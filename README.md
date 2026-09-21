# tv-series

Libreria e gestore di serie TV. App web statica (PWA), senza build: si apre
`index.html` e funziona.

## Funzioni

- **Riprendi da qui**: le serie in corso con il prossimo episodio e un pulsante per segnarlo visto
- Categorie riordinabili con drag & drop, vista griglia o lista con filtri e ordinamento
- Voto per cast, trama, ambientazione, colonna sonora e coinvolgimento, con media e confronto con TMDB
- **Voto per stagione**: gli stessi cinque assi, stagione per stagione, facoltativi e separati dal voto della serie
- Scheda dettagli con trailer, cast, trama, stagioni e disponibilità streaming
- Calendario delle prossime uscite e notifiche degli episodi in onda oggi
- Tempo di visione, diario di visione, avanzamento episodio per episodio con checklist per stagione
- **Account**: da ospite i dati restano su questo dispositivo; con l'accesso (anonimo o Google) la libreria si sincronizza
- **Ricerca unificata**: un solo campo filtra la libreria e, da 3 caratteri, propone sotto le serie TMDB che non hai ancora
- **Tag** liberi per serie, con filtro nella vista lista e ricerca
- **Confronto** fianco a fianco di due serie (stagioni, episodi, voti, avanzamento, rete)
- **Esportazione ICS** delle prossime uscite, da importare in qualsiasi calendario
- Ricerca per titolo (tollerante ai refusi), per genere e per tag
- Consigli personalizzati in base ai generi più votati
- Sincronizzazione via Firestore, con funzionamento offline
- Backup completo (elenco + voti + diario), importazione e condivisione della lista
- Stampa della lista impaginata su carta, con dialogo di stampa automatico
- Annullamento delle eliminazioni entro 8 secondi

## Struttura dei file

| File | Contenuto |
|---|---|
| `index.html` | Solo il markup |
| `styles.css` | Tutti gli stili |
| `app.js` | Tutta la logica |
| `sw.js` | Service worker (offline e cache) |
| `manifest.json` | Manifest PWA |
| `data/default-data.json` | Categorie **vuote**: punto di partenza dei nuovi account e del Reset fatto da dentro un account |
| `data/Samuele-data.json` | Libreria di partenza dello scomparto **ospite** (formato backup v2): primo avvio e Reset da ospite |
| `firestore.rules` | Regole di sicurezza Firestore (**da applicare**, vedi sotto) |
| `functions/index.js` | Cloud Function per le notifiche (**non collegata**, vedi il commento in testa) |
| `tests/run.js` | Smoke test: `npm install && npm test` |
| `makeicons.py` | Rigenera le icone PWA dai PNG sorgente |

CSS e JS stanno in file separati perché il service worker serve l'HTML
network-first: tenendo tutto in un unico file, ogni visita riscaricava circa
240 KB. Ora si riscarica solo il markup, mentre stili e codice arrivano dalla
cache finché non cambia `VERSION` in `sw.js`. **Dopo ogni modifica a
`styles.css` o `app.js` va incrementato `VERSION`**, altrimenti i client
continuano a usare la versione in cache.

## Uso in locale

Il service worker e le `fetch()` sui file in `data/` richiedono http, non
`file://`:

```bash
python3 -m http.server 8000
# poi apri http://localhost:8000
```

## Account e sincronizzazione

L'app ha **due stati e due soli**, e lo dice in chiaro sia nell'etichetta accanto
all'icona utente sia nel badge in alto:

| Stato | Dove stanno i dati | Badge |
|---|---|---|
| **Ospite** (nessun accesso) | Solo in questo browser. Firestore non viene toccato. | Solo questo dispositivo |
| **Accesso** (anonimo o Google) | `users/{uid}/tvtracker/{shows,ratings,watchdata}` | Sincronizzato |

- **Accesso anonimo**: sincronizza, ma e' legato al singolo browser. Se esci non
  c'e' modo di rientrare in quel profilo — l'app te lo chiede prima di procedere.
