/* A device's Docker containers (Device > Containers): read them over SSH with a saved login, see
 * which are running and healthy and which have newer images, and update, restart, stop, start or
 * read the logs of one, one click at a time. Nothing runs on a schedule. */
import { useEffect, useState } from 'react';
import { api, GET } from '../api/client';
import type { Container, DockerConf, DockerSnap } from '../api/types';
import { forHowLong, timeAgo, type Row } from '../lib/util';
import { choose, modal, toast } from '../ui/overlay';
import { Btn, Card, MenuButton, Small, Spinner, Table } from '../ui/bits';

type Data = { conf: DockerConf; snap: DockerSnap | null };
// Docker gives ISO times ("2026-11-01T10:00:00.123Z"); HaRM's helpers take "YYYY-MM-DD HH:MM:SS" in UTC.
const since = (iso: string) => iso && !iso.startsWith('0001') ? iso.slice(0, 19).replace('T', ' ') : '';

const pill = (text: string, cls: string) => <span className={`badge ${cls}`}>{text}</span>;

function stateBadge(c: Container) {
  if (c.state === 'running') {
    if (c.health === 'unhealthy') return pill('Unhealthy', 'bad');
    if (c.health === 'starting') return pill('Starting', 'warn');
    return pill('Running', 'ok');
  }
  if (c.state === 'restarting') return pill('Restarting', 'warn');
  if (c.state === 'paused') return pill('Paused', 'muted');
  return pill(c.state === 'exited' ? 'Stopped' : c.state, 'bad');
}

function showOutput(title: string, text: string) {
  modal(title, <pre className="code logs">{text || 'Nothing was printed.'}</pre>, { wide: true });
}

/* Where and how to reach Docker: an address, a saved login, and whether to use sudo. */
function Connect({ deviceId, conf, onRead }: { deviceId: number; conf: DockerConf; onRead: (d: Data) => void }) {
  const [t, setT] = useState<Row | null>(null);
  const [host, setHost] = useState(conf.host || '');
  const [port, setPort] = useState(String(conf.port || 22));
  const [cred, setCred] = useState(conf.credential_id ? String(conf.credential_id) : '');
  const [sudo, setSudo] = useState(conf.sudo ?? true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    GET(`/devices/${deviceId}/collect-targets`).then(x => {
      setT(x);
      if (!conf.host) setHost(x.hosts[0] || '');
      if (!conf.credential_id && x.credentials[0]) setCred(String(x.credentials[0].id));
    }).catch(e => setErr(e.message));
  }, [deviceId]);  // eslint-disable-line react-hooks/exhaustive-deps
  const read = async (trust = false): Promise<void> => {
    setBusy(true); setErr('');
    try { onRead(await api('POST', `/devices/${deviceId}/docker/read`, { host: host.trim(), port: +port || 22, credential_id: cred || null, sudo, trust_new_key: trust })); }
    catch (e) {
      const msg = (e as Error).message;
      if (/host key changed/i.test(msg) && await choose('The machine’s key changed', msg, [['no', 'Cancel'], ['yes', 'Trust the new key', 'primary']]) === 'yes') return read(true);
      setErr(msg);
    }
    setBusy(false);
  };
  if (!t && !err) return <div className="muted"><Spinner /> Loading…</div>;
  return (
    <div className="disc-form">
      <p className="muted">HaRM connects over SSH with one of this device’s saved logins and asks Docker for its containers. Nothing is changed.</p>
      <div className="inline">
        <label className="disc-field"><span>Address</span>
          <input list={`dk-hosts-${deviceId}`} value={host} onChange={e => setHost(e.target.value)} placeholder="10.0.0.20" />
          <datalist id={`dk-hosts-${deviceId}`}>{(t?.hosts || []).map((h: string) => <option key={h} value={h} />)}</datalist></label>
        <label className="disc-field"><span>Port</span><input value={port} onChange={e => setPort(e.target.value)} inputMode="numeric" style={{ width: 80 }} /></label>
        <label className="disc-field"><span>Login</span>
          <select value={cred} onChange={e => setCred(e.target.value)}>
            <option value="">Pick a saved login</option>
            {(t?.credentials || []).map((c: Row) => <option key={c.id} value={c.id}>{`${c.label}${c.username ? ` (${c.username})` : ''}`}</option>)}</select></label>
      </div>
      {t && !t.credentials.length ? <p className="muted small">This device has no saved logins yet. Add its SSH login on the <b>Logins</b> tab first.</p> : null}
      <label className="check inline-check"><input type="checkbox" checked={sudo} onChange={e => setSudo(e.target.checked)} />Use sudo (unless the login is in the docker group)</label>
      <div className="inline"><Btn label="🐳 Read containers" cls="primary" disabled={busy || !host || !cred} onClick={() => read()} />{busy ? <Spinner /> : null}</div>
      <div className="form-error">{err}</div>
    </div>
  );
}

