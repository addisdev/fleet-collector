import Fastify from "fastify";
import { createHash } from "node:crypto";
import { createReadStream, statSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { db } from "./db.js";
import { renderDash } from "./dash.js";
import { cronMatches, isValidCron, minuteKey } from "./cron.js";

const PORT = Number(process.env.FLEET_PORT ?? 8787);
const ARTIFACT_DIR = process.env.FLEET_ARTIFACT_DIR ?? path.resolve("artifacts/store");
mkdirSync(ARTIFACT_DIR, { recursive: true });

const LONG_POLL_S = 25;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Lease defaults. A claim expires unless the runner keeps renewing it via
// beacons; the sweep then requeues the job (up to max_attempts) so a dead
// runner cannot strand work in 'claimed'.
const DEFAULT_LEASE_TTL_S = 600;
// drain and soak legitimately run for hours between beacons.
const LONG_LEASE_TTL_S = 4 * 60 * 60;
const LONG_LEASE_WORKLOADS = new Set(["drain", "soak"]);
const MAX_LEASE_TTL_S = 24 * 60 * 60;
const DEFAULT_MAX_ATTEMPTS = 3;
const SWEEP_MS = Number(process.env.FLEET_SWEEP_MS ?? 15_000);

const app = Fastify({ logger: { level: process.env.FLEET_LOG ?? "info" } });

// Artifact uploads arrive as raw bytes. Buffered in memory for Phase 0;
// streaming upload is a Phase 2 concern (app builds are ~100 MB, models a few GB).
app.addContentTypeParser(
  "application/octet-stream",
  { parseAs: "buffer", bodyLimit: 4 * 1024 * 1024 * 1024 },
  (_req, body, done) => done(null, body),
);

type JobSpec = {
  schema: number;
  job_id: string;
  workload: string;
  executor: "device" | "host";
  fanout?: boolean;
  targets?: { pool?: string; match?: string; exclusive?: boolean; device_id?: string };
  lease?: { ttl_s?: number; max_attempts?: number };
  [k: string]: unknown;
};

const SCHEDULER_TICK_MS = Number(process.env.FLEET_SCHEDULER_TICK_MS ?? 20_000);
const POWER_CONFIG_PATH = process.env.FLEET_POWER_CONFIG ?? path.resolve("power.json");

// CI integration is BUILT BUT OFF. Statuses are recorded (posted=0) unless
// both are set: FLEET_GITHUB_STATUS=1 arms posting, FLEET_GITHUB_TOKEN
// authenticates it. Nothing else in the system reads these.
const GITHUB_STATUS_ARMED = process.env.FLEET_GITHUB_STATUS === "1";
const GITHUB_TOKEN = process.env.FLEET_GITHUB_TOKEN;
const GITHUB_API = process.env.FLEET_GITHUB_API ?? "https://api.github.com";

const WORKLOADS = new Set(["benchmark", "batch", "pipeline", "install", "ui-test", "drain", "soak"]);

function touchDevice(deviceId: string) {
  db.prepare("UPDATE devices SET last_seen = datetime('now') WHERE device_id = ?").run(deviceId);
}

// Atomically claim the oldest queued job this claimant is eligible for, and
// start its lease clock.
const claimTx = db.transaction((executor: string, claimant: string, devicePools: string[]): JobSpec | null => {
  if (executor === "device") {
    // A host-executor job holding this device (exclusive ui-test, drain…)
    // means the agent must idle until the lock is released.
    const locked = db.prepare("SELECT job_id FROM device_locks WHERE device_id = ?").get(claimant);
    if (locked) return null;
  }
  const rows = db
    .prepare("SELECT job_id, spec FROM jobs WHERE status = 'queued' AND executor = ? ORDER BY created_at")
    .all(executor) as { job_id: string; spec: string }[];
  for (const row of rows) {
    const spec = JSON.parse(row.spec) as JobSpec;
    if (executor === "device") {
      if (spec.targets?.device_id && spec.targets.device_id !== claimant) continue;
      const pool = spec.targets?.pool;
      if (pool && !devicePools.includes(pool)) continue;
    }
    db.prepare(
      `UPDATE jobs SET status = 'claimed', claimed_by = ?, claimed_at = datetime('now'),
                       attempts = attempts + 1,
                       lease_deadline = datetime('now', '+' || lease_ttl_s || ' seconds')
       WHERE job_id = ?`,
    ).run(claimant, row.job_id);
    if (executor === "device") {
      db.prepare("INSERT OR REPLACE INTO device_locks (device_id, job_id) VALUES (?, ?)").run(
        claimant, row.job_id,
      );
    }
    return spec;
  }
  return null;
});

async function longPollClaim(executor: "device" | "host", claimant: string, pools: string[]) {
  for (let i = 0; i < LONG_POLL_S; i++) {
    const spec = claimTx(executor, claimant, pools);
    if (spec) return spec;
    await sleep(1000);
  }
  return null;
}

// --- lease sweep ---

type SweptJob = { job_id: string; claimed_by: string | null; attempts: number };

// Requeue claims whose lease lapsed; give up on jobs that burned all attempts.
const sweepLeasesTx = db.transaction((): { requeued: SweptJob[]; failed: SweptJob[] } => {
  const expired = db
    .prepare(
      `SELECT job_id, claimed_by, attempts, max_attempts FROM jobs
       WHERE status = 'claimed' AND lease_deadline IS NOT NULL AND lease_deadline <= datetime('now')`,
    )
    .all() as (SweptJob & { max_attempts: number })[];

  const requeue = db.prepare(
    `UPDATE jobs SET status = 'queued', claimed_by = NULL, claimed_at = NULL,
                     lease_deadline = NULL, last_error = ?
     WHERE job_id = ?`,
  );
  const giveUp = db.prepare(
    `UPDATE jobs SET status = 'failed', finished_at = datetime('now'),
                     lease_deadline = NULL, last_error = ?
     WHERE job_id = ?`,
  );

  const requeued: SweptJob[] = [];
  const failed: SweptJob[] = [];
  const dropLocks = db.prepare("DELETE FROM device_locks WHERE job_id = ?");
  for (const job of expired) {
    const who = job.claimed_by ?? "unknown claimant";
    if (job.attempts >= job.max_attempts) {
      giveUp.run(`lease expired on ${who}; gave up after ${job.attempts}/${job.max_attempts} attempts`, job.job_id);
      failed.push(job);
    } else {
      requeue.run(`lease expired on ${who}; requeued after attempt ${job.attempts}/${job.max_attempts}`, job.job_id);
      requeued.push(job);
    }
    dropLocks.run(job.job_id);
  }
  return { requeued, failed };
});

function sweepLeases() {
  const swept = sweepLeasesTx();
  for (const j of swept.requeued)
    app.log.warn({ job_id: j.job_id, claimed_by: j.claimed_by, attempt: j.attempts }, "lease expired; requeued");
  for (const j of swept.failed)
    app.log.error({ job_id: j.job_id, claimed_by: j.claimed_by, attempts: j.attempts }, "lease expired; job failed");
  return swept;
}

// --- devices ---

app.post("/devices/register", async (req, reply) => {
  const b = req.body as { device_id?: string; descriptor?: object; pools?: string[] };
  if (!b?.device_id) return reply.code(400).send({ error: "device_id required" });
  db.prepare(
    `INSERT INTO devices (device_id, descriptor, pools, last_seen)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(device_id) DO UPDATE SET
       descriptor = excluded.descriptor, pools = excluded.pools, last_seen = excluded.last_seen`,
  ).run(b.device_id, JSON.stringify(b.descriptor ?? {}), JSON.stringify(b.pools ?? []));
  return { ok: true };
});

app.get("/devices/:id/next-job", async (req, reply) => {
  const { id } = req.params as { id: string };
  const dev = db.prepare("SELECT pools FROM devices WHERE device_id = ?").get(id) as
    | { pools: string }
    | undefined;
  if (!dev) return reply.code(404).send({ error: "unknown device; register first" });
  touchDevice(id);
  const spec = await longPollClaim("device", id, JSON.parse(dev.pools));
  if (!spec) return reply.code(204).send();
  return spec;
});

app.get("/executor/next-job", async (req, reply) => {
  const claimant = ((req.query as Record<string, string>).name ?? "host-executor");
  const spec = await longPollClaim("host", claimant, []);
  if (!spec) return reply.code(204).send();
  return spec;
});

// --- jobs ---

app.post("/jobs", async (req, reply) => {
  const spec = req.body as JobSpec;
  if (spec?.schema !== 1) return reply.code(400).send({ error: "schema must be 1" });
  if (!spec.job_id) return reply.code(400).send({ error: "job_id required" });
  if (!WORKLOADS.has(spec.workload)) return reply.code(400).send({ error: `unknown workload: ${spec.workload}` });
  if (spec.executor !== "device" && spec.executor !== "host")
    return reply.code(400).send({ error: "executor must be 'device' or 'host'" });

  if (spec.lease !== undefined && (typeof spec.lease !== "object" || spec.lease === null || Array.isArray(spec.lease)))
    return reply.code(400).send({ error: "lease must be an object" });
  const ttlS =
    spec.lease?.ttl_s ??
    (LONG_LEASE_WORKLOADS.has(spec.workload) ? LONG_LEASE_TTL_S : DEFAULT_LEASE_TTL_S);
  if (!Number.isInteger(ttlS) || ttlS < 1 || ttlS > MAX_LEASE_TTL_S)
    return reply.code(400).send({ error: `lease.ttl_s must be an integer between 1 and ${MAX_LEASE_TTL_S}` });
  const maxAttempts = spec.lease?.max_attempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1)
    return reply.code(400).send({ error: "lease.max_attempts must be an integer >= 1" });
  // Persist the effective lease so runners see it in the spec they claim and
  // can pace their beacons against it.
  spec.lease = { ttl_s: ttlS, max_attempts: maxAttempts };

  // Fan-out: one queued child per registered device in the target pool, each
  // pinned via targets.device_id. Host jobs already fan across attached
  // targets inside the executor, so fanout is a device-executor concept.
  if (spec.fanout) {
    if (spec.executor !== "device")
      return reply.code(400).send({ error: "fanout is only for executor: device" });
    const pool = spec.targets?.pool;
    const devices = (
      db.prepare("SELECT device_id, pools FROM devices").all() as { device_id: string; pools: string }[]
    ).filter((d) => !pool || (JSON.parse(d.pools) as string[]).includes(pool));
    if (devices.length === 0)
      return reply.code(400).send({ error: `no registered devices${pool ? ` in pool ${pool}` : ""}` });

    const insert = db.prepare(
      "INSERT OR IGNORE INTO jobs (job_id, executor, workload, spec, lease_ttl_s, max_attempts) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const created: string[] = [];
    for (const d of devices) {
      const child: JobSpec = {
        ...spec,
        job_id: `${spec.job_id}--${d.device_id}`,
        targets: { ...spec.targets, device_id: d.device_id },
      };
      delete child.fanout;
      const r = insert.run(child.job_id, child.executor, child.workload, JSON.stringify(child), ttlS, maxAttempts);
      if (r.changes > 0) created.push(child.job_id);
    }
    return reply.code(201).send({ ok: true, fanout: created });
  }

  try {
    db.prepare(
      "INSERT INTO jobs (job_id, executor, workload, spec, lease_ttl_s, max_attempts) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(spec.job_id, spec.executor, spec.workload, JSON.stringify(spec), ttlS, maxAttempts);
  } catch (e: unknown) {
    if ((e as { code?: string }).code === "SQLITE_CONSTRAINT_PRIMARYKEY")
      return reply.code(409).send({ error: "job_id already exists" });
    throw e;
  }
  return reply.code(201).send({ ok: true, job_id: spec.job_id });
});

// Runs on a timer too; exposed so an operator (or the smoke test) can force a
// pass instead of waiting out the interval.
app.post("/jobs/sweep", async () => {
  const swept = sweepLeases();
  return {
    ok: true,
    requeued: swept.requeued.map((j) => j.job_id),
    failed: swept.failed.map((j) => j.job_id),
  };
});

app.get("/jobs/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const job = db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(id);
  if (!job) return reply.code(404).send({ error: "not found" });
  return job;
});

// --- results ---

app.post("/results", async (req, reply) => {
  const b = req.body as {
    schema?: number; kind?: string; job_id?: string; device_id?: string;
    iter?: number; final?: boolean; ok?: boolean;
  };
  if (b?.schema !== 1) return reply.code(400).send({ error: "schema must be 1" });
  if (!b.device_id) return reply.code(400).send({ error: "device_id required" });

  if (b.kind === "beacon") {
    db.prepare("INSERT INTO beacon_samples (device_id, job_id, sample) VALUES (?, ?, ?)").run(
      b.device_id, b.job_id ?? null, JSON.stringify(b),
    );
    db.prepare("UPDATE devices SET last_beacon = ?, last_seen = datetime('now') WHERE device_id = ?").run(
      JSON.stringify(b), b.device_id,
    );
    // A beacon carrying a job_id is proof of life for that claim, so it pushes
    // the lease out. Not scoped to claimed_by: host-executor jobs are claimed by
    // the Mac executor but beacon from the device it is driving. lease_renewed
    // false tells a runner its claim is gone (swept, or already finished) and it
    // should stop work rather than keep burning the device.
    let leaseRenewed = false;
    if (b.job_id) {
      leaseRenewed =
        db
          .prepare(
            `UPDATE jobs SET lease_deadline = datetime('now', '+' || lease_ttl_s || ' seconds')
             WHERE job_id = ? AND status = 'claimed'`,
          )
          .run(b.job_id).changes > 0;
    }
    return { ok: true, lease_renewed: leaseRenewed };
  }

  if (b.kind !== "result") return reply.code(400).send({ error: "kind must be 'result' or 'beacon'" });
  if (!b.job_id) return reply.code(400).send({ error: "job_id required for kind=result" });
  // Idempotent by (job_id, device_id, iter): retried posts overwrite, never duplicate.
  db.prepare(
    "INSERT OR REPLACE INTO results (job_id, device_id, iter, payload) VALUES (?, ?, ?, ?)",
  ).run(b.job_id, b.device_id, b.iter ?? 0, JSON.stringify(b));
  touchDevice(b.device_id);

  if (b.final) {
    // Dropping the deadline takes the job out of the sweep's reach for good.
    db.prepare(
      "UPDATE jobs SET status = ?, finished_at = datetime('now'), lease_deadline = NULL WHERE job_id = ?",
    ).run(b.ok === false ? "failed" : "done", b.job_id);
    db.prepare("DELETE FROM device_locks WHERE job_id = ?").run(b.job_id);
    reportStatus(b.job_id, b.ok === false ? "failure" : "success").catch((e) =>
      app.log.error(e, "status report failed"),
    );
  }
  return { ok: true };
});

// --- GitHub commit statuses (recorded always, posted only when armed) ---

async function reportStatus(jobId: string, state: "success" | "failure") {
  const row = db.prepare("SELECT spec FROM jobs WHERE job_id = ?").get(jobId) as
    | { spec: string }
    | undefined;
  if (!row) return;
  const target = (JSON.parse(row.spec) as JobSpec & { report_to?: { github_status?: string } })
    .report_to?.github_status;
  if (!target) return;

  let posted = 0;
  let detail: string;
  if (!GITHUB_STATUS_ARMED || !GITHUB_TOKEN) {
    detail = "dry run: FLEET_GITHUB_STATUS/FLEET_GITHUB_TOKEN not set";
    app.log.info({ job_id: jobId, target, state }, "commit status recorded, not posted (CI off)");
  } else {
    const m = /^([^/]+)\/([^@]+)@(.+)$/.exec(target);
    if (!m) {
      detail = `bad github_status target: ${target}`;
    } else {
      const res = await fetch(`${GITHUB_API}/repos/${m[1]}/${m[2]}/statuses/${m[3]}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${GITHUB_TOKEN}`,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          state,
          context: "fleet-runner",
          description: `fleet job ${jobId}: ${state}`,
        }),
      });
      posted = res.ok ? 1 : 0;
      detail = `github responded ${res.status}`;
    }
  }
  db.prepare(
    `INSERT INTO status_reports (job_id, target, state, posted, detail) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(job_id, target) DO UPDATE SET state = excluded.state, posted = excluded.posted, detail = excluded.detail`,
  ).run(jobId, target, state, posted, detail);
}

app.get("/status-reports", async () =>
  db.prepare("SELECT * FROM status_reports ORDER BY created_at DESC LIMIT 100").all());

// --- device locks (host executor coordination) ---

const acquireLocksTx = db.transaction((jobId: string, deviceIds: string[]) => {
  const granted: string[] = [];
  const denied: string[] = [];
  for (const id of deviceIds) {
    const existing = db.prepare("SELECT job_id FROM device_locks WHERE device_id = ?").get(id) as
      | { job_id: string }
      | undefined;
    if (!existing || existing.job_id === jobId) {
      db.prepare("INSERT OR REPLACE INTO device_locks (device_id, job_id) VALUES (?, ?)").run(id, jobId);
      granted.push(id);
    } else {
      denied.push(id);
    }
  }
  return { granted, denied };
});

app.post("/locks/acquire", async (req, reply) => {
  const b = req.body as { job_id?: string; device_ids?: string[] };
  if (!b?.job_id || !Array.isArray(b.device_ids))
    return reply.code(400).send({ error: "job_id and device_ids required" });
  return { ok: true, ...acquireLocksTx(b.job_id, b.device_ids) };
});

app.post("/locks/release", async (req, reply) => {
  const b = req.body as { job_id?: string };
  if (!b?.job_id) return reply.code(400).send({ error: "job_id required" });
  const released = db.prepare("DELETE FROM device_locks WHERE job_id = ?").run(b.job_id).changes;
  return { ok: true, released };
});

// --- schedules (nightly runs are just cron-driven enqueues) ---

type ScheduleRow = { id: string; cron: string; template: string; enabled: number; last_run: string | null };

app.post("/schedules", async (req, reply) => {
  const b = req.body as { id?: string; cron?: string; template?: JobSpec; enabled?: boolean };
  if (!b?.id || !b.cron || !b.template)
    return reply.code(400).send({ error: "id, cron, and template required" });
  if (!isValidCron(b.cron)) return reply.code(400).send({ error: `invalid cron: ${b.cron}` });
  if ((b.template as { job_id?: string }).job_id)
    return reply.code(400).send({ error: "template must not carry job_id; the scheduler generates it" });
  db.prepare(
    `INSERT INTO schedules (id, cron, template, enabled) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET cron = excluded.cron, template = excluded.template, enabled = excluded.enabled`,
  ).run(b.id, b.cron, JSON.stringify(b.template), b.enabled ? 1 : 0);
  return reply.code(201).send({ ok: true, id: b.id, enabled: !!b.enabled });
});

app.get("/schedules", async () =>
  (db.prepare("SELECT * FROM schedules ORDER BY id").all() as ScheduleRow[]).map((s) => ({
    ...s, template: JSON.parse(s.template), enabled: !!s.enabled,
  })));

app.patch("/schedules/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const b = req.body as { enabled?: boolean };
  if (typeof b?.enabled !== "boolean") return reply.code(400).send({ error: "enabled (boolean) required" });
  const changed = db.prepare("UPDATE schedules SET enabled = ? WHERE id = ?").run(b.enabled ? 1 : 0, id).changes;
  if (!changed) return reply.code(404).send({ error: "not found" });
  return { ok: true, id, enabled: b.enabled };
});

app.delete("/schedules/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const changed = db.prepare("DELETE FROM schedules WHERE id = ?").run(id).changes;
  if (!changed) return reply.code(404).send({ error: "not found" });
  return { ok: true };
});

// Fire due schedules for the current minute (at most once per minute each).
// Enqueues through POST /jobs via inject so fanout and validation apply.
async function schedulerTick(now = new Date()): Promise<string[]> {
  const key = minuteKey(now);
  const due = (db.prepare("SELECT * FROM schedules WHERE enabled = 1").all() as ScheduleRow[]).filter(
    (s) => s.last_run !== key && cronMatches(s.cron, now),
  );
  const fired: string[] = [];
  for (const s of due) {
    db.prepare("UPDATE schedules SET last_run = ? WHERE id = ?").run(key, s.id);
    const jobId = `${s.id}-${key.replace(/[^0-9]/g, "")}`;
    const res = await app.inject({
      method: "POST", url: "/jobs",
      payload: { ...JSON.parse(s.template), job_id: jobId },
    });
    if (res.statusCode === 201) fired.push(jobId);
    else if (res.statusCode !== 409)
      app.log.error({ schedule: s.id, status: res.statusCode, body: res.body }, "schedule enqueue failed");
  }
  return fired;
}

app.post("/schedules/tick", async () => ({ ok: true, fired: await schedulerTick() }));

// --- power control (smart-plug webhooks per pool) ---

app.post("/power/:pool/:state", async (req, reply) => {
  const { pool, state } = req.params as { pool: string; state: string };
  if (state !== "on" && state !== "off") return reply.code(400).send({ error: "state must be on|off" });
  let config: { pools?: Record<string, Record<string, string>> };
  try {
    config = JSON.parse(readFileSync(POWER_CONFIG_PATH, "utf8"));
  } catch {
    return reply.code(404).send({ error: `no power config at ${POWER_CONFIG_PATH}` });
  }
  const url = config.pools?.[pool]?.[state];
  if (!url) return reply.code(404).send({ error: `no ${state} webhook configured for pool ${pool}` });
  const res = await fetch(url, { method: "POST" });
  app.log.info({ pool, state, webhook_status: res.status }, "power webhook fired");
  return { ok: res.ok, pool, state, webhook_status: res.status };
});

// --- artifacts (models and app builds, addressed by sha256) ---

app.post("/artifacts", async (req, reply) => {
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || body.length === 0)
    return reply.code(400).send({ error: "raw application/octet-stream body required" });
  const sha256 = createHash("sha256").update(body).digest("hex");
  const dest = path.join(ARTIFACT_DIR, sha256);
  if (!existsSync(dest)) {
    const tmp = `${dest}.tmp-${process.pid}`;
    await writeFile(tmp, body);
    await rename(tmp, dest);
  }
  const name = (req.headers["x-artifact-name"] as string | undefined) ?? null;
  db.prepare(
    "INSERT OR IGNORE INTO artifacts (sha256, name, size) VALUES (?, ?, ?)",
  ).run(sha256, name, body.length);
  return reply.code(201).send({ ok: true, sha256, size: body.length });
});

