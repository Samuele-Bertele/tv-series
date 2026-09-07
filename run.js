// Smoke test di TVTRACKER. Richiede jsdom: npm install
//   node tests/run.js
//
// Copre due famiglie di controlli:
//   1. Statici: si legge il sorgente e si verifica che certe cose ci siano (o
//      NON ci siano piu'). Servono a impedire il ritorno dei bug gia' corretti.
//   2. Comportamentali: si carica app.js in jsdom con un finto Firebase e si
//      guarda cosa fa davvero al cambio di identita'.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
const results = [];
const check = (name, cond, detail = '') => {
  if (cond) { pass++; results.push(`  ok   ${name}`); }
  else { fail++; results.push(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const group = (name) => results.push(`\n${name}`);

const appJs = read('app.js');
const css = read('styles.css');
const html = read('index.html');
const rules = read('firestore.rules');
const sw = read('sw.js');
const gitignore = read('.gitignore');

const SEED_PATH = path.join(ROOT, 'data/Samuele-data.json');
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return null; } };
const SEED_JSON = readJson(SEED_PATH);
const DEFAULT_JSON = readJson(path.join(ROOT, 'data/default-data.json'));

// ============================================================
group('1. Identita\' e ambito dei dati');
// ============================================================
check('LEGACY_SHARED_SYNC rimosso', !appJs.includes('LEGACY_SHARED_SYNC'));
check('legacyDocRefs rimosso', !appJs.includes('legacyDocRefs'));
// Deve sparire la collezione di PRIMO livello db.collection('tvtracker').
// users/{uid}.collection('tvtracker') e' un'altra cosa: e' il ramo personale.
check('nessun riferimento alla collezione condivisa di primo livello',
  !/(?<!doc\(uid\)\.)(?<!\.doc\(user\.uid\)\.)\bdb\.collection\(['"]tvtracker['"]\)/.test(appJs)
  && !/firestoreDb\.collection\(['"]tvtracker['"]\)/.test(appJs));
check('scopedKey definita', /const scopedKey = /.test(appJs));
check('applyScope definita', /const applyScope = /.test(appJs));
check('applyScope azzera il timestamp leggendolo dallo scomparto',
  /applyScope[\s\S]{0,1400}?localDataTimestamp = parseInt\(localStorage\.getItem\(scopedKey\('data-ts'\)\)/.test(appJs));
check('migrazione delle chiavi non namespaced presente', /const migrateLegacyStorage = /.test(appJs));
check('migrateLegacyStorage chiamata all\'avvio prima di ogni lettura',
  appJs.indexOf('migrateLegacyStorage();') < appJs.indexOf('loadRatings();\n  loadWatchData();'));
check('nessuna scrittura sulle vecchie chiavi globali',
  !/localStorage\.setItem\('tvtracker-(data|ratings|watchdata)/.test(appJs));
check('la lista pubblica non viene piu\' letta', !appJs.includes('loadPublicList'));
check('isPublicView rimosso', !appJs.includes('isPublicView'));

// ============================================================
group('2. Sincronizzazione');
// ============================================================
check('ratings ha un timestamp', /ratingsTimestamp/.test(appJs));
check('watchdata ha un timestamp', /watchTimestamp/.test(appJs));
check('listener ratings con guardia temporale',
  /listenToRatings[\s\S]{0,600}?remoteTs < ratingsTimestamp/.test(appJs));
check('listener watchdata con guardia temporale',
  /listenToWatchData[\s\S]{0,600}?remoteTs < watchTimestamp/.test(appJs));
check('ratings scrive il campo ts', /ratingsDocRef\.set\(\{ data: ratingsData, ts: ratingsTimestamp/.test(appJs));
check('watchdata scrive il campo ts', /watchDataDocRef\.set\(\{ data: watchData, ts: watchTimestamp/.test(appJs));
check('il timestamp non si alza applicando dati remoti',
  /if \(!applyingRemoteRatings\) ratingsTimestamp = Date\.now\(\)/.test(appJs));
check('createEmptyUserDocs inizializza tutti e tre i ts',
  /ratingsDocRef\.set\(\{ data: \{\}, ts, updatedAt/.test(appJs));

// ============================================================
group('3. Autenticazione');
// ============================================================
check('fallback a redirect per il popup bloccato', /signInWithRedirect/.test(appJs));
check('link con redirect per l\'account anonimo', /linkWithRedirect/.test(appJs));
check('getRedirectResult raccolto all\'avvio', /getRedirectResult/.test(appJs));
check('credential-already-in-use avvisa invece di procedere in silenzio',
  /credential-already-in-use[\s\S]{0,900}?confirmDialog/.test(appJs));
check('eliminazione account presente', /authDeleteBtn/.test(appJs) && /currentUser\.delete\(\)/.test(appJs));
check('requires-recent-login gestito', /requires-recent-login/.test(appJs));
check('account-exists-with-different-credential tradotto',
  /account-exists-with-different-credential/.test(appJs));
check('too-many-requests tradotto', /too-many-requests/.test(appJs));
check('badge esplicito per lo stato ospite', /Solo questo dispositivo/.test(appJs));

// ============================================================
group('4. Regole Firestore');
// ============================================================
check('nessun match sulla collezione condivisa', !/match \/tvtracker\/\{/.test(rules));
check('nessuna scrittura non autenticata',
  !/allow create, update: if docId in/.test(rules));
check('delete consentito solo al proprietario',
  /allow delete: if request\.auth != null && request\.auth\.uid == userId/.test(rules));
check('scrittura vincolata alle tre chiavi', /hasOnly\(\['data', 'ts', 'updatedAt'\]\)/.test(rules));
check('chiusura generale presente', /match \/\{document=\*\*\}[\s\S]{0,80}allow read, write: if false/.test(rules));

// ============================================================
group('5. Ricerca unificata');
// ============================================================
check('un solo campo di ricerca nell\'HTML',
  (html.match(/id="searchInput"/g) || []).length === 1 && !html.includes('globalSearchInput'));
check('vecchia barra TMDB rimossa dall\'HTML', !html.includes('global-search-wrap'));
check('nessun riferimento residuo in app.js', !/globalSearch(Input|Dropdown|Wrap)/.test(appJs));
check('il dropdown esiste nell\'HTML', html.includes('id="searchDropdown"'));
check('i suggerimenti partono da 3 caratteri', /q\.length < 3/.test(appJs));
check('le serie gia\' in libreria sono escluse dai suggerimenti',
  /filter\(r => !owned\(r\)\)/.test(appJs));
check('debounce sulle chiamate TMDB', /setTimeout\(\(\) => runTmdbSuggestions\(q\), 400\)/.test(appJs));
check('richiesta precedente annullata', /tmdbSuggestController\.abort\(\)/.test(appJs));
check('CSS del dropdown presente', css.includes('.search-dropdown-item'));

// ============================================================
group('6. Design system');
// ============================================================
check('scala tipografica definita', /--fs-2xs:/.test(css) && /--fs-3xl:/.test(css));
check('scala in rem, non px', /--fs-md:\s*0\.875rem/.test(css));
check('scala degli spazi definita', /--space-1:/.test(css) && /--space-8:/.test(css));
check('scala dei raggi definita', /--radius-xs:/.test(css));
check('--accent-rgb definito', /--accent-rgb:\s*224, 50, 60/.test(css));
check('--gold-rgb definito', /--gold-rgb:\s*212, 175, 55/.test(css));

const rootEnd = css.indexOf('}\n* { box-sizing');
const cssBody = css.slice(rootEnd);
const hardAccent = (cssBody.match(/rgba\(224\s*,\s*50\s*,\s*60/g) || []).length;
const hardGold = (cssBody.match(/rgba\(212\s*,\s*175\s*,\s*55/g) || []).length;
check('nessun accento rgba scritto a mano fuori da :root', hardAccent === 0, `trovati ${hardAccent}`);
check('nessun oro rgba scritto a mano fuori da :root', hardGold === 0, `trovati ${hardGold}`);

const halfPx = (css.match(/font-size:\s*\d+\.5px/g) || []).length;
check('nessun font-size a mezzo pixel', halfPx === 0, `trovati ${halfPx}`);

const pxSizes = (cssBody.match(/font-size:\s*\d+px/g) || []).length;
check('quasi nessun font-size in px residuo', pxSizes <= 5, `trovati ${pxSizes}`);

check('transizione non piu\' su "all"', !/--transition:\s*all /.test(css));
check('token di testo dorato definito', /--gold-text:/.test(css));

// ============================================================
group('7. Layout e accessibilita\'');
// ============================================================
check('nessuna barra sticky', !/is-stuck|is-compact/.test(css) && !/setupStickyBar/.test(appJs));
check('intestazioni di categoria non sticky',
  !/\.category-header\s*\{[\s\S]{0,200}position: sticky/.test(css));
check('nessun backdrop-filter aggiunto alla barra',
  !/\.top-bar[^{]*\{[^}]*backdrop-filter/.test(css));
check('legenda voti rimossa',
  !/rating-legend/.test(css) && !/ratingLegend/.test(html) && !/setupRatingLegend/.test(appJs));
check('nessun pannello figlio della barra (ha overflow:hidden)',
  !/legend-pop-wrap/.test(css));
check('le due modali statiche passano da registerModal',
  /\['authModal', 'compareModal'\][\s\S]{0,200}registerModal/.test(appJs));
check('nessuno stile inline residuo nella modale account',
  !/id="authGuest"[\s\S]{0,200}style=/.test(html));
check('input a 16px per non far zoomare iOS',
  /\.search-input\s*\{[\s\S]{0,400}font-size: var\(--fs-lg\)/.test(css));
check('prefers-reduced-motion ancora rispettato', /@media \(prefers-reduced-motion: reduce\)/.test(css));
check('combobox annunciato', /role="combobox"/.test(html));

// ============================================================
group('7b. Tema unico (scuro)');
// ============================================================
check('nessuna regola [data-theme="light"] nel CSS', !/\[data-theme/.test(css));
check('nessun attributo data-theme scritto da app.js', !/data-theme/.test(appJs));
check('applyTheme/initTheme/setupThemeToggle rimossi',
  !/applyTheme|initTheme|setupThemeToggle/.test(appJs));
check('THEME_KEY rimosso', !/THEME_KEY/.test(appJs));
check('pulsante di cambio tema rimosso dall\'HTML',
  !/themeToggleBtn/.test(html) && !/theme-icon/.test(html));
check('script inline pre-paint rimosso', !/prefers-color-scheme/.test(html));
check('color-scheme dichiarato solo dark', /content="dark"/.test(html));
check('theme-color unico', (html.match(/name="theme-color"/g) || []).length === 1);
check('i token di superficie restano', /--panel:/.test(css) && /--pop:/.test(css) && /--surface:/.test(css));

// ============================================================
group('8. Struttura del progetto');
// ============================================================
check('la Cloud Function sta in functions/', fs.existsSync(path.join(ROOT, 'functions/index.js')));
check('non c\'e\' piu\' un index.js alla radice', !fs.existsSync(path.join(ROOT, 'index.js')));
// [CAMBIO v13] Prima qui si controllava che data/Samuele-data.json NON ci
// fosse. Ora e' il contrario: e' la libreria di partenza dello scomparto
// ospite, l'app la scarica a runtime e senza di lei il Reset da ospite non ha
// niente da ripristinare. Resta pero' un file PUBBLICO: puo' contenere titoli e
// avanzamento, non voti ne' diario.
check('la libreria di partenza dell\'ospite esiste', fs.existsSync(SEED_PATH));
check('default-data.json conservato', fs.existsSync(path.join(ROOT, 'data/default-data.json')));
check('default-data.json non contiene serie',
  DEFAULT_JSON !== null && Array.isArray(DEFAULT_JSON)
  && DEFAULT_JSON.every(c => Array.isArray(c.shows) && c.shows.length === 0),
  'le categorie predefinite devono essere vuote: e\' il punto di partenza dei nuovi account');
check('la libreria di partenza e\' un backup valido',
  SEED_JSON !== null && Array.isArray(SEED_JSON.data) && SEED_JSON.data.length > 0
  && SEED_JSON.data.every(c => c && typeof c.name === 'string' && Array.isArray(c.shows)));
check('la libreria di partenza non contiene voti ne\' diario',
  SEED_JSON !== null
  && Object.keys(SEED_JSON.ratings || {}).length === 0
  && Object.keys(SEED_JSON.watch || {}).length === 0,
  'e\' un file pubblico: i voti e il diario non ci vanno');
check('la libreria di partenza e\' versionata (.gitignore)',
  /^!data\/Samuele-data\.json$/m.test(gitignore),
  'senza l\'eccezione il file non viene pubblicato e il Reset da ospite non trova nulla');
check('.gitignore presente', fs.existsSync(path.join(ROOT, '.gitignore')));
check('package.json presente', fs.existsSync(path.join(ROOT, 'package.json')));
check('VERSION del service worker incrementata', /const VERSION = 'v13'/.test(sw));

// ============================================================
group('8b. Conformita\' legale e accessibilita\'');

const privacy = read('privacy.html');
const cookie  = read('cookie.html');
const termini = read('termini.html');

check('le tre pagine legali esistono',
  ['privacy.html', 'cookie.html', 'termini.html', 'legal.css', 'LICENSE']
    .every(f => fs.existsSync(path.join(ROOT, f))));

// I termini d'uso delle API di TMDB impongono questa frase in modo visibile.
// Se sparisce, il progetto viola la licenza che gli permette di esistere.
const TMDB_NOTICE = /non\s+e'\s+approvato\s+ne'\s+certificato\s+da\s+TMDB/;
check('attribuzione TMDB nel piede di pagina dell\'app', TMDB_NOTICE.test(html));
check('attribuzione TMDB nelle pagine legali',
  [privacy, cookie, termini].every(p => TMDB_NOTICE.test(p)));

check('il piede di pagina rimanda alle tre pagine legali',
  ['privacy.html', 'cookie.html', 'termini.html'].every(f => html.includes(`href="${f}"`)));

// Le pagine legali non devono dipendere da app.js: vanno lette anche a
// JavaScript spento o se l'app va in errore.
check('le pagine legali non caricano app.js',
  ![privacy, cookie, termini].some(p => p.includes('app.js')));

// I segnaposto del titolare vanno sostituiti prima della pubblicazione:
// un'informativa senza contatti impedisce di esercitare i diritti GDPR.
const placeholders = /\[NOME E COGNOME\]|\[INDIRIZZO EMAIL\]/;
check('PROMEMORIA: segnaposto del titolare sostituiti',
  !placeholders.test(privacy) && !placeholders.test(termini),
  'sostituisci [NOME E COGNOME] e [INDIRIZZO EMAIL] in privacy.html e termini.html');

// Guardia sul contrasto. --accent (#e0323c) da' 4.42:1 sul fondo scuro, sotto
// la soglia AA di 4.5:1 per il testo normale: come colore di TESTO va usato
// --accent-text. Su bordi e sfondi --accent resta legittimo (soglia 3:1).
const bareAccentText = css.match(/(^|[;{\s])color: var\(--accent\)/gm) || [];
check('nessun testo usa --accent al posto di --accent-text',
  bareAccentText.length === 0,
  `${bareAccentText.length} dichiarazioni da convertire`);

check('--accent-text supera il contrasto AA', /--accent-text:\s*#ff6b73/.test(css));

// Una modale senza role="dialog" viene annunciata come un div qualsiasi.
check('le modali statiche dichiarano role="dialog"',
  (html.match(/role="dialog"/g) || []).length >= 2 &&
  (html.match(/aria-modal="true"/g) || []).length >= 2);

// L'anello del voto apre un pannello al click: deve essere raggiungibile con
// Tab e attivabile con Invio/Spazio, non solo col mouse.
check('l\'anello del voto e\' attivabile da tastiera',
  /rating-ring \$\{tier\}" role="button" tabindex="0"/.test(appJs) &&
  /\.rating-ring'\)\.onkeydown/.test(appJs));

check('indicatore di focus visibile definito', /:focus-visible\s*\{[^}]*outline:/.test(css));
check('rispetto di prefers-reduced-motion', /prefers-reduced-motion:\s*reduce/.test(css));

// Nessuno strumento di analisi: e' cio' che permette di non avere il banner
// dei cookie. Se rientra, la cookie policy diventa falsa.
check('nessuno strumento di analisi o tracciamento',
  !/gtag\(|googletagmanager|google-analytics|plausible\.io|matomo|hotjar|clarity\.ms|fbq\(/i
    .test(html + appJs + sw));

// Un iframe di YouTube imposta cookie di terze parti all'apertura di ogni
// scheda: il trailer deve restare un link.
check('nessun iframe di YouTube incorporato',
  !/<iframe[^>]*youtube/i.test(appJs + html));

// ============================================================
group('8c. Libreria di partenza: ospite vs account');
// ============================================================
// La regola in una riga: l'ospite riparte dalla libreria personale, un account
// riparte vuoto. Se questa distinzione si perde, si torna al bug della v9 (la
// lista di qualcuno che spunta dentro l'account di qualcun altro) oppure a
// quello segnalato adesso (il Reset da ospite che lascia lo schermo vuoto).
check('le due librerie di partenza hanno costanti distinte',
  /const DEFAULT_DATA_URL = '\.\/data\/default-data\.json'/.test(appJs)
  && /const GUEST_SEED_URL\s+= '\.\/data\/Samuele-data\.json'/.test(appJs));
check('il percorso del seed compare solo dentro loadGuestSeed',
  (appJs.match(/GUEST_SEED_URL/g) || []).length === 2);
check('il seed si legge da due soli punti (primo avvio e Reset)',
  (appJs.match(/loadGuestSeed\(\)/g) || []).length === 2);
check('la scelta dipende dallo scomparto, non da chi chiama',
  /loadStartingLibrary = async \(\) => \{\s*\n\s*if \(storeScope !== GUEST_SCOPE\) return await loadEmptyLibrary\(\);/.test(appJs));
check('un account nuovo parte dalla struttura vuota',
  /createEmptyUserDocs[\s\S]{0,1600}loadEmptyLibrary\(\)/.test(appJs)
  && !/createEmptyUserDocs[\s\S]{0,1600}loadGuestSeed/.test(appJs),
  'createEmptyUserDocs non deve vedere la libreria dell\'ospite');
check('il Reset si ramifica sullo scomparto',
  /const resetData = async \(\) => \{\s*\n\s*const isGuest = storeScope === GUEST_SCOPE;/.test(appJs));
check('il Reset da ospite ripristina, il Reset da account svuota',
  /if \(isGuest\) \{[\s\S]{0,300}loadGuestSeed\(\)[\s\S]{0,300}\} else \{[\s\S]{0,200}loadEmptyLibrary\(\)/.test(appJs));
check('dopo il ripristino si normalizza lo schema',
  /mergeSeedSideStores\(seed\);[\s\S]{0,400}ensureSchema\(\);/.test(appJs),
  'il file di partenza non porta id, tag ne\' addedAt');
check('voti e diario del seed sono additivi, mai sovrascritti',
  /const mergeSeedSideStores[\s\S]{0,600}target\[key\] === undefined/.test(appJs));
check('il Reset non svuota piu\' la cache dei dettagli TMDB',
  !/showDetailsCache\.clear\(\);/.test(appJs) && /pruneDetailsCache\(\);\n/.test(appJs),
  'con ~150 serie ripristinate sarebbero altrettante fetch TMDB immediate');
check('il service worker tratta tutta la cartella data/ come rete-prima',
  /const isDataFile = /.test(sw) && /isDataFile\(url\)/.test(sw)
  && !/endsWith\('default-data\.json'\)/.test(sw));
check('il fallback offline ignora la query string',
  /caches\.match\(req, \{ ignoreSearch: true \}\)/.test(sw),
  'la fetch aggiunge ?t=<ora>: senza ignoreSearch la copia in cache non si trova mai');

// ============================================================
group('9. Convenzioni del progetto (README)');
// ============================================================
check('il backup esporta ancora i tre store',
  /version: EXPORT_VERSION[\s\S]{0,400}data[\s\S]{0,200}ratings[\s\S]{0,200}watch/.test(appJs));
check('ensureSchema non ri-chiavia voti e diario',
  !/ratingsData\[.*generateId/.test(appJs));
check('i menu passano da openFloatingMenu', /openFloatingMenu\(anchorEl, items/.test(appJs));
check('escapeHtml usato nel dropdown dei suggerimenti',
  /search-dropdown-item[\s\S]{0,400}escapeHtml/.test(appJs));

// ============================================================
group('10. Comportamento in jsdom');
// ============================================================
let jsdomOk = true;
try { require.resolve('jsdom'); } catch (e) { jsdomOk = false; }

if (!jsdomOk) {
  results.push('  --   jsdom non installato: i controlli dinamici sono saltati (npm install)');
} else {
  const { JSDOM } = require('jsdom');

  const authCallbacks = [];
  const writes = { shows: [], ratings: [], watch: [] };
  const makeDoc = (bucket) => ({
    get: async () => ({ exists: true, data: () => ({ data: [], ts: 1 }) }),
    set: async (payload) => { writes[bucket].push(payload); },
    delete: async () => {},
    onSnapshot: () => () => {},
  });

  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.test/' });
  const w = dom.window;

  // Finto SDK Firebase: abbastanza da far girare initFirebase e catturare il
  // callback di onAuthStateChanged, che e' quello che vogliamo pilotare.
  w.firebase = {
    initializeApp: () => {},
    firestore: Object.assign(() => ({
      collection: () => ({ doc: () => ({ collection: () => ({ doc: (id) => makeDoc(id === 'shows' ? 'shows' : id === 'ratings' ? 'ratings' : 'watch') }) }) }),
    }), { FieldValue: { serverTimestamp: () => 'TS' } }),
    auth: Object.assign(() => ({
      onAuthStateChanged: (cb) => { authCallbacks.push(cb); },
      getRedirectResult: () => Promise.resolve(null),
      signOut: async () => {},
    }), { GoogleAuthProvider: function () {} }),
  };
  w.fetch = async () => ({ ok: true, json: async () => ({ results: [] }), text: async () => '[]' });
  w.matchMedia = () => ({ matches: false, addEventListener: () => {} });
  w.IntersectionObserver = function () { this.observe = () => {}; this.disconnect = () => {}; };
  w.requestAnimationFrame = (fn) => setTimeout(fn, 0);

  // Libreria "dell'ospite" gia' presente, con un timestamp recente: e' lo
  // scenario esatto che prima distruggeva la libreria dell'account.
  const GUEST_LIB = [{ name: 'Sto guardando', shows: [{ title: 'Serie ospite' }] }];
  w.localStorage.setItem('tvtracker-data', JSON.stringify(GUEST_LIB));
  w.localStorage.setItem('tvtracker-data-ts', String(Date.now()));
  w.localStorage.setItem('tvtracker-ratings', JSON.stringify({ 'Serie ospite': { average: 9 } }));

  try {
    w.eval(appJs);
  } catch (e) {
    results.push(`  FAIL app.js non si carica in jsdom — ${e.message}`);
    fail++;
  }

  const ls = w.localStorage;

  check('le vecchie chiavi sono state migrate in guest',
    ls.getItem('tvtracker:guest:data') === JSON.stringify(GUEST_LIB));
  check('le vecchie chiavi sono state rimosse', ls.getItem('tvtracker-data') === null);
  check('i voti sono stati migrati', ls.getItem('tvtracker:guest:ratings') !== null);
  check('onAuthStateChanged registrato', authCallbacks.length === 1);

  // Secondo avvio, browser pulito: l'ospite deve trovare la libreria del file
  // invece di una pagina vuota. E' il caso segnalato (Reset che svuota tutto),
  // qui verificato sul percorso gemello del primo avvio.
  const seedBootTest = async () => {
    if (!SEED_JSON) { results.push('  --   data/Samuele-data.json assente: test del seed saltato'); return; }

    const dom2 = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.test/' });
    const w2 = dom2.window;
    const asked = [];
    w2.firebase = undefined;   // niente SDK: l'app resta in locale, ed e' quello che ci serve
    w2.fetch = async (url) => {
      asked.push(String(url));
      if (String(url).includes('Samuele-data.json')) return { ok: true, text: async () => JSON.stringify(SEED_JSON) };
      if (String(url).includes('default-data.json')) return { ok: true, text: async () => JSON.stringify(DEFAULT_JSON || []) };
      return { ok: true, json: async () => ({ results: [] }), text: async () => '[]' };
    };
    w2.matchMedia = () => ({ matches: false, addEventListener: () => {} });
    w2.IntersectionObserver = function () { this.observe = () => {}; this.disconnect = () => {}; };
    w2.requestAnimationFrame = (fn) => setTimeout(fn, 0);

    try { w2.eval(appJs); } catch (e) { check('app.js si carica con lo storage vuoto', false, e.message); return; }
    await new Promise(r => setTimeout(r, 120));   // initData e' asincrona

    let stored = null;
    try { stored = JSON.parse(w2.localStorage.getItem('tvtracker:guest:data')); } catch (e) {}
    const titles = (cats) => (cats || []).flatMap(c => (c.shows || []).map(sh => sh.title));

    check('l\'ospite chiede la libreria di partenza', asked.some(u => u.includes('Samuele-data.json')));
    check('la libreria di partenza finisce nello scomparto ospite',
      Array.isArray(stored) && titles(stored).length === titles(SEED_JSON.data).length && titles(stored).length > 0,
      `attese ${titles(SEED_JSON.data).length} serie, trovate ${stored ? titles(stored).length : 'nessuna'}`);
    check('le serie ripristinate hanno id e tag',
      Array.isArray(stored) && stored.every(c => c.id && c.shows.every(sh => sh.id && Array.isArray(sh.tags))));
    check('nessuno scomparto di account viene creato dall\'ospite',
      !Object.keys(w2.localStorage).some(k => /^tvtracker:(?!guest:)/.test(k) && k.endsWith(':data')));
  };

  // Login: lo scomparto deve cambiare e il timestamp ripartire da zero.
  if (authCallbacks.length) {
    const before = ls.getItem('tvtracker:guest:data');
    return Promise.resolve(authCallbacks[0]({ uid: 'utente-123', isAnonymous: false, displayName: 'Test' }))
      .catch(() => {})
      .then(() => {
        check('lo scomparto ospite non e\' stato toccato dall\'accesso',
          ls.getItem('tvtracker:guest:data') === before);
        check('nessuna scrittura della libreria ospite sui documenti dell\'account',
          !writes.shows.some(p => JSON.stringify(p.data) === JSON.stringify(GUEST_LIB)),
          'la libreria dell\'ospite e\' finita sull\'account');
      })
      .then(seedBootTest)
      .then(report, (e) => { check('test del seed completato', false, e.message); report(); });
  }
  return seedBootTest().then(report, (e) => { check('test del seed completato', false, e.message); report(); });
}

function report() {
  console.log(results.join('\n'));
  console.log(`\n${pass} passati, ${fail} falliti su ${pass + fail}`);
  process.exit(fail ? 1 : 0);
}

if (!jsdomOk) report();
