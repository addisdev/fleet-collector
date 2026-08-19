// Alerts: what the collector thinks is wrong right now, and what it thought
// was wrong earlier.
import { useApi } from "../api.js";
import { mutate, useMutation } from "../mutate.js";
import { useQuery } from "../router.js";
import { Actions, Button, ErrorBox, Link, Loaded, Panel, Pill, Stat, agoFrom, clock, duration } from "../ui.js";

export type Alert = {
  id: number;
  rule: string;
  subject: string;
  severity: "warning" | "critical";
  message: string;
  state: "open" | "acked" | "snoozed" | "resolved";
  first_seen: string | null;
  last_seen: string | null;
  resolved_at: string | null;
  snooze_until: string | null;
  seen_count: number;
  age_s: number;
};
export type AlertList = {
  alerts: Alert[];
  counts: Record<string, number>;
  webhook: boolean;
  thresholds: Record<string, number>;
};

/** Where an alert's subject actually lives, so a name is a link. */
function subjectLink(a: Alert) {
  if (a.rule.startsWith("device-") || a.rule === "thermal-critical" || a.rule === "low-battery")
    return <Link to={`/devices/${encodeURIComponent(a.subject)}`}><code>{a.subject}</code></Link>;
  if (a.rule.startsWith("job-")) return <Link to={`/jobs/${encodeURIComponent(a.subject)}`}><code>{a.subject}</code></Link>;
  if (a.rule === "schedule-missed") return <Link to="/schedules"><code>{a.subject}</code></Link>;
  return <code>{a.subject}</code>;
}

function AlertActions({ a, onDone }: { a: Alert; onDone: () => void }) {
  const ack = useMutation(async () => {
    const r = await mutate("POST", `/api/alerts/${a.id}/ack`, {});
    onDone();
    return r;
  });
  const snooze = useMutation(async () => {
    const r = await mutate("POST", `/api/alerts/${a.id}/snooze`, { minutes: 60 });
    onDone();
    return r;
  });

  if (a.state === "resolved") return null;
  return (
    <>
      <Actions>
        {a.state !== "acked" && (
          <Button busy={ack.busy} onClick={() => void ack.go()} title="Stop it nagging; it stays listed until the condition clears">
            Acknowledge
          </Button>
        )}
        {a.state !== "snoozed" && (
          <Button busy={snooze.busy} onClick={() => void snooze.go()} title="Quiet for an hour, then it comes back on its own">
            Snooze 1h
          </Button>
        )}
      </Actions>
      {ack.error && <ErrorBox error={ack.error} />}
      {snooze.error && <ErrorBox error={snooze.error} />}
    </>
  );
}

export function Alerts() {
  const [q, setQuery] = useQuery();
  const showResolved = q.get("resolved") === "true";
  const state = useApi<AlertList>(
    `/api/alerts?state=${showResolved ? "open,acked,snoozed,resolved" : "open,acked,snoozed"}`,
    ["alert", "job", "device"],
    30_000,
  );

  return (
    <>
      <h1>Alerts</h1>
      <Loaded state={state} what="alerts">
        {(d) => (
          <>
            <Panel>
              <div class="stats">
                <Stat label="open" value={d.counts.open ?? 0} tone={(d.counts.open ?? 0) > 0 ? "bad" : "ok"} />
                <Stat label="acknowledged" value={d.counts.acked ?? 0} />
                <Stat label="snoozed" value={d.counts.snoozed ?? 0} />
                <Stat label="resolved" value={d.counts.resolved ?? 0} />
              </div>
              <p class="empty">
                {d.webhook
                  ? "A webhook is configured, so newly opened alerts also go to your phone."
                  : "No FLEET_ALERT_WEBHOOK is set, so this dashboard is the only place alerts appear."}{" "}
                A device is called offline after {duration(d.thresholds.deviceOfflineS)}; a schedule is called missed{" "}
                {duration(d.thresholds.scheduleLateS)} after it should have fired.
              </p>
              <label class="field checkbox">
                <input
                  type="checkbox"
                  checked={showResolved}
                  onChange={(e) => setQuery({ resolved: (e.target as HTMLInputElement).checked ? "true" : null })}
                />
                <span>include resolved</span>
              </label>
            </Panel>

            {d.alerts.length === 0 ? (
              <Panel>
                <p class="empty">Nothing is wrong. The collector re-checks every minute.</p>
              </Panel>
            ) : (
              d.alerts.map((a) => (
                <Panel
                  key={a.id}
                  title={a.rule}
                  aside={
                    <span>
                      <Pill kind={a.state === "resolved" ? "done" : a.severity === "critical" ? "failed" : "claimed"}>
                        {a.state === "resolved" ? "resolved" : a.severity}
                      </Pill>{" "}
                      {a.state !== "open" && a.state !== "resolved" && <Pill kind="queued">{a.state}</Pill>}
                    </span>
                  }
                >
                  <p class={a.severity === "critical" && a.state !== "resolved" ? "error" : "stub"}>{a.message}</p>
                  <p class="empty">
                    {subjectLink(a)} · first seen {clock(a.first_seen)} · last seen {agoFrom(a.last_seen)} ·{" "}
                    {/* seen_count is how many one-minute ticks found it still
                        true, which is the honest measure of how long it lasted. */}
                    seen {a.seen_count}×
                    {a.state === "snoozed" && a.snooze_until ? ` · wakes ${clock(a.snooze_until)}` : ""}
                    {a.resolved_at ? ` · resolved ${clock(a.resolved_at)}` : ""}
                  </p>
                  <AlertActions a={a} onDone={state.reload} />
                </Panel>
              ))
            )}
          </>
        )}
      </Loaded>
    </>
  );
}

/** The banner every screen carries. Silent unless something is actually open. */
export function AlertBanner() {
  const state = useApi<AlertList>("/api/alerts?state=open", ["alert", "job", "device"], 60_000);
  const open = state.data?.alerts ?? [];
  if (open.length === 0) return null;
  const worst = open.some((a) => a.severity === "critical") ? "critical" : "warning";
  return (
    <Link to="/alerts" class={`banner ${worst}`}>
      <strong>{open.length}</strong> open alert{open.length === 1 ? "" : "s"} — {open[0].message}
      {open.length > 1 ? ` (+${open.length - 1} more)` : ""}
    </Link>
  );
}
