// GET /api/jobs (filtered, paginated) and GET /api/jobs/:id (detail)
import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { AGE, beaconFields, inClause, iso, paging, parse, sha256Refs } from "./shared.js";

const STATUSES = new Set(["queued", "claimed", "done", "failed", "cancelled"]);
const EXECUTORS = new Set(["device", "host"]);
const SORTS: Record<string, string> = {
  created: "created_at",
  updated: "COALESCE(finished_at, claimed_at, created_at)",
  finished: "finished_at",
  job_id: "job_id",
};

type JobRow = {
  job_id: string;
  executor: string;
  workload: string;
  spec: string;
  status: string;
  created_at: string;
  claimed_by: string | null;
  claimed_at: string | null;
  finished_at: string | null;
  lease_ttl_s: number;
  max_attempts: number;
  attempts: number;
  lease_deadline: string | null;
  last_error: string | null;
  priority: number;
  parent_job_id: string | null;
  template_id: string | null;
  lease_remaining_s: number | null;
  duration_s: number | null;
};

const JOB_COLUMNS = `job_id, executor, workload, spec, status, created_at, claimed_by, claimed_at,
  finished_at, lease_ttl_s, max_attempts, attempts, lease_deadline, last_error,
  priority, parent_job_id, template_id,
  CASE WHEN status = 'claimed' AND lease_deadline IS NOT NULL
       THEN CAST(strftime('%s', lease_deadline) - strftime('%s','now') AS INTEGER) END AS lease_remaining_s,
  CASE WHEN claimed_at IS NOT NULL
       THEN CAST(strftime('%s', COALESCE(finished_at, 'now')) - strftime('%s', claimed_at) AS INTEGER) END AS duration_s`;

export function shapeJob(j: JobRow, opts: { spec?: boolean } = {}) {
  const spec = parse<Record<string, any>>(j.spec, {});
  return {
    job_id: j.job_id,
    workload: j.workload,
    executor: j.executor,
    status: j.status,
    claimed_by: j.claimed_by,
    attempts: j.attempts,
    max_attempts: j.max_attempts,
    priority: j.priority,
    template_id: j.template_id,
    lease_ttl_s: j.lease_ttl_s,
    lease_deadline: iso(j.lease_deadline),
    lease_remaining_s: j.lease_remaining_s,
    duration_s: j.duration_s,
    last_error: j.last_error,
    created_at: iso(j.created_at),
    claimed_at: iso(j.claimed_at),
    finished_at: iso(j.finished_at),
    // Pulled out of the spec because every list view filters or groups on them.
    pool: spec.targets?.pool ?? null,
    match: spec.targets?.match ?? null,
    device_id: spec.targets?.device_id ?? null,
    wants_executor: spec.targets?.executor ?? null,
    exclusive: spec.targets?.exclusive ?? false,
    backend: spec.backend ?? null,
    model: spec.model?.name ?? null,
    app: spec.app?.name ?? null,
    report_to: spec.report_to ?? null,
    ...(opts.spec ? { spec } : {}),
  };
}

