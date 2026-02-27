-- Station dataset schema (PostGIS)
--
-- NOTE: `station_timeseries` index columns (spi*/spei*/...) are created
-- dynamically by `import_data.py` from the CSV header.
--
-- Spatial indexing is done with GiST on stations.geom.

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS stations (
  station_id TEXT PRIMARY KEY,
  station_name TEXT,
  props JSONB,
  geom geometry(Point, 4326) NOT NULL
);

-- Spatial index for fast bbox queries.
CREATE INDEX IF NOT EXISTS idx_stations_geom ON stations USING gist (geom);

CREATE TABLE IF NOT EXISTS station_timeseries (
  station_id TEXT NOT NULL REFERENCES stations(station_id) ON DELETE CASCADE,
  date DATE NOT NULL,
  -- <dynamic numeric columns from data.csv header>
  PRIMARY KEY (station_id, date)
);

-- Fast map lookup for a month: WHERE date = ...
CREATE INDEX IF NOT EXISTS idx_station_timeseries_date_station ON station_timeseries (date, station_id);

-- Fast station drilldown: WHERE station_id = ... ORDER BY date
CREATE INDEX IF NOT EXISTS idx_station_timeseries_station_date ON station_timeseries (station_id, date);
