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
  if (schemaChanged) await saveData();
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
const DETAILS_CACHE_TTL = 12 * 60 * 60 * 1000; // 12h: compromesso tra velocità e dati aggiornati (prossimi episodi)
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
const NOTIF_STORE_KEY = 'tvtracker-notified';

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
const stopFirestoreListeners = () => {
  if (unsubShows)   { try { unsubShows(); }   catch (e) {} unsubShows = null; }
  if (unsubRatings) { try { unsubRatings(); } catch (e) {} unsubRatings = null; }
  if (unsubWatch)   { try { unsubWatch(); }   catch (e) {} unsubWatch = null; }
};

const countShows = (cats) => Array.isArray(cats)
  ? cats.reduce((n, c) => n + (Array.isArray(c?.shows) ? c.shows.length : 0), 0)
  : 0;

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

    const emptyLibrary = await loadDefaultData();
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
      // giusti. Al primo giro previousScope e nextScope coincidono solo se
      // l'utente e' gia' ospite, quindi la guardia evita una ricarica inutile.
      if (nextScope !== previousScope || !scopeInitialised) {
        applyScope(nextScope);
        scopeInitialised = true;
      }

      if (user) {
        const refs = userDocRefs(firestoreDb, user.uid);
        showsDocRef = refs.shows;
        ratingsDocRef = refs.ratings;
        watchDataDocRef = refs.watch;
        firebaseEnabled = true;
        updateSyncStatus('connecting');
        const isNewAccount = await createEmptyUserDocs();
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
      render();
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
      if (remoteTs < ratingsTimestamp) { updateSyncStatus('synced'); return; }
      applyingRemoteRatings = true;
      ratingsData = remote;
      ratingsTimestamp = remoteTs;
      saveRatingsLocal();
      applyingRemoteRatings = false;
      updateSyncStatus('synced');
      render();
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
      if (remoteTs < watchTimestamp) return;
      applyingRemoteWatchData = true;
      watchData = remote;
      watchTimestamp = remoteTs;
      saveWatchDataLocal();
      applyingRemoteWatchData = false;
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
  for (const key of [...showDetailsCache.keys()]) if (!alive.has(key)) { showDetailsCache.delete(key); removed = true; }
  if (removed) persistDetailsCache();
};

// [PERF] Cache dettagli TMDB persistente: recupera al boot quello che già sappiamo
const hydrateDetailsCacheFromStorage = () => {
  try {
    const raw = localStorage.getItem(DETAILS_CACHE_KEY);
    if (!raw) return;
    const stored = JSON.parse(raw);
    const now = Date.now();
    for (const [title, entry] of Object.entries(stored)) {
      if (entry && (now - entry.ts) < DETAILS_CACHE_TTL) showDetailsCache.set(title, entry.data);
    }
  } catch (e) { console.warn('Cache dettagli non leggibile, verrà ricreata:', e); }
};

// Le fetch arrivano a gruppi (drag&drop, apertura app...): raggruppiamo i salvataggi
// in uno solo invece di scrivere su localStorage ad ogni singola risposta TMDB.
let detailsCachePersistPending = false;
const persistDetailsCache = () => {
  if (detailsCachePersistPending) return;
  detailsCachePersistPending = true;
  setTimeout(() => {
    detailsCachePersistPending = false;
    try {
      const alive = new Set();
      for (const cat of data) for (const show of cat.shows) alive.add(show.title);
      const now = Date.now();
      const out = {};
      for (const [title, value] of showDetailsCache.entries()) {
        if (value && alive.has(title)) out[title] = { ts: now, data: value };
      }
      localStorage.setItem(DETAILS_CACHE_KEY, JSON.stringify(out));
    } catch (e) { console.warn('Impossibile salvare la cache dettagli (spazio pieno?):', e); }
  }, 300);
};

const listenToShows = () => {
  if (!firebaseEnabled || !showsDocRef) return;
  unsubShows = showsDocRef.onSnapshot((doc) => {
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
    if (remoteTs < localDataTimestamp) { updateSyncStatus('synced'); return; }
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
    render();
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

const loadDefaultData = async () => {
  try {
    const res = await fetch(`./data/default-data.json?t=${Date.now()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const d = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (!Array.isArray(d)) throw new Error('Formato non valido');
    return d;
  } catch(err) {
    console.error('Errore caricamento default:', err);
    showError(`Impossibile caricare i dati predefiniti: ${err.message}`);
    return [];
  }
};

const initData = async () => {
  const saved = localStorage.getItem(scopedKey('data'));
  if (saved) {
    try { data = JSON.parse(saved); if (Array.isArray(data) && data.length) return; } catch(e) {}
  }
  data = await loadDefaultData();
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
  if (ratings) for (const [title, entry] of Object.entries(ratings)) if (!ratingsData[title]) ratingsData[title] = entry;
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
class RateLimitedQueue {
  constructor(limit = 3) { this.limit = limit; this.running = 0; this.queue = []; }
  async add(fn) {
    if (this.running >= this.limit) await new Promise(r => this.queue.push(r));
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

const fetchShowDetails = async (title, knownId = null) => {
  if (!title) return null;
  if (showDetailsCache.has(title)) return showDetailsCache.get(title);
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
        if (!sj.results?.length) { showDetailsCache.set(title, null); return null; }
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
        vote_average: details.vote_average?.toFixed(1)||'N/A',
        first_air_date: details.first_air_date||'Sconosciuta',
        number_of_seasons: filteredSeasons.length,
        number_of_episodes: details.number_of_episodes||0,
        genres: details.genres?.map(g=>g.name).join(', ')||'Nessun genere',
        genre_ids: details.genres?.map(g=>g.id) || [],
        genre_names: details.genres?.map(g=>g.name) || [],
        seasons: filteredSeasons, status: details.status||'Sconosciuto',
        networks: details.networks?.map(n=>n.name).join(', ')||'N/A',
        episode_run_time: details.episode_run_time?.length ? details.episode_run_time : [42],
        next_episode_to_air: details.next_episode_to_air ? {
          air_date: details.next_episode_to_air.air_date,
          episode_number: details.next_episode_to_air.episode_number,
          season_number: details.next_episode_to_air.season_number,
          name: details.next_episode_to_air.name
        } : null,
        cast: (details.credits?.cast || []).slice(0, 6).map(c => ({
          name: c.name, character: c.character || '', profile_path: c.profile_path || null
        })),
        trailer: pickTrailer(details.videos?.results),
        backdrop_path: details.backdrop_path || null
      };
      showDetailsCache.set(title, showDetails);
      persistDetailsCache(); // [PERF] disponibile subito anche nella prossima sessione
      failedFetchAt.delete(title); // [FIX LOOP] se ora va a buon fine, cancella eventuali fallimenti precedenti
      return showDetails;
    } catch(e) {
      console.warn(`Errore fetch ${title}:`, e);
      // [FIX LOOP] senza questo, una serie che fallisce sempre (rate limit TMDB,
      // errore di rete persistente...) veniva ritentata ad OGNI render, e ogni
      // render la richiamava di nuovo perché prefetchDetails segnalava "novità"
      // anche a fetch fallita: un ciclo infinito che martellava l'API e allagava
      // il DOM di nuovi elementi (form per-categoria ricreati ad ogni giro).
      failedFetchAt.set(title, Date.now());
      return null; // errore di rete: NON mettiamo in cache "per sempre", ma non si ritenta a raffica
    } finally {
      inFlightDetails.delete(title);
    }
  });

  inFlightDetails.set(title, p);
  return p;
};

// [FIX PERF] Senza knownId questa funzione registrava per prima la promise in
// inFlightDetails: la chiamata successiva con show.tmdbId riceveva la stessa
// promise e la ricerca testuale veniva fatta comunque, annullando il risparmio.
const fetchPoster = async (title, knownId = null) => {
  if (!title) return null;
  const d = await fetchShowDetails(title, knownId);
  if (d?.poster_path) return TMDB_IMG + d.poster_path;
  return null;
};

// [PERF] Non blocca più il primo disegno a schermo: chi la chiama può scegliere
// di non aspettarla (vedi doRender). Se una serie è già in cache (anche perché
// recuperata da localStorage all'avvio) il backfill di tmdbId/seasons_count
// avviene subito, in modo sincrono, senza nessuna rete.
// Ritorna true se sono arrivati dati nuovi da TMDB (vale la pena ridisegnare).
const prefetchDetails = async () => {
  const tasks = [];
  let showsUpdated = false;
  const backfill = (show, cached) => {
    if (!cached) return;
    // [FIX LOOP] controlliamo che il valore in cache sia valido prima di copiarlo:
    // se fosse undefined (es. voce di cache vecchia/malformata), assegnarlo
    // comunque lascerebbe show.tmdbId/seasons_count "ancora da impostare" per
    // sempre, riattivando showsUpdated=true (e quindi il re-render) ad ogni giro.
    if (!show.tmdbId && cached.id) { show.tmdbId = cached.id; showsUpdated = true; }
    if (show.seasons_count === undefined && cached.number_of_seasons !== undefined) { show.seasons_count = cached.number_of_seasons; showsUpdated = true; }
  };
  for (const cat of data) {
    for (const show of cat.shows) {
      if (!show.poster && navigator.onLine) tasks.push(fetchPoster(show.title, show.tmdbId).then(url => { if (url) { show.poster = url; showsUpdated = true; } }));
      if (showDetailsCache.has(show.title)) { backfill(show, showDetailsCache.get(show.title)); continue; }
      if (!navigator.onLine) continue;
      // [FIX LOOP] se questo titolo è fallito di recente, non ritentarlo subito:
      // altrimenti un fallimento persistente (rate limit, errore di rete) faceva
      // ripartire la fetch ad ogni singolo render, all'infinito.
      const lastFail = failedFetchAt.get(show.title);
      if (lastFail && (Date.now() - lastFail) < FAILED_RETRY_COOLDOWN) continue;
      tasks.push(fetchShowDetails(show.title, show.tmdbId).then(d => backfill(show, d)));
    }
  }
  if (!tasks.length) { if (showsUpdated) saveData(); return showsUpdated; }
  startLoading();
  try { await Promise.all(tasks); } finally { stopLoading(); }
  if (showsUpdated) saveData();
  // [FIX LOOP] prima si ritornava "true" solo perché erano partite delle fetch,
  // anche se tutte fallite e senza cambiare nulla: questo causava il re-render
  // continuo. Ora si ridisegna solo se è arrivato davvero qualcosa di nuovo.
  return showsUpdated;
};

// ==================== SEARCH ====================
// Un solo campo per due lavori: filtra la libreria a ogni tasto (istantaneo,
// tutto locale) e, con almeno 3 caratteri, interroga TMDB per proporre le serie
// che NON hai ancora. La ricerca globale non e' piu' un secondo campo: e' la
// coda naturale della prima.
const setupSearch = () => {
  const input = document.getElementById('searchInput');
  const clearBtn = document.getElementById('searchClear');
  if (!input || !clearBtn) return;

  const reset = () => {
    input.value = '';
    searchQuery = '';
    clearBtn.classList.remove('visible');
    applySearch();
    closeTmdbSuggestions();
  };

  input.addEventListener('input', () => {
    searchQuery = input.value.trim().toLowerCase();
    clearBtn.classList.toggle('visible', searchQuery.length > 0);
    applySearch();
    queueTmdbSuggestions(input.value.trim());
  });

  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') reset(); });
  clearBtn.addEventListener('click', () => { reset(); input.focus(); });
};

// [1] Ricerca "fuzzy": tollera piccoli refusi (es. "breking bad" trova "Breaking Bad").
// NB: l'esempio nel commento originale era "breakin bd", che in realtà NON ha mai
// funzionato — la guardia qw.length < 3 qui sotto scarta "bd" prima di arrivare
// al confronto. È voluto: sulle parole di una o due lettere il fuzzy produrrebbe
// troppi falsi positivi. Corretto l'esempio, non il comportamento.
// Riusa la stessa levenshteinDistance già usata per il match dei risultati TMDB.
const fuzzyMatch = (query, title) => {
  if (!query) return true;
  const t = title.toLowerCase();
  if (t.includes(query)) return true; // corrispondenza esatta: percorso veloce
  const qWords = query.split(/\s+/).filter(Boolean);
  const tWords = t.split(/\s+/).filter(Boolean);
  if (!qWords.length || !tWords.length) return false;
  return qWords.every(qw => tWords.some(tw => {
    if (tw.includes(qw) || qw.includes(tw)) return true;
    if (qw.length < 3) return false; // parole troppo corte: il fuzzy darebbe troppi falsi positivi
    return levenshteinDistance(qw, tw) <= 0.34;
  }));
};

// [RICERCA GENERI] I nomi dei generi sono già in showDetailsCache (arrivano con
// i dettagli TMDB che l'app scarica comunque) e vengono scritti su data-genres
// al momento del render. Il confronto è quindi puramente locale: zero chiamate
// di rete, zero costi, e in pratica zero tempo — è un includes su una stringa di
// una ventina di caratteri per card.
const genreMatch = (query, genresAttr) => {
  if (!genresAttr) return false;
  return genresAttr.split('|').some(g => g.includes(query) || fuzzyMatch(query, g));
};

const applySearch = () => {
  const info = document.getElementById('searchResultsInfo');
  if (!info) return;
  if (!searchQuery) {
    document.querySelectorAll('.show-card, .show-row').forEach(c => c.classList.remove('search-hidden'));
    document.querySelectorAll('.category').forEach(cat => cat.style.display = '');
    info.hidden = true;
    return;
  }
  let totalVisible = 0, byGenre = 0;
  document.querySelectorAll('.category').forEach(catEl => {
    const cards = catEl.querySelectorAll('.show-card, .show-row');
    let catVisible = 0;
    cards.forEach(card => {
      const titleEl = card.querySelector('.show-title');
      const title = titleEl ? titleEl.textContent.toLowerCase() : '';
      const titleHit = fuzzyMatch(searchQuery, title);
      const genreHit = !titleHit && genreMatch(searchQuery, card.dataset.genres);
      // I tag sono scritti a mano dall'utente: la corrispondenza e' esatta
      // (contiene), senza fuzzy, per non far comparire risultati inspiegabili.
      const tagHit = !titleHit && !genreHit && (card.dataset.tags || '').split('|').some(t => t && t.includes(searchQuery));
      const matches = titleHit || genreHit || tagHit;
      card.classList.toggle('search-hidden', !matches);
      if (matches) catVisible++;
      if (genreHit) byGenre++;
    });
    totalVisible += catVisible;
    catEl.style.display = catVisible === 0 ? 'none' : '';
  });
  info.hidden = false;
  // Va detto quante arrivano dal genere: altrimenti cercando "thriller" e
  // vedendo comparire serie senza quella parola nel titolo sembra un errore.
  const genreNote = byGenre ? ` <span class="search-genre-note">(${byGenre} per genere)</span>` : '';
  const head = totalVisible
    ? `<strong>${totalVisible}</strong> nella tua libreria${genreNote}`
    : 'Nessun risultato nella tua libreria';
  info.innerHTML = head;
};

// ==================== AUTOCOMPLETE TMDB ====================
// FIX #2b: i timer erano indicizzati con un oggetto DOM come chiave -> tutti gli input
// condividevano la stessa chiave "[object HTMLInputElement]". Ora WeakMap.
const debounceTimers = new WeakMap();
document.addEventListener('input', (e) => {
  if (!e.target.classList.contains('show-title-input')) return;
  // [PERF] se l'utente riscrive a mano, l'ID scelto in precedenza non è più
  // affidabile: lo scartiamo finché non seleziona di nuovo un suggerimento.
  delete e.target.dataset.tmdbId;
  clearTimeout(debounceTimers.get(e.target));
  const query = e.target.value.trim();
  const form = e.target.closest('.add-show-form');
  if (!form) return;
  let dropdown = form.querySelector('.autocomplete-dropdown');
  if (!dropdown) {
    dropdown = document.createElement('div');
    dropdown.className = 'autocomplete-dropdown';
    e.target.parentNode.style.position = 'relative';
    e.target.parentNode.appendChild(dropdown);
  }
  if (query.length < 2) {
    dropdown.innerHTML = '';
    dropdown.style.display = 'none';
    return;
  }
  debounceTimers.set(e.target, setTimeout(async () => {
    try {
      const res = await fetch(`https://api.themoviedb.org/3/search/tv?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}&language=it-IT`);
      const sj = await res.json();
      const results = (sj.results || []).slice(0, 6);
      dropdown.innerHTML = results.map(r => `
        <div class="autocomplete-item" data-title="${escapeHtml(r.name)}" data-poster="${r.poster_path ? TMDB_IMG + r.poster_path : ''}" data-year="${r.first_air_date ? r.first_air_date.split('-')[0] : ''}" data-id="${r.id}">
          <img src="${r.poster_path ? TMDB_IMG + r.poster_path : PLACEHOLDER_IMG}" alt="">
          <div><strong>${escapeHtml(r.name)}</strong><br><small>${r.first_air_date ? r.first_air_date.split('-')[0] : ''}</small></div>
        </div>
      `).join('');
      dropdown.style.display = results.length ? 'block' : 'none';
    } catch(err) { dropdown.style.display = 'none'; }
  }, 400));
});

document.addEventListener('click', (e) => {
  const item = e.target.closest('.autocomplete-item');
  if (item) {
    const form = item.closest('.add-show-form');
    const titleInput = form.querySelector('.show-title-input');
    // FIX #2: selettore su classe dedicata, non sul testo del placeholder
    const posterInput = form.querySelector('.show-poster-input');
    titleInput.value = item.dataset.title;
    if (posterInput && item.dataset.poster) posterInput.value = item.dataset.poster;
    if (item.dataset.id) titleInput.dataset.tmdbId = item.dataset.id; // [PERF] evita una futura ricerca testuale
    const dropdown = form.querySelector('.autocomplete-dropdown');
    if (dropdown) { dropdown.innerHTML = ''; dropdown.style.display = 'none'; }
  } else {
    document.querySelectorAll('.autocomplete-dropdown').forEach(d => {
      if (!d.contains(e.target)) d.style.display = 'none';
    });
  }
});

// ==================== DRAG & DROP ====================
function removePlaceholder() {
  if (drag.placeholder && drag.placeholder.parentNode) drag.placeholder.parentNode.removeChild(drag.placeholder);
  drag.placeholder = null;
}
function movePlaceholderTo(grid, beforeEl) {
  if (!drag.placeholder) {
    drag.placeholder = document.createElement('div');
    drag.placeholder.className = 'drop-placeholder';
  }
  if (drag.placeholder.nextSibling === beforeEl && drag.placeholder.parentNode === grid) return;
  if (beforeEl) grid.insertBefore(drag.placeholder, beforeEl);
  else grid.appendChild(drag.placeholder);
}
function getInsertBeforeCard(grid, clientX, clientY) {
  const cards = [...grid.querySelectorAll('.show-card:not(.dragging)')];
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const midX = rect.left + rect.width / 2;
    if (clientY < midY - 5) return card;
    if (Math.abs(clientY - midY) <= rect.height / 2 + 4 && clientX < midX) return card;
  }
  return null;
}

// ==================== SIDE NAV ====================
const renderCategoryNav = (legendShows) => {
  const list = document.getElementById('sideNavList');
  if (!list) return;
  if (!data.length && (!legendShows || !legendShows.length)) {
    list.innerHTML = `<div class="side-nav-empty">Nessuna categoria disponibile</div>`;
    return;
  }
  let itemsHtml = '';
  if (legendShows && legendShows.length) {
    itemsHtml += `<button class="side-nav-item legend-nav-item" data-nav-target="legends-section"><span><i class="fas fa-crown"></i> Epopee Seriali</span><span class="cat-nav-count">${legendShows.length}</span></button>`;
  }
  itemsHtml += data.map((cat, idx) => `<button class="side-nav-item" data-nav-target="category-${idx}"><span>${escapeHtml(cat.name)}</span><span class="cat-nav-count">${cat.shows.length}</span></button>`).join('');
  list.innerHTML = itemsHtml;
  list.querySelectorAll('[data-nav-target]').forEach(btn => {
    btn.onclick = () => {
      const targetId = btn.dataset.navTarget;
      const target = document.getElementById(targetId);
      if (!target) return;
      if (targetId.startsWith('category-')) {
        const catIdx = parseInt(targetId.replace('category-', ''));
        const catName = data[catIdx]?.name;
        if (catName && collapsedCategories.has(catName)) {
          collapsedCategories.delete(catName);
          saveCollapsed();
          target.classList.remove('collapsed');
        }
      }
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      closeSideNav();
    };
  });
};

const openSideNav = () => {
  document.getElementById('sideNavPanel')?.classList.add('open');
  document.getElementById('sideNavBackdrop')?.classList.add('visible');
  const toggle = document.getElementById('sideNavToggleMobile');
  toggle?.classList.add('active');
  toggle?.setAttribute('aria-expanded', 'true');
};
const closeSideNav = () => {
  document.getElementById('sideNavPanel')?.classList.remove('open');
  document.getElementById('sideNavBackdrop')?.classList.remove('visible');
  const toggle = document.getElementById('sideNavToggleMobile');
  toggle?.classList.remove('active');
  toggle?.setAttribute('aria-expanded', 'false');
};

