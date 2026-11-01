/* Tasks & issues: everything open, grouped by what it's about. */
import { useState } from 'react';
import { api, GET } from '../api/client';
import { S } from '../lib/state';
import type { Row } from '../lib/util';
import { toast } from '../ui/overlay';
import { Btn, Card, HelpLink, PageHead } from '../ui/bits';
import { NOTE_LINKS, NoteItem } from '../lib/notes';
import { Pending, useLoad } from '../app/router';

export default function Tasks() {
  const q = useLoad(() => Promise.all([GET<Row[]>('/notes?done=0'), GET<Row[]>('/notes?done=1')]));
  const [dev, setDev] = useState('');
  const [text, setText] = useState('');
  if (!q.data) return <Pending q={q} />;
  const [open, done] = q.data;
  const back = q.reload;
  const todo = open.filter(n => n.kind === 'task' || n.kind === 'issue');
  const recent = done.filter(n => n.kind === 'task' || n.kind === 'issue').sort((a, b) => (b.done_at || '').localeCompare(a.done_at || '')).slice(0, 15);
  const groups = new Map<string, Row[]>();
  for (const n of todo) {
    const k = `${n.entity}:${n.entity_id}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(n);
  }
  const addTask = async () => {
    if (!dev || !text.trim()) return toast('Pick a device and type the task', 'bad');
    await api('POST', '/notes', { entity: 'devices', entity_id: +dev, kind: 'task', body: text.trim() });
    setText('');
    back();
  };
  return <>
    <PageHead title="Tasks & issues" sub={`${todo.length} open across ${groups.size} item${groups.size === 1 ? '' : 's'}`}><HelpLink s="notes" /></PageHead>
    <div className="card"><div className="toolbar task-add">
      <select aria-label="Device" value={dev} onChange={e => setDev(e.target.value)}><option value="">Device…</option>{S.lk.devices.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
      <input placeholder="New task, e.g. “Replace failed drive in bay 3”" value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addTask(); }} />
      <Btn label="+ Add task" onClick={addTask} cls="primary" />
    </div></div>
    {todo.length ? [...groups.entries()].map(([k, list]) => (
      <Card key={k} title={list[0].target_name || 'Item'} actions={<a className="button sm" href={(NOTE_LINKS[list[0].entity] || '#/components?id=') + list[0].entity_id}>Open</a>}>
        <ul className="plain notes-list open">{list.map(n => <NoteItem key={n.id} n={n} after={back} />)}</ul>
      </Card>
    )) : <div className="card onboarding"><h3>All clear 🎉</h3><p>Add tasks from any device page (Notes &amp; tasks), or above.</p></div>}
    {recent.length ? <Card title="Recently done"><ul className="plain notes-list">{recent.map(n => <NoteItem key={n.id} n={n} after={back} showTarget />)}</ul></Card> : null}
  </>;
}
