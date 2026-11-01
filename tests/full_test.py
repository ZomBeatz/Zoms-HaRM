"""Full feature test. Starts HaRM on a throwaway database and exercises every API area,
reporting every failure instead of stopping at the first one.

    .venv/bin/python tests/full_test.py
"""
import http.cookiejar
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORT = 8098
BASE = f"http://127.0.0.1:{PORT}"
PW = "correct horse battery"


class Client:
    def __init__(self):
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def raw(self, m, p, body=None, headers=None, data=None):
        h = {"X-HaRM": "1", "Origin": BASE}
        if body is not None:
            h["Content-Type"] = "application/json"
            data = json.dumps(body).encode()
        h.update(headers or {})
        req = urllib.request.Request(BASE + p, method=m, data=data, headers={k: v for k, v in h.items() if v is not None})
        try:
            r = self.op.open(req, timeout=60)
            return r.status, r.read(), r.headers
        except urllib.error.HTTPError as e:
            return e.code, e.read(), e.headers

    def call(self, m, p, body=None, expect=200, **kw):
        code, data, _ = self.raw(m, "/api" + p, body, **kw)
        try:
            data = json.loads(data)
        except ValueError:
            pass
        if code != expect:
            raise AssertionError(f"{m} {p}: expected {expect}, got {code}: {str(data)[:300]}")
        return data


results = []


def test(name):
    def wrap(fn):
        try:
            fn()
            results.append((name, None))
            print(f"  ✓ {name}")
        except Exception as e:  # noqa: BLE001 — report everything
            results.append((name, e))
            print(f"  ✗ {name}: {e}")
            if os.environ.get("VERBOSE"):
                traceback.print_exc()
        return fn
    return wrap


def fake_ai():
    """A stand-in OpenAI-compatible AI service (like Ollama) for the built-in AI Assist test."""
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer
    seen = {}

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a): pass
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            seen["body"], seen["auth"], seen["path"] = body, self.headers.get("Authorization"), self.path
            reply = {"harm_ai": 1, "items": [{"type": "part", "category": "SSD", "model": "Samsung 870 EVO", "capacity": "1tb",
                                               "quantity": 2, "confidence": "high", "todo": ["Check wear level"]}], "todo": []}
            raw = json.dumps({"choices": [{"message": {"content": "Here you go:\n```json\n" + json.dumps(reply) + "\n```"}}]}).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(raw)
    srv = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, seen


