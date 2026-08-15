// End-to-end smoke: simulates one device-executor client and one host-executor
// client against a running collector. Exercises every Phase 0 endpoint.
// Usage: npm run smoke   (collector must be running on FLEET_URL, default :8788)
import { createHash } from "node:crypto";

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
    lease: { ttl_s: 2, max_attempts: 2 },
  });
  check("short-lease job enqueues", r.status === 201, JSON.stringify(r));

  const claim = await json("GET", `/devices/${DEVICE}/next-job`);
  check("device claims short-lease job", claim.body?.job_id === LEASE_JOB, JSON.stringify(claim.body));
  check("claimed spec carries effective lease", claim.body?.lease?.ttl_s === 2 && claim.body?.lease?.max_attempts === 2);

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
  await sleep(2500);
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

  await sleep(2500);
  const final = await json("POST", "/jobs/sweep");
  check("sweep fails the job once attempts run out", final.body?.failed?.includes(LEASE_JOB), JSON.stringify(final.body));
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

// 11. dashboard shows all of it
{
  const html = await (await fetch(`${BASE}/dash`)).text();
  check("dashboard lists device", html.includes(DEVICE));
  check("dashboard lists both jobs", html.includes(BENCH_JOB) && html.includes(UI_JOB));
  check("dashboard shows benchmark summary", html.includes("tok/s"));
  check("dashboard shows ui-test verdict", html.includes("11 passed / 1 failed"));
  check("dashboard explains the lease failure", html.includes(LEASE_JOB) && html.includes("gave up after 2/2 attempts"));
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
  await json("POST", "/devices/register", { device_id: BIG, descriptor: { model: "Big", ram_mb: 8000, os: "android-14" }, pools: ["match-pool"] });
  await json("POST", "/devices/register", { device_id: SMALL, descriptor: { model: "Small", ram_mb: 2000, os: "android-11" }, pools: ["match-pool"] });
  const bad = await json("POST", "/jobs", { schema: 1, job_id: `smoke-match-bad-${run}`, workload: "benchmark", executor: "device", targets: { match: "ram_mb >>> 4" } });
  check("invalid match expression rejected", bad.status === 400, JSON.stringify(bad.body));
  const fan = await json("POST", "/jobs", {
    schema: 1, job_id: `smoke-match-${run}`, workload: "benchmark", executor: "device", backend: "synthetic",
    fanout: true, targets: { pool: "match-pool", match: "ram_mb >= 4000 && os ~ 'android'" },
  });
  const kids = (fan.body?.fanout ?? []) as string[];
  check("fanout honors match (only the big device)", kids.length === 1 && kids[0].endsWith(BIG), JSON.stringify(fan.body));
  await json("POST", "/jobs", {
    schema: 1, job_id: `smoke-match-claim-${run}`, workload: "benchmark", executor: "device", backend: "synthetic",
    targets: { pool: "match-pool", match: "ram_mb < 3000" },
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

console.log(failures === 0 ? "\nsmoke: ALL PASS" : `\nsmoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
