// End-to-end smoke: simulates one device-executor client and one host-executor
// client against a running collector. Exercises every Phase 0 endpoint.
// Usage: npm run smoke   (collector must be running on FLEET_URL, default :8787)
import { createHash } from "node:crypto";

const BASE = process.env.FLEET_URL ?? "http://127.0.0.1:8787";
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

const run = Date.now();
const DEVICE = `smoke-pixel-${run}`;
const BENCH_JOB = `smoke-bench-${run}`;
const UI_JOB = `smoke-uitest-${run}`;

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

// 9. dashboard shows all of it
{
  const html = await (await fetch(`${BASE}/dash`)).text();
  check("dashboard lists device", html.includes(DEVICE));
  check("dashboard lists both jobs", html.includes(BENCH_JOB) && html.includes(UI_JOB));
  check("dashboard shows benchmark summary", html.includes("tok/s"));
  check("dashboard shows ui-test verdict", html.includes("11 passed / 1 failed"));
}

console.log(failures === 0 ? "\nsmoke: ALL PASS" : `\nsmoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
