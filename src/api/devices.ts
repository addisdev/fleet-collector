// GET /api/devices, /api/devices/:id, /api/devices/:id/beacons
import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { AGE, beaconFields, deviceCapabilities, deviceStatus, effectivePools, iso, isSimulator, paging, parse } from "./shared.js";

type DeviceRow = {
  device_id: string;
  descriptor: string;
  pools: string;
  pools_override: string | null;
  capabilities: string | null;
  last_net: string | null;
  name: string | null;
  notes: string | null;
  last_seen: string;
  last_beacon: string | null;
  age_s: number | null;
};

const DEVICE_SELECT = `SELECT device_id, descriptor, pools, pools_override, capabilities, last_net, name, notes,
                              last_seen, last_beacon, ${AGE("last_seen")} AS age_s
                       FROM devices`;

function shapeDevice(d: DeviceRow) {
  const descriptor = parse<Record<string, unknown>>(d.descriptor, {});
  const beacon = beaconFields(parse<Record<string, unknown> | null>(d.last_beacon, null));
  return {
    device_id: d.device_id,
    name: d.name,
    notes: d.notes,
    descriptor,
    // `pools` is what the queue actually uses; the two sources stay visible
    // beside it so an override is never mistaken for the device's own report.
    pools: effectivePools(d),
    pools_reported: parse<string[]>(d.pools, []),
    pools_override: parse<string[] | null>(d.pools_override, null),
    // null, not [], for an agent that predates capabilities: the dashboard says
    // "all" for that case rather than showing it as able to run nothing.
    capabilities: deviceCapabilities(d),
    last_net: d.last_net,
    platform: /ios|iphone|ipad/i.test(String(descriptor.os ?? "")) ? "ios" : "android",
    simulator: isSimulator(descriptor, d.device_id),
    status: deviceStatus(d.age_s),
    age_s: d.age_s,
    last_seen: iso(d.last_seen),
    beacon,
  };
}

