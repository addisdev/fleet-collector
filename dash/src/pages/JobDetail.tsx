import { useApi, type JobDetail as Detail, type ResultRow } from "../api.js";
import { Workload } from "../icons.js";
import { mutate, useMutation } from "../mutate.js";
import { navigate } from "../router.js";
import { useDeviceNames } from "../names.js";
import { Actions, Button, ConfirmButton, CopyId, DeviceName, ErrorBox, Json, Link, Loaded, Panel, Pill, Stat, bytes, clock, duration, num } from "../ui.js";
import { JobRows, LeaseCell } from "./Jobs.js";

/** One line that says what a result row actually reported, per workload. */
function summarize(payload: Record<string, any>): string {
  const m = payload.metrics;
  const t = payload.test;
  if (m) {
    const parts: string[] = [];
    // Prefill and decode are never merged into a single tok/s: one number
    // would hide whichever half matters for the question being asked.
    if (m.prefill_tok_s != null) parts.push(`prefill ${num(m.prefill_tok_s)} tok/s`);
    if (m.decode_tok_s != null) parts.push(`decode ${num(m.decode_tok_s)} tok/s`);
    if (m.ttft_ms != null) parts.push(`ttft ${num(m.ttft_ms, 0)} ms`);
    if (m.load_ms != null) parts.push(`load ${m.load_ms} ms`);
    if (m.peak_mem_mb != null) parts.push(`${m.peak_mem_mb} MB (${m.mem_method ?? "method unlabeled"})`);
    return parts.join(" · ");
  }
  if (t) return `${t.passed ?? 0} passed / ${t.failed ?? 0} failed`;
  if (payload.error) return String(payload.error);
  return "";
}

function Results({ results, names }: { results: ResultRow[]; names: Record<string, string> }) {
  if (results.length === 0) return <p class="empty">No result rows yet.</p>;
  return (
    <div class="scroll">
      <table>
        <tr>
          <th>Device</th>
          <th>Iter</th>
          <th>Reported</th>
          <th>When</th>
        </tr>
        {results.map((r) => (
          <tr key={`${r.device_id}-${r.iter}`}>
            <td class="wrap-anywhere">
              <DeviceName id={r.device_id} names={names} />
            </td>
            <td class="num">
              {r.iter}
              {r.payload.final ? <span class="faint"> final</span> : ""}
            </td>
            <td>
              {r.payload.ok === false && <Pill kind="failed">not ok</Pill>} {summarize(r.payload)}
            </td>
            <td class="dim">{clock(r.created_at)}</td>
          </tr>
        ))}
      </table>
    </div>
  );
}

function JobActions({ job, onDone }: { job: Detail; onDone: () => void }) {
  const cancel = useMutation(async () => {
    const r = await mutate<{ note: string }>("POST", `/api/jobs/${encodeURIComponent(job.job_id)}/cancel`, {});
    onDone();
    return r;
  });
  const retry = useMutation(async () => {
    const r = await mutate<{ job_id: string }>("POST", `/api/jobs/${encodeURIComponent(job.job_id)}/retry`, {});
    navigate(`/jobs/${encodeURIComponent(r.job_id)}`);
    return r;
  });
  // Two explicit hooks rather than a bump(delta) helper: hooks must not be
  // called from a function that could be skipped or reordered.
  const raise = useMutation(async () => {
    const r = await mutate("PATCH", `/api/jobs/${encodeURIComponent(job.job_id)}`, { priority: job.priority + 1 });
    onDone();
    return r;
  });
  const lower = useMutation(async () => {
    const r = await mutate("PATCH", `/api/jobs/${encodeURIComponent(job.job_id)}`, { priority: job.priority - 1 });
    onDone();
    return r;
  });

  const stoppable = job.status === "queued" || job.status === "claimed";

  return (
    <>
      <Actions>
        {stoppable && (
          <ConfirmButton
            confirm={job.status === "claimed" ? "Yes, cancel this running job" : "Yes, cancel"}
            busy={cancel.busy}
            onConfirm={() => void cancel.go()}
          >
            Cancel
          </ConfirmButton>
        )}
        <Button busy={retry.busy} onClick={() => void retry.go()} title="Clone this spec under a fresh job id">
          Retry as new job
        </Button>
        {job.status === "queued" && (
          <>
            <Button busy={raise.busy} onClick={() => void raise.go()} title="Move up the queue">
              priority +1
            </Button>
            <Button busy={lower.busy} onClick={() => void lower.go()} disabled={job.priority <= 0}>
              −1
            </Button>
            <span class="dim">priority {job.priority}</span>
          </>
        )}
      </Actions>
      {[cancel, retry, raise, lower].map((m, i) => (m.error ? <ErrorBox key={i} error={m.error} /> : null))}
      {cancel.result && <p class="empty">{(cancel.result as { note: string }).note}</p>}
    </>
  );
}

