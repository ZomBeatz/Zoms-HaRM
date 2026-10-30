#!/usr/bin/env python3
"""Zom's HaRM: desktop control panel for the HaRM server (Qt / PySide6).

Start, stop and restart the server, see the addresses phones should use, open HaRM,
and keep it running from the system tray. The server runs as its own process, so it
keeps going if this window is closed (or even if the launcher quits, if you choose).

    python3 launcher/harm_launcher.py               # open the control panel
    python3 launcher/harm_launcher.py --background  # start the server, tray only (used at login)
    python3 launcher/harm_launcher.py --open        # start if needed, then open HaRM in the browser
"""

import ipaddress
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

from PySide6.QtCore import Qt, QTimer, QUrl
from PySide6.QtGui import QAction, QDesktopServices, QGuiApplication, QIcon
from PySide6.QtNetwork import QLocalServer, QLocalSocket
from PySide6.QtWidgets import (QApplication, QCheckBox, QFrame, QGridLayout, QHBoxLayout, QLabel,
                               QMenu, QMessageBox, QPlainTextEdit, QPushButton, QSpinBox,
                               QSystemTrayIcon, QToolButton, QVBoxLayout, QWidget)

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CONF = DATA / "launcher.json"
LOG = DATA / "logs" / "server.log"
CERT, KEY = DATA / "tls" / "harm.crt", DATA / "tls" / "harm.key"
ICON = ROOT / "branding" / "harm-icon.svg"
CHECK = (Path(__file__).resolve().parent / "check.svg").as_posix()
WINDOWS = os.name == "nt"
VENV_PY = ROOT / ".venv" / ("Scripts/python.exe" if WINDOWS else "bin/python")
SERVER_INFO = DATA / "server.json"  # written when this app starts the server (used where /proc doesn't exist)
APP_ID = "zoms-harm"
try:
    VERSION = re.search(r'__version__ = "([^"]+)"', (ROOT / "harm" / "__init__.py").read_text()).group(1)
except (OSError, AttributeError):
    VERSION = ""
DEFAULTS = {"network": True, "https": True, "port": 8077, "autostart": False, "close_to_tray": True,
            "tray_hint_shown": False}
AUTOSTART = Path.home() / ".config" / "autostart" / f"{APP_ID}.desktop"

COLORS = {"bg": "#14161c", "panel": "#1a1e27", "panel2": "#222733", "line": "#2e3442", "text": "#e6e9ef",
          "muted": "#9aa3b5", "blue": "#4fb0ec", "blue_dk": "#2580c3", "orange": "#ec6a3f",
          "ok": "#46c2a0", "warn": "#e8b04a", "bad": "#ef6b6b"}

STYLE = f"""
QWidget {{ background: {COLORS['bg']}; color: {COLORS['text']}; font-size: 10.5pt; }}
QFrame#card {{ background: {COLORS['panel']}; border: 1px solid {COLORS['line']}; border-radius: 10px; }}
QFrame#card QLabel, QFrame#card QCheckBox, QWidget#clear {{ background: transparent; }}
QLabel#h {{ color: {COLORS['muted']}; font-size: 8.5pt; font-weight: 700; letter-spacing: 1px; }}
QLabel#muted {{ color: {COLORS['muted']}; }}
QLabel#status {{ font-size: 17pt; font-weight: 800; }}
QLabel#addr {{ font-family: monospace; font-size: 11pt; }}
QLabel#warn {{ color: {COLORS['warn']}; }}
QPushButton, QToolButton {{ background: {COLORS['panel2']}; border: 1px solid {COLORS['line']}; border-radius: 7px;
  padding: 7px 14px; color: {COLORS['text']}; }}
QPushButton:hover, QToolButton:hover {{ border-color: {COLORS['muted']}; }}
QPushButton:disabled {{ color: #5b6375; }}
QPushButton#primary {{ background: {COLORS['blue']}; border-color: {COLORS['blue']}; color: #06223a; font-weight: 700; }}
QPushButton#primary:hover {{ background: #6cc0f2; }}
QPushButton#danger {{ color: {COLORS['bad']}; }}
QToolButton#small {{ padding: 3px 9px; font-size: 9pt; }}
QCheckBox {{ spacing: 9px; }}
QCheckBox::indicator {{ width: 17px; height: 17px; border-radius: 4px; border: 1px solid {COLORS['muted']}; background: {COLORS['panel2']}; }}
QCheckBox::indicator:checked {{ background: {COLORS['blue']}; border-color: {COLORS['blue']}; image: url({CHECK}); }}
QSpinBox {{ background: {COLORS['panel2']}; border: 1px solid {COLORS['line']}; border-radius: 6px; padding: 4px 6px; }}
QPlainTextEdit {{ background: #0c0e13; border: 1px solid {COLORS['line']}; border-radius: 8px; font-family: monospace;
  font-size: 9pt; color: {COLORS['muted']}; }}
QMenu {{ background: {COLORS['panel']}; border: 1px solid {COLORS['line']}; padding: 4px; }}
QMenu::item {{ padding: 6px 18px; border-radius: 5px; }}
QMenu::item:selected {{ background: {COLORS['panel2']}; }}
"""


# ---------------------------------------------------------------- self-update

_LOADED_MTIME = Path(__file__).stat().st_mtime


def code_changed() -> bool:
    """True when this file was updated after the panel started (so it can offer to reload)."""
    try:
        return Path(__file__).stat().st_mtime > _LOADED_MTIME + 1
    except OSError:
        return False


def uptime(seconds: float) -> str:
    """3d 4h 05m 09s / 2h 03m 41s / 4m 07s"""
    s = max(0, int(seconds))
    d, s = divmod(s, 86400)
    hr, s = divmod(s, 3600)
    m, s = divmod(s, 60)
    if d:
        return f"{d}d {hr}h {m:02d}m {s:02d}s"
    if hr:
        return f"{hr}h {m:02d}m {s:02d}s"
    return f"{m}m {s:02d}s"


# ---------------------------------------------------------------- settings

def load_conf() -> dict:
    try:
        return {**DEFAULTS, **json.loads(CONF.read_text())}
    except (OSError, ValueError):
        return dict(DEFAULTS)


def save_conf(conf: dict) -> None:
    DATA.mkdir(exist_ok=True)
    CONF.write_text(json.dumps(conf, indent=2))


# ---------------------------------------------------------------- server discovery

def pid_alive(pid: int) -> bool:
    if WINDOWS:
        import ctypes
        h = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return False
        code = ctypes.c_ulong()
        ctypes.windll.kernel32.GetExitCodeProcess(h, ctypes.byref(code))
        ctypes.windll.kernel32.CloseHandle(h)
        return code.value == 259  # STILL_ACTIVE
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def harm_servers() -> list[dict]:
    """HaRM server processes of this user, however they were started (here or ./run.sh)."""
    if not Path("/proc/self").exists():  # Windows / macOS: only servers this app started
        try:
            info = json.loads(SERVER_INFO.read_text())
        except (OSError, ValueError):
            return []
        return [info] if pid_alive(int(info.get("pid", 0))) else []
    found = []
    for p in Path("/proc").iterdir():
        if not p.name.isdigit():
            continue
        try:
            if p.stat().st_uid != os.getuid():
                continue
            args = (p / "cmdline").read_bytes().split(b"\0")
            args = [a.decode(errors="replace") for a in args if a]
        except OSError:
            continue
        if "harm.main:app" not in args or not any("uvicorn" in a for a in args[:3]):
            continue
        opt = lambda flag, default=None: args[args.index(flag) + 1] if flag in args and args.index(flag) + 1 < len(args) else default
        found.append({"pid": int(p.name), "host": opt("--host", "127.0.0.1"), "port": int(opt("--port", "8000")),
                      "https": "--ssl-certfile" in args, "started": p.stat().st_mtime})
    return found


