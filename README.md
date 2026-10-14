# tv-series

Libreria e gestore di serie TV. App web statica (PWA), senza build: si apre
`index.html` e funziona.

## Funzioni

- **Riprendi da qui**: le serie in corso con il prossimo episodio e un pulsante per segnarlo visto
- Categorie riordinabili con drag & drop, vista griglia o lista con filtri e ordinamento
- Voto per cast, trama, ambientazione, colonna sonora e coinvolgimento, con media e confronto con TMDB
- **Voto per stagione**: gli stessi cinque assi, stagione per stagione, facoltativi e separati dal voto della serie
- Scheda dettagli con trailer, cast, trama, stagioni e disponibilità streaming
- Calendario delle prossime uscite
- **Notifiche personalizzate**, anche ad app chiusa (Android, app installata): episodi in uscita (debutti, ritorni e finali con un testo proprio, "sei in pari" o "ti mancano N episodi"), "L'hai visto?" con il pulsante per segnarlo, nuove stagioni e date di debutto, serie concluse o cancellate, episodi da recuperare, riepilogo della settimana, numero sull'icona dell'app. Si regolano da ⋮ > Notifiche, con anteprima dal vivo sulle tue serie
- Tempo di visione, diario di visione, avanzamento episodio per episodio con checklist per stagione
- **Statistiche**: tempo visto, rimasto e in lista d'attesa (rewatch a parte), stato delle serie su TMDB, distribuzione dei voti, confronto con TMDB, generi e reti con voto medio, decenni, diario mensile, categorie
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
| `sw.js` | Service worker (offline, cache, notifiche ad app chiusa) |
| `notify-core.js` | Motore delle notifiche, condiviso: lo caricano sia `index.html` sia `sw.js` |
| `badge-96.png` | Icona monocromatica della barra di stato Android per le notifiche |
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

## Caricare le modifiche dal browser

"Add file > Upload files" di GitHub perde le cartelle se si selezionano i
singoli file: `tests/run.js` finisce alla radice come `run.js` e `npm test`
smette di funzionare (e' successo fino alla v15). Per i file dentro una
cartella si trascina la cartella intera nella pagina di upload, oppure si usa
"Create new file" scrivendo il percorso completo (`tests/run.js`). Un test di
struttura se ne accorge.

## Notifiche

Il motore sta in `notify-core.js` ed e' **lo stesso file** per la pagina (che
lo carica con un `<script>` prima di `app.js` e lo trova come `window.TVNotify`)
e per il service worker (`importScripts`). Pagina aperta e controllo in
background decidono quindi allo stesso modo, con gli stessi testi.

| Tipo | Quando | Per quali serie |
|---|---|---|
| Episodio in uscita | il giorno dell'uscita; debutto, ritorno e finale di stagione hanno un testo proprio | Sto guardando e categorie "viste"; da Da vedere solo i debutti (episodio 1) |
| L'hai visto? | dal giorno dopo l'uscita (entro 7 giorni) del **tuo** prossimo episodio, se non hai segnato nulla da allora | Sto guardando |
| Nuova stagione | quando su TMDB compare una stagione nuova o ne viene fissata la data | tutte tranne Da vedere |
| Fine o cancellazione | quando lo stato TMDB passa a concluso o cancellato | tutte tranne Da vedere |
| Episodi da recuperare | una volta a settimana, se resti indietro e non segni nulla da 7 giorni | Sto guardando |
| La tua settimana | lunedi' (o martedi'), uscite dei 7 giorni successivi | come gli episodi |

Oltre quattro avvisi in un colpo solo (primo avvio, telefono spento per giorni)
i restanti diventano una notifica di riepilogo. "Silenzia serie" dalla notifica
la toglie da tutti gli avvisi; si riattiva dal pannello.

**Ad app chiusa.** Il service worker ascolta l'evento `periodicsync`: Chrome lo
concede solo all'app **installata** e decide da se' la frequenza (di solito ogni
12-24 ore, in base a quanto la usi). Il giro interroga TMDB per le serie da
controllare (al massimo 80, prima quelle in corso), salta se l'app e' aperta e
visibile e rispetta il silenzio notturno (23-8). **Su iPhone/iPad e su Firefox
questo evento non esiste**: gli avvisi arrivano quando apri l'app. Per averli
anche li' ad app chiusa serve un server push (`functions/index.js`, piano Blaze):
il service worker ha gia' il gestore `push`, con la stessa veste grafica.

**Stato.** Preferenze, fotografia compatta della libreria (titolo, id TMDB,
tipo, ultimo episodio visto, ora dell'ultima spunta), stagioni gia' viste e
registro degli avvisi stanno nella cache `tvtracker-notify` (Cache Storage),
non in localStorage: il service worker localStorage non lo vede, e il registro
deve essere uno solo, altrimenti lo stesso episodio arriverebbe due volte. Ogni
scrittura rilegge lo stato (`TVNotify.updateState`). Il cambio di `VERSION` non
cancella questa cache. Sono impostazioni del dispositivo, come la vista griglia
o lista: non entrano nel backup. L'unico campo nuovo nei dati sincronizzati e'
`watchData[titolo].lastMarkedAt`, scritto da `markEpisode`/`markSeason`.

**Azioni.** "✓ Visto" e "Apri la scheda" portano in primo piano l'app (messaggio
`tvtracker-notify` dal service worker) o la aprono con `?tvn=mark|open&t=...`;
l'app esegue l'azione e ripulisce l'indirizzo. "Silenzia serie" e "Non ancora"
si risolvono nel service worker senza aprire nulla.

