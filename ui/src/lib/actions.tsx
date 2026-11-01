/* Actions: saved commands sent to a device over SSH with one click. Never on a schedule. */
import { api, GET } from '../api/client';
import { S } from './state';
import { timeAgo, type Row } from './util';
import { choose, modal, toast } from '../ui/overlay';
import { A, Small, Table } from '../ui/bits';
import { deleteEntity, editEntity } from './forms';

/* Ready-made actions to start from. The commands are examples: check them for your own gear. */
export const ACTION_TEMPLATES: Row[] = [
  { name: 'Uptime and disk space', mode: 'script', command: 'uptime\ndf -h -x tmpfs -x devtmpfs -x overlay',
    notes: 'A safe first try: it only reads.' },
  { name: 'Update packages (Debian, Ubuntu, Proxmox)', mode: 'script', sudo: true, confirm: true,
    command: 'export DEBIAN_FRONTEND=noninteractive\napt-get update\napt-get -y upgrade' },
  { name: 'Restart', mode: 'script', sudo: true, confirm: true, command: 'systemctl reboot' },
  { name: 'Shut down', mode: 'script', sudo: true, confirm: true, command: 'systemctl poweroff' },
  { name: 'Proxmox: list VMs and containers', mode: 'script', sudo: true, command: 'qm list\npct list' },
  { name: 'Quiet the fans (HPE iLO 4)', mode: 'lines', legacy_ssh: true,
    command: '# Needs iLO 4 with the fan-control (“unlocked”) firmware.\n# One line per fan: fan p <fan> max <speed, 0 to 255>.\nfan p 0 max 60\nfan p 1 max 60\nfan p 2 max 60\nfan p 3 max 60\nfan p 4 max 60\nfan p 5 max 60',
    notes: 'Send it to the iLO address with the iLO login. Change the fans and speeds for your server, then watch its temperatures.' },
  { name: 'Power on (HPE iLO)', mode: 'lines', legacy_ssh: true, command: 'power on', notes: 'Send it to the iLO address with the iLO login.' },
  { name: 'Power on (Dell iDRAC)', mode: 'lines', legacy_ssh: true, command: 'racadm serveraction powerup', notes: 'Send it to the iDRAC address with the iDRAC login.' },
  { name: 'Shut down (Windows)', mode: 'lines', confirm: true, command: 'shutdown /s /t 0', notes: 'Needs OpenSSH Server turned on in Windows (Settings > System > Optional features).' },
];

type After = (() => unknown) | null | undefined;

export async function editAction(rec: Row, after?: After) {
  try { S.lk.credentials = await GET('/credentials'); } catch { S.lk.credentials = []; }
  editEntity('actions', { mode: 'script', pinned: true, ...rec }, after);
}

/* Run a saved action. One click; the result comes back as a toast with the output a tap away. */
export async function runAction(a: Row, { host = null, trust = false, after = null }: { host?: string | null; trust?: boolean; after?: After } = {}): Promise<void> {
  if (a.confirm && !trust) {
    const ok = await choose(`Run “${a.name}”?`, 'This was set to ask first.', [['no', 'Cancel'], ['yes', '▶ Run', 'primary']]);
    if (ok !== 'yes') return;
  }
  toast(`Sending “${a.name}”…`);
  let r: Row;
  try { r = await api('POST', `/actions/${a.id}/run`, { host, trust_new_key: trust }); }
  catch (e) { toast((e as Error).message, 'bad'); return; }
  const bad = r.results.filter((x: Row) => !x.ok);
  const keyChanged = bad.find((x: Row) => x.code === 'hostkey');
  if (keyChanged) {
    const pickIt = await choose('The machine’s key changed', <>{`${keyChanged.host}: ${keyChanged.error}`} Trust the new key only if you reinstalled it or replaced its management card.</>,
      [['no', 'Cancel'], ['yes', 'Trust the new key and run', 'primary']]);
    if (pickIt === 'yes') return runAction(a, { host: keyChanged.host, trust: true, after });
    return;
  }
  const show = { label: 'Show output', onClick: () => showRunResult(r) };
  if (!bad.length) toast(`✓ ${a.name}: done${r.results.length > 1 ? ` on all ${r.results.length}` : ''}`, 'ok', show);
  else if (bad.length === r.results.length && r.results.length === 1) toast(`${a.name} didn’t work: ${bad[0].error || `it ended with code ${bad[0].exit_code}`}`, 'bad', show);
  else toast(`${a.name}: worked on ${r.results.length - bad.length} of ${r.results.length}`, 'bad', show);
  if (after) after();
}

