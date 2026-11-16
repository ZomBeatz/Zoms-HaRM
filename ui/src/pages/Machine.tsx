/* A machine's health and updates (Device > Health): disk space, drives' SMART health, ZFS pools and
 * RAID, memory, waiting updates and restarts, and backups, read over SSH with a saved login. Disks
 * and volumes can carry a label saying what they really are ("12 × 4 TB in RAID 6"), shown over
 * what the system reports. Installing updates and restarting are one click each, never scheduled. */
import { useEffect, useState } from 'react';
import { api, GET } from '../api/client';
import type { BackupCheck, Disk, MachineLabel, MachineView, Problem, Volume } from '../api/types';
import { duration, timeAgo, type Row } from '../lib/util';
import { choose, modal, toast, type ModalCtl } from '../ui/overlay';
import { Bar, Btn, Card, MenuButton, Small, Spinner, Table } from '../ui/bits';
import { Connect } from './Containers';

export const fmtBytes = (n: number | null | undefined) => {
  if (n == null) return '';
  for (const [u, d] of [['TB', 1e12], ['GB', 1e9], ['MB', 1e6]] as const) {
    if (n >= d) { const v = n / d; return `${v < 100 ? +v.toFixed(1) : Math.round(v)} ${u}`; }
  }
  return `${n} B`;
};
const LEVEL: Record<string, string> = { bad: 'bad', warn: 'warn', info: 'info' };
export const ProblemList = ({ items, showDevice = false }: { items: Problem[]; showDevice?: boolean }) =>
  items.length ? <ul className="plain-list">{items.map(p => <li key={(p.device_id || '') + p.key}>
    <span className={`badge ${LEVEL[p.level]}`}>{p.level === 'bad' ? 'Problem' : p.level === 'warn' ? 'Check' : 'Note'}</span>{' '}
    {showDevice && p.device ? <>{p.device_id ? <a href={`#/devices/${p.device_id}?tab=health`}><b>{p.device}</b></a> : <b>{p.device}</b>}{': '}</> : null}{p.text}</li>)}</ul> : null;

const hoursText = (h: number) => h % 24 ? `${h} hours` : h === 24 ? 'day' : `${h / 24} days`;
const HOURS = [6, 12, 24, 36, 48, 72, 168, 336, 720];

function backupAge(b: BackupCheck) {
  if (b.unread) return <span className="muted small">read on the next check</span>;
  if (b.missing) return <span className="bad-text">{b.kind === 'folder' ? 'folder not found' : 'no snapshots'}</span>;
  if (!b.newest) return <span className="warn-text">nothing yet</span>;
  const old = (Date.now() - new Date(b.newest.replace(' ', 'T') + 'Z').getTime()) / 3.6e6 > b.hours;
  return <span className={old ? 'warn-text' : undefined}>{`newest ${timeAgo(b.newest)}`}</span>;
}

/* What a disk or volume really is, over what the system reports. */
function labelDialog(deviceId: number, key: string, what: string, shown: string, cur: MachineLabel, done: (v: MachineView) => void) {
  modal(`What is ${what}?`, (m: ModalCtl) => <LabelForm m={m} deviceId={deviceId} k={key} shown={shown} cur={cur} done={done} />);
}
function LabelForm({ m, deviceId, k, shown, cur, done }: { m: ModalCtl; deviceId: number; k: string; shown: string; cur: MachineLabel; done: (v: MachineView) => void }) {
  const [name, setName] = useState(cur.name || '');
  const [real, setReal] = useState(cur.real || '');
  const [ignore, setIgnore] = useState(!!cur.ignore);
  const save = async (clear = false) => {
    try { done(await api('POST', `/devices/${deviceId}/machine/labels`, clear ? { key: k } : { key: k, name, real, ignore })); m.close(true); }
    catch (e) { toast((e as Error).message, 'bad'); }
  };
  return <div className="disc-form">
    <p className="muted">The system sees <b>{shown}</b>. Say what it really is, for example a RAID controller’s virtual drive made of several disks. HaRM shows your words first and keeps reading the real values underneath.</p>
    <label className="disc-field"><span>Call it</span><input value={name} placeholder="Media array" onChange={e => setName(e.target.value)} maxLength={80} /></label>
    <label className="disc-field"><span>What it really is</span><input value={real} placeholder="12 × 4 TB in RAID 6 (40 TB usable)" onChange={e => setReal(e.target.value)} maxLength={120} /></label>
    <label className="check inline-check"><input type="checkbox" checked={ignore} onChange={e => setIgnore(e.target.checked)} />Don’t warn about it (a full boot partition that’s meant to be small, say)</label>
    <div className="actions">{cur.name || cur.real || cur.ignore ? <Btn label="Remove label" onClick={() => save(true)} /> : null}<Btn label="Cancel" onClick={() => m.close(true)} /><Btn label="Save" cls="primary" onClick={() => save()} /></div>
  </div>;
}

