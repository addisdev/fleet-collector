// web-audit: crawl-and-audit for the fleet's own sites.
//
// The crawl uses a real browser, not fetch — these sites are SPAs, and the
// aliquant smoke spec already documents the trap: a blank body with a correct
// title is what a naive fetch would see and bless. Every page's checks run
// against the RENDERED document. (The raw-HTML perspective belongs to
// web-unfurl, deliberately.)
//
// Severity follows the fleet's red-means-something rule: `error` fails the
// nightly, `warn` is recorded in the report and the metrics but does not.
import { chromium, devices } from "playwright";
import { leaseBudgetS, log, NAME, postBeacon, postResult } from "../fleet-client.js";
import type { Job } from "../executor.js";
import { countBySeverity, readSiteConfig, resolveSiteDir, uploadReport, type Finding } from "./shared.js";

type AuditConfig = {
  max_pages?: number;
  exclude?: string[];           // regexes matched against the pathname
  external_links?: "check" | "skip";
  allow_external?: string[];    // hostnames (or regexes) never checked
  max_external?: number;
  mobile?: boolean;             // the mobile-friendliness pass; default on
  // false = this site is DELIBERATELY not for search engines (an app
  // subdomain behind a login, say). The robots.txt full block flips from the
  // audit's worst error to the expected state, and the index-oriented warns
  // (meta description, canonical, sitemap) go quiet — while everything that
  // matters regardless of indexing (broken links, empty renders, JSON-LD,
  // titles, the whole mobile pass) still runs. Default true.
  indexable?: boolean;
};

type PageRecord = {
  url: string;
  status: number | null;
  redirects: number;
  title: string | null;
  description: string | null;
  canonical: string | null;
  h1_count: number;
  noindex: boolean;
  linked_from: string[];
  findings: Finding[];
};

/** Everything the desktop pass reads out of one rendered page. */
const EXTRACT = `(() => {
  const meta = (sel) => document.querySelector(sel)?.getAttribute("content") ?? null;
  return {
    title: document.title || null,
    description: meta('meta[name="description"]'),
    robots: meta('meta[name="robots"]'),
    canonical: document.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? null,
    h1Count: document.querySelectorAll("h1").length,
    jsonLd: [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent ?? ""),
    anchors: [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")).filter(Boolean),
    bodyTextLength: (document.body?.innerText ?? "").trim().length,
  };
})()`;

/** The mobile-friendliness pass' page-side measurements. Simplified versions
 *  of what Google's mobile-friendly test measures; the tap-target rule in
 *  particular is reduced to "smaller than 24css px in both dimensions",
 *  which catches the obvious offenders without the full spacing analysis. */
const EXTRACT_MOBILE = `(() => {
  // The yardstick is screen.width (the device's ideal viewport), NOT
  // innerWidth: mobile Chrome EXPANDS the layout viewport to fit overflowing
  // content — a 1200px div on a 412px phone reports innerWidth 1208 — so
  // scrollWidth > innerWidth is a test that can never fire. Verified against
  // the stub: viewport meta present, 1200px div, innerWidth 1208.
  const vw = screen.width;
  const doc = document.documentElement;
  let smallText = 0, textNodes = 0;
  for (const el of document.querySelectorAll("p, li, span, td, a, label")) {
    const t = (el.childNodes[0]?.nodeType === 3 ? el.childNodes[0].textContent : "").trim();
    if (!t) continue;
    textNodes++;
    if (parseFloat(getComputedStyle(el).fontSize) < 12) smallText++;
    if (textNodes >= 400) break;
  }
  let tinyTargets = 0, targets = 0;
  for (const el of document.querySelectorAll("a[href], button, input, select")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    targets++;
    if (r.width < 24 && r.height < 24) tinyTargets++;
    if (targets >= 400) break;
  }
  return {
    hasViewportMeta: !!document.querySelector('meta[name="viewport"]'),
    contentWiderThanViewport: doc.scrollWidth > vw + 1,
    scrollWidth: doc.scrollWidth,
    viewportWidth: vw,
    smallTextPct: textNodes ? Math.round((smallText / textNodes) * 100) : 0,
    tinyTargets,
  };
})()`;

const normalize = (u: URL): string => {
  u.hash = "";
  return u.toString();
};

