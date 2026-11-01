/* Printing: spec and sell sheets (saved as PDF from the print dialog) and QR labels. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { GET } from '../api/client';
import { nz, prefGet, prefSet, type Row } from '../lib/util';
import { modal, toast } from '../ui/overlay';
import { Btn } from '../ui/bits';
import type { Sections } from '../lib/export';
import { loadZXing } from './scan';

export async function qrSvg(text: string, size = 160): Promise<SVGSVGElement> {
  const Z = await loadZXing();
  const hints = new Map([[Z.EncodeHintType.MARGIN, 0]]);
  const svg = new Z.BrowserQRCodeSvgWriter().write(text, size, size, hints);
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);  // so it scales to the label size when printed
  return svg;
}

/* A QR code, drawn once ZXing has loaded. */
export function Qr({ text, size = 160, cls = '' }: { text: string; size?: number; cls?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    qrSvg(text, size).then(svg => { if (live && box.current) box.current.replaceChildren(svg); }).catch(() => setFailed(true));
    return () => { live = false; };
  }, [text, size]);
  return failed ? <span className="muted">QR codes need the scanner library</span> : <div ref={box} className={cls} />;
}

let printRoot: Root | null = null;
function printNode(node: React.ReactNode, pageCss = '') {
  const host = document.getElementById('print-root') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'print-root' }));
  printRoot = printRoot || createRoot(host);
  flushSync(() => printRoot!.render(node));
  const page = document.getElementById('label-page') || document.head.appendChild(Object.assign(document.createElement('style'), { id: 'label-page' }));
  page.textContent = pageCss;
  document.body.classList.add('printing');
  const done = () => { document.body.classList.remove('printing'); page.textContent = ''; window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  setTimeout(() => { window.print(); setTimeout(done, 1500); }, 100);
}

const Item = ({ k, v }: { k: string; v: unknown }) => v == null || v === '' ? null : <div className="ps-row"><span className="ps-k">{k}</span><span className="ps-v">{String(v)}</span></div>;

/* Spec sheet / sell sheet, rendered for the browser's Print → Save as PDF. */
export function printSheet(bundle: Row[], sec: Sections, o: { mode?: string; title?: string; subtitle?: string; condition?: string; footer?: string; prices?: Record<string, string> }) {
  const sell = o.mode === 'sell';
  printNode(
    <div className={'ps' + (sell ? ' sell' : '')}>
      <header className="ps-head">
        <div><h1>{o.title || (sell ? 'Hardware for sale' : 'Hardware spec sheet')}</h1>{o.subtitle ? <p>{o.subtitle}</p> : null}</div>
        <div className="ps-meta">{new Date().toLocaleDateString()}<br />{`${bundle.length} item${bundle.length === 1 ? '' : 's'}`}</div>
      </header>
      {bundle.map(d => {
        const v = d.device;
        const price = o.prices?.[v.id];
        const drives = d.storage.drives ? `${d.storage.total} raw · ${d.storage.groups.map((g: Row) => `${g.count}× ${g.capacity} ${g.category}`).join(', ')}` : (v.storage || null);
        const nics = d.interfaces.filter((i: Row) => i.speed || i.kind).map((i: Row) => [i.kind, i.speed].filter(Boolean).join(' ')).join(', ');
        return (
          <section key={v.id} className="ps-item">
            <div className="ps-item-head">
              <div><h2>{sell && v.model ? nz(v.manufacturer, v.model) : v.name}</h2>
                <div className="ps-sub">{sell ? v.device_type : [v.device_type, nz(v.manufacturer, v.model)].filter(Boolean).join(' · ')}</div></div>
              {price ? <div className="ps-price">{price}</div> : null}
            </div>
            <div className="ps-grid">
              {sec.basics && !sell ? <Item k="Status" v={v.status} /> : null}
              {sec.serial ? <Item k="Serial / service tag" v={v.serial} /> : null}
              {sec.location && !sell ? <Item k="Location" v={[v.location_path, v.rack_name ? `${v.rack_name}${v.rack_u ? ' U' + v.rack_u : ''}` : null].filter(Boolean).join(' · ')} /> : null}
              {sec.hardware ? <Item k="CPU" v={v.cpu} /> : null}{sec.hardware ? <Item k="Memory" v={v.ram} /> : null}
              {sec.storage ? <Item k="Storage" v={drives} /> : null}
              {sec.hardware ? <Item k="Power supply" v={v.psu} /> : null}
              {sec.hardware && !sell ? <Item k="OS" v={v.os} /> : null}
              {sec.network && sell ? <Item k="Networking" v={nics} /> : null}
              {sec.hardware && !sell ? <Item k="Hostname" v={v.hostname} /> : null}
              {sec.purchase && !sell ? <Item k="Warranty until" v={v.warranty_until} /> : null}
              {sell && o.condition ? <Item k="Condition" v={o.condition} /> : null}
            </div>
            {sec.parts && d.components.length ? <div className="ps-list"><h3>Installed parts</h3>
              <ul>{d.components.map((c: Row) => <li key={c.id}>{`${c.quantity > 1 ? c.quantity + ' × ' : ''}${[c.manufacturer, c.model, c.capacity, c.interface].filter(Boolean).join(' · ') || c.category}`}</li>)}</ul></div> : null}
            {sec.network && !sell && d.interfaces.length ? <div className="ps-list"><h3>Network</h3>
              <table><tbody>{d.interfaces.map((i: Row) => <tr key={i.id}><td>{i.name || ''}</td><td>{i.ip || ''}</td><td>{i.mac || ''}</td><td>{i.vlan || i.native_vlan || ''}</td><td>{i.speed || ''}</td></tr>)}</tbody></table></div> : null}
            {sec.services && !sell && d.services.length ? <div className="ps-list"><h3>Services</h3>
              <ul>{d.services.map((s: Row) => <li key={s.id}>{`${s.name}${s.port ? ` (${s.port})` : ''}${s.url ? ` · ${s.url}` : ''}`}</li>)}</ul></div> : null}
            {sec.notes && !sell && d.notes?.some((n: Row) => n.kind === 'note') ? <div className="ps-notes">{d.notes.filter((n: Row) => n.kind === 'note').slice(0, 3).map((n: Row) => n.body).join('\n\n')}</div> : null}
          </section>
        );
      })}
      {o.footer ? <footer className="ps-foot">{o.footer}</footer> : null}
    </div>,
  );
}

