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
import time
import traceback
import urllib.request
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
        "  image) case \"$4\" in *version*) echo 1.40.0;; *) echo 'lscr.io/linuxserver/plex@sha256:111 ';; esac;;\n"
        "  buildx) case \"$5$6\" in *version*plex*) echo 'linux/arm64=1.41.9 linux/amd64=1.41.0 ';; *plex*) echo '\"sha256:222\"';; *) echo '';; esac;;\n"
        "  compose) exit 0;;\n"
        "esac\n")
    (fake / "docker").chmod(0o755)
    run = lambda script: subprocess.run(["sh", "-c", script], capture_output=True, text=True,
                                        env={**os.environ, "PATH": f"{fake}:{os.environ['PATH']}"}).stdout
    rows = docker.parse_list(run(docker.LIST_SCRIPT))
    assert [r["name"] for r in rows] == ["old-thing", "plex"], rows
    assert rows[1]["ports"] == ["32400→32400/tcp"] and rows[1]["health"] == "healthy", rows[1]
    ups, vers = docker.parse_check(run(docker.CHECK_SCRIPT))
    assert ups == {"lscr.io/linuxserver/plex:latest": "update", "nginx:1.25": "unknown"}, ups
    want = "1.41.9" if os.uname().machine == "aarch64" else "1.41.0"
    assert vers["lscr.io/linuxserver/plex:latest"] == {"now": "1.40.0", "new": want}, vers
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


def subprocess_ok(script: str) -> bool:
    import subprocess
    return subprocess.run(["sh", "-n", "-c", script]).returncode == 0


SAMPLE = """HARM_SEC=os
PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"
ID=debian
VERSION_ID="12"
KERNEL=6.1.0-25-amd64
HOST=nas
ROOT=0
HARM_SEC=uptime
864000.5 100.0
0.52 0.40 0.30 1/200 999
8
HARM_SEC=mem
MemTotal:       16000000 kB
MemAvailable:    8000000 kB
SwapTotal:             0 kB
SwapFree:              0 kB
HARM_SEC=df
Filesystem     Type  1B-blocks  Used Available Capacity Mounted on
/dev/sda2      ext4  100000 96000 4000 96% /
/dev/sdb1      xfs   42000000000000 21000000000000 21000000000000 50% /mnt/big array
/dev/sdb1      xfs   42000000000000 21000000000000 21000000000000 50% /srv/bind
HARM_SEC=reboot
NEEDED=packages
linux-image-6.1.0-26-amd64
HARM_SEC=updates
MANAGER=apt
REFRESHED=1
openssl/stable-security 3.0.15-1~deb12u1 amd64 [upgradable from: 3.0.14-1~deb12u2]
plexmediaserver/public 1.41.0.1 amd64 [upgradable from: 1.40.5.1]
HARM_SEC=disks
NAME="sda" SIZE="500107862016" ROTA="0" TYPE="disk" TRAN="sata" VENDOR="ATA     " MODEL="Samsung SSD 870" SERIAL="S1"
NAME="sdb" SIZE="42000000000000" ROTA="1" TYPE="disk" TRAN="" VENDOR="DELL" MODEL="PERC H730P Mini" SERIAL="VD0"
NAME="sdc" SIZE="4000787030016" ROTA="1" TYPE="disk" TRAN="sata" VENDOR="ATA" MODEL="WDC WD40EFRX" SERIAL="WD-1"
HARM_SEC=smart
HARM_DISK=sda
SMART overall-health self-assessment test result: PASSED
  9 Power_On_Hours          0x0032   095   095   000    Old_age   Always       -       21034
  5 Reallocated_Sector_Ct   0x0033   100   100   010    Pre-fail  Always       -       0
HARM_DISK=sdb
Product:              PERC H730P Mini
HARM_DISK=sdc
SMART overall-health self-assessment test result: FAILED!
  5 Reallocated_Sector_Ct   0x0033   100   100   010    Pre-fail  Always       -       12
HARM_SEC=zpool
tank	8000	4000	4000	DEGRADED
HARM_SEC=zsnap
tank/media	1700000000
HARM_SEC=md
md0 : active raid1 sdd1[0]
      1000 blocks super 1.2 [2/1] [U_]
HARM_SEC=folders
HARM_FOLDER=/mnt/backups
1700000000 2048 /mnt/backups/a.tar
"""


