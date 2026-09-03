// The "is the fleet OK" screen. One request, five answers.
import { useApi, type Overview as OverviewData, type RecentResults } from "../api.js";
import { Workload } from "../icons.js";
import { useDeviceNames } from "../names.js";
import { DeviceName, Link, Loaded, Panel, Pill, Stat, ago, agoFrom, clock, duration } from "../ui.js";

function LeaseBar({ fraction }: { fraction: number | null }) {
  if (fraction == null) return null;
  const pct = Math.round(fraction * 100);
  const tone = fraction < 0.1 ? "critical" : fraction < 0.33 ? "low" : "";
  return (
    <div class={`lease-bar ${tone}`} title={`${pct}% of the lease window remaining`}>
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Overview() {
  // Live topics: anything that moves a number on this page. The 30 s timer is
  // for the numbers that drift without any event at all — lease countdowns,
  // queue age, uptime.
  const state = useApi<OverviewData>("/api/overview", ["job", "device", "beacon", "result", "schedule"], 30_000);
  const recent = useApi<RecentResults>("/api/results/recent?limit=12", ["result"], 60_000);
  const names = useDeviceNames();

  return (
    <>
      <h1>Overview</h1>
      <Loaded state={state} what="overview">
        {(d) => (
          <>
            <Panel title="Fleet" aside={<span class="faint">{clock(d.generated_at)}</span>}>
              <div class="stats">
                <Stat label="online" value={d.devices.online} tone={d.devices.online > 0 ? "ok" : undefined} />
                <Stat label="stale" value={d.devices.stale} tone={d.devices.stale > 0 ? "warn" : undefined} />
                <Stat label="offline" value={d.devices.offline} tone={d.devices.offline > 0 ? "bad" : undefined} />
                <Stat label="busy" value={d.devices.busy} />
                <Stat label="charging" value={d.devices.charging} />
                <Stat
                  label="worst thermal"
                  value={d.devices.worst_thermal ?? "—"}
                  tone={
                    d.devices.worst_thermal === "critical"
                      ? "bad"
                      : d.devices.worst_thermal === "serious"
                        ? "warn"
                        : undefined
                  }
                />
              </div>
              {d.devices.low_battery_devices.length > 0 && (
                <p class="empty">
                  Below 15% and not charging:{" "}
                  {d.devices.low_battery_devices.map((id) => (
                    <Link key={id} to={`/devices/${encodeURIComponent(id)}`}>
                      <code>{id}</code>{" "}
                    </Link>
                  ))}
                </p>
              )}
            </Panel>

            <Panel title="Queue">
              <div class="stats">
                <Stat label="queued" value={d.queue.queued} />
                <Stat label="running" value={d.queue.claimed} tone={d.queue.claimed > 0 ? "warn" : undefined} />
                <Stat label="done 24h" value={d.queue.done_24h} tone="ok" />
                <Stat label="failed 24h" value={d.queue.failed_24h} tone={d.queue.failed_24h > 0 ? "bad" : undefined} />
                <Stat label="oldest queued" value={duration(d.queue.oldest_queued_age_s)} />
                <Stat
                  label="last attempt"
                  value={d.queue.last_attempt}
                  tone={d.queue.last_attempt > 0 ? "warn" : undefined}
                />
              </div>
            </Panel>

            <Panel title={`Running now (${d.running.length})`}>
              {d.running.length === 0 ? (
                <p class="empty">Nothing claimed. The fleet is idle.</p>
              ) : (
                <div class="scroll">
                  <table>
                    <tr>
                      <th>Job</th>
                      <th>Workload</th>
                      <th>Claimed by</th>
                      <th>Elapsed</th>
                      <th>Lease left</th>
                      <th>Attempt</th>
                    </tr>
                    {d.running.map((j) => (
                      <tr key={j.job_id}>
                        <td class="wrap-anywhere">
                          <Link to={`/jobs/${encodeURIComponent(j.job_id)}`}>
                            <code>{j.job_id}</code>
                          </Link>
                        </td>
                        <td>
                          <Workload name={j.workload} /> <span class="faint">{j.executor}</span>
                        </td>
                        <td class="wrap-anywhere">
                          {j.claimed_by ? <DeviceName id={j.claimed_by} names={names} /> : <span class="faint">—</span>}
                        </td>
                        <td class="num">{duration(j.elapsed_s)}</td>
                        <td>
                          {duration(j.lease_remaining_s)}
                          <LeaseBar fraction={j.lease_fraction} />
                        </td>
                        <td class="num">
                          {j.attempts}/{j.max_attempts}
                        </td>
                      </tr>
                    ))}
                  </table>
                </div>
              )}
            </Panel>

            <Panel title="Recent failures">
              {d.recent_failures.length === 0 ? (
                <p class="empty">No failed jobs.</p>
              ) : (
                <div class="scroll">
                  <table>
                    {d.recent_failures.map((j) => (
                      <>
                        <tr key={j.job_id}>
                          <td class="wrap-anywhere">
                            <Link to={`/jobs/${encodeURIComponent(j.job_id)}`}>
                              <code>{j.job_id}</code>
                            </Link>
                          </td>
                          <td>
                            <Workload name={j.workload} />
                          </td>
                          <td class="dim">{clock(j.finished_at)}</td>
                          <td class="num">
                            {j.attempts}/{j.max_attempts}
                          </td>
                        </tr>
                        {j.last_error && (
                          <tr class="note">
                            <td colSpan={4}>↳ {j.last_error}</td>
                          </tr>
                        )}
                      </>
                    ))}
                  </table>
                </div>
              )}
            </Panel>

            <Panel
              title="Scheduler"
              aside={
                d.schedules.missed > 0 ? (
                  <Pill kind="failed">{d.schedules.missed} missed</Pill>
                ) : (
                  <span class="faint">
                    {d.schedules.enabled} of {d.schedules.total} enabled
                  </span>
                )
              }
            >
              {d.schedules.next.length === 0 ? (
                <p class="empty">
                  {d.schedules.total === 0
                    ? "No schedules."
                    : "No schedule is enabled — nightly runs are seeded but off."}
                </p>
              ) : (
                <div class="scroll">
                  <table>
                    {d.schedules.next.map((s) => (
                      <tr key={s.id}>
                        <td>
                          <code>{s.id}</code>
                        </td>
                        <td class="dim">
                          <code>{s.cron}</code>
                        </td>
                        <td>in {duration(s.next_run_in_s)}</td>
                        <td class="dim">{clock(s.next_run)}</td>
                        <td>{s.missed && <Pill kind="failed">missed</Pill>}</td>
                      </tr>
                    ))}
                  </table>
                </div>
              )}
            </Panel>

            <Panel title="Recent results">
              <Loaded state={recent} what="results">
                {(r) =>
                  r.results.length === 0 ? (
                    <p class="empty">No results yet.</p>
                  ) : (
                    <div class="scroll">
                      <table>
                        <tr>
                          <th>Job</th>
                          <th>Device</th>
                          <th>Iter</th>
                          <th>Reported</th>
                          <th>When</th>
                        </tr>
                        {r.results.map((x) => (
                          <tr key={`${x.job_id}-${x.device_id}-${x.iter}`}>
                            <td class="wrap-anywhere">
                              <Link to={`/jobs/${encodeURIComponent(x.job_id)}`}>
                                <code>{x.job_id}</code>
                              </Link>
                            </td>
                            <td class="wrap-anywhere">
                              <DeviceName id={x.device_id} names={names} />
                            </td>
                            <td class="num">
                              {x.iter}
                              {x.final ? <span class="faint"> final</span> : ""}
                            </td>
                            <td>
                              {!x.ok && <Pill kind="failed">not ok</Pill>} {x.summary}
                            </td>
                            <td class="dim">{agoFrom(x.created_at)}</td>
                          </tr>
                        ))}
                      </table>
                    </div>
                  )
                }
              </Loaded>
            </Panel>

            <Panel title="Collector">
              <div class="stats">
                <Stat label="uptime" value={duration(d.health.uptime_s)} />
                <Stat label="node" value={d.health.node} />
                <Stat label="dash clients" value={d.health.stream_clients} />
                <Stat label="started" value={ago((Date.now() - new Date(d.health.started_at).getTime()) / 1000)} />
              </div>
            </Panel>
          </>
        )}
      </Loaded>
    </>
  );
}