function BackupForm({ m, deviceId, cur, done }: { m: ModalCtl; deviceId: number; cur: BackupCheck[]; done: (v: MachineView) => void }) {
  const [rows, setRows] = useState<BackupCheck[]>(cur.length ? cur.map(b => ({ ...b })) : [{ kind: 'folder', path: '', hours: 36, name: '' }]);
  const set = (i: number, patch: Partial<BackupCheck>) => setRows(r => r.map((x, j) => j === i ? { ...x, ...patch } : x));
  const save = async () => {
    try { done(await api('POST', `/devices/${deviceId}/machine/backups`, { backups: rows.filter(r => r.path.trim()) })); m.close(true); toast('Saved. They’re read on the next check'); }
    catch (e) { toast((e as Error).message, 'bad'); }
  };
  return <div className="disc-form">
    <p className="muted">HaRM warns when the newest file in a folder, or the newest snapshot of a ZFS dataset, is older than you expect. Folders are searched three levels deep.</p>
    {rows.map((r, i) => <div key={i} className="inline wrap">
      <label className="disc-field"><span>Kind</span><select value={r.kind} onChange={e => set(i, { kind: e.target.value as 'folder' | 'zfs' })}><option value="folder">Folder</option><option value="zfs">ZFS snapshots</option></select></label>
      <label className="disc-field"><span>{r.kind === 'folder' ? 'Folder' : 'Dataset'}</span><input className="mono" value={r.path} placeholder={r.kind === 'folder' ? '/mnt/backups/nextcloud' : 'tank/media'} onChange={e => set(i, { path: e.target.value })} /></label>
      <label className="disc-field"><span>Name (optional)</span><input value={r.name} placeholder="Nextcloud backups" onChange={e => set(i, { name: e.target.value })} /></label>
      <label className="disc-field"><span>A new one every</span><select value={r.hours} onChange={e => set(i, { hours: +e.target.value })}>{HOURS.map(h => <option key={h} value={h}>{hoursText(h)}</option>)}</select></label>
      <Small label="🗑" title="Remove" onClick={() => setRows(x => x.filter((_, j) => j !== i))} />
    </div>)}
    <p><Small label="+ Add another" onClick={() => setRows(x => [...x, { kind: 'folder', path: '', hours: 36, name: '' }])} /></p>
    <div className="actions"><Btn label="Cancel" onClick={() => m.close(true)} /><Btn label="Save" cls="primary" onClick={save} /></div>
  </div>;
}

