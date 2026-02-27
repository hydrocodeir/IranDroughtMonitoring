"""One-time importer: one or more (data.csv + geoinfo.geojson) pairs ➜ PostGIS.

Why this exists
--------------
The running dashboard must never read CSV/GeoJSON directly (too slow for large
files and blocks map loading). This script performs **one-time ingestion** into
an indexed PostGIS database.

Multi-layer support
------------------
You can import multiple spatial levels by placing multiple pairs under
`data/import/<dataset_key>/`:

  data/import/station/data.csv
  data/import/station/geoinfo.geojson

  data/import/province/data.csv
  data/import/province/geoinfo.geojson

Backward compatibility
---------------------
If you only have a single pair and place it directly in `data/import/`, this
script imports it as dataset_key="station":

  data/import/data.csv
  data/import/geoinfo.geojson

Performance notes
-----------------
* CSV ingestion is **chunked** and streamed into Postgres using COPY.
  This avoids loading a 50MB+ CSV into memory.
* GeoJSON is usually much smaller than CSV. We load it once, then insert in
  batches.
* Each dataset gets its own **wide** time-series table (ts_<dataset_key>)
  created dynamically from the CSV header. This avoids exploding row counts.

This script is intentionally NOT executed on each request.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
from io import StringIO
from pathlib import Path
from typing import Any

import pandas as pd
from psycopg2.extras import execute_values
from sqlalchemy import text

import sys

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str((ROOT / "backend").resolve()))
from app.database import engine  # noqa: E402
from app.datasets_store import get_available_indices, precompute_trend_stats  # noqa: E402


DATASET_KEY_RE = re.compile(r"^[a-zA-Z0-9_]+$")


def safe_dataset_key(value: str) -> str:
    key = (value or "").strip()
    if not key or not DATASET_KEY_RE.match(key):
        raise ValueError(f"Unsafe dataset key: {value!r} (use letters/numbers/underscore)")
    return key


def month_start(dt: pd.Timestamp) -> str:
    if pd.isna(dt):
        return ""
    return f"{dt.year:04d}-{dt.month:02d}-01"


def discover_dataset_dirs(base_dir: Path) -> list[tuple[str, Path]]:
    """Discover dataset folders.

    Returns: list of (dataset_key, folder)
    """
    # Backward compatible single dataset
    direct_csv = base_dir / "data.csv"
    direct_geo = base_dir / "geoinfo.geojson"
    if direct_csv.exists() and direct_geo.exists():
        return [("station", base_dir)]

    pairs: list[tuple[str, Path]] = []
    for child in sorted(base_dir.iterdir()):
        if not child.is_dir() or child.name.startswith("."):
            continue
        csv_path = child / "data.csv"
        geo_path = child / "geoinfo.geojson"
        if csv_path.exists() and geo_path.exists():
            pairs.append((safe_dataset_key(child.name), child))
    return pairs


def detect_id_column(header: list[str]) -> str:
    candidates = [
        "feature_id",
        "station_id",
        "region_id",
        "id",
        "code",
        "gid",
        "fid",
        "name",
    ]
    lower = [c.lower() for c in header]
    for cand in candidates:
        if cand in lower:
            return header[lower.index(cand)]
    # Fallback to first column
    return header[0]


def detect_date_columns(header: list[str]) -> dict[str, str] | None:
    lower = [c.lower() for c in header]
    if "date" in lower:
        return {"mode": "date", "date": header[lower.index("date")]}
    if "month" in lower and "year" in lower:
        return {"mode": "ym", "year": header[lower.index("year")], "month": header[lower.index("month")]}
    if "yyyymm" in lower:
        return {"mode": "yyyymm", "yyyymm": header[lower.index("yyyymm")]}
    return None


def normalize_header(header: list[str]) -> list[str]:
    return [str(c).strip().replace("\ufeff", "") for c in header]


def create_base_schema(replace: bool) -> None:
    conn = engine.raw_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("CREATE EXTENSION IF NOT EXISTS postgis")

            if replace:
                # Drop all per-dataset ts_* tables.
                cur.execute(
                    """
                    DO $$
                    DECLARE r RECORD;
                    BEGIN
                      FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'ts_%') LOOP
                        EXECUTE 'DROP TABLE IF EXISTS ' || quote_ident(r.tablename) || ' CASCADE';
                      END LOOP;
                    END$$;
                    """
                )
                cur.execute("DROP TABLE IF EXISTS features CASCADE")
                cur.execute("DROP TABLE IF EXISTS datasets CASCADE")

            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS datasets (
                  dataset_key TEXT PRIMARY KEY,
                  title TEXT,
                  geom_type TEXT,
                  min_date DATE,
                  max_date DATE,
                  created_at TIMESTAMPTZ DEFAULT NOW()
                )
                """
            )

            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS features (
                  dataset_key TEXT NOT NULL REFERENCES datasets(dataset_key) ON DELETE CASCADE,
                  feature_id TEXT NOT NULL,
                  name TEXT,
                  props JSONB,
                  geom geometry(Geometry, 4326) NOT NULL,
                  min_date DATE,
                  max_date DATE,
                  PRIMARY KEY (dataset_key, feature_id)
                )
                """
            )
            cur.execute("CREATE INDEX IF NOT EXISTS idx_features_geom ON features USING gist (geom)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_features_name ON features (dataset_key, name)")
        conn.commit()
    finally:
        conn.close()


def create_ts_table(dataset_key: str, index_columns: list[str], replace: bool) -> None:
    key = safe_dataset_key(dataset_key)
    table = f"ts_{key}"

    # Validate index columns to avoid SQL injection.
    safe_cols: list[str] = []
    for c in index_columns:
        cc = str(c).strip().lower()
        if not cc:
            continue
        if not all(ch.isalnum() or ch == "_" for ch in cc):
            raise ValueError(f"Unsafe column name in CSV header: {c!r}")
        if cc in {"feature_id", "station_id", "region_id", "id", "date", "year", "month", "yyyymm"}:
            continue
        safe_cols.append(cc)
    cols_sql = ",\n    ".join([f'"{c}" DOUBLE PRECISION NULL' for c in safe_cols])

    conn = engine.raw_connection()
    try:
        with conn.cursor() as cur:
            if replace:
                cur.execute(f"DROP TABLE IF EXISTS {table} CASCADE")

            cur.execute(
                f"""
                CREATE TABLE IF NOT EXISTS {table} (
                  feature_id TEXT NOT NULL,
                  date DATE NOT NULL,
                  {cols_sql}{"," if cols_sql else ""}
                  PRIMARY KEY (feature_id, date)
                )
                """
            )
            cur.execute(f"CREATE INDEX IF NOT EXISTS idx_{table}_date_feature ON {table} (date, feature_id)")
            cur.execute(f"CREATE INDEX IF NOT EXISTS idx_{table}_feature_date ON {table} (feature_id, date)")
        conn.commit()
    finally:
        conn.close()


def read_geojson_features(path: Path) -> list[dict[str, Any]]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    feats = raw.get("features", []) if isinstance(raw, dict) else []
    return feats if isinstance(feats, list) else []


def ingest_features(dataset_key: str, geojson_path: Path, id_hint: str | None = None) -> tuple[int, str]:
    feats = read_geojson_features(geojson_path)
    rows = []
    geom_type = "Geometry"

    # Candidate property names for feature ids
    id_keys = [k for k in [id_hint, "feature_id", "station_id", "region_id", "id", "code", "gid", "fid", "name"] if k]

    for f in feats:
        if not isinstance(f, dict):
            continue
        props = f.get("properties") or {}
        geom = f.get("geometry") or {}
        gtype = geom.get("type")
        if isinstance(gtype, str) and geom_type == "Geometry":
            geom_type = gtype

        feature_id = None
        for k in id_keys:
            if k in props and props.get(k) not in (None, ""):
                feature_id = props.get(k)
                break
        if feature_id in (None, ""):
            feature_id = f.get("id")
        if feature_id in (None, ""):
            continue
        feature_id = str(feature_id)

        name = props.get("name") or props.get("station_name") or props.get("title") or feature_id

        cleaned_props = dict(props)
        # Avoid storing redundant id/name keys twice
        for k in ["feature_id", "station_id", "region_id", "id", "station_name"]:
            cleaned_props.pop(k, None)

        geom_json = json.dumps(geom, ensure_ascii=False)
        rows.append((dataset_key, feature_id, str(name), json.dumps(cleaned_props, ensure_ascii=False), geom_json))

    if not rows:
        return 0, geom_type

    sql = """
    INSERT INTO features (dataset_key, feature_id, name, props, geom)
    VALUES %s
    ON CONFLICT (dataset_key, feature_id) DO UPDATE
    SET name = EXCLUDED.name,
        props = EXCLUDED.props,
        geom = EXCLUDED.geom;
    """

    conn = engine.raw_connection()
    try:
        with conn.cursor() as cur:
            template = "(%s,%s,%s,%s::jsonb, ST_SetSRID(ST_GeomFromGeoJSON(%s),4326))"
            execute_values(cur, sql, rows, template=template, page_size=1000)
        conn.commit()
    finally:
        conn.close()

    return len(rows), geom_type


def ingest_timeseries(
    *,
    dataset_key: str,
    csv_path: Path,
    id_col: str,
    date_info: dict[str, str],
    index_columns: list[str],
    chunksize: int,
) -> int:
    key = safe_dataset_key(dataset_key)
    table = f"ts_{key}"

    cols = ["feature_id", "date"] + [c.strip().lower() for c in index_columns]
    cols = [c for c in cols if c not in {"feature_id", "date"}]  # de-dup
    cols = ["feature_id", "date"] + cols
    cols_sql = ",".join([f'"{c}"' if c not in {"feature_id", "date"} else c for c in cols])
    copy_sql = f"COPY {table} ({cols_sql}) FROM STDIN WITH (FORMAT CSV, NULL '', QUOTE '\"')"

    inserted = 0
    conn = engine.raw_connection()
    try:
        with conn.cursor() as cur:
            reader = pd.read_csv(csv_path, chunksize=chunksize, low_memory=False)
            for i, chunk in enumerate(reader, start=1):
                if chunk.empty:
                    continue

                chunk.columns = normalize_header(list(chunk.columns))
                col_map_lower = {c.lower(): c for c in chunk.columns}
                if id_col.lower() not in col_map_lower:
                    raise ValueError(f"CSV missing id column {id_col!r}")

                # Normalize ID column to feature_id
                chunk["feature_id"] = chunk[col_map_lower[id_col.lower()]].astype("string")

                # Build date column
                if date_info["mode"] == "date":
                    dt_col = col_map_lower.get(date_info["date"].lower())
                    if not dt_col:
                        raise ValueError("CSV missing date column")
                    chunk["date"] = pd.to_datetime(chunk[dt_col], errors="coerce").map(month_start)
                elif date_info["mode"] == "ym":
                    y_col = col_map_lower.get(date_info["year"].lower())
                    m_col = col_map_lower.get(date_info["month"].lower())
                    if not y_col or not m_col:
                        raise ValueError("CSV missing year/month columns")
                    y = pd.to_numeric(chunk[y_col], errors="coerce")
                    m = pd.to_numeric(chunk[m_col], errors="coerce")
                    chunk["date"] = [
                        f"{int(yy):04d}-{int(mm):02d}-01" if pd.notna(yy) and pd.notna(mm) else ""
                        for yy, mm in zip(y, m)
                    ]
                elif date_info["mode"] == "yyyymm":
                    ym_col = col_map_lower.get(date_info["yyyymm"].lower())
                    if not ym_col:
                        raise ValueError("CSV missing yyyymm column")
                    raw = chunk[ym_col].astype("string")
                    chunk["date"] = raw.map(lambda s: f"{str(s)[:4]}-{str(s)[4:6]}-01" if s and len(str(s)) >= 6 else "")
                else:
                    raise ValueError("Unsupported date format")

                # Ensure expected index columns exist (lowercased)
                for c in index_columns:
                    cl = c.strip().lower()
                    if cl not in col_map_lower:
                        chunk[cl] = pd.NA
                    else:
                        chunk.rename(columns={col_map_lower[cl]: cl}, inplace=True)

                out = chunk[["feature_id", "date"] + [c.strip().lower() for c in index_columns]].copy()
                out = out[(out["feature_id"].notna()) & (out["date"].astype(str).str.len() == 10)]
                if out.empty:
                    continue

                buf = StringIO()
                out.to_csv(buf, index=False, header=False, na_rep="", quoting=csv.QUOTE_MINIMAL)
                buf.seek(0)
                cur.copy_expert(copy_sql, buf)
                inserted += len(out)

                if i % 5 == 0:
                    conn.commit()
                    print(f"[{dataset_key}] chunks processed={i}, rows inserted≈{inserted:,}")

        conn.commit()
    finally:
        conn.close()
    return inserted


def finalize_bounds(dataset_key: str) -> None:
    key = safe_dataset_key(dataset_key)
    table = f"ts_{key}"
    with engine.begin() as conn:
        # Update per-feature bounds
        conn.execute(
            text(
                f"""
                UPDATE features f
                SET min_date = s.min_d,
                    max_date = s.max_d
                FROM (
                  SELECT feature_id, MIN(date) AS min_d, MAX(date) AS max_d
                  FROM {table}
                  GROUP BY feature_id
                ) s
                WHERE f.dataset_key = :k AND f.feature_id = s.feature_id;
                """
            ),
            {"k": key},
        )
        # Update dataset bounds
        conn.execute(
            text(
                f"""
                UPDATE datasets
                SET min_date = (SELECT MIN(date) FROM {table}),
                    max_date = (SELECT MAX(date) FROM {table})
                WHERE dataset_key = :k;
                """
            ),
            {"k": key},
        )




def precompute_dataset_trends(dataset_key: str) -> None:
    """Precompute full-history trends right after import for zero first-click delay."""
    indices = get_available_indices(dataset_key)
    if not indices:
        print(f"[{dataset_key}] no index columns found for trend precompute")
        return
    for idx in indices:
        count = precompute_trend_stats(dataset_key=dataset_key, index=idx)
        print(f"[{dataset_key}] precomputed trends for {idx}: {count:,} features")

def import_one_dataset(dataset_key: str, folder: Path, replace: bool, chunksize: int) -> None:
    csv_path = folder / "data.csv"
    geo_path = folder / "geoinfo.geojson"
    if not csv_path.exists() or not geo_path.exists():
        raise FileNotFoundError(f"Missing data.csv/geoinfo.geojson in {folder}")

    with csv_path.open("r", encoding="utf-8", newline="") as f:
        header = normalize_header(next(csv.reader(f)))
    id_col = detect_id_column(header)
    date_info = detect_date_columns(header)
    if not date_info:
        raise SystemExit("CSV must have either 'date' or ('year' and 'month') columns")

    lower = [c.lower() for c in header]
    # Index columns = everything except id/date fields
    exclude = {id_col.lower(), "feature_id", "station_id", "region_id", "id", "code"}
    if date_info["mode"] == "date":
        exclude.add(date_info["date"].lower())
    elif date_info["mode"] == "ym":
        exclude.add(date_info["year"].lower())
        exclude.add(date_info["month"].lower())
    elif date_info["mode"] == "yyyymm":
        exclude.add(date_info["yyyymm"].lower())
    index_cols = [c for c in lower if c not in exclude]
    print(f"[{dataset_key}] id_col={id_col!r}, date_mode={date_info['mode']}, indices={len(index_cols)}")

    # Register dataset row (will update geom_type and bounds later)
    with engine.begin() as conn:
        conn.execute(
            text(
                """
                INSERT INTO datasets(dataset_key, title, geom_type)
                VALUES (:k, :t, :g)
                ON CONFLICT (dataset_key) DO UPDATE
                SET title = EXCLUDED.title;
                """
            ),
            {"k": dataset_key, "t": dataset_key, "g": "Geometry"},
        )

    create_ts_table(dataset_key, index_cols, replace=replace)

    print(f"[{dataset_key}] importing GeoJSON features...")
    count, geom_type = ingest_features(dataset_key, geo_path, id_hint=id_col)
    print(f"[{dataset_key}] features imported: {count:,} (geom_type={geom_type})")

    with engine.begin() as conn:
        conn.execute(
            text("UPDATE datasets SET geom_type = :g WHERE dataset_key = :k"),
            {"k": dataset_key, "g": geom_type},
        )

    print(f"[{dataset_key}] importing time series CSV (chunked COPY)...")
    inserted = ingest_timeseries(
        dataset_key=dataset_key,
        csv_path=csv_path,
        id_col=id_col,
        date_info=date_info,
        index_columns=index_cols,
        chunksize=chunksize,
    )
    print(f"[{dataset_key}] rows inserted: {inserted:,}")

    print(f"[{dataset_key}] computing per-feature and dataset bounds...")
    finalize_bounds(dataset_key)

    with engine.begin() as conn:
        conn.execute(text("ANALYZE features"))
        conn.execute(text(f"ANALYZE ts_{dataset_key}"))

    print(f"[{dataset_key}] precomputing trends for all indices...")
    precompute_dataset_trends(dataset_key)


def main() -> None:
    parser = argparse.ArgumentParser(description="Import drought datasets into PostGIS")
    parser.add_argument("--data-dir", default=str(ROOT / "data" / "import"), help="Folder containing dataset pairs")
    parser.add_argument("--replace", action="store_true", help="Drop and recreate imported tables")
    parser.add_argument("--chunksize", type=int, default=50_000, help="CSV rows per chunk")
    args = parser.parse_args()

    base = Path(args.data_dir)
    if not base.exists():
        raise SystemExit(f"data-dir not found: {base}")

    datasets = discover_dataset_dirs(base)
    if not datasets:
        raise SystemExit(
            "No dataset pairs found. Place files as either:\n"
            "  data/import/data.csv + data/import/geoinfo.geojson\n"
            "or multi-layer:\n"
            "  data/import/<dataset_key>/data.csv + geoinfo.geojson"
        )

    print("Creating base schema...")
    create_base_schema(replace=bool(args.replace))

    for dataset_key, folder in datasets:
        import_one_dataset(dataset_key, folder, replace=bool(args.replace), chunksize=int(args.chunksize))

    print("Done. Start the dashboard (FastAPI + frontend).")


if __name__ == "__main__":
    main()
