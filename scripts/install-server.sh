#!/usr/bin/env bash
# Run Zom's HaRM as a background service on a Linux server (no desktop needed).
# It starts at boot, restarts if it crashes, and keeps its data in this folder's data/.
#
#   ./scripts/install-server.sh                         # install & start (asks for sudo)
#   ./scripts/install-server.sh --names "192.168.1.50 harm.lan"   # names/IPs phones use (default: auto-detected)
#   ./scripts/install-server.sh --port 8077
#   ./scripts/install-server.sh --print                 # just show the service file
#   ./scripts/install-server.sh --uninstall             # stop and remove the service (data is kept)
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
UNIT=/etc/systemd/system/zoms-harm.service
PORT=8077 NAMES="" PRINT=0
say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --names) NAMES=$2; shift 2 ;;
    --port) PORT=$2; shift 2 ;;
    --print) PRINT=1; shift ;;
    --uninstall)
      sudo systemctl disable --now zoms-harm.service 2>/dev/null || true
      sudo rm -f "$UNIT" && sudo systemctl daemon-reload
      say "Service removed. Your data is still in $ROOT/data."; exit 0 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done
case "$PORT" in ''|*[!0-9]*) echo "--port must be a number" >&2; exit 2 ;; esac
RUN_USER=${SUDO_USER:-$(id -un)}
case "$ROOT" in *" "*) echo "Move HaRM to a folder without spaces in its path (e.g. /opt/zoms-harm) and run this again." >&2; exit 1 ;; esac

unit() {
cat <<UNIT
[Unit]
Description=Zom's HaRM - Hardware & Rack Manager
After=network-online.target
Wants=network-online.target

[Service]
User=$RUN_USER
WorkingDirectory=$ROOT
Environment=PYTHONUNBUFFERED=1
ExecStartPre=$ROOT/.venv/bin/python -m harm.certs --ensure $NAMES
ExecStart=$ROOT/.venv/bin/uvicorn harm.main:app --host 0.0.0.0 --port $PORT --proxy-headers --forwarded-allow-ips 127.0.0.1 --no-server-header --ssl-certfile $ROOT/data/tls/harm.crt --ssl-keyfile $ROOT/data/tls/harm.key
Restart=on-failure
RestartSec=5
UMask=0077
# Hardening: HaRM only needs to write its own data folder.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$ROOT/data
ProtectKernelTunables=true
ProtectControlGroups=true

[Install]
WantedBy=multi-user.target
UNIT
}

if [ -z "$NAMES" ]; then
  NAMES="$(hostname) $(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.' | grep -v '^127\.' | tr '\n' ' ')"
fi
NAMES=$(echo "$NAMES" | xargs)
if [ "$PRINT" = 1 ]; then unit; exit 0; fi

command -v systemctl >/dev/null || { echo "This needs systemd. Use Docker (docker-compose.yml) or ./run.sh instead." >&2; exit 1; }
say "Setting up HaRM in $ROOT"
./install.sh --no-menu
mkdir -p data
say "HTTPS certificate for: $NAMES"
.venv/bin/python -m harm.certs --ensure $NAMES
say "Installing the service (needs sudo)…"
unit | sudo tee "$UNIT" >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now zoms-harm.service
sleep 2
if systemctl is-active --quiet zoms-harm.service; then
  say "HaRM is running. Open one of these and create your master password:"
  for n in $NAMES; do echo "      https://$n:$PORT"; done
  echo "    Phones: trust the certificate first (https://<address>:$PORT/harm-ca.crt; see GUIDE.md > Connect your phone)."
  if command -v ufw >/dev/null && sudo ufw status 2>/dev/null | grep -q "Status: active"; then
    echo "    Firewall (ufw) is on. Allow your network, e.g.:  sudo ufw allow from 192.168.1.0/24 to any port $PORT proto tcp"
  fi
  echo "    Logs: journalctl -u zoms-harm -f    ·    Stop: sudo systemctl stop zoms-harm"
else
  echo "HaRM didn't start. See: journalctl -u zoms-harm -n 50" >&2; exit 1
fi
