from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse

from .utils import drought_class, mann_kendall_and_sen
from .user_data import list_regions, map_features, extract_timeseries

app = FastAPI(title="Iran Drought Monitoring API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "data_dirs": {
            "point": "data/user_data/point",
            "polygon": "data/user_data/polygon",
        },
    }


@app.get("/regions")
def get_regions(level: str = Query("province")):
    return list_regions(level)


@app.get("/mapdata")
def get_mapdata(level: str = "province", date: str = "2020-01", index: str = "spi3"):
    features = map_features(level, date, index, drought_class)
    return {"type": "FeatureCollection", "features": features}


@app.get("/timeseries")
def get_timeseries(region_id: str, level: str = "province", index: str = "spi3"):
    return extract_timeseries(region_id, level, index)


@app.get("/kpi")
def get_kpi(region_id: str, level: str = "province", index: str = "spi3"):
    ts = extract_timeseries(region_id, level, index)
    values = [float(r["value"]) for r in ts]
    if not values:
        return {"error": "No series found"}

    trend = mann_kendall_and_sen(values)
    return {
        "min": min(values),
        "max": max(values),
        "mean": sum(values) / len(values),
        "latest": values[-1],
        "severity": drought_class(values[-1]) if index.lower().startswith(("spi", "spei")) else "N/A",
        "trend": trend,
    }


@app.get("/panel", response_class=HTMLResponse)
def panel(region_id: str, level: str = "province", index: str = "spi3"):
    data = get_kpi(region_id, level, index)
    if "error" in data:
        return "<div class='alert alert-warning'>No KPI data</div>"
    return f"""
    <div class='card card-body'>
      <h6>شاخص {index.upper()}</h6>
      <div>آخرین مقدار: <strong>{data['latest']:.2f}</strong></div>
      <div>شدت: <strong>{data['severity']}</strong></div>
      <div>میانگین: {data['mean']:.2f} | کمینه: {data['min']:.2f} | بیشینه: {data['max']:.2f}</div>
      <div>Mann-Kendall τ: {data['trend']['tau']:.3f} | Sen's slope: {data['trend']['sen_slope']:.4f}</div>
    </div>
    """
