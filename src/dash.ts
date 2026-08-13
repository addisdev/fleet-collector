import { db } from "./db.js";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

export function renderDash(): string {
  const devices = db
    .prepare("SELECT * FROM devices ORDER BY last_seen DESC")
    .all() as { device_id: string; descriptor: string; pools: string; last_seen: string; last_beacon: string | null }[];
  const jobs = db
    .prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 50")
    .all() as { job_id: string; executor: string; workload: string; status: string; created_at: string; claimed_by: string | null; finished_at: string | null }[];
  const results = db
    .prepare("SELECT * FROM results ORDER BY created_at DESC LIMIT 50")
    .all() as { job_id: string; device_id: string; iter: number; payload: string; created_at: string }[];

  const deviceRows = devices
    .map((d) => {
      const desc = JSON.parse(d.descriptor);
      const beacon = d.last_beacon ? JSON.parse(d.last_beacon) : null;
      return `<tr>
        <td><code>${esc(d.device_id)}</code></td>
        <td>${esc(desc.model ?? "?")} · ${esc(desc.os ?? "?")}</td>
        <td>${esc(JSON.parse(d.pools).join(", "))}</td>
        <td>${beacon?.beacon?.battery_pct != null ? esc(beacon.beacon.battery_pct) + "%" : "—"}</td>
        <td>${esc(beacon?.beacon?.thermal ?? "—")}</td>
        <td>${esc(d.last_seen)}</td>
      </tr>`;
    })
    .join("");

  const jobRows = jobs
    .map(
      (j) => `<tr>
        <td><code>${esc(j.job_id)}</code></td>
        <td>${esc(j.workload)}</td>
        <td>${esc(j.executor)}</td>
        <td class="st-${esc(j.status)}">${esc(j.status)}</td>
        <td>${esc(j.claimed_by ?? "—")}</td>
        <td>${esc(j.finished_at ?? j.created_at)}</td>
      </tr>`,
    )
    .join("");

  const resultRows = results
    .map((r) => {
      const p = JSON.parse(r.payload);
      const summary = p.metrics
        ? `decode ${p.metrics.decode_tok_s ?? "?"} tok/s · ${p.metrics.peak_mem_mb ?? "?"} MB (${p.metrics.mem_method ?? "?"})`
        : p.test
          ? `${p.test.passed ?? 0} passed / ${p.test.failed ?? 0} failed`
          : "";
      return `<tr>
        <td><code>${esc(r.job_id)}</code></td>
        <td><code>${esc(r.device_id)}</code></td>
        <td>${esc(r.iter)}${p.final ? " (final)" : ""}</td>
        <td>${esc(summary)}</td>
        <td>${esc(r.created_at)}</td>
      </tr>`;
    })
    .join("");

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Fleet Collector</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 2rem auto; max-width: 72rem; padding: 0 1rem; color: #1c2025; background: #f7f8fa; }
  @media (prefers-color-scheme: dark) { body { color: #e6e8ec; background: #16181c; } th { color: #767e89; } td { border-color: #31363e; } }
  h1 { font-size: 1.4rem; } h2 { font-size: 1.05rem; margin-top: 2rem; }
  table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
  th { text-align: left; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; color: #7a828e; padding: 0.4rem 0.8rem 0.4rem 0; }
  td { padding: 0.4rem 0.8rem 0.4rem 0; border-top: 1px solid #dde1e7; }
  code { font-family: ui-monospace, Menlo, monospace; font-size: 0.85em; }
  .st-done { color: #2e7d32; } .st-failed { color: #c62828; } .st-claimed { color: #9a5b00; }
</style></head><body>
<h1>Fleet Collector</h1>
<h2>Devices (${devices.length})</h2>
<table><tr><th>ID</th><th>Hardware</th><th>Pools</th><th>Battery</th><th>Thermal</th><th>Last seen</th></tr>${deviceRows}</table>
<h2>Jobs</h2>
<table><tr><th>Job</th><th>Workload</th><th>Executor</th><th>Status</th><th>Claimed by</th><th>Updated</th></tr>${jobRows}</table>
<h2>Recent results</h2>
<table><tr><th>Job</th><th>Device</th><th>Iter</th><th>Summary</th><th>At</th></tr>${resultRows}</table>
</body></html>`;
}
