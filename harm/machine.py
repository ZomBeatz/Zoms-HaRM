"""A machine's health and updates, over SSH (like Docker and actions): disk space, drives' SMART
health, ZFS pools and RAID arrays, memory and load, waiting OS updates (and which are security
fixes), whether it needs a restart, and how fresh its backups are.

The check only reads. Installing updates and restarting are separate scripts, each run when it's
pressed. Every value that goes into a script (a backup folder, a dataset) is checked and quoted here.
"""

import re
import shlex
from datetime import datetime, timezone

SECTIONS = ("os", "uptime", "mem", "df", "reboot", "updates", "disks", "smart", "zpool", "zsnap", "md", "folders")

CHECK_SCRIPT = r"""export LC_ALL=C
sec() { echo "HARM_SEC=$1"; }
# A limited login may run just smartctl and apt-get update with sudo (no password): see Help.
SU=""; [ "$(id -u)" != 0 ] && [ "${HARM_SU:-}" = 1 ] && SU="sudo -n"
sec os
grep -E '^(PRETTY_NAME|ID|ID_LIKE|VERSION_ID)=' /etc/os-release 2>/dev/null
echo "KERNEL=$(uname -r)"; echo "HOST=$(hostname 2>/dev/null)"; echo "ROOT=$(id -u)"
command -v pveversion >/dev/null 2>&1 && echo "PVE=$(pveversion 2>/dev/null | head -1)"
sec uptime
cat /proc/uptime 2>/dev/null; cat /proc/loadavg 2>/dev/null; nproc 2>/dev/null || getconf _NPROCESSORS_ONLN
sec mem
grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo 2>/dev/null
sec df
df -PT -B1 -x tmpfs -x devtmpfs -x squashfs -x overlay -x efivarfs -x fuse.lxcfs -x nsfs -x ramfs 2>/dev/null
sec reboot
[ -f /var/run/reboot-required ] && echo "NEEDED=packages" && head -20 /var/run/reboot-required.pkgs 2>/dev/null
if command -v needs-restarting >/dev/null 2>&1; then needs-restarting -r >/dev/null 2>&1; [ $? -eq 1 ] && echo "NEEDED=packages"; fi
k=$(uname -r); m=/lib/modules; [ -d /usr/lib/modules ] && m=/usr/lib/modules
if [ -d "$m" ] && [ -n "$(ls "$m" 2>/dev/null)" ]; then
  [ -d "$m/$k" ] || echo "NEEDED=kernel"
  newest=$(ls "$m" | grep -E '^[0-9]' | sort -V | tail -1)
  [ -n "$newest" ] && [ "$newest" != "$k" ] && echo "NEWER_KERNEL=$newest"
fi
sec updates
if command -v apt-get >/dev/null 2>&1; then
  echo "MANAGER=apt"
  if { [ "$(id -u)" = 0 ] || [ -n "$SU" ]; } && command -v timeout >/dev/null 2>&1; then
    timeout 150 $SU apt-get update -qq >/dev/null 2>&1 && echo "REFRESHED=1"
  fi
  apt list --upgradable 2>/dev/null | grep -v '^Listing'
elif command -v dnf >/dev/null 2>&1; then
  echo "MANAGER=dnf"; dnf -q check-update 2>/dev/null; echo "REFRESHED=1"
  echo "SECURITY_LIST"; dnf -q updateinfo list --security --available 2>/dev/null
elif command -v pacman >/dev/null 2>&1; then
  echo "MANAGER=pacman"
  if command -v checkupdates >/dev/null 2>&1; then checkupdates 2>/dev/null; echo "REFRESHED=1"; else pacman -Qu 2>/dev/null; fi
elif command -v apk >/dev/null 2>&1; then
  echo "MANAGER=apk"; apk version -l '<' 2>/dev/null | grep -v '^Installed'
fi
sec disks
lsblk -dnb -P -o NAME,SIZE,ROTA,TYPE,TRAN,VENDOR,MODEL,SERIAL 2>/dev/null
sec smart
if command -v smartctl >/dev/null 2>&1; then
  for d in $(lsblk -dn -o NAME,TYPE 2>/dev/null | awk '$2=="disk"{print $1}'); do
    case "$d" in zram*|loop*|sr*|rbd*|nbd*) continue;; esac
    echo "HARM_DISK=$d"
    $SU smartctl -H -i -A "/dev/$d" 2>&1 | grep -E 'password is required|Device Model|Model Number|Product:|Vendor:|Serial [Nn]umber|overall-health|Health Status|Reallocated_Sector_Ct|Current_Pending_Sector|Offline_Uncorrectable|Power_On_Hours|Power On Hours|Accumulated power on time|Temperature_Celsius|Current Drive Temperature|^Temperature:|Percentage Used|Media and Data Integrity Errors|elements in grown defect list|Permission denied|Unable to detect device type|failed:|Unavailable|not supported' | head -30
  done
else
  echo "NO_SMARTCTL"
fi
sec zpool
command -v zpool >/dev/null 2>&1 && zpool list -Hp -o name,size,alloc,free,health 2>/dev/null
sec zsnap
command -v zfs >/dev/null 2>&1 && zfs list -Hp -t snapshot -o name,creation 2>/dev/null | awk '{split($1,a,"@"); if ($2+0 > m[a[1]]+0) m[a[1]]=$2} END {for (k in m) print k "\t" m[k]}' | head -300
sec md
[ -r /proc/mdstat ] && grep -E '^md|blocks' /proc/mdstat
sec folders
"""

