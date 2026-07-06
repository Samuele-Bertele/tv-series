// ==================== CONFIG ====================
const TMDB_API_KEY = '74f5aefb6bb96d044cbf995d9b1897e2';
const TMDB_IMG = 'https://image.tmdb.org/t/p/w342';
const TMDB_IMG_LARGE = 'https://image.tmdb.org/t/p/w780';
const PLACEHOLDER_IMG = 'https://via.placeholder.com/300x450/141414/333333?text=+';

// ==================== STATE ====================
let data = [];
const showDetailsCache = new Map();
let renderScheduled = false;
let pendingSeasonFetch = false;
let ratingsData = {};
let searchQuery = '';
let collapsedCategories = new Set();

// ==================== LOADING BAR ====================
let loadingCount = 0;
const loadingBar = document.getElementById('loadingBar');
const startLoading = () => { loadingCount++; loadingBar.classList.add('active'); };
const stopLoading = () => { loadingCount = Math.max(0, loadingCount - 1); if (!loadingCount) loadingBar.classList.remove('active'); };

// ==================== RATINGS ====================
const loadRatings = () => {
  try { const s = localStorage.getItem('tvtracker-ratings'); if (s) ratingsData = JSON.parse(s); } catch(e) { ratingsData = {}; }
};
const saveRatings = () => localStorage.setItem('tvtracker-ratings', JSON.stringify(ratingsData));
const calcAverage = (s) => (s.cast + s.trama + s.ambientazione + s.colonna_sonora + s.coinvolgimento) / 5;
const toStars = (val) => { const full = Math.round(val / 2); return '★'.repeat(full) + '☆'.repeat(5 - full); };

// ==================== DRAG STATE ====================
const drag = { type: null, catIdx: null, showIdx: null, placeholder: null, lastDroppedTitle: null };

// ==================== UTIL ====================
const escapeHtml = (str) =>
  String(str).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

const showError = (msg) => {
  document.getElementById('errorContainer').innerHTML =
    `<div class="error-message"><h3><i class="fas fa-exclamation-triangle"></i> Errore</h3><p>${msg}</p></div>`;
  setTimeout(() => { document.getElementById('errorContainer').innerHTML = ''; }, 5000);
};

// ==================== PERSIST ====================
const saveData = () => localStorage.setItem('tvtracker-data', JSON.stringify(data));

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
  const saved = localStorage.getItem('tvtracker-data');
  if (saved) {
    try { data = JSON.parse(saved); if (Array.isArray(data) && data.length) return; } catch(e) {}
  }
  data = await loadDefaultData();
  if (data.length) saveData();
};

const exportToFile = () => {
  const blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tvtracker-backup-${new Date().toISOString().slice(0,19)}.json`;
  a.click();
  URL.revokeObjectURL(url);
};

const importFromFile = (file) => {
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const imported = JSON.parse(e.target.result);
      if (!Array.isArray(imported)) throw new Error('Il file deve contenere un array di categorie');
      for (const cat of imported) {
        if (!cat.name || !Array.isArray(cat.shows)) throw new Error(`Categoria "${cat.name}" non valida`);
      }
      data = imported;
      saveData();
      showDetailsCache.clear();
      await render();
      showError('✅ Dati importati con successo!');
    } catch(err) { showError(`Importazione fallita: ${err.message}`); }
  };
  reader.readAsText(file);
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
const apiQueue = new RateLimitedQueue(3);

const fetchShowDetails = async (title) => {
  if (!title) return null;
  if (showDetailsCache.has(title)) return showDetailsCache.get(title);
  return apiQueue.add(async () => {
    try {
      const sr = await fetch(`https://api.themoviedb.org/3/search/tv?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(title)}&language=it-IT`);
      if (!sr.ok) return null;
      const sj = await sr.json();
      if (!sj.results?.length) return null;
      const result = sj.results[0];
      const dr = await fetch(`https://api.themoviedb.org/3/tv/${result.id}?api_key=${TMDB_API_KEY}&language=it-IT&append_to_response=credits`);
      if (!dr.ok) return null;
      const details = await dr.json();
      const filteredSeasons = (details.seasons||[]).filter(s=>s.season_number>0).sort((a,b)=>a.season_number-b.season_number);
      const showDetails = {
        id: details.id, title: details.name, original_title: details.original_name,
        overview: details.overview||'Nessuna descrizione disponibile.',
        poster_path: details.poster_path,
        vote_average: details.vote_average?.toFixed(1)||'N/A',
        first_air_date: details.first_air_date||'Sconosciuta',
        number_of_seasons: filteredSeasons.length,
        number_of_episodes: details.number_of_episodes||0,
        genres: details.genres?.map(g=>g.name).join(', ')||'Nessun genere',
        seasons: filteredSeasons, status: details.status||'Sconosciuto',
        networks: details.networks?.map(n=>n.name).join(', ')||'N/A',
      };
      showDetailsCache.set(title, showDetails);
      return showDetails;
    } catch(e) { console.warn(`Errore fetch ${title}:`, e); return null; }
  });
};

const fetchPoster = async (title) => {
  if (!title) return null;
  const d = await fetchShowDetails(title);
  if (d?.poster_path) return TMDB_IMG + d.poster_path;
  return null;
};

const prefetchPosters = async () => {
  const toFetch = [];
  for (const cat of data)
    for (const show of cat.shows)
      if (!show.poster)
        toFetch.push(fetchPoster(show.title).then(url => { if (url) show.poster = url; }));
  if (toFetch.length) { startLoading(); await Promise.all(toFetch); stopLoading(); saveData(); }
};