- **Accesso Google**: se eri gia' entrato come anonimo, l'account viene
  *collegato* (`linkWithPopup`) invece di crearne uno nuovo. Se quel Google e'
  gia' legato a un altro profilo l'app te lo dice e chiede conferma, invece di
  cambiare account in silenzio lasciando indietro la libreria dell'anonimo.
  Se il popup e' bloccato (tipico nella PWA installata su iOS) si passa
  automaticamente a `signInWithRedirect`.
- **Primo accesso**: `createEmptyUserDocs()` crea i documenti **vuoti**, con le
  sole categorie di `data/default-data.json`. Un account nuovo non eredita
  nulla, nemmeno dall'ospite. Per portarci una lista si usano *Esporta backup*
  prima e *Importa backup* dopo, che sono azioni esplicite.
- **Eliminazione**: dalla modale Account si possono cancellare i tre documenti e
  l'account stesso. La copia locale del dispositivo non viene toccata.

### Libreria di partenza: due file, due significati

Ospite e account non partono dallo stesso posto, e il Reset segue la stessa
regola:

| Scomparto | Primo avvio e Reset | File |
|---|---|---|
| **Ospite** | Ripristina la libreria personale | `data/Samuele-data.json` |
| **Account** | Riparte vuoto | `data/default-data.json` |

Il motivo e' che i due scomparti non hanno lo stesso proprietario. Quello ospite
e' questo browser e basta: la sua libreria di riferimento e' quella versionata
nel repo, e "riparti da capo" vuol dire tornare li'. Un account e' di chi ci ha
fatto accesso: ripopolarlo con la lista di un altro sarebbe il bug corretto in
v9, quando `default-data.json` era una libreria vera e chiunque premesse Reset
si ritrovava in casa l'elenco del proprietario.

A deciderlo e' sempre `storeScope`, in `loadStartingLibrary()` e in
`resetData()`, mai il punto in cui la funzione viene chiamata. `GUEST_SEED_URL`
compare in un solo posto, dentro `loadGuestSeed()`.

Due dettagli che vale la pena non dimenticare:

- **Voti e diario del file sono additivi.** `mergeSeedSideStores()` aggiunge solo
  le chiavi che in questo browser non ci sono gia': un ripristino non cancella
  mai un voto messo dopo.
- **`data/Samuele-data.json` e' pubblico** quanto il resto del sito: viene
  servito da GitHub Pages. Ci vanno titoli e avanzamento, non voti ne' diario —
  c'e' uno smoke test che lo verifica.

### Scomparti per identita' (importante)

Ogni identita' ha il suo scomparto in localStorage:
`tvtracker:{uid|guest}:{data,ratings,watchdata,data-ts,ratings-ts,watchdata-ts}`.
Il passaggio da uno all'altro avviene in `applyScope()`, che va chiamata
**prima** di attaccare i listener Firestore e che **azzera i timestamp**.

Questo non e' un dettaglio cosmetico. I listener usano `remoteTs < localTs` per
ignorare snapshot piu' vecchi di quello che si ha in locale: un confronto
sensato *dentro* una identita', distruttivo *attraverso* due. Con le chiavi
globali di prima bastava aver usato l'app da ospite di recente perche', al primo
accesso, lo snapshot dell'account venisse scartato e il primo salvataggio ne
sovrascrivesse la libreria nel cloud. Se un giorno tocchi questa zona: **il
timestamp appartiene allo scomparto, non al dispositivo.**

Le chiavi non namespaced della versione precedente vengono spostate una volta
sola dentro `guest` da `migrateLegacyStorage()`, che gira prima di ogni lettura.

### Cose rimosse di proposito

- **Tema chiaro.** Illeggibile in troppi punti (il testo dorato stava a 1.44:1
  su fondo crema). Rimosso il blocco `[data-theme="light"]`, il pulsante, lo
  script pre-paint e `THEME_KEY`. L'app è solo scura.
- **Barra sticky.** Provata e tolta: scorrendo scattava, perché il
  `backdrop-filter: blur()` su un elemento appiccicato si ridipinge a ogni
  frame di scorrimento. Non vale il prezzo.
