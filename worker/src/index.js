// whatsabove.nyc poller
//
// One Durable Object ("the poller") wakes every POLL_SECONDS, fetches every aircraft within
// RADIUS_NM of New York from an ADS-B v2 API (adsb.lol by default) in a single call, and keeps a
// shared picture of the sky:
//   - current aircraft, with their routes looked up once per callsign
//   - 30 minutes of position history per aircraft
//   - which published approach each runway is using, and the path arrivals actually fly
// After each poll it writes live.json to R2; every minute it writes history.json. The site reads
// both from data.whatsabove.nyc, so visitors never call the Worker or the ADS-B API themselves.
//
// The poller keeps itself awake with alarms. A cron trigger every minute pokes it, so it starts
// on the first deploy and restarts if the alarm chain ever breaks. On a cold start it restores
// its state from history.json.

import RAW_APPROACHES from '../../site/approaches.json';

const LAT0 = 40.70, LON0 = -73.92, D2R = Math.PI / 180, FT_PER_NM = 6076.12;
const COSL = Math.cos(LAT0 * D2R);
const HISTORY_MIN = 30;           // keep this much history
const TRAIL_EVERY_S = 20;         // one history point per aircraft every 20 s
const GONE_AFTER_S = 60;          // not in the feed for this long: no longer live
const MIN_AGL = 50, GROUND_FT = 15;
const ROUTE_LOOKUPS_PER_POLL = 3; // be gentle with adsbdb
const ROUTE_RETRY_MS = 3600e3;

const toXZ = (lat, lon) => ({ x: (lon - LON0) * 60 * COSL, z: -(lat - LAT0) * 60 });
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const angDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
const num = v => (v == null || v === '' ? null : Number(v));
const r1 = v => Math.round(v * 1000) / 1000;

/* ---------- approaches (same preparation as the page, so both agree) ---------- */
const APR_PRIO = { I: 0, H: 1, R: 2, L: 3, S: 4 };
const APPROACHES = RAW_APPROACHES.map(a => ({ ...a }));
const THR = {};
function measure(ap) { const n = ap.xz.length; ap.s = new Array(n).fill(0); for (let i = n - 2; i >= 0; i--) ap.s[i] = ap.s[i + 1] + Math.hypot(ap.xz[i + 1].x - ap.xz[i].x, ap.xz[i + 1].z - ap.xz[i].z); }
for (const ap of APPROACHES) {
  ap.rk = ap.a + ' ' + ap.rwy; ap.key = ap.a + ' ' + ap.id;
  ap.xz = ap.p.map(([la, lo]) => toXZ(la, lo)); measure(ap);
  THR[ap.rk] = ap.xz[ap.xz.length - 1];
}
const oppRwy = r => { const m = /^(\d+)([LRC]?)$/.exec(r); return String((+m[1] + 18) % 36 || 36) + ({ L: 'R', R: 'L', C: 'C' }[m[2]] || ''); };
for (const ap of APPROACHES) {
  const T = THR[ap.rk], O = THR[ap.a + ' ' + oppRwy(ap.rwy)]; if (!O) continue;
  const uL = Math.hypot(O.x - T.x, O.z - T.z), u = { x: (O.x - T.x) / uL, z: (O.z - T.z) / uL }; ap.u = u;
  const n = ap.xz.length, P = ap.xz[n - 2], dL = Math.hypot(T.x - P.x, T.z - P.z), d = { x: (T.x - P.x) / dL, z: (T.z - P.z) / dL };
  if (Math.acos(clamp(d.x * u.x + d.z * u.z, -1, 1)) < 8 * D2R || dL < 1.2) continue;
  const F = { x: T.x - u.x * 0.8, z: T.z - u.z * 0.8 }, w = { x: F.x - P.x, z: F.z - P.z }, det = d.x * u.z - d.z * u.x;
  let C = { x: F.x - u.x * 1.2, z: F.z - u.z * 1.2 };
  if (Math.abs(det) > 1e-6) {
    const t = (w.x * u.z - w.z * u.x) / det, k = (d.x * w.z - d.z * w.x) / det;
    if (t > 0 && k > 0.2 && k < 4) C = { x: P.x + d.x * t, z: P.z + d.z * t };
  }
  const curve = [];
  for (let i = 1; i <= 14; i++) { const q = i / 14, a = (1 - q) * (1 - q), b = 2 * (1 - q) * q, c = q * q; curve.push({ x: a * P.x + b * C.x + c * F.x, z: a * P.z + b * C.z + c * F.z }); }
  ap.xz = ap.xz.slice(0, n - 1).concat(curve, [T]); measure(ap);
}
const altAt = (ap, s) => (ap.el + ap.tch) / FT_PER_NM + Math.tan(ap.gpa * D2R) * s;
function projectOn(ap, x, z) {
  let best = null;
  for (let i = 0; i < ap.xz.length - 1; i++) {
    const a = ap.xz[i], b = ap.xz[i + 1], dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz || 1e-9;
    const f = clamp(((x - a.x) * dx + (z - a.z) * dz) / L2, 0, 1);
    const d = Math.hypot(x - (a.x + dx * f), z - (a.z + dz * f));
    if (!best || d < best.lat) best = { lat: d, s: ap.s[i] - f * (ap.s[i] - ap.s[i + 1]), hdg: Math.atan2(dx, -dz), end: (i === 0 && f === 0) };
  }
  return best;
}
const aprLabel = ap => ap.nick ? `${ap.nick} (${ap.name})` : ap.name;

