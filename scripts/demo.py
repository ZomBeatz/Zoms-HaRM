"""Try Zom's HaRM with made-up demo data (a small home lab), without touching your own data.

    python3 scripts/demo.py               # starts a demo on http://127.0.0.1:8099 (password: demo-password)
    python3 scripts/demo.py --port 8100
    python3 scripts/demo.py --keep        # keep the demo's data folder afterwards (it's printed)
    python3 scripts/demo.py --save demo.db  # just write the filled-in demo database and stop (the online demo uses it)

The demo is also what the guide's screenshots are taken from. Everything in it is fictional.
"""

import argparse
import http.cookiejar
import json
import os
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PASSWORD = "demo-password"


class Api:
    def __init__(self, base):
        self.base = base
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def __call__(self, method, path, body=None):
        req = urllib.request.Request(self.base + "/api" + path, method=method,
                                     data=json.dumps(body).encode() if body is not None else None,
                                     headers={"X-HaRM": "1", "Content-Type": "application/json", "Origin": self.base})
        try:
            return json.loads(self.op.open(req, timeout=30).read() or b"null")
        except urllib.error.HTTPError as e:
            raise SystemExit(f"{method} {path}: {e.code} {e.read()[:300]}")


def seed(api: Api) -> None:
    api("POST", "/auth/setup", {"password": PASSWORD})
    P = lambda path, body: api("POST", path, body)

    # Places
    home = P("/locations", {"name": "Home", "kind": "Building"})
    base = P("/locations", {"name": "Basement", "kind": "Room", "parent_id": home["id"]})
    closet = P("/locations", {"name": "Server closet", "kind": "Closet", "parent_id": base["id"]})
    garage = P("/locations", {"name": "Garage", "kind": "Garage", "parent_id": home["id"]})
    office = P("/locations", {"name": "Office", "kind": "Office", "parent_id": home["id"]})
    rack = P("/racks", {"name": "Main rack", "kind": "Rack", "height_u": 24, "location_id": closet["id"],
                        "manufacturer": "StarTech", "model": "4POSTRACK25U", "depth_mm": 1000})
    shelf = P("/racks", {"name": "Wire shelf", "kind": "Wire Shelving", "location_id": garage["id"]})
    bin_ = P("/racks", {"name": "Drive bin", "kind": "Bin", "location_id": garage["id"]})
    desk = P("/racks", {"name": "Desk", "kind": "Desk", "location_id": office["id"]})

    # Networks
    lan = P("/networks", {"name": "Home LAN", "kind": "LAN", "vlan_id": 1, "cidr": "192.168.10.0/24", "gateway": "192.168.10.1",
                          "dhcp_start": "192.168.10.100", "dhcp_end": "192.168.10.199", "dns_servers": "192.168.10.53", "domain": "home.lan"})
    P("/networks", {"name": "Servers", "kind": "Servers", "vlan_id": 20, "cidr": "10.20.0.0/24", "gateway": "10.20.0.1"})
    P("/networks", {"name": "Management", "kind": "Management", "vlan_id": 30, "cidr": "10.30.0.0/24", "gateway": "10.30.0.1"})
    P("/networks", {"name": "IoT", "kind": "IoT", "vlan_id": 40, "cidr": "10.40.0.0/24", "gateway": "10.40.0.1"})
    _ = lan

    cluster = P("/clusters", {"name": "homelab", "kind": "Proxmox VE", "location_id": closet["id"],
                              "notes": "Two nodes plus a QDevice on the Pi for quorum."})

    def dev(name, **kw):
        return P("/devices", {"name": name, "status": "Active", "connected": True, **kw})

    def iface(d, name, ip, mac, **kw):
        return P("/interfaces", {"device_id": d["id"], "name": name, "ip": ip, "mac": mac, **kw})

    # The rack, top to bottom
    gw = dev("UniFi Dream Machine Pro", device_type="Router", manufacturer="Ubiquiti", model="UDM-Pro", rack_id=rack["id"], rack_u=24,
             serial="F4E2C6A1B2C3", mgmt_url="https://192.168.10.1", purchase_date="2023-03-14", purchase_price=379, warranty_until="2025-03-14")
    sw = dev("USW Pro 24 PoE", device_type="Switch", manufacturer="Ubiquiti", model="USW-Pro-24-PoE", rack_id=rack["id"], rack_u=23,
             serial="F4E2C6A9D8E7", purchase_price=699)
    dev("Patch panel", device_type="Patch Panel", manufacturer="Monoprice", model="24-port Cat6", rack_id=rack["id"], rack_u=22, connected=False)
    r730 = dev("pve1", device_type="Hypervisor Host", manufacturer="Dell", model="PowerEdge R730", rack_id=rack["id"], rack_u=10, u_height=2,
               serial="7XK9P2J", hostname="pve1.home.lan", os="Proxmox VE 9.0", psu="2× 750 W redundant", power_draw_w=180,
               mgmt_url="https://10.30.0.10", cluster_id=cluster["id"], purchase_date="2024-06-02", purchase_price=420, vendor="eBay",
               msrp=8900, market_value=380, value_checked="2026-10-01", tags="prod, proxmox")
    dl380 = dev("pve2", device_type="Hypervisor Host", manufacturer="HPE", model="ProLiant DL380 Gen9", rack_id=rack["id"], rack_u=7, u_height=2,
                serial="CZJ7310ABC", hostname="pve2.home.lan", os="Proxmox VE 9.0", psu="2× 500 W", power_draw_w=150,
                mgmt_url="https://10.30.0.11", cluster_id=cluster["id"], purchase_price=350, tags="prod, proxmox")
    nas = dev("vault", device_type="NAS", manufacturer="Synology", model="RS1221+", rack_id=rack["id"], rack_u=4, u_height=2,
              serial="2190QWR123456", hostname="vault.home.lan", os="DSM 7.2", purchase_date="2023-11-20", purchase_price=1050,
              warranty_until="2026-11-20", tags="storage")
    ups = dev("APC Smart-UPS 1500", device_type="UPS", manufacturer="APC", model="SMT1500RM2U", rack_id=rack["id"], rack_u=1, u_height=2,
              serial="AS2145123456", power_draw_w=0, purchase_price=480)

    # Elsewhere in the house
    ws = dev("Alex's desktop", device_type="Workstation", manufacturer="Custom", model="Ryzen 9 build", rack_id=desk["id"],
             position="Under the desk", os="Windows 11", hostname="alex-pc")
    pi = dev("pi-dns", device_type="SBC (Raspberry Pi etc.)", manufacturer="Raspberry Pi", model="Pi 4 Model B 8GB", rack_id=desk["id"],
             position="Behind the monitor", os="Raspberry Pi OS", hostname="pi-dns.home.lan")
    old = dev("Old R610", device_type="Server", manufacturer="Dell", model="PowerEdge R610", status="Spare", connected=False,
              location_id=garage["id"], position="Pile by the door", serial="4HQ2V1K")
    broken = dev("Netgear GS108", device_type="Switch", manufacturer="Netgear", model="GS108", status="Broken", connected=False,
                 rack_id=shelf["id"], position="Top shelf")
    dev("Maya's iPad", device_type="Tablet", manufacturer="Apple", model="iPad Air", location_id=home["id"])
    dev("Living room TV", device_type="TV / Streaming", manufacturer="LG", model="OLED C3", location_id=home["id"])

    # Addresses (management ports on their own VLAN)
    iface(gw, "LAN", "192.168.10.1", "F4:E2:C6:A1:B2:C3", is_primary=True)
    iface(sw, "mgmt", "192.168.10.2", "F4:E2:C6:A9:D8:E7", is_primary=True, poe="None")
    iface(r730, "vmbr0", "10.20.0.10", "B0:83:FE:12:34:56", speed="10G", is_primary=True)
    iface(r730, "iDRAC", "10.30.0.10", "B0:83:FE:12:34:5A", kind="IPMI / BMC")
    iface(dl380, "vmbr0", "10.20.0.11", "9C:B6:54:AB:CD:01", speed="10G", is_primary=True)
    iface(dl380, "iLO", "10.30.0.11", "9C:B6:54:AB:CD:05", kind="IPMI / BMC")
    iface(nas, "bond0", "10.20.0.20", "00:11:32:AA:BB:CC", speed="10G", is_primary=True)
    iface(ws, "Ethernet", "192.168.10.50", "A8:A1:59:11:22:33", speed="2.5G", is_primary=True)
    iface(pi, "eth0", "192.168.10.53", "DC:A6:32:44:55:66", is_primary=True)
    iface(ups, "NMC", "10.30.0.5", "00:C0:B7:12:34:56", kind="IPMI / BMC")

    P("/services", {"device_id": r730["id"], "name": "Proxmox VE", "protocol": "HTTPS", "port": 8006, "url": "https://10.20.0.10:8006", "status": "Running"})
    P("/services", {"device_id": dl380["id"], "name": "Proxmox VE", "protocol": "HTTPS", "port": 8006, "url": "https://10.20.0.11:8006", "status": "Running"})
    P("/services", {"device_id": nas["id"], "name": "DSM", "protocol": "HTTPS", "port": 5001, "url": "https://10.20.0.20:5001", "status": "Running"})
    P("/services", {"device_id": pi["id"], "name": "Pi-hole", "protocol": "HTTP", "port": 80, "url": "http://192.168.10.53/admin", "status": "Running"})

    # Logins (demo passwords)
    idrac = P("/credentials", {"label": "iDRAC", "kind": "Web UI", "username": "root", "password": "demo-idrac-pass", "device_id": r730["id"], "last_rotated": "2026-02-10"})
    pve_root = P("/credentials", {"label": "Proxmox root", "kind": "SSH", "username": "root", "password": "demo-pve-pass", "device_id": r730["id"]})
    ilo = P("/credentials", {"label": "iLO", "kind": "Web UI", "username": "Administrator", "password": "demo-ilo-pass", "device_id": dl380["id"], "last_rotated": "2024-01-05"})
    dsm = P("/credentials", {"label": "DSM admin", "kind": "Web UI", "username": "alex", "password": "demo-dsm-pass", "device_id": nas["id"],
                             "totp_secret": "JBSWY3DPEHPK3PXP"})

    # One-click actions
    P("/actions", {"name": "Quiet the fans", "device_id": dl380["id"], "hosts": "10.30.0.11", "credential_id": ilo["id"], "mode": "lines",
                   "legacy_ssh": True, "pinned": True,
                   "command": "# iLO 4 with the fan-control firmware. fan p <fan> max <speed, 0 to 255>.\n"
                              + "\n".join(f"fan p {n} max 60" for n in range(6)),
                   "notes": "Run after a reboot: the fans start at full speed."})
    P("/actions", {"name": "Power on", "device_id": r730["id"], "hosts": "10.30.0.10", "credential_id": idrac["id"], "mode": "lines",
                   "legacy_ssh": True, "pinned": True, "command": "racadm serveraction powerup"})
    P("/actions", {"name": "Update packages", "device_id": r730["id"], "credential_id": pve_root["id"], "mode": "script", "confirm": True,
                   "pinned": False, "command": "export DEBIAN_FRONTEND=noninteractive\napt-get update\napt-get -y dist-upgrade"})
    P("/actions", {"name": "Uptime and disk space", "device_id": nas["id"], "credential_id": dsm["id"], "mode": "script", "sudo": False,
                   "pinned": True, "command": "uptime\ndf -h /volume1"})
    P("/credentials", {"label": "Home Wi-Fi", "kind": "Wi-Fi PSK", "password": "demo-wifi-pass"})

    # Hardware inside pve1: CPUs from the library, memory, a drive bay group
    cpus = api("GET", "/catalog/search?category=cpu&q=E5-2680")["results"]
    if cpus:
        f = api("GET", f"/catalog/{cpus[0]['id']}/component-fields")
        P("/components", {k: f[k] for k in ("category", "manufacturer", "model", "interface", "capacity", "catalog_id") if f.get(k)} |
          {"device_id": r730["id"], "quantity": 2})
    P("/components", {"category": "RAM", "manufacturer": "Samsung", "model": "M393A2K40BB1", "capacity": "16 GB", "interface": "DDR4 RDIMM",
                      "speed": "2400 MT/s", "quantity": 8, "device_id": r730["id"]})
    bays = P("/device_slots", {"device_id": r730["id"], "interface": "SAS/SATA", "form_factor": '2.5"', "total": 8, "label": "Front",
                               "array_name": "RAID 6 (PERC H730)", "first_index": 0})
    drives = P("/components", {"category": "HDD", "manufacturer": "Seagate", "model": "ST1200MM0088", "capacity": "1.2 TB", "interface": "SAS",
                               "form_factor": '2.5"', "speed": "10K RPM", "quantity": 6, "device_id": r730["id"], "slot_id": bays["id"]})
    failed = api("POST", f"/components/{drives['id']}/split", {"slot_id": bays["id"], "bay": 3})
    api("PUT", f"/components/{failed['id']}", {"health": "Failed: predictive failure"})
    P("/device_slots", {"device_id": r730["id"], "interface": "PCIe x8", "total": 3, "notes": "Riser 1"})
    P("/components", {"category": "NIC", "manufacturer": "Intel", "model": "X710-DA2", "interface": "PCIe x8", "speed": "10GbE", "quantity": 1,
                      "device_id": r730["id"]})
    P("/components", {"category": "RAM", "manufacturer": "SK hynix", "capacity": "32 GB", "interface": "DDR4 RDIMM", "quantity": 6, "device_id": dl380["id"]})
    nas_bays = P("/device_slots", {"device_id": nas["id"], "interface": "SATA", "form_factor": '3.5"', "total": 8, "label": "Front", "array_name": "SHR-2"})
    P("/components", {"category": "HDD", "manufacturer": "WD", "model": "WD120EFBX", "capacity": "12 TB", "interface": "SATA", "form_factor": '3.5"',
                      "quantity": 6, "device_id": nas["id"], "slot_id": nas_bays["id"]})

    # Spares on the shelf and in the bin
    P("/components", {"category": "HDD", "manufacturer": "Seagate", "model": "ST1200MM0088", "capacity": "1.2 TB", "interface": "SAS", "form_factor": '2.5"',
                      "quantity": 2, "status": "In Stock", "condition": "Used - Good", "rack_id": bin_["id"], "market_value": 25})
    P("/components", {"category": "HDD", "manufacturer": "WD", "model": "WD40EFRX", "capacity": "4 TB", "interface": "SATA", "form_factor": '3.5"',
                      "quantity": 3, "status": "In Stock", "condition": "Used - Good", "rack_id": bin_["id"]})
    P("/components", {"category": "RAM", "capacity": "16 GB", "interface": "DDR4 RDIMM", "quantity": 4, "status": "In Stock", "rack_id": shelf["id"],
                      "position": "Anti-static bag, blue"})
    P("/components", {"category": "Transceiver (SFP)", "manufacturer": "Ubiquiti", "model": "UACC-DAC-SFP10-1M", "quantity": 4, "status": "In Stock",
                      "rack_id": shelf["id"]})
    P("/components", {"category": "Caddy / Tray", "manufacturer": "Dell", "model": "2.5\" caddy for R730", "quantity": 5, "status": "In Stock",
                      "rack_id": bin_["id"]})

    # VMs and containers
    def vm(name, host, vmid, cpu, ram, disk, ip, kind="Virtual Machine", status="Active", os=None):
        g = dev(name, device_type=kind, host_id=host["id"], vm_id=str(vmid), vcpus=cpu, vm_ram_gb=ram, vm_disk_gb=disk, status=status,
                connected=status == "Active", cluster_id=cluster["id"], os=os)
        iface(g, "net0", ip, None, is_primary=True)
        return g
    plex = vm("plex", r730, 100, 4, 8, 64, "10.20.0.100", os="Ubuntu 24.04")
    vm("home-assistant", r730, 101, 2, 4, 32, "10.20.0.101", os="Home Assistant OS")
    vm("docker", dl380, 110, 6, 16, 128, "10.20.0.110", os="Debian 13")
    vm("unifi-controller", dl380, 120, 1, 2, 16, "10.20.0.120", kind="Container", os="Debian 13")
    vm("windows-test", dl380, 130, 4, 8, 80, "10.20.0.130", status="Standby", os="Windows 11")
    P("/services", {"device_id": plex["id"], "name": "Plex", "protocol": "HTTP", "port": 32400, "url": "http://10.20.0.100:32400/web", "status": "Running"})

    # Cables
    P("/connections", {"a_device_id": r730["id"], "a_port": "SFP+ 1", "b_device_id": sw["id"], "b_port": "SFP+ 25", "medium": "DAC (SFP+)", "length": "1 m"})
    P("/connections", {"a_device_id": dl380["id"], "a_port": "SFP+ 1", "b_device_id": sw["id"], "b_port": "SFP+ 26", "medium": "DAC (SFP+)", "length": "1 m"})
    P("/connections", {"a_device_id": nas["id"], "a_port": "LAN 1", "b_device_id": sw["id"], "b_port": "1", "medium": "Cat6", "color": "Blue", "cable_label": "A01"})
    P("/connections", {"a_device_id": sw["id"], "a_port": "Uplink", "b_device_id": gw["id"], "b_port": "LAN 8", "medium": "Cat6", "color": "Yellow"})
    P("/connections", {"a_device_id": ups["id"], "a_port": "USB", "b_device_id": nas["id"], "b_port": "USB 1", "medium": "USB"})

    # Notes, tasks and issues
    note = lambda entity, eid, kind, body: P("/notes", {"entity": entity, "entity_id": eid, "kind": kind, "body": body})
    note("devices", r730["id"], "issue", "Bay 3 drive reports predictive failure. Spare is in the drive bin.")
    note("devices", r730["id"], "task", "Update iDRAC firmware to 2.86")
    note("devices", r730["id"], "action", "Moved Plex to its own VM and gave it 8 GB")
    note("devices", dl380["id"], "issue", "PSU 2 fan is noisy")
    note("devices", nas["id"], "task", "Run a data scrub before the warranty ends")
    note("devices", old["id"], "note", "Maya might want this for her lab. Ask before selling.")
    note("racks", rack["id"], "note", "Rear door sticks; lift it slightly to close.")
    note("locations", garage["id"], "task", "Label the drive bin")
    note("clusters", cluster["id"], "note", "Upgrade both nodes together. Migrate VMs first.")
    _ = broken

    # A PC build in progress
    b = P("/builds", {"name": "Alex's gaming upgrade", "purpose": "Gaming PC", "budget": 1500})
    for cat, name, price, acquire in (("cpu", "AMD Ryzen 7 9800X3D", 479, "Ordered"), ("motherboard", "ASUS TUF B650-PLUS WIFI", 199, "Need"),
                                      ("memory", "32 GB DDR5-6000 kit", 109, "Need"), ("gpu", "Radeon RX 9070 XT", 599, "Need"),
                                      ("storage", "2 TB NVMe SSD", 129, "Have")):
        P("/build_items", {"build_id": b["id"], "category": cat, "name": name, "price": price, "acquire": acquire})


