const API = "http://localhost:8000";
const map = L.map('map', { zoomControl: false }).setView([32.5, 53.6], 5);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(map);

let geoLayer;
let chart;
let selectedFeature = null;
let latestMapFeatures = [];

const levelEl = document.getElementById('level');
const indexEl = document.getElementById('index');
const dateEl = document.getElementById('date');
const panelEl = document.getElementById('insightPanel');
const closeBtn = document.getElementById('closePanel');
const monthStripEl = document.getElementById('monthStrip');
const valueBoxEl = document.getElementById('valueBox');

const droughtColors = {
  'D4': '#7f1d1d',
  'D3': '#dc2626',
  'D2': '#f97316',
  'D1': '#fbbf24',
  'D0': '#fde047',
  'Normal/Wet': '#86efac'
};

const severityLong = {
  'Normal/Wet': 'Normal/Wet',
  'D0': 'D0 - Abnormally Dry',
  'D1': 'D1 - Moderate Drought',
  'D2': 'D2 - Severe Drought',
  'D3': 'D3 - Extreme Drought',
  'D4': 'D4 - Exceptional Drought'
};

function severityColor(sev) { return droughtColors[sev] || '#60a5fa'; }

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

function fallbackGeoJSON(dateRef = dateEl.value) {
  const month = Number((dateRef || '2020-01').split('-')[1] || 1);
  const tehranValue = -0.9 + (month * 0.03);
  const isfahanValue = -1.3 + (month * 0.02);
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [[[50.9,35.3],[52.0,35.3],[52.0,36.2],[50.9,36.2],[50.9,35.3]]] },
        properties: { id: 1, name: 'Tehran', value: Number(tehranValue.toFixed(2)), severity: classify(tehranValue) }
      },
      {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [[[50.1,31.4],[52.7,31.4],[52.7,33.8],[50.1,33.8],[50.1,31.4]]] },
        properties: { id: 2, name: 'Isfahan', value: Number(isfahanValue.toFixed(2)), severity: classify(isfahanValue) }
      }
    ]
  };
}

function fallbackTimeSeries(baseValue = -0.5) {
  return Array.from({ length: 48 }).map((_, i) => ({
    date: `2022-${String((i % 12) + 1).padStart(2, '0')}-01`,
    value: (Math.sin(i / 3) - 0.7) + (Math.random() * 0.45) + baseValue * 0.05
  }));
}

function normalizeTimeseries(ts, baseValue = -0.5) {
  if (!Array.isArray(ts) || ts.length === 0) return fallbackTimeSeries(baseValue);
  const ok = ts.filter(d => d && d.date && Number.isFinite(Number(d.value))).map(d => ({ date: d.date, value: Number(d.value) }));
  return ok.length ? ok : fallbackTimeSeries(baseValue);
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
    const isPred = m >= centerMonth;
    btn.className = `month-chip ${m === centerMonth ? 'active' : ''} ${isPred ? 'predicted' : ''}`;
    btn.innerHTML = `${month}${(m.endsWith('-01') || m.endsWith('-07')) ? `<span class="year-tag">${year}</span>` : ''}`;
    btn.onclick = () => {
      dateEl.value = m;
      onDateChanged();
    };
    monthStripEl.appendChild(btn);
  }
}

function setPanelOpen(open) {
  panelEl.classList.toggle('open', open);
  panelEl.setAttribute('aria-hidden', String(!open));
}

function applySeverityStyle(sev) {
  const map = { 'Normal/Wet': 'NormalWet', 'D0': 'D0', 'D1': 'D1', 'D2': 'D2', 'D3': 'D3', 'D4': 'D4' };
  ['NormalWet','D0','D1','D2','D3','D4'].forEach(k => valueBoxEl.classList.remove(`sev-${k}`));
  const key = map[sev] || 'D0';
  valueBoxEl.classList.add(`sev-${key}`);
  const c = severityColor(sev);
  valueBoxEl.style.borderColor = c;
}