export function registerDevices(app: FastifyInstance) {
  app.get("/api/devices", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const rows = db.prepare(`${DEVICE_SELECT} ORDER BY last_seen DESC`).all() as DeviceRow[];

    // Current work and locks in two queries rather than two per device.
    const claims = new Map(
      (
        db
          .prepare("SELECT job_id, workload, claimed_by FROM jobs WHERE status = 'claimed' AND claimed_by IS NOT NULL")
          .all() as { job_id: string; workload: string; claimed_by: string }[]
      ).map((j) => [j.claimed_by, j]),
    );
    const locks = new Map(
      (
        db.prepare("SELECT device_id, job_id, acquired_at FROM device_locks").all() as {
          device_id: string;
          job_id: string;
          acquired_at: string;
        }[]
      ).map((l) => [l.device_id, l]),
    );

    let devices = rows.map((d) => {
      const lock = locks.get(d.device_id);
      return {
        ...shapeDevice(d),
        // A device is busy when it holds a lock (host-driven work) or is the
        // claimant of a claimed job (device-executor work).
        current_job: claims.get(d.device_id)?.job_id ?? lock?.job_id ?? null,
        lock: lock ? { job_id: lock.job_id, acquired_at: iso(lock.acquired_at) } : null,
      };
    });

    if (q.status) {
      const want = new Set(q.status.split(","));
      devices = devices.filter((d) => want.has(d.status));
    }
    if (q.pool) devices = devices.filter((d) => d.pools.includes(q.pool!));
    if (q.platform) devices = devices.filter((d) => d.platform === q.platform);
    if (q.simulator === "false") devices = devices.filter((d) => !d.simulator);
    if (q.q) {
      const needle = q.q.toLowerCase();
      devices = devices.filter((d) =>
        `${d.device_id} ${d.descriptor.model ?? ""} ${d.descriptor.os ?? ""} ${d.descriptor.soc ?? ""}`
          .toLowerCase()
          .includes(needle),
      );
    }

    // Facet over effective pools, so a pool that exists only as an override is
    // still offered in the filter.
    const pools = [...new Set(rows.flatMap((d) => effectivePools(d)))].sort();
    return { total: devices.length, pools, devices };
  });

  app.get("/api/devices/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.prepare(`${DEVICE_SELECT} WHERE device_id = ?`).get(id) as DeviceRow | undefined;
    if (!row) return reply.code(404).send({ error: "unknown device" });

    const lock = db.prepare("SELECT job_id, acquired_at FROM device_locks WHERE device_id = ?").get(id) as
      | { job_id: string; acquired_at: string }
      | undefined;

    // Jobs this device claimed, plus jobs pinned to it that it has not run yet.
    const jobs = db
      .prepare(
        `SELECT job_id, workload, executor, status, created_at, finished_at, attempts, max_attempts, last_error
         FROM jobs
         WHERE claimed_by = ? OR json_extract(spec, '$.targets.device_id') = ?
         ORDER BY COALESCE(finished_at, created_at) DESC LIMIT 50`,
      )
      .all(id, id) as {
      job_id: string;
      workload: string;
      executor: string;
      status: string;
      created_at: string;
      finished_at: string | null;
      attempts: number;
      max_attempts: number;
      last_error: string | null;
    }[];

    const latestBench = db
      .prepare(
        `SELECT r.job_id, r.payload, r.created_at, j.spec
         FROM results r JOIN jobs j ON j.job_id = r.job_id
         WHERE r.device_id = ? AND j.workload = 'benchmark'
           AND json_extract(r.payload, '$.final') = 1 AND json_extract(r.payload, '$.ok') = 1
         ORDER BY r.created_at DESC LIMIT 10`,
      )
      .all(id) as { job_id: string; payload: string; created_at: string; spec: string }[];

    const counts = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM results WHERE device_id = ?)         AS results,
           (SELECT COUNT(*) FROM beacon_samples WHERE device_id = ?)  AS beacons`,
      )
      .get(id, id) as { results: number; beacons: number };

    return {
      ...shapeDevice(row),
      current_job:
        (
          db.prepare("SELECT job_id FROM jobs WHERE status = 'claimed' AND claimed_by = ? LIMIT 1").get(id) as
            | { job_id: string }
            | undefined
        )?.job_id ??
        lock?.job_id ??
        null,
      lock: lock ? { job_id: lock.job_id, acquired_at: iso(lock.acquired_at) } : null,
      counts,
      jobs: jobs.map((j) => ({
        ...j,
        created_at: iso(j.created_at),
        finished_at: iso(j.finished_at),
      })),
      benchmarks: latestBench.map((b) => {
        const spec = parse<Record<string, any>>(b.spec, {});
        const payload = parse<Record<string, any>>(b.payload, {});
        return {
          job_id: b.job_id,
          at: iso(b.created_at),
          model: spec.model?.name ?? "synthetic",
          quant: spec.model?.quant ?? null,
          backend: spec.backend ?? "synthetic",
          metrics: payload.metrics ?? null,
        };
      }),
    };
  });

  // Beacon history drives the battery/thermal charts. Bounded by default: a
  // 60 s beacon is ~1.4 k rows per device per day and the chart cannot use more
  // than a few thousand points anyway.
  app.get("/api/devices/:id/beacons", async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as Record<string, string | undefined>;
    const hours = Math.min(24 * 30, Math.max(1, Number(q.hours ?? 24) || 24));
    const { per_page, offset } = paging(q, 2000, 5000);

    const rows = db
      .prepare(
        `SELECT ts, job_id, sample FROM beacon_samples
         WHERE device_id = ? AND ts >= datetime('now', ?)
         ORDER BY ts DESC LIMIT ? OFFSET ?`,
      )
      .all(id, `-${hours} hours`, per_page, offset) as { ts: string; job_id: string | null; sample: string }[];

    return {
      device_id: id,
      hours,
      count: rows.length,
      // Ascending: charts want time going left to right.
      samples: rows
        .reverse()
        .map((r) => ({ ts: iso(r.ts), ...beaconFields(parse<Record<string, unknown>>(r.sample, {})), job_id: r.job_id })),
    };
  });
}
