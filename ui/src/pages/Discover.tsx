/* Discover: bring what's on the network into HaRM, from a router's client list, UniFi, Proxmox
 * or a scan. Nothing is saved until Apply or Import. */
import { useState } from 'react';
import { api, GET, loadLookups } from '../api/client';
import { S } from '../lib/state';
import { locPath } from '../lib/lookups';
import { nz, type Row } from '../lib/util';
import { confirmBox, toast } from '../ui/overlay';
import { A, Badge, Btn, Card, HelpLink, Mono, PageHead, Small, Table, Tabs, type Kid } from '../ui/bits';
import { Pending, useLoad } from '../app/router';

const keyOf = (x: Row) => x.mac || x.ip;
const Field = ({ label, children, hint }: { label: string; children: Kid; hint?: Kid }) =>
  <label className="disc-field"><span>{label}</span>{children}{hint ? <small className="muted">{hint}</small> : null}</label>;
const B = ({ children }: { children: Kid }) => <b>{children}</b>;

/* Where to find the client list on common routers. */
function RouterHelp() {
  const rows: [string, Kid][] = [
    ['pfSense', 'Status > DHCP Leases (select the table and copy). Or the file /var/dhcpd/var/db/dhcpd.leases.'],
    ['OPNsense', 'Services > ISC DHCPv4 > Leases (or Services > Dnsmasq / Kea > Leases on newer versions).'],
    ['OpenWrt', 'Status > Overview > Active DHCP Leases, or the file /tmp/dhcp.leases.'],
    ['Pi-hole', 'Settings > DHCP > Currently active DHCP leases, or /etc/pihole/dhcp.leases.'],
    ['MikroTik', 'IP > DHCP Server > Leases (select all, copy), or run /ip dhcp-server lease print.'],
    ['TP-Link Omada', 'Clients page > Export (CSV), then paste the file’s contents.'],
    ['UniFi without API keys', 'Client Devices (select the table and copy), or Export.'],
    ['Home routers (Netgear, ASUS, TP-Link, Eero, ISP boxes…)', 'Look for “Attached devices”, “Client list”, “DHCP clients” or “Connected devices” and copy the table.'],
    ['No router access?', <>On a Windows PC run <code>arp -a</code> (or <code>ip neigh</code> on Linux) and paste the output. It only lists devices that PC has talked to recently.</>],
  ];
  return <details className="trouble"><summary>Where do I find the list on my router?</summary>
    <dl className="kv help-kv">{rows.map(([k, v]) => [<dt key={'k' + k}>{k}</dt>, <dd key={'v' + k}>{v}</dd>])}</dl></details>;
}

