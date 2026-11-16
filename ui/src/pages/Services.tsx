/* Services: every web page and port on your devices, as cards or a list. Filter, search, star
 * favorites, sort them into lists, group and size them, and give each card an icon, a color and
 * buttons of its own (open a link, copy something, or run one of your saved actions). How the page
 * looks is kept on each device; favorites, lists and buttons are kept in HaRM for every device. */
import { createElement, useMemo, useState } from 'react';
import { api, GET } from '../api/client';
import { Pending, useLoad } from '../app/router';
import { editEntity } from '../lib/forms';
import { runAction } from '../lib/actions';
import { CertText, ServicePill } from '../lib/status';
import { SERVICE_COLORS, SERVICE_ICONS, serviceIcon } from '../lib/serviceIcons';
import { fmtMs, prefGet, prefSet, timeAgo, type Row } from '../lib/util';
import { copy, modal, toast, type ModalCtl } from '../ui/overlay';
import { A, Btn, Card, MenuButton, PageHead, Small, Table } from '../ui/bits';

export interface CardButton { kind: 'link' | 'copy' | 'action'; label: string; value?: string; action_id?: number }
export interface Svc extends Row {
  id: number; device_id: number; device_name: string; name: string; url: string | null; port: number | null; protocol: string | null;
  version: string | null; notes: string | null; favorite: number; lists: string | null; icon: string | null; color: string | null;
  buttons: CardButton[]; state: string | null; latency_ms: number | null; detail: string | null; checked_at: string | null;
  cert_expires: string | null; location_id: number | null; location_name: string | null; host: string | null;
}
interface Board { services: Svc[]; actions: { id: number; name: string; confirm: number; device_id: number | null }[]; colors: string[] }

type Show = 'address' | 'device' | 'state' | 'speed' | 'version' | 'notes' | 'lists';
interface View {
  mode: 'cards' | 'list'; size: 's' | 'm' | 'l'; group: 'none' | 'device' | 'location' | 'list' | 'state';
  sort: 'name' | 'device' | 'state' | 'speed'; favFirst: boolean; show: Record<Show, boolean>;
}
const DEFAULT_VIEW: View = { mode: 'cards', size: 'm', group: 'none', sort: 'name', favFirst: true,
  show: { address: true, device: true, state: true, speed: false, version: false, notes: false, lists: true } };
const SHOW_LABELS: [Show, string][] = [['state', 'Answering or not'], ['device', 'Device'], ['address', 'Address'], ['speed', 'How fast it answered'],
  ['version', 'Version'], ['lists', 'Lists'], ['notes', 'Notes']];
const KEY = 'harm-services-view';
function loadView(): View {
  try { const v = JSON.parse(prefGet(KEY) || '{}'); return { ...DEFAULT_VIEW, ...v, show: { ...DEFAULT_VIEW.show, ...(v.show || {}) } }; }
  catch { return DEFAULT_VIEW; }
}

export const listsOf = (s: { lists: string | null }) => (s.lists || '').split(',').map(x => x.trim()).filter(Boolean);
export const addressOf = (s: Svc) => s.url || (s.port && s.host ? `${s.host}:${s.port}` : s.host || '');
const isWeb = (u: string | null | undefined) => !!u && /^https?:\/\//i.test(u);
const STATE_ORDER: Record<string, number> = { down: 0, unknown: 1, up: 2 };

/* What a card's own button does; actions keep their own “Ask before running”. */
async function press(b: CardButton, board: Board, after: () => void) {
  if (b.kind === 'copy') return copy(b.value || '', `Copied: ${b.label}`);
  if (b.kind === 'link') {
    const u = b.value || '';
    if (isWeb(u)) window.open(u, '_blank', 'noopener,noreferrer');
    else location.href = u;  // ssh://, smb://, rdp://, vnc:// open the app your computer uses for them
    return;
  }
  const a = board.actions.find(x => x.id === b.action_id);
  if (!a) return toast(`“${b.label}” runs an action that was deleted. Edit the card.`, 'bad');
  await runAction(a, { after });
}

