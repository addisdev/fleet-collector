// Search Console: one finalized day of search analytics per run.
import { log, NAME, postResult } from "../../fleet-client.js";
import type { Job } from "../../executor.js";
import { uploadReport } from "../shared.js";
import { googleAccessToken, type GoogleServiceAccount } from "./auth.js";
import { keychainJson } from "./index.js";

const API_BASE = process.env.FLEET_GSC_API ?? "https://www.googleapis.com/webmasters/v3";

type GscRow = { keys: string[]; clicks: number; impressions: number; ctr: number; position: number };

export async function runGsc(job: Job) {
  const p = (job.params ?? {}) as {
    property?: string; account?: string; days_back?: number; dimensions?: string[];
  };
  const property = p.property;
  if (!property) throw new Error('archive(gsc) needs params.property (e.g. "sc-domain:example.com")');
  const account = p.account ?? "gsc-service-account";
  const dimensions = p.dimensions ?? ["query", "page", "device"];
  // GSC data finalizes late; three days back is the oldest day that is
  // reliably complete. An earlier pull archives numbers that then change.
  const daysBack = Math.max(1, Number(p.days_back ?? 3));
  const date = new Date(Date.now() - daysBack * 86_400_000).toISOString().slice(0, 10);

  const sa = await keychainJson<GoogleServiceAccount>(
    account, "the service-account JSON",
    " — and add the service account's email as a user on the Search Console property",
  );
  if (!sa.client_email || !sa.private_key) throw new Error(`Keychain item ${account} lacks client_email/private_key`);

  const token = await googleAccessToken(sa, "https://www.googleapis.com/auth/webmasters.readonly");
  const rows: GscRow[] = [];
  const pageSize = 25_000;
  for (let startRow = 0; startRow < 100_000; startRow += pageSize) {
    const res = await fetch(
      `${API_BASE}/sites/${encodeURIComponent(property)}/searchAnalytics/query`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ startDate: date, endDate: date, dimensions, rowLimit: pageSize, startRow }),
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (res.status === 403) {
      throw new Error(`Search Console refused (403) — is ${sa.client_email} added as a user on ${property}?`);
    }
    if (!res.ok) throw new Error(`searchAnalytics query -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const batch = ((await res.json()) as { rows?: GscRow[] }).rows ?? [];
    rows.push(...batch);
    if (batch.length < pageSize) break;
  }

  const clicks = rows.reduce((a, r) => a + r.clicks, 0);
  const impressions = rows.reduce((a, r) => a + r.impressions, 0);
  const avgPosition = impressions > 0
    ? rows.reduce((a, r) => a + r.position * r.impressions, 0) / impressions
    : null;

  const name = `gsc-${property.replace(/[^a-zA-Z0-9.-]+/g, "_")}-${date}.json`;
  const sha = await uploadReport(name, { source: "gsc", property, date, dimensions, row_count: rows.length, rows });

  await postResult({
    job_id: job.job_id, device_id: "web:gsc", iter: 0, ok: true,
    metrics: {
      clicks, impressions,
      ctr_pct: impressions > 0 ? Number(((clicks / impressions) * 100).toFixed(2)) : 0,
      ...(avgPosition !== null ? { avg_position: Number(avgPosition.toFixed(2)) } : {}),
    },
    artifacts: [sha],
  });
  log(`archive gsc ${property} ${date}: ${rows.length} rows, ${clicks} clicks / ${impressions} impressions`);
  await postResult({ job_id: job.job_id, device_id: `host:${NAME}`, iter: 0, final: true, ok: true });
}
