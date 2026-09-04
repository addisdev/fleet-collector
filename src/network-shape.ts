/**
 * Network shaping for host-driven jobs: `params.network`.
 *
 * A job says `"network": "offline"` and every device path in the executor --
 * ui-test, web-shots, drain -- runs with that condition applied and restored
 * afterwards, whatever happened in between.
 *
 * The rule this module is written around: a shaping profile that does nothing
 * is worse than no shaping at all. An offline test that quietly ran online is a
 * green row asserting the app survives losing the network, produced by never
 * taking the network away. So every profile here either genuinely changes the
 * device's connectivity and VERIFIES that it did, or throws an error naming the
 * limitation. There is no path through this file that returns success having
 * applied nothing.
 *
 * What is actually reachable, and what is not:
 *
 *   offline / offline-after-<n>s, Android    -- real. `svc wifi disable` and
 *     `svc data disable` over adb, no root needed, verified against
 *     `settings get global wifi_on` afterwards.
 *
 *   offline, iOS simulator                   -- NOT reachable. A simulator has
 *     no network stack of its own; it uses the Mac's. There is no per-simulator
 *     toggle, and the thing that looks like one --
 *     `simctl status_bar override --dataNetwork` -- only redraws the status bar
 *     icon. An app that "went offline" that way still has full connectivity,
 *     which is the exact failure this module exists to prevent.
 *
 *   3g / lossy, any device                   -- not reachable from adb. Latency,
 *     bandwidth and loss shaping on Android means `tc` inside the device's
 *     netns, which needs root and a kernel with sch_netem; an unrooted retail
 *     phone has neither. The reachable path is dnctl/dummynet + pfctl on the
 *     Mac, which shapes only traffic that TRANSITS THE MAC -- true for a
 *     simulator and for traffic an app reaches over `adb reverse`, false for a
 *     phone on wifi talking to the internet. That path is implemented below and
 *     is off unless the operator has explicitly set the host up for it, because
 *     it needs root and a pf.conf anchor. Without that setup it refuses.
 *
 * Restoring is the other half, and the more important one. A phone left with
 * wifi disabled by an executor that crashed mid-job is indistinguishable from a
 * dead phone: it drops off the dashboard, every subsequent job on it fails, and
 * nothing anywhere says "somebody turned its wifi off". So:
 *
 *   - the intent to shape is journalled to disk BEFORE the device is touched,
 *     so a crash between the two is still recoverable;
 *   - `restoreAttached` runs at executor startup, before any job is claimed;
 *   - a restore that cannot be verified KEEPS its journal entry, so the next
 *     startup tries again instead of forgetting.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec, log } from "./fleet-client.js";

/** Same default and env var as the executor's; this module is used alongside it. */
const ADB = process.env.ADB_BIN ?? "adb";

/**
 * Where the shaping journal lives.
 *
 * Deliberately NOT under the repo or in tmp: it has to survive a crash, a
 * reboot and an executor restarted from a different working directory, because
 * its whole job is to be readable by the process that comes after the one that
 * disabled a phone's wifi.
 */
const STATE_DIR = process.env.FLEET_STATE_DIR ?? path.join(os.homedir(), ".fleet");
const JOURNAL = path.join(STATE_DIR, "network-shape.json");

/** The subset of a Target this module needs; structurally the executor's. */
export type ShapeTarget = { id: string; platform: "android" | "ios"; kind?: "device" | "simulator" };

/** The subset of a Job this module needs. */
export type ShapeJob = {
  params?: Record<string, unknown>;
  targets?: { url?: string };
};

export type Profile =
  | { kind: "offline"; delayS: number }
  | { kind: "3g" }
  | { kind: "lossy" };

/** Dummynet settings per shaped profile. Bandwidth in kbit/s, delay one-way in ms. */
const PIPE_CONFIG: Record<"3g" | "lossy", { bwKbit: number; delayMs: number; plr: number }> = {
  // A mid-band 3G connection: ~780 kbit/s, ~200 ms each way (400 ms RTT).
  "3g": { bwKbit: 780, delayMs: 200, plr: 0 },
  // Not slow, just unreliable -- the condition that breaks retry logic.
  lossy: { bwKbit: 0, delayMs: 100, plr: 0.05 },
};

/**
 * Parse `params.network`. Pure, so the accepted vocabulary is testable.
 *
 * Unknown names throw rather than defaulting to "no shaping": a typo'd profile
 * silently running unshaped is the same green-but-vacuous result the whole
 * module is built to avoid.
 */
