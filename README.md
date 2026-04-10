# Iran Drought Monitoring Dashboard (FastAPI + Leaflet)

This project serves drought map + trend analytics from **PostGIS**, with Redis/in-memory caching and a static frontend.

## Production hardening highlights (April 2026)

- Config moved to environment-backed settings (`backend/app/settings.py`) for CORS, map limits, and cache TTLs.
- API errors standardized to `{ "error": { "code", "message", "path" } }` with explicit HTTP handlers.
- `/regions` optimized to query only feature id/name (no geometry loading).
- Import pipeline now clears app caches and metadata caches after ingest.
- Frontend now protects overview requests from staleness/overlap using abort + sequence guards.
- Better frontend error visibility for map/overview loading failures.

## Architecture

- **Backend**: FastAPI + SQLAlchemy.
- **Data**: PostGIS tables (`datasets`, `features`, and per-layer `ts_<dataset_key>`).
- **Cache**: Redis first, in-memory fallback.
- **Frontend**: Leaflet map + ECharts panel.

## Configuration (new)

Set via environment variables:

- `APP_ENV` (default `development`)
- `LOG_LEVEL` (default `INFO`)
- `CORS_ORIGINS` (comma-separated)
- `MAP_LIMIT_DEFAULT` / `MAP_LIMIT_MAX`
- `CACHE_TTL_SHORT_SECONDS` / `CACHE_TTL_MEDIUM_SECONDS` / `CACHE_TTL_LONG_SECONDS` / `CACHE_TTL_DAILY_SECONDS`
- `DATABASE_URL`, `REDIS_URL`

## Import data

```bash
python import_data.py --replace
```

After import, the script now invalidates API caches automatically.

## Run

```bash
make dev
# or
make prod
```

- Frontend: `http://localhost:8080`
- Backend docs: `http://localhost:8000/docs`

## API

- `GET /health`
- `GET /datasets`
- `GET /meta?level=<dataset_key>`
- `GET /regions?level=<dataset_key>`
- `GET /mapdata?level=<dataset_key>&index=spi3&date=YYYY-MM&bbox=minLon,minLat,maxLon,maxLat`
- `GET /overview?level=<dataset_key>&index=spi3&date=YYYY-MM`
- `GET /timeseries?region_id=<id>&level=<dataset_key>&index=spi3`
- `GET /kpi?region_id=<id>&level=<dataset_key>&index=spi3&date=YYYY-MM`
- `POST /admin/cache/invalidate?prefix=api:`

## Changelog

### Added
- Env-based settings module.
- Cache invalidation endpoint and importer-driven invalidation.
- Backend exception handlers for consistent error payloads.

### Changed
- `/regions` now uses direct feature listing query.
- Frontend `onDateChanged()` now refreshes both map and overview together.
- Frontend fetch error handling parses backend error messages.

### Fixed
- Reduced stale overview updates during rapid filter/date changes.
- Removed silent backend fallback on `/regions` failures.

## Compatibility notes

- Existing endpoints are preserved.
- Error body shape is now standardized; clients reading legacy plain `detail` should switch to `error.message`.
- Existing cache keys are effectively invalidated (new `api:*` prefixes).
