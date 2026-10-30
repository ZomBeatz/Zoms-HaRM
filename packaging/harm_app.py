"""The program inside the installers: Zom's HaRM's control panel, plus its server and certificate tools.

    zoms-harm                       the control panel (what the Start Menu / app menu opens)
    zoms-harm --background          the control panel in the tray, starting the server (used at login)
    zoms-harm --open                start the server if needed and open HaRM in the browser
    zoms-harm --server harm.main:app --host … --port …   the HaRM server (the panel starts it this way)
    zoms-harm --certs NAME…         make or check the HTTPS certificate (like python -m harm.certs)

PyInstaller freezes this file (packaging/zoms-harm.spec). Data goes in the person's own folder,
never next to the program: see harm.db.data_dir().
"""

import sys


def _stdio() -> None:
    """A windowed program may start without stdout/stderr; write to HARM_LOG (or nowhere) instead of crashing."""
    import os

    if sys.stdout is None or sys.stderr is None:
        out = open(os.environ.get("HARM_LOG") or os.devnull, "a", buffering=1, encoding="utf-8", errors="replace")
        sys.stdout = sys.stdout or out
        sys.stderr = sys.stderr or out


def main() -> int:
    args = sys.argv[1:]
    _stdio()
    if args[:1] == ["--server"]:
        import uvicorn.main

        sys.argv = ["uvicorn", *args[1:]]
        return uvicorn.main.main()  # exits by itself
    if args[:1] == ["--certs"]:
        from harm import certs

        return certs.main(args[1:])
    if args[:1] == ["--version"]:
        from harm import __version__

        print(__version__)
        return 0
    import harm_launcher  # frozen in from launcher/ (see the spec's pathex)

    return harm_launcher.main()


if __name__ == "__main__":
    sys.exit(main())
