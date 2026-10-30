import os
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP_DATA_NAME = "com.zombeatz.zoms-harm"


def data_dir() -> Path:
    """Where HaRM keeps its database, certificates, backups and logs.

    HARM_DATA wins. The installed app (frozen by PyInstaller) uses the person's own data folder, so
    updating or reinstalling never touches it: %APPDATA%\\com.zombeatz.zoms-harm on Windows,
    ~/.local/share/com.zombeatz.zoms-harm on Linux. A copy run from source keeps data/ next to the code.
    """
    if os.environ.get("HARM_DATA"):
        return Path(os.environ["HARM_DATA"])
    if getattr(sys, "frozen", False):
        if os.name == "nt":
            base = Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming")
        else:
            base = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
        return base / APP_DATA_NAME
    return ROOT / "data"


DB_PATH = Path(os.environ.get("HARM_DB") or data_dir() / "harm.db")

SCHEMA_VERSION = 8  # highest key in MIGRATIONS

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS locations (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    kind       TEXT,
    parent_id  INTEGER REFERENCES locations(id) ON DELETE SET NULL,
    address    TEXT,
    notes      TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Anything that holds hardware: racks, cabinets, shelves, bins, drawers, desks...
CREATE TABLE IF NOT EXISTS racks (
    id             INTEGER PRIMARY KEY,
    name           TEXT NOT NULL,
    kind           TEXT NOT NULL DEFAULT 'Rack',
    location_id    INTEGER REFERENCES locations(id) ON DELETE SET NULL,
    height_u       INTEGER,
    numbering_desc INTEGER NOT NULL DEFAULT 0,  -- 1 = U1 at the top
    width          TEXT,
    depth_mm       INTEGER,
    manufacturer   TEXT,
    model          TEXT,
    notes          TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS devices (
    id             INTEGER PRIMARY KEY,
    name           TEXT NOT NULL,
    device_type    TEXT,
    manufacturer   TEXT,
    model          TEXT,
    serial         TEXT,
    asset_tag      TEXT,
    status         TEXT NOT NULL DEFAULT 'Active',
    connected      INTEGER NOT NULL DEFAULT 0,
    hostname       TEXT,
    os             TEXT,
    cpu            TEXT,
    ram            TEXT,
    storage        TEXT,
    psu            TEXT,
    power_draw_w   INTEGER,
    location_id    INTEGER REFERENCES locations(id) ON DELETE SET NULL,
    rack_id        INTEGER REFERENCES racks(id) ON DELETE SET NULL,
    rack_u         INTEGER,
    u_height       INTEGER NOT NULL DEFAULT 1,
    rack_face      TEXT NOT NULL DEFAULT 'front',
    full_depth     INTEGER NOT NULL DEFAULT 1,
    position       TEXT,
    mgmt_url       TEXT,
    purchase_date  TEXT,
    purchase_price REAL,
    vendor         TEXT,
    warranty_until TEXT,
    tags           TEXT,
    notes          TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Bays/slots/ports a device offers for components (e.g. 4x SATA 3.5" bays).
CREATE TABLE IF NOT EXISTS device_slots (
    id          INTEGER PRIMARY KEY,
    device_id   INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    interface   TEXT NOT NULL,
    form_factor TEXT,
    total       INTEGER NOT NULL DEFAULT 1,
    notes       TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS components (
    id             INTEGER PRIMARY KEY,
    category       TEXT NOT NULL,
    manufacturer   TEXT,
    model          TEXT,
    part_number    TEXT,
    serial         TEXT,
    capacity       TEXT,
    interface      TEXT,
    form_factor    TEXT,
    speed          TEXT,
    quantity       INTEGER NOT NULL DEFAULT 1,
    condition      TEXT,
    status         TEXT NOT NULL DEFAULT 'In Stock',
    device_id      INTEGER REFERENCES devices(id) ON DELETE SET NULL,
    location_id    INTEGER REFERENCES locations(id) ON DELETE SET NULL,
    rack_id        INTEGER REFERENCES racks(id) ON DELETE SET NULL,
    position       TEXT,
    health         TEXT,
    purchase_date  TEXT,
    purchase_price REAL,
    vendor         TEXT,
    warranty_until TEXT,
    tags           TEXT,
    notes          TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS interfaces (
    id         INTEGER PRIMARY KEY,
    device_id  INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    name       TEXT,
    kind       TEXT,
    mac        TEXT,
    ip         TEXT,
    subnet     TEXT,
    gateway    TEXT,
    vlan       TEXT,
    speed      TEXT,
    dhcp       INTEGER NOT NULL DEFAULT 0,
    dns_name   TEXT,
    notes      TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS services (
    id         INTEGER PRIMARY KEY,
    device_id  INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    protocol   TEXT,
    port       INTEGER,
    url        TEXT,
    version    TEXT,
    status     TEXT,
    notes      TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS credentials (
    id               INTEGER PRIMARY KEY,
    label            TEXT NOT NULL,
    kind             TEXT,
    username         TEXT,
    url              TEXT,
    device_id        INTEGER REFERENCES devices(id) ON DELETE SET NULL,
    service_id       INTEGER REFERENCES services(id) ON DELETE SET NULL,
    last_rotated     TEXT,
    password_enc     BLOB,
    secret_notes_enc BLOB,
    totp_secret_enc  BLOB,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Cables / links between devices (or to an untracked endpoint like "ISP").
CREATE TABLE IF NOT EXISTS connections (
    id          INTEGER PRIMARY KEY,
    a_device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    a_port      TEXT,
    b_device_id INTEGER REFERENCES devices(id) ON DELETE CASCADE,
    b_port      TEXT,
    b_endpoint  TEXT,
    medium      TEXT,
    cable_label TEXT,
    length      TEXT,
    color       TEXT,
    speed       TEXT,
    notes       TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit (
    id        INTEGER PRIMARY KEY,
    ts        TEXT NOT NULL DEFAULT (datetime('now')),
    action    TEXT NOT NULL,
    entity    TEXT,
    entity_id INTEGER,
    detail    TEXT,
    ip        TEXT
);

CREATE INDEX IF NOT EXISTS idx_devices_rack ON devices(rack_id);
CREATE INDEX IF NOT EXISTS idx_devices_location ON devices(location_id);
CREATE INDEX IF NOT EXISTS idx_components_device ON components(device_id);
CREATE INDEX IF NOT EXISTS idx_interfaces_device ON interfaces(device_id);
CREATE INDEX IF NOT EXISTS idx_services_device ON services(device_id);
CREATE INDEX IF NOT EXISTS idx_credentials_device ON credentials(device_id);
CREATE INDEX IF NOT EXISTS idx_slots_device ON device_slots(device_id);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts);
"""


# Incremental upgrades applied on top of SCHEMA (which is the v1 baseline).
MIGRATIONS: dict[int, list[str]] = {
    2: [
        """CREATE TABLE IF NOT EXISTS networks (
            id          INTEGER PRIMARY KEY,
            name        TEXT NOT NULL,
            kind        TEXT,
            vlan_id     INTEGER,
            cidr        TEXT,
            gateway     TEXT,
            ipv6_prefix TEXT,
            dhcp_start  TEXT,
            dhcp_end    TEXT,
            dns_servers TEXT,
            domain      TEXT,
            ssid        TEXT,
            location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
            notes       TEXT,
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        )""",
        "ALTER TABLE interfaces ADD COLUMN network_id INTEGER REFERENCES networks(id) ON DELETE SET NULL",
        "ALTER TABLE interfaces ADD COLUMN assignment TEXT",
        "ALTER TABLE interfaces ADD COLUMN ipv6 TEXT",
        "ALTER TABLE interfaces ADD COLUMN dns_servers TEXT",
        "ALTER TABLE interfaces ADD COLUMN mtu INTEGER",
        "ALTER TABLE interfaces ADD COLUMN port_mode TEXT",
        "ALTER TABLE interfaces ADD COLUMN native_vlan TEXT",
        "ALTER TABLE interfaces ADD COLUMN tagged_vlans TEXT",
        "ALTER TABLE interfaces ADD COLUMN poe TEXT",
        "ALTER TABLE interfaces ADD COLUMN link_state TEXT",
        "ALTER TABLE interfaces ADD COLUMN parent TEXT",
        "ALTER TABLE interfaces ADD COLUMN wifi_ssid TEXT",
        "UPDATE interfaces SET assignment = 'DHCP reservation' WHERE dhcp = 1",
        "CREATE INDEX IF NOT EXISTS idx_interfaces_network ON interfaces(network_id)",
        "CREATE INDEX IF NOT EXISTS idx_interfaces_ip ON interfaces(ip)",
    ],
    3: [
        # Parts library: imported (source 'opendb') and your own (source 'custom').
        """CREATE TABLE IF NOT EXISTS catalog_parts (
            id           INTEGER PRIMARY KEY,
            source       TEXT NOT NULL,
            source_id    TEXT,
            category     TEXT NOT NULL,
            name         TEXT NOT NULL,
            manufacturer TEXT,
            part_numbers TEXT,
            release_year INTEGER,
            specs        TEXT NOT NULL DEFAULT '{}',
            notes        TEXT,
            created_at   TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE (source, source_id)
        )""",
        "CREATE INDEX IF NOT EXISTS idx_catalog_cat ON catalog_parts(category, name)",
        """CREATE TABLE IF NOT EXISTS builds (
            id         INTEGER PRIMARY KEY,
            name       TEXT NOT NULL,
            purpose    TEXT,
            status     TEXT NOT NULL DEFAULT 'Planning',
            device_id  INTEGER REFERENCES devices(id) ON DELETE SET NULL,
            budget     REAL,
            notes      TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )""",
        """CREATE TABLE IF NOT EXISTS build_items (
            id           INTEGER PRIMARY KEY,
            build_id     INTEGER NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
            category     TEXT NOT NULL,
            catalog_id   INTEGER REFERENCES catalog_parts(id) ON DELETE SET NULL,
            component_id INTEGER REFERENCES components(id) ON DELETE SET NULL,
            name         TEXT,
            quantity     INTEGER NOT NULL DEFAULT 1,
            price        REAL,
            acquire      TEXT NOT NULL DEFAULT 'Need',
            notes        TEXT,
            created_at   TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
        )""",
        "CREATE INDEX IF NOT EXISTS idx_build_items_build ON build_items(build_id)",
        "ALTER TABLE components ADD COLUMN catalog_id INTEGER REFERENCES catalog_parts(id) ON DELETE SET NULL",
    ],
    4: [
        # Parts assigned to a device were left "In Stock" by older versions.
        "UPDATE components SET status = 'Installed' WHERE device_id IS NOT NULL AND status = 'In Stock'",
        "UPDATE components SET status = 'In Stock' WHERE device_id IS NULL AND status = 'Installed'",
        # Serial number and service tag are one field now; move tags typed into "Asset tag".
        "UPDATE devices SET serial = asset_tag, asset_tag = NULL "
        "WHERE (serial IS NULL OR serial = '') AND asset_tag IS NOT NULL AND asset_tag != ''",
        lambda conn: _normalize_capacities(conn),
    ],
    5: [
        # Journal: notes, tasks, actions taken and issues, attached to any item.
        """CREATE TABLE IF NOT EXISTS notes (
            id         INTEGER PRIMARY KEY,
            entity     TEXT NOT NULL,
            entity_id  INTEGER NOT NULL,
            kind       TEXT NOT NULL DEFAULT 'note',
            body       TEXT NOT NULL,
            done       INTEGER NOT NULL DEFAULT 0,
            pinned     INTEGER NOT NULL DEFAULT 0,
            due        TEXT,
            done_at    TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )""",
        "CREATE INDEX IF NOT EXISTS idx_notes_entity ON notes(entity, entity_id)",
        "CREATE INDEX IF NOT EXISTS idx_notes_open ON notes(kind, done)",
        # Device notes move into the journal (keeping when they were last edited).
        "INSERT INTO notes (entity, entity_id, kind, body, created_at, updated_at) "
        "SELECT 'devices', id, 'note', notes, updated_at, updated_at FROM devices "
        "WHERE notes IS NOT NULL AND TRIM(notes) != ''",
        "UPDATE devices SET notes = NULL",
        # Named bay groups with their own controller/array, and drives placed in bays.
        "ALTER TABLE device_slots ADD COLUMN label TEXT",
        "ALTER TABLE device_slots ADD COLUMN array_name TEXT",
        "ALTER TABLE device_slots ADD COLUMN first_index INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE components ADD COLUMN slot_id INTEGER REFERENCES device_slots(id) ON DELETE SET NULL",
        "ALTER TABLE components ADD COLUMN bay INTEGER",
        # "Raid" was being used as a connection type: RAID is the array, the bays take SAS and SATA.
        "UPDATE device_slots SET array_name = COALESCE(array_name, 'RAID'), interface = 'SAS/SATA' "
        "WHERE LOWER(TRIM(interface)) = 'raid'",
        "UPDATE components SET interface = NULL WHERE LOWER(TRIM(interface)) = 'raid'",
        lambda conn: _seed_server_cpus(conn),
    ],
    6: [
        # What things are worth: list price when new, today's market value, and when it was checked.
        "ALTER TABLE devices ADD COLUMN msrp REAL",
        "ALTER TABLE devices ADD COLUMN market_value REAL",
        "ALTER TABLE devices ADD COLUMN value_checked TEXT",
        "ALTER TABLE components ADD COLUMN msrp REAL",
        "ALTER TABLE components ADD COLUMN market_value REAL",
        "ALTER TABLE components ADD COLUMN value_checked TEXT",
    ],
    7: [
        # Clusters, and virtual machines / containers as devices that run on a host.
        """CREATE TABLE IF NOT EXISTS clusters (
            id          INTEGER PRIMARY KEY,
            name        TEXT NOT NULL,
            kind        TEXT,
            location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
            notes       TEXT,
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        )""",
        "ALTER TABLE devices ADD COLUMN host_id INTEGER REFERENCES devices(id) ON DELETE SET NULL",
        "ALTER TABLE devices ADD COLUMN cluster_id INTEGER REFERENCES clusters(id) ON DELETE SET NULL",
        "ALTER TABLE devices ADD COLUMN vm_id TEXT",
        "ALTER TABLE devices ADD COLUMN vcpus INTEGER",
        "ALTER TABLE devices ADD COLUMN vm_ram_gb REAL",
        "ALTER TABLE devices ADD COLUMN vm_disk_gb REAL",
        "CREATE INDEX IF NOT EXISTS idx_devices_host ON devices(host_id)",
        "CREATE INDEX IF NOT EXISTS idx_devices_cluster ON devices(cluster_id)",
        # One interface per device can be its main address (used for quick links and logins).
        "ALTER TABLE interfaces ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0",
    ],
    8: [
        # Online checks: whether each device answers, per address, and when that last changed.
        "ALTER TABLE devices ADD COLUMN watch INTEGER NOT NULL DEFAULT 1",
        """CREATE TABLE IF NOT EXISTS device_status (
            device_id  INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
            address    TEXT NOT NULL,
            state      TEXT NOT NULL,
            latency_ms REAL,
            method     TEXT,
            checked_at TEXT NOT NULL,
            changed_at TEXT NOT NULL,
            PRIMARY KEY (device_id, address)
        )""",
        """CREATE TABLE IF NOT EXISTS status_events (
            id        INTEGER PRIMARY KEY,
            device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
            address   TEXT NOT NULL,
            state     TEXT NOT NULL,
            at        TEXT NOT NULL
        )""",
        "CREATE INDEX IF NOT EXISTS idx_status_events ON status_events(device_id, at)",
        # Saved actions: commands sent over SSH to a device's addresses with one click.
        """CREATE TABLE IF NOT EXISTS actions (
            id            INTEGER PRIMARY KEY,
            name          TEXT NOT NULL,
            device_id     INTEGER REFERENCES devices(id) ON DELETE CASCADE,
            hosts         TEXT,
            port          INTEGER,
            credential_id INTEGER REFERENCES credentials(id) ON DELETE SET NULL,
            username      TEXT,
            mode          TEXT NOT NULL DEFAULT 'script',
            command       TEXT NOT NULL,
            sudo          INTEGER NOT NULL DEFAULT 0,
            legacy_ssh    INTEGER NOT NULL DEFAULT 0,
            ssh_options   TEXT,
            confirm       INTEGER NOT NULL DEFAULT 0,
            pinned        INTEGER NOT NULL DEFAULT 1,
            notes         TEXT,
            created_at    TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
        )""",
        "CREATE INDEX IF NOT EXISTS idx_actions_device ON actions(device_id)",
        # What each run did. The output is encrypted with the vault key, like logins.
        """CREATE TABLE IF NOT EXISTS action_runs (
            id         INTEGER PRIMARY KEY,
            action_id  INTEGER NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
            host       TEXT NOT NULL,
            ok         INTEGER NOT NULL,
            exit_code  INTEGER,
            ms         INTEGER,
            output_enc BLOB,
            at         TEXT NOT NULL DEFAULT (datetime('now'))
        )""",
        "CREATE INDEX IF NOT EXISTS idx_action_runs ON action_runs(action_id, id)",
    ],
}


# Common homelab/server CPUs missing from the parts library (cores, threads, base GHz).
_SERVER_CPUS = {
    ("C32", "DDR3"): [("AMD Opteron 4122", 4, 4, 2.2), ("AMD Opteron 4130", 4, 4, 2.6), ("AMD Opteron 4162 EE", 6, 6, 1.7),
                      ("AMD Opteron 4170 HE", 6, 6, 2.1), ("AMD Opteron 4174 HE", 6, 6, 2.3), ("AMD Opteron 4176 HE", 6, 6, 2.4),
                      ("AMD Opteron 4180", 6, 6, 2.6), ("AMD Opteron 4184", 6, 6, 2.8), ("AMD Opteron 4226", 6, 6, 2.7),
                      ("AMD Opteron 4228 HE", 6, 6, 2.8), ("AMD Opteron 4230 HE", 6, 6, 2.9), ("AMD Opteron 4234", 6, 6, 3.1),
                      ("AMD Opteron 4238", 6, 6, 3.3), ("AMD Opteron 4240", 6, 6, 3.4), ("AMD Opteron 4256 EE", 8, 8, 1.6),
                      ("AMD Opteron 4274 HE", 8, 8, 2.5), ("AMD Opteron 4276 HE", 8, 8, 2.6), ("AMD Opteron 4280", 8, 8, 2.8),
                      ("AMD Opteron 4284", 8, 8, 3.0), ("AMD Opteron 4332 HE", 6, 6, 3.0), ("AMD Opteron 4334", 6, 6, 3.1),
                      ("AMD Opteron 4340", 6, 6, 3.5), ("AMD Opteron 4376 HE", 8, 8, 2.6), ("AMD Opteron 4386", 8, 8, 3.1)],
    ("G34", "DDR3"): [("AMD Opteron 6128", 8, 8, 2.0), ("AMD Opteron 6168", 12, 12, 1.9), ("AMD Opteron 6174", 12, 12, 2.2),
                      ("AMD Opteron 6176", 12, 12, 2.3)],
    ("LGA 1366", "DDR3"): [("Intel Xeon E5520", 4, 8, 2.26), ("Intel Xeon L5520", 4, 8, 2.26), ("Intel Xeon X5550", 4, 8, 2.66),
                           ("Intel Xeon X5570", 4, 8, 2.93), ("Intel Xeon E5620", 4, 8, 2.4), ("Intel Xeon E5630", 4, 8, 2.53),
                           ("Intel Xeon E5640", 4, 8, 2.66), ("Intel Xeon E5645", 6, 12, 2.4), ("Intel Xeon L5640", 6, 12, 2.26),
                           ("Intel Xeon X5650", 6, 12, 2.66), ("Intel Xeon X5660", 6, 12, 2.8), ("Intel Xeon X5670", 6, 12, 2.93),
                           ("Intel Xeon X5675", 6, 12, 3.06), ("Intel Xeon X5680", 6, 12, 3.33), ("Intel Xeon X5690", 6, 12, 3.46)],
    ("LGA 1156", "DDR3"): [("Intel Xeon X3430", 4, 4, 2.4), ("Intel Xeon X3440", 4, 8, 2.53), ("Intel Xeon X3450", 4, 8, 2.66),
                           ("Intel Xeon X3460", 4, 8, 2.8), ("Intel Xeon X3470", 4, 8, 2.93), ("Intel Xeon X3480", 4, 8, 3.06)],
    ("LGA 2011", "DDR3"): [("Intel Xeon E5-2620", 6, 12, 2.0), ("Intel Xeon E5-2630", 6, 12, 2.3), ("Intel Xeon E5-2650", 8, 16, 2.0),
                           ("Intel Xeon E5-2660", 8, 16, 2.2), ("Intel Xeon E5-2670", 8, 16, 2.6), ("Intel Xeon E5-2680", 8, 16, 2.7),
                           ("Intel Xeon E5-2690", 8, 16, 2.9), ("Intel Xeon E5-2620 v2", 6, 12, 2.1), ("Intel Xeon E5-2630 v2", 6, 12, 2.6),
                           ("Intel Xeon E5-2640 v2", 8, 16, 2.0), ("Intel Xeon E5-2650 v2", 8, 16, 2.6), ("Intel Xeon E5-2660 v2", 10, 20, 2.2),
                           ("Intel Xeon E5-2670 v2", 10, 20, 2.5), ("Intel Xeon E5-2680 v2", 10, 20, 2.8), ("Intel Xeon E5-2690 v2", 10, 20, 3.0),
                           ("Intel Xeon E5-2695 v2", 12, 24, 2.4), ("Intel Xeon E5-2697 v2", 12, 24, 2.7)],
    ("LGA 2011-3", "DDR4"): [("Intel Xeon E5-2620 v3", 6, 12, 2.4), ("Intel Xeon E5-2630 v3", 8, 16, 2.4), ("Intel Xeon E5-2640 v3", 8, 16, 2.6),
                             ("Intel Xeon E5-2650 v3", 10, 20, 2.3), ("Intel Xeon E5-2660 v3", 10, 20, 2.6), ("Intel Xeon E5-2670 v3", 12, 24, 2.3),
                             ("Intel Xeon E5-2680 v3", 12, 24, 2.5), ("Intel Xeon E5-2690 v3", 12, 24, 2.6), ("Intel Xeon E5-2695 v3", 14, 28, 2.3),
                             ("Intel Xeon E5-2697 v3", 14, 28, 2.6), ("Intel Xeon E5-2698 v3", 16, 32, 2.3), ("Intel Xeon E5-2699 v3", 18, 36, 2.3),
                             ("Intel Xeon E5-2620 v4", 8, 16, 2.1), ("Intel Xeon E5-2630 v4", 10, 20, 2.2), ("Intel Xeon E5-2640 v4", 10, 20, 2.4),
                             ("Intel Xeon E5-2650 v4", 12, 24, 2.2), ("Intel Xeon E5-2660 v4", 14, 28, 2.0), ("Intel Xeon E5-2680 v4", 14, 28, 2.4),
                             ("Intel Xeon E5-2690 v4", 14, 28, 2.6), ("Intel Xeon E5-2695 v4", 18, 36, 2.1), ("Intel Xeon E5-2697 v4", 18, 36, 2.3),
                             ("Intel Xeon E5-2698 v4", 20, 40, 2.2), ("Intel Xeon E5-2699 v4", 22, 44, 2.2)],
    ("LGA 3647", "DDR4"): [("Intel Xeon Silver 4110", 8, 16, 2.1), ("Intel Xeon Silver 4114", 10, 20, 2.2), ("Intel Xeon Silver 4116", 12, 24, 2.1),
                           ("Intel Xeon Gold 5118", 12, 24, 2.3), ("Intel Xeon Gold 6130", 16, 32, 2.1), ("Intel Xeon Gold 6138", 20, 40, 2.0),
                           ("Intel Xeon Gold 6148", 20, 40, 2.4), ("Intel Xeon Silver 4210", 10, 20, 2.2), ("Intel Xeon Silver 4214", 12, 24, 2.2),
                           ("Intel Xeon Gold 5218", 16, 32, 2.3), ("Intel Xeon Gold 6230", 20, 40, 2.1), ("Intel Xeon Gold 6248", 20, 40, 2.5)],
    ("SP3", "DDR4"): [("AMD EPYC 7282", 16, 32, 2.8), ("AMD EPYC 7302", 16, 32, 3.0), ("AMD EPYC 7402", 24, 48, 2.8),
                      ("AMD EPYC 7502", 32, 64, 2.5), ("AMD EPYC 7551", 32, 64, 2.0), ("AMD EPYC 7601", 32, 64, 2.2)],
}


def _seed_server_cpus(conn) -> None:
    import json
    for (socket, mem), cpus in _SERVER_CPUS.items():
        for name, cores, threads, ghz in cpus:
            specs = {"socket": socket, "cores": cores, "threads": threads, "base_ghz": ghz, "memory_types": [mem], "ecc": True}
            conn.execute(
                "INSERT OR IGNORE INTO catalog_parts (source, source_id, category, name, manufacturer, specs) "
                "VALUES ('harm', ?, 'cpu', ?, ?, ?)",
                (name.lower().replace(" ", "-"), name, name.split()[0], json.dumps(specs)))


def _normalize_capacities(conn) -> None:
    from .units import normalize_capacity
    for r in conn.execute("SELECT id, capacity FROM components WHERE capacity IS NOT NULL").fetchall():
        new = normalize_capacity(r[1])
        if new != r[1]:
            conn.execute("UPDATE components SET capacity = ? WHERE id = ?", (new, r[0]))


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=10, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 10000")
    return conn


def init() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(DB_PATH.parent, 0o700)
    new = not DB_PATH.exists()
    conn = connect()
    try:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(SCHEMA)
        conn.execute("INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '1')")
        conn.commit()
        current = int(get_meta(conn, "schema_version"))
        for version in sorted(v for v in MIGRATIONS if v > current):
            with conn:  # one transaction per migration
                for stmt in MIGRATIONS[version]:
                    stmt(conn) if callable(stmt) else conn.execute(stmt)
                set_meta(conn, "schema_version", str(version))
    finally:
        conn.close()
    if new:
        os.chmod(DB_PATH, 0o600)


def get_meta(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def set_meta(conn: sqlite3.Connection, key: str, value: str | None) -> None:
    if value is None:
        conn.execute("DELETE FROM meta WHERE key = ?", (key,))
    else:
        conn.execute(
            "INSERT INTO meta(key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )
