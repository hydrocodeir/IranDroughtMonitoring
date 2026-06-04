const API_BASE = window.API_BASE_URL || "http://localhost:8000";
// const API_BASE = "http://localhost:8000";

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
    const sortedIndices = sortIndexOptions(meta.indices);
    indexEl.textContent = '';
    const fragment = document.createDocumentFragment();
    sortedIndices.forEach((idx) => {
      const m = String(idx).match(/^(spi|spei|ssi)(\d+)$/i);
      const label = m ? `${m[1].toUpperCase()}-${m[2]}` : String(idx).toUpperCase();
      const option = document.createElement('option');
      option.value = String(idx).toLowerCase();
      option.textContent = label;
      fragment.appendChild(option);
    });
    indexEl.appendChild(fragment);

    const preferred = ['spi3', 'spei3', 'ssi3', sortedIndices[0]];
    const chosen = preferred.find((v) => sortedIndices.includes(v)) || sortedIndices[0];
    if (!hasInitializedIndexSelection) {
      // Initial app load: default to SPI-3, then SPEI-3, then SSI-3.
      indexEl.value = chosen;
      hasInitializedIndexSelection = true;
    } else {
      indexEl.value = sortedIndices.includes(indexEl.value) ? indexEl.value : chosen;
    }
  }

  if (meta.min_month && meta.max_month) {
    setGlobalBounds(meta.min_month, meta.max_month);
    // If the current date is unset, default to dataset max.
    if (!normalizeMonthInput(dateEl.value)) setDateValue(meta.max_month);
    // Ensure slider is in sync.
    syncGlobalSliderFromInput();
  }
}
syncBootstrapDir();

// ---------- Map (Leaflet) ----------
const DEFAULT_VIEW = Object.freeze({ center: [30, 0], zoom: 2 });
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
let selectedOverlayLayer = L.layerGroup().addTo(map);
let chart;
let overviewChart;
let selectedFeature = null;
let latestMapFeatures = [];
let currentMapFeatures = [];
let currentMapIndex = null;
let currentMapClimateRange = null;
let currentRangeStart = null;
let currentRangeEnd = null;
let mapRequestSeq = 0;
let panelRequestSeq = 0;
let overviewRequestSeq = 0;
let lastPanelQueryKey = null;
let mapUpdateDebounce = null;
let mapAbortController = null;
let panelAbortController = null;
let overviewAbortController = null;
let lastChartRenderKey = null;
let chartResizeBound = false;
let appIsReady = false;
let hasInitializedIndexSelection = false;
let suppressNextMapAutoSelect = false;
let mapResizeObserver = null;
let chartZoomLast5Years = false;

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
let showAllStationMarkers = false;
let currentSearchSuggestions = [];
let activeSearchSuggestionIndex = -1;
let suggestionPointerActivated = false;

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
const appShellEl = document.getElementById('appShell');
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
const panelCountryEl = document.getElementById('panelCountry');
const syncToMapBtn = document.getElementById('syncToMap');
const syncToPanelBtn = document.getElementById('syncToPanel');
const chartZoomToggleEl = document.getElementById('chartZoomToggle');
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

const hoverIndexEl = document.getElementById('hoverIndex');
const hoverValueEl = document.getElementById('hoverValue');
const hoverSeverityEl = document.getElementById('hoverSeverity');
const hoverTrendEl = document.getElementById('hoverTrend');
const markerModeToggleEl = document.getElementById('markerModeToggle');
const searchSuggestionsEl = document.getElementById('searchSuggestions');
const closeSidebarBtn = document.getElementById('closeSidebar');
const mobileMapTabBtn = document.getElementById('mobileMapTab');
const mobileFiltersTabBtn = document.getElementById('mobileFiltersTab');
const mobileAnalysisTabBtn = document.getElementById('mobileAnalysisTab');

const MONTH_RE = /^\d{4}-\d{2}$/;

function normalizeMonthInput(value) {
  const raw = toLatinDigits(value).trim();
  return MONTH_RE.test(raw) ? raw : '';
}

function ensureMonthInputValue() {
  if (!dateEl) return;
  dateEl.type = 'month';
  dateEl.inputMode = 'numeric';
  dateEl.autocomplete = 'off';
  dateEl.spellcheck = false;
  dateEl.lang = 'en-US';
  dateEl.value = normalizeMonthInput(dateEl.value || '2020-01') || '2020-01';
}

function setDateValue(monthValue) {
  const normalized = normalizeMonthInput(monthValue);
  if (normalized) dateEl.value = normalized;
}

function getDateValue() {
  return normalizeMonthInput(dateEl.value) || '2020-01';
}

const basemapEl = document.getElementById('basemap');
const resetViewBtn = document.getElementById('resetView');

const toggleSidebarBtn = document.getElementById('toggleSidebar');
const togglePanelBtn = document.getElementById('togglePanel');

const aboutOpenBtn = document.getElementById('openAbout');
const aboutModalEl = document.getElementById('aboutModal');
const aboutCloseBtn = document.getElementById('aboutClose');
const aboutOkBtn = document.getElementById('aboutOk');
const contactOpenBtn = document.getElementById('openContact');
const contactModalEl = document.getElementById('contactModal');
const contactCloseBtn = document.getElementById('contactClose');
const contactOkBtn = document.getElementById('contactOk');
const startupNoticeModalEl = document.getElementById('startupNoticeModal');
const startupNoticeCloseBtn = document.getElementById('startupNoticeClose');
const startupNoticeOkBtn = document.getElementById('startupNoticeOk');

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
  station: 'Station',
  province: 'Province',
  county: 'County',
  level1: 'Level 1 Basin',
  level2: 'Level 2 Basin',
  level3: 'Level 3 Basin'
};

// Filled from GET /datasets. Used for UI labels while still
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

function isDroughtIndex(indexName) {
  return /^(spi|spei)\d+$/i.test(String(indexName || '').trim());
}

function isBarClimateIndex(indexName) {
  const idx = String(indexName || '').trim().toLowerCase();
  return idx.includes('precip') || idx.includes('pet');
}

function sortIndexOptions(indices) {
  const unique = [...new Set((indices || []).map((idx) => String(idx || '').trim().toLowerCase()).filter(Boolean))];
  const parsed = (value) => {
    const match = String(value).match(/^(spi|spei|ssi)(\d+)$/i);
    if (!match) return { family: 3, window: Number.MAX_SAFE_INTEGER, label: String(value).toLowerCase(), raw: String(value).toLowerCase() };
    const familyOrder = { spi: 0, spei: 1, ssi: 2 };
    return {
      family: familyOrder[match[1].toLowerCase()] ?? 3,
      window: Number(match[2]),
      label: `${match[1].toUpperCase()}-${match[2]}`,
      raw: `${match[1].toLowerCase()}${match[2]}`
    };
  };
  return unique.sort((a, b) => {
    const pa = parsed(a);
    const pb = parsed(b);
    if (pa.family !== pb.family) return pa.family - pb.family;
    if (pa.window !== pb.window) return pa.window - pb.window;
    return pa.label.localeCompare(pb.label) || pa.raw.localeCompare(pb.raw);
  });
}

function getFeatureDisplayName(feature) {
  return feature?.properties?.station_name
    || feature?.properties?.name
    || feature?.properties?.title
    || feature?.properties?.id
    || 'Region';
}

function getFeatureId(feature) {
  return String(
    feature?.properties?.id
    ?? feature?.properties?.station_id
    ?? feature?.properties?.feature_id
    ?? ''
  ).trim();
}

function isSelectedFeature(feature) {
  const selectedId = getFeatureId(selectedFeature);
  return Boolean(selectedId) && getFeatureId(feature) === selectedId;
}

function getFeatureCountry(feature) {
  return feature?.properties?.country
    || feature?.properties?.Country
    || '';
}

function isPointFeature(feature) {
  return String(feature?.geometry?.type || '').toLowerCase() === 'point';
}

function featureMatchesSearch(feature) {
  const q = String(searchQuery || '').trim().toLowerCase();
  if (!q) return true;
  const name = String(getFeatureDisplayName(feature)).toLowerCase();
  const country = String(getFeatureCountry(feature)).toLowerCase();
  const province = String(feature?.properties?.province || feature?.properties?.Province || '').toLowerCase();
  const id = getFeatureId(feature).toLowerCase();
  return name.includes(q) || country.includes(q) || province.includes(q) || id.includes(q);
}