export function parseNetworkProfile(spec: string): Profile {
  const s = spec.trim().toLowerCase();
  if (s === "offline") return { kind: "offline", delayS: 0 };
  const after = /^offline-after-(\d+)s$/.exec(s);
  if (after) return { kind: "offline", delayS: Number(after[1]) };
  if (s === "3g") return { kind: "3g" };
  if (s === "lossy") return { kind: "lossy" };
  throw new Error(
    `params.network "${spec}" is not a profile I know: offline, offline-after-<n>s, 3g, lossy`,
  );
}

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

type Entry = {
  profile: string;
  applied_at: string;
  /** Prior connectivity, so restore puts back what was there rather than a guess. */
  android?: { wifi: string | null; data: string | null };
  host?: { pipe: number; scope: string; pf_was_enabled: boolean };
};

type Journal = { schema: 1; entries: Record<string, Entry> };

function readJournal(): Journal {
  try {
    const j = JSON.parse(readFileSync(JOURNAL, "utf8")) as Journal;
    if (j && typeof j === "object" && j.entries) return { schema: 1, entries: j.entries };
  } catch {
    // No journal, or an unreadable one. Either way there is nothing to recover.
  }
  return { schema: 1, entries: {} };
}

function writeJournal(j: Journal) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(JOURNAL, JSON.stringify(j, null, 2) + "\n");
}

function journalPut(id: string, e: Entry) {
  const j = readJournal();
  j.entries[id] = e;
  writeJournal(j);
}

function journalDrop(id: string) {
  const j = readJournal();
  if (!(id in j.entries)) return;
  delete j.entries[id];
  writeJournal(j);
}

function journalGet(id: string): Entry | undefined {
  return readJournal().entries[id];
}

// ---------------------------------------------------------------------------
// Android
// ---------------------------------------------------------------------------

async function androidSetting(id: string, key: string): Promise<string | null> {
  try {
    const { stdout } = await exec(ADB, ["-s", id, "shell", "settings", "get", "global", key], { timeout: 15_000 });
    const v = stdout.replace(/\r/g, "").trim();
    return v === "" || v === "null" ? null : v;
  } catch {
    return null;
  }
}

/**
 * Take an Android device off the network, and prove it went off.
 *
 * `svc wifi disable` exits 0 whether or not it worked -- on a device where the
 * shell is not allowed to change wifi state it prints nothing and changes
 * nothing -- so the setting is read back. Refusing loudly here is the point:
 * the alternative is an "offline" run against a device that never left the
 * network.
 */
async function androidOffline(t: ShapeTarget) {
  // A device attached over adb-tcp is reached THROUGH the wifi we are about to
  // switch off: the disable command would land, the control channel would die
  // with it, and restore would have nothing to talk to. The phone would then be
  // off the network permanently, with no way back except somebody walking over
  // with a cable. Refuse, and say which cable to plug in.
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(t.id) || /^[a-z0-9.-]+:\d+$/i.test(t.id)) {
    throw new Error(
      `${t.id} is attached over adb-tcp, and taking it offline would cut this executor's own connection ` +
      "to it with no way to restore -- attach it over USB to run an offline profile",
    );
  }

  const prior = {
    wifi: await androidSetting(t.id, "wifi_on"),
    data: await androidSetting(t.id, "mobile_data"),
  };
  // Journal the INTENT before touching the device: a crash between these two
  // lines must still leave a record that this device may need repair.
  journalPut(t.id, { profile: "offline", applied_at: new Date().toISOString(), android: prior });

  await exec(ADB, ["-s", t.id, "shell", "svc", "wifi", "disable"], { timeout: 20_000 });
  // Cellular: only meaningful on a device with a SIM, a no-op elsewhere.
  await exec(ADB, ["-s", t.id, "shell", "svc", "data", "disable"], { timeout: 20_000 }).catch(() => {});

  await new Promise((r) => setTimeout(r, 1500));
  const now = await androidSetting(t.id, "wifi_on");
  if (now !== "0") {
    await androidRestore(t).catch(() => {});
    throw new Error(
      `could not take ${t.id} offline: wifi_on is still ${now ?? "unknown"} after svc wifi disable ` +
      "(this shell may not be allowed to change wifi state)",
    );
  }
}

/**
 * Put an Android device's connectivity back.
 *
 * Wifi is re-enabled unconditionally, because "on the network" is the baseline
 * state of every device in the fleet and one that is off is broken by
 * definition. Cellular data is NOT: re-enabling data on a device an operator
 * deliberately keeps on wifi can put a metered SIM to work overnight, so it is
 * only restored when the journal says WE turned it off.
 *
 * Returns true when the device was actually changed (i.e. needed repair).
 */
