# Zom's HaRM: setup and user guide

HaRM (Hardware and Rack Manager) keeps track of your hardware: where every device lives, what's inside it, how it's networked, how to log into it, and what still needs doing. It runs on your own computer. Your phone connects to it over your home Wi-Fi, and nothing is sent to the internet.

To look around first, the **[live demo](https://zombeatz.github.io/Zoms-HaRM/)** runs HaRM in your browser with made-up data (password `demo-password`), or run `python3 scripts/demo.py` for the same demo on your computer.

The full guide, with pictures and a page for every feature, is online at https://docs.zombeatzmedia.com/harm/. This copy covers the essentials for offline use.

**Contents:** [Install on Windows](#install-on-windows) · [Install on Linux](#install-on-linux) · [Run on a server (Docker / service)](#run-on-a-server-docker-or-linux-service) · [First start](#first-start) · [Connect your phone](#connect-your-phone) · [Everyday use](#everyday-use) · [Backups and moving to a new PC](#backups-and-moving-to-a-new-pc) · [Updating](#updating) · [Uninstalling](#uninstalling) · [Troubleshooting](#troubleshooting) · [Security](#security)

---

## Install on Windows

You need Windows 10 or 11 (64-bit) and about 400 MB of disk space. No administrator rights are needed, and nothing else has to be installed first.

1. From the [latest release](https://github.com/ZomBeatz/Zoms-HaRM/releases/latest), download **`Zoms-HaRM_(version)_x64-setup.exe`**.
2. Open it. If Windows shows *"Windows protected your PC"*, click **More info > Run anyway**. The warning appears because the file isn't signed with a paid certificate yet; it's built by GitHub from HaRM's public code.
3. Click **Install**, then **Finish** with **Run Zom's HaRM** ticked.

HaRM is now in the Start Menu, and in **Settings > Apps** like any other app.

## Install on Linux

Download the file for your system from the [latest release](https://github.com/ZomBeatz/Zoms-HaRM/releases/latest):

| Your system | File | How |
|---|---|---|
| Ubuntu, Mint, Debian | `zoms-harm_(version)_amd64.deb` | Open it in your software installer and click **Install**. |
| Fedora, openSUSE | `zoms-harm-(version)-1.x86_64.rpm` | Open it in your software installer and click **Install**. |
| Any other | `Zoms-HaRM_(version)_amd64.AppImage` | Right-click > **Properties** > allow running it as a program, then double-click it. |

**Zom's HaRM** is then in your app menu. Optional extras: `tesseract` (reads printed text on labels), `zbar` (barcode reading on the server) and `qrencode`. Install them with your package manager if you want them; HaRM says where they help.

**Running HaRM from its source code instead** (developers, or a headless machine): extract the source archive and run `./install.sh` (Linux) or **Install HaRM.cmd** (Windows). Those keep data in the `data` folder next to the code.

## Run on a server (Docker or Linux service)

Want HaRM always on, on a home server, NAS or mini PC? There are two ways. Both keep everything in a `data` folder you can back up, and both set up HTTPS by themselves.

### Docker (any OS with Docker: Linux servers, Unraid, TrueNAS SCALE, Synology with Container Manager…)

1. Make a folder for HaRM on the server and download [`docker-compose.yml`](https://github.com/ZomBeatz/Zoms-HaRM/raw/main/docker-compose.yml) into it.
2. Open `docker-compose.yml` and set `HARM_CERT_NAMES` to the address phones will use: the server's LAN IP and/or hostname, e.g. `"192.168.1.50 harm.lan"`. Set `TZ` to your time zone.
3. Start it:
   ```bash
   docker compose up -d
   ```
   Docker downloads HaRM's image (built by GitHub, for PCs and Raspberry Pis).
4. Open `https://<that address>:8077` and create your master password.

- **Data** (database, certificates, daily backups) is in `./data` next to the compose file.
- **Changing the address** later: edit `HARM_CERT_NAMES` and run `docker compose up -d`. The certificate is re-issued, and phones keep trusting it.
- **Updating:** `docker compose pull && docker compose up -d`. Your `data` folder is kept.
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

Then connect your phone as below: open `https://<address>:8077/harm-ca.crt` on the phone to get the certificate, and follow **Help & Guide > Troubleshooting** in HaRM for the exact steps per phone.

## First start

1. Open **Zom's HaRM** from the Start Menu or app menu. The control panel opens.
2. Leave the two settings ticked if you want to use a phone:
   - **Let phones and other devices connect**
   - **Use HTTPS** (phones need it for the camera and for installing HaRM as an app)
3. Press **▶ Start**. The first time, HaRM offers to create its HTTPS certificate: choose **Yes**.
   - **Windows:** a firewall prompt appears. Tick **Private networks** and choose **Allow**.
4. Press **Open HaRM ↗**. Your browser warns once about the certificate, because it doesn't know HaRM's private certificate authority yet. On *this* computer it's safe to continue (Advanced > Proceed), or you can set up trust properly with the phone steps below.
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

**When the phone is the better tool:** wherever the hardware is. At the rack, search finds a device by name, IP, serial or MAC, and its **Network** tab lists every port. At a console, a device's **Logins > Open** copies the password. When parts arrive or you sort a bin, **+ New > New part from label** opens the camera on the label. **AI Assist** turns photos of a whole shelf into inventory. While you work, tick off tasks and note what you did on the device. Setup, Discover and other bulk imports, the PC builder, exports and settings are quicker on a computer.

## Everyday use

**Home** lists what needs attention (devices that went offline, IP conflicts, broken gear, warranties ending, things not hooked up, old passwords) next to your open tasks.

**Status** shows which devices are answering right now: every device with an IP address, grouped by where it is, with **Online**, **Offline**, **Not checked** or **Not hooked up**, how fast it answered, and a bar for each of the last 24 hours.
- HaRM knocks on a few ports of each address (the device's own services, then SSH, the web and so on). Any answer counts. If none answers, it tries one ping.
- Hooked-up devices are checked every 5 minutes, and every minute while the page is open. Change it in **Settings > Status and actions**. To leave one device out, edit it and untick **Check if it's online**.
- A server's iLO, iDRAC or IPMI port is checked too and shown under it.
- **Wake** sends a Wake-on-LAN packet to an offline device that has a MAC address (Wake-on-LAN must be on in its BIOS). In Docker this needs `network_mode: host`.
- **⋯ > Full screen** makes it a wall display that keeps itself up to date.

**Actions** are commands you save once and send to a device over SSH with one click, like quieting a server's fans after a reboot:
1. Open **Actions** (or a device's **Actions** tab) and press **+ New action**. **Start from an example** fills in the form.
2. Pick the device. Leave **Send to** empty for its main address, or enter its iLO or iDRAC address, or several addresses, one per line.
3. Pick a saved **Login** (or none, to use the computer's SSH key).
4. **How to send it:** as one shell script (Linux, Proxmox, NAS boxes), or one command per line (iLO, iDRAC, switches, Windows).
5. Old management ports often refuse modern SSH: tick **Older SSH**, or paste the `-o` settings from an ssh command that works into **Other SSH settings**.

Press **▶ Run** on the Actions page, the device's tab, or its tile on **Status**. A message says whether it worked, with **Show output**. Tick **Ask before running** for anything that restarts or shuts down.

**Search** (top bar, or press `/`): type a name, IP, MAC, serial, part number or login. Results appear as you type, and picking one opens that exact item: an IP opens its network entry, a login opens its reveal window.

**+ New** (top right) adds anything, or **scans a label** with the camera: barcodes, QR codes and printed text go straight into the right fields.

**Devices:** each device page starts with a summary (whether it's online, where it is, its IP to copy, the management page, one-tap logins) and has these tabs:
- **Overview:** notes and tasks (type one and press Enter), details, location and purchase info.
- **Hardware:** CPU, memory, drives and drive bays (tap an empty bay to fill it), all installed parts, and expansion slots. Spare parts that fit are suggested.
- **Network:** interfaces (IP, MAC, VLAN), services, and cables.
- **Logins:** **Open ↗** opens the iDRAC/iLO/web page and copies the password in one click. SSH logins give a ready-to-paste command.
- **Actions:** its one-click commands, and whether each of its addresses answers.

The **⋯** button holds the less common actions: Import specs, check if it's online, wake it up, new action, export/PDF, print a QR label, clone, and delete.

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

**Virtual & Clusters:** track VMs and containers as devices that **run on** a host (VM ID, vCPUs, memory, disk). A host's **VMs** tab shows what's running on it and how much of its CPU and memory is claimed. Group hosts into **clusters** (Proxmox, Kubernetes, vSphere…). **Discover > Proxmox** imports a whole Proxmox cluster with all its VMs and containers.

**Main address:** if a device has several IPs (OS plus iDRAC, for example), tap the 🌐 address on its page and pick **☆ Main**. That one is used for quick links, logins and lists. Management ports are never picked automatically.

**Networks & IPs** keeps subnets and VLANs, with an IP map showing who uses what and the next free addresses. **Discover** brings in what's on your network from **any router** (paste its client or DHCP list: pfSense, OPNsense, OpenWrt, Pi-hole, MikroTik, Omada, ordinary home routers), a **UniFi** console (API key), **Proxmox**, or a **network scan**. Phones, tablets, TVs, consoles and smart-home gear are recognised by name. You review everything before it's saved.

**PC Builder:** plan builds from about 30,000 library parts or your own spares, with compatibility checks. **Create device** turns a finished build into a real device.

**Export & Share:** copy devices as text for a person or an AI assistant, download CSV/JSON, or print a spec sheet or sell sheet to PDF.

**Settings:** appearance (match your computer, light or dark), locking, master password, two-factor login, recovery code, phones and tablets, how often to check what's online, AI Assist, backups, keyboard shortcuts, and About with **Send feedback** and **Check for new versions**.

## Backups and moving to a new PC

**Where your data is:** in your own data folder, never next to the app, so updating or reinstalling can't touch it.

- Windows: `%APPDATA%\com.zombeatz.zoms-harm` (paste that into File Explorer's address bar)
- Linux: `~/.local/share/com.zombeatz.zoms-harm`
- A server, Docker, or a copy run from source: the `data` folder next to HaRM

It holds the database, the daily backups (`backups`), HaRM's certificates (`tls`) and its log.

- HaRM **backs itself up daily** and keeps the last 14.
- **Settings > Data & backups > Download backup** saves a copy whenever you want one. Keep a copy on another drive or computer now and then.
- **To move HaRM to a new computer**, install it there, press **Stop** in its control panel, and copy the whole data folder over the new one. That brings your devices, logins, certificates (so phones keep trusting it) and backups. Your master password stays the same.
- **Used an older HaRM from a folder?** The first time the installed app opens, **Bring in data from an older HaRM…** copies that folder's data in for you.

## Updating

Download the newer installer and open it, the same way you installed HaRM. It replaces the app and keeps your data and settings. Open browser tabs and the phone app show a **⟳ Reload** banner.

## Uninstalling

- **Windows:** **Settings > Apps > Zom's HaRM > Uninstall**. It asks whether to remove your data too; the answer is no unless you choose otherwise.
- **Linux:** remove **zoms-harm** in your software center (or `sudo apt remove zoms-harm` / `sudo dnf remove zoms-harm`). For the AppImage, delete the file. Your data folder is kept; delete it yourself if you want it gone.

## Troubleshooting

HaRM has these steps built in too: **Help & Guide > Troubleshooting**, the **Show troubleshooting steps** button when HaRM can't start on a device, and **Still not working?** in the desktop app's Phone setup.

| Problem | Fix |
|---|---|
| The phone shows "Your connection is not private" | The certificate isn't trusted on the phone yet. Open **Phone setup**, do step 2, then fully close and reopen Chrome. |
| The phone can't connect at all | Same Wi-Fi as the computer? **Phone setup**'s checklist checks sharing, HTTPS, the certificate and the firewall. On Windows, allow Python in *Windows Security > Firewall > Allow an app*. |
| iPhone/iPad: works in Safari but the home-screen app says "Cannot reach the HaRM server" | The certificate isn't fully trusted. Check **Settings > General > About > Certificate Trust Settings** and turn on *Zom's HaRM local CA*. If it isn't listed, redo **Phone setup** step 2. Then delete the home-screen icon and add it again from Safari. |
| iPhone/iPad home-screen icon is just a letter ("H") | iOS couldn't fetch the icon because it doesn't trust HaRM's certificate yet. Do **Phone setup** step 2 (iPhone / iPad), remove the home-screen icon, then open HaRM in Safari and Add to Home Screen again. |
| The computer's IP address changed | The control panel shows **Fix certificate**. Click it. Phones keep trusting HaRM. Better still, give the computer a fixed IP in your router. |
| "Port in use" | Another program uses port 8077. Change **Port** in the control panel's settings. |
| HaRM won't start | Open **Server log** at the bottom of the control panel. It shows the reason. |
| Forgot the master password | On the unlock screen choose **Use the recovery code**. |
| Status says Offline, but the device is on | Its firewall blocks every port HaRM tries, and ping. Add a service with an open port on its **Network** tab (HaRM tries those first), or allow ping. |
| An action says the machine "only speaks an older kind of SSH" | Edit the action and tick **Older SSH**. If it still fails, paste the `-o …` settings from an ssh command that works into **Other SSH settings**. |
| An action says the machine's key changed | Normal after reinstalling it or replacing its iLO or iDRAC card: choose **Trust the new key and run**. If nothing changed, find out why first. |
| Lost the password *and* the recovery code | Stored logins can't be recovered; that's what keeps them safe. Everything else is still readable from a backup. |

## Security

- Logins are encrypted (AES-256-GCM) with a key that only your master password or recovery code unlocks. Nobody can read them from a copied database.
- HaRM locks itself after 30 minutes idle. Optional two-factor login is in **Settings**.
- Every change, sign-in, password reveal and action run is recorded in the **Audit Log**.
- **Actions** run commands on your machines with your saved logins, so they only work while HaRM is unlocked. Their results are encrypted like your logins. HaRM never allows SSH settings that could run a program on its own computer.
- Only install HaRM's certificate on **your own** devices. Keep `data/tls/harm-ca.key` private: anyone with that file could impersonate websites to phones that trust it.
- HaRM is meant for your home network. Don't expose it directly to the internet. For access away from home, use a VPN into your home network (for example your router's VPN).
