// TVTRACKER — Cloud Function per le notifiche degli episodi in uscita.
//
// ⚠️ QUESTO FILE NON È COLLEGATO ALL'APP. È il punto di partenza, non una
// funzione pronta: manca ancora tutto il lato client. Prima di poterlo usare:
//
//   1. Piano Blaze. Le funzioni schedulate e le chiamate di rete in uscita (a
//      TMDB) non sono disponibili sul piano gratuito Spark.
//   2. SDK messaging nel client. index.html carica solo firebase-app,
//      firebase-firestore e firebase-auth: va aggiunto firebase-messaging-compat.
//   3. Un service worker dedicato, `firebase-messaging-sw.js`, alla radice del
//      sito. Non si può riusare `sw.js`: FCM cerca proprio quel nome.
//   4. Una chiave VAPID (Console Firebase > Impostazioni progetto > Cloud
//      Messaging > Certificati push web) e il salvataggio del token in
//      users/{uid}/fcmTokens/{token} dopo il permesso dell'utente.
//   5. Le regole Firestore vanno estese a quella sottocollezione: quelle attuali
//      consentono solo i tre documenti in users/{uid}/tvtracker.
//
// Da valutare prima di attivarlo: la funzione interroga TMDB una volta per
// serie per utente, ogni giorno. Con una libreria di 150 serie sono 150
// richieste al giorno per il solo proprietario. Conviene raggruppare per tmdbId
// fra tutti gli utenti e mettere in cache il risultato in Firestore, invece di
// ripetere la stessa chiamata per ogni account.
//
// Nel frattempo l'app continua a usare le notifiche locali già presenti in
// app.js: funzionano all'apertura e ogni ora se la scheda resta aperta, senza
// bisogno di server, piano a pagamento o token da gestire.
//
// Deploy (una volta soddisfatti i punti sopra):
//   npm install -g firebase-tools && firebase login
//   firebase init functions
//   firebase functions:secrets:set TMDB_KEY
//   firebase deploy --only functions

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

admin.initializeApp();

// functions.config() è deprecato e rimosso dalle versioni recenti della CLI:
// si usano i secret parametrizzati.
const TMDB_KEY = defineSecret('TMDB_KEY');

exports.checkEpisodesDaily = onSchedule(
  { schedule: '0 9 * * *', timeZone: 'Europe/Rome', secrets: [TMDB_KEY], region: 'europe-west1' },
  async () => {
    const db = admin.firestore();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);

    // Una sola richiesta TMDB per serie, condivisa fra tutti gli utenti: senza
    // questa cache la stessa serie veniva interrogata una volta per account.
    const detailsCache = new Map();
    const nextEpisodeFor = async (tmdbId) => {
      if (detailsCache.has(tmdbId)) return detailsCache.get(tmdbId);
      try {
        const res = await fetch(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${TMDB_KEY.value()}&language=it-IT`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        detailsCache.set(tmdbId, j.next_episode_to_air || null);
      } catch (e) {
        logger.warn(`TMDB ${tmdbId} non raggiungibile`, e);
        detailsCache.set(tmdbId, null);
      }
      return detailsCache.get(tmdbId);
    };

    const users = await db.collection('users').get();
    for (const userDoc of users.docs) {
      const uid = userDoc.id;
      const tokensSnap = await db.collection('users').doc(uid).collection('fcmTokens').get();
      const tokens = tokensSnap.docs.map(d => d.id);
      if (!tokens.length) continue;   // niente token: inutile andare oltre

      const showsDoc = await db.collection('users').doc(uid).collection('tvtracker').doc('shows').get();
      if (!showsDoc.exists) continue;
      const cats = showsDoc.data().data || [];

      const notified = new Set();
      for (const cat of cats) {
        for (const show of (cat.shows || [])) {
          if (!show.tmdbId) continue;
          const next = await nextEpisodeFor(show.tmdbId);
          if (!next?.air_date) continue;

          // 'T00:00:00' e non new Date(iso): senza, la data viene letta come UTC
          // mentre il confronto è su mezzanotte locale — stesso errore di un
          // giorno già corretto in app.js.
          const air = new Date(next.air_date + 'T00:00:00');
          if (air < today || air >= tomorrow) continue;

          const key = `${show.id || show.title}|${next.air_date}`;
          if (notified.has(key)) continue;
          notified.add(key);

          const res = await admin.messaging().sendEachForMulticast({
            notification: {
              title: `📺 ${show.title}`,
              body: `Esce oggi: S${next.season_number}E${next.episode_number}${next.name ? ` — ${next.name}` : ''}`,
            },
            webpush: { notification: { icon: show.poster || undefined } },
            tokens,
          });

          // I token dei browser disinstallati restano validi in Firestore per
          // sempre e fanno fallire ogni invio successivo: si ripuliscono qui.
          res.responses.forEach((r, i) => {
            const code = r.error?.code;
            if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
              db.collection('users').doc(uid).collection('fcmTokens').doc(tokens[i]).delete().catch(() => {});
            }
          });
        }
      }
    }
    return null;
  },
);