function BackgroundForm({ m, deviceId, conf, done }: { m: ModalCtl; deviceId: number; conf: MachineView['conf']; done: (v: MachineView) => void }) {
  const [creds, setCreds] = useState<Row[] | null>(null);
  const [cred, setCred] = useState('');
  const [sudo, setSudo] = useState('limited');
  const [hasKey, setHasKey] = useState(false);
  const [useKey, setUseKey] = useState(false);
  useEffect(() => {
    GET(`/devices/${deviceId}/collect-targets`).then(t => setCreds(t.credentials)).catch(() => setCreds([]));
    GET('/ssh-key').then(k => setHasKey(!!k.key)).catch(() => {});
  }, [deviceId]);
  const on = async () => {
    try { done(await api('POST', `/devices/${deviceId}/background`, { on: true, credential_id: cred || null, sudo, use_key: useKey })); m.close(true); toast('Background checks are on for this machine'); }
    catch (e) { toast((e as Error).message, 'bad'); }
  };
  return <div className="disc-form">
    <p>HaRM can check this machine on its own, also while it’s locked, every few hours (<b>Settings &gt; Status and actions</b>). It only reads: health, disk space, updates, backups and containers. Updates and restarts still wait for you.</p>
    <p className="warn-text small">To do that, HaRM keeps a copy of the login encrypted with a key in its data folder rather than your master password. Anyone who gets that folder could use it. Pick a login made for this, that can read but not change much (see <a href="#/help?s=background">Help: background checks</a>).</p>
    <label className="disc-field"><span>Login for background checks</span>
      <select value={cred} onChange={e => setCred(e.target.value)}>
        <option value="">Pick a saved login</option>
        {(creds || []).map(c => <option key={c.id} value={c.id}>{`${c.label}${c.username ? ` (${c.username})` : ''}`}</option>)}</select></label>
    {hasKey ? <label className="check"><input type="checkbox" checked={useKey} onChange={e => setUseKey(e.target.checked)} />
      <span>Sign in with HaRM’s SSH key, and keep no password (add the key to the machine first, with <b>🔌 Connect</b>)</span></label> : null}
    {cred && +cred === conf.credential_id ? <p className="warn-text small">That’s the login HaRM uses for your one-click checks. A login just for background checks is safer.</p> : null}
    <label className="disc-field"><span>sudo</span><select value={sudo} onChange={e => setSudo(e.target.value)}>
      <option value="limited">Only for drive health and the update list (set up on the machine, see Help)</option>
      <option value="none">None (no drive health; the update list may be old)</option>
      <option value="all">For the whole check (the login can do anything as root)</option></select></label>
    <div className="actions"><Btn label="Cancel" onClick={() => m.close(true)} /><Btn label="Turn on" cls="primary" disabled={!cred} onClick={on} /></div>
  </div>;
}