@test
def _():
    """machine check: disks, SMART, pools, RAID, updates, reboot, backups, labels and drive health"""
    from harm import machine, upkeep
    bk = machine.clean_backups([{"kind": "folder", "path": "/mnt/backups/", "hours": 24}, {"kind": "zfs", "path": "tank", "hours": 48}])
    assert bk[0]["path"] == "/mnt/backups"
    for bad in ({"kind": "folder", "path": "relative"}, {"kind": "zfs", "path": "tank; rm -rf /"}, {"kind": "folder", "path": "/x", "hours": 5}):
        try:
            machine.clean_backups([bad])
            raise AssertionError(f"accepted {bad}")
        except machine.MachineError:
            pass
    assert "'/mnt/my backups'" in machine.check_script([{"kind": "folder", "path": "/mnt/my backups", "hours": 24}])
    assert machine.check_script([], True).startswith("HARM_SU=1\n") and "HARM_SU" not in machine.check_script([]).split("\n")[0]
    snap = machine.parse(SAMPLE, bk)
    assert [v["mount"] for v in snap["volumes"]] == ["/", "/mnt/big array"], snap["volumes"]  # the bind mount once
    assert snap["updates"]["count"] == 2 and snap["updates"]["security"] == 1 and snap["updates"]["packages"][0]["name"] == "openssl"
    assert snap["reboot"]["needed"] and snap["disks"][0]["model"] == "Samsung SSD 870"
    assert snap["disks"][1]["virtual"] and snap["disks"][1]["smart"]["note"] == "virtual drive"
    assert snap["disks"][0]["smart"]["hours"] == 21034 and snap["disks"][2]["smart"]["health"] == "failing"
    assert snap["md"][0]["degraded"] and snap["pools"][0]["health"] == "DEGRADED"
    assert machine.drive_health(snap["disks"][0]) == "SMART OK, 21k hours"
    texts = " | ".join(p["text"] for p in machine.problems(snap))
    for want in ("/ is 96% full", "failing (SMART)", "ZFS pool tank is DEGRADED", "md0 is degraded", "1 security update",
                 "Needs a restart", "Backup /mnt/backups: the newest is", "Backup tank: the newest is"):
        assert want in texts, (want, texts)
    labels = {"vol:/": {"ignore": True}, "disk:WD-1": {"name": "Bay 3"}}
    texts = " | ".join(p["text"] for p in machine.problems(snap, labels))
    assert "/ is 96%" not in texts and "Bay 3: the drive reports" in texts, texts

    # Stored through upkeep: SMART goes into the matching part's Health, and an alert goes out once.
    did = sql("INSERT INTO devices (name, alerts) VALUES ('nas3', 1)")
    part = sql("INSERT INTO components (category, serial, device_id, status, quantity) VALUES ('Drive', 's1', ?, 'Installed', 1)", did)
    conn = db.connect()
    try:
        db.set_meta(conn, "alerts", '{"enabled": true}')
        upkeep.save(conn, f"machine_backups:{did}", bk)
        upkeep.store(conn, did, SAMPLE)
        assert conn.execute("SELECT health FROM components WHERE id = ?", (part,)).fetchone()[0] == "SMART OK, 21k hours"
        ev = upkeep.track(conn, did)
        assert ev and all(e["state"] == "down" for e in ev) and any("DEGRADED" in e["title"] for e in ev), ev
        assert upkeep.track(conn, did) == [], "alerted twice"
        upkeep.save(conn, f"machine:{did}", {**upkeep.load(conn, f"machine:{did}"), "pools": []})
        assert [e["state"] for e in upkeep.track(conn, did)] == ["up"]
        # Containers: one that was running and stopped, with its log in the alert.
        upkeep.save(conn, f"docker:{did}", {"containers": [{"name": "web", "state": "exited", "restarts": 0}], "was_running": {"web": 0}})
        ev = upkeep.track(conn, did, {"web": "panic: out of memory"})
        assert len(ev) == 1 and "web stopped" in ev[0]["title"] and "out of memory" in ev[0]["message"], ev
        # The background login: sealed with its own key, readable back, gone when turned off.
        upkeep.bg_set(conn, did, "harm-ro", "pw-123", "read-only (harm-ro)", "limited")
        assert upkeep.bg_get(conn, did) == {"user": "harm-ro", "pw": "pw-123", "sudo": "limited"} and "pw-123" not in (db.get_meta(conn, "bg_logins") or "")
        upkeep.bg_forget(conn, did)
        assert upkeep.bg_get(conn, did) is None
    finally:
        conn.close()
    for sc in (machine.CHECK_SCRIPT, machine.UPGRADE_SCRIPT, machine.REBOOT_SCRIPT, upkeep.script(bk, True)):
        assert subprocess_ok(sc), sc[:80]


