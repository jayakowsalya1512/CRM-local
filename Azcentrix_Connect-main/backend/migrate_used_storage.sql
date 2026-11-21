ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS used_storage DOUBLE NOT NULL DEFAULT 0 AFTER storage_limit_mb;

UPDATE tenants AS t
SET used_storage = (
  SELECT ROUND(COALESCE(SUM(data_length + index_length), 0) / 1024 / 1024, 2)
  FROM information_schema.tables
  WHERE table_schema = t.db_name
);