_FOLDER = re.compile(r"^/[^\0\n]{0,250}$")
_DATASET = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,250}$")
HOURS = (6, 12, 24, 36, 48, 72, 168, 336, 720)


class MachineError(Exception):
    pass


def clean_backups(items) -> list[dict]:
    """Backup checks from the form: a folder that should get new files, or a ZFS dataset's snapshots."""
    out = []
    for b in (items or [])[:20]:
        kind = b.get("kind")
        path = str(b.get("path") or "").strip().rstrip("/") or "/"
        try:
            hours = int(b.get("hours") or 36)
        except (TypeError, ValueError):
            hours = 36
        if hours not in HOURS:
            raise MachineError(f"Expect a new backup every {', '.join(str(h) for h in HOURS)} hours")
        if kind == "folder" and not _FOLDER.match(path):
            raise MachineError(f"“{path}” isn't a folder path. Start it with /, like /mnt/backups/nextcloud")
        if kind == "zfs" and not _DATASET.match(path):
            raise MachineError(f"“{path}” isn't a ZFS dataset name, like tank/media")
        if kind not in ("folder", "zfs"):
            raise MachineError("A backup check is a folder or a ZFS dataset")
        out.append({"kind": kind, "path": path, "hours": hours, "name": str(b.get("name") or "").strip()[:60]})
    return out


def check_script(backups: list[dict], limited_sudo: bool = False) -> str:
    """The check, plus the newest file in each backup folder (searched three levels deep)."""
    lines = []
    for b in backups:
        if b["kind"] != "folder":
            continue
        q = shlex.quote(b["path"])
        lines.append(f'echo "HARM_FOLDER={b["path"]}"\n'
                     f'if [ -d {q} ]; then find {q} -maxdepth 3 -type f -exec stat -c "%Y %s %n" {{}} + 2>/dev/null '
                     f'| sort -n | tail -1; else echo MISSING; fi\n')
    return ("HARM_SU=1\n" if limited_sudo else "") + CHECK_SCRIPT + "".join(lines)


# --------------------------------------------------------------------------- reading the output

def _sections(out: str) -> dict[str, list[str]]:
    secs, cur = {}, None
    for line in out.splitlines():
        if line.startswith("HARM_SEC="):
            cur = line[9:].strip()
            secs[cur] = []
        elif cur:
            secs[cur].append(line.rstrip())
    return secs


def _int(v, default=0) -> int:
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return default


def _ts(epoch) -> str | None:
    e = _int(epoch, -1)
    return datetime.fromtimestamp(e, timezone.utc).strftime("%Y-%m-%d %H:%M:%S") if e > 0 else None


_VIRTUAL = re.compile(r"PERC|MegaRAID|MR9|LSI|AVAGO|LOGICAL|Smart Array|ServeRAID|RAID|Virtual|QEMU|VBOX|VMware|"
                      r"Msft|iSCSI|Areca|Adaptec|3ware|HPE? LOGICAL|Dell BOSS", re.I)


