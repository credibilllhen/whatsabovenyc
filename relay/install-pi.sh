#!/usr/bin/env bash
# Installs the whatsabove.nyc relay on a Raspberry Pi (Raspberry Pi OS / Debian) as a small,
# locked-down background service that reaches the data APIs only through Tor.
#
#   sudo bash install-pi.sh /path/to/token-file
#
# Safe to run again: it updates the relay and keeps the token.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo: sudo bash $0 <token-file>"; exit 1; }
TOKEN_SRC="${1:-}"
RAW="https://raw.githubusercontent.com/credibilllhen/whatsabovenyc/main/relay/relay.py"

echo "== 1/5  Token"
install -d -m 700 /etc/whatsabove
if [ -n "$TOKEN_SRC" ]; then
  [ -s "$TOKEN_SRC" ] || { echo "No token in $TOKEN_SRC"; exit 1; }
  install -m 600 -o root -g root "$TOKEN_SRC" /etc/whatsabove/token
  rm -f "$TOKEN_SRC"
fi
[ -s /etc/whatsabove/token ] || { echo "No token yet: sudo bash $0 <token-file>"; exit 1; }

echo "== 2/5  Tor (hides this network's address from the data APIs)"
command -v tor >/dev/null || { apt-get update -qq && apt-get install -y -qq tor; }
grep -q '^HTTPTunnelPort 127.0.0.1:9080' /etc/tor/torrc || printf '\n# whatsabove relay\nHTTPTunnelPort 127.0.0.1:9080\n' >> /etc/tor/torrc
systemctl enable -q tor
systemctl restart tor

echo "== 3/5  Relay"
install -d -m 755 /opt/whatsabove-relay
curl -fsSL "$RAW" -o /opt/whatsabove-relay/relay.py.new
python3 -m py_compile /opt/whatsabove-relay/relay.py.new
mv /opt/whatsabove-relay/relay.py.new /opt/whatsabove-relay/relay.py
chmod 644 /opt/whatsabove-relay/relay.py
rm -rf /opt/whatsabove-relay/__pycache__

echo "== 4/5  Service"
cat > /etc/systemd/system/whatsabove-relay.service <<'UNIT'
[Unit]
Description=whatsabove.nyc relay (ADS-B data via Tor to the Cloudflare poller)
Wants=network-online.target tor.service
After=network-online.target tor.service

[Service]
ExecStart=/usr/bin/python3 -I /opt/whatsabove-relay/relay.py
Environment=RELAY_PROXY=http://127.0.0.1:9080 RELAY_CITIES=nyc,boston PYTHONUNBUFFERED=1
LoadCredential=token:/etc/whatsabove/token
Restart=always
RestartSec=15

# Minimal resources: a low-priority sliver of one core and a hard memory cap.
Nice=15
CPUQuota=10%
MemoryMax=64M
TasksMax=8
IOSchedulingClass=idle

# Locked down: throwaway user, read-only system, no access to home folders or devices.
DynamicUser=yes
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=yes
RestrictRealtime=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
SystemCallArchitectures=native
CapabilityBoundingSet=

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable -q whatsabove-relay

echo "== 5/5  Checks"
for i in $(seq 1 30); do
  curl -s -o /dev/null -x http://127.0.0.1:9080 https://check.torproject.org/api/ip && break
  sleep 3
done
echo -n "Tor:      "; curl -s --max-time 20 -x http://127.0.0.1:9080 https://check.torproject.org/api/ip || echo "not ready yet"
echo
echo -n "adsb.lol through Tor: HTTP "; curl -s -o /dev/null -w '%{http_code}\n' --max-time 20 -x http://127.0.0.1:9080 \
  -A "Python-urllib/3" https://api.adsb.lol/v2/point/40.7/-73.92/5 || echo "no answer"
systemctl restart whatsabove-relay
sleep 25
echo
journalctl -u whatsabove-relay -n 5 --no-pager -o cat
echo
echo "Done. Live log: journalctl -u whatsabove-relay -f   Stop: sudo systemctl stop whatsabove-relay"
