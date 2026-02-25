import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
POINT_DIR = ROOT / "data" / "user_data" / "point"
POLYGON_DIR = ROOT / "data" / "user_data" / "polygon"


def _normalize_month(value: Any) -> str | None:
    if value is None:
        return None
    try:
        dt = pd.to_datetime(value)
    except Exception:
        return None
    if pd.isna(dt):
        return None
    return f"{dt.year:04d}-{dt.month:02d}"


@dataclass
class DataBundle:
    kind: str
    features: list[dict[str, Any]]
    df: pd.DataFrame
    id_col: str | None


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


def load_user_bundle(level: str) -> DataBundle | None:
    kind = "point" if level == "station" else "polygon"
    base = POINT_DIR if kind == "point" else POLYGON_DIR
    geojson_path = base / "geoinfo.geojson"
    csv_path = base / "data.csv"

    if not (geojson_path.exists() and csv_path.exists()):
        return None

    features = _read_geojson(geojson_path)
    df = _read_csv(csv_path)
    if df.empty:
        df = pd.DataFrame(columns=["date"])
    if "date" in df.columns:
        df["month_key"] = df["date"].map(_normalize_month)

    normalized_features = []
    for idx, feature in enumerate(features, start=1):
        f = {"type": "Feature", "geometry": feature.get("geometry"), "properties": _extract_feature_props(kind, feature, idx)}
        normalized_features.append(f)

    ids = {f.get("properties", {}).get("id", "") for f in normalized_features}
    id_col = _guess_id_col(df, {str(i) for i in ids}) if not df.empty else None

    if id_col:
        df[id_col] = df[id_col].astype(str)

    return DataBundle(kind=kind, features=normalized_features, df=df, id_col=id_col)


def list_regions(level: str) -> list[dict[str, Any]]:
    bundle = load_user_bundle(level)
    if not bundle:
        return []
    rows = []
    for feature in bundle.features:
        props = feature.get("properties") or {}
        rows.append({"id": props.get("id"), "name": props.get("name"), "level": level})
    return rows


def map_features(level: str, date: str, index: str, classify_fn) -> list[dict[str, Any]]:
    bundle = load_user_bundle(level)
    if not bundle:
        return []

    target_month = _normalize_month(date)
    df = bundle.df
    id_col = bundle.id_col

    out = []
    for feature in bundle.features:
        props = dict(feature.get("properties") or {})
        value = None
        if id_col and index in df.columns and "month_key" in df.columns and target_month:
            rows = df[(df[id_col] == str(props.get("id"))) & (df["month_key"] == target_month)]
            if not rows.empty:
                raw = pd.to_numeric(rows.iloc[-1][index], errors="coerce")
                if pd.notna(raw):
                    value = float(raw)

        props["value"] = value
        props["severity"] = classify_fn(value) if value is not None and index.lower().startswith(("spi", "spei")) else "N/A"
        out.append({"type": "Feature", "geometry": feature.get("geometry"), "properties": props})

    return out


def extract_timeseries(region_id: str | int, level: str, index: str) -> list[dict[str, Any]]:
    bundle = load_user_bundle(level)
    if not bundle or not bundle.id_col or index not in bundle.df.columns or "date" not in bundle.df.columns:
        return []

    df = bundle.df
    rows = df[df[bundle.id_col] == str(region_id)].copy()
    if rows.empty:
        return []
    rows["date"] = pd.to_datetime(rows["date"], errors="coerce")
    rows[index] = pd.to_numeric(rows[index], errors="coerce")
    rows = rows.dropna(subset=["date", index]).sort_values("date")
    return [{"date": r["date"].date().isoformat(), "value": float(r[index])} for _, r in rows.iterrows()]
