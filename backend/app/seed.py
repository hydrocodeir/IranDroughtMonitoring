import time
from pathlib import Path
import geopandas as gpd
import pandas as pd
from shapely.geometry import Polygon, MultiPolygon
from sqlalchemy import text
from sqlalchemy.exc import OperationalError
from geoalchemy2.shape import from_shape

from .database import SessionLocal, engine
from .models import Base, Region, TimeSeries

ROOT = Path(__file__).resolve().parents[2]
GEOJSON_PATH = ROOT / "data" / "iran_provinces.geojson"
TS_PATH = ROOT / "data" / "simulated_timeseries.csv"

LEVELS = ["province", "county", "study_area", "level1", "level2", "level3"]


def create_tables_with_retry(max_retries: int = 20, delay_seconds: float = 2.0):
    last_error = None
    for attempt in range(1, max_retries + 1):
        try:
            with engine.begin() as conn:
                conn.execute(text("CREATE EXTENSION IF NOT EXISTS postgis"))
            Base.metadata.create_all(bind=engine)
            return
        except OperationalError as exc:
            last_error = exc
            if attempt == max_retries:
                break
            time.sleep(delay_seconds)
    raise last_error


def _subregion_name(base: str, level: str, idx: int) -> str:
    return f"{base} {level.replace('_', ' ').title()} {idx}"


def seed_regions_and_timeseries():
    create_tables_with_retry()
    db = SessionLocal()
    try:
        if db.query(Region).count() > 0:
            return

        gdf = gpd.read_file(GEOJSON_PATH)
        region_ids = {}

        for _, row in gdf.iterrows():
            geom = row.geometry
            if isinstance(geom, Polygon):
                geom = MultiPolygon([geom])
            region = Region(name=row["name"], level="province", geom=from_shape(geom, srid=4326))
            db.add(region)
            db.flush()
            region_ids[(row["name"], "province")] = region.id

            minx, miny, maxx, maxy = geom.bounds
            for level in LEVELS[1:]:
                for i in range(1, 3):
                    dx = (maxx - minx) / 2
                    dy = (maxy - miny) / 2
                    poly = Polygon([
                        (minx + (i - 1) * dx * 0.6, miny + (i - 1) * dy * 0.4),
                        (minx + i * dx, miny + (i - 1) * dy * 0.4),
                        (minx + i * dx, miny + i * dy * 0.6),
                        (minx + (i - 1) * dx * 0.6, miny + i * dy * 0.6),
                    ])
                    sub = Region(
                        name=_subregion_name(row["name"], level, i),
                        level=level,
                        geom=from_shape(MultiPolygon([poly]), srid=4326),
                    )
                    db.add(sub)
                    db.flush()
                    region_ids[(sub.name, level)] = sub.id

        df = pd.read_csv(TS_PATH, parse_dates=["date"])
        for _, row in df.iterrows():
            region_id = region_ids.get((row["region_name"], "province"))
            if region_id is None:
                continue
            db.add(
                TimeSeries(
                    region_id=region_id,
                    date=row["date"].date(),
                    spi3=float(row["spi3"]),
                    spei3=float(row["spei3"]),
                    precip=float(row["precip"]),
                    temp=float(row["temp"]),
                )
            )

        db.commit()
    finally:
        db.close()
