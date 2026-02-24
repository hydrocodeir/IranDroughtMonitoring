import json
from datetime import datetime
from fastapi import FastAPI, Depends, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session
from sqlalchemy import func
from apscheduler.schedulers.background import BackgroundScheduler

from .database import get_db
from .models import Region, TimeSeries
from .seed import seed_regions_and_timeseries
from .cache import get_cache, set_cache
from .utils import drought_class, mann_kendall_and_sen
from .tasks import compute_kpi_task

app = FastAPI(title="Iran Drought Monitoring API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def startup_event():
    seed_regions_and_timeseries()
    scheduler = BackgroundScheduler()
    scheduler.add_job(lambda: compute_kpi_task.delay(1, "spi3"), "cron", day=1, hour=0)
    scheduler.start()


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/regions")
def get_regions(level: str = Query("province"), db: Session = Depends(get_db)):
    key = f"regions:{level}"
    if cached := get_cache(key):
        return cached
    rows = db.query(Region.id, Region.name, Region.level).filter(Region.level == level).all()
    payload = [{"id": r.id, "name": r.name, "level": r.level} for r in rows]
    set_cache(key, payload)
    return payload


@app.get("/mapdata")
def get_mapdata(
    level: str = "province",
    date: str = "2020-01",
    index: str = "spi3",
    db: Session = Depends(get_db),
):
    key = f"map:{level}:{date}:{index}"
    if cached := get_cache(key):
        return cached
    target = datetime.strptime(date, "%Y-%m").date().replace(day=1)
    col = getattr(TimeSeries, index)

    rows = (
        db.query(
            Region.id,
            Region.name,
            func.ST_AsGeoJSON(func.ST_SimplifyPreserveTopology(Region.geom, 0.01)).label("geometry"),
            col.label("value"),
        )
        .join(TimeSeries, TimeSeries.region_id == Region.id, isouter=True)
        .filter(Region.level == level)
        .filter((TimeSeries.date == target) | (TimeSeries.date.is_(None)))
        .all()
    )

    features = []
    for r in rows:
        value = float(r.value) if r.value is not None else 0.0
        features.append(
            {
                "type": "Feature",
                "geometry": json.loads(r.geometry),
                "properties": {
                    "id": r.id,
                    "name": r.name,
                    "value": value,
                    "severity": drought_class(value) if index in ["spi3", "spei3"] else "N/A",
                },
            }
        )

    payload = {"type": "FeatureCollection", "features": features}
    set_cache(key, payload)
    return payload


@app.get("/timeseries")
def get_timeseries(region_id: int, index: str = "spi3", db: Session = Depends(get_db)):
    key = f"ts:{region_id}:{index}"
    if cached := get_cache(key):
        return cached
    col = getattr(TimeSeries, index)
    rows = (
        db.query(TimeSeries.date, col.label("value"))
        .filter(TimeSeries.region_id == region_id)
        .order_by(TimeSeries.date)
        .all()
    )
    payload = [{"date": r.date.isoformat(), "value": float(r.value)} for r in rows]
    set_cache(key, payload)
    return payload


@app.get("/kpi")
def get_kpi(
    region_id: int,
    index: str = "spi3",
    async_compute: bool = False,
    db: Session = Depends(get_db),
):
    if async_compute:
        task = compute_kpi_task.delay(region_id, index)
        return {"task_id": task.id, "status": "submitted"}

    key = f"kpi:{region_id}:{index}"
    if cached := get_cache(key):
        return cached
    col = getattr(TimeSeries, index)
    rows = (
        db.query(col.label("value"))
        .filter(TimeSeries.region_id == region_id)
        .order_by(TimeSeries.date)
        .all()
    )
    values = [float(r.value) for r in rows]
    if not values:
        return {"error": "No series found"}
    trend = mann_kendall_and_sen(values)
    payload = {
        "min": min(values),
        "max": max(values),
        "mean": sum(values) / len(values),
        "latest": values[-1],
        "severity": drought_class(values[-1]) if index in ["spi3", "spei3"] else "N/A",
        "trend": trend,
    }
    set_cache(key, payload)
    return payload


@app.get("/panel", response_class=HTMLResponse)
def panel(region_id: int, index: str = "spi3", db: Session = Depends(get_db)):
    data = get_kpi(region_id, index, False, db)
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
