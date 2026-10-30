/* Zom's HaRM service worker: lets the app be installed and opens instantly.
 * Only the app shell (code, styles, icons) is cached. API responses are never
 * cached, so no inventory data or secrets are stored on the phone. */
const SHELL = 'harm-shell-v4';
const ASSETS = ['/', '/static/app.js', '/static/style.css', '/static/theme.js', '/static/icon.svg', '/static/icon-coolant.svg', '/static/icon-coolant-anim.svg', '/static/icon-192.png', '/static/manifest.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== SHELL).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Only HaRM's own app files are handled here. Everything else (the certificate download, icons,
  // the API) goes straight to the network, so the browser can show its own certificate warnings.
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname !== '/' && !url.pathname.startsWith('/static/')) return;
  // Network first (always fresh after updates), cached shell when the server can't be reached.
  e.respondWith(fetch(e.request).then(res => {
    if (res.ok && (url.pathname === '/' || url.pathname.startsWith('/static/'))) {
      const copy = res.clone();
      caches.open(SHELL).then(c => c.put(e.request, copy));
    }
    return res;
  }).catch(() => caches.match(e.request).then(r => r || caches.match('/'))));
});
