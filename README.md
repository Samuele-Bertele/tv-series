# tv-series

Libreria e gestore di serie TV. App web statica (PWA), senza build: si apre
`index.html` e funziona.

## Funzioni

- **Riprendi da qui**: le serie in corso con il prossimo episodio e un pulsante per segnarlo visto
- Categorie riordinabili con drag & drop, vista griglia o lista con filtri e ordinamento
- Voto per cast, trama, ambientazione, colonna sonora e coinvolgimento, con media e confronto con TMDB
- Scheda dettagli con trailer, cast, trama, stagioni e disponibilità streaming
- Calendario delle prossime uscite e notifiche degli episodi in onda oggi
- Tempo di visione, diario di visione, avanzamento episodi
- Ricerca per titolo (tollerante ai refusi) e per genere
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

## Sicurezza — da sistemare

**Regole Firestore.** L'app scrive su Firestore senza autenticarsi. Se il
progetto è ancora in modalità test, il database è di fatto aperto a chiunque
conosca il project id, che è pubblico perché sta in `app.js`. In
`firestore.rules` ci sono due opzioni: una applicabile subito senza toccare il
codice, e quella consigliata con autenticazione anonima. Applicale con:

```bash
firebase deploy --only firestore:rules
```

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
altrimenti il backup torna a essere parziale.

## Test

Tre smoke test in jsdom (`smoke1/2/3.mjs`, 122 verifiche). Non sono nel repo:
richiedono `npm install jsdom`. Coprono render, persistenza, menu flottante,
undo, export/import nei due formati, ricerca per genere, trailer e cast.

## Debito tecnico noto

- **Indicizzazione per titolo.** Voti, date, diario e cache sono tutti indicizzati
  sul titolo della serie. Da qui la migrazione manuale quando si rinomina una
  serie e i controlli che impediscono titoli duplicati nella stessa categoria. Un
  `id` stabile su ogni serie eliminerebbe l'intera classe di problemi.
- **Semantica delle categorie basata sul nome.** Il comportamento dipende da
  `includes('sto guardando')`, `'da vedere'`, `'da vedere in futuro'`: rinominare
  una categoria ne cambia il funzionamento senza avvisare. Servirebbe un campo
  `type` sulla categoria.
- **Render completo ad ogni modifica.** `doRender` ricostruisce tutto il DOM,
  listener compresi, anche per cambiare un singolo valore. Con librerie grandi
  conviene passare alla delega degli eventi su `categoriesContainer`.
- **Stampa.** Il pulsante "Stampa lista" apre la lista in una nuova scheda ma non
  avvia la stampa. Servirebbe `win.print()` o un vero foglio `@media print`.
- **Voti e diario orfani.** Eliminando una serie, `ratingsData[titolo]` e
  `watchData[titolo]` restano in localStorage e su Firestore per sempre. È voluto
  (riaggiungendo la serie ritrovi il voto) ma non c'è modo di vederli né di
  ripulirli, quindi crescono in silenzio.
- **Chiave TMDB e regole Firestore.** Vedi la sezione Sicurezza qui sopra:
  entrambe sono ancora da sistemare.
