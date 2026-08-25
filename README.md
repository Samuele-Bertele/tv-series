# tv-series

Libreria e gestore di serie TV. App web statica (PWA), senza build: si apre
`index.html` e funziona.

## Funzioni

- Categorie riordinabili con drag & drop, vista griglia o lista con filtri e ordinamento
- Voto per cast, trama, ambientazione, colonna sonora e coinvolgimento, con media e confronto con TMDB
- Calendario delle prossime uscite e notifiche degli episodi in onda oggi
- Tempo di visione, diario di visione, avanzamento episodi, disponibilità streaming
- Consigli personalizzati in base ai generi più votati
- Sincronizzazione via Firestore, con funzionamento offline
- Importazione, esportazione e condivisione della lista

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
