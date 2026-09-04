// Operational reads: health, system, schedules, artifacts, events, locks.
import type { FastifyInstance } from "fastify";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { db } from "../db.js";
import {
  ARTIFACT_DIR,
  DATA_DIR,
  GITHUB_STATUS_ARMED,
  GITHUB_TOKEN,
  LOG_FILE,
  POWER_CONFIG_PATH,
  SCHEDULER_TICK_MS,
  SWEEP_MS,
} from "../config.js";
import { minuteKey, nextRun, prevRun } from "../cron.js";
import { THRESHOLDS, webhookConfigured } from "../alerts.js";
import { guardEnabled } from "./guard.js";
import { AGE, iso, paging, parse, sha256Refs, tableCounts } from "./shared.js";
import { clientCount, SERVER_INSTANCE, STARTED_AT } from "./stream.js";

const bytesOf = (file: string) => {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
};

// A stat per file is cheap, but not unbounded: this runs on a 2016 MacBook
// whose real job is serving long-polls. Past the cap the page says so rather
// than quietly reporting a total that covers part of the directory.
const SCAN_CAP = 20_000;

/** Size of the artifact store on disk, not the sum of the `size` column: a
 *  file left behind by an interrupted upload counts against the disk even
 *  though no row references it. */
function artifactDiskUsage() {
  try {
    const names = readdirSync(ARTIFACT_DIR);
    const scanned = names.slice(0, SCAN_CAP);
    let bytes = 0;
    for (const n of scanned) bytes += bytesOf(path.join(ARTIFACT_DIR, n));
    return {
      files: names.length,
      // How many of those `files` the byte total actually covers. Equal to
      // files in every normal case; smaller means `bytes` is a floor.
      scanned: scanned.length,
      bytes,
      truncated: names.length > scanned.length,
    };
  } catch {
    return { files: 0, scanned: 0, bytes: 0, truncated: false };
  }
}

export function health() {
  return {
    ok: true,
    instance: SERVER_INSTANCE,
    started_at: STARTED_AT.toISOString(),
    uptime_s: Math.floor(process.uptime()),
    now: new Date().toISOString(),
    node: process.version,
    pid: process.pid,
    stream_clients: clientCount(),
    // Lets the dashboard ask for a token up front instead of discovering the
    // requirement through a 401 on the user's first cancel.
    guard: guardEnabled(),
  };
}

export type ScheduleView = ReturnType<typeof schedulesView>[number];

export function schedulesView(now = new Date()) {
  const rows = db.prepare("SELECT * FROM schedules ORDER BY id").all() as {
    id: string;
    cron: string;
    template: string;
    enabled: number;
    last_run: string | null;
    created_at: string;
  }[];

  return rows.map((s) => {
    const next = nextRun(s.cron, now);
    const prev = prevRun(s.cron, now);
    // Only a schedule that has fired before can be *missed*: a freshly enabled
    // one has no history to be late against, and calling that an alert would
    // cry wolf every time someone flips a toggle.
    const missed =
      !!s.enabled &&
      prev != null &&
      s.last_run != null &&
      s.last_run !== minuteKey(prev) &&
      // Same threshold the schedule-missed alert uses, so this page and the
      // alert banner can never disagree about whether a schedule is late.
      now.getTime() - prev.getTime() > THRESHOLDS.scheduleLateS * 1000;
    const template = parse<Record<string, any>>(s.template, {});
    return {
      id: s.id,
      cron: s.cron,
      enabled: !!s.enabled,
      last_run: s.last_run,
      next_run: next ? next.toISOString() : null,
      next_run_in_s: next ? Math.round((next.getTime() - now.getTime()) / 1000) : null,
      prev_expected: prev ? prev.toISOString() : null,
      missed,
      late_by_s: missed && prev ? Math.round((now.getTime() - prev.getTime()) / 1000) : null,
      workload: template.workload ?? null,
      executor: template.executor ?? null,
      fanout: !!template.fanout,
      pool: template.targets?.pool ?? null,
      template,
    };
  });
}

