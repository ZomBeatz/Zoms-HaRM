/* Maintenance: everything across your machines that needs attention or an update, in one place.
 * Problems found by machine checks, OS and container updates (with versions), restarts waiting,
 * backups, and Proxmox VMs with one-click power and snapshots. Nothing here runs on a schedule;
 * background checks (optional, Settings) only read. */
import { useState } from 'react';
import { api, GET } from '../api/client';
import type { Maintenance as M, PveGuest } from '../api/types';
import { useLoad, Pending } from '../app/router';
import { duration, timeAgo, type Row } from '../lib/util';
import { choose, modal, toast } from '../ui/overlay';
import { A, Btn, Card, MenuButton, PageHead, Small, Spinner, Table } from '../ui/bits';
import { fmtBytes, ProblemList } from './Machine';
import { versionText } from './Containers';
import { changeManyOnMachines, changeOnMachine } from '../dialogs/later';

const PVE_WORDS: Record<string, [string, string]> = {
  start: ['Start', 'Started'], shutdown: ['Shut down', 'Shutting down'], reboot: ['Reboot', 'Rebooting'],
  stop: ['Stop (force)', 'Stopped'], snapshot: ['Take a snapshot', 'Snapshot taken'],
};

/* A changed Proxmox certificate asks before HaRM sends the token again. */
async function pveCall(path: string, body: Row): Promise<any> {
  try { return await api('POST', path, body); }
  catch (e) {
    const msg = (e as Error).message;
    if (!/certificate changed/i.test(msg)) throw e;
    if (await choose('The certificate changed', msg, [['no', 'Cancel'], ['yes', 'Trust the new certificate', 'primary']]) !== 'yes') throw new Error('Cancelled');
    return api('POST', path, { ...body, trust_new_cert: true });
  }
}