export async function runWebAudit(job: Job) {
  const startUrl = job.targets?.url;
  if (!startUrl) throw new Error("web-audit needs targets.url");
  const flows = job.suite?.flows;
  const { dir, suite } = flows ? resolveSiteDir(flows) : { dir: null, suite: new URL(startUrl).hostname };
  const config = (dir ? readSiteConfig<AuditConfig>(dir, "audit.json") : null) ?? {};

  // Browsers only exist on FLEET_WEB hosts — same honesty rule as web-test.
  if (process.env.FLEET_WEB !== "1") {
    await postResult({
      job_id: job.job_id, device_id: `host:${NAME}`, iter: 0, final: true, ok: false,
      error: `executor ${NAME} has no browsers; pin web-audit with targets.executor`,
    });
    log(`refused web-audit ${job.job_id}: no browsers on ${NAME}`);
    return;
  }

  const indexable = config.indexable !== false;
  const maxPages = Math.max(1, Number(config.max_pages ?? 200));
  const exclude = (config.exclude ?? []).map((p) => new RegExp(p));
  const origin = new URL(startUrl).origin;
  const pageTimeoutMs = Math.min(30_000, leaseBudgetS(job) * 1000);

  const pages = new Map<string, PageRecord>();
  const external = new Map<string, string[]>(); // url -> linked_from
  // Recorded at DISCOVERY time, keyed by target: a link's target usually has
  // no page record yet when the link is found (it is still in the queue), so
  // writing into the record would lose almost every linked_from — which is
  // exactly what made the broken-link check silently never fire.
  const linkedFrom = new Map<string, string[]>();
  const queue: string[] = [normalize(new URL(startUrl))];
  const queued = new Set(queue);
  const site: Finding[] = [];

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    let crawled = 0;

    while (queue.length > 0 && crawled < maxPages) {
      const url = queue.shift()!;
      crawled++;
      // The lease outlives any single page; the beacon is what lets the crawl
      // outlive the lease.
      if (crawled % 10 === 0) await postBeacon(job.job_id, "web:audit", {}).catch(() => {});

      const rec: PageRecord = {
        url, status: null, redirects: 0, title: null, description: null,
        canonical: null, h1_count: 0, noindex: false, linked_from: [], findings: [],
      };
      pages.set(url, rec);
      try {
        const res = await page.goto(url, { waitUntil: "load", timeout: pageTimeoutMs });
        rec.status = res?.status() ?? null;
        for (let r = res?.request().redirectedFrom(); r; r = r.redirectedFrom()) rec.redirects++;
        if (rec.redirects > 1) {
          rec.findings.push({ severity: "warn", check: "redirects", page: url, detail: `${rec.redirects}-hop redirect chain` });
        }
        if ((rec.status ?? 0) >= 400) {
          rec.findings.push({ severity: "error", check: "status", page: url, detail: `HTTP ${rec.status}` });
          continue;
        }
        if (!page.url().startsWith(origin)) {
          rec.findings.push({ severity: "warn", check: "redirects", page: url, detail: `redirected off-origin to ${page.url()}` });
          continue;
        }

        const d = await page.evaluate(EXTRACT) as {
          title: string | null; description: string | null; robots: string | null;
          canonical: string | null; h1Count: number; jsonLd: string[];
          anchors: string[]; bodyTextLength: number;
        };
        rec.title = d.title;
        rec.description = d.description;
        rec.canonical = d.canonical;
        rec.h1_count = d.h1Count;
        rec.noindex = /noindex/i.test(d.robots ?? "");

        if (!d.title) rec.findings.push({ severity: "error", check: "title", page: url, detail: "no <title>" });
        else if (indexable && d.title.length > 65) rec.findings.push({ severity: "warn", check: "title", page: url, detail: `title is ${d.title.length} chars; results truncate around 60` });
        if (indexable && !d.description) rec.findings.push({ severity: "warn", check: "description", page: url, detail: "no meta description" });
        else if (d.description && d.description.length > 165) rec.findings.push({ severity: "warn", check: "description", page: url, detail: `description is ${d.description.length} chars` });
        if (indexable && !d.canonical) rec.findings.push({ severity: "warn", check: "canonical", page: url, detail: "no canonical link" });
        else if (d.canonical) {
          const canon = new URL(d.canonical, url);
          if (canon.origin !== origin) rec.findings.push({ severity: "warn", check: "canonical", page: url, detail: `canonical points off-origin: ${canon}` });
        }
        if (d.h1Count === 0) rec.findings.push({ severity: "warn", check: "headings", page: url, detail: "no h1" });
        if (d.h1Count > 1) rec.findings.push({ severity: "warn", check: "headings", page: url, detail: `${d.h1Count} h1 elements` });
        if (d.bodyTextLength === 0) rec.findings.push({ severity: "error", check: "render", page: url, detail: "rendered body is empty — the SPA-shipped-broken signature" });
        for (const [i, raw] of d.jsonLd.entries()) {
          try { JSON.parse(raw); } catch { rec.findings.push({ severity: "error", check: "structured-data", page: url, detail: `JSON-LD block ${i + 1} does not parse` }); }
        }

        for (const href of d.anchors) {
          let u: URL;
          try { u = new URL(href, page.url()); } catch { continue; }
          if (!/^https?:$/.test(u.protocol)) continue;
          if (u.origin === origin) {
            const n = normalize(u);
            if (exclude.some((re) => re.test(u.pathname))) continue;
            if (!queued.has(n)) { queued.add(n); queue.push(n); }
            if (!linkedFrom.has(n)) linkedFrom.set(n, []);
            linkedFrom.get(n)!.push(url);
          } else {
            if (!external.has(u.toString())) external.set(u.toString(), []);
            external.get(u.toString())!.push(url);
          }
        }
      } catch (e) {
        rec.findings.push({ severity: "error", check: "load", page: url, detail: (e as Error).message.slice(0, 200) });
      }
    }
    if (queue.length > 0) {
      // No silent caps: the crawl stopped before the site did.
      site.push({ severity: "warn", check: "coverage", detail: `crawl stopped at max_pages=${maxPages} with ${queue.length} URLs still queued` });
    }

    // Site-level: duplicates read across every crawled page.
    for (const field of ["title", "description"] as const) {
      const byValue = new Map<string, string[]>();
      for (const r of pages.values()) {
        const v = r[field];
        if (!v) continue;
        if (!byValue.has(v)) byValue.set(v, []);
        byValue.get(v)!.push(r.url);
      }
      for (const [v, urls] of byValue) {
        if (urls.length > 1) site.push({ severity: "warn", check: `duplicate-${field}`, detail: `${urls.length} pages share the ${field} ${JSON.stringify(v.slice(0, 60))}: ${urls.slice(0, 4).join(", ")}` });
      }
    }
    // Broken internal links: a 4xx page someone links to is an error; the
    // linked_from list is what makes the report actionable.
    for (const r of pages.values()) {
      r.linked_from = linkedFrom.get(r.url) ?? [];
      if ((r.status ?? 0) >= 400 && r.linked_from.length > 0) {
        site.push({ severity: "error", check: "broken-link", detail: `${r.url} is HTTP ${r.status}, linked from ${r.linked_from.slice(0, 3).join(", ")}` });
      }
    }

    // External links: bounded, allowlisted, and only ever a warning — a
    // third party's flake must not fail our nightly.
    if ((config.external_links ?? "check") === "check") {
      const allow = (config.allow_external ?? []).map((p) => new RegExp(p));
      const toCheck = [...external.entries()]
        .filter(([u]) => !allow.some((re) => re.test(new URL(u).hostname)))
        .slice(0, Math.max(0, Number(config.max_external ?? 50)));
      for (const [u, from] of toCheck) {
        try {
          let res = await fetch(u, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(15_000) });
          // Some hosts refuse HEAD; that is their right, not a broken link.
          if (res.status === 405 || res.status === 501) res = await fetch(u, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(15_000) });
          if (res.status >= 400) site.push({ severity: "warn", check: "external-link", detail: `${u} -> HTTP ${res.status} (linked from ${from[0]})` });
        } catch {
          site.push({ severity: "warn", check: "external-link", detail: `${u} unreachable (linked from ${from[0]})` });
        }
      }
      if (external.size > toCheck.length) {
        site.push({ severity: "warn", check: "coverage", detail: `${external.size - toCheck.length} external links not checked (allowlisted or over max_external)` });
      }
    }

    // sitemap.xml vs what the crawl found. A non-indexable site needs no
    // sitemap, so the whole comparison is skipped rather than warned about.
    if (indexable) try {
      const res = await fetch(new URL("/sitemap.xml", origin), { signal: AbortSignal.timeout(15_000) });
      if (res.ok) {
        const locs = [...(await res.text()).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
        let checked = 0;
        for (const loc of locs) {
          let n: string;
          try { n = normalize(new URL(loc)); } catch { site.push({ severity: "error", check: "sitemap", detail: `sitemap <loc> is not a URL: ${loc.slice(0, 100)}` }); continue; }
          if (pages.has(n) || checked >= 50) continue;
          checked++;
          const head = await fetch(n, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(15_000) }).catch(() => null);
          if (!head || head.status >= 400) {
            site.push({ severity: "error", check: "sitemap", detail: `sitemap lists ${n} which answers HTTP ${head?.status ?? "nothing"}` });
          }
        }
        const inSitemap = new Set(locs.map((l) => { try { return normalize(new URL(l)); } catch { return l; } }));
        const missing = [...pages.values()].filter((r) => (r.status ?? 0) < 400 && !r.noindex && !inSitemap.has(r.url));
        if (missing.length > 0) site.push({ severity: "warn", check: "sitemap", detail: `${missing.length} crawled page(s) absent from sitemap.xml, e.g. ${missing[0].url}` });
      } else {
        site.push({ severity: "warn", check: "sitemap", detail: `no sitemap.xml (HTTP ${res.status})` });
      }
    } catch (e) {
      site.push({ severity: "warn", check: "sitemap", detail: `sitemap fetch failed: ${(e as Error).message.slice(0, 100)}` });
    }

    // robots.txt sanity. For an indexable site a full block is the audit's
    // worst error; for a deliberately non-indexable one the full block IS the
    // correct state, and a robots.txt that permits crawling is the surprise.
    try {
      const res = await fetch(new URL("/robots.txt", origin), { signal: AbortSignal.timeout(15_000) });
      const blocked = res.ok &&
        /^user-agent:\s*\*\s*$[\s\S]{0,200}?^disallow:\s*\/\s*$/im.test(await res.clone().text());
      if (indexable) {
        if (!res.ok) site.push({ severity: "warn", check: "robots", detail: `no robots.txt (HTTP ${res.status})` });
        else if (blocked) site.push({ severity: "error", check: "robots", detail: "robots.txt disallows / for every crawler — the whole site is blocked from indexing" });
      } else if (!blocked) {
        site.push({ severity: "warn", check: "robots", detail: "audit.json declares this site non-indexable, but robots.txt permits crawling" });
      }
    } catch (e) {
      if (indexable) site.push({ severity: "warn", check: "robots", detail: `robots.txt fetch failed: ${(e as Error).message.slice(0, 100)}` });
    }

    // The mobile-friendliness pass: same URL list, rendered under a phone
    // profile, findings in their own check namespace.
    if (config.mobile !== false) {
      const mobileContext = await browser.newContext({ ...devices["Pixel 7"] });
      const mPage = await mobileContext.newPage();
      let i = 0;
      for (const rec of pages.values()) {
        if ((rec.status ?? 0) >= 400) continue;
        i++;
        if (i % 10 === 0) await postBeacon(job.job_id, "web:audit", {}).catch(() => {});
        try {
          await mPage.goto(rec.url, { waitUntil: "load", timeout: pageTimeoutMs });
          const m = await mPage.evaluate(EXTRACT_MOBILE) as {
            hasViewportMeta: boolean; contentWiderThanViewport: boolean;
            scrollWidth: number; viewportWidth: number; smallTextPct: number; tinyTargets: number;
          };
          if (!m.hasViewportMeta) {
            // The flagship: without the meta, mobile browsers render at the
            // 980px fallback width — the web-shots stub demonstrated exactly
            // this, at 980css px on every mobile profile.
            rec.findings.push({ severity: "error", check: "mobile-viewport", page: rec.url, detail: "no viewport meta — mobile renders at the 980px fallback width" });
          }
          if (m.contentWiderThanViewport && m.hasViewportMeta) {
            // Without the meta this is implied by the viewport error above;
            // flagging both would state one defect twice.
            rec.findings.push({ severity: "error", check: "mobile-overflow", page: rec.url, detail: `content is ${m.scrollWidth}px wide on a ${m.viewportWidth}px-wide device (horizontal scrolling)` });
          }
          if (m.smallTextPct > 60) {
            rec.findings.push({ severity: "warn", check: "mobile-text", page: rec.url, detail: `${m.smallTextPct}% of sampled text is below 12px` });
          }
          if (m.tinyTargets > 0) {
            rec.findings.push({ severity: "warn", check: "mobile-tap-targets", page: rec.url, detail: `${m.tinyTargets} tap target(s) smaller than 24px in both dimensions` });
          }
        } catch (e) {
          rec.findings.push({ severity: "warn", check: "mobile-load", page: rec.url, detail: (e as Error).message.slice(0, 150) });
        }
      }
      await mobileContext.close();
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const all: Finding[] = [...site, ...[...pages.values()].flatMap((r) => r.findings)];
  const totals = countBySeverity(all);
  const sha = await uploadReport(`${job.job_id}-audit-report.json`, {
    suite, start_url: startUrl,
    pages_crawled: pages.size,
    pages: Object.fromEntries([...pages.entries()].map(([u, r]) => [u, { ...r, linked_from: r.linked_from.slice(0, 10) }])),
    site_findings: site,
    totals,
  });
  const ok = totals.issues_error === 0;
  const firstError = all.find((f) => f.severity === "error");
  await postResult({
    job_id: job.job_id, device_id: "web:audit", iter: 0, ok,
    metrics: { pages_crawled: pages.size, ...totals },
    test: { passed: pages.size - new Set(all.filter((f) => f.severity === "error").map((f) => f.page ?? "site")).size, failed: new Set(all.filter((f) => f.severity === "error").map((f) => f.page ?? "site")).size, artifacts: [sha] },
    error: ok ? undefined : `${totals.issues_error} error(s), e.g. ${firstError?.check}: ${firstError?.detail.slice(0, 140)}`,
  });
  log(`web-audit ${startUrl}: ${pages.size} pages, ${totals.issues_error} errors / ${totals.issues_warn} warnings`);
  await postResult({ job_id: job.job_id, device_id: `host:${NAME}`, iter: 0, final: true, ok });
}
