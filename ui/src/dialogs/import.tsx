/* Import specs: read a machine's hardware (over SSH, on the HaRM computer, or by pasting the
 * collector's output) and pick what to add. */
import { useEffect, useRef, useState } from 'react';
import { api, GET, loadLookups } from '../api/client';
import { S } from '../lib/state';
import { STORAGE_CATS, asset, nz, type Row } from '../lib/util';
import { copy, modal, toast, type ModalCtl } from '../ui/overlay';
import { Btn, Small } from '../ui/bits';

/* The machines being inventoried usually don't trust HaRM's private certificate, so the
   download skips that check and the script's SHA-256 (shown here over the trusted
   connection) is verified before anything runs. */
function collectorCommands(): [string, string, string | null][] {
  const base = `${location.origin}/static/collect`;
  const sha = S.caps.collect_sha256 || {};
  const sh = sha.sh ? `curl -fsSLk ${base}/harm-collect.sh -o harm-collect.sh && echo "${sha.sh}  harm-collect.sh" | ` : null;
  const ps = sha.ps1
    ? `$p=@{}; if ($PSVersionTable.PSVersion.Major -ge 6) { $p.SkipCertificateCheck=$true } else { [Net.ServicePointManager]::ServerCertificateValidationCallback={$true} }; iwr @p ${base}/harm-collect.ps1 -UseBasicParsing -OutFile harm-collect.ps1; if ((Get-FileHash harm-collect.ps1).Hash -ne '${sha.ps1}') { throw 'Checksum mismatch: not running it' }; powershell -ExecutionPolicy Bypass -File .\\harm-collect.ps1 | Set-Clipboard`
    : `iwr ${base}/harm-collect.ps1 -OutFile harm-collect.ps1; powershell -ExecutionPolicy Bypass -File .\\harm-collect.ps1 | Set-Clipboard`;
  return [
    ['Linux', sh ? `${sh}sha256sum -c --quiet && sudo bash harm-collect.sh` : `curl -fsSL ${base}/harm-collect.sh -o harm-collect.sh && sudo bash harm-collect.sh`,
      'sudo is optional; it adds the serial number and memory stick details. The checksum check stops it if the download was tampered with.'],
    ['macOS', sh ? `${sh}shasum -a 256 -c -s && bash harm-collect.sh` : `curl -fsSL ${base}/harm-collect.sh -o harm-collect.sh && bash harm-collect.sh`, null],
    ['Windows (PowerShell)', ps, 'The result is copied to the clipboard; just paste it below.'],
  ];
}

