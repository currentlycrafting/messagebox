// ==================== MOVIE CARD HANDLING ====================
const cardsContainer = document.getElementById('cardsContainer');
const starAnimation = document.getElementById('starAnimation');
const carouselNav = document.querySelector('.carousel-nav');
const carouselPrev = document.querySelector('.carousel-prev');
const carouselNext = document.querySelector('.carousel-next');
const carouselDotsWrap = document.querySelector('.carousel-dots');
const clickCounter = document.getElementById('click-counter');
const counterLikedEl = document.getElementById('counter-liked');
const counterSeenEl = document.getElementById('counter-seen');
const counterLeftEl = document.getElementById('counter-left');
const downloadWatchlistBtn = document.getElementById('downloadWatchlistBtn');
const refreshBtn = document.getElementById('refreshBtn');
let currentCardIndex = 0;
let cardWrappers = [];

// Loading overlay / placeholder
const loadingOverlay = document.getElementById('loadingOverlay');
const retryLoadBtn = document.getElementById('retryLoadBtn');
const copyCashtagBtn = document.getElementById('copyCashtagBtn');
const cashtagEl = document.getElementById('cashtag');
const openCashAppLink = document.getElementById('openCashAppLink');
const supportToast = document.getElementById('supportToast');

// Watch list UI
const watchlistToggle = document.getElementById('watchlistToggle');
const watchlistPanel = document.getElementById('watchlistPanel');
const watchlistCloseBtn = document.getElementById('watchlistCloseBtn');
const watchlistBody = document.getElementById('watchlistBody');
const watchlistEmpty = document.getElementById('watchlistEmpty');
const watchlistCountEl = document.getElementById('watchlistCount');
const modeStatus = document.getElementById('modeStatus');

// Mapping (super mode)
const mappingToggle = document.getElementById('mappingToggle');
const mappingPanel = document.getElementById('mappingPanel');
const mappingCloseBtn = document.getElementById('mappingCloseBtn');
const mappingRadar = document.getElementById('mappingRadar');
const mapGenres = document.getElementById('mapGenres');
const mapDirectors = document.getElementById('mapDirectors');
const mapActors = document.getElementById('mapActors');

// Use same-origin by default (works in Docker). If you serve the HTML from
// a different dev server, set window.API_BASE in the page.
const API_BASE = (typeof window !== 'undefined' && window.API_BASE) ? String(window.API_BASE) : '';

// ====================
// QUEUE / BATCH STATE
// ====================
const DISPLAY_SIZE = 3;
const PREFETCH_WHEN_QUEUE_BELOW = 12;
const PRELOAD_POSTERS_AHEAD = 12;

let movieQueue = [];
let displayedMovies = [];
let isAdvancing = false;
let isPlaceholderMode = false;

let totalLiked = 0;
let totalSeen = 0;

let batchNumber = 0;
let likedThisBatch = [];
let likedPreviousBatch = [];
let currentRound = 1;
let lastSuperProfiles = null;
let superProfilesHistory = [];

// Use a session-level exclusion set to keep batches fresh.
// Stored as "normalizedTitle::year"
const seenMovieKeys = new Set();

// Persist current recommendation state across navigation (same tab)
const RECOMMEND_STATE_KEY = 'odyssey.recommend.state.v2';
const MODE_KEY = 'odyssey.mode';

function getMode() {
  try {
    const raw = window.localStorage.getItem(MODE_KEY);
    return raw === 'super' ? 'super' : 'regular';
  } catch (e) {
    return 'regular';
  }
}

function saveRecommendState() {
  if (isPlaceholderMode) {
    try { sessionStorage.removeItem(RECOMMEND_STATE_KEY); } catch (e) {}
    return;
  }

  try {
    const payload = {
      v: 2,
      saved_at: Date.now(),
      mode: getMode(),
      currentRound,
      lastSuperProfiles,
      superProfilesHistory,
      displayedMovies: Array.isArray(displayedMovies) ? displayedMovies : [],
      movieQueue: Array.isArray(movieQueue) ? movieQueue : [],
      totalSeen: Number.isFinite(Number(totalSeen)) ? Number(totalSeen) : 0,
      batchNumber: Number.isFinite(Number(batchNumber)) ? Number(batchNumber) : 0,
      likedThisBatch: Array.isArray(likedThisBatch) ? likedThisBatch : [],
      likedPreviousBatch: Array.isArray(likedPreviousBatch) ? likedPreviousBatch : [],
      seenMovieKeys: Array.from(seenMovieKeys),
    };
    sessionStorage.setItem(RECOMMEND_STATE_KEY, JSON.stringify(payload));
  } catch (e) {
    // non-fatal
  }
}

function restoreRecommendState() {
  try {
    const raw = sessionStorage.getItem(RECOMMEND_STATE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.v !== 2) return false;
    if (parsed.mode && String(parsed.mode) !== getMode()) return false;

    const restoredDisplayed = Array.isArray(parsed.displayedMovies) ? parsed.displayedMovies : [];
    const restoredQueue = Array.isArray(parsed.movieQueue) ? parsed.movieQueue : [];

    // Must have something meaningful to restore
    if (!restoredDisplayed.length) return false;

    displayedMovies = restoredDisplayed;
    movieQueue = restoredQueue;
    totalSeen = Number.isFinite(Number(parsed.totalSeen)) ? Number(parsed.totalSeen) : 0;
    batchNumber = Number.isFinite(Number(parsed.batchNumber)) ? Number(parsed.batchNumber) : 0;
    likedThisBatch = Array.isArray(parsed.likedThisBatch) ? parsed.likedThisBatch : [];
    likedPreviousBatch = Array.isArray(parsed.likedPreviousBatch) ? parsed.likedPreviousBatch : [];
    currentRound = Number.isFinite(Number(parsed.currentRound)) ? Number(parsed.currentRound) : 1;
    lastSuperProfiles = parsed.lastSuperProfiles || null;
    superProfilesHistory = Array.isArray(parsed.superProfilesHistory) ? parsed.superProfilesHistory : [];

    seenMovieKeys.clear();
    const keys = Array.isArray(parsed.seenMovieKeys) ? parsed.seenMovieKeys : [];
    keys.forEach((k) => { if (k) seenMovieKeys.add(String(k)); });

    isPlaceholderMode = false;
    return true;
  } catch (e) {
    return false;
  }
}

