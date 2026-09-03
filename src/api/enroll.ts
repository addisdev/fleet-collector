// GET /api/enroll — everything the "add a device" screen needs.
//
// The hard part of enrolling a phone is not the software, it is typing the
// collector's address on a touch keyboard without a typo, once per device. So the screen shows a QR code, and this endpoint supplies the
// addresses that are actually worth encoding.
import type { FastifyInstance } from "fastify";
import { networkInterfaces } from "node:os";
import { PORT } from "../config.js";
import { db } from "../db.js";
import { AGE, iso } from "./shared.js";

/**
 * Addresses a device on the same network could reach this collector on.
 *
 * Derived from the host's own interfaces rather than from the request, because
 * the request may have arrived over an SSH tunnel or a port-forward — in which
 * case the browser's own origin is `127.0.0.1`, which is a perfectly good URL
 * for the operator and a useless one for a phone.
 */
function reachableBases(): { url: string; address: string; iface: string; kind: string }[] {
  const out: { url: string; address: string; iface: string; kind: string }[] = [];
  for (const [iface, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      // Tailscale hands out 100.64.0.0/10; those work from anywhere on the
      // tailnet, which is the difference between "on the shelf" and "at work".
      const [o1, o2] = a.address.split(".").map(Number);
      const tailscale = o1 === 100 && o2 >= 64 && o2 <= 127;
      out.push({
        url: `http://${a.address}:${PORT}`,
        address: a.address,
        iface,
        kind: tailscale ? "tailnet" : "lan",
      });
    }
  }
  // LAN first: a phone on the shelf is on the LAN, and the tailnet address only
  // helps a device already signed in to it.
  return out.sort((x, y) => (x.kind === y.kind ? 0 : x.kind === "lan" ? -1 : 1));
}

export function registerEnroll(app: FastifyInstance) {
  app.get("/api/enroll", async () => {
    // Newest runner build in the store, so the page can offer a download
    // instead of asking someone to go and build one.
    const apk = db
      .prepare(
        `SELECT sha256, name, size, created_at FROM artifacts
         WHERE name LIKE '%.apk' ORDER BY created_at DESC LIMIT 1`,
      )
      .get() as { sha256: string; name: string; size: number; created_at: string } | undefined;

    const devices = db
      .prepare(`SELECT device_id, ${AGE("last_seen")} AS age_s FROM devices`)
      .all() as { device_id: string; age_s: number }[];

    return {
      port: PORT,
      bases: reachableBases(),
      hostname: process.env.HOSTNAME ?? null,
      runner_apk: apk
        ? {
            ...apk,
            created_at: iso(apk.created_at),
            // The filename param is what makes Android offer to install it.
            download: `/artifacts/${apk.sha256}?filename=${encodeURIComponent(apk.name)}`,
          }
        : null,
      // So the screen can tell a device that just appeared from the six that
      // were already there.
      known_device_ids: devices.map((d) => d.device_id),
      pools: [
        ...new Set(
          (db.prepare("SELECT pools, pools_override FROM devices").all() as {
            pools: string;
            pools_override: string | null;
          }[]).flatMap((d) => {
            try {
              const o = d.pools_override ? (JSON.parse(d.pools_override) as string[]) : null;
              return Array.isArray(o) ? o : (JSON.parse(d.pools) as string[]);
            } catch {
              return [];
            }
          }),
        ),
      ].sort(),
    };
  });
}
