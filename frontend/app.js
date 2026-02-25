const API = "http://localhost:8000";
const map = L.map('map', { zoomControl: false }).setView([32.5, 53.6], 5);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(map);

let geoLayer;
let chart;
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
const closeBtn = document.getElementById('closePanel');
const monthStripEl = document.getElementById('monthStrip');
const valueBoxEl = document.getElementById('valueBox');
const modalBackdropEl = document.getElementById('modalBackdrop');
const panelSpinnerEl = document.getElementById('panelSpinner');
const kpiGridEl = document.getElementById('kpiGrid');
const mapLoadingEl = document.getElementById('mapLoading');
const timelineControls = [
  document.getElementById('toStart'),
  document.getElementById('prevMonth'),
  document.getElementById('date'),
  document.getElementById('nextMonth'),
  document.getElementById('toEnd'),
  document.getElementById('stripPrev'),
  document.getElementById('stripNext')
];

const droughtColors = {
  'D4': '#7f1d1d',
  'D3': '#dc2626',
  'D2': '#f97316',
  'D1': '#fbbf24',
  'D0': '#fde047',
  'Normal/Wet': '#86efac'
};

const DROUGHT_THRESHOLD_LINES = [
  { yAxis: -0.5, name: 'D0' },
  { yAxis: -0.8, name: 'D1' },
  { yAxis: -1.3, name: 'D2' },
  { yAxis: -1.6, name: 'D3' },
  { yAxis: -2.0, name: 'D4' },
];


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

  return toPersianDigits((raw || '—').replace('.', '٫'));
}

function addMonth(yyyymm, delta) {
  const [y, m] = yyyymm.split('-').map(Number);
  const dt = new Date(y, m - 1 + delta, 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
}

function toMonthLabel(yyyymm) {
  const [y, m] = yyyymm.split('-').map(Number);
  const labels = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return { month: labels[m - 1], year: y };
}

function toISODate(yyyymm) { return `${yyyymm}-01`; }

function toUTCMonthStart(yyyymm) { return `${yyyymm}-01T00:00:00Z`; }

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
  const minDate = dateEl.min || null;
  const maxDate = dateEl.max || null;
  for (let i = -18; i <= 18; i += 1) {
    const m = addMonth(centerMonth, i);
    const { month, year } = toMonthLabel(m);
    const btn = document.createElement('button');
    const outOfRange = (minDate && m < minDate) || (maxDate && m > maxDate);
    btn.className = `month-chip ${m === centerMonth ? 'active' : ''}`;
    btn.disabled = outOfRange;
    btn.innerHTML = `${month}${(m.endsWith('-01') || m.endsWith('-07')) ? `<span class="year-tag">${year}</span>` : ''}`;
    btn.onclick = () => {
      if (outOfRange) return;
      lastPanelQueryKey = null;
      dateEl.value = m;
      debouncedDateChanged();
    };
    monthStripEl.appendChild(btn);
  }
}

function setPanelOpen(open) {
  panelEl.classList.toggle('open', open);
  panelEl.setAttribute('aria-hidden', String(!open));
  if (modalBackdropEl) {
    modalBackdropEl.classList.toggle('open', open);
    modalBackdropEl.setAttribute('aria-hidden', String(!open));
  }
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
  document.getElementById('panelTitle').textContent = `${toPersianDigits(dateEl.value.replace(/-/g, '/'))}`;
  document.getElementById('panelSubtitle').textContent = `ناحیه انتخاب‌شده: ${featureName}`;
  document.getElementById('mainMetricLabel').textContent = `مقدار ${indexLabel.toUpperCase()}`;
  document.getElementById('mainMetricValue').textContent = formatNumber(kpi.latest);
  document.getElementById('severityBadge').textContent = severityLong[sev] || sev;
  applySeverityStyle(sev);

  document.getElementById('tauVal').textContent = formatNumber(kpi.trend?.tau);
  document.getElementById('pVal').textContent = formatPValue(kpi.trend?.p_value);
  document.getElementById('senVal').textContent = formatNumber(kpi.trend?.sen_slope);
  document.getElementById('latestVal').textContent = formatNumber(kpi.latest);
  document.getElementById('trendText').textContent = `روند: ${(kpi.trend?.trend === 'decreasing' ? 'کاهشی' : kpi.trend?.trend === 'increasing' ? 'افزایشی' : kpi.trend?.trend === 'no trend' ? 'بدون روند' : (kpi.trend?.trend || '—'))} | میانگین: ${formatNumber(kpi.mean)} | کمینه: ${formatNumber(kpi.min)} | بیشینه: ${formatNumber(kpi.max)}`;
}

