/* AI Assist: photos to inventory with any AI chat. HaRM writes the prompt, the AI identifies and
 * prices the hardware, and its reply comes back here for a preview before anything is saved. */
import { useEffect, useRef, useState } from 'react';
import { api, GET, loadLookups, UNREACHABLE } from '../api/client';
import { S, aiOn, rerender } from '../lib/state';
import { locDescendants, locPath } from '../lib/lookups';
import { money, type Row } from '../lib/util';
import { modal, toast } from '../ui/overlay';
import { A, Btn, Card, Small } from '../ui/bits';
import { photoToCanvas, scanDialog } from './scan';
import { showAuth } from '../app/session';

export async function aiAssist(preset: Row = {}) {
  if (!aiOn()) { toast('AI features are turned off in Settings > AI Assist.', 'bad'); return; }
  try {
    const cfg = await GET('/ai/config');
    const p = cfg.providers[cfg.provider];
    let host = '';
    try { host = new URL(cfg.base_url).host; } catch { /* not set */ }
    S.aiConf = p ? (cfg.provider === 'compatible'
      ? { provider: cfg.provider, label: `your AI service${host ? ` at ${host}` : ''}`, short: 'your AI' }
      : { provider: cfg.provider, label: p.label, short: p.label.split(' (')[0] }) : null;
  } catch { S.aiConf = null; }
  const st = S.ai = Object.assign(S.ai || { hint: '', reply: '' }, preset.location_id || preset.rack_id
    ? { location_id: preset.location_id || null, rack_id: preset.rack_id || null, position: preset.position || '' } : {});
  modal('🤖 AI Assist: photos to inventory', <AiAssist st={st} />, { wide: true });
}

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => <label className="disc-field"><span>{label}</span>{children}</label>;

