// Host executor: claims executor:"host" jobs and drives attached Android
// devices from outside via adb + Maestro. Runs on the Mac next to the
// collector (iOS support arrives in Phase 3 via devicectl/XCUITest).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const exec = promisify(execFile);

const BASE = process.env.FLEET_URL ?? "http://127.0.0.1:8787";
const NAME = process.env.FLEET_EXECUTOR_NAME ?? os.hostname().replace(/\.local$/, "");
const FLOWS_DIR = process.env.FLEET_FLOWS_DIR ?? path.resolve("flows");
const MAESTRO = process.env.MAESTRO_BIN ?? path.join(os.homedir(), ".maestro/bin/maestro");
const ADB = process.env.ADB_BIN ?? "adb";

type Job = {
  job_id: string;
  workload: string;
  app?: { name: string; build: string; sha256: string; platform?: "android" | "ios" };
  suite?: { kind: string; flows?: string; app_id?: string; asserts?: string[] };
  targets?: { pool?: string; exclusive?: boolean };
  params?: Record<string, unknown>;
};

// The generic XCUITest bundle lives in the iOS runner repo; one scheme tests
// any app via TEST_RUNNER_-passed env (FLEET_APP_ID / FLEET_ASSERTS).
const IOS_PROJECT = process.env.FLEET_IOS_PROJECT ??
  path.resolve("../fleet-runner-ios/FleetRunner.xcodeproj");

type Target = { id: string; platform: "android" | "ios" };

const log = (msg: string) => console.log(`[executor:${NAME}] ${msg}`);

async function post(url: string, body: unknown) {
  const res = await fetch(`${BASE}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${url} -> ${res.status}`);
}

async function postResult(row: Record<string, unknown>) {
  await post("/results", { schema: 1, kind: "result", ...row });
}

// Exclusive jobs hold the collector's device locks while they run, so a
// device-executor agent never gets handed work mid-UI-test.
async function acquireLocks(jobId: string, deviceIds: string[]): Promise<Set<string>> {
  const res = await fetch(`${BASE}/locks/acquire`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ job_id: jobId, device_ids: deviceIds }),
  });
  if (!res.ok) throw new Error(`locks/acquire -> ${res.status}`);
  const body = (await res.json()) as { granted: string[] };
  return new Set(body.granted);
}

async function releaseLocks(jobId: string) {
  await fetch(`${BASE}/locks/release`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ job_id: jobId }),
  }).catch(() => {});
}

async function adbDevices(): Promise<string[]> {
  const { stdout } = await exec(ADB, ["devices"]);
  return stdout
    .split("\n")
    .slice(1)
    .filter((l) => l.trim().endsWith("device"))
    .map((l) => l.split("\t")[0]);
}

async function bootedSimulators(): Promise<string[]> {
  try {
    const { stdout } = await exec("xcrun", ["simctl", "list", "devices", "booted", "-j"]);
    const parsed = JSON.parse(stdout) as {
      devices: Record<string, { udid: string; state: string }[]>;
    };
    return Object.values(parsed.devices).flat()
      .filter((d) => d.state === "Booted")
      .map((d) => d.udid);
  } catch {
    return []; // no Xcode tooling on this host
  }
}

// Android serials plus booted iOS simulator UDIDs. Real iPhones via
// devicectl are the remaining Phase 3b gap.
async function listTargets(): Promise<Target[]> {
  const android = (await adbDevices()).map((id): Target => ({ id, platform: "android" }));
  const ios = (await bootedSimulators()).map((id): Target => ({ id, platform: "ios" }));
  return [...android, ...ios];
}

async function hasApp(target: Target, appId: string): Promise<boolean> {
  try {
    if (target.platform === "android") {
      await exec(ADB, ["-s", target.id, "shell", "pm", "path", appId], { timeout: 15_000 });
    } else {
      await exec("xcrun", ["simctl", "get_app_container", target.id, appId], { timeout: 15_000 });
    }
    return true;
  } catch {
    return false;
  }
}

