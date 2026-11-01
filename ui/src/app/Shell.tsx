/* The frame around every page: sidebar, top bar with search and + New, the phone's tab bar. */
import { Component, Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { GET } from '../api/client';
import { S, aiOn, useApp } from '../lib/state';
import { MOD, hasKeyboard, prefGet, prefSet } from '../lib/util';
import { toast, copy } from '../ui/overlay';
import { editCredential, editEntity } from '../lib/forms';
import { scanDialog } from '../dialogs/scan';
import { aiAssist, installApp } from '../dialogs/later';
import { BackLink, PageWaiting, pageLoading, trackHistory, useHash, whenPageLoaded } from './router';
import { lockNow } from './session';
import { applyTheme, coolantUnlocked, themeIcon, themeName } from './theme';
import { ROUTES, prefetchPages } from './routes';
import { NightBat } from './halloween';

/* Sidebar: everyday pages first, the rest folded under “More”. */
const NAV_GROUPS: [string | null, [string, string, string][]][] = [
  [null, [['dashboard', 'Home', '◧'], ['status', 'Status', '📶'], ['tasks', 'Tasks & Notes', '☑']]],
  ['Inventory', [['devices', 'Devices', '▤'], ['virtual', 'Virtual & Clusters', '⧉'], ['racks', 'Racks & Storage', '▥'], ['components', 'Spare Parts', '◫'], ['builds', 'PC Builder', '⚒']]],
  ['Network', [['networks', 'Networks & IPs', '⌗'], ['discover', 'Discover', '⌖'], ['actions', 'Actions', '⚡'], ['vault', 'Logins (Vault)', '🔑']]],
  ['More', [['locations', 'Locations', '⌂'], ['connections', 'Cables', '⇄'], ['library', 'Parts Library', '▦'],
    ['export', 'Export & Share', '⇪'], ['audit', 'Audit log', '📜'], ['settings', 'Settings', '⚙'], ['help', 'Help & guide', '❓']]],
];

export const BrandName = () => <div className="brand-name">Zom's <span className="brand-accent">HaRM</span></div>;

const closeNav = () => document.body.classList.remove('nav-open');
const toggleNav = () => document.body.classList.toggle('nav-open');

function NavLink({ item: [k, label, ico], top }: { item: [string, string, string]; top: string }) {
  return <a href={`#/${k}`} data-nav={k} title={label} className={k === top ? 'active' : undefined}>
    <span className="ico">{ico}</span><span className="nav-label">{label}</span></a>;
}

function Sidebar({ top }: { top: string }) {
  const installPrompt = useApp(s => s.installPrompt);
  const img = useRef<HTMLImageElement>(null);
  const [more, setMore] = useState(() => prefGet('harm-nav-more') === '1');
  const moreActive = NAV_GROUPS[3][1].some(([k]) => k === top);
  useEffect(() => { if (moreActive) setMore(true); }, [moreActive]);
  /* Easter egg: click the logo 5 times quickly to unlock the Coolant theme. */
  const brandClicks = () => {
    const now = Date.now();
    S.brandClicks = S.brandClicks.filter(t => now - t < 2000).concat(now);
    const i = img.current;
    if (i) { i.classList.remove('brand-pop'); void i.offsetWidth; i.classList.add('brand-pop'); }
    if (S.brandClicks.length < 5) return;
    S.brandClicks = [];
    const first = !coolantUnlocked();
    prefSet('harm-coolant', '1');
    const next = themeName() === 'coolant' ? 'zombeatz' : 'coolant';
    applyTheme(next);
    toast(next === 'coolant' ? (first ? '❄ Coolant unlocked! Switch any time in Settings > Appearance.' : '❄ Coolant on') : 'Back to ZomBeatz');
    useApp.setState(s => ({ lkTick: s.lkTick + 1 }));
  };
  return (
    <aside className="sidebar">
      <a className="brand" href="#/dashboard" onClick={brandClicks}><img ref={img} className="brand-icon" src={themeIcon()} alt="" />
        <div><BrandName /><div className="brand-sub">Hardware &amp; Rack Manager</div></div></a>
      <nav onClick={e => { if ((e.target as Element).closest('a')) closeNav(); }}>
        {NAV_GROUPS.map(([title, items]) => title !== 'More'
          ? <div key={title || 'top'} className="nav-group">{title ? <div className="nav-title">{title}</div> : null}{items.map(i => <NavLink key={i[0]} item={i} top={top} />)}</div>
          : <details key="more" className="nav-group nav-more" open={more}
            onToggle={e => { const o = (e.target as HTMLDetailsElement).open; setMore(o); prefSet('harm-nav-more', o ? '1' : '0'); }}>
            <summary className="nav-title">More</summary>{items.map(i => <NavLink key={i[0]} item={i} top={top} />)}
          </details>)}
      </nav>
      <button className="install-btn" type="button" hidden={!installPrompt} onClick={installApp}>⤓ Install app</button>
      <button className="lock" type="button" onClick={lockNow} title="Lock now">🔒 <span className="nav-label">Lock now</span></button>
    </aside>
  );
}

/* Results appear while typing; Enter or a click opens the item itself. */
function SearchBox({ q }: { q: string }) {
  const [value, setValue] = useState(q);
  const [rows, setRows] = useState<{ kind: string; label: string; sub?: string; link: string }[]>([]);
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const seq = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (q) setValue(q); }, [q]);
  useEffect(() => {
    const v = value.trim();
    if (v.length < 2) { setRows([]); setOpen(false); return; }
    const t = setTimeout(async () => {
      const mine = ++seq.current;
      try { const r = await GET('/search?q=' + encodeURIComponent(v)); if (mine === seq.current) { setRows(r); setSel(0); setOpen(document.activeElement === input.current); } } catch { /* ignore */ }
    }, 180);
    return () => clearTimeout(t);
  }, [value]);
  const go = (link: string) => { setOpen(false); input.current?.blur(); location.hash = link; };
  const all = () => { setOpen(false); location.hash = '#/search?q=' + encodeURIComponent(value.trim()); };
  return (
    <div className="search-wrap">
      <input ref={input} type="search" placeholder="Search devices, IPs, serials, parts…" aria-label="Search" autoComplete="off"
        title={hasKeyboard() ? `Search everything (${MOD} K)` : undefined} value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'ArrowDown' && rows.length) { e.preventDefault(); setSel(s => Math.min(s + 1, Math.min(rows.length, 8) - 1)); setOpen(true); }
          else if (e.key === 'ArrowUp' && rows.length) { e.preventDefault(); setSel(s => Math.max(s - 1, 0)); }
          else if (e.key === 'Escape') { if (open) setOpen(false); else { setValue(''); input.current?.blur(); } }
          else if (e.key === 'Enter' && value.trim()) {
            e.preventDefault();
            if (open && rows[sel]) go(rows[sel].link); else all();
          }
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onFocus={() => { if (rows.length && value.trim().length >= 2) setOpen(true); }} />
      <div className="search-pop" role="listbox" hidden={!open || !rows.length}>
        {rows.slice(0, 8).map((r, i) => (
          <button key={i} type="button" role="option" className={'search-hit' + (i === sel ? ' on' : '')} onMouseDown={e => { e.preventDefault(); go(r.link); }}>
            <span className="badge muted">{r.kind}</span><span className="sh-main"><b>{r.label}</b>{r.sub ? <span className="muted small">{r.sub}</span> : null}</span>
          </button>
        ))}
        {rows.length > 8 ? <button type="button" className="search-all" onMouseDown={e => { e.preventDefault(); all(); }}>{`See all ${rows.length} results`}</button> : null}
      </div>
    </div>
  );
}

