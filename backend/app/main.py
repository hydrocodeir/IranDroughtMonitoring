from datetime import date, datetime
from html import escape
import logging
from typing import Any, Callable

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from fastapi.responses import HTMLResponse

from .cache import clear_cache, get_or_set_cache
from .datasets_store import (
    fetch_feature_name,
    fetch_features_geojson,
    fetch_meta,
    fetch_overview_counts,
    fetch_regions,
    fetch_precomputed_trend,
    fetch_timeseries_full,
    fetch_trend_stats_all,
    fetch_values_up_to,
    find_effective_month_for_value,
    list_datasets,
)
from .settings import settings
from .utils import drought_class, mann_kendall_and_sen

logging.basicConfig(level=getattr(logging, settings.log_level.upper(), logging.INFO))
logger = logging.getLogger(__name__)

app = FastAPI(title=settings.app_name)

origins = settings.cors_origins_list

app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DATASET_UNAVAILABLE_DETAIL = (
    "Dataset not imported yet. Place files in data/import/ and run: python import_data.py --replace"
)


def api_error(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


# ---------- Shared helpers ----------

def dataset_unavailable_http_exc() -> HTTPException:
    return api_error(503, "dataset_unavailable", DATASET_UNAVAILABLE_DETAIL)


async def run_cached(key: str, builder: Callable[[], Any], ttl_seconds: int) -> Any:
    return await run_in_threadpool(get_or_set_cache, key, builder, ttl_seconds)


def parse_month(month: str | None) -> date | None:
    if not month:
        return None
    try:
        return datetime.strptime(month, "%Y-%m").date().replace(day=1)
    except ValueError:
        return None


def rounded_bbox_key(bbox: str | None) -> str | None:
    if not bbox:
        return None
    try:
        parts = [round(float(p), 3) for p in bbox.split(",")]
        return ",".join(map(str, parts)) if len(parts) == 4 else bbox
    except (TypeError, ValueError):
        return bbox


def trend_payload(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if not row:
        return None
    return {
        "tau": row.get("tau"),
        "p_value": row.get("p_value"),
        "sen_slope": row.get("sen_slope"),
        "trend_category": row.get("trend_category"),
        "trend_label_en": row.get("trend_label_en"),
        "trend_label_fa": row.get("trend_label_fa"),
        "trend_symbol": row.get("trend_symbol"),
    }


def enrich_map_features_with_drought_and_trend(
    features: list[dict[str, Any]],
    index: str,
    trends_by_feature_id: dict[str, dict[str, Any]],
) -> None:
    drought_index = str(index).lower().startswith(("spi", "spei"))
    for feature in features:
        props = feature.setdefault("properties", {})
        value = props.get("value")
        has_value = value is not None

        props["has_value"] = has_value
        if drought_index:
            props["severity"] = drought_class(value) if has_value else "No Data"
        else:
            props["severity"] = "N/A" if has_value else "No Data"

        feature_id = str(props.get("id"))
        payload = trend_payload(trends_by_feature_id.get(feature_id))
        if payload:
            props["trend"] = payload


def empty_regions_or_meta(level: str) -> list[dict[str, str]]:
    return fetch_regions(dataset_key=level)


# ---------- Endpoints ----------


@app.get("/health")
def health():
    return {"status": "ok", "cache": "redis+memory", "storage": "postgis", "env": settings.app_env}


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    detail = exc.detail
    if isinstance(detail, dict) and "code" in detail and "message" in detail:
        payload = detail
    else:
        payload = {"code": f"http_{exc.status_code}", "message": str(detail)}
    payload["path"] = request.url.path
    return JSONResponse(status_code=exc.status_code, content={"error": payload})


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    logger.exception("Unhandled API error", extra={"path": request.url.path})
    return JSONResponse(
        status_code=500,
        content={"error": {"code": "internal_error", "message": "Internal server error", "path": request.url.path}},
    )


@app.post("/admin/cache/invalidate")
async def invalidate_cache(prefix: str | None = Query(default="api:")):
    deleted = await run_in_threadpool(clear_cache, prefix)
    return {"status": "ok", "deleted": deleted, "prefix": prefix}


@app.get("/meta")
async def meta(level: str = Query("station")):
    try:
        return await run_in_threadpool(fetch_meta, level)
    except Exception as exc:
        raise dataset_unavailable_http_exc() from exc


@app.get("/datasets")
async def datasets():
    try:
        return await run_in_threadpool(list_datasets)
    except Exception as exc:
        raise api_error(503, "dataset_registry_unavailable", "Dataset registry not available. Run: python import_data.py --replace") from exc


@app.get("/regions")
async def get_regions(level: str = Query("station")):
    key = f"api:regions:{level}"
    try:
        return await run_cached(key, lambda: empty_regions_or_meta(level), settings.cache_ttl_long_seconds)
    except ValueError as exc:
        raise api_error(400, "invalid_request", str(exc)) from exc
    except Exception as exc:
        raise dataset_unavailable_http_exc() from exc


@app.get("/mapdata")
async def get_mapdata(
    level: str = "station",
    date: str = "2020-01",
    index: str = "spi3",
    bbox: str | None = None,
    limit: int = settings.map_limit_default,
    offset: int = 0,
):
    bbox_key = rounded_bbox_key(bbox)
    limit = max(1, min(limit, settings.map_limit_max))
    key = f"api:map:{level}:{index}:{date}:{bbox_key}:{limit}:{offset}"

    def _builder():
        feature_collection = fetch_features_geojson(
            dataset_key=level,
            index=index,
            yyyymm=date,
            bbox=bbox,
            limit=limit,
            offset=offset,
        )
        trend_cache_key = f"trend_all:{level}:{index}"
        trends = get_or_set_cache(
            trend_cache_key,
            lambda: fetch_trend_stats_all(dataset_key=level, index=index),
            settings.cache_ttl_daily_seconds,
        )
        enrich_map_features_with_drought_and_trend(
            feature_collection.get("features", []),
            index=index,
            trends_by_feature_id=trends,
        )
        return feature_collection

    try:
        return await run_cached(key, _builder, settings.cache_ttl_short_seconds)
    except ValueError as exc:
        raise api_error(400, "invalid_request", str(exc)) from exc
    except Exception as exc:
        raise dataset_unavailable_http_exc() from exc


@app.get("/overview")
async def overview(level: str = "station", index: str = "spi3", date: str = "2020-01"):
    key = f"api:overview:{level}:{index}:{date}"
    try:
        return await run_cached(
            key,
            lambda: fetch_overview_counts(dataset_key=level, index=index, yyyymm=date),
            settings.cache_ttl_short_seconds,
        )
    except ValueError as exc:
        raise api_error(400, "invalid_request", str(exc)) from exc
    except Exception as exc:
        raise dataset_unavailable_http_exc() from exc


@app.get("/timeseries")
async def get_timeseries(
    region_id: str,
    level: str = "station",
    index: str = "spi3",
    start: str | None = None,
    end: str | None = None,
    date: str | None = None,
):
    # start/end/date intentionally kept for backward compatibility.
    _ = (start, end, date)

    key = f"api:ts:{level}:{index}:{region_id}:full"
    try:
        return await run_cached(
            key,
            lambda: fetch_timeseries_full(dataset_key=level, feature_id=region_id, index=index),
            settings.cache_ttl_medium_seconds,
        )
    except ValueError as exc:
        raise api_error(400, "invalid_request", str(exc)) from exc
    except Exception as exc:
        raise dataset_unavailable_http_exc() from exc


@app.get("/kpi")
async def get_kpi(region_id: str, level: str = "station", index: str = "spi3", date: str | None = None):
    key = f"api:kpi:{level}:{index}:{region_id}:{date or 'auto'}"

    def _builder():
        requested = parse_month(date)

        effective_month = requested
        note = None
        if requested is not None:
            effective_month, _effective_value, note = find_effective_month_for_value(
                dataset_key=level,
                feature_id=region_id,
                index=index,
                requested=requested,
            )

        values = fetch_values_up_to(dataset_key=level, feature_id=region_id, index=index, end_date=effective_month)
        if not values:
            return {"error": {"code": "no_series", "message": "No series found"}, "feature": fetch_feature_name(level, region_id)}

        trend = fetch_precomputed_trend(dataset_key=level, index=index, feature_id=region_id)
        if trend is None:
            full_values = fetch_values_up_to(dataset_key=level, feature_id=region_id, index=index, end_date=None)
            trend = mann_kendall_and_sen(full_values)

        latest_val = values[-1]
        return {
            "feature": fetch_feature_name(level, region_id),
            "requested_month": requested.strftime("%Y-%m") if requested else None,
            "effective_month": effective_month.strftime("%Y-%m") if effective_month else None,
            "note": note,
            "min": min(values),
            "max": max(values),
            "mean": sum(values) / len(values),
            "latest": latest_val,
            "severity": drought_class(latest_val) if index.lower().startswith(("spi", "spei")) else "N/A",
            "trend": trend,
        }

    try:
        return await run_cached(key, _builder, settings.cache_ttl_medium_seconds)
    except ValueError as exc:
        raise api_error(400, "invalid_request", str(exc)) from exc
    except Exception as exc:
        raise dataset_unavailable_http_exc() from exc


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
