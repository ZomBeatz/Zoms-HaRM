/* Logins in and out: import a Bitwarden or Vaultwarden export, export for Bitwarden, and change a
 * login's password on a Linux machine over SSH (then keep the new one in HaRM). */
import { useEffect, useState } from 'react';
import { api, GET } from '../api/client';
import { S } from '../lib/state';
import { downloadText, genPassword, type Row } from '../lib/util';
import { copy, modal, toast, type ModalCtl } from '../ui/overlay';
import { Btn, EyeButton, Small, Spinner, Table } from '../ui/bits';

type After = (() => unknown) | null | undefined;

/* ------------------------------------------------------------------ import */

export function importBitwarden(after?: After) {
  modal('Import from Bitwarden', (m: ModalCtl) => <Import m={m} after={after} />, { wide: true });
}

function Import({ m, after }: { m: ModalCtl; after?: After }) {
  const [data, setData] = useState('');
  const [items, setItems] = useState<Row[] | null>(null);
  const [pick, setPick] = useState<Record<number, { on: boolean; device_id: string }>>({});
  const [busy, setBusy] = useState(false);
  const read = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    try {
      const text = await f.text();
      const r = await api('POST', '/vault/bitwarden/preview', { data: text });
      setData(text); setItems(r.items);
      setPick(Object.fromEntries(r.items.map((it: Row) => [it.i, { on: !it.duplicate, device_id: it.device ? String(it.device.id) : '' }])));
    } catch (e) { toast((e as Error).message, 'bad'); }
    setBusy(false);
  };
  const save = async () => {
    setBusy(true);
    try {
      const picks = Object.entries(pick).filter(([, p]) => p.on).map(([i, p]) => ({ i: +i, device_id: p.device_id ? +p.device_id : null }));
      const r = await api('POST', '/vault/bitwarden/import', { data, picks });
      setData('');  // the export holds every password in plain text: don't keep it around
      m.close(true);
      toast(`Imported ${r.imported} login${r.imported === 1 ? '' : 's'}. Now delete the export file from your computer.`, 'ok');
      after?.();
    } catch (e) { toast((e as Error).message, 'bad'); }
    setBusy(false);
  };
  const devices = [...S.lk.devices].sort((a, b) => a.name.localeCompare(b.name));
  if (!items) return <div className="disc-form">
    <ol>
      <li>In Bitwarden (or Vaultwarden): <b>Tools &gt; Export vault</b>, file format <b>.json</b> (not the encrypted one).</li>
      <li>Pick the file here. HaRM shows what’s in it, with the device each login seems to be for, before anything is saved.</li>
      <li>After importing, delete the export file: it holds every password in plain text.</li>
    </ol>
    <p className="muted small">Logins come in encrypted with your master password. Cards, identities and secure notes stay in Bitwarden.</p>
    <label className="button primary">⇩ Choose the export file<input type="file" accept=".json,application/json" hidden onChange={e => read(e.target.files?.[0])} /></label>
    {busy ? <Spinner /> : null}
  </div>;
  const n = Object.values(pick).filter(p => p.on).length;
  return <div className="disc-form">
    <p>{`${items.length} login${items.length === 1 ? '' : 's'} in the export. Untick any you don’t want; ones HaRM already has (same name and username) start unticked.`}</p>
    <div className="table-wrap"><Table rows={items} cols={[
      { label: '', nosort: true, get: it => <input type="checkbox" aria-label={`Import ${it.label}`} checked={!!pick[it.i]?.on} onChange={e => setPick(p => ({ ...p, [it.i]: { ...p[it.i], on: e.target.checked } }))} /> },
      { label: 'Login', get: it => <span><b>{it.label}</b>{it.duplicate ? <span className="badge muted">already in HaRM</span> : null}
        <div className="muted small">{[it.username, it.url, it.folder].filter(Boolean).join(' · ')}{it.has_totp ? ' · 2FA' : ''}</div></span>, sort: it => it.label },
      { label: 'Device', get: it => <select aria-label="Device" value={pick[it.i]?.device_id || ''} onChange={e => setPick(p => ({ ...p, [it.i]: { ...p[it.i], device_id: e.target.value } }))}>
        <option value="">None</option>{devices.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select> },
    ]} /></div>
    <div className="actions"><Btn label="Cancel" onClick={() => { setData(''); m.close(true); }} /><Btn label={`Import ${n}`} cls="primary" disabled={!n || busy} onClick={save} /></div>
  </div>;
}

/* ------------------------------------------------------------------ export */

export function exportBitwarden() {
  modal('Export for Bitwarden', (m: ModalCtl) => <Export m={m} />);
}

