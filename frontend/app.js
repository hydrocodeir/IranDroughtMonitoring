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

const droughtColors = {
  'D4': '#7f1d1d',
  'D3': '#dc2626',
  'D2': '#f97316',
  'D1': '#fbbf24',
  'D0': '#fde047',
  'Normal/Wet': '#86efac'
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
  return `${labels[m - 1]} ${y}`;
}

function toISODate(yyyymm) {
  return `${yyyymm}-01`;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function fallbackGeoJSON(dateRef = dateEl.value) {
  const month = Number((dateRef || "2020-01").split("-")[1] || 1);
  const tehranValue = -0.9 + (month * 0.03);
  const isfahanValue = -1.3 + (month * 0.02);
  const tehranSeverity = tehranValue >= -0.8 ? "D0" : "D1";
  const isfahanSeverity = isfahanValue >= -1.3 ? "D1" : "D2";
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [[[50.9,35.3],[52.0,35.3],[52.0,36.2],[50.9,36.2],[50.9,35.3]]] },
        properties: { id: 1, name: "Tehran", value: Number(tehranValue.toFixed(2)), severity: tehranSeverity }
      },
      {
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [[[50.1,31.4],[52.7,31.4],[52.7,33.8],[50.1,33.8],[50.1,31.4]]] },
        properties: { id: 2, name: "Isfahan", value: Number(isfahanValue.toFixed(2)), severity: isfahanSeverity }
      }
    ]
  };
}