- **Legenda dei voti.** Era una striscia sempre a schermo, poi un popover che
  non funzionava (vedi la convenzione sui menu, più sotto). Quattro pallini
  verde/arancio/rosso/rosso scuro si leggono da soli, e il dettaglio dei voti
  è già nel tooltip del badge.

### Archivio condiviso: rimosso

Fino alla v9 esisteva `LEGACY_SHARED_SYNC`: da sloggati l'app sincronizzava su
`/tvtracker/{shows,ratings,watchdata}`, tre documenti scrivibili **senza
autenticazione** da chiunque conoscesse il project id (che e' pubblico, sta in
`app.js`). Oltre al rischio ovvio, uscendo da un account la libreria privata
finiva li' dentro. E' stato tolto, insieme al blocco corrispondente in
`firestore.rules` e alla voce "Vedi lista pubblica", che aggiungeva una terza
identita' apparente a schermo. Se hai ancora documenti in `/tvtracker` o
`/public`, si cancellano a mano dalla Console.

Prima del deploy vanno fatte due cose:

```bash
firebase deploy --only firestore:rules
```

e in Console Firebase va configurata l'autenticazione:

1. **Authentication → Inizia**. Se non lo fai, l'SDK non trova nessuna
   configurazione e `signInWithPopup` fallisce con un 400 su
   `identitytoolkit.googleapis.com/v1/projects` (`CONFIGURATION_NOT_FOUND`).
2. **Sign-in method**: abilita **Anonimo** e **Google**, altrimenti si ottiene
   `auth/operation-not-allowed`.
3. **Settings → Domini autorizzati**: aggiungi il dominio da cui il sito è
   servito (per GitHub Pages, `<utente>.github.io`), altrimenti
   `auth/unauthorized-domain`.

`authErrorMessage()` in `app.js` traduce questi tre casi nell'azione da fare,
così l'errore non resta solo in console.

**Chiave TMDB.** È in chiaro in `app.js`. In un'app puramente client-side
qualsiasi chiave è comunque estraibile dal browser, ma in un repo pubblico è
anche indicizzabile: il rischio concreto è che la quota venga consumata da altri
o che la chiave venga revocata. La soluzione è un piccolo proxy (Netlify o
Cloudflare Functions) che tenga la chiave lato server. Finché non c'è, è una
scelta consapevole.

## Convenzioni interne

**Scale.** Font, spazi e raggi passano da `--fs-*`, `--space-*`, `--radius-*`.
Le dimensioni del testo sono in `rem`, non in px, perche' chi ingrandisce il
carattere nel browser deve ottenere qualcosa. **I campi di input non scendono
mai sotto `--fs-lg` (16px)**: sotto quella soglia Safari su iOS ingrandisce la
pagina al tocco, e nell'app installata non si torna indietro.

**Accento e oro.** Non si scrive mai `rgba(224,50,60,x)` o `rgba(212,175,55,x)`
a mano: si compone da `rgba(var(--accent-rgb), x)` e `rgba(var(--gold-rgb), x)`.
Erano 124 occorrenze sparse, che rendevano impossibile cambiare il colore del
marchio. Quando l'oro o l'accento sono colore del **testo**, si usano
`--gold-text` / `--accent-text`: sono i primi a diventare illeggibili se si
tocca la palette, e averli separati vuol dire un punto solo da correggere.

**Palette: due famiglie, non sette.** Fino alla v14 su una schermata si
vedevano rosso del marchio, oro delle epopee, azzurro delle uscite, viola dei
consigli e i quattro colori degli anelli voto. Ora: il **rosso** e' marchio e
azione (e l'episodio di oggi, l'unica riga delle uscite su cui si agisce),
l'**oro** e' delle epopee e dei voti, i quattro colori degli anelli restano
perche' sono dati, non decorazione. `--info-*` e `--rec-*` esistono ancora ma
sono grigi quasi neutri: la gerarchia di uscite e consigli la fanno tipografia e
spazio. Un test controlla che restino neutri (scarto R/G/B <= 28), non il valore
esatto: se un giorno si vuole ricolorare, il test dice perche' era stato tolto.

