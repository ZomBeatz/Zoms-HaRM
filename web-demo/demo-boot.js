// Online demo: answers the app's /api/ requests with HaRM's real server running in a worker (worker.js),
// so nothing leaves the visitor's browser. Loaded before app.js; app.js checks window.harmDemo.
(() => {
  const version = new URL(document.currentScript.src).search;  // ?v=… from build.py
  const worker = new Worker('demo/worker.js' + version, { type: 'module' });
  const waiting = new Map();
  let next = 0;
  let readyState = 'starting';

  const bootText = (text) => { const b = document.querySelector('#app .boot'); if (b) b.textContent = text; };

  worker.onmessage = ({ data: m }) => {
    if (m.type === 'progress') bootText(m.text);
    else if (m.type === 'ready') {
      readyState = 'ready';
      if (m.kept) toastSoon('Welcome back: your changes from last time are still here.');
    } else if (m.type === 'failed') {
      readyState = 'failed';
      bootText('The online demo couldn’t start: ' + m.text + '. Try reloading, or use a current Chrome, Edge, Firefox or Safari.');
    } else if (m.type === 'reset-done') location.reload();
    else if (m.type === 'response' && waiting.has(m.id)) {
      const { ok } = waiting.get(m.id);
      waiting.delete(m.id);
      const empty = m.status === 204 || m.status === 304;
      ok(new Response(empty ? null : m.body, { status: m.status, headers: m.headers }));
    }
  };

  async function ask(req) {
    const u = new URL(req.url);
    const body = ['GET', 'HEAD'].includes(req.method) ? null : await req.arrayBuffer();
    const headers = [...req.headers.entries()];
    return new Promise((ok, fail) => {
      const id = ++next;
      waiting.set(id, { ok, fail });
      worker.postMessage({ type: 'request', id, method: req.method, url: u.pathname + u.search, headers, body }, body ? [body] : []);
    });
  }

  const realFetch = window.fetch.bind(window);
  const isApi = (url) => { const u = new URL(url, location.href); return u.origin === location.origin && u.pathname.startsWith('/api/'); };
  window.fetch = (input, init) => {
    const req = new Request(input, init);
    return isApi(req.url) ? ask(req) : realFetch(input, init);
  };

  async function download(url) {
    const r = await window.fetch(url);
    if (!r.ok) { alert('Download failed: ' + r.status); return; }
    const name = /filename="?([^";]+)/.exec(r.headers.get('content-disposition') || '')?.[1] || url.split('/').pop();
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(await r.blob()), download: name });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // Plain links to /api/ (CSV exports, backup) would leave the page; fetch them through the demo instead.
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href^="/api/"]');
    if (!a) return;
    e.preventDefault();
    download(a.getAttribute('href'));
  }, true);

  function reset() {
    if (confirm('Reset the demo? Your changes in this browser will be removed.')) worker.postMessage({ type: 'reset' });
  }

  function toastSoon(text) {
    const t = () => (typeof toast === 'function' ? toast(text) : setTimeout(t, 500));
    setTimeout(t, 1500);
  }

  // A small badge so visitors know where they are and how to start over.
  function badge() {
    const el = document.createElement('div');
    el.className = 'demo-badge';
    el.setAttribute('role', 'note');
    const label = document.createElement('span');
    const b = document.createElement('strong');
    b.textContent = 'Live demo.';
    const long = document.createElement('span');
    long.className = 'demo-long';
    long.textContent = ' Try anything. Changes are only saved in this browser.';
    label.append(b, long);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Reset demo';
    btn.addEventListener('click', reset);
    const get = document.createElement('a');
    get.href = 'https://github.com/ZomBeatz/Zoms-HaRM#quick-start';
    get.target = '_blank';
    get.rel = 'noopener';
    get.textContent = 'Get Zom\u2019s HaRM';
    el.append(label, btn, get);
    document.body.append(el);
    // If a visitor locks the demo, the unlock box says what to type.
    new MutationObserver(() => {
      const pw = document.querySelector('.auth-card input[type=password]:not([data-demo])');
      if (pw) { pw.dataset.demo = '1'; pw.placeholder = 'Demo password: demo-password'; }
    }).observe(document.getElementById('app') || document.body, { childList: true, subtree: true });
  }
  if (document.body) badge(); else document.addEventListener('DOMContentLoaded', badge);

  window.harmDemo = { download, reset, get state() { return readyState; } };
})();
