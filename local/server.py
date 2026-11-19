#!/usr/bin/env python3
"""
Local mode: serves the site and proxies flight-data APIs so the browser never
has to make cross-origin requests. Standard library only. The deployed site
doesn't use this; it reads the shared feed the Cloudflare poller writes.

    python3 local/server.py               # then open http://localhost:8080

Defaults to adsb.lol for live traffic, which needs no key.

Environment variables (all optional):
    PORT=8080                             port to serve on
    HOST=127.0.0.1                        set 0.0.0.0 to reach it from other devices (e.g. on a Pi)
    FREEFLIGHT_URL=http://localhost:8000  your FreeFlight container
    FREEFLIGHT_API_KEY=...                only if you set FREEFLIGHT_API_KEYS on it
    FREEFLIGHT_KEY_HEADER=X-API-Key       header FreeFlight expects the key in
    ADSB_URL=https://api.adsb.lol         any ADSBExchange-v2-style server
    ADSB_PATH=/v2/point/{lat}/{lon}/{dist}
                                          ADSBExchange itself: /v2/lat/{lat}/lon/{lon}/dist/{dist}/
    ADSB_API_KEY=...                      sent in ADSB_KEY_HEADER (default api-auth)
    ADSB_KEY_HEADER=api-auth              RapidAPI uses X-RapidAPI-Key
"""
import json
import os
import statistics
import urllib.parse
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "site"
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8080"))


def _headers(key_env, header_env, default_header):
    key = os.environ.get(key_env)
    return {os.environ.get(header_env, default_header): key} if key else {}


UPSTREAMS = {
    "/ff/": (os.environ.get("FREEFLIGHT_URL", "http://localhost:8000"),
             _headers("FREEFLIGHT_API_KEY", "FREEFLIGHT_KEY_HEADER", "X-API-Key")),
    "/adsb/": (os.environ.get("ADSB_URL", "https://api.adsb.lol"),
               _headers("ADSB_API_KEY", "ADSB_KEY_HEADER", "api-auth")),
    "/adsbdb/": ("https://api.adsbdb.com", {}),
}
if "rapidapi" in UPSTREAMS["/adsb/"][0] and UPSTREAMS["/adsb/"][1]:
    UPSTREAMS["/adsb/"][1]["X-RapidAPI-Host"] = UPSTREAMS["/adsb/"][0].split("//", 1)[-1].split("/")[0]


GROUND_FT = 15  # JFK, LGA, EWR and TEB all sit within a few feet of this


def drop_low(body, min_agl):
    """Remove aircraft on the ground or below min_agl feet from an ADS-B v2 response.

    Barometric altitude is pressure altitude (standard 1013.25 hPa), so it's corrected with the
    local altimeter setting: the median nav_qnh reported by aircraft below 18,000 ft.
    The public APIs can't filter by altitude, so this saves the browser work, not API calls.
    """
    try:
        data = json.loads(body)
    except ValueError:
        return body
    ac = data.get("ac")
    if not isinstance(ac, list):
        return body
    qnhs = [a["nav_qnh"] for a in ac if isinstance(a.get("nav_qnh"), (int, float))
            and isinstance(a.get("alt_baro"), (int, float)) and a["alt_baro"] < 18000]
    corr = (statistics.median(qnhs) - 1013.25) * 27.3 if len(qnhs) >= 3 else 0.0

    def keep(a):
        alt = a.get("alt_baro")
        if alt == "ground":
            return False
        if not isinstance(alt, (int, float)):
            return True  # no altitude reported: let the page decide
        return alt + corr - GROUND_FT >= min_agl

    data["ac"] = [a for a in ac if keep(a)]
    data["filtered_low"] = len(ac) - len(data["ac"])
    return json.dumps(data).encode()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        if self.path.split("?")[0] == "/proxy/status":
            return self._json(200, {
                "ok": True,
                "freeflight": UPSTREAMS["/ff/"][0],
                "adsb": UPSTREAMS["/adsb/"][0],
                "adsbPath": os.environ.get("ADSB_PATH", "/v2/point/{lat}/{lon}/{dist}"),
            })
        for prefix, (base, extra) in UPSTREAMS.items():
            if self.path.startswith(prefix):
                path, min_agl = self.path[len(prefix):], None
                if prefix == "/adsb/" and "?" in path:  # our own option, stripped before calling the API
                    p, q = path.split("?", 1)
                    params = urllib.parse.parse_qsl(q, keep_blank_values=True)
                    min_agl = next((float(v) for k, v in params if k == "min_agl"), None)
                    rest = urllib.parse.urlencode([(k, v) for k, v in params if k != "min_agl"])
                    path = p + ("?" + rest if rest else "")
                return self._proxy(base.rstrip("/") + "/" + path, extra, min_agl)
        if self.path.split("?")[0] == "/approaches.js":  # built from approaches.json, as the deploy does
            data = (ROOT / "approaches.json").read_text()
            body = ("window.APPROACHES_DATA=" + data + ";\n").encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            return self.wfile.write(body)
        if self.path in ("/", ""):
            self.path = "/index.html"
        if not self.path.split("?")[0] == "/index.html":
            return self._json(404, {"error": "not found"})  # don't serve the rest of the folder
        return super().do_GET()

    def _proxy(self, url, extra, min_agl=None):
        req = urllib.request.Request(url, headers={
            "User-Agent": "nyc-airspace-3d/1.0", "Accept": "application/json", **extra})
        try:
            with urllib.request.urlopen(req, timeout=12) as r:
                body, status, ctype = r.read(), r.status, r.headers.get("Content-Type", "application/json")
        except urllib.error.HTTPError as e:
            body, status, ctype = e.read(), e.code, e.headers.get("Content-Type", "application/json")
        except Exception as e:  # connection refused, DNS, timeout
            reason = getattr(e, "reason", e)
            return self._json(502, {"error": f"{reason}", "upstream": url})
        if min_agl is not None and status == 200:
            body = drop_low(body, min_agl)
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        if len(args) > 1 and str(args[1]).startswith(("2", "3")):
            return  # keep the console quiet for successful polls
        super().log_message(fmt, *args)


if __name__ == "__main__":
    print(f"NYC airspace viewer on http://{'localhost' if HOST == '0.0.0.0' else HOST}:{PORT}")
    print(f"  FreeFlight -> {UPSTREAMS['/ff/'][0]}")
    print(f"  ADS-B v2   -> {UPSTREAMS['/adsb/'][0]}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
