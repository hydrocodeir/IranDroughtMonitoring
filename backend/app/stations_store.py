"""Database-backed data access for station points + time series.

Why this exists
--------------
The original dashboard loaded and indexed large CSV/GeoJSON files in memory on
first request (pandas + Python dicts). That approach scales poorly and blocks
the map request thread.

This module provides *query-based* access to the dataset stored in PostGIS.
All heavy parsing happens once in `import_data.py`.

Performance optimizations
-------------------------
- Bounding-box filtering using PostGIS spatial index (GiST on geom)
- Column validation to safely select the requested SPI/SPEI field
- Pagination (limit/offset)
- "overview" aggregation performed in SQL (no need to load all stations)
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from functools import lru_cache
from typing import Any, Iterable

from sqlalchemy import text

from .database import engine


def _parse_yyyymm(value: str) -> date:
    """Convert 'YYYY-MM' into a DATE (first day of month)."""
    parts = (value or "").strip().split("-")
    if len(parts) != 2:
        raise ValueError("date must be YYYY-MM")
    y, m = int(parts[0]), int(parts[1])
    if m < 1 or m > 12:
        raise ValueError("month must be 1..12")
    return date(y, m, 1)


def _bbox_from_str(bbox: str | None) -> tuple[float, float, float, float] | None:
    if not bbox:
        return None
    parts = [p.strip() for p in bbox.split(",")]
    if len(parts) != 4:
        return None
    minx, miny, maxx, maxy = map(float, parts)
    # basic normalization
    if maxx < minx:
        minx, maxx = maxx, minx
    if maxy < miny:
        miny, maxy = maxy, miny
    return minx, miny, maxx, maxy


@lru_cache(maxsize=1)
def get_available_indices() -> list[str]:
    """Read available SPI/SPEI columns from the DB once and cache in-process."""
    sql = text(
        """
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'station_timeseries'
          AND column_name NOT IN ('station_id', 'date')
        ORDER BY column_name
        """
    )
    with engine.begin() as conn:
        rows = conn.execute(sql).fetchall()
    return [r[0] for r in rows]


def validate_index_name(index: str) -> str:
    idx = (index or "").strip().lower()
    allowed = set(get_available_indices())
    if idx not in allowed:
        # Return a friendly message: clients can fetch /meta for full list.
        raise ValueError(f"Unknown index '{index}'. Available: {', '.join(sorted(list(allowed))[:8])}...")
    return idx


@dataclass(frozen=True)
class StationRow:
    station_id: str
    name: str
    lon: float
    lat: float
    props: dict[str, Any]
    value: float | None


def fetch_meta() -> dict[str, Any]:
    """Global metadata used by the UI (min/max date, available indices, station count)."""
    indices = get_available_indices()
    with engine.begin() as conn:
        min_max = conn.execute(text("SELECT MIN(date), MAX(date) FROM station_timeseries")).fetchone()
        cnt = conn.execute(text("SELECT COUNT(*) FROM stations")).scalar_one()
    min_d, max_d = min_max[0], min_max[1]
    return {
        "station_count": int(cnt or 0),
        "indices": indices,
        "min_month": min_d.strftime("%Y-%m") if min_d else None,
        "max_month": max_d.strftime("%Y-%m") if max_d else None,
    }


def fetch_stations_geojson(
    *,
    index: str,
    yyyymm: str,
    bbox: str | None,
    limit: int = 2000,
    offset: int = 0,
) -> dict[str, Any]:
    """Return a GeoJSON FeatureCollection for the requested bbox.

    The query is *entirely* database-backed. Runtime does not touch CSV/GeoJSON.
    """

    idx = validate_index_name(index)
    month_date = _parse_yyyymm(yyyymm)
    envelope = _bbox_from_str(bbox)

    # NOTE: column name can't be parametrized, so we validate it first and then
    # safely interpolate using double-quotes.
    idx_sql = '"' + idx.replace('"', '') + '"'

    where_bbox = ""
    params: dict[str, Any] = {"target_date": month_date, "limit": int(limit), "offset": int(offset)}
    if envelope:
        minx, miny, maxx, maxy = envelope
        where_bbox = "AND s.geom && ST_MakeEnvelope(:minx, :miny, :maxx, :maxy, 4326)"
        params.update({"minx": minx, "miny": miny, "maxx": maxx, "maxy": maxy})

    # IMPORTANT: keep payload small for fast map loads.
    # We intentionally avoid returning the full JSONB `props` on the map layer.
    sql = text(
        f"""
        SELECT
          s.station_id,
          COALESCE(s.station_name, s.station_id) AS name,
          ST_X(s.geom) AS lon,
          ST_Y(s.geom) AS lat,
          (s.props ->> 'Province') AS province,
          ts.{idx_sql} AS value
        FROM stations s
        LEFT JOIN station_timeseries ts
          ON ts.station_id = s.station_id
         AND ts.date = :target_date
        WHERE 1=1
        {where_bbox}
        ORDER BY s.station_id
        LIMIT :limit OFFSET :offset
        """
    )

    count_sql = None
    if offset == 0:
        count_sql = text(
            f"""
            SELECT COUNT(*)
            FROM stations s
            WHERE 1=1
            {where_bbox}
            """
        )

    with engine.begin() as conn:
        rows = conn.execute(sql, params).fetchall()
        total = conn.execute(count_sql, params).scalar_one() if count_sql is not None else None

    features = []
    for r in rows:
        props = {
            "id": str(r.station_id),
            "name": str(r.name),
            "province": r.province,
            "value": float(r.value) if r.value is not None else None,
        }
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [float(r.lon), float(r.lat)]},
                "properties": props,
            }
        )

    truncated = total is not None and total > (offset + len(features))
    return {
        "type": "FeatureCollection",
        "features": features,
        "meta": {
            "total": int(total) if total is not None else None,
            "returned": len(features),
            "limit": int(limit),
            "offset": int(offset),
            "truncated": bool(truncated),
        },
    }


def fetch_timeseries(*, station_id: str, index: str, start: str | None, end: str | None) -> list[dict[str, Any]]:
    idx = validate_index_name(index)
    idx_sql = '"' + idx.replace('"', '') + '"'

    where = "WHERE station_id = :sid"
    params: dict[str, Any] = {"sid": str(station_id)}
    if start:
        params["start"] = _parse_yyyymm(start)
        where += " AND date >= :start"
    if end:
        params["end"] = _parse_yyyymm(end)
        where += " AND date <= :end"

    sql = text(
        f"""
        SELECT date, {idx_sql} AS value
        FROM station_timeseries
        {where}
        ORDER BY date
        """
    )

    with engine.begin() as conn:
        rows = conn.execute(sql, params).fetchall()

    out: list[dict[str, Any]] = []
    for r in rows:
        if r.value is None:
            continue
        out.append({"date": r.date.isoformat(), "value": float(r.value)})
    return out


def fetch_overview_counts(*, index: str, yyyymm: str) -> dict[str, Any]:
    """Server-side aggregation used by the overview chart.

    This avoids shipping all stations to the client just to compute counts.
    """

    idx = validate_index_name(index)
    idx_sql = '"' + idx.replace('"', '') + '"'
    month_date = _parse_yyyymm(yyyymm)

    # Mimic `drought_class()` thresholds in SQL.
    sql = text(
        f"""
        WITH v AS (
          SELECT ts.{idx_sql} AS val
          FROM station_timeseries ts
          WHERE ts.date = :target_date
        )
        SELECT
          COUNT(*) FILTER (WHERE val IS NOT NULL) AS with_value,
          COUNT(*) FILTER (WHERE val IS NULL) AS missing,
          COUNT(*) FILTER (WHERE val >= 0) AS normal_wet,
          COUNT(*) FILTER (WHERE val < 0 AND val >= -0.8) AS d0,
          COUNT(*) FILTER (WHERE val < -0.8 AND val >= -1.3) AS d1,
          COUNT(*) FILTER (WHERE val < -1.3 AND val >= -1.6) AS d2,
          COUNT(*) FILTER (WHERE val < -1.6 AND val >= -2.0) AS d3,
          COUNT(*) FILTER (WHERE val < -2.0) AS d4
        FROM v;
        """
    )

    with engine.begin() as conn:
        row = conn.execute(sql, {"target_date": month_date}).fetchone()

    return {
        "with_value": int(row.with_value or 0),
        "missing": int(row.missing or 0),
        "counts": {
            "Normal/Wet": int(row.normal_wet or 0),
            "D0": int(row.d0 or 0),
            "D1": int(row.d1 or 0),
            "D2": int(row.d2 or 0),
            "D3": int(row.d3 or 0),
            "D4": int(row.d4 or 0),
        },
    }
