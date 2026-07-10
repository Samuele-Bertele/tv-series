// TVTRACKER — service worker
// Va posizionato nella stessa cartella di index.html (la registrazione usa './sw.js')
const VERSION = 'v2';
const CACHE = `tvtracker-${VERSION}`;
self.addEventListener('install', () => {
  // Niente precache dello shell: l'HTML deve sempre poter cambiare.
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});
const isHtml = (req) =>
  req.mode === 'navigate' ||
  (req.headers.get('accept') || '').includes('text/html');
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  // 1) HTML e dati: SEMPRE dalla rete. Cache solo come fallback offline.
  const isApi = url.hostname.includes('themoviedb.org')
    || url.hostname.includes('googleapis.com')
    || url.hostname.includes('gstatic.com')
    || url.hostname.includes('firestore')
    || url.pathname.endsWith('default-data.json');
  if (isHtml(req) || isApi) {
    e.respondWith(
      fetch(req)
        .then(res => {
          if (res.ok && isHtml(req)) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(req, clone));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }
  // 2) Asset statici (immagini, font, css, js di terzi): cache-first.
  e.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(res => {
      if (res.ok) {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(req, clone));
      }
      return res;
    }).catch(() => cached))
  );
});
// Click su una notifica episodio: porta in primo piano la scheda già aperta, o ne apre una.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) if ('focus' in client) return client.focus();
      if (self.clients.openWindow) return self.clients.openWindow('./');
    })
  );
});
// Hook per un eventuale push server-side futuro (Firebase Cloud Messaging).
self.addEventListener('push', (e) => {
  let payload = { title: 'TVTRACKER', body: 'Nuovo episodio disponibile' };
  try { if (e.data) payload = { ...payload, ...e.data.json() }; } catch (err) {}
  e.waitUntil(self.registration.showNotification(payload.title, { body: payload.body, tag: payload.tag }));
});
