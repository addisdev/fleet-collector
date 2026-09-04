// `npm test` — everything a fresh clone can check without hardware.
//
// The collector's real test is scripts/smoke.ts, which drives a running
// collector through every Phase 0 endpoint. That is the right shape for this
// project (the interesting bugs live in the HTTP surface and the SQL, not in
// pure functions) but it has always needed someone to start a collector first,
// remember which port, and remember not to point it at the real one. This
// script does those three things, so CI and a stranger get the same run.
//
// The temp database is the part that matters. Running the suite against a
// live fleet would enrol fake devices and enqueue fake jobs into the history
// somebody actually reads, so the collector under test gets its own data
// directory, its own artifact store, and a port nobody is using.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX = path.join(ROOT, "node_modules/tsx/dist/cli.mjs");
const BIN = path.join(ROOT, "node_modules/.bin");

let failed = false;
const step = (name: string) => console.log(`\n=== ${name}`);

/** Run a command to completion; resolve false rather than throwing. */
function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return new Promise<boolean>((resolve) => {
    const p = spawn(cmd, args, { cwd: opts.cwd ?? ROOT, env: { ...process.env, ...opts.env }, stdio: "inherit" });
    p.on("error", (e) => { console.error(`  cannot run ${cmd}: ${e.message}`); resolve(false); });
    p.on("exit", (code) => resolve(code === 0));
  });
}

/**
 * A port nobody is listening on. Bind zero, read what the kernel picked, hand
 * it back. There is a race between closing this and the collector binding it,
 * but the alternative is a hard-coded port that collides with the collector
 * this machine is probably already running — which is the failure that would
 * actually happen.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "string" || addr === null) return reject(new Error("no port"));
      srv.close(() => resolve(addr.port));
    });
  });
}

async function waitForHealth(base: string, proc: ChildProcess, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`collector exited early with code ${proc.exitCode}`);
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`collector did not answer /api/health within ${timeoutMs}ms`);
}

// --- 1. types -----------------------------------------------------------
step("typecheck (collector)");
if (!(await run(path.join(BIN, "tsc"), ["--noEmit"]))) failed = true;

// --- 2. dashboard -------------------------------------------------------
// Its deps are a separate install, so a clone that has not run dash:install
// should be told that plainly rather than fail with a missing-binary error.
step("typecheck + build (dashboard)");
const { existsSync } = await import("node:fs");
if (!existsSync(path.join(ROOT, "dash/node_modules"))) {
  console.log("  SKIPPED — run `npm run dash:install` first");
} else if (!(await run("npm", ["--prefix", "dash", "run", "build"]))) {
  failed = true;
}

// --- 3. the icon set keeps up with the workloads -------------------------
// WORKLOAD_ICON says it covers every workload the collector accepts, and
// nothing but this step enforces it. The dashboard deliberately does not
// import collector types, so the two lists can only be compared as text —
// which means a regex that stops matching has to fail the step, not pass it
// quietly, or the check silently stops checking.
step("every workload has an icon");
{
  const literal = (src: string, re: RegExp, what: string) => {
    const m = src.match(re);
    if (!m) throw new Error(`cannot find ${what} — this check needs updating`);
    return m[1];
  };
  try {
    const workloads = literal(
      await readFile(path.join(ROOT, "src/server.ts"), "utf8"),
      /const WORKLOADS = new Set\(\[([\s\S]*?)\]\)/,
      "WORKLOADS in src/server.ts",
    );
    const icons = literal(
      await readFile(path.join(ROOT, "dash/src/icons.tsx"), "utf8"),
      /const WORKLOAD_ICON: Record<string, IconName> = \{([\s\S]*?)\n\};/,
      "WORKLOAD_ICON in dash/src/icons.tsx",
    );
    const accepted = new Set([...workloads.matchAll(/"([a-z][a-z-]*)"/g)].map((m) => m[1]));
    const drawn = new Set([...icons.matchAll(/^\s*"?([a-z][a-z-]*)"?\s*:/gm)].map((m) => m[1]));
    if (accepted.size === 0 || drawn.size === 0) throw new Error("parsed an empty list — this check needs updating");

    const missing = [...accepted].filter((w) => !drawn.has(w));
    const stale = [...drawn].filter((w) => !accepted.has(w));
    if (missing.length) console.error(`  no icon for: ${missing.join(", ")}`);
    if (stale.length) console.error(`  icon for a workload the collector does not accept: ${stale.join(", ")}`);
    if (missing.length || stale.length) failed = true;
    else console.log(`  ok — ${accepted.size} workloads, ${accepted.size} icons`);
  } catch (e) {
    failed = true;
    console.error(`  ${(e as Error).message}`);
  }
}

// --- 4. metric names ----------------------------------------------------
// The schema is the contract for a name that three codebases write and one
// reads. Nothing enforced it until now, and the last drift cost the plant-ID
// eval's numbers their queryability.
step("metric names match the schema");
if (!(await run(process.execPath, [TSX, "scripts/check-metrics.ts"]))) failed = true;

// --- 5. the collector, on its own data ----------------------------------
step("smoke (against a throwaway collector)");
const dir = await mkdtemp(path.join(tmpdir(), "fleet-test-"));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
let server: ChildProcess | undefined;

try {
  server = spawn(process.execPath, [TSX, "src/server.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      FLEET_PORT: String(port),
      FLEET_DATA_DIR: path.join(dir, "data"),
      FLEET_ARTIFACT_DIR: path.join(dir, "artifacts"),
      FLEET_LOG_FILE: path.join(dir, "collector.log"),
      // Nothing in the suite needs the sweeper or the scheduler, and a tick
      // firing mid-assertion is a flake nobody enjoys diagnosing.
      FLEET_SWEEP_MS: "60000",
      FLEET_SCHEDULER_TICK_MS: "60000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Held, not streamed: a passing run should be quiet, and a failing one
  // should print the server's side of the story right where you are looking.
  let log = "";
  server.stdout?.on("data", (d) => { log += d; });
  server.stderr?.on("data", (d) => { log += d; });

  console.log(`  collector on ${base}, data in ${dir}`);
  await waitForHealth(base, server);

  if (!(await run(process.execPath, [TSX, "scripts/smoke.ts"], { env: { FLEET_URL: base } }))) {
    failed = true;
    console.error("\n--- collector output ---\n" + log.trimEnd());
  }
} catch (e) {
  failed = true;
  console.error(`  ${(e as Error).message}`);
} finally {
  server?.kill("SIGTERM");
  await rm(dir, { recursive: true, force: true });
}

console.log(failed ? "\nFAILED" : "\nALL PASS");
process.exit(failed ? 1 : 0);
