// ==================== CONFIG ====================
const TMDB_API_KEY = '74f5aefb6bb96d044cbf995d9b1897e2';
const TMDB_IMG = 'https://image.tmdb.org/t/p/w342';
const TMDB_IMG_LARGE = 'https://image.tmdb.org/t/p/w780';
// Testata del modale dei dettagli. w780 e non w1280: l'immagine viene comunque
// velata e sfumata, la risoluzione in più non si vedrebbe.
const TMDB_IMG_BACKDROP = 'https://image.tmdb.org/t/p/w780';
// FIX: via.placeholder.com è offline -> placeholder inline, zero richieste di rete
const PLACEHOLDER_IMG = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='450'%3E%3Crect width='300' height='450' fill='%23141414'/%3E%3Ctext x='150' y='240' text-anchor='middle' font-family='sans-serif' font-size='48' fill='%23333'%3ETV%3C/text%3E%3C/svg%3E";


// ========== SCHEMA: id stabili, tipo semantico delle categorie, tag ==========
//
// [FIX DATI] La prima stesura di questa migrazione ri-chiavava ratingsData e
// watchData da titolo a UUID. Ma tutto il resto dell'app li legge per titolo
// (ratingsData[show.title], watchData[title]: una quarantina di punti), quindi
// dopo la migrazione voti, date e diario restavano in localStorage ma sparivano
// dall'interfaccia. Inoltre ricostruiva ogni serie da una lista fissa di campi,
// scartando tutto il resto (tmdbId salvati a mano, campi futuri...).
//
// Ora la normalizzazione e' ADDITIVA e idempotente: aggiunge id/type/tags senza
// toccare le chiavi degli store ne' scartare campi sconosciuti. Gli id servono
// alle funzioni nuove (confronto, UID del calendario ICS) e sono pronti per un
// eventuale passaggio futuro a store indicizzati per id, che pero' e' un
// refactor a se' e va fatto in un colpo solo su tutti i punti di lettura.