function QuickAdd() {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('click', outside);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('click', outside); document.removeEventListener('keydown', esc); };
  }, [open]);
  const toDevice = (r: { id: number }) => { location.hash = `#/devices/${r.id}`; };
  const item = (label: string, fn: () => void) => <button type="button" role="menuitem" onClick={() => { setOpen(false); fn(); }}>{label}</button>;
  const copyScan = (title: string) => scanDialog({ title, single: true, targets: [{ k: 'copy', label: 'Copied' }], onPick: (_k, v) => copy(v, 'Copied') });
  return (
    <div className="qa" ref={wrap}>
      <button type="button" className="primary qa-btn" aria-haspopup="menu" onClick={() => setOpen(o => !o)}>+ New</button>
      <div className="qa-menu" hidden={!open} role="menu">
        <div className="qa-group">Scan a label</div>
        {item('📷 New part from label', () => editEntity('components', { status: 'In Stock', quantity: 1 }, null, { autoScan: true }))}
        {item('📷 New device from label', () => editEntity('devices', { status: 'Active' }, toDevice, { autoScan: true }))}
        {item('🏷 Scan a HaRM label (open device)', () => copyScan('Scan a HaRM label'))}
        {item('📝 Scan text or barcode (copy it)', () => copyScan('Scanner'))}
        {aiOn() ? item('🤖 AI Assist: photos → inventory', () => aiAssist()) : null}
        <div className="qa-group">Add</div>
        {item('▤ Device', () => editEntity('devices', { status: 'Active' }, toDevice))}
        {item('◫ Spare part', () => editEntity('components', { status: 'In Stock', quantity: 1 }))}
        {item('🔑 Login', () => editCredential({}))}
        {item('⌗ Network', () => editEntity('networks', {}))}
        {item('▥ Rack / shelf / pile', () => editEntity('racks', { kind: 'Shelf' }))}
        {item('⌂ Location', () => editEntity('locations', {}))}
      </div>
    </div>
  );
}

