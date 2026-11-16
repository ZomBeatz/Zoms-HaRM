"""Unit tests for the parts that are hard to reach over the API: the new-device watch (with a
stand-in network scan), uptime arithmetic, quiet hours, power loads, backup copies and reading a
certificate's end date. Uses a throwaway database.

    .venv/bin/python tests/unit_test.py
"""
import asyncio
import os
import shutil
import socket
import ssl
import sys
import tempfile
import threading
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TMP = tempfile.mkdtemp(prefix="harm-unit-")
os.environ.update(HARM_DB=os.path.join(TMP, "harm.db"), HARM_AUTO_BACKUP="0", HARM_MONITOR="0")
sys.path.insert(0, str(ROOT))

from harm import alerts, db, discover, docker, main, monitor, netwatch, power  # noqa: E402

db.init()
results = []


def test(fn):
    try:
        fn()
        results.append(None)
        print(f"  ✓ {fn.__doc__}")
    except Exception as e:  # noqa: BLE001
        results.append(e)
        print(f"  ✗ {fn.__doc__}: {e}")
        traceback.print_exc()
    return fn


def sql(q, *a):
    conn = db.connect()
    try:
        cur = conn.execute(q, a)
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


@test
def _():
    """uptime: up, down and unknown time, outages and the longest one"""
    now = datetime(2026, 1, 2, tzinfo=timezone.utc)
    start = now - timedelta(days=1)
    ts = lambda h: (start + timedelta(hours=h)).strftime("%Y-%m-%d %H:%M:%S")
    u = monitor._uptime([("down", ts(2)), ("up", ts(3)), ("down", ts(10)), ("up", ts(13))], "up", start, now)
    assert u["outages"] == 2 and u["down_s"] == 4 * 3600 and u["longest_s"] == 3 * 3600, u
    assert abs(u["uptime"] - 20 / 24) < 1e-4, u
    u = monitor._uptime([("up", ts(12))], None, start, now)  # nothing known before noon
    assert u["uptime"] == 1 and u["known_s"] == 12 * 3600, u
    u = monitor._uptime([], "down", start, now)  # down the whole time, since before the window
    assert u["uptime"] == 0 and u["outages"] == 1, u


@test
def _():
    """quiet hours: an evening-to-morning window and a daytime one"""
    at = lambda hm: datetime(2026, 1, 1, *map(int, hm.split(":")))
    night = {"quiet_on": True, "quiet_from": "22:00", "quiet_to": "07:00"}
    assert alerts.in_quiet_hours(night, at("23:30")) and alerts.in_quiet_hours(night, at("03:00"))
    assert not alerts.in_quiet_hours(night, at("07:00")) and not alerts.in_quiet_hours(night, at("12:00"))
    day = {"quiet_on": True, "quiet_from": "09:00", "quiet_to": "17:00"}
    assert alerts.in_quiet_hours(day, at("12:00")) and not alerts.in_quiet_hours(day, at("20:00"))
    assert not alerts.in_quiet_hours({**night, "quiet_on": False}, at("23:30"))


@test
def _():
    """quiet hours: alerts are held, then sent together when they end"""
    sent = []
    real = alerts.send
    alerts.send = lambda title, message, urgent=True, extra=None, only=None: sent.append((title, message)) or []
    try:
        conn = db.connect()
        now = datetime.now().astimezone()
        db.set_meta(conn, "alerts", '{"enabled": true, "quiet_on": true, "quiet_from": "%s", "quiet_to": "%s"}' % (
            (now - timedelta(hours=1)).strftime("%H:%M"), (now + timedelta(hours=1)).strftime("%H:%M")))
        conn.commit()
        conn.close()
        alerts.deliver([{"state": "down", "title": "pve2 is offline", "message": "x"}])
        assert sent == [], sent
        alerts.flush_held()
        assert sent == [], "still quiet"
        conn = db.connect()
        db.set_meta(conn, "alerts", '{"enabled": true, "quiet_on": false}')
        conn.commit()
        conn.close()
        alerts.flush_held()
        assert len(sent) == 1 and "quiet hours" in sent[0][0] and "pve2 is offline" in sent[0][1], sent
        alerts.flush_held()
        assert len(sent) == 1, "sent once"
    finally:
        alerts.send = real