**Una sola filettatura.** La riga-gradiente in cima esiste solo su `.top-bar`.
Era anche su epopee, uscite, consigli, card delle statistiche e card leggenda:
lo stesso accento sei volte e' una cornice, non un accento.

**Oro come colore del testo.** Si usano `--gold-text` o `--gold-text-soft`,
**mai** `rgba(var(--gold-rgb), x)`: l'alpha spegne anche il contrasto, e a
10-12px sette regole mancavano la soglia AA (il caso peggiore a 2,40:1). Con
l'alpha si fanno bordi, sfondi e sfumature.

**Token delle superfici.** I componenti non scrivono mai un colore di superficie
a mano: usano `--panel` (barra, modali, side nav), `--pop` (menu e dropdown
sovrapposti), `--surface` (riquadri interni), `--input-*` (campi). **Il tema
chiaro non esiste più**: era illeggibile in troppi punti e è stato rimosso
insieme al pulsante di cambio tema e allo script pre-paint nell'`<head>`.
I token restano perché sono quello che tiene coerenti barra, modali, menu e
riquadri fra loro, e sono l'unico punto da toccare per ritoccare la palette.

**Menu a tendina.** Ogni menu passa da `openFloatingMenu(pulsante, voci)`. Il
pannello viene creato in `<body>` con `position: fixed` apposta: `.top-bar` ha
`overflow: hidden`, e le card applicano una `transform` al passaggio del mouse,
che crea un contesto di impilamento. Un pannello annidato verrebbe tagliato dal
primo e coperto dal secondo. **Non reintrodurre pannelli figli della card né
della barra**: la legenda dei voti a comparsa è stata provata proprio così ed è
finita esattamente in quel modo — al click non si vedeva niente, perché
`.top-bar { overflow: hidden }` la tagliava. Se ti serve un pannello, passa da
`openFloatingMenu`, che lo monta in `<body>` con `position: fixed`.

**Voto per stagione.** Vive in `ratingsData[titolo].seasons = { "1": {...5 assi,
average, savedAt}, ... }`, cioe' dentro uno store che esiste gia': backup,
import e Firestore lo portano con se' senza modifiche. Tre regole:

- **Il voto della serie si legge solo con `ratingOf(titolo)`**, e i titoli
  valutati solo con `ratedTitles()`. Una voce puo' avere le sole `seasons` (chi
  vota la stagione 3 di una serie mai valutata) e allora `average` non c'e':
  leggerla direttamente porta a `undefined.toFixed()` dentro `doRender`, cioe' a
  schermo bianco. C'e' un test che simula esattamente questo.
- **Le stagioni non entrano nella media della serie.** Anelli, statistiche,
  consigli e confronto leggono il voto della serie e basta.
- **Una sola stagione = nessun voto per stagione.** Per una miniserie "la
  stagione 1" e "la serie" sono lo stesso oggetto: il selettore compare da due
  stagioni in su.

L'import in modalita' *unisci* riempie anche i buchi **dentro** la voce: una
stagione che in locale manca arriva dal file, una che c'e' non si tocca.

**Ricerca.** Una sola regola per ogni card, `searchHit()`: titolo (fuzzy),
poi genere, poi tag. Oltre alle categorie la seguono le sezioni costruite dalla
libreria — Riprendi da qui, Prossime uscite, Epopee — elencate in
`SEARCH_SECTIONS`: si filtrano card per card e spariscono se non resta nulla.
I consigli no: non sono libreria, durante una ricerca si nascondono. Se aggiungi
una sezione fatta di serie della libreria, va aggiunta li', e le sue card devono
portare `searchAttrs(show)`.
Nel fuzzy le parole di una o due lettere del titolo non contano come
"contenute" nella parola cercata: prima "crime" trovava "I Simpson" (per la
"i") e "pilota" trovava "Il trono di spade".

