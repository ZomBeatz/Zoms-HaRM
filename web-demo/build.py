"""Build the online demo: HaRM's web app plus its real Python server, run in the browser by Pyodide.

    python3 web-demo/build.py                 # writes demo-site/ (open it with any static web server)
    python3 web-demo/build.py --out site --python .venv/bin/python

The demo is made from the current code every time, so it always matches the app. GitHub publishes
it with .github/workflows/demo.yml. To try it locally:
    python3 web-demo/build.py && python3 -m http.server -d demo-site 8095   (then open http://127.0.0.1:8095)
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HERE = ROOT / "web-demo"
STATIC = ROOT / "harm" / "static"
# Pure-Python packages HaRM needs that Pyodide doesn't ship (it has FastAPI, cryptography and sqlite).
WHEELS = ["pyotp==2.10.0"]


def page(out: Path) -> None:
    """The app's own page (the built interface in static/app/), with paths made relative so the demo
    works in a sub-folder (/Zoms-HaRM/). The app itself reads files from static/ when window.harmDemo is set."""
    shutil.copytree(STATIC, out / "static", ignore=shutil.ignore_patterns("sw.js", "index.html", "__pycache__"))
    html = (STATIC / "app" / "index.html").read_text()
    html = re.sub(r'\s*<link rel="manifest"[^>]*>', "", html)
    html = html.replace('"/static/', '"static/').replace('"/apple-touch-icon.png"', '"static/apple-touch-icon.png"')
    html = html.replace("<title>Zom's HaRM</title>", "<title>Zom's HaRM · Online demo</title>")
    # The demo's worker must answer /api/ before the app starts, so its script goes before the app's.
    html = html.replace('  <script type="module"',
                        '  <link rel="stylesheet" href="demo/demo.css">\n'
                        '  <script src="demo/demo-boot.js"></script>\n'
                        '  <script type="module"', 1)
    if "demo/demo-boot.js" not in html:
        raise SystemExit("static/app/index.html changed shape: couldn't add the demo script. Update page() in web-demo/build.py.")
    html = html.replace('<div class="boot">Loading…</div>', '<div class="boot">Starting the online demo…</div>')
    (out / "index.html").write_text(html)


def code(out: Path) -> str:
    """HaRM's Python package plus the bridge, zipped for the worker."""
    target = out / "demo" / "harm.zip"
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted((ROOT / "harm").glob("*.py")):
            z.write(f, f"harm/{f.name}")
        z.write(HERE / "bridge.py", "harm_demo_bridge.py")
    return target.name


def wheels(out: Path, python: str) -> list[str]:
    d = out / "demo" / "wheels"
    subprocess.run([python, "-m", "pip", "download", "--quiet", "--no-deps", "--only-binary=:all:", "-d", str(d), *WHEELS],
                   check=True)
    return [f"wheels/{w.name}" for w in sorted(d.glob("*.whl"))]


def data(out: Path, python: str) -> str:
    """The made-up home lab from scripts/demo.py, filled in by the real server."""
    target = out / "demo" / "demo.db"
    subprocess.run([python, str(ROOT / "scripts" / "demo.py"), "--save", str(target), "--port", os.environ.get("DEMO_BUILD_PORT", "8096")],
                   check=True, cwd=ROOT)
    return target.name


def stamp(out: Path) -> None:
    """Add ?v=<hash of the site> to the page's scripts and styles, so a new demo isn't mixed with cached old files."""
    h = hashlib.sha256()
    for f in sorted(p for p in out.rglob("*") if p.is_file() and p.name != "index.html"):
        h.update(f.relative_to(out).as_posix().encode() + f.read_bytes())
    v = h.hexdigest()[:10]
    index = out / "index.html"
    index.write_text(re.sub(r'((?:src|href)="(?:static|demo)/[^"?]+\.(?:js|css))"', rf'\1?v={v}"', index.read_text()))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", default=str(ROOT / "demo-site"))
    ap.add_argument("--python", default=None, help="Python with HaRM's requirements (default: .venv, else this one)")
    args = ap.parse_args()
    venv = ROOT / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    python = args.python or (str(venv) if venv.exists() else sys.executable)
    out = Path(args.out).resolve()
    if out.exists():
        shutil.rmtree(out)
    (out / "demo").mkdir(parents=True)
    page(out)
    for f in ("worker.js", "demo-boot.js", "demo.css"):
        shutil.copy(HERE / f, out / "demo" / f)
    build = {"code": code(out), "db": data(out, python), "wheels": wheels(out, python)}
    # New demo data each build: visitors' saved changes are kept only until the next published demo.
    build["seed"] = hashlib.sha256((out / "demo" / build["db"]).read_bytes()).hexdigest()[:16]
    (out / "demo" / "build.json").write_text(json.dumps(build, indent=2))
    stamp(out)
    (out / ".nojekyll").write_text("")
    print(f"Online demo built in {out}")


if __name__ == "__main__":
    main()