let seasonUpdatePromise = null;
const updateSeasonsCounts = async () => {
  if (seasonUpdatePromise) return seasonUpdatePromise;
  seasonUpdatePromise = (async () => {
    let updated = false;
    for (const cat of data)
      for (const show of cat.shows)
        if (show.seasons_count === undefined) {
          const d = await fetchShowDetails(show.title);
          if (d?.number_of_seasons !== undefined) { show.seasons_count = d.number_of_seasons; updated = true; }
        }
    if (updated) { saveData(); await render(); }
    seasonUpdatePromise = null;
  })();
  return seasonUpdatePromise;
};

// ==================== SEARCH ====================
const setupSearch = () => {
  const input = document.getElementById('searchInput');
  const clearBtn = document.getElementById('searchClear');

  input.addEventListener('input', () => {
    searchQuery = input.value.trim().toLowerCase();
    clearBtn.classList.toggle('visible', searchQuery.length > 0);
    applySearch();
  });
  clearBtn.addEventListener('click', () => {
    input.value = '';
    searchQuery = '';
    clearBtn.classList.remove('visible');
    applySearch();
  });
};

const applySearch = () => {
  const info = document.getElementById('searchResultsInfo');
  if (!searchQuery) {
    document.querySelectorAll('.show-card').forEach(c => c.classList.remove('search-hidden'));
    document.querySelectorAll('.category').forEach(cat => cat.style.display = '');
    info.style.display = 'none';
    return;
  }
  let totalVisible = 0;
  document.querySelectorAll('.category').forEach(catEl => {
    const cards = catEl.querySelectorAll('.show-card');
    let catVisible = 0;
    cards.forEach(card => {
      const titleEl = card.querySelector('.show-title');
      const title = titleEl ? titleEl.textContent.toLowerCase() : '';
      const matches = title.includes(searchQuery);
      card.classList.toggle('search-hidden', !matches);
      if (matches) catVisible++;
    });
    totalVisible += catVisible;
    catEl.style.display = catVisible === 0 ? 'none' : '';
  });
  info.style.display = 'block';
  info.innerHTML = `Trovate <strong>${totalVisible}</strong> serie per "<strong>${escapeHtml(searchQuery)}</strong>"`;
};

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