const setupSideNav = () => {
  const edge = document.getElementById('sideNavEdge');
  const panel = document.getElementById('sideNavPanel');
  const toggleMobile = document.getElementById('sideNavToggleMobile');
  const closeBtn = document.getElementById('sideNavClose');
  const backdrop = document.getElementById('sideNavBackdrop');
  const isDesktop = () => window.matchMedia('(min-width: 901px)').matches;
  edge?.addEventListener('mouseenter', () => { if (isDesktop()) openSideNav(); });
  panel?.addEventListener('mouseleave', () => { if (isDesktop()) closeSideNav(); });
  toggleMobile?.addEventListener('click', () => {
    if (panel.classList.contains('open')) closeSideNav();
    else openSideNav();
  });
  closeBtn?.addEventListener('click', closeSideNav);
  backdrop?.addEventListener('click', closeSideNav);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSideNav(); });
};

// ==================== RIPRENDI DA QUI ====================
// Quello che si apre l'app per fare: vedere a che punto si è e segnare un
// episodio. Prima serviva aprire la scheda, scorrere fino a "Episodio attuale",
// cambiare un numero e salvare. Qui è un pulsante.
// Nessuna chiamata di rete: usa solo watchData e i dettagli già in cache.

// Qual è il prossimo episodio da vedere, dato dove si è arrivati.
// Ritorna { season, episode } | { finished: true } | null (dati insufficienti).
const nextEpisodeOf = (title) => {
  const d = showDetailsCache.get(title);
  if (!d?.seasons?.length) return null;
  const w = watchData[title] || {};
  let season = w.currentSeason || 1;
  let episode = (w.currentEpisode ?? 0) + 1;
  const info = d.seasons.find(x => x.season_number === season);
  // Finita la stagione corrente si passa alla prima della successiva. Le
  // stagioni non sono per forza numerate di seguito (speciali già filtrati,
  // ma capitano buchi), quindi si prende la prima con numero maggiore.
  if (info && episode > (info.episode_count || 0)) {
    const nextSeason = d.seasons.filter(x => x.season_number > season).sort((a,b) => a.season_number - b.season_number)[0];
    if (!nextSeason) return { finished: true };
    season = nextSeason.season_number;
    episode = 1;
  }
  if (!d.seasons.some(x => x.season_number === season)) return { finished: true };
  return { season, episode };
};

const advanceEpisode = async (title) => {
  const next = nextEpisodeOf(title);
  if (!next || next.finished) return;
  // Passa dalla checklist: cosi' l'avanzamento rapido e la spunta per episodio
  // raccontano sempre la stessa storia.
  markEpisode(title, next.season, next.episode, true);
  const ok = await saveWatchData();
  if (!ok) showError('Progresso salvato in locale, ma la sincronizzazione cloud non è riuscita (verrà ritentata).');
  await render(); // aggiorna sia questa sezione sia la mini barra sulla card
};

const buildResumeList = () => {
  const out = [];
  for (const cat of data) {
    if (!isWatchingCat(cat.name)) continue;
    for (const show of cat.shows) {
      out.push({
        show,
        progress: computeEpisodeProgress(show.title),
        next: nextEpisodeOf(show.title),
      });
    }
  }
  // In cima chi è più avanti: sono le serie che si sta davvero seguendo. In
  // fondo quelle non ancora iniziate o senza dati stagione.
  return out.sort((a, b) => (b.progress?.pct ?? -1) - (a.progress?.pct ?? -1));
};

const renderResume = () => {
  const container = document.getElementById('resumeContainer');
  if (!container) return;
  const list = buildResumeList();
  if (!list.length) { container.innerHTML = ''; return; }

  container.innerHTML = `<div class="resume-section">
    <div class="resume-header">
      <i class="fas fa-play resume-header-icon" aria-hidden="true"></i>
      <div class="resume-title">RIPRENDI DA QUI</div>
      <div class="resume-sub">${list.length} ${list.length === 1 ? 'serie in corso' : 'serie in corso'}</div>
    </div>
    <div class="resume-row">${list.map(({ show, progress, next }) => {
      const poster = escapeHtml(show.poster || PLACEHOLDER_IMG);
      let statusHtml, actionHtml;
      if (!next) {
        statusHtml = `<div class="resume-status muted">Dati stagioni non ancora disponibili</div>`;
        actionHtml = `<button type="button" class="resume-btn ghost" data-open="${escapeHtml(show.title)}">Apri</button>`;
      } else if (next.finished) {
        statusHtml = `<div class="resume-status done"><i class="fas fa-flag-checkered"></i> Arrivato alla fine</div>`;
        actionHtml = `<button type="button" class="resume-btn ghost" data-open="${escapeHtml(show.title)}">Apri</button>`;
      } else {
        statusHtml = `<div class="resume-status"><span class="resume-next">S${next.season}E${next.episode}</span> da vedere</div>`;
        actionHtml = `<button type="button" class="resume-btn" data-advance="${escapeHtml(show.title)}" title="Segna S${next.season}E${next.episode} come visto"><i class="fas fa-check"></i> Visto</button>`;
      }
      const barHtml = progress
        ? `<div class="resume-bar"><div class="resume-bar-fill" style="width:${progress.pct}%"></div></div><div class="resume-bar-label">${progress.watched} di ${progress.total} · ${progress.pct}%</div>`
        : `<div class="resume-bar-label muted">Nessun episodio segnato</div>`;
      return `<div class="resume-card">
        <img class="resume-poster" src="${poster}" alt="" loading="lazy" data-open="${escapeHtml(show.title)}">
        <div class="resume-body">
          <div class="resume-name" data-open="${escapeHtml(show.title)}" title="${escapeHtml(show.title)}">${escapeHtml(show.title)}</div>
          ${statusHtml}
          ${barHtml}
          ${actionHtml}
        </div>
      </div>`;
    }).join('')}</div>
  </div>`;

  container.querySelectorAll('[data-open]').forEach(el => {
    el.onclick = () => openShowDetails(el.dataset.open);
  });
  container.querySelectorAll('[data-advance]').forEach(btn => {
    btn.onclick = async () => {
      btn.disabled = true; // il salvataggio passa da Firestore: evita il doppio click
      await advanceEpisode(btn.dataset.advance);
    };
  });
};

// ==================== [2] CALENDARIO USCITE ====================
const startOfToday = () => { const d = new Date(); d.setHours(0,0,0,0); return d; };

// [FIX DATE] "2026-03-14" passato a new Date() viene interpretato come UTC,
// mentre startOfToday() è mezzanotte LOCALE: a est di Greenwich il confronto
// sbagliava di un giorno a cavallo della mezzanotte. Aggiungendo 'T00:00:00'
// la data viene letta come locale, coerentemente ovunque.
const parseAirDate = (iso) => {
  if (!iso) return null;
  const d = new Date(iso + 'T00:00:00');
  return isNaN(d) ? null : d;
};

const buildUpcoming = () => {
  const today = startOfToday();
  const limit = new Date(today); limit.setDate(limit.getDate() + UPCOMING_WINDOW_DAYS);
  const seen = new Set();
  const out = [];
  for (const cat of data) {
    for (const show of cat.shows) {
      if (seen.has(show.title)) continue;
      const d = showDetailsCache.get(show.title);
      const ne = d?.next_episode_to_air;
      if (!ne?.air_date) continue;
      const air = parseAirDate(ne.air_date);
      if (!air || air < today || air > limit) continue;
      seen.add(show.title);
      out.push({ show, ne, air, days: Math.round((air - today) / 86400000) });
    }
  }
  return out.sort((a, b) => a.air - b.air);
};

const whenLabel = (days) => days === 0 ? 'OGGI' : days === 1 ? 'DOMANI' : `TRA ${days} GIORNI`;

const renderUpcoming = () => {
  const c = document.getElementById('upcomingContainer');
  if (!c) return;
  const items = buildUpcoming();
  if (!items.length) { c.innerHTML = ''; return; }
  const cards = items.map(({ show, ne, days }) => {
    const dateStr = parseAirDate(ne.air_date).toLocaleDateString('it-IT', { weekday: 'short', day: '2-digit', month: 'short' });
    const epName = ne.name ? ` · ${escapeHtml(ne.name)}` : '';
    return `<div class="upcoming-card${days === 0 ? ' is-today' : ''}" data-title="${escapeHtml(show.title)}">
      <img src="${escapeHtml(show.poster || PLACEHOLDER_IMG)}" alt="" loading="lazy">
      <div class="upcoming-body">
        <div class="upcoming-when${days === 0 ? ' today' : ''}">${whenLabel(days)}</div>
        <div class="upcoming-show">${escapeHtml(show.title)}</div>
        <div class="upcoming-ep">${dateStr} · S${ne.season_number}E${ne.episode_number}${epName}</div>
      </div>
    </div>`;
  }).join('');
  c.innerHTML = `<div class="upcoming-section" id="upcoming-section">
    <div class="upcoming-header">
      <i class="fas fa-calendar-days"></i>
      <div class="upcoming-title">PROSSIME USCITE</div>
      <div class="upcoming-sub">${items.length} episodi nei prossimi ${UPCOMING_WINDOW_DAYS} giorni</div>
      <button class="btn btn-secondary btn-sm upcoming-ics" id="exportIcsBtn" title="Scarica un file .ics da importare nel calendario">
        <i class="fas fa-calendar-plus btn-icon" aria-hidden="true"></i> Esporta ICS
      </button>
    </div>
    <div class="upcoming-row">${cards}</div>
  </div>`;
  c.querySelectorAll('.upcoming-card').forEach(el => {
    el.onclick = () => openShowDetails(el.dataset.title);
  });
  const icsBtn = c.querySelector('#exportIcsBtn');
  if (icsBtn) icsBtn.onclick = exportCalendar;
};

// ==================== [ICS] ESPORTA CALENDARIO ====================
// RFC 5545: righe separate da CRLF, ripiegate a 75 ottetti, e nel testo vanno
// protetti backslash, punto e virgola, virgola e a capo. escapeHtml qui NON va
// bene: dentro un .ics trasformerebbe "Rick & Morty" in "Rick &amp; Morty".
const icsEscape = (s) => String(s ?? '')
  .replace(/\\/g, '\\\\')
  .replace(/;/g, '\\;')
  .replace(/,/g, '\\,')
  .replace(/\r?\n/g, '\\n');

// Il limite di riga si misura in OTTETTI, non in caratteri: un accento ne occupa
// due e spezzarlo a meta' produrrebbe un file illeggibile.
const icsEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
const icsFold = (line) => {
  if (!icsEncoder) return line;
  if (icsEncoder.encode(line).length <= 75) return line;
  const chunks = [];
  let cur = '', bytes = 0;
  for (const ch of line) {
    const b = icsEncoder.encode(ch).length;
    // Le righe di continuazione iniziano con uno spazio, che conta nel limite.
    if (bytes + b > (chunks.length ? 74 : 75)) { chunks.push(cur); cur = ''; bytes = 0; }
    cur += ch;
    bytes += b;
  }
  chunks.push(cur);
  return chunks.map((c, i) => (i ? ' ' + c : c)).join('\r\n');
};

const icsDate = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
const icsStamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

const generateICS = (items) => {
  const now = icsStamp(new Date());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//TVTRACKER//Calendario uscite//IT',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];
  for (const { show, ne, air } of items) {
    // In un evento su tutto il giorno DTEND e' ESCLUSIVO: con la stessa data di
    // DTSTART l'evento dura zero e diversi calendari non lo disegnano affatto.
    const end = new Date(air);
    end.setDate(end.getDate() + 1);
    const uid = `${show.id || encodeURIComponent(show.title)}-${ne.season_number}-${ne.episode_number}@tvtracker`;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${now}`,
      `DTSTART;VALUE=DATE:${icsDate(air)}`,
      `DTEND;VALUE=DATE:${icsDate(end)}`,
      `SUMMARY:${icsEscape(`${show.title} — S${ne.season_number}E${ne.episode_number}`)}`,
      `DESCRIPTION:${icsEscape(ne.name || 'Nuovo episodio')}`,
      'TRANSP:TRANSPARENT',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(icsFold).join('\r\n') + '\r\n';
};

const exportCalendar = () => {
  const items = buildUpcoming();
  if (!items.length) { showToast('Nessun episodio in uscita da esportare.'); return; }
  const blob = new Blob([generateICS(items)], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'tvtracker-calendario.ics';
  a.style.display = 'none';
  // Stessa cautela di exportToFile: l'ancora dev'essere nel documento e l'URL
  // non va revocato prima che il download sia partito.
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
  showToast(`Calendario esportato: ${items.length} episodi.`, 'success');
};

// ==================== [CONFRONTO] DUE SERIE A FIANCO ====================
// La selezione e' per id e non per titolo: due categorie possono contenere lo
// stesso titolo, e in quel caso il confronto mostrerebbe due volte la stessa.
let compareSelection = [];

const findShowById = (showId) => {
  for (const cat of data) {
    const show = cat.shows.find(s => s.id === showId);
    if (show) return { show, cat };
  }
  return null;
};

// Sincronizza badge sulle card e barra in basso senza passare da render():
// un render completo per accendere un contorno sarebbe sproporzionato.
const syncCompareUi = () => {
  document.querySelectorAll('.show-card').forEach(card => {
    card.classList.toggle('compare-selected', compareSelection.includes(card.dataset.showId));
  });
  const container = document.getElementById('compareBarContainer');
  if (!container) return;
  if (!compareSelection.length) { container.innerHTML = ''; return; }
  const names = compareSelection.map(id => findShowById(id)?.show.title).filter(Boolean);
  container.innerHTML = `<div class="compare-bar">
    <span class="compare-bar-count"><i class="fas fa-code-compare"></i> ${escapeHtml(names.join('  vs  '))}</span>
    <button class="btn btn-primary" id="compareOpenBtn" ${compareSelection.length === 2 ? '' : 'disabled'}>
      <i class="fas fa-code-compare btn-icon"></i> ${compareSelection.length === 2 ? 'Confronta' : 'Scegline un\'altra'}
    </button>
    <button class="btn btn-secondary" id="compareClearBtn"><i class="fas fa-times btn-icon"></i> Annulla</button>
  </div>`;
  const openBtn = container.querySelector('#compareOpenBtn');
  if (openBtn) openBtn.onclick = openCompareModal;
  container.querySelector('#compareClearBtn').onclick = () => { compareSelection = []; syncCompareUi(); };
};

const toggleCompare = (showId) => {
  if (!showId) return;
  if (compareSelection.includes(showId)) {
    compareSelection = compareSelection.filter(id => id !== showId);
  } else if (compareSelection.length < 2) {
    compareSelection.push(showId);
  } else {
    // Si sostituisce la piu' vecchia invece di rifiutare: e' quello che ci si
    // aspetta cliccando una terza serie, e non costringe a deselezionare prima.
    compareSelection = [compareSelection[1], showId];
  }
  syncCompareUi();
};

const openCompareModal = async () => {
  if (compareSelection.length !== 2) return;
  const a = findShowById(compareSelection[0]);
  const b = findShowById(compareSelection[1]);
  if (!a || !b) { showToast('Una delle due serie non e\' piu\' in libreria.'); compareSelection = []; syncCompareUi(); return; }

  const modal = document.getElementById('compareModal');
  const body = document.getElementById('compareBody');
  if (!modal || !body) return;
  body.innerHTML = '<div style="grid-column:1/-1;padding:40px;text-align:center;color:var(--text-muted)"><i class="fas fa-circle-notch fa-spin"></i> Carico i dettagli...</div>';
  modal.style.display = 'flex';

  const close = () => { modal.style.display = 'none'; };
  const closeBtn = document.getElementById('compareClose');
  if (closeBtn) closeBtn.onclick = close;
  modal.onclick = (e) => { if (e.target === modal) close(); };

  // La cache puo' non avere ancora i dettagli di una delle due: senza questo
  // il confronto mostrava una colonna di trattini.
  const [d1, d2] = await Promise.all([
    fetchShowDetails(a.show.title, a.show.tmdbId || null),
    fetchShowDetails(b.show.title, b.show.tmdbId || null),
  ]);
  if (modal.style.display !== 'flex') return;

  const r1 = ratingsData[a.show.title];
  const r2 = ratingsData[b.show.title];
  const p1 = computeEpisodeProgress(a.show.title);
  const p2 = computeEpisodeProgress(b.show.title);

  const row = (label, v1, v2) => `<div class="compare-row">
    <div class="compare-cell">${escapeHtml(String(v1 ?? '—'))}</div>
    <div class="compare-key">${escapeHtml(label)}</div>
    <div class="compare-cell">${escapeHtml(String(v2 ?? '—'))}</div>
  </div>`;

  const col = (show, details, rating) => `<div class="compare-col">
    <img src="${escapeHtml(show.poster || (details?.poster_path ? TMDB_IMG + details.poster_path : PLACEHOLDER_IMG))}" alt="${escapeHtml(show.title)}">
    <h3>${escapeHtml(show.title)}</h3>
    ${rating ? `<div class="compare-my-rating ${ratingTier(rating.average)}">${rating.average.toFixed(1)}</div>` : '<div class="compare-my-rating none">Non votata</div>'}
  </div>`;

  body.innerHTML = `${col(a.show, d1, r1)}${col(b.show, d2, r2)}
    <div class="compare-table">
      ${row('Stagioni', d1?.number_of_seasons, d2?.number_of_seasons)}
      ${row('Episodi', d1?.number_of_episodes, d2?.number_of_episodes)}
      ${row('Voto TMDB', d1?.vote_average, d2?.vote_average)}
      ${row('Il mio voto', r1 ? r1.average.toFixed(1) : '—', r2 ? r2.average.toFixed(1) : '—')}
      ${row('Avanzamento', p1 ? `${p1.pct}%` : '—', p2 ? `${p2.pct}%` : '—')}
      ${row('Genere', d1?.genres, d2?.genres)}
      ${row('Stato', d1?.status, d2?.status)}
      ${row('Rete', d1?.networks, d2?.networks)}
      ${row('Categoria', a.cat.name, b.cat.name)}
    </div>`;
};

// ==================== SUGGERIMENTI TMDB (stesso campo di ricerca) ====================
// Non e' piu' una barra a se': si aggancia a #searchInput e compare sotto,
// elencando solo le serie che NON hai gia'. Cosi' "cerco" e "aggiungo" sono lo
// stesso gesto invece di due campi che si somigliano.
let tmdbSuggestTimer = null;
let tmdbSuggestController = null;
let tmdbSuggestSeq = 0;

const closeTmdbSuggestions = () => {
  const dropdown = document.getElementById('searchDropdown');
  const input = document.getElementById('searchInput');
  if (dropdown) { dropdown.style.display = 'none'; dropdown.innerHTML = ''; }
  if (input) input.setAttribute('aria-expanded', 'false');
  tmdbSuggestSeq++;   // invalida qualunque risposta ancora in volo
};

const runTmdbSuggestions = async (q) => {
  const dropdown = document.getElementById('searchDropdown');
  const input = document.getElementById('searchInput');
  if (!dropdown) return;

  const mySeq = ++tmdbSuggestSeq;
  if (tmdbSuggestController) tmdbSuggestController.abort();
  tmdbSuggestController = typeof AbortController !== 'undefined' ? new AbortController() : null;

  dropdown.innerHTML = '<div class="search-dropdown-status"><i class="fas fa-circle-notch fa-spin" aria-hidden="true"></i> Cerco su TMDB...</div>';
  dropdown.style.display = 'block';
  if (input) input.setAttribute('aria-expanded', 'true');

  try {
    const res = await fetch(
      `https://api.themoviedb.org/3/search/tv?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(q)}&language=it-IT`,
      tmdbSuggestController ? { signal: tmdbSuggestController.signal } : undefined,
    );
    if (mySeq !== tmdbSuggestSeq) return;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    if (mySeq !== tmdbSuggestSeq) return;

    const owned = (r) => data.some(c => c.shows.some(s =>
      s.tmdbId === r.id || s.title.toLowerCase() === (r.name || '').toLowerCase()));

    // Le serie gia' in libreria sono gia' visibili nella griglia filtrata sopra:
    // ripeterle qui raddoppierebbe lo stesso titolo sullo schermo.
    const results = (j.results || []).filter(r => !owned(r)).slice(0, 6);
    if (!results.length) {
      dropdown.innerHTML = '<div class="search-dropdown-status">Nessun altro risultato su TMDB.</div>';
      return;
    }

    dropdown.innerHTML = `<div class="search-dropdown-head">Aggiungi da TMDB</div>` + results.map(r => {
      const year = r.first_air_date ? r.first_air_date.split('-')[0] : '';
      return `<div class="search-dropdown-item" role="option" tabindex="0"
          data-title="${escapeHtml(r.name || '')}"
          data-poster="${escapeHtml(r.poster_path || '')}"
          data-id="${r.id}">
        <img src="${r.poster_path ? TMDB_IMG + escapeHtml(r.poster_path) : PLACEHOLDER_IMG}" alt="" loading="lazy">
        <div class="search-dropdown-meta">
          <strong>${escapeHtml(r.name || 'Senza titolo')}</strong>
          <small>${escapeHtml(year)}${year && r.vote_average ? ' · ' : ''}${r.vote_average ? `${r.vote_average.toFixed(1)} ★` : ''}</small>
        </div>
        <button type="button" class="search-dropdown-add">Aggiungi</button>
      </div>`;
    }).join('');
    dropdown.style.display = 'block';
  } catch (e) {
    if (e?.name === 'AbortError' || mySeq !== tmdbSuggestSeq) return;
    dropdown.innerHTML = '<div class="search-dropdown-status">Ricerca su TMDB non riuscita.</div>';
  }
};

// Sotto i 3 caratteri non si chiama TMDB: le risposte sarebbero rumore e
// consumerebbero quota a ogni tasto.
const queueTmdbSuggestions = (raw) => {
  clearTimeout(tmdbSuggestTimer);
  const q = (raw || '').trim();
  if (q.length < 3) { closeTmdbSuggestions(); return; }
  tmdbSuggestTimer = setTimeout(() => runTmdbSuggestions(q), 400);
};