function Preview({ r, st, done }: { r: Row; st: Row; done: (res: Row) => void }) {
  const [rows, setRows] = useState(() => r.items.map((it: Row) => ({ it: { ...it }, on: !it.duplicate })));
  const [tasks, setTasks] = useState(true);
  const [notes, setNotes] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const n = rows.filter((x: Row) => x.on).length;
  const upd = (i: number, patch: Row) => setRows((list: Row[]) => list.map((x, j) => j === i ? { ...x, it: { ...x.it, ...patch } } : x));
  const conf = (c: string) => <span className={`badge ${c === 'high' ? 'ok' : c === 'low' ? 'warn' : 'info'}`}>{c}</span>;
  const add = async () => {
    setBusy(true);
    try {
      const res = await api('POST', '/ai/import', {
        items: rows.filter((x: Row) => x.on).map((x: Row) => x.it), batch_todo: r.todo, location_id: st.location_id, rack_id: st.rack_id,
        position: st.position, device_status: st.device_status || 'Spare', tasks, notes,
      });
      st.reply = '';
      await loadLookups();
      done(res);
      rerender();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <div>
      <h4>4. Check and add</h4>
      {r.summary ? <p className="muted">{r.summary}</p> : null}
      {r.warnings.map((w: string, i: number) => <div key={i} className="notice">{w}</div>)}
      <div className="table-wrap"><table className="ai-table">
        <thead><tr>{['', 'Kind', 'Item', 'Serial', 'Qty', 'Value', 'To-do'].map((t, i) => <th key={i}>{t}</th>)}</tr></thead>
        <tbody>{rows.map(({ it, on }: Row, i: number) => {
          const specs = it.kind === 'device'
            ? [it.device_type, it.cpu, it.ram, it.storage].filter(Boolean).join(' · ')
            : [it.category, it.capacity, it.interface, it.form_factor, it.speed].filter(Boolean).join(' · ');
          const value = [it.msrp ? `new ${money(it.msrp)}` : '', it.market_value ? `now ${money(it.market_value)}` : ''].filter(Boolean).join(' → ');
          return (
            <tr key={i} className={it.duplicate ? 'dup' : ''}>
              <td><input type="checkbox" checked={on} onChange={e => setRows((list: Row[]) => list.map((x, j) => j === i ? { ...x, on: e.target.checked } : x))} /></td>
              <td><span className="badge muted">{it.kind === 'device' ? 'Device' : 'Part'}</span> {conf(it.confidence)}</td>
              <td className="ai-name"><input value={it.name} aria-label="Name" onChange={e => upd(i, { name: e.target.value })} />
                <div className="muted small">{specs || 'None'}</div>
                {it.duplicate ? <div className="warn-text small">Already in HaRM: <A href={it.duplicate.link}>{it.duplicate.name}</A></div> : null}</td>
              <td><div className="inline nowrap"><input value={it.serial || ''} className="mono" placeholder="serial" aria-label="Serial" onChange={e => upd(i, { serial: e.target.value })} />
                <Small label="📷" cls="ghost" onClick={() => scanDialog({ title: `Scan serial: ${it.name}`, single: true, targets: [{ k: 'serial', label: 'Serial' }], onPick: (_k, v) => upd(i, { serial: v }) })} /></div>
                {it.part_number ? <div className="muted small mono">{`P/N ${it.part_number}`}</div> : null}</td>
              <td>{it.kind === 'part' ? <input type="number" min={1} value={it.quantity} className="qty-in" aria-label="Quantity"
                onChange={e => upd(i, { quantity: Math.max(1, parseInt(e.target.value, 10) || 1) })} /> : ''}</td>
              <td className="small">{value || <span className="muted">None</span>}{it.sources.length ? <div className="muted">{`${it.sources.length} source${it.sources.length > 1 ? 's' : ''}`}</div> : null}</td>
              <td className="small">{it.todo.length ? <span title={it.todo.join('\n')}>{`☐ ${it.todo.length}`}</span> : ''}</td>
            </tr>
          );
        })}</tbody>
      </table></div>
      {r.todo.length ? <div className="notice"><b>To-do for the batch: </b>{r.todo.join(' · ')}</div> : null}
      <div className="form-error">{err}</div>
      <div className="ai-foot">
        <label className="check inline-check"><input type="checkbox" checked={tasks} onChange={e => setTasks(e.target.checked)} />Turn the AI’s to-dos into tasks</label>
        <label className="check inline-check"><input type="checkbox" checked={notes} onChange={e => setNotes(e.target.checked)} />Save its research (values, sources, labels) as notes</label>
        <span className="muted small"><b>{`${n} of ${rows.length}`}</b> ticked</span>
        <button type="button" className="primary" disabled={!n || busy} onClick={add}>{`Add ${n} item${n === 1 ? '' : 's'}`}</button>
      </div>
    </div>
  );
}

function AiAssist({ st }: { st: Row }) {
  const [, redraw] = useState(0);
  const set = (patch: Row) => { Object.assign(st, patch); redraw(n => n + 1); };
  const [err, setErr] = useState('');
  const [preview, setPreview] = useState<Row | null>(null);
  const [added, setAdded] = useState<Row | null>(null);
  const [prompt, setPrompt] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const [asking, setAsking] = useState(false);
  const [askStatus, setAskStatus] = useState('');
  const promptDetails = useRef<HTMLDetailsElement>(null);
  const promptBox = useRef<HTMLTextAreaElement>(null);
  const manual = useRef<HTMLDetailsElement>(null);
  const fileIn = useRef<HTMLInputElement>(null);
  const conf = S.aiConf;
  const lid = +st.location_id || null;
  const racks = S.lk.racks.filter(r => !lid || locDescendants(lid).has(r.location_id!));

  const read = async (text = st.reply) => {
    setErr('');
    try { setPreview(await api('POST', '/ai/parse', { text })); setAdded(null); }
    catch (e) { setErr((e as Error).message); setPreview(null); }
  };
  useEffect(() => { if (String(st.reply || '').trim()) read(); }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  const copyPrompt = async () => {
    setErr('');
    try {
      const r = await api('POST', '/ai/prompt', { hint: st.hint, location_id: st.location_id, rack_id: st.rack_id, position: st.position });
      setPrompt(r.prompt);
      try { await navigator.clipboard.writeText(r.prompt); toast('Prompt copied. Paste it into your AI app with your photos.'); }
      catch { if (promptDetails.current) promptDetails.current.open = true; setTimeout(() => promptBox.current?.select(), 0); toast('Select the prompt below and copy it', 'bad'); }
    } catch (e) { setErr((e as Error).message); }
  };
  const ask = async () => {
    if (!photos.length) return toast('Add a photo first', 'bad');
    setErr(''); setAsking(true);
    setAskStatus(`Asking ${conf!.label}… this can take a minute while it searches for prices.`);
    let failed = false;
    try {
      const resp = await fetch('/api/ai/ask', { method: 'POST', credentials: 'same-origin', headers: { 'X-HaRM': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ images: photos, hint: st.hint, location_id: st.location_id, rack_id: st.rack_id, position: st.position }) });
      const data = await resp.json().catch(() => ({}));
      if (resp.status === 401) { showAuth('Your session ended. Please unlock again.'); return; }
      if (data.raw) set({ reply: data.raw });
      if (!resp.ok) {
        failed = true;
        setErr(data.detail || resp.statusText);
        if (data.raw && manual.current) manual.current.open = true;
      } else { setAskStatus(data.web ? '✓ Answered, with web search' : '✓ Answered'); setPreview(data); setAdded(null); }
    } catch { failed = true; setErr(UNREACHABLE()); }
    setAsking(false);
    if (failed) setAskStatus('');
  };

  return (
    <div className="ai-assist">
      <p className="muted">Take photos of your hardware (labels visible if you can), let any AI app identify it and look up what it’s worth, then bring the results back here. Nothing is saved until you press Add.</p>
      <h4>1. Where is it? (optional)</h4>
      <div className="grid three">
        <Field label="Location"><select id="ai-loc" value={st.location_id || ''} onChange={e => {
          const l = +e.target.value || null;
          const keep = st.rack_id && S.lk.racks.some(r => r.id === st.rack_id && (!l || locDescendants(l).has(r.location_id!)));
          set({ location_id: l, rack_id: keep ? st.rack_id : null });
        }}><option value="">Not set</option>{S.lk.locations.map(l => <option key={l.id} value={l.id}>{locPath(l.id)}</option>)}</select></Field>
        <Field label="Holder"><select id="ai-rack" value={racks.some(r => r.id === st.rack_id) ? st.rack_id : ''} onChange={e => {
          const id = +e.target.value || null;
          const r = S.lk.racks.find(x => x.id === id);
          set({ rack_id: id, ...(r && r.location_id && !st.location_id ? { location_id: r.location_id } : {}) });
        }}><option value="">Loose in the room</option>{racks.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
        <Field label="Spot"><input id="ai-pos" value={st.position || ''} placeholder="Top shelf, bin 4…" onChange={e => set({ position: e.target.value })} /></Field>
      </div>
      <div className="grid two">
        <Field label="Hint for the AI"><textarea id="ai-hint" rows={2} value={st.hint} onChange={e => set({ hint: e.target.value })}
          placeholder="Optional: what is this? e.g. “drives pulled from the R515s”, “box of RAM from a recycler”" /></Field>
        <Field label="New devices are marked"><select id="ai-status" value={st.device_status || 'Spare'} onChange={e => set({ device_status: e.target.value })}>
          {S.enums.device_statuses.map(s => <option key={s} value={s}>{s}</option>)}</select></Field>
      </div>
      <h4>2. Get the AI’s answer</h4>
      <div className="ai-direct">
        {conf?.provider ? <>
          <div className="inline"><Btn label="📷 Add photos" onClick={() => fileIn.current?.click()} />
            <Btn label={`🤖 Ask ${conf.short}`} onClick={ask} cls="primary" disabled={asking} /><span className="muted small">{askStatus}</span></div>
          <input ref={fileIn} type="file" accept="image/*" multiple hidden onChange={async e => {
            const files = [...(e.target.files || [])].slice(0, 10 - photos.length);
            const out: string[] = [];
            for (const f of files) { try { out.push((await photoToCanvas(f, 1600)).toDataURL('image/jpeg', 0.85)); } catch (x) { toast((x as Error).message, 'bad'); } }
            e.target.value = '';
            setPhotos(p => [...p, ...out]);
          }} />
          <div className="ai-thumbs">{photos.map((p, i) => (
            <div key={i} className="ai-thumb"><img src={p} alt={`Photo ${i + 1}`} />
              <button type="button" className="ai-x" aria-label="Remove photo" onClick={() => setPhotos(list => list.filter((_, j) => j !== i))}>✕</button></div>
          ))}</div>
          <p className="muted small">{`Photos go to ${conf.label}. Up to 10 at a time; they’re shrunk first to keep it quick and cheap.`}</p>
        </> : <p className="muted small">Want to skip the copy &amp; paste? Pick an AI service in <A href="#/settings">Settings &gt; AI Assist</A> to send photos straight from here.</p>}
      </div>
      <details className="ai-manual" ref={manual} open={!conf?.provider || !!String(st.reply || '').trim()}>
        <summary>{conf?.provider ? 'Or copy & paste with any AI app' : 'Copy & paste with any AI app (ChatGPT, Claude, Gemini…)'}</summary>
        <div className="inline"><Btn label="📋 Copy prompt" onClick={copyPrompt} cls="primary" />
          <span className="muted small">Paste it into your AI app and attach your photos. Turn on web search so it can look up prices.</span></div>
        <details className="ai-prompt" ref={promptDetails}><summary>See the prompt</summary>
          <textarea ref={promptBox} rows={8} readOnly className="mono small" value={prompt} /></details>
        <p><b>Then paste the AI’s whole reply:</b></p>
        <textarea id="ai-reply" rows={6} className="mono" spellCheck={false} value={st.reply} onChange={e => set({ reply: e.target.value })}
          placeholder="Paste the AI’s whole reply here (it starts with {&quot;harm_ai&quot;…)" />
        <div className="actions"><Btn label="Read reply" onClick={() => read()} cls="primary" /></div>
      </details>
      <div className="form-error">{err}</div>
      {added ? (
        <div className="notice ok-notice"><b>{`✓ Added ${added.created.length} item${added.created.length === 1 ? '' : 's'}`}</b>
          {added.tasks ? <>{` and ${added.tasks} task${added.tasks === 1 ? '' : 's'} · `}<A href="#/tasks">See tasks</A></> : ''}
          <ul className="plain">{added.created.map((c: Row, i: number) => <li key={i}><A href={c.link}>{c.name}</A></li>)}</ul>
        </div>
      ) : preview ? <Preview key={JSON.stringify(preview).length} r={preview} st={st} done={res => { setAdded(res); set({ reply: '' }); }} /> : null}
    </div>
  );
}

/* Settings > AI Assist: which AI service the built-in photo mode uses. */
export function AiSettingsCard() {
  const [cfg, setCfg] = useState<Row | null>(null);
  const [err, setErr] = useState('');
  const [prov, setProv] = useState('');
  const [key, setKey] = useState('');
  const [model, setModel] = useState('');
  const [base, setBase] = useState('');
  const [web, setWeb] = useState(false);
  useEffect(() => {
    GET('/ai/config').then(c => { setCfg(c); setProv(c.provider); setModel(c.model); setBase(c.base_url); setWeb(!!c.web); }).catch(e => setErr(e.message));
  }, []);
  if (err) return <Card title="AI service"><div className="form-error">{err}</div></Card>;
  if (!cfg) return <Card title="AI service"><div className="muted">Loading…</div></Card>;
  const P = cfg.providers;
  const p = P[prov];
  const save = async (extra: Row = {}) => {
    try {
      const r = await api('POST', '/ai/config', { provider: prov, model, base_url: base, web, api_key: key, ...extra });
      setCfg({ ...cfg, ...r });
      setKey('');
      toast(prov ? `AI Assist will use ${P[prov].label}` : 'Built-in AI Assist is off');
    } catch (e) { toast((e as Error).message, 'bad'); }
  };
  const row = (label: string, el: React.ReactNode, help?: string, hidden = false) =>
    <label className="disc-field" hidden={!p || hidden}><span>{label}</span>{el}{help ? <small className="muted">{help}</small> : null}</label>;
  return (
    <Card title="AI service">
      <p className="muted">Lets 🤖 AI Assist send your photos straight to an AI service and fill in the results. Without one, you can still copy the prompt into any AI app.</p>
      <label className="disc-field"><span>AI service</span>
        <select id="ai-provider" value={prov} onChange={e => setProv(e.target.value)}>
          <option value="">Off (copy &amp; paste only)</option>
          {Object.entries(P).map(([k, x]: [string, any]) => <option key={k} value={k}>{x.label}</option>)}
        </select></label>
      {row('API key', <div className="inline"><input id="ai-key" type="password" autoComplete="off" value={key} onChange={e => setKey(e.target.value)}
        placeholder={p ? (cfg.has_key[prov] ? 'Saved in the vault (leave blank to keep it)' : (p.key ? 'Paste your API key' : 'Only if the service needs one')) : ''} />
        {p?.keys_url ? <a target="_blank" rel="noopener noreferrer" href={p.keys_url}>Get an API key ↗</a> : null}</div>,
        'Stored encrypted in your vault. Usage is billed by the service, usually a few cents per batch of photos.')}
      {row('Model', <input id="ai-model" value={model} placeholder={p?.model || 'e.g. llava, qwen2.5vl, gpt-4o'} onChange={e => setModel(e.target.value)} />,
        'Leave blank for the recommended one. It must be able to see images.')}
      {row('Service address', <input id="ai-base" value={base} placeholder="http://localhost:11434/v1" inputMode="url" onChange={e => setBase(e.target.value)} />,
        'Ollama: http://localhost:11434/v1 · LM Studio: http://localhost:1234/v1 · OpenRouter: https://openrouter.ai/api/v1', prov !== 'compatible')}
      {row('', <span className="inline"><input type="checkbox" checked={web} onChange={e => setWeb(e.target.checked)} />Let it search the web for prices and specs</span>, undefined, !p?.web)}
      <div className="inline"><Btn label="Save" onClick={() => save()} cls="primary" />
        {p && cfg.has_key[prov] ? <Small label="Remove saved key" onClick={() => save({ clear_key: true, api_key: '' })} cls="ghost-danger" /> : null}</div>
      <p className="muted small">Photos you send go to the service you pick (a local Ollama or LM Studio keeps them on your network). Logins and other secrets are never sent.</p>
    </Card>
  );
}
