// Dashboard mutations (plan D2). Every route here is behind requireToken.
//
// Enqueueing goes through the existing POST /jobs by inject rather than a
// second insert path: fan-out, lease defaults, workload validation and the
// duplicate-id 409 are non-trivial and must not have two implementations that
// can drift.
import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { isValidMatch } from "../match.js";
import { requireToken } from "./guard.js";
import { iso, parse } from "./shared.js";

type Announce = (event: { type: string; [k: string]: unknown }) => void;
type MatchingDevices = (pool?: string, match?: string) => { device_id: string; pools: string; pools_override: string | null; descriptor: string }[];

/** Cancelling is a state change plus lock release. The runner is not told
 *  directly — it learns on its next beacon, which returns lease_renewed:false
 *  because the job is no longer 'claimed'. That is the same path a swept lease
 *  uses, so runners already handle it and no new protocol message is needed. */
const cancelTx = db.transaction((jobId: string, reason: string) => {
  const job = db.prepare("SELECT status FROM jobs WHERE job_id = ?").get(jobId) as { status: string } | undefined;
  if (!job) return { ok: false as const, code: 404, error: "not found" };
  if (job.status !== "queued" && job.status !== "claimed")
    return { ok: false as const, code: 409, error: `job is already ${job.status}` };

  db.prepare(
    `UPDATE jobs SET status = 'cancelled', finished_at = datetime('now'),
                     lease_deadline = NULL, last_error = ?
     WHERE job_id = ?`,
  ).run(reason, jobId);
  const released = db.prepare("DELETE FROM device_locks WHERE job_id = ?").run(jobId).changes;
  return { ok: true as const, was: job.status, released };
});