function SshPane({ dev, parse, setErr }: { dev: Row; parse: (text: string) => Promise<void>; setErr: (e: React.ReactNode) => void }) {
  const [t, setT] = useState<Row | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [cred, setCred] = useState('');
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [sudo, setSudo] = useState(true);
  const [os, setOs] = useState('auto');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    GET(`/devices/${dev.id}/collect-targets`).then(x => {
      setT(x); setHost(x.hosts[0] || '');
      setCred(x.credentials[0] ? String(x.credentials[0].id) : '');
      if (x.is_windows) setOs('windows');
    }).catch(e => setLoadErr(e.message));
  }, [dev.id]);
  if (loadErr) return <div className="form-error">{loadErr}</div>;
  if (!t) return <div className="muted">Loading…</div>;
  if (!t.ssh) return <div className="notice">The HaRM server has no ssh client. Install the openssh-client package, or use “Run it yourself”.</div>;
  const go = async (trust = false): Promise<void> => {
    setBusy(true); setErr('');
    const who = cred ? (t.credentials.find((c: Row) => String(c.id) === cred)?.username || '?') : user;
    setStatus(`Connecting to ${who}@${host} and reading specs… (up to a minute)`);
    try {
      const r = await api('POST', `/devices/${dev.id}/collect`, {
        mode: 'ssh', host: host.trim(), port: +port || 22, credential_id: cred || null,
        username: cred ? null : user.trim(), password: cred ? null : pass, sudo, os, trust_new_key: trust,
      });
      setStatus('✓ Read. Check the list below, then add what you want.');
      await parse(r.output);
    } catch (x) {
      setStatus('');
      const msg = (x as Error).message;
      setErr(/host key changed/i.test(msg) ? <>{msg} <Small label="I reinstalled it: trust the new key and retry" onClick={() => go(true)} cls="primary" /></> : msg);
    }
    setBusy(false);
  };
  return (
    <div>
      <p>HaRM connects to <b>{dev.name}</b> over SSH, runs the same read-only collector, and shows what it found. Nothing is changed on that machine.</p>
      <div className="grid two">
        <label className="disc-field"><span>Address</span><div className="inline">
          <input value={host} placeholder="192.168.1.50 or hostname" className="mono" list="collect-hosts" onChange={e => setHost(e.target.value)} />
          <input type="number" value={port} min={1} max={65535} className="port-in" onChange={e => setPort(e.target.value)} /></div>
          <datalist id="collect-hosts">{t.hosts.map((x: string) => <option key={x} value={x} />)}</datalist></label>
        <label className="disc-field"><span>Login</span><select value={cred} onChange={e => setCred(e.target.value)}>
          {t.credentials.map((c: Row) => <option key={c.id} value={c.id}>{`${c.label}${c.username ? ` (${c.username})` : ''}${c.has_password ? '' : ' · no password saved'}`}</option>)}
          <option value="">Other: type a username…</option></select></label>
      </div>
      <div className="grid two" hidden={!!cred}>
        <input placeholder="root" autoComplete="off" value={user} onChange={e => setUser(e.target.value)} />
        <input type="password" placeholder="Password (not saved). Leave blank for SSH keys" autoComplete="new-password" value={pass} onChange={e => setPass(e.target.value)} />
      </div>
      <div className="grid two">
        <label className="check inline-check"><input type="checkbox" checked={sudo} onChange={e => setSudo(e.target.checked)} />Use sudo (adds serial number and memory sticks on Linux)</label>
        <label className="disc-field"><span>System</span><select value={os} onChange={e => setOs(e.target.value)}>
          <option value="auto">Detect automatically</option><option value="unix">Linux / macOS</option><option value="windows">Windows (OpenSSH)</option></select></label>
      </div>
      <div className="actions"><Btn label="Connect & read specs" onClick={() => go()} cls="primary" disabled={busy} /></div>
      <div className="muted small">{status}</div>
      <p className="muted small">The saved password is used on the HaRM server and never sent to this browser. The machine’s SSH host key is remembered the first time, and HaRM refuses to connect if it changes. SSH keys of the account running HaRM also work: pick “Other”, enter the username, and leave the password blank.</p>
    </div>
  );
}

