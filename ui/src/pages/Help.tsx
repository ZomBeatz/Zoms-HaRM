/* Help & guide: how HaRM works, section by section. The full guide is on docs.zombeatzmedia.com. */
import { useEffect } from 'react';
import { deviceKind, hasKeyboard, MOD } from '../lib/util';
import { A, Btn, PageHead, type Kid } from '../ui/bits';
import { phoneAppHelp } from '../dialogs/phone';

const B = ({ children }: { children: Kid }) => <b>{children}</b>;
const C = ({ children }: { children: Kid }) => <code>{children}</code>;
const L = ({ items, ordered = false }: { items: Kid[]; ordered?: boolean }) => {
  const kids = items.map((i, n) => <li key={n}>{i}</li>);
  return ordered ? <ol>{kids}</ol> : <ul>{kids}</ul>;
};

/* The same keys as every ZomBeatz product. Listed in Help and Settings > Shortcuts, and never
   mentioned on touch screens. Ctrl +/−/0 is the browser's own zoom. */
const SHORTCUTS: [string, [string[], string][]][] = [
  ['Getting around', [[[MOD, 'K'], 'Search everything'], [['/'], 'Filter the list on this page'], [['['], 'Fold the sidebar'], [['?'], 'Help and this list of shortcuts']]],
  ['Adding and closing', [[['N'], 'Add a new item (opens + New)'], [['Esc'], 'Close the dialog, menu or search']]],
  ['Zoom', [[[MOD, '+'], 'Zoom in'], [[MOD, '−'], 'Zoom out'], [[MOD, '0'], 'Back to normal size']]],
];
export function ShortcutsList() {
  return <>{SHORTCUTS.map(([group, rows]) => (
    <div key={group} className="keys-group"><h4>{group}</h4>
      <table className="keys"><tbody>{rows.map(([keys, does]) => <tr key={does}><td>{keys.map(k => <kbd key={k}>{k}</kbd>)}</td><td>{does}</td></tr>)}</tbody></table></div>
  ))}</>;
}

/* Device-specific fixes for "can't connect" problems. Works without the server (used on the
   start-up error screen too), so it only uses what's already loaded in the page. */
export function TroubleshootingContent() {
  const here = location.origin;
  const mine = deviceKind();
  const sec = (key: string, title: string, body: Kid) => <details key={key} className="trouble" open={key === mine}>
    <summary>{title}{key === mine ? <span className="badge info">this device</span> : null}</summary>{body}</details>;
  return <>
    <p>Most connection problems are about trust: phones and tablets only talk to HaRM once they trust its certificate. If HaRM opens on one device but not another, the server is fine; fix the device that fails.</p>
    {sec('ios', 'iPhone / iPad', <>
      <p>Symptoms: <B>“Cannot reach the HaRM server”</B>, a warning that the connection isn’t private, it works in Safari but not from the home screen, or the home-screen icon is just a letter.</p>
      <L ordered items={[
        <><B>Clear old HaRM data: </B>Settings &gt; Apps &gt; Safari &gt; Advanced &gt; Website Data (older versions: Settings &gt; Safari &gt; Advanced &gt; Website Data). Search <C>{location.hostname || '192.168'}</C> and swipe to delete. Remove any HaRM icon from the home screen.</>,
        <><B>Download the certificate: </B>on the computer running HaRM, open <B>📱 Phone setup</B> in the desktop app and scan the first QR code with the Camera app, or open <C>{`${here}/harm-ca.crt`}</C> in Safari. If Safari warns, tap <B>Show Details &gt; visit this website</B>. Tap <B>Allow</B>, then Close.</>,
        <><B>Install it: </B>Settings &gt; <B>Profile Downloaded</B> (or General &gt; VPN &amp; Device Management) &gt; Zom’s HaRM local CA &gt; <B>Install</B>.</>,
        <><B>Trust it (the step most people miss): </B>Settings &gt; General &gt; About &gt; <B>Certificate Trust Settings</B> &gt; turn on <B>Zom’s HaRM local CA</B>.</>,
        <><B>Close Safari completely </B>(swipe it away in the app switcher), then open <C>{here}</C>. There should be no warning.</>,
        <><B>Add to Home Screen: </B>Share &gt; Add to Home Screen &gt; Add.</>,
      ]} />
      <L items={[
        'Still a warning at step 5? The trust switch in step 4 isn’t on. Not listed there? Step 3 didn’t finish.',
        'Worked before and stopped after HaRM was updated or its certificate re-issued? Update HaRM on the computer (older versions made certificates iPhones reject), restart it, then repeat from step 5.',
      ]} />
    </>)}
    {sec('android', 'Android', <L ordered items={[
      <>Open <B>📱 Phone setup</B> in the desktop app and scan the first QR code (or open <C>{`${here}/harm-ca.crt`}</C>). Chrome warns once: Advanced &gt; Proceed. The file downloads.</>,
      <>Settings &gt; Security &amp; privacy &gt; More security &amp; privacy &gt; Encryption &amp; credentials &gt; <B>Install a certificate &gt; CA certificate</B> &gt; Install anyway &gt; pick harm-ca.crt. (Samsung: Settings &gt; Security and privacy &gt; More security settings &gt; Install from device storage &gt; CA certificate.)</>,
      <>Close Chrome completely (swipe it away), reopen <C>{here}</C>. There should be a padlock and no warning.</>,
      <>Chrome ⋮ &gt; <B>Add to Home screen &gt; Install</B>.</>,
    ]} />)}
    {sec('computer', 'Any device', <L items={[
      <><B>Same network? </B>The device must be on the same Wi-Fi/network as the computer running HaRM (not guest Wi-Fi, mobile data or a VPN).</>,
      <><B>Right address? </B>The desktop app shows the addresses under “Where to open it”. If the computer’s IP changed, use the new one and press <B>Fix certificate</B> there.</>,
      <><B>Is HaRM running? </B>The desktop app shows ● Running. If it says Stopped, press Start; if it won’t start, open Server log at the bottom.</>,
      <><B>Firewall: </B>Windows asks the first time HaRM starts: allow it on Private networks. On Linux, the Phone setup checklist checks the firewall and offers to open the port.</>,
      <><B>Shared on your network? </B>In the desktop app, “Let phones and other devices connect” must be ticked (then Restart).</>,
      <><B>Still stuck? </B>The Phone setup checklist in the desktop app watches what the device does and shows which step is missing.</>,
    ]} />)}
  </>;
}

