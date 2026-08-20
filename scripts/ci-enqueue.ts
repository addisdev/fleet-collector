// CI entry point: upload a build artifact (optional), enqueue a job, poll to
// completion, exit 0/1 on the verdict. This is what a GitHub Actions step
// runs over Tailscale — see ci/example-workflow.yml. Standalone-testable:
//   npx tsx scripts/ci-enqueue.ts --job job.json [--artifact app.apk] [--timeout 900]
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}

const BASE = (args.get("collector") ?? process.env.FLEET_URL ?? "http://127.0.0.1:8788").replace(/\/$/, "");
const JOB_FILE = args.get("job");
const ARTIFACT = args.get("artifact");
const TIMEOUT_S = Number(args.get("timeout") ?? 900);

if (!JOB_FILE) {
  console.error("usage: ci-enqueue --job <spec.json> [--artifact <file>] [--collector <url>] [--timeout <s>]");
  process.exit(2);
}

const spec = JSON.parse(readFileSync(JOB_FILE, "utf8"));

function fail(msg: string): never {
  console.error(`ci-enqueue: ${msg}`);
  process.exit(1);
}

if (ARTIFACT) {
  const body = readFileSync(ARTIFACT);
  const res = await fetch(`${BASE}/artifacts`, {
    method: "POST",
    // Tag the build with the app it belongs to, so a nightly can ask for the
    // latest one instead of pinning a hash somebody has to remember to bump.
    headers: {
      "content-type": "application/octet-stream",
      "x-artifact-name": ARTIFACT.split("/").pop()!,
      ...(spec.app?.name ? { "x-artifact-app": String(spec.app.name) } : {}),
      ...(spec.app?.build ? { "x-artifact-build": String(spec.app.build) } : {}),
      ...(spec.app?.platform ? { "x-artifact-platform": String(spec.app.platform) } : {}),
    },
    body,
  });
  if (!res.ok) fail(`artifact upload -> HTTP ${res.status}`);
  const { sha256 } = (await res.json()) as { sha256: string };
  const local = createHash("sha256").update(body).digest("hex");
  if (sha256 !== local) fail(`artifact hash mismatch: ${sha256} != ${local}`);
  if (spec.app) spec.app.sha256 = sha256;
  else if (spec.model) spec.model.sha256 = sha256;
  console.log(`artifact uploaded: ${sha256}`);
}

const enq = await fetch(`${BASE}/jobs`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(spec),
});
if (enq.status === 409) console.log(`job ${spec.job_id} already queued; polling it`);
else if (!enq.ok) fail(`enqueue -> HTTP ${enq.status}: ${await enq.text()}`);
else console.log(`enqueued ${spec.job_id}`);

const deadline = Date.now() + TIMEOUT_S * 1000;
let status = "queued";
while (Date.now() < deadline) {
  const res = await fetch(`${BASE}/jobs/${spec.job_id}`);
  if (res.ok) {
    status = ((await res.json()) as { status: string }).status;
    if (status === "done" || status === "failed") break;
  }
  await new Promise((r) => setTimeout(r, 10_000));
}

console.log(`job ${spec.job_id}: ${status}`);
if (status === "done") process.exit(0);
if (status === "failed") fail("job failed — per-device details on the collector dashboard");
fail(`timed out after ${TIMEOUT_S}s (status: ${status})`);