async function androidRestore(t: ShapeTarget): Promise<boolean> {
  const entry = journalGet(t.id);
  const before = await androidSetting(t.id, "wifi_on");
  const needed = before === "0";

  if (needed) await exec(ADB, ["-s", t.id, "shell", "svc", "wifi", "enable"], { timeout: 20_000 });
  if (entry?.android?.data === "1") {
    await exec(ADB, ["-s", t.id, "shell", "svc", "data", "enable"], { timeout: 20_000 }).catch(() => {});
  }

  if (needed) {
    await new Promise((r) => setTimeout(r, 1500));
    const after = await androidSetting(t.id, "wifi_on");
    if (after !== "1") {
      // Keep the journal entry: the next startup sweep must try again rather
      // than forget that this device was left disconnected by us.
      throw new Error(
        `${t.id} is still offline after svc wifi enable (wifi_on=${after ?? "unknown"}); it needs manual repair`,
      );
    }
  }
  journalDrop(t.id);
  return needed;
}

// ---------------------------------------------------------------------------
// Host-side shaping (dnctl + pfctl), for traffic that transits this Mac
// ---------------------------------------------------------------------------

const PF_ANCHOR = "fleet-shape";

/**
 * Is host-side shaping set up on this machine?
 *
 * Three preconditions, and all three are the operator's to satisfy once:
 *
 *   FLEET_NET_SHAPE_HOST=1  -- explicit opt-in. This path filters packets on a
 *     working Mac; it does not turn itself on.
 *   passwordless sudo for pfctl and dnctl -- the executor is otherwise entirely
 *     sudo-free, and prompting for a password inside a nightly is not a thing
 *     that can work.
 *   a `dummynet-anchor "fleet-shape"` / `anchor "fleet-shape"` pair in
 *     /etc/pf.conf -- pf does not evaluate an anchor the main ruleset never
 *     references, so loading rules into an unreferenced anchor succeeds and
 *     shapes nothing. That is the silent no-op in its purest form, so it is
 *     checked rather than assumed. The executor does not edit /etc/pf.conf: a
 *     test runner rewriting the machine's firewall config unprompted is not a
 *     trade worth making.
 *
 * Returns null when set up, or the reason it is not.
 */
async function hostShapingUnavailable(): Promise<string | null> {
  if (process.env.FLEET_NET_SHAPE_HOST !== "1") {
    return "host-side shaping is off on this executor (set FLEET_NET_SHAPE_HOST=1 once the pf setup below is in place)";
  }
  try {
    await exec("sudo", ["-n", "true"], { timeout: 10_000 });
  } catch {
    return "host-side shaping needs passwordless sudo for pfctl/dnctl on this host, and this executor does not have it";
  }
  try {
    const { stdout } = await exec("sudo", ["-n", "pfctl", "-s", "Anchors"], { timeout: 15_000 });
    if (!stdout.split("\n").some((l) => l.trim() === PF_ANCHOR)) {
      return `/etc/pf.conf has no "${PF_ANCHOR}" anchor, so rules loaded into it would never be evaluated; ` +
        `add 'dummynet-anchor "${PF_ANCHOR}"' and 'anchor "${PF_ANCHOR}"' to /etc/pf.conf and reload it`;
    }
  } catch (e) {
    return `pfctl could not be queried on this host: ${(e as Error).message.slice(0, 120)}`;
  }
  return null;
}

/**
 * What to shape, as a pf destination clause.
 *
 * Scope is mandatory, and this is the subtle part. A simulator's traffic leaves
 * the Mac from the Mac's own stack, indistinguishable from the executor's: an
 * unscoped pipe would put 400 ms and 5% loss on this executor's own calls to
 * the collector and on adb itself, which corrupts the run it was meant to
 * measure. So shaping is only ever applied to a named destination -- the URL
 * the job is testing, or `params.network_to` -- and refuses without one.
 */
function shapeScope(job: ShapeJob): { clause: string[]; label: string } {
  const to = (job.params?.network_to as string | undefined) ?? job.targets?.url;
  if (!to) {
    throw new Error(
      "host-side shaping needs a destination: set params.network_to (host or host:port) or targets.url. " +
      "Shaping everything would also shape this executor's own link to the collector and to adb",
    );
  }
  let host = to;
  let port: string | undefined;
  try {
    const u = new URL(to.includes("://") ? to : `http://${to}`);
    host = u.hostname;
    port = u.port || (u.protocol === "https:" ? "443" : u.protocol === "http:" ? "80" : undefined);
  } catch {
    const m = /^([^:/]+)(?::(\d+))?$/.exec(to);
    if (!m) throw new Error(`params.network_to is not a host or URL: ${to}`);
    host = m[1];
    port = m[2];
  }
  return {
    clause: port ? ["to", host, "port", port] : ["to", host],
    label: port ? `${host}:${port}` : host,
  };
}

