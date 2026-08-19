// The alert engine (plan D5).
//
// Rules are pure functions over the database: each returns the set of things
// currently wrong. A reconcile pass then decides what is new, what is still
// true, and what has stopped being true — so an alert is a *state*, not an
// event, and a condition that persists for six hours is one row rather than
// three hundred and sixty.
//
// Nothing here notifies more than once for the same condition, and nothing
// notifies at all for an alert someone has acknowledged or snoozed. An alerting
// system that cries wolf gets muted, and a muted alerting system is worse than
// none.
import { db } from "./db.js";
import { beaconFields, deviceStatus, effectivePools, hasBattery, parse } from "./api/shared.js";
import { minuteKey, prevRun } from "./cron.js";

export type Severity = "warning" | "critical";
export type Finding = { rule: string; subject: string; severity: Severity; message: string };

const env = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export const THRESHOLDS = {
  deviceOfflineS: env("FLEET_ALERT_DEVICE_OFFLINE_S", 15 * 60),
  scheduleLateS: env("FLEET_ALERT_SCHEDULE_LATE_S", 5 * 60),
  stuckMultiple: env("FLEET_ALERT_STUCK_LEASE_MULTIPLE", 2),
  lowBatteryPct: env("FLEET_ALERT_LOW_BATTERY_PCT", 15),
  dbBytes: env("FLEET_ALERT_DB_BYTES", 2 * 1024 * 1024 * 1024),
  logBytes: env("FLEET_ALERT_LOG_BYTES", 200 * 1024 * 1024),
};

/** Every rule, evaluated against the current database. */
export function evaluate(now = new Date(), sizes: { dbBytes: number; logBytes: number }): Finding[] {
  const out: Finding[] = [];

  // --- devices ---
  const devices = db
    .prepare(
      `SELECT device_id, pools, pools_override, last_beacon, name,
              CAST(strftime('%s','now') - strftime('%s', last_seen) AS INTEGER) AS age_s
       FROM devices`,
    )
    .all() as {
    device_id: string;
    pools: string;
    pools_override: string | null;
    last_beacon: string | null;
    name: string | null;
    age_s: number;
  }[];

  for (const d of devices) {
    // The device's name if it has one, always with the id, because an alert
    // is often read somewhere the id is what you need to act on it.
    const label = d.name ? `${d.name} (${d.device_id})` : d.device_id;
    if (d.age_s > THRESHOLDS.deviceOfflineS) {
      out.push({
        rule: "device-offline",
        subject: d.device_id,
        severity: "warning",
        message: `${label} has not checked in for ${Math.round(d.age_s / 60)} min`,
      });
      // Battery and thermal readings from a silent device describe whenever it
      // went silent, so they are not worth alerting on.
      continue;
    }

    const b = beaconFields(parse<Record<string, unknown> | null>(d.last_beacon, null));
    if (b?.thermal === "critical")
      out.push({ rule: "thermal-critical", subject: d.device_id, severity: "critical", message: `${label} is thermally critical` });
    if (hasBattery(b?.battery_pct) && b!.battery_pct! < THRESHOLDS.lowBatteryPct && b?.charging === false)
      out.push({
        rule: "low-battery",
        subject: d.device_id,
        severity: "warning",
        message: `${label} is at ${b!.battery_pct}% and not charging`,
      });
  }

  // --- jobs ---
  for (const j of db
    .prepare(
      `SELECT job_id, workload, claimed_by, last_error, attempts, max_attempts FROM jobs
       WHERE status = 'failed' AND finished_at >= datetime('now', '-24 hours')`,
    )
    .all() as { job_id: string; workload: string; claimed_by: string | null; last_error: string | null; attempts: number; max_attempts: number }[]) {
    out.push({
      rule: "job-failed",
      subject: j.job_id,
      severity: "warning",
      message: `${j.workload} job ${j.job_id} failed after ${j.attempts}/${j.max_attempts}${j.last_error ? `: ${j.last_error}` : ""}`,
    });
  }

  // Stuck: the lease is being renewed, so the runner is alive and beaconing,
  // but it has produced nothing. A dead runner is the sweep's problem; this is
  // the case the sweep cannot see, because beacons keep the claim fresh forever.
  for (const j of db
    .prepare(
      `SELECT j.job_id, j.workload, j.claimed_by, j.lease_ttl_s,
              CAST(strftime('%s','now') - strftime('%s', j.claimed_at) AS INTEGER) AS held_s
       FROM jobs j
       WHERE j.status = 'claimed' AND j.claimed_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM results r WHERE r.job_id = j.job_id)`,
    )
    .all() as { job_id: string; workload: string; claimed_by: string | null; lease_ttl_s: number; held_s: number }[]) {
    if (j.held_s > j.lease_ttl_s * THRESHOLDS.stuckMultiple)
      out.push({
        rule: "job-stuck",
        subject: j.job_id,
        severity: "warning",
        message: `${j.workload} job ${j.job_id} has been claimed by ${j.claimed_by ?? "?"} for ${Math.round(j.held_s / 60)} min with no results`,
      });
  }

  // --- schedules ---
  for (const s of db.prepare("SELECT id, cron, last_run FROM schedules WHERE enabled = 1").all() as {
    id: string;
    cron: string;
    last_run: string | null;
  }[]) {
    const prev = prevRun(s.cron, now);
    // A schedule that has never run has no history to be late against, so a
    // freshly enabled one does not immediately alarm.
    if (!prev || s.last_run == null) continue;
    const lateS = (now.getTime() - prev.getTime()) / 1000;
    if (s.last_run !== minuteKey(prev) && lateS > THRESHOLDS.scheduleLateS)
      out.push({
        rule: "schedule-missed",
        subject: s.id,
        severity: "warning",
        message: `schedule ${s.id} should have fired at ${minuteKey(prev)} and did not`,
      });
  }

  // --- collector ---
  if (sizes.dbBytes > THRESHOLDS.dbBytes)
    out.push({
      rule: "db-size",
      subject: "collector",
      severity: "warning",
      message: `the database is ${(sizes.dbBytes / 1e9).toFixed(1)} GB — prune beacons on the System screen`,
    });
  if (sizes.logBytes > THRESHOLDS.logBytes)
    out.push({
      rule: "log-size",
      subject: "collector",
      severity: "warning",
      message: `the log is ${(sizes.logBytes / 1e6).toFixed(0)} MB and launchd does not rotate it`,
    });

  return out;
}

