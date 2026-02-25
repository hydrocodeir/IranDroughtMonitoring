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

const levelEl = document.getElementById('level');
const indexEl = document.getElementById('index');
const dateEl = document.getElementById('date');
const panelEl = document.getElementById('insightPanel');
const closeBtn = document.getElementById('closePanel');
const monthStripEl = document.getElementById('monthStrip');
const valueBoxEl = document.getElementById('valueBox');
const modalBackdropEl = document.getElementById('modalBackdrop');

const droughtColors = {
  'D4': '#7f1d1d',
  'D3': '#dc2626',
  'D2': '#f97316',
  'D1': '#fbbf24',
  'D0': '#fde047',
  'Normal/Wet': '#86efac'
};


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

function formatChartDate(value) {
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return String(value || '');
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
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
  for (let i = -18; i <= 18; i += 1) {
    const m = addMonth(centerMonth, i);
    const { month, year } = toMonthLabel(m);
    const btn = document.createElement('button');
    btn.className = `month-chip ${m === centerMonth ? 'active' : ''}`;
    btn.innerHTML = `${month}${(m.endsWith('-01') || m.endsWith('-07')) ? `<span class="year-tag">${year}</span>` : ''}`;
    btn.onclick = () => {
      lastPanelQueryKey = null;
      dateEl.value = m;
      onDateChanged();
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
  const parsedData = ts.map((d) => [d.date, Number(d.value)]);
  const trendData = calculateTrendLine(parsedData);
  const selectedDate = toISODate(dateEl.value);
  const lastDate = parsedData.length ? parsedData[parsedData.length - 1][0] : selectedDate;

  const chartDom = document.getElementById('tsChart');
  if (!chart) {
    chart = echarts.init(chartDom);
    window.addEventListener('resize', () => chart && chart.resize());
  }

  const markLineData = [
    { yAxis: -0.5, name: 'D0' },
    { yAxis: -0.8, name: 'D1' },
    { yAxis: -1.3, name: 'D2' },
    { yAxis: -1.6, name: 'D3' },
    { yAxis: -2.0, name: 'D4' },
  ];

  if (selectedDate !== lastDate) {
    markLineData.push({ xAxis: selectedDate, lineStyle: { color: '#ef4444', type: 'dashed', width: 1.8 }, label: { show: false } });
  }

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
        type: 'slider',
        show: true,
        start: 0,
        end: 100,
        bottom: 10,
        height: 25,
        borderColor: '#d1d5db',
        fillerColor: 'rgba(167, 183, 204, 0.4)',
        handleStyle: { color: '#a7b7cc' }
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

  currentRangeStart = parsedData.length ? parsedData[0][0].slice(0, 7) : null;
  currentRangeEnd = parsedData.length ? parsedData[parsedData.length - 1][0].slice(0, 7) : null;
  chart.setOption(option, true);
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

  let data = { type: 'FeatureCollection', features: [] };
  try {
    data = await fetchJson(`${API}/mapdata?level=${level}&index=${index}&date=${date}`);
  } catch (_) {}

  if (reqId !== mapRequestSeq) return;

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

    const queryKey = `${regionId}|${levelName}|${indexName}|${dateEl.value}`;
    if (lastPanelQueryKey === queryKey && panelEl.classList.contains('open')) return;
    lastPanelQueryKey = queryKey;

    const reqId = ++panelRequestSeq;
    let kpi = { error: 'No series found' }; let ts = [];
    try {
      [kpi, ts] = await Promise.all([
        fetchJson(`${API}/kpi?region_id=${regionId}&level=${levelName}&index=${indexName}&date=${dateEl.value}`),
        fetchJson(`${API}/timeseries?region_id=${regionId}&level=${levelName}&index=${indexName}`)
      ]);
    } catch (_) {}

    if (reqId !== panelRequestSeq) return;

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
    renderChart(normalizeTimeseries(ts), indexName);
  } catch (err) {
    console.error('onRegionClick error:', err);
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

function setupEvents() {
  document.getElementById('reloadTop').addEventListener('click', () => { lastPanelQueryKey = null; onDateChanged(); });
  indexEl.addEventListener('change', async () => { lastPanelQueryKey = null; await onDateChanged(); });
  levelEl.addEventListener('change', () => { lastPanelQueryKey = null; onDateChanged(); });
  dateEl.addEventListener('change', () => { lastPanelQueryKey = null; onDateChanged(); });

  document.getElementById('prevMonth').addEventListener('click', () => { lastPanelQueryKey = null; dateEl.value = addMonth(dateEl.value, -1); onDateChanged(); });
  document.getElementById('nextMonth').addEventListener('click', () => { lastPanelQueryKey = null; dateEl.value = addMonth(dateEl.value, 1); onDateChanged(); });
  document.getElementById('toStart').addEventListener('click', () => {
    if (!currentRangeStart) return;
    lastPanelQueryKey = null;
    dateEl.value = currentRangeStart;
    onDateChanged();
  });
  document.getElementById('toEnd').addEventListener('click', () => {
    if (!currentRangeEnd) return;
    lastPanelQueryKey = null;
    dateEl.value = currentRangeEnd;
    onDateChanged();
  });

  // Fix timeline arrow behavior: shift date and refresh (not just scroll)
  document.getElementById('stripPrev').addEventListener('click', () => { lastPanelQueryKey = null; dateEl.value = addMonth(dateEl.value, -1); onDateChanged(); });
  document.getElementById('stripNext').addEventListener('click', () => { lastPanelQueryKey = null; dateEl.value = addMonth(dateEl.value, 1); onDateChanged(); });

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
