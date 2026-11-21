/* Connect to a device (Device > 🔌 Connect): a terminal in HaRM, your own SSH app, a remote desktop
 * file, VNC, the Proxmox console of a VM, or its management page. Only HaRM's own terminal uses the
 * saved password; the others open apps on your computer, which ask for it themselves. */
import { useEffect, useState } from 'react';
import { api, GET } from '../api/client';
import { S } from '../lib/state';
import { downloadText, type Row } from '../lib/util';
import { choose, copy, modal, toast, type ModalCtl } from '../ui/overlay';
import { Btn, Spinner } from '../ui/bits';
import { screensDialog } from './screens';

/* Ports whose page is usually HTTPS (Cockpit, Proxmox, Webmin, …). */
const HTTPS_PORTS = [443, 8443, 9090, 8006, 9443, 10000, 5001];
const webPorts = (d: Row) => [...new Set<number>((d.services || []).map((s: Row) => +s.port).filter((n: number) => n && n !== 22 && (n < 5900 || n > 5999)))];
const isWindows = (d: Row) => /windows/i.test(`${d.os || ''} ${d.device_type || ''}`);
const shortName = (n?: string | null) => (n || '').split('.')[0];
/* The port in a login's address (ssh://host:2222 or host:2222), else 22. */
const portOf = (c?: Row) => (String(c?.url || '').split('://').pop()!.match(/:(\d{1,5})(\/|$)/) || [])[1] || '22';

export function connectDialog(dev: Row) {
  modal(`Connect to ${dev.name}`, (m: ModalCtl) => <Connect m={m} dev={dev} />);
}

