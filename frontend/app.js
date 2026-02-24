const API = "http://localhost:8000";
const map = L.map('map').setView([32.5, 53.6], 5);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(map);
let geoLayer;
let chart;

function colorBySeverity(sev){ return ({'D4':'#6b0d0d','D3':'#d7301f','D2':'#fc8d59','D1':'#fdbb84','D0':'#fee08b','Normal/Wet':'#d9f0a3'})[sev] || '#74add1'; }

async function loadMap(){
  const level = levelEl.value, index = indexEl.value, date = dateEl.value;
  const data = await (await fetch(`${API}/mapdata?level=${level}&index=${index}&date=${date}`)).json();
  if (geoLayer) map.removeLayer(geoLayer);
  geoLayer = L.geoJSON(data, {
    style: f => ({ color:'#444', weight:1, fillOpacity:0.7, fillColor:colorBySeverity(f.properties.severity)}),
    onEachFeature: (f, layer) => {
      layer.bindTooltip(`${f.properties.name}<br>${index}: ${f.properties.value.toFixed(2)}<br>${f.properties.severity}`);
      layer.on('click', () => onRegionClick(f.properties.id));
    }
  }).addTo(map);
}

async function onRegionClick(regionId){
  const index = indexEl.value;
  document.getElementById('kpi-panel').setAttribute('hx-get', `${API}/panel?region_id=${regionId}&index=${index}`);
  document.getElementById('kpi-panel').setAttribute('hx-trigger', 'load');
  htmx.process(document.getElementById('kpi-panel'));

  const ts = await (await fetch(`${API}/timeseries?region_id=${regionId}&index=${index}`)).json();
  const labels = ts.map(d=>d.date); const values = ts.map(d=>d.value);
  if(chart) chart.destroy();
  chart = new Chart(document.getElementById('tsChart'), {type:'line', data:{labels, datasets:[{label:index, data:values, borderColor:'#1d4ed8'}]}});
}

const levelEl = document.getElementById('level');
const indexEl = document.getElementById('index');
const dateEl = document.getElementById('date');
document.getElementById('reload').onclick = loadMap;

document.getElementById('search').addEventListener('input', (e)=>{
  const q = e.target.value.trim();
  geoLayer.eachLayer(l => { if(!q || l.feature.properties.name.includes(q)){ l.setStyle({opacity:1,fillOpacity:.7}); } else { l.setStyle({opacity:.2,fillOpacity:.1}); } });
});

loadMap();
