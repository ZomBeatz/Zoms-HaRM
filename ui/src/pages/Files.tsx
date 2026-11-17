/* Files on a machine (#/files?d=&h=&p=&c=): browse folders, upload (button or drop), download, edit
 * text files, new folder, rename, delete, and run a command in the folder. One SSH connection, like
 * the terminal: it closes when HaRM locks or you leave the page. "Use sudo" does it all as root. */
import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { fmtBytes, fmtDay, type Row } from '../lib/util';
import { choose, modal, toast, type ModalCtl } from '../ui/overlay';
import { formDialog } from '../ui/form';
import { A, Btn, PageHead, Small, Spinner, Table } from '../ui/bits';

type Entry = { name: string; type: 'd' | 'f' | 'l' | 'o'; to: string; size: number; mtime: number; mode: string; owner: string; group: string; link: string };
type Up = { name: string; pct: number; err?: string };
type Ran = { cmd: string; dir: string; output: string; exit_code: number; sudo: boolean };

const join = (dir: string, name: string) => (dir.endsWith('/') ? dir : dir + '/') + name;
const parent = (p: string) => p.replace(/\/[^/]+\/?$/, '') || '/';
const isDir = (e: Entry) => e.type === 'd' || (e.type === 'l' && e.to === 'd');
const rwx = (mode: string) => {
  const m = parseInt(mode, 8);
  if (Number.isNaN(m)) return mode;
  return [6, 3, 0].map(s => `${m >> s & 4 ? 'r' : '-'}${m >> s & 2 ? 'w' : '-'}${m >> s & 1 ? 'x' : '-'}`).join('');
};
const when = (t: number) => { const d = new Date(t * 1000); return `${fmtDay(d.toISOString().slice(0, 10))} ${d.toTimeString().slice(0, 5)}`; };

