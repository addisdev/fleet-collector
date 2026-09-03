// App Store Connect customer reviews.
//
// ASC keeps full review history, so unlike Play nothing is ever lost — the
// daily pull exists to keep the archive current and to feed the weekly
// digest a steady diet. Each run pulls reviews created inside the window
// (days_back, default 8 — one day of overlap over a daily cadence, deduped
// downstream by review id).
import { log, NAME, postResult } from "../../fleet-client.js";
import type { Job } from "../../executor.js";
import { uploadReport } from "../shared.js";
import { ascToken, type AscApiKey } from "./auth.js";
import { keychainJson, type Review } from "./index.js";

const API_BASE = process.env.FLEET_ASC_API ?? "https://api.appstoreconnect.apple.com";

type AscReview = {
  id: string;
  attributes?: {
    rating?: number; title?: string | null; body?: string | null;
    reviewerNickname?: string | null; createdDate?: string; territory?: string | null;
  };
};

export async function runAscReviews(job: Job) {
  const p = (job.params ?? {}) as {
    app?: string; app_id?: string; account?: string; days_back?: number;
  };
  // `app` is the human name used in artifact names and the digest; `app_id`
  // is Apple's numeric identifier the API wants.
  const app = p.app;
  const appId = p.app_id;
  if (!app || !appId) throw new Error('archive(asc) needs params.app (a name) and params.app_id (the numeric App Store id)');
  const account = p.account ?? "asc-api-key";
  const daysBack = Math.max(1, Number(p.days_back ?? 8));
  const since = Date.now() - daysBack * 86_400_000;

  const key = await keychainJson<AscApiKey>(
    account, 'an ASC key JSON ({"key_id","issuer_id","private_key"})',
    " — the .p8 contents go in private_key",
  );
  if (!key.key_id || !key.issuer_id || !key.private_key) {
    throw new Error(`Keychain item ${account} lacks key_id/issuer_id/private_key`);
  }
  const token = ascToken(key);

  const reviews: Review[] = [];
  let url: string | null =
    `${API_BASE}/v1/apps/${encodeURIComponent(appId)}/customerReviews?sort=-createdDate&limit=200`;
  // Sorted newest-first, so the first review older than the window ends the
  // walk — no reason to page through years of history every morning.
  paging: while (url) {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error(`App Store Connect refused (${res.status}) — check the key's role covers app ${appId}`);
    }
    if (!res.ok) throw new Error(`customerReviews -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { data?: AscReview[]; links?: { next?: string } };
    for (const r of body.data ?? []) {
      const a = r.attributes ?? {};
      const created = a.createdDate ? Date.parse(a.createdDate) : NaN;
      if (Number.isFinite(created) && created < since) break paging;
      reviews.push({
        id: `asc:${r.id}`,
        source: "asc",
        app,
        rating: a.rating ?? 0,
        title: a.title ?? null,
        body: a.body ?? "",
        author: a.reviewerNickname ?? null,
        date: a.createdDate ?? new Date().toISOString(),
        territory: a.territory ?? null,
      });
    }
    url = body.links?.next ?? null;
  }

  const date = new Date().toISOString().slice(0, 10);
  const avgRating = reviews.length ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length : null;
  const name = `reviews-asc-${app.replace(/[^a-zA-Z0-9.-]+/g, "_")}-${date}.json`;
  const sha = await uploadReport(name, {
    source: "asc", app, app_id: appId, pulled_at: new Date().toISOString(),
    window_days: daysBack, review_count: reviews.length, reviews,
  });

  await postResult({
    job_id: job.job_id, device_id: "web:asc", iter: 0, ok: true,
    metrics: {
      reviews_count: reviews.length,
      ...(avgRating !== null ? { avg_rating: Number(avgRating.toFixed(2)) } : {}),
    },
    artifacts: [sha],
  });
  log(`archive asc ${app}: ${reviews.length} reviews in the last ${daysBack}d` +
    (avgRating !== null ? `, avg ${avgRating.toFixed(2)}★` : ""));
  await postResult({ job_id: job.job_id, device_id: `host:${NAME}`, iter: 0, final: true, ok: true });
}