@test
def _():
    """power: a UPS's load includes what's plugged into its PDU; loops are refused"""
    ups = sql("INSERT INTO devices (name, device_type, status, connected, power_capacity_w) VALUES ('UPS', 'UPS', 'Active', 1, 1000)")
    pdu = sql("INSERT INTO devices (name, device_type, status, connected, powered_by_id) VALUES ('PDU', 'PDU', 'Active', 1, ?)", ups)
    rack = sql("INSERT INTO racks (name, kind, height_u, power_budget_w) VALUES ('R', 'Rack', 42, 700)")
    sql("INSERT INTO devices (name, status, connected, power_draw_w, powered_by_id, rack_id) VALUES ('big', 'Active', 1, 600, ?, ?)", pdu, rack)
    sql("INSERT INTO devices (name, status, connected, power_draw_w, powered_by_id) VALUES ('small', 'Active', 1, 250, ?)", ups)
    sql("INSERT INTO devices (name, status, connected, power_draw_w, powered_by_id) VALUES ('unplugged', 'Spare', 0, 500, ?)", ups)
    sql("INSERT INTO devices (name, status, connected, powered_by_id) VALUES ('unknown', 'Active', 1, ?)", pdu)
    conn = db.connect()
    try:
        s = power.summary(conn)
        u = next(x for x in s["supplies"] if x["name"] == "UPS")
        assert u["load_w"] == 850 and u["level"] == "warn" and u["without_draw"] == ["unknown"], u
        r = next(x for x in s["racks"] if x["name"] == "R")
        assert r["draw_w"] == 600 and r["level"] == "warn", r
        assert {w["name"] for w in power.warnings(conn)} == {"UPS", "R"}
        try:
            power.check_loop(conn, ups, pdu)
            raise AssertionError("a loop was allowed")
        except ValueError:
            pass
        power.check_loop(conn, None, pdu)
    finally:
        conn.close()


@test
def _():
    """new-device watch: the first scan learns, later ones list and alert what's new"""
    lan = sql("INSERT INTO networks (name, kind, cidr) VALUES ('Home LAN', 'LAN', '192.168.50.0/24')")
    guest = sql("INSERT INTO networks (name, kind, cidr) VALUES ('Guest Wi-Fi', 'Guest', '192.168.60.0/24')")
    d = sql("INSERT INTO devices (name, status, connected) VALUES ('nas', 'Active', 1)")
    sql("INSERT INTO interfaces (device_id, ip, mac) VALUES (?, '192.168.50.10', 'AA:BB:CC:00:00:10')", d)
    hosts = {"192.168.50.0/24": [{"ip": "192.168.50.10", "mac": "aa:bb:cc:00:00:10"}, {"ip": "192.168.50.20", "mac": None, "hostname": "printer"}],
             "192.168.60.0/24": [{"ip": "192.168.60.5", "mac": "aa:bb:cc:00:00:99"}]}
    scanned = []

    async def fake_scan(cidr, timeout=0.8):
        scanned.append(cidr)
        return {"cidr": cidr, "hosts": hosts[cidr]}
    sent = []
    real_scan, real_deliver = discover.scan, alerts.deliver
    discover.scan, alerts.deliver = fake_scan, lambda ev: sent.extend(ev)
    try:
        conn = db.connect()
        for bad in ({"enabled": True, "networks": []}, {"enabled": True, "networks": [9999]}, {"interval": 7}):
            try:
                netwatch.save(conn, bad)
                raise AssertionError(f"accepted {bad}")
            except ValueError:
                pass
        netwatch.save(conn, {"enabled": True, "networks": [lan], "interval": 15})
        conn.commit()
        conn.close()
        r = asyncio.run(netwatch.scan_now())
        assert r["baseline"] and r["new"] == [] and scanned == ["192.168.50.0/24"], (r, scanned)  # the guest Wi-Fi isn't scanned
        hosts["192.168.50.0/24"].append({"ip": "192.168.50.77", "mac": "aa:bb:cc:00:00:77", "hostname": "Sams-iPhone"})
        r = asyncio.run(netwatch.scan_now())
        assert [n["ip"] for n in r["new"]] == ["192.168.50.77"] and not r["baseline"], r
        assert sent and sent[0]["title"] == "New on Home LAN: Sams-iPhone", sent
        conn = db.connect()
        p = netwatch.pending(conn)
        assert [x["ip"] for x in p] == ["192.168.50.77"], p
        netwatch.mark(conn, p[0]["id"], "ignored")
        conn.commit()
        assert netwatch.pending(conn) == []
        conn.close()
        sent.clear()
        asyncio.run(netwatch.scan_now())
        assert sent == [], "an ignored device doesn't alert again"
        _ = guest
    finally:
        discover.scan, alerts.deliver = real_scan, real_deliver


