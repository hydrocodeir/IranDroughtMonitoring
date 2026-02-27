const API_BASE = window.API_BASE_URL || "http://localhost:8000";

// Keep Bootstrap direction consistent with document direction.
// Default is LTR, but RTL remains supported when <html dir="rtl">.
function syncBootstrapDir() {
  const dir = String(document.documentElement.getAttribute('dir') || 'ltr').toLowerCase();
  const ltr = document.getElementById('bootstrapCss');
  const rtl = document.getElementById('bootstrapRtlCss');
  if (!ltr || !rtl) return;
  const useRtl = dir === 'rtl';
  rtl.disabled = !useRtl;
  ltr.disabled = useRtl;
}

async function loadDatasetsList() {
  // Populate the dataset (level) selector from the backend registry.
  // Falls back to a single "station" option if /datasets is unavailable.
  let datasets = [];
  try {
    datasets = await fetchJson(`${API_BASE}/datasets`);
  } catch (_) {
    datasets = [{ key: 'station', title: levelLabels.station || 'station' }];
  }

  datasetTitles.clear();
  levelEl.innerHTML = '';

  datasets.forEach((d) => {
    const rawKey = d.key || d.dataset_key || d.level || d.name;
    if (!rawKey) return;
    // Canonicalize to lower-case so URLs are stable. The backend resolves
    // dataset keys case-insensitively.
    const key = String(rawKey).trim().toLowerCase();
    const title = d.title || levelLabels[key] || String(rawKey);
    datasetTitles.set(key, title);
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = title;
    levelEl.appendChild(opt);
  });

  if (!levelEl.value && levelEl.options.length) {
    levelEl.value = levelEl.options[0].value;
  }
}

async function loadMetaForSelectedDataset() {
  const level = levelEl.value || 'station';
  const meta = await fetchJson(`${API_BASE}/meta?level=${encodeURIComponent(level)}`);

  // Populate indices based on the imported CSV header for this dataset.
  if (Array.isArray(meta.indices) && meta.indices.length) {
    indexEl.innerHTML = meta.indices.map((idx) => {
      const m = String(idx).match(/^(spi|spei)(\d+)$/i);
      const label = m ? `${m[1].toUpperCase()}-${m[2]}` : String(idx).toUpperCase();
      return `<option value="${idx}">${label}</option>`;
    }).join('');

    const preferred = ['spi3', 'spei3', meta.indices[0]];
    const chosen = preferred.find((v) => meta.indices.includes(v)) || meta.indices[0];
    indexEl.value = meta.indices.includes(indexEl.value) ? indexEl.value : chosen;
  }

  if (meta.min_month && meta.max_month) {
    setGlobalBounds(meta.min_month, meta.max_month);
    // If the current date is unset, default to dataset max.
    if (!dateEl.value) dateEl.value = meta.max_month;
    // Ensure slider is in sync.
    syncGlobalSliderFromInput();
  }
}
syncBootstrapDir();

// ---------- Map (Leaflet) ----------
const DEFAULT_VIEW = Object.freeze({ center: [32.5, 53.6], zoom: 5 });
const map = L.map('map', { zoomControl: false, preferCanvas: true }).setView(DEFAULT_VIEW.center, DEFAULT_VIEW.zoom);
// Keep controls away from the fixed bottom-left map tooltip and top-left legend.
L.control.zoom({ position: 'topright' }).addTo(map);
L.control.scale({ position: 'bottomleft', metric: true, imperial: false }).addTo(map);

// Neutral basemaps (no keys required)
const BASEMAPS = {
  carto: L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    subdomains: 'abcd',
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
  }),
  osm: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }),
  dark: L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    subdomains: 'abcd',
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
  })
};

let activeBasemap = BASEMAPS.carto.addTo(map);

let geoLayer;
let chart;
let overviewChart;
let selectedFeature = null;
let latestMapFeatures = [];
let currentRangeStart = null;
let currentRangeEnd = null;
let mapRequestSeq = 0;
let panelRequestSeq = 0;
let lastPanelQueryKey = null;
let mapUpdateDebounce = null;
let mapAbortController = null;
let panelAbortController = null;
let lastChartRenderKey = null;
let chartResizeBound = false;
let appIsReady = false;

// Global (map) month bounds for the currently selected dataset layer.
let globalMinMonth = null;
let globalMaxMonth = null;
let globalMinInt = 0;
let globalMaxInt = 0;

// Panel (feature) month state (decoupled from global month).
let stationMinInt = null;
let stationMaxInt = null;
let stationMonthInt = null;

let searchQuery = '';

// Cached panel series for the currently selected feature (used to update chart
// markers when the global map month changes without reloading the whole panel).
let currentPanelSeries = [];
let currentPanelFeatureName = null;

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 180;
const mapDataCache = new Map();
const panelKpiCache = new Map();
const timeseriesCache = new Map();
const derivedSeriesCache = new Map();
const overviewCache = new Map();

const levelEl = document.getElementById('level');
const indexEl = document.getElementById('index');
const dateEl = document.getElementById('date');
const panelEl = document.getElementById('insightPanel');
const sidebarEl = document.getElementById('sidebar');
const closeBtn = document.getElementById('closePanel');
// New unified date management:
// - dateEl + globalSlider control the map month (global)
// - stationSlider controls the selected feature month (panel)
// They are decoupled to avoid short station spans locking the global selector.
const globalSliderEl = document.getElementById('globalSlider');
const globalMinLabelEl = document.getElementById('globalMinLabel');
const globalMaxLabelEl = document.getElementById('globalMaxLabel');
const stationSliderEl = document.getElementById('stationSlider');
const stationRangeLabelEl = document.getElementById('stationRangeLabel');
const stationMonthLabelEl = document.getElementById('stationMonthLabel');
const syncToMapBtn = document.getElementById('syncToMap');
const clearSearchBtn = document.getElementById('clearSearch');
const valueBoxEl = document.getElementById('valueBox');
const modalBackdropEl = document.getElementById('modalBackdrop');
const panelSpinnerEl = document.getElementById('panelSpinner');
const kpiGridEl = document.getElementById('kpiGrid');
const mapLoadingEl = document.getElementById('mapLoading');

const mapSubtitleEl = document.getElementById('mapSubtitle');
const overviewSubtitleEl = document.getElementById('overviewSubtitle');
const overviewStatsEl = document.getElementById('overviewStats');
const hoverBoxEl = document.getElementById('mapHover');
const hoverNameEl = document.getElementById('hoverName');
const hoverMetaEl = document.getElementById('hoverMeta');

const basemapEl = document.getElementById('basemap');
const resetViewBtn = document.getElementById('resetView');

const toggleSidebarBtn = document.getElementById('toggleSidebar');
const togglePanelBtn = document.getElementById('togglePanel');

const aboutOpenBtn = document.getElementById('openAbout');
const aboutModalEl = document.getElementById('aboutModal');
const aboutCloseBtn = document.getElementById('aboutClose');
const aboutOkBtn = document.getElementById('aboutOk');

const headerEl = document.querySelector('.app-header');
const timelineControls = [
  document.getElementById('toStart'),
  document.getElementById('prevMonth'),
  document.getElementById('date'),
  document.getElementById('nextMonth'),
  document.getElementById('toEnd'),
  globalSliderEl
];

const levelLabels = {
  station: 'ایستگاهی',
  province: 'استانی',
  county: 'شهرستانی',
  level1: 'حوزه درجه یک',
  level2: 'حوزه درجه دو',
  level3: 'حوزه درجه سه'
};

// Filled from GET /datasets. Used for UI labels (Persian-friendly) while still
// keeping dataset keys stable in URLs.
const datasetTitles = new Map();

const droughtColors = {
  'D4': '#7f1d1d',
  'D3': '#dc2626',
  'D2': '#f97316',
  'D1': '#fbbf24',
  'D0': '#fde047',
  'Normal/Wet': '#86efac',
  'No Data': '#e5e7eb'
};

