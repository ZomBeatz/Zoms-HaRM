/* The small pieces every page is made of: buttons, cards, tables, menus, tabs, badges. */
import { Children, isValidElement, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { S } from '../lib/state';
import { Ic } from '../lib/icons';
import { badgeClass, fmtDay, nz, prefGet, prefSet, today, type Row } from '../lib/util';

export type Kid = ReactNode;

/* The visible text of some JSX, for sorting tables and skipping empty details. */
export function nodeText(n: ReactNode): string {
  if (n == null || typeof n === 'boolean') return '';
  if (typeof n === 'string' || typeof n === 'number') return String(n);
  if (Array.isArray(n)) return n.map(nodeText).join('');
  if (isValidElement(n)) {
    // Host elements by their text; small components (Mono, WarrantyCell…) by the value they show.
    const p = n.props as Row;
    for (const k of ['children', 'label', 'text', 'status', 'v', 'd', 'url', 'date']) if (p[k] != null) return nodeText(p[k]);
    return '';
  }
  return '';
}

export const Badge = ({ status }: { status?: string | null }) =>
  status ? <span className={`badge ${badgeClass(status)}`}>{status}</span> : null;
export const Dot = ({ on }: { on: unknown }) =>
  <span className={'dot ' + (on ? 'on' : 'off')} title={on ? 'Hooked up' : 'Not hooked up'} />;
export const A = ({ href, children, cls }: { href: string; children?: Kid; cls?: string }) =>
  <a href={href} className={cls}>{children}</a>;
export function ExtLink({ url, text }: { url?: string | null; text?: Kid }) {
  if (!url) return null;
  return /^https?:\/\//i.test(url) ? <a href={url} target="_blank" rel="noopener noreferrer">{text || url}</a> : <>{url}</>;
}
export const Mono = ({ v }: { v: unknown }) => v == null || v === '' ? null : <span className="mono">{String(v)}</span>;
export const Spinner = () => <span className="spinner" />;

export function Btn({ label, onClick, cls = '', disabled, title }: { label: Kid; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; cls?: string; disabled?: boolean; title?: string }) {
  return <button type="button" className={cls} onClick={onClick} disabled={disabled} title={title}>{label}</button>;
}
export const Small = ({ label, onClick, cls = '', disabled, title }: Parameters<typeof Btn>[0]) =>
  <Btn label={label} onClick={onClick} cls={'sm ' + cls} disabled={disabled} title={title} />;
export const HelpLink = ({ s, label = '?' }: { s: string; label?: string }) =>
  <a className="button help-btn" href={`#/help?s=${s}`} title="How this works">{label}</a>;

export function WarrantyCell({ d }: { d?: string | null }) {
  if (!d) return null;
  const cls = d < today() ? 'bad-text' : (d <= new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10) ? 'warn-text' : '');
  return <span className={cls}>{fmtDay(d)}</span>;
}

export function PageHead({ title, sub, children }: { title: Kid; sub?: Kid; children?: Kid }) {
  // The page's name for "Back to …": the title's first part, without badges after it.
  const kids = isValidElement(title) ? (title.props as Row).children : null;
  const text = nodeText(Array.isArray(kids) ? kids[0] : title).trim();
  useEffect(() => {
    S.pageTitle = text;
    // The browser tab names the page, and which HaRM it is when it has a name (Settings).
    document.title = [text, S.auth?.site_name || "Zom's HaRM", window.harmDemo ? 'Online demo' : ''].filter(Boolean).join(' · ');
    const cur = S.hist[S.hist.length - 1];
    if (cur && cur.hash === (location.hash || '#/dashboard')) cur.title = text;
  }, [text]);
  return (
    <div className="page-head">
      <div><h1>{title}</h1>{sub ? <div className="sub">{sub}</div> : null}</div>
      <div className="page-actions">{children}</div>
    </div>
  );
}

export function Card({ title, children, actions, cls = '' }: { title: Kid; children?: Kid; actions?: Kid; cls?: string }) {
  return (
    <section className={'card ' + cls}>
      <div className="card-head"><h3>{title}</h3><div className="card-actions">{actions}</div></div>
      {children}
    </section>
  );
}

/* Label and value pairs; pairs without a value are left out. */
export function KV({ pairs }: { pairs: [Kid, Kid][] }) {
  const rows = pairs.filter(([, v]) => v != null && v !== '' && v !== false && !(isValidElement(v) && !nodeText(v)));
  if (!rows.length) return <div className="empty">No details yet.</div>;
  return <dl className="kv">{rows.map(([k, v], i) => [<dt key={'k' + i}>{k}</dt>, <dd key={'v' + i}>{v}</dd>])}</dl>;
}