/** A stable pipe number per device, so two shaped targets never share one. */
function pipeFor(id: string): number {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 600;
  return 4200 + h;
}

async function hostShape(t: ShapeTarget, job: ShapeJob, kind: "3g" | "lossy") {
  const why = await hostShapingUnavailable();
  if (why) throw new Error(`cannot apply the ${kind} profile: ${why}`);

  const scope = shapeScope(job);
  const pipe = pipeFor(t.id);
  const cfg = PIPE_CONFIG[kind];

  const pfEnabled = await exec("sudo", ["-n", "pfctl", "-s", "info"], { timeout: 15_000 })
    .then(({ stdout }) => /Status: Enabled/.test(stdout))
    .catch(() => false);

  journalPut(t.id, {
    profile: kind,
    applied_at: new Date().toISOString(),
    host: { pipe, scope: scope.label, pf_was_enabled: pfEnabled },
  });

  const pipeArgs = ["-n", "dnctl", "pipe", String(pipe), "config",
    ...(cfg.bwKbit ? ["bw", `${cfg.bwKbit}Kbit/s`] : []),
    "delay", String(cfg.delayMs),
    ...(cfg.plr ? ["plr", String(cfg.plr)] : [])];
  await exec("sudo", pipeArgs, { timeout: 15_000 });

  // Both directions: a download-only pipe describes no real connection.
  const rules =
    `dummynet out proto tcp ${scope.clause.join(" ")} pipe ${pipe}\n` +
    `dummynet in proto tcp from ${scope.label.split(":")[0]} pipe ${pipe}\n`;
  await exec("sh", ["-c", `printf %s ${JSON.stringify(rules)} | sudo -n pfctl -a ${PF_ANCHOR} -f -`], { timeout: 20_000 });
  if (!pfEnabled) await exec("sudo", ["-n", "pfctl", "-E"], { timeout: 15_000 });

  // Verify, because every command above exits 0 on a machine where none of it
  // took effect. An unverifiable pipe is torn down and reported, never used.
  const listed = await exec("sudo", ["-n", "dnctl", "list"], { timeout: 15_000 })
    .then(({ stdout }) => new RegExp(`^0*${pipe}\\b`, "m").test(stdout))
    .catch(() => false);
  const anchored = await exec("sudo", ["-n", "pfctl", "-a", PF_ANCHOR, "-s", "rules"], { timeout: 15_000 })
    .then(({ stdout }) => stdout.includes(`pipe ${pipe}`) || stdout.includes("dummynet"))
    .catch(() => false);
  if (!listed || !anchored) {
    await hostRestore(t).catch(() => {});
    throw new Error(
      `the ${kind} profile did not take effect on this host (dnctl pipe ${listed ? "present" : "missing"}, ` +
      `pf anchor rules ${anchored ? "present" : "missing"}); refusing to run a shaped job unshaped`,
    );
  }
  log(`network: ${kind} applied to ${scope.label} for ${t.id} (dummynet pipe ${pipe})`);
}