def seed_status(db_path: Path) -> None:
    """A believable last day for the Status page: pve2 dropped off for a while overnight, and
    Alex's desktop is asleep. Written straight into the database, since the demo never checks
    for real (its made-up addresses could belong to real devices on your network)."""
    os.environ["HARM_DB"] = str(db_path)
    sys.path.insert(0, str(ROOT))
    from datetime import datetime, timedelta, timezone
    from harm import monitor
    now = datetime.now(timezone.utc).replace(microsecond=0)
    ts = lambda **kw: (now - timedelta(**kw)).strftime("%Y-%m-%d %H:%M:%S")
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    latency = {"192.168.10.1": 0.4, "192.168.10.2": 0.7, "10.20.0.10": 0.3, "10.30.0.10": 1.2, "10.20.0.11": 0.4,
               "10.30.0.11": 2.1, "10.20.0.20": 0.5, "192.168.10.53": 1.8, "10.30.0.5": 3.4}
    history = {  # address: [(state, how long ago)], oldest first
        "10.20.0.11": [("up", {"days": 3}), ("down", {"hours": 21, "minutes": 10}), ("up", {"hours": 20, "minutes": 25})],
        "192.168.10.50": [("down", {"days": 1, "hours": 6}), ("up", {"hours": 11}), ("down", {"hours": 1, "minutes": 45})],
    }
    for did, t in monitor.targets(conn).items():
        for addr in t["addresses"]:
            events = history.get(addr, [("up", {"days": 3})])
            for state, ago in events:
                conn.execute("INSERT INTO status_events (device_id, address, state, at) VALUES (?,?,?,?)", (did, addr, state, ts(**ago)))
            state, ago = events[-1]
            conn.execute("INSERT OR REPLACE INTO device_status (device_id, address, state, latency_ms, method, checked_at, changed_at) "
                         "VALUES (?,?,?,?,?,?,?)", (did, addr, state, latency.get(addr, 0.9) if state == "up" else None,
                                                    ("port 8006" if addr.startswith("10.20.0.1") else "port 443") if state == "up" else None,
                                                    ts(minutes=1), ts(**ago)))
    # Services: all answering, except Pi-hole, which stopped 20 minutes ago.
    for r in conn.execute("SELECT id, device_id, name FROM services").fetchall():
        bad = r["name"] == "Pi-hole"
        conn.execute("INSERT OR REPLACE INTO service_status (service_id, device_id, state, code, latency_ms, detail, checked_at, changed_at) "
                     "VALUES (?,?,?,?,?,?,?,?)", (r["id"], r["device_id"], "down" if bad else "up", None if bad else 200,
                                                  None if bad else 12.0, "connection refused" if bad else "HTTP 200",
                                                  ts(minutes=1), ts(minutes=20) if bad else ts(days=3)))
    conn.commit()
    conn.close()