/* QR labels in the sizes of common label rolls, or a full sheet (ZomBeatz printing rules:
   QR on the left at least 15 mm wide, the name in bold, 1 or 2 lines of key facts). */
const LABEL_SIZES: [string, string, { w: number; h: number } | null][] = [
  ['62x29', '62 × 29 mm roll (Brother DK-11209 and similar)', { w: 62, h: 29 }],
  ['2x1', '2 × 1 in roll (Dymo, Zebra and similar)', { w: 50.8, h: 25.4 }],
  ['1x1', '1 × 1 in roll (QR code and name only)', { w: 25.4, h: 25.4 }],
  ['sheet', 'Full sheet (A4 or Letter, 2 across)', null],
];
const deviceMainIp = (d: Row) => (d.interfaces.find((i: Row) => i.is_primary && i.ip) || d.interfaces.find((i: Row) => i.ip) || {}).ip || '';

export function printLabels(ids: number[]) {
  function Pick({ close }: { close: () => void }) {
    const [size, setSize] = useState(prefGet('harm-label-size') || '62x29');
    return (
      <div>
        <p>Pick the size of your labels. Each label is printed in light colors, with a QR code that opens the device in HaRM.</p>
        <div className="radio-list">{LABEL_SIZES.map(([k, label]) => (
          <label key={k} className="radio-row"><input type="radio" name="label-size" value={k} checked={k === size} onChange={() => setSize(k)} />{' '}{label}</label>
        ))}</div>
        <div className="actions"><Btn label="Cancel" onClick={close} /><Btn label="Print…" cls="primary" onClick={() => {
          prefSet('harm-label-size', size);
          close();
          doPrintLabels(ids, size).catch(e => toast(e.message, 'bad'));
        }} /></div>
      </div>
    );
  }
  modal(ids.length > 1 ? `Print ${ids.length} labels` : 'Print a label', m => <Pick close={() => m.close(true)} />);
}

async function doPrintLabels(ids: number[], size: string) {
  const bundle: Row[] = await GET('/export/bundle?ids=' + ids.join(','));
  const dims = LABEL_SIZES.find(x => x[0] === size)![2];
  const qrs = await Promise.all(bundle.map(d => qrSvg(`${location.origin}/#/devices/${d.device.id}`, 150)));
  function Labels() {
    const refs = useRef<(HTMLDivElement | null)[]>([]);
    useLayoutEffect(() => { refs.current.forEach((el, i) => el?.replaceChildren(qrs[i])); }, []);
    return (
      <div className={`labels labels-${size}`}>
        {bundle.map((d, i) => {
          const v = d.device;
          const ip = deviceMainIp(d);
          const facts = [nz(v.manufacturer, v.model), ip || (v.serial ? `S/N ${v.serial}` : '')].filter(Boolean).slice(0, 2);
          return (
            <div key={v.id} className="label"><div className="label-qr" ref={el => { refs.current[i] = el; }} />
              <div className="label-text"><b>{v.name}</b>{size === '1x1' ? null : facts.map(f => <div key={f} className={/^[\d.:]+$|^S\/N/.test(f) ? 'mono' : ''}>{f}</div>)}</div>
            </div>
          );
        })}
      </div>
    );
  }
  // Roll labels print one per page at the roll's size; a sheet uses the normal page.
  printNode(<Labels />, dims ? `@page { size: ${dims.w}mm ${dims.h}mm; margin: 0; }` : '');
}
