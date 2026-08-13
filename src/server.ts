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
  [k: string]: unknown;
};

const WORKLOADS = new Set(["benchmark", "batch", "pipeline", "install", "ui-test", "drain", "soak"]);

function touchDevice(deviceId: string) {
  db.prepare("UPDATE devices SET last_seen = datetime('now') WHERE device_id = ?").run(deviceId);
}

// Atomically claim the oldest queued job this claimant is eligible for.
const claimTx = db.transaction((executor: string, claimant: string, devicePools: string[]): JobSpec | null => {
  const rows = db
    .prepare("SELECT job_id, spec FROM jobs WHERE status = 'queued' AND executor = ? ORDER BY created_at")
    .all(executor) as { job_id: string; spec: string }[];
  for (const row of rows) {
    const spec = JSON.parse(row.spec) as JobSpec;
    const pool = spec.targets?.pool;
    if (executor === "device" && pool && !devicePools.includes(pool)) continue;
    db.prepare(
      "UPDATE jobs SET status = 'claimed', claimed_by = ?, claimed_at = datetime('now') WHERE job_id = ?",
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
  try {
    db.prepare("INSERT INTO jobs (job_id, executor, workload, spec) VALUES (?, ?, ?, ?)").run(
      spec.job_id, spec.executor, spec.workload, JSON.stringify(spec),
    );
  } catch (e: unknown) {
    if ((e as { code?: string }).code === "SQLITE_CONSTRAINT_PRIMARYKEY")
      return reply.code(409).send({ error: "job_id already exists" });
    throw e;
  }
  return reply.code(201).send({ ok: true, job_id: spec.job_id });
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
    return { ok: true };
  }

  if (b.kind !== "result") return reply.code(400).send({ error: "kind must be 'result' or 'beacon'" });
  if (!b.job_id) return reply.code(400).send({ error: "job_id required for kind=result" });
  // Idempotent by (job_id, device_id, iter): retried posts overwrite, never duplicate.
  db.prepare(
    "INSERT OR REPLACE INTO results (job_id, device_id, iter, payload) VALUES (?, ?, ?, ?)",
  ).run(b.job_id, b.device_id, b.iter ?? 0, JSON.stringify(b));
  touchDevice(b.device_id);

  if (b.final) {
    db.prepare(
      "UPDATE jobs SET status = ?, finished_at = datetime('now') WHERE job_id = ?",
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
});
