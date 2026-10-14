// TVTRACKER — motore delle notifiche, condiviso fra pagina e service worker.
//
// Lo carica index.html con un <script> (prima di app.js) e sw.js con
// importScripts: le due copie del codice sono LO STESSO file, quindi la
// pagina aperta e il controllo in background (app chiusa) decidono allo stesso
// modo cosa notificare e con quali parole. Prima la logica stava in app.js e
// girava solo con la pagina aperta.
//
// Cosa notifica (ogni voce si spegne dalle impostazioni):
//   episode   il giorno di uscita di un episodio; premiere e finali di stagione
//             hanno un testo proprio, e per chi sta guardando la serie si dice
//             se e' in pari o quanti episodi gli mancano prima di quello
//   reminder  "L'hai visto?" il giorno dopo l'uscita del tuo prossimo episodio,
//             con il pulsante per segnarlo senza aprire la scheda
//   season    una stagione nuova annunciata su TMDB, o la data che arriva per
//             una stagione gia' annunciata
//   status    una serie che segui si e' conclusa o e' stata cancellata
//   backlog   una volta a settimana, le serie in corso su cui sei rimasto indietro
//   digest    il lunedi' (o il martedi'), le uscite dei prossimi sette giorni
//
// Lo stato (preferenze, libreria compatta, cosa e' gia' stato notificato, ultime
// stagioni viste) vive in Cache Storage e non in localStorage: il service
// worker non puo' leggere localStorage, e le due meta' devono vedere lo stesso
// registro, altrimenti la stessa uscita arriverebbe due volte.
(function (root) {
  'use strict';

  const VERSION = 1;
  const STATE_CACHE = 'tvtracker-notify';
  const STATE_PATH = './__tvtracker/notify-state.json';
  const SYNC_TAG = 'tvtracker-notify';
  const TMDB_API = 'https://api.themoviedb.org/3';
  const TMDB_STILL = 'https://image.tmdb.org/t/p/w780';
  const TMDB_POSTER = 'https://image.tmdb.org/t/p/w342';
  const ICON = './icon-192.png';
  const BADGE = './badge-96.png';
  const DAY = 86400000;
  const LOG_KEEP_MS = 120 * DAY;
  const HISTORY_MAX = 30;
  // Oltre questo numero di notifiche in un colpo solo (primo avvio, telefono
  // rimasto spento tre giorni) le restanti diventano UNA notifica di riepilogo.
  const MAX_PER_RUN = 4;
  // Al massimo quante serie interroga il controllo in background a ogni giro.
  const BACKGROUND_FETCH_MAX = 80;
  const QUIET_FROM = 23;
  const QUIET_TO = 8;

  const DEFAULT_PREFS = Object.freeze({
    enabled: true,
    episodes: true,
    reminders: true,
    seasons: true,
    status: true,
    backlog: true,
    digest: true,
    badge: true,
    quiet: true,
    muted: [],
  });

  // Ordine di importanza: decide chi resta fuori quando si supera MAX_PER_RUN.
  const PRIORITY = { reminder: 0, episode: 1, season: 2, status: 3, backlog: 4, digest: 5 };
  const ENDED = new Set(['Ended', 'Canceled']);

  // ---------------------------------------------------------------- date
  const midnight = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  // "2026-03-14" come data LOCALE: new Date('2026-03-14') sarebbe UTC, e a est
  // di Greenwich il confronto con la mezzanotte locale sbaglia di un giorno.
  const parseDay = (iso) => {
    if (!iso || typeof iso !== 'string') return null;
    const d = new Date(iso + 'T00:00:00');
    return isNaN(d) ? null : d;
  };
  const dayDiff = (iso, now) => {
    const d = parseDay(iso);
    if (!d) return null;
    return Math.round((d - midnight(now)) / DAY);
  };
  const isoWeek = (now) => {
    const d = midnight(now);
    d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
    const week1 = new Date(d.getFullYear(), 0, 4);
    const n = 1 + Math.round(((d - week1) / DAY - 3 + ((week1.getDay() + 6) % 7)) / 7);
    return `${d.getFullYear()}-W${String(n).padStart(2, '0')}`;
  };
  const longDate = (iso) => {
    const d = parseDay(iso);
    return d ? d.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' }) : '';
  };
  const weekdayShort = (iso) => {
    const d = parseDay(iso);
    if (!d) return '';
    const s = d.toLocaleDateString('it-IT', { weekday: 'short' }).replace('.', '');
    return s.charAt(0).toUpperCase() + s.slice(1);
  };
  // "ieri", "lunedì", "domani", "tra 12 giorni"
  const relativeDay = (iso, now) => {
    const n = dayDiff(iso, now);
    if (n === null) return '';
    if (n === 0) return 'oggi';
    if (n === -1) return 'ieri';
    if (n === 1) return 'domani';
    if (n < -1 && n > -7) return parseDay(iso).toLocaleDateString('it-IT', { weekday: 'long' });
    if (n > 1) return `tra ${n} giorni`;
    return `${-n} giorni fa`;
  };

  // ---------------------------------------------------------------- episodi
  const epCode = (s, e) => `S${s}E${e}`;
  const quoted = (name) => {
    const n = (name || '').trim();
    // TMDB mette "Episodio 5" quando il titolo vero non c'e': non aggiunge nulla.
    if (!n || /^(episodio|episode)\s*\d+$/i.test(n)) return '';
    return ` «${n}»`;
  };
  const sortedSeasons = (d) => (Array.isArray(d?.seasons) ? d.seasons : [])
    .filter(s => s && s.season_number > 0)
    .slice()
    .sort((a, b) => a.season_number - b.season_number);

  // Il prossimo episodio da vedere, data la posizione { s, e } dell'ultimo
  // visto. Stessa regola di nextEpisodeOf in app.js.
  const nextAfter = (pos, d) => {
    if (!pos) return null;
    const seasons = sortedSeasons(d);
    if (!seasons.length) return null;
    let s = pos.s || 1;
    let e = (pos.e || 0) + 1;
    const info = seasons.find(x => x.season_number === s);
    if (info && e > (info.episode_count || 0)) {
      const next = seasons.find(x => x.season_number > s);
      if (!next) return null;
      s = next.season_number; e = 1;
    }
    if (!seasons.some(x => x.season_number === s)) return null;
    return { s, e };
  };

  // Episodi gia' usciti (fino a last_episode_to_air compreso) che vengono DOPO
  // la posizione dell'utente.
  const airedAfter = (pos, d) => {
    const la = d?.last_episode_to_air;
    if (!pos || !la?.season_number) return 0;
    let count = 0;
    for (const s of sortedSeasons(d)) {
      const n = s.season_number;
      if (n < pos.s || n > la.season_number) continue;
      const aired = n < la.season_number ? (s.episode_count || 0) : la.episode_number;
      const seen = n === pos.s ? (pos.e || 0) : 0;
      count += Math.max(0, aired - seen);
    }
    return count;
  };

  const imageOf = (episode, d) => {
    if (episode?.still_path) return TMDB_STILL + episode.still_path;
    if (d?.backdrop_path) return TMDB_STILL + d.backdrop_path;
    return undefined;
  };
  const iconOf = (show, d) => show?.poster || (d?.poster_path ? TMDB_POSTER + d.poster_path : ICON);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  // ---------------------------------------------------------------- stato
  const freshState = () => ({
    v: VERSION,
    prefs: { ...DEFAULT_PREFS, muted: [] },
    library: null,
    baseline: {},
    log: {},
    history: [],
  });

  const normalizeState = (raw) => {
    const st = freshState();
    if (!raw || typeof raw !== 'object') return st;
    if (raw.prefs && typeof raw.prefs === 'object') {
      st.prefs = { ...st.prefs, ...raw.prefs };
      st.prefs.muted = Array.isArray(raw.prefs.muted) ? raw.prefs.muted.filter(x => x !== null && x !== undefined) : [];
    }
    if (raw.library && Array.isArray(raw.library.shows)) st.library = raw.library;
    if (raw.baseline && typeof raw.baseline === 'object') st.baseline = raw.baseline;
    if (raw.log && typeof raw.log === 'object') st.log = raw.log;
    if (Array.isArray(raw.history)) st.history = raw.history.slice(0, HISTORY_MAX);
    for (const k of ['lastBackground', 'lastRun']) if (typeof raw[k] === 'number') st[k] = raw[k];
    return st;
  };

  const stateUrl = () => {
    try { return new URL(STATE_PATH, root.location.href).href; }
    catch (e) { return STATE_PATH; }
  };
  const hasCaches = () => typeof root.caches !== 'undefined' && root.caches && typeof root.caches.open === 'function';

  // Ripiego in memoria per i browser senza Cache Storage (e per jsdom).
  let memoryState = null;

  const loadState = async () => {
    if (!hasCaches()) return normalizeState(memoryState);
    try {
      const cache = await root.caches.open(STATE_CACHE);
      const res = await cache.match(stateUrl());
      if (!res) return freshState();
      return normalizeState(await res.json());
    } catch (e) { return normalizeState(memoryState); }
  };

  const saveState = async (st) => {
    const now = Date.now();
    for (const [k, t] of Object.entries(st.log)) if (!(t > now - LOG_KEEP_MS)) delete st.log[k];
    st.history = st.history.slice(0, HISTORY_MAX);
    if (!hasCaches()) { memoryState = JSON.parse(JSON.stringify(st)); return st; }
    try {
      const cache = await root.caches.open(STATE_CACHE);
      await cache.put(stateUrl(), new Response(JSON.stringify(st), { headers: { 'Content-Type': 'application/json' } }));
    } catch (e) { memoryState = JSON.parse(JSON.stringify(st)); }
    return st;
  };

  // Leggi-modifica-scrivi, in fila. Pagina e service worker scrivono lo stesso
  // documento: rileggerlo ogni volta e' cio' che impedisce a una copia vecchia
  // in memoria di cancellare il registro scritto dall'altra meta'.
  let queue = Promise.resolve();
  const updateState = (mutator) => {
    const run = queue.then(async () => {
      const st = await loadState();
      const out = await mutator(st);
      await saveState(st);
      return out === undefined ? st : out;
    });
    queue = run.catch(() => {});
    return run;
  };

  // ---------------------------------------------------------------- motore
  const isMuted = (prefs, show) => show?.id != null && (prefs.muted || []).some(m => String(m) === String(show.id));

  // Aggiorna la fotografia delle stagioni di una serie e restituisce le novita'.
  // La fotografia si UNISCE, non si sostituisce: la pagina puo' avere dettagli
  // piu' vecchi di quelli appena scaricati dal service worker, e una stagione
  // sparita da una copia vecchia non deve far ripartire l'annuncio.
  const diffBaseline = (baseline, id, d, now) => {
    const changes = [];
    const nowSeasons = {};
    for (const s of sortedSeasons(d)) nowSeasons[s.season_number] = s.air_date || '';
    const prev = baseline[id];
    if (!prev) {
      baseline[id] = { seasons: nowSeasons, status: d.status || '', at: now.getTime() };
      return changes;   // prima volta che la si vede: si memorizza e basta
    }
    const known = prev.seasons || {};
    const knownMax = Math.max(0, ...Object.keys(known).map(Number));
    const added = Object.keys(nowSeasons).map(Number).filter(n => !(n in known) && n > knownMax);
    if (added.length) {
      const n = Math.max(...added);
      changes.push({ type: 'new-season', season: n, date: nowSeasons[n] });
    }
    for (const [n, date] of Object.entries(nowSeasons)) {
      if (date && known[n] === '' && !added.includes(Number(n))) changes.push({ type: 'season-date', season: Number(n), date });
    }
    if (d.status && prev.status && d.status !== prev.status && ENDED.has(d.status) && !ENDED.has(prev.status)) {
      changes.push({ type: 'status', status: d.status });
    }
    const merged = { ...known };
    for (const [n, date] of Object.entries(nowSeasons)) if (date || !(n in merged)) merged[n] = date;
    baseline[id] = { seasons: merged, status: d.status || prev.status || '', at: now.getTime() };
    return changes;
  };

  const showKey = (show) => (show.id != null ? `id${show.id}` : `t${show.t}`);

  // Cuore del motore. Puro: nessuna rete, nessuna notifica, nessun salvataggio.
  //   library   { shows: [{ t, id, kind, poster, pos, marked }] }
  //             kind: 'watching' (Sto guardando), 'followed' (altre categorie),
  //             'backlog' (Da vedere / Da vedere in futuro)
  //   details   (show) => dettagli TMDB nel formato di app.js, o null
  //   state     lo stato condiviso: baseline e log vengono AGGIORNATI qui
  //   background true nel service worker: rispetta il silenzio notturno
  // Restituisce { notes, badge } — badge e' il numero di serie in corso con
  // almeno un episodio uscito e non ancora segnato.
  const evaluate = ({ library, details, state, now = new Date(), background = false }) => {
    const prefs = state.prefs || DEFAULT_PREFS;
    const shows = (library?.shows || []).filter(s => s && s.t);
    const out = [];
    let badge = 0;
    if (!prefs.enabled) return { notes: [], badge: 0, quiet: false };
    if (background && prefs.quiet) {
      const h = now.getHours();
      // Nel silenzio notturno non si tocca nulla, nemmeno la fotografia delle
      // stagioni: un annuncio "consumato" di notte senza notificarlo andrebbe perso.
      if (h >= QUIET_FROM || h < QUIET_TO) return { notes: [], badge: null, quiet: true };
    }
    const fresh = (key) => !state.log[key];
    const remindedShows = new Set();
    const weekAhead = [];
    const behindList = [];

    for (const show of shows) {
      const d = details(show);
      if (!d) continue;
      const muted = isMuted(prefs, show);
      const ne = d.next_episode_to_air;
      const la = d.last_episode_to_air;
      const behind = show.kind === 'watching' ? airedAfter(show.pos, d) : 0;
      if (behind > 0) badge++;

      // --- stagioni e stato: si aggiorna la fotografia anche se silenziata ---
      if (show.id != null) {
        const changes = diffBaseline(state.baseline, show.id, d, now);
        if (!muted && show.kind !== 'backlog') {
          for (const c of changes) {
            if (c.type === 'new-season' && prefs.seasons) {
              const key = `season|${show.id}|${c.season}`;
              if (!fresh(key)) continue;
              const when = c.date ? dayDiff(c.date, now) : null;
              let body;
              if (when === null) body = 'Annunciata ufficialmente. La data non c\'è ancora: ti avviso appena viene fissata.';
              else if (when > 0) body = `Debutta ${longDate(c.date)} (${relativeDay(c.date, now)}). Te lo ricordo quel giorno.`;
              else if (when === 0) body = 'Ed è già qui: il primo episodio esce oggi.';
              else body = `È uscita ${longDate(c.date)}: puoi già iniziarla.`;
              out.push({ key, kind: 'season', show, d, title: `🆕 ${show.t}: arriva la stagione ${c.season}`, body,
                image: imageOf(null, d), actions: ['open', 'mute'] });
            } else if (c.type === 'season-date' && prefs.seasons) {
              const key = `date|${show.id}|${c.season}|${c.date}`;
              const when = dayDiff(c.date, now);
              if (!fresh(key) || when === null || when < 0) continue;
              out.push({ key, kind: 'season', show, d, title: `📅 ${show.t}: la stagione ${c.season} ha una data`,
                body: when === 0 ? 'Debutta oggi!' : `Debutta ${longDate(c.date)}, ${relativeDay(c.date, now)}.`,
                image: imageOf(null, d), actions: ['open', 'mute'] });
            } else if (c.type === 'status' && prefs.status) {
              const key = `status|${show.id}|${c.status}`;
              if (!fresh(key)) continue;
              const canceled = c.status === 'Canceled';
              out.push({ key, kind: 'status', show, d,
                title: canceled ? `✂️ ${show.t} è stata cancellata` : `🏁 ${show.t} si è conclusa`,
                body: canceled
                  ? 'TMDB la segna come cancellata: non sono previste altre stagioni.'
                  : 'TMDB la segna come terminata. Se ti mancano episodi, sono tutti lì che ti aspettano.',
                image: imageOf(null, d), actions: ['open'] });
            }
          }
        }
      }
      if (muted) continue;

      // --- episodio in uscita oggi ---
      const neDay = ne?.air_date ? dayDiff(ne.air_date, now) : null;
      const premiere = ne?.episode_number === 1;
      const counts = show.kind !== 'backlog' || premiere;   // da vedere: solo i debutti
      if (prefs.episodes && neDay === 0 && counts) {
        const key = `ep|${showKey(show)}|${ne.season_number}x${ne.episode_number}`;
        if (fresh(key)) {
          const info = sortedSeasons(d).find(s => s.season_number === ne.season_number);
          const finale = ne.episode_number > 1 && info?.episode_count === ne.episode_number;
          let title, lead;
          if (premiere && ne.season_number === 1) {
            title = `🎬 Debutta oggi: ${show.t}`;
            lead = `Il primo episodio${quoted(ne.name)} è disponibile da oggi.`;
          } else if (premiere) {
            title = `🔥 ${show.t} è tornata`;
            lead = `Oggi parte la stagione ${ne.season_number}${quoted(ne.name)}.`;
          } else if (finale) {
            title = `🏁 Finale di stagione: ${show.t}`;
            lead = `${epCode(ne.season_number, ne.episode_number)}${quoted(ne.name)} esce oggi.`;
          } else {
            title = `📺 ${show.t}`;
            lead = `Nuovo episodio oggi · ${epCode(ne.season_number, ne.episode_number)}${quoted(ne.name)}`;
          }
          let extra = '';
          if (show.kind === 'watching' && show.pos) {
            extra = behind === 0 ? 'Sei in pari: è il tuo prossimo episodio.'
              : `Prima ti ${behind === 1 ? 'manca 1 episodio' : `mancano ${behind} episodi`}.`;
          }
          out.push({ key, kind: 'episode', show, d, title, body: extra ? `${lead}\n${extra}` : lead,
            image: imageOf(ne, d), timestamp: parseDay(ne.air_date)?.getTime(), actions: ['open', 'mute'] });
        }
      }
      if (prefs.digest && ne?.air_date && neDay !== null && neDay >= 0 && neDay < 7 && counts) {
        weekAhead.push({ show, ne, day: neDay });
      }

      // --- "L'hai visto?" il giorno dopo l'uscita del TUO prossimo episodio ---
      if (show.kind === 'watching' && show.pos && la?.air_date) {
        const ago = dayDiff(la.air_date, now);
        const next = nextAfter(show.pos, d);
        const aired = parseDay(la.air_date);
        if (prefs.reminders && ago !== null && ago <= -1 && ago >= -7 && next
            && next.s === la.season_number && next.e === la.episode_number
            && !((show.marked || 0) >= aired.getTime())) {
          const key = `mark|${showKey(show)}|${la.season_number}x${la.episode_number}`;
          if (fresh(key)) {
            remindedShows.add(show.t);
            out.push({ key, kind: 'reminder', show, d,
              title: `👀 Hai visto ${show.t}?`,
              body: `${epCode(la.season_number, la.episode_number)}${quoted(la.name)} è uscito ${relativeDay(la.air_date, now)}.\nSegnalo e resti in pari.`,
              image: imageOf(la, d), timestamp: aired.getTime(), actions: ['mark', 'later'],
              mark: { s: la.season_number, e: la.episode_number } });
          }
        }
        if (behind > 0 && show.marked > 0 && now.getTime() - show.marked > 7 * DAY) behindList.push({ show, behind });
      }
    }

    // --- arretrati: una volta a settimana, tutte le serie in una notifica ---
    if (prefs.backlog) {
      const list = behindList.filter(x => !remindedShows.has(x.show.t)).sort((a, b) => b.behind - a.behind);
      const key = `backlog|${isoWeek(now)}`;
      if (list.length && fresh(key)) {
        if (list.length === 1) {
          const { show, behind } = list[0];
          out.push({ key, kind: 'backlog', show, d: details(show),
            title: `⏳ ${show.t}: ${plural(behind, 'episodio', 'episodi')} da recuperare`,
            body: `L'ultimo che hai segnato è ${epCode(show.pos.s, show.pos.e)}. Hai visto qualcosa nel frattempo?`,
            image: imageOf(null, details(show)), actions: ['open'] });
        } else {
          const names = list.slice(0, 4).map(x => `${x.show.t} · ${x.behind} ep.`);
          if (list.length > 4) names.push(`e altre ${list.length - 4}`);
          out.push({ key, kind: 'backlog', show: null, section: 'resume',
            title: `⏳ ${list.length} serie ti aspettano`,
            body: `${names.join(', ')}.\nAggiorna i progressi in un tocco da "Riprendi da qui".`, actions: [] });
        }
      }
    }

    // --- riepilogo della settimana: lunedi' o martedi' ---
    if (prefs.digest && (now.getDay() === 1 || now.getDay() === 2) && weekAhead.length) {
      const key = `digest|${isoWeek(now)}`;
      if (fresh(key)) {
        const seen = new Set();
        const items = weekAhead.sort((a, b) => a.day - b.day).filter(x => !seen.has(x.show.t) && seen.add(x.show.t));
        const lines = items.slice(0, 4).map(({ show, ne, day }) =>
          `${day === 0 ? 'Oggi' : day === 1 ? 'Domani' : weekdayShort(ne.air_date)} · ${show.t} ${epCode(ne.season_number, ne.episode_number)}`);
        if (items.length > 4) lines.push(`…e altre ${items.length - 4}`);
        out.push({ key, kind: 'digest', show: null, section: 'upcoming',
          title: `🗓️ La tua settimana in TV: ${plural(items.length, 'uscita', 'uscite')}`,
          body: lines.join('\n'), actions: [] });
      }
    }

    out.sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind]);
    return { notes: finalize(out, now), badge, quiet: false };
  };

  // Da nota interna a qualcosa che si puo' mostrare e salvare: copia solo dati
  // serializzabili e, oltre MAX_PER_RUN, raccoglie il resto in un riepilogo.
  const finalize = (notes, now) => {
    // La stessa serie in due categorie produrrebbe due volte la stessa nota.
    const unique = new Set();
    const shaped = notes.filter(n => !unique.has(n.key) && unique.add(n.key)).map(n => ({
      key: n.key,
      kind: n.kind,
      title: n.title,
      body: n.body,
      icon: n.show ? iconOf(n.show, n.d) : ICON,
      image: n.image,
      timestamp: n.timestamp,
      actions: n.actions || [],
      showTitle: n.show?.t || '',
      showId: n.show?.id ?? null,
      section: n.section || '',
      mark: n.mark || null,
    }));
    if (shaped.length <= MAX_PER_RUN) return shaped;
    const keep = shaped.slice(0, MAX_PER_RUN - 1);
    const rest = shaped.slice(MAX_PER_RUN - 1);
    const names = [...new Set(rest.map(n => n.showTitle).filter(Boolean))];
    keep.push({
      key: `summary|${now.getTime()}`,
      kind: 'summary',
      title: `🔔 Altre ${rest.length} novità dalle tue serie`,
      body: names.length ? `${names.slice(0, 5).join(', ')}${names.length > 5 ? '…' : ''}` : 'Apri TVTracker per vederle.',
      icon: ICON,
      actions: [],
      showTitle: '',
      showId: null,
      section: 'upcoming',
      mark: null,
      // Le note riassunte entrano comunque nella cronologia e nel registro.
      folded: rest,
    });
    return keep;
  };

  const ACTION_LABELS = {
    open: 'Apri la scheda',
    mute: 'Silenzia serie',
    mark: '✓ Visto',
    later: 'Non ancora',
  };

  // Titolo e opzioni per registration.showNotification.
  const toNotification = (note) => {
    const opts = {
      body: note.body,
      icon: note.icon || ICON,
      badge: BADGE,
      tag: note.key,
      lang: 'it',
      dir: 'ltr',
      vibrate: [70, 40, 70],
      data: {
        kind: note.kind,
        key: note.key,
        title: note.showTitle || '',
        id: note.showId,
        section: note.section || '',
        s: note.mark?.s ?? null,
        e: note.mark?.e ?? null,
      },
      actions: (note.actions || []).slice(0, 2).map(a => ({ action: a, title: ACTION_LABELS[a] || a })),
    };
    if (note.image) opts.image = note.image;
    if (note.timestamp) opts.timestamp = note.timestamp;
    return [note.title, opts];
  };

  // Mostra, registra nel log e nella cronologia. `state` va passato dentro un
  // updateState, cosi' il salvataggio e' unico.
  const deliver = async (registration, notes, state, now = new Date()) => {
    let shown = 0;
    for (const note of notes) {
      const [title, opts] = toNotification(note);
      try {
        await registration.showNotification(title, opts);
        shown++;
      } catch (e) {
        // Permesso revocato o browser che rifiuta le opzioni: si riprova senza
        // immagine e pulsanti prima di arrendersi.
        try {
          await registration.showNotification(title, { body: opts.body, icon: opts.icon, badge: opts.badge, tag: opts.tag, data: opts.data });
          shown++;
        } catch (e2) { continue; }
      }
      const all = [note, ...(note.folded || [])];
      for (const n of all) {
        state.log[n.key] = now.getTime();
        if (n.kind === 'summary') continue;
        state.history.unshift({ key: n.key, kind: n.kind, title: n.title, body: n.body, show: n.showTitle || '', icon: n.icon, at: now.getTime() });
      }
    }
    state.history = state.history.slice(0, HISTORY_MAX);
    return shown;
  };

  const setBadge = async (nav, prefs, count) => {
    if (!nav || count === null || count === undefined) return;
    try {
      if (!prefs.badge || !count) { if (nav.clearAppBadge) await nav.clearAppBadge(); return; }
      if (nav.setAppBadge) await nav.setAppBadge(Math.min(count, 99));
    } catch (e) { /* non supportato: nessun danno */ }
  };

  // Notifica di prova costruita su una serie vera della libreria.
  const sample = (library, details) => {
    const shows = (library?.shows || []).filter(s => s && s.t);
    const pick = shows.find(s => s.kind === 'watching' && details(s)) || shows.find(s => details(s)) || shows[0];
    if (!pick) {
      return { key: `test|${Date.now()}`, kind: 'test', title: '🔔 Le notifiche funzionano', body: 'Da ora ti avviso di uscite, nuove stagioni ed episodi da segnare.',
        icon: ICON, actions: [], showTitle: '', showId: null, section: '', mark: null };
    }
    const d = details(pick) || {};
    const next = nextAfter(pick.pos, d) || (d.next_episode_to_air ? { s: d.next_episode_to_air.season_number, e: d.next_episode_to_air.episode_number } : null);
    return {
      key: `test|${Date.now()}`,
      kind: 'test',
      title: `📺 ${pick.t}`,
      body: next
        ? `Così ti avviserò quando esce ${epCode(next.s, next.e)}.\nQuesta è una prova: tutto funziona.`
        : 'Così ti avviserò delle nuove uscite.\nQuesta è una prova: tutto funziona.',
      icon: iconOf(pick, d),
      image: imageOf(null, d),
      actions: ['open'],
      showTitle: pick.t,
      showId: pick.id ?? null,
      section: '',
      mark: null,
    };
  };

  // Anteprima di un tipo di notifica, costruita facendo girare IL MOTORE VERO
  // su una copia ritoccata dei dettagli di una serie della libreria: testi,
  // immagine e pulsanti sono esattamente quelli che arriveranno.
  const localIso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const preview = (library, details, kind, now = new Date()) => {
    const shows = (library?.shows || []).filter(s => s && s.t && details(s));
    const pick = shows.find(s => s.kind === 'watching' && s.pos && sortedSeasons(details(s)).length)
      || shows.find(s => sortedSeasons(details(s)).length);
    if (!pick) return null;
    const d = JSON.parse(JSON.stringify(details(pick)));
    const seasons = sortedSeasons(d);
    const lastSeason = seasons[seasons.length - 1];
    const shift = (n) => { const x = new Date(now); x.setDate(x.getDate() + n); return localIso(x); };
    // Il "tuo prossimo episodio": quello vero se c'e', altrimenti l'ultimo della
    // serie, con la posizione subito prima.
    let target = nextAfter(pick.pos, d);
    let pos = pick.pos;
    if (!target) {
      target = { s: lastSeason.season_number, e: Math.max(1, lastSeason.episode_count || 1) };
      pos = { s: target.s, e: target.e - 1 };
    }
    const episode = (air) => ({ air_date: air, season_number: target.s, episode_number: target.e,
      name: d.next_episode_to_air?.name || d.last_episode_to_air?.name || '', still_path: d.next_episode_to_air?.still_path || d.last_episode_to_air?.still_path || null });
    const show = { ...pick, id: pick.id ?? 'anteprima', kind: 'watching', pos, marked: 0 };
    const state = freshState();
    state.prefs = { ...DEFAULT_PREFS, muted: [], digest: false, backlog: false, status: false, quiet: false,
      episodes: kind === 'episode', reminders: kind === 'reminder', seasons: kind === 'season' };
    if (kind === 'episode') { d.next_episode_to_air = episode(localIso(now)); d.last_episode_to_air = null; }
    if (kind === 'reminder') { d.last_episode_to_air = episode(shift(-1)); d.next_episode_to_air = null; }
    if (kind === 'season') {
      state.baseline[show.id] = { seasons: Object.fromEntries(seasons.map(s => [s.season_number, s.air_date || ''])), status: d.status || '' };
      d.seasons = [...seasons, { season_number: lastSeason.season_number + 1, episode_count: 0, air_date: shift(24) }];
      d.next_episode_to_air = null; d.last_episode_to_air = null;
    }
    const res = evaluate({ library: { shows: [show] }, details: () => d, state, now });
    return res.notes.find(n => n.kind === kind) || null;
  };

  // ---------------------------------------------------------------- service worker
  // Dettagli TMDB ridotti a quello che serve al motore: lo stesso formato che
  // app.js salva nella sua cache.
  const slimDetails = (raw) => {
    if (!raw || !raw.id) return null;
    const ep = (x) => x ? { air_date: x.air_date, season_number: x.season_number, episode_number: x.episode_number, name: x.name, still_path: x.still_path || null } : null;
    return {
      id: raw.id,
      status: raw.status || '',
      poster_path: raw.poster_path || null,
      backdrop_path: raw.backdrop_path || null,
      seasons: (raw.seasons || []).filter(s => s.season_number > 0)
        .map(s => ({ season_number: s.season_number, episode_count: s.episode_count || 0, air_date: s.air_date || null })),
      next_episode_to_air: ep(raw.next_episode_to_air),
      last_episode_to_air: ep(raw.last_episode_to_air),
    };
  };

  const fetchDetails = async (id, key) => {
    const res = await fetch(`${TMDB_API}/tv/${id}?api_key=${encodeURIComponent(key)}&language=it-IT`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return slimDetails(await res.json());
  };

  // Le serie da interrogare in background: prima quelle in corso, poi quelle
  // seguite, poi i debutti attesi; mai quelle gia' concluse.
  const backgroundTargets = (library, baseline) => {
    const rank = { watching: 0, followed: 1, backlog: 2 };
    return (library?.shows || [])
      // Le serie in corso sempre, anche se concluse: servono al conto degli
      // episodi da recuperare (badge e promemoria). Le altre solo se ancora vive.
      .filter(s => s && s.id != null && (s.kind === 'watching' || !ENDED.has(baseline[s.id]?.status)))
      .sort((a, b) => (rank[a.kind] ?? 3) - (rank[b.kind] ?? 3))
      .slice(0, BACKGROUND_FETCH_MAX);
  };

  const pool = async (items, limit, fn) => {
    const results = new Map();
    let i = 0;
    const worker = async () => {
      while (i < items.length) {
        const item = items[i++];
        try { results.set(item, await fn(item)); } catch (e) { results.set(item, null); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
  };

  // Il giro in background (evento periodicsync). Con l'app aperta e visibile
  // non fa nulla: ci pensa la pagina, che ha dati piu' freschi.
  const runInBackground = async (sw, { now = new Date() } = {}) => {
    try {
      const clients = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (clients.some(c => c.visibilityState === 'visible')) return { skipped: 'visible' };
    } catch (e) { /* si prosegue */ }
    const perm = sw.Notification?.permission;
    if (perm && perm !== 'granted') return { skipped: 'permission' };

    const snapshot = await loadState();
    if (!snapshot.prefs.enabled || !snapshot.library?.shows?.length || !snapshot.library.tmdbKey) return { skipped: 'empty' };
    const h = now.getHours();
    if (snapshot.prefs.quiet && (h >= QUIET_FROM || h < QUIET_TO)) return { skipped: 'quiet' };

    const targets = backgroundTargets(snapshot.library, snapshot.baseline);
    const fetched = await pool(targets, 4, (s) => fetchDetails(s.id, snapshot.library.tmdbKey));

    return updateState(async (state) => {
      const res = evaluate({
        library: state.library || snapshot.library,
        details: (s) => fetched.get(targets.find(t => t.t === s.t && t.id === s.id)) || null,
        state, now, background: true,
      });
      const shown = await deliver(sw.registration, res.notes, state, now);
      state.lastBackground = now.getTime();
      await setBadge(sw.navigator, state.prefs, res.badge);
      return { shown, checked: fetched.size };
    });
  };

  // Click su una notifica o su uno dei suoi pulsanti.
  const handleClick = async (sw, action, data = {}) => {
    if (action === 'later') return 'later';
    if (action === 'mute') {
      if (data.id != null) {
        await updateState((st) => {
          if (!st.prefs.muted.some(m => String(m) === String(data.id))) st.prefs.muted.push(data.id);
        });
      }
      return 'mute';
    }
    const op = action === 'mark' ? 'mark' : 'open';
    const msg = { type: 'tvtracker-notify', op, title: data.title || '', section: data.section || '', s: data.s ?? null, e: data.e ?? null };
    const list = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = list.find(c => c.visibilityState === 'visible') || list[0];
    if (client) {
      client.postMessage(msg);
      if ('focus' in client) { try { await client.focus(); } catch (e) {} }
      return op;
    }
    const q = new URLSearchParams({ tvn: op });
    if (msg.title) q.set('t', msg.title);
    if (msg.section) q.set('sec', msg.section);
    if (op === 'mark' && msg.s != null) { q.set('s', String(msg.s)); q.set('e', String(msg.e)); }
    if (sw.clients.openWindow) await sw.clients.openWindow(`./?${q.toString()}`);
    return op;
  };

  root.TVNotify = {
    VERSION, SYNC_TAG, STATE_CACHE, DEFAULT_PREFS, MAX_PER_RUN, QUIET_FROM, QUIET_TO, ACTION_LABELS,
    loadState, saveState, updateState, normalizeState,
    evaluate, toNotification, deliver, setBadge, sample, preview,
    nextAfter, airedAfter, relativeDay, longDate, isoWeek, dayDiff,
    slimDetails, backgroundTargets, runInBackground, handleClick,
  };
})(typeof self !== 'undefined' ? self : this);