// ==================== RENDER ====================
const render = async () => {
  if (renderScheduled) return;
  renderScheduled = true;
  await new Promise(r => requestAnimationFrame(r));

  const container = document.getElementById('categoriesContainer');
  const legendsContainer = document.getElementById('legendsContainer');
  if (!container) { renderScheduled = false; return; }

  // show skeletons while posters load
  if (!container.children.length) {
    container.innerHTML = data.slice(0,3).map(() => `
      <div>
        <div style="height:38px;width:220px;background:linear-gradient(90deg,#1a1a1a 25%,#252525 50%,#1a1a1a 75%);background-size:200% 100%;animation:skeletonShimmer 1.5s infinite;border-radius:8px;margin-bottom:16px;"></div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(155px,1fr));gap:16px;">
          ${Array(5).fill(0).map(()=>`<div class="skeleton-card"><div class="skeleton-poster"></div><div class="skeleton-body"><div class="skeleton-line"></div><div class="skeleton-line short"></div></div></div>`).join('')}
        </div>
      </div>`).join('');
  }

  startLoading();
  await prefetchPosters();
  stopLoading();

  // ---- Epopee Seriali ----
  // MODIFICA 1: le serie nella categoria "Sto guardando" non compaiono nelle Epopee Seriali
  const legendShows = [];
  const legendTitles = new Set();
  for (const cat of data) {
    if (cat.name.toLowerCase().includes('sto guardando')) continue; // escludi "Sto guardando"
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
    // MODIFICA 2: rinominata da "LEGGENDE TV" a "EPOPEE SERIALI"
    legendsContainer.innerHTML = `
      <div class="legends-section">
        <div class="legends-header">
          <div class="crown-row">
            <div class="crown-line"></div>
            <div class="crown-center"><i class="fas fa-crown crown-icon"></i></div>
            <div class="crown-line right"></div>
          </div>
          <h2 class="legends-title">EPOPEE SERIALI</h2>
          <p class="legends-subtitle">Le grandi serie con 8+ stagioni · ordinate per stagioni</p>
        </div>
        <div class="legends-row" id="legendsRow"></div>
      </div>`;
    const legendsRow = document.getElementById('legendsRow');
    for (const show of legendShows) {
      const card = document.createElement('div');
      card.className = 'legend-card';
      card.onclick = () => openShowDetails(show.title);
      card.innerHTML = `
        <div class="legend-poster-wrap">
          <img class="legend-poster" src="${show.poster || PLACEHOLDER_IMG}" alt="${escapeHtml(show.title)}" loading="lazy">
          <div class="legend-overlay"></div>
          <div class="legend-seasons-badge"><i class="fas fa-layer-group" style="font-size:9px"></i> ${show.seasons_count} stagioni</div>
          <div class="legend-info">
            <div class="legend-badge-row"><i class="fas fa-crown legend-crown-mini"></i><span class="legend-label">Epopea</span></div>
            <div class="legend-title">${escapeHtml(show.title)}</div>
            ${show.progress && parseFloat(show.progress) !== 0 ? `<div class="legend-progress">Visto: ${show.progress} volte</div>` : ''}
          </div>
        </div>`;
      legendsRow.appendChild(card);
    }
  }

  // ---- Categories ----
  if (!data.length) {
    container.innerHTML = `<div class="empty-msg"><i class="fas fa-tv"></i><h3>Nessuna serie TV disponibile</h3><p>Aggiungi delle serie o importa un backup</p></div>`;
    renderScheduled = false;
    return;
  }

  container.innerHTML = '';
  let globalCounter = 1;
  const UNNUMBERED_CATS = ['sto guardando', 'da vedere'];

  for (let catIdx = 0; catIdx < data.length; catIdx++) {
    const cat = data[catIdx];
    const catLower = cat.name.toLowerCase();
    const isNumberedCat = !UNNUMBERED_CATS.some(e => catLower.includes(e));
    const isCollapsed = collapsedCategories.has(catIdx);

    const catDiv = document.createElement('div');
    catDiv.className = 'category' + (isCollapsed ? ' collapsed' : '');
    catDiv.dataset.catIdx = catIdx;

    // ---- Header ----
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

    // Toggle collapse on header click (not on action buttons)
    headerDiv.addEventListener('click', (e) => {
      if (e.target.closest('.category-actions')) return;
      if (collapsedCategories.has(catIdx)) collapsedCategories.delete(catIdx);
      else collapsedCategories.add(catIdx);
      catDiv.classList.toggle('collapsed');
    });

    // Category drag (on drag handle only)
    dragHandleBtn.draggable = true;
    dragHandleBtn.addEventListener('dragstart', (e) => {
      drag.type = 'category';
      drag.catIdx = catIdx;
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

    // ---- Body (collapsible) ----
    const bodyDiv = document.createElement('div');
    bodyDiv.className = 'category-body';

    const showsRow = document.createElement('div');
    showsRow.className = 'shows-row';
    showsRow.dataset.catIdx = catIdx;

    if (!cat.shows.length) {
      const emptyMsg = document.createElement('div');
      emptyMsg.className = 'empty-msg';
      emptyMsg.innerHTML = '<i class="fas fa-film"></i> Nessuna serie. Aggiungine una qui sotto.';
      showsRow.appendChild(emptyMsg);
    } else {
      for (let showIdx = 0; showIdx < cat.shows.length; showIdx++) {
        const show = cat.shows[showIdx];
        const isLegend = legendTitles.has(show.title);
        const card = document.createElement('div');
        card.className = 'show-card';
        card.draggable = true;
        card.dataset.catIdx = catIdx;
        card.dataset.showIdx = showIdx;
        if (isLegend) card.dataset.isLegend = 'true';

        const posterUrl = show.poster || PLACEHOLDER_IMG;
        const ratingEntry = ratingsData[show.title];

        let numberHtml;
        if (isNumberedCat) {
          numberHtml = isLegend
            ? `<i class="fas fa-crown" style="color:#FFD700;font-size:9px"></i> ${globalCounter}.`
            : `${globalCounter}.`;
          globalCounter++;
        } else {
          numberHtml = isLegend ? `<i class="fas fa-crown" style="color:#FFD700;font-size:9px"></i>` : '';
        }

        const progressHtml = show.progress && parseFloat(show.progress) !== 0
          ? `<div class="show-progress">Visto: ${show.progress} volte</div>`
          : (show.progress !== undefined && parseFloat(show.progress) === 0
              ? `<div class="show-progress unseen">Da vedere</div>` : '');

        // Build rating tooltip HTML
        let ratingBadgeHtml = '';
        if (ratingEntry) {
          const RATING_CATS_INFO = [
            { key: 'cast', label: 'Cast', icon: 'fa-users' },
            { key: 'trama', label: 'Trama', icon: 'fa-book-open' },
            { key: 'ambientazione', label: 'Ambienz.', icon: 'fa-map-location-dot' },
            { key: 'colonna_sonora', label: 'Musica', icon: 'fa-music' },
            { key: 'coinvolgimento', label: 'Coinvolg.', icon: 'fa-fire' },
          ];
          const tooltipRows = RATING_CATS_INFO.map(c =>
            `<div class="rating-tooltip-row"><span class="rating-tooltip-label">${c.label}</span><span class="rating-tooltip-val">${ratingEntry[c.key]}</span></div>`
          ).join('');
          ratingBadgeHtml = `
            <div class="rating-badge" data-show-title="${escapeHtml(show.title)}">
              <i class="fas fa-star"></i> ${ratingEntry.average.toFixed(1)}
              <div class="rating-tooltip">
                ${tooltipRows}
                <div class="rating-tooltip-divider"></div>
                <div class="rating-tooltip-avg-row">
                  <span class="rating-tooltip-avg-label">Media</span>
                  <span class="rating-tooltip-avg-val">${ratingEntry.average.toFixed(1)}</span>
                </div>
              </div>
            </div>`;
        }

        // Build move-to submenu
        const otherCats = data.map((c, i) => ({ name: c.name, idx: i })).filter(c => c.idx !== catIdx);
        const moveSubmenuItems = otherCats.map(c =>
          `<button data-move-to="${c.idx}"><i class="fas fa-arrow-right"></i> ${escapeHtml(c.name)}</button>`
        ).join('');

        card.innerHTML = `
          <div class="poster-wrap">
            <img class="poster" src="${posterUrl}" alt="${escapeHtml(show.title)}" loading="lazy">
            <div class="poster-overlay"></div>
            ${numberHtml ? `<div class="show-number">${numberHtml}</div>` : ''}
            <div class="card-menu">⋮
              <div class="card-menu-box" style="display:none">
                <button class="details-btn"><i class="fas fa-info-circle"></i> Dettagli</button>
                <button class="edit-btn"><i class="fas fa-edit"></i> Modifica</button>
                <button class="rate-btn"><i class="fas fa-star"></i> Vota</button>
                <div class="move-submenu">
                  <button><i class="fas fa-folder-open"></i> Sposta in...<i class="fas fa-chevron-right" style="margin-left:auto;font-size:10px;opacity:0.5;"></i></button>
                  <div class="move-submenu-list">${moveSubmenuItems}</div>
                </div>
                <button class="delete-btn"><i class="fas fa-trash"></i> Elimina</button>
              </div>
            </div>
            <div class="poster-info">
              <div class="show-title">${escapeHtml(show.title)}</div>
              ${progressHtml}
              ${ratingBadgeHtml}
            </div>
          </div>`;

        card.querySelector('.poster').onclick = (e) => { e.stopPropagation(); openShowDetails(show.title); };
        card.querySelector('.show-title').onclick = (e) => { e.stopPropagation(); openShowDetails(show.title); };

        const menuBtn = card.querySelector('.card-menu');
        const menuBox = card.querySelector('.card-menu-box');
        menuBtn.onclick = (e) => {
          e.stopPropagation();
          const isOpen = menuBox.style.display !== 'none';
          document.querySelectorAll('.card-menu-box').forEach(b => b.style.display = 'none');
          menuBox.style.display = isOpen ? 'none' : 'block';
        };

        menuBox.querySelector('.delete-btn').onclick  = () => deleteShow(catIdx, showIdx);
        menuBox.querySelector('.edit-btn').onclick    = () => openEditModal(catIdx, showIdx);
        menuBox.querySelector('.details-btn').onclick = () => { openShowDetails(show.title); menuBox.style.display = 'none'; };
        menuBox.querySelector('.rate-btn').onclick    = () => { openRatingModal(show.title, show.poster); menuBox.style.display = 'none'; };

        // Move-to submenu items
        menuBox.querySelectorAll('[data-move-to]').forEach(btn => {
          btn.onclick = async () => {
            const dstCatIdx = parseInt(btn.dataset.moveTo);
            menuBox.style.display = 'none';
            await moveShow(catIdx, showIdx, dstCatIdx);
          };
        });

        if (ratingEntry) {
          card.querySelector('.rating-badge').onclick = (e) => { e.stopPropagation(); openRatingDetails(show.title); };
        }

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
        const [movedShow] = data[srcCatIdx].shows.splice(srcShowIdx, 1);
        let realInsertIdx = insertIdx;
        if (srcCatIdx === dstCatIdx && srcShowIdx < insertIdx) realInsertIdx = Math.max(0, insertIdx - 1);
        data[dstCatIdx].shows.splice(realInsertIdx, 0, movedShow);
        drag.lastDroppedTitle = movedTitle;
        saveData();
        drag.type = null; drag.catIdx = null; drag.showIdx = null;
        await render();
        // Flash the dropped card
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
          // update collapsed set indices
          const newCollapsed = new Set();
          collapsedCategories.forEach(idx => {
            if (idx === srcCatIdx) newCollapsed.add(dstCatIdx);
            else if (idx >= Math.min(srcCatIdx, dstCatIdx) && idx <= Math.max(srcCatIdx, dstCatIdx)) {
              newCollapsed.add(srcCatIdx < dstCatIdx ? idx - 1 : idx + 1);
            } else newCollapsed.add(idx);
          });
          collapsedCategories = newCollapsed;
          saveData();
        }
        drag.type = null; drag.catIdx = null;
        await render();
      }
    });

    bodyDiv.appendChild(showsRow);

    // Add show form
    const addForm = document.createElement('form');
    addForm.className = 'add-show-form';
    addForm.innerHTML = `
      <input type="text" placeholder="Titolo serie..." />
      <input type="text" placeholder="Volte viste (0 = da vedere)" />
      <input type="text" placeholder="URL poster (opzionale)" />
      <button type="submit" class="btn btn-secondary"><i class="fas fa-plus btn-icon"></i> Aggiungi</button>
      <span class="drop-hint">Trascina per riordinare</span>`;
    addForm.onsubmit = async (e) => {
      e.preventDefault();
      const inputs = addForm.querySelectorAll('input');
      const title = inputs[0].value.trim();
      if (!title) return;
      let progress = inputs[1].value.trim().replace(',', '.');
      const poster = inputs[2].value.trim() || undefined;
      const matched = progress.match(/[\d.]+/);
      progress = matched ? matched[0] : (progress ? progress : undefined);
      data[catIdx].shows.push({ title, progress: progress || undefined, poster });
      saveData();
      inputs[0].value = ''; inputs[1].value = ''; inputs[2].value = '';
      await render();
    };
    bodyDiv.appendChild(addForm);
    catDiv.appendChild(bodyDiv);
    container.appendChild(catDiv);
  }

  renderScheduled = false;
  applySearch();

  if (!pendingSeasonFetch) {
    pendingSeasonFetch = true;
    setTimeout(async () => { await updateSeasonsCounts(); pendingSeasonFetch = false; }, 500);
  }
};

