/* Add HaRM's SSH key to many machines at once (Settings > HaRM's SSH key > Add to my machines…).
 * Each machine is the device's saved SSH login at its first address, done one after another with
 * the same endpoint as 🔌 Connect > Add HaRM's SSH key, so each one is checked and audited. */
import { useEffect, useState } from 'react';
import { api, GET } from '../api/client';
import { timeAgo, type Row } from '../lib/util';
import { modal, toast, type ModalCtl } from '../ui/overlay';
import { A, Btn, Spinner } from '../ui/bits';

export function addKeyDialog() {
  modal('Add HaRM’s SSH key to my machines', (m: ModalCtl) => <AddKey m={m} />);
}

type Result = { ok: boolean; text: string; hostkey?: boolean };

function AddKey({ m }: { m: ModalCtl }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [pick, setPick] = useState<Set<number>>(new Set());
  const [res, setRes] = useState<Record<number, Result | 'busy'>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    GET('/ssh-key/targets').then((r: Row[]) => { setRows(r); setPick(new Set(r.filter(x => !x.added).map(x => x.device_id))); })
      .catch(e => { toast((e as Error).message, 'bad'); setRows([]); });
  }, []);
  if (!rows) return <div className="muted"><Spinner /> Loading…</div>;
  if (!rows.length) return <p className="muted">No machines to add it to yet. A machine needs a saved login of the kind <b>SSH</b> or <b>OS Account</b>, with a username and password, on its device (not Windows).</p>;
  const one = async (x: Row, trust = false) => {
    setRes(r => ({ ...r, [x.device_id]: 'busy' }));
    let out: Result;
    try {
      const r = await api('POST', `/devices/${x.device_id}/ssh-key`, { host: x.host, port: x.port, credential_id: x.credential_id, trust_new_key: trust });
      out = r.works ? { ok: true, text: 'Added. HaRM signs in with its key now' } : { ok: false, text: 'Added, but signing in with it didn’t work: the machine may not allow keys' };
    } catch (e) {
      const msg = (e as Error).message;
      out = { ok: false, text: msg, hostkey: /host key changed/i.test(msg) };
    }
    setRes(r => ({ ...r, [x.device_id]: out }));
    return out;
  };
  const all = async () => {
    setBusy(true);
    let good = 0;
    const todo = rows.filter(x => pick.has(x.device_id));
    for (const x of todo) if ((await one(x)).ok) good++;
    setBusy(false);
    toast(`Added to ${good} of ${todo.length} machine${todo.length === 1 ? '' : 's'}`, good === todo.length ? 'ok' : 'bad');
  };
  const toggle = (id: number, on: boolean) => setPick(p => { const n = new Set(p); if (on) n.add(id); else n.delete(id); return n; });
  return <div className="disc-form">
    <p className="muted small">HaRM signs in to each machine once with its saved login and adds its public key to that user’s <code>~/.ssh/authorized_keys</code>, changing nothing else, then checks it can sign in with only the key.</p>
    <ul className="plain-list key-targets">{rows.map(x => {
      const r = res[x.device_id];
      return <li key={x.device_id}>
        <label className="check"><input type="checkbox" checked={pick.has(x.device_id)} disabled={busy} onChange={e => toggle(x.device_id, e.target.checked)} />
          <span><A href={`#/devices/${x.device_id}`}><b>{x.device}</b></A> <span className="mono small">{`${x.username}@${x.host}${x.port !== 22 ? `:${x.port}` : ''}`}</span>
            {x.added && !r ? <span className="muted small">{` · added ${timeAgo(x.added)}`}</span> : null}</span></label>
        {r === 'busy' ? <div className="muted small"><Spinner /> Adding…</div>
          : r ? <div className={`small ${r.ok ? 'ok-text' : 'warn-text'}`}>{r.ok ? '✓ ' : '✗ '}{r.text}
            {r.hostkey ? <> <Btn label="Trust the new key and add" disabled={busy} onClick={() => one(x, true)} /></> : null}</div> : null}
      </li>;
    })}</ul>
    <div className="inline">
      <Btn label={busy ? 'Adding…' : `🗝 Add to ${pick.size} machine${pick.size === 1 ? '' : 's'}`} cls="primary" disabled={busy || !pick.size} onClick={all} />
      <Btn label="Close" disabled={busy} onClick={() => m.close(true)} />
    </div>
  </div>;
}