const DROUGHT_THRESHOLD_LINES = Object.freeze([
  { yAxis: -0.5, name: 'D0' },
  { yAxis: -0.8, name: 'D1' },
  { yAxis: -1.3, name: 'D2' },
  { yAxis: -1.6, name: 'D3' },
  { yAxis: -2.0, name: 'D4' },
]);


function populateIndexOptions() {
  const windows = [1, 3, 6, 9, 12, 15, 18, 21, 24];
  const options = [];
  for (const window of windows) {
    options.push({ value: `spi${window}`, label: `SPI-${window}` });
    options.push({ value: `spei${window}`, label: `SPEI-${window}` });
  }
  indexEl.innerHTML = options.map((opt) => `<option value="${opt.value}">${opt.label}</option>`).join('');
  indexEl.value = 'spi3';
}

const severityLong = {
  'Normal/Wet': 'نرمال/مرطوب',
  'D0': 'D0 - خشکی غیرعادی',
  'D1': 'D1 - خشکسالی متوسط',
  'D2': 'D2 - خشکسالی شدید',
  'D3': 'D3 - خشکسالی بسیار شدید',
  'D4': 'D4 - خشکسالی استثنایی'
};

function severityColor(sev) { return droughtColors[sev] || '#60a5fa'; }

// 3-class trend classification (must match backend rules)
function classifyTrend(trend, alpha = 0.05) {
  const slope = Number(trend?.sen_slope);
  const p = Number(trend?.p_value);
  const hasBackend = Boolean(trend?.trend_category);

  if (hasBackend) {
    const c = String(trend.trend_category);
    if (c === 'inc') return { category: 'inc', symbol: '↑', labelEn: trend.trend_label_en, labelFa: trend.trend_label_fa, tone: 'pos' };
    if (c === 'dec') return { category: 'dec', symbol: '↓', labelEn: trend.trend_label_en, labelFa: trend.trend_label_fa, tone: 'neg' };
    return { category: 'none', symbol: '—', labelEn: trend.trend_label_en, labelFa: trend.trend_label_fa, tone: 'neu' };
  }

  if (!Number.isFinite(p) || p > alpha) {
    return { category: 'none', symbol: '—', labelEn: 'No Significant Trend', labelFa: 'بدون روند معنی‌دار', tone: 'neu' };
  }
  if (Number.isFinite(slope) && slope > 0) {
    return { category: 'inc', symbol: '↑', labelEn: 'Increasing Trend (Wetter)', labelFa: 'روند افزایشی (مرطوب‌تر)', tone: 'pos' };
  }
  if (Number.isFinite(slope) && slope < 0) {
    return { category: 'dec', symbol: '↓', labelEn: 'Decreasing Trend (Drier)', labelFa: 'روند کاهشی (خشک‌تر)', tone: 'neg' };
  }
  return { category: 'none', symbol: '—', labelEn: 'No Significant Trend', labelFa: 'بدون روند معنی‌دار', tone: 'neu' };
}

function toPersianDigits(value) {
  return String(value).replace(/\d/g, (digit) => '۰۱۲۳۴۵۶۷۸۹'[digit]);
}

function formatNumber(value, digits = 4) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  const formatted = Math.abs(num).toFixed(digits).replace('.', '٫');
  return toPersianDigits(num < 0 ? `${formatted}−` : formatted);
}

function formatPValue(value) {
  const raw = String(value ?? '').trim();
  const num = Number(raw);
  if (Number.isFinite(num)) return formatNumber(num, 4);

  const match = raw.match(/^([<>]=?)\s*(-?\d*\.?\d+)$/);
  if (match) {
    const [, sign, numberPart] = match;
    return `${sign}${formatNumber(Number(numberPart), 4)}`;
  }

  // Keep as-is (but still enforce LTR marks around it)
  const LRM = '\u200E';
  return `${LRM}${(raw || '—')}${LRM}`;
}

function addMonth(yyyymm, delta) {
  const [y, m] = yyyymm.split('-').map(Number);
  const dt = new Date(y, m - 1 + delta, 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
}

function toMonthLabel(yyyymm) {
  const [y, m] = yyyymm.split('-').map(Number);
  // Gregorian months in Persian (for UI consistency)
  const labels = ['ژانویه','فوریه','مارس','آوریل','مه','ژوئن','ژوئیه','اوت','سپتامبر','اکتبر','نوامبر','دسامبر'];
  return { month: labels[m - 1] || String(m), year: y };
}

function toISODate(yyyymm) { return `${yyyymm}-01`; }

function toChartMonthStart(yyyymm) { return `${yyyymm}-01`; }

// Month parsing helpers (no off-by-one conversions).
function monthToInt(yyyymm) {
  const [y, m] = String(yyyymm || '1970-01').split('-').map(Number);
  return (y * 12) + (m - 1);
}

function intToMonth(n) {
  const y = Math.floor(n / 12);
  const m = (n % 12) + 1;
  return `${y}-${String(m).padStart(2, '0')}`;
}

function clampInt(v, minV, maxV) {
  return Math.min(Math.max(v, minV), maxV);
}

function formatChartDate(value) {
  const raw = String(value || '');
  const directMonth = raw.match(/^(\d{4}-\d{2})/);
  if (directMonth) return directMonth[1];

  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return raw;
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
}

function debounce(fn, wait = 200) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function pruneCache(cache) {
  if (cache.size <= CACHE_MAX) return;
  const firstKey = cache.keys().next().value;
  if (firstKey) cache.delete(firstKey);
}

async function fetchCached(cache, key, urlBuilder, options = {}) {
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && (now - cached.ts) < CACHE_TTL_MS) return cached.promise;

  const request = fetchJson(urlBuilder(), options)
    .catch((error) => {
      cache.delete(key);
      throw error;
    });

  cache.set(key, { ts: now, promise: request });
  pruneCache(cache);
  return request;
}

function classify(value) {
  if (value >= 0) return 'Normal/Wet';
  if (value >= -0.8) return 'D0';
  if (value >= -1.3) return 'D1';
  if (value >= -1.6) return 'D2';
  if (value >= -2.0) return 'D3';
  return 'D4';
}

function normalizeTimeseries(ts) {
  if (!Array.isArray(ts) || ts.length === 0) return [];
  return ts
    .filter((d) => d && d.date)
    // Keep missing months as null so the x-axis spans the full feature range.
    .map((d) => ({ date: d.date, value: (d.value == null ? null : Number(d.value)) }));
}

function getTrendLine(values) {
  const n = values.length;
  if (n < 2) return [...values];
  const xMean = (n - 1) / 2;
  const yMean = values.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (i - xMean) * (values[i] - yMean);
    den += (i - xMean) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const intercept = yMean - slope * xMean;
  return values.map((_, i) => intercept + slope * i);
}

// Month-strip UI was removed in favor of a global timeline slider.

function setPanelOpen(open) {
  // On desktop, the panel is part of the layout; on mobile it's a drawer.
  state.panelOpen = Boolean(open);
  panelEl.classList.toggle('open', state.panelOpen);
  panelEl.setAttribute('aria-hidden', String(isMobileViewport() ? !state.panelOpen : false));
  updateBackdrop();

   // Ensure charts reflow correctly after drawer transition.
   setTimeout(() => {
     try { chart?.resize?.(); } catch (_) {}
     try { overviewChart?.resize?.(); } catch (_) {}
   }, 260);
}

function isMobileViewport() {
  return window.matchMedia('(max-width: 991.98px)').matches;
}

const state = {
  sidebarOpen: false,
  panelOpen: false,
  modalOpen: false,
};

function updateBackdrop() {
  if (!modalBackdropEl) return;
  const show = state.modalOpen || (isMobileViewport() && (state.sidebarOpen || state.panelOpen));
  modalBackdropEl.classList.toggle('show', show);
  modalBackdropEl.setAttribute('aria-hidden', String(!show));
}

