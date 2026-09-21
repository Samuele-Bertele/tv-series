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
check('VERSION del service worker incrementata', /const VERSION = 'v15'/.test(sw));

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

// Le due famiglie che fino alla v14 non avevano alcun token: il blu delle
// prossime uscite e il viola dei consigli.
//
// [v15] Non basta piu' che i token esistano: devono restare NEUTRI. Si vedevano
// sette tinte su una schermata sola (rosso, oro, azzurro, viola e i quattro
// colori degli anelli voto) e il rosso del marchio non era piu' distinguibile
// dal resto. Il test lega la decisione, non il valore: se qualcuno rimette una
// tinta satura in --info o --rec, qui si accorge del perche' era stata tolta.
check('--info definito', /--info:\s*#[0-9a-f]{6}/i.test(css));
check('--rec definito', /--rec:\s*#[0-9a-f]{6}/i.test(css));

const neutrality = (token) => {
  const m = css.match(new RegExp(`--${token}:\\s*#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})`, 'i'));
  if (!m) return 255;
  const [r, g, b] = m.slice(1).map(h => parseInt(h, 16));
  return Math.max(r, g, b) - Math.min(r, g, b);
};
check('la famiglia "informazione" e\' neutra', neutrality('info') <= 28,
  `scarto R/G/B di ${neutrality('info')}: oltre 28 torna a leggersi come una tinta`);
check('la famiglia "consigli" e\' neutra', neutrality('rec') <= 28,
  `scarto R/G/B di ${neutrality('rec')}: oltre 28 torna a leggersi come una tinta`);

// Una sola filettatura in cima: era su .top-bar, .legends-section,
// .upcoming-section, .recs-section e .stat-card.
// La firma e' precisa: pseudo-elemento ancorato ai tre lati alti e alto 2-3px.
// Non basta contare i ::before, che servono anche a pallini ed elenchi.
const topRules = (css.match(/::before \{[^}]*top: 0; left: 0; right: 0;[^}]*height: [23]px/g) || []).length;
check('una sola riga-gradiente in cima ai pannelli', topRules === 1, `trovate ${topRules}`);

// L'oro con alpha come colore del TESTO non passa AA a 10-12px: il caso
// peggiore stava a 2,40:1. Sui bordi e sugli sfondi l'alpha resta legittima.
const goldAlphaText = (css.match(/[;{ ]color:\s*rgba\(var\(--gold-rgb\)/g) || []).length;
check('nessun testo dorato con alpha al posto di --gold-text',
  goldAlphaText === 0, `${goldAlphaText} dichiarazioni da convertire`);
check('--gold-text-soft usato davvero',
  (css.match(/var\(--gold-text-soft\)/g) || []).length >= 3);

check('--on-accent definito', /--on-accent:\s*#ffffff/.test(css));
check('--fs-4xl definito per il wordmark', /--fs-4xl:/.test(css));

const hardInfo = (cssBody.match(/#7fd4ff|#40a9ff|rgba\(64\s*,\s*169\s*,\s*255/g) || []).length;
const hardRec  = (cssBody.match(/#c98bdd|#e5c5f0|rgba\(155\s*,\s*89\s*,\s*182/g) || []).length;
const hardGreen = (cssBody.match(/rgba\(46\s*,\s*204\s*,\s*113/g) || []).length;
check('nessun blu delle uscite scritto a mano fuori da :root', hardInfo === 0, `trovati ${hardInfo}`);
check('nessun viola dei consigli scritto a mano fuori da :root', hardRec === 0, `trovati ${hardRec}`);
check('nessun verde rgba scritto a mano fuori da :root', hardGreen === 0, `trovati ${hardGreen}`);

// I colori non devono rientrare dalla finestra: app.js genera HTML, e uno
// style="color:..." inline scavalca i token senza che il foglio se ne accorga.
// Le righe con win.document.write sono escluse a ragion veduta: scrivono in una
// finestra NUOVA, che non carica styles.css — li' var(--...) non risolverebbe
// nulla e il <pre> uscirebbe con i colori di default del browser.
const appJsInDocument = appJs
  .split('\n')
  .filter(l => !l.includes('win.document.write'))
  .join('\n');
const inlineColor = (appJsInDocument.match(/style="[^"]*color:\s*(#|rgba?\()/g) || []).length;
check('nessun colore inline nei template di app.js', inlineColor === 0, `trovati ${inlineColor}`);

// L'immagine di condivisione e' un canvas: non capisce var(), quindi il valore
// va risolto — ma leggendolo dal foglio, non ricopiandolo.
check('i colori del canvas si leggono dai token', /const cssVar = /.test(appJs)
  && /cssVar\('--accent'/.test(appJs));
check('nessun esadecimale ricopiato nel canvas di condivisione',
  !/ctx\.fillStyle = '#/.test(appJs));

// ============================================================
group('9b. Gerarchia e semantica (v15)');
// ============================================================
check('la barra e\' un <header>', /<header class="top-bar">/.test(html));
check('il wordmark e\' un <h1>', /<h1 class="logo">/.test(html) && !/<div class="logo">/.test(html));
check('il contenuto sta in un <main>', /<main>[\s\S]*id="categoriesContainer"[\s\S]*<\/main>/.test(html));
check('skip link verso la libreria', /class="skip-link" href="#categoriesContainer"/.test(html));
check('sottotitolo informativo, riempito dal codice',
  /id="librarySubtitle"/.test(html) && /const updateLibrarySubtitle = /.test(appJs)
  && !/drag &amp; drop\s*<\/div>/.test(html));
check('il form "nuova categoria" non e\' piu\' nella barra',
  html.indexOf('id="addCategoryForm"') > html.indexOf('</header>'));
check('il form "nuova categoria" sta nel pannello Categorie',
  /id="sideNavPanel"[\s\S]*id="addCategoryForm"/.test(html));
check('il menu ⋮ porta al form della categoria', /label: 'Nuova categoria'/.test(appJs));
check('intestazione di categoria = <h2><button aria-expanded>',
  /document\.createElement\('h2'\)/.test(appJs)
  && /class="category-toggle" aria-expanded="\$\{!isCollapsed\}" aria-controls=/.test(appJs)
  && /toggleBtn\.setAttribute\('aria-expanded'/.test(appJs));
check('nessun listener di click sul div dell\'intestazione',
  !/headerDiv\.addEventListener\('click'/.test(appJs));
check('.sr-only ha un uso reale', /class="sr-only"/.test(appJs));
check('sezioni con nome accessibile',
  /<section class="legends-section"[^>]*aria-labelledby="legendsTitle"/.test(appJs)
  && /<section class="upcoming-section"[^>]*aria-labelledby="upcomingTitle"/.test(appJs)
  && (appJs.match(/<section class="recs-section" aria-labelledby="recsTitle">/g) || []).length === 4);
check('le affordance solo-hover hanno un ripiego touch',
  /@media \(hover: none\) \{[^}]*\.category-actions \{ opacity: 1; \}[^}]*\.journal-entry-del \{ opacity: 1; \}/.test(css));
// Due per riga sotto i 480px c'era gia': qui si blocca, cosi' nessuno lo toglie
// credendolo un doppione del blocco 768 (che mette tre per riga).
check('due card per riga sotto i 480px',
  /@media \(max-width: 480px\) \{\s*\.shows-row \{ grid-template-columns: repeat\(2, 1fr\)/.test(css));
check('anello del voto ridotto dove le card sono tre per riga',
  /@media \(max-width: 768px\) \{[\s\S]*?\.rating-ring \{ width: 34px; height: 34px; \}/.test(css));
check('font di ripiego con size-adjust',
  /font-family: 'Sora Fallback';[\s\S]{0,160}size-adjust/.test(css)
  && /font-family: 'Unbounded Fallback';[\s\S]{0,160}size-adjust/.test(css)
  && /--font-body: 'Sora', 'Sora Fallback'/.test(css));
{
  const printFn = (appJs.match(/const printList = \(\) => \{[\s\S]*?\n\};/) || [''])[0];
  check('la stampa apre il dialogo e non e\' piu\' un <pre>',
    /win\.print\(\)/.test(printFn) && !/<pre/.test(printFn));
}
check('nessuna finestra di testo bianco su nero',
  !/background:#000;color:#fff/.test(appJs));
check('foglio @media print presente', /@media print \{/.test(css));

// La guardia del contrasto su --accent cercava "color: var(--accent)" con lo
// spazio: `.show-tag` scriveva "color:var(--accent)" e passava. Ora lo spazio
// e' facoltativo.
const bareAccentAny = css.match(/(^|[;{\s])color:\s*var\(--accent\)/gm) || [];
check('nessun testo usa --accent, con o senza spazio', bareAccentAny.length === 0,
  `${bareAccentAny.length} dichiarazioni da convertire`);

// Nessuna classe definita nel foglio senza un uso: erano 18.
{
  const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const defined = [...new Set((cssNoComments.match(/\.[a-zA-Z][\w-]*/g) || []).map(c => c.slice(1)))];
  const usedIn = appJs + html + read('legal.css');
  const dead = defined.filter(c => !new RegExp(`\\b${c}\\b`).test(usedIn));
  check('nessuna classe CSS morta', dead.length === 0, dead.join(', '));
}

// ============================================================
group('9c. Voto per stagione (struttura)');
// ============================================================
check('un solo punto di lettura del voto della serie',
  /const ratingOf = \(title\) => \{[\s\S]{0,120}typeof e\.average === 'number'/.test(appJs));
// Il bug che questa guardia previene: una voce con le sole stagioni ha
// `average` undefined, e doRender la leggeva con .toFixed() -> schermo bianco.
check('nessun .average letto direttamente da ratingsData[...]',
  !/ratingsData\[[^\]]+\]\??\.average/.test(appJs));
check('nessun conteggio dei voti che includa le voci solo-stagioni',
  !/Object\.keys\(ratingsData\)\.length/.test(appJs) && !/Object\.entries\(ratingsData\)/.test(appJs));
check('le stagioni vivono dentro ratingsData, non in un quarto store',
  /ratingsData\[title\] = \{ \.\.\.base, seasons: \{/.test(appJs)
  && !/seasonRatingsData|tvtracker:[^']*season/.test(appJs));
check('rivalutare la serie non cancella le stagioni',
  /const seasons = ratingsData\[title\]\?\.seasons;\s*\n\s*ratingsData\[title\] = seasons \? \{ \.\.\.scores, seasons \} : scores;/.test(appJs));
check('le stagioni si ordinano per numero, non come stringhe',
  /seasonRatingEntries[\s\S]{0,200}parseInt\(a\[0\], 10\) - parseInt\(b\[0\], 10\)/.test(appJs));
check('select dell\'ambito a 16px (niente zoom su iOS)',
  /\.rating-scope select \{[\s\S]{0,300}font-size: var\(--fs-lg\)/.test(css));

// ============================================================
group('10. Comportamento in jsdom (accesso, seed, voto per stagione, ricerca, consigli)');
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

  // [VOTO PER STAGIONE] Il flusso vero, sul codice vero: modale, selettore
  // d'ambito, salvataggi, render e import. Le funzioni interne sono const
  // dentro l'eval: le si espone con un gancio accodato allo stesso sorgente.
  const seasonRatingTest = async () => {
    const dom3 = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.test/' });
    const w3 = dom3.window;
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    w3.firebase = undefined;
    w3.fetch = async () => ({ ok: true, json: async () => ({ results: [] }), text: async () => '[]' });
    w3.matchMedia = () => ({ matches: false, addEventListener: () => {} });
    w3.IntersectionObserver = function () { this.observe = () => {}; this.disconnect = () => {}; };
    w3.requestAnimationFrame = (fn) => setTimeout(fn, 0);

    const axes = (v) => ({ cast: v, trama: v, ambientazione: v, colonna_sonora: v, coinvolgimento: v, average: v });
    w3.localStorage.setItem('tvtracker:guest:data', JSON.stringify([
      { name: 'Drama', shows: [
        { title: 'Serie lunga', seasons_count: 3 },
        { title: 'Solo stagioni', seasons_count: 3 },
        { title: 'Mini', seasons_count: 1 },
      ] },
    ]));
    w3.localStorage.setItem('tvtracker:guest:ratings', JSON.stringify({
      'Serie lunga': { ...axes(8), seasons: { '1': axes(9), '2': axes(6), '10': axes(7) } },
      'Solo stagioni': { seasons: { '2': axes(7) } },
    }));

    const HOOK = `\n;window.__t = { ratingOf, ratedTitles, seasonRatingSummary, seasonRatingEntries,
      mergeImportedData, openRatingModal, showDetailsCache, getRatings: () => ratingsData };`;
    try { w3.eval(appJs + HOOK); }
    catch (e) { check('app.js si carica con voti per stagione in memoria', false, e.message); return; }
    await wait(200);
    const t = w3.__t;
    const doc = w3.document;

    // --- lettura ---
    check('una voce con le sole stagioni non e\' un voto della serie', t.ratingOf('Solo stagioni') === null);
    check('ratedTitles conta solo i voti della serie',
      JSON.stringify(t.ratedTitles()) === JSON.stringify(['Serie lunga']));
    check('le stagioni si ordinano come numeri (2 prima di 10)',
      JSON.stringify(t.seasonRatingEntries('Serie lunga').map(e => e[0])) === '["1","2","10"]');
    const sum = t.seasonRatingSummary('Serie lunga');
    check('riepilogo: conteggio, media, migliore e peggiore',
      sum && sum.count === 3 && sum.avg.toFixed(2) === '7.33' && sum.best.season === '1' && sum.worst.season === '2');

    // --- render: il crash che la guardia previene ---
    const cards = [...doc.querySelectorAll('.show-card')];
    const cardOf = (title) => cards.find(c => c.dataset.title === title);
    check('il render regge una voce senza average', cards.length === 3,
      `card disegnate: ${cards.length}`);
    check('nessun anello sulla serie votata solo per stagione',
      !!cardOf('Solo stagioni') && !cardOf('Solo stagioni').querySelector('.rating-ring'));
    check('l\'anello c\'e\' sulla serie votata', !!cardOf('Serie lunga')?.querySelector('.rating-ring'));
    check('il sottotitolo conta solo le serie davvero valutate',
      /3 serie · 1 categoria · 1 valutate/.test(doc.getElementById('librarySubtitle')?.textContent || ''),
      doc.getElementById('librarySubtitle')?.textContent);

    const seasons3 = { seasons: [1, 2, 3].map(n => ({ season_number: n, name: `Stagione ${n}` })) };
    t.showDetailsCache.set('Serie lunga', seasons3);
    t.showDetailsCache.set('Solo stagioni', seasons3);
    t.showDetailsCache.set('Mini', { seasons: [{ season_number: 1, name: 'Stagione 1' }] });

    const openModal = async (title, scope) => {
      await t.openRatingModal(title, 'x.jpg', scope);
      return doc.querySelector('.rating-modal')?.closest('.modal-overlay');
    };
    const setAll = (modal, v) => modal.querySelectorAll('.rating-slider').forEach(sl => {
      sl.value = String(v); sl.dispatchEvent(new w3.Event('input'));
    });
    const save = async (modal) => { modal.querySelector('#saveRating').click(); await wait(80); };

    // --- votare una stagione nuova ---
    let m = await openModal('Serie lunga');
    const sel = m?.querySelector('#ratingScope');
    check('il selettore d\'ambito compare da due stagioni in su', !!sel && sel.options.length === 4);
    sel.value = '3'; sel.dispatchEvent(new w3.Event('change'));
    check('cambiare ambito ricarica i cursori (stagione mai votata: 7)',
      [...m.querySelectorAll('.rating-slider')].every(x => x.value === '7'));
    check('il titolo della modale segue l\'ambito', /Valuta Stagione 3/.test(m.querySelector('.modal-header h2').textContent));
    sel.value = '1'; sel.dispatchEvent(new w3.Event('change'));
    check('...e mostra i voti gia\' dati (stagione 1: 9)',
      [...m.querySelectorAll('.rating-slider')].every(x => x.value === '9'));
    sel.value = '3'; sel.dispatchEvent(new w3.Event('change'));
    setAll(m, 10); await save(m);
    let r = t.getRatings()['Serie lunga'];
    check('il voto di stagione finisce in seasons[n]', r.seasons['3']?.average === 10);
    check('votare una stagione non tocca il voto della serie', r.average === 8);
    check('...ne\' le altre stagioni', r.seasons['1'].average === 9 && r.seasons['2'].average === 6);

    // --- rivalutare la serie ---
    m = await openModal('Serie lunga');
    setAll(m, 5); await save(m);
    r = t.getRatings()['Serie lunga'];
    check('rivalutare la serie cambia la media', r.average === 5);
    check('rivalutare la serie non cancella le stagioni', Object.keys(r.seasons).length === 4);

    // --- serie mai votata: la stagione non inventa un voto alla serie ---
    m = await openModal('Solo stagioni', '3');
    check('la modale si apre direttamente sulla stagione richiesta',
      m.querySelector('#ratingScope')?.value === '3');
    setAll(m, 4); await save(m);
    check('votare una stagione non inventa il voto della serie', t.ratingOf('Solo stagioni') === null);
    check('le stagioni della serie non votata si accumulano',
      JSON.stringify(Object.keys(t.getRatings()['Solo stagioni'].seasons).sort()) === '["2","3"]');

    // --- miniserie ---
    m = await openModal('Mini', '1');
    check('nessun selettore per una serie di una sola stagione', !m.querySelector('#ratingScope'));
    setAll(m, 6); await save(m);
    check('...e il voto va alla serie, non alla stagione 1',
      t.ratingOf('Mini')?.average === 6 && !t.getRatings()['Mini'].seasons);

    // --- import in unione: si riempiono i buchi, anche dentro la voce ---
    t.mergeImportedData({ cats: [], watch: null, ratings: {
      'Serie lunga':   { ...axes(1), seasons: { '1': axes(2), '4': axes(9) } },
      'Solo stagioni': { ...axes(8), seasons: { '2': axes(1) } },
    } });
    r = t.getRatings();
    check('unione: il voto locale della serie vince', r['Serie lunga'].average === 5);
    check('unione: la stagione locale vince', r['Serie lunga'].seasons['1'].average === 9);
    check('unione: la stagione mancante arriva dal file', r['Serie lunga'].seasons['4']?.average === 9);
    check('unione: il voto della serie riempie il buco, le stagioni locali restano',
      r['Solo stagioni'].average === 8 && r['Solo stagioni'].seasons['2'].average === 7 && r['Solo stagioni'].seasons['3'].average === 4);

    // --- persistenza: tutto nello store esistente ---
    const stored = JSON.parse(w3.localStorage.getItem('tvtracker:guest:ratings') || '{}');
    check('i voti per stagione sono salvati nello store dei voti', stored['Serie lunga']?.seasons?.['3']?.average === 10);
    check('nessuna chiave di storage nuova per le stagioni',
      !Object.keys(w3.localStorage).some(k => /season/i.test(k)));
  };

  // [RICERCA] Le sezioni costruite dalla libreria devono seguire la ricerca;
  // i consigli (che non sono libreria) spariscono.
  const searchSectionsTest = async () => {
    const dom4 = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.test/' });
    const w4 = dom4.window;
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    w4.firebase = undefined;
    w4.fetch = async () => ({ ok: true, json: async () => ({ results: [] }), text: async () => '[]' });
    w4.matchMedia = () => ({ matches: false, addEventListener: () => {} });
    w4.IntersectionObserver = function () { this.observe = () => {}; this.disconnect = () => {}; };
    w4.requestAnimationFrame = (fn) => setTimeout(fn, 0);
    w4.localStorage.setItem('tvtracker:guest:data', JSON.stringify([
      { name: 'Sto guardando', shows: [{ title: 'Breaking Bad', tags: ['crime'] }, { title: 'Friends' }] },
      { name: 'Animazione', shows: [{ title: 'I Simpson', seasons_count: 35, progress: '1' }] },
    ]));
    const HOOK = `\n;window.__s = { showDetailsCache, render, fetchRecommendations, fuzzyMatch,
      setRatings: (r) => { ratingsData = r; } };`;
    try { w4.eval(appJs + HOOK); }
    catch (e) { check('app.js si carica per il test della ricerca', false, e.message); return; }
    await wait(150);
    const t = w4.__s, doc = w4.document;
    const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
    t.showDetailsCache.set('Breaking Bad', { genre_names: ['Dramma'], next_episode_to_air: { air_date: inDays(1), season_number: 5, episode_number: 9, name: 'x' } });
    t.showDetailsCache.set('I Simpson',    { genre_names: ['Animazione'], next_episode_to_air: { air_date: inDays(3), season_number: 36, episode_number: 2, name: 'y' } });
    await t.render(); await wait(60);

    // Il falso positivo che il test sulle sezioni ha fatto emergere, presente
    // gia' nella v14 e anche nella griglia: le parole di una o due lettere del
    // titolo ("i", "il", "di") "contenute" nella parola cercata.
    const fz = (q, title) => t.fuzzyMatch(q, title.toLowerCase());
    check('ricerca: "crime" non trova "I Simpson"', !fz('crime', 'I Simpson'));
    check('ricerca: "pilota" non trova "Il trono di spade"', !fz('pilota', 'Il trono di spade'));
    check('ricerca: "diamanti" non trova "La casa di carta"', !fz('diamanti', 'La casa di carta'));
    check('ricerca: i refusi funzionano ancora ("breking" -> Breaking Bad)', fz('breking', 'Breaking Bad'));
    check('ricerca: parole in ordine sparso ("casa carta")', fz('casa carta', 'La casa di carta'));
    check('ricerca: parola cercata che ne contiene una del titolo ("breakingbad")', fz('breakingbad', 'Breaking Bad'));

    const input = doc.getElementById('searchInput');
    const search = async (q) => { input.value = q; input.dispatchEvent(new w4.Event('input')); await wait(20); };
    const shown = (sel) => [...doc.querySelectorAll(sel)].filter(el => !el.classList.contains('search-hidden')).map(el => el.dataset.title);
    const hidden = (id) => doc.getElementById(id).hidden;

    check('senza ricerca le tre sezioni sono piene',
      shown('.resume-card').length === 2 && shown('.upcoming-card').length === 2 && shown('.legend-card').length === 1);

    await search('simpson');
    check('ricerca: "Riprendi da qui" sparisce se non resta nulla', hidden('resumeContainer'));
    check('ricerca: le uscite si filtrano per titolo',
      JSON.stringify(shown('.upcoming-card')) === '["I Simpson"]' && !hidden('upcomingContainer'));
    check('ricerca: le epopee si filtrano per titolo',
      JSON.stringify(shown('.legend-card')) === '["I Simpson"]' && !hidden('legendsContainer'));
    check('ricerca: i consigli si nascondono', hidden('recommendationsContainer'));
    check('ricerca: la frase di conteggio delle uscite segue il filtro',
      /^1 di 2 episodi/i.test(doc.querySelector('.upcoming-sub')?.textContent || ''),
      doc.querySelector('.upcoming-sub')?.textContent);

    await search('crime');
    check('ricerca per tag anche nelle sezioni', JSON.stringify(shown('.resume-card')) === '["Breaking Bad"]');
    check('...e l\'epopea senza quel tag sparisce con la sua sezione', hidden('legendsContainer'));

    await search('dramma');
    check('ricerca per genere anche nelle sezioni', JSON.stringify(shown('.upcoming-card')) === '["Breaking Bad"]');

    await t.render(); await wait(60);
    check('il filtro sopravvive a un nuovo render', JSON.stringify(shown('.upcoming-card')) === '["Breaking Bad"]');

    await search('');
    check('cancellando la ricerca la frase torna quella di prima',
      /^2 episodi/i.test(doc.querySelector('.upcoming-sub')?.textContent || ''));
    check('cancellando la ricerca torna tutto',
      !hidden('resumeContainer') && !hidden('upcomingContainer') && !hidden('legendsContainer') && !hidden('recommendationsContainer')
      && shown('.resume-card').length === 2 && shown('.legend-card').length === 1);

    // [CONSIGLI] due pagine di discover che si sovrappongono
    t.showDetailsCache.set('Breaking Bad', { genre_ids: [18], genre_names: ['Dramma'] });
    t.setRatings({ 'Breaking Bad': { cast: 9, trama: 9, ambientazione: 9, colonna_sonora: 9, coinvolgimento: 9, average: 9 } });
    const page = [1, 2, 3].map(id => ({ id, name: `Serie ${id}`, genre_ids: [18], vote_average: 8 }));
    w4.fetch = async () => ({ ok: true, json: async () => ({ results: page }) });
    const recs = await t.fetchRecommendations();
    const ids = recs.items.map(r => r.id);
    check('consigli senza doppioni fra le pagine', ids.length === 3 && new Set(ids).size === 3,
      `ids: ${JSON.stringify(ids)}`);
  };

  // [SERVICE WORKER] Eseguito davvero, in una sandbox con cache e fetch finti.
  const serviceWorkerTest = async () => {
    group('11. Service worker (eseguito in una sandbox)');
    const vm = require('vm');
    const store = new Map();
    const noSearch = (u) => u.split('?')[0];
    const cache = {
      put: async (req, res) => { store.set(req.url, res); },
      match: async (req) => store.get(req.url),
    };
    const cachesMock = {
      open: async () => cache,
      match: async (req, opts = {}) => opts.ignoreSearch
        ? [...store.entries()].find(([k]) => noSearch(k) === noSearch(req.url))?.[1]
        : store.get(req.url),
      keys: async () => [], delete: async () => true,
    };
    let net = async () => { throw new Error('offline'); };
    const listeners = {};
    const sandbox = {
      self: { addEventListener: (t, fn) => { listeners[t] = fn; }, skipWaiting() {}, clients: { claim: async () => {} } },
      caches: cachesMock, fetch: (req) => net(req), URL, Request, Response, console, setTimeout,
    };
    vm.createContext(sandbox);
    try { vm.runInContext(sw, sandbox); }
    catch (e) { check('sw.js si carica', false, e.message); return; }

    const dispatch = async (url, accept = '*/*') => {
      const req = new Request(url, { headers: { accept } });
      let responded = null; const waits = [];
      listeners.fetch({ request: req, respondWith: (p) => { responded = Promise.resolve(p); }, waitUntil: (p) => waits.push(p) });
      const res = responded ? await responded : undefined;
      await Promise.all(waits);
      return res;
    };
    // Risposta opaca: e' quello che arriva a <link>/<script> senza crossorigin.
    const opaque = (tag) => ({ ok: false, type: 'opaque', status: 0, tag, clone() { return this; } });
    const ok = (body) => new Response(body, { status: 200 });

    const FA   = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/solid.min.css';
    const FB   = 'https://www.gstatic.com/firebasejs/10.13.1/firebase-app-compat.js';
    const GCSS = 'https://fonts.googleapis.com/css2?family=Sora:wght@400..800&display=swap';
    const WOFF = 'https://fonts.gstatic.com/s/sora/v12/abc.woff2';
    const FS   = 'https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel?x=1';
    const AUTH = 'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=k';

    net = async (req) => req.url === WOFF ? ok('font') : (req.url.includes('googleapis.com/') && !req.url.includes('fonts.') ? ok('api') : opaque('v1'));
    await dispatch(FA); await dispatch(FB); await dispatch(GCSS); await dispatch(WOFF);
    await dispatch(FS); await dispatch(AUTH);
    check('Font Awesome (risposta opaca) finisce in cache', store.has(FA));
    check('l\'SDK Firebase finisce in cache', store.has(FB));
    check('il CSS di Google Fonts finisce in cache', store.has(GCSS));
    check('i file dei font finiscono in cache', store.has(WOFF));
    check('Firestore resta fuori dalla cache', !store.has(FS));
    check('l\'autenticazione resta fuori dalla cache', !store.has(AUTH));

    net = async () => { throw new Error('offline'); };
    const offFA = await dispatch(FA), offFB = await dispatch(FB);
    check('offline: icone e SDK arrivano dalla cache', offFA?.tag === 'v1' && offFB?.tag === 'v1');
    const offFS = await dispatch(FS);
    check('offline: Firestore riceve un 503, non una copia vecchia', offFS?.status === 503);

    // stale-while-revalidate: si serve la copia, intanto la si aggiorna
    net = async () => opaque('v2');
    const stale = await dispatch(FA);
    check('si serve subito la copia in cache', stale?.tag === 'v1');
    check('...e intanto la cache si aggiorna', store.get(FA)?.tag === 'v2');

    const other = 'https://www.gstatic.com/qualcosaltro.js';
    net = async () => opaque('x');
    await dispatch(other);
    check('su gstatic solo /firebasejs/ e\' considerato fisso', !store.has(other));
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
      .then(seasonRatingTest)
      .then(searchSectionsTest)
      .then(serviceWorkerTest)
      .then(report, (e) => { check('test dinamici completati', false, e.message); report(); });
  }
  return seedBootTest().then(seasonRatingTest).then(searchSectionsTest).then(serviceWorkerTest)
    .then(report, (e) => { check('test dinamici completati', false, e.message); report(); });
}

function report() {
  console.log(results.join('\n'));
  console.log(`\n${pass} passati, ${fail} falliti su ${pass + fail}`);
  process.exit(fail ? 1 : 0);
}

if (!jsdomOk) report();
