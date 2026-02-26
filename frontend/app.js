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

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 180;
const mapDataCache = new Map();
const panelKpiCache = new Map();
const timeseriesCache = new Map();
const derivedSeriesCache = new Map();

const levelEl = document.getElementById('level');
const indexEl = document.getElementById('index');
const dateEl = document.getElementById('date');
const panelEl = document.getElementById('insightPanel');
const sidebarEl = document.getElementById('sidebar');
const closeBtn = document.getElementById('closePanel');
const monthStripEl = document.getElementById('monthStrip');
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
  document.getElementById('stripPrev'),
  document.getElementById('stripNext')
];

const levelLabels = {
  station: 'ایستگاهی',
  province: 'استانی',
  county: 'شهرستانی',
  level1: 'حوزه درجه یک',
  level2: 'حوزه درجه دو',
  level3: 'حوزه درجه سه'
};

const droughtColors = {
  'D4': '#7f1d1d',
  'D3': '#dc2626',
  'D2': '#f97316',
  'D1': '#fbbf24',
  'D0': '#fde047',
  'Normal/Wet': '#86efac'
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

function toDisplayMonth(yyyymm) { return addMonth(yyyymm, 1); }

function fromDisplayMonth(yyyymm) { return addMonth(yyyymm, -1); }

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
    .filter((d) => d && d.date && Number.isFinite(Number(d.value)))
    .map((d) => ({ date: d.date, value: Number(d.value) }));
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

function buildMonthStrip(centerMonth) {
  monthStripEl.innerHTML = '';
  const displayCenterMonth = toDisplayMonth(centerMonth);
  const minDate = dateEl.min || null;
  const maxDate = dateEl.max || null;
  for (let i = -18; i <= 18; i += 1) {
    const displayMonth = addMonth(displayCenterMonth, i);
    const sourceMonth = fromDisplayMonth(displayMonth);
    const { month, year } = toMonthLabel(displayMonth);
    const btn = document.createElement('button');
    const outOfRange = (minDate && sourceMonth < minDate) || (maxDate && sourceMonth > maxDate);
    btn.className = `month-chip ${displayMonth === displayCenterMonth ? 'active' : ''}`;
    btn.disabled = outOfRange;
    btn.innerHTML = `${month}${(displayMonth.endsWith('-01') || displayMonth.endsWith('-07')) ? `<span class="year-tag">${toPersianDigits(year)}</span>` : ''}`;
    btn.onclick = () => {
      if (outOfRange) return;
      lastPanelQueryKey = null;
      dateEl.value = sourceMonth;
      debouncedDateChanged();
    };
    monthStripEl.appendChild(btn);
  }
}

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

function renderKPI(kpi, featureName, indexLabel) {
  const sev = kpi.severity || '-';
  document.getElementById('panelTitle').textContent = `${featureName}`;
  document.getElementById('panelSubtitle').textContent = `تاریخ انتخاب شده: ${toPersianDigits(toDisplayMonth(dateEl.value).replace(/-/g, '/'))}`;
  document.getElementById('mainMetricLabel').textContent = `مقدار ${formatIndexLabel(indexLabel)}`;
  document.getElementById('mainMetricValue').textContent = formatNumber(kpi.latest);
  document.getElementById('severityBadge').textContent = severityLong[sev] || sev;
  applySeverityStyle(sev);

  document.getElementById('tauVal').textContent = formatNumber(kpi.trend?.tau);
  document.getElementById('pVal').textContent = formatPValue(kpi.trend?.p_value);
  document.getElementById('senVal').textContent = formatNumber(kpi.trend?.sen_slope);

  // Trend status + note (professional style like reference)
  const pRaw = kpi.trend?.p_value;
  const pNum = (() => {
    if (Number.isFinite(Number(pRaw))) return Number(pRaw);
    const raw = String(pRaw ?? '').trim();
    const match = raw.match(/(-?\d*\.?\d+)/);
    return match ? Number(match[1]) : NaN;
  })();

  const significant = Number.isFinite(pNum) ? (pNum < 0.05) : false;
  const trendStatusEl = document.getElementById('trendStatus');
  if (trendStatusEl) trendStatusEl.textContent = significant ? 'Significant Trend' : 'No Significant Trend';

  const trendNoteEl = document.getElementById('trendNote');
  if (trendNoteEl) {
    if (!Number.isFinite(pNum)) trendNoteEl.textContent = '—';
    else trendNoteEl.textContent = significant ? 'Statistically significant (p < 0.05)' : 'Not statistically significant (p ≥ 0.05)';
  }
}

function renderPanelLoading(featureName = 'ناحیه') {
  document.getElementById('panelTitle').textContent = `${featureName}`;
  document.getElementById('panelSubtitle').textContent = `تاریخ انتخاب شده: ${toPersianDigits(toDisplayMonth(dateEl.value).replace(/-/g, '/'))}`;
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

function applyDateBounds(minDate, maxDate) {
  if (!minDate || !maxDate) {
    dateEl.removeAttribute('min');
    dateEl.removeAttribute('max');
    return false;
  }

  dateEl.min = minDate;
  dateEl.max = maxDate;

  if (dateEl.value < minDate) {
    dateEl.value = minDate;
    return true;
  }
  if (dateEl.value > maxDate) {
    dateEl.value = maxDate;
    return true;
  }
  return false;
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
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  const n = data.length;
  if (n < 2) return [...data];

  for (let i = 0; i < n; i += 1) {
    sumX += i;
    sumY += data[i][1];
    sumXY += i * data[i][1];
    sumXX += i * i;
  }

  const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;
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

function renderChart(ts, indexLabel) {
  const selectedId = String(selectedFeature?.properties?.id || 'unknown');
  const lastPoint = ts.length ? `${ts[ts.length - 1].date}|${ts[ts.length - 1].value}` : 'empty';
  const derivedKey = `${selectedId}|${levelEl.value}|${indexLabel}|${dateEl.value}|${ts.length}|${lastPoint}`;
  let cachedDerived = derivedSeriesCache.get(derivedKey);
  if (!cachedDerived) {
    const parsedData = ts.map((d) => [String(d.date).includes('T') ? d.date : `${d.date}T00:00:00Z`, Number(d.value)]);
    cachedDerived = {
      parsedData,
      trendData: calculateTrendLine(parsedData)
    };
    derivedSeriesCache.set(derivedKey, cachedDerived);
  }

  const { parsedData, trendData } = cachedDerived;
  const selectedDate = toChartMonthStart(toDisplayMonth(dateEl.value));

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
    ...DROUGHT_THRESHOLD_LINES.map((line) => ({ ...line }))
  ];

  const endValue = parsedData[parsedData.length - 1]?.[0];
  // Initial viewport: most recent year
  const startValue = getStartValueForLastYears(parsedData, 1) || parsedData[0]?.[0];
  const timelineSeriesData = endValue
    ? [[selectedDate, -3], [selectedDate, 2]]
    : [];


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
          // Hide helper series from tooltip (Trend + Timeline)
          .filter((item) => !['Timeline', 'Trend'].includes(item?.seriesName))
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
      {
        name: 'Timeline',
        type: 'line',
        data: timelineSeriesData,
        symbol: 'none',
        tooltip: { show: false },
        animation: false,
        lineStyle: { color: '#2563eb', width: 1.8, type: 'dashed' },
        itemStyle: { color: '#2563eb' },
        z: 4
      }
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
  const levelLabel = levelLabels[levelEl.value] || levelEl.value;
  const dateLabel = toPersianDigits(toDisplayMonth(dateEl.value).replace(/-/g, '/'));
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

function renderOverview(features) {
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

  const counts = order.reduce((acc, k) => (acc[k] = 0, acc), {});
  (features || []).forEach((f) => {
    const s = f?.properties?.severity;
    if (counts[s] != null) counts[s] += 1;
  });
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
    overviewStatsEl.innerHTML = total
      ? order.map((k) => {
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
      }).join('')
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
      ['D4', 'خشکسالی استثنایی', '#7f1d1d']
    ];
    div.innerHTML = `
      <div class="head">
        <h6 id="legendTitle">راهنمای شدت خشکسالی</h6>
        <button id="legendToggle" class="toggle" type="button" aria-label="نمایش راهنما">▸</button>
      </div>
      <div class="legend-body">
        ${items.map(i => `<div class="row-item"><span class="sw" style="background:${i[2]}"></span><span class="short">${i[0]}</span><span class="label">${i[1]}</span></div>`).join('')}
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
  const value = feature?.properties?.value == null ? '—' : formatNumber(feature?.properties?.value);
  hoverNameEl.textContent = name;
  hoverMetaEl.textContent = `${formatIndexLabel(indexName)}: ${value} ••• ${severityLong[sev] || sev}`;
  hoverBoxEl.classList.remove('is-hidden');
  hoverBoxEl.setAttribute('aria-hidden', 'false');
}

async function loadMap() {
  const level = levelEl.value;
  const index = indexEl.value;
  const date = dateEl.value;
  const reqId = ++mapRequestSeq;
  if (mapAbortController) mapAbortController.abort();
  mapAbortController = new AbortController();
  toggleMapLoading(true);

  let data = { type: 'FeatureCollection', features: [] };
  try {
    const mapKey = `${level}|${index}|${date}`;
    data = await fetchCached(
      mapDataCache,
      mapKey,
      () => `${API_BASE}/mapdata?level=${level}&index=${index}&date=${date}`,
      { signal: mapAbortController.signal }
    );
    preloadLikelyMapRequests(level, index, date);
  } catch (_) {}

  if (reqId !== mapRequestSeq) { toggleMapLoading(false); return; }

  toggleMapLoading(false);
  latestMapFeatures = data.features || [];
  if (geoLayer) map.removeLayer(geoLayer);

  const defaultPolyStyle = (f) => ({
    color: '#334155',
    weight: 1,
    opacity: 1,
    fillOpacity: 0.78,
    fillColor: severityColor(f?.properties?.severity)
  });

  const hoverPolyStyle = {
    color: '#0f172a',
    weight: 2,
    fillOpacity: 0.9
  };

  geoLayer = L.geoJSON(data, {
    style: defaultPolyStyle,
    pointToLayer: (feature, latlng) => L.circleMarker(latlng, {
      radius: 7,
      weight: 1.5,
      color: '#0f172a',
      fillColor: severityColor(feature?.properties?.severity),
      fillOpacity: 0.95
    }),
    onEachFeature: (feature, layer) => {
      layer.on('mouseover', () => {
        if (layer.setStyle) layer.setStyle(hoverPolyStyle);
        if (layer.bringToFront) layer.bringToFront();
        setHoverInfo(feature, index);
      });

      layer.on('mouseout', () => {
        if (layer.setStyle) layer.setStyle(defaultPolyStyle(feature));
        setHoverInfo(null);
      });

      layer.on('click', () => onRegionClick(feature));
    }
  }).addTo(map);

  if (data.features?.length) map.fitBounds(geoLayer.getBounds(), { padding: [20, 20] });

  // Update overview chart + subtitles
  renderOverview(latestMapFeatures);
}

async function onRegionClick(feature) {
  try {
    selectedFeature = feature;
    const regionId = feature?.properties?.id;
    const indexName = indexEl.value;
    const levelName = levelEl.value;
    const featureName = feature?.properties?.name || 'ناحیه';
    setPanelOpen(true);
    renderPanelLoading(featureName);
    togglePanelSpinner(true);
    setTimelineDisabled(false);
    setNoDataMessage(false);

    const queryKey = `${regionId}|${levelName}|${indexName}|${dateEl.value}`;
    if (lastPanelQueryKey === queryKey && panelEl.classList.contains('open')) return;
    lastPanelQueryKey = queryKey;

    const reqId = ++panelRequestSeq;
    if (panelAbortController) panelAbortController.abort();
    panelAbortController = new AbortController();
    let kpi = { error: 'No series found' }; let ts = []; let tsAll = [];
    try {
      const seriesKey = `${regionId}|${levelName}|${indexName}|${dateEl.value}`;
      const seriesAllKey = `${regionId}|${levelName}|${indexName}|all`;
      const kpiKey = `${regionId}|${levelName}|${indexName}|${dateEl.value}`;
      [kpi, ts, tsAll] = await Promise.all([
        fetchCached(panelKpiCache, kpiKey, () => `${API_BASE}/kpi?region_id=${regionId}&level=${levelName}&index=${indexName}&date=${dateEl.value}`, { signal: panelAbortController.signal }),
        fetchCached(timeseriesCache, seriesKey, () => `${API_BASE}/timeseries?region_id=${regionId}&level=${levelName}&index=${indexName}&date=${dateEl.value}`, { signal: panelAbortController.signal }),
        fetchCached(timeseriesCache, seriesAllKey, () => `${API_BASE}/timeseries?region_id=${regionId}&level=${levelName}&index=${indexName}`, { signal: panelAbortController.signal })
      ]);
    } catch (_) {}

    if (reqId !== panelRequestSeq) return;

    const normalizedSeries = normalizeTimeseries(ts);
    const normalizedAllSeries = normalizeTimeseries(tsAll);
    const rangeSeries = normalizedAllSeries.length ? normalizedAllSeries : normalizedSeries;
    const { minDate, maxDate } = getDateRangeFromTimeseries(rangeSeries);

    if (!rangeSeries.length) {
      setTimelineDisabled(true);
      renderKPI({
        latest: NaN,
        min: NaN,
        max: NaN,
        mean: NaN,
        severity: 'N/A',
        trend: { tau: NaN, p_value: '-', sen_slope: NaN, trend: '—' }
      }, featureName, indexName);
      setNoDataMessage(true, 'No data for this selection');
      renderChart([], indexName);
      togglePanelSpinner(false);
      return;
    }

    setTimelineDisabled(false);
    const dateAdjusted = applyDateBounds(minDate, maxDate);
    buildMonthStrip(dateEl.value);
    if (dateAdjusted) {
      lastPanelQueryKey = null;
      await onDateChanged();
      return;
    }

    const latestVisiblePoint = normalizedSeries.length ? normalizedSeries[normalizedSeries.length - 1] : null;
    const latestVisibleValue = Number(latestVisiblePoint?.value);
    const val = Number(feature?.properties?.value);
    const resolvedLatest = Number.isFinite(latestVisibleValue)
      ? latestVisibleValue
      : (Number.isFinite(val) ? val : NaN);

    const safeKpi = (kpi && typeof kpi === 'object' && !kpi.error)
      ? kpi
      : {
        latest: Number.isFinite(resolvedLatest) ? resolvedLatest : 0,
        min: Number.isFinite(resolvedLatest) ? resolvedLatest : 0,
        max: Number.isFinite(resolvedLatest) ? resolvedLatest : 0,
        mean: Number.isFinite(resolvedLatest) ? resolvedLatest : 0,
        severity: feature?.properties?.severity || 'N/A',
        trend: { tau: 0, p_value: '-', sen_slope: 0, trend: 'بدون روند' }
      };

    if (Number.isFinite(resolvedLatest)) {
      safeKpi.latest = resolvedLatest;
      if (!safeKpi.severity || safeKpi.severity === 'N/A') {
        safeKpi.severity = classify(resolvedLatest);
      }
    }

    renderKPI(safeKpi, featureName, indexName);
    renderChart(rangeSeries, indexName);
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
  buildMonthStrip(dateEl.value);
  await loadMap();
  if (panelEl.classList.contains('open') && selectedFeature) {
    await onRegionClick(findSelectedFeatureFromCurrentMap());
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
    lastChartRenderKey = null;
    onDateChanged();
  });
  indexEl.addEventListener('change', async () => { lastPanelQueryKey = null; await onDateChanged(); });
  levelEl.addEventListener('change', () => {
    lastPanelQueryKey = null;
    dateEl.removeAttribute('min');
    dateEl.removeAttribute('max');
    setTimelineDisabled(false);
    onDateChanged();
  });
  dateEl.addEventListener('change', () => { lastPanelQueryKey = null; debouncedDateChanged(); });

  document.getElementById('prevMonth').addEventListener('click', () => {
    if (dateEl.min && dateEl.value <= dateEl.min) return;
    lastPanelQueryKey = null;
    dateEl.value = addMonth(dateEl.value, -1);
    debouncedDateChanged();
  });
  document.getElementById('nextMonth').addEventListener('click', () => {
    if (dateEl.max && dateEl.value >= dateEl.max) return;
    lastPanelQueryKey = null;
    dateEl.value = addMonth(dateEl.value, 1);
    debouncedDateChanged();
  });
  document.getElementById('toStart').addEventListener('click', () => {
    if (!currentRangeStart) return;
    lastPanelQueryKey = null;
    dateEl.value = currentRangeStart;
    debouncedDateChanged();
  });
  document.getElementById('toEnd').addEventListener('click', () => {
    if (!currentRangeEnd) return;
    lastPanelQueryKey = null;
    dateEl.value = currentRangeEnd;
    debouncedDateChanged();
  });

  // Fix timeline arrow behavior: shift date and refresh (not just scroll)
  document.getElementById('stripPrev').addEventListener('click', () => {
    if (dateEl.min && dateEl.value <= dateEl.min) return;
    lastPanelQueryKey = null;
    dateEl.value = addMonth(dateEl.value, -1);
    debouncedDateChanged();
  });
  document.getElementById('stripNext').addEventListener('click', () => {
    if (dateEl.max && dateEl.value >= dateEl.max) return;
    lastPanelQueryKey = null;
    dateEl.value = addMonth(dateEl.value, 1);
    debouncedDateChanged();
  });

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

  document.getElementById('search').addEventListener('input', (e) => {
    if (!geoLayer) return;
    const q = e.target.value.trim();
    geoLayer.eachLayer((layer) => {
      const hit = !q || layer.feature.properties.name.toLowerCase().includes(q.toLowerCase());
      if (layer.setStyle) layer.setStyle({ opacity: hit ? 1 : .2, fillOpacity: hit ? .78 : .1 });
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

populateIndexOptions();
addMapLegend();
setupEvents();
updateHeaderHeightVar();
updateSubtitles();
buildMonthStrip(dateEl.value);
loadMap();