function setSidebarOpen(open) {
  if (!sidebarEl) return;
  state.sidebarOpen = Boolean(open);
  sidebarEl.classList.toggle('open', state.sidebarOpen);
  sidebarEl.setAttribute('aria-hidden', String(isMobileViewport() ? !state.sidebarOpen : false));
  updateBackdrop();
}

function setAboutModalOpen(open) {
  if (!aboutModalEl) return;
  state.modalOpen = Boolean(open);
  aboutModalEl.classList.toggle('open', state.modalOpen);
  aboutModalEl.setAttribute('aria-hidden', String(!state.modalOpen));
  updateBackdrop();

  if (state.modalOpen) {
    setTimeout(() => {
      (aboutOkBtn || aboutCloseBtn || aboutModalEl).focus?.();
    }, 0);
  }
}

function updateHeaderHeightVar() {
  if (!headerEl) return;
  const h = Math.ceil(headerEl.getBoundingClientRect().height);
  document.documentElement.style.setProperty('--app-header-h', `${h}px`);
}

function invalidateMapSoon() {
  // Helps Leaflet reflow after resize / drawer transitions
  setTimeout(() => map.invalidateSize(), 50);
  setTimeout(() => map.invalidateSize(), 280);
}

function applySeverityStyle(sev) {
  const map = { 'Normal/Wet': 'NormalWet', 'D0': 'D0', 'D1': 'D1', 'D2': 'D2', 'D3': 'D3', 'D4': 'D4' };
  ['NormalWet','D0','D1','D2','D3','D4'].forEach(k => valueBoxEl.classList.remove(`sev-${k}`));
  const key = map[sev] || 'D0';
  valueBoxEl.classList.add(`sev-${key}`);
  const c = severityColor(sev);
  valueBoxEl.style.borderColor = c;
  valueBoxEl.style.setProperty('--severity-color', c);
}

function renderKPI(kpi, featureName, indexLabel, panelMonth) {
  const sev = kpi.severity || '-';
  document.getElementById('panelTitle').textContent = `${featureName}`;
  const m = panelMonth || dateEl.value;
  document.getElementById('panelSubtitle').textContent = `تاریخ انتخاب شده: ${toPersianDigits(String(m).replace(/-/g, '/'))}`;
  document.getElementById('mainMetricLabel').textContent = `مقدار ${formatIndexLabel(indexLabel)}`;
  document.getElementById('mainMetricValue').textContent = formatNumber(kpi.latest);
  document.getElementById('severityBadge').textContent = severityLong[sev] || sev;
  applySeverityStyle(sev);

  document.getElementById('tauVal').textContent = formatNumber(kpi.trend?.tau);
  document.getElementById('pVal').textContent = formatPValue(kpi.trend?.p_value);
  document.getElementById('senVal').textContent = formatNumber(kpi.trend?.sen_slope);

  // Trend status + note (3-class, consistent across map/tooltips/panel)
  const t = classifyTrend(kpi.trend, 0.05);
  const trendStatusEl = document.getElementById('trendStatus');
  if (trendStatusEl) {
    trendStatusEl.textContent = `${t.symbol} ${t.labelFa}`;
    trendStatusEl.classList.toggle('trend-pos', t.tone === 'pos');
    trendStatusEl.classList.toggle('trend-neg', t.tone === 'neg');
    trendStatusEl.classList.toggle('trend-neu', t.tone === 'neu');
  }

  const trendNoteEl = document.getElementById('trendNote');
  if (trendNoteEl) {
    const pNum = Number(kpi.trend?.p_value);
    if (!Number.isFinite(pNum)) trendNoteEl.textContent = '—';
    else trendNoteEl.textContent = `p = ${formatPValue(pNum)} • ${t.labelEn}`;
  }
}

function renderPanelLoading(featureName = 'ناحیه', panelMonth = null) {
  document.getElementById('panelTitle').textContent = `${featureName}`;
  const m = panelMonth || dateEl.value;
  document.getElementById('panelSubtitle').textContent = `تاریخ انتخاب شده: ${toPersianDigits(String(m).replace(/-/g, '/'))}`;
  document.getElementById('mainMetricLabel').textContent = `مقدار ${formatIndexLabel(indexEl.value)}`;
  document.getElementById('mainMetricValue').textContent = '...';
  document.getElementById('severityBadge').textContent = 'درحال بارگذاری';
  const trendStatusEl = document.getElementById('trendStatus');
  const trendNoteEl = document.getElementById('trendNote');
  if (trendStatusEl) trendStatusEl.textContent = '—';
  if (trendNoteEl) trendNoteEl.textContent = 'در حال بارگذاری...';
  ['tauVal', 'pVal', 'senVal'].forEach((id) => {
    document.getElementById(id).textContent = '...';
  });
}

function togglePanelSpinner(show) {
  if (!panelSpinnerEl) return;
  panelSpinnerEl.classList.toggle('d-none', !show);
}

function toggleMapLoading(show) {
  if (!mapLoadingEl) return;
  mapLoadingEl.classList.toggle('show', show);
}

function preloadLikelyMapRequests(level, index, baseMonth) {
  [-1, 1].forEach((offset) => {
    const nextMonth = addMonth(baseMonth, offset);
    const mapKey = `${level}|${index}|${nextMonth}`;
    fetchCached(mapDataCache, mapKey, () => `${API_BASE}/mapdata?level=${level}&index=${index}&date=${nextMonth}`)
      .catch(() => {});
  });
}


function setTimelineDisabled(disabled) {
  timelineControls.forEach((el) => {
    if (!el) return;
    el.disabled = disabled;
  });
}

function setNoDataMessage(show, message = 'No data for this selection') {
  if (!show) return;
  const trendStatusEl = document.getElementById('trendStatus');
  const trendNoteEl = document.getElementById('trendNote');
  if (trendStatusEl) trendStatusEl.textContent = '—';
  if (trendNoteEl) trendNoteEl.textContent = message;
}


function isRtl() {
  return document.documentElement.getAttribute('dir') === 'rtl';
}

function sliderUiFromOffset(rangeEl, offset) {
  const min = Number(rangeEl?.min || 0);
  const max = Number(rangeEl?.max || 0);
  const safe = clampInt(Number(offset || 0), min, max);
  return isRtl() ? (max - safe) : safe;
}

function sliderOffsetFromUi(rangeEl) {
  const min = Number(rangeEl?.min || 0);
  const max = Number(rangeEl?.max || 0);
  const ui = clampInt(Number(rangeEl?.value || 0), min, max);
  return isRtl() ? (max - ui) : ui;
}

function setGlobalBounds(minMonth, maxMonth) {
  // Global bounds come from the dataset layer, NOT from the selected feature.
  globalMinMonth = minMonth;
  globalMaxMonth = maxMonth;
  if (!minMonth || !maxMonth) return;

  dateEl.min = minMonth;
  dateEl.max = maxMonth;
  globalMinInt = monthToInt(minMonth);
  globalMaxInt = monthToInt(maxMonth);

  // Clamp the current global month into bounds.
  const cur = monthToInt(dateEl.value);
  const clamped = clampInt(cur, globalMinInt, globalMaxInt);
  dateEl.value = intToMonth(clamped);

  if (globalMinLabelEl) globalMinLabelEl.textContent = toPersianDigits(String(minMonth).replace(/-/g, '/'));
  if (globalMaxLabelEl) globalMaxLabelEl.textContent = toPersianDigits(String(maxMonth).replace(/-/g, '/'));

  if (globalSliderEl) {
    globalSliderEl.min = 0;
    globalSliderEl.max = Math.max(0, globalMaxInt - globalMinInt);
    globalSliderEl.value = String(sliderUiFromOffset(globalSliderEl, monthToInt(dateEl.value) - globalMinInt));
    paintRange(globalSliderEl);
  }
}