// Close menus on outside click
document.addEventListener('click', (e) => {
  if (!e.target.closest('.card-menu'))
    document.querySelectorAll('.card-menu-box').forEach(b => b.style.display = 'none');
});

// ==================== CRUD ====================
const deleteShow = async (catIdx, showIdx) => {
  const title = data[catIdx].shows[showIdx].title;
  data[catIdx].shows.splice(showIdx, 1);
  showDetailsCache.delete(title);
  saveData();
  await render();
};

const moveShow = async (srcCatIdx, srcShowIdx, dstCatIdx) => {
  const [movedShow] = data[srcCatIdx].shows.splice(srcShowIdx, 1);
  data[dstCatIdx].shows.push(movedShow);
  saveData();
  await render();
};

const deleteCategory = async (catIdx) => {
  const cat = data[catIdx];
  const hasShows = cat.shows.length > 0;
  const msg = hasShows
    ? `Eliminare la categoria "${cat.name}" con ${cat.shows.length} serie? Le serie verranno perse.`
    : `Eliminare la categoria vuota "${cat.name}"?`;
  if (!confirm(msg)) return;
  data.splice(catIdx, 1);
  // update collapsed indices
  const newCollapsed = new Set();
  collapsedCategories.forEach(idx => { if (idx < catIdx) newCollapsed.add(idx); else if (idx > catIdx) newCollapsed.add(idx - 1); });
  collapsedCategories = newCollapsed;
  saveData();
  await render();
};

