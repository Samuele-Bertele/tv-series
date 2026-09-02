# tv-series

Libreria e gestore di serie TV. App web statica (PWA), senza build: si apre
`index.html` e funziona.

## Funzioni

- **Riprendi da qui**: le serie in corso con il prossimo episodio e un pulsante per segnarlo visto
- Categorie riordinabili con drag & drop, vista griglia o lista con filtri e ordinamento
- Voto per cast, trama, ambientazione, colonna sonora e coinvolgimento, con media e confronto con TMDB
- Scheda dettagli con trailer, cast, trama, stagioni e disponibilità streaming
- Calendario delle prossime uscite e notifiche degli episodi in onda oggi
- Tempo di visione, diario di visione, avanzamento episodio per episodio con checklist per stagione
- **Account**: accesso anonimo o con Google; ogni utente ha la propria libreria sincronizzata
- **Ricerca globale TMDB**: cerca una serie in tutto il catalogo e scegli in quale categoria aggiungerla
- **Tag** liberi per serie, con filtro nella vista lista e ricerca
- **Confronto** fianco a fianco di due serie (stagioni, episodi, voti, avanzamento, rete)
- **Esportazione ICS** delle prossime uscite, da importare in qualsiasi calendario
- Ricerca per titolo (tollerante ai refusi), per genere e per tag
- Consigli personalizzati in base ai generi più votati
- Sincronizzazione via Firestore, con funzionamento offline
- Backup completo (elenco + voti + diario), importazione e condivisione della lista
- Annullamento delle eliminazioni entro 8 secondi

## Struttura dei file

| File | Contenuto |
|---|---|
| `index.html` | Solo il markup |
| `styles.css` | Tutti gli stili |
| `app.js` | Tutta la logica |
| `sw.js` | Service worker (offline e cache) |
| `manifest.json` | Manifest PWA |
| `data/default-data.json` | Elenco iniziale, usato al primo avvio e dal Reset |
| `firestore.rules` | Regole di sicurezza Firestore (**da applicare**, vedi sotto) |
| `makeicons.py` | Rigenera le icone PWA dai PNG sorgente |

CSS e JS stanno in file separati perché il service worker serve l'HTML
network-first: tenendo tutto in un unico file, ogni visita riscaricava circa
240 KB. Ora si riscarica solo il markup, mentre stili e codice arrivano dalla
cache finché non cambia `VERSION` in `sw.js`. **Dopo ogni modifica a
`styles.css` o `app.js` va incrementato `VERSION`**, altrimenti i client
continuano a usare la versione in cache.

## Uso in locale

Il service worker e `fetch()` su `data/default-data.json` richiedono http, non
`file://`:

```bash
python3 -m http.server 8000
# poi apri http://localhost:8000
```

## Account e sincronizzazione

Ogni utente ha la propria libreria sotto `users/{uid}/tvtracker/{shows,ratings,watchdata}`.

- **Senza accesso** l'app continua a sincronizzare sull'archivio condiviso
  `/tvtracker/{shows,ratings,watchdata}`, cioè come funzionava prima che gli
  account esistessero. È un ripiego temporaneo, governato dalla costante
  `LEGACY_SHARED_SYNC` in `app.js`: quei documenti sono scrivibili senza
  autenticazione da chiunque conosca il project id, che è pubblico perché sta
  in `app.js`. Appena l'accesso funziona su tutti i dispositivi, metti la
  costante a `false` e togli il permesso di scrittura su `/tvtracker` in
  `firestore.rules`. Il badge in alto mostra **Condiviso** invece di
  **Sincronizzato** proprio per ricordarlo.
- **Accesso anonimo**: legato al singolo browser. Comodo, ma se esci non c'è
  modo di rientrare in quel profilo — l'app te lo chiede prima di procedere.
- **Accesso Google**: se eri già entrato come anonimo, l'account viene
  *collegato* (`linkWithPopup`) invece di crearne uno nuovo, così la libreria
  costruita da ospite non resta orfana.
- **Primo accesso**: se i documenti dell'utente non esistono, `seedUserDocsIfEmpty()`
  li crea partendo dai dati locali, oppure dai vecchi documenti condivisi
  `/tvtracker/*` se contengono più serie.

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

**Token del tema.** I componenti non scrivono mai un colore di superficie a mano:
usano `--panel` (barra, modali, side nav), `--pop` (menu e dropdown sovrapposti),
`--surface` (riquadri interni), `--input-*` (campi). Il tema chiaro si limita a
ridefinire quei token. Se aggiungi un componente e gli dai un fondo esadecimale
fisso, sul tema chiaro resterà scuro: usa i token.

**Menu a tendina.** Ogni menu passa da `openFloatingMenu(pulsante, voci)`. Il
pannello viene creato in `<body>` con `position: fixed` apposta: `.top-bar` ha
`overflow: hidden`, e le card applicano una `transform` al passaggio del mouse,
che crea un contesto di impilamento. Un pannello annidato verrebbe tagliato dal
primo e coperto dal secondo. Non reintrodurre dropdown figli della card.

**Backup.** `exportToFile` scrive `{version, data, ratings, watch}`. Se aggiungi
un quarto store da qualche parte, va aggiunto anche lì e in `normalizeImport`,
altrimenti il backup torna a essere parziale. Tag (`show.tags`) e checklist
episodi (`watchData[titolo].watchedEpisodes`) vivono dentro store già esportati,
quindi non richiedono nulla di nuovo.

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

Smoke test in jsdom, non versionati (richiedono `npm install jsdom`). Coprono
render, persistenza, menu flottante, undo, export/import nei due formati,
ricerca per genere, trailer e cast, più: schema e recupero dati, checklist
episodi, conformità del file ICS, tag, confronto e ricerca globale.

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
- **Colore dominante delle locandine.** Il CDN di TMDB serve
  `Access-Control-Allow-Origin` solo quando la richiesta porta l'header
  `Origin`; il `<img>` della card non lo manda, e la variante senza header
  finisce nella cache del CDN, dove la richiesta CORS dell'estrazione colore la
  ritrova. `app.js` riprova una volta con una query diversa per saltare quella
  voce di cache, poi si arrende e tiene il rosso di accento. Aggiungere
  `crossorigin` ai `<img>` risolverebbe alla radice, ma se per una locandina
  l'header manca davvero l'immagine non si vedrebbe più: perdere l'alone è meno
  grave che perdere la locandina.
- **Archivio condiviso scrivibile.** Vedi `LEGACY_SHARED_SYNC` nella sezione
  Account: è la scorciatoia che tiene in piedi la sincronia finché l'accesso
  non è configurato, ed è la cosa da chiudere per prima.
- **Stampa.** Il pulsante "Stampa lista" apre la lista in una nuova scheda ma non
  avvia la stampa. Servirebbe `win.print()` o un vero foglio `@media print`.
- **Voti e diario orfani.** Eliminando una serie, `ratingsData[titolo]` e
  `watchData[titolo]` restano in localStorage e su Firestore per sempre. È voluto
  (riaggiungendo la serie ritrovi il voto) ma non c'è modo di vederli né di
  ripulirli, quindi crescono in silenzio.
- **Chiave TMDB e regole Firestore.** Vedi la sezione Sicurezza qui sopra:
  entrambe sono ancora da sistemare.
