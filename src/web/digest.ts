// digest: the weekly review digest — the fleet summarizing what its users
// said about its apps, using its own shelf as the language model.
//
// The host executor is the conductor here, not the worker. It gathers the
// week's review artifacts (pulled daily by archive asc/play), builds prompt
// items, and enqueues them as ordinary `batch` jobs that the phones' runners
// process with llama.cpp — the same machinery every benchmark uses. Two
// passes: classify every review (map), then summarize each cluster (reduce).
//
// The clustering BETWEEN those passes is deterministic code over a closed
// taxonomy, not a model call. It is the step most tempting to hand the LLM
// and the step that most needs to be debuggable when the digest says
// something odd — a fixed tag vocabulary is also what makes small on-device
// models reliable classifiers at all.
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BASE, fetchArtifact, log, NAME, postBeacon, postResult, uploadArtifact } from "../fleet-client.js";
import type { Job } from "../executor.js";
import type { Review } from "./archive/index.js";
import { uploadReport } from "./shared.js";

const TAXONOMY = ["crash", "bug", "performance", "sync", "billing", "ux", "feature-request", "praise", "other"] as const;
type Tag = (typeof TAXONOMY)[number];

type Classification = { tag: Tag; sentiment: string; gist: string; parsed: boolean };

type DigestParams = {
  apps?: string[];           // restrict to these app names; default: every app found
  days?: number;             // review window, default 7
  match?: string;            // device targeting for the batch jobs
  max_tokens?: number;       // generation budget per item, default 200
  batch_timeout_s?: number;  // per batch job, default 3600
  min_cluster?: number;      // smaller clusters fold into "other", default 2
};

const classifyPrompt = (r: Review) => {
  const text = [r.title, r.body].filter(Boolean).join(" — ").slice(0, 600);
  return (
    `You label app store reviews. Reply with ONLY a JSON object on one line, no other text:\n` +
    `{"tag": "<one of: ${TAXONOMY.join("|")}>", "sentiment": "positive|negative|neutral", "gist": "<the review in at most 15 words>"}\n\n` +
    `Review of ${r.app} (${r.rating}/5): ${text}\nJSON:`
  );
};

const summarizePrompt = (app: string, tag: Tag, members: { review: Review; c: Classification }[]) => {
  const avg = members.reduce((s, m) => s + m.review.rating, 0) / members.length;
  const gists = members.slice(0, 30).map((m) => `- (${m.review.rating}/5) ${m.c.gist}`).join("\n");
  return (
    `You write one paragraph for a weekly app-review digest. These are the "${tag}" reviews ` +
    `for ${app} this week (${members.length} reviews, average ${avg.toFixed(1)}/5):\n${gists}\n\n` +
    `Write 2-3 plain sentences describing what users are reporting. No preamble, no bullet points.`
  );
};

/** The first JSON object in a model's output, or a fallback that keeps the
 *  review in the digest under "other" — a review must never vanish because a
 *  small model rambled. */
function parseClassification(output: string, review: Review): Classification {
  const m = /\{[\s\S]*?\}/.exec(output);
  if (m) {
    try {
      const j = JSON.parse(m[0]) as { tag?: string; sentiment?: string; gist?: string };
      const tag = (TAXONOMY as readonly string[]).includes(j.tag ?? "") ? (j.tag as Tag) : "other";
      return {
        tag,
        sentiment: j.sentiment ?? "neutral",
        gist: (j.gist ?? review.body.slice(0, 80)).slice(0, 200),
        parsed: true,
      };
    } catch { /* fall through to the fallback */ }
  }
  return { tag: "other", sentiment: "neutral", gist: review.body.slice(0, 80), parsed: false };
}

async function apiJson<T>(pathname: string): Promise<T> {
  const res = await fetch(`${BASE}${pathname}`);
  if (!res.ok) throw new Error(`GET ${pathname} -> ${res.status}`);
  return (await res.json()) as T;
}

/** Enqueue a batch job on the shelf and wait it out, renewing the digest's
 *  own lease with a beacon per poll. Returns the outputs the device posted. */
