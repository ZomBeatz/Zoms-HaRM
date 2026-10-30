#!/usr/bin/env bash
# Add "Zom's HaRM" to your desktop's app menu (KDE, GNOME, …) with its icon.
# Installs for your user only; nothing outside your home folder is touched.
#
#   ./scripts/install-desktop-app.sh             # install / update
#   ./scripts/install-desktop-app.sh --uninstall # remove it again
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
ID=zoms-harm
APPS="$HOME/.local/share/applications"
ICONS="$HOME/.local/share/icons/hicolor"

refresh() {
  command -v update-desktop-database >/dev/null && update-desktop-database -q "$APPS" || true
  command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t "$ICONS" 2>/dev/null || true
  command -v kbuildsycoca6 >/dev/null && kbuildsycoca6 >/dev/null 2>&1 || true
}

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$APPS/$ID.desktop" "$HOME/.config/autostart/$ID.desktop" "$ICONS/scalable/apps/$ID.svg"
  for s in 16 22 24 32 48 64 128 256 512; do rm -f "$ICONS/${s}x${s}/apps/$ID.png"; done
  refresh
  echo "Removed Zom's HaRM from the app menu. (The server, your data and the project folder are untouched.)"
  exit 0
fi

PY=${HARM_LAUNCHER_PY:-}
if [ -z "$PY" ]; then
  if [ -x .venv/bin/python ] && .venv/bin/python -c "import PySide6.QtWidgets" 2>/dev/null; then PY="$ROOT/.venv/bin/python"; else PY=$(command -v python3); fi
fi
"$PY" -c "import PySide6.QtWidgets" 2>/dev/null || {
  echo "The control panel needs PySide6 (Qt for Python). Install it first, e.g.:" >&2
  echo "  Easiest: run ./install.sh (it installs it for HaRM only)." >&2
  echo "  Or system-wide - Arch/CachyOS: sudo pacman -S pyside6   Debian/Ubuntu: sudo apt install python3-pyside6.qtwidgets" >&2
  exit 1
}

mkdir -p "$APPS" "$ICONS/scalable/apps"
install -m 644 branding/harm-icon.svg "$ICONS/scalable/apps/$ID.svg"
if command -v rsvg-convert >/dev/null; then
  for s in 16 22 24 32 48 64 128 256 512; do
    mkdir -p "$ICONS/${s}x${s}/apps"
    rsvg-convert -w "$s" -h "$s" branding/harm-icon.svg -o "$ICONS/${s}x${s}/apps/$ID.png"
  done
fi

cat > "$APPS/$ID.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Version=1.0
Name=Zom's HaRM
GenericName=Hardware & Rack Manager
Comment=Start the HaRM server and open HaRM
Exec="$PY" "$ROOT/launcher/harm_launcher.py"
Icon=$ID
Terminal=false
Categories=Utility;
Keywords=HaRM;rack;server;homelab;inventory;hardware;
StartupNotify=true
StartupWMClass=$ID
SingleMainWindow=true
Actions=open;

[Desktop Action open]
Name=Open HaRM in the browser
Exec="$PY" "$ROOT/launcher/harm_launcher.py" --open
DESKTOP
chmod 644 "$APPS/$ID.desktop"
refresh
echo "Installed. Find “Zom's HaRM” in your app menu (it may take a few seconds to appear)."
