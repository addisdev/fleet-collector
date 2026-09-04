// Host executor: claims executor:"host" jobs and drives attached Android
// devices from outside via adb + Maestro. Runs on the Mac next to the
// collector (iOS support arrives in Phase 3 via devicectl/XCUITest).
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import {
  exec, BASE, NAME, log, postResult, postBeacon, fetchArtifact, uploadArtifact,
  leaseBudgetS,
} from "./fleet-client.js";
import { runWebUnfurl } from "./web/unfurl.js";
import { runWebAudit } from "./web/audit.js";
import { runArchive } from "./web/archive/index.js";
import { runDigest } from "./web/digest.js";
import { countXcodebuildTests, xcodebuildDiagnostics } from "./xcparse.js";
import {
  fleetOwned, physicalIos, simulatorName, isAndroidEmulatorSerial, iosNotReadyReason,
  adbFailureIsWorthReporting, SIM_PREFIX,
  type IosDeviceInfo,
} from "./targets.js";
import { evalMatch } from "./match.js";
import { keychainPassword, redact, KEYCHAIN_SERVICE } from "./secrets.js";
import { parseAmStart, amStartProblem } from "./am-start.js";
import { withNetwork, withNetworkAll, restoreAttached } from "./network-shape.js";

const FLOWS_DIR = process.env.FLEET_FLOWS_DIR ?? path.resolve("flows");
const MAESTRO = process.env.MAESTRO_BIN ?? path.join(os.homedir(), ".maestro/bin/maestro");
const ADB = process.env.ADB_BIN ?? "adb";

export type Job = {
  job_id: string;
  workload: string;
  // ML workloads name the model artifact; digest forwards it into the batch
  // jobs it enqueues.
  model?: Record<string, unknown>;
  app?: { name: string; build: string; sha256: string; platform?: "android" | "ios" };
  suite?: {
    kind: string; flows?: string; app_id?: string; asserts?: string[];
    // An app repo running its OWN XCUITest suite rather than the generic
    // FleetRunner bundle: which project, which scheme, which tests.
    project?: string; scheme?: string; only?: string;
    // How the suite signs in. NAMES only -- the account (an email, not a
    // secret) and which env vars the suite reads. The password is resolved on
    // the executor host and never travels in a job spec, because specs are
    // stored, served by the API and rendered on the dashboard.
    credentials?: { account: string; email_var?: string; password_var?: string };
    // TCC permissions to pre-grant on simulator targets before the tests run
    // (`xcrun simctl privacy grant <service> <bundle>`). A permission dialog a
    // suite does not handle is worse than a failure: it sits on the shared
    // simulator blocking every job after this one. `service` is whatever
    // simctl accepts (location, location-always, photos, ...); `bundle_id`
    // defaults to the suite's app_id. Simulators only -- a physical device has
    // no simctl, so a suite that runs on devices still needs an interruption
    // monitor.
    permissions?: { service: string; bundle_id?: string }[];
  };
  targets?: {
    pool?: string; exclusive?: boolean; executor?: string; url?: string;
    // Honoured HERE as well as at claim time -- see selectTargets.
    match?: string; device_id?: string; device_kind?: "device" | "simulator";
  };
  params?: Record<string, unknown>;
  lease?: { ttl_s?: number };
};

// The generic XCUITest bundle lives in the iOS runner repo; one scheme tests
// any app via TEST_RUNNER_-passed env (FLEET_APP_ID / FLEET_ASSERTS).
const WEB_SPECS_DIR = process.env.FLEET_WEB_SPECS_DIR ?? path.resolve("web-specs");

const IOS_PROJECT = process.env.FLEET_IOS_PROJECT ??
  path.resolve("../fleet-runner-ios/FleetRunner.xcodeproj");

type Target = { id: string; platform: "android" | "ios"; kind?: "device" | "simulator" };

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

/**
 * Android serials, or none on a host with no Android SDK.
 *
 * The `catch` is the point. This used to throw ENOENT on a Mac without adb,
 * listTargets propagated it, and reportAttached's catch swallowed it -- so an
 * iOS-only host registered NOTHING, silently, including the iPhone cabled to
 * it. bootedSimulators and devicectlDevices have always tolerated their
 * tooling being absent; this was the one that did not, and it went unnoticed
 * because every host so far happened to have adb.
 */
let adbComplaint = "";

