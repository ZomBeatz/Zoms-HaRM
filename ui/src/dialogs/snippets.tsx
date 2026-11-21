/* Saved commands: named commands you use often, for the terminal, Files' command box and Run on
 * machines. Kept in HaRM's database, encrypted like the vault (GET/PUT /api/snippets). */
import { useEffect, useState } from 'react';
import { api, GET } from '../api/client';
import { type Row } from '../lib/util';
import { modal, toast, type ModalCtl } from '../ui/overlay';
import { formDialog } from '../ui/form';
import { Btn, MenuButton, Small, type MenuItem } from '../ui/bits';

export type Snippet = { id: string; name: string; command: string; sudo: boolean };

let cache: Snippet[] | null = null;
const listeners = new Set<(s: Snippet[]) => void>();
const publish = (s: Snippet[]) => { cache = s; listeners.forEach(f => f(s)); };

export async function loadSnippets(fresh = false): Promise<Snippet[]> {
  if (cache && !fresh) return cache;
  const s = await GET('/snippets') as Snippet[];
  publish(s);
  return s;
}

async function saveAll(list: Snippet[]) {
  publish(await api('PUT', '/snippets', { snippets: list }) as Snippet[]);
}

export function useSnippets(): Snippet[] {
  const [s, setS] = useState<Snippet[]>(cache || []);
  useEffect(() => {
    listeners.add(setS);
    loadSnippets().catch(() => {});
    return () => { listeners.delete(setS); };
  }, []);
  return s;
}

/* Name a command and keep it. */
export function saveSnippet(command: string, sudo = false) {
  const c = command.trim();
  if (!c) return;
  formDialog({
    title: 'Save this command',
    rec: { name: c.split('\n')[0].slice(0, 60), command: c, sudo },
    fields: [
      { k: 'name', label: 'Name', required: true, raw: true },
      { k: 'command', label: 'Command', type: 'textarea', required: true, raw: true, rows: 4 },
      { k: 'sudo', label: 'Run with sudo (on Run on machines)', type: 'checkbox' },
    ],
    submit: async (v: Row) => {
      await saveAll([...await loadSnippets(), { id: '', name: String(v.name).trim(), command: String(v.command), sudo: !!v.sudo }]);
    },
    onDone: () => toast('Saved'),
  });
}

/* ★ Saved: pick a saved command, keep the one typed, or edit the list. */
export function SnippetMenu({ onPick, current, sudo }: { onPick: (s: Snippet) => void; current?: string; sudo?: boolean }) {
  const list = useSnippets();
  return <MenuButton label="★ Saved" cls="sm" items={[
    ...list.map((s): MenuItem => [<span key={s.id} title={s.command}>{s.name}{s.sudo ? <span className="muted"> · sudo</span> : null}</span>, () => onPick(s)]),
    !list.length && [<span className="muted">No saved commands yet</span>, () => {}],
    current?.trim() ? ['＋ Save this command…', () => saveSnippet(current, sudo)] : null,
    list.length ? ['✎ Edit saved commands…', () => snippetsDialog()] : null,
  ]} />;
}

export function snippetsDialog() {
  modal('Saved commands', (m: ModalCtl) => <Edit m={m} />, { wide: true });
}

function Edit({ m }: { m: ModalCtl }) {
  const [rows, setRows] = useState<Snippet[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { loadSnippets(true).then(s => setRows(s.map(x => ({ ...x })))).catch(e => { toast((e as Error).message, 'bad'); setRows([]); }); }, []);
  if (!rows) return <p className="muted">Loading…</p>;
  const set = (i: number, x: Partial<Snippet>) => setRows(r => r!.map((y, j) => j === i ? { ...y, ...x } : y));
  const move = (i: number, d: number) => setRows(r => { const n = [...r!]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x); return n; });
  const save = async () => {
    setBusy(true);
    try { await saveAll(rows); toast('Saved'); m.close(true); } catch (e) { toast((e as Error).message, 'bad'); }
    setBusy(false);
  };
  return <div className="disc-form">
    <p className="muted small">Pick them from <b>★ Saved</b> in the terminal, Files and Run on machines. They’re kept encrypted, like the vault.</p>
    {!rows.length ? <p className="muted">No saved commands. Type one in a command box, then ★ Saved › Save this command.</p> : null}
    <ul className="plain-list snippets">{rows.map((s, i) => <li key={s.id || i}>
      <div className="inline">
        <input aria-label="Name" value={s.name} onChange={e => set(i, { name: e.target.value })} />
        <label className="check inline-check"><input type="checkbox" checked={s.sudo} onChange={e => set(i, { sudo: e.target.checked })} />sudo</label>
        <Small label="↑" title="Move up" disabled={i === 0} onClick={() => move(i, -1)} />
        <Small label="↓" title="Move down" disabled={i === rows.length - 1} onClick={() => move(i, 1)} />
        <Small label="🗑" title="Delete" onClick={() => setRows(r => r!.filter((_, j) => j !== i))} />
      </div>
      <textarea className="mono" aria-label="Command" rows={Math.min(6, s.command.split('\n').length + 1)} value={s.command} spellCheck={false}
        onChange={e => set(i, { command: e.target.value })} />
    </li>)}</ul>
    <div className="actions"><Btn label="Cancel" onClick={() => m.close()} /><Btn label={busy ? 'Saving…' : 'Save'} cls="primary" disabled={busy} onClick={save} /></div>
  </div>;
}