function featureMatchesQuery(feature, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  const name = String(getFeatureDisplayName(feature)).toLowerCase();
  const country = String(getFeatureCountry(feature)).toLowerCase();
  const province = String(feature?.properties?.province || feature?.properties?.Province || '').toLowerCase();
  const id = getFeatureId(feature).toLowerCase();
  return name.includes(q) || country.includes(q) || province.includes(q) || id.includes(q);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function highlightMatchText(value, query) {
  const text = String(value ?? '');
  const q = String(query || '').trim();
  if (!q) return escapeHtml(text);
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const idx = lower.indexOf(needle);
  if (idx < 0) return escapeHtml(text);
  const before = escapeHtml(text.slice(0, idx));
  const match = escapeHtml(text.slice(idx, idx + q.length));
  const after = escapeHtml(text.slice(idx + q.length));
  return `${before}<mark>${match}</mark>${after}`;
}

function collectSearchSuggestions(query, limit = 8) {
  const q = String(query || '').trim();
  if (!q) return [];
  const matches = (currentMapFeatures || []).filter((feature) => featureMatchesQuery(feature, q));
  const scored = matches.map((feature) => {
    const name = getFeatureDisplayName(feature);
    const id = getFeatureId(feature);
    const nameLower = name.toLowerCase();
    const idLower = id.toLowerCase();
    const qLower = q.toLowerCase();
    const starts = nameLower.startsWith(qLower) || idLower.startsWith(qLower) ? 0 : 1;
    return { feature, name, id, starts };
  });
  scored.sort((a, b) => a.starts - b.starts || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return scored.slice(0, limit);
}

function hideSearchSuggestions() {
  if (!searchSuggestionsEl) return;
  searchSuggestionsEl.classList.add('d-none');
  searchSuggestionsEl.innerHTML = '';
  currentSearchSuggestions = [];
  activeSearchSuggestionIndex = -1;
  suggestionPointerActivated = false;
}

function renderSearchSuggestions(query, preferredIndex = 0) {
  if (!searchSuggestionsEl) return;
  const items = collectSearchSuggestions(query);
  currentSearchSuggestions = items;
  activeSearchSuggestionIndex = items.length ? clampInt(preferredIndex, 0, items.length - 1) : -1;
  if (!items.length) {
    hideSearchSuggestions();
    return;
  }

  searchSuggestionsEl.innerHTML = items.map((item, index) => {
    const active = index === activeSearchSuggestionIndex ? ' is-active' : '';
    return `
      <button type="button" class="search-suggestion${active}" role="option" aria-selected="${index === activeSearchSuggestionIndex}">
        <span class="search-suggestion__name">${highlightMatchText(item.name, query)}</span>
        <span class="search-suggestion__id">${highlightMatchText(item.id || '—', query)}</span>
      </button>
    `;
  }).join('');
  searchSuggestionsEl.classList.remove('d-none');

  searchSuggestionsEl.querySelectorAll('.search-suggestion').forEach((btn, index) => {
    btn.addEventListener('mouseenter', () => {
      activeSearchSuggestionIndex = index;
      renderSearchSuggestions(query, index);
    });
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      suggestionPointerActivated = true;
      const item = currentSearchSuggestions[index];
      if (item) selectSearchSuggestion(item.feature);
    });
    btn.addEventListener('click', () => {
      if (suggestionPointerActivated) {
        suggestionPointerActivated = false;
        return;
      }
      const item = currentSearchSuggestions[index];
      if (item) selectSearchSuggestion(item.feature);
      suggestionPointerActivated = false;
    });
  });
}

function focusFeatureOnMap(feature) {
  if (!feature) return;
  const geo = L.geoJSON(feature);
  const bounds = geo.getBounds();
  if (bounds && bounds.isValid && bounds.isValid()) {
    const pad = isPointFeature(feature) ? 0.5 : 0.2;
    map.fitBounds(bounds.pad(pad), { maxZoom: 9 });
  }
  geo.remove();
}

function syncSelectedFeatureOverlay() {
  if (!selectedOverlayLayer) {
    selectedOverlayLayer = L.layerGroup().addTo(map);
  }
  selectedOverlayLayer.clearLayers();
  const feature = findSelectedFeatureFromCurrentMap();
  if (!feature) return;
  const overlay = isPointFeature(feature)
    ? buildPointMarker(feature, currentMapIndex)
    : buildPolygonLayer([feature], currentMapIndex);
  if (overlay) {
    selectedOverlayLayer.addLayer(overlay);
    if (overlay.bringToFront) overlay.bringToFront();
  }
}

function selectSearchSuggestion(feature) {
  if (!feature) return;
  const name = getFeatureDisplayName(feature);
  searchQuery = String(name || '').trim();
  if (document.getElementById('search')) {
    document.getElementById('search').value = searchQuery;
  }
  hideSearchSuggestions();
  focusFeatureOnMap(feature);
  onRegionClick(feature);
}

function clusterVisuals(count) {
  if (count >= 1000) return { size: 58, bg: '#f97316', ring: '#fdba74', text: '#431407' };
  if (count >= 250) return { size: 52, bg: '#fb923c', ring: '#fed7aa', text: '#4a1d09' };
  if (count >= 75) return { size: 46, bg: '#facc15', ring: '#fde68a', text: '#713f12' };
  if (count >= 20) return { size: 42, bg: '#fde047', ring: '#fef08a', text: '#713f12' };
  return { size: 38, bg: '#86efac', ring: '#bbf7d0', text: '#14532d' };
}

function formatClusterCount(count) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(count);
}

function clusterIcon(count) {
  const visuals = clusterVisuals(count);
  const fontSize = count >= 1000 ? 12 : 13;
  return L.divIcon({
    className: 'station-cluster',
    html: `<div class="station-cluster__bubble" style="width:${visuals.size}px;height:${visuals.size}px;border-radius:50%;background:${visuals.bg};border:5px solid ${visuals.ring};color:${visuals.text};display:flex;align-items:center;justify-content:center;font-size:${fontSize}px;font-weight:800;line-height:1;box-shadow:0 10px 22px rgba(15,23,42,0.18);">${formatClusterCount(count)}</div>`,
    iconSize: [visuals.size, visuals.size],
    iconAnchor: [visuals.size / 2, visuals.size / 2]
  });
}

function clusterSignIcon(count, value) {
  const base = clusterVisuals(count);
  const tone = clusterToneVisuals(value);
  const fontSize = count >= 1000 ? 12 : 13;
  return L.divIcon({
    className: 'station-cluster',
    html: `<div class="station-cluster__bubble" style="width:${base.size}px;height:${base.size}px;border-radius:50%;background:${tone.bg};border:5px solid ${tone.ring};color:${tone.text};display:flex;align-items:center;justify-content:center;font-size:${fontSize}px;font-weight:800;line-height:1;box-shadow:0 10px 22px rgba(15,23,42,0.18);">${formatClusterCount(count)}</div>`,
    iconSize: [base.size, base.size],
    iconAnchor: [base.size / 2, base.size / 2]
  });
}

function pointRadiusForFeature(feature, index, climateRange) {
  const hasValue = feature?.properties?.has_value !== false;
  const base = !hasValue
    ? 6
    : (!isDroughtIndex(index)
      ? climatePointRadius(Math.abs(Number(feature?.properties?.value)), climateRange)
      : 7);
  return isTouchLikeDevice() ? Math.max(base + 4, 12) : base;
}

function pointStyleForFeature(feature, index, climateRange) {
  const selected = isSelectedFeature(feature);
  const searched = searchQuery && featureMatchesSearch(feature);
  const hasValue = feature?.properties?.has_value !== false;
  const value = Number(feature?.properties?.value);
  const fillColor = hasValue ? mapValueColor(value, index) : '#e5e7eb';
  const baseRadius = pointRadiusForFeature(feature, index, climateRange);
  return {
    radius: selected ? Math.max(baseRadius + 3, 10) : (searched ? baseRadius + 1.5 : baseRadius),
    weight: selected ? 3.5 : (searched ? 2.5 : 1.5),
    color: selected ? '#1d4ed8' : (searched ? '#0f766e' : fillColor),
    fillColor: selected ? '#f8fafc' : (searched ? '#ccfbf1' : fillColor),
    fillOpacity: selected ? 1 : (searched ? 1 : (hasValue ? 0.95 : 0.2)),
    opacity: 1,
    className: [
      selected ? 'station-marker--selected' : '',
      searched && !selected ? 'station-marker--search-match' : ''
    ].filter(Boolean).join(' ')
  };
}

function buildPointMarker(feature, index) {
  const coords = feature?.geometry?.coordinates || [];
  if (coords.length < 2) return null;
  const latlng = L.latLng(Number(coords[1]), Number(coords[0]));
  const marker = L.circleMarker(latlng, pointStyleForFeature(feature, index, currentMapClimateRange));
  let touchActivated = false;
  if (!isTouchLikeDevice()) {
    marker.on('mouseover', () => {
      if (searchQuery && !featureMatchesSearch(feature)) return;
      setHoverInfo(feature, index);
    });
    marker.on('mouseout', () => {
      if (searchQuery && !featureMatchesSearch(feature)) return;
      setHoverInfo(null);
    });
  }
  marker.on('click', () => {
    if (touchActivated) return;
    if (searchQuery && !featureMatchesSearch(feature)) return;
    onRegionClick(feature);
  });
  if (isTouchLikeDevice()) {
    marker.on('touchend', (e) => {
      if (searchQuery && !featureMatchesSearch(feature)) return;
      e?.originalEvent?.preventDefault?.();
      e?.originalEvent?.stopPropagation?.();
      touchActivated = true;
      setTimeout(() => { touchActivated = false; }, 350);
      onRegionClick(feature);
    });
  }
  if (isSelectedFeature(feature) && marker.bringToFront) {
    marker.on('add', () => marker.bringToFront());
  }
  return marker;
}


function populateIndexOptions() {
  const windows = [1, 3, 6, 9, 12, 15, 18, 21, 24];
  indexEl.textContent = '';
  const fragment = document.createDocumentFragment();
  for (const monthWindow of windows) {
    const spiOption = document.createElement('option');
    spiOption.value = `spi${monthWindow}`;
    spiOption.textContent = `SPI-${monthWindow}`;
    fragment.appendChild(spiOption);
  }
  indexEl.appendChild(fragment);
  indexEl.value = 'spi3';
}

