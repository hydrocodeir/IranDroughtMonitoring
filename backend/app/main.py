from datetime import datetime
from html import escape

from fastapi import FastAPI, Query
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse

from .cache import get_or_set_cache
from .utils import drought_class, mann_kendall_and_sen
from .user_data import extract_timeseries, list_regions, map_features

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
        "cache": "redis+memory",
        "data_dirs": {
            "point": "data/user_data/point",
            "polygon": "data/user_data/polygon",
        },
    }


@app.get("/regions")
async def get_regions(level: str = Query("province")):
    key = f"regions:{level}"
    return await run_in_threadpool(get_or_set_cache, key, lambda: list_regions(level), 1800)


@app.get("/mapdata")
async def get_mapdata(level: str = "province", date: str = "2020-01", index: str = "spi3"):
    key = f"map:{level}:{index}:{date}"
    features = await run_in_threadpool(get_or_set_cache, key, lambda: map_features(level, date, index, drought_class), 600)
    return {"type": "FeatureCollection", "features": features}


@app.get("/timeseries")
async def get_timeseries(region_id: str, level: str = "province", index: str = "spi3", date: str | None = None):
    key = f"ts:{level}:{index}:{region_id}:{date or 'all'}"

    def _builder():
        rows = extract_timeseries(region_id, level, index)
        if not date:
            return rows
        try:
            target_key = datetime.strptime(date, "%Y-%m").strftime("%Y-%m")
            return [r for r in rows if datetime.fromisoformat(r["date"]).strftime("%Y-%m") <= target_key]
        except Exception:
            return rows

    return await run_in_threadpool(get_or_set_cache, key, _builder, 900)


@app.get("/kpi")
async def get_kpi(region_id: str, level: str = "province", index: str = "spi3", date: str | None = None):
    base_key = f"kpi:{level}:{index}:{region_id}:all"

    def _builder():
        ts = extract_timeseries(region_id, level, index)
        if not ts:
            return {"error": "No series found"}

        values = [float(r["value"]) for r in ts]
        if not values:
            return {"error": "No series found"}

        trend = mann_kendall_and_sen(values)
        latest_val = values[-1]
        return {
            "min": min(values),
            "max": max(values),
            "mean": sum(values) / len(values),
            "latest": latest_val,
            "severity": drought_class(latest_val) if index.lower().startswith(("spi", "spei")) else "N/A",
            "trend": trend,
        }

    return await run_in_threadpool(get_or_set_cache, base_key, _builder, 600)


@app.get("/panel", response_class=HTMLResponse)
async def panel(region_id: str, level: str = "province", index: str = "spi3"):
    data = await get_kpi(region_id, level, index)
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


@app.get("/panel-fragment", response_class=HTMLResponse)
async def panel_fragment(region_id: str, level: str = "province", index: str = "spi3", date: str | None = None):
    data = await get_kpi(region_id, level, index, date)
    if "error" in data:
        return "<div class='alert alert-warning m-0'>No KPI data</div>"

    trend = data.get("trend", {})
    return f"""
    <div class=\"kpi-card\"><small>ضریب کندال (τ)</small><strong id=\"tauVal\">{trend.get('tau', 0):.4f}</strong></div>
    <div class=\"kpi-card\"><small>مقدار p</small><strong id=\"pVal\">{escape(str(trend.get('p_value', '-')))}</strong></div>
    <div class=\"kpi-card\"><small>شیب سن</small><strong id=\"senVal\">{trend.get('sen_slope', 0):.4f}</strong></div>
    <div class=\"kpi-card\"><small>مقدار</small><strong id=\"latestVal\">{data.get('latest', 0):.4f}</strong></div>
    """
