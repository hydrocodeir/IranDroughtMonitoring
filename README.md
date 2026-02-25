# Iran Drought Monitoring Dashboard

A high-performance, Dockerized drought monitoring dashboard for Iran, inspired by the UCI drought platform and adapted for Iran's planning levels.

## Stack
- **Backend:** FastAPI, GeoPandas, Rasterio, Xarray, NumPy, Pandas, PostgreSQL/PostGIS, Redis, Celery, APScheduler.
- **Python env/tooling:** `uv` virtual environment for backend dependency installation in container builds.
- **Frontend:** HTML5, CSS3, Bootstrap 5 RTL, HTMX, Vanilla JS, Leaflet, Chart.js.
- **Containers:** Docker + Docker Compose.

## Features
- Multi-level spatial support: `province`, `county`, `study_area`, `level1`, `level2`, `level3`.
- Automatic first-run ingestion of `data/iran_provinces.geojson` into PostGIS.
- 10 years (120 months) simulated monthly climate/index data loaded from `data/simulated_timeseries.csv`.
- Choropleth drought classes (`D0`..`D4`) from SPI/SPEI thresholds.
- Region click interaction with KPI and 10-year time-series chart.
- رابط کاربری مدرن RTL با فونت فارسی Vazirmatn، پنل کشویی از سمت چپ و نوار کنترل تاریخ/محدوده در پایین نقشه.
- Redis cache on regions/map/timeseries/KPI endpoints.
- Celery task support for async KPI calculations.
- APScheduler monthly trigger for background recompute workflows.
- Geometry simplification in map API for faster payloads.

## API Endpoints
- `GET /regions?level=province`
- `GET /mapdata?level=province&date=YYYY-MM&index=spi3`
- `GET /timeseries?region_id=1&index=spi3`
- `GET /kpi?region_id=1&index=spi3`

Extra:
- `GET /panel?region_id=1&index=spi3` (HTMX fragment)
- `GET /health`

## Data
- `data/iran_provinces.geojson`: demo province boundaries (replaceable by real boundaries).
- `data/simulated_timeseries.csv`: 120-month synthetic data per province.
- `backend/scripts/generate_simulated_data.py`: regenerate synthetic data.

## Run
```bash
docker-compose up --build
```

- Frontend: `http://localhost:8080`
- Backend API docs: `http://localhost:8000/docs`

## Performance Notes
- Redis caches repeated response objects (default TTL 15 minutes).
- Precomputed monthly values are persisted in `time_series` table.
- Simplified geometries are served in map responses.
- KPI heavy job can run async with Celery via `async_compute=true`.

## Schema
### `regions`
- `id`, `name`, `level`, `geom`
- Indexes: GIST on `geom`, B-tree on level/name

### `time_series`
- `region_id`, `date`, `spi3`, `spei3`, `precip`, `temp`
- Indexes: B-tree on `(region_id, date)`

## Notes for replacing with real data
1. Replace `data/iran_provinces.geojson` with real province/county/other geometries.
2. Keep `name` + `level` attributes.
3. If using full hierarchy, update seed import logic in `backend/app/seed.py`.
4. Replace synthetic CSV with real monthly outputs.

## Scenario templates for real data replacement
The repository now includes ready-to-fill sample files for your requested SPI/SPEI workflows:

### 1) Station point scenario (CSV + GeoJSON)
- `data/scenarios/station_point/stations.geojson`
  - Point geometry per station with `station_id` and `station_name`.
- `data/scenarios/station_point/station_spi_spei_1_24_sample.csv`
  - Monthly values with columns: `station_id`, `date`, `spi1..spi24`, `spei1..spei24`.

### 2) Polygon level scenario (province/county/basin levels)
- `data/scenarios/polygon_levels/province.geojson`
- `data/scenarios/polygon_levels/county.geojson`
- `data/scenarios/polygon_levels/level1.geojson`
- `data/scenarios/polygon_levels/level2.geojson`
- `data/scenarios/polygon_levels/level3.geojson`
- `data/scenarios/polygon_levels/polygon_spi_spei_1_24_sample.csv`
  - Monthly values with columns: `level`, `unit_id`, `date`, `spi1..spi24`, `spei1..spei24`.

### Dashboard behavior prepared
- Geographic dropdown includes: `ایستگاهی`, `استانی`, `شهرستانی`, `حوزه درجه یک`, `حوزه درجه دو`, `حوزه درجه سه`.
- Index dropdown now includes all SPI/SPEI windows from 1 to 24 months.
- Selecting either Point or Polygon opens a modal-style detail view and chart panel.

> You can replace only the sample values and keep the schema/column names unchanged so the UI contract stays stable.