async function runShelfBatch(
  digestJob: Job, label: string, items: string[], params: DigestParams,
): Promise<string[]> {
  const jobId = `${digestJob.job_id}--${label}`;
  const dir = mkdtempSync(path.join(os.tmpdir(), "fleet-digest-"));
  const itemsFile = path.join(dir, "items.json");
  writeFileSync(itemsFile, JSON.stringify({ items }));
  const inputSha = await uploadArtifact(itemsFile, `${jobId}-items.json`);

  const spec = {
    schema: 1, job_id: jobId, workload: "batch", executor: "device",
    backend: "llama.cpp",
    ...(digestJob.model ? { model: digestJob.model } : {}),
    params: { input_sha256: inputSha, max_tokens: params.max_tokens ?? 200 },
    targets: { match: params.match ?? "ram_mb >= 4000" },
    constraints: { require_charging: true },
    lease: { ttl_s: 1800, max_attempts: 2 },
  };
  const made = await fetch(`${BASE}/jobs`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(spec),
  });
  // 409 means a previous attempt of THIS digest already enqueued it — adopt
  // rather than fail, so a re-claimed digest picks up where it stopped.
  if (!made.ok && made.status !== 409) throw new Error(`enqueue ${label} batch -> ${made.status}: ${(await made.text()).slice(0, 200)}`);
  log(`digest ${label}: ${items.length} item(s) queued for the shelf as ${jobId}`);

  const timeoutS = Number(params.batch_timeout_s ?? 3600);
  const deadline = Date.now() + timeoutS * 1000;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`${label} batch ${jobId} did not finish inside ${timeoutS}s`);
    await new Promise((r) => setTimeout(r, 10_000));
    await postBeacon(digestJob.job_id, "web:digest", {}).catch(() => {});
    const j = await apiJson<{ status: string; last_error?: string | null }>(`/jobs/${encodeURIComponent(jobId)}`);
    if (j.status === "done") break;
    if (j.status === "failed" || j.status === "cancelled") {
      throw new Error(`${label} batch ${jobId} ${j.status}: ${j.last_error ?? "no detail"}`);
    }
  }

  const detail = await apiJson<{ results?: { payload?: { final?: boolean; artifacts?: string[] } }[] }>(
    `/api/jobs/${encodeURIComponent(jobId)}`,
  );
  const finalRow = (detail.results ?? []).find((r) => r.payload?.final && (r.payload?.artifacts ?? []).length > 0);
  const outSha = finalRow?.payload?.artifacts?.[0];
  if (!outSha) throw new Error(`${label} batch ${jobId} finished without an outputs artifact`);
  const outFile = path.join(dir, `${label}-outputs.json`);
  await fetchArtifact(outSha, outFile);
  const parsed = JSON.parse(readFileSync(outFile, "utf8")) as { outputs?: { item?: number; output?: string }[] };
  const outputs = new Array<string>(items.length).fill("");
  for (const o of parsed.outputs ?? []) {
    if (typeof o.item === "number" && o.item >= 0 && o.item < items.length) outputs[o.item] = o.output ?? "";
  }
  return outputs;
}