export function registerSystem(app: FastifyInstance) {
  app.get("/api/health", async () => health());

  app.get("/api/system", async () => {
    const dbFiles = ["fleet.db", "fleet.db-wal", "fleet.db-shm"].map((f) => ({
      file: f,
      bytes: bytesOf(path.join(DATA_DIR, f)),
    }));
    const power = (() => {
      try {
        const cfg = JSON.parse(readFileSync(POWER_CONFIG_PATH, "utf8")) as {
          pools?: Record<string, Record<string, string>>;
        };
        // Webhook URLs can carry device tokens; the dashboard needs to know a
        // pool is controllable, never the secret that controls it.
        return { configured: true, pools: Object.keys(cfg.pools ?? {}) };
      } catch {
        return { configured: false, pools: [] as string[] };
      }
    })();

    return {
      health: health(),
      paths: { data_dir: DATA_DIR, artifact_dir: ARTIFACT_DIR, log_file: LOG_FILE, power_config: POWER_CONFIG_PATH },
      db: { files: dbFiles, bytes: dbFiles.reduce((a, f) => a + f.bytes, 0), counts: tableCounts() },
      artifacts: artifactDiskUsage(),
      log: { path: LOG_FILE, exists: existsSync(LOG_FILE), bytes: bytesOf(LOG_FILE) },
      intervals: { sweep_ms: SWEEP_MS, scheduler_tick_ms: SCHEDULER_TICK_MS },
      ci: {
        // Armed means a closing job posts a real commit status to GitHub.
        armed: GITHUB_STATUS_ARMED && !!GITHUB_TOKEN,
        status_flag: GITHUB_STATUS_ARMED,
        token_present: !!GITHUB_TOKEN,
      },
      power,
    };
  });

  app.get("/api/schedules", async () => ({ schedules: schedulesView() }));

  app.get("/api/alerts", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    // Open by default: resolved history is available but is not what a banner
    // or a glance at the shelf is asking about.
    const states = (q.state ?? "open,acked,snoozed").split(",").filter(Boolean);
    const rows = db
      .prepare(
        `SELECT *, ${AGE("first_seen")} AS age_s FROM alerts
         WHERE state IN (${states.map(() => "?").join(",")})
         ORDER BY CASE severity WHEN 'critical' THEN 0 ELSE 1 END, last_seen DESC LIMIT 200`,
      )
      .all(...states) as (Record<string, unknown> & { first_seen: string; last_seen: string; resolved_at: string | null; snooze_until: string | null })[];

    return {
      alerts: rows.map((a) => ({
        ...a,
        notified: !!a.notified,
        first_seen: iso(a.first_seen),
        last_seen: iso(a.last_seen),
        resolved_at: iso(a.resolved_at),
        snooze_until: iso(a.snooze_until),
      })),
      counts: Object.fromEntries(
        (db.prepare("SELECT state, COUNT(*) AS n FROM alerts GROUP BY state").all() as { state: string; n: number }[]).map(
          (r) => [r.state, r.n],
        ),
      ),
      // So the UI can say whether anything beyond the dashboard will hear it.
      webhook: webhookConfigured(),
      thresholds: THRESHOLDS,
    };
  });

  // Host-executor liveness, derived from their long-poll traffic. A host job
  // queued behind a dead executor is indistinguishable from a slow one without
  // this.
  app.get("/api/executors", async () => ({
    executors: (
      db
        .prepare(`SELECT name, last_seen, last_job, polls, ${AGE("last_seen")} AS age_s FROM executors ORDER BY last_seen DESC`)
        .all() as { name: string; last_seen: string; last_job: string | null; polls: number; age_s: number }[]
    ).map((e) => ({
      ...e,
      last_seen: iso(e.last_seen),
      // The long poll is ~25 s, so a healthy executor is never quiet for long.
      status: e.age_s <= 90 ? "polling" : e.age_s <= 600 ? "quiet" : "gone",
    })),
    queued_host_jobs: (
      db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued' AND executor = 'host'").get() as { n: number }
    ).n,
  }));

  app.get("/api/status-reports", async () => ({
    reports: (
      db.prepare("SELECT * FROM status_reports ORDER BY created_at DESC LIMIT 100").all() as {
        job_id: string;
        target: string;
        state: string;
        posted: number;
        detail: string | null;
        created_at: string;
      }[]
    ).map((r) => ({ ...r, posted: !!r.posted, created_at: iso(r.created_at) })),
  }));

  app.get("/api/locks", async () => ({
    locks: (
      db.prepare(`SELECT device_id, job_id, acquired_at, ${AGE("acquired_at")} AS held_s FROM device_locks ORDER BY acquired_at`).all() as {
        device_id: string;
        job_id: string;
        acquired_at: string;
        held_s: number;
      }[]
    ).map((l) => ({ ...l, acquired_at: iso(l.acquired_at) })),
  }));

  app.get("/api/artifacts", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const { page, per_page, offset } = paging(q);
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.q) {
      // App name too: "which builds do I have for greenfolio-android" is the
      // question you ask once artifacts know what they are.
      where.push("(name LIKE ? OR sha256 LIKE ? OR app LIKE ?)");
      params.push(`%${q.q}%`, `${q.q}%`, `%${q.q}%`);
    }
    if (q.app) {
      where.push("app = ?");
      params.push(q.app);
    }
    const sql = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM artifacts${sql}`).get(...params) as { n: number }).n;
    const rows = db
      .prepare(
        `SELECT sha256, name, size, created_at, app, build, platform, published_at, pinned, pin_reason
           FROM artifacts${sql}
          ORDER BY COALESCE(publish_seq, rowid) DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, per_page, offset) as {
        sha256: string; name: string | null; size: number; created_at: string;
        app: string | null; build: string | null; platform: string | null; published_at: string | null;
        pinned: number; pin_reason: string | null;
      }[];

    const baselineShas = new Set(
      (db.prepare("SELECT sha256 FROM baselines").all() as { sha256: string }[]).map((b) => b.sha256),
    );

    // One pass over recent specs and result payloads builds the whole
    // reference map; the alternative is a LIKE scan per artifact.
    const refs = new Map<string, number>();
    for (const { blob } of [
      ...(db.prepare("SELECT spec AS blob FROM jobs ORDER BY created_at DESC LIMIT 5000").all() as { blob: string }[]),
      ...(db.prepare("SELECT payload AS blob FROM results ORDER BY created_at DESC LIMIT 5000").all() as {
        blob: string;
      }[]),
    ]) {
      for (const sha of sha256Refs(blob)) refs.set(sha, (refs.get(sha) ?? 0) + 1);
    }

    return {
      page,
      per_page,
      total,
      pages: Math.max(1, Math.ceil(total / per_page)),
      artifacts: rows.map((a) => ({
        ...a,
        created_at: iso(a.created_at),
        published_at: a.published_at ? iso(a.published_at) : null,
        on_disk: existsSync(path.join(ARTIFACT_DIR, a.sha256)),
        references: refs.get(a.sha256) ?? 0,
        pinned: !!a.pinned,
        pin_reason: a.pin_reason,
        // A baseline reference is a row, not text in a spec, so it never shows
        // up in the reference count. Surfaced separately rather than folded in,
        // because "referenced by 0 things but undeletable" is the confusing
        // state this is here to explain.
        baseline: baselineShas.has(a.sha256),
      })),
    };
  });

  app.get("/api/events", async () => ({
    topics: (
      db
        .prepare(
          `SELECT topic, COUNT(*) AS count, MAX(id) AS last_id, MAX(created_at) AS last_at
           FROM events GROUP BY topic ORDER BY last_at DESC`,
        )
        .all() as { topic: string; count: number; last_id: number; last_at: string }[]
    ).map((t) => ({ ...t, last_at: iso(t.last_at) })),
  }));

  app.get("/api/events/:topic", async (req) => {
    const { topic } = req.params as { topic: string };
    const q = req.query as Record<string, string | undefined>;
    const limit = Math.min(500, Math.max(1, Number(q.limit ?? 50) || 50));
    const rows = db
      .prepare("SELECT id, payload, created_at FROM events WHERE topic = ? ORDER BY id DESC LIMIT ?")
      .all(topic, limit) as { id: number; payload: string; created_at: string }[];
    return {
      topic,
      events: rows.map((e) => ({ id: e.id, created_at: iso(e.created_at), payload: parse(e.payload, {}) })),
    };
  });
}
