// Serves the built dashboard SPA at /dash.
//
// Hand-rolled rather than @fastify/static: the asset set is a handful of files
// with hashed names, and the collector's deploy story is "rebuildable over SSH
// with nobody at the keyboard" — every runtime dependency added here is one
// more thing that has to install cleanly on a 2016 MacBook with no sudo.
import type { FastifyInstance, FastifyReply } from "fastify";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { DASH_DIST } from "./config.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

const PLACEHOLDER = `<!doctype html>
<html><head><meta charset="utf-8"><title>Fleet Dashboard — not built</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
 body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 3rem auto; max-width: 40rem;
        padding: 0 1.5rem; color: #1c2025; background: #f7f8fa; line-height: 1.6; }
 @media (prefers-color-scheme: dark) { body { color: #e6e8ec; background: #16181c; } pre { background: #21242a; } }
 pre { background: #eceef2; padding: 0.9rem 1rem; border-radius: 6px; overflow-x: auto; font-size: 0.85rem; }
 code { font-family: ui-monospace, Menlo, monospace; }
 a { color: inherit; }
</style></head><body>
<h1>Dashboard not built</h1>
<p>The collector is running and its API is live — only the browser bundle is missing.</p>
<pre>cd fleet-collector/dash
npm install
npm run build</pre>
<p>Then reload. The collector picks up <code>dash/dist</code> without a restart.</p>
<p>Meanwhile: <a href="/dash/legacy">legacy dashboard</a> · <a href="/api/overview">/api/overview</a></p>
</body></html>`;

/** Resolve a URL path inside the dist directory, or null if it escapes or does
 *  not exist. Traversal is rejected on the resolved path, so encoded and
 *  nested forms of `..` are covered by the same check. */
function resolveAsset(rel: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const full = path.resolve(DASH_DIST, decoded);
  if (full !== DASH_DIST && !full.startsWith(DASH_DIST + path.sep)) return null;
  if (!existsSync(full) || !statSync(full).isFile()) return null;
  return full;
}

function sendFile(reply: FastifyReply, file: string, immutable: boolean) {
  const ext = path.extname(file).toLowerCase();
  return reply
    .header("content-type", MIME[ext] ?? "application/octet-stream")
    .header("content-length", statSync(file).size)
    // Vite fingerprints asset filenames, so those can be cached hard; the
    // entry HTML must not be, or a rebuilt dashboard never reaches the browser.
    .header("cache-control", immutable ? "public, max-age=31536000, immutable" : "no-cache")
    .send(createReadStream(file));
}

function sendIndex(reply: FastifyReply) {
  const index = path.join(DASH_DIST, "index.html");
  if (!existsSync(index)) return reply.code(200).type("text/html; charset=utf-8").send(PLACEHOLDER);
  return sendFile(reply, index, false);
}

export function registerDashStatic(app: FastifyInstance) {
  app.get("/dash", async (_req, reply) => sendIndex(reply));

  app.get("/dash/*", async (req, reply) => {
    const rel = (req.params as { "*": string })["*"];
    const file = rel ? resolveAsset(rel) : null;
    // No file at that path means a client-side route (/dash/jobs/abc): hand
    // back the SPA shell and let the router sort it out.
    if (!file) return sendIndex(reply);
    return sendFile(reply, file, rel.startsWith("assets/"));
  });
}