const severityLong = {
  'Normal/Wet': 'Normal/Wet',
  'D0': 'D0 - Abnormally Dry',
  'D1': 'D1 - Moderate Drought',
  'D2': 'D2 - Severe Drought',
  'D3': 'D3 - Extreme Drought',
  'D4': 'D4 - Exceptional Drought'
};

function severityColor(sev) { return droughtColors[sev] || '#60a5fa'; }

function mapSignTone(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 'neutral';
  if (num > 0) return 'positive';
  if (num < 0) return 'negative';
  return 'neutral';
}

function mapValueColor(value, indexName) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '#e5e7eb';
  if (isDroughtIndex(indexName)) return severityColor(classify(num));
  const tone = mapSignTone(value);
  if (tone === 'positive') return '#2563eb';
  if (tone === 'negative') return '#dc2626';
  return '#9ca3af';
}

function clusterToneVisuals(value) {
  const tone = mapSignTone(value);
  if (tone === 'positive') return { bg: 'rgba(37, 99, 235, 0.88)', ring: 'rgba(37, 99, 235, 0.30)', text: '#ffffff' };
  if (tone === 'negative') return { bg: 'rgba(220, 38, 38, 0.88)', ring: 'rgba(220, 38, 38, 0.30)', text: '#ffffff' };
  return { bg: 'rgba(107, 114, 128, 0.86)', ring: 'rgba(107, 114, 128, 0.26)', text: '#ffffff' };
}

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
    return { category: 'none', symbol: '—', labelEn: 'No Significant Trend', labelFa: 'No Significant Trend', tone: 'neu' };
  }
  if (Number.isFinite(slope) && slope > 0) {
    return { category: 'inc', symbol: '↑', labelEn: 'Increasing Trend (Wetter)', labelFa: 'Increasing Trend (Wetter)', tone: 'pos' };
  }
  if (Number.isFinite(slope) && slope < 0) {
    return { category: 'dec', symbol: '↓', labelEn: 'Decreasing Trend (Drier)', labelFa: 'Decreasing Trend (Drier)', tone: 'neg' };
  }
  return { category: 'none', symbol: '—', labelEn: 'No Significant Trend', labelFa: 'No Significant Trend', tone: 'neu' };
}

function trendLabelForIndex(indexName, trend) {
  const t = classifyTrend(trend, 0.05);
  if (isDroughtIndex(indexName)) return t;
  if (t.category === 'inc') return { ...t, labelEn: 'Increasing Trend', labelFa: 'Increasing Trend' };
  if (t.category === 'dec') return { ...t, labelEn: 'Decreasing Trend', labelFa: 'Decreasing Trend' };
  return t;
}

function toLatinDigits(value) {
  return String(value ?? '')
    .replace(/[۰-۹]/g, (d) => '0123456789'[d.charCodeAt(0) - 1776])
    .replace(/[٠-٩]/g, (d) => '0123456789'[d.charCodeAt(0) - 1632]);
}

function formatNumber(value, digits = 4) {
  const num = Number(toLatinDigits(value));
  if (!Number.isFinite(num)) return '—';
  return num.toFixed(digits);
}

function formatPValue(value) {
  const raw = toLatinDigits(value).trim();
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
  const [y, m] = (normalizeMonthInput(yyyymm) || '2020-01').split('-').map(Number);
  const dt = new Date(y, m - 1 + delta, 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
}

function toMonthLabel(yyyymm) {
  const [y, m] = (normalizeMonthInput(yyyymm) || '2020-01').split('-').map(Number);
  const labels = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return { month: labels[m - 1] || String(m), year: y };
}

function toISODate(yyyymm) { return `${yyyymm}-01`; }

function toChartMonthStart(yyyymm) { return `${yyyymm}-01`; }

// Month parsing helpers (no off-by-one conversions).
function monthToInt(yyyymm) {
  const [y, m] = toLatinDigits(yyyymm || '1970-01').split('-').map(Number);
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
  const raw = toLatinDigits(value || '');
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
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const payload = await res.json();
      message = payload?.error?.message || payload?.detail?.message || payload?.detail || message;
    } catch (_) {}
    throw new Error(message);
  }
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
  if (togglePanelBtn) {
    togglePanelBtn.setAttribute('aria-expanded', String(state.panelOpen));
  }
  if (isMobileViewport() && state.panelOpen) setMobileSection('analysis');
  if (isMobileViewport() && !state.panelOpen && state.mobileSection === 'analysis') setMobileSection('map');
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

function isTouchLikeDevice() {
  return window.matchMedia('(pointer: coarse)').matches || window.matchMedia('(hover: none)').matches || Boolean(L?.Browser?.touch);
}

function setTimelineButtonLabels() {
  const mobile = isMobileViewport();
  const labels = mobile
    ? { toEnd: '>>', nextMonth: '>', prevMonth: '<', toStart: '<<' }
    : { toEnd: 'Latest', nextMonth: 'Next', prevMonth: 'Prev', toStart: 'Start' };
  const map = [
    ['toEnd', labels.toEnd],
    ['nextMonth', labels.nextMonth],
    ['prevMonth', labels.prevMonth],
    ['toStart', labels.toStart],
  ];
  map.forEach(([id, label]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = label;
  });
}

const state = {
  sidebarOpen: false,
  panelOpen: false,
  modalOpen: false,
  activeModalId: '',
  mobileSection: 'map',
};

function syncMobileWorkspaceUI() {
  if (!appShellEl) return;
  appShellEl.dataset.mobileSection = state.mobileSection;
  const active = state.mobileSection;
  if (mobileMapTabBtn) {
    mobileMapTabBtn.classList.toggle('btn-primary', active === 'map');
    mobileMapTabBtn.classList.toggle('btn-outline-primary', active !== 'map');
  }
  if (mobileFiltersTabBtn) {
    mobileFiltersTabBtn.classList.toggle('btn-primary', active === 'filters');
    mobileFiltersTabBtn.classList.toggle('btn-outline-primary', active !== 'filters');
  }
  if (mobileAnalysisTabBtn) {
    mobileAnalysisTabBtn.classList.toggle('btn-primary', active === 'analysis');
    mobileAnalysisTabBtn.classList.toggle('btn-outline-primary', active !== 'analysis');
  }
}

function setMobileSection(section) {
  const next = ['map', 'filters', 'analysis'].includes(section) ? section : 'map';
  state.mobileSection = next;
  syncMobileWorkspaceUI();
  if (isMobileViewport() && next === 'map') invalidateMapSoon();
}

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
  if (toggleSidebarBtn) {
    toggleSidebarBtn.setAttribute('aria-expanded', String(state.sidebarOpen));
  }
  if (isMobileViewport() && state.sidebarOpen) setMobileSection('filters');
  if (isMobileViewport() && !state.sidebarOpen && state.mobileSection === 'filters') setMobileSection('map');
  updateBackdrop();
}

function scrollModalToTop(modalEl) {
  if (!modalEl) return;
  const dialog = modalEl.querySelector('.app-modal__dialog');
  modalEl.scrollTop = 0;
  if (dialog) {
    dialog.scrollTop = 0;
    dialog.scrollIntoView?.({ block: 'start', inline: 'nearest' });
  }
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
  window.scrollTo?.(0, 0);
}

function setModalOpen(modalEl, open, focusTarget = null) {
  if (!modalEl) return;
  const nextOpen = Boolean(open);
  [aboutModalEl, contactModalEl, startupNoticeModalEl].forEach((candidate) => {
    if (!candidate || candidate === modalEl) return;
    candidate.classList.remove('open');
    candidate.setAttribute('aria-hidden', 'true');
  });
  state.modalOpen = nextOpen;
  state.activeModalId = nextOpen ? (modalEl.id || '') : '';
  modalEl.classList.toggle('open', nextOpen);
  modalEl.setAttribute('aria-hidden', String(!nextOpen));
  updateBackdrop();

  if (nextOpen) {
    scrollModalToTop(modalEl);
    setTimeout(() => {
      scrollModalToTop(modalEl);
      (focusTarget || modalEl).focus?.();
    }, 0);
  }
}

function closeActiveModal() {
  if (state.activeModalId === 'aboutModal') setModalOpen(aboutModalEl, false);
  else if (state.activeModalId === 'contactModal') setModalOpen(contactModalEl, false);
  else if (state.activeModalId === 'startupNoticeModal') setModalOpen(startupNoticeModalEl, false);
}

function setAboutModalOpen(open) {
  setModalOpen(aboutModalEl, open, aboutOkBtn || aboutCloseBtn || aboutModalEl);
}

function setContactModalOpen(open) {
  setModalOpen(contactModalEl, open, contactOkBtn || contactCloseBtn || contactModalEl);
}

