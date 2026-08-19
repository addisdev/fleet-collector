// Read-only schedule list. Enabling, running now, and editing the template are
// D4 — but the legacy dashboard listed every schedule including the disabled
// ones, and the overview only shows the next few enabled, so without this page
// a disabled nightly run is invisible in the SPA.
import { useApi } from "../api.js";
import { Json, Loaded, Panel, Pill, Stat, clock, duration } from "../ui.js";

type Schedule = {
  id: string;
  cron: string;
  enabled: boolean;
  last_run: string | null;
  next_run: string | null;
  next_run_in_s: number | null;
  prev_expected: string | null;
  missed: boolean;
  late_by_s: number | null;
  workload: string | null;
  executor: string | null;
  fanout: boolean;
  pool: string | null;
  template: Record<string, unknown>;
};

export function Schedules() {
  const state = useApi<{ schedules: Schedule[] }>("/api/schedules", ["schedule", "job"], 30_000);

  return (
    <>
      <h1>Schedules</h1>
      <Loaded state={state} what="schedules">
        {(d) => (
          <>
            <Panel>
              <div class="stats">
                <Stat label="total" value={d.schedules.length} />
                <Stat label="enabled" value={d.schedules.filter((s) => s.enabled).length} tone="ok" />
                <Stat
                  label="missed"
                  value={d.schedules.filter((s) => s.missed).length}
                  tone={d.schedules.some((s) => s.missed) ? "bad" : undefined}
                />
              </div>
            </Panel>

            {d.schedules.length === 0 ? (
              <Panel>
                <p class="empty">No schedules. Nightly runs are created with POST /schedules.</p>
              </Panel>
            ) : (
              d.schedules.map((s) => (
                <Panel
                  key={s.id}
                  title={s.id}
                  aside={
                    <span>
                      {s.missed && <Pill kind="failed">missed</Pill>} <Pill kind={s.enabled ? "done" : "queued"}>{s.enabled ? "on" : "off"}</Pill>
                    </span>
                  }
                >
                  <div class="stats">
                    <Stat label="cron" value={<code>{s.cron}</code>} />
                    <Stat label="workload" value={s.workload ?? "—"} />
                    <Stat label="next run" value={s.enabled && s.next_run_in_s != null ? `in ${duration(s.next_run_in_s)}` : "—"} />
                    <Stat label="last run" value={s.last_run ?? "never"} />
                  </div>
                  <p class="empty">
                    {s.executor ? `${s.executor} executor` : "no executor"}
                    {s.pool ? ` · pool ${s.pool}` : ""}
                    {s.fanout ? " · fans out to every matching device" : ""}
                    {s.enabled && s.next_run ? ` · next ${clock(s.next_run)}` : ""}
                    {s.missed && s.late_by_s != null ? ` · overdue by ${duration(s.late_by_s)}` : ""}
                  </p>
                  <Json value={s.template} label="job template" />
                </Panel>
              ))
            )}

            <p class="stub">Enable, disable, run-now, and template editing arrive in D4.</p>
          </>
        )}
      </Loaded>
    </>
  );
}
