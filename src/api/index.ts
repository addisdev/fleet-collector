// The dashboard's read API. Everything here is GET and side-effect free —
// mutations (cancel, retry, schedule toggles) arrive in D2 and will register
// alongside, behind the token guard.
//
// Contract notes that hold for every endpoint:
//   • timestamps are ISO-8601 UTC with a Z, never SQLite's bare local-looking form
//   • every list is bounded; nothing streams an unbounded table to a browser
//   • field names match the job/result schemas, so a reader of `schemas/` can
//     predict the shape
import type { FastifyInstance } from "fastify";
import { registerDevices } from "./devices.js";
import { registerEnroll } from "./enroll.js";
import { registerJobs } from "./jobs.js";
import { registerMutations } from "./mutations.js";
import { registerOverview } from "./overview.js";
import { registerResults } from "./results.js";
import { registerStream } from "./stream.js";
import { registerSystem } from "./system.js";
import { registerVisual } from "./visual.js";

type Announce = (event: { type: string; [k: string]: unknown }) => void;
type MatchingDevices = (
  pool?: string,
  match?: string,
  workload?: string,
  backend?: string | null,
) => {
  device_id: string; pools: string; pools_override: string | null;
  descriptor: string; capabilities: string | null;
}[];

export function registerApi(app: FastifyInstance, announce: Announce, matchingDevices: MatchingDevices) {
  registerOverview(app);
  registerDevices(app);
  registerEnroll(app);
  registerJobs(app);
  registerResults(app);
  registerSystem(app);
  registerVisual(app);
  registerStream(app);
  registerMutations(app, announce, matchingDevices);

  // A JSON 404 for unknown /api paths: without it a typo'd endpoint returns
  // the SPA's index.html and the client tries to JSON.parse an HTML document.
  for (const method of ["get", "post", "patch", "delete"] as const) {
    app[method]("/api/*", async (req, reply) =>
      reply.code(404).send({ error: `no such endpoint: ${req.method} ${(req.params as { "*": string })["*"]}` }),
    );
  }
}

export { publish } from "./stream.js";
export { invalidateOverview } from "./overview.js";
