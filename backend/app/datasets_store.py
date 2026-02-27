"""Database-backed access layer for *multi-layer* drought datasets.

This module is the heart of the performance redesign.

Key ideas
---------
1) **No CSV/GeoJSON at runtime**
   The running API never reads `data.csv` or `geoinfo.geojson`. Those files are
   import-only inputs handled by `import_data.py`.

2) **Multi-layer datasets**
   Each imported layer (stations, provinces, counties, ...) has:
     - one row in `datasets`
     - many rows in `features`
     - one *wide* time-series table `ts_<dataset_key>` created from the CSV header

3) **Fast map loading**
   `/mapdata` uses:
     - bounding box filtering (ST_MakeEnvelope) + GiST index on `features.geom`
     - pagination (limit/offset)
     - server-side join for just the requested date

4) **Different time ranges per feature**
   Each feature stores `min_date`/`max_date` (computed during import).
   Time series queries return a *continuous* monthly series (missing months
   are returned with `value: null`), which keeps chart axes stable.

Security
--------
Dataset keys and index column names must not become SQL injection vectors.
We therefore:
  - validate dataset_key with a strict regex
  - validate index name against information_schema columns for `ts_<key>`

"""

from __future__ import annotations

import re
from datetime import date
from functools import lru_cache
from typing import Any, Iterable

from sqlalchemy import text

from .database import engine
from .utils import mann_kendall_and_sen

_DATASET_KEY_RE = re.compile(r"^[A-Za-z0-9_]+$")


def _validate_dataset_key(value: str) -> str:
    """Validate a dataset key.

    Why this is careful
    -------------------
    Dataset keys appear in:
      - URLs (`level=<dataset_key>`)
      - dynamically created table names (`ts_<dataset_key>`)

    PostgreSQL folds **unquoted identifiers** to lower-case. That means if a
    user imports a folder named `Station`, the SQL table `ts_Station` actually
    becomes `ts_station`.

    Meanwhile, `datasets.dataset_key` is TEXT and therefore case-sensitive.
    The UI might send `Station` (as selected) while the server expects
    `station` for table lookups.

    To make the app robust, we:
      1) validate strictly (letters/numbers/underscore)
      2) resolve dataset rows case-insensitively (`lower(dataset_key)`)
      3) always build ts table names from a canonical lower-case key
    """

    key = (value or "").strip()
    if not key or not _DATASET_KEY_RE.match(key):
        raise ValueError("Invalid dataset key")
    return key


def _canonical_dataset_key(value: str) -> str:
    """Canonical form used for table names and caches."""
    return _validate_dataset_key(value).lower()


@lru_cache(maxsize=256)
def resolve_dataset_key(value: str) -> str:
    """Resolve an incoming key to the stored datasets.dataset_key.

    This makes API calls tolerant to case differences ("station" vs "Station").
    """
    raw = _validate_dataset_key(value)
    canon = raw.lower()
    with engine.begin() as conn:
        row = conn.execute(
            text(
                """
                SELECT dataset_key
                FROM datasets
                WHERE lower(dataset_key) = :k
                LIMIT 1
                """
            ),
            {"k": canon},
        ).fetchone()
    if not row:
        raise ValueError("Dataset not found")
    return str(row.dataset_key)


def _ts_table(dataset_key: str) -> str:
    # Table names are identifiers. PostgreSQL folds unquoted identifiers
    # to lower-case, so `ts_Station` becomes `ts_station`.
    # We therefore always build ts table names using a canonical lower-case key.
    key = _canonical_dataset_key(dataset_key)
    return f"ts_{key}"


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
    if maxx < minx:
        minx, maxx = maxx, minx
    if maxy < miny:
        miny, maxy = maxy, miny
    return minx, miny, maxx, maxy


@lru_cache(maxsize=128)
def get_available_indices(dataset_key: str) -> list[str]:
    """Return SPI/SPEI (and other numeric) columns for a dataset's ts table."""
    # Canonicalize to avoid duplicate cache entries (e.g. Station vs station).
    dataset_key = _canonical_dataset_key(dataset_key)
    table = _ts_table(dataset_key)
    sql = text(
        """
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = :t
          AND column_name NOT IN ('feature_id', 'date')
        ORDER BY column_name
        """
    )
    with engine.begin() as conn:
        rows = conn.execute(sql, {"t": table}).fetchall()
    return [r[0] for r in rows]


def validate_index_name(dataset_key: str, index: str) -> str:
    idx = (index or "").strip().lower()
    allowed = set(get_available_indices(_canonical_dataset_key(dataset_key)))
    if idx not in allowed:
        raise ValueError(
            f"Unknown index '{index}'. Available: {', '.join(sorted(list(allowed))[:12])}{'...' if len(allowed) > 12 else ''}"
        )
    return idx