/* Proxmox import preview: link or add each node, add or update each VM / container. */
function ProxmoxPreview({ out }: { out: Row }) {
  const devOpts = S.lk.devices.filter(d => !d.host_id);
  const [nodeSel, setNodeSel] = useState<Record<string, string>>(() => Object.fromEntries(out.nodes.map((n: Row) => [n.name, n.match ? String(n.match.id) : 'create'])));
  const guests = out.guests.filter((g: Row) => !g.template);
  const [guestOn, setGuestOn] = useState<Record<string, boolean>>(() => Object.fromEntries(guests.map((g: Row) => [`${g.node}/${g.vmid}`, true])));
  const [loc, setLoc] = useState('');
  const [done, setDone] = useState(false);
  if (done) return <div className="notice ok-notice">✓ Imported. <A href="#/virtual">See Virtual &amp; Clusters</A></div>;
  const apply = async () => {
    const nodes = out.nodes.map((n: Row) => ({ name: n.name, ip: n.ip, device_id: /^\d+$/.test(nodeSel[n.name]) ? +nodeSel[n.name] : null, create: nodeSel[n.name] === 'create' }));
    const gs = guests.filter((g: Row) => guestOn[`${g.node}/${g.vmid}`]).map((g: Row) => ({ ...g, device_id: g.match?.id || null, create: !g.match }));
    try {
      const r = await api('POST', '/discover/proxmox/import', { cluster: out.cluster, nodes, guests: gs, location_id: loc || null });
      toast(Object.entries(r).filter(([, v]) => v).map(([k, v]) => `${v} ${k.replace('_', ' ')}`).join(', ') || 'Nothing changed');
      await loadLookups();
      setDone(true);
    } catch (e) { toast((e as Error).message, 'bad'); }
  };
  return <>
    {out.notes.map((n: string, i: number) => <div key={i} className="notice">{n}</div>)}
    {out.cluster ? <p>Cluster <b>{out.cluster}</b>{out.cluster_match ? ' (already in HaRM, will be updated)' : ' (will be added)'}</p> : null}
    <Card title="Hosts"><div className="table-wrap"><table>
      <thead><tr>{['Node', 'Size', 'State', 'In HaRM'].map(t => <th key={t}>{t}</th>)}</tr></thead>
      <tbody>{out.nodes.map((n: Row) => (
        <tr key={n.name}><td><b>{n.name}</b><div className="muted small mono">{n.ip || ''}</div></td>
          <td className="small">{[n.cpus ? `${n.cpus} CPUs` : '', n.ram_gb ? `${n.ram_gb} GB RAM` : ''].filter(Boolean).join(' · ')}</td>
          <td>{n.online ? <Badge status="Active" /> : <Badge status="Standby" />}</td>
          <td><select className="sm" value={nodeSel[n.name]} onChange={e => setNodeSel(s => ({ ...s, [n.name]: e.target.value }))}>
            <option value="create">{`+ Add “${n.name}” as a new host`}</option><option value="">Skip</option>
            {devOpts.map(d => <option key={d.id} value={d.id}>{`Link to ${d.name}`}</option>)}</select></td></tr>
      ))}</tbody>
    </table></div></Card>
    <Card title={`VMs and containers · ${guests.length}`}>{guests.length ? <div className="table-wrap"><table>
      <thead><tr>{['', 'Name', 'Size', 'IP', 'State', 'In HaRM'].map((t, i) => <th key={i}>{t}</th>)}</tr></thead>
      <tbody>{guests.map((g: Row) => {
        const k = `${g.node}/${g.vmid}`;
        return <tr key={k}><td><input type="checkbox" checked={guestOn[k]} onChange={e => setGuestOn(s => ({ ...s, [k]: e.target.checked }))} /></td>
          <td><b>{g.name}</b><div className="muted small">{`${g.kind} ${g.vmid} on ${g.node}`}</div></td>
          <td className="small">{[g.vcpus ? `${g.vcpus} vCPU` : '', g.ram_gb ? `${g.ram_gb} GB` : '', g.disk_gb ? `${g.disk_gb} GB disk` : ''].filter(Boolean).join(' · ')}</td>
          <td className="small mono">{g.ips.join(', ')}</td>
          <td>{g.running ? <span className="ok-text">● running</span> : <span className="muted">○ stopped</span>}</td>
          <td className="small">{g.match ? <>Update <A href={`#/devices/${g.match.id}`}>{g.match.name}</A></> : <span className="badge info">New</span>}</td></tr>;
      })}</tbody>
    </table></div> : <div className="empty">No VMs or containers.</div>}</Card>
    <div className="disc-apply card"><Field label="New hosts go in"><select value={loc} onChange={e => setLoc(e.target.value)}>
      <option value="">No location</option>{S.lk.locations.map(l => <option key={l.id} value={l.id}>{locPath(l.id)}</option>)}</select></Field>
      <Btn label="Import" onClick={apply} cls="primary" /></div>
  </>;
}

interface Found { hosts: Row[]; networks: Row[]; notes: string[]; label: string; filter: string; choice: Record<string, string>; types: Record<string, string>; netPick: Record<string, boolean> }