/* ---------- ADS-B parsing and the ground filter ---------- */
function parseFeed(j) {
  return (j.ac || j.aircraft || []).map(a => {
    const ground = a.alt_baro === 'ground';
    return {
      hex: String(a.hex || '').replace('~', '').toLowerCase(), cs: String(a.flight || '').trim().toUpperCase(),
      reg: a.r || '', type: a.t || '', lat: num(a.lat), lon: num(a.lon),
      altFt: ground ? 0 : (num(a.alt_baro) ?? num(a.alt_geom) ?? 0), gs: num(a.gs) ?? 0,
      track: num(a.track) ?? num(a.true_heading) ?? num(a.mag_heading) ?? 0, vr: num(a.baro_rate) ?? num(a.geom_rate) ?? 0,
      sq: a.squawk || '', ground, seen: num(a.seen_pos) ?? num(a.seen) ?? 0, qnh: num(a.nav_qnh)
    };
  }).filter(r => r.hex && Number.isFinite(r.lat) && Number.isFinite(r.lon));
}
// Barometric altitude is pressure altitude, so correct it with the local altimeter setting:
// the median nav_qnh reported by aircraft below 18,000 ft.
function qnhCorrection(recs) {
  const q = recs.filter(r => r.qnh && !r.ground && r.altFt < 18000).map(r => r.qnh).sort((a, b) => a - b);
  return q.length < 3 ? 0 : (q[q.length >> 1] - 1013.25) * 27.3;
}
const isLow = (r, corr) => r.ground || r.altFt + corr - GROUND_FT < MIN_AGL;

/* ---------- routes (adsbdb) ---------- */
function findRoute(o, d = 0) {
  if (!o || typeof o !== 'object' || d > 5) return null;
  if (o.origin && o.destination) return o;
  for (const k of Object.keys(o)) { const r = findRoute(o[k], d + 1); if (r) return r; }
  return null;
}
const normCode = c => { c = String(c || '').toUpperCase(); return (c.length === 4 && c[0] === 'K') ? c.slice(1) : c; };
function apInfo(x) {
  if (!x) return { code: '', name: '' };
  if (typeof x === 'string') return { code: normCode(x), name: '' };
  return { code: normCode(x.iata_code || x.iata || x.icao_code || x.icao || x.code || ''), name: x.municipality || x.city || x.name || '' };
}
function parseRoute(j) {
  const r = findRoute(j); if (!r) return null;
  const o = apInfo(r.origin), d = apInfo(r.destination);
  if (!o.code && !d.code) return null;
  const al = r.airline || {};
  return { orig: o.code, origName: o.name, dest: d.code, destName: d.name,
    airline: typeof al === 'string' ? al : (al.name || ''), airlineIata: typeof al === 'object' ? (al.iata || al.iata_code || '') : '' };
}

