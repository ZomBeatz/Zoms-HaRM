# Zom's HaRM: Hardware and Rack Manager

A self-hosted, single-owner web app for tracking your computer and network
hardware: where it lives, how it's racked, what's inside it, what it runs, how
it's cabled, and how to log into it. It also tracks spare parts and tells you
which ones fit in which devices.

## What it tracks

| Area | Details |
|---|---|
| **Locations** | Nested tree: site > building > room > closet… Each room has a page listing its holders plus **loose** devices and parts (piles, desks, the floor), each with a “spot” note. |
| **Racks & Storage** | Anything that holds hardware: racks and cabinets (with U heights), shelves, bins, totes, drawers, desks, piles. In forms, the holder list is filtered to the chosen location. Racks get a front/rear elevation view where you click an empty U to add or place a device. |
| **Devices** | Type, make/model, serial, asset tag, status (Active/Standby/Spare/In Repair/Broken/Retired…), **hooked up** toggle, hostname, OS, CPU/RAM/storage, PSU and power draw, management URL, purchase/vendor/warranty, tags, notes. Rack placement checks bounds and overlaps, including front vs. rear and full-depth gear. |
| **Slots & bays** | What a device can take: e.g. 12× SAS3 3.5" bays, 8× DDR4 RDIMM, 1× PCIe x16. Shows used/total. |
| **Parts inventory** | Drives, RAM, CPUs, NICs, HBAs, PSUs, transceivers, cables… with capacity, interface (SATA, SAS, NVMe, DDR4, SFP+…), form factor, quantity, condition, health, where it's stored. Install into a device (it splits quantities) or remove back to a shelf or bin. |
| **Compatibility** | Each device slot lists in-stock spares that fit. Each spare part shows which devices have a free slot for it. Matching understands that SAS backplanes take SATA drives, a PCIe x16 slot takes x8/x4/x1 cards, and generic vs. specific names ("SATA" vs "SATA III"). |
| **Networks & IPs** | Subnets/VLANs/Wi-Fi with gateway, DHCP pool, DNS, domain, IPv6 prefix. Each has an IP map showing who uses which address, duplicates, static IPs inside the DHCP pool, and the next free addresses. |
| **Interfaces** | Per device: IPv4 (accepts `/prefix`), IPv6, assignment (static/reservation/DHCP), gateway, DNS servers and name, MAC (normalized), speed, MTU, PoE, link state, parent bond/bridge, Wi-Fi SSID, access VLAN or trunk native/tagged VLANs. Linked to networks automatically from the IP. |
| **Services** | Name, protocol/port, URL, version, status. |
| **Connections** | Cables between device ports (or to an untracked endpoint like "ISP modem"): medium (Cat6, DAC, OM4, SFF-8643, C13…), label, length, color, speed. |
| **AI Assist** | Photos → inventory with any AI chat app: HaRM writes a prompt (with where things are stored and its own categories), the AI identifies each item from your photos, reads labels and looks up the original price and current used value with sources. Paste the reply back for a preview (confidence, duplicate serials flagged, 📷 to scan missing serials), then add everything in one go, with research saved as notes and the AI's to-dos as tasks. Devices and parts gain **Original price**, **Current value** and **Value checked** fields. |
| **Discover** | Bring devices in from **any router** (paste its client/DHCP lease list: pfSense, OPNsense, OpenWrt, Pi-hole, MikroTik, Omada, home routers, `arp -a`), a **UniFi** console (API key), **Proxmox** (cluster, nodes, VMs, containers via a read-only token), or a **network scan**. Matches existing devices by MAC/IP/name; phones, tablets, TVs, consoles and smart-home gear are recognised by name. You review before anything is saved. |
| **Virtual & Clusters** | VMs and containers as devices that run on a host (VM ID, vCPU, memory, disk; no rack space). Host pages show their guests and CPU/memory overcommit; clusters group hosts with combined resources. **Main address** per device keeps iDRAC/iLO ports out of quick links. |
| **Vault** | Logins and secrets per device/service: username, password, TOTP 2FA secret (shows live codes), encrypted notes, last-rotated date. Includes a password generator. **Open ↗** launches what a login is for (management page, service URL, SSH command or `ssh://` link, `.rdp` file) and copies the password on the same click. |
| **Home** | One **Needs attention** list (IP conflicts, broken or in-repair devices, warranties ending within 90 days, active gear not hooked up, logins not changed in a year) next to your open tasks, plus rack space, spares and storage. Breakdowns and recent activity are folded under **More**. |
| **Search** | One box for devices, IPs, MACs, serials, services, parts, holders, locations, and credentials. |
| **Notes & tasks** | A journal on every device, rack and room: notes, tasks (tick them off), actions taken ("replaced PSU 2") and issues. Type and press Enter. Open tasks appear on the dashboard and the Tasks page; marking a drive failed adds an issue automatically. |
| **Processors & memory** | CPUs come from the library (it also has common server CPUs: Opteron 4100 to 4300 and 6100, Xeon 5500/5600/X3400/E5 v1 to v4/Scalable, EPYC) or from specs you enter. Totals are shown, e.g. "2 × Opteron 4234 = 12 cores / 12 threads". Memory is grouped by size and type with totals and a slot map. |
| **Drive bays** | Named bay groups (Front, Rear…) that can accept several connections (SAS/SATA), each with its own RAID/controller label, a tap-to-fill bay map, per-array totals and a RAID calculator. You can mark a single drive in a bay as failed. |
| **QR labels** | Print stickers with name, model, serial, IP and a QR code that opens the device in HaRM. |
| **Calm layout** | The sidebar groups everyday pages (Inventory, Network) and folds the rest under **More**. Phones get a bottom bar (Home, Devices, Racks, Tasks). Device pages open with a summary (where it is, IP, management link, one-tap logins) and tabs: Overview, Hardware, Network, Logins. Rarely used actions sit in a **⋯** menu. |
| **Themes** | **ZomBeatz** (brand blue with orange highlights) in dark (default), light, or matching the system, chosen in Settings > Appearance and saved per device. There's also a hidden theme to find. Logos are in `branding/` (`make-logos.py` rebuilds them). |
| **Installable app** | Works as a phone app (PWA) once the phone trusts HaRM's certificate (Settings > Phone app walks you through it, and `/harm-ca.crt` downloads the CA). Long-press shortcuts open Scan, Devices and Tasks. |
| **Automatic backups** | A daily snapshot goes to `data/backups/` (newest 14 kept; set `HARM_BACKUP_KEEP`, or `HARM_AUTO_BACKUP=0` to turn it off). |
| **Import specs** | From the device page: **Over SSH** (HaRM connects with a saved vault login or SSH keys, runs the read-only collector with optional sudo, Linux/macOS/Windows OpenSSH; host keys pinned in `data/ssh/known_hosts`), **This computer** (the HaRM server itself), or run a small read-only script yourself and paste its output. It fills in hostname, OS, model, serial, CPU and RAM, and adds each drive, memory stick, GPU and network card (IP and MAC). Already-recorded serials and MACs are skipped. Scripts are in `harm/static/collect/` and are served by HaRM. |
| **Storage math** | Drive sizes are standardized ("4tb" becomes "4 TB"; tap-to-pick sizes). Every device has a Storage card with drives grouped by size, the raw total, and a usable-capacity calculator for JBOD, RAID 0/1/5/6/10 and RAIDZ1-3. Spare Parts and the dashboard show totals too. |
| **Export & Share** | Choose devices (by location, rack, type, status) and what to include, then copy Markdown for a person or AI assistant, or download Markdown, CSV or JSON. You can also print a spec sheet or a sell sheet (with asking prices) to PDF. Secrets are never exported. |
| **PC Builder** | PCPartPicker-style parts lists built from the parts library, your spare-parts inventory, or custom parts. Compatibility checks: CPU socket against board and cooler; memory type, slots, capacity, SO-DIMM, ECC/RDIMM; board size, GPU length and cooler height against the case; PSU form factor, length, wattage (against an estimated power draw) and GPU power connectors; M.2 slots and sizes; SATA ports; drive bays; SAS without an HBA; video output. The picker can hide incompatible parts. Track Have / Need / Ordered, prices and budget. **Create device** turns a finished build into a device with its motherboard slots and parts installed. |
| **Parts library** | About 30,000 parts with specs from [BuildCores OpenDB](https://github.com/buildcores/buildcores-open-db), downloaded on demand. Add your own custom parts, or copy and correct library parts. Inventory parts can be linked to library parts (**Find in library**). |
| **Scanning** | Camera buttons on serial, part number, model, asset tag and MAC fields, plus a whole-label scan that sorts values into fields. Barcodes and QR codes are decoded on the phone (ZXing) and on the server (zbar); printed text is read by tesseract. Photos are never stored. |
| **Guides** | A setup wizard (locations → holders → networks → devices → security) and an in-app help guide. |
| **Forms** | Closing a changed form asks Keep editing / Discard / Save. Typing is also kept as a local draft and restored if the form closes anyway (auto-lock, phone tab reload). Secrets are never drafted. **Save & add another** carries shared fields forward for bulk entry. |
| **Audit log** | Every create, update and delete, plus logins, failed logins, secret reveals, exports and backups. |

## Install (for users)

The full guide, with pictures, is at **[zombeatz.github.io/zombeatz-docs/harm](https://zombeatz.github.io/zombeatz-docs/harm/)**. A copy for offline use is in **[GUIDE.md](GUIDE.md)**. Download the release, then follow it, which covers setup, first start, phone setup, everyday use, backups, updates and troubleshooting.

- **Windows:** extract the zip to your user folder and double-click `Install HaRM.cmd`.
- **Linux:** `./install.sh`

Run it on a server with **Docker** (`docker compose up -d --build`) or as a **Linux service** (`./scripts/install-server.sh`): see GUIDE.md > Run on a server.

Try it with made-up data first: `python3 scripts/demo.py` (opens on http://127.0.0.1:8099, password `demo-password`).

Build a release yourself with `python3 scripts/package.py` (writes `dist/zoms-harm-<version>.zip` and `.tar.gz`; your `data/` folder is never included). Tests: `.venv/bin/python tests/smoke.py` (quick) and `tests/full_test.py` (every feature).

## Run it

```bash
./run.sh
```

Then open <http://127.0.0.1:8077>. The first visit asks you to create a master
password and shows a **one-time recovery code**. Save it offline.

On first run, `run.sh` creates `.venv` and installs `requirements.txt`. Data
lives in `data/harm.db` (the directory is `0700` and the file is `0600`).

Settings come from environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `HARM_HOST` | `127.0.0.1` | Bind address |
| `HARM_PORT` | `8077` | Port |
| `HARM_DB` | `data/harm.db` | Database path |
| `HARM_IDLE_MINUTES` | `30` | Auto-lock after inactivity |
| `HARM_MAX_SESSION_HOURS` | `12` | Hard session limit |
| `HARM_SECURE_COOKIE` | `auto` | `auto` marks the cookie `Secure` when the request came over HTTPS |
| `HARM_TRUSTED_PROXIES` | `127.0.0.1` | Proxies whose `X-Forwarded-*` headers are trusted |
| `HARM_TLS` | `0` | `1` serves HTTPS using `data/tls/harm.crt` + `harm.key` (override with `HARM_TLS_CERT` / `HARM_TLS_KEY`) |

### Parts library

The PC Builder's library is downloaded into your own database on demand from
**Parts Library > Download library** (about 16 MB; this is the only feature that
needs internet access). You can also run it from the command line, or import a
snapshot you downloaded yourself:

```bash
.venv/bin/python -m harm.pcbuild update
.venv/bin/python -m harm.pcbuild update --file buildcores-open-db-main.tar.gz
```

PCPartPicker has no public API and its terms don't allow scraping, so HaRM
uses BuildCores OpenDB instead. The data is licensed **CC BY-NC-SA 4.0**:
personal, non-commercial use is fine, and if you share the data publicly you
must credit BuildCores. It isn't bundled with HaRM. Prices aren't included, so
enter your own. Library specs can have gaps (radiator support, for example), so
treat the checks as a strong hint rather than a guarantee.

### Using it from your phone

Live camera scanning needs HTTPS. Photo scanning works over plain HTTP too. To
serve HTTPS on your network:

```bash
./scripts/make-cert.sh harm.lan 192.168.1.50   # the names/IPs you'll type on the phone
HARM_HOST=0.0.0.0 HARM_TLS=1 ./run.sh
```

Then open `https://192.168.1.50:8077` on the phone. To stop the certificate
warning, install `data/tls/harm-ca.crt` on the phone as a trusted CA:

- **iOS:** Settings > Profile Downloaded > Install, then Settings > General >
  About > Certificate Trust Settings.
- **Android:** Settings > Security > Install a certificate > CA certificate.

Use "Add to Home Screen" for an app icon. Label text recognition needs
`tesseract` on the server, and the server-side barcode reader needs `zbarimg`.
The Docker image includes both.

### Docker

```bash
docker compose up -d --build
```

This publishes on `127.0.0.1:8077` only, and data persists in `./data`.

### Exposing it on your LAN

Keep HaRM bound to localhost and put a TLS reverse proxy in front. A Caddy
example:

```
harm.lan {
    tls internal
    reverse_proxy 127.0.0.1:8077
}
```

The proxy must pass the original `Host` header through, which Caddy and nginx
do by default. HaRM rejects cross-origin writes. Don't expose it to the
internet; if you need remote access, reach it over a VPN into your home network (for
example your router's VPN).

### Desktop app (Linux)

A control panel with its own icon, so you don't need a terminal: Start / Stop / Restart, **Open HaRM**, the addresses to use on your phone (with Copy buttons), a one-click fix when the HTTPS certificate doesn't cover the PC's current IP, a **Phone setup** guide (QR codes for the certificate and for HaRM, steps for Android, Samsung and iPhone, and a checklist that ticks itself off by watching the server: running, shared, HTTPS, certificate, firewall, then phone connected, certificate downloaded, certificate trusted, signed in, installed as an app), the server log, and a tray icon so HaRM keeps running after you close the window. Optional **Start HaRM when I log in**.

```bash
./scripts/install-desktop-app.sh              # adds "Zom's HaRM" to the app menu
./scripts/install-desktop-app.sh --uninstall  # removes it
```

Needs PySide6 (`sudo pacman -S pyside6` on Arch/CachyOS). The panel finds a server started from a terminal too, and settings are kept in `data/launcher.json`.

## Security model

- **Encryption at rest.** A random 256-bit data key encrypts every password,
  TOTP secret and secret note with AES-256-GCM. Each field is bound to its
  field name as associated data.
- **The data key is never stored in plaintext.** It is wrapped by a key derived
  from your master password (scrypt, N=2^16, r=8), and a second copy is
  wrapped by a key derived from your recovery code. The master password itself
  is not stored, only a hash of a separate derived verifier.
- **The server needs your password.** After a restart, nothing can be decrypted
  until you unlock again. The unwrapped key lives only in server memory, tied
  to your session.
- **Optional 2FA (TOTP) for unlocking.** Its secret is also encrypted with the
  data key. Used codes can't be replayed.
- **Recovery.** The recovery code resets the master password, turns off 2FA,
  rotates the recovery code, and ends all sessions.
- **Sessions.** Random 256-bit token in an `HttpOnly`, `SameSite=Strict` cookie
  (`Secure` over HTTPS). Sessions lock after the idle timeout or the hard
  limit, both server-side and in the browser.
- **Brute-force protection.** After 5 failures, login, recovery and password
  confirmation back off exponentially per IP, up to 15 minutes.
- **Scanning.** Uploaded photos go to a private temp file, are read by zbar and
  tesseract, and are deleted. Only JPEG, PNG and WebP up to 15 MB are accepted.
  Drafts of unsaved forms live in the browser's local storage on that device
  and never include passwords, 2FA secrets or secret notes.
- **Web hardening.** Strict CSP with no inline scripts or styles, so the
  frontend never uses `innerHTML`. Every write needs a custom header (CSRF).
  `X-Frame-Options: DENY`, `no-referrer`, and `no-store` on API responses. API
  docs are disabled.
- **Backups.** Settings > Backup downloads a consistent SQLite snapshot.
  Secrets stay encrypted inside it and only your master password or recovery
  code opens them. CSV exports never include secrets, and cells are escaped
  against spreadsheet formula injection.

**If you lose both the master password and the recovery code, the stored
logins are unrecoverable.** Your hardware inventory is unaffected because only
secrets are encrypted.

## Layout

```
harm/
  main.py      FastAPI app: auth, sessions, security middleware, CRUD, rack/slot logic
  models.py    Entity definitions (fields, joins, search) and suggestion lists
  crypto.py    scrypt key derivation, AES-GCM, key wrapping, recovery codes
  pcbuild.py   Parts library import (OpenDB), spec normalisation, build compatibility checks
  collect.py   Parser for the spec-collector output
  units.py     Size parsing/formatting and snapping to marketed drive sizes
  static/sw.js Service worker (app shell only; API data is never cached)
tests/smoke.py End-to-end smoke test on a throwaway database
  static/collect/  harm-collect.sh (Linux/macOS) and harm-collect.ps1 (Windows)
  db.py        SQLite schema and helpers
  static/      Frontend: index.html, app.js (vanilla JS, no build step), style.css
  static/vendor/  ZXing barcode decoder 0.23.0 (Apache-2.0), loaded only when scanning
scripts/make-cert.sh  Local CA + HTTPS certificate for phone access
run.sh         Local launcher
Dockerfile, docker-compose.yml
```