export function registerJobs(app: FastifyInstance) {
  app.get("/api/jobs", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const where: string[] = [];
    const params: unknown[] = [];

    for (const [column, raw, allowed] of [
      ["status", q.status, STATUSES],
      ["executor", q.executor, EXECUTORS],
      ["workload", q.workload, undefined],
    ] as const) {
      const clause = inClause(column, raw, allowed as Set<string> | undefined);
      if (clause) {
        where.push(clause.sql);
        params.push(...clause.params);
      }
    }
    if (q.pool) {
      where.push("json_extract(spec, '$.targets.pool') = ?");
      params.push(q.pool);
    }
    if (q.device) {
      // Either the device ran it, or it is pinned to that device and waiting.
      where.push("(claimed_by = ? OR json_extract(spec, '$.targets.device_id') = ?)");
      params.push(q.device, q.device);
    }
    if (q.q) {
      where.push("job_id LIKE ?");
      params.push(`%${q.q}%`);
    }
    if (q.has_error === "true") where.push("last_error IS NOT NULL");
    if (q.from) {
      where.push("created_at >= ?");
      params.push(q.from.replace("T", " ").replace("Z", ""));
    }
    if (q.to) {
      where.push("created_at <= ?");
      params.push(q.to.replace("T", " ").replace("Z", ""));
    }

    const sql = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM jobs${sql}`).get(...params) as { n: number }).n;

    const sort = SORTS[q.sort ?? "updated"] ?? SORTS.updated;
    const dir = q.dir === "asc" ? "ASC" : "DESC";
    const { page, per_page, offset } = paging(q);
    const rows = db
      .prepare(`SELECT ${JOB_COLUMNS} FROM jobs${sql} ORDER BY ${sort} ${dir}, job_id ${dir} LIMIT ? OFFSET ?`)
      .all(...params, per_page, offset) as JobRow[];

    // Facets for the filter UI, over the whole table rather than this page.
    const counts = Object.fromEntries(
      (db.prepare("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status").all() as {
        status: string;
        n: number;
      }[]).map((r) => [r.status, r.n]),
    );
    const workloads = (
      db.prepare("SELECT DISTINCT workload FROM jobs ORDER BY workload").all() as { workload: string }[]
    ).map((r) => r.workload);
    const pools = (
      db
        .prepare(
          `SELECT DISTINCT json_extract(spec, '$.targets.pool') AS pool FROM jobs
           WHERE pool IS NOT NULL ORDER BY pool`,
        )
        .all() as { pool: string }[]
    ).map((r) => r.pool);

    return {
      page,
      per_page,
      total,
      pages: Math.max(1, Math.ceil(total / per_page)),
      status_counts: counts,
      workloads,
      pools,
      jobs: rows.map((j) => shapeJob(j)),
    };
  });

  app.get("/api/jobs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.prepare(`SELECT ${JOB_COLUMNS} FROM jobs WHERE job_id = ?`).get(id) as JobRow | undefined;
    if (!row) return reply.code(404).send({ error: "not found" });

    const results = (
      db
        .prepare(`SELECT device_id, iter, payload, created_at, ${AGE("created_at")} AS age_s FROM results WHERE job_id = ? ORDER BY device_id, iter`)
        .all(id) as { device_id: string; iter: number; payload: string; created_at: string; age_s: number }[]
    ).map((r) => ({
      device_id: r.device_id,
      iter: r.iter,
      created_at: iso(r.created_at),
      payload: parse<Record<string, any>>(r.payload, {}),
    }));

    const beacons = (
      db
        .prepare("SELECT ts, device_id, sample FROM beacon_samples WHERE job_id = ? ORDER BY ts LIMIT 2000")
        .all(id) as { ts: string; device_id: string; sample: string }[]
    ).map((b) => ({
      ts: iso(b.ts),
      device_id: b.device_id,
      ...beaconFields(parse<Record<string, unknown>>(b.sample, {})),
    }));

    // Fan-out children are named `<parent>--<device_id>`, and POST /jobs
    // inserts only the children — the parent id never has a row. Since D2 the
    // relationship is recorded in parent_job_id; the string inference below
    // still covers children enqueued before that column existed.
    const pinned = parse<Record<string, any>>(row.spec, {}).targets?.device_id as string | undefined;
    const parent =
      row.parent_job_id ??
      (pinned && id.endsWith(`--${pinned}`)
        ? id.slice(0, -(pinned.length + 2))
        : ((
            db
              .prepare("SELECT job_id FROM jobs WHERE ? LIKE job_id || '--%' ORDER BY LENGTH(job_id) DESC LIMIT 1")
              .get(id) as { job_id: string } | undefined
          )?.job_id ?? null));

    const likePrefix = (p: string) => `${p.replace(/[\\%_]/g, "\\$&")}--%`;
    const childrenOf = (p: string) =>
      (
        db
          .prepare(`SELECT ${JOB_COLUMNS} FROM jobs WHERE job_id LIKE ? ESCAPE '\\' ORDER BY job_id`)
          .all(likePrefix(p)) as JobRow[]
      ).map((c) => shapeJob(c));

    const children = childrenOf(id);
    // The rest of the fan-out. Reachable from any child because the parent id
    // itself has no row to open.
    const siblings = parent ? childrenOf(parent).filter((s) => s.job_id !== id) : [];

    const statusReport = db.prepare("SELECT * FROM status_reports WHERE job_id = ?").get(id) as
      | { target: string; state: string; posted: number; detail: string | null; created_at: string }
      | undefined;

    const lockedDevices = (
      db.prepare("SELECT device_id, acquired_at FROM device_locks WHERE job_id = ?").all(id) as {
        device_id: string;
        acquired_at: string;
      }[]
    ).map((l) => ({ device_id: l.device_id, acquired_at: iso(l.acquired_at) }));

    // Artifacts the job referenced (spec: models, app builds) or produced
    // (results: JUnit, screenshots, batch outputs), resolved against the store.
    const specRefs = new Set(sha256Refs(row.spec));
    const resultRefs = new Set(results.flatMap((r) => sha256Refs(JSON.stringify(r.payload))));
    const allRefs = [...new Set([...specRefs, ...resultRefs])];
    const known = allRefs.length
      ? (db
          .prepare(`SELECT sha256, name, size, created_at FROM artifacts WHERE sha256 IN (${allRefs.map(() => "?").join(",")})`)
          .all(...allRefs) as { sha256: string; name: string | null; size: number; created_at: string }[])
      : [];
    const artifacts = allRefs.map((sha) => {
      const meta = known.find((k) => k.sha256 === sha);
      return {
        sha256: sha,
        name: meta?.name ?? null,
        size: meta?.size ?? null,
        created_at: iso(meta?.created_at),
        // A spec can reference an artifact that was never uploaded — that is a
        // real failure mode (job fails at download), so say so rather than hide it.
        in_store: !!meta,
        role: specRefs.has(sha) ? ("input" as const) : ("output" as const),
      };
    });

    return {
      ...shapeJob(row, { spec: true }),
      parent,
      children,
      siblings,
      results,
      beacons,
      artifacts,
      locks: lockedDevices,
      status_report: statusReport
        ? { ...statusReport, posted: !!statusReport.posted, created_at: iso(statusReport.created_at) }
        : null,
      // What the row can honestly say about its own history. The collector
      // stores current state, not an event log, so this is derived — and the
      // field name says so rather than implying a record that does not exist.
      derived_timeline: [
        { at: iso(row.created_at), what: "queued" },
        ...(row.claimed_at ? [{ at: iso(row.claimed_at), what: `claimed by ${row.claimed_by ?? "?"} (attempt ${row.attempts})` }] : []),
        ...(beacons.length ? [{ at: beacons[0].ts, what: `first beacon of ${beacons.length}` }] : []),
        ...(row.finished_at ? [{ at: iso(row.finished_at), what: row.status }] : []),
      ],
    };
  });
}
