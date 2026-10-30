'use strict';
/* Zom's HaRM: Hardware and Rack Manager (frontend).
 * No framework, no build step. All DOM is built with h(), which only ever
 * sets textContent / attributes, so stored data can never inject markup. */

const S = {
  auth: null, authed: false, enums: {},
  lk: { locations: [], racks: [], devices: [], services: [], networks: [], clusters: [] }, caps: {}, hist: [],
  filters: { devices: {}, components: { tab: 'spares' }, vault: {} }, wiz: { step: (() => { try { return +localStorage.getItem('harm-wiz-step') || 0; } catch { return 0; } })() },
  lastActivity: Date.now(), lastPing: Date.now(),
};
const LOOKUPS = ['locations', 'racks', 'devices', 'services', 'networks', 'clusters'];
const LABELS = {
  locations: 'Location', racks: 'Holder', devices: 'Device', device_slots: 'Slot / bay',
  components: 'Component', interfaces: 'Interface', services: 'Service',
  credentials: 'Credential', connections: 'Connection', networks: 'Network', clusters: 'Cluster', builds: 'Build', build_items: 'Build part',
};

// ---------------------------------------------------------------- DOM helpers

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  let value;
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') value = v;
    else if (k === 'checked') el.checked = true;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, kids);
  if (value !== undefined) el.value = value;
  return el;
}
function append(el, kids) {
  const plain = NO_ICONS.has(el.tagName);
  for (const k of [kids].flat(Infinity)) {
    if (k == null || k === false) continue;
    if (k instanceof Node) { el.append(k); continue; }
    const text = String(k);
    if (plain || !ICON_RX.test(text)) { el.append(document.createTextNode(text)); continue; }
    // Interface symbols (📷 ⚙ ▤ …) are drawn as Lucide icons, per the ZomBeatz design system.
    for (const part of text.split(ICON_SPLIT)) {
      if (!part) continue;
      const name = ICON_FOR[part];
      if (name === '') continue;
      el.append(name ? ic(name) : document.createTextNode(part));
    }
  }
  return el;
}

/* Lucide icon as an inline SVG (CSP-safe: built from data, never from HTML strings). */
function ic(name, cls = '') {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2,
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: `ic ${cls}`.trim() })) svg.setAttribute(k, v);
  for (const [tag, attrs] of (typeof LUCIDE !== 'undefined' && LUCIDE[name]) || []) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.append(el);
  }
  return svg;
}
const ICON_FOR = {
  '◧': 'house', '☑': 'list-checks', '▤': 'monitor', '⧉': 'layers', '▥': 'server', '◫': 'package', '⚒': 'hammer',
  '⌗': 'network', '⌖': 'radar', '🔑': 'key-round', '⌂': 'map-pin', '⇄': 'cable', '▦': 'library', '⇪': 'share-2',
  '📜': 'scroll-text', '⚙': 'settings', '❓': 'circle-help', '☰': 'menu', '📷': 'camera', '📸': 'camera', '🤖': 'bot',
  '⬇': 'download', '⇩': 'download', '⤓': 'download', '🗑': 'trash-2', '📝': 'notebook-pen', '🖥': 'monitor', '📱': 'smartphone',
  '📋': 'clipboard', '🏷': 'tag', '↗': 'external-link', '🔌': 'plug', '📌': 'pin', '🌐': 'globe', '❄': 'snowflake',
  '🔳': 'qr-code', '🔧': 'wrench', '🛠': 'wrench', '🔒': 'lock', '✎': 'pencil', '⚑': 'flag', '★': 'star', '☆': 'star',
  '▾': 'chevron-down', '▸': 'chevron-right', '🧭': 'compass', '🛡': 'shield', '🖨': 'printer', '📍': 'map-pin',
  '💾': 'hard-drive', '🎥': 'video', '🌙': 'moon', '☀': 'sun', '◐': 'sun-moon', '⟳': 'rotate-cw', '🧩': 'boxes',
  '⚠': 'triangle-alert', '▶': 'play', '■': 'square', '⎘': 'copy', '💬': 'message-square', '⌨': 'keyboard', '🎉': '',
};
const NO_ICONS = new Set(['OPTION', 'TEXTAREA', 'TITLE', 'STYLE', 'SCRIPT', 'CODE', 'PRE']);
const ICON_KEYS = Object.keys(ICON_FOR).filter(k => k.length <= 2).sort((a, b) => b.length - a.length);
const ICON_SPLIT = new RegExp(`(${ICON_KEYS.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\uFE0F?`, 'u');
const ICON_RX = new RegExp(ICON_SPLIT.source, 'u');
const view = () => document.getElementById('view');
/* replaceChildren that, like h(), flattens arrays and skips null/false. */
const fillEl = (el, ...kids) => { el.replaceChildren(); return append(el, kids); };
/* Paint the main view, unless the user has already navigated elsewhere while this
 * page was loading (a slow response must not overwrite a newer page). */
const render = (...kids) => {
  if (S.routeHash !== undefined && location.hash !== S.routeHash) return;
  const v = view();
  v.replaceChildren();
  append(v, kids);
};
const esc = s => String(s ?? '');
const nz = (...xs) => xs.filter(x => x != null && x !== '').join(' ');

function toast(msg, kind = 'ok', action = null) {
  const t = h('div', { class: `toast ${kind}` }, h('span', null, msg),
    action ? h('button', { type: 'button', class: 'sm toast-action', onclick: () => { t.remove(); action.onClick(); } }, action.label) : null);
  document.getElementById('toasts').append(t);
  const life = action ? 7000 : 2600;
  setTimeout(() => t.classList.add('out'), life);
  setTimeout(() => t.remove(), life + 500);
}

/* Dialog. `beforeClose` (async → bool) can veto a close that the user started
 * with ✕, Escape or a backdrop click; close(true) always closes. */
function modal(title, body, { wide = false, beforeClose = null, headExtra = null, cls = '' } = {}) {
  const back = h('div', { class: 'modal-back' });
  const isTop = () => [...document.querySelectorAll('.modal-back')].pop() === back;
  let closing = false;
  const close = async (force = false) => {
    if (closing || !back.isConnected) return;
    if (!force && beforeClose) {
      closing = true;
      const ok = await beforeClose();
      closing = false;
      if (!ok) return;
    }
    back.remove();
    document.removeEventListener('keydown', onKey);
    if (!document.querySelector('.modal-back')) { document.body.classList.remove('modal-open'); document.documentElement.classList.remove('modal-open'); }
    if (onClose) onClose();
  };
  let onClose = null;
  const onKey = e => { if (e.key === 'Escape' && isTop()) { e.preventDefault(); close(); } };
  const box = h('div', { class: `modal ${wide ? 'wide' : ''} ${cls}`, role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'modal-head' },
      h('h2', null, title),
      h('div', { class: 'modal-head-actions' }, headExtra,
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => close() }, '✕'))),
    h('div', { class: 'modal-body' }, body));
  back.append(box);
  // Only a press that starts AND ends on the backdrop counts (not a text selection drag).
  let downOnBack = false;
  back.addEventListener('mousedown', e => { downOnBack = e.target === back; });
  back.addEventListener('click', e => { if (downOnBack && e.target === back && isTop()) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(back);
  document.body.classList.add('modal-open');  // the page behind must not scroll
  document.documentElement.classList.add('modal-open');
  if (window.matchMedia('(min-width: 861px)').matches) {
    setTimeout(() => box.querySelector('.modal-body input:not([type=checkbox]):not([type=file]), .modal-body select, .modal-body textarea, .modal-body button.primary')?.focus(), 0);
  }
  return { close, box, set onClose(fn) { onClose = fn; } };
}

/* Ask the user to pick one of several buttons. Resolves to the chosen key (or null). */
function choose(title, message, buttons) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; m.close(true); resolve(v); } };
    const m = modal(title, h('div', null, h('p', null, message),
      h('div', { class: 'actions' }, buttons.map(([key, label, cls]) =>
        h('button', { type: 'button', class: cls || '', onclick: () => finish(key) }, label)))),
      { beforeClose: async () => { finish(null); return true; } });
  });
}

async function confirmBox(msg, okLabel = 'Delete') {
  return (await choose('Are you sure?', msg, [['no', 'Cancel'], ['yes', okLabel, 'danger']])) === 'yes';
}

async function copy(text, what = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(`${what} to clipboard`); }
  catch { toast('Clipboard unavailable (needs HTTPS or localhost)', 'bad'); }
}

function badge(status) {
  return status ? h('span', { class: `badge ${badgeClass(status)}` }, status) : '';
}
const dot = on => h('span', { class: 'dot ' + (on ? 'on' : 'off'), title: on ? 'Hooked up' : 'Not hooked up' });
const link = (href, text) => h('a', { href }, text);
const extLink = (url, text) => {
  if (!url) return '';
  const safe = /^https?:\/\//i.test(url) ? url : null;
  return safe ? h('a', { href: safe, target: '_blank', rel: 'noopener noreferrer' }, text || url) : url;
};
const money = v => v == null ? '' : Number(v).toLocaleString(undefined, { style: 'currency', currency: 'USD' });
const today = () => new Date().toISOString().slice(0, 10);
function warrantyCell(d) {
  if (!d) return '';
  const cls = d < today() ? 'bad-text' : (d <= new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10) ? 'warn-text' : '');
  return h('span', { class: cls }, d);
}
function btn(label, onclick, cls = '') { return h('button', { type: 'button', class: cls, onclick }, label); }
function small(label, onclick, cls = '') { return btn(label, onclick, 'sm ' + cls); }

function pageHead(title, sub, ...actions) {
  S.pageTitle = typeof title === 'string' ? title : (title.firstChild?.textContent || title.textContent || '').trim();
  return h('div', { class: 'page-head' },
    h('div', null, h('h1', null, title), sub ? h('div', { class: 'sub' }, sub) : null),
    h('div', { class: 'page-actions' }, actions));
}
function card(title, body, ...actions) {
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', null, title), h('div', { class: 'card-actions' }, actions)),
    body);
}
function kv(pairs) {
  const rows = pairs.filter(([, v]) => v != null && v !== '' && !(v instanceof Node && !v.textContent));
  if (!rows.length) return h('div', { class: 'empty' }, 'No details yet.');
  return h('dl', { class: 'kv' }, rows.map(([k, v]) => [h('dt', null, k), h('dd', null, v)]));
}

function table(cols, rows, { empty = 'Nothing here yet.', onRow, rowClass } = {}) {
  if (!rows.length) return h('div', { class: 'empty' }, empty);
  let sortIdx = -1, dir = 1;
  const tbody = h('tbody');
  const keyOf = c => c.sort || (r => { const v = c.get(r); return v instanceof Node ? v.textContent : v; });
  const sorted = () => {
    if (sortIdx < 0) return rows;
    const key = keyOf(cols[sortIdx]);
    return [...rows].sort((a, b) => {
      const x = key(a) ?? '', y = key(b) ?? '';
      return (typeof x === 'number' && typeof y === 'number' ? x - y
        : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' })) * dir;
    });
  };
  const draw = () => tbody.replaceChildren(...sorted().map(r =>
    h('tr', {
      class: nz(onRow ? 'click' : '', rowClass ? rowClass(r) : '') || null,
      onclick: onRow ? e => { if (!e.target.closest('button,a,input,select')) onRow(r); } : null,
    }, cols.map(c => h('td', { class: c.cls, 'data-label': c.label }, c.get(r))))));
  const thead = h('thead', null, h('tr', null, cols.map((c, i) => h('th', {
    class: nz(c.cls, c.nosort ? '' : 'sortable'),
    onclick: c.nosort ? null : () => { dir = sortIdx === i ? -dir : 1; sortIdx = i; draw(); },
  }, c.label))));
  draw();
  return h('div', { class: 'table-wrap' }, h('table', null, thead, tbody));
}

// ---------------------------------------------------------------- API

/* A failed request on HTTPS is usually the certificate (not trusted on this device, or changed
   after a restart), not a dead server, so say what to try. */
const UNREACHABLE = () => location.protocol === 'https:'
  ? 'Cannot reach the HaRM server. If it’s running, this device may not trust HaRM’s certificate (or the certificate changed after a restart): open HaRM in the browser once, or install the certificate with Phone setup in the HaRM desktop app.'
  : 'Cannot reach the HaRM server. Check that it’s running and that this device is on the same network.';

async function api(method, path, body) {
  const opt = { method, credentials: 'same-origin', headers: { 'X-HaRM': '1' } };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  let r;
  try { r = await fetch('/api' + path, opt); }
  catch { throw new Error(UNREACHABLE()); }
  S.lastPing = Date.now();
  let data = null;
  try { data = await r.json(); } catch { /* empty body */ }
  if (r.status === 401 && !path.startsWith('/auth/')) {
    showAuth('Your session ended. Please unlock again.');
    throw new Error('Session expired');
  }
  if (!r.ok) {
    const d = data && data.detail;
    throw new Error(typeof d === 'string' ? d : (d ? JSON.stringify(d) : r.statusText));
  }
  return data;
}
const GET = p => api('GET', p);
// The online demo (web-demo/) answers /api/ inside the browser, so it fetches downloads itself.
const openDownload = url => { if (window.harmDemo) window.harmDemo.download(url); else location.href = url; };

async function loadLookups() {
  const res = await Promise.all(LOOKUPS.map(e => GET('/' + e)));
  LOOKUPS.forEach((e, i) => { S.lk[e] = res[i]; });
}

function locPath(id) {
  const parts = [];
  let cur = S.lk.locations.find(l => l.id === id), guard = 0;
  while (cur && guard++ < 25) {
    parts.unshift(cur.name);
    cur = S.lk.locations.find(l => l.id === cur.parent_id);
  }
  return parts.join(' > ');
}
function lkLabel(entity, r) {
  if (entity === 'racks') return `${r.name} (${nz(r.kind, r.location_name ? '· ' + r.location_name : '')})`;
  if (entity === 'locations') return locPath(r.id);
  if (entity === 'services') return `${r.name} (${r.device_name})`;
  if (entity === 'devices') return r.name + (r.device_type ? ` (${r.device_type})` : '');
  if (entity === 'networks') return r.name + (r.vlan_id ? ` · VLAN ${r.vlan_id}` : '') + (r.cidr ? ` · ${r.cidr}` : '');
  return r.name;
}

// ---------------------------------------------------------------- forms

const opts = list => list.map(o => typeof o === 'string' ? { value: o, label: o } : o);

function genPassword(len = 24) {
  const cs = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+?';
  const limit = Math.floor(2 ** 32 / cs.length) * cs.length;
  const buf = new Uint32Array(1), out = [];
  while (out.length < len) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) out.push(cs[buf[0] % cs.length]);
  }
  return out.join('');
}

/* Location `id` plus every location nested inside it. */
function locDescendants(id) {
  const out = new Set([Number(id)]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const l of S.lk.locations) {
      if (l.parent_id && out.has(l.parent_id) && !out.has(l.id)) { out.add(l.id); grew = true; }
    }
  }
  return out;
}
const rackById = id => S.lk.racks.find(r => String(r.id) === String(id));
const rackHasUnits = id => !!(id && rackById(id)?.height_u);
const rackInLocation = (r, v) => !v.location_id || locDescendants(v.location_id).has(r.location_id);
/* Picking a holder moves the location to the holder's room. */
const VIRTUAL_TYPES = ['Virtual Machine', 'Container'];
const isVirtual = v => VIRTUAL_TYPES.includes(v.device_type) || !!v.host_id;

function rackPicked(input, form) {
  const r = rackById(input.value);
  if (r && r.location_id && form.get('location_id') !== String(r.location_id)) form.set({ location_id: r.location_id });
}

/* Draft autosave so a closed dialog, idle lock or phone tab reload never loses typing.
 * Secrets are never written to drafts. */
const DRAFT_PREFIX = 'harm-draft:';
const DRAFT_TTL = 7 * 864e5;
function loadDraft(key) {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_PREFIX + key) || 'null');
    if (!d || Date.now() - d.at > DRAFT_TTL) return null;
    return d.values;
  } catch { return null; }
}
function saveDraft(key, values) {
  try { localStorage.setItem(DRAFT_PREFIX + key, JSON.stringify({ at: Date.now(), values })); } catch { /* storage unavailable */ }
}
function clearDraft(key) {
  try { localStorage.removeItem(DRAFT_PREFIX + key); } catch { /* storage unavailable */ }
}

/* Field spec keys:
 *   k, label, type (text|number|date|textarea|checkbox|select|fk|password), required, default,
 *   options (select), entity/filter/none (fk), list (datalist), ph, help, wide, raw, min, step,
 *   scan: true        → camera button that fills this field
 *   showIf(vals)      → only show when true; clearWhenHidden → submit null while hidden
 *   scopeBy: [keys] + scope(row, vals) → fk options filtered by other fields
 *   onChange(input, form) */
const splitTokens = v => String(v || '').split(/\s*\/\s*/).map(x => x.trim()).filter(Boolean);
/* "SAS/SATA" chips: tapping toggles each connection in or out of the list. */
function toggleToken(value, token) {
  const t = splitTokens(value);
  const i = t.indexOf(token);
  if (i >= 0) t.splice(i, 1); else t.push(token);
  return t.join('/');
}

function buildForm(fields, rec = {}) {
  const inputs = {};
  const order = [];
  const grid = h('div', { class: 'form-grid' });
  const sections = [];

  const raw = () => Object.fromEntries(order.map(k => {
    const { f, input } = inputs[k];
    return [k, f.type === 'checkbox' ? input.checked : input.value];
  }));

  function fillSelect(input, f, keep) {
    let list;
    if (f.type === 'fk') {
      let rows = S.lk[f.entity] || [];
      if (f.filter) rows = rows.filter(f.filter);
      if (f.scope) { const v = raw(); rows = rows.filter(r => f.scope(r, v)); }
      list = rows.map(r => ({ value: String(r.id), label: lkLabel(f.entity, r) })).sort((a, b) => a.label.localeCompare(b.label));
      if (keep != null && keep !== '' && !list.some(o => o.value === String(keep))) {
        const r = (S.lk[f.entity] || []).find(x => String(x.id) === String(keep));
        if (r) list.unshift({ value: String(r.id), label: lkLabel(f.entity, r) });
      }
    } else {
      list = opts(f.options || []);
    }
    input.replaceChildren(...[
      f.required && f.type !== 'fk' ? null : h('option', { value: '' }, f.none || 'None'),
      ...list.map(o => h('option', { value: o.value }, o.label)),
    ].filter(Boolean));
    input.value = keep == null ? '' : String(keep);
    if (input.value !== String(keep ?? '')) input.value = '';
  }

  for (const f of fields) {
    if (f.section) {
      const el = h('div', { class: 'form-section' + (f.adv ? ' adv' : '') }, f.section);
      sections.push({ el, f });
      grid.append(el);
      continue;
    }
    const id = `f_${f.k}_${Math.random().toString(36).slice(2, 7)}`;
    const v = rec[f.k] ?? f.default;
    let input, control;
    if (f.type === 'hidden') {
      input = h('input', { type: 'hidden', value: v ?? '' });
      const wrap = h('div', { class: 'field', hidden: true }, input);
      inputs[f.k] = { f: { ...f, clearWhenHidden: false }, input, wrap };
      order.push(f.k);
      grid.append(wrap);
      continue;
    }
    if (f.type === 'textarea') {
      input = h('textarea', { id, rows: f.rows || 3, value: v ?? '', placeholder: f.ph });
    } else if (f.type === 'checkbox') {
      input = h('input', { id, type: 'checkbox', checked: !!v });
    } else if (f.type === 'select' || f.type === 'fk') {
      input = h('select', { id });
      inputs[f.k] = { f, input };  // so raw() sees earlier fields while scoping
      order.push(f.k);
      fillSelect(input, f, v);
      order.pop();
    } else if (f.type === 'password') {
      input = h('input', { id, type: 'password', value: v ?? '', autocomplete: 'new-password', spellcheck: 'false' });
      control = h('div', { class: 'pw-row' }, input,
        eyeButton(on => { input.type = on ? 'text' : 'password'; }),
        small('Generate', () => { input.value = genPassword(); input.type = 'text'; input.dispatchEvent(new Event('input', { bubbles: true })); }));
    } else {
      input = h('input', {
        id, type: f.type || 'text', value: v ?? '', placeholder: f.ph, step: f.step, min: f.min,
        list: f.list ? 'dl_' + f.list : null, autocomplete: 'off', spellcheck: f.type ? null : 'false',
        inputmode: f.type === 'number' ? 'decimal' : f.inputmode,
        autocapitalize: f.scan ? 'characters' : null,
      });
    }
    if (f.required) input.required = true;
    if (f.scan) {
      control = h('div', { class: 'scan-row' }, control || input,
        h('button', { type: 'button', class: 'scan-btn', title: `Scan ${f.label}`, 'aria-label': `Scan ${f.label}`,
          onclick: () => scanInto(input, f.label) }, '📷'));
    }
    const chipBox = f.chips ? h('div', { class: 'chips field-chips' }) : null;
    const body = f.type === 'checkbox'
      ? h('label', { class: 'check', for: id }, input, h('span', null, f.label))
      : [h('label', { for: id }, f.label + (f.required ? ' *' : '')), control || input];
    const wrap = h('div', { class: 'field' + (f.wide ? ' wide' : '') + (f.type === 'checkbox' ? ' is-check' : '') + (f.adv ? ' adv' : ''), 'data-k': f.k },
      body, chipBox, f.help ? h('small', null, f.help) : null);
    inputs[f.k] = { f, input, wrap, chipBox };
    order.push(f.k);
    grid.append(wrap);
  }

  const form = {
    el: grid, inputs, fields,
    get: k => inputs[k] ? (inputs[k].f.type === 'checkbox' ? inputs[k].input.checked : inputs[k].input.value) : undefined,
    /* Set values in field order, firing change so scoping and autosave follow. */
    set(values) {
      for (const k of order) {
        if (!(k in values)) continue;
        const { f, input } = inputs[k];
        const v = values[k];
        if (f.type === 'checkbox') input.checked = !!v;
        else if (input.tagName === 'SELECT') {
          input.value = v == null ? '' : String(v);
          if (input.value !== String(v ?? '') && f.type === 'fk') fillSelect(input, f, v);
        } else input.value = v ?? '';
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    },
    values() {
      const out = {};
      for (const k of order) {
        const { f, input, wrap } = inputs[k];
        if (f.virtual) continue;
        if (wrap.hidden && f.clearWhenHidden) { out[k] = f.type === 'checkbox' ? false : null; continue; }
        if (f.type === 'checkbox') out[k] = input.checked;
        else if (f.type === 'password' || f.raw) out[k] = input.value;
        else out[k] = input.value.trim() === '' ? null : input.value;
      }
      return out;
    },
    draftValues() {
      const v = form.values();
      for (const k of order) {
        const f = inputs[k].f;
        if (f.type === 'password' || f.secret) delete v[k];
      }
      return v;
    },
    refresh(changed) {
      const v = raw();
      for (const k of order) {
        const { f, input } = inputs[k];
        if (f.scope && changed && (f.scopeBy || []).includes(changed)) {
          const cur = input.value;
          fillSelect(input, f, null);
          if ([...input.options].some(o => o.value === cur)) input.value = cur;
          else if (cur) input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      for (const k of order) { const { f, wrap } = inputs[k]; if (f.showIf) wrap.hidden = !f.showIf(v); }
      for (const s of sections) if (s.f.showIf) s.el.hidden = !s.f.showIf(v);
      for (const k of order) {
        const { f, input, chipBox } = inputs[k];
        if (!chipBox) continue;
        const list = typeof f.chips === 'function' ? f.chips(v) : f.chips;
        chipBox.replaceChildren(...(list || []).map(c => h('button', {
          type: 'button', class: 'chip' + ((f.chipMulti ? splitTokens(input.value).includes(c) : input.value === c) ? ' on' : ''),
          onclick: () => { input.value = f.chipMulti ? toggleToken(input.value, c) : f.chipAppend && input.value.trim() && !input.value.includes(c) ? `${input.value.trim()}, ${c}` : c; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); },
        }, c)));
        chipBox.hidden = !list || !list.length;
      }
    },
    /* Highlight the field a server error is about. */
    flag(message) {
      grid.querySelectorAll('.field.invalid').forEach(w => w.classList.remove('invalid'));
      const m = /(?:for |^)([a-z_]+)(?: is required|:)/.exec(message || '') || /field: ([a-z_]+)/.exec(message || '');
      const hit = m && inputs[m[1]];
      if (!hit) return false;
      grid.classList.add('show-adv');
      hit.wrap.classList.add('invalid');
      hit.wrap.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return true;
    },
  };
  // "More details": advanced fields stay out of the way until wanted (shown if any already has a value).
  const advKeys = order.filter(k => inputs[k].f.adv);
  if (advKeys.length) {
    const filled = advKeys.some(k => { const x = rec[inputs[k].f.k]; return x != null && x !== '' && x !== false && inputs[k].f.type !== 'hidden'; });
    const toggle = h('button', { type: 'button', class: 'more-toggle wide' });
    const setOpen = open => { grid.classList.toggle('show-adv', open); toggle.textContent = open ? '▾ Fewer details' : '▸ More details (optional)'; };
    toggle.addEventListener('click', () => setOpen(!grid.classList.contains('show-adv')));
    const firstAdv = grid.querySelector('.adv');
    grid.insertBefore(toggle, firstAdv);
    setOpen(filled);
  }
  for (const k of order) {
    const { f, input } = inputs[k];
    input.addEventListener('change', () => { if (f.onChange) f.onChange(input, form); form.refresh(k); });
  }
  form.refresh(null);
  return form;
}

function formDialog({ title, fields, rec = {}, submit, onDone, extra, saveLabel = 'Save', wide, draftKey, again, scanTargets, headButtons, notice, preset }) {
  const form = buildForm(fields, rec);
  const err = h('div', { class: 'form-error', role: 'alert' });
  const save = h('button', { class: 'primary', type: 'submit', name: 'save' }, saveLabel);
  const againBtn = again ? h('button', { type: 'submit', name: 'again' }, again.label || 'Save & add another') : null;
  const original = form.values();
  const initial = JSON.stringify(original);
  const dirty = () => JSON.stringify(form.values()) !== initial;
  let busy = false, m;

  const doSubmit = async andAgain => {
    if (busy) return false;
    if (!el.reportValidity()) return false;
    busy = true;
    err.textContent = '';
    save.disabled = true;
    if (againBtn) againBtn.disabled = true;
    try {
      const vals = form.values();
      const res = await submit(vals, form);
      if (draftKey) clearDraft(draftKey);
      m.close(true);
      if (onDone) await onDone(res, { again: andAgain, vals });
      return true;
    } catch (x) {
      err.textContent = '⚠ ' + x.message;
      if (!form.flag(x.message)) err.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      toast(`Not saved: ${x.message}`, 'bad');
      return false;
    } finally {
      busy = false;
      save.disabled = false;
      if (againBtn) againBtn.disabled = false;
    }
  };

  let banner = null;
  const el = h('form', {
    novalidate: false,
    onsubmit: e => { e.preventDefault(); doSubmit(e.submitter?.name === 'again'); },
    onkeydown: e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doSubmit(false); } },
  },
  notice ? h('div', { class: 'saved-banner' }, notice) : null,
  form.el, extra,
  h('div', { class: 'actions sticky-actions' }, err,
    h('button', { type: 'button', onclick: () => m.close() }, 'Cancel'), againBtn, save));

  let draft = draftKey ? loadDraft(draftKey) : null;
  // What the form was opened with (e.g. "this device", "this rack") always wins over an old draft.
  if (draft && preset) for (const k of Object.keys(preset)) delete draft[k];
  if (draft && JSON.stringify({ ...form.draftValues(), ...draft }) !== JSON.stringify(form.draftValues())) {
    form.set(draft);
    banner = h('div', { class: 'draft-banner' },
      h('span', null, '↩ Restored changes you hadn’t saved.'),
      small('Discard them', () => { form.set(original); clearDraft(draftKey); banner.remove(); }));
    el.prepend(banner);
  }

  if (draftKey) {
    let t = null;
    const persist = () => { clearTimeout(t); t = setTimeout(() => { if (dirty()) saveDraft(draftKey, form.draftValues()); else clearDraft(draftKey); }, 300); };
    el.addEventListener('input', persist);
    el.addEventListener('change', persist);
  }

  const scanBtn = scanTargets && scanTargets.some(k => form.inputs[k])
    ? h('button', { type: 'button', class: 'sm scan-label-btn', onclick: () => scanLabel(form, scanTargets) }, '📷 Scan label')
    : null;

  m = modal(title, el, {
    wide: wide ?? fields.length > 9,
    headExtra: [headButtons ? headButtons(form) : null, scanBtn],
    beforeClose: async () => {
      if (!dirty()) { if (draftKey) clearDraft(draftKey); return true; }
      const c = await choose('Unsaved changes', 'You changed this form. Save before closing?', [
        ['keep', 'Keep editing'], ['discard', 'Discard changes', 'ghost-danger'], ['save', 'Save', 'primary']]);
      if (c === 'save') { doSubmit(false); return false; }
      if (c === 'discard') { if (draftKey) clearDraft(draftKey); return true; }
      return false;
    },
  });
  return { m, form };
}

/* Tap-to-fill choices for parts, by category. */
const HDD_SIZES = ['1 TB', '2 TB', '3 TB', '4 TB', '6 TB', '8 TB', '10 TB', '12 TB', '14 TB', '16 TB', '18 TB', '20 TB', '22 TB', '24 TB'];
const SSD_SIZES = ['120 GB', '240 GB', '256 GB', '480 GB', '500 GB', '512 GB', '960 GB', '1 TB', '1.92 TB', '2 TB', '3.84 TB', '4 TB', '8 TB'];
const DRIVE_MAKERS = ['Seagate', 'Western Digital', 'Toshiba', 'HGST', 'Samsung', 'Crucial', 'Intel', 'Micron'];
const PART_CHIPS = {
  'HDD': { sizes: HDD_SIZES, iface: ['SATA', 'SAS'], ff: ['3.5"', '2.5"'], makers: DRIVE_MAKERS, speeds: ['5400 RPM', '7200 RPM', '10K RPM', '15K RPM'] },
  'SSD': { sizes: SSD_SIZES, iface: ['SATA', 'SAS', 'U.2'], ff: ['2.5"', 'M.2 2280'], makers: DRIVE_MAKERS },
  'NVMe SSD': { sizes: ['256 GB', '512 GB', '1 TB', '2 TB', '4 TB', '8 TB'], iface: ['NVMe M.2 (M-key)', 'U.2'], ff: ['M.2 2280', 'M.2 2242', 'M.2 22110', 'U.2 2.5"'], makers: DRIVE_MAKERS },
  'USB / Flash': { sizes: ['16 GB', '32 GB', '64 GB', '128 GB', '256 GB', '512 GB', '1 TB', '2 TB', '4 TB'], iface: ['USB-A', 'USB-C'] },
  'RAM': { sizes: ['2 GB', '4 GB', '8 GB', '16 GB', '32 GB', '64 GB', '128 GB'], iface: ['DDR3 DIMM', 'DDR3 RDIMM', 'DDR4 DIMM', 'DDR4 RDIMM', 'DDR5 DIMM', 'DDR5 RDIMM', 'DDR4 SODIMM', 'DDR5 SODIMM'], ff: ['DIMM', 'SODIMM'], makers: ['Samsung', 'SK hynix', 'Micron', 'Kingston', 'Crucial', 'Corsair', 'G.Skill'], speeds: ['1333 MT/s', '1600 MT/s', '2133 MT/s', '2400 MT/s', '2666 MT/s', '3200 MT/s', '4800 MT/s', '5600 MT/s', '6000 MT/s'] },
  'CPU': { iface: ['AM4', 'AM5', 'LGA1151', 'LGA1200', 'LGA1700', 'LGA1851', 'LGA2011-3', 'LGA3647', 'LGA4189', 'SP3', 'SP5', 'C32 / G34'], makers: ['Intel', 'AMD'] },
  'GPU': { sizes: ['4 GB', '8 GB', '12 GB', '16 GB', '24 GB', '32 GB'], iface: ['PCIe x16'], ff: ['Full height', 'Low profile'], makers: ['NVIDIA', 'AMD', 'Intel', 'ASUS', 'MSI', 'Gigabyte', 'EVGA'] },
  'NIC': { iface: ['PCIe x4', 'PCIe x8', 'PCIe x16', 'PCIe x1', 'OCP 2.0', 'OCP 3.0', 'Mezzanine'], ff: ['Full height', 'Low profile'], makers: ['Intel', 'Mellanox', 'Broadcom', 'Chelsio', 'Solarflare'], speeds: ['1GbE', '2.5GbE', '10GbE', '25GbE', '40GbE', '100GbE'] },
  'HBA / RAID Card': { iface: ['PCIe x8', 'PCIe x4', 'PCIe x16', 'Mezzanine'], ff: ['Full height', 'Low profile'], makers: ['LSI / Broadcom', 'Dell PERC', 'HPE Smart Array', 'Adaptec'], speeds: ['6Gb/s', '12Gb/s'] },
  'PSU': { sizes: ['450 W', '550 W', '650 W', '750 W', '850 W', '1000 W', '1100 W', '1400 W'], iface: ['Hot-swap (server)', 'ATX', 'SFX'], ff: ['Redundant PSU', 'ATX', 'SFX', 'Flex ATX'] },
  'Transceiver (SFP)': { iface: ['SFP', 'SFP+', 'SFP28', 'QSFP+', 'QSFP28'], speeds: ['1G', '10G', '25G', '40G', '100G'], ff: ['SR (multimode)', 'LR (single-mode)', 'RJ45 copper'] },
  'Cable': { iface: ['Cat6', 'Cat6a', 'DAC', 'AOC', 'Fiber OM3', 'Fiber OM4', 'Fiber OS2', 'SFF-8087', 'SFF-8643', 'SFF-8088', 'C13/C14', 'C19/C20'], ff: ['0.5 m', '1 m', '2 m', '3 m', '5 m'] },
  'Motherboard': { iface: ['AM4', 'AM5', 'LGA1700', 'LGA1851', 'LGA2011-3', 'LGA3647', 'SP3'], ff: ['ATX', 'Micro ATX', 'Mini-ITX', 'EATX', 'SSI EEB', 'Proprietary'] },
};
const SLOT_KINDS = {
  'Drive bays': { iface: ['SAS', 'SATA', 'U.2 (NVMe)'], ff: ['3.5"', '2.5"'], counts: ['2', '4', '6', '8', '12', '24'] },
  'Memory slots': { iface: ['DDR3 DIMM', 'DDR3 RDIMM', 'DDR4 DIMM', 'DDR4 RDIMM', 'DDR5 DIMM', 'DDR5 RDIMM', 'DDR4 SODIMM', 'DDR5 SODIMM'], ff: ['DIMM', 'SODIMM'], counts: ['2', '4', '8', '12', '16', '24'] },
  'M.2 slots': { iface: ['NVMe M.2 (M-key)', 'M.2 SATA (B+M key)'], ff: ['M.2 2280', 'M.2 2242', 'M.2 22110'], counts: ['1', '2', '3', '4'] },
  'PCIe slots': { iface: ['PCIe x16', 'PCIe x8', 'PCIe x4', 'PCIe x1', 'OCP 3.0', 'Mezzanine'], ff: ['Full height', 'Low profile'], counts: ['1', '2', '3', '4', '6'] },
  'CPU sockets': { iface: ['AM4', 'AM5', 'LGA1151', 'LGA1200', 'LGA1700', 'LGA2011-3', 'LGA3647', 'SP3', 'C32 / G34'], counts: ['1', '2', '4'] },
  'Power supply bays': { iface: ['Hot-swap (server)', 'ATX', 'SFX'], counts: ['1', '2'] },
  'Network ports (SFP)': { iface: ['SFP', 'SFP+', 'SFP28', 'QSFP+', 'QSFP28'], counts: ['2', '4', '8', '24', '48'] },
  'Other': { iface: [], ff: [] },
};
function slotKindOf(iface) {
  const k = String(iface || '').toLowerCase();
  if (!k) return 'Drive bays';
  if (/ddr|dimm/.test(k)) return 'Memory slots';
  if (/m\.?2/.test(k)) return 'M.2 slots';
  if (/pcie|ocp|mezz/.test(k)) return 'PCIe slots';
  if (/sfp/.test(k)) return 'Network ports (SFP)';
  if (/lga|am\d|sp\d|socket|c32|g34/.test(k)) return 'CPU sockets';
  if (/hot-swap|atx|sfx|psu/.test(k)) return 'Power supply bays';
  if (/sas|sata|u\.2|raid|bay|drive/.test(k)) return 'Drive bays';
  return 'Other';
}

const FORMS = {
  locations: rec => [
    { k: 'name', label: 'Name', required: true, ph: 'Basement lab' },
    { k: 'kind', label: 'Kind', list: 'location_kinds' },
    { k: 'parent_id', label: 'Inside of', type: 'fk', entity: 'locations', none: 'Top level',
      filter: l => !rec.id || !locDescendants(rec.id).has(l.id) },
    { k: 'address', label: 'Address / description' },
    { k: 'notes', label: 'Notes', type: 'textarea', wide: true },
  ],
  racks: () => [
    { k: 'name', label: 'Name', required: true, ph: 'Rack A · Wire shelf 2 · Pile by the door' },
    { k: 'kind', label: 'Kind', list: 'rack_kinds', default: 'Rack', help: 'Use Pile, Floor or Tote for loose stacks of gear.' },
    { k: 'location_id', label: 'Location', type: 'fk', entity: 'locations' },
    { k: 'height_u', label: 'Height (U)', type: 'number', min: 1, help: 'Only for racks/cabinets. Leave blank for shelves, bins and piles.' },
    { k: 'numbering_desc', label: 'Number U1 from the top', type: 'checkbox', showIf: v => !!v.height_u },
    { k: 'width', label: 'Width', ph: '19"' },
    { k: 'depth_mm', label: 'Depth (mm)', type: 'number', min: 0 },
    { k: 'manufacturer', label: 'Manufacturer' },
    { k: 'model', label: 'Model' },
    { k: 'notes', label: 'Notes', type: 'textarea', wide: true },
  ],
  devices: () => [
    { k: 'name', label: 'Name', required: true, ph: 'pve-01, R515 #1, NAS' },
    { k: 'device_type', label: 'Type', list: 'device_types', chips: ['Server', 'Hypervisor Host', 'Virtual Machine', 'Container', 'NAS', 'Switch', 'Router', 'Desktop', 'Laptop', 'Phone', 'Tablet'] },
    { k: 'status', label: 'Status', type: 'select', options: S.enums.device_statuses, required: true, default: 'Active' },
    { k: 'connected', label: 'Hooked up (cabled & powered)', type: 'checkbox' },
    { k: 'manufacturer', label: 'Manufacturer', chips: ['Dell', 'HPE', 'Supermicro', 'Lenovo', 'Cisco', 'Ubiquiti', 'Synology', 'Custom'] },
    { k: 'model', label: 'Model', scan: true, ph: 'PowerEdge R515' },
    { k: 'serial', label: 'Serial number / service tag', scan: true, wide: true, help: 'Dell’s service tag, HPE’s serial, etc.: whatever identifies this exact unit.', showIf: v => !isVirtual(v) },
    { k: 'host_id', label: 'Runs on (host)', type: 'fk', entity: 'devices', none: 'Not set', showIf: isVirtual,
      help: 'The physical machine (hypervisor) this VM or container runs on.' },
    { k: 'vm_id', label: 'VM / container ID', ph: '100', showIf: isVirtual },
    { k: 'vcpus', label: 'vCPUs', type: 'number', min: 0, showIf: isVirtual, chips: ['1', '2', '4', '8', '16'] },
    { k: 'vm_ram_gb', label: 'Memory (GB)', type: 'number', step: '0.5', min: 0, showIf: isVirtual, chips: ['1', '2', '4', '8', '16', '32'] },
    { k: 'vm_disk_gb', label: 'Disk (GB)', type: 'number', step: '1', min: 0, showIf: isVirtual, chips: ['32', '64', '128', '256', '500'] },
    { k: 'cluster_id', label: 'Cluster', type: 'fk', entity: 'clusters', none: 'Not in a cluster', adv: true,
      help: 'For hypervisor hosts and nodes: which cluster they belong to.' },
    { section: 'Where it lives' },
    { k: 'location_id', label: 'Location (room)', type: 'fk', entity: 'locations' },
    { k: 'rack_id', label: 'Rack / holder', type: 'fk', entity: 'racks', none: 'None (loose in the room)',
      scopeBy: ['location_id'], scope: rackInLocation, onChange: rackPicked, showIf: v => !isVirtual(v), clearWhenHidden: true,
      help: 'Only holders in the chosen location are listed.' },
    { k: 'rack_u', label: 'Lowest rack unit (U)', type: 'number', min: 1, showIf: v => rackHasUnits(v.rack_id), clearWhenHidden: true },
    { k: 'u_height', label: 'Height (U)', type: 'number', min: 1, default: 1, showIf: v => rackHasUnits(v.rack_id), chips: ['1', '2', '3', '4', '5'] },
    { k: 'rack_face', label: 'Mounted on', type: 'select', options: [{ value: 'front', label: 'Front' }, { value: 'rear', label: 'Rear' }], required: true, default: 'front', showIf: v => rackHasUnits(v.rack_id) },
    { k: 'full_depth', label: 'Full depth (blocks both faces)', type: 'checkbox', default: true, showIf: v => rackHasUnits(v.rack_id) },
    { k: 'position', label: 'Spot', ph: 'Top shelf left · pile by the door · under the desk', wide: true },
    { section: 'System', adv: true },
    { k: 'hostname', label: 'Hostname / FQDN', adv: true },
    { k: 'os', label: 'OS / firmware', ph: 'Proxmox VE 9.1', adv: true },
    { k: 'cpu', label: 'CPU', adv: true },
    { k: 'ram', label: 'RAM', ph: '128 GB DDR4 ECC', adv: true },
    { k: 'psu', label: 'Power supply', ph: '2x 750W redundant', adv: true },
    { k: 'power_draw_w', label: 'Typical draw (W)', type: 'number', min: 0, adv: true },
    { k: 'mgmt_url', label: 'Management URL (iDRAC, iLO, web UI)', ph: 'https://10.0.0.5', inputmode: 'url', adv: true, wide: true },
    { section: 'Tracking', adv: true },
    { k: 'asset_tag', label: 'Asset tag (your own label)', adv: true, help: 'Only if you stick your own inventory labels on things.' },
    { k: 'tags', label: 'Tags', ph: 'prod, homelab, k8s', adv: true },
    { k: 'purchase_date', label: 'Purchased', type: 'date', adv: true },
    { k: 'purchase_price', label: 'Price', type: 'number', step: '0.01', min: 0, adv: true },
    { k: 'msrp', label: 'Original price (new)', type: 'number', step: '0.01', min: 0, adv: true },
    { k: 'market_value', label: 'Current value', type: 'number', step: '0.01', min: 0, adv: true },
    { k: 'value_checked', label: 'Value checked on', type: 'date', adv: true },
    { k: 'vendor', label: 'Vendor', adv: true },
    { k: 'warranty_until', label: 'Warranty until', type: 'date', adv: true },
  ],
  device_slots: rec => {
    const guess = slotKindOf(rec.interface);
    return [
      { k: 'device_id', label: 'Device', type: 'fk', entity: 'devices', required: true },
      { k: '_kind', label: 'What kind of slot?', type: 'select', virtual: true, required: true, default: guess,
        options: Object.keys(SLOT_KINDS) },
      { k: 'label', label: 'Name this group', ph: 'Front bays, Rear 2.5" bays, CPU 1 DIMMs…', wide: true,
        chips: v => v._kind === 'Drive bays' ? ['Front bays', 'Rear bays', 'Internal', 'Flex bay', 'Boot drives'] : v._kind === 'Memory slots' ? ['CPU 1 slots', 'CPU 2 slots'] : [] },
      { k: 'interface', label: 'Accepts', required: true, wide: true, chipMulti: true,
        chips: v => SLOT_KINDS[v._kind]?.iface || [],
        help: 'Drive bays: tap every connection it takes (most server bays take SAS and SATA).' },
      { k: 'array_name', label: 'RAID / controller', wide: true, showIf: v => v._kind === 'Drive bays',
        chips: ['RAID 1', 'RAID 5', 'RAID 6', 'RAID 10', 'HBA / IT mode (passthrough)', 'ZFS pool', 'Onboard SATA', 'Not set up'], ph: 'PERC H700 · RAID 6',
        help: 'Which array or controller this group of bays belongs to. Two RAIDs? Make two groups.' },
      { k: 'first_index', label: 'Numbering starts at', type: 'number', min: 0, default: 0, chips: ['0', '1'], help: 'Dell numbers bays from 0, HPE from 1.' },
      { k: 'form_factor', label: 'Size / form factor', wide: true, chips: v => SLOT_KINDS[v._kind]?.ff || [] },
      { k: 'total', label: 'How many', type: 'number', min: 1, default: 1, chips: v => SLOT_KINDS[v._kind]?.counts || ['1', '2', '4', '8', '12'] },
      { k: 'notes', label: 'Notes', ph: 'Hot-swap, front', chips: ['Hot-swap', 'Front', 'Rear', 'Internal'], chipAppend: true },
    ];
  },
  components: () => [
    { k: 'category', label: 'What is it?', list: 'component_categories', required: true, wide: true,
      chips: ['HDD', 'SSD', 'NVMe SSD', 'RAM', 'CPU', 'GPU', 'NIC', 'HBA / RAID Card', 'PSU', 'Transceiver (SFP)', 'Cable'] },
    { k: 'manufacturer', label: 'Manufacturer', chips: v => PART_CHIPS[v.category]?.makers || [] },
    { k: 'model', label: 'Model', scan: true },
    { k: 'capacity', label: 'Size', ph: 'Tap a size or type one', wide: true,
      chips: v => PART_CHIPS[v.category]?.sizes || [], showIf: v => !PART_CHIPS[v.category] || !!PART_CHIPS[v.category].sizes || !v.category },
    { k: 'interface', label: 'Connection', wide: true, chips: v => PART_CHIPS[v.category]?.iface || [],
      help: 'How it plugs in. Used to match spare parts to free slots. (RAID isn’t a connection; that’s set up on the controller.)' },
    { k: 'form_factor', label: 'Form factor', chips: v => PART_CHIPS[v.category]?.ff || [] },
    { k: 'quantity', label: 'How many', type: 'number', min: 0, default: 1, chips: ['1', '2', '4', '6', '8', '12'] },
    { k: 'serial', label: 'Serial number', scan: true, showIf: v => !v.quantity || +v.quantity <= 1, help: 'For several identical parts, put serials in Notes.' },
    { k: 'catalog_id', type: 'hidden' },
    { section: 'Where it is' },
    { k: 'device_id', label: 'Installed in device', type: 'fk', entity: 'devices', none: 'Not installed (spare)',
      onChange: (input, form) => { const st = form.get('status'); if (input.value && st === 'In Stock') form.set({ status: 'Installed' }); else if (!input.value && st === 'Installed') form.set({ status: 'In Stock' }); } },
    { k: 'status', label: 'Status', type: 'select', options: S.enums.component_statuses, required: true, default: 'In Stock' },
    { k: 'location_id', label: 'Location (room)', type: 'fk', entity: 'locations', showIf: v => !v.device_id },
    { k: 'rack_id', label: 'Stored in (holder)', type: 'fk', entity: 'racks', none: 'None (loose in the room)',
      scopeBy: ['location_id'], scope: rackInLocation, onChange: rackPicked, showIf: v => !v.device_id, clearWhenHidden: true },
    { k: 'position', label: 'Spot', ph: 'Bin 4, anti-static bag', showIf: v => !v.device_id, clearWhenHidden: true },
    { section: 'Details', adv: true },
    { k: 'part_number', label: 'Part number', scan: true, adv: true },
    { k: 'speed', label: 'Speed / rating', ph: '7200 RPM, 3200 MT/s, 10GbE', adv: true, chips: v => PART_CHIPS[v.category]?.speeds || [] },
    { k: 'condition', label: 'Condition', list: 'component_conditions', adv: true, chips: ['New', 'Used - Good', 'Used - Fair', 'Faulty'] },
    { k: 'health', label: 'Health', ph: 'SMART OK, 21k hours', adv: true },
    { k: 'purchase_date', label: 'Purchased', type: 'date', adv: true },
    { k: 'purchase_price', label: 'Price (each)', type: 'number', step: '0.01', min: 0, adv: true },
    { k: 'msrp', label: 'Original price (new, each)', type: 'number', step: '0.01', min: 0, adv: true },
    { k: 'market_value', label: 'Current value (each)', type: 'number', step: '0.01', min: 0, adv: true },
    { k: 'value_checked', label: 'Value checked on', type: 'date', adv: true },
    { k: 'vendor', label: 'Vendor', adv: true },
    { k: 'warranty_until', label: 'Warranty until', type: 'date', adv: true },
    { k: 'tags', label: 'Tags', wide: true, adv: true },
    { k: 'notes', label: 'Notes', type: 'textarea', wide: true, adv: true },
  ],
  clusters: () => [
    { k: 'name', label: 'Name', required: true, ph: 'pve-cluster, k3s-home' },
    { k: 'kind', label: 'Kind', list: 'cluster_kinds', chips: ['Proxmox VE', 'Kubernetes', 'VMware vSphere', 'Docker Swarm', 'Ceph'] },
    { k: 'location_id', label: 'Location', type: 'fk', entity: 'locations' },
    { k: 'notes', label: 'Notes', type: 'textarea', wide: true, ph: 'Quorum, shared storage, HA groups…' },
  ],
  networks: () => [
    { section: 'Network' },
    { k: 'name', label: 'Name', required: true, ph: 'Servers, IoT, Management' },
    { k: 'kind', label: 'Purpose', list: 'network_kinds' },
    { k: 'vlan_id', label: 'VLAN ID', type: 'number', min: 1, ph: '10' },
    { k: 'cidr', label: 'Subnet (CIDR)', ph: '10.0.10.0/24', inputmode: 'decimal' },
    { k: 'gateway', label: 'Gateway', ph: '10.0.10.1', inputmode: 'decimal' },
    { k: 'location_id', label: 'Site / location', type: 'fk', entity: 'locations' },
    { section: 'DHCP & DNS' },
    { k: 'dhcp_start', label: 'DHCP pool start', ph: '10.0.10.100', inputmode: 'decimal' },
    { k: 'dhcp_end', label: 'DHCP pool end', ph: '10.0.10.199', inputmode: 'decimal' },
    { k: 'dns_servers', label: 'DNS servers', ph: '10.0.10.1, 1.1.1.1' },
    { k: 'domain', label: 'Search domain', ph: 'lab.home.arpa' },
    { k: 'ipv6_prefix', label: 'IPv6 prefix', ph: 'fd00:10::/64' },
    { k: 'ssid', label: 'Wi-Fi SSID (if wireless)' },
    { k: 'notes', label: 'Notes', type: 'textarea', wide: true, ph: 'Firewall rules, what lives here, ISP details…' },
  ],
  interfaces: () => {
    const trunk = v => /trunk|hybrid/i.test(v.port_mode || '');
    return [
      { section: 'Interface' },
      { k: 'device_id', label: 'Device', type: 'fk', entity: 'devices', required: true },
      { k: 'name', label: 'Name', ph: 'eno1, mgmt, port 24, wlan0' },
      { k: 'is_primary', label: 'Main address for this device', type: 'checkbox',
        help: 'Used for quick links, logins and lists. Leave off for iDRAC / iLO / management ports.' },
      { k: 'kind', label: 'Kind', list: 'net_kinds' },
      { k: 'link_state', label: 'Link state', type: 'select', options: S.enums.link_states },
      { k: 'mac', label: 'MAC address', scan: true, ph: 'AA:BB:CC:DD:EE:FF' },
      { k: 'speed', label: 'Speed', ph: '1G, 2.5G, 10G' },
      { k: 'mtu', label: 'MTU', type: 'number', min: 68, ph: '1500 / 9000' },
      { k: 'poe', label: 'PoE', list: 'poe_options' },
      { k: 'parent', label: 'Member of / parent', ph: 'bond0, vmbr0, eth0' },
      { k: 'wifi_ssid', label: 'Wi-Fi SSID', showIf: v => /wi-?fi|wlan|wireless/i.test(v.kind || '') },
      { section: 'Addressing' },
      { k: 'assignment', label: 'Assignment', type: 'select', options: S.enums.ip_assignments },
      { k: 'network_id', label: 'Network', type: 'fk', entity: 'networks', none: 'Detect from IP' },
      { k: 'ip', label: 'IPv4 address', ph: '10.0.10.5 or 10.0.10.5/24', inputmode: 'decimal' },
      { k: 'subnet', label: 'Subnet / prefix', ph: '/24' },
      { k: 'gateway', label: 'Gateway', inputmode: 'decimal' },
      { k: 'ipv6', label: 'IPv6 address', ph: 'fd00:10::5/64' },
      { k: 'dns_servers', label: 'DNS servers', ph: '10.0.10.1' },
      { k: 'dns_name', label: 'DNS name', ph: 'nas.lab.home.arpa' },
      { section: 'VLANs & switching' },
      { k: 'port_mode', label: 'Port mode', type: 'select', options: S.enums.port_modes },
      { k: 'vlan', label: 'Access VLAN', ph: '10', showIf: v => !trunk(v) },
      { k: 'native_vlan', label: 'Native / untagged VLAN', showIf: trunk },
      { k: 'tagged_vlans', label: 'Tagged VLANs', ph: '10, 20, 30-40', showIf: trunk },
      { k: 'notes', label: 'Notes', wide: true },
    ];
  },
  builds: () => [
    { k: 'name', label: 'Name', required: true, ph: 'Gaming rig 2026, NAS from spares' },
    { k: 'purpose', label: 'Purpose', list: 'build_purposes' },
    { k: 'status', label: 'Status', type: 'select', options: S.enums.build_statuses, required: true, default: 'Planning' },
    { k: 'budget', label: 'Budget', type: 'number', step: '0.01', min: 0 },
    { k: 'device_id', label: 'Linked device (for upgrades / once built)', type: 'fk', entity: 'devices', none: 'None', wide: true },
    { k: 'notes', label: 'Notes', type: 'textarea', wide: true },
  ],
  services: () => [
    { k: 'device_id', label: 'Device', type: 'fk', entity: 'devices', required: true },
    { k: 'name', label: 'Service', required: true, ph: 'Proxmox UI, Plex, SSH' },
    { k: 'protocol', label: 'Protocol', list: 'protocols' },
    { k: 'port', label: 'Port', type: 'number', min: 0 },
    { k: 'url', label: 'URL', ph: 'https://…', wide: true, inputmode: 'url' },
    { k: 'version', label: 'Version' },
    { k: 'status', label: 'Status', list: 'service_statuses' },
    { k: 'notes', label: 'Notes', type: 'textarea', wide: true },
  ],
  credentials: () => [
    { k: 'label', label: 'Label', required: true, ph: 'iDRAC root, pfSense admin' },
    { k: 'kind', label: 'Kind', list: 'credential_kinds' },
    { k: 'username', label: 'Username', raw: true },
    { k: 'password', label: 'Password / secret', type: 'password', wide: true },
    { k: 'url', label: 'URL / host', wide: true, inputmode: 'url' },
    { k: 'device_id', label: 'Device', type: 'fk', entity: 'devices' },
    { k: 'service_id', label: 'Service', type: 'fk', entity: 'services' },
    { k: 'totp_secret', label: '2FA / TOTP secret (base32 or otpauth://)', type: 'password', wide: true },
    { k: 'last_rotated', label: 'Last rotated', type: 'date' },
    { k: 'secret_notes', label: 'Secret notes (encrypted): recovery codes, keys…', type: 'textarea', raw: true, secret: true, wide: true, rows: 4 },
  ],
  connections: () => [
    { k: 'a_device_id', label: 'From device', type: 'fk', entity: 'devices', required: true },
    { k: 'a_port', label: 'From port', ph: 'eth0, port 12, SFP+ 1' },
    { k: 'b_device_id', label: 'To device', type: 'fk', entity: 'devices', none: 'Untracked endpoint' },
    { k: 'b_port', label: 'To port', showIf: v => !!v.b_device_id },
    { k: 'b_endpoint', label: 'Untracked endpoint', ph: 'ISP modem, wall jack 3B', wide: true, showIf: v => !v.b_device_id, clearWhenHidden: true },
    { k: 'medium', label: 'Medium / cable', list: 'mediums' },
    { k: 'speed', label: 'Link speed' },
    { k: 'cable_label', label: 'Cable label', scan: true },
    { k: 'length', label: 'Length', ph: '1 m' },
    { k: 'color', label: 'Color' },
    { k: 'notes', label: 'Notes', wide: true },
  ],
};

/* Fields carried into the next form by "Save & add another". */
const STICKY = {
  devices: ['device_type', 'status', 'location_id', 'rack_id', 'manufacturer', 'connected', 'vendor', 'purchase_date'],
  components: ['category', 'status', 'device_id', 'condition', 'location_id', 'rack_id', 'position', 'manufacturer', 'model',
    'part_number', 'capacity', 'interface', 'form_factor', 'speed', 'vendor', 'purchase_date', 'purchase_price', 'warranty_until'],
  interfaces: ['device_id', 'kind', 'network_id', 'assignment', 'port_mode', 'speed'],
  locations: ['parent_id', 'kind'],
  racks: ['location_id', 'kind', 'height_u'],
  networks: ['location_id', 'kind'],
  services: ['device_id', 'protocol'],
  connections: ['a_device_id', 'medium', 'speed', 'color'],
  device_slots: ['device_id'],
  credentials: ['device_id', 'kind'],
};
/* Fields a label scan can fill. */
const SCAN_TARGETS = {
  devices: ['serial', 'model', 'manufacturer', 'asset_tag'],
  components: ['serial', 'part_number', 'model', 'manufacturer', 'capacity'],
  interfaces: ['mac', 'name'],
};

function editEntity(entity, rec, after, { autoScan = false, notice = null } = {}) {
  rec = rec || {};
  const isNew = !rec.id;
  // Drafts for new records are kept per context, so a half-typed part for one device
  // never shows up (or gets saved) when adding a part to a different device.
  const ctx = isNew ? Object.keys(rec).filter(k => k.endsWith('_id') && rec[k] != null).sort().map(k => `${k}=${rec[k]}`).join('&') : '';
  const dlg = formDialog({
    title: (isNew ? 'Add ' : 'Edit ') + LABELS[entity].toLowerCase(),
    fields: FORMS[entity](rec),
    rec,
    notice,
    preset: isNew ? rec : null,
    draftKey: `${entity}:${rec.id || 'new'}${ctx ? ':' + ctx : ''}`,
    again: isNew && STICKY[entity] ? { label: 'Save & add another' } : null,
    scanTargets: SCAN_TARGETS[entity],
    headButtons: entity === 'components' ? form => h('button', { type: 'button', class: 'sm', onclick: () => libraryLookup(form) }, '▦ Find in library') : null,
    submit: async vals => {
      const r = isNew ? await api('POST', `/${entity}`, vals) : await api('PUT', `/${entity}/${rec.id}`, vals);
      if (LOOKUPS.includes(entity)) await loadLookups();
      return r;
    },
    onDone: async (r, { again, vals }) => {
      const label = r && (r.name || r.label || [r.manufacturer, r.model, r.capacity].filter(Boolean).join(' ') || r.category || r.ip);
      if (again) {
        const next = {};
        for (const k of STICKY[entity]) if (vals[k] != null && vals[k] !== '') next[k] = vals[k];
        rerender();
        editEntity(entity, next, after, { autoScan, notice: `✓ Saved “${label || LABELS[entity]}”. Fill in the next one, or Cancel when you’re done.` });
      } else {
        const msg = `${isNew ? 'Added' : 'Saved'} ${label ? `“${label}”` : ''}`;
        await (after || rerender)(r);
        await new Promise(res => setTimeout(res, 0));  // let any navigation settle
        const prev = S.hist[S.hist.length - 2];
        if (prev && prev.hash !== location.hash) toast(msg, 'ok', { label: `← Back to ${prev.title || 'previous page'}`, onClick: () => history.back() });
        else toast(msg);
      }
    },
  });
  if (autoScan) scanLabel(dlg.form, SCAN_TARGETS[entity] || []);
  return dlg;
}

async function editCredential(rec, after) {
  if (rec && rec.id) {
    const sec = await api('POST', `/credentials/${rec.id}/reveal`);
    rec = { ...rec, password: sec.password, totp_secret: sec.totp_secret, secret_notes: sec.secret_notes };
  }
  editEntity('credentials', rec, after);
}

async function deleteEntity(entity, rec, after, warn = '') {
  const name = rec.name || rec.label || rec.model || rec.interface || rec.a_port || rec.ip || `#${rec.id}`;
  if (!await confirmBox(`Delete ${LABELS[entity].toLowerCase()} "${name}"? ${warn}`)) return;
  try {
    await api('DELETE', `/${entity}/${rec.id}`);
    toast('Deleted');
    if (LOOKUPS.includes(entity)) await loadLookups();
    (after || rerender)();
  } catch (e) { toast(e.message, 'bad'); }
}

function rowActions(entity, r, after) {
  return h('div', { class: 'row-actions' },
    small('Edit', () => entity === 'credentials' ? editCredential(r, after) : editEntity(entity, r, after)),
    small('Delete', () => deleteEntity(entity, r, after), 'ghost-danger'));
}

// ---------------------------------------------------------------- scanning (barcodes + label text)

let zxingLoading = null;
function loadZXing() {
  if (window.ZXing) return Promise.resolve(window.ZXing);
  zxingLoading = zxingLoading || new Promise((resolve, reject) => {
    const s = h('script', { src: '/static/vendor/zxing-0.23.0.min.js' });
    s.onload = () => resolve(window.ZXing);
    s.onerror = () => { zxingLoading = null; reject(new Error('Could not load the barcode reader')); };
    document.head.append(s);
  });
  return zxingLoading;
}

function zxDecode(Z, canvas) {
  const hints = new Map([[Z.DecodeHintType.TRY_HARDER, true]]);
  const reader = new Z.MultiFormatReader();
  reader.setHints(hints);
  try {
    const r = reader.decode(new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(canvas))), hints);
    return { format: Z.BarcodeFormat[r.getBarcodeFormat()] || 'barcode', value: r.getText() };
  } catch { return null; }
}

/* Labels often carry several stacked barcodes; decode the whole image and strips of it. */
function zxDecodeAll(Z, canvas) {
  const found = new Map();
  const regions = [[0, 0, 1, 1]];
  for (const n of [2, 3, 4]) for (let i = 0; i < n; i++) regions.push([0, i / n, 1, 1 / n]);
  regions.push([0, 0, 0.5, 1], [0.5, 0, 0.5, 1]);
  const tmp = document.createElement('canvas');
  for (const [x, y, w, hh] of regions) {
    const sw = Math.round(canvas.width * w), sh = Math.round(canvas.height * hh);
    tmp.width = sw; tmp.height = sh;
    tmp.getContext('2d').drawImage(canvas, Math.round(canvas.width * x), Math.round(canvas.height * y), sw, sh, 0, 0, sw, sh);
    const r = zxDecode(Z, tmp);
    if (r && !found.has(r.value)) found.set(r.value, r);
  }
  return [...found.values()];
}

async function photoToCanvas(file, maxSide = 2000) {
  let src;
  try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch {
    src = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('That file is not an image this browser can read'));
      img.src = URL.createObjectURL(file);
    });
  }
  const scale = Math.min(1, maxSide / Math.max(src.width, src.height));
  const c = document.createElement('canvas');
  c.width = Math.round(src.width * scale);
  c.height = Math.round(src.height * scale);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c;
}

async function serverScan(canvas) {
  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.92));
  const r = await fetch('/api/scan', { method: 'POST', credentials: 'same-origin', headers: { 'X-HaRM': '1', 'Content-Type': 'image/jpeg' }, body: blob });
  if (r.status === 401) { showAuth('Your session ended. Please unlock again.'); throw new Error('Session expired'); }
  if (!r.ok) throw new Error('The server could not read the photo');
  return r.json();
}

const BRANDS = ['Seagate', 'Western Digital', 'WDC', 'Toshiba', 'HGST', 'Samsung', 'Crucial', 'Micron', 'Kingston',
  'Intel', 'AMD', 'Dell', 'HPE', 'Hewlett Packard', 'Lenovo', 'IBM', 'Supermicro', 'Cisco', 'Ubiquiti', 'MikroTik',
  'Netgear', 'TP-Link', 'Synology', 'QNAP', 'Mellanox', 'NVIDIA', 'Broadcom', 'LSI', 'SK hynix', 'Hynix', 'Corsair',
  'ASUS', 'ASRock', 'Gigabyte', 'MSI', 'APC', 'CyberPower', 'Eaton', 'Juniper', 'Aruba', 'Raspberry Pi', 'Sabrent',
  'SanDisk', 'Solidigm', 'Kioxia', 'Chelsio', 'Brocade', 'Arista', 'Fortinet', 'Netgate', 'Protectli', 'Minisforum'];

/* Turn barcode values and recognised label text into candidate field values. */
function parseLabel(barcodes, text) {
  const out = [];
  const seen = new Set();
  const add = (value, guess, source) => {
    value = String(value || '').trim().replace(/^[\s:#.\-]+|[\s.,;:]+$/g, '');
    if (value.length < 3 || value.length > 80) return;
    const key = value.toUpperCase();
    const existing = out.find(c => c.value.toUpperCase() === key);
    if (existing) { if (!existing.guess && guess) existing.guess = guess; return; }
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ value, guess, source });
  };
  const macRe = /^(?:[0-9A-F]{2}[:\-]?){5}[0-9A-F]{2}$/i;
  for (const b of barcodes) {
    const v = b.value.trim();
    add(v, macRe.test(v) ? 'mac' : /^\d+(\.\d+)?\s?(TB|GB)$/i.test(v) ? 'capacity' : null, b.format);
  }
  const patterns = [
    [/\b(?:S\/N|SN|SER(?:IAL)?\.?(?:\s*(?:NO|NUM(?:BER)?|#))?|SERIAL\s+NUMBER)\s*[:#.\-]?\s*([A-Z0-9][A-Z0-9\-]{3,})/i, 'serial'],
    [/\b(?:P\/N|PN|PART\s*(?:NO|NUM(?:BER)?|#)?|MPN|FRU(?:\s*P\/?N)?)\s*[:#.\-]?\s*([A-Z0-9][A-Z0-9\-_.\/]{2,})/i, 'part_number'],
    [/\b(?:M\/N|MODEL(?:\s*(?:NO|NUM(?:BER)?|#))?|MDL|MTM)\s*[:#.\-]?\s*([A-Z0-9][A-Z0-9\-_.\/]{2,})/i, 'model'],
    [/\b(?:SERVICE\s*TAG|SVC\s*TAG|S\/T|ASSET(?:\s*TAG)?)\s*[:#.\-]?\s*([A-Z0-9\-]{4,})/i, 'asset_tag'],
    [/\b(?:MAC|HW\s*ADDR(?:ESS)?|ETHERNET|LAN)\b[^0-9A-F]{0,12}((?:[0-9A-F]{2}[:\-]?){5}[0-9A-F]{2})\b/i, 'mac'],
    [/\b((?:[0-9A-F]{2}[:\-]){5}[0-9A-F]{2})\b/i, 'mac'],
    [/\b(\d+(?:\.\d+)?\s?(?:TB|GB))\b/i, 'capacity'],
  ];
  const lines = (text || '').split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 1);
  for (const line of lines) for (const [re, guess] of patterns) { const m = line.match(re); if (m) add(m[1], guess, 'text'); }
  // Labelled lines first, then barcode values usually being the serial.
  for (const c of out) if (!c.guess && c.source !== 'text') c.guess = out.some(x => x.guess === 'serial') ? null : 'serial';
  const lower = (text || '').toLowerCase();
  for (const b of BRANDS) if (new RegExp(`\\b${b.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower)) add(b, 'manufacturer', 'text');
  for (const tok of (text || '').match(/\b[A-Z0-9][A-Z0-9\-]{5,}\b/g) || []) {
    if (/[A-Z]/.test(tok) && /\d/.test(tok)) add(tok, null, 'text');
  }
  return { candidates: out, lines };
}

function scanDialog({ title = 'Scan label', targets, onPick, single = false }) {
  const canLive = window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
  const status = h('div', { class: 'scan-status muted small' });
  const results = h('div', { class: 'scan-results' });
  const video = h('video', { class: 'scan-video', playsinline: true, muted: true });
  video.muted = true;
  const counter = h('div', { class: 'vf-count' });
  const hint = h('div', { class: 'vf-hint' }, 'Hold one barcode inside the box');
  const textBtn = h('button', { type: 'button', class: 'vf-text-btn' }, '📝 Read text');
  const viewfinder = h('div', { class: 'viewfinder', hidden: true }, video, h('div', { class: 'vf-frame' }), hint, counter, textBtn);
  const fileInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
  let stopLive = null;
  let barcodes = [], text = '', newest = null;
  const manual = [];
  const applied = new Map();

  const pick = (k, label, value) => {
    onPick(k, value);
    applied.set(k, value);
    toast(`${label} set`);
    if (single) m.close(true); else draw();
  };
  const useWord = w => {
    if (single) return pick(targets[0].k, targets[0].label, w);
    if (!manual.some(c => c.value === w)) manual.unshift({ value: w, guess: null, source: 'picked' });
    newest = w;
    draw();
  };

  const draw = () => {
    const parsed = parseLabel(barcodes, text);
    const candidates = [...manual, ...parsed.candidates.filter(c => !manual.some(x => x.value === c.value))];
    const lines = parsed.lines;
    const n = barcodes.length;
    counter.textContent = n ? `✓ ${n} code${n === 1 ? '' : 's'} found` : '';
    if (!candidates.length && !lines.length) { results.replaceChildren(); return; }
    const rows = candidates.map(c => {
      const btns = targets.map(t => {
        const isApplied = applied.get(t.k) === c.value;
        return h('button', {
          type: 'button', class: 'sm ' + (isApplied ? 'applied' : (c.guess === t.k ? 'primary' : '')),
          onclick: () => pick(t.k, t.label, c.value),
        }, isApplied ? `✓ ${t.label}` : (single ? 'Use this' : t.label));
      });
      const src = c.source === 'text' ? 'printed text' : c.source === 'picked' ? 'you picked' : `barcode · ${String(c.source).replace(/_/g, '-').toLowerCase()}`;
      const harm = /#\/devices\/(\d+)/.exec(c.value);
      if (harm) btns.unshift(h('button', { type: 'button', class: 'sm primary', onclick: () => { m.close(true); location.hash = `#/devices/${harm[1]}`; } }, '→ Open this device'));
      return h('div', { class: 'cand' + (c.value === newest ? ' new' : '') },
        h('div', { class: 'cand-val' }, h('code', null, c.value), h('span', { class: 'badge muted' }, src),
          c.guess && !single ? h('span', { class: 'muted small' }, `looks like: ${targets.find(t => t.k === c.guess)?.label || c.guess}`) : null),
        h('div', { class: 'cand-actions' }, btns));
    });
    const suggested = single ? [] : candidates.filter(c => c.guess && targets.some(t => t.k === c.guess));
    const fillAll = suggested.length > 1 ? h('button', {
      type: 'button', class: 'primary block', onclick: () => {
        const done = new Set();
        for (const c of suggested) if (!done.has(c.guess)) { onPick(c.guess, c.value); applied.set(c.guess, c.value); done.add(c.guess); }
        toast(`Filled ${done.size} fields`);
        m.close(true);
      },
    }, `✓ Fill all ${new Set(suggested.map(c => c.guess)).size} highlighted suggestions`) : null;
    const words = [...new Set(lines.join(' ').split(/\s+/).map(w => w.replace(/^[^\w]+|[^\w]+$/g, '')).filter(w => w.length >= 3))]
      .filter(w => !candidates.some(c => c.value === w)).slice(0, 80);
    fillEl(results,
      fillAll,
      rows.length ? h('div', null, h('h4', null, single ? 'Tap “Use this” on the right value' : 'Tap which box each value belongs in'), rows)
        : h('p', { class: 'muted' }, 'Nothing that looks like an ID yet. Try closer, with more light, or tap a word below.'),
      words.length ? h('div', { class: 'word-chips' }, h('h4', null, 'Other text on the label (tap one to use it)'),
        h('div', { class: 'chips' }, words.map(w => h('button', { type: 'button', class: 'chip mono', onclick: () => useWord(w) }, w)))) : null);
  };

  const mergeServer = r => {
    for (const b of r.barcodes) if (!barcodes.some(x => x.value === b.value)) barcodes.push({ format: b.format, value: b.value });
    text = [text, r.text].filter(Boolean).join('\n');
  };

  textBtn.addEventListener('click', async () => {
    if (!video.videoWidth) return;
    const c = document.createElement('canvas');
    const scale = Math.min(1, 2000 / video.videoWidth);
    c.width = video.videoWidth * scale; c.height = video.videoHeight * scale;
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
    textBtn.disabled = true;
    status.replaceChildren(h('span', { class: 'spinner' }), ' Reading the text in view…');
    try {
      const r = await serverScan(c);
      mergeServer(r);
      status.textContent = r.ocr ? 'Read. Tap the words or values you want below. Move closer and tap again for more.' : 'Text reading isn’t installed on the server (tesseract).';
      draw();
    } catch (e) { status.textContent = e.message; }
    textBtn.disabled = false;
  });

  const startLive = async () => {
    status.textContent = 'Starting camera…';
    try {
      const Z = await loadZXing();
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      video.srcObject = stream;
      viewfinder.hidden = false;
      await video.play();
      liveBtn.hidden = true;
      status.textContent = 'Barcodes are picked up automatically, and each one is listed below. For printed text (no barcode), tap “Read text”.';
      const c = document.createElement('canvas');
      let stopped = false;
      const loop = () => {
        if (stopped) return;
        if (video.videoWidth) {
          const scale = Math.min(1, 1280 / video.videoWidth);
          c.width = video.videoWidth * scale; c.height = video.videoHeight * scale;
          c.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0, c.width, c.height);
          const r = zxDecode(Z, c);
          if (r && !barcodes.some(b => b.value === r.value)) {
            barcodes.push(r);
            newest = r.value;
            if (navigator.vibrate) navigator.vibrate(60);
            viewfinder.classList.remove('hit'); void viewfinder.offsetWidth; viewfinder.classList.add('hit');
            hint.textContent = 'Got one! Aim at the next barcode, or pick from the list below.';
            draw();
          }
        }
        setTimeout(loop, 180);
      };
      loop();
      stopLive = () => { stopped = true; stream.getTracks().forEach(t => t.stop()); viewfinder.hidden = true; liveBtn.hidden = false; };
    } catch (e) {
      status.textContent = (e.name === 'NotAllowedError' ? 'Camera permission was denied. ' : `Camera unavailable (${e.message}). `) + 'Use “Take photo” instead.';
    }
  };

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    if (stopLive) { stopLive(); stopLive = null; }
    status.replaceChildren(h('span', { class: 'spinner' }), ' Reading barcodes and text…');
    try {
      const canvas = await photoToCanvas(file);
      const [client, server] = await Promise.allSettled([
        loadZXing().then(Z => zxDecodeAll(Z, canvas)),
        serverScan(canvas),
      ]);
      if (client.status === 'fulfilled') for (const b of client.value) if (!barcodes.some(x => x.value === b.value)) barcodes.push(b);
      if (server.status === 'fulfilled') mergeServer(server.value);
      const notes = [];
      if (server.status === 'fulfilled' && !server.value.ocr) notes.push('Text recognition is not installed on the server (install tesseract), so only barcodes were read.');
      if (server.status === 'rejected') notes.push('The server could not read the photo; showing what the phone decoded.');
      status.textContent = notes.join(' ') || 'Done. Pick values below, or take another photo to add more.';
      draw();
    } catch (e) { status.textContent = e.message; }
  });

  const liveBtn = h('button', { type: 'button', class: 'primary', onclick: startLive, hidden: !canLive }, '🎥 Live camera');
  const m = modal(title, h('div', { class: 'scanner' },
    h('ol', { class: 'scan-howto' },
      h('li', null, canLive ? 'Live camera picks up barcodes and QR codes automatically. “Read text” reads printed text.' : 'Take a photo of the label; HaRM reads its barcodes and printed text.'),
      h('li', null, 'Everything found is listed below, with a best guess at what each value is.'),
      h('li', null, single ? 'Tap “Use this” on the right one.' : 'Tap which box each value goes in, or “Fill all”.')),
    h('div', { class: 'scan-buttons' }, liveBtn,
      h('button', { type: 'button', class: canLive ? '' : 'primary', onclick: () => fileInput.click() }, '📸 Take or choose photo'),
      fileInput),
    canLive ? null : h('p', { class: 'muted small' }, 'Live camera needs HTTPS (see Help > Phone & scanning). Photo mode works everywhere.'),
    viewfinder, status, results,
    h('div', { class: 'actions' }, h('button', { type: 'button', onclick: () => m.close(true) }, 'Done'))));
  m.onClose = () => { if (stopLive) stopLive(); };
  if (canLive && window.matchMedia('(pointer: coarse)').matches) startLive();
  return m;
}

function scanInto(input, label) {
  scanDialog({
    title: `Scan ${label}`, single: true, targets: [{ k: 'x', label }],
    onPick: (_k, v) => {
      input.value = v;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
  });
}

function scanLabel(form, keys) {
  const targets = keys.filter(k => form.inputs[k]).map(k => ({ k, label: form.inputs[k].f.label.replace(/ \(.*\)$/, '') }));
  if (!targets.length) return;
  scanDialog({ title: 'Scan label', targets, onPick: (k, v) => form.set({ [k]: v }) });
}

// ---------------------------------------------------------------- TOTP (client side, for live codes)

function b32decode(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, val = 0;
  const out = [];
  for (const c of s.toUpperCase().replace(/=+$/, '')) {
    const i = A.indexOf(c);
    if (i < 0) continue;
    val = ((val << 5) | i) & 0xffff;
    bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}
/* Secrets show as dots; the eye shows them and they hide again after 30 seconds (ZomBeatz rule). */
function eyeButton(setShown) {
  let shown = false, timer = null;
  const b = h('button', { type: 'button', class: 'icon-btn eye-btn', 'aria-label': 'Show', title: 'Show' }, ic('eye'));
  const set = on => {
    shown = on;
    clearTimeout(timer);
    if (on) timer = setTimeout(() => { if (b.isConnected) set(false); }, 30000);
    b.replaceChildren(ic(on ? 'eye-off' : 'eye'));
    b.setAttribute('aria-label', on ? 'Hide' : 'Show');
    b.title = on ? 'Hide (hides by itself after 30 seconds)' : 'Show';
    setShown(on);
  };
  b.addEventListener('click', () => set(!shown));
  return b;
}
const splitCode = c => (c && c.length === 6 ? `${c.slice(0, 3)} ${c.slice(3)}` : c || '');

async function totpNow(secret, period = 30, digits = 6) {
  const key = await crypto.subtle.importKey('raw', b32decode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const ctr = Math.floor(Date.now() / 1000 / period);
  const buf = new ArrayBuffer(8), dv = new DataView(buf);
  dv.setUint32(0, Math.floor(ctr / 2 ** 32));
  dv.setUint32(4, ctr >>> 0);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf));
  const o = sig[sig.length - 1] & 15;
  const code = (((sig[o] & 127) << 24) | (sig[o + 1] << 16) | (sig[o + 2] << 8) | sig[o + 3]) % 10 ** digits;
  return String(code).padStart(digits, '0');
}

/* Buttons that open what a login is for. Browsers never let one site type into another
   site's login form, so opening a web page copies the password on the same click. */
function launchPanel(c, sec) {
  const targets = sec.targets || [];
  if (!targets.length) return null;
  const user = c.username || '';
  const copyPw = () => { if (sec.password) copy(sec.password, 'Password'); };
  const items = targets.map(t => {
    if (t.type === 'web') {
      return h('a', { class: 'button primary', href: t.url, target: '_blank', rel: 'noopener noreferrer', onclick: copyPw },
        `↗ ${t.label}`, h('span', { class: 'launch-sub' }, t.url.replace(/^https?:\/\//, '')));
    }
    if (t.type === 'ssh') {
      const cmd = `ssh ${user ? user + '@' : ''}${t.host}${t.port && t.port !== 22 ? ' -p ' + t.port : ''}`;
      return h('div', { class: 'launch-row' },
        h('code', null, cmd),
        small('Copy command', () => copy(cmd, 'SSH command')),
        h('a', { class: 'button sm', href: `ssh://${user ? encodeURIComponent(user) + '@' : ''}${t.host}${t.port && t.port !== 22 ? ':' + t.port : ''}`, onclick: copyPw }, 'Open in SSH app'));
    }
    if (t.type === 'rdp') {
      return h('div', { class: 'launch-row' },
        h('code', null, `RDP → ${t.host}`),
        small('Download .rdp file', () => {
          copyPw();
          download(`${t.host}.rdp`, `full address:s:${t.host}\r\n${user ? `username:s:${user}\r\n` : ''}prompt for credentials:i:1\r\n`, 'application/x-rdp');
        }));
    }
    return null;
  });
  return h('div', { class: 'launch' }, items,
    h('p', { class: 'muted small' }, sec.password
      ? 'Opening copies the password, so just paste it into the login box. After the first login, let your browser save it for true one-click sign-in next time.'
      : 'No password stored for this login.'));
}

async function revealCredential(c) {
  let sec;
  try { sec = await api('POST', `/credentials/${c.id}/reveal`); }
  catch (e) { return toast(e.message, 'bad'); }
  const masked = '•'.repeat(12);
  const pwVal = h('code', { class: 'secret' }, masked);
  let code = sec.totp_code || '';
  const totpCode = h('code', { class: 'secret big totp' }, splitCode(code));
  const totpLeft = h('span', { class: 'totp-ring', role: 'img', 'aria-label': '' });
  const body = h('div', { class: 'reveal' },
    launchPanel(c, sec),
    kv([
      ['Label', c.label],
      ['Kind', c.kind],
      ['Device', c.device_name ? link(`#/devices/${c.device_id}`, c.device_name) : ''],
      ['URL', extLink(c.url)],
      ['Username', c.username ? h('span', { class: 'inline' }, h('code', null, c.username), small('Copy', () => copy(c.username, 'Username'))) : ''],
      ['Password', sec.password != null ? h('span', { class: 'inline' }, pwVal,
        eyeButton(on => { pwVal.textContent = on ? sec.password : masked; }),
        small('Copy', () => copy(sec.password, 'Password'))) : ''],
      ['2FA code', sec.totp_secret ? h('span', { class: 'inline' }, totpCode, totpLeft, small('Copy', () => copy(code, '2FA code'))) : ''],
      ['Last rotated', c.last_rotated],
    ]),
    sec.secret_notes ? [h('h4', null, 'Secret notes'), h('pre', { class: 'secret-notes' }, sec.secret_notes)] : null,
    h('p', { class: 'muted small' }, 'This window closes automatically after 60 seconds. Reveals are recorded in the audit log.'));
  const m = modal('🔑 ' + c.label, body);
  let ticks = 0;
  const tick = async () => {
    if (!document.body.contains(m.box)) return clearInterval(timer);
    if (++ticks > 60) { m.close(); return clearInterval(timer); }
    if (sec.totp_secret && window.crypto?.subtle) {
      try { code = await totpNow(sec.totp_secret); totpCode.textContent = splitCode(code); } catch { /* keep server code */ }
      const left = 30 - Math.floor(Date.now() / 1000) % 30;
      totpLeft.style.setProperty('--p', String(left / 30));
      totpLeft.setAttribute('aria-label', `${left} seconds left`);
      totpLeft.title = `${left} seconds left`;
    }
  };
  const timer = setInterval(tick, 1000);
  tick();
}

// ---------------------------------------------------------------- auth screens

// ---------------------------------------------------------------- themes

const THEMES = {
  zombeatz: { name: 'ZomBeatz', blurb: 'Brand blue with orange highlights. The default.', icon: '/static/icon.svg',
    swatches: { dark: ['#14161c', '#4fb0ec', '#ec6a3f'], light: ['#f4f5f8', '#2580c3', '#ec6a3f'] } },
  coolant: { name: 'Coolant', blurb: '❄ You found it. Liquid-cooled servers, mint and cyan.', icon: '/static/icon-coolant.svg', anim: '/static/icon-coolant-anim.svg', hidden: true,
    swatches: { dark: ['#14161c', '#5ff7cf', '#22d3ee'], light: ['#f4f5f8', '#0e9f8c', '#0891b2'] } },
};
/* "this phone", "this tablet", "this computer": the words the design system uses for the device in hand. */
function deviceWord() {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) || (/Android/.test(ua) && !/Mobile/.test(ua))) return 'tablet';
  if (/iPhone|iPod|Android|Mobile/.test(ua)) return 'phone';
  return 'computer';
}
const MODES = [['auto', `Match my ${deviceWord()}`], ['light', 'Light'], ['dark', 'Dark']];
const themeName = () => (document.documentElement.dataset.product === 'harm-coolant' ? 'coolant' : 'zombeatz');
/* The sidebar logo may be animated (Coolant); tab icons and theme previews stay still. */
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const themeIcon = () => { const t = THEMES[themeName()]; return t.anim && !calm() ? t.anim : t.icon; };
const brandName = () => h('div', { class: 'brand-name' }, "Zom's ", h('span', { class: 'brand-accent' }, 'HaRM'));
function themePrefs() {
  try { return { theme: localStorage.getItem('harm-theme') || 'zombeatz', mode: localStorage.getItem('harm-mode') || 'auto' }; }
  catch { return { theme: 'zombeatz', mode: 'auto' }; }
}
/* Theme and light/dark are remembered per device (phone and PC can differ). */
function applyTheme(theme, mode) {
  const p = themePrefs();
  theme = THEMES[theme] ? theme : (THEMES[p.theme] ? p.theme : 'zombeatz');
  mode = mode || p.mode;
  try { localStorage.setItem('harm-theme', theme); localStorage.setItem('harm-mode', mode); } catch { /* not saved */ }
  const r = document.documentElement;
  r.dataset.product = theme === 'coolant' ? 'harm-coolant' : 'harm';
  r.dataset.modePref = mode;
  r.dataset.theme = mode === 'auto' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : mode;
  document.querySelectorAll('img.brand-icon').forEach(i => { i.src = themeIcon(); });
  const fav = document.querySelector('link[rel="icon"]');
  if (fav) fav.href = THEMES[theme].icon;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(r).getPropertyValue('--bg').trim() || '#12151b';
}
matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => {
  if (themePrefs().mode === 'auto') applyTheme();
});

const coolantUnlocked = () => prefGet('harm-coolant') === '1' || themePrefs().theme === 'coolant';

/* Easter egg: click the sidebar logo 5 times quickly to unlock the Coolant theme. */
function brandClicks(e) {
  const now = Date.now();
  S.brandClicks = (S.brandClicks || []).filter(t => now - t < 2000).concat(now);
  const img = e.currentTarget.querySelector('img');
  if (img) { img.classList.remove('brand-pop'); void img.offsetWidth; img.classList.add('brand-pop'); }
  if (S.brandClicks.length < 5) return;
  S.brandClicks = [];
  const first = !coolantUnlocked();
  prefSet('harm-coolant', '1');
  const next = themeName() === 'coolant' ? 'zombeatz' : 'coolant';
  applyTheme(next);
  toast(next === 'coolant' ? (first ? '❄ Coolant unlocked! Switch any time in Settings > Appearance.' : '❄ Coolant on') : 'Back to ZomBeatz');
  if (location.hash.startsWith('#/settings')) route();
}

function appearanceCard() {
  const body = h('div');
  const draw = () => {
    const p = themePrefs();
    const scheme = document.documentElement.dataset.theme;
    fillEl(body,
      h('div', { class: 'theme-picks' }, Object.entries(THEMES).filter(([, t]) => !t.hidden || coolantUnlocked()).map(([k, t]) => h('button', {
        type: 'button', class: 'theme-pick' + (p.theme === k ? ' on' : ''), onclick: () => { applyTheme(k); draw(); },
      }, h('img', { src: t.icon, alt: '' }), h('span', null, h('b', null, t.name), h('small', null, t.blurb),
        h('span', { class: 'swatches' }, t.swatches[scheme].map(c => h('i', { style: { background: c } }))))))),
      h('div', { class: 'chips' }, MODES.map(([k, l]) => h('button', {
        type: 'button', class: 'chip' + (p.mode === k ? ' on' : ''), onclick: () => { applyTheme(null, k); draw(); },
      }, l))),
      h('p', { class: 'muted small' }, `Saved on this ${deviceWord()} only, so your phone and computer can each have their own. Match my ${deviceWord()} follows its light or dark setting.`));
  };
  draw();
  return card('Appearance', body);
}

function showAuth(msg) {
  S.authed = false;
  document.querySelectorAll('.modal-back').forEach(m => m.remove());
  document.body.classList.remove('modal-open');
  document.documentElement.classList.remove('modal-open');
  const app = document.getElementById('app');
  app.replaceChildren(h('div', { class: 'auth-wrap' }, h('div', { class: 'auth-card' },
    h('div', { class: 'brand big' }, h('img', { class: 'brand-icon', src: themeIcon(), alt: '' }),
      h('div', null, brandName(), h('div', { class: 'brand-sub' }, 'Hardware & Rack Manager'))),
    msg ? h('div', { class: 'notice' }, msg) : null,
    h('div', { id: 'auth-body' }))));
  api('GET', '/auth/status').then(st => {
    S.auth = st;
    (st.setup ? renderLogin : renderSetup)();
  }).catch(e => { document.getElementById('auth-body').append(h('div', { class: 'form-error' }, e.message)); });
}

function authForm(fields, submitLabel, onSubmit, footer) {
  const err = h('div', { class: 'form-error', role: 'alert' });
  const inputs = {};
  const b = h('button', { class: 'primary block', type: 'submit' }, submitLabel);
  const form = h('form', {
    onsubmit: async e => {
      e.preventDefault();
      err.textContent = '';
      b.disabled = true;
      try { await onSubmit(Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value]))); }
      catch (x) { err.textContent = x.message; }
      finally { b.disabled = false; }
    },
  }, fields.map(f => {
    const i = h('input', { type: f.type || 'password', autocomplete: f.ac || 'off', required: !f.optional, inputmode: f.inputmode, placeholder: f.ph });
    inputs[f.k] = i;
    return h('div', { class: 'field' }, h('label', null, f.label), i);
  }), err, b, footer);
  document.getElementById('auth-body').replaceChildren(form);
  setTimeout(() => form.querySelector('input')?.focus(), 0);
}

function renderSetup() {
  authForm([
    { k: 'pw', label: 'Create a master password (10+ characters)', ac: 'new-password' },
    { k: 'pw2', label: 'Confirm master password', ac: 'new-password' },
  ], 'Create vault', async v => {
    if (v.pw !== v.pw2) throw new Error('Passwords do not match');
    const r = await api('POST', '/auth/setup', { password: v.pw });
    showRecoveryCode(r.recovery_code, () => { location.hash = '#/setup'; startApp(); });
  }, h('p', { class: 'muted small' }, 'Your master password encrypts every stored login. It is never stored and cannot be recovered without the recovery code shown next.'));
}

function renderLogin() {
  const fields = [{ k: 'password', label: 'Master password', ac: 'current-password' }];
  if (S.auth.totp_enabled) fields.push({ k: 'totp', label: '2FA code', type: 'text', ac: 'one-time-code', inputmode: 'numeric', ph: '123456' });
  authForm(fields, 'Unlock', async v => {
    await api('POST', '/auth/login', v);
    await startApp();
  }, h('p', { class: 'small center' }, h('a', { href: '#', onclick: e => { e.preventDefault(); renderRecover(); } }, 'Forgot your password? Use the recovery code')));
}

function renderRecover() {
  authForm([
    { k: 'recovery_code', label: 'Recovery code', type: 'text', ph: 'XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX' },
    { k: 'new_password', label: 'New master password', ac: 'new-password' },
    { k: 'pw2', label: 'Confirm new password', ac: 'new-password' },
  ], 'Reset password', async v => {
    if (v.new_password !== v.pw2) throw new Error('Passwords do not match');
    const r = await api('POST', '/auth/recover', { recovery_code: v.recovery_code, new_password: v.new_password });
    showRecoveryCode(r.recovery_code, startApp, 'Your old recovery code no longer works, and 2FA has been turned off.');
  }, h('p', { class: 'small center' }, h('a', { href: '#', onclick: e => { e.preventDefault(); renderLogin(); } }, 'Back to unlock')));
}

function showRecoveryCode(code, then, extra) {
  const ok = h('input', { type: 'checkbox' });
  const go = h('button', { class: 'primary', type: 'button', disabled: true }, 'Continue');
  ok.addEventListener('change', () => { go.disabled = !ok.checked; });
  const m = modal('Save your recovery code', h('div', null,
    h('p', null, 'This is the only way back in if you forget your master password. Store it somewhere safe and offline. It will not be shown again.'),
    extra ? h('p', { class: 'warn-text' }, extra) : null,
    h('div', { class: 'recovery' }, h('code', null, code), small('Copy', () => copy(code, 'Recovery code'))),
    h('label', { class: 'check' }, ok, h('span', null, 'I have saved my recovery code')),
    h('div', { class: 'actions' }, go)));
  m.box.querySelector('.modal-head .icon-btn').remove();
  go.addEventListener('click', () => { m.close(); if (then) then(); });
}

// ---------------------------------------------------------------- shell & routing

/* Sidebar: everyday pages first, the rest folded under “More”. */
const NAV_GROUPS = [
  [null, [['dashboard', 'Home', '◧'], ['tasks', 'Tasks & Notes', '☑']]],
  ['Inventory', [['devices', 'Devices', '▤'], ['virtual', 'Virtual & Clusters', '⧉'], ['racks', 'Racks & Storage', '▥'], ['components', 'Spare Parts', '◫'], ['builds', 'PC Builder', '⚒']]],
  ['Network', [['networks', 'Networks & IPs', '⌗'], ['discover', 'Discover', '⌖'], ['vault', 'Logins (Vault)', '🔑']]],
  ['More', [['locations', 'Locations', '⌂'], ['connections', 'Cables', '⇄'], ['library', 'Parts Library', '▦'],
    ['export', 'Export & Share', '⇪'], ['audit', 'Audit log', '📜'], ['settings', 'Settings', '⚙'], ['help', 'Help & guide', '❓']]],
];
const navLink = ([k, label, ico]) => h('a', { href: `#/${k}`, 'data-nav': k, title: label }, h('span', { class: 'ico' }, ico), h('span', { class: 'nav-label' }, label));
function navTree() {
  return NAV_GROUPS.map(([title, items]) => {
    if (title !== 'More') return h('div', { class: 'nav-group' }, title ? h('div', { class: 'nav-title' }, title) : null, items.map(navLink));
    let open = false;
    try { open = localStorage.getItem('harm-nav-more') === '1'; } catch { /* default closed */ }
    const det = h('details', { class: 'nav-group nav-more', open,
      ontoggle: e => { try { localStorage.setItem('harm-nav-more', e.target.open ? '1' : '0'); } catch { /* ignore */ } } },
      h('summary', { class: 'nav-title' }, 'More'), items.map(navLink));
    return det;
  });
}
/* Phone: the few pages used every day sit in a bottom bar. */
function tabBar() {
  const t = (k, label, ico) => h('a', { href: `#/${k}`, 'data-nav': k }, h('span', { class: 'tb-ico' }, ico), h('span', null, label));
  return h('nav', { class: 'tabbar' }, t('dashboard', 'Home', '◧'), t('devices', 'Devices', '▤'), t('racks', 'Racks', '▥'), t('tasks', 'Tasks', '☑'),
    h('button', { type: 'button', onclick: () => document.body.classList.toggle('nav-open') }, h('span', { class: 'tb-ico' }, '☰'), h('span', null, 'More')));
}


/* After HaRM is updated/restarted, an open tab (or the phone app) offers a reload. */
function checkVersion(st) {
  if (!st || !st.version) return;
  if (!S.version) { S.version = st.version; return; }
  if (st.version !== S.version && !S.updateShown) {
    S.updateShown = true;
    toast('HaRM was updated.', 'ok', { label: '⟳ Reload', onClick: () => location.reload() });
    document.body.append(h('div', { class: 'update-bar' }, 'A newer version of HaRM is available. ',
      h('button', { type: 'button', class: 'sm primary', onclick: () => location.reload() }, '⟳ Reload')));
  }
}

async function startApp() {
  S.auth = await api('GET', '/auth/status');
  checkVersion(S.auth);
  if (!S.auth.authenticated) return showAuth();
  S.authed = true;
  [S.enums, S.caps] = await Promise.all([GET('/meta/enums'), GET('/meta/capabilities').catch(() => ({}))]);
  await loadLookups();
  renderShell();
  route();
}

function renderShell() {
  document.querySelectorAll('datalist').forEach(d => d.remove());
  for (const [name, list] of Object.entries(S.enums)) {
    document.body.append(h('datalist', { id: 'dl_' + name }, list.map(v => h('option', { value: v }))));
  }
  const search = h('input', { type: 'search', placeholder: 'Search devices, IPs, serials, parts…', 'aria-label': 'Search', autocomplete: 'off',
    title: hasKeyboard() ? `Search everything (${MOD} K)` : null });
  const searchBox = searchTypeahead(search);
  const app = document.getElementById('app');
  document.body.classList.toggle('nav-folded', prefGet('harm-nav-folded') === '1');
  app.replaceChildren(
    h('aside', { class: 'sidebar' },
      h('a', { class: 'brand', href: '#/dashboard', onclick: brandClicks }, h('img', { class: 'brand-icon', src: themeIcon(), alt: '' }),
        h('div', null, brandName(), h('div', { class: 'brand-sub' }, 'Hardware & Rack Manager'))),
      h('nav', null, navTree()),
      h('button', { class: 'install-btn', type: 'button', hidden: !S.installPrompt, onclick: installApp }, '⤓ Install app'),
      h('button', { class: 'lock', type: 'button', onclick: lockNow, title: 'Lock now' }, '🔒 ', h('span', { class: 'nav-label' }, 'Lock now'))),
    h('div', { class: 'main' },
      h('header', { class: 'topbar' },
        h('button', { class: 'icon-btn menu', type: 'button', 'aria-label': 'Menu', onclick: () => document.body.classList.toggle('nav-open') }, '☰'),
        searchBox, quickAddButton()),
      h('main', { id: 'view' })),
    tabBar(),
    h('div', { class: 'nav-scrim', onclick: () => document.body.classList.remove('nav-open') }));
}

async function lockNow() {
  try { await api('POST', '/auth/logout'); } catch { /* ignore */ }
  showAuth('Locked.');
}

const ROUTES = [
  [/^\/?(dashboard)?$/, () => viewDashboard()],
  [/^\/devices$/, () => viewDevices()],
  [/^\/devices\/(\d+)$/, (m, q) => viewDevice(+m[1], q)],
  [/^\/racks$/, () => viewRacks()],
  [/^\/racks\/(\d+)$/, m => viewRack(+m[1])],
  [/^\/components$/, (m, q) => viewComponents(q)],
  [/^\/connections$/, () => viewConnections()],
  [/^\/locations$/, () => viewLocations()],
  [/^\/locations\/(\d+)$/, m => viewLocation(+m[1])],
  [/^\/networks$/, () => viewNetworks()],
  [/^\/networks\/(\d+)$/, m => viewNetwork(+m[1])],
  [/^\/discover$/, () => viewDiscover()],
  [/^\/virtual$/, () => viewVirtual()],
  [/^\/clusters\/(\d+)$/, m => viewCluster(+m[1])],
  [/^\/setup$/, () => viewSetup()],
  [/^\/builds$/, () => viewBuilds()],
  [/^\/builds\/(\d+)$/, m => viewBuild(+m[1])],
  [/^\/library$/, () => viewLibrary()],
  [/^\/export$/, (m, q) => viewExport(q)],
  [/^\/tasks$/, () => viewTasks()],
  [/^\/scan-part$/, () => { location.replace('#/components'); setTimeout(() => editEntity('components', { status: 'In Stock', quantity: 1 }, null, { autoScan: true }), 300); }],
  [/^\/help$/, (m, q) => viewHelp(q.get('s'))],
  [/^\/vault$/, (m, q) => viewVault(q)],
  [/^\/audit$/, () => viewAudit()],
  [/^\/settings$/, () => viewSettings()],
  [/^\/search$/, (m, q) => viewSearch(q.get('q') || '')],
];

/* Drop one-shot query parts (like ?edit=…) from the address without reloading, so Back and
   re-renders don't reopen the same dialog. */
function cleanHash(hash) {
  history.replaceState(null, '', hash);
  S.routeHash = location.hash;
  const cur = S.hist[S.hist.length - 1];
  if (cur) cur.hash = location.hash;
}

/* In-app history, so detail pages can offer "← Back to The Rack". */
function trackHistory() {
  const hsh = location.hash || '#/dashboard';
  const hist = S.hist;
  if (hist.length && hist[hist.length - 1].hash === hsh) return;
  if (hist.length > 1 && hist[hist.length - 2].hash === hsh) { hist.pop(); return; }
  hist.push({ hash: hsh, title: '' });
  if (hist.length > 60) hist.shift();
}
function backLink() {
  const prev = S.hist[S.hist.length - 2];
  if (!prev) return null;
  return h('a', { class: 'back-link', href: prev.hash, onclick: e => { e.preventDefault(); history.back(); } },
    `← Back to ${prev.title || 'previous page'}`);
}
function goBackOr(fallback) {
  if (S.hist.length > 1) history.back();
  else location.hash = fallback;
}

async function route() {
  if (!S.authed) return;
  document.body.classList.remove('nav-open');
  S.routeHash = location.hash;
  trackHistory();
  const raw = location.hash.replace(/^#/, '');
  const [path, qs] = raw.split('?');
  const q = new URLSearchParams(qs || '');
  const top = { clusters: 'virtual' }[path.split('/')[1]] || path.split('/')[1] || 'dashboard';
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === top));
  const more = document.querySelector('.nav-more');
  if (more && more.querySelector('a.active')) more.open = true;
  for (const [re, fn] of ROUTES) {
    const m = path.match(re);
    if (m) {
      try { await fn(m, q); }
      catch (e) { if (S.authed) render(h('div', { class: 'form-error' }, e.message)); }
      const cur = S.hist[S.hist.length - 1];
      if (cur && cur.hash === (location.hash || '#/dashboard')) cur.title = S.pageTitle || '';
      return;
    }
  }
  render(h('div', { class: 'empty' }, 'Page not found.'));
}
const rerender = () => route();
window.addEventListener('hashchange', route);

// ---------------------------------------------------------------- views: dashboard

async function viewDashboard() {
  const [d, sum] = await Promise.all([GET('/dashboard'), GET('/devices/summary')]);
  const c = d.counts;
  const back = () => viewDashboard();
  const stat = (n, label, href) => h('a', { class: 'stat', href }, h('div', { class: 'stat-n' }, n), h('div', { class: 'stat-l' }, label));
  const barList = (rows, hrefOf, cls = '') => {
    const max = Math.max(...rows.map(x => x.n), 1);
    return h('div', { class: 'bars' }, rows.map(r => {
      const fill = h('div', { class: 'bar-fill ' + cls });
      fill.style.width = `${(r.n / max) * 100}%`;
      return h(hrefOf ? 'a' : 'div', { class: 'bar-row', href: hrefOf ? hrefOf(r) : null, title: r.capacities || null },
        h('div', { class: 'bar-label' }, r.label), h('div', { class: 'bar' }, fill), h('div', { class: 'bar-n' }, r.n));
    }));
  };
  const rackRows = d.racks.filter(r => r.height_u).map(r => {
    const pct = Math.min(100, Math.round((r.used_u / r.height_u) * 100));
    const fill = h('div', { class: 'bar-fill' + (pct > 85 ? ' hot' : '') });
    fill.style.width = pct + '%';
    return h('a', { class: 'bar-row', href: `#/racks/${r.id}` }, h('div', { class: 'bar-label' }, r.name), h('div', { class: 'bar' }, fill), h('div', { class: 'bar-n' }, `${r.used_u}/${r.height_u}U`));
  });
  const isEmpty = c.devices === 0 && c.components === 0 && c.racks === 0;

  // One list of everything that needs a look, most urgent first.
  const att = [];
  const item = (ico, body, cls = '') => att.push(h('li', { class: cls }, h('span', { class: 'a-ico' }, ico), h('span', null, body)));
  d.ip_conflicts.forEach(r => item('⚠', [h('b', { class: 'mono bad-text' }, r.label), ` is used by more than one device: ${r.devices}`]));
  (d.needs_repair || []).forEach(r => item('🛠', [link(`#/devices/${r.id}`, r.label), ' ', badge(r.status)]));
  d.warranty_soon.forEach(r => item('🛡', [link(r.kind === 'device' ? `#/devices/${r.id}` : `#/components?id=${r.id}`, r.label), ' warranty ends ', warrantyCell(r.warranty_until)]));
  if (d.unconnected_active.length) {
    item('🔌', [`${d.unconnected_active.length} active device${d.unconnected_active.length > 1 ? 's are' : ' is'} marked not hooked up: `,
      d.unconnected_active.slice(0, 6).map((r, i) => [i ? ', ' : '', link(`#/devices/${r.id}`, r.label)]),
      d.unconnected_active.length > 6 ? ' …' : '']);
  }
  if (d.stale_credentials.length) {
    item('🔑', [link('#/vault', `${d.stale_credentials.length} login${d.stale_credentials.length > 1 ? 's' : ''}`), ' not changed in over a year']);
  }

  render(
    pageHead('Home', isEmpty ? 'Let’s get your hardware in here.' : 'What needs you, and what you’ve got.',
      isEmpty ? h('a', { class: 'button primary', href: '#/setup' }, '🧭 Setup guide') : null),
    isEmpty ? h('div', { class: 'card onboarding' },
      h('h3', null, 'Getting started'),
      h('ol', null,
        h('li', null, link('#/locations', 'Add a location'), ': your house, the basement, the closet.'),
        h('li', null, link('#/racks', 'Add a rack or holder'), ': a 42U rack, a wire shelf, a bin of spare drives.'),
        h('li', null, link('#/devices', 'Add devices'), ', or pull them in from your network with ', link('#/discover', 'Discover'), '.'),
        h('li', null, link('#/components', 'Catalog spare parts'), ' Drives, RAM, NICs, cables and see what fits where.')),
      h('p', null, h('a', { class: 'button primary', href: '#/setup' }, '🧭 Start the setup guide'), ' ', h('span', { class: 'muted small' }, 'Walks you through all of this in about 10 minutes.'))) : null,
    isEmpty ? null : h('div', { class: 'stats' },
      stat(c.devices, `Devices · ${c.connected} hooked up`, '#/devices'),
      stat(d.open_tasks.length, 'Open tasks & issues', '#/tasks'),
      stat(c.spare_units, 'Spare parts', '#/components'),
      sum.totals.storage ? stat(sum.totals.storage, `Raw storage · ${sum.totals.drives} drives`, '#/devices') : null,
      sum.totals.cores ? stat(sum.totals.cores, `CPU cores${sum.totals.ram ? ' · ' + sum.totals.ram + ' RAM' : ''}`, '#/devices') : null),
    isEmpty ? null : h('div', { class: 'grid two' },
      card('Needs attention', att.length ? h('ul', { class: 'attention' }, att) : h('div', { class: 'all-good' }, '✓ Nothing needs attention.')),
      card(`Tasks & issues${d.open_tasks.length ? ' · ' + d.open_tasks.length : ''}`,
        d.open_tasks.length ? h('ul', { class: 'plain notes-list open' }, d.open_tasks.slice(0, 8).map(n => noteItem(n, back, { showTarget: true })))
          : h('div', { class: 'empty' }, 'No open tasks. Add them from any device’s page, or on the Tasks page.'),
        h('a', { class: 'button sm', href: '#/tasks' }, d.open_tasks.length > 8 ? `All ${d.open_tasks.length}` : 'Tasks page'))),
    isEmpty ? null : h('div', { class: 'grid' },
      rackRows.length ? card('Rack space', h('div', { class: 'bars' }, rackRows)) : null,
      d.spares_by_category.length ? card('Spare parts on hand', barList(d.spares_by_category, () => '#/components', 'alt')) : null,
      d.storage_installed.drives ? card('Storage', h('div', null,
        h('div', { class: 'storage-total' }, h('b', null, d.storage_installed.total), h('span', { class: 'muted' }, ` raw installed in ${d.storage_installed.drives} drives`)),
        h('ul', { class: 'plain storage-groups' }, d.storage_installed.groups.slice(0, 6).map(g => h('li', null, h('b', null, `${g.count} × ${g.capacity}`), ` ${g.category}`))),
        d.storage_spare.drives ? h('p', null, link('#/components', `${d.storage_spare.total} spare`), h('span', { class: 'muted' }, ` on the shelf in ${d.storage_spare.drives} drives`)) : null)) : null),
    isEmpty ? null : h('details', { class: 'more-stats' }, h('summary', null, 'More: devices by status and type, recent activity'),
      h('div', { class: 'grid' },
        card('Devices by status', d.devices_by_status.length ? barList(d.devices_by_status) : h('div', { class: 'empty' }, 'Nothing yet.')),
        card('Devices by type', d.devices_by_type.length ? barList(d.devices_by_type) : h('div', { class: 'empty' }, 'Nothing yet.')),
        card('Recent activity', auditList(d.recent), h('a', { class: 'button sm', href: '#/audit' }, 'Audit log')))));
}

function auditList(rows) {
  return rows.length ? h('ul', { class: 'plain audit' }, rows.map(a => h('li', null,
    h('span', { class: 'muted mono' }, a.ts.slice(5, 16)), ' ',
    h('b', null, a.action), ' ', a.entity ? `${a.entity}` : '', a.detail ? h('span', { class: 'muted' }, `: ${a.detail}`) : ''))) : h('div', { class: 'empty' }, 'No activity yet.');
}

// ---------------------------------------------------------------- views: devices

function placement(d) {
  if (!d.rack_id) return d.position || '';
  const where = d.rack_u ? ` · U${d.rack_u}${d.u_height > 1 ? '-' + (d.rack_u + d.u_height - 1) : ''}${d.rack_face === 'rear' ? ' (rear)' : ''}` : (d.position ? ` · ${d.position}` : '');
  return h('span', null, link(`#/racks/${d.rack_id}`, d.rack_name), where);
}

/* "64 cores · 512 GB RAM · 120 TB" for a set of devices. */
function fleetLine(ids, sum) {
  let cores = 0, ram = 0, st = 0, issues = 0, tasks = 0;
  for (const id of ids) {
    const x = sum.devices[id] || {};
    cores += x.cores || 0; ram += x.ram_gb || 0; st += x.storage_gb || 0; issues += x.issues || 0; tasks += x.tasks || 0;
  }
  return [cores ? `${cores} cores` : null, ram ? `${fmtGB(ram)} RAM` : null, st ? `${fmtGB(st)} raw storage` : null,
    issues ? `⚠ ${issues} open issue${issues > 1 ? 's' : ''}` : null, tasks ? `☐ ${tasks} open task${tasks > 1 ? 's' : ''}` : null].filter(Boolean);
}
function taskFlag(x) {
  if (!x || !(x.issues || x.tasks)) return '';
  return h('span', { class: `badge ${x.issues ? 'warn' : 'info'}`, title: `${x.issues || 0} open issue(s), ${x.tasks || 0} open task(s)` },
    x.issues ? `⚠ ${x.issues}` : `☐ ${x.tasks}`);
}

async function viewDevices() {
  const [rows, sum] = await Promise.all([GET('/devices'), GET('/devices/summary')]);
  const hw = r => sum.devices[r.id] || {};
  const F = S.filters.devices;
  const holder = h('div');
  const sel = (key, label, list) => h('select', {
    value: F[key] || '', 'aria-label': label,
    onchange: e => { F[key] = e.target.value; draw(); },
  }, h('option', { value: '' }, label), list.map(o => h('option', { value: o.value ?? o }, o.label ?? o)));
  const q = h('input', { type: 'search', placeholder: 'Filter…', value: F.q || '', oninput: e => { F.q = e.target.value; draw(); } });
  const types = [...new Set(rows.map(r => r.device_type).filter(Boolean))].sort();
  // Less-used filters live behind one button; it shows how many are active.
  const extraKeys = ['type', 'loc', 'rack', 'conn', 'kind'];
  const extra = h('div', { class: 'toolbar extra-filters', hidden: !extraKeys.some(k => F[k]) && !S.devFiltersOpen },
    sel('type', 'All types', types),
    sel('loc', 'All locations', S.lk.locations.map(l => ({ value: String(l.id), label: locPath(l.id) }))),
    sel('rack', 'All holders', S.lk.racks.map(r => ({ value: String(r.id), label: r.name }))),
    sel('conn', 'Hooked up?', [{ value: '1', label: 'Hooked up' }, { value: '0', label: 'Not hooked up' }]),
    sel('kind', 'Physical & virtual', [{ value: 'phys', label: 'Physical only' }, { value: 'virt', label: 'VMs & containers only' }]),
    small('Clear filters', () => { for (const k of [...extraKeys, 'status', 'q']) delete F[k]; viewDevices(); }, 'ghost'));
  const nActive = () => extraKeys.filter(k => F[k]).length;
  const moreFilters = btn(`Filters${nActive() ? ` · ${nActive()}` : ''}`, () => { extra.hidden = !extra.hidden; S.devFiltersOpen = !extra.hidden; });
  const draw = () => {
    moreFilters.textContent = `Filters${nActive() ? ` · ${nActive()}` : ''}`;
    const needle = (F.q || '').toLowerCase();
    const list = rows.filter(r =>
      (!F.type || r.device_type === F.type) && (!F.status || r.status === F.status) &&
      (!F.rack || String(r.rack_id) === F.rack) && (!F.loc || String(r.location_id) === F.loc) &&
      (!F.conn || String(r.connected) === F.conn) &&
      (!F.kind || (F.kind === 'virt') === isVirtual(r)) &&
      (!needle || [r.name, r.hostname, r.model, r.manufacturer, r.serial, r.asset_tag, r.ips, r.tags, r.os].some(x => x && String(x).toLowerCase().includes(needle))));
    S.devVisible = list.map(r => r.id);
    const line = fleetLine(S.devVisible, sum);
    const detailed = prefGet('harm-dev-detailed') === '1';
    holder.replaceChildren(line.length ? h('div', { class: 'fleet-line' }, h('b', null, `${list.length} device${list.length === 1 ? '' : 's'}`), ' · ', line.join(' · ')) : '', table([
      { label: '', get: r => dot(r.connected), sort: r => r.connected, cls: 'narrow' },
      { label: 'Name', get: r => h('div', null, link(`#/devices/${r.id}`, r.name),
        !detailed && (r.manufacturer || r.model || r.device_type) ? h('div', { class: 'muted small' }, [r.device_type, nz(r.manufacturer, r.model)].filter(Boolean).join(' · ')) : null),
        sort: r => r.name },
      detailed ? { label: 'Type', get: r => r.device_type || '' } : null,
      { label: 'Status', get: r => statusSelect(r, () => viewDevices()), sort: r => r.status },
      detailed ? { label: 'Model', get: r => nz(r.manufacturer, r.model) } : null,
      detailed ? { label: 'Cores', get: r => hw(r).cores || '', sort: r => hw(r).cores || 0 } : null,
      detailed ? { label: 'RAM', get: r => hw(r).ram || h('span', { class: 'muted' }, r.ram || ''), sort: r => hw(r).ram_gb || 0 } : null,
      detailed ? { label: 'Storage', get: r => hw(r).storage || '', sort: r => hw(r).storage_gb || 0 } : null,
      { label: 'IP', get: r => h('span', { class: 'mono' }, detailed ? (r.ips || '') : (r.ips || '').split(', ')[0]) },
      { label: 'Where', get: r => r.host_id ? h('span', null, '⧉ on ', link(`#/devices/${r.host_id}`, r.host_name || 'host'))
        : r.rack_id ? placement(r) : (r.location_id ? nz(locPath(r.location_id), r.position ? `· ${r.position}` : '') : '') },
      { label: '⚑', get: r => taskFlag(hw(r)), sort: r => (hw(r).issues || 0) * 100 + (hw(r).tasks || 0) },
    ].filter(Boolean), list, { empty: rows.length ? 'No devices match the filters.' : 'No devices yet. Add your first one.', onRow: r => { location.hash = `#/devices/${r.id}`; } }));
  };
  render(
    pageHead('Devices', `${rows.length} device${rows.length === 1 ? '' : 's'}`,
      btn('⇪ Export / PDF', () => { location.hash = '#/export?ids=' + S.devVisible.join(','); }),
      btn('+ Add device', () => editEntity('devices', {}, r => { location.hash = `#/devices/${r.id}`; }), 'primary')),
    h('div', { class: 'toolbar' }, q, sel('status', 'All statuses', S.enums.device_statuses), moreFilters,
      h('label', { class: 'check inline-check view-toggle' }, h('input', { type: 'checkbox', checked: prefGet('harm-dev-detailed') === '1',
        onchange: e => { prefSet('harm-dev-detailed', e.target.checked ? '1' : '0'); draw(); } }), 'Hardware columns')),
    extra, holder);
  draw();
}

function prefGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function prefSet(k, v) { try { localStorage.setItem(k, v); } catch { /* not saved */ } }

const fmtGB = gb => gb == null ? '' : gb >= 1000 ? `${+(gb / 1000).toFixed(2)} TB` : `${+gb.toFixed(1)} GB`;

/* Raw → usable capacity for common layouts, for quick "what do I actually get" math. */
function raidCalc(groups) {
  const sizes = [];
  for (const g of groups) for (let i = 0; i < g.count; i++) sizes.push(g.gb);
  const n = sizes.length;
  if (n < 2) return null;
  const min = Math.min(...sizes), sum = sizes.reduce((a, b) => a + b, 0);
  const layouts = [
    ['Individual disks / JBOD', sum, 0, 1], ['RAID 0 (stripe, no redundancy)', sum, 0, 2],
    ['RAID 1 / mirror (all disks copies)', min, n - 1, 2], ['RAID 10 / mirrored pairs', Math.floor(n / 2) * min, 1, 4],
    ['RAID 5 / RAIDZ1', (n - 1) * min, 1, 3], ['RAID 6 / RAIDZ2', (n - 2) * min, 2, 4], ['RAIDZ3', (n - 3) * min, 3, 5],
  ].filter(l => n >= l[3]);
  const out = h('div', { class: 'raid-out' });
  const sel = h('select', { 'aria-label': 'Layout' }, layouts.map((l, i) => h('option', { value: i }, l[0])));
  const draw = () => {
    const [name, gb, fails] = layouts[+sel.value];
    fillEl(out, h('b', null, `≈ ${fmtGB(gb)} usable`), ' ',
      h('span', { class: 'muted small' }, `(≈ ${(gb * 1e9 / 2 ** 40).toFixed(2)} TiB as most OSes show it) · `,
        fails ? `survives ${name.startsWith('RAID 10') ? '1 disk per pair' : fails + ' disk failure' + (fails > 1 ? 's' : '')}` : 'no disk can fail'),
      new Set(sizes).size > 1 && !/JBOD|RAID 0/.test(name) ? h('div', { class: 'warn-text small' }, `Mixed sizes: redundant layouts use the smallest (${fmtGB(min)}) per disk.`) : null);
  };
  sel.addEventListener('change', draw);
  sel.value = String(Math.max(0, layouts.findIndex(l => l[0].startsWith(n >= 4 ? 'RAID 6' : n >= 3 ? 'RAID 5' : 'RAID 1'))));
  draw();
  return h('div', { class: 'raid-calc' }, h('label', null, 'If set up as '), sel, out);
}

function storageBody(st, legacy, { raid = true } = {}) {
  if (!st || !st.drives) {
    return legacy
      ? h('p', null, 'Noted: ', h('b', null, legacy), h('span', { class: 'muted small' }, ' (free-text note from before). Add the drives as parts, or use Import specs, to get real totals.'))
      : h('div', { class: 'empty' }, 'No drives recorded yet. Add them as parts (or use Import specs) and totals appear here.');
  }
  return h('div', null,
    h('div', { class: 'storage-total' }, h('b', null, st.total || 'None'), h('span', { class: 'muted' }, ` raw across ${st.drives} drive${st.drives === 1 ? '' : 's'}`)),
    h('ul', { class: 'plain storage-groups' }, st.groups.map(g => h('li', null,
      h('b', null, `${g.count} × ${g.capacity}`), ` ${g.category}`, h('span', { class: 'muted' }, ` = ${fmtGB(g.gb * g.count)}`)))),
    st.unknown ? h('p', { class: 'warn-text small' }, `${st.unknown} drive(s) have no size set.`) : null,
    raid ? raidCalc(st.groups) : null);
}

function badgeClass(status) {
  const s = (status || '').toLowerCase();
  return /^(active|running|in stock|new|built$|have$)/.test(s) ? 'ok'
    : /^(standby|testing|spare|reserved|planned|installed|planning|ordering|building|ordered)/.test(s) ? 'info'
      : /^(in repair|rma|used - fair)/.test(s) ? 'warn' : /^(broken|faulty)/.test(s) ? 'bad' : 'muted';
}

/* One-tap status change for a device. */
function statusSelect(dev, after) {
  return h('select', {
    class: `status-pill ${badgeClass(dev.status)}`, 'aria-label': `Status of ${dev.name}`, value: dev.status,
    onclick: e => e.stopPropagation(),
    onchange: async e => {
      const v = e.target.value;
      try {
        await api('PUT', `/devices/${dev.id}`, { status: v });
        toast(`${dev.name}: ${v}`);
        await loadLookups();
        (after || rerender)();
      } catch (x) { toast(x.message, 'bad'); e.target.value = dev.status; }
    },
  }, S.enums.device_statuses.map(st => h('option', { value: st }, st)));
}

function deviceChecklist(dev, d, actions) {
  const key = `harm-checklist-hidden:${dev.id}`;
  try { if (localStorage.getItem(key)) return null; } catch { /* storage unavailable */ }
  const steps = [
    [!!dev.serial, 'Serial number / service tag', actions.edit],
    [!!(dev.location_id || dev.rack_id), 'Where it lives', actions.edit],
    [!!(d.cpus.items.length || d.memory.sticks || dev.cpu || dev.ram), 'CPU & memory', actions.importSpecs, 'Import specs'],
    [d.storage.drives > 0 || !/server|nas|san|das|desktop|workstation|hypervisor/i.test(dev.device_type || ''), 'Drives', actions.addDrive, 'Add drives'],
    [d.interfaces.length > 0, 'Network (IP / MAC)', actions.addIface, 'Add interface'],
    [d.credentials.length > 0, 'Login (iDRAC / iLO / OS)', actions.addLogin, 'Add login'],
  ];
  const todo = steps.filter(x => !x[0]);
  if (!todo.length) return null;
  const el = h('div', { class: 'card checklist' },
    h('div', { class: 'card-head' }, h('h3', null, `Finish setting up · ${steps.length - todo.length}/${steps.length} done`),
      small('Hide', () => { try { localStorage.setItem(key, '1'); } catch { /* ignore */ } el.remove(); })),
    h('div', { class: 'check-steps' }, steps.map(([done, label, fn, btnLabel]) => h('div', { class: 'check-step' + (done ? ' done' : '') },
      h('span', { class: 'tick' }, done ? '✓' : '○'), h('span', null, label),
      done ? null : small(btnLabel || 'Add', fn)))));
  return el;
}

async function viewDevice(id, q) {
  const d = await GET(`/devices/${id}/full`);
  S.tabs = S.tabs || {};
  if (q && q.get('tab')) S.tabs.device = q.get('tab');
  const dev = d.device;
  const back = () => viewDevice(id);
  const preset = { device_id: id };
  const actions = {
    edit: () => editEntity('devices', dev, back),
    importSpecs: () => importSpecs(dev, d, back),
    addDrive: () => editEntity('components', { device_id: id, status: 'Installed', category: 'HDD', quantity: 1 }, back),
    addIface: () => editEntity('interfaces', preset, back),
    addLogin: () => editCredential({ ...preset, label: `${dev.name} admin` }, back),
  };

  const toggle = h('button', { type: 'button', class: 'toggle ' + (dev.connected ? 'on' : 'off'), onclick: async () => {
    try { await api('PUT', `/devices/${id}`, { connected: !dev.connected }); await loadLookups(); back(); } catch (e) { toast(e.message, 'bad'); }
  } }, dot(dev.connected), dev.connected ? 'Hooked up' : 'Not hooked up');

  const clone = () => {
    const copyRec = { ...dev };
    for (const k of ['id', 'serial', 'asset_tag', 'rack_u', 'hostname', 'created_at', 'updated_at']) delete copyRec[k];
    copyRec.name = dev.name.replace(/#(\d+)$/, (_m, n) => `#${+n + 1}`);
    if (copyRec.name === dev.name) copyRec.name += ' (copy)';
    editEntity('devices', copyRec, r => { location.hash = `#/devices/${r.id}`; });
  };

  const rackInfo = dev.rack_id ? h('span', null, link(`#/racks/${dev.rack_id}`, dev.rack_name),
    dev.rack_u ? `, U${dev.rack_u}${dev.u_height > 1 ? ' to U' + (dev.rack_u + dev.u_height - 1) : ''}, ${dev.rack_face}${dev.full_depth ? ', full depth' : ''}` : ' (no U position)') : '';

  const isCpuSlot = sl => !/ddr|dimm|pcie|m\.2|sas|sata|u\.2|ocp|sfp|mezz/i.test(sl.interface) && /lga|am\d|sp\d|c32|g34|str|socket|fm\d/i.test(`${sl.interface} ${sl.label || ''}`);
  const otherSlots = d.slots.filter(sl => !sl.drive_bay && !/ddr|dimm/i.test(sl.interface) && !isCpuSlot(sl));
  const slotCards = otherSlots.map(sl => {
    const pct = sl.total ? Math.min(100, (sl.used / sl.total) * 100) : 0;
    const fill = h('div', { class: 'bar-fill' + (sl.used > sl.total ? ' hot' : '') });
    fill.style.width = pct + '%';
    const free = sl.total - sl.used;
    const compat = h('div', { class: 'compat', hidden: true },
      sl.compatible.length ? table([
        { label: 'Part', get: c => nz(c.manufacturer, c.model) || c.category },
        { label: 'Size', get: c => c.capacity || '' },
        { label: 'Connection', get: c => nz(c.interface, c.form_factor) },
        { label: 'Qty', get: c => c.quantity },
        { label: 'Stored', get: c => [c.rack_name, c.position].filter(Boolean).join(' · ') || c.location_name || '' },
        { label: '', nosort: true, get: c => small('Install', () => installDialog(c, id, back), 'primary') },
      ], sl.compatible) : h('div', { class: 'empty' }, 'No compatible spares in stock.'));
    const raidNote = /^raid$/i.test(sl.interface || '')
      ? h('div', { class: 'warn-text small' }, '“Raid” isn’t a connection type (RAID is set up on the controller). Edit this and pick SAS or SATA so spare drives match properly.') : null;
    return h('div', { class: 'slot' },
      h('div', { class: 'slot-head' },
        h('div', null, h('b', null, sl.interface), sl.form_factor ? ` · ${sl.form_factor}` : '', sl.notes ? h('div', { class: 'muted small' }, sl.notes) : null),
        h('div', { class: 'row-actions' },
          sl.compatible.length && free > 0 ? small(`${sl.compatible.length} spare${sl.compatible.length > 1 ? 's' : ''} fit`, () => { compat.hidden = !compat.hidden; }, 'info') : null,
          small('Edit', () => editEntity('device_slots', sl, back)),
          small('Delete', () => deleteEntity('device_slots', sl, back), 'ghost-danger'))),
      h('div', { class: 'bar-row' }, h('div', { class: 'bar' }, fill), h('div', { class: 'bar-n' }, `${sl.used}/${sl.total} used`)),
      raidNote, compat);
  });

  // At a glance: where it is, how to reach it, and one-tap logins.
  // The device's main address: the one marked primary, else the first that isn't a management port (iDRAC/iLO/IPMI).
  const ips = d.interfaces.filter(i => i.ip);
  const isMgmt = i => i.kind === 'IPMI / BMC' || /idrac|ilo|ipmi|bmc|mgmt|management/i.test(i.name || '');
  const mainIface = ips.find(i => i.is_primary) || ips.find(i => !isMgmt(i)) || ips[0];
  const mainIp = mainIface?.ip;
  const setPrimary = async i => { try { await api('PUT', `/interfaces/${i.id}`, { is_primary: true }); toast(`${i.ip} is now the main address`); back(); } catch (e) { toast(e.message, 'bad'); } };
  const ipFact = !mainIp ? null : ips.length < 2
    ? h('button', { type: 'button', class: 'fact mono', title: 'Copy IP', onclick: () => copy(mainIp, 'IP') }, h('span', null, '🌐'), mainIp)
    : (() => {
      const menu = h('div', { class: 'qa-menu pop-menu ip-menu', hidden: true, role: 'menu' },
        h('div', { class: 'qa-group' }, 'Addresses: tap to copy'),
        ips.map(i => h('div', { class: 'ip-row' },
          h('button', { type: 'button', role: 'menuitem', class: 'ip-copy', onclick: () => { menu.hidden = true; copy(i.ip, 'IP'); } },
            h('span', { class: 'mono' }, i.ip), h('span', { class: 'muted small' }, nz(i.name, isMgmt(i) ? '· management' : '', i.id === mainIface.id ? '· main' : ''))),
          i.id === mainIface.id && i.is_primary ? h('span', { class: 'ip-star', title: 'Main address' }, '★')
            : h('button', { type: 'button', class: 'sm ghost', title: 'Use this as the main address (quick links, logins, lists)', onclick: () => { menu.hidden = true; setPrimary(i); } }, '☆ Main'))));
      return h('span', { class: 'qa pop' },
        h('button', { type: 'button', class: 'fact mono', title: 'All addresses', onclick: () => { document.querySelectorAll('.pop-menu').forEach(m => { if (m !== menu) m.hidden = true; }); menu.hidden = !menu.hidden; } },
          h('span', null, '🌐'), mainIp, h('span', { class: 'muted small' }, ` +${ips.length - 1} ▾`)), menu);
    })();
  const openNotes = d.notes.filter(n => (n.kind === 'task' || n.kind === 'issue') && !n.done);
  S.tabs = S.tabs || {};
  const fact = (ico, content, title) => h('span', { class: 'fact', title }, h('span', null, ico), content);
  const facts = h('div', { class: 'facts' },
    dev.location_id || dev.rack_id ? fact('📍', h('span', null,
      dev.rack_id ? link(`#/racks/${dev.rack_id}`, dev.rack_name) : link(`#/locations/${dev.location_id}`, locPath(dev.location_id)),
      dev.rack_u ? ` · U${dev.rack_u}` : (dev.position ? ` · ${dev.position}` : '')), 'Where it is') : null,
    dev.host_id ? fact('🖥', h('span', null, 'Runs on ', link(`#/devices/${dev.host_id}`, dev.host_name || 'host'), dev.vm_id ? ` · ID ${dev.vm_id}` : ''), 'Host') : null,
    dev.cluster_id ? fact('🧩', link(`#/clusters/${dev.cluster_id}`, dev.cluster_name || 'cluster'), 'Cluster') : null,
    ipFact,
    dev.mgmt_url ? fact('🖥', h('a', { href: dev.mgmt_url, target: '_blank', rel: 'noopener noreferrer' }, 'Management ↗'), dev.mgmt_url) : null,
    d.credentials.slice(0, 3).map(c => h('button', { type: 'button', class: 'fact', title: 'Open / reveal this login', onclick: () => revealCredential(c) },
      h('span', null, '🔑'), c.label)),
    openNotes.length ? h('button', { type: 'button', class: 'fact', title: 'Open tasks and issues', onclick: () => { S.tabs.device = 'overview'; back(); } },
      h('span', null, '⚑'), h('span', { class: 'warn-text' }, `${openNotes.length} open`)) : null);

  const hwCount = d.components.reduce((n, c) => n + (c.quantity || 1), 0);
  const virtual = isVirtual(dev);
  const showGuests = !virtual && (d.guests.length > 0 || /hypervisor|server|nas|mini pc|desktop|workstation/i.test(dev.device_type || ''));
  const deleteDev = () => deleteEntity('devices', dev, () => goBackOr('#/devices'),
    'Its interfaces, services, slots and cable records will be deleted. Installed parts go back to stock.');
  render(
    h('div', { class: 'crumbs' }, backLink(), link('#/devices', 'Devices'), ' › ', dev.name),
    pageHead(h('span', null, dev.name), nz(dev.device_type, dev.manufacturer, dev.model) || null,
      statusSelect(dev, back),
      toggle,
      btn('Edit', actions.edit, 'primary'),
      menuButton('⋯', [
        ['⇩ Import specs…', actions.importSpecs],
        ['📝 Add note or task', () => { S.tabs.device = 'overview'; back().then(() => document.querySelector('.note-input')?.focus()); }],
        ['⇪ Export / PDF / sell sheet', () => { location.hash = `#/export?ids=${id}`; }],
        ['🏷 Print label…', () => printLabels([id])],
        ['⎘ Clone…', clone],
        ['🗑 Delete', deleteDev, 'danger-item'],
      ])),
    facts,
    deviceChecklist(dev, d, actions),
    tabs('device', [
      ['overview', 'Overview', null, () => [
        journalCard('devices', id, d.notes, back),
        h('div', { class: 'grid two' },
          card('Details', kv([
            ...(virtual ? [['Runs on', dev.host_id ? link(`#/devices/${dev.host_id}`, dev.host_name || 'host') : 'Not set'], ['VM / container ID', dev.vm_id],
              ['vCPUs', dev.vcpus], ['Memory', dev.vm_ram_gb != null ? `${dev.vm_ram_gb} GB` : ''], ['Disk', dev.vm_disk_gb != null ? `${dev.vm_disk_gb} GB` : '']] : []),
            ['Cluster', dev.cluster_id ? link(`#/clusters/${dev.cluster_id}`, dev.cluster_name || 'cluster') : ''],
            ['Serial / service tag', dev.serial ? h('span', { class: 'inline' }, h('span', { class: 'mono' }, dev.serial), small('Copy', () => copy(dev.serial, 'Serial'))) : ''],
            ['Hostname', dev.hostname ? h('span', { class: 'mono' }, dev.hostname) : ''],
            ['OS / firmware', dev.os],
            ['CPU', d.cpus.items.length ? `${d.cpus.items.map(x => (x.qty > 1 ? x.qty + '× ' : '') + x.name).join(', ')} · ${d.cpus.cores} cores / ${d.cpus.threads} threads` : dev.cpu],
            ['RAM', d.memory.sticks ? `${d.memory.total} (${d.memory.groups.map(g => `${g.count}× ${g.capacity}`).join(', ')})` : dev.ram],
            ['Storage', d.storage.drives ? `${d.storage.total} raw in ${d.storage.drives} drives` : null],
            ['Power supply', dev.psu], ['Typical draw', dev.power_draw_w != null ? `${dev.power_draw_w} W` : ''],
            ['Asset tag', dev.asset_tag],
            ['Tags', dev.tags ? h('span', null, dev.tags.split(',').map(t => t.trim()).filter(Boolean).map(t => h('span', { class: 'tag' }, t))) : ''],
            ['PC build', d.builds.length ? h('span', null, d.builds.map(b => link(`#/builds/${b.id}`, b.name))) : ''],
          ])),
          card('Location & purchase', kv([
            ['Location', dev.location_id ? link(`#/locations/${dev.location_id}`, locPath(dev.location_id)) : ''],
            ['Rack / holder', rackInfo],
            ['Spot', dev.position],
            ['Purchased', nz(dev.purchase_date, dev.vendor ? `from ${dev.vendor}` : '')],
            ['Price', money(dev.purchase_price)],
            ['Original price', money(dev.msrp)],
            ['Current value', dev.market_value != null ? `${money(dev.market_value)}${dev.value_checked ? ` (checked ${dev.value_checked})` : ''}` : ''],
            ['Warranty until', warrantyCell(dev.warranty_until)],
            ['Added', dev.created_at], ['Updated', dev.updated_at],
          ]))),
      ]],
      ...(showGuests ? [['vms', 'VMs', d.guests.length || null, () => guestsCard(dev, d, back)]] : []),
      ...(virtual ? [] : [['hardware', 'Hardware', hwCount || null, () => [
        h('div', { class: 'grid two hw' }, cpuCard(dev, d, back), memoryCard(dev, d, back)),
        storageCard(dev, d, back),
        card('All installed parts', table([
          { label: 'What', get: r => r.category },
          { label: 'Part', get: r => nz(r.manufacturer, r.model) },
          { label: 'Size', get: r => r.capacity || '' },
          { label: 'Connection', get: r => nz(r.interface, r.form_factor) },
          { label: 'Serial', get: r => h('span', { class: 'mono' }, r.serial || '') },
          { label: 'Qty', get: r => r.quantity },
          { label: 'Health', get: r => r.health || '' },
          { label: '', nosort: true, get: r => h('div', { class: 'row-actions' },
            small('Remove', () => uninstallDialog(r, back)), small('Edit', () => editEntity('components', r, back))) },
        ], d.components, { empty: 'No parts recorded inside this device.' }),
          small('+ Add part', () => editEntity('components', { device_id: id, status: 'Installed', quantity: 1 }, back))),
        card('Expansion & other slots', slotCards.length ? h('div', { class: 'slots' }, slotCards)
          : h('div', { class: 'empty' }, 'PCIe, M.2, CPU sockets, PSU bays… Record them to see which spare parts fit.'),
          small('+ Add', () => editEntity('device_slots', { ...preset, total: 1, _kind: 'PCIe slots' }, back))),
      ]]]),
      ['network', 'Network', (d.interfaces.length + d.services.length + d.connections.length) || null, () => [
        card('Network interfaces', ifaceTable(d.interfaces, back), small('+ Add', actions.addIface)),
        card('Services', table([
          { label: 'Service', get: r => r.name },
          { label: 'Port', get: r => nz(r.protocol, r.port) },
          { label: 'URL', get: r => extLink(r.url) },
          { label: 'Version', get: r => r.version || '' },
          { label: 'Status', get: r => badge(r.status) },
          { label: '', nosort: true, get: r => rowActions('services', r, back) },
        ], d.services, { empty: 'No services recorded.' }), small('+ Add', () => editEntity('services', preset, back))),
        card('Cables & connections', connTable(d.connections, back, id),
          small('+ Add', () => editEntity('connections', { a_device_id: id }, back))),
      ]],
      ['logins', 'Logins', d.credentials.length || null, () => [
        card('Logins', credTable(d.credentials, back), small('+ Add', actions.addLogin)),
      ]],
    ]));
  // Links from search open the item itself: #/devices/5?tab=network&edit=interfaces-12, ?open=<login id>
  if (q && (q.get('edit') || q.get('open'))) {
    const [ent, rid] = (q.get('edit') || '').split('-');
    const rec = ent === 'interfaces' ? d.interfaces.find(r => String(r.id) === rid)
      : ent === 'services' ? d.services.find(r => String(r.id) === rid) : null;
    const cred = q.get('open') ? d.credentials.find(c => String(c.id) === q.get('open')) : null;
    cleanHash(`#/devices/${id}`);
    if (rec) editEntity(ent, rec, back);
    if (cred) revealCredential(cred);
  }
}

function credTable(rows, after) {
  return table([
    { label: 'Label', get: r => h('a', { href: '#', onclick: e => { e.preventDefault(); revealCredential(r); } }, r.label) },
    { label: 'Kind', get: r => r.kind || '' },
    { label: 'Username', get: r => r.username ? h('span', { class: 'inline' }, h('code', null, r.username), small('Copy', () => copy(r.username, 'Username'))) : '' },
    { label: 'Device', get: r => r.device_id ? link(`#/devices/${r.device_id}`, r.device_name) : '' },
    { label: 'URL', get: r => extLink(r.url) },
    { label: '2FA', get: r => r.has_totp ? '✓' : '' },
    { label: 'Rotated', get: r => r.last_rotated || '' },
    { label: '', nosort: true, get: r => h('div', { class: 'row-actions' },
      small('Open ↗', () => revealCredential(r), 'primary'),
      r.has_password ? small('Copy pw', async () => {
        try { const s = await api('POST', `/credentials/${r.id}/reveal`); copy(s.password, 'Password'); } catch (e) { toast(e.message, 'bad'); }
      }) : null,
      small('Edit', () => editCredential(r, after)),
      small('Delete', () => deleteEntity('credentials', r, after), 'ghost-danger')) },
  ], rows, { empty: 'No logins stored.' });
}

function connTable(rows, after, perspective) {
  return table([
    { label: 'From', get: r => {
      const flip = perspective && r.b_device_id === perspective && r.a_device_id !== perspective;
      return flip ? h('span', null, r.b_port || 'None') : h('span', null, perspective ? '' : link(`#/devices/${r.a_device_id}`, r.a_device_name), perspective ? '' : ' : ', r.a_port || 'None');
    } },
    { label: 'To', get: r => {
      const flip = perspective && r.b_device_id === perspective && r.a_device_id !== perspective;
      if (flip) return h('span', null, link(`#/devices/${r.a_device_id}`, r.a_device_name), ' : ', r.a_port || 'None');
      return r.b_device_id ? h('span', null, link(`#/devices/${r.b_device_id}`, r.b_device_name), ' : ', r.b_port || 'None') : h('span', { class: 'muted' }, r.b_endpoint || '');
    } },
    { label: 'Medium', get: r => r.medium || '' },
    { label: 'Speed', get: r => r.speed || '' },
    { label: 'Label', get: r => r.cable_label || '' },
    { label: 'Length', get: r => r.length || '' },
    { label: 'Color', get: r => r.color || '' },
    { label: '', nosort: true, get: r => rowActions('connections', r, after) },
  ], rows, { empty: 'No cables recorded.' });
}

// ---------------------------------------------------------------- views: racks

async function viewRacks() {
  const rows = await GET('/racks');
  render(
    pageHead('Racks & Storage', 'Racks, cabinets, shelves, bins, totes and piles: anything that holds hardware.',
      helpLink('piles'),
      btn('+ Add holder', () => editEntity('racks', { kind: 'Rack', height_u: 42 }, r => { location.hash = `#/racks/${r.id}`; }), 'primary')),
    rows.length ? h('div', { class: 'tiles' }, rows.map(rackTile)) : h('div', { class: 'empty' }, 'No racks or holders yet. Loose gear can live directly in a location.'));
}


// Kinds of device for the rack drawing, in the design system's category order (--zb-cat-1 to 6, then Other).
const DEVICE_CATEGORIES = [
  ['Servers and computers', ['Server', 'Hypervisor Host', 'Workstation', 'Desktop', 'Laptop', 'Mini PC', 'SBC (Raspberry Pi etc.)']],
  ['Network', ['Switch', 'Router', 'Firewall', 'Access Point', 'Modem / ONT', 'Patch Panel']],
  ['Storage', ['NAS', 'SAN / DAS']],
  ['Power', ['UPS', 'PDU']],
  ['Other gear', ['KVM', 'Console Server', 'Printer', 'Camera / NVR', 'IoT', 'Monitor', 'Phone', 'Tablet', 'TV / Streaming', 'Game Console', 'Smart Home', 'Wearable']],
  ['Accessories', ['Cable Manager', 'Shelf / Tray']],
];
function deviceCategory(type) {
  const i = DEVICE_CATEGORIES.findIndex(([, types]) => types.includes(type));
  return i < 0 ? ['other', 'Other'] : [i + 1, DEVICE_CATEGORIES[i][0]];
}
function elevation(rack, devices, face, onEmpty) {
  const H = rack.height_u;
  const rowOf = u => rack.numbering_desc ? u : H - u + 1;
  const grid = h('div', { class: 'rack-grid' });
  grid.style.gridTemplateRows = `repeat(${H}, var(--u))`;
  for (let u = 1; u <= H; u++) {
    const lab = h('div', { class: 'u-label' }, u);
    lab.style.gridRow = String(rowOf(u));
    const slot = h('button', { type: 'button', class: 'u-slot', title: `U${u}: empty`, onclick: () => onEmpty(u, face) });
    slot.style.gridRow = String(rowOf(u));
    const lab2 = lab.cloneNode(true);
    lab.style.gridColumn = '1';
    slot.style.gridColumn = '2';
    lab2.style.gridColumn = '3';
    grid.append(lab, slot, lab2);
  }
  for (const d of devices) {
    if (!d.rack_u) continue;
    const mine = d.rack_face === face;
    if (!mine && !d.full_depth) continue;
    const top = d.rack_u + d.u_height - 1;
    const start = Math.min(rowOf(d.rack_u), rowOf(top));
    const typeCls = 'cat-' + deviceCategory(d.device_type)[0];
    const el = h('a', {
      class: `u-dev ${typeCls}${mine ? '' : ' ghost'}${d.connected ? '' : ' unplugged'} st-${badgeClass(d.status)}`,
      href: `#/devices/${d.id}`,
      title: `${d.name}, U${d.rack_u}${d.u_height > 1 ? '-' + top : ''}${mine ? '' : ` (mounted ${d.rack_face}, full depth)`}`,
    }, h('span', { class: 'u-dev-name' }, d.name), d.u_height > 1 || d.device_type ? h('span', { class: 'u-dev-sub' }, nz(d.device_type, d.model)) : null,
    d.status !== 'Active' ? h('span', { class: 'u-dev-status' }, d.status) : null,
    mine ? taskFlag(d._sum) : null, dot(d.connected));
    el.style.gridRow = `${start} / span ${d.u_height}`;
    el.style.gridColumn = '2';
    grid.append(el);
  }
  const kinds = [...new Map(devices.filter(d => d.rack_u && (d.rack_face === face || d.full_depth))
    .map(d => deviceCategory(d.device_type)).map(c => [c[0], c])).values()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return h('div', { class: 'rack-col' }, h('div', { class: 'rack-face-label' }, face === 'front' ? 'Front' : 'Rear'), h('div', { class: 'rack-frame' }, grid),
    kinds.length ? h('div', { class: 'cat-legend', 'aria-label': 'Kinds of device' }, kinds.map(([n, label]) => h('span', { class: `cat-${n}` }, h('i'), label))) : null);
}

async function viewRack(id) {
  const [{ rack, devices, components }, rackNotes, sum] = await Promise.all([GET(`/racks/${id}/layout`), GET(`/notes?entity=racks&entity_id=${id}`), GET('/devices/summary')]);
  for (const d of devices) d._sum = sum.devices[d.id];
  const back = () => viewRack(id);
  const unplaced = devices.filter(d => !d.rack_u);

  const onEmpty = (u, face) => {
    const cands = S.lk.devices.filter(d => !d.rack_u && d.id);
    const pick = h('select', null, h('option', { value: '' }, 'Choose a device'),
      cands.map(d => h('option', { value: String(d.id) }, d.name + (d.rack_id ? ` (in ${d.rack_name})` : ''))));
    const height = h('input', { type: 'number', min: 1, value: 1 });
    pick.addEventListener('change', () => { const d = cands.find(x => String(x.id) === pick.value); if (d) height.value = d.u_height || 1; });
    const err = h('div', { class: 'form-error' });
    const m = modal(`U${u} (${face})`, h('div', null,
      h('p', null, btn(`+ New device at U${u}`, () => {
        m.close();
        editEntity('devices', { rack_id: id, rack_u: u, rack_face: face, u_height: 1, location_id: rack.location_id, status: 'Active', full_depth: true }, back);
      }, 'primary')),
      cands.length ? h('div', null,
        h('h4', null, 'Or place an existing device'),
        h('div', { class: 'form-grid' },
          h('div', { class: 'field wide' }, h('label', null, 'Device'), pick),
          h('div', { class: 'field' }, h('label', null, 'Height (U)'), height)),
        err,
        h('div', { class: 'actions' }, btn('Place here', async () => {
          if (!pick.value) return (err.textContent = 'Choose a device');
          try {
            await api('PUT', `/devices/${pick.value}`, { rack_id: id, rack_u: u, rack_face: face, u_height: height.value || 1 });
            await loadLookups(); m.close(); toast('Placed'); back();
          } catch (e) { err.textContent = e.message; }
        }, 'primary'))) : null));
  };

  const contents = h('div', null,
    journalCard('racks', id, rackNotes, back),
    card(rack.height_u ? 'In this holder without a U position' : 'Devices here', table([
      { label: '', get: r => dot(r.connected), cls: 'narrow' },
      { label: 'Device', get: r => link(`#/devices/${r.id}`, r.name) },
      { label: 'Type', get: r => r.device_type || '' },
      { label: 'Status', get: r => statusSelect(r, back), sort: r => r.status },
      { label: 'Position', get: r => r.position || '' },
    ], rack.height_u ? unplaced : devices, { empty: 'None.' }),
      small('+ Device', () => editEntity('devices', { rack_id: id, location_id: rack.location_id, status: 'Active', full_depth: true }, back))),
    card('Spare parts stored here', table([
      { label: 'Category', get: r => r.category },
      { label: 'Part', get: r => link(`#/components?id=${r.id}`, nz(r.manufacturer, r.model) || r.category) },
      { label: 'Capacity', get: r => r.capacity || '' },
      { label: 'Interface', get: r => nz(r.interface, r.form_factor) },
      { label: 'Qty', get: r => r.quantity },
      { label: 'Position', get: r => r.position || '' },
      { label: 'Status', get: r => badge(r.status) },
    ], components, { empty: 'No parts stored here.' }),
      small('+ Part', () => editEntity('components', { rack_id: id, location_id: rack.location_id, status: 'In Stock', quantity: 1 }, back))));

  render(
    h('div', { class: 'crumbs' }, backLink(), link('#/racks', 'Racks & Storage'), ' › ', rack.name),
    pageHead(rack.name, nz(rack.kind, rack.height_u ? `· ${rack.height_u}U` : '', rack.location_id ? '· ' + locPath(rack.location_id) : '', rack.manufacturer ? '· ' + nz(rack.manufacturer, rack.model) : ''),
      btn('🤖 AI Assist here', () => aiAssist({ rack_id: id, location_id: rack.location_id })),
      btn('Edit', () => editEntity('racks', rack, back)),
      menuButton('⋯', [['🗑 Delete', () => deleteEntity('racks', rack, () => goBackOr('#/racks'), 'Devices and parts inside will stay, but lose their holder.'), 'danger-item']])),
    rack.notes ? h('div', { class: 'card notes' }, rack.notes) : null,
    rack.height_u ? h('div', { class: 'rack-layout' },
      h('div', { class: 'rack-pair' }, elevation(rack, devices, 'front', onEmpty), elevation(rack, devices, 'rear', onEmpty)),
      h('div', { class: 'rack-side' },
        h('p', { class: 'muted small' }, 'Click an empty unit to add or place a device there. Faded blocks are full-depth devices mounted on the other face. Striped blocks are not hooked up.'),
        contents)) : contents);
}

// ---------------------------------------------------------------- views: components

function compWhere(r) {
  if (r.device_id) return h('span', null, 'in ', link(`#/devices/${r.device_id}`, r.device_name));
  if (r.rack_id) return h('span', null, link(`#/racks/${r.rack_id}`, r.rack_name), r.position ? ` · ${r.position}` : '');
  return nz(r.location_id ? locPath(r.location_id) : '', r.position);
}

async function installDialog(comp, deviceId, after) {
  let fits = [];
  try { fits = await GET(`/components/${comp.id}/fits`); } catch { /* optional */ }
  const fitIds = new Map(fits.map(f => [f.device_id, f]));
  const devs = [...S.lk.devices].sort((a, b) => (fitIds.has(b.id) - fitIds.has(a.id)) || a.name.localeCompare(b.name));
  formDialog({
    title: `Install ${nz(comp.manufacturer, comp.model) || comp.category}`,
    fields: [
      { k: 'device_id', label: 'Into device', type: 'select', required: true,
        options: devs.map(d => ({ value: String(d.id), label: (fitIds.has(d.id) ? `★ ${d.name}: ${fitIds.get(d.id).free} free ${fitIds.get(d.id).slot}` : d.name) })) },
      comp.quantity > 1 ? { k: 'quantity', label: `How many (of ${comp.quantity})`, type: 'number', min: 1, default: 1 } : null,
    ].filter(Boolean),
    rec: { device_id: deviceId ? String(deviceId) : (fits[0] ? String(fits[0].device_id) : ''), quantity: 1 },
    extra: fits.length ? h('p', { class: 'muted small' }, '★ marks devices with a free slot matching this part’s interface and form factor.') : h('p', { class: 'muted small' }, 'No device has a recorded free slot matching this part. Add slots on a device page to get suggestions.'),
    saveLabel: 'Install',
    submit: async v => { await api('POST', `/components/${comp.id}/install`, { device_id: v.device_id, quantity: v.quantity || 1 }); toast('Installed'); },
    onDone: () => (after || rerender)(),
  });
}

function uninstallDialog(comp, after) {
  formDialog({
    title: `Remove ${nz(comp.manufacturer, comp.model) || comp.category} from ${comp.device_name}`,
    fields: [
      { k: 'status', label: 'New status', type: 'select', options: S.enums.component_statuses.filter(s => s !== 'Installed'), required: true, default: 'In Stock' },
      { k: 'location_id', label: 'Location (room)', type: 'fk', entity: 'locations' },
      { k: 'rack_id', label: 'Store in (holder)', type: 'fk', entity: 'racks', none: 'None (loose in the room)', scopeBy: ['location_id'], scope: rackInLocation, onChange: rackPicked },
      { k: 'position', label: 'Spot', ph: 'Bin 2' },
    ],
    saveLabel: 'Remove',
    submit: async v => { await api('POST', `/components/${comp.id}/uninstall`, v); toast('Removed'); },
    onDone: () => (after || rerender)(),
  });
}

const parseSizeGB = t => { const m = /^\s*(\d+(?:\.\d+)?)\s*(TB|GB)\s*$/i.exec(t || ''); return m ? +m[1] * (m[2].toUpperCase() === 'TB' ? 1000 : 1) : null; };
const STORAGE_CATS = /^(HDD|SSD|NVMe SSD|USB \/ Flash)$/;
/* "Drives here: 12 × 4 TB HDD, 6 × 1 TB HDD = 54 TB" for the parts shown. */
function storageSummaryLine(list) {
  const groups = new Map();
  let total = 0, n = 0;
  for (const r of list) {
    if (!STORAGE_CATS.test(r.category)) continue;
    const gb = parseSizeGB(r.capacity);
    n += r.quantity;
    if (!gb) continue;
    const key = `${r.capacity} ${r.category}`;
    groups.set(key, (groups.get(key) || 0) + r.quantity);
    total += gb * r.quantity;
  }
  if (!n) return [];
  return [h('b', null, `💾 ${fmtGB(total)} of drives`), ` in ${n} drive${n === 1 ? '' : 's'}: `,
    [...groups].sort((a, b) => (parseSizeGB(b[0].split(' ').slice(0, 2).join(' ')) || 0) - (parseSizeGB(a[0].split(' ').slice(0, 2).join(' ')) || 0))
      .map(([k, c]) => `${c} × ${k}`).join(' · ')];
}

async function viewComponents(q) {
  const rows = await GET('/components');
  const F = S.filters.components;
  const holder = h('div');
  const tabs = [['spares', 'Spares in stock', r => !r.device_id && r.status === 'In Stock'],
    ['installed', 'Installed', r => !!r.device_id], ['other', 'RMA / faulty / reserved', r => !r.device_id && r.status !== 'In Stock'],
    ['all', 'All', () => true]];
  const qi = h('input', { type: 'search', placeholder: 'Filter…', value: F.q || '', oninput: e => { F.q = e.target.value; draw(); } });
  const cats = [...new Set(rows.map(r => r.category))].sort();
  const catSel = h('select', { value: F.cat || '', onchange: e => { F.cat = e.target.value; draw(); } },
    h('option', { value: '' }, 'All categories'), cats.map(c => h('option', { value: c }, c)));
  const ifaces = [...new Set(rows.map(r => r.interface).filter(Boolean))].sort();
  const ifSel = h('select', { value: F.iface || '', onchange: e => { F.iface = e.target.value; draw(); } },
    h('option', { value: '' }, 'All interfaces'), ifaces.map(c => h('option', { value: c }, c)));
  const tabBar = h('div', { class: 'tabs' });
  const sumBox = h('div', { class: 'storage-sum' });
  const draw = () => {
    tabBar.replaceChildren(...tabs.map(([k, label, fn]) => h('button', { type: 'button', class: F.tab === k ? 'active' : '', onclick: () => { F.tab = k; draw(); } }, `${label} (${rows.filter(fn).reduce((a, r) => a + r.quantity, 0)})`)));
    const tf = tabs.find(t => t[0] === F.tab)[2];
    const needle = (F.q || '').toLowerCase();
    const list = rows.filter(r => tf(r) && (!F.cat || r.category === F.cat) && (!F.iface || r.interface === F.iface) &&
      (!needle || [r.manufacturer, r.model, r.part_number, r.serial, r.capacity, r.interface, r.form_factor, r.tags, r.notes, r.device_name].some(x => x && x.toLowerCase().includes(needle))));
    sumBox.replaceChildren(...storageSummaryLine(list, F.tab));
    holder.replaceChildren(table([
      { label: 'Category', get: r => r.category },
      { label: 'Part', get: r => h('span', null, h('b', null, nz(r.manufacturer, r.model) || 'None'), r.part_number ? h('div', { class: 'muted small mono' }, r.part_number) : null) },
      { label: 'Capacity', get: r => r.capacity || '' },
      { label: 'Interface', get: r => nz(r.interface, r.form_factor) },
      { label: 'Speed', get: r => r.speed || '' },
      { label: 'Qty', get: r => r.quantity, sort: r => r.quantity },
      { label: 'Status', get: r => badge(r.status) },
      { label: 'Condition', get: r => r.condition || '' },
      { label: 'Where', get: r => compWhere(r) },
      { label: 'Serial', get: r => h('span', { class: 'mono small' }, r.serial || '') },
      { label: '', nosort: true, get: r => h('div', { class: 'row-actions' },
        r.device_id ? small('Remove', () => uninstallDialog(r)) : (r.quantity > 0 ? small('Install', () => installDialog(r), 'primary') : null),
        small('Edit', () => editEntity('components', r)),
        small('Delete', () => deleteEntity('components', r), 'ghost-danger')) },
    ], list, { empty: rows.length ? 'No parts match.' : 'No parts cataloged yet.', rowClass: r => (q && q.get('id') === String(r.id)) ? 'hl' : '' }));
  };
  render(
    pageHead('Spare Parts', 'Drives, memory, cards, cables: everything on the shelf or inside a device.',
      helpLink('parts'),
      btn('🤖 AI Assist', () => aiAssist()),
      menuButton('⋯', [['⇩ Export CSV', () => { openDownload('/api/export/components.csv'); }]]),
      btn('+ Add part', () => editEntity('components', { status: 'In Stock', quantity: 1 }), 'primary')),
    tabBar,
    h('div', { class: 'toolbar' }, qi, catSel, ifSel),
    sumBox,
    holder);
  const hit = q && q.get('id') ? rows.find(r => String(r.id) === q.get('id')) : null;
  if (hit) F.tab = tabs.find(t => t[2](hit))[0];
  draw();
  if (hit) { cleanHash('#/components'); editEntity('components', hit, () => viewComponents()); }
}

// ---------------------------------------------------------------- views: connections, locations, vault, audit

async function viewConnections() {
  const rows = await GET('/connections');
  render(
    pageHead('Connections', 'Cables and links between devices: network, storage, power, console.',
      h('a', { class: 'button', href: '/api/export/connections.csv' }, 'Export CSV'),
      btn('+ Add connection', () => editEntity('connections', {}), 'primary')),
    card('All connections', connTable(rows)));
}

async function viewLocations() {
  const rows = S.lk.locations = await GET('/locations');
  const children = pid => rows.filter(r => (r.parent_id || null) === pid).sort((a, b) => a.name.localeCompare(b.name));
  const node = (r, depth) => {
    const row = h('div', { class: 'tree-row' },
      h('div', { class: 'tree-name' }, h('span', { class: 'tree-indent' }, ''), link(`#/locations/${r.id}`, h('b', null, r.name)), r.kind ? h('span', { class: 'badge muted' }, r.kind) : null,
        r.address ? h('span', { class: 'muted small' }, r.address) : null),
      h('div', { class: 'tree-meta muted small' }, `${r.rack_count} holder${r.rack_count === 1 ? '' : 's'} · ${r.device_count} device${r.device_count === 1 ? '' : 's'}`),
      h('div', { class: 'row-actions' },
        small('+ Inside', () => editEntity('locations', { parent_id: r.id })),
        small('Edit', () => editEntity('locations', r)),
        small('Delete', () => deleteEntity('locations', r, null, 'Things inside it will keep existing without a location.'), 'ghost-danger')));
    row.querySelector('.tree-indent').style.width = `${depth * 22}px`;
    return [row, ...children(r.id).map(c => node(c, depth + 1))];
  };
  render(
    pageHead('Locations', 'Sites, buildings, rooms, closets. Nest them however you like. Open one to see what’s loose in it.',
      helpLink('piles'),
      btn('+ Add location', () => editEntity('locations', {}), 'primary')),
    rows.length ? h('div', { class: 'card tree' }, children(null).map(r => node(r, 0))) : h('div', { class: 'empty' }, 'No locations yet.'));
}

async function viewVault(q) {
  const rows = await GET('/credentials');
  const F = S.filters.vault;
  const holder = h('div');
  const draw = () => {
    const n = (F.q || '').toLowerCase();
    holder.replaceChildren(credTable(rows.filter(r => !n || [r.label, r.kind, r.username, r.url, r.device_name].some(x => x && x.toLowerCase().includes(n)))));
  };
  const want = q && q.get('open') ? rows.find(r => String(r.id) === q.get('open')) : null;
  if (want) { cleanHash('#/vault'); setTimeout(() => revealCredential(want), 0); }
  render(
    pageHead('Vault', 'Logins and secrets, encrypted with AES-256-GCM under your master password.',
      helpLink('logins'),
      btn('Password generator', () => {
        const out = h('code', { class: 'secret big' }, genPassword());
        const len = h('input', { type: 'number', min: 8, max: 128, value: 24 });
        modal('Password generator', h('div', null,
          h('div', { class: 'recovery' }, out),
          h('div', { class: 'toolbar' }, h('label', null, 'Length '), len,
            btn('Regenerate', () => { out.textContent = genPassword(Math.min(128, Math.max(8, +len.value || 24))); }),
            btn('Copy', () => copy(out.textContent, 'Password'), 'primary'))));
      }),
      btn('+ Add login', () => editCredential({}), 'primary')),
    h('div', { class: 'toolbar' }, h('input', { type: 'search', placeholder: 'Filter…', value: F.q || '', oninput: e => { F.q = e.target.value; draw(); } })),
    holder);
  draw();
}

async function viewAudit() {
  const rows = await GET('/audit?limit=1000');
  render(
    pageHead('Audit Log', 'Every change, login, export and secret reveal.'),
    card('Last 1000 events', table([
      { label: 'Time (UTC)', get: r => h('span', { class: 'mono small' }, r.ts) },
      { label: 'Action', get: r => h('b', { class: /fail/.test(r.action) ? 'bad-text' : '' }, r.action) },
      { label: 'Entity', get: r => r.entity ? `${r.entity}${r.entity_id ? ' #' + r.entity_id : ''}` : '' },
      { label: 'Detail', get: r => r.detail || '' },
      { label: 'IP', get: r => h('span', { class: 'mono small' }, r.ip || '') },
    ], rows)));
}

/* Results appear while typing; Enter or a click opens the item itself. */
function searchTypeahead(input) {
  const pop = h('div', { class: 'search-pop', role: 'listbox', hidden: true });
  let rows = [], sel = 0, timer = null, seq = 0;
  const close = () => { pop.hidden = true; };
  const go = r => { close(); input.blur(); location.hash = r.link; };
  const draw = () => {
    fillEl(pop, rows.slice(0, 8).map((r, i) => h('button', {
      type: 'button', role: 'option', class: 'search-hit' + (i === sel ? ' on' : ''),
      onmousedown: e => { e.preventDefault(); go(r); },
    }, h('span', { class: 'badge muted' }, r.kind), h('span', { class: 'sh-main' }, h('b', null, r.label), r.sub ? h('span', { class: 'muted small' }, r.sub) : null))),
    rows.length > 8 ? h('button', { type: 'button', class: 'search-all', onmousedown: e => { e.preventDefault(); close(); location.hash = '#/search?q=' + encodeURIComponent(input.value.trim()); } }, `See all ${rows.length} results`) : null);
    pop.hidden = !rows.length;
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const v = input.value.trim();
    if (v.length < 2) { rows = []; return close(); }
    timer = setTimeout(async () => {
      const mine = ++seq;
      try { const r = await GET('/search?q=' + encodeURIComponent(v)); if (mine === seq) { rows = r; sel = 0; draw(); } } catch { /* ignore */ }
    }, 180);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' && rows.length) { e.preventDefault(); sel = Math.min(sel + 1, Math.min(rows.length, 8) - 1); draw(); }
    else if (e.key === 'ArrowUp' && rows.length) { e.preventDefault(); sel = Math.max(sel - 1, 0); draw(); }
    else if (e.key === 'Escape') close();
    else if (e.key === 'Enter' && input.value.trim()) {
      e.preventDefault();
      if (!pop.hidden && rows[sel]) go(rows[sel]);
      else { close(); location.hash = '#/search?q=' + encodeURIComponent(input.value.trim()); }
    }
  });
  input.addEventListener('blur', () => setTimeout(close, 150));
  input.addEventListener('focus', () => { if (rows.length && input.value.trim().length >= 2) draw(); });
  return h('div', { class: 'search-wrap' }, input, pop);
}

async function viewSearch(q) {
  const rows = q ? await GET('/search?q=' + encodeURIComponent(q)) : [];
  if (rows.length === 1) { location.replace(rows[0].link); return; }
  const box = document.querySelector('.topbar input[type=search]');
  if (box) box.value = q;
  render(
    pageHead(`Search: ${q}`, `${rows.length} result${rows.length === 1 ? '' : 's'}`),
    rows.length ? h('div', { class: 'card' }, h('ul', { class: 'plain results' }, rows.map(r => h('li', null,
      h('span', { class: 'badge muted' }, r.kind), ' ', link(r.link, r.label), ' ', h('span', { class: 'muted small' }, r.sub)))))
      : h('div', { class: 'empty' }, q.length < 2 ? 'Type at least 2 characters.' : 'Nothing found.'));
}

// ---------------------------------------------------------------- views: settings

async function viewSettings() {
  [S.auth, S.caps] = await Promise.all([api('GET', '/auth/status'), GET('/meta/capabilities')]);
  const totpBody = h('div');
  const drawTotp = () => {
    if (S.auth.totp_enabled) {
      totpBody.replaceChildren(h('p', null, badge('Active'), ' Unlocking requires a code from your authenticator app.'),
        btn('Turn off 2FA', () => formDialog({
          title: 'Turn off 2FA', fields: [{ k: 'password', label: 'Master password', type: 'password' }], saveLabel: 'Turn off',
          submit: v => api('POST', '/auth/totp/disable', v), onDone: () => { toast('2FA turned off'); viewSettings(); },
        }), 'ghost-danger'));
    } else {
      totpBody.replaceChildren(h('p', null, 'Add a second factor (any TOTP app: Aegis, 2FAS, Bitwarden, 1Password, Google Authenticator).'),
        btn('Set up 2FA', async () => {
          const t = await api('POST', '/auth/totp/begin');
          formDialog({
            title: 'Set up 2FA', saveLabel: 'Turn on',
            extra: null,
            fields: [{ k: 'code', label: 'Enter the 6-digit code from your app', required: true }],
            submit: v => api('POST', '/auth/totp/enable', v),
            onDone: () => { toast('2FA is on'); viewSettings(); },
          }).form.el.prepend(h('div', { class: 'field wide' },
            h('p', null, 'Add this key to your authenticator app (choose “enter a setup key”, time-based):'),
            h('div', { class: 'recovery' }, h('code', null, t.secret.match(/.{1,4}/g).join(' ')), small('Copy', () => copy(t.secret, 'Key'))),
            h('details', null, h('summary', null, 'otpauth:// link'), h('code', { class: 'wrap small' }, t.uri))));
        }, 'primary'));
    }
  };
  drawTotp();
  const ents = ['devices', 'components', 'racks', 'locations', 'networks', 'interfaces', 'services', 'connections', 'device_slots', 'credentials'];
  const group = (title, ...cards) => [h('h2', { class: 'settings-group' }, title), h('div', { class: 'grid two' }, cards)];
  render(
    pageHead('Settings', 'Grouped like the guide’s Settings page. Each one says what it does.'),
    group('Appearance', appearanceCard()),
    group('Locking and security',
      card('Locking', h('div', null,
        h('p', null, `Locked after ${S.auth.idle_minutes} minutes without use, and whenever the HaRM server restarts. Unlocking needs your master password${S.auth.totp_enabled ? ' and a 2FA code' : ''}.`),
        btn('🔒 Lock now', lockNow))),
      card('Master password', h('div', null,
        h('p', null, 'Unlocks HaRM and the saved logins inside it. Changing it keeps every saved login.'),
        btn('Change password…', () => formDialog({
          title: 'Change master password',
          fields: [
            { k: 'current_password', label: 'Current password', type: 'password', required: true },
            { k: 'new_password', label: 'New password (10+ characters)', type: 'password', required: true },
            { k: 'confirm', label: 'Confirm new password', type: 'password', required: true },
          ],
          submit: v => {
            if (v.new_password !== v.confirm) throw new Error('The two new passwords don’t match.');
            return api('POST', '/auth/change-password', { current_password: v.current_password, new_password: v.new_password });
          },
          onDone: () => toast('Password changed'),
        })))),
      card('Two-factor authentication', totpBody),
      card('Recovery code', h('div', null,
        h('p', null, 'Unlocks HaRM if you forget the master password. Without your password or recovery code, saved logins can’t be recovered.'),
        btn('New recovery code…', () => formDialog({
          title: 'New recovery code', fields: [{ k: 'password', label: 'Master password', type: 'password', required: true }], saveLabel: 'Make a new code',
          submit: v => api('POST', '/auth/recovery-code', v), onDone: r => showRecoveryCode(r.recovery_code),
        })),
        h('p', { class: 'muted small' }, 'The old code stops working as soon as you make a new one.')))),
    group('Phones & tablets',
      card('Phone app', h('div', null,
        h('p', null, 'Put HaRM on your phone’s home screen so it opens like an app, with shortcuts for scanning, devices and tasks. Both need to be on the same Wi‑Fi.'),
        h('div', { class: 'inline' }, btn('How to connect a phone…', phoneAppHelp, 'primary'),
          h('button', { type: 'button', class: 'install-btn', hidden: !S.installPrompt, onclick: installApp }, '⤓ Install on this device'),
          S.caps.ca_cert ? h('a', { class: 'button', href: '/harm-ca.crt', download: 'harm-ca.crt' }, '⬇ Certificate') : null))),
      card('Camera and scanning', h('div', null, kv([
        ['This connection', window.isSecureContext ? h('span', { class: 'ok-text' }, '✓ Secure (HTTPS or this computer)') : h('span', { class: 'warn-text' }, 'Plain HTTP')],
        ['Live camera scanning', window.isSecureContext && navigator.mediaDevices?.getUserMedia ? 'Available' : 'Needs HTTPS'],
        ['Photo scanning', 'Available'],
        ['Text recognition (server)', S.caps.ocr ? 'Available' : h('span', { class: 'warn-text' }, 'Not installed (install tesseract)')],
        ['Barcode reader (server)', S.caps.barcodes ? 'Available' : 'Not installed (the phone reads barcodes itself)'],
        ['Address', mono(location.origin)],
      ]), h('p', null, h('a', { class: 'button', href: '#/help?s=mobile' }, 'How scanning works'))))),
    group('AI Assist', aiSettingsCard()),
    group('Data & backups',
      card('Automatic backups', h('div', null,
        h('p', null, 'HaRM saves a copy every day and keeps the last 14. Saved logins stay encrypted inside.'),
        S.caps.backups?.length ? h('ul', { class: 'plain' }, S.caps.backups.slice(0, 5).map(b => h('li', { class: 'mono small' }, `${b.name} · ${(b.size / 1e6).toFixed(1)} MB`)))
          : h('p', { class: 'muted small' }, 'The first one is made a few seconds after the server starts.'),
        h('p', { class: 'muted small' }, `Kept on the HaRM computer in ${S.caps.backup_dir || 'data/backups'}. Copy that folder to another disk now and then.`))),
      card('Download a backup', h('div', null,
        h('p', null, 'The whole database in one file. Saved logins stay encrypted and only open with your master password or recovery code.'),
        h('a', { class: 'button primary', href: '/api/backup' }, '⬇ Download backup (.db)'))),
      card('Export CSV', h('div', null, h('div', { class: 'export-links' }, ents.map(e => h('a', { class: 'button sm', href: `/api/export/${e}.csv` }, e.replace('_', ' ')))),
        h('p', { class: 'muted small' }, 'The logins file has names and usernames only, never passwords. More ways out: ', link('#/export', 'Export & Share'), '.')))),
    hasKeyboard() ? group('Shortcuts', card('Keyboard shortcuts', h('div', null, shortcutsList()))) : null,
    group('About', aboutCard()));
}

/* Settings > About: version, license, the guide and Send feedback (the design system's About). */
function aboutCard() {
  const v = S.auth?.release || '';
  return card('About Zom’s HaRM', h('div', { class: 'about-row' },
    h('img', { src: '/static/icon.svg', alt: '', width: 48, height: 48 }),
    h('div', null,
      h('p', null, h('b', null, 'Zom’s HaRM'), ' ', v),
      h('p', { class: 'muted small' }, 'Hardware and rack manager, kept on your own computer. Made by ZomBeatz Media.'),
      h('p', { class: 'muted small' }, 'Free and open source under the MIT license. ',
        h('a', { href: 'https://github.com/ZomBeatz/Zoms-HaRM', target: '_blank', rel: 'noopener' }, 'See the code'), ' · ',
        h('a', { href: 'https://github.com/ZomBeatz/Zoms-HaRM/blob/main/CHANGELOG.md', target: '_blank', rel: 'noopener' }, 'What’s new')),
      h('div', { class: 'inline' },
        btn('💬 Send feedback', sendFeedback),
        h('a', { class: 'button', href: 'https://docs.zombeatzmedia.com/harm/', target: '_blank', rel: 'noopener' }, 'Read the guide'),
        h('a', { class: 'button', href: '#/setup' }, '🧭 Setup guide')))));
}

/* An email to ZomBeatz Media with the version and device filled in. */
function sendFeedback() {
  const ua = navigator.userAgent;
  const system = /Android/.test(ua) ? 'Android' : /iPhone/.test(ua) ? 'iPhone' : deviceWord() === 'tablet' && /Mac|iPad/.test(ua) ? 'iPad'
    : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'an unknown system';
  const v = S.auth?.release || '';
  const body = ['What happened, or what would you like?', '', '', 'Steps, if something went wrong:', '1. ', '', '---',
    `Zom's HaRM ${v}, a browser on ${system} (this ${deviceWord()}).`].join('\n');
  location.href = `mailto:info@zombeatzmedia.com?subject=${encodeURIComponent(`Zom's HaRM feedback (${v})`)}&body=${encodeURIComponent(body)}`;
}

// ---------------------------------------------------------------- shared bits for the newer views

const mono = v => (v == null || v === '') ? '' : h('span', { class: 'mono' }, v);
const helpLink = (section, label = '?') => h('a', { class: 'button help-btn', href: `#/help?s=${section}`, title: 'How this works' }, label);

let qaListening = false;
function quickAddButton() {
  const menu = h('div', { class: 'qa-menu', hidden: true, role: 'menu' });
  const item = (label, fn) => h('button', { type: 'button', role: 'menuitem', onclick: () => { menu.hidden = true; fn(); } }, label);
  const toDevice = r => { location.hash = `#/devices/${r.id}`; };
  menu.append(
    h('div', { class: 'qa-group' }, 'Scan a label'),
    item('📷 New part from label', () => editEntity('components', { status: 'In Stock', quantity: 1 }, null, { autoScan: true })),
    item('📷 New device from label', () => editEntity('devices', { status: 'Active' }, toDevice, { autoScan: true })),
    item('🏷 Scan a HaRM label (open device)', () => scanDialog({ title: 'Scan a HaRM label', single: true, targets: [{ k: 'copy', label: 'Copied' }], onPick: (_k, v) => copy(v, 'Copied') })),
    item('📝 Scan text or barcode (copy it)', () => scanDialog({ title: 'Scanner', single: true, targets: [{ k: 'copy', label: 'Copied' }], onPick: (_k, v) => copy(v, 'Copied') })),
    item('🤖 AI Assist: photos → inventory', () => aiAssist()),
    h('div', { class: 'qa-group' }, 'Add'),
    item('▤ Device', () => editEntity('devices', { status: 'Active' }, toDevice)),
    item('◫ Spare part', () => editEntity('components', { status: 'In Stock', quantity: 1 })),
    item('🔑 Login', () => editCredential({})),
    item('⌗ Network', () => editEntity('networks', {})),
    item('▥ Rack / shelf / pile', () => editEntity('racks', { kind: 'Shelf' })),
    item('⌂ Location', () => editEntity('locations', {})));
  if (!qaListening) {
    qaListening = true;
    document.addEventListener('click', e => {
      const m = document.querySelector('.qa-menu');
      if (m && !m.hidden && !e.target.closest('.qa')) m.hidden = true;
    });
  }
  return h('div', { class: 'qa' },
    h('button', { type: 'button', class: 'primary qa-btn', 'aria-haspopup': 'menu', onclick: () => { menu.hidden = !menu.hidden; } }, '+ New'),
    menu);
}

/* A “⋯” button holding the less-used actions of a page. items: [label, fn, cls] or null. */
function menuButton(label, items, cls = '') {
  const menu = h('div', { class: 'qa-menu pop-menu', hidden: true, role: 'menu' },
    items.filter(Boolean).map(([l, fn, cls]) => h('button', { type: 'button', role: 'menuitem', class: cls || '',
      onclick: () => { menu.hidden = true; fn(); } }, l)));
  return h('div', { class: 'qa pop' },
    h('button', { type: 'button', class: cls || null, 'aria-haspopup': 'menu', 'aria-label': label === '⋯' ? 'More actions' : null, onclick: () => {
      document.querySelectorAll('.pop-menu').forEach(m => { if (m !== menu) m.hidden = true; });
      menu.hidden = !menu.hidden;
    } }, label), menu);
}
document.addEventListener('click', e => {
  document.querySelectorAll('.pop-menu').forEach(m => { if (!m.hidden && !m.parentElement.contains(e.target)) m.hidden = true; });
});

/* Tabs that remember the last one used (per kind of page), so moving between devices keeps your place.
   defs: [id, label, count|null, build()] */
function tabs(key, defs) {
  S.tabs = S.tabs || {};
  const body = h('div', { class: 'tab-body' });
  const bar = h('div', { class: 'tabs', role: 'tablist' });
  // The last tab is remembered per kind of page (every device page opens on the same tab).
  if (!S.tabs[key]) S.tabs[key] = prefGet('harm-tab-' + key);
  const show = id => {
    S.tabs[key] = id;
    prefSet('harm-tab-' + key, id);
    bar.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.tab === id));
    fillEl(body, defs.find(d => d[0] === id)[3]());
  };
  for (const [id, label, count] of defs) {
    bar.append(h('button', { type: 'button', role: 'tab', 'data-tab': id, onclick: () => show(id) },
      label, count ? h('span', { class: 'tab-n' }, count) : null));
  }
  show(defs.some(d => d[0] === S.tabs[key]) ? S.tabs[key] : defs[0][0]);
  return h('div', null, bar, body);
}

function rackTile(r) {
  const pct = r.height_u ? Math.min(100, Math.round((r.used_u / r.height_u) * 100)) : null;
  let bar = null;
  if (pct != null) {
    const fill = h('div', { class: 'bar-fill' + (pct > 85 ? ' hot' : '') });
    fill.style.width = pct + '%';
    bar = h('div', { class: 'bar-row' }, h('div', { class: 'bar' }, fill), h('div', { class: 'bar-n' }, `${r.used_u}/${r.height_u}U`));
  }
  return h('a', { class: 'tile', href: `#/racks/${r.id}` },
    h('div', { class: 'tile-head' }, h('b', null, r.name), h('span', { class: 'badge muted' }, r.kind)),
    h('div', { class: 'muted small' }, r.location_id ? locPath(r.location_id) : 'No location'),
    bar,
    h('div', { class: 'small' }, `${r.device_count} device${r.device_count === 1 ? '' : 's'} · ${r.component_count} spare part${r.component_count === 1 ? '' : 's'}`));
}

function ifaceTable(rows, after) {
  return table([
    { label: 'Name', get: r => h('span', null, h('b', null, r.name || 'None'), r.is_primary ? h('span', { class: 'ip-star', title: 'Main address' }, ' ★') : null,
      r.kind ? h('div', { class: 'muted small' }, r.kind) : null) },
    { label: 'Network', get: r => r.network_id ? link(`#/networks/${r.network_id}`, r.network_name + (r.network_vlan ? ` · VLAN ${r.network_vlan}` : '')) : '' },
    { label: 'Address', get: r => h('div', null,
      r.ip ? mono(r.ip + (r.subnet && String(r.subnet).startsWith('/') ? r.subnet : '')) : null,
      r.ipv6 ? h('div', { class: 'mono small muted' }, r.ipv6) : null,
      r.assignment ? h('div', null, h('span', { class: 'badge muted' }, r.assignment)) : null) },
    { label: 'MAC', get: r => mono(r.mac) },
    { label: 'VLANs', get: r => /trunk|hybrid/i.test(r.port_mode || '')
      ? `${r.port_mode}: native ${r.native_vlan || 'None'}, tagged ${r.tagged_vlans || 'None'}`
      : nz(r.port_mode, r.vlan ? `VLAN ${r.vlan}` : '') },
    { label: 'Link', get: r => [r.speed, r.mtu ? `MTU ${r.mtu}` : '', r.poe && r.poe !== 'None' ? r.poe : '', r.link_state, r.parent ? `in ${r.parent}` : ''].filter(Boolean).join(' · ') },
    { label: 'DNS / SSID', get: r => [r.dns_name, r.wifi_ssid ? `SSID ${r.wifi_ssid}` : ''].filter(Boolean).join(' · ') },
    { label: '', nosort: true, get: r => rowActions('interfaces', r, after) },
  ], rows, { empty: 'No interfaces recorded.' });
}

// ---------------------------------------------------------------- views: a single location

async function viewLocation(id) {
  const d = await GET(`/locations/${id}/contents`);
  const loc = d.location;
  const back = () => viewLocation(id);
  const chain = [];
  for (let cur = loc, guard = 0; cur && cur.parent_id && guard < 25; guard++) {
    cur = S.lk.locations.find(l => l.id === cur.parent_id);
    if (cur) chain.unshift(cur);
  }
  const looseDevCols = [
    { label: '', get: r => dot(r.connected), sort: r => r.connected, cls: 'narrow' },
    { label: 'Device', get: r => link(`#/devices/${r.id}`, r.name) },
    { label: 'Type', get: r => r.device_type || '' },
    { label: 'Status', get: r => statusSelect(r, back), sort: r => r.status },
    { label: 'Spot', get: r => r.position || h('span', { class: 'muted' }, 'not noted') },
    { label: '', nosort: true, get: r => small('Edit', () => editEntity('devices', r, back)) },
  ];
  render(
    h('div', { class: 'crumbs' }, backLink(), link('#/locations', 'Locations'), chain.map(p => [' › ', link(`#/locations/${p.id}`, p.name)]), ' › ', loc.name),
    pageHead(loc.name, nz(loc.kind, loc.address ? `· ${loc.address}` : '') || null,
      helpLink('piles'),
      btn('+ Device here', () => editEntity('devices', { location_id: id, status: 'Active' }, back)),
      btn('+ Part here', () => editEntity('components', { location_id: id, status: 'In Stock', quantity: 1 }, back)),
      btn('🤖 AI Assist here', () => aiAssist({ location_id: id })),
      menuButton('⋯', [['✎ Edit…', () => editEntity('locations', loc, back)],
        ['🗑 Delete', () => deleteEntity('locations', loc, () => goBackOr('#/locations'), 'Things inside it will keep existing without a location.'), 'danger-item']])),
    loc.notes ? h('div', { class: 'card notes' }, loc.notes) : null,
    journalCard('locations', id, d.notes, back),
    d.children.length ? card(`Inside ${loc.name}`, h('ul', { class: 'plain' }, d.children.map(c => h('li', null,
      link(`#/locations/${c.id}`, h('b', null, c.name)), ' ', c.kind ? h('span', { class: 'badge muted' }, c.kind) : null, ' ',
      h('span', { class: 'muted small' }, `${c.rack_count} holder${c.rack_count === 1 ? '' : 's'} · ${c.device_count} device${c.device_count === 1 ? '' : 's'}`)))),
      small('+ Add', () => editEntity('locations', { parent_id: id }, back))) : null,
    card('Racks, shelves & piles here', d.racks.length ? h('div', { class: 'tiles' }, d.racks.map(rackTile)) : h('div', { class: 'empty' }, 'No holders here.'),
      small('+ Add', () => editEntity('racks', { location_id: id, kind: 'Shelf' }, back))),
    card('Loose devices', h('div', null,
      h('p', { class: 'muted small' }, 'Devices in this room that aren’t on a rack, shelf or in a bin: piles, desks, the floor. Use “Spot” to note where (“pile by the door”).'),
      table(looseDevCols, d.loose_devices, { empty: 'Nothing loose here.' })),
    small('+ Device', () => editEntity('devices', { location_id: id, status: 'Active' }, back))),
    card('Loose parts', table([
      { label: 'Category', get: r => r.category },
      { label: 'Part', get: r => link(`#/components?id=${r.id}`, nz(r.manufacturer, r.model) || r.category) },
      { label: 'Capacity', get: r => r.capacity || '' },
      { label: 'Qty', get: r => r.quantity },
      { label: 'Spot', get: r => r.position || '' },
      { label: 'Status', get: r => badge(r.status) },
    ], d.loose_components, { empty: 'No loose parts here.' }),
    small('+ Part', () => editEntity('components', { location_id: id, status: 'In Stock', quantity: 1 }, back))),
    d.networks.length ? card('Networks at this location', h('ul', { class: 'plain' }, d.networks.map(n => h('li', null,
      link(`#/networks/${n.id}`, n.name), ' ', h('span', { class: 'muted mono small' }, nz(n.cidr, n.vlan_id ? `VLAN ${n.vlan_id}` : '')))))) : null);
}

// ---------------------------------------------------------------- views: networks

async function viewNetworks() {
  const rows = await GET('/networks');
  const add = () => editEntity('networks', {});
  render(
    pageHead('Networks & IPs', 'Subnets, VLANs and Wi-Fi networks, and which device has which address.',
      helpLink('networks'),
      h('a', { class: 'button', href: '#/discover' }, '⌖ Discover'),
      menuButton('⋯', [['⇩ Export CSV', () => { openDownload('/api/export/networks.csv'); }]]),
      btn('+ Add network', add, 'primary')),
    rows.length ? card('Networks', table([
      { label: 'VLAN', get: r => r.vlan_id ?? '', sort: r => r.vlan_id ?? 99999 },
      { label: 'Name', get: r => link(`#/networks/${r.id}`, r.name) },
      { label: 'Purpose', get: r => r.kind || '' },
      { label: 'Subnet', get: r => mono(r.cidr) },
      { label: 'Gateway', get: r => mono(r.gateway) },
      { label: 'DHCP pool', get: r => r.dhcp_start ? mono(`${r.dhcp_start} to ${r.dhcp_end || '?'}`) : '' },
      { label: 'DNS / domain', get: r => [r.dns_servers, r.domain].filter(Boolean).join(' · ') },
      { label: 'IPs used', get: r => r.ip_count, sort: r => r.ip_count },
      { label: '', nosort: true, get: r => rowActions('networks', r) },
    ], rows, { onRow: r => { location.hash = `#/networks/${r.id}`; } }))
      : h('div', { class: 'card onboarding' }, h('h3', null, 'No networks yet'),
        h('p', null, 'Add each subnet or VLAN you run, e.g. “Servers · VLAN 10 · 10.0.10.0/24”. Device interfaces with an address in that range link to it automatically, and every network gets an IP map showing conflicts and free addresses.'),
        btn('+ Add your first network', add, 'primary')));
}

async function viewNetwork(id) {
  const d = await GET(`/networks/${id}/ipmap`);
  const n = d.network, st = d.stats;
  const back = () => viewNetwork(id);
  let usage = h('div', { class: 'empty' }, 'Add a subnet (CIDR) to see usage and free addresses.');
  if (st.hosts) {
    const fill = h('div', { class: 'bar-fill' + (st.used / st.hosts > 0.85 ? ' hot' : '') });
    fill.style.width = `${Math.min(100, (st.used / st.hosts) * 100)}%`;
    usage = h('div', null,
      h('div', { class: 'bar-row' }, h('div', { class: 'bar' }, fill), h('div', { class: 'bar-n' }, `${st.used}/${st.hosts}`)),
      kv([['Usable addresses', st.hosts], ['Recorded in HaRM', st.used], ['DHCP pool size', st.dhcp_size || '']]),
      d.next_free.length ? [h('h4', null, 'Next free static addresses (tap to assign)'),
        h('div', { class: 'chips' }, d.next_free.map(ip => h('button', {
          type: 'button', class: 'chip mono',
          onclick: () => editEntity('interfaces', {
            network_id: id, ip, assignment: 'Static', subnet: n.cidr ? '/' + n.cidr.split('/')[1] : null,
            gateway: n.gateway, dns_servers: n.dns_servers, vlan: n.vlan_id,
          }, back),
        }, ip)))] : null);
  }
  render(
    h('div', { class: 'crumbs' }, backLink(), link('#/networks', 'Networks & IPs'), ' › ', n.name),
    pageHead(n.name, [n.kind, n.vlan_id ? `VLAN ${n.vlan_id}` : '', n.cidr].filter(Boolean).join(' · ') || null,
      helpLink('networks'),
      btn('Edit', () => editEntity('networks', n, back)),
      menuButton('⋯', [['🗑 Delete', () => deleteEntity('networks', n, () => goBackOr('#/networks'), 'Interfaces keep their addresses but lose the link to this network.'), 'danger-item']])),
    d.conflicts.length ? h('div', { class: 'card alert' }, h('b', null, '⚠ Address conflicts: '), d.conflicts.join(', '), ' are recorded on more than one interface.') : null,
    h('div', { class: 'grid two' },
      card('Details', kv([
        ['Subnet', mono(n.cidr)], ['Gateway', mono(n.gateway)],
        ['DHCP pool', n.dhcp_start ? mono(`${n.dhcp_start} to ${n.dhcp_end || '?'}`) : ''],
        ['DNS servers', mono(n.dns_servers)], ['Search domain', n.domain], ['IPv6 prefix', mono(n.ipv6_prefix)],
        ['Wi-Fi SSID', n.ssid], ['Location', n.location_id ? link(`#/locations/${n.location_id}`, locPath(n.location_id)) : ''],
      ])),
      card('Usage', usage)),
    n.notes ? card('Notes', h('div', { class: 'notes' }, n.notes)) : null,
    card('Addresses in use', table([
      { label: 'IP', get: r => h('span', { class: 'mono' + (r.duplicate ? ' bad-text' : '') }, r.ip, r.duplicate ? ' ⚠ duplicate' : '') },
      { label: 'Device', get: r => link(`#/devices/${r.device_id}`, r.device_name) },
      { label: 'Interface', get: r => r.name || '' },
      { label: 'Assignment', get: r => h('span', { class: 'inline' }, r.assignment || '',
        r.in_dhcp_range && /static/i.test(r.assignment || '') ? h('span', { class: 'badge warn' }, 'inside DHCP pool') : null,
        r.outside ? h('span', { class: 'badge bad' }, 'outside subnet') : null) },
      { label: 'MAC', get: r => mono(r.mac) },
      { label: 'DNS name', get: r => r.dns_name || '' },
      { label: '', nosort: true, get: r => rowActions('interfaces', r, back) },
    ], d.entries, { empty: 'No device has an address in this network yet.' }),
    small('+ Add address', () => editEntity('interfaces', { network_id: id, assignment: 'Static' }, back))));
}

// ---------------------------------------------------------------- setup guide (wizard)

function quickAdd(entity, fields, rec, onAdded, label = 'Add') {
  const form = buildForm(fields, rec);
  const err = h('div', { class: 'form-error', role: 'alert' });
  const el = h('form', {
    class: 'quick-add',
    onsubmit: async e => {
      e.preventDefault();
      if (!el.reportValidity()) return;
      err.textContent = '';
      try {
        const vals = form.values();
        const r = await api('POST', `/${entity}`, vals);
        await loadLookups();
        toast(`${LABELS[entity]} added`);
        onAdded(r, vals);
      } catch (x) { err.textContent = x.message; }
    },
  }, form.el, err, h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'primary' }, `+ ${label}`)));
  return { el, form };
}

const wizList = (rows, fmt, empty) => rows.length
  ? h('div', { class: 'wiz-list' }, h('h4', null, `Added so far (${rows.length})`), h('ul', { class: 'plain' }, rows.map(r => h('li', null, fmt(r)))))
  : h('p', { class: 'muted small' }, empty);

const WIZ = [
  {
    title: 'Welcome',
    render(body) {
      const box = (t, s) => h('div', { class: 'wd-box' }, h('b', null, t), h('span', null, s));
      body.append(
        h('h2', null, 'Welcome to HaRM'),
        h('p', null, 'HaRM keeps track of every piece of hardware you own: where it is, what’s inside it, how it’s networked, and how to log in to it. This guide sets up the basics. Skip anything you like and come back later from Help > Setup guide.'),
        h('h4', null, 'How things fit together'),
        h('div', { class: 'wiz-diagram' },
          box('Location', 'House > Basement'), h('span', { class: 'wd-arrow' }, '→'),
          box('Holder', 'Rack A · Shelf 2 · a pile'), h('span', { class: 'wd-arrow' }, '→'),
          box('Device', 'truenas, sw-core'), h('span', { class: 'wd-arrow' }, '→'),
          box('Parts', 'drives, RAM, NICs')),
        h('div', { class: 'wiz-diagram' },
          box('Network', 'Servers · VLAN 10'), h('span', { class: 'wd-arrow' }, '↔'),
          box('Interface', 'eno1 · 10.0.10.20'), h('span', { class: 'wd-arrow' }, '+'),
          box('Services & logins', 'TrueNAS UI · admin')),
        h('ul', null,
          h('li', null, 'Only a name is required anywhere. Fill in more whenever you like.'),
          h('li', null, 'Forms never lose your typing. Close one by accident and the changes come back when you reopen it.'),
          h('li', null, 'On your phone, ', h('b', null, '+ New > Scan'), ' reads serial numbers and part numbers straight off labels.')));
    },
  },
  {
    title: 'Locations',
    render(body, redraw) {
      const qa = quickAdd('locations', [
        { k: 'name', label: 'Name', required: true, ph: 'Basement' },
        { k: 'kind', label: 'Kind', list: 'location_kinds' },
        { k: 'parent_id', label: 'Inside of', type: 'fk', entity: 'locations', none: 'Top level' },
      ], {}, redraw, 'Add location');
      body.append(
        h('h2', null, 'Where is your hardware?'),
        h('p', null, 'Add the places your gear lives. Nest them if that helps: a building, then the rooms inside it. Tap a suggestion to start.'),
        h('div', { class: 'chips' }, ['Home', 'Office', 'Basement', 'Garage', 'Server closet', 'Office desk', 'Storage unit'].map(n =>
          h('button', { type: 'button', class: 'chip', onclick: () => { qa.form.set({ name: n }); qa.form.inputs.name.input.focus(); } }, n))),
        qa.el,
        wizList(S.lk.locations, l => [h('b', null, locPath(l.id)), l.kind ? ` · ${l.kind}` : ''], 'Nothing yet.'));
    },
  },
  {
    title: 'Racks, shelves & piles',
    render(body, redraw) {
      const hasUnits = v => /rack|cabinet/i.test(v.kind || '');
      const qa = quickAdd('racks', [
        { k: 'name', label: 'Name', required: true, ph: 'Rack A · Shelf 2 · Pile by the door' },
        { k: 'kind', label: 'Kind', type: 'select', options: S.enums.rack_kinds, required: true, default: 'Rack' },
        { k: 'location_id', label: 'Location', type: 'fk', entity: 'locations' },
        { k: 'height_u', label: 'Height (U)', type: 'number', min: 1, default: 42, showIf: hasUnits, clearWhenHidden: true },
      ], {}, redraw, 'Add holder');
      body.append(
        h('h2', null, 'What holds your hardware?'),
        h('p', null, 'A “holder” is anything gear sits in or on. Pick the kind that matches:'),
        h('dl', { class: 'kv' },
          h('dt', null, 'Rack / Cabinet'), h('dd', null, 'Has numbered rack units. You get a front and rear rack diagram.'),
          h('dt', null, 'Shelf / Bin / Tote / Drawer'), h('dd', null, 'Storage without unit numbers: spare drives in a bin, switches on a shelf.'),
          h('dt', null, 'Pile / Floor'), h('dd', null, 'A heap of gear in a corner that you want to keep together as a group.')),
        h('div', { class: 'tip' }, h('b', null, 'Gear piled in random rooms? '),
          'You don’t have to create anything for it. Give the device a Location and leave the holder empty; it shows as ',
          h('i', null, 'loose'), ' on that room’s page, with a “Spot” note like “pile by the door”. Make a Pile holder only when you want a specific pile grouped.'),
        qa.el,
        wizList(S.lk.racks, r => [h('b', null, r.name), ` · ${r.kind}`, r.location_id ? ` · ${locPath(r.location_id)}` : '', r.height_u ? ` · ${r.height_u}U` : ''], 'Nothing yet. You can skip this if everything is loose.'));
    },
  },
  {
    title: 'Networks',
    optional: true,
    render(body, redraw) {
      const qa = quickAdd('networks', [
        { k: 'name', label: 'Name', required: true, ph: 'Home LAN, Servers, IoT' },
        { k: 'vlan_id', label: 'VLAN ID', type: 'number', min: 1 },
        { k: 'cidr', label: 'Subnet', ph: '192.168.1.0/24', inputmode: 'decimal' },
        { k: 'gateway', label: 'Gateway', ph: '192.168.1.1', inputmode: 'decimal' },
        { k: 'dhcp_start', label: 'DHCP pool start', inputmode: 'decimal' },
        { k: 'dhcp_end', label: 'DHCP pool end', inputmode: 'decimal' },
      ], {}, redraw, 'Add network');
      body.append(
        h('h2', null, 'Your networks (optional)'),
        h('p', null, 'Add each subnet or VLAN. When you later give a device an IP address, HaRM links it to the right network, warns about duplicates, and suggests free addresses. Not sure? Skip this; your router’s settings page lists these.'),
        qa.el,
        wizList(S.lk.networks, n => [h('b', null, n.name), n.vlan_id ? ` · VLAN ${n.vlan_id}` : '', n.cidr ? ` · ${n.cidr}` : ''], 'Nothing yet.'));
    },
  },
  {
    title: 'Devices',
    render(body, redraw) {
      const qa = quickAdd('devices', [
        { k: 'name', label: 'Name', required: true, ph: 'nas-01, old-thinkpad, sw-core' },
        { k: 'device_type', label: 'Type', list: 'device_types' },
        { k: 'location_id', label: 'Location', type: 'fk', entity: 'locations' },
        { k: 'rack_id', label: 'Holder', type: 'fk', entity: 'racks', none: 'None (loose in the room)', scopeBy: ['location_id'], scope: rackInLocation, onChange: rackPicked },
        { k: 'rack_u', label: 'Lowest rack unit (U)', type: 'number', min: 1, showIf: v => rackHasUnits(v.rack_id), clearWhenHidden: true },
        { k: 'u_height', label: 'Height (U)', type: 'number', min: 1, default: 1, showIf: v => rackHasUnits(v.rack_id) },
        { k: 'position', label: 'Spot', ph: 'pile by the door', showIf: v => !rackHasUnits(v.rack_id), clearWhenHidden: true },
        { k: 'serial', label: 'Serial number', scan: true },
        { k: 'connected', label: 'Hooked up (cabled & powered)', type: 'checkbox' },
      ], S.wizSticky || {}, (r, vals) => { S.wizSticky = { location_id: vals.location_id, rack_id: vals.rack_id, device_type: vals.device_type }; redraw(); }, 'Add device');
      body.append(
        h('h2', null, 'Add your devices'),
        h('p', null, 'Quick-add the main things now: servers, switches, the router, the NAS, even the laptop in the closet. Location and holder stay filled in between adds. IPs, logins, drive bays and more go on each device’s own page later.'),
        qa.el,
        wizList(S.lk.devices.slice(-15).reverse(), d => [link(`#/devices/${d.id}`, h('b', null, d.name)), d.device_type ? ` · ${d.device_type}` : '', d.rack_name ? ` · ${d.rack_name}` : (d.location_name ? ` · ${d.location_name} (loose)` : '')], 'Nothing yet.'));
    },
  },
  {
    title: 'Security & phone',
    render(body) {
      const secure = window.isSecureContext;
      body.append(
        h('h2', null, 'Keep it safe, use it anywhere'),
        h('div', { class: 'grid two' },
          card('Recovery code', h('p', null, 'You saw a recovery code when you created your password. It is the only way back in if you forget the password. Store it offline. Lost it? Make a new one in ', link('#/settings', 'Settings'), '.')),
          card('Two-factor unlock', h('div', null, h('p', null, S.auth.totp_enabled ? '2FA is on.' : 'Recommended: require a code from an authenticator app to unlock HaRM.'),
            S.auth.totp_enabled ? null : h('a', { class: 'button primary', href: '#/settings' }, 'Turn on 2FA in Settings'))),
          card('Backups', h('p', null, 'Download a backup from ', link('#/settings', 'Settings'), ' now and then. Logins inside it stay encrypted.')),
          card('Phone & scanning', h('div', null,
            h('p', null, secure ? '✓ This connection is HTTPS, so live camera scanning works.' : 'You’re on plain HTTP. Photo scanning works, but live camera scanning needs HTTPS.'),
            h('a', { class: 'button', href: '#/help?s=mobile' }, 'How to use HaRM on your phone')))));
    },
  },
  {
    title: 'Done',
    render(body) {
      const go = (href, t, s) => h('a', { class: 'tile', href }, h('b', null, t), h('span', { class: 'muted small' }, s));
      body.append(
        h('h2', null, 'You’re set up 🎉'),
        h('p', null, 'Good next steps:'),
        h('div', { class: 'tiles' },
          go('#/devices', 'Fill in device details', 'IPs, services, logins, drive bays'),
          go('#/components', 'Catalog spare parts', 'Scan drives and RAM; see what fits where'),
          go('#/racks', 'Check your racks', 'Click empty units to place gear'),
          go('#/networks', 'Plan IP addresses', 'Free IPs, conflicts, VLANs'),
          go('#/help', 'Read the guide', 'Every feature, explained')));
    },
  },
];

async function viewSetup() {
  const step = Math.max(0, Math.min(S.wiz.step || 0, WIZ.length - 1));
  const goto = n => {
    S.wiz.step = n;
    try { localStorage.setItem('harm-wiz-step', String(n)); } catch { /* storage unavailable */ }
    viewSetup();
    window.scrollTo(0, 0);
  };
  const body = h('div', { class: 'wiz-body' });
  const last = step === WIZ.length - 1;
  render(
    pageHead('Setup guide', `Step ${step + 1} of ${WIZ.length}: ${WIZ[step].title}`, h('a', { class: 'button', href: '#/help' }, 'Full guide')),
    h('ol', { class: 'wiz-steps' }, WIZ.map((w, i) => h('li', { class: i === step ? 'cur' : (i < step ? 'done' : '') },
      h('button', { type: 'button', onclick: () => goto(i) }, h('span', { class: 'n' }, i < step ? '✓' : i + 1), h('span', { class: 't' }, w.title))))),
    h('div', { class: 'card wiz-card' }, body,
      h('div', { class: 'wiz-nav' },
        step > 0 ? btn('← Back', () => goto(step - 1)) : h('span'),
        h('div', { class: 'grow' }),
        last ? h('a', { class: 'button primary', href: '#/dashboard', onclick: () => { S.wiz.step = 0; try { localStorage.removeItem('harm-wiz-step'); } catch { /* ignore */ } } }, 'Go to dashboard')
          : [WIZ[step].optional ? btn('Skip', () => goto(step + 1)) : null,
            btn(step === 0 ? 'Let’s start →' : 'Next →', () => goto(step + 1), 'primary')])));
  WIZ[step].render(body, () => viewSetup());
}

// ---------------------------------------------------------------- help

const P = (...k) => h('p', null, ...k);
const UL = (...items) => h('ul', null, items.map(i => h('li', null, i)));
const OL = (...items) => h('ol', null, items.map(i => h('li', null, i)));
const B = t => h('b', null, t);
const C = t => h('code', null, t);

/* Device-specific fixes for "can't connect" problems. Works without the server (used on the
   start-up error screen too), so it only uses what's already loaded in the page. */
function deviceKind() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'computer';
}
function troubleshootingContent() {
  const here = location.origin;
  const mine = deviceKind();
  const sec = (key, title, ...body) => h('details', { class: 'trouble', open: key === mine }, h('summary', null, title, key === mine ? h('span', { class: 'badge info' }, 'this device') : null), body);
  return [
    P('Most connection problems are about trust: phones and tablets only talk to HaRM once they trust its certificate. If HaRM opens on one device but not another, the server is fine; fix the device that fails.'),
    sec('ios', 'iPhone / iPad',
      P('Symptoms: ', B('“Cannot reach the HaRM server”'), ', a warning that the connection isn’t private, it works in Safari but not from the home screen, or the home-screen icon is just a letter.'),
      OL(
        [B('Clear old HaRM data: '), 'Settings > Apps > Safari > Advanced > Website Data (older versions: Settings > Safari > Advanced > Website Data). Search ', C(location.hostname || '192.168'), ' and swipe to delete. Remove any HaRM icon from the home screen.'],
        [B('Download the certificate: '), 'on the computer running HaRM, open ', B('📱 Phone setup'), ' in the desktop app and scan the first QR code with the Camera app, or open ', C(`${here}/harm-ca.crt`), ' in Safari. If Safari warns, tap ', B('Show Details > visit this website'), '. Tap ', B('Allow'), ', then Close.'],
        [B('Install it: '), 'Settings > ', B('Profile Downloaded'), ' (or General > VPN & Device Management) > Zom’s HaRM local CA > ', B('Install'), '.'],
        [B('Trust it (the step most people miss): '), 'Settings > General > About > ', B('Certificate Trust Settings'), ' > turn on ', B('Zom’s HaRM local CA'), '.'],
        [B('Close Safari completely '), '(swipe it away in the app switcher), then open ', C(here), '. There should be no warning.'],
        [B('Add to Home Screen: '), 'Share > Add to Home Screen > Add.']),
      UL(
        ['Still a warning at step 5? The trust switch in step 4 isn’t on. Not listed there? Step 3 didn’t finish.'],
        ['Worked before and stopped after HaRM was updated or its certificate re-issued? Update HaRM on the computer (older versions made certificates iPhones reject), restart it, then repeat from step 5.'])),
    sec('android', 'Android',
      OL(
        ['Open ', B('📱 Phone setup'), ' in the desktop app and scan the first QR code (or open ', C(`${here}/harm-ca.crt`), '). Chrome warns once: Advanced > Proceed. The file downloads.'],
        ['Settings > Security & privacy > More security & privacy > Encryption & credentials > ', B('Install a certificate > CA certificate'), ' > Install anyway > pick harm-ca.crt. (Samsung: Settings > Security and privacy > More security settings > Install from device storage > CA certificate.)'],
        ['Close Chrome completely (swipe it away), reopen ', C(here), '. There should be a padlock and no warning.'],
        ['Chrome ⋮ > ', B('Add to Home screen > Install'), '.'])),
    sec('computer', 'Any device',
      UL(
        [B('Same network? '), 'The device must be on the same Wi-Fi/network as the computer running HaRM (not guest Wi-Fi, mobile data or a VPN).'],
        [B('Right address? '), 'The desktop app shows the addresses under “Where to open it”. If the computer’s IP changed, use the new one and press ', B('Fix certificate'), ' there.'],
        [B('Is HaRM running? '), 'The desktop app shows ● Running. If it says Stopped, press Start; if it won’t start, open Server log at the bottom.'],
        [B('Firewall: '), 'Windows asks the first time HaRM starts: allow it on Private networks. On Linux, the Phone setup checklist checks the firewall and offers to open the port.'],
        [B('Shared on your network? '), 'In the desktop app, “Let phones and other devices connect” must be ticked (then Restart).'],
        [B('Still stuck? '), 'The Phone setup checklist in the desktop app watches what the device does and shows which step is missing.'])),
  ];
}

const HELP = [
  ['start', 'Quick start', () => [
    OL(
      ['Run the ', link('#/setup', 'setup guide'), '. It adds your locations, racks/shelves, networks and first devices.'],
      ['Open a device and fill in what matters: IP addresses, services, logins, drive bays and installed parts.'],
      ['Catalog spare parts in ', link('#/components', 'Spare Parts'), '. On a phone, use ', B('+ New > Scan'), '.'],
      ['Use the search box at the top for anything: a name, IP, MAC, serial or part number.']),
  ]],
  ['concepts', 'How things fit together', () => [
    h('dl', { class: 'kv help-kv' },
      h('dt', null, 'Location'), h('dd', null, 'A place: house, room, closet, storage unit. Locations can be nested.'),
      h('dt', null, 'Holder'), h('dd', null, 'What hardware sits in or on: a rack or cabinet (with unit numbers), a shelf, bin, tote, drawer, desk, or a pile.'),
      h('dt', null, 'Device'), h('dd', null, 'Anything with its own identity: server, switch, NAS, router, laptop, UPS, patch panel.'),
      h('dt', null, 'Slots & bays'), h('dd', null, 'What a device can take, e.g. “12× SAS 3.5\" bays” or “8× DDR4 RDIMM”. HaRM uses these to suggest spare parts that fit.'),
      h('dt', null, 'Part'), h('dd', null, 'A component that goes into a device: drive, RAM stick, CPU, NIC, PSU, cable, SFP. Parts are either installed in a device or stored somewhere.'),
      h('dt', null, 'Network'), h('dd', null, 'A subnet / VLAN / Wi-Fi network with its gateway, DHCP pool and DNS.'),
      h('dt', null, 'Interface'), h('dd', null, 'A network port on a device, with its IP, MAC, VLANs and more. Interfaces link to networks automatically from the IP.'),
      h('dt', null, 'Service'), h('dd', null, 'Something a device runs: a web UI, SSH, SMB share, Plex.'),
      h('dt', null, 'Connection'), h('dd', null, 'A cable between two device ports (or to something untracked, like the ISP modem).'),
      h('dt', null, 'Login'), h('dd', null, 'A username and password (plus optional 2FA secret and notes), stored encrypted in the Vault.')),
  ]],
  ['piles', 'Gear in piles and random rooms', () => [
    P('Not everything lives in a rack. There are two ways to record loose gear:'),
    OL(
      [B('Just set the Location'), ' and leave “Rack / holder” empty. The device shows under ', B('Loose devices'), ' on that room’s page (Locations > the room). Use the ', B('Spot'), ' field to say where: “pile by the door”, “under the desk”.'],
      [B('Make a Pile, Floor or Tote holder'), ' when you want a particular heap grouped, e.g. “E-waste pile” or “Tote 3”. It gets its own page listing everything in it.']),
    P('When you pick a location in a form, the holder list only shows holders in that location (and rooms inside it). Picking a holder first fills in its location for you.'),
  ]],
  ['racking', 'Putting a device in a rack', () => [
    OL(
      ['Open the rack from ', link('#/racks', 'Racks & Storage'), '.'],
      ['Click an empty unit on the front or rear view, then create a new device there or place an existing one.'],
      ['Or edit a device: choose the rack, then the ', B('lowest unit'), ' it occupies and its height in U.']),
    UL(
      ['Full-depth devices block both faces. Turn that off for shallow gear like patch panels or PDUs so another device can use the other face.'],
      ['Faded blocks are full-depth devices seen from the other side. Striped blocks are not hooked up.'],
      ['HaRM refuses overlapping placements and tells you which device is in the way.']),
  ]],
  ['parts', 'Spare parts and what fits where', () => [
    OL(
      ['Add parts in ', link('#/components', 'Spare Parts'), '. Set the ', B('Interface'), ' (SATA III, DDR4 RDIMM, PCIe x8…) and ', B('Form factor'), ' (3.5", M.2 2280…).'],
      ['On a device page, add its ', B('Slots & bays'), '. Each slot shows how many are used and a button listing in-stock spares that fit.'],
      ['Click ', B('Install'), ' to move a part into a device (it splits a stack if you have several), and ', B('Remove'), ' to put it back on a shelf.']),
    P('Matching understands that SAS bays take SATA drives, a PCIe x16 slot takes x8/x4/x1 cards, and that “SATA” covers “SATA III”.'),
    P(B('Cataloging lots of drives? '), 'Use ', B('Save & add another'), '. Category, model, capacity, location and so on carry over, so you only scan or type each serial number.'),
  ]],
  ['builder', 'PC Builder', () => [
    P('Plan a computer part by part, like PCPartPicker, but mixing three sources:'),
    UL(
      [B('Parts library'), ': ~30,000 real parts with specs (see below).'],
      [B('My spare parts'), ': things already in your Spare Parts. Marked “Have” automatically.'],
      [B('Custom parts'), ': anything not in the library. Enter the specs you know; they’re saved for reuse.']),
    OL(
      ['Create a build in ', link('#/builds', 'PC Builder'), ' and give it a purpose and budget.'],
      ['Click ', B('Choose …'), ' on each row. With ', B('Only compatible'), ' ticked, the picker hides parts that clash with what you’ve already chosen and tells you why others don’t fit.'],
      ['Set each part to Have / Need / Ordered and enter prices to track cost and what’s left to buy.'],
      ['When it’s assembled, click ', B('Create device'), '. HaRM makes the device, fills in CPU/RAM/storage/PSU, adds the motherboard’s memory, M.2, SATA and PCIe slots, and installs the parts.']),
    P(B('What gets checked: '), 'CPU socket vs motherboard and cooler; memory type, slot count, capacity, SO-DIMM vs DIMM, ECC and registered memory; motherboard size vs case; video card length and cooler height vs case; PSU size, length, wattage (with an estimated power draw) and GPU power connectors; M.2 slot count and sizes; SATA ports; 3.5" bays; SAS drives without an HBA; and whether there’s any video output.'),
    P('Use ', B('Duplicate'), ' to try variations, or link a build to an existing device to plan an upgrade.'),
  ]],
  ['library', 'Parts library', () => [
    P('The library holds specs for real parts from ', h('a', { href: 'https://github.com/buildcores/buildcores-open-db', target: '_blank', rel: 'noopener noreferrer' }, 'BuildCores OpenDB'),
      ', an open, community-maintained database (CC BY-NC-SA 4.0: free for personal, non-commercial use). PCPartPicker itself has no public API and doesn’t allow scraping, so HaRM doesn’t use it.'),
    UL(
      [B('Download / update'), ' from ', link('#/library', 'Parts Library'), '. It takes under a minute; run it again any time for newer parts. The server needs internet access for this; nothing else in HaRM does.'],
      [B('Prices'), ' aren’t in the data. Enter what you paid or expect to pay.'],
      [B('Custom parts'), ': ', B('+ Custom part'), ', or ', B('Make custom copy'), ' of a library part to correct its specs.'],
      [B('Inventory link'), ': on a spare part, ', B('▦ Find in library'), ' fills model, part number, capacity, interface and form factor and links it, so builds can check it. ', B('Add to inventory'), ' on a library part does the reverse.']),
    P('Library data can have gaps or mistakes. Double-check anything critical, like radiator support or exact clearances.'),
  ]],
  ['networks', 'Networks, IPs and VLANs', () => [
    OL(
      ['Add your networks in ', link('#/networks', 'Networks & IPs'), ': name, VLAN ID, subnet (e.g. ', C('10.0.10.0/24'), '), gateway, DHCP pool and DNS.'],
      ['On a device, add interfaces with their IP. You can type ', C('10.0.10.5/24'), ' and HaRM splits out the prefix. The network is detected from the IP automatically.'],
      ['Open a network to see its ', B('IP map'), ': every address in use, which device has it, duplicates, static IPs sitting inside the DHCP pool, and the next free addresses. Tap a free address to assign it.']),
    P('Interfaces also record IPv6, assignment type (static / DHCP reservation / DHCP), DNS servers and name, MAC (normalized to ', C('AA:BB:CC:DD:EE:FF'), '), speed, MTU, PoE, link state, parent bond/bridge, Wi-Fi SSID, and switch-port mode: access VLAN, or a trunk’s native and tagged VLANs.'),
    P('The dashboard warns when the same IP is recorded on two interfaces.'),
  ]],
  ['logins', 'Storing logins', () => [
    UL(
      ['Add logins from a device page or the ', link('#/vault', 'Vault'), '. Passwords, 2FA secrets and secret notes are encrypted with your master password.'],
      ['Paste a 2FA setup key or an ', C('otpauth://'), ' link into the TOTP field and HaRM shows live 6-digit codes.'],
      [B('Reveal'), ' shows a login for 60 seconds. Every reveal is recorded in the ', link('#/audit', 'Audit Log'), '.'],
      ['Set “Last rotated” and Home reminds you about logins older than a year.']),
  ]],
  ['forms', 'Forms, unsaved changes and drafts', () => [
    UL(
      ['If you close a form with changes (✕, Escape, clicking outside, or Cancel), HaRM asks: ', B('Keep editing'), ', ', B('Discard'), ' or ', B('Save'), '.'],
      ['What you type is also kept as a draft on this device. If the form closes anyway (auto-lock, the phone reloads the tab), reopen the same form and your changes are restored. Passwords and secret notes are never kept in drafts.'],
      [B('Save & add another'), ' saves and opens a fresh form with the shared fields still filled in. A green “✓ Saved” note at the top confirms the last one went in.'],
      ['Forms show the basics first. ', B('▸ More details'), ' opens the optional fields (system, purchase, notes…).'],
      ['After saving, a ', B('← Back to …'), ' button takes you to where you were (for example the rack you came from). Detail pages also have a back link at the top.'],
      ['If saving fails, the reason appears next to the Save button and the field in question is highlighted.'],
      [C('Ctrl'), '/', C('⌘'), ' + ', C('Enter'), ' saves the open form.']),
  ]],
  ['notes', 'Notes, tasks and history', () => [
    P('Every device, rack and room has a ', B('Notes & tasks'), ' box. Type and press Enter; no edit dialog needed.'),
    UL(
      [B('📝 Note'), ': anything worth remembering (“iDRAC shares NIC 1”).'],
      [B('☐ Task'), ': something to do. Tick it off when done; it’s kept as history.'],
      [B('🔧 Did'), ': a record of work done (“Replaced PSU 2”, “Updated BIOS to 2.8”).'],
      [B('⚠ Issue'), ': something broken. Marking a drive failed in a bay adds an issue automatically.']),
    P('Open tasks and issues appear on Home and on the ', link('#/tasks', 'Tasks & Notes'), ' page. Pin important notes to keep them on top. Search finds note text, and exports include open tasks and recent history.'),
  ]],
  ['hardware', 'CPU, memory and drive bays', () => [
    UL(
      [B('Processors'), ': ', B('+ Add CPU'), ' to pick a model (the library includes common server CPUs: Opteron 4100 to 4300 and 6100, Xeon 5500/5600, X3400, E5 v1 to v4, Scalable, EPYC). Cores and threads fill in automatically, with totals for multi-socket servers. Not listed? Enter the specs once and it’s saved for reuse.'],
      [B('Memory'), ': shows sticks grouped by size and type with the total, plus a slot map if you add memory slots.'],
      [B('Drive bays'), ': add a group per set of bays: a name (Front, Rear…), the size (3.5"/2.5"), how many, what it accepts (tap ', B('SAS'), ' and ', B('SATA'), ' for bays that take both), and its RAID/controller. Two arrays or two cages? Make two groups.'],
      ['Each bay shows as a box. Tap an empty one to add a drive (or fill all empty bays with identical drives); tap a full one to edit it, move it to spares, or mark it failed.'],
      ['Each group shows its own raw total and RAID calculator, and the Storage card adds them all up.']),
  ]],
  ['labels', 'QR labels', () => [
    P(B('🏷 Label'), ' on a device (or ', B('🔳 QR labels'), ' on Export & Share for several) prints stickers with the name, model, serial, IP and a QR code. Scan the QR with your phone’s camera, or with ', B('+ New > Scan a HaRM label'), ', to jump straight to that device.'),
    P('Use “Save as PDF” to send them to a label printer, or print on sticker paper.'),
  ]],
  ['backups', 'Automatic backups', () => [
    P('HaRM makes a snapshot of its database every day into data/backups on the server and keeps the last 14. Logins stay encrypted inside them. Settings lists the latest ones. Copy that folder to another disk or machine now and then; a backup on the same drive won’t survive that drive failing.'),
  ]],
  ['import', 'Fill in specs automatically', () => [
    P('Instead of typing CPU, RAM, drives and network cards by hand, let HaRM read them. Open the device and click ', B('⇩ Import specs'), ', then pick one of three ways:'),
    UL(
      [B('🔌 Over SSH'), ': HaRM connects from the server using a login saved on that device in the vault (or a username with the server’s SSH keys), runs the read-only collector, and shows the results. Works with Linux, macOS and Windows with OpenSSH. Leave ', B('Use sudo'), ' on to include the serial number and memory sticks. The saved password never leaves the server. The first connection remembers the machine’s SSH key, and HaRM refuses to connect if it later changes, unless you confirm the machine was reinstalled.'],
      [B('🖥 This computer'), ': for the machine HaRM runs on. No SSH needed.'],
      [B('📋 Run it yourself'), ': copy the command for that machine’s OS, run it there, and paste the output. Use this for machines HaRM can’t reach. The command checks the script’s fingerprint before running it.']),
    P('Then tick what you want: device details (hostname, OS, model, serial, CPU, RAM), each drive and memory stick as an installed part with its serial, and each network card with its IP and MAC.'),
    P('Things already recorded (same serial or MAC) are unticked automatically, so importing twice doesn’t duplicate anything.'),
    P('For servers without an OS yet, the serial is on the pull-out tag or label. Use the 📷 button to scan it.'),
  ]],
  ['storage', 'Storage totals and sizes', () => [
    UL(
      ['Add drives as parts (or with Import specs). Tap a standard size such as 4 TB; anything typed like “4tb” is tidied to “4 TB” automatically.'],
      ['Each device has a ', B('Storage'), ' card: drives grouped by size, the raw total, and a calculator for what you’d get as JBOD, RAID 0/1/5/6/10 or RAIDZ1-3, including the TiB figure most OSes display.'],
      ['Spare Parts shows the total of the drives you’re looking at (e.g. all spares), and Home shows installed and spare totals.'],
      [B('Connection'), ' means how a drive plugs in (SATA, SAS, NVMe). RAID is configured on the controller, so it isn’t a connection. SAS bays accept SATA drives too.']),
  ]],
  ['export', 'Export, share and PDFs', () => [
    P('Open ', link('#/export', 'Export & Share'), ' (or ', B('⇪ Export / PDF'), ' on a device or the device list).'),
    OL(['Pick devices: filter by location, rack, type or status, then select.'], ['Choose what to include.'], ['Pick an output.']),
    UL(
      [B('Copy for AI / chat'), ': clean Markdown you can paste straight into a chat with a person or an AI assistant when asking for help.'],
      [B('Markdown, CSV, JSON'), ' downloads for documents, spreadsheets or scripts.'],
      [B('Spec sheet (PDF)'), ': a tidy printable summary of each device.'],
      [B('Sell sheet (PDF)'), ': hides internal details (location, IPs, hostnames) and adds a title, condition, asking prices and a contact line.']),
    P('PDFs use the browser’s print dialog: choose “Save as PDF”. Passwords and secrets are never exported.'),
  ]],
  ['ai', 'AI Assist: photos to inventory', () => [
    P('Log a pile of hardware in minutes: photograph it, let an AI identify and price it, and bring the results into HaRM. Works with any AI app (ChatGPT, Claude, Gemini…); HaRM never sends anything anywhere itself.'),
    OL(
      ['Open ', B('🤖 AI Assist'), ' from ', B('+ New'), ', Spare Parts, or a location or rack page (then everything goes there).'],
      ['Optionally pick where the things are and add a hint (“drives pulled from the R515s”).'],
      [B('Copy prompt'), ', paste it into your AI app and attach your photos. Turn on web search so it can find the original price and today’s used value, with sources.'],
      ['Paste the AI’s reply into HaRM and press ', B('Read reply'), '. Check the preview: fix names, set quantities, untick anything you don’t want, and use 📷 to scan a serial the AI couldn’t read.'],
      [B('Add'), '. Devices and parts are created where you chose; the AI’s research (values, sources, labels it read) is saved as a note on each, and its to-dos (“scan the service tag”, “test drive health”) become tasks.']),
    UL(
      ['Photos work best with labels facing the camera and in focus. Several photos of the same pile are fine.'],
      ['Serials already in HaRM are flagged and unticked, so re-importing a photo doesn’t create duplicates.'],
      ['Each item gets ', B('Original price'), ', ', B('Current value'), ' and the date it was checked. Update them any time in the item’s form.'],
      ['AI can misread labels: check serials against the label before relying on them. Low-confidence items are marked.']),
  ]],
  ['discover', 'Discover: bring in what’s on your network', () => [
    P(link('#/discover', 'Discover'), ' finds devices and lets you add them in bulk. Nothing is saved until you press ', B('Apply'), ' or ', B('Import'), '. Pick whichever source fits your setup:'),
    h('dl', { class: 'kv help-kv' },
      h('dt', null, 'Any router'), h('dd', null, 'Works with almost everything (pfSense, OPNsense, OpenWrt, Pi-hole, MikroTik, Omada, ASUS, Netgear, ISP routers…). Copy the router’s list of connected devices or DHCP leases and paste it. HaRM reads IP, MAC and name from tables, lease files, CSV exports and ', C('arp -a'), ' output. The Discover tab lists where each router keeps that list.'),
      h('dt', null, 'UniFi'), h('dd', null, 'For UniFi OS consoles (UDM, UCG, UDR, UXG, Cloud Key Gen2+) with UniFi Network 9 or newer. Create an API key in the Network app under ', B('Settings > Control Plane > Integrations'), ' (some versions: ', B('Settings > System > Integrations'), ' or ', B('Control Plane > API Access'), '). Brings in UniFi gear, clients with switch port or Wi-Fi, fixed-IP reservations and VLANs. Older self-hosted UniFi Network Server has no API keys: use Any router with its Client Devices list.'),
      h('dt', null, 'Proxmox'), h('dd', null, 'Imports your cluster, its nodes and every VM and container (vCPU, memory, disk, running or not, and IPs if the QEMU guest agent is installed). Needs a read-only API token: Datacenter > Permissions > API Tokens, with the PVEAuditor role on ', C('/'), '.'),
      h('dt', null, 'Network scan'), h('dd', null, 'Sweeps a private range from the HaRM server: common ports, names and MAC addresses. Good for finding servers and web UIs; phones and locked-down devices may not answer.')),
    h('h4', null, 'Reviewing results'),
    UL(
      [B('New'), ' devices aren’t in HaRM yet: choose ', B('Add as new device'), ' (HaRM suggests a type: phones, tablets, TVs, consoles, smart-home gear, switches…) or ', B('Attach to'), ' an existing device, e.g. an iDRAC address to its server.'],
      [B('IP changed'), ' devices are matched by MAC but HaRM has an older address; they’re pre-set to update.'],
      ['Matches use MAC first, then IP, then the device’s management URL, then name.'],
      [B('Hide'), ' anything you never want to track. Hidden devices stay out of future results.']),
  ]],
  ['virtual', 'Virtual machines & clusters', () => [
    P('A VM or container is a device of type ', B('Virtual Machine'), ' or ', B('Container'), ' that ', B('runs on'), ' a host. It gets everything a device has (IPs, services, logins, notes) plus its VM ID, vCPUs, memory and disk, and it never takes rack space.'),
    UL(
      ['On a host’s page, the ', B('VMs'), ' tab lists its guests and how much of the host’s CPU threads and memory they claim (over 100% means overcommitted).'],
      ['A ', B('cluster'), ' groups hosts (Proxmox, Kubernetes, vSphere, Ceph…). Its page shows the nodes, every guest and combined resources. Set a host’s cluster in its form (More details) or with ', B('+ Add node'), '.'],
      [link('#/virtual', 'Virtual & Clusters'), ' lists every cluster, host and VM in one place.'],
      ['Running Proxmox? ', link('#/discover', 'Discover > Proxmox'), ' imports all of it, and re-importing updates what changed.']),
    h('h4', null, 'Main address'),
    P('When a device has several IPs (say, the OS plus an iDRAC), HaRM uses its ', B('main address'), ' for the summary, quick links, logins and lists. Management ports are never picked automatically. To choose, tap the 🌐 address on the device page and pick ', B('☆ Main'), ', or tick ', B('Main address'), ' on the interface.'),
  ]],
  ['trouble', 'Troubleshooting: can’t connect', () => troubleshootingContent()],
  ['mobile', 'Phone & scanning', () => [
    P('HaRM works on phones and can be installed as an app (its own icon, no browser bars, long-press shortcuts for Scan, Devices and Tasks). Chrome only allows installing sites it fully trusts, so your phone has to trust HaRM’s certificate once. ', btn('📱 Show me how', phoneAppHelp, 'sm primary')),
    h('h4', null, 'Scanning labels'),
    UL(
      [B('📷 buttons'), ' next to serial number, part number, model, asset tag and MAC fields scan into that one field.'],
      [B('📷 Scan label'), ' at the top of device and part forms reads the whole label and lets you send each value to the right field. Labelled values (“S/N:”, “P/N:”, “MAC”) are pre-matched.'],
      [B('+ New > New part from label'), ' opens a new part with the scanner already running. Ideal for a stack of drives.'],
      [B('Photo mode'), ' works everywhere. It decodes barcodes and QR codes and, when the server has text recognition installed (tesseract), also reads printed text. Photos are processed and discarded; they are never stored.'],
      [B('Live mode'), ' scans continuously from the camera: hold a barcode inside the box and it’s added to the list (the phone buzzes). Several codes? Aim at each in turn, then choose. ', B('📝 Read text'), ' reads printed text in view. Browsers only allow live mode over HTTPS.'],
      ['Every word read from a label is shown as a chip; tap one to use it if the guesses missed.'],
      [B('+ New > Scan text or barcode'), ' is a general scanner that just copies what it reads.']),
    h('h4', null, 'Hosting it on a server for your phone'),
    OL(
      ['On the server, run HaRM listening on the network with HTTPS. The simplest built-in way:',
        h('pre', { class: 'code' }, './scripts/make-cert.sh harm.lan 192.168.1.50\nHARM_HOST=0.0.0.0 HARM_TLS=1 ./run.sh')],
      ['Open ', C('https://<server-ip>:8077'), ' on your phone. A self-signed certificate shows a warning the first time. Install ', C('data/tls/harm-ca.crt'), ' on the phone to trust it permanently, or proceed past the warning.'],
      ['Alternative with a fully trusted certificate: put HaRM behind Caddy/nginx with HTTPS.']),
    P('Keep HaRM on your LAN or VPN. Don’t expose it to the internet.'),
  ]],
  ['security', 'Security & backups', () => [
    UL(
      ['Logins are encrypted (AES-256-GCM). The key is unlocked by your master password and only kept in server memory while you’re signed in. A server restart locks everything.'],
      ['HaRM locks itself after a period of inactivity (Settings shows how long).'],
      ['Turn on 2FA in ', link('#/settings', 'Settings'), ' so unlocking also needs a code from your phone.'],
      ['Keep your recovery code offline. With neither the password nor the recovery code, stored logins cannot be recovered. The rest of your inventory is not encrypted and is unaffected.'],
      ['Download backups from Settings. CSV exports never include passwords.']),
  ]],
  ['keys', 'Keyboard shortcuts', () => [P('The same keys work in every ZomBeatz app. Single keys don’t fire while you’re typing in a box.'), shortcutsList()], { keyboard: true }],
  ['search', 'Search and adding', () => [
    UL(
      ['The top search box finds devices, IPs, MACs, serials, services, parts, holders, locations, networks and logins (labels and usernames only).'],
      ['Click any table header to sort by it.'],
      [B('+ New'), ' in the top bar adds anything from any page.'],
      ['The box at the top of a list (devices, parts, logins) filters just that list.'],
      ['Device pages have ', B('Clone'), ' for adding several identical machines.']),
  ]],
];

function viewHelp(section) {
  const HELP_HERE = HELP.filter(([, , , o]) => !(o && o.keyboard) || hasKeyboard());
  render(
    pageHead('Help & guide', 'How HaRM works and how to get the most out of it.',
      h('a', { class: 'button primary', href: '#/setup' }, '🧭 Setup guide')),
    h('nav', { class: 'card help-toc' }, h('ul', null, HELP_HERE.map(([id, title]) =>
      h('li', null, h('a', { href: `#/help?s=${id}` }, title))))),
    HELP_HERE.map(([id, title, body]) => h('section', { class: 'card help-sec', id: `help-${id}` }, h('h2', null, title), body())));
  if (section) setTimeout(() => document.getElementById(`help-${section}`)?.scrollIntoView({ block: 'start' }), 0);
}

// ---------------------------------------------------------------- PC builder & parts library

async function pcMeta() {
  if (!S.pc) S.pc = await GET('/catalog/meta');
  return S.pc;
}
const catLabel = k => (S.pc?.categories.find(c => c.key === k) || {}).label || k;
const sourceBadge = src => h('span', { class: `badge ${src === 'custom' ? 'info' : src === 'inventory' ? 'ok' : 'muted'}` },
  { library: 'Library', custom: 'Custom', inventory: 'My inventory', manual: 'Manual' }[src] || src);

function fmtSpec(type, v) {
  if (v == null || v === '') return '';
  if (type === 'bool') return v ? 'Yes' : 'No';
  if (type === 'm2') return v.map(m => `${(m.sizes || []).join('/')}${m.interface ? ` (${m.interface})` : ''}`).join(', ');
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

function startLibraryUpdate(onDone) {
  const msg = h('p', null, h('span', { class: 'spinner' }), ' Starting…');
  const m = modal('Updating the parts library', h('div', null, msg,
    h('p', { class: 'muted small' }, 'Downloading BuildCores OpenDB (about 16 MB) and importing ~30,000 parts. You can close this; it keeps going in the background.'),
    h('div', { class: 'actions' }, btn('Close', () => m.close(true)))));
  api('POST', '/catalog/update').catch(e => { msg.textContent = e.message; });
  const poll = setInterval(async () => {
    if (!S.authed) return clearInterval(poll);
    let st;
    try { st = await GET('/catalog/status'); } catch { return; }
    const j = st.job;
    if (j.phase === 'downloading') msg.replaceChildren(h('span', { class: 'spinner' }), ` Downloading… ${(j.done / 1048576).toFixed(1)} MB`);
    else if (j.phase === 'importing') msg.replaceChildren(h('span', { class: 'spinner' }), ` Importing… ${j.done.toLocaleString()} parts`);
    if (!j.running && (j.phase === 'done' || j.phase === 'failed')) {
      clearInterval(poll);
      if (j.phase === 'failed') { msg.replaceChildren(h('span', { class: 'bad-text' }, `Update failed: ${j.error}`)); return; }
      msg.textContent = `✓ Done: ${st.total.toLocaleString()} parts in your library.`;
      toast('Parts library updated');
      if (onDone) onDone();
    }
  }, 1000);
}

function libraryEmptyCard(after) {
  return h('div', { class: 'card onboarding' },
    h('h3', null, 'Set up the parts library'),
    h('p', null, 'Download about 30,000 parts (CPUs, motherboards, memory, video cards, cases, power supplies, coolers, storage and fans) with the specs HaRM needs for compatibility checks. Source: BuildCores OpenDB, free for personal use. About 16 MB; it takes under a minute.'),
    btn('⬇ Download parts library', () => startLibraryUpdate(after || rerender), 'primary'),
    h('p', { class: 'muted small' }, 'Prefer not to? You can still use your own inventory and custom parts.'));
}

/* Search box + results for one category. onAdd(part) gets the chosen library part. */
function librarySearch({ category, q = '', buildId = null, addLabel = 'Add', onAdd, categorySelect = false, source = '' }) {
  const state = { category, source };
  const input = h('input', { type: 'search', value: q, placeholder: 'Search by name, model or part number…' });
  const onlyOk = h('input', { type: 'checkbox', checked: true });
  const list = h('div', { class: 'pick-list' });
  const note = h('div', { class: 'muted small pick-note' });
  const catSel = categorySelect ? h('select', { value: category, onchange: e => { state.category = e.target.value; run(); } },
    S.pc.categories.filter(c => c.key !== 'other').map(c => h('option', { value: c.key }, c.label))) : null;
  const srcSel = categorySelect ? h('select', { value: source, onchange: e => { state.source = e.target.value; run(); } },
    h('option', { value: '' }, 'All parts'), h('option', { value: 'opendb' }, 'Library'), h('option', { value: 'custom' }, 'My custom parts')) : null;
  let seq = 0, timer;
  const run = async () => {
    const my = ++seq;
    list.replaceChildren(h('div', { class: 'muted pad' }, h('span', { class: 'spinner' }), ' Searching…'));
    const qs = new URLSearchParams({ category: state.category, q: input.value, limit: 60 });
    if (buildId) { qs.set('build_id', buildId); qs.set('compatible', onlyOk.checked ? 1 : 0); }
    if (state.source) qs.set('source', state.source);
    let r;
    try { r = await GET('/catalog/search?' + qs); } catch (e) { list.replaceChildren(h('div', { class: 'form-error' }, e.message)); return; }
    if (my !== seq) return;
    list.replaceChildren(...(r.results.length ? r.results.map(p => partRow(p, addLabel, onAdd ? () => onAdd(p, state.category) : null))
      : [h('div', { class: 'empty' }, input.value ? 'No matches.' : 'Nothing in this category yet.')]));
    note.textContent = [r.more ? 'Showing the first 60; type more to narrow it down.' : '',
      r.hidden_incompatible ? `${r.hidden_incompatible} incompatible part${r.hidden_incompatible === 1 ? '' : 's'} hidden.` : ''].filter(Boolean).join(' ');
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 250); });
  onlyOk.addEventListener('change', run);
  run();
  return h('div', { class: 'lib-search' },
    h('div', { class: 'toolbar' }, catSel, input, srcSel,
      buildId ? h('label', { class: 'check inline-check' }, onlyOk, h('span', null, 'Only compatible')) : null),
    note, list);
}

function partRow(p, addLabel, onAdd) {
  return h('div', { class: 'pick-row' + (p.issues?.length ? ' has-issues' : '') },
    h('div', { class: 'pick-main' },
      h('div', null, h('b', null, p.name), ' ', p.source === 'custom' ? sourceBadge('custom') : null, p.release_year ? h('span', { class: 'muted small' }, ` ${p.release_year}`) : null),
      h('div', { class: 'muted small' }, p.summary || 'No specs'),
      p.issues?.length ? h('div', { class: 'bad-text small' }, '✗ ' + p.issues.join(' ')) : null),
    h('div', { class: 'pick-actions' },
      small('Details', () => partDetail(p.id)),
      onAdd ? small(addLabel, onAdd, p.issues?.length ? '' : 'primary') : null));
}

function customFields(cat) {
  const t = { num: 'number', bool: 'checkbox', text: 'text', list: 'text', m2: 'text' };
  return [
    { k: 'name', label: 'Name', required: true, wide: true, ph: 'e.g. Supermicro X11SCH-F' },
    { k: 'manufacturer', label: 'Manufacturer' },
    { k: 'part_numbers', label: 'Part number(s)', scan: true },
    { section: 'Specs used for compatibility checks (fill what you know)' },
    ...(S.pc.spec_fields[cat] || []).map(f => ({
      k: 'spec_' + f.k, label: f.label, type: t[f.type], step: f.type === 'num' ? 'any' : null,
      help: f.type === 'list' ? 'Comma-separated' : f.type === 'm2' ? 'One entry per slot: 2280, 2280, 2242-2280' : null,
    })),
    { k: 'notes', label: 'Notes', type: 'textarea', wide: true },
  ];
}

async function customPartDialog(rec, after) {
  await pcMeta();
  const isNew = !rec.id;
  let cat = rec.category || 'cpu';
  if (!isNew) {
    const full = await GET(`/catalog/${rec.id}`);
    rec = { ...full, ...Object.fromEntries(Object.entries(full.form_specs || {}).map(([k, v]) => ['spec_' + k, v])) };
    cat = rec.category;
  }
  const catPick = isNew && !rec.lockCategory
    ? h('div', { class: 'field wide' }, h('label', null, 'Category'), h('select', {
      value: cat, onchange: e => { m.close(true); customPartDialog({ ...rec, category: e.target.value }, after); },
    }, S.pc.categories.map(c => h('option', { value: c.key }, c.label))))
    : null;
  const { m } = formDialog({
    title: `${isNew ? 'New custom' : 'Edit custom'} part: ${catLabel(cat)}`,
    fields: customFields(cat), rec, wide: true,
    draftKey: `catalog:${rec.id || 'new-' + cat}`,
    extra: catPick,
    submit: async vals => {
      const specs = {}, body = { category: cat };
      for (const [k, v] of Object.entries(vals)) {
        if (k.startsWith('spec_')) specs[k.slice(5)] = v;
        else body[k] = v;
      }
      body.specs = specs;
      const r = isNew ? await api('POST', '/catalog', body) : await api('PUT', `/catalog/${rec.id}`, body);
      toast(isNew ? 'Custom part saved' : 'Saved');
      return r;
    },
    onDone: r => (after || rerender)(r),
  });
  if (catPick) m.box.querySelector('form').prepend(catPick);
}

async function partDetail(id) {
  await pcMeta();
  const p = await GET(`/catalog/${id}`);
  const fields = S.pc.spec_fields[p.category] || [];
  const rows = fields.map(f => [f.label, fmtSpec(f.type, p.specs[f.k])]);
  let m;
  const toBuild = async () => {
    const builds = await GET('/builds');
    formDialog({
      title: 'Add to a build',
      fields: [{ k: 'build_id', label: 'Build', type: 'select', required: true, options: [{ value: 'new', label: '+ New build' }, ...builds.map(b => ({ value: String(b.id), label: b.name }))] },
        { k: 'quantity', label: 'Quantity', type: 'number', min: 1, default: 1 }],
      rec: { build_id: builds[0] ? String(builds[0].id) : 'new' },
      saveLabel: 'Add',
      submit: async v => {
        let bid = v.build_id;
        if (bid === 'new') bid = (await api('POST', '/builds', { name: `New build (${p.name.slice(0, 40)})`, status: 'Planning' })).id;
        await api('POST', '/build_items', { build_id: +bid, category: p.category, catalog_id: p.id, quantity: v.quantity || 1, acquire: 'Need' });
        return bid;
      },
      onDone: bid => { m.close(true); location.hash = `#/builds/${bid}`; },
    });
  };
  const toInventory = () => formDialog({
    title: `Add to inventory: ${p.name}`,
    fields: [
      { k: 'quantity', label: p.category === 'memory' ? 'Kits' : 'Quantity', type: 'number', min: 1, default: 1, help: p.category === 'memory' ? 'Inventory counts individual sticks.' : null },
      { k: 'status', label: 'Status', type: 'select', options: S.enums.component_statuses, required: true, default: 'In Stock' },
      { k: 'condition', label: 'Condition', list: 'component_conditions' },
      { k: 'purchase_price', label: 'Price (each)', type: 'number', step: '0.01', min: 0 },
      { k: 'location_id', label: 'Location (room)', type: 'fk', entity: 'locations' },
      { k: 'rack_id', label: 'Stored in (holder)', type: 'fk', entity: 'racks', none: 'None (loose in the room)', scopeBy: ['location_id'], scope: rackInLocation, onChange: rackPicked },
      { k: 'position', label: 'Spot' },
    ],
    saveLabel: 'Add to inventory',
    submit: v => api('POST', `/catalog/${p.id}/to-inventory`, v),
    onDone: c => { toast('Added to inventory'); m.close(true); location.hash = `#/components?id=${c.id}`; },
  });
  m = modal(p.name, h('div', { class: 'part-detail' },
    h('div', { class: 'inline' }, sourceBadge(p.source === 'custom' ? 'custom' : 'library'), h('span', { class: 'badge muted' }, catLabel(p.category)),
      p.inventory_count ? h('span', { class: 'badge ok' }, `${p.inventory_count} in your inventory`) : null),
    kv([['Manufacturer', p.manufacturer], ['Part numbers', p.part_numbers ? mono(p.part_numbers) : ''], ['Released', p.release_year], ...rows, ['Notes', p.notes]]),
    h('div', { class: 'actions wrap' },
      p.source === 'custom' ? btn('Delete', async () => {
        if (!await confirmBox(`Delete custom part "${p.name}"? Builds keep its name.`)) return;
        await api('DELETE', `/catalog/${p.id}`); toast('Deleted'); m.close(true); rerender();
      }, 'ghost-danger') : null,
      p.source === 'custom' ? btn('Edit', () => { m.close(true); customPartDialog({ id: p.id }); })
        : btn('Make custom copy', async () => { const c = await api('POST', `/catalog/${p.id}/copy`); m.close(true); customPartDialog({ id: c.id }); }),
      btn('Add to inventory', toInventory),
      btn('Add to build', toBuild, 'primary'))), { wide: true });
}

async function viewLibrary() {
  const [st] = await Promise.all([GET('/catalog/status'), pcMeta()]);
  const F = S.filters.library = S.filters.library || { cat: 'cpu' };
  const counts = {};
  for (const r of st.counts) counts[r.category] = (counts[r.category] || 0) + r.n;
  const src = st.source;
  render(
    pageHead('Parts Library', st.total ? `${st.total.toLocaleString()} parts to plan builds with and catalog your inventory.` : 'Specs for PC parts, used for builds and compatibility checks.',
      helpLink('library'),
      btn('+ Custom part', () => customPartDialog({ category: F.cat }, () => viewLibrary())),
      btn(st.total ? '⟳ Update library' : '⬇ Download library', () => startLibraryUpdate(() => viewLibrary()), st.total ? '' : 'primary')),
    st.total ? null : libraryEmptyCard(() => viewLibrary()),
    h('div', { class: 'card' }, librarySearch({ category: F.cat, categorySelect: true })),
    h('div', { class: 'card muted small attribution' },
      h('p', null, S.pc.attribution),
      src ? h('p', null, `Last imported ${src.at}${src.ref ? ` (source ${src.ref})` : ''}: ${src.imported.toLocaleString()} parts.`) : null,
      h('p', null, 'In the library: ', S.pc.categories.filter(c => counts[c.key]).map(c => `${c.label} ${counts[c.key].toLocaleString()}`).join(' · ') || 'nothing yet', '.')));
}

async function libraryLookup(form) {
  await pcMeta();
  const map = { HDD: 'storage', SSD: 'storage', 'NVMe SSD': 'storage', RAM: 'memory', CPU: 'cpu', GPU: 'gpu', PSU: 'psu',
    Motherboard: 'motherboard', 'Cooler / Fan': 'cooler', NIC: 'nic' };
  const cat = map[form.get('category')] || 'storage';
  const q = form.get('part_number') || form.get('model') || '';
  const m = modal('Find in parts library', librarySearch({
    category: cat, q, categorySelect: true, addLabel: 'Use this',
    onAdd: async p => {
      const f = await GET(`/catalog/${p.id}/component-fields`);
      delete f.quantity;
      form.set(f);
      m.close(true);
      toast('Filled from the library');
    },
  }), { wide: true });
}

async function pickPart(build, cat, replace) {
  await pcMeta();
  const label = catLabel(cat);
  const body = h('div');
  const tabBar = h('div', { class: 'tabs' });
  let m;
  const addItem = async payload => {
    try {
      if (replace) await api('DELETE', `/build_items/${replace.id}`);
      await api('POST', '/build_items', { build_id: build.id, category: cat, quantity: replace?.qty || 1, ...payload });
      m.close(true);
      toast(`${label} ${replace ? 'swapped' : 'added'}`);
      viewBuild(build.id);
    } catch (e) { toast(e.message, 'bad'); }
  };
  const tabs = {
    library: ['Parts library', async () => {
      const st = await GET('/catalog/status');
      const custom = st.counts.some(c => c.category === cat && c.source === 'custom');
      body.replaceChildren(st.total || custom ? librarySearch({ category: cat, buildId: build.id, onAdd: p => addItem({ catalog_id: p.id, acquire: 'Need' }) })
        : libraryEmptyCard(() => { m.close(true); pickPart(build, cat, replace); }));
    }],
    inventory: ['My spare parts', async () => {
      body.replaceChildren(h('div', { class: 'muted pad' }, h('span', { class: 'spinner' }), ' Loading…'));
      const rows = await GET(`/builds/${build.id}/inventory?category=${cat}`);
      body.replaceChildren(rows.length ? h('div', { class: 'pick-list' }, rows.map(c => h('div', { class: 'pick-row' + (c.issues.length ? ' has-issues' : '') },
        h('div', { class: 'pick-main' },
          h('b', null, [c.manufacturer, c.model, c.capacity].filter(Boolean).join(' ') || c.category),
          h('div', { class: 'muted small' }, [c.summary, `${c.quantity} on hand`, c.rack_name || c.location_name, c.condition].filter(Boolean).join(' · ')),
          c.issues.length ? h('div', { class: 'bad-text small' }, '✗ ' + c.issues.join(' ')) : null,
          !Object.keys(c.specs).length ? h('div', { class: 'warn-text small' }, 'No specs known. Use “Find in library” on this part to enable checks.') : null),
        h('div', { class: 'pick-actions' }, small('Use', () => addItem({ component_id: c.id, acquire: 'Have' }), c.issues.length ? '' : 'primary')))))
        : h('div', { class: 'empty' }, `No spare ${label.toLowerCase()} in your inventory. Parts already installed in a device aren’t listed.`));
    }],
    custom: ['Custom part', async () => {
      const form = buildForm(customFields(cat), {});
      const err = h('div', { class: 'form-error' });
      const el = h('form', {
        onsubmit: async e => {
          e.preventDefault();
          if (!el.reportValidity()) return;
          const vals = form.values(), specs = {}, bodyP = { category: cat };
          for (const [k, v] of Object.entries(vals)) { if (k.startsWith('spec_')) specs[k.slice(5)] = v; else bodyP[k] = v; }
          bodyP.specs = specs;
          try { const p = await api('POST', '/catalog', bodyP); await addItem({ catalog_id: p.id, acquire: 'Need' }); }
          catch (x) { err.textContent = x.message; }
        },
      }, h('p', { class: 'muted small' }, 'For anything not in the library. It’s saved to your custom parts so you can reuse it.'),
      form.el, err, h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'primary' }, `Add custom ${label}`)));
      body.replaceChildren(el);
    }],
  };
  const show = k => {
    tabBar.replaceChildren(...Object.entries(tabs).map(([key, [t]]) => h('button', { type: 'button', class: key === k ? 'active' : '', onclick: () => show(key) }, t)));
    tabs[k][1]();
  };
  m = modal(`${replace ? 'Swap' : 'Choose'} ${label}`, h('div', null, tabBar, body), { wide: true, cls: 'picker' });
  show('library');
}

const BUILD_PURPOSE_DEVICE = { 'NAS': 'NAS', 'Homelab server': 'Server', 'Hypervisor host': 'Hypervisor Host', 'Router / firewall': 'Firewall', 'Workstation': 'Workstation' };

async function viewBuilds() {
  const [rows, st] = await Promise.all([GET('/builds'), GET('/catalog/status'), pcMeta()]);
  const newBuild = () => editEntity('builds', { status: 'Planning' }, r => { location.hash = `#/builds/${r.id}`; });
  render(
    pageHead('PC Builder', 'Plan builds from the parts library, your spare parts and custom parts, with compatibility checks.',
      helpLink('builder'), h('a', { class: 'button', href: '#/library' }, '▦ Parts library'), btn('+ New build', newBuild, 'primary')),
    st.total ? null : libraryEmptyCard(),
    rows.length ? h('div', { class: 'tiles' }, rows.map(b => h('a', { class: 'tile', href: `#/builds/${b.id}` },
      h('div', { class: 'tile-head' }, h('b', null, b.name), badge(b.status)),
      h('div', { class: 'muted small' }, [b.purpose, b.device_name ? `→ ${b.device_name}` : ''].filter(Boolean).join(' · ') || ' '),
      h('div', { class: 'small' }, `${b.item_count} part${b.item_count === 1 ? '' : 's'} · ${money(b.total_price)}${b.budget ? ` of ${money(b.budget)} budget` : ''}`))))
      : h('div', { class: 'card onboarding' }, h('h3', null, 'No builds yet'),
        h('p', null, 'A build is a parts list for one computer: a new gaming PC, a NAS from spare parts, or an upgrade to something you own. HaRM checks that everything fits together, and once it’s built, turns it into a device with its parts installed.'),
        btn('+ Start a build', newBuild, 'primary')));
}

async function viewBuild(id) {
  const [d] = await Promise.all([GET(`/builds/${id}/full`), pcMeta()]);
  const b = d.build, st = d.stats;
  const back = () => viewBuild(id);
  const itemIssues = itemId => d.checks.filter(c => (c.level === 'error' || c.level === 'warn') && c.items.includes(itemId));
  const put = async (itemId, patch) => { try { await api('PUT', `/build_items/${itemId}`, patch); back(); } catch (e) { toast(e.message, 'bad'); } };

  const statusEl = st.errors ? h('div', { class: 'compat bad' }, `✗ ${st.errors} compatibility problem${st.errors > 1 ? 's' : ''}`)
    : st.warnings ? h('div', { class: 'compat warn' }, `⚠ No blockers, ${st.warnings} thing${st.warnings > 1 ? 's' : ''} to check`)
      : d.items.length ? h('div', { class: 'compat ok' }, '✓ No compatibility problems found')
        : h('div', { class: 'compat' }, 'Add parts to check compatibility');
  let budgetBar = null;
  if (b.budget) {
    const fill = h('div', { class: 'bar-fill' + (st.total_price > b.budget ? ' hot' : '') });
    fill.style.width = `${Math.min(100, (st.total_price / b.budget) * 100)}%`;
    budgetBar = h('div', { class: 'bar-row' }, h('div', { class: 'bar' }, fill), h('div', { class: 'bar-n' }, `${money(st.total_price)} / ${money(b.budget)}`));
  }

  const rows = [];
  for (const c of S.pc.categories) {
    const its = d.items.filter(i => i.category === c.key);
    const single = S.pc.single.includes(c.key);
    const chooseBtn = small(its.length ? `+ Add another` : `+ Choose ${c.label}`, () => pickPart(b, c.key), its.length ? '' : 'primary');
    if (!its.length) {
      rows.push(h('tr', { class: 'empty-slot' }, h('th', null, c.label), h('td', { colspan: 5 }, chooseBtn)));
      continue;
    }
    its.forEach((it, idx) => {
      const issues = itemIssues(it.id);
      const worst = issues.some(x => x.level === 'error') ? 'error' : issues.length ? 'warn' : null;
      const acq = h('select', { class: 'acq ' + (it.acquire || '').toLowerCase(), value: it.acquire, 'aria-label': 'Have / need', onchange: e => put(it.id, { acquire: e.target.value }) },
        S.enums.acquire_states.map(a => h('option', { value: a }, a)));
      const qty = h('input', { type: 'number', min: 1, value: it.qty, class: 'qty', 'aria-label': 'Quantity', onchange: e => put(it.id, { quantity: e.target.value }) });
      const price = h('input', { type: 'number', min: 0, step: '0.01', value: it.price ?? '', placeholder: '$', class: 'price', 'aria-label': 'Price each', onchange: e => put(it.id, { price: e.target.value }) });
      const nameEl = it.catalog_id ? h('a', { href: '#', onclick: e => { e.preventDefault(); partDetail(it.catalog_id); } }, it.name)
        : it.component_id ? link(`#/components?id=${it.component_id}`, it.name) : h('span', null, it.name);
      rows.push(h('tr', { class: worst ? `has-${worst}` : '' },
        h('th', null, idx === 0 ? c.label : ''),
        h('td', { class: 'part-cell' },
          h('div', null, worst ? h('span', { class: worst === 'error' ? 'bad-text' : 'warn-text', title: issues.map(x => x.message).join('\n') }, worst === 'error' ? '✗ ' : '⚠ ') : null, nameEl, ' ', sourceBadge(it.source)),
          h('div', { class: 'muted small' }, it.summary || (it.source === 'manual' ? 'No specs' : '')),
          it.component_id && it.comp_device_id ? h('div', { class: 'warn-text small' }, 'Currently installed in another device') : null),
        h('td', { 'data-label': 'Status' }, acq),
        h('td', { 'data-label': 'Qty' }, qty),
        h('td', { 'data-label': 'Price' }, price),
        h('td', { class: 'row-actions' },
          single ? small('Swap', () => pickPart(b, c.key, it)) : null,
          small('Remove', async () => { await api('DELETE', `/build_items/${it.id}`); back(); }, 'ghost-danger'))));
    });
    if (!single || its.length === 0) rows.push(h('tr', { class: 'add-row' }, h('th'), h('td', { colspan: 5 }, chooseBtn)));
  }

  const lv = { error: ['✗', 'bad-text'], warn: ['⚠', 'warn-text'], info: ['ℹ', 'muted'], ok: ['✓', 'ok-text'] };
  const checkLi = c => h('li', null, h('span', { class: lv[c.level][1] }, lv[c.level][0]), ' ', c.message);
  const passed = d.checks.filter(c => c.level === 'ok');
  const toDevice = () => formDialog({
    title: 'Create a device from this build',
    fields: [
      { k: 'name', label: 'Device name', required: true, default: b.name },
      { k: 'device_type', label: 'Type', list: 'device_types', default: BUILD_PURPOSE_DEVICE[b.purpose] || 'Desktop' },
      { k: 'location_id', label: 'Location (room)', type: 'fk', entity: 'locations' },
      { k: 'rack_id', label: 'Rack / holder', type: 'fk', entity: 'racks', none: 'None (loose in the room)', scopeBy: ['location_id'], scope: rackInLocation, onChange: rackPicked },
      { k: 'install_inventory', label: 'Install the parts from my inventory into it', type: 'checkbox', default: true, wide: true },
      { k: 'create_components', label: 'Record library/custom parts as installed components', type: 'checkbox', default: true, wide: true },
    ],
    extra: h('p', { class: 'muted small' }, 'Also adds the motherboard’s memory, M.2, SATA and PCIe slots to the device, so spare-part matching works for future upgrades.'),
    saveLabel: 'Create device',
    submit: v => api('POST', `/builds/${id}/to-device`, v),
    onDone: async r => { await loadLookups(); toast(`Device created: ${r.slots} slots, ${r.installed + r.created} parts`); location.hash = `#/devices/${r.device_id}`; },
  });

  render(
    h('div', { class: 'crumbs' }, backLink(), link('#/builds', 'PC Builder'), ' › ', b.name),
    pageHead(h('span', null, b.name, ' ', badge(b.status)), [b.purpose, b.device_id ? null : ''].filter(Boolean).join(' · ') || null,
      helpLink('builder'),
      b.device_id ? h('a', { class: 'button', href: `#/devices/${b.device_id}` }, `→ ${b.device_name || 'Device'}`) : btn('🖥 Create device', toDevice, d.items.length ? 'primary' : ''),
      btn('Edit', () => editEntity('builds', b, back)),
      btn('Duplicate', async () => { const n = await api('POST', `/builds/${id}/duplicate`); location.hash = `#/builds/${n.id}`; }),
      btn('Delete', () => deleteEntity('builds', b, () => goBackOr('#/builds')), 'ghost-danger')),
    h('div', { class: 'build-summary card' },
      statusEl,
      h('div', { class: 'bs-stat' }, h('b', null, st.est_watts ? `~${st.est_watts} W` : 'None'), h('span', null, st.recommended_psu ? `estimated draw · ${st.recommended_psu} W+ PSU` : 'estimated draw')),
      h('div', { class: 'bs-stat' }, h('b', null, money(st.total_price)), h('span', null, st.to_buy_price ? `${money(st.to_buy_price)} still to buy` : 'total')),
      h('div', { class: 'bs-stat' }, h('b', null, `${st.have}/${d.items.length}`), h('span', null, `parts on hand${st.ordered ? ` · ${st.ordered} ordered` : ''}`)),
      budgetBar ? h('div', { class: 'bs-budget' }, budgetBar) : null),
    b.notes ? h('div', { class: 'card notes' }, b.notes) : null,
    h('div', { class: 'card' }, h('div', { class: 'table-wrap' }, h('table', { class: 'build-table' },
      h('thead', null, h('tr', null, h('th', null, 'Component'), h('th', null, 'Part'), h('th', null, 'Status'), h('th', null, 'Qty'), h('th', null, 'Price each'), h('th'))),
      h('tbody', null, rows)))),
    card('Compatibility', h('div', null,
      h('ul', { class: 'plain checks' }, d.checks.filter(c => c.level !== 'ok').map(checkLi)),
      passed.length ? h('details', null, h('summary', null, `${passed.length} check${passed.length > 1 ? 's' : ''} passed`), h('ul', { class: 'plain checks' }, passed.map(checkLi))) : null,
      h('p', { class: 'muted small' }, 'Checks: socket, memory type/slots/capacity, ECC/RDIMM, case fit for board, GPU length and cooler height, PSU form factor/length/wattage/connectors, M.2 and SATA capacity, drive bays, video output. Library data can have gaps; double-check anything critical.'))));
}

// ---------------------------------------------------------------- import specs (collector scripts)

/* The machines being inventoried usually don't trust HaRM's private certificate, so the
   download skips that check and the script's SHA-256 (shown here over the trusted
   connection) is verified before anything runs. */
function collectorCommands() {
  const base = `${location.origin}/static/collect`;
  const sha = S.caps.collect_sha256 || {};
  const sh = sha.sh
    ? `curl -fsSLk ${base}/harm-collect.sh -o harm-collect.sh && echo "${sha.sh}  harm-collect.sh" | `
    : null;
  const ps = sha.ps1
    ? `$p=@{}; if ($PSVersionTable.PSVersion.Major -ge 6) { $p.SkipCertificateCheck=$true } else { [Net.ServicePointManager]::ServerCertificateValidationCallback={$true} }; iwr @p ${base}/harm-collect.ps1 -UseBasicParsing -OutFile harm-collect.ps1; if ((Get-FileHash harm-collect.ps1).Hash -ne '${sha.ps1}') { throw 'Checksum mismatch: not running it' }; powershell -ExecutionPolicy Bypass -File .\\harm-collect.ps1 | Set-Clipboard`
    : `iwr ${base}/harm-collect.ps1 -OutFile harm-collect.ps1; powershell -ExecutionPolicy Bypass -File .\\harm-collect.ps1 | Set-Clipboard`;
  return [
    ['Linux', sh ? `${sh}sha256sum -c --quiet && sudo bash harm-collect.sh` : `curl -fsSL ${base}/harm-collect.sh -o harm-collect.sh && sudo bash harm-collect.sh`,
      'sudo is optional; it adds the serial number and memory stick details. The checksum check stops it if the download was tampered with.'],
    ['macOS', sh ? `${sh}shasum -a 256 -c -s && bash harm-collect.sh` : `curl -fsSL ${base}/harm-collect.sh -o harm-collect.sh && bash harm-collect.sh`, null],
    ['Windows (PowerShell)', ps, 'The result is copied to the clipboard; just paste it below.'],
  ];
}

function importSpecs(dev, d, after) {
  const textarea = h('textarea', { rows: 6, placeholder: 'Paste the output here (it starts with {"harm_collect"…)', spellcheck: 'false', class: 'mono' });
  const err = h('div', { class: 'form-error' });
  const preview = h('div');
  const cmds = collectorCommands();
  const manual = h('div', null,
    h('p', null, h('b', null, '1. On ', dev.name, ', run the command for its OS.'),
      ' It only reads hardware info and prints it. Nothing is sent anywhere. ',
      h('a', { href: '/static/collect/harm-collect.sh', target: '_blank', rel: 'noopener' }, 'Linux/macOS script'), ' · ',
      h('a', { href: '/static/collect/harm-collect.ps1', target: '_blank', rel: 'noopener' }, 'Windows script')),
    cmds.map(([os, cmd, note]) => h('div', { class: 'cmd' },
      h('div', { class: 'cmd-head' }, h('b', null, os), small('Copy', () => copy(cmd, `${os} command`))),
      h('pre', { class: 'code' }, cmd), note ? h('div', { class: 'muted small' }, note) : null)),
    h('p', { class: 'muted small' }, 'If that machine can’t reach HaRM, download the script here and copy it over on a USB stick.'),
    h('p', null, h('b', null, '2. Paste everything it printed:')), textarea,
    h('div', { class: 'actions' }, btn('Read it', () => parse(), 'primary')));
  const sshBox = h('div', null, h('div', { class: 'muted' }, 'Loading…'));
  const localBox = h('div', null,
    h('p', null, 'Use this when ', h('b', null, dev.name), ' is the computer HaRM itself runs on. The collector runs right here, without SSH.'),
    h('p', { class: 'muted small' }, 'It runs as the account HaRM runs under, so the serial number and memory stick details are only included if HaRM runs as root. Everything else (CPU, drives, network cards, GPU) is read normally.'),
    h('div', { class: 'actions' }, btn('Read this computer’s specs', async e => {
      e.target.disabled = true; err.textContent = '';
      try { await parse((await api('POST', `/devices/${dev.id}/collect`, { mode: 'local' })).output); }
      catch (x) { err.textContent = x.message; }
      e.target.disabled = false;
    }, 'primary')));
  const panes = { ssh: sshBox, local: localBox, manual };
  const tabs = h('div', { class: 'chips' });
  const showPane = k => {
    for (const [name, el] of Object.entries(panes)) el.hidden = name !== k;
    tabs.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c.dataset.k === k));
    err.textContent = '';
  };
  [['ssh', '🔌 Over SSH'], ['local', '🖥 This computer (HaRM server)'], ['manual', '📋 Run it yourself']]
    .forEach(([k, l]) => tabs.append(h('button', { type: 'button', class: 'chip', 'data-k': k, onclick: () => showPane(k) }, l)));
  const step1 = h('div', { class: 'import-steps' }, tabs, sshBox, localBox, manual, err, preview);
  const m = modal(`Import specs: ${dev.name}`, step1, { wide: true });
  showPane('ssh');

  GET(`/devices/${dev.id}/collect-targets`).then(t => {
    if (!t.ssh) return fillEl(sshBox, h('div', { class: 'notice' }, 'The HaRM server has no ssh client. Install the openssh-client package, or use “Run it yourself”.'));
    const host = h('input', { value: t.hosts[0] || '', placeholder: '192.168.1.50 or hostname', class: 'mono', list: 'collect-hosts' });
    const hostList = h('datalist', { id: 'collect-hosts' }, t.hosts.map(x => h('option', { value: x })));
    const port = h('input', { type: 'number', value: 22, min: 1, max: 65535, class: 'port-in' });
    const cred = h('select', null,
      t.credentials.map(c => h('option', { value: c.id }, `${c.label}${c.username ? ` (${c.username})` : ''}${c.has_password ? '' : ' · no password saved'}`)),
      h('option', { value: '' }, 'Other: type a username…'));
    const user = h('input', { placeholder: 'root', autocomplete: 'off' });
    const pass = h('input', { type: 'password', placeholder: 'Password (not saved). Leave blank for SSH keys', autocomplete: 'new-password' });
    const other = h('div', { class: 'grid two' }, user, pass);
    const sudo = h('input', { type: 'checkbox', checked: true });
    const os = h('select', null, [['auto', 'Detect automatically'], ['unix', 'Linux / macOS'], ['windows', 'Windows (OpenSSH)']].map(([v, l]) => h('option', { value: v }, l)));
    if (t.is_windows) os.value = 'windows';
    const status = h('div', { class: 'muted small' });
    const syncOther = () => { other.hidden = !!cred.value; };
    cred.addEventListener('change', syncOther); syncOther();
    const go = async (trust = false) => {
      goBtn.disabled = true; err.textContent = '';
      const who = cred.value ? (t.credentials.find(c => String(c.id) === cred.value)?.username || '?') : user.value;
      fillEl(status, `Connecting to ${who}@${host.value} and reading specs… (up to a minute)`);
      try {
        const r = await api('POST', `/devices/${dev.id}/collect`, {
          mode: 'ssh', host: host.value.trim(), port: +port.value || 22, credential_id: cred.value || null,
          username: cred.value ? null : user.value.trim(), password: cred.value ? null : pass.value,
          sudo: sudo.checked, os: os.value, trust_new_key: trust,
        });
        fillEl(status, '✓ Read. Check the list below, then add what you want.');
        await parse(r.output);
      } catch (x) {
        fillEl(status);
        err.textContent = x.message;
        if (/host key changed/i.test(x.message)) {
          err.append(' ', small('I reinstalled it: trust the new key and retry', () => go(true), 'primary'));
        }
      }
      goBtn.disabled = false;
    };
    const goBtn = btn('Connect & read specs', () => go(), 'primary');
    fillEl(sshBox,
      h('p', null, 'HaRM connects to ', h('b', null, dev.name), ' over SSH, runs the same read-only collector, and shows what it found. Nothing is changed on that machine.'),
      h('div', { class: 'grid two' },
        h('label', { class: 'disc-field' }, h('span', null, 'Address'), h('div', { class: 'inline' }, host, port), hostList),
        h('label', { class: 'disc-field' }, h('span', null, 'Login'), cred)),
      other,
      h('div', { class: 'grid two' },
        h('label', { class: 'check inline-check' }, sudo, 'Use sudo (adds serial number and memory sticks on Linux)'),
        h('label', { class: 'disc-field' }, h('span', null, 'System'), os)),
      h('div', { class: 'actions' }, goBtn), status,
      h('p', { class: 'muted small' }, 'The saved password is used on the HaRM server and never sent to this browser. The machine’s SSH host key is remembered the first time, and HaRM refuses to connect if it changes. SSH keys of the account running HaRM also work: pick “Other”, enter the username, and leave the password blank.'));
  }).catch(x => fillEl(sshBox, h('div', { class: 'form-error' }, x.message)));

  const parse = async (text = textarea.value) => {
    err.textContent = '';
    let r;
    try { r = await api('POST', '/specs/parse', { text }); }
    catch (e) { err.textContent = e.message; return; }
    showPreview(r);
  };

  const showPreview = r => {
    const fieldLabels = { hostname: 'Hostname', os: 'OS', manufacturer: 'Manufacturer', model: 'Model', serial: 'Serial / service tag', cpu: 'CPU', ram: 'RAM' };
    const rows = [];
    const devChecks = {};
    for (const [k, label] of Object.entries(fieldLabels)) {
      const nv = r.device[k];
      if (!nv) continue;
      const cur = dev[k];
      const same = cur === nv;
      const cb = h('input', { type: 'checkbox', checked: !cur });
      devChecks[k] = [cb, nv];
      rows.push(h('tr', { class: same ? 'muted' : '' }, h('td', null, same ? '✓' : cb), h('td', null, label), h('td', { class: 'muted' }, cur || 'None'),
        h('td', null, same ? 'already set' : h('b', null, nv))));
    }
    const haveSerials = new Set(d.components.map(c => (c.serial || '').toUpperCase()).filter(Boolean));
    const haveMacs = new Set(d.interfaces.map(i => (i.mac || '').toUpperCase()).filter(Boolean));
    const partChecks = [];
    const partRow = (p, extraNote) => {
      const dup = p.serial ? haveSerials.has(p.serial.toUpperCase())
        : d.components.some(c => c.category === p.category && (c.model || '').toLowerCase() === (p.model || '').toLowerCase());
      const cb = h('input', { type: 'checkbox', checked: !dup && !p.integrated });
      partChecks.push([cb, p]);
      return h('tr', null, h('td', null, cb),
        h('td', null, p.category), h('td', null, h('b', null, [p.manufacturer, p.model].filter(Boolean).join(' ') || 'None')),
        h('td', null, [p.capacity, p.interface, p.quantity > 1 ? `×${p.quantity}` : null].filter(Boolean).join(' · ')),
        h('td', { class: 'mono small' }, p.serial || ''),
        h('td', { class: 'muted small' }, dup ? 'already recorded' : (p.integrated ? 'built-in graphics' : p.library_match ? '✓ found in parts library' : extraNote || '')));
    };
    const ifChecks = [];
    const nicRows = r.nics.map(n => {
      const dup = haveMacs.has(n.mac.toUpperCase());
      const cb = h('input', { type: 'checkbox', checked: !dup });
      ifChecks.push([cb, n]);
      return h('tr', null, h('td', null, cb), h('td', null, n.name), h('td', null, n.kind),
        h('td', { class: 'mono' }, [n.ip ? n.ip + (n.subnet || '') : '', n.ipv6].filter(Boolean).join(' · ')),
        h('td', { class: 'mono small' }, n.mac), h('td', { class: 'muted small' }, dup ? 'already recorded' : (n.speed || '')));
    });
    const parts = [...(r.cpus || []), ...r.memory, ...r.disks, ...r.gpus];
    const totalLine = r.device.storage_total ? h('p', { class: 'muted small' }, `Drives found: ${r.disks.length} (${r.device.storage_total} total).`) : null;
    const apply = h('button', { type: 'button', class: 'primary' }, 'Add the ticked items');
    apply.addEventListener('click', async () => {
      apply.disabled = true;
      let nDev = 0, nParts = 0, nIf = 0;
      try {
        const patch = {};
        for (const [k, [cb, v]] of Object.entries(devChecks)) if (cb.checked) { patch[k] = v; nDev++; }
        if (Object.keys(patch).length) await api('PUT', `/devices/${dev.id}`, patch);
        for (const [cb, p] of partChecks) {
          if (!cb.checked) continue;
          const body = { ...p, device_id: dev.id, status: 'Installed' };
          delete body.integrated; delete body.library_match; delete body.custom_specs;
          if (p.custom_specs?.cores) {  // CPU not in the library: save its specs so cores/threads show
            const part = await api('POST', '/catalog', { category: 'cpu', name: nz(p.manufacturer, p.model), manufacturer: p.manufacturer, specs: p.custom_specs });
            body.catalog_id = part.id;
          }
          await api('POST', '/components', body);
          nParts++;
        }
        for (const [cb, n] of ifChecks) {
          if (!cb.checked) continue;
          await api('POST', '/interfaces', { ...n, device_id: dev.id });
          nIf++;
        }
        await loadLookups();
        m.close(true);
        toast(`Imported: ${nDev} field${nDev === 1 ? '' : 's'}, ${nParts} part${nParts === 1 ? '' : 's'}, ${nIf} interface${nIf === 1 ? '' : 's'}`);
        after();
      } catch (e) { toast(e.message, 'bad'); apply.disabled = false; }
    });
    fillEl(preview,
      h('h3', { class: 'import-h' }, `3. Choose what to add (found on a ${r.platform} machine)`),
      rows.length ? [h('h4', null, 'Device details'), h('p', { class: 'muted small' }, 'Fields that already have a different value are unticked; tick them to overwrite.'),
        h('div', { class: 'table-wrap' }, h('table', { class: 'import-table' }, h('tbody', null, rows)))] : null,
      parts.length ? [h('h4', null, 'Parts inside it (CPU, memory, drives, graphics)'), totalLine,
        h('div', { class: 'table-wrap' }, h('table', { class: 'import-table' }, h('tbody', null, parts.map(p => partRow(p)))))] : null,
      r.memory.length === 0 && r.platform === 'linux' ? h('p', { class: 'muted small' }, 'No memory stick details. Run the Linux script with sudo to include them.') : null,
      nicRows.length ? [h('h4', null, 'Network interfaces'), h('div', { class: 'table-wrap' }, h('table', { class: 'import-table' }, h('tbody', null, nicRows)))] : null,
      h('div', { class: 'actions' }, apply));
    preview.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
}

// ---------------------------------------------------------------- export / share / print

const EXPORT_SECTIONS = [
  ['basics', 'Basics (type, model, status)', true], ['serial', 'Serial / service tag', true],
  ['location', 'Location & rack position', true], ['hardware', 'CPU, RAM, PSU, OS', true],
  ['storage', 'Storage & drives', true], ['parts', 'Other installed parts', true],
  ['network', 'Network (IPs, MACs, VLANs)', true], ['services', 'Services', true],
  ['slots', 'Slots & bays', false], ['connections', 'Cabling', false],
  ['logins', 'Login names (never passwords)', false], ['purchase', 'Purchase & warranty', false], ['notes', 'Notes', true],
];

function exportMarkdown(bundle, sec, opts = {}) {
  const L = [];
  const row = (k, v) => { if (v != null && v !== '') L.push(`- **${k}:** ${v}`); };
  L.push(`# ${opts.title || 'Hardware inventory'}`, '', `_${bundle.length} device${bundle.length === 1 ? '' : 's'} · exported ${new Date().toLocaleString()} from Zom's HaRM_`, '');
  for (const d of bundle) {
    const v = d.device;
    L.push(`## ${v.name}`, '');
    if (sec.basics) { row('Type', v.device_type); row('Make / model', nz(v.manufacturer, v.model)); row('Status', `${v.status}${v.connected ? ', hooked up' : ', not hooked up'}`); }
    if (sec.serial) row('Serial / service tag', v.serial);
    if (sec.location) {
      row('Location', v.location_path);
      row('Rack / holder', v.rack_name ? `${v.rack_name}${v.rack_u ? ` U${v.rack_u}${v.u_height > 1 ? '-' + (v.rack_u + v.u_height - 1) : ''} (${v.rack_face})` : ''}` : null);
      row('Spot', v.position);
    }
    if (sec.hardware) { row('Hostname', v.hostname); row('OS', v.os); row('CPU', v.cpu); row('RAM', v.ram); row('PSU', v.psu); row('Management URL', v.mgmt_url); }
    if (sec.purchase) { row('Purchased', nz(v.purchase_date, v.vendor ? `from ${v.vendor}` : '')); row('Price', v.purchase_price != null ? money(v.purchase_price) : null); row('Warranty until', v.warranty_until); }
    if (sec.storage && d.storage.drives) {
      L.push('', `**Storage:** ${d.storage.total} raw (${d.storage.drives} drives)`);
      for (const g of d.storage.groups) L.push(`- ${g.count} × ${g.capacity} ${g.category}`);
    }
    const storageCats = /^(hdd|ssd|nvme ssd|usb \/ flash)$/i;
    const parts = d.components.filter(c => sec.parts && !(sec.storage && storageCats.test(c.category)));
    if (parts.length) {
      L.push('', '**Parts:**');
      for (const c of parts) L.push(`- ${c.quantity > 1 ? c.quantity + ' × ' : ''}${[c.category, c.manufacturer, c.model, c.capacity, c.interface].filter(Boolean).join(' · ')}${sec.serial && c.serial ? ` (S/N ${c.serial})` : ''}`);
    }
    if (sec.network && d.interfaces.length) {
      L.push('', '**Network:**', '', '| Interface | Network | IP | MAC | VLAN | Speed |', '|---|---|---|---|---|---|');
      for (const i of d.interfaces) L.push(`| ${i.name || ''} | ${i.network_name || ''} | ${i.ip ? i.ip + (i.subnet && String(i.subnet).startsWith('/') ? i.subnet : '') : ''} | ${i.mac || ''} | ${i.port_mode && /trunk/i.test(i.port_mode) ? `trunk ${i.native_vlan || ''}/${i.tagged_vlans || ''}` : (i.vlan || '')} | ${i.speed || ''} |`);
    }
    if (sec.services && d.services.length) {
      L.push('', '**Services:**');
      for (const s of d.services) L.push(`- ${s.name}${s.port ? ` (${nz(s.protocol, s.port)})` : ''}${s.url ? ` ${s.url}` : ''}${s.version ? ` v${s.version}` : ''}`);
    }
    if (sec.slots && d.slots.length) {
      L.push('', '**Slots & bays:**');
      for (const s of d.slots) L.push(`- ${s.interface}${s.form_factor ? ' ' + s.form_factor : ''}: ${s.used}/${s.total} used${s.notes ? ` (${s.notes})` : ''}`);
    }
    if (sec.connections && d.connections.length) {
      L.push('', '**Cabling:**');
      for (const c of d.connections) L.push(`- ${c.a_device_name}:${c.a_port || '?'} → ${c.b_device_name ? `${c.b_device_name}:${c.b_port || '?'}` : c.b_endpoint || '?'}${c.medium ? ` (${c.medium})` : ''}`);
    }
    if (sec.logins && d.credentials.length) {
      L.push('', '**Logins (names only):**');
      for (const c of d.credentials) L.push(`- ${c.label}${c.username ? `: ${c.username}` : ''}${c.url ? ` @ ${c.url}` : ''}`);
    }
    if (sec.notes && v.notes) L.push('', '**Notes:**', '', v.notes);
    if (sec.notes && d.notes?.length) {
      const open = d.notes.filter(n => (n.kind === 'task' || n.kind === 'issue') && !n.done);
      const log = d.notes.filter(n => !open.includes(n)).slice(0, 10);
      if (open.length) { L.push('', '**Open tasks / issues:**'); for (const n of open) L.push(`- [ ] ${n.kind === 'issue' ? '⚠ ' : ''}${n.body}`); }
      if (log.length) { L.push('', '**Notes & history:**'); for (const n of log) L.push(`- ${n.created_at.slice(0, 10)} (${n.kind}${n.done ? ', done' : ''}): ${n.body.replace(/\n/g, ' ')}`); }
    }
    L.push('');
  }
  return L.join('\n');
}

function exportCSV(bundle, sec) {
  const cols = [['name', 'Name'], ['device_type', 'Type'], ['manufacturer', 'Manufacturer'], ['model', 'Model'], ['status', 'Status']];
  if (sec.serial) cols.push(['serial', 'Serial / service tag']);
  if (sec.location) cols.push(['location_path', 'Location'], ['rack_name', 'Rack'], ['rack_u', 'U'], ['position', 'Spot']);
  if (sec.hardware) cols.push(['hostname', 'Hostname'], ['os', 'OS'], ['cpu', 'CPU'], ['ram', 'RAM'], ['psu', 'PSU']);
  if (sec.purchase) cols.push(['purchase_date', 'Purchased'], ['purchase_price', 'Price'], ['warranty_until', 'Warranty']);
  const q = v => { let x = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(x)) x = "'" + x; return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
  const head = [...cols.map(c => c[1]), ...(sec.storage ? ['Storage (raw)', 'Drives'] : []), ...(sec.network ? ['IPs', 'MACs'] : [])];
  const lines = [head.map(q).join(',')];
  for (const d of bundle) {
    const v = d.device;
    lines.push([...cols.map(c => q(v[c[0]])),
      ...(sec.storage ? [q(d.storage.total), q(d.storage.groups.map(g => `${g.count}x ${g.capacity}`).join('; '))] : []),
      ...(sec.network ? [q(d.interfaces.map(i => i.ip).filter(Boolean).join('; ')), q(d.interfaces.map(i => i.mac).filter(Boolean).join('; '))] : [])].join(','));
  }
  return lines.join('\n');
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* Spec sheet / sell sheet, rendered for the browser's Print → Save as PDF. */
function printSheet(bundle, sec, o) {
  const root = document.getElementById('print-root') || document.body.appendChild(h('div', { id: 'print-root' }));
  const item = (k, v) => (v == null || v === '') ? null : h('div', { class: 'ps-row' }, h('span', { class: 'ps-k' }, k), h('span', { class: 'ps-v' }, v));
  const sell = o.mode === 'sell';
  root.replaceChildren(h('div', { class: 'ps' + (sell ? ' sell' : '') },
    h('header', { class: 'ps-head' },
      h('div', null, h('h1', null, o.title || (sell ? 'Hardware for sale' : 'Hardware spec sheet')),
        o.subtitle ? h('p', null, o.subtitle) : null),
      h('div', { class: 'ps-meta' }, new Date().toLocaleDateString(), h('br'), `${bundle.length} item${bundle.length === 1 ? '' : 's'}`)),
    bundle.map(d => {
      const v = d.device;
      const price = o.prices?.[v.id];
      const drives = d.storage.drives ? `${d.storage.total} raw · ${d.storage.groups.map(g => `${g.count}× ${g.capacity} ${g.category}`).join(', ')}` : (v.storage || null);
      const nics = d.interfaces.filter(i => i.speed || i.kind).map(i => [i.kind, i.speed].filter(Boolean).join(' ')).join(', ');
      return h('section', { class: 'ps-item' },
        h('div', { class: 'ps-item-head' },
          h('div', null, h('h2', null, sell && v.model ? nz(v.manufacturer, v.model) : v.name),
            h('div', { class: 'ps-sub' }, sell ? v.device_type : [v.device_type, nz(v.manufacturer, v.model)].filter(Boolean).join(' · '))),
          price ? h('div', { class: 'ps-price' }, price) : null),
        h('div', { class: 'ps-grid' },
          sec.basics && !sell ? item('Status', v.status) : null,
          sec.serial ? item('Serial / service tag', v.serial) : null,
          sec.location && !sell ? item('Location', [v.location_path, v.rack_name ? `${v.rack_name}${v.rack_u ? ' U' + v.rack_u : ''}` : null].filter(Boolean).join(' · ')) : null,
          sec.hardware ? item('CPU', v.cpu) : null, sec.hardware ? item('Memory', v.ram) : null,
          sec.storage ? item('Storage', drives) : null,
          sec.hardware ? item('Power supply', v.psu) : null,
          sec.hardware && !sell ? item('OS', v.os) : null,
          sec.network && sell ? item('Networking', nics) : null,
          sec.hardware && !sell ? item('Hostname', v.hostname) : null,
          sec.purchase && !sell ? item('Warranty until', v.warranty_until) : null,
          sell && o.condition ? item('Condition', o.condition) : null),
        sec.parts && d.components.length ? h('div', { class: 'ps-list' }, h('h3', null, 'Installed parts'),
          h('ul', null, d.components.map(c => h('li', null, `${c.quantity > 1 ? c.quantity + ' × ' : ''}${[c.manufacturer, c.model, c.capacity, c.interface].filter(Boolean).join(' · ') || c.category}`)))) : null,
        sec.network && !sell && d.interfaces.length ? h('div', { class: 'ps-list' }, h('h3', null, 'Network'),
          h('table', null, h('tbody', null, d.interfaces.map(i => h('tr', null, h('td', null, i.name || ''), h('td', null, i.ip || ''), h('td', null, i.mac || ''), h('td', null, i.vlan || i.native_vlan || ''), h('td', null, i.speed || '')))))) : null,
        sec.services && !sell && d.services.length ? h('div', { class: 'ps-list' }, h('h3', null, 'Services'),
          h('ul', null, d.services.map(s => h('li', null, `${s.name}${s.port ? ` (${s.port})` : ''}${s.url ? ` · ${s.url}` : ''}`)))) : null,
        sec.notes && !sell && d.notes?.some(n => n.kind === 'note') ? h('div', { class: 'ps-notes' }, d.notes.filter(n => n.kind === 'note').slice(0, 3).map(n => n.body).join('\n\n')) : null);
    }),
    o.footer ? h('footer', { class: 'ps-foot' }, o.footer) : null));
  document.body.classList.add('printing');
  const done = () => { document.body.classList.remove('printing'); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  setTimeout(() => { window.print(); setTimeout(done, 1500); }, 50);
}

async function viewExport(q) {
  const devices = await GET('/devices');
  const pre = new Set((q.get('ids') || '').split(',').filter(Boolean).map(Number));
  const F = S.filters.export = S.filters.export || {};
  const picked = new Set(pre.size ? pre : (F.picked || []));
  const secState = F.sec || Object.fromEntries(EXPORT_SECTIONS.map(([k, , on]) => [k, on]));
  F.sec = secState;
  const listBox = h('div', { class: 'export-list' });
  const countEl = h('span', { class: 'muted' });
  const filters = { loc: '', rack: '', type: '', status: '' };
  const matches = d => (!filters.loc || locDescendants(filters.loc).has(d.location_id)) && (!filters.rack || String(d.rack_id) === filters.rack)
    && (!filters.type || d.device_type === filters.type) && (!filters.status || d.status === filters.status);
  const drawList = () => {
    const vis = devices.filter(matches);
    listBox.replaceChildren(...vis.map(d => {
      const cb = h('input', { type: 'checkbox', checked: picked.has(d.id), onchange: e => { e.target.checked ? picked.add(d.id) : picked.delete(d.id); F.picked = [...picked]; countEl.textContent = `${picked.size} selected`; } });
      return h('label', { class: 'check export-dev' }, cb, h('span', null, h('b', null, d.name), h('span', { class: 'muted small' }, ' ' + [d.device_type, d.rack_name || d.location_name].filter(Boolean).join(' · '))));
    }));
    countEl.textContent = `${picked.size} selected`;
  };
  const sel = (label, key, list) => h('select', { 'aria-label': label, onchange: e => { filters[key] = e.target.value; drawList(); } },
    h('option', { value: '' }, label), list.map(o => h('option', { value: o.value ?? o }, o.label ?? o)));
  const selectVisible = on => { for (const d of devices.filter(matches)) on ? picked.add(d.id) : picked.delete(d.id); F.picked = [...picked]; drawList(); };

  const secBoxes = h('div', { class: 'export-secs' }, EXPORT_SECTIONS.map(([k, label]) =>
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: secState[k], onchange: e => { secState[k] = e.target.checked; } }), h('span', null, label))));

  const titleIn = h('input', { placeholder: 'Title (optional)', value: F.title || '', oninput: e => { F.title = e.target.value; } });
  const getBundle = async () => {
    if (!picked.size) { toast('Select at least one device', 'bad'); return null; }
    return GET('/export/bundle?ids=' + [...picked].join(','));
  };
  const out = h('pre', { class: 'code export-out', hidden: true });
  const asMarkdown = async (then) => {
    const b = await getBundle(); if (!b) return;
    const md = exportMarkdown(b, secState, { title: F.title });
    out.textContent = md; out.hidden = false;
    then(md, b);
  };
  const sellBtn = async () => {
    const b = await getBundle(); if (!b) return;
    const priceFields = b.map(d => ({ k: `p_${d.device.id}`, label: `Asking price: ${d.device.name}`, ph: '$250 or OBO' }));
    formDialog({
      title: 'Sell sheet',
      fields: [
        { k: 'title', label: 'Title', default: F.title || 'Hardware for sale', wide: true },
        { k: 'subtitle', label: 'Subtitle', ph: 'Local pickup, tested and working', wide: true },
        { k: 'condition', label: 'Condition', ph: 'Used, fully working', chips: ['Used, fully working', 'Refurbished', 'For parts / not working'], wide: true },
        ...priceFields,
        { k: 'footer', label: 'Contact line', ph: 'Contact: name, phone or email', wide: true },
      ],
      saveLabel: 'Create PDF',
      submit: async v => v,
      onDone: v => printSheet(b, { ...secState, location: false, basics: false, logins: false, purchase: false, slots: false, connections: false },
        { mode: 'sell', title: v.title, subtitle: v.subtitle, condition: v.condition, footer: v.footer,
          prices: Object.fromEntries(b.map(d => [d.device.id, v[`p_${d.device.id}`]])) }),
    });
  };

  render(
    pageHead('Export & share', 'Pick devices and what to include. Copy it for a person or an AI assistant, download it, or make a PDF.', helpLink('export')),
    h('div', { class: 'grid two' },
      card('1. Devices', h('div', null,
        h('div', { class: 'toolbar' },
          sel('All locations', 'loc', S.lk.locations.map(l => ({ value: String(l.id), label: locPath(l.id) }))),
          sel('All holders', 'rack', S.lk.racks.map(r => ({ value: String(r.id), label: r.name }))),
          sel('All types', 'type', [...new Set(devices.map(d => d.device_type).filter(Boolean))].sort()),
          sel('All statuses', 'status', S.enums.device_statuses)),
        h('div', { class: 'inline' }, small('Select shown', () => selectVisible(true)), small('Clear shown', () => selectVisible(false)), countEl),
        listBox)),
      card('2. Include', h('div', null, secBoxes, titleIn,
        h('p', { class: 'muted small' }, 'Passwords and other secrets are never exported.')))),
    card('3. Get it', h('div', null,
      h('div', { class: 'export-actions' },
        btn('📋 Copy for AI / chat (Markdown)', () => asMarkdown(md => copy(md, 'Markdown')), 'primary'),
        btn('⬇ Markdown (.md)', () => asMarkdown(md => download('harm-export.md', md, 'text/markdown'))),
        btn('⬇ Spreadsheet (.csv)', async () => { const b = await getBundle(); if (b) download('harm-export.csv', exportCSV(b, secState), 'text/csv'); }),
        btn('⬇ JSON', async () => { const b = await getBundle(); if (b) download('harm-export.json', JSON.stringify(b, null, 2), 'application/json'); }),
        btn('🖨 Spec sheet (PDF)', async () => { const b = await getBundle(); if (b) printSheet(b, secState, { title: F.title }); }),
        btn('🏷 Sell sheet (PDF)', sellBtn),
        btn('🔳 QR labels', () => { if (!picked.size) return toast('Select at least one device', 'bad'); printLabels([...picked]); })),
      h('p', { class: 'muted small' }, 'PDFs open your browser’s print dialog: choose “Save as PDF” (on a phone: Share > Print, then pinch out or Save).'),
      out)));
  drawList();
}

// ---------------------------------------------------------------- journal: notes, tasks, actions, issues

const NOTE_KINDS = { note: ['📝', 'Note', 'muted'], task: ['☐', 'Task', 'info'], action: ['🔧', 'Did', 'ok'], issue: ['⚠', 'Issue', 'warn'] };

function timeAgo(ts) {
  if (!ts) return '';
  const d = new Date(String(ts).replace(' ', 'T') + 'Z');
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return d.toLocaleDateString();
}

function noteItem(n, after, { showTarget = false } = {}) {
  const [ico, label, cls] = NOTE_KINDS[n.kind] || NOTE_KINDS.note;
  const actionable = n.kind === 'task' || n.kind === 'issue';
  const set = async patch => { try { await api('PUT', `/notes/${n.id}`, patch); after(); } catch (e) { toast(e.message, 'bad'); } };
  const check = actionable
    ? h('input', { type: 'checkbox', class: 'note-check', checked: !!n.done, title: n.done ? 'Mark as not done' : 'Mark as done', onchange: e => set({ done: e.target.checked }) })
    : h('span', { class: 'note-ico', 'aria-hidden': 'true' }, ico);
  const bodyEl = h('div', { class: 'note-body' }, n.body);
  const edit = () => {
    const t = h('textarea', { rows: 3, value: n.body });
    bodyEl.replaceChildren(t, h('div', { class: 'inline' }, small('Save', () => t.value.trim() && set({ body: t.value }), 'primary'), small('Cancel', after)));
    t.focus();
  };
  const links = { devices: '#/devices/', racks: '#/racks/', locations: '#/locations/', networks: '#/networks/', builds: '#/builds/', components: '#/components?id=' };
  return h('li', { class: `note k-${n.kind}${n.done ? ' done' : ''}${n.pinned ? ' pinned' : ''}` }, check,
    h('div', { class: 'note-main' },
      showTarget && n.target_name ? h('div', { class: 'note-target' }, link(links[n.entity] + n.entity_id, n.target_name)) : null,
      bodyEl,
      h('div', { class: 'note-meta' }, h('span', { class: `badge ${cls}` }, label), ` ${timeAgo(n.created_at)}`,
        n.done && n.done_at ? ` · done ${timeAgo(n.done_at)}` : '', n.pinned ? ' · 📌' : '')),
    // The checkbox marks it done; everything else is in a small menu.
    h('div', { class: 'note-actions' }, menuButton('⋯', [
      [n.pinned ? '📌 Unpin' : '📌 Pin to top', () => set({ pinned: !n.pinned })],
      ['✎ Edit…', edit],
      ['🗑 Delete', async () => { if (await confirmBox('Delete this entry?')) { await api('DELETE', `/notes/${n.id}`); after(); } }, 'danger-item'],
    ], 'sm ghost')));
}

/* Quick journal for any item: type and press Enter. No edit dialog needed. */
function journalCard(entity, entityId, notes, after, title = 'Notes & tasks') {
  let kind = S.lastNoteKind || 'note';
  const ta = h('textarea', { rows: 2, class: 'note-input', placeholder: 'What did you do, notice, or need to do? Enter to add · Shift+Enter for a new line' });
  const kinds = h('div', { class: 'kind-chips' });
  const drawKinds = () => kinds.replaceChildren(...Object.entries(NOTE_KINDS).map(([k, [ico, label]]) =>
    h('button', { type: 'button', class: 'chip' + (k === kind ? ' on' : ''), onclick: () => { kind = k; S.lastNoteKind = k; drawKinds(); ta.focus(); } }, `${ico} ${label}`)));
  drawKinds();
  const addBtn = h('button', { type: 'button', class: 'primary' }, 'Add');
  const add = async () => {
    const body = ta.value.trim();
    if (!body) return ta.focus();
    addBtn.disabled = true;
    try { await api('POST', '/notes', { entity, entity_id: entityId, kind, body }); ta.value = ''; await after(); }
    catch (e) { toast(e.message, 'bad'); }
    addBtn.disabled = false;
  };
  addBtn.addEventListener('click', add);
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); add(); } });
  const open = notes.filter(n => (n.kind === 'task' || n.kind === 'issue') && !n.done);
  const rest = notes.filter(n => !open.includes(n));
  const showAll = S.showAllNotes === `${entity}:${entityId}`;
  return h('section', { class: 'card journal' },
    h('div', { class: 'card-head' }, h('h3', null, title + (open.length ? ` · ${open.length} open` : ''))),
    h('div', { class: 'note-add' }, ta, h('div', { class: 'note-add-row' }, kinds, addBtn)),
    open.length ? h('ul', { class: 'plain notes-list open' }, open.map(n => noteItem(n, after))) : null,
    rest.length ? h('ul', { class: 'plain notes-list' }, rest.slice(0, showAll ? 999 : 6).map(n => noteItem(n, after)))
      : (open.length ? null : h('div', { class: 'empty' }, 'Nothing yet. Jot down what you did, what’s broken, or what to do next.')),
    rest.length > 6 && !showAll ? small(`Show all ${rest.length}`, () => { S.showAllNotes = `${entity}:${entityId}`; after(); }) : null);
}

async function viewTasks() {
  const [open, done] = await Promise.all([GET('/notes?done=0'), GET('/notes?done=1')]);
  const todo = open.filter(n => n.kind === 'task' || n.kind === 'issue');
  const recent = done.filter(n => n.kind === 'task' || n.kind === 'issue').sort((a, b) => (b.done_at || '').localeCompare(a.done_at || '')).slice(0, 15);
  const groups = new Map();
  for (const n of todo) {
    const k = `${n.entity}:${n.entity_id}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(n);
  }
  const back = () => viewTasks();
  const addFor = h('select', { 'aria-label': 'Device' }, h('option', { value: '' }, 'Device…'), S.lk.devices.map(d => h('option', { value: d.id }, d.name)));
  const text = h('input', { placeholder: 'New task, e.g. “Replace failed drive in bay 3”' });
  const addTask = async () => {
    if (!addFor.value || !text.value.trim()) return toast('Pick a device and type the task', 'bad');
    await api('POST', '/notes', { entity: 'devices', entity_id: +addFor.value, kind: 'task', body: text.value.trim() });
    text.value = '';
    back();
  };
  text.addEventListener('keydown', e => { if (e.key === 'Enter') addTask(); });
  render(
    pageHead('Tasks & issues', `${todo.length} open across ${groups.size} item${groups.size === 1 ? '' : 's'}`, helpLink('notes')),
    h('div', { class: 'card' }, h('div', { class: 'toolbar task-add' }, addFor, text, btn('+ Add task', addTask, 'primary'))),
    todo.length ? [...groups.values()].map(list => card(list[0].target_name || 'Item', h('ul', { class: 'plain notes-list open' }, list.map(n => noteItem(n, back, { showTarget: false }))),
      h('a', { class: 'button sm', href: ({ devices: '#/devices/', racks: '#/racks/', locations: '#/locations/', networks: '#/networks/', builds: '#/builds/' }[list[0].entity] || '#/components?id=') + list[0].entity_id }, 'Open')))
      : h('div', { class: 'card onboarding' }, h('h3', null, 'All clear 🎉'), h('p', null, 'Add tasks from any device page (Notes & tasks), or above.')),
    recent.length ? card('Recently done', h('ul', { class: 'plain notes-list' }, recent.map(n => noteItem(n, back, { showTarget: true })))) : null);
}

// ---------------------------------------------------------------- hardware cards: CPU, memory, drive bays

function slotGrid(sl, compsById, onEmpty, onFilled) {
  const first = sl.first_index || 0;
  return h('div', { class: 'bays' + (sl.drive_bay ? ' drive' : ' slot-grid') },
    sl.bays.map((cid, i) => {
      const n = first + i;
      const c = cid && compsById[cid];
      if (!c) return h('button', { type: 'button', class: 'bay empty', title: `${sl.drive_bay ? 'Bay' : 'Slot'} ${n}: empty, tap to add`, onclick: () => onEmpty(n) },
        h('span', { class: 'bay-n' }, n), h('span', { class: 'bay-cap' }, '+'));
      const kind = /hdd/i.test(c.category) ? 'HDD' : /nvme/i.test(c.category) ? 'NVMe' : /ssd/i.test(c.category) ? 'SSD' : (c.interface || c.category || '').split(' ')[0];
      return h('button', {
        type: 'button', class: `bay filled st-${badgeClass(c.status)}`,
        title: [`${sl.drive_bay ? 'Bay' : 'Slot'} ${n}`, c.capacity, c.category, nz(c.manufacturer, c.model), c.serial ? `S/N ${c.serial}` : '', c.status !== 'Installed' ? c.status : ''].filter(Boolean).join(' · '),
        onclick: () => onFilled(c, n),
      }, h('span', { class: 'bay-n' }, n), h('span', { class: 'bay-cap' }, c.capacity || kind), h('span', { class: 'bay-type' }, kind));
    }),
    sl.overflow ? h('div', { class: 'bay-overflow warn-text small' }, `+${sl.overflow} more than this group has room for`) : null);
}

function partMenu(c, where, back, sl = null, n = null) {
  let m;
  // A bay showing one of "6 × 2 TB" acts on just that drive: split it off first.
  const one = async () => (c.quantity > 1 && sl) ? api('POST', `/components/${c.id}/split`, { slot_id: sl.id, bay: n }) : c;
  const act = fn => async () => { m.close(true); try { await fn(await one()); } catch (e) { toast(e.message, 'bad'); } };
  m = modal(`${where}: ${c.capacity || ''} ${c.category}`.trim(), h('div', null,
    kv([['Part', nz(c.manufacturer, c.model) || c.category], ['Size', c.capacity], ['Connection', c.interface], ['Form factor', c.form_factor],
      ['Serial', c.serial ? h('span', { class: 'mono' }, c.serial) : ''], ['Status', badge(c.status)], ['Health', c.health],
      ['Group', c.quantity > 1 ? `One of ${c.quantity} identical drives recorded together. Actions here apply to this ${sl?.drive_bay === false ? 'slot' : 'bay'} only.` : '']]),
    h('div', { class: 'actions wrap' },
      btn('Remove to spares', act(x => uninstallDialog(x, back))),
      c.status !== 'Faulty' ? btn('⚠ Mark failed', act(async x => {
        await api('PUT', `/components/${x.id}`, { status: 'Faulty' });
        await api('POST', '/notes', { entity: 'devices', entity_id: c.device_id, kind: 'issue', body: `${where}: ${c.capacity || ''} ${c.category} ${c.serial && c.quantity === 1 ? `(S/N ${c.serial}) ` : ''}marked failed. Replace it.`.replace(/\s+/g, ' ') });
        toast('Marked failed, and an issue was added to the device');
        back();
      }), 'ghost-danger') : btn('Mark OK again', act(async x => { await api('PUT', `/components/${x.id}`, { status: 'Installed' }); back(); })),
      btn(c.quantity > 1 ? 'Edit this drive' : 'Edit', act(x => editEntity('components', x, back)), 'primary'))));
}

function addToBay(dev, sl, n, back) {
  const accepts = splitTokens(sl.interface).filter(Boolean);
  const empty = sl.bays.filter(b => b == null).length;
  const isDrive = sl.drive_bay;
  const isMem = /ddr|dimm/i.test(sl.interface);
  const cat = isDrive ? 'HDD' : isMem ? 'RAM' : null;
  formDialog({
    title: `${isDrive ? 'Bay' : 'Slot'} ${n}${sl.label ? ` · ${sl.label}` : ''}: add ${isDrive ? 'a drive' : isMem ? 'memory' : 'a part'}`,
    fields: [
      { k: 'category', label: 'What is it?', required: true, default: cat, chips: isDrive ? ['HDD', 'SSD', 'NVMe SSD'] : isMem ? ['RAM'] : ['GPU', 'NIC', 'HBA / RAID Card', 'Other'] },
      { k: 'capacity', label: 'Size', required: isDrive || isMem, chips: v => PART_CHIPS[v.category]?.sizes || [] },
      { k: 'interface', label: 'Connection', default: accepts.length === 1 ? accepts[0] : (isMem ? sl.interface : null),
        chips: v => accepts.length > 1 ? accepts : (PART_CHIPS[v.category]?.iface || accepts) },
      { k: 'manufacturer', label: 'Manufacturer', chips: v => PART_CHIPS[v.category]?.makers || [] },
      { k: 'model', label: 'Model', scan: true },
      { k: 'serial', label: 'Serial number', scan: true, showIf: v => +v.quantity <= 1 },
      { k: 'quantity', label: 'How many identical ones', type: 'number', min: 1, default: 1, chips: empty > 1 ? ['1', String(empty)] : null,
        help: empty > 1 ? `${empty} empty in this group. More than 1 fills the empty ${isDrive ? 'bays' : 'slots'} in order.` : null },
    ],
    saveLabel: 'Add',
    submit: v => api('POST', '/components', {
      ...v, device_id: dev.id, status: 'Installed', slot_id: sl.id, form_factor: sl.form_factor || null,
      bay: +v.quantity > 1 ? null : n,
    }),
    onDone: () => { toast('Added'); back(); },
  });
}

function bayGroupsBody(dev, d, slots, back) {
  const compsById = Object.fromEntries(d.components.map(c => [c.id, c]));
  return slots.map(sl => {
    const st = sl.storage;
    const used = sl.bays.filter(Boolean).length;
    return h('div', { class: 'bay-group' },
      h('div', { class: 'bay-head' },
        h('div', null,
          h('b', null, sl.label || (sl.drive_bay ? 'Drive bays' : sl.interface)),
          h('span', { class: 'muted small' }, ' ' + [sl.form_factor, sl.drive_bay ? `accepts ${splitTokens(sl.interface).join(' & ')}` : (sl.label ? sl.interface : null), `${used}/${sl.total} used`].filter(Boolean).join(' · ')),
          sl.array_name ? h('div', null, h('span', { class: 'badge info' }, sl.array_name)) : null,
          sl.notes ? h('div', { class: 'muted small' }, sl.notes) : null),
        h('div', { class: 'row-actions' },
          sl.compatible.length && used < sl.total ? small(`${sl.compatible.length} spare${sl.compatible.length > 1 ? 's' : ''} fit`, () => sparesFor(sl, dev, back), 'info') : null,
          small('Edit', () => editEntity('device_slots', sl, back)),
          small('Delete', () => deleteEntity('device_slots', sl, back, 'Drives in it stay installed in the device.'), 'ghost-danger'))),
      slotGrid(sl, compsById, n => addToBay(dev, sl, n, back), (c, n) => partMenu(c, `${sl.label || 'Bay'} ${n}`, back, sl, n)),
      st && st.drives ? h('div', { class: 'bay-foot' }, h('b', null, st.total), h('span', { class: 'muted' }, ` raw · ${st.groups.map(g => `${g.count}× ${g.capacity}`).join(', ')}`), raidCalc(st.groups)) : null);
  });
}

function sparesFor(sl, dev, back) {
  const m = modal(`Spares that fit ${sl.label || sl.interface}`, table([
    { label: 'Part', get: c => nz(c.manufacturer, c.model) || c.category },
    { label: 'Size', get: c => c.capacity || '' },
    { label: 'Connection', get: c => nz(c.interface, c.form_factor) },
    { label: 'Qty', get: c => c.quantity },
    { label: 'Stored', get: c => [c.rack_name, c.position].filter(Boolean).join(' · ') || c.location_name || '' },
    { label: '', nosort: true, get: c => small('Install', () => { m.close(true); installDialog(c, dev.id, back); }, 'primary') },
  ], sl.compatible), { wide: true });
}

function cpuCard(dev, d, back) {
  const c = d.cpus;
  const sockets = d.slots.filter(s => /cpu|socket|lga|am\d|sp\d|c32|g34|str/i.test(`${s.interface} ${s.label || ''}`) && !/ddr|dimm|pcie|m\.2|sas|sata/i.test(s.interface));
  const sockTotal = sockets.reduce((a, s) => a + s.total, 0);
  const body = c.items.length ? h('div', null,
    h('div', { class: 'storage-total' }, h('b', null, `${c.cores || '?'} cores`), h('span', { class: 'muted' }, ` / ${c.threads || '?'} threads total${c.sockets > 1 ? ` across ${c.sockets} CPUs` : ''}`)),
    h('ul', { class: 'plain storage-groups' }, c.items.map(x => h('li', { class: 'cpu-line' },
      h('div', null, h('b', null, `${x.qty > 1 ? x.qty + ' × ' : ''}${x.name}`)),
      h('div', { class: 'muted small' }, [x.cores ? `${x.cores} cores / ${x.threads || x.cores} threads${x.qty > 1 ? ' each' : ''}` : 'core count unknown: edit it or pick it from the library',
        x.base_ghz ? `${x.base_ghz} GHz${x.boost_ghz ? ` (boost ${x.boost_ghz} GHz)` : ''}` : null, x.socket].filter(Boolean).join(' · ')),
      h('div', { class: 'row-actions' }, small('Edit', () => editEntity('components', d.components.find(k => k.id === x.id), back)),
        small('Remove', () => uninstallDialog(d.components.find(k => k.id === x.id), back)))))),
    sockTotal ? h('p', { class: (c.sockets > sockTotal ? 'bad-text' : 'muted') + ' small' }, `${c.sockets} of ${sockTotal} CPU socket${sockTotal > 1 ? 's' : ''} filled`) : null)
    : h('div', null, dev.cpu ? h('p', null, 'Noted: ', h('b', null, dev.cpu)) : null,
      h('p', { class: 'muted small' }, 'Add the CPU to see cores and threads. Pick it from the library (servers like Opteron and Xeon are included), or enter its specs.'));
  return card('Processors', body, small('+ Add CPU', () => pickCPU(dev, back)));
}

function pickCPU(dev, back) {
  let m;
  const howMany = async (fields) => {
    formDialog({
      title: 'How many of this CPU?',
      fields: [{ k: 'quantity', label: 'Number of CPUs (sockets filled)', type: 'number', min: 1, default: 1, chips: ['1', '2', '4'] }],
      saveLabel: 'Add',
      submit: v => api('POST', '/components', { ...fields, quantity: v.quantity || 1, device_id: dev.id, status: 'Installed' }),
      onDone: () => { toast('CPU added'); back(); },
    });
  };
  const manual = h('div', { class: 'cpu-manual' });
  const form = buildForm([
    { k: 'name', label: 'Model', required: true, ph: 'Opteron 4234, Xeon E5-2680 v4' },
    { k: 'manufacturer', label: 'Maker', chips: ['AMD', 'Intel'] },
    { k: 'cores', label: 'Cores per CPU', type: 'number', min: 1, required: true, chips: ['2', '4', '6', '8', '10', '12', '16'] },
    { k: 'threads', label: 'Threads per CPU', type: 'number', min: 1, help: 'Same as cores if it has no Hyper-Threading/SMT.' },
    { k: 'base_ghz', label: 'Clock (GHz)', type: 'number', step: 'any' },
    { k: 'socket', label: 'Socket', chips: ['C32', 'G34', 'LGA 1366', 'LGA 2011', 'LGA 2011-3', 'LGA 3647', 'SP3', 'AM4', 'AM5', 'LGA 1700'] },
    { k: 'quantity', label: 'How many CPUs', type: 'number', min: 1, default: 1, chips: ['1', '2', '4'] },
  ], {});
  const save = btn('Add CPU', async () => {
    const v = form.values();
    if (!v.name || !v.cores) return toast('Model and cores are needed', 'bad');
    try {
      const part = await api('POST', '/catalog', { category: 'cpu', name: v.name, manufacturer: v.manufacturer,
        specs: { cores: v.cores, threads: v.threads || v.cores, base_ghz: v.base_ghz, socket: v.socket } });
      await api('POST', '/components', { category: 'CPU', manufacturer: v.manufacturer, model: v.name.replace(new RegExp(`^${v.manufacturer || '#'}\\s*`, 'i'), ''),
        catalog_id: part.id, interface: v.socket, capacity: `${v.cores}C/${v.threads || v.cores}T`, quantity: v.quantity || 1, device_id: dev.id, status: 'Installed' });
      m.close(true); toast('CPU added (also saved to your custom parts)'); back();
    } catch (e) { toast(e.message, 'bad'); }
  }, 'primary');
  manual.append(form.el, h('div', { class: 'actions' }, save));
  m = modal(`Add a CPU to ${dev.name}`, h('div', null,
    h('p', { class: 'muted small' }, 'Search by model number (e.g. 4234, E5-2680, 7950X3D). Built-in entries cover common server CPUs.'),
    librarySearch({ category: 'cpu', q: (dev.cpu || '').match(/\b[A-Z]?\d{4}[A-Z0-9-]*\b/i)?.[0] || '', addLabel: 'Use',
      onAdd: async p => { const f = await GET(`/catalog/${p.id}/component-fields`); m.close(true); howMany(f); } }),
    h('details', { class: 'cpu-manual-wrap' }, h('summary', null, 'Not listed? Enter its specs'), manual)), { wide: true });
}

function memoryCard(dev, d, back) {
  const mem = d.memory;
  const memSlots = d.slots.filter(s => /ddr|dimm/i.test(s.interface));
  const compsById = Object.fromEntries(d.components.map(c => [c.id, c]));
  const body = h('div', null,
    mem.sticks ? [
      h('div', { class: 'storage-total' }, h('b', null, mem.total || '?'), h('span', { class: 'muted' }, ` across ${mem.sticks} stick${mem.sticks === 1 ? '' : 's'}`)),
      h('ul', { class: 'plain storage-groups' }, mem.groups.map(g => h('li', null, h('b', null, `${g.count} × ${g.capacity}`),
        ` ${[g.interface, g.speed].filter(Boolean).join(' · ')}`, g.gb ? h('span', { class: 'muted' }, ` = ${fmtGB(g.gb * g.count)}`) : null)))]
      : h('div', null, dev.ram ? h('p', null, 'Noted: ', h('b', null, dev.ram)) : null,
        h('p', { class: 'muted small' }, 'Add memory sticks (or use Import specs) to see the breakdown. Add memory slots to see which are free.')),
    memSlots.map(sl => h('div', { class: 'bay-group' },
      h('div', { class: 'bay-head' }, h('div', null, h('b', null, sl.label || 'Memory slots'), h('span', { class: 'muted small' }, ` ${sl.interface} · ${sl.bays.filter(Boolean).length}/${sl.total} used`)),
        h('div', { class: 'row-actions' }, small('Edit', () => editEntity('device_slots', sl, back)))),
      slotGrid(sl, compsById, n => addToBay(dev, sl, n, back), (c, n) => partMenu(c, `${sl.label || 'Slot'} ${n}`, back, sl, n)))));
  return card('Memory', body,
    small('+ Add memory', () => editEntity('components', { device_id: dev.id, status: 'Installed', category: 'RAM', quantity: 1 }, back)),
    memSlots.length ? null : small('+ Slots', () => editEntity('device_slots', { device_id: dev.id, total: 8, interface: 'DDR4 DIMM' }, back)));
}

function storageCard(dev, d, back) {
  const bays = d.slots.filter(s => s.drive_bay);
  const inBays = new Set(bays.flatMap(s => s.bays.filter(Boolean)));
  const loose = d.components.filter(c => STORAGE_CATS.test(c.category) && !inBays.has(c.id));
  return card('Storage', h('div', null,
    storageBody(d.storage, dev.storage, { raid: !bays.length }),
    bays.length ? bayGroupsBody(dev, d, bays, back)
      : d.storage.drives ? h('p', { class: 'muted small' }, 'Tip: add the drive bays (front/rear, how many, SAS/SATA, which RAID) to see each bay and what’s in it.') : null,
    bays.length && loose.length ? h('p', { class: 'muted small' }, `${loose.reduce((a, c) => a + c.quantity, 0)} drive(s) aren’t in any bay group: `,
      loose.map(c => small(`${c.quantity > 1 ? c.quantity + '× ' : ''}${c.capacity || c.category}`, () => partMenu(c, 'Drive', back)))) : null),
    small('+ Drive bays', () => editEntity('device_slots', { device_id: dev.id, total: 4, _kind: 'Drive bays', interface: 'SAS/SATA', form_factor: '3.5"' }, back)),
    small('+ Drives', () => editEntity('components', { device_id: dev.id, status: 'Installed', category: 'HDD', quantity: 1 }, back)));
}

// ---------------------------------------------------------------- QR labels

async function qrSvg(text, size = 160) {
  const Z = await loadZXing();
  const hints = new Map([[Z.EncodeHintType.MARGIN, 0]]);
  const svg = new Z.BrowserQRCodeSvgWriter().write(text, size, size, hints);
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);  // so it scales to the label size when printed
  return svg;
}

/* QR labels in the sizes of common label rolls, or a full sheet (ZomBeatz printing rules:
   QR on the left at least 15 mm wide, the name in bold, 1 or 2 lines of key facts). */
const LABEL_SIZES = [
  ['62x29', '62 × 29 mm roll (Brother DK-11209 and similar)', { w: 62, h: 29 }],
  ['2x1', '2 × 1 in roll (Dymo, Zebra and similar)', { w: 50.8, h: 25.4 }],
  ['1x1', '1 × 1 in roll (QR code and name only)', { w: 25.4, h: 25.4 }],
  ['sheet', 'Full sheet (A4 or Letter, 2 across)', null],
];
function printLabels(ids) {
  const pick = prefGet('harm-label-size') || '62x29';
  const radios = LABEL_SIZES.map(([k, label]) => h('label', { class: 'radio-row' },
    h('input', { type: 'radio', name: 'label-size', value: k, checked: k === pick }), ' ', label));
  const m = modal(ids.length > 1 ? `Print ${ids.length} labels` : 'Print a label', h('div', null,
    h('p', null, 'Pick the size of your labels. Each label is printed in light colors, with a QR code that opens the device in HaRM.'),
    h('div', { class: 'radio-list' }, radios),
    h('div', { class: 'actions' }, btn('Cancel', () => m.close(true)), btn('Print…', () => {
      const size = radios.map(r => r.querySelector('input')).find(i => i.checked)?.value || '62x29';
      prefSet('harm-label-size', size);
      m.close(true);
      doPrintLabels(ids, size).catch(e => toast(e.message, 'bad'));
    }, 'primary'))));
}
async function doPrintLabels(ids, size) {
  const bundle = await GET('/export/bundle?ids=' + ids.join(','));
  const root = document.getElementById('print-root') || document.body.appendChild(h('div', { id: 'print-root' }));
  const dims = LABEL_SIZES.find(x => x[0] === size)[2];
  const labels = [];
  for (const d of bundle) {
    const v = d.device;
    const ip = deviceMainIp(d);
    const qr = await qrSvg(`${location.origin}/#/devices/${v.id}`, 150);
    const facts = [nz(v.manufacturer, v.model), ip || (v.serial ? `S/N ${v.serial}` : '')].filter(Boolean).slice(0, 2);
    labels.push(h('div', { class: 'label' }, h('div', { class: 'label-qr' }, qr),
      h('div', { class: 'label-text' }, h('b', null, v.name), size === '1x1' ? null : facts.map(f => h('div', { class: /^[\d.:]+$|^S\/N/.test(f) ? 'mono' : '' }, f)))));
  }
  root.replaceChildren(h('div', { class: `labels labels-${size}` }, labels));
  // Roll labels print one per page at the roll's size; a sheet uses the normal page.
  const page = document.getElementById('label-page') || document.head.appendChild(h('style', { id: 'label-page' }));
  page.textContent = dims ? `@page { size: ${dims.w}mm ${dims.h}mm; margin: 0; }` : '';
  document.body.classList.add('printing');
  const done = () => { document.body.classList.remove('printing'); page.textContent = ''; window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  setTimeout(() => { window.print(); setTimeout(done, 1500); }, 100);
}
const deviceMainIp = d => (d.interfaces.find(i => i.is_primary && i.ip) || d.interfaces.find(i => i.ip) || {}).ip || '';

// ---------------------------------------------------------------- phone app (install) help

function phoneAppHelp() {
  const standalone = window.matchMedia('(display-mode: standalone)').matches;
  const secure = window.isSecureContext;
  const ca = S.caps.ca_cert;
  modal('Use HaRM as an app on your phone', h('div', { class: 'phone-help' },
    h('div', { class: 'notice' }, 'Not connecting, or a warning that won’t go away? ',
      h('a', { href: '#/help?s=trouble', onclick: () => document.querySelectorAll('.modal-back').forEach(m => m.remove()) }, 'Step-by-step troubleshooting for iPhone, iPad and Android')),
    standalone ? h('p', { class: 'ok-text' }, '✓ You’re already using HaRM as an installed app.') : null,
    phoneQrBlock(),
    h('p', null, 'Chrome only offers “Install app” for sites it fully trusts. HaRM uses its own HTTPS certificate, so your phone needs to trust it once:'),
    h('ol', null,
      h('li', null, 'On your phone, open this page and download the certificate: ',
        ca ? h('a', { class: 'button sm', href: '/harm-ca.crt', download: 'harm-ca.crt' }, '⬇ harm-ca.crt') : h('span', { class: 'warn-text' }, 'not created yet: run scripts/make-cert.sh on the server')),
      h('li', null, h('b', null, 'Android: '), 'Settings > Security & privacy > More security settings > Encryption & credentials > Install a certificate > ', h('b', null, 'CA certificate'), ' > Install anyway > pick harm-ca.crt. (Search Settings for “CA certificate” if the menus differ.)'),
      h('li', null, h('b', null, 'iPhone: '), 'open the file > Settings > Profile Downloaded > Install, then Settings > General > About > Certificate Trust Settings > turn on “Zom’s HaRM local CA”.'),
      h('li', null, 'Close Chrome completely, reopen ', h('code', null, location.origin), '. There should be no warning now.'),
      h('li', null, 'Chrome menu (⋮) > ', h('b', null, 'Install app'), ' (or “Add to Home screen”). On iPhone: Safari > Share > Add to Home Screen.')),
    h('p', null, h('button', { type: 'button', class: 'primary install-btn', hidden: !S.installPrompt, onclick: installApp }, '⤓ Install now')),
    h('p', { class: 'muted small' }, `This browser: ${secure ? 'secure connection ✓' : 'NOT trusted yet (step 2 not done)'} · ${standalone ? 'installed' : 'in a browser tab'}. Only install it on your own devices, and keep data/tls/harm-ca.key on the server private: whoever has that key could vouch for other sites to your phone. Long-press the app icon for shortcuts (Scan a part, Devices, Tasks).`)));
}

// ---------------------------------------------------------------- idle lock & boot

['mousemove', 'keydown', 'click', 'scroll', 'touchstart'].forEach(ev =>
  addEventListener(ev, () => { S.lastActivity = Date.now(); }, { passive: true }));

setInterval(async () => {
  if (!S.authed || !S.auth) return;
  const idleMs = S.auth.idle_minutes * 60000;
  const now = Date.now();
  if (now - S.lastActivity > idleMs) {
    try { await api('POST', '/auth/logout'); } catch { /* ignore */ }
    showAuth('Locked after inactivity.');
  } else if (now - S.lastActivity < 60000 && now - S.lastPing > 4 * 60000) {
    // Keep the server session alive while the user is actively working.
    api('GET', '/auth/status').then(st => { checkVersion(st); if (!st.authenticated) showAuth('Your session ended. Please unlock again.'); }).catch(() => {});
  }
}, 15000);

// Installable app: register the service worker and keep Chrome's install prompt for our own button.
if ('serviceWorker' in navigator && window.isSecureContext && !window.harmDemo) {
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => { /* untrusted certificate etc. */ });
}
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  S.installPrompt = e;
  document.querySelectorAll('.install-btn').forEach(b => { b.hidden = false; });
});
window.addEventListener('appinstalled', () => { S.installPrompt = null; toast('HaRM installed as an app'); });
async function installApp() {
  if (!S.installPrompt) return phoneAppHelp();
  S.installPrompt.prompt();
  await S.installPrompt.userChoice;
  S.installPrompt = null;
  document.querySelectorAll('.install-btn').forEach(b => { b.hidden = true; });
}
// ---------------------------------------------------------------- keyboard shortcuts

/* The same keys as every ZomBeatz product. Listed in Help and Settings > Shortcuts, and never
   mentioned on touch screens. Ctrl +/−/0 is the browser's own zoom. */
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = IS_MAC ? '⌘' : 'Ctrl';
const hasKeyboard = () => matchMedia('(hover: hover) and (pointer: fine)').matches;
const SHORTCUTS = [
  ['Getting around', [
    [[MOD, 'K'], 'Search everything'],
    [['/'], 'Filter the list on this page'],
    [['['], 'Fold the sidebar'],
    [['?'], 'Help and this list of shortcuts'],
  ]],
  ['Adding and closing', [
    [['N'], 'Add a new item (opens + New)'],
    [['Esc'], 'Close the dialog, menu or search'],
  ]],
  ['Zoom', [
    [[MOD, '+'], 'Zoom in'],
    [[MOD, '−'], 'Zoom out'],
    [[MOD, '0'], 'Back to normal size'],
  ]],
];
function shortcutsList() {
  return SHORTCUTS.map(([group, rows]) => h('div', { class: 'keys-group' }, h('h4', null, group),
    h('table', { class: 'keys' }, h('tbody', null, rows.map(([keys, does]) =>
      h('tr', null, h('td', null, keys.map(k => h('kbd', null, k))), h('td', null, does)))))));
}
function toggleNavFold() {
  const on = !document.body.classList.contains('nav-folded');
  document.body.classList.toggle('nav-folded', on);
  prefSet('harm-nav-folded', on ? '1' : '0');
}
addEventListener('keydown', e => {
  if (!S.authed || e.isComposing) return;
  const typing = e.target.closest && e.target.closest('input,textarea,select,[contenteditable]');
  const inDialog = document.querySelector('.modal-back');
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
    if (inDialog) return;
    const box = document.querySelector('.topbar input[type=search]');
    if (box) { e.preventDefault(); box.focus(); box.select(); }
    return;
  }
  if (e.key === 'Escape') {
    const menu = document.querySelector('.qa-menu:not([hidden])');
    if (menu) { menu.hidden = true; return; }
    if (typing && e.target.matches('.topbar input[type=search]')) { e.target.value = ''; e.target.dispatchEvent(new Event('input')); e.target.blur(); }
    return;
  }
  // Single keys never fire while typing, with a dialog open, or with Ctrl/⌘/Alt held.
  if (typing || inDialog || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === '/') {
    const box = document.querySelector('#view input[type=search]') || document.querySelector('.topbar input[type=search]');
    if (box) { e.preventDefault(); box.focus(); }
  } else if (e.key === 'n' || e.key === 'N') {
    const b = document.querySelector('.qa-btn');
    if (b) { e.preventDefault(); b.click(); document.querySelector('.qa-menu button')?.focus(); }
  } else if (e.key === '?') {
    e.preventDefault();
    location.hash = '#/help?s=keys';
  } else if (e.key === '[' && matchMedia('(min-width: 701px)').matches) {
    e.preventDefault();
    toggleNavFold();
  }
});

startApp().catch(showStartError);

function showStartError(e) {
  const help = h('div', { class: 'boot-help', hidden: true }, troubleshootingContent());
  document.getElementById('app').replaceChildren(h('div', { class: 'boot boot-error' }, h('p', null, 'HaRM couldn’t start. ' + e.message),
    h('div', { class: 'inline center-row' }, btn('⟳ Try again', () => location.reload(), 'primary'),
      btn('Show troubleshooting steps', ev => { help.hidden = !help.hidden; ev.target.textContent = help.hidden ? 'Show troubleshooting steps' : 'Hide troubleshooting steps'; })),
    help));
}

// ---------------------------------------------------------------- network discovery

async function viewDiscover() {
  const cfg = await GET('/discover/config');
  const st = { hosts: [], networks: [], notes: [], label: '', filter: 'new', choice: {}, types: {}, netPick: {} };
  const keyOf = x => x.mac || x.ip;
  const results = h('div');

  const field = (label, input, hint) => h('label', { class: 'disc-field' }, h('span', null, label), input, hint ? h('small', { class: 'muted' }, hint) : null);
  const uUrl = h('input', { type: 'url', value: cfg.unifi.url, placeholder: 'https://192.168.1.1', inputmode: 'url' });
  const uKey = h('input', { type: 'password', autocomplete: 'off', placeholder: cfg.unifi.has_key ? 'Saved in the vault (leave blank)' : 'Paste the API key' });
  const uSite = h('input', { value: cfg.unifi.site, placeholder: 'default' });
  const uVerify = h('input', { type: 'checkbox', checked: cfg.unifi.verify });
  const uRemember = h('input', { type: 'checkbox', checked: true });
  const uStatus = h('div', { class: 'muted small' });
  const uBtn = btn('Import from UniFi', async () => {
    uBtn.disabled = true; fillEl(uStatus, 'Asking the gateway…');
    try {
      const out = await api('POST', '/discover/unifi', { url: uUrl.value, api_key: uKey.value, site: uSite.value, verify: uVerify.checked, remember: uRemember.checked });
      uKey.value = ''; if (uRemember.checked) uKey.placeholder = 'Saved in the vault (leave blank)';
      fillEl(uStatus, `Site “${out.site.name}”: ${out.hosts.length} devices and clients.`);
      show(out, `UniFi · ${out.site.name}`);
    } catch (e) { fillEl(uStatus, h('span', { class: 'bad-text' }, e.message)); }
    uBtn.disabled = false;
  }, 'primary');

  const cidr = h('input', { value: cfg.subnets[0]?.cidr || cfg.networks[0]?.cidr || '', placeholder: '192.168.1.0/24', class: 'mono' });
  const sStatus = h('div', { class: 'muted small' });
  const sBtn = btn('Scan', async () => {
    sBtn.disabled = true; fillEl(sStatus, 'Scanning… this takes 10 to 30 seconds.');
    try {
      const out = await api('POST', '/discover/scan', { cidr: cidr.value });
      fillEl(sStatus, `${out.hosts.length} hosts answered out of ${out.scanned} addresses (${out.elapsed}s).`);
      show(out, `Scan · ${out.cidr}`);
    } catch (e) { fillEl(sStatus, h('span', { class: 'bad-text' }, e.message)); }
    sBtn.disabled = false;
  }, 'primary');
  const sugg = [...cfg.subnets, ...cfg.networks.filter(n => !cfg.subnets.some(s => s.cidr === n.cidr))];

  // Any router: pasted client list
  const listText = h('textarea', { id: 'disc-list', rows: 8, class: 'mono small', spellcheck: 'false', placeholder: 'Paste the table of connected devices / DHCP leases here' });
  const lStatus = h('div', { class: 'muted small' });
  const lBtn = btn('Read list', async () => {
    try {
      const out = await api('POST', '/discover/clients', { text: listText.value });
      fillEl(lStatus, `${out.hosts.length} device${out.hosts.length === 1 ? '' : 's'} found.`);
      show(out, 'Router client list');
    } catch (e) { fillEl(lStatus, h('span', { class: 'bad-text' }, e.message)); }
  }, 'primary');

  // Proxmox
  const px = cfg.proxmox || {};
  const pUrl = h('input', { type: 'url', value: px.url || '', placeholder: 'https://192.168.1.20:8006', inputmode: 'url' });
  const pTok = h('input', { value: px.token_id || '', placeholder: 'root@pam!harm', autocomplete: 'off' });
  const pSec = h('input', { type: 'password', autocomplete: 'off', placeholder: px.has_secret ? 'Saved in the vault (leave blank)' : 'Token secret' });
  const pVerify = h('input', { type: 'checkbox', checked: !!px.verify });
  const pStatus = h('div', { class: 'muted small' });
  const pxResults = h('div');
  const pBtn = btn('Read Proxmox', async () => {
    pBtn.disabled = true; fillEl(pStatus, 'Reading the cluster…');
    try {
      const out = await api('POST', '/discover/proxmox', { url: pUrl.value, token_id: pTok.value, secret: pSec.value, verify: pVerify.checked });
      pSec.value = ''; pSec.placeholder = 'Saved in the vault (leave blank)';
      fillEl(pStatus, `${out.cluster ? `Cluster “${out.cluster}”: ` : ''}${out.nodes.length} node${out.nodes.length === 1 ? '' : 's'}, ${out.guests.length} VMs and containers.`);
      proxmoxPreview(out, pxResults);
    } catch (e) { fillEl(pStatus, h('span', { class: 'bad-text' }, e.message)); }
    pBtn.disabled = false;
  }, 'primary');

  function show(out, label) {
    Object.assign(st, { hosts: out.hosts, networks: out.networks || [], notes: out.notes || [], label, choice: {}, types: {}, netPick: {} });
    for (const x of st.hosts) {
      // Known by MAC/IP with nothing new: skip. Known some other way, or IP changed: update it.
      if (x.match && (x.match.ip_changed || !x.match.interface_id)) st.choice[keyOf(x)] = 'link:' + x.match.device_id;
      st.types[keyOf(x)] = x.type_guess || '';
    }
    for (const n of st.networks) st.netPick[n.cidr] = !n.exists;
    const counts = groups();
    st.filter = counts.new.length ? 'new' : 'all';
    draw();
  }

  function groups() {
    const vis = st.hosts.filter(x => !x.ignored);
    return {
      new: vis.filter(x => !x.match), known: vis.filter(x => x.match),
      changed: vis.filter(x => x.match && x.match.ip_changed), hidden: st.hosts.filter(x => x.ignored), all: vis,
    };
  }

  function actionSelect(x) {
    const k = keyOf(x);
    const opts = [['', x.match ? 'Already in HaRM' : 'Skip'], ['new', '+ Add as new device']];
    if (x.match) opts.push([`link:${x.match.device_id}`, `Update “${x.match.device_name}”`]);
    for (const d of S.lk.devices) if (!x.match || d.id !== x.match.device_id) opts.push([`link:${d.id}`, `Attach to ${d.name}`]);
    const sel = h('select', { class: 'sm', onchange: () => { st.choice[k] = sel.value; draw(); } },
      opts.map(([v, l]) => h('option', { value: v }, l)));
    sel.value = st.choice[k] || '';
    return sel;
  }
  function typeSelect(x) {
    const k = keyOf(x);
    const sel = h('select', { class: 'sm', onchange: () => { st.types[k] = sel.value; } },
      h('option', { value: '' }, 'Type…'), S.enums.device_types.map(t => h('option', { value: t }, t)));
    sel.value = st.types[k] || '';
    return sel;
  }
  async function hide(list, ignore = true) {
    try {
      await api('POST', '/discover/ignore', { keys: list.map(keyOf), ignore });
      list.forEach(x => { x.ignored = ignore; delete st.choice[keyOf(x)]; });
      draw();
    } catch (e) { toast(e.message, 'bad'); }
  }

  const locSel = h('select', null, h('option', { value: '' }, 'No location'), S.lk.locations.map(l => h('option', { value: l.id }, locPath(l.id))));
  const svcBox = h('input', { type: 'checkbox', checked: true });

  async function apply() {
    const items = [];
    for (const x of st.hosts) {
      const c = st.choice[keyOf(x)];
      if (!c || x.ignored) continue;
      const linkId = c.startsWith('link:') ? +c.slice(5) : null;
      items.push({ action: linkId ? 'link' : 'new', device_id: linkId, device_type: st.types[keyOf(x)] || null,
        mgmt: !!(linkId && x.bmc), host: x });
    }
    const networks = st.networks.filter(n => st.netPick[n.cidr] && !n.exists);
    if (!items.length && !networks.length) return toast('Nothing chosen yet. Pick an action on some rows first.', 'bad');
    try {
      const r = await api('POST', '/discover/import', { items, networks, location_id: locSel.value || null, services: svcBox.checked });
      toast(Object.entries(r).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(', ') || 'Nothing changed');
      await loadLookups();
      networks.forEach(n => { n.exists = true; });
      for (const it of items) {
        it.host.match = { device_id: it.device_id, device_name: it.action === 'new' ? 'just added' : (S.lk.devices.find(d => d.id === it.device_id)?.name || 'updated'), how: 'import' };
        delete st.choice[keyOf(it.host)];
      }
      draw();
    } catch (e) { toast(e.message, 'bad'); }
  }

  function draw() {
    if (!st.label) return fillEl(results);
    const g = groups();
    const rows = g[st.filter];
    const chosen = Object.entries(st.choice).filter(([k, v]) => v && !st.hosts.find(x => keyOf(x) === k)?.ignored).length;
    const nets = st.networks.length ? card('Networks on the gateway', table([
      { label: '', nosort: true, get: n => n.exists ? '✓' : h('input', { type: 'checkbox', checked: st.netPick[n.cidr], onchange: e => { st.netPick[n.cidr] = e.target.checked; } }) },
      { label: 'Name', get: n => n.name },
      { label: 'VLAN', get: n => n.vlan_id ?? '' },
      { label: 'Subnet', get: n => mono(n.cidr) },
      { label: 'Gateway', get: n => mono(n.gateway) },
      { label: 'DHCP pool', get: n => n.dhcp_start ? mono(`${n.dhcp_start} to ${n.dhcp_end}`) : '' },
      { label: 'In HaRM', get: n => n.exists ? badge('Already added') : h('span', { class: 'badge info' }, 'New') },
    ], st.networks)) : null;
    const chip = (k, label) => h('button', { type: 'button', class: 'chip' + (st.filter === k ? ' on' : ''), onclick: () => { st.filter = k; draw(); } }, `${label} (${g[k].length})`);
    const hostTable = table([
      { label: 'Name', get: x => h('div', null, h('b', null, x.name || x.hostname || 'None'),
        x.hostname && x.hostname !== x.name ? h('div', { class: 'muted small mono' }, x.hostname) : null,
        x.model ? h('div', { class: 'muted small' }, x.model) : null,
        x.bmc && !x.match ? h('div', { class: 'warn-text small' }, 'Management port (iDRAC/iLO): attach it to its server') : null) },
      { label: 'IP', sort: x => x.ip ? x.ip.split('.').map(n => n.padStart(3, '0')).join('.') : '~', get: x => h('div', null, mono(x.ip || 'None'),
        x.match?.ip_changed ? h('div', { class: 'warn-text small' }, `HaRM has ${x.match.iface_ip}`) : null,
        x.fixed_ip ? h('div', { class: 'muted small' }, 'reserved') : null) },
      { label: 'MAC / vendor', get: x => h('div', null, mono(x.mac || ''), x.vendor ? h('div', { class: 'muted small' }, x.vendor) : null) },
      { label: 'Seen', get: x => h('div', { class: 'small' },
        x.source === 'unifi' ? h('span', { class: x.online ? '' : 'muted' }, nz(x.online ? '● online' : '○ offline', x.connection)) : null,
        x.uplink ? h('div', { class: 'muted' }, nz(x.uplink, x.port ? `port ${x.port}` : '')) : null,
        x.network && x.connection === 'Wi-Fi' ? h('div', { class: 'muted' }, x.network) : null,
        x.ports.length ? h('div', { class: 'port-chips' }, x.ports.map(p => h('span', { class: 'port-chip', title: p.name }, p.port))) : null) },
      { label: 'In HaRM', get: x => x.match
        ? h('div', null, x.match.how === 'import' ? '✓ ' : '', link(`#/devices/${x.match.device_id}`, x.match.device_name),
          x.match.how !== 'import' ? h('div', { class: 'muted small' }, `matched by ${x.match.how}`) : null)
        : h('span', { class: 'badge info' }, 'New') },
      { label: 'Action', nosort: true, get: x => x.ignored
        ? small('Unhide', () => hide([x], false))
        : h('div', { class: 'disc-act' }, actionSelect(x), st.choice[keyOf(x)] === 'new' ? typeSelect(x) : null,
          small('Hide', () => hide([x]), 'ghost')) },
    ], rows, { empty: st.filter === 'new' ? 'Everything found is already in HaRM.' : 'Nothing here.', rowClass: x => st.choice[keyOf(x)] ? 'picked' : '' });
    fillEl(results,
      st.notes.map(n => h('div', { class: 'notice' }, n)),
      nets,
      card(`Found: ${st.label}`, h('div', null,
        h('div', { class: 'chips' }, chip('new', 'New'), chip('changed', 'IP changed'), chip('known', 'Already in HaRM'), chip('all', 'All'), chip('hidden', 'Hidden')),
        st.filter === 'new' && rows.length ? h('div', { class: 'inline disc-bulk' },
          small('Add all shown as devices', () => { rows.forEach(x => { st.choice[keyOf(x)] = 'new'; }); draw(); }),
          small('Hide all shown', async () => { if (await confirmBox(`Hide ${rows.length} hosts from future results? (phones, TVs, smart plugs…) You can unhide them under “Hidden”.`, 'Hide')) hide(rows); }, 'ghost')) : null,
        hostTable)),
      h('div', { class: 'disc-apply card' },
        h('label', { class: 'disc-field' }, h('span', null, 'New devices go in'), locSel),
        h('label', { class: 'check inline-check' }, svcBox, 'Add services for open ports (SSH, web UIs…)'),
        btn(`Apply ${chosen} change${chosen === 1 ? '' : 's'}${st.networks.some(n => st.netPick[n.cidr] && !n.exists) ? ' + networks' : ''}`, apply, 'primary')));
  }

  render(
    pageHead('Discover devices', 'Bring what’s on your network into HaRM: from your router’s client list, a UniFi gateway, Proxmox, or a scan. You review everything before it’s saved.', helpLink('discover')),
    tabs('discover', [
      ['router', 'Any router', null, () => card('Paste your router’s client list', h('div', { class: 'disc-form' },
        h('p', { class: 'muted' }, 'Works with almost any router or DHCP server: copy its list of connected devices or DHCP leases (the whole table is fine) and paste it below. HaRM picks out each device’s IP, MAC address and name.'),
        routerHelp(),
        field('Client list', listText),
        h('div', { class: 'inline' }, lBtn, lStatus)))],
      ['unifi', 'UniFi', null, () => card('UniFi gateway', h('div', { class: 'disc-form' },
        field('Gateway address', uUrl, 'Your UniFi console, e.g. https://192.168.1.1'),
        field('API key', uKey, h('span', null, 'Needs a UniFi OS console (UDM, UCG, UDR, UXG, Cloud Key Gen2+) with UniFi Network 9 or newer. ', helpLink('discover', 'Where do I get one?'))),
        h('details', { class: 'trouble' }, h('summary', null, 'How to create the API key'),
          OL(['Sign in to your console’s UniFi Network app with an admin account.'],
            ['Open ', B('Settings > Control Plane > Integrations'), '. (Depending on the version it may be ', B('Settings > System > Integrations'), ' or ', B('Control Plane > API Access'), '.)'],
            [B('Create API Key'), ', give it a name like “HaRM”, and pick “Never expires” or remember to renew it.'],
            ['Copy the key right away: UniFi only shows it once.']),
          P(h('span', { class: 'muted small' }, 'Older self-hosted “UniFi Network Server” installs don’t support API keys: use ', B('Any router'), ' with the client list copied from its Client Devices page instead.'))),
        field('Site', uSite),
        h('label', { class: 'check inline-check' }, uVerify, 'Verify certificate (off for the console’s self-signed certificate)'),
        h('label', { class: 'check inline-check' }, uRemember, 'Remember the key (encrypted with your vault)'),
        h('div', { class: 'inline' }, uBtn, uStatus)))],
      ['proxmox', 'Proxmox', null, () => [card('Proxmox VE: nodes, VMs and containers', h('div', { class: 'disc-form' },
        h('p', { class: 'muted' }, 'Reads your cluster (or single node), its hosts, and every VM and container with its vCPUs, memory and disk. VM IP addresses come along when the QEMU guest agent is installed.'),
        field('Proxmox address', pUrl, 'Any node, e.g. https://192.168.1.20:8006'),
        h('div', { class: 'grid two' }, field('Token ID', pTok, 'user@realm!name, e.g. root@pam!harm'), field('Token secret', pSec)),
        h('details', { class: 'trouble' }, h('summary', null, 'How to create a read-only token'),
          OL(['In the Proxmox web UI: ', B('Datacenter > Permissions > API Tokens > Add'), '. Pick a user (e.g. root@pam), name the token “harm”.'],
            ['Untick ', B('Privilege Separation'), ' (or give the token its own permission in the next step).'],
            [B('Datacenter > Permissions > Add > API Token Permission'), ': path ', C('/'), ', role ', B('PVEAuditor'), ' (read-only).'],
            ['Copy the secret: Proxmox only shows it once.'])),
        h('label', { class: 'check inline-check' }, pVerify, 'Verify certificate (off for Proxmox’s self-signed certificate)'),
        h('div', { class: 'inline' }, pBtn, pStatus))), pxResults]],
      ['scan', 'Network scan', null, () => card('Scan the network', h('div', { class: 'disc-form' },
        field('Range', cidr, 'Private ranges only, /22 or smaller. Runs from the HaRM server.'),
        sugg.length ? h('div', { class: 'chips' }, sugg.map(s => h('button', { type: 'button', class: 'chip mono', title: s.label, onclick: () => { cidr.value = s.cidr; } }, s.cidr))) : null,
        h('p', { class: 'muted small' }, 'Checks common ports (SSH, web, RDP, SMB, Proxmox, Plex…) on every address, then reads names and MAC addresses. Open ports become suggested services. Phones and other devices that block every port may only show up if the HaRM server can see them on the same network.'),
        h('div', { class: 'inline' }, sBtn, sStatus)))],
    ]),
    results,
    cfg.ignored ? h('p', { class: 'muted small' }, `${cfg.ignored} hosts are hidden from results. Scan again and pick “Hidden” to bring any back.`) : null);
}

// ---------------------------------------------------------------- AI Assist

/* Photo → inventory with any AI chat: HaRM writes the prompt, the AI identifies and prices
   the hardware, and its reply comes back here for a preview before anything is saved. */
async function aiAssist(preset = {}) {
  try {
    const cfg = await GET('/ai/config');
    const p = cfg.providers[cfg.provider];
    let host = '';
    try { host = new URL(cfg.base_url).host; } catch { /* not set */ }
    S.aiConf = p ? (cfg.provider === 'compatible'
      ? { provider: cfg.provider, label: `your AI service${host ? ` at ${host}` : ''}`, short: 'your AI' }
      : { provider: cfg.provider, label: p.label, short: p.label.split(' (')[0] }) : null;
  } catch { S.aiConf = null; }
  return aiAssistDialog(preset);
}

function aiAssistDialog(preset = {}) {
  const st = S.ai = Object.assign(S.ai || { hint: '', reply: '' }, preset.location_id || preset.rack_id ? { location_id: preset.location_id || null, rack_id: preset.rack_id || null, position: preset.position || '' } : {});
  const err = h('div', { class: 'form-error' });
  const preview = h('div');
  const opt = (v, l) => h('option', { value: v ?? '' }, l);
  const locSel = h('select', { id: 'ai-loc' }, opt('', 'Not set'), S.lk.locations.map(l => opt(l.id, locPath(l.id))));
  const rackSel = h('select', { id: 'ai-rack' });
  const fillRacks = () => {
    const lid = +locSel.value || null;
    fillEl(rackSel, opt('', 'Loose in the room'), S.lk.racks.filter(r => !lid || locDescendants(lid).has(r.location_id)).map(r => opt(r.id, r.name)));
    rackSel.value = st.rack_id && [...rackSel.options].some(o => o.value === String(st.rack_id)) ? st.rack_id : '';
  };
  locSel.value = st.location_id || '';
  fillRacks();
  locSel.addEventListener('change', () => { st.location_id = +locSel.value || null; fillRacks(); st.rack_id = +rackSel.value || null; });
  rackSel.addEventListener('change', () => {
    st.rack_id = +rackSel.value || null;
    const r = S.lk.racks.find(x => x.id === st.rack_id);
    if (r && r.location_id && !locSel.value) { locSel.value = r.location_id; st.location_id = r.location_id; }
  });
  const pos = h('input', { id: 'ai-pos', value: st.position || '', placeholder: 'Top shelf, bin 4…', oninput: e => { st.position = e.target.value; } });
  const hint = h('textarea', { id: 'ai-hint', rows: 2, placeholder: 'Optional: what is this? e.g. “drives pulled from the R515s”, “box of RAM from a recycler”', oninput: e => { st.hint = e.target.value; } }, st.hint);
  hint.value = st.hint;
  const devStatus = h('select', { id: 'ai-status' }, S.enums.device_statuses.map(s => opt(s, s)));
  devStatus.value = st.device_status || 'Spare';
  devStatus.addEventListener('change', () => { st.device_status = devStatus.value; });
  const reply = h('textarea', { id: 'ai-reply', rows: 6, class: 'mono', spellcheck: 'false', placeholder: 'Paste the AI’s whole reply here (it starts with {"harm_ai"…)', oninput: e => { st.reply = e.target.value; } });
  reply.value = st.reply;
  const promptBox = h('textarea', { rows: 8, readonly: true, class: 'mono small' });
  const field = (label, input) => h('label', { class: 'disc-field' }, h('span', null, label), input);

  const copyPrompt = async () => {
    err.textContent = '';
    try {
      const r = await api('POST', '/ai/prompt', { hint: st.hint, location_id: st.location_id, rack_id: st.rack_id, position: st.position });
      promptBox.value = r.prompt;
      try { await navigator.clipboard.writeText(r.prompt); toast('Prompt copied. Paste it into your AI app with your photos.'); }
      catch { promptDetails.open = true; promptBox.select(); toast('Select the prompt below and copy it', 'bad'); }
    } catch (e) { err.textContent = e.message; }
  };
  const promptDetails = h('details', { class: 'ai-prompt' }, h('summary', null, 'See the prompt'), promptBox);

  // Built-in route: photos go straight to the AI service chosen in Settings.
  const direct = h('div', { class: 'ai-direct' });
  const photos = [];
  const thumbs = h('div', { class: 'ai-thumbs' });
  const drawThumbs = () => fillEl(thumbs, photos.map((p, i) => h('div', { class: 'ai-thumb' }, h('img', { src: p, alt: `Photo ${i + 1}` }),
    h('button', { type: 'button', class: 'ai-x', 'aria-label': 'Remove photo', onclick: () => { photos.splice(i, 1); drawThumbs(); } }, '✕'))));
  const fileIn = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, onchange: async e => {
    for (const f of [...e.target.files].slice(0, 10 - photos.length)) {
      try { photos.push((await photoToCanvas(f, 1600)).toDataURL('image/jpeg', 0.85)); } catch (x) { toast(x.message, 'bad'); }
    }
    e.target.value = ''; drawThumbs();
  } });
  const askStatus = h('span', { class: 'muted small' });
  const ask = async () => {
    if (!photos.length) return toast('Add a photo first', 'bad');
    err.textContent = ''; askBtn.disabled = true;
    fillEl(askStatus, `Asking ${S.aiConf.label}… this can take a minute while it searches for prices.`);
    try {
      const resp = await fetch('/api/ai/ask', { method: 'POST', credentials: 'same-origin', headers: { 'X-HaRM': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ images: photos, hint: st.hint, location_id: st.location_id, rack_id: st.rack_id, position: st.position }) });
      const data = await resp.json().catch(() => ({}));
      if (resp.status === 401) { showAuth('Your session ended. Please unlock again.'); return; }
      if (data.raw) { st.reply = reply.value = data.raw; }
      if (!resp.ok) {
        err.textContent = data.detail || resp.statusText;
        if (data.raw) { document.querySelector('.ai-manual').open = true; }
      } else { fillEl(askStatus, data.web ? '✓ Answered, with web search' : '✓ Answered'); showPreview(data); }
    } catch (x) { err.textContent = UNREACHABLE(); }
    askBtn.disabled = false;
    if (err.textContent) fillEl(askStatus);
  };
  const askBtn = btn('🤖 Ask', ask, 'primary');
  if (S.aiConf?.provider) {
    askBtn.textContent = `🤖 Ask ${S.aiConf.short}`;
    fillEl(direct, h('div', { class: 'inline' }, btn('📷 Add photos', () => fileIn.click()), askBtn, askStatus), fileIn, thumbs,
      h('p', { class: 'muted small' }, `Photos go to ${S.aiConf.label}. Up to 10 at a time; they’re shrunk first to keep it quick and cheap.`));
  } else {
    fillEl(direct, h('p', { class: 'muted small' }, 'Want to skip the copy & paste? Pick an AI service in ', link('#/settings', 'Settings > AI Assist'), ' to send photos straight from here.'));
  }

  const read = async () => {
    err.textContent = '';
    try { showPreview(await api('POST', '/ai/parse', { text: reply.value })); }
    catch (e) { err.textContent = e.message; fillEl(preview); }
  };

  const showPreview = r => {
    const rows = r.items.map(it => ({ it, on: !it.duplicate }));
    const conf = c => h('span', { class: `badge ${c === 'high' ? 'ok' : c === 'low' ? 'warn' : 'info'}` }, c);
    const tbody = h('tbody');
    const count = h('b');
    const addBtn = h('button', { type: 'button', class: 'primary' });
    const sync = () => { const n = rows.filter(x => x.on).length; count.textContent = `${n} of ${rows.length}`; addBtn.textContent = `Add ${n} item${n === 1 ? '' : 's'}`; addBtn.disabled = !n; };
    for (const row of rows) {
      const it = row.it;
      const name = h('input', { value: it.name, 'aria-label': 'Name', oninput: e => { it.name = e.target.value; } });
      const serial = h('input', { value: it.serial || '', class: 'mono', placeholder: 'serial', 'aria-label': 'Serial', oninput: e => { it.serial = e.target.value; } });
      const scan = small('📷', () => scanDialog({ title: `Scan serial: ${it.name}`, single: true, targets: [{ k: 'serial', label: 'Serial' }], onPick: (_k, v) => { serial.value = v; it.serial = v; } }), 'ghost');
      const qty = it.kind === 'part' ? h('input', { type: 'number', min: 1, value: it.quantity, class: 'qty-in', 'aria-label': 'Quantity', oninput: e => { it.quantity = Math.max(1, parseInt(e.target.value, 10) || 1); } }) : '';
      const cb = h('input', { type: 'checkbox', checked: row.on, onchange: e => { row.on = e.target.checked; sync(); } });
      const specs = it.kind === 'device'
        ? [it.device_type, it.cpu, it.ram, it.storage].filter(Boolean).join(' · ')
        : [it.category, it.capacity, it.interface, it.form_factor, it.speed].filter(Boolean).join(' · ');
      const value = [it.msrp ? `new ${money(it.msrp)}` : '', it.market_value ? `now ${money(it.market_value)}` : ''].filter(Boolean).join(' → ');
      tbody.append(h('tr', { class: it.duplicate ? 'dup' : '' },
        h('td', null, cb),
        h('td', null, h('span', { class: 'badge muted' }, it.kind === 'device' ? 'Device' : 'Part'), ' ', conf(it.confidence)),
        h('td', { class: 'ai-name' }, name, h('div', { class: 'muted small' }, specs || 'None'),
          it.duplicate ? h('div', { class: 'warn-text small' }, 'Already in HaRM: ', link(it.duplicate.link, it.duplicate.name)) : null),
        h('td', null, h('div', { class: 'inline nowrap' }, serial, scan), it.part_number ? h('div', { class: 'muted small mono' }, `P/N ${it.part_number}`) : null),
        h('td', null, qty),
        h('td', { class: 'small' }, value || h('span', { class: 'muted' }, 'None'), it.sources.length ? h('div', { class: 'muted' }, `${it.sources.length} source${it.sources.length > 1 ? 's' : ''}`) : null),
        h('td', { class: 'small' }, it.todo.length ? h('span', { title: it.todo.join('\n') }, `☐ ${it.todo.length}`) : '')));
    }
    const tasksBox = h('input', { type: 'checkbox', checked: true });
    const notesBox = h('input', { type: 'checkbox', checked: true });
    addBtn.addEventListener('click', async () => {
      addBtn.disabled = true;
      try {
        const res = await api('POST', '/ai/import', {
          items: rows.filter(x => x.on).map(x => x.it), batch_todo: r.todo, location_id: st.location_id, rack_id: st.rack_id,
          position: st.position, device_status: st.device_status || 'Spare', tasks: tasksBox.checked, notes: notesBox.checked,
        });
        st.reply = ''; await loadLookups();
        fillEl(preview, h('div', { class: 'notice ok-notice' }, h('b', null, `✓ Added ${res.created.length} item${res.created.length === 1 ? '' : 's'}`),
          res.tasks ? [` and ${res.tasks} task${res.tasks === 1 ? '' : 's'} · `, link('#/tasks', 'See tasks')] : ''),
          h('ul', { class: 'plain' }, res.created.map(c => h('li', null, link(c.link, c.name)))));
        reply.value = '';
        rerender();
      } catch (e) { err.textContent = e.message; addBtn.disabled = false; }
    });
    sync();
    fillEl(preview,
      h('h4', null, '4. Check and add'),
      r.summary ? h('p', { class: 'muted' }, r.summary) : null,
      r.warnings.map(w => h('div', { class: 'notice' }, w)),
      h('div', { class: 'table-wrap' }, h('table', { class: 'ai-table' },
        h('thead', null, h('tr', null, ['', 'Kind', 'Item', 'Serial', 'Qty', 'Value', 'To-do'].map(t => h('th', null, t)))), tbody)),
      r.todo.length ? h('div', { class: 'notice' }, h('b', null, 'To-do for the batch: '), r.todo.join(' · ')) : null,
      h('div', { class: 'ai-foot' },
        h('label', { class: 'check inline-check' }, tasksBox, 'Turn the AI’s to-dos into tasks'),
        h('label', { class: 'check inline-check' }, notesBox, 'Save its research (values, sources, labels) as notes'),
        h('span', { class: 'muted small' }, count, ' ticked'), addBtn));
  };

  modal('🤖 AI Assist: photos to inventory', h('div', { class: 'ai-assist' },
    h('p', { class: 'muted' }, 'Take photos of your hardware (labels visible if you can), let any AI app identify it and look up what it’s worth, then bring the results back here. Nothing is saved until you press Add.'),
    h('h4', null, '1. Where is it? (optional)'),
    h('div', { class: 'grid three' }, field('Location', locSel), field('Holder', rackSel), field('Spot', pos)),
    h('div', { class: 'grid two' }, field('Hint for the AI', hint), field('New devices are marked', devStatus)),
    h('h4', null, '2. Get the AI’s answer'),
    direct,
    h('details', { class: 'ai-manual', open: !S.aiConf?.provider || !!st.reply.trim() },
      h('summary', null, S.aiConf?.provider ? 'Or copy & paste with any AI app' : 'Copy & paste with any AI app (ChatGPT, Claude, Gemini…)'),
      h('div', { class: 'inline' }, btn('📋 Copy prompt', copyPrompt, 'primary'),
        h('span', { class: 'muted small' }, 'Paste it into your AI app and attach your photos. Turn on web search so it can look up prices.')),
      promptDetails,
      h('p', null, h('b', null, 'Then paste the AI’s whole reply:')),
      reply,
      h('div', { class: 'actions' }, btn('Read reply', read, 'primary'))),
    err, preview), { wide: true });
  if (st.reply.trim()) read();
}

/* Settings > AI Assist: which AI service the built-in photo mode uses. */
function aiSettingsCard() {
  const body = h('div', null, h('div', { class: 'muted' }, 'Loading…'));
  GET('/ai/config').then(cfg => {
    const P = cfg.providers;
    const prov = h('select', { id: 'ai-provider' }, h('option', { value: '' }, 'Off (copy & paste only)'),
      Object.entries(P).map(([k, p]) => h('option', { value: k }, p.label)));
    prov.value = cfg.provider;
    const key = h('input', { id: 'ai-key', type: 'password', autocomplete: 'off' });
    const model = h('input', { id: 'ai-model', value: cfg.model });
    const base = h('input', { id: 'ai-base', value: cfg.base_url, placeholder: 'http://localhost:11434/v1', inputmode: 'url' });
    const web = h('input', { type: 'checkbox', checked: cfg.web });
    const keyLink = h('a', { target: '_blank', rel: 'noopener noreferrer' }, 'Get an API key ↗');
    const rows = {};
    const row = (k, label, el, help) => (rows[k] = h('label', { class: 'disc-field' }, h('span', null, label), el, help ? h('small', { class: 'muted' }, help) : null));
    const sync = () => {
      const p = P[prov.value];
      for (const r of Object.values(rows)) r.hidden = !p;
      if (removeKey) removeKey.hidden = !p || !cfg.has_key[prov.value];
      if (!p) return;
      key.placeholder = cfg.has_key[prov.value] ? 'Saved in the vault (leave blank to keep it)' : (p.key ? 'Paste your API key' : 'Only if the service needs one');
      model.placeholder = p.model || 'e.g. llava, qwen2.5vl, gpt-4o';
      rows.base.hidden = prov.value !== 'compatible';
      rows.web.hidden = !p.web;
      keyLink.href = p.keys_url || '#';
      keyLink.hidden = !p.keys_url;
    };
    const removeKey = small('Remove saved key', () => save({ clear_key: true, api_key: '' }), 'ghost-danger');
    prov.addEventListener('change', sync);
    const save = async (extra = {}) => {
      try {
        Object.assign(cfg, await api('POST', '/ai/config', { provider: prov.value, model: model.value, base_url: base.value, web: web.checked, api_key: key.value, ...extra }));
        key.value = ''; sync(); toast(prov.value ? `AI Assist will use ${P[prov.value].label}` : 'Built-in AI Assist is off');
      } catch (e) { toast(e.message, 'bad'); }
    };
    fillEl(body,
      h('p', { class: 'muted' }, 'Lets 🤖 AI Assist send your photos straight to an AI service and fill in the results. Without one, you can still copy the prompt into any AI app.'),
      h('label', { class: 'disc-field' }, h('span', null, 'AI service'), prov),
      row('key', 'API key', h('div', { class: 'inline' }, key, keyLink), 'Stored encrypted in your vault. Usage is billed by the service, usually a few cents per batch of photos.'),
      row('model', 'Model', model, 'Leave blank for the recommended one. It must be able to see images.'),
      row('base', 'Service address', base, 'Ollama: http://localhost:11434/v1 · LM Studio: http://localhost:1234/v1 · OpenRouter: https://openrouter.ai/api/v1'),
      row('web', '', h('span', { class: 'inline' }, web, 'Let it search the web for prices and specs')),
      h('div', { class: 'inline' }, btn('Save', () => save(), 'primary'), removeKey),
      h('p', { class: 'muted small' }, 'Photos you send go to the service you pick (a local Ollama or LM Studio keeps them on your network). Logins and other secrets are never sent.'));
    sync();
  }).catch(e => fillEl(body, h('div', { class: 'form-error' }, e.message)));
  return card('AI Assist', body);
}


/* Where to find the client list on common routers. */
function routerHelp() {
  const rows = [
    ['pfSense', 'Status > DHCP Leases (select the table and copy). Or the file /var/dhcpd/var/db/dhcpd.leases.'],
    ['OPNsense', 'Services > ISC DHCPv4 > Leases (or Services > Dnsmasq / Kea > Leases on newer versions).'],
    ['OpenWrt', 'Status > Overview > Active DHCP Leases, or the file /tmp/dhcp.leases.'],
    ['Pi-hole', 'Settings > DHCP > Currently active DHCP leases, or /etc/pihole/dhcp.leases.'],
    ['MikroTik', 'IP > DHCP Server > Leases (select all, copy), or run /ip dhcp-server lease print.'],
    ['TP-Link Omada', 'Clients page > Export (CSV), then paste the file’s contents.'],
    ['UniFi without API keys', 'Client Devices (select the table and copy), or Export.'],
    ['Home routers (Netgear, ASUS, TP-Link, Eero, ISP boxes…)', 'Look for “Attached devices”, “Client list”, “DHCP clients” or “Connected devices” and copy the table.'],
    ['No router access?', 'On a Windows PC run ', C('arp -a'), ' (or ', C('ip neigh'), ' on Linux) and paste the output. It only lists devices that PC has talked to recently.'],
  ];
  return h('details', { class: 'trouble' }, h('summary', null, 'Where do I find the list on my router?'),
    h('dl', { class: 'kv help-kv' }, rows.map(([k, ...v]) => [h('dt', null, k), h('dd', null, ...v)])));
}

/* Proxmox import preview: link or add each node, add or update each VM / container. */
function proxmoxPreview(out, box) {
  const nodeSel = {}, guestPick = {};
  const devOpts = S.lk.devices.filter(d => !d.host_id);
  const nodeRows = out.nodes.map(n => {
    const sel = h('select', { class: 'sm' }, h('option', { value: 'create' }, `+ Add “${n.name}” as a new host`),
      h('option', { value: '' }, 'Skip'), devOpts.map(d => h('option', { value: d.id }, `Link to ${d.name}`)));
    sel.value = n.match ? String(n.match.id) : 'create';
    nodeSel[n.name] = sel;
    return h('tr', null, h('td', null, h('b', null, n.name), h('div', { class: 'muted small mono' }, n.ip || '')),
      h('td', { class: 'small' }, [n.cpus ? `${n.cpus} CPUs` : '', n.ram_gb ? `${n.ram_gb} GB RAM` : ''].filter(Boolean).join(' · ')),
      h('td', null, n.online ? badge('Active') : badge('Standby')), h('td', null, sel));
  });
  const guestRows = out.guests.filter(g => !g.template).map(g => {
    const cb = h('input', { type: 'checkbox', checked: true });
    guestPick[`${g.node}/${g.vmid}`] = [cb, g];
    return h('tr', null, h('td', null, cb), h('td', null, h('b', null, g.name), h('div', { class: 'muted small' }, `${g.kind} ${g.vmid} on ${g.node}`)),
      h('td', { class: 'small' }, [g.vcpus ? `${g.vcpus} vCPU` : '', g.ram_gb ? `${g.ram_gb} GB` : '', g.disk_gb ? `${g.disk_gb} GB disk` : ''].filter(Boolean).join(' · ')),
      h('td', { class: 'small mono' }, g.ips.join(', ')), h('td', null, g.running ? h('span', { class: 'ok-text' }, '● running') : h('span', { class: 'muted' }, '○ stopped')),
      h('td', { class: 'small' }, g.match ? ['Update ', link(`#/devices/${g.match.id}`, g.match.name)] : h('span', { class: 'badge info' }, 'New')));
  });
  const locSel = h('select', null, h('option', { value: '' }, 'No location'), S.lk.locations.map(l => h('option', { value: l.id }, locPath(l.id))));
  const apply = btn('Import', async () => {
    const nodes = out.nodes.map(n => ({ name: n.name, ip: n.ip, device_id: /^\d+$/.test(nodeSel[n.name].value) ? +nodeSel[n.name].value : null, create: nodeSel[n.name].value === 'create' }));
    const guests = Object.values(guestPick).filter(([cb]) => cb.checked).map(([, g]) => ({ ...g, device_id: g.match?.id || null, create: !g.match }));
    try {
      const r = await api('POST', '/discover/proxmox/import', { cluster: out.cluster, nodes, guests, location_id: locSel.value || null });
      toast(Object.entries(r).filter(([, v]) => v).map(([k, v]) => `${v} ${k.replace('_', ' ')}`).join(', ') || 'Nothing changed');
      await loadLookups();
      fillEl(box, h('div', { class: 'notice ok-notice' }, '✓ Imported. ', link('#/virtual', 'See Virtual & Clusters')));
    } catch (e) { toast(e.message, 'bad'); }
  }, 'primary');
  fillEl(box,
    out.notes.map(n => h('div', { class: 'notice' }, n)),
    out.cluster ? h('p', null, 'Cluster ', h('b', null, out.cluster), out.cluster_match ? ' (already in HaRM, will be updated)' : ' (will be added)') : null,
    card('Hosts', h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, ['Node', 'Size', 'State', 'In HaRM'].map(t => h('th', null, t)))), h('tbody', null, nodeRows)))),
    card(`VMs and containers · ${guestRows.length}`, guestRows.length ? h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, ['', 'Name', 'Size', 'IP', 'State', 'In HaRM'].map(t => h('th', null, t)))), h('tbody', null, guestRows)))
      : h('div', { class: 'empty' }, 'No VMs or containers.')),
    h('div', { class: 'disc-apply card' }, h('label', { class: 'disc-field' }, h('span', null, 'New hosts go in'), locSel), apply));
}


/* VMs and containers on a host, with how much of the host they claim. */
function guestsCard(dev, d, back) {
  const t = d.guest_totals;
  const threads = d.cpus.threads || d.cpus.cores || 0;
  const ramGb = d.memory.total_gb || 0;
  const meter = (label, used, cap, unit) => {
    if (!cap) return h('div', { class: 'muted small' }, `${label}: ${used || 0}${unit} allocated (add the host’s ${label === 'CPU' ? 'CPU' : 'memory'} under Hardware to compare)`);
    const pct = Math.round((used / cap) * 100);
    const fill = h('div', { class: 'bar-fill' + (pct > 100 ? ' hot' : '') });
    fill.style.width = `${Math.min(100, pct)}%`;
    return h('div', { class: 'bar-row' }, h('div', { class: 'bar-label' }, label), h('div', { class: 'bar' }, fill),
      h('div', { class: 'bar-n' }, `${used}${unit} / ${cap}${unit}${pct > 100 ? ` (${(used / cap).toFixed(1)}× overcommitted)` : ''}`));
  };
  return [
    card(`VMs & containers on ${dev.name}`, h('div', null,
      t.count ? h('div', { class: 'bars' }, meter('CPU', t.vcpus, threads, ' vCPU'), meter('Memory', +t.ram_gb.toFixed(1), +ramGb.toFixed(1), ' GB')) : null,
      table([
        { label: '', get: r => dot(r.status === 'Active'), sort: r => r.status, cls: 'narrow' },
        { label: 'Name', get: r => h('div', null, link(`#/devices/${r.id}`, r.name), h('div', { class: 'muted small' }, nz(r.device_type, r.vm_id ? `· ID ${r.vm_id}` : ''))) },
        { label: 'vCPU', get: r => r.vcpus ?? '', sort: r => r.vcpus || 0 },
        { label: 'Memory', get: r => r.vm_ram_gb != null ? `${r.vm_ram_gb} GB` : '', sort: r => r.vm_ram_gb || 0 },
        { label: 'Disk', get: r => r.vm_disk_gb != null ? `${r.vm_disk_gb} GB` : '', sort: r => r.vm_disk_gb || 0 },
        { label: 'IP', get: r => h('span', { class: 'mono' }, (r.ips || '').split(', ')[0]) },
        { label: 'Status', get: r => statusSelect(r, back), sort: r => r.status },
      ], d.guests, { empty: 'No VMs or containers recorded on this host yet. Add them here, or import them from Proxmox in Discover.', onRow: r => { location.hash = `#/devices/${r.id}`; } })),
      small('+ Add VM', () => editEntity('devices', { host_id: dev.id, device_type: 'Virtual Machine', status: 'Active', connected: true, cluster_id: dev.cluster_id }, back)),
      small('+ Container', () => editEntity('devices', { host_id: dev.id, device_type: 'Container', status: 'Active', connected: true, cluster_id: dev.cluster_id }, back))),
  ];
}


// ---------------------------------------------------------------- virtual machines & clusters

const gbText = v => v == null ? '' : v >= 1000 ? `${+(v / 1000).toFixed(1)} TB` : `${+(+v).toFixed(1)} GB`;

function vmTable(rows, back, { showHost = true } = {}) {
  return table([
    { label: '', get: r => dot(r.status === 'Active'), sort: r => r.status, cls: 'narrow' },
    { label: 'Name', get: r => h('div', null, link(`#/devices/${r.id}`, r.name), h('div', { class: 'muted small' }, nz(r.device_type, r.vm_id ? `· ID ${r.vm_id}` : ''))) },
    showHost ? { label: 'Host', get: r => r.host_id ? link(`#/devices/${r.host_id}`, r.host_name) : h('span', { class: 'warn-text small' }, 'not set'), sort: r => r.host_name || '' } : null,
    { label: 'vCPU', get: r => r.vcpus ?? '', sort: r => r.vcpus || 0 },
    { label: 'Memory', get: r => gbText(r.vm_ram_gb), sort: r => r.vm_ram_gb || 0 },
    { label: 'Disk', get: r => gbText(r.vm_disk_gb), sort: r => r.vm_disk_gb || 0 },
    { label: 'IP', get: r => h('span', { class: 'mono' }, (r.ips || '').split(', ')[0]) },
    { label: 'Status', get: r => statusSelect(r, back), sort: r => r.status },
  ].filter(Boolean), rows, { empty: 'No VMs or containers yet.', onRow: r => { location.hash = `#/devices/${r.id}`; } });
}

async function viewVirtual() {
  const [clusters, devices] = await Promise.all([GET('/clusters'), GET('/devices')]);
  const back = () => viewVirtual();
  const guests = devices.filter(isVirtual);
  const hosts = devices.filter(d => !isVirtual(d) && (devices.some(g => g.host_id === d.id) || /hypervisor/i.test(d.device_type || '')));
  const F = S.filters.virtual = S.filters.virtual || {};
  const holder = h('div');
  const q = h('input', { type: 'search', placeholder: 'Filter VMs…', value: F.q || '', oninput: e => { F.q = e.target.value; draw(); } });
  const draw = () => {
    const n = (F.q || '').toLowerCase();
    fillEl(holder, vmTable(guests.filter(g => !n || [g.name, g.host_name, g.vm_id, g.ips, g.os].some(x => x && String(x).toLowerCase().includes(n))), back));
  };
  const running = guests.filter(g => g.status === 'Active').length;
  render(
    pageHead('Virtual & Clusters', `${guests.length} VMs and containers (${running} running) on ${hosts.length} host${hosts.length === 1 ? '' : 's'}`,
      helpLink('virtual'),
      h('a', { class: 'button', href: '#/discover' }, '⌖ Import from Proxmox'),
      btn('+ Cluster', () => editEntity('clusters', {}, r => { location.hash = `#/clusters/${r.id}`; })),
      btn('+ VM', () => editEntity('devices', { device_type: 'Virtual Machine', status: 'Active', connected: true }, r => { location.hash = `#/devices/${r.id}`; }), 'primary')),
    clusters.length ? h('div', { class: 'grid' }, clusters.map(c => h('a', { class: 'card cluster-tile', href: `#/clusters/${c.id}` },
      h('div', { class: 'cluster-kind' }, c.kind || 'Cluster'), h('h3', null, c.name),
      h('div', { class: 'muted' }, `${c.node_count} node${c.node_count === 1 ? '' : 's'} · ${c.guest_count} guest${c.guest_count === 1 ? '' : 's'}`)))) : null,
    hosts.length ? card('Hosts', table([
      { label: 'Host', get: r => link(`#/devices/${r.id}`, r.name) },
      { label: 'Cluster', get: r => r.cluster_id ? link(`#/clusters/${r.cluster_id}`, r.cluster_name) : '' },
      { label: 'Guests', get: r => guests.filter(g => g.host_id === r.id).length, sort: r => guests.filter(g => g.host_id === r.id).length },
      { label: 'vCPU allocated', get: r => guests.filter(g => g.host_id === r.id).reduce((a, g) => a + (g.vcpus || 0), 0) },
      { label: 'Memory allocated', get: r => gbText(guests.filter(g => g.host_id === r.id).reduce((a, g) => a + (g.vm_ram_gb || 0), 0)) },
      { label: 'Status', get: r => badge(r.status) },
    ], hosts, { onRow: r => { location.hash = `#/devices/${r.id}`; } })) : null,
    card('VMs & containers', h('div', null, h('div', { class: 'toolbar' }, q), holder)),
    !guests.length && !clusters.length ? h('div', { class: 'card onboarding' }, h('h3', null, 'Track your virtual machines'),
      P('Add each VM or container as a device that ', B('runs on'), ' a host, with its ID, vCPUs, memory and disk. Hosts then show what’s running on them and how much of their CPU and memory is claimed. Group hosts into a ', B('cluster'), ' (Proxmox, Kubernetes, vSphere…) to see everything together.'),
      P('Running Proxmox? ', link('#/discover', 'Discover > Proxmox'), ' imports the cluster, its nodes and every VM and container in one go.')) : null);
  draw();
}

async function viewCluster(id) {
  const d = await GET(`/clusters/${id}/full`);
  const c = d.cluster, back = () => viewCluster(id);
  const cap = d.capacity, used = d.allocated;
  const meter = (label, u, total, unit) => {
    const pct = total ? Math.round((u / total) * 100) : 0;
    const fill = h('div', { class: 'bar-fill' + (pct > 100 ? ' hot' : '') });
    fill.style.width = `${Math.min(100, pct)}%`;
    return h('div', { class: 'bar-row' }, h('div', { class: 'bar-label' }, label), h('div', { class: 'bar' }, fill),
      h('div', { class: 'bar-n' }, total ? `${u}${unit} / ${total}${unit}` : `${u}${unit} allocated`));
  };
  render(
    h('div', { class: 'crumbs' }, backLink(), link('#/virtual', 'Virtual & Clusters'), ' › ', c.name),
    pageHead(c.name, nz(c.kind, c.location_name ? `· ${c.location_name}` : '') || null,
      btn('+ Add node', () => choose('Add a node', 'Pick an existing device or add a new one.', [['existing', 'Existing device'], ['new', 'New device', 'primary']]).then(async k => {
        if (k === 'new') editEntity('devices', { device_type: 'Hypervisor Host', status: 'Active', cluster_id: id }, back);
        if (k === 'existing') {
          const opts = S.lk.devices.filter(x => !x.host_id && x.cluster_id !== id);
          formDialog({ title: `Add a node to ${c.name}`, fields: [{ k: 'device_id', label: 'Device', type: 'select', required: true, options: opts.map(x => ({ value: x.id, label: x.name })) }],
            submit: v => api('PUT', `/devices/${v.device_id}`, { cluster_id: id }), onDone: back });
        }
      })),
      btn('Edit', () => editEntity('clusters', c, back)),
      menuButton('⋯', [['🗑 Delete cluster', () => deleteEntity('clusters', c, () => goBackOr('#/virtual'), 'Its hosts and VMs stay; they just leave the cluster.'), 'danger-item']])),
    h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('div', { class: 'stat-n' }, d.nodes.length), h('div', { class: 'stat-l' }, 'Nodes')),
      h('div', { class: 'stat' }, h('div', { class: 'stat-n' }, d.guests.length), h('div', { class: 'stat-l' }, `VMs & containers · ${d.guests.filter(g => g.status === 'Active').length} running`)),
      cap.cores ? h('div', { class: 'stat' }, h('div', { class: 'stat-n' }, cap.cores), h('div', { class: 'stat-l' }, `Cores · ${cap.threads} threads`)) : null,
      cap.ram_gb ? h('div', { class: 'stat' }, h('div', { class: 'stat-n' }, gbText(cap.ram_gb)), h('div', { class: 'stat-l' }, 'Memory')) : null),
    card('Resources claimed by guests', h('div', { class: 'bars' },
      meter('CPU', used.vcpus, cap.threads, ' vCPU'), meter('Memory', +used.ram_gb.toFixed(1), +cap.ram_gb.toFixed(1), ' GB'),
      meter('Disk', +used.disk_gb.toFixed(0), +cap.storage_gb.toFixed(0), ' GB'))),
    card('Nodes', table([
      { label: '', get: r => dot(r.connected), cls: 'narrow' },
      { label: 'Node', get: r => link(`#/devices/${r.id}`, r.name) },
      { label: 'Guests', get: r => d.guests.filter(g => g.host_id === r.id).length },
      { label: 'IP', get: r => h('span', { class: 'mono' }, (r.ips || '').split(', ')[0]) },
      { label: 'Where', get: r => r.rack_id ? placement(r) : (r.location_id ? locPath(r.location_id) : '') },
      { label: 'Status', get: r => statusSelect(r, back), sort: r => r.status },
    ], d.nodes, { empty: 'No nodes yet. Add the hosts that make up this cluster.', onRow: r => { location.hash = `#/devices/${r.id}`; } })),
    card('VMs & containers', vmTable(d.guests, back)),
    journalCard('clusters', id, d.notes, back));
}


/* QR codes for setting up a phone from the web app (for servers without the desktop app). */
function phoneQrBlock() {
  const urls = S.caps.phone_urls || [];
  if (!urls.length || !S.caps.ca_cert) return null;
  const pick = h('select', { 'aria-label': 'Address' }, urls.map(u => h('option', { value: u }, u.replace('https://', ''))));
  const certBox = h('div', { class: 'qr-box' }), appBox = h('div', { class: 'qr-box' });
  const draw = async () => {
    const base = pick.value;
    try {
      fillEl(certBox, await qrSvg(`${base}/harm-ca.crt`, 168), h('div', { class: 'muted small' }, '① Certificate'));
      fillEl(appBox, await qrSvg(`${base}/`, 168), h('div', { class: 'muted small' }, '② Open HaRM'));
    } catch { fillEl(certBox, h('span', { class: 'muted' }, 'QR codes need the scanner library')); }
  };
  pick.addEventListener('change', draw);
  draw();
  return h('div', { class: 'qr-pair-wrap' },
    h('p', null, h('b', null, 'Scan this with your phone’s camera. '), 'Both need to be on the same Wi‑Fi. Scan ① first (install and trust the certificate), then ②.'),
    urls.length > 1 ? h('label', { class: 'disc-field' }, h('span', null, 'Address your phone uses'), pick) : null,
    h('div', { class: 'qr-pair' }, certBox, appBox));
}