function updateModeStatus() {
  if (!modeStatus) return;
  const mode = getMode();
  const label = mode === 'super' ? 'Super' : 'Regular';
  modeStatus.textContent = isPlaceholderMode ? 'Demo • Round 0' : `${label} • Round ${currentRound}`;
  renderMappingUI();
}

function topEntries(obj, n) {
  const entries = Object.entries(obj || {}).map(([k, v]) => [String(k), Number(v)]).filter(([, v]) => Number.isFinite(v));
  entries.sort((a, b) => b[1] - a[1]);
  return entries.slice(0, n);
}

function entropy01(obj) {
  const entries = Object.entries(obj || {}).map(([, v]) => Number(v)).filter((v) => Number.isFinite(v) && v > 0);
  if (!entries.length) return 0;
  const sum = entries.reduce((s, v) => s + v, 0);
  if (sum <= 0) return 0;
  const probs = entries.map((v) => v / sum).filter((p) => p > 0);
  const h = -probs.reduce((s, p) => s + p * Math.log(p), 0);
  const maxH = Math.log(probs.length || 1);
  if (maxH <= 0) return 0;
  return Math.max(0, Math.min(h / maxH, 1));
}

function coverage01(obj, targetCount) {
  const n = Object.keys(obj || {}).length;
  const t = Math.max(1, Number(targetCount) || 1);
  return Math.max(0, Math.min(n / t, 1));
}

function similarity01(a, b) {
  // Cosine similarity across union keys, normalized to 0..1
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  let dot = 0, na = 0, nb = 0;
  keys.forEach((k) => {
    const va = Number((a || {})[k] || 0);
    const vb = Number((b || {})[k] || 0);
    if (!Number.isFinite(va) || !Number.isFinite(vb)) return;
    dot += va * vb;
    na += va * va;
    nb += vb * vb;
  });
  if (na <= 0 || nb <= 0) return 0;
  const cos = dot / (Math.sqrt(na) * Math.sqrt(nb));
  return Math.max(0, Math.min(cos, 1));
}

function categoryStrength(obj) {
  const t = topEntries(obj, 5);
  if (!t.length) return 0;
  const avg = t.reduce((s, [, v]) => s + v, 0) / t.length;
  return Math.max(0, Math.min(avg, 1));
}