async function adbDevices(): Promise<string[]> {
  let stdout: string;
  try {
    ({ stdout } = await exec(ADB, ["devices"]));
    adbComplaint = "";
  } catch (e) {
    const err = e as { code?: string; stderr?: string; message?: string };
    // ENOENT is the iOS-only host this function exists for: no adb, no Android
    // devices, nothing to say. Anything else means adb IS here and is failing
    // -- a version-mismatched daemon, a dead server -- and returning [] for
    // that silently empties the whole Android shelf. Every cabled phone reads
    // offline, and jobs fail with "no android targets matched this job", which
    // sends you looking at match expressions instead of at adb.
    if (adbFailureIsWorthReporting(err.code)) {
      const why = (err.stderr ?? err.message ?? "unknown").trim().split("\n")[0].slice(0, 160);
      // Once per distinct complaint: this runs every 60s and a permanently
      // broken adb would otherwise fill the log.
      if (why !== adbComplaint) {
        adbComplaint = why;
        log(`adb is present but failing, so no Android devices are visible: ${why}`);
      }
    }
    return [];
  }
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

async function runInstall(job: Job) {
  const app = job.app;
  if (!app) throw new Error("install job needs an app ref");
  const platform = app.platform ?? "android";
  const targets = await selectTargets(job, (await listTargets()).filter((t) => t.platform === platform));
  if (targets.length === 0) throw new Error(`no ${platform} targets matched this job`);

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


/** Is this target one the fleet may run work on? Presence and jobs must agree. */
async function fleetOwnedTarget(
  t: Target,
  sims: Record<string, { udid: string; name: string }[]> | null,
): Promise<boolean> {
  return fleetOwned(await virtualNameOf(t, sims));
}

/** The simctl device map, or null when there is no Xcode tooling here. */
async function simctlDevices(): Promise<Record<string, { udid: string; name: string }[]> | null> {
  try {
    const { stdout } = await exec("xcrun", ["simctl", "list", "devices", "-j"], { timeout: 20_000 });
    return (JSON.parse(stdout) as { devices: Record<string, { udid: string; name: string }[]> }).devices;
  } catch {
    return null;
  }
}

/**
 * Narrow the attached targets to the ones this job actually asked for.
 *
 * `targets.match` used to gate only which EXECUTOR claimed a job; once claimed,
 * the executor ran on everything it could see. That was invisible while the
 * Xcode Mac had a single simulator. It stopped being invisible the moment the
 * fleet held an iOS 27 simulator and an iOS 18.7 phone at once: a job asking
 * for `os ~ 'ios-18'` would claim correctly and then run on both, and a nightly
 * meant for real hardware would quietly report simulator results as well.
 *
 * The same expression now means the same thing in both places, evaluated
 * against the same descriptor the collector holds.
 *
 * `device_kind` is the blunt instrument for the common case -- "real hardware,
 * whatever it is" -- which no descriptor field expresses honestly, because
 * `kind` is a property of how the device is attached rather than of the device.
 */
async function selectTargets(job: Job, all: Target[]): Promise<Target[]> {
  const t = job.targets ?? {};
  let out = all;

  // Cheap, pure filters first. They are array operations; membership has to
  // interrogate each survivor -- `adb emu avd name` per emulator, 10s timeout
  // apiece -- so narrowing before asking means a pinned job never pays to
  // identify devices it had already excluded.
  if (t.device_id) out = out.filter((x) => x.id === t.device_id);
  if (t.device_kind) out = out.filter((x) => x.kind === t.device_kind);

  // Membership, which was missing entirely. fleetOwned gated only PRESENCE --
  // a scratch simulator could not join the device list, but a job still ran on
  // it, because selection never asked. Observed: an aliquant suite pinned to
  // simulators ran on `fleet-sim-1` AND a stray `iPhone 17` somebody had
  // booted, reporting both. "It cannot be registered" and "it cannot be given
  // work" are different claims.
  {
    const sims = out.some((x) => x.platform === "ios") ? await simctlDevices() : null;
    const owned: Target[] = [];
    const rejected: string[] = [];
    for (const target of out) {
      if (await fleetOwnedTarget(target, sims)) owned.push(target);
      else rejected.push(target.id);
    }
    // Say so. Otherwise the caller throws "no targets matched this job", which
    // sends an operator to their match expression -- and the device is absent
    // from the dashboard too, because presence is gated by the same rule, so
    // there is nothing anywhere that names the actual reason.
    if (rejected.length > 0) {
      log(
        `ignoring ${rejected.length} attached device(s) that are not in the fleet ` +
        `(a virtual device joins by being named "${SIM_PREFIX}…"): ${rejected.join(", ")}`,
      );
    }
    out = owned;
  }

  if (t.match) {
    // Descriptors cost adb, simctl and devicectl calls, so nothing is queried
    // unless a match expression actually needs one.
    const sims = await simctlDevices();
    const ios = out.some((x) => x.platform === "ios") ? await devicectlDevices() : null;
    const kept: Target[] = [];
    for (const target of out) {
      const d = await describeTarget(target, sims, ios);
      try {
        if (evalMatch(t.match, d as Record<string, unknown>)) kept.push(target);
      } catch (e) {
        // A malformed expression must not silently select everything.
        throw new Error(`targets.match is invalid: ${(e as Error).message}`);
      }
    }
    out = kept;
  }
  return out;
}


/**
 * Resolve a suite's sign-in details, or explain precisely why it cannot.
 *
 * Shared by both UI-test paths. It used to live only in the XCUITest branch,
 * which meant a Maestro job could set `suite.credentials`, have the collector
 * accept it, and get no sign-in and no error -- the field looked like it should
 * work and silently did nothing, which is the same green-but-vacuous failure
 * this whole mechanism exists to remove.
 */
async function resolveCredentials(suite: NonNullable<Job["suite"]>, who: string): Promise<{
  account: string; password: string; emailVar: string; passwordVar: string;
} | null> {
  const cred = suite.credentials;
  if (!cred?.account) return null;
  const got = await keychainPassword(cred.account);
  if (!got.ok) {
    throw new Error(
      got.reason === "missing"
        ? `no Keychain item for ${cred.account} (service "${KEYCHAIN_SERVICE}") on ${who}; add one with: ` +
          `security add-generic-password -s ${KEYCHAIN_SERVICE} -a ${cred.account} -w`
        : `the Keychain item for ${cred.account} exists on ${who} but could not be read (${got.detail}); ` +
          "the login keychain is locked, or this agent is not allowed to read it",
    );
  }
  log(`signing in as ${cred.account} (password from the ${who} Keychain)`);
  return {
    account: cred.account,
    password: got.password,
    emailVar: cred.email_var ?? "GREENFOLIO_TEST_EMAIL",
    passwordVar: cred.password_var ?? "GREENFOLIO_TEST_PASSWORD",
  };
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

  // Sign-in details, resolved HERE and nowhere else. A suite that needs an
  // account skips every test that touches one -- greenfolio's skips 8 of 12 --
  // so this is the difference between a nightly that tests the app and a
  // nightly that tests that the app launches.
  const creds = await resolveCredentials(suite, NAME);

  // Resolved before the loop so a spec that cannot name a bundle fails the
  // job with one clear message instead of failing per-target.
  const perms = (suite.permissions ?? []).map((p) => {
    const bundle = p.bundle_id ?? appId;
    if (!bundle) throw new Error(`suite.permissions entry "${p.service}" needs a bundle_id (this suite has no app_id)`);
    return { service: p.service, bundle };
  });

  const targets = await selectTargets(job, (await listTargets()).filter((t) => t.platform === "ios"));
  if (targets.length === 0) throw new Error("no iOS targets matched this job");

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
      if (target.kind !== "simulator") {
        log(`provisioning updates allowed for ${target.id} (may register it with the Apple team)`);
      }
      // Pre-grant TCC permissions so no system dialog ever appears. The grant
      // is recorded by bundle id whether or not the app is installed yet, so
      // it works for own-project suites that install during the test action.
      // A grant that fails means the dialog WILL appear and the suite WILL
      // hang on it -- and worse, the dialog outlives the job on a shared
      // simulator -- so a failed grant fails this target rather than running.
      if (perms.length > 0 && target.kind === "simulator") {
        let grantError = "";
        for (const p of perms) {
          try {
            await exec("xcrun", ["simctl", "privacy", target.id, "grant", p.service, p.bundle], { timeout: 30_000 });
            log(`granted ${p.service} to ${p.bundle} on ${target.id}`);
          } catch (e) {
            grantError = `simctl privacy grant ${p.service} ${p.bundle} failed: ` +
              (((e as { stderr?: string }).stderr ?? (e as Error).message) || "unknown error").trim().slice(-500);
            break;
          }
        }
        if (grantError) {
          allOk = false;
          await postResult({ job_id: job.job_id, device_id: target.id, iter: 0, ok: false, error: grantError });
          log(`xcuitest on ${target.id}: ${grantError}`);
          continue;
        }
      } else if (perms.length > 0) {
        // No simctl for hardware; the suite must handle the dialog itself.
        log(`permissions not pre-granted on ${target.id} (physical device; needs an interruption monitor)`);
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
           // A physical device needs a provisioning profile that lists it, and
           // without this xcodebuild refuses rather than fetching one -- "No
           // profiles for 'com.example' were found". Simulators are unsigned,
           // so it costs them nothing.
           //
           // It authorises xcodebuild to MUTATE the developer portal, not just
           // read it: an unrecognised device gets registered, consuming one of
           // the team's 100 slots, which Apple resets only at renewal. That is
           // a real side effect for a job running unattended at 02:30, so the
           // log below records which device it was passed for.
           ...(target.kind === "simulator" ? [] : ["-allowProvisioningUpdates"]),
           ...(only ? [`-only-testing:${only}`] : [])],
          {
            timeout: Number(job.params?.timeout_s ?? 1800) * 1000,
            env: {
              ...process.env,
              ...(appId ? { TEST_RUNNER_FLEET_APP_ID: appId } : {}),
              ...(asserts ? { TEST_RUNNER_FLEET_ASSERTS: asserts } : {}),
              // TEST_RUNNER_ is the prefix xcodebuild strips before handing the
              // variable to the test runner process -- which is where
              // ProcessInfo.processInfo.environment is read, and from there the
              // suite forwards it into the app's launchEnvironment.
              ...(creds
                ? {
                    [`TEST_RUNNER_${creds.emailVar}`]: creds.account,
                    [`TEST_RUNNER_${creds.passwordVar}`]: creds.password,
                  }
                : {}),
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
      // Scrub before ANY of this becomes an artifact. xcodebuild echoes its
      // environment in places, and the log is downloadable from the dashboard,
      // so a password that reaches the store has leaked however carefully it
      // was fetched.
      const secrets = creds ? [creds.password] : [];
      full = redact(full, secrets);
      logTail = redact(logTail, secrets);
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

  // Maestro takes `-e KEY=value` and a flow reads it as ${KEY}, which is how a
  // flow types into a login form. Same Keychain, same rule: the job names the
  // account, the password never leaves this host.
  const creds = await resolveCredentials(suite, NAME);

  const targets = await selectTargets(job, await listTargets());
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
    // params.network, when the job carries one, is applied around the flow run
    // and restored afterwards whatever happens inside it. A profile that cannot
    // be applied fails the device's row by name rather than running the flow
    // unshaped — an offline suite that quietly ran online is a pass that proves
    // nothing.
    let shapeError: string | undefined;
    try {
      await withNetwork(job, target, async () => {
        try {
          await exec(
            MAESTRO,
            ["--device", serial, "test", "--format", "junit", "--output", report,
             ...(appId ? ["-e", `APP_ID=${appId}`] : []),
             ...(creds
               ? ["-e", `${creds.emailVar}=${creds.account}`, "-e", `${creds.passwordVar}=${creds.password}`]
               : []),
             flows],
            { timeout: 600_000 },
          );
        } catch {
          // Non-zero exit also just means failing flows; the report tells the truth.
          failedToRun = !existsSync(report);
        }
      });
    } catch (e) {
      shapeError = (e as Error).message.slice(0, 300);
      failedToRun = true;
    }

    let passed = 0;
    let failed = 1;
    const artifacts: string[] = [];
    if (!failedToRun && existsSync(report)) {
      const xml = readFileSync(report, "utf8");
      ({ passed, failed } = parseJunit(xml));
      // Scrub before upload: a failing step echoes the command it ran, and the
      // report is downloadable from the dashboard.
      if (creds) writeFileSync(report, redact(xml, [creds.password]));
      artifacts.push(await uploadArtifact(report, `${job.job_id}-${serial}-junit.xml`));
    }
    if (failed > 0) allOk = false;
    await postResult({
      job_id: job.job_id, device_id: serial, iter: 0,
      ok: failed === 0, test: { passed, failed, artifacts },
      ...(shapeError ? { error: `params.network: ${shapeError}` } : {}),
    });
    log(`ui-test on ${serial}: ${passed} passed / ${failed} failed${shapeError ? ` (network shaping: ${shapeError})` : ""}`);
  }
  } finally {
    if (granted) await releaseLocks(job.job_id);
  }
  await postResult({ job_id: job.job_id, device_id: `host:${NAME}`, iter: 0, final: true, ok: allOk });
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
  const targets = await selectTargets(job, (await listTargets()).filter((t) => t.platform === platform));
  if (targets.length === 0) throw new Error(`no ${platform} targets matched this job`);

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
  let allOk = true;
  // params.network wraps the sampling window rather than the whole job: the app
  // is already up when shaping starts, so `offline-after-<n>s` measures what it
  // is for — an app that loses the network while running — instead of one that
  // never had it. Restored on every exit path, including a throw mid-run.
  //
  // Worth knowing before pointing an offline profile at a drain job: this
  // executor drives the device over adb, and taking a wifi-attached device
  // offline would cut its own control channel. network-shape refuses that case
  // outright rather than stranding the device.
  await withNetworkAll(job, eligible, async () => {
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
  });
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
  const targets = await selectTargets(job, (await listTargets()).filter((t) => t.platform === platform));
  if (targets.length === 0) throw new Error(`no ${platform} targets matched this job`);

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

const LAUNCH_STATES = ["cold", "warm", "hot"] as const;
type LaunchState = (typeof LAUNCH_STATES)[number];

/** The launcher activity `am start -n` needs, resolved the same way launchApp does. */
async function androidLaunchComponent(target: Target, appId: string): Promise<string> {
  const { stdout } = await exec(
    ADB, ["-s", target.id, "shell", "cmd", "package", "resolve-activity", "--brief", appId],
    { timeout: 15_000 },
  );
  const component = stdout.replace(/\r/g, "").trim().split("\n").pop()?.trim();
  if (!component || !component.includes("/")) {
    throw new Error(`no launcher activity for ${appId}: ${stdout.trim().slice(0, 160)}`);
  }
  return component;
}

/**
 * Put the app into `state`, then launch it once and ask the framework how long
 * that took.
 *
 * The three states are three different pieces of choreography, and the
 * difference between them is the whole measurement:
 *
 *   cold -- force-stop first, so the process is gone and Android builds it from
 *           nothing. This is the number a user feels after a reboot.
 *   warm -- launch again with the process still around. No force-stop, by
 *           definition: warm IS "the app is still in memory".
 *   hot  -- HOME first, so the activity is merely backgrounded, then return to
 *           it. The cheapest launch there is.
 *
 * `am start -W` blocks until the activity reports it is displayed and prints
 * TotalTime, which is the framework's own time-to-first-frame. That is why this
 * path exists and the iOS ones below do not: nothing in simctl or devicectl
 * answers the same question.
 */
async function androidLaunchOnce(target: Target, component: string, appId: string, state: LaunchState) {
  if (state === "cold") {
    await exec(ADB, ["-s", target.id, "shell", "am", "force-stop", appId], { timeout: 20_000 });
    // Force-stop returns before the process is reaped; measuring into that
    // window times a launch that is still racing the teardown.
    await new Promise((r) => setTimeout(r, 800));
  } else if (state === "hot") {
    await exec(ADB, ["-s", target.id, "shell", "input", "keyevent", "KEYCODE_HOME"], { timeout: 20_000 });
    await new Promise((r) => setTimeout(r, 1200));
  }
  const { stdout } = await exec(
    ADB, ["-s", target.id, "shell", "am", "start", "-W", "-n", component],
    { timeout: 90_000 },
  );
  return parseAmStart(stdout);
}

/**
 * cold-start: how long the app takes to put its first frame on screen, N times
 * over, in each launch state.
 *
 * One result row per launch — never a pre-averaged one. The collector computes
 * p50 and p95 from the rows, split by launch_state, because a percentile mixing
 * cold and hot launches describes nothing that ever happens to a person holding
 * the phone.
 *
 * Android is the only platform this can measure honestly, and that is a
 * statement about the tooling rather than about the app:
 *
 *   Android      -- `am start -W` reports TotalTime, the framework's own
 *                   time-to-first-frame. Real measurement.
 *   iOS simulator-- `simctl launch` returns once the process is SPAWNED. That
 *                   is not time to first frame, it is a much smaller number
 *                   that would sit in a field documented as time to first
 *                   frame and be read as one. Reported as a failed row naming
 *                   the limitation.
 *   iOS device   -- devicectl has the same gap and one more: no force-stop by
 *                   bundle id, so the cold state cannot even be established.
 *
 * The honest iOS path is on-device (XCTApplicationLaunchMetric in an XCUITest
 * run, or the runner app reporting its own first frame) — it needs a runner
 * change in another repo, not a number invented here.
 */
async function runColdStart(job: Job) {
  const appId = (job.params?.app_id as string | undefined) ?? job.suite?.app_id;
  if (!appId) throw new Error("cold-start job needs params.app_id");
  const launches = Math.max(1, Number(job.params?.launches ?? 10));
  const asked = job.params?.states;
  const states = (Array.isArray(asked) ? asked.map(String) : [...LAUNCH_STATES]) as LaunchState[];
  for (const s of states) {
    if (!LAUNCH_STATES.includes(s)) {
      throw new Error(`params.states has ${JSON.stringify(s)}; launch states are ${LAUNCH_STATES.join(", ")}`);
    }
  }
  if (states.length === 0) throw new Error("params.states is empty; nothing to measure");

  const platform = job.app?.platform ?? "android";
  const targets = await selectTargets(job, (await listTargets()).filter((t) => t.platform === platform));
  if (targets.length === 0) throw new Error(`no ${platform} targets matched this job`);

  let allOk = true;
  for (const target of targets) {
    // iOS, both kinds: say what is missing and stop. A spawn time filed as
    // launch_ms would be indistinguishable downstream from an Android
    // time-to-first-frame, and every comparison drawn from the pair would be
    // wrong in the app's favour.
    if (target.platform === "ios") {
      allOk = false;
      const why = target.kind === "device"
        ? "devicectl cannot time an iOS device's first frame (and cannot force-stop by bundle id, " +
          "so the cold state cannot be established); measure it on-device with XCTApplicationLaunchMetric"
        : "simctl launch returns when the process is spawned, not when the first frame is presented, " +
          "so there is no honest time-to-first-frame here; measure it with XCTApplicationLaunchMetric in a ui-test job";
      await postResult({ job_id: job.job_id, device_id: target.id, iter: 0, ok: false, error: why });
      log(`cold-start on ${target.id}: unsupported — ${why}`);
      continue;
    }

    if (!(await hasApp(target, appId))) {
      await postResult({ job_id: job.job_id, device_id: target.id, iter: 0, ok: true, error: `skipped: ${appId} not installed` });
      log(`cold-start on ${target.id}: skipped (${appId} not installed)`);
      continue;
    }

    let component: string;
    try {
      component = await androidLaunchComponent(target, appId);
    } catch (e) {
      allOk = false;
      await postResult({ job_id: job.job_id, device_id: target.id, iter: 0, ok: false, error: (e as Error).message.slice(0, 300) });
      log(`cold-start on ${target.id}: ${(e as Error).message}`);
      continue;
    }

    let iter = 0;
    for (const state of states) {
      // The lease is renewed per state, not per job: ten launches of a heavy
      // app in three states outlives a default lease comfortably, and a swept
      // job would be re-claimed and re-run on the same phone.
      await postBeacon(job.job_id, target.id, {}).catch(() => {});

      // One discarded warm-up launch per state, and it is not optional. Each
      // state is defined by what the OS is holding when the launch starts, and
      // the launch before the first measured one is what puts it there: the
      // first "warm" launch after a cold start would otherwise be measured
      // against a process that was never warm, and the first launch of the run
      // as a whole carries one-time work (dexopt, first-run migrations) that no
      // user pays twice.
      try {
        await androidLaunchOnce(target, component, appId, state);
      } catch (e) {
        allOk = false;
        iter += 1;
        await postResult({
          job_id: job.job_id, device_id: target.id, iter, ok: false,
          error: `${state} warm-up launch failed: ${(e as Error).message.slice(0, 240)}`,
        });
        log(`cold-start ${appId} on ${target.id}: ${state} warm-up failed, skipping the state`);
        continue;
      }

      const measured: number[] = [];
      for (let i = 0; i < launches; i++) {
        iter += 1;
        let parsed;
        try {
          parsed = await androidLaunchOnce(target, component, appId, state);
        } catch (e) {
          allOk = false;
          await postResult({
            job_id: job.job_id, device_id: target.id, iter, ok: false,
            error: `${state} launch ${i + 1} failed: ${(e as Error).message.slice(0, 240)}`,
          });
          continue;
        }
        const problem = amStartProblem(parsed);
        if (problem || parsed.totalMs === null) {
          allOk = false;
          await postResult({
            job_id: job.job_id, device_id: target.id, iter, ok: false,
            error: `${state} launch ${i + 1}: ${problem ?? "no TotalTime"}`,
          });
          continue;
        }
        // LaunchState (Android 10+) is the framework's verdict on what that
        // launch actually was, and it beats our choreography's intent: a
        // force-stopped app the OS still had warm really did launch warm, and
        // filing it as cold is how a p95 stops meaning anything. When the
        // platform is too old to say, the state we drove is the best available.
        const reported = parsed.launchState ?? state;
        if (parsed.launchState && parsed.launchState !== state) {
          log(`cold-start ${appId} on ${target.id}: asked for ${state}, the framework reported ${parsed.launchState} — filing it as ${parsed.launchState}`);
        }
        measured.push(parsed.totalMs);
        await postResult({
          job_id: job.job_id, device_id: target.id, iter, ok: true,
          metrics: { launch_ms: parsed.totalMs, launch_state: reported },
        });
      }
      const mean = measured.length > 0 ? Math.round(measured.reduce((a, b) => a + b, 0) / measured.length) : null;
      log(`cold-start ${appId} on ${target.id}: ${state} — ${measured.length}/${launches} launches, mean ${mean ?? "?"} ms`);
    }
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

  // Which config projects to run: one name, an array run in sequence, or "all".
  // "all" asks Playwright for the resolved config rather than keeping a copy of
  // the project names here — a copy is how a project added to the config would
  // silently never run in the nightly that exists to run everything.
  const asked = job.params?.browser ?? "chromium";
  const projects = asked === "all"
    ? await listWebProjects()
    : (Array.isArray(asked) ? asked.map(String) : [String(asked)]);
  if (projects.length === 0) throw new Error("params.browser named no projects");

  // Nothing beacons DURING a single project's run, so each one must finish
  // inside the lease or the sweep requeues a job that is still running and a
  // second executor runs the same suite concurrently. Between projects a
  // beacon renews the lease, which is what lets a matrix of N projects run on
  // the same lease one project needs. next-job reports the lease the collector
  // granted. Stop a little short of it so a timing-out run reports its own
  // failure rather than being swept mid-flight and silently re-run by whoever
  // claims it next.
  const timeoutS = leaseBudgetS(job);

  let allOk = true;
  for (const [i, project] of projects.entries()) {
    if (i > 0) await postBeacon(job.job_id, `web:${project}`, {}).catch(() => {});
    const ok = await runWebProject(job, url, specDir, project, timeoutS);
    if (!ok) allOk = false;
  }
  await postResult({ job_id: job.job_id, device_id: `host:${NAME}`, iter: 0, final: true, ok: allOk });
}

/** Every file under dir, named by its path relative to dir. */
function walkFiles(dir: string, rel: string): { file: string; name: string }[] {
  const found: { file: string; name: string }[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) found.push(...walkFiles(abs, r));
    else if (e.isFile()) found.push({ file: abs, name: r });
  }
  return found;
}

/** The project names playwright.config.ts resolves to, via --list. */
async function listWebProjects(): Promise<string[]> {
  const { stdout } = await exec("npx", ["playwright", "test", "--list", "--reporter=json"], {
    timeout: 120_000,
    env: { ...process.env, CI: "1" },
    maxBuffer: 64 * 1024 * 1024,
  });
  const report = JSON.parse(stdout.slice(stdout.indexOf("{"))) as {
    config?: { projects?: { name?: string }[] };
  };
  const names = [...new Set((report.config?.projects ?? []).map((p) => p.name ?? "").filter(Boolean))];
  if (names.length === 0) throw new Error("playwright --list reported no projects");
  return names;
}

/** One config project against the URL; posts its own result row. */
async function runWebProject(
  job: Job, url: string, specDir: string, project: string, timeoutS: number,
): Promise<boolean> {
  const deviceId = `web:${project}`;
  const out = mkdtempSync(path.join(os.tmpdir(), `web-${job.job_id}-${project}-`));

  const args = [
    "playwright", "test", specDir,
    `--project=${project}`,
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
  for (const f of (existsSync(out) ? walkFiles(out, "") : [])) {
    // The project is part of the name: two projects failing the same test
    // otherwise upload artifacts under identical names.
    artifacts.push(await uploadArtifact(f.file, `${job.job_id}-${project}-${f.name.replace(/\//g, "_")}`));
  }

  await postResult({
    job_id: job.job_id, device_id: deviceId, iter: 0,
    ok, test: { passed, failed, artifacts },
    error: ok ? undefined : detail || `${failed} failing`,
  });
  log(`web-test ${url} (${project}): ${passed} passed / ${failed} failed in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  return ok;
}

type ShotsManifest = {
  profiles?: string[];
  threshold_pct?: number;
  freeze_time?: string;
  pages?: {
    name?: string; path?: string; waitFor?: string; mask?: string[];
    fullPage?: boolean; threshold_pct?: number; settle_ms?: number;
  }[];
};

/**
 * A profile the matrix captures under. Most are playwright.config.ts project
 * names run via the _shots spec; two are meta-names that expand to real
 * hardware attached to THIS host:
 *
 *   "android-device"  -> one `android:<serial>` profile per fleet-owned
 *                        Android device, real Chrome driven over adb
 *   "ios-sim-safari"  -> one `ios-sim:<name>` profile per booted fleet-owned
 *                        simulator, Safari via simctl
 *
 * Expansion is per-device on purpose: two phones have two screens, so they
 * are two baselines — collapsing them under one profile would diff a Pixel
 * against an S21 and call the hardware difference a regression.
 *
 * `missing` marks a meta-name that expanded to nothing here: the profile the
 * manifest asked for cannot run on this host, and the run must say so rather
 * than quietly shrink. (Split device profiles into their own job pinned to
 * the executor whose shelf holds the hardware.)
 */
type WebProfile = {
  profile: string;
  target?: { kind: "android" | "ios-sim"; id: string };
  missing?: string;
};

async function expandWebProfiles(names: string[]): Promise<WebProfile[]> {
  const out: WebProfile[] = [];
  let all: Target[] | null = null;
  const targets = async () => (all ??= await listTargets());
  for (const name of names) {
    if (name === "android-device") {
      const owned: Target[] = [];
      for (const t of (await targets()).filter((t) => t.platform === "android")) {
        if (await fleetOwnedTarget(t, null)) owned.push(t);
      }
      if (owned.length === 0) out.push({ profile: name, missing: `no fleet-owned Android device attached to ${NAME}` });
      for (const t of owned) out.push({ profile: `android:${t.id}`, target: { kind: "android", id: t.id } });
    } else if (name === "ios-sim-safari") {
      const sims = await simctlDevices();
      const booted = (await targets()).filter((t) => t.platform === "ios" && t.kind === "simulator");
      let any = false;
      for (const t of booted) {
        const nm = simulatorName(t.id, sims);
        if (!fleetOwned(nm)) continue;
        any = true;
        out.push({ profile: `ios-sim:${nm ?? t.id}`, target: { kind: "ios-sim", id: t.id } });
      }
      if (!any) out.push({ profile: name, missing: `no booted fleet-owned simulator on ${NAME}` });
    } else {
      out.push({ profile: name });
    }
  }
  return out;
}

/** Reject after `s` seconds — device captures must not outlive the lease. */
function withTimeout<T>(p: Promise<T>, s: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} did not finish inside ${s}s`)), s * 1000).unref()),
  ]);
}

