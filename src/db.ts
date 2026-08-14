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
  finished_at TEXT,
  -- Lease: a claim is only good until lease_deadline. Beacons renew it, the
  -- sweep requeues it when it lapses, so a runner that dies mid-job (OOM kill,
  -- flat battery, yanked cable) does not strand the job in 'claimed' forever.
  lease_ttl_s    INTEGER NOT NULL DEFAULT 600,
  max_attempts   INTEGER NOT NULL DEFAULT 3,
  attempts       INTEGER NOT NULL DEFAULT 0,
  lease_deadline TEXT,
  last_error     TEXT
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

CREATE TABLE IF NOT EXISTS schedules (
  id         TEXT PRIMARY KEY,
  cron       TEXT NOT NULL,           -- 5-field cron expression
  template   TEXT NOT NULL,           -- JSON job spec without job_id
  enabled    INTEGER NOT NULL DEFAULT 0,
  last_run   TEXT,                    -- ISO minute of the last firing (dedup)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A device works one job at a time. Device-executor claims take the lock
-- implicitly; the host executor acquires explicitly for exclusive jobs.
CREATE TABLE IF NOT EXISTS device_locks (
  device_id   TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL,
  acquired_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Pipeline event rails: publish/subscribe without an external broker. Old
-- devices publish trigger events; capable devices subscribe, process, and
-- publish results to a sibling topic.
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  topic      TEXT NOT NULL,
  payload    TEXT NOT NULL,           -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_topic_id ON events (topic, id);

-- Every job that asked for a GitHub commit status gets a row here when it
-- closes. posted=0 rows are dry runs: reporting is off (the default) or the
-- POST failed — the audit trail exists either way, so turning CI on later
-- changes behavior, not bookkeeping.
CREATE TABLE IF NOT EXISTS status_reports (
  job_id     TEXT NOT NULL,
  target     TEXT NOT NULL,            -- owner/repo@sha
  state      TEXT NOT NULL,            -- success | failure
  posted     INTEGER NOT NULL DEFAULT 0,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (job_id, target)
);
`);

// CREATE TABLE IF NOT EXISTS is a no-op on a database that predates a column,
// so added columns need an explicit ALTER for existing collector installs.
const jobColumns = new Set(
  (db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]).map((c) => c.name),
);
for (const [column, ddl] of [
  ["lease_ttl_s", "lease_ttl_s INTEGER NOT NULL DEFAULT 600"],
  ["max_attempts", "max_attempts INTEGER NOT NULL DEFAULT 3"],
  ["attempts", "attempts INTEGER NOT NULL DEFAULT 0"],
  ["lease_deadline", "lease_deadline TEXT"],
  ["last_error", "last_error TEXT"],
] as const) {
  if (!jobColumns.has(column)) db.exec(`ALTER TABLE jobs ADD COLUMN ${ddl}`);
}

// After the ALTERs: on a pre-lease database the column does not exist yet when
// the CREATE TABLE block above runs.
db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_lease ON jobs (status, lease_deadline);");

// Jobs claimed before leases existed have no deadline and would never be swept.
// Treat them as claimed right now: they get one lease window to report in.
db.prepare(
  `UPDATE jobs SET lease_deadline = datetime('now', '+' || lease_ttl_s || ' seconds'),
                   attempts = MAX(attempts, 1)
   WHERE status = 'claimed' AND lease_deadline IS NULL`,
).run();