/* ---------- the poller ---------- */
export class PollerV3 {
  constructor(state, env) {
    this.state = state; this.env = env;
    this.loaded = false;
    this.ac = new Map();      // hex -> { r, trail: [[tSec, lat, lon, altFt]], hist: [{x, z}], lastSeen, lastTrail, lastVote, gone }
    this.routes = new Map();  // callsign -> route or { none: true, at }
    this.scores = {};         // approach key -> votes
    this.landVotes = {};      // runway key -> landings
    this.tracks = {};         // runway key -> [{ t, pts: [{x, z, s}] }]
    this.rwyActive = {};
    this.lastScoreT = 0; this.lastHistory = 0;
    this.stats = { polls: 0, errors: 0, lastError: '', lastOk: 0, lastCount: 0, lastMs: 0 };
  }
  get interval() { return clamp(Number(this.env.POLL_SECONDS) || 10, 2, 60); }

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try { // a cold start picks up where the last history file left off
      const obj = await this.env.DATA.get('history.json');
      if (!obj) return;
      const h = await obj.json();
      if (!h || Date.now() - h.t > HISTORY_MIN * 60e3) return;
      const base = h.t / 1000;
      for (const [hex, pts] of Object.entries(h.ac || {})) {
        const trail = pts.map(([dt, la, lo, alt]) => [base + dt, la / 1e4, lo / 1e4, alt]);
        const last = trail[trail.length - 1];
        const m = (h.meta || {})[hex];
        const r = m ? { hex, cs: m[0] || '', type: m[1] || '', reg: m[2] || '', lat: last[1], lon: last[2], altFt: last[3], gs: 0, track: 0, vr: 0, sq: '', ground: false, seen: 0 } : null;
        this.ac.set(hex, { r, trail, hist: [], lastSeen: last[0] * 1000, lastTrail: last[0] * 1000, gone: true });
      }
      for (const [cs, r] of Object.entries(h.routes || {})) this.routes.set(cs, r);
      const L = h.learn || {};
      this.scores = L.scores || {}; this.landVotes = L.landVotes || {}; this.rwyActive = L.rwyActive || {};
      this.tracks = L.tracks || {}; this.lastScoreT = L.lastScoreT || 0;
    } catch (e) { /* start fresh */ }
  }

  async ensureAlarm() {
    const a = await this.state.storage.getAlarm();
    if (!a || a < Date.now() - 30e3) await this.state.storage.setAlarm(Date.now() + 1000);
  }

  async fetch(req) {
    const url = new URL(req.url), path = url.pathname;
    // A running instance keeps its code across deploys. Each minute the Worker (always on the
    // latest code) passes its build; an older instance resets itself and comes back on the new one.
    const build = url.searchParams.get('build');
    if (build && this.env.BUILD_ID && build !== this.env.BUILD_ID && this.state.abort) {
      this.state.abort(`restarting for build ${build}`);
    }
    await this.load();
    if (path === '/kick') { await this.ensureAlarm(); return new Response('ok'); }
    await this.ensureAlarm();
    return Response.json({ ...this.stats, build: this.env.BUILD_ID || 'dev', source: this.source, resting: this.rest || {}, aircraft: [...this.ac.values()].filter(e => !e.gone).length,
      tracked: this.ac.size, routes: this.routes.size, interval: this.interval });
  }

  async alarm() {
    await this.load();
    // schedule the next wake-up first, so a failed poll never stops the chain
    await this.state.storage.setAlarm(Date.now() + this.interval * 1000);
    const t0 = Date.now();
    try {
      await this.poll();
      this.stats.lastOk = Date.now();
    } catch (e) {
      this.stats.errors++; this.stats.lastError = `${new Date().toISOString()} ${e.message || e}`;
    }
    this.stats.polls++; this.stats.lastMs = Date.now() - t0;
  }

  async poll() {
    const env = this.env, now = Date.now(), tSec = now / 1000;
    const recs = parseFeed(await this.fetchFeed(now));
    const corr = qnhCorrection(recs), seen = new Set();

    for (const r of recs) {
      let e = this.ac.get(r.hex);
      if (isLow(r, corr)) { // on the ground or below 50 ft: it has landed (or not taken off yet)
        if (e && !e.gone) { this.recordLanding(e, now); e.gone = true; }
        continue;
      }
      seen.add(r.hex);
      if (!e) { e = { r, trail: [], hist: [], lastSeen: now, lastTrail: 0, gone: false }; this.ac.set(r.hex, e); }
      e.r = r; e.lastSeen = now; e.gone = false;
      if (now - e.lastTrail >= TRAIL_EVERY_S * 1000) { e.trail.push([r1(tSec), r.lat, r.lon, Math.round(r.altFt)]); e.lastTrail = now; }
      if (r.altFt < 9000) { // positions below 9,000 ft, for learning the paths arrivals fly
        const p = toXZ(r.lat, r.lon), L = e.hist[e.hist.length - 1];
        if (!L || Math.hypot(p.x - L.x, p.z - L.z) > 0.12) { e.hist.push({ x: p.x, z: p.z }); if (e.hist.length > 400) e.hist.shift(); }
      }
    }
    // gone from the feed: if it was low and descending it has landed
    for (const [hex, e] of this.ac) {
      if (!e.gone && !seen.has(hex)) {
        const low = e.r && e.r.altFt < 1500 && e.r.vr <= 0;
        if (low || now - e.lastSeen > GONE_AFTER_S * 1000) { if (low) this.recordLanding(e, now); e.gone = true; }
      }
      const cutoff = tSec - HISTORY_MIN * 60;
      while (e.trail.length && e.trail[0][0] < cutoff) e.trail.shift();
      if (e.gone && now - e.lastSeen > HISTORY_MIN * 60e3) this.ac.delete(hex);
    }

    this.score(now);
    await this.lookupRoutes(now);

    const live = [];
    for (const e of this.ac.values()) {
      if (e.gone || !e.r) continue;
      const r = e.r, rt = this.routes.get(r.cs);
      const o = { hex: r.hex, cs: r.cs, reg: r.reg, type: r.type, lat: r.lat, lon: r.lon, altFt: Math.round(r.altFt), gs: Math.round(r.gs),
        track: Math.round(r.track), vr: Math.round(r.vr), sq: r.sq, seen: Math.round(r.seen * 10) / 10 };
      if (rt && !rt.none) Object.assign(o, { orig: rt.orig, dest: rt.dest, origName: rt.origName, destName: rt.destName, airline: rt.airline, airlineIata: rt.airlineIata });
      live.push(o);
    }
    this.stats.lastCount = live.length;
    const body = JSON.stringify({ t: now, interval: this.interval, radius: Number(env.RADIUS_NM || 40), source: this.source || 'adsb.lol', ac: live, active: this.activeList(now) });
    const puts = [env.DATA.put('live.json', body, { httpMetadata: { contentType: 'application/json', cacheControl: `public, max-age=${Math.max(1, Math.floor(this.interval / 2))}` } })];
    if (now - this.lastHistory >= 60e3) { puts.push(this.writeHistory(now)); this.lastHistory = now; }
    await Promise.all(puts);
  }

  /* Every aircraft in the area, in one call. Sources are tried in order; one that refuses
     (rate limit, error, timeout) is rested for a while, longer each time, and the next is used.
     Cloudflare's outbound addresses are shared, so volunteer APIs sometimes rate-limit them. */
  sources() {
    const env = this.env, r = env.RADIUS_NM || 40;
    const fill = t => t.replace('{lat}', LAT0).replace('{lon}', LON0).replace('{dist}', r);
    const main = { name: (env.ADSB_URL || 'https://api.adsb.lol').replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^api\./, ''),
      url: (env.ADSB_URL || 'https://api.adsb.lol').replace(/\/+$/, '') + fill(env.ADSB_PATH || '/v2/point/{lat}/{lon}/{dist}'), key: true };
    const list = [];
    // FlyItalyADSB identifies us by key rather than IP, so it works from Cloudflare's shared addresses.
    // Its radius is in km. Free key: 30 requests/minute, 300,000/month.
    if (env.FLYITALY_API_KEY) list.push({ name: 'flyitalyadsb', url: `https://api.flyitalyadsb.com/v2/lat/${LAT0}/lon/${LON0}/dist/${Math.round(r * 1.852)}`,
      headers: { 'X-Api-Key': env.FLYITALY_API_KEY } });
    list.push(main);
    if (env.FALLBACK !== 'off') list.push({ name: 'adsb.fi', url: fill(env.FALLBACK_URL || 'https://opendata.adsb.fi/api/v2/lat/{lat}/lon/{lon}/dist/{dist}') });
    return list;
  }
  async fetchFeed(now) {
    this.rest = this.rest || {};
    const headers = { 'User-Agent': 'whatsabove.nyc poller', Accept: 'application/json' };
    const errors = [];
    for (const src of this.sources()) {
      const st = this.rest[src.name] || (this.rest[src.name] = { until: 0, strikes: 0 });
      if (now < st.until) { errors.push(`${src.name} resting after ${st.reason}`); continue; }
      const h = { ...headers };
      if (src.key && this.env.ADSB_API_KEY) h[this.env.ADSB_KEY_HEADER || 'api-auth'] = this.env.ADSB_API_KEY;
      if (src.headers) Object.assign(h, src.headers);
      try {
        const res = await fetch(src.url, { headers: h, signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const j = await res.json();
          st.strikes = 0; this.source = src.name;
          this.stats.bySource = this.stats.bySource || {};
          this.stats.bySource[src.name] = (this.stats.bySource[src.name] || 0) + 1;
          return j;
        }
        const ra = Number(res.headers.get('Retry-After')) || 0;
        st.strikes++;
        st.until = now + Math.max(ra * 1000, Math.min(600e3, 30e3 * 2 ** (st.strikes - 1)));
        st.reason = `HTTP ${res.status}${ra ? `, retry after ${ra} s` : ''}`; st.at = new Date(now).toISOString();
        errors.push(`${src.name} HTTP ${res.status}`);
      } catch (e) {
        st.strikes++; st.until = now + Math.min(600e3, 30e3 * 2 ** (st.strikes - 1));
        st.reason = e.name === 'TimeoutError' ? 'timed out' : String(e.message || e); st.at = new Date(now).toISOString();
        errors.push(`${src.name} ${st.reason}`);
      }
    }
    throw new Error(errors.join('; '));
  }

  writeHistory(now) {
    const base = now / 1000, ac = {}, meta = {};
    for (const [hex, e] of this.ac) {
      if (!e.trail.length) continue;
      ac[hex] = e.trail.map(([t, la, lo, alt]) => [Math.round(t - base), Math.round(la * 1e4), Math.round(lo * 1e4), alt]);
      if (e.r) meta[hex] = [e.r.cs, e.r.type, e.r.reg]; // for labels when the page plays history back
    }
    const routes = {};
    for (const e of this.ac.values()) { const cs = e.r && e.r.cs, rt = cs && this.routes.get(cs); if (rt) routes[cs] = rt; }
    const learn = { scores: this.scores, landVotes: this.landVotes, rwyActive: this.rwyActive, lastScoreT: this.lastScoreT, tracks: this.tracks };
    const body = JSON.stringify({ t: now, minutes: HISTORY_MIN, every: TRAIL_EVERY_S, ac, meta, routes, learn });
    return this.env.DATA.put('history.json', body, { httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=20' } });
  }

  async lookupRoutes(now) {
    const want = [];
    for (const e of this.ac.values()) {
      const cs = !e.gone && e.r && e.r.cs; if (!cs || want.includes(cs)) continue;
      const rt = this.routes.get(cs);
      if (!rt || (rt.none && now - rt.at > ROUTE_RETRY_MS)) want.push(cs);
      if (want.length >= ROUTE_LOOKUPS_PER_POLL) break;
    }
    await Promise.all(want.map(async cs => {
      try {
        const r = await fetch(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(cs)}`, { headers: { 'User-Agent': 'whatsabove.nyc poller' } });
        const rt = r.ok ? parseRoute(await r.json()) : null;
        this.routes.set(cs, rt ? { ...rt, at: now } : { none: true, at: now });
      } catch (e) { this.routes.set(cs, { none: true, at: now }); }
    }));
    if (this.routes.size > 5000) { // forget callsigns not seen for a while
      const live = new Set([...this.ac.values()].map(e => e.r && e.r.cs));
      for (const cs of this.routes.keys()) if (!live.has(cs)) this.routes.delete(cs);
    }
  }

  /* Each arrival below 6,000 ft that isn't climbing votes, at most every 10 s, for the published
     approach whose path it is flying. Landings are recorded per runway. Both decay with an
     8-minute half-life. */
  score(now) {
    const dtMin = this.lastScoreT ? (now - this.lastScoreT) / 60000 : 0; this.lastScoreT = now;
    const decay = Math.pow(0.5, dtMin / 8);
    for (const k of Object.keys(this.scores)) { this.scores[k] *= decay; if (this.scores[k] < 0.01) delete this.scores[k]; }
    for (const k of Object.keys(this.landVotes)) { this.landVotes[k] *= decay; if (this.landVotes[k] < 0.01) delete this.landVotes[k]; }
    for (const e of this.ac.values()) {
      const r = e.r;
      if (e.gone || !r || r.altFt > 6000 || r.vr > 300) continue;
      if (e.lastVote && now - e.lastVote < 10000) continue;
      const p = toXZ(r.lat, r.lon), altNm = r.altFt / FT_PER_NM;
      let best = null;
      for (const ap of APPROACHES) {
        const pr = projectOn(ap, p.x, p.z);
        if (pr.end || pr.s < 0.3) continue;
        if (pr.lat > Math.max(0.5, pr.s * 0.06)) continue;
        if (Math.abs(angDiff((r.track || 0) * D2R, pr.hdg)) > 30 * D2R) continue;
        if (altNm > altAt(ap, pr.s) + 1500 / FT_PER_NM) continue;
        const better = !best || pr.lat < best.lat - 0.12 || (Math.abs(pr.lat - best.lat) <= 0.12 && APR_PRIO[ap.t] < APR_PRIO[best.ap.t]);
        if (better) best = { ap, lat: pr.lat };
      }
      if (best) { this.scores[best.ap.key] = (this.scores[best.ap.key] || 0) + 1; e.lastVote = now; }
    }
    // tracks older than 30 minutes no longer describe the current flow
    for (const rk of Object.keys(this.tracks)) {
      this.tracks[rk] = this.tracks[rk].filter(tr => now - tr.t < 30 * 60e3);
      if (!this.tracks[rk].length) delete this.tracks[rk];
    }
  }

  recordLanding(e, now) {
    const h = e.hist; if (!h || h.length < 6) return;
    const last = h[h.length - 1];
    let j = h.length - 1; while (j > 0 && Math.hypot(h[j].x - last.x, h[j].z - last.z) < 0.8) j--;
    const hx = last.x - h[j].x, hz = last.z - h[j].z, hl = Math.hypot(hx, hz); if (hl < 0.3) return;
    let best = null;
    for (const ap of APPROACHES) {
      if (!ap.u || (best && best.rk === ap.rk)) continue;
      const T = THR[ap.rk], d = Math.hypot(last.x - T.x, last.z - T.z);
      if (d > 2 || (hx * ap.u.x + hz * ap.u.z) / hl < Math.cos(35 * D2R)) continue;
      if (!best || d < best.d) best = { rk: ap.rk, d, T };
    }
    if (!best) return;
    const pts = [{ x: r1(best.T.x), z: r1(best.T.z), s: 0 }]; let s = 0, prev = best.T;
    for (let i = h.length - 1; i >= 0 && s < 16; i--) {
      const q = h[i], step = Math.hypot(q.x - prev.x, q.z - prev.z);
      if (step < 0.05) continue;
      s += step; pts.push({ x: r1(q.x), z: r1(q.z), s: r1(s) }); prev = q;
    }
    if (s < 5) return;
    const list = this.tracks[best.rk] || (this.tracks[best.rk] = []);
    list.push({ t: now, pts }); while (list.length > 6) list.shift();
    this.landVotes[best.rk] = (this.landVotes[best.rk] || 0) + 1;
    e.hist = [];
  }

  flownPath(rk, now) {
    const list = (this.tracks[rk] || []).filter(tr => now - tr.t < 30 * 60e3);
    if (list.length < 2) return null;
    const atS = (pts, s) => {
      for (let i = 0; i < pts.length - 1; i++) if (pts[i + 1].s >= s) {
        const a = pts[i], b = pts[i + 1], f = (s - a.s) / ((b.s - a.s) || 1e-9);
        return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f };
      }
      return null;
    };
    const out = [];
    for (let s = 0; s <= 15 + 1e-6; s += 0.25) {
      let x = 0, z = 0, k = 0;
      for (const tr of list) { const q = atS(tr.pts, s); if (q) { x += q.x; z += q.z; k++; } }
      if (k < 2) break;
      out.push({ x: x / k, z: z / k });
    }
    if (out.length < 17) return null;
    const sm = out.map((q, i) => {
      if (i === 0) return q;
      let x = 0, z = 0, n = 0;
      for (let m = Math.max(1, i - 2); m <= Math.min(out.length - 1, i + 2); m++) { x += out[m].x; z += out[m].z; n++; }
      return { x: x / n, z: z / n };
    });
    return { pts: sm.map(q => [r1(q.x), r1(q.z)]), n: list.length, sig: list[list.length - 1].t };
  }

  // Runways in use, with the approach to draw and (when known) the path arrivals are flying.
  activeList(now) {
    const rw = {}, top = {};
    for (const ap of APPROACHES) {
      const sc = this.scores[ap.key] || 0;
      const g = rw[ap.rk] || (rw[ap.rk] = { a: ap.a, rwy: ap.rwy, sum: 0, best: null, bestSc: -1, prio: null });
      g.sum += sc;
      if (!g.best || sc > g.bestSc + 0.01 || (Math.abs(sc - g.bestSc) <= 0.01 && APR_PRIO[ap.t] < APR_PRIO[g.best.t])) { g.best = ap; g.bestSc = sc; }
      if (!g.prio || APR_PRIO[ap.t] < APR_PRIO[g.prio.t]) g.prio = ap;
    }
    for (const [rk, g] of Object.entries(rw)) { g.land = this.landVotes[rk] || 0; g.total = g.sum + g.land; top[g.a] = Math.max(top[g.a] || 0, g.total); }
    const out = [];
    for (const [rk, g] of Object.entries(rw)) {
      this.rwyActive[rk] = this.rwyActive[rk] ? g.total >= 0.8 : (g.total >= 2 && g.total >= top[g.a] * 0.3);
      if (!this.rwyActive[rk]) { delete this.rwyActive[rk]; continue; }
      const visual = g.land >= 2 && g.sum < g.land * 0.35;
      const ap = visual || g.sum < 0.5 ? g.prio : g.best, fp = this.flownPath(rk, now);
      out.push({ a: g.a, rwy: g.rwy, id: ap.id, visual, title: visual ? `Visual approach RWY ${g.rwy}` : aprLabel(ap),
        flown: fp ? fp.pts : null, n: fp ? fp.n : 0, sig: (visual ? 'V' : ap.id) + '|' + (fp ? fp.sig : 'pub') });
    }
    return out;
  }
}

/* ---------- the Worker ---------- */
const poller = env => env.POLLER.get(env.POLLER.idFromName('nyc'));

export default {
  // GET /status shows how the poller is doing (and starts it if it isn't running).
  // GET /live.json and /history.json serve the files straight from R2: a fallback for
  // before data.whatsabove.nyc is connected, and for local testing.
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = { 'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*' };
    if (url.pathname === '/live.json' || url.pathname === '/history.json') {
      const obj = await env.DATA.get(url.pathname.slice(1));
      if (!obj) return new Response('not ready yet', { status: 404, headers: cors });
      return new Response(obj.body, { headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': obj.httpMetadata?.cacheControl || 'no-store' } });
    }
    if (url.pathname === '/status') return poller(env).fetch(`https://poller/status?build=${env.BUILD_ID || ''}`);
    if (url.pathname === '/probe/lol') { // adsb.lol hit rate from here: 8 tries, 1.2 s apart
      const res = [];
      for (let i = 0; i < 8; i++) {
        try { const r = await fetch('https://api.adsb.lol/v2/point/40.7/-73.92/40', { headers: { 'User-Agent': 'whatsabove.nyc poller' } }); res.push(r.status); await r.arrayBuffer(); }
        catch (e) { res.push('err'); }
        await new Promise(r => setTimeout(r, 1200));
      }
      return Response.json({ statuses: res });
    }
    if (url.pathname === '/probe/flyitaly') { // what the block page says
      const r = await fetch('https://api.flyitalyadsb.com/v2/lat/40.7/lon/-73.92/dist/74', { headers: { 'User-Agent': 'whatsabove.nyc poller' } });
      const t = await r.text();
      const title = (t.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
      const code = (t.match(/Error\s*(?:code)?\s*(\d{3,4})/i) || [])[1] || '';
      return Response.json({ status: r.status, title, code, server: r.headers.get('server'), cfRay: r.headers.get('cf-ray'), text: t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 400) });
    }
    if (url.pathname === '/probe') { // which keyless sources answer from Cloudflare right now
      const bb = 'lamin=40.1&lomin=-74.7&lamax=41.3&lomax=-73.1';
      const cands = {
        'adsb.lol': 'https://api.adsb.lol/v2/point/40.7/-73.92/40',
        'adsb.fi v2': 'https://opendata.adsb.fi/api/v2/lat/40.7/lon/-73.92/dist/40',
        'adsb.fi v3': 'https://opendata.adsb.fi/api/v3/lat/40.7/lon/-73.92/dist/40',
        'adsb.one': 'https://api.adsb.one/v2/point/40.7/-73.92/40',
        'airplanes.live': 'https://api.airplanes.live/v2/point/40.7/-73.92/40',
        'opensky (anonymous)': `https://opensky-network.org/api/states/all?${bb}`,
        'flyitalyadsb (no key)': 'https://api.flyitalyadsb.com/v2/lat/40.7/lon/-73.92/dist/74',
      };
      const out = {};
      await Promise.all(Object.entries(cands).map(async ([k, u]) => {
        try {
          const h = { 'User-Agent': 'whatsabove.nyc poller', Accept: 'application/json' };
          if (k.startsWith('flyitalyadsb') && env.FLYITALY_API_KEY) h['X-Api-Key'] = env.FLYITALY_API_KEY;
          const r = await fetch(u, { headers: h, signal: AbortSignal.timeout(12000) });
          const t = await r.text(); let n = null;
          try { const j = JSON.parse(t); n = (j.ac || j.aircraft || j.states || []).length; } catch (e) {}
          out[k] = { status: r.status, aircraft: n, note: n == null ? t.slice(0, 100) : undefined, limit: r.headers.get('x-rate-limit-remaining') || undefined };
        } catch (e) { out[k] = { error: String(e.message || e) }; }
      }));
      return Response.json(out);
    }
    return new Response('whatsabove.nyc poller. See /status.', { headers: cors });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(poller(env).fetch(`https://poller/kick?build=${env.BUILD_ID || ''}`));
  },
};
