// TVTRACKER — service worker
// Va posizionato nella stessa cartella di index.html (la registrazione usa './sw.js')
//
// [v15] Riduzione cromatica: --info e --rec da azzurro e viola a grigi quasi
// neutri, uscite e consigli su superfici neutre, una sola filettatura in cima
// (sulla barra). Wordmark a 40px in un vero <h1>, <header>/<main>/<section>,
// intestazioni di categoria come <h2><button aria-expanded>, skip link. Testo
// dorato con alpha sostituito da --gold-text/--gold-text-soft (il caso peggiore
// era 2,40:1). Form "nuova categoria" spostato nel pannello Categorie. Anello
// del voto a 34px sotto i 768px. Rimosse 18 classi CSS morte. Stampa vera con
// win.print(). Voto per stagione in ratingsData[titolo].seasons, con
// ratingOf() come unico punto di lettura del voto della serie.
// Ripristinata la virgola mancante in data/Samuele-data.json, che faceva
// ripiegare in silenzio il primo avvio sulle categorie vuote.
// Font, Font Awesome e SDK Firebase finalmente in cache (stale-while-
// revalidate, risposte opache comprese: vedi isPinnedAsset). La ricerca filtra
// anche Riprendi da qui, Prossime uscite ed Epopee e nasconde i consigli;
// corretto il falso positivo di fuzzyMatch sulle parole di una o due lettere
// ("crime" trovava "I Simpson"). Consigli senza doppioni fra le pagine TMDB.
// Cambiati app.js, styles.css, index.html, sw.js, data/Samuele-data.json.
//
// [v14] Pulizia dei colori: le due famiglie senza token (blu delle uscite,
// viola dei consigli) sono diventate --info-* e --rec-*, e i colori dell'immagine
// di condivisione si leggono dal foglio invece di essere ricopiati in app.js.
// Corretto il contrasto di "Da vedere" (3.21:1 -> 5.34:1). Spostati run.js in
// tests/ e index.js in functions/, unificato il .gitignore duplicato.
// Cambiati app.js, styles.css e sw.js.
//
// [v13] Il Reset dell'ospite non svuota piu': ripristina la libreria di
// data/Samuele-data.json, mentre un account nuovo (e il Reset fatto da dentro un
// account) continua a partire dalle categorie vuote di data/default-data.json.
// Il ramo rete-prima vale ora per tutti i file sotto data/, non solo per
// default-data.json, e il fallback offline ignora la query string: la fetch ci
// attacca un ?t=... sempre diverso, quindi caches.match non trovava mai nulla e
// la copia salvata restava li' inutilizzata. Cambiati app.js e sw.js.
//
// [v12] Aggiunte le pagine legali (privacy.html, cookie.html, termini.html,
// legal.css) e il piede di pagina con l'attribuzione TMDB richiesta dai termini
// d'uso delle API. Accessibilita': i colori del TESTO passano da --accent
// (4.42:1, sotto la soglia AA) a --accent-text (7.17:1), le modali dichiarano
// role="dialog", l'anello del voto e' attivabile da tastiera e c'e' un
// indicatore di focus visibile ovunque. Cambiati app.js, styles.css e
// index.html, piu' i quattro file nuovi.
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
const VERSION = 'v15';
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

// Le librerie di partenza: default-data.json (categorie vuote) e
// Samuele-data.json (la libreria dell'ospite). Devono arrivare dalla rete, cosi'
// una modifica al file si vede subito, ma vanno tenute in cache: senza, il Reset
// offline non avrebbe niente da cui ripartire.
const isDataFile = (url) => /\/data\/[^/]+\.json$/.test(url.pathname);

