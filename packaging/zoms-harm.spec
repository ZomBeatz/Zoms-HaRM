# PyInstaller recipe for the installers: one folder with Python, HaRM, its server and the Qt control panel.
#   pyinstaller --noconfirm packaging/zoms-harm.spec      (run from the repository root)
# The result is dist/zoms-harm/, which the Windows (Inno Setup) and Linux (nfpm, AppImage) steps wrap.
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules

ROOT = Path(SPECPATH).resolve().parent
WINDOWS = sys.platform == "win32"

a = Analysis(
    [str(ROOT / "packaging" / "harm_app.py")],
    pathex=[str(ROOT), str(ROOT / "launcher")],
    datas=[
        (str(ROOT / "harm" / "static"), "harm/static"),
        (str(ROOT / "branding" / "harm-icon.svg"), "branding"),
        (str(ROOT / "branding" / "harm-icon-256.png"), "branding"),
        (str(ROOT / "launcher" / "check.svg"), "launcher"),
    ],
    # uvicorn loads harm.main by name, so list it (and the server packages) for PyInstaller to follow.
    hiddenimports=["harm_launcher", "harm.main", "pyotp", *collect_submodules("harm"), *collect_submodules("uvicorn")],
    excludes=["tkinter", "PySide6.QtWebEngineCore", "PySide6.Qt3DCore", "PySide6.QtQuick", "PySide6.QtQml"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, [],
    exclude_binaries=True,
    name="zoms-harm",
    console=False,  # no terminal window; the server's output goes to its log file
    icon=str(ROOT / "branding" / ("harm.ico" if WINDOWS else "harm-icon-256.png")),
)
coll = COLLECT(exe, a.binaries, a.datas, name="zoms-harm")