const addFromTmdbItem = (item, anchorEl) => {
  const title = item.dataset.title;
  const poster = item.dataset.poster ? TMDB_IMG + item.dataset.poster : undefined;
  const tmdbId = parseInt(item.dataset.id, 10) || undefined;

  // Si chiede SEMPRE la categoria e si aggiunge in QUELLA scelta.
  const items = data.map((cat, i) => ({
    icon: cat.type === 'watching' ? 'fa-play' : cat.type === 'todo' ? 'fa-bookmark' : 'fa-folder',
    label: cat.name,
    onSelect: async () => {
      const target = data[i];
      if (!target) return;
      if (catHasTitle(target, title)) { showToast(`"${title}" e' gia' presente in "${target.name}".`); return; }
      const newShow = { id: generateId(), title, poster, tmdbId, progress: '0', addedAt: new Date().toISOString(), tags: [] };
      target.shows.push(newShow);
      await saveData();
      const input = document.getElementById('searchInput');
      const clearBtn = document.getElementById('searchClear');
      if (input) input.value = '';
      if (clearBtn) clearBtn.classList.remove('visible');
      searchQuery = '';
      closeTmdbSuggestions();
      await render();
      applySearch();
      flagJustAdded(newShow.id);
      showToast(`"${title}" aggiunta a ${target.name}.`, 'success');
    },
  }));
  openFloatingMenu(anchorEl, items, { align: 'end' });
};

// La legenda dei voti era una striscia sempre presente fra la ricerca e la
// prima categoria. Serve una volta sola, per imparare i colori: ora si apre a
// richiesta e si chiude con Esc, click fuori o un secondo click sul pulsante.
const setupGlobalSearch = () => {
  const dropdown = document.getElementById('searchDropdown');
  const input = document.getElementById('searchInput');
  if (!dropdown || !input) return;

  dropdown.addEventListener('click', (e) => {
    const item = e.target.closest('.search-dropdown-item');
    if (!item) return;
    const addBtn = e.target.closest('.search-dropdown-add');
    if (addBtn) { addFromTmdbItem(item, addBtn); return; }
    openShowDetails(item.dataset.title);
  });

  dropdown.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const item = e.target.closest('.search-dropdown-item');
    if (!item) return;
    e.preventDefault();
    openShowDetails(item.dataset.title);
  });

  document.addEventListener('click', (e) => {
    if (!dropdown.contains(e.target) && e.target !== input) closeTmdbSuggestions();
  });
};

// Evidenzia la card appena creata. Va chiamata DOPO render(), quando la card
// esiste davvero nel DOM.
const flagJustAdded = (showId) => {
  if (!showId || prefersReducedMotion()) return;
  const card = document.querySelector(`.show-card[data-show-id="${showId}"]`);
  if (!card) return;
  card.classList.add('just-added');
  card.addEventListener('animationend', () => card.classList.remove('just-added'), { once: true });
};

// ==================== [3] NOTIFICHE EPISODI ====================
// Nota: senza un server push reale, il controllo avviene all'apertura dell'app
// (e ogni ora se la scheda resta aperta). Il service worker mostra la notifica.
const loadNotified = () => { try { return JSON.parse(localStorage.getItem(NOTIF_STORE_KEY)) || {}; } catch (e) { return {}; } };
const saveNotified = (obj) => {
  const cutoff = Date.now() - 60 * 86400000;
  for (const k of Object.keys(obj)) if (obj[k] < cutoff) delete obj[k];
  localStorage.setItem(NOTIF_STORE_KEY, JSON.stringify(obj));
};

// Le notifiche non hanno più un pulsante fisso in barra ma una voce nel menu ⋮,
// ricostruita ad ogni apertura: lo stato del permesso si legge lì, al momento.
const notificationMenuState = () => {
  if (!('Notification' in window)) return null; // browser senza API: voce assente
  if (Notification.permission === 'granted') return { icon: 'fa-bell',       label: 'Notifiche attive',    disabled: true };
  if (Notification.permission === 'denied')  return { icon: 'fa-bell-slash', label: 'Notifiche bloccate',  disabled: true };
  return { icon: 'fa-bell', label: 'Attiva notifiche', onSelect: requestNotificationPermission };
};
const updateNotifyBtn = () => {}; // conservata: la chiama requestNotificationPermission

const checkEpisodeNotifications = async () => {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const notified = loadNotified();
  let changed = false;
  const reg = ('serviceWorker' in navigator) ? await navigator.serviceWorker.getRegistration() : null;
  for (const { show, ne, days } of buildUpcoming()) {
    if (days !== 0) continue; // solo gli episodi che escono oggi
    const key = `${show.title}|${ne.air_date}`;
    if (notified[key]) continue;
    const title = `📺 ${show.title}`;
    const body = `Esce oggi: S${ne.season_number}E${ne.episode_number}${ne.name ? ` — ${ne.name}` : ''}`;
    const opts = { body, tag: key, icon: show.poster || undefined, badge: show.poster || undefined };
    try {
      if (reg) await reg.showNotification(title, opts);
      else new Notification(title, opts);
      notified[key] = Date.now();
      changed = true;
    } catch (e) { console.warn('Notifica fallita:', e); }
  }
  if (changed) saveNotified(notified);
};

const requestNotificationPermission = async () => {
  if (!('Notification' in window)) return;
  const p = await Notification.requestPermission();
  updateNotifyBtn();
  if (p === 'granted') await checkEpisodeNotifications();
};

// Da chiamare UNA volta all'avvio: registra il controllo orario. I bottoni
// (desktop e mobile) usano requestNotificationPermission, così cliccarli
// più volte non accumula intervalli duplicati.
const setupNotifications = () => {
  // ricontrolla ogni ora se la scheda resta aperta (utile a cavallo della mezzanotte)
  setInterval(() => checkEpisodeNotifications(), 3600000);
};

// ==================== [8] VISTA LISTA ====================
const getShowMeta = (show) => {
  const d = showDetailsCache.get(show.title);
  let views = null;
  if (show.progress !== undefined && show.progress !== null && show.progress !== '') {
    const v = parseFloat(String(show.progress).replace(',', '.'));
    if (!isNaN(v)) views = v;
  }
  return {
    rating: ratingsData[show.title]?.average ?? null,
    seasons: show.seasons_count ?? d?.number_of_seasons ?? null,
    year: d?.first_air_date && /^\d{4}/.test(d.first_air_date) ? parseInt(d.first_air_date.slice(0, 4)) : null,
    genreNames: d?.genre_names || [],
    tags: Array.isArray(show.tags) ? show.tags : [],
    views,
  };
};

// Tutti i tag in uso, ordinati. Serve al filtro della vista lista e al
// suggerimento nella modale di modifica.
const allTags = () => {
  const set = new Set();
  for (const cat of data) for (const show of cat.shows) (show.tags || []).forEach(t => set.add(t));
  return [...set].sort((a, b) => a.localeCompare(b, 'it'));
};

// I tag arrivano da un campo di testo libero: si normalizzano una volta sola,
// qui, invece che in tre punti diversi.
const parseTagsInput = (raw) => {
  const seen = new Set();
  const out = [];
  for (const piece of String(raw || '').split(',')) {
    const t = piece.trim().replace(/\s+/g, ' ');
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t.slice(0, 32));
  }
  return out.slice(0, 12);
};

// [2] Filtri vista lista: genere/anno/voto minimo, calcolati sulle serie note
const renderListFilters = () => {
  const container = document.getElementById('listFiltersContainer');
  if (!container) return;
  if (viewMode !== 'list') { container.innerHTML = ''; return; }
  const genresSet = new Set();
  const yearsSet = new Set();
  for (const cat of data) {
    for (const show of cat.shows) {
      const meta = getShowMeta(show);
      if (meta.year) yearsSet.add(meta.year);
      meta.genreNames.forEach(g => genresSet.add(g));
    }
  }
  const genres = [...genresSet].sort((a, b) => a.localeCompare(b));
  const years = [...yearsSet].sort((a, b) => b - a);
  const tags = allTags();
  const hasActiveFilters = listFilters.genre || listFilters.year || listFilters.minRating || listFilters.tag;
  container.innerHTML = `<div class="list-filters">
    <div class="list-filter-group"><label>Genere</label><select id="filterGenre"><option value="">Tutti</option>${genres.map(g => `<option value="${escapeHtml(g)}" ${listFilters.genre === g ? 'selected' : ''}>${escapeHtml(g)}</option>`).join('')}</select></div>
    <div class="list-filter-group"><label>Anno</label><select id="filterYear"><option value="">Tutti</option>${years.map(y => `<option value="${y}" ${String(listFilters.year) === String(y) ? 'selected' : ''}>${y}</option>`).join('')}</select></div>
    <div class="list-filter-group"><label>Voto minimo</label><select id="filterMinRating">
      <option value="0" ${listFilters.minRating === 0 ? 'selected' : ''}>Tutti</option>
      <option value="6" ${listFilters.minRating === 6 ? 'selected' : ''}>6+</option>
      <option value="7" ${listFilters.minRating === 7 ? 'selected' : ''}>7+</option>
      <option value="8" ${listFilters.minRating === 8 ? 'selected' : ''}>8+</option>
      <option value="9" ${listFilters.minRating === 9 ? 'selected' : ''}>9+</option>
    </select></div>
    ${tags.length ? `<div class="list-filter-group"><label>Tag</label><select id="filterTag"><option value="">Tutti</option>${tags.map(t => `<option value="${escapeHtml(t)}" ${listFilters.tag === t ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('')}</select></div>` : ''}
    ${hasActiveFilters ? `<button class="list-filter-reset" id="filterReset"><i class="fas fa-times"></i> Reset filtri</button>` : ''}
  </div>`;
  container.querySelector('#filterGenre').onchange = (e) => { listFilters.genre = e.target.value; render(); };
  container.querySelector('#filterYear').onchange = (e) => { listFilters.year = e.target.value; render(); };
  container.querySelector('#filterMinRating').onchange = (e) => { listFilters.minRating = parseFloat(e.target.value); render(); };
  const tagSelect = container.querySelector('#filterTag');
  if (tagSelect) tagSelect.onchange = (e) => { listFilters.tag = e.target.value; render(); };
  const resetBtn = container.querySelector('#filterReset');
  if (resetBtn) resetBtn.onclick = () => { listFilters = { genre: '', year: '', minRating: 0, tag: '' }; render(); };
};

// [voti] soglie: >=8 verde, 6-7.9 ambra, 3.1-5.9 rosso, <=3.0 rosso scuro
const ratingTier = (v) => v <= 3 ? 'awful' : (v >= 8 ? 'good' : (v >= 6 ? 'mid' : 'bad'));

const TABLE_COLS = [
  { key: 'title',   label: 'Titolo' },
  { key: 'rating',  label: 'Voto' },
  { key: 'seasons', label: 'Stagioni' },
  { key: 'year',    label: 'Anno' },
  { key: 'views',   label: 'Visioni' },
];

const buildShowsTable = (cat, catIdx, legendTitles) => {
  const wrap = document.createElement('div');
  wrap.className = 'shows-table-wrap';
  let rows = cat.shows.map((show, i) => ({ show, i, ...getShowMeta(show) }));
  // [2] applica i filtri attivi della vista lista
  if (listFilters.genre) rows = rows.filter(r => r.genreNames.includes(listFilters.genre));
  if (listFilters.year) rows = rows.filter(r => String(r.year) === String(listFilters.year));
  if (listFilters.minRating) rows = rows.filter(r => (r.rating ?? 0) >= listFilters.minRating);
  if (listFilters.tag) rows = rows.filter(r => r.tags.includes(listFilters.tag));
  if (sortState.key !== 'manual') {
    const k = sortState.key;
    rows.sort((a, b) => {
      const va = k === 'title' ? a.show.title.toLowerCase() : a[k];
      const vb = k === 'title' ? b.show.title.toLowerCase() : b[k];
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      if (va < vb) return -sortState.dir;
      if (va > vb) return sortState.dir;
      return 0;
    });
  }
  if (!rows.length) {
    wrap.innerHTML = `<div class="empty-msg"><i class="fas fa-filter"></i> Nessuna serie corrisponde ai filtri selezionati.</div>`;
    return wrap;
  }
  const arrow = (k) => sortState.key === k ? (sortState.dir === 1 ? ' ▲' : ' ▼') : '';
  const headCells = TABLE_COLS.map(c => `<th data-sort="${c.key}" class="${sortState.key === c.key ? 'sorted' : ''}">${c.label}${arrow(c.key)}</th>`).join('');
  const bulkHeadCell = bulkMode ? `<th style="width:36px"></th>` : '';
  const bodyRows = rows.map((r, pos) => `<tr class="show-row" data-show-idx="${r.i}" data-genres="${escapeHtml((showDetailsCache.get(r.show.title)?.genre_names || []).join('|').toLowerCase())}">
    ${bulkMode ? `<td><input type="checkbox" class="bulk-row-checkbox" name="bulk-select" data-title="${escapeHtml(r.show.title)}" ${selectedShows.has(r.show.title) ? 'checked' : ''}></td>` : ''}
    <td class="col-idx">${legendTitles.has(r.show.title) ? '<i class="fas fa-crown" style="color:var(--gold);font-size:10px"></i> ' : ''}${pos + 1}</td>
    <td class="show-title">${escapeHtml(r.show.title)}${r.tags.length ? `<div class="show-tags-inline">${r.tags.map(t => `<span class="show-tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}</td>
    <td>${r.rating != null ? `<span class="tbl-rating ${ratingTier(r.rating)}">${r.rating.toFixed(1)}</span>` : '<span style="color:var(--text-muted)">—</span>'}</td>
    <td>${r.seasons ?? '—'}</td>
    <td>${r.year ?? '—'}</td>
    <td>${r.views != null ? r.views : '—'}</td>
    <td class="col-actions">
      <button data-act="details" title="Dettagli"><i class="fas fa-info-circle"></i></button>
      <button data-act="rate" title="Vota"><i class="fas fa-star"></i></button>
      <button data-act="share" title="Condividi"><i class="fas fa-share-nodes"></i></button>
      <button data-act="edit" title="Modifica"><i class="fas fa-edit"></i></button>
      <button data-act="del" title="Elimina"><i class="fas fa-trash"></i></button>
    </td></tr>`).join('');
  wrap.innerHTML = `<table class="shows-table"><thead><tr>${bulkHeadCell}<th class="col-idx">#</th>${headCells}<th class="col-actions"></th></tr></thead><tbody>${bodyRows}</tbody></table>`;

  wrap.querySelectorAll('th[data-sort]').forEach(th => {
    th.onclick = () => {
      const k = th.dataset.sort;
      if (sortState.key === k) {
        if (sortState.dir === 1) sortState.dir = -1;
        else { sortState.key = 'manual'; sortState.dir = 1; } // terzo click = ordine manuale
      } else { sortState.key = k; sortState.dir = 1; }
      render();
    };
  });
  wrap.querySelectorAll('.bulk-row-checkbox').forEach(cb => {
    cb.onclick = (e) => e.stopPropagation();
    cb.onchange = () => toggleShowSelection(cb.dataset.title);
  });
  wrap.querySelectorAll('tr.show-row').forEach(tr => {
    const sIdx = parseInt(tr.dataset.showIdx);
    // FIX CLICK: prima si apriva la scheda solo cliccando esattamente sul testo
    // del titolo; ora risponde tutta la riga (i bottoni azione e la checkbox
    // hanno già il loro stopPropagation, quindi restano azioni separate).
    tr.onclick = () => openShowDetails(cat.shows[sIdx].title);
    // [A11Y] stesso discorso della griglia, per la vista lista
    tr.tabIndex = 0;
    tr.onkeydown = (e) => {
      if (e.target !== tr) return;
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      openShowDetails(cat.shows[sIdx].title);
    };
    tr.querySelectorAll('[data-act]').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const s = cat.shows[sIdx];
        if (!s) return;
        switch (btn.dataset.act) {
          case 'details': openShowDetails(s.title); break;
          case 'rate':    openRatingModal(s.title, s.poster); break;
          case 'share':   shareShowCard(s.title); break;
          case 'edit':    openEditModal(catIdx, sIdx); break;
          case 'del':     deleteShow(catIdx, sIdx); break; // [UNDO] niente conferma: si annulla dal toast
        }
      };
    });
  });
  return wrap;
};

const setupViewToggle = () => {
  const tg = document.getElementById('viewToggle');
  if (!tg) return;
  const sync = () => tg.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.view === viewMode));
  sync();
  tg.querySelectorAll('button').forEach(b => {
    b.onclick = async () => {
      if (viewMode === b.dataset.view) return;
      viewMode = b.dataset.view;
      localStorage.setItem('tvtracker-view', viewMode);
      if (viewMode === 'grid') sortState = { key: 'manual', dir: 1 };
      sync();
      await render();
    };
  });
};

// ==================== [5] RACCOMANDAZIONI ====================
const buildTasteProfile = () => {
  const vec = {};
  for (const [title, entry] of Object.entries(ratingsData)) {
    const d = showDetailsCache.get(title);
    if (!d?.genre_ids?.length) continue;
    const w = entry.average - 5; // sotto il 5 il genere viene penalizzato
    for (const g of d.genre_ids) vec[String(g)] = (vec[String(g)] || 0) + w;
  }
  return vec;
};

const cosineSim = (a, b) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let dot = 0, na = 0, nb = 0;
  for (const k of keys) { const x = a[k] || 0, y = b[k] || 0; dot += x * y; na += x * x; nb += y * y; }
  return (na && nb) ? dot / Math.sqrt(na * nb) : 0;
};

const GENRE_NAMES_BY_ID = {};
const rememberGenreNames = () => {
  for (const d of showDetailsCache.values()) {
    if (!d?.genre_ids) continue;
    d.genre_ids.forEach((id, i) => { if (d.genre_names?.[i]) GENRE_NAMES_BY_ID[String(id)] = d.genre_names[i]; });
  }
};

const fetchRecommendations = async () => {
  rememberGenreNames();
  const profile = buildTasteProfile();
  const topGenres = Object.entries(profile).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([g]) => g);
  if (!topGenres.length) return { items: [], genres: [] };

  const owned = new Set();
  for (const cat of data) for (const s of cat.shows) owned.add(s.title.trim().toLowerCase());

  const pages = [1, 2];
  const results = [];
  for (const page of pages) {
    const url = `https://api.themoviedb.org/3/discover/tv?api_key=${TMDB_API_KEY}&language=it-IT&sort_by=vote_average.desc&vote_count.gte=300&with_genres=${topGenres.join(',')}&page=${page}`;
    const res = await fetch(url);
    if (!res.ok) break;
    const j = await res.json();
    results.push(...(j.results || []));
  }

  const scored = results
    .filter(r => r.name && !owned.has(r.name.trim().toLowerCase()))
    .map(r => {
      const cv = {};
      (r.genre_ids || []).forEach(g => { cv[String(g)] = 1; });
      return { ...r, sim: cosineSim(profile, cv) };
    })
    .filter(r => r.sim > 0)
    .sort((a, b) => (b.sim - a.sim) || (b.vote_average - a.vote_average))
    .slice(0, 12);

  return { items: scored, genres: topGenres.map(g => GENRE_NAMES_BY_ID[g] || `#${g}`) };
};

const addRecommendedShow = async (title, posterPath, tmdbId) => {
  let targetIdx = data.findIndex(c => c.name.toLowerCase().includes('da vedere'));
  if (targetIdx === -1) targetIdx = 0;
  if (targetIdx < 0 || !data[targetIdx]) { showError('Crea prima una categoria.'); return; }
  data[targetIdx].shows.push({
    title,
    progress: '0',
    poster: posterPath ? TMDB_IMG + posterPath : undefined,
    tmdbId, // [PERF] già noto dal motore di raccomandazione, niente ricerca testuale futura
    addedAt: new Date().toISOString()
  });
  saveData();
  recsCache = null; // il profilo cambia, ricalcoliamo alla prossima apertura
  await render();
};

