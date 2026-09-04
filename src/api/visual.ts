// Visual-regression baselines: the mutable pointer into the immutable
// artifact store. The executor reads this to know what to diff against; the
// dashboard reads it to render the review grid and writes it when a person
// accepts a shot as the new truth.
//
// Accepting is a mutation and sits behind the token guard like every other
// dashboard mutation. The read side is open like the rest of /api.
import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { requireToken } from "./guard.js";
import { iso, parse } from "./shared.js";

type BaselineRow = {
  suite: string;
  page: string;
  profile: string;
  sha256: string;
  accepted_at: string;
  accepted_from_job: string | null;
};

type Shot = { suite?: string; page?: string; profile?: string; sha256?: string; diff_sha256?: string };
type ShotPayload = {
  ok?: boolean;
  error?: string;
  metrics?: { diff_pct?: number };
  shot?: Shot;
};

/** One run's per-page rows for a suite, in iter (= manifest) order. */
function shotRows(jobId: string, suite: string) {
  const rows = db.prepare(
    "SELECT iter, payload FROM results WHERE job_id = ? AND iter > 0 ORDER BY iter",
  ).all(jobId) as { iter: number; payload: string }[];
  return rows
    .map((r) => ({ iter: r.iter, p: parse<ShotPayload>(r.payload, {}) }))
    .filter((r) => r.p.shot?.suite === suite && r.p.shot.page && r.p.shot.profile);
}

