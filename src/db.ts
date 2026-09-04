import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";

mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, "fleet.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS devices (
  device_id   TEXT PRIMARY KEY,
  descriptor  TEXT NOT NULL,          -- JSON: model, soc, ram_mb, os, app_ver
  pools       TEXT NOT NULL,          -- JSON array: what the runner reports
  last_seen   TEXT NOT NULL,
  last_beacon TEXT,                   -- JSON: most recent beacon sample
  -- Operator-set fields. The runner rewrites the pools column on every
  -- register, so an edit sharing it would be clobbered within the minute:
  -- the device says what it thinks it is, the operator overrides, and neither
  -- erases the other. Effective pools = override ?? reported.
  pools_override TEXT,
  -- What the agent says it can run; see the migration below for why NULL is
  -- permissive rather than empty.
  capabilities   TEXT,
  -- /24 prefix the agent last registered from; see the migration below.
  last_net       TEXT,
  -- The device's name. Not a nickname beside its id: the id is what the runner
  -- reports and what job specs pin, and this is what a person calls the thing.
  name           TEXT,
  notes          TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
  job_id      TEXT PRIMARY KEY,
  executor    TEXT NOT NULL CHECK (executor IN ('device','host')),
  workload    TEXT NOT NULL,
  spec        TEXT NOT NULL,          -- full JSON job spec
  -- 'cancelled' is not 'failed': a failed job means something went wrong, a
  -- cancelled one means a person stopped it. Collapsing them would lie in the
  -- dashboard's failure counts and in every alert built on them.
  status      TEXT NOT NULL DEFAULT 'queued'
              CHECK (status IN ('queued','claimed','done','failed','cancelled')),
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
  last_error     TEXT,
  -- Claim order is priority DESC, created_at ASC: a job promoted from the
  -- dashboard jumps the queue without its created_at being falsified.
  priority       INTEGER NOT NULL DEFAULT 0,
  -- Recorded at fan-out time. The parent id has no row of its own, so without
  -- this the relationship can only be inferred from the id string.
  parent_job_id  TEXT,
  template_id    TEXT
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

-- Visual-regression baselines: for (suite, page, profile), which artifact is
-- the accepted truth. The artifact store is content-addressed and immutable;
-- this table is the mutable pointer into it. Accepting a new baseline
-- overwrites the row — history lives in the results that captured each shot,
-- not here. Rows referenced here must survive any future artifact GC.
CREATE TABLE IF NOT EXISTS baselines (
  suite       TEXT NOT NULL,          -- web-specs/<suite>, as the job's suite.flows names it
  page        TEXT NOT NULL,          -- shots.json page name
  profile     TEXT NOT NULL,          -- playwright.config.ts project name
  sha256      TEXT NOT NULL,
  accepted_at TEXT NOT NULL DEFAULT (datetime('now')),
  accepted_from_job TEXT,             -- the web-shots job the accepted shot came from
  PRIMARY KEY (suite, page, profile)
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
-- Alerts are state, not events: one row per (rule, subject) while the condition
-- holds, resolved when it stops. A device that is offline for six hours is one
-- row with a rising seen_count, not 360 notifications.
CREATE TABLE IF NOT EXISTS alerts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  rule         TEXT NOT NULL,
  subject      TEXT NOT NULL,          -- device_id, job_id, schedule id, or 'collector'
  severity     TEXT NOT NULL,
  message      TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'open'
               CHECK (state IN ('open','acked','snoozed','resolved')),
  first_seen   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen    TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at  TEXT,
  snooze_until TEXT,
  seen_count   INTEGER NOT NULL DEFAULT 1,
  notified     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_alerts_state ON alerts (state, rule, subject);

-- Host executors announce themselves by polling for work, so their liveness is
-- already observable — it just was not recorded. Without this, a dashboard can
-- show a queue full of host jobs and no way to tell that the executor driving
-- them died three hours ago.
CREATE TABLE IF NOT EXISTS executors (
  name       TEXT PRIMARY KEY,
  last_seen  TEXT NOT NULL,
  last_job   TEXT,
  polls      INTEGER NOT NULL DEFAULT 0
);

-- Saved job specs for the dashboard composer: the "run the nightly benchmark
-- again, now" button without retyping a spec. A template is a job spec with no
-- job_id, exactly like a schedule's template.
CREATE TABLE IF NOT EXISTS job_templates (
  id         TEXT PRIMARY KEY,
  name       TEXT,
  spec       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);

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
  ["priority", "priority INTEGER NOT NULL DEFAULT 0"],
  ["parent_job_id", "parent_job_id TEXT"],
  ["template_id", "template_id TEXT"],
] as const) {
  if (!jobColumns.has(column)) db.exec(`ALTER TABLE jobs ADD COLUMN ${ddl}`);
}