const generateId = () => (typeof crypto !== 'undefined' && crypto.randomUUID)
  ? crypto.randomUUID()
  : `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

// L'ordine conta: "da vedere in futuro" contiene "da vedere".
const CATEGORY_TYPE_RULES = [
  ['watching', 'sto guardando'],
  ['future',   'da vedere in futuro'],
  ['todo',     'da vedere'],
];
const categoryType = (name) => {
  const n = (name || '').toLowerCase();
  const hit = CATEGORY_TYPE_RULES.find(([, needle]) => n.includes(needle));
  return hit ? hit[0] : 'custom';
};

// Idempotente: si puo' chiamare a ogni avvio, dopo un'importazione e dopo uno
// snapshot remoto. Ritorna true se ha cambiato qualcosa (quindi vale la pena
// salvare).
const ensureSchema = () => {
  let changed = false;
  const seenIds = new Set();
  for (const cat of data) {
    if (!cat || !Array.isArray(cat.shows)) continue;
    if (!cat.id) { cat.id = generateId(); changed = true; }
    const t = categoryType(cat.name);
    if (cat.type !== t) { cat.type = t; changed = true; }
    for (const show of cat.shows) {
      if (!show) continue;
      // Un id duplicato e' peggio di un id mancante: confronto e UID del
      // calendario finirebbero a puntare a due serie diverse.
      if (!show.id || seenIds.has(show.id)) { show.id = generateId(); changed = true; }
      seenIds.add(show.id);
      if (!Array.isArray(show.tags)) { show.tags = []; changed = true; }
      if (!show.addedAt) { show.addedAt = new Date().toISOString(); changed = true; }
    }
  }
  return changed;
};

// Recupero per chi ha gia' eseguito la migrazione "v3" (quella che spostava le
// chiavi su UUID): rimette voti e schede di visione sotto il titolo. Le chiavi
// che non corrispondono a nessun id noto vengono lasciate dove sono: meglio un
// residuo inerte che una cancellazione.
const repairLegacyIdKeys = () => {
  const titleById = new Map();
  const knownTitles = new Set();
  for (const cat of data) {
    for (const show of (cat?.shows || [])) {
      if (show?.id && show?.title) titleById.set(show.id, show.title);
      if (show?.title) knownTitles.add(show.title);
    }
  }
  let changed = false;
  const remap = (store) => {
    for (const key of Object.keys(store)) {
      if (knownTitles.has(key)) continue;
      const title = titleById.get(key);
      if (!title) continue;
      if (store[title] === undefined) store[title] = store[key];
      delete store[key];
      changed = true;
    }
  };
  remap(ratingsData);
  remap(watchData);
  return changed;
};

// Chiamata unica all'avvio, dopo che data/ratingsData/watchData sono stati
// caricati davvero (prima veniva eseguita in cima al file, e le sue assegnazioni
// venivano poi sovrascritte da loadRatings/loadWatchData/initData).
const normalizeStoredData = async () => {
  const schemaChanged = ensureSchema();
  const repaired = repairLegacyIdKeys();
  if (repaired) { saveRatingsLocal(); saveWatchDataLocal(); }
  // [v17] Id, tag e tipo di categoria sono campi calcolati: salvarli con
  // saveData alzava il timestamp, e dalla v17 l'avvio puo' avvenire gia' nello
  // scomparto di un account. Una libreria locale "normalizzata" sarebbe
  // risultata piu' recente di quella sul cloud, scartandone lo snapshot.
  if (schemaChanged) saveDerivedData();
  if (repaired) { saveRatings(); saveWatchData(); }
};


// ==================== STATE ====================
let currentUser = null;

// ==================== AMBITO DEI DATI (per identita') ====================
// [FIX CRITICO] Prima le chiavi di localStorage erano tre costanti globali al
// dispositivo (tvtracker-data, -ratings, -watchdata) e localDataTimestamp era
// un solo numero, sempre quello, qualunque account fosse attivo. Ma quel
// timestamp viene usato da listenToShows per decidere se accettare uno snapshot
// remoto: un confronto che ha senso DENTRO una identita', non ATTRAVERSO due.
//
// Cosa succedeva:
//   - Accesso: se avevi usato l'app da ospite oggi, il timestamp locale era piu'
//     recente di quello dell'account (scritto magari una settimana fa). Lo
//     snapshot dell'account veniva scartato, in memoria restava la libreria
//     dell'ospite, e il primo salvataggio la scriveva SOPRA l'account.
//   - Uscita: la libreria privata restava in memoria e finiva nell'archivio
//     condiviso, che era scrivibile da chiunque.
//   - In ogni caso, la libreria di un utente restava in localStorage leggibile
//     da chiunque altro usasse quel browser.
//
// Ora ogni identita' ha il suo scomparto: 'guest' finche' non si accede, l'uid
// dopo. Cambiare identita' vuol dire cambiare scomparto e ripartire da un
// timestamp azzerato, non ereditare quello di prima.
const GUEST_SCOPE = 'guest';
let storeScope = GUEST_SCOPE;
let scopeInitialised = false;

const scopedKey = (name, scope = storeScope) => `tvtracker:${scope}:${name}`;

// Chiavi della versione precedente, non namespaced. Vengono spostate una volta
// sola dentro lo scomparto 'guest', cosi' chi apre l'app dopo l'aggiornamento
// ritrova la sua libreria invece di una pagina vuota.
const LEGACY_KEYS = {
  data: 'tvtracker-data',
  'data-ts': 'tvtracker-data-ts',
  ratings: 'tvtracker-ratings',
  watchdata: 'tvtracker-watchdata',
};

const migrateLegacyStorage = () => {
  try {
    if (localStorage.getItem(scopedKey('migrated', GUEST_SCOPE))) return;
    for (const [name, oldKey] of Object.entries(LEGACY_KEYS)) {
      const val = localStorage.getItem(oldKey);
      if (val === null) continue;
      if (localStorage.getItem(scopedKey(name, GUEST_SCOPE)) === null) {
        localStorage.setItem(scopedKey(name, GUEST_SCOPE), val);
      }
      localStorage.removeItem(oldKey);
    }
    localStorage.setItem(scopedKey('migrated', GUEST_SCOPE), '1');
  } catch (e) { console.warn('Migrazione localStorage non riuscita:', e); }
};

let data = [];
const showDetailsCache = new Map(); // title -> details | null (null = "cercato, non trovato")
const watchProvidersCache = new Map(); // tmdbId -> provider info | null
// [PERF] Senza persistenza, ogni ricarica della pagina perdeva tutta la cache
// e doveva rifare una fetch TMDB per OGNI serie solo per sapere quante stagioni
// ha o se c'è un episodio in uscita. Salvandola in localStorage (con scadenza)
// i caricamenti successivi al primo sono quasi istantanei.
const DETAILS_CACHE_KEY = 'tvtracker-details-cache';
// [v17] Niente piu' una scadenza unica di 12 ore. Prima una voce scaduta veniva
// SCARTATA al caricamento: aprendo il sito il giorno dopo, tutte le ~150 serie
// erano scadute insieme e "Riprendi da qui" e "Prossime uscite" restavano vuoti
// finche' non tornavano 150 richieste TMDB, cinque alla volta. In piu' il
// salvataggio riscriveva il timestamp di TUTTE le voci con l'ora corrente, cosi'
// chi apriva l'app spesso non aggiornava mai nulla (episodi nuovi compresi).
//
// Ora la cache e' stale-while-revalidate: ogni voce tiene l'ora in cui e' stata
// scaricata davvero, al caricamento si usano tutte (anche vecchie) per disegnare
// subito, e quelle "da rinfrescare" si riscaricano in background, con prima le
// serie che stai guardando. La freschezza dipende da quanto la serie puo'
// cambiare: vedi detailsMaxAge().
const DETAILS_FRESH_MS = {
  live:    2 * 60 * 60 * 1000,        // in "Sto guardando": episodi e stagioni nuovi
  active:  24 * 60 * 60 * 1000,       // ancora in onda o annunciata
  settled: 14 * 24 * 60 * 60 * 1000,  // finita o cancellata: non cambia quasi piu'
  missing: 3 * 24 * 60 * 60 * 1000,   // cercata su TMDB e non trovata
};
// [PERF] I provider streaming cambiano raramente: TTL più lungo (4 giorni) rispetto ai dettagli.
const PROVIDERS_CACHE_KEY = 'tvtracker-providers-cache';
const PROVIDERS_CACHE_TTL = 4 * 24 * 60 * 60 * 1000;
let ratingsData = {};
// [FIX RESET] Tempo di visione e diario NON stanno più dentro l'oggetto show
// (che viene sovrascritto dal Reset), ma in uno store separato tenuto per
// titolo, esattamente come ratingsData. Struttura: { [title]: { startedAt, finishedAt, journal: [], currentSeason, currentEpisode } }
let watchData = {};
let searchQuery = '';
// [FIX] Prima era un Set di INDICI: ogni riordino o cancellazione di categoria
// richiedeva di rimappare a mano gli indici (due blocchi separati e facili da
// sbagliare). Indicizzando per nome il problema sparisce: i nomi sono già unici,
// lo garantiscono il form di creazione e la fusione in importazione.
// [FIX] ...e non veniva salvato da nessuna parte: chiudere otto categorie su
// dodici e ricaricare le riapriva tutte. Ora vive in localStorage.
const COLLAPSED_KEY = 'tvtracker-collapsed';
let collapsedCategories = new Set();
try {
  const rawCollapsed = localStorage.getItem(COLLAPSED_KEY);
  if (rawCollapsed) collapsedCategories = new Set(JSON.parse(rawCollapsed));
} catch (e) { /* voce corrotta: si riparte da zero, nessun danno */ }
const saveCollapsed = () => {
  try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsedCategories])); }
  catch (e) { console.warn('Impossibile salvare le categorie chiuse:', e); }
};

// Categorie che non partecipano alla numerazione globale delle card.
// Era duplicata in doRender e in printList: due copie da tenere allineate a mano.
const UNNUMBERED_CATS = ['sto guardando', 'da vedere'];

// Etichette abbreviate del tooltip sull'anello del voto. Erano ridefinite dentro
// il ciclo di rendering, quindi ricreate una volta per card ad ogni render.
// NB: le etichette sono volutamente più corte di quelle di RATING_CATS.
const RATING_TOOLTIP_CATS = [
  { key: 'cast', label: 'Cast' },
  { key: 'trama', label: 'Trama' },
  { key: 'ambientazione', label: 'Ambienz.' },
  { key: 'colonna_sonora', label: 'Musica' },
  { key: 'coinvolgimento', label: 'Coinvolg.' },
];

// [filtri] vista lista: genere, anno, voto minimo
let listFilters = { genre: '', year: '', minRating: 0, tag: '' };

// [selezione multipla] sposta/elimina più serie in un colpo solo
let bulkMode = false;
let selectedShows = new Set(); // titoli selezionati

// [8] vista griglia/lista + ordinamento
let viewMode = localStorage.getItem('tvtracker-view') === 'list' ? 'list' : 'grid';
let sortState = { key: 'manual', dir: 1 };

// [5] raccomandazioni
let recsCache = null;
let recsLoading = false;

// [2][3] calendario + notifiche
const UPCOMING_WINDOW_DAYS = 30;
// [v18] Il registro delle notifiche gia' mostrate non sta piu' in localStorage
// (il service worker non lo vedrebbe): vive nello stato di notify-core.js. La
// vecchia chiave si legge una volta sola, per non ripetere l'avviso di oggi.
const LEGACY_NOTIFIED_KEY = 'tvtracker-notified';

// render concurrency
let rendering = false;
let renderQueued = false;

// [FIX SYNC] Timestamp logico dell'ultima modifica locale. Serve per non farci
// sovrascrivere da uno snapshot Firestore più vecchio (es. al riavvio dell'app,
// prima che il nostro ultimo salvataggio sia arrivato al server).
let localDataTimestamp = 0; // impostato da applyScope(), che sa quale scomparto leggere
let ratingsTimestamp = 0;
let watchTimestamp = 0;
let pendingShowsWrite = false;

// Firebase sync
let firebaseEnabled = false;
let ratingsDocRef = null;
let watchDataDocRef = null;
let showsDocRef = null;
let applyingRemoteRatings = false;
let applyingRemoteWatchData = false;
let applyingRemoteShows = false;
let lastShowsWrittenJson = null; // FIX #5: guardia contro l'eco delle nostre scritture

// ==================== LOADING BAR ====================
let loadingCount = 0;
const loadingBar = document.getElementById('loadingBar');
const startLoading = () => { loadingCount++; loadingBar.classList.add('active'); };
const stopLoading = () => { loadingCount = Math.max(0, loadingCount - 1); if (!loadingCount) loadingBar.classList.remove('active'); };

// ==================== BANNER OFFLINE ====================
// [PERF] quando siamo offline evitiamo di lanciare fetch destinate a fallire:
// usato più avanti da prefetchDetails.
const updateOfflineBanner = () => {
  const banner = document.getElementById('offlineBanner');
  if (!banner) return;
  banner.style.display = navigator.onLine ? 'none' : 'flex';
};
window.addEventListener('online', updateOfflineBanner);
window.addEventListener('offline', updateOfflineBanner);

// ==================== FIREBASE ====================
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDPlZcNCY14Lkkg6YTsDkq7prmNg-ODbtA",
  authDomain: "serietvtracker.firebaseapp.com",
  projectId: "serietvtracker",
  storageBucket: "serietvtracker.firebasestorage.app",
  messagingSenderId: "51046520782",
  appId: "1:51046520782:web:ea8870a9d9e2deed293d9f",
  measurementId: "G-MC3MZPE900"
};

// [v17 PERF] L'SDK Firebase non sta piu' nell'<head>. Erano tre <script>
// sincroni (app, firestore, auth: qualche centinaio di KB di JavaScript) che il
// browser doveva scaricare ed ESEGUIRE prima di disegnare qualunque cosa, anche
// quando arrivavano dalla cache del service worker. Su un telefono e' la parte
// piu' lunga dell'avvio. Ora la libreria si disegna dai dati locali e l'SDK si
// carica subito dopo, in parallelo con il resto.
// Se si cambia versione, l'URL nuovo finisce in cache da solo (isPinnedAsset in
// sw.js accetta qualunque percorso sotto /firebasejs/).
const FIREBASE_SDK_VERSION = '10.13.1';
const FIREBASE_SDK = ['firebase-app-compat.js', 'firebase-firestore-compat.js', 'firebase-auth-compat.js']
  .map(f => `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/${f}`);
const hasFirebaseSdk = () => typeof firebase !== 'undefined' && !!firebase?.initializeApp;

// Risolve true quando i tre file sono eseguiti, false se uno non arriva
// (offline al primo avvio, blocco pubblicita'): in quel caso initFirebase
// ripiega da sola sulla modalita' locale.
const loadFirebaseSdk = () => new Promise((resolve) => {
  if (hasFirebaseSdk()) { resolve(true); return; }
  let left = FIREBASE_SDK.length;
  let failed = false;
  const done = () => { clearTimeout(timer); resolve(!failed && hasFirebaseSdk()); };
  // Rete appesa: dopo 20 secondi si lavora in locale invece di restare su
  // "Connessione..." per sempre.
  const timer = setTimeout(() => { failed = true; resolve(false); }, 20000);
  for (const src of FIREBASE_SDK) {
    const s = document.createElement('script');
    s.src = src;
    // async=false: gli script inseriti da JavaScript vengono eseguiti NELL'ORDINE
    // di inserimento (app prima di firestore e auth), pur scaricandosi in parallelo.
    s.async = false;
    s.onload = () => { if (--left === 0) done(); };
    s.onerror = () => { failed = true; if (--left === 0) done(); };
    document.head.appendChild(s);
  }
});

const updateSyncStatus = (state) => {
  const el = document.getElementById('syncStatus');
  if (!el) return;
  el.className = `sync-status ${state}`;
  const labels = {
    synced: ['<i class="fas fa-cloud"></i>', 'Sincronizzato'],
    // Senza accesso non si sincronizza piu' con nessuno: i dati vivono in questo
    // browser e basta. Il badge lo dice invece di lasciarlo intuire.
    local: ['<i class="fas fa-hard-drive"></i>', currentUser ? 'Solo locale' : 'Solo questo dispositivo'],
    connecting: ['<i class="fas fa-circle-notch fa-spin"></i>', 'Connessione...'],
    error: ['<i class="fas fa-triangle-exclamation"></i>', 'Errore sync'],
  };
  const [icon, text] = labels[state] || labels.local;
  el.innerHTML = `${icon}<span>${text}</span>`;
};

// Riferimenti ai documenti personali dell'utente autenticato.
const userDocRefs = (db, uid) => {
  const col = db.collection('users').doc(uid).collection('tvtracker');
  return { shows: col.doc('shows'), ratings: col.doc('ratings'), watch: col.doc('watchdata') };
};

let firestoreDb = null;
// onSnapshot restituisce la funzione per disiscriversi. Senza tenerla, ogni
// cambio di account lasciava attivo il listener del precedente: due sorgenti
// che scrivevano sullo stesso stato locale.
let unsubShows = null, unsubRatings = null, unsubWatch = null;
// [v17] true dopo il primo snapshot dell'elenco: prima di allora non si sa se il
// cloud ha una versione piu' recente, e i campi calcolati (vedi saveDerivedData)
// non devono salire a coprirla.
let showsSnapshotSeen = false;
const stopFirestoreListeners = () => {
  showsSnapshotSeen = false;
  if (unsubShows)   { try { unsubShows(); }   catch (e) {} unsubShows = null; }
  if (unsubRatings) { try { unsubRatings(); } catch (e) {} unsubRatings = null; }
  if (unsubWatch)   { try { unsubWatch(); }   catch (e) {} unsubWatch = null; }
};

const countShows = (cats) => Array.isArray(cats)
  ? cats.reduce((n, c) => n + (Array.isArray(c?.shows) ? c.shows.length : 0), 0)
  : 0;

// [v17 PERF] Lo scomparto con cui si apre la pagina. Prima si partiva SEMPRE da
// 'guest' e si passava all'account solo quando Firebase aveva caricato l'SDK e
// risolto la sessione: chi usa un account vedeva per un attimo la libreria
// dell'ospite (o, su un browser mai usato da ospite, aspettava addirittura il
// download di Samuele-data.json), poi tutto veniva ridisegnato. Ora si riapre
// subito l'ultimo scomparto usato, purche' abbia dei dati su questo browser;
// onAuthStateChanged conferma o corregge appena puo'.
const LAST_SCOPE_KEY = 'tvtracker-last-scope';
const rememberScope = (scope) => {
  try { localStorage.setItem(LAST_SCOPE_KEY, scope); } catch (e) {}
};
// "Questo browser ha gia' sincronizzato quell'account": c'e' un timestamp.
const accountKnownLocally = (uid) => {
  try { return (parseInt(localStorage.getItem(scopedKey('data-ts', uid)) || '0', 10) || 0) > 0; }
  catch (e) { return false; }
};
const initialScope = () => {
  try {
    const last = localStorage.getItem(LAST_SCOPE_KEY);
    if (last && last !== GUEST_SCOPE && localStorage.getItem(scopedKey('data', last)) !== null && accountKnownLocally(last)) return last;
  } catch (e) {}
  return GUEST_SCOPE;
};

// Passa allo scomparto di un'identita': carica i suoi dati locali e AZZERA il
// timestamp di riferimento. Senza l'azzeramento, il timestamp dell'identita'
// precedente farebbe scartare il primo snapshot della nuova (vedi il commento
// lungo su GUEST_SCOPE). Va chiamata PRIMA di attaccare i listener Firestore.
const applyScope = (scope) => {
  storeScope = scope;

  const readJson = (name, fallback) => {
    try {
      const raw = localStorage.getItem(scopedKey(name));
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return parsed ?? fallback;
    } catch (e) { return fallback; }
  };

  data = readJson('data', []);
  if (!Array.isArray(data)) data = [];
  ratingsData = readJson('ratings', {});
  watchData = readJson('watchdata', {});
  localDataTimestamp = parseInt(localStorage.getItem(scopedKey('data-ts')) || '0', 10) || 0;
  ratingsTimestamp = parseInt(localStorage.getItem(scopedKey('ratings-ts')) || '0', 10) || 0;
  watchTimestamp = parseInt(localStorage.getItem(scopedKey('watchdata-ts')) || '0', 10) || 0;

  // Le tre bandierine dell'eco vanno riportate a zero: se un cambio di identita'
  // capita mentre ne era alzata una, ogni salvataggio successivo uscirebbe
  // subito e la nuova libreria non verrebbe mai scritta.
  applyingRemoteShows = false;
  applyingRemoteRatings = false;
  applyingRemoteWatchData = false;
  lastShowsWrittenJson = null;
  pendingShowsWrite = false;

  ensureSchema();
  // showDetailsCache NON si svuota: contiene dati pubblici di TMDB (stagioni,
  // trama, cast), non dati dell'utente. Svuotarla costringerebbe a rifare una
  // fetch per ogni serie a ogni accesso, senza proteggere nulla.
};

// Prima accensione di un account: i documenti sotto /users/{uid} non esistono
// ancora e vengono creati VUOTI.
//
// [SCELTA] La versione precedente li seminava con i dati locali, o con quelli
// dell'archivio condiviso /tvtracker se piu' ricchi. Comodo per la migrazione di
// chi possiede l'archivio, sbagliato per chiunque altro: bastava registrarsi per
// ritrovarsi in casa la libreria di un altro. Un account nuovo e' un account
// nuovo. Chi vuole portarci una lista usa Esporta backup prima e Importa backup
// dopo, che sono operazioni esplicite e sotto il suo controllo.
const createEmptyUserDocs = async () => {
  if (!showsDocRef || !ratingsDocRef || !watchDataDocRef) return false;

  // [CORSA] Le tre bandierine "sto applicando dati remoti" fanno uscire subito
  // saveShowsToFirebase / saveRatings / saveWatchData. Vanno alzate PRIMA della
  // get(): initFirebase parte prima di initData, e un saveData() qualsiasi nel
  // frattempo (basta uno schema da normalizzare all'avvio) scriverebbe la
  // libreria precedente sui documenti dell'account appena creato — che a quel
  // punto risulterebbe gia' esistente, e nascerebbe pieno.
  applyingRemoteShows = true;
  applyingRemoteRatings = true;
  applyingRemoteWatchData = true;
  try {
    const snap = await showsDocRef.get();
    if (snap.exists) return false;

    // Esplicitamente loadEmptyLibrary, non la libreria di partenza dello
    // scomparto: un account nuovo non eredita nulla, nemmeno dall'ospite.
    const emptyLibrary = await loadEmptyLibrary();
    const ts = Date.now();

    // Prima si svuota lo stato locale, poi si scrive: nell'ordine inverso la
    // libreria di prima resterebbe in memoria, visibile e pronta a risalire al
    // primo salvataggio.
    data = emptyLibrary;
    ensureSchema();
    ratingsData = {};
    watchData = {};
    localDataTimestamp = ts;
    ratingsTimestamp = ts;
    watchTimestamp = ts;
    localStorage.setItem(scopedKey('data'), JSON.stringify(data));
    localStorage.setItem(scopedKey('data-ts'), String(ts));
    saveRatingsLocal();
    saveWatchDataLocal();

    const stamp = firebase.firestore.FieldValue.serverTimestamp();
    await Promise.all([
      showsDocRef.set({ data, ts, updatedAt: stamp }),
      ratingsDocRef.set({ data: {}, ts, updatedAt: stamp }),
      watchDataDocRef.set({ data: {}, ts, updatedAt: stamp }),
    ]);
    return true;   // true = account appena creato
  } catch (e) {
    console.error('Creazione del profilo fallita:', e);
    return false;
  } finally {
    applyingRemoteShows = false;
    applyingRemoteRatings = false;
    applyingRemoteWatchData = false;
  }
};

// Codice lungo e facile da sbagliare, usato in tre punti.
const POPUP_UNSUPPORTED = 'auth/operation-not-supported-in-this-environment';

const authErrorMessage = (e) => {
  const code = e?.code || '';
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return null;
  if (code === 'auth/account-exists-with-different-credential') {
    return 'Esiste gia\' un account con questa email ma con un altro metodo di accesso. Entra con quello che avevi usato la prima volta.';
  }
  if (code === 'auth/too-many-requests') {
    return 'Troppi tentativi ravvicinati: Firebase ha bloccato temporaneamente l\'accesso da questo dispositivo. Riprova fra qualche minuto.';
  }
  if (code === 'auth/configuration-not-found' || code === 'auth/internal-error') {
    return 'Autenticazione non ancora attivata su questo progetto Firebase. Apri Console Firebase > Authentication e premi "Inizia", poi abilita i provider Anonimo e Google.';
  }
  if (code === 'auth/operation-not-allowed') {
    return 'Questo metodo di accesso non e\' abilitato. Console Firebase > Authentication > Sign-in method.';
  }
  if (code === 'auth/unauthorized-domain') {
    return `Il dominio ${location.hostname} non e' fra quelli autorizzati. Aggiungilo in Console Firebase > Authentication > Settings > Domini autorizzati.`;
  }
  if (code === 'auth/popup-blocked') {
    return 'Il browser ha bloccato la finestra di accesso: consenti i popup per questo sito e riprova.';
  }
  if (code === 'auth/network-request-failed') {
    return 'Rete non raggiungibile: l\'accesso non e\' andato a buon fine.';
  }
  return `Accesso non riuscito: ${e?.message || e}`;
};