function RunBlock({ x }: { x: Row }) {
  const facts = [x.ms != null ? `${(x.ms / 1000).toFixed(1)} s` : null, x.exit_code != null ? `code ${x.exit_code}` : null, x.at ? timeAgo(x.at) : null].filter(Boolean).join(' · ');
  return (
    <div className="run-block">
      <div className="run-head"><b className={x.ok ? 'ok-text' : 'bad-text'}>{x.ok ? `✓ ${x.host}` : `✗ ${x.host}`}</b><span className="muted small">{facts}</span></div>
      {x.error ? <p className="bad-text">{x.error}</p> : null}
      {x.output ? <pre className="run-out">{x.output}</pre> : (x.error ? null : <p className="muted small">It printed nothing.</p>)}
    </div>
  );
}
function showRunResult(r: Row) {
  modal(r.action, <div>{r.results.map((x: Row, i: number) => <RunBlock key={i} x={x} />)}</div>, { wide: true });
}
async function showRuns(a: Row) {
  let runs: Row[];
  try { runs = await GET(`/actions/${a.id}/runs`); } catch (e) { toast((e as Error).message, 'bad'); return; }
  modal(`${a.name}: recent runs`, (
    <div>
      {runs.length ? runs.map((x, i) => <RunBlock key={i} x={x} />) : <div className="empty">It hasn’t been run yet.</div>}
      <p className="muted small">HaRM keeps the last 50 runs. The output is stored encrypted, like your logins.</p>
    </div>
  ), { wide: true });
}

export function ActionsTable({ rows, after, showDevice = true }: { rows: Row[]; after?: After; showDevice?: boolean }) {
  return <Table rows={rows} empty="No actions yet." cols={[
    { label: 'Action', get: a => <div><b>{a.name}</b>{a.notes ? <div className="muted small">{a.notes}</div> : null}</div>, sort: a => a.name },
    showDevice && { label: 'Device', get: a => a.device_id ? <A href={`#/devices/${a.device_id}`}>{a.device_name}</A> : '', sort: a => a.device_name || '' },
    { label: 'Sends to', get: a => a.hosts ? <span className="mono small">{a.hosts.split('\n').join(', ')}</span> : <span className="muted small">Main address</span> },
    { label: 'How', get: a => <span className="small">{a.mode === 'lines' ? 'One command per line' : 'Shell script'}{a.sudo ? ', sudo' : ''}{a.legacy_ssh ? ', older SSH' : ''}</span> },
    { label: 'Last run', get: a => a.last_run_at
      ? <button type="button" className="linkish" onClick={() => showRuns(a)}><span className={a.last_ok ? 'ok-text' : 'bad-text'}>{a.last_ok ? '✓ ' : '✗ '}</span>{timeAgo(a.last_run_at)}</button>
      : <span className="muted small">Never</span>, sort: a => a.last_run_at || '' },
    { label: '', nosort: true, get: a => (
      <div className="row-actions">
        <Small label="▶ Run" onClick={() => runAction(a, { after })} cls="primary" />
        <Small label="Edit" onClick={() => editAction(a, after)} />
        <Small label="Delete" onClick={() => deleteEntity('actions', a, after)} cls="ghost-danger" />
      </div>
    ) },
  ]} />;
}

export function ActionExamples({ preset, after }: { preset: Row; after?: After }) {
  return <div className="chips">{ACTION_TEMPLATES.map(t => (
    <button key={t.name} type="button" className="chip" onClick={() => editAction({ ...t, ...preset }, after)}>{t.name}</button>
  ))}</div>;
}
