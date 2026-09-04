// GET /api/results (filtered) and GET /api/results/bench (cross-device table)
//
// The metric-normalization rules from the plan are enforced here, not in the
// UI: prefill and decode stay separate fields, every memory number carries the
// method that produced it, and simulator rows are flagged so a comparison view
// can drop them. A client that ignores the flags still cannot accidentally
// merge prefill and decode, because they are never summed into one number.
import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { AGE, beaconFields, inClause, iso, isSimulator, paging, parse } from "./shared.js";

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

  // Pass/fail per (build, device) for ui-test jobs, plus the matrix the D3
  // screen renders: builds down, devices across.
  app.get("/api/results/ui", async () => {
    const rows = db
      .prepare(
        `SELECT r.job_id, r.device_id, r.payload, r.created_at, j.spec
         FROM results r JOIN jobs j ON j.job_id = r.job_id
         -- Rows that report a test outcome, not rows marked final. The host
         -- executor posts the per-device verdict WITHOUT final, then a final
         -- host:<name> summary carrying no test data at all -- so filtering on
         -- final selected exactly the rows with nothing in them, and every real
         -- executor-driven run was invisible here.
         WHERE j.workload = 'ui-test' AND json_extract(r.payload, '$.test') IS NOT NULL
         ORDER BY r.created_at DESC LIMIT 500`,
      )
      .all() as { job_id: string; device_id: string; payload: string; created_at: string; spec: string }[];

    const runs = rows.map((r) => {
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
        artifacts: (payload.test?.artifacts ?? payload.artifacts ?? []) as string[],
      };
    });

    // The host executor also posts a `host:<name>` summary row per job. It is
    // the executor's verdict, not a device's, and putting it in a device column
    // would invent a device that does not exist.
    const deviceRuns = runs.filter((r) => !r.device_id.startsWith("host:"));
    const builds = [...new Set(deviceRuns.map((r) => `${r.app ?? "?"} ${r.build ?? "?"}`))];
    const devices = [...new Set(deviceRuns.map((r) => r.device_id))].sort();

    const matrix = builds.map((build) => ({
      build,
      cells: devices.map((device) => {
        // Newest first, so [0] is the current verdict and the rest are history.
        const forCell = deviceRuns.filter((r) => `${r.app ?? "?"} ${r.build ?? "?"}` === build && r.device_id === device);
        const latest = forCell[0] ?? null;
        // A test that alternates verdict across runs of the same build on the
        // same device is flaky by definition — nothing about the build or the
        // device changed between them.
        const verdicts = forCell.map((r) => r.ok);
        return {
          device,
          latest,
          runs: forCell.length,
          flaky: new Set(verdicts).size > 1,
        };
      }),
    }));

    return { runs, builds, devices, matrix };
  });

  /**
   * Drain runs: the battery curve per device, and how fast it fell.
   *
   * Percent-per-hour is read from metrics.drain_pct_per_h when present. Older
   * rows put it in decode_tok_s because there was no field for it, so those are
   * returned with pct_per_h_inferred set — a number labelled "tok/s" in storage
   * must not be charted as tok/s, and must not be silently relabelled either.
   */
  /**
   * Thermal runs: throughput against elapsed time, which is a curve rather
   * than a number. The whole point is what happens after the first minute, so
   * every iteration's row is returned rather than a summary — and the moment
   * the OS first changed thermal state is called out, because that is usually
   * where the curve bends and it is the thing a summary would lose.
   */
  app.get("/api/results/thermal", async () => {
    const jobs = db
      .prepare(
        `SELECT job_id, spec, status, created_at, finished_at FROM jobs
         WHERE workload = 'thermal' ORDER BY created_at DESC LIMIT 50`,
      )
      .all() as { job_id: string; spec: string; status: string; created_at: string; finished_at: string | null }[];

    return {
      runs: jobs.map((j) => {
        const spec = parse<Record<string, any>>(j.spec, {});
        const rows = (
          db
            .prepare(
              `SELECT device_id, iter, payload FROM results
               WHERE job_id = ? AND device_id NOT LIKE 'host:%' ORDER BY device_id, iter`,
            )
            .all(j.job_id) as { device_id: string; iter: number; payload: string }[]
        ).map((r) => {
          const p = parse<Record<string, any>>(r.payload, {});
          const m = p.metrics ?? {};
          return {
            device_id: r.device_id,
            iter: r.iter,
            final: p.final === true,
            elapsed_s: typeof m.elapsed_s === "number" ? m.elapsed_s : null,
            decode_tok_s: typeof m.decode_tok_s === "number" ? m.decode_tok_s : null,
            thermal_state: m.thermal_state ?? null,
            battery_pct: m.battery_end_pct ?? m.battery_start_pct ?? null,
            ok: p.ok !== false,
            error: p.error ?? null,
          };
        });

        const byDevice = new Map<string, typeof rows>();
        for (const r of rows) byDevice.set(r.device_id, [...(byDevice.get(r.device_id) ?? []), r]);

        return {
          job_id: j.job_id,
          status: j.status,
          model: spec.model?.name ?? null,
          quant: spec.model?.quant ?? null,
          backend: spec.backend ?? null,
          duration_s: spec.params?.duration_s ?? null,
          started_at: iso(j.created_at),
          finished_at: iso(j.finished_at),
          devices: [...byDevice].map(([device_id, curve]) => {
            const measured = curve.filter((c) => !c.final && c.decode_tok_s !== null);
            const first = measured[0]?.decode_tok_s ?? null;
            const last = measured[measured.length - 1]?.decode_tok_s ?? null;
            // Where the OS first admitted the device was warming up. Reported
            // as elapsed seconds because that is the axis of the chart.
            const baseState = measured[0]?.thermal_state ?? null;
            const bend = measured.find((c) => c.thermal_state !== null && c.thermal_state !== baseState);
            return {
              device_id,
              samples: measured.length,
              first_tok_s: first,
              last_tok_s: last,
              // Negative means it got slower, which is the expected direction
              // and the reason the workload exists.
              drop_pct: first && last ? ((last - first) / first) * 100 : null,
              throttled_at_s: bend?.elapsed_s ?? null,
              throttled_to: bend?.thermal_state ?? null,
              curve: measured,
            };
          }),
        };
      }),
    };
  });

  /**
   * Cold-start runs: one row per launch, so p50 and p95 are computed over real
   * launches rather than over a number the runner already averaged. Split by
   * launch state, because a p95 mixing cold and hot launches describes nothing
   * that ever happens to a user.
   */
  app.get("/api/results/cold-start", async () => {
    const jobs = db
      .prepare(
        `SELECT job_id, spec, status, created_at, finished_at FROM jobs
         WHERE workload = 'cold-start' ORDER BY created_at DESC LIMIT 50`,
      )
      .all() as { job_id: string; spec: string; status: string; created_at: string; finished_at: string | null }[];

    const pct = (xs: number[], p: number): number | null => {
      if (xs.length === 0) return null;
      const sorted = [...xs].sort((a, b) => a - b);
      // Nearest-rank: with ten launches the p95 should be a launch that
      // happened, not an interpolation between two that did.
      const rank = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
      return sorted[Math.max(0, rank)];
    };

    return {
      runs: jobs.map((j) => {
        const spec = parse<Record<string, any>>(j.spec, {});
        const rows = (
          db
            .prepare(
              `SELECT device_id, payload FROM results
               WHERE job_id = ? AND device_id NOT LIKE 'host:%'`,
            )
            .all(j.job_id) as { device_id: string; payload: string }[]
        ).map((r) => {
          const p = parse<Record<string, any>>(r.payload, {});
          const m = p.metrics ?? {};
          return {
            device_id: r.device_id,
            launch_ms: typeof m.launch_ms === "number" ? m.launch_ms : null,
            launch_state: (m.launch_state ?? null) as string | null,
            final: p.final === true,
            ok: p.ok !== false,
            error: p.error ?? null,
          };
        });

        const byDevice = new Map<string, typeof rows>();
        for (const r of rows) byDevice.set(r.device_id, [...(byDevice.get(r.device_id) ?? []), r]);

        return {
          job_id: j.job_id,
          status: j.status,
          app: spec.app?.name ?? spec.params?.app_id ?? null,
          build: spec.app?.build ?? null,
          started_at: iso(j.created_at),
          finished_at: iso(j.finished_at),
          devices: [...byDevice].map(([device_id, launches]) => {
            const states = ["cold", "warm", "hot"] as const;
            return {
              device_id,
              error: launches.find((l) => l.error)?.error ?? null,
              states: states
                .map((state) => {
                  const ms = launches
                    .filter((l) => l.launch_state === state && l.launch_ms !== null)
                    .map((l) => l.launch_ms as number);
                  return { state, launches: ms.length, p50_ms: pct(ms, 50), p95_ms: pct(ms, 95) };
                })
                .filter((s) => s.launches > 0),
            };
          }),
        };
      }),
    };
  });

  app.get("/api/results/drain", async () => {
    const jobs = db
      .prepare(
        `SELECT job_id, spec, status, created_at, finished_at FROM jobs
         WHERE workload = 'drain' ORDER BY created_at DESC LIMIT 50`,
      )
      .all() as { job_id: string; spec: string; status: string; created_at: string; finished_at: string | null }[];

    return {
      runs: jobs.map((j) => {
        const spec = parse<Record<string, any>>(j.spec, {});
        const summaries = (
          db
            .prepare(
              `SELECT device_id, payload FROM results
               WHERE job_id = ? AND iter = 0 AND device_id NOT LIKE 'host:%'`,
            )
            .all(j.job_id) as { device_id: string; payload: string }[]
        ).map((r) => {
          const p = parse<Record<string, any>>(r.payload, {});
          const m = p.metrics ?? {};
          const explicit = typeof m.drain_pct_per_h === "number" ? m.drain_pct_per_h : null;
          return {
            device_id: r.device_id,
            ok: p.ok !== false,
            battery_start_pct: m.battery_start_pct ?? null,
            battery_end_pct: m.battery_end_pct ?? null,
            pct_per_h: explicit ?? (typeof m.decode_tok_s === "number" ? m.decode_tok_s : null),
            pct_per_h_inferred: explicit === null && typeof m.decode_tok_s === "number",
            error: p.error ?? null,
          };
        });

        // The curve itself comes from the beacons the run posted: one sample
        // per check, carrying battery and whether the app was still alive.
        const curve = (
          db
            .prepare("SELECT device_id, ts, sample FROM beacon_samples WHERE job_id = ? ORDER BY ts LIMIT 5000")
            .all(j.job_id) as { device_id: string; ts: string; sample: string }[]
        ).map((b) => ({ device_id: b.device_id, ts: iso(b.ts), ...beaconFields(parse<Record<string, unknown>>(b.sample, {})) }));

        return {
          job_id: j.job_id,
          status: j.status,
          app: spec.app?.name ?? spec.params?.app_id ?? null,
          build: spec.app?.build ?? null,
          scenario: spec.params?.scenario ?? null,
          started_at: iso(j.created_at),
          finished_at: iso(j.finished_at),
          devices: summaries,
          curve,
        };
      }),
    };
  });

  /**
   * Soak runs: the OEM-task-killer survival matrix. The measurement is simply
   * whether the process was still alive at each check, so the timeline is the
   * result — a single pass/fail would throw away when it died.
   */
  app.get("/api/results/soak", async () => {
    const jobs = db
      .prepare(
        `SELECT job_id, spec, status, created_at, finished_at FROM jobs
         WHERE workload = 'soak' ORDER BY created_at DESC LIMIT 50`,
      )
      .all() as { job_id: string; spec: string; status: string; created_at: string; finished_at: string | null }[];

    return {
      runs: jobs.map((j) => {
        const spec = parse<Record<string, any>>(j.spec, {});
        const checks = (
          db
            .prepare(
              `SELECT device_id, iter, payload, created_at FROM results
               WHERE job_id = ? AND iter > 0 AND device_id NOT LIKE 'host:%' ORDER BY device_id, iter`,
            )
            .all(j.job_id) as { device_id: string; iter: number; payload: string; created_at: string }[]
        ).map((r) => {
          const p = parse<Record<string, any>>(r.payload, {});
          return { device_id: r.device_id, iter: r.iter, alive: p.ok !== false, at: iso(r.created_at), error: p.error ?? null };
        });

        const devices = [...new Set(checks.map((c) => c.device_id))].sort();
        return {
          job_id: j.job_id,
          status: j.status,
          app: spec.params?.app_id ?? spec.app?.name ?? null,
          started_at: iso(j.created_at),
          finished_at: iso(j.finished_at),
          devices: devices.map((device) => {
            const mine = checks.filter((c) => c.device_id === device);
            const died = mine.find((c) => !c.alive) ?? null;
            return {
              device_id: device,
              checks: mine,
              survived: mine.length > 0 && mine.every((c) => c.alive),
              // When it died matters more than that it died: an app killed at
              // check 2 and one killed at check 40 are different findings.
              died_at_check: died?.iter ?? null,
              died_at: died?.at ?? null,
            };
          }),
        };
      }),
    };
  });

  /**
   * Vision-eval runs (batch jobs on a vision backend): accuracy and latency per
   * model per device.
   *
   * Runners that predate the named metric fields encoded these in LLM slots —
   * top-1 in decode_tok_s, p50 in ttft_ms, images/sec in prefill_tok_s — and
   * had nowhere at all to put top-5 or p95, which is why the published eval
   * report carries numbers this table cannot. Inferred values are flagged and
   * the missing ones are returned as null rather than guessed.
   */
  app.get("/api/results/vision", async () => {
    const VISION_BACKENDS = new Set(["litert", "coreml", "tflite", "vision"]);
    const rows = db
      .prepare(
        `SELECT r.job_id, r.device_id, r.payload, r.created_at, j.spec
         FROM results r JOIN jobs j ON j.job_id = r.job_id
         WHERE j.workload = 'batch' AND json_extract(r.payload, '$.final') = 1
         ORDER BY r.created_at DESC LIMIT 500`,
      )
      .all() as { job_id: string; device_id: string; payload: string; created_at: string; spec: string }[];

    const descriptors = new Map(
      (db.prepare("SELECT device_id, descriptor FROM devices").all() as { device_id: string; descriptor: string }[]).map(
        (d) => [d.device_id, parse<Record<string, unknown>>(d.descriptor, {})],
      ),
    );

    const runs = rows
      .filter((r) => VISION_BACKENDS.has(String(parse<Record<string, any>>(r.spec, {}).backend ?? "")))
      .map((r) => {
        const spec = parse<Record<string, any>>(r.spec, {});
        const p = parse<Record<string, any>>(r.payload, {});
        const m = p.metrics ?? {};
        const named = typeof m.top1_pct === "number" || typeof m.p50_ms === "number";
        const descriptor = descriptors.get(r.device_id) ?? {};
        return {
          job_id: r.job_id,
          device_id: r.device_id,
          device_model: descriptor.model ?? null,
          simulator: isSimulator(descriptor, r.device_id),
          at: iso(r.created_at),
          model: spec.model?.name ?? null,
          quant: spec.model?.quant ?? null,
          backend: spec.backend ?? null,
          accel: spec.params?.accelerator ?? spec.params?.delegate ?? null,
          top1_pct: named ? (m.top1_pct ?? null) : (typeof m.decode_tok_s === "number" ? m.decode_tok_s : null),
          // Never inferred: no legacy slot ever carried these.
          top5_pct: m.top5_pct ?? null,
          p50_ms: named ? (m.p50_ms ?? null) : (typeof m.ttft_ms === "number" ? m.ttft_ms : null),
          p95_ms: m.p95_ms ?? null,
          images_per_s: named ? (m.images_per_s ?? null) : (typeof m.prefill_tok_s === "number" ? m.prefill_tok_s : null),
          load_ms: m.load_ms ?? null,
          peak_mem_mb: m.peak_mem_mb ?? null,
          mem_method: m.mem_method ?? null,
          inferred: !named,
        };
      });

    return {
      runs,
      // So the page can say once, at the top, that some rows are being read
      // through a convention rather than a contract.
      inferred_count: runs.filter((r) => r.inferred).length,
      missing_top5: runs.filter((r) => r.top5_pct == null).length,
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
