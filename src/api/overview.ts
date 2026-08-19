// GET /api/overview — everything the "is the fleet OK" screen needs, in one
// request. Cached briefly: the overview is the page people leave open, and the
// collector's real job is serving long-polls to the fleet.
import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { AGE, beaconFields, deviceStatus, hasBattery, iso, parse, worstThermal } from "./shared.js";
import { health, schedulesView } from "./system.js";

const CACHE_MS = 2000;
let cached: { at: number; body: unknown } | null = null;

function build() {
  const now = new Date();

  const deviceRows = db
    .prepare(`SELECT device_id, descriptor, pools, last_seen, last_beacon, ${AGE("last_seen")} AS age_s FROM devices`)
    .all() as {
    device_id: string;
    descriptor: string;
    pools: string;
    last_seen: string;
    last_beacon: string | null;
    age_s: number;
  }[];

  const busy = new Set(
    (db.prepare("SELECT claimed_by FROM jobs WHERE status = 'claimed' AND claimed_by IS NOT NULL").all() as {
      claimed_by: string;
    }[]).map((r) => r.claimed_by),
  );
  for (const l of db.prepare("SELECT device_id FROM device_locks").all() as { device_id: string }[])
    busy.add(l.device_id);

  const byStatus = { online: 0, stale: 0, offline: 0 };
  const byPool: Record<string, number> = {};
  let charging = 0;
  // Named, not just counted: "1 device below 15%" makes you go looking, and a
  // bare count cannot be checked against anything.
  const lowBatteryDevices: string[] = [];
  const thermals: (string | null)[] = [];
  for (const d of deviceRows) {
    const status = deviceStatus(d.age_s);
    byStatus[status]++;
    for (const p of parse<string[]>(d.pools, [])) byPool[p] = (byPool[p] ?? 0) + 1;
    const b = beaconFields(parse<Record<string, unknown> | null>(d.last_beacon, null));
    if (b?.charging) charging++;
    // Only trust battery/thermal from devices still checking in — a stale
    // reading is a snapshot of whenever the device stopped talking.
    if (status === "online") {
      thermals.push(b?.thermal ?? null);
      if (hasBattery(b?.battery_pct) && b!.battery_pct! < 15 && b?.charging === false)
        lowBatteryDevices.push(d.device_id);
    }
  }

  const queue = db
    .prepare(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'queued')  AS queued,
         COUNT(*) FILTER (WHERE status = 'claimed') AS claimed,
         COUNT(*) FILTER (WHERE status = 'done'   AND finished_at >= datetime('now','-24 hours')) AS done_24h,
         COUNT(*) FILTER (WHERE status = 'failed' AND finished_at >= datetime('now','-24 hours')) AS failed_24h,
         COUNT(*) FILTER (WHERE status = 'claimed' AND attempts >= max_attempts) AS last_attempt,
         (SELECT ${AGE("MIN(created_at)")} FROM jobs WHERE status = 'queued') AS oldest_queued_age_s
       FROM jobs`,
    )
    .get() as Record<string, number | null>;

  const running = (
    db
      .prepare(
        `SELECT job_id, workload, executor, claimed_by, claimed_at, attempts, max_attempts, lease_deadline, lease_ttl_s,
                ${AGE("claimed_at")} AS elapsed_s,
                CAST(strftime('%s', lease_deadline) - strftime('%s','now') AS INTEGER) AS lease_remaining_s
         FROM jobs WHERE status = 'claimed' ORDER BY claimed_at LIMIT 50`,
      )
      .all() as {
      job_id: string;
      workload: string;
      executor: string;
      claimed_by: string | null;
      claimed_at: string | null;
      attempts: number;
      max_attempts: number;
      lease_deadline: string | null;
      lease_ttl_s: number;
      elapsed_s: number | null;
      lease_remaining_s: number | null;
    }[]
  ).map((j) => ({
    ...j,
    claimed_at: iso(j.claimed_at),
    lease_deadline: iso(j.lease_deadline),
    // How much of the lease window is left, for the shrinking bar.
    lease_fraction:
      j.lease_remaining_s != null && j.lease_ttl_s > 0
        ? Math.max(0, Math.min(1, j.lease_remaining_s / j.lease_ttl_s))
        : null,
  }));

  const recentFailures = (
    db
      .prepare(
        `SELECT job_id, workload, executor, claimed_by, last_error, finished_at, attempts, max_attempts
         FROM jobs WHERE status = 'failed' ORDER BY finished_at DESC LIMIT 10`,
      )
      .all() as {
      job_id: string;
      workload: string;
      executor: string;
      claimed_by: string | null;
      last_error: string | null;
      finished_at: string | null;
      attempts: number;
      max_attempts: number;
    }[]
  ).map((j) => ({ ...j, finished_at: iso(j.finished_at) }));

  const schedules = schedulesView(now);

  return {
    generated_at: now.toISOString(),
    devices: {
      total: deviceRows.length,
      ...byStatus,
      busy: deviceRows.filter((d) => busy.has(d.device_id)).length,
      idle: deviceRows.filter((d) => !busy.has(d.device_id) && deviceStatus(d.age_s) === "online").length,
      charging,
      low_battery: lowBatteryDevices.length,
      low_battery_devices: lowBatteryDevices,
      worst_thermal: worstThermal(thermals),
      by_pool: byPool,
    },
    queue: {
      queued: queue.queued ?? 0,
      claimed: queue.claimed ?? 0,
      done_24h: queue.done_24h ?? 0,
      failed_24h: queue.failed_24h ?? 0,
      last_attempt: queue.last_attempt ?? 0,
      oldest_queued_age_s: queue.oldest_queued_age_s ?? null,
    },
    running,
    recent_failures: recentFailures,
    schedules: {
      total: schedules.length,
      enabled: schedules.filter((s) => s.enabled).length,
      missed: schedules.filter((s) => s.missed).length,
      // The enabled ones, soonest first — a disabled schedule has no next run.
      next: schedules
        .filter((s) => s.enabled && s.next_run_in_s != null)
        .sort((a, b) => (a.next_run_in_s ?? 0) - (b.next_run_in_s ?? 0))
        .slice(0, 5)
        .map((s) => ({ id: s.id, cron: s.cron, next_run: s.next_run, next_run_in_s: s.next_run_in_s, missed: s.missed })),
    },
    health: health(),
  };
}

export function registerOverview(app: FastifyInstance) {
  app.get("/api/overview", async (req) => {
    const fresh = (req.query as Record<string, string | undefined>).fresh === "1";
    if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.body;
    const body = build();
    cached = { at: Date.now(), body };
    return body;
  });
}

/** The overview is the one cached read; anything that changes fleet state
 *  invalidates it so the next poll cannot serve a stale snapshot. */
export function invalidateOverview() {
  cached = null;
}
