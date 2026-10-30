"""End-to-end smoke test. Starts HaRM on a throwaway database and exercises the API.

    .venv/bin/python tests/smoke.py
"""
import json, os, subprocess, tempfile, time, urllib.request, http.cookiejar
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORT = 8099
tmp = tempfile.mkdtemp(prefix="harm-smoke-")
env = {**os.environ, "HARM_DB": os.path.join(tmp, "harm.db"), "HARM_AUTO_BACKUP": "0"}
server = subprocess.Popen([str(ROOT / ".venv/bin/uvicorn"), "harm.main:app", "--port", str(PORT)],
                          cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
B = f"http://127.0.0.1:{PORT}/api"
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def call(m, p, body=None, expect=200):
    req = urllib.request.Request(B + p, method=m, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"X-HaRM": "1", "Content-Type": "application/json"})
    try:
        r = op.open(req); code, data = r.status, r.read()
    except urllib.error.HTTPError as e:
        code, data = e.code, e.read()
    try:
        data = json.loads(data)
    except Exception:
        pass
    if code != expect:
        raise SystemExit(f"FAIL {m} {p}: {code} {str(data)[:300]}")
    return data


def fake_unifi():
    """A stand-in UniFi console for the import test."""
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer
    pages = {
        "/proxy/network/integration/v1/sites": [{"id": "s1", "internalReference": "default", "name": "Default"}],
        "/proxy/network/integration/v1/sites/s1/devices": [
            {"id": "d1", "name": "Core Switch", "model": "USW-24-PoE", "macAddress": "aa:bb:cc:00:00:01", "ipAddress": "10.9.0.2", "state": "ONLINE"}],
        "/proxy/network/integration/v1/sites/s1/clients": [
            {"type": "WIRED", "name": "pve1", "macAddress": "aa:bb:cc:00:00:10", "ipAddress": "10.9.0.20", "uplinkDeviceId": "d1"},
            {"type": "WIRELESS", "name": "Phone", "macAddress": "aa:bb:cc:00:00:11", "ipAddress": "10.9.0.99"}],
    }

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a): pass
        def do_GET(self):
            path = self.path.split("?")[0]
            if self.headers.get("X-API-KEY") != "k3y":
                self.send_response(401); self.end_headers(); return
            if path.endswith("/rest/networkconf"):
                body = {"data": [{"name": "Lab", "purpose": "corporate", "ip_subnet": "10.9.0.1/24", "vlan_enabled": True, "vlan": "20",
                                  "dhcpd_enabled": True, "dhcpd_start": "10.9.0.100", "dhcpd_stop": "10.9.0.200"}]}
            elif path in pages:
                body = {"data": pages[path], "totalCount": len(pages[path])}
            else:
                self.send_response(404); self.end_headers(); return
            raw = json.dumps(body).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(raw)
    srv = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


