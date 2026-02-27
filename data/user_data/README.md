# (Deprecated) user_data folders

Older versions of this project read CSV/GeoJSON files directly at runtime.
That design caused severe performance issues on large datasets.

✅ The current version **does not** read from `data/user_data/*` while running.

Use the new import flow:

1) Place your files (import-only):

Single dataset (imports as `station`):

- `data/import/data.csv`
- `data/import/geoinfo.geojson`

Or multiple datasets:

- `data/import/<dataset_key>/data.csv`
- `data/import/<dataset_key>/geoinfo.geojson`

2) Run the one-time import:

```bash
python import_data.py --replace
```

After import, the dashboard loads everything from the PostGIS database.