function paintRange(rangeEl) {
  // Modern slider fill (RTL-aware)
  if (!rangeEl) return;
  const min = Number(rangeEl.min || 0);
  const max = Number(rangeEl.max || 100);
  const val = Number(rangeEl.value || 0);
  const pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
  const rtl = document.documentElement.getAttribute('dir') === 'rtl';
  rangeEl.style.setProperty('--fill', `${pct}%`);
  rangeEl.style.setProperty('--fill-dir', rtl ? 'to left' : 'to right');
}

function syncGlobalSliderFromInput() {
  if (!globalSliderEl || globalMinMonth == null || globalMaxMonth == null) return;
  globalSliderEl.value = String(sliderUiFromOffset(globalSliderEl, monthToInt(dateEl.value) - globalMinInt));
  paintRange(globalSliderEl);
}

function syncGlobalInputFromSlider() {
  if (!globalSliderEl || globalMinMonth == null || globalMaxMonth == null) return;
  const offset = sliderOffsetFromUi(globalSliderEl);
  const m = intToMonth(globalMinInt + offset);
  dateEl.value = m;
  paintRange(globalSliderEl);
}

function getDateRangeFromTimeseries(ts) {
  if (!ts.length) return { minDate: null, maxDate: null };
  const months = ts
    .map((d) => String(d.date || '').slice(0, 7))
    .filter((d) => /^\d{4}-\d{2}$/.test(d))
    .sort();

  if (!months.length) return { minDate: null, maxDate: null };
  return { minDate: months[0], maxDate: months[months.length - 1] };
}

function calculateTrendLine(data) {
  // Robust to missing values: fit a line using only finite points.
  const n = data.length;
  if (n < 2) return [...data];

  const xs = [];
  const ys = [];
  for (let i = 0; i < n; i += 1) {
    const y = data[i][1];
    if (Number.isFinite(y)) {
      xs.push(i);
      ys.push(y);
    }
  }
  if (xs.length < 2) return data.map((p) => [p[0], null]);

  const xMean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const yMean = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i += 1) {
    num += (xs[i] - xMean) * (ys[i] - yMean);
    den += (xs[i] - xMean) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const intercept = yMean - slope * xMean;
  return data.map((point, i) => [point[0], slope * i + intercept]);
}

function getStartValueForLastYears(parsedData, years = 5) {
  if (!Array.isArray(parsedData) || parsedData.length === 0) return null;
  const end = new Date(parsedData[parsedData.length - 1][0]);
  if (Number.isNaN(end.getTime())) {
    const fallback = Math.max(parsedData.length - (years * 12), 0);
    return parsedData[fallback]?.[0] ?? parsedData[0][0];
  }

  const start = new Date(end);
  start.setUTCFullYear(end.getUTCFullYear() - years);
  let idx = 0;
  for (let i = 0; i < parsedData.length; i += 1) {
    const dt = new Date(parsedData[i][0]);
    if (!Number.isNaN(dt.getTime()) && dt >= start) {
      idx = i;
      break;
    }
  }
  return parsedData[idx][0];
}

function renderChart(ts, indexLabel, mapMonth, panelMonth) {
  const selectedId = String(selectedFeature?.properties?.id || 'unknown');
  const lastPoint = ts.length ? `${ts[ts.length - 1].date}|${ts[ts.length - 1].value}` : 'empty';
  const derivedKey = `${selectedId}|${levelEl.value}|${indexLabel}|${mapMonth}|${panelMonth}|${ts.length}|${lastPoint}`;
  let cachedDerived = derivedSeriesCache.get(derivedKey);
  if (!cachedDerived) {
    const parsedData = ts.map((d) => {
      const iso = String(d.date).includes('T') ? d.date : `${d.date}T00:00:00Z`;
      const v = (d.value == null ? null : Number(d.value));
      return [iso, Number.isFinite(v) ? v : null];
    });
    cachedDerived = {
      parsedData,
      trendData: calculateTrendLine(parsedData)
    };
    derivedSeriesCache.set(derivedKey, cachedDerived);
  }

  const { parsedData, trendData } = cachedDerived;
  const selectedDate = toChartMonthStart(mapMonth);
  const panelDate = toChartMonthStart(panelMonth);

  const chartDom = document.getElementById('tsChart');
  if (lastChartRenderKey !== derivedKey && chart) {
    chart.dispose();
    chart = null;
  }
  if (!chart) {
    chart = echarts.init(chartDom);
  }
  if (!chartResizeBound) {
    window.addEventListener('resize', () => chart && chart.resize());
    chartResizeBound = true;
  }

  const markLineData = [
    ...DROUGHT_THRESHOLD_LINES.map((line) => ({ ...line })),
    { xAxis: selectedDate, name: 'نقشه' },
    { xAxis: panelDate, name: 'ناحیه' }
  ];

  const endValue = parsedData[parsedData.length - 1]?.[0];
  // Initial viewport: most recent year
  const startValue = getStartValueForLastYears(parsedData, 1) || parsedData[0]?.[0];
  // No separate timeline series; we use vertical markLines for both dates.


  const option = {
    animation: true,
    animationDuration: 0,
    animationDurationUpdate: 0,
    textStyle: { fontFamily: 'Vazirmatn' },
    title: {
      text: '',
      left: 0,
      top: 6,
      textStyle: { fontWeight: 900, fontSize: 16, color: '#101828' }
    },
    toolbox: {
      right: 10,
      top: 6,
      itemSize: 16,
      iconStyle: { borderColor: '#667085' },
      emphasis: { iconStyle: { borderColor: '#2563eb' } },
      feature: {
        dataZoom: { yAxisIndex: 'none' },
        restore: {},
        saveAsImage: { name: 'timeseries', pixelRatio: 2 }
      }
    },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross' },
      formatter: (params) => {
        const entries = Array.isArray(params) ? params : [params];
        const rawAxis = entries[0]?.axisValue ?? entries[0]?.value?.[0] ?? '';
        const axisValue = (() => {
          const dt = new Date(rawAxis);
          if (!Number.isNaN(dt.getTime())) {
            return dt.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
          }
          return formatChartDate(rawAxis);
        })();

        const visible = entries
          // Hide helper series from tooltip (Trend)
          .filter((item) => !['Trend'].includes(item?.seriesName))
          .map((item) => {
            const value = Array.isArray(item.value) ? item.value[1] : item.value;
            return `${item.marker}${item.seriesName}: ${formatNumber(value)}`;
          });

        const primary = entries.find((e) => e?.seriesName === formatIndexLabel(indexLabel)) || entries[0];
        const primaryVal = Array.isArray(primary?.value) ? Number(primary.value[1]) : Number(primary?.value);
        const sev = Number.isFinite(primaryVal) ? classify(primaryVal) : null;
        const sevRow = sev ? `Severity: <strong>${sev}</strong>` : null;
        const html = [axisValue, ...visible, sevRow].filter(Boolean).join('<br/>');
        return `
          <div dir="ltr" style="text-align:left; unicode-bidi:plaintext;">
            ${html}
          </div>
        `;
      }
    },
    legend: {
      bottom: 52,
      left: 'center',
      itemWidth: 16,
      itemHeight: 8,
      textStyle: { color: '#475467' }
    },
    grid: {
      left: '7%',
      right: '8%',
      bottom: 94,
      top: 52,
      containLabel: true
    },
    xAxis: {
      type: 'time',
      name: '',
      nameLocation: 'middle',
      nameGap: 36,
      boundaryGap: false,
      axisLabel: {
        formatter: (value) => formatChartDate(value),
        rotate: 45,
        color: '#6b7280'
      },
      axisLine: { lineStyle: { color: '#d1d5db' } },
      splitLine: { show: false }
    },
    yAxis: {
      type: 'value',
      name: '',
      nameTextStyle: { color: '#6b7280', padding: [0, 0, 0, 8] },
      min: -3,
      max: 2,
      interval: 1,
      axisLabel: {
        color: '#6b7280',
        formatter: (value) => value
      },
      splitLine: {
        show: true,
        lineStyle: { color: '#e5e7eb' }
      }
    },
    visualMap: {
      type: 'piecewise',
      show: false,
      dimension: 1,
      seriesIndex: 0,
      pieces: [
        { min: 0, color: '#a2e8c6' },
        { min: -0.5, max: 0, color: '#c7eed8' },
        { min: -0.8, max: -0.5, color: '#ffea75' },
        { min: -1.3, max: -0.8, color: '#ffc859' },
        { min: -1.6, max: -1.3, color: '#ff9843' },
        { min: -2.0, max: -1.6, color: '#e73838' },
        { max: -2.0, color: '#8b0000' }
      ]
    },
    dataZoom: [
      {
        type: 'inside',
        xAxisIndex: 0,
        filterMode: 'none',
        // Horizontal scrolling / panning:
        // - Mouse wheel pans by default (older years)
        // - Hold SHIFT and use wheel to zoom
        zoomOnMouseWheel: 'shift',
        moveOnMouseWheel: true,
        moveOnMouseMove: true
      },
      {
        type: 'slider',
        show: true,
        xAxisIndex: 0,
        startValue,
        endValue,
        bottom: 12,
        height: 26,
        showDetail: false,
        showDataShadow: true,
        borderColor: '#d1d5db',
        backgroundColor: 'rgba(255, 255, 255, 0.55)',
        fillerColor: 'rgba(148, 163, 184, 0.35)',
        handleStyle: { color: '#94a3b8', borderColor: '#94a3b8' },
        handleSize: '88%',
        filterMode: 'none'
      }
    ],
    series: [
      {
        name: formatIndexLabel(indexLabel),
        type: 'line',
        data: parsedData,
        symbol: 'none',
        lineStyle: { width: 2 },
        areaStyle: {
          origin: 0,
          opacity: 0.7
        },
        animation: false,
        markLine: {
          animation: false,
          symbol: ['none', 'none'],
          label: { position: 'end', formatter: '{b}', color: '#475467', fontSize: 12 },
          lineStyle: { type: 'dashed', color: '#9ca3af', width: 1 },
          data: markLineData
        }
      },
      {
        name: 'Trend',
        type: 'line',
        data: trendData,
        symbol: 'none',
        silent: true,
        tooltip: { show: false },
        animation: false,
        lineStyle: { color: '#ef4444', width: 1.6, type: 'solid' },
        itemStyle: { color: '#ef4444' }
      },
      // Timeline markers are rendered via markLine.
    ]
  };

  currentRangeStart = parsedData.length ? formatChartDate(parsedData[0][0]) : null;
  currentRangeEnd = parsedData.length ? formatChartDate(parsedData[parsedData.length - 1][0]) : null;
  chart.setOption(option, true);
  lastChartRenderKey = derivedKey;
}