@test
def _():
    """backup copies: copied to the second place, the oldest pruned, a missing folder reported"""
    target = Path(TMP) / "second-place"
    target.mkdir()
    for day in range(1, 10):
        (target / f"harm-202601{day:02d}.db").write_bytes(b"old")
    conn = db.connect()
    db.set_meta(conn, "backup_copy", '{"dir": "%s", "keep": 7}' % str(target).replace("\\", "\\\\"))
    conn.commit()
    conn.close()
    r = main.copy_backup()
    assert r["ok"], r
    copies = sorted(p.name for p in target.glob("harm-*.db"))
    assert len(copies) == 7 and copies[-1] == r["file"], copies
    shutil.rmtree(target)
    r = main.copy_backup()
    assert not r["ok"] and "connected" in r["error"], r


@test
def _():
    """certificates: the end date of a service's certificate, even a self-signed one"""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "test.local")])
    end = datetime.now(timezone.utc) + timedelta(days=10)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(1).not_valid_before(datetime.now(timezone.utc) - timedelta(days=1)).not_valid_after(end)
            .sign(key, hashes.SHA256()))
    pem = Path(TMP) / "c.pem"
    pem.write_bytes(cert.public_bytes(serialization.Encoding.PEM)
                    + key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(pem)
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(4)

    def serve():
        for _ in range(2):
            c, _a = srv.accept()
            try:
                with ctx.wrap_socket(c, server_side=True) as t:
                    t.recv(1024)
                    t.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            except (OSError, ssl.SSLError):
                pass
    threading.Thread(target=serve, daemon=True).start()
    url = f"https://127.0.0.1:{srv.getsockname()[1]}/"
    r = monitor._http_sync(url)
    assert r["state"] == "up" and r["cert_expires"] == end.strftime("%Y-%m-%d"), r


@test
def _():
    """certificates: one alert when one runs out within 14 days, not again for the same date"""
    d = sql("INSERT INTO devices (name, status, connected) VALUES ('nas2', 'Active', 1)")
    sv = sql("INSERT INTO services (device_id, name, url) VALUES (?, 'DSM', 'https://10.0.0.9:5001')", d)
    soon = (datetime.now(timezone.utc) + timedelta(days=9)).strftime("%Y-%m-%d")
    far = (datetime.now(timezone.utc) + timedelta(days=90)).strftime("%Y-%m-%d")
    sql("INSERT INTO service_status (service_id, device_id, state, checked_at, changed_at, cert_expires) VALUES (?, ?, 'up', '2026-01-01 00:00:00', '2026-01-01 00:00:00', ?)", sv, d, soon)
    conn = db.connect()
    try:
        db.set_meta(conn, "alerts", '{"enabled": true, "certs": true}')
        ev = [e for e in alerts.due(conn) if e["kind"] == "certificate"]
        assert len(ev) == 1 and "DSM on nas2 runs out soon" in ev[0]["title"], ev
        assert not [e for e in alerts.due(conn) if e["kind"] == "certificate"], "alerted twice"
        conn.execute("UPDATE service_status SET cert_expires = ? WHERE service_id = ?", (far, sv))  # renewed
        assert not [e for e in alerts.due(conn) if e["kind"] == "certificate"]
        assert [x["name"] for x in monitor.certs_expiring(conn, 30)] == [], "renewed: no warning on Home"
    finally:
        conn.close()


@test
def _():
    """docker: reading containers, update checks and the scripts sent (run against a stand-in docker)"""
    import json as _json
    import subprocess
    fake = Path(TMP) / "bin"
    fake.mkdir(exist_ok=True)
    stack = Path(TMP) / "media stack"  # a Compose folder with a space in its name
    stack.mkdir(exist_ok=True)
    plex = {"name": "/plex", "image": "lscr.io/linuxserver/plex:latest", "image_id": "sha256:aaa", "state": "running",
            "health": "healthy", "started": "2026-11-01T10:00:00Z", "restarts": 0, "project": "media", "service": "plex",
            "workdir": str(stack), "configs": str(stack / "compose.yml"),
            "ports": {"32400/tcp": [{"HostIp": "0.0.0.0", "HostPort": "32400"}], "1900/udp": None}}
    old = {**plex, "name": "/old-thing", "state": "exited", "health": None, "project": "", "service": "", "workdir": "",
           "configs": "", "image": "nginx:1.25", "ports": {}}
    log = Path(TMP) / "docker.log"
    (fake / "docker").write_text("#!/bin/sh\n"
        f"echo \"$@\" >> '{log}'\n"
        'case "$1" in\n'
        "  ps) [ \"$2\" = \"-aq\" ] && printf 'a\\nb\\n'; [ \"$2\" = \"-a\" ] && printf 'lscr.io/linuxserver/plex:latest\\nnginx:1.25\\n'; [ \"$2\" = \"-q\" ] && echo a;;\n"
        f"  inspect) [ \"$2\" = \"-f\" ] && echo sha256:aaa || printf '%s\\n%s\\n' '{_json.dumps(plex)}' '{_json.dumps(old)}';;\n"
        "  image) echo 'lscr.io/linuxserver/plex@sha256:111 ';;\n"
        "  buildx) case \"$6\" in *plex*) echo '\"sha256:222\"';; *) echo '';; esac;;\n"
        "  compose) exit 0;;\n"
        "esac\n")
    (fake / "docker").chmod(0o755)
    run = lambda script: subprocess.run(["sh", "-c", script], capture_output=True, text=True,
                                        env={**os.environ, "PATH": f"{fake}:{os.environ['PATH']}"}).stdout
    rows = docker.parse_list(run(docker.LIST_SCRIPT))
    assert [r["name"] for r in rows] == ["old-thing", "plex"], rows
    assert rows[1]["ports"] == ["32400→32400/tcp"] and rows[1]["health"] == "healthy", rows[1]
    ups = docker.parse_check(run(docker.CHECK_SCRIPT))
    assert ups == {"lscr.io/linuxserver/plex:latest": "update", "nginx:1.25": "unknown"}, ups
    out = run(docker.op_script(rows[1], "update"))
    assert "HARM_RESULT=same" in out and docker.op_result("update", out) == "Already up to date.", out
    sent = log.read_text()
    assert f"-p media -f {stack}/compose.yml pull plex" in sent and "up -d plex" in sent, sent  # quoted path arrived whole
    assert "pulled-only" in docker.op_script(rows[0], "update")  # not Compose: download only
    for bad in ("x; rm -rf /", "-v", "$(id)"):
        try:
            docker.op_script({**rows[1], "name": bad}, "restart")
            raise AssertionError(f"accepted {bad!r}")
        except docker.DockerError:
            pass
    try:
        docker.parse_list("HARM_NO_DOCKER")
        raise AssertionError("no error without docker")
    except docker.DockerError as e:
        assert "isn't installed" in str(e)
    for op in docker.OPS:
        assert subprocess.run(["sh", "-n", "-c", docker.op_script(rows[1], op)]).returncode == 0, op

    # The endpoints, with SSH stood in by this shell (and the stand-in docker).
    from starlette.requests import Request
    sent = []

    def fake_ssh(host, port, user, pw, mode, script, sudo=False, *a, **k):
        sent.append((host, user, sudo))
        p = subprocess.run(["sh", "-c", script], capture_output=True, text=True, env={**os.environ, "PATH": f"{fake}:{os.environ['PATH']}"})
        return {"ok": p.returncode == 0, "exit_code": p.returncode, "output": p.stdout + p.stderr, "ms": 1}

    def req(body):
        async def receive():
            return {"type": "http.request", "body": _json.dumps(body).encode()}
        return Request({"type": "http", "method": "POST", "path": "/", "headers": [], "client": ("127.0.0.1", 1), "query_string": b""}, receive)

    real, main.remote.run_action = main.remote.run_action, fake_ssh
    did = sql("INSERT INTO devices (name) VALUES ('dockerhost')")
    cid = sql("INSERT INTO credentials (label, username, device_id) VALUES ('ssh', 'admin', ?)", did)
    conn, sess = db.connect(), {"dek": b"0" * 32}
    try:
        r = asyncio.run(main.docker_read(did, req({"host": "10.0.0.9", "credential_id": cid, "sudo": True}), sess, conn))
        assert len(r["snap"]["containers"]) == 2 and sent[-1] == ("10.0.0.9", "admin", True), (r, sent)
        r = asyncio.run(main.docker_check(did, req({}), sess, conn))
        assert r["snap"]["updates"]["lscr.io/linuxserver/plex:latest"] == "update", r["snap"]
        assert main.docker_summary(conn, did) == {"at": r["snap"]["at"], "total": 2, "problems": ["old-thing"], "updates": ["plex"]}
        r = asyncio.run(main.docker_op(did, req({"name": "plex", "op": "update"}), sess, conn))
        assert r["ok"] and r["message"] == "Already up to date." and len(r["snap"]["containers"]) == 2, r
        r = asyncio.run(main.docker_op(did, req({"name": "plex", "op": "logs"}), sess, conn))
        assert r["ok"], r
        try:
            asyncio.run(main.docker_op(did, req({"name": "nope; reboot", "op": "restart"}), sess, conn))
            raise AssertionError("ran an operation on an unknown container")
        except main.HTTPException as e:
            assert e.status_code == 400
        assert [x["action"] for x in conn.execute("SELECT action FROM audit WHERE entity_id = ? AND entity = 'devices' ORDER BY id", (did,))][:2] == ["docker-read", "docker-update"]
    finally:
        main.remote.run_action = real
        conn.close()


failed = [r for r in results if r]
shutil.rmtree(TMP, ignore_errors=True)
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