// An artifact used to be an anonymous blob: a hash, a filename and a size. That
// is why a nightly had to pin a literal sha256 by hand, and why one of them
// spent six days testing an APK older than the code it was meant to guard.
// Recording which app and build an artifact IS lets a schedule ask for the
// latest one instead of a hash somebody has to remember to update.
const artifactColumns = new Set(
  (db.prepare("PRAGMA table_info(artifacts)").all() as { name: string }[]).map((c) => c.name),
);
for (const [column, ddl] of [
  ["app", "app TEXT"],
  ["build", "build TEXT"],
  ["platform", "platform TEXT"],
  // NOT created_at. The store is content-addressed, so re-uploading bytes that
  // already exist is an ignored insert and created_at keeps its original value
  // -- which means a revert that republishes an earlier build looks OLDER than
  // the build it just replaced, and `latest` resolves to the wrong one.
  // published_at is when this content was last claimed by an app.
  ["published_at", "published_at TEXT"],
  // And publish_seq is what `latest` actually orders by. A timestamp cannot do
  // it: datetime('now') is second-granular, so two publishes in the same second
  // tie, and the only tiebreak left is rowid -- which for a content-addressed
  // row is the order the BYTES were first seen, not the order they were
  // published. That is precisely backwards for a revert. A counter has neither
  // problem.
  ["publish_seq", "publish_seq INTEGER"],
  // A pin says "never collect this, whatever the reference scan concludes".
  // The scan reads job specs, results, schedules and templates — it cannot see
  // an accepted visual baseline, whose whole job is to still be there in six
  // months to diff against. Once build and model-convert start producing
  // artifacts nightly, GC stops being hypothetical and that blind spot becomes
  // a deleted baseline and a visual suite with nothing to compare to.
  ["pinned", "pinned INTEGER NOT NULL DEFAULT 0"],
  ["pin_reason", "pin_reason TEXT"],
] as const) {
  if (!artifactColumns.has(column)) db.exec(`ALTER TABLE artifacts ADD COLUMN ${ddl}`);
}
// Existing rows predate the column; their upload time is the best available
// answer and is correct for everything that was never republished.
db.exec("UPDATE artifacts SET published_at = created_at WHERE published_at IS NULL");
// Existing rows were never republished, so first-seen order IS publish order
// for them; seed the counter from rowid so it stays monotonic from here.
db.exec("UPDATE artifacts SET publish_seq = rowid WHERE publish_seq IS NULL");
// The lookup a nightly does every time it fires.
db.exec("CREATE INDEX IF NOT EXISTS idx_artifacts_app ON artifacts (app, publish_seq DESC)");

// `nickname` was the wrong word: it implied a second label beside the id rather
// than the device's name. Renamed in place so existing names carry over — this
// must happen before the add-column loop below, or that loop would add an empty
// `name` beside the populated `nickname` and orphan every name already set.
{
  const cols = new Set(
    (db.prepare("PRAGMA table_info(devices)").all() as { name: string }[]).map((c) => c.name),
  );
  if (cols.has("nickname") && !cols.has("name")) {
    db.exec("ALTER TABLE devices RENAME COLUMN nickname TO name");
  }
}