function Connect({ m, dev }: { m: ModalCtl; dev: Row }) {
  const [t, setT] = useState<Row | null>(null);
  const [pve, setPve] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [cred, setCred] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [viaSsh, setViaSsh] = useState(true);
  const [vncP, setVncP] = useState('5900');
  const [webP, setWebP] = useState(String(webPorts(dev)[0] || ''));
  const [webHttps, setWebHttps] = useState(HTTPS_PORTS.includes(webPorts(dev)[0]));
  const [webTo, setWebTo] = useState('');
  const [webOther, setWebOther] = useState(false);
  const [tuns, setTuns] = useState<Row[]>([]);
  const loadTuns = () => GET('/tunnels').then((r: Row[]) => setTuns(r.filter(x => x.device_id === dev.id))).catch(() => {});
  useEffect(() => {
    GET('/ssh-key').then(k => setHasKey(!!k.key)).catch(() => {});
    GET(`/devices/${dev.id}/collect-targets`).then(x => {
      setT(x); setHost(x.hosts[0] || '');
      const ssh = x.credentials.find((c: Row) => /ssh|os/i.test(c.kind || '')) || x.credentials[0];
      if (ssh) { setCred(String(ssh.id)); setPort(portOf(ssh)); }
      if (x.screen?.port) setVncP(String(x.screen.port));
    }).catch(() => setT({ hosts: [], credentials: [] }));
    GET('/discover/config').then(c => setPve(c.proxmox?.url || '')).catch(() => {});
    loadTuns();
  }, [dev.id]);  // eslint-disable-line react-hooks/exhaustive-deps
  if (!t) return <div className="muted"><Spinner /> Loading…</div>;
  const c = t.credentials.find((x: Row) => String(x.id) === cred);
  const user = c?.username || '';
  const at = user ? `${user}@${host}` : host;
  const p = +port || 22;
  const sshCmd = `ssh ${p !== 22 ? `-p ${p} ` : ''}${at}`;
  const go = (hash: string) => { m.close(true); location.hash = hash; };
  const term = () => go(`#/terminal?${new URLSearchParams({ d: String(dev.id), h: host, p: String(p), ...(cred ? { c: cred } : {}), ...(user ? { u: user } : {}) })}`);
  const rdp = () => downloadText(`${dev.name.replace(/[^\w.-]+/g, '_')}.rdp`,
    [`full address:s:${host}`, user ? `username:s:${user}` : '', 'prompt for credentials:i:1', 'screen mode id:i:2', ''].filter(Boolean).join('\r\n'), 'application/x-rdp');
  // Proxmox's own console: a VM or container on a node, or the node's shell.
  const guest = dev.host_id && dev.vm_id;
  const pveUrl = pve && (guest
    ? `${pve}/?console=${dev.device_type === 'Container' ? 'lxc' : 'kvm'}&novnc=1&vmid=${encodeURIComponent(dev.vm_id)}&node=${encodeURIComponent(shortName(dev.host_name))}&resize=scale`
    : /proxmox/i.test(`${dev.os || ''} ${dev.device_type || ''} ${dev.tags || ''}`) ? `${pve}/?console=shell&xtermjs=1&node=${encodeURIComponent(shortName(dev.hostname) || dev.name)}` : '');
  const keyOp = async (remove: boolean) => {
    if (remove && await choose('Take HaRM’s key out?', `HaRM won’t be able to sign in to ${at} with its key any more, only with the saved password.`,
      [['no', 'Cancel'], ['yes', 'Take it out', 'danger']]) !== 'yes') return;
    setBusy(true);
    try {
      const r = await api('POST', `/devices/${dev.id}/ssh-key`, { host, port: p, credential_id: +cred, remove });
      toast(remove ? `Took HaRM’s key out of ${at}` : r.works ? `Added. HaRM signs in to ${at} with its key now` : `Added to ${at}, but signing in with it didn’t work: the machine may not allow keys`, r.works === false ? 'bad' : 'ok');
    } catch (e) { toast((e as Error).message, 'bad'); }
    setBusy(false);
  };
  const vncSvc = (dev.services || []).find((s: Row) => s.port >= 5900 && s.port <= 5999);
  // Through SSH needs a login with a username; then VNC that only listens on the machine works too (port 5900).
  const canSsh = !!(cred && user) && !isWindows(dev);
  const vncPort = vncSvc?.port || (canSsh ? +vncP || 5900 : 0);
  const ssh = canSsh && viaSsh;
  // The password of a screen HaRM set up (Find screens > Set up) is in its own vault entry.
  const vc: Record<string, string> = t.screen?.credential_id && +vncPort === t.screen.port ? { vc: String(t.screen.credential_id) } : {};
  const screen = () => go(`#/vnc?${new URLSearchParams({ d: String(dev.id), h: host, p: String(vncPort), ...(cred ? { c: cred } : {}), ...(ssh ? { s: String(p) } : {}), ...vc })}`);
  const filesUrl = `#/files?${new URLSearchParams({ d: String(dev.id), h: host, p: String(p), c: cred })}`;
  const find = () => screensDialog({ dev, host, port: p, cred: +cred, user, saved: t.screen,
    open: (vp: number, vcred?: number) => go(`#/vnc?${new URLSearchParams({ d: String(dev.id), h: host, p: String(vp), c: cred, s: String(p), ...(vcred ? { vc: String(vcred) } : {}) })}`) });
  const tunUrl = (x: Row) => `${x.scheme}://${location.hostname}:${x.port}/`;
  const web = async (trust = false) => {
    const w = window.open('', '_blank');  // opened now, while it's still a click, so it isn't blocked
    if (w) { w.opener = null; w.document.title = 'Opening…'; }
    setBusy(true);
    try {
      const r = await api('POST', '/tunnels', { device_id: dev.id, host, port: p, credential_id: +cred, target: webTo.trim() || '127.0.0.1',
        target_port: +webP, https: webHttps, trust_new_key: trust });
      if (w) w.location.href = tunUrl(r); else window.open(tunUrl(r), '_blank', 'noopener');
      loadTuns();
    } catch (e) {
      w?.close();
      const msg = (e as Error).message;
      if (/host key changed/i.test(msg) && await choose('The machine’s SSH key changed', 'That’s normal after reinstalling it, but can also mean something is intercepting the connection.',
        [['no', 'Cancel'], ['yes', 'Trust the new key', 'primary']]) === 'yes') { setBusy(false); return web(true); }
      if (!/host key changed/i.test(msg)) toast(msg, 'bad');
    }
    setBusy(false);
  };
  const closeTun = async (x: Row) => { await api('DELETE', `/tunnels/${x.id}`).catch(() => {}); loadTuns(); };
  return <div className="disc-form connect">
    <div className="inline">
      <label className="disc-field"><span>Address</span>
        <input list="cn-hosts" value={host} onChange={e => setHost(e.target.value)} />
        <datalist id="cn-hosts">{t.hosts.map((h: string) => <option key={h} value={h} />)}</datalist></label>
      <label className="disc-field"><span>Port</span><input value={port} onChange={e => setPort(e.target.value)} inputMode="numeric" style={{ width: 80 }} /></label>
      <label className="disc-field"><span>Login</span><select value={cred} onChange={e => { setCred(e.target.value); setPort(portOf(t.credentials.find((x: Row) => String(x.id) === e.target.value))); }}>
        <option value="">None (this computer’s SSH key)</option>
        {t.credentials.map((x: Row) => <option key={x.id} value={x.id}>{`${x.label}${x.username ? ` (${x.username})` : ''}`}</option>)}</select></label>
    </div>
    <div className="connect-list">
      {S.caps?.terminal !== false ? <div><Btn label="⌨ Terminal in HaRM" cls="primary" disabled={!host || (!user && !!cred)} onClick={term} />
        <span className="muted small">SSH in this window, with the saved login. Closes when HaRM locks.</span></div> : null}
      {S.caps?.terminal !== false && cred && user ? <div><Btn label="📁 Files" disabled={!host} onClick={() => go(filesUrl)} />
        <span className="muted small">{isWindows(dev) ? 'Browse, upload, download and edit files, and run PowerShell in a folder (needs OpenSSH Server on Windows).'
          : 'Browse, upload, download and edit files, and run commands in a folder.'}</span></div> : null}
      {S.caps?.terminal !== false && canSsh ? <div className="connect-web"><Btn label="🌐 Web page through SSH" disabled={!host || busy || !+webP} onClick={() => web()} />
        <input aria-label="Web page port" title="The page's port on the machine" list="cn-webports" value={webP} placeholder="Port" inputMode="numeric" style={{ width: 84 }}
          onChange={e => { setWebP(e.target.value); setWebHttps(HTTPS_PORTS.includes(+e.target.value)); }} />
        <datalist id="cn-webports">{webPorts(dev).map(n => <option key={n} value={n} />)}</datalist>
        <label className="check inline-check" title="The page itself uses https"><input type="checkbox" checked={webHttps} onChange={e => setWebHttps(e.target.checked)} />https</label>
        {webOther ? <input aria-label="Address seen from the machine" title="Another address, as the machine sees it (like a router or printer behind it)" placeholder="127.0.0.1" value={webTo}
          onChange={e => setWebTo(e.target.value)} style={{ width: 140 }} /> : null}
        <span className="muted small">{webOther ? 'An address the machine can reach. ' : 'A page on the machine itself (like Cockpit on 9090), in a new tab, encrypted. '}
          {webOther ? null : <a href="#" onClick={e => { e.preventDefault(); setWebOther(true); }}>Another address…</a>}</span>
        {tuns.length ? <ul className="plain-list small">{tuns.map(x => <li key={x.id}>{'Open: '}<a href={tunUrl(x)} target="_blank" rel="noopener noreferrer">{`${x.target} → ${tunUrl(x)}`}</a>{' '}
          <a href="#" onClick={e => { e.preventDefault(); closeTun(x); }}>Close</a></li>)}</ul> : null}</div> : null}
      {S.caps?.terminal !== false && canSsh ? <div><Btn label="⌨ Run a command" disabled={!host} onClick={() => go(`#/run?d=${dev.id}`)} />
        <span className="muted small">On this machine, or many at once, and see the output.</span></div> : null}
      {hasKey && cred && user ? <div><Btn label="🗝 Add HaRM’s SSH key" disabled={busy || !host} onClick={() => keyOp(false)} />
        <span className="muted small">{`Into ${user}’s authorized_keys, so HaRM signs in without the password. `}<a href="#" onClick={e => { e.preventDefault(); keyOp(true); }}>Take it out</a></span></div> : null}
      <div><a className="button" href={`ssh://${encodeURI(at)}${p !== 22 ? `:${p}` : ''}`}>↗ Open in my SSH app</a>
        <span className="muted small">If your computer has an app for ssh:// links.</span></div>
      <div><Btn label="📋 Copy SSH command" onClick={() => copy(sshCmd, `Copied: ${sshCmd}`)} /><span className="mono small">{sshCmd}</span></div>
      {isWindows(dev) || (dev.services || []).some((s: Row) => s.port === 3389) ? <div><Btn label="🖥 Remote desktop file (.rdp)" onClick={rdp} />
        <span className="muted small">Opens in Remote Desktop (Windows, Mac) or Remmina. It asks for the password itself.</span></div> : null}
      {vncPort ? <div>{S.caps?.terminal !== false ? <Btn label="🖥 Screen in HaRM (VNC)" onClick={screen} disabled={!host} /> : null}
        {vncSvc ? <a className="button" href={`vnc://${host}:${vncPort}`}>↗ VNC app</a> : null}
        {vncSvc ? null : <input aria-label="VNC port" title="VNC port on the machine (5900 is display :0, 5901 is :1)" value={vncP} onChange={e => setVncP(e.target.value)} inputMode="numeric" style={{ width: 70 }} />}
        <span className="muted small">{vncSvc ? `Port ${vncPort}. ` : 'VNC port on the machine. '}
          {canSsh ? <label className="check inline-check"><input type="checkbox" checked={viaSsh} disabled={!vncSvc} onChange={e => setViaSsh(e.target.checked)} />{`Through SSH as ${user} (encrypted)`}</label>
            : 'Not encrypted: pick an SSH login to send it through SSH.'}
          {canSsh ? <>{' '}<a href="#" onClick={e => { e.preventDefault(); find(); }}>🔍 Find screens</a></> : null}</span></div> : null}
      {pveUrl ? <div><a className="button" href={pveUrl} target="_blank" rel="noopener noreferrer">↗ Proxmox console</a>
        <span className="muted small">{guest ? 'The VM’s screen, in Proxmox (sign in to Proxmox if it asks).' : 'The node’s shell, in Proxmox.'}</span></div> : null}
      {dev.mgmt_url ? <div><a className="button" href={dev.mgmt_url} target="_blank" rel="noopener noreferrer">↗ Management page</a>
        <span className="muted small">iDRAC, iLO or IPMI: its own remote console is in there.</span></div> : null}
    </div>
  </div>;
}