const openEditModal = (catIdx, showIdx) => {
  const targetShow = data[catIdx].shows[showIdx];
  if (!targetShow) return;
  const oldTitle = targetShow.title;
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-content edit-modal">
      <div class="modal-header">
        <h2>Modifica serie</h2>
        <button class="modal-close">&times;</button>
      </div>
      <div class="edit-form">
        <label>Titolo</label>
        <input id="editTitle" type="text" class="form-input" value="${escapeHtml(targetShow.title)}" />
        <label>Progresso (0 = da vedere)</label>
        <input id="editProgress" type="text" class="form-input" value="${targetShow.progress || ''}" />
        <label>Poster URL</label>
        <input id="editPoster" type="text" class="form-input" value="${targetShow.poster || ''}" />
      </div>
      <div class="edit-actions">
        <button class="btn btn-primary" id="saveEdit"><i class="fas fa-save btn-icon"></i> Salva</button>
        <button class="btn btn-secondary" id="cancelEdit">Annulla</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
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
    targetShow.title = newTitle || targetShow.title;
    targetShow.progress = newProgress || undefined;
    targetShow.poster = newPoster || undefined;
    if (newTitle && newTitle !== oldTitle) { targetShow.seasons_count = undefined; showDetailsCache.delete(oldTitle); }
    saveData();
    await render();
    closeModal();
  };
};

const openShowDetails = async (title) => {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-content">
      <div class="modal-header">
        <h2>${escapeHtml(title)}</h2>
        <button class="modal-close">&times;</button>
      </div>
      <div class="modal-body">
        <div style="padding:40px;text-align:center;grid-column:1/-1">Caricamento dettagli...</div>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const closeModal = () => modal.remove();
  modal.querySelector('.modal-close').onclick = closeModal;
  modal.onclick = (e) => { if (e.target === modal) closeModal(); };

  const details = await fetchShowDetails(title);
  if (!details) {
    modal.querySelector('.modal-body').innerHTML = `<div style="padding:40px;text-align:center;grid-column:1/-1">Impossibile caricare i dettagli</div>`;
  } else {
    const posterUrl = details.poster_path ? TMDB_IMG_LARGE + details.poster_path : PLACEHOLDER_IMG;
    modal.querySelector('.modal-body').innerHTML = `
      <img class="modal-poster" src="${posterUrl}" alt="${escapeHtml(title)}">
      <div class="modal-details">
        <div class="detail-row">
          <div class="detail-item"><h4>Voto Medio</h4><p>${details.vote_average}/10</p></div>
          <div class="detail-item clickable" id="seasonsDetailItem" title="Clicca per vedere gli episodi per stagione">
            <h4>Stagioni</h4><p>${details.number_of_seasons}</p>
            <div class="detail-hint"><i class="fas fa-list-ol"></i> Vedi episodi</div>
          </div>
          <div class="detail-item"><h4>Episodi</h4><p>${details.number_of_episodes}</p></div>
        </div>
        <div class="detail-row">
          <div class="detail-item"><h4>Genere</h4><p>${details.genres}</p></div>
          <div class="detail-item"><h4>Stato</h4><p>${details.status}</p></div>
        </div>
        <div class="detail-row">
          <div class="detail-item"><h4>Trama</h4><p class="overview">${details.overview}</p></div>
        </div>
      </div>`;
    const footer = document.createElement('div');
    footer.className = 'modal-footer';
    footer.innerHTML = `
      <a href="https://www.themoviedb.org/tv/${details.id}" target="_blank" class="external-link"><i class="fas fa-external-link-alt"></i> Vedi su TMDB</a>
      <button class="btn btn-primary" id="closeDetailsBtn">Chiudi</button>`;
    modal.querySelector('.modal-content').appendChild(footer);
    footer.querySelector('#closeDetailsBtn').onclick = closeModal;

    // MODIFICA: click sul numero di stagioni apre il dettaglio episodi per stagione
    const seasonsItem = modal.querySelector('#seasonsDetailItem');
    if (seasonsItem) seasonsItem.onclick = () => openSeasonsBreakdown(details, title);
  }
};

// ==================== SEASONS BREAKDOWN (episodi per stagione) ====================
const openSeasonsBreakdown = (details, showTitle) => {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';

  const seasons = details.seasons || [];
  const seasonsHtml = seasons.length
    ? seasons.map(s => `
        <div class="season-item">
          <div class="season-item-name">${escapeHtml(s.name || `Stagione ${s.season_number}`)}</div>
          <div class="season-item-episodes">${s.episode_count ?? '—'}<span>episodi</span></div>
        </div>`).join('')
    : `<div style="text-align:center;color:var(--text-muted);padding:20px;">Nessuna informazione sulle stagioni disponibile</div>`;

  modal.innerHTML = `
    <div class="modal-content seasons-modal">
      <div class="modal-header">
        <h2><i class="fas fa-layer-group" style="font-size:20px;margin-right:8px;"></i>${escapeHtml(showTitle)}</h2>
        <button class="modal-close">&times;</button>
      </div>
      <div class="seasons-list">${seasonsHtml}</div>
      <div class="modal-footer" style="justify-content:flex-end;">
        <button class="btn btn-primary" id="closeSeasonsBtn">Chiudi</button>
      </div>
    </div>`;

  document.body.appendChild(modal);
  const closeModal = () => modal.remove();
  modal.querySelector('.modal-close').onclick = closeModal;
  modal.querySelector('#closeSeasonsBtn').onclick = closeModal;
  modal.onclick = (e) => { if (e.target === modal) closeModal(); };
};

