// Shared plumbing for the web workload modules (audit, unfurl, archive).
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { uploadArtifact } from "../fleet-client.js";

export const WEB_SPECS_DIR = process.env.FLEET_WEB_SPECS_DIR ?? path.resolve("web-specs");

/**
 * Resolve a suite.flows value to its directory under web-specs, refusing
 * escapes. Same rule as web-test: the separator matters, because a bare
 * prefix test lets `../web-specs-evil` through.
 */
export function resolveSiteDir(flows: string): { dir: string; suite: string } {
  const root = path.resolve(WEB_SPECS_DIR);
  const dir = path.resolve(root, flows);
  if (dir !== root && !dir.startsWith(root + path.sep)) {
    throw new Error("suite.flows escapes the specs dir");
  }
  return { dir, suite: path.relative(root, dir) || "." };
}

/** The site's config file for a workload, or null when the site has none. */
export function readSiteConfig<T>(dir: string, filename: string): T | null {
  const file = path.join(dir, filename);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

/**
 * One finding, everywhere. `error` fails the run; `warn` is recorded and
 * reported but does not — the same stance the aliquant smoke spec takes on
 * edge-injected scripts: failing a nightly on what nobody will fix teaches
 * everyone to ignore red.
 */
export type Finding = {
  severity: "error" | "warn";
  check: string;
  page?: string;
  detail: string;
};

export const countBySeverity = (findings: Finding[]) => ({
  issues_error: findings.filter((f) => f.severity === "error").length,
  issues_warn: findings.filter((f) => f.severity === "warn").length,
});

/** Write a JSON report to a temp file and upload it; returns the sha. */
export async function uploadReport(name: string, report: unknown): Promise<string> {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "fleet-report-")), name);
  writeFileSync(file, JSON.stringify(report, null, 1));
  return uploadArtifact(file, name);
}
