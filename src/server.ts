import Fastify from "fastify";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, statSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import path from "node:path";
import { db } from "./db.js";
import { renderDash, renderBench } from "./dash.js";
import { cronMatches, isValidCron, minuteKey } from "./cron.js";
import { evalMatch, isValidMatch } from "./match.js";
import {
  ARTIFACT_DIR,
  BIND,
  DATA_DIR,
  GITHUB_API,
  GITHUB_STATUS_ARMED,
  GITHUB_TOKEN,
  LOG_FILE,
  PORT,
  POWER_CONFIG_PATH,
  SCHEDULER_TICK_MS,
  SWEEP_MS,
} from "./config.js";
import { evaluate, expireSnoozes, notify, reconcile } from "./alerts.js";
import { requireToken } from "./api/guard.js";
import { invalidateOverview, publish, registerApi } from "./api/index.js";
import { capabilityMatches, deviceCapabilities, effectivePools } from "./api/shared.js";
import { registerDashStatic } from "./dash-static.js";

mkdirSync(ARTIFACT_DIR, { recursive: true });

/** Every fleet-state change fans out to connected dashboards and drops the
 *  overview's short cache. Called after the write commits, never inside a
 *  transaction — a broken browser pipe must not roll back a device's result. */
function announce(event: { type: string; [k: string]: unknown }) {
  invalidateOverview();
  publish(event);
}

const LONG_POLL_S = 25;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Lease defaults. A claim expires unless the runner keeps renewing it via
// beacons; the sweep then requeues the job (up to max_attempts) so a dead
// runner cannot strand work in 'claimed'.
const DEFAULT_LEASE_TTL_S = 600;
// drain and soak legitimately run for hours between beacons.
const LONG_LEASE_TTL_S = 4 * 60 * 60;
// thermal is minutes rather than hours, but a 15-minute sustained run is still
// well past the 600 s default, and a swept lease mid-run would requeue a job
// whose whole value is an unbroken curve.
const LONG_LEASE_WORKLOADS = new Set(["drain", "soak", "thermal"]);
const MAX_LEASE_TTL_S = 24 * 60 * 60;
// Agents beacon every 60 s. Two missed beacons and a state claim is no longer
// evidence of anything, which matters because these claims gate work rather
// than merely describing it.
const BEACON_TRUST_S = 180;
const DEFAULT_MAX_ATTEMPTS = 3;

const app = Fastify({ logger: { level: process.env.FLEET_LOG ?? "info" } });

// Artifact uploads arrive as raw bytes and are streamed to disk while the
// hash is computed — a multi-GB GGUF never lives in collector memory.
app.addContentTypeParser("application/octet-stream", (_req, payload, done) => done(null, payload));

type JobSpec = {
  schema: number;
  job_id: string;
  workload: string;
  executor: "device" | "host";
  // true fans out to every matching device; { distinct: "os" } fans out to one
  // device per distinct value of that descriptor field.
  fanout?: boolean | { distinct?: string };
  // Named here rather than left to the index signature because capability
  // routing reads it: an agent may declare a workload outright or only one
  // backend of it ("batch:litert").
  backend?: string;
  // `sha256: "latest"` is resolved at enqueue time to the newest build uploaded
  // under this app name -- see resolveLatestBuild.
  app?: { name?: string; build?: string; sha256?: string; platform?: string };
  targets?: {
    pool?: string;
    match?: string;
    exclusive?: boolean;
    device_id?: string;
    // Which host executor should claim this. Not a capability label -- it is a
    // statement about which machine can physically reach the toolchain or the
    // device, which is not a property of any device, so a match expression
    // cannot express it. iOS work needs the Mac with Xcode; Android shelf work
    // needs the machine the shelf is cabled to.
    executor?: string;
    // web-test only: what to point the browser at.
    url?: string;
    // Honoured by the host executor when it picks devices to run on, not only
    // when deciding who claims the job. `device_kind` says "real hardware" or
    // "simulator" -- which no descriptor field expresses honestly, because it
    // is a property of how a device is attached rather than of the device.
    device_kind?: "device" | "simulator";
  };
  constraints?: Record<string, unknown>;
  lease?: { ttl_s?: number; max_attempts?: number };
  // Queue position and provenance. Both are collector bookkeeping rather than
  // instructions to the runner, which ignores them.
  priority?: number;
  template_id?: string;
  [k: string]: unknown;
};