export default function Files({ q }: { q: URLSearchParams }) {
  const [sid, setSid] = useState('');
  const [label, setLabel] = useState(`${q.get('h')}`);
  const [home, setHome] = useState('');
  const [path, setPath] = useState('');
  const [typed, setTyped] = useState('');
  const [list, setList] = useState<Entry[] | null>(null);
  const [cut, setCut] = useState(false);
  const [err, setErr] = useState('');
  const [closed, setClosed] = useState('');
  const [keyChanged, setKeyChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sudo, setSudo] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [ups, setUps] = useState<Up[]>([]);
  const [drop, setDrop] = useState(false);
  const [cmd, setCmd] = useState('');
  const [log, setLog] = useState<Ran[]>([]);
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState(0);
  const [trust, setTrust] = useState(false);
  const pick = useRef<HTMLInputElement>(null);
  const logBox = useRef<HTMLDivElement>(null);
  const sidRef = useRef('');

  useEffect(() => {
    let gone = false;
    setClosed(''); setErr(''); setKeyChanged(false); setList(null);
    (async () => {
      try {
        const r = await api('POST', '/files', { device_id: +(q.get('d') || 0) || null, host: q.get('h'), port: +(q.get('p') || 22),
          credential_id: +(q.get('c') || 0), legacy: q.get('legacy') === '1', trust_new_key: trust });
        if (gone) { api('POST', `/files/${r.id}/close`, {}).catch(() => {}); return; }
        sidRef.current = r.id;
        setSid(r.id); setLabel(r.label); setHome(r.home);
        await open(r.home, r.id);
      } catch (e) {
        const m = (e as Error).message;
        setClosed(m); setKeyChanged(/host key changed/i.test(m));
      }
    })();
    return () => { gone = true; if (sidRef.current) api('POST', `/files/${sidRef.current}/close`, {}).catch(() => {}); sidRef.current = ''; };
  }, [run, q.toString()]);  // eslint-disable-line react-hooks/exhaustive-deps

  const fail = (e: unknown) => {
    const m = (e as Error).message;
    if (/has closed|open it again/i.test(m)) setClosed(m); else toast(m, 'bad');
  };
  async function open(p: string, id = sid, asRoot = sudo) {
    setBusy(true); setErr('');
    try {
      const r = await api('GET', `/files/${id}/list?${new URLSearchParams({ path: p, sudo: asRoot ? 'true' : 'false' })}`);
      setPath(r.path); setTyped(r.path); setList(r.entries); setCut(r.cut);
    } catch (e) {
      const m = (e as Error).message;
      if (/has closed|open it again/i.test(m)) setClosed(m); else setErr(m);
    }
    setBusy(false);
  }
  const reload = () => open(path);
  const doOp = async (body: Row) => api('POST', `/files/${sid}/do`, { sudo, ...body });

  const download = (e: Entry) => {
    const a = document.createElement('a');
    a.href = `/api/files/${sid}/download?${new URLSearchParams({ path: join(path, e.name), sudo: sudo ? 'true' : 'false' })}`;
    a.download = e.name;
    document.body.appendChild(a); a.click(); a.remove();
  };
  const openEntry = (e: Entry) => {
    if (isDir(e)) return open(join(path, e.name));
    if (e.type === 'f' || e.type === 'l') return e.size <= 1024 * 1024 ? editFile(e) : download(e);
  };
  const editFile = async (e: Entry) => {
    const p = join(path, e.name);
    try {
      const r = await doOp({ op: 'read', path: p });
      modal(<span className="mono">{p}</span>, (m: ModalCtl) => <Editor m={m} text={r.text} save={async t => { await doOp({ op: 'write', path: p, text: t }); toast(`Saved ${e.name}`); reload(); }} />,
        { wide: true, cls: 'files-editor' });
    } catch (err) {
      const m = (err as Error).message;
      if (/text file|over 1 MB/.test(m) && await choose(e.name, m, [['no', 'Cancel'], ['yes', '⬇ Download', 'primary']]) === 'yes') download(e);
      else if (!/text file|over 1 MB/.test(m)) fail(err);
    }
  };
  const newFolder = () => formDialog({
    title: 'New folder', fields: [{ k: 'name', label: `Name (in ${path})`, required: true, raw: true }],
    submit: async v => { await doOp({ op: 'mkdir', path: join(path, String(v.name).trim()) }); },
    onDone: () => reload(),
  });
  const newFile = () => formDialog({
    title: 'New text file', fields: [{ k: 'name', label: `Name (in ${path})`, required: true, raw: true, ph: 'notes.txt' }],
    submit: async v => { await doOp({ op: 'write', path: join(path, String(v.name).trim()), text: '' }); },
    onDone: () => reload(),
  });
  const rename = (e: Entry) => formDialog({
    title: `Rename ${e.name}`, rec: { name: e.name }, fields: [{ k: 'name', label: 'New name', required: true, raw: true }],
    submit: async v => {
      const to = String(v.name).trim();
      await doOp({ op: 'rename', path: join(path, e.name), to: to.startsWith('/') ? to : join(path, to) });
    },
    onDone: () => reload(),
  });
  const del = async (e: Entry) => {
    const what = isDir(e) && e.type === 'd' ? `the folder ${e.name} and everything in it` : e.name;
    if (await choose(`Delete ${e.name}?`, `This deletes ${what} on the machine${sudo ? ', as root' : ''}. It can’t be undone.`,
      [['no', 'Cancel'], ['yes', 'Delete', 'danger']]) !== 'yes') return;
    try { await doOp({ op: 'delete', path: join(path, e.name) }); toast(`Deleted ${e.name}`); reload(); } catch (err) { fail(err); }
  };

  const upload = async (fs: FileList | File[]) => {
    const all = Array.from(fs);
    if (!all.length || !sid) return;
    const names = new Set((list || []).map(e => e.name));
    const clash = all.filter(f => names.has(f.name));
    if (clash.length && await choose('Replace files?', `${clash.map(f => f.name).join(', ')} ${clash.length === 1 ? 'is' : 'are'} already in ${path}.`,
      [['no', 'Cancel'], ['yes', 'Replace', 'danger']]) !== 'yes') return;
    const dir = path;
    for (const f of all) {
      setUps(u => [...u.filter(x => x.name !== f.name), { name: f.name, pct: 0 }]);
      const set = (x: Partial<Up>) => setUps(u => u.map(y => y.name === f.name ? { ...y, ...x } : y));
      await new Promise<void>(done => {
        const x = new XMLHttpRequest();
        x.open('PUT', `/api/files/${sid}/upload?${new URLSearchParams({ path: join(dir, f.name), sudo: sudo ? 'true' : 'false' })}`);
        x.setRequestHeader('X-HaRM', '1');
        x.upload.onprogress = ev => ev.lengthComputable && set({ pct: Math.round(ev.loaded / ev.total * 100) });
        x.onload = () => {
          if (x.status < 300) setUps(u => u.filter(y => y.name !== f.name));
          else { let m = x.statusText; try { m = JSON.parse(x.responseText).detail || m; } catch { /* plain */ } set({ err: m }); }
          done();
        };
        x.onerror = () => { set({ err: 'The upload stopped' }); done(); };
        x.send(f);
      });
    }
    if (dir === path) reload();
  };

  const runCmd = async () => {
    const c = cmd.trim();
    if (!c || running) return;
    setRunning(true);
    try {
      const r = await doOp({ op: 'run', path, command: c });
      setLog(l => [...l.slice(-30), { cmd: c, dir: path, sudo, ...r }]);
      setCmd('');
      reload();
    } catch (e) { fail(e); }
    setRunning(false);
    setTimeout(() => logBox.current?.scrollTo({ top: 1e9 }), 30);
  };

  const term = () => { location.hash = `#/terminal?${new URLSearchParams([...q.entries()].filter(([k]) => ['d', 'h', 'p', 'c', 'u', 'legacy'].includes(k)))}`; };
  const crumbs = path.split('/').filter(Boolean);
  const shown = (list || []).filter(e => hidden || !e.name.startsWith('.'));
  const sorted = [...shown].sort((a, b) => Number(isDir(b)) - Number(isDir(a)) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

  if (closed) return <div className="files-page">
    <PageHead title={label} sub={<span>Files · {q.get('d') ? <A href={`#/devices/${q.get('d')}`}>Back to the device</A> : null}</span>}>
      <Btn label="⟳ Connect again" cls="primary" onClick={() => { setTrust(false); setRun(n => n + 1); }} />
    </PageHead>
    <p className="warn-text">{closed}</p>
    {keyChanged ? <div className="notice warn"><b>The machine’s SSH key changed.</b> That’s normal after reinstalling it, but can also mean something is intercepting the connection.{' '}
      <Btn label="Trust the new key and connect" onClick={() => { toast('Trusting the new key'); setTrust(true); setRun(n => n + 1); }} /></div> : null}
  </div>;

  return <div className={`files-page${drop ? ' drop' : ''}`}
    onDragOver={e => { if (sid && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrop(true); } }}
    onDragLeave={e => { if (e.currentTarget === e.target) setDrop(false); }}
    onDrop={e => { e.preventDefault(); setDrop(false); upload(e.dataTransfer.files); }}>
    <PageHead title={label} sub={<span>{`Files${sudo ? ' as root (sudo)' : ''} · closes when HaRM locks · `}{q.get('d') ? <A href={`#/devices/${q.get('d')}`}>Back to the device</A> : null}</span>}>
      <Small label="⬆ Upload" title="Or drop files on the list" disabled={!sid} onClick={() => pick.current?.click()} />
      <Small label="+ Folder" disabled={!sid} onClick={newFolder} />
      <Small label="+ File" disabled={!sid} onClick={newFile} />
      <Small label="⌨ Terminal" title="A full terminal on this machine" onClick={term} />
      <Small label="✕ Close" onClick={() => { history.length > 1 ? history.back() : (location.hash = '#/dashboard'); }} />
    </PageHead>
    <input ref={pick} type="file" multiple hidden onChange={e => { if (e.target.files) upload(e.target.files); e.target.value = ''; }} />
    <form className="files-bar" onSubmit={e => { e.preventDefault(); open(typed.trim() || home); }}>
      <Small label="↑" title="Up one folder" disabled={!sid || path === '/'} onClick={() => open(parent(path))} />
      <Small label="⌂" title="Home folder" disabled={!sid} onClick={() => open(home)} />
      <Small label="⟳" title="Reload" disabled={!sid} onClick={reload} />
      <input className="mono" aria-label="Folder" value={typed} onChange={e => setTyped(e.target.value)} spellCheck={false} />
      <label className="check inline-check" title="List, change and run things as root"><input type="checkbox" checked={sudo} disabled={!sid}
        onChange={e => { setSudo(e.target.checked); open(path, sid, e.target.checked); }} />Use sudo</label>
      <label className="check inline-check"><input type="checkbox" checked={hidden} onChange={e => setHidden(e.target.checked)} />Hidden files</label>
    </form>
    <div className="files-crumbs small">
      <a href="#" onClick={e => { e.preventDefault(); open('/'); }}>/</a>
      {crumbs.map((c, i) => <span key={i}><a href="#" onClick={e => { e.preventDefault(); open('/' + crumbs.slice(0, i + 1).join('/')); }}>{c}</a>{i < crumbs.length - 1 ? ' / ' : ''}</span>)}
      {busy ? <> <Spinner /></> : null}
    </div>
    {ups.length ? <ul className="plain-list files-ups">{ups.map(u => <li key={u.name} className="small">
      <span className="mono">{u.name}</span>{' '}{u.err ? <><span className="warn-text">{u.err}</span> <a href="#" onClick={e => { e.preventDefault(); setUps(x => x.filter(y => y.name !== u.name)); }}>Dismiss</a></>
        : <><progress max={100} value={u.pct} /> {u.pct}%</>}</li>)}</ul> : null}
    <div className="files-list">
      {err ? <p className="warn-text">{err}</p> : !list ? <div className="muted"><Spinner /> {sid ? 'Reading the folder…' : 'Signing in over SSH…'}</div>
        : <Table<Entry & Row> rows={sorted as (Entry & Row)[]} empty={hidden ? 'This folder is empty.' : 'Nothing here (tick Hidden files to see files starting with a dot).'}
          onRow={r => openEntry(r)} rowClass={r => isDir(r) ? 'files-dir' : ''} cols={[
            { label: 'Name', get: r => <span className="files-name">{isDir(r) ? '📁' : r.type === 'l' ? '🔗' : r.type === 'o' ? '⚙' : '📄'} <span>{r.name}</span>
              {r.type === 'l' ? <span className="muted small">{` → ${r.link}`}</span> : null}</span>, sort: r => `${isDir(r) ? 0 : 1}${r.name.toLowerCase()}` },
            { label: 'Size', get: r => isDir(r) ? '' : fmtBytes(r.size), sort: r => isDir(r) ? -1 : r.size, cls: 'num' },
            { label: 'Modified', get: r => when(r.mtime), sort: r => r.mtime },
            { label: 'Permissions', get: r => <span className="mono small" title={r.mode}>{rwx(r.mode)}</span>, sort: r => r.mode },
            { label: 'Owner', get: r => r.owner === r.group ? r.owner : `${r.owner}:${r.group}` },
            { label: '', nosort: true, get: r => <span className="row-actions">
              {!isDir(r) && r.type !== 'o' ? <Small label="⬇" title="Download" onClick={() => download(r)} /> : null}
              <Small label="✎" title="Rename or move" onClick={() => rename(r)} />
              <Small label="🗑" title="Delete" onClick={() => del(r)} /></span> },
          ]} />}
      {cut ? <p className="muted small">Showing the first 5,000. Use the command box (like <span className="mono">ls</span>) for the rest.</p> : null}
    </div>
    <div className="files-shell">
      {log.length ? <div className="files-log mono small" ref={logBox}>{log.map((l, i) => <div key={i}>
        <div className="files-cmd">{`${l.sudo ? '#' : '$'} ${l.cmd}`}<span className="muted">{`  (in ${l.dir}${l.exit_code ? `, exit code ${l.exit_code}` : ''})`}</span></div>
        <pre>{l.output || ' '}</pre></div>)}</div> : null}
      <form className="inline" onSubmit={e => { e.preventDefault(); runCmd(); }}>
        <input className="mono" aria-label="Command" placeholder={`Run a command in ${path || 'this folder'}${sudo ? ' as root' : ''}…`} value={cmd} onChange={e => setCmd(e.target.value)} disabled={!sid} spellCheck={false} autoComplete="off" />
        <Btn label={running ? 'Running…' : '▶ Run'} cls="primary" disabled={!sid || running || !cmd.trim()} onClick={runCmd} />
        {log.length ? <Small label="Clear" onClick={() => setLog([])} /> : null}
      </form>
      <p className="muted small">One command at a time, up to 2 minutes, without typing into it. For anything interactive, use <a href="#" onClick={e => { e.preventDefault(); term(); }}>the terminal</a>.</p>
    </div>
  </div>;
}

function Editor({ m, text, save }: { m: ModalCtl; text: string; save: (t: string) => Promise<void> }) {
  const [t, setT] = useState(text);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { await save(t); m.close(true); } catch (e) { toast((e as Error).message, 'bad'); }
    setBusy(false);
  };
  return <form className="disc-form" onSubmit={e => { e.preventDefault(); go(); }}>
    <textarea className="mono files-text" value={t} onChange={e => setT(e.target.value)} spellCheck={false}
      onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); go(); } }} />
    <div className="actions"><Btn label="Cancel" onClick={() => m.close()} /><Btn label={busy ? 'Saving…' : '💾 Save'} cls="primary" disabled={busy || t === text} onClick={go} /></div>
  </form>;
}