const HELP: [string, string, () => Kid, { keyboard?: boolean }?][] = [
  ['start', 'Quick start', () => <L ordered items={[
    <>Run the <A href="#/setup">setup guide</A>. It adds your locations, racks/shelves, networks and first devices.</>,
    'Open a device and fill in what matters: IP addresses, services, logins, drive bays and installed parts.',
    <>Catalog spare parts in <A href="#/components">Spare Parts</A>. On a phone, use <B>+ New &gt; Scan</B>.</>,
    'Use the search box at the top for anything: a name, IP, MAC, serial or part number.',
  ]} />],
  ['concepts', 'How things fit together', () => <dl className="kv help-kv">
    <dt>Location</dt><dd>A place: house, room, closet, storage unit. Locations can be nested.</dd>
    <dt>Holder</dt><dd>What hardware sits in or on: a rack or cabinet (with unit numbers), a shelf, bin, tote, drawer, desk, or a pile.</dd>
    <dt>Device</dt><dd>Anything with its own identity: server, switch, NAS, router, laptop, UPS, patch panel.</dd>
    <dt>Slots &amp; bays</dt><dd>What a device can take, e.g. “12× SAS 3.5" bays” or “8× DDR4 RDIMM”. HaRM uses these to suggest spare parts that fit.</dd>
    <dt>Part</dt><dd>A component that goes into a device: drive, RAM stick, CPU, NIC, PSU, cable, SFP. Parts are either installed in a device or stored somewhere.</dd>
    <dt>Network</dt><dd>A subnet / VLAN / Wi-Fi network with its gateway, DHCP pool and DNS.</dd>
    <dt>Interface</dt><dd>A network port on a device, with its IP, MAC, VLANs and more. Interfaces link to networks automatically from the IP.</dd>
    <dt>Service</dt><dd>Something a device runs: a web UI, SSH, SMB share, Plex.</dd>
    <dt>Connection</dt><dd>A cable between two device ports (or to something untracked, like the ISP modem).</dd>
    <dt>Login</dt><dd>A username and password (plus optional 2FA secret and notes), stored encrypted in the Vault.</dd>
  </dl>],
  ['piles', 'Gear in piles and random rooms', () => <>
    <p>Not everything lives in a rack. There are two ways to record loose gear:</p>
    <L ordered items={[
      <><B>Just set the Location</B> and leave “Rack / holder” empty. The device shows under <B>Loose devices</B> on that room’s page (Locations &gt; the room). Use the <B>Spot</B> field to say where: “pile by the door”, “under the desk”.</>,
      <><B>Make a Pile, Floor or Tote holder</B> when you want a particular heap grouped, e.g. “E-waste pile” or “Tote 3”. It gets its own page listing everything in it.</>,
    ]} />
    <p>When you pick a location in a form, the holder list only shows holders in that location (and rooms inside it). Picking a holder first fills in its location for you.</p>
  </>],
  ['racking', 'Putting a device in a rack', () => <>
    <L ordered items={[<>Open the rack from <A href="#/racks">Racks &amp; Storage</A>.</>, 'Click an empty unit on the front or rear view, then create a new device there or place an existing one.',
      <>Or edit a device: choose the rack, then the <B>lowest unit</B> it occupies and its height in U.</>]} />
    <L items={['Full-depth devices block both faces. Turn that off for shallow gear like patch panels or PDUs so another device can use the other face.',
      'Faded blocks are full-depth devices seen from the other side. Striped blocks are not hooked up.', 'HaRM refuses overlapping placements and tells you which device is in the way.']} />
  </>],
  ['parts', 'Spare parts and what fits where', () => <>
    <L ordered items={[
      <>Add parts in <A href="#/components">Spare Parts</A>. Set the <B>Interface</B> (SATA III, DDR4 RDIMM, PCIe x8…) and <B>Form factor</B> (3.5", M.2 2280…).</>,
      <>On a device page, add its <B>Slots &amp; bays</B>. Each slot shows how many are used and a button listing in-stock spares that fit.</>,
      <>Click <B>Install</B> to move a part into a device (it splits a stack if you have several), and <B>Remove</B> to put it back on a shelf.</>,
    ]} />
    <p>Matching understands that SAS bays take SATA drives, a PCIe x16 slot takes x8/x4/x1 cards, and that “SATA” covers “SATA III”.</p>
    <p><B>Cataloging lots of drives? </B>Use <B>Save &amp; add another</B>. Category, model, capacity, location and so on carry over, so you only scan or type each serial number.</p>
  </>],
  ['builder', 'PC Builder', () => <>
    <p>Plan a computer part by part, like PCPartPicker, but mixing three sources:</p>
    <L items={[<><B>Parts library</B>: ~30,000 real parts with specs (see below).</>, <><B>My spare parts</B>: things already in your Spare Parts. Marked “Have” automatically.</>,
      <><B>Custom parts</B>: anything not in the library. Enter the specs you know; they’re saved for reuse.</>]} />
    <L ordered items={[
      <>Create a build in <A href="#/builds">PC Builder</A> and give it a purpose and budget.</>,
      <>Click <B>Choose …</B> on each row. With <B>Only compatible</B> ticked, the picker hides parts that clash with what you’ve already chosen and tells you why others don’t fit.</>,
      'Set each part to Have / Need / Ordered and enter prices to track cost and what’s left to buy.',
      <>When it’s assembled, click <B>Create device</B>. HaRM makes the device, fills in CPU/RAM/storage/PSU, adds the motherboard’s memory, M.2, SATA and PCIe slots, and installs the parts.</>,
    ]} />
    <p><B>What gets checked: </B>CPU socket vs motherboard and cooler; memory type, slot count, capacity, SO-DIMM vs DIMM, ECC and registered memory; motherboard size vs case; video card length and cooler height vs case; PSU size, length, wattage (with an estimated power draw) and GPU power connectors; M.2 slot count and sizes; SATA ports; 3.5" bays; SAS drives without an HBA; and whether there’s any video output.</p>
    <p>Use <B>Duplicate</B> to try variations, or link a build to an existing device to plan an upgrade.</p>
  </>],
  ['library', 'Parts library', () => <>
    <p>The library holds specs for real parts from <a href="https://github.com/buildcores/buildcores-open-db" target="_blank" rel="noopener noreferrer">BuildCores OpenDB</a>, an open, community-maintained database (CC BY-NC-SA 4.0: free for personal, non-commercial use). PCPartPicker itself has no public API and doesn’t allow scraping, so HaRM doesn’t use it.</p>
    <L items={[
      <><B>Download / update</B> from <A href="#/library">Parts Library</A>. It takes under a minute; run it again any time for newer parts. The server needs internet access for this; nothing else in HaRM does.</>,
      <><B>Prices</B> aren’t in the data. Enter what you paid or expect to pay.</>,
      <><B>Custom parts</B>: <B>+ Custom part</B>, or <B>Make custom copy</B> of a library part to correct its specs.</>,
      <><B>Inventory link</B>: on a spare part, <B>▦ Find in library</B> fills model, part number, capacity, interface and form factor and links it, so builds can check it. <B>Add to inventory</B> on a library part does the reverse.</>,
    ]} />
    <p>Library data can have gaps or mistakes. Double-check anything critical, like radiator support or exact clearances.</p>
  </>],
  ['networks', 'Networks, IPs and VLANs', () => <>
    <L ordered items={[
      <>Add your networks in <A href="#/networks">Networks &amp; IPs</A>: name, VLAN ID, subnet (e.g. <C>10.0.10.0/24</C>), gateway, DHCP pool and DNS.</>,
      <>On a device, add interfaces with their IP. You can type <C>10.0.10.5/24</C> and HaRM splits out the prefix. The network is detected from the IP automatically.</>,
      <>Open a network to see its <B>IP map</B>: every address in use, which device has it, duplicates, static IPs sitting inside the DHCP pool, and the next free addresses. Tap a free address to assign it.</>,
    ]} />
    <p>Interfaces also record IPv6, assignment type (static / DHCP reservation / DHCP), DNS servers and name, MAC (normalized to <C>AA:BB:CC:DD:EE:FF</C>), speed, MTU, PoE, link state, parent bond/bridge, Wi-Fi SSID, and switch-port mode: access VLAN, or a trunk’s native and tagged VLANs.</p>
    <p>The dashboard warns when the same IP is recorded on two interfaces.</p>
  </>],
  ['logins', 'Storing logins', () => <L items={[
    <>Add logins from a device page or the <A href="#/vault">Vault</A>. Passwords, 2FA secrets and secret notes are encrypted with your master password.</>,
    <>Paste a 2FA setup key or an <C>otpauth://</C> link into the TOTP field and HaRM shows live 6-digit codes.</>,
    <><B>Reveal</B> shows a login for 60 seconds. Every reveal is recorded in the <A href="#/audit">Audit Log</A>.</>,
    'Set “Last rotated” and Home reminds you about logins older than a year.',
  ]} />],
  ['forms', 'Forms, unsaved changes and drafts', () => <L items={[
    <>If you close a form with changes (✕, Escape, clicking outside, or Cancel), HaRM asks: <B>Keep editing</B>, <B>Discard</B> or <B>Save</B>.</>,
    'What you type is also kept as a draft on this device. If the form closes anyway (auto-lock, the phone reloads the tab), reopen the same form and your changes are restored. Passwords and secret notes are never kept in drafts.',
    <><B>Save &amp; add another</B> saves and opens a fresh form with the shared fields still filled in. A green “✓ Saved” note at the top confirms the last one went in.</>,
    <>Forms show the basics first. <B>▸ More details</B> opens the optional fields (system, purchase, notes…).</>,
    <>After saving, a <B>← Back to …</B> button takes you to where you were (for example the rack you came from). Detail pages also have a back link at the top.</>,
    'If saving fails, the reason appears next to the Save button and the field in question is highlighted.',
    <><C>Ctrl</C>/<C>⌘</C> + <C>Enter</C> saves the open form.</>,
  ]} />],
  ['notes', 'Notes, tasks and history', () => <>
    <p>Every device, rack and room has a <B>Notes &amp; tasks</B> box. Type and press Enter; no edit dialog needed.</p>
    <L items={[<><B>📝 Note</B>: anything worth remembering (“iDRAC shares NIC 1”).</>, <><B>☐ Task</B>: something to do. Tick it off when done; it’s kept as history.</>,
      <><B>🔧 Did</B>: a record of work done (“Replaced PSU 2”, “Updated BIOS to 2.8”).</>, <><B>⚠ Issue</B>: something broken. Marking a drive failed in a bay adds an issue automatically.</>]} />
    <p>Open tasks and issues appear on Home and on the <A href="#/tasks">Tasks &amp; Notes</A> page. Pin important notes to keep them on top. Search finds note text, and exports include open tasks and recent history.</p>
  </>],
  ['hardware', 'CPU, memory and drive bays', () => <L items={[
    <><B>Processors</B>: <B>+ Add CPU</B> to pick a model (the library includes common server CPUs: Opteron 4100 to 4300 and 6100, Xeon 5500/5600, X3400, E5 v1 to v4, Scalable, EPYC). Cores and threads fill in automatically, with totals for multi-socket servers. Not listed? Enter the specs once and it’s saved for reuse.</>,
    <><B>Memory</B>: shows sticks grouped by size and type with the total, plus a slot map if you add memory slots.</>,
    <><B>Drive bays</B>: add a group per set of bays: a name (Front, Rear…), the size (3.5"/2.5"), how many, what it accepts (tap <B>SAS</B> and <B>SATA</B> for bays that take both), and its RAID/controller. Two arrays or two cages? Make two groups.</>,
    'Each bay shows as a box. Tap an empty one to add a drive (or fill all empty bays with identical drives); tap a full one to edit it, move it to spares, or mark it failed.',
    'Each group shows its own raw total and RAID calculator, and the Storage card adds them all up.',
  ]} />],
  ['labels', 'QR labels', () => <>
    <p><B>🏷 Label</B> on a device (or <B>🔳 QR labels</B> on Export &amp; Share for several) prints stickers with the name, model, serial, IP and a QR code. Scan the QR with your phone’s camera, or with <B>+ New &gt; Scan a HaRM label</B>, to jump straight to that device.</p>
    <p>Use “Save as PDF” to send them to a label printer, or print on sticker paper.</p>
  </>],
  ['backups', 'Automatic backups', () => <p>HaRM makes a snapshot of its database every day into data/backups on the server and keeps the last 14. Logins stay encrypted inside them. Settings lists the latest ones. Copy that folder to another disk or machine now and then; a backup on the same drive won’t survive that drive failing.</p>],
  ['import', 'Fill in specs automatically', () => <>
    <p>Instead of typing CPU, RAM, drives and network cards by hand, let HaRM read them. Open the device and click <B>⇩ Import specs</B>, then pick one of three ways:</p>
    <L items={[
      <><B>🔌 Over SSH</B>: HaRM connects from the server using a login saved on that device in the vault (or a username with the server’s SSH keys), runs the read-only collector, and shows the results. Works with Linux, macOS and Windows with OpenSSH. Leave <B>Use sudo</B> on to include the serial number and memory sticks. The saved password never leaves the server. The first connection remembers the machine’s SSH key, and HaRM refuses to connect if it later changes, unless you confirm the machine was reinstalled.</>,
      <><B>🖥 This computer</B>: for the machine HaRM runs on. No SSH needed.</>,
      <><B>📋 Run it yourself</B>: copy the command for that machine’s OS, run it there, and paste the output. Use this for machines HaRM can’t reach. The command checks the script’s fingerprint before running it.</>,
    ]} />
    <p>Then tick what you want: device details (hostname, OS, model, serial, CPU, RAM), each drive and memory stick as an installed part with its serial, and each network card with its IP and MAC.</p>
    <p>Things already recorded (same serial or MAC) are unticked automatically, so importing twice doesn’t duplicate anything.</p>
    <p>For servers without an OS yet, the serial is on the pull-out tag or label. Use the 📷 button to scan it.</p>
  </>],
  ['storage', 'Storage totals and sizes', () => <L items={[
    'Add drives as parts (or with Import specs). Tap a standard size such as 4 TB; anything typed like “4tb” is tidied to “4 TB” automatically.',
    <>Each device has a <B>Storage</B> card: drives grouped by size, the raw total, and a calculator for what you’d get as JBOD, RAID 0/1/5/6/10 or RAIDZ1-3, including the TiB figure most OSes display.</>,
    'Spare Parts shows the total of the drives you’re looking at (e.g. all spares), and Home shows installed and spare totals.',
    <><B>Connection</B> means how a drive plugs in (SATA, SAS, NVMe). RAID is configured on the controller, so it isn’t a connection. SAS bays accept SATA drives too.</>,
  ]} />],
  ['export', 'Export, share and PDFs', () => <>
    <p>Open <A href="#/export">Export &amp; Share</A> (or <B>⇪ Export / PDF</B> on a device or the device list).</p>
    <L ordered items={['Pick devices: filter by location, rack, type or status, then select.', 'Choose what to include.', 'Pick an output.']} />
    <L items={[<><B>Copy for AI / chat</B>: clean Markdown you can paste straight into a chat with a person or an AI assistant when asking for help.</>,
      <><B>Markdown, CSV, JSON</B> downloads for documents, spreadsheets or scripts.</>, <><B>Spec sheet (PDF)</B>: a tidy printable summary of each device.</>,
      <><B>Sell sheet (PDF)</B>: hides internal details (location, IPs, hostnames) and adds a title, condition, asking prices and a contact line.</>]} />
    <p>PDFs use the browser’s print dialog: choose “Save as PDF”. Passwords and secrets are never exported.</p>
  </>],
  ['ai', 'AI Assist: photos to inventory', () => <>
    <p>Log a pile of hardware in minutes: photograph it, let an AI identify and price it, and bring the results into HaRM. Works with any AI app (ChatGPT, Claude, Gemini…); HaRM never sends anything anywhere itself.</p>
    <L ordered items={[
      <>Open <B>🤖 AI Assist</B> from <B>+ New</B>, Spare Parts, or a location or rack page (then everything goes there).</>,
      'Optionally pick where the things are and add a hint (“drives pulled from the R515s”).',
      <><B>Copy prompt</B>, paste it into your AI app and attach your photos. Turn on web search so it can find the original price and today’s used value, with sources.</>,
      <>Paste the AI’s reply into HaRM and press <B>Read reply</B>. Check the preview: fix names, set quantities, untick anything you don’t want, and use 📷 to scan a serial the AI couldn’t read.</>,
      <><B>Add</B>. Devices and parts are created where you chose; the AI’s research (values, sources, labels it read) is saved as a note on each, and its to-dos (“scan the service tag”, “test drive health”) become tasks.</>,
    ]} />
    <L items={['Photos work best with labels facing the camera and in focus. Several photos of the same pile are fine.',
      'Serials already in HaRM are flagged and unticked, so re-importing a photo doesn’t create duplicates.',
      <>Each item gets <B>Original price</B>, <B>Current value</B> and the date it was checked. Update them any time in the item’s form.</>,
      'AI can misread labels: check serials against the label before relying on them. Low-confidence items are marked.']} />
  </>],
  ['discover', 'Discover: bring in what’s on your network', () => <>
    <p><A href="#/discover">Discover</A> finds devices and lets you add them in bulk. Nothing is saved until you press <B>Apply</B> or <B>Import</B>. Pick whichever source fits your setup:</p>
    <dl className="kv help-kv">
      <dt>Any router</dt><dd>Works with almost everything (pfSense, OPNsense, OpenWrt, Pi-hole, MikroTik, Omada, ASUS, Netgear, ISP routers…). Copy the router’s list of connected devices or DHCP leases and paste it. HaRM reads IP, MAC and name from tables, lease files, CSV exports and <C>arp -a</C> output. The Discover tab lists where each router keeps that list.</dd>
      <dt>UniFi</dt><dd>For UniFi OS consoles (UDM, UCG, UDR, UXG, Cloud Key Gen2+) with UniFi Network 9 or newer. Create an API key in the Network app under <B>Settings &gt; Control Plane &gt; Integrations</B> (some versions: <B>Settings &gt; System &gt; Integrations</B> or <B>Control Plane &gt; API Access</B>). Brings in UniFi gear, clients with switch port or Wi-Fi, fixed-IP reservations and VLANs. Older self-hosted UniFi Network Server has no API keys: use Any router with its Client Devices list.</dd>
      <dt>Proxmox</dt><dd>Imports your cluster, its nodes and every VM and container (vCPU, memory, disk, running or not, and IPs if the QEMU guest agent is installed). Needs a read-only API token: Datacenter &gt; Permissions &gt; API Tokens, with the PVEAuditor role on <C>/</C>.</dd>
      <dt>Network scan</dt><dd>Sweeps a private range from the HaRM server: common ports, names and MAC addresses. Good for finding servers and web UIs; phones and locked-down devices may not answer.</dd>
    </dl>
    <h4>Reviewing results</h4>
    <L items={[
      <><B>New</B> devices aren’t in HaRM yet: choose <B>Add as new device</B> (HaRM suggests a type: phones, tablets, TVs, consoles, smart-home gear, switches…) or <B>Attach to</B> an existing device, e.g. an iDRAC address to its server.</>,
      <><B>IP changed</B> devices are matched by MAC but HaRM has an older address; they’re pre-set to update.</>,
      'Matches use MAC first, then IP, then the device’s management URL, then name.',
      <><B>Hide</B> anything you never want to track. Hidden devices stay out of future results.</>,
    ]} />
  </>],
  ['virtual', 'Virtual machines & clusters', () => <>
    <p>A VM or container is a device of type <B>Virtual Machine</B> or <B>Container</B> that <B>runs on</B> a host. It gets everything a device has (IPs, services, logins, notes) plus its VM ID, vCPUs, memory and disk, and it never takes rack space.</p>
    <L items={[
      <>On a host’s page, the <B>VMs</B> tab lists its guests and how much of the host’s CPU threads and memory they claim (over 100% means overcommitted).</>,
      <>A <B>cluster</B> groups hosts (Proxmox, Kubernetes, vSphere, Ceph…). Its page shows the nodes, every guest and combined resources. Set a host’s cluster in its form (More details) or with <B>+ Add node</B>.</>,
      <><A href="#/virtual">Virtual &amp; Clusters</A> lists every cluster, host and VM in one place.</>,
      <>Running Proxmox? <A href="#/discover">Discover &gt; Proxmox</A> imports all of it, and re-importing updates what changed.</>,
    ]} />
    <h4>Main address</h4>
    <p>When a device has several IPs (say, the OS plus an iDRAC), HaRM uses its <B>main address</B> for the summary, quick links, logins and lists. Management ports are never picked automatically. To choose, tap the 🌐 address on the device page and pick <B>☆ Main</B>, or tick <B>Main address</B> on the interface.</p>
  </>],
  ['status', 'Status: which devices are online', () => <>
    <p>The <A href="#/status">Status</A> page shows every device that has an IP address, grouped by where it is, with a word for each: <B>Online</B>, <B>Offline</B>, <B>Not checked</B> or <B>Not hooked up</B>.</p>
    <L ordered items={[
      'HaRM knocks on a few ports of each address (the device’s own services, then SSH, the web and the like). Any answer counts. If none answers, it tries one ping.',
      <>It checks devices that are hooked up and not retired or sold. To leave one out, edit it and untick <B>Check if it’s online</B>.</>,
      'A management port (iLO, iDRAC, IPMI) is checked too and shown under the device, so you can tell “the server is off” from “the whole box lost power”.',
      <>Its services (Network tab) are checked too once it answers: a web address must reply, and a port must accept the connection. Each shows <B>Answering</B> or <B>Not answering</B>.</>,
      'The bars show the last 24 hours, one per hour, with how much of the time it answered.',
    ]} />
    <p>HaRM checks every 5 minutes (change it in <A href="#/settings">Settings &gt; Status and actions</A>), and every minute while the Status page is open. Devices that go offline also show on <B>Home</B>.</p>
    <p><B>Wake-on-LAN: </B>a device with a MAC address gets a <B>Wake</B> button while it’s offline. Wake-on-LAN has to be turned on in its BIOS or network card. HaRM in Docker can only wake devices with <code>network_mode: host</code>.</p>
    <p><B>On a wall screen: </B>⋯ &gt; <B>Full screen</B> hides the sidebar and keeps the page up to date by itself.</p>
    <p><B>Alerts: </B>in <A href="#/settings">Settings &gt; Status and actions &gt; Alerts</A>, get a message by ntfy (a phone app), email or a webhook when a device or service stops answering, and when it’s back. A short wait skips blips like restarts. Many changes at once (a power cut) arrive as one message.</p>
    <p><B>In the rack: </B>a device that isn’t answering is outlined in red and says <B>Offline</B>.</p>
    <p><B>Uptime report: </B><A href="#/uptime">📊 Uptime</A> shows how much of the last day, week or month each device and service answered, worst first, with outages. Docker containers count as the services (ports) they publish.</p>
    <p><B>New devices: </B>⋯ &gt; <B>Watch for new devices</B> scans the networks you tick (leave the guest Wi-Fi out) and lists anything HaRM doesn’t know at the top of this page, to add or ignore.</p>
    <p><B>Certificates: </B>for https services, HaRM notes when the certificate runs out, and warns on Home 30 days before (and alerts 14 days before).</p>
    <p><B>Power: </B>give a UPS or PDU what it <B>Can supply</B>, set <B>Plugged into</B> on each device, and a rack its <B>Power available</B>. The rack and UPS pages show how close they are, and Home warns at 80%.</p>
  </>],
  ['actions', 'Actions: one-click commands', () => <>
    <p>An action is a command you save once and send to a device over SSH with one click: quieting a server’s fans, updating, restarting, powering on through the iLO.</p>
    <L ordered items={[
      <>Open <A href="#/actions">Actions</A> (or a device’s <B>Actions</B> tab) and press <B>+ New action</B>. <B>Start from an example</B> fills in the form.</>,
      <>Pick the device. <B>Send to</B> can stay empty to use its main address, or hold the iLO or iDRAC address, or several addresses, one per line.</>,
      <>Pick a saved <B>Login</B> from the Vault. HaRM uses its password, or this computer’s SSH key when there’s none.</>,
      <><B>How to send it: </B>as one shell script for Linux, Proxmox and NAS boxes, or one command per line for iLO, iDRAC, switches and Windows, which have no Unix shell.</>,
      <>Old management ports often refuse modern SSH. Tick <B>Older SSH</B>, or paste the <code>-o</code> settings from an ssh command that works into <B>Other SSH settings</B>.</>,
    ]} />
    <p>Press <B>▶ Run</B>. A message says whether it worked, with <B>Show output</B>. The last 50 runs are kept, encrypted like your logins.</p>
    <p>Actions use your saved logins, so they only run while HaRM is unlocked, and each run is in the <A href="#/audit">Audit log</A>. Tick <B>Ask before running</B> for anything that restarts or shuts down.</p>
  </>],
  ['trouble', 'Troubleshooting: can’t connect', () => <TroubleshootingContent />],
  ['mobile', 'Phones, tablets and scanning', () => <>
    <p>HaRM works on phones and can be installed as an app (its own icon, no browser bars, long-press shortcuts for Scan, Devices and Tasks). Chrome only allows installing sites it fully trusts, so your phone has to trust HaRM’s certificate once. <Btn label="📱 Show me how" onClick={phoneAppHelp} cls="sm primary" /></p>
    <h4>Scanning labels</h4>
    <L items={[
      <><B>📷 buttons</B> next to serial number, part number, model, asset tag and MAC fields scan into that one field.</>,
      <><B>📷 Scan label</B> at the top of device and part forms reads the whole label and lets you send each value to the right field. Labelled values (“S/N:”, “P/N:”, “MAC”) are pre-matched.</>,
      <><B>+ New &gt; New part from label</B> opens a new part with the scanner already running. Ideal for a stack of drives.</>,
      <><B>Photo mode</B> works everywhere. It decodes barcodes and QR codes and, when the server has text recognition installed (tesseract), also reads printed text. Photos are processed and discarded; they are never stored.</>,
      <><B>Live mode</B> scans continuously from the camera: hold a barcode inside the box and it’s added to the list (the phone buzzes). Several codes? Aim at each in turn, then choose. <B>📝 Read text</B> reads printed text in view. Browsers only allow live mode over HTTPS.</>,
      'Every word read from a label is shown as a chip; tap one to use it if the guesses missed.',
      <><B>+ New &gt; Scan text or barcode</B> is a general scanner that just copies what it reads.</>,
    ]} />
    <h4>Hosting it on a server for your phone</h4>
    <L ordered items={[
      <>On the server, run HaRM listening on the network with HTTPS. The simplest built-in way:<pre className="code">{'./scripts/make-cert.sh harm.lan 192.168.1.50\nHARM_HOST=0.0.0.0 HARM_TLS=1 ./run.sh'}</pre></>,
      <>Open <C>{'https://<server-ip>:8077'}</C> on your phone. A self-signed certificate shows a warning the first time. Install <C>data/tls/harm-ca.crt</C> on the phone to trust it permanently, or proceed past the warning.</>,
      'Alternative with a fully trusted certificate: put HaRM behind Caddy/nginx with HTTPS.',
    ]} />
    <p>Keep HaRM on your LAN or VPN. Don’t expose it to the internet.</p>
  </>],
  ['security', 'Security & backups', () => <L items={[
    'Logins are encrypted (AES-256-GCM). The key is unlocked by your master password and only kept in server memory while you’re signed in. A server restart locks everything.',
    'HaRM locks itself after a period of inactivity (Settings shows how long).',
    <>Turn on 2FA in <A href="#/settings">Settings</A> so unlocking also needs a code from your phone.</>,
    'Keep your recovery code offline. With neither the password nor the recovery code, stored logins cannot be recovered. The rest of your inventory is not encrypted and is unaffected.',
    'Download backups from Settings. CSV exports never include passwords.',
  ]} />],
  ['keys', 'Keyboard shortcuts', () => <><p>The same keys work in every ZomBeatz app. Single keys don’t fire while you’re typing in a box.</p><ShortcutsList /></>, { keyboard: true }],
  ['search', 'Search and adding', () => <L items={[
    'The top search box finds devices, IPs, MACs, serials, services, parts, holders, locations, networks and logins (labels and usernames only).',
    'Click any table header to sort by it.',
    <><B>+ New</B> in the top bar adds anything from any page.</>,
    'The box at the top of a list (devices, parts, logins) filters just that list.',
    <>Device pages have <B>Clone</B> for adding several identical machines.</>,
  ]} />],
];

export default function Help({ section }: { section: string | null }) {
  const here = HELP.filter(([, , , o]) => !(o && o.keyboard) || hasKeyboard());
  useEffect(() => {
    if (section) setTimeout(() => document.getElementById(`help-${section}`)?.scrollIntoView({ block: 'start' }), 0);
  }, [section]);
  return <>
    <PageHead title="Help & guide" sub="How HaRM works and how to get the most out of it."><a className="button primary" href="#/setup">🧭 Setup guide</a></PageHead>
    <nav className="card help-toc"><ul>{here.map(([id, title]) => <li key={id}><a href={`#/help?s=${id}`}>{title}</a></li>)}</ul></nav>
    {here.map(([id, title, body]) => <section key={id} className="card help-sec" id={`help-${id}`}><h2>{title}</h2>{body()}</section>)}
  </>;
}