def _smart(lines: list[str]) -> dict:
    s = {"health": "unknown", "hours": None, "temp": None, "realloc": None, "pending": None, "wear": None, "note": ""}
    for ln in lines:
        low = ln.lower()
        if "overall-health" in low or "health status" in low:
            v = ln.split(":", 1)[-1].strip().upper()
            s["health"] = "ok" if v in ("PASSED", "OK") else "failing"
        elif "permission denied" in low or "password is required" in low:
            s["note"] = "needs sudo"
        elif "unable to detect device type" in low or "unavailable" in low or "not supported" in low:
            s["note"] = s["note"] or "not available"
        attr = ln.split()
        if re.match(r"^\s*\d+\s+(Reallocated_Sector_Ct|Current_Pending_Sector|Offline_Uncorrectable|Power_On_Hours|Temperature_Celsius)", ln):
            name, raw = attr[1], attr[9] if len(attr) > 9 else ""
            val = _int(re.match(r"\d+", raw).group() if re.match(r"\d+", raw) else None, None)
            key = {"Reallocated_Sector_Ct": "realloc", "Current_Pending_Sector": "pending", "Offline_Uncorrectable": "pending",
                   "Power_On_Hours": "hours", "Temperature_Celsius": "temp"}[name]
            if val is not None:
                s[key] = max(val, s[key] or 0) if key == "pending" else val
        elif low.startswith("power on hours") or low.startswith("accumulated power on time"):
            m = re.search(r"([\d,]+)", ln.split(":", 1)[-1])
            if m:
                s["hours"] = _int(m.group(1).replace(",", ""), None)
        elif low.startswith("temperature:") or low.startswith("current drive temperature"):
            m = re.search(r"(\d+)", ln.split(":", 1)[-1])
            if m:
                s["temp"] = _int(m.group(1), None)
        elif low.startswith("percentage used"):
            m = re.search(r"(\d+)%", ln)
            if m:
                s["wear"] = _int(m.group(1), None)
        elif low.startswith("media and data integrity errors") or "grown defect list" in low:
            m = re.search(r"(\d+)\s*$", ln)
            if m:
                s["realloc"] = (s["realloc"] or 0) + _int(m.group(1))
    return s


def _pairs(line: str) -> dict:
    return {k: v for k, v in re.findall(r'(\w+)="([^"]*)"', line)}


def _updates(lines: list[str]) -> dict:
    u = {"manager": None, "refreshed": False, "packages": []}
    sec_names, in_sec = set(), False
    for ln in lines:
        if ln.startswith("MANAGER="):
            u["manager"] = ln[8:]
            continue
        if ln.startswith("REFRESHED="):
            u["refreshed"] = True
            continue
        if ln == "SECURITY_LIST":
            in_sec = True
            continue
        if not ln.strip():
            continue
        if in_sec:  # dnf: ADVISORY  Important/Sec.  name-version.arch
            parts = ln.split()
            if len(parts) >= 3:
                sec_names.add(re.sub(r"-[^-]+-[^-]+$", "", parts[-1]))
            continue
        m = u["manager"]
        if m == "apt":  # name/suite version arch [upgradable from: old]
            r = re.match(r"^([^/\s]+)/(\S+)\s+(\S+)\s+\S+\s+\[upgradable from:\s*([^\]]+)\]", ln)
            if r:
                u["packages"].append({"name": r.group(1), "new": r.group(3), "now": r.group(4).strip(),
                                      "security": "security" in r.group(2)})
        elif m == "dnf":  # name.arch  version  repo
            parts = ln.split()
            if len(parts) == 3 and "." in parts[0] and not ln.startswith(("Obsoleting", "Last metadata", "Security:")):
                u["packages"].append({"name": parts[0].rsplit(".", 1)[0], "new": parts[1], "now": "", "security": False})
        elif m == "pacman":  # name old -> new
            r = re.match(r"^(\S+)\s+(\S+)\s+->\s+(\S+)", ln)
            if r:
                u["packages"].append({"name": r.group(1), "now": r.group(2), "new": r.group(3), "security": False})
        elif m == "apk":  # name-version < new
            r = re.match(r"^(\S+?)-(\d\S*)\s+<\s+(\S+)", ln)
            if r:
                u["packages"].append({"name": r.group(1), "now": r.group(2), "new": r.group(3), "security": False})
    for p in u["packages"]:
        if p["name"] in sec_names:
            p["security"] = True
    u["count"] = len(u["packages"])
    u["security"] = sum(1 for p in u["packages"] if p["security"])
    u["packages"] = sorted(u["packages"], key=lambda p: (not p["security"], p["name"]))[:400]
    return u