// Mirrors the CSS the _shots spec injects; the android path drives a Page
// directly, so it carries its own copy.
const KILL_MOTION_CSS =
  "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }";

/**
 * Real Chrome on a real (fleet-owned) Android device, via Playwright's
 * android support over adb. Same determinism steps as the _shots spec; the
 * PNGs land in the same layout, so the shared verdict/diff code downstream
 * never knows a phone was involved.
 *
 * Dynamic import: this executor also runs on hosts that will never capture,
 * and they should not pay to load playwright at startup.
 */
async function captureAndroidShots(
  serial: string, manifest: ShotsManifest, url: string, outDir: string,
): Promise<string> {
  const { _android } = await import("playwright");
  const devices = await _android.devices();
  const device = devices.find((d) => d.serial() === serial);
  if (!device) {
    for (const d of devices) await d.close().catch(() => {});
    throw new Error(`playwright's adb sees no device ${serial}`);
  }
  let detail = "";
  try {
    const context = await device.launchBrowser();
    try {
      const page = await context.newPage();
      if (manifest.freeze_time) await page.clock.setFixedTime(new Date(manifest.freeze_time));
      await page.emulateMedia({ reducedMotion: "reduce" });
      for (const p of manifest.pages ?? []) {
        try {
          await page.goto(new URL(p.path!, url).toString(), { waitUntil: "load", timeout: 30_000 });
          if (p.waitFor) await page.locator(p.waitFor).first().waitFor({ timeout: 15_000 });
          await page.addStyleTag({ content: KILL_MOTION_CSS });
          await page.evaluate(() => document.fonts.ready.then(() => undefined));
          await page.screenshot({
            path: path.join(outDir, `${p.name}.png`),
            fullPage: p.fullPage ?? true,
            animations: "disabled",
            mask: (p.mask ?? []).map((s) => page.locator(s)),
          });
        } catch (e) {
          // Leave the PNG absent; the per-page row downstream reports it. Keep
          // the first failure as the run's detail — later ones usually echo it.
          if (!detail) detail = (e as Error).message.slice(0, 200);
        }
      }
    } finally {
      await context.close().catch(() => {});
    }
  } finally {
    await device.close().catch(() => {});
    for (const d of devices) if (d !== device) await d.close().catch(() => {});
  }
  return detail;
}