// Due stati e due soli: "Ospite" (dati solo su questo dispositivo) e il nome
// dell'account (dati sincronizzati). Prima le etichette erano tre — "Ospite",
// "Ospite salvato", "Non collegato" — e nessuna diceva dove finissero i dati.
const updateAccountUi = () => {
  const label = document.getElementById('accountLabel');
  if (label) {
    label.textContent = currentUser
      ? (currentUser.isAnonymous ? 'Account anonimo' : (currentUser.displayName || currentUser.email || 'Il mio account'))
      : 'Ospite';
  }
  const guest = document.getElementById('authGuest');
  const user  = document.getElementById('authUser');
  if (guest) guest.hidden = !!currentUser;
  if (user)  user.hidden  = !currentUser;

  const who = document.getElementById('authUserWho');
  if (who && currentUser) {
    who.textContent = currentUser.isAnonymous
      ? 'Sei entrato con un account anonimo. La libreria e\' sincronizzata, ma legata a questo profilo: se esci non c\'e\' modo di rientrarci.'
      : `Sei entrato come ${currentUser.displayName || currentUser.email || 'utente'}. La libreria e\' sincronizzata su tutti i dispositivi in cui usi questo account.`;
  }
};

const initFirebase = () => {
  // L'SDK arriva da gstatic.com: puo' mancare per un blocco di rete, un blocco
  // pubblicita' aggressivo o una prima visita offline. Non e' un errore di
  // sincronizzazione, e' semplicemente modalita' locale — e senza questa
  // guardia il badge restava fisso su "Errore sync" con l'app perfettamente
  // funzionante.
  if (typeof firebase === 'undefined' || !firebase.initializeApp) {
    firebaseEnabled = false;
    updateSyncStatus('local');
    return;
  }
  if (!FIREBASE_CONFIG.apiKey || FIREBASE_CONFIG.apiKey.includes('INSERISCI_QUI')) {
    firebaseEnabled = false;
    updateSyncStatus('local');
    return;
  }
  try {
    firebase.initializeApp(FIREBASE_CONFIG);
    firestoreDb = firebase.firestore();

    // [FIX PWA] Chi ha fatto l'accesso via redirect (l'unico praticabile
    // nell'app installata su iOS) rientra qui. onAuthStateChanged scatta
    // comunque; questa chiamata serve a intercettare gli errori del giro di
    // ritorno, che altrimenti resterebbero muti.
    firebase.auth().getRedirectResult().catch((e) => {
      const msg = authErrorMessage(e);
      if (msg) showError(msg);
    });

    firebase.auth().onAuthStateChanged(async (user) => {
      const previousScope = storeScope;
      currentUser = user;
      stopFirestoreListeners();
      updateAccountUi();

      const nextScope = user ? user.uid : GUEST_SCOPE;
      // Il cambio di scomparto va fatto SEMPRE prima di toccare i riferimenti ai
      // documenti e i listener: e' quello che azzera il timestamp e carica i dati
      // giusti. Al primo giro previousScope e nextScope coincidono se l'avvio ha
      // gia' aperto lo scomparto giusto (vedi initialScope), quindi la guardia
      // evita una ricarica inutile.
      let scopeChanged = false;
      if (nextScope !== previousScope || !scopeInitialised) {
        applyScope(nextScope);
        scopeInitialised = true;
        scopeChanged = true;
      }
      rememberScope(nextScope);
      // Uscita da un account su un browser in cui l'ospite non era mai stato
      // riempito (dalla v17 l'avvio apre direttamente lo scomparto dell'account):
      // l'ospite riparte dalla sua libreria come al primo avvio, non da vuoto.
      if (!user && scopeChanged && !data.length) {
        await initData();
        if (pendingSeedId) { markSeedApplied(pendingSeedId); pendingSeedId = null; }
      }

      let isNewAccount = false;
      if (user) {
        const refs = userDocRefs(firestoreDb, user.uid);
        showsDocRef = refs.shows;
        ratingsDocRef = refs.ratings;
        watchDataDocRef = refs.watch;
        firebaseEnabled = true;
        updateSyncStatus('connecting');
        // [v17 PERF] Un account che questo browser ha gia' sincronizzato esiste
        // per forza sul cloud: la get() di controllo costava un giro completo
        // di rete PRIMA di attaccare i listener, cioe' prima di vedere i dati
        // aggiornati. Si fa solo per un account mai visto qui.
        isNewAccount = accountKnownLocally(user.uid) ? false : await createEmptyUserDocs();
        listenToRatings();
        listenToWatchData();
        listenToShows();
        if (isNewAccount) {
          showToast('Account creato: la libreria parte vuota. Per portarci una lista, usa "Importa backup" dal menu ⋮.', 'success');
        }
      } else {
        // [SCELTA] Senza accesso l'app lavora SOLO in locale. Prima continuava a
        // sincronizzare su /tvtracker/*, tre documenti scrivibili da chiunque
        // conoscesse il project id: un ospite vedeva e poteva modificare
        // l'archivio di qualcun altro, e uscendo da un account ci finiva dentro
        // la libreria privata appena lasciata. Ora ospite vuol dire ospite: i
        // dati restano in questo browser, e si sincronizzano solo dopo l'accesso.
        showsDocRef = null;
        ratingsDocRef = null;
        watchDataDocRef = null;
        firebaseEnabled = false;
        updateSyncStatus('local');
      }
      // [v17] Se lo scomparto era gia' quello giusto (avvio nello scomparto
      // ricordato) non c'e' niente da ridisegnare: prima qui partiva sempre un
      // secondo render completo della pagina, uguale al primo. I dati nuovi
      // arrivano con gli snapshot, che ridisegnano da soli.
      if (scopeChanged || isNewAccount) render();
      // Un'altra libreria puo' avere dettagli vecchi diversi da quella di prima.
      if (scopeChanged) refreshStaleDetails({ force: true }).catch(() => {});
    });

  } catch (e) {
    console.error('Firebase init error:', e);
    firebaseEnabled = false;
    updateSyncStatus('error');
  }
};

// [RIMOSSO] "Vedi lista pubblica" sostituiva a schermo la libreria con un elenco
// preconfezionato senza salvarlo: una terza identita' apparente, oltre a ospite
// e account, che rendeva impossibile capire di chi fossero i dati a video. Con
// due soli stati — ospite locale e account sincronizzato — la domanda non si
// pone piu'. La collezione /public non e' piu' letta da nessuna parte.

const setupAuth = () => {
  const modal = document.getElementById('authModal');
  const btn = document.getElementById('accountBtn');
  if (!modal || !btn) return;
  const close = () => { modal.style.display = 'none'; };

  btn.onclick = () => {
    updateAccountUi();
    modal.style.display = 'flex';
  };
  const closeBtn = document.getElementById('authClose');
  if (closeBtn) closeBtn.onclick = close;
  modal.onclick = (e) => { if (e.target === modal) close(); };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.style.display === 'flex') close();
  });

  // Se Firebase non e' configurato i pulsanti non devono restare li' a fingere.
  if (!firestoreDb) {
    const guest = document.getElementById('authGuest');
    if (guest) guest.innerHTML = '<p style="color:var(--text-muted);font-size:14px;margin:0;">Sincronizzazione non configurata: l\'app sta lavorando solo in locale su questo dispositivo.</p>';
    return;
  }

  const busy = async (button, fn) => {
    const original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<i class="fas fa-circle-notch fa-spin btn-icon"></i> Attendi...';
    try { await fn(); close(); }
    catch (e) {
      console.error('Auth:', e);
      const msg = authErrorMessage(e);
      if (msg) showError(msg);   // null = l'utente ha chiuso il popup, non e' un errore
    }
    finally { button.disabled = false; button.innerHTML = original; }
  };

  const anonBtn = document.getElementById('authAnonBtn');
  if (anonBtn) anonBtn.onclick = () => busy(anonBtn, () => firebase.auth().signInAnonymously());

  const googleBtn = document.getElementById('authGoogleBtn');
  if (googleBtn) googleBtn.onclick = () => busy(googleBtn, async () => {
    const provider = new firebase.auth.GoogleAuthProvider();

    // Se si e' entrati come anonimi, si COLLEGA l'account invece di crearne uno
    // nuovo: altrimenti la libreria costruita da ospite resterebbe orfana.
    if (currentUser?.isAnonymous) {
      try { await currentUser.linkWithPopup(provider); return; }
      catch (e) {
        if (e?.code === 'auth/popup-blocked' || e?.code === POPUP_UNSUPPORTED) {
          await currentUser.linkWithRedirect(provider);
          return;
        }
        if (e?.code !== 'auth/credential-already-in-use' && e?.code !== 'auth/email-already-in-use') throw e;

        // [FIX] Prima si cadeva in silenzio su signInWithPopup: l'utente entrava
        // nell'altro profilo e la libreria costruita da ospite spariva dalla
        // vista senza una parola. Ora glielo si dice, e puo' esportarla prima.
        const proceed = await confirmDialog({
          title: 'Questo Google e\' gia\' collegato a un altro profilo',
          message: 'Non posso unire i due profili. Se continui, entri nell\'altro account e la libreria costruita da ospite resta indietro: e\' salvata su questo dispositivo, ma non la vedrai piu\' nell\'app.\n\nSe ti serve, annulla ed esporta prima un backup dal menu ⋮.',
          confirmLabel: 'Entra nell\'altro account', danger: true,
        });
        if (!proceed) return;
      }
    }

    // [FIX PWA] In standalone su iOS i popup vengono bloccati o si aprono in un
    // contesto che non torna mai indietro: l'accesso con Google era di fatto
    // impossibile dall'app installata. Se il popup non e' praticabile si passa
    // al redirect, che getRedirectResult raccoglie al rientro.
    try {
      await firebase.auth().signInWithPopup(provider);
    } catch (e) {
      if (e?.code === 'auth/popup-blocked' || e?.code === POPUP_UNSUPPORTED) {
        await firebase.auth().signInWithRedirect(provider);
        return;
      }
      throw e;
    }
  });

  const logoutBtn = document.getElementById('authLogoutBtn');
  if (logoutBtn) logoutBtn.onclick = async () => {
    if (currentUser?.isAnonymous && !await confirmDialog({
      title: 'Esci dall\'account ospite',
      message: 'Questo profilo e\' anonimo: uscendo non c\'e\' modo di rientrarci e la copia nel cloud diventa irraggiungibile.\n\nTornerai a vedere la libreria locale di questo dispositivo, che e\' un\'altra cosa.',
      confirmLabel: 'Esci lo stesso', danger: true,
    })) return;
    close();
    await firebase.auth().signOut();
  };

  // [NUOVO] Senza questo, gli account anonimi e i loro documenti restano in
  // Firestore per sempre e l'utente non ha alcun modo di cancellare i propri
  // dati dal cloud.
  const deleteBtn = document.getElementById('authDeleteBtn');
  if (deleteBtn) deleteBtn.onclick = async () => {
    if (!currentUser) return;
    if (!await confirmDialog({
      title: 'Elimina l\'account e i dati nel cloud',
      message: 'Vengono cancellati i tre documenti di questo account su Firestore (elenco, voti, diario) e l\'account stesso.\n\nLa copia locale di questo dispositivo NON viene toccata: dopo l\'eliminazione tornerai a vederla come ospite.\n\nL\'operazione non e\' reversibile.',
      confirmLabel: 'Elimina definitivamente', danger: true,
    })) return;
    close();
    try {
      stopFirestoreListeners();
      firebaseEnabled = false;   // niente scritture di coda mentre si cancella
      await Promise.all([
        showsDocRef?.delete(),
        ratingsDocRef?.delete(),
        watchDataDocRef?.delete(),
      ].filter(Boolean));
      await currentUser.delete();
      showToast('Account eliminato. Stai vedendo la libreria locale di questo dispositivo.', 'success');
    } catch (e) {
      console.error('Eliminazione account:', e);
      if (e?.code === 'auth/requires-recent-login') {
        showError('Per sicurezza Firebase chiede un accesso recente: esci, rientra e riprova subito dopo.');
      } else {
        showError(`Eliminazione non riuscita: ${e?.message || e}`);
      }
    }
  };
};

