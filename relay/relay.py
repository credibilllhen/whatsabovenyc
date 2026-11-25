#!/usr/bin/env python3
"""
whatsabove.nyc home relay.

Fetches every aircraft within 40 nm of New York from a free ADS-B API every 10 seconds, from your
own internet connection, and hands it to the poller on Cloudflare, which does everything else.
The free APIs refuse Cloudflare's shared addresses but answer home connections.

    python3 relay/relay.py

The first run creates a token in ~/.whatsabove-relay-token and tells you where to paste it.
Standard library only; runs on macOS or a Raspberry Pi. Ctrl+C stops it.

Settings (environment variables, all optional):
    WHATSABOVE_INGEST   where to send data (default: the poller's /ingest URL)
    RELAY_CITIES        which cities to feed, comma-separated: nyc, boston (default nyc)
    RELAY_SECONDS       how often to fetch (default 10)
    RELAY_PROXY         send the API requests through this HTTP proxy, e.g. Tor's
                        http://127.0.0.1:9080. When set, they never go out directly.
    RELAY_TOKEN_FILE    where the token is kept (default ~/.whatsabove-relay-token)

Privacy: requests to the data APIs carry no cookies and nothing that names this site or
machine, only Python's generic user agent. With RELAY_PROXY set to Tor, the APIs don't see
your IP address either. Only the poller, which is yours, sees where the data comes from.
"""
import gzip
import json
import os
import secrets
import signal
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

RADIUS_NM = 40
CENTERS = {"nyc": (40.70, -73.92), "boston": (42.36, -71.01)}  # must match the poller's
CITIES = [c.strip() for c in os.environ.get("RELAY_CITIES", "nyc").split(",") if c.strip() in CENTERS] or ["nyc"]
INGEST = os.environ.get("WHATSABOVE_INGEST", "https://whatsabove-poller.sasha-henry-10.workers.dev/ingest")
EVERY = max(5, int(os.environ.get("RELAY_SECONDS", "10")))
_cred = os.environ.get("CREDENTIALS_DIRECTORY")  # set by systemd's LoadCredential
TOKEN_FILE = Path(os.environ.get("RELAY_TOKEN_FILE") or (Path(_cred) / "token" if _cred else Path.home() / ".whatsabove-relay-token"))
PROXY = os.environ.get("RELAY_PROXY", "").strip()
UA = "whatsabove.nyc relay"  # sent only to the poller, never to the data APIs

# Requests to the data APIs: through the proxy only when one is set (never a direct fallback),
# and with no identifying headers. Proxy settings in the environment are ignored otherwise.
api = urllib.request.build_opener(urllib.request.ProxyHandler({"https": PROXY, "http": PROXY} if PROXY else {}))
api.addheaders.append(("Accept", "application/json"))  # beside urllib's generic "Python-urllib/3.x" user agent
poller = urllib.request.build_opener(urllib.request.ProxyHandler({}))

def sources(city):  # tried in order; one that refuses is rested, longer each time
    lat, lon = CENTERS[city]
    return [
        ("adsb.lol", f"https://api.adsb.lol/v2/point/{lat}/{lon}/{RADIUS_NM}"),
        ("adsb.fi", f"https://opendata.adsb.fi/api/v2/lat/{lat}/lon/{lon}/dist/{RADIUS_NM}"),
        ("airplanes.live", f"https://api.airplanes.live/v2/point/{lat}/{lon}/{RADIUS_NM}"),
    ]
KEEP = ("hex", "flight", "r", "t", "lat", "lon", "alt_baro", "alt_geom", "gs", "track", "true_heading",
        "mag_heading", "baro_rate", "geom_rate", "squawk", "seen_pos", "seen", "nav_qnh")


def token():
    if TOKEN_FILE.exists():
        return TOKEN_FILE.read_text().strip()
    if _cred or os.environ.get("RELAY_TOKEN_FILE"):
        sys.exit(f"No token at {TOKEN_FILE}. Copy the token there first.")
    t = secrets.token_hex(24)
    TOKEN_FILE.write_text(t + "\n")
    TOKEN_FILE.chmod(0o600)
    print(f"""
Created a relay token in {TOKEN_FILE}.
Add it to GitHub once, so the poller accepts data from this machine:

  1. Copy it:   cat {TOKEN_FILE} | pbcopy        (on a Pi, just: cat {TOKEN_FILE})
  2. Open github.com/credibilllhen/whatsabovenyc > Settings > Secrets and variables > Actions
  3. New repository secret: name INGEST_TOKEN, paste the token, Add secret
  4. Actions > Deploy poller > Run workflow

Until that deploy finishes, sends will be refused with 401 and retried.
""", flush=True)
    return t


rest = {name: [0.0, 0] for name, _ in sources("nyc")}  # name -> [rest until, strikes], shared by the cities


def fetch_feed(city):
    errors = []
    now = time.time()
    for name, url in sources(city):
        until, strikes = rest[name]
        if now < until:
            continue
        try:
            with api.open(url, timeout=20 if PROXY else 8) as r:
                data = json.loads(r.read())
            rest[name] = [0.0, 0]
            return name, data
        except urllib.error.HTTPError as e:
            wait = int(e.headers.get("Retry-After") or 0)
            errors.append(f"{name} HTTP {e.code}")
        except Exception as e:  # timeout, DNS, bad JSON
            wait = 0
            errors.append(f"{name} {type(e).__name__}")
        strikes += 1
        rest[name] = [now + max(wait, min(600, 30 * 2 ** (strikes - 1))), strikes]
    raise RuntimeError("; ".join(errors) or "all sources resting")


def send(city, source, data, tok):
    ac = [{k: a[k] for k in KEEP if k in a} for a in (data.get("ac") or data.get("aircraft") or [])]
    body = gzip.compress(json.dumps({"ac": ac, "now": data.get("now")}, separators=(",", ":")).encode())
    url = INGEST if city == "nyc" else f"{INGEST}?city={city}"
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "Authorization": f"Bearer {tok}", "Content-Type": "application/json", "X-Gzip": "1",
        "X-Source": source, "User-Agent": UA})
    with poller.open(req, timeout=15) as r:
        r.read()
    return len(ac), len(body)


def main():
    tok = token()
    signal.signal(signal.SIGTERM, lambda *a: sys.exit(0))
    via = f" (data APIs reached through {PROXY})" if PROXY else ""
    print(f"Relaying {' and '.join(CITIES)} every {EVERY} s to {INGEST}{via}. Ctrl+C to stop.", flush=True)
    sent = {c: 0 for c in CITIES}
    last_note = 0.0
    while True:
        started = time.time()
        note = started - last_note > 300  # a line per city on the first send, then every 5 minutes
        for city in CITIES:
            try:
                source, data = fetch_feed(city)
                n, size = send(city, source, data, tok)
                sent[city] += 1
                if sent[city] == 1 or note:
                    print(f"{time.strftime('%H:%M:%S')}  {city}: sent {n} aircraft from {source} ({size // 1024} KB); {sent[city]} sends so far", flush=True)
            except urllib.error.HTTPError as e:
                if e.code == 401:
                    print(f"{time.strftime('%H:%M:%S')}  {city}: poller refused the token (401). Is INGEST_TOKEN in GitHub and the poller redeployed?", flush=True)
                    time.sleep(50)
                else:
                    print(f"{time.strftime('%H:%M:%S')}  {city}: poller answered HTTP {e.code}", flush=True)
            except Exception as e:
                print(f"{time.strftime('%H:%M:%S')}  {city}: {e}", flush=True)
        if note: last_note = started
        time.sleep(max(1, EVERY - (time.time() - started)))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nStopped.")
