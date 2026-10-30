"""Build release archives for other users: dist/zoms-harm-<version>.zip (Windows) and .tar.gz (Linux).

    python3 scripts/package.py

Only the app is packed. Your data/ folder (database, certificates, backups), .venv/ and caches
are never included.
"""
import re
import stat
import tarfile
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VERSION = re.search(r'__version__ = "([^"]+)"', (ROOT / "harm" / "__init__.py").read_text()).group(1)
NAME = f"zoms-harm-{VERSION}"
INCLUDE = ["harm", "launcher", "scripts", "tests", "branding", "README.md", "GUIDE.md", "requirements.txt",
           "requirements-desktop.txt", "run.sh", "install.sh", "Install HaRM.cmd", "Uninstall HaRM.cmd",
           "Dockerfile", "docker-compose.yml", ".dockerignore", "docker"]
SKIP_DIRS = {"__pycache__", "old-icons", ".pytest_cache"}
SKIP_FILES = re.compile(r"\.(pyc|db|db-wal|db-shm|log)$")
EXECUTABLE = re.compile(r"(\.sh|harm_launcher\.py)$")  # also docker/entrypoint.sh


def files():
    for item in INCLUDE:
        p = ROOT / item
        if not p.exists():
            raise SystemExit(f"missing: {item}")
        if p.is_file():
            yield p
            continue
        for f in sorted(p.rglob("*")):
            if f.is_file() and not SKIP_DIRS & set(f.relative_to(ROOT).parts) and not SKIP_FILES.search(f.name):
                yield f


def main():
    dist = ROOT / "dist"
    dist.mkdir(exist_ok=True)
    listing = list(files())
    bad = [f for f in listing if "data" == f.relative_to(ROOT).parts[0] or f.name in ("launcher.json", "server.json")]
    assert not bad, f"refusing to pack user data: {bad}"
    zpath, tpath = dist / f"{NAME}.zip", dist / f"{NAME}.tar.gz"
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for f in listing:
            info = zipfile.ZipInfo(f"{NAME}/{f.relative_to(ROOT).as_posix()}", time.localtime(f.stat().st_mtime)[:6])
            mode = 0o755 if EXECUTABLE.search(f.name) else 0o644
            info.external_attr = (stat.S_IFREG | mode) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, f.read_bytes())
    with tarfile.open(tpath, "w:gz") as t:
        for f in listing:
            ti = t.gettarinfo(str(f), f"{NAME}/{f.relative_to(ROOT).as_posix()}")
            ti.mode = 0o755 if EXECUTABLE.search(f.name) else 0o644
            ti.uid = ti.gid = 0
            ti.uname = ti.gname = ""
            with open(f, "rb") as fh:
                t.addfile(ti, fh)
    for p in (zpath, tpath):
        print(f"{p.relative_to(ROOT)}  {p.stat().st_size / 1e6:.1f} MB  ({len(listing)} files)")


if __name__ == "__main__":
    main()
