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

const BASE = process.env.FLEET_URL ?? "http://127.0.0.1:8788";
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

type Target = { id: string; platform: "android" | "ios"; kind?: "device" | "simulator" };

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

// Physical iPhones/iPads paired with this Mac, via devicectl (Xcode 15+).
// Requires the device to be connected (USB or Wi-Fi) and trusted; installs
// need a build signed for it (TestFlight / dev profile), which is the app
// repo's problem, not the fleet's.
async function connectedIosDevices(): Promise<string[]> {
  try {
    const out = path.join(mkdtempSync(path.join(os.tmpdir(), "fleet-dc-")), "devices.json");
    await exec("xcrun", ["devicectl", "list", "devices", "--json-output", out], { timeout: 30_000 });
    const parsed = JSON.parse(readFileSync(out, "utf8")) as {
      result?: { devices?: { identifier: string; connectionProperties?: { tunnelState?: string } }[] };
    };
    return (parsed.result?.devices ?? [])
      .filter((d) => d.connectionProperties?.tunnelState === "connected")
      .map((d) => d.identifier);
  } catch {
    return [];
  }
}

// Android serials, booted iOS simulator UDIDs, and connected physical iOS
// devices (devicectl identifiers).
async function listTargets(): Promise<Target[]> {
  const android = (await adbDevices()).map((id): Target => ({ id, platform: "android", kind: "device" }));
  const sims = (await bootedSimulators()).map((id): Target => ({ id, platform: "ios", kind: "simulator" }));
  const phones = (await connectedIosDevices()).map((id): Target => ({ id, platform: "ios", kind: "device" }));
  return [...android, ...sims, ...phones];
}

