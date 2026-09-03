// The host executor's collector-client primitives, shared by the workload
// modules under src/web/ and by the executor itself. One implementation of
// "post a result row" and "move an artifact" — the alternative is each
// workload module growing its own copy, and copies are where the result
// contract quietly forks.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";

export const exec = promisify(execFile);

export const BASE = process.env.FLEET_URL ?? "http://127.0.0.1:8788";
export const NAME = process.env.FLEET_EXECUTOR_NAME ?? os.hostname().replace(/\.local$/, "");

export const log = (msg: string) => console.log(`[executor:${NAME}] ${msg}`);

export async function post(url: string, body: unknown) {
  const res = await fetch(`${BASE}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${url} -> ${res.status}`);
}

export async function postResult(row: Record<string, unknown>) {
  await post("/results", { schema: 1, kind: "result", ...row });
}

export async function postBeacon(jobId: string, deviceId: string, extra: Record<string, unknown>) {
  await post("/results", {
    schema: 1, kind: "beacon", job_id: jobId, device_id: deviceId, beacon: extra,
  });
}

export async function fetchArtifact(sha256: string, dest: string) {
  const res = await fetch(`${BASE}/artifacts/${sha256}`);
  if (!res.ok) throw new Error(`artifact ${sha256} -> ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = createHash("sha256").update(buf).digest("hex");
  if (got !== sha256) throw new Error(`artifact hash mismatch: ${got}`);
  writeFileSync(dest, buf);
}

export async function uploadArtifact(file: string, name: string): Promise<string> {
  const res = await fetch(`${BASE}/artifacts`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-artifact-name": name },
    body: readFileSync(file),
  });
  if (!res.ok) throw new Error(`artifact upload -> ${res.status}`);
  return ((await res.json()) as { sha256: string }).sha256;
}

/**
 * The per-unit time budget a lease allows, in seconds. Shared by every web
 * workload: nothing beacons DURING one unit of work (a project run, a device
 * capture, a crawl segment), so each unit must finish inside the lease —
 * stopping a little short of it, so a timing-out unit reports its own failure
 * rather than being swept mid-flight and silently re-run by the next claimant.
 */
export function leaseBudgetS(job: { lease?: { ttl_s?: number }; params?: Record<string, unknown> }, fallbackS = 570): number {
  const lease = Number(job.lease?.ttl_s);
  const asked = Number(job.params?.timeout_s);
  const budget = Number.isFinite(asked) && asked > 0
    ? asked
    : (Number.isFinite(lease) && lease > 30 ? lease - 30 : fallbackS);
  return Math.max(30, budget);
}
