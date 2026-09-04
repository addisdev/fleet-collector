// Every environment knob in one place. Both the collector and the dashboard
// API need these paths, and two copies of `path.resolve("artifacts/store")`
// would drift the first time someone changed a default.
import path from "node:path";

export const PORT = Number(process.env.FLEET_PORT ?? 8788);

/**
 * Which addresses the collector answers on. Comma-separated; the default is
 * every interface, which is what it has always done and what a LAN-only fleet
 * wants.
 *
 * It is a list because the useful posture has two entries and no wildcard: a
 * loopback address so the dashboard and the local executor keep working, and
 * the host's own tailnet address so roaming agents can reach it — without the
 * LAN, the guest network, or a hotel's wifi being able to. The README's "no
 * auth, LAN only" threat model stops being true the moment an agent claims
 * work from outside the house, and this is the knob that makes it true again.
 *
 *   FLEET_BIND=127.0.0.1,100.x.y.z
 */
export const BIND = (process.env.FLEET_BIND ?? "0.0.0.0")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);
export const DATA_DIR = process.env.FLEET_DATA_DIR ?? path.resolve("data");
export const ARTIFACT_DIR = process.env.FLEET_ARTIFACT_DIR ?? path.resolve("artifacts/store");
export const POWER_CONFIG_PATH = process.env.FLEET_POWER_CONFIG ?? path.resolve("power.json");

export const SWEEP_MS = Number(process.env.FLEET_SWEEP_MS ?? 15_000);
export const SCHEDULER_TICK_MS = Number(process.env.FLEET_SCHEDULER_TICK_MS ?? 20_000);

// CI integration is BUILT BUT OFF. Statuses are recorded (posted=0) unless
// both are set: FLEET_GITHUB_STATUS=1 arms posting, FLEET_GITHUB_TOKEN
// authenticates it.
export const GITHUB_STATUS_ARMED = process.env.FLEET_GITHUB_STATUS === "1";
export const GITHUB_TOKEN = process.env.FLEET_GITHUB_TOKEN;
export const GITHUB_API = process.env.FLEET_GITHUB_API ?? "https://api.github.com";

// launchd sends both streams here and does not rotate it; the dashboard's
// system page reports its size so it cannot quietly eat the disk.
export const LOG_FILE =
  process.env.FLEET_LOG_FILE ?? path.join(process.env.HOME ?? "", "Library/Logs/fleet-collector.log");

// Built dashboard assets. Absent on a fresh checkout — the collector serves a
// build-me placeholder rather than failing to start.
export const DASH_DIST = process.env.FLEET_DASH_DIST ?? path.resolve("dash/dist");