@test
def _():
    """pinned certificates: the first one is remembered, a different one is refused before the token goes out"""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID
    from harm import tlspin

    def server(cn):
        key = ec.generate_private_key(ec.SECP256R1())
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)])
        cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(1)
                .not_valid_before(datetime.now(timezone.utc) - timedelta(days=1)).not_valid_after(datetime.now(timezone.utc) + timedelta(days=9))
                .sign(key, hashes.SHA256()))
        pem = Path(TMP) / f"{cn}.pem"
        pem.write_bytes(cert.public_bytes(serialization.Encoding.PEM)
                        + key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(pem)
        srv = socket.socket()
        srv.bind(("127.0.0.1", 0))
        srv.listen(4)
        got = []

        def serve():
            for _ in range(2):
                c, _a = srv.accept()
                try:
                    with ctx.wrap_socket(c, server_side=True) as t:
                        got.append(t.recv(4096))
                        t.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{"data": 1}')
                except (OSError, ssl.SSLError):
                    pass
        threading.Thread(target=serve, daemon=True).start()
        return f"https://127.0.0.1:{srv.getsockname()[1]}", got

    url, _ = server("pve-a")
    op, seen = tlspin.opener(False, None)
    op.open(urllib.request.Request(url + "/x"), timeout=5).read()
    pin = seen["fp"]
    assert len(pin) == 64
    url2, got = server("impostor")
    op2, _ = tlspin.opener(False, pin)
    try:
        op2.open(urllib.request.Request(url2 + "/x", headers={"Authorization": "PVEAPIToken=secret"}), timeout=5)
        raise AssertionError("a different certificate was accepted")
    except tlspin.PinMismatch:
        pass
    time.sleep(0.2)
    assert not any(b"secret" in g for g in got), "the token was sent to the impostor"


@test
def _():
    """terminal: typing reaches the program, output comes back in order, resizing works, closing ends it"""
    from harm import terminal
    if os.name == "nt":
        return
    t = terminal.Session("me", "test", ["sh"], {"PATH": os.environ["PATH"], "PS1": "$ "}, 100, 30)
    t.write("stty size; echo HARM_$((40+2))\n")
    out, seen, ended = "", 0, None
    for _ in range(50):
        chunks, ended = t.since(seen, 0.2)
        for seq, text in chunks:
            seen, out = seq, out + text
        if "HARM_42" in out.split("echo", 1)[-1]:
            break
    assert "30 100" in out and "HARM_42" in out, out
    t.resize(120, 40)
    t.write("stty size\n")
    for _ in range(50):
        chunks, ended = t.since(seen, 0.2)
        for seq, text in chunks:
            seen, out = seq, out + text
        if "40 120" in out:
            break
    assert "40 120" in out, out
    try:
        terminal.get(t.id, "someone-else")
        raise AssertionError("another sign-in reached the terminal")
    except terminal.TerminalError:
        pass
    t.end("bye")
    assert t.since(seen, 0.1)[1] == "bye" and t.proc.wait(5) is not None
    try:
        t.write("x")
        raise AssertionError("wrote to a closed terminal")
    except terminal.TerminalError:
        pass


@test
def _():
    """logins: Bitwarden exports in and out, and the password-change script takes only the marked line"""
    import json as _json
    import subprocess
    from harm import vaultio
    export = {"encrypted": False, "folders": [{"id": "f1", "name": "Servers"}], "items": [
        {"type": 1, "name": "pve1 root", "folderId": "f1", "notes": "rack A",
         "login": {"username": "root", "password": "p@ss:word", "totp": "JBSWY3DPEHPK3PXP", "uris": [{"uri": "https://10.20.0.10:8006"}, {"uri": "ssh://10.20.0.10"}]},
         "fields": [{"name": "pin", "value": "1234", "type": 0}, {"name": "hidden", "value": "x", "type": 1}]},
        {"type": 2, "name": "a secure note"},
        {"type": 1, "name": "NAS admin", "login": {"username": "admin", "password": "y", "uris": []}}]}
    items = vaultio.parse_bitwarden(export)
    assert [i["label"] for i in items] == ["pve1 root", "NAS admin"] and items[0]["folder"] == "Servers"
    assert "pin: 1234" in items[0]["notes"] and "hidden" not in items[0]["notes"] and "Also: ssh://10.20.0.10" in items[0]["notes"]
    vaultio.match_devices(items, [{"id": 4, "name": "pve1", "hostname": "pve1.home.lan", "ips": "10.20.0.10, 10.30.0.10"},
                                  {"id": 7, "name": "nas", "hostname": None, "ips": ""}])
    assert items[0]["device"] == {"id": 4, "name": "pve1"} and items[1]["device"] == {"id": 7, "name": "nas"}, items
    for bad in ({"encrypted": True, "items": []}, {"hello": 1}, []):
        try:
            vaultio.parse_bitwarden(bad)
            raise AssertionError(f"read {bad}")
        except vaultio.VaultIOError:
            pass
    back = vaultio.parse_bitwarden(_json.loads(_json.dumps(vaultio.to_bitwarden([{"label": "x", "username": "u", "password": "p", "url": "https://h",
                                                                                     "totp_secret": "T", "secret_notes": "n", "device_name": "d"}]))))
    assert back[0]["password"] == "p" and back[0]["totp"] == "T" and "HaRM device: d" in back[0]["notes"], back

    fake = Path(TMP) / "pwbin"
    fake.mkdir(exist_ok=True)
    got = Path(TMP) / "chpasswd.txt"
    (fake / "chpasswd").write_text(f"#!/bin/sh\ncat > '{got}'\n")
    (fake / "id").write_text('#!/bin/sh\n[ "$1" = "-u" ] && echo 0 && exit 0\n[ "$1" = "admin" ]\n')
    for f in ("chpasswd", "id"):
        (fake / f).chmod(0o755)
    script = vaultio.change_script("admin")
    env = {**os.environ, "PATH": f"{fake}:{os.environ['PATH']}"}
    new = "n3w pass%s\\x$(id)"
    for stdin in ("old-sudo-password\n" + vaultio.change_input(new), vaultio.change_input(new)):  # sudo read its line, or didn't
        got.unlink(missing_ok=True)
        out = subprocess.run(["sh", "-c", script], input=stdin, capture_output=True, text=True, env=env).stdout
        assert vaultio.change_result(out) is None and got.read_text() == f"admin:{new}\n", (out, got.read_text())
    assert "old-sudo-password" not in got.read_text()
    out = subprocess.run(["sh", "-c", vaultio.change_script("nobody")], input=vaultio.change_input(new), capture_output=True, text=True, env=env).stdout
    assert vaultio.change_result(out) == "There's no such user on that machine", out
    for bad in ("root; reboot", "-x", ""):
        try:
            vaultio.change_script(bad)
            raise AssertionError(f"accepted {bad!r}")
        except vaultio.VaultIOError:
            pass
    assert vaultio.strong_enough("short") and vaultio.strong_enough("long enough but: colon") and not vaultio.strong_enough("a-good-long-password")
    assert vaultio.previous_note("old", "keep\nPrevious password (until 2020-01-01): older").splitlines()[0] == "keep"



@test
def _():
    """SSH key: a key ssh can read, encrypted at rest, and authorized_keys edited once and put back"""
    import subprocess
    from harm import crypto, sshkey
    priv, pub = sshkey.generate("zoms-harm@test")
    assert pub.startswith("ssh-ed25519 ") and pub.endswith(" zoms-harm@test")
    with sshkey.KeyFile(priv) as path:
        assert (os.stat(path).st_mode & 0o777) == 0o600
        if shutil.which("ssh-keygen"):  # ssh reads it, and it matches the public key
            got = subprocess.run(["ssh-keygen", "-y", "-f", path], capture_output=True, text=True).stdout.split()
            assert got[:2] == pub.split()[:2], got
    assert not Path(path).exists()
    conn = db.connect()
    dek = crypto.new_dek()
    sshkey.save(conn, dek, priv, pub)
    assert sshkey.public(conn) == pub and sshkey.private(conn, dek) == priv and sshkey.private(conn, None) is None
    assert priv not in (db.get_meta(conn, "ssh_key") or "") and sshkey.private(conn, crypto.new_dek()) is None
    sshkey.mark(conn, 7, "root", "10.0.0.5", 22, True)
    assert sshkey.has(conn, 7, "root", "10.0.0.5", 22) and not sshkey.has(conn, 7, "root", "10.0.0.5", 2222)
    new = crypto.new_dek()
    sshkey.rewrap(conn, dek, new)  # same key, so it's still on the same machines
    assert sshkey.private(conn, new) == priv and sshkey.has(conn, 7, "root", "10.0.0.5", 22)
    sshkey.mark(conn, 7, "root", "10.0.0.5", 22, False)
    assert sshkey.places(conn) == {}
    sshkey.mark(conn, 7, "root", "10.0.0.5", 22, True)
    sshkey.save(conn, new, *sshkey.generate("zoms-harm@test"))  # a new key isn't on any machine yet
    assert sshkey.places(conn) == {}
    sshkey.remove(conn)
    conn.close()
    home = Path(TMP) / "keyhome"
    home.mkdir()
    (home / ".ssh").mkdir()
    (home / ".ssh" / "authorized_keys").write_text("ssh-rsa AAAA other@laptop\n")
    run = lambda sc: subprocess.run(["sh", "-c", sc], capture_output=True, text=True, env={**os.environ, "HOME": str(home)}).stdout
    for _ in range(2):  # twice: still only one line
        assert "HARM_RESULT=added" in run(sshkey.install_script(pub))
    assert (home / ".ssh" / "authorized_keys").read_text() == f"ssh-rsa AAAA other@laptop\n{pub}\n"
    assert "HARM_RESULT=removed" in run(sshkey.remove_script(pub))
    assert (home / ".ssh" / "authorized_keys").read_text() == "ssh-rsa AAAA other@laptop\n"
    for bad in ("ssh-ed25519 AAAA x\nssh-rsa evil", "ssh-rsa AAAA x"):
        try:
            sshkey.install_script(bad)
            raise AssertionError("accepted a bad key")
        except ValueError:
            pass


failed = [r for r in results if r]
shutil.rmtree(TMP, ignore_errors=True)
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