function formatIndexLabel(value) {
  const raw = String(value || '');
  const m = raw.match(/^(spi|spei)(\d+)$/i);
  if (m) return `${m[1].toUpperCase()}-${m[2]}`;
  return raw.toUpperCase();
}

function updateSubtitles() {
  const levelLabel = (datasetTitles.get(levelEl.value) || levelLabels[levelEl.value] || levelEl.value);
  const dateLabel = toPersianDigits(String(dateEl.value).replace(/-/g, '/'));
  const idxLabel = formatIndexLabel(indexEl.value);
  const text = `${idxLabel} • ${dateLabel} • سطح: ${levelLabel}`;
  if (mapSubtitleEl) mapSubtitleEl.textContent = text;
  if (overviewSubtitleEl) overviewSubtitleEl.textContent = text;

  const legendTitle = document.getElementById('legendTitle');
  if (legendTitle) legendTitle.textContent = `راهنمای شدت خشکسالی • ${idxLabel}`;
}

function ensureOverviewChart() {
  const dom = document.getElementById('overviewChart');
  if (!dom) return null;
  if (!overviewChart) overviewChart = echarts.init(dom);
  return overviewChart;
}

function renderOverviewFromCounts(payload) {
  updateSubtitles();
  const chartInstance = ensureOverviewChart();
  if (!chartInstance) return;

  const order = ['Normal/Wet', 'D0', 'D1', 'D2', 'D3', 'D4'];
  const labelsFa = {
    'Normal/Wet': 'نرمال/مرطوب',
    'D0': 'خشکی غیرعادی',
    'D1': 'خشکسالی متوسط',
    'D2': 'خشکسالی شدید',
    'D3': 'خشکسالی بسیار شدید',
    'D4': 'خشکسالی استثنایی'
  };

  const counts = payload?.counts || {};
  const total = order.reduce((a, k) => a + (counts[k] || 0), 0);

  const data = order
    .filter((k) => (counts[k] || 0) > 0)
    .map((k) => ({
      name: labelsFa[k] || k,
      value: counts[k],
      itemStyle: { color: droughtColors[k] || '#94a3b8' }
    }));

  chartInstance.setOption({
    animation: false,
    tooltip: {
      trigger: 'item',
      formatter: (p) => {
        const percent = total ? (p.value / total) * 100 : 0;
        return `${p.marker}${p.name}<br/>تعداد: ${toPersianDigits(p.value)}<br/>درصد: ${toPersianDigits(percent.toFixed(1).replace('.', '٫'))}٪`;
      }
    },
    legend: {
      bottom: 0,
      left: 'center',
      itemWidth: 12,
      itemHeight: 12,
      textStyle: { color: '#475467', fontFamily: 'Vazirmatn' }
    },
    series: [
      {
        type: 'pie',
        radius: ['42%', '70%'],
        center: ['50%', '44%'],
        avoidLabelOverlap: true,
        label: { show: false },
        labelLine: { show: false },
        data
      }
    ]
  }, true);

  // In case the panel is a drawer / off-canvas (mobile), force a reflow.
  setTimeout(() => {
    try { chartInstance.resize?.(); } catch (_) {}
  }, 0);

  if (overviewStatsEl) {
    const missing = payload?.missing ?? 0;
    overviewStatsEl.innerHTML = total
      ? (`<div class="text-muted small mb-2">ایستگاه‌ها: ${toPersianDigits(payload?.with_value ?? total)} • دادهٔ ناموجود: ${toPersianDigits(missing)}</div>` +
      order.map((k) => {
        const c = counts[k] || 0;
        const pct = total ? (c / total) * 100 : 0;
        const label = labelsFa[k] || k;
        return `
          <div class="stat-row">
            <div class="stat-left">
              <span class="swatch" style="background:${droughtColors[k] || '#94a3b8'}"></span>
              <span>${label}</span>
            </div>
            <div>${toPersianDigits(c)} عدد --- ${toPersianDigits(pct.toFixed(1).replace('.', '٫'))}٪</div>
          </div>
        `;
      }).join(''))
      : '<div class="text-muted small">برای این انتخاب داده‌ای در دسترس نیست.</div>';
  }
}

