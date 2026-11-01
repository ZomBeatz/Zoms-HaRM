/* Forms built from a list of fields: every add and edit dialog, the setup guide's quick adds.
 * A FormCtl holds the values (strings, and booleans for checkboxes, like the inputs themselves),
 * so other code can fill a form while it's open: label scans, "Find in library", examples. */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { S } from '../lib/state';
import { lkLabel } from '../lib/lookups';
import { genPassword, splitTokens, toggleToken, type Row } from '../lib/util';
import { choose, modal, toast, type ModalCtl } from './overlay';
import { EyeButton, Small, type Kid } from './bits';
import { scanDialog, scanLabel } from '../dialogs/scan';

export type Vals = Record<string, any>;
export interface Field {
  k?: string;
  label?: string;
  type?: 'text' | 'number' | 'date' | 'time' | 'textarea' | 'checkbox' | 'select' | 'fk' | 'password' | 'hidden' | 'url';
  section?: string;
  required?: boolean;
  default?: unknown;
  options?: (string | { value: string | number; label: string })[];
  entity?: string;
  filter?: (r: Row) => boolean;
  none?: string;
  list?: string;
  ph?: string;
  help?: Kid;
  wide?: boolean;
  /* Submitted as typed, spaces and all (usernames, commands). */
  raw?: boolean;
  min?: number;
  max?: number;
  step?: string;
  rows?: number;
  inputmode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
  scan?: boolean;
  showIf?: (v: Vals) => boolean;
  clearWhenHidden?: boolean;
  scopeBy?: string[];
  scope?: (r: Row, v: Vals) => boolean;
  onChange?: (value: any, form: FormCtl) => void;
  chips?: string[] | null | ((v: Vals) => string[] | null | undefined);
  chipMulti?: boolean;
  chipAppend?: boolean;
  adv?: boolean;
  /* Only steers the form; never submitted. */
  virtual?: boolean;
  /* Never kept in drafts. */
  secret?: boolean;
  noGenerate?: boolean;
}

const optList = (list: Field['options']) => (list || []).map(o => typeof o === 'string' ? { value: o, label: o } : { value: String(o.value), label: o.label });

export class FormCtl {
  fields: Field[];
  vals: Vals = {};
  showAdv = false;
  flagged: string | null = null;
  private listeners = new Set<() => void>();
  version = 0;

  constructor(fields: (Field | null | false)[], rec: Row = {}) {
    this.fields = fields.filter(Boolean) as Field[];
    for (const f of this.inputs()) {
      const v = rec[f.k!] ?? f.default;
      this.vals[f.k!] = f.type === 'checkbox' ? !!v : v == null ? '' : String(v);
    }
    // A choice that isn't on the list starts empty (or on the first choice, when one is needed).
    for (const f of this.inputs()) {
      if (f.type !== 'select' && f.type !== 'fk') continue;
      const cur = this.vals[f.k!];
      if (cur === '') { if (f.type === 'select' && f.required) this.vals[f.k!] = this.options(f)[0]?.value ?? ''; continue; }
      if (!this.options(f).some(o => o.value === cur)) this.vals[f.k!] = f.type === 'select' && f.required ? (this.options(f)[0]?.value ?? '') : '';
    }
    const adv = this.inputs().filter(f => f.adv && f.type !== 'hidden');
    this.showAdv = adv.some(f => { const x = rec[f.k!]; return x != null && x !== '' && x !== false; });
  }

  inputs() { return this.fields.filter(f => f.k && !f.section); }
  field(k: string) { return this.inputs().find(f => f.k === k); }
  has(k: string) { return !!this.field(k); }
  get(k: string) { return this.vals[k]; }

  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  notify() { this.version++; this.listeners.forEach(fn => fn()); }

  /* The choices of a select or fk field, with the current value kept when a filter hides it. */
  options(f: Field, keepCurrent = true): { value: string; label: string }[] {
    if (f.type !== 'fk') return optList(f.options);
    const all: Row[] = (S.lk as any)[f.entity!] || [];
    let rows = all;
    if (f.filter) rows = rows.filter(f.filter);
    if (f.scope) rows = rows.filter(r => f.scope!(r, this.vals));
    const list = rows.map(r => ({ value: String(r.id), label: lkLabel(f.entity!, r) })).sort((a, b) => a.label.localeCompare(b.label));
    const keep = this.vals[f.k!];
    if (keepCurrent && keep != null && keep !== '' && !list.some(o => o.value === String(keep))) {
      const r = all.find(x => String(x.id) === String(keep));
      if (r) list.unshift({ value: String(r.id), label: lkLabel(f.entity!, r) });
    }
    return list;
  }

  visible(f: Field) { return !f.showIf || !!f.showIf(this.vals); }