function Export({ m }: { m: ModalCtl }) {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const out = await api('POST', '/vault/bitwarden/export', { password: pw });
      setPw('');
      downloadText(`harm-logins-for-bitwarden-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(out, null, 2), 'application/json');
      m.close(true);
      toast(`Exported ${out.items.length} logins. Import the file in Bitwarden, then delete it.`, 'ok');
    } catch (e) { toast((e as Error).message, 'bad'); }
    setBusy(false);
  };
  return <form className="disc-form" onSubmit={e => { e.preventDefault(); go(); }}>
    <p>Saves every login (password, 2FA secret, notes and address) in a file Bitwarden and Vaultwarden can import (<b>Tools &gt; Import data</b>, format <b>Bitwarden (json)</b>). They land in a folder called HaRM.</p>
    <p className="warn-text small">The file holds every password in plain text. Import it, then delete it, and don’t email or sync it anywhere.</p>
    <label className="disc-field"><span>Master password</span><input type="password" autoComplete="current-password" value={pw} onChange={e => setPw(e.target.value)} /></label>
    <div className="actions"><Btn label="Cancel" onClick={() => m.close(true)} /><Btn label="⇪ Export" cls="primary" disabled={!pw || busy} onClick={go} /></div>
  </form>;
}

/* ------------------------------------------------------------------ change a password on the machine */

export function changeOnMachine(cred: Row, after?: After) {
  modal(`Change ${cred.username}’s password`, (m: ModalCtl) => <Change m={m} cred={cred} after={after} />);
}

function Change({ m, cred, after }: { m: ModalCtl; cred: Row; after?: After }) {
  const [t, setT] = useState<Row | null>(null);
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [via, setVia] = useState(String(cred.id));
  const [sudo, setSudo] = useState(cred.username !== 'root');
  const [pw, setPw] = useState(() => genPassword(24));
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Row | null>(null);
  useEffect(() => {
    if (!cred.device_id) { setT({ hosts: [], credentials: [] }); return; }
    GET(`/devices/${cred.device_id}/collect-targets`).then(x => { setT(x); setHost(x.hosts[0] || ''); }).catch(() => setT({ hosts: [], credentials: [] }));
  }, [cred.device_id]);
  if (!t) return <div className="muted"><Spinner /> Loading…</div>;
  const others = t.credentials.filter((c: Row) => c.id !== cred.id && c.username);
  const go = async () => {
    setBusy(true);
    try {
      const r = await api('POST', `/credentials/${cred.id}/change-on-machine`, { host, port: +port || 22, via_credential_id: +via, sudo, new_password: pw });
      setDone(r); after?.();
    } catch (e) { toast((e as Error).message, 'bad'); }
    setBusy(false);
  };
  if (done) return <div className="disc-form">
    <p className="ok-text">{`Changed on ${host}, and saved in HaRM. The old password is kept in this login’s secret notes, in case something else still uses it.`}</p>
    {done.works === true ? <p>✓ It signs in with the new password.</p>
      : done.works === false ? <p className="warn-text">HaRM couldn’t sign in with the new password over SSH. That’s expected if the machine only allows SSH keys; otherwise check it now, while you still have a session open.</p> : null}
    <p className="muted">If this login is also in Bitwarden or another password manager, update it there too.</p>
    <div className="actions"><Btn label="📋 Copy new password" onClick={() => copy(pw, 'New password copied')} /><Btn label="Done" cls="primary" onClick={() => m.close(true)} /></div>
  </div>;
  return <form className="disc-form" onSubmit={e => { e.preventDefault(); go(); }}>
    <p>{`HaRM connects over SSH and sets a new password for the Linux user ${cred.username} with chpasswd, then keeps it here. It works on Linux machines (Proxmox, Debian, Ubuntu, most NAS boxes).`}</p>
    <div className="inline">
      <label className="disc-field"><span>Machine</span><input list="cp-hosts" value={host} onChange={e => setHost(e.target.value)} placeholder="10.0.0.20" />
        <datalist id="cp-hosts">{t.hosts.map((h: string) => <option key={h} value={h} />)}</datalist></label>
      <label className="disc-field"><span>Port</span><input value={port} onChange={e => setPort(e.target.value)} inputMode="numeric" style={{ width: 80 }} /></label>
    </div>
    <label className="disc-field"><span>Connect with</span><select value={via} onChange={e => setVia(e.target.value)}>
      <option value={cred.id}>{`This login, with its current password (${cred.username})`}</option>
      {others.map((c: Row) => <option key={c.id} value={c.id}>{`${c.label} (${c.username})`}</option>)}</select></label>
    <label className="check inline-check"><input type="checkbox" checked={sudo} onChange={e => setSudo(e.target.checked)} />Use sudo (needed unless connecting as root)</label>
    <label className="disc-field"><span>New password</span><div className="inline">
      <input type={shown ? 'text' : 'password'} className="mono" value={pw} onChange={e => setPw(e.target.value)} autoComplete="new-password" style={{ minWidth: 260 }} />
      <EyeButton shown={shown} setShown={setShown} /><Small label="⟳ New one" onClick={() => setPw(genPassword(24))} /><Small label="📋" title="Copy" onClick={() => copy(pw, 'Copied')} /></div></label>
    <p className="warn-text small">Anything else that signs in as this user with the old password (scripts, backup jobs, other apps) stops working until you update it.</p>
    <div className="actions"><Btn label="Cancel" onClick={() => m.close(true)} /><Btn label={busy ? 'Changing…' : '🔑 Change password'} cls="primary" disabled={busy || !host || pw.length < 12} onClick={go} /></div>
  </form>;
}