function renderPanelLoading(featureName = 'ناحیه') {
  document.getElementById('panelTitle').textContent = `${toPersianDigits(dateEl.value.replace(/-/g, '/'))}`;
  document.getElementById('panelSubtitle').textContent = `ناحیه انتخاب‌شده: ${featureName}`;
  document.getElementById('mainMetricLabel').textContent = `مقدار ${indexEl.value.toUpperCase()}`;
  document.getElementById('mainMetricValue').textContent = '...';
  document.getElementById('severityBadge').textContent = 'درحال بارگذاری';
  document.getElementById('trendText').textContent = 'درحال بارگذاری داده‌ها...';
  ['tauVal', 'pVal', 'senVal', 'latestVal'].forEach((id) => {
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
    fetchCached(mapDataCache, mapKey, () => `${API}/mapdata?level=${level}&index=${index}&date=${nextMonth}`)
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
  if (show) document.getElementById('trendText').textContent = message;
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
  const selectedDate = toUTCMonthStart(dateEl.value);

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
    ...DROUGHT_THRESHOLD_LINES,
    {
      xAxis: selectedDate,
      lineStyle: { color: '#ef4444', type: 'dashed', width: 1.8 },
      label: { show: false }
    }
  ];


  const option = {
    title: {
      text: '',
      left: 'left',
      textStyle: { fontWeight: 'bold', fontSize: 20, color: '#1f2937' }
    },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross' },
      formatter: (params) => {
        const entries = Array.isArray(params) ? params : [params];
        const rawAxis = entries[0]?.axisValue ?? entries[0]?.value?.[0] ?? '';
        const axisValue = formatChartDate(rawAxis);
        const rows = entries.map((item) => {
          const value = Array.isArray(item.value) ? item.value[1] : item.value;
          return `${item.marker}${item.seriesName}: ${formatNumber(value)}`;
        });
        return [axisValue, ...rows].join('<br/>');
      }
    },
    legend: {
      top: 0,
      right: 8,
      textStyle: { color: '#4b5563' }
    },
    grid: {
      left: '7%',
      right: '10%',
      bottom: '20%',
      top: 50,
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
        filterMode: 'none'
      },
      {
        type: 'slider',
        show: true,
        startValue: parsedData[Math.max(parsedData.length - 60, 0)]?.[0],
        endValue: parsedData[parsedData.length - 1]?.[0],
        bottom: 10,
        height: 25,
        borderColor: '#d1d5db',
        fillerColor: 'rgba(167, 183, 204, 0.4)',
        handleStyle: { color: '#a7b7cc' },
        filterMode: 'none'
      }
    ],
    series: [
      {
        name: indexLabel.toUpperCase(),
        type: 'line',
        data: parsedData,
        symbol: 'none',
        lineStyle: { width: 2 },
        areaStyle: {
          origin: 0,
          opacity: 0.7
        },
        markLine: {
          symbol: ['none', 'none'],
          label: { position: 'end', formatter: '{b}', color: '#374151', fontSize: 12 },
          lineStyle: { type: 'dashed', color: '#9ca3af', width: 1 },
          data: markLineData
        }
      },
      {
        name: 'روند',
        type: 'line',
        data: trendData,
        symbol: 'none',
        lineStyle: { color: '#ef4444', width: 1.6, type: 'solid' },
        itemStyle: { color: '#ef4444' }
      }
    ]
  };

  currentRangeStart = parsedData.length ? formatChartDate(parsedData[0][0]) : null;
  currentRangeEnd = parsedData.length ? formatChartDate(parsedData[parsedData.length - 1][0]) : null;
  chart.setOption(option, true);
  lastChartRenderKey = derivedKey;
}

