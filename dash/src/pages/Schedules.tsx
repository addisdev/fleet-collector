// Read-only schedule list. Enabling, running now, and editing the template are
// D4 — but the legacy dashboard listed every schedule including the disabled
// ones, and the overview only shows the next few enabled, so without this page
// a disabled nightly run is invisible in the SPA.
import { useApi } from "../api.js";
import { mutate, useMutation } from "../mutate.js";
import { navigate } from "../router.js";
import { Actions, Button, ConfirmButton, ErrorBox, Json, Loaded, Panel, Pill, Stat, clock, duration } from "../ui.js";

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

function ScheduleActions({ s, onDone }: { s: Schedule; onDone: () => void }) {
  const toggle = useMutation(async () => {
    const r = await mutate("PATCH", `/api/schedules/${encodeURIComponent(s.id)}`, { enabled: !s.enabled });
    onDone();
    return r;
  });
  const runNow = useMutation(async () => {
    const r = await mutate<{ job_id?: string; fanout?: string[] }>("POST", `/api/schedules/${encodeURIComponent(s.id)}/run`, {});
    onDone();
    if (r.job_id) navigate(`/jobs/${encodeURIComponent(r.job_id)}`);
    else if (r.fanout?.length) navigate(`/jobs?q=${encodeURIComponent(s.id)}`);
    return r;
  });
  const remove = useMutation(async () => {
    const r = await mutate("DELETE", `/api/schedules/${encodeURIComponent(s.id)}`);
    onDone();
    return r;
  });

  return (
    <>
      <Actions>
        <Button tone={s.enabled ? undefined : "primary"} busy={toggle.busy} onClick={() => void toggle.go()}>
          {s.enabled ? "Disable" : "Enable"}
        </Button>
        <Button busy={runNow.busy} onClick={() => void runNow.go()} title="Fire once now, without waiting for the cron minute">
          Run now
        </Button>
        <ConfirmButton confirm="Yes, delete this schedule" busy={remove.busy} onConfirm={() => void remove.go()}>
          Delete
        </ConfirmButton>
      </Actions>
      {[toggle, runNow, remove].map((m, i) => (m.error ? <ErrorBox key={i} error={m.error} /> : null))}
    </>
  );
}

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
                  <ScheduleActions s={s} onDone={state.reload} />
                </Panel>
              ))
            )}
          </>
        )}
      </Loaded>
    </>
  );
}