// ==================== RATING SYSTEM ====================
const EXCLUDED_CATEGORIES = ['da vedere', 'sto guardando'];
const RATING_CATS = [
  { key: 'cast',           label: 'Cast',           icon: 'fa-users' },
  { key: 'trama',          label: 'Trama',          icon: 'fa-book-open' },
  { key: 'ambientazione',  label: 'Ambientazione',  icon: 'fa-map-location-dot' },
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
    return `
      <div class="rating-category">
        <div class="rating-cat-header">
          <div class="rating-cat-label"><i class="fas ${cat.icon}"></i>${cat.label}</div>
          <div class="rating-cat-value" id="val-${cat.key}">${val}</div>
        </div>
        <input type="range" class="rating-slider" id="slider-${cat.key}" min="0" max="10" step="1" value="${val}"
               oninput="document.getElementById('val-${cat.key}').textContent=this.value; updateRatingAvgPreview()">
        <div class="rating-track-labels"><span>0</span><span>5</span><span>10</span></div>
      </div>`;
  }).join('');

  const initAvg = existing.average !== undefined
    ? existing.average.toFixed(1)
    : (RATING_CATS.reduce((s,c) => s + (existing[c.key] !== undefined ? existing[c.key] : 7), 0) / RATING_CATS.length).toFixed(1);

  modal.innerHTML = `
    <div class="modal-content rating-modal">
      <div class="modal-header">
        <h2><i class="fas fa-star" style="font-size:22px;margin-right:10px;"></i>Valuta Serie</h2>
        <button class="modal-close">&times;</button>
      </div>
      <div style="padding:24px 28px;">
        <div class="rating-show-header">
          <img class="rating-show-poster" src="${posterUrl}" alt="${escapeHtml(title)}">
          <div class="rating-show-meta">
            <h3>${escapeHtml(title)}</h3>
            <p>Assegna un voto da 0 a 10 per ogni categoria</p>
            ${existing.savedAt ? `<p style="margin-top:6px;color:rgba(255,215,0,0.6);font-size:11px;"><i class="fas fa-check-circle"></i> Già valutata il ${new Date(existing.savedAt).toLocaleDateString('it-IT')}</p>` : ''}
          </div>
        </div>
        <div class="rating-categories">${slidersHtml}</div>
        <div class="rating-average-box">
          <div class="rating-average-label">Media voti</div>
          <div class="rating-average-value" id="ratingAvgPreview">${initAvg}</div>
          <div class="rating-average-stars" id="ratingAvgStars">${toStars(parseFloat(initAvg))}</div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="cancelRating">Annulla</button>
        <button class="btn btn-primary" id="saveRating"><i class="fas fa-save"></i> Salva Valutazione</button>
      </div>
    </div>`;

  document.body.appendChild(modal);
  const closeModal = () => modal.remove();
  modal.querySelector('.modal-close').onclick = closeModal;
  modal.querySelector('#cancelRating').onclick = closeModal;
  modal.onclick = (e) => { if (e.target === modal) closeModal(); };
  modal.querySelector('#saveRating').onclick = async () => {
    const scores = {};
    for (const cat of RATING_CATS) scores[cat.key] = parseInt(modal.querySelector(`#slider-${cat.key}`).value);
    scores.average = calcAverage(scores);
    scores.savedAt = new Date().toISOString();
    ratingsData[title] = scores;
    saveRatings();
    closeModal();
    await render();
  };
};

window.updateRatingAvgPreview = () => {
  const keys = ['cast','trama','ambientazione','colonna_sonora','coinvolgimento'];
  const avg = keys.reduce((s,k) => { const el = document.getElementById(`slider-${k}`); return s + (el ? parseInt(el.value) : 0); }, 0) / keys.length;
  const avgEl = document.getElementById('ratingAvgPreview');
  const starsEl = document.getElementById('ratingAvgStars');
  if (avgEl) avgEl.textContent = avg.toFixed(1);
  if (starsEl) starsEl.textContent = toStars(avg);
};

