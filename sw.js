// TVTRACKER — service worker
// Va posizionato nella stessa cartella di index.html (la registrazione usa './sw.js')

const CACHE = 'tvtracker-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL).catch(() => {})) // se un file manca, non bloccare l'install
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first per i dati (TMDB, Firestore, default-data.json), cache-first per lo shell.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  const isApi = url.hostname.includes('themoviedb.org')
    || url.hostname.includes('googleapis.com')
    || url.hostname.includes('firestore')
    || url.pathname.endsWith('default-data.json');

  if (isApi) {
    e.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }

  e.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(res => {
      if (res.ok && url.origin === self.location.origin) {
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
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
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
