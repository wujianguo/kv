-- Migration: 0001_init
-- Creates the kv_store table and its supporting index.

CREATE TABLE IF NOT EXISTS kv_store (
  k          TEXT    PRIMARY KEY,
  v          TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expire_at  INTEGER           -- NULL means never expires; Unix milliseconds
);

-- Index used by the scheduled cleanup job that deletes expired rows.
CREATE INDEX IF NOT EXISTS idx_kv_store_expire_at ON kv_store (expire_at);