**Service worker e terze parti.** Font, Font Awesome e SDK Firebase passano da
`isPinnedAsset()`, in stale-while-revalidate, **risposte opache comprese**: si
caricano con `<link>`/`<script>` senza `crossorigin`, quindi arrivano come
risposte opache con `res.ok === false`, e fino alla v14 nessuna veniva salvata.
Non si aggiunge `crossorigin` ai tag per lo stesso motivo delle locandine: se
una CDN smettesse di mandare l'header CORS, la risorsa sparirebbe del tutto.
Firestore e l'autenticazione restano fuori dalla cache. Se cambi la versione di
una di quelle librerie in `index.html`, l'URL nuovo viene salvato da solo; il
vecchio sparisce al successivo `VERSION`.

**Backup.** `exportToFile` scrive `{version, data, ratings, watch}`. Se aggiungi
un quarto store da qualche parte, va aggiunto anche lì e in `normalizeImport`,
altrimenti il backup torna a essere parziale. Tag (`show.tags`), checklist
episodi (`watchData[titolo].watchedEpisodes`) e voti per stagione
(`ratingsData[titolo].seasons`) vivono dentro store già esportati, quindi non
richiedono nulla di nuovo.

**Schema dei dati.** `ensureSchema()` è idempotente e va chiamata ogni volta che
`data` arriva da fuori: all'avvio, dopo un'importazione e dopo uno snapshot
Firestore. Assegna `id` alle serie, `type` alle categorie e inizializza `tags`,
senza scartare campi sconosciuti. **Non ri-chiavia `ratingsData` e `watchData`**:
quei due store restano indicizzati per titolo, come li legge tutto il resto
dell'app. Se un giorno si passa agli id, va fatto in un colpo solo su tutti i
punti di lettura, non a metà.

**Indicizzazione degli store.** `ratingsData`, `watchData` e `showDetailsCache`
sono indicizzati **per titolo**. `show.id` esiste ma serve ad altro: confronto
fra serie, UID stabili nel file `.ics`, identificazione della card nel DOM.
Non mescolare le due cose.

**Avanzamento episodi.** La fonte di verità è `watchData[titolo].watchedEpisodes`,
un array di chiavi `"stagionexEpisodio"`. `currentSeason`/`currentEpisode`
restano scritti e allineati perché li usano "Riprendi da qui", la mini barra
sulla card e le notifiche. Quando confronti due chiavi, usa `lastWatchedEpisode()`:
l'ordinamento lessicografico mette `"10x1"` prima di `"2x1"`.

## Test

```bash
npm install
npm test
```

`tests/run.js` esegue 225 controlli in sedici gruppi: ambito dei dati per
identita', guardie di sincronizzazione, autenticazione, regole Firestore,
ricerca unificata, design system (nessun colore scritto a mano fuori da
`:root`, famiglie informazione/consigli neutre, nessun testo dorato con alpha,
nessuna classe CSS morta), gerarchia e semantica (`<header>`, `<h1>`, `<main>`,
intestazioni di categoria come `<h2><button>`), struttura del progetto,
conformita' legale, libreria di partenza, voto per stagione. In jsdom: un
accesso partendo da una libreria ospite piu' recente, il primo avvio da ospite
il flusso completo del voto per stagione (modale, selettore, salvataggi,
render di una voce senza voto della serie, import in unione), la ricerca sulle
sezioni fisse e la deduplica dei consigli. Il service worker viene eseguito in
una sandbox `vm` con `caches` e `fetch` finti: si verifica cosa finisce in cache
e cosa arriva offline, non solo che il codice contenga certe righe.

Due controlli falliscono di proposito finche' non si decide: il file pubblico
`data/Samuele-data.json` contiene voti e diario, e le pagine legali hanno ancora
i segnaposto del titolare.

**Dove stanno i file.** `run.js` va in `tests/`, `index.js` della Cloud
Function in `functions/`: `package.json` e il test stesso si aspettano quei
percorsi. Nella v14 erano finiti tutti e due nella radice — probabilmente
caricando i file uno per uno — e `npm test` non partiva piu'. Nel frattempo una
modifica a mano aveva tolto una virgola a `Samuele-data.json`: il primo avvio
ripiegava in silenzio sulle categorie vuote, e il test che l'avrebbe detto non
girava.