def list_datasets() -> list[dict[str, Any]]:
    """List dataset layers imported into PostGIS."""
    sql = text(
        """
        SELECT dataset_key, COALESCE(title, dataset_key) AS title, geom_type,
               min_date, max_date
        FROM datasets
        ORDER BY dataset_key
        """
    )
    with engine.begin() as conn:
        rows = conn.execute(sql).fetchall()
    out = []
    for r in rows:
        out.append(
            {
                "key": r.dataset_key,
                "title": r.title,
                "geom_type": r.geom_type,
                "min_month": r.min_date.strftime("%Y-%m") if r.min_date else None,
                "max_month": r.max_date.strftime("%Y-%m") if r.max_date else None,
            }
        )
    return out


def fetch_meta(level: str) -> dict[str, Any]:
    """Lightweight metadata for UI initialization."""
    # Case-insensitive dataset selection: the UI may send `Station` while the
    # stored key is `station` (or vice versa).
    stored_key = resolve_dataset_key(level)
    idxs = get_available_indices(_canonical_dataset_key(level))

    with engine.begin() as conn:
        ds = conn.execute(
            text(
                """
                SELECT dataset_key, COALESCE(title, dataset_key) AS title, geom_type, min_date, max_date
                FROM datasets
                WHERE dataset_key = :k
                """
            ),
            {"k": stored_key},
        ).fetchone()
        if not ds:
            raise ValueError("Dataset not found")
        cnt = conn.execute(
            text("SELECT COUNT(*) FROM features WHERE dataset_key = :k"), {"k": stored_key}
        ).scalar_one()

    return {
        "dataset_key": ds.dataset_key,
        "title": ds.title,
        "geom_type": ds.geom_type,
        "feature_count": int(cnt or 0),
        "indices": idxs,
        "min_month": ds.min_date.strftime("%Y-%m") if ds.min_date else None,
        "max_month": ds.max_date.strftime("%Y-%m") if ds.max_date else None,
    }


def fetch_feature_name(dataset_key: str, feature_id: str) -> str:
    key = resolve_dataset_key(dataset_key)
    with engine.begin() as conn:
        row = conn.execute(
            text(
                """
                SELECT COALESCE(name, feature_id) AS name
                FROM features
                WHERE dataset_key = :k AND feature_id = :fid
                """
            ),
            {"k": key, "fid": str(feature_id)},
        ).fetchone()
    return str(row.name) if row else str(feature_id)


def fetch_features_geojson(
    *,
    dataset_key: str,
    index: str,
    yyyymm: str,
    bbox: str | None,
    limit: int = 2000,
    offset: int = 0,
) -> dict[str, Any]:
    """Return a GeoJSON FeatureCollection for the requested map viewport."""

    # Use the stored key for filtering `features.dataset_key`, but use the
    # canonical (lower-case) key for the time-series table name.
    key = resolve_dataset_key(dataset_key)
    idx = validate_index_name(dataset_key, index)
    idx_sql = '"' + idx.replace('"', '') + '"'
    month_date = _parse_yyyymm(yyyymm)
    envelope = _bbox_from_str(bbox)

    ts = _ts_table(dataset_key)

    where_bbox = ""
    params: dict[str, Any] = {
        "k": key,
        "target_date": month_date,
        "limit": int(limit),
        "offset": int(offset),
    }
    if envelope:
        minx, miny, maxx, maxy = envelope
        where_bbox = "AND f.geom && ST_MakeEnvelope(:minx, :miny, :maxx, :maxy, 4326)"
        params.update({"minx": minx, "miny": miny, "maxx": maxx, "maxy": maxy})

    # NOTE: We intentionally keep properties small for fast map loads.
    # If you need more, fetch it via a dedicated endpoint.
    sql = text(
        f"""
        SELECT
          f.feature_id,
          COALESCE(f.name, f.feature_id) AS name,
          ST_AsGeoJSON(f.geom, 6) AS geom_json,
          (f.props ->> 'Province') AS province,
          ts.{idx_sql} AS value
        FROM features f
        LEFT JOIN {ts} ts
          ON ts.feature_id = f.feature_id
         AND ts.date = :target_date
        WHERE f.dataset_key = :k
        {where_bbox}
        ORDER BY f.feature_id
        LIMIT :limit OFFSET :offset
        """
    )

    count_sql = None
    if offset == 0:
        count_sql = text(
            f"""
            SELECT COUNT(*)
            FROM features f
            WHERE f.dataset_key = :k
            {where_bbox}
            """
        )

    with engine.begin() as conn:
        rows = conn.execute(sql, params).fetchall()
        total = conn.execute(count_sql, params).scalar_one() if count_sql is not None else None

    features: list[dict[str, Any]] = []
    import json

    for r in rows:
        geom = json.loads(r.geom_json) if r.geom_json else None
        props = {
            "id": str(r.feature_id),
            "name": str(r.name),
            "province": r.province,
            "value": float(r.value) if r.value is not None else None,
        }
        features.append({"type": "Feature", "geometry": geom, "properties": props})

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


