// GET /api/results (filtered) and GET /api/results/bench (cross-device table)
//
// The metric-normalization rules from the plan are enforced here, not in the
// UI: prefill and decode stay separate fields, every memory number carries the
// method that produced it, and simulator rows are flagged so a comparison view
// can drop them. A client that ignores the flags still cannot accidentally
// merge prefill and decode, because they are never summed into one number.
import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { AGE, inClause, iso, isSimulator, paging, parse } from "./shared.js";

type ResultRow = {
  job_id: string;
  device_id: string;
  iter: number;
  payload: string;
  created_at: string;
  workload: string;
  spec: string;
};

/** The grouping key for "these numbers are comparable to each other". */
function configKey(spec: Record<string, any>) {
  const p = spec.params ?? {};
  const model = spec.model?.name ?? "synthetic";
  const quant = spec.model?.quant ? ` ${spec.model.quant}` : "";
  return `${model}${quant} · ${spec.backend ?? "synthetic"} · pp${p.prompt_tokens ?? 512}/tg${p.gen_tokens ?? 128}`;
}

export function registerResults(app: FastifyInstance) {
  app.get("/api/results", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const where: string[] = [];
    const params: unknown[] = [];

    if (q.job) {
      where.push("r.job_id = ?");
      params.push(q.job);
    }
    if (q.device) {
      where.push("r.device_id = ?");
      params.push(q.device);
    }
    const workload = inClause("j.workload", q.workload);
    if (workload) {
      where.push(workload.sql);
      params.push(...workload.params);
    }
    if (q.final === "true") where.push("json_extract(r.payload, '$.final') = 1");
    if (q.ok === "false") where.push("json_extract(r.payload, '$.ok') = 0");
    if (q.from) {
      where.push("r.created_at >= ?");
      params.push(q.from.replace("T", " ").replace("Z", ""));
    }
    if (q.to) {
      where.push("r.created_at <= ?");
      params.push(q.to.replace("T", " ").replace("Z", ""));
    }

    const sql = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    const total = (
      db.prepare(`SELECT COUNT(*) AS n FROM results r JOIN jobs j ON j.job_id = r.job_id${sql}`).get(...params) as {
        n: number;
      }
    ).n;

    const { page, per_page, offset } = paging(q);
    const rows = db
      .prepare(
        `SELECT r.job_id, r.device_id, r.iter, r.payload, r.created_at, j.workload, j.spec
         FROM results r JOIN jobs j ON j.job_id = r.job_id${sql}
         ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, per_page, offset) as ResultRow[];

    return {
      page,
      per_page,
      total,
      pages: Math.max(1, Math.ceil(total / per_page)),
      results: rows.map((r) => {
        const payload = parse<Record<string, any>>(r.payload, {});
        return {
          job_id: r.job_id,
          device_id: r.device_id,
          iter: r.iter,
          workload: r.workload,
          final: !!payload.final,
          ok: payload.ok !== false,
          created_at: iso(r.created_at),
          metrics: payload.metrics ?? null,
          test: payload.test ?? null,
          payload,
        };
      }),
    };
  });

  // One entry per comparable configuration: the latest passing run per device,
  // plus that device's history under the same configuration for trend charts.
  app.get("/api/results/bench", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const limit = Math.min(5000, Math.max(100, Number(q.limit ?? 1000) || 1000));

    const rows = db
      .prepare(
        `SELECT r.job_id, r.device_id, r.iter, r.payload, r.created_at, j.workload, j.spec
         FROM results r JOIN jobs j ON j.job_id = r.job_id
         WHERE j.workload = 'benchmark' AND json_extract(r.payload, '$.final') = 1
           AND json_extract(r.payload, '$.ok') = 1
         ORDER BY r.created_at DESC LIMIT ?`,
      )
      .all(limit) as ResultRow[];

    const descriptors = new Map(
      (db.prepare("SELECT device_id, descriptor FROM devices").all() as {
        device_id: string;
        descriptor: string;
      }[]).map((d) => [d.device_id, parse<Record<string, unknown>>(d.descriptor, {})]),
    );

    type Point = {
      job_id: string;
      at: string | null;
      prefill_tok_s: number | null;
      decode_tok_s: number | null;
      ttft_ms: number | null;
      load_ms: number | null;
      peak_mem_mb: number | null;
      mem_method: string | null;
      thermal: unknown;
    };

    const configs = new Map<string, Map<string, Point[]>>();
    for (const r of rows) {
      const spec = parse<Record<string, any>>(r.spec, {});
      const payload = parse<Record<string, any>>(r.payload, {});
      const m = payload.metrics ?? {};
      const key = configKey(spec);
      const perDevice = configs.get(key) ?? new Map<string, Point[]>();
      const history = perDevice.get(r.device_id) ?? [];
      history.push({
        job_id: r.job_id,
        at: iso(r.created_at),
        prefill_tok_s: m.prefill_tok_s ?? null,
        decode_tok_s: m.decode_tok_s ?? null,
        ttft_ms: m.ttft_ms ?? null,
        load_ms: m.load_ms ?? null,
        peak_mem_mb: m.peak_mem_mb ?? null,
        // Never defaulted: an unlabeled memory number is not comparable to
        // anything, and pretending otherwise is the whole failure mode.
        mem_method: m.mem_method ?? null,
        thermal: m.thermal ?? null,
      });
      perDevice.set(r.device_id, history);
      configs.set(key, perDevice);
    }

    return {
      configs: [...configs.entries()].map(([key, perDevice]) => ({
        config: key,
        devices: [...perDevice.entries()]
          .map(([device_id, history]) => {
            const descriptor = descriptors.get(device_id) ?? {};
            return {
              device_id,
              model: descriptor.model ?? null,
              os: descriptor.os ?? null,
              simulator: isSimulator(descriptor, device_id),
              // rows arrived newest-first
              latest: history[0],
              history: [...history].reverse(),
            };
          })
          .sort((a, b) => (b.latest.decode_tok_s ?? 0) - (a.latest.decode_tok_s ?? 0)),
      })),
    };
  });

  // Pass/fail per (build, device) for ui-test jobs — the shape the D3 matrix
  // needs, exposed now so the API contract is settled.
  app.get("/api/results/ui", async () => {
    const rows = db
      .prepare(
        `SELECT r.job_id, r.device_id, r.payload, r.created_at, j.spec
         FROM results r JOIN jobs j ON j.job_id = r.job_id
         WHERE j.workload = 'ui-test' AND json_extract(r.payload, '$.final') = 1
         ORDER BY r.created_at DESC LIMIT 500`,
      )
      .all() as { job_id: string; device_id: string; payload: string; created_at: string; spec: string }[];

    return {
      runs: rows.map((r) => {
        const spec = parse<Record<string, any>>(r.spec, {});
        const payload = parse<Record<string, any>>(r.payload, {});
        return {
          job_id: r.job_id,
          device_id: r.device_id,
          at: iso(r.created_at),
          app: spec.app?.name ?? null,
          build: spec.app?.build ?? null,
          suite: spec.suite?.kind ?? null,
          ok: payload.ok !== false,
          passed: payload.test?.passed ?? null,
          failed: payload.test?.failed ?? null,
        };
      }),
    };
  });

  app.get("/api/results/recent", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const limit = Math.min(200, Math.max(1, Number(q.limit ?? 25) || 25));
    const rows = db
      .prepare(
        `SELECT r.job_id, r.device_id, r.iter, r.payload, r.created_at, j.workload, j.spec,
                ${AGE("r.created_at")} AS age_s
         FROM results r JOIN jobs j ON j.job_id = r.job_id
         ORDER BY r.created_at DESC LIMIT ?`,
      )
      .all(limit) as (ResultRow & { age_s: number })[];

    return {
      results: rows.map((r) => {
        const payload = parse<Record<string, any>>(r.payload, {});
        const m = payload.metrics;
        const t = payload.test;
        return {
          job_id: r.job_id,
          device_id: r.device_id,
          iter: r.iter,
          workload: r.workload,
          final: !!payload.final,
          ok: payload.ok !== false,
          created_at: iso(r.created_at),
          age_s: r.age_s,
          summary: m
            ? `decode ${m.decode_tok_s ?? "?"} tok/s · ${m.peak_mem_mb ?? "?"} MB (${m.mem_method ?? "?"})`
            : t
              ? `${t.passed ?? 0} passed / ${t.failed ?? 0} failed`
              : "",
        };
      }),
    };
  });
}