/**
 * Safari on a booted fleet simulator: openurl, settle, screenshot. True
 * WebKit rendering with none of Playwright's control — no waitFor, no masks,
 * no fullPage, and Safari's own chrome is in frame. The status bar is pinned
 * (Apple's own 9:41, full battery) so the clock does not diff against itself
 * nightly; `settle_ms` per page stands in for waitFor.
 *
 * The simulator is shared state, and the capture inherits it: a system dialog
 * another job left up, or a "back to app" breadcrumb from whatever opened
 * Safari last, is in the shot. That is deliberate — dismissing a dialog some
 * suspended XCUITest is waiting on would break THAT job to prettify this one.
 * A polluted shot diffs red, a person sees why on the review grid, and the
 * fix is fleet hygiene, not capture cleverness.
 */
async function captureSimSafariShots(
  udid: string, manifest: ShotsManifest, url: string, outDir: string,
): Promise<string> {
  let detail = "";
  await exec("xcrun", ["simctl", "status_bar", udid, "override",
    "--time", "9:41", "--batteryState", "charged", "--batteryLevel", "100",
    "--wifiBars", "3", "--cellularBars", "4"], { timeout: 30_000 }).catch(() => {});
  try {
    // Cold-start warm-up. The first openurl may LAUNCH Safari, and a shot
    // taken on a per-page settle budget catches it mid-launch — observed as a
    // black screen where the page should be, accepted as a 97%-wrong
    // baseline. Open the first page and give the launch its own budget before
    // any capture; ready-and-idle is what makes the per-page settle honest.
    const first = manifest.pages?.[0];
    if (first) {
      await exec("xcrun", ["simctl", "openurl", udid, new URL(first.path!, url).toString()], { timeout: 30_000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 8000));
    }
    for (const p of manifest.pages ?? []) {
      try {
        await exec("xcrun", ["simctl", "openurl", udid, new URL(p.path!, url).toString()], { timeout: 30_000 });
        await new Promise((r) => setTimeout(r, p.settle_ms ?? 4000));
        await exec("xcrun", ["simctl", "io", udid, "screenshot", path.join(outDir, `${p.name}.png`)], { timeout: 30_000 });
      } catch (e) {
        if (!detail) detail = (e as Error).message.slice(0, 200);
      }
    }
  } finally {
    await exec("xcrun", ["simctl", "status_bar", udid, "clear"], { timeout: 30_000 }).catch(() => {});
  }
  return detail;
}