function Results({ st, set }: { st: Found; set: (patch: Partial<Found>) => void }) {
  const [loc, setLoc] = useState('');
  const [svc, setSvc] = useState(true);
  const vis = st.hosts.filter(x => !x.ignored);
  const g: Record<string, Row[]> = {
    new: vis.filter(x => !x.match), known: vis.filter(x => x.match), changed: vis.filter(x => x.match && x.match.ip_changed),
    hidden: st.hosts.filter(x => x.ignored), all: vis,
  };
  const rows = g[st.filter];
  const chosen = Object.entries(st.choice).filter(([k, v]) => v && !st.hosts.find(x => keyOf(x) === k)?.ignored).length;
  const choose = (x: Row, v: string) => set({ choice: { ...st.choice, [keyOf(x)]: v } });
  const hide = async (list: Row[], ignore = true) => {
    try {
      await api('POST', '/discover/ignore', { keys: list.map(keyOf), ignore });
      const choice = { ...st.choice };
      list.forEach(x => { x.ignored = ignore; delete choice[keyOf(x)]; });
      set({ choice });
    } catch (e) { toast((e as Error).message, 'bad'); }
  };
  const apply = async () => {
    const items = [];
    for (const x of st.hosts) {
      const c = st.choice[keyOf(x)];
      if (!c || x.ignored) continue;
      const linkId = c.startsWith('link:') ? +c.slice(5) : null;
      items.push({ action: linkId ? 'link' : 'new', device_id: linkId, device_type: st.types[keyOf(x)] || null, mgmt: !!(linkId && x.bmc), host: x });
    }
    const networks = st.networks.filter(n => st.netPick[n.cidr] && !n.exists);
    if (!items.length && !networks.length) return toast('Nothing chosen yet. Pick an action on some rows first.', 'bad');
    try {
      const r = await api('POST', '/discover/import', { items, networks, location_id: loc || null, services: svc });
      toast(Object.entries(r).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(', ') || 'Nothing changed');
      await loadLookups();
      networks.forEach(n => { n.exists = true; });
      const choice = { ...st.choice };
      for (const it of items) {
        it.host.match = { device_id: it.device_id, device_name: it.action === 'new' ? 'just added' : (S.lk.devices.find(d => d.id === it.device_id)?.name || 'updated'), how: 'import' };
        delete choice[keyOf(it.host)];
      }
      set({ choice });
    } catch (e) { toast((e as Error).message, 'bad'); }
  };
  const chip = (k: string, label: string) => <button key={k} type="button" className={'chip' + (st.filter === k ? ' on' : '')} onClick={() => set({ filter: k })}>{`${label} (${g[k].length})`}</button>;
  return <>
    {st.notes.map((n, i) => <div key={i} className="notice">{n}</div>)}
    {st.networks.length ? <Card title="Networks on the gateway"><Table rows={st.networks} cols={[
      { label: '', nosort: true, get: n => n.exists ? '✓' : <input type="checkbox" checked={!!st.netPick[n.cidr]} onChange={e => set({ netPick: { ...st.netPick, [n.cidr]: e.target.checked } })} /> },
      { label: 'Name', get: n => n.name },
      { label: 'VLAN', get: n => n.vlan_id ?? '' },
      { label: 'Subnet', get: n => <Mono v={n.cidr} /> },
      { label: 'Gateway', get: n => <Mono v={n.gateway} /> },
      { label: 'DHCP pool', get: n => n.dhcp_start ? <Mono v={`${n.dhcp_start} to ${n.dhcp_end}`} /> : '' },
      { label: 'In HaRM', get: n => n.exists ? <Badge status="Already added" /> : <span className="badge info">New</span> },
    ]} /></Card> : null}
    <Card title={`Found: ${st.label}`}><div>
      <div className="chips">{chip('new', 'New')}{chip('changed', 'IP changed')}{chip('known', 'Already in HaRM')}{chip('all', 'All')}{chip('hidden', 'Hidden')}</div>
      {st.filter === 'new' && rows.length ? <div className="inline disc-bulk">
        <Small label="Add all shown as devices" onClick={() => set({ choice: { ...st.choice, ...Object.fromEntries(rows.map(x => [keyOf(x), 'new'])) } })} />
        <Small label="Hide all shown" cls="ghost" onClick={async () => { if (await confirmBox(`Hide ${rows.length} hosts from future results? (phones, TVs, smart plugs…) You can unhide them under “Hidden”.`, 'Hide')) hide(rows); }} />
      </div> : null}
      <Table rows={rows} empty={st.filter === 'new' ? 'Everything found is already in HaRM.' : 'Nothing here.'} rowClass={x => st.choice[keyOf(x)] ? 'picked' : ''} cols={[
        { label: 'Name', get: x => <div><b>{x.name || x.hostname || 'None'}</b>
          {x.hostname && x.hostname !== x.name ? <div className="muted small mono">{x.hostname}</div> : null}
          {x.model ? <div className="muted small">{x.model}</div> : null}
          {x.bmc && !x.match ? <div className="warn-text small">Management port (iDRAC/iLO): attach it to its server</div> : null}</div> },
        { label: 'IP', sort: x => x.ip ? x.ip.split('.').map((n: string) => n.padStart(3, '0')).join('.') : '~', get: x => <div><Mono v={x.ip || 'None'} />
          {x.match?.ip_changed ? <div className="warn-text small">{`HaRM has ${x.match.iface_ip}`}</div> : null}
          {x.fixed_ip ? <div className="muted small">reserved</div> : null}</div> },
        { label: 'MAC / vendor', get: x => <div><Mono v={x.mac || ''} />{x.vendor ? <div className="muted small">{x.vendor}</div> : null}</div> },
        { label: 'Seen', get: x => <div className="small">
          {x.source === 'unifi' ? <span className={x.online ? '' : 'muted'}>{nz(x.online ? '● online' : '○ offline', x.connection)}</span> : null}
          {x.uplink ? <div className="muted">{nz(x.uplink, x.port ? `port ${x.port}` : '')}</div> : null}
          {x.network && x.connection === 'Wi-Fi' ? <div className="muted">{x.network}</div> : null}
          {x.ports.length ? <div className="port-chips">{x.ports.map((p: Row) => <span key={p.port} className="port-chip" title={p.name}>{p.port}</span>)}</div> : null}</div> },
        { label: 'In HaRM', get: x => x.match ? <div>{x.match.how === 'import' ? '✓ ' : ''}<A href={`#/devices/${x.match.device_id}`}>{x.match.device_name}</A>
          {x.match.how !== 'import' ? <div className="muted small">{`matched by ${x.match.how}`}</div> : null}</div> : <span className="badge info">New</span> },
        { label: 'Action', nosort: true, get: x => x.ignored ? <Small label="Unhide" onClick={() => hide([x], false)} /> : <div className="disc-act">
          <select className="sm" value={st.choice[keyOf(x)] || ''} onChange={e => choose(x, e.target.value)}>
            <option value="">{x.match ? 'Already in HaRM' : 'Skip'}</option><option value="new">+ Add as new device</option>
            {x.match ? <option value={`link:${x.match.device_id}`}>{`Update “${x.match.device_name}”`}</option> : null}
            {S.lk.devices.filter(d => !x.match || d.id !== x.match.device_id).map(d => <option key={d.id} value={`link:${d.id}`}>{`Attach to ${d.name}`}</option>)}
          </select>
          {st.choice[keyOf(x)] === 'new' ? <select className="sm" value={st.types[keyOf(x)] || ''} onChange={e => set({ types: { ...st.types, [keyOf(x)]: e.target.value } })}>
            <option value="">Type…</option>{S.enums.device_types.map(t => <option key={t} value={t}>{t}</option>)}</select> : null}
          <Small label="Hide" onClick={() => hide([x])} cls="ghost" />
        </div> },
      ]} />
    </div></Card>
    <div className="disc-apply card">
      <Field label="New devices go in"><select value={loc} onChange={e => setLoc(e.target.value)}><option value="">No location</option>
        {S.lk.locations.map(l => <option key={l.id} value={l.id}>{locPath(l.id)}</option>)}</select></Field>
      <label className="check inline-check"><input type="checkbox" checked={svc} onChange={e => setSvc(e.target.checked)} />Add services for open ports (SSH, web UIs…)</label>
      <Btn label={`Apply ${chosen} change${chosen === 1 ? '' : 's'}${st.networks.some(n => st.netPick[n.cidr] && !n.exists) ? ' + networks' : ''}`} onClick={apply} cls="primary" />
    </div>
  </>;
}

