#!/usr/bin/env bash
# Zom's HaRM installer for Linux.
#
#   ./install.sh            # set up HaRM and add it to your app menu
#   ./install.sh --no-menu  # set up only (run it with ./run.sh)
#
# Everything stays inside this folder (the app in .venv/, your data in data/), plus a menu
# entry and icon in your home folder. Nothing needs root.
set -euo pipefail
cd "$(dirname "$0")"
say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

PY=""
for c in python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$c" >/dev/null && "$c" -c 'import sys; sys.exit(sys.version_info < (3, 10))' 2>/dev/null; then PY=$(command -v "$c"); break; fi
done
[ -n "$PY" ] || die "HaRM needs Python 3.10 or newer. Install it with your package manager (e.g. 'sudo apt install python3 python3-venv' or 'sudo pacman -S python')."
"$PY" -c 'import venv, ensurepip' 2>/dev/null || die "Python's venv module is missing. On Debian/Ubuntu: sudo apt install python3-venv"
say "Using $($PY --version) at $PY"

if [ ! -x .venv/bin/python ]; then
  say "Creating the app environment (.venv)…"
  "$PY" -m venv .venv
fi
say "Installing HaRM's parts (this takes a minute the first time)…"
.venv/bin/python -m pip install --quiet --upgrade pip
.venv/bin/python -m pip install --quiet -r requirements.txt

if [ "${1:-}" = "--no-menu" ]; then
  say "Done. Start HaRM with:  HARM_HOST=0.0.0.0 HARM_TLS=1 ./run.sh   (or just ./run.sh for this computer only)"
  exit 0
fi

# The desktop control panel needs Qt (PySide6). Use the system's copy if it has one, else install it here.
if "$PY" -c 'import PySide6.QtWidgets' 2>/dev/null; then
  say "Using your system's PySide6 for the desktop app."
  LAUNCH_PY=$PY
else
  say "Installing the desktop app's toolkit (PySide6, ~100 MB, one time)…"
  .venv/bin/python -m pip install --quiet -r requirements-desktop.txt
  LAUNCH_PY=$(pwd)/.venv/bin/python
fi
.venv/bin/python -m pip install --quiet "segno>=1.6,<2" 2>/dev/null || true

for tool in tesseract zbarimg qrencode; do
  command -v "$tool" >/dev/null || MISSING="${MISSING:-} $tool"
done
HARM_LAUNCHER_PY="$LAUNCH_PY" ./scripts/install-desktop-app.sh
echo
say "Installed! Open “Zom's HaRM” from your app menu, press Start, then Open HaRM."
[ -n "${MISSING:-}" ] && echo "    Optional extras not found:${MISSING}. (tesseract = reading text on labels, zbarimg = barcodes on the server, qrencode = QR codes if segno is unavailable.)"
echo "    Guide: GUIDE.md"
