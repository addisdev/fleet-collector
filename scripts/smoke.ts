// End-to-end smoke: simulates one device-executor client and one host-executor
// client against a running collector. Exercises every Phase 0 endpoint.
// Usage: npm run smoke   (collector must be running on FLEET_URL, default :8788)
import { createHash } from "node:crypto";

import { countXcodebuildTests, xcodebuildDiagnostics } from "../src/xcparse.js";
import {
  fleetOwned, physicalIos, simulatorName, isAndroidEmulatorSerial, iosNotReadyReason,
  adbFailureIsWorthReporting,
} from "../src/targets.js";
import { evalMatch } from "../src/match.js";
import { parseAmStart, amStartProblem } from "../src/am-start.js";
import { parseNetworkProfile } from "../src/network-shape.js";
import { redact, keychainPassword } from "../src/secrets.js";

const BASE = process.env.FLEET_URL ?? "http://127.0.0.1:8788";
let failures = 0;

function check(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ok    ${name}`);
  else {
    failures++;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function json(method: string, url: string, body?: unknown) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const run = Date.now();
const DEVICE = `smoke-pixel-${run}`;
const BENCH_JOB = `smoke-bench-${run}`;
const UI_JOB = `smoke-uitest-${run}`;
const LEASE_JOB = `smoke-lease-${run}`;
const DRAIN_JOB = `smoke-drain-${run}`;
// Scoped to this run: a fixed pool name accumulates devices from every previous
// run against the same collector, and the match/fan-out sections assert on how
// many devices a pool holds.
const MATCH_POOL = `smoke-match-pool-${run}`;

console.log(`smoke against ${BASE}`);

// 1. register a device
{
  const r = await json("POST", "/devices/register", {
    device_id: DEVICE,
    descriptor: { model: "Pixel 4a", soc: "SD730G", ram_mb: 5793, os: "android-13" },
    pools: ["ml-capable", "android-ui"],
  });
  check("device registers", r.status === 200 && r.body?.ok === true, JSON.stringify(r));
}

// 2. upload an artifact, download it back, verify hash + range requests
{
  const blob = Buffer.from(`fake-gguf-model-${run}`.repeat(1000));
  const sha = createHash("sha256").update(blob).digest("hex");
  const up = await fetch(`${BASE}/artifacts`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-artifact-name": "smoke.gguf" },
    body: blob,
  });
  const upBody = await up.json();
  check("artifact upload returns sha", up.status === 201 && upBody.sha256 === sha, JSON.stringify(upBody));

  const down = await fetch(`${BASE}/artifacts/${sha}`);
  const roundtrip = Buffer.from(await down.arrayBuffer());
  check("artifact roundtrips by hash", createHash("sha256").update(roundtrip).digest("hex") === sha);

  const ranged = await fetch(`${BASE}/artifacts/${sha}`, { headers: { range: "bytes=0-9" } });
  const first10 = Buffer.from(await ranged.arrayBuffer());
  check(
    "range request works",
    ranged.status === 206 && first10.length === 10 && first10.equals(blob.subarray(0, 10)),
    `status=${ranged.status} len=${first10.length}`,
  );

  // 3. enqueue a device-executor benchmark referencing the artifact
  const r = await json("POST", "/jobs", {
    schema: 1, job_id: BENCH_JOB, workload: "benchmark", executor: "device",
    model: { name: "smoke-model", format: "gguf", quant: "Q4_K_M", sha256: sha },
    backend: "llama.cpp",
    params: { prompt_tokens: 512, gen_tokens: 128, warmup_iters: 1, measure_iters: 2 },
    targets: { pool: "ml-capable" },
  });
  check("benchmark job enqueues", r.status === 201, JSON.stringify(r));
  const dup = await json("POST", "/jobs", { schema: 1, job_id: BENCH_JOB, workload: "benchmark", executor: "device" });
  check("duplicate job_id rejected with 409", dup.status === 409);
}

// 4. enqueue a host-executor ui-test job
{
  const r = await json("POST", "/jobs", {
    schema: 1, job_id: UI_JOB, workload: "ui-test", executor: "host",
    app: { name: "greenfolio-android", build: "smoke", sha256: "0".repeat(64) },
    suite: { kind: "maestro", flows: "flows/smoke/*.yaml" },
    targets: { pool: "android-ui", exclusive: true },
  });
  check("ui-test job enqueues", r.status === 201, JSON.stringify(r));
}

// 5. device long-polls and claims ONLY the device job
{
  const r = await json("GET", `/devices/${DEVICE}/next-job`);
  check("device claims benchmark job", r.status === 200 && r.body?.job_id === BENCH_JOB, JSON.stringify(r.body));
  check("claimed spec carries model + params", r.body?.model?.name === "smoke-model" && r.body?.params?.measure_iters === 2);
}

// 6. host executor claims ONLY the host job
{
  const r = await json("GET", "/executor/next-job?name=mac-mini");
  check("host executor claims ui-test job", r.status === 200 && r.body?.job_id === UI_JOB, JSON.stringify(r.body));
}

// 7. device posts beacon + per-iteration results + final summary (idempotently)
{
  await json("POST", "/results", {
    schema: 1, kind: "beacon", device_id: DEVICE, job_id: BENCH_JOB,
    beacon: { battery_pct: 74, charging: true, thermal: "nominal" },
  });
  for (const iter of [1, 2]) {
    await json("POST", "/results", {
      schema: 1, kind: "result", job_id: BENCH_JOB, device_id: DEVICE, iter,
      metrics: { decode_tok_s: 9.8 + iter, prefill_tok_s: 61.2, ttft_ms: 8420, peak_mem_mb: 812, mem_method: "pss", thermal: ["nominal"] },
    });
  }
  const retry = await json("POST", "/results", {
    schema: 1, kind: "result", job_id: BENCH_JOB, device_id: DEVICE, iter: 2,
    metrics: { decode_tok_s: 11.8, prefill_tok_s: 61.2, ttft_ms: 8420, peak_mem_mb: 812, mem_method: "pss", thermal: ["nominal"] },
  });
  check("result retry is idempotent", retry.status === 200);
  const fin = await json("POST", "/results", {
    schema: 1, kind: "result", job_id: BENCH_JOB, device_id: DEVICE, iter: 0, final: true, ok: true,
    metrics: { decode_tok_s: 10.8, prefill_tok_s: 61.2, ttft_ms: 8420, peak_mem_mb: 812, mem_method: "pss", thermal: ["nominal", "fair"] },
  });
  check("final result accepted", fin.status === 200);
  const job = await json("GET", `/jobs/${BENCH_JOB}`);
  check("final result marks job done", job.body?.status === "done", `status=${job.body?.status}`);
}

// 8. host executor reports a failing ui-test run
{
  const fin = await json("POST", "/results", {
    schema: 1, kind: "result", job_id: UI_JOB, device_id: DEVICE, iter: 0, final: true, ok: false,
    test: { passed: 11, failed: 1, artifacts: [] },
  });
  check("ui-test final accepted", fin.status === 200);
  const job = await json("GET", `/jobs/${UI_JOB}`);
  check("failing run marks job failed", job.body?.status === "failed", `status=${job.body?.status}`);
}

// 9. a claim that goes quiet expires, requeues, and eventually fails.
// Models the real incident: an emulator's low-memory killer takes out the
// runner mid-benchmark, so no final result and no further beacons ever arrive.
{
  const r = await json("POST", "/jobs", {
    schema: 1, job_id: LEASE_JOB, workload: "benchmark", executor: "device",
    model: { name: "smoke-model", format: "gguf", quant: "Q4_K_M", sha256: "0".repeat(64) },
    targets: { pool: "ml-capable" },
    // Four seconds, not two. SQLite stores whole seconds, so a renewal lands a
    // deadline anywhere in [ttl-1, ttl] from now; with a 2 s lease the margin
    // after a 1 s wait was under a second, and on a loaded machine this test
    // decided the sweep had eaten a lease it had not. The assertion is about
    // renewal, not about timer precision, so give it room to be about that.
    lease: { ttl_s: 4, max_attempts: 2 },
  });
  check("short-lease job enqueues", r.status === 201, JSON.stringify(r));

  const claim = await json("GET", `/devices/${DEVICE}/next-job`);
  check("device claims short-lease job", claim.body?.job_id === LEASE_JOB, JSON.stringify(claim.body));
  check("claimed spec carries effective lease", claim.body?.lease?.ttl_s === 4 && claim.body?.lease?.max_attempts === 2);

  const claimed = await json("GET", `/jobs/${LEASE_JOB}`);
  check(
    "claim records attempt + lease deadline",
    claimed.body?.status === "claimed" && claimed.body?.attempts === 1 && !!claimed.body?.lease_deadline,
    JSON.stringify(claimed.body),
  );

  // A live runner beacons; that must hold the lease open past its original deadline.
  await sleep(1500);
  const beacon = await json("POST", "/results", {
    schema: 1, kind: "beacon", device_id: DEVICE, job_id: LEASE_JOB,
    beacon: { battery_pct: 66, charging: true, thermal: "fair" },
  });
  check("beacon reports lease renewed", beacon.body?.lease_renewed === true, JSON.stringify(beacon.body));
  await sleep(1000);
  const held = await json("POST", "/jobs/sweep");
  check("renewed lease survives the sweep", !held.body?.requeued?.includes(LEASE_JOB), JSON.stringify(held.body));
  check("job still claimed after renewal", (await json("GET", `/jobs/${LEASE_JOB}`)).body?.status === "claimed");

  // Now the runner dies: beacons stop, the lease lapses, the sweep requeues it.
  // Comfortably past the renewed four-second deadline, for the same reason.
  await sleep(5000);
  const swept = await json("POST", "/jobs/sweep");
  check("sweep requeues the expired claim", swept.body?.requeued?.includes(LEASE_JOB), JSON.stringify(swept.body));
  const requeued = await json("GET", `/jobs/${LEASE_JOB}`);
  check(
    "requeued job is claimable again, claimant cleared",
    requeued.body?.status === "queued" && requeued.body?.claimed_by === null && requeued.body?.lease_deadline === null,
    JSON.stringify(requeued.body),
  );
  check("requeue records why", /lease expired/.test(requeued.body?.last_error ?? ""), requeued.body?.last_error);

  // A beacon for a job nobody holds tells the runner to give up.
  const orphan = await json("POST", "/results", {
    schema: 1, kind: "beacon", device_id: DEVICE, job_id: LEASE_JOB,
    beacon: { battery_pct: 65, charging: true, thermal: "fair" },
  });
  check("beacon on an unclaimed job reports no renewal", orphan.body?.lease_renewed === false, JSON.stringify(orphan.body));

  // Second (and last) attempt: another device picks it up and dies the same way.
  const reclaim = await json("GET", `/devices/${DEVICE}/next-job`);
  check("requeued job is handed out again", reclaim.body?.job_id === LEASE_JOB, JSON.stringify(reclaim.body));
  check("retry counts as a second attempt", (await json("GET", `/jobs/${LEASE_JOB}`)).body?.attempts === 2);

  // Past the four-second lease again; the reclaim reset the deadline.
  await sleep(5000);
  const final = await json("POST", "/jobs/sweep");
  // Assert the OUTCOME, not this particular sweep's return value. The collector
  // runs its own sweep every SWEEP_MS, so it frequently gets there first and
  // this call correctly reports nothing left to do -- which made the check fail
  // on a job that had already been failed exactly as intended. A test that goes
  // red when the system worked is the fastest way to teach people to ignore it.
  const exhausted = final.body?.failed?.includes(LEASE_JOB) === true
    || (await json("GET", `/jobs/${LEASE_JOB}`)).body?.status === "failed";
  check("sweep fails the job once attempts run out", exhausted, JSON.stringify(final.body));
  const dead = await json("GET", `/jobs/${LEASE_JOB}`);
  check(
    "exhausted job ends failed, not requeued",
    dead.body?.status === "failed" && dead.body?.attempts === 2 && !!dead.body?.finished_at,
    JSON.stringify(dead.body),
  );
}

// 10. lease defaults: long-running workloads get hours, bad TTLs are rejected.
// Pool nobody is in, so this queued job never interferes with later runs.
{
  const r = await json("POST", "/jobs", {
    schema: 1, job_id: DRAIN_JOB, workload: "drain", executor: "device",
    targets: { pool: `smoke-unclaimable-${run}` },
  });
  check("drain job enqueues without an explicit lease", r.status === 201, JSON.stringify(r));
  const job = await json("GET", `/jobs/${DRAIN_JOB}`);
  check(
    "drain defaults to a multi-hour lease",
    job.body?.lease_ttl_s === 14400 && job.body?.max_attempts === 3,
    JSON.stringify(job.body),
  );

  const bad = await json("POST", "/jobs", {
    schema: 1, job_id: `${DRAIN_JOB}-bad`, workload: "benchmark", executor: "device",
    lease: { ttl_s: 0 },
  });
  check("zero-second lease rejected", bad.status === 400, JSON.stringify(bad));
  const tooLong = await json("POST", "/jobs", {
    schema: 1, job_id: `${DRAIN_JOB}-toolong`, workload: "soak", executor: "device",
    lease: { ttl_s: 999999 },
  });
  check("absurd lease rejected", tooLong.status === 400, JSON.stringify(tooLong));
}

// 11. legacy dashboard shows all of it. Server-rendered and build-step-free,
// so it stays the fallback while the SPA grows into parity.
{
  const html = await (await fetch(`${BASE}/dash/legacy`)).text();
  check("dashboard lists device", html.includes(DEVICE));
  check("dashboard lists both jobs", html.includes(BENCH_JOB) && html.includes(UI_JOB));
  check("dashboard shows benchmark summary", html.includes("tok/s"));
  check("dashboard shows ui-test verdict", html.includes("11 passed / 1 failed"));
  check("dashboard explains the lease failure", html.includes(LEASE_JOB) && html.includes("gave up after 2/2 attempts"));
  const bench = await (await fetch(`${BASE}/dash/legacy/bench`)).text();
  check("legacy bench page renders", bench.includes("Fleet Benchmarks"));
}

// 12. fan-out: one child job per pool device, pinned so only that device claims it
{
  const OTHER = `smoke-tab-${run}`;
  await json("POST", "/devices/register", {
    device_id: OTHER,
    descriptor: { model: "Tab", ram_mb: 4096, os: "android-11" },
    pools: ["ml-capable"],
  });
  const r = await json("POST", "/jobs", {
    schema: 1, job_id: `smoke-fan-${run}`, workload: "benchmark", executor: "device",
    backend: "synthetic", fanout: true, targets: { pool: "ml-capable" },
  });
  const created = (r.body?.fanout ?? []) as string[];
  check(
    "fanout creates children for both pool devices",
    r.status === 201 &&
      created.includes(`smoke-fan-${run}--${DEVICE}`) &&
      created.includes(`smoke-fan-${run}--${OTHER}`),
    JSON.stringify(r.body),
  );

  // OTHER may only claim its own pinned child, never the first device's.
  const claimed = await json("GET", `/devices/${OTHER}/next-job`);
  check(
    "fanout child is pinned to its device",
    claimed.status === 200 && claimed.body?.targets?.device_id === OTHER,
    JSON.stringify(claimed.body),
  );
  await json("POST", "/results", {
    schema: 1, kind: "result", job_id: claimed.body.job_id, device_id: OTHER, iter: 0, final: true, ok: true,
  });
  // Drain DEVICE's own pinned child so later sections see an empty queue.
  const mine = await json("GET", `/devices/${DEVICE}/next-job`);
  check("first device claims its own child", mine.status === 200 && mine.body?.job_id === `smoke-fan-${run}--${DEVICE}`);
  await json("POST", "/results", {
    schema: 1, kind: "result", job_id: mine.body.job_id, device_id: DEVICE, iter: 0, final: true, ok: true,
  });
}

// 13. exclusive locks: a host lock starves the device agent until released
{
  const LOCK_JOB = `smoke-lock-${run}`;
  const grant = await json("POST", "/locks/acquire", { job_id: LOCK_JOB, device_ids: [DEVICE] });
  check("host acquires device lock", grant.status === 200 && grant.body?.granted?.includes(DEVICE));
  const contested = await json("POST", "/locks/acquire", { job_id: "someone-else", device_ids: [DEVICE] });
  check("second job is denied the lock", contested.body?.denied?.includes(DEVICE), JSON.stringify(contested.body));

  await json("POST", "/jobs", {
    schema: 1, job_id: `${LOCK_JOB}-starved`, workload: "benchmark", executor: "device",
    backend: "synthetic", targets: { device_id: DEVICE },
  });
  const denied = await json("GET", `/devices/${DEVICE}/next-job`);
  check("locked device is not handed work", denied.status === 204, `status=${denied.status}`);

  await json("POST", "/locks/release", { job_id: LOCK_JOB });
  const after = await json("GET", `/devices/${DEVICE}/next-job`);
  check("released device claims work again", after.status === 200 && after.body?.job_id === `${LOCK_JOB}-starved`);
  await json("POST", "/results", {
    schema: 1, kind: "result", job_id: `${LOCK_JOB}-starved`, device_id: DEVICE, iter: 0, final: true, ok: true,
  });
}

// 14. scheduler: an every-minute schedule fires on tick, once per minute
{
  const SCHED = `smoke-sched-${run}`;
  const bad = await json("POST", "/schedules", { id: SCHED, cron: "not a cron", template: {} });
  check("invalid cron rejected", bad.status === 400);
  const r = await json("POST", "/schedules", {
    id: SCHED, cron: "* * * * *", enabled: true,
    // Pinned to a device that never exists so the fired job stays queued and
    // later sections' claim order is undisturbed.
    template: { schema: 1, workload: "benchmark", executor: "device", backend: "synthetic",
                targets: { device_id: "smoke-nonexistent-device" } },
  });
  check("schedule created", r.status === 201, JSON.stringify(r.body));
  const tick = await json("POST", "/schedules/tick");
  const fired = (tick.body?.fired ?? []) as string[];
  check("tick fires the schedule", fired.some((j) => j.startsWith(SCHED)), JSON.stringify(tick.body));
  const tick2 = await json("POST", "/schedules/tick");
  check(
    "same minute does not double-fire",
    !((tick2.body?.fired ?? []) as string[]).some((j) => j.startsWith(SCHED)),
    JSON.stringify(tick2.body),
  );
  const off = await json("PATCH", `/schedules/${SCHED}`, { enabled: false });
  check("schedule disables", off.status === 200 && off.body?.enabled === false);
}

// 15. CI statuses are recorded but never posted while the integration is off
{
  const CI_JOB = `smoke-ci-${run}`;
  await json("POST", "/jobs", {
    schema: 1, job_id: CI_JOB, workload: "benchmark", executor: "device",
    backend: "synthetic", targets: { device_id: DEVICE },
    report_to: { github_status: "addisdev/example@deadbeef" },
  });
  const claimed = await json("GET", `/devices/${DEVICE}/next-job`);
  check("ci job claimed", claimed.status === 200 && claimed.body?.job_id === CI_JOB);
  await json("POST", "/results", {
    schema: 1, kind: "result", job_id: CI_JOB, device_id: DEVICE, iter: 0, final: true, ok: false,
  });
  const reports = await json("GET", "/status-reports");
  const row = ((reports.body ?? []) as { job_id: string; state: string; posted: number; detail: string }[])
    .find((r) => r.job_id === CI_JOB);
  check("status recorded as failure", row?.state === "failure", JSON.stringify(row));
  check("status NOT posted (CI off)", row?.posted === 0 && (row?.detail ?? "").includes("dry run"), JSON.stringify(row));
}

// 16. pipeline event rails: publish/poll with a cursor
{
  const TOPIC = `smoke-topic-${run}`;
  const e1 = await json("POST", `/events/${TOPIC}`, { prompt: "first" });
  const e2 = await json("POST", `/events/${TOPIC}`, { prompt: "second" });
  check("events publish", e1.status === 201 && e2.status === 201 && e2.body.id > e1.body.id);
  const p1 = await json("GET", `/events/${TOPIC}/poll?after=0`);
  check("poll returns first event", p1.status === 200 && p1.body?.payload?.prompt === "first");
  const p2 = await json("GET", `/events/${TOPIC}/poll?after=${p1.body.id}`);
  check("cursor advances to second event", p2.status === 200 && p2.body?.payload?.prompt === "second");
}

// 17. targets.match: descriptor expressions gate claims and fan-out
{
  const BIG = `smoke-big-${run}`, SMALL = `smoke-small-${run}`;
  await json("POST", "/devices/register", { device_id: BIG, descriptor: { model: "Big", ram_mb: 8000, os: "android-14" }, pools: [MATCH_POOL] });
  await json("POST", "/devices/register", { device_id: SMALL, descriptor: { model: "Small", ram_mb: 2000, os: "android-11" }, pools: [MATCH_POOL] });
  const bad = await json("POST", "/jobs", { schema: 1, job_id: `smoke-match-bad-${run}`, workload: "benchmark", executor: "device", targets: { match: "ram_mb >>> 4" } });
  check("invalid match expression rejected", bad.status === 400, JSON.stringify(bad.body));
  const fan = await json("POST", "/jobs", {
    schema: 1, job_id: `smoke-match-${run}`, workload: "benchmark", executor: "device", backend: "synthetic",
    fanout: true, targets: { pool: MATCH_POOL, match: "ram_mb >= 4000 && os ~ 'android'" },
  });
  const kids = (fan.body?.fanout ?? []) as string[];
  check("fanout honors match (only the big device)", kids.length === 1 && kids[0].endsWith(BIG), JSON.stringify(fan.body));
  await json("POST", "/jobs", {
    schema: 1, job_id: `smoke-match-claim-${run}`, workload: "benchmark", executor: "device", backend: "synthetic",
    targets: { pool: MATCH_POOL, match: "ram_mb < 3000" },
  });
  const bigClaim = await json("GET", `/devices/${BIG}/next-job`);
  check("big device claims only its fanout child, not the <3000 job", bigClaim.status === 200 && bigClaim.body?.job_id === kids[0], JSON.stringify(bigClaim.body));
  await json("POST", "/results", { schema: 1, kind: "result", job_id: kids[0], device_id: BIG, iter: 0, final: true, ok: true });
  const bigAgain = await json("GET", `/devices/${BIG}/next-job`);
  check("match excludes big device from the <3000 job", bigAgain.status === 204, `status=${bigAgain.status}`);
  const smallClaim = await json("GET", `/devices/${SMALL}/next-job`);
  check("small device claims the <3000 job", smallClaim.status === 200 && smallClaim.body?.job_id === `smoke-match-claim-${run}`, JSON.stringify(smallClaim.body));
  await json("POST", "/results", { schema: 1, kind: "result", job_id: `smoke-match-claim-${run}`, device_id: SMALL, iter: 0, final: true, ok: true });
}

// --- dashboard API (plan D0) ---

// 18. the read API answers for every screen, with UTC-marked timestamps
{
  const health = await json("GET", "/api/health");
  check("api health ok", health.status === 200 && health.body?.ok === true, JSON.stringify(health.body));
  check("api health carries an instance id", typeof health.body?.instance === "string");

  const ov = await json("GET", "/api/overview?fresh=1");
  const o = ov.body;
  check("overview returns", ov.status === 200, JSON.stringify(ov).slice(0, 200));
  check("overview counts the smoke devices", (o?.devices?.total ?? 0) >= 2, JSON.stringify(o?.devices));
  check("overview counts closed jobs", (o?.queue?.done_24h ?? 0) >= 1, JSON.stringify(o?.queue));
  check("overview lists the failed lease job", (o?.recent_failures ?? []).some((f: any) => f.job_id === LEASE_JOB));
  check("overview surfaces schedules", typeof o?.schedules?.total === "number", JSON.stringify(o?.schedules));
  // SQLite stores "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker; every
  // timestamp leaving the API must be unambiguous or the browser shifts it.
  check("overview timestamps are UTC-marked", /Z$/.test(o?.generated_at ?? ""), o?.generated_at);

  const devices = await json("GET", "/api/devices");
  const dev = (devices.body?.devices ?? []).find((d: any) => d.device_id === DEVICE);
  check("device list includes the smoke device", !!dev, JSON.stringify(devices.body?.devices?.length));
  check("device carries derived status", ["online", "stale", "offline"].includes(dev?.status), dev?.status);
  check("device carries parsed descriptor + pools", dev?.descriptor?.model === "Pixel 4a" && dev?.pools?.includes("ml-capable"));
  check("device beacon is flattened", dev?.beacon?.thermal === "fair" || dev?.beacon?.thermal === "nominal", JSON.stringify(dev?.beacon));
  check("device list exposes the pool facet", (devices.body?.pools ?? []).includes("android-ui"));
  check("device timestamps are UTC-marked", /Z$/.test(dev?.last_seen ?? ""), dev?.last_seen);

  const detail = await json("GET", `/api/devices/${DEVICE}`);
  check("device detail returns", detail.status === 200 && detail.body?.device_id === DEVICE);
  check("device detail lists its jobs", (detail.body?.jobs ?? []).some((j: any) => j.job_id === BENCH_JOB));
  check("device detail lists its benchmarks", (detail.body?.benchmarks ?? []).length >= 1);
  check("unknown device 404s", (await json("GET", "/api/devices/no-such-device")).status === 404);

  const beacons = await json("GET", `/api/devices/${DEVICE}/beacons?hours=24`);
  check("beacon history returns samples", (beacons.body?.samples ?? []).length >= 1, JSON.stringify(beacons.body?.count));
  check("beacon samples are chronological", (() => {
    const ts = (beacons.body?.samples ?? []).map((s: any) => s.ts);
    return ts.every((t: string, i: number) => i === 0 || t >= ts[i - 1]);
  })());

  const jobs = await json("GET", "/api/jobs?per_page=200");
  check("job list returns", jobs.status === 200 && Array.isArray(jobs.body?.jobs));
  check("job list paginates", typeof jobs.body?.total === "number" && jobs.body?.page === 1);
  check("job list reports status facets", typeof jobs.body?.status_counts?.done === "number", JSON.stringify(jobs.body?.status_counts));
  check("job list reports workload + pool facets for the filter UI",
    (jobs.body?.workloads ?? []).includes("ui-test") && (jobs.body?.pools ?? []).includes("android-ui"),
    JSON.stringify({ workloads: jobs.body?.workloads, pools: jobs.body?.pools }));
  const byPool = await json("GET", "/api/jobs?pool=android-ui");
  check("job filter narrows by pool", (byPool.body?.jobs ?? []).length > 0 && (byPool.body?.jobs ?? []).every((j: any) => j.pool === "android-ui"));
  const byDevice = await json("GET", `/api/jobs?device=${DEVICE}`);
  check("job filter narrows by device", (byDevice.body?.jobs ?? []).some((j: any) => j.job_id === BENCH_JOB));
  const filtered = await json("GET", "/api/jobs?status=failed");
  check(
    "job filter narrows to failed",
    (filtered.body?.jobs ?? []).length > 0 && (filtered.body?.jobs ?? []).every((j: any) => j.status === "failed"),
    JSON.stringify((filtered.body?.jobs ?? []).map((j: any) => j.status)),
  );
  const byWorkload = await json("GET", "/api/jobs?workload=ui-test");
  check("job filter narrows by workload", (byWorkload.body?.jobs ?? []).every((j: any) => j.workload === "ui-test"));
  const searched = await json("GET", `/api/jobs?q=${encodeURIComponent(BENCH_JOB)}`);
  check("job search finds by id", (searched.body?.jobs ?? []).some((j: any) => j.job_id === BENCH_JOB));

  const jobDetail = await json("GET", `/api/jobs/${BENCH_JOB}`);
  check("job detail returns the spec", jobDetail.body?.spec?.model?.name === "smoke-model", JSON.stringify(jobDetail.body?.spec));
  check("job detail includes result rows", (jobDetail.body?.results ?? []).length >= 3, String((jobDetail.body?.results ?? []).length));
  check("job detail resolves input artifacts", (jobDetail.body?.artifacts ?? []).some((a: any) => a.role === "input" && a.in_store));
  check("job detail derives a timeline", (jobDetail.body?.derived_timeline ?? []).length >= 2);
  check("unknown job 404s", (await json("GET", "/api/jobs/no-such-job")).status === 404);

  // Fan-out children must resolve to their parent even though the parent id
  // itself contains no separator ambiguity by luck alone.
  const child = await json("GET", `/api/jobs/smoke-fan-${run}--${DEVICE}`);
  check("fanout child names its parent", child.body?.parent === `smoke-fan-${run}`, JSON.stringify(child.body?.parent));

  const results = await json("GET", `/api/results?job=${BENCH_JOB}`);
  check("results endpoint filters by job", (results.body?.results ?? []).every((r: any) => r.job_id === BENCH_JOB));
  const bench = await json("GET", "/api/results/bench");
  const configs = (bench.body?.configs ?? []) as any[];
  check("bench view groups by configuration", configs.length > 0, JSON.stringify(configs.map((c: any) => c.config)));
  // Find the configuration this run's real benchmark landed in — other smoke
  // sections close benchmark jobs with no metrics at all, and those are
  // legitimately their own (empty) configurations.
  const entry = configs
    .flatMap((c: any) => (c.devices ?? []).map((d: any) => ({ config: c.config, ...d })))
    .find((d: any) => d.latest?.job_id === BENCH_JOB);
  check("bench view includes the smoke benchmark", !!entry, JSON.stringify(configs.map((c: any) => c.config)));
  check("bench config names model, quant and backend", /smoke-model Q4_K_M · llama\.cpp/.test(entry?.config ?? ""), entry?.config);
  check("bench view keeps prefill and decode separate", entry?.latest?.decode_tok_s != null && entry?.latest?.prefill_tok_s != null, JSON.stringify(entry?.latest));
  check("bench view labels the memory method", entry?.latest?.mem_method === "pss", JSON.stringify(entry?.latest));
  // The host executor posts a ui-test verdict the way it actually does: the
  // per-device row carries the test outcome and is NOT final, and a separate
  // host:<name> row is final and carries no test data. Filtering the matrix on
  // `final` therefore selected exactly the rows with nothing in them, and every
  // real executor-driven run was invisible.
  const EXEC_UI = `smoke-exec-ui-${run}`;
  await json("POST", "/jobs", {
    schema: 1, job_id: EXEC_UI, workload: "ui-test", executor: "host",
    app: { name: "fleet-runner", build: "exec-shape" },
    suite: { kind: "maestro", flows: "fleetrunner/smoke.yaml" },
    targets: { pool: `smoke-unclaimable-${run}` },
  });
  await json("POST", "/results", {
    schema: 1, kind: "result", job_id: EXEC_UI, device_id: DEVICE, iter: 0,
    ok: true, test: { passed: 3, failed: 0, artifacts: [] },
  });
  await json("POST", "/results", {
    schema: 1, kind: "result", job_id: EXEC_UI, device_id: "host:smoke-exec", iter: 0, final: true, ok: true,
  });

  const ui = await json("GET", "/api/results/ui");
  const execRun = (ui.body?.runs ?? []).find((r: any) => r.job_id === EXEC_UI && r.device_id === DEVICE);
  check("a non-final per-device verdict still reaches the ui view", !!execRun && execRun.passed === 3, JSON.stringify(execRun));
  check("the executor's own host: summary is not treated as a device", !(ui.body?.devices ?? []).includes("host:smoke-exec"), JSON.stringify(ui.body?.devices));
  check("that run appears in the build x device matrix", (ui.body?.matrix ?? []).some((m: any) => m.build.includes("exec-shape") && m.cells.some((c: any) => c.device === DEVICE && c.latest)), "executor-shaped run missing from the matrix");
  check("ui results carry the verdict", (ui.body?.runs ?? []).some((r: any) => r.job_id === UI_JOB && r.ok === false && r.failed === 1));

  const sys = await json("GET", "/api/system");
  check("system reports db counts", (sys.body?.db?.counts?.jobs ?? 0) > 0, JSON.stringify(sys.body?.db?.counts));
  check("system reports artifact usage", (sys.body?.artifacts?.files ?? 0) >= 1);
  check("system reports CI as unarmed", sys.body?.ci?.armed === false, JSON.stringify(sys.body?.ci));

  const scheds = await json("GET", "/api/schedules");
  const sched = (scheds.body?.schedules ?? []).find((s: any) => s.id === `smoke-sched-${run}`);
  check("schedule view computes the next run", !!sched && typeof sched.next_run === "string", JSON.stringify(sched));
  check("disabled schedule is not reported missed", sched?.missed === false, JSON.stringify(sched));

  const arts = await json("GET", "/api/artifacts");
  check("artifact list reports on-disk state", (arts.body?.artifacts ?? []).some((a: any) => a.on_disk === true));
  check("artifact list counts references", (arts.body?.artifacts ?? []).some((a: any) => a.references > 0), JSON.stringify(arts.body?.artifacts?.[0]));

  const topics = await json("GET", "/api/events");
  check("event topics are listed", (topics.body?.topics ?? []).some((t: any) => t.topic === `smoke-topic-${run}`));
  const tail = await json("GET", `/api/events/smoke-topic-${run}?limit=5`);
  check("event tail returns payloads", (tail.body?.events ?? []).some((e: any) => e.payload?.prompt === "second"));

  const locks = await json("GET", "/api/locks");
  check("locks endpoint answers", locks.status === 200 && Array.isArray(locks.body?.locks));

  const notFound = await json("GET", "/api/nope");
  check("unknown api path returns JSON, not HTML", notFound.status === 404 && typeof notFound.body?.error === "string", JSON.stringify(notFound));
}

// 19. the live stream pushes fleet changes as they happen
{
  const SSE_JOB = `smoke-sse-${run}`;
  const ac = new AbortController();
  const res = await fetch(`${BASE}/api/stream`, { headers: { accept: "text/event-stream" }, signal: ac.signal });
  check("stream connects as text/event-stream", res.status === 200 && (res.headers.get("content-type") ?? "").includes("text/event-stream"), String(res.status));

  const seen: string[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const pump = (async () => {
    // Give up rather than hang the suite if nothing ever arrives.
    const deadline = Date.now() + 8000;
    let buffer = "";
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      seen.push(buffer);
      if (buffer.includes("hello") && buffer.includes(SSE_JOB)) break;
    }
    return buffer;
  })();

  await sleep(300);
  // A job enqueued now must show up on the already-open stream.
  await json("POST", "/jobs", {
    schema: 1, job_id: SSE_JOB, workload: "benchmark", executor: "device",
    backend: "synthetic", targets: { pool: `smoke-unclaimable-${run}` },
  });

  const buffer = await pump;
  ac.abort();
  check("stream sends the hello handshake", /event: hello/.test(buffer), buffer.slice(0, 120));
  check("stream pushes a job event", /event: job/.test(buffer) && buffer.includes(SSE_JOB), buffer.slice(-200));
}

// 20. the SPA is served at /dash without shadowing the API or escaping dist
{
  const dash = await fetch(`${BASE}/dash`);
  const html = await dash.text();
  check("/dash serves html", dash.status === 200 && (dash.headers.get("content-type") ?? "").includes("text/html"));
  // Either the built shell or the build-me placeholder — both are valid states
  // for a checkout, and both must be HTML rather than a 404.
  check("/dash is the SPA shell or its placeholder", /id="app"/.test(html) || /Dashboard not built/.test(html), html.slice(0, 120));

  // Unknown client-side routes fall through to the shell, not to a 404.
  const deep = await fetch(`${BASE}/dash/jobs/${BENCH_JOB}`);
  check("client routes fall through to the shell", deep.status === 200 && (deep.headers.get("content-type") ?? "").includes("text/html"));

  // Traversal must not escape the dist directory.
  for (const attack of ["../package.json", "..%2Fpackage.json", "../../../../etc/passwd"]) {
    const res = await fetch(`${BASE}/dash/${attack}`);
    const body = await res.text();
    check(
      `traversal blocked: ${attack}`,
      !body.includes("fleet-collector") || /id="app"|Dashboard not built/.test(body),
      body.slice(0, 80),
    );
  }
}

// --- dashboard mutations (plan D2) ---

// 21. cancel: a queued job stops, and a claimed one tells its runner to stop
{
  const CANCEL_Q = `smoke-cancel-q-${run}`;
  await json("POST", "/jobs", {
    schema: 1, job_id: CANCEL_Q, workload: "benchmark", executor: "device",
    backend: "synthetic", targets: { pool: `smoke-unclaimable-${run}` },
  });
  const c1 = await json("POST", `/api/jobs/${CANCEL_Q}/cancel`, { reason: "smoke" });
  check("queued job cancels", c1.status === 200 && c1.body?.was === "queued", JSON.stringify(c1.body));
  const after = await json("GET", `/api/jobs/${CANCEL_Q}`);
  check("cancelled is its own status, not failed", after.body?.status === "cancelled", after.body?.status);
  check("cancellation records the reason", after.body?.last_error === "smoke", after.body?.last_error);
  const again = await json("POST", `/api/jobs/${CANCEL_Q}/cancel`);
  check("cancelling a closed job is refused", again.status === 409, JSON.stringify(again.body));

  // Cancelled jobs must not count as failures: alerts and the overview's
  // failed-24h tile are built on that distinction.
  const failedList = await json("GET", "/api/jobs?status=failed&per_page=200");
  check("cancelled job is absent from the failed list", !(failedList.body?.jobs ?? []).some((j: any) => j.job_id === CANCEL_Q));
  const cancelledList = await json("GET", "/api/jobs?status=cancelled");
  check("cancelled is filterable", (cancelledList.body?.jobs ?? []).some((j: any) => j.job_id === CANCEL_Q));

  // A claimed job: the runner finds out through the beacon it already sends.
  const CANCEL_C = `smoke-cancel-c-${run}`;
  await json("POST", "/jobs", {
    schema: 1, job_id: CANCEL_C, workload: "benchmark", executor: "device",
    backend: "synthetic", targets: { device_id: DEVICE },
  });
  const claim = await json("GET", `/devices/${DEVICE}/next-job`);
  check("cancel test job is claimed", claim.body?.job_id === CANCEL_C, JSON.stringify(claim.body));
  const live = await json("POST", "/results", {
    schema: 1, kind: "beacon", device_id: DEVICE, job_id: CANCEL_C,
    beacon: { battery_pct: 80, charging: true, thermal: "nominal" },
  });
  check("beacon renews before cancellation", live.body?.lease_renewed === true);

  const c2 = await json("POST", `/api/jobs/${CANCEL_C}/cancel`);
  check("claimed job cancels", c2.status === 200 && c2.body?.was === "claimed", JSON.stringify(c2.body));
  const dead = await json("POST", "/results", {
    schema: 1, kind: "beacon", device_id: DEVICE, job_id: CANCEL_C,
    beacon: { battery_pct: 80, charging: true, thermal: "nominal" },
  });
  check("cancelled job stops renewing the runner's lease", dead.body?.lease_renewed === false, JSON.stringify(dead.body));
  check("cancelling released the device lock", (c2.body?.locks_released ?? 0) >= 1, JSON.stringify(c2.body));
  // The sweep must leave it alone: a cancelled job is closed, not lapsed.
  const swept = await json("POST", "/jobs/sweep");
  check("sweep does not requeue a cancelled job", !((swept.body?.requeued ?? []) as string[]).includes(CANCEL_C));
}

// 22. retry clones the spec under a fresh id, leaving the original on the record
{
  const r1 = await json("POST", `/api/jobs/${UI_JOB}/retry`, {});
  check("retry enqueues a new job", r1.status === 201 && r1.body?.job_id === `${UI_JOB}-r2`, JSON.stringify(r1.body));
  const clone = await json("GET", `/api/jobs/${UI_JOB}-r2`);
  check("retry carries the original spec", clone.body?.spec?.suite?.kind === "maestro", JSON.stringify(clone.body?.spec));
  check("retry starts fresh", clone.body?.status === "queued" && clone.body?.attempts === 0);
  const original = await json("GET", `/api/jobs/${UI_JOB}`);
  check("original job is untouched by the retry", original.body?.status === "failed");
  const r2 = await json("POST", `/api/jobs/${UI_JOB}-r2/retry`, {});
  check("a second retry does not collide", r2.status === 201 && r2.body?.job_id === `${UI_JOB}-r3`, JSON.stringify(r2.body));
  await json("POST", `/api/jobs/${UI_JOB}-r2/cancel`);
  await json("POST", `/api/jobs/${UI_JOB}-r3/cancel`);
}

// 23. priority reorders the queue without falsifying created_at
{
  const LOW = `smoke-prio-low-${run}`, HIGH = `smoke-prio-high-${run}`;
  const POOL = `smoke-prio-pool-${run}`;
  const PRIO_DEV = `smoke-prio-dev-${run}`;
  await json("POST", "/devices/register", { device_id: PRIO_DEV, descriptor: { model: "Prio" }, pools: [POOL] });
  // LOW is enqueued first, so age alone would hand it out first.
  await json("POST", "/jobs", { schema: 1, job_id: LOW, workload: "benchmark", executor: "device", backend: "synthetic", targets: { pool: POOL } });
  await json("POST", "/jobs", { schema: 1, job_id: HIGH, workload: "benchmark", executor: "device", backend: "synthetic", targets: { pool: POOL } });
  const bump = await json("PATCH", `/api/jobs/${HIGH}`, { priority: 5 });
  check("priority updates", bump.status === 200 && bump.body?.priority === 5, JSON.stringify(bump.body));

  const first = await json("GET", `/devices/${PRIO_DEV}/next-job`);
  check("higher priority is claimed first despite being newer", first.body?.job_id === HIGH, JSON.stringify(first.body?.job_id));
  await json("POST", "/results", { schema: 1, kind: "result", job_id: HIGH, device_id: PRIO_DEV, iter: 0, final: true, ok: true });
  const second = await json("GET", `/devices/${PRIO_DEV}/next-job`);
  check("the older low-priority job follows", second.body?.job_id === LOW);
  await json("POST", "/results", { schema: 1, kind: "result", job_id: LOW, device_id: PRIO_DEV, iter: 0, final: true, ok: true });
}

// 24. target preview agrees with what fan-out actually does
{
  const pv = await json("POST", "/api/jobs/preview-targets", { targets: { pool: MATCH_POOL, match: "ram_mb >= 4000" } });
  check("preview counts matching devices", (pv.body?.count ?? 0) >= 1, JSON.stringify(pv.body));
  check("preview names them", (pv.body?.devices ?? []).every((d: any) => typeof d.device_id === "string"));
  const bad = await json("POST", "/api/jobs/preview-targets", { targets: { match: "ram_mb >>> 4" } });
  check("preview rejects an invalid match expression", bad.status === 400, JSON.stringify(bad.body));

  // The preview's promise has to hold: fan out with the same targets and
  // compare the child count.
  const FAN = `smoke-preview-fan-${run}`;
  const fan = await json("POST", "/api/jobs", {
    schema: 1, job_id: FAN, workload: "benchmark", executor: "device", backend: "synthetic",
    fanout: true, targets: { pool: MATCH_POOL, match: "ram_mb >= 4000" },
  });
  check(
    "fan-out enqueues exactly what the preview promised",
    (fan.body?.fanout ?? []).length === pv.body?.count,
    `preview=${pv.body?.count} fanout=${(fan.body?.fanout ?? []).length}`,
  );
  for (const child of (fan.body?.fanout ?? []) as string[]) {
    const c = await json("GET", `/api/jobs/${child}`);
    check(`fan-out child records its parent (${child.slice(-12)})`, c.body?.parent === FAN, JSON.stringify(c.body?.parent));
    await json("POST", `/api/jobs/${child}/cancel`);
  }
}

// 25. device edits: an override the runner cannot clobber
{
  const EDIT_POOL = `smoke-override-${run}`;
  const patch = await json("PATCH", `/api/devices/${DEVICE}`, {
    name: "shelf top left", notes: "USB hub port 3", pools: [EDIT_POOL],
  });
  check("device edit accepted", patch.status === 200, JSON.stringify(patch.body));
  const dev = await json("GET", `/api/devices/${DEVICE}`);
  check("name and notes persist", dev.body?.name === "shelf top left" && dev.body?.notes === "USB hub port 3");
  check("effective pools use the override", JSON.stringify(dev.body?.pools) === JSON.stringify([EDIT_POOL]), JSON.stringify(dev.body?.pools));
  check("the runner's own pools remain visible", (dev.body?.pools_reported ?? []).includes("ml-capable"), JSON.stringify(dev.body?.pools_reported));

  // The whole point of a separate column: re-registration must not erase it.
  await json("POST", "/devices/register", {
    device_id: DEVICE,
    descriptor: { model: "Pixel 4a", soc: "SD730G", ram_mb: 5793, os: "android-13" },
    pools: ["ml-capable", "android-ui"],
  });
  const after = await json("GET", `/api/devices/${DEVICE}`);
  check("re-registration does not clobber the override", JSON.stringify(after.body?.pools) === JSON.stringify([EDIT_POOL]), JSON.stringify(after.body?.pools));
  check("re-registration does not clobber the name", after.body?.name === "shelf top left");

  // And the queue must honour the override, not the reported pools.
  const OVERRIDE_JOB = `smoke-override-job-${run}`;
  await json("POST", "/jobs", {
    schema: 1, job_id: OVERRIDE_JOB, workload: "benchmark", executor: "device",
    backend: "synthetic", targets: { pool: EDIT_POOL },
  });
  const claimed = await json("GET", `/devices/${DEVICE}/next-job`);
  check("the queue claims through the overridden pool", claimed.body?.job_id === OVERRIDE_JOB, JSON.stringify(claimed.body?.job_id));
  await json("POST", "/results", { schema: 1, kind: "result", job_id: OVERRIDE_JOB, device_id: DEVICE, iter: 0, final: true, ok: true });

  const cleared = await json("PATCH", `/api/devices/${DEVICE}`, { pools: null });
  check("clearing the override restores the reported pools", cleared.status === 200);
  const restored = await json("GET", `/api/devices/${DEVICE}`);
  check("effective pools fall back to the runner's", (restored.body?.pools ?? []).includes("ml-capable"), JSON.stringify(restored.body?.pools));
}

// 26. templates round-trip through the composer's store
{
  const TPL = `smoke-tpl-${run}`;
  const bad = await json("POST", "/api/templates", { id: TPL, spec: { schema: 1, job_id: "nope", workload: "benchmark" } });
  check("template with a job_id is rejected", bad.status === 400, JSON.stringify(bad.body));
  const ok = await json("POST", "/api/templates", {
    id: TPL, name: "smoke template",
    spec: { schema: 1, workload: "benchmark", executor: "device", backend: "synthetic" },
  });
  check("template saved", ok.status === 201, JSON.stringify(ok.body));
  const list = await json("GET", "/api/templates");
  check("template listed with its spec parsed", (list.body?.templates ?? []).some((t: any) => t.id === TPL && t.spec?.backend === "synthetic"));
  check("template delete works", (await json("DELETE", `/api/templates/${TPL}`)).status === 200);
  check("deleting a missing template 404s", (await json("DELETE", `/api/templates/${TPL}`)).status === 404);
}

// 27. forgetting a device keeps its measurements
{
  const GONE = `smoke-gone-${run}`;
  await json("POST", "/devices/register", { device_id: GONE, descriptor: { model: "Gone" }, pools: [] });
  await json("POST", "/results", { schema: 1, kind: "beacon", device_id: GONE, beacon: { battery_pct: 50, charging: false, thermal: "nominal" } });
  // A host-executor job is claimed by the executor, not the device, so only the
  // lock reveals that this device is mid-test. Deleting it anyway would drop
  // the lock and let the device's own agent start work on top of a running
  // UI test.
  await json("POST", "/locks/acquire", { job_id: `smoke-holding-${run}`, device_ids: [GONE] });
  const busy = await json("DELETE", `/api/devices/${GONE}`);
  check("forgetting a host-locked device is refused", busy.status === 409, JSON.stringify(busy.body));
  check("still locked after the refusal", (await json("GET", "/api/locks")).body?.locks?.some((l: any) => l.device_id === GONE));
  await json("POST", "/locks/release", { job_id: `smoke-holding-${run}` });

  const del = await json("DELETE", `/api/devices/${GONE}`);
  check("device forgotten once the lock is gone", del.status === 200, JSON.stringify(del.body));
  check("forgetting an unknown device 404s", (await json("DELETE", `/api/devices/${GONE}`)).status === 404);
  const beacons = await json("GET", `/api/devices/${GONE}/beacons`);
  check("beacon history survives the device row", (beacons.body?.samples ?? []).length >= 1, JSON.stringify(beacons.body?.count));
}

// 28. a device with no battery telemetry is not a low battery
{
  // Asserted by name, not by arithmetic on a global count. Only devices that
  // are still 'online' are counted, so any earlier run's device crossing the
  // staleness threshold mid-measurement would move a total this test never
  // touched — which is exactly the flake an absolute or delta check produced.
  const lowBattery = async () =>
    ((await json("GET", "/api/overview?fresh=1")).body?.devices?.low_battery_devices ?? []) as string[];

  // iOS simulators report -1 for battery: "no battery telemetry", not "1%".
  const SIM = `smoke-sim-${run}`;
  await json("POST", "/devices/register", { device_id: SIM, descriptor: { model: "iPhone 16 Simulator", os: "ios-18.4" }, pools: [] });
  await json("POST", "/results", {
    schema: 1, kind: "beacon", device_id: SIM,
    beacon: { battery_pct: -1, charging: false, thermal: "nominal" },
  });
  // A genuinely flat device, so the check distinguishes "-1 is ignored" from
  // "the list is simply empty".
  const FLAT = `smoke-flat-${run}`;
  await json("POST", "/devices/register", { device_id: FLAT, descriptor: { model: "Flat" }, pools: [] });
  await json("POST", "/results", {
    schema: 1, kind: "beacon", device_id: FLAT,
    beacon: { battery_pct: 7, charging: false, thermal: "nominal" },
  });

  const low = await lowBattery();
  check("a -1 battery is not counted as low", !low.includes(SIM), JSON.stringify(low));
  check("a real flat battery is counted as low", low.includes(FLAT), JSON.stringify(low));
}

// 29b. results views (plan D3)
{
  const drain = await json("GET", "/api/results/drain");
  check("drain view answers", drain.status === 200 && Array.isArray(drain.body?.runs));

  // A drain run reporting the named field must be read straight, and one using
  // the old decode_tok_s slot must still be read — but flagged, because a
  // battery figure stored under a name meaning tokens/second is not a thing to
  // present as a measurement.
  const NAMED = `smoke-drain-named-${run}`, LEGACY = `smoke-drain-legacy-${run}`;
  for (const [id, metrics] of [
    [NAMED, { battery_start_pct: 90, battery_end_pct: 60, drain_pct_per_h: 15 }],
    [LEGACY, { battery_start_pct: 90, battery_end_pct: 60, decode_tok_s: 15 }],
  ] as const) {
    await json("POST", "/jobs", {
      schema: 1, job_id: id, workload: "drain", executor: "host",
      params: { app_id: "com.taylab.fleetrunner" }, targets: { pool: `smoke-unclaimable-${run}` },
    });
    await json("POST", "/results", { schema: 1, kind: "result", job_id: id, device_id: DEVICE, iter: 0, ok: true, metrics });
  }
  const drain2 = await json("GET", "/api/results/drain");
  const named = (drain2.body?.runs ?? []).find((r: any) => r.job_id === NAMED)?.devices?.[0];
  const legacy = (drain2.body?.runs ?? []).find((r: any) => r.job_id === LEGACY)?.devices?.[0];
  check("drain reads the named field straight", named?.pct_per_h === 15 && named?.pct_per_h_inferred === false, JSON.stringify(named));
  check("drain still reads a legacy row, but flags it", legacy?.pct_per_h === 15 && legacy?.pct_per_h_inferred === true, JSON.stringify(legacy));
  for (const id of [NAMED, LEGACY]) await json("POST", `/api/jobs/${id}/cancel`, {});
  const soak = await json("GET", "/api/results/soak");
  check("soak view answers", soak.status === 200 && Array.isArray(soak.body?.runs));
  const vision = await json("GET", "/api/results/vision");
  check("vision view answers", vision.status === 200 && Array.isArray(vision.body?.runs));
  const ui = await json("GET", "/api/results/ui");
  check("ui view builds a build x device matrix", Array.isArray(ui.body?.matrix) && Array.isArray(ui.body?.devices), JSON.stringify(ui.body?.devices));
  // The executor's own `host:<name>` summary row is not a device and must not
  // become a column in the matrix.
  check("ui matrix excludes the host executor row", !(ui.body?.devices ?? []).some((d: string) => d.startsWith("host:")), JSON.stringify(ui.body?.devices));

  // A device named by the fleet's own simulator convention must be flagged, or
  // it lands in a hardware comparison.
  const SIMDEV = `iphone-sim-${run}`;
  await json("POST", "/devices/register", { device_id: SIMDEV, descriptor: { model: "arm64", os: "ios-18.4" }, pools: [] });
  const devs = await json("GET", "/api/devices");
  const simRow = (devs.body?.devices ?? []).find((d: any) => d.device_id === SIMDEV);
  check("a -sim- device id is detected as a simulator", simRow?.simulator === true, JSON.stringify(simRow?.simulator));
  const realRow = (devs.body?.devices ?? []).find((d: any) => d.device_id === DEVICE);
  check("a real device is not mistaken for a simulator", realRow?.simulator === false, JSON.stringify(realRow?.simulator));
}

// 30. operations (plan D4): schedules, artifacts GC, retention, executors
{
  const SCHED2 = `smoke-ops-sched-${run}`;
  const up = await json("POST", "/api/schedules", {
    id: SCHED2, cron: "0 3 * * *", enabled: false,
    template: { schema: 1, workload: "benchmark", executor: "device", backend: "synthetic",
                targets: { device_id: `smoke-nobody-${run}` } },
  });
  check("schedule upserts through the guarded route", up.status === 201, JSON.stringify(up.body));
  const on = await json("PATCH", `/api/schedules/${SCHED2}`, { enabled: true });
  check("schedule enables through the guarded route", on.status === 200 && on.body?.enabled === true);

  // Run-now must not consume the cron dedup key, or the schedule would skip
  // its next real firing.
  const fired = await json("POST", `/api/schedules/${SCHED2}/run`, {});
  check("run-now enqueues immediately", fired.status === 201 && String(fired.body?.job_id ?? "").includes("-manual-"), JSON.stringify(fired.body));
  const after = await json("GET", "/api/schedules");
  const row = (after.body?.schedules ?? []).find((s: any) => s.id === SCHED2);
  check("run-now leaves the cron dedup key untouched", row?.last_run === null, JSON.stringify(row?.last_run));
  await json("POST", `/api/jobs/${fired.body?.job_id}/cancel`, {});
  check("schedule deletes", (await json("DELETE", `/api/schedules/${SCHED2}`)).status === 200);

  // GC must never offer an artifact a job still points at.
  const gc = await json("GET", "/api/artifacts/gc-candidates?days=0");
  const shas = (gc.body?.candidates ?? []).map((c: any) => c.sha256);
  const bench = await json("GET", `/api/jobs/${BENCH_JOB}`);
  const modelSha = bench.body?.spec?.model?.sha256;
  check("gc lists candidates", gc.status === 200 && typeof gc.body?.count === "number", JSON.stringify(gc.body?.count));
  check("gc never offers a referenced artifact", !shas.includes(modelSha), `${modelSha} was offered for deletion`);
  const refusal = await json("DELETE", `/api/artifacts/${modelSha}`);
  check("deleting a referenced artifact is refused", refusal.status === 409, JSON.stringify(refusal.body));

  // Retention defaults to a dry run: the count comes before the deletion.
  const dry = await json("POST", "/api/system/retention", { beacon_days: 3650, event_days: 3650 });
  check("retention dry-runs by default", dry.body?.dry_run === true && typeof dry.body?.would_delete?.beacons === "number", JSON.stringify(dry.body));
  const bad = await json("POST", "/api/system/retention", { beacon_days: 0 });
  check("retention rejects a zero-day window", bad.status === 400, JSON.stringify(bad.body));

  const sweep = await json("POST", "/api/system/sweep", {});
  check("sweep runs through the guarded route", sweep.status === 200 && Array.isArray(sweep.body?.requeued));

  // The executor registers itself simply by polling, so this needs no new
  // endpoint on the executor side.
  await json("GET", `/executor/next-job?name=smoke-exec-${run}`);
  const execs = await json("GET", "/api/executors");
  const mine = (execs.body?.executors ?? []).find((e: any) => e.name === `smoke-exec-${run}`);
  check("a polling executor is recorded", !!mine, JSON.stringify((execs.body?.executors ?? []).map((e: any) => e.name)));
  check("a just-polled executor reads as polling", mine?.status === "polling", JSON.stringify(mine));
}

// 31. alerts (plan D5): fire, dedup, acknowledge, snooze, resolve
{
  const BATT = `smoke-alert-batt-${run}`;
  await json("POST", "/devices/register", { device_id: BATT, descriptor: { model: "AlertTest" }, pools: [] });
  await json("POST", "/results", {
    schema: 1, kind: "beacon", device_id: BATT,
    beacon: { battery_pct: 6, charging: false, thermal: "nominal" },
  });

  const tick1 = await json("POST", "/api/alerts/tick", {});
  check("alert tick runs", tick1.status === 200, JSON.stringify(tick1.body));
  const list1 = await json("GET", "/api/alerts");
  const batt = (list1.body?.alerts ?? []).find((a: any) => a.rule === "low-battery" && a.subject === BATT);
  check("a flat device raises a low-battery alert", !!batt, JSON.stringify((list1.body?.alerts ?? []).map((a: any) => a.rule)));
  check("the failed lease job raises a job-failed alert", (list1.body?.alerts ?? []).some((a: any) => a.rule === "job-failed" && a.subject === LEASE_JOB));
  check("alerts report whether a webhook exists", typeof list1.body?.webhook === "boolean");
  // The Schedules page and the alert rule must call the same schedule late at
  // the same moment, or the banner stays silent while another screen says
  // something is wrong.
  const sysThresh = (await json("GET", "/api/alerts")).body?.thresholds?.scheduleLateS;
  check("the missed-schedule threshold is shared, not duplicated", sysThresh === 300, JSON.stringify(sysThresh));

  // A condition that stays true is one alert, not one per tick — the whole
  // point of storing alerts as state.
  await json("POST", "/api/alerts/tick", {});
  const list2 = await json("GET", "/api/alerts");
  const same = (list2.body?.alerts ?? []).filter((a: any) => a.rule === "low-battery" && a.subject === BATT);
  check("a persisting condition does not duplicate", same.length === 1, `${same.length} rows`);
  check("but it does count the sightings", (same[0]?.seen_count ?? 0) >= 2, JSON.stringify(same[0]?.seen_count));

  const acked = await json("POST", `/api/alerts/${batt.id}/ack`, {});
  check("alert acknowledges", acked.status === 200 && acked.body?.state === "acked", JSON.stringify(acked.body));
  const list3 = await json("GET", "/api/alerts");
  const stillThere = (list3.body?.alerts ?? []).find((a: any) => a.id === batt.id);
  check("an acknowledged alert stays listed", stillThere?.state === "acked", JSON.stringify(stillThere?.state));

  const jobAlert = (list3.body?.alerts ?? []).find((a: any) => a.rule === "job-failed");
  const snoozed = await json("POST", `/api/alerts/${jobAlert.id}/snooze`, { minutes: 30 });
  check("alert snoozes", snoozed.status === 200 && snoozed.body?.state === "snoozed", JSON.stringify(snoozed.body));
  check("snooze rejects a zero window", (await json("POST", `/api/alerts/${jobAlert.id}/snooze`, { minutes: 0 })).status === 400);

  // The condition clearing is the only thing that resolves an alert.
  await json("POST", "/results", {
    schema: 1, kind: "beacon", device_id: BATT,
    beacon: { battery_pct: 90, charging: true, thermal: "nominal" },
  });
  await json("POST", "/api/alerts/tick", {});
  const list4 = await json("GET", "/api/alerts?state=open,acked,snoozed,resolved");
  const resolved = (list4.body?.alerts ?? []).find((a: any) => a.id === batt.id);
  check("charging the device resolves its alert", resolved?.state === "resolved", JSON.stringify(resolved?.state));
  check("the resolved alert keeps its history", !!resolved?.first_seen && !!resolved?.resolved_at, JSON.stringify(resolved));
  const openOnly = await json("GET", "/api/alerts?state=open");
  check("resolved alerts drop out of the open list", !(openOnly.body?.alerts ?? []).some((a: any) => a.id === batt.id));
  check("acking an unknown alert 404s", (await json("POST", "/api/alerts/999999/ack", {})).status === 404);
}

// 32. enrolment (adding a device to the fleet)
{
  const enroll = await json("GET", "/api/enroll");
  check("enroll endpoint answers", enroll.status === 200, JSON.stringify(enroll.body).slice(0, 120));
  // The QR has to encode an address a phone can reach. Loopback is a perfectly
  // good URL for the operator and a useless one for a device, so the endpoint
  // reports the host's own non-loopback interfaces rather than echoing back
  // whatever the browser happened to connect on.
  const bases = (enroll.body?.bases ?? []) as { url: string; kind: string }[];
  check("enrol advertises at least one reachable address", bases.length >= 1, JSON.stringify(bases));
  check("no loopback address is ever advertised", !bases.some((b) => /127\.|localhost|::1/.test(b.url)), JSON.stringify(bases));
  check("addresses are classified lan or tailnet", bases.every((b) => b.kind === "lan" || b.kind === "tailnet"), JSON.stringify(bases));
  check("enrol lists already-known devices", Array.isArray(enroll.body?.known_device_ids) && enroll.body.known_device_ids.includes(DEVICE));

  // A phone downloading the runner must get a file Android will offer to
  // install, not a 64-character hash with no extension.
  const apkSha = createHash("sha256").update(`fake-apk-${run}`).digest("hex");
  await fetch(`${BASE}/artifacts`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-artifact-name": `fleet-runner-${run}.apk` },
    body: Buffer.from(`fake-apk-${run}`),
  });
  const enroll2 = await json("GET", "/api/enroll");
  check("enrol offers the newest runner APK", (enroll2.body?.runner_apk?.name ?? "").endsWith(".apk"), JSON.stringify(enroll2.body?.runner_apk));
  check("the APK link carries a filename", String(enroll2.body?.runner_apk?.download ?? "").includes("filename="));

  const named = await fetch(`${BASE}/artifacts/${apkSha}?filename=fleet-runner.apk`);
  check("filename becomes a content-disposition", (named.headers.get("content-disposition") ?? "").includes('filename="fleet-runner.apk"'), named.headers.get("content-disposition") ?? "none");
  const bare = await fetch(`${BASE}/artifacts/${apkSha}`);
  check("no filename means no content-disposition", !bare.headers.get("content-disposition"));

  // The name goes straight into a response header, so it is stripped rather
  // than trusted: a CRLF would let a caller invent headers of their own.
  const evil = await fetch(`${BASE}/artifacts/${apkSha}?filename=${encodeURIComponent('a"\r\nX-Evil: yes')}`);
  check("header injection through the filename is stripped", !evil.headers.get("x-evil"), "an injected header survived");
  check("quotes and CRLF do not reach the header", (evil.headers.get("content-disposition") ?? "").includes('filename="aX-Evilyes"'), evil.headers.get("content-disposition") ?? "none");
  const traversal = await fetch(`${BASE}/artifacts/${apkSha}?filename=${encodeURIComponent("../../etc/passwd")}`);
  check("path separators are stripped from the filename", !(traversal.headers.get("content-disposition") ?? "").includes("/"), traversal.headers.get("content-disposition") ?? "none");
}

// 33. targets.executor routes host jobs to a named executor (plan U0)
{
  const PINNED = `smoke-exec-pinned-${run}`, ANY = `smoke-exec-any-${run}`;
  await json("POST", "/jobs", {
    schema: 1, job_id: PINNED, workload: "install", executor: "host",
    app: { name: "x", build: "1", sha256: "0".repeat(64) },
    targets: { executor: "mac-xcode" }, lease: { ttl_s: 60, max_attempts: 1 },
  });
  await json("POST", "/jobs", {
    schema: 1, job_id: ANY, workload: "install", executor: "host",
    app: { name: "x", build: "1", sha256: "0".repeat(64) },
    lease: { ttl_s: 60, max_attempts: 1 },
  });

  // An executor by another name must not take the pinned job -- it should skip
  // past it and claim the unpinned one instead.
  const other = await json("GET", `/executor/next-job?name=shelf-${run}`);
  check("an unnamed executor skips a job pinned to another", other.body?.job_id === ANY, JSON.stringify(other.body?.job_id));

  const right = await json("GET", `/executor/next-job?name=mac-xcode`);
  check("the named executor claims its pinned job", right.body?.job_id === PINNED, JSON.stringify(right.body?.job_id));
  check("the spec still carries the routing", right.body?.targets?.executor === "mac-xcode");

  const shown = await json("GET", `/api/jobs/${PINNED}`);
  check("the api reports which executor a job wants", shown.body?.wants_executor === "mac-xcode", JSON.stringify(shown.body?.wants_executor));
  for (const j of [PINNED, ANY]) await json("POST", `/api/jobs/${j}/cancel`, {});
}

// 29. the legacy dashboard's own links still resolve to legacy pages
{
  const html = await (await fetch(`${BASE}/dash/legacy`)).text();
  // The whole point of legacy is that it works when the SPA is not built, so a
  // link from it into the SPA shell would strand the operator.
  check("legacy links to the legacy bench page", html.includes('href="/dash/legacy/bench"'), "legacy dash links off to a removed route");
  const bench = await (await fetch(`${BASE}/dash/legacy/bench`)).text();
  check("legacy bench links back to the legacy dash", bench.includes('href="/dash/legacy"'));
}

// 30. the web-test workload: a URL target, no device
{
  const WEB = `smoke-web-${run}`;
  const made = await json("POST", "/jobs", {
    schema: 1, job_id: WEB, workload: "web-test", executor: "host",
    app: { name: "aliquant-web", build: "smoke" },
    suite: { kind: "playwright", flows: "aliquant" },
    params: { browser: "chromium" },
    // No `targets.match`: a browser is not a device, so there is nothing to
    // match against. The URL is the target.
    targets: { executor: `web-${run}`, url: "http://127.0.0.1:4173" },
    lease: { ttl_s: 900, max_attempts: 1 },
  });
  check("a web-test job is accepted", made.status === 201, `status ${made.status} ${JSON.stringify(made.body)}`);

  const claimed = await json("GET", `/executor/next-job?name=web-${run}`);
  check("a host executor claims the web-test job", claimed.body?.job_id === WEB, JSON.stringify(claimed.body?.job_id));
  check("the URL reaches the executor", claimed.body?.targets?.url === "http://127.0.0.1:4173", JSON.stringify(claimed.body?.targets));

  // The two-row shape the dashboard matrix reads: a per-browser verdict that
  // carries the test outcome, and a `final` host summary that closes the job.
  await json("POST", "/results", {
    schema: 1, kind: "result", job_id: WEB, device_id: "web:chromium", ok: true,
    test: { passed: 1, failed: 0 },
  });
  await json("POST", "/results", {
    schema: 1, kind: "result", job_id: WEB, device_id: `host:web-${run}`, ok: true, final: true,
  });

  const done = await json("GET", `/api/jobs/${WEB}`);
  check("a web-test job completes", done.body?.status === "done", JSON.stringify(done.body?.status));
  const browser = (done.body?.results ?? []).find((r: any) => r.device_id === "web:chromium");
  check("the browser verdict is stored under a web: device id", !!browser, "no web:chromium row");
  check("the browser verdict carries the counts", browser?.payload?.test?.passed === 1 && browser?.payload?.test?.failed === 0, JSON.stringify(browser?.payload?.test));

  // A browser is not a device and must never be enrolled as one — otherwise
  // every nightly would add a permanently-offline "device" to the fleet.
  const devs = await json("GET", "/api/devices?limit=500");
  const ghost = (devs.body?.devices ?? []).some((d: any) => String(d.device_id).startsWith("web:"));
  check("a browser is not enrolled as a device", !ghost, "a web: pseudo-device leaked into the device list");
}

// 30b. the web-shots workload: the capture half of the visual-regression matrix
{
  const SHOTS = `smoke-shots-${run}`;
  const made = await json("POST", "/jobs", {
    schema: 1, job_id: SHOTS, workload: "web-shots", executor: "host",
    suite: { kind: "playwright", flows: "aliquant" },
    targets: { executor: `web-${run}`, url: "http://127.0.0.1:4173" },
    lease: { ttl_s: 600, max_attempts: 1 },
  });
  check("a web-shots job is accepted", made.status === 201, `status ${made.status} ${JSON.stringify(made.body)}`);

  const claimed = await json("GET", `/executor/next-job?name=web-${run}`);
  check("a host executor claims the web-shots job", claimed.body?.job_id === SHOTS, JSON.stringify(claimed.body?.job_id));

  // The row shape the executor posts, following drain: per-page rows at
  // iter 1..N, a per-profile summary at iter 0, and the host row closing it.
  await json("POST", "/results", {
    schema: 1, kind: "result", job_id: SHOTS, device_id: "web:chromium", iter: 1, ok: true,
    test: { passed: 1, failed: 0 },
  });
  await json("POST", "/results", {
    schema: 1, kind: "result", job_id: SHOTS, device_id: "web:chromium", iter: 0, ok: true,
    test: { passed: 1, failed: 0 },
  });
  await json("POST", "/results", {
    schema: 1, kind: "result", job_id: SHOTS, device_id: `host:web-${run}`, ok: true, final: true,
  });
  const done = await json("GET", `/api/jobs/${SHOTS}`);
  check("a web-shots job completes", done.body?.status === "done", JSON.stringify(done.body?.status));
  const rows = (done.body?.results ?? []).filter((r: any) => r.device_id === "web:chromium");
  check("per-page and per-profile rows coexist", rows.length === 2, `${rows.length} web:chromium rows`);
}

// 30c. visual baselines: the mutable pointer into the immutable artifact store
{
  const bytes = `baseline-shot-${run}`;
  const up = (await (await fetch(`${BASE}/artifacts`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-artifact-name": "home.png" },
    body: bytes,
  })).json()) as { sha256: string };

  // A baseline may only point at bytes the store actually holds — a pointer
  // into nothing would fail every diff forever while looking like truth.
  const bogus = await json("POST", "/api/visual/baselines/accept", {
    suite: `smoke-suite-${run}`, page: "home", profile: "chromium",
    sha256: "0".repeat(64),
  });
  check("a baseline for a missing artifact is refused", bogus.status === 404, `status ${bogus.status}`);

  const accepted = await json("POST", "/api/visual/baselines/accept", {
    suite: `smoke-suite-${run}`, page: "home", profile: "chromium",
    sha256: up.sha256, job_id: `smoke-shots-${run}`,
  });
  check("a baseline is accepted", accepted.status === 201, `status ${accepted.status} ${JSON.stringify(accepted.body)}`);

  const listed = await json("GET", `/api/visual/baselines?suite=smoke-suite-${run}`);
  const row = (listed.body?.baselines ?? [])[0];
  check("the baseline lists for its suite", row?.sha256 === up.sha256 && row?.page === "home", JSON.stringify(row));
  check("accepted_at is unambiguous UTC", /Z$/.test(row?.accepted_at ?? ""), JSON.stringify(row?.accepted_at));

  // Accepting again replaces the pointer — the store is immutable, the
  // pointer is not, and (suite, page, profile) must never grow duplicates.
  const up2 = (await (await fetch(`${BASE}/artifacts`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-artifact-name": "home2.png" },
    body: `${bytes}-v2`,
  })).json()) as { sha256: string };
  await json("POST", "/api/visual/baselines/accept", {
    suite: `smoke-suite-${run}`, page: "home", profile: "chromium", sha256: up2.sha256,
  });
  const relisted = await json("GET", `/api/visual/baselines?suite=smoke-suite-${run}`);
  check("re-accepting replaces, not duplicates",
    relisted.body?.baselines?.length === 1 && relisted.body.baselines[0].sha256 === up2.sha256,
    JSON.stringify(relisted.body?.baselines));

  // 30d. the review matrix, assembled from the rows' shot blocks
  const SUITE = `smoke-suite-${run}`;
  const MJOB = `smoke-matrix-${run}`;
  await json("POST", "/jobs", {
    schema: 1, job_id: MJOB, workload: "web-shots", executor: "host",
    suite: { kind: "playwright", flows: SUITE },
    targets: { executor: `web-${run}`, url: "http://127.0.0.1:4173" },
    lease: { ttl_s: 600, max_attempts: 1 },
  });
  await json("GET", `/executor/next-job?name=web-${run}`);
  // One page under two profiles: chromium diverged from the up2 baseline,
  // webkit captured with no baseline at all.
  await json("POST", "/results", {
    schema: 1, kind: "result", job_id: MJOB, device_id: "web:chromium", iter: 1, ok: false,
    metrics: { diff_pct: 4.2 }, test: { passed: 0, failed: 1 },
    shot: { suite: SUITE, page: "home", profile: "chromium", sha256: up.sha256, diff_sha256: up2.sha256 },
    error: "4.20% of pixels differ (threshold 0.1%)",
  });
  await json("POST", "/results", {
    schema: 1, kind: "result", job_id: MJOB, device_id: "web:webkit", iter: 1, ok: true,
    test: { passed: 1, failed: 0 },
    shot: { suite: SUITE, page: "home", profile: "webkit", sha256: up.sha256 },
    error: "new: no baseline — accept this shot to start diffing",
  });
  await json("POST", "/results", {
    schema: 1, kind: "result", job_id: MJOB, device_id: `host:web-${run}`, ok: false, final: true,
  });

  const suites = await json("GET", "/api/visual/suites");
  check("the suite appears in the picker", (suites.body?.suites ?? []).includes(SUITE), JSON.stringify(suites.body?.suites));

  const matrix = await json("GET", `/api/visual/matrix?suite=${SUITE}`);
  const cells = matrix.body?.cells ?? [];
  const chromium = cells.find((c: any) => c.profile === "chromium");
  const webkit = cells.find((c: any) => c.profile === "webkit");
  check("the matrix reads the latest run", matrix.body?.latest?.job_id === MJOB, JSON.stringify(matrix.body?.latest));
  check("a cell over threshold with a baseline is diverged",
    chromium?.status === "diverged" && chromium?.diff_pct === 4.2 && chromium?.baseline_sha256 === up2.sha256,
    JSON.stringify(chromium));
  check("a captured cell with no baseline is new, not failed",
    webkit?.status === "new" && webkit?.baseline_sha256 === null,
    JSON.stringify(webkit));
}

// 30e. the site-health and review workloads are accepted and carry named metrics
for (const [workload, device] of [["web-audit", "web:audit"], ["web-unfurl", "web:unfurl"], ["archive", "web:gsc"], ["digest", "web:digest"]] as const) {
  const JOB = `smoke-${workload}-${run}`;
  const made = await json("POST", "/jobs", {
    schema: 1, job_id: JOB, workload, executor: "host",
    ...(workload === "archive"
      ? { params: { source: "gsc", property: "sc-domain:example.com" }, targets: { executor: `web-${run}` } }
      : workload === "digest"
        ? { params: { days: 7 }, targets: { executor: `web-${run}` } }
        : { suite: { kind: "playwright", flows: "aliquant" }, targets: { executor: `web-${run}`, url: "http://127.0.0.1:4173" } }),
    lease: { ttl_s: 600, max_attempts: 1 },
  });
  check(`a ${workload} job is accepted`, made.status === 201, `status ${made.status} ${JSON.stringify(made.body)}`);
  await json("GET", `/executor/next-job?name=web-${run}`);
  await json("POST", "/results", {
    schema: 1, kind: "result", job_id: JOB, device_id: device, iter: 0, ok: true,
    metrics: workload === "archive"
      ? { clicks: 5, impressions: 100, ctr_pct: 5 }
      : workload === "digest"
        ? { reviews_count: 18, clusters: 3, avg_rating: 3.4 }
        : { issues_error: 0, issues_warn: 2 },
  });
  await json("POST", "/results", {
    schema: 1, kind: "result", job_id: JOB, device_id: `host:web-${run}`, ok: true, final: true,
  });
  const done = await json("GET", `/api/jobs/${JOB}`);
  check(`a ${workload} job completes with its metrics stored`,
    done.body?.status === "done" && !!(done.body?.results ?? []).find((r: any) => r.device_id === device)?.payload?.metrics,
    JSON.stringify(done.body?.status));
}

// 31. build channels: a nightly asks for the latest build, not a pinned hash
{
  const APP = `smoke-app-${run}`;
  const put = async (bytes: string, build: string) =>
    (await (await fetch(`${BASE}/artifacts`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-artifact-name": `${build}.apk`,
        "x-artifact-app": APP,
        "x-artifact-build": build,
        "x-artifact-platform": "android",
      },
      body: bytes,
    })).json()) as { sha256: string };

  const older = await put(`older-${run}`, "1.0.0");
  const newer = await put(`newer-${run}`, "1.1.0");
  check("an artifact can declare which app it is", !!older.sha256 && !!newer.sha256);

  // A schedule that fires with sha256: "latest" must resolve to the newest
  // build for that app -- the whole point is that nobody edits a hash.
  const SCHED = `smoke-latest-${run}`;
  await json("POST", "/schedules", {
    id: SCHED,
    // Every minute, so the tick below always considers it due.
    cron: "* * * * *",
    enabled: true,
    template: {
      schema: 1, workload: "install", executor: "host",
      app: { name: APP, build: "latest", sha256: "latest" },
      targets: { executor: `never-${run}` },
      lease: { ttl_s: 600, max_attempts: 1 },
    },
  });
  const tick = await json("POST", "/schedules/tick", {});
  const jobId = (tick.body?.fired ?? []).find((j: string) => j.startsWith(SCHED));
  check("a schedule with a latest build fires", !!jobId, JSON.stringify(tick.body?.fired));

  const fired = await json("GET", `/api/jobs/${jobId}`);
  const spec = fired.body?.spec ?? {};
  check("latest resolves to the newest build", spec.app?.sha256 === newer.sha256,
    `${spec.app?.sha256} (newer=${newer.sha256} older=${older.sha256})`);
  check("the resolved build string is recorded, not the word 'latest'", spec.app?.build === "1.1.0",
    JSON.stringify(spec.app?.build));

  // A nightly for an app nobody has built yet must be SKIPPED, not failed: a
  // job pinned to a build that does not exist would fail in a way that looks
  // exactly like the app being broken.
  const EMPTY = `smoke-nobuild-${run}`;
  await json("POST", "/schedules", {
    id: EMPTY, cron: "* * * * *", enabled: true,
    template: {
      schema: 1, workload: "install", executor: "host",
      app: { name: `never-built-${run}`, build: "latest", sha256: "latest" },
      targets: { executor: `never-${run}` }, lease: { ttl_s: 600, max_attempts: 1 },
    },
  });
  const tick2 = await json("POST", "/schedules/tick", {});
  const firedEmpty = (tick2.body?.fired ?? []).some((j: string) => j.startsWith(EMPTY));
  check("a nightly with no build is skipped, not failed", !firedEmpty, JSON.stringify(tick2.body?.fired));

  // A revert republishes bytes that already exist, so the insert is ignored and
  // the row keeps its ORIGINAL created_at -- which made `latest` resolve to the
  // build the revert replaced. published_at is what makes this come out right.
  await put(`older-${run}`, "1.2-revert");
  const REVERT = `smoke-revert-${run}`;
  await json("POST", "/jobs", {
    schema: 1, job_id: REVERT, workload: "install", executor: "host",
    app: { name: APP, build: "latest", sha256: "latest" },
    targets: { executor: `never-${run}` }, lease: { ttl_s: 600, max_attempts: 1 },
  });
  const reverted = await json("GET", `/api/jobs/${REVERT}`);
  check("a revert republishing older bytes becomes the latest build",
    reverted.body?.spec?.app?.build === "1.2-revert", JSON.stringify(reverted.body?.spec?.app?.build));

  // `latest` is the documented contract for hand-written and CI jobs too, not
  // a scheduler-only convenience.
  check("POST /jobs resolves latest, never storing the literal string",
    reverted.body?.spec?.app?.sha256 === older.sha256, JSON.stringify(reverted.body?.spec?.app?.sha256));

  const GHOST = `smoke-ghost-${run}`;
  const ghost = await json("POST", "/jobs", {
    schema: 1, job_id: GHOST, workload: "install", executor: "host",
    app: { name: `never-built-${run}`, build: "latest", sha256: "latest" },
    targets: { executor: `never-${run}` }, lease: { ttl_s: 600, max_attempts: 1 },
  });
  check("a job asking for a build nobody has published is rejected", ghost.status === 400,
    `status ${ghost.status}`);

  for (const id of [SCHED, EMPTY]) await json("DELETE", `/schedules/${id}`, undefined);
  for (const j of [jobId, REVERT]) if (j) await json("POST", `/api/jobs/${j}/cancel`, {});
}

// 32. xcodebuild test counts: what ran, not what the exit code implied
{
  const log = [
    "Test Suite 'GreeneryUITests' started at 2026-08-19 21:00:00.000",
    "Test Case '-[GreeneryUITests.BloomsUITests testBloomAppears]' passed (1.2 seconds).",
    "Test Case '-[GreeneryUITests.BloomsUITests testBloomDismisses]' failed (0.9 seconds).",
    // An entirely ordinary test name that contains the word "failed". A naive
    // substring count reads this as a failure; it passed.
    "Test Case '-[GreeneryUITests.EULAGateUITests testFailedAcceptShowsBanner]' passed (0.4 seconds).",
    "    XCTAssertTrue failed - the banner never appeared",
    "** TEST FAILED **",
  ].join("\n");
  const c = countXcodebuildTests(log);
  check("xcodebuild passes are counted", c.passed === 2, JSON.stringify(c));
  check("xcodebuild failures are counted", c.failed === 1, JSON.stringify(c));
  check("a test NAMED failed is not counted as a failure", c.passed === 2 && c.failed === 1, JSON.stringify(c));

  // A build failure produces no Test Case lines at all. Reporting 0/0 there
  // would render as a green run that tested nothing.
  const none = countXcodebuildTests("error: no such module 'Supabase'\n** BUILD FAILED **");
  check("a build failure yields no test counts", none.passed === 0 && none.failed === 0, JSON.stringify(none));

  // XCTSkip is how a suite says "I could not test this". greenfolio's iOS UI
  // tests skip every case without a signed-in session, and xcodebuild still
  // exits 0 -- so a suite that tested NOTHING must never look like a pass.
  const allSkipped = [
    "Test Case '-[GreenFolioUITests.BloomsUITests testBloomsRowAppears]' started.",
    "Test Case '-[GreenFolioUITests.BloomsUITests testBloomsRowAppears]' skipped (48.2 seconds).",
    "Test Case '-[GreenFolioUITests.BloomsUITests testComposerReachesTheEditor]' skipped (41.1 seconds).",
  ].join("\n");
  const sk = countXcodebuildTests(allSkipped);
  check("skipped tests are counted separately", sk.skipped === 2 && sk.passed === 0 && sk.failed === 0,
    JSON.stringify(sk));
  check("a started line is not counted as a result", sk.skipped + sk.passed + sk.failed === 2,
    JSON.stringify(sk));

  // The verdict rule the executor applies to those counts, asserted here
  // because it is the part that decides whether a nightly is read or ignored.
  const majoritySkipped = (c: { passed: number; failed: number; skipped: number }) =>
    c.skipped > 0 && c.skipped >= c.passed + c.failed;
  // greenfolio-ios today: 7 pass, 9 skip for want of a signed-in session. More
  // of the suite did not run than did, so this is not a green nightly.
  check("a majority-skipped suite is not a pass", majoritySkipped({ passed: 7, failed: 0, skipped: 9 }));
  // The gradual case the all-or-nothing check missed: fixtures rot, one test
  // survives, and the run would otherwise stay green on that survivor.
  check("one survivor among skips is not a pass", majoritySkipped({ passed: 1, failed: 0, skipped: 15 }));
  // A healthy suite with a couple of legitimately-skipped cases still passes.
  check("a few skips in a healthy suite still pass", !majoritySkipped({ passed: 14, failed: 0, skipped: 2 }));

  // What the failure artifact leads with. Both of these were real defects.
  {
    // Real xcodebuild output echoes source, and `error:` is an ordinary Swift
    // argument label -- so a loose match reads this line as a build error.
    const echoed = "        try? outbox.markFailed(op, error: OutboxDeliveryError.undeliverablePayload,";
    const real = "error: Build input files cannot be found: LeaderboardRepository.swift";
    const d = xcodebuildDiagnostics([echoed, real, "/x/F.swift:9:1: warning: deprecated"].join("\n"));
    check("echoed source is not mistaken for a diagnostic", !d.some((l) => l.includes("markFailed")),
      JSON.stringify(d));
    check("both diagnostic shapes are captured", d.length === 2, JSON.stringify(d));

    // An Xcode build routinely emits hundreds of deprecation warnings. Taking
    // the first N in document order pushes the one error off the end.
    const noisy = [
      ...Array.from({ length: 250 }, (_, i) => `/x/F${i}.swift:1:1: warning: deprecated`),
      real,
    ].join("\n");
    const capped = xcodebuildDiagnostics(noisy);
    check("the error survives a log full of warnings", capped.some((l) => l.startsWith("error:")),
      `kept ${capped.length}, first=${capped[0]?.slice(0, 40)}`);
    check("errors come before warnings", capped[0] === real, capped[0]?.slice(0, 60));

    // A compiler diagnostic carries line:column; an XCTest FAILURE carries
    // only a line. Requiring a column dropped every test failure from the
    // artifact -- the single line most worth reading -- while faithfully
    // preserving a hundred deprecation warnings. Observed on a real device
    // run: 10 passed, 1 failed, artifact reported zero errors.
    const xctestFailure =
      "/Users/x/BloomsUITests.swift:228: error: -[Suite testBloomsRowAppears] : failed - collection did not load";
    const withFailure = xcodebuildDiagnostics([
      "/Users/x/File.swift:90:23: warning: capture of self",
      xctestFailure,
    ].join("\n"));
    check("an XCTest failure line is captured despite having no column",
      withFailure.includes(xctestFailure), JSON.stringify(withFailure));
    check("the test failure still outranks the warning", withFailure[0] === xctestFailure,
      withFailure[0]?.slice(0, 60));

    // Tolerating a missing adb must not also tolerate a BROKEN one. A
    // version-mismatched daemon exits non-zero like any other failure, and
    // swallowing it empties the whole Android shelf with nothing in the log.
    check("a missing adb is not worth reporting", !adbFailureIsWorthReporting("ENOENT"));
    check("a wedged adb is worth reporting", adbFailureIsWorthReporting(undefined));
    check("a non-zero adb exit is worth reporting", adbFailureIsWorthReporting("1"));
  }
}

// 33. shelf presence: a host-driven device exists and reads online
{
  // What the host executor now sends every 60s for each attached device. The
  // descriptor is the point: a device registered without one shows on the
  // dashboard and can never be selected by `os ~ 'android'`, so it would sit
  // there looking healthy and never be given work.
  const SHELF = `smoke-shelf-${run}`;
  const reg = await json("POST", "/devices/register", {
    device_id: SHELF,
    descriptor: { model: "SM-G955U1", os: "android-9", ram_mb: 3800, serial: SHELF, attached_to: `exec-${run}` },
    pools: [],
  });
  check("an executor can register an attached device", reg.status === 200 || reg.status === 201, `status ${reg.status}`);

  const listed = (await json("GET", "/api/devices?limit=500")).body?.devices
    ?.find((d: any) => d.device_id === SHELF);
  // The bug this fixes: a cabled phone read `offline` between jobs because
  // nothing refreshed it -- it has no runner app of its own to beacon.
  check("an attached device reads online", listed?.status === "online", JSON.stringify(listed?.status));

  // And it must be targetable, not merely visible.
  const JOB = `smoke-shelf-job-${run}`;
  const made = await json("POST", "/jobs", {
    schema: 1, job_id: JOB, workload: "ui-test", executor: "host",
    app: { name: "x", build: "1", sha256: "deadbeef" },
    suite: { kind: "maestro", flows: "x.yaml", app_id: "com.x" },
    targets: { match: "os ~ 'android'", executor: `exec-${run}` },
    lease: { ttl_s: 600, max_attempts: 1 },
  });
  check("a host job targeting android is accepted", made.status === 201, `status ${made.status}`);
  const claim = await json("GET", `/executor/next-job?name=exec-${run}`);
  check("an executor-registered device is targetable by match", claim.body?.job_id === JOB,
    JSON.stringify(claim.body?.job_id));
  await json("POST", `/api/jobs/${JOB}/cancel`, {});

  // Re-registering is how presence stays fresh, so it must not duplicate.
  await json("POST", "/devices/register", {
    device_id: SHELF, descriptor: { model: "SM-G955U1", os: "android-9", serial: SHELF }, pools: [],
  });
  const all = (await json("GET", "/api/devices?limit=500")).body?.devices ?? [];
  check("re-registering refreshes rather than duplicates",
    all.filter((d: any) => d.device_id === SHELF).length === 1, "duplicate device row");

  // Which attached things may join the fleet at all.
  {
    const SIMS = {
      "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [
        { udid: "AB0637DA-212F-4E29-AE5F-26EA006BC168", name: "fleet-iphone-1" },
        { udid: "A92E6FCA-7A8C-4255-ADA2-AF835850A259", name: "iPhone 16 Pro" },
      ],
    };
    check("a fleet simulator joins", fleetOwned(simulatorName("AB0637DA-212F-4E29-AE5F-26EA006BC168", SIMS)));
    // The Xcode Mac is a working machine. A simulator someone booted for five
    // minutes of debugging must not quietly start taking nightly work.
    check("a scratch simulator does not join",
      !fleetOwned(simulatorName("A92E6FCA-7A8C-4255-ADA2-AF835850A259", SIMS)));
    // Real hardware simctl has never heard of is in: somebody cabled it up.
    check("a cabled phone joins", fleetOwned(simulatorName("988a1b3541354f565a", SIMS)));
    check("a phone joins even with no simctl at all", fleetOwned(simulatorName("988a1b3541354f565a", null)));

    // The rule has to cover every kind of virtual device. Gating iOS only is
    // exactly what let an emulator named `jerv-test` into the fleet.
    check("an emulator serial is recognised as virtual", isAndroidEmulatorSerial("emulator-5554"));
    check("a phone serial is not", !isAndroidEmulatorSerial("988a1b3541354f565a"));
    check("a scratch AVD does not join", !fleetOwned("jerv-test"));

    // Membership must gate JOBS, not only presence. It gated only presence,
    // and the gap was invisible until an aliquant suite pinned to simulators
    // ran on fleet-sim-1 AND on a stray iPhone 17 somebody had booted --
    // reporting both as results. "It cannot be registered" and "it cannot be
    // given work" are different claims.
    const bootedOnTheHost = [
      { udid: "1C733669", name: "fleet-sim-1" },
      { udid: "500582F9", name: "iPhone 17" },
    ];
    const sims = { "com.apple.CoreSimulator.SimRuntime.iOS-26-5": bootedOnTheHost };
    const selectable = bootedOnTheHost.filter((d) => fleetOwned(simulatorName(d.udid, sims)));
    check("a job runs only on fleet-owned simulators", selectable.length === 1,
      JSON.stringify(selectable.map((d) => d.name)));
    check("the stray simulator is the one excluded", selectable[0]?.name === "fleet-sim-1",
      String(selectable[0]?.name));
    check("a fleet AVD joins", fleetOwned("fleet-pixel-8"));
  }

  // Telling a physical iPhone from a simulator, using devicectl's real output
  // shape. This matters because devicectl lists simulators AS devices with no
  // isSimulated flag -- the Xcode Mac reports 25 of them and one real phone.
  {
    const DEVICECTL = [
      // A booted simulator. devicectl calls it a connected iPhone 16.
      { identifier: "AB0637DA", platform: "iOS", transport: "sameMachine", tunnelState: "connected",
        pairingState: "paired", marketingName: "iPhone 16", osVersion: "27.0" },
      // Real hardware on the desk. Note tunnelState -- devicectl reports
      // `disconnected` for a cabled phone that answers instantly, because the
      // tunnel is brought up on demand. Gating on it rejected a working phone.
      { identifier: "09A99EFE", platform: "iOS", transport: "wired", tunnelState: "disconnected",
        pairingState: "paired", name: "MiPhone 12 Pro", productType: "iPhone13,3", osVersion: "18.7.8" },
      // Reached over the network and not currently on it: genuinely unreachable.
      { identifier: "OFFLINE1", platform: "iOS", transport: "localNetwork", tunnelState: "disconnected",
        pairingState: "paired", marketingName: "iPhone 16 Pro", osVersion: "26.6" },
      // On the network and answering.
      { identifier: "NETOK001", platform: "iOS", transport: "localNetwork", tunnelState: "connected",
        pairingState: "paired", marketingName: "iPad Air", osVersion: "18.4" },
      // A paired Apple Watch is not a UI-test target.
      { identifier: "WATCH001", platform: "watchOS", transport: "localNetwork", tunnelState: "connected",
        pairingState: "paired", marketingName: "Apple Watch Series 11" },
    ];
    const phys = physicalIos(DEVICECTL);
    const ids = phys.map((d) => d.identifier);
    check("a simulator reported by devicectl is not physical hardware",
      !ids.includes("AB0637DA"), JSON.stringify(ids));
    // The one that matters: this exact device, wired and answering, was
    // rejected by a tunnelState check.
    check("a wired phone is reachable even when the tunnel reads disconnected",
      ids.includes("09A99EFE"), JSON.stringify(ids));
    check("a network device that is off the network is not offered",
      !ids.includes("OFFLINE1"), "a job would fail on an unreachable device");
    check("a network device that is on the network is offered", ids.includes("NETOK001"), JSON.stringify(ids));
    check("a watch is not an iOS target", !ids.includes("WATCH001"));
        check("exactly the reachable hardware is returned", phys.length === 2, JSON.stringify(ids));

    // What the executor SAYS about a device it is ignoring. The first version
    // said "is paired but not reachable -- unlock it, trust this Mac" for
    // every case, which was actively wrong once the executor moved hosts:
    // pairing is per-Mac and does not travel with the phone, so it advised
    // unlocking an already-unlocked phone while the real fix went unmentioned.
    const unpaired = {
      identifier: "09A99EFE", platform: "iOS", transport: "wired",
      tunnelState: "disconnected", pairingState: "unpaired", name: "MiPhone 12 Pro",
    };
    const reason = iosNotReadyReason(unpaired) ?? "";
    check("an unpaired phone is told to pair, not to unlock",
      reason.includes("not paired") && reason.includes("Trust"), reason);
    check("the unpaired message does not blame the lock screen",
      !reason.toLowerCase().includes("unlock it, trust"), reason);

    // Paired but off the network is a different problem with different advice.
    const offNetwork = { ...unpaired, identifier: "OFFNET", transport: "localNetwork", pairingState: "paired" };
    const r2 = iosNotReadyReason(offNetwork) ?? "";
    check("a paired but unreachable phone is described as such",
      r2.includes("not reachable") && !r2.includes("not paired"), r2);

    // And a device that is fine gets no complaint at all -- otherwise the log
    // fills with noise about working hardware.
    // An iOS-only Mac has no Android SDK. adbDevices used to throw ENOENT
    // there, listTargets propagated it, and the presence sweep's catch
    // swallowed it -- so the host registered NOTHING, silently, including the
    // iPhone cabled to it. Every other enumerator already tolerated its
    // tooling being absent; this one did not, and it went unnoticed because
    // every host until now happened to have adb.
    //
    // Asserted at the collector: a host that can see only iOS devices must
    // still be able to register them.
    const IOSONLY = `smoke-iosonly-${run}`;
    const regd = await json("POST", "/devices/register", {
      device_id: IOSONLY,
      descriptor: { model: "iPhone 12 Pro", os: "ios-18.7.8", serial: IOSONLY, attached_to: `ios-only-${run}` },
      pools: [],
    });
    check("an iOS-only host can register its phone", regd.status === 200 || regd.status === 201,
      `status ${regd.status}`);
    const seenIt = (await json("GET", "/api/devices?limit=500")).body?.devices
      ?.find((d: any) => d.device_id === IOSONLY);
    check("that phone is online and targetable", seenIt?.status === "online", JSON.stringify(seenIt?.status));

    check("a healthy wired phone produces no message",
      iosNotReadyReason({ ...unpaired, pairingState: "paired" }) === null,
      String(iosNotReadyReason({ ...unpaired, pairingState: "paired" })));
  }
}

// 34. a job can ask for real hardware and get only real hardware
{
  // The two iOS targets the Xcode Mac actually has, described the way the
  // executor describes them.
  const SIM = { model: "fleet-iphone-1", os: "ios-27.0", soc: "simulator", kind: "simulator" };
  const PHONE = { model: "iPhone 12 Pro", os: "ios-18.7.8", soc: "iPhone13,3", kind: "device" };

  // The bug this closes: `match` gated only which EXECUTOR claimed a job. Once
  // claimed, the executor ran on every target it could see -- so a nightly
  // meant for an iOS 18 phone also ran on an iOS 27 simulator and reported
  // both. The same expression must mean the same thing in both places.
  check("a match for ios-18 selects the phone", evalMatch("os ~ 'ios-18'", PHONE));
  check("a match for ios-18 rejects the ios-27 simulator", !evalMatch("os ~ 'ios-18'", SIM));

  // device_kind is the blunt instrument for "real hardware, whatever it is",
  // which no descriptor field states honestly: `kind` describes how a device is
  // attached, not what it is.
  const pick = (kind: string, all: { kind: string }[]) => all.filter((d) => d.kind === kind);
  check("device_kind=device selects only hardware",
    pick("device", [SIM, PHONE]).length === 1 && pick("device", [SIM, PHONE])[0] === PHONE);
  check("device_kind=simulator selects only simulators",
    pick("simulator", [SIM, PHONE]).length === 1 && pick("simulator", [SIM, PHONE])[0] === SIM);

  // A malformed expression must not quietly select everything -- that would
  // turn a typo into a job that runs on the whole shelf.
  let threw = false;
  try { evalMatch("os ~~ ", PHONE); } catch { threw = true; }
  check("a malformed match expression throws rather than matching all", threw);

  // And the collector must accept the new field so a job can express it.
  const KIND = `smoke-kind-${run}`;
  const made = await json("POST", "/jobs", {
    schema: 1, job_id: KIND, workload: "ui-test", executor: "host",
    app: { name: "greenfolio-ios", build: "local" },
    suite: { kind: "xcuitest", project: "/tmp/x.xcodeproj", scheme: "X" },
    targets: { executor: `never-${run}`, device_kind: "device", match: "os ~ 'ios-18'" },
    lease: { ttl_s: 600, max_attempts: 1 },
  });
  check("a job may ask for real hardware", made.status === 201, `status ${made.status}`);
  const back = await json("GET", `/api/jobs/${KIND}`);
  check("device_kind survives the round trip", back.body?.spec?.targets?.device_kind === "device",
    JSON.stringify(back.body?.spec?.targets));
  await json("POST", `/api/jobs/${KIND}/cancel`, {});
}

// 35. UI-test sign-in: names travel, secrets do not
{
  // A job spec is stored, served by the API and rendered on the dashboard, so
  // a password in one is published to everyone on the LAN. The account is not
  // a secret and is genuinely useful to see; the password never leaves the
  // executor host's Keychain.
  const OK = `smoke-cred-${run}`;
  const good = await json("POST", "/jobs", {
    schema: 1, job_id: OK, workload: "ui-test", executor: "host",
    app: { name: "greenfolio-ios", build: "local" },
    suite: {
      kind: "xcuitest", project: "/tmp/x.xcodeproj", scheme: "X",
      credentials: {
        account: "showcase@greenfol.io",
        email_var: "GREENFOLIO_TEST_EMAIL",
        password_var: "GREENFOLIO_TEST_PASSWORD",
      },
    },
    targets: { executor: `never-${run}`, device_kind: "device" },
    lease: { ttl_s: 600, max_attempts: 1 },
  });
  check("a job may name the account it signs in as", good.status === 201, `status ${good.status}`);
  const back = await json("GET", `/api/jobs/${OK}`);
  check("the account survives the round trip",
    back.body?.spec?.suite?.credentials?.account === "showcase@greenfol.io",
    JSON.stringify(back.body?.spec?.suite?.credentials));
  await json("POST", `/api/jobs/${OK}/cancel`, {});

  // Permissions ride the same channel: declared in the spec, applied by the
  // executor (simctl privacy grant) before the tests run, so a suite like
  // jerv's never leaves a location dialog parked on a shared simulator.
  const PERM = `smoke-perm-${run}`;
  const perm = await json("POST", "/jobs", {
    schema: 1, job_id: PERM, workload: "ui-test", executor: "host",
    app: { name: "jerv-ios", build: "local" },
    suite: {
      kind: "xcuitest", project: "/tmp/x.xcodeproj", scheme: "X",
      permissions: [{ service: "location-always", bundle_id: "com.taylab.jerv" }],
    },
    targets: { executor: `never-${run}`, device_kind: "simulator" },
    lease: { ttl_s: 600, max_attempts: 1 },
  });
  check("a job may declare permissions to pre-grant", perm.status === 201, `status ${perm.status}`);
  const permBack = await json("GET", `/api/jobs/${PERM}`);
  check("the permission grant survives the round trip",
    permBack.body?.spec?.suite?.permissions?.[0]?.service === "location-always" &&
      permBack.body?.spec?.suite?.permissions?.[0]?.bundle_id === "com.taylab.jerv",
    JSON.stringify(permBack.body?.spec?.suite?.permissions));
  await json("POST", `/api/jobs/${PERM}/cancel`, {});

  // The guard that matters. Refused outright rather than trusting every future
  // caller to remember where secrets belong.
  for (const bad of [
    { suite: { kind: "xcuitest", password: "hunter2" } },
    { params: { api_key: "sk-live-xyz" } },
    { report_to: { token: "ghp_abc" } },
  ]) {
    const res = await json("POST", "/jobs", {
      schema: 1, job_id: `smoke-secret-${run}-${Math.random().toString(36).slice(2, 8)}`,
      workload: "ui-test", executor: "host",
      app: { name: "x", build: "1" }, targets: { executor: `never-${run}` }, ...bad,
    });
    check(`a spec carrying ${Object.keys(bad)[0]} secrets is refused`, res.status === 400,
      `status ${res.status} for ${JSON.stringify(bad)}`);
  }

  // And whatever the suite prints, the password must not reach the artifact
  // store -- xcodebuild echoes its environment in places, and the log is
  // downloadable from the dashboard.
  const log = "env: TEST_RUNNER_GREENFOLIO_TEST_PASSWORD=s3cr3t-value\nTest Case passed";
  const scrubbed = redact(log, ["s3cr3t-value"]);
  check("a password is scrubbed from the uploaded log", !scrubbed.includes("s3cr3t-value"), scrubbed);
  check("scrubbing leaves the rest of the log intact", scrubbed.includes("Test Case passed"));
  // A short string would match half the log; better to leave it than to redact
  // everything into uselessness.
  check("a too-short secret is not used as a scrub pattern", redact("a b c", ["b"]) === "a b c");

  // A missing item and an unreadable one need opposite remedies -- add the
  // entry, versus unlock the keychain. Telling someone to add an item that
  // already exists is the kind of advice that costs an hour.
  const absent = await keychainPassword(`nobody-${run}@example.invalid`, `fleet-absent-${run}`);
  check("a missing keychain item reports as missing",
    absent.ok === false && absent.reason === "missing", JSON.stringify(absent));
}

// --- capability routing ---

// An agent says what it can run; the queue never hands it anything else. The
// hard part is not the filter, it is that a collector upgrade must not idle a
// shelf of runners that predate the field — so "declared nothing" and "declared
// an empty list" have to mean opposite things, and both are asserted here.
{
  const CAPS_POOL = `smoke-caps-${run}`;
  const MODERN = `smoke-caps-modern-${run}`;
  const LEGACY = `smoke-caps-legacy-${run}`;

  await json("POST", "/devices/register", {
    device_id: MODERN, descriptor: { model: "Modern", ram_mb: 8000, os: "android-15" },
    pools: [CAPS_POOL], capabilities: ["benchmark", "batch:litert"],
  });
  // No capabilities key at all: the shape every runner sent before this landed.
  await json("POST", "/devices/register", {
    device_id: LEGACY, descriptor: { model: "Legacy", ram_mb: 4000, os: "android-11" },
    pools: [CAPS_POOL],
  });

  const badCaps = await json("POST", "/devices/register", {
    device_id: `${MODERN}-bad`, descriptor: {}, pools: [], capabilities: "benchmark",
  });
  check("capabilities must be an array", badCaps.status === 400, JSON.stringify(badCaps.body));

  // A workload the collector ships with, pinned to the agent that declares it.
  await json("POST", "/jobs", {
    schema: 1, job_id: `smoke-caps-bench-${run}`, workload: "benchmark", executor: "device",
    backend: "synthetic", targets: { device_id: MODERN },
  });
  const benchClaim = await json("GET", `/devices/${MODERN}/next-job`);
  check("an agent claims a workload it declares",
    benchClaim.status === 200 && benchClaim.body?.job_id === `smoke-caps-bench-${run}`,
    JSON.stringify(benchClaim.body));
  await json("POST", "/results", { schema: 1, kind: "result", job_id: `smoke-caps-bench-${run}`, device_id: MODERN, iter: 0, final: true, ok: true });

  // pipeline is a shipped workload, so it enqueues; MODERN did not declare it,
  // so MODERN is never offered it.
  await json("POST", "/jobs", {
    schema: 1, job_id: `smoke-caps-undeclared-${run}`, workload: "pipeline", executor: "device",
    targets: { device_id: MODERN },
  });
  const refused = await json("GET", `/devices/${MODERN}/next-job`);
  check("an agent is not offered a workload it did not declare", refused.status === 204, `status=${refused.status}`);

  // The same job, offered to the agent that never mentioned capabilities.
  await json("POST", "/jobs", {
    schema: 1, job_id: `smoke-caps-legacy-${run}`, workload: "pipeline", executor: "device",
    targets: { device_id: LEGACY },
  });
  const legacyClaim = await json("GET", `/devices/${LEGACY}/next-job`);
  check("an agent that declared nothing is still offered everything",
    legacyClaim.status === 200 && legacyClaim.body?.job_id === `smoke-caps-legacy-${run}`,
    JSON.stringify(legacyClaim.body));
  await json("POST", "/results", { schema: 1, kind: "result", job_id: `smoke-caps-legacy-${run}`, device_id: LEGACY, iter: 0, final: true, ok: true });

  // A backend pairing satisfies the workload; the bare workload satisfies any
  // backend. MODERN declares batch:litert but not batch.
  await json("POST", "/jobs", {
    schema: 1, job_id: `smoke-caps-litert-${run}`, workload: "batch", executor: "device",
    backend: "litert", targets: { device_id: MODERN },
  });
  const litert = await json("GET", `/devices/${MODERN}/next-job`);
  check("a workload:backend capability satisfies that backend",
    litert.status === 200 && litert.body?.job_id === `smoke-caps-litert-${run}`, JSON.stringify(litert.body));
  await json("POST", "/results", { schema: 1, kind: "result", job_id: `smoke-caps-litert-${run}`, device_id: MODERN, iter: 0, final: true, ok: true });

  await json("POST", "/jobs", {
    schema: 1, job_id: `smoke-caps-coreml-${run}`, workload: "batch", executor: "device",
    backend: "coreml", targets: { device_id: MODERN },
  });
  const coreml = await json("GET", `/devices/${MODERN}/next-job`);
  check("a workload:backend capability does not satisfy a different backend",
    coreml.status === 204, `status=${coreml.status}`);

  // Re-registering without the key keeps what was declared; sending [] clears
  // it. Without this an older build rolling back would widen itself to all.
  await json("POST", "/devices/register", {
    device_id: MODERN, descriptor: { model: "Modern", ram_mb: 8000, os: "android-15" }, pools: [CAPS_POOL],
  });
  const kept = await json("GET", "/api/devices");
  const modernRow = (kept.body?.devices ?? []).find((d: any) => d.device_id === MODERN);
  check("a re-register that omits capabilities keeps them",
    Array.isArray(modernRow?.capabilities) && modernRow.capabilities.includes("benchmark"),
    JSON.stringify(modernRow?.capabilities));
  const legacyRow = (kept.body?.devices ?? []).find((d: any) => d.device_id === LEGACY);
  check("an agent that never declared reads as null, not empty",
    legacyRow?.capabilities === null, JSON.stringify(legacyRow?.capabilities));

  // A workload the collector has never heard of. Refused while nothing can run
  // it, accepted once an agent claims it — that is the whole point of the
  // change: a new runner adds work without a collector release.
  const orphan = await json("POST", "/jobs", {
    schema: 1, job_id: `smoke-caps-orphan-${run}`, workload: "teleport", executor: "device",
  });
  check("an unknown workload no agent can run is refused at enqueue",
    orphan.status === 422, `status=${orphan.status} ${JSON.stringify(orphan.body)}`);

  const NOVEL = `smoke-caps-novel-${run}`;
  await json("POST", "/devices/register", {
    device_id: NOVEL, descriptor: { model: "Novel", ram_mb: 16000, os: "macos-15" },
    pools: [CAPS_POOL], capabilities: ["teleport"],
  });
  const accepted = await json("POST", "/jobs", {
    schema: 1, job_id: `smoke-caps-novel-${run}`, workload: "teleport", executor: "device",
    targets: { device_id: NOVEL },
  });
  check("an unknown workload an agent declares is accepted",
    accepted.status === 200 || accepted.status === 201, `status=${accepted.status} ${JSON.stringify(accepted.body)}`);
  const novelClaim = await json("GET", `/devices/${NOVEL}/next-job`);
  check("and the declaring agent claims it",
    novelClaim.status === 200 && novelClaim.body?.job_id === `smoke-caps-novel-${run}`,
    JSON.stringify(novelClaim.body));
  await json("POST", "/results", { schema: 1, kind: "result", job_id: `smoke-caps-novel-${run}`, device_id: NOVEL, iter: 0, final: true, ok: true });

  // capabilities is readable from a match expression, so a job can target the
  // toolchain an agent has rather than the hardware it runs on.
  check("match reads capabilities", evalMatch("capabilities ~ 'teleport'", { capabilities: ["teleport", "benchmark"] }));
  check("match does not invent capabilities", !evalMatch("capabilities ~ 'teleport'", { capabilities: ["benchmark"] }));

  // Fan-out and the composer's preview must agree with the claim, or the
  // preview promises devices the queue then refuses.
  const fanCaps = await json("POST", "/jobs", {
    schema: 1, job_id: `smoke-caps-fan-${run}`, workload: "pipeline", executor: "device",
    fanout: true, targets: { pool: CAPS_POOL },
  });
  const capKids = (fanCaps.body?.fanout ?? []) as string[];
  check("fanout skips agents that cannot run the workload",
    capKids.length === 1 && capKids[0].endsWith(LEGACY), JSON.stringify(fanCaps.body));
}

// --- laptop constraints ---

// require_charging and min_battery_pct are enforced by the runner against live
// state. These are enforced here, before the claim, because a laptop that is
// merely on battery or merely busy has not failed at anything — the job should
// wait rather than burn an attempt.
{
  const CONS = `smoke-cons-${run}`;
  const beacon = (extra: Record<string, unknown>) =>
    json("POST", "/results", { schema: 1, kind: "beacon", device_id: CONS, beacon: { battery_pct: 90, charging: false, thermal: "nominal", ...extra } });

  await json("POST", "/devices/register", {
    device_id: CONS, descriptor: { model: "MacBook", os: "macos-15", kind: "laptop" },
    pools: [], capabilities: ["benchmark"],
  });

  await beacon({ on_ac: false, idle_s: 0, load_1m: 8 });
  await json("POST", "/jobs", {
    schema: 1, job_id: `smoke-cons-ac-${run}`, workload: "benchmark", executor: "device", backend: "synthetic",
    targets: { device_id: CONS }, constraints: { require_ac: true },
  });
  const onBattery = await json("GET", `/devices/${CONS}/next-job`);
  check("require_ac holds the job while the machine is on battery", onBattery.status === 204, `status=${onBattery.status}`);

  await beacon({ on_ac: true, idle_s: 600, load_1m: 0.2 });
  const onMains = await json("GET", `/devices/${CONS}/next-job`);
  check("and releases it once the machine is on mains",
    onMains.status === 200 && onMains.body?.job_id === `smoke-cons-ac-${run}`, JSON.stringify(onMains.body));
  await json("POST", "/results", { schema: 1, kind: "result", job_id: `smoke-cons-ac-${run}`, device_id: CONS, iter: 0, final: true, ok: true });

  await json("POST", "/jobs", {
    schema: 1, job_id: `smoke-cons-load-${run}`, workload: "benchmark", executor: "device", backend: "synthetic",
    targets: { device_id: CONS }, constraints: { max_load: 1 },
  });
  await beacon({ on_ac: true, idle_s: 600, load_1m: 9 });
  const busy = await json("GET", `/devices/${CONS}/next-job`);
  check("max_load holds the job while the machine is busy", busy.status === 204, `status=${busy.status}`);
  await beacon({ on_ac: true, idle_s: 600, load_1m: 0.1 });
  const quiet = await json("GET", `/devices/${CONS}/next-job`);
  check("and releases it once the machine is quiet",
    quiet.status === 200 && quiet.body?.job_id === `smoke-cons-load-${run}`, JSON.stringify(quiet.body));
  await json("POST", "/results", { schema: 1, kind: "result", job_id: `smoke-cons-load-${run}`, device_id: CONS, iter: 0, final: true, ok: true });

  // A window that cannot contain now, expressed so it stays false whenever the
  // suite runs: two hours that end before the current hour begins.
  const hour = new Date().getHours();
  const from = (hour + 3) % 24;
  const to = (hour + 5) % 24;
  await json("POST", "/jobs", {
    schema: 1, job_id: `smoke-cons-window-${run}`, workload: "benchmark", executor: "device", backend: "synthetic",
    targets: { device_id: CONS }, constraints: { window: { from, to } },
  });
  const outside = await json("GET", `/devices/${CONS}/next-job`);
  check("a window that excludes now holds the job", outside.status === 204, `status=${outside.status} window=${from}-${to}`);

  // The registry knows where it registered from, which is what tells "offline"
  // apart from "on another network".
  const devs = await json("GET", "/api/devices");
  const row = (devs.body?.devices ?? []).find((d: any) => d.device_id === CONS);
  check("registration records the network it came from", typeof row?.last_net === "string", JSON.stringify(row?.last_net));
}

// --- fan-out: host jobs, and one per distinct OS ---
{
  const OSPOOL = `smoke-os-${run}`;
  const mk = (id: string, os: string) =>
    json("POST", "/devices/register", { device_id: id, descriptor: { model: "P", os, ram_mb: 4000 }, pools: [OSPOOL], capabilities: ["benchmark"] });
  await mk(`${OSPOOL}-a`, "android-13");
  await mk(`${OSPOOL}-b`, "android-13");
  await mk(`${OSPOOL}-c`, "android-15");

  const distinct = await json("POST", "/jobs", {
    schema: 1, job_id: `smoke-os-distinct-${run}`, workload: "benchmark", executor: "device", backend: "synthetic",
    fanout: { distinct: "os" }, targets: { pool: OSPOOL },
  });
  const kids = (distinct.body?.fanout ?? []) as string[];
  check("fanout distinct:os makes one child per OS, not per device",
    kids.length === 2, `${kids.length} children: ${JSON.stringify(kids)}`);

  const badDistinct = await json("POST", "/jobs", {
    schema: 1, job_id: `smoke-os-bad-${run}`, workload: "benchmark", executor: "device",
    fanout: { distinct: 7 }, targets: { pool: OSPOOL },
  });
  check("fanout.distinct must name a field", badDistinct.status === 400, `status=${badDistinct.status}`);

  // Host fan-out used to be refused outright; a host child is pinned the same
  // way a device child is and the executor already honours it.
  const hostFan = await json("POST", "/jobs", {
    schema: 1, job_id: `smoke-os-host-${run}`, workload: "install", executor: "host",
    app: { name: "x", build: "1", sha256: "a".repeat(64) },
    fanout: { distinct: "os" }, targets: { pool: OSPOOL, executor: `never-${run}` },
  });
  check("host jobs can fan out too", (hostFan.body?.fanout ?? []).length === 2, JSON.stringify(hostFan.body));
}

// --- artifact pins ---

// The reference scan reads job specs, results, schedules and templates. It
// cannot see a visual baseline, whose whole purpose is to still exist months
// later to diff against — which is precisely the artifact GC would have eaten.
{
  const body = new TextEncoder().encode(`pin-me-${run}`);
  const sha = createHash("sha256").update(body).digest("hex");
  const up = await fetch(`${BASE}/artifacts`, {
    method: "POST", headers: { "content-type": "application/octet-stream", "x-artifact-name": `pin-${run}.bin` }, body,
  });
  check("artifact uploads for the pin test", up.status === 201, `status=${up.status}`);

  const pin = await json("POST", `/api/artifacts/${sha}/pin`, { pinned: true, reason: "smoke" });
  check("an artifact can be pinned", pin.status === 200 && pin.body?.pinned === true, JSON.stringify(pin.body));

  const del = await json("DELETE", `/api/artifacts/${sha}`);
  check("a pinned artifact refuses deletion", del.status === 409, `status=${del.status} ${JSON.stringify(del.body)}`);

  const gc = await json("GET", "/api/artifacts/gc-candidates?days=0");
  const offered = ((gc.body?.candidates ?? []) as { sha256: string }[]).some((c) => c.sha256 === sha);
  check("and is never offered as a GC candidate", !offered, `${gc.body?.count} candidates`);

  await json("POST", `/api/artifacts/${sha}/pin`, { pinned: false });
  const del2 = await json("DELETE", `/api/artifacts/${sha}`);
  check("unpinning releases it", del2.status === 200, `status=${del2.status} ${JSON.stringify(del2.body)}`);
}

// --- regression alerts ---

// The sweep catches a fleet that stopped working. This catches one still
// working and quietly getting worse, which is the failure a device lab exists
// to find and the only one nothing here looked for.
{
  const REG = `smoke-reg-${run}`;
  await json("POST", "/devices/register", {
    device_id: REG, descriptor: { model: "Regressor", os: "android-14", ram_mb: 8000 },
    pools: [], capabilities: ["benchmark"],
  });

  const post = async (i: number, tokS: number) => {
    const jobId = `smoke-reg-${run}-${i}`;
    await json("POST", "/jobs", {
      schema: 1, job_id: jobId, workload: "benchmark", executor: "device", backend: "synthetic",
      model: { name: "qwen-test", format: "gguf", quant: "Q4_K_M", sha256: "b".repeat(64) },
      targets: { device_id: REG },
    });
    await json("POST", "/results", {
      schema: 1, kind: "result", job_id: jobId, device_id: REG, iter: 0, final: true, ok: true,
      metrics: { decode_tok_s: tokS },
    });
  };
  // Five steady runs, then one that is a third slower on the same device with
  // the same model and quant — the only comparison that means anything.
  for (let i = 0; i < 5; i++) await post(i, 100);
  const before = await json("POST", "/api/alerts/tick");
  const quiet = ((before.body?.opened ?? []) as unknown[]).length;
  await post(5, 66);
  const after = await json("POST", "/api/alerts/tick");

  const alerts = await json("GET", "/api/alerts");
  const list = (alerts.body?.alerts ?? alerts.body ?? []) as { rule?: string; subject?: string }[];
  const found = Array.isArray(list) && list.some((a) => a.rule === "benchmark-regressed" && String(a.subject).startsWith(REG));
  check("a benchmark that falls against its own median raises an alert", found,
    `opened_before=${quiet} opened_after=${JSON.stringify(after.body?.opened)} alerts=${JSON.stringify(list).slice(0, 300)}`);
}

// --- cold-start: parsing what the device actually said ---

// This parser decides what number gets stored, so it is the piece that has to
// be checkable without plugging in a phone. Every sample below is a shape a
// real device emits; the one that matters most is the launch that did not
// happen, because a parser returning 0 there reports an instant launch.
{
  const crlf = (s: string) => s.replace(/\n/g, "\r\n");

  const cold = parseAmStart(crlf(
    "Starting: Intent { act=android.intent.action.MAIN cmp=com.x/.MainActivity }\n" +
    "Status: ok\nLaunchState: COLD\nActivity: com.x/.MainActivity\nTotalTime: 1043\nWaitTime: 1067\nComplete\n",
  ));
  check("am start: a cold launch parses through CRLF", cold.totalMs === 1043 && cold.launchState === "cold", JSON.stringify(cold));
  check("am start: a cold launch is reportable", amStartProblem(cold) === null, String(amStartProblem(cold)));

  const hot = parseAmStart(crlf("Status: ok\nLaunchState: HOT\nTotalTime: 96\nThisTime: 96\nWaitTime: 110\n"));
  check("am start: a hot launch keeps the framework's own verdict", hot.launchState === "hot" && hot.thisMs === 96, JSON.stringify(hot));

  // The case worth the whole module: nothing launched, and most builds print
  // no TotalTime at all.
  const brought = parseAmStart(crlf(
    "Warning: Activity not started, its current task has been brought to the front\nStatus: ok\nComplete\n",
  ));
  check("am start: a task merely brought to the front has no launch time", brought.totalMs === null, JSON.stringify(brought));
  check("am start: and is refused rather than reported as instant",
    (amStartProblem(brought) ?? "").includes("no TotalTime"), String(amStartProblem(brought)));

  const missing = parseAmStart(crlf("Error: Activity class {com.x/.Nope} does not exist.\n"));
  check("am start: an unresolvable intent is an error, not a measurement",
    (amStartProblem(missing) ?? "").includes("does not exist"), String(amStartProblem(missing)));

  // A timeout can still print a TotalTime; the number describes a launch that
  // did not finish, so the status has to win.
  const timedOut = parseAmStart(crlf("Status: timeout\nTotalTime: 9999\n"));
  check("am start: a timeout is refused even with a TotalTime present",
    (amStartProblem(timedOut) ?? "").includes("timeout"), String(amStartProblem(timedOut)));

  // Android 9 prints no LaunchState. Still measurable, just without ground truth.
  const old9 = parseAmStart("Status: ok\nActivity: com.x/.MainActivity\nTotalTime: 512\nWaitTime: 530\n");
  check("am start: a pre-Android-10 launch measures without a LaunchState",
    old9.totalMs === 512 && old9.launchState === null && amStartProblem(old9) === null, JSON.stringify(old9));

  check("am start: empty output is refused", amStartProblem(parseAmStart("")) !== null);
  // A number in prose is not a field.
  const decoy = parseAmStart(crlf("Status: ok\nNote: the TotalTime: 42 shown earlier was wrong\n"));
  check("am start: a TotalTime mid-sentence is not read as a field", decoy.totalMs === null, JSON.stringify(decoy));
}

// --- network shaping: the vocabulary is refused, not defaulted ---

// A typo'd profile that silently runs unshaped turns an offline test into a
// test that proves nothing and still passes, which is the exact failure the
// module exists to prevent.
{
  check("network: offline parses", parseNetworkProfile("offline").kind === "offline");
  const delayed = parseNetworkProfile("offline-after-30s");
  check("network: offline-after-Ns keeps the delay",
    delayed.kind === "offline" && delayed.delayS === 30, JSON.stringify(delayed));
  check("network: 3g parses", parseNetworkProfile("3g").kind === "3g");
  let threw = false;
  try { parseNetworkProfile("slowish"); } catch { threw = true; }
  check("network: an unknown profile throws rather than running unshaped", threw);
}

console.log(failures === 0 ? "\nsmoke: ALL PASS" : `\nsmoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