const renderRecommendations = async (force = false) => {
  const c = document.getElementById('recommendationsContainer');
  if (!c) return;
  const header = (extra = '') => `<div class="recs-header"><i class="fas fa-wand-magic-sparkles"></i><div class="recs-title">TI POTREBBE PIACERE</div>${extra}</div>`;
  const ratedCount = Object.keys(ratingsData).length;

  if (ratedCount < 3) {
    c.innerHTML = `<div class="recs-section">${header()}<div class="recs-empty">Vota almeno 3 serie per attivare i consigli — al momento ne hai valutate <strong>${ratedCount}</strong>.</div></div>`;
    return;
  }

  if (recsLoading) return;
  if (!recsCache || force) {
    recsLoading = true;
    c.innerHTML = `<div class="recs-section">${header()}<div class="recs-empty"><i class="fas fa-circle-notch fa-spin"></i> Calcolo dei consigli in base ai tuoi voti...</div></div>`;
    try { recsCache = await fetchRecommendations(); }
    catch (e) { console.error('Errore raccomandazioni:', e); recsCache = { items: [], genres: [] }; }
    finally { recsLoading = false; }
  }

  const refreshBtn = `<button class="recs-refresh" id="recsRefresh"><i class="fas fa-rotate"></i> Aggiorna</button>`;
  if (!recsCache.items.length) {
    c.innerHTML = `<div class="recs-section">${header(refreshBtn)}<div class="recs-empty">Nessun consiglio disponibile. Vota qualche altra serie con voti alti per definire meglio il tuo profilo.</div></div>`;
  } else {
    const cards = recsCache.items.map(r => {
      const poster = r.poster_path ? TMDB_IMG + r.poster_path : PLACEHOLDER_IMG;
      const year = r.first_air_date ? r.first_air_date.slice(0, 4) : '—';
      const match = Math.round(Math.max(0, Math.min(1, r.sim)) * 100);
      return `<div class="rec-card">
        <div class="rec-poster-wrap">
          <img src="${poster}" alt="${escapeHtml(r.name)}" loading="lazy">
          <div class="rec-match">${match}% match</div>
          <div class="rec-tmdb"><i class="fas fa-star"></i>${(r.vote_average || 0).toFixed(1)}</div>
        </div>
        <div class="rec-body">
          <div class="rec-name">${escapeHtml(r.name)}</div>
          <div class="rec-year">${year}</div>
          <button class="rec-add" data-title="${escapeHtml(r.name)}" data-poster="${r.poster_path || ''}" data-id="${r.id}"><i class="fas fa-plus"></i> Aggiungi</button>
        </div>
      </div>`;
    }).join('');
    const basis = recsCache.genres.length ? `<div class="recs-basis">In base ai tuoi generi preferiti: ${recsCache.genres.map(escapeHtml).join(' · ')} — ${ratedCount} serie valutate</div>` : '';
    c.innerHTML = `<div class="recs-section">${header(refreshBtn)}${basis}<div class="recs-row">${cards}</div></div>`;
    c.querySelectorAll('.rec-add').forEach(btn => {
      btn.onclick = async () => {
        btn.className = 'rec-add added';
        btn.innerHTML = '<i class="fas fa-check"></i> Aggiunta';
        await addRecommendedShow(btn.dataset.title, btn.dataset.poster || null, btn.dataset.id ? parseInt(btn.dataset.id, 10) : undefined);
      };
    });
  }
  const rb = document.getElementById('recsRefresh');
  if (rb) rb.onclick = () => renderRecommendations(true);
};

// Voci del menu ⋮ di una card. Costruite alla richiesta e non ad ogni render:
// con N serie e M categorie il vecchio sottomenu "Sposta in..." creava N×M
// pulsanti invisibili ad ogni singolo disegno della griglia.
const buildCardMenuItems = (catIdx, showIdx, show) => {
  const moveTargets = data
    .map((c, i) => ({ c, i }))
    .filter(({ i }) => i !== catIdx)
    .map(({ c, i }) => ({
      icon: 'fa-arrow-right',
      label: c.name,
      onSelect: () => moveShow(catIdx, showIdx, i),
    }));
  return [
    { icon: 'fa-info-circle',  label: 'Dettagli',  onSelect: () => openShowDetails(show.title) },
    { icon: 'fa-edit',         label: 'Modifica',  onSelect: () => openEditModal(catIdx, showIdx) },
    { icon: 'fa-star',         label: 'Vota',      onSelect: () => openRatingModal(show.title, show.poster) },
    { icon: 'fa-share-nodes',  label: 'Condividi', onSelect: () => shareShowCard(show.title) },
    { icon: 'fa-code-compare', label: compareSelection.includes(show.id) ? 'Togli dal confronto' : 'Confronta', onSelect: () => toggleCompare(show.id) },
    moveTargets.length
      ? { type: 'submenu', icon: 'fa-folder-open', label: 'Sposta in...', items: moveTargets }
      : { type: 'note', label: 'Nessun\'altra categoria in cui spostarla' },
    { type: 'separator' },
    { icon: 'fa-trash', label: 'Elimina', danger: true, onSelect: () => deleteShow(catIdx, showIdx) },
  ];
};

// ==================== RENDER ====================
// ============================================================
// PRESENTAZIONE: MOSAICO, ALONI, ENTRATA SCAGLIONATA
//
// Tutto quello che sta in questo blocco è decorativo. È scritto in modo che ogni
// singolo pezzo possa fallire senza portarsi dietro nient'altro: se
// IntersectionObserver non c'è le card compaiono subito, se il canvas non è
// leggibile l'alone resta rosso, se non ci sono locandine il mosaico non parte.
// ============================================================

// Va letta ogni volta e non salvata in una costante: la preferenza si può
// cambiare a sistema mentre la pagina è aperta.
const prefersReducedMotion = () => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  catch (e) { return false; }
};

// ---------- Colore dominante della locandina ----------
// Serve per l'alone colorato in hover. La lettura passa da un <img> separato con
// crossOrigin="anonymous": se il CDN non manda gli header CORS quel caricamento
// fallisce, ma la locandina VISIBILE (che non ha crossOrigin) resta intatta.
// Non si tocca mai l'immagine che l'utente vede.
const POSTER_COLOR_KEY = 'tvtracker-poster-colors';
const POSTER_COLOR_MAX = 400;
let posterColors = {};        // url -> "r, g, b"
let posterColorOff = false;   // interruttore generale, vedi sotto
// [CORS] Il CDN di TMDB manda Access-Control-Allow-Origin solo quando la
// richiesta porta l'header Origin. Il <img> della card non lo manda (non ha
// crossorigin: aggiungerglielo farebbe sparire la locandina se l'header manca
// davvero), quindi il CDN memorizza la variante SENZA header; la richiesta in
// modalita' CORS dell'estrazione colore se la ritrova davanti e viene bloccata.
// Al primo fallimento si riprova una volta sola con una query diversa, che salta
// quella voce di cache. Se fallisce anche quella il problema e' a monte.
let posterColorBust = false;
let posterColorFails = 0;
let posterColorSaveTimer = null;

const hydratePosterColors = () => {
  try {
    const raw = localStorage.getItem(POSTER_COLOR_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') posterColors = parsed;
  } catch (e) { posterColors = {}; }
};

const persistPosterColors = () => {
  try {
    let entries = Object.entries(posterColors);
    // Le chiavi degli oggetti mantengono l'ordine di inserimento: tagliando in
    // testa si buttano le locandine più vecchie, che sono anche quelle di serie
    // probabilmente non più in libreria.
    if (entries.length > POSTER_COLOR_MAX) entries = entries.slice(-POSTER_COLOR_MAX);
    posterColors = Object.fromEntries(entries);
    localStorage.setItem(POSTER_COLOR_KEY, JSON.stringify(posterColors));
  } catch (e) { /* quota piena: l'alone è decorativo, si può perdere */ }
};

const schedulePosterColorSave = () => {
  clearTimeout(posterColorSaveTimer);
  posterColorSaveTimer = setTimeout(persistPosterColors, 1200);
};

const rgbToHsl = (r, g, b) => {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
};

const hslToRgb = (h, s, l) => {
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)].map(v => Math.round(v * 255));
};

// La media di una locandina tende sempre al fango: molte locandine sono scure e
// desaturate. Qui la tinta si tiene e si spingono saturazione e luminosità a un
// minimo, altrimenti l'alone sarebbe un grigio indistinguibile dall'ombra.
const vividify = ([r, g, b]) => {
  const [h, s, l] = rgbToHsl(r, g, b);
  return hslToRgb(h, Math.min(1, Math.max(s, 0.58)), Math.min(0.68, Math.max(l, 0.52)));
};

const extractPosterColor = (url) => new Promise((resolve) => {
  let settled = false;
  const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
  let img;
  try { img = new Image(); } catch (e) { finish(null); return; }
  img.crossOrigin = 'anonymous';
  img.onerror = () => finish(null);
  img.onload = () => {
    try {
      // 12x18 mantiene il rapporto 2:3 del poster ed è abbastanza per una media:
      // leggere la locandina a piena risoluzione costerebbe ~150.000 pixel per card.
      const W = 12, H = 18;
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) { finish(null); return; }
      ctx.drawImage(img, 0, 0, W, H);
      // getImageData su un canvas "contaminato" da un'immagine senza CORS lancia
      // SecurityError: è il caso che gestisce il catch qui sotto.
      const px = ctx.getImageData(0, 0, W, H).data;
      let wr = 0, wg = 0, wb = 0, total = 0;
      for (let i = 0; i < px.length; i += 4) {
        if (px[i + 3] < 200) continue;
        const r = px[i], g = px[i + 1], b = px[i + 2];
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const sat = max === 0 ? 0 : (max - min) / max;
        const lum = max / 255;
        // I pixel quasi neri e quasi bianchi (bordi, scritte, cieli) non dicono
        // nulla sull'identità cromatica della locandina: pesano quasi zero.
        const inRange = lum > 0.16 && lum < 0.94 ? 1 : 0.04;
        const weight = sat * sat * inRange + 0.015;
        wr += r * weight; wg += g * weight; wb += b * weight; total += weight;
      }
      if (!total) { finish(null); return; }
      finish(vividify([wr / total, wg / total, wb / total].map(v => Math.round(v))));
    } catch (e) {
      finish(null); // canvas contaminato, o niente supporto canvas
    }
  };
  // Se il caricamento resta appeso non si tiene occupato uno slot della coda.
  setTimeout(() => finish(null), 8000);
  img.src = posterColorBust ? url + (url.includes('?') ? '&' : '?') + 'tvt=1' : url;
});

// Al massimo due decodifiche in parallelo: con 150 card in libreria, lanciarle
// tutte insieme bloccherebbe il thread principale allo scroll.
let paletteActive = 0;
const paletteQueue = [];
const pumpPaletteQueue = () => {
  while (paletteActive < 2 && paletteQueue.length) {
    const job = paletteQueue.shift();
    paletteActive++;
    extractPosterColor(job.url).then((rgb) => {
      paletteActive--;
      job.done(rgb);
      pumpPaletteQueue();
    });
  }
};

const applyPosterGlow = (el, retried = false) => {
  const url = el?.dataset?.posterUrl;
  if (!url) return;
  const cached = posterColors[url];
  if (cached) { el.style.setProperty('--card-glow', cached); return; }
  if (posterColorOff) return;
  paletteQueue.push({
    url,
    done: (rgb) => {
      if (!rgb) {
        // Un solo tentativo con la query anti-cache, vedi posterColorBust.
        if (!posterColorBust && !retried) {
          posterColorBust = true;
          applyPosterGlow(el, true);
          return;
        }
        // Tre fallimenti consecutivi significano quasi sempre una cosa sola: su
        // questo dominio il canvas non è leggibile. Continuare vorrebbe dire
        // scaricare ogni locandina una seconda volta per niente, quindi si
        // spegne la funzione per il resto della sessione e si tiene il rosso.
        if (++posterColorFails >= 3) {
          posterColorOff = true;
          paletteQueue.length = 0;
          // Un messaggio solo, invece di lasciare in console decine di errori
          // di rete senza spiegazione.
          console.info('TVTRACKER: colore dominante delle locandine disattivato — il CDN di TMDB non espone gli header CORS. Le card usano il rosso di accento. Nessun altro effetto sull\'app.');
        }
        return;
      }
      posterColorFails = 0;
      const value = rgb.join(', ');
      posterColors[url] = value;
      schedulePosterColorSave();
      // L'elemento può nel frattempo essere stato sostituito da un nuovo render:
      // in quel caso non importa, la card nuova legge il valore dalla cache
      // appena riempita e lo applica subito.
      el.style.setProperty('--card-glow', value);
    }
  });
  pumpPaletteQueue();
};

// ---------- Anello del voto ----------
const countUpTo = (el, target, duration) => {
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    // Stessa forma della curva con cui si riempie l'arco: numero e cerchio
    // arrivano al valore finale insieme.
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = (target * eased).toFixed(1);
    if (t < 1) requestAnimationFrame(step);
    else el.textContent = target.toFixed(1);
  };
  requestAnimationFrame(step);
};

// L'anello viene disegnato con stroke-dasharray="0 100" e il voto a 0.0: qui si
// scrive il valore vero. Il riempimento dell'arco è già una transizione CSS
// (.ring-fg ha transition: stroke-dasharray 0.7s), basta scriverlo in un frame
// successivo perché parta invece di applicarsi di scatto.
const settleRatingRing = (ring, animate) => {
  if (!ring || ring.dataset.ringDone === '1') return;
  ring.dataset.ringDone = '1';
  const fg = ring.querySelector('.ring-fg');
  const valEl = ring.querySelector('.ring-val');
  const dash = parseFloat(ring.dataset.dash);
  const target = parseFloat(ring.dataset.val);
  if (!fg || !isFinite(dash)) return;
  if (!animate || prefersReducedMotion() || typeof requestAnimationFrame !== 'function') {
    fg.style.strokeDasharray = `${dash} 100`;
    if (valEl && isFinite(target)) valEl.textContent = target.toFixed(1);
    return;
  }
  requestAnimationFrame(() => { fg.style.strokeDasharray = `${dash} 100`; });
  if (valEl && isFinite(target)) countUpTo(valEl, target, 800);
};

// ---------- Entrata scaglionata ----------
// Le card entrano solo quando arrivano davvero a schermo, sfalsate di poche
// decine di millisecondi. L'animazione usa la Web Animations API e non una
// classe CSS perché ogni card ha un ritardo diverso: con il CSS servirebbe una
// regola per indice. Finita l'animazione non resta nessuno stile addosso alla
// card, quindi il transform dell'hover funziona come prima.
const revealedOnce = new Set();
let revealObserver = null;

const finishReveal = (el, animate) => {
  el.removeAttribute('data-reveal');
  el.style.removeProperty('opacity');
  settleRatingRing(el.querySelector?.('.rating-ring'), animate);
  applyPosterGlow(el);
};

