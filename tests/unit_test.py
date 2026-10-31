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

from harm import alerts, db, discover, main, monitor, netwatch, power  # noqa: E402

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


failed = [r for r in results if r]
shutil.rmtree(TMP, ignore_errors=True)
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
