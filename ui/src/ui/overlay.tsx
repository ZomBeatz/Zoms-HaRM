/* Toasts and dialogs. Both can be opened from anywhere (a save handler, a menu) without a
 * component around them, so they live in small stores and are drawn by <Overlays/>. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';

// ---------------------------------------------------------------- toasts

interface Toast { id: number; msg: ReactNode; kind: string; action: { label: string; onClick: () => void } | null; out: boolean }
const useToasts = create<{ list: Toast[] }>(() => ({ list: [] }));
let toastId = 0;

export function toast(msg: ReactNode, kind = 'ok', action: Toast['action'] = null) {
  const id = ++toastId;
  useToasts.setState(s => ({ list: [...s.list, { id, msg, kind, action, out: false }] }));
  const life = action ? 7000 : 2600;
  const drop = () => useToasts.setState(s => ({ list: s.list.filter(t => t.id !== id) }));
  setTimeout(() => useToasts.setState(s => ({ list: s.list.map(t => t.id === id ? { ...t, out: true } : t) })), life);
  setTimeout(drop, life + 500);
}

function Toasts() {
  const list = useToasts(s => s.list);
  const host = document.getElementById('toasts');
  if (!host) return null;
  const drop = (id: number) => useToasts.setState(s => ({ list: s.list.filter(t => t.id !== id) }));
  return createPortal(list.map(t => (
    <div key={t.id} className={`toast ${t.kind}${t.out ? ' out' : ''}`}>
      <span>{t.msg}</span>
      {t.action ? <button type="button" className="sm toast-action" onClick={() => { drop(t.id); t.action!.onClick(); }}>{t.action.label}</button> : null}
    </div>
  )), host);
}

export async function copy(text: string, what = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(`${what} to clipboard`); }
  catch { toast('Clipboard unavailable (needs HTTPS or localhost)', 'bad'); }
}

// ---------------------------------------------------------------- dialogs

export interface ModalOptions {
  wide?: boolean;
  cls?: string;
  headExtra?: ReactNode;
  /* Can veto a close the user started with ✕, Escape or a backdrop click; close(true) always closes. */
  beforeClose?: () => Promise<boolean> | boolean;
  /* No ✕ (the recovery code must be acknowledged). */
  noClose?: boolean;
}
export interface ModalCtl {
  id: number;
  close: (force?: boolean) => Promise<void>;
  onClose: (() => void) | null;
  /* The dialog's box, once it's drawn. */
  box: HTMLDivElement | null;
}
interface Entry { ctl: ModalCtl; title: ReactNode; body: ReactNode | ((m: ModalCtl) => ReactNode); opts: ModalOptions }
const useModals = create<{ list: Entry[] }>(() => ({ list: [] }));
let modalId = 0;

const syncBodyClass = (open: boolean) => {
  document.body.classList.toggle('modal-open', open);  // the page behind must not scroll
  document.documentElement.classList.toggle('modal-open', open);
};

export function modal(title: ReactNode, body: Entry['body'], opts: ModalOptions = {}): ModalCtl {
  let closing = false;
  const ctl: ModalCtl = {
    id: ++modalId, onClose: null, box: null,
    async close(force = false) {
      if (closing || !useModals.getState().list.some(e => e.ctl === ctl)) return;
      if (!force && opts.beforeClose) {
        closing = true;
        const ok = await opts.beforeClose();
        closing = false;
        if (!ok) return;
      }
      useModals.setState(s => ({ list: s.list.filter(e => e.ctl !== ctl) }));
      syncBodyClass(useModals.getState().list.length > 0);
      ctl.onClose?.();
    },
  };
  useModals.setState(s => ({ list: [...s.list, { ctl, title, body, opts }] }));
  syncBodyClass(true);
  return ctl;
}
export const closeAllModals = () => { useModals.setState({ list: [] }); syncBodyClass(false); };
export const anyModalOpen = () => useModals.getState().list.length > 0;

function ModalView({ entry, top }: { entry: Entry; top: boolean }) {
  const { ctl, title, body, opts } = entry;
  const box = useRef<HTMLDivElement>(null);
  const downOnBack = useRef(false);
  useEffect(() => {
    ctl.box = box.current;
    if (window.matchMedia('(min-width: 861px)').matches) {
      setTimeout(() => box.current?.querySelector<HTMLElement>('.modal-body input:not([type=checkbox]):not([type=file]), .modal-body select, .modal-body textarea, .modal-body button.primary')?.focus(), 0);
    }
  }, [ctl]);
  useEffect(() => {
    if (!top) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); ctl.close(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [top, ctl]);
  return (
    <div className="modal-back"
      onMouseDown={e => { downOnBack.current = e.target === e.currentTarget; }}
      onClick={e => { if (downOnBack.current && e.target === e.currentTarget && top) ctl.close(); }}>
      <div ref={box} className={`modal ${opts.wide ? 'wide' : ''} ${opts.cls || ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2>{title}</h2>
          <div className="modal-head-actions">
            {opts.headExtra}
            {opts.noClose ? null : <button className="icon-btn" type="button" aria-label="Close" onClick={() => ctl.close()}>✕</button>}
          </div>
        </div>
        <div className="modal-body">{typeof body === 'function' ? body(ctl) : body}</div>
      </div>
    </div>
  );
}

function Modals() {
  const list = useModals(s => s.list);
  return createPortal(list.map((e, i) => <ModalView key={e.ctl.id} entry={e} top={i === list.length - 1} />), document.body);
}

/* Ask the user to pick one of several buttons. Resolves to the chosen key (or null). */
export function choose(title: ReactNode, message: ReactNode, buttons: [string, string, string?][]): Promise<string | null> {
  return new Promise(resolve => {
    let done = false;
    const finish = (v: string | null) => { if (!done) { done = true; m.close(true); resolve(v); } };
    const m = modal(title, (
      <div>
        <p>{message}</p>
        <div className="actions">
          {buttons.map(([key, label, cls]) => <button key={key} type="button" className={cls || ''} onClick={() => finish(key)}>{label}</button>)}
        </div>
      </div>
    ), { beforeClose: () => { finish(null); return true; } });
  });
}

export async function confirmBox(msg: ReactNode, okLabel = 'Delete') {
  return (await choose('Are you sure?', msg, [['no', 'Cancel'], ['yes', okLabel, 'danger']])) === 'yes';
}

/* A dialog that redraws itself: body gets the dialog and a redraw function. */
export function useRedraw() {
  const [, set] = useState(0);
  return () => set(n => n + 1);
}

export function Overlays() {
  return <><Modals /><Toasts /></>;
}