export function registerMutations(app: FastifyInstance, announce: Announce, matchingDevices: MatchingDevices) {
  // --- jobs ---

  app.post("/api/jobs/:id/cancel", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const { id } = req.params as { id: string };
    const reason = ((req.body as { reason?: string } | null)?.reason ?? "cancelled from the dashboard").slice(0, 500);

    const out = cancelTx(id, reason);
    if (!out.ok) return reply.code(out.code).send({ error: out.error });
    announce({ type: "job", job_id: id, status: "cancelled", was: out.was });
    return {
      ok: true,
      job_id: id,
      was: out.was,
      locks_released: out.released,
      // Say plainly that stopping the row does not stop the device.
      note:
        out.was === "claimed"
          ? "The runner stops at its next beacon (lease_renewed:false); work already in flight finishes first."
          : "Job was queued; nothing was running.",
    };
  });

  // Retry clones the spec under a fresh id rather than resetting the original:
  // the failed attempt and its results stay on the record.
  app.post("/api/jobs/:id/retry", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { pool?: string; device_id?: string; priority?: number };

    const row = db.prepare("SELECT spec, template_id FROM jobs WHERE job_id = ?").get(id) as
      | { spec: string; template_id: string | null }
      | undefined;
    if (!row) return reply.code(404).send({ error: "not found" });

    const spec = parse<Record<string, any>>(row.spec, {});
    const base = String(spec.job_id ?? id).replace(/-r(\d+)$/, "");
    // Walk forward past ids that already exist so a third retry does not 409.
    let attempt = 2;
    let jobId = `${base}-r${attempt}`;
    while (db.prepare("SELECT 1 FROM jobs WHERE job_id = ?").get(jobId)) {
      attempt++;
      jobId = `${base}-r${attempt}`;
    }

    const retry: Record<string, any> = { ...spec, job_id: jobId };
    delete retry.fanout; // a retry re-runs this job, not the whole shelf
    if (body.pool || body.device_id) {
      retry.targets = { ...(spec.targets ?? {}) };
      if (body.pool) retry.targets.pool = body.pool;
      if (body.device_id) retry.targets.device_id = body.device_id;
    }
    if (Number.isInteger(body.priority)) retry.priority = body.priority;
    if (row.template_id) retry.template_id = row.template_id;

    const res = await app.inject({ method: "POST", url: "/jobs", payload: retry });
    if (res.statusCode !== 201)
      return reply.code(res.statusCode).send({ error: `enqueue failed: ${res.body}` });
    return reply.code(201).send({ ok: true, job_id: jobId, retry_of: id });
  });

  app.patch("/api/jobs/:id", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { priority?: number };
    if (!Number.isInteger(body.priority))
      return reply.code(400).send({ error: "priority (integer) required" });

    const changed = db.prepare("UPDATE jobs SET priority = ? WHERE job_id = ?").run(body.priority, id).changes;
    if (!changed) return reply.code(404).send({ error: "not found" });
    announce({ type: "job", job_id: id, status: "priority", priority: body.priority });
    return { ok: true, job_id: id, priority: body.priority };
  });

  // The composer's enqueue. Guarded, then handed to POST /jobs unchanged.
  app.post("/api/jobs", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const res = await app.inject({ method: "POST", url: "/jobs", payload: req.body as object });
    return reply.code(res.statusCode).send(res.json());
  });

  /** "N devices match" for the composer, computed with the same function
   *  fan-out uses so the preview cannot promise a different set than it gets. */
  app.post("/api/jobs/preview-targets", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const t = ((req.body ?? {}) as { targets?: { pool?: string; match?: string; device_id?: string } }).targets ?? {};
    if (t.match && !isValidMatch(t.match))
      return reply.code(400).send({ error: `invalid targets.match expression: ${t.match}` });

    let devices = matchingDevices(t.pool, t.match);
    if (t.device_id) devices = devices.filter((d) => d.device_id === t.device_id);

    return {
      count: devices.length,
      devices: devices.map((d) => {
        const descriptor = parse<Record<string, unknown>>(d.descriptor, {});
        return { device_id: d.device_id, model: descriptor.model ?? null, os: descriptor.os ?? null };
      }),
    };
  });

  // --- devices ---

  app.patch("/api/devices/:id", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { nickname?: string | null; notes?: string | null; pools?: string[] | null };

    const exists = db.prepare("SELECT 1 FROM devices WHERE device_id = ?").get(id);
    if (!exists) return reply.code(404).send({ error: "unknown device" });

    if (body.pools !== undefined && body.pools !== null) {
      if (!Array.isArray(body.pools) || body.pools.some((p) => typeof p !== "string"))
        return reply.code(400).send({ error: "pools must be an array of strings, or null to clear the override" });
    }
    if (body.nickname !== undefined)
      db.prepare("UPDATE devices SET nickname = ? WHERE device_id = ?").run(body.nickname || null, id);
    if (body.notes !== undefined)
      db.prepare("UPDATE devices SET notes = ? WHERE device_id = ?").run(body.notes || null, id);
    if (body.pools !== undefined)
      db.prepare("UPDATE devices SET pools_override = ? WHERE device_id = ?").run(
        // null clears the override and hands the device back to what its runner
        // reports, which is different from an override of "no pools".
        body.pools === null ? null : JSON.stringify(body.pools),
        id,
      );

    announce({ type: "device", device_id: id, event: "edit" });
    const row = db.prepare("SELECT pools, pools_override, nickname, notes FROM devices WHERE device_id = ?").get(id);
    return { ok: true, device_id: id, ...(row as object) };
  });

  app.delete("/api/devices/:id", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const { id } = req.params as { id: string };
    // Forgetting a live device is pointless — it re-registers within a minute
    // and the row comes back, minus the operator's nickname and notes.
    const claimed = db.prepare("SELECT job_id FROM jobs WHERE status = 'claimed' AND claimed_by = ?").get(id) as
      | { job_id: string }
      | undefined;
    if (claimed)
      return reply.code(409).send({ error: `device is running ${claimed.job_id}; cancel it first` });

    // A host-executor job is claimed by the *executor* ("mac-mini"), never by
    // the device it drives, so claimed_by alone cannot see an exclusive ui-test
    // or drain. Its device lock can: deleting the row below would drop that
    // lock, and the device's own agent — which only stands down while a lock
    // exists — would start claiming work on top of the running test.
    const held = db.prepare("SELECT job_id FROM device_locks WHERE device_id = ?").get(id) as
      | { job_id: string }
      | undefined;
    if (held)
      return reply
        .code(409)
        .send({ error: `device is locked by ${held.job_id}; cancel that job or release the lock first` });

    const changed = db.prepare("DELETE FROM devices WHERE device_id = ?").run(id).changes;
    if (!changed) return reply.code(404).send({ error: "unknown device" });
    db.prepare("DELETE FROM device_locks WHERE device_id = ?").run(id);
    announce({ type: "device", device_id: id, event: "forget" });
    // Results and beacons are deliberately kept: they are measurements, and a
    // device leaving the shelf does not make them untrue.
    return { ok: true, device_id: id, note: "results and beacon history were kept" };
  });

  app.post("/api/devices/:id/release-lock", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const { id } = req.params as { id: string };
    const released = db.prepare("DELETE FROM device_locks WHERE device_id = ?").run(id).changes;
    if (released) announce({ type: "lock", event: "release", device_id: id, released });
    return { ok: true, released };
  });

  // --- job templates (the composer's saved specs) ---

  app.get("/api/templates", async () => ({
    templates: (
      db.prepare("SELECT id, name, spec, created_at, updated_at FROM job_templates ORDER BY id").all() as {
        id: string;
        name: string | null;
        spec: string;
        created_at: string;
        updated_at: string | null;
      }[]
    ).map((t) => ({
      ...t,
      spec: parse(t.spec, {}),
      created_at: iso(t.created_at),
      updated_at: iso(t.updated_at),
    })),
  }));

  app.post("/api/templates", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const b = (req.body ?? {}) as { id?: string; name?: string; spec?: Record<string, unknown> };
    if (!b.id || !b.spec) return reply.code(400).send({ error: "id and spec required" });
    if ((b.spec as { job_id?: string }).job_id)
      return reply.code(400).send({ error: "template must not carry job_id; it is generated at enqueue" });

    db.prepare(
      `INSERT INTO job_templates (id, name, spec) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, spec = excluded.spec, updated_at = datetime('now')`,
    ).run(b.id, b.name ?? null, JSON.stringify(b.spec));
    announce({ type: "template", id: b.id, event: "upsert" });
    return reply.code(201).send({ ok: true, id: b.id });
  });

  app.delete("/api/templates/:id", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const { id } = req.params as { id: string };
    const changed = db.prepare("DELETE FROM job_templates WHERE id = ?").run(id).changes;
    if (!changed) return reply.code(404).send({ error: "not found" });
    announce({ type: "template", id, event: "delete" });
    return { ok: true };
  });
}
