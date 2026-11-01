/* Scanning labels: barcodes (read on the phone with ZXing) and printed text (read by the server). */
import { useEffect, useRef, useState } from 'react';
import { serverScan } from '../api/client';
import { parseLabel, type Barcode, type Candidate } from '../lib/labels';
import { asset } from '../lib/util';
import { modal, toast, type ModalCtl } from '../ui/overlay';
import { Spinner } from '../ui/bits';
import type { FormCtl } from '../ui/form';

let zxingLoading: Promise<any> | null = null;
export function loadZXing(): Promise<any> {
  if (window.ZXing) return Promise.resolve(window.ZXing);
  zxingLoading = zxingLoading || new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = asset('vendor/zxing-0.23.0.min.js');
    s.onload = () => resolve(window.ZXing);
    s.onerror = () => { zxingLoading = null; reject(new Error('Could not load the barcode reader')); };
    document.head.append(s);
  });
  return zxingLoading;
}

function zxDecode(Z: any, canvas: HTMLCanvasElement): Barcode | null {
  const hints = new Map([[Z.DecodeHintType.TRY_HARDER, true]]);
  const reader = new Z.MultiFormatReader();
  reader.setHints(hints);
  try {
    const r = reader.decode(new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(canvas))), hints);
    return { format: Z.BarcodeFormat[r.getBarcodeFormat()] || 'barcode', value: r.getText() };
  } catch { return null; }
}

/* Labels often carry several stacked barcodes; decode the whole image and strips of it. */
function zxDecodeAll(Z: any, canvas: HTMLCanvasElement) {
  const found = new Map<string, Barcode>();
  const regions = [[0, 0, 1, 1]];
  for (const n of [2, 3, 4]) for (let i = 0; i < n; i++) regions.push([0, i / n, 1, 1 / n]);
  regions.push([0, 0, 0.5, 1], [0.5, 0, 0.5, 1]);
  const tmp = document.createElement('canvas');
  for (const [x, y, w, hh] of regions) {
    const sw = Math.round(canvas.width * w), sh = Math.round(canvas.height * hh);
    tmp.width = sw; tmp.height = sh;
    tmp.getContext('2d')!.drawImage(canvas, Math.round(canvas.width * x), Math.round(canvas.height * y), sw, sh, 0, 0, sw, sh);
    const r = zxDecode(Z, tmp);
    if (r && !found.has(r.value)) found.set(r.value, r);
  }
  return [...found.values()];
}

