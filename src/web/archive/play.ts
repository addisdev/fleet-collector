// Play Console reviews.
//
// The Play API returns roughly the LAST SEVEN DAYS of reviews and nothing
// older — this pull is the fleet's only chance to keep them. That constraint
// is why the review archive runs daily and why this module exists at all:
// miss a week and the week is gone.
//
// Auth is the same Google service-account grant as Search Console with the
// androidpublisher scope; the service account must be linked in Play Console
// with permission to view app information.
import { log, NAME, postResult } from "../../fleet-client.js";
import type { Job } from "../../executor.js";
import { uploadReport } from "../shared.js";
import { googleAccessToken, type GoogleServiceAccount } from "./auth.js";
import { keychainJson, type Review } from "./index.js";

const API_BASE = process.env.FLEET_PLAY_API ?? "https://androidpublisher.googleapis.com/androidpublisher/v3";

type PlayReview = {
  reviewId: string;
  authorName?: string;
  comments?: {
    userComment?: {
      text?: string;
      lastModified?: { seconds?: string | number };
      starRating?: number;
      reviewerLanguage?: string;
    };
  }[];
};

export async function runPlayReviews(job: Job) {
  const p = (job.params ?? {}) as { app?: string; package?: string; account?: string };
  const app = p.app;
  const pkg = p.package;
  if (!app || !pkg) throw new Error('archive(play) needs params.app (a name) and params.package (e.g. "com.taylab.greenfolio")');
  const account = p.account ?? "play-service-account";

  const sa = await keychainJson<GoogleServiceAccount>(
    account, "the service-account JSON",
    " — and link the service account in Play Console with view-app-information permission",
  );
  if (!sa.client_email || !sa.private_key) throw new Error(`Keychain item ${account} lacks client_email/private_key`);

  const token = await googleAccessToken(sa, "https://www.googleapis.com/auth/androidpublisher");
  const reviews: Review[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${API_BASE}/applications/${encodeURIComponent(pkg)}/reviews`);
    url.searchParams.set("maxResults", "100");
    if (pageToken) url.searchParams.set("token", pageToken);
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Play Console refused (${res.status}) — is ${sa.client_email} linked in Play Console for ${pkg}?`);
    }
    if (!res.ok) throw new Error(`reviews -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as {
      reviews?: PlayReview[];
      tokenPagination?: { nextPageToken?: string };
    };
    for (const r of body.reviews ?? []) {
      const c = r.comments?.[0]?.userComment;
      if (!c) continue;
      const seconds = Number(c.lastModified?.seconds ?? 0);
      reviews.push({
        id: `play:${r.reviewId}`,
        source: "play",
        app,
        rating: c.starRating ?? 0,
        title: null, // Play reviews have no title
        body: (c.text ?? "").trim(),
        author: r.authorName ?? null,
        date: seconds ? new Date(seconds * 1000).toISOString() : new Date().toISOString(),
        territory: c.reviewerLanguage ?? null,
      });
    }
    pageToken = body.tokenPagination?.nextPageToken;
  } while (pageToken);

  const date = new Date().toISOString().slice(0, 10);
  const avgRating = reviews.length ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length : null;
  const name = `reviews-play-${app.replace(/[^a-zA-Z0-9.-]+/g, "_")}-${date}.json`;
  const sha = await uploadReport(name, {
    source: "play", app, package: pkg, pulled_at: new Date().toISOString(),
    review_count: reviews.length, reviews,
  });

  await postResult({
    job_id: job.job_id, device_id: "web:play", iter: 0, ok: true,
    metrics: {
      reviews_count: reviews.length,
      ...(avgRating !== null ? { avg_rating: Number(avgRating.toFixed(2)) } : {}),
    },
    artifacts: [sha],
  });
  log(`archive play ${app}: ${reviews.length} reviews` + (avgRating !== null ? `, avg ${avgRating.toFixed(2)}★` : ""));
  await postResult({ job_id: job.job_id, device_id: `host:${NAME}`, iter: 0, final: true, ok: true });
}
