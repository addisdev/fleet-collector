import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.FLEET_DATA_DIR ?? path.resolve("data");
mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, "fleet.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS devices (
  device_id   TEXT PRIMARY KEY,
  descriptor  TEXT NOT NULL,          -- JSON: model, soc, ram_mb, os, app_ver
  pools       TEXT NOT NULL,          -- JSON array of pool tags
  last_seen   TEXT NOT NULL,
  last_beacon TEXT                    -- JSON: most recent beacon sample
);

CREATE TABLE IF NOT EXISTS jobs (
  job_id      TEXT PRIMARY KEY,
  executor    TEXT NOT NULL CHECK (executor IN ('device','host')),
  workload    TEXT NOT NULL,
  spec        TEXT NOT NULL,          -- full JSON job spec
  status      TEXT NOT NULL DEFAULT 'queued'
              CHECK (status IN ('queued','claimed','done','failed')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  claimed_by  TEXT,
  claimed_at  TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS results (
  job_id     TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  iter       INTEGER NOT NULL DEFAULT 0,
  payload    TEXT NOT NULL,           -- full JSON result row
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (job_id, device_id, iter)
);

CREATE TABLE IF NOT EXISTS beacon_samples (
  device_id  TEXT NOT NULL,
  ts         TEXT NOT NULL DEFAULT (datetime('now')),
  job_id     TEXT,
  sample     TEXT NOT NULL            -- JSON beacon payload
);
CREATE INDEX IF NOT EXISTS idx_beacon_device_ts ON beacon_samples (device_id, ts);

CREATE TABLE IF NOT EXISTS artifacts (
  sha256     TEXT PRIMARY KEY,
  name       TEXT,
  size       INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
