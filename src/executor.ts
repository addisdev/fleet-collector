// Host executor: claims executor:"host" jobs and drives attached Android
// devices from outside via adb + Maestro. Runs on the Mac next to the
// collector (iOS support arrives in Phase 3 via devicectl/XCUITest).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { countXcodebuildTests, xcodebuildDiagnostics } from "./xcparse.js";
import {
  fleetOwned, physicalIos, simulatorName, isAndroidEmulatorSerial,
  type IosDeviceInfo,
} from "./targets.js";

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
  suite?: {
    kind: string; flows?: string; app_id?: string; asserts?: string[];
    // An app repo running its OWN XCUITest suite rather than the generic
    // FleetRunner bundle: which project, which scheme, which tests.
    project?: string; scheme?: string; only?: string;
  };
  targets?: { pool?: string; exclusive?: boolean; executor?: string; url?: string };
  params?: Record<string, unknown>;
  lease?: { ttl_s?: number };
};

// The generic XCUITest bundle lives in the iOS runner repo; one scheme tests
// any app via TEST_RUNNER_-passed env (FLEET_APP_ID / FLEET_ASSERTS).
const WEB_SPECS_DIR = process.env.FLEET_WEB_SPECS_DIR ?? path.resolve("web-specs");

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

/**
 * What devicectl knows, keyed by identifier.
 *
 * Read once and shared, because devicectl is slow and every caller wants the
 * same answer. The important field is `transport`, and it is not the obvious
 * one: devicectl lists SIMULATORS as devices too, with no `isSimulated` flag
 * to tell them apart -- this Mac reports 25 "devices", of which one is real.
 * A simulator is always `sameMachine`; hardware arrives over `wired` or
 * `localNetwork`. Filtering on tunnelState alone let a simulator through as a
 * physical device, which is how one ended up in the fleet.
 */
async function devicectlDevices(): Promise<IosDeviceInfo[]> {
  try {
    const out = path.join(mkdtempSync(path.join(os.tmpdir(), "fleet-dc-")), "devices.json");
    await exec("xcrun", ["devicectl", "list", "devices", "--json-output", out], { timeout: 30_000 });
    const parsed = JSON.parse(readFileSync(out, "utf8")) as {
      result?: {
        devices?: {
          identifier: string;
          connectionProperties?: { tunnelState?: string; transportType?: string; pairingState?: string };
          hardwareProperties?: { marketingName?: string; productType?: string; platform?: string };
          deviceProperties?: { name?: string; osVersionNumber?: string };
        }[];
      };
    };
    return (parsed.result?.devices ?? []).map((d) => ({
      identifier: d.identifier,
      name: d.deviceProperties?.name,
      marketingName: d.hardwareProperties?.marketingName,
      productType: d.hardwareProperties?.productType,
      osVersion: d.deviceProperties?.osVersionNumber,
      transport: d.connectionProperties?.transportType,
      tunnelState: d.connectionProperties?.tunnelState,
      pairingState: d.connectionProperties?.pairingState,
      platform: d.hardwareProperties?.platform,
    }));
  } catch {
    return []; // no Xcode tooling on this host
  }
}