def port_open(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.3):
            return True
    except OSError:
        return False


def lan_ips() -> list[tuple[str, str]]:
    out = []
    if shutil.which("ip"):
        try:
            p = subprocess.run(["ip", "-j", "-4", "addr"], capture_output=True, text=True, timeout=3)
            for link in json.loads(p.stdout or "[]"):
                name = link.get("ifname", "")
                if name == "lo" or name.startswith(("docker", "br-", "veth", "virbr", "tailscale", "wg")):
                    continue
                out += [(a["local"], name) for a in link.get("addr_info", []) if a.get("local")]
        except (OSError, ValueError, subprocess.TimeoutExpired):
            pass
    if not out:  # Windows / macOS: ask the OS which address it would use for the LAN
        for ip in _fallback_ips():
            out.append((ip, "network"))
    return out


def _fallback_ips() -> list[str]:
    ips = []
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))  # no packet is sent
            ips.append(s.getsockname()[0])
    except OSError:
        pass
    try:
        ips += [i[4][0] for i in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)]
    except OSError:
        pass
    return [ip for ip in dict.fromkeys(ips) if not ip.startswith(("127.", "169.254."))]


_CERT_CACHE: dict = {}


def cert_names() -> set[str]:
    """Names the HTTPS certificate covers (read with HaRM's own Python, cached until the file changes)."""
    try:
        mtime = CERT.stat().st_mtime
    except OSError:
        return set()
    if _CERT_CACHE.get("mtime") != mtime and VENV_PY.exists():
        p = subprocess.run([str(VENV_PY), "-c", "import json; from harm import certs; print(json.dumps(sorted(certs.cert_names())))"],
                           cwd=ROOT, capture_output=True, text=True, **_no_window())
        try:
            _CERT_CACHE.update(mtime=mtime, names=set(json.loads(p.stdout)))
        except ValueError:
            return set()
    return _CERT_CACHE.get("names", set())


def _no_window() -> dict:
    """Keep helper commands from flashing a console window on Windows."""
    return {"creationflags": 0x08000000} if WINDOWS else {}


# ---------------------------------------------------------------- UI helpers

_LUCIDE: dict | None = None


def lucide(name: str, color: str = "#e6e8ef", size: int = 16) -> QIcon:
    """A Lucide icon (same set as the web app, from harm/static/icons.js) as a QIcon."""
    global _LUCIDE
    from PySide6.QtGui import QPixmap
    if _LUCIDE is None:
        try:
            text = (ROOT / "harm" / "static" / "icons.js").read_text()
            _LUCIDE = json.loads(text[text.index("{"): text.rindex("}") + 1])
        except (OSError, ValueError):
            _LUCIDE = {}
    parts = "".join(f"<{tag} " + " ".join(f'{k}="{v}"' for k, v in attrs.items()) + "/>" for tag, attrs in _LUCIDE.get(name, []))
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{size * 2}" height="{size * 2}" viewBox="0 0 24 24" fill="none" '
           f'stroke="{color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">{parts}</svg>')
    pm = QPixmap()
    pm.loadFromData(svg.encode(), "SVG")
    return QIcon(pm)

def card(title: str | None = None) -> tuple[QFrame, QVBoxLayout]:
    f = QFrame(objectName="card")
    lay = QVBoxLayout(f)
    lay.setContentsMargins(16, 14, 16, 14)
    lay.setSpacing(10)
    if title:
        lay.addWidget(QLabel(title.upper(), objectName="h"))
    return f, lay