// [v15] Terze parti statiche con l'URL fissato a una versione: il CSS di
// Google Fonts, i file dei font, Font Awesome 6.4.0 su cdnjs e l'SDK Firebase
// 10.13.1 su gstatic. Fino alla v14 non finivano MAI nella cache, per due
// motivi sovrapposti:
//   1. il test `isApi` qui sotto prendeva tutto googleapis.com e gstatic.com
//      (voleva intercettare Firestore e l'autenticazione) e quindi anche i font
//      e l'SDK, che finivano nel ramo rete-prima dove si salvano solo HTML e
//      file di data/;
//   2. Font Awesome, il CSS dei font e l'SDK si caricano con <link> e <script>
//      SENZA crossorigin: il browser li chiede in modalita' no-cors e riceve una
//      risposta "opaca", con res.ok === false. Il ramo degli asset statici
//      salvava solo `if (res.ok)`: Font Awesome, che quel ramo diceva di coprire,
//      non e' mai stato salvato.
// Risultato: avvio offline della PWA senza icone e senza font, appena la cache
// HTTP del browser li aveva scartati (su iOS succede presto).
//
// Perche' non aggiungere crossorigin ai tag: se una di quelle CDN smettesse di
// mandare Access-Control-Allow-Origin, la risorsa non si caricherebbe piu' del
// tutto. E' lo stesso ragionamento gia' fatto per le locandine TMDB (vedi il
// README, "Colore dominante"): meglio una cache che salva risposte opache che
// un'icona che sparisce.
//
// Perche' stale-while-revalidate e non cache-first: di una risposta opaca non
// si legge lo stato, quindi non si puo' sapere se e' un 200 o una pagina
// d'errore. Con cache-first un errore salvato resterebbe fino al prossimo
// VERSION; cosi' si serve la copia in cache e intanto la si riscarica, e un
// errore si ripara da solo alla visita dopo.
// Costo noto: Chrome conteggia ogni risposta opaca con un'imbottitura di
// qualche MB nella quota. Qui sono sei file, su una quota che e' una frazione
// del disco.
const isPinnedAsset = (url) =>
  url.hostname === 'fonts.googleapis.com'
  || url.hostname === 'fonts.gstatic.com'
  || url.hostname === 'cdnjs.cloudflare.com'
  || (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/'));

const cacheable = (res) => res && (res.ok || res.type === 'opaque');

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // 0) Terze parti statiche fissate a una versione: stale-while-revalidate.
  //    Va PRIMA del test isApi, che altrimenti le catturerebbe.
  if (isPinnedAsset(url)) {
    const network = fetch(req)
      .then(async (res) => {
        if (cacheable(res)) {
          const copy = res.clone();
          const cache = await caches.open(CACHE);
          await cache.put(req, copy);
        }
        return res;
      })
      .catch(() => null);
    // Il riscaricamento deve finire anche quando la risposta e' gia' partita
    // dalla cache, altrimenti il browser puo' fermare il worker a meta'.
    e.waitUntil(network);
    e.respondWith(
      caches.match(req).then(cached => cached || network.then(res =>
        res || new Response('', { status: 504, statusText: 'Offline' })))
    );
    return;
  }

  // 1) HTML e dati: SEMPRE dalla rete. Cache solo come fallback offline.
  const isApi = url.hostname.includes('themoviedb.org')
    || url.hostname.includes('googleapis.com')
    || url.hostname.includes('gstatic.com')
    || url.hostname.includes('firestore')
    || isDataFile(url);

  if (isHtml(req) || isApi) {
    e.respondWith(
      fetch(req)
        .then(res => {
          // [FIX] Prima si metteva in cache solo l'HTML: il ramo isApi aveva un
          // fallback offline che non trovava mai nulla. Ora si salva anche la
          // risposta dei file sotto data/, gli unici davvero utili da riusare
          // offline (le chiamate TMDB/Firestore restano fuori: sono per-serie e
          // riempirebbero la cache senza motivo).
          const cacheable = res.ok && (isHtml(req) || isDataFile(url));
          if (cacheable) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(req, clone));
          }
          return res;
        })
        .catch(async () => {
          // ignoreSearch: le librerie di partenza si scaricano con un ?t=<ora>
          // diverso a ogni chiamata. Con il confronto esatto la copia in cache
          // non veniva MAI trovata, e offline il Reset falliva in silenzio.
          const cached = await caches.match(req, { ignoreSearch: true });
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