function addMapLegend() {
  // Legend: top-left, collapsed by default.
  const legend = L.control({ position: 'topleft' });
  legend.onAdd = () => {
    const div = L.DomUtil.create('div', 'map-legend collapsed');
    div.id = 'mapLegendBox';
    const items = [
      ['NW', 'نرمال/مرطوب', '#86efac'],
      ['D0', 'خشکی غیرعادی', '#fde047'],
      ['D1', 'خشکسالی متوسط', '#fbbf24'],
      ['D2', 'خشکسالی شدید', '#f97316'],
      ['D3', 'خشکسالی بسیار شدید', '#dc2626'],
      ['D4', 'خشکسالی استثنایی', '#7f1d1d'],
      ['—', 'بدون داده', '#e5e7eb']
    ];
    div.innerHTML = `
      <div class="head">
        <h6 id="legendTitle">راهنمای شدت خشکسالی</h6>
        <button id="legendToggle" class="toggle" type="button" aria-label="نمایش راهنما">▸</button>
      </div>
      <div class="legend-body">
        ${items.map(i => `<div class="row-item"><span class="sw" style="background:${i[2]}"></span><span class="short">${i[0]}</span><span class="label">${i[1]}</span></div>`).join('')}
        <div class="legend-sep"></div>
        <div class="legend-subtitle">راهنمای روند (کل دوره)</div>
        <div class="row-item"><span class="trend-ic trend-pos">↑</span><span class="label">روند افزایشی (مرطوب‌تر)</span></div>
        <div class="row-item"><span class="trend-ic trend-neg">↓</span><span class="label">روند کاهشی (خشک‌تر)</span></div>
        <div class="row-item"><span class="trend-ic trend-neu">—</span><span class="label">بدون روند معنی‌دار</span></div>
      </div>`;

    // Prevent map interactions while using the legend.
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.disableScrollPropagation(div);
    return div;
  };
  legend.addTo(map);

  setTimeout(() => {
    const toggle = document.getElementById('legendToggle');
    const legendBox = document.getElementById('mapLegendBox');
    if (!toggle || !legendBox) return;
    toggle.addEventListener('click', () => {
      legendBox.classList.toggle('collapsed');
      const collapsed = legendBox.classList.contains('collapsed');
      toggle.textContent = collapsed ? '▸' : '▾';
      toggle.setAttribute('aria-label', collapsed ? 'نمایش راهنما' : 'جمع‌کردن راهنما');
    });
  }, 100);
}

function setHoverInfo(feature, indexName) {
  if (!hoverBoxEl || !hoverNameEl || !hoverMetaEl) return;
  if (!feature) {
    hoverBoxEl.classList.add('is-hidden');
    hoverBoxEl.setAttribute('aria-hidden', 'true');
    return;
  }
  const name = feature?.properties?.name || '—';
  const sev = feature?.properties?.severity || '—';
  const hasValue = feature?.properties?.has_value !== false && feature?.properties?.value != null;
  const value = hasValue ? formatNumber(feature?.properties?.value) : '—';
  const t = classifyTrend(feature?.properties?.trend, 0.05);
  hoverNameEl.textContent = name;
  const sevText = (sev === 'No Data' || !hasValue) ? 'بدون داده' : (severityLong[sev] || sev);
  hoverMetaEl.textContent = `${formatIndexLabel(indexName)}: ${value} ••• ${sevText} ••• ${t.symbol} ${t.labelFa}`;
  hoverBoxEl.classList.remove('is-hidden');
  hoverBoxEl.setAttribute('aria-hidden', 'false');
}

function applySearchFilter() {
  if (!geoLayer) return;
  const q = String(searchQuery || '').trim().toLowerCase();
  geoLayer.eachLayer((layer) => {
    const name = String(layer?.feature?.properties?.name || '').toLowerCase();
    const hit = !q || name.includes(q);
    layer._searchMatch = hit;

    // Visually fade non-matching features.
    if (layer.setStyle) {
      const hv = layer?.feature?.properties?.has_value !== false;
      const baseFill = hv ? 0.78 : 0.12;
      const baseOp = hv ? 1 : 0.35;
      layer.setStyle({
        opacity: hit ? baseOp : 0.15,
        fillOpacity: hit ? baseFill : 0.05
      });
    }

    // Disable interaction for non-matching features.
    const el = layer.getElement?.();
    if (el) el.style.pointerEvents = hit ? 'auto' : 'none';
  });
}

async function updatePanelForMonth(newMonth) {
  if (!selectedFeature || stationMinInt == null || stationMaxInt == null) return;
  const monthInt = clampInt(monthToInt(newMonth), stationMinInt, stationMaxInt);
  stationMonthInt = monthInt;
  const monthStr = intToMonth(monthInt);

  if (stationSliderEl) stationSliderEl.value = String(sliderUiFromOffset(stationSliderEl, stationMonthInt - stationMinInt));
  paintRange(stationSliderEl);
  if (stationMonthLabelEl) stationMonthLabelEl.textContent = `ماه انتخابی: ${toPersianDigits(monthStr.replace(/-/g, '/'))}`;

  const regionId = selectedFeature?.properties?.id;
  const indexName = indexEl.value;
  const levelName = levelEl.value;
  const featureName = selectedFeature?.properties?.name || currentPanelFeatureName || 'ناحیه';

  const reqId = ++panelRequestSeq;
  if (panelAbortController) panelAbortController.abort();
  panelAbortController = new AbortController();
  togglePanelSpinner(true);
  renderPanelLoading(featureName, monthStr);

  const kpiKey = `${regionId}|${levelName}|${indexName}|${monthStr}`;
  const kpi = await fetchCached(
    panelKpiCache,
    kpiKey,
    () => `${API_BASE}/kpi?region_id=${regionId}&level=${levelName}&index=${indexName}&date=${monthStr}`,
    { signal: panelAbortController.signal }
  ).catch(() => ({ error: 'No series found' }));

  if (reqId !== panelRequestSeq) return;

  const effective = kpi?.effective_month || monthStr;
  if (effective && /^\d{4}-\d{2}$/.test(effective)) {
    stationMonthInt = clampInt(monthToInt(effective), stationMinInt, stationMaxInt);
    if (stationSliderEl) stationSliderEl.value = String(sliderUiFromOffset(stationSliderEl, stationMonthInt - stationMinInt));
    paintRange(stationSliderEl);
    if (stationMonthLabelEl) stationMonthLabelEl.textContent = `ماه انتخابی: ${toPersianDigits(effective.replace(/-/g, '/'))}`;
  }

  renderKPI(kpi, featureName, indexName, effective);
  renderChart(currentPanelSeries, indexName, dateEl.value, effective);
  togglePanelSpinner(false);
}

async function loadMap() {
  if (!appIsReady) return;
  const level = levelEl.value;
  const index = indexEl.value;
  const date = dateEl.value;
  const bounds = map.getBounds();
  const bbox = [
    bounds.getWest().toFixed(4),
    bounds.getSouth().toFixed(4),
    bounds.getEast().toFixed(4),
    bounds.getNorth().toFixed(4)
  ].join(',');
  const reqId = ++mapRequestSeq;
  if (mapAbortController) mapAbortController.abort();
  mapAbortController = new AbortController();
  toggleMapLoading(true);

  let data = { type: 'FeatureCollection', features: [] };
  try {
    const mapKey = `${level}|${index}|${date}|${bbox}`;
    data = await fetchCached(
      mapDataCache,
      mapKey,
      () => `${API_BASE}/mapdata?level=${level}&index=${index}&date=${date}&bbox=${encodeURIComponent(bbox)}`,
      { signal: mapAbortController.signal }
    );
    // NOTE: we intentionally avoid prefetching when bbox-based loading is enabled.
    // Adjacent-month prefetch can explode cache keys while the user is panning.
  } catch (_) {}

  if (reqId !== mapRequestSeq) { toggleMapLoading(false); return; }

  toggleMapLoading(false);
  latestMapFeatures = data.features || [];
  if (geoLayer) map.removeLayer(geoLayer);

  const defaultPolyStyle = (f) => ({
    color: '#334155',
    weight: 1,
    opacity: (f?.properties?.has_value === false) ? 0.35 : 1,
    fillOpacity: (f?.properties?.has_value === false) ? 0.12 : 0.78,
    fillColor: (f?.properties?.has_value === false) ? '#e5e7eb' : severityColor(f?.properties?.severity)
  });

  const hoverPolyStyle = {
    color: '#0f172a',
    weight: 2,
    fillOpacity: 0.9
  };

  geoLayer = L.geoJSON(data, {
    style: defaultPolyStyle,
    pointToLayer: (feature, latlng) => L.circleMarker(latlng, {
      radius: (feature?.properties?.has_value === false) ? 6 : 7,
      weight: 1.5,
      color: '#0f172a',
      fillColor: (feature?.properties?.has_value === false) ? '#e5e7eb' : severityColor(feature?.properties?.severity),
      fillOpacity: (feature?.properties?.has_value === false) ? 0.2 : 0.95
    }),
    onEachFeature: (feature, layer) => {
      // Search mode: only matching features should respond to hover/click.
      layer._searchMatch = true;
      layer.on('mouseover', () => {
        if (searchQuery && !layer._searchMatch) return;
        if (layer.setStyle) layer.setStyle(hoverPolyStyle);
        if (layer.bringToFront) layer.bringToFront();
        setHoverInfo(feature, index);
      });

      layer.on('mouseout', () => {
        if (searchQuery && !layer._searchMatch) return;
        if (layer.setStyle) layer.setStyle(defaultPolyStyle(feature));
        setHoverInfo(null);
      });

      layer.on('click', () => {
        if (searchQuery && !layer._searchMatch) return;
        onRegionClick(feature);
      });
    }
  }).addTo(map);

  // Apply active search filter to the new layer.
  applySearchFilter();

  // Do NOT auto-fit on each load. With bbox-driven loading this would trigger
  // endless move events and repeated requests.
}

