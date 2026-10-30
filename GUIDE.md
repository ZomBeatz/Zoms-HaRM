# Zom's HaRM: setup and user guide

HaRM (Hardware and Rack Manager) keeps track of your hardware: where every device lives, what's inside it, how it's networked, how to log into it, and what still needs doing. It runs on your own computer. Your phone connects to it over your home Wi-Fi, and nothing is sent to the internet.

**Contents:** [Install on Windows](#install-on-windows) · [Install on Linux](#install-on-linux) · [Run on a server (Docker / service)](#run-on-a-server-docker-or-linux-service) · [First start](#first-start) · [Connect your phone](#connect-your-phone) · [Everyday use](#everyday-use) · [Backups and moving to a new PC](#backups-and-moving-to-a-new-pc) · [Updating](#updating) · [Uninstalling](#uninstalling) · [Troubleshooting](#troubleshooting) · [Security](#security)

---

## Install on Windows

You need Windows 10 or 11 and about 400 MB of disk space. No administrator rights are needed.

1. **Extract the zip somewhere in your user folder**, for example `C:\Users\you\ZomsHaRM`.
   Don't use *Program Files*: HaRM keeps its data next to the app, and Windows doesn't allow that there.
2. Open the folder and **double-click `Install HaRM.cmd`**.
   - If Windows shows *"Windows protected your PC"*, click **More info › Run anyway**. That warning appears for any script downloaded from the internet.
   - If Python isn't installed, the installer offers to install it for you (using Windows' own `winget`). Otherwise, get it from [python.org](https://www.python.org/downloads/) and tick **"Add python.exe to PATH"**.
3. Wait a few minutes while it downloads HaRM's parts (about 150 MB the first time).
4. When it finishes there's a **Zom's HaRM** icon in the Start Menu and on the Desktop.

## Install on Linux

You need Python 3.10 or newer (most distributions have it already).

```bash
tar xzf zoms-harm-1.1.0.tar.gz
cd zoms-harm-1.1.0
./install.sh
```

This sets HaRM up inside its folder and adds **Zom's HaRM** to your app menu (KDE, GNOME, and others). Nothing needs root.

- On Debian/Ubuntu, if it says the venv module is missing: `sudo apt install python3-venv`
- Optional extras: `tesseract` (reads printed text on labels), `zbar` (barcode reading on the server), and `qrencode`. Install them with your package manager if you want them.
- Prefer the terminal or a headless server? Use `./install.sh --no-menu`, then start HaRM with `HARM_HOST=0.0.0.0 HARM_TLS=1 ./run.sh`. There's also a `Dockerfile`.

## Run on a server (Docker or Linux service)

Want HaRM always on, on a home server, NAS or mini PC? There are two ways. Both keep everything in a `data` folder you can back up, and both set up HTTPS by themselves.

### Docker (any OS with Docker: Linux servers, Unraid, TrueNAS SCALE, Synology with Container Manager…)

1. Extract the release on the server.
2. Open `docker-compose.yml` and set `HARM_CERT_NAMES` to the address phones will use: the server's LAN IP and/or hostname, e.g. `"192.168.1.50 harm.lan"`. Set `TZ` to your time zone.
3. Start it:
   ```bash
   docker compose up -d --build
   ```
4. Open `https://<that address>:8077` and create your master password.

- **Data** (database, certificates, daily backups) is in `./data` next to the compose file.
- **Changing the address** later: edit `HARM_CERT_NAMES` and run `docker compose up -d`. The certificate is re-issued, and phones keep trusting it.
- **Updating:** extract the new release over the old one (keep `data`), then `docker compose up -d --build`.
- **Network discovery** (scan / MAC addresses) needs host networking. In `docker-compose.yml`, remove `ports:` and uncomment `network_mode: host`. The UniFi, Proxmox and router-list imports work either way.
- **Behind your own reverse proxy** (Caddy, Traefik, Nginx Proxy Manager)? Set `HARM_TLS: "0"` and let the proxy handle HTTPS.

### Linux service (no Docker)

```bash
./scripts/install-server.sh --names "192.168.1.50 harm.lan"
```

This sets HaRM up in its folder, creates the certificate, and installs a system service that starts at boot and restarts if it stops. It asks for your sudo password once.

- **Logs:** `journalctl -u zoms-harm -f`
- **Stop / start:** `sudo systemctl stop zoms-harm` / `sudo systemctl start zoms-harm`
- **Remove:** `./scripts/install-server.sh --uninstall` (your data stays)

Then connect your phone as below: open `https://<address>:8077/harm-ca.crt` on the phone to get the certificate, and follow **Help & Guide › Troubleshooting** in HaRM for the exact steps per phone.

## First start

1. Open **Zom's HaRM** from the Start Menu or app menu. The control panel opens.
2. Leave the two settings ticked if you want to use a phone:
   - **Let phones and other devices connect**
   - **Use HTTPS** (phones need it for the camera and for installing HaRM as an app)
3. Press **▶ Start**. The first time, HaRM offers to create its HTTPS certificate: choose **Yes**.
   - **Windows:** a firewall prompt appears. Tick **Private networks** and choose **Allow**.
4. Press **Open HaRM ↗**. Your browser warns once about the certificate, because it doesn't know HaRM's private certificate authority yet. On *this* computer it's safe to continue (Advanced › Proceed), or you can set up trust properly with the phone steps below.
5. **Create your master password** (10+ characters). It encrypts your stored logins.
6. **Write down the recovery code** HaRM shows you and keep it somewhere safe. It's the only way back in if you forget the password.
7. Follow the **setup guide**: locations → racks, shelves and bins → networks → devices. It takes about 10 minutes, and you can skip any step.

Closing the control panel window keeps HaRM running in the system tray. Right-click the tray icon to open HaRM, stop it, or quit. Tick **Start HaRM when I log in** if you want it running all the time.

## Connect your phone

In the control panel, press **📱 Phone setup**. (It appears once HaRM is running and shared on your network.) The setup window has:

- **QR codes**, so you never type an address: one downloads HaRM's certificate, the other opens HaRM.
- **Exact steps for Android, Samsung Galaxy and iPhone/iPad** to trust the certificate (once per phone).
- **A checklist that ticks itself off** as your phone connects, downloads the certificate, trusts it, signs in and installs the app. If something isn't working, the checklist says which step and offers a fix button where it can.

When it's done, HaRM sits on your phone's home screen like an app. Long-press the icon for **Scan**, **Devices** and **Tasks** shortcuts.

## Everyday use

**Home** lists what needs attention (IP conflicts, broken gear, warranties ending, things not hooked up, old passwords) next to your open tasks.

**Search** (top bar, or press `/`): type a name, IP, MAC, serial, part number or login. Results appear as you type, and picking one opens that exact item: an IP opens its network entry, a login opens its reveal window.

**+ New** (top right) adds anything, or **scans a label** with the camera: barcodes, QR codes and printed text go straight into the right fields.

**Devices:** each device page starts with a summary (where it is, its IP to copy, the management page, one-tap logins) and has four tabs:
- **Overview:** notes and tasks (type one and press Enter), details, location and purchase info.
- **Hardware:** CPU, memory, drives and drive bays (tap an empty bay to fill it), all installed parts, and expansion slots. Spare parts that fit are suggested.
- **Network:** interfaces (IP, MAC, VLAN), services, and cables.
- **Logins:** **Open ↗** opens the iDRAC/iLO/web page and copies the password in one click. SSH logins give a ready-to-paste command.

The **⋯** button holds the less common actions: Import specs, export/PDF, print a QR label, clone, and delete.

**Import specs** fills in a device's hardware for you. Pick one of three ways:
- **Over SSH** with a saved login.
- **This computer**, for the machine HaRM runs on.
- **Run it yourself:** copy a one-line command, run it on the machine, and paste the result.

**Racks & Storage:** racks show a front/rear picture. Click an empty U to put a device there. Shelves, bins, totes and piles work too.

**🤖 AI Assist** (in **+ New**, Spare Parts, and on location and rack pages) logs a pile of hardware from photos:
1. Copy HaRM's prompt and paste it into any AI app (ChatGPT, Claude, Gemini) with your photos. Turn on web search so it can look up prices.
2. Paste the reply back into HaRM and check the preview.
3. Add. Each item gets its original price, current value, the AI's sources, and its to-dos as tasks.

**Spare Parts:** everything on the shelf or inside devices. Install parts into devices and take them out again; quantities split automatically.

**Virtual & Clusters:** track VMs and containers as devices that **run on** a host (VM ID, vCPUs, memory, disk). A host's **VMs** tab shows what's running on it and how much of its CPU and memory is claimed. Group hosts into **clusters** (Proxmox, Kubernetes, vSphere…). **Discover › Proxmox** imports a whole Proxmox cluster with all its VMs and containers.

**Main address:** if a device has several IPs (OS plus iDRAC, for example), tap the 🌐 address on its page and pick **☆ Main**. That one is used for quick links, logins and lists. Management ports are never picked automatically.

**Networks & IPs** keeps subnets and VLANs, with an IP map showing who uses what and the next free addresses. **Discover** brings in what's on your network from **any router** (paste its client or DHCP list: pfSense, OPNsense, OpenWrt, Pi-hole, MikroTik, Omada, ordinary home routers), a **UniFi** console (API key), **Proxmox**, or a **network scan**. Phones, tablets, TVs, consoles and smart-home gear are recognised by name. You review everything before it's saved.

**PC Builder:** plan builds from about 30,000 library parts or your own spares, with compatibility checks. **Create device** turns a finished build into a real device.

**Export & Share:** copy devices as text for a person or an AI assistant, download CSV/JSON, or print a spec sheet or sell sheet to PDF.

**Settings:** password, two-factor login, recovery code, and appearance (dark or light). There may also be something to find if you click the logo enough.

## Backups and moving to a new PC

- HaRM **backs itself up daily** into `data/backups/` and keeps the last 14.
- **Settings › Backup** downloads a copy whenever you want one. Keep a copy on another drive or computer now and then.
- **To move HaRM**, copy the whole `data` folder into the new installation's folder before starting it. That brings your database, certificates (so phones keep trusting it) and backups. Your master password stays the same.

## Updating

1. Stop HaRM: in the control panel press **Stop**, then Quit from the tray.
2. Extract the new version **over** your current HaRM folder, replacing the files. Your `data` folder isn't in the download, so it's kept.
3. Run the installer again (`Install HaRM.cmd` or `./install.sh`) to pick up new parts.
4. Start HaRM. Open browser tabs and the phone app show a **⟳ Reload** banner.

## Uninstalling

- **Windows:** double-click `Uninstall HaRM.cmd` (removes the shortcuts and stops HaRM), then delete the HaRM folder.
- **Linux:** run `./scripts/install-desktop-app.sh --uninstall`, then delete the HaRM folder.

Back up `data/` first if you might want your inventory again.

## Troubleshooting

HaRM has these steps built in too: **Help & Guide › Troubleshooting**, the **Show troubleshooting steps** button when HaRM can't start on a device, and **Still not working?** in the desktop app's Phone setup.

| Problem | Fix |
|---|---|
| The phone shows "Your connection is not private" | The certificate isn't trusted on the phone yet. Open **Phone setup**, do step 2, then fully close and reopen Chrome. |
| The phone can't connect at all | Same Wi-Fi as the computer? **Phone setup**'s checklist checks sharing, HTTPS, the certificate and the firewall. On Windows, allow Python in *Windows Security › Firewall › Allow an app*. |
| iPhone/iPad: works in Safari but the home-screen app says "Cannot reach the HaRM server" | The certificate isn't fully trusted. Check **Settings › General › About › Certificate Trust Settings** and turn on *Zom's HaRM local CA*. If it isn't listed, redo **Phone setup** step 2. Then delete the home-screen icon and add it again from Safari. |
| iPhone/iPad home-screen icon is just a letter ("H") | iOS couldn't fetch the icon because it doesn't trust HaRM's certificate yet. Do **Phone setup** step 2 (iPhone / iPad), remove the home-screen icon, then open HaRM in Safari and Add to Home Screen again. |
| The computer's IP address changed | The control panel shows **Fix certificate**. Click it. Phones keep trusting HaRM. Better still, give the computer a fixed IP in your router. |
| "Port in use" | Another program uses port 8077. Change **Port** in the control panel's settings. |
| HaRM won't start | Open **Server log** at the bottom of the control panel. It shows the reason. |
| Forgot the master password | On the unlock screen choose **Use the recovery code**. |
| Lost the password *and* the recovery code | Stored logins can't be recovered; that's what keeps them safe. Everything else is still readable from a backup. |

## Security

- Logins are encrypted (AES-256-GCM) with a key that only your master password or recovery code unlocks. Nobody can read them from a copied database.
- HaRM locks itself after 30 minutes idle. Optional two-factor login is in **Settings**.
- Every change, sign-in and password reveal is recorded in the **Audit Log**.
- Only install HaRM's certificate on **your own** devices. Keep `data/tls/harm-ca.key` private: anyone with that file could impersonate websites to phones that trust it.
- HaRM is meant for your home network. Don't expose it directly to the internet. For access away from home, use a VPN into your home network (for example your router's VPN).
