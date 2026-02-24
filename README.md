# Iran Drought Monitoring Dashboard

A high-performance, Dockerized drought monitoring dashboard for Iran, inspired by the UCI drought platform and adapted for Iran's planning levels.

## Stack
- **Backend:** FastAPI, GeoPandas, Rasterio, Xarray, NumPy, Pandas, PostgreSQL/PostGIS, Redis, Celery, APScheduler.
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
