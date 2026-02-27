# Iran Drought Monitoring Dashboard (FastAPI + Leaflet)

This project was redesigned to **eliminate runtime CSV/GeoJSON loading**.

✅ The dashboard **never** reads `data.csv` or `geoinfo.geojson` while serving requests.

Instead, there is a **one-time import step** that ingests the files into a **PostGIS** database (with spatial indexing), enabling:

- fast map startup (no expensive pandas/GeoJSON parsing)
- server-side filtering (bounding-box queries)
- date-range time-series queries
- pagination / lazy loading
- caching (Redis + in-memory fallback)

---

## 1) Place `data.csv` and `geoinfo.geojson` (import-only)

The running dashboard must **not** read CSV/GeoJSON at runtime.

### Option A — Single dataset (backward compatible)

```
data/import/data.csv
data/import/geoinfo.geojson
```

This imports as dataset key: `station`.

### Option B — Multiple datasets (recommended)

Create one folder per spatial layer:

```
data/import/station/data.csv
data/import/station/geoinfo.geojson

data/import/province/data.csv
data/import/province/geoinfo.geojson

data/import/county/data.csv
data/import/county/geoinfo.geojson
```

Each folder name becomes a selectable dataset layer in the UI.

---

## 2) One-time import

### Option A — Docker (recommended)

```bash
make dev
# wait until PostGIS is healthy, then in another terminal:
docker compose -f docker-compose.dev.yml exec backend python /app/import_data.py --replace
```

### Option B — Local Python (advanced)

Run the import script locally if you have a running PostgreSQL+PostGIS instance.

```bash
export DATABASE_URL="postgresql+psycopg2://postgres:postgres@localhost:5432/drought"
python import_data.py --replace
```

---

## 3) Run

### Development (hot reload)

```bash
make dev
```

### Production

```bash
make prod
```

- Frontend: `http://localhost:8080`
- Backend docs (OpenAPI): `http://localhost:8000/docs`

---

## API (multi-layer)

- `GET /health`
- `GET /datasets` (list available imported layers)
- `GET /meta?level=<dataset_key>` (indices + dataset min/max)
- `GET /mapdata?level=<dataset_key>&index=spi3&date=YYYY-MM&bbox=minLon,minLat,maxLon,maxLat&limit=...&offset=...`
- `GET /overview?level=<dataset_key>&index=spi3&date=YYYY-MM` (server-side aggregation)
- `GET /timeseries?region_id=<feature_id>&level=<dataset_key>&index=spi3` (full series with missing months as null)
- `GET /kpi?region_id=<feature_id>&level=<dataset_key>&index=spi3&date=YYYY-MM` (auto-adjusts to nearest available month)

---

## What changed (performance diagnosis)

The original implementation loaded and indexed the **entire** CSV and GeoJSON in Python on first request. On large datasets (50MB CSV, 600k+ rows), this caused:

- slow pandas parsing
- extremely expensive `DataFrame.iterrows()` loops
- huge nested Python dictionaries (month → station → index)
- long single-thread CPU spikes that blocked the map request

The redesign moves all heavy work to **one-time ingestion**, and serves the map from indexed database queries.

---

## Date management (unified + robust)

The frontend now uses a **single, consistent date controller** that avoids the old issues caused by mixing map dates and station dates.

### Two independent timelines

1) **Global map month** (controls what is rendered on the map)
   - UI: the month picker at the top + the bottom timeline slider
   - Drives backend calls:
     - `GET /mapdata?level=<layer>&index=<idx>&date=YYYY-MM&bbox=...`
     - `GET /overview?level=<layer>&index=<idx>&date=YYYY-MM`

2) **Panel (feature) month** (controls KPI selection for the selected station/polygon)
   - UI: the slider under the time series chart
   - Drives backend call:
     - `GET /kpi?region_id=<id>&level=<layer>&index=<idx>&date=YYYY-MM`

These are **decoupled** on purpose:
- Selecting a station with a short history must **not** lock the global map timeline.
- Switching stations must **not** require a page refresh.

### Different time ranges per station/polygon

Every feature has its own temporal coverage:
- During import, we compute `features.min_date` / `features.max_date` per feature.
- For each selected feature + index, the backend computes per-index bounds (ignoring NULL values).

When you click a feature:
1) The UI requests the full time series via `/timeseries`.
2) The response includes `min_month` and `max_month`.
3) The panel slider is reconfigured so its range **always matches the full available feature range**.
4) If the current panel month is outside the valid range, it is **auto-clamped**.

### Missing months

`/timeseries` returns a **continuous monthly series**:
- Missing months are returned with `value: null`.
- This prevents chart axis shrinkage and keeps the time slider stable.

### Preventing empty/invalid KPI states

If the requested panel month has no value (or lies outside the feature range), the backend resolves an **effective month**:
- outside bounds → clamped to min/max
- inside bounds but NULL → nearest previous month with value, else nearest next month

The API returns:
- `requested_month`
- `effective_month`
- `note` (e.g., `clamped-to-end;nearest-previous`)

The frontend then **syncs the panel slider** to `effective_month` to avoid blank KPI cards.

---

## Search mode behavior

Search works completely client-side (fast and avoids extra server load):
- Matching features stay fully visible.
- Non-matching features are faded **and made non-interactive**:
  - `pointer-events: none` on their SVG elements
  - hover/click handlers also guard against interaction

A **Clear search** button resets the filter and restores normal hover/click behavior.

