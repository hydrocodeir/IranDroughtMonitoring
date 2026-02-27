-- Multi-layer PostGIS schema (created by import_data.py)
--
-- Notes
-- -----
-- - Each imported dataset ("layer") has:
--     * one row in `datasets`
--     * many rows in `features`
--     * one dedicated *wide* time-series table: ts_<dataset_key>
--
-- - Wide tables are used to avoid exploding row counts (CSV contains many SPI/SPEI columns).
--
-- - Spatial index:
--     GiST index on features.geom for fast bbox queries (used by /mapdata)
--
-- - Time indexes:
--     Btree indexes on (date, feature_id) and (feature_id, date) in each ts_<dataset_key>
--     to accelerate map joins and time-series queries.

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS datasets (
  dataset_key TEXT PRIMARY KEY,
  title TEXT,
  geom_type TEXT,
  min_date DATE,
  max_date DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS features (
  dataset_key TEXT NOT NULL REFERENCES datasets(dataset_key) ON DELETE CASCADE,
  feature_id TEXT NOT NULL,
  name TEXT,
  props JSONB,
  geom geometry(Geometry, 4326) NOT NULL,
  min_date DATE,
  max_date DATE,
  PRIMARY KEY (dataset_key, feature_id)
);

CREATE INDEX IF NOT EXISTS idx_features_geom ON features USING gist (geom);
CREATE INDEX IF NOT EXISTS idx_features_name ON features (dataset_key, name);

-- Per-dataset time series tables are named: ts_<dataset_key>
-- They are created dynamically by import_data.py based on the CSV header.
-- Example:
--   CREATE TABLE ts_station (
--     feature_id TEXT NOT NULL,
--     date DATE NOT NULL,
--     spi3 DOUBLE PRECISION,
--     spei3 DOUBLE PRECISION,
--     PRIMARY KEY (feature_id, date)
--   );
--
-- Indexes per ts_<dataset_key>:
--   CREATE INDEX idx_ts_<key>_date_feature ON ts_<key> (date, feature_id);
--   CREATE INDEX idx_ts_<key>_feature_date ON ts_<key> (feature_id, date);