## Debito tecnico noto

- **Indicizzazione per titolo.** Voti, date, diario e cache restano indicizzati
  sul titolo della serie. Da qui la migrazione manuale quando si rinomina una
  serie e i controlli che impediscono titoli duplicati nella stessa categoria.
  `show.id` ora esiste ed è stabile: il passaggio è possibile, ma va fatto in
  un'unica volta su tutti i punti di lettura — farlo a metà rende voti e diario
  invisibili pur restando salvati.
- **Semantica delle categorie.** `cat.type` esiste ed è quello che usano gli
  stati vuoti e la ricerca globale, ma viene *derivato dal nome* a ogni
  `ensureSchema()`: rinominare "Sto guardando" in "In corso" ne cambia ancora il
  comportamento. Per renderlo davvero indipendente servirebbe un selettore del
  tipo nell'interfaccia, e smettere di ricalcolarlo.
- **Render completo ad ogni modifica.** `doRender` ricostruisce tutto il DOM,
  listener compresi, anche per cambiare un singolo valore. Con librerie grandi
  conviene passare alla delega degli eventi su `categoriesContainer`. Un tentativo
  di *DOM diffing* è stato scartato: la versione proposta aggiornava solo numero,
  progresso e checkbox, lasciando indietro locandine, titoli, anelli del voto,
  tag, badge degli episodi e `data-show-idx` (da cui dipendono i menu ⋮), e la
  condizione di ricostruzione — confrontare il numero di figli — non si accorgeva
  di riordini, rinomine e nuovi voti. La checklist episodi intanto accoda il
  render esterno di 400 ms, che era il caso peggiore concreto.
- **Notifiche push reali.** `functions/index.js` esiste ma **non è collegato**:
  vedi il commento in testa al file per cosa manca.
- **Voti e diario orfani** (vedi sotto) e **chiave TMDB in chiaro** restano i due
  debiti aperti più concreti.
- **Colore dominante delle locandine.** Il CDN di TMDB serve
  `Access-Control-Allow-Origin` solo quando la richiesta porta l'header
  `Origin`; il `<img>` della card non lo manda, e la variante senza header
  finisce nella cache del CDN, dove la richiesta CORS dell'estrazione colore la
  ritrova. `app.js` riprova una volta con una query diversa per saltare quella
  voce di cache, poi si arrende e tiene il rosso di accento. Aggiungere
  `crossorigin` ai `<img>` risolverebbe alla radice, ma se per una locandina
  l'header manca davvero l'immagine non si vedrebbe più: perdere l'alone è meno
  grave che perdere la locandina.
- **Voti e diario orfani.** Eliminando una serie, `ratingsData[titolo]` e
  `watchData[titolo]` restano in localStorage e su Firestore per sempre. È voluto
  (riaggiungendo la serie ritrovi il voto) ma non c'è modo di vederli né di
  ripulirli, quindi crescono in silenzio.
- **Chiave TMDB e regole Firestore.** Vedi la sezione Sicurezza qui sopra:
  entrambe sono ancora da sistemare.

## Cosa manca ancora

Non è stato fatto in questo giro, in ordine di utilità:

- **Proxy per la chiave TMDB.** È ancora in chiaro in `app.js`. In un'app
  puramente client-side qualsiasi chiave è estraibile, ma in un repo pubblico è
  anche indicizzabile. Un Netlify/Cloudflare Function che la tenga lato server
  chiude la questione.
- **Modularizzazione di `app.js`.** Sono ~5.300 righe in un unico scope globale.
  Si può passare a moduli ES (`<script type="module">`) senza introdurre un
  build step: `state.js`, `sync.js`, `auth.js`, `tmdb.js`, `render/`, `modals/`.
- **Bump automatico di `VERSION`.** Resta manuale ed è l'unico passo che, se
  dimenticato, rompe tutto in silenzio. Basta un hook pre-commit.
- **Pulizia di voti e diario orfani.** Eliminando una serie restano in memoria
  per sempre, per scelta, ma non c'è modo di vederli né di ripulirli.