export default function Discover() {
  const q = useLoad(() => GET('/discover/config'));
  const [st, setSt] = useState<Found | null>(null);
  const [busy, setBusy] = useState('');
  const [status, setStatus] = useState<Record<string, Kid>>({});
  const [listText, setListText] = useState('');
  const [u, setU] = useState<Row | null>(null);
  const [p, setP] = useState<Row | null>(null);
  const [cidr, setCidr] = useState<string | null>(null);
  const [px, setPx] = useState<Row | null>(null);
  if (!q.data) return <Pending q={q} />;
  const cfg = q.data;
  const uni = u || { url: cfg.unifi.url, key: '', site: cfg.unifi.site, verify: cfg.unifi.verify, remember: true, hasKey: cfg.unifi.has_key };
  const prox = p || { url: cfg.proxmox?.url || '', token: cfg.proxmox?.token_id || '', secret: '', verify: !!cfg.proxmox?.verify, hasSecret: cfg.proxmox?.has_secret };
  const range = cidr ?? (cfg.subnets[0]?.cidr || cfg.networks[0]?.cidr || '');
  const say = (k: string, v: Kid) => setStatus(s => ({ ...s, [k]: v }));
  const bad = (k: string, e: unknown) => say(k, <span className="bad-text">{(e as Error).message}</span>);
  const show = (out: Row, label: string) => {
    const next: Found = { hosts: out.hosts, networks: out.networks || [], notes: out.notes || [], label, filter: 'new', choice: {}, types: {}, netPick: {} };
    for (const x of next.hosts) {
      // Known by MAC/IP with nothing new: skip. Known some other way, or IP changed: update it.
      if (x.match && (x.match.ip_changed || !x.match.interface_id)) next.choice[keyOf(x)] = 'link:' + x.match.device_id;
      next.types[keyOf(x)] = x.type_guess || '';
    }
    for (const n of next.networks) next.netPick[n.cidr] = !n.exists;
    next.filter = next.hosts.some(x => !x.ignored && !x.match) ? 'new' : 'all';
    setSt(next);
  };
  const run = async (k: string, fn: () => Promise<void>) => { setBusy(k); try { await fn(); } catch (e) { bad(k, e); } setBusy(''); };
  const sugg = [...cfg.subnets, ...cfg.networks.filter((n: Row) => !cfg.subnets.some((s: Row) => s.cidr === n.cidr))];
  return <>
    <PageHead title="Discover devices" sub="Bring what’s on your network into HaRM: from your router’s client list, a UniFi gateway, Proxmox, or a scan. You review everything before it’s saved."><HelpLink s="discover" /></PageHead>
    <Tabs k="discover" defs={[
      ['router', 'Any router', null, () => <Card title="Paste your router’s client list"><div className="disc-form">
        <p className="muted">Works with almost any router or DHCP server: copy its list of connected devices or DHCP leases (the whole table is fine) and paste it below. HaRM picks out each device’s IP, MAC address and name.</p>
        <RouterHelp />
        <Field label="Client list"><textarea id="disc-list" rows={8} className="mono small" spellCheck={false} value={listText} onChange={e => setListText(e.target.value)}
          placeholder="Paste the table of connected devices / DHCP leases here" /></Field>
        <div className="inline"><Btn label="Read list" cls="primary" onClick={() => run('list', async () => {
          const out = await api('POST', '/discover/clients', { text: listText });
          say('list', `${out.hosts.length} device${out.hosts.length === 1 ? '' : 's'} found.`);
          show(out, 'Router client list');
        })} /><div className="muted small">{status.list}</div></div>
      </div></Card>],
      ['unifi', 'UniFi', null, () => <Card title="UniFi gateway"><div className="disc-form">
        <Field label="Gateway address" hint="Your UniFi console, e.g. https://192.168.1.1"><input type="url" value={uni.url} placeholder="https://192.168.1.1" inputMode="url" onChange={e => setU({ ...uni, url: e.target.value })} /></Field>
        <Field label="API key" hint={<span>Needs a UniFi OS console (UDM, UCG, UDR, UXG, Cloud Key Gen2+) with UniFi Network 9 or newer. <HelpLink s="discover" label="Where do I get one?" /></span>}>
          <input type="password" autoComplete="off" value={uni.key} placeholder={uni.hasKey ? 'Saved in the vault (leave blank)' : 'Paste the API key'} onChange={e => setU({ ...uni, key: e.target.value })} /></Field>
        <details className="trouble"><summary>How to create the API key</summary>
          <ol><li>Sign in to your console’s UniFi Network app with an admin account.</li>
            <li>Open <B>Settings &gt; Control Plane &gt; Integrations</B>. (Depending on the version it may be <B>Settings &gt; System &gt; Integrations</B> or <B>Control Plane &gt; API Access</B>.)</li>
            <li><B>Create API Key</B>, give it a name like “HaRM”, and pick “Never expires” or remember to renew it.</li>
            <li>Copy the key right away: UniFi only shows it once.</li></ol>
          <p><span className="muted small">Older self-hosted “UniFi Network Server” installs don’t support API keys: use <B>Any router</B> with the client list copied from its Client Devices page instead.</span></p>
        </details>
        <Field label="Site"><input value={uni.site} placeholder="default" onChange={e => setU({ ...uni, site: e.target.value })} /></Field>
        <label className="check inline-check"><input type="checkbox" checked={uni.verify} onChange={e => setU({ ...uni, verify: e.target.checked })} />Verify certificate (off for the console’s self-signed certificate)</label>
        <label className="check inline-check"><input type="checkbox" checked={uni.remember} onChange={e => setU({ ...uni, remember: e.target.checked })} />Remember the key (encrypted with your vault)</label>
        <div className="inline"><Btn label="Import from UniFi" cls="primary" disabled={busy === 'unifi'} onClick={() => run('unifi', async () => {
          say('unifi', 'Asking the gateway…');
          const out = await api('POST', '/discover/unifi', { url: uni.url, api_key: uni.key, site: uni.site, verify: uni.verify, remember: uni.remember });
          setU({ ...uni, key: '', hasKey: uni.hasKey || uni.remember });
          say('unifi', `Site “${out.site.name}”: ${out.hosts.length} devices and clients.`);
          show(out, `UniFi · ${out.site.name}`);
        })} /><div className="muted small">{status.unifi}</div></div>
      </div></Card>],
      ['proxmox', 'Proxmox', null, () => <>
        <Card title="Proxmox VE: nodes, VMs and containers"><div className="disc-form">
          <p className="muted">Reads your cluster (or single node), its hosts, and every VM and container with its vCPUs, memory and disk. VM IP addresses come along when the QEMU guest agent is installed.</p>
          <Field label="Proxmox address" hint="Any node, e.g. https://192.168.1.20:8006"><input type="url" value={prox.url} placeholder="https://192.168.1.20:8006" inputMode="url" onChange={e => setP({ ...prox, url: e.target.value })} /></Field>
          <div className="grid two">
            <Field label="Token ID" hint="user@realm!name, e.g. root@pam!harm"><input value={prox.token} placeholder="root@pam!harm" autoComplete="off" onChange={e => setP({ ...prox, token: e.target.value })} /></Field>
            <Field label="Token secret"><input type="password" autoComplete="off" value={prox.secret} placeholder={prox.hasSecret ? 'Saved in the vault (leave blank)' : 'Token secret'} onChange={e => setP({ ...prox, secret: e.target.value })} /></Field>
          </div>
          <details className="trouble"><summary>How to create a read-only token</summary>
            <ol><li>In the Proxmox web UI: <B>Datacenter &gt; Permissions &gt; API Tokens &gt; Add</B>. Pick a user (e.g. root@pam), name the token “harm”.</li>
              <li>Untick <B>Privilege Separation</B> (or give the token its own permission in the next step).</li>
              <li><B>Datacenter &gt; Permissions &gt; Add &gt; API Token Permission</B>: path <code>/</code>, role <B>PVEAuditor</B> (read-only).</li>
              <li>Copy the secret: Proxmox only shows it once.</li></ol>
          </details>
          <label className="check inline-check"><input type="checkbox" checked={prox.verify} onChange={e => setP({ ...prox, verify: e.target.checked })} />Verify certificate (off for Proxmox’s self-signed certificate)</label>
          <div className="inline"><Btn label="Read Proxmox" cls="primary" disabled={busy === 'px'} onClick={() => run('px', async () => {
            say('px', 'Reading the cluster…');
            const out = await api('POST', '/discover/proxmox', { url: prox.url, token_id: prox.token, secret: prox.secret, verify: prox.verify });
            setP({ ...prox, secret: '', hasSecret: true });
            say('px', `${out.cluster ? `Cluster “${out.cluster}”: ` : ''}${out.nodes.length} node${out.nodes.length === 1 ? '' : 's'}, ${out.guests.length} VMs and containers.`);
            setPx(out);
          })} /><div className="muted small">{status.px}</div></div>
        </div></Card>
        {px ? <ProxmoxPreview key={JSON.stringify(px).length} out={px} /> : null}
      </>],
      ['scan', 'Network scan', null, () => <Card title="Scan the network"><div className="disc-form">
        <Field label="Range" hint="Private ranges only, /22 or smaller. Runs from the HaRM server."><input value={range} placeholder="192.168.1.0/24" className="mono" onChange={e => setCidr(e.target.value)} /></Field>
        {sugg.length ? <div className="chips">{sugg.map((s: Row) => <button key={s.cidr} type="button" className="chip mono" title={s.label} onClick={() => setCidr(s.cidr)}>{s.cidr}</button>)}</div> : null}
        <p className="muted small">Checks common ports (SSH, web, RDP, SMB, Proxmox, Plex…) on every address, then reads names and MAC addresses. Open ports become suggested services. Phones and other devices that block every port may only show up if the HaRM server can see them on the same network.</p>
        <div className="inline"><Btn label="Scan" cls="primary" disabled={busy === 'scan'} onClick={() => run('scan', async () => {
          say('scan', 'Scanning… this takes 10 to 30 seconds.');
          const out = await api('POST', '/discover/scan', { cidr: range });
          say('scan', `${out.hosts.length} hosts answered out of ${out.scanned} addresses (${out.elapsed}s).`);
          show(out, `Scan · ${out.cidr}`);
        })} /><div className="muted small">{status.scan}</div></div>
      </div></Card>],
    ]} />
    {st ? <Results st={st} set={patch => setSt(s => ({ ...s!, ...patch }))} /> : null}
    {cfg.ignored ? <p className="muted small">{`${cfg.ignored} hosts are hidden from results. Scan again and pick “Hidden” to bring any back.`}</p> : null}
  </>;
}
