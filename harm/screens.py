"""Screens on a machine: find the VNC servers it runs, and set one up with one click.

VNC needs a server on the machine that shares its screen. Find screens (read-only) lists the VNC
ports it listens on, including ones only open on the machine itself, and what kind of desktop it
has. On a Linux desktop that uses X11, Set up installs x11vnc as a service (zoms-harm-vnc) that
shares the desktop on 127.0.0.1 only, with a password HaRM keeps in the vault: so it can only be
reached through HaRM's SSH tunnel. Take it out removes the service again. Wayland desktops, Macs
and machines without a desktop get directions instead.
"""

import re
import secrets
import string

SERVICE = "zoms-harm-vnc"
PASSFILE = "/etc/zoms-harm-vnc.pass"

CHECK = r'''
echo "os=$(uname -s)"
echo "me=$(id -un)"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
if command -v ss >/dev/null 2>&1; then ss -Hltn 2>/dev/null | awk '{print $4}'
elif command -v netstat >/dev/null 2>&1; then netstat -ltn 2>/dev/null | awk 'NR>2 {print $4}'
fi | sed -n 's/^\(.*\)[:.]\(59[0-9][0-9]\)$/listen=\2 \1/p'
if command -v loginctl >/dev/null 2>&1; then
  for s in $(loginctl list-sessions --no-legend 2>/dev/null | awk '{print $1}'); do
    echo "session=$(loginctl show-session "$s" -p Type -p Class -p State -p Desktop -p Name 2>/dev/null | tr '\n' ' ')"
  done
fi
ls /tmp/.X11-unix 2>/dev/null | sed -n 's/^X\([0-9][0-9]*\)$/xdisplay=\1/p'
for p in x11vnc Xvnc wayvnc gnome-remote-desktop-daemon vino-server krfb Xtigervnc; do
  pgrep -x "$p" >/dev/null 2>&1 && echo "running=$p"
done
for p in sway Hyprland wayfire river labwc niri gnome-shell kwin_wayland; do
  pgrep -x "$p" >/dev/null 2>&1 && echo "comp=$p"
done
ls "$XDG_RUNTIME_DIR" 2>/dev/null | sed -n 's/^\(wayland-[0-9][0-9]*\)$/wsock=\1/p'
command -v x11vnc >/dev/null 2>&1 && echo "x11vnc=yes"
command -v wayvnc >/dev/null 2>&1 && echo "wayvnc=$(wayvnc -V 2>&1 | head -n 1)"
if command -v grdctl >/dev/null 2>&1; then grdctl --help 2>&1 | grep -qi vnc && echo "grdctl=vnc" || echo "grdctl=novnc"; fi
[ -f "$HOME/.config/systemd/user/zoms-harm-vnc.service" ] && echo "harmuser=$(systemctl --user is-active zoms-harm-vnc 2>/dev/null)"
[ -f /etc/systemd/system/zoms-harm-vnc.service ] && echo "harm=$(systemctl is-active zoms-harm-vnc 2>/dev/null)"
for pm in apt-get dnf zypper pacman apk; do command -v $pm >/dev/null 2>&1 && { echo "pm=$pm"; break; }; done
command -v systemctl >/dev/null 2>&1 && echo "systemd=yes"
[ "$(id -u)" = 0 ] && echo "root=yes"
true
'''


def parse(out: str) -> dict:
    """What Find screens learned, and what HaRM can do about it."""
    v: dict = {"ports": [], "sessions": [], "displays": [], "running": [], "x11vnc": False, "harm": None,
               "pm": None, "systemd": False, "os": "", "me": "", "comp": [], "wsock": [], "wayvnc": None,
               "grdctl": None, "harmuser": None}
    for line in out.splitlines():
        k, _, val = line.partition("=")
        val = val.strip()
        if k == "listen":
            port, _, addr = val.partition(" ")
            addr = addr.strip("[]")
            local = addr.startswith("127.") or addr in ("::1", "localhost")
            if not any(p["port"] == int(port) for p in v["ports"]):
                v["ports"].append({"port": int(port), "local": local})
            elif not local:  # listening everywhere wins
                next(p for p in v["ports"] if p["port"] == int(port))["local"] = False
        elif k == "session":
            f = dict(re.findall(r"(\w+)=(\S*)", val))
            v["sessions"].append({"type": f.get("Type", ""), "class": f.get("Class", ""), "state": f.get("State", ""),
                                  "desktop": f.get("Desktop", ""), "user": f.get("Name", "")})
        elif k == "xdisplay":
            v["displays"].append(int(val))
        elif k == "running":
            v["running"].append(val)
        elif k == "x11vnc":
            v["x11vnc"] = True
        elif k == "harm":
            v["harm"] = val or "unknown"
        elif k in ("pm", "os", "me", "grdctl"):
            v[k] = val
        elif k in ("comp", "wsock"):
            v[k].append(val)
        elif k == "wayvnc":
            m = re.search(r"(\d+)\.(\d+)", val)
            v["wayvnc"] = [int(m.group(1)), int(m.group(2))] if m else [0, 0]
        elif k == "harmuser":
            v["harmuser"] = val or "unknown"
        elif k == "systemd":
            v["systemd"] = True
    if v["harmuser"] and not v["harm"]:
        v["harm"] = v["harmuser"]
    v["ports"].sort(key=lambda p: p["port"])
    v.update(_verdict(v))
    return v