// [FIX] Voti e diario non avevano alcuna protezione temporale: vinceva sempre
// l'ultimo snapshot arrivato, e il ramo "documento assente" spingeva su il
// locale senza guardare niente. Ora seguono la stessa regola di `shows` — campo
// `ts` scritto insieme ai dati e snapshot piu' vecchi del locale ignorati.
const listenToRatings = () => {
  if (!firebaseEnabled || !ratingsDocRef) return;
  unsubRatings = ratingsDocRef.onSnapshot((doc) => {
    if (doc.exists) {
      const remote = doc.data().data || {};
      const remoteTs = doc.data().ts || 0;
      if (JSON.stringify(remote) === JSON.stringify(ratingsData)) { updateSyncStatus('synced'); return; }
      if (remoteTs < ratingsTimestamp) {
        // [v17] Il locale e' piu' recente del cloud e diverso: una modifica fatta
        // prima che la sincronizzazione partisse (o offline) che non e' mai
        // salita. Prima la si ignorava e basta, e restava solo su questo
        // dispositivo finche' non se ne faceva un'altra.
        pushLocalRatings();
        return;
      }
      applyingRemoteRatings = true;
      ratingsData = remote;
      ratingsTimestamp = remoteTs;
      saveRatingsLocal();
      applyingRemoteRatings = false;
      updateSyncStatus('synced');
      scheduleRender();
    } else {
      ratingsDocRef.set({ data: ratingsData, ts: ratingsTimestamp, updatedAt: firebase.firestore.FieldValue.serverTimestamp() })
        .then(() => updateSyncStatus('synced'))
        .catch(() => updateSyncStatus('error'));
    }
  }, (err) => {
    console.error('Firebase listen ratings error:', err);
    updateSyncStatus('error');
  });
};

// [FIX RESET] Sync di tempo di visione + diario, su un documento separato da "shows"
// così un Reset (che sostituisce solo "shows" con i dati di default) non li tocca.
const listenToWatchData = () => {
  if (!firebaseEnabled || !watchDataDocRef) return;
  unsubWatch = watchDataDocRef.onSnapshot((doc) => {
    if (doc.exists) {
      const remote = doc.data().data || {};
      const remoteTs = doc.data().ts || 0;
      if (JSON.stringify(remote) === JSON.stringify(watchData)) return;
      if (remoteTs < watchTimestamp) { pushLocalWatchData(); return; } // [v17] vedi listenToRatings
      applyingRemoteWatchData = true;
      watchData = remote;
      watchTimestamp = remoteTs;
      saveWatchDataLocal();
      applyingRemoteWatchData = false;
      // [v17 FIX] Mancava del tutto: gli episodi segnati su un altro dispositivo
      // arrivavano in memoria ma "Riprendi da qui", le barre di avanzamento e le
      // statistiche restavano quelle vecchie fino al primo render causato da
      // qualcos'altro. E' meta' del "gli episodi aggiornati arrivano tardi".
      scheduleRender();
    } else {
      watchDataDocRef.set({ data: watchData, ts: watchTimestamp, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }).catch(() => {});
    }
  }, (err) => {
    console.error('Firebase listen watchdata error:', err);
  });
};

// FIX #1/#5: non svuotiamo mai la cache in blocco, la potiamo dei titoli non più presenti
const pruneDetailsCache = () => {
  const alive = new Set();
  for (const cat of data) for (const show of cat.shows) alive.add(show.title);
  let removed = false;
  for (const key of [...showDetailsCache.keys()]) if (!alive.has(key)) { showDetailsCache.delete(key); detailsFetchedAt.delete(key); removed = true; }
  if (removed) persistDetailsCache();
};

// [v17] Ora di download di ogni voce (title -> ms). E' cio' che decide se una
// voce va rinfrescata, e NON viene toccata dal salvataggio: prima ogni
// persistDetailsCache riscriveva ts = adesso per tutte le voci.
const detailsFetchedAt = new Map();
// Cresce di uno ogni volta che arriva un dato che cambia qualcosa a schermo:
// chi ha lanciato delle fetch confronta il valore prima e dopo per sapere se
// ridisegnare, senza dover confrontare a mano decine di campi.
let detailsVersion = 0;

// Solo i campi che finiscono a schermo fuori dalla scheda dettagli: prossimo
// episodio (badge, Prossime uscite, notifiche), stagioni ed episodi (Riprendi da
// qui, barre di avanzamento, Epopee), locandina, generi (ricerca, consigli).
const detailsSignature = (d) => d ? JSON.stringify([
  d.next_episode_to_air, d.last_episode_to_air?.air_date, d.number_of_seasons, d.number_of_episodes, d.status, d.poster_path,
  (d.seasons || []).map(s => [s.season_number, s.episode_count]), d.genre_ids,
]) : 'null';

// Deterministico per titolo, fra 0,8 e 1,2: senza, le voci scaricate tutte
// insieme (primo avvio, aggiornamento dell'app) scadrebbero anche tutte insieme,
// e ogni due settimane si ripresenterebbe la raffica di 150 richieste.
const freshnessJitter = (title) => 0.8 + (parseInt(hashString(String(title)), 16) % 401) / 1000;

const isWatchingTitle = (title) => data.some(c => isWatchingCat(c.name) && c.shows.some(s => s.title === title));

// Quanto puo' invecchiare una voce prima di andare riscaricata.
const detailsMaxAge = (title, d) => {
  if (d === null) return DETAILS_FRESH_MS.missing;
  if (isWatchingTitle(title)) return DETAILS_FRESH_MS.live;
  const status = d?.status;
  if (status === 'Ended' || status === 'Canceled') return DETAILS_FRESH_MS.settled * freshnessJitter(title);
  return DETAILS_FRESH_MS.active * freshnessJitter(title);
};

const isDetailsStale = (title) => {
  if (!showDetailsCache.has(title)) return true;
  const d = showDetailsCache.get(title);
  // Il "prossimo episodio" e' gia' uscito: il dato e' vecchio per definizione,
  // qualunque sia la sua eta'. E' il caso di "Prossime uscite" che mostra un
  // episodio di ieri invece di quello della settimana prossima.
  const ne = d?.next_episode_to_air?.air_date;
  if (ne) {
    const air = new Date(ne + 'T00:00:00');
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (!isNaN(air) && air < today) return true;
  }
  const at = detailsFetchedAt.get(title) || 0;
  return (Date.now() - at) > detailsMaxAge(title, d);
};

// Unico punto di scrittura dei dettagli arrivati da TMDB.
const storeDetails = (title, value) => {
  const had = showDetailsCache.has(title);
  const changed = !had || detailsSignature(showDetailsCache.get(title)) !== detailsSignature(value);
  showDetailsCache.set(title, value);
  detailsFetchedAt.set(title, Date.now());
  if (changed) detailsVersion++;
  persistDetailsCache();
};

// [PERF] Cache dettagli TMDB persistente: recupera al boot quello che già sappiamo.
// [v17] Si caricano TUTTE le voci, anche vecchie: una locandina o un elenco di
// stagioni di ieri sono molto meglio di una sezione vuota. Le vecchie vengono
// poi rinfrescate da refreshStaleDetails, senza bloccare il disegno.
const hydrateDetailsCacheFromStorage = () => {
  try {
    const raw = localStorage.getItem(DETAILS_CACHE_KEY);
    if (!raw) return;
    const stored = JSON.parse(raw);
    for (const [title, entry] of Object.entries(stored)) {
      if (!entry || typeof entry !== 'object' || !('data' in entry)) continue;
      showDetailsCache.set(title, entry.data);
      detailsFetchedAt.set(title, Number(entry.ts) || 0);
    }
  } catch (e) { console.warn('Cache dettagli non leggibile, verrà ricreata:', e); }
};

// Le fetch arrivano a gruppi (drag&drop, apertura app...): raggruppiamo i salvataggi
// in uno solo invece di scrivere su localStorage ad ogni singola risposta TMDB.
// [v17] Un secondo invece di 300 ms: durante un aggiornamento in background
// arrivano decine di risposte, e ogni salvataggio serializza l'intera cache.
let detailsCachePersistPending = false;
const persistDetailsCache = () => {
  if (detailsCachePersistPending) return;
  detailsCachePersistPending = true;
  setTimeout(() => {
    detailsCachePersistPending = false;
    try {
      const alive = new Set();
      for (const cat of data) for (const show of cat.shows) alive.add(show.title);
      const out = {};
      for (const [title, value] of showDetailsCache.entries()) {
        if (!alive.has(title)) continue;
        // Anche le voci null ("cercata, non trovata"): prima non si salvavano e
        // la ricerca testuale ripartiva a ogni apertura del sito.
        out[title] = { ts: detailsFetchedAt.get(title) || 0, data: value };
      }
      localStorage.setItem(DETAILS_CACHE_KEY, JSON.stringify(out));
    } catch (e) { console.warn('Impossibile salvare la cache dettagli (spazio pieno?):', e); }
  }, 1000);
};

const listenToShows = () => {
  if (!firebaseEnabled || !showsDocRef) return;
  unsubShows = showsDocRef.onSnapshot((doc) => {
    showsSnapshotSeen = true;
    // [FIX SYNC] Non applicare nulla mentre una nostra scrittura è ancora in corso:
    // eviterebbe di essere sovrascritti da uno snapshot che non riflette ancora
    // l'ultima modifica locale (es. una data appena aggiunta).
    if (pendingShowsWrite) return;
    if (!doc.exists) {
      showsDocRef.set({ data: data, ts: localDataTimestamp, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }).catch(() => {});
      return;
    }
    const remoteData = doc.data().data;
    const remoteTs = doc.data().ts || 0;
    if (!Array.isArray(remoteData)) return;
    const remoteJson = JSON.stringify(remoteData);
    if (remoteJson === lastShowsWrittenJson) { updateSyncStatus('synced'); return; } // eco della nostra scrittura
    if (remoteJson === JSON.stringify(data)) { updateSyncStatus('synced'); return; }  // già allineati
    // [FIX SYNC] Ignora snapshot più vecchi di quello che abbiamo già in locale:
    // questo è il bug che faceva "sparire" le date appena salvate al riavvio.
    // [v17] ...e se il locale e' piu' recente lo si fa salire (vedi listenToRatings).
    if (remoteTs < localDataTimestamp) { saveShowsToFirebase(); return; }
    applyingRemoteShows = true;
    data = remoteData;
    // Uno snapshot scritto da una versione precedente puo' non avere id/tag:
    // senza questo, confronto e tag smetterebbero di funzionare dopo un sync.
    ensureSchema();
    localDataTimestamp = remoteTs;
    localStorage.setItem(scopedKey('data'), JSON.stringify(data));
    localStorage.setItem(scopedKey('data-ts'), String(remoteTs));
    pruneDetailsCache();
    applyingRemoteShows = false;
    updateSyncStatus('synced');
    scheduleRender();
  }, (err) => {
    console.error('Firebase listen shows error:', err);
    updateSyncStatus('error');
  });
};