// web-test and web-shots are host-executed like ui-test, but their target is a
// URL rather than a device: no phone is involved and none is locked. web-test
// runs Playwright suites; web-shots captures the screenshot matrix the
// visual-regression pipeline diffs.
// web-audit crawls and audits a site (SEO, structure, mobile-friendliness),
// web-unfurl checks the raw-HTML link previews bots see, archive pulls an
// external API's data (Search Console, App Store / Play reviews) into the
// artifact store, and digest turns the week's archived reviews into a
// summary by farming batch jobs to the shelf's on-device models.
const WORKLOADS = new Set([
  "benchmark", "batch", "pipeline", "install", "ui-test", "drain", "soak",
  "web-test", "web-shots", "web-audit", "web-unfurl", "archive", "digest",
  // thermal is a device workload the runners declare, and cold-start is a host
  // one. Both are listed here anyway because the collector ships their result
  // views and the dashboard ships their icons and skeletons — a workload the
  // collector renders is a workload the collector knows about.
  "thermal", "cold-start", "self-check",
]);

function touchDevice(deviceId: string) {
  db.prepare("UPDATE devices SET last_seen = datetime('now') WHERE device_id = ?").run(deviceId);
}

/** Devices a `targets` clause selects. Shared by fan-out and by the composer's
 *  "N devices match" preview, so the preview cannot disagree with what fan-out
 *  will actually do. */
export function matchingDevices(pool?: string, match?: string, workload?: string, backend?: string | null) {
  return (
    db.prepare("SELECT device_id, pools, pools_override, descriptor, capabilities FROM devices").all() as {
      device_id: string;
      pools: string;
      pools_override: string | null;
      descriptor: string;
      capabilities: string | null;
    }[]
  ).filter((d) => {
    const pools = effectivePools(d);
    const capabilities = deviceCapabilities(d);
    if (pool && !pools.includes(pool)) return false;
    // Checked before the expression, so a match expression can narrow the set
    // but never widen an agent past what its own code can run.
    if (workload && !capabilityMatches(capabilities, workload, backend)) return false;
    if (match) {
      try {
        return evalMatch(match, {
          ...JSON.parse(d.descriptor), device_id: d.device_id, pools, capabilities: capabilities ?? [],
        });
      } catch {
        return false;
      }
    }
    return true;
  });
}

/**
 * Is there any agent on the fleet that could run this workload? The built-in
 * set is always serviceable — those workloads live in the executor, which does
 * not register as a device. Anything else has to be claimed by an agent that
 * says it can run it, which is what stops a typo'd workload sitting queued
 * forever with no explanation.
 */
function workloadServiceableBy(workload: string, backend?: string | null): boolean {
  if (WORKLOADS.has(workload)) return true;
  return (
    db.prepare("SELECT capabilities FROM devices").all() as { capabilities: string | null }[]
  ).some((d) => {
    const declared = deviceCapabilities(d);
    // A legacy agent's null means "no opinion", which cannot be read as a claim
    // to run a workload that did not exist when it registered.
    return declared !== null && capabilityMatches(declared, workload, backend);
  });
}

/**
 * Preconditions the collector can check before handing out a claim, evaluated
 * against the device's last beacon.
 *
 * Deliberately NOT the whole `constraints` object. `require_charging` and
 * `min_battery_pct` are enforced by the runner apps against live state, and
 * they refuse the job with a failed result; moving them here would change that
 * behaviour and double-enforce it against data up to a minute stale. What is
 * here is the set that describes a machine being temporarily unsuitable rather
 * than a device failing a contract — a laptop on battery, or busy, or awake at
 * the wrong hour has not failed at anything, so the job should stay queued and
 * be offered again rather than burn an attempt.
 *
 * Stale beacons fail closed. A machine that stopped reporting cannot be shown
 * to be idle, and guessing in the permissive direction is how a benchmark ends
 * up running while someone is typing.
 */
export function constraintsSatisfied(
  constraints: Record<string, unknown> | undefined,
  lastBeacon: Record<string, unknown> | null,
  beaconAgeS: number | null,
  now = new Date(),
): boolean {
  if (!constraints) return true;
  const wantsAc = constraints.require_ac === true;
  const wantsIdle = typeof constraints.require_idle_s === "number";
  const wantsLoad = typeof constraints.max_load === "number";
  const window = constraints.window as { from?: number; to?: number; tz_offset_min?: number } | undefined;

  if (window && typeof window.from === "number" && typeof window.to === "number") {
    const shifted = typeof window.tz_offset_min === "number"
      ? new Date(now.getTime() + window.tz_offset_min * 60_000)
      : now;
    const hour = typeof window.tz_offset_min === "number" ? shifted.getUTCHours() : shifted.getHours();
    // from > to means the window crosses midnight, which is the common case:
    // "22 to 06" is the night, not an empty set.
    const inside = window.from <= window.to
      ? hour >= window.from && hour < window.to
      : hour >= window.from || hour < window.to;
    if (!inside) return false;
  }

  if (!wantsAc && !wantsIdle && !wantsLoad) return true;

  // Everything below reads the beacon, so no beacon means no claim.
  const sample = (lastBeacon?.beacon ?? lastBeacon) as Record<string, unknown> | null | undefined;
  if (!sample) return false;
  if (beaconAgeS !== null && beaconAgeS > BEACON_TRUST_S) return false;

  if (wantsAc && sample.on_ac !== true && sample.charging !== true) return false;
  if (wantsIdle) {
    const idle = Number(sample.idle_s);
    if (!Number.isFinite(idle) || idle < Number(constraints.require_idle_s)) return false;
  }
  if (wantsLoad) {
    const load = Number(sample.load_1m);
    if (!Number.isFinite(load) || load > Number(constraints.max_load)) return false;
  }
  return true;
}