def parse(out: str, backups: list[dict] | None = None) -> dict:
    s = _sections(out)
    if "os" not in s:
        raise MachineError("That machine didn't answer like Linux. The machine check works on Linux, Proxmox and most NAS boxes")
    kv = dict(ln.split("=", 1) for ln in s.get("os", []) if "=" in ln)
    os_ = {"name": kv.get("PRETTY_NAME", "").strip('"') or "Linux", "id": kv.get("ID", "").strip('"'),
           "like": kv.get("ID_LIKE", "").strip('"'), "version": kv.get("VERSION_ID", "").strip('"'),
           "kernel": kv.get("KERNEL", ""), "hostname": kv.get("HOST", ""), "pve": kv.get("PVE", "")}
    snap: dict = {"os": os_, "root": kv.get("ROOT") == "0"}

    up = s.get("uptime", [])
    snap["uptime_s"] = _int(up[0].split()[0]) if up and up[0].split() else None
    load = up[1].split()[:3] if len(up) > 1 else []
    snap["load"] = [float(x) for x in load if re.match(r"^[\d.]+$", x)]
    snap["cpus"] = _int(up[2], None) if len(up) > 2 else None

    mem = {k.rstrip(":"): _int(v) * 1024 for k, v, *_ in (ln.split() for ln in s.get("mem", []) if len(ln.split()) >= 2)}
    snap["mem"] = {"total": mem.get("MemTotal"), "avail": mem.get("MemAvailable"),
                   "swap_total": mem.get("SwapTotal"), "swap_free": mem.get("SwapFree")}

    vols, seen = [], set()
    for ln in s.get("df", [])[1:]:
        p = ln.split()
        if len(p) < 7 or not p[2].isdigit():
            continue
        source, fstype, size, used, avail, mount = p[0], p[1], _int(p[2]), _int(p[3]), _int(p[4]), " ".join(p[6:])
        if size <= 0 or mount.startswith(("/snap/", "/var/lib/docker/", "/run/", "/sys/", "/proc/", "/dev/")):
            continue
        if fstype not in ("zfs", "nfs", "nfs4", "cifs", "smb3", "fuse.mergerfs", "fuse.sshfs") and source in seen:
            continue  # the same disk mounted twice (bind mounts)
        seen.add(source)
        vols.append({"source": source, "type": fstype, "size": size, "used": used, "avail": avail, "mount": mount,
                     "pct": round(used * 100 / (used + avail)) if used + avail else 0})
    snap["volumes"] = vols[:60]

    rb = s.get("reboot", [])
    why = sorted({ln[7:] for ln in rb if ln.startswith("NEEDED=")})
    newer = next((ln[13:] for ln in rb if ln.startswith("NEWER_KERNEL=")), "")
    if newer and "kernel" not in why and "packages" not in why:
        why.append("kernel")
    snap["reboot"] = {"needed": bool(why), "why": why, "kernel_now": os_["kernel"], "kernel_new": newer,
                      "packages": [ln for ln in rb if ln and "=" not in ln][:20]}

    snap["updates"] = _updates(s.get("updates", []))

    disks = []
    for ln in s.get("disks", []):
        d = _pairs(ln)
        if d.get("TYPE") != "disk" or re.match(r"^(zram|loop|sr|rbd|nbd)", d.get("NAME", "")):
            continue
        vendor = "" if d.get("VENDOR", "").strip().upper() in ("ATA", "") else d["VENDOR"]
        model = " ".join(f"{vendor} {d.get('MODEL', '')}".split())
        disks.append({"name": d.get("NAME", ""), "size": _int(d.get("SIZE")), "rotational": d.get("ROTA") == "1",
                      "tran": d.get("TRAN", ""), "model": model, "serial": d.get("SERIAL", "").strip(),
                      "virtual": bool(_VIRTUAL.search(model)), "smart": None})
    smart_lines, cur = {}, None
    no_smartctl = "NO_SMARTCTL" in s.get("smart", [])
    for ln in s.get("smart", []):
        if ln.startswith("HARM_DISK="):
            cur = ln[10:]
            smart_lines[cur] = []
        elif cur:
            smart_lines[cur].append(ln)
    for d in disks:
        if d["name"] in smart_lines:
            sm = _smart(smart_lines[d["name"]])
            d["smart"] = sm
            if d["virtual"] and sm["health"] == "unknown":
                sm["note"] = "virtual drive"
    snap["disks"] = disks
    snap["smartctl"] = not no_smartctl

    pools = []
    for ln in s.get("zpool", []):
        p = ln.split("\t")
        if len(p) == 5:
            pools.append({"name": p[0], "size": _int(p[1]), "alloc": _int(p[2]), "free": _int(p[3]), "health": p[4]})
    snap["pools"] = pools

    md, name = [], None
    for ln in s.get("md", []):
        m = re.match(r"^(md\S+)\s*:\s*(\S+)\s+(\S+)?", ln)
        if m:
            name = m.group(1)
            md.append({"name": name, "state": m.group(2), "level": m.group(3) or "", "degraded": False})
        elif name and md:
            st = re.search(r"\[([U_]+)\]", ln)
            if st and "_" in st.group(1):
                md[-1]["degraded"] = True
    snap["md"] = md

    newest = {}
    for ln in s.get("zsnap", []):
        p = ln.split("\t")
        if len(p) == 2:
            newest[p[0]] = _ts(p[1])
    snap["snapshots"] = newest

    folders, cur = {}, None
    for ln in s.get("folders", []):
        if ln.startswith("HARM_FOLDER="):
            cur = ln[12:]
            folders[cur] = {"newest": None, "file": "", "missing": False}
        elif cur and ln == "MISSING":
            folders[cur]["missing"] = True
        elif cur and ln.strip():
            p = ln.split(" ", 2)
            if len(p) == 3:
                folders[cur] = {"newest": _ts(p[0]), "file": p[2], "size": _int(p[1]), "missing": False}
    snap["folders"] = folders
    snap["backups"] = backup_status(backups or [], folders, newest)
    return snap


