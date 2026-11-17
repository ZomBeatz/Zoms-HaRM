# Changelog

## 0.3.3

**Files on a machine**
- **📁 Files** in **🔌 Connect** (and on the terminal page) opens a file browser for the machine: folders with size, date, permissions and owner, **⬆ Upload** (or drop files on it), **⬇ Download**, **+ Folder**, **+ File**, rename or move, and delete.
- Click a text file (up to 1 MB) to open it in an editor; **Save** (or Ctrl+S) writes it back, keeping its permissions.
- **Use sudo** lists, opens and changes things as root, for files like `/etc` configs.
- A command box at the bottom runs one command in the folder you're in and shows what it printed, without opening a terminal.
- It uses one SSH connection with the saved login (or HaRM's key), only while HaRM is unlocked, and closes when HaRM locks, after 30 minutes unused or when you leave the page. Uploads, downloads, changes and commands are in the audit log.

**Screens: find them, or set one up**
- **🔍 Find screens** (next to the screen in **🔌 Connect**) looks at the machine over SSH and lists the VNC servers it runs, including ones only open on the machine itself.
- On a Linux desktop with X11, **🔧 Set up screen sharing** installs **x11vnc** as a service that shares the desktop on the machine only, so it's reached through HaRM's SSH connection, with a new VNC password saved in the vault. **Take it out** removes it again.
- Wayland desktops (GNOME, KDE, Sway), Macs and machines without a desktop get directions for their own screen sharing instead.

**The screen through SSH**
- **🖥 Screen in HaRM (VNC)** can go **through SSH**: HaRM signs in to the machine with the picked login (or its own SSH key) and reaches VNC on the machine itself, so the screen is encrypted all the way. It's on whenever a login with a username is picked.
- That also works for VNC servers that only listen on the machine (like `x11vnc -localhost`), which HaRM couldn't reach before: pick the VNC port (5900 is display :0, 5901 is :1) in **🔌 Connect**.
- Clear reasons when it can't connect: the login was refused, the machine's SSH key changed (with **Trust the new key and connect**), or nothing answers on that VNC port.
- If the machine refuses the saved login's password as its VNC password, **Connect again** asks you for it instead.

**HaRM's SSH key on all your machines**
- **Settings > Locking and security > HaRM's SSH key > 🗝 Add to my machines…** lists every device with a saved SSH or OS login, and adds the key to all the ones you tick, one after another, with ✓ or the reason for each.
- It remembers where the key was added (**added 3d ago**), so those start unticked. A new key starts with none.
- **⟳ New key… > Swap on my machines** puts a new key on every machine that has the current one, checks HaRM can sign in with it, then takes the old one out. **Use the new key** switches at the end, so nothing stops working along the way.

**Change old passwords in one go**
- **Maintenance > Old passwords > 🔑 Change them all…** sets a new random password on each machine (with `chpasswd`, like **Change on machine**), one after another, saves each in the vault, and shows ✓ or the reason for each.

**Smaller things**
- **🔌 Connect** takes the SSH port from the login's address (like `10.0.0.5:2222`).
- "Made …" under HaRM's SSH key showed a broken date.

## 0.3.2

**See what's online: the Status page**
- **Status** (in the sidebar, and the phone's bottom bar) shows every device with an address, grouped by where it is, each with **Online**, **Offline**, **Not checked** or **Not hooked up**, how fast it answered, and a bar for each of the last 24 hours.
- A server's management port (iLO, iDRAC, IPMI) is checked too and shown under it, so "the server is off" and "the whole box lost power" look different.
- HaRM checks every 5 minutes, and every minute while the page is open. Change it, or turn it off, in **Settings > Status and actions**. Devices that go offline also show on **Home**.
- **Services are checked too:** each web page or port on a device's **Network** tab says **Answering** or **Not answering** (a 502 from a proxy counts as not answering), on its tile, on the device's page and on **Home**.
- **Alerts:** a message by **ntfy** (a phone app), **email** or a **webhook** (Home Assistant, Discord, Slack, Gotify…) when a device or service stops answering, and when it's back. A short wait skips blips like restarts, many changes at once arrive as one message, and **Send a test** checks it works. Set it up in **Settings > Status and actions > Alerts**; turn it off for one device with **Send alerts about it**.
- **Quiet hours** hold alerts overnight (or whenever you choose) and send them as one message when they end.
- **Certificates:** HaRM notes when each https service's certificate runs out, warns on **Home** 30 days before, and alerts 14 days before.
- **Uptime report** (**📊 Uptime** on the Status page): how much of the last day, week or month each device and service answered, worst first, with the number of outages, the longest, and the total time down. VMs, containers and the services your Docker containers publish are in it too.
- **New devices on the network:** HaRM can scan the networks you pick now and then (leave the guest Wi-Fi out) and list anything it doesn't know at the top of the Status page, with **+ Add…** and **Ignore**, and an alert if you want one. The first scan only learns what's already there.
- **The rack drawing** outlines a device in red and says **Offline** when it isn't answering.
- **Wake** sends a Wake-on-LAN packet to an offline device with a MAC address.
- **⋯ > Full screen** turns the page into a wall display.

**Power budget**
- Give a UPS or PDU what it **Can supply**, set what each device is **Plugged into**, and give a rack its **Power available** (its circuit's limit).
- The rack page and the UPS's page show how much is used, counting through PDUs, and **Home** warns at 80% and over 100%.

**One-click actions**
- Save a command once and send it to a device over SSH with one click: quiet a server's fans, update, restart, power on through the iLO or iDRAC.
- Send it as one shell script (Linux, Proxmox, NAS boxes), or one command per line (iLO, iDRAC, switches, Windows). **Older SSH** connects to old management ports that refuse modern SSH, and **Other SSH settings** takes the `-o` settings from a command that already works.
- Actions use your saved logins, run only while HaRM is unlocked, keep their last 50 results (encrypted), and are recorded in the audit log. Start from examples for Proxmox, Debian and Ubuntu, iLO, iDRAC and Windows.
- Run them from **Actions**, a device's **Actions** tab, or the buttons on the Status page. They run when you press the button, never on a schedule.

**Installing**
- **One-click installers.** Windows gets a normal setup file (`Zoms-HaRM_0.3.2_x64-setup.exe`) and Linux gets `.deb`, `.rpm` and AppImage files, with everything inside. Nothing else to install first, and no administrator rights needed on Windows.
- The installed app keeps your data in its own folder, so updating or reinstalling never touches it: `%APPDATA%\com.zombeatz.zoms-harm` on Windows, `~/.local/share/com.zombeatz.zoms-harm` on Linux.
- **Used HaRM from a folder before?** The first time the installed app opens, **Bring in data from an older HaRM…** copies your devices, logins and certificates over. The old folder isn't changed.
- Uninstalling keeps your data, unless you tick the box to remove it.

**Try it first**
- **Live demo** at [zombeatz.github.io/Zoms-HaRM](https://zombeatz.github.io/Zoms-HaRM/): the real app with a made-up home lab, running in your browser. Changes stay in that browser until you press **Reset demo**.

**Looks and feel**
- **Light or dark follows your computer** (or phone) unless you pick one in **Settings > Appearance**: **Match my computer**, **Light** or **Dark**.
- Plainer headings: sentence case, no capitals, and the same sizes as the other ZomBeatz apps.
- **Rack colors mean something:** servers, network gear, storage, power, other gear and accessories each have a color, with a key under the rack saying which is which.
- Dialog titles on phones no longer get squeezed by their buttons.
- On phones, the UniFi and Proxmox tabs of **Discover** no longer make the page wider than the screen.
- The unlock screen's boxes are labelled, for screen readers and password managers.
- When a search finds just one thing and opens it, **← Back** names the page you were on before the search.

**Keyboard**
- **Ctrl K** (⌘K on a Mac) searches everything, **/** filters the list on the page, **N** opens **+ New**, **?** shows the shortcuts, **[** folds the sidebar to icons, and **Esc** closes menus and search. See **Help > Keyboard shortcuts** or **Settings > Shortcuts**.

**Docker containers**
- A device's **Containers** tab lists its Docker containers, read over SSH with a saved login: running, stopped or unhealthy, how long they've been up, their image, published ports, and whether a newer image is out (**Check for updates** asks the registry without downloading anything).
- **Update** pulls the newest image and re-creates the container with Docker Compose, keeping its settings. **Restart**, **Stop**/**Start** and **Logs** are one click each, and **Clean up old images** frees the space old versions take. Nothing runs on a schedule.
- The **Status** page shows a server's containers on its tile, and **Watch its web page** makes a container's port a service with the usual checks and alerts.
- New examples in **Actions**: update Plex installed as a package, update every Compose project in a folder, clean up old images.

**Services as cards**
- **Services** (in the sidebar): every web page and port on your devices as **cards** or a **list**, with whether each answers.
- **Filter**, show only those answering (or not), only **★ Favorites**, or one **list**.
- **⚙ Layout:** card size, group by device, place, list or state, sort, favorites first, and what each card shows. Kept on each device.
- **Favorites** come first and show on **Home**. **Lists** ("Media", "Admin pages") sort services into groups; one can be in several.
- **Edit card…:** an icon (or one guessed from the name), a color, and up to 8 buttons of your own: open a link or an app (`ssh://`, `smb://`, `rdp://`, `vnc://`), copy text, or run a saved action (which keeps its own "Ask before running").
- **Results on the card:** an action button can show the last line its action printed ("2 streams", "backup 3 h ago"). It updates when you press it.
- **Saved layouts:** **⚙ Layout > Save this layout as…** keeps the look and filters under a name, like "Wall tablet", to pick on any device.

**Maintenance: health, updates and backups**
- A machine's **Health** tab (**⋯ > Health and updates…**) reads it over SSH with a saved login: disk space, each drive's health (SMART), ZFS pools and RAID arrays, memory, waiting updates with security fixes marked, whether it needs a restart, and its containers. Drive health goes into each drive's **Health** field, matched by serial number.
- **Labels for virtual drives:** say what a disk, volume or pool really is ("12 × 4 TB in RAID 6"), shown over what the system reports (a 42 TB virtual drive), or stop warnings about it.
- **Backups to watch:** folders that should get new files and ZFS datasets that should get new snapshots, with how often. Proxmox backups are checked for every VM.
- **Maintenance** (in the sidebar): what needs attention on every machine, system updates with **Install** and **Restart**, container updates with the versions (1.41.9 → 1.42.2), backups, and **⟳ Check everything**. Problems also show on **Home** and on the **Status** page.
- **Proxmox:** every VM's state, use and newest backup, with **Start**, **Shut down**, **Reboot**, **Take a snapshot** and **Stop** (the token needs `VM.PowerMgmt` and `VM.Snapshot` for the buttons).
- **Maintenance log:** updates, restarts, container changes, Proxmox power and snapshots, and actions each leave a **Did** note on the device.
- **Background checks** (off unless you turn them on): read chosen machines every few hours, also while HaRM is locked, with a login of their own (encrypted with `background.key`, not in backups), and alert about new problems. They only read.
- **Alerts** about problems machine checks find; a container that stops or keeps restarting comes with the last lines of its log.
- Proxmox and UniFi certificates are remembered the first time HaRM connects; a changed one asks before HaRM sends the token again.

**Connecting to your machines**
- **🔌 Connect** on a device: a **terminal in HaRM** signed in with the saved login, **Open in my SSH app**, **Copy SSH command**, a **Remote Desktop file** (.rdp) for Windows, a **VNC** link, the **Proxmox console** of a VM or node, and the **management page** (iDRAC, iLO).
- The terminal only works while HaRM is unlocked, closes when it locks, after 30 minutes without typing or when you leave the page, and at most 4 are open. Opening and closing are in the audit log; nothing typed is stored. Turn it off in **Settings > Locking and security**.
- **Screen in HaRM (VNC):** a machine's screen in HaRM's page, relayed through HaRM, for machines with a VNC port. It only goes to the device's own addresses and VNC ports, and closes when HaRM locks.
- **HaRM's SSH key** (**Settings > Locking and security**): one key for this HaRM, its private part encrypted with your master password. **🗝 Add HaRM's SSH key** in **🔌 Connect** puts it on a machine (and **Take it out** removes it), and HaRM then signs in with it. Background checks can use it instead of a stored password.

**Logins and Bitwarden**
- **Import from Bitwarden** (or Vaultwarden) on the vault's **⋯** menu: pick the .json export, see each login with the device it seems to be for, untick any you don't want, and import. Passwords never show in the preview.
- **Export for Bitwarden** asks for your master password again and saves a file Bitwarden and Vaultwarden can import.
- **🔑 Change on machine…** on a Linux login sets a new password on the machine over SSH, saves it in HaRM, keeps the old one in the login's secret notes, and checks the new one signs in.
- **Old passwords** on **Maintenance**: logins not changed in a year (or 3 months to 2 years, in **Settings > Status and actions**), each with **Change on machine**. **Home** links to them.

**Cleaning up parts**
- **Delete** on any part of a device removes it outright (added by mistake, by hand or by a scan), with **Undo**. It doesn't go to Spare Parts. **Remove** is now **To spares**, with **Delete it instead** in it.
- **Import specs** can **Replace with this scan**: parts the new scan didn't find are deleted, and only the kinds of parts it read. **Undo** (in the message, or **⋯ > Undo last import**) puts everything back as it was.
- Deleting a device with parts inside asks whether they go to **Spare Parts** or are deleted with it.

**Settings**
- **Name of this HaRM**, where **new parts and devices start**, a **High contrast** option, **notes oldest first** and **finished tasks tucked away**, a shorter **menu** (untick pages you don't use), and a **Wall display** mode that opens on Status full screen and doesn't lock itself.
- **Export & share** remembers what you include, the title and the sell sheet's lines on each device.
- **Find a setting…** at the top of Settings filters the page.
- **Reading and comfort** (**Settings > Appearance**, kept on each device): **Text size** (Normal, Large, Larger), **Spacing** (Comfortable or Compact), how **dates** and the **clock** read, **Lengths** in millimetres or inches (rack depth and PC part sizes), **Less motion**, and a **sound** (and buzz on phones) when something goes offline while the Status page is open.
- **On every device**: the **Currency** prices are shown in, and the page HaRM **starts on** (Home, Status, Devices, Tasks, Racks, or where you left off).
- **Locking** is set in **Settings > Locking and security**: lock after 5 minutes to 8 hours without use, or only when you lock it, and sign in again after 4 hours to a week. **How many backups to keep** (7, 14, 30 or 90 days) is in **Data & backups**. Before, these needed a server setting.
- **Use AI features** (**Settings > AI Assist**): untick it and every AI button disappears, from **+ New**, Spare Parts, racks, locations and Help, and HaRM refuses AI requests. Your AI settings are kept for if you turn it back on.
- Settings are grouped: Appearance, Locking and security, Phones & tablets, Status and actions, AI Assist, Data & backups, Shortcuts and About.
- **Settings > About** shows the version and license, links to the code and this list, and has **Send feedback**, which starts an email with your version and device filled in.
- **Copy to a second place** (**Settings > Data & backups**): each day's backup is also copied to another disk, like a NAS share or USB drive, keeping the last 7 to 90.
- **Check for new versions** (off unless you turn it on) asks GitHub about twice a day and puts a note on **Home** when a newer HaRM is out.

**On GitHub**
- Each release has a `SHA256SUMS.txt` to check your download against.
- Bug report and feature idea forms, and `SECURITY.md` for reporting security problems privately.

**Under the hood**
- The interface was rewritten in TypeScript and React, built with Vite: the same tools as Zomello. It looks and works the same. Mistakes like a misspelled field are now caught before a release, and the interface has its own tests.
- HaRM still runs with Python only: the built interface ships with the code.
- Moving between pages, the previous page stays on screen until the next one is ready, instead of going blank.
- HaRM starts faster, especially on phones: each page's code loads when it's first needed (the first download is about a third smaller).
- A page that can't be shown now says so, with a **Reload** button, instead of leaving the whole window blank.
- A new test opens every page, tab, menu and dialog in a real browser with every change.

## 0.3.1

The first public release.

**Your hardware**
- **Places, racks, shelves and bins:** where everything is, with a front and rear rack view that knows half-depth gear and refuses overlaps.
- **Devices** with their hardware (processors, memory, drive bays), network ports, services, logins, notes and tasks.
- **Spare parts** with quantities, where they're kept, and which device they're installed in.
- **Virtual machines, containers and clusters:** what runs on each host and how much of it they claim.
- **Networks and IPs:** VLANs, ranges and an IP map, and a **main address** per device so a management port never takes over its quick links.

**Filling it in fast**
- **Discover** reads any router's client list (phones, tablets, TVs and consoles are recognised), a UniFi console, a Proxmox cluster, or scans your network.
- **Import specs** over SSH or from the computer HaRM runs on.
- **Scan labels** with a phone's camera: barcodes, QR codes and printed serials.
- **AI Assist** turns photos of a shelf into parts and devices, with prices if the AI can look them up. Works with Claude, ChatGPT, Gemini or a local model, or by copy and paste with any AI app.

**Logins**
- A vault for passwords and 2FA codes, encrypted with your master password, with a recovery code and optional 2FA to unlock.

**Phones and tablets**
- Install HaRM on a phone's home screen. **Phone setup** in the desktop app shows QR codes and a checklist that ticks itself off as the phone connects, with steps for Android, Samsung Galaxy, iPhone and iPad.

**More**
- PC builder with compatibility checks, spec and sell sheets, QR labels, CSV and JSON exports, and daily backups.
- Runs on Windows and Linux with a desktop control panel, or on a server with Docker or a Linux service.
