// web-unfurl: what link-preview bots actually see.
//
// Unfurl bots — Slack, iMessage, Twitter, Facebook — do NOT execute
// JavaScript, so this workload deliberately fetches RAW HTML, the exact
// opposite of web-audit's rendered crawl. The contrast is the feature: og
// tags injected client-side unfurl as nothing on every platform, and a
// browser-based check can never see that bug.
//
// No browser, no FLEET_WEB gate: a few dozen fetches run anywhere with a
// network path to the site.
import { log, NAME, postResult } from "../fleet-client.js";
import type { Job } from "../executor.js";
import { countBySeverity, readSiteConfig, resolveSiteDir, uploadReport, type Finding } from "./shared.js";

type UnfurlPage = { name?: string; path?: string };
type UnfurlConfig = {
  pages?: UnfurlPage[];
  // Extra or replacement bot user-agents, name -> UA string.
  agents?: Record<string, string>;
  image?: { min_px?: number; warn_bytes?: number };
};

// The bots whose previews people actually complain about. A site may UA-gate,
// which is why every page is fetched once per agent and the tag sets compared.
const DEFAULT_AGENTS: Record<string, string> = {
  slack: "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
  twitter: "Twitterbot/1.0",
  facebook: "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
};

// Platform truncation happens around here; over is a warn, not an error.
const TITLE_WARN_LEN = 70;
const DESC_WARN_LEN = 200;

/**
 * Meta tags from raw HTML, by property/name. Regex, not a DOM: the documents
 * are our own sites' heads, and the alternative is a parser dependency for
 * tags this shape. The same pragmatism as parseJunit.
 */
export function metaTags(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/<meta\s[^>]*>/gi)) {
    const tag = m[0];
    const key = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    const content = /content\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (key && content !== undefined && !(key in out)) out[key] = content;
  }
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim();
  if (title) out["html:title"] = title;
  return out;
}

/** Width/height from PNG, JPEG or GIF bytes; null when unrecognised. */
export function imageDims(buf: Buffer): { w: number; h: number } | null {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf.length > 10 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    // Scan JPEG markers for a start-of-frame, which carries the dimensions.
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      }
      i += 2 + (buf.readUInt16BE(i + 2) || 1);
    }
  }
  return null;
}

async function checkPage(
  pageName: string, pageUrl: string, agents: Record<string, string>,
  imageCfg: { min_px: number; warn_bytes: number },
): Promise<{ findings: Finding[]; tags: Record<string, string> }> {
  const findings: Finding[] = [];
  const perAgent = new Map<string, Record<string, string>>();

  for (const [agent, ua] of Object.entries(agents)) {
    try {
      const res = await fetch(pageUrl, {
        headers: { "user-agent": ua, accept: "text/html" },
        redirect: "follow",
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status >= 400) {
        findings.push({ severity: "error", check: "fetch", page: pageName, detail: `${agent}: HTTP ${res.status}` });
        continue;
      }
      perAgent.set(agent, metaTags(await res.text()));
    } catch (e) {
      findings.push({ severity: "error", check: "fetch", page: pageName, detail: `${agent}: ${(e as Error).message.slice(0, 120)}` });
    }
  }
  const tags = perAgent.values().next().value ?? {};
  if (perAgent.size === 0) return { findings, tags };

  // UA-dependent unfurls: same page, different tags per bot.
  const shapes = new Set([...perAgent.values()].map((t) =>
    JSON.stringify(Object.entries(t).filter(([k]) => k.startsWith("og:") || k.startsWith("twitter:")).sort())));
  if (shapes.size > 1) {
    findings.push({
      severity: "warn", check: "ua-consistency", page: pageName,
      detail: `og/twitter tags differ between ${[...perAgent.keys()].join("/")} — previews will vary by platform`,
    });
  }

  // Required tags, in the RAW response — the whole point of this workload.
  for (const required of ["og:title", "og:description", "og:image"]) {
    if (!tags[required]?.trim()) {
      findings.push({
        severity: "error", check: "og-tags", page: pageName,
        detail: `${required} missing or empty in the raw HTML (client-side injection does not unfurl)`,
      });
    }
  }
  for (const wanted of ["og:url", "twitter:card"]) {
    if (!tags[wanted]?.trim()) {
      findings.push({ severity: "warn", check: "og-tags", page: pageName, detail: `${wanted} missing` });
    }
  }
  if ((tags["og:title"]?.length ?? 0) > TITLE_WARN_LEN) {
    findings.push({ severity: "warn", check: "length", page: pageName, detail: `og:title is ${tags["og:title"].length} chars; platforms truncate around ${TITLE_WARN_LEN}` });
  }
  if ((tags["og:description"]?.length ?? 0) > DESC_WARN_LEN) {
    findings.push({ severity: "warn", check: "length", page: pageName, detail: `og:description is ${tags["og:description"].length} chars; platforms truncate around ${DESC_WARN_LEN}` });
  }

  // The image itself: it must fetch, be an image, and be big enough to show.
  const image = tags["og:image"]?.trim();
  if (image) {
    let imageUrl: URL | null = null;
    try {
      imageUrl = new URL(image, pageUrl);
      if (!/^https?:/.test(image)) {
        findings.push({ severity: "warn", check: "og-image", page: pageName, detail: "og:image is a relative URL; the spec wants absolute and some scrapers refuse to resolve it" });
      }
    } catch {
      findings.push({ severity: "error", check: "og-image", page: pageName, detail: `og:image is not a URL: ${image.slice(0, 100)}` });
    }
    if (imageUrl) {
      try {
        const res = await fetch(imageUrl, { redirect: "follow", signal: AbortSignal.timeout(20_000) });
        const type = res.headers.get("content-type") ?? "";
        if (res.status >= 400) {
          findings.push({ severity: "error", check: "og-image", page: pageName, detail: `og:image fetch -> HTTP ${res.status}` });
        } else if (!type.startsWith("image/")) {
          findings.push({ severity: "error", check: "og-image", page: pageName, detail: `og:image content-type is ${type || "missing"}` });
        } else {
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length > imageCfg.warn_bytes) {
            findings.push({ severity: "warn", check: "og-image", page: pageName, detail: `og:image is ${(buf.length / 1048576).toFixed(1)}MB; platforms cap around ${(imageCfg.warn_bytes / 1048576).toFixed(0)}MB` });
          }
          const dims = imageDims(buf);
          if (dims && (dims.w < imageCfg.min_px || dims.h < imageCfg.min_px)) {
            findings.push({ severity: "error", check: "og-image", page: pageName, detail: `og:image is ${dims.w}x${dims.h}; below ${imageCfg.min_px}px platforms drop the preview image` });
          }
        }
      } catch (e) {
        findings.push({ severity: "error", check: "og-image", page: pageName, detail: `og:image fetch failed: ${(e as Error).message.slice(0, 120)}` });
      }
    }
  }
  return { findings, tags };
}