def backup_status(backups: list[dict], folders: dict, snapshots: dict) -> list[dict]:
    """Each backup check with the newest file or snapshot found."""
    out = []
    for b in backups:
        if b["kind"] == "folder":
            f = folders.get(b["path"])
            out.append({**b, "newest": (f or {}).get("newest"), "file": (f or {}).get("file", ""),
                        "missing": (f or {}).get("missing", False), "unread": f is None})
        else:
            hits = {k: v for k, v in snapshots.items() if k == b["path"] or k.startswith(b["path"] + "/")}
            out.append({**b, "newest": max((v for v in hits.values() if v), default=None), "file": "",
                        "missing": not hits, "unread": False})
    return out


# --------------------------------------------------------------------------- what needs attention

def _age_hours(ts: str | None, now: datetime) -> float | None:
    if not ts:
        return None
    return (now - datetime.strptime(ts, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)).total_seconds() / 3600


def _size(n: int) -> str:
    for unit, div in (("TB", 1e12), ("GB", 1e9), ("MB", 1e6)):
        if n >= div:
            v = n / div
            return f"{v:.1f} {unit}" if v < 100 else f"{v:.0f} {unit}"
    return f"{n} B"


def label(labels: dict, key: str, default: str) -> str:
    return (labels.get(key) or {}).get("name") or default


