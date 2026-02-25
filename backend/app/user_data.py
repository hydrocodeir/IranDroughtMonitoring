import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
POINT_DIR = ROOT / "data" / "user_data" / "point"
POLYGON_DIR = ROOT / "data" / "user_data" / "polygon"


@lru_cache(maxsize=32)
def _normalize_month_cached(value: str) -> str | None:
    try:
        dt = pd.to_datetime(value)
    except Exception:
        return None
    if pd.isna(dt):
        return None
    return f"{dt.year:04d}-{dt.month:02d}"


def _normalize_month(value: Any) -> str | None:
    if value is None:
        return None
    return _normalize_month_cached(str(value))


@dataclass
class DataBundle:
    kind: str
    features: list[dict[str, Any]]
    id_col: str | None
    map_values: dict[str, dict[str, dict[str, float]]]
    timeseries: dict[str, dict[str, list[dict[str, Any]]]]


def _read_geojson(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []
    return raw.get("features", []) if isinstance(raw, dict) else []


def _read_csv(path: Path) -> pd.DataFrame:
    if not path.exists():
        return pd.DataFrame()
    try:
        return pd.read_csv(path)
    except Exception:
        return pd.DataFrame()


def _sanitize_columns(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return df
    out = df.copy()
    out.columns = [str(c).strip().replace("﻿", "").lower() for c in out.columns]
    return out


def _resolve_index_col(columns: list[str], index: str) -> str | None:
    if not columns:
        return None
    key = str(index or "").strip().lower()
    if key in columns:
        return key
    normalized = {c.replace("-", "").replace("_", ""): c for c in columns}
    return normalized.get(key.replace("-", "").replace("_", ""))


def _extract_feature_props(kind: str, feature: dict[str, Any], fallback_id: int) -> dict[str, Any]:
    props = feature.get("properties") or {}
    id_candidates = ["station_id", "unit_id", "id", "code", "name", "station_name", "boundary"]
    name_candidates = ["station_name", "name", "unit_name", "Province", "province", "boundary"]

    fid = next((props.get(k) for k in id_candidates if props.get(k) not in (None, "")), fallback_id)
    name = next((props.get(k) for k in name_candidates if props.get(k) not in (None, "")), f"feature-{fallback_id}")

    out = dict(props)
    out["id"] = str(fid)
    out["name"] = str(name)
    out["level"] = "station" if kind == "point" else props.get("level", "polygon")
    return out


def _guess_id_col(df: pd.DataFrame, feature_ids: set[str]) -> str | None:
    preferred = ["station_id", "unit_id", "id", "region_id", "name", "region_name", "station_name"]
    for col in preferred:
        if col in df.columns:
            overlap = set(df[col].astype(str).unique()) & feature_ids
            if overlap:
                return col
    best = None
    best_score = 0
    for col in df.columns:
        overlap = set(df[col].astype(str).unique()) & feature_ids
        if len(overlap) > best_score:
            best = col
            best_score = len(overlap)
    return best


def _build_indexes(df: pd.DataFrame, id_col: str | None) -> tuple[dict[str, dict[str, dict[str, float]]], dict[str, dict[str, list[dict[str, Any]]]]]:
    if df.empty or not id_col or "date" not in df.columns:
        return {}, {}

    candidate_indexes = [
        c for c in df.columns
        if c not in {id_col, "date", "month_key"} and pd.api.types.is_numeric_dtype(pd.to_numeric(df[c], errors="coerce"))
    ]

    map_values: dict[str, dict[str, dict[str, float]]] = {}
    timeseries: dict[str, dict[str, list[dict[str, Any]]]] = {}

    for _, row in df.iterrows():
        region_id = str(row.get(id_col, ""))
        month_key = row.get("month_key")
        date_raw = row.get("date")
        if not region_id or not month_key or pd.isna(date_raw):
            continue

        date_str = pd.to_datetime(date_raw, errors="coerce")
        if pd.isna(date_str):
            continue
        iso_date = date_str.date().isoformat()

        month_bucket = map_values.setdefault(str(month_key), {}).setdefault(region_id, {})
        region_series = timeseries.setdefault(region_id, {})

        for idx_col in candidate_indexes:
            val = pd.to_numeric(row.get(idx_col), errors="coerce")
            if pd.isna(val):
                continue
            fval = float(val)
            month_bucket[idx_col] = fval
            region_series.setdefault(idx_col, []).append({"date": iso_date, "value": fval})

    for series_by_idx in timeseries.values():
        for idx_col, seq in series_by_idx.items():
            seq.sort(key=lambda x: x["date"])
            series_by_idx[idx_col] = seq

    return map_values, timeseries


@lru_cache(maxsize=8)
def load_user_bundle(level: str) -> DataBundle | None:
    kind = "point" if level == "station" else "polygon"
    base = POINT_DIR if kind == "point" else POLYGON_DIR
    geojson_path = base / "geoinfo.geojson"
    csv_path = base / "data.csv"

    if not (geojson_path.exists() and csv_path.exists()):
        return None

    features = _read_geojson(geojson_path)
    df = _sanitize_columns(_read_csv(csv_path))
    if df.empty:
        df = pd.DataFrame(columns=["date"])

    normalized_features = []
    for idx, feature in enumerate(features, start=1):
        f = {"type": "Feature", "geometry": feature.get("geometry"), "properties": _extract_feature_props(kind, feature, idx)}
        normalized_features.append(f)

    if "date" in df.columns:
        df["month_key"] = df["date"].map(_normalize_month)

    ids = {f.get("properties", {}).get("id", "") for f in normalized_features}
    id_col = _guess_id_col(df, {str(i) for i in ids}) if not df.empty else None
    if id_col:
        df[id_col] = df[id_col].astype(str)

    map_values, timeseries = _build_indexes(df, id_col)

    return DataBundle(kind=kind, features=normalized_features, id_col=id_col, map_values=map_values, timeseries=timeseries)


def list_regions(level: str) -> list[dict[str, Any]]:
    bundle = load_user_bundle(level)
    if not bundle:
        return []
    return [
        {"id": feature.get("properties", {}).get("id"), "name": feature.get("properties", {}).get("name"), "level": level}
        for feature in bundle.features
    ]


def map_features(level: str, date: str, index: str, classify_fn) -> list[dict[str, Any]]:
    bundle = load_user_bundle(level)
    if not bundle:
        return []

    target_month = _normalize_month(date)
    out = []
    columns = []
    if bundle.timeseries:
        sample_region = next(iter(bundle.timeseries.values()), {})
        columns = list(sample_region.keys())
    index_col = _resolve_index_col(columns, index)

    month_values = bundle.map_values.get(target_month or "", {})
    idx_lc = index.lower()

    for feature in bundle.features:
        props = dict(feature.get("properties") or {})
        rid = str(props.get("id"))
        value = month_values.get(rid, {}).get(index_col) if index_col else None
        props["value"] = value
        props["severity"] = classify_fn(value) if value is not None and idx_lc.startswith(("spi", "spei")) else "N/A"
        out.append({"type": "Feature", "geometry": feature.get("geometry"), "properties": props})

    return out


def extract_timeseries(region_id: str | int, level: str, index: str) -> list[dict[str, Any]]:
    bundle = load_user_bundle(level)
    if not bundle:
        return []

    region_series = bundle.timeseries.get(str(region_id))
    if not region_series:
        return []

    index_col = _resolve_index_col(list(region_series.keys()), index)
    if not index_col:
        return []

    return region_series.get(index_col, [])
