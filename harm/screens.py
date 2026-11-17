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
if command -v ss >/dev/null 2>&1; then ss -Hltn 2>/dev/null | awk '{print $4}'
elif command -v netstat >/dev/null 2>&1; then netstat -ltn 2>/dev/null | awk 'NR>2 {print $4}'
fi | sed -n 's/^\(.*\)[:.]\(59[0-9][0-9]\)$/listen=\2 \1/p'
if command -v loginctl >/dev/null 2>&1; then
  for s in $(loginctl list-sessions --no-legend 2>/dev/null | awk '{print $1}'); do
    echo "session=$(loginctl show-session "$s" -p Type -p Class -p State -p Desktop 2>/dev/null | tr '\n' ' ')"
  done
fi
ls /tmp/.X11-unix 2>/dev/null | sed -n 's/^X\([0-9][0-9]*\)$/xdisplay=\1/p'
for p in x11vnc Xvnc wayvnc gnome-remote-desktop-daemon vino-server krfb Xtigervnc; do
  pgrep -x "$p" >/dev/null 2>&1 && echo "running=$p"
done
command -v x11vnc >/dev/null 2>&1 && echo "x11vnc=yes"
[ -f /etc/systemd/system/zoms-harm-vnc.service ] && echo "harm=$(systemctl is-active zoms-harm-vnc 2>/dev/null)"
for pm in apt-get dnf zypper pacman apk; do command -v $pm >/dev/null 2>&1 && { echo "pm=$pm"; break; }; done
command -v systemctl >/dev/null 2>&1 && echo "systemd=yes"
[ "$(id -u)" = 0 ] && echo "root=yes"
true
'''


def parse(out: str) -> dict:
    """What Find screens learned, and what HaRM can do about it."""
    v: dict = {"ports": [], "sessions": [], "displays": [], "running": [], "x11vnc": False, "harm": None,
               "pm": None, "systemd": False, "os": ""}
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
                                  "desktop": f.get("Desktop", "")})
        elif k == "xdisplay":
            v["displays"].append(int(val))
        elif k == "running":
            v["running"].append(val)
        elif k == "x11vnc":
            v["x11vnc"] = True
        elif k == "harm":
            v["harm"] = val or "unknown"
        elif k in ("pm", "os"):
            v[k] = val
        elif k == "systemd":
            v["systemd"] = True
    v["ports"].sort(key=lambda p: p["port"])
    v.update(_verdict(v))
    return v


def _verdict(v: dict) -> dict:
    users = [s for s in v["sessions"] if s["class"] == "user" and s["type"] in ("x11", "wayland")]
    wayland = [s for s in users if s["type"] == "wayland"]
    desk = (wayland or users or [{}])[0].get("desktop", "").lower()
    if v["os"] == "Darwin":
        return {"can_setup": False, "kind": "mac",
                "advice": "Macs have screen sharing built in: System Settings > General > Sharing > Screen Sharing. "
                          "Then open it here on port 5900."}
    if v["os"] and v["os"] != "Linux":
        return {"can_setup": False, "kind": "other", "advice": f"HaRM can only set up screen sharing on Linux ({v['os']} here)."}
    if wayland and not [s for s in users if s["type"] == "x11"]:
        if "gnome" in desk:
            how = "GNOME shares its screen itself: Settings > System > Remote Desktop, turn on Desktop Sharing and VNC (or use RDP)."
        elif "kde" in desk or "plasma" in desk:
            how = "KDE shares its screen with Krfb (Desktop Sharing): install krfb and turn it on."
        else:
            how = "Sway and other wlroots desktops share the screen with wayvnc: install it and run wayvnc 127.0.0.1."
        return {"can_setup": False, "kind": "wayland",
                "advice": "This machine's desktop uses Wayland, which x11vnc can't share. " + how
                          + " Or sign in to an X11 session (like “GNOME on Xorg” or “Plasma (X11)”) and set it up here."}
    if not v["displays"]:
        return {"can_setup": False, "kind": "headless",
                "advice": "This machine has no desktop to share (nothing is drawing a screen). Use the terminal instead, "
                          "or install a desktop first."}
    if not v["systemd"] or not v["pm"]:
        return {"can_setup": False, "kind": "other",
                "advice": "HaRM sets up x11vnc with systemd and apt, dnf, zypper, pacman or apk, and this machine has "
                          "neither. Install x11vnc yourself and run it with -localhost."}
    return {"can_setup": True, "kind": "x11", "advice": ""}


def free_port(v: dict) -> int:
    used = {p["port"] for p in v["ports"]}
    return next(p for p in range(5900, 6000) if p not in used)


def new_password() -> str:
    """VNC passwords count only their first 8 characters."""
    abc = string.ascii_letters + string.digits
    return "".join(secrets.choice(abc) for _ in range(8))


def setup_script(port: int, display: int, pm: str) -> str:
    """Install x11vnc and run it as a service on 127.0.0.1 only. Reads the password on its first input line."""
    install = {
        "apt-get": "DEBIAN_FRONTEND=noninteractive apt-get install -y x11vnc || "
                   "{ DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y x11vnc; }",
        "dnf": "dnf -y install x11vnc",
        "zypper": "zypper -n install x11vnc",
        "pacman": "pacman -S --noconfirm --needed x11vnc",
        "apk": "apk add x11vnc",
    }[pm]
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