def problems(snap: dict | None, labels: dict | None = None) -> list[dict]:
    """[{key, level ('bad' | 'warn' | 'info'), text}] for one machine. key stays the same while the
    problem lasts, so an alert goes out once."""
    if not snap:
        return []
    labels = labels or {}
    now = datetime.now(timezone.utc)
    out = []

    def add(key, level, text):
        if not (labels.get(key) or {}).get("ignore"):
            out.append({"key": key, "level": level, "text": text})

    for v in snap.get("volumes", []):
        key = f"vol:{v['mount']}"
        name = label(labels, key, v["mount"])
        if v["pct"] >= 95:
            add(key, "bad", f"{name} is {v['pct']}% full ({_size(v['avail'])} left)")
        elif v["pct"] >= 90:
            add(key, "warn", f"{name} is {v['pct']}% full ({_size(v['avail'])} left)")
    for d in snap.get("disks", []):
        key = f"disk:{d['serial'] or d['name']}"
        name = label(labels, key, f"{d['model'] or d['name']} ({d['name']})")
        sm = d.get("smart") or {}
        if sm.get("health") == "failing":
            add(key, "bad", f"{name}: the drive reports it's failing (SMART)")
        elif (sm.get("realloc") or 0) > 0 or (sm.get("pending") or 0) > 0:
            bits = [f"{sm['realloc']} reallocated" if sm.get("realloc") else "", f"{sm['pending']} pending" if sm.get("pending") else ""]
            add(key, "warn", f"{name}: {' and '.join(b for b in bits if b)} sectors. Keep an eye on it")
        if (sm.get("wear") or 0) >= 90:
            add(key + ":wear", "warn", f"{name}: {sm['wear']}% of its rated wear is used")
    for p in snap.get("pools", []):
        if p["health"] != "ONLINE":
            add(f"pool:{p['name']}", "bad", f"ZFS pool {label(labels, 'pool:' + p['name'], p['name'])} is {p['health']}")
    for m in snap.get("md", []):
        if m.get("degraded"):
            add(f"md:{m['name']}", "bad", f"RAID array {m['name']} is degraded (a drive is missing or failed)")
    mem = snap.get("mem") or {}
    if mem.get("total") and mem.get("avail") is not None and mem["avail"] < mem["total"] * 0.05:
        add("mem", "warn", f"Memory is almost full ({_size(mem['avail'])} free)")
    u = snap.get("updates") or {}
    if u.get("security"):
        add("updates:security", "warn", f"{u['security']} security update{'s' if u['security'] != 1 else ''} waiting")
    if (snap.get("reboot") or {}).get("needed"):
        add("reboot", "info", "Needs a restart to finish updating")
    for b in snap.get("backups", []):
        key = f"backup:{b['kind']}:{b['path']}"
        name = b.get("name") or b["path"]
        if b.get("unread"):
            continue
        if b.get("missing"):
            add(key, "warn", f"Backup {name}: {'the folder is missing' if b['kind'] == 'folder' else 'no snapshots found'}")
            continue
        age = _age_hours(b.get("newest"), now)
        if age is None:
            add(key, "warn", f"Backup {name}: nothing in it yet")
        elif age > b["hours"]:
            days = age / 24
            add(key, "warn", f"Backup {name}: the newest is {f'{days:.0f} days' if days >= 2 else f'{age:.0f} hours'} old")
    return out


def drive_health(d: dict) -> str | None:
    """A drive's SMART result in the words of the Health field: "SMART OK, 21k hours"."""
    sm = d.get("smart") or {}
    if sm.get("health") not in ("ok", "failing"):
        return None
    bits = ["SMART OK" if sm["health"] == "ok" else "SMART FAILING"]
    if sm.get("realloc"):
        bits.append(f"{sm['realloc']} reallocated")
    if sm.get("pending"):
        bits.append(f"{sm['pending']} pending")
    if sm.get("wear") is not None:
        bits.append(f"{sm['wear']}% worn")
    if sm.get("hours"):
        bits.append(f"{sm['hours'] / 1000:.0f}k hours" if sm["hours"] >= 1000 else f"{sm['hours']} hours")
    return ", ".join(bits)


# --------------------------------------------------------------------------- one-click changes

_ROOT = 'if [ "$(id -u)" != 0 ]; then echo "HARM_NOT_ROOT"; exit 4; fi\n'

UPGRADE_SCRIPT = _ROOT + r"""export DEBIAN_FRONTEND=noninteractive LC_ALL=C
if command -v apt-get >/dev/null 2>&1; then
  apt-get update -q || exit 1
  if command -v pveversion >/dev/null 2>&1; then how=dist-upgrade; else how="upgrade --with-new-pkgs"; fi
  apt-get -y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold $how || exit 1
  apt-get -y -q autoremove >/dev/null 2>&1
elif command -v dnf >/dev/null 2>&1; then dnf -y upgrade || exit 1
elif command -v pacman >/dev/null 2>&1; then pacman -Syu --noconfirm || exit 1
elif command -v apk >/dev/null 2>&1; then apk update && apk upgrade || exit 1
else echo "HARM_NO_MANAGER"; exit 5
fi
echo HARM_RESULT=upgraded
[ -f /var/run/reboot-required ] && echo HARM_REBOOT=1
exit 0
"""

REBOOT_SCRIPT = _ROOT + r"""echo HARM_RESULT=rebooting
nohup sh -c 'sleep 3; systemctl reboot || shutdown -r now || reboot' >/dev/null 2>&1 &
exit 0
"""


def explain(output: str) -> str | None:
    if "HARM_NOT_ROOT" in output:
        return "That needs administrator rights. Tick “Use sudo” in the connection, or use the root login"
    if "HARM_NO_MANAGER" in output:
        return "HaRM doesn't know this machine's package manager (it knows apt, dnf, pacman and apk)"
    return None