// Overview chart is computed server-side (no need to download all stations).
async function loadOverview() {
  if (!appIsReady) return;
  const level = levelEl.value;
  const idx = indexEl.value;
  const date = dateEl.value;
  const key = `${level}|${idx}|${date}`;
  try {
    const payload = await fetchCached(
      overviewCache,
      key,
      () => `${API_BASE}/overview?level=${level}&index=${idx}&date=${date}`
    );
    renderOverviewFromCounts(payload);
  } catch (_) {
    // The map can still function even if overview fails.
  }
}

async function onRegionClick(feature) {
  try {
    selectedFeature = feature;
    const regionId = feature?.properties?.id;
    const indexName = indexEl.value;
    const levelName = levelEl.value;
    const featureName = feature?.properties?.name || 'ناحیه';
    currentPanelFeatureName = featureName;
    setPanelOpen(true);

    // Load time series first (we need per-feature min/max to configure panel slider).
    togglePanelSpinner(true);
    setNoDataMessage(false);
    setTimelineDisabled(false);

    const reqId = ++panelRequestSeq;
    if (panelAbortController) panelAbortController.abort();
    panelAbortController = new AbortController();

    renderPanelLoading(featureName, stationMonthInt != null ? intToMonth(stationMonthInt) : dateEl.value);

    const tsKey = `${regionId}|${levelName}|${indexName}|full`;
    const tsPayload = await fetchCached(
      timeseriesCache,
      tsKey,
      () => `${API_BASE}/timeseries?region_id=${regionId}&level=${levelName}&index=${indexName}`,
      { signal: panelAbortController.signal }
    ).catch(() => ({ min_month: null, max_month: null, data: [] }));

    if (reqId !== panelRequestSeq) return;

    const minM = tsPayload?.min_month;
    const maxM = tsPayload?.max_month;
    const series = normalizeTimeseries(tsPayload?.data || []);
    currentPanelSeries = series;

    if (!minM || !maxM || !series.length) {
      stationMinInt = null;
      stationMaxInt = null;
      stationMonthInt = null;
      if (stationSliderEl) stationSliderEl.disabled = true;
      if (stationRangeLabelEl) stationRangeLabelEl.textContent = '—';
      if (stationMonthLabelEl) stationMonthLabelEl.textContent = '—';
      renderKPI({
        latest: NaN,
        min: NaN,
        max: NaN,
        mean: NaN,
        severity: 'N/A',
        trend: { tau: NaN, p_value: '-', sen_slope: NaN, trend: '—' }
      }, featureName, indexName, null);
      setNoDataMessage(true, 'No data for this selection');
      renderChart([], indexName, dateEl.value, dateEl.value);
      togglePanelSpinner(false);
      return;
    }

    // Configure panel (feature) slider to the FULL available range.
    stationMinInt = monthToInt(minM);
    stationMaxInt = monthToInt(maxM);
    const base = (stationMonthInt != null) ? stationMonthInt : monthToInt(dateEl.value);
    stationMonthInt = clampInt(base, stationMinInt, stationMaxInt);

    if (stationSliderEl) {
      stationSliderEl.disabled = false;
      stationSliderEl.min = 0;
      stationSliderEl.max = Math.max(0, stationMaxInt - stationMinInt);
      stationSliderEl.value = String(sliderUiFromOffset(stationSliderEl, stationMonthInt - stationMinInt));
      paintRange(stationSliderEl);
    }
    if (stationRangeLabelEl) {
      stationRangeLabelEl.textContent = `${minM} → ${maxM}`;
    }

    const panelMonth = intToMonth(stationMonthInt);
    if (stationMonthLabelEl) stationMonthLabelEl.textContent = `ماه انتخابی: ${toPersianDigits(panelMonth.replace(/-/g, '/'))}`;

    // KPI uses panel month (NOT global month). The backend auto-adjusts if missing.
    const kpiKey = `${regionId}|${levelName}|${indexName}|${panelMonth}`;
    const kpi = await fetchCached(
      panelKpiCache,
      kpiKey,
      () => `${API_BASE}/kpi?region_id=${regionId}&level=${levelName}&index=${indexName}&date=${panelMonth}`,
      { signal: panelAbortController.signal }
    ).catch(() => ({ error: 'No series found' }));

    if (reqId !== panelRequestSeq) return;

    // If backend adjusted the month (missing data), sync the panel slider.
    const effectiveMonth = kpi?.effective_month || panelMonth;
    if (effectiveMonth && /^\d{4}-\d{2}$/.test(effectiveMonth)) {
      const effInt = monthToInt(effectiveMonth);
      if (stationMinInt != null && stationMaxInt != null) {
        stationMonthInt = clampInt(effInt, stationMinInt, stationMaxInt);
        if (stationSliderEl) stationSliderEl.value = String(sliderUiFromOffset(stationSliderEl, stationMonthInt - stationMinInt));
        if (stationMonthLabelEl) stationMonthLabelEl.textContent = `ماه انتخابی: ${toPersianDigits(effectiveMonth.replace(/-/g, '/'))}`;
      }
    }

    renderKPI(kpi, featureName, indexName, effectiveMonth);
    renderChart(series, indexName, dateEl.value, effectiveMonth);
    togglePanelSpinner(false);
  } catch (err) {
    console.error('onRegionClick error:', err);
    togglePanelSpinner(false);
    setPanelOpen(true);
  }
}

function findSelectedFeatureFromCurrentMap() {
  if (!selectedFeature || !latestMapFeatures.length) return selectedFeature;
  const selectedId = String(selectedFeature?.properties?.id ?? '');
  return latestMapFeatures.find((f) => String(f?.properties?.id ?? '') === selectedId) || selectedFeature;
}

async function onDateChanged() {
  syncGlobalSliderFromInput();
  updateSubtitles();
  await Promise.all([loadMap()]);

  // Do NOT refetch the panel on global date changes.
  // The panel has its own stationMonth (slider) and only needs the chart marker updated.
  if (panelEl.classList.contains('open') && selectedFeature && currentPanelSeries.length) {
    const panelMonth = stationMonthInt != null ? intToMonth(stationMonthInt) : dateEl.value;
    renderChart(currentPanelSeries, indexEl.value, dateEl.value, panelMonth);
  }
}

const debouncedDateChanged = debounce(() => {
  if (mapUpdateDebounce) {
    clearTimeout(mapUpdateDebounce);
  }
  mapUpdateDebounce = setTimeout(() => {
    onDateChanged();
  }, 120);
}, 120);