export function HealthTab({ deviceId, after }: { deviceId: number; after: () => void }) {
  const [v, setV] = useState<MachineView | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [setup, setSetup] = useState(false);
  useEffect(() => { GET<MachineView>(`/devices/${deviceId}/machine`).then(setV).catch(e => setErr(e.message)); }, [deviceId]);
  if (err) return <div className="form-error">{err}</div>;
  if (!v) return <div className="muted"><Spinner /> Loading…</div>;
  const got = (d: MachineView) => { setV(d); setSetup(false); after(); };
  if (!v.snap || setup) {
    return <Card title="Health and updates"><Connect<MachineView> deviceId={deviceId} conf={v.conf} onRead={got} path="machine/check" button="🩺 Check this machine"
      intro="HaRM connects over SSH with one of this device’s saved logins and reads its disk space, drive health (SMART), memory, waiting updates, whether it needs a restart, and its containers. Nothing is changed. Works on Linux, Proxmox and most NAS boxes."
      sudoHint="Use sudo (needed for drive health and to refresh the update list)" /></Card>;
  }
  const snap = v.snap;
  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    try { await fn(); } catch (e) { toast((e as Error).message, 'bad'); }
    setBusy('');
  };
  const check = () => run('check', async () => { got(await api('POST', `/devices/${deviceId}/machine/check`, {})); toast('Checked'); });
  const upgrade = () => run('upgrade', async () => {
    const u = snap.updates;
    if (await choose(`Install ${u.count} update${u.count === 1 ? '' : 's'}?`, <>HaRM runs the system’s own updater ({u.manager}) and keeps your changed settings files. It can take a few minutes; services may restart. {snap.os.pve ? 'On Proxmox this is a full upgrade, as Proxmox recommends.' : ''}</>,
      [['no', 'Cancel'], ['yes', 'Install updates', 'primary']]) !== 'yes') return;
    toast('Installing updates… this can take a few minutes');
    const r = await api('POST', `/devices/${deviceId}/machine/upgrade`, {});
    got(r);
    const out = () => modal('Install updates: output', <pre className="code logs">{r.output || 'Nothing was printed.'}</pre>, { wide: true });
    toast(r.ok ? 'Updates installed' : 'The update didn’t finish', r.ok ? 'ok' : 'bad', { label: 'Output', onClick: out });
  });
  const reboot = () => run('reboot', async () => {
    if (await choose('Restart this machine?', 'Everything on it stops for a minute or two, including VMs and containers that don’t start by themselves.',
      [['no', 'Cancel'], ['yes', 'Restart', 'primary']]) !== 'yes') return;
    await api('POST', `/devices/${deviceId}/machine/reboot`, {});
    toast('Restarting. Check again in a few minutes');
    got(await GET(`/devices/${deviceId}/machine`));
  });
  const background = () => v.background.on
    ? run('bg', async () => {
      if (await choose('Stop background checks?', 'HaRM forgets the copy of the login it kept for them.', [['no', 'Cancel'], ['yes', 'Stop them', 'primary']]) !== 'yes') return;
      got(await api('POST', `/devices/${deviceId}/background`, { on: false }));
    })
    : modal('Check it in the background', (m: ModalCtl) => <BackgroundForm m={m} deviceId={deviceId} conf={v.conf} done={got} />);
  const L = v.labels;
  const lbl = (key: string) => L[key] || {};
  const pencil = (key: string, what: string, shown: string) =>
    <Small label="✎" title="Say what this really is" onClick={() => labelDialog(deviceId, key, what, shown, lbl(key), got)} />;
  const mem = snap.mem;
  const memPct = mem.total && mem.avail != null ? Math.round((1 - mem.avail / mem.total) * 100) : null;
  const u = snap.updates;
  const volCols = [
    { label: 'Volume', get: (x: Volume) => { const l = lbl(`vol:${x.mount}`); return <span><b>{l.name || x.mount}</b>{l.name ? <span className="muted small mono">{` ${x.mount}`}</span> : null}
      {l.real ? <div className="small">{l.real}</div> : null}<div className="muted small">{`${x.type} · ${x.source}`}{l.ignore ? ' · no warnings' : ''}</div></span>; }, sort: (x: Volume) => x.mount },
    { label: 'Used', get: (x: Volume) => <Bar pct={x.pct} cls={x.pct >= 95 ? 'over' : x.pct >= 90 ? 'hot' : ''} n={`${x.pct}%`} />, sort: (x: Volume) => x.pct },
    { label: 'Free', get: (x: Volume) => `${fmtBytes(x.avail)} of ${fmtBytes(x.size)}`, sort: (x: Volume) => x.avail },
    { label: '', nosort: true, get: (x: Volume) => pencil(`vol:${x.mount}`, x.mount, `${x.mount}, ${fmtBytes(x.size)}`) },
  ];
  const smartCell = (d: Disk) => {
    const s = d.smart;
    if (!s || s.health === 'unknown') return <span className="muted small">{s?.note === 'virtual drive' ? 'virtual drive: check the controller' : s?.note === 'needs sudo' ? 'needs sudo' : snap.smartctl ? 'not available' : 'smartctl not installed'}</span>;
    const bits = [s.hours ? `${s.hours >= 1000 ? `${Math.round(s.hours / 1000)}k` : s.hours} hours` : '', s.temp ? `${s.temp}°C` : '',
      s.wear != null ? `${s.wear}% worn` : '', s.realloc ? `${s.realloc} reallocated` : '', s.pending ? `${s.pending} pending` : ''].filter(Boolean).join(' · ');
    return <span><span className={`badge ${s.health === 'ok' ? (s.realloc || s.pending ? 'warn' : 'ok') : 'bad'}`}>{s.health === 'ok' ? 'OK' : 'Failing'}</span> <span className="muted small">{bits}</span></span>;
  };
  const diskCols = [
    { label: 'Drive', get: (d: Disk) => { const l = lbl(`disk:${d.serial || d.name}`); return <span><b>{l.name || d.model || d.name}</b> <span className="muted small mono">{d.name}</span>
      {l.real ? <div className="small">{l.real}</div> : null}<div className="muted small">{[d.tran.toUpperCase(), d.rotational ? 'spinning' : 'solid state', d.serial].filter(Boolean).join(' · ')}</div></span>; }, sort: (d: Disk) => d.name },
    { label: 'Size', get: (d: Disk) => { const l = lbl(`disk:${d.serial || d.name}`); return l.real ? <span title="What the system reports">{fmtBytes(d.size)}<div className="muted small">as the system sees it</div></span> : fmtBytes(d.size); }, sort: (d: Disk) => d.size },
    { label: 'Health (SMART)', get: smartCell },
    { label: '', nosort: true, get: (d: Disk) => pencil(`disk:${d.serial || d.name}`, d.name, `${d.model || d.name}, ${fmtBytes(d.size)}`) },
  ];
  const facts = [snap.os.name, snap.os.pve, snap.uptime_s != null ? `up ${duration(snap.uptime_s)}` : '',
    snap.load.length && snap.cpus ? `load ${snap.load[0]} on ${snap.cpus} CPUs` : ''].filter(Boolean);
  return <>
    <Card title="Health" actions={<>
      <Small label={busy === 'check' ? 'Checking…' : '⟳ Check again'} onClick={check} disabled={!!busy} />
      <MenuButton label="⋯" items={[
        ['🗄 Backups to watch…', () => modal('Backups to watch', (m: ModalCtl) => <BackupForm m={m} deviceId={deviceId} cur={v.backups} done={got} />, { wide: true })],
        [v.background.on ? '⏸ Stop background checks' : '🕑 Check it in the background…', background],
        ['⏻ Restart the machine…', reboot],
        ['⚙ Connection…', () => setSetup(true)],
      ]} />
    </>}>
      <p className="muted small">{[...facts, `checked ${timeAgo(snap.at)}`, v.background.on ? 'checked in the background' : ''].filter(Boolean).join(' · ')}</p>
      {v.error ? <p className="warn-text small">{`The last background check didn’t work (${timeAgo(v.error.at)}): ${v.error.error}`}</p> : null}
      {v.problems.length ? <ProblemList items={v.problems} /> : <p className="ok-text">Nothing needs attention.</p>}
      {memPct != null ? <div className="grid two"><div><div className="muted small">Memory</div><Bar pct={memPct} cls={memPct >= 95 ? 'over' : memPct >= 90 ? 'hot' : ''} n={`${fmtBytes(mem.avail)} free of ${fmtBytes(mem.total)}`} /></div>
        {mem.swap_total ? <div><div className="muted small">Swap</div><Bar pct={Math.round((1 - (mem.swap_free || 0) / mem.swap_total) * 100)} n={`${fmtBytes((mem.swap_total || 0) - (mem.swap_free || 0))} used`} /></div> : null}</div> : null}
    </Card>
    <Card title={`Updates${u.count ? ` · ${u.count}` : ''}`} actions={<>
      {u.count ? <Small label={busy === 'upgrade' ? 'Installing…' : '⬇ Install updates'} cls="primary" onClick={upgrade} disabled={!!busy} /> : null}
      {snap.reboot.needed && !snap.restarted_at ? <Small label={busy === 'reboot' ? 'Restarting…' : '⏻ Restart'} onClick={reboot} disabled={!!busy} /> : null}
    </>}>
      {snap.restarted_at ? <p className="muted small">{`Restarted ${timeAgo(snap.restarted_at)}. Check again to see it come back.`}</p>
        : snap.reboot.needed ? <p className="warn-text">{`Needs a restart to finish updating${snap.reboot.kernel_new && snap.reboot.kernel_new !== snap.reboot.kernel_now ? ` (runs kernel ${snap.reboot.kernel_now}, ${snap.reboot.kernel_new} is installed)` : ''}.`}</p> : null}
      {!u.manager ? <p className="muted">HaRM doesn’t know this machine’s package manager.</p>
        : !u.count ? <p className="ok-text">{`Up to date${u.refreshed ? '' : ' (as of the machine’s last update check: tick “Use sudo” so HaRM can refresh it)'}.`}</p>
        : <>
          <p>{`${u.count} update${u.count === 1 ? '' : 's'} waiting`}{u.security ? <> · <span className="warn-text">{`${u.security} security`}</span></> : null}{u.refreshed ? '' : <span className="muted small"> (list not refreshed: needs sudo)</span>}</p>
          <details><summary>Show them</summary><div className="table-wrap"><Table rows={u.packages as unknown as Row[]} cols={[
            { label: 'Package', get: p => <span><span className="mono">{p.name}</span>{p.security ? <span className="badge warn">security</span> : null}</span>, sort: p => p.name },
            { label: 'Now', get: p => <span className="mono small">{p.now}</span> },
            { label: 'New', get: p => <span className="mono small">{p.new}</span> },
          ]} /></div></details>
        </>}
    </Card>
    <Card title="Disks and space">
      <div className="table-wrap"><Table rows={snap.volumes as unknown as Row[]} cols={volCols as never} empty="No volumes found." /></div>
      {snap.disks.length ? <div className="table-wrap"><Table rows={snap.disks as unknown as Row[]} cols={diskCols as never} /></div> : null}
      {snap.pools.length || snap.md.length ? <ul className="plain-list">
        {snap.pools.map(p => <li key={p.name}><span className={`badge ${p.health === 'ONLINE' ? 'ok' : 'bad'}`}>{p.health}</span>{` ZFS pool ${lbl(`pool:${p.name}`).name || p.name}: ${fmtBytes(p.free)} free of ${fmtBytes(p.size)}`} {pencil(`pool:${p.name}`, p.name, `pool ${p.name}, ${fmtBytes(p.size)}`)}</li>)}
        {snap.md.map(x => <li key={x.name}><span className={`badge ${x.degraded ? 'bad' : 'ok'}`}>{x.degraded ? 'Degraded' : 'OK'}</span>{` RAID ${x.name} (${x.level})`}</li>)}
      </ul> : null}
      <p className="muted small">Drive health goes into each drive’s <b>Health</b> on its part, matched by serial number. Use ✎ to say what a virtual drive or volume really is.</p>
    </Card>
    <Card title="Backups" actions={<Small label="✎ Edit" onClick={() => modal('Backups to watch', (m: ModalCtl) => <BackupForm m={m} deviceId={deviceId} cur={v.backups} done={got} />, { wide: true })} />}>
      {snap.backups.length ? <ul className="plain-list">{snap.backups.map(b => <li key={b.kind + b.path}>
        <b>{b.name || b.path}</b> <span className="muted small mono">{b.kind === 'zfs' ? `zfs ${b.path}` : b.path}</span>{' · '}{backupAge(b)}<span className="muted small">{` · expected every ${hoursText(b.hours)}`}</span></li>)}</ul>
        : <p className="muted">Tell HaRM where this machine’s backups land (a folder, or a ZFS dataset’s snapshots), and it warns when they stop coming.</p>}
    </Card>
  </>;
}