/* Phone: the few pages used every day sit in a bottom bar. */
function TabBar({ top }: { top: string }) {
  const t = (k: string, label: string, ico: string) =>
    <a href={`#/${k}`} data-nav={k} className={k === top ? 'active' : undefined}><span className="tb-ico">{ico}</span><span>{label}</span></a>;
  return (
    <nav className="tabbar">
      {t('dashboard', 'Home', '◧')}{t('status', 'Status', '📶')}{t('devices', 'Devices', '▤')}{t('tasks', 'Tasks', '☑')}
      <button type="button" onClick={toggleNav}><span className="tb-ico">☰</span><span>More</span></button>
    </nav>
  );
}

function Datalists() {
  return createPortal(Object.entries(S.enums).map(([name, list]) => (
    <datalist key={name} id={'dl_' + name}>{list.map(v => <option key={v} value={v} />)}</datalist>
  )), document.body);
}

/* A page that fails to draw (or whose code can't be downloaded, as after HaRM was updated while
   this tab was open) shows a message instead of taking the whole app down. */
class PageError extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    const e = this.state.error;
    if (!e) return this.props.children;
    const stale = /dynamically imported module|Importing a module script failed|error loading/i.test(e.message);
    return <div className="card"><p>{stale ? 'HaRM was updated since this page was opened. Reload to get the new version.' : `This page couldn’t be shown: ${e.message}`}</p>
      <button type="button" className="primary" onClick={() => location.reload()}>⟳ Reload</button></div>;
  }
}

function Page({ path, q }: { path: string; q: URLSearchParams }) {
  for (const [re, render] of ROUTES) {
    const m = path.match(re);
    if (m) return render(m, q) as ReactNode;
  }
  return <div className="empty">Page not found.</div>;
}

/* Between pages: the old page stays on screen, dimmed, until the new one has its data, so the
   screen never goes blank. A copy of it is shown, so nothing on it can be clicked. */
function usePageHandover(hash: string) {
  const slot = useRef<HTMLDivElement>(null);
  const snap = useRef<HTMLElement | null>(null);
  const end = useRef<(() => void) | null>(null);
  const [settled, setSettled] = useState(0);
  const before = () => {
    const v = document.getElementById('view');
    snap.current = v && v.childElementCount ? v.cloneNode(true) as HTMLElement : null;
  };
  useLayoutEffect(() => {
    const ghost = snap.current;
    snap.current = null;
    window.scrollTo(0, 0);
    if (!ghost || !pageLoading() || !slot.current) return;
    const view = document.getElementById('view')!;
    ghost.removeAttribute('id');
    ghost.querySelectorAll('[id]').forEach(e => e.removeAttribute('id'));
    ghost.className = 'view-ghost';
    ghost.setAttribute('aria-hidden', 'true');
    ghost.inert = true;
    slot.current.replaceChildren(ghost);
    view.classList.add('view-waiting');
    const stop = whenPageLoaded(() => setSettled(n => n + 1));
    const timer = setTimeout(() => end.current?.(), 5000);
    end.current = () => { end.current = null; stop(); clearTimeout(timer); ghost.remove(); view.classList.remove('view-waiting'); };
    return () => end.current?.();
  }, [hash]);
  // Runs in the same commit as the new page's data, so there's no empty frame in between.
  useLayoutEffect(() => { if (!pageLoading()) end.current?.(); }, [settled]);
  return { slot, before };
}

export function Shell() {
  const handover = useRef<() => void>(() => {});
  const route = useHash(() => handover.current());
  useApp(s => s.lkTick);
  const updateReady = useApp(s => s.updateReady);
  const { path, q, hash } = route;
  trackHistory();
  const top = ({ clusters: 'virtual', uptime: 'status' } as Record<string, string>)[path.split('/')[1]] || path.split('/')[1] || 'dashboard';
  useEffect(() => { document.body.classList.toggle('nav-folded', prefGet('harm-nav-folded') === '1'); }, []);
  useEffect(() => { closeNav(); }, [hash]);
  useEffect(() => { const t = setTimeout(prefetchPages, 3000); return () => clearTimeout(t); }, []);
  const { slot, before } = usePageHandover(hash);
  handover.current = before;
  return (
    <>
      <Sidebar top={top} />
      <div className="main">
        <header className="topbar">
          <button className="icon-btn menu" type="button" aria-label="Menu" onClick={toggleNav}>☰</button>
          <SearchBox q={path === '/search' ? q.get('q') || '' : ''} />
          <QuickAdd />
        </header>
        <div className="view-ghost-slot" ref={slot} />
        <main id="view" key={hash}><PageError><Suspense fallback={<PageWaiting />}><Page path={path} q={q} /></Suspense></PageError></main>
      </div>
      <TabBar top={top} />
      <div className="nav-scrim" onClick={closeNav} />
      <Datalists />
      <NightBat />
      {updateReady ? createPortal(<div className="update-bar">A newer version of HaRM is available. <button type="button" className="sm primary" onClick={() => location.reload()}>⟳ Reload</button></div>, document.body) : null}
    </>
  );
}

export { BackLink };