const revealElement = (el, indexInBatch) => {
  if (revealObserver) revealObserver.unobserve(el);
  if (el.dataset.revealKey) revealedOnce.add(el.dataset.revealKey);
  if (prefersReducedMotion() || typeof el.animate !== 'function') { finishReveal(el, false); return; }
  let anim;
  try {
    anim = el.animate(
      [{ opacity: 0, transform: 'translateY(22px) scale(0.97)' }, { opacity: 1, transform: 'none' }],
      // fill:'backwards' tiene la card invisibile anche DURANTE il ritardo:
      // senza, lampeggerebbe visibile prima di iniziare a entrare.
      { duration: 560, delay: Math.min(indexInBatch, 11) * 45, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', fill: 'backwards' }
    );
  } catch (e) { finishReveal(el, false); return; }
  // Sia onfinish sia oncancel: se la card viene rimossa a metà animazione non
  // deve poter restare invisibile.
  anim.onfinish = () => finishReveal(el, true);
  anim.oncancel = () => finishReveal(el, false);
};

const ensureRevealObserver = () => {
  if (revealObserver) return revealObserver;
  if (typeof IntersectionObserver !== 'function') return null;
  revealObserver = new IntersectionObserver((entries) => {
    const visible = entries.filter(e => e.isIntersecting);
    // L'ordine di consegna delle entries non è garantito dalla specifica: si
    // riordina per posizione, altrimenti lo sfalsamento sembra casuale.
    visible.sort((a, b) => (a.boundingClientRect.top - b.boundingClientRect.top) || (a.boundingClientRect.left - b.boundingClientRect.left));
    visible.forEach((entry, i) => revealElement(entry.target, i));
  }, { rootMargin: '90px 0px', threshold: 0.01 });
  return revealObserver;
};

const observeReveal = (el, key) => {
  const obs = ensureRevealObserver();
  // Niente IntersectionObserver, oppure card già entrata in questa sessione (un
  // secondo render non deve rianimare tutta la griglia): si mostra e basta.
  if (!obs || revealedOnce.has(key)) { finishReveal(el, false); return; }
  el.dataset.revealKey = key;
  el.dataset.reveal = 'pending';
  obs.observe(el);
};

// Rete di sicurezza: se per qualsiasi motivo l'observer non scatta (categoria
// dentro un contenitore a altezza zero, bug del browser, scheda in background al
// momento sbagliato) dopo qualche secondo si mostra comunque tutto. Meglio
// perdere l'animazione che lasciare una card invisibile.
let revealSafetyTimer = null;
const flushPendingReveals = () => {
  document.querySelectorAll('[data-reveal="pending"]').forEach(el => revealElement(el, 0));
};

// ---------- Mosaico dell'intestazione ----------
let heroSignature = '';
const HERO_TILE_PX = 108;

const renderHeroMosaic = () => {
  const art = document.getElementById('heroArt');
  const strip = document.getElementById('heroStrip');
  if (!art || !strip) return;

  const posters = [];
  const seen = new Set();
  for (const cat of data) {
    for (const show of cat.shows) {
      const p = show.poster;
      // Solo http(s), e nessuna virgoletta o parentesi: l'URL finisce dentro una
      // url("...") in CSS, dove un apice chiuso a metà romperebbe la regola.
      if (!p || !/^https?:\/\//i.test(p) || /["'()\\]/.test(p) || seen.has(p)) continue;
      seen.add(p);
      posters.push(p);
      if (posters.length >= 26) break;
    }
    if (posters.length >= 26) break;
  }

  if (!posters.length) {
    art.classList.remove('ready');
    strip.innerHTML = '';
    heroSignature = '';
    return;
  }

  const signature = posters.join('|');
  // doRender gira più volte (scheletro, dati, prefetch): senza questo controllo
  // il mosaico verrebbe ricostruito ogni volta e l'animazione ripartirebbe da capo.
  if (signature === heroSignature) return;
  heroSignature = signature;

  // La striscia va ripetuta un numero PARI di volte: l'animazione la trasla del
  // 50% della propria larghezza, quindi a fine ciclo la seconda metà si trova
  // esattamente dove stava la prima e il ritorno a capo non si vede.
  const barWidth = art.offsetWidth || 1440;
  const setWidth = posters.length * HERO_TILE_PX;
  let reps = 2 * Math.ceil((barWidth * 1.2) / Math.max(setWidth, 1));
  reps = Math.max(2, Math.min(reps, 12));

  const frag = document.createDocumentFragment();
  for (let r = 0; r < reps; r++) {
    for (const url of posters) {
      const tile = document.createElement('span');
      tile.className = 'hero-tile';
      tile.style.backgroundImage = `url("${url}")`;
      frag.appendChild(tile);
    }
  }
  strip.innerHTML = '';
  strip.appendChild(frag);
  art.classList.add('ready');
};

hydratePosterColors();

const doRender = async () => {
  await new Promise(r => requestAnimationFrame(r));
  const container = document.getElementById('categoriesContainer');
  const legendsContainer = document.getElementById('legendsContainer');
  if (!container) return;

  if (!container.children.length) {
    // [TEMA] gli stili dello scheletro erano scritti a mano qui dentro, con
    // esadecimali scuri fissi: in tema chiaro erano barre nere su fondo crema.
    // Ora sono classi in styles.css che seguono i token del tema.
    container.innerHTML = data.slice(0,3).map(() => `<div class="skeleton-cat"><div class="skeleton-cat-title"></div><div class="skeleton-grid">${Array(5).fill(0).map(()=>`<div class="skeleton-card"><div class="skeleton-poster"></div><div class="skeleton-body"><div class="skeleton-line"></div><div class="skeleton-line short"></div></div></div>`).join('')}</div></div>`).join('');
  }

  // [PERF] non aspettiamo più la rete prima di disegnare: con la cache persistente
  // quasi tutto è già disponibile e il backfill sincrono (dentro prefetchDetails)
  // è già avvenuto a questo punto. Quel che manca (serie mai viste prima) arriva
  // poco dopo e riattiva un secondo render mirato (vedi in fondo alla funzione).
  const detailsPromise = prefetchDetails();

  renderHeroMosaic(); // mosaico di locandine dietro l'intestazione (si ricostruisce solo se cambia la libreria)
  renderResume();  // "Riprendi da qui": serie in corso, con avanzamento in un click
  // [2] calendario uscite (con quel che è già in cache)
  renderUpcoming();
  renderListFilters(); // [2] filtri vista lista (genere/anno/voto)

  const legendShows = [];
  const legendTitles = new Set();
  for (const cat of data) {
    if (cat.name.toLowerCase().includes('sto guardando')) continue;
    for (const show of cat.shows) {
      const seasons = show.seasons_count || 0;
      if (seasons >= 8 && (!show.progress || parseFloat(show.progress) !== 0)) {
        legendTitles.add(show.title);
        legendShows.push({ ...show, category: cat.name });
      }
    }
  }
  legendShows.sort((a,b) => (b.seasons_count||0) - (a.seasons_count||0));

  if (!legendShows.length) {
    legendsContainer.innerHTML = '';
  } else {
    legendsContainer.innerHTML = `<div class="legends-section" id="legends-section"><div class="legends-header"><div class="crown-row"><div class="crown-line"></div><div class="crown-center"><i class="fas fa-crown crown-icon"></i></div><div class="crown-line right"></div></div><h2 class="legends-title">EPOPEE SERIALI</h2><p class="legends-subtitle">Le grandi serie con 8+ stagioni · ordinate per stagioni</p></div><div class="legends-row" id="legendsRow"></div></div>`;
    const legendsRow = document.getElementById('legendsRow');
    for (const show of legendShows) {
      const card = document.createElement('div');
      card.className = 'legend-card';
      card.onclick = () => openShowDetails(show.title);
      if (show.poster) card.dataset.posterUrl = show.poster;
      observeReveal(card, `legend:${show.title}`);
      card.innerHTML = `<div class="legend-poster-wrap"><img class="legend-poster" src="${escapeHtml(show.poster || PLACEHOLDER_IMG)}" alt="${escapeHtml(show.title)}" loading="lazy"><div class="legend-overlay"></div><div class="legend-seasons-badge"><i class="fas fa-layer-group" style="font-size:9px"></i> ${show.seasons_count} stagioni</div><div class="legend-info"><div class="legend-badge-row"><i class="fas fa-crown legend-crown-mini"></i><span class="legend-label">Epopea</span></div><div class="legend-title">${escapeHtml(show.title)}</div>${show.progress && parseFloat(show.progress) !== 0 ? `<div class="legend-progress">Visto: ${escapeHtml(show.progress)} volte</div>` : ''}</div></div>`;
      legendsRow.appendChild(card);
    }
  }

  if (!data.length) {
    container.innerHTML = `<div class="empty-msg"><i class="fas fa-tv"></i><h3>Nessuna serie TV disponibile</h3><p>Aggiungi delle serie o importa un backup</p></div>`;
    renderCategoryNav(legendShows);
    return;
  }

  container.innerHTML = '';
  let globalCounter = 1;
  const today = new Date(); today.setHours(0,0,0,0);

  for (let catIdx = 0; catIdx < data.length; catIdx++) {
    const cat = data[catIdx];
    const catLower = cat.name.toLowerCase();
    const isNumberedCat = !UNNUMBERED_CATS.some(e => catLower.includes(e));
    const isCollapsed = collapsedCategories.has(cat.name);
    const catDiv = document.createElement('div');
    catDiv.className = 'category' + (isCollapsed ? ' collapsed' : '');
    catDiv.dataset.catIdx = catIdx;
    catDiv.id = `category-${catIdx}`;
    const headerDiv = document.createElement('div');
    headerDiv.className = 'category-header';
    const titleDiv = document.createElement('div');
    titleDiv.className = 'category-title';
    titleDiv.innerHTML = `${escapeHtml(cat.name)} <span class="category-count">${cat.shows.length}</span>`;
    const collapseIcon = document.createElement('i');
    collapseIcon.className = 'fas fa-chevron-down category-collapse-icon';
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'category-actions';
    const dragHandleBtn = document.createElement('span');
    dragHandleBtn.className = 'drag-handle-cat';
    dragHandleBtn.innerHTML = '<i class="fas fa-grip-lines"></i>';
    dragHandleBtn.title = 'Trascina per riordinare';
    const deleteCatBtn = document.createElement('button');
    deleteCatBtn.className = 'category-action-btn delete-cat-btn';
    deleteCatBtn.innerHTML = '<i class="fas fa-trash"></i>';
    deleteCatBtn.title = 'Elimina categoria';
    deleteCatBtn.onclick = (e) => { e.stopPropagation(); deleteCategory(catIdx); };
    actionsDiv.appendChild(dragHandleBtn);
    actionsDiv.appendChild(deleteCatBtn);
    headerDiv.appendChild(titleDiv);
    headerDiv.appendChild(collapseIcon);
    headerDiv.appendChild(actionsDiv);
    headerDiv.addEventListener('click', (e) => {
      if (e.target.closest('.category-actions')) return;
      if (collapsedCategories.has(cat.name)) collapsedCategories.delete(cat.name);
      else collapsedCategories.add(cat.name);
      saveCollapsed();
      catDiv.classList.toggle('collapsed');
    });
    dragHandleBtn.draggable = true;
    dragHandleBtn.addEventListener('dragstart', (e) => {
      drag.type = 'category'; drag.catIdx = catIdx;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', 'category');
      setTimeout(() => catDiv.classList.add('cat-dragging'), 0);
    });
    dragHandleBtn.addEventListener('dragend', () => {
      catDiv.classList.remove('cat-dragging');
      document.querySelectorAll('.cat-drag-over').forEach(el => el.classList.remove('cat-drag-over'));
      drag.type = null; drag.catIdx = null;
    });
    catDiv.appendChild(headerDiv);
    const bodyDiv = document.createElement('div');
    bodyDiv.className = 'category-body';
    const showsRow = document.createElement('div');
    showsRow.className = 'shows-row';
    showsRow.dataset.catIdx = catIdx;
    if (!cat.shows.length) {
      // Il suggerimento cambia in base al TIPO della categoria (non al nome
      // esatto): "Sto guardando" vuota e "Da vedere" vuota non hanno lo stesso
      // problema, e dire "aggiungine una" a entrambe non aiuta nessuna delle due.
      const HINTS = {
        watching: 'Trascina qui una serie da "Da vedere" per iniziare a seguirla.',
        todo: 'La lista d\'attesa e\' vuota: cerca una serie qui sopra e aggiungila.',
        future: 'Nessuna serie in programma. Metti qui quelle che devono ancora uscire.',
        custom: 'Nessuna serie in questa categoria. Aggiungine una qui sotto.',
      };
      const emptyMsg = document.createElement('div');
      emptyMsg.className = 'empty-msg empty-msg-rich';
      emptyMsg.innerHTML = `<svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <rect x="2" y="2" width="20" height="20" rx="5"/><path d="M7 2v20M17 2v20M2 12h20"/>
        </svg>
        <div class="empty-msg-title">Nessuna serie qui</div>
        <div class="empty-msg-hint">${escapeHtml(HINTS[cat.type] || HINTS.custom)}</div>`;
      showsRow.appendChild(emptyMsg);
    } else if (viewMode === 'list') {
      // [8] in vista lista le card non vengono costruite: si usa la tabella
    } else {
      for (let showIdx = 0; showIdx < cat.shows.length; showIdx++) {
        const show = cat.shows[showIdx];
        const isLegend = legendTitles.has(show.title);
        const card = document.createElement('div');
        card.className = 'show-card';
        card.draggable = true;
        card.dataset.catIdx = catIdx;
        card.dataset.showIdx = showIdx;
        card.dataset.title = show.title;
        card.dataset.showId = show.id || '';
        if (compareSelection.includes(show.id)) card.classList.add('compare-selected');
        // usato dalla ricerca per genere: minuscolo e separato da | (nessun
        // genere TMDB contiene la pipe, a differenza della virgola)
        const cachedGenres = showDetailsCache.get(show.title)?.genre_names;
        if (cachedGenres?.length) card.dataset.genres = cachedGenres.join('|').toLowerCase();
        if (show.tags?.length) card.dataset.tags = show.tags.join('|').toLowerCase();
        if (isLegend) card.dataset.isLegend = 'true';
        const posterUrl = show.poster || PLACEHOLDER_IMG;
        const ratingEntry = ratingsData[show.title];
        const detailsCached = showDetailsCache.get(show.title);
        const nextEp = detailsCached?.next_episode_to_air;
        const nextEpAir = nextEp ? parseAirDate(nextEp.air_date) : null;
        const isFutureEpisode = !!(nextEpAir && nextEpAir >= today);
        let numberHtml;
        if (isNumberedCat) {
          numberHtml = isLegend ? `<i class="fas fa-crown" style="color:#d4af37;font-size:9px"></i> ${globalCounter}.` : `${globalCounter}.`;
          globalCounter++;
        } else {
          numberHtml = isLegend ? `<i class="fas fa-crown" style="color:#d4af37;font-size:9px"></i>` : '';
        }
        // [SEC] progress è testo libero (modale di modifica, JSON importato, Firestore):
// va escapato come tutto il resto prima di finire in innerHTML.
const progressHtml = show.progress && parseFloat(show.progress) !== 0 ? `<div class="show-progress">Visto: ${escapeHtml(show.progress)} volte</div>` : (show.progress !== undefined && parseFloat(show.progress) === 0 ? `<div class="show-progress unseen">Da vedere</div>` : '');
        // [6] anello di progresso colorato al posto del badge testuale
        let ratingRingHtml = '';
        if (ratingEntry) {
          const avg = ratingEntry.average;
          const tier = ratingTier(avg);
          card.dataset.ratingTier = tier;
          const dash = (avg / 10 * 100).toFixed(1);
          const tooltipRows = RATING_TOOLTIP_CATS.map(c => `<div class="rating-tooltip-row"><span class="rating-tooltip-label">${c.label}</span><span class="rating-tooltip-val">${ratingEntry[c.key]}</span></div>`).join('');
          // L'anello nasce vuoto (0 100) e con il voto a 0.0: settleRatingRing lo
          // riempie quando la card entra a schermo, così l'arco si disegna e il
          // numero sale invece di comparire già fatto. Con movimento ridotto, o
          // se la card era già stata mostrata, il valore viene scritto subito.
          ratingRingHtml = `<div class="rating-ring ${tier}" data-show-title="${escapeHtml(show.title)}" data-dash="${dash}" data-val="${avg.toFixed(1)}">
            <svg viewBox="0 0 36 36"><circle class="ring-bg" cx="18" cy="18" r="15.915"/><circle class="ring-fg" cx="18" cy="18" r="15.915" stroke-dasharray="0 100"/></svg>
            <span class="ring-val">0.0</span>
            <div class="rating-tooltip">${tooltipRows}<div class="rating-tooltip-divider"></div><div class="rating-tooltip-avg-row"><span class="rating-tooltip-avg-label">Media</span><span class="rating-tooltip-avg-val">${avg.toFixed(1)}</span></div></div>
          </div>`;
        }
        let nextEpisodeBadgeHtml = '';
        if (isFutureEpisode) {
          const dateFormatted = nextEpAir.toLocaleDateString('it-IT', { day:'2-digit', month:'short' });
          nextEpisodeBadgeHtml = `<div class="next-episode-badge" title="S${nextEp.season_number}E${nextEp.episode_number}"><i class="fas fa-clock"></i> Prossimo ep. ${dateFormatted}</div>`;
        }
        // [4] Barra di avanzamento episodi, solo per la categoria "Sto guardando"
        let epProgressMiniHtml = '';
        if (isWatchingCat(cat.name)) {
          const epProgress = computeEpisodeProgress(show.title);
          if (epProgress) {
            epProgressMiniHtml = `<div class="ep-progress-mini"><div class="ep-progress-mini-bar"><div class="ep-progress-mini-fill" style="width:${epProgress.pct}%"></div></div><div class="ep-progress-mini-label">S${epProgress.season}E${epProgress.episode} · ${epProgress.pct}%</div></div>`;
          }
        }
        // [PERF] La lista "Sposta in..." veniva generata per OGNI card: con N serie
        // e M categorie sono N×M pulsanti creati ad ogni render, tutti invisibili
        // finché non si apre il menu. Ora il contenitore nasce vuoto e viene
        // riempito alla prima apertura del menu di quella card.
        const tagsHtml = (show.tags || []).length
          ? `<div class="show-tags">${show.tags.map(t => `<span class="show-tag">${escapeHtml(t)}</span>`).join('')}</div>`
          : '';
        const isSelected = selectedShows.has(show.title);
        if (bulkMode) card.classList.add('bulk-selectable');
        if (isSelected) card.classList.add('bulk-selected');
        const bulkCheckboxHtml = bulkMode ? `<div class="bulk-checkbox ${isSelected ? 'checked' : ''}"><i class="fas fa-check"></i></div>` : '';
        // FIX: show-number, card-menu, rating-ring e poster-info sono ora FUORI da .poster-wrap
        // (che ha overflow:hidden per l'effetto zoom sul poster). Prima erano dentro,
        // quindi il tooltip del voto medio veniva tagliato dal bordo della card.
        card.innerHTML = `<div class="poster-wrap"><img class="poster" src="${escapeHtml(posterUrl)}" alt="${escapeHtml(show.title)}" loading="lazy"><div class="poster-overlay"></div></div>${numberHtml ? `<div class="show-number">${numberHtml}</div>` : ''}${bulkCheckboxHtml}<button type="button" class="card-menu" aria-haspopup="menu" aria-expanded="false" aria-label="Altre azioni per ${escapeHtml(show.title)}"><i class="fas fa-ellipsis-vertical" aria-hidden="true"></i></button>${ratingRingHtml}<div class="poster-info${ratingEntry ? ' has-rating-space' : ''}"><div class="show-title">${escapeHtml(show.title)}</div>${tagsHtml}${progressHtml}${epProgressMiniHtml}${nextEpisodeBadgeHtml}</div>`;
        const openOrSelect = (e) => {
          if (bulkMode) toggleShowSelection(show.title);
          else openShowDetails(show.title);
        };
        // FIX CLICK: prima il click funzionava solo se si colpiva esattamente il
        // poster o il testo del titolo. Il resto della card (bordi, spazio vuoto,
        // badge) mostrava comunque il cursore "afferra" (per il drag&drop) dando
        // l'illusione di essere cliccabile, ma non lo era. Ora risponde tutta la
        // card; menu ⋮, anello voto e checkbox hanno il loro stopPropagation e
        // restano quindi azioni separate dal click di apertura.
        card.onclick = openOrSelect;
        // [A11Y] La card è un div: senza tabindex e gestione di Invio/Spazio
        // l'intera griglia era inutilizzabile da tastiera.
        card.tabIndex = 0;
        card.setAttribute('role', 'button');
        card.setAttribute('aria-label', show.title);
        card.onkeydown = (e) => {
          if (e.target !== card) return; // lasciamo passare i tasti dei controlli interni
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          openOrSelect(e);
        };
        const bulkCheckboxEl = card.querySelector('.bulk-checkbox');
        if (bulkCheckboxEl) bulkCheckboxEl.onclick = (e) => { e.stopPropagation(); toggleShowSelection(show.title); };
        const menuBtn = card.querySelector('.card-menu');
        // La card intera apre la scheda al click: senza stopPropagation il ⋮
        // farebbe scattare anche quella.
        menuBtn.onclick = (e) => { e.stopPropagation(); openFloatingMenu(menuBtn, buildCardMenuItems(catIdx, showIdx, show)); };
        menuBtn.onkeydown = (e) => e.stopPropagation(); // Invio/Spazio li gestisce già <button>

        if (ratingEntry) card.querySelector('.rating-ring').onclick = (e) => { e.stopPropagation(); openRatingDetails(show.title); };
        card.draggable = !bulkMode;
        card.addEventListener('dragstart', (e) => {
          drag.type = 'show'; drag.catIdx = catIdx; drag.showIdx = showIdx;
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', 'show');
          setTimeout(() => card.classList.add('dragging'), 0);
        });
        card.addEventListener('dragend', () => {
          card.classList.remove('dragging');
          removePlaceholder();
          document.querySelectorAll('.cat-drag-over').forEach(el => el.classList.remove('cat-drag-over'));
          drag.type = null; drag.catIdx = null; drag.showIdx = null;
        });
        // Entrata scaglionata + alone del colore della locandina. La chiave è il
        // titolo e non la posizione: spostando una serie di categoria non deve
        // rientrare da capo, e soprattutto un riordino non deve far rianimare
        // card diverse da quelle davvero nuove.
        if (posterUrl !== PLACEHOLDER_IMG) card.dataset.posterUrl = posterUrl;
        observeReveal(card, `show:${show.title}`);
        showsRow.appendChild(card);
      }
    }
    showsRow.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (drag.type === 'show') {
        document.querySelectorAll('.cat-drag-over').forEach(el => el.classList.remove('cat-drag-over'));
        catDiv.classList.add('cat-drag-over');
        movePlaceholderTo(showsRow, getInsertBeforeCard(showsRow, e.clientX, e.clientY));
      } else if (drag.type === 'category') {
        document.querySelectorAll('.cat-drag-over').forEach(el => el.classList.remove('cat-drag-over'));
        catDiv.classList.add('cat-drag-over');
      }
    });
    showsRow.addEventListener('dragleave', (e) => {
      if (!catDiv.contains(e.relatedTarget)) catDiv.classList.remove('cat-drag-over');
    });
    showsRow.addEventListener('drop', async (e) => {
      e.preventDefault();
      catDiv.classList.remove('cat-drag-over');
      if (drag.type === 'show' && drag.catIdx !== null && drag.showIdx !== null) {
        const srcCatIdx = drag.catIdx, srcShowIdx = drag.showIdx;
        const dstCatIdx = parseInt(showsRow.dataset.catIdx);
        let insertIdx = data[dstCatIdx].shows.length;
        if (drag.placeholder && drag.placeholder.parentNode === showsRow) {
          const allChildren = [...showsRow.children];
          const phIdx = allChildren.indexOf(drag.placeholder);
          insertIdx = allChildren.slice(0, phIdx).filter(c => c.classList.contains('show-card') && !c.classList.contains('dragging')).length;
        }
        removePlaceholder();
        const movedTitle = data[srcCatIdx].shows[srcShowIdx].title;
        if (srcCatIdx !== dstCatIdx && catHasTitle(data[dstCatIdx], movedTitle)) {
          showToast(`"${movedTitle}" è già presente in "${data[dstCatIdx].name}".`); // [10]
          drag.type = null; drag.catIdx = null; drag.showIdx = null;
          await render();
          return;
        }
        const [movedShow] = data[srcCatIdx].shows.splice(srcShowIdx, 1);
        if (srcCatIdx !== dstCatIdx) trackWatchTransition(movedShow, data[srcCatIdx], data[dstCatIdx]); // [2] tempo di visione
        let realInsertIdx = insertIdx;
        if (srcCatIdx === dstCatIdx && srcShowIdx < insertIdx) realInsertIdx = Math.max(0, insertIdx - 1);
        data[dstCatIdx].shows.splice(realInsertIdx, 0, movedShow);
        drag.lastDroppedTitle = movedTitle;
        saveData();
        drag.type = null; drag.catIdx = null; drag.showIdx = null;
        await render();
        if (drag.lastDroppedTitle) {
          document.querySelectorAll('.show-card').forEach(c => {
            if (c.querySelector('.show-title')?.textContent === drag.lastDroppedTitle) {
              c.classList.add('just-dropped');
              setTimeout(() => c.classList.remove('just-dropped'), 500);
            }
          });
          drag.lastDroppedTitle = null;
        }
      } else if (drag.type === 'category') {
        const srcCatIdx = drag.catIdx, dstCatIdx = catIdx;
        if (srcCatIdx !== dstCatIdx) {
          const [movedCat] = data.splice(srcCatIdx, 1);
          data.splice(dstCatIdx, 0, movedCat);
          // niente rimappatura: collapsedCategories è indicizzato per nome
          saveData();
        }
        drag.type = null; drag.catIdx = null;
        await render();
      }
    });
    if (viewMode === 'list' && cat.shows.length) bodyDiv.appendChild(buildShowsTable(cat, catIdx, legendTitles));
    else bodyDiv.appendChild(showsRow);
    const addForm = document.createElement('form');
    addForm.className = 'add-show-form';
    // FIX #2: classi dedicate sugli input, niente più selettori basati sul placeholder
    addForm.innerHTML = `<div style="position:relative"><input type="text" class="show-title-input" name="show-title" placeholder="Titolo serie..." autocomplete="off" /></div><input type="text" class="show-progress-input" name="show-progress" placeholder="Volte viste (0 = da vedere)" /><input type="text" class="show-poster-input" name="show-poster" placeholder="URL poster (opzionale)" /><button type="submit" class="btn btn-secondary"><i class="fas fa-plus btn-icon"></i> Aggiungi</button><span class="drop-hint">Trascina per riordinare</span>`;
    addForm.onsubmit = async (e) => {
      e.preventDefault();
      const titleInput = addForm.querySelector('.show-title-input');
      const progressInput = addForm.querySelector('.show-progress-input');
      const posterInput = addForm.querySelector('.show-poster-input');
      const title = titleInput.value.trim();
      if (!title) return;
      if (data[catIdx].shows.some(s => s.title.toLowerCase() === title.toLowerCase())) {
        showToast(`"${title}" è già presente in questa categoria.`);
        return;
      }
      let progress = progressInput.value.trim().replace(',', '.');
      const poster = posterInput.value.trim() || undefined;
      const tmdbId = titleInput.dataset.tmdbId ? parseInt(titleInput.dataset.tmdbId, 10) : undefined; // [PERF]
      const matched = progress.match(/[\d.]+/);
      progress = matched ? matched[0] : (progress ? progress : undefined);
      const newShow = { id: generateId(), title, progress: progress || undefined, poster, tmdbId, addedAt: new Date().toISOString(), tags: [] };
      data[catIdx].shows.push(newShow);
      saveData();
      delete titleInput.dataset.tmdbId;
      titleInput.value = ''; progressInput.value = ''; posterInput.value = '';
      const dropdown = addForm.querySelector('.autocomplete-dropdown');
      if (dropdown) { dropdown.innerHTML = ''; dropdown.style.display = 'none'; }
      await render();
      flagJustAdded(newShow.id);
    };
    bodyDiv.appendChild(addForm);
    catDiv.appendChild(bodyDiv);
    container.appendChild(catDiv);
  }
  renderCategoryNav(legendShows);
  applySearch();
  renderRecommendations(); // [5] non bloccante
  renderBulkBar(); // [3] barra azioni multiple
  syncCompareUi(); // le card sono state ricostruite: rimette badge e barra confronto

  // Rete di sicurezza dell'entrata scaglionata: se dopo tre secondi qualche card
  // è ancora in attesa (observer che non è scattato, scheda in secondo piano al
  // momento del render) la si mostra comunque. Una card invisibile è un bug,
  // un'animazione persa no.
  clearTimeout(revealSafetyTimer);
  revealSafetyTimer = setTimeout(flushPendingReveals, 3000);

  // [PERF] quando arrivano dati nuovi da TMDB (episodi in uscita, stagioni di
  // serie mai viste prima), ridisegna una volta sola; il primo disegno intanto
  // non ha aspettato nulla. Aggiorna anche le notifiche episodi con i dati freschi.
  detailsPromise.then((changed) => {
    if (changed) render();
    checkEpisodeNotifications();
  });
};

// FIX: prima un render concorrente veniva semplicemente scartato (renderScheduled).
// Ora viene accodato ed eseguito subito dopo.
const render = async () => {
  if (rendering) { renderQueued = true; return; }
  rendering = true;
  try {
    await doRender();
  } catch (e) {
    console.error('Errore di render:', e);
  } finally {
    rendering = false;
    if (renderQueued) { renderQueued = false; await render(); }
  }
};

