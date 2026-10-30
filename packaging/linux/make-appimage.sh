#!/usr/bin/env bash
# Wrap dist/zoms-harm/ (from PyInstaller) into dist/Zoms-HaRM_<version>_amd64.AppImage.
#   VERSION=0.3.2 packaging/linux/make-appimage.sh      (needs appimagetool on PATH)
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${VERSION:?set VERSION, e.g. VERSION=0.3.2}"
app=build/Zoms-HaRM.AppDir
rm -rf "$app" && mkdir -p "$app/usr/lib" "$app/usr/share/icons/hicolor/256x256/apps"
cp -a dist/zoms-harm "$app/usr/lib/zoms-harm"
cp packaging/linux/zoms-harm.desktop "$app/zoms-harm.desktop"
cp branding/harm-icon-256.png "$app/zoms-harm.png"
cp branding/harm-icon-256.png "$app/usr/share/icons/hicolor/256x256/apps/zoms-harm.png"
cat > "$app/AppRun" <<'RUN'
#!/bin/sh
exec "$(dirname "$(readlink -f "$0")")/usr/lib/zoms-harm/zoms-harm" "$@"
RUN
chmod +x "$app/AppRun"
ARCH=x86_64 appimagetool "$app" "dist/Zoms-HaRM_${VERSION}_amd64.AppImage"
