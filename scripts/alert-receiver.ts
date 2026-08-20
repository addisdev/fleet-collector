/**
 * Where a red run becomes something you actually notice.
 *
 * `alerts.notify()` POSTs newly-opened alerts to `FLEET_ALERT_WEBHOOK`. Until
 * now that was unset, so the dashboard was the only channel — which fails the
 * one thing a nightly is for: nobody opens a dashboard to discover a suite they
 * assumed was green.
 *
 * **Why this runs on the workstation rather than on fleet-host.** fleet-host is
 * headless, so a notification raised there is a notification nobody sees. The
 * collector is a launchd agent and macOS 26 gates local-network access per app,
 * so it cannot reach this Mac's LAN address either — the same wall that put the
 * executor behind an ssh tunnel in the first place. So the existing tunnel
 * carries a REVERSE forward: the collector posts to its own 127.0.0.1:8790,
 * ssh delivers it here, and this raises a real notification on the machine the
 * work is being done on. Loopback at both ends, nothing on the LAN, nothing off
 * it.
 *
 * If this Mac is asleep the POST fails and `notify()` swallows it — the alert
 * is still open in the dashboard and still in the JSONL below when the link
 * comes back. Losing a notification is acceptable; losing the alert is not, and
 * that is the collector's job rather than this one's.
 */
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const PORT = Number(process.env.FLEET_ALERT_PORT ?? 8790);
const LOG = process.env.FLEET_ALERT_LOG ?? path.join(homedir(), "Library/Logs/fleet-alerts.jsonl");

/** Everything that arrives, whether or not the notification lands. */
function record(entry: object) {
  try {
    appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    // A full disk must not take the receiver down; the notification is still
    // worth attempting.
  }
}

/**
 * AppleScript string literals take backslash and double-quote escapes and
 * nothing else. Passing the message unescaped would let a job whose error text
 * contains a quote either break the notification or, worse, run as script.
 */
function osaString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function notify(title: string, message: string, critical: boolean) {
  // Truncated: Notification Center silently drops an over-long body, which
  // would turn a loud failure into a quiet one.
  const body = message.length > 240 ? message.slice(0, 237) + "…" : message;
  const script =
    `display notification "${osaString(body)}" ` +
    `with title "${osaString(title)}"` +
    (critical ? ` sound name "Basso"` : "");
  execFile("/usr/bin/osascript", ["-e", script], (err) => {
    if (err) record({ kind: "notify-failed", error: String(err) });
  });
}

createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405).end("post an alert");
    return;
  }
  let body = "";
  req.on("data", (c) => {
    body += c;
    // A webhook receiver should not be a way to exhaust this machine's memory.
    if (body.length > 64 * 1024) req.destroy();
  });
  req.on("end", () => {
    // ntfy-shaped: the collector sends a plain-text body with title/priority
    // headers, so read those and fall back to something honest.
    const title = String(req.headers["title"] ?? "fleet");
    const priority = String(req.headers["priority"] ?? "default");
    record({ kind: "alert", title, priority, body });
    notify(title, body || "(no message)", priority === "high");
    res.writeHead(204).end();
  });
}).listen(PORT, "127.0.0.1", () => {
  record({ kind: "listening", port: PORT });
  console.log(`fleet alert receiver on 127.0.0.1:${PORT}, logging to ${LOG}`);
});
