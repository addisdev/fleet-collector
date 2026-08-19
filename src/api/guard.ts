// The mutation guard.
//
// This is a speed bump, not authentication. The collector is LAN/Tailscale-only
// and `POST /jobs` stays open so CI and curl keep working — anyone who can
// reach the dashboard can already enqueue work. What the token buys is that a
// stray tab, a bookmarked URL, or a misfired script cannot *cancel* or *delete*
// without carrying it. Unset (the default) means every mutation is allowed,
// exactly as before this existed.
import type { FastifyReply, FastifyRequest } from "fastify";

const TOKEN = process.env.FLEET_DASH_TOKEN;

export const guardEnabled = () => !!TOKEN;

/** Returns true when the request may proceed; sends 401 and returns false when
 *  it may not, so callers can `if (!requireToken(req, reply)) return;`. */
export function requireToken(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!TOKEN) return true;
  const supplied = req.headers["x-fleet-token"];
  if (typeof supplied === "string" && supplied === TOKEN) return true;
  reply.code(401).send({ error: "X-Fleet-Token required (FLEET_DASH_TOKEN is set on the collector)" });
  return false;
}
