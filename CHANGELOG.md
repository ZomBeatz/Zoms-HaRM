# Changelog

## 0.3.2

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

**Keyboard**
- **Ctrl K** (⌘K on a Mac) searches everything, **/** filters the list on the page, **N** opens **+ New**, **?** shows the shortcuts, **[** folds the sidebar to icons, and **Esc** closes menus and search. See **Help > Keyboard shortcuts** or **Settings > Shortcuts**.

**Settings**
- Settings are grouped: Appearance, Locking and security, Phones & tablets, AI Assist, Data & backups, Shortcuts and About.
- **Settings > About** shows the version and license, links to the code and this list, and has **Send feedback**, which starts an email with your version and device filled in.

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
