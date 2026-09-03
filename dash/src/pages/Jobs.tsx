import { useApi, type Job, type JobList } from "../api.js";
import { useQuery } from "../router.js";
import { Workload } from "../icons.js";
import { useDeviceNames } from "../names.js";
import { DeviceName, Filters, Link, Loaded, Pager, Panel, Pill, Search, Select, agoFrom, duration } from "../ui.js";

/** How much of the lease window is left. Green while there is room, red when a
 *  sweep is imminent — the bar is the "is this job about to be requeued?" answer. */
export function LeaseCell({ job }: { job: Job }) {
  if (job.status !== "claimed" || job.lease_remaining_s == null) {
    return job.attempts > 1 || job.last_error ? (
      <span class="dim">
        try {job.attempts}/{job.max_attempts}
      </span>
    ) : (
      <span class="faint">—</span>
    );
  }
  const fraction = job.lease_ttl_s > 0 ? Math.max(0, Math.min(1, job.lease_remaining_s / job.lease_ttl_s)) : 0;
  const tone = fraction < 0.1 ? "critical" : fraction < 0.33 ? "low" : "";
  return (
    <span>
      {duration(job.lease_remaining_s)}
      <div class={`lease-bar ${tone}`} title={`try ${job.attempts}/${job.max_attempts}`}>
        <i style={{ width: `${Math.round(fraction * 100)}%` }} />
      </div>
    </span>
  );
}

export function JobRows({ jobs }: { jobs: Job[] }) {
  const names = useDeviceNames();
  return (
    <table>
      <tr>
        <th>Job</th>
        <th>Workload</th>
        <th>Status</th>
        <th>Target</th>
        <th>Lease</th>
        <th>Duration</th>
        <th>Updated</th>
      </tr>
      {jobs.map((j) => (
        <>
          <tr key={j.job_id}>
            <td class="wrap-anywhere">
              <Link to={`/jobs/${encodeURIComponent(j.job_id)}`}>
                <code>{j.job_id}</code>
              </Link>
            </td>
            <td>
              <Workload name={j.workload} /> <span class="faint">{j.executor}</span>
            </td>
            <td>
              <Pill kind={j.status} />
            </td>
            <td class="dim wrap-anywhere">
              {j.claimed_by ? (
                <DeviceName id={j.claimed_by} names={names} />
              ) : j.device_id ? (
                <DeviceName id={j.device_id} names={names} />
              ) : (
                j.pool ?? j.match ?? "—"
              )}
            </td>
            <td>
              <LeaseCell job={j} />
            </td>
            <td class="num">{duration(j.duration_s)}</td>
            <td class="dim">{agoFrom(j.finished_at ?? j.claimed_at ?? j.created_at)}</td>
          </tr>
          {j.last_error && (
            <tr class="note">
              <td colSpan={7}>↳ {j.last_error}</td>
            </tr>
          )}
        </>
      ))}
    </table>
  );
}

export function Jobs() {
  const [q, setQuery] = useQuery();
  const status = q.get("status") ?? "";
  const workload = q.get("workload") ?? "";
  const executor = q.get("executor") ?? "";
  const pool = q.get("pool") ?? "";
  const device = q.get("device") ?? "";
  const search = q.get("q") ?? "";
  const hasError = q.get("has_error") === "true";
  const page = Number(q.get("page") ?? 1) || 1;

  const params = new URLSearchParams();
  for (const [k, v] of [
    ["status", status],
    ["workload", workload],
    ["executor", executor],
    ["pool", pool],
    ["device", device],
    ["q", search],
    ["has_error", hasError ? "true" : ""],
    ["page", page > 1 ? String(page) : ""],
  ] as const)
    if (v) params.set(k, v);

  const state = useApi<JobList>(`/api/jobs${params.toString() ? `?${params}` : ""}`, ["job", "result"], 30_000);
  const active = !!(status || workload || executor || pool || device || search || hasError);

  return (
    <>
      <h1>
        Jobs{" "}
        <Link to="/jobs/new" class="newjob">
          + new job
        </Link>
      </h1>
      <Loaded state={state} what="jobs">
        {(d) => (
          <>
            <Panel>
              <Filters
                active={active}
                onClear={() =>
                  setQuery({ status: null, workload: null, executor: null, pool: null, device: null, q: null, has_error: null })
                }
              >
                <Select
                  label="status"
                  value={status}
                  options={["queued", "claimed", "done", "failed", "cancelled"].map((s) => ({
                    value: s,
                    label: `${s} (${d.status_counts[s] ?? 0})`,
                  }))}
                  onChange={(v) => setQuery({ status: v })}
                />

                <Select label="workload" value={workload} options={d.workloads} onChange={(v) => setQuery({ workload: v })} />
                <Select label="executor" value={executor} options={["device", "host"]} onChange={(v) => setQuery({ executor: v })} />
                <Select label="pool" value={pool} options={d.pools} onChange={(v) => setQuery({ pool: v })} />
                <Search label="find" value={search} placeholder="job id" onChange={(v) => setQuery({ q: v })} />
                <label class="field checkbox">
                  <input type="checkbox" checked={hasError} onChange={(e) => setQuery({ has_error: (e.target as HTMLInputElement).checked ? "true" : null })} />
                  <span>has error</span>
                </label>
              </Filters>
              {device && (
                <p class="empty">
                  Filtered to device <code>{device}</code>.{" "}
                  <button type="button" class="linkish" onClick={() => setQuery({ device: null })}>
                    remove
                  </button>
                </p>
              )}
            </Panel>

            <Panel title={`${d.total} job${d.total === 1 ? "" : "s"}`}>
              {d.jobs.length === 0 ? (
                <p class="empty">No job matches these filters.</p>
              ) : (
                <>
                  <div class="scroll">
                    <JobRows jobs={d.jobs} />
                  </div>
                  <Pager page={d.page} pages={d.pages} total={d.total} onPage={(p) => setQuery({ page: String(p) })} />
                </>
              )}
            </Panel>

          </>
        )}
      </Loaded>
    </>
  );
}
