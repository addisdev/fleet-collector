// Dashboard mutations (plan D2). Every route here is behind requireToken.
//
// Enqueueing goes through the existing POST /jobs by inject rather than a
// second insert path: fan-out, lease defaults, workload validation and the
// duplicate-id 409 are non-trivial and must not have two implementations that
// can drift.
import type { FastifyInstance } from "fastify";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { ARTIFACT_DIR } from "../config.js";
import { db } from "../db.js";
import { isValidMatch } from "../match.js";
import { requireToken } from "./guard.js";
import { iso, parse, sha256Refs } from "./shared.js";

type Announce = (event: { type: string; [k: string]: unknown }) => void;
type MatchingDevices = (
  pool?: string, match?: string, workload?: string, backend?: string | null,
) => {
  device_id: string; pools: string; pools_override: string | null;
  descriptor: string; capabilities: string | null;
}[];

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
    const body = (req.body ?? {}) as {
      targets?: { pool?: string; match?: string; device_id?: string };
      workload?: string; backend?: string;
    };
    const t = body.targets ?? {};
    if (t.match && !isValidMatch(t.match))
      return reply.code(400).send({ error: `invalid targets.match expression: ${t.match}` });

    // The composer knows the workload it is about to enqueue, so the preview
    // counts the agents that can actually run it rather than every agent the
    // pool and match happen to select.
    let devices = matchingDevices(t.pool, t.match, body.workload, body.backend ?? null);
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
    const body = (req.body ?? {}) as { name?: string | null; notes?: string | null; pools?: string[] | null };

    const exists = db.prepare("SELECT 1 FROM devices WHERE device_id = ?").get(id);
    if (!exists) return reply.code(404).send({ error: "unknown device" });

    if (body.pools !== undefined && body.pools !== null) {
      if (!Array.isArray(body.pools) || body.pools.some((p) => typeof p !== "string"))
        return reply.code(400).send({ error: "pools must be an array of strings, or null to clear the override" });
    }
    if (body.name !== undefined)
      db.prepare("UPDATE devices SET name = ? WHERE device_id = ?").run(body.name || null, id);
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
    const row = db.prepare("SELECT pools, pools_override, name, notes FROM devices WHERE device_id = ?").get(id);
    return { ok: true, device_id: id, ...(row as object) };
  });

  app.delete("/api/devices/:id", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const { id } = req.params as { id: string };
    // Forgetting a live device is pointless — it re-registers within a minute
    // and the row comes back, minus the operator's name and notes.
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

  // --- schedules (plan D4) ---

  for (const [method, path] of [
    ["POST", "/api/schedules"],
    ["PATCH", "/api/schedules/:id"],
    ["DELETE", "/api/schedules/:id"],
  ] as const) {
    const handler = async (req: any, reply: any) => {
      if (!requireToken(req, reply)) return;
      // Forwarded to the long-standing /schedules routes rather than
      // reimplemented: cron validation and the no-job_id rule live there.
      const id = req.params?.id ? `/${encodeURIComponent(req.params.id)}` : "";
      const res = await app.inject({ method, url: `/schedules${id}`, payload: req.body as object });
      return reply.code(res.statusCode).send(res.statusCode === 204 ? null : res.json());
    };
    if (method === "POST") app.post(path, handler);
    else if (method === "PATCH") app.patch(path, handler);
    else app.delete(path, handler);
  }

  /** Fire one schedule now, without waiting for its cron minute and without
   *  disturbing the dedup key that stops it double-firing on its own. */
  app.post("/api/schedules/:id/run", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const { id } = req.params as { id: string };
    const row = db.prepare("SELECT template FROM schedules WHERE id = ?").get(id) as { template: string } | undefined;
    if (!row) return reply.code(404).send({ error: "not found" });

    // Suffixed with 'manual' so a hand-fired run is never mistaken for the
    // scheduler's own, and cannot collide with the minute-keyed id it uses.
    const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
    const jobId = `${id}-manual-${stamp}`;
    const res = await app.inject({
      method: "POST",
      url: "/jobs",
      payload: { ...parse<Record<string, unknown>>(row.template, {}), job_id: jobId },
    });
    if (res.statusCode !== 201) return reply.code(res.statusCode).send({ error: `enqueue failed: ${res.body}` });
    return reply.code(201).send({ ok: true, ...(res.json() as Record<string, unknown>), schedule: id });
  });

  // --- alerts (plan D5) ---

  app.post("/api/alerts/:id/ack", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const { id } = req.params as { id: string };
    // Acknowledged, not resolved: the condition is still true and the alert
    // stays visible. Only the condition clearing resolves it.
    const changed = db
      .prepare("UPDATE alerts SET state = 'acked' WHERE id = ? AND state != 'resolved'")
      .run(Number(id)).changes;
    if (!changed) return reply.code(404).send({ error: "no open alert with that id" });
    announce({ type: "alert", id: Number(id), event: "ack" });
    return { ok: true, id: Number(id), state: "acked" };
  });

  app.post("/api/alerts/:id/snooze", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const { id } = req.params as { id: string };
    const minutes = Number((req.body as { minutes?: number } | null)?.minutes ?? 60);
    if (!Number.isFinite(minutes) || minutes < 1) return reply.code(400).send({ error: "minutes must be >= 1" });

    const changed = db
      .prepare(
        `UPDATE alerts SET state = 'snoozed', snooze_until = datetime('now', ?)
         WHERE id = ? AND state != 'resolved'`,
      )
      .run(`+${Math.round(minutes)} minutes`, Number(id)).changes;
    if (!changed) return reply.code(404).send({ error: "no open alert with that id" });
    announce({ type: "alert", id: Number(id), event: "snooze" });
    return { ok: true, id: Number(id), state: "snoozed", minutes };
  });

  // --- artifacts (plan D4) ---

  /** Everything that makes an artifact un-collectable: a textual reference in
   *  something the collector stores, or a pin.
   *
   *  Baselines are the case a text scan cannot reach. An accepted visual
   *  baseline is referenced by a row in `baselines`, not by any job spec, and
   *  its entire purpose is to still exist months later to diff against — so
   *  the scan would have offered every one of them for collection. */
  function protectedShas(): Set<string> {
    const referenced = new Set<string>();
    for (const { blob } of [
      ...(db.prepare("SELECT spec AS blob FROM jobs").all() as { blob: string }[]),
      ...(db.prepare("SELECT payload AS blob FROM results").all() as { blob: string }[]),
      ...(db.prepare("SELECT template AS blob FROM schedules").all() as { blob: string }[]),
      ...(db.prepare("SELECT spec AS blob FROM job_templates").all() as { blob: string }[]),
    ]) {
      for (const sha of sha256Refs(blob)) referenced.add(sha);
    }
    for (const b of db.prepare("SELECT sha256 FROM baselines").all() as { sha256: string }[])
      referenced.add(b.sha256);
    for (const a of db.prepare("SELECT sha256 FROM artifacts WHERE pinned = 1").all() as { sha256: string }[])
      referenced.add(a.sha256);
    return referenced;
  }

  /** Artifacts nothing references and nobody pinned. The candidates are listed
   *  before anything is deleted, because a hash the dashboard cannot see a
   *  reference to may still be referenced by something it never indexed. */
  function gcCandidates(olderThanDays: number) {
    const referenced = protectedShas();
    return (
      db
        .prepare(
          `SELECT sha256, name, size, created_at FROM artifacts
           WHERE created_at <= datetime('now', ?) ORDER BY size DESC`,
        )
        .all(`-${olderThanDays} days`) as { sha256: string; name: string | null; size: number; created_at: string }[]
    )
      .filter((a) => !referenced.has(a.sha256))
      .map((a) => ({ ...a, created_at: iso(a.created_at) }));
  }

  app.get("/api/artifacts/gc-candidates", async (req) => {
    const days = Math.max(0, Number((req.query as Record<string, string>).days ?? 30) || 30);
    const candidates = gcCandidates(days);
    return {
      days,
      count: candidates.length,
      bytes: candidates.reduce((a, c) => a + c.size, 0),
      candidates: candidates.slice(0, 500),
    };
  });

  /** Pin or unpin. A pin is an operator saying "keep this whatever the scan
   *  thinks"; the reason is stored because a pin with no reason is one nobody
   *  will ever dare remove. */
  app.post("/api/artifacts/:sha256/pin", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const { sha256 } = req.params as { sha256: string };
    if (!/^[a-f0-9]{64}$/.test(sha256)) return reply.code(400).send({ error: "bad sha256" });
    const body = (req.body ?? {}) as { pinned?: boolean; reason?: string };
    const pinned = body.pinned !== false;
    const changed = db
      .prepare("UPDATE artifacts SET pinned = ?, pin_reason = ? WHERE sha256 = ?")
      .run(pinned ? 1 : 0, pinned ? (body.reason ?? "pinned from the dashboard") : null, sha256).changes;
    if (!changed) return reply.code(404).send({ error: "not found" });
    announce({ type: "artifact", sha256, event: pinned ? "pin" : "unpin" });
    return { ok: true, sha256, pinned };
  });

  app.delete("/api/artifacts/:sha256", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const { sha256 } = req.params as { sha256: string };
    if (!/^[a-f0-9]{64}$/.test(sha256)) return reply.code(400).send({ error: "bad sha256" });

    const pin = db.prepare("SELECT pinned, pin_reason FROM artifacts WHERE sha256 = ?").get(sha256) as
      | { pinned: number; pin_reason: string | null } | undefined;
    if (pin?.pinned)
      return reply.code(409).send({
        error: `pinned${pin.pin_reason ? `: ${pin.pin_reason}` : ""}; unpin it first if you really mean to delete it`,
      });

    // Refuse while anything still points at it. An artifact is content, not a
    // cache entry: deleting one a queued job needs makes that job fail at
    // download time, long after the click that caused it.
    const referencedBy = (
      db.prepare("SELECT job_id, spec FROM jobs").all() as { job_id: string; spec: string }[]
    ).filter((j) => j.spec.includes(sha256));
    if (referencedBy.length > 0)
      return reply
        .code(409)
        .send({ error: `still referenced by ${referencedBy.length} job(s), e.g. ${referencedBy[0].job_id}` });

    // A baseline is referenced by a row, not by any spec text, so the scan
    // above cannot see it. Deleting one leaves a visual suite diffing against
    // nothing and reporting every page as changed.
    const baseline = db.prepare("SELECT suite, page, profile FROM baselines WHERE sha256 = ?").get(sha256) as
      | { suite: string; page: string; profile: string } | undefined;
    if (baseline)
      return reply.code(409).send({
        error: `accepted visual baseline for ${baseline.suite}/${baseline.page} (${baseline.profile}); ` +
          "accept a different shot first",
      });

    const removed = db.prepare("DELETE FROM artifacts WHERE sha256 = ?").run(sha256).changes;
    if (!removed) return reply.code(404).send({ error: "not found" });
    await unlink(path.join(ARTIFACT_DIR, sha256)).catch(() => {});
    announce({ type: "artifact", sha256, event: "delete" });
    return { ok: true, sha256 };
  });

  // --- system (plan D4) ---

  app.post("/api/system/sweep", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const res = await app.inject({ method: "POST", url: "/jobs/sweep" });
    return reply.code(res.statusCode).send(res.json());
  });

  app.post("/api/system/scheduler-tick", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const res = await app.inject({ method: "POST", url: "/schedules/tick" });
    return reply.code(res.statusCode).send(res.json());
  });

  app.post("/api/power/:pool/:state", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const { pool, state } = req.params as { pool: string; state: string };
    const res = await app.inject({ method: "POST", url: `/power/${encodeURIComponent(pool)}/${encodeURIComponent(state)}` });
    return reply.code(res.statusCode).send(res.json());
  });

  /**
   * Retention. A 60 s beacon is ~1.4k rows per device per day, so the table
   * that powers the battery charts is also the one that grows without bound.
   * Deliberately manual: a nightly job that silently deletes measurements is a
   * worse default than a button someone presses.
   */
  app.post("/api/system/retention", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const b = (req.body ?? {}) as { beacon_days?: number; event_days?: number; dry_run?: boolean };
    const beaconDays = Number(b.beacon_days ?? 30);
    const eventDays = Number(b.event_days ?? 30);
    if (!Number.isFinite(beaconDays) || beaconDays < 1 || !Number.isFinite(eventDays) || eventDays < 1)
      return reply.code(400).send({ error: "beacon_days and event_days must be >= 1" });

    const countBeacons = db.prepare("SELECT COUNT(*) AS n FROM beacon_samples WHERE ts <= datetime('now', ?)");
    const countEvents = db.prepare("SELECT COUNT(*) AS n FROM events WHERE created_at <= datetime('now', ?)");
    const beacons = (countBeacons.get(`-${beaconDays} days`) as { n: number }).n;
    const events = (countEvents.get(`-${eventDays} days`) as { n: number }).n;

    if (b.dry_run !== false) return { ok: true, dry_run: true, would_delete: { beacons, events } };

    db.prepare("DELETE FROM beacon_samples WHERE ts <= datetime('now', ?)").run(`-${beaconDays} days`);
    db.prepare("DELETE FROM events WHERE created_at <= datetime('now', ?)").run(`-${eventDays} days`);
    announce({ type: "retention", beacons, events });
    return { ok: true, dry_run: false, deleted: { beacons, events } };
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