WLROOTS = ("sway", "hyprland", "wayfire", "river", "labwc")


def _verdict(v: dict) -> dict:
    users = [s for s in v["sessions"] if s["class"] == "user" and s["type"] in ("x11", "wayland")]
    wayland = [s for s in users if s["type"] == "wayland"]
    desk = (wayland or users or [{}])[0].get("desktop", "").lower()
    comps = [c.lower() for c in v["comp"]]
    if v["os"] == "Darwin":
        return {"can_setup": False, "kind": "mac", "how": None,
                "advice": "Macs have screen sharing built in: System Settings > General > Sharing > Screen Sharing. "
                          "Then open it here on port 5900."}
    if v["os"] and v["os"] != "Linux":
        return {"can_setup": False, "kind": "other", "how": None,
                "advice": f"HaRM can only set up screen sharing on Linux ({v['os']} here)."}
    if wayland and not [s for s in users if s["type"] == "x11"]:
        owner = wayland[0].get("user", "")
        gnome = "gnome" in desk or "gnome-shell" in comps
        kde = "kde" in desk or "plasma" in desk or "kwin_wayland" in comps
        wlr = next((c for c in WLROOTS if c in desk or c in comps), None)
        x11 = " Or sign in to an X11 session (like “GNOME on Xorg” or “Plasma (X11)”) and set up x11vnc here."
        if kde:
            return {"can_setup": False, "kind": "wayland", "how": None,
                    "advice": "This machine's desktop is KDE on Wayland, which asks on the screen itself before sharing it, "
                              "so HaRM can't turn it on from here. On the machine: install krfb (Desktop Sharing), open it, "
                              "turn on unattended access and set a password, then open port 5900 here." + x11}
        if not (gnome or wlr):
            return {"can_setup": False, "kind": "wayland", "how": None,
                    "advice": "This machine's desktop uses Wayland, which x11vnc can't share, and HaRM doesn't know how to "
                              "set up this one." + x11}
        if owner and v["me"] and owner != v["me"]:
            return {"can_setup": False, "kind": "wayland", "how": None,
                    "advice": f"The desktop belongs to {owner}, and screen sharing on Wayland is set up as that user. "
                              f"Pick a login for {owner} and check again."}
        if gnome:
            if v["grdctl"] == "vnc":
                return {"can_setup": True, "kind": "wayland", "how": "gnome", "advice": ""}
            return {"can_setup": False, "kind": "wayland", "how": None,
                    "advice": "GNOME shares its screen itself, but here only over RDP: on the machine, Settings > System > "
                              "Remote Desktop, turn on Desktop Sharing, then use 🔌 Connect > Remote desktop file (.rdp)."
                    if v["grdctl"] else "GNOME shares its screen with gnome-remote-desktop, which isn't installed here: "
                                         "install it, then check again."}
        if not v["systemd"] or not v["pm"] or not v["wsock"]:
            return {"can_setup": False, "kind": "wayland", "how": None,
                    "advice": f"{wlr.title()} shares its screen with wayvnc, which HaRM sets up with systemd and a package "
                              "manager while the desktop is running. Sign in to the desktop on the machine, then check again."}
        return {"can_setup": True, "kind": "wayland", "how": "wayvnc", "advice": ""}
    if not v["displays"]:
        return {"can_setup": False, "kind": "headless", "how": None,
                "advice": "This machine has no desktop to share (nothing is drawing a screen). Use the terminal instead, "
                          "or install a desktop first."}
    if not v["systemd"] or not v["pm"]:
        return {"can_setup": False, "kind": "other", "how": None,
                "advice": "HaRM sets up x11vnc with systemd and apt, dnf, zypper, pacman or apk, and this machine has "
                          "neither. Install x11vnc yourself and run it with -localhost."}
    return {"can_setup": True, "kind": "x11", "how": "x11vnc", "advice": ""}


def free_port(v: dict) -> int:
    used = {p["port"] for p in v["ports"]}
    return next(p for p in range(5900, 6000) if p not in used)


def new_password() -> str:
    """VNC passwords count only their first 8 characters."""
    abc = string.ascii_letters + string.digits
    return "".join(secrets.choice(abc) for _ in range(8))


def _install(pm: str, pkg: str) -> str:
    return {
        "apt-get": f"DEBIAN_FRONTEND=noninteractive apt-get install -y {pkg} || "
                   f"{{ DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y {pkg}; }}",
        "dnf": f"dnf -y install {pkg}",
        "zypper": f"zypper -n install {pkg}",
        "pacman": f"pacman -S --noconfirm --needed {pkg}",
        "apk": f"apk add {pkg}",
    }[pm]