function setupEvents() {
  document.getElementById('reloadTop').addEventListener('click', () => {
    lastPanelQueryKey = null;
    mapDataCache.clear();
    panelKpiCache.clear();
    timeseriesCache.clear();
    derivedSeriesCache.clear();
    overviewCache.clear();
    lastChartRenderKey = null;
    onDateChanged();
  });
  indexEl.addEventListener('change', async () => {
    lastPanelQueryKey = null;
    await onDateChanged();
    // Index affects the panel series; reload it if open.
    if (panelEl.classList.contains('open') && selectedFeature) {
      await onRegionClick(findSelectedFeatureFromCurrentMap());
    }
  });

  levelEl.addEventListener('change', async () => {
    lastPanelQueryKey = null;
    // Switching dataset layer resets panel state but does NOT reload the page.
    selectedFeature = null;
    currentPanelSeries = [];
    stationMinInt = null;
    stationMaxInt = null;
    stationMonthInt = null;
    if (stationSliderEl) stationSliderEl.disabled = true;
    setPanelOpen(false);
    await loadMetaForSelectedDataset();
    await onDateChanged();
  });

  dateEl.addEventListener('change', () => {
    lastPanelQueryKey = null;
    syncGlobalSliderFromInput();
    debouncedDateChanged();
  });

  if (globalSliderEl) {
    globalSliderEl.addEventListener('input', () => {
      lastPanelQueryKey = null;
      syncGlobalInputFromSlider();
      debouncedDateChanged();
    });
  }

  document.getElementById('prevMonth').addEventListener('click', () => {
    if (globalMinMonth && dateEl.value <= globalMinMonth) return;
    lastPanelQueryKey = null;
    dateEl.value = addMonth(dateEl.value, -1);
    syncGlobalSliderFromInput();
    debouncedDateChanged();
  });
  document.getElementById('nextMonth').addEventListener('click', () => {
    if (globalMaxMonth && dateEl.value >= globalMaxMonth) return;
    lastPanelQueryKey = null;
    dateEl.value = addMonth(dateEl.value, 1);
    syncGlobalSliderFromInput();
    debouncedDateChanged();
  });
  document.getElementById('toStart').addEventListener('click', () => {
    if (!globalMinMonth) return;
    lastPanelQueryKey = null;
    dateEl.value = globalMinMonth;
    syncGlobalSliderFromInput();
    debouncedDateChanged();
  });
  document.getElementById('toEnd').addEventListener('click', () => {
    if (!globalMaxMonth) return;
    lastPanelQueryKey = null;
    dateEl.value = globalMaxMonth;
    syncGlobalSliderFromInput();
    debouncedDateChanged();
  });

  // Feature (panel) month slider + sync button
  if (stationSliderEl) {
    stationSliderEl.addEventListener('input', () => {
      if (stationMinInt == null) return;
      paintRange(stationSliderEl);
      const offset = sliderOffsetFromUi(stationSliderEl);
      updatePanelForMonth(intToMonth(stationMinInt + offset));
    });
  }

  if (syncToMapBtn) {
    syncToMapBtn.addEventListener('click', () => {
      if (stationMinInt == null || stationMaxInt == null) return;
      const target = clampInt(monthToInt(dateEl.value), stationMinInt, stationMaxInt);
      updatePanelForMonth(intToMonth(target));
    });
  }

  if (closeBtn) closeBtn.addEventListener('click', () => { lastPanelQueryKey = null; setPanelOpen(false); });

  if (panelEl) panelEl.addEventListener('click', (e) => e.stopPropagation());

  // Mobile drawers
  if (toggleSidebarBtn) {
    toggleSidebarBtn.addEventListener('click', () => {
      setSidebarOpen(!state.sidebarOpen);
      setPanelOpen(false);
      invalidateMapSoon();
    });
  }
  if (togglePanelBtn) {
    togglePanelBtn.addEventListener('click', () => {
      setPanelOpen(!state.panelOpen);
      setSidebarOpen(false);
      invalidateMapSoon();
    });
  }

  // Backdrop click closes drawers / modal
  if (modalBackdropEl) {
    modalBackdropEl.addEventListener('click', () => {
      setSidebarOpen(false);
      setPanelOpen(false);
      setAboutModalOpen(false);
      invalidateMapSoon();
    });
  }

  // Modal
  if (aboutOpenBtn) aboutOpenBtn.addEventListener('click', () => setAboutModalOpen(true));
  if (aboutCloseBtn) aboutCloseBtn.addEventListener('click', () => setAboutModalOpen(false));
  if (aboutOkBtn) aboutOkBtn.addEventListener('click', () => setAboutModalOpen(false));

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (state.modalOpen) { setAboutModalOpen(false); return; }
    if (isMobileViewport() && state.sidebarOpen) { setSidebarOpen(false); return; }
    if (isMobileViewport() && state.panelOpen) { lastPanelQueryKey = null; setPanelOpen(false); return; }
  });

  const searchEl = document.getElementById('search');
  if (searchEl) {
    searchEl.addEventListener('input', (e) => {
      searchQuery = e.target.value.trim();
      applySearchFilter();
    });
  }

  if (clearSearchBtn) {
    clearSearchBtn.addEventListener('click', () => {
      searchQuery = '';
      if (searchEl) searchEl.value = '';
      applySearchFilter();
    });
  }

  const indexHelpBtn = document.getElementById('indexHelpBtn');
  const trendHelpBtn = document.getElementById('trendHelpBtn');
  const indexHelpPanel = document.getElementById('indexHelpPanel');
  const trendHelpPanel = document.getElementById('trendHelpPanel');

  function toggleHelp(panelEl) {
    if (!panelEl) return;
    panelEl.classList.toggle('d-none');
  }

  if (indexHelpBtn) indexHelpBtn.addEventListener('click', () => toggleHelp(indexHelpPanel));
  if (trendHelpBtn) trendHelpBtn.addEventListener('click', () => toggleHelp(trendHelpPanel));

  document.querySelectorAll('[data-close-help]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-close-help');
      const panel = id ? document.getElementById(id) : null;
      if (panel) panel.classList.add('d-none');
    });
  });

  // Basemap
  if (basemapEl) {
    basemapEl.addEventListener('change', () => {
      const key = basemapEl.value;
      const next = BASEMAPS[key] || BASEMAPS.carto;
      if (activeBasemap) map.removeLayer(activeBasemap);
      activeBasemap = next.addTo(map);
    });
  }

  if (resetViewBtn) {
    resetViewBtn.addEventListener('click', () => {
      map.setView(DEFAULT_VIEW.center, DEFAULT_VIEW.zoom);
    });
  }

  // Lazy loading: fetch only stations inside the current viewport.
  // Debounced to avoid firing during continuous panning.
  const debouncedMove = debounce(() => {
    loadMap();
  }, 180);
  map.on('moveend', debouncedMove);

  // Responsive housekeeping
  window.addEventListener('resize', () => {
    updateHeaderHeightVar();
    if (overviewChart) overviewChart.resize();
    invalidateMapSoon();

    // If we leave mobile, clear drawer states
    if (!isMobileViewport()) {
      state.sidebarOpen = false;
      state.panelOpen = false;
      sidebarEl?.classList.remove('open');
      panelEl?.classList.remove('open');
      sidebarEl?.setAttribute('aria-hidden', 'false');
      panelEl?.setAttribute('aria-hidden', 'false');
      updateBackdrop();
    } else {
      // On mobile, keep closed unless explicitly opened
      setSidebarOpen(state.sidebarOpen);
      setPanelOpen(state.panelOpen);
    }
  });
}

async function initApp() {
  // Provide a fast local fallback if the backend endpoints aren't ready.
  populateIndexOptions();
  addMapLegend();
  setupEvents();
  updateHeaderHeightVar();

  try {
    await loadDatasetsList();
    await loadMetaForSelectedDataset();
  } catch (err) {
    // Backend not ready or dataset not imported yet.
    if (mapSubtitleEl) {
      mapSubtitleEl.textContent = 'داده‌ای وارد نشده است. لطفاً import_data.py را اجرا کنید.';
    }
    // Fallback: at least have a "station" option so UI doesn't break.
    if (!levelEl.options.length) {
      levelEl.innerHTML = '<option value="station">ایستگاهی</option>';
    }
  }

  updateSubtitles();
  appIsReady = true;
  await Promise.all([loadMap()]);
}

initApp();