**Aspetto.** Titolo con emoji per tipo, locandina come icona, fotogramma
dell'episodio (o il backdrop della serie) come immagine grande, `badge-96.png`
nella barra di stato. Su iPhone immagine e pulsanti non vengono mostrati.

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
- **`data/Samuele-data.json` e' la vetrina pubblica**: viene servito da GitHub
  Pages e contiene anche voti e diario (e' un backup completo). Chiunque apra il
  sito senza accedere vede quella libreria; chi crea un account parte comunque
  vuoto. Tutto cio' che ci metti dentro, date di visione comprese, e' leggibile
  da chiunque.
- **La vetrina si aggiorna da sola** (v16). Quando lo scomparto ospite viene
  riempito dal file, `markSeedApplied()` salva in `tvtracker:guest:seed`
  l'impronta del file e quella del contenuto. All'avvio
  `refreshGuestSeedIfPristine()` riscarica il file: se l'ospite non ha toccato
  nulla e il file e' cambiato, passa alla versione nuova. Se l'ospite ha
  modificato anche solo un voto, la sua copia vince. Le copie di prima della
  v16 non hanno il timbro e non vengono toccate: per agganciarle basta un Reset.

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
una di quelle librerie (font e icone in `index.html`, l'SDK Firebase in
`FIREBASE_SDK_VERSION` dentro `app.js`), l'URL nuovo viene salvato da solo; il
vecchio sparisce al successivo `VERSION`.

**Avvio e dati aggiornati (v17).** Tre regole, ognuna nata da un caso concreto
di "il sito ci mette tanto a mostrare gli episodi nuovi":

- **Si disegna sempre prima dai dati locali.** L'SDK Firebase non e' piu' un
  `<script>` sincrono nell'`<head>`: lo carica `loadFirebaseSdk()` dopo il primo
  `render()`. La pagina si apre nell'ultimo scomparto usato (`initialScope()`,
  chiave `tvtracker-last-scope`), purche' abbia dati su questo browser, cosi'
  chi usa un account non vede prima la libreria dell'ospite. Un account gia'
  sincronizzato qui non fa la `get()` di controllo prima dei listener.
- **La cache dei dettagli TMDB e' stale-while-revalidate.** Ogni voce ha l'ora
  di download vera (`detailsFetchedAt`), non riscritta a ogni salvataggio. Al
  caricamento si usano tutte, anche vecchie; `refreshStaleDetails()` riscarica
  in background quelle scadute secondo `detailsMaxAge()` (2 ore per le serie in
  "Sto guardando", 24 per quelle in onda, 14 giorni per le finite; sempre se il
  "prossimo episodio" e' gia' uscito), prima le serie in corso e quelle con un
  episodio in calendario. Parte all'avvio, al ritorno in primo piano e ogni ora.
  **Ogni dato TMDB entra in cache da `storeDetails()`**, che decide se e'
  cambiato qualcosa di visibile (`detailsVersion`): e' quello che fa ridisegnare.
- **Ridisegni non richiesti dall'utente passano da `scheduleRender()`**
  (snapshot Firestore, dettagli arrivati), che li raggruppa. I gesti
  dell'utente chiamano `render()` direttamente.

**Timestamp della libreria.** `saveData()` alza `localDataTimestamp` ed e' per
le modifiche dell'utente. I campi che l'app ricava da sola (id, tag, tipo di
categoria, tmdbId, seasons_count, locandina) si salvano con `saveDerivedData()`,
che **non** lo alza: altrimenti il solo riempimento all'avvio rende il locale
"piu' recente" del cloud e lo snapshot con le modifiche fatte sul telefono viene
scartato. Quando uno snapshot e' piu' vecchio del locale e diverso, il locale
viene rimandato su (era una modifica che non era mai arrivata al cloud).

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

`tests/run.js` esegue 386 controlli in ventitre gruppi: ambito dei dati per
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
e cosa arriva offline, non solo che il codice contenga certe righe. Il gruppo 12
apre il sito con una cache dei dettagli di due giorni prima e controlla che
"Riprendi da qui" compaia subito, si aggiorni da solo quando TMDB risponde e che
gli episodi segnati su un altro dispositivo ridisegnino la pagina.
I gruppi 13-13d fanno girare il motore delle notifiche in una sandbox (testi
per debutti, ritorni e finali, "L'hai visto?", fotografia delle stagioni,
silenzio notturno, riepilogo oltre quattro avvisi, registro condiviso in una
Cache Storage finta, click e giro in background), poi la pagina vera in jsdom
con un service worker finto (vecchio registro migrato, "✓ Visto" che segna
l'episodio, pannello e interruttori) e infine `sw.js` con `importScripts`.

Un controllo fallisce di proposito finche' non si decide: le pagine legali hanno
ancora i segnaposto del titolare. (Dalla v16 il file pubblico
`data/Samuele-data.json` puo' contenere voti e diario per scelta, e il test
relativo verifica solo il formato.)

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
- **Notifiche ad app chiusa su iPhone.** Su Android (app installata) arrivano
  dal service worker con `periodicsync`; su iOS quell'evento non esiste e serve
  un server push. `functions/index.js` e' lo scheletro, **non collegato**: vedi
  il commento in testa al file per cosa manca.
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