export default function Maintenance() {
  const q = useLoad(() => GET<M>('/maintenance'));
  const [busy, setBusy] = useState('');
  if (!q.data) return <Pending q={q} />;
  const d = q.data;
  const set = (x: M) => q.set(x);
  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    try { await fn(); } catch (e) { toast((e as Error).message, 'bad'); }
    setBusy('');
  };
  const checkAll = () => run('all', async () => {
    toast('Checking every machine… this takes a minute or two');
    const r = await api('POST', '/maintenance/check-all', {});
    set(r);
    const bad = r.results.filter((x: Row) => !x.ok);
    toast(bad.length ? `${bad.length} couldn’t be checked: ${bad.map((x: Row) => x.device).join(', ')}` : `Checked ${r.results.length} machine${r.results.length === 1 ? '' : 's'}`, bad.length ? 'bad' : 'ok');
  });
  const upgrade = (m: M['machines'][0]) => run(`up:${m.id}`, async () => {
    if (await choose(`Install ${m.updates.count} update${m.updates.count === 1 ? '' : 's'} on ${m.name}?`, `HaRM runs ${m.updates.manager} and keeps your changed settings files. Services may restart.`,
      [['no', 'Cancel'], ['yes', 'Install updates', 'primary']]) !== 'yes') return;
    toast(`Installing updates on ${m.name}…`);
    const r = await api('POST', `/devices/${m.id}/machine/upgrade`, {});
    toast(r.ok ? `${m.name}: updates installed` : `${m.name}: the update didn’t finish`, r.ok ? 'ok' : 'bad',
      { label: 'Output', onClick: () => modal(`${m.name}: output`, <pre className="code logs">{r.output}</pre>, { wide: true }) });
    set(await GET('/maintenance'));
  });
  const reboot = (m: M['machines'][0]) => run(`rb:${m.id}`, async () => {
    if (await choose(`Restart ${m.name}?`, 'Everything on it stops for a minute or two.', [['no', 'Cancel'], ['yes', 'Restart', 'primary']]) !== 'yes') return;
    await api('POST', `/devices/${m.id}/machine/reboot`, {});
    toast(`${m.name} is restarting`);
    set(await GET('/maintenance'));
  });
  const updateCt = (c: M['containers'][0]) => run(`ct:${c.device_id}:${c.name}`, async () => {
    toast(`Updating ${c.name} on ${c.device}…`);
    const r = await api('POST', `/devices/${c.device_id}/docker/op`, { name: c.name, op: 'update' });
    toast(`${c.name}: ${r.ok ? r.message : 'that didn’t work'}`, r.ok ? 'ok' : 'bad');
    set(await GET('/maintenance'));
  });
  const updateAllCt = () => run('ct-all', async () => {
    if (await choose(`Update ${d.containers.length} containers?`, d.containers.map(c => `${c.name} (${c.device})`).join(', '),
      [['no', 'Cancel'], ['yes', 'Update them', 'primary']]) !== 'yes') return;
    for (const c of d.containers) {
      toast(`Updating ${c.name} on ${c.device}…`);
      const r = await api('POST', `/devices/${c.device_id}/docker/op`, { name: c.name, op: 'update' }).catch(e => ({ ok: false, message: e.message }));
      toast(`${c.name}: ${r.ok ? r.message : 'that didn’t work'}`, r.ok ? 'ok' : 'bad');
    }
    set(await GET('/maintenance'));
  });
  const readPve = () => run('pve', async () => set(await pveCall('/proxmox/live', {})));
  const pveOp = (g: PveGuest, op: string) => run(`pve:${g.vmid}`, async () => {
    if (op !== 'start' && await choose(`${PVE_WORDS[op][0]}: ${g.name}?`,
      op === 'stop' ? 'Like pulling the plug: anything unsaved inside it is lost. Use Shut down when you can.'
        : op === 'snapshot' ? 'Proxmox saves its disks (and memory, for a running VM) as they are now, so you can roll back. Snapshots take space until you delete them in Proxmox.'
          : 'It’s unavailable until it’s back up.',
      [['no', 'Cancel'], ['yes', PVE_WORDS[op][0], 'primary']]) !== 'yes') return;
    const r = await pveCall('/proxmox/op', { node: g.node, type: g.type, vmid: g.vmid, op });
    toast(r.ok ? `${g.name}: ${PVE_WORDS[op][1].toLowerCase()}${r.snapshot ? ` (${r.snapshot})` : ''}${r.done ? '' : '…'}` : `${g.name}: ${r.detail || 'that didn’t work'}`, r.ok ? 'ok' : 'bad');
    set({ ...d, proxmox: r.proxmox });
  });

  const problems = [...d.machines.flatMap(m => m.problems.filter(p => p.level !== 'info').map(p => ({ ...p, device: m.name, device_id: m.id }))),
    ...d.proxmox_problems.map(p => ({ ...p, device: 'Proxmox' }))];
  const withUpdates = d.machines.filter(m => m.updates.count || m.reboot);
  const backups = d.machines.flatMap(m => m.backups.map(b => ({ ...b, device: m.name, device_id: m.id })));
  const pve = d.proxmox;
  const bgLine = d.background.on
    ? `Background checks every ${d.background.hours} hour${d.background.hours === 1 ? '' : 's'}${d.background.last ? `, last ${timeAgo(d.background.last.at)}` : ''}`
    : 'Background checks are off';
  return <>
    <PageHead title="Maintenance" sub={<span>{bgLine} · <A href="#/settings?s=status">Settings</A></span>}>
      <Btn label={busy === 'all' ? 'Checking…' : '⟳ Check everything'} cls="primary" onClick={checkAll} disabled={!!busy || !d.machines.length} />
    </PageHead>
    {!d.machines.length ? <Card title="Get started"><p>Open a server or VM, go to its <b>Health</b> tab (or <b>⋯ &gt; Health and updates</b>), and pick the saved login HaRM should use. It then shows here with its disk space, drive health, updates and backups.</p></Card> : null}
    {problems.length ? <Card title={`Needs attention · ${problems.length}`}><ProblemList items={problems} showDevice /></Card>
      : d.machines.length ? <Card title="Needs attention"><p className="ok-text">Nothing right now.</p></Card> : null}
    {withUpdates.length ? <Card title="System updates">
      <div className="table-wrap"><Table rows={withUpdates as unknown as Row[]} cols={[
        { label: 'Machine', get: m => <span><A href={`#/devices/${m.id}?tab=health`}><b>{m.name}</b></A><div className="muted small">{m.os}</div></span>, sort: m => m.name },
        { label: 'Waiting', get: m => <span>{m.updates.count ? `${m.updates.count} update${m.updates.count === 1 ? '' : 's'}` : ''}{m.updates.security ? <span className="warn-text">{` · ${m.updates.security} security`}</span> : null}
          {m.reboot ? <div className="warn-text small">needs a restart</div> : null}
          {m.updates.packages.length ? <div className="muted small">{m.updates.packages.slice(0, 4).map((p: Row) => p.name).join(', ')}{m.updates.count > 4 ? '…' : ''}</div> : null}</span>, sort: m => m.updates.count },
        { label: 'Checked', get: m => m.at ? timeAgo(m.at) : 'never' },
        { label: '', nosort: true, get: m => <div className="row-actions">
          {busy.endsWith(`:${m.id}`) ? <Spinner /> : null}
          {m.updates.count ? <Small label="⬇ Install" cls="primary" onClick={() => upgrade(m as never)} disabled={!!busy} /> : null}
          {m.reboot ? <Small label="⏻ Restart" onClick={() => reboot(m as never)} disabled={!!busy} /> : null}</div> },
      ]} /></div></Card> : null}
    {d.containers.length ? <Card title={`Container updates · ${d.containers.length}`} actions={d.containers.length > 1 ? <Small label="⬇ Update all" cls="primary" onClick={updateAllCt} disabled={!!busy} /> : null}>
      <div className="table-wrap"><Table rows={d.containers as unknown as Row[]} cols={[
        { label: 'Container', get: c => <span><b>{c.name}</b><div className="muted small"><A href={`#/devices/${c.device_id}?tab=containers`}>{c.device}</A>{c.project ? ` · ${c.project}` : ''}</div></span>, sort: c => c.name },
        { label: 'Version', get: c => <span><span className="mono small">{c.image}</span><div className="small">{versionText(c) || <span className="muted">newer image available</span>}</div></span> },
        { label: '', nosort: true, get: c => busy === `ct:${c.device_id}:${c.name}` ? <Spinner /> : <Small label="Update" cls="primary" onClick={() => updateCt(c as never)} disabled={!!busy} /> },
      ]} /></div>
      <p className="muted small">Updates use Docker Compose where the container was started with it, so its settings stay the same.</p></Card> : null}
    {d.machines.length ? <Card title={`Machines · ${d.machines.length}`}>
      <div className="table-wrap"><Table rows={d.machines as unknown as Row[]} cols={[
        { label: 'Machine', get: m => <A href={`#/devices/${m.id}?tab=health`}><b>{m.name}</b></A>, sort: m => m.name },
        { label: 'State', get: m => m.error ? <span className="bad-text small">{m.error.error}</span>
          : m.problems.some((p: Row) => p.level === 'bad') ? <span className="badge bad">Problem</span>
          : m.problems.some((p: Row) => p.level === 'warn') ? <span className="badge warn">Check</span> : m.at ? <span className="badge ok">OK</span> : <span className="muted">not checked</span> },
        { label: 'Up for', get: m => m.uptime_s != null ? duration(m.uptime_s) : '' },
        { label: 'Checked', get: m => <span>{m.at ? timeAgo(m.at) : 'never'}{m.background ? <div className="muted small">also in the background</div> : null}</span>, sort: m => m.at || '' },
      ]} /></div></Card> : null}
    {d.old_logins.length ? <Card title={`Old passwords · ${d.old_logins.length}`} actions={d.old_logins.some(c => c.username && c.device_id)
      ? <Small label="🔑 Change them all…" onClick={() => changeManyOnMachines(d.old_logins as unknown as Row[], () => q.reload())} /> : null}>
      <div className="table-wrap"><Table rows={d.old_logins as unknown as Row[]} cols={[
        { label: 'Login', get: c => <span><A href="#/vault"><b>{c.label}</b></A><div className="muted small">{[c.username, c.kind].filter(Boolean).join(' · ')}</div></span>, sort: c => c.label },
        { label: 'Device', get: c => c.device_id ? <A href={`#/devices/${c.device_id}`}>{c.device}</A> : '', sort: c => c.device || '' },
        { label: 'Changed', get: c => <span>{timeAgo(c.last_rotated)}{c.no_date ? <div className="muted small">saved then; never marked as changed</div> : null}</span>, sort: c => c.last_rotated },
        { label: '', nosort: true, get: c => c.username ? <Small label="🔑 Change on machine…" onClick={() => changeOnMachine(c, () => q.reload())} /> : null },
      ]} /></div>
      <p className="muted small">{`Logins whose password hasn’t changed in ${d.password_days >= 365 ? `${d.password_days / 365} year${d.password_days > 365 ? 's' : ''}` : `${d.password_days} days`}. `}<b>Change on machine</b> works for Linux users; for others, change it there and press <b>Edit</b> in the vault to save it. How old counts as old: <A href="#/settings?s=status">Settings</A>.</p></Card> : null}
    {backups.length ? <Card title="Backups">
      <ul className="plain-list">{backups.map(b => {
        const age = b.newest ? (Date.now() - new Date(b.newest.replace(' ', 'T') + 'Z').getTime()) / 3.6e6 : null;
        const late = b.missing || (age != null && age > b.hours) || (!b.newest && !b.unread);
        return <li key={b.device_id + b.kind + b.path}><span className={`badge ${late ? 'warn' : 'ok'}`}>{late ? 'Late' : 'OK'}</span>{' '}
          <b>{b.name || b.path}</b> <span className="muted small">{`on ${b.device}`}</span>{' · '}
          {b.unread ? 'read on the next check' : b.missing ? 'not found' : b.newest ? `newest ${timeAgo(b.newest)}` : 'nothing yet'}</li>;
      })}</ul></Card> : null}
    <Card title="Proxmox" actions={d.proxmox_ready ? <Small label={busy === 'pve' ? 'Reading…' : '⟳ Read Proxmox'} onClick={readPve} disabled={!!busy} /> : null}>
      {!d.proxmox_ready ? <p className="muted">Connect Proxmox in <A href="#/discover?tab=proxmox">Discover &gt; Proxmox</A> (keep “remember” on) to see every VM’s state and backups here, and to start, shut down and snapshot them with one click.</p>
        : !pve ? <p className="muted">Press <b>Read Proxmox</b> to see your VMs and their backups.</p>
        : <>
          <p className="muted small">{`Read ${timeAgo(pve.at)}`}{pve.backups_error ? ` · backups couldn’t be read: ${pve.backups_error}` : ''}</p>
          <div className="table-wrap"><Table rows={pve.guests.filter(g => !g.template) as unknown as Row[]} cols={[
            { label: 'VM', get: g => <span><b>{g.name}</b> <span className="muted small">{`${g.vmid} · ${g.node} · ${g.type === 'qemu' ? 'VM' : 'container'}`}</span></span>, sort: g => +g.vmid },
            { label: 'State', get: g => <span><span className={`badge ${g.status === 'running' ? 'ok' : 'muted'}`}>{g.status === 'running' ? 'Running' : g.status === 'stopped' ? 'Stopped' : g.status}</span>{g.lock ? <span className="muted small">{` ${g.lock}`}</span> : null}</span>, sort: g => g.status },
            { label: 'Use', get: g => g.status === 'running' ? <span className="small">{`${g.cpu}% CPU · ${fmtBytes(g.mem)} of ${fmtBytes(g.maxmem)}`}<div className="muted small">{`up ${duration(g.uptime)}`}</div></span> : '' },
            { label: 'Newest backup', get: g => { const b = pve.backups[g.vmid]; return b ? <span className={d.proxmox_problems.some(p => p.key === `pve-backup:${g.vmid}`) ? 'warn-text' : undefined}>{timeAgo(new Date(b.ctime * 1000).toISOString().slice(0, 19).replace('T', ' '))}<div className="muted small">{b.storage}</div></span> : <span className="muted small">none found</span>; } },
            { label: '', nosort: true, get: g => <div className="row-actions">{busy === `pve:${g.vmid}` ? <Spinner /> : null}
              <MenuButton label="⋯" items={[
                g.status !== 'running' ? ['▶ Start', () => pveOp(g as never, 'start')] : null,
                g.status === 'running' ? ['⏻ Shut down', () => pveOp(g as never, 'shutdown')] : null,
                g.status === 'running' ? ['⟳ Reboot', () => pveOp(g as never, 'reboot')] : null,
                ['📸 Take a snapshot', () => pveOp(g as never, 'snapshot')],
                g.status === 'running' ? ['■ Stop (force)', () => pveOp(g as never, 'stop'), 'danger-item'] : null,
              ]} /></div> },
          ]} /></div>
        </>}
    </Card>
  </>;
}
