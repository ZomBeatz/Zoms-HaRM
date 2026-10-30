"""Pictures of the desktop app for the guide, rendered off-screen with made-up addresses.

    python3 scripts/launcher-screenshots.py ../zombeatz-docs/site/public/img/harm

Needs PySide6. Writes desktop-app.png, desktop-app-stopped.png and phone-setup.png.
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "launcher"))
import os
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import harm_launcher as L  # noqa: E402
from PySide6.QtGui import QIcon  # noqa: E402
from PySide6.QtWidgets import QApplication  # noqa: E402

out = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
out.mkdir(parents=True, exist_ok=True)
tmp = Path(os.environ.get("TMPDIR", "/tmp")) / "harm-launcher-shots.log"
tmp.write_text("=== Started ===\nINFO:     192.168.10.121:50122 - \"GET /harm-ca.crt HTTP/1.1\" 200 OK\n"
               "INFO:     192.168.10.121:50130 - \"GET / HTTP/1.1\" 200 OK\n")

# Demo values only: nothing from this computer appears in the pictures.
L.save_conf = lambda c: None
L.LOG = tmp
L.lan_ips = lambda: [("192.168.10.5", "eth0")]
L.lan_nets = lambda: [{"ip": "192.168.10.5", "ifname": "eth0", "net": "192.168.10.0/24"}]
L.cert_names = lambda: {"localhost", "127.0.0.1", "192.168.10.5", "harm-server"}
L.firewall_status = lambda port, nets: ("ok", f"The firewall allows port {port} from 192.168.10.0/24.")
L.AUTOSTART = Path("/nonexistent/zoms-harm.desktop")

app = QApplication([])
app.setWindowIcon(QIcon(str(L.ICON)))
servers = []
L.harm_servers = lambda: servers
L.port_open = lambda p: bool(servers)

panel = L.Panel(app, background=False)
panel.conf.update(network=True, https=True, port=8077, close_to_tray=True)
panel.c_auto.setChecked(False)
panel.state = None
panel.refresh()
panel.adjustSize()
app.processEvents()
panel.grab().save(str(out / "desktop-app-stopped.png"))

servers.append({"pid": 1, "host": "0.0.0.0", "port": 8077, "https": True, "started": time.time() - (3 * 86400 + 4 * 3600 + 17 * 60 + 9)})
panel.state = None
panel.refresh()
panel.adjustSize()
app.processEvents()
panel.grab().save(str(out / "desktop-app.png"))

panel.conf["phone_platform"] = "iphone"
ps = L.PhoneSetup(panel)
ps.resize(760, 2350)
ps.show()
app.processEvents()
ps.check()
app.processEvents()
ps.grab().save(str(out / "phone-setup.png"))
tmp.unlink(missing_ok=True)
print("saved desktop-app.png, desktop-app-stopped.png, phone-setup.png in", out)
