/* Connect to a device (Device > 🔌 Connect): a terminal in HaRM, your own SSH app, a remote desktop
 * file, VNC, the Proxmox console of a VM, or its management page. Only HaRM's own terminal uses the
 * saved password; the others open apps on your computer, which ask for it themselves. */
import { useEffect, useState } from 'react';
import { GET } from '../api/client';
import { S } from '../lib/state';
import { downloadText, type Row } from '../lib/util';
import { copy, modal, type ModalCtl } from '../ui/overlay';
import { Btn, Spinner } from '../ui/bits';

const isWindows = (d: Row) => /windows/i.test(`${d.os || ''} ${d.device_type || ''}`);
const shortName = (n?: string | null) => (n || '').split('.')[0];

export function connectDialog(dev: Row) {
  modal(`Connect to ${dev.name}`, (m: ModalCtl) => <Connect m={m} dev={dev} />);
}

function Connect({ m, dev }: { m: ModalCtl; dev: Row }) {
  const [t, setT] = useState<Row | null>(null);
  const [pve, setPve] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [cred, setCred] = useState('');
  useEffect(() => {
    GET(`/devices/${dev.id}/collect-targets`).then(x => {
      setT(x); setHost(x.hosts[0] || '');
      const ssh = x.credentials.find((c: Row) => /ssh|os/i.test(c.kind || '')) || x.credentials[0];
      if (ssh) setCred(String(ssh.id));
    }).catch(() => setT({ hosts: [], credentials: [] }));
    GET('/discover/config').then(c => setPve(c.proxmox?.url || '')).catch(() => {});
  }, [dev.id]);
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
  const vnc = (dev.services || []).find((s: Row) => s.port >= 5900 && s.port <= 5999);
  return <div className="disc-form connect">
    <div className="inline">
      <label className="disc-field"><span>Address</span>
        <input list="cn-hosts" value={host} onChange={e => setHost(e.target.value)} />
        <datalist id="cn-hosts">{t.hosts.map((h: string) => <option key={h} value={h} />)}</datalist></label>
      <label className="disc-field"><span>Port</span><input value={port} onChange={e => setPort(e.target.value)} inputMode="numeric" style={{ width: 80 }} /></label>
      <label className="disc-field"><span>Login</span><select value={cred} onChange={e => setCred(e.target.value)}>
        <option value="">None (this computer’s SSH key)</option>
        {t.credentials.map((x: Row) => <option key={x.id} value={x.id}>{`${x.label}${x.username ? ` (${x.username})` : ''}`}</option>)}</select></label>
    </div>
    <div className="connect-list">
      {S.caps?.terminal !== false ? <div><Btn label="⌨ Terminal in HaRM" cls="primary" disabled={!host || (!user && !!cred)} onClick={term} />
        <span className="muted small">SSH in this window, with the saved login. Closes when HaRM locks.</span></div> : null}
      <div><a className="button" href={`ssh://${encodeURI(at)}${p !== 22 ? `:${p}` : ''}`}>↗ Open in my SSH app</a>
        <span className="muted small">If your computer has an app for ssh:// links.</span></div>
      <div><Btn label="📋 Copy SSH command" onClick={() => copy(sshCmd, `Copied: ${sshCmd}`)} /><span className="mono small">{sshCmd}</span></div>
      {isWindows(dev) || (dev.services || []).some((s: Row) => s.port === 3389) ? <div><Btn label="🖥 Remote desktop file (.rdp)" onClick={rdp} />
        <span className="muted small">Opens in Remote Desktop (Windows, Mac) or Remmina. It asks for the password itself.</span></div> : null}
      {vnc ? <div><a className="button" href={`vnc://${host}:${vnc.port}`}>↗ VNC</a><span className="muted small">{`Port ${vnc.port}, in your VNC app.`}</span></div> : null}
      {pveUrl ? <div><a className="button" href={pveUrl} target="_blank" rel="noopener noreferrer">↗ Proxmox console</a>
        <span className="muted small">{guest ? 'The VM’s screen, in Proxmox (sign in to Proxmox if it asks).' : 'The node’s shell, in Proxmox.'}</span></div> : null}
      {dev.mgmt_url ? <div><a className="button" href={dev.mgmt_url} target="_blank" rel="noopener noreferrer">↗ Management page</a>
        <span className="muted small">iDRAC, iLO or IPMI: its own remote console is in there.</span></div> : null}
    </div>
  </div>;
}