function renderKPI(kpi, featureName, indexLabel) {
  const sev = kpi.severity || '-';
  document.getElementById('panelTitle').textContent = `Drought - ${dateEl.value}`;
  document.getElementById('panelSubtitle').textContent = `Selected Region: ${featureName}`;
  document.getElementById('mainMetricLabel').textContent = `${indexLabel.toUpperCase()} Value`;
  document.getElementById('mainMetricValue').textContent = Number(kpi.latest ?? 0).toFixed(2);
  document.getElementById('severityBadge').textContent = severityLong[sev] || sev;
  applySeverityStyle(sev);

  document.getElementById('tauVal').textContent = Number(kpi.trend?.tau ?? 0).toFixed(3);
  document.getElementById('pVal').textContent = (kpi.trend?.p_value ?? '-').toString();
  document.getElementById('senVal').textContent = Number(kpi.trend?.sen_slope ?? 0).toFixed(4);
  document.getElementById('latestVal').textContent = Number(kpi.latest ?? 0).toFixed(2);
  document.getElementById('trendText').textContent = `Trend: ${kpi.trend?.trend || '-'} | Mean: ${Number(kpi.mean ?? 0).toFixed(2)} | Min: ${Number(kpi.min ?? 0).toFixed(2)} | Max: ${Number(kpi.max ?? 0).toFixed(2)}`;
}

function droughtUpperBound(value) {
  if (value >= -0.5) return 0.0;
  if (value >= -0.8) return -0.5;
  if (value >= -1.3) return -0.8;
  if (value >= -1.6) return -1.3;
  if (value >= -2.0) return -1.6;
  return -2.0;
}

function thresholdSeverityByBound(bound) {
  if (bound >= 0) return 'Normal/Wet';
  if (bound >= -0.5) return 'D0';
  if (bound >= -0.8) return 'D1';
  if (bound >= -1.3) return 'D2';
  if (bound >= -1.6) return 'D3';
  return 'D4';
}

