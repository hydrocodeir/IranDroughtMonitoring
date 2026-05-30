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

## Deploy to VPS for `drought.werifum.ir`

1. Point DNS records to the VPS public IP:

```text
CNAME  drought  <target-host>
# or, if your DNS provider does not use CNAME here:
A      drought  <VPS_IP>
```

2. Install runtime packages on an Ubuntu VPS:

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-plugin nginx certbot python3-certbot-nginx git
sudo systemctl enable --now docker nginx
```

3. Clone the project and create the production env file:

```bash
cd /opt
sudo git clone https://github.com/HydroCodeIR/IranDroughtMonitoring.git
sudo chown -R "$USER:$USER" IranDroughtMonitoring
cd IranDroughtMonitoring
cp .env.prod.example .env.prod
nano .env.prod
```

Set a strong `POSTGRES_PASSWORD`, and keep `DATABASE_URL` in sync with it.

4. Start production containers:

```bash
make prod-detached
```

The production compose file only exposes the frontend on `127.0.0.1:8080`. PostGIS, Redis, and the backend stay private inside Docker.

5. Install the Nginx host config:

```bash
sudo cp deploy/nginx-drought.werifum.ir.conf /etc/nginx/sites-available/drought.werifum.ir
sudo ln -s /etc/nginx/sites-available/drought.werifum.ir /etc/nginx/sites-enabled/drought.werifum.ir
sudo nginx -t
sudo systemctl reload nginx
```

6. Enable HTTPS:

```bash
sudo certbot --nginx -d drought.werifum.ir
```

7. Import or refresh data when needed:

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml exec backend python /app/import_data.py --replace
```

Useful checks:

```bash
curl http://127.0.0.1:8080
docker compose --env-file .env.prod -f docker-compose.prod.yml ps
docker compose --env-file .env.prod -f docker-compose.prod.yml logs -f backend
```

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
