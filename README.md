# Iran Drought Monitoring Dashboard

A lightweight drought dashboard that reads **only user-provided files**.

## Data folders (required naming)
Put your files exactly in these paths:

- `data/user_data/point/geoinfo.geojson`
- `data/user_data/point/data.csv`
- `data/user_data/polygon/geoinfo.geojson`
- `data/user_data/polygon/data.csv`

If files are missing in either folder, that section is shown as empty in the dashboard.
No synthetic/fallback data is generated.

## Expected format
- `geoinfo.geojson`: valid `FeatureCollection` (Point for station mode, any geometry for polygon mode).
- `data.csv`: includes `date` + SPI/SPEI columns such as `spi1..spi24`, `spei1..spei24` (whatever you provide).
- Identifier columns can be `station_id`, `unit_id`, `id`, `name`, ... (auto-detected by overlap with GeoJSON properties).

## API Endpoints
- `GET /health`
- `GET /regions?level=station|province|county|level1|level2|level3`
- `GET /mapdata?level=...&date=YYYY-MM&index=spi3`
- `GET /timeseries?region_id=...&level=...&index=spi3`
- `GET /kpi?region_id=...&level=...&index=spi3`

## Run
### Development mode (hot reload for backend, celery, and frontend)
```bash
make dev
# or: docker compose -f docker-compose.dev.yml up --build
```

### Production mode (current nginx + non-reload backend setup)
```bash
make prod
# or: docker compose -f docker-compose.yml up --build
```

- Frontend: `http://localhost:8080`
- Backend docs: `http://localhost:8000/docs`

In development mode, backend and frontend source folders are bind-mounted, so code changes apply immediately without rebuilding images.
