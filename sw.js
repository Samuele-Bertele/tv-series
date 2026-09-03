// TVTRACKER — service worker
// Va posizionato nella stessa cartella di index.html (la registrazione usa './sw.js')
//
// [v11] Tolti tema chiaro, barra sticky e legenda dei voti. Il tema chiaro era
// illeggibile in troppi punti; la barra appiccicata scattava (il backdrop-filter
// si ridipingeva a ogni frame di scorrimento); la legenda era un pannello figlio
// di .top-bar, che ha overflow:hidden, quindi al click veniva tagliata e non si
// vedeva. Cambiati app.js, styles.css e index.html.
//
// [v10] Account: senza accesso l'app lavora SOLO in locale (niente piu' archivio
// condiviso scrivibile da chiunque), e ogni identita' ha il suo scomparto in
// localStorage. Corretto il bug per cui accedere da un dispositivo usato di
// recente da ospite faceva scartare lo snapshot dell'account e ne sovrascriveva
// la libreria nel cloud. Le due barre di ricerca sono diventate una sola, la
// barra e' sticky, la legenda voti e' un popover, e il foglio di stile ha una
// scala tipografica in rem. Cambiati app.js, styles.css, index.html e
// firestore.rules.
//
// [v9] Un account nuovo parte con la libreria vuota invece di ereditare quella
// locale o l'archivio condiviso, e il Reset svuota davvero invece di
// ripristinare un elenco preconfezionato. Cambiati app.js, index.html e
// data/default-data.json.
//
// [v8] Correzioni post-rilascio: senza account la sincronizzazione torna
// sull'archivio condiviso invece di spegnersi (LEGACY_SHARED_SYNC), messaggi
// leggibili quando l'autenticazione non e' configurata in Console, e una sola
// riga in console invece di decine di errori CORS quando il CDN di TMDB non
// espone gli header per l'estrazione del colore. Cambiato app.js.
//
// [v7] Account Firebase, ricerca globale TMDB, tag, checklist episodi, confronto
// fra due serie, esportazione ICS del calendario, stati vuoti illustrati.
// Corretti: la migrazione dello schema (ri-chiavava voti e diario su UUID
// rendendoli invisibili), il ramo Firestore da sloggato (scriveva su un
// documento in sola lettura) e il CSS incollato due volte.
// Cambiati styles.css, app.js e index.html.
//
// [v6] Restyling: mosaico di locandine nell'intestazione, alone del colore
// dominante sulle card, entrata scaglionata, anelli del voto animati, backdrop
// TMDB nel modale. Cambiati styles.css, app.js e index.html.
//
// [v5] Cambiati styles.css, app.js e index.html: la VERSION va incrementata a
// ogni modifica, altrimenti il ramo cache-first continua a servire i vecchi.
//
// [v4] CSS e JS non sono più dentro index.html. Prima l'HTML era 240 KB ed era
// servito network-first: ogni visita riscaricava tutto, stili e codice compresi.
// Ora l'HTML resta network-first (deve poter cambiare subito), mentre
// styles.css e app.js passano dal ramo cache-first: si scaricano una volta sola
// e cambiano solo quando cambia VERSION.
const VERSION = 'v11';
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
          // [FIX] Prima si metteva in cache solo l'HTML: il ramo isApi aveva un
          // fallback offline che non trovava mai nulla. Ora si salva anche la
          // risposta di default-data.json, l'unica utile davvero da riusare
          // offline (le chiamate TMDB/Firestore restano fuori: sono per-serie e
          // riempirebbero la cache senza motivo).
          const cacheable = res.ok && (isHtml(req) || url.pathname.endsWith('default-data.json'));
          if (cacheable) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(req, clone));
          }
          return res;
        })
        .catch(async () => {
          const cached = await caches.match(req);
          if (cached) return cached;
          return new Response('Offline e nessuna copia in cache.', {
            status: 503,
            statusText: 'Offline',
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
        })
    );
    return;
  }

  // 2) Asset statici (styles.css, app.js, immagini, font, css/js di terzi): cache-first.
  e.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req)
        .then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(req, clone));
          }
          return res;
        })
        // [FIX] Qui prima c'era `.catch(() => cached)`: siamo nel ramo in cui
        // `cached` è per definizione undefined, quindi respondWith riceveva
        // undefined e il browser sollevava un errore di rete invece di dare una
        // risposta. Serve una Response vera.
        .catch(() => new Response('', { status: 504, statusText: 'Offline' }));
    })
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