const saveShowsToFirebase = async () => {
  if (!firebaseEnabled || !showsDocRef || applyingRemoteShows) return true;
  const json = JSON.stringify(data);
  lastShowsWrittenJson = json;
  pendingShowsWrite = true;
  try {
    await showsDocRef.set({ data: JSON.parse(json), ts: localDataTimestamp, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
    updateSyncStatus('synced');
    return true;
  } catch (e) {
    console.error('Errore salvataggio shows su Firebase:', e);
    lastShowsWrittenJson = null;
    updateSyncStatus('error');
    return false;
  } finally {
    pendingShowsWrite = false;
  }
};

const loadRatings = () => {
  try { const s = localStorage.getItem(scopedKey('ratings')); if (s) ratingsData = JSON.parse(s); } catch(e) { ratingsData = {}; }
};
const saveRatingsLocal = () => {
  localStorage.setItem(scopedKey('ratings'), JSON.stringify(ratingsData));
  localStorage.setItem(scopedKey('ratings-ts'), String(ratingsTimestamp));
};

const saveRatings = async () => {
  // Il timestamp si alza solo quando la modifica nasce QUI: se stiamo applicando
  // uno snapshot remoto, alzarlo farebbe ignorare gli aggiornamenti successivi
  // dell'altro dispositivo.
  if (!applyingRemoteRatings) ratingsTimestamp = Date.now();
  saveRatingsLocal();
  if (applyingRemoteRatings || !firebaseEnabled || !ratingsDocRef) return;
  try {
    await ratingsDocRef.set({ data: ratingsData, ts: ratingsTimestamp, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
    updateSyncStatus('synced');
  } catch (e) {
    console.error('Errore salvataggio ratings su Firebase:', e);
    updateSyncStatus('error');
  }
};

// [FIX RESET] Persistenza di watchData (tempo di visione + diario), separata da "shows"
const loadWatchData = () => {
  try { const s = localStorage.getItem(scopedKey('watchdata')); if (s) watchData = JSON.parse(s); } catch(e) { watchData = {}; }
};
const saveWatchDataLocal = () => {
  localStorage.setItem(scopedKey('watchdata'), JSON.stringify(watchData));
  localStorage.setItem(scopedKey('watchdata-ts'), String(watchTimestamp));
};

// [v17] Rimanda su il locale SENZA alzare il timestamp: non e' una modifica
// nuova, e' una vecchia che non era arrivata al cloud.
const pushLocalRatings = () => {
  if (!firebaseEnabled || !ratingsDocRef || applyingRemoteRatings) return;
  ratingsDocRef.set({ data: ratingsData, ts: ratingsTimestamp, updatedAt: firebase.firestore.FieldValue.serverTimestamp() })
    .then(() => updateSyncStatus('synced'))
    .catch((e) => { console.error('Errore invio voti locali:', e); updateSyncStatus('error'); });
};
const pushLocalWatchData = () => {
  if (!firebaseEnabled || !watchDataDocRef || applyingRemoteWatchData) return;
  watchDataDocRef.set({ data: watchData, ts: watchTimestamp, updatedAt: firebase.firestore.FieldValue.serverTimestamp() })
    .catch((e) => console.error('Errore invio diario locale:', e));
};

const saveWatchData = async () => {
  if (!applyingRemoteWatchData) watchTimestamp = Date.now();
  saveWatchDataLocal();
  if (applyingRemoteWatchData || !firebaseEnabled || !watchDataDocRef) return true;
  try {
    await watchDataDocRef.set({ data: watchData, ts: watchTimestamp, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
    return true;
  } catch (e) {
    console.error('Errore salvataggio watchdata su Firebase:', e);
    return false;
  }
};

const calcAverage = (s) => (s.cast + s.trama + s.ambientazione + s.colonna_sonora + s.coinvolgimento) / 5;

// [VOTO PER STAGIONE] Da quando esistono i voti per stagione, una voce di
// ratingsData puo' esistere con le sole `seasons` dentro: chi vota la stagione
// 3 di una serie a cui non ha mai dato un voto complessivo. In quel caso
// `average` non c'e'.
// QUALUNQUE lettura di un voto passa da qui, altrimenti prima o poi si arriva a
// undefined.toFixed(1) — e succederebbe dentro doRender, cioe' a schermo bianco.
const ratingOf = (title) => {
  const e = ratingsData[title];
  return (e && typeof e.average === 'number') ? e : null;
};
const ratedTitles = () => Object.keys(ratingsData).filter(t => ratingOf(t));
const toStars = (val) => { const full = Math.round(val / 2); return '★'.repeat(full) + '☆'.repeat(5 - full); };

// ==================== [7/2] TEMPO DI VISIONE, DIARIO, STREAMING ====================
// Trova il riferimento "vivo" (categoria/indice/oggetto) di una serie a partire dal titolo.
// Serve perché le modali (dettagli) lavorano per titolo, ma per modificare i dati
// (date, note di diario) serve l'oggetto originale dentro `data`.
const findShowRef = (title) => {
  for (let ci = 0; ci < data.length; ci++) {
    const si = data[ci].shows.findIndex(s => s.title === title);
    if (si !== -1) return { catIdx: ci, showIdx: si, show: data[ci].shows[si], cat: data[ci] };
  }
  return null;
};

const isWatchingCat = (name) => (name || '').toLowerCase().includes('sto guardando');

// [2] Tracciamento automatico: si attiva SOLO quando una serie viene spostata
// esplicitamente (drag&drop o menu "Sposta in...") da/verso la categoria "Sto guardando".
// Le serie già presenti in una categoria (comprese quelle già in "Sto guardando" o già
// viste) NON ricevono date automaticamente: solo un bottone manuale nel dettaglio.
// [FIX RESET] Le date vivono in watchData (per titolo), non sull'oggetto show,
// così un Reset dell'elenco serie non le cancella.
const trackWatchTransition = (show, srcCat, dstCat) => {
  if (!show || !srcCat || !dstCat) return;
  const wasWatching = isWatchingCat(srcCat.name);
  const willWatch = isWatchingCat(dstCat.name);
  if (wasWatching === willWatch) return;
  const today = new Date().toISOString().slice(0, 10);
  const entry = watchData[show.title] = watchData[show.title] || {};
  let changed = false;
  if (!wasWatching && willWatch && !entry.startedAt) { entry.startedAt = today; changed = true; }
  else if (wasWatching && !willWatch && !entry.finishedAt) { entry.finishedAt = today; changed = true; }
  if (changed) saveWatchData();
};

const formatWatchDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d)) return '—';
  return d.toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' });
};

const computeWatchSummary = (watch) => {
  if (!watch) return null;
  if (watch.startedAt && watch.finishedAt) {
    const start = new Date(watch.startedAt + 'T00:00:00');
    const end = new Date(watch.finishedAt + 'T00:00:00');
    if (isNaN(start) || isNaN(end)) return null;
    const days = Math.max(0, Math.round((end - start) / 86400000));
    return { type: 'done', days };
  }
  if (watch.startedAt && !watch.finishedAt) {
    const start = new Date(watch.startedAt + 'T00:00:00');
    if (isNaN(start)) return null;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const days = Math.max(0, Math.round((today - start) / 86400000));
    return { type: 'ongoing', days };
  }
  return null;
};

// [4] Progresso episodi. La spunta per singolo episodio (checklist nel dettaglio)
// e' la fonte di verita' quando c'e'; altrimenti si ricade sul vecchio dato
// "stagione/episodio corrente", che resta comunque aggiornato per "Riprendi da
// qui", per la mini barra sulla card e per le notifiche.
const epKey = (s, e) => `${s}x${e}`;
const parseEpKey = (k) => {
  const [s, e] = String(k).split('x').map(Number);
  return (Number.isFinite(s) && Number.isFinite(e)) ? { season: s, episode: e } : null;
};

// [FIX] L'ordinamento lessicografico di Array.prototype.sort mette "10x1" prima
// di "2x1": prendere l'ultimo elemento dopo un sort() semplice riportava la
// serie indietro di otto stagioni. Qui il confronto e' numerico.
const lastWatchedEpisode = (keys) => {
  let best = null;
  for (const k of keys || []) {
    const p = parseEpKey(k);
    if (!p) continue;
    if (!best || p.season > best.season || (p.season === best.season && p.episode > best.episode)) best = p;
  }
  return best;
};

// Checklist implicita per chi aveva gia' impostato stagione/episodio prima che
// esistesse: tutto quello che viene prima risulta visto. Non viene salvata
// finche' l'utente non tocca davvero una casella (vedi markEpisode).
const derivedWatchedKeys = (title) => {
  const w = watchData[title] || {};
  const d = showDetailsCache.get(title);
  const out = [];
  if (!d?.seasons?.length || !w.currentSeason) return out;
  for (const s of d.seasons) {
    const count = s.episode_count || 0;
    if (s.season_number < w.currentSeason) {
      for (let e = 1; e <= count; e++) out.push(epKey(s.season_number, e));
    } else if (s.season_number === w.currentSeason) {
      const upto = Math.min(w.currentEpisode ?? 0, count);
      for (let e = 1; e <= upto; e++) out.push(epKey(s.season_number, e));
    }
  }
  return out;
};

const watchedKeysOf = (title) => {
  const w = watchData[title] || {};
  // Un array vuoto e' una scelta esplicita ("ho tolto tutte le spunte") e non
  // deve far ripartire la derivazione.
  return Array.isArray(w.watchedEpisodes) ? w.watchedEpisodes : derivedWatchedKeys(title);
};

const markEpisode = (title, season, episode, watched) => {
  const w = watchData[title] = watchData[title] || {};
  const list = new Set(watchedKeysOf(title));
  const key = epKey(season, episode);
  if (watched) list.add(key); else list.delete(key);
  w.watchedEpisodes = [...list];
  const last = lastWatchedEpisode(w.watchedEpisodes);
  w.currentSeason = last?.season ?? 1;
  w.currentEpisode = last?.episode ?? 0;
  // [v18] Quando hai toccato per l'ultima volta i progressi di questa serie:
  // le notifiche non ti chiedono "l'hai visto?" se l'hai appena segnato, e
  // "episodi da recuperare" parte solo dopo una settimana di silenzio.
  w.lastMarkedAt = Date.now();
};

const markSeason = (title, seasonNumber, episodeCount, watched) => {
  const w = watchData[title] = watchData[title] || {};
  const list = new Set(watchedKeysOf(title));
  for (let e = 1; e <= episodeCount; e++) {
    const key = epKey(seasonNumber, e);
    if (watched) list.add(key); else list.delete(key);
  }
  w.watchedEpisodes = [...list];
  const last = lastWatchedEpisode(w.watchedEpisodes);
  w.currentSeason = last?.season ?? 1;
  w.currentEpisode = last?.episode ?? 0;
  w.lastMarkedAt = Date.now();
};

const computeEpisodeProgress = (title) => {
  const d = showDetailsCache.get(title);
  if (!d?.seasons?.length) return null;
  const w = watchData[title];
  if (!w) return null;
  if (!Array.isArray(w.watchedEpisodes) && !w.currentSeason) return null;
  const valid = new Set();
  let total = 0;
  for (const s of d.seasons) {
    const count = s.episode_count || 0;
    total += count;
    for (let e = 1; e <= count; e++) valid.add(epKey(s.season_number, e));
  }
  if (!total) return null;
  // Le chiavi che non corrispondono a nessun episodio reale (stagione tolta da
  // TMDB, dato importato male) non devono gonfiare la percentuale.
  const keys = watchedKeysOf(title).filter(k => valid.has(k));
  const last = lastWatchedEpisode(keys);
  const pct = Math.max(0, Math.min(100, Math.round((keys.length / total) * 100)));
  return {
    watched: keys.length,
    total,
    pct,
    season: last?.season ?? (w.currentSeason || 1),
    episode: last?.episode ?? 0,
  };
};

// [PERF] I provider streaming vivevano solo in RAM: persistiamo anche questi
// (TTL più lungo, cambiano raramente) per evitare fetch ripetute ad ogni apertura del dettaglio.
const hydrateProvidersCacheFromStorage = () => {
  try {
    const raw = localStorage.getItem(PROVIDERS_CACHE_KEY);
    if (!raw) return;
    const stored = JSON.parse(raw);
    const now = Date.now();
    for (const [id, entry] of Object.entries(stored)) {
      if (entry && (now - entry.ts) < PROVIDERS_CACHE_TTL) watchProvidersCache.set(Number(id), entry.data);
    }
  } catch (e) { console.warn('Cache provider non leggibile:', e); }
};
let providersCachePersistPending = false;
const persistProvidersCache = () => {
  if (providersCachePersistPending) return;
  providersCachePersistPending = true;
  setTimeout(() => {
    providersCachePersistPending = false;
    try {
      const now = Date.now();
      const out = {};
      for (const [id, value] of watchProvidersCache.entries()) out[id] = { ts: now, data: value };
      localStorage.setItem(PROVIDERS_CACHE_KEY, JSON.stringify(out));
    } catch (e) { console.warn('Impossibile salvare cache provider:', e); }
  }, 300);
};

// [5] Disponibilità streaming: TMDB espone gratuitamente gli stessi dati di JustWatch
// tramite l'endpoint watch/providers, quindi non serve una chiave API separata.
const fetchWatchProviders = async (tmdbId) => {
  if (!tmdbId) return null;
  if (watchProvidersCache.has(tmdbId)) return watchProvidersCache.get(tmdbId);
  try {
    const res = await fetch(`https://api.themoviedb.org/3/tv/${tmdbId}/watch/providers?api_key=${TMDB_API_KEY}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const result = j.results?.IT || j.results?.US || null;
    watchProvidersCache.set(tmdbId, result);
    persistProvidersCache();
    return result;
  } catch (e) {
    console.warn('Errore fetch watch providers:', e);
    return null; // errore di rete: non mettiamo in cache, si riprova alla prossima apertura
  }
};

const renderProvidersHtml = (prov) => {
  if (!prov) return `<p style="color:var(--text-muted);font-size:13px;margin:8px 0 0;">Non risulta disponibile in streaming/noleggio in Italia al momento.</p>`;
  const groups = [
    { key: 'flatrate', label: 'In abbonamento' },
    { key: 'rent', label: 'Noleggio' },
    { key: 'buy', label: 'Acquisto' },
  ];
  let html = '';
  for (const g of groups) {
    const list = prov[g.key];
    if (!list?.length) continue;
    html += `<div class="wt-provider-group"><div class="wt-provider-group-label">${g.label}</div><div class="wt-provider-logos">${list.map(p => `<img class="wt-provider-logo" src="https://image.tmdb.org/t/p/w45${escapeHtml(p.logo_path || '')}" alt="${escapeHtml(p.provider_name)}" title="${escapeHtml(p.provider_name)}" loading="lazy">`).join('')}</div></div>`;
  }
  if (!html) return `<p style="color:var(--text-muted);font-size:13px;margin:8px 0 0;">Non risulta disponibile in streaming/noleggio in Italia al momento.</p>`;
  html += `<div class="wt-jw-attrib">Dati forniti da JustWatch${prov.link ? ` · <a href="${escapeHtml(prov.link)}" target="_blank" rel="noopener">vedi tutte le opzioni</a>` : ''}</div>`;
  return html;
};

// ==================== DRAG STATE ====================
const drag = { type: null, catIdx: null, showIdx: null, placeholder: null, lastDroppedTitle: null };

// ==================== UTIL ====================
// [SEC] Anche l'apice singolo viene escapato: oggi tutti gli attributi generati
// usano le virgolette doppie, ma è una garanzia che costa nulla mantenere.
const escapeHtml = (str) => String(str).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

// Toast unificato: errori (rosso) e conferme (verde, type 'success')
// [FIX] Il timer da 5s era anonimo: due toast ravvicinati e il timer del primo
// svuotava il contenitore cancellando il secondo in anticipo. Ora è uno solo,
// azzerato ad ogni nuovo toast.
let toastTimer = null;
// Se il toast in corso ha una scadenza con effetti (es. "passata la finestra di
// annullamento, ripulisci la cache"), va eseguita anche quando lo si sostituisce
// con un altro toast prima del tempo.
let toastOnExpire = null;

const clearToast = (runExpire = true) => {
  clearTimeout(toastTimer);
  const pending = toastOnExpire;
  toastOnExpire = null;
  const c = document.getElementById('errorContainer');
  if (c) c.innerHTML = '';
  if (runExpire && pending) pending();
};

const showToast = (msg, type = 'error') => {
  clearToast();
  const icon = type === 'success' ? 'fa-check-circle' : 'fa-exclamation-triangle';
  document.getElementById('errorContainer').innerHTML =
    `<div class="error-message${type === 'success' ? ' success' : ''}"><i class="fas ${icon}"></i> ${escapeHtml(msg)}</div>`;
  toastTimer = setTimeout(() => clearToast(), 5000);
};
const showError = (msg) => showToast(msg, 'error');

// [UNDO] Toast con un'azione. Sostituisce la conferma preventiva sulle
// eliminazioni: eliminare è immediato, ma per qualche secondo si può tornare
// indietro. Più veloce di un dialogo e più sicuro, perché protegge anche da chi
// il dialogo lo conferma per riflesso.
const UNDO_MS = 8000;
const showActionToast = (msg, actionLabel, onAction, { onExpire = null, ms = UNDO_MS } = {}) => {
  clearToast();
  const container = document.getElementById('errorContainer');
  container.innerHTML = `<div class="error-message undo" role="alert">
    <i class="fas fa-trash-can" aria-hidden="true"></i>
    <span class="toast-text">${escapeHtml(msg)}</span>
    <button type="button" class="toast-action"><i class="fas fa-rotate-left" aria-hidden="true"></i> ${escapeHtml(actionLabel)}</button>
    <span class="toast-timer" style="animation-duration:${ms}ms"></span>
  </div>`;
  toastOnExpire = onExpire;
  container.querySelector('.toast-action').onclick = () => {
    toastOnExpire = null;      // annullato: la scadenza non deve più scattare
    clearToast(false);
    onAction();
  };
  toastTimer = setTimeout(() => clearToast(), ms);
};

// ==================== [A11Y] MODALI ACCESSIBILI ====================
// Le modali sono create al volo in una decina di punti diversi. Invece di
// ritoccarle una per una, questo helper aggiunge a ciascuna: ruolo dialog,
// intrappolamento del Tab (altrimenti si tabba dietro all'overlay) e ritorno
// del focus all'elemento di partenza alla chiusura.
const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const registerModal = (modal, { labelSelector = '.modal-header h2' } = {}) => {
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  const labelEl = modal.querySelector(labelSelector);
  if (labelEl) {
    if (!labelEl.id) labelEl.id = `modal-label-${Math.random().toString(36).slice(2, 9)}`;
    modal.setAttribute('aria-labelledby', labelEl.id);
  }

  // Focus sul contenitore, non sul primo bottone: dà il contesto agli screen
  // reader senza far comparire un anello di focus a chi ha aperto col mouse.
  const content = modal.querySelector('.modal-content') || modal;
  if (!content.hasAttribute('tabindex')) content.setAttribute('tabindex', '-1');

  const previouslyFocused = document.activeElement;

  modal.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const items = [...modal.querySelectorAll(FOCUSABLE_SELECTOR)].filter(el => el.offsetParent !== null || el === document.activeElement);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === content)) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus();
    }
  });

  const originalRemove = modal.remove.bind(modal);
  modal.remove = () => {
    originalRemove();
    if (previouslyFocused && document.contains(previouslyFocused)) {
      try { previouslyFocused.focus({ preventScroll: true }); } catch (e) {}
    }
  };
  return modal;
};

// Il contenitore va messo a fuoco dopo l'inserimento nel DOM.
const mountModal = (modal, opts) => {
  document.body.appendChild(modal);
  registerModal(modal, opts);
  const content = modal.querySelector('.modal-content') || modal;
  setTimeout(() => { try { content.focus({ preventScroll: true }); } catch (e) {} }, 0);
  return modal;
};

// [14] Conferma nello stile dell'app al posto di confirm() nativo.
// Ritorna una Promise<boolean>: chiusura con X, "Annulla", click fuori o Esc = false.
const confirmDialog = ({ title, message, confirmLabel = 'Conferma', danger = false }) => new Promise((resolve) => {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `<div class="modal-content edit-modal"><div class="modal-header"><h2>${escapeHtml(title)}</h2><button class="modal-close" aria-label="Chiudi">&times;</button></div><div style="padding:24px 28px;"><p style="margin:0;color:var(--text-muted);font-size:14px;line-height:1.55;white-space:pre-line;">${escapeHtml(message)}</p></div><div class="edit-actions"><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="confirmYes">${escapeHtml(confirmLabel)}</button><button class="btn btn-secondary" id="confirmNo">Annulla</button></div></div>`;
  mountModal(modal);
  const close = (result) => { modal.remove(); resolve(result); };
  // letto dall'handler di Esc: senza questo la Promise resterebbe appesa per sempre
  modal.__dismiss = () => close(false);
  modal.querySelector('#confirmYes').onclick = () => close(true);
  modal.querySelector('#confirmNo').onclick = () => close(false);
  modal.querySelector('.modal-close').onclick = () => close(false);
  modal.onclick = (e) => { if (e.target === modal) close(false); };
  // [A11Y] Nelle conferme distruttive il focus iniziale va su "Annulla":
  // un Invio distratto non deve cancellare nulla.
  setTimeout(() => modal.querySelector(danger ? '#confirmNo' : '#confirmYes').focus(), 50);
});

// [13] Esc chiude la modale in cima alla pila (possono impilarsi: dettagli -> stagioni,
// voto -> dettaglio voto). Le modali di conferma passano dal loro __dismiss per
// risolvere la Promise invece di essere solo rimosse dal DOM.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const modals = document.querySelectorAll('.modal-overlay');
  if (!modals.length) return;
  const top = modals[modals.length - 1];
  if (typeof top.__dismiss === 'function') top.__dismiss();
  else top.remove();
});

// ==================== MENU FLOTTANTE (⋮) ====================
// [FIX] Il menu della card era un <div> in posizione assoluta DENTRO la card.
// Tre problemi che si sommavano:
//   1. .show-card:hover applica una transform, e una transform crea un contesto
//      di impilamento: passando il mouse su una card vicina, quella card veniva
//      disegnata SOPRA il menu aperto, che quindi diventava incliccabile;
//   2. il sottomenu "Sposta in..." si apriva solo su :hover, cioè mai su touch;
//   3. vicino al bordo inferiore o destro della finestra il pannello usciva
//      dallo schermo, senza modo di raggiungere le ultime voci.
// Qui il pannello viene creato in <body> con position:fixed. Fuori da qualsiasi
// contesto di impilamento e da qualsiasi overflow:hidden, quindi non può essere
// né coperto né tagliato; si posiziona rispetto al pulsante e si ribalta verso
// l'alto se sotto non c'è spazio. Lo usano sia il ⋮ delle card sia quello della
// barra in alto (che è dentro .top-bar, la quale ha overflow:hidden).
let floatingMenuState = null;

const closeFloatingMenu = ({ restoreFocus = false } = {}) => {
  if (!floatingMenuState) return;
  const { el, anchor: btn, teardown } = floatingMenuState;
  floatingMenuState = null;
  teardown();
  el.remove();
  if (btn) {
    btn.setAttribute('aria-expanded', 'false');
    btn.classList.remove('menu-open');
    if (restoreFocus && document.contains(btn)) { try { btn.focus({ preventScroll: true }); } catch (e) {} }
  }
};

const positionFloatingMenu = (el, btn, align) => {
  const r = btn.getBoundingClientRect();
  const gap = 6, margin = 8;
  el.style.maxHeight = 'none';
  const w = el.offsetWidth;
  const wanted = el.offsetHeight;
  const below = window.innerHeight - r.bottom - gap - margin;
  const above = r.top - gap - margin;
  // Si apre verso l'alto solo se sotto non ci sta E sopra c'è più spazio.
  const up = wanted > below && above > below;
  const maxH = Math.max(140, Math.round(up ? above : below));
  el.style.maxHeight = maxH + 'px';
  const h = Math.min(wanted, maxH);
  let top  = up ? r.top - h - gap : r.bottom + gap;
  let left = align === 'start' ? r.left : r.right - w;
  left = Math.max(margin, Math.min(left, window.innerWidth  - w - margin));
  top  = Math.max(margin, Math.min(top,  window.innerHeight - h - margin));
  el.style.left = Math.round(left) + 'px';
  el.style.top  = Math.round(top)  + 'px';
  el.dataset.direction = up ? 'up' : 'down';
};

// items: { icon, label, danger, onSelect } | { type:'submenu', icon, label, items }
//        | { type:'separator' } | { type:'note', label }
const buildMenuButton = (item) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'floating-menu-item' + (item.danger ? ' danger' : '');
  b.setAttribute('role', 'menuitem');
  b.innerHTML = `${item.icon ? `<i class="fas ${item.icon}" aria-hidden="true"></i>` : '<span class="floating-menu-icon-slot"></span>'}<span>${escapeHtml(item.label)}</span>`;
  if (item.disabled) { b.disabled = true; }
  return b;
};

const openFloatingMenu = (btn, items, { align = 'end' } = {}) => {
  // Secondo click sullo stesso pulsante: chiude (comportamento atteso di un ⋮).
  const wasThis = floatingMenuState && floatingMenuState.anchor === btn;
  closeFloatingMenu();
  if (wasThis) return;

  const el = document.createElement('div');
  el.className = 'floating-menu';
  el.setAttribute('role', 'menu');

  const addItems = (list, container, depth) => {
    for (const item of list) {
      if (item.type === 'separator') {
        const hr = document.createElement('div');
        hr.className = 'floating-menu-sep';
        container.appendChild(hr);
        continue;
      }
      if (item.type === 'note') {
        const n = document.createElement('div');
        n.className = 'floating-menu-note';
        n.textContent = item.label;
        container.appendChild(n);
        continue;
      }
      if (item.type === 'submenu') {
        // Fisarmonica dentro allo stesso pannello, non un riquadro a volo che
        // esce lateralmente: funziona identico con mouse, tastiera e dito.
        const wrap = document.createElement('div');
        wrap.className = 'floating-menu-sub';
        const head = buildMenuButton(item);
        head.classList.add('floating-menu-subhead');
        head.setAttribute('aria-expanded', 'false');
        head.insertAdjacentHTML('beforeend', '<i class="fas fa-chevron-down floating-menu-chevron" aria-hidden="true"></i>');
        const body = document.createElement('div');
        body.className = 'floating-menu-subbody';
        body.hidden = true;
        addItems(item.items, body, depth + 1);
        head.onclick = () => {
          const open = !body.hidden;
          body.hidden = open;
          head.setAttribute('aria-expanded', String(!open));
          wrap.classList.toggle('open', !open);
          positionFloatingMenu(el, btn, align);
          if (!open) body.querySelector('.floating-menu-item')?.focus();
        };
        wrap.appendChild(head); wrap.appendChild(body);
        container.appendChild(wrap);
        continue;
      }
      const b = buildMenuButton(item);
      b.onclick = () => { closeFloatingMenu(); item.onSelect?.(); };
      container.appendChild(b);
    }
  };
  addItems(items, el, 0);

  document.body.appendChild(el);
  positionFloatingMenu(el, btn, align);
  btn.setAttribute('aria-expanded', 'true');
  btn.classList.add('menu-open');

  const focusables = () => [...el.querySelectorAll('.floating-menu-item:not([disabled])')].filter(x => x.offsetParent !== null);
  const onDocPointer = (e) => { if (!el.contains(e.target) && !btn.contains(e.target)) closeFloatingMenu(); };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      // Fermato qui: senza stopPropagation l'Esc chiuderebbe ANCHE la modale
      // sottostante (il menu può essere aperto sopra una scheda dettagli).
      e.stopPropagation(); e.preventDefault(); closeFloatingMenu({ restoreFocus: true }); return;
    }
    if (e.key === 'Tab') { closeFloatingMenu(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const list = focusables();
    if (!list.length) return;
    e.preventDefault();
    const i = list.indexOf(document.activeElement);
    let next;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    else if (e.key === 'ArrowDown') next = i < 0 ? 0 : (i + 1) % list.length;
    else next = i < 0 ? list.length - 1 : (i - 1 + list.length) % list.length;
    list[next].focus();
  };
  const onReflow = () => { if (floatingMenuState) positionFloatingMenu(el, btn, align); };

  document.addEventListener('pointerdown', onDocPointer, true);
  document.addEventListener('keydown', onKey, true);
  // capture:true intercetta anche lo scroll dei contenitori interni (la lista
  // categorie, il corpo di una modale), non solo quello della finestra.
  window.addEventListener('scroll', onReflow, true);
  window.addEventListener('resize', onReflow);

  floatingMenuState = {
    el, anchor: btn,
    teardown: () => {
      document.removeEventListener('pointerdown', onDocPointer, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onReflow, true);
      window.removeEventListener('resize', onReflow);
    }
  };
  return el;
};

// ==================== PERSIST ====================
const saveData = async () => {
  localDataTimestamp = Date.now();
  localStorage.setItem(scopedKey('data-ts'), String(localDataTimestamp));
  localStorage.setItem(scopedKey('data'), JSON.stringify(data));
  return await saveShowsToFirebase();
};

// [v17] Per i campi che l'app ricava da TMDB (tmdbId, seasons_count,
// locandina): NON sono una modifica dell'utente e non alzano il timestamp.
// Prima passavano da saveData, e il riempimento fatto all'avvio bastava a
// rendere la copia locale "piu' recente" del cloud: lo snapshot con le modifiche
// fatte sul telefono veniva scartato come vecchio, e al primo salvataggio
// sovrascritto. Al cloud salgono solo dopo il primo snapshot, cioe' quando si sa
// che il locale non sta coprendo una versione piu' nuova.
const saveDerivedData = () => {
  try { localStorage.setItem(scopedKey('data'), JSON.stringify(data)); }
  catch (e) { console.warn('Salvataggio locale non riuscito:', e); }
  if (firebaseEnabled && showsSnapshotSeen) saveShowsToFirebase();
};

// ==================== LIBRERIE DI PARTENZA ====================
// Due file, due significati diversi. Non vanno confusi:
//
//   data/default-data.json   Le sole categorie, vuote. E' il punto di partenza
//                            di un account NUOVO e del Reset fatto da dentro un
//                            account: nessuno deve ritrovarsi in casa la lista
//                            di qualcun altro (era il bug corretto in v9).
//   data/Samuele-data.json   La libreria personale del proprietario, nel formato
//                            dei backup v2. Vale SOLO per lo scomparto 'guest',
//                            che e' questo browser e basta: li' "riparti da capo"
//                            vuol dire tornare a questa lista, non al vuoto.
//
// La scelta dipende SEMPRE dallo scomparto attivo (storeScope), mai da chi
// chiama: e' l'unica regola che impedisce alla libreria dell'ospite di finire
// dentro l'account di qualcun altro.
const DEFAULT_DATA_URL = './data/default-data.json';
const GUEST_SEED_URL   = './data/Samuele-data.json';

// Accetta entrambi i formati grazie a normalizeImport: l'array nudo di categorie
// (default-data.json) e l'oggetto backup con voti e diario (Samuele-data.json).
// Ritorna { cats, ratings, watch }.
const fetchLibraryFile = async (url) => {
  const res = await fetch(`${url}?t=${Date.now()}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  return normalizeImport(JSON.parse(text.replace(/^\uFEFF/, '')));
};

const loadEmptyLibrary = async () => {
  try {
    return (await fetchLibraryFile(DEFAULT_DATA_URL)).cats;
  } catch(err) {
    console.error('Errore caricamento struttura vuota:', err);
    showError(`Impossibile caricare i dati predefiniti: ${err.message}`);
    return [];
  }
};

// Se il file non c'e' (fork del progetto, deploy senza la cartella data, prima
// visita offline) si ripiega sulle categorie vuote: meglio partire spogli che
// non partire affatto.
// { fallback: false } serve al controllo della vetrina (refreshGuestSeedIfPristine):
// li' un file irraggiungibile vuol dire "non cambiare nulla", non "svuota".
const loadGuestSeed = async ({ fallback = true } = {}) => {
  try {
    return await fetchLibraryFile(GUEST_SEED_URL);
  } catch(err) {
    if (!fallback) throw err;
    console.warn('Libreria iniziale non disponibile, uso le categorie vuote:', err);
    return { cats: await loadEmptyLibrary(), ratings: null, watch: null };
  }
};

// Voti e diario del file di partenza vengono AGGIUNTI, mai sovrascritti: quello
// che c'e' gia' in questo browser vince sempre. Dalla v16 Samuele-data.json e'
// un backup completo, voti e diario compresi: e' la vetrina pubblica.
const mergeSeedSideStores = ({ ratings, watch }) => {
  const fill = (target, source) => {
    let touched = false;
    if (!source) return touched;
    for (const [key, value] of Object.entries(source)) {
      if (target[key] === undefined) { target[key] = value; touched = true; }
    }
    return touched;
  };
  if (fill(ratingsData, ratings)) saveRatings();
  if (fill(watchData, watch)) saveWatchData();
};

// Ospite: si riparte dalla libreria personale. Account: si riparte vuoti.
// Stessa regola del Reset, applicata al primo avvio di uno scomparto.
const loadStartingLibrary = async () => {
  if (storeScope !== GUEST_SCOPE) return await loadEmptyLibrary();
  const seed = await loadGuestSeed();
  mergeSeedSideStores(seed);
  // Solo se il file c'era davvero: il ripiego sulle categorie vuote non e' la
  // vetrina e non va timbrato come tale.
  if (seed.ratings !== null || seed.watch !== null || seed.cats.some(c => c.shows.length)) {
    pendingSeedId = seedIdOf(seed);
  }
  return seed.cats;
};

// ==================== [v16] VETRINA DELL'OSPITE SEMPRE AGGIORNATA ====================
// Chi apriva il sito una volta restava per sempre con la copia di quel giorno:
// initData legge prima localStorage, e Samuele-data.json non veniva piu'
// riscaricato. Ogni aggiornamento della libreria sul repo arrivava solo a chi
// non era mai passato.
//
// Ora, quando lo scomparto ospite viene riempito dal file, si salva un timbro:
// l'impronta del file e l'impronta del contenuto subito dopo. A ogni avvio, se
// il contenuto e' ancora identico a quel momento (l'ospite non ha toccato
// nulla) e il file sul sito e' cambiato, si passa alla versione nuova.
// Se invece l'ospite ha modificato anche solo un voto, la sua copia vince e
// non viene mai sovrascritta: il Reset resta il modo esplicito di tornare
// alla vetrina.
//
// Riguarda SOLO lo scomparto 'guest'. Gli account non leggono mai questo file.
let pendingSeedId = null;

const stableStringify = (v) => {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).filter(k => v[k] !== undefined).sort()
      .map(k => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
};

// FNV-1a a 32 bit: serve un confronto, non una firma crittografica.
const hashString = (str) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
};

const seedIdOf = (seed) => hashString(stableStringify({ cats: seed.cats, ratings: seed.ratings, watch: seed.watch }));

// Solo cio' che l'utente puo' cambiare: categorie, titoli, visioni, tag, voti,
// diario. id, addedAt, tmdbId, poster e seasons_count li riempie l'app da sola
// e non devono far credere che l'ospite abbia modificato qualcosa.
const guestContentHash = () => hashString(stableStringify({
  lib: data.map(c => [c.name, c.shows.map(s => [s.title, s.progress ?? null, (s.tags || []).join('|')])]),
  ratings: ratingsData,
  watch: watchData,
}));

const markSeedApplied = (seedId) => {
  if (storeScope !== GUEST_SCOPE || !seedId) return;
  try { localStorage.setItem(scopedKey('seed'), JSON.stringify({ seed: seedId, hash: guestContentHash() })); }
  catch (e) { console.warn('Timbro della libreria iniziale non salvato:', e); }
};

const refreshGuestSeedIfPristine = async () => {
  if (storeScope !== GUEST_SCOPE || !navigator.onLine) return false;
  let stamp = null;
  try { stamp = JSON.parse(localStorage.getItem(scopedKey('seed')) || 'null'); } catch (e) {}
  if (!stamp?.seed || !stamp?.hash) return false;       // copia di prima della v16: non si sa, non si tocca
  if (guestContentHash() !== stamp.hash) return false;  // l'ospite ha modificato qualcosa
  let seed;
  try { seed = await loadGuestSeed({ fallback: false }); } catch (e) { return false; }
  const seedId = seedIdOf(seed);
  if (seedId === stamp.seed) return false;
  // Durante la fetch si puo' aver fatto l'accesso o toccato qualcosa.
  if (storeScope !== GUEST_SCOPE || guestContentHash() !== stamp.hash) return false;
  data = seed.cats;
  ratingsData = seed.ratings || {};
  watchData = seed.watch || {};
  ensureSchema();
  saveData(); saveRatings(); saveWatchData();
  markSeedApplied(seedId);
  return true;
};

const initData = async () => {
  const saved = localStorage.getItem(scopedKey('data'));
  if (saved) {
    try { data = JSON.parse(saved); if (Array.isArray(data) && data.length) return; } catch(e) {}
  }
  // [v17] Lo scomparto di un account non si riempie mai da qui: la sua libreria
  // e' quella sul cloud, e una libreria di partenza salvata con un timestamp
  // nuovo farebbe scartare lo snapshot vero come "piu' vecchio".
  if (storeScope !== GUEST_SCOPE) { if (!Array.isArray(data)) data = []; return; }
  data = await loadStartingLibrary();
  // Il file di partenza non porta id, tag ne' date di aggiunta: senza questo,
  // confronto fra serie, tag e UID del calendario ICS nascono zoppi.
  ensureSchema();
  if (data.length) saveData();
};

// [FIX BACKUP] Prima qui usciva solo `data`: voti, tempo di visione, diario e
// avanzamento episodi restavano fuori dal file. Un "backup" che, ripristinato,
// riportava solo l'elenco dei titoli. Ora il file contiene i tre store.
const EXPORT_VERSION = 2;

const exportToFile = () => {
  const payload = {
    app: 'tvtracker',
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    data,
    ratings: ratingsData,
    watch: watchData,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tvtracker-backup-${new Date().toISOString().slice(0,19)}.json`;
  // [FIX] Firefox richiede che l'ancora sia nel documento, e revocare l'URL
  // subito dopo il click può interrompere il download prima che parta.
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
};

// Accetta entrambi i formati: l'array nudo dei backup vecchi (solo categorie) e
// il nuovo oggetto con voti e watch data. Normalizza in un'unica forma.
const normalizeImport = (parsed) => {
  let cats, ratings = null, watch = null;
  if (Array.isArray(parsed)) {
    cats = parsed;                       // backup v1: solo l'elenco
  } else if (parsed && Array.isArray(parsed.data)) {
    cats = parsed.data;                  // backup v2
    if (parsed.ratings && typeof parsed.ratings === 'object') ratings = parsed.ratings;
    if (parsed.watch   && typeof parsed.watch   === 'object') watch   = parsed.watch;
  } else {
    throw new Error('Formato non riconosciuto: serve un array di categorie o un backup TVTRACKER');
  }
  for (const cat of cats) {
    if (!cat || !cat.name || !Array.isArray(cat.shows)) throw new Error(`Categoria "${cat?.name ?? '?'}" non valida`);
  }
  return { cats, ratings, watch };
};

const importFromFile = (file) => {
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      openImportModeModal(normalizeImport(JSON.parse(e.target.result)));
    } catch(err) { showError(`Importazione fallita: ${err.message}`); }
  };
  reader.readAsText(file);
};

// [12] Unione: le categorie con lo stesso nome (case-insensitive) vengono fuse;
// le serie con lo stesso titolo già presenti nella categoria non vengono duplicate.
const mergeImportedData = ({ cats, ratings, watch }) => {
  for (const importedCat of cats) {
    let targetCat = data.find(c => c.name.toLowerCase() === importedCat.name.toLowerCase());
    if (!targetCat) {
      targetCat = { name: importedCat.name, shows: [] };
      data.push(targetCat);
    }
    const existingTitles = new Set(targetCat.shows.map(s => s.title.toLowerCase()));
    for (const show of importedCat.shows) {
      if (!existingTitles.has(show.title.toLowerCase())) {
        targetCat.shows.push(show);
        existingTitles.add(show.title.toLowerCase());
      }
    }
  }
  // In unione i dati locali vincono: si riempiono solo i buchi. Ripristinare un
  // backup di sei mesi fa non deve sovrascrivere un voto dato ieri.
  if (ratings) for (const [title, entry] of Object.entries(ratings)) {
    if (!entry || typeof entry !== 'object') continue;
    const local = ratingsData[title];
    if (!local) { ratingsData[title] = entry; continue; }
    // [VOTO PER STAGIONE] Prima la voce locale vinceva per intero: con i voti
    // per stagione vuol dire che un backup con le stagioni 1-4 votate, importato
    // dove c'e' solo il voto della serie, perdeva tutte e quattro le stagioni.
    // Anche quelli sono buchi, e si riempiono con la stessa regola: cio' che c'e'
    // in locale non si tocca, cio' che manca arriva dal file.
    let merged = local;
    if (typeof local.average !== 'number' && typeof entry.average === 'number') {
      const { seasons: _fromFile, ...overallOnly } = entry;
      merged = local.seasons ? { ...overallOnly, seasons: local.seasons } : overallOnly;
    }
    if (entry.seasons && typeof entry.seasons === 'object') {
      const seasons = { ...(merged.seasons || {}) };
      for (const [n, v] of Object.entries(entry.seasons)) if (!seasons[n]) seasons[n] = v;
      merged = { ...merged, seasons };
    }
    ratingsData[title] = merged;
  }
  if (watch)   for (const [title, entry] of Object.entries(watch))   if (!watchData[title])   watchData[title]   = entry;
  // Un backup vecchio non ha id ne' tag: senza questo le serie importate non
  // sarebbero confrontabili e non finirebbero nel file .ics con un UID stabile.
  ensureSchema();
};

// [12] Chiede sempre come procedere: sostituire tutto (comportamento di prima,
// rischioso se importato per sbaglio) oppure unire con quello che c'è già.
const openImportModeModal = (bundle) => {
  const { cats, ratings, watch } = bundle;
  const totalImported = cats.reduce((sum, c) => sum + c.shows.length, 0);
  const extras = [];
  if (ratings) extras.push(`${Object.keys(ratings).length} valutazioni`);
  if (watch)   extras.push(`${Object.keys(watch).length} schede di visione (date e diario)`);
  const extrasHtml = extras.length
    ? `<p style="color:var(--text-muted);font-size:13px;margin:0;">Il backup contiene anche <strong>${escapeHtml(extras.join('</strong> e <strong>'))}</strong>.</p>`
    : `<p style="color:var(--text-muted);font-size:13px;margin:0;">Backup in formato vecchio: contiene solo l'elenco, senza voti né diario.</p>`;
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `<div class="modal-content edit-modal"><div class="modal-header"><h2><i class="fas fa-upload"></i> Importa backup</h2><button class="modal-close" aria-label="Chiudi">&times;</button></div><div style="padding:24px 28px;display:flex;flex-direction:column;gap:12px;">
    <p style="color:var(--text-muted);font-size:13px;margin:0;">Il file contiene <strong>${cats.length}</strong> categorie e <strong>${totalImported}</strong> serie.</p>
    ${extrasHtml}
    <button class="btn btn-primary" id="importMerge" style="justify-content:flex-start;"><i class="fas fa-code-merge btn-icon"></i> Unisci con l'elenco attuale</button>
    <button class="btn btn-danger" id="importReplace" style="justify-content:flex-start;"><i class="fas fa-triangle-exclamation btn-icon"></i> Sostituisci tutto</button>
    <button class="btn btn-secondary" id="importCancel">Annulla</button>
  </div></div>`;
  mountModal(modal);
  const closeModal = () => modal.remove();
  modal.querySelector('.modal-close').onclick = closeModal;
  modal.querySelector('#importCancel').onclick = closeModal;
  modal.onclick = (e) => { if (e.target === modal) closeModal(); };

  // Voti e watch data hanno il loro store e la loro sincronizzazione: vanno
  // salvati a parte, altrimenti restano solo in memoria fino al reload.
  const persistExtras = async () => {
    const jobs = [];
    if (ratings) jobs.push(saveRatings());
    if (watch)   jobs.push(saveWatchData());
    if (jobs.length) {
      const results = await Promise.all(jobs);
      if (results.some(ok => ok === false)) showError('Importato in locale, ma la sincronizzazione cloud non è riuscita (verrà ritentata).');
    }
  };

  modal.querySelector('#importReplace').onclick = async () => {
    data = cats;
    if (ratings) ratingsData = ratings;
    if (watch)   watchData   = watch;
    saveData();
    await persistExtras();
    pruneDetailsCache();
    closeModal();
    await render();
    showToast('Backup ripristinato (sostituito) con successo!', 'success');
  };
  modal.querySelector('#importMerge').onclick = async () => {
    mergeImportedData(bundle);
    saveData();
    await persistExtras();
    pruneDetailsCache();
    closeModal();
    await render();
    showToast('Backup unito con successo!', 'success');
  };
};

// ==================== TMDB API ====================
// [v17] { urgent: true } scavalca la fila: l'aggiornamento in background puo'
// accodare un centinaio di richieste, e la scheda dettagli aperta dall'utente
// non deve aspettare che finiscano.
class RateLimitedQueue {
  constructor(limit = 3) { this.limit = limit; this.running = 0; this.queue = []; }
  async add(fn, { urgent = false } = {}) {
    if (this.running >= this.limit) await new Promise(r => (urgent ? this.queue.unshift(r) : this.queue.push(r)));
    this.running++;
    try { return await fn(); }
    finally { this.running--; if (this.queue.length) this.queue.shift()(); }
  }
}
const apiQueue = new RateLimitedQueue(5);
const inFlightDetails = new Map(); // evita fetch duplicati in parallelo sullo stesso titolo
// [FIX LOOP] tiene traccia di QUANDO una fetch è fallita per un titolo, per non
// ritentarla subito di nuovo (vedi prefetchDetails più sotto e il catch in fetchShowDetails).
const failedFetchAt = new Map(); // title -> timestamp dell'ultimo fallimento
const FAILED_RETRY_COOLDOWN = 5 * 60 * 1000; // aspetta 5 minuti prima di ritentare un titolo fallito

// [FIX TMDB] Distanza di Levenshtein normalizzata (0 = identico, 1 = completamente diverso)
// Per scegliere il risultato TMDB più simile al titolo cercato, invece di fidarsi
// dell'ordinamento TMDB che cambia nel tempo e per popolarità.
const levenshteinDistance = (a, b) => {
  const aL = a.length, bL = b.length;
  const d = Array(bL + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= aL; i++) {
    const t = [i];
    for (let j = 1; j <= bL; j++) {
      t.push(Math.min(
        d[j] + 1,
        t[j - 1] + 1,
        d[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      ));
    }
    Object.assign(d, t);
  }
  return d[bL] / Math.max(aL, bL);
};

const findBestMatch = (query, results) => {
  if (!results?.length) return null;
  const queryLower = query.toLowerCase().trim();
  let bestResult = results[0];
  let bestScore = -1;
  for (const r of results) {
    const name = (r.name || '').toLowerCase().trim();
    const original = (r.original_name || '').toLowerCase().trim();
    // Priorità: exact match > 95% simile > primo risultato
    if (name === queryLower || original === queryLower) return r;
    const nameScore = 1 - levenshteinDistance(queryLower, name);
    const origScore = 1 - levenshteinDistance(queryLower, original);
    const score = Math.max(nameScore, origScore);
    if (score > bestScore && score > 0.8) { // almeno 80% di somiglianza
      bestScore = score;
      bestResult = r;
    }
  }
  return bestResult;
};

// Versione dello schema della cache dettagli. Le voci salvate prima che
// esistessero trailer e cast non hanno quei campi: invece di invalidare tutta la
// cache in blocco (145 rifetch tutte insieme al primo avvio), si ricarica la
// singola serie quando se ne apre la scheda. Vedi openShowDetails.
const DETAILS_SCHEMA_VERSION = 2;

// Un solo trailer, scelto con criterio: prima l'ufficiale italiano, poi
// l'ufficiale inglese, poi qualsiasi trailer, poi un teaser. Solo YouTube,
// perché è l'unico host per cui sappiamo costruire l'URL.
const pickTrailer = (videos) => {
  const yt = (videos || []).filter(v => v.site === 'YouTube' && v.key);
  if (!yt.length) return null;
  const pick =
    yt.find(v => v.type === 'Trailer' && v.official && v.iso_639_1 === 'it') ||
    yt.find(v => v.type === 'Trailer' && v.iso_639_1 === 'it') ||
    yt.find(v => v.type === 'Trailer' && v.official) ||
    yt.find(v => v.type === 'Trailer') ||
    yt.find(v => v.type === 'Teaser') ||
    yt[0];
  return pick ? { key: pick.key, name: pick.name || 'Trailer', lang: pick.iso_639_1 || '' } : null;
};

const slimEpisode = (ep) => ep ? {
  air_date: ep.air_date,
  episode_number: ep.episode_number,
  season_number: ep.season_number,
  name: ep.name,
  still_path: ep.still_path || null,
} : null;

// [v17] { force: true } riscarica anche se la voce c'e' gia' (aggiornamento in
// background). Se la rete fallisce si tiene e si restituisce la voce vecchia:
// un dato di ieri e' meglio di "Impossibile caricare i dettagli".
const fetchShowDetails = async (title, knownId = null, { force = false, urgent = false } = {}) => {
  if (!title) return null;
  if (!force && showDetailsCache.has(title)) return showDetailsCache.get(title);
  if (inFlightDetails.has(title)) return inFlightDetails.get(title);

  const p = apiQueue.add(async () => {
    try {
      // [PERF] Se conosciamo già l'ID TMDB della serie (salvato dopo il primo
      // fetch, o scelto dall'autocomplete) saltiamo del tutto la ricerca testuale:
      // dimezza le chiamate di rete per le serie già viste in passato.
      let tmdbId = knownId;
      if (!tmdbId) {
        const sr = await fetch(`https://api.themoviedb.org/3/search/tv?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(title)}&language=it-IT`);
        if (!sr.ok) throw new Error(`search HTTP ${sr.status}`);
        const sj = await sr.json();
        if (!sj.results?.length) { storeDetails(title, null); return null; }
        tmdbId = findBestMatch(title, sj.results).id; // [FIX TMDB] fuzzy matching
      }
      // credits e videos arrivano nella STESSA chiamata con append_to_response:
      // trailer e cast non costano quindi nessuna richiesta in più. Di entrambi
      // si conserva solo il minimo indispensabile (vedi sotto): la risposta
      // grezza contiene centinaia di nomi e decine di video, e questa cache
      // finisce in localStorage.
      const dr = await fetch(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${TMDB_API_KEY}&language=it-IT&append_to_response=credits,videos&include_video_language=it,en,null`);
      if (!dr.ok) throw new Error(`details HTTP ${dr.status}`);
      const details = await dr.json();
      const filteredSeasons = (details.seasons||[]).filter(s=>s.season_number>0).sort((a,b)=>a.season_number-b.season_number);
      const showDetails = {
        v: DETAILS_SCHEMA_VERSION,
        id: details.id, title: details.name, original_title: details.original_name,
        overview: details.overview||'Nessuna descrizione disponibile.',
        poster_path: details.poster_path,
        vote_average: