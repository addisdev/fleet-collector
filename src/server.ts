import Fastify from "fastify";
import { createHash } from "node:crypto";
import { createReadStream, statSync, existsSync, mkdirSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { db } from "./db.js";
import { renderDash } from "./dash.js";

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
  targets?: { pool?: string; match?: string; exclusive?: boolean };
  lease?: { ttl_s?: number; max_attempts?: number };
  [k: string]: unknown;
};

const WORKLOADS = new Set(["benchmark", "batch", "pipeline", "install", "ui-test", "drain", "soak"]);

function touchDevice(deviceId: string) {
  db.prepare("UPDATE devices SET last_seen = datetime('now') WHERE device_id = ?").run(deviceId);
}

// Atomically claim the oldest queued job this claimant is eligible for, and
// start its lease clock.
const claimTx = db.transaction((executor: string, claimant: string, devicePools: string[]): JobSpec | null => {
  const rows = db
    .prepare("SELECT job_id, spec FROM jobs WHERE status = 'queued' AND executor = ? ORDER BY created_at")
    .all(executor) as { job_id: string; spec: string }[];
  for (const row of rows) {
    const spec = JSON.parse(row.spec) as JobSpec;
    const pool = spec.targets?.pool;
    if (executor === "device" && pool && !devicePools.includes(pool)) continue;
    db.prepare(
      `UPDATE jobs SET status = 'claimed', claimed_by = ?, claimed_at = datetime('now'),
                       attempts = attempts + 1,
                       lease_deadline = datetime('now', '+' || lease_ttl_s || ' seconds')
       WHERE job_id = ?`,
    ).run(claimant, row.job_id);
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
  for (const job of expired) {
    const who = job.claimed_by ?? "unknown claimant";
    if (job.attempts >= job.max_attempts) {
      giveUp.run(`lease expired on ${who}; gave up after ${job.attempts}/${job.max_attempts} attempts`, job.job_id);
      failed.push(job);
    } else {
      requeue.run(`lease expired on ${who}; requeued after attempt ${job.attempts}/${job.max_attempts}`, job.job_id);
      requeued.push(job);
    }
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
  }
  return { ok: true };
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
});