/** `ios` lets a caller that has already listed devicectl avoid paying for it twice. */
async function listTargets(ios?: IosDeviceInfo[]): Promise<Target[]> {
  const android = (await adbDevices()).map((id): Target => ({ id, platform: "android", kind: "device" }));
  const sims = (await bootedSimulators()).map((id): Target => ({ id, platform: "ios", kind: "simulator" }));
  const phones = physicalIos(ios ?? (await devicectlDevices())).map((d): Target => ({
    id: d.identifier, platform: "ios", kind: "device",
  }));
  // A booted simulator is reported by BOTH simctl and devicectl, so dedupe and
  // let the simctl answer win: it is the one that knows it is a simulator.
  const seen = new Set(sims.map((t) => t.id));
  return [...android, ...sims, ...phones.filter((t) => !seen.has(t.id))];
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

// XCUITest path: booted simulators and physical devices paired with this Mac.
// A physical device additionally needs a signed test bundle -- xcodebuild will
// say so plainly, and the diagnostics in the log artifact carry that message.
// Pass/fail per device from the test counts xcodebuild reports; the log tail is
// uploaded as the artifact.
async function runXcuitest(job: Job) {
  const suite = job.suite!;
  // An app repo's own suite names its project and scheme. The generic
  // FleetRunner bundle drives an ALREADY-INSTALLED app and so needs an app_id;
  // a real suite builds and installs the app itself, so it needs neither an
  // app_id nor the installed-app check below.
  const ownProject = suite.project ? path.resolve(suite.project) : null;
  const project = ownProject ?? IOS_PROJECT;
  const scheme = suite.scheme ?? "FleetRunner";
  const only = suite.only ?? (ownProject ? undefined : "FleetRunnerUITests");
  const appId = suite.app_id;
  if (!appId && !ownProject) throw new Error("xcuitest suite needs app_id or project");
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
      // Only meaningful for the generic bundle: a project running its own
      // suite installs the app as part of the test action.
      if (!ownProject && appId && !(await hasApp(target, appId))) {
        await postResult({
          job_id: job.job_id, device_id: target.id, iter: 0, ok: true,
          error: `skipped: ${appId} not installed`,
        });
        log(`xcuitest on ${target.id}: skipped (${appId} not installed)`);
        continue;
      }
      let ok = true;
      let logTail = "";
      let full = "";
      try {
        const { stdout } = await exec(
          "xcodebuild",
          ["test", "-project", project, "-scheme", scheme,
           // A physical device is not a simulator, and xcodebuild will not
           // guess: the destination platform has to match the hardware or the
           // run fails before a single test starts.
           "-destination", `platform=${target.kind === "simulator" ? "iOS Simulator" : "iOS"},id=${target.id}`,
           ...(only ? [`-only-testing:${only}`] : [])],
          {
            timeout: Number(job.params?.timeout_s ?? 1800) * 1000,
            env: {
              ...process.env,
              ...(appId ? { TEST_RUNNER_FLEET_APP_ID: appId } : {}),
              ...(asserts ? { TEST_RUNNER_FLEET_ASSERTS: asserts } : {}),
            },
            maxBuffer: 64 * 1024 * 1024,
          },
        );
        full = stdout;
        logTail = stdout.slice(-4000);
      } catch (e) {
        ok = false;
        allOk = false;
        full = (e as { stdout?: string }).stdout ?? "";
        logTail = (full || (e as Error).message).slice(-4000);
      }
      // Counts come from what ran, not from the exit code.
      const counted = countXcodebuildTests(full);
      const passed = counted.passed;
      // A build failure produces no Test Case lines at all, and a suite that
      // XCTSkip'd every case produces no passes -- xcodebuild exits 0 for the
      // second, so without this a run that tested NOTHING reports green.
      let failed = counted.failed || (ok ? 0 : 1);
      let note = "";
      // A skip is a test that did not run. Judging only the all-skipped case
      // makes the check all-or-nothing, while the failure it guards against --
      // a fixture rotting and coverage quietly shrinking -- is gradual: a suite
      // that degrades from 16 passing to 1 passing and 15 skipped would stay
      // green on the strength of the one survivor. Most of the suite not
      // running is a result nobody should have to read a count to notice.
      if (counted.skipped > 0 && counted.skipped >= passed + counted.failed) {
        failed = failed || counted.skipped;
        note = passed === 0 && counted.failed === 0
          ? `all ${counted.skipped} tests skipped (no fixture?)`
          : `${counted.skipped} of ${passed + counted.failed + counted.skipped} tests skipped (no fixture?)`;
      }
      if (failed > 0) { ok = false; allOk = false; }
      // The tail alone is not enough to diagnose a build failure: xcodebuild
      // prints thousands of lines of compile commands after the error, so the
      // last 4000 characters are reliably the least useful 4000 characters.
      const diagnostics = xcodebuildDiagnostics(full);
      const logFile = path.join(mkdtempSync(path.join(os.tmpdir(), "fleet-xc-")), "xcodebuild.log");
      writeFileSync(
        logFile,
        (diagnostics.length ? `--- diagnostics (${diagnostics.length}) ---\n${diagnostics.join("\n")}\n\n` : "") +
          `--- tail ---\n${logTail}`,
      );
      const sha = await uploadArtifact(logFile, `${job.job_id}-${target.id}-xcodebuild.log`);
      await postResult({
        job_id: job.job_id, device_id: target.id, iter: 0, ok,
        test: { passed, failed, skipped: counted.skipped, artifacts: [sha] },
        error: note || undefined,
      });
      log(
        `xcuitest ${scheme} on ${target.id}: ${passed} passed / ${failed} failed` +
        (counted.skipped ? ` / ${counted.skipped} skipped` : "") + (note ? ` -- ${note}` : ""),
      );
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
  // The flow names an app; the job may override which VARIANT of it.
  //
  // This is the .debug mismatch from the plan. A flow hard-coding
  // com.taylab.greenfolio.debug cannot test the .smoke build that CI actually
  // publishes, and a flow hard-coding either cannot test the other -- so the
  // one flow that existed could never pass against the installed package.
  // A flow written as `appId: ${APP_ID}` takes the id from the job instead, and
  // the same flow then covers debug, smoke and release.
  const appIdMatch = /^appId:\s*(\S+)/m.exec(readFileSync(flows, "utf8"));
  const declared = appIdMatch?.[1];
  const parameterised = !declared || /\$\{|^\$/.test(declared);
  if (parameterised && !job.suite?.app_id) {
    throw new Error(`${flows} takes its appId from the job, so suite.app_id is required`);
  }
  const appId = job.suite?.app_id ?? declared;

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
        ["--device", serial, "test", "--format", "junit", "--output", report,
         ...(appId ? ["-e", `APP_ID=${appId}`] : []), flows],
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

/**
 * web-test: Playwright against a URL.
 *
 * No device, so no target list and no locks — the "device" on the result row is
 * the browser, because a result row needs a device_id and pretending a phone
 * was involved would be worse than naming what actually ran.
 *
 * Browsers install into the executor's own home directory, so this stays
 * sudo-free like everything else on these machines.
 */
async function runWebTest(job: Job) {
  const url = job.targets?.url;
  if (!url) throw new Error("web-test needs targets.url");
  const spec = (job.suite?.flows as string | undefined) ?? ".";
  const browser = (job.params?.browser as string | undefined) ?? "chromium";
  const specRoot = path.resolve(WEB_SPECS_DIR);
  const specDir = path.resolve(specRoot, spec);
  // The separator matters: a bare prefix test lets `../web-specs-evil` through,
  // because it really does start with `.../web-specs`.
  if (specDir !== specRoot && !specDir.startsWith(specRoot + path.sep)) {
    throw new Error("suite.flows escapes the specs dir");
  }

  // Only executors with browsers installed can honestly run this. The fleet
  // has them on one machine, so an unpinned web job landing anywhere else must
  // say "this host has no browsers" rather than fail somewhere inside npx --
  // or worse, quietly download a browser onto a 2016 laptop mid-nightly.
  if (process.env.FLEET_WEB !== "1") {
    await postResult({
      job_id: job.job_id, device_id: `host:${NAME}`, iter: 0, final: true, ok: false,
      error: `executor ${NAME} has no browsers; pin web-test with targets.executor`,
    });
    log(`refused web-test ${job.job_id}: no browsers on ${NAME}`);
    return;
  }

  const deviceId = `web:${browser}`;
  const out = mkdtempSync(path.join(os.tmpdir(), `web-${job.job_id}-`));

  // Nothing beacons during a web run, so the lease cannot be renewed: the
  // process must finish inside it or the sweep requeues a job that is still
  // running and a second executor runs the same suite concurrently.
  // next-job reports the lease the collector granted. Stop a little short of
  // it so a timing-out run reports its own failure rather than being swept
  // mid-flight and silently re-run by whoever claims it next.
  const lease = Number(job.lease?.ttl_s);
  const asked = Number(job.params?.timeout_s);
  const budgetS = Number.isFinite(asked) && asked > 0
    ? asked
    : (Number.isFinite(lease) && lease > 30 ? lease - 30 : 570);
  const timeoutS = Math.max(30, budgetS);

  const args = [
    "playwright", "test", specDir,
    `--project=${browser}`,
    "--reporter=json",
    `--output=${out}`,
  ];
  const started = Date.now();
  let passed = 0;
  let failed = 0;
  let ok = false;
  let detail = "";

  try {
    const { stdout } = await exec("npx", args, {
      timeout: timeoutS * 1000,
      env: { ...process.env, PLAYWRIGHT_BASE_URL: url, CI: "1" },
    });
    // Playwright's JSON reporter puts the counts in stats; a non-zero exit is
    // a failing suite, not a broken run, so both paths report rather than throw.
    const report = JSON.parse(stdout.slice(stdout.indexOf("{")));
    passed = report.stats?.expected ?? 0;
    failed = (report.stats?.unexpected ?? 0) + (report.stats?.flaky ?? 0);
    ok = failed === 0 && passed > 0;
  } catch (e: unknown) {
    const err = e as { stdout?: string; message?: string };
    try {
      const report = JSON.parse((err.stdout ?? "").slice((err.stdout ?? "").indexOf("{")));
      passed = report.stats?.expected ?? 0;
      failed = (report.stats?.unexpected ?? 0) + (report.stats?.flaky ?? 0);
      detail = report.errors?.[0]?.message ?? "";
    } catch {
      detail = (err.message ?? String(e)).slice(0, 400);
      failed = failed || 1;
    }
  }

  // A trace or screenshot is the whole reason a failing web test is
  // debuggable later, so upload whatever Playwright left behind.
  // Playwright puts trace.zip, the failure screenshot and error-context.md in a
  // per-test SUBDIRECTORY, not at the top level. A flat readdir here uploads
  // .last-run.json and silently loses everything that makes a red suite
  // debuggable, so walk the tree and name each file by its relative path.
  const artifacts: string[] = [];
  const walk = (dir: string, rel: string) => {
    const found: { file: string; name: string }[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) found.push(...walk(abs, r));
      else if (e.isFile()) found.push({ file: abs, name: r });
    }
    return found;
  };
  for (const f of (existsSync(out) ? walk(out, "") : [])) {
    artifacts.push(await uploadArtifact(f.file, `${job.job_id}-${f.name.replace(/\//g, "_")}`));
  }

  await postResult({
    job_id: job.job_id, device_id: deviceId, iter: 0,
    ok, test: { passed, failed, artifacts },
    error: ok ? undefined : detail || `${failed} failing`,
  });
  log(`web-test ${url} (${browser}): ${passed} passed / ${failed} failed in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  await postResult({ job_id: job.job_id, device_id: `host:${NAME}`, iter: 0, final: true, ok });
}

/**
 * Describe an attached device well enough to target it.
 *
 * Match expressions are evaluated against a descriptor, so a device registered
 * without one can never be selected by `os ~ 'android'` -- it would show up on
 * the dashboard and silently never be given work.
 */
async function describeTarget(
  t: Target,
  sims: Record<string, { udid: string; name: string }[]> | null,
  ios: IosDeviceInfo[] | null,
): Promise<Record<string, unknown>> {
  if (t.platform === "android") {
    const prop = async (k: string) => {
      try {
        return (await exec(ADB, ["-s", t.id, "shell", "getprop", k], { timeout: 10_000 })).stdout.trim();
      } catch {
        return "";
      }
    };
    const [model, release, memKb] = await Promise.all([
      prop("ro.product.model"),
      prop("ro.build.version.release"),
      (async () => {
        try {
          const out = (await exec(ADB, ["-s", t.id, "shell", "cat", "/proc/meminfo"], { timeout: 10_000 })).stdout;
          return Number(/MemTotal:\s+(\d+)/.exec(out)?.[1] ?? 0);
        } catch {
          return 0;
        }
      })(),
    ]);
    return {
      model: model || t.id,
      os: release ? `android-${release}` : "android",
      ...(memKb ? { ram_mb: Math.round(memKb / 1024) } : {}),
      serial: t.id,
      attached_to: NAME,
      kind: t.kind,
    };
  }
  // iOS: ask simctl what this UDID actually is. A descriptor of
  // {model: "simulator", os: "ios"} would register the device but leave it
  // untargetable -- `os ~ 'ios-18'` matches nothing without the version, and
  // every simulator would look identical on the dashboard.
  try {
    for (const [runtime, list] of Object.entries(sims ?? {})) {
      const hit = list.find((d) => d.udid === t.id);
      if (!hit) continue;
      // "com.apple.CoreSimulator.SimRuntime.iOS-18-4" -> "ios-18.4"
      const v = /iOS-([\d-]+)$/.exec(runtime)?.[1]?.replace(/-/g, ".");
      return {
        model: hit.name,
        os: v ? `ios-${v}` : "ios",
        serial: t.id,
        attached_to: NAME,
        // simctl knows it, so it is a simulator whichever enumerator found it.
        kind: "simulator",
        // Belt and braces for isSimulator(), which reads model/os/soc: a
        // simulator that slips past that check lands in a hardware comparison,
        // which is the one thing the flag exists to prevent.
        soc: "simulator",
      };
    }
  } catch {
    // simctl changed its output shape.
  }

  // Physical hardware. `{model: "iphone", os: "ios"}` would register the phone
  // and leave it untargetable -- `os ~ 'ios-18'` matches nothing without the
  // version, and every iPhone on the shelf would look identical.
  const info = (ios ?? []).find((d) => d.identifier === t.id);
  if (info) {
    return {
      model: info.marketingName ?? info.name ?? "iphone",
      os: info.osVersion ? `ios-${info.osVersion}` : "ios",
      ...(info.productType ? { soc: info.productType } : {}),
      serial: t.id,
      attached_to: NAME,
      kind: "device",
    };
  }
  return { model: t.kind === "simulator" ? "simulator" : "iphone", os: "ios", serial: t.id, attached_to: NAME, kind: t.kind };
}

/**
 * Register the devices attached to this host, so the fleet knows they exist.
 *
 * A phone driven over adb never speaks to the collector itself: it has no
 * runner app polling, so nothing registers it and nothing refreshes its
 * last_seen. The result was a dashboard where the entire shelf read `offline`
 * however many phones were actually cabled up, and where host-driven results
 * were filed against serial numbers that had no device row at all.
 *
 * Best effort by design -- presence must never be the reason an executor stops
 * claiming work, so failures here are swallowed.
 */
/**
 * The virtual device name behind this target, or null if it is real hardware.
 *
 * Android emulators are resolved over adb because the serial (`emulator-5554`)
 * says nothing about which AVD it is -- the Xcode Mac was running one called
 * `jerv-test`, which has no business taking nightly work.
 */
async function virtualNameOf(
  t: Target,
  sims: Record<string, { udid: string; name: string }[]> | null,
): Promise<string | null> {
  if (t.platform === "ios") return simulatorName(t.id, sims);
  if (!isAndroidEmulatorSerial(t.id)) return null; // a cabled phone
  try {
    const { stdout } = await exec(ADB, ["-s", t.id, "emu", "avd", "name"], { timeout: 10_000 });
    // `adb emu` answers with the value then a trailing OK line.
    return stdout.split("\n").map((l) => l.trim()).filter((l) => l && l !== "OK")[0] ?? t.id;
  } catch {
    // Unreachable emulators cannot be identified, so they do not get in.
    return t.id;
  }
}

// Devices we have already complained about, so a permanently-paired phone
// does not print the same line every minute.
const announcedIos = new Set<string>();

let reporting = false;

async function reportAttached() {
  // Per-device work is bounded only by timeouts -- 10s per adb getprop against
  // a wedged phone -- so a sweep can outlast the interval that scheduled it.
  // Without this guard those runs overlap and compound adb contention against
  // a device an actual job may be driving.
  if (reporting) return;
  reporting = true;
  try {
    // One listing per sweep of each kind, not one per device. devicectl in
    // particular takes seconds and has a 30s timeout, so re-running it per
    // target is how a sweep starts outlasting the interval that scheduled it.
    const ios = await devicectlDevices();
    // A phone that is paired but whose tunnel is down is invisible to the
    // fleet and looks identical to one that was never plugged in. Say so
    // once, so onboarding a device is diagnosable instead of silent.
    for (const d of ios) {
      if (d.platform !== "iOS" || d.transport === "sameMachine") continue;
      if (physicalIos([d]).length > 0) continue; // it is in; nothing to report
      const key = `${d.identifier}:${d.tunnelState}`;
      if (announcedIos.has(key)) continue;
      announcedIos.add(key);
      log(
        `${d.marketingName ?? d.name ?? d.identifier} is paired but not reachable ` +
        `(transport=${d.transport}, tunnel=${d.tunnelState}) -- unlock it, trust this Mac, ` +
        "and check Developer Mode is on",
      );
    }
    let targets: Target[] = [];
    try {
      targets = await listTargets(ios);
    } catch {
      return;
    }

    let sims: Record<string, { udid: string; name: string }[]> | null = null;
    if (targets.some((t) => t.platform === "ios")) {
      try {
        const { stdout } = await exec("xcrun", ["simctl", "list", "devices", "-j"], { timeout: 20_000 });
        sims = (JSON.parse(stdout) as { devices: Record<string, { udid: string; name: string }[]> }).devices;
      } catch {
        sims = null; // no Xcode tooling; describeTarget falls back
      }
    }

    // devicectl and simctl can both report the same UDID, so without this the
    // device is registered twice a sweep with a different `kind` each time.
    const seen = new Set<string>();
    for (const t of targets) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      if (!fleetOwned(await virtualNameOf(t, sims))) continue;
      try {
        await fetch(`${BASE}/devices/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ device_id: t.id, descriptor: await describeTarget(t, sims, ios), pools: [] }),
        });
      } catch {
        // Next tick will try again.
      }
    }
  } finally {
    reporting = false;
  }
}

async function main() {
  log(`polling ${BASE} (flows: ${FLOWS_DIR})`);
  // The dashboard calls a device online for ONLINE_S seconds after it was last
  // seen. Refreshing on a timer rather than per poll keeps presence steady
  // regardless of how long a long-poll blocks or how long a job runs.
  await reportAttached();
  setInterval(reportAttached, 60_000).unref();
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
      else if (job.workload === "web-test") await runWebTest(job);
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