function ImportPreview({ r, dev, d, m, after }: { r: Row; dev: Row; d: Row; m: ModalCtl; after: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, [r]);
  const fieldLabels: Record<string, string> = { hostname: 'Hostname', os: 'OS', manufacturer: 'Manufacturer', model: 'Model', serial: 'Serial / service tag', cpu: 'CPU', ram: 'RAM' };
  const devRows = Object.entries(fieldLabels).filter(([k]) => r.device[k]);
  const haveSerials = new Set(d.components.map((c: Row) => (c.serial || '').toUpperCase()).filter(Boolean));
  const haveMacs = new Set(d.interfaces.map((i: Row) => (i.mac || '').toUpperCase()).filter(Boolean));
  const parts: Row[] = [...(r.cpus || []), ...r.memory, ...r.disks, ...r.gpus];
  const same = (c: Row, p: Row) => p.serial ? (c.serial || '').toUpperCase() === p.serial.toUpperCase()
    : c.category === p.category && (c.model || '').toLowerCase() === (p.model || '').toLowerCase();
  const partDup = (p: Row) => p.serial ? haveSerials.has(p.serial.toUpperCase()) : d.components.some((c: Row) => same(c, p));
  // Replace mode: parts of the kinds this scan read (CPU, memory, drives, graphics) that it didn't find.
  const kind = (cat: string) => STORAGE_CATS.test(cat || '') ? 'drive' : cat;
  const kinds = new Set(parts.filter(p => !p.integrated).map(p => kind(p.category)));
  const missing: Row[] = d.components.filter((c: Row) => kinds.has(kind(c.category)) && !parts.some(p => same(c, p)));
  const [mode, setMode] = useState<'add' | 'replace'>('add');
  const [delOn, setDelOn] = useState<boolean[]>(() => missing.map(() => false));
  const pickMode = (m2: 'add' | 'replace') => { setMode(m2); setDelOn(missing.map(() => m2 === 'replace')); };
  const [devOn, setDevOn] = useState<Record<string, boolean>>(() => Object.fromEntries(devRows.map(([k]) => [k, !dev[k]])));
  const [partOn, setPartOn] = useState<boolean[]>(() => parts.map(p => !partDup(p) && !p.integrated));
  const [nicOn, setNicOn] = useState<boolean[]>(() => r.nics.map((n: Row) => !haveMacs.has(n.mac.toUpperCase())));
  const [busy, setBusy] = useState(false);
  const apply = async () => {
    setBusy(true);
    let nDev = 0, nParts = 0, nIf = 0, nDel = 0;
    // What this import did, so Undo can put it back exactly.
    const undo: ImportUndo = { device: dev.id, before: {}, parts: [], interfaces: [], deleted: [] };
    try {
      const patch: Row = {};
      for (const [k] of devRows) if (devOn[k] && dev[k] !== r.device[k]) { patch[k] = r.device[k]; undo.before[k] = dev[k] ?? null; nDev++; }
      if (Object.keys(patch).length) await api('PUT', `/devices/${dev.id}`, patch);
      for (const [i, c] of missing.entries()) {
        if (!delOn[i]) continue;
        await api('DELETE', `/components/${c.id}`);
        undo.deleted.push(c);
        nDel++;
      }
      for (const [i, p] of parts.entries()) {
        if (!partOn[i]) continue;
        const body: Row = { ...p, device_id: dev.id, status: 'Installed' };
        delete body.integrated; delete body.library_match; delete body.custom_specs;
        if (p.custom_specs?.cores) {  // CPU not in the library: save its specs so cores/threads show
          const part = await api('POST', '/catalog', { category: 'cpu', name: nz(p.manufacturer, p.model), manufacturer: p.manufacturer, specs: p.custom_specs });
          body.catalog_id = part.id;
        }
        undo.parts.push((await api('POST', '/components', body)).id);
        nParts++;
      }
      for (const [i, n] of r.nics.entries()) {
        if (!nicOn[i]) continue;
        undo.interfaces.push((await api('POST', '/interfaces', { ...n, device_id: dev.id })).id);
        nIf++;
      }
      await loadLookups();
      m.close(true);
      S.lastImport[dev.id] = undo;
      toast(`Imported: ${nDev} field${nDev === 1 ? '' : 's'}, ${nParts} part${nParts === 1 ? '' : 's'}, ${nIf} interface${nIf === 1 ? '' : 's'}${nDel ? `; ${nDel} old part${nDel === 1 ? '' : 's'} deleted` : ''}`,
        'ok', { label: 'Undo', onClick: () => undoImport(dev.id, after) });
      after();
    } catch (e) { toast((e as Error).message, 'bad'); setBusy(false); }
  };
  const flip = <T,>(set: React.Dispatch<React.SetStateAction<T[]>>, i: number, on: boolean) => set(list => list.map((x, j) => j === i ? on as T : x));
  return (
    <div ref={box}>
      <h3 className="import-h">{`3. Choose what to add (found on a ${r.platform} machine)`}</h3>
      {devRows.length ? <>
        <h4>Device details</h4><p className="muted small">Fields that already have a different value are unticked; tick them to overwrite.</p>
        <div className="table-wrap"><table className="import-table"><tbody>{devRows.map(([k, label]) => {
          const nv = r.device[k], cur = dev[k], same = cur === nv;
          return <tr key={k} className={same ? 'muted' : ''}>
            <td>{same ? '✓' : <input type="checkbox" checked={devOn[k]} onChange={e => setDevOn(o => ({ ...o, [k]: e.target.checked }))} />}</td>
            <td>{label}</td><td className="muted">{cur || 'None'}</td><td>{same ? 'already set' : <b>{nv}</b>}</td></tr>;
        })}</tbody></table></div>
      </> : null}
      {parts.length ? <>
        <h4>Parts inside it (CPU, memory, drives, graphics)</h4>
        {r.device.storage_total ? <p className="muted small">{`Drives found: ${r.disks.length} (${r.device.storage_total} total).`}</p> : null}
        <div className="table-wrap"><table className="import-table"><tbody>{parts.map((p, i) => {
          const dup = partDup(p);
          return <tr key={i}><td><input type="checkbox" checked={partOn[i]} onChange={e => flip(setPartOn, i, e.target.checked)} /></td>
            <td>{p.category}</td><td><b>{[p.manufacturer, p.model].filter(Boolean).join(' ') || 'None'}</b></td>
            <td>{[p.capacity, p.interface, p.quantity > 1 ? `×${p.quantity}` : null].filter(Boolean).join(' · ')}</td>
            <td className="mono small">{p.serial || ''}</td>
            <td className="muted small">{dup ? 'already recorded' : (p.integrated ? 'built-in graphics' : p.library_match ? '✓ found in parts library' : '')}</td></tr>;
        })}</tbody></table></div>
      </> : null}
      {missing.length ? <>
        <h4>On the device, but not in this scan</h4>
        <div className="chips">{([['add', 'Add to what’s there'], ['replace', 'Replace with this scan']] as const).map(([k, l]) => (
          <button key={k} type="button" className={'chip' + (mode === k ? ' on' : '')} onClick={() => pickMode(k)}>{l}</button>))}</div>
        <p className="muted small">Ticked parts are deleted (they don’t go to Spare Parts). Only the kinds of parts this scan read are listed; network ports are never removed.</p>
        <div className="table-wrap"><table className="import-table"><tbody>{missing.map((c, i) => (
          <tr key={c.id} className={delOn[i] ? 'import-del' : ''}><td><input type="checkbox" aria-label="Delete" checked={delOn[i]} onChange={e => flip(setDelOn, i, e.target.checked)} /></td>
            <td>{c.category}</td><td><b>{[c.manufacturer, c.model].filter(Boolean).join(' ') || 'None'}</b></td>
            <td>{[c.capacity, c.interface, c.quantity > 1 ? `×${c.quantity}` : null].filter(Boolean).join(' · ')}</td>
            <td className="mono small">{c.serial || ''}</td><td className="muted small">{delOn[i] ? 'will be deleted' : 'kept'}</td></tr>
        ))}</tbody></table></div>
      </> : null}
      {r.memory.length === 0 && r.platform === 'linux' ? <p className="muted small">No memory stick details. Run the Linux script with sudo to include them.</p> : null}
      {r.nics.length ? <>
        <h4>Network interfaces</h4>
        <div className="table-wrap"><table className="import-table"><tbody>{r.nics.map((n: Row, i: number) => {
          const dup = haveMacs.has(n.mac.toUpperCase());
          return <tr key={i}><td><input type="checkbox" checked={nicOn[i]} onChange={e => flip(setNicOn, i, e.target.checked)} /></td>
            <td>{n.name}</td><td>{n.kind}</td><td className="mono">{[n.ip ? n.ip + (n.subnet || '') : '', n.ipv6].filter(Boolean).join(' · ')}</td>
            <td className="mono small">{n.mac}</td><td className="muted small">{dup ? 'already recorded' : (n.speed || '')}</td></tr>;
        })}</tbody></table></div>
      </> : null}
      <div className="actions"><button type="button" className="primary" disabled={busy} onClick={apply}>{delOn.some(Boolean) ? 'Add and delete the ticked items' : 'Add the ticked items'}</button></div>
    </div>
  );
}

