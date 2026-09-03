import { db } from "./db.js";
import { effectivePools } from "./api/shared.js";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

const SHARED_CSS = `
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 2rem auto; max-width: 72rem; padding: 0 1rem; color: #1c2025; background: #f7f8fa; }
  @media (prefers-color-scheme: dark) { body { color: #e6e8ec; background: #16181c; } th { color: #767e89; } td { border-color: #31363e; } }
  h1 { font-size: 1.4rem; } h2 { font-size: 1.05rem; margin-top: 2rem; }
  a { color: inherit; }
  table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
  th { text-align: left; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; color: #7a828e; padding: 0.4rem 0.8rem 0.4rem 0; }
  td { padding: 0.4rem 0.8rem 0.4rem 0; border-top: 1px solid #dde1e7; }
  code { font-family: ui-monospace, Menlo, monospace; font-size: 0.85em; }
  .st-done { color: #2e7d32; } .st-failed { color: #c62828; } .st-claimed { color: #9a5b00; }
  .lease { font-size: 0.78rem; color: #7a828e; white-space: nowrap; }
  .note td { border-top: 0; padding-top: 0; font-size: 0.78rem; color: #7a828e; }
`;

/** One table per (model · quant · backend · pp/tg): latest final result per device. */
export function renderBench(): string {
  const rows = db
    .prepare(
      `SELECT r.job_id, r.device_id, r.payload, r.created_at, j.spec
       FROM results r JOIN jobs j ON j.job_id = r.job_id
       WHERE j.workload = 'benchmark' AND json_extract(r.payload, '$.final') = 1
         AND json_extract(r.payload, '$.ok') = 1
       ORDER BY r.created_at DESC LIMIT 500`,
    )
    .all() as { job_id: string; device_id: string; payload: string; created_at: string; spec: string }[];

  const groups = new Map<string, Map<string, { payload: string; created_at: string }>>();
  for (const r of rows) {
    const spec = JSON.parse(r.spec);
    const p = spec.params ?? {};
    const key = `${spec.model?.name ?? "synthetic"}${spec.model?.quant ? ` ${spec.model.quant}` : ""} · ${spec.backend ?? "synthetic"} · pp${p.prompt_tokens ?? 512}/tg${p.gen_tokens ?? 128}`;
    const perDevice = groups.get(key) ?? new Map();
    if (!perDevice.has(r.device_id)) perDevice.set(r.device_id, r); // rows are newest-first
    groups.set(key, perDevice);
  }

  const sections = [...groups.entries()]
    .map(([key, perDevice]) => {
      const body = [...perDevice.entries()]
        .map(([device, r]) => {
          const p = JSON.parse(r.payload);
          const m = p.metrics ?? {};
          const d = p.device ?? {};
          return { device, os: d.os ?? "?", m, at: r.created_at, decode: m.decode_tok_s ?? 0 };
        })
        .sort((a, b) => b.decode - a.decode)
        .map(
          (x) => `<tr>
            <td><code>${esc(x.device)}</code></td><td>${esc(x.os)}</td>
            <td>${x.m.prefill_tok_s?.toFixed(1) ?? "—"}</td>
            <td><strong>${x.m.decode_tok_s?.toFixed(1) ?? "—"}</strong></td>
            <td>${x.m.ttft_ms?.toFixed(0) ?? "—"}</td>
            <td>${x.m.load_ms ?? "—"}</td>
            <td>${x.m.peak_mem_mb ?? "—"} (${esc(x.m.mem_method ?? "?")})</td>
            <td>${esc(x.at)}</td>
          </tr>`,
        )
        .join("");
      return `<h2>${esc(key)}</h2>
        <table><tr><th>Device</th><th>OS</th><th>Prefill tok/s</th><th>Decode tok/s</th><th>TTFT ms</th><th>Load ms</th><th>Mem MB (method)</th><th>When</th></tr>${body}</table>`;
    })
    .join("");

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Fleet Benchmarks</title><link rel="icon" type="image/svg+xml" href="/dash/favicon.svg">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${SHARED_CSS}</style></head><body>
<h1>Fleet Benchmarks <a href="/dash/legacy" style="font-size:0.8rem">← dashboard</a></h1>
<p style="color:#7a828e;font-size:0.85rem">Latest passing run per device per configuration, fastest decode first. Memory methods differ by platform and are never comparable across them.</p>
${sections || "<p>No benchmark results yet.</p>"}
</body></html>`;
}

export function renderDash(): string {
  const devices = db
    .prepare("SELECT * FROM devices ORDER BY last_seen DESC")
    .all() as { device_id: string; descriptor: string; pools: string; pools_override: string | null; last_seen: string; last_beacon: string | null }[];
  const jobs = db
    .prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 50")
    .all() as { job_id: string; executor: string; workload: string; status: string; created_at: string; claimed_by: string | null; finished_at: string | null; attempts: number; max_attempts: number; lease_deadline: string | null; last_error: string | null }[];
  const results = db
    .prepare("SELECT * FROM results ORDER BY created_at DESC LIMIT 50")
    .all() as { job_id: string; device_id: string; iter: number; payload: string; created_at: string }[];
  const schedules = db
    .prepare("SELECT * FROM schedules ORDER BY id")
    .all() as { id: string; cron: string; enabled: number; last_run: string | null }[];
  const locks = db
    .prepare("SELECT * FROM device_locks ORDER BY acquired_at")
    .all() as { device_id: string; job_id: string; acquired_at: string }[];

  const deviceRows = devices
    .map((d) => {
      const desc = JSON.parse(d.descriptor);
      const beacon = d.last_beacon ? JSON.parse(d.last_beacon) : null;
      return `<tr>
        <td><code>${esc(d.device_id)}</code></td>
        <td>${esc(desc.model ?? "?")} · ${esc(desc.os ?? "?")}</td>
        <td>${esc(effectivePools(d).join(", "))}</td>
        <td>${beacon?.beacon?.battery_pct != null ? esc(beacon.beacon.battery_pct) + "%" : "—"}</td>
        <td>${esc(beacon?.beacon?.thermal ?? "—")}</td>
        <td>${esc(d.last_seen)}</td>
      </tr>`;
    })
    .join("");

  const jobRows = jobs
    .map((j) => {
      const lease =
        j.status === "claimed" && j.lease_deadline
          ? `try ${j.attempts}/${j.max_attempts} · lease to ${esc(j.lease_deadline)}`
          : j.attempts > 1 || j.last_error
            ? `try ${j.attempts}/${j.max_attempts}`
            : "—";
      return `<tr>
        <td><code>${esc(j.job_id)}</code></td>
        <td>${esc(j.workload)}</td>
        <td>${esc(j.executor)}</td>
        <td class="st-${esc(j.status)}">${esc(j.status)}</td>
        <td>${esc(j.claimed_by ?? "—")}</td>
        <td class="lease">${lease}</td>
        <td>${esc(j.finished_at ?? j.created_at)}</td>
      </tr>${
        j.last_error
          ? `<tr class="note"><td colspan="7">↳ ${esc(j.last_error)}</td></tr>`
          : ""
      }`;
    })
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
<html><head><meta charset="utf-8"><title>Fleet Collector</title><link rel="icon" type="image/svg+xml" href="/dash/favicon.svg">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${SHARED_CSS}</style></head><body>
<h1>Fleet Collector <a href="/dash/legacy/bench" style="font-size:0.8rem">benchmarks →</a></h1>
<h2>Devices (${devices.length})</h2>
<table><tr><th>ID</th><th>Hardware</th><th>Pools</th><th>Battery</th><th>Thermal</th><th>Last seen</th></tr>${deviceRows}</table>
<h2>Jobs</h2>
<table><tr><th>Job</th><th>Workload</th><th>Executor</th><th>Status</th><th>Claimed by</th><th>Lease</th><th>Updated</th></tr>${jobRows}</table>
<h2>Recent results</h2>
<table><tr><th>Job</th><th>Device</th><th>Iter</th><th>Summary</th><th>At</th></tr>${resultRows}</table>
<h2>Schedules (${schedules.length})</h2>
<table><tr><th>ID</th><th>Cron</th><th>Enabled</th><th>Last run</th></tr>${schedules
    .map(
      (s) => `<tr><td><code>${esc(s.id)}</code></td><td><code>${esc(s.cron)}</code></td>
        <td class="${s.enabled ? "st-done" : ""}">${s.enabled ? "on" : "off"}</td><td>${esc(s.last_run ?? "—")}</td></tr>`,
    )
    .join("")}</table>
<h2>Device locks (${locks.length})</h2>
<table><tr><th>Device</th><th>Held by job</th><th>Since</th></tr>${locks
    .map(
      (l) => `<tr><td><code>${esc(l.device_id)}</code></td><td><code>${esc(l.job_id)}</code></td><td>${esc(l.acquired_at)}</td></tr>`,
    )
    .join("")}</table>
</body></html>`;
}