function setStartupNoticeOpen(open) {
  setModalOpen(startupNoticeModalEl, open, startupNoticeOkBtn || startupNoticeCloseBtn || startupNoticeModalEl);
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

function setupMapResizeObserver() {
  if (mapResizeObserver || typeof ResizeObserver === 'undefined') return;
  const target = document.getElementById('map');
  if (!target) return;
  mapResizeObserver = new ResizeObserver(() => {
    invalidateMapSoon();
  });
  mapResizeObserver.observe(target);
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
  const droughtMode = isDroughtIndex(indexLabel);
  const sev = droughtMode ? (kpi.severity || '-') : '—';
  document.getElementById('panelTitle').textContent = `${featureName}`;
  if (panelCountryEl) {
    const country = getFeatureCountry(selectedFeature);
    panelCountryEl.textContent = country ? `Country: ${country}` : '';
  }
  const m = panelMonth || getDateValue();
  document.getElementById('panelSubtitle').textContent = `Selected date: ${String(m).replace(/-/g, '/')}`;
  const metricLabelEl = document.getElementById('mainMetricLabel');
  if (metricLabelEl) metricLabelEl.textContent = `${formatIndexLabel(indexLabel)} value`;
  document.getElementById('mainMetricValue').textContent = formatNumber(kpi.latest);
  document.getElementById('severityBadge').textContent = droughtMode ? (severityLong[sev] || sev) : 'Climate variable';
  if (droughtMode) applySeverityStyle(sev);

  document.getElementById('tauVal').textContent = formatNumber(kpi.trend?.tau);
  document.getElementById('pVal').textContent = formatPValue(kpi.trend?.p_value);
  document.getElementById('senVal').textContent = formatNumber(kpi.trend?.sen_slope);

  // Trend status + note (3-class, consistent across map/tooltips/panel)
  const t = trendLabelForIndex(indexLabel, kpi.trend);
  const trendStatusEl = document.getElementById('trendStatus');
  if (trendStatusEl) {
    trendStatusEl.textContent = `${t.symbol} ${t.labelEn}`;
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

function renderPanelLoading(featureName = 'Region', panelMonth = null) {
  document.getElementById('panelTitle').textContent = `${featureName}`;
  if (panelCountryEl) {
    const country = getFeatureCountry(selectedFeature);
    panelCountryEl.textContent = country ? `Country: ${country}` : '';
  }
  const m = panelMonth || getDateValue();
  document.getElementById('panelSubtitle').textContent = `Selected date: ${String(m).replace(/-/g, '/')}`;
  const metricLabelEl = document.getElementById('mainMetricLabel');
  if (metricLabelEl) metricLabelEl.textContent = `${formatIndexLabel(indexEl.value)} value`;
  document.getElementById('mainMetricValue').textContent = '...';
  document.getElementById('severityBadge').textContent = 'Loading';
  const trendStatusEl = document.getElementById('trendStatus');
  const trendNoteEl = document.getElementById('trendNote');
  if (trendStatusEl) trendStatusEl.textContent = '—';
  if (trendNoteEl) trendNoteEl.textContent = 'Loading...';
  ['tauVal', 'pVal', 'senVal'].forEach((id) => {
    document.getElementById(id).textContent = '...';
  });
}

function togglePanelSpinner(show) {
  if (!panelSpinnerEl) return;
  panelSpinnerEl.classList.toggle('d-none', !show);
  panelEl?.setAttribute('aria-busy', String(Boolean(show)));
}

function toggleMapLoading(show) {
  if (!mapLoadingEl) return;
  mapLoadingEl.classList.toggle('show', show);
  const mapEl = document.getElementById('map');
  mapEl?.setAttribute('aria-busy', String(Boolean(show)));
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
  const trendStatusEl = document.getElementById('trendStatus');
  const trendNoteEl = document.getElementById('trendNote');
  if (!show) {
    if (trendNoteEl?.dataset?.defaultText) {
      trendNoteEl.textContent = trendNoteEl.dataset.defaultText;
    }
    return;
  }
  if (trendStatusEl) trendStatusEl.textContent = '—';
  if (trendNoteEl) trendNoteEl.textContent = message;
}


function sliderUiFromOffset(rangeEl, offset) {
  const min = Number(rangeEl?.min || 0);
  const max = Number(rangeEl?.max || 0);
  return clampInt(Number(offset || 0), min, max);
}

function sliderOffsetFromUi(rangeEl) {
  const min = Number(rangeEl?.min || 0);
  const max = Number(rangeEl?.max || 0);
  return clampInt(Number(rangeEl?.value || 0), min, max);
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
  const cur = monthToInt(getDateValue());
  const clamped = clampInt(cur, globalMinInt, globalMaxInt);
  setDateValue(intToMonth(clamped));

  if (globalMinLabelEl) globalMinLabelEl.textContent = toLatinDigits(String(minMonth).replace(/-/g, '/'));
  if (globalMaxLabelEl) globalMaxLabelEl.textContent = toLatinDigits(String(maxMonth).replace(/-/g, '/'));

  if (globalSliderEl) {
    globalSliderEl.min = 0;
    globalSliderEl.max = Math.max(0, globalMaxInt - globalMinInt);
    globalSliderEl.value = String(sliderUiFromOffset(globalSliderEl, monthToInt(getDateValue()) - globalMinInt));
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
  rangeEl.style.setProperty('--fill', `${pct}%`);
  rangeEl.style.setProperty('--fill-dir', 'to right');
}

function syncGlobalSliderFromInput() {
  if (!globalSliderEl || globalMinMonth == null || globalMaxMonth == null) return;
  globalSliderEl.value = String(sliderUiFromOffset(globalSliderEl, monthToInt(getDateValue()) - globalMinInt));
  paintRange(globalSliderEl);
}

function syncGlobalInputFromSlider() {
  if (!globalSliderEl || globalMinMonth == null || globalMaxMonth == null) return;
  const offset = sliderOffsetFromUi(globalSliderEl);
  const m = intToMonth(globalMinInt + offset);
  setDateValue(m);
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

function getInitialChartZoom(parsedData, years = 5) {
  if (!Array.isArray(parsedData) || parsedData.length < 2) return null;

  const firstValue = parsedData[0]?.[0];
  const lastValue = parsedData[parsedData.length - 1]?.[0];
  if (!firstValue || !lastValue) return null;

  const fallbackWindow = Math.max(years * 12, 1);
  const fallbackStartIndex = Math.max(parsedData.length - fallbackWindow, 0);
  const fallbackNeedsZoom = parsedData.length > fallbackWindow;

  const firstDate = new Date(firstValue);
  const lastDate = new Date(lastValue);
  const hasValidDates = !Number.isNaN(firstDate.getTime()) && !Number.isNaN(lastDate.getTime());

  if (!hasValidDates) {
    if (!fallbackNeedsZoom) return null;
    return {
      startValue: parsedData[fallbackStartIndex]?.[0] ?? firstValue,
      endValue: lastValue
    };
  }

  const startThreshold = new Date(lastDate);
  startThreshold.setUTCFullYear(lastDate.getUTCFullYear() - years);
  const needsZoom = firstDate < startThreshold;
  if (!needsZoom) return null;

  return {
    startValue: getStartValueForLastYears(parsedData, years) || firstValue,
    endValue: lastValue
  };
}

function renderChart(ts, indexLabel, mapMonth, panelMonth) {
  const droughtMode = isDroughtIndex(indexLabel);
  const barClimateMode = !droughtMode && isBarClimateIndex(indexLabel);
  const selectedId = getFeatureId(selectedFeature) || 'unknown';
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
  const nonDroughtLineMode = !droughtMode && !barClimateMode;
  const positiveAreaData = nonDroughtLineMode
    ? parsedData.map((point) => [point[0], point[1] != null && point[1] > 0 ? point[1] : null])
    : [];
  const negativeAreaData = nonDroughtLineMode
    ? parsedData.map((point) => [point[0], point[1] != null && point[1] < 0 ? point[1] : null])
    : [];

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
    ...(droughtMode ? DROUGHT_THRESHOLD_LINES.map((line) => ({ ...line })) : []),
    { xAxis: selectedDate, name: 'Map' },
    { xAxis: panelDate, name: 'Panel' }
  ];

  const initialZoom = chartZoomLast5Years ? getInitialChartZoom(parsedData, 5) : null;
  // No separate timeline series; we use vertical markLines for both dates.


  const option = {
    animation: true,
    animationDuration: 0,
    animationDurationUpdate: 0,
    textStyle: { fontFamily: 'Segoe UI, Roboto, Arial, sans-serif' },
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
          .filter((item) => !(String(item?.seriesName || '').startsWith('__')) && !['Trend'].includes(item?.seriesName))
          .map((item) => {
            const value = Array.isArray(item.value) ? item.value[1] : item.value;
            return `${item.marker}${item.seriesName}: ${formatNumber(value)}`;
          });

        const primary = entries.find((e) => e?.seriesName === formatIndexLabel(indexLabel)) || entries[0];
        const primaryVal = Array.isArray(primary?.value) ? Number(primary.value[1]) : Number(primary?.value);
        const sev = (droughtMode && Number.isFinite(primaryVal)) ? classify(primaryVal) : null;
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
      min: droughtMode ? -3 : 'dataMin',
      max: droughtMode ? 2 : 'dataMax',
      axisLabel: {
        color: '#6b7280',
        formatter: (value) => toLatinDigits(value)
      },
      splitLine: {
        show: true,
        lineStyle: { color: '#e5e7eb' }
      }
    },
    dataZoom: [
      {
        type: 'inside',
        xAxisIndex: 0,
        filterMode: 'none',
        ...(initialZoom || {}),
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
        ...(initialZoom || {}),
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
      ...(nonDroughtLineMode ? [
        {
          name: '__positive_fill',
          type: 'line',
          data: positiveAreaData,
          symbol: 'none',
          lineStyle: { opacity: 0, width: 0 },
          itemStyle: { opacity: 0 },
          showSymbol: false,
          silent: true,
          tooltip: { show: false },
          areaStyle: { color: 'rgba(37, 99, 235, 0.22)' },
          animation: false
        },
        {
          name: '__negative_fill',
          type: 'line',
          data: negativeAreaData,
          symbol: 'none',
          lineStyle: { opacity: 0, width: 0 },
          itemStyle: { opacity: 0 },
          showSymbol: false,
          silent: true,
          tooltip: { show: false },
          areaStyle: { color: 'rgba(239, 68, 68, 0.22)' },
          animation: false
        }
      ] : []),
      {
        name: formatIndexLabel(indexLabel),
        type: barClimateMode ? 'bar' : 'line',
        data: parsedData,
        symbol: barClimateMode ? undefined : 'none',
        lineStyle: barClimateMode ? undefined : { width: 2, color: nonDroughtLineMode ? '#6b7280' : undefined },
        itemStyle: barClimateMode ? { color: '#2563eb' } : (nonDroughtLineMode ? { color: '#6b7280' } : undefined),
        areaStyle: (droughtMode || barClimateMode) ? (droughtMode ? { origin: 0, opacity: 0.7 } : undefined) : { opacity: 0.28 },
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
  if (nonDroughtLineMode) {
    option.legend.data = [formatIndexLabel(indexLabel), 'Trend'];
  }
  if (droughtMode) {
    option.yAxis.interval = 1;
    option.visualMap = {
      type: 'piecewise',
      show: false,
      dimension: 1,
      seriesIndex: 0,
      pieces: [
        { min: 0, color: droughtColors['Normal/Wet'] },
        { min: -0.5, max: 0, color: '#c7eed8' },
        { min: -0.8, max: -0.5, color: droughtColors['D0'] },
        { min: -1.3, max: -0.8, color: droughtColors['D1'] },
        { min: -1.6, max: -1.3, color: droughtColors['D2'] },
        { min: -2.0, max: -1.6, color: droughtColors['D3'] },
        { max: -2.0, color: droughtColors['D4'] }
      ]
    };
  }

  currentRangeStart = parsedData.length ? formatChartDate(parsedData[0][0]) : null;
  currentRangeEnd = parsedData.length ? formatChartDate(parsedData[parsedData.length - 1][0]) : null;
  chart.setOption(option, true);
  if (initialZoom?.startValue && initialZoom?.endValue) {
    chart.dispatchAction({
      type: 'dataZoom',
      batch: [
        { dataZoomIndex: 0, startValue: initialZoom.startValue, endValue: initialZoom.endValue },
        { dataZoomIndex: 1, startValue: initialZoom.startValue, endValue: initialZoom.endValue }
      ]
    });
  }
  lastChartRenderKey = derivedKey;
}

function formatIndexLabel(value) {
  const raw = String(value || '');
  const m = raw.match(/^(spi|spei|ssi)(\d+)$/i);
  if (m) return `${m[1].toUpperCase()}-${m[2]}`;
  if (/^tmin$/i.test(raw)) return 'Tmin';
  if (/^tmax$/i.test(raw)) return 'Tmax';
  if (/^tmean$/i.test(raw)) return 'Tmean';
  if (/^precip$/i.test(raw)) return 'Precip';
  return raw.toUpperCase();
}

function updateSubtitles() {
  const levelLabel = (datasetTitles.get(levelEl.value) || levelLabels[levelEl.value] || levelEl.value);
  const dateLabel = toLatinDigits(String(getDateValue()).replace(/-/g, '/'));
  const idxLabel = formatIndexLabel(indexEl.value);
  const text = `${idxLabel} • ${dateLabel} • Level: ${levelLabel}`;
  if (mapSubtitleEl) mapSubtitleEl.textContent = text;
  if (overviewSubtitleEl) overviewSubtitleEl.textContent = text;
  renderMapLegend(indexEl.value);
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
  if (payload?.mode === 'climate') {
    const withValue = Number(payload?.with_value || 0);
    const missing = Number(payload?.missing || 0);
    const mean = formatNumber(payload?.mean);
    const min = formatNumber(payload?.min);
    const max = formatNumber(payload?.max);
    chartInstance.setOption({
      animation: false,
      xAxis: { type: 'category', data: ['Min', 'Mean', 'Max'] },
      yAxis: { type: 'value' },
      tooltip: { trigger: 'axis' },
      series: [{
        type: 'bar',
        data: [payload?.min, payload?.mean, payload?.max],
        itemStyle: { color: '#2563eb' },
      }],
      legend: { show: false },
      grid: { left: '10%', right: '6%', top: '10%', bottom: '16%' }
    }, true);
    if (overviewStatsEl) {
      overviewStatsEl.innerHTML = `
        <div class="text-muted small mb-2">With data: ${withValue} • Missing: ${missing}</div>
        <div class="stat-row"><div class="stat-left"><span>Min</span></div><div>${min}</div></div>
        <div class="stat-row"><div class="stat-left"><span>Mean</span></div><div>${mean}</div></div>
        <div class="stat-row"><div class="stat-left"><span>Max</span></div><div>${max}</div></div>
      `;
    }
    return;
  }

  const order = ['Normal/Wet', 'D0', 'D1', 'D2', 'D3', 'D4'];
  const labelsFa = {
    'Normal/Wet': 'Normal/Wet',
    'D0': 'Abnormally Dry',
    'D1': 'Moderate Drought',
    'D2': 'Severe Drought',
    'D3': 'Extreme Drought',
    'D4': 'Exceptional Drought'
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
        return `${p.marker}${p.name}<br/>Count: ${p.value}<br/>Percent: ${percent.toFixed(1)}%`;
      }
    },
    legend: {
      bottom: 0,
      left: 'center',
      itemWidth: 12,
      itemHeight: 12,
      textStyle: { color: '#475467', fontFamily: 'Segoe UI, Roboto, Arial, sans-serif' }
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
      ? (`<div class="text-muted small mb-2">Stations with data: ${payload?.with_value ?? total} • Missing: ${missing}</div>` +
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
            <div>${c} --- ${pct.toFixed(1)}%</div>
          </div>
        `;
      }).join(''))
      : '<div class="text-muted small">No data available for this selection.</div>';
  }
}

function buildMapLegendHtml(indexName) {
  const droughtMode = isDroughtIndex(indexName);
  const items = droughtMode ? [
        ['NW', 'Normal/Wet', '#86efac'],
        ['D0', 'Abnormally Dry', '#fde047'],
        ['D1', 'Moderate Drought', '#fbbf24'],
        ['D2', 'Severe Drought', '#f97316'],
        ['D3', 'Extreme Drought', '#dc2626'],
        ['D4', 'Exceptional Drought', '#7f1d1d'],
        ['—', 'No data', '#e5e7eb']
      ] : [
        ['+', 'Positive values', '#2563eb'],
        ['0', 'Zero', '#9ca3af'],
        ['−', 'Negative values', '#dc2626'],
        ['—', 'No data', '#e5e7eb']
      ];
  const title = droughtMode ? 'Drought severity guide' : 'Value sign guide';
  const trendPos = droughtMode ? 'Increasing trend (wetter)' : 'Increasing trend';
  const trendNeg = droughtMode ? 'Decreasing trend (drier)' : 'Decreasing trend';
  const trendNeutral = droughtMode ? '' : '<div class="row-item"><span class="trend-ic trend-neu">—</span><span class="label">No significant trend</span></div>';

  return `
      <div class="head">
        <h6 id="legendTitle">${title}</h6>
        <button id="legendToggle" class="toggle" type="button" aria-label="Show legend">▸</button>
      </div>
      <div class="legend-body" id="legendBody">
        ${items.map(i => `<div class="row-item"><span class="sw" style="background:${i[2]}"></span><span class="short">${i[0]}</span><span class="label">${i[1]}</span></div>`).join('')}
        <div class="row-item"><span class="trend-ic trend-pos">↑</span><span id="legendTrendInc" class="label">${trendPos}</span></div>
        <div class="row-item"><span class="trend-ic trend-neg">↓</span><span id="legendTrendDec" class="label">${trendNeg}</span></div>
        ${trendNeutral}
      </div>`;
}

function renderMapLegend(indexName) {
  const legendBox = document.getElementById('mapLegendBox');
  if (!legendBox) return;
  const collapsed = legendBox.classList.contains('collapsed');
  legendBox.innerHTML = buildMapLegendHtml(indexName);
  legendBox.classList.toggle('collapsed', collapsed);
  const toggle = document.getElementById('legendToggle');
  if (toggle) {
    toggle.textContent = collapsed ? '▸' : '▾';
    toggle.setAttribute('aria-label', collapsed ? 'Show legend' : 'Collapse legend');
    toggle.onclick = () => {
      legendBox.classList.toggle('collapsed');
      const isCollapsed = legendBox.classList.contains('collapsed');
      toggle.textContent = isCollapsed ? '▸' : '▾';
      toggle.setAttribute('aria-label', isCollapsed ? 'Show legend' : 'Collapse legend');
    };
  }
}

function addMapLegend() {
  // Legend: top-left, collapsed by default.
  const legend = L.control({ position: 'topleft' });
  legend.onAdd = () => {
    const div = L.DomUtil.create('div', 'map-legend collapsed');
    div.id = 'mapLegendBox';
    div.innerHTML = buildMapLegendHtml(indexEl.value);

    // Prevent map interactions while using the legend.
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.disableScrollPropagation(div);
    return div;
  };
  legend.addTo(map);
}

function setHoverInfo(feature, indexName) {
  if (!hoverBoxEl || !hoverNameEl) return;
  if (!feature) {
    hoverBoxEl.classList.add('is-hidden');
    hoverBoxEl.setAttribute('aria-hidden', 'true');
    return;
  }
  const name = getFeatureDisplayName(feature);
  const sev = feature?.properties?.severity || '—';
  const hasValue = feature?.properties?.has_value !== false && feature?.properties?.value != null;
  const value = hasValue ? formatNumber(feature?.properties?.value) : '—';
  const t = trendLabelForIndex(indexName, feature?.properties?.trend);
  hoverNameEl.textContent = name;
  const droughtMode = isDroughtIndex(indexName);
  const sevText = droughtMode
    ? ((sev === 'No Data' || !hasValue) ? 'No data' : (severityLong[sev] || sev))
    : '—';
  
  hoverIndexEl.textContent = `${formatIndexLabel(indexName)}`;
  hoverValueEl.textContent = value;
  hoverSeverityEl.textContent = hasValue ? sevText : '—';
  hoverTrendEl.textContent = hasValue ? `${t.symbol} ${t.labelEn}` : '—';
  
  hoverBoxEl.classList.remove('is-hidden');
  hoverBoxEl.setAttribute('aria-hidden', 'false');
}

function computeClimateValueRange(features) {
  const vals = (features || [])
    .map((f) => Number(f?.properties?.value))
    .filter((v) => Number.isFinite(v));
  if (!vals.length) return null;
  return { min: Math.min(...vals), max: Math.max(...vals) };
}

function computeMagnitudeValueRange(features) {
  const vals = (features || [])
    .map((f) => Math.abs(Number(f?.properties?.value)))
    .filter((v) => Number.isFinite(v));
  if (!vals.length) return null;
  return { min: Math.min(...vals), max: Math.max(...vals) };
}

function climatePointRadius(value, range) {
  if (!Number.isFinite(value) || !range) return 6;
  const span = range.max - range.min;
  if (!Number.isFinite(span) || span <= 0) return 8;
  const t = Math.max(0, Math.min(1, (value - range.min) / span));
  return 4 + (t * 10);
}

function buildPolygonLayer(features, index) {
  const defaultPolyStyle = (f) => {
    const selected = isSelectedFeature(f);
    const searched = searchQuery && featureMatchesSearch(f);
    const hasValue = f?.properties?.has_value !== false;
    const baseColor = hasValue ? mapValueColor(f?.properties?.value, index) : '#94a3b8';
    return {
      color: selected ? '#1d4ed8' : (searched ? '#0f766e' : baseColor),
      weight: selected ? 3 : (searched ? 2.2 : 1),
      opacity: selected ? 1 : (hasValue ? 1 : 0.35),
      fillOpacity: selected ? 0.88 : (searched ? 0.9 : (hasValue ? 0.78 : 0.12)),
      fillColor: selected ? '#dbeafe' : (searched ? '#ccfbf1' : (hasValue ? baseColor : '#e5e7eb'))
    };
  };

  const hoverPolyStyle = {
    color: '#0f172a',
    weight: 2,
    fillOpacity: 0.9
  };

  return L.geoJSON({ type: 'FeatureCollection', features }, {
    style: defaultPolyStyle,
    onEachFeature: (feature, layer) => {
      if (!isTouchLikeDevice()) {
        layer.on('mouseover', () => {
          if (searchQuery && !featureMatchesSearch(feature)) return;
          if (layer.setStyle) layer.setStyle(hoverPolyStyle);
          if (layer.bringToFront) layer.bringToFront();
          setHoverInfo(feature, index);
        });

        layer.on('mouseout', () => {
          if (searchQuery && !featureMatchesSearch(feature)) return;
          if (layer.setStyle) layer.setStyle(defaultPolyStyle(feature));
          setHoverInfo(null);
        });
      }

      layer.on('click', () => {
        if (searchQuery && !featureMatchesSearch(feature)) return;
        onRegionClick(feature);
      });

      if (isSelectedFeature(feature) && layer.bringToFront) {
        layer.bringToFront();
      }
    }
  });
}

function buildPointLayer(features, index) {
  if (showAllStationMarkers) {
    const group = L.layerGroup();
    for (const feature of features) {
      const marker = buildPointMarker(feature, index);
      if (marker) group.addLayer(marker);
    }
    return group;
  }

  const cellSize = map.getZoom() >= 11 ? 26 : map.getZoom() >= 9 ? 34 : map.getZoom() >= 7 ? 44 : 56;
  const buckets = new Map();
  const visibleBounds = map.getBounds();

  for (const feature of features) {
    const coords = feature?.geometry?.coordinates || [];
    if (coords.length < 2) continue;
    const latlng = L.latLng(Number(coords[1]), Number(coords[0]));
    if (!visibleBounds.contains(latlng)) continue;
    const projected = map.project(latlng, map.getZoom());
    const key = `${Math.floor(projected.x / cellSize)}:${Math.floor(projected.y / cellSize)}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { features: [], latSum: 0, lngSum: 0, bounds: null };
      buckets.set(key, bucket);
    }
    bucket.features.push(feature);
    bucket.latSum += latlng.lat;
    bucket.lngSum += latlng.lng;
    bucket.bounds = bucket.bounds ? bucket.bounds.extend(latlng) : L.latLngBounds(latlng, latlng);
  }

  const group = L.layerGroup();
  buckets.forEach((bucket) => {
    if (!bucket.features.length) return;
    if (bucket.features.length === 1) {
      const marker = buildPointMarker(bucket.features[0], index);
      if (marker) group.addLayer(marker);
      return;
    }

    const latlng = L.latLng(bucket.latSum / bucket.features.length, bucket.lngSum / bucket.features.length);
    const bucketValues = bucket.features
      .map((feature) => Number(feature?.properties?.value))
      .filter((value) => Number.isFinite(value));
    const clusterValue = bucketValues.length ? (bucketValues.reduce((sum, value) => sum + value, 0) / bucketValues.length) : null;
    const clusterMarker = L.marker(
      latlng,
      {
        icon: isDroughtIndex(index) ? clusterIcon(bucket.features.length) : clusterSignIcon(bucket.features.length, clusterValue),
        keyboard: false,
        riseOnHover: true
      }
    );
    clusterMarker.on('click', () => {
      const pad = Math.max(0.15, 0.5 - (bucket.features.length * 0.01));
      const maxZoom = Math.min((map.getMaxZoom?.() ?? 18), map.getZoom() + 2);
      map.fitBounds(bucket.bounds.pad(pad), { maxZoom });
    });
    clusterMarker.bindTooltip(`${bucket.features.length} stations`, { direction: 'top', sticky: true });
    group.addLayer(clusterMarker);
  });

  return group;
}

function syncMarkerModeToggle(points = []) {
  if (!markerModeToggleEl) return;
  const hasPoints = (levelEl?.value || '').toLowerCase() === 'station' || points.length > 0;
  markerModeToggleEl.disabled = !hasPoints;
  markerModeToggleEl.checked = showAllStationMarkers;
  markerModeToggleEl.title = hasPoints ? 'Toggle between clustered and individual station markers' : 'This layer has no station markers';
}

function renderCurrentMapFeatures() {
  if (!geoLayer) {
    geoLayer = L.layerGroup().addTo(map);
  }
  geoLayer.clearLayers();
  setHoverInfo(null);

  const features = (currentMapFeatures || []).filter(featureMatchesSearch);
  const polygons = features.filter((feature) => !isPointFeature(feature));
  const points = features.filter((feature) => isPointFeature(feature));
  syncMarkerModeToggle(points);

  if (polygons.length) {
    geoLayer.addLayer(buildPolygonLayer(polygons, currentMapIndex));
  }

  if (points.length) {
    geoLayer.addLayer(buildPointLayer(points, currentMapIndex));
  }

  syncSelectedFeatureOverlay();
  const searchInput = document.getElementById('search');
  if (searchInput && document.activeElement === searchInput) {
    renderSearchSuggestions(searchQuery, activeSearchSuggestionIndex >= 0 ? activeSearchSuggestionIndex : 0);
  } else {
    hideSearchSuggestions();
  }
}

function applySearchFilter() {
  renderCurrentMapFeatures();
}

function clearSelectedFeatureState() {
  selectedFeature = null;
  currentPanelSeries = [];
  currentPanelFeatureName = null;
  stationMinInt = null;
  stationMaxInt = null;
  stationMonthInt = null;
  if (stationSliderEl) stationSliderEl.disabled = true;
  if (stationRangeLabelEl) stationRangeLabelEl.textContent = '—';
  if (stationMonthLabelEl) {
    stationMonthLabelEl.textContent = '—';
    delete stationMonthLabelEl.dataset.month;
  }
  setHoverInfo(null);
  syncSelectedFeatureOverlay();
}

async function updatePanelForMonth(newMonth) {
  if (!selectedFeature || stationMinInt == null || stationMaxInt == null) return;
  const monthInt = clampInt(monthToInt(newMonth), stationMinInt, stationMaxInt);
  stationMonthInt = monthInt;
  const monthStr = intToMonth(monthInt);

  if (stationSliderEl) stationSliderEl.value = String(sliderUiFromOffset(stationSliderEl, stationMonthInt - stationMinInt));
  paintRange(stationSliderEl);
  if (stationMonthLabelEl) { stationMonthLabelEl.textContent = `Selected month: ${monthStr.replace(/-/g, '/')}`; stationMonthLabelEl.dataset.month = monthStr; }

  const regionId = getFeatureId(selectedFeature);
  const indexName = indexEl.value;
  const levelName = levelEl.value;
  const featureName = getFeatureDisplayName(selectedFeature) || currentPanelFeatureName || 'Region';

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
    if (stationMonthLabelEl) { stationMonthLabelEl.textContent = `Selected month: ${effective.replace(/-/g, '/')}`; stationMonthLabelEl.dataset.month = effective; }
  }

  renderKPI(kpi, featureName, indexName, effective);
  renderChart(currentPanelSeries, indexName, getDateValue(), effective);
  togglePanelSpinner(false);
}

async function loadMap(options = {}) {
  const autoSelectRequested = options.autoSelect !== false;
  const autoSelect = autoSelectRequested && !suppressNextMapAutoSelect;
  if (autoSelectRequested) suppressNextMapAutoSelect = false;
  if (!appIsReady) return;
  const level = levelEl.value;
  const index = indexEl.value;
  const date = getDateValue();
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
  } catch (err) {
    if (String(err?.name) !== 'AbortError') {
      mapSubtitleEl.textContent = `Map loading error: ${err.message || 'Unknown error'}`;
    }
  }

  if (reqId !== mapRequestSeq) { toggleMapLoading(false); return; }

  toggleMapLoading(false);
  latestMapFeatures = data.features || [];
  currentMapFeatures = latestMapFeatures.slice();
  currentMapIndex = index;
  currentMapClimateRange = isDroughtIndex(index) ? null : computeMagnitudeValueRange(currentMapFeatures);
  if (!geoLayer) geoLayer = L.layerGroup().addTo(map);
  renderCurrentMapFeatures();

  // Initial default selection: choose one feature on first page load.
  if (autoSelect && !selectedFeature && latestMapFeatures.length) {
    const defaultFeature = latestMapFeatures.find((f) => f?.properties?.has_value !== false) || latestMapFeatures[0];
    if (defaultFeature) {
      await onRegionClick(defaultFeature);
    }
  }

  // Do NOT auto-fit on each load. With bbox-driven loading this would trigger
  // endless move events and repeated requests.
}

// Overview chart is computed server-side (no need to download all stations).
async function loadOverview() {
  if (!appIsReady) return;
  const level = levelEl.value;
  const idx = indexEl.value;
  const date = getDateValue();
  const key = `${level}|${idx}|${date}`;
  const reqId = ++overviewRequestSeq;
  if (overviewAbortController) overviewAbortController.abort();
  overviewAbortController = new AbortController();
  try {
    const payload = await fetchCached(
      overviewCache,
      key,
      () => `${API_BASE}/overview?level=${level}&index=${idx}&date=${date}`,
      { signal: overviewAbortController.signal }
    );
    if (reqId !== overviewRequestSeq) return;
    renderOverviewFromCounts(payload);
  } catch (err) {
    if (String(err?.name) === 'AbortError') return;
    // The map can still function even if overview fails.
    updateOverviewSubtitle(`Overview loading error: ${err.message || 'Unknown error'}`);
  }
}

async function onRegionClick(feature) {
  try {
    selectedFeature = feature;
    syncSelectedFeatureOverlay();
    const regionId = getFeatureId(feature);
    const indexName = indexEl.value;
    const levelName = levelEl.value;
    const featureName = getFeatureDisplayName(feature);
    currentPanelFeatureName = featureName;
    setPanelOpen(true);

    // Load time series first (we need per-feature min/max to configure panel slider).
    togglePanelSpinner(true);
    setNoDataMessage(false);
    setTimelineDisabled(false);

    const reqId = ++panelRequestSeq;
    if (panelAbortController) panelAbortController.abort();
    panelAbortController = new AbortController();

    renderPanelLoading(featureName, stationMonthInt != null ? intToMonth(stationMonthInt) : getDateValue());

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
      if (stationMonthLabelEl) { stationMonthLabelEl.textContent = '—'; delete stationMonthLabelEl.dataset.month; }
      renderKPI({
        latest: NaN,
        min: NaN,
        max: NaN,
        mean: NaN,
        severity: 'N/A',
        trend: { tau: NaN, p_value: '-', sen_slope: NaN, trend: '—' }
      }, featureName, indexName, null);
      setNoDataMessage(true, 'No data for this selection');
      renderChart([], indexName, getDateValue(), getDateValue());
      togglePanelSpinner(false);
      return;
    }

    // Configure panel (feature) slider to the FULL available range.
    stationMinInt = monthToInt(minM);
    stationMaxInt = monthToInt(maxM);
    const base = (stationMonthInt != null) ? stationMonthInt : monthToInt(getDateValue());
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
    if (stationMonthLabelEl) { stationMonthLabelEl.textContent = `Selected month: ${panelMonth.replace(/-/g, '/')}`; stationMonthLabelEl.dataset.month = panelMonth; }

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
        if (stationMonthLabelEl) { stationMonthLabelEl.textContent = `Selected month: ${effectiveMonth.replace(/-/g, '/')}`; stationMonthLabelEl.dataset.month = effectiveMonth; }
      }
    }

    renderKPI(kpi, featureName, indexName, effectiveMonth);
    renderChart(series, indexName, getDateValue(), effectiveMonth);
    togglePanelSpinner(false);
  } catch (err) {
    console.error('onRegionClick error:', err);
    togglePanelSpinner(false);
    setPanelOpen(true);
  }
}

function findSelectedFeatureFromCurrentMap() {
  if (!selectedFeature || !latestMapFeatures.length) return selectedFeature;
  const selectedId = getFeatureId(selectedFeature);
  return latestMapFeatures.find((f) => getFeatureId(f) === selectedId) || selectedFeature;
}

async function onDateChanged() {
  syncGlobalSliderFromInput();
  updateSubtitles();
  await Promise.all([loadMap(), loadOverview()]);

  // Do NOT refetch the panel on global date changes.
  // The panel has its own stationMonth (slider) and only needs the chart marker updated.
  if (panelEl.classList.contains('open') && selectedFeature && currentPanelSeries.length) {
    const panelMonth = stationMonthInt != null ? intToMonth(stationMonthInt) : getDateValue();
    renderChart(currentPanelSeries, indexEl.value, getDateValue(), panelMonth);
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
  const trendNoteEl = document.getElementById('trendNote');
  if (trendNoteEl && !trendNoteEl.dataset.defaultText) {
    trendNoteEl.dataset.defaultText = trendNoteEl.textContent || '—';
  }

  if (chartZoomToggleEl) {
    chartZoomToggleEl.checked = false;
    chartZoomLast5Years = false;
    chartZoomToggleEl.addEventListener('change', () => {
      chartZoomLast5Years = chartZoomToggleEl.checked;
      if (panelEl.classList.contains('open') && selectedFeature && currentPanelSeries.length) {
        const panelMonth = stationMonthInt != null ? intToMonth(stationMonthInt) : getDateValue();
        renderChart(currentPanelSeries, indexEl.value, getDateValue(), panelMonth);
      }
    });
  }

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
    mapDataCache.clear();
    panelKpiCache.clear();
    timeseriesCache.clear();
    overviewCache.clear();
    await loadMetaForSelectedDataset();
    await onDateChanged();
  });

  dateEl.addEventListener('input', () => {
    const normalized = toLatinDigits(dateEl.value).replace(/[^\d-]/g, '').slice(0, 7);
    if (dateEl.value !== normalized) dateEl.value = normalized;
  });

  dateEl.addEventListener('change', () => {
    const normalized = normalizeMonthInput(dateEl.value);
    if (!normalized) {
      setDateValue(globalMaxMonth || globalMinMonth || '2020-01');
    } else {
      setDateValue(normalized);
    }
    if (globalMinMonth && globalMaxMonth) {
      const clamped = clampInt(monthToInt(getDateValue()), globalMinInt, globalMaxInt);
      setDateValue(intToMonth(clamped));
    }
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
    if (globalMinMonth && getDateValue() <= globalMinMonth) return;
    lastPanelQueryKey = null;
    setDateValue(addMonth(getDateValue(), -1));
    syncGlobalSliderFromInput();
    debouncedDateChanged();
  });
  document.getElementById('nextMonth').addEventListener('click', () => {
    if (globalMaxMonth && getDateValue() >= globalMaxMonth) return;
    lastPanelQueryKey = null;
    setDateValue(addMonth(getDateValue(), 1));
    syncGlobalSliderFromInput();
    debouncedDateChanged();
  });
  document.getElementById('toStart').addEventListener('click', () => {
    if (!globalMinMonth) return;
    lastPanelQueryKey = null;
    setDateValue(globalMinMonth);
    syncGlobalSliderFromInput();
    debouncedDateChanged();
  });
  document.getElementById('toEnd').addEventListener('click', () => {
    if (!globalMaxMonth) return;
    lastPanelQueryKey = null;
    setDateValue(globalMaxMonth);
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
      const target = clampInt(monthToInt(getDateValue()), stationMinInt, stationMaxInt);
      updatePanelForMonth(intToMonth(target));
    });
  }

  if (syncToPanelBtn) {
    syncToPanelBtn.addEventListener('click', () => {
      const panelMonth = stationMonthLabelEl?.dataset?.month;
      if (!panelMonth) return;
      setDateValue(panelMonth);
      lastPanelQueryKey = null;
      syncGlobalSliderFromInput();
      debouncedDateChanged();
    });
  }

  if (closeBtn) closeBtn.addEventListener('click', () => { lastPanelQueryKey = null; setPanelOpen(false); });

  if (panelEl) panelEl.addEventListener('click', (e) => e.stopPropagation());

  // Mobile drawers
  if (toggleSidebarBtn) {
    toggleSidebarBtn.addEventListener('click', () => {
      setSidebarOpen(!state.sidebarOpen);
      setPanelOpen(false);
      if (isMobileViewport()) setMobileSection(state.sidebarOpen ? 'filters' : 'map');
      invalidateMapSoon();
    });
  }
  if (togglePanelBtn) {
    togglePanelBtn.addEventListener('click', () => {
      setPanelOpen(!state.panelOpen);
      setSidebarOpen(false);
      if (isMobileViewport()) setMobileSection(state.panelOpen ? 'analysis' : 'map');
      invalidateMapSoon();
    });
  }

  if (closeSidebarBtn) {
    closeSidebarBtn.addEventListener('click', () => {
      lastPanelQueryKey = null;
      setSidebarOpen(false);
      setMobileSection('map');
      invalidateMapSoon();
    });
  }

  if (mobileMapTabBtn) {
    mobileMapTabBtn.addEventListener('click', () => {
      lastPanelQueryKey = null;
      setSidebarOpen(false);
      setPanelOpen(false);
      setMobileSection('map');
      invalidateMapSoon();
    });
  }

  if (mobileFiltersTabBtn) {
    mobileFiltersTabBtn.addEventListener('click', () => {
      setPanelOpen(false);
      setSidebarOpen(true);
      setMobileSection('filters');
      invalidateMapSoon();
    });
  }

  if (mobileAnalysisTabBtn) {
    mobileAnalysisTabBtn.addEventListener('click', async () => {
      document.activeElement?.blur?.();
      setSidebarOpen(false);
      setPanelOpen(true);
      setMobileSection('analysis');
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
      lastPanelQueryKey = null;
      await onDateChanged();
      if (selectedFeature) {
        const feature = findSelectedFeatureFromCurrentMap() || selectedFeature;
        if (feature) {
          await onRegionClick(feature);
        }
      }
      invalidateMapSoon();
    });
  }

  // Backdrop click closes drawers / modal
  if (modalBackdropEl) {
    modalBackdropEl.addEventListener('click', () => {
      setSidebarOpen(false);
      setPanelOpen(false);
      setMobileSection('map');
      closeActiveModal();
      invalidateMapSoon();
    });
  }

  // Modal
  if (aboutOpenBtn) aboutOpenBtn.addEventListener('click', () => setAboutModalOpen(true));
  if (aboutCloseBtn) aboutCloseBtn.addEventListener('click', () => setAboutModalOpen(false));
  if (aboutOkBtn) aboutOkBtn.addEventListener('click', () => setAboutModalOpen(false));
  if (contactOpenBtn) contactOpenBtn.addEventListener('click', () => setContactModalOpen(true));
  if (contactCloseBtn) contactCloseBtn.addEventListener('click', () => setContactModalOpen(false));
  if (contactOkBtn) contactOkBtn.addEventListener('click', () => setContactModalOpen(false));
  if (startupNoticeCloseBtn) startupNoticeCloseBtn.addEventListener('click', () => setStartupNoticeOpen(false));
  if (startupNoticeOkBtn) startupNoticeOkBtn.addEventListener('click', () => setStartupNoticeOpen(false));

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (state.modalOpen) { closeActiveModal(); return; }
    if (isMobileViewport() && state.sidebarOpen) { setSidebarOpen(false); setMobileSection('map'); return; }
    if (isMobileViewport() && state.panelOpen) { lastPanelQueryKey = null; setPanelOpen(false); setMobileSection('map'); return; }
  });

  const searchEl = document.getElementById('search');
  const applySearchFilterDebounced = debounce(applySearchFilter, 120);
  if (searchEl) {
    searchEl.addEventListener('input', (e) => {
      searchQuery = e.target.value.trim();
      renderSearchSuggestions(searchQuery);
      applySearchFilterDebounced();
    });
    searchEl.addEventListener('focus', () => {
      renderSearchSuggestions(searchEl.value, activeSearchSuggestionIndex >= 0 ? activeSearchSuggestionIndex : 0);
    });
    searchEl.addEventListener('keydown', (e) => {
      if (!currentSearchSuggestions.length) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeSearchSuggestionIndex = (activeSearchSuggestionIndex + 1) % currentSearchSuggestions.length;
        renderSearchSuggestions(searchEl.value, activeSearchSuggestionIndex);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeSearchSuggestionIndex = (activeSearchSuggestionIndex - 1 + currentSearchSuggestions.length) % currentSearchSuggestions.length;
        renderSearchSuggestions(searchEl.value, activeSearchSuggestionIndex);
      } else if (e.key === 'Enter') {
        const item = currentSearchSuggestions[activeSearchSuggestionIndex] || currentSearchSuggestions[0];
        if (item) {
          e.preventDefault();
          selectSearchSuggestion(item.feature);
        }
      } else if (e.key === 'Escape') {
        hideSearchSuggestions();
      }
    });
    searchEl.addEventListener('blur', () => {
      const delay = isTouchLikeDevice() ? 300 : 120;
      setTimeout(() => {
        if (document.activeElement === searchEl && isTouchLikeDevice()) return;
        hideSearchSuggestions();
      }, delay);
    });
  }

  if (clearSearchBtn) {
    clearSearchBtn.addEventListener('click', async () => {
      searchQuery = '';
      if (searchEl) searchEl.value = '';
      hideSearchSuggestions();
      showAllStationMarkers = false;
      if (markerModeToggleEl) markerModeToggleEl.checked = false;
      lastPanelQueryKey = null;
      clearSelectedFeatureState();
      setPanelOpen(false);
      suppressNextMapAutoSelect = true;
      setTimeout(() => { suppressNextMapAutoSelect = false; }, 1500);
      map.setView(DEFAULT_VIEW.center, DEFAULT_VIEW.zoom);
      applySearchFilter();
      await loadMap({ autoSelect: false });
      invalidateMapSoon();
    });
  }

  if (markerModeToggleEl) {
    markerModeToggleEl.checked = false;
    markerModeToggleEl.addEventListener('change', () => {
      showAllStationMarkers = markerModeToggleEl.checked;
      renderCurrentMapFeatures();
    });
  }

  const indexHelpBtn = document.getElementById('indexHelpBtn');
  const trendHelpBtn = document.getElementById('trendHelpBtn');
  const indexHelpPanel = document.getElementById('indexHelpPanel');
  const trendHelpPanel = document.getElementById('trendHelpPanel');

  function toggleHelp(panelEl) {
    if (!panelEl) return;
    const shouldOpen = panelEl.classList.contains('d-none');
    [indexHelpPanel, trendHelpPanel].forEach((panel) => {
      if (panel && panel !== panelEl) panel.classList.add('d-none');
    });
    panelEl.classList.toggle('d-none', !shouldOpen);
    if (shouldOpen) panelEl.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
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
    setTimelineButtonLabels();
    if (overviewChart) overviewChart.resize();
    invalidateMapSoon();

    // If we leave mobile, clear drawer states
    if (!isMobileViewport()) {
      state.sidebarOpen = false;
      state.panelOpen = false;
      setMobileSection('map');
      sidebarEl?.classList.remove('open');
      panelEl?.classList.remove('open');
      sidebarEl?.setAttribute('aria-hidden', 'false');
      panelEl?.setAttribute('aria-hidden', 'false');
      updateBackdrop();
    } else {
      // On mobile, keep closed unless explicitly opened
      setSidebarOpen(state.sidebarOpen);
      setPanelOpen(state.panelOpen);
      syncMobileWorkspaceUI();
    }
  });
}

async function initApp() {
  // Provide a fast local fallback if the backend endpoints aren't ready.
  ensureMonthInputValue();
  populateIndexOptions();
  addMapLegend();
  setupEvents();
  setupMapResizeObserver();
  updateHeaderHeightVar();
  setTimelineButtonLabels();
  syncMobileWorkspaceUI();

  try {
    await loadDatasetsList();
    await loadMetaForSelectedDataset();
  } catch (err) {
    // Backend not ready or dataset not imported yet.
    if (mapSubtitleEl) {
      mapSubtitleEl.textContent = 'No imported data found. Please run import_data.py.';
    }
    // Fallback: at least have a "station" option so UI doesn't break.
    if (!levelEl.options.length) {
      levelEl.innerHTML = '<option value="station">Station</option>';
    }
  }

  updateSubtitles();
  appIsReady = true;
  await Promise.all([loadMap()]);
  invalidateMapSoon();
  setTimeout(() => {
    setStartupNoticeOpen(true);
  }, 220);
}

initApp();