export async function runDigest(job: Job) {
  const p = (job.params ?? {}) as DigestParams;
  const days = Math.max(1, Number(p.days ?? 7));
  const since = Date.now() - days * 86_400_000;
  const minCluster = Math.max(1, Number(p.min_cluster ?? 2));
  const date = new Date().toISOString().slice(0, 10);
  const dir = mkdtempSync(path.join(os.tmpdir(), "fleet-digest-"));

  // 1. This week's reviews, from the artifacts the daily archive pulls left.
  const found = await apiJson<{ artifacts: { sha256: string; name: string | null; created_at: string }[] }>(
    "/api/artifacts?q=reviews-&per_page=200",
  );
  const reviewArtifacts = (found.artifacts ?? []).filter((a) => /^reviews-(asc|play)-/.test(a.name ?? ""));
  const byId = new Map<string, Review>();
  for (const a of reviewArtifacts) {
    const file = path.join(dir, a.sha256);
    await fetchArtifact(a.sha256, file);
    const report = JSON.parse(readFileSync(file, "utf8")) as { reviews?: Review[] };
    for (const r of report.reviews ?? []) {
      if (Date.parse(r.date) < since) continue;
      if (p.apps && !p.apps.includes(r.app)) continue;
      byId.set(r.id, r); // pulls overlap by design; last write wins
    }
  }

  // 2. The watermark: whatever the previous digest already covered is not
  // news, however recent it still is.
  const prior = await apiJson<{ artifacts: { sha256: string; name: string | null }[] }>(
    "/api/artifacts?q=review-digest-&per_page=10",
  );
  const priorJson = (prior.artifacts ?? []).find((a) => a.name?.endsWith(".json"));
  if (priorJson) {
    const file = path.join(dir, "prior-digest.json");
    await fetchArtifact(priorJson.sha256, file);
    for (const id of (JSON.parse(readFileSync(file, "utf8")) as { covered_ids?: string[] }).covered_ids ?? []) {
      byId.delete(id);
    }
  }

  const reviews = [...byId.values()];
  if (reviews.length === 0) {
    // An empty week is a fact, not a failure — but say it, or a broken pull
    // upstream would look identical to a quiet week.
    await postResult({
      job_id: job.job_id, device_id: "web:digest", iter: 0, ok: true,
      metrics: { reviews_count: 0 },
      error: `no new reviews in the last ${days}d (from ${reviewArtifacts.length} archive artifact(s))`,
    });
    await postResult({ job_id: job.job_id, device_id: `host:${NAME}`, iter: 0, final: true, ok: true });
    log(`digest: no new reviews in the last ${days}d`);
    return;
  }

  // 3. Map: classify every review on the shelf.
  const classifyOutputs = await runShelfBatch(job, "classify", reviews.map(classifyPrompt), p);
  const classified = reviews.map((review, i) => ({ review, c: parseClassification(classifyOutputs[i], review) }));
  const parseFailures = classified.filter((x) => !x.c.parsed).length;

  // 4. Cluster deterministically by (app, tag); small clusters fold into
  // "other" so the digest reads as themes, not a list of one-offs.
  const clusters = new Map<string, { app: string; tag: Tag; members: typeof classified }>();
  for (const x of classified) {
    let key = `${x.review.app}|${x.c.tag}`;
    if (!clusters.has(key)) clusters.set(key, { app: x.review.app, tag: x.c.tag, members: [] });
    clusters.get(key)!.members.push(x);
  }
  for (const [key, cl] of [...clusters.entries()]) {
    if (cl.tag !== "other" && cl.members.length < minCluster) {
      clusters.delete(key);
      const otherKey = `${cl.app}|other`;
      if (!clusters.has(otherKey)) clusters.set(otherKey, { app: cl.app, tag: "other", members: [] });
      clusters.get(otherKey)!.members.push(...cl.members);
    }
  }
  const ordered = [...clusters.values()].sort((a, b) =>
    a.app.localeCompare(b.app) || b.members.length - a.members.length);

  // 5. Reduce: one summary paragraph per cluster, again on the shelf.
  const summaries = await runShelfBatch(
    job, "summarize", ordered.map((cl) => summarizePrompt(cl.app, cl.tag, cl.members)), p,
  );

  // 6. Assemble. The representative quote is chosen in code — the most
  // substantial short review — never generated, so it is always a real quote.
  const apps = [...new Set(reviews.map((r) => r.app))].sort();
  const lines: string[] = [`# Review digest — week ending ${date}`, ""];
  for (const app of apps) {
    const appReviews = reviews.filter((r) => r.app === app);
    const avg = appReviews.reduce((s, r) => s + r.rating, 0) / appReviews.length;
    const bySource = (s: string) => appReviews.filter((r) => r.source === s).length;
    lines.push(`## ${app}`, "",
      `${appReviews.length} new review(s), average ${avg.toFixed(2)}/5 ` +
      `(${bySource("asc")} App Store, ${bySource("play")} Play).`, "");
    for (const [i, cl] of ordered.entries()) {
      if (cl.app !== app) continue;
      const cavg = cl.members.reduce((s, m) => s + m.review.rating, 0) / cl.members.length;
      lines.push(`### ${cl.tag} — ${cl.members.length} review(s), ${cavg.toFixed(1)}/5`, "");
      lines.push((summaries[i] || "(no summary generated)").trim(), "");
      const quote = cl.members
        .filter((m) => m.review.body.length >= 20 && m.review.body.length <= 240)
        .sort((a, b) => b.review.body.length - a.review.body.length)[0];
      if (quote) {
        lines.push(`> "${quote.review.body.trim()}" — ${quote.review.author ?? "anonymous"}, ` +
          `${quote.review.rating}/5, ${quote.review.source === "asc" ? "App Store" : "Play"}`, "");
      }
    }
  }
  if (parseFailures > 0) {
    lines.push("---", `${parseFailures} of ${reviews.length} classifications did not parse and were filed under "other".`, "");
  }

  const mdFile = path.join(dir, `review-digest-${date}.md`);
  writeFileSync(mdFile, lines.join("\n"));
  const mdSha = await uploadArtifact(mdFile, `review-digest-${date}.md`);
  const jsonSha = await uploadReport(`review-digest-${date}.json`, {
    date, days, apps,
    reviews_count: reviews.length,
    parse_failures: parseFailures,
    clusters: ordered.map((cl, i) => ({
      app: cl.app, tag: cl.tag, count: cl.members.length,
      summary: (summaries[i] || "").trim(),
      review_ids: cl.members.map((m) => m.review.id),
    })),
    covered_ids: reviews.map((r) => r.id),
  });

  const avgAll = reviews.reduce((s, r) => s + r.rating, 0) / reviews.length;
  await postResult({
    job_id: job.job_id, device_id: "web:digest", iter: 0, ok: true,
    metrics: {
      reviews_count: reviews.length,
      clusters: ordered.length,
      avg_rating: Number(avgAll.toFixed(2)),
    },
    test: { passed: ordered.length, failed: 0, artifacts: [mdSha, jsonSha] },
  });
  log(`digest: ${reviews.length} reviews -> ${ordered.length} cluster(s), avg ${avgAll.toFixed(2)}/5`);
  await postResult({ job_id: job.job_id, device_id: `host:${NAME}`, iter: 0, final: true, ok: true });
}