/**
 * web-shots: the screenshot half of the visual-regression matrix.
 *
 * Captures every page in the suite's shots.json under each requested config
 * project and uploads the PNGs. Capture only — baselines and diffing arrive
 * with the collector's baselines table (Phase 3), so today's rows say "these
 * pixels exist", not "these pixels are right".
 *
 * The actual browser work happens in web-specs/_shots/capture.spec.ts, run as
 * a Playwright test so `--project=` means exactly what it means for web-test.
 * Result shape follows drain: per-page rows at iter 1..N, a per-profile
 * summary at iter 0, and the host row closing the job.
 *
 * Each captured page is diffed against the accepted baseline the collector
 * holds for (suite, page, profile). Diffing happens HERE, on the one host that
 * captures, because a baseline is only comparable to pixels rendered by the
 * same machine — fonts and antialiasing differ across hosts, so moving the
 * capture host invalidates every baseline, and pretending the collector could
 * judge that would hide it. A page with no baseline reports ok with a note:
 * the first capture of a new page must not fail the nightly, but must stay
 * visible until someone accepts it.
 */
async function runWebShots(job: Job) {
  const url = job.targets?.url;
  if (!url) throw new Error("web-shots needs targets.url");
  const spec = job.suite?.flows as string | undefined;
  if (!spec) throw new Error("web-shots needs suite.flows (the web-specs/<site> directory holding shots.json)");
  const specRoot = path.resolve(WEB_SPECS_DIR);
  const specDir = path.resolve(specRoot, spec);
  // Same separator rule as web-test: a bare prefix test lets `../web-specs-evil` through.
  if (specDir !== specRoot && !specDir.startsWith(specRoot + path.sep)) {
    throw new Error("suite.flows escapes the specs dir");
  }
  const manifestPath = path.join(specDir, "shots.json");
  if (!existsSync(manifestPath)) throw new Error(`no shots manifest: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ShotsManifest;
  const pages = manifest.pages ?? [];
  if (pages.length === 0) throw new Error(`${manifestPath} lists no pages`);
  // Page names become file names and artifact names, so they are validated
  // here — before a browser launches — rather than discovered as a half-run
  // matrix when the screenshot path fails to write.
  for (const p of pages) {
    if (!p.name || !/^[a-z0-9][a-z0-9_-]*$/i.test(p.name)) {
      throw new Error(`shots.json page name unusable as a filename: ${JSON.stringify(p.name)}`);
    }
    if (!p.path) throw new Error(`shots.json page '${p.name}' has no path`);
  }
  if (new Set(pages.map((p) => p.name)).size !== pages.length) {
    throw new Error("shots.json page names must be unique — they name the artifacts");
  }

  // Same honesty rule as web-test: only a host with browsers may run this.
  if (process.env.FLEET_WEB !== "1") {
    await postResult({
      job_id: job.job_id, device_id: `host:${NAME}`, iter: 0, final: true, ok: false,
      error: `executor ${NAME} has no browsers; pin web-shots with targets.executor`,
    });
    log(`refused web-shots ${job.job_id}: no browsers on ${NAME}`);
    return;
  }

  // The job may override the manifest's profiles; same forms as web-test.
  const asked = job.params?.browser ?? manifest.profiles ?? "chromium";
  const profiles = asked === "all"
    ? await listWebProjects()
    : (Array.isArray(asked) ? asked.map(String) : [String(asked)]);
  if (profiles.length === 0) throw new Error("no profiles: params.browser and shots.json both named none");

  // The accepted truth for this suite, keyed page|profile. Fetched once per
  // job, not per profile: every profile in one run diffs against the same
  // accepted set even if someone clicks accept mid-run.
  const suite = path.relative(specRoot, specDir) || ".";
  const baselines = new Map<string, string>();
  {
    const res = await fetch(`${BASE}/api/visual/baselines?suite=${encodeURIComponent(suite)}`);
    if (!res.ok) throw new Error(`baselines fetch -> ${res.status}`);
    const body = (await res.json()) as { baselines: { page: string; profile: string; sha256: string }[] };
    for (const b of body.baselines) baselines.set(`${b.page}|${b.profile}`, b.sha256);
  }

  // Same per-profile lease budget as web-test, renewed by a beacon between
  // profiles: the lease budgets one profile's capture, not the whole matrix.
  const timeoutS = leaseBudgetS(job);

  const expanded = await expandWebProfiles(profiles);

  // Device-backed captures drive hardware the device-executor also hands work
  // to, so they hold collector locks for the whole run — a benchmark starting
  // mid-capture would pollute both jobs' results.
  const deviceIds = expanded.filter((e) => e.target).map((e) => e.target!.id);
  const granted = deviceIds.length > 0 ? await acquireLocks(job.job_id, deviceIds) : null;

  let allOk = true;
  try {
  for (const [i, entry] of expanded.entries()) {
    const profile = entry.profile;
    if (i > 0) await postBeacon(job.job_id, `web:${profile}`, {}).catch(() => {});
    // A meta-profile that found no hardware here: fail its slot plainly.
    if (entry.missing) {
      allOk = false;
      await postResult({
        job_id: job.job_id, device_id: `web:${profile}`, iter: 0, ok: false,
        test: { passed: 0, failed: pages.length, artifacts: [] },
        error: `${entry.missing}; pin device captures to the executor whose shelf holds them`,
      });
      log(`web-shots ${url} (${profile}): ${entry.missing}`);
      continue;
    }
    // Locked hardware is skipped, not failed — the precedent every other
    // host-driven workload sets.
    if (entry.target && granted && !granted.has(entry.target.id)) {
      await postResult({
        job_id: job.job_id, device_id: `web:${profile}`, iter: 0, ok: true,
        test: { passed: 0, failed: 0, artifacts: [] },
        error: "skipped: device locked by another job",
      });
      log(`web-shots ${url} (${profile}): skipped (locked)`);
      continue;
    }
    const outDir = mkdtempSync(path.join(os.tmpdir(), `shots-${job.job_id}-${profile.replace(/[^a-zA-Z0-9_-]/g, "_")}-`));
    const testResults = path.join(outDir, "test-results");
    const started = Date.now();
    let detail = "";
    try {
      // Device captures honour params.network: shaping is applied around the
      // capture and restored after it, including when the capture throws. A
      // profile the target cannot take throws out of here into the catch below,
      // so the profile's failure is what the pages report — not a clean-looking
      // capture taken under conditions nobody asked for.
      if (entry.target?.kind === "android") {
        const t: Target = { id: entry.target.id, platform: "android", kind: "device" };
        detail = await withNetwork(job, t, () => withTimeout(
          captureAndroidShots(t.id, manifest, url, outDir), timeoutS, `android capture on ${t.id}`));
      } else if (entry.target?.kind === "ios-sim") {
        const t: Target = { id: entry.target.id, platform: "ios", kind: "simulator" };
        detail = await withNetwork(job, t, () => withTimeout(
          captureSimSafariShots(t.id, manifest, url, outDir), timeoutS, `simulator capture on ${t.id}`));
      } else {
        await exec(
          "npx",
          ["playwright", "test", path.join(specRoot, "_shots"),
           `--project=${profile}`, "--reporter=json", `--output=${testResults}`],
          {
            timeout: timeoutS * 1000,
            env: {
              ...process.env, CI: "1", PLAYWRIGHT_BASE_URL: url,
              SHOTS_MANIFEST: manifestPath, SHOTS_OUT: outDir,
            },
            maxBuffer: 64 * 1024 * 1024,
          },
        );
      }
    } catch (e: unknown) {
      // A non-zero exit is some pages failing to capture; the per-page rows
      // below say which. Keep the message for pages with nothing better.
      detail = ((e as Error).message ?? String(e)).slice(0, 300);
    }

    // Per-page verdict: captured, and within threshold of the accepted
    // baseline. The metric is a named field — diff_pct — never laundered
    // through a slot that means something else.
    let captured = 0;
    let diverged = 0;
    const shas: string[] = [];
    for (const [pi, p] of pages.entries()) {
      const file = path.join(outDir, `${p.name}.png`);
      const capturedOk = existsSync(file);
      let ok = capturedOk;
      let diffPct: number | undefined;
      let note: string | undefined;
      let sha: string | undefined;
      let diffSha: string | undefined;
      const rowArtifacts: string[] = [];
      if (capturedOk) {
        sha = await uploadArtifact(file, `${job.job_id}-${profile}-${p.name}.png`);
        rowArtifacts.push(sha);
        shas.push(sha);
        captured++;
        const baseline = baselines.get(`${p.name}|${profile}`);
        const threshold = Number(p.threshold_pct ?? manifest.threshold_pct ?? 0.1);
        if (!baseline) {
          // Visible, not failing: a new page's first capture is not a
          // regression, but it stays flagged until someone accepts it.
          note = "new: no baseline — accept this shot to start diffing";
        } else if (baseline === sha) {
          diffPct = 0; // identical bytes; nothing to decode
        } else {
          try {
            const diffFile = path.join(outDir, `${p.name}-diff.png`);
            const d = await diffShot(file, baseline, diffFile);
            diffPct = d.diffPct;
            if (diffPct > threshold) {
              ok = false;
              diverged++;
              note = d.note ?? `${diffPct.toFixed(2)}% of pixels differ (threshold ${threshold}%)`;
              // The diff image only when it matters: a within-threshold pair
              // has nothing worth a person's look, and the store is forever.
              if (d.wroteDiff) {
                diffSha = await uploadArtifact(diffFile, `${job.job_id}-${profile}-${p.name}-diff.png`);
                rowArtifacts.push(diffSha);
              }
            }
          } catch (e) {
            // A baseline the store cannot produce is an operational problem,
            // not a visual regression — but it must fail, loudly, because a
            // page that cannot be judged is not a page that passed.
            ok = false;
            diverged++;
            note = `baseline ${baseline.slice(0, 12)}… unreadable: ${(e as Error).message.slice(0, 200)}`;
          }
        }
      } else {
        note = `no screenshot for page '${p.name}'${detail ? `: ${detail}` : ""}`;
      }
      await postResult({
        job_id: job.job_id, device_id: `web:${profile}`, iter: pi + 1, ok,
        ...(diffPct !== undefined ? { metrics: { diff_pct: Number(diffPct.toFixed(4)) } } : {}),
        test: { passed: ok ? 1 : 0, failed: ok ? 0 : 1, artifacts: rowArtifacts },
        // The structured identity of this cell of the matrix. The dashboard
        // grid is assembled from these, never parsed out of iter order or the
        // note text — iter maps to manifest order, and manifests change.
        shot: {
          suite, page: p.name, profile,
          ...(sha ? { sha256: sha } : {}),
          ...(diffSha ? { diff_sha256: diffSha } : {}),
        },
        error: note,
      });
    }

    // A capture that missed pages left traces/screenshots explaining why;
    // upload them onto the profile summary so a red matrix is debuggable.
    const debris: string[] = [];
    if (captured < pages.length && existsSync(testResults)) {
      for (const f of walkFiles(testResults, "")) {
        debris.push(await uploadArtifact(f.file, `${job.job_id}-${profile}-debris-${f.name.replace(/\//g, "_")}`));
      }
    }

    const missed = pages.length - captured;
    const ok = missed === 0 && diverged === 0;
    if (!ok) allOk = false;
    const problems = [
      ...(missed > 0 ? [`${missed} of ${pages.length} pages not captured`] : []),
      ...(diverged > 0 ? [`${diverged} page(s) diverged from baseline`] : []),
    ].join("; ");
    await postResult({
      job_id: job.job_id, device_id: `web:${profile}`, iter: 0, ok,
      test: { passed: pages.length - missed - diverged, failed: missed + diverged, artifacts: [...shas, ...debris] },
      error: ok ? undefined : problems,
    });
    log(
      `web-shots ${url} (${profile}): ${captured}/${pages.length} pages` +
      (diverged ? `, ${diverged} diverged` : "") +
      ` in ${((Date.now() - started) / 1000).toFixed(0)}s`,
    );
  }
  } finally {
    if (granted) await releaseLocks(job.job_id);
  }
  await postResult({ job_id: job.job_id, device_id: `host:${NAME}`, iter: 0, final: true, ok: allOk });
}

