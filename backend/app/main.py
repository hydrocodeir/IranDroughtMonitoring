from datetime import datetime
from html import escape

from fastapi import FastAPI, Query, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import HTMLResponse

from .cache import get_or_set_cache
from .utils import drought_class, mann_kendall_and_sen
from .datasets_store import (
    list_datasets,
    fetch_meta,
    fetch_overview_counts,
    fetch_features_geojson,
    fetch_timeseries_full,
    find_effective_month_for_value,
    fetch_values_up_to,
    fetch_feature_name,
    fetch_trend_stats_all,
)

app = FastAPI(title="Iran Drought Monitoring API")

# GZip helps when map responses grow (GeoJSON can be large).
app.add_middleware(GZipMiddleware, minimum_size=1000)

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
        "storage": "postgis",
    }


@app.get("/meta")
async def meta(level: str = Query("station")):
    """Lightweight metadata endpoint used on UI startup.

    This replaces reading CSV/GeoJSON files in the running application.
    """
    try:
        return await run_in_threadpool(fetch_meta, level)
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail="Dataset not imported yet. Place files in data/import/ and run: python import_data.py --replace",
        ) from exc


@app.get("/datasets")
async def datasets():
    """List imported dataset layers."""
    try:
        return await run_in_threadpool(list_datasets)
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail="Dataset registry not available. Run: python import_data.py --replace",
        ) from exc


@app.get("/regions")
async def get_regions(level: str = Query("station")):
    """Backwards-compatible endpoint.

    For the redesigned station-only dataset, the UI no longer needs to fetch the
    full region list. This endpoint is kept for compatibility.
    """
    # Deprecated endpoint kept for compatibility with older frontends.
    key = f"regions:{level}"

    def _builder():
        meta = fetch_meta(level)
        if not meta.get("indices") or not meta.get("max_month"):
            return []
        data = fetch_features_geojson(
            dataset_key=level,
            index=meta["indices"][0],
            yyyymm=meta["max_month"],
            bbox=None,
            limit=200000,
            offset=0,
        )
        return [
            {"id": f["properties"]["id"], "name": f["properties"]["name"], "level": level}
            for f in data.get("features", [])
        ]

    try:
        return await run_in_threadpool(get_or_set_cache, key, _builder, 1800)
    except Exception:
        return []


@app.get("/mapdata")
async def get_mapdata(
    level: str = "station",
    date: str = "2020-01",
    index: str = "spi3",
    bbox: str | None = None,
    limit: int = 2000,
    offset: int = 0,
):
    """Map layer endpoint.

    Key redesign:
    - The server *never* reads CSV/GeoJSON at runtime.
    - The client requests only the visible map area via `bbox=`.
    """

    # Cache key rounds bbox to reduce cache fragmentation during panning.
    bbox_key = None
    if bbox:
        try:
            parts = [round(float(p), 3) for p in bbox.split(",")]
            bbox_key = ",".join(map(str, parts)) if len(parts) == 4 else bbox
        except Exception:
            bbox_key = bbox
    key = f"map:{level}:{index}:{date}:{bbox_key}:{limit}:{offset}"

    def _builder():
        fc = fetch_features_geojson(dataset_key=level, index=index, yyyymm=date, bbox=bbox, limit=limit, offset=offset)

        # Full-history trend statistics must be stable and independent of the selected date.
        trend_key = f"trend_all:{level}:{index}"
        trends = get_or_set_cache(trend_key, lambda: fetch_trend_stats_all(dataset_key=level, index=index), 24 * 3600)

        # Add severity server-side (cheap) so the client only styles.
        for f in fc.get("features", []):
            val = f.get("properties", {}).get("value")
            f["properties"]["has_value"] = val is not None
            f["properties"]["severity"] = drought_class(val) if val is not None and str(index).lower().startswith(("spi", "spei")) else ("No Data" if val is None else "N/A")

            fid = str(f.get("properties", {}).get("id"))
            t = trends.get(fid)
            if t:
                # Keep payload small: include trend stats + classification.
                f["properties"]["trend"] = {
                    "tau": t.get("tau"),
                    "p_value": t.get("p_value"),
                    "sen_slope": t.get("sen_slope"),
                    "trend_category": t.get("trend_category"),
                    "trend_label_en": t.get("trend_label_en"),
                    "trend_label_fa": t.get("trend_label_fa"),
                    "trend_symbol": t.get("trend_symbol"),
                }
        return fc

    try:
        return await run_in_threadpool(get_or_set_cache, key, _builder, 300)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail="Dataset not imported yet. Place files in data/import/ and run: python import_data.py --replace",
        ) from exc