export function ServiceCard({ s, board, view, after }: { s: Svc; board: Board; view: View; after: () => void }) {
  const Icon = serviceIcon(s.icon, s.name);
  const addr = addressOf(s);
  const star = async () => {
    try { await api('PUT', `/services/${s.id}`, { favorite: !s.favorite }); after(); } catch (e) { toast((e as Error).message, 'bad'); }
  };
  const sh = view.show;
  return <div className={`svc-card size-${view.size}${s.state === 'down' ? ' is-down' : ''}`} style={s.color ? { ['--svc' as string]: SERVICE_COLORS[s.color] } : undefined}>
    <div className="svc-top">
      <span className="svc-icon">{createElement(Icon, { size: view.size === 's' ? 18 : 24, 'aria-hidden': true })}</span>
      <div className="svc-title">
        {isWeb(s.url) ? <a className="svc-name" href={s.url!} target="_blank" rel="noopener noreferrer">{s.name}</a> : <b className="svc-name">{s.name}</b>}
        {sh.device && view.size !== 's' ? <div className="muted small"><A href={`#/devices/${s.device_id}?tab=network`}>{s.device_name}</A>{s.location_name ? ` · ${s.location_name}` : ''}</div> : null}
      </div>
      <button type="button" className={`svc-star${s.favorite ? ' on' : ''}`} title={s.favorite ? 'Remove from favorites' : 'Add to favorites'} aria-label={s.favorite ? 'Remove from favorites' : 'Add to favorites'} onClick={star}>{s.favorite ? '★' : '☆'}</button>
    </div>
    {view.size !== 's' ? <div className="svc-body">
      {sh.state ? <div><ServicePill sv={s as never} />{sh.speed && s.latency_ms != null ? <span className="muted small">{` ${fmtMs(s.latency_ms)}`}</span> : null}
        {s.cert_expires && new Date(s.cert_expires).getTime() - Date.now() < 30 * 864e5 ? <> <span className="badge warn">Certificate <CertText date={s.cert_expires} /></span></> : null}</div> : null}
      {sh.address && addr ? <div className="mono small svc-addr" title={addr}>{addr}</div> : null}
      {sh.version && s.version ? <div className="small">{`Version ${s.version}`}</div> : null}
      {sh.lists && listsOf(s).length ? <div className="chips">{listsOf(s).map(l => <span key={l} className="chip small">{l}</span>)}</div> : null}
      {sh.notes && s.notes && view.size === 'l' ? <p className="muted small svc-notes">{s.notes}</p> : null}
    </div> : null}
    <div className="svc-buttons">
      {isWeb(s.url) ? <a className="button sm primary" href={s.url!} target="_blank" rel="noopener noreferrer">Open ↗</a> : null}
      {s.buttons.slice(0, view.size === 's' ? 1 : 8).map((b, i) => <Small key={i} label={`${b.kind === 'action' ? '⚡ ' : b.kind === 'copy' ? '📋 ' : ''}${b.label}`}
        title={b.kind === 'action' ? `Runs the action “${board.actions.find(a => a.id === b.action_id)?.name || '?'}”` : b.value} onClick={() => press(b, board, after)} />)}
      <MenuButton label="⋯" items={[
        ['✎ Edit card…', () => editCard(s, board, after)],
        ['⚙ Edit service…', () => editEntity('services', s, after)],
        addr ? ['📋 Copy address', () => copy(addr, 'Address copied')] : null,
        ['▤ Open device', () => { location.hash = `#/devices/${s.device_id}?tab=network`; }],
      ]} />
    </div>
  </div>;
}

/* ------------------------------------------------------------------ the card editor */

export function editCard(s: Svc, board: Board, after: () => void) {
  modal(`Card: ${s.name}`, (m: ModalCtl) => <CardEditor m={m} s={s} board={board} after={after} />, { wide: true });
}