export function JobDetail({ id }: { id: string }) {
  const state = useApi<Detail>(`/api/jobs/${encodeURIComponent(id)}`, ["job", "result", "beacon", "lock"], 15_000);
  const names = useDeviceNames();

  return (
    <>
      <h1 class="wrap-anywhere">
        <code>{id}</code> <CopyId text={id} />
      </h1>
      <Loaded state={state} what="job">
        {(j) => (
          <>
            <Panel
              title="Status"
              aside={
                <span>
                  <Pill kind={j.status} />{" "}
                  <span class="faint">
                    <Workload name={j.workload} /> · {j.executor}
                  </span>
                </span>
              }
            >
              <div class="stats">
                <Stat label="attempts" value={`${j.attempts}/${j.max_attempts}`} tone={j.attempts >= j.max_attempts && j.status !== "done" ? "warn" : undefined} />
                <Stat label="duration" value={duration(j.duration_s)} />
                <Stat label="lease ttl" value={duration(j.lease_ttl_s)} />
                <Stat label="claimed by" value={j.claimed_by ?? "—"} />
                <Stat label="results" value={j.results.length} />
                <Stat label="beacons" value={j.beacons.length} />
              </div>
              {j.status === "claimed" && (
                <p class="empty">
                  Lease remaining: <LeaseCell job={j} />
                </p>
              )}
              {j.last_error && <p class="error">{j.last_error}</p>}
              <JobActions job={j} onDone={state.reload} />
            </Panel>

            <Panel title="Target">
              <div class="scroll">
                <table>
                  {[
                    ["pool", j.pool],
                    ["match", j.match],
                    ["pinned device", j.device_id],
                    ["exclusive", j.exclusive ? "yes" : null],
                    ["backend", j.backend],
                    ["model", j.model],
                    ["app", j.app],
                  ]
                    .filter(([, v]) => v)
                    .map(([k, v]) => (
                      <tr key={String(k)}>
                        <td class="dim">{k}</td>
                        <td class="wrap-anywhere">
                          {k === "pinned device" ? (
                            <DeviceName id={String(v)} names={names} />
                          ) : (
                            <code>{String(v)}</code>
                          )}
                        </td>
                      </tr>
                    ))}
                </table>
              </div>
            </Panel>

            <Panel title="What happened">
              <ol class="timeline">
                {j.derived_timeline.map((e, i) => (
                  <li key={i}>
                    <span class="dim">{clock(e.at)}</span> {e.what}
                  </li>
                ))}
              </ol>
              <p class="empty">
                Derived from the job row, not a log. The collector keeps only the current state of a job, so a requeue
                shows up in the attempt count rather than as its own entry here.
              </p>
            </Panel>

            <Panel title={`Results (${j.results.length})`}>
              <Results results={j.results} names={names} />
            </Panel>

            {j.artifacts.length > 0 && (
              <Panel title={`Artifacts (${j.artifacts.length})`}>
                <div class="scroll">
                  <table>
                    <tr>
                      <th>Role</th>
                      <th>Name</th>
                      <th>Size</th>
                      <th>sha256</th>
                    </tr>
                    {j.artifacts.map((a) => (
                      <tr key={a.sha256}>
                        <td>{a.role}</td>
                        <td>
                          {a.name ?? <span class="faint">unnamed</span>}
                          {/* A spec can reference a hash that was never uploaded.
                              That is a real failure mode — the job dies on download —
                              so it is stated rather than hidden. */}
                          {!a.in_store && <div class="text-bad">not in the store</div>}
                        </td>
                        <td class="num">{bytes(a.size)}</td>
                        <td class="wrap-anywhere">
                          {a.in_store ? (
                            <a href={`/artifacts/${a.sha256}`}>
                              <code>{a.sha256.slice(0, 12)}…</code>
                            </a>
                          ) : (
                            <code>{a.sha256.slice(0, 12)}…</code>
                          )}
                        </td>
                      </tr>
                    ))}
                  </table>
                </div>
              </Panel>
            )}

            {(j.children.length > 0 || j.siblings.length > 0 || j.parent) && (
              <Panel title="Fan-out">
                {j.parent && (
                  <p class="empty">
                    Child of <code>{j.parent}</code>
                    <span class="faint"> — the parent id has no job row of its own; the collector enqueues only children.</span>
                  </p>
                )}
                <div class="scroll">
                  <JobRows jobs={j.children.length ? j.children : j.siblings} />
                </div>
              </Panel>
            )}

            {j.locks.length > 0 && (
              <Panel title="Device locks held">
                <div class="scroll">
                  <table>
                    {j.locks.map((l) => (
                      <tr key={l.device_id}>
                        <td>
                          <DeviceName id={l.device_id} names={names} />
                        </td>
                        <td class="dim">since {clock(l.acquired_at)}</td>
                      </tr>
                    ))}
                  </table>
                </div>
              </Panel>
            )}

            {j.status_report && (
              <Panel title="Commit status">
                <p class="stub">
                  <code>{j.status_report.target}</code> → <strong>{j.status_report.state}</strong>{" "}
                  {j.status_report.posted ? <Pill kind="done">posted</Pill> : <Pill kind="queued">not posted</Pill>}
                  <br />
                  <span class="faint">{j.status_report.detail}</span>
                </p>
              </Panel>
            )}

            <Panel title="Spec">
              <Json value={j.spec} label="full job spec" />
            </Panel>
          </>
        )}
      </Loaded>
    </>
  );
}
