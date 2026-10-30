// The online demo's "server": HaRM's own Python code running in Pyodide, in a background worker.
// demo-boot.js sends it the page's /api/ requests; changes are saved in this browser (IndexedDB).
const PYODIDE = 'https://cdn.jsdelivr.net/pyodide/v314.0.7/full/';

const say = (text) => postMessage({ type: 'progress', text });

// ---- IndexedDB: one record holding the demo database (and which build it came from)
const idb = () => new Promise((ok, fail) => {
  const r = indexedDB.open('harm-demo', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => ok(r.result);
  r.onerror = () => fail(r.error);
});
async function store(mode, fn) {
  const d = await idb();
  return new Promise((ok, fail) => {
    const t = d.transaction('kv', mode);
    const req = fn(t.objectStore('kv'));
    t.oncomplete = () => ok(req && req.result);
    t.onerror = () => fail(t.error);
  });
}
const loadSaved = () => store('readonly', (s) => s.get('db')).catch(() => null);
const save = (rec) => store('readwrite', (s) => s.put(rec, 'db'));
const forget = () => store('readwrite', (s) => s.delete('db'));

let py, bridge, build, saveTimer;

async function start() {
  build = await (await fetch('build.json', { cache: 'no-cache' })).json();
  say('Downloading Python (about 20 MB the first time)…');
  const { loadPyodide } = await import(PYODIDE + 'pyodide.mjs');
  py = await loadPyodide({ indexURL: PYODIDE });
  say('Loading HaRM’s server…');
  await py.loadPackage(['fastapi', 'cryptography', 'micropip'], { messageCallback: () => {} });
  const get = async (f) => new Uint8Array(await (await fetch(f, { cache: 'no-cache' })).arrayBuffer());
  const [code, seed, saved] = await Promise.all([get(build.code), get(build.db), loadSaved()]);
  py.unpackArchive(code, 'zip', { extractDir: '/app' });
  await py.pyimport('micropip').install(build.wheels.map((w) => new URL(w, location.href).href));
  py.FS.mkdirTree('/data');
  // Keep the visitor's changes, unless this is a newer demo (then start from its fresh data).
  const keep = saved && saved.seed === build.seed;
  py.FS.writeFile('/data/harm.db', keep ? saved.bytes : seed);
  say('Opening the demo data…');
  py.runPython('import sys; sys.path.insert(0, "/app")');
  bridge = py.pyimport('harm_demo_bridge');
  await bridge.start();
  postMessage({ type: 'ready', kept: !!keep });
}

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const bytes = bridge.snapshot().toJs();
    save({ seed: build.seed, bytes, at: Date.now() }).catch((e) => console.warn('demo: could not save', e));
  }, 600);
}

const ready = start().catch((e) => {
  postMessage({ type: 'failed', text: String(e && e.message || e) });
  throw e;
});

onmessage = async ({ data: m }) => {
  if (m.type === 'reset') {
    await forget();
    postMessage({ type: 'reset-done' });
    return;
  }
  if (m.type !== 'request') return;
  try {
    await ready;
    const res = await bridge.handle(m.method, m.url, py.toPy(m.headers), m.body ? py.toPy(new Uint8Array(m.body)) : py.toPy(new Uint8Array()));
    const [status, headers, body] = res.toJs({ create_proxies: false });
    res.destroy();
    const buf = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
    postMessage({ type: 'response', id: m.id, status, headers, body: buf }, [buf]);
    if (!['GET', 'HEAD'].includes(m.method)) saveSoon();
  } catch (e) {
    postMessage({ type: 'response', id: m.id, status: 500, headers: [['content-type', 'application/json']],
      body: new TextEncoder().encode(JSON.stringify({ detail: 'Demo error: ' + (e && e.message || e) })).buffer });
  }
};
