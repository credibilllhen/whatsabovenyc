# What's above NYC

A live 3D view of the aircraft over New York, with the approaches in use at JFK, LaGuardia and Newark.

## How it works

```
adsb.lol ──(1 call / 10 s)──▶ Cloudflare Worker + Durable Object ("the poller")
                                   │  keeps 30 min of history, routes, active approaches
                                   ▼
                              R2 bucket: live.json (every poll), history.json (every minute)
                                   │  served at data.whatsabove.nyc through Cloudflare's cache
                                   ▼
                     whatsabove.nyc (GitHub Pages) ── every visitor reads the same files
```

The ADS-B API is called once per poll no matter how many people are watching. Each call returns
every aircraft within 40 nm. Ground traffic and anything below 50 ft is dropped by the poller.

| Folder | What it is |
|---|---|
| `site/` | The page. `approaches.json` is the FAA approach data (edit it to update the approaches). |
| `worker/` | The poller: `src/index.js`, `wrangler.toml` (polling interval and other settings). |
| `local/server.py` | Runs everything on your own machine, without Cloudflare: `python3 local/server.py`. |
| `.github/workflows/` | `site.yml` publishes the page, `worker.yml` deploys the poller, on every push to `main`. |

## One-time setup

1. **Cloudflare**: add `whatsabove.nyc` to your account (free plan) and point the domain's
   nameservers at the two Cloudflare gives you. Enable R2, then create a bucket named
   `whatsabove-data`.
2. **Deploy key**: in Cloudflare, *My Profile > API Tokens > Create Token*, using the
   *Edit Cloudflare Workers* template, and add *Account > Workers R2 Storage > Edit*.
   In GitHub, *Settings > Secrets and variables > Actions*, add:
   - `CLOUDFLARE_API_TOKEN`: the token
   - `CLOUDFLARE_ACCOUNT_ID`: from the Cloudflare dashboard's account home
3. **Data domain**: R2 bucket *whatsabove-data > Settings > Custom Domains > Connect domain*:
   `data.whatsabove.nyc`. Then *Caching > Cache Rules*: hostname equals `data.whatsabove.nyc`,
   *Eligible for cache*, *Respect origin* TTL. (Cloudflare doesn't cache .json files by default.)
4. **GitHub Pages**: *Settings > Pages > Source: GitHub Actions*, custom domain `whatsabove.nyc`.
   In Cloudflare DNS (DNS only, grey cloud):
   - `A @` → `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
   - `CNAME www` → `credibilllhen.github.io`
   When the certificate is ready, tick *Enforce HTTPS*.
5. Push to `main`, or run both workflows from the *Actions* tab. The poller starts within a
   minute of its first deploy. Check it at `https://whatsabove-poller.<your-subdomain>.workers.dev/status`.

## Settings

In `worker/wrangler.toml`:

- `POLL_SECONDS`: 10 fits the free Workers plan. The poller never sleeps, and at 5 s its running
  time lands near the free plan's daily limit; on the $5 plan, 5 is fine.
- `ADSB_URL`, `ADSB_PATH`: any ADSBExchange-v2-style API. For one that needs a key, add the key
  as a Worker secret: `npx wrangler secret put ADSB_API_KEY` (and `ADSB_KEY_HEADER` if it isn't
  `api-auth`).

## Updating the approaches

Replace `site/approaches.json` and push. Both the page and the poller use it. The current file
comes from FAA CIFP cycle 2611 (Oct 29 to Nov 26, 2026). Each entry is one published approach:

```json
{"a":"JFK","id":"S13L","t":"S","rwy":"13L","name":"VOR RWY 13L/13R","nick":"Canarsie",
 "gpa":3,"tch":58,"el":13,"gs":false,"p":[[lat,lon], ...]}
```

`p` runs from 15 nm out to the landing threshold; `gpa` is the glide path angle in degrees, `tch`
the threshold crossing height and `el` the threshold elevation, both in feet.

## Data and terms

Positions: [adsb.lol](https://adsb.lol), a volunteer ADS-B network. Routes: [adsbdb](https://www.adsbdb.com).
Both are for non-commercial use. Coastline © OpenStreetMap contributors (ODbL). Approaches: FAA CIFP.