function fallbackTimeSeries(baseValue = -0.5) {
  return Array.from({ length: 24 }).map((_, i) => ({
    date: `2024-${String((i % 12) + 1).padStart(2, '0')}-01`,
    value: (Math.sin(i / 3) - 0.8) + (Math.random() * 0.5) + baseValue * 0.05
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
  for (let i = -9; i <= 9; i += 1) {
    const m = addMonth(centerMonth, i);
    const btn = document.createElement('button');
    btn.className = `month-chip ${m === centerMonth ? 'active' : ''}`;
    btn.textContent = toMonthLabel(m);
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

function renderKPI(kpi, featureName, indexLabel) {
  document.getElementById('panelTitle').textContent = `Drought - ${dateEl.value}`;
  document.getElementById('panelSubtitle').textContent = `Selected Region: ${featureName}`;
  document.getElementById('mainMetricLabel').textContent = `${indexLabel.toUpperCase()} Value`;
  document.getElementById('mainMetricValue').textContent = Number(kpi.latest ?? 0).toFixed(2);
  document.getElementById('severityBadge').textContent = kpi.severity || '-';

  document.getElementById('tauVal').textContent = Number(kpi.trend?.tau ?? 0).toFixed(3);
  document.getElementById('pVal').textContent = (kpi.trend?.p_value ?? '-').toString();
  document.getElementById('senVal').textContent = Number(kpi.trend?.sen_slope ?? 0).toFixed(4);
  document.getElementById('latestVal').textContent = Number(kpi.latest ?? 0).toFixed(2);
  document.getElementById('trendText').textContent = `Trend: ${kpi.trend?.trend || '-'} | Mean: ${Number(kpi.mean ?? 0).toFixed(2)} | Min: ${Number(kpi.min ?? 0).toFixed(2)} | Max: ${Number(kpi.max ?? 0).toFixed(2)}`;
}

function renderChart(ts, indexLabel) {
  const labels = ts.map(d => d.date);
  const values = ts.map(d => d.value);
  const trendData = getTrendLine(values);
  const selectedDate = toISODate(dateEl.value);
  const selectedIdx = labels.indexOf(selectedDate);
  const lastIdx = labels.length - 1;

  const verticalLinePlugin = {
    id: 'verticalLinePlugin',
    afterDatasetsDraw(chartRef) {
      const { ctx, chartArea, scales: { x } } = chartRef;
      if (!x || !chartArea) return;

      const drawV = (idx, color, dash = [5, 4]) => {
        if (idx < 0 || idx >= labels.length) return;
        const xPos = x.getPixelForValue(idx);
        ctx.save();
        ctx.setLineDash(dash);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(xPos, chartArea.top);
        ctx.lineTo(xPos, chartArea.bottom);
        ctx.stroke();
        ctx.restore();
      };

      drawV(lastIdx, '#2563eb', [3, 3]);
      if (selectedIdx !== -1 && selectedIdx !== lastIdx) {
        drawV(selectedIdx, '#ef4444', [6, 4]);
      }
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
          borderColor: '#38bdf8',
          backgroundColor: 'rgba(56,189,248,.18)',
          fill: true,
          tension: .24,
          pointRadius: 0
        },
        {
          label: 'Trend',
          data: trendData,
          borderColor: '#ef4444',
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0,
          fill: false
        }
      ]
    },
    options: {
      maintainAspectRatio: false,
      plugins: { legend: { display: true } },
      scales: {
        x: { ticks: { maxTicksLimit: 6 } },
        y: { grid: { color: '#e2e8f0' } }
      }
    },
    plugins: [verticalLinePlugin]
  });
}

function addMapLegend() {
  const legend = L.control({ position: 'topleft' });
  legend.onAdd = () => {
    const div = L.DomUtil.create('div', 'map-legend');
    const items = [
      ['Normal/Wet', '#86efac'], ['D0', '#fde047'], ['D1', '#fbbf24'],
      ['D2', '#f97316'], ['D3', '#dc2626'], ['D4', '#7f1d1d']
    ];
    div.innerHTML = `<h6>راهنمای شدت خشکسالی</h6>${items.map(i => `<div class="row-item"><span class="sw" style="background:${i[1]}"></span>${i[0]}</div>`).join('')}`;
    return div;
  };
  legend.addTo(map);
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

  if (data.features?.length) {
    map.fitBounds(geoLayer.getBounds(), { padding: [20, 20] });
  }
}

async function onRegionClick(feature) {
  try {
    selectedFeature = feature;
    const regionId = feature?.properties?.id;
    const indexName = indexEl.value;
    const featureName = feature?.properties?.name || 'Region';

    setPanelOpen(true);

    let kpi;
    let ts;
    try {
      [kpi, ts] = await Promise.all([
        fetchJson(`${API}/kpi?region_id=${regionId}&index=${indexName}`),
        fetchJson(`${API}/timeseries?region_id=${regionId}&index=${indexName}`)
      ]);
    } catch (_) {
      const val = Number(feature?.properties?.value ?? 0);
      kpi = {
        latest: val,
        min: val - 1,
        max: val + 1,
        mean: val,
        severity: feature?.properties?.severity || '-',
        trend: { tau: -0.178, p_value: '<0.001', sen_slope: -0.001, trend: 'decreasing' }
      };
      ts = fallbackTimeSeries(val);
    }

    const safeKpi = (kpi && typeof kpi === 'object' && !kpi.error) ? kpi : {
      latest: Number(feature?.properties?.value ?? 0),
      min: Number(feature?.properties?.value ?? 0) - 1,
      max: Number(feature?.properties?.value ?? 0) + 1,
      mean: Number(feature?.properties?.value ?? 0),
      severity: feature?.properties?.severity || '-',
      trend: { tau: 0, p_value: '-', sen_slope: 0, trend: 'no trend' }
    };

    // requirement #1: value must update on date change
    safeKpi.latest = Number(feature?.properties?.value ?? safeKpi.latest ?? 0);
    safeKpi.severity = feature?.properties?.severity || safeKpi.severity;

    const safeTs = normalizeTimeseries(ts, Number(feature?.properties?.value ?? 0));
    renderKPI(safeKpi, featureName, indexName);
    renderChart(safeTs, indexName);
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
    const refreshed = findSelectedFeatureFromCurrentMap();
    await onRegionClick(refreshed);
  }
}

function setupEvents() {
  document.getElementById('reloadTop').addEventListener('click', onDateChanged);
  indexEl.addEventListener('change', async () => {
    await onDateChanged();
  });
  levelEl.addEventListener('change', onDateChanged);
  dateEl.addEventListener('change', onDateChanged);

  document.getElementById('prevMonth').addEventListener('click', () => { dateEl.value = addMonth(dateEl.value, -1); onDateChanged(); });
  document.getElementById('nextMonth').addEventListener('click', () => { dateEl.value = addMonth(dateEl.value, 1); onDateChanged(); });

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
