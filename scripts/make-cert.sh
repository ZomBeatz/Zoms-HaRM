#!/usr/bin/env bash
# Create (or re-issue) HaRM's HTTPS certificate, signed by HaRM's own local authority.
# Phones trust the authority once (data/tls/harm-ca.crt); re-issuing for a new IP keeps that trust.
#
#   ./scripts/make-cert.sh                       # this computer's hostname and LAN IPs
#   ./scripts/make-cert.sh harm.lan 192.168.1.50 # specific names and/or IPs
set -euo pipefail
cd "$(dirname "$0")/.."
PY=.venv/bin/python
[ -x "$PY" ] || PY=python3
exec "$PY" -m harm.certs "$@"