// Atomically claim the oldest queued job this claimant is eligible for, and
// start its lease clock.
const claimTx = db.transaction((
  executor: string,
  claimant: string,
  devicePools: string[],
  deviceCaps: string[] | null = null,
): JobSpec | null => {
  let descriptor: Record<string, unknown> = {};
  let beacon: Record<string, unknown> | null = null;
  let beaconAgeS: number | null = null;
  if (executor === "device") {
    // A host-executor job holding this device (exclusive ui-test, drain…)
    // means the agent must idle until the lock is released.
    const locked = db.prepare("SELECT job_id FROM device_locks WHERE device_id = ?").get(claimant);
    if (locked) return null;
    const dev = db
      .prepare(
        `SELECT descriptor, last_beacon,
                CAST(strftime('%s','now') - strftime('%s', last_seen) AS INTEGER) AS age_s
         FROM devices WHERE device_id = ?`,
      )
      .get(claimant) as { descriptor: string; last_beacon: string | null; age_s: number | null } | undefined;
    try { beacon = dev?.last_beacon ? JSON.parse(dev.last_beacon) : null; } catch { beacon = null; }
    beaconAgeS = dev?.age_s ?? null;
    // targets.match expressions can read `pools`, so they see the effective set
    // the caller resolved, not the runner's raw report.
    descriptor = {
      ...(dev ? JSON.parse(dev.descriptor) : {}),
      device_id: claimant, pools: devicePools, capabilities: deviceCaps ?? [],
    };
  }
  // Priority first, then age. A job promoted from the dashboard jumps the queue
  // without anyone falsifying its created_at.
  const rows = db
    .prepare(
      "SELECT job_id, spec FROM jobs WHERE status = 'queued' AND executor = ? ORDER BY priority DESC, created_at",
    )
    .all(executor) as { job_id: string; spec: string }[];
  for (const row of rows) {
    const spec = JSON.parse(row.spec) as JobSpec;
    // Host jobs may name the executor that should take them. Unset stays
    // permissive: any executor claims it, exactly as before.
    if (executor === "host" && spec.targets?.executor && spec.targets.executor !== claimant) continue;
    if (executor === "device") {
      if (spec.targets?.device_id && spec.targets.device_id !== claimant) continue;
      const pool = spec.targets?.pool;
      if (pool && !devicePools.includes(pool)) continue;
      // An agent is never handed a workload it did not say it could run. This
      // sits above targets.match on purpose: an expression narrows the set of
      // eligible agents, it does not grant one a workload its code lacks.
      if (!capabilityMatches(deviceCaps, spec.workload, spec.backend ?? null)) continue;
      // Not a rejection: an unsatisfied constraint leaves the job queued for
      // the next poll, which is the whole difference between "the laptop is
      // busy right now" and "this job failed".
      if (!constraintsSatisfied(spec.constraints, beacon, beaconAgeS)) continue;
      // targets.match: descriptor expression ("ram_mb >= 4000 && os ~ 'android'").
      if (spec.targets?.match) {
        try { if (!evalMatch(spec.targets.match, descriptor)) continue; } catch { continue; }
      }
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

async function longPollClaim(
  executor: "device" | "host",
  claimant: string,
  pools: string[],
  capabilities: string[] | null = null,
) {
  for (let i = 0; i < LONG_POLL_S; i++) {
    const spec = claimTx(executor, claimant, pools, capabilities);
    if (spec) {
      // Announced here rather than inside claimTx: the transaction has
      // committed by the time it returns.
      announce({ type: "job", job_id: spec.job_id, status: "claimed", workload: spec.workload, executor, claimed_by: claimant });
      return spec;
    }
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
  for (const j of swept.requeued) {
    app.log.warn({ job_id: j.job_id, claimed_by: j.claimed_by, attempt: j.attempts }, "lease expired; requeued");
    announce({ type: "job", job_id: j.job_id, status: "queued", reason: "lease expired", attempts: j.attempts });
  }
  for (const j of swept.failed) {
    app.log.error({ job_id: j.job_id, claimed_by: j.claimed_by, attempts: j.attempts }, "lease expired; job failed");
    announce({ type: "job", job_id: j.job_id, status: "failed", reason: "lease expired", attempts: j.attempts });
  }
  return swept;
}

// --- devices ---

app.post("/devices/register", async (req, reply) => {
  const b = req.body as {
    device_id?: string; descriptor?: object; pools?: string[]; capabilities?: string[];
  };
  if (!b?.device_id) return reply.code(400).send({ error: "device_id required" });
  if (b.capabilities !== undefined &&
      (!Array.isArray(b.capabilities) || b.capabilities.some((c) => typeof c !== "string")))
    return reply.code(400).send({ error: "capabilities must be an array of strings" });
  // An agent that sends no capabilities keeps whatever it declared last, rather
  // than having them erased: an older build of the same runner re-registering
  // during a rollback would otherwise widen itself back to everything.
  const capabilities = b.capabilities === undefined ? null : JSON.stringify(b.capabilities);
  // Where it registered from, kept to a /24 (or the IPv6 prefix): enough to
  // tell the house from a cafe, without keeping a movement log.
  const net = (() => {
    const ip = (req.ip ?? "").replace(/^::ffff:/, "");
    if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip.split(".").slice(0, 3).join(".") + ".0/24";
    if (ip.includes(":")) return ip.split(":").slice(0, 4).join(":") + "::/64";
    return null;
  })();
  db.prepare(
    `INSERT INTO devices (device_id, descriptor, pools, capabilities, last_net, last_seen)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(device_id) DO UPDATE SET
       descriptor = excluded.descriptor, pools = excluded.pools, last_seen = excluded.last_seen,
       capabilities = COALESCE(excluded.capabilities, devices.capabilities),
       last_net = COALESCE(excluded.last_net, devices.last_net)`,
  ).run(b.device_id, JSON.stringify(b.descriptor ?? {}), JSON.stringify(b.pools ?? []), capabilities, net);
  announce({
    type: "device", device_id: b.device_id, event: "register",
    pools: b.pools ?? [], capabilities: b.capabilities ?? null,
  });
  return { ok: true };
});

app.get("/devices", async () =>
  (db.prepare("SELECT * FROM devices ORDER BY last_seen DESC").all() as
    { device_id: string; descriptor: string; pools: string; last_seen: string;
      last_beacon: string | null; capabilities: string | null }[])
    .map((d) => ({
      device_id: d.device_id,
      descriptor: JSON.parse(d.descriptor),
      pools: JSON.parse(d.pools),
      capabilities: deviceCapabilities(d),
      last_seen: d.last_seen,
      last_beacon: d.last_beacon ? JSON.parse(d.last_beacon) : null,
    })));

app.get("/devices/:id/next-job", async (req, reply) => {
  const { id } = req.params as { id: string };
  const dev = db
    .prepare("SELECT pools, pools_override, capabilities FROM devices WHERE device_id = ?")
    .get(id) as { pools: string; pools_override: string | null; capabilities: string | null } | undefined;
  if (!dev) return reply.code(404).send({ error: "unknown device; register first" });
  touchDevice(id);
  const spec = await longPollClaim("device", id, effectivePools(dev), deviceCapabilities(dev));
  if (!spec) return reply.code(204).send();
  return spec;
});

app.get("/executor/next-job", async (req, reply) => {
  const claimant = ((req.query as Record<string, string>).name ?? "host-executor");
  // A poll is a heartbeat. Recording it here means executor liveness needs no
  // new endpoint and no change to the executor itself — and a queue of host
  // jobs with a dead executor stops looking like a queue that is merely slow.
  db.prepare(
    `INSERT INTO executors (name, last_seen, polls) VALUES (?, datetime('now'), 1)
     ON CONFLICT(name) DO UPDATE SET last_seen = excluded.last_seen, polls = polls + 1`,
  ).run(claimant);
  const spec = await longPollClaim("host", claimant, []);
  if (!spec) return reply.code(204).send();
  db.prepare("UPDATE executors SET last_job = ? WHERE name = ?").run(spec.job_id, claimant);
  // Hand back the lease the collector actually granted, not the one the job
  // asked for. Most jobs set none and get a default the executor cannot see;
  // a workload that must finish inside its lease (web-test has nothing to
  // beacon with) can only budget itself if it is told the real number.
  const granted = db.prepare("SELECT lease_ttl_s FROM jobs WHERE job_id = ?").get(spec.job_id) as
    { lease_ttl_s?: number } | undefined;
  return { ...spec, lease: { ...(spec.lease ?? {}), ttl_s: granted?.lease_ttl_s ?? spec.lease?.ttl_s } };
});

// --- jobs ---

app.post("/jobs", async (req, reply) => {
  let spec = req.body as JobSpec;
  if (spec?.schema !== 1) return reply.code(400).send({ error: "schema must be 1" });
  if (!spec.job_id) return reply.code(400).send({ error: "job_id required" });
  if (typeof spec.workload !== "string" || !spec.workload)
    return reply.code(400).send({ error: "workload required" });
  // The set below is what the collector and the host executor ship with. Beyond
  // it, an agent that declares a capability defines the workload — which is how
  // a new runner adds work the collector has never heard of without a release
  // here. Refusing when nothing on the fleet can run it keeps the failure at
  // enqueue time, where the caller sees it, rather than as a job queued forever.
  if (!workloadServiceableBy(spec.workload, spec.backend ?? null))
    return reply.code(422).send({
      error: `no agent can run workload '${spec.workload}'` +
        (spec.backend ? ` with backend '${spec.backend}'` : "") +
        "; a device must declare it in the capabilities it registers with",
    });
  // A job spec is stored in SQLite, served by the API and rendered on the
  // dashboard, so anything in one is effectively published to everyone on the
  // LAN. Refuse secrets outright rather than trusting every future caller to
  // remember: the executor resolves passwords from its own host Keychain, and
  // a spec only ever names the account.
  {
    const flat = JSON.stringify(spec).toLowerCase();
    for (const banned of ["\"password\"", "\"passwd\"", "\"secret\"", "\"token\"", "\"api_key\"", "\"apikey\""]) {
      if (flat.includes(banned)) {
        return reply.code(400).send({
          error: `job specs must not carry secrets (${banned.replace(/"/g, "")}); ` +
            "name the account instead and keep the password in the executor host's Keychain",
        });
      }
    }
  }
  // `latest` is the documented contract for CI and for hand-written jobs, not
  // a scheduler-only convenience. Resolving here means a job posted directly
  // is never pinned to a string that cannot name an artifact.
  try {
    spec = resolveLatestBuild(spec);
  } catch (e) {
    return reply.code(400).send({ error: String((e as Error).message ?? e) });
  }
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

  const priority = spec.priority ?? 0;
  if (!Number.isInteger(priority)) return reply.code(400).send({ error: "priority must be an integer" });
  const templateId = typeof spec.template_id === "string" ? spec.template_id : null;

  // Fan-out: one queued child per registered device in the target pool, each
  // pinned via targets.device_id. Host jobs already fan across attached
  // targets inside the executor, so fanout is a device-executor concept.
  if (spec.targets?.match && !isValidMatch(spec.targets.match))
    return reply.code(400).send({ error: `invalid targets.match expression: ${spec.targets.match}` });

  if (spec.fanout) {
    const pool = spec.targets?.pool;
    const match = spec.targets?.match;
    // Host jobs fan out too now. A host child is pinned with targets.device_id
    // exactly as a device child is, and the executor's own selectTargets
    // already honours that field, so nothing downstream needed teaching.
    const distinct = typeof spec.fanout === "object" && spec.fanout !== null
      ? (spec.fanout as { distinct?: string }).distinct
      : undefined;
    if (distinct !== undefined && typeof distinct !== "string")
      return reply.code(400).send({ error: "fanout.distinct must be a descriptor field name" });

    // Same predicate the claim uses, so fan-out cannot mint a child job for a
    // device that will then never be offered it. For host jobs the capability
    // belongs to the executor rather than the device, so it is not applied.
    let devices = spec.executor === "device"
      ? matchingDevices(pool, match, spec.workload, spec.backend ?? null)
      : matchingDevices(pool, match);
    if (devices.length === 0)
      return reply.code(400).send({
        error: `no registered devices${pool ? ` in pool ${pool}` : ""}${match ? ` matching ${match}` : ""}` +
          ` can run ${spec.workload}`,
      });

    // "One per distinct OS" is the canary shape: a smoke pass on every OS on
    // the shelf without paying for every phone. Newest-seen wins within a
    // group, because that is the device most likely to still be plugged in.
    if (distinct) {
      const seen = new Map<string, typeof devices[number]>();
      for (const d of devices) {
        const key = String(
          (JSON.parse(d.descriptor) as Record<string, unknown>)[distinct] ?? "",
        );
        // matchingDevices returns registry order, which is last_seen DESC.
        if (!seen.has(key)) seen.set(key, d);
      }
      devices = [...seen.values()];
    }

    const insert = db.prepare(
      `INSERT OR IGNORE INTO jobs (job_id, executor, workload, spec, lease_ttl_s, max_attempts, priority, parent_job_id, template_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const created: string[] = [];
    for (const d of devices) {
      const child: JobSpec = {
        ...spec,
        job_id: `${spec.job_id}--${d.device_id}`,
        targets: { ...spec.targets, device_id: d.device_id },
      };
      delete child.fanout;
      const r = insert.run(
        child.job_id, child.executor, child.workload, JSON.stringify(child), ttlS, maxAttempts,
        priority, spec.job_id, templateId,
      );
      if (r.changes > 0) created.push(child.job_id);
    }
    for (const jobId of created)
      announce({ type: "job", job_id: jobId, status: "queued", workload: spec.workload, executor: spec.executor, parent: spec.job_id });
    return reply.code(201).send({ ok: true, fanout: created });
  }

  try {
    db.prepare(
      `INSERT INTO jobs (job_id, executor, workload, spec, lease_ttl_s, max_attempts, priority, template_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(spec.job_id, spec.executor, spec.workload, JSON.stringify(spec), ttlS, maxAttempts, priority, templateId);
  } catch (e: unknown) {
    if ((e as { code?: string }).code === "SQLITE_CONSTRAINT_PRIMARYKEY")
      return reply.code(409).send({ error: "job_id already exists" });
    throw e;
  }
  announce({ type: "job", job_id: spec.job_id, status: "queued", workload: spec.workload, executor: spec.executor });
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
    announce({
      type: "beacon",
      device_id: b.device_id,
      job_id: b.job_id ?? null,
      lease_renewed: leaseRenewed,
      beacon: (b as { beacon?: unknown }).beacon ?? null,
    });
    return { ok: true, lease_renewed: leaseRenewed };
  }

  if (b.kind !== "result") return reply.code(400).send({ error: "kind must be 'result' or 'beacon'" });
  if (!b.job_id) return reply.code(400).send({ error: "job_id required for kind=result" });
  // Idempotent by (job_id, device_id, iter): retried posts overwrite, never duplicate.
  db.prepare(
    "INSERT OR REPLACE INTO results (job_id, device_id, iter, payload) VALUES (?, ?, ?, ?)",
  ).run(b.job_id, b.device_id, b.iter ?? 0, JSON.stringify(b));
  touchDevice(b.device_id);
  announce({ type: "result", job_id: b.job_id, device_id: b.device_id, iter: b.iter ?? 0, final: !!b.final });

  if (b.final) {
    // Dropping the deadline takes the job out of the sweep's reach for good.
    db.prepare(
      "UPDATE jobs SET status = ?, finished_at = datetime('now'), lease_deadline = NULL WHERE job_id = ?",
    ).run(b.ok === false ? "failed" : "done", b.job_id);
    db.prepare("DELETE FROM device_locks WHERE job_id = ?").run(b.job_id);
    announce({
      type: "job",
      job_id: b.job_id,
      status: b.ok === false ? "failed" : "done",
      device_id: b.device_id,
    });
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
  const outcome = acquireLocksTx(b.job_id, b.device_ids);
  if (outcome.granted.length) announce({ type: "lock", event: "acquire", job_id: b.job_id, devices: outcome.granted });
  return { ok: true, ...outcome };
});

app.post("/locks/release", async (req, reply) => {
  const b = req.body as { job_id?: string };
  if (!b?.job_id) return reply.code(400).send({ error: "job_id required" });
  const released = db.prepare("DELETE FROM device_locks WHERE job_id = ?").run(b.job_id).changes;
  if (released) announce({ type: "lock", event: "release", job_id: b.job_id, released });
  return { ok: true, released };
});

// --- pipeline events (pub/sub without an external broker) ---

app.post("/events/:topic", async (req, reply) => {
  const { topic } = req.params as { topic: string };
  const payload = req.body ?? {};
  const r = db.prepare("INSERT INTO events (topic, payload) VALUES (?, ?)").run(
    topic, JSON.stringify(payload),
  );
  announce({ type: "pipeline-event", topic, id: Number(r.lastInsertRowid) });
  return reply.code(201).send({ ok: true, id: Number(r.lastInsertRowid) });
});

// Long-poll the next event after a cursor; 204 when the poll expires empty.
app.get("/events/:topic/poll", async (req, reply) => {
  const { topic } = req.params as { topic: string };
  const after = Number((req.query as Record<string, string>).after ?? 0);
  for (let i = 0; i < LONG_POLL_S; i++) {
    const row = db
      .prepare("SELECT id, payload, created_at FROM events WHERE topic = ? AND id > ? ORDER BY id LIMIT 1")
      .get(topic, after) as { id: number; payload: string; created_at: string } | undefined;
    if (row) return { id: row.id, payload: JSON.parse(row.payload), created_at: row.created_at };
    await sleep(1000);
  }
  return reply.code(204).send();
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
  announce({ type: "schedule", event: "upsert", id: b.id, enabled: !!b.enabled });
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
  announce({ type: "schedule", event: "toggle", id, enabled: b.enabled });
  return { ok: true, id, enabled: b.enabled };
});

app.delete("/schedules/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const changed = db.prepare("DELETE FROM schedules WHERE id = ?").run(id).changes;
  if (!changed) return reply.code(404).send({ error: "not found" });
  announce({ type: "schedule", event: "delete", id });
  return { ok: true };
});

/**
 * Resolve `app.sha256: "latest"` to the newest build uploaded for `app.name`.
 *
 * This is what stops a nightly from testing yesterday's code. A schedule that
 * pins a literal hash tests that hash forever, which is how one of these spent
 * six days guarding an APK older than the code it was meant to guard; a
 * schedule that asks for "latest" tests whatever CI pushed most recently.
 *
 * Throws when there is nothing to test, rather than enqueueing a job pinned to
 * a build that does not exist.
 */
function resolveLatestBuild(spec: JobSpec): JobSpec {
  if (spec.app?.sha256 !== "latest") return spec;
  const appName = spec.app?.name;
  if (!appName) throw new Error("app.sha256 is 'latest' but app.name is missing");
  const row = db
    .prepare(
      `SELECT sha256, build FROM artifacts WHERE app = ?
       ORDER BY COALESCE(publish_seq, rowid) DESC LIMIT 1`,
    )
    .get(appName) as { sha256: string; build: string | null } | undefined;
  if (!row) throw new Error(`no build has been uploaded for ${appName}`);
  // Record the build string the artifact carries, so a result says which build
  // actually ran. Falling back to the template's build would write the literal
  // word "latest" into the result, which is untraceable to any commit; the
  // short hash is at least a real answer.
  const templateBuild = spec.app.build === "latest" ? undefined : spec.app.build;
  return {
    ...spec,
    app: { ...spec.app, sha256: row.sha256, build: row.build ?? templateBuild ?? row.sha256.slice(0, 12) },
  };
}

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
    let payload: Record<string, unknown>;
    try {
      payload = resolveLatestBuild(JSON.parse(s.template) as JobSpec) as Record<string, unknown>;
    } catch (e) {
      // No build to test is not a red nightly -- it is a nightly that did not
      // run. Firing it anyway against a hash that resolves to nothing would
      // produce a failure that looks like the app is broken.
      app.log.warn({ schedule: s.id, reason: String(e) }, "schedule skipped");
      announce({ type: "schedule", event: "skipped", id: s.id, reason: String((e as Error).message ?? e) });
      continue;
    }
    const res = await app.inject({
      method: "POST", url: "/jobs",
      payload: { ...payload, job_id: jobId },
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
  const stream = req.body as Readable;
  if (!stream || typeof (stream as { pipe?: unknown }).pipe !== "function")
    return reply.code(400).send({ error: "raw application/octet-stream body required" });

  const tmp = path.join(ARTIFACT_DIR, `.upload-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const hash = createHash("sha256");
  let size = 0;
  try {
    await pipeline(
      stream,
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          hash.update(chunk);
          size += chunk.length;
          yield chunk;
        }
      },
      createWriteStream(tmp),
    );
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
  if (size === 0) {
    await unlink(tmp).catch(() => {});
    return reply.code(400).send({ error: "empty body" });
  }

  const sha256 = hash.digest("hex");
  const dest = path.join(ARTIFACT_DIR, sha256);
  if (existsSync(dest)) await unlink(tmp).catch(() => {});
  else await rename(tmp, dest);

  const name = (req.headers["x-artifact-name"] as string | undefined) ?? null;
  // Which app this build IS. Optional, because an artifact can still be an
  // anonymous blob, but a build that says so can be found by a nightly without
  // anyone pinning its hash.
  const app_ = (req.headers["x-artifact-app"] as string | undefined) ?? null;
  const build = (req.headers["x-artifact-build"] as string | undefined) ?? null;
  const platform = (req.headers["x-artifact-platform"] as string | undefined) ?? null;
  db.prepare(
    "INSERT OR IGNORE INTO artifacts (sha256, name, size, app, build, platform) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(sha256, name, size, app_, build, platform);
  // Content-addressing means re-uploading identical bytes is an ignored insert,
  // so a revert that republishes an earlier build would otherwise keep that
  // build's original created_at and sort BEHIND the build it just replaced.
  // Stamping published_at is what makes `latest` mean "most recently
  // published" rather than "first seen".
  if (app_) {
    db.prepare(
      `UPDATE artifacts
          SET app = ?, build = COALESCE(?, build), platform = COALESCE(?, platform),
              published_at = datetime('now'),
              publish_seq = (SELECT COALESCE(MAX(publish_seq), 0) + 1 FROM artifacts)
        WHERE sha256 = ?`,
    ).run(app_, build, platform, sha256);
  }
  announce({ type: "artifact", sha256, name, size, app: app_, build });
  return reply.code(201).send({ ok: true, sha256, size, app: app_, build });
});

app.get("/artifacts/:sha256", async (req, reply) => {
  const { sha256 } = req.params as { sha256: string };
  if (!/^[a-f0-9]{64}$/.test(sha256)) return reply.code(400).send({ error: "bad sha256" });
  const file = path.join(ARTIFACT_DIR, sha256);
  if (!existsSync(file)) return reply.code(404).send({ error: "not found" });
  const size = statSync(file).size;
  reply.header("accept-ranges", "bytes").header("content-type", "application/octet-stream");

  // ?filename= makes a browser save the artifact under a real name. Without it
  // a phone downloading the runner gets a 64-character hash with no extension,
  // which Android will not offer to install. Quoted and stripped of anything
  // that could break out of the header or the filename.
  const wanted = (req.query as Record<string, string | undefined>).filename;
  if (wanted) {
    const safe = wanted.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 100);
    if (safe) reply.header("content-disposition", `attachment; filename="${safe}"`);
  }

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

// The server-rendered tables that were /dash through Phase 0–4. Kept at
// /dash/legacy while the SPA grows into parity (plan D0→D1): it has no build
// step, so it still works from a bare checkout if the bundle is missing.
app.get("/dash/legacy", async (_req, reply) => {
  reply.type("text/html").send(renderDash());
});
app.get("/dash/legacy/bench", async (_req, reply) => {
  reply.type("text/html").send(renderBench());
});

// Read API for the dashboard, then the SPA itself. Registration order does not
// decide precedence — Fastify prefers static routes over the /dash/* wildcard —
// but reading them in this order matches how a request resolves.
registerApi(app, announce, matchingDevices);
registerDashStatic(app);

app.get("/", async (_req, reply) => reply.redirect("/dash"));

// --- alerts (plan D5) ---

const ALERT_TICK_MS = Number(process.env.FLEET_ALERT_TICK_MS ?? 60_000);

function fileSize(f: string) {
  try {
    return statSync(f).size;
  } catch {
    return 0;
  }
}

export async function alertTick() {
  expireSnoozes();
  const opened = reconcile(
    evaluate(new Date(), {
      dbBytes: ["fleet.db", "fleet.db-wal"].reduce((a, f) => a + fileSize(path.join(DATA_DIR, f)), 0),
      logBytes: fileSize(LOG_FILE),
    }),
  );
  for (const a of opened) {
    app.log.warn({ rule: a.rule, subject: a.subject, severity: a.severity }, a.message);
    announce({ type: "alert", id: a.id, rule: a.rule, subject: a.subject, severity: a.severity, message: a.message });
  }
  // Marked before the await so a webhook that hangs cannot cause a re-notify
  // on the next tick.
  for (const a of opened) db.prepare("UPDATE alerts SET notified = 1 WHERE id = ?").run(a.id);
  await notify(opened, (o, m) => app.log.warn(o, m));
  return opened;
}

app.post("/api/alerts/tick", async (req, reply) => {
  if (!requireToken(req, reply)) return;
  return { ok: true, opened: (await alertTick()).map((a) => a.id) };
});

app.listen({ port: PORT, host: BIND[0] ?? "0.0.0.0" }).then(() => {
  // Node binds one address per server, so every address after the first gets a
  // bare TCP listener whose connections are handed to the same HTTP server.
  // One Fastify app, one route table, several front doors.
  for (const host of BIND.slice(1)) {
    const extra = createServer((socket) => app.server.emit("connection", socket));
    extra.on("error", (e) => app.log.error(e, `bind ${host}:${PORT} failed`));
    extra.listen(PORT, host);
    extra.unref();
  }
  app.log.info(`fleet-collector listening on ${BIND.join(", ")}:${PORT}`);
  if (BIND.includes("0.0.0.0") || BIND.includes("::")) {
    // Not an error: it is the default and it is right for a LAN-only fleet.
    // Said out loud because there is no authentication behind it, so the
    // network is the whole access control and it should be a decision.
    app.log.warn(
      "listening on every interface with no authentication; " +
        "set FLEET_BIND to loopback plus your tailnet address if agents roam",
    );
  }
  sweepLeases(); // catch claims that lapsed while the collector was down
  setInterval(sweepLeases, SWEEP_MS).unref();
  setInterval(() => {
    schedulerTick().catch((e) => app.log.error(e, "scheduler tick failed"));
  }, SCHEDULER_TICK_MS).unref();
  // Evaluated on a slower cadence than the sweep: these are conditions
  // measured in minutes, and a tighter loop would only cost the little host CPU.
  alertTick().catch((e) => app.log.error(e, "alert tick failed"));
  setInterval(() => {
    alertTick().catch((e) => app.log.error(e, "alert tick failed"));
  }, ALERT_TICK_MS).unref();
});