class Panel(QWidget):
    def __init__(self, app: QApplication, background: bool):
        super().__init__()
        self.app = app
        self.conf = load_conf()
        self.proc_started_here: int | None = None
        self.state = None
        self.quitting = False
        self.setWindowTitle(f"Zom's HaRM {VERSION}".strip())
        self.setWindowIcon(app.windowIcon())
        self.setMinimumWidth(500)
        self.setStyleSheet(STYLE)
        self.build()
        self.build_tray()
        self.timer = QTimer(self, interval=1500, timeout=self.refresh)
        self.timer.start()
        self.clock = QTimer(self, interval=1000, timeout=self.tick_uptime)
        self.clock.start()
        self.refresh()
        if background:
            if not harm_servers():
                self.start()
        else:
            self.show()

    # ---------------- layout
    def build(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(18, 18, 18, 18)
        root.setSpacing(12)

        head = QHBoxLayout()
        logo = QLabel()
        logo.setPixmap(self.app.windowIcon().pixmap(84, 84))
        head.addWidget(logo)
        title = QLabel(f"<span style='font-size:19pt;font-weight:800'>Zom's <span style='color:{COLORS['blue']}'>HaRM</span></span>"
                       f"<br><span style='color:{COLORS['muted']};letter-spacing:1px;font-size:8.5pt;font-weight:700'>"
                       "HARDWARE &amp; RACK MANAGER · SERVER</span>")
        head.addWidget(title, 1)
        root.addLayout(head)
        self.update_bar = QPushButton(lucide("rotate-cw", "#0a0c10"), " The control panel was updated. Click to reload it (the server keeps running).",
                                      objectName="primary", clicked=lambda: self.reload_self())
        self.update_bar.hide()
        root.addWidget(self.update_bar)

        # status
        c, lay = card()
        row = QHBoxLayout()
        self.dot = QLabel("●")
        self.dot.setStyleSheet("font-size: 20pt; background: transparent;")
        self.status = QLabel("…", objectName="status")
        self.status_sub = QLabel("", objectName="muted")
        col = QVBoxLayout()
        col.setSpacing(0)
        col.addWidget(self.status)
        col.addWidget(self.status_sub)
        row.addWidget(self.dot)
        row.addLayout(col, 1)
        lay.addLayout(row)
        btns = QHBoxLayout()
        self.b_start = QPushButton(lucide("play", "#0a0c10"), " Start", objectName="primary", clicked=lambda: self.start())
        self.b_stop = QPushButton(lucide("square", COLORS["bad"]), " Stop", objectName="danger", clicked=lambda: self.stop())
        self.b_restart = QPushButton(lucide("rotate-cw"), " Restart", clicked=lambda: self.restart())
        self.b_open = QPushButton(lucide("external-link", "#0a0c10"), " Open HaRM", objectName="primary", clicked=lambda: self.open_harm())
        for b in (self.b_start, self.b_stop, self.b_restart):
            btns.addWidget(b)
        btns.addStretch(1)
        btns.addWidget(self.b_open)
        lay.addLayout(btns)
        root.addWidget(c)

        # addresses
        c, self.addr_lay = card("Where to open it")
        self.addr_widget = QWidget()
        self.addr_lay.addWidget(self.addr_widget)
        self.cert_warn = QLabel("", objectName="warn", wordWrap=True)
        self.cert_fix = QPushButton("Fix certificate", clicked=lambda: self.fix_cert())
        warn_row = QHBoxLayout()
        warn_row.addWidget(self.cert_warn, 1)
        warn_row.addWidget(self.cert_fix)
        self.addr_lay.addLayout(warn_row)
        self.phone_row = QWidget(objectName="clear")
        phone = QHBoxLayout(self.phone_row)
        phone.setContentsMargins(0, 0, 0, 0)
        phone.addWidget(QLabel("Setting up a phone? Step-by-step guide with QR codes and a live checklist.", objectName="muted", wordWrap=True), 1)
        phone.addWidget(QPushButton(lucide("smartphone", "#0a0c10"), " Phone setup", objectName="primary", clicked=lambda: self.phone_setup()))
        self.addr_lay.addWidget(self.phone_row)
        self.addr_card = c
        root.addWidget(c)

        # settings
        c, lay = card("Settings")
        self.c_net = QCheckBox("Let phones and other devices connect (share on my network)")
        self.c_https = QCheckBox("Use HTTPS (needed for the phone camera and installing the app)")
        g = QGridLayout()
        g.addWidget(QLabel("Port"), 0, 0)
        self.port = QSpinBox(minimum=1024, maximum=65535)
        self.port.setValue(int(self.conf["port"]))
        self.port.setMinimumWidth(110)
        g.addWidget(self.port, 0, 1)
        g.setColumnStretch(2, 1)
        self.c_auto = QCheckBox("Start HaRM when I log in")
        self.c_tray = QCheckBox("Keep running in the tray when this window is closed")
        self.c_net.setChecked(self.conf["network"])
        self.c_https.setChecked(self.conf["https"])
        self.c_auto.setChecked(bool(self.conf.get("autostart")) if WINDOWS else AUTOSTART.exists())
        self.c_tray.setChecked(self.conf["close_to_tray"])
        for w in (self.c_net, self.c_https):
            lay.addWidget(w)
        lay.addLayout(g)
        lay.addWidget(self.c_auto)
        lay.addWidget(self.c_tray)
        self.apply_hint = QLabel("Restart the server to apply these changes.", objectName="warn")
        self.apply_hint.hide()
        lay.addWidget(self.apply_hint)
        self.c_net.toggled.connect(self.settings_changed)
        self.c_https.toggled.connect(self.settings_changed)
        self.port.valueChanged.connect(self.settings_changed)
        self.c_auto.toggled.connect(self.set_autostart)
        self.c_tray.toggled.connect(self.settings_changed)
        root.addWidget(c)

        # log
        self.b_log = QToolButton(objectName="small", text=" Server log", checkable=True, icon=lucide("chevron-right"),
                                 toolButtonStyle=Qt.ToolButtonTextBesideIcon)
        self.b_log.toggled.connect(self.toggle_log)
        root.addWidget(self.b_log, 0, Qt.AlignLeft)
        self.log = QPlainTextEdit(readOnly=True)
        self.log.setMaximumBlockCount(400)
        self.log.setMinimumHeight(170)
        self.log.hide()
        root.addWidget(self.log)
        root.addStretch(1)

    def build_tray(self):
        self.tray = None
        if not QSystemTrayIcon.isSystemTrayAvailable():
            return
        self.tray = QSystemTrayIcon(self.app.windowIcon(), self)
        m = QMenu()
        self.a_open = QAction("Open HaRM", m, triggered=lambda: self.open_harm())
        self.a_toggle = QAction("Start server", m, triggered=lambda: self.stop() if self.running() else self.start())
        m.addAction(self.a_open)
        m.addAction(QAction("Show control panel", m, triggered=self.show_panel))
        m.addSeparator()
        m.addAction(self.a_toggle)
        m.addSeparator()
        m.addAction(QAction("Quit", m, triggered=self.quit_app))
        self.tray.setContextMenu(m)
        self.tray.activated.connect(lambda r: self.show_panel() if r == QSystemTrayIcon.Trigger else None)
        self.tray.show()

    # ---------------- state
    def running(self) -> bool:
        return bool(harm_servers())

    def current(self) -> dict:
        s = harm_servers()
        if s:
            return s[0]
        https = self.conf["https"] and CERT.exists() and KEY.exists()
        return {"host": "0.0.0.0" if self.conf["network"] else "127.0.0.1", "port": int(self.conf["port"]), "https": https}

    def refresh(self):
        servers = harm_servers()
        cur = self.current()
        up = bool(servers) and port_open(cur["port"])
        if servers and up:
            state = "running"
        elif servers:
            state = "starting"
        elif port_open(int(self.conf["port"])):
            state = "busy"
        else:
            state = "stopped"
        label, color, sub = {
            "running": ("Running", COLORS["ok"], ""),
            "starting": ("Starting…", COLORS["warn"], "Getting ready…"),
            "stopped": ("Stopped", COLORS["muted"], "Press Start to run HaRM."),
            "busy": ("Port in use", COLORS["bad"], f"Another program is using port {self.conf['port']}. Pick another port below."),
        }[state]
        if state == "running":
            where = "shared on your network" if cur["host"] in ("0.0.0.0", "::") else "this computer only"
            self._started = servers[0]["started"]
            sub = f"Up {uptime(time.time() - self._started)} · {'HTTPS' if cur['https'] else 'HTTP'} · {where}"
            if len(servers) > 1:
                sub += f" · {len(servers)} copies running"
        self.dot.setStyleSheet(f"font-size: 20pt; background: transparent; color: {color};")
        self.status.setText(label)
        self.status_sub.setText(sub)
        self.b_start.setVisible(state in ("stopped", "busy"))
        self.b_start.setEnabled(state == "stopped")
        self.b_stop.setVisible(state in ("running", "starting"))
        self.b_restart.setEnabled(state == "running")
        self.b_open.setEnabled(state == "running")
        if self.tray:
            self.tray.setToolTip(f"Zom's HaRM: {label}")
            self.a_toggle.setText("Stop server" if servers else "Start server")
            self.a_open.setEnabled(state == "running")
        if state != self.state or not hasattr(self, 'addr_box'):
            self.draw_addresses(cur, state)
        # Addresses and phone setup only make sense once HaRM is running (and shared, for phones).
        self.addr_card.setVisible(state == "running")
        self.phone_row.setVisible(state == "running" and cur["host"] in ("0.0.0.0", "::"))
        if self.state == "stopped" or state == "stopped":
            self.adjustSize()
        self.update_bar.setVisible(code_changed())
        self.state = state
        if self.log.isVisible():
            self.read_log()

    def tick_uptime(self):
        """Keep the uptime counting every second without re-scanning processes."""
        if self.state != "running" or not self.isVisible() or not getattr(self, "_started", None):
            return
        self.status_sub.setText(re.sub(r"^Up [^·]+", f"Up {uptime(time.time() - self._started)} ", self.status_sub.text()))

    def draw_addresses(self, cur: dict, state: str):
        # Build the rows in a fresh widget and swap it in, so old rows never overlap new ones.
        box_widget = QWidget(objectName="clear")
        self.addr_box = QVBoxLayout(box_widget)
        self.addr_box.setContentsMargins(0, 0, 0, 0)
        self.addr_box.setSpacing(6)
        scheme = "https" if cur["https"] else "http"
        rows = [("This computer", f"{scheme}://localhost:{cur['port']}")]
        shared = cur["host"] in ("0.0.0.0", "::")
        if shared:
            rows += [(f"Phones ({ifname})", f"{scheme}://{ip}:{cur['port']}") for ip, ifname in lan_ips()]
        for label, url in rows:
            r = QHBoxLayout()
            lbl = QLabel(label, objectName="muted")
            lbl.setMinimumWidth(130)
            r.addWidget(lbl)
            r.addWidget(QLabel(url, objectName="addr", textInteractionFlags=Qt.TextSelectableByMouse), 1)
            cp = QToolButton(objectName="small", text="Copy")
            cp.clicked.connect(lambda _=False, u=url: (QGuiApplication.clipboard().setText(u), self.flash(cp)))
            r.addWidget(cp)
            self.addr_box.addLayout(r)
        if not shared:
            self.addr_box.addWidget(QLabel("Only this computer can connect. Tick “share on my network” for phones.", objectName="muted", wordWrap=True))
        old = self.addr_widget
        self.addr_lay.replaceWidget(old, box_widget)
        old.hide()
        old.deleteLater()
        self.addr_widget = box_widget
        # Certificate must name every address phones use, or they show a warning.
        missing = []
        if cur["https"] and shared:
            names = cert_names()
            missing = [ip for ip, _ in lan_ips() if ip not in names]
        self.missing_names = missing
        self.cert_warn.setText(f"The HTTPS certificate doesn’t cover {', '.join(missing)}, so phones will show a warning there." if missing else "")
        self.cert_warn.setVisible(bool(missing))
        self.cert_fix.setVisible(bool(missing))

    def flash(self, btn: QToolButton):
        btn.setText("Copied ✓")
        QTimer.singleShot(1200, lambda: btn.setText("Copy"))

    # ---------------- actions
    def settings_changed(self, *_):
        self.conf.update(network=self.c_net.isChecked(), https=self.c_https.isChecked(),
                         port=self.port.value(), close_to_tray=self.c_tray.isChecked())
        save_conf(self.conf)
        s = harm_servers()
        if s:
            want_host = "0.0.0.0" if self.conf["network"] else "127.0.0.1"
            want_https = self.conf["https"] and CERT.exists()
            self.apply_hint.setVisible((s[0]["host"], s[0]["port"], s[0]["https"]) != (want_host, self.conf["port"], want_https))
        self.state = None
        self.refresh()

    def ensure_ready(self) -> bool:
        if not VENV_PY.exists():
            QMessageBox.information(self, "First-time setup",
                                    "HaRM needs to install its parts first (about a minute). The log below shows progress; "
                                    "press Start again when it finishes.")
            self.b_log.setChecked(True)
            LOG.parent.mkdir(parents=True, exist_ok=True)
            def setup():
                with open(LOG, "a") as fh:
                    subprocess.run([sys.executable, "-m", "venv", ".venv"], cwd=ROOT, stdout=fh, stderr=subprocess.STDOUT, **_no_window())
                    subprocess.run([str(VENV_PY), "-m", "pip", "install", "-r", "requirements.txt"], cwd=ROOT, stdout=fh,
                                   stderr=subprocess.STDOUT, **_no_window())
                    fh.write("Setup finished. Press Start.\n")
            import threading
            threading.Thread(target=setup, daemon=True).start()
            return False
        if self.conf["https"] and not (CERT.exists() and KEY.exists()):
            r = QMessageBox.question(self, "HTTPS certificate",
                                     "HTTPS is on but there is no certificate yet. Create one now? "
                                     "(Choose No to start with plain HTTP.)")
            if r == QMessageBox.Yes:
                if not self.make_cert():
                    return False
            else:
                self.c_https.setChecked(False)
        return True

    def start(self):
        if harm_servers():
            return
        if not self.ensure_ready():
            return
        cur = self.current()
        args = [str(VENV_PY), "-m", "uvicorn", "harm.main:app", "--host", cur["host"], "--port", str(cur["port"]),
                "--proxy-headers", "--forwarded-allow-ips", os.environ.get("HARM_TRUSTED_PROXIES", "127.0.0.1"),
                "--no-server-header"]
        if cur["https"]:
            args += ["--ssl-certfile", str(CERT), "--ssl-keyfile", str(KEY)]
        LOG.parent.mkdir(parents=True, exist_ok=True)
        if LOG.exists() and LOG.stat().st_size > 2_000_000:
            LOG.replace(LOG.with_suffix(".log.1"))
        with open(LOG, "a") as fh:
            fh.write(f"\n=== Started {time.strftime('%Y-%m-%d %H:%M:%S')} ===\n")
            fh.flush()
            if WINDOWS:  # its own process group, no console window, keeps running if this app closes
                extra = {"creationflags": 0x00000200 | 0x08000000}
            else:
                extra = {"start_new_session": True, "preexec_fn": lambda: os.umask(0o077)}
            p = subprocess.Popen(args, cwd=ROOT, stdout=fh, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, **extra)
        self.proc_started_here = p.pid
        SERVER_INFO.write_text(json.dumps({"pid": p.pid, "host": cur["host"], "port": cur["port"],
                                           "https": cur["https"], "started": time.time()}))
        self.apply_hint.hide()
        QTimer.singleShot(400, self.refresh)
        QTimer.singleShot(5000, self.check_started)

    def check_started(self):
        if not harm_servers():
            self.b_log.setChecked(True)
            self.read_log()
            QMessageBox.warning(self, "HaRM didn't start", "The server stopped right away. The log shows why.")

    def stop(self, wait: bool = False):
        servers = harm_servers()
        for s in servers:
            try:
                os.kill(s["pid"], signal.SIGTERM)
            except (ProcessLookupError, OSError):
                pass
        deadline = time.time() + 6
        while wait and harm_servers() and time.time() < deadline:
            time.sleep(0.15)
        for s in harm_servers() if wait else []:
            try:
                os.kill(s["pid"], getattr(signal, "SIGKILL", signal.SIGTERM))
            except (ProcessLookupError, OSError):
                pass
        QTimer.singleShot(300, self.refresh)

    def restart(self):
        self.stop(wait=True)
        self.start()

    def open_harm(self, path: str = ""):
        cur = self.current()
        QDesktopServices.openUrl(QUrl(f"{'https' if cur['https'] else 'http'}://localhost:{cur['port']}/{path}"))

    def make_cert(self) -> bool:
        names = sorted(cert_names() - {"localhost", "127.0.0.1"})
        host = socket.gethostname()
        wanted = list(dict.fromkeys([host, *[ip for ip, _ in lan_ips()], *names]))
        p = subprocess.run([str(VENV_PY), "-m", "harm.certs", *wanted], cwd=ROOT,
                           capture_output=True, text=True, **_no_window())
        _CERT_CACHE.clear()
        if p.returncode != 0:
            QMessageBox.warning(self, "Certificate", f"Couldn't create the certificate:\n{p.stderr or p.stdout}")
            return False
        return True

    def fix_cert(self):
        r = QMessageBox.question(self, "Fix certificate",
                                 f"Re-issue HaRM's HTTPS certificate so it also covers {', '.join(self.missing_names)}?\n\n"
                                 "It's signed by the same HaRM authority, so phones that already trust HaRM keep trusting it. "
                                 "The server restarts to use it.")
        if r == QMessageBox.Yes and self.make_cert():
            if harm_servers():
                self.restart()
            self.state = None
            self.refresh()

    def set_autostart(self, on: bool):
        if WINDOWS:
            import winreg
            key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run", 0, winreg.KEY_SET_VALUE)
            if on:
                pyw = Path(sys.executable).with_name("pythonw.exe")
                winreg.SetValueEx(key, "Zoms HaRM", 0, winreg.REG_SZ, f'"{pyw if pyw.exists() else sys.executable}" "{Path(__file__).resolve()}" --background')
            else:
                try:
                    winreg.DeleteValue(key, "Zoms HaRM")
                except OSError:
                    pass
            winreg.CloseKey(key)
            self.conf["autostart"] = on
            save_conf(self.conf)
            return
        if on:
            AUTOSTART.parent.mkdir(parents=True, exist_ok=True)
            AUTOSTART.write_text(
                "[Desktop Entry]\nType=Application\nName=Zom's HaRM\nComment=Start the HaRM server in the tray\n"
                f'Exec={sys.executable} "{Path(__file__).resolve()}" --background\n'
                f"Icon={APP_ID}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n")
        elif AUTOSTART.exists():
            AUTOSTART.unlink()
        self.conf["autostart"] = on
        save_conf(self.conf)

    def toggle_log(self, on: bool):
        self.b_log.setIcon(lucide("chevron-down" if on else "chevron-right"))
        self.log.setVisible(on)
        if on:
            self.read_log()
        self.adjustSize()

    def read_log(self):
        try:
            with open(LOG, "rb") as fh:
                fh.seek(max(0, LOG.stat().st_size - 40_000))
                text = fh.read().decode(errors="replace")
        except OSError:
            text = "No log yet. (Servers started from a terminal log there instead.)"
        if text != self.log.toPlainText():
            self.log.setPlainText(text)
            self.log.verticalScrollBar().setValue(self.log.verticalScrollBar().maximum())

    def phone_setup(self):
        if getattr(self, "phone", None) is None or not self.phone.isVisible():
            self.phone = PhoneSetup(self)
        self.phone.show()
        self.phone.raise_()
        self.phone.activateWindow()

    def reload_self(self):
        """Restart the control panel itself on its new code. The server is a separate process and keeps running."""
        if self.tray:
            self.tray.hide()
        os.execv(sys.executable, [sys.executable, str(Path(__file__).resolve()), *([] if self.isVisible() else ["--background"])])

    def show_panel(self):
        self.show()
        self.raise_()
        self.activateWindow()

    # ---------------- closing
    def closeEvent(self, e):
        if self.quitting:
            return e.accept()
        if self.tray and self.conf["close_to_tray"]:
            e.ignore()
            self.hide()
            if not self.conf.get("tray_hint_shown"):
                self.tray.showMessage("Zom's HaRM", "Still running in the tray. Right-click the icon to open or quit.",
                                      self.app.windowIcon(), 5000)
                self.conf["tray_hint_shown"] = True
                save_conf(self.conf)
            return
        e.ignore()
        self.quit_app()

    def quit_app(self):
        if harm_servers():
            box = QMessageBox(self)
            box.setWindowTitle("Quit")
            box.setText("The HaRM server is still running.")
            box.setInformativeText("Stop it too? If you leave it running, phones can keep using HaRM, and you can "
                                   "reopen this panel any time to stop it.")
            stop = box.addButton("Stop server && quit", QMessageBox.DestructiveRole)
            leave = box.addButton("Leave it running", QMessageBox.AcceptRole)
            box.addButton(QMessageBox.Cancel)
            box.exec()
            if box.clickedButton() == stop:
                self.stop(wait=True)
            elif box.clickedButton() != leave:
                return
        self.quitting = True
        if self.tray:
            self.tray.hide()
        self.app.quit()


# ---------------------------------------------------------------- phone setup

def lan_nets() -> list[dict]:
    """This PC's LAN addresses with their subnets (for the firewall check)."""
    out = []
    if shutil.which("ip"):
        try:
            p = subprocess.run(["ip", "-j", "-4", "addr"], capture_output=True, text=True, timeout=3)
            for link in json.loads(p.stdout or "[]"):
                name = link.get("ifname", "")
                if name == "lo" or name.startswith(("docker", "br-", "veth", "virbr", "tailscale", "wg")):
                    continue
                for a in link.get("addr_info", []):
                    if a.get("local"):
                        net = ipaddress.ip_network(f"{a['local']}/{a['prefixlen']}", strict=False)
                        out.append({"ip": a["local"], "ifname": name, "net": str(net)})
        except (OSError, ValueError, KeyError, subprocess.TimeoutExpired):
            pass
    if not out:  # Windows / macOS: assume the usual home-network size
        for ip in _fallback_ips():
            out.append({"ip": ip, "ifname": "network", "net": str(ipaddress.ip_network(f"{ip}/24", strict=False))})
    return out


def qr_pixmap(text: str, size: int = 190):
    """A QR code as a pixmap: the segno library if installed, else the system's qrencode tool."""
    import io
    from PySide6.QtGui import QPixmap
    png = None
    try:
        import segno
        buf = io.BytesIO()
        segno.make(text, error="m").save(buf, kind="png", scale=8, border=3)
        png = buf.getvalue()
    except ImportError:
        if shutil.which("qrencode"):
            p = subprocess.run(["qrencode", "-t", "PNG", "-s", "8", "-m", "3", "-l", "M", "-o", "-", text],
                               capture_output=True, timeout=5)
            png = p.stdout if p.returncode == 0 else None
    pm = QPixmap()
    if not png or not pm.loadFromData(png, "PNG"):
        return None
    return pm.scaled(size, size, Qt.KeepAspectRatio, Qt.FastTransformation)


def firewall_status(port: int, nets: list[dict]) -> tuple[str, str]:
    """('ok'|'bad'|'unknown', explanation) for whether phones on the LAN can reach the port."""
    import ipaddress
    if WINDOWS:
        return "unknown", ("Windows asks the first time HaRM starts: tick “Private networks” and choose Allow. "
                           "Once your phone connects, this is confirmed by the steps below.")
    active = lambda unit: subprocess.run(["systemctl", "is-active", "--quiet", unit]).returncode == 0
    if shutil.which("systemctl") and active("ufw"):
        try:
            rules = Path("/etc/ufw/user.rules").read_text()
            default = Path("/etc/default/ufw").read_text()
        except OSError:
            return "unknown", "The firewall (ufw) is on, but its rules can't be read without your password."
        if re.search(r'DEFAULT_INPUT_POLICY="ACCEPT"', default):
            return "ok", "The firewall (ufw) lets everything in."
        phone_nets = [ipaddress.ip_network(n["net"]) for n in nets]
        for line in rules.splitlines():
            m = re.match(r"### tuple ### allow (\S+) (\S+) \S+ \S+ (\S+) in", line)
            if not m:
                continue
            proto, dports, src = m.groups()
            if proto not in ("tcp", "any"):
                continue
            hit = dports == "any"
            for part in dports.split(","):
                lo, _, hi = part.partition(":")
                if lo.isdigit() and int(lo) <= port <= int(hi or lo):
                    hit = True
            if not hit:
                continue
            try:
                srcnet = ipaddress.ip_network(src if src != "any" else "0.0.0.0/0", strict=False)
            except ValueError:
                continue
            if any(pn.subnet_of(srcnet) for pn in phone_nets if pn.version == srcnet.version):
                return "ok", f"The firewall (ufw) allows port {port} from {src}."
        return "bad", f"The firewall (ufw) is blocking port {port}. Phones can't connect until it's allowed."
    if shutil.which("systemctl") and active("firewalld"):
        p = subprocess.run(["firewall-cmd", "--list-ports"], capture_output=True, text=True)
        if p.returncode == 0:
            return ("ok", f"firewalld allows port {port}.") if f"{port}/tcp" in p.stdout.split() else \
                   ("bad", f"firewalld is blocking port {port}.")
        return "unknown", "firewalld is on; its rules can't be read without your password."
    return "ok", "No firewall is blocking connections."


ACCESS = re.compile(r'INFO:\s+([0-9a-fA-F.:]+):\d+ - "(\w+) (\S+) HTTP/[\d.]+" (\d{3})')


def phone_activity(own_ips: set[str]) -> dict:
    """What other devices have done, read from the server's access log."""
    seen = {}
    try:
        with open(LOG, "rb") as fh:
            fh.seek(max(0, LOG.stat().st_size - 1_500_000))
            text = fh.read().decode(errors="replace")
    except OSError:
        return {}
    for m in ACCESS.finditer(text):
        ip, method, path, code = m.group(1), m.group(2), m.group(3), int(m.group(4))
        if ip.startswith("127.") or ip in own_ips or ip == "::1":
            continue
        d = seen.setdefault(ip, set())
        d.add("reached")
        if path.startswith("/harm-ca.crt") and code == 200:
            d.add("cert")
        if path.startswith("/sw.js") and code == 200:
            d.add("trusted")
        if method == "POST" and path.startswith(("/api/auth/login", "/api/auth/setup", "/api/auth/recover")) and code == 200:
            d.add("signed_in")
        if path.startswith("/?app=1") or path.startswith("/?source=pwa"):
            d.add("installed")
    return seen


TROUBLE = {
    "android": [
        "Still a warning? The certificate isn't installed: redo step 2, then <b>close Chrome completely</b> (swipe it away) and reopen.",
        "Opens in Chrome but not from the home screen? Remove the home-screen icon and add it again from Chrome.",
    ],
    "samsung": [
        "Still a warning? The certificate isn't installed: redo step 2, then <b>close Chrome completely</b> (swipe it away) and reopen.",
        "Using Samsung Internet? Use Chrome for HaRM: it handles installed certificates and “Install app” best.",
    ],
    "iphone": [
        "<b>Clear old HaRM data first:</b> Settings > Apps > Safari > Advanced > Website Data, search <b>192.168</b>, swipe to delete. Remove the HaRM home-screen icon.",
        "Still a warning in Safari? <b>Settings > General > About > Certificate Trust Settings</b>: the switch for Zom's HaRM local CA must be on. Not listed there? The profile isn't installed yet (step 2).",
        "Works in Safari but not from the home screen? That means the trust switch is off. Turn it on, then delete and re-add the home-screen icon.",
        "Stopped working after an update or a new certificate? Press Restart above, close Safari completely, and open HaRM again.",
    ],
}
COMMON_TROUBLE = [
    "Same Wi-Fi as this PC? Guest Wi-Fi, mobile data and VPNs can't reach HaRM.",
    "Phone works but another device doesn't? The server is fine: fix that device.",
    "Nothing in the checklist ticks when you scan? Check the firewall line above, and that “Seen from” lists your device.",
]

GUIDES = {
    "android": ("Android", [
        "Open <b>Settings > Security &amp; privacy > More security &amp; privacy > Encryption &amp; credentials</b>.",
        "Tap <b>Install a certificate > CA certificate > Install anyway</b>.",
        "Pick <b>harm-ca.crt</b> from Downloads. Confirm with your PIN or fingerprint.",
    ]),
    "samsung": ("Samsung Galaxy", [
        "Open <b>Settings > Security and privacy > More security settings</b>.",
        "Tap <b>Install from device storage > CA certificate > Install anyway</b>.",
        "Pick <b>harm-ca.crt</b> from Downloads. Confirm with your PIN or fingerprint.",
    ]),
    "iphone": ("iPhone / iPad", [
        "Opened HaRM on this device before? First clear it: <b>Settings > Apps > Safari > Advanced > Website Data</b>, "
        "search <b>192.168</b> and delete it, and remove any HaRM icon from the home screen.",
        "Scan with the <b>Camera</b> app and open the link in <b>Safari</b>, then tap <b>Allow</b>.",
        "Open <b>Settings > General > VPN &amp; Device Management</b>, tap <b>Zom's HaRM local CA</b> > <b>Install</b>.",
        "Open <b>Settings > General > About > Certificate Trust Settings</b> and turn on <b>Zom's HaRM local CA</b>. "
        "<b>Don't skip this</b>: without it HaRM only works in Safari, never from the home screen.",
    ]),
}


class PhoneSetup(QWidget):
    """Step-by-step phone guide with QR codes and a checklist that checks itself."""

    def __init__(self, panel: "Panel"):
        super().__init__(None, Qt.Window)
        from PySide6.QtWidgets import QButtonGroup, QComboBox, QScrollArea
        self.panel = panel
        self.platform = panel.conf.get("phone_platform", "android")
        self.setWindowTitle("Phone setup · Zom's HaRM")
        self.setWindowIcon(panel.app.windowIcon())
        self.setStyleSheet(STYLE + f"""
            QLabel#qrcap {{ font-weight: 700; }}
            QLabel#qr {{ background: #ffffff; border-radius: 10px; padding: 8px; }}
            QLabel#step {{ color: {COLORS['orange']}; font-weight: 800; font-size: 8.5pt; letter-spacing: 1px; }}
            QPushButton#seg {{ padding: 5px 12px; }}
            QPushButton#seg:checked {{ background: {COLORS['blue']}; color: #06223a; border-color: {COLORS['blue']}; font-weight: 700; }}
            QComboBox {{ background: {COLORS['panel2']}; border: 1px solid {COLORS['line']}; border-radius: 6px; padding: 4px 8px; }}
            QScrollArea {{ border: none; }}""")
        self.resize(760, 860)
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        scroll = QScrollArea(widgetResizable=True)
        outer.addWidget(scroll)
        body = QWidget()
        scroll.setWidget(body)
        root = QVBoxLayout(body)
        root.setContentsMargins(20, 18, 20, 20)
        root.setSpacing(14)

        head = QLabel(f"<span style='font-size:17pt;font-weight:800'>Set up your phone</span><br>"
                      f"<span style='color:{COLORS['muted']}'>About 3 minutes, once per phone. The checklist ticks itself "
                      "off as your phone gets each step done.</span>", wordWrap=True)
        root.addWidget(head)

        # checklist
        c, lay = card("Checklist")
        self.rows = QVBoxLayout()
        self.rows.setSpacing(4)
        self.rows_widget = QWidget()
        self.rows_widget.setLayout(self.rows)
        lay.addWidget(self.rows_widget)
        self.seen_label = QLabel("", objectName="muted", wordWrap=True)
        lay.addWidget(self.seen_label)
        root.addWidget(c)

        # address picker (only shown when the PC has more than one network)
        self.addr = QComboBox()
        self.addr.currentIndexChanged.connect(self.draw_qr)
        self.addr_row = QHBoxLayout()
        self.addr_row.addWidget(QLabel("Your phone reaches this PC at", objectName="muted"))
        self.addr_row.addWidget(self.addr, 1)
        root.addLayout(self.addr_row)

        # step 1
        c, lay = card()
        lay.addWidget(QLabel("STEP 1", objectName="step"))
        lay.addWidget(QLabel("Connect your phone to the <b>same Wi-Fi</b> as this PC.", wordWrap=True))
        root.addWidget(c)

        # step 2: certificate
        c, lay = card()
        lay.addWidget(QLabel("STEP 2 · TRUST HaRM (ONCE)", objectName="step"))
        row = QHBoxLayout()
        row.setSpacing(16)
        qcol = QVBoxLayout()
        self.qr_cert = QLabel(objectName="qr", alignment=Qt.AlignCenter)
        qcol.addWidget(self.qr_cert)
        qcol.addWidget(QLabel("Scan to download the certificate", objectName="muted", alignment=Qt.AlignCenter))
        row.addLayout(qcol)
        steps = QVBoxLayout()
        seg = QHBoxLayout()
        self.seg_group = QButtonGroup(self)
        for key, (label, _) in GUIDES.items():
            b = QPushButton(label, objectName="seg", checkable=True)
            b.setChecked(key == self.platform)
            b.clicked.connect(lambda _=False, k=key: self.set_platform(k))
            self.seg_group.addButton(b)
            seg.addWidget(b)
        seg.addStretch(1)
        steps.addLayout(seg)
        self.guide = QLabel(wordWrap=True, textFormat=Qt.RichText)
        self.guide.setAlignment(Qt.AlignTop)
        steps.addWidget(self.guide, 1)
        row.addLayout(steps, 1)
        lay.addLayout(row)
        root.addWidget(c)

        # step 3: open HaRM
        c, lay = card()
        lay.addWidget(QLabel("STEP 3 · OPEN HaRM", objectName="step"))
        row = QHBoxLayout()
        row.setSpacing(16)
        qcol = QVBoxLayout()
        self.qr_app = QLabel(objectName="qr", alignment=Qt.AlignCenter)
        qcol.addWidget(self.qr_app)
        qcol.addWidget(QLabel("Scan to open HaRM", objectName="muted", alignment=Qt.AlignCenter))
        row.addLayout(qcol)
        row.addWidget(QLabel(
            "<ol style='margin-left:-20px'>"
            "<li>Fully close Chrome first (swipe it away in recent apps) so it notices the new certificate.</li>"
            "<li>Scan this code. HaRM should open with a <b>padlock</b> and <b>no warning</b>.</li>"
            "<li>Unlock with your master password.</li></ol>"
            f"<span style='color:{COLORS['muted']}'>Still see “Your connection is not private”? The certificate "
            "isn't installed yet. Go back to step 2.</span>", wordWrap=True, textFormat=Qt.RichText), 1)
        lay.addLayout(row)
        root.addWidget(c)

        # step 4: install
        c, lay = card()
        lay.addWidget(QLabel("STEP 4 · ADD IT AS AN APP", objectName="step"))
        lay.addWidget(QLabel(
            "<b>Android (Chrome):</b> tap <b>⋮ > Add to Home screen > Install</b>. HaRM gets its own icon and opens "
            "without the browser bars. Long-press the icon for Scan, Devices and Tasks shortcuts.<br><br>"
            "<b>iPhone (Safari):</b> tap <b>Share > Add to Home Screen</b>.", wordWrap=True, textFormat=Qt.RichText))
        root.addWidget(c)

        c, lay = card()
        lay.addWidget(QLabel("STILL NOT WORKING?", objectName="step"))
        self.trouble = QLabel(wordWrap=True, textFormat=Qt.RichText)
        lay.addWidget(self.trouble)
        root.addWidget(c)

        foot = QLabel(f"<span style='color:{COLORS['muted']}'>Only install HaRM's certificate on your own devices, "
                      "and keep <code>data/tls/harm-ca.key</code> private: anyone with that file could impersonate "
                      "websites to phones that trust it.</span>", wordWrap=True, textFormat=Qt.RichText)
        root.addWidget(foot)
        root.addStretch(1)

        self.set_platform(self.platform, save=False)
        self.fill_addresses()
        self.timer = QTimer(self, interval=2000, timeout=self.check)
        self.timer.start()
        self.check()

    # ---------------- content
    def set_platform(self, key: str, save: bool = True):
        self.platform = key
        label, steps = GUIDES[key]
        dl = "Scan the code with the Camera app." if key == "iphone" else (
            "Scan the code with the camera. Chrome shows <b>“Your connection is not private”</b> this one time: "
            "tap <b>Advanced > Proceed</b>, and <b>harm-ca.crt</b> downloads.")
        items = "".join(f"<li>{s}</li>" for s in steps)
        self.guide.setText(f"{dl}<ol style='margin-left:-20px'>{items}</ol>")
        tips = "".join(f"<li>{t}</li>" for t in TROUBLE.get(key, []) + COMMON_TROUBLE)
        self.trouble.setText(f"<ul style='margin-left:-20px'>{tips}</ul>")
        for b in self.seg_group.buttons():
            b.setChecked(b.text() == label)
        if save:
            self.panel.conf["phone_platform"] = key
            save_conf(self.panel.conf)

    def fill_addresses(self):
        self.addr.blockSignals(True)
        self.addr.clear()
        for n in lan_nets():
            self.addr.addItem(f"{n['ip']}  ({n['ifname']})", n["ip"])
        self.addr.blockSignals(False)
        many = self.addr.count() > 1
        for i in range(self.addr_row.count()):
            w = self.addr_row.itemAt(i).widget()
            if w:
                w.setVisible(many)
        self.draw_qr()

    def base_url(self) -> str | None:
        ip = self.addr.currentData()
        if not ip:
            return None
        cur = self.panel.current()
        return f"{'https' if cur['https'] else 'http'}://{ip}:{cur['port']}"

    def draw_qr(self, *_):
        base = self.base_url()
        for lbl, path in ((self.qr_cert, "/harm-ca.crt"), (self.qr_app, "/")):
            pm = qr_pixmap(base + path) if base else None
            if pm:
                lbl.setPixmap(pm)
                lbl.setToolTip(base + path)
            else:
                lbl.setText("No network address" if not base else "QR codes need the\n“segno” package")
                lbl.setStyleSheet("color: #14171f; padding: 30px;")

    # ---------------- checklist
    def check(self):
        cur = self.panel.current()
        servers = harm_servers()
        running = bool(servers) and port_open(cur["port"])
        shared = cur["host"] in ("0.0.0.0", "::")
        nets = lan_nets()
        names = cert_names()
        uncovered = [n["ip"] for n in nets if n["ip"] not in names]
        has_ca = (DATA / "tls" / "harm-ca.crt").exists()
        fw, fw_text = firewall_status(cur["port"], nets)
        acts = phone_activity({n["ip"] for n in nets})
        done = set().union(*acts.values()) if acts else set()
        logged_here = running and LOG.exists() and LOG.stat().st_mtime >= servers[0]["started"] - 5 if servers else False
        rows = []

        def add(state, text, fix=None):
            rows.append((state, text, fix))

        add("ok" if running else "bad", "HaRM is running" if running else "HaRM isn't running",
            None if running else ("Start", self.panel.start))
        add("ok" if shared else "bad", "Shared on your network" if shared else "Only this PC can connect",
            None if shared else ("Share it", self.share))
        add("ok" if cur["https"] else "bad", "Using HTTPS" if cur["https"] else "HTTPS is off (phones need it for the camera and the app)",
            None if cur["https"] else ("Turn on", self.https_on))
        if cur["https"]:
            if not has_ca:
                add("bad", "No HaRM certificate yet", ("Create", self.panel.fix_cert))
            elif uncovered:
                add("bad", f"The certificate doesn't cover {', '.join(uncovered)}", ("Fix certificate", self.panel.fix_cert))
            else:
                add("ok", "The certificate covers this PC's address")
        add(fw, fw_text, ("Allow it", self.allow_firewall) if fw == "bad" and shutil.which("pkexec") else None)
        if running and not logged_here:
            add("unknown", "Phone progress can't be seen: HaRM was started outside this app",
                ("Restart here", self.panel.restart))
        else:
            add("ok" if "reached" in done else "wait", "Phone reached HaRM" if "reached" in done else "Waiting for your phone to connect (step 2 or 3)")
            add("ok" if "cert" in done else "wait", "Phone downloaded the certificate" if "cert" in done else "Waiting for the certificate download (step 2)")
            if "trusted" in done:
                add("ok", "Phone trusts HaRM's certificate")
            elif "reached" in done:
                add("warn", "Phone doesn't trust the certificate yet: install it (step 2), then fully close Chrome and reopen")
            else:
                add("wait", "Waiting for the phone to trust HaRM (steps 2 and 3)")
            add("ok" if "signed_in" in done else "wait", "Signed in on the phone" if "signed_in" in done else "Waiting for you to unlock HaRM on the phone (step 3)")
            add("ok" if "installed" in done else "wait", "Opened as an installed app" if "installed" in done else "Waiting for “Add to Home screen” (step 4)")
        self.draw_rows(rows)
        if acts:
            self.seen_label.setText("Seen from: " + ", ".join(sorted(acts)))
        else:
            self.seen_label.setText("")

    def draw_rows(self, rows):
        sig = repr([(s, t) for s, t, _ in rows])
        if getattr(self, "_sig", None) == sig:
            return
        self._sig = sig
        new = QWidget(objectName="clear")
        lay = QVBoxLayout(new)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(4)
        icons = {"ok": ("✓", COLORS["ok"]), "bad": ("✕", COLORS["bad"]), "warn": ("!", COLORS["warn"]),
                 "wait": ("○", COLORS["muted"]), "unknown": ("?", COLORS["warn"])}
        for state, text, fix in rows:
            r = QHBoxLayout()
            ico, color = icons[state]
            i = QLabel(ico)
            i.setFixedWidth(22)
            i.setStyleSheet(f"color: {color}; font-weight: 800; font-size: 12pt; background: transparent;")
            r.addWidget(i)
            t = QLabel(text, wordWrap=True)
            t.setStyleSheet(f"background: transparent; color: {COLORS['muted'] if state == 'wait' else COLORS['text']};")
            r.addWidget(t, 1)
            if fix:
                b = QToolButton(objectName="small", text=fix[0])
                b.clicked.connect(lambda _=False, f=fix[1]: (f(), QTimer.singleShot(800, self.refresh_all)))
                r.addWidget(b)
            lay.addLayout(r)
        old = self.rows_widget
        parent_lay = old.parentWidget().layout()
        parent_lay.replaceWidget(old, new)
        old.hide()
        old.deleteLater()
        self.rows_widget = new

    def refresh_all(self):
        self._sig = None
        self.fill_addresses()
        self.check()

    # ---------------- fixes
    def share(self):
        self.panel.c_net.setChecked(True)
        if harm_servers():
            self.panel.restart()
        self.fill_addresses()

    def https_on(self):
        self.panel.c_https.setChecked(True)
        if not (CERT.exists() and KEY.exists()) and not self.panel.make_cert():
            return
        if harm_servers():
            self.panel.restart()
        self.fill_addresses()

    def allow_firewall(self):
        port = self.panel.current()["port"]
        nets = lan_nets()
        if not nets:
            return
        net = nets[0]["net"]
        r = QMessageBox.question(self, "Allow HaRM through the firewall",
                                 f"Allow port {port} from your home network ({net})?\n\n"
                                 "Your system will ask for your password.")
        if r != QMessageBox.Yes:
            return
        p = subprocess.run(["pkexec", "ufw", "allow", "from", net, "to", "any", "port", str(port), "proto", "tcp",
                            "comment", "Zom's HaRM"], capture_output=True, text=True)
        if p.returncode != 0:
            QMessageBox.warning(self, "Firewall", f"That didn't work:\n{(p.stderr or p.stdout).strip() or 'cancelled'}")



def main():
    background = "--background" in sys.argv
    want_open = "--open" in sys.argv
    QGuiApplication.setDesktopFileName(APP_ID)  # lets KDE/GNOME match the window to its icon
    app = QApplication(sys.argv)
    app.setApplicationName("Zom's HaRM")
    app.setWindowIcon(QIcon.fromTheme(APP_ID, QIcon(str(ICON))))
    app.setQuitOnLastWindowClosed(False)

    # Only one control panel: a second launch just brings the first one forward.
    probe = QLocalSocket()
    probe.connectToServer(APP_ID)
    if probe.waitForConnected(300):
        probe.write(b"open" if want_open else (b"bg" if background else b"show"))
        probe.waitForBytesWritten(300)
        return 0
    QLocalServer.removeServer(APP_ID)
    server = QLocalServer()
    server.listen(APP_ID)

    panel = Panel(app, background or want_open)

    def on_message():
        sock = server.nextPendingConnection()
        if not sock:
            return
        sock.waitForReadyRead(300)
        msg = bytes(sock.readAll()).decode()
        if msg == "open":
            open_when_ready()
        elif msg == "show":
            if code_changed():
                panel.show()
                panel.reload_self()
            panel.show_panel()

    def open_when_ready(tries: int = 40):
        if not harm_servers():
            panel.start()
        if harm_servers() and port_open(panel.current()["port"]):
            panel.open_harm()
        elif tries:
            QTimer.singleShot(250, lambda: open_when_ready(tries - 1))

    server.newConnection.connect(on_message)
    if want_open:
        open_when_ready()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