function ImportSpecs({ dev, d, m, after }: { dev: Row; d: Row; m: ModalCtl; after: () => void }) {
  const [pane, setPane] = useState('ssh');
  const [err, setErr] = useState<React.ReactNode>('');
  const [text, setText] = useState('');
  const [result, setResult] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);
  const parse = async (t: string) => {
    setErr('');
    try { setResult(await api('POST', '/specs/parse', { text: t })); }
    catch (e) { setErr((e as Error).message); }
  };
  const show = (k: string) => { setPane(k); setErr(''); };
  return (
    <div className="import-steps">
      <div className="chips">{[['ssh', '🔌 Over SSH'], ['local', '🖥 This computer (HaRM server)'], ['manual', '📋 Run it yourself']].map(([k, l]) => (
        <button key={k} type="button" className={'chip' + (pane === k ? ' on' : '')} data-k={k} onClick={() => show(k)}>{l}</button>
      ))}</div>
      <div hidden={pane !== 'ssh'}><SshPane dev={dev} parse={parse} setErr={setErr} /></div>
      <div hidden={pane !== 'local'}>
        <p>Use this when <b>{dev.name}</b> is the computer HaRM itself runs on. The collector runs right here, without SSH.</p>
        <p className="muted small">It runs as the account HaRM runs under, so the serial number and memory stick details are only included if HaRM runs as root. Everything else (CPU, drives, network cards, GPU) is read normally.</p>
        <div className="actions"><Btn label="Read this computer’s specs" cls="primary" disabled={busy} onClick={async () => {
          setBusy(true); setErr('');
          try { await parse((await api('POST', `/devices/${dev.id}/collect`, { mode: 'local' })).output); }
          catch (x) { setErr((x as Error).message); }
          setBusy(false);
        }} /></div>
      </div>
      <div hidden={pane !== 'manual'}>
        <p><b>{`1. On ${dev.name}, run the command for its OS.`}</b> It only reads hardware info and prints it. Nothing is sent anywhere. <a href={asset('collect/harm-collect.sh')} target="_blank" rel="noopener">Linux/macOS script</a> · <a href={asset('collect/harm-collect.ps1')} target="_blank" rel="noopener">Windows script</a></p>
        {collectorCommands().map(([os, cmd, note]) => (
          <div key={os} className="cmd"><div className="cmd-head"><b>{os}</b><Small label="Copy" onClick={() => copy(cmd, `${os} command`)} /></div>
            <pre className="code">{cmd}</pre>{note ? <div className="muted small">{note}</div> : null}</div>
        ))}
        <p className="muted small">If that machine can’t reach HaRM, download the script here and copy it over on a USB stick.</p>
        <p><b>2. Paste everything it printed:</b></p>
        <textarea rows={6} placeholder="Paste the output here (it starts with {&quot;harm_collect&quot;…)" spellCheck={false} className="mono" value={text} onChange={e => setText(e.target.value)} />
        <div className="actions"><Btn label="Read it" onClick={() => parse(text)} cls="primary" /></div>
      </div>
      <div className="form-error">{err}</div>
      {result ? <ImportPreview key={JSON.stringify(result).length} r={result} dev={dev} d={d} m={m} after={after} /> : null}
    </div>
  );
}