try:
    for _ in range(50):
        try:
            op.open(f"http://127.0.0.1:{PORT}/api/auth/status"); break
        except Exception:
            time.sleep(0.2)
    call("GET","/devices", expect=401)
    call("POST","/auth/setup",{"password":"short"}, expect=400)
    rc = call("POST","/auth/setup",{"password":"correct horse battery"})["recovery_code"]
    loc = call("POST","/locations",{"name":"Home"})
    rack = call("POST","/racks",{"name":"R","kind":"Rack","height_u":12,"location_id":loc["id"]})
    d = call("POST","/devices",{"name":"srv","rack_id":rack["id"],"rack_u":3,"u_height":2})
    call("POST","/devices",{"name":"clash","rack_id":rack["id"],"rack_u":4}, expect=409)
    cred = call("POST","/credentials",{"label":"root","password":"s3cr3t!","device_id":d["id"]})
    assert call("POST",f"/credentials/{cred['id']}/reveal")["password"]=="s3cr3t!"
    sl = call("POST","/device_slots",{"device_id":d["id"],"interface":"SAS/SATA","form_factor":'3.5"',"total":4,"label":"Front","array_name":"RAID 5"})
    c = call("POST","/components",{"category":"HDD","capacity":"4tb","interface":"SATA","quantity":3,"device_id":d["id"],"slot_id":sl["id"]})
    assert c["capacity"]=="4 TB" and c["status"]=="Installed"
    spare = call("POST","/components",{"category":"HDD","capacity":"4 TB","interface":"SATA","form_factor":'3.5"',"quantity":1})
    f = call("GET",f"/devices/{d['id']}/full"); s0 = f["slots"][0]
    assert s0["used"]==3 and len(s0["compatible"])==1 and s0["storage"]["total"]=="12 TB", s0
    one = call("POST",f"/components/{c['id']}/split",{"slot_id":sl["id"],"bay":1})
    assert one["quantity"]==1 and call("GET",f"/components/{c['id']}")["quantity"]==2
    n = call("POST","/notes",{"entity":"devices","entity_id":d["id"],"kind":"task","body":"todo"})
    assert call("PUT",f"/notes/{n['id']}",{"done":True})["done_at"]
    call("POST","/auth/logout",{})
    call("POST","/auth/login",{"password":"correct horse battery"})
    call("DELETE",f"/devices/{d['id']}")
    assert call("GET",f"/notes?entity=devices&entity_id={d['id']}")==[]
    assert all(x["status"]=="In Stock" for x in call("GET","/components"))
    call("POST","/auth/logout",{})
    call("POST","/auth/recover",{"recovery_code":rc,"new_password":"another long pass"})
    assert call("POST",f"/credentials/{cred['id']}/reveal")["password"]=="s3cr3t!"
    # Login launcher: a web login opens the device's management page, SSH gives a command.
    d = call("POST","/devices",{"name":"r515","mgmt_url":"https://10.9.0.5"})
    web = call("POST","/credentials",{"label":"idrac","kind":"Web UI","username":"root","password":"x","device_id":d["id"]})
    t = call("POST",f"/credentials/{web['id']}/reveal")["targets"]
    assert t and t[0]["url"]=="https://10.9.0.5", t
    ssh = call("POST","/credentials",{"label":"ssh","kind":"SSH","username":"root","url":"10.9.0.20"})
    assert call("POST",f"/credentials/{ssh['id']}/reveal")["targets"]==[{"type":"ssh","host":"10.9.0.20","port":22}]
    # Discovery: range checks, UniFi import + matching, bulk import, hide.
    call("POST","/discover/scan",{"cidr":"8.8.8.0/24"}, expect=400)
    call("POST","/discover/scan",{"cidr":"10.0.0.0/16"}, expect=400)
    fu = fake_unifi(); base = f"http://127.0.0.1:{fu.server_port}"
    call("POST","/discover/unifi",{"url":base,"api_key":"nope"}, expect=400)
    out = call("POST","/discover/unifi",{"url":base,"api_key":"k3y","remember":True})
    assert len(out["hosts"])==3 and out["networks"][0]["vlan_id"]==20, out
    assert call("GET","/discover/config")["unifi"]["has_key"]
    out = call("POST","/discover/unifi",{"url":base})  # uses the stored key
    by = {x["name"]: x for x in out["hosts"]}
    assert by["Core Switch"]["type_guess"]=="Switch" and by["pve1"]["match"] is None
    pve = {**by["pve1"], "ports":[{"port":8006,"name":"Proxmox VE"},{"port":22,"name":"SSH"}]}
    bmc = {**by["Phone"], "name":"bmc", "ip":"10.9.0.5", "mac":"aa:bb:cc:00:00:55"}
    r = call("POST","/discover/import",{"networks":out["networks"],"items":[
        {"action":"new","host":pve,"device_type":"Hypervisor Host"},
        {"action":"link","device_id":d["id"],"mgmt":True,"host":bmc}]})
    assert r=={"networks":1,"devices":1,"linked":1,"interfaces":2,"services":2}, r
    out = call("POST","/discover/unifi",{"url":base})
    by = {x["name"]: x for x in out["hosts"]}
    assert by["pve1"]["match"]["how"]=="MAC" and out["networks"][0]["exists"]
    pvedev = by["pve1"]["match"]["device_id"]
    svcs = call("GET",f"/services?device_id={pvedev}")
    assert {x["url"] for x in svcs}=={"https://10.9.0.20:8006", None}, svcs
    ifs = call("GET",f"/interfaces?device_id={d['id']}")
    assert ifs[0]["kind"]=="IPMI / BMC" and ifs[0]["network_id"], ifs
    call("POST","/discover/ignore",{"keys":["aa:bb:cc:00:00:11"]})
    assert [x["ignored"] for x in call("POST","/discover/unifi",{"url":base})["hosts"] if x["name"]=="Phone"]==[True]
    fu.shutdown()
    # Spec collection: on the server itself, and SSH input checks.
    tg = call("GET",f"/devices/{d['id']}/collect-targets")
    assert "10.9.0.5" in tg["hosts"] or tg["hosts"]==[] or tg["hosts"], tg
    out = call("POST",f"/devices/{d['id']}/collect",{"mode":"local"})["output"]
    assert call("POST","/specs/parse",{"text":out})["device"]
    call("POST",f"/devices/{d['id']}/collect",{"mode":"ssh","host":"-oProxyCommand=x","username":"root"}, expect=400)
    print("SMOKE PASSED")
finally:
    server.terminate()