async function hasApp(target: Target, appId: string): Promise<boolean> {
  try {
    if (target.platform === "android") {
      await exec(ADB, ["-s", target.id, "shell", "pm", "path", appId], { timeout: 15_000 });
    } else if (target.kind === "device") {
      const out = path.join(mkdtempSync(path.join(os.tmpdir(), "fleet-dc-")), "apps.json");
      await exec("xcrun", ["devicectl", "device", "info", "apps", "--device", target.id, "--json-output", out], { timeout: 30_000 });
      const parsed = JSON.parse(readFileSync(out, "utf8")) as { result?: { apps?: { bundleIdentifier: string }[] } };
      return (parsed.result?.apps ?? []).some((a) => a.bundleIdentifier === appId);
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
      } else if (target.kind === "device") {
        await exec("xcrun", ["devicectl", "device", "install", "app", "--device", target.id, installable], { timeout: 300_000 });
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
  if (target.platform === "ios" && target.kind === "device") {
    await exec("xcrun", ["devicectl", "device", "process", "launch", "--device", target.id, appId], { timeout: 60_000 });
    return;
  }
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
  try {
    if (target.platform === "android") {
      const { stdout } = await exec(ADB, ["-s", target.id, "shell", "dumpsys", "battery"], { timeout: 15_000 });
      const m = /level:\s*(\d+)/.exec(stdout);
      return m ? Number(m[1]) : null;
    }
    if (target.kind === "device") {
      // devicectl exposes battery via device info; the fleet runner's beacon
      // is the primary source on real iPhones — this is the host-side cross-check.
      const out = path.join(mkdtempSync(path.join(os.tmpdir(), "fleet-dc-")), "info.json");
      await exec("xcrun", ["devicectl", "device", "info", "details", "--device", target.id, "--json-output", out], { timeout: 30_000 });
      const txt = readFileSync(out, "utf8");
      const m = /"batteryLevel"\s*:\s*([0-9.]+)/.exec(txt);
      return m ? Math.round(Number(m[1]) * (Number(m[1]) <= 1 ? 100 : 1)) : null;
    }
    return null; // simulators have no battery
  } catch {
    return null;
  }
}

// Location replay: feed the device a recorded route so a drain run walks the
// same path every night with the real GPS radio on. Simulators take a GPX
// file directly; Android uses the mock-location provider (the app under test
// must allow mock locations in its debug build); real iPhones need the app's
// own debug replay provider (devicectl has no location injection).
async function replayLocation(target: Target, gpxPath: string): Promise<string> {
  if (target.platform === "ios" && target.kind === "simulator") {
    await exec("xcrun", ["simctl", "location", target.id, "start", "--speed=1.4", gpxPath], { timeout: 30_000 });
    return "simctl location (gpx replay)";
  }
  if (target.platform === "android") {
    // Parse trackpoints and push them one at a time via the emulator geo
    // console (emulators) or the mock provider (devices with fleet-runner as
    // mock app). Emulator path here; device path is best-effort.
    const gpx = readFileSync(gpxPath, "utf8");
    const pts = [...gpx.matchAll(/<trkpt[^>]*lat="([-0-9.]+)"[^>]*lon="([-0-9.]+)"/g)].map((m) => [Number(m[1]), Number(m[2])]);
    if (target.id.startsWith("emulator-")) {
      // Fire-and-forget replay: one fix per second, in the background.
      (async () => {
        for (const [lat, lon] of pts) {
          await exec(ADB, ["-s", target.id, "emu", "geo", "fix", String(lon), String(lat)], { timeout: 10_000 }).catch(() => {});
          await new Promise((r) => setTimeout(r, 1000));
        }
      })();
      return `adb emu geo fix (${pts.length} points)`;
    }
    return `no injection path for physical Android; app-side replay required (${pts.length} points parsed)`;
  }
  return "no injection path for physical iOS; app-side replay required";
}

// Drain: unplugged battery-drain curve for an app scenario. Launches the app,
// optionally replays a GPX route, and samples battery + process-alive every
// interval — each sample renews the lease. Result: the drain curve (per-check
// rows), start/end %, and %/hour. Honest about preconditions: refuses when
// the device is charging (a drain test on a charger is meaningless) unless
// params.allow_charging is set for pipeline validation.
async function runDrain(job: Job) {
  const appId = job.params?.app_id as string | undefined;
  if (!appId) throw new Error("drain job needs params.app_id");
  const durationS = Number(job.params?.duration_s ?? 3600);
  const intervalS = Number(job.params?.interval_s ?? 60);
  const gpxSha = job.params?.gpx_sha256 as string | undefined;
  const allowCharging = job.params?.allow_charging === true;
  const platform = job.app?.platform ?? "android";
  const targets = (await listTargets()).filter((t) => t.platform === platform);
  if (targets.length === 0) throw new Error(`no ${platform} targets attached`);

  let gpxPath: string | undefined;
  if (gpxSha) {
    gpxPath = path.join(mkdtempSync(path.join(os.tmpdir(), "fleet-gpx-")), "route.gpx");
    await fetchArtifact(gpxSha, gpxPath);
  }

  const start = new Map<string, number | null>();
  const eligible: Target[] = [];
  for (const t of targets) {
    if (!(await hasApp(t, appId))) {
      await postResult({ job_id: job.job_id, device_id: t.id, iter: 0, ok: true, error: `skipped: ${appId} not installed` });
      continue;
    }
    // Precondition: not charging. Android reports it via dumpsys; sims never charge.
    if (t.platform === "android" && !allowCharging) {
      const { stdout } = await exec(ADB, ["-s", t.id, "shell", "dumpsys", "battery"], { timeout: 15_000 }).catch(() => ({ stdout: "" }));
      if (/(AC|USB|Wireless) powered: true/.test(stdout)) {
        await postResult({ job_id: job.job_id, device_id: t.id, iter: 0, ok: false, error: "drain precondition failed: device is charging (unplug, or set the pool's power webhook)" });
        continue;
      }
    }
    await launchApp(t, appId).catch(() => {});
    let replay = "none";
    if (gpxPath) replay = await replayLocation(t, gpxPath).catch((e) => `replay failed: ${(e as Error).message}`);
    start.set(t.id, await batteryPct(t));
    log(`drain ${appId} on ${t.id}: start ${start.get(t.id)}% · location: ${replay}`);
    eligible.push(t);
  }
  if (eligible.length === 0) {
    await postResult({ job_id: job.job_id, device_id: `host:${NAME}`, iter: 0, final: true, ok: false, error: "no eligible targets (not installed / charging)" });
    return;
  }

  const t0 = Date.now();
  const deadline = t0 + durationS * 1000;
  let iter = 0;
  const alive = new Map(eligible.map((t) => [t.id, true]));
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, Math.min(intervalS * 1000, deadline - Date.now())));
    iter += 1;
    for (const t of eligible) {
      const isAlive = await processAlive(t, appId);
      if (!isAlive) alive.set(t.id, false);
      const battery = await batteryPct(t);
      await postBeacon(job.job_id, t.id, { process_alive: { [appId]: isAlive }, ...(battery !== null ? { battery_pct: battery } : {}) });
      await postResult({ job_id: job.job_id, device_id: t.id, iter, ok: isAlive,
        metrics: { battery_end_pct: battery, ttft_ms: (Date.now() - t0) / 1000 },
        error: isAlive ? undefined : `process ${appId} not running at check ${iter}` });
    }
  }
  if (gpxPath) for (const t of eligible) if (t.platform === "ios" && t.kind === "simulator")
    await exec("xcrun", ["simctl", "location", t.id, "clear"], { timeout: 15_000 }).catch(() => {});

  let allOk = true;
  for (const t of eligible) {
    const s = start.get(t.id); const e = await batteryPct(t);
    const hours = (Date.now() - t0) / 3_600_000;
    const perHour = s !== null && s !== undefined && e !== null && hours > 0 ? (s - e) / hours : null;
    const ok = alive.get(t.id) ?? false;
    if (!ok) allOk = false;
    await postResult({ job_id: job.job_id, device_id: t.id, iter: 0, ok,
      // drain_pct_per_h, not decode_tok_s. This used to ride in the decode slot
      // "for the bench page" — which never worked: both bench queries filter
      // workload = 'benchmark', so a drain row could not appear there. All it
      // achieved was a battery figure stored under a name that means tokens
      // per second. Historical rows still carry it that way and the dashboard
      // reads them back, marked as inferred.
      metrics: { battery_start_pct: s, battery_end_pct: e, drain_pct_per_h: perHour },
      error: ok ? undefined : `${appId} died during the drain run` });
    log(`drain ${appId} on ${t.id}: ${s}% -> ${e}% (${perHour?.toFixed(1) ?? "?"} %/h) ${ok ? "" : "APP DIED"}`);
  }
  await postResult({ job_id: job.job_id, device_id: `host:${NAME}`, iter: 0, final: true, ok: allOk });
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
      else if (job.workload === "drain") await runDrain(job);
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