app.get("/artifacts/:sha256", async (req, reply) => {
  const { sha256 } = req.params as { sha256: string };
  if (!/^[a-f0-9]{64}$/.test(sha256)) return reply.code(400).send({ error: "bad sha256" });
  const file = path.join(ARTIFACT_DIR, sha256);
  if (!existsSync(file)) return reply.code(404).send({ error: "not found" });
  const size = statSync(file).size;
  reply.header("accept-ranges", "bytes").header("content-type", "application/octet-stream");

  const range = req.headers.range;
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
  if (m && (m[1] !== "" || m[2] !== "")) {
    const start = m[1] === "" ? size - Number(m[2]) : Number(m[1]);
    const end = m[1] !== "" && m[2] !== "" ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start < 0 || start > end)
      return reply.code(416).header("content-range", `bytes */${size}`).send();
    return reply
      .code(206)
      .header("content-range", `bytes ${start}-${end}/${size}`)
      .send(createReadStream(file, { start, end }));
  }
  return reply.header("content-length", size).send(createReadStream(file));
});

// --- dashboard ---

app.get("/dash", async (_req, reply) => {
  reply.type("text/html").send(renderDash());
});
app.get("/", async (_req, reply) => reply.redirect("/dash"));

app.listen({ port: PORT, host: "0.0.0.0" }).then(() => {
  app.log.info(`fleet-collector listening on :${PORT}`);
  sweepLeases(); // catch claims that lapsed while the collector was down
  setInterval(sweepLeases, SWEEP_MS).unref();
  setInterval(() => {
    schedulerTick().catch((e) => app.log.error(e, "scheduler tick failed"));
  }, SCHEDULER_TICK_MS).unref();
});
