// Helpers shared by the /api/* read endpoints.
import { db } from "../db.js";

/** SQLite writes timestamps as UTC "YYYY-MM-DD HH:MM:SS" with no zone marker,
 *  and V8 parses that shape as LOCAL time — silently shifting every timestamp
 *  by the host's offset. Every timestamp leaving the API goes through here, so
 *  the browser gets unambiguous UTC. */
export const iso = (s: string | null | undefined): string | null =>
  s ? `${s.replace(" ", "T")}Z` : null;

export const parse = <T = Record<string, unknown>>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

/** Age in seconds, computed by SQLite so both sides of the subtraction are UTC. */
export const AGE = (col: string) => `CAST(strftime('%s','now') - strftime('%s', ${col}) AS INTEGER)`;

/**
 * The pools a device actually claims work under: the operator's override when
 * one is set, otherwise what the runner reported at registration. Every claim,
 * fan-out, and match decision goes through this — a pool edit that the queue
 * ignored would be worse than no edit at all.
 */
export function effectivePools(row: { pools: string; pools_override?: string | null }): string[] {
  const override = parse<string[] | null>(row.pools_override ?? null, null);
  return Array.isArray(override) ? override : parse<string[]>(row.pools, []);
}

/**
 * What an agent says it can run. NULL is not an empty list: it is an agent that
 * registered before capabilities existed, and it must keep being offered work
 * or a collector upgrade would silently idle the whole shelf. Callers get null
 * for that case and are expected to treat it as "no opinion", not "nothing".
 */
export function deviceCapabilities(row: { capabilities?: string | null }): string[] | null {
  const parsed = parse<string[] | null>(row.capabilities ?? null, null);
  return Array.isArray(parsed) ? parsed : null;
}

/**
 * The capability a job needs. A job that names a backend can be satisfied two
 * ways: by an agent that declares the exact pairing ("batch:litert"), or by one
 * that declares the workload outright ("batch") and so handles every backend it
 * was built with. Being permissive here is deliberate — the narrow form exists
 * to let a future agent advertise one backend without claiming the workload.
 */
export function capabilityMatches(
  declared: string[] | null,
  workload: string,
  backend?: string | null,
): boolean {
  if (declared === null) return true;
  if (declared.includes(workload)) return true;
  return !!backend && declared.includes(`${workload}:${backend}`);
}

// Devices beacon every 60 s. One missed beacon is normal (the runner may be
// mid-inference); five missed beacons means something is wrong; a quarter hour
// of silence means the device is off the shelf, asleep, or dead.
export const ONLINE_S = 180;
export const STALE_S = 900;

export type DeviceStatus = "online" | "stale" | "offline";

export function deviceStatus(ageS: number | null): DeviceStatus {
  if (ageS == null) return "offline";
  if (ageS <= ONLINE_S) return "online";
  if (ageS <= STALE_S) return "stale";
  return "offline";
}

// Shared thermal enum, worst last — the runners map every platform's native
// thermal state onto these four.
export const THERMAL_ORDER = ["nominal", "fair", "serious", "critical"] as const;

export function worstThermal(states: (string | null | undefined)[]): string | null {
  let worst: string | null = null;
  let worstIdx = -1;
  for (const s of states) {
    const i = THERMAL_ORDER.indexOf(s as (typeof THERMAL_ORDER)[number]);
    if (i > worstIdx) {
      worstIdx = i;
      worst = s ?? null;
    }
  }
  return worst;
}

/** The beacon payload the runners post is `{schema, kind, device_id, beacon:{…}}`.
 *  Older rows and host-driven beacons put the fields at the top level, so read
 *  through both shapes rather than trusting one. */
/** A device with no battery telemetry reports -1, not a low charge: iOS
 *  simulators always do, and treating that as "1% left" turns every simulator
 *  on the shelf into a permanent low-battery alert. */
export const hasBattery = (pct: number | null | undefined): pct is number => typeof pct === "number" && pct >= 0;

export function beaconFields(sample: Record<string, unknown> | null) {
  if (!sample) return null;
  const b = (sample.beacon ?? sample) as Record<string, unknown>;
  return {
    battery_pct: typeof b.battery_pct === "number" ? b.battery_pct : null,
    charging: typeof b.charging === "boolean" ? b.charging : null,
    thermal: typeof b.thermal === "string" ? b.thermal : null,
    mem_mb: typeof b.mem_mb === "number" ? b.mem_mb : typeof b.pss_mb === "number" ? b.pss_mb : null,
    mem_method: typeof b.mem_method === "string" ? b.mem_method : null,
    process_alive: typeof b.process_alive === "boolean" ? b.process_alive : null,
    job_id: typeof sample.job_id === "string" ? sample.job_id : null,
  };
}

/** Simulators are not hardware. Every view that compares devices has to be able
 *  to exclude them, so the flag is derived once, here. */
export function isSimulator(descriptor: Record<string, unknown>, deviceId: string): boolean {
  const hay = `${deviceId} ${String(descriptor.model ?? "")} ${String(descriptor.os ?? "")} ${String(
    descriptor.soc ?? "",
  )}`.toLowerCase();
  // `[-_]sim[-_]` catches the fleet's own naming (iphone-sim-0000), which
  // "simulator" alone misses — and a simulator that slips through this check
  // lands in a hardware comparison table, which is the one thing the flag
  // exists to prevent. Delimited so it cannot fire on a word merely
  // containing "sim".
  return /simulator|emulator|sdk_gphone|goldfish|ranchu|x86_64|[-_]sim[-_]|[-_]sim$/.test(hay);
}

export type Paging = { page: number; per_page: number; offset: number };

export function paging(q: Record<string, string | undefined>, defaultPer = 50, maxPer = 200): Paging {
  const page = Math.max(1, Number(q.page ?? 1) || 1);
  const per_page = Math.min(maxPer, Math.max(1, Number(q.per_page ?? defaultPer) || defaultPer));
  return { page, per_page, offset: (page - 1) * per_page };
}

/** Comma-separated filter values ("done,failed") → parameterized IN clause. */
export function inClause(column: string, raw: string | undefined, allowed?: Set<string>) {
  if (!raw) return null;
  const values = raw
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0 && (!allowed || allowed.has(v)));
  if (values.length === 0) return null;
  return { sql: `${column} IN (${values.map(() => "?").join(",")})`, params: values };
}

/** Every 64-hex string in a blob of JSON — how job specs and result payloads
 *  reference the artifact store, whatever key they use for it. */
export function sha256Refs(text: string): string[] {
  return [...new Set(text.match(/\b[a-f0-9]{64}\b/g) ?? [])];
}

export function tableCounts(): Record<string, number> {
  const tables = [
    "devices",
    "jobs",
    "results",
    "beacon_samples",
    "artifacts",
    "schedules",
    "device_locks",
    "events",
    "status_reports",
  ];
  const out: Record<string, number> = {};
  for (const t of tables) {
    out[t] = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  }
  return out;
}