def fetch_overview_counts(*, dataset_key: str, index: str, yyyymm: str) -> dict[str, Any]:
    """Server-side aggregation for overview dashboard cards."""

    # Ensure dataset exists (case-insensitive), and build the ts table name
    # from the canonical lower-case key.
    _ = resolve_dataset_key(dataset_key)
    idx = validate_index_name(dataset_key, index)
    idx_sql = '"' + idx.replace('"', '') + '"'
    month_date = _parse_yyyymm(yyyymm)
    ts = _ts_table(dataset_key)

    # Thresholds mirror frontend classify() and utils.drought_class().
    sql = text(
        f"""
        WITH v AS (
          SELECT {idx_sql} AS val
          FROM {ts}
          WHERE date = :target_date
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
        "date": yyyymm,
        "index": idx,
        "with_value": int(row.with_value or 0),
        "missing": int(row.missing or 0),
        "Normal/Wet": int(row.normal_wet or 0),
        "D0": int(row.d0 or 0),
        "D1": int(row.d1 or 0),
        "D2": int(row.d2 or 0),
        "D3": int(row.d3 or 0),
        "D4": int(row.d4 or 0),
    }


def _index_min_max_date(dataset_key: str, feature_id: str, index: str) -> tuple[date | None, date | None]:
    """Compute per-index bounds for a feature (ignoring nulls)."""
    _ = resolve_dataset_key(dataset_key)
    idx = validate_index_name(dataset_key, index)
    idx_sql = '"' + idx.replace('"', '') + '"'
    ts = _ts_table(dataset_key)

    sql = text(
        f"""
        SELECT MIN(date) AS min_d, MAX(date) AS max_d
        FROM {ts}
        WHERE feature_id = :fid AND {idx_sql} IS NOT NULL
        """
    )
    with engine.begin() as conn:
        row = conn.execute(sql, {"fid": str(feature_id)}).fetchone()
    return row.min_d, row.max_d


def fetch_timeseries_full(*, dataset_key: str, feature_id: str, index: str) -> dict[str, Any]:
    """Return the full (continuous) monthly time series for a feature.

    Missing months are represented with value=null.

    Returns:
      - min_month/max_month in YYYY-MM (for the panel slider bounds)
      - data[] with ISO dates (YYYY-MM-01)
    """

    key = resolve_dataset_key(dataset_key)
    idx = validate_index_name(dataset_key, index)
    idx_sql = '"' + idx.replace('"', '') + '"'
    ts = _ts_table(dataset_key)

    min_d, max_d = _index_min_max_date(dataset_key, feature_id, idx)
    if not min_d or not max_d:
        return {"feature": fetch_feature_name(key, feature_id), "min_month": None, "max_month": None, "data": []}

    # NOTE (PostgreSQL + SQLAlchemy): avoid the PostgreSQL shorthand cast operator
    #   "::date" inside `text()` because the colon can be mis-parsed as a bind
    #   parameter by SQLAlchemy's `text()` parser (e.g. it may interpret "::date"
    #   as a bind named ":date").
    # We use CAST(...) instead, which is unambiguous and fixes the
    #   "syntax error at or near ':'" seen in server logs.
    sql = text(
        f"""
        WITH months AS (
          SELECT CAST(
            generate_series(
              CAST(:min_d AS date),
              CAST(:max_d AS date),
              interval '1 month'
            ) AS date
          ) AS d
        )
        SELECT m.d AS date, t.{idx_sql} AS value
        FROM months m
        LEFT JOIN {ts} t
          ON t.feature_id = :fid AND t.date = m.d
        ORDER BY m.d;
        """
    )

    with engine.begin() as conn:
        rows = conn.execute(sql, {"min_d": min_d, "max_d": max_d, "fid": str(feature_id)}).fetchall()

    data = [{"date": r.date.isoformat(), "value": (float(r.value) if r.value is not None else None)} for r in rows]

    return {
        "feature": fetch_feature_name(key, feature_id),
        "min_month": min_d.strftime("%Y-%m"),
        "max_month": max_d.strftime("%Y-%m"),
        "data": data,
    }


def find_effective_month_for_value(
    *,
    dataset_key: str,
    feature_id: str,
    index: str,
    requested: date,
) -> tuple[date, float | None, str | None]:
    """Resolve a requested month to a month that actually has a value.

    This is used to prevent:
      - empty KPIs when the requested month is outside the feature's coverage
      - empty KPIs when the month exists but the index is NULL for that feature

    Policy (kept simple and predictable):
      1) If requested is outside [min,max] -> clamp to nearest bound.
      2) If requested has value -> use it.
      3) Else, try nearest previous month with value.
      4) Else, try nearest next month with value.

    Returns (effective_date, value, note).
    """

    key = resolve_dataset_key(dataset_key)
    idx = validate_index_name(dataset_key, index)
    idx_sql = '"' + idx.replace('"', '') + '"'
    ts = _ts_table(dataset_key)

    min_d, max_d = _index_min_max_date(dataset_key, feature_id, idx)
    if not min_d or not max_d:
        return requested, None, "no-data"

    eff = requested
    note = None
    if requested < min_d:
        eff = min_d
        note = "clamped-to-start"
    elif requested > max_d:
        eff = max_d
        note = "clamped-to-end"

    with engine.begin() as conn:
        exact = conn.execute(
            text(f"SELECT {idx_sql} AS v FROM {ts} WHERE feature_id=:fid AND date=:d"),
            {"fid": str(feature_id), "d": eff},
        ).fetchone()
        if exact and exact.v is not None:
            return eff, float(exact.v), note

        prev = conn.execute(
            text(
                f"""
                SELECT date, {idx_sql} AS v
                FROM {ts}
                WHERE feature_id=:fid AND date<=:d AND {idx_sql} IS NOT NULL
                ORDER BY date DESC
                LIMIT 1
                """
            ),
            {"fid": str(feature_id), "d": eff},
        ).fetchone()
        if prev:
            return prev.date, float(prev.v), (note or "") + ("" if note is None else ";") + "nearest-previous"

        nxt = conn.execute(
            text(
                f"""
                SELECT date, {idx_sql} AS v
                FROM {ts}
                WHERE feature_id=:fid AND date>:d AND {idx_sql} IS NOT NULL
                ORDER BY date ASC
                LIMIT 1
                """
            ),
            {"fid": str(feature_id), "d": eff},
        ).fetchone()
        if nxt:
            return nxt.date, float(nxt.v), (note or "") + ("" if note is None else ";") + "nearest-next"

    return eff, None, (note or "") + ("" if note is None else ";") + "no-value"


def fetch_values_up_to(
    *,
    dataset_key: str,
    feature_id: str,
    index: str,
    end_date: date | None,
) -> list[float]:
    """Return numeric values up to end_date (inclusive), ignoring NULLs.

    Used for Mann-Kendall + Sen slope trend computation.
    """

    _ = resolve_dataset_key(dataset_key)
    idx = validate_index_name(dataset_key, index)
    idx_sql = '"' + idx.replace('"', '') + '"'
    ts = _ts_table(dataset_key)

    where_end = ""
    params: dict[str, Any] = {"fid": str(feature_id)}
    if end_date is not None:
        where_end = "AND date <= :end_d"
        params["end_d"] = end_date

    sql = text(
        f"""
        SELECT {idx_sql} AS v
        FROM {ts}
        WHERE feature_id = :fid
          AND {idx_sql} IS NOT NULL
          {where_end}
        ORDER BY date
        """
    )

    with engine.begin() as conn:
        rows = conn.execute(sql, params).fetchall()

    return [float(r.v) for r in rows if r.v is not None]


def fetch_trend_stats_all(*, dataset_key: str, index: str) -> dict[str, dict[str, Any]]:
    """Compute (and return) full-history trend statistics for all features.

    This is used to attach *fixed* trend attributes to map features.
    Trend statistics must NOT change with UI date sliders.

    Returns a mapping: feature_id -> trend dict.
    """

    _ = resolve_dataset_key(dataset_key)
    idx = validate_index_name(dataset_key, index)
    idx_sql = '"' + idx.replace('"', '') + '"'
    ts = _ts_table(dataset_key)

    sql = text(
        f"""
        SELECT feature_id, array_agg({idx_sql} ORDER BY date) AS vals
        FROM {ts}
        WHERE {idx_sql} IS NOT NULL
        GROUP BY feature_id
        """
    )

    out: dict[str, dict[str, Any]] = {}
    with engine.begin() as conn:
        rows = conn.execute(sql).fetchall()

    for r in rows:
        vals = list(r.vals or [])
        # array_agg can contain Decimals depending on driver
        cleaned = [float(v) for v in vals if v is not None]
        out[str(r.feature_id)] = mann_kendall_and_sen(cleaned)

    return out