  /* One field changed: run its onChange, and empty fields scoped by it whose value no longer fits. */
  private changed(k: string) {
    const f = this.field(k);
    if (f?.onChange) f.onChange(this.vals[k], this);
    for (const g of this.inputs()) {
      if (!g.scope || !(g.scopeBy || []).includes(k)) continue;
      const cur = this.vals[g.k!];
      if (cur && !this.options(g, false).some(o => o.value === cur)) { this.vals[g.k!] = ''; this.changed(g.k!); }
    }
  }

  input(k: string, v: unknown) {
    this.vals[k] = v;
    if (this.flagged === k) this.flagged = null;
    this.changed(k);
    this.notify();
  }

  /* Set values in field order, as if typed, so scoping and onChange follow. */
  set(values: Vals) {
    for (const f of this.inputs()) {
      const k = f.k!;
      if (!(k in values)) continue;
      const v = values[k];
      this.vals[k] = f.type === 'checkbox' ? !!v : v == null ? '' : String(v);
      this.changed(k);
    }
    this.notify();
  }

  values(): Vals {
    const out: Vals = {};
    for (const f of this.inputs()) {
      const k = f.k!;
      if (f.virtual) continue;
      if (f.type !== 'hidden' && f.clearWhenHidden && !this.visible(f)) { out[k] = f.type === 'checkbox' ? false : null; continue; }
      const v = this.vals[k];
      if (f.type === 'checkbox') out[k] = !!v;
      else if (f.type === 'password' || f.raw) out[k] = v;
      else out[k] = String(v).trim() === '' ? null : v;
    }
    return out;
  }

  draftValues() {
    const v = this.values();
    for (const f of this.inputs()) if (f.type === 'password' || f.secret) delete v[f.k!];
    return v;
  }

  /* Highlight the field a server error is about. */
  flag(message: string) {
    const m = /(?:for |^)([a-z_]+)(?: is required|:)/.exec(message || '') || /field: ([a-z_]+)/.exec(message || '');
    const hit = m && this.field(m[1]);
    this.flagged = hit ? m![1] : null;
    if (hit) this.showAdv = true;
    this.notify();
    return !!hit;
  }
}

export function useForm(ctl: FormCtl) {
  const [, set] = useState(0);
  useEffect(() => ctl.subscribe(() => set(n => n + 1)), [ctl]);
  return ctl;
}