export interface ImportUndo { device: number; before: Row; parts: number[]; interfaces: number[]; deleted: Row[] }
const KEEP_OUT = ['id', 'created_at', 'updated_at', 'device_name', 'location_name', 'rack_name'];

/* Takes back the last import on a device: removes what it added, brings back what it deleted, and
   restores the fields it changed. Offered in the import's message and the device's ⋯ menu. */
export async function undoImport(deviceId: number, after: () => void) {
  const u = S.lastImport[deviceId];
  if (!u) return;
  delete S.lastImport[deviceId];
  try {
    for (const id of u.parts) await api('DELETE', `/components/${id}`).catch(() => {});
    for (const id of u.interfaces) await api('DELETE', `/interfaces/${id}`).catch(() => {});
    for (const c of u.deleted) await api('POST', '/components', Object.fromEntries(Object.entries(c).filter(([k]) => !KEEP_OUT.includes(k))));
    if (Object.keys(u.before).length) await api('PUT', `/devices/${deviceId}`, u.before);
    await loadLookups();
    toast('Import undone');
  } catch (e) { toast((e as Error).message, 'bad'); }
  after();
}

export function importSpecs(dev: Row, d: Row, after: () => void) {
  modal(`Import specs: ${dev.name}`, m => <ImportSpecs dev={dev} d={d} m={m} after={after} />, { wide: true });
}
