/* Run on machines (#/run): one command on many machines at once, each with its saved SSH login, and
 * each machine's output side by side. Four run at a time; every run is in the audit log. ⚡ Save as
 * action keeps the command as an action on each machine, with its own button. */
import { useEffect, useMemo, useState } from 'react';
import { api, GET } from '../api/client';
import { fmtMs, prefGet, prefSet, type Row } from '../lib/util';
import { choose, copy, toast } from '../ui/overlay';
import { formDialog } from '../ui/form';
import { editAction } from '../lib/actions';
import { A, Btn, PageHead, Small, Spinner } from '../ui/bits';
import { SnippetMenu } from '../dialogs/snippets';

type Res = { ok: boolean; exit_code: number | null; output: string; ms: number | null; error?: string; hostkey?: boolean };
const PICK = 'harm-run-pick';
const AT_ONCE = 4;
const RISKY = /\b(rm|reboot|shutdown|poweroff|halt|mkfs|dd)\b/;

export default function RunMany({ q }: { q: URLSearchParams }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [pick, setPick] = useState<Set<number>>(new Set());
  const [login, setLogin] = useState<Record<number, number>>({});
  const [filter, setFilter] = useState('');
  const [cmd, setCmd] = useState(q.get('cmd') || '');
  const [sudo, setSudo] = useState(false);
  const [res, setRes] = useState<Record<number, Res | 'busy'>>({});
  const [busy, setBusy] = useState(false);
  const [ran, setRan] = useState('');
  useEffect(() => {
    GET('/run/targets').then((r: Row[]) => {
      setRows(r);
      let saved: number[] = [];
      try { saved = JSON.parse(prefGet(PICK) || '[]'); } catch { /* none */ }
      const want = q.get('d') ? [+q.get('d')!] : saved;
      setPick(new Set(r.map(x => x.device_id).filter(id => want.includes(id))));
    }).catch(e => { toast((e as Error).message, 'bad'); setRows([]); });
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  const shown = useMemo(() => (rows || []).filter(x => !filter || `${x.device} ${x.host} ${x.username}`.toLowerCase().includes(filter.toLowerCase())), [rows, filter]);
  if (!rows) return <div className="muted"><Spinner /> Loading…</div>;
  const toggle = (ids: number[], on: boolean) => setPick(p => {
    const n = new Set(p); ids.forEach(id => on ? n.add(id) : n.delete(id));
    prefSet(PICK, JSON.stringify([...n]));
    return n;
  });
  const credOf = (x: Row) => login[x.device_id] || x.credential_id;
  const one = async (x: Row, command: string, trust = false) => {
    setRes(r => ({ ...r, [x.device_id]: 'busy' }));
    const c = x.logins.find((l: Row) => l.id === credOf(x)) || x.logins[0];
    let out: Res;
    try {
      out = await api('POST', `/devices/${x.device_id}/run`, { host: x.host, port: c.port, credential_id: c.id, command, sudo, trust_new_key: trust });
    } catch (e) {
      const m = (e as Error).message;
      out = { ok: false, exit_code: null, output: '', ms: null, error: m, hostkey: /host key changed/i.test(m) };
    }
    setRes(r => ({ ...r, [x.device_id]: out }));
  };
  const runAll = async () => {
    const c = cmd.trim();
    const todo = rows.filter(x => pick.has(x.device_id));
    if (!c || !todo.length) return;
    if (todo.length > 1 && RISKY.test(c)
      && await choose('Run it on all of them?', <>This runs <span className="mono">{c.split('\n')[0]}</span>{` on ${todo.length} machines${sudo ? ', as root' : ''}.`}</>,
        [['no', 'Cancel'], ['yes', `Run on ${todo.length}`, 'danger']]) !== 'yes') return;
    setBusy(true); setRan(c);
    setRes(Object.fromEntries(todo.map(x => [x.device_id, 'busy'])));
    const queue = [...todo];
    await Promise.all(Array.from({ length: Math.min(AT_ONCE, queue.length) }, async () => {
      for (let x = queue.shift(); x; x = queue.shift()) await one(x, c);
    }));
    setBusy(false);
  };
  // The command as an action on each picked machine: one opens the action form, several get the same name.
  const saveAction = () => {
    const c = cmd.trim();
    const todo = rows.filter(x => pick.has(x.device_id));
    if (!c || !todo.length) return;
    const rec = (x: Row, name: string, confirm: boolean) => {
      const l = x.logins.find((y: Row) => y.id === credOf(x)) || x.logins[0];
      return { name, device_id: x.device_id, hosts: x.host, port: l.port, credential_id: l.id, mode: 'script', command: c, sudo, confirm, pinned: true };
    };
    if (todo.length === 1) return editAction(rec(todo[0], '', RISKY.test(c)));
    formDialog({
      title: `Save as an action on ${todo.length} machines`,
      fields: [{ k: 'name', label: 'Name', required: true, ph: c.split('\n')[0].slice(0, 60),
        help: `Each machine gets its own action with this command and the login picked for it${sudo ? ', run with sudo' : ''}: on its page, on Actions, and as a button on a service card.` },
        { k: 'confirm', label: 'Ask before running', type: 'checkbox', default: RISKY.test(c) }],
      submit: async v => {
        for (const x of todo) await api('POST', '/actions', rec(x, String(v.name).trim(), !!v.confirm));
      },
      onDone: () => toast(`Saved as an action on ${todo.length} machines`),
    });
  };
  const done = Object.values(res).filter(r => r !== 'busy') as Res[];
  const good = done.filter(r => r.ok).length;
  const withRes = rows.filter(x => res[x.device_id]);
  return <div className="run-page">
    <PageHead title="Run on machines" sub="One command on many machines, each with its saved SSH login">
      <A href="#/actions" cls="button">Saved actions</A>
    </PageHead>
    {!rows.length ? <p className="muted">No machines to run on yet. A machine needs a saved login of the kind <b>SSH</b> or <b>OS Account</b> with a username, on its device (not Windows).</p> : <>
      <div className="run-grid">
        <div className="run-machines">
          <div className="inline">
            <input type="search" placeholder="Filter…" value={filter} onChange={e => setFilter(e.target.value)} />
            <Small label="All" onClick={() => toggle(shown.map(x => x.device_id), true)} />
            <Small label="None" onClick={() => toggle(shown.map(x => x.device_id), false)} />
          </div>
          <ul className="plain-list key-targets">{shown.map(x => <li key={x.device_id}>
            <label className="check"><input type="checkbox" checked={pick.has(x.device_id)} disabled={busy} onChange={e => toggle([x.device_id], e.target.checked)} />
              <span><b>{x.device}</b> <span className="mono small">{x.host}</span></span></label>
            {x.logins.length > 1 ? <select aria-label={`Login for ${x.device}`} className="small" value={credOf(x)} disabled={busy}
              onChange={e => setLogin(l => ({ ...l, [x.device_id]: +e.target.value }))}>
              {x.logins.map((l: Row) => <option key={l.id} value={l.id}>{`${l.username} (${l.label})`}</option>)}</select>
              : <span className="muted small">{` as ${x.username}`}</span>}
          </li>)}</ul>
        </div>
        <form className="run-command" onSubmit={e => { e.preventDefault(); runAll(); }}>
          <textarea className="mono" aria-label="Command" rows={5} placeholder={'uptime\ndf -h /'} value={cmd} spellCheck={false}
            onChange={e => setCmd(e.target.value)} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runAll(); } }} />
          <div className="inline">
            <Btn label={busy ? 'Running…' : `▶ Run on ${pick.size} machine${pick.size === 1 ? '' : 's'}`} cls="primary" disabled={busy || !pick.size || !cmd.trim()} onClick={runAll} />
            <label className="check inline-check"><input type="checkbox" checked={sudo} disabled={busy} onChange={e => setSudo(e.target.checked)} />Run with sudo</label>
            <SnippetMenu current={cmd} sudo={sudo} onPick={s => { setCmd(s.command); setSudo(s.sudo); }} />
            <Small label="⚡ Save as action…" title="Keep it as an action on each picked machine, with its own button" disabled={busy || !pick.size || !cmd.trim()} onClick={saveAction} />
          </div>
          <p className="muted small">Runs as a shell script (sh), {AT_ONCE} machines at a time, up to 5 minutes each, without typing into it. Ctrl+Enter runs it.</p>
        </form>
      </div>
      {withRes.length ? <>
        <h3 className="run-head">{busy ? <><Spinner />{` Running on ${withRes.length - done.length} of ${withRes.length}…`}</> : `${good} of ${done.length} worked`}
          {ran ? <span className="mono small muted">{`  ${ran.split('\n')[0]}`}</span> : null}</h3>
        <div className="run-results">{withRes.map(x => {
          const r = res[x.device_id];
          return <div key={x.device_id} className={`card run-result ${r === 'busy' ? '' : r.ok ? 'ok' : 'bad'}`}>
            <div className="run-result-head">
              <A href={`#/devices/${x.device_id}`}><b>{x.device}</b></A>
              {r === 'busy' ? <span className="muted small"><Spinner /> Running…</span>
                : <span className={`small ${r.ok ? 'ok-text' : 'warn-text'}`}>{r.error ? '✗ Didn’t run' : `${r.ok ? '✓' : '✗'} exit ${r.exit_code}`}{r.ms != null ? <span className="muted">{` · ${fmtMs(r.ms)}`}</span> : null}</span>}
              {r !== 'busy' && r.output ? <Small label="⧉" title="Copy the output" onClick={() => copy(r.output, 'Copied the output')} /> : null}
            </div>
            {r === 'busy' ? null : r.error ? <p className="warn-text small">{r.error}{r.hostkey ? <> <Btn label="Trust the new key and run" disabled={busy} onClick={() => one(x, ran, true)} /></> : null}</p>
              : <pre className="mono small run-output">{r.output || '(no output)'}</pre>}
          </div>;
        })}</div>
      </> : null}
    </>}
  </div>;
}