export async function runWebUnfurl(job: Job) {
  const url = job.targets?.url;
  if (!url) throw new Error("web-unfurl needs targets.url");
  const flows = job.suite?.flows;
  if (!flows) throw new Error("web-unfurl needs suite.flows (the web-specs/<site> directory holding unfurl.json)");
  const { dir, suite } = resolveSiteDir(flows);
  const config = readSiteConfig<UnfurlConfig>(dir, "unfurl.json");
  if (!config) throw new Error(`no unfurl manifest: ${dir}/unfurl.json`);
  const pages = config.pages ?? [];
  if (pages.length === 0) throw new Error("unfurl.json lists no pages");
  for (const p of pages) {
    if (!p.name || !p.path) throw new Error(`unfurl.json page needs name and path: ${JSON.stringify(p)}`);
  }
  const agents = config.agents ?? DEFAULT_AGENTS;
  const imageCfg = { min_px: config.image?.min_px ?? 200, warn_bytes: config.image?.warn_bytes ?? 5 * 1048576 };

  const all: Finding[] = [];
  const perPage: Record<string, { url: string; findings: Finding[]; tags: Record<string, string> }> = {};
  let allOk = true;
  for (const [pi, p] of pages.entries()) {
    const pageUrl = new URL(p.path!, url).toString();
    const { findings, tags } = await checkPage(p.name!, pageUrl, agents, imageCfg);
    all.push(...findings);
    perPage[p.name!] = { url: pageUrl, findings, tags };
    const counts = countBySeverity(findings);
    const ok = counts.issues_error === 0;
    if (!ok) allOk = false;
    await postResult({
      job_id: job.job_id, device_id: "web:unfurl", iter: pi + 1, ok,
      metrics: counts,
      error: findings[0] ? `${findings.length} finding(s): ${findings[0].detail.slice(0, 140)}` : undefined,
    });
    log(`web-unfurl ${pageUrl}: ${counts.issues_error} errors / ${counts.issues_warn} warnings`);
  }

  const totals = countBySeverity(all);
  const sha = await uploadReport(`${job.job_id}-unfurl-report.json`, {
    suite, base_url: url, agents: Object.keys(agents), pages: perPage, totals,
  });
  const failedPages = pages.filter((p) => countBySeverity(perPage[p.name!].findings).issues_error > 0).length;
  await postResult({
    job_id: job.job_id, device_id: "web:unfurl", iter: 0, ok: allOk,
    metrics: totals,
    test: { passed: pages.length - failedPages, failed: failedPages, artifacts: [sha] },
    error: allOk ? undefined : `${totals.issues_error} error(s) across ${pages.length} page(s)`,
  });
  await postResult({ job_id: job.job_id, device_id: `host:${NAME}`, iter: 0, final: true, ok: allOk });
}