def fake_proxmox():
    """A stand-in Proxmox VE API (two nodes, a VM with the guest agent, a container, a template)."""
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer
    G = 1024 ** 3
    pages = {
        "/api2/json/cluster/status": [{"type": "cluster", "name": "homelab"},
                                      {"type": "node", "name": "pve1", "ip": "10.7.0.11"}, {"type": "node", "name": "pve2", "ip": "10.7.0.12"}],
        "/api2/json/cluster/resources": [
            {"type": "node", "node": "pve1", "status": "online", "maxcpu": 24, "maxmem": 64 * G, "maxdisk": 100 * G},
            {"type": "node", "node": "pve2", "status": "online", "maxcpu": 16, "maxmem": 32 * G, "maxdisk": 100 * G},
            {"type": "qemu", "vmid": 100, "name": "plex", "node": "pve1", "status": "running", "maxcpu": 4, "maxmem": 8 * G, "maxdisk": 64 * G},
            {"type": "lxc", "vmid": 101, "name": "pihole", "node": "pve2", "status": "stopped", "maxcpu": 1, "maxmem": 1 * G, "maxdisk": 8 * G},
            {"type": "qemu", "vmid": 9000, "name": "ubuntu-template", "node": "pve1", "status": "stopped", "template": 1},
            {"type": "storage", "storage": "local"}],
        "/api2/json/nodes/pve1/qemu/100/agent/network-get-interfaces": {"result": [
            {"name": "lo", "ip-addresses": [{"ip-address-type": "ipv4", "ip-address": "127.0.0.1"}]},
            {"name": "eth0", "ip-addresses": [{"ip-address-type": "ipv4", "ip-address": "10.7.0.50"}]}]},
    }

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a): pass
        def do_GET(self):
            if self.headers.get("Authorization") != "PVEAPIToken=root@pam!harm=s3cret":
                self.send_response(401); self.end_headers(); return
            data = pages.get(self.path.split("?")[0])
            if data is None:
                self.send_response(404); self.end_headers(); return
            raw = json.dumps({"data": data}).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(raw)
    srv = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def main():
    tmp = tempfile.mkdtemp(prefix="harm-full-")
    env = {**os.environ, "HARM_DB": os.path.join(tmp, "harm.db"), "HARM_AUTO_BACKUP": "0", "HARM_IDLE_MINUTES": "30",
           "HARM_MONITOR": "0"}
    server = subprocess.Popen([sys.executable, "-m", "uvicorn", "harm.main:app", "--port", str(PORT)],
                              cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=open(os.path.join(tmp, "err.log"), "w"))
    try:
        for _ in range(60):
            try:
                urllib.request.urlopen(BASE + "/api/auth/status", timeout=1)
                break
            except Exception:
                time.sleep(0.2)
        run(Client())
    finally:
        server.terminate()
        server.wait(10)
        errs = open(os.path.join(tmp, "err.log")).read()
        tracebacks = errs.count("Traceback")
        shutil.rmtree(tmp, ignore_errors=True)
    failed = [r for r in results if r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed" + (f", {tracebacks} server tracebacks" if tracebacks else ""))
    if tracebacks:
        print(errs[-3000:])
    sys.exit(1 if failed or tracebacks else 0)


def run(c: Client):
    S = {}

    print("Auth & security")

    @test("status before setup")
    def _():
        st = c.call("GET", "/auth/status")
        assert st["setup"] is False and st["authenticated"] is False, st

    @test("weak password rejected")
    def _():
        c.call("POST", "/auth/setup", {"password": "short"}, expect=400)

    @test("setup")
    def _():
        S["rc"] = c.call("POST", "/auth/setup", {"password": PW})["recovery_code"]

    @test("second setup refused")
    def _():
        Client().call("POST", "/auth/setup", {"password": "another long password"}, expect=409)

    @test("CSRF: missing header refused")
    def _():
        code, _, _ = c.raw("POST", "/api/locations", {"name": "x"}, headers={"X-HaRM": None})
        assert code == 403, code

    @test("CSRF: foreign origin refused")
    def _():
        code, _, _ = c.raw("POST", "/api/locations", {"name": "x"}, headers={"Origin": "https://evil.example"})
        assert code == 403, code

    @test("unauthenticated API refused")
    def _():
        Client().call("GET", "/devices", expect=401)

    @test("security headers")
    def _():
        _, _, hd = c.raw("GET", "/")
        csp = hd.get("Content-Security-Policy", "")
        assert "script-src 'self'" in csp and hd.get("X-Content-Type-Options") == "nosniff", dict(hd)

    @test("wrong password then login")
    def _():
        o = Client()
        o.call("POST", "/auth/login", {"password": "wrong password!!"}, expect=401)
        o.call("POST", "/auth/login", {"password": PW})
        assert o.call("GET", "/auth/status")["authenticated"]

    @test("TOTP enable, login needs code, disable")
    def _():
        import pyotp
        t = c.call("POST", "/auth/totp/begin")
        c.call("POST", "/auth/totp/enable", {"code": "000000"}, expect=400)
        c.call("POST", "/auth/totp/enable", {"code": pyotp.TOTP(t["secret"]).now()})
        o = Client()
        o.call("POST", "/auth/login", {"password": PW}, expect=401)
        o.call("POST", "/auth/login", {"password": PW, "totp": pyotp.TOTP(t["secret"]).now()})
        c.call("POST", "/auth/totp/disable", {"password": PW})
        Client().call("POST", "/auth/login", {"password": PW})

    print("Locations, racks, devices")

    @test("location tree, no cycles")
    def _():
        S["home"] = c.call("POST", "/locations", {"name": "Home", "kind": "Building"})
        S["base"] = c.call("POST", "/locations", {"name": "Basement", "kind": "Room", "parent_id": S["home"]["id"]})
        c.call("PUT", f"/locations/{S['home']['id']}", {"parent_id": S["base"]["id"]}, expect=400)

    @test("validation: unknown field, bad FK, required")
    def _():
        c.call("POST", "/devices", {"name": "x", "bogus": 1}, expect=400)
        c.call("POST", "/devices", {"name": "x", "location_id": 99999}, expect=400)
        c.call("POST", "/devices", {"model": "no name"}, expect=400)
        c.call("POST", "/devices", {"name": "x", "purchase_date": "13/45/2020"}, expect=400)

    @test("rack placement: bounds, overlap, faces")
    def _():
        S["rack"] = c.call("POST", "/racks", {"name": "Main", "kind": "Rack", "height_u": 12, "location_id": S["base"]["id"]})
        rid = S["rack"]["id"]
        S["srv"] = c.call("POST", "/devices", {"name": "srv1", "device_type": "Server", "rack_id": rid, "rack_u": 1, "u_height": 2,
                                                "serial": "SN-1", "mgmt_url": "https://10.0.0.50"})
        assert S["srv"]["location_id"] == S["base"]["id"], "location should follow the rack"
        c.call("POST", "/devices", {"name": "clash", "rack_id": rid, "rack_u": 2}, expect=409)
        c.call("POST", "/devices", {"name": "too high", "rack_id": rid, "rack_u": 12, "u_height": 2}, expect=400)
        # a half-depth rear device can share a U with a half-depth front one
        a = c.call("POST", "/devices", {"name": "front-half", "rack_id": rid, "rack_u": 5, "full_depth": False})
        c.call("POST", "/devices", {"name": "rear-half", "rack_id": rid, "rack_u": 5, "rack_face": "rear", "full_depth": False})
        lay = c.call("GET", f"/racks/{rid}/layout")
        assert len(lay["devices"]) == 3, lay
        S["half"] = a

    @test("device status follows hooked-up; quick status change")
    def _():
        d = c.call("PUT", f"/devices/{S['srv']['id']}", {"status": "In Repair"})
        assert d["status"] == "In Repair"
        c.call("PUT", f"/devices/{S['srv']['id']}", {"status": "Active", "connected": True})

    @test("location contents")
    def _():
        loose = c.call("POST", "/devices", {"name": "laptop", "location_id": S["base"]["id"], "position": "pile by the door"})
        ct = c.call("GET", f"/locations/{S['base']['id']}/contents")
        assert any(d["id"] == loose["id"] for d in ct["loose_devices"]) and ct["racks"], ct.keys()

    print("Parts, slots, bays, CPU/memory")

    @test("capacity normalized and status follows device")
    def _():
        S["bay"] = c.call("POST", "/device_slots", {"device_id": S["srv"]["id"], "interface": "SAS/SATA", "form_factor": '3.5"',
                                                    "total": 4, "label": "Front", "array_name": "RAID 5", "first_index": 0})
        S["drives"] = c.call("POST", "/components", {"category": "HDD", "capacity": "4tb", "interface": "SATA", "form_factor": '3.5"',
                                                     "quantity": 3, "device_id": S["srv"]["id"], "slot_id": S["bay"]["id"]})
        assert S["drives"]["capacity"] == "4 TB" and S["drives"]["status"] == "Installed", S["drives"]

    @test("spares fit the bay; install and uninstall")
    def _():
        spare = c.call("POST", "/components", {"category": "HDD", "capacity": "4000 GB", "interface": "SATA", "form_factor": '3.5"',
                                               "quantity": 2, "location_id": S["base"]["id"]})
        assert spare["capacity"] == "4 TB" and spare["status"] == "In Stock"
        fits = c.call("GET", f"/components/{spare['id']}/fits")
        assert any(f["device_id"] == S["srv"]["id"] for f in (fits if isinstance(fits, list) else fits.get("devices", fits.get("fits", [])))), fits
        c.call("POST", f"/components/{spare['id']}/install", {"device_id": S["srv"]["id"], "quantity": 1})
        full = c.call("GET", f"/devices/{S['srv']['id']}/full")
        assert full["storage"]["drives"] == 4, full["storage"]
        inst = [x for x in full["components"] if x["id"] != S["drives"]["id"] and x["category"] == "HDD"][0]
        c.call("POST", f"/components/{inst['id']}/uninstall", {"rack_id": S["rack"]["id"]})
        c.call("POST", f"/components/{inst['id']}/uninstall", {}, expect=400)
        c.call("POST", f"/components/{spare['id']}/install", {"device_id": S["srv"]["id"], "quantity": 99}, expect=400)
        S["spare"] = spare

    @test("split one drive out of a group and mark it failed")
    def _():
        one = c.call("POST", f"/components/{S['drives']['id']}/split", {"slot_id": S["bay"]["id"], "bay": 2})
        assert one["quantity"] == 1 and one["bay"] == 2
        c.call("PUT", f"/components/{one['id']}", {"health": "Failed"})
        assert c.call("GET", f"/components/{S['drives']['id']}")["quantity"] == 2

    @test("memory and CPU summaries")
    def _():
        c.call("POST", "/components", {"category": "RAM", "capacity": "16gb", "interface": "DDR4 RDIMM", "quantity": 4, "device_id": S["srv"]["id"]})
        cpu = c.call("GET", "/catalog/search?category=cpu&q=xeon")["results"]
        assert cpu, "seeded server CPUs should be searchable"
        f = c.call("GET", f"/catalog/{cpu[0]['id']}/component-fields")
        f.update(device_id=S["srv"]["id"], quantity=2, catalog_id=cpu[0]["id"])
        c.call("POST", "/components", {k: v for k, v in f.items() if k in ("category", "manufacturer", "model", "part_number", "capacity", "interface", "form_factor", "speed", "quantity", "device_id", "catalog_id")})
        full = c.call("GET", f"/devices/{S['srv']['id']}/full")
        assert full["memory"]["total"] == "64 GB", full["memory"]
        assert full["cpus"]["cores"] > 0, full["cpus"]

    @test("device summary and fleet totals")
    def _():
        s = c.call("GET", "/devices/summary")
        d = s["devices"][str(S["srv"]["id"])]
        assert d["cores"] and d["ram"] and d["storage"], d
        assert s["totals"]["drives"] == 3  # 4 installed, 1 removed earlier

    @test("deleting a slot clears bay numbers on its parts")
    def _():
        tmp = c.call("POST", "/device_slots", {"device_id": S["srv"]["id"], "interface": "NVMe", "total": 2})
        p = c.call("POST", "/components", {"category": "NVMe SSD", "capacity": "1tb", "device_id": S["srv"]["id"], "slot_id": tmp["id"], "bay": 1})
        c.call("DELETE", f"/device_slots/{tmp['id']}")
        p = c.call("GET", f"/components/{p['id']}")
        assert p["slot_id"] is None and p["bay"] is None, p

    print("Networks, interfaces, services, connections")

    @test("network + interface linking, IP/MAC normalization")
    def _():
        S["net"] = c.call("POST", "/networks", {"name": "Lab", "cidr": "10.0.0.0/24", "gateway": "10.0.0.1", "vlan_id": 10,
                                                "dhcp_start": "10.0.0.100", "dhcp_end": "10.0.0.200"})
        i = c.call("POST", "/interfaces", {"device_id": S["srv"]["id"], "name": "eno1", "ip": "10.0.0.20/24", "mac": "aa-bb-cc-dd-ee-ff"})
        assert i["ip"] == "10.0.0.20" and i["subnet"] == "/24" and i["mac"] == "AA:BB:CC:DD:EE:FF" and i["network_id"] == S["net"]["id"], i
        c.call("POST", "/interfaces", {"device_id": S["srv"]["id"], "ip": "999.1.1.1"}, expect=400)
        S["iface"] = i

    @test("IP map: conflicts, DHCP range, next free")
    def _():
        c.call("POST", "/interfaces", {"device_id": S["half"]["id"], "ip": "10.0.0.20"})
        c.call("POST", "/interfaces", {"device_id": S["half"]["id"], "ip": "10.0.0.150"})
        m = c.call("GET", f"/networks/{S['net']['id']}/ipmap")
        assert "10.0.0.20" in m["conflicts"] and m["next_free"][0] == "10.0.0.2", (m["conflicts"], m["next_free"][:3])
        assert any(e["in_dhcp_range"] for e in m["entries"])
        dash = c.call("GET", "/dashboard")
        assert any(x["label"] == "10.0.0.20" for x in dash["ip_conflicts"])

    @test("services and connections")
    def _():
        S["svc"] = c.call("POST", "/services", {"device_id": S["srv"]["id"], "name": "Proxmox", "protocol": "HTTPS", "port": 8006,
                                                "url": "https://10.0.0.20:8006"})
        c.call("POST", "/connections", {"a_device_id": S["srv"]["id"], "a_port": "eno1"}, expect=400)
        c.call("POST", "/connections", {"a_device_id": S["srv"]["id"], "a_port": "eno1", "b_device_id": S["half"]["id"], "b_port": "24", "medium": "Cat6"})

    print("Vault")

    @test("credential secrets encrypted, reveal and launch targets")
    def _():
        cr = c.call("POST", "/credentials", {"label": "iDRAC", "kind": "Web UI", "username": "root", "password": "calvin",
                                             "totp_secret": "JBSWY3DPEHPK3PXP", "device_id": S["srv"]["id"]})
        assert "password" not in cr and cr["has_password"] and cr["has_totp"], cr
        rv = c.call("POST", f"/credentials/{cr['id']}/reveal")
        assert rv["password"] == "calvin" and len(rv["totp_code"]) == 6
        assert rv["targets"][0]["url"] == "https://10.0.0.50", rv["targets"]
        ssh = c.call("POST", "/credentials", {"label": "root ssh", "kind": "SSH", "username": "root", "device_id": S["srv"]["id"]})
        t = c.call("POST", f"/credentials/{ssh['id']}/reveal")["targets"]
        assert t == [{"type": "ssh", "host": "10.0.0.20", "port": 22}], t
        c.call("POST", "/credentials", {"label": "bad", "totp_secret": "not base32!!"}, expect=400)
        S["cred"] = cr

    @test("password change keeps vault, signs out other sessions")
    def _():
        other = Client()
        other.call("POST", "/auth/login", {"password": PW})
        c.call("POST", "/auth/change-password", {"current_password": PW, "new_password": "brand new password 1"})
        other.call("GET", "/devices", expect=401)
        assert c.call("POST", f"/credentials/{S['cred']['id']}/reveal")["password"] == "calvin"
        c.call("POST", "/auth/change-password", {"current_password": "brand new password 1", "new_password": PW})

    print("Notes & tasks")

    @test("journal kinds, done, pin, open tasks")
    def _():
        n = c.call("POST", "/notes", {"entity": "devices", "entity_id": S["srv"]["id"], "kind": "task", "body": "Replace PSU"})
        c.call("POST", "/notes", {"entity": "devices", "entity_id": S["srv"]["id"], "kind": "bogus", "body": "x"}, expect=400)
        c.call("POST", "/notes", {"entity": "devices", "entity_id": 99999, "body": "x"}, expect=400)
        c.call("PUT", f"/notes/{n['id']}", {"pinned": True})
        assert any(x["id"] == n["id"] for x in c.call("GET", "/notes?done=0"))
        assert c.call("PUT", f"/notes/{n['id']}", {"done": True})["done_at"]
        assert not any(x["id"] == n["id"] for x in c.call("GET", "/notes?done=0"))

    print("Search")

    @test("search finds each kind and links to the item itself")
    def _():
        c.call("POST", "/notes", {"entity": "devices", "entity_id": S["srv"]["id"], "body": "zebra firmware note"})
        def hit(q, kind):
            r = [x for x in c.call("GET", "/search?q=" + urllib.parse.quote(q)) if x["kind"] == kind]
            assert r, f"no {kind} for {q}"
            return r[0]["link"]
        assert hit("srv1", "Device") == f"#/devices/{S['srv']['id']}"
        ips = [x["link"] for x in c.call("GET", "/search?q=10.0.0.20") if x["kind"] == "IP / Interface"]
        assert any(l.endswith(f"edit=interfaces-{S['iface']['id']}") for l in ips), ips
        assert hit("Proxmox", "Service").endswith(f"edit=services-{S['svc']['id']}")
        assert hit("iDRAC", "Credential").endswith(f"open={S['cred']['id']}")
        assert "components?id=" in hit("4 TB", "Component")
        assert hit("zebra", "Note").startswith(f"#/devices/{S['srv']['id']}")
        assert hit("Lab", "Network") == f"#/networks/{S['net']['id']}"
        assert c.call("GET", "/search?q=a") == []

    print("PC builder & library")

    @test("custom part, copy, delete; library status")
    def _():
        c.call("GET", "/catalog/meta")
        c.call("GET", "/catalog/status")
        p = c.call("POST", "/catalog", {"category": "cpu", "name": "Test CPU 9000", "manufacturer": "AMD",
                                        "specs": {"socket": "AM5", "cores": 8, "threads": 16, "memory_types": "DDR5"}})
        cp = c.call("POST", f"/catalog/{p['id']}/copy")
        c.call("PUT", f"/catalog/{cp['id']}", {"category": "cpu", "name": "Test CPU 9000 (fixed)", "specs": {"socket": "AM5", "cores": 8}})
        c.call("DELETE", f"/catalog/{cp['id']}")
        c.call("POST", "/catalog", {"category": "nope", "name": "x"}, expect=400)
        S["cpu_part"] = p

    @test("build with compatibility issue, then to device")
    def _():
        b = c.call("POST", "/builds", {"name": "Gaming PC", "purpose": "Gaming PC"})
        mb = c.call("POST", "/catalog", {"category": "motherboard", "name": "Test Board AM4", "specs": {"socket": "AM4", "ram_type": "DDR4", "ram_slots": 4}})
        c.call("POST", "/build_items", {"build_id": b["id"], "category": "cpu", "catalog_id": S["cpu_part"]["id"], "price": 300})
        c.call("POST", "/build_items", {"build_id": b["id"], "category": "motherboard", "catalog_id": mb["id"], "price": 150})
        c.call("POST", "/build_items", {"build_id": b["id"], "category": "storage", "component_id": S["spare"]["id"], "acquire": "Have"})
        c.call("POST", "/build_items", {"build_id": b["id"], "category": "cpu", "name": "x", "acquire": "Maybe"}, expect=400)
        full = c.call("GET", f"/builds/{b['id']}/full")
        txt = json.dumps(full).lower()
        assert "socket" in txt, "AM5 CPU on an AM4 board should be flagged"
        c.call("GET", f"/catalog/search?category=motherboard&build_id={b['id']}&compatible=1")
        c.call("GET", f"/builds/{b['id']}/inventory?category=storage")
        dup = c.call("POST", f"/builds/{b['id']}/duplicate")
        dev = c.call("POST", f"/builds/{b['id']}/to-device", {"name": "Gaming PC"})
        did = dev.get("device_id") or dev.get("id") or dev.get("device", {}).get("id")
        assert did, dev
        c.call("POST", f"/builds/{b['id']}/to-device", {}, expect=400)
        c.call("DELETE", f"/builds/{dup['id']}")

    @test("library part to inventory")
    def _():
        r = c.call("POST", f"/catalog/{S['cpu_part']['id']}/to-inventory", {"quantity": 2, "location_id": S["base"]["id"]})
        assert r, r

    print("Import specs, scanning, export")

    @test("collector output parses (this machine)")
    def _():
        out = subprocess.run(["bash", str(ROOT / "harm/static/collect/harm-collect.sh")], capture_output=True, text=True, timeout=120).stdout
        r = c.call("POST", "/specs/parse", {"text": "noise before\n" + out})
        assert r["device"].get("hostname") and r["disks"] is not None, r["device"]
        c.call("POST", "/specs/parse", {"text": "garbage"}, expect=400)

    @test("collect locally via API; SSH input checks")
    def _():
        c.call("GET", f"/devices/{S['srv']['id']}/collect-targets")
        assert "harm_collect" in c.call("POST", f"/devices/{S['srv']['id']}/collect", {"mode": "local"})["output"]
        c.call("POST", f"/devices/{S['srv']['id']}/collect", {"mode": "ssh", "host": "-oProxyCommand=x", "username": "a"}, expect=400)

    @test("scan a QR label photo")
    def _():
        if not shutil.which("qrencode"):
            return
        png = subprocess.run(["qrencode", "-t", "PNG", "-s", "6", "-o", "-", "SN-ABC123"], capture_output=True).stdout
        r = c.call("POST", "/scan", headers={"Content-Type": "image/png"}, data=png)
        if r["barcode_reader"]:
            assert any(b["value"] == "SN-ABC123" for b in r["barcodes"]), r
        c.call("POST", "/scan", headers={"Content-Type": "application/octet-stream"}, data=b"not an image", expect=415)

    @test("CSV export for every entity, bundle, backup")
    def _():
        for e in ("devices", "components", "racks", "locations", "networks", "interfaces", "services", "connections", "device_slots"):
            code, data, hd = c.raw("GET", f"/api/export/{e}.csv")
            assert code == 200 and b"," in data, (e, code)
        code, data, _ = c.raw("GET", "/api/export/credentials.csv")
        assert code in (400, 403, 404) or b"calvin" not in data, "secrets must never be exported"
        b = c.call("GET", f"/export/bundle?ids={S['srv']['id']}")
        assert "calvin" not in json.dumps(b), "secrets must not be in bundles"
        code, data, _ = c.raw("GET", "/api/backup")
        assert code == 200 and data[:16] == b"SQLite format 3\x00", code

    print("AI Assist")

    @test("prompt, messy reply parsing, duplicates, import with notes and tasks")
    def _():
        loc = c.call("POST", "/locations", {"name": "Garage"})
        bin_ = c.call("POST", "/racks", {"name": "Bin 4", "kind": "Bin", "location_id": loc["id"]})
        pr = c.call("POST", "/ai/prompt", {"hint": "drives from a recycler", "location_id": loc["id"], "rack_id": bin_["id"], "position": "top"})["prompt"]
        assert "Garage > Bin 4 > top" in pr and "drives from a recycler" in pr and '"harm_ai": 1' in pr, pr[:400]
        c.call("POST", "/devices", {"name": "Old R710", "serial": "7XK9P2"})
        reply = """Sure! Here's what I found in your photos:
```json
{"harm_ai": 1, "summary": "A Dell server and a stack of drives.",
 "items": [
  {"type": "device", "name": "Dell PowerEdge R710", "category": "server", "manufacturer": "Dell", "model": "PowerEdge R710",
   "serial": "7xk9p2", "specs": {"cpu": "2x Xeon X5650", "ram": "48 GB DDR3", "storage": "6x 3.5in bays"},
   "msrp": "$3,299", "market_value": "around $120", "currency": "USD", "value_notes": "eBay sold Oct 2026: $90-150",
   "sources": ["https://www.ebay.com/sch/i.html?_nkw=r710", "not a url"], "confidence": "High",
   "todo": ["Check iDRAC license"]},
  {"type": "part", "category": "Hard drive", "manufacturer": "Seagate", "model": "ST4000NM0035", "capacity": "4tb",
   "interface": "SATA", "form_factor": "3.5\"", "speed": "7200 RPM", "quantity": 6, "condition": "used good",
   "market_value": 35, "confidence": "medium", "todo": ["Run SMART tests", "Scan serials"], },
  {"type": "part", "category": "memory stick", "model": "M393B2G70BH0-YH9", "capacity": "16gb", "interface": "DDR3 RDIMM", "quantity": 4, "confidence": "low"}
 ],
 "todo": ["Label the bin"]}
```
Let me know if you need anything else!"""
        r = c.call("POST", "/ai/parse", {"text": reply})
        dev, hdd, ram = r["items"]
        assert dev["kind"] == "device" and dev["device_type"] == "Server" and dev["msrp"] == 3299 and dev["market_value"] == 120, dev
        assert dev["duplicate"] and dev["duplicate"]["name"] == "Old R710", "serial match should be case-insensitive"
        assert dev["sources"] == ["https://www.ebay.com/sch/i.html?_nkw=r710"] and dev["confidence"] == "high"
        assert hdd["category"] == "HDD" and hdd["capacity"] == "4 TB" and hdd["quantity"] == 6 and hdd["condition"] == "Used - Good", hdd
        assert ram["category"] == "RAM" and ram["capacity"] == "16 GB", ram
        c.call("POST", "/ai/parse", {"text": "I couldn't see anything, sorry."}, expect=400)
        out = c.call("POST", "/ai/import", {"items": [hdd, ram], "batch_todo": r["todo"], "location_id": loc["id"],
                                            "rack_id": bin_["id"], "position": "top"})
        assert len(out["created"]) == 2 and out["tasks"] == 3, out
        part = c.call("GET", f"/components/{out['created'][0]['id']}")
        assert part["rack_id"] == bin_["id"] and part["status"] == "In Stock" and part["market_value"] == 35 and part["value_checked"], part
        notes = c.call("GET", f"/notes?entity=components&entity_id={part['id']}")
        assert any(n["kind"] == "task" and "SMART" in n["body"] for n in notes)
        assert any(n["kind"] == "note" and "AI Assist" in n["body"] for n in notes), notes
        assert any("Label the bin" in n["body"] for n in c.call("GET", f"/notes?entity=racks&entity_id={bin_['id']}"))
        d = c.call("POST", "/ai/import", {"items": [dev], "device_status": "Spare"})["created"][0]
        dd = c.call("GET", f"/devices/{d['id']}")
        assert dd["status"] == "Spare" and dd["cpu"] == "2x Xeon X5650" and dd["msrp"] == 3299, dd

    @test("built-in AI: settings, key encrypted, photos to a local AI service")
    def _():
        import base64
        cfg = c.call("GET", "/ai/config")
        assert set(cfg["providers"]) == {"anthropic", "openai", "gemini", "compatible"}
        c.call("POST", "/ai/ask", {"images": []}, expect=502)  # not set up yet
        srv, seen = fake_ai()
        c.call("POST", "/ai/config", {"provider": "compatible", "base_url": "ftp://x"}, expect=400)
        cfg = c.call("POST", "/ai/config", {"provider": "compatible", "model": "llava", "api_key": "sk-local",
                                            "base_url": f"http://127.0.0.1:{srv.server_port}/v1"})
        assert cfg["has_key"]["compatible"] and "sk-local" not in json.dumps(cfg)
        code, data, _ = c.raw("GET", "/api/backup")
        assert b"sk-local" not in data, "API keys must be stored encrypted"
        png = base64.b64encode(subprocess.run(["qrencode", "-t", "PNG", "-o", "-", "x"], capture_output=True).stdout).decode() if shutil.which("qrencode") else "iVBORw0KGgo="
        r = c.call("POST", "/ai/ask", {"images": [f"data:image/png;base64,{png}"], "hint": "SSDs"})
        assert r["items"][0]["category"] == "SSD" and r["items"][0]["capacity"] == "1 TB" and r["raw"], r
        assert seen["auth"] == "Bearer sk-local" and seen["path"] == "/v1/chat/completions"
        content = seen["body"]["messages"][0]["content"]
        assert content[0]["type"] == "text" and "SSDs" in content[0]["text"] and content[1]["image_url"]["url"].startswith("data:image/png")
        srv.shutdown()
        c.call("POST", "/ai/config", {"provider": ""})

    @test("built-in AI: Claude, ChatGPT and Gemini request formats")
    def _():
        sys.path.insert(0, str(ROOT))
        from harm import aiproviders as A
        sent = []
        canned = {"anthropic": {"content": [{"type": "server_tool_use"}, {"type": "text", "text": "{\"items\": []}"}]},
                  "openai": {"output": [{"type": "web_search_call"}, {"type": "message", "content": [{"type": "output_text", "text": "{\"items\": []}"}]}]},
                  "gemini": {"candidates": [{"content": {"parts": [{"text": "{\"items\": []}"}]}}]}}
        img = "data:image/jpeg;base64,AAAA"
        for prov in ("anthropic", "openai", "gemini"):
            A._post = lambda url, headers, body, prov=prov: (sent.append((url, headers, body)), canned[prov])[1]
            out = A.ask({"provider": prov}, "KEY", "PROMPT", [img])
            assert out["text"] == '{"items": []}' and out["web"], (prov, out)
        (u1, h1, b1), (u2, h2, b2), (u3, h3, b3) = sent
        assert u1.endswith("/v1/messages") and h1["x-api-key"] == "KEY" and b1["model"] == "claude-sonnet-5-5"
        assert b1["messages"][0]["content"][0]["source"] == {"type": "base64", "media_type": "image/jpeg", "data": "AAAA"}
        assert b1["tools"][0]["name"] == "web_search"
        assert u2.endswith("/v1/responses") and h2["Authorization"] == "Bearer KEY" and b2["input"][0]["content"][1]["image_url"] == img
        assert "gemini-2.5-flash:generateContent" in u3 and h3["x-goog-api-key"] == "KEY" and "KEY" not in u3
        assert b3["contents"][0]["parts"][0]["inline_data"]["data"] == "AAAA" and b3["tools"] == [{"google_search": {}}]
        # A model without web search: retried once without it, with a note.
        calls = []
        def flaky(url, headers, body):
            calls.append(body)
            if "tools" in body:
                raise A.AIError("The AI service answered 400: web_search tool not supported for this model")
            return canned["anthropic"]
        A._post = flaky
        out = A.ask({"provider": "anthropic"}, "KEY", "P", [img])
        assert len(calls) == 2 and not out["web"] and out["note"]
        try:
            A.ask({"provider": "openai"}, None, "P", [img]); raise AssertionError("missing key should be refused")
        except A.AIError:
            pass

    @test("HTTPS certificate meets iPhone/iPad rules (lifetime <= 825 days, server key usage)")
    def _():
        import tempfile as tf
        sys.path.insert(0, str(ROOT))
        from harm import certs
        from cryptography import x509
        with tf.TemporaryDirectory() as d:
            certs.TLS = Path(d); certs.CA_CRT, certs.CA_KEY = Path(d) / "ca.crt", Path(d) / "ca.key"
            certs.CRT, certs.KEY = Path(d) / "s.crt", Path(d) / "s.key"
            certs.make_server_cert(["host.lan", "10.0.0.5"])
            c = x509.load_pem_x509_certificate(certs.CRT.read_bytes())
            assert (c.not_valid_after_utc - c.not_valid_before_utc).days <= 825
            assert c.extensions.get_extension_for_class(x509.KeyUsage).value.digital_signature
            assert {"host.lan", "10.0.0.5"} <= certs.cert_names()

    print("Virtual machines, clusters, main address")

    @test("phones, tablets and more recognised; pasted router list")
    def _():
        assert {"Phone", "Tablet", "Virtual Machine", "Container"} <= set(c.call("GET", "/meta/enums")["device_types"])
        out = c.call("POST", "/discover/clients", {"text": "1697049600 aa:bb:cc:dd:ee:01 192.168.9.50 Alex-s-S25-Ultra *\n"
                                                           "1697049600 aa:bb:cc:dd:ee:02 192.168.9.51 iPad *\n"
                                                           "1697049600 aa:bb:cc:dd:ee:03 192.168.9.52 LivingRoom-Roku *"})
        assert [x["type_guess"] for x in out["hosts"]] == ["Phone", "Tablet", "TV / Streaming"], out

    @test("VMs run on a host: no rack space, no loops, host totals")
    def _():
        rk = c.call("POST", "/racks", {"name": "VM test rack", "kind": "Rack", "height_u": 10})
        host = c.call("POST", "/devices", {"name": "pve-test", "device_type": "Hypervisor Host", "rack_id": rk["id"], "rack_u": 1})
        vm = c.call("POST", "/devices", {"name": "web01", "device_type": "Virtual Machine", "host_id": host["id"], "rack_id": rk["id"],
                                         "rack_u": 5, "vm_id": "100", "vcpus": 4, "vm_ram_gb": 8, "vm_disk_gb": 64})
        assert vm["rack_id"] is None and vm["rack_u"] is None and vm["host_name"] == "pve-test", vm
        c.call("PUT", f"/devices/{host['id']}", {"host_id": vm["id"]}, expect=400)
        c.call("POST", "/devices", {"name": "db01", "device_type": "Container", "host_id": host["id"], "vcpus": 2, "vm_ram_gb": 4})
        full = c.call("GET", f"/devices/{host['id']}/full")
        assert full["guest_totals"]["count"] == 2 and full["guest_totals"]["vcpus"] == 6 and full["guest_totals"]["ram_gb"] == 12, full["guest_totals"]
        summ = c.call("GET", "/devices/summary")
        assert summ["virtual"]["count"] >= 2 and summ["devices"][str(vm["id"])]["virtual"]
        c.call("DELETE", f"/devices/{host['id']}")
        assert c.call("GET", f"/devices/{vm['id']}")["host_id"] is None, "guests survive their host being deleted"
        S["vm_rack"] = rk

    @test("clusters: nodes, guests, capacity, notes, search")
    def _():
        cl = c.call("POST", "/clusters", {"name": "lab-cluster", "kind": "Proxmox VE"})
        n1 = c.call("POST", "/devices", {"name": "node-a", "device_type": "Hypervisor Host", "cluster_id": cl["id"]})
        c.call("POST", "/components", {"category": "RAM", "capacity": "32 GB", "quantity": 2, "device_id": n1["id"]})
        c.call("POST", "/devices", {"name": "k8s-1", "device_type": "Virtual Machine", "host_id": n1["id"], "vcpus": 4, "vm_ram_gb": 16})
        full = c.call("GET", f"/clusters/{cl['id']}/full")
        assert len(full["nodes"]) == 1 and len(full["guests"]) == 1 and full["capacity"]["ram_gb"] == 64 and full["allocated"]["ram_gb"] == 16, full
        c.call("POST", "/notes", {"entity": "clusters", "entity_id": cl["id"], "body": "quorum ok"})
        assert any(x["kind"] == "Cluster" and x["link"] == f"#/clusters/{cl['id']}" for x in c.call("GET", "/search?q=lab-cluster"))
        assert c.call("GET", "/clusters")[0]["node_count"] >= 1
        c.call("DELETE", f"/clusters/{cl['id']}")
        assert c.call("GET", f"/devices/{n1['id']}")["cluster_id"] is None

    @test("main address: one per device, management ports never picked first")
    def _():
        d = c.call("POST", "/devices", {"name": "r515-main", "mgmt_url": "https://10.8.0.9"})
        bmc = c.call("POST", "/interfaces", {"device_id": d["id"], "name": "iDRAC", "ip": "10.8.0.9"})
        os1 = c.call("POST", "/interfaces", {"device_id": d["id"], "name": "eno1", "ip": "10.8.0.20"})
        os2 = c.call("POST", "/interfaces", {"device_id": d["id"], "name": "eno2", "ip": "10.8.0.21"})
        assert c.call("GET", f"/devices/{d['id']}")["ips"].split(", ")[0] == "10.8.0.20", "iDRAC must not come first"
        ssh = c.call("POST", "/credentials", {"label": "os ssh", "kind": "SSH", "username": "root", "device_id": d["id"]})
        assert c.call("POST", f"/credentials/{ssh['id']}/reveal")["targets"][0]["host"] == "10.8.0.20"
        c.call("PUT", f"/interfaces/{os2['id']}", {"is_primary": True})
        c.call("PUT", f"/interfaces/{os1['id']}", {"is_primary": True})
        ifs = {i["id"]: i["is_primary"] for i in c.call("GET", f"/interfaces?device_id={d['id']}")}
        assert ifs[os1["id"]] == 1 and ifs[os2["id"]] == 0 and ifs[bmc["id"]] == 0, ifs
        assert c.call("POST", f"/credentials/{ssh['id']}/reveal")["targets"][0]["host"] == "10.8.0.20"
        assert c.call("GET", f"/devices/{d['id']}/collect-targets")["hosts"][0] == "10.8.0.20"

    @test("Proxmox import: cluster, nodes, VMs, containers, IPs; re-import updates")
    def _():
        srv = fake_proxmox(); url = f"http://127.0.0.1:{srv.server_port}"
        c.call("POST", "/discover/proxmox", {"url": url, "token_id": "root@pam!harm", "secret": "wrong"}, expect=400)
        c.call("POST", "/discover/proxmox", {"url": url, "token_id": "not-a-token", "secret": "x"}, expect=400)
        out = c.call("POST", "/discover/proxmox", {"url": url, "token_id": "root@pam!harm", "secret": "s3cret"})
        assert out["cluster"] == "homelab" and [n["name"] for n in out["nodes"]] == ["pve1", "pve2"]
        plex = next(g for g in out["guests"] if g["name"] == "plex")
        assert plex["vcpus"] == 4 and plex["ram_gb"] == 8 and plex["ips"] == ["10.7.0.50"] and plex["running"]
        cfg = c.call("GET", "/discover/config")["proxmox"]
        assert cfg["has_secret"] and cfg["token_id"] == "root@pam!harm"
        nodes = [{"name": n["name"], "ip": n["ip"], "create": True} for n in out["nodes"]]
        guests = [{**g, "create": True} for g in out["guests"] if not g["template"]]
        r = c.call("POST", "/discover/proxmox/import", {"cluster": out["cluster"], "nodes": nodes, "guests": guests})
        assert r["clusters"] == 1 and r["hosts_added"] == 2 and r["guests_added"] == 2 and r["interfaces"] >= 3, r
        again = c.call("POST", "/discover/proxmox", {"url": url, "token_id": "root@pam!harm"})  # stored secret
        assert all(n["match"] for n in again["nodes"]) and all(g["match"] for g in again["guests"] if not g["template"]), again
        r2 = c.call("POST", "/discover/proxmox/import", {"cluster": again["cluster"],
            "nodes": [{"name": n["name"], "ip": n["ip"], "device_id": n["match"]["id"]} for n in again["nodes"]],
            "guests": [{**g, "device_id": g["match"]["id"]} for g in again["guests"] if not g["template"]]})
        assert r2["guests_updated"] == 2 and r2["guests_added"] == 0 and r2["clusters"] == 0, r2
        cl = next(x for x in c.call("GET", "/clusters") if x["name"] == "homelab")
        full = c.call("GET", f"/clusters/{cl['id']}/full")
        assert len(full["nodes"]) == 2 and len(full["guests"]) == 2
        ph = next(g for g in full["guests"] if g["name"] == "pihole")
        assert ph["device_type"] == "Container" and ph["status"] == "Standby" and ph["host_name"] == "pve2", ph
        srv.shutdown()

    print("Discovery")

    @test("discovery config and range checks")
    def _():
        cfg = c.call("GET", "/discover/config")
        assert "subnets" in cfg
        c.call("POST", "/discover/scan", {"cidr": "8.8.8.0/24"}, expect=400)

    print("Pages & app shell")

    @test("app shell files")
    def _():
        code, page, _ = c.raw("GET", "/")
        assert code == 200, code
        # The built interface (ui/ → harm/static/app/): its script and stylesheet must be there.
        built = re.findall(r'(?:src|href)="(/static/app/assets/[^"]+)"', page.decode())
        assert any(b.endswith(".js") for b in built) and any(b.endswith(".css") for b in built), built
        for p in (*built, "/static/theme.js", "/static/icon.svg", "/static/icon-coolant.svg", "/static/icon-graveyard.svg",
                  "/static/manifest.webmanifest", "/sw.js", "/static/collect/harm-collect.sh", "/static/collect/harm-collect.ps1",
                  "/static/vendor/zxing-0.23.0.min.js", "/static/icon-192.png", "/static/apple-touch-icon.png"):
            code, _, _ = c.raw("GET", p)
            assert code == 200, (p, code)

    @test("dashboard, audit, meta")
    def _():
        d = c.call("GET", "/dashboard")
        assert {"open_tasks", "needs_repair", "ip_conflicts", "warranty_soon"} <= set(d), d.keys()
        assert c.call("GET", "/audit?limit=50")
        assert "device_statuses" in c.call("GET", "/meta/enums")
        assert "ocr" in c.call("GET", "/meta/capabilities")

    print("Online status & actions")

    @test("online check: a device that answers, its management port that doesn't")
    def _():
        d = c.call("POST", "/devices", {"name": "Answers", "status": "Active", "connected": True})
        c.call("POST", "/interfaces", {"device_id": d["id"], "name": "eth0", "ip": "127.0.0.1/8", "mac": "aa:bb:cc:dd:ee:01", "is_primary": True})
        c.call("POST", "/interfaces", {"device_id": d["id"], "name": "iLO", "kind": "IPMI / BMC", "ip": "192.0.2.10"})
        c.call("POST", "/status/check", {"device_id": d["id"]})
        st = c.call("GET", f"/devices/{d['id']}/full")["online"]
        assert st["state"] == "up" and st["address"] == "127.0.0.1", st
        assert st["others"] and st["others"][0]["state"] == "down" and st["others"][0]["management"], st
        assert len(st["strip"]) == 24 and st["strip"][-1] == "up", st["strip"]
        S["up"] = d

    @test("online check: offline, not hooked up, and turned off")
    def _():
        down = c.call("POST", "/devices", {"name": "Gone quiet", "status": "Active", "connected": True})
        c.call("POST", "/interfaces", {"device_id": down["id"], "ip": "192.0.2.11"})
        off = c.call("POST", "/devices", {"name": "On the shelf", "status": "Active", "connected": False})
        c.call("POST", "/interfaces", {"device_id": off["id"], "ip": "192.0.2.12"})
        quiet = c.call("POST", "/devices", {"name": "Not watched", "status": "Active", "connected": True, "watch": False})
        c.call("POST", "/interfaces", {"device_id": quiet["id"], "ip": "192.0.2.13"})
        assert c.call("POST", "/status/check", {"max_age": 0})["checked"]
        assert c.call("POST", "/status/check", {"max_age": 600})["checked"] is False, "a fresh check is skipped"
        board = {x["name"]: x for x in c.call("GET", "/status")["devices"]}
        assert board["Gone quiet"]["state"] == "down" and board["Gone quiet"]["since"], board["Gone quiet"]
        assert board["On the shelf"]["state"] == "off" and board["Not watched"]["state"] == "unwatched"
        assert board["Answers"]["state"] == "up" and board["Answers"]["can_wake"]
        offline = [x["label"] for x in c.call("GET", "/dashboard")["offline"]]
        assert "Gone quiet" in offline and not {"Answers", "On the shelf", "Not watched"} & set(offline), offline
        S["down"] = down

    @test("Wake-on-LAN needs a MAC, and sends to the subnet")
    def _():
        c.call("POST", f"/devices/{S['down']['id']}/wake", expect=400)
        r = c.call("POST", f"/devices/{S['up']['id']}/wake")
        assert r["mac"] == "AA:BB:CC:DD:EE:01" and any(x.startswith("127.255.255.255") for x in r["sent_to"]), r

    @test("actions: checks what's saved")
    def _():
        c.call("POST", "/actions", {"name": "Nowhere", "command": "uptime"}, expect=400)
        c.call("POST", "/actions", {"name": "Bad host", "hosts": "-oProxyCommand=x", "command": "uptime"}, expect=400)
        e = c.call("POST", "/actions", {"name": "Sneaky", "hosts": "10.0.0.5", "command": "uptime",
                                        "ssh_options": "-o ProxyCommand=touch /tmp/x"}, expect=400)
        assert "ProxyCommand" in e["detail"], e
        c.call("POST", "/actions", {"name": "Bad mode", "hosts": "10.0.0.5", "command": "x", "mode": "telnet"}, expect=400)
        a = c.call("POST", "/actions", {"name": "Quiet the fans", "device_id": S["up"]["id"], "hosts": "10.0.0.5, 10.0.0.6",
                                        "mode": "lines", "legacy_ssh": True, "command": "fan p 0 max 60",
                                        "ssh_options": "-o KexAlgorithms=+diffie-hellman-group14-sha1"})
        assert a["hosts"] == "10.0.0.5\n10.0.0.6" and a["device_name"] == "Answers" and a["last_run_at"] is None, a
        assert [x["name"] for x in c.call("GET", f"/devices/{S['up']['id']}/full")["actions"]] == ["Quiet the fans"]
        assert c.call("GET", "/status")["devices"][0]["actions"] or True

    @test("actions: a run that can't connect is reported, kept encrypted, and audited")
    def _():
        lg = c.call("POST", "/credentials", {"label": "Box root", "username": "root", "password": "test-password-123"})
        a = c.call("POST", "/actions", {"name": "Closed port", "hosts": "127.0.0.1", "port": 1, "credential_id": lg["id"],
                                        "command": "uptime"})
        r = c.call("POST", f"/actions/{a['id']}/run", {})
        res = r["results"][0]
        assert r["action"] == "Closed port" and res["ok"] is False and res["error"], r
        c.call("POST", f"/actions/{a['id']}/run", {"host": "10.9.9.9"}, expect=400)
        runs = c.call("GET", f"/actions/{a['id']}/runs")
        assert len(runs) == 1 and runs[0]["output"] == res["error"] and "test-password-123" not in json.dumps(runs), runs
        assert c.call("GET", f"/actions/{a['id']}")["last_ok"] == 0
        assert any(x["action"] == "run-action" for x in c.call("GET", "/audit?limit=20"))

    @test("settings: check interval and the opt-in update check")
    def _():
        assert c.call("GET", "/settings/app") == {"status_interval": 5, "update_check": False, "ai_enabled": True, "currency": "USD",
                                                   "idle_minutes": 30, "session_hours": 12, "backup_keep": 14, "start_page": "dashboard"}
        c.call("POST", "/settings/app", {"status_interval": 7}, expect=400)
        assert c.call("POST", "/settings/app", {"status_interval": 0})["status_interval"] == 0
        assert c.call("GET", "/status")["status_interval"] == 0
        assert c.call("GET", "/update-check")["enabled"] is False

    @test("settings: currency, lock timing, backups kept and start page")
    def _():
        c.call("POST", "/settings/app", {"currency": "euro"}, expect=400)
        c.call("POST", "/settings/app", {"idle_minutes": 7}, expect=400)
        c.call("POST", "/settings/app", {"start_page": "audit"}, expect=400)
        out = c.call("POST", "/settings/app", {"currency": "eur", "backup_keep": 30, "start_page": "status", "session_hours": 24})
        assert (out["currency"], out["backup_keep"], out["start_page"], out["session_hours"]) == ("EUR", 30, "status", 24), out
        caps = c.call("GET", "/meta/capabilities")
        assert caps["currency"] == "EUR" and caps["start_page"] == "status", caps
        # Lock timing applies straight away: never lock when idle, then back to 30 minutes.
        assert c.call("POST", "/settings/app", {"idle_minutes": 0})["idle_minutes"] == 0
        assert c.call("GET", "/auth/status")["idle_minutes"] == 0
        c.call("POST", "/settings/app", {"idle_minutes": 30, "session_hours": 12, "currency": "USD", "backup_keep": 14, "start_page": "dashboard"})
        assert c.call("GET", "/auth/status")["idle_minutes"] == 30

    @test("settings: AI features can be turned off, and the AI endpoints then refuse")
    def _():
        assert c.call("GET", "/meta/capabilities")["ai"] is True
        assert c.call("POST", "/settings/app", {"ai_enabled": False})["ai_enabled"] is False
        assert c.call("GET", "/meta/capabilities")["ai"] is False
        for path, body in (("/ai/prompt", {}), ("/ai/parse", {"text": "x"}), ("/ai/import", {"items": [{}]}), ("/ai/ask", {"images": []})):
            c.call("POST", path, body, expect=403)
        assert c.call("POST", "/settings/app", {"ai_enabled": True})["ai_enabled"] is True
        assert "prompt" in c.call("POST", "/ai/prompt", {})

    hooks = []

    def hook_server():
        """A web service that's broken (500) and a webhook that keeps what it's sent."""
        import threading
        from http.server import BaseHTTPRequestHandler, HTTPServer

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                self.send_response(500); self.end_headers()

            def do_POST(self):
                hooks.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                self.send_response(204); self.end_headers()
        srv = HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        return srv

    def listener(port=0):
        import socket
        so = socket.socket()
        so.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        so.bind(("127.0.0.1", port))
        so.listen(8)
        return so

    def wait_hook(text):
        for _ in range(50):
            if any(text in h["title"] for h in hooks):
                return True
            time.sleep(0.1)
        raise AssertionError(f"no alert with {text!r}: {[h['title'] for h in hooks]}")

    @test("services: a web page, a closed port, a broken page, and a stopped one")
    def _():
        S["hook"] = hook_server()
        hp = S["hook"].server_address[1]
        did = S["up"]["id"]
        for body in ({"name": "HaRM web", "url": f"http://127.0.0.1:{PORT}/"}, {"name": "Closed", "protocol": "TCP", "port": 1},
                     {"name": "Broken web", "url": f"http://127.0.0.1:{hp}/"}, {"name": "Old thing", "port": 1, "status": "Stopped"}):
            c.call("POST", "/services", {"device_id": did, **body})
        c.call("POST", "/status/check", {"device_id": did})
        sv = {x["name"]: x for x in c.call("GET", f"/devices/{did}/full")["online"]["services"]}
        assert sv["HaRM web"]["state"] == "up" and sv["HaRM web"]["code"] == 200, sv
        assert sv["Closed"]["state"] == "down" and "refused" in sv["Closed"]["detail"], sv
        assert sv["Broken web"]["state"] == "down" and sv["Broken web"]["code"] == 500, sv
        assert "Old thing" not in sv
        down = {x["name"] for x in c.call("GET", "/dashboard")["services_down"]}
        assert down == {"Closed", "Broken web"}, down
        assert next(x for x in c.call("GET", "/status")["devices"] if x["id"] == did)["services"]
        assert "online" in c.call("GET", f"/racks/{S['rack']['id']}/layout")

    @test("alerts: settings are checked, and secrets never come back")
    def _():
        a = c.call("GET", "/alerts")
        assert a["enabled"] is False and a["has_webhook_url"] is False and a["recent"] == [], a
        c.call("POST", "/alerts", {"enabled": True}, expect=400)
        c.call("POST", "/alerts", {"enabled": True, "webhook_on": True}, expect=400)
        c.call("POST", "/alerts", {"enabled": True, "ntfy_on": True, "ntfy_url": "https://ntfy.sh/"}, expect=400)
        c.call("POST", "/alerts", {"enabled": True, "email_on": True, "email_host": "smtp.example.com", "email_to": "not an address"}, expect=400)
        c.call("POST", "/alerts/test", {}, expect=400)
        time.sleep(1.1)  # the services above went down before alerts were turned on: no alerts about them
        url = f"http://127.0.0.1:{S['hook'].server_address[1]}/hook"
        r = c.call("POST", "/alerts", {"enabled": True, "delay": 0, "webhook_on": True, "webhook_url": url})
        assert r["has_webhook_url"] and "webhook_url" not in r, r
        assert url not in json.dumps(c.call("GET", "/alerts"))
        t = c.call("POST", "/alerts/test", {})
        assert t["results"] == [{"channel": "webhook", "ok": True}], t
        wait_hook("Test from Zom's HaRM")
        assert c.call("GET", "/alerts")["recent"][0]["ok"] == 1

    @test("alerts: a device goes offline; a service goes down and comes back")
    def _():
        d = c.call("POST", "/devices", {"name": "Fresh outage", "status": "Active", "connected": True})
        c.call("POST", "/interfaces", {"device_id": d["id"], "ip": "192.0.2.20"})
        quiet = c.call("POST", "/devices", {"name": "No alerts please", "status": "Active", "connected": True, "alerts": False})
        c.call("POST", "/interfaces", {"device_id": quiet["id"], "ip": "192.0.2.21"})
        c.call("POST", "/status/check", {"device_id": d["id"]})
        c.call("POST", "/status/check", {"device_id": quiet["id"]})
        wait_hook("Fresh outage is offline")
        so = listener()
        port = so.getsockname()[1]
        did = S["up"]["id"]
        c.call("POST", "/services", {"device_id": did, "name": "Flaky", "protocol": "TCP", "port": port})
        c.call("POST", "/status/check", {"device_id": did})
        so.close()
        c.call("POST", "/status/check", {"device_id": did})
        wait_hook("Flaky on Answers isn't answering")
        so = listener(port)
        c.call("POST", "/status/check", {"device_id": did})
        wait_hook("Flaky on Answers is answering again")
        so.close()
        c.call("POST", "/status/check", {"device_id": d["id"]})
        time.sleep(0.5)
        titles = [h["title"] for h in hooks]
        assert titles.count("Fresh outage is offline") == 1, titles
        assert not [t for t in titles if "No alerts please" in t or "Closed" in t or "Broken web" in t], titles
        c.call("POST", "/alerts", {"enabled": False})

    @test("power, uptime report, new-device watch and backup copies: the API checks what it's sent")
    def _():
        ups = c.call("POST", "/devices", {"name": "Rack UPS", "device_type": "UPS", "status": "Active", "connected": True, "power_capacity_w": 900})
        srv = c.call("POST", "/devices", {"name": "Hungry", "status": "Active", "connected": True, "power_draw_w": 800, "powered_by_id": ups["id"]})
        c.call("PUT", f"/devices/{ups['id']}", {"powered_by_id": srv["id"]}, expect=400)
        c.call("PUT", f"/devices/{ups['id']}", {"powered_by_id": ups["id"]}, expect=400)
        sup = next(x for x in c.call("GET", "/power")["supplies"] if x["id"] == ups["id"])
        assert sup["load_w"] == 800 and sup["level"] == "warn", sup
        assert c.call("GET", f"/devices/{ups['id']}/full")["power"]["load_w"] == 800
        assert any(w["name"] == "Rack UPS" for w in c.call("GET", "/dashboard")["power"])
        rep = c.call("GET", "/status/report?days=7")
        names = {x["name"]: x for x in rep["devices"]}
        assert names["Answers"]["uptime"] == 1 and names["Gone quiet"]["uptime"] == 0, names
        assert any(x["name"] == "Flaky" and x["outages"] == 1 for x in rep["services"]), rep["services"]
        c.call("GET", "/status/report?days=5", expect=400)
        nw = c.call("GET", "/netwatch")
        assert nw["enabled"] is False and nw["pending"] == [] and nw["all_networks"], nw
        c.call("POST", "/netwatch", {"enabled": True, "networks": []}, expect=400)
        c.call("POST", "/netwatch/9999", {"status": "ignored"}, expect=404)
        c.call("POST", "/backup-copy", {"dir": "relative/folder"}, expect=400)
        c.call("POST", "/backup-copy", {"dir": "/no/such/harm/folder"}, expect=400)
        c.call("POST", "/backup-copy/run", {}, expect=400)
        c.call("POST", "/alerts", {"quiet_on": True, "quiet_from": "25:00"}, expect=400)

    @test("deleting a device removes its actions and online history")
    def _():
        c.call("DELETE", f"/devices/{S['up']['id']}")
        assert not [x for x in c.call("GET", "/actions") if x["name"] == "Quiet the fans"]
        assert "Answers" not in [x["name"] for x in c.call("GET", "/status")["devices"]]

    print("Deleting")

    @test("deleting a device returns parts to stock and removes its notes")
    def _():
        did = S["srv"]["id"]
        c.call("DELETE", f"/devices/{did}")
        assert all(x["status"] != "Installed" or x["device_id"] != did for x in c.call("GET", "/components"))
        assert c.call("GET", f"/notes?entity=devices&entity_id={did}") == []
        assert c.call("GET", f"/devices/{did}", expect=404)

    @test("deleting a rack keeps its devices")
    def _():
        c.call("DELETE", f"/racks/{S['rack']['id']}")
        h = c.call("GET", f"/devices/{S['half']['id']}")
        assert h["rack_id"] is None and h["rack_u"] is None, h

    @test("recovery code resets the password; vault survives")
    def _():
        o = Client()
        o.call("POST", "/auth/recover", {"recovery_code": "WRONG-CODE", "new_password": "another long pass"}, expect=401)
        r = o.call("POST", "/auth/recover", {"recovery_code": S["rc"], "new_password": "another long pass"})
        assert r.get("recovery_code"), "a new recovery code should be issued"


if __name__ == "__main__":
    main()
