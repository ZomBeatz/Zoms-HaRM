#!/usr/bin/env bash
# Start Zom's HaRM. Binds to localhost by default.
#   HARM_HOST=0.0.0.0 HARM_TLS=1 ./run.sh   # serve HTTPS on the network (see scripts/make-cert.sh)
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  python3 -m venv .venv
  .venv/bin/pip install -q -r requirements.txt
fi
umask 077
tls=()
if [ "${HARM_TLS:-0}" = "1" ]; then
  cert=${HARM_TLS_CERT:-data/tls/harm.crt}
  key=${HARM_TLS_KEY:-data/tls/harm.key}
  [ -f "$cert" ] && [ -f "$key" ] || { echo "HARM_TLS=1 but $cert / $key not found. Run ./scripts/make-cert.sh first." >&2; exit 1; }
  tls=(--ssl-certfile "$cert" --ssl-keyfile "$key")
fi
for tool in tesseract zbarimg; do
  command -v "$tool" >/dev/null || echo "note: '$tool' not installed; label scanning will have reduced features" >&2
done
exec .venv/bin/uvicorn harm.main:app \
  --host "${HARM_HOST:-127.0.0.1}" --port "${HARM_PORT:-8077}" \
  --proxy-headers --forwarded-allow-ips "${HARM_TRUSTED_PROXIES:-127.0.0.1}" \
  --no-server-header "${tls[@]}" "$@"