const deviceColumns = new Set(
  (db.prepare("PRAGMA table_info(devices)").all() as { name: string }[]).map((c) => c.name),
);
for (const [column, ddl] of [
  ["pools_override", "pools_override TEXT"],
  ["name", "name TEXT"],
  ["notes", "notes TEXT"],
  // What this agent says it can run. A pool is a label a person applied; a
  // capability is a statement about the agent's own code and toolchain, which
  // is why the queue routes on it and an operator cannot override it.
  // NULL means an agent registered before capabilities existed: it is offered
  // everything, exactly as it was before, rather than silently offered nothing.
  ["capabilities", "capabilities TEXT"],
  // The network the agent last registered from, as a /24 prefix. Once agents
  // roam, "six devices offline" and "six devices on another network" look
  // identical in the registry and mean opposite things — the dashboard
  // screenshots taken from the wrong LAN read as an abandoned fleet for
  // exactly this reason. A prefix, not the full address: enough to tell one
  // place from another, not a log of where a laptop has been.
  ["last_net", "last_net TEXT"],
] as const) {
  if (!deviceColumns.has(column)) db.exec(`ALTER TABLE devices ADD COLUMN ${ddl}`);
}

// A CHECK constraint cannot be widened with ALTER, so a database created before
// 'cancelled' existed would reject every cancellation with a constraint error.
// SQLite's supported fix is to rebuild the table. Every column above exists by
// now, so the copy can name them explicitly rather than trusting SELECT *.
const jobsDdl = (
  db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'").get() as
    | { sql: string }
    | undefined
)?.sql;
if (jobsDdl && !jobsDdl.includes("'cancelled'")) {
  const COLUMNS = [
    "job_id", "executor", "workload", "spec", "status", "created_at", "claimed_by", "claimed_at",
    "finished_at", "lease_ttl_s", "max_attempts", "attempts", "lease_deadline", "last_error",
    "priority", "parent_job_id", "template_id",
  ].join(", ");
  db.exec("PRAGMA foreign_keys = off");
  db.transaction(() => {
    db.exec(`
      CREATE TABLE jobs_migrating (
        job_id      TEXT PRIMARY KEY,
        executor    TEXT NOT NULL CHECK (executor IN ('device','host')),
        workload    TEXT NOT NULL,
        spec        TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','claimed','done','failed','cancelled')),
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        claimed_by  TEXT,
        claimed_at  TEXT,
        finished_at TEXT,
        lease_ttl_s    INTEGER NOT NULL DEFAULT 600,
        max_attempts   INTEGER NOT NULL DEFAULT 3,
        attempts       INTEGER NOT NULL DEFAULT 0,
        lease_deadline TEXT,
        last_error     TEXT,
        priority       INTEGER NOT NULL DEFAULT 0,
        parent_job_id  TEXT,
        template_id    TEXT
      );
      INSERT INTO jobs_migrating (${COLUMNS}) SELECT ${COLUMNS} FROM jobs;
      DROP TABLE jobs;
      ALTER TABLE jobs_migrating RENAME TO jobs;
    `);
  })();
  db.exec("PRAGMA foreign_keys = on");
}

// After the ALTERs and the rebuild: on a pre-lease database the column does not
// exist yet when the CREATE TABLE block above runs, and DROP TABLE takes every
// index on the old table with it.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_jobs_lease ON jobs (status, lease_deadline);
  CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs (status, executor, priority DESC, created_at);
  CREATE INDEX IF NOT EXISTS idx_jobs_parent ON jobs (parent_job_id);
`);

// Jobs claimed before leases existed have no deadline and would never be swept.
// Treat them as claimed right now: they get one lease window to report in.
db.prepare(
  `UPDATE jobs SET lease_deadline = datetime('now', '+' || lease_ttl_s || ' seconds'),
                   attempts = MAX(attempts, 1)
   WHERE status = 'claimed' AND lease_deadline IS NULL`,
).run();