/** Returns true when something was actually torn down. */
async function hostRestore(t: ShapeTarget): Promise<boolean> {
  const entry = journalGet(t.id);
  if (!entry?.host) return false;
  await exec("sudo", ["-n", "pfctl", "-a", PF_ANCHOR, "-F", "rules"], { timeout: 20_000 }).catch(() => {});
  await exec("sudo", ["-n", "dnctl", "pipe", String(entry.host.pipe), "delete"], { timeout: 20_000 }).catch(() => {});
  // Only undo what we did: a Mac whose pf was already on stays on.
  if (!entry.host.pf_was_enabled) {
    await exec("sudo", ["-n", "pfctl", "-d"], { timeout: 15_000 }).catch(() => {});
  }
  journalDrop(t.id);
  return true;
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** Delayed-offline timers, so restore can cancel one that has not fired yet. */
const pending = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Apply a profile to one target.
 *
 * `offline-after-<n>s` returns immediately having ARMED the disconnection: the
 * job under it runs normally and loses the network n seconds in, which is the
 * condition worth testing (an app that is offline before it starts never gets
 * to the code that handles losing a connection mid-flight).
 */
export async function apply(target: ShapeTarget, profile: string, job: ShapeJob = {}): Promise<void> {
  const p = parseNetworkProfile(profile);

  if (p.kind === "3g" || p.kind === "lossy") {
    if (target.platform === "android" && target.kind === "device") {
      throw new Error(
        `the ${p.kind} profile cannot be applied to the Android device ${target.id}: latency and loss shaping ` +
        "inside the device needs root (tc/netem), and host-side dummynet only shapes traffic that transits this " +
        "Mac -- which a phone on wifi does not. Run this profile against a simulator, or against a device whose " +
        "traffic reaches the host over adb reverse, and set params.network_to",
      );
    }
    return hostShape(target, job, p.kind);
  }

  // offline
  if (target.platform === "ios") {
    throw new Error(
      `the offline profile cannot be applied to the iOS target ${target.id}: a simulator uses the Mac's own ` +
      "network and has no per-simulator switch, and there is no devicectl path to a device's radios. " +
      "(simctl status_bar --dataNetwork only redraws the status bar icon; the app stays fully online.)",
    );
  }

  if (p.delayS > 0) {
    const timer = setTimeout(() => {
      pending.delete(target.id);
      androidOffline(target).then(
        () => log(`network: ${target.id} taken offline after ${p.delayS}s`),
        (e) => log(`network: could not take ${target.id} offline after ${p.delayS}s: ${(e as Error).message}`),
      );
    }, p.delayS * 1000);
    timer.unref();
    pending.set(target.id, timer);
    log(`network: ${target.id} will go offline in ${p.delayS}s`);
    return;
  }

  await androidOffline(target);
  log(`network: ${target.id} is offline`);
}

/**
 * Undo whatever was applied to this target, verified.
 *
 * Safe to call on a target that was never shaped: it cancels nothing, finds no
 * journal entry, and (on Android) confirms the device is on the network.
 */
export async function restore(target: ShapeTarget): Promise<boolean> {
  const timer = pending.get(target.id);
  if (timer) {
    clearTimeout(timer);
    pending.delete(target.id);
  }
  let changed = await hostRestore(target);
  if (target.platform === "android") changed = (await androidRestore(target)) || changed;
  return changed;
}

/**
 * Run `fn` with the job's `params.network` applied to this target.
 *
 * The finally is the entire point of the wrapper existing: every device path
 * that shapes must restore, including the ones that throw, and including the
 * ones that throw inside a loop over several devices.
 */
export async function withNetwork<T>(job: ShapeJob, target: ShapeTarget, fn: () => Promise<T>): Promise<T> {
  const profile = job.params?.network as string | undefined;
  if (!profile) return fn();
  await apply(target, profile, job);
  try {
    return await fn();
  } finally {
    await restore(target).catch((e) => log(`network: restoring ${target.id} failed: ${(e as Error).message}`));
  }
}

/** withNetwork over several targets at once, for a workload that samples them together. */
export async function withNetworkAll<T>(job: ShapeJob, targets: ShapeTarget[], fn: () => Promise<T>): Promise<T> {
  if (!job.params?.network || targets.length === 0) return fn();
  const [head, ...rest] = targets;
  return withNetwork(job, head, () => withNetworkAll(job, rest, fn));
}

/**
 * Startup repair: put every attached device back on the network before this
 * executor claims anything.
 *
 * This exists because of the failure mode, not the feature. An executor killed
 * mid-job -- a reboot, an OOM, a `pkill` aimed at something else -- leaves a
 * phone with its wifi off, and a phone with its wifi off looks exactly like a
 * phone that has died: absent from the dashboard, failing every job it is given,
 * with nothing anywhere naming the cause. One sweep at startup turns a
 * permanent mystery into a log line.
 *
 * Caller passes the targets it is already allowed to touch, so the fleet
 * membership policy in targets.ts is applied in exactly one place.
 */
export async function restoreAttached(targets: ShapeTarget[]): Promise<string[]> {
  const repaired: string[] = [];
  const journalled = new Set(Object.keys(readJournal().entries));
  for (const t of targets) {
    try {
      if (await restore(t)) {
        repaired.push(t.id);
        log(`network: ${t.id} was left disconnected by an earlier run; put back on the network`);
      }
    } catch (e) {
      log(`network: ${t.id} needs manual repair: ${(e as Error).message}`);
    }
  }
  // Devices we shaped that are NOT attached now: nothing to do here, but the
  // entry stays and this says so, because that phone is still off the network
  // wherever it is.
  const absent = [...journalled].filter((id) => !targets.some((t) => t.id === id));
  if (absent.length > 0) {
    log(
      `network: ${absent.length} device(s) shaped by an earlier run are not attached now and stay journalled ` +
      `until they are: ${absent.join(", ")}`,
    );
  }
  return repaired;
}