export async function photoToCanvas(file: Blob, maxSide = 2000) {
  let src: ImageBitmap | HTMLImageElement;
  try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch {
    src = await new Promise<HTMLImageElement>((resolve, reject) => {
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
  c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

export interface ScanTarget { k: string; label: string }
interface ScanOpts { title?: string; targets: ScanTarget[]; onPick: (k: string, v: string) => void; single?: boolean }

function Scanner({ o, m }: { o: ScanOpts; m: ModalCtl }) {
  const { targets, onPick, single = false } = o;
  const canLive = window.isSecureContext && !!navigator.mediaDevices && 'getUserMedia' in navigator.mediaDevices;
  const video = useRef<HTMLVideoElement>(null);
  const finder = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const stopLive = useRef<(() => void) | null>(null);
  const [status, setStatus] = useState<React.ReactNode>('');
  const [live, setLive] = useState(false);
  const [hint, setHint] = useState('Hold one barcode inside the box');
  const [barcodes, setBarcodes] = useState<Barcode[]>([]);
  const [text, setText] = useState('');
  const [manual, setManual] = useState<Candidate[]>([]);
  const [applied, setApplied] = useState<Record<string, string>>({});
  const [newest, setNewest] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const codes = useRef<Barcode[]>([]);
  codes.current = barcodes;

  const pick = (k: string, label: string, value: string) => {
    onPick(k, value);
    setApplied(a => ({ ...a, [k]: value }));
    toast(`${label} set`);
    if (single) m.close(true);
  };
  const useWord = (w: string) => {
    if (single) return pick(targets[0].k, targets[0].label, w);
    setManual(list => list.some(c => c.value === w) ? list : [{ value: w, guess: null, source: 'picked' }, ...list]);
    setNewest(w);
  };
  const mergeServer = (r: { barcodes: Barcode[]; text: string }) => {
    setBarcodes(list => [...list, ...r.barcodes.filter(b => !list.some(x => x.value === b.value)).map(b => ({ format: b.format, value: b.value }))]);
    setText(t => [t, r.text].filter(Boolean).join('\n'));
  };

  const readText = async () => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement('canvas');
    const scale = Math.min(1, 2000 / v.videoWidth);
    c.width = v.videoWidth * scale; c.height = v.videoHeight * scale;
    c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
    setReading(true);
    setStatus(<><Spinner /> Reading the text in view…</>);
    try {
      const r = await serverScan(c);
      mergeServer(r);
      setStatus(r.ocr ? 'Read. Tap the words or values you want below. Move closer and tap again for more.' : 'Text reading isn’t installed on the server (tesseract).');
    } catch (e) { setStatus((e as Error).message); }
    setReading(false);
  };

  const startLive = async () => {
    setStatus('Starting camera…');
    try {
      const Z = await loadZXing();
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      const v = video.current!;
      v.srcObject = stream;
      setLive(true);
      await v.play();
      setStatus('Barcodes are picked up automatically, and each one is listed below. For printed text (no barcode), tap “Read text”.');
      const c = document.createElement('canvas');
      let stopped = false;
      const loop = () => {
        if (stopped) return;
        if (v.videoWidth) {
          const scale = Math.min(1, 1280 / v.videoWidth);
          c.width = v.videoWidth * scale; c.height = v.videoHeight * scale;
          c.getContext('2d', { willReadFrequently: true })!.drawImage(v, 0, 0, c.width, c.height);
          const r = zxDecode(Z, c);
          if (r && !codes.current.some(b => b.value === r.value)) {
            codes.current = [...codes.current, r];
            setBarcodes(codes.current);
            setNewest(r.value);
            if (navigator.vibrate) navigator.vibrate(60);
            const f = finder.current;
            if (f) { f.classList.remove('hit'); void f.offsetWidth; f.classList.add('hit'); }
            setHint('Got one! Aim at the next barcode, or pick from the list below.');
          }
        }
        setTimeout(loop, 180);
      };
      loop();
      stopLive.current = () => { stopped = true; stream.getTracks().forEach(t => t.stop()); setLive(false); };
    } catch (e) {
      const err = e as Error;
      setStatus((err.name === 'NotAllowedError' ? 'Camera permission was denied. ' : `Camera unavailable (${err.message}). `) + 'Use “Take photo” instead.');
    }
  };

  const onFile = async () => {
    const file = fileInput.current!.files?.[0];
    fileInput.current!.value = '';
    if (!file) return;
    if (stopLive.current) { stopLive.current(); stopLive.current = null; }
    setStatus(<><Spinner /> Reading barcodes and text…</>);
    try {
      const canvas = await photoToCanvas(file);
      const [client, server] = await Promise.allSettled([loadZXing().then(Z => zxDecodeAll(Z, canvas)), serverScan(canvas)]);
      if (client.status === 'fulfilled') setBarcodes(list => [...list, ...client.value.filter(b => !list.some(x => x.value === b.value))]);
      if (server.status === 'fulfilled') mergeServer(server.value);
      const notes = [];
      if (server.status === 'fulfilled' && !server.value.ocr) notes.push('Text recognition is not installed on the server (install tesseract), so only barcodes were read.');
      if (server.status === 'rejected') notes.push('The server could not read the photo; showing what the phone decoded.');
      setStatus(notes.join(' ') || 'Done. Pick values below, or take another photo to add more.');
    } catch (e) { setStatus((e as Error).message); }
  };

  useEffect(() => {
    m.onClose = () => { stopLive.current?.(); };
    if (canLive && window.matchMedia('(pointer: coarse)').matches) startLive();
    return () => { stopLive.current?.(); };
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  const parsed = parseLabel(barcodes, text);
  const candidates = [...manual, ...parsed.candidates.filter(c => !manual.some(x => x.value === c.value))];
  const lines = parsed.lines;
  const suggested = single ? [] : candidates.filter(c => c.guess && targets.some(t => t.k === c.guess));
  const words = [...new Set(lines.join(' ').split(/\s+/).map(w => w.replace(/^[^\w]+|[^\w]+$/g, '')).filter(w => w.length >= 3))]
    .filter(w => !candidates.some(c => c.value === w)).slice(0, 80);
  const fillAll = () => {
    const done = new Set<string>();
    for (const c of suggested) if (!done.has(c.guess!)) { onPick(c.guess!, c.value); done.add(c.guess!); }
    toast(`Filled ${done.size} fields`);
    m.close(true);
  };
  const n = barcodes.length;

  return (
    <div className="scanner">
      <ol className="scan-howto">
        <li>{canLive ? 'Live camera picks up barcodes and QR codes automatically. “Read text” reads printed text.' : 'Take a photo of the label; HaRM reads its barcodes and printed text.'}</li>
        <li>Everything found is listed below, with a best guess at what each value is.</li>
        <li>{single ? 'Tap “Use this” on the right one.' : 'Tap which box each value goes in, or “Fill all”.'}</li>
      </ol>
      <div className="scan-buttons">
        <button type="button" className="primary" onClick={startLive} hidden={!canLive || live}>🎥 Live camera</button>
        <button type="button" className={canLive ? '' : 'primary'} onClick={() => fileInput.current?.click()}>📸 Take or choose photo</button>
        <input ref={fileInput} type="file" accept="image/*" capture="environment" hidden onChange={onFile} />
      </div>
      {canLive ? null : <p className="muted small">Live camera needs HTTPS (see Help &gt; Phone &amp; scanning). Photo mode works everywhere.</p>}
      <div className="viewfinder" hidden={!live} ref={finder}>
        <video ref={video} className="scan-video" playsInline muted />
        <div className="vf-frame" />
        <div className="vf-hint">{hint}</div>
        <div className="vf-count">{n ? `✓ ${n} code${n === 1 ? '' : 's'} found` : ''}</div>
        <button type="button" className="vf-text-btn" disabled={reading} onClick={readText}>📝 Read text</button>
      </div>
      <div className="scan-status muted small">{status}</div>
      <div className="scan-results">
        {!candidates.length && !lines.length ? null : <>
          {suggested.length > 1 ? (
            <button type="button" className="primary block" onClick={fillAll}>
              {`✓ Fill all ${new Set(suggested.map(c => c.guess)).size} highlighted suggestions`}
            </button>
          ) : null}
          {candidates.length ? (
            <div>
              <h4>{single ? 'Tap “Use this” on the right value' : 'Tap which box each value belongs in'}</h4>
              {candidates.map(c => {
                const src = c.source === 'text' ? 'printed text' : c.source === 'picked' ? 'you picked' : `barcode · ${String(c.source).replace(/_/g, '-').toLowerCase()}`;
                const harm = /#\/devices\/(\d+)/.exec(c.value);
                return (
                  <div key={c.value} className={'cand' + (c.value === newest ? ' new' : '')}>
                    <div className="cand-val"><code>{c.value}</code><span className="badge muted">{src}</span>
                      {c.guess && !single ? <span className="muted small">{`looks like: ${targets.find(t => t.k === c.guess)?.label || c.guess}`}</span> : null}
                    </div>
                    <div className="cand-actions">
                      {harm ? <button type="button" className="sm primary" onClick={() => { m.close(true); location.hash = `#/devices/${harm[1]}`; }}>→ Open this device</button> : null}
                      {targets.map(t => {
                        const on = applied[t.k] === c.value;
                        return <button key={t.k} type="button" className={'sm ' + (on ? 'applied' : (c.guess === t.k ? 'primary' : ''))}
                          onClick={() => pick(t.k, t.label, c.value)}>{on ? `✓ ${t.label}` : (single ? 'Use this' : t.label)}</button>;
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : <p className="muted">Nothing that looks like an ID yet. Try closer, with more light, or tap a word below.</p>}
          {words.length ? (
            <div className="word-chips"><h4>Other text on the label (tap one to use it)</h4>
              <div className="chips">{words.map(w => <button key={w} type="button" className="chip mono" onClick={() => useWord(w)}>{w}</button>)}</div>
            </div>
          ) : null}
        </>}
      </div>
      <div className="actions"><button type="button" onClick={() => m.close(true)}>Done</button></div>
    </div>
  );
}

export function scanDialog(o: ScanOpts) {
  return modal(o.title || 'Scan label', m => <Scanner o={o} m={m} />);
}

/* Fill several fields of an open form from one label. */
export function scanLabel(form: FormCtl, keys: string[]) {
  const targets = keys.filter(k => form.has(k)).map(k => ({ k, label: (form.field(k)!.label || k).replace(/ \(.*\)$/, '') }));
  if (!targets.length) return;
  scanDialog({ title: 'Scan label', targets, onPick: (k, v) => form.set({ [k]: v }) });
}