// [UNDO] Niente più dialogo di conferma: si elimina subito e per otto secondi
// si può annullare dal toast. La serie viene reinserita nella stessa categoria
// (cercata per NOME, non per indice: nel frattempo l'ordine può essere cambiato)
// e nella stessa posizione.
const deleteShow = async (catIdx, showIdx) => {
  const cat = data[catIdx];
  if (!cat) return;
  const [removed] = cat.shows.splice(showIdx, 1);
  if (!removed) return;
  const catName = cat.name;
  selectedShows.delete(removed.title); // [FIX] restava selezionata: contatore della barra bulk sfasato
  if (removed.id && compareSelection.includes(removed.id)) {
    compareSelection = compareSelection.filter(id => id !== removed.id);
    syncCompareUi();
  }
  saveData();
  await render();
  showActionToast(`"${removed.title}" eliminata.`, 'Annulla', async () => {
    const target = data.find(c => c.name === catName);
    if (!target) { showError('La categoria di origine non esiste più: impossibile annullare.'); return; }
    target.shows.splice(Math.min(showIdx, target.shows.length), 0, removed);
    saveData();
    await render();
    showToast(`"${removed.title}" ripristinata.`, 'success');
  }, {
    // La voce di cache si butta solo quando l'annullamento non è più possibile:
    // altrimenti ripristinare la serie costerebbe una fetch TMDB inutile.
    onExpire: () => {
      const stillUsed = data.some(c => c.shows.some(x => x.title === removed.title));
      if (!stillUsed) showDetailsCache.delete(removed.title);
    }
  });
};
// [10] La destinazione contiene già una serie con questo titolo? Spostarla creerebbe
// un duplicato che condividerebbe voto, date e diario (indicizzati per titolo).
const catHasTitle = (cat, title) => cat.shows.some(s => s.title.toLowerCase() === title.toLowerCase());

const moveShow = async (srcCatIdx, srcShowIdx, dstCatIdx) => {
  const srcCatRef = data[srcCatIdx];
  const dstCatRef = data[dstCatIdx];
  if (srcCatIdx !== dstCatIdx && catHasTitle(dstCatRef, srcCatRef.shows[srcShowIdx].title)) {
    showToast(`"${srcCatRef.shows[srcShowIdx].title}" è già presente in "${dstCatRef.name}".`);
    return;
  }
  const [movedShow] = srcCatRef.shows.splice(srcShowIdx, 1);
  trackWatchTransition(movedShow, srcCatRef, dstCatRef); // [2] tempo di visione
  dstCatRef.shows.push(movedShow);
  saveData();
  await render();
};
const deleteCategory = async (catIdx) => {
  const cat = data[catIdx];
  // Qui la conferma resta: si porta via N serie in un colpo solo. L'annullamento
  // è la seconda rete di sicurezza, non la sostituisce.
  const msg = cat.shows.length ? `La categoria "${cat.name}" contiene ${cat.shows.length} serie: verranno eliminate insieme a lei.` : `La categoria "${cat.name}" è vuota.`;
  if (!await confirmDialog({ title: 'Elimina categoria', message: msg, confirmLabel: 'Elimina', danger: true })) return;
  const [removedCat] = data.splice(catIdx, 1);
  const wasCollapsed = collapsedCategories.delete(cat.name);
  saveCollapsed();
  saveData();
  await render();
  showActionToast(`Categoria "${removedCat.name}" eliminata${removedCat.shows.length ? ` con ${removedCat.shows.length} serie` : ''}.`, 'Annulla', async () => {
    data.splice(Math.min(catIdx, data.length), 0, removedCat);
    if (wasCollapsed) { collapsedCategories.add(removedCat.name); saveCollapsed(); }
    saveData();
    await render();
    showToast(`Categoria "${removedCat.name}" ripristinata.`, 'success');
  }, { onExpire: () => pruneDetailsCache() }); // la cache si pulisce solo a annullamento scaduto
};

// ==================== [3] SELEZIONE MULTIPLA (BULK) ====================
// [PERF] Prima ogni spunta ricostruiva l'INTERO DOM (tutte le card, i loro
// listener, la nav laterale) solo per accendere una checkbox. Ora si aggiornano
// i pochi elementi interessati e la sola barra delle azioni multiple.
const toggleShowSelection = (title) => {
  if (selectedShows.has(title)) selectedShows.delete(title); else selectedShows.add(title);
  const isSelected = selectedShows.has(title);
  document.querySelectorAll('.show-card').forEach(card => {
    if (card.dataset.title !== title) return;
    card.classList.toggle('bulk-selected', isSelected);
    card.querySelector('.bulk-checkbox')?.classList.toggle('checked', isSelected);
  });
  document.querySelectorAll('.bulk-row-checkbox').forEach(cb => {
    if (cb.dataset.title === title) cb.checked = isSelected;
  });
  renderBulkBar();
};

const bulkMoveTo = async (dstCatIdx) => {
  const dstCat = data[dstCatIdx];
  if (!dstCat) return;
  let skipped = 0;
  for (const title of selectedShows) {
    const ref = findShowRef(title);
    if (!ref) continue;
    if (ref.cat === dstCat) continue; // già lì: niente da fare
    if (catHasTitle(dstCat, title)) { skipped++; continue; } // [10] eviterebbe un duplicato
    const [movedShow] = ref.cat.shows.splice(ref.showIdx, 1);
    trackWatchTransition(movedShow, ref.cat, dstCat); // [2] tempo di visione
    dstCat.shows.push(movedShow);
  }
  selectedShows.clear();
  saveData();
  await render();
  if (skipped) showToast(skipped === 1
    ? `1 serie non spostata: era già presente in "${dstCat.name}".`
    : `${skipped} serie non spostate: erano già presenti in "${dstCat.name}".`);
};

const bulkDelete = async () => {
  const count = selectedShows.size;
  if (!await confirmDialog({ title: 'Elimina serie selezionate', message: `Stai per eliminare ${count} serie.`, confirmLabel: 'Elimina', danger: true })) return;
  // Si annota da dove veniva ognuna, così l'annullamento le rimette al loro posto
  // e non tutte in fondo alla prima categoria.
  const removed = [];
  for (const title of selectedShows) {
    const ref = findShowRef(title);
    if (!ref) continue;
    const [show] = ref.cat.shows.splice(ref.showIdx, 1);
    removed.push({ show, catName: ref.cat.name, showIdx: ref.showIdx });
  }
  selectedShows.clear();
  saveData();
  await render();
  if (!removed.length) return;
  showActionToast(`${removed.length} serie eliminate.`, 'Annulla', async () => {
    // In ordine inverso: reinserendo dall'ultimo indice al primo, gli indici
    // annotati restano validi mano a mano che la categoria si ripopola.
    for (const { show, catName, showIdx } of removed.slice().reverse()) {
      const target = data.find(c => c.name === catName);
      if (target) target.shows.splice(Math.min(showIdx, target.shows.length), 0, show);
    }
    saveData();
    await render();
    showToast(`${removed.length} serie ripristinate.`, 'success');
  }, { onExpire: () => pruneDetailsCache() });
};

const renderBulkBar = () => {
  const container = document.getElementById('bulkBarContainer');
  if (!container) return;
  if (!bulkMode || !selectedShows.size) { container.innerHTML = ''; return; }
  container.innerHTML = `<div class="bulk-bar">
    <span class="bulk-bar-count"><i class="fas fa-check-double"></i> ${selectedShows.size} selezionate</span>
    <select id="bulkMoveTarget"><option value="">Sposta in...</option>${data.map((c, i) => `<option value="${i}">${escapeHtml(c.name)}</option>`).join('')}</select>
    <button class="btn btn-danger" id="bulkDeleteBtn"><i class="fas fa-trash btn-icon"></i> Elimina</button>
    <button class="btn btn-secondary" id="bulkCancelBtn"><i class="fas fa-times btn-icon"></i> Deseleziona</button>
  </div>`;
  container.querySelector('#bulkMoveTarget').onchange = async (e) => {
    if (e.target.value === '') return;
    await bulkMoveTo(parseInt(e.target.value, 10));
  };
  container.querySelector('#bulkDeleteBtn').onclick = bulkDelete;
  container.querySelector('#bulkCancelBtn').onclick = () => { selectedShows.clear(); render(); };
};

// La modalità selezione si attiva dal menu ⋮; il suo stato è visibile dalla
// barra azioni in basso e dalle checkbox sulle card, non più da un bottone acceso.
const toggleBulkMode = () => {
  bulkMode = !bulkMode;
  if (!bulkMode) selectedShows.clear();
  render();
  showToast(bulkMode ? 'Modalità selezione attiva: tocca le serie da selezionare.' : 'Modalità selezione disattivata.', 'success');
};

const openEditModal = (catIdx, showIdx) => {
  const targetShow = data[catIdx].shows[showIdx];
  if (!targetShow) return;
  const oldTitle = targetShow.title;
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `<div class="modal-content edit-modal"><div class="modal-header"><h2>Modifica serie</h2><button class="modal-close" aria-label="Chiudi">&times;</button></div><div class="edit-form"><label>Titolo</label><input id="editTitle" type="text" class="form-input" value="${escapeHtml(targetShow.title)}" /><label>Progresso (0 = da vedere)</label><input id="editProgress" type="text" class="form-input" value="${escapeHtml(targetShow.progress || '')}" /><label>Poster URL</label><input id="editPoster" type="text" class="form-input" value="${escapeHtml(targetShow.poster || '')}" /><label>Tag (separati da virgola)</label><input id="editTags" type="text" class="form-input" list="tagSuggestions" value="${escapeHtml((targetShow.tags || []).join(', '))}" placeholder="es. Netflix, Da finire, Doppiato..." /><datalist id="tagSuggestions">${allTags().map(t => `<option value="${escapeHtml(t)}"></option>`).join('')}</datalist></div><div class="edit-actions"><button class="btn btn-primary" id="saveEdit"><i class="fas fa-save btn-icon"></i> Salva</button><button class="btn btn-secondary" id="cancelEdit">Annulla</button></div></div>`;
  mountModal(modal);
  const closeModal = () => modal.remove();
  modal.querySelector('.modal-close').onclick = closeModal;
  modal.querySelector('#cancelEdit').onclick = closeModal;
  modal.onclick = (e) => { if (e.target === modal) closeModal(); };
  setTimeout(() => modal.querySelector('#editTitle').focus(), 50);
  modal.querySelector('#saveEdit').onclick = async () => {
    const newTitle = modal.querySelector('#editTitle').value.trim();
    let newProgress = modal.querySelector('#editProgress').value.trim().replace(',', '.');
    const newPoster = modal.querySelector('#editPoster').value.trim();
    const match = newProgress.match(/[\d.]+/);
    newProgress = match ? match[0] : (newProgress ? newProgress : undefined);
    if (newTitle && newTitle !== oldTitle && data[catIdx].shows.some((s, i) => i !== showIdx && s.title.toLowerCase() === newTitle.toLowerCase())) {
      showToast(`"${newTitle}" è già presente in questa categoria.`);
      return;
    }
    targetShow.title = newTitle || targetShow.title;
    targetShow.progress = newProgress || undefined;
    targetShow.poster = newPoster || undefined;
    targetShow.tags = parseTagsInput(modal.querySelector('#editTags').value);
    if (newTitle && newTitle !== oldTitle) {
      targetShow.seasons_count = undefined;
      showDetailsCache.delete(oldTitle);
      // voti, date e diario sono indicizzati per titolo: senza migrazione
      // resterebbero appesi al vecchio nome e sparirebbero dalla UI
      if (ratingsData[oldTitle] && !ratingsData[newTitle]) {
        ratingsData[newTitle] = ratingsData[oldTitle];
        delete ratingsData[oldTitle];
        saveRatings();
      }
      if (watchData[oldTitle] && !watchData[newTitle]) {
        // Qui dentro c'e' anche watchedEpisodes: senza lo spostamento la
        // checklist della serie rinominata ripartirebbe da zero.
        watchData[newTitle] = watchData[oldTitle];
        delete watchData[oldTitle];
        saveWatchData();
      }
    }
    saveData();
    await render();
    closeModal();
  };
};