function CardEditor({ m, s, board, after }: { m: ModalCtl; s: Svc; board: Board; after: () => void }) {
  const [icon, setIcon] = useState(s.icon || '');
  const [color, setColor] = useState(s.color || '');
  const [lists, setLists] = useState(s.lists || '');
  const [fav, setFav] = useState(!!s.favorite);
  const [btns, setBtns] = useState<CardButton[]>(s.buttons.map(b => ({ ...b })));
  const known = useMemo(() => [...new Set(board.services.flatMap(listsOf))].sort(), [board]);
  const mine = (lists || '').split(',').map(x => x.trim()).filter(Boolean);
  const toggleList = (l: string) => setLists((mine.includes(l) ? mine.filter(x => x !== l) : [...mine, l]).join(', '));
  const setB = (i: number, patch: Partial<CardButton>) => setBtns(x => x.map((b, j) => j === i ? { ...b, ...patch } : b));
  const move = (i: number, d: number) => setBtns(x => { const y = [...x]; const [b] = y.splice(i, 1); y.splice(i + d, 0, b); return y; });
  const save = async () => {
    try {
      await api('PUT', `/services/${s.id}`, { icon: icon || null, color: color || null, lists: lists || null, favorite: fav,
        buttons: btns.length ? JSON.stringify(btns.map(b => b.kind === 'action' ? { kind: b.kind, label: b.label, action_id: Number(b.action_id) } : { kind: b.kind, label: b.label, value: b.value })) : null });
      m.close(true); toast('Card saved'); after();
    } catch (e) { toast((e as Error).message, 'bad'); }
  };
  const devActions = [...board.actions].sort((a, b) => Number(b.device_id === s.device_id) - Number(a.device_id === s.device_id) || a.name.localeCompare(b.name));
  return <div className="disc-form card-editor">
    <div className="disc-field"><span>Icon</span><div className="icon-grid">
      <button type="button" className={`icon-pick${!icon ? ' on' : ''}`} title="Guess from the name" onClick={() => setIcon('')}>Auto</button>
      {Object.entries(SERVICE_ICONS).map(([k, [I, label]]) => <button key={k} type="button" className={`icon-pick${icon === k ? ' on' : ''}`} title={label} aria-label={label} onClick={() => setIcon(k)}>{createElement(I, { size: 18, 'aria-hidden': true })}</button>)}
    </div></div>
    <div className="disc-field"><span>Color</span><div className="inline">
      <button type="button" className={`swatch${!color ? ' on' : ''}`} title="None" onClick={() => setColor('')}>✕</button>
      {board.colors.map(c => <button key={c} type="button" className={`swatch${color === c ? ' on' : ''}`} title={c} aria-label={c} style={{ background: SERVICE_COLORS[c] }} onClick={() => setColor(c)} />)}
    </div></div>
    <label className="check inline-check"><input type="checkbox" checked={fav} onChange={e => setFav(e.target.checked)} />Favorite (shown first, and on Home)</label>
    <label className="disc-field"><span>Lists</span><input value={lists} placeholder="Media, Admin pages" onChange={e => setLists(e.target.value)} />
      <small className="muted">Separate with commas. A service can be in several.</small></label>
    {known.length ? <div className="chips">{known.map(l => <button key={l} type="button" className={`chip${mine.includes(l) ? ' on' : ''}`} onClick={() => toggleList(l)}>{l}</button>)}</div> : null}
    <h4>Buttons</h4>
    <p className="muted small">{isWeb(s.url) ? 'The card already has Open ↗ for its address. ' : ''}Add up to 8: open another page or app (ssh://, smb://, rdp://, vnc:// open the app your computer uses), copy something, or run one of your saved <A href="#/actions">actions</A>.</p>
    {btns.map((b, i) => {
      const a = board.actions.find(x => x.id === Number(b.action_id));
      return <div key={i} className="inline wrap card-btn-row">
        <label className="disc-field"><span>Does</span><select value={b.kind} onChange={e => setB(i, { kind: e.target.value as CardButton['kind'] })}>
          <option value="link">Open a link</option><option value="copy">Copy text</option><option value="action">Run an action</option></select></label>
        <label className="disc-field"><span>Name</span><input value={b.label} maxLength={30} placeholder={b.kind === 'action' ? 'Restart' : b.kind === 'copy' ? 'Copy API URL' : 'Settings'} onChange={e => setB(i, { label: e.target.value })} /></label>
        {b.kind === 'action'
          ? <label className="disc-field"><span>Action</span><select value={b.action_id ?? ''} onChange={e => setB(i, { action_id: +e.target.value })}>
            <option value="">Pick one</option>{devActions.map(x => <option key={x.id} value={x.id}>{x.name}{x.device_id === s.device_id ? '' : ' (another device)'}</option>)}</select></label>
          : <label className="disc-field"><span>{b.kind === 'link' ? 'Address' : 'Text'}</span><input className="mono" value={b.value || ''} placeholder={b.kind === 'link' ? 'https://… or ssh://user@host' : ''} onChange={e => setB(i, { value: e.target.value })} /></label>}
        <Small label="↑" title="Move up" disabled={!i} onClick={() => move(i, -1)} />
        <Small label="↓" title="Move down" disabled={i === btns.length - 1} onClick={() => move(i, 1)} />
        <Small label="🗑" title="Remove" onClick={() => setBtns(x => x.filter((_, j) => j !== i))} />
        {b.kind === 'action' && a && !a.confirm ? <p className="warn-text small">{`“${a.name}” runs without asking. For anything that restarts or shuts down, tick Ask before running on the action.`}</p> : null}
      </div>;
    })}
    {btns.length < 8 ? <p><Small label="+ Add a button" onClick={() => setBtns(x => [...x, { kind: 'link', label: '', value: '' }])} /></p> : null}
    <div className="actions"><Btn label="Cancel" onClick={() => m.close(true)} /><Btn label="Save" cls="primary" onClick={save} /></div>
  </div>;
}

/* ------------------------------------------------------------------ layout */

function LayoutMenu({ view, set }: { view: View; set: (v: View) => void }) {
  return <div className="disc-form">
    <label className="disc-field"><span>Card size</span><select value={view.size} onChange={e => set({ ...view, size: e.target.value as View['size'] })}>
      <option value="s">Small (name and one button)</option><option value="m">Medium</option><option value="l">Large (with notes)</option></select></label>
    <label className="disc-field"><span>Group by</span><select value={view.group} onChange={e => set({ ...view, group: e.target.value as View['group'] })}>
      <option value="none">Nothing</option><option value="device">Device</option><option value="location">Place</option><option value="list">List</option><option value="state">Answering or not</option></select></label>
    <label className="disc-field"><span>Sort by</span><select value={view.sort} onChange={e => set({ ...view, sort: e.target.value as View['sort'] })}>
      <option value="name">Name</option><option value="device">Device</option><option value="state">Not answering first</option><option value="speed">Fastest first</option></select></label>
    <label className="check inline-check"><input type="checkbox" checked={view.favFirst} onChange={e => set({ ...view, favFirst: e.target.checked })} />Favorites first</label>
    <div className="disc-field"><span>Show</span>{SHOW_LABELS.map(([k, l]) => <label key={k} className="check inline-check">
      <input type="checkbox" checked={view.show[k]} onChange={e => set({ ...view, show: { ...view.show, [k]: e.target.checked } })} />{l}</label>)}</div>
    <p><Small label="Back to how it was at first" onClick={() => set(DEFAULT_VIEW)} /></p>
  </div>;
}

export default function Services() {
  const q = useLoad(() => GET<Board>('/services/board'));
  const [view, setViewState] = useState<View>(loadView);
  const [find, setFind] = useState('');
  const [state, setState] = useState(() => prefGet('harm-services-state') || 'all');
  const [list, setList] = useState(() => prefGet('harm-services-list') || '');
  const [favOnly, setFavOnly] = useState(() => prefGet('harm-services-fav') === '1');
  const setView = (v: View) => { setViewState(v); prefSet(KEY, JSON.stringify(v)); };
  const pick = (k: string, v: string, fn: (x: string) => void) => { fn(v); prefSet(k, v); };
  if (!q.data) return <Pending q={q} />;
  const board = q.data;
  const after = () => q.reload();
  const all = board.services;
  const lists = [...new Set(all.flatMap(listsOf))].sort();
  const words = find.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = all.filter(s => (state === 'all' || (s.state || 'unknown') === state)
    && (!list || listsOf(s).includes(list)) && (!favOnly || s.favorite)
    && words.every(w => [s.name, s.device_name, s.url, s.host, s.lists, s.notes, s.location_name, s.version].some(x => (x || '').toLowerCase().includes(w))));
  const cmp: Record<View['sort'], (a: Svc, b: Svc) => number> = {
    name: (a, b) => a.name.localeCompare(b.name), device: (a, b) => a.device_name.localeCompare(b.device_name) || a.name.localeCompare(b.name),
    state: (a, b) => (STATE_ORDER[a.state || 'unknown'] - STATE_ORDER[b.state || 'unknown']) || a.name.localeCompare(b.name),
    speed: (a, b) => (a.latency_ms ?? 1e9) - (b.latency_ms ?? 1e9),
  };
  shown.sort((a, b) => (view.favFirst ? b.favorite - a.favorite : 0) || cmp[view.sort](a, b));
  const groupOf = (s: Svc): string[] => view.group === 'device' ? [s.device_name] : view.group === 'location' ? [s.location_name || 'No place']
    : view.group === 'list' ? (listsOf(s).length ? listsOf(s) : ['In no list']) : view.group === 'state' ? [{ up: 'Answering', down: 'Not answering' }[s.state || ''] || 'Not checked'] : [''];
  const groups = new Map<string, Svc[]>();
  for (const s of shown) for (const g of groupOf(s)) groups.set(g, [...(groups.get(g) || []), s]);
  const down = all.filter(s => s.state === 'down').length;
  const body = (rows: Svc[]) => view.mode === 'cards'
    ? <div className={`svc-grid size-${view.size}`}>{rows.map(s => <ServiceCard key={s.id} s={s} board={board} view={view} after={after} />)}</div>
    : <div className="table-wrap"><Table rows={rows as unknown as Row[]} cols={[
      { label: '', nosort: true, get: s => <button type="button" className={`svc-star${s.favorite ? ' on' : ''}`} aria-label="Favorite" onClick={async () => { await api('PUT', `/services/${s.id}`, { favorite: !s.favorite }); after(); }}>{s.favorite ? '★' : '☆'}</button> },
      { label: 'Service', get: s => <span>{isWeb(s.url) ? <a href={s.url} target="_blank" rel="noopener noreferrer"><b>{s.name}</b></a> : <b>{s.name}</b>}
        {view.show.lists && listsOf(s as Svc).length ? <span className="muted small">{` ${listsOf(s as Svc).join(', ')}`}</span> : null}</span>, sort: s => s.name },
      ...(view.show.device ? [{ label: 'Device', get: (s: Row) => <A href={`#/devices/${s.device_id}?tab=network`}>{s.device_name}</A>, sort: (s: Row) => s.device_name }] : []),
      ...(view.show.address ? [{ label: 'Address', get: (s: Row) => <span className="mono small">{addressOf(s as Svc)}</span> }] : []),
      ...(view.show.state ? [{ label: 'State', get: (s: Row) => <span><ServicePill sv={s as never} />{view.show.speed && s.latency_ms != null ? <span className="muted small">{` ${fmtMs(s.latency_ms)}`}</span> : null}</span>, sort: (s: Row) => STATE_ORDER[s.state || 'unknown'] }] : []),
      ...(view.show.version ? [{ label: 'Version', get: (s: Row) => s.version || '' }] : []),
      { label: '', nosort: true, get: s => <div className="row-actions">
        {(s.buttons as CardButton[]).slice(0, 3).map((b, i) => <Small key={i} label={`${b.kind === 'action' ? '⚡ ' : ''}${b.label}`} onClick={() => press(b, board, after)} />)}
        <MenuButton label="⋯" items={[['✎ Edit card…', () => editCard(s as Svc, board, after)], ['⚙ Edit service…', () => editEntity('services', s, after)]]} /></div> },
    ]} /></div>;
  return <>
    <PageHead title="Services" sub={`${all.length} on your devices${down ? ` · ${down} not answering` : ''}`}>
      <div className="seg" role="group" aria-label="Show as">
        <button type="button" className={view.mode === 'cards' ? 'on' : ''} onClick={() => setView({ ...view, mode: 'cards' })}>⊞ Cards</button>
        <button type="button" className={view.mode === 'list' ? 'on' : ''} onClick={() => setView({ ...view, mode: 'list' })}>☰ List</button>
      </div>
      <MenuButton label="⚙ Layout" items={[['Card size, grouping, sorting and what’s shown…', () => modal('Layout', () => <LayoutLive view={view} set={setView} />)]]} />
      <Btn label="+ New" cls="primary" onClick={() => editEntity('services', {}, after)} />
    </PageHead>
    <div className="toolbar">
      <input type="search" placeholder="Filter…" aria-label="Filter services" value={find} onChange={e => setFind(e.target.value)} />
      <select aria-label="Answering" value={state} onChange={e => pick('harm-services-state', e.target.value, setState)}>
        <option value="all">All</option><option value="up">Answering</option><option value="down">Not answering</option><option value="unknown">Not checked</option></select>
      <button type="button" className={`chip${favOnly ? ' on' : ''}`} onClick={() => { setFavOnly(!favOnly); prefSet('harm-services-fav', favOnly ? '0' : '1'); }}>★ Favorites</button>
      {lists.map(l => <button key={l} type="button" className={`chip${list === l ? ' on' : ''}`} onClick={() => pick('harm-services-list', list === l ? '' : l, setList)}>{l}</button>)}
    </div>
    {!all.length ? <Card title="No services yet"><p>Services are the web pages and ports on your devices: Proxmox’s page, Plex, a NAS, SSH. Add them on a device’s <b>Network</b> tab, with <b>+ New</b> here, or let <A href="#/discover">Discover</A> find them. Each one is checked to see if it answers.</p></Card>
      : !shown.length ? <p className="muted">Nothing matches. <Small label="Clear filters" onClick={() => { setFind(''); pick('harm-services-state', 'all', setState); pick('harm-services-list', '', setList); setFavOnly(false); prefSet('harm-services-fav', '0'); }} /></p>
      : [...groups.entries()].map(([g, rows]) => g ? <section key={g} className="svc-group"><h3 className="svc-group-title">{`${g} · ${rows.length}`}</h3>{body(rows)}</section> : <div key="all">{body(rows)}</div>)}
    <p className="muted small">{`Checked with the online checks${all.some(s => s.checked_at) ? `, last ${timeAgo(all.map(s => s.checked_at || '').sort().pop())}` : ''}. Favorites, lists and buttons are kept in HaRM; the layout is kept on this device.`}</p>
  </>;
}

/* The layout dialog keeps its own copy, so changes show at once. */
function LayoutLive({ view, set }: { view: View; set: (v: View) => void }) {
  const [v, setV] = useState(view);
  return <LayoutMenu view={v} set={x => { setV(x); set(x); }} />;
}

/* Favorite services on Home, as small cards. */
export function FavoriteServices() {
  const q = useLoad(() => GET<Board>('/services/board'));
  const favs = (q.data?.services || []).filter(s => s.favorite);
  if (!q.data || !favs.length) return null;
  const view = { ...loadView(), size: 'm' as const };
  return <Card title="Favorite services" actions={<A href="#/services">All services</A>}>
    <div className="svc-grid size-m">{favs.slice(0, 12).map(s => <ServiceCard key={s.id} s={s} board={q.data!} view={view} after={() => q.reload()} />)}</div>
  </Card>;
}

