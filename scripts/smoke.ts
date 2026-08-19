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
  const ui = await json("GET", "/api/results/ui");
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
    nickname: "shelf top left", notes: "USB hub port 3", pools: [EDIT_POOL],
  });
  check("device edit accepted", patch.status === 200, JSON.stringify(patch.body));
  const dev = await json("GET", `/api/devices/${DEVICE}`);
  check("nickname and notes persist", dev.body?.nickname === "shelf top left" && dev.body?.notes === "USB hub port 3");
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
  check("re-registration does not clobber the nickname", after.body?.nickname === "shelf top left");

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
  // Measured as one delta, not absolutes: this suite shares a collector with
  // whatever ran before it, so an absolute count only holds on a fresh
  // database. Both devices are registered between a single pair of readings —
  // low_battery only counts devices still 'online', so any earlier device
  // aging past that threshold mid-measurement would move an unrelated count,
  // and the narrower the window, the less that can happen.
  const lowBattery = async () =>
    ((await json("GET", "/api/overview?fresh=1")).body?.devices?.low_battery ?? 0) as number;
  const before = await lowBattery();

  // iOS simulators report -1 for battery: "no battery telemetry", not "1%".
  const SIM = `smoke-sim-${run}`;
  await json("POST", "/devices/register", { device_id: SIM, descriptor: { model: "iPhone 16 Simulator", os: "ios-18.4" }, pools: [] });
  await json("POST", "/results", {
    schema: 1, kind: "beacon", device_id: SIM,
    beacon: { battery_pct: -1, charging: false, thermal: "nominal" },
  });
  // A genuinely flat device, so the assertion distinguishes "-1 is ignored"
  // from "the counter is simply broken".
  const FLAT = `smoke-flat-${run}`;
  await json("POST", "/devices/register", { device_id: FLAT, descriptor: { model: "Flat" }, pools: [] });
  await json("POST", "/results", {
    schema: 1, kind: "beacon", device_id: FLAT,
    beacon: { battery_pct: 7, charging: false, thermal: "nominal" },
  });

  const after = await lowBattery();
  check(
    "exactly one of a -1 battery and a 7% battery counts as low",
    after === before + 1,
    `before=${before} after=${after} (a -1 simulator battery must not count; 7% must)`,
  );
}

// 29b. results views (plan D3)
{
  const drain = await json("GET", "/api/results/drain");
  check("drain view answers", drain.status === 200 && Array.isArray(drain.body?.runs));
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

// 29. the legacy dashboard's own links still resolve to legacy pages
{
  const html = await (await fetch(`${BASE}/dash/legacy`)).text();
  // The whole point of legacy is that it works when the SPA is not built, so a
  // link from it into the SPA shell would strand the operator.
  check("legacy links to the legacy bench page", html.includes('href="/dash/legacy/bench"'), "legacy dash links off to a removed route");
  const bench = await (await fetch(`${BASE}/dash/legacy/bench`)).text();
  check("legacy bench links back to the legacy dash", bench.includes('href="/dash/legacy"'));
}

console.log(failures === 0 ? "\nsmoke: ALL PASS" : `\nsmoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