const openShowDetails = async (title) => {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `<div class="modal-content"><div class="modal-header"><h2>${escapeHtml(title)}</h2><button class="modal-close" aria-label="Chiudi">&times;</button></div><div class="modal-body"><div style="padding:40px;text-align:center;grid-column:1/-1">Caricamento dettagli...</div></div></div>`;
  mountModal(modal);
  const closeModal = () => modal.remove();
  modal.querySelector('.modal-close').onclick = closeModal;
  modal.onclick = (e) => { if (e.target === modal) closeModal(); };
  // Se in cache c'è una voce salvata prima di trailer e cast, la si butta e si
  // ricarica SOLO questa serie: una richiesta, solo quando serve davvero.
  const cachedEntry = showDetailsCache.get(title);
  if (cachedEntry && cachedEntry.v !== DETAILS_SCHEMA_VERSION) showDetailsCache.delete(title);
  const details = await fetchShowDetails(title, cachedEntry?.id || null);
  if (!document.body.contains(modal)) return;
  if (!details) {
    modal.querySelector('.modal-body').innerHTML = `<div style="padding:40px;text-align:center;grid-column:1/-1">Impossibile caricare i dettagli</div>`;
    return;
  }

  // Testata cinematografica. backdrop_path era già dentro la cache dei dettagli
  // (lo salva fetchShowDetails) e non veniva mostrato da nessuna parte: qui non
  // si aggiunge nessuna chiamata di rete, si usa un dato che c'era già.
  if (details.backdrop_path) {
    const content = modal.querySelector('.modal-content');
    if (content && !content.querySelector('.modal-backdrop-art')) {
      content.classList.add('has-backdrop');
      const art = document.createElement('div');
      art.className = 'modal-backdrop-art';
      art.setAttribute('aria-hidden', 'true'); // decorativa: il titolo è già nell'intestazione
      const img = document.createElement('img');
      img.src = TMDB_IMG_BACKDROP + details.backdrop_path;
      img.alt = '';
      // Se il backdrop non arriva si torna all'intestazione normale invece di
      // lasciare 250px di vuoto sopra al titolo.
      img.onerror = () => { content.classList.remove('has-backdrop'); art.remove(); };
      const veil = document.createElement('span');
      veil.className = 'modal-backdrop-veil';
      art.appendChild(img);
      art.appendChild(veil);
      content.insertBefore(art, content.firstChild);
    }
  }

  // [2] Tempo di visione: date di inizio/fine, modificabili, con bottone "aggiungi" se assenti
  const renderWatchTimeBlock = (justSavedField = null) => {
    const container = modal.querySelector('#watchTimeContainer');
    if (!container) return;
    const watch = watchData[title] || {};
    const summary = computeWatchSummary(watch);
    const row = (field, label) => {
      const val = watch[field];
      if (val) {
        return `<div class="wt-row" data-field="${field}"><span class="wt-label">${label}</span><span class="wt-value">${formatWatchDate(val)}</span><button class="wt-edit-btn" data-field="${field}" title="Modifica data"><i class="fas fa-pen"></i></button><button class="wt-clear-btn" data-field="${field}" title="Rimuovi data"><i class="fas fa-times"></i></button></div>`;
      }
      return `<div class="wt-row" data-field="${field}"><span class="wt-label">${label}</span><span class="wt-value wt-empty">Non impostata</span><button class="wt-add-btn" data-field="${field}"><i class="fas fa-plus"></i> Aggiungi</button></div>`;
    };
    let summaryHtml = '';
    if (summary?.type === 'done') summaryHtml = `<div class="wt-summary wt-summary-done"><i class="fas fa-hourglass-end"></i> Guardata in <strong>${summary.days}</strong> giorn${summary.days === 1 ? 'o' : 'i'}</div>`;
    else if (summary?.type === 'ongoing') summaryHtml = `<div class="wt-summary wt-summary-ongoing"><i class="fas fa-hourglass-half"></i> In corso da <strong>${summary.days}</strong> giorn${summary.days === 1 ? 'o' : 'i'}</div>`;
    container.innerHTML = `<h4><i class="fas fa-stopwatch"></i> Tempo di visione</h4><div class="wt-rows">${row('startedAt', 'Inizio')}${row('finishedAt', 'Fine')}</div>${summaryHtml}`;

    // [FIX SALVATAGGIO] Flash verde di conferma sulla riga appena salvata
    if (justSavedField) {
      const savedRow = container.querySelector(`.wt-row[data-field="${justSavedField}"]`);
      if (savedRow) {
        savedRow.classList.add('wt-just-saved');
        setTimeout(() => savedRow.classList.remove('wt-just-saved'), 1200);
      }
    }

    container.querySelectorAll('.wt-clear-btn').forEach(btn => {
      btn.onclick = async () => {
        const field = btn.dataset.field;
        if (!watchData[title]) return;
        delete watchData[title][field];
        btn.disabled = true;
        const ok = await saveWatchData();
        if (!ok) showError('Data rimossa in locale, ma la sincronizzazione cloud non è riuscita (verrà ritentata).');
        renderWatchTimeBlock();
      };
    });
    container.querySelectorAll('.wt-edit-btn, .wt-add-btn').forEach(btn => {
      btn.onclick = () => {
        const field = btn.dataset.field;
        const rowEl = btn.closest('.wt-row');
        const currentVal = watch[field] || new Date().toISOString().slice(0, 10);
        rowEl.innerHTML = `<input type="date" class="wt-date-input" name="watch-date" value="${currentVal}"><button class="wt-save-btn" title="Salva"><i class="fas fa-check"></i></button><button class="wt-cancel-btn" title="Annulla"><i class="fas fa-times"></i></button>`;
        const input = rowEl.querySelector('.wt-date-input');
        input.focus();
        rowEl.querySelector('.wt-save-btn').onclick = async () => {
          if (!input.value) return;
          watchData[title] = watchData[title] || {};
          watchData[title][field] = input.value;
          const saveBtn = rowEl.querySelector('.wt-save-btn');
          if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i>'; }
          const ok = await saveWatchData();
          if (!ok) showError('Data salvata in locale, ma la sincronizzazione cloud non è riuscita (verrà ritentata).');
          renderWatchTimeBlock(ok ? field : null);
        };
        rowEl.querySelector('.wt-cancel-btn').onclick = () => renderWatchTimeBlock();
      };
    });
  };

  // [7] Diario di visione: note libere con timeline, per ogni rewatch/momento
  // [FIX RESET] Le note vivono in watchData[title].journal, non sull'oggetto show.
  const renderJournalBlock = () => {
    const container = modal.querySelector('#journalContainer');
    if (!container) return;
    const today = new Date().toISOString().slice(0, 10);
    const entries = (watchData[title]?.journal || []).slice().sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || ''));
    const entriesHtml = entries.length ? entries.map(e => `<div class="journal-entry" data-id="${e.id}"><div class="journal-entry-dot"></div><div class="journal-entry-body"><div class="journal-entry-head"><span class="journal-entry-date">${formatWatchDate(e.date)}</span><button class="journal-entry-del" title="Elimina nota"><i class="fas fa-trash"></i></button></div><div class="journal-entry-text">${escapeHtml(e.text)}</div></div></div>`).join('') : `<p class="journal-empty">Nessuna nota ancora. Scrivi la prima!</p>`;
    container.innerHTML = `<h4><i class="fas fa-feather-pointed"></i> Diario di visione</h4><form class="journal-add-form"><input type="date" class="journal-date-input" name="journal-date" value="${today}" max="${today}"><textarea class="journal-text-input" name="journal-text" placeholder="Una nota, un pensiero, la scena preferita..." rows="2"></textarea><button type="submit" class="btn btn-secondary btn-sm"><i class="fas fa-plus"></i> Aggiungi nota</button></form><div class="journal-timeline">${entriesHtml}</div>`;

    container.querySelector('.journal-add-form').onsubmit = async (e) => {
      e.preventDefault();
      const dateInput = container.querySelector('.journal-date-input');
      const textInput = container.querySelector('.journal-text-input');
      const submitBtn = container.querySelector('.journal-add-form button[type="submit"]');
      const text = textInput.value.trim();
      if (!text) return;
      watchData[title] = watchData[title] || {};
      watchData[title].journal = watchData[title].journal || [];
      watchData[title].journal.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, date: dateInput.value || today, text, createdAt: new Date().toISOString() });
      if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i>'; }
      const ok = await saveWatchData();
      if (!ok) showError('Nota salvata in locale, ma la sincronizzazione cloud non è riuscita (verrà ritentata).');
      renderJournalBlock();
    };
    container.querySelectorAll('.journal-entry-del').forEach(btn => {
      btn.onclick = async () => {
        const id = btn.closest('.journal-entry').dataset.id;
        if (!watchData[title]) return;
        watchData[title].journal = (watchData[title].journal || []).filter(e => e.id !== id);
        await saveWatchData();
        renderJournalBlock();
      };
    });
  };

  // [4] Avanzamento episodi — visibile SOLO se la serie e' attualmente nella
  // categoria "Sto guardando". Il dato vive in watchData (non nell'oggetto show)
  // per restare coerente con tempo di visione e diario.
  const watchRef = findShowRef(title);
  const isCurrentlyWatching = !!(watchRef && isWatchingCat(watchRef.cat.name));

  // Un tocco su una casella non deve far ripartire un render completo dell'app
  // (tutte le categorie, tutte le card, la nav laterale): spuntando una stagione
  // intera sarebbero decine di ricostruzioni del DOM di fila.
  let outerRenderTimer = null;
  const scheduleOuterRender = () => {
    clearTimeout(outerRenderTimer);
    outerRenderTimer = setTimeout(() => render(), 400);
  };

  const renderEpisodeChecklist = () => {
    const container = modal.querySelector('#episodeChecklistContainer');
    if (!container) return;
    // Le stagioni in cache sono gia' filtrate a season_number > 0 da
    // fetchShowDetails: gli speciali non entrano nel conteggio.
    const seasons = details.seasons || [];
    if (!seasons.length) {
      container.innerHTML = '<h4><i class="fas fa-list-check"></i> Avanzamento episodi</h4><p style="color:var(--text-muted);font-size:12px;margin-top:8px;">TMDB non fornisce l\'elenco delle stagioni per questa serie.</p>';
      return;
    }
    const watched = new Set(watchedKeysOf(title));
    const openSeasons = new Set(
      [...container.querySelectorAll('.ep-season.open')].map(el => el.dataset.season)
    );

    let totalWatched = 0, totalEpisodes = 0;
    const seasonsHtml = seasons.map(season => {
      const sNum = season.season_number;
      const epCount = season.episode_count || 0;
      totalEpisodes += epCount;
      let seasonWatched = 0;
      let epsHtml = '';
      for (let ep = 1; ep <= epCount; ep++) {
        const key = epKey(sNum, ep);
        const isWatched = watched.has(key);
        if (isWatched) seasonWatched++;
        epsHtml += `<label class="ep-check ${isWatched ? 'watched' : ''}" title="S${sNum}E${ep}">
          <input type="checkbox" name="ep-${sNum}-${ep}" data-season="${sNum}" data-episode="${ep}" ${isWatched ? 'checked' : ''}>
          <span>${ep}</span>
        </label>`;
      }
      totalWatched += seasonWatched;
      const pct = epCount ? Math.round((seasonWatched / epCount) * 100) : 0;
      const isOpen = openSeasons.has(String(sNum));
      const allDone = epCount > 0 && seasonWatched === epCount;
      return `<div class="ep-season${isOpen ? ' open' : ''}" data-season="${sNum}">
        <div class="ep-season-header" role="button" tabindex="0" aria-expanded="${isOpen}">
          <span class="ep-season-name">${escapeHtml(season.name || `Stagione ${sNum}`)}</span>
          <span class="ep-season-progress">${seasonWatched}/${epCount} · ${pct}%</span>
          <button type="button" class="ep-season-all" data-season="${sNum}" data-count="${epCount}" data-mark="${allDone ? 'off' : 'on'}" title="${allDone ? 'Togli la spunta a tutta la stagione' : 'Segna tutta la stagione come vista'}">
            <i class="fas ${allDone ? 'fa-rotate-left' : 'fa-check-double'}" aria-hidden="true"></i>
          </button>
          <i class="fas fa-chevron-down ep-season-chevron" aria-hidden="true"></i>
        </div>
        <div class="ep-season-body">${epsHtml || '<span class="ep-season-empty">Nessun episodio noto.</span>'}</div>
      </div>`;
    }).join('');

    const totalPct = totalEpisodes ? Math.round((totalWatched / totalEpisodes) * 100) : 0;
    container.innerHTML = `<h4><i class="fas fa-list-check"></i> Avanzamento episodi</h4>
      <div class="ep-total-bar"><div class="ep-total-fill" style="width:${totalPct}%"></div></div>
      <div class="ep-total-label">${totalWatched} di ${totalEpisodes} episodi · ${totalPct}%</div>
      <div class="ep-checklist">${seasonsHtml}</div>`;

    // Apri/chiudi stagione. Niente onclick inline nel markup: sarebbe l'unico
    // gestore in linea rimasto in tutto il file e non passerebbe una CSP.
    container.querySelectorAll('.ep-season-header').forEach(header => {
      const toggle = () => {
        const box = header.parentElement;
        const open = box.classList.toggle('open');
        header.setAttribute('aria-expanded', String(open));
      };
      header.onclick = (e) => { if (!e.target.closest('.ep-season-all')) toggle(); };
      header.onkeydown = (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        if (e.target.closest('.ep-season-all')) return;
        e.preventDefault();
        toggle();
      };
    });

    container.querySelectorAll('.ep-season-all').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const sNum = parseInt(btn.dataset.season, 10);
        const count = parseInt(btn.dataset.count, 10) || 0;
        markSeason(title, sNum, count, btn.dataset.mark === 'on');
        const ok = await saveWatchData();
        if (!ok) showError('Avanzamento salvato in locale, ma la sincronizzazione cloud non e\' riuscita (verra\' ritentata).');
        renderEpisodeChecklist();
        scheduleOuterRender();
      };
    });

    container.querySelectorAll('.ep-check input[type="checkbox"]').forEach(cb => {
      cb.onchange = async () => {
        markEpisode(title, parseInt(cb.dataset.season, 10), parseInt(cb.dataset.episode, 10), cb.checked);
        const ok = await saveWatchData();
        if (!ok) showError('Avanzamento salvato in locale, ma la sincronizzazione cloud non e\' riuscita (verra\' ritentata).');
        renderEpisodeChecklist();
        scheduleOuterRender();
      };
    });
  };

  // [5] Dove guardarla: disponibilità streaming/noleggio/acquisto (dati JustWatch via TMDB)
  const loadProviders = async () => {
    const body = modal.querySelector('#providersBody');
    if (!body) return;
    const prov = await fetchWatchProviders(details.id);
    if (!document.body.contains(modal)) return;
    body.innerHTML = renderProvidersHtml(prov);
  };

  // [17/18] Confronto voto: il mio (se presente) vs quello della community TMDB,
  // sempre etichettati chiaramente per non confonderli. Mostrato solo qui nel
  // dettaglio, non sulla copertina/card in griglia.
  const myRatingEntry = ratingsData[title];
  const tmdbScoreNum = parseFloat(details.vote_average);
  const tmdbScore = isNaN(tmdbScoreNum) ? null : tmdbScoreNum;
  const myScore = myRatingEntry ? myRatingEntry.average : null;
  let ratingDeltaHtml = '';
  if (tmdbScore !== null && myScore !== null) {
    const delta = myScore - tmdbScore;
    const deltaAbs = Math.abs(delta).toFixed(1);
    if (Math.abs(delta) < 0.3) ratingDeltaHtml = `<div class="rating-compare-delta neutral">In linea con TMDB</div>`;
    else if (delta > 0) ratingDeltaHtml = `<div class="rating-compare-delta higher">+${deltaAbs} rispetto a TMDB — più generoso</div>`;
    else ratingDeltaHtml = `<div class="rating-compare-delta lower">-${deltaAbs} rispetto a TMDB — più severo</div>`;
  }
  const ratingCompareHtml = `<div class="detail-item rating-compare-item">
    <h4>Voto</h4>
    <div class="rating-compare-row">
      <div class="rating-compare-col"><div class="rating-compare-label"><i class="fas fa-globe"></i> TMDB</div><div class="rating-compare-value tmdb">${details.vote_average}<span>/10</span></div></div>
      <div class="rating-compare-divider"></div>
      <div class="rating-compare-col"><div class="rating-compare-label"><i class="fas fa-user"></i> Il mio voto</div><div class="rating-compare-value mine">${myScore !== null ? myScore.toFixed(1) : '—'}<span>${myScore !== null ? '/10' : ''}</span></div></div>
    </div>
    ${ratingDeltaHtml}
  </div>`;

  // [CAST] Sei nomi, con la foto quando c'è: abbastanza per riconoscere la serie,
  // non tanti da trasformare la scheda in un elenco.
  const castHtml = details.cast?.length ? `<div class="detail-row"><div class="detail-item"><h4><i class="fas fa-users"></i> Cast principale</h4><div class="cast-row">${details.cast.map(c => `<div class="cast-member">
      ${c.profile_path
        ? `<img class="cast-photo" src="https://image.tmdb.org/t/p/w185${escapeHtml(c.profile_path)}" alt="" loading="lazy">`
        : `<div class="cast-photo cast-photo-empty"><i class="fas fa-user"></i></div>`}
      <div class="cast-name">${escapeHtml(c.name)}</div>
      ${c.character ? `<div class="cast-character">${escapeHtml(c.character)}</div>` : ''}
    </div>`).join('')}</div></div></div>` : '';

  // [TRAILER] Nessun iframe incorporato: caricherebbe il player YouTube (e i suoi
  // cookie) all'apertura di ogni scheda. Si apre in una scheda nuova al click.
  const trailerHtml = details.trailer ? `<a class="trailer-link" href="https://www.youtube.com/watch?v=${encodeURIComponent(details.trailer.key)}" target="_blank" rel="noopener">
      <span class="trailer-play"><i class="fas fa-play"></i></span>
      <span class="trailer-text"><strong>Guarda il trailer</strong><span>${escapeHtml(details.trailer.name)}${details.trailer.lang === 'it' ? ' · in italiano' : ''}</span></span>
      <i class="fas fa-external-link-alt trailer-ext"></i>
    </a>` : '';

  const posterUrl = details.poster_path ? TMDB_IMG_LARGE + details.poster_path : PLACEHOLDER_IMG;
  modal.querySelector('.modal-body').innerHTML = `<div class="modal-poster-col"><img class="modal-poster" src="${escapeHtml(posterUrl)}" alt="${escapeHtml(title)}">${trailerHtml}</div><div class="modal-details"><div class="detail-row">${ratingCompareHtml}<div class="detail-item clickable" id="seasonsDetailItem"><h4>Stagioni</h4><p>${details.number_of_seasons}</p><div class="detail-hint"><i class="fas fa-list-ol"></i> Vedi episodi</div></div><div class="detail-item"><h4>Episodi</h4><p>${details.number_of_episodes}</p></div></div><div class="detail-row"><div class="detail-item"><h4>Genere</h4><p>${escapeHtml(details.genres)}</p></div><div class="detail-item"><h4>Stato</h4><p>${escapeHtml(details.status)}</p></div></div><div class="detail-row"><div class="detail-item"><h4>Trama</h4><p class="overview">${escapeHtml(details.overview)}</p></div></div>${castHtml}<div class="detail-row"><div class="detail-item" id="watchTimeContainer"></div></div>${isCurrentlyWatching ? `<div class="detail-row"><div class="detail-item" id="episodeChecklistContainer"></div></div>` : ''}<div class="detail-row"><div class="detail-item" id="providersContainer"><h4><i class="fas fa-tv"></i> Dove guardarla</h4><div id="providersBody" class="wt-providers-body"><i class="fas fa-circle-notch fa-spin"></i> Ricerca piattaforme...</div></div></div><div class="detail-row"><div class="detail-item" id="journalContainer"></div></div></div>`;
  const footer = document.createElement('div');
  footer.className = 'modal-footer';
  footer.innerHTML = `<a href="https://www.themoviedb.org/tv/${details.id}" target="_blank" rel="noopener" class="external-link"><i class="fas fa-external-link-alt"></i> Vedi su TMDB</a><div style="display:flex;gap:10px;"><button class="btn btn-secondary" id="shareDetailsBtn"><i class="fas fa-share-nodes btn-icon"></i> Condividi</button><button class="btn btn-primary" id="closeDetailsBtn">Chiudi</button></div>`;
  modal.querySelector('.modal-content').appendChild(footer);
  footer.querySelector('#closeDetailsBtn').onclick = closeModal;
  footer.querySelector('#shareDetailsBtn').onclick = () => shareShowCard(title);
  const seasonsItem = modal.querySelector('#seasonsDetailItem');
  if (seasonsItem) seasonsItem.onclick = () => openSeasonsBreakdown(details, title);

  renderWatchTimeBlock();
  renderJournalBlock();
  if (isCurrentlyWatching) renderEpisodeChecklist();
  loadProviders();
};

const openSeasonsBreakdown = (details, showTitle) => {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  const seasons = details.seasons || [];
  const seasonsHtml = seasons.length ? seasons.map(s => `<div class="season-item"><div class="season-item-name">${escapeHtml(s.name || `Stagione ${s.season_number}`)}</div><div class="season-item-episodes">${s.episode_count ?? '—'}<span>episodi</span></div></div>`).join('') : `<div style="text-align:center;color:var(--text-muted);padding:20px;">Nessuna informazione sulle stagioni disponibile</div>`;
  modal.innerHTML = `<div class="modal-content seasons-modal"><div class="modal-header"><h2><i class="fas fa-layer-group"></i> ${escapeHtml(showTitle)}</h2><button class="modal-close" aria-label="Chiudi">&times;</button></div><div class="seasons-list">${seasonsHtml}</div><div class="modal-footer" style="justify-content:flex-end;"><button class="btn btn-primary" id="closeSeasonsBtn">Chiudi</button></div></div>`;
  mountModal(modal);
  const closeModal = () => modal.remove();
  modal.querySelector('.modal-close').onclick = closeModal;
  modal.querySelector('#closeSeasonsBtn').onclick = closeModal;
  modal.onclick = (e) => { if (e.target === modal) closeModal(); };
};

const EXCLUDED_CATEGORIES = ['da vedere', 'sto guardando'];
const RATING_CATS = [
  { key: 'cast', label: 'Cast', icon: 'fa-users' },
  { key: 'trama', label: 'Trama', icon: 'fa-book-open' },
  { key: 'ambientazione', label: 'Ambientazione', icon: 'fa-map-location-dot' },
  { key: 'colonna_sonora', label: 'Colonna Sonora', icon: 'fa-music' },
  { key: 'coinvolgimento', label: 'Coinvolgimento', icon: 'fa-fire' },
];

const getVotableShows = () => {
  const shows = [];
  for (const cat of data) {
    const cl = cat.name.toLowerCase();
    if (EXCLUDED_CATEGORIES.some(e => cl.includes(e))) continue;
    for (const show of cat.shows) shows.push({ ...show, category: cat.name });
  }
  return shows;
};

const openRatingModal = async (title, posterOverride = null) => {
  const existing = ratingsData[title] || {};
  const posterUrl = posterOverride || (await fetchPoster(title)) || PLACEHOLDER_IMG;
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  const slidersHtml = RATING_CATS.map(cat => {
    const val = existing[cat.key] !== undefined ? existing[cat.key] : 7;
    return `<div class="rating-category"><div class="rating-cat-header"><div class="rating-cat-label"><i class="fas ${cat.icon}"></i>${cat.label}</div><div class="rating-cat-value" id="val-${cat.key}">${val}</div></div><input type="range" class="rating-slider" id="slider-${cat.key}" min="0" max="10" step="1" value="${val}" aria-label="${cat.label}"><div class="rating-track-labels"><span>0</span><span>5</span><span>10</span></div></div>`;
  }).join('');
  const initAvg = existing.average !== undefined ? existing.average.toFixed(1) : (RATING_CATS.reduce((s,c) => s + (existing[c.key] !== undefined ? existing[c.key] : 7), 0) / RATING_CATS.length).toFixed(1);
  modal.innerHTML = `<div class="modal-content rating-modal"><div class="modal-header"><h2><i class="fas fa-star"></i> Valuta Serie</h2><button class="modal-close" aria-label="Chiudi">&times;</button></div><div style="padding:24px 28px;"><div class="rating-show-header"><img class="rating-show-poster" src="${escapeHtml(posterUrl)}" alt="${escapeHtml(title)}"><div class="rating-show-meta"><h3>${escapeHtml(title)}</h3><p>Assegna un voto da 0 a 10 per ogni categoria</p>${existing.savedAt ? `<p style="margin-top:6px;color:rgba(212,175,55,0.6);font-size:11px;"><i class="fas fa-check-circle"></i> Già valutata il ${new Date(existing.savedAt).toLocaleDateString('it-IT')}</p>` : ''}</div></div><div class="rating-categories">${slidersHtml}</div><div class="rating-average-box"><div class="rating-average-label">Media voti</div><div class="rating-average-value" id="ratingAvgPreview">${initAvg}</div><div class="rating-average-stars" id="ratingAvgStars">${toStars(parseFloat(initAvg))}</div></div></div><div class="modal-footer"><button class="btn btn-secondary" id="cancelRating">Annulla</button><button class="btn btn-primary" id="saveRating"><i class="fas fa-save"></i> Salva Valutazione</button></div></div>`;
  mountModal(modal);
  const closeModal = () => modal.remove();
  modal.querySelector('.modal-close').onclick = closeModal;
  modal.querySelector('#cancelRating').onclick = closeModal;
  modal.onclick = (e) => { if (e.target === modal) closeModal(); };

  // [CSP] Prima gli slider usavano un attributo oninput inline che chiamava una
  // funzione globale su window: bastava a rendere impossibile una CSP severa, e
  // gli id (#slider-cast...) erano cercati su tutto il documento, quindi due
  // modali voto aperte insieme si sarebbero pestate i piedi. Ora i listener sono
  // agganciati qui e le ricerche sono limitate a questa modale.
  const updateAvgPreview = () => {
    const avg = RATING_CATS.reduce((sum, c) => sum + parseInt(modal.querySelector(`#slider-${c.key}`).value, 10), 0) / RATING_CATS.length;
    modal.querySelector('#ratingAvgPreview').textContent = avg.toFixed(1);
    modal.querySelector('#ratingAvgStars').textContent = toStars(avg);
  };
  for (const cat of RATING_CATS) {
    const slider = modal.querySelector(`#slider-${cat.key}`);
    slider.addEventListener('input', () => {
      modal.querySelector(`#val-${cat.key}`).textContent = slider.value;
      updateAvgPreview();
    });
  }

  modal.querySelector('#saveRating').onclick = async () => {
    const scores = {};
    for (const cat of RATING_CATS) scores[cat.key] = parseInt(modal.querySelector(`#slider-${cat.key}`).value);
    scores.average = calcAverage(scores);
    scores.savedAt = new Date().toISOString();
    ratingsData[title] = scores;
    await saveRatings();
    closeModal();
    await render();
  };
};

const openRatingDetails = (title) => {
  const entry = ratingsData[title];
  if (!entry) return;
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  const itemsHtml = RATING_CATS.map(cat => `<div class="rating-detail-item"><div class="rating-detail-item-label"><i class="fas ${cat.icon}"></i>${cat.label}</div><div class="rating-detail-item-value">${entry[cat.key]}<span style="font-size:14px;color:var(--text-muted)">/10</span></div><div class="rating-detail-bar"><div class="rating-detail-bar-fill" style="width:${entry[cat.key]*10}%"></div></div></div>`).join('');
  modal.innerHTML = `<div class="modal-content rating-modal"><div class="modal-header"><h2>${escapeHtml(title)}</h2><button class="modal-close" aria-label="Chiudi">&times;</button></div><div style="padding:24px 28px;"><p style="color:var(--text-muted);font-size:13px;margin:0 0 8px 0;">${entry.savedAt ? `Valutata il ${new Date(entry.savedAt).toLocaleDateString('it-IT', {day:'2-digit',month:'long',year:'numeric'})}` : ''}</p><div class="rating-detail-grid">${itemsHtml}</div><div class="rating-big-avg"><div class="rating-average-stars" style="font-size:20px;letter-spacing:3px;">${toStars(entry.average)}</div><div class="rating-big-avg-val">${entry.average.toFixed(1)}</div><div class="rating-big-avg-label">Media generale</div></div></div><div class="modal-footer" style="justify-content:flex-end;gap:10px;"><button class="btn btn-secondary" id="reRateBtn"><i class="fas fa-edit"></i> Modifica</button><button class="btn btn-primary" id="closeRatingDetail">Chiudi</button></div></div>`;
  mountModal(modal);
  const closeModal = () => modal.remove();
  modal.querySelector('.modal-close').onclick = closeModal;
  modal.querySelector('#closeRatingDetail').onclick = closeModal;
  modal.onclick = (e) => { if (e.target === modal) closeModal(); };
  modal.querySelector('#reRateBtn').onclick = () => { closeModal(); openRatingModal(title); };
};

const openRandomRating = async () => {
  const shows = getVotableShows();
  if (!shows.length) {
    showError('Nessuna serie disponibile per la valutazione.');
    return;
  }
  // Escludi le serie già valutate
  const unratedShows = shows.filter(show => !ratingsData[show.title]);
  if (!unratedShows.length) {
    showToast('Tutte le serie sono state valutate!', 'success');
    return;
  }
  const picked = unratedShows[Math.floor(Math.random() * unratedShows.length)];
  await openRatingModal(picked.title, picked.poster || null);
};