/**
 * How far the captured pixels drifted from the baseline, as a percent of the
 * pixel grid, writing a visual diff image when any pixel drifted.
 *
 * A size change short-circuits to 100%: pixelmatch cannot compare mismatched
 * grids, and a page whose full-page height changed has materially changed
 * however its overlapping pixels look. Antialiasing differences are ignored
 * (pixelmatch's default) — they are the noise floor of same-host rendering.
 */
async function diffShot(
  currentFile: string, baselineSha: string, diffFile: string,
): Promise<{ diffPct: number; note?: string; wroteDiff: boolean }> {
  const baseFile = path.join(mkdtempSync(path.join(os.tmpdir(), "fleet-base-")), "baseline.png");
  await fetchArtifact(baselineSha, baseFile);
  const cur = PNG.sync.read(readFileSync(currentFile));
  const base = PNG.sync.read(readFileSync(baseFile));
  if (cur.width !== base.width || cur.height !== base.height) {
    return {
      diffPct: 100,
      note: `size changed: ${base.width}x${base.height} -> ${cur.width}x${cur.height}`,
      wroteDiff: false,
    };
  }
  const diff = new PNG({ width: cur.width, height: cur.height });
  const mismatched = pixelmatch(base.data, cur.data, diff.data, cur.width, cur.height, { threshold: 0.1 });
  if (mismatched > 0) writeFileSync(diffFile, PNG.sync.write(diff));
  return { diffPct: (mismatched / (cur.width * cur.height)) * 100, wroteDiff: mismatched > 0 };
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
    // A device the fleet is ignoring looks identical to one that was never
    // plugged in. Say why, once, so onboarding is diagnosable instead of
    // silent -- and say the RIGHT thing, because "unlock it" is useless advice
    // for a phone that is simply not paired with this Mac.
    for (const d of ios) {
      const reason = iosNotReadyReason(d);
      if (!reason) continue;
      const key = `${d.identifier}:${d.pairingState}:${d.tunnelState}`;
      if (announcedIos.has(key)) continue;
      announcedIos.add(key);
      log(reason);
    }
    let targets: Target[] = [];
    try {
      targets = await listTargets(ios);
    } catch (e) {
      // Was a bare `return`, which turned any enumerator failure into a host
      // that reports no devices at all and says nothing about why.
      log(`could not list attached devices: ${(e as Error).message.slice(0, 160)}`);
      return;
    }

    const sims = targets.some((t) => t.platform === "ios") ? await simctlDevices() : null;

    // devicectl and simctl can both report the same UDID, so without this the
    // device is registered twice a sweep with a different `kind` each time.
    const seen = new Set<string>();
    for (const t of targets) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      if (!(await fleetOwnedTarget(t, sims))) continue;
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

/**
 * Undo any network shaping an earlier run of this executor left behind, before
 * a single job is claimed.
 *
 * The failure this prevents: a phone whose wifi was disabled by a job that
 * never reached its restore -- a reboot, an OOM, a pkill aimed at something
 * else -- looks exactly like a phone that has died. It vanishes from the
 * dashboard, fails every job it is handed, and nothing anywhere names the
 * cause. Restoring at startup means the worst case is one log line instead of
 * an afternoon.
 *
 * Only devices this executor is allowed to touch, decided by the same
 * fleetOwned rule as presence and selection: a scratch phone somebody has
 * deliberately taken off the network is not ours to reconnect.
 */
async function restoreNetworkOnStartup() {
  try {
    const attached = await listTargets();
    const sims = attached.some((t) => t.platform === "ios") ? await simctlDevices() : null;
    const owned: Target[] = [];
    for (const t of attached) if (await fleetOwnedTarget(t, sims)) owned.push(t);
    const repaired = await restoreAttached(owned);
    log(
      repaired.length > 0
        ? `network: repaired ${repaired.length} device(s) left shaped by an earlier run: ${repaired.join(", ")}`
        : `network: ${owned.length} attached device(s), none needed repair`,
    );
  } catch (e) {
    // Never a reason not to start working: an executor that refuses to claim
    // because a restore sweep failed is a worse outage than the one it is
    // guarding against.
    log(`network: startup restore sweep failed: ${(e as Error).message.slice(0, 200)}`);
  }
}

async function main() {
  log(`polling ${BASE} (flows: ${FLOWS_DIR})`);
  await restoreNetworkOnStartup();
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
      else if (job.workload === "cold-start") await runColdStart(job);
      else if (job.workload === "web-test") await runWebTest(job);
      else if (job.workload === "web-shots") await runWebShots(job);
      else if (job.workload === "web-audit") await runWebAudit(job);
      else if (job.workload === "web-unfurl") await runWebUnfurl(job);
      else if (job.workload === "archive") await runArchive(job);
      else if (job.workload === "digest") await runDigest(job);
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