const openRatingDetails = (title) => {
  const entry = ratingsData[title];
  if (!entry) return;
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  const itemsHtml = RATING_CATS.map(cat => `
    <div class="rating-detail-item">
      <div class="rating-detail-item-label"><i class="fas ${cat.icon}"></i>${cat.label}</div>
      <div class="rating-detail-item-value">${entry[cat.key]}<span style="font-size:14px;color:var(--text-muted)">/10</span></div>
      <div class="rating-detail-bar"><div class="rating-detail-bar-fill" style="width:${entry[cat.key]*10}%"></div></div>
    </div>`).join('');
  modal.innerHTML = `
    <div class="modal-content rating-modal">
      <div class="modal-header">
        <h2><i class="fas fa-star" style="font-size:22px;margin-right:10px;"></i>${escapeHtml(title)}</h2>
        <button class="modal-close">&times;</button>
      </div>
      <div style="padding:24px 28px;">
        <p style="color:var(--text-muted);font-size:13px;margin:0 0 8px 0;">
          ${entry.savedAt ? `Valutata il ${new Date(entry.savedAt).toLocaleDateString('it-IT', {day:'2-digit',month:'long',year:'numeric'})}` : ''}
        </p>
        <div class="rating-detail-grid">${itemsHtml}</div>
        <div class="rating-big-avg">
          <div class="rating-average-stars" style="font-size:20px;letter-spacing:3px;">${toStars(entry.average)}</div>
          <div class="rating-big-avg-val">${entry.average.toFixed(1)}</div>
          <div class="rating-big-avg-label">Media generale</div>
        </div>
      </div>
      <div class="modal-footer" style="justify-content:flex-end;gap:10px;">
        <button class="btn btn-secondary" id="reRateBtn"><i class="fas fa-edit"></i> Modifica</button>
        <button class="btn btn-primary" id="closeRatingDetail">Chiudi</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const closeModal = () => modal.remove();
  modal.querySelector('.modal-close').onclick = closeModal;
  modal.querySelector('#closeRatingDetail').onclick = closeModal;
  modal.onclick = (e) => { if (e.target === modal) closeModal(); };
  modal.querySelector('#reRateBtn').onclick = () => { closeModal(); openRatingModal(title); };
};

const openRandomRating = async () => {
  const shows = getVotableShows();
  if (!shows.length) { showError('Nessuna serie disponibile per la valutazione.'); return; }
  const picked = shows[Math.floor(Math.random() * shows.length)];
  await openRatingModal(picked.title, picked.poster || null);
};

// ==================== STATISTICS ====================
const showStatistics = () => {
  let excludeFuture = false, excludeWatching = false;
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  const modalContent = document.createElement('div');
  modalContent.className = 'modal-content';
  modalContent.style.maxWidth = '1050px';

  const refreshStats = () => {
    let totalShows = 0, totalViews = 0;
    const categories = [], mostWatched = [];
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
      }
      categories.push({ name: cat.name, showCount: catShows, totalViews: catViews });
    }
    mostWatched.sort((a,b) => b.views - a.views);

    // ---- Ratings stats ----
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

    const RATING_CAT_INFO = [
      { key: 'cast', label: 'Cast', icon: 'fa-users' },
      { key: 'trama', label: 'Trama', icon: 'fa-book-open' },
      { key: 'ambientazione', label: 'Ambientazione', icon: 'fa-map-location-dot' },
      { key: 'colonna_sonora', label: 'Colonna Sonora', icon: 'fa-music' },
      { key: 'coinvolgimento', label: 'Coinvolgimento', icon: 'fa-fire' },
    ];

    const catAvgBarsHtml = RATING_CAT_INFO.map(c => {
      const avg = ratedCount ? (catSums[c.key] / ratedCount).toFixed(1) : 0;
      return `
        <div class="cat-avg-bar-row">
          <div class="cat-avg-bar-label"><i class="fas ${c.icon}"></i>${c.label}</div>
          <div class="cat-avg-bar-track"><div class="cat-avg-bar-fill" style="width:${(avg/10)*100}%"></div></div>
          <div class="cat-avg-bar-val">${avg}</div>
        </div>`;
    }).join('');

    const topRatedHtml = topRated.slice(0,5).map((s,i) => `
      <div class="top-rated-item">
        <div class="top-rated-rank">${i+1}</div>
        <div class="top-rated-info">
          <div class="top-rated-title">${escapeHtml(s.title)}</div>
          <div class="top-rated-cat">${escapeHtml(s.cat)}</div>
        </div>
        <div class="top-rated-score">
          <div class="top-rated-avg">${s.avg.toFixed(1)}</div>
          <div class="top-rated-stars">${toStars(s.avg)}</div>
        </div>
      </div>`).join('');

    const ratingsSection = ratedCount ? `
      <div class="stats-ratings-section">
        <div class="stats-section">
          <h3><i class="fas fa-star" style="color:var(--gold)"></i> Valutazioni</h3>
          <div class="ratings-stats-grid">
            <div class="rating-stat-card">
              <div class="rating-stat-card-label">Serie valutate</div>
              <div class="rating-stat-card-value">${ratedCount}</div>
              <div class="rating-stat-card-sub">su ${totalShows} totali</div>
            </div>
            <div class="rating-stat-card">
              <div class="rating-stat-card-label">Media globale</div>
              <div class="rating-stat-card-value">${globalAvgRating}</div>
              <div class="rating-stat-card-sub">${toStars(parseFloat(globalAvgRating))}</div>
            </div>
            ${bestShow ? `<div class="rating-stat-card">
              <div class="rating-stat-card-label">Migliore</div>
              <div class="rating-stat-card-value" style="font-size:20px;padding-top:4px;">${escapeHtml(bestShow)}</div>
              <div class="rating-stat-card-sub">${bestAvg.toFixed(1)} / 10</div>
            </div>` : ''}
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:16px;">
            <div>
              <div style="font-size:13px;font-weight:700;color:var(--text);margin-bottom:12px;">Media per categoria</div>
              <div class="category-avg-bars">${catAvgBarsHtml}</div>
            </div>
            <div>
              <div style="font-size:13px;font-weight:700;color:var(--text);margin-bottom:12px;">Top 5 serie votate</div>
              <div class="top-rated-list">${topRatedHtml}</div>
            </div>
          </div>
        </div>
      </div>` : `<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:14px;">
        <i class="fas fa-star" style="font-size:24px;opacity:0.3;display:block;margin-bottom:8px;"></i>
        Nessuna serie valutata ancora. Usa il bottone <strong style="color:var(--accent)">★</strong> sulle card per iniziare.
      </div>`;

    const togglesHtml = `
      <div style="display:flex;flex-direction:column;gap:12px;margin-bottom:24px;">
        <div class="toggle-container" style="margin-bottom:0;">
          <div class="toggle-left">
            <div class="toggle-icon"><i class="fas fa-clock"></i></div>
            <div class="toggle-text">
              <div class="toggle-title">Serie "Da vedere in futuro"</div>
              <div class="toggle-description">Includi nelle statistiche le serie in lista d'attesa</div>
            </div>
          </div>
          <div class="toggle-right">
            <label class="toggle-switch"><input type="checkbox" id="futureToggle" ${excludeFuture ? '' : 'checked'}><span class="toggle-slider"></span></label>
            <div class="toggle-status">${excludeFuture ? 'ESCLUSE' : 'INCLUSE'}</div>
          </div>
        </div>
        <div class="toggle-container" style="margin-bottom:0;">
          <div class="toggle-left">
            <div class="toggle-icon"><i class="fas fa-play"></i></div>
            <div class="toggle-text">
              <div class="toggle-title">Serie "Sto guardando"</div>
              <div class="toggle-description">Includi nelle statistiche le serie che stai guardando</div>
            </div>
          </div>
          <div class="toggle-right">
            <label class="toggle-switch"><input type="checkbox" id="watchingToggle" ${excludeWatching ? '' : 'checked'}><span class="toggle-slider"></span></label>
            <div class="toggle-status">${excludeWatching ? 'ESCLUSE' : 'INCLUSE'}</div>
          </div>
        </div>
      </div>`;

    modalContent.innerHTML = `
      <div class="modal-header">
        <h2><i class="fas fa-chart-bar"></i> Statistiche Serie TV</h2>
        <button class="modal-close">&times;</button>
      </div>
      <div class="modal-body" style="display:block;padding:28px;">
        ${togglesHtml}
        <div class="stats-grid">
          <div class="stat-card"><h3>Serie Totali</h3><p class="stat-value">${totalShows}</p></div>
          <div class="stat-card"><h3>Visioni Totali</h3><p class="stat-value">${totalViews.toFixed(1)}</p></div>
          <div class="stat-card"><h3>Media Visioni</h3><p class="stat-value">${totalShows ? (totalViews/totalShows).toFixed(1) : 0}</p></div>
          <div class="stat-card"><h3>Categorie</h3><p class="stat-value">${categories.length}</p></div>
        </div>
        <div class="stats-columns">
          <div class="stats-section">
            <h3><i class="fas fa-folder"></i> Per Categoria</h3>
            <div class="categories-list">
              ${categories.map(c => `
                <div class="category-item">
                  <div class="category-name">${escapeHtml(c.name)}</div>
                  <div class="category-stats">
                    <div class="category-stat"><div class="stat-label">Serie</div><div class="stat-number">${c.showCount}</div></div>
                    <div class="category-stat"><div class="stat-label">Visioni</div><div class="stat-number">${c.totalViews}</div></div>
                  </div>
                </div>`).join('')}
            </div>
          </div>
          <div class="stats-section">
            <h3><i class="fas fa-trophy"></i> Più Viste</h3>
            <div class="top-shows-list">
              ${mostWatched.slice(0,8).map((s,i) => `
                <div class="top-show-item">
                  <div class="show-rank">${i+1}</div>
                  <div>
                    <div class="show-title" style="color:var(--text)">${escapeHtml(s.title)}</div>
                    <div class="show-category">${escapeHtml(s.category)}</div>
                  </div>
                  <div><div class="show-views">${s.views}</div><div class="show-views-label">visioni</div></div>
                </div>`).join('')}
            </div>
          </div>
        </div>
        ${ratingsSection}
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" id="closeStats">Chiudi</button>
      </div>`;

    modalContent.querySelector('#futureToggle').onchange   = (e) => { excludeFuture   = !e.target.checked; refreshStats(); };
    modalContent.querySelector('#watchingToggle').onchange = (e) => { excludeWatching = !e.target.checked; refreshStats(); };
    modalContent.querySelector('.modal-close').onclick = () => modal.remove();
    modalContent.querySelector('#closeStats').onclick  = () => modal.remove();
  };

  refreshStats();
  modal.appendChild(modalContent);
  document.body.appendChild(modal);
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
};

// ==================== PRINT ====================
const printList = () => {
  let output = '', globalCounter = 1;
  for (const cat of data) {
    output += `${cat.name}\n${'='.repeat(cat.name.length)}\n\n`;
    for (const show of cat.shows) {
      const legend = (show.seasons_count || 0) >= 8 ? ' 👑' : '';
      const prog = show.progress ? ` — ${show.progress} volte` : (show.progress === '0' ? ' — Da vedere' : '');
      const rating = ratingsData[show.title] ? ` ★${ratingsData[show.title].average.toFixed(1)}` : '';
      output += `${legend ? '👑 ' : `${globalCounter++}. `}${show.title}${prog}${rating}\n`;
    }
    output += '\n\n';
  }
  const win = window.open('', '_blank');
  win.document.write(`<pre style="font-family:monospace;white-space:pre-wrap;background:#000;color:#fff;padding:20px;">${output}</pre>`);
  win.document.close();
};

// ==================== RESET ====================
const resetData = async () => {
  if (confirm('Ripristinare i dati originali? Tutte le modifiche andranno perse.')) {
    localStorage.removeItem('tvtracker-data');
    showDetailsCache.clear();
    collapsedCategories.clear();
    data = await loadDefaultData();
    if (data.length) saveData();
    await render();
  }
};

// ==================== EVENTS ====================
document.getElementById('printListBtn').onclick = printList;
document.getElementById('statsBtn').onclick      = showStatistics;
document.getElementById('resetBtn').onclick      = resetData;
document.getElementById('exportBtn').onclick     = exportToFile;
document.getElementById('importBtn').onclick     = () => document.getElementById('importFileInput').click();
document.getElementById('importFileInput').onchange = (e) => { if(e.target.files[0]) importFromFile(e.target.files[0]); e.target.value = ''; };

document.getElementById('addCategoryForm').onsubmit = async (e) => {
  e.preventDefault();
  const name = document.getElementById('newCategoryName').value.trim();
  if (!name) return;
  data.push({ name, shows: [] });
  saveData();
  document.getElementById('newCategoryName').value = '';
  await render();
};

document.getElementById('ratingFab').onclick = openRandomRating;

// ==================== SERVICE WORKER ====================
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js')
    .then(reg => console.log('Service Worker registrato', reg))
    .catch(err => console.log('SW registrazione fallita', err));
}

// ==================== BOOT ====================
(async () => {
  loadRatings();
  await initData();
  setupSearch();
  await render();
})();