export function ContainersTab({ deviceId, host, after }: { deviceId: number; host: string; after: () => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [setup, setSetup] = useState(false);
  useEffect(() => { GET<Data>(`/devices/${deviceId}/docker`).then(setData).catch(e => setErr(e.message)); }, [deviceId]);
  if (err) return <div className="form-error">{err}</div>;
  if (!data) return <div className="muted"><Spinner /> Loading…</div>;
  const got = (d: Data) => { setData(d); setSetup(false); after(); };
  if (!data.snap || setup) {
    return <Card title="Docker containers"><Connect deviceId={deviceId} conf={data.conf} onRead={got} /></Card>;
  }
  const snap = data.snap;
  const addr = data.conf.host || host;  // for links to the containers' web pages
  const ups = snap.updates || {};
  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    try { await fn(); } catch (e) { toast((e as Error).message, 'bad'); }
    setBusy('');
  };
  const readAgain = () => run('read', async () => got(await api('POST', `/devices/${deviceId}/docker/read`, {})));
  const check = () => run('check', async () => {
    const d: Data = await api('POST', `/devices/${deviceId}/docker/check`, {});
    got(d);
    const n = new Set(d.snap!.containers.filter(c => d.snap!.updates?.[c.image] === 'update').map(c => c.image)).size;
    toast(n ? `${n} image${n === 1 ? ' has' : 's have'} a newer version` : 'Every image is up to date (or can’t be checked)');
  });
  const op = async (c: Container, o: string) => {
    if (o === 'update' || o === 'restart' || o === 'stop') {
      const say = { update: [`Update ${c.name}?`, c.project ? `HaRM pulls the newest ${c.image} and re-creates it with Docker Compose (project ${c.project}). It’s down for a moment while it restarts.` : `HaRM downloads the newest ${c.image}. This container wasn’t started with Docker Compose, so you’ll re-create it yourself afterwards.`],
        restart: [`Restart ${c.name}?`, 'It’s down for a moment.'], stop: [`Stop ${c.name}?`, 'It stays stopped until you start it again.'] }[o]!;
      if (await choose(say[0], say[1], [['no', 'Cancel'], ['yes', o === 'update' ? 'Update' : o === 'restart' ? 'Restart' : 'Stop', 'primary']]) !== 'yes') return;
    }
    await run(`${o}:${c.name}`, async () => {
      if (o === 'update') toast(`Updating ${c.name}… (a few minutes for big images)`);
      const r = await api('POST', `/devices/${deviceId}/docker/op`, { name: c.name, op: o });
      if (o === 'logs') return showOutput(`Logs: ${c.name} (last 200 lines)`, r.output);
      setData(d => d && { ...d, snap: r.snap });
      after();
      if (r.ok) toast(`${c.name}: ${r.message}`, 'ok', r.output ? { label: 'Output', onClick: () => showOutput(`${c.name}: ${o}`, r.output) } : null);
      else toast(`${c.name}: that didn’t work`, 'bad', { label: 'Output', onClick: () => showOutput(`${c.name}: ${o}`, r.output) });
    });
  };
  const watch = async (c: Container) => {
    const port = c.ports.map(p => p.split('→')).find(([, to]) => to.endsWith('/tcp'))?.[0];
    if (!port) return;
    await run(`watch:${c.name}`, async () => {
      await api('POST', '/services', { device_id: deviceId, name: c.name, protocol: 'HTTP', port: +port, url: `http://${addr}:${port}`, status: 'Running', notes: 'Docker container' });
      toast(`${c.name} is now checked every few minutes, with alerts if it stops answering`);
      after();
    });
  };
  const prune = () => run('prune', async () => {
    if (await choose('Clean up old images?', 'Deletes images no container uses any more, like the old versions left after updates. Running containers aren’t touched.', [['no', 'Cancel'], ['yes', 'Clean up', 'primary']]) !== 'yes') return;
    const r = await api('POST', `/devices/${deviceId}/docker/prune`, {});
    toast(r.freed ? `Cleaned up: ${r.freed} freed` : 'Nothing to clean up');
  });
  const notRunning = snap.containers.filter(c => c.state !== 'running' || c.health === 'unhealthy').length;
  const withUpdate = snap.containers.filter(c => ups[c.image] === 'update');
  const updateAll = () => run('all', async () => {
    if (await choose(`Update ${withUpdate.length} container${withUpdate.length === 1 ? '' : 's'}?`, withUpdate.map(c => c.name).join(', '),
      [['no', 'Cancel'], ['yes', 'Update them', 'primary']]) !== 'yes') return;
    for (const c of withUpdate) {
      toast(`Updating ${c.name}…`);
      const r = await api('POST', `/devices/${deviceId}/docker/op`, { name: c.name, op: 'update' });
      setData(d => d && { ...d, snap: r.snap });
      toast(`${c.name}: ${r.ok ? r.message : 'that didn’t work'}`, r.ok ? 'ok' : 'bad');
    }
    after();
  });
  const cols = [
    { label: 'Container', get: (c: Container) => <span><b>{c.name}</b>{c.project ? <span className="muted small">{` ${c.project}`}</span> : null}</span>, sort: (c: Container) => c.name },
    { label: 'State', get: (c: Container) => <span>{stateBadge(c)}{c.restarts > 3 ? <span className="warn-text small">{` restarted ${c.restarts}×`}</span> : null}</span>, sort: (c: Container) => c.state },
    { label: 'Up for', get: (c: Container) => c.state === 'running' && since(c.started) ? forHowLong(since(c.started)).replace(/^for /, '') : '' },
    { label: 'Image', get: (c: Container) => <span><span className="mono small">{c.image}</span>{' '}
      {ups[c.image] === 'update' ? pill('Update available', 'info') : ups[c.image] === 'current' ? <span className="muted small">up to date</span> : null}</span> },
    { label: 'Ports', get: (c: Container) => <span>{c.ports.map(p => {
      const [from, to] = p.split('→');
      return to.endsWith('/tcp') ? <a key={p} className="mono small" href={`http://${addr}:${from}`} target="_blank" rel="noopener noreferrer">{from} </a> : <span key={p} className="mono small">{`${from} `}</span>;
    })}</span> },
    { label: '', nosort: true, get: (c: Container) => <div className="row-actions">
      {busy.endsWith(`:${c.name}`) ? <Spinner /> : null}
      {ups[c.image] === 'update' ? <Small label="Update" cls="primary" onClick={() => op(c, 'update')} /> : null}
      <MenuButton label="⋯" items={[
        ['⟳ Restart', () => op(c, 'restart')],
        c.state === 'running' ? ['■ Stop', () => op(c, 'stop')] : ['▶ Start', () => op(c, 'start')],
        ['📜 Logs', () => op(c, 'logs')],
        ['⬇ Update now', () => op(c, 'update')],
        c.ports.some(p => p.endsWith('/tcp')) ? ['🔔 Watch its web page', () => watch(c)] : null,
      ]} /></div> },
  ];
  return (
    <Card title={`Docker containers · ${snap.containers.length}`} actions={<>
      <Small label={busy === 'read' ? 'Reading…' : '⟳ Read again'} onClick={readAgain} />
      <Small label={busy === 'check' ? 'Checking…' : 'Check for updates'} onClick={check} />
      <MenuButton label="⋯" items={[['🧹 Clean up old images', prune], ['⚙ Connection…', () => setSetup(true)]]} />
    </>}>
      <p className="muted small">{[`Read ${timeAgo(snap.at)}`, notRunning ? `${notRunning} not running or unhealthy` : 'all running',
        snap.checked_at ? `updates checked ${timeAgo(snap.checked_at)}` : 'updates not checked yet'].join(' · ')}</p>
      {withUpdate.length > 1 ? <p><Btn label={`⬇ Update all ${withUpdate.length}`} cls="primary" onClick={updateAll} /></p> : null}
      <div className="table-wrap"><Table rows={snap.containers as (Container & Row)[]} cols={cols} empty="No containers on this machine." /></div>
      <p className="muted small">Updates use Docker Compose where the container was started with it, so its settings stay the same. Each runs when you press it, never on a schedule.</p>
    </Card>
  );
}