def main():
    ap = argparse.ArgumentParser(description="Start Zom's HaRM with made-up demo data.")
    ap.add_argument("--port", type=int, default=8099)
    ap.add_argument("--keep", action="store_true", help="keep the demo's data folder afterwards")
    ap.add_argument("--seed-only", metavar="URL", help="fill an already running, empty HaRM at URL instead")
    ap.add_argument("--save", metavar="FILE", help="write the filled-in demo database to FILE and stop")
    args = ap.parse_args()
    if args.seed_only:
        seed(Api(args.seed_only.rstrip("/")))
        return
    with socket.socket() as s:
        if s.connect_ex(("127.0.0.1", args.port)) == 0:
            raise SystemExit(f"Port {args.port} is already in use. Pick another with --port.")
    tmp = tempfile.mkdtemp(prefix="harm-demo-")
    py = ROOT / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    # HARM_DEMO=1: the demo never checks, wakes or runs actions on its made-up addresses for real.
    env = {**os.environ, "HARM_DB": str(Path(tmp) / "harm.db"), "HARM_AUTO_BACKUP": "0", "HARM_IDLE_MINUTES": "720", "HARM_DEMO": "1"}
    server = subprocess.Popen([str(py if py.exists() else sys.executable), "-m", "uvicorn", "harm.main:app", "--host", "127.0.0.1",
                               "--port", str(args.port)], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = f"http://127.0.0.1:{args.port}"
    try:
        for _ in range(100):
            try:
                urllib.request.urlopen(base + "/api/auth/status", timeout=1)
                break
            except Exception:
                time.sleep(0.2)
        seed(Api(base))
        seed_status(Path(tmp) / "harm.db")
        if args.save:
            return
        print(f"Demo running at {base}  ·  password: {PASSWORD}  ·  Ctrl+C to stop", flush=True)
        server.wait()
    except KeyboardInterrupt:
        pass
    finally:
        server.terminate()
        try:
            server.wait(10)
        except subprocess.TimeoutExpired:
            server.kill()
        if args.save:
            out = Path(args.save).resolve()
            out.unlink(missing_ok=True)
            conn = sqlite3.connect(Path(tmp) / "harm.db")
            conn.execute("VACUUM INTO ?", (str(out),))
            conn.close()
            print(f"Demo database saved to {out}")
        if args.keep:
            print(f"Demo data kept in {tmp}")
        else:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
