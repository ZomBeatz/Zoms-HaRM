/* The journal on every device, rack and room: notes, tasks, work done and issues. */
import { useRef, useState } from 'react';
import { api } from '../api/client';
import { S } from './state';
import { look } from './look';
import { timeAgo, type Row } from './util';
import { confirmBox, toast } from '../ui/overlay';
import { A, MenuButton, Small } from '../ui/bits';

export const NOTE_KINDS: Record<string, [string, string, string]> = {
  note: ['📝', 'Note', 'muted'], task: ['☐', 'Task', 'info'], action: ['🔧', 'Did', 'ok'], issue: ['⚠', 'Issue', 'warn'],
};
export const NOTE_LINKS: Record<string, string> = {
  devices: '#/devices/', racks: '#/racks/', locations: '#/locations/', networks: '#/networks/', builds: '#/builds/',
  clusters: '#/clusters/', components: '#/components?id=',
};
export const isOpenTask = (n: Row) => (n.kind === 'task' || n.kind === 'issue') && !n.done;

type After = () => unknown;

export function NoteItem({ n, after, showTarget = false }: { n: Row; after: After; showTarget?: boolean }) {
  const [ico, label, cls] = NOTE_KINDS[n.kind] || NOTE_KINDS.note;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(n.body);
  const actionable = n.kind === 'task' || n.kind === 'issue';
  const set = async (patch: Row) => { try { await api('PUT', `/notes/${n.id}`, patch); setEditing(false); await after(); } catch (e) { toast((e as Error).message, 'bad'); } };
  return (
    <li className={`note k-${n.kind}${n.done ? ' done' : ''}${n.pinned ? ' pinned' : ''}`}>
      {actionable
        ? <input type="checkbox" className="note-check" checked={!!n.done} title={n.done ? 'Mark as not done' : 'Mark as done'} onChange={e => set({ done: e.target.checked })} />
        : <span className="note-ico" aria-hidden="true">{ico}</span>}
      <div className="note-main">
        {showTarget && n.target_name ? <div className="note-target"><A href={(NOTE_LINKS[n.entity] || '#/components?id=') + n.entity_id}>{n.target_name}</A></div> : null}
        <div className="note-body">
          {editing ? <>
            <textarea rows={3} value={text} autoFocus onChange={e => setText(e.target.value)} />
            <div className="inline"><Small label="Save" onClick={() => text.trim() && set({ body: text })} cls="primary" /><Small label="Cancel" onClick={() => { setEditing(false); setText(n.body); }} /></div>
          </> : n.body}
        </div>
        <div className="note-meta"><span className={`badge ${cls}`}>{label}</span>{` ${timeAgo(n.created_at)}`}
          {n.done && n.done_at ? ` · done ${timeAgo(n.done_at)}` : ''}{n.pinned ? ' · 📌' : ''}</div>
      </div>
      {/* The checkbox marks it done; everything else is in a small menu. */}
      <div className="note-actions"><MenuButton label="⋯" cls="sm ghost" items={[
        [n.pinned ? '📌 Unpin' : '📌 Pin to top', () => set({ pinned: !n.pinned })],
        ['✎ Edit…', () => setEditing(true)],
        ['🗑 Delete', async () => { if (await confirmBox('Delete this entry?')) { await api('DELETE', `/notes/${n.id}`); after(); } }, 'danger-item'],
      ]} /></div>
    </li>
  );
}

/* Quick journal for any item: type and press Enter. No edit dialog needed. */
export function JournalCard({ entity, entityId, notes, after, title = 'Notes & tasks' }: { entity: string; entityId: number; notes: Row[]; after: After; title?: string }) {
  const [kind, setKind] = useState(S.lastNoteKind || 'note');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(S.showAllNotes === `${entity}:${entityId}`);
  const ta = useRef<HTMLTextAreaElement>(null);
  const add = async () => {
    if (!body.trim()) return ta.current?.focus();
    setBusy(true);
    try { await api('POST', '/notes', { entity, entity_id: entityId, kind, body: body.trim() }); setBody(''); await after(); }
    catch (e) { toast((e as Error).message, 'bad'); }
    setBusy(false);
  };
  // Settings > Appearance > Notes: oldest first, and finished tasks out of the way, if chosen.
  const { notesOrder, hideDone } = look();
  const [seeDone, setSeeDone] = useState(false);
  const open = notes.filter(isOpenTask);
  const finished = notes.filter(n => n.done);
  const sorted = notesOrder === 'oldest' ? [...notes].reverse() : notes;
  const rest = sorted.filter(n => !open.includes(n) && (!hideDone || seeDone || !n.done));
  return (
    <section className="card journal">
      <div className="card-head"><h3>{title + (open.length ? ` · ${open.length} open` : '')}</h3></div>
      <div className="note-add">
        <textarea ref={ta} rows={2} className="note-input" value={body} onChange={e => setBody(e.target.value)}
          placeholder="What did you do, notice, or need to do? Enter to add · Shift+Enter for a new line"
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); add(); } }} />
        <div className="note-add-row">
          <div className="kind-chips">{Object.entries(NOTE_KINDS).map(([k, [ico, label]]) => (
            <button key={k} type="button" className={'chip' + (k === kind ? ' on' : '')} onClick={() => { setKind(k); S.lastNoteKind = k; ta.current?.focus(); }}>{`${ico} ${label}`}</button>
          ))}</div>
          <button type="button" className="primary" disabled={busy} onClick={add}>Add</button>
        </div>
      </div>
      {open.length ? <ul className="plain notes-list open">{open.map(n => <NoteItem key={n.id} n={n} after={after} />)}</ul> : null}
      {rest.length ? <ul className="plain notes-list">{rest.slice(0, showAll ? 999 : 6).map(n => <NoteItem key={n.id} n={n} after={after} />)}</ul>
        : (open.length ? null : <div className="empty">Nothing yet. Jot down what you did, what’s broken, or what to do next.</div>)}
      {rest.length > 6 && !showAll ? <Small label={`Show all ${rest.length}`} onClick={() => { S.showAllNotes = `${entity}:${entityId}`; setShowAll(true); }} /> : null}
      {hideDone && finished.length && !seeDone ? <Small label={`Show ${finished.length} finished`} onClick={() => setSeeDone(true)} /> : null}
    </section>
  );
}