export interface Col<T> {
  label: Kid;
  get: (r: T) => Kid;
  sort?: (r: T) => unknown;
  cls?: string;
  nosort?: boolean;
}
/* A table whose headings sort it. Rows are clickable with onRow (not on their buttons and links). */
export function Table<T extends Row>({ cols, rows, empty = 'Nothing here yet.', onRow, rowClass }: {
  cols: (Col<T> | null | false)[]; rows: T[]; empty?: Kid; onRow?: (r: T) => void; rowClass?: (r: T) => string;
}) {
  const [sort, setSort] = useState<{ i: number; dir: number }>({ i: -1, dir: 1 });
  const cs = cols.filter(Boolean) as Col<T>[];
  if (!rows.length) return <div className="empty">{empty}</div>;
  let list = rows;
  if (sort.i >= 0 && cs[sort.i]) {
    const c = cs[sort.i];
    const key = c.sort || ((r: T) => nodeText(c.get(r)));
    list = [...rows].sort((a, b) => {
      const x = key(a) ?? '', y = key(b) ?? '';
      return (typeof x === 'number' && typeof y === 'number' ? x - y
        : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' })) * sort.dir;
    });
  }
  const label = (c: Col<T>) => nodeText(c.label);
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>{cs.map((c, i) => (
            <th key={i} className={nz(c.cls, c.nosort ? '' : 'sortable') || undefined}
              onClick={c.nosort ? undefined : () => setSort(s => ({ i, dir: s.i === i ? -s.dir : 1 }))}>{c.label}</th>
          ))}</tr>
        </thead>
        <tbody>
          {list.map((r, ri) => (
            <tr key={r.id ?? ri} className={nz(onRow ? 'click' : '', rowClass ? rowClass(r) : '') || undefined}
              onClick={onRow ? e => { if (!(e.target as Element).closest('button,a,input,select')) onRow(r); } : undefined}>
              {cs.map((c, i) => <td key={i} className={c.cls} data-label={label(c)}>{c.get(r)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* Only one pop-up menu is open at a time. */
const MENU_EVENT = 'harm-menu-open';

export type MenuItem = [Kid, () => void, string?] | null | false;
/* A “⋯” button holding the less-used actions of a page. */
export function MenuButton({ label, items, cls = '', menuCls = '' }: { label: Kid; items: MenuItem[]; cls?: string; menuCls?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const other = (e: Event) => { if ((e as CustomEvent).detail !== id) setOpen(false); };
    const outside = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener(MENU_EVENT, other);
    document.addEventListener('click', outside);
    document.addEventListener('keydown', esc);
    return () => { window.removeEventListener(MENU_EVENT, other); document.removeEventListener('click', outside); document.removeEventListener('keydown', esc); };
  }, [open, id]);
  return (
    <div className="qa pop" ref={wrap}>
      <button type="button" className={cls || undefined} aria-haspopup="menu" aria-label={label === '⋯' ? 'More actions' : undefined}
        onClick={() => { window.dispatchEvent(new CustomEvent(MENU_EVENT, { detail: id })); setOpen(o => !o); }}>{label}</button>
      <div className={'qa-menu pop-menu ' + menuCls} hidden={!open} role="menu">
        {(items.filter(Boolean) as [Kid, () => void, string?][]).map(([l, fn, c], i) => (
          <button key={i} type="button" role="menuitem" className={c || ''} onClick={() => { setOpen(false); fn(); }}>{l}</button>
        ))}
      </div>
    </div>
  );
}
/* A menu opened from any element (the device page's address list). */
export function usePopMenu() {
  const [open, setOpen] = useState(false);
  const id = useId();
  const wrap = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const other = (e: Event) => { if ((e as CustomEvent).detail !== id) setOpen(false); };
    const outside = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener(MENU_EVENT, other);
    document.addEventListener('click', outside);
    return () => { window.removeEventListener(MENU_EVENT, other); document.removeEventListener('click', outside); };
  }, [open, id]);
  const toggle = () => { window.dispatchEvent(new CustomEvent(MENU_EVENT, { detail: id })); setOpen(o => !o); };
  return { open, setOpen, toggle, wrap };
}

export type TabDef = [string, Kid, number | null | undefined, () => Kid];
/* Tabs that remember the last one used per kind of page, so moving between devices keeps your place. */
export function Tabs({ k, defs, want, wantKey = 0 }: { k: string; defs: TabDef[]; want?: string | null; wantKey?: number }) {
  const [cur, setCur] = useState(() => {
    if (want) S.tabs[k] = want;
    if (!S.tabs[k]) S.tabs[k] = prefGet('harm-tab-' + k) || '';
    return S.tabs[k];
  });
  const id = defs.some(d => d[0] === cur) ? cur : defs[0][0];
  const show = (t: string) => { S.tabs[k] = t; prefSet('harm-tab-' + k, t); setCur(t); };
  useEffect(() => { if (want) show(want); }, [want, wantKey]);  // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div>
      <div className="tabs" role="tablist">
        {defs.map(([t, label, count]) => (
          <button key={t} type="button" role="tab" data-tab={t} className={t === id ? 'on' : undefined} onClick={() => show(t)}>
            {label}{count ? <span className="tab-n">{count}</span> : null}
          </button>
        ))}
      </div>
      <div className="tab-body">{defs.find(d => d[0] === id)![3]()}</div>
    </div>
  );
}

/* A filled bar with a number beside it. */
export function Bar({ pct, cls = '', label, n, title, href }: { pct: number; cls?: string; label?: Kid; n?: Kid; title?: string; href?: string }) {
  const inner = <>
    {label != null ? <div className="bar-label">{label}</div> : null}
    <div className="bar"><div className={'bar-fill ' + cls} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} /></div>
    {n != null ? <div className="bar-n">{n}</div> : null}
  </>;
  return href ? <a className="bar-row" href={href} title={title}>{inner}</a> : <div className="bar-row" title={title}>{inner}</div>;
}

/* Secrets show as dots; the eye shows them, and they hide again after 30 seconds (ZomBeatz rule). */
export function EyeButton({ shown, setShown }: { shown: boolean; setShown: (on: boolean) => void }) {
  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setShown(false), 30000);
    return () => clearTimeout(t);
  }, [shown, setShown]);
  return (
    <button type="button" className="icon-btn eye-btn" aria-label={shown ? 'Hide' : 'Show'}
      title={shown ? 'Hide (hides by itself after 30 seconds)' : 'Show'} onClick={() => setShown(!shown)}>
      <Ic name={shown ? 'eye-off' : 'eye'} />
    </button>
  );
}

/* The first child that isn't empty (used where the old code returned '' for "nothing"). */
export const hasKids = (k: Kid) => Children.toArray(k).length > 0;