function FieldView({ ctl, f }: { ctl: FormCtl; f: Field }) {
  const id = useId();
  const [shown, setShown] = useState(false);
  const k = f.k!;
  const v = ctl.vals[k];
  const hidden = !ctl.visible(f);
  const set = (x: unknown) => ctl.input(k, x);
  if (f.type === 'hidden') return null;
  let input: ReactNode;
  if (f.type === 'textarea') {
    input = <textarea id={id} rows={f.rows || 3} value={v} placeholder={f.ph} required={f.required && !hidden} onChange={e => set(e.target.value)} />;
  } else if (f.type === 'checkbox') {
    input = <input id={id} type="checkbox" checked={!!v} onChange={e => set(e.target.checked)} />;
  } else if (f.type === 'select' || f.type === 'fk') {
    const list = ctl.options(f);
    input = (
      <select id={id} value={v} required={f.required && !hidden} onChange={e => set(e.target.value)}>
        {f.required && f.type !== 'fk' ? null : <option value="">{f.none || 'None'}</option>}
        {list.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  } else if (f.type === 'password') {
    input = (
      <div className="pw-row">
        <input id={id} type={shown ? 'text' : 'password'} value={v} autoComplete="new-password" spellCheck={false}
          required={f.required && !hidden} onChange={e => set(e.target.value)} />
        <EyeButton shown={shown} setShown={setShown} />
        {f.noGenerate ? null : <Small label="Generate" onClick={() => { setShown(true); set(genPassword()); }} />}
      </div>
    );
  } else {
    input = (
      <input id={id} type={f.type || 'text'} value={v} placeholder={f.ph} step={f.step} min={f.min} max={f.max}
        list={f.list ? 'dl_' + f.list : undefined} autoComplete="off" spellCheck={f.type ? undefined : false}
        inputMode={f.type === 'number' ? 'decimal' : f.inputmode} autoCapitalize={f.scan ? 'characters' : undefined}
        required={f.required && !hidden} onChange={e => set(e.target.value)} />
    );
  }
  if (f.scan) {
    input = (
      <div className="scan-row">{input}
        <button type="button" className="scan-btn" title={`Scan ${f.label}`} aria-label={`Scan ${f.label}`}
          onClick={() => scanDialog({ title: `Scan ${f.label}`, single: true, targets: [{ k: 'x', label: f.label! }], onPick: (_k, x) => set(x) })}>📷</button>
      </div>
    );
  }
  const chips = typeof f.chips === 'function' ? f.chips(ctl.vals) : f.chips;
  const chipOn = (c: string) => f.chipMulti ? splitTokens(v).includes(c) : v === c;
  const pick = (c: string) => set(f.chipMulti ? toggleToken(v, c)
    : f.chipAppend && String(v).trim() && !String(v).includes(c) ? `${String(v).trim()}, ${c}` : c);
  const cls = 'field' + (f.wide ? ' wide' : '') + (f.type === 'checkbox' ? ' is-check' : '') + (f.adv ? ' adv' : '') + (ctl.flagged === k ? ' invalid' : '');
  return (
    <div className={cls} data-k={k} hidden={hidden}>
      {f.type === 'checkbox'
        ? <label className="check" htmlFor={id}>{input}<span>{f.label}</span></label>
        : <><label htmlFor={id}>{(f.label || '') + (f.required ? ' *' : '')}</label>{input}</>}
      {f.chips ? (
        <div className="chips field-chips" hidden={!chips || !chips.length}>
          {(chips || []).map(c => <button key={c} type="button" className={'chip' + (chipOn(c) ? ' on' : '')} onClick={() => pick(c)}>{c}</button>)}
        </div>
      ) : null}
      {f.help ? <small>{f.help}</small> : null}
    </div>
  );
}

/* The fields, in a grid; optional ones fold under "More details". */
export function FormGrid({ ctl }: { ctl: FormCtl }) {
  useForm(ctl);
  const grid = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ctl.flagged) grid.current?.querySelector(`[data-k="${ctl.flagged}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [ctl.flagged, ctl.version]);
  const hasAdv = ctl.inputs().some(f => f.adv);
  const out: ReactNode[] = [];
  let toggled = false;
  ctl.fields.forEach((f, i) => {
    if (hasAdv && !toggled && f.adv) {
      toggled = true;
      out.push(<button key="adv" type="button" className="more-toggle wide" onClick={() => { ctl.showAdv = !ctl.showAdv; ctl.notify(); }}>
        {ctl.showAdv ? '▾ Fewer details' : '▸ More details (optional)'}</button>);
    }
    if (f.section) out.push(<div key={'s' + i} className={'form-section' + (f.adv ? ' adv' : '')} hidden={!!f.showIf && !f.showIf(ctl.vals)}>{f.section}</div>);
    else out.push(<FieldView key={f.k} ctl={ctl} f={f} />);
  });
  return <div ref={grid} className={'form-grid' + (ctl.showAdv ? ' show-adv' : '')}>{out}</div>;
}

// ---------------------------------------------------------------- drafts

/* Draft autosave so a closed dialog, idle lock or phone tab reload never loses typing.
 * Secrets are never written to drafts. */
const DRAFT_PREFIX = 'harm-draft:';
const DRAFT_TTL = 7 * 864e5;
export function loadDraft(key: string): Vals | null {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_PREFIX + key) || 'null');
    if (!d || Date.now() - d.at > DRAFT_TTL) return null;
    return d.values;
  } catch { return null; }
}
export function saveDraft(key: string, values: Vals) {
  try { localStorage.setItem(DRAFT_PREFIX + key, JSON.stringify({ at: Date.now(), values })); } catch { /* storage unavailable */ }
}
export function clearDraft(key: string) {
  try { localStorage.removeItem(DRAFT_PREFIX + key); } catch { /* storage unavailable */ }
}

// ---------------------------------------------------------------- the form dialog

export interface FormDialogOpts {
  title: Kid;
  fields: (Field | null | false)[];
  rec?: Row;
  submit: (vals: Vals, form: FormCtl) => unknown;
  onDone?: (res: any, info: { again: boolean; vals: Vals }) => unknown;
  /* Shown above the fields. */
  top?: Kid;
  /* Shown below the fields. */
  extra?: Kid;
  saveLabel?: string;
  wide?: boolean;
  draftKey?: string;
  again?: { label?: string } | null;
  scanTargets?: string[];
  headButtons?: (form: FormCtl) => Kid;
  notice?: Kid;
  preset?: Row | null;
}

function FormDialogBody({ o, ctl, m, api }: { o: FormDialogOpts; ctl: FormCtl; m: ModalCtl; api: { submit?: (again: boolean) => Promise<boolean> } }) {
  useForm(ctl);
  const formEl = useRef<HTMLFormElement>(null);
  const errEl = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState(false);
  const original = useRef<Vals | null>(null);
  const busyRef = useRef(false);

  // An unsaved draft from last time comes back, except for what the form was opened with.
  useEffect(() => {
    original.current = ctl.values();
    if (!o.draftKey) return;
    const draft = loadDraft(o.draftKey);
    if (draft && o.preset) for (const k of Object.keys(o.preset)) delete draft[k];
    if (draft && JSON.stringify({ ...ctl.draftValues(), ...draft }) !== JSON.stringify(ctl.draftValues())) {
      ctl.set(draft);
      setBanner(true);
    }
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!o.draftKey || !original.current) return;
    const t = setTimeout(() => {
      if (JSON.stringify(ctl.values()) !== (api as any).initial) saveDraft(o.draftKey!, ctl.draftValues());
      else clearDraft(o.draftKey!);
    }, 300);
    return () => clearTimeout(t);
  }, [ctl.version]);  // eslint-disable-line react-hooks/exhaustive-deps

  const doSubmit = async (again: boolean) => {
    if (busyRef.current) return false;
    if (!formEl.current!.reportValidity()) return false;
    busyRef.current = true;
    setBusy(true);
    setErr('');
    try {
      const vals = ctl.values();
      const res = await o.submit(vals, ctl);
      if (o.draftKey) clearDraft(o.draftKey);
      await m.close(true);
      if (o.onDone) await o.onDone(res, { again, vals });
      return true;
    } catch (x) {
      const msg = (x as Error).message;
      setErr('⚠ ' + msg);
      if (!ctl.flag(msg)) setTimeout(() => errEl.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 0);
      toast(`Not saved: ${msg}`, 'bad');
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  api.submit = doSubmit;

  return (
    <form ref={formEl}
      onSubmit={e => { e.preventDefault(); doSubmit(((e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.name === 'again'); }}
      onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doSubmit(false); } }}>
      {banner ? (
        <div className="draft-banner"><span>↩ Restored changes you hadn’t saved.</span>
          <Small label="Discard them" onClick={() => { if (original.current) ctl.set(original.current); clearDraft(o.draftKey!); setBanner(false); }} />
        </div>
      ) : null}
      {o.notice ? <div className="saved-banner">{o.notice}</div> : null}
      {o.top}
      <FormGrid ctl={ctl} />
      {o.extra}
      <div className="actions sticky-actions">
        <div className="form-error" role="alert" ref={errEl}>{err}</div>
        <button type="button" onClick={() => m.close()}>Cancel</button>
        {o.again ? <button type="submit" name="again" disabled={busy}>{o.again.label || 'Save & add another'}</button> : null}
        <button className="primary" type="submit" name="save" disabled={busy}>{o.saveLabel || 'Save'}</button>
      </div>
    </form>
  );
}

export function formDialog(o: FormDialogOpts): { m: ModalCtl; form: FormCtl } {
  const ctl = new FormCtl(o.fields, o.rec || {});
  const api: { submit?: (again: boolean) => Promise<boolean>; initial?: string } = {};
  api.initial = JSON.stringify(ctl.values());
  const dirty = () => JSON.stringify(ctl.values()) !== api.initial;
  const scanBtn = o.scanTargets && o.scanTargets.some(k => ctl.has(k))
    ? <button type="button" className="sm scan-label-btn" onClick={() => scanLabel(ctl, o.scanTargets!)}>📷 Scan label</button>
    : null;
  const m = modal(o.title, mm => <FormDialogBody o={o} ctl={ctl} m={mm} api={api} />, {
    wide: o.wide ?? o.fields.filter(Boolean).length > 9,
    headExtra: <>{o.headButtons ? o.headButtons(ctl) : null}{scanBtn}</>,
    beforeClose: async () => {
      if (!dirty()) { if (o.draftKey) clearDraft(o.draftKey); return true; }
      const c = await choose('Unsaved changes', 'You changed this form. Save before closing?', [
        ['keep', 'Keep editing'], ['discard', 'Discard changes', 'ghost-danger'], ['save', 'Save', 'primary']]);
      if (c === 'save') { api.submit?.(false); return false; }
      if (c === 'discard') { if (o.draftKey) clearDraft(o.draftKey); return true; }
      return false;
    },
  });
  return { m, form: ctl };
}

/* A form right on the page that adds one record and stays open for the next (the setup guide). */
export function QuickForm({ ctl, label, onSubmit }: { ctl: FormCtl; label: string; onSubmit: (vals: Vals) => Promise<void> }) {
  const [err, setErr] = useState('');
  return (
    <form className="quick-add" onSubmit={async e => {
      e.preventDefault();
      if (!(e.currentTarget as HTMLFormElement).reportValidity()) return;
      setErr('');
      try { await onSubmit(ctl.values()); } catch (x) { setErr((x as Error).message); }
    }}>
      <FormGrid ctl={ctl} />
      <div className="form-error" role="alert">{err}</div>
      <div className="actions"><button type="submit" className="primary">{`+ ${label}`}</button></div>
    </form>
  );
}