function addMapLegend() {
  const legend = L.control({ position: 'bottomright' });
  legend.onAdd = () => {
    const div = L.DomUtil.create('div', 'map-legend');
    div.id = 'mapLegendBox';
    const items = [
      ['N0', 'Normal/Wet', '#86efac'],
      ['D0', 'Abnormally Dry', '#fde047'],
      ['D1', 'Moderate Drought', '#fbbf24'],
      ['D2', 'Severe Drought', '#f97316'],
      ['D3', 'Extreme Drought', '#dc2626'],
      ['D4', 'Exceptional Drought', '#7f1d1d']
    ];
    div.innerHTML = `
      <div class="head">
        <button id="legendToggle" class="toggle">‹</button>
        <h6>Drought Severity</h6>
      </div>
      ${items.map(i => `<div class="row-item"><span class="sw" style="background:${i[2]}"></span><span class="short">${i[0]}</span><span class="label">${i[1]}</span></div>`).join('')}`;
    return div;
  };
  legend.addTo(map);

  setTimeout(() => {
    const toggle = document.getElementById('legendToggle');
    const legendBox = document.getElementById('mapLegendBox');
    if (!toggle || !legendBox) return;
    toggle.addEventListener('click', () => {
      legendBox.classList.toggle('compact');
      toggle.textContent = legendBox.classList.contains('compact') ? '›' : '‹';
    });
  }, 100);
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
      () => `${API}/mapdata?level=${level}&index=${index}&date=${date}`,
      { signal: mapAbortController.signal }
    );
    preloadLikelyMapRequests(level, index, date);
  } catch (_) {}

  if (reqId !== mapRequestSeq) { toggleMapLoading(false); return; }

  toggleMapLoading(false);
  latestMapFeatures = data.features || [];
  if (geoLayer) map.removeLayer(geoLayer);

  geoLayer = L.geoJSON(data, {
    style: f => ({ color: '#334155', weight: 1, fillOpacity: 0.78, fillColor: severityColor(f.properties.severity) }),
    pointToLayer: (feature, latlng) => L.circleMarker(latlng, {
      radius: 8,
      weight: 1.5,
      color: '#0f172a',
      fillColor: severityColor(feature?.properties?.severity),
      fillOpacity: 0.95
    }),
    onEachFeature: (feature, layer) => {
      const mapValue = feature.properties.value == null ? '—' : formatNumber(feature.properties.value);
      layer.bindTooltip(`<div><strong>${feature.properties.name}</strong><br>شاخص ${index.toUpperCase()}: ${mapValue}<br>${severityLong[feature.properties.severity] || feature.properties.severity}</div>`);
      layer.on('click', () => onRegionClick(feature));
    }
  }).addTo(map);

  if (data.features?.length) map.fitBounds(geoLayer.getBounds(), { padding: [20, 20] });
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
        fetchCached(panelKpiCache, kpiKey, () => `${API}/kpi?region_id=${regionId}&level=${levelName}&index=${indexName}&date=${dateEl.value}`, { signal: panelAbortController.signal }),
        fetchCached(timeseriesCache, seriesKey, () => `${API}/timeseries?region_id=${regionId}&level=${levelName}&index=${indexName}&date=${dateEl.value}`, { signal: panelAbortController.signal }),
        fetchCached(timeseriesCache, seriesAllKey, () => `${API}/timeseries?region_id=${regionId}&level=${levelName}&index=${indexName}`, { signal: panelAbortController.signal })
      ]);
      if (window.htmx && kpiGridEl) {
        htmx.ajax('GET', `${API}/panel-fragment?region_id=${regionId}&level=${levelName}&index=${indexName}&date=${dateEl.value}`, {
          target: '#kpiGrid',
          swap: 'innerHTML'
        });
      }
    } catch (_) {}

    if (reqId !== panelRequestSeq) return;

    const normalizedSeries = normalizeTimeseries(ts);
    const normalizedAllSeries = normalizeTimeseries(tsAll);
    const rangeSeries = normalizedAllSeries.length ? normalizedAllSeries : normalizedSeries;
    const { minDate, maxDate } = getDateRangeFromTimeseries(rangeSeries);

    if (!rangeSeries.length) {
      setTimelineDisabled(true);
      setNoDataMessage(true, 'No data for this selection');
      renderKPI({
        latest: NaN,
        min: NaN,
        max: NaN,
        mean: NaN,
        severity: 'N/A',
        trend: { tau: NaN, p_value: '-', sen_slope: NaN, trend: '—' }
      }, featureName, indexName);
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

    const val = Number(feature?.properties?.value);
    const safeKpi = (kpi && typeof kpi === 'object' && !kpi.error)
      ? kpi
      : {
        latest: Number.isFinite(val) ? val : 0,
        min: Number.isFinite(val) ? val : 0,
        max: Number.isFinite(val) ? val : 0,
        mean: Number.isFinite(val) ? val : 0,
        severity: feature?.properties?.severity || 'N/A',
        trend: { tau: 0, p_value: '-', sen_slope: 0, trend: 'بدون روند' }
      };

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

  closeBtn.addEventListener('click', () => { lastPanelQueryKey = null; setPanelOpen(false); });

  panelEl.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panelEl.classList.contains('open')) { lastPanelQueryKey = null; setPanelOpen(false); }
  });

  document.getElementById('search').addEventListener('input', (e) => {
    if (!geoLayer) return;
    const q = e.target.value.trim();
    geoLayer.eachLayer((layer) => {
      const hit = !q || layer.feature.properties.name.toLowerCase().includes(q.toLowerCase());
      if (layer.setStyle) layer.setStyle({ opacity: hit ? 1 : .2, fillOpacity: hit ? .78 : .1 });
    });
  });
}

populateIndexOptions();
addMapLegend();
setupEvents();
buildMonthStrip(dateEl.value);
loadMap();