async function fetchArtifact(sha256: string, dest: string) {
  const res = await fetch(`${BASE}/artifacts/${sha256}`);
  if (!res.ok) throw new Error(`artifact ${sha256} -> ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = createHash("sha256").update(buf).digest("hex");
  if (got !== sha256) throw new Error(`artifact hash mismatch: ${got}`);
  writeFileSync(dest, buf);
}

async function uploadArtifact(file: string, name: string): Promise<string> {
  const res = await fetch(`${BASE}/artifacts`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-artifact-name": name },
    body: readFileSync(file),
  });
  if (!res.ok) throw new Error(`artifact upload -> ${res.status}`);
  return ((await res.json()) as { sha256: string }).sha256;
}

async function runInstall(job: Job) {
  const app = job.app;
  if (!app) throw new Error("install job needs an app ref");
  const platform = app.platform ?? "android";
  const targets = (await listTargets()).filter((t) => t.platform === platform);
  if (targets.length === 0) throw new Error(`no ${platform} targets attached`);

  const dir = mkdtempSync(path.join(os.tmpdir(), "fleet-"));
  let installable: string;
  if (platform === "android") {
    installable = path.join(dir, `${app.name}.apk`);
    await fetchArtifact(app.sha256, installable);
  } else {
    // iOS artifacts are zips of the .app bundle (a directory can't be a raw artifact).
    const zip = path.join(dir, `${app.name}.zip`);
    await fetchArtifact(app.sha256, zip);
    await exec("ditto", ["-x", "-k", zip, dir], { timeout: 120_000 });
    const appDir = readdirSync(dir).find((f) => f.endsWith(".app"));
    if (!appDir) throw new Error("no .app bundle inside iOS artifact zip");
    installable = path.join(dir, appDir);
  }

  let allOk = true;
  for (const target of targets) {
    let ok = true;
    let error: string | undefined;
    try {
      if (platform === "android") {
        await exec(ADB, ["-s", target.id, "install", "-r", installable], { timeout: 120_000 });
      } else {
        await exec("xcrun", ["simctl", "install", target.id, installable], { timeout: 120_000 });
      }
    } catch (e) {
      ok = false;
      allOk = false;
      error = (e as Error).message.slice(0, 300);
    }
    await postResult({ job_id: job.job_id, device_id: target.id, iter: 0, ok, error });
    log(`install ${app.name}@${app.build} on ${target.id} (${platform}): ${ok ? "ok" : "FAILED"}`);
  }
  await postResult({ job_id: job.job_id, device_id: `host:${NAME}`, iter: 0, final: true, ok: allOk });
}

function parseJunit(xml: string): { passed: number; failed: number } {
  const m = /tests="(\d+)"[^>]*failures="(\d+)"/.exec(xml);
  if (!m) return { passed: 0, failed: 1 };
  const tests = Number(m[1]);
  const failed = Number(m[2]);
  return { passed: tests - failed, failed };
}

// XCUITest path: iOS simulators only (real devices need signing + devicectl).
// Pass/fail per device from xcodebuild's exit code; the log tail is uploaded
// as the artifact since xcresult parsing earns its keep only with real suites.
async function runXcuitest(job: Job) {
  const suite = job.suite!;
  const appId = suite.app_id;
  if (!appId) throw new Error("xcuitest suite needs app_id");
  const asserts = (suite.asserts ?? []).join("|");
  const targets = (await listTargets()).filter((t) => t.platform === "ios");
  if (targets.length === 0) throw new Error("no booted iOS simulators");

  const granted = job.targets?.exclusive
    ? await acquireLocks(job.job_id, targets.map((t) => t.id))
    : null;

  let allOk = true;
  try {
    for (const target of targets) {
      if (granted && !granted.has(target.id)) {
        await postResult({
          job_id: job.job_id, device_id: target.id, iter: 0, ok: true,
          error: "skipped: device locked by another job",
        });
        continue;
      }
      if (!(await hasApp(target, appId))) {
        await postResult({
          job_id: job.job_id, device_id: target.id, iter: 0, ok: true,
          error: `skipped: ${appId} not installed`,
        });
        log(`xcuitest on ${target.id}: skipped (${appId} not installed)`);
        continue;
      }
      let ok = true;
      let logTail = "";
      try {
        const { stdout } = await exec(
          "xcodebuild",
          ["test", "-project", IOS_PROJECT, "-scheme", "FleetRunner",
           "-destination", `platform=iOS Simulator,id=${target.id}`,
           "-only-testing:FleetRunnerUITests"],
          {
            timeout: 900_000,
            env: {
              ...process.env,
              TEST_RUNNER_FLEET_APP_ID: appId,
              TEST_RUNNER_FLEET_ASSERTS: asserts,
            },
            maxBuffer: 64 * 1024 * 1024,
          },
        );
        logTail = stdout.slice(-4000);
      } catch (e) {
        ok = false;
        allOk = false;
        logTail = ((e as { stdout?: string }).stdout ?? (e as Error).message).slice(-4000);
      }
      const logFile = path.join(mkdtempSync(path.join(os.tmpdir(), "fleet-xc-")), "xcodebuild.log");
      writeFileSync(logFile, logTail);
      const sha = await uploadArtifact(logFile, `${job.job_id}-${target.id}-xcodebuild.log`);
      await postResult({
        job_id: job.job_id, device_id: target.id, iter: 0, ok,
        test: { passed: ok ? 1 : 0, failed: ok ? 0 : 1, artifacts: [sha] },
      });
      log(`xcuitest on ${target.id}: ${ok ? "passed" : "FAILED"}`);
    }
  } finally {
    if (granted) await releaseLocks(job.job_id);
  }
  await postResult({ job_id: job.job_id, device_id: `host:${NAME}`, iter: 0, final: true, ok: allOk });
}

async function runUiTest(job: Job) {
  const suite = job.suite;
  if (!suite) throw new Error("ui-test job needs a suite");
  if (suite.kind === "xcuitest") return runXcuitest(job);
  if (suite.kind !== "maestro") throw new Error(`suite kind ${suite.kind} not supported yet`);
  if (!suite.flows) throw new Error("maestro suite needs flows");
  const flows = path.resolve(FLOWS_DIR, suite.flows);
  if (!existsSync(flows)) throw new Error(`flows not found: ${flows}`);

  const targets = await listTargets();
  if (targets.length === 0) throw new Error("no targets attached");

  // The appId in the flow decides which pool members can run it; devices
  // without the app are reported as skipped, not failed (registry pools
  // make this explicit in Phase 4). Same bundle id on both platforms means
  // one flow can span Android and iOS.
  const appIdMatch = /^appId:\s*(\S+)/m.exec(readFileSync(flows, "utf8"));
  const appId = appIdMatch?.[1];

  const granted = job.targets?.exclusive
    ? await acquireLocks(job.job_id, targets.map((t) => t.id))
    : null;

  let allOk = true;
  try {
  for (const target of targets) {
    const serial = target.id;
    if (granted && !granted.has(serial)) {
      await postResult({
        job_id: job.job_id, device_id: serial, iter: 0, ok: true,
        error: "skipped: device locked by another job",
      });
      log(`ui-test on ${serial}: skipped (locked)`);
      continue;
    }
    if (appId && !(await hasApp(target, appId))) {
      await postResult({
        job_id: job.job_id, device_id: serial, iter: 0, ok: true,
        error: `skipped: ${appId} not installed`,
      });
      log(`ui-test on ${serial}: skipped (${appId} not installed)`);
      continue;
    }
    const outDir = mkdtempSync(path.join(os.tmpdir(), "fleet-junit-"));
    const report = path.join(outDir, "report.xml");
    let failedToRun = false;
    try {
      await exec(
        MAESTRO,
        ["--device", serial, "test", "--format", "junit", "--output", report, flows],
        { timeout: 600_000 },
      );
    } catch {
      // Non-zero exit also just means failing flows; the report tells the truth.
      failedToRun = !existsSync(report);
    }

    let passed = 0;
    let failed = 1;
    const artifacts: string[] = [];
    if (!failedToRun && existsSync(report)) {
      ({ passed, failed } = parseJunit(readFileSync(report, "utf8")));
      artifacts.push(await uploadArtifact(report, `${job.job_id}-${serial}-junit.xml`));
    }
    if (failed > 0) allOk = false;
    await postResult({
      job_id: job.job_id, device_id: serial, iter: 0,
      ok: failed === 0, test: { passed, failed, artifacts },
    });
    log(`ui-test on ${serial}: ${passed} passed / ${failed} failed`);
  }
  } finally {
    if (granted) await releaseLocks(job.job_id);
  }
  await postResult({ job_id: job.job_id, device_id: `host:${NAME}`, iter: 0, final: true, ok: allOk });
}

async function postBeacon(jobId: string, deviceId: string, extra: Record<string, unknown>) {
  await post("/results", {
    schema: 1, kind: "beacon", job_id: jobId, device_id: deviceId, beacon: extra,
  });
}

async function launchApp(target: Target, appId: string) {
  if (target.platform === "android") {
    // Resolve the real launcher activity; monkey is a fallback because some
    // images (ATD) resolve but throttle monkey events.
    try {
      const { stdout } = await exec(
        ADB, ["-s", target.id, "shell", "cmd", "package", "resolve-activity", "--brief", appId],
        { timeout: 15_000 },
      );
      const component = stdout.trim().split("\n").pop()?.trim();
      if (!component || !component.includes("/")) throw new Error(`unresolvable: ${stdout}`);
      await exec(ADB, ["-s", target.id, "shell", "am", "start", "-n", component], { timeout: 30_000 });
    } catch {
      await exec(ADB, ["-s", target.id, "shell", "monkey", "-p", appId, "-c",
        "android.intent.category.LAUNCHER", "1"], { timeout: 30_000 });
    }
  } else {
    await exec("xcrun", ["simctl", "launch", target.id, appId], { timeout: 60_000 });
  }
}

async function processAlive(target: Target, appId: string): Promise<boolean> {
  try {
    if (target.platform === "android") {
      const { stdout } = await exec(ADB, ["-s", target.id, "shell", "pidof", appId], { timeout: 15_000 });
      return stdout.trim().length > 0;
    }
    const { stdout } = await exec("xcrun", ["simctl", "spawn", target.id, "launchctl", "list"], { timeout: 15_000 });
    return stdout.includes(appId);
  } catch {
    return false;
  }
}

async function batteryPct(target: Target): Promise<number | null> {
  if (target.platform !== "android") return null; // simulators have no battery
  try {
    const { stdout } = await exec(ADB, ["-s", target.id, "shell", "dumpsys", "battery"], { timeout: 15_000 });
    const m = /level:\s*(\d+)/.exec(stdout);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

// Soak: launch the app, then prove it stays alive — the whole measurement for
// OEM-task-killer survival. Each sample is a beacon (renewing the job lease)
// plus a result row; ok means the process survived every check.
async function runSoak(job: Job) {
  const appId = (job.params?.app_id as string) ?? undefined;
  if (!appId) throw new Error("soak job needs params.app_id");
  const durationS = Number(job.params?.duration_s ?? 3600);
  const intervalS = Number(job.params?.interval_s ?? 60);
  const platform = job.app?.platform ?? "android";
  const targets = (await listTargets()).filter((t) => t.platform === platform);
  if (targets.length === 0) throw new Error(`no ${platform} targets attached`);

  const alive = new Map<string, boolean>();
  for (const t of targets) {
    await launchApp(t, appId).catch(() => {});
    alive.set(t.id, true);
  }

  const deadline = Date.now() + durationS * 1000;
  let iter = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, Math.min(intervalS * 1000, deadline - Date.now())));
    iter += 1;
    for (const t of targets) {
      const isAlive = await processAlive(t, appId);
      if (!isAlive) alive.set(t.id, false);
      const battery = await batteryPct(t);
      await postBeacon(job.job_id, t.id, {
        process_alive: { [appId]: isAlive },
        ...(battery !== null ? { battery_pct: battery } : {}),
      });
      await postResult({
        job_id: job.job_id, device_id: t.id, iter,
        ok: isAlive, error: isAlive ? undefined : `process ${appId} not running at check ${iter}`,
      });
      log(`soak ${appId} on ${t.id} check ${iter}: ${isAlive ? "alive" : "DEAD"}`);
    }
  }

  let allOk = true;
  for (const t of targets) {
    const survived = alive.get(t.id) ?? false;
    if (!survived) allOk = false;
    await postResult({
      job_id: job.job_id, device_id: t.id, iter: 0, ok: survived,
      error: survived ? undefined : `${appId} died during the soak`,
    });
  }
  await postResult({ job_id: job.job_id, device_id: `host:${NAME}`, iter: 0, final: true, ok: allOk });
}

async function main() {
  log(`polling ${BASE} (flows: ${FLOWS_DIR})`);
  while (true) {
    let job: Job | null = null;
    try {
      const res = await fetch(`${BASE}/executor/next-job?name=${encodeURIComponent(NAME)}`);
      if (res.status === 204) continue;
      if (!res.ok) throw new Error(`next-job -> ${res.status}`);
      job = (await res.json()) as Job;
    } catch (e) {
      log(`poll error: ${(e as Error).message}; retrying in 10s`);
      await new Promise((r) => setTimeout(r, 10_000));
      continue;
    }

    log(`claimed ${job.job_id} (${job.workload})`);
    try {
      if (job.workload === "install") await runInstall(job);
      else if (job.workload === "ui-test") await runUiTest(job);
      else if (job.workload === "soak") await runSoak(job);
      else {
        await postResult({
          job_id: job.job_id, device_id: `host:${NAME}`, iter: 0, final: true, ok: false,
          error: `workload '${job.workload}' not supported by this executor yet`,
        });
      }
    } catch (e) {
      await postResult({
        job_id: job.job_id, device_id: `host:${NAME}`, iter: 0, final: true, ok: false,
        error: (e as Error).message.slice(0, 500),
      });
      log(`job ${job.job_id} failed: ${(e as Error).message}`);
    }
  }
}

main();