export function registerVisual(app: FastifyInstance) {
  app.get("/api/visual/baselines", async (req) => {
    const { suite } = req.query as { suite?: string };
    const rows = (
      suite
        ? db.prepare("SELECT * FROM baselines WHERE suite = ? ORDER BY page, profile LIMIT 1000").all(suite)
        : db.prepare("SELECT * FROM baselines ORDER BY suite, page, profile LIMIT 1000").all()
    ) as BaselineRow[];
    return {
      baselines: rows.map((r) => ({
        suite: r.suite,
        page: r.page,
        profile: r.profile,
        sha256: r.sha256,
        accepted_at: iso(r.accepted_at),
        accepted_from_job: r.accepted_from_job,
      })),
    };
  });

  // Which suites have visual history at all: anything with an accepted
  // baseline, plus anything a recent web-shots run captured. Both sources,
  // because a brand-new suite has runs but no baselines yet, and a retired
  // one has baselines but no recent runs — and both belong in the picker.
  app.get("/api/visual/suites", async () => {
    const suites = new Set<string>(
      (db.prepare("SELECT DISTINCT suite FROM baselines ORDER BY suite").all() as { suite: string }[]).map((r) => r.suite),
    );
    const recent = db.prepare(
      "SELECT job_id, spec FROM jobs WHERE workload = 'web-shots' ORDER BY created_at DESC LIMIT 100",
    ).all() as { job_id: string; spec: string }[];
    for (const j of recent) {
      const row = db.prepare(
        "SELECT payload FROM results WHERE job_id = ? AND iter > 0 LIMIT 1",
      ).get(j.job_id) as { payload: string } | undefined;
      const s = parse<ShotPayload>(row?.payload ?? null, {}).shot?.suite;
      if (s) suites.add(s);
    }
    return { suites: [...suites].sort() };
  });

  /**
   * The review grid: pages × profiles from the latest run of a suite, each
   * cell judged, plus per-cell history over the last few runs.
   *
   * Assembled from the rows' `shot` blocks — the executor stamps every
   * per-page row with (suite, page, profile, sha256) precisely so this
   * endpoint never has to reverse-engineer identity from iter order.
   */
  app.get("/api/visual/matrix", async (req, reply) => {
    const q = req.query as { suite?: string; runs?: string };
    if (!q.suite) return reply.code(400).send({ error: "suite required" });
    const wantRuns = Math.min(Math.max(Number(q.runs ?? 10) || 10, 1), 25);

    // Newest first, bounded: the grid reads the latest run, history reads a
    // handful more. Jobs from other suites cost one row-parse each to skip.
    const jobs = db.prepare(
      `SELECT job_id, status, created_at, finished_at FROM jobs
       WHERE workload = 'web-shots' ORDER BY created_at DESC LIMIT 100`,
    ).all() as { job_id: string; status: string; created_at: string; finished_at: string | null }[];

    const runs: { job_id: string; status: string; created_at: string | null; rows: ReturnType<typeof shotRows> }[] = [];
    for (const j of jobs) {
      if (runs.length >= wantRuns) break;
      const rows = shotRows(j.job_id, q.suite);
      if (rows.length === 0) continue;
      runs.push({ job_id: j.job_id, status: j.status, created_at: iso(j.created_at), rows });
    }
    if (runs.length === 0) {
      return { suite: q.suite, latest: null, runs: [], profiles: [], pages: [], cells: [] };
    }

    const baselineBySlot = new Map<string, string>(
      (db.prepare("SELECT page, profile, sha256 FROM baselines WHERE suite = ?").all(q.suite) as BaselineRow[])
        .map((b) => [`${b.page}|${b.profile}`, b.sha256]),
    );

    const latest = runs[0];
    // Page order is the latest manifest's order (iter within one profile);
    // profile order is first appearance. Sets keep both stable and deduped.
    const pages: string[] = [];
    const profiles: string[] = [];
    for (const r of latest.rows) {
      const s = r.p.shot!;
      if (!pages.includes(s.page!)) pages.push(s.page!);
      if (!profiles.includes(s.profile!)) profiles.push(s.profile!);
    }

    const cells = latest.rows.map((r) => {
      const s = r.p.shot!;
      const key = `${s.page}|${s.profile}`;
      const baseline = baselineBySlot.get(key) ?? null;
      const captured = !!s.sha256;
      // One word the grid can color by. "new" only when captured: a page that
      // failed to capture is missing whether or not a baseline exists.
      const status = !captured ? "missing" : !baseline ? "new" : r.p.ok ? "pass" : "diverged";
      const history = runs.slice(1).map((run) => {
        const h = run.rows.find((x) => x.p.shot!.page === s.page && x.p.shot!.profile === s.profile);
        return h
          ? { job_id: run.job_id, created_at: run.created_at, ok: h.p.ok ?? null, diff_pct: h.p.metrics?.diff_pct ?? null }
          : { job_id: run.job_id, created_at: run.created_at, ok: null, diff_pct: null };
      });
      return {
        page: s.page,
        profile: s.profile,
        status,
        ok: r.p.ok ?? null,
        diff_pct: r.p.metrics?.diff_pct ?? null,
        note: r.p.error ?? null,
        sha256: s.sha256 ?? null,
        diff_sha256: s.diff_sha256 ?? null,
        baseline_sha256: baseline,
        history,
      };
    });

    return {
      suite: q.suite,
      latest: { job_id: latest.job_id, status: latest.status, created_at: latest.created_at },
      runs: runs.map((r) => ({ job_id: r.job_id, status: r.status, created_at: r.created_at })),
      profiles,
      pages,
      cells,
    };
  });

  app.post("/api/visual/baselines/accept", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const b = (req.body ?? {}) as {
      suite?: string; page?: string; profile?: string; sha256?: string; job_id?: string;
    };
    for (const field of ["suite", "page", "profile", "sha256"] as const) {
      if (!b[field] || typeof b[field] !== "string") {
        return reply.code(400).send({ error: `${field} required` });
      }
    }
    if (!/^[a-f0-9]{64}$/.test(b.sha256!)) {
      return reply.code(400).send({ error: "sha256 must be 64 hex chars" });
    }
    // A baseline pointing at bytes the store does not hold would fail every
    // diff forever while looking like an accepted truth — refuse it here, once,
    // rather than diagnosing it nightly.
    if (!db.prepare("SELECT 1 FROM artifacts WHERE sha256 = ?").get(b.sha256)) {
      return reply.code(404).send({ error: `no such artifact: ${b.sha256}` });
    }
    db.prepare(
      `INSERT INTO baselines (suite, page, profile, sha256, accepted_at, accepted_from_job)
       VALUES (?, ?, ?, ?, datetime('now'), ?)
       ON CONFLICT(suite, page, profile) DO UPDATE SET
         sha256 = excluded.sha256,
         accepted_at = excluded.accepted_at,
         accepted_from_job = excluded.accepted_from_job`,
    ).run(b.suite, b.page, b.profile, b.sha256, b.job_id ?? null);
    // Accepting a shot is the moment its bytes stop being one run's output and
    // start being the thing every future run is judged against, so it is also
    // the moment it must survive artifact collection. Pinning here rather than
    // relying on the GC scan means a baseline is safe even if the scan is
    // later narrowed or a pruning pass is written that never heard of it.
    db.prepare(
      "UPDATE artifacts SET pinned = 1, pin_reason = ? WHERE sha256 = ?",
    ).run(`accepted visual baseline for ${b.suite}/${b.page} (${b.profile})`, b.sha256);
    return reply.code(201).send({ ok: true, suite: b.suite, page: b.page, profile: b.profile, sha256: b.sha256 });
  });
}