@app.get("/overview")
async def overview(level: str = "station", index: str = "spi3", date: str = "2020-01"):
    """Server-side aggregation used by the overview chart."""
    key = f"overview:{level}:{index}:{date}"
    try:
        return await run_in_threadpool(
            get_or_set_cache,
            key,
            lambda: fetch_overview_counts(dataset_key=level, index=index, yyyymm=date),
            300,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail="Dataset not imported yet. Place files in data/import/ and run: python import_data.py --replace",
        ) from exc


@app.get("/timeseries")
async def get_timeseries(
    region_id: str,
    level: str = "station",
    index: str = "spi3",
    start: str | None = None,
    end: str | None = None,
    date: str | None = None,
):
    """Time-series endpoint.

    New parameters: start/end (YYYY-MM) for date-range loading.
    Backwards-compat: `date=` behaves as "up to this month".
    """
    # New: always return the *full* feature series (continuous months with nulls).
    # start/end/date are accepted for backward compatibility but ignored here.
    key = f"ts:{level}:{index}:{region_id}:full"
    try:
        return await run_in_threadpool(
            get_or_set_cache,
            key,
            lambda: fetch_timeseries_full(dataset_key=level, feature_id=region_id, index=index),
            900,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail="Dataset not imported yet. Place files in data/import/ and run: python import_data.py --replace",
        ) from exc


@app.get("/kpi")
async def get_kpi(region_id: str, level: str = "station", index: str = "spi3", date: str | None = None):
    base_key = f"kpi:{level}:{index}:{region_id}:{date or 'auto'}"

    def _builder():
        requested = None
        if date:
            try:
                requested = datetime.strptime(date, "%Y-%m").date().replace(day=1)
            except Exception:
                requested = None

        eff_date = requested
        note = None
        if requested is not None:
            eff_date, _eff_val, note = find_effective_month_for_value(
                dataset_key=level, feature_id=region_id, index=index, requested=requested
            )

        # KPI window (date slider) controls displayed values and summary stats.
        values = fetch_values_up_to(dataset_key=level, feature_id=region_id, index=index, end_date=eff_date)
        if not values:
            return {"error": "No series found", "feature": fetch_feature_name(level, region_id)}

        # Critical: trend statistics must be computed ONCE from the FULL historical series
        # and must remain fixed regardless of the selected date range.
        full_values = fetch_values_up_to(dataset_key=level, feature_id=region_id, index=index, end_date=None)
        trend = mann_kendall_and_sen(full_values)
        latest_val = values[-1]
        return {
            "feature": fetch_feature_name(level, region_id),
            "requested_month": requested.strftime("%Y-%m") if requested else None,
            "effective_month": eff_date.strftime("%Y-%m") if eff_date else None,
            "note": note,
            "min": min(values),
            "max": max(values),
            "mean": sum(values) / len(values),
            "latest": latest_val,
            "severity": drought_class(latest_val) if index.lower().startswith(("spi", "spei")) else "N/A",
            "trend": trend,
        }

    try:
        return await run_in_threadpool(get_or_set_cache, base_key, _builder, 600)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail="Dataset not imported yet. Place files in data/import/ and run: python import_data.py --replace",
        ) from exc


@app.get("/panel", response_class=HTMLResponse)
async def panel(region_id: str, level: str = "station", index: str = "spi3"):
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
async def panel_fragment(region_id: str, level: str = "station", index: str = "spi3", date: str | None = None):
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