export type AlertRow = {
  id: number;
  rule: string;
  subject: string;
  severity: string;
  message: string;
  state: string;
  first_seen: string;
  last_seen: string;
  resolved_at: string | null;
  snooze_until: string | null;
  seen_count: number;
  notified: number;
};

/**
 * Fold the current findings into stored state. Returns the alerts that just
 * opened — the only ones worth notifying about, since everything else is
 * either already known or already handled.
 */
export const reconcile = db.transaction((findings: Finding[]): AlertRow[] => {
  const open = db.prepare("SELECT * FROM alerts WHERE state != 'resolved'").all() as AlertRow[];
  // NUL as the separator, written as an escape rather than a raw byte: no rule
  // name or subject can contain one, so no two pairs collide the way
  // ("a-b","c") and ("a","b-c") would with a printable separator. The raw byte
  // this replaces made git classify the entire file as binary.
  const key = (r: { rule: string; subject: string }) => `${r.rule}\u0000${r.subject}`;
  const current = new Map(findings.map((f) => [key(f), f]));
  const opened: AlertRow[] = [];

  for (const a of open) {
    if (current.has(key(a))) {
      const f = current.get(key(a))!;
      // Still true: refresh the wording (an offline device's minute count
      // changes) and count the sighting, but never re-notify.
      db.prepare(
        `UPDATE alerts SET last_seen = datetime('now'), seen_count = seen_count + 1,
                           message = ?, severity = ?
         WHERE id = ?`,
      ).run(f.message, f.severity, a.id);
      current.delete(key(a));
    } else {
      // Stopped being true. Resolving rather than deleting keeps the history
      // that says a device was offline for an hour last Tuesday.
      db.prepare("UPDATE alerts SET state = 'resolved', resolved_at = datetime('now') WHERE id = ?").run(a.id);
    }
  }

  for (const f of current.values()) {
    const info = db
      .prepare(
        `INSERT INTO alerts (rule, subject, severity, message, state, first_seen, last_seen)
         VALUES (?, ?, ?, ?, 'open', datetime('now'), datetime('now'))`,
      )
      .run(f.rule, f.subject, f.severity, f.message);
    opened.push(db.prepare("SELECT * FROM alerts WHERE id = ?").get(Number(info.lastInsertRowid)) as AlertRow);
  }

  return opened;
});

/** Snoozed alerts wake up on their own once the snooze expires. */
export function expireSnoozes() {
  db.prepare(
    `UPDATE alerts SET state = 'open', snooze_until = NULL
     WHERE state = 'snoozed' AND snooze_until IS NOT NULL AND snooze_until <= datetime('now')`,
  ).run();
}

const WEBHOOK = process.env.FLEET_ALERT_WEBHOOK;

/**
 * Push newly opened alerts somewhere a phone will see them. ntfy-shaped by
 * default (a plain POST body works for ntfy.sh and most webhook receivers).
 * Unset means the dashboard is the only channel, which is the default.
 */
export async function notify(alerts: AlertRow[], log: (o: object, m: string) => void) {
  if (!WEBHOOK || alerts.length === 0) return;
  for (const a of alerts) {
    try {
      const res = await fetch(WEBHOOK, {
        method: "POST",
        headers: {
          "content-type": "text/plain; charset=utf-8",
          // ntfy reads these; other receivers ignore them harmlessly.
          title: `fleet: ${a.rule}`,
          priority: a.severity === "critical" ? "high" : "default",
          tags: a.severity === "critical" ? "rotating_light" : "warning",
        },
        body: a.message,
      });
      if (!res.ok) log({ status: res.status, rule: a.rule }, "alert webhook rejected");
    } catch (e) {
      // A webhook that is down must never take the collector with it.
      log({ err: String(e), rule: a.rule }, "alert webhook failed");
    }
  }
}

export const webhookConfigured = () => !!WEBHOOK;