// ==================== STATISTICS ====================
// FIX #4: prima di leggere showDetailsCache in modo sincrono, garantiamo che sia popolata.
const showStatistics = async () => {
  await prefetchDetails();

  let excludeFuture = false, excludeWatching = false;
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  const modalContent = document.createElement('div');
  modalContent.className = 'modal-content';
  modalContent.style.maxWidth = '1050px';
  const refreshStats = () => {
    let totalShows = 0, totalViews = 0;
    const categories = [], mostWatched = [];
    const addedPerMonth = {};
    const genreCount = {};
    let totalWatchTimeMin = 0;
    for (const cat of data) {
      const isFuture   = cat.name.toLowerCase().includes('da vedere in futuro');
      const isWatching = cat.name.toLowerCase().includes('sto guardando');
      if (excludeFuture && isFuture) continue;
      if (excludeWatching && isWatching) continue;
      let catShows = 0, catViews = 0;
      for (const show of cat.shows) {
        catShows++; totalShows++;
        let views = 1;
        if (show.progress && show.progress !== '0') {
          const val = parseFloat(String(show.progress).replace(',', '.'));
          if (!isNaN(val)) views = val;
        }
        catViews += views; totalViews += views;
        mostWatched.push({ title: show.title, views, category: cat.name });
        if (show.addedAt) {
          const d = new Date(show.addedAt);
          const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
          addedPerMonth[key] = (addedPerMonth[key] || 0) + 1;
        }
        if (views > 0) {
          const details = showDetailsCache.get(show.title);
          if (details) {
            const epDuration = details.episode_run_time?.[0] || 42;
            totalWatchTimeMin += (details.number_of_episodes || 0) * epDuration * views;
            (details.genre_names || []).forEach(g => {
              genreCount[g] = (genreCount[g] || 0) + views;
            });
          }
        }
      }
      categories.push({ name: cat.name, showCount: catShows, totalViews: catViews });
    }
    mostWatched.sort((a,b) => b.views - a.views);
    const ratedEntries = Object.entries(ratingsData);
    const ratedCount = ratedEntries.length;
    let ratingSum = 0, bestShow = null, bestAvg = 0;
    const catSums = { cast: 0, trama: 0, ambientazione: 0, colonna_sonora: 0, coinvolgimento: 0 };
    const topRated = [];
    for (const [title, entry] of ratedEntries) {
      ratingSum += entry.average;
      if (entry.average > bestAvg) { bestAvg = entry.average; bestShow = title; }
      for (const k of Object.keys(catSums)) catSums[k] += entry[k] || 0;
      let catName = '';
      for (const cat of data) { if (cat.shows.find(s => s.title === title)) { catName = cat.name; break; } }
      topRated.push({ title, avg: entry.average, cat: catName });
    }
    topRated.sort((a,b) => b.avg - a.avg);
    const globalAvgRating = ratedCount ? (ratingSum / ratedCount).toFixed(1) : '—';
    const catAvgBarsHtml = RATING_CATS.map(c => {
      const avg = ratedCount ? (catSums[c.key] / ratedCount).toFixed(1) : 0;
      return `<div class="cat-avg-bar-row"><div class="cat-avg-bar-label"><i class="fas ${c.icon}"></i>${c.label}</div><div class="cat-avg-bar-track"><div class="cat-avg-bar-fill" style="width:${(avg/10)*100}%"></div></div><div class="cat-avg-bar-val">${avg}</div></div>`;
    }).join('');
    const topRatedHtml = topRated.slice(0,5).map((s,i) => `<div class="top-rated-item"><div class="top-rated-rank">${i+1}</div><div class="top-rated-info"><div class="top-rated-title">${escapeHtml(s.title)}</div><div class="top-rated-cat">${escapeHtml(s.cat)}</div></div><div class="top-rated-score"><div class="top-rated-avg">${s.avg.toFixed(1)}</div><div class="top-rated-stars">${toStars(s.avg)}</div></div></div>`).join('');
    const ratingsSection = ratedCount ? `<div class="stats-ratings-section"><div class="stats-section"><h3><i class="fas fa-star" style="color:var(--gold)"></i> Valutazioni</h3><div class="ratings-stats-grid"><div class="rating-stat-card"><div class="rating-stat-card-label">Serie valutate</div><div class="rating-stat-card-value">${ratedCount}</div><div class="rating-stat-card-sub">su ${totalShows} totali</div></div><div class="rating-stat-card"><div class="rating-stat-card-label">Media globale</div><div class="rating-stat-card-value">${globalAvgRating}</div><div class="rating-stat-card-sub">${toStars(parseFloat(globalAvgRating))}</div></div>${bestShow ? `<div class="rating-stat-card"><div class="rating-stat-card-label">Migliore</div><div class="rating-stat-card-value" style="font-size:20px;padding-top:4px;">${escapeHtml(bestShow)}</div><div class="rating-stat-card-sub">${bestAvg.toFixed(1)} / 10</div></div>` : ''}</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:16px;"><div><div style="font-size:13px;font-weight:700;color:var(--text);margin-bottom:12px;">Media per categoria</div><div class="category-avg-bars">${catAvgBarsHtml}</div></div><div><div style="font-size:13px;font-weight:700;color:var(--text);margin-bottom:12px;">Top 5 serie votate</div><div class="top-rated-list">${topRatedHtml}</div></div></div></div></div>` : `<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:14px;"><i class="fas fa-star" style="font-size:24px;opacity:0.3;display:block;margin-bottom:8px;"></i>Nessuna serie valutata ancora.</div>`;
    const totalHours = (totalWatchTimeMin / 60).toFixed(1);
    const totalDays = (totalWatchTimeMin / 1440).toFixed(1);
    const genreEntries = Object.entries(genreCount).sort((a,b) => b[1] - a[1]);
    const genreBarsHtml = genreEntries.slice(0,5).map(([name, count]) => `<div class="bar-chart-row"><div class="bar-chart-label">${escapeHtml(name)}</div><div class="bar-chart-track"><div class="bar-chart-fill" style="width:${Math.min(100, (count / (genreEntries[0]?.[1] || 1))*100)}%"></div></div><div class="bar-chart-value">${count}</div></div>`).join('');
    const now = new Date();
    const months = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      const monthName = d.toLocaleString('it-IT', { month:'short', year:'numeric' });
      months.push({ key, label: monthName, count: addedPerMonth[key] || 0 });
    }
    const maxAdded = Math.max(1, ...months.map(m => m.count));
    const addedBarsHtml = months.map(m => `<div class="bar-chart-row"><div class="bar-chart-label">${m.label}</div><div class="bar-chart-track"><div class="bar-chart-fill" style="width:${(m.count / maxAdded)*100}%"></div></div><div class="bar-chart-value">${m.count}</div></div>`).join('');
    const extraSection = `<div class="stats-extra-section"><div class="stats-section"><h3><i class="fas fa-clock"></i> Tempo totale di visione stimato</h3><p><span class="stats-time-total">${totalHours} ore</span> (circa ${totalDays} giorni)</p><p style="color:var(--text-muted);font-size:13px;">Basato su episodi × durata media (TMDB)</p></div><div class="stats-section" style="margin-top:16px;"><h3><i class="fas fa-tags"></i> Generi più visti</h3><div class="bar-chart">${genreBarsHtml || '<p style="color:var(--text-muted);">Nessun dato</p>'}</div></div><div class="stats-section" style="margin-top:16px;"><h3><i class="fas fa-calendar-alt"></i> Serie aggiunte per mese (ultimi 12 mesi)</h3><div class="bar-chart">${addedBarsHtml || '<p style="color:var(--text-muted);">Nessuna data di aggiunta disponibile</p>'}</div></div></div>`;
    const togglesHtml = `<div style="display:flex;flex-direction:column;gap:12px;margin-bottom:24px;"><div class="toggle-container" style="margin-bottom:0;"><div class="toggle-left"><div class="toggle-icon"><i class="fas fa-clock"></i></div><div class="toggle-text"><div class="toggle-title">Serie "Da vedere in futuro"</div><div class="toggle-description">Includi nelle statistiche le serie in lista d'attesa</div></div></div><div class="toggle-right"><label class="toggle-switch"><input type="checkbox" id="futureToggle" ${excludeFuture ? '' : 'checked'}><span class="toggle-slider"></span></label><div class="toggle-status">${excludeFuture ? 'ESCLUSE' : 'INCLUSE'}</div></div></div><div class="toggle-container" style="margin-bottom:0;"><div class="toggle-left"><div class="toggle-icon"><i class="fas fa-play"></i></div><div class="toggle-text"><div class="toggle-title">Serie "Sto guardando"</div><div class="toggle-description">Includi nelle statistiche le serie che stai guardando</div></div></div><div class="toggle-right"><label class="toggle-switch"><input type="checkbox" id="watchingToggle" ${excludeWatching ? '' : 'checked'}><span class="toggle-slider"></span></label><div class="toggle-status">${excludeWatching ? 'ESCLUSE' : 'INCLUSE'}</div></div></div></div>`;
    modalContent.innerHTML = `<div class="modal-header"><h2><i class="fas fa-chart-bar"></i> Statistiche Serie TV</h2><button class="modal-close" aria-label="Chiudi">&times;</button></div><div class="modal-body" style="display:block;padding:28px;">${togglesHtml}<div class="stats-grid"><div class="stat-card"><h3>Serie Totali</h3><p class="stat-value">${totalShows}</p></div><div class="stat-card"><h3>Visioni Totali</h3><p class="stat-value">${totalViews.toFixed(1)}</p></div><div class="stat-card"><h3>Media Visioni</h3><p class="stat-value">${totalShows ? (totalViews/totalShows).toFixed(1) : 0}</p></div><div class="stat-card"><h3>Categorie</h3><p class="stat-value">${categories.length}</p></div></div><div class="stats-columns"><div class="stats-section"><h3><i class="fas fa-folder"></i> Per Categoria</h3><div class="categories-list">${categories.map(c => `<div class="category-item"><div class="category-name">${escapeHtml(c.name)}</div><div class="category-stats"><div class="category-stat"><div class="stat-label">Serie</div><div class="stat-number">${c.showCount}</div></div><div class="category-stat"><div class="stat-label">Visioni</div><div class="stat-number">${c.totalViews}</div></div></div></div>`).join('')}</div></div><div class="stats-section"><h3><i class="fas fa-trophy"></i> Più Viste</h3><div class="top-shows-list">${mostWatched.slice(0,8).map((s,i) => `<div class="top-show-item"><div class="show-rank">${i+1}</div><div><div class="show-title" style="color:var(--text)">${escapeHtml(s.title)}</div><div class="show-category">${escapeHtml(s.category)}</div></div><div><div class="show-views">${s.views}</div><div class="show-views-label">visioni</div></div></div>`).join('')}</div></div></div>${ratingsSection}${extraSection}</div><div class="modal-footer"><button class="btn btn-primary" id="closeStats">Chiudi</button></div>`;
    modalContent.querySelector('#futureToggle').onchange   = (e) => { excludeFuture   = !e.target.checked; refreshStats(); };
    modalContent.querySelector('#watchingToggle').onchange = (e) => { excludeWatching = !e.target.checked; refreshStats(); };
    modalContent.querySelector('.modal-close').onclick = () => modal.remove();
    modalContent.querySelector('#closeStats').onclick  = () => modal.remove();
  };
  refreshStats();
  modal.appendChild(modalContent);
  mountModal(modal);
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
};

const printList = () => {
  let output = '', globalCounter = 1;
  // stessa regola di numerazione della griglia: contatore globale, saltando
  // le categorie "Sto guardando" / "Da vedere" (le epopee restano numerate, con corona)
  for (const cat of data) {
    const isNumberedCat = !UNNUMBERED_CATS.some(e => cat.name.toLowerCase().includes(e));
    output += `${cat.name}\n${'='.repeat(cat.name.length)}\n\n`;
    for (const show of cat.shows) {
      const legend = (show.seasons_count || 0) >= 8 ? '👑 ' : '';
      const prog = show.progress && parseFloat(show.progress) !== 0 ? ` — ${show.progress} volte` : (show.progress !== undefined && parseFloat(show.progress) === 0 ? ' — Da vedere' : '');
      const rating = ratingsData[show.title] ? ` ★${ratingsData[show.title].average.toFixed(1)}` : '';
      const num = isNumberedCat ? `${globalCounter++}. ` : '';
      output += `${num}${legend}${show.title}${prog}${rating}\n`;
    }
    output += '\n\n';
  }
  const win = window.open('', '_blank');
  if (!win) { showToast('Popup bloccato dal browser: consenti i popup per questo sito per vedere la lista.'); return; }
  win.document.write(`<pre style="font-family:monospace;white-space:pre-wrap;background:#000;color:#fff;padding:20px;">${escapeHtml(output)}</pre>`);
  win.document.close();
};

// ==================== [5] CONDIVISIONE LISTA (leggibile, per amici) ====================
const buildShareText = () => {
  let out = `📺 Le mie serie TV\n\n`;
  for (const cat of data) {
    if (!cat.shows.length) continue;
    out += `▸ ${cat.name}\n`;
    for (const show of cat.shows) {
      const rating = ratingsData[show.title] ? ` — ⭐ ${ratingsData[show.title].average.toFixed(1)}` : '';
      const legend = (show.seasons_count || 0) >= 8 ? ' 👑' : '';
      out += `  • ${show.title}${legend}${rating}\n`;
    }
    out += `\n`;
  }
  out += `Generato con TVTRACKER`;
  return out;
};

const shareList = async () => {
  const text = buildShareText();
  if (navigator.share) {
    try { await navigator.share({ title: 'Le mie serie TV', text }); return; }
    catch (e) { /* utente ha annullato, o non supportato: proseguiamo col fallback sotto */ }
  }
  try {
    await navigator.clipboard.writeText(text);
    showToast('Lista copiata negli appunti, pronta da incollare!', 'success');
  } catch (e) {
    const win = window.open('', '_blank');
    if (!win) { showToast('Impossibile condividere: appunti non disponibili e popup bloccato dal browser.'); return; }
    win.document.write(`<pre style="font-family:monospace;white-space:pre-wrap;background:#000;color:#fff;padding:20px;">${escapeHtml(text)}</pre>`);
    win.document.close();
  }
};

// ==================== [11] CONDIVISIONE CARD SINGOLA (immagine) ====================
// Disegnata interamente su canvas (nessuna immagine esterna caricata): evita ogni
// problema di CORS con le immagini TMDB e funziona sempre, anche offline.
const wrapCanvasText = (ctx, text, x, y, maxWidth, lineHeight, maxLines = 2) => {
  const words = text.split(' ');
  let line = '', curY = y, lines = 0;
  for (const word of words) {
    const test = line + word + ' ';
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line.trim(), x, curY);
      line = word + ' ';
      curY += lineHeight;
      lines++;
      if (lines >= maxLines - 1) break;
    } else line = test;
  }
  ctx.fillText(line.trim(), x, curY);
};

const generateShowShareImage = (title) => {
  const rating = ratingsData[title];
  const ref = findShowRef(title);
  const details = showDetailsCache.get(title);
  const W = 800, H = 420;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  const bgGrad = ctx.createLinearGradient(0, 0, W, H);
  bgGrad.addColorStop(0, '#161616'); bgGrad.addColorStop(1, '#0a0a0a');
  ctx.fillStyle = bgGrad; ctx.fillRect(0, 0, W, H);

  const accentGrad = ctx.createLinearGradient(0, 0, W, 0);
  accentGrad.addColorStop(0, '#e0323c'); accentGrad.addColorStop(1, '#b8121b');
  ctx.fillStyle = accentGrad; ctx.fillRect(0, 0, W, 6);

  ctx.fillStyle = '#ededed';
  ctx.font = '700 42px sans-serif';
  wrapCanvasText(ctx, title, 48, 110, W - 96, 50, 2);

  ctx.fillStyle = '#8a8a8a';
  ctx.font = '500 20px sans-serif';
  ctx.fillText(details?.genres || ref?.cat?.name || '', 48, 175);

  if (rating) {
    ctx.fillStyle = '#d4af37';
    ctx.font = '700 56px sans-serif';
    ctx.fillText(`★ ${rating.average.toFixed(1)}`, 48, 280);
    ctx.fillStyle = '#8a8a8a';
    ctx.font = '500 18px sans-serif';
    ctx.fillText('il mio voto su 10', 48, 312);
  } else {
    ctx.fillStyle = '#8a8a8a';
    ctx.font = '500 20px sans-serif';
    ctx.fillText('Non ancora valutata', 48, 260);
  }

  ctx.fillStyle = '#e0323c';
  ctx.font = '700 24px sans-serif';
  ctx.fillText('📺 TVTRACKER', 48, H - 36);

  return canvas;
};

const shareShowCard = async (title) => {
  try {
    const canvas = generateShowShareImage(title);
    canvas.toBlob(async (blob) => {
      if (!blob) { showError('Non sono riuscito a generare l\'immagine.'); return; }
      const safeName = title.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
      const file = new File([blob], `${safeName}.png`, { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title }); return; }
        catch (e) { /* annullato o fallito: proseguiamo col download */ }
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${safeName}.png`;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
    }, 'image/png');
  } catch (e) {
    console.error('Errore generazione immagine condivisione:', e);
    showError('Non sono riuscito a generare l\'immagine da condividere.');
  }
};

// [SCELTA] Il Reset riportava l'elenco al contenuto di data/default-data.json,
// che era una libreria vera e propria: chiunque premesse Reset si ritrovava in
// casa la lista di qualcun altro. Ora quel file contiene solo le categorie
// vuote, quindi Reset vuol dire davvero "riparti da zero". Per recuperare una
// lista esiste Importa backup.
const resetData = async () => {
  if (await confirmDialog({ title: 'Svuota la libreria', message: 'Tutte le serie e le categorie vengono rimosse: resta solo la struttura vuota.\n\nVoti, tempo di visione e diario NON vengono toccati, e tornano visibili se riaggiungi le stesse serie.\n\nSe non hai un backup recente, annulla ed esporta prima.', confirmLabel: 'Svuota', danger: true })) {
    localStorage.removeItem(scopedKey('data'));
    showDetailsCache.clear();
    collapsedCategories.clear();
    saveCollapsed();
    data = await loadDefaultData();
    if (data.length) saveData();
    await render();
  }
};

document.getElementById('printListBtn').onclick = printList;
document.getElementById('statsBtn').onclick      = showStatistics;
document.getElementById('resetBtn').onclick      = resetData;
document.getElementById('importFileInput').onchange = (e) => { if(e.target.files[0]) importFromFile(e.target.files[0]); e.target.value = ''; };

// ==================== MENU AZIONI DELLA BARRA ====================
// Un solo ⋮, subito a destra dello switch griglia/lista. Su schermi larghi
// raccoglie le cinque azioni meno frequenti; sotto i 768px la barra nasconde
// anche Stampa, Statistiche e Reset, che quindi finiscono qui in cima. Prima
// erano due menu distinti (barra desktop + FAB mobile) con handler duplicati.
const COMPACT_BAR = '(max-width: 768px)';
const buildActionsMenuItems = () => {
  const items = [];
  if (window.matchMedia(COMPACT_BAR).matches) {
    items.push(
      { icon: 'fa-print',      label: 'Stampa lista', onSelect: printList },
      { icon: 'fa-chart-bar',  label: 'Statistiche',  onSelect: showStatistics },
      { icon: 'fa-redo',       label: 'Reset',        onSelect: resetData },
      { type: 'separator' },
    );
  }
  items.push(
    { icon: 'fa-share-nodes',  label: 'Condividi lista', onSelect: shareList },
    { icon: 'fa-check-double', label: bulkMode ? 'Esci dalla selezione' : 'Seleziona più serie', onSelect: toggleBulkMode },
    { type: 'separator' },
    { icon: 'fa-download',     label: 'Esporta backup', onSelect: exportToFile },
    { icon: 'fa-upload',       label: 'Importa backup', onSelect: () => document.getElementById('importFileInput').click() },
  );
  const notif = notificationMenuState();
  if (notif) items.push({ type: 'separator' }, notif);
  return items;
};
const actionsMenuBtn = document.getElementById('actionsMenuBtn');
actionsMenuBtn.onclick = () => openFloatingMenu(actionsMenuBtn, buildActionsMenuItems());

document.getElementById('addCategoryForm').onsubmit = async (e) => {
  e.preventDefault();
  const name = document.getElementById('newCategoryName').value.trim();
  if (!name) return;
  if (data.some(c => c.name.toLowerCase() === name.toLowerCase())) {
    showToast(`La categoria "${name}" esiste già.`);
    return;
  }
  data.push({ id: generateId(), name, type: categoryType(name), shows: [] });
  saveData();
  document.getElementById('newCategoryName').value = '';
  await render();
};
document.getElementById('ratingFab').onclick = openRandomRating;

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js')
    .then(reg => console.log('Service Worker registrato', reg))
    .catch(err => console.log('SW registrazione fallita', err));
}

(async () => {
  // Deve venire prima di qualunque lettura: sposta le chiavi non namespaced
  // della versione precedente dentro lo scomparto 'guest'.
  migrateLegacyStorage();
  applyScope(GUEST_SCOPE);
  scopeInitialised = true;

  loadRatings();
  loadWatchData();
  hydrateDetailsCacheFromStorage(); // [PERF] recupera i dettagli TMDB già noti, niente rifetch inutili
  hydrateProvidersCacheFromStorage(); // [6] idem per i provider streaming
  updateOfflineBanner(); // [20] mostra subito se si parte offline
  initFirebase();
  await initData();

  // [FIX ORDINE] La normalizzazione dello schema deve venire DOPO initData e
  // loadRatings/loadWatchData. Nella versione precedente girava in cima al file,
  // quindi le sue assegnazioni a data/ratingsData/watchData venivano subito
  // sovrascritte da quelle funzioni: non aveva alcun effetto sulla memoria, solo
  // su localStorage.
  await normalizeStoredData();

  // [FIX] listenTo* non si chiamano piu' qui: li attiva onAuthStateChanged
  // quando (e solo se) c'e' un account. Chiamandoli anche qui si registravano
  // due snapshot listener sullo stesso documento.
  setupSearch();
  setupGlobalSearch();
  setupAuth();

  // [A11Y] Le due modali scritte a mano in index.html non passavano da
  // registerModal: niente role=dialog, niente Tab intrappolato, niente ritorno
  // del focus. Tutte le altre, create al volo, ci passavano gia'.
  ['authModal', 'compareModal'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) registerModal(el);
  });
  setupSideNav();
  setupViewToggle();
  setupNotifications();
  updateAccountUi();
  await render();
  await checkEpisodeNotifications(); // eventuali dati mancanti arrivano poco dopo in background e la richiamano di nuovo
})();