function droughtFillColorByBound(bound) {
  const sev = thresholdSeverityByBound(bound);
  const base = severityColor(sev);
  const rgb = base.startsWith('#') ? base : '#60a5fa';
  const hex = rgb.replace('#', '');
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, 0.40)`;
}

function drawThresholdGuides(chartRef) {
  const y = chartRef.scales.y;
  const { ctx, chartArea } = chartRef;
  if (!y || !chartArea) return;
  [-0.5, -0.8, -1.3, -1.6, -2.0].forEach(v => {
    const py = y.getPixelForValue(v);
    ctx.save();
    ctx.strokeStyle = 'rgba(107,114,128,.55)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(chartArea.left, py);
    ctx.lineTo(chartArea.right, py);
    ctx.stroke();
    ctx.restore();
  });
}

function drawAreaBetweenSeriesAndThreshold(chartRef, values) {
  const y = chartRef.scales.y;
  const meta = chartRef.getDatasetMeta(0);
  const { ctx } = chartRef;
  if (!y || !meta?.data?.length || values.length < 2) return;

  // Fill ONLY between line and its local threshold bound (piecewise), not full row bands.
  for (let i = 1; i < meta.data.length; i += 1) {
    const p0 = meta.data[i - 1];
    const p1 = meta.data[i];
    const v0 = Number(values[i - 1]);
    const v1 = Number(values[i]);
    if (!Number.isFinite(v0) || !Number.isFinite(v1)) continue;

    const steps = 10;
    for (let j = 0; j < steps; j += 1) {
      const t0 = j / steps;
      const t1 = (j + 1) / steps;
      const x0 = p0.x + (p1.x - p0.x) * t0;
      const x1 = p0.x + (p1.x - p0.x) * t1;
      const vSeg0 = v0 + (v1 - v0) * t0;
      const vSeg1 = v0 + (v1 - v0) * t1;
      const bound0 = droughtUpperBound(vSeg0);
      const bound1 = droughtUpperBound(vSeg1);
      const boundMid = droughtUpperBound((vSeg0 + vSeg1) / 2);

      const yLine0 = y.getPixelForValue(vSeg0);
      const yLine1 = y.getPixelForValue(vSeg1);
      const yBound0 = y.getPixelForValue(bound0);
      const yBound1 = y.getPixelForValue(bound1);

      ctx.save();
      ctx.fillStyle = droughtFillColorByBound(boundMid);
      ctx.beginPath();
      ctx.moveTo(x0, yLine0);
      ctx.lineTo(x1, yLine1);
      ctx.lineTo(x1, yBound1);
      ctx.lineTo(x0, yBound0);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }
}

function drawThresholdLabels(chartRef) {
  const y = chartRef.scales.y;
  const { ctx, chartArea } = chartRef;
  if (!y || !chartArea) return;

  const labels = [
    { text: 'D0', val: -0.5 },
    { text: 'D1', val: -0.8 },
    { text: 'D2', val: -1.3 },
    { text: 'D3', val: -1.6 },
    { text: 'D4', val: -2.0 },
  ];

  ctx.save();
  ctx.fillStyle = '#374151';
  ctx.font = '12px Vazirmatn, sans-serif';
  ctx.textBaseline = 'middle';
  labels.forEach(l => {
    const yy = y.getPixelForValue(l.val);
    ctx.fillText(l.text, chartArea.right + 8, yy);
  });
  ctx.restore();
}

function renderChart(ts, indexLabel) {
  const labels = ts.map(d => d.date);
  const values = ts.map(d => d.value);
  const trendData = getTrendLine(values);
  const selectedDate = toISODate(dateEl.value);
  const selectedIdx = labels.indexOf(selectedDate);
  const lastIdx = labels.length - 1;

  const customPlugin = {
    id: 'bandsAndVLines',
    beforeDatasetsDraw(chartRef) {
      drawAreaBetweenSeriesAndThreshold(chartRef, values);
      drawThresholdGuides(chartRef);
    },
    afterDatasetsDraw(chartRef) {
      const { ctx, chartArea, scales: { x } } = chartRef;
      if (!x || !chartArea) return;
      const drawV = (idx, color, dash = [5, 4]) => {
        if (idx < 0 || idx >= labels.length) return;
        const xPos = x.getPixelForValue(idx);
        ctx.save();
        ctx.setLineDash(dash);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(xPos, chartArea.top);
        ctx.lineTo(xPos, chartArea.bottom);
        ctx.stroke();
        ctx.restore();
      };
      drawV(lastIdx, '#2563eb', [3, 3]);
      if (selectedIdx !== -1 && selectedIdx !== lastIdx) drawV(selectedIdx, '#ef4444', [6, 4]);
      drawThresholdLabels(chartRef);
    }
  };

  if (chart) chart.destroy();
  chart = new Chart(document.getElementById('tsChart'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: indexLabel.toUpperCase(),
          data: values,
          borderWidth: 2,
          pointRadius: 0,
          tension: .2,
          segment: {
            borderColor: ctx => severityColor(classify(ctx.p1.parsed.y))
          }
        },
        {
          label: 'Trend',
          data: trendData,
          borderColor: '#ef4444',
          borderWidth: 1.4,
          pointRadius: 0,
          tension: 0,
          fill: false
        }
      ]
    },
    options: {
      maintainAspectRatio: false,
      layout: { padding: { right: 32 } },
      plugins: { legend: { display: true } },
      scales: {
        x: { ticks: { maxTicksLimit: 6 } },
        y: { min: -3, max: 2.5, grid: { color: '#e2e8f0' } }
      }
    },
    plugins: [customPlugin]
  });
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
  let data;
  try {
    data = await fetchJson(`${API}/mapdata?level=${level}&index=${index}&date=${date}`);
  } catch (_) {
    data = fallbackGeoJSON(date);
  }

  latestMapFeatures = data.features || [];
  if (geoLayer) map.removeLayer(geoLayer);

  geoLayer = L.geoJSON(data, {
    style: f => ({ color: '#334155', weight: 1, fillOpacity: 0.78, fillColor: severityColor(f.properties.severity) }),
    onEachFeature: (feature, layer) => {
      layer.bindTooltip(`<div><strong>${feature.properties.name}</strong><br>${index.toUpperCase()}: ${Number(feature.properties.value).toFixed(2)}<br>${feature.properties.severity}</div>`);
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
    const featureName = feature?.properties?.name || 'Region';
    setPanelOpen(true);

    let kpi; let ts;
    try {
      [kpi, ts] = await Promise.all([
        fetchJson(`${API}/kpi?region_id=${regionId}&index=${indexName}`),
        fetchJson(`${API}/timeseries?region_id=${regionId}&index=${indexName}`)
      ]);
    } catch (_) {
      const val = Number(feature?.properties?.value ?? 0);
      kpi = { latest: val, min: val - 1, max: val + 1, mean: val, severity: feature?.properties?.severity || classify(val), trend: { tau: -0.178, p_value: '<0.001', sen_slope: -0.001, trend: 'decreasing' } };
      ts = fallbackTimeSeries(val);
    }

    const safeKpi = (kpi && typeof kpi === 'object' && !kpi.error) ? kpi : { latest: Number(feature?.properties?.value ?? 0), min: Number(feature?.properties?.value ?? 0)-1, max: Number(feature?.properties?.value ?? 0)+1, mean: Number(feature?.properties?.value ?? 0), severity: feature?.properties?.severity || classify(Number(feature?.properties?.value ?? 0)), trend: { tau: 0, p_value: '-', sen_slope: 0, trend: 'no trend' } };

    safeKpi.latest = Number(feature?.properties?.value ?? safeKpi.latest ?? 0);
    safeKpi.severity = feature?.properties?.severity || safeKpi.severity || classify(safeKpi.latest);

    renderKPI(safeKpi, featureName, indexName);
    renderChart(normalizeTimeseries(ts, safeKpi.latest), indexName);
  } catch (err) {
    console.error('onRegionClick error:', err);
    setPanelOpen(true);
  }
}

function findSelectedFeatureFromCurrentMap() {
  if (!selectedFeature || !latestMapFeatures.length) return selectedFeature;
  const selectedId = selectedFeature?.properties?.id;
  return latestMapFeatures.find(f => f?.properties?.id === selectedId) || selectedFeature;
}

async function onDateChanged() {
  buildMonthStrip(dateEl.value);
  await loadMap();
  if (panelEl.classList.contains('open') && selectedFeature) {
    await onRegionClick(findSelectedFeatureFromCurrentMap());
  }
}

function setupEvents() {
  document.getElementById('reloadTop').addEventListener('click', onDateChanged);
  indexEl.addEventListener('change', async () => { await onDateChanged(); });
  levelEl.addEventListener('change', onDateChanged);
  dateEl.addEventListener('change', onDateChanged);

  document.getElementById('prevMonth').addEventListener('click', () => { dateEl.value = addMonth(dateEl.value, -1); onDateChanged(); });
  document.getElementById('nextMonth').addEventListener('click', () => { dateEl.value = addMonth(dateEl.value, 1); onDateChanged(); });

  // Fix timeline arrow behavior: shift date and refresh (not just scroll)
  document.getElementById('stripPrev').addEventListener('click', () => { dateEl.value = addMonth(dateEl.value, -1); onDateChanged(); });
  document.getElementById('stripNext').addEventListener('click', () => { dateEl.value = addMonth(dateEl.value, 1); onDateChanged(); });

  closeBtn.addEventListener('click', () => setPanelOpen(false));

  document.getElementById('search').addEventListener('input', (e) => {
    if (!geoLayer) return;
    const q = e.target.value.trim();
    geoLayer.eachLayer((layer) => {
      const hit = !q || layer.feature.properties.name.toLowerCase().includes(q.toLowerCase());
      layer.setStyle({ opacity: hit ? 1 : .2, fillOpacity: hit ? .78 : .1 });
    });
  });
}

addMapLegend();
setupEvents();
buildMonthStrip(dateEl.value);
loadMap();