function drawRadar(canvas, values, prevValues) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(w, h) * 0.34;
  const labels = ['Genres', 'Directors', 'Actors', 'Diversity', 'Coverage', 'Stability'];
  const vals = [
    values.genres,
    values.directors,
    values.actors,
    values.diversity,
    values.coverage,
    values.stability,
  ];
  const count = labels.length;
  const angles = Array.from({ length: count }, (_, i) => (-Math.PI / 2) + (2 * Math.PI * i) / count);

  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 2;
  for (let step = 1; step <= 4; step++) {
    const rr = (r * step) / 4;
    ctx.beginPath();
    angles.forEach((a, i) => {
      const x = cx + Math.cos(a) * rr;
      const y = cy + Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.stroke();
  }
  angles.forEach((a) => {
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    ctx.stroke();
  });

  function drawPoly(vs, fill, stroke, dashed) {
    ctx.save();
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 3;
    if (dashed) ctx.setLineDash([8, 6]);
    ctx.beginPath();
    angles.forEach((a, i) => {
      const rr = r * Math.max(0, Math.min(Number(vs[i]) || 0, 1));
      const x = cx + Math.cos(a) * rr;
      const y = cy + Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  if (prevValues && Array.isArray(prevValues) && prevValues.length === count) {
    drawPoly(prevValues, 'rgba(255,255,255,0.06)', 'rgba(255,255,255,0.32)', true);
  }
  drawPoly(vals, 'rgba(76,175,80,0.18)', 'rgba(76,175,80,0.78)', false);

  ctx.fillStyle = 'rgba(255,255,255,0.82)';
  ctx.font = '700 13px Inter, system-ui, -apple-system, Segoe UI, Arial';
  labels.forEach((lab, i) => {
    const a = angles[i];
    const x = cx + Math.cos(a) * (r + 18);
    const y = cy + Math.sin(a) * (r + 18);
    ctx.textAlign = (Math.cos(a) > 0.2) ? 'left' : (Math.cos(a) < -0.2 ? 'right' : 'center');
    ctx.textBaseline = (Math.sin(a) > 0.2) ? 'top' : (Math.sin(a) < -0.2 ? 'bottom' : 'middle');
    ctx.fillText(lab, x, y);
  });
}

function renderChips(container, entries) {
  if (!container) return;
  container.innerHTML = '';
  entries.forEach(([k, v]) => {
    const chip = document.createElement('div');
    chip.className = 'mapping-chip';
    chip.innerHTML = `<b>${k}</b><span>${Math.round(v * 100)}%</span>`;
    container.appendChild(chip);
  });
}

function renderMappingUI() {
  const mode = getMode();
  const show = mode === 'super' && !isPlaceholderMode;
  if (mappingToggle) mappingToggle.style.display = show ? '' : 'none';
  if (!mappingPanel) return;
  if (!show) {
    mappingPanel.classList.remove('open');
    if (mappingToggle) mappingToggle.setAttribute('aria-expanded', 'false');
    return;
  }

  // Only render heavy stuff when open
  if (!mappingPanel.classList.contains('open')) return;

  const profiles = lastSuperProfiles || {};
  const genreProfile = profiles.genreProfile || {};
  const directorProfile = profiles.directorProfile || {};
  const actorProfile = profiles.actorProfile || {};

  renderChips(mapGenres, topEntries(genreProfile, 10));
  renderChips(mapDirectors, topEntries(directorProfile, 8));
  renderChips(mapActors, topEntries(actorProfile, 10));

  const current = {
    genres: categoryStrength(genreProfile),
    directors: categoryStrength(directorProfile),
    actors: categoryStrength(actorProfile),
    diversity: entropy01(genreProfile),
    coverage: (coverage01(genreProfile, 12) + coverage01(actorProfile, 15) + coverage01(directorProfile, 10)) / 3,
    stability: 1,
  };

  let prev = null;
  if (superProfilesHistory.length >= 2) {
    const prevProfiles = superProfilesHistory[superProfilesHistory.length - 2] || {};
    const pg = prevProfiles.genreProfile || {};
    const pd = prevProfiles.directorProfile || {};
    const pa = prevProfiles.actorProfile || {};
    current.stability = (similarity01(genreProfile, pg) + similarity01(directorProfile, pd) + similarity01(actorProfile, pa)) / 3;
    prev = [
      categoryStrength(pg),
      categoryStrength(pd),
      categoryStrength(pa),
      entropy01(pg),
      (coverage01(pg, 12) + coverage01(pa, 15) + coverage01(pd, 10)) / 3,
      1,
    ];
  }

  drawRadar(mappingRadar, current, prev);
}

function toggleMapping(open) {
  if (!mappingPanel) return;
  const shouldOpen = typeof open === 'boolean' ? open : !mappingPanel.classList.contains('open');
  mappingPanel.classList.toggle('open', shouldOpen);
  if (mappingToggle) mappingToggle.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
  renderMappingUI();
}

// In-memory watch list (liked movies) for this page session
let watchlist = [];
const watchlistKeys = new Set();

// Random cashtag rotation (balanced over time)
const CASH_APP_CHOICES = [
  { tag: '$sunni134', url: 'https://cash.app/$sunni134' },
  { tag: '$Khalidm223', url: 'https://cash.app/$Khalidm223' },
];
let cashtagBag = [];

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function pickCashtagChoice() {
  if (!cashtagBag.length) cashtagBag = shuffleInPlace(CASH_APP_CHOICES.slice());
  return cashtagBag.pop();
}

function applyRandomCashtag() {
  const choice = pickCashtagChoice();
  if (cashtagEl) cashtagEl.textContent = choice.tag;
  if (openCashAppLink) openCashAppLink.href = choice.url;
}

let currentLoadingMode = 'init'; // 'init' | 'batch'

const PLACEHOLDER_MOVIES = [
  {
    title: 'Oppenheimer',
    year: '2023',
    director: 'Christopher Nolan',
    image: 'images/oppenheimer.jpg',
    placeholder: true,
  },
  {
    title: 'The Dark Knight',
    year: '2008',
    director: 'Christopher Nolan',
    image: 'images/dark-knight.jpg',
    placeholder: true,
  },
  {
    title: 'Interstellar',
    year: '2014',
    director: 'Christopher Nolan',
    image: 'images/interstellar.jpg',
    placeholder: true,
  },
];

function normalizeTitle(value) {
  return String(value || '').trim().toLowerCase();
}

function movieKey(movie) {
  const title = normalizeTitle(movie && movie.title);
  const year = String((movie && movie.year) || '').trim();
  return `${title}::${year}`;
}

function setLoading(active, { message = '', showRetry = false } = {}) {
  if (!loadingOverlay) return;
  if (active) applyRandomCashtag();
  loadingOverlay.classList.toggle('active', Boolean(active));
  loadingOverlay.setAttribute('aria-busy', active ? 'true' : 'false');
  if (supportToast && message) supportToast.textContent = String(message);
  if (retryLoadBtn) retryLoadBtn.style.display = showRetry ? '' : 'none';
}

function updateCounterUI() {
  const liked = Number.isFinite(Number(totalLiked)) ? Number(totalLiked) : 0;
  const seen = Number.isFinite(Number(totalSeen)) ? Number(totalSeen) : 0;
  const left = Array.isArray(movieQueue) ? movieQueue.length : 0;

  // New UI (preferred)
  if (counterLikedEl) counterLikedEl.textContent = String(liked);
  if (counterSeenEl) counterSeenEl.textContent = String(seen);
  if (counterLeftEl) counterLeftEl.textContent = String(left);

  // Backward compatible fallback
  if (!counterLikedEl && clickCounter) {
    clickCounter.textContent = String(liked);
  }
}

function getBatchSizeForMode() {
  return getMode() === 'super' ? 50 : 80;
}

function updateWatchlistCount() {
  if (!watchlistCountEl) return;
  watchlistCountEl.textContent = String(Array.isArray(watchlist) ? watchlist.length : 0);
}

function escapeCsv(value) {
  const s = String(value ?? '');
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadWatchlistCsv() {
  const rows = Array.isArray(watchlist) ? watchlist : [];
  const header = ['title', 'year', 'director', 'poster_url'];
  const lines = [header.join(',')];
  for (const m of rows) {
    lines.push([
      escapeCsv(m && m.title ? m.title : ''),
      escapeCsv(m && m.year ? m.year : ''),
      escapeCsv(m && m.director ? m.director : ''),
      escapeCsv(m && m.image ? m.image : ''),
    ].join(','));
  }

  const csv = lines.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  a.href = url;
  a.download = `watchlist-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function toggleWatchlist(open) {
  if (!watchlistPanel) return;
  const shouldOpen = typeof open === 'boolean' ? open : !watchlistPanel.classList.contains('open');
  watchlistPanel.classList.toggle('open', shouldOpen);
  if (watchlistToggle) watchlistToggle.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
}

function preloadOnePoster(url) {
  const u = url ? String(url) : '';
  if (!u) return;
  const img = new Image();
  img.decoding = 'async';
  img.loading = 'eager';
  img.src = u;
}

function renderWatchlistItem(movie) {
  if (!watchlistBody) return;
  if (watchlistEmpty) watchlistEmpty.style.display = 'none';

  const title = movie && movie.title ? String(movie.title) : '';
  const year = movie && movie.year ? String(movie.year) : '';
  const director = movie && movie.director ? String(movie.director) : '';
  const image = movie && movie.image ? String(movie.image) : '';
  preloadOnePoster(image);

  const item = document.createElement('div');
  item.className = 'watchlist-item';
  item.dataset.key = movieKey(movie);

  const poster = document.createElement('div');
  poster.className = 'watchlist-poster';
  const img = document.createElement('img');
  img.src = image || 'default_poster.svg';
  img.alt = `${title || 'Movie'} poster`;
  img.onerror = () => {
    img.src = 'default_poster.svg';
    img.style.display = '';
  };
  poster.appendChild(img);

  const meta = document.createElement('div');
  meta.className = 'watchlist-meta';
  const titleEl = document.createElement('div');
  titleEl.className = 'wl-title';
  titleEl.textContent = `${title}${year ? ` (${year})` : ''}`;
  const subEl = document.createElement('div');
  subEl.className = 'wl-sub';
  subEl.textContent = director || '';
  meta.appendChild(titleEl);
  meta.appendChild(subEl);

  const actions = document.createElement('div');
  actions.className = 'wl-actions';

  const copyBtn = document.createElement('button');
  copyBtn.className = 'wl-copy';
  copyBtn.type = 'button';
  copyBtn.textContent = '⧉';
  copyBtn.setAttribute('aria-label', `Copy ${title}${year ? ` (${year})` : ''}`);
  copyBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const text = `${title}${year ? ` (${year})` : ''}`.trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      copyBtn.textContent = '✓';
      window.setTimeout(() => { copyBtn.textContent = '⧉'; }, 900);
    } catch (err) {
      copyBtn.textContent = '!';
      window.setTimeout(() => { copyBtn.textContent = '⧉'; }, 900);
    }
  });

  const removeBtn = document.createElement('button');
  removeBtn.className = 'wl-remove';
  removeBtn.type = 'button';
  removeBtn.textContent = '×';
  removeBtn.setAttribute('aria-label', `Remove ${title} from watch list`);
  removeBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const key = item.dataset.key || '';
    // Update UI immediately
    watchlist = watchlist.filter((m) => movieKey(m) !== key);
    watchlistKeys.delete(key);
    item.remove();
    if (watchlistEmpty) watchlistEmpty.style.display = watchlist.length ? 'none' : '';
    updateWatchlistCount();
    // Best-effort backend sync
    try {
      await fetch(`${API_BASE}/api/watchlist/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
    } catch (err) {
      // non-fatal
    }
  });

  item.appendChild(poster);
  item.appendChild(meta);
  actions.appendChild(copyBtn);
  actions.appendChild(removeBtn);
  item.appendChild(actions);

  // Insert newest at top
  watchlistBody.insertBefore(item, watchlistBody.firstChild);
}

function addToWatchlist(movie) {
  const key = movieKey(movie);
  if (!key || watchlistKeys.has(key)) return;
  watchlistKeys.add(key);
  watchlist.unshift({
    title: movie && movie.title ? String(movie.title) : '',
    year: movie && movie.year ? String(movie.year) : '',
    director: movie && movie.director ? String(movie.director) : '',
    image: movie && movie.image ? String(movie.image) : '',
  });
  renderWatchlistItem(movie);
  updateWatchlistCount();
}

async function fetchWatchlist() {
  try {
    const response = await fetch(`${API_BASE}/api/watchlist`);
    if (!response.ok) return;
    const list = await response.json().catch(() => null);
    if (!Array.isArray(list)) return;

    watchlist = [];
    watchlistKeys.clear();
    if (watchlistBody) {
      Array.from(watchlistBody.querySelectorAll('.watchlist-item')).forEach((n) => n.remove());
    }
    if (watchlistEmpty) watchlistEmpty.style.display = list.length ? 'none' : '';

    // Backend stores watchlist in click order (oldest -> newest).
    // `addToWatchlist()` inserts at the top, so iterating forward keeps newest at top.
    list.forEach((m) => addToWatchlist(m));
    updateWatchlistCount();
  } catch (error) {
    // non-fatal
  }
}

function showDeltaAnimation(x, y, delta) {
  const el = document.createElement('div');
  el.className = 'floating-click-number';
  const safeDelta = Number.isFinite(Number(delta)) ? Number(delta) : 1;
  el.textContent = safeDelta >= 0 ? `+${safeDelta}` : String(safeDelta);
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  document.body.appendChild(el);

  window.setTimeout(() => {
    el.remove();
  }, 900);
}

async function checkCsvUploaded() {
  try {
    const response = await fetch(`${API_BASE}/api/csv-status`);
    const json = await response.json().catch(() => null);
    if (!response.ok || !json) return false;
    return Boolean(json.csv_uploaded);
  } catch (err) {
    return false;
  }
}

async function fetchClickCount() {
  try {
    const response = await fetch(`${API_BASE}/api/click-count`);
    if (!response.ok) return;
    const json = await response.json();
    if (!json || typeof json.count !== 'number') return;
    totalLiked = json.count;
    updateCounterUI();
  } catch (error) {
    // non-fatal
  }
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function preloadPosters(movies) {
  safeArray(movies).slice(0, PRELOAD_POSTERS_AHEAD).forEach((m) => {
    const url = m && m.image ? String(m.image) : '';
    if (!url) return;
    const img = new Image();
    img.decoding = 'async';
    img.loading = 'eager';
    img.src = url;
  });
}

function attachPosterFallback(imgEl) {
  if (!imgEl) return;
  imgEl.addEventListener('error', () => {
    const fallback = 'default_poster.svg';
    if (imgEl.src && imgEl.src.includes(fallback)) return;
    imgEl.src = fallback;
    imgEl.style.display = '';
  }, { once: true });
}

async function fetchBatchIfNeeded() {
  // Intentionally a no-op.
  // We only fetch a new 40-movie batch once the current batch is exhausted,
  // so the next batch can use the completed batch's likes as context.
}

let batchFetchPromise = null;
async function fetchNextBatch() {
  if (batchFetchPromise) return batchFetchPromise;

  batchFetchPromise = (async () => {
    try {
    const exclude_keys = Array.from(seenMovieKeys);
    const response = await fetch(`${API_BASE}/api/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        batch_size: getBatchSizeForMode(),
        mode: getMode(),
        liked_titles: likedPreviousBatch,
        exclude_keys,
      }),
    });

    const json = await response.json().catch(() => null);
    const movies = json && Array.isArray(json.movies) ? json.movies : [];
    if (json && json.profiles && getMode() === 'super') {
      lastSuperProfiles = json.profiles;
      superProfilesHistory = Array.isArray(superProfilesHistory) ? superProfilesHistory : [];
      superProfilesHistory.push(json.profiles);
      if (superProfilesHistory.length > 12) superProfilesHistory = superProfilesHistory.slice(-12);
    }

    if (!response.ok) {
      const msg = (json && json.error) ? String(json.error) : 'Batch fetch failed';
      throw new Error(msg);
    }

    if (!movies.length) {
      // Don't hard-fail: just keep UI stable and allow user to retry.
      return false;
    }

    batchNumber += 1;
    likedThisBatch = [];
    likedPreviousBatch = [];
    updateModeStatus();

    movies.forEach((m) => {
      const key = movieKey(m);
      if (!key || seenMovieKeys.has(key)) return;
      seenMovieKeys.add(key);
      movieQueue.push(m);
    });

    preloadPosters(movieQueue);
    updateCounterUI();
    saveRecommendState();
    return true;
    } catch (error) {
      console.error(error);
      return false;
    }
  })();

  try {
    return await batchFetchPromise;
  } finally {
    batchFetchPromise = null;
  }
}

function popNextMovies(n) {
  const out = [];
  while (out.length < n && movieQueue.length) {
    out.push(movieQueue.shift());
  }
  return out;
}

async function initRecommendations() {
  try {
    if (!cardsContainer) return;
    cardsContainer.innerHTML = `<div class="loading-text">Loading recommendations...</div>`;
    currentLoadingMode = 'init';
    setLoading(true, { message: 'Loading…', showRetry: false });

    // First batch: no likes context
    likedPreviousBatch = [];
    currentRound = 1;
    lastSuperProfiles = null;
    superProfilesHistory = [];
    updateModeStatus();
    const ok = await fetchNextBatch();
    if (!ok) throw new Error('Failed to fetch batch');

    displayedMovies = popNextMovies(DISPLAY_SIZE);
    if (!displayedMovies.length) {
      cardsContainer.innerHTML = `<div class="loading-text">No recommendations yet. Upload your CSV on the home page.</div>`;
      if (carouselNav) carouselNav.style.display = 'none';
      updateCounterUI();
      setLoading(false);
      return;
    }

    renderMovieCards(displayedMovies);
    preloadPosters(movieQueue);
    updateCounterUI();
    setLoading(false);
    saveRecommendState();
  } catch (error) {
    console.error(error);
    // Fallback: show demo cards if CSV is missing/corrupted or batch fails
    setLoading(false);
    initPlaceholders();
    if (supportToast) supportToast.textContent = 'Upload a CSV to unlock real recommendations.';
  }
}

function initPlaceholders() {
  isPlaceholderMode = true;
  movieQueue = [];
  displayedMovies = PLACEHOLDER_MOVIES.slice(0, DISPLAY_SIZE);
  totalSeen = 0;
  currentRound = 0;
  updateCounterUI();
  updateModeStatus();
  setLoading(false);
  renderMovieCards(displayedMovies);
  saveRecommendState();
}

// Render movie cards dynamically
function renderMovieCards(movies, preserveIndex = 0) {
  cardsContainer.innerHTML = '';
  currentCardIndex = preserveIndex;
  
  movies.forEach((movie, index) => {
    const isLocked = Boolean(movie && movie.placeholder);
    const cardWrapper = document.createElement('div');
    cardWrapper.className = `card-wrapper${isLocked ? ' is-locked' : ''}`;
    cardWrapper.dataset.title = movie.title;
    cardWrapper.dataset.director = movie.director;
    cardWrapper.dataset.year = movie.year;
    
    cardWrapper.innerHTML = `
      <div class="product-card">
        <div class="card-image">
          <img src="${movie.image || 'default_poster.svg'}" alt="${movie.title} poster">
          ${isLocked ? `
            <div class="lock-overlay" aria-label="Upload CSV to unlock">
              <div class="lock-pill">
                <svg class="lock-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                  <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                </svg>
                <span>Upload CSV to Unlock</span>
              </div>
            </div>
          ` : ''}
        </div>
        <div class="card-body">
          <p class="card-title">Title: ${movie.title} (${movie.year})</p>
          <p class="card-subtitle">Director: ${movie.director}</p>
        </div>
      </div>
      <div class="card-action">
        <button class="icon-btn icon-btn-filled favorite-btn" aria-label="Add ${movie.title} to favorites">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
          </svg>
        </button>
      </div>
    `;
    
    cardsContainer.appendChild(cardWrapper);
    
    // Add click handlers
    const productCard = cardWrapper.querySelector('.product-card');
    const favoriteBtn = cardWrapper.querySelector('.favorite-btn');
    const img = cardWrapper.querySelector('.card-image img');
    attachPosterFallback(img);

    // Stable slot index so handlers always use the *current* displayed movie
    cardWrapper.dataset.slot = String(index);
    
    // Card click handler
    productCard.addEventListener('click', async (event) => {
      const slot = Number(cardWrapper.dataset.slot || index);
      const currentMovie = (Array.isArray(displayedMovies) && displayedMovies[slot]) ? displayedMovies[slot] : movie;
      if (!favoriteBtn.classList.contains('active')) {
        await handleLike(currentMovie, cardWrapper, slot, event);
      }
      favoriteBtn.classList.add('active');
    });
    
    // Star button click handler
    favoriteBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      const slot = Number(cardWrapper.dataset.slot || index);
      const currentMovie = (Array.isArray(displayedMovies) && displayedMovies[slot]) ? displayedMovies[slot] : movie;
      if (!favoriteBtn.classList.contains('active')) {
        await handleLike(currentMovie, cardWrapper, slot, event);
      }
      favoriteBtn.classList.add('active');
    });
  });

  // Setup carousel (small aspect ratio)
  cardWrappers = Array.from(cardsContainer.querySelectorAll('.card-wrapper'));
  setupCarousel(cardWrappers.length);

  // Keep the same card centered on small screens after re-render.
  window.requestAnimationFrame(() => {
    scrollToCard(currentCardIndex);
    updateCarouselUI();
  });
}

let currentAnimatingCard = null;
let starAnimTimeoutId = null;

// Handle card/star like click
async function handleLike(movie, cardWrapper, cardIndex, event) {
  if (isAdvancing) return;
  playStarAnimation(cardWrapper);

  const clickX = event && typeof event.clientX === 'number' ? event.clientX : window.innerWidth / 2;
  const clickY = event && typeof event.clientY === 'number' ? event.clientY : window.innerHeight / 2;

  // Placeholder mode: animate only (no counter/watchlist/backend)
  if (isPlaceholderMode || (movie && movie.placeholder)) {
    const favoriteBtn = cardWrapper ? cardWrapper.querySelector('.favorite-btn') : null;
    if (favoriteBtn) favoriteBtn.classList.add('active');

    // Flip "in place" (swap to the same content)
    window.setTimeout(() => {
      // Reuse the flip animation but keep the same displayed set
      if (Array.isArray(cardWrappers) && cardWrappers.length) {
        cardWrappers.forEach((cw) => cw.classList.add('is-flipping'));
        window.setTimeout(() => {
          cardWrappers.forEach((cw) => {
            const pc = cw.querySelector('.product-card');
            if (!pc) return;
            pc.style.transition = 'none';
            pc.style.transform = 'rotateY(-90deg)';
            void pc.offsetWidth;
            cw.classList.remove('is-flipping');
            pc.style.transition = 'transform 320ms cubic-bezier(0.2, 0.75, 0.2, 1)';
            pc.style.transform = 'rotateY(0deg)';
            window.setTimeout(() => {
              pc.style.transition = '';
              pc.style.transform = '';
            }, 340);
          });
        }, 270);
      }

      // Let the "green button" pop, then reset so user can demo-click repeatedly
      window.setTimeout(() => {
        if (favoriteBtn) favoriteBtn.classList.remove('active');
      }, 700);
    }, 320);
    return;
  }

  // Optimistic local update for UX
  totalLiked += 1;
  updateCounterUI();
  showDeltaAnimation(clickX, clickY, 1);

  // Add to watch list immediately
  addToWatchlist(movie);

  const title = String(movie && movie.title ? movie.title : '').trim();
  if (title) likedThisBatch.push(title);
  saveRecommendState();

  // Fire-and-forget backend tracking (do not block animation)
  void trackMovieLike(movie).then((result) => {
    if (result && typeof result.total_clicks === 'number') {
      totalLiked = result.total_clicks;
      updateCounterUI();
    }
  });

  // Satisfying delay before we flip/replace the set
  window.setTimeout(() => {
    void advanceToNextSet(cardIndex);
  }, 420);
}

// Play star burst animation
// - Clicking the same card again during the animation does nothing
// - Clicking a different card will play immediately (moves the overlay)
function playStarAnimation(cardWrapper) {
  if (!cardWrapper) return;

  // If this same card is already animating, don't restart/cut it off
  if (currentAnimatingCard === cardWrapper && starAnimation.classList.contains('active')) {
    return;
  }

  // If switching cards mid-animation, clean up the previous card state
  if (currentAnimatingCard && currentAnimatingCard !== cardWrapper) {
    currentAnimatingCard.classList.remove('card-clicked');
  }

  currentAnimatingCard = cardWrapper;

  const rect = cardWrapper.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  
  starAnimation.style.left = `${centerX}px`;
  starAnimation.style.top = `${centerY}px`;
  
  cardWrapper.classList.add('card-clicked');

  // Restart overlay animation cleanly
  if (starAnimTimeoutId) {
    clearTimeout(starAnimTimeoutId);
    starAnimTimeoutId = null;
  }
  starAnimation.classList.remove('active');
  void starAnimation.offsetWidth;
  starAnimation.classList.add('active');

  starAnimTimeoutId = setTimeout(() => {
    // Only clear if we haven't switched to another card meanwhile
    if (currentAnimatingCard === cardWrapper) {
      starAnimation.classList.remove('active');
      cardWrapper.classList.remove('card-clicked');
      currentAnimatingCard = null;
      starAnimTimeoutId = null;
    }
  }, 1000);
}

// Send like data to Flask backend (no recommendation replacement)
async function trackMovieLike(movie) {
  try {
    const response = await fetch(`${API_BASE}/api/like`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        title: movie && movie.title,
        year: movie && movie.year,
        director: movie && movie.director,
        image: movie && movie.image,
      })
    });
    
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      console.error('Click failed:', data);
      return null;
    }
    return data;
  } catch (error) {
    console.error('Error tracking click:', error);
    return null;
  }
}

function setCardContent(cardWrapper, movie) {
  if (!cardWrapper) return;

  const title = movie && movie.title ? String(movie.title) : '';
  const year = movie && movie.year ? String(movie.year) : '';
  const director = movie && movie.director ? String(movie.director) : '';

  cardWrapper.dataset.title = title;
  cardWrapper.dataset.director = director;
  cardWrapper.dataset.year = year;

  const img = cardWrapper.querySelector('.card-image img');
  if (img) {
    const url = movie && movie.image ? String(movie.image) : '';
    img.style.display = '';
    img.src = url || 'default_poster.svg';
    img.alt = `${title || 'Movie'} poster`;
    attachPosterFallback(img);
  }

  const titleEl = cardWrapper.querySelector('.card-title');
  const subtitleEl = cardWrapper.querySelector('.card-subtitle');
  if (titleEl) titleEl.textContent = year ? `Title: ${title} (${year})` : `Title: ${title}`;
  if (subtitleEl) subtitleEl.textContent = director ? `Director: ${director}` : 'Director:';

  const favoriteBtn = cardWrapper.querySelector('.favorite-btn');
  if (favoriteBtn) {
    favoriteBtn.classList.remove('active');
    favoriteBtn.setAttribute('aria-label', `Add ${title} to favorites`);
  }
}

async function advanceToNextSet(preserveIndex = 0) {
  if (isAdvancing) return;
  if (!cardsContainer) return;
  if (!Array.isArray(cardWrappers) || !cardWrappers.length) return;

  // Placeholder mode: flip in place (demo only)
  if (isPlaceholderMode) {
    isAdvancing = true;
    cardWrappers.forEach((cw) => cw.classList.add('is-flipping'));
    window.setTimeout(() => {
      cardWrappers.forEach((cw) => {
        const pc = cw.querySelector('.product-card');
        if (!pc) return;
        pc.style.transition = 'none';
        pc.style.transform = 'rotateY(-90deg)';
        void pc.offsetWidth;
        cw.classList.remove('is-flipping');
        pc.style.transition = 'transform 320ms cubic-bezier(0.2, 0.75, 0.2, 1)';
        pc.style.transform = 'rotateY(0deg)';
        window.setTimeout(() => {
          pc.style.transition = '';
          pc.style.transform = '';
        }, 340);
      });
      window.setTimeout(() => { isAdvancing = false; }, 380);
    }, 270);
    return;
  }

  isAdvancing = true;

  // If we've exhausted the batch, carry likes forward as context.
  // This gives "fresh but taste-aware" next batch recommendations.
  if (movieQueue.length < DISPLAY_SIZE) {
    currentLoadingMode = 'batch';
    setLoading(true, { message: 'Refreshing recommendations…', showRetry: false });
    likedPreviousBatch = safeArray(likedThisBatch);
    likedThisBatch = [];
    const prevRound = currentRound;
    currentRound += 1;
    updateModeStatus();
    const ok = await fetchNextBatch();
    if (!ok) {
      currentRound = prevRound;
      updateModeStatus();
      setLoading(true, { message: 'Failed to refresh. You can retry.', showRetry: true });
      isAdvancing = false;
      return;
    }
    setLoading(false);
  }

  // Lazy prefetch for smoothness
  // (no-op by design; see fetchBatchIfNeeded)

  const nextSet = popNextMovies(DISPLAY_SIZE);
  if (nextSet.length < DISPLAY_SIZE) {
    isAdvancing = false;
    return;
  }

  // Count that we've "seen" the previous cards once we advance
  totalSeen += displayedMovies.length;
  displayedMovies = nextSet;
  updateCounterUI();
  saveRecommendState();

  // Flip-out all cards
  cardWrappers.forEach((cw) => cw.classList.add('is-flipping'));

  // At midpoint (edge-on), swap content, then flip back in
  window.setTimeout(() => {
    cardWrappers.forEach((cw, i) => {
      const pc = cw.querySelector('.product-card');
      if (!pc) return;

      // Swap content while hidden
      const nextMovie = nextSet[i];
      if (nextMovie) setCardContent(cw, nextMovie);

      // Prepare flip-in from the other side
      pc.style.transition = 'none';
      pc.style.transform = 'rotateY(-90deg)';
      void pc.offsetWidth;

      cw.classList.remove('is-flipping');
      pc.style.transition = 'transform 320ms cubic-bezier(0.2, 0.75, 0.2, 1)';
      pc.style.transform = 'rotateY(0deg)';

      window.setTimeout(() => {
        pc.style.transition = '';
        pc.style.transform = '';
      }, 340);
    });

    // Keep same card centered on small screens after swap
    currentCardIndex = preserveIndex;
    window.requestAnimationFrame(() => {
      scrollToCard(currentCardIndex);
      updateCarouselUI();
    });

    window.setTimeout(() => {
      isAdvancing = false;
      saveRecommendState();
    }, 380);
  }, 270);
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  fetchClickCount();
  fetchWatchlist();
  updateCounterUI();
  setLoading(false);
  updateModeStatus();

  // Decide placeholder vs real recommendations
  void (async () => {
    const uploaded = await checkCsvUploaded();
    if (!uploaded) {
      // No CSV: show demo cards immediately, no loading overlay
      initPlaceholders();
      return;
    }
    // CSV exists: restore prior batch if available; otherwise cold start
    const restored = restoreRecommendState();
    if (restored) {
      setLoading(false);
      renderMovieCards(displayedMovies);
      preloadPosters(movieQueue);
      updateCounterUI();
      updateModeStatus();
      return;
    }
    isPlaceholderMode = false;
    await initRecommendations();
  })();

  // Placeholder support: copy cashtag
  if (copyCashtagBtn && cashtagEl) {
    copyCashtagBtn.addEventListener('click', async () => {
      const text = String(cashtagEl.textContent || '').trim();
      try {
        await navigator.clipboard.writeText(text);
        if (supportToast) supportToast.textContent = 'Copied.';
      } catch (e) {
        if (supportToast) supportToast.textContent = 'Copy failed.';
      }
      window.clearTimeout(copyCashtagBtn._t);
      copyCashtagBtn._t = window.setTimeout(() => {
        if (supportToast) supportToast.textContent = '';
      }, 1200);
    });
  }

  if (retryLoadBtn) {
    retryLoadBtn.addEventListener('click', async () => {
      setLoading(true, { message: 'Retrying…', showRetry: false });
      if (currentLoadingMode === 'batch') {
        const ok = await fetchNextBatch();
        if (ok) setLoading(false);
        else setLoading(true, { message: 'Still failing. Try again in a moment.', showRetry: true });
        return;
      }
      isPlaceholderMode = false;
      await initRecommendations();
    });
  }

  // Watch list panel toggles
  if (watchlistToggle) watchlistToggle.addEventListener('click', () => toggleWatchlist());
  if (watchlistCloseBtn) watchlistCloseBtn.addEventListener('click', () => toggleWatchlist(false));

  // Mapping panel toggles (super mode only)
  if (mappingToggle) mappingToggle.addEventListener('click', () => toggleMapping());
  if (mappingCloseBtn) mappingCloseBtn.addEventListener('click', () => toggleMapping(false));
  renderMappingUI();

  // Download CSV
  if (downloadWatchlistBtn) {
    downloadWatchlistBtn.addEventListener('click', () => {
      if (!watchlist || !watchlist.length) {
        window.alert('Watch list is empty yet. Like a movie to add it.');
        return;
      }
      downloadWatchlistCsv();
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      try {
        await advanceToNextSet(0);
      } catch (error) {
        console.error(error);
        window.alert('Failed to refresh recommendations.');
      }
    });
  }
});

function isSmallScreenCarousel() {
  return window.matchMedia('(max-width: 768px)').matches;
}

function scrollToCard(index) {
  if (!cardsContainer || !cardWrappers[index]) return;

  if (!isSmallScreenCarousel()) return; // larger layouts show all cards

  cardsContainer.scrollTo({
    top: cardWrappers[index].offsetTop,
    behavior: 'smooth'
  });
}

function updateCarouselUI() {
  if (!carouselDotsWrap) return;
  const dots = Array.from(carouselDotsWrap.querySelectorAll('.carousel-dot'));
  dots.forEach((dot, i) => dot.classList.toggle('active', i === currentCardIndex));
  if (carouselPrev) carouselPrev.disabled = currentCardIndex === 0;
  if (carouselNext) carouselNext.disabled = currentCardIndex === cardWrappers.length - 1;
}

function setupCarousel(total) {
  if (!carouselDotsWrap || !carouselPrev || !carouselNext) return;

  // build dots
  carouselDotsWrap.innerHTML = '';
  for (let i = 0; i < total; i++) {
    const dot = document.createElement('button');
    dot.className = `carousel-dot${i === 0 ? ' active' : ''}`;
    dot.type = 'button';
    dot.dataset.index = String(i);
    dot.addEventListener('click', () => {
      currentCardIndex = i;
      scrollToCard(currentCardIndex);
      updateCarouselUI();
    });
    carouselDotsWrap.appendChild(dot);
  }

  carouselPrev.onclick = () => {
    if (currentCardIndex > 0) {
      currentCardIndex--;
      scrollToCard(currentCardIndex);
      updateCarouselUI();
    }
  };

  carouselNext.onclick = () => {
    if (currentCardIndex < cardWrappers.length - 1) {
      currentCardIndex++;
      scrollToCard(currentCardIndex);
      updateCarouselUI();
    }
  };

  // Sync when user scrolls vertically (swipe)
  let t = null;
  cardsContainer.addEventListener('scroll', () => {
    if (!isSmallScreenCarousel()) return;
    window.clearTimeout(t);
    t = window.setTimeout(() => {
      const top = cardsContainer.scrollTop;
      let best = 0;
      let dist = Infinity;
      cardWrappers.forEach((cw, idx) => {
        const d = Math.abs(cw.offsetTop - top);
        if (d < dist) { dist = d; best = idx; }
      });
      if (best !== currentCardIndex) {
        currentCardIndex = best;
        updateCarouselUI();
      }
    }, 80);
  }, { passive: true });

  window.addEventListener('resize', () => {
    // keep centered layout on larger sizes
    if (!isSmallScreenCarousel()) currentCardIndex = 0;
    updateCarouselUI();
  });

  updateCarouselUI();
}
