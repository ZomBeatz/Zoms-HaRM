/* The simpler list pages: cables, the vault, the audit log, search results. */
import { useEffect, useState } from 'react';
import { GET } from '../api/client';
import { S } from '../lib/state';
import { genPassword, type Row } from '../lib/util';
import { copy, modal } from '../ui/overlay';
import { A, Btn, Card, HelpLink, PageHead, Table } from '../ui/bits';
import { ConnTable, CredTable } from '../ui/tables';
import { editCredential, editEntity } from '../lib/forms';
import { revealCredential } from '../dialogs/credential';
import { Pending, cleanHash, useLoad } from '../app/router';

export function Connections() {
  const q = useLoad(() => GET('/connections'));
  if (!q.data) return <Pending q={q} />;
  return <>
    <PageHead title="Connections" sub="Cables and links between devices: network, storage, power, console.">
      <a className="button" href="/api/export/connections.csv">Export CSV</a>
      <Btn label="+ Add connection" onClick={() => editEntity('connections', {})} cls="primary" />
    </PageHead>
    <Card title="All connections"><ConnTable rows={q.data} /></Card>
  </>;
}

function PasswordGenerator() {
  const [len, setLen] = useState('24');
  const [pw, setPw] = useState(() => genPassword());
  return (
    <div>
      <div className="recovery"><code className="secret big">{pw}</code></div>
      <div className="toolbar"><label>Length </label><input type="number" min={8} max={128} value={len} onChange={e => setLen(e.target.value)} />
        <Btn label="Regenerate" onClick={() => setPw(genPassword(Math.min(128, Math.max(8, +len || 24))))} />
        <Btn label="Copy" onClick={() => copy(pw, 'Password')} cls="primary" /></div>
    </div>
  );
}

export function Vault({ q: qs }: { q: URLSearchParams }) {
  const q = useLoad(() => GET<Row[]>('/credentials'));
  const F = S.filters.vault;
  const [needle, setNeedle] = useState<string>(F.q || '');
  useEffect(() => {
    const want = q.data && qs.get('open') ? q.data.find(r => String(r.id) === qs.get('open')) : null;
    if (want) { cleanHash('#/vault'); setTimeout(() => revealCredential(want), 0); }
  }, [q.data]);  // eslint-disable-line react-hooks/exhaustive-deps
  if (!q.data) return <Pending q={q} />;
  const n = needle.toLowerCase();
  return <>
    <PageHead title="Vault" sub="Logins and secrets, encrypted with AES-256-GCM under your master password.">
      <HelpLink s="logins" />
      <Btn label="Password generator" onClick={() => modal('Password generator', <PasswordGenerator />)} />
      <Btn label="+ Add login" onClick={() => editCredential({})} cls="primary" />
    </PageHead>
    <div className="toolbar"><input type="search" placeholder="Filter…" value={needle} onChange={e => { F.q = e.target.value; setNeedle(e.target.value); }} /></div>
    <CredTable rows={q.data.filter(r => !n || [r.label, r.kind, r.username, r.url, r.device_name].some(x => x && x.toLowerCase().includes(n)))} />
  </>;
}

export function Audit() {
  const q = useLoad(() => GET('/audit?limit=1000'));
  if (!q.data) return <Pending q={q} />;
  return <>
    <PageHead title="Audit Log" sub="Every change, login, export and secret reveal." />
    <Card title="Last 1000 events"><Table rows={q.data} cols={[
      { label: 'Time (UTC)', get: r => <span className="mono small">{r.ts}</span> },
      { label: 'Action', get: r => <b className={/fail/.test(r.action) ? 'bad-text' : ''}>{r.action}</b> },
      { label: 'Entity', get: r => r.entity ? `${r.entity}${r.entity_id ? ' #' + r.entity_id : ''}` : '' },
      { label: 'Detail', get: r => r.detail || '' },
      { label: 'IP', get: r => <span className="mono small">{r.ip || ''}</span> },
    ]} /></Card>
  </>;
}

export function Search({ q: text }: { q: string }) {
  const q = useLoad(() => text ? GET<Row[]>('/search?q=' + encodeURIComponent(text)) : Promise.resolve([] as Row[]));
  // One match opens it directly, in place of the search, so "Back to" skips the search too.
  const only = q.data?.length === 1 ? q.data[0].link : null;
  useEffect(() => {
    if (!only) return;
    if (S.hist[S.hist.length - 1]?.hash === location.hash) S.hist.pop();
    location.replace(only);
  }, [only]);
  if (!q.data || only) return <Pending q={q} />;
  const rows = q.data;
  return <>
    <PageHead title={`Search: ${text}`} sub={`${rows.length} result${rows.length === 1 ? '' : 's'}`} />
    {rows.length ? <div className="card"><ul className="plain results">{rows.map((r, i) => (
      <li key={i}><span className="badge muted">{r.kind}</span> <A href={r.link}>{r.label}</A> <span className="muted small">{r.sub}</span></li>
    ))}</ul></div> : <div className="empty">{text.length < 2 ? 'Type at least 2 characters.' : 'Nothing found.'}</div>}
  </>;
}
