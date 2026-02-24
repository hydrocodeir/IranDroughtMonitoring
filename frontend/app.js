const API = "http://localhost:8000";
const map = L.map('map', { zoomControl: false }).setView([32.5, 53.6], 5);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(map);

let geoLayer;
let chart;
let selectedFeature = null;

const levelEl = document.getElementById('level');
const indexEl = document.getElementById('index');
const dateEl = document.getElementById('date');
const panelEl = document.getElementById('insightPanel');
const closeBtn = document.getElementById('closePanel');

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

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function fallbackGeoJSON() {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [[[50.9,35.3],[52.0,35.3],[52.0,36.2],[50.9,36.2],[50.9,35.3]]] },
        properties: { id: 1, name: 'Tehran', value: -0.79, severity: 'D0' }
      },
      {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [[[50.1,31.4],[52.7,31.4],[52.7,33.8],[50.1,33.8],[50.1,31.4]]] },
        properties: { id: 2, name: 'Isfahan', value: -1.2, severity: 'D1' }
      }
    ]
  };
}

async function loadMap() {
  const level = levelEl.value;
  const index = indexEl.value;
  const date = dateEl.value;
  let data;

  try {
    data = await fetchJson(`${API}/mapdata?level=${level}&index=${index}&date=${date}`);
  } catch (_) {
    data = fallbackGeoJSON();
  }

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

function setPanelOpen(open) {
  panelEl.classList.toggle('open', open);
  panelEl.setAttribute('aria-hidden', String(!open));
  closeBtn.classList.toggle('d-none', !open);
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
  if (chart) chart.destroy();

  chart = new Chart(document.getElementById('tsChart'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: indexLabel.toUpperCase(),
        data: values,
        borderColor: '#38bdf8',
        backgroundColor: 'rgba(56,189,248,.2)',
        fill: true,
        tension: .24,
        pointRadius: 0
      }]
    },
    options: {
      maintainAspectRatio: false,
      plugins: { legend: { display: true } },
      scales: {
        x: { ticks: { maxTicksLimit: 6 } },
        y: { grid: { color: '#e2e8f0' } }
      }
    }
  });
}

async function onRegionClick(feature) {
  selectedFeature = feature;
  const regionId = feature.properties.id;
  const indexName = indexEl.value;

  let kpi;
  let ts;
  try {
    [kpi, ts] = await Promise.all([
      fetchJson(`${API}/kpi?region_id=${regionId}&index=${indexName}`),
      fetchJson(`${API}/timeseries?region_id=${regionId}&index=${indexName}`)
    ]);
  } catch (_) {
    const val = Number(feature.properties.value ?? 0);
    kpi = {
      latest: val,
      min: val - 1,
      max: val + 1,
      mean: val,
      severity: feature.properties.severity || '-',
      trend: { tau: -0.178, p_value: '<0.001', sen_slope: -0.001, trend: 'decreasing' }
    };
    ts = Array.from({ length: 24 }).map((_, i) => ({ date: `2024-${String((i % 12) + 1).padStart(2, '0')}-01`, value: (Math.sin(i / 3) - 0.8) + (Math.random() * 0.5) }));
  }

  renderKPI(kpi, feature.properties.name, indexName);
  renderChart(ts, indexName);
  setPanelOpen(true);
}

function setupEvents() {
  document.getElementById('reloadTop').addEventListener('click', loadMap);
  indexEl.addEventListener('change', () => {
    loadMap();
    if (selectedFeature) onRegionClick(selectedFeature);
  });
  levelEl.addEventListener('change', loadMap);
  dateEl.addEventListener('change', loadMap);

  document.getElementById('prevMonth').addEventListener('click', () => { dateEl.value = addMonth(dateEl.value, -1); loadMap(); });
  document.getElementById('nextMonth').addEventListener('click', () => { dateEl.value = addMonth(dateEl.value, 1); loadMap(); });

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

setupEvents();
loadMap();