def install_script(pm: str, pkg: str) -> str:
    """Install a package with sudo, if its program isn't there yet."""
    return f"command -v {pkg} >/dev/null 2>&1 || {{ {_install(pm, pkg)}; }} >/dev/null\necho HARM_RESULT=installed\n"


def setup_script(port: int, display: int, pm: str) -> str:
    """Install x11vnc and run it as a service on 127.0.0.1 only. Reads the password on its first input line."""
    install = _install(pm, "x11vnc")
    return f'''set -e
IFS= read -r PW
command -v x11vnc >/dev/null 2>&1 || {{ {install}; }} >/dev/null
X=$(command -v x11vnc)
umask 077
printf '%s\\n' "$PW" > {PASSFILE}
cat > /etc/systemd/system/{SERVICE}.service <<EOF
[Unit]
Description=Screen sharing for Zom's HaRM (x11vnc, only on this machine)
After=display-manager.service

[Service]
ExecStart=$X -display :{display} -auth guess -localhost -rfbport {port} -passwdfile {PASSFILE} -forever -shared -noxdamage -quiet
Restart=always
RestartSec=3

[Install]
WantedBy=graphical.target
EOF
chmod 644 /etc/systemd/system/{SERVICE}.service
systemctl daemon-reload
systemctl enable {SERVICE} >/dev/null 2>&1
systemctl restart {SERVICE}
sleep 3
if systemctl is-active --quiet {SERVICE}; then echo HARM_RESULT=ok; else
  echo HARM_RESULT=failed; journalctl -u {SERVICE} -n 5 --no-pager 2>/dev/null | tail -n 5
fi
'''


REMOVE = f'''systemctl disable --now {SERVICE} >/dev/null 2>&1
rm -f /etc/systemd/system/{SERVICE}.service {PASSFILE}
systemctl daemon-reload
echo HARM_RESULT=removed
'''


_USER_ENV = """export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
"""
WAYVNC_USER = "harm"


def wayvnc_script(port: int, wsock: str) -> str:
    """As the desktop's own user: wayvnc as a user service on 127.0.0.1 only, with a username and password
    (RSA-AES, which wayvnc has from 0.7). Reads the password on its first input line."""
    if not re.fullmatch(r"wayland-\d+", wsock):
        raise ValueError("bad Wayland socket name")
    return _USER_ENV + rf"""set -e
IFS= read -r PW
X=$(command -v wayvnc)
set -- $(wayvnc -V 2>&1 | head -n 1 | sed -n 's/[^0-9]*\([0-9][0-9]*\)\.\([0-9][0-9]*\).*/\1 \2/p')
if [ "${{1:-0}}" -eq 0 ] && [ "${{2:-0}}" -lt 7 ]; then echo HARM_RESULT=old; exit 0; fi
D="$HOME/.config/{SERVICE}"
mkdir -p "$D" "$HOME/.config/systemd/user"
chmod 700 "$D"
umask 077
[ -f "$D/rsa_key.pem" ] || ssh-keygen -q -m pem -t rsa -b 2048 -N '' -f "$D/rsa_key.pem" >/dev/null
cat > "$D/config" <<EOF
address=127.0.0.1
port={port}
enable_auth=true
username={WAYVNC_USER}
password=$PW
rsa_private_key_file=$D/rsa_key.pem
EOF
cat > "$HOME/.config/systemd/user/{SERVICE}.service" <<EOF
[Unit]
Description=Screen sharing for Zom's HaRM (wayvnc, only on this machine)

[Service]
Environment=WAYLAND_DISPLAY={wsock}
ExecStart=$X --config $D/config
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable {SERVICE} >/dev/null 2>&1
systemctl --user restart {SERVICE}
sleep 3
if systemctl --user is-active --quiet {SERVICE}; then echo HARM_RESULT=ok; else
  echo HARM_RESULT=failed; journalctl --user -u {SERVICE} -n 5 --no-pager 2>/dev/null | tail -n 5
fi
"""


WAYVNC_REMOVE = _USER_ENV + f"""systemctl --user disable --now {SERVICE} >/dev/null 2>&1
rm -rf "$HOME/.config/{SERVICE}" "$HOME/.config/systemd/user/{SERVICE}.service"
systemctl --user daemon-reload
echo HARM_RESULT=removed
"""

GNOME_SETUP = _USER_ENV + """set -e
IFS= read -r PW
grdctl vnc set-auth-method password
grdctl vnc set-password "$PW"
grdctl vnc disable-view-only
grdctl vnc enable
systemctl --user enable gnome-remote-desktop.service >/dev/null 2>&1 || true
systemctl --user restart gnome-remote-desktop.service
sleep 3
if systemctl --user is-active --quiet gnome-remote-desktop.service; then echo HARM_RESULT=ok; else
  echo HARM_RESULT=failed; journalctl --user -u gnome-remote-desktop -n 5 --no-pager 2>/dev/null | tail -n 5
fi
"""

GNOME_REMOVE = _USER_ENV + """grdctl vnc disable
systemctl --user restart gnome-remote-desktop.service >/dev/null 2>&1
echo HARM_RESULT=removed
"""
