// Collector health and housekeeping. Real in D0 because it is all one
// endpoint, and because "how big is that unrotated log?" is the question the
// README warns about and nothing else answers.
import { useState } from "preact/hooks";
import { useApi, type Locks } from "../api.js";
import { mutate, useMutation, useToken } from "../mutate.js";
import { useDeviceNames } from "../names.js";
import { Actions, Button, ConfirmButton, DeviceName, ErrorBox, Field, Link, Loaded, Panel, Pill, Stat, agoFrom, bytes, clock, duration } from "../ui.js";

function TokenPanel({ required }: { required: boolean }) {
  const [saved, save] = useToken();
  const [draft, setDraft] = useState(saved);

  return (
    <Panel
      title="Dashboard token"
      aside={required ? <Pill kind={saved ? "done" : "failed"}>{saved ? "set" : "missing"}</Pill> : <Pill kind="queued">not required</Pill>}
    >
      <p class="stub">
        {required
          ? "This collector runs with FLEET_DASH_TOKEN set, so cancel, retry, edit and enqueue need the token. It is stored in this browser only."
          : "This collector has no FLEET_DASH_TOKEN, so mutations are open to anyone who can reach it — the same as POST /jobs. Set the env var to require a token."}
      </p>
      <Field label="token" hint="kept in localStorage, sent as X-Fleet-Token">
        <input type="password" value={draft} onInput={(e) => setDraft((e.target as HTMLInputElement).value)} />
      </Field>
      <Actions>
        <Button tone="primary" onClick={() => save(draft)}>
          Save token
        </Button>
        {saved && (
          <Button
            onClick={() => {
              save("");
              setDraft("");
            }}
          >
            Clear
          </Button>
        )}
      </Actions>
    </Panel>
  );
}

type SystemData = {
  health: {
    uptime_s: number; node: string; pid: number; started_at: string; instance: string;
    stream_clients: number; guard: boolean;
  };
  paths: { data_dir: string; artifact_dir: string; log_file: string; power_config: string };
  db: { files: { file: string; bytes: number }[]; bytes: number; counts: Record<string, number> };
  artifacts: { files: number; scanned: number; bytes: number; truncated: boolean };
  log: { path: string; exists: boolean; bytes: number };
  intervals: { sweep_ms: number; scheduler_tick_ms: number };
  ci: { armed: boolean; status_flag: boolean; token_present: boolean };
  power: { configured: boolean; pools: string[] };
};

// launchd does not rotate the collector's log and it writes a line per request.
const LOG_WARN_BYTES = 200 * 1024 * 1024;

type Executors = {
  executors: { name: string; last_seen: string | null; last_job: string | null; polls: number; age_s: number; status: string }[];
  queued_host_jobs: number;
};

function Operations({ pools, onDone }: { pools: string[]; onDone: () => void }) {
  const sweep = useMutation(async () => {
    const r = await mutate<{ requeued: string[]; failed: string[] }>("POST", "/api/system/sweep", {});
    onDone();
    return r;
  });
  const tick = useMutation(async () => {
    const r = await mutate<{ fired: string[] }>("POST", "/api/system/scheduler-tick", {});
    onDone();
    return r;
  });
  const [retention, setRetention] = useState({ beacon_days: 30, event_days: 30 });
  const dryRun = useMutation(() =>
    mutate<{ would_delete: { beacons: number; events: number } }>("POST", "/api/system/retention", {
      ...retention,
      dry_run: true,
    }),
  );
  const purge = useMutation(async () => {
    const r = await mutate("POST", "/api/system/retention", { ...retention, dry_run: false });
    dryRun.reset();
    onDone();
    return r;
  });

  return (
    <>
      <Panel title="Run now">
        <Actions>
          <Button busy={sweep.busy} onClick={() => void sweep.go()} title="Requeue or fail claims whose lease has lapsed">
            Sweep leases
          </Button>
          <Button busy={tick.busy} onClick={() => void tick.go()} title="Evaluate schedules for the current minute">
            Scheduler tick
          </Button>
        </Actions>
        {sweep.error && <ErrorBox error={sweep.error} />}
        {tick.error && <ErrorBox error={tick.error} />}
        {sweep.result && (
          <p class="empty">
            Requeued {(sweep.result as { requeued: string[] }).requeued.length}, failed{" "}
            {(sweep.result as { failed: string[] }).failed.length}.
          </p>
        )}
        {tick.result && <p class="empty">Fired {(tick.result as { fired: string[] }).fired.length} schedule(s).</p>}
      </Panel>

      {pools.length > 0 && <PowerPanel pools={pools} />}

      <Panel title="Retention">
        <p class="stub">
          A 60-second beacon is roughly 1,400 rows per device per day, and those rows are what the battery charts read.
          Pruning is manual on purpose — a nightly job quietly deleting measurements is a worse default than a button.
        </p>
        <div class="filters">
          <label class="field">
            <span>keep beacons (days)</span>
            <input
              type="number"
              min={1}
              value={retention.beacon_days}
              onChange={(e) => setRetention({ ...retention, beacon_days: Number((e.target as HTMLInputElement).value) || 1 })}
            />
          </label>
          <label class="field">
            <span>keep events (days)</span>
            <input
              type="number"
              min={1}
              value={retention.event_days}
              onChange={(e) => setRetention({ ...retention, event_days: Number((e.target as HTMLInputElement).value) || 1 })}
            />
          </label>
        </div>
        <Actions>
          <Button busy={dryRun.busy} onClick={() => void dryRun.go()}>
            Count what would go
          </Button>
          {dryRun.result && (
            <ConfirmButton
              confirm={`Yes, delete ${(dryRun.result as { would_delete: { beacons: number; events: number } }).would_delete.beacons} beacons and ${(dryRun.result as { would_delete: { beacons: number; events: number } }).would_delete.events} events`}
              busy={purge.busy}
              onConfirm={() => void purge.go()}
            >
              Prune
            </ConfirmButton>
          )}
        </Actions>
        {dryRun.error && <ErrorBox error={dryRun.error} />}
        {purge.error && <ErrorBox error={purge.error} />}
        {dryRun.result && !purge.result && (
          <p class="empty">
            Would delete {(dryRun.result as { would_delete: { beacons: number } }).would_delete.beacons} beacon samples
            and {(dryRun.result as { would_delete: { events: number } }).would_delete.events} events.
          </p>
        )}
        {purge.result && <p class="empty">Pruned.</p>}
      </Panel>
    </>
  );
}

function PowerPanel({ pools }: { pools: string[] }) {
  const [last, setLast] = useState<string | null>(null);
  const fire = useMutation(async () => null);

  const send = async (pool: string, state: "on" | "off") => {
    try {
      const r = await mutate<{ webhook_status: number }>("POST", `/api/power/${encodeURIComponent(pool)}/${state}`, {});
      setLast(`${pool} ${state}: webhook returned ${r.webhook_status}`);
    } catch (e) {
      setLast(`${pool} ${state}: ${(e as Error).message}`);
    }
  };

  return (
    <Panel title="Power">
      <p class="stub">Fires the pool's smart-plug webhook. Cutting power to a pool mid-run will fail its jobs.</p>
      {pools.map((p) => (
        <Actions key={p}>
          <span class="mono">{p}</span>
          <Button busy={fire.busy} onClick={() => void send(p, "on")}>
            on
          </Button>
          <ConfirmButton confirm={`Yes, cut power to ${p}`} onConfirm={() => void send(p, "off")}>
            off
          </ConfirmButton>
        </Actions>
      ))}
      {last && <p class="empty">{last}</p>}
    </Panel>
  );
}

export function System() {
  const state = useApi<SystemData>("/api/system", ["artifact", "job"], 60_000);
  const locks = useApi<Locks>("/api/locks", ["lock", "job"], 30_000);
  const executors = useApi<Executors>("/api/executors", ["job"], 30_000);
  const names = useDeviceNames();

  return (
    <>
      <h1>System</h1>
      <Loaded state={locks} what="locks">
        {(l) => (
          <Panel title={`Device locks (${l.locks.length})`}>
            {l.locks.length === 0 ? (
              <p class="empty">No device is locked. Host-executor jobs take a lock while they drive a device.</p>
            ) : (
              <div class="scroll">
                <table>
                  <tr>
                    <th>Device</th>
                    <th>Held by job</th>
                    <th>Held for</th>
                  </tr>
                  {l.locks.map((lk) => (
                    <tr key={lk.device_id}>
                      <td class="wrap-anywhere">
                        <DeviceName id={lk.device_id} names={names} />
                      </td>
                      <td class="wrap-anywhere">
                        <Link to={`/jobs/${encodeURIComponent(lk.job_id)}`}>
                          <code>{lk.job_id}</code>
                        </Link>
                      </td>
                      <td class="num">{duration(lk.held_s)}</td>
                    </tr>
                  ))}
                </table>
              </div>
            )}
          </Panel>
        )}
      </Loaded>
      <Loaded state={executors} what="executors">
        {(e) => (
          <Panel
            title={`Host executors (${e.executors.length})`}
            aside={e.queued_host_jobs > 0 ? <Pill kind="claimed">{e.queued_host_jobs} host jobs queued</Pill> : undefined}
          >
            {e.executors.length === 0 ? (
              <p class="empty">
                No host executor has ever polled this collector. Host jobs — installs, UI tests, drain, soak — cannot
                run without one.
              </p>
            ) : (
              <div class="scroll">
                <table>
                  <tr>
                    <th>Executor</th>
                    <th>Status</th>
                    <th>Last poll</th>
                    <th>Last job</th>
                    <th class="right">Polls</th>
                  </tr>
                  {e.executors.map((x) => (
                    <tr key={x.name}>
                      <td>
                        <code>{x.name}</code>
                      </td>
                      <td>
                        <Pill kind={x.status === "polling" ? "done" : x.status === "quiet" ? "claimed" : "failed"}>
                          {x.status}
                        </Pill>
                      </td>
                      <td class="dim">{agoFrom(x.last_seen)}</td>
                      <td class="wrap-anywhere dim">
                        {x.last_job ? (
                          <Link to={`/jobs/${encodeURIComponent(x.last_job)}`}>
                            <code>{x.last_job}</code>
                          </Link>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td class="num">{x.polls}</td>
                    </tr>
                  ))}
                </table>
              </div>
            )}
            {e.queued_host_jobs > 0 && e.executors.every((x) => x.status === "gone") && (
              <p class="error">
                {e.queued_host_jobs} host job(s) are queued and no executor is polling. Nothing will claim them until
                one comes back.
              </p>
            )}
          </Panel>
        )}
      </Loaded>

      <Loaded state={state} what="system info">
        {(d) => (
          <>
            <TokenPanel required={d.health.guard} />
            <Operations pools={d.power.pools} onDone={state.reload} />

            <Panel title="Collector">
              <div class="stats">
                <Stat label="uptime" value={duration(d.health.uptime_s)} />
                <Stat label="node" value={d.health.node} />
                <Stat label="pid" value={d.health.pid} />
                <Stat label="dash clients" value={d.health.stream_clients} />
                <Stat label="sweep" value={`${Math.round(d.intervals.sweep_ms / 1000)}s`} />
                <Stat label="scheduler tick" value={`${Math.round(d.intervals.scheduler_tick_ms / 1000)}s`} />
              </div>
              <p class="empty">Started {clock(d.health.started_at)}.</p>
            </Panel>

            <Panel title="Storage">
              <div class="stats">
                <Stat label="database" value={bytes(d.db.bytes)} />
                <Stat label={d.artifacts.truncated ? "artifacts (at least)" : "artifacts"} value={bytes(d.artifacts.bytes)} />
                <Stat label="artifact files" value={d.artifacts.files} />
                <Stat
                  label="log file"
                  value={d.log.exists ? bytes(d.log.bytes) : "—"}
                  tone={d.log.bytes > LOG_WARN_BYTES ? "warn" : undefined}
                />
              </div>
              {d.artifacts.truncated && (
                <p class="empty">
                  The artifact total covers the first {d.artifacts.scanned.toLocaleString()} of{" "}
                  {d.artifacts.files.toLocaleString()} files — the real figure is larger.
                </p>
              )}
              {d.log.bytes > LOG_WARN_BYTES && (
                <p class="empty">
                  The log is past {bytes(LOG_WARN_BYTES)} and launchd does not rotate it — truncate it by hand.
                </p>
              )}
              <div class="scroll" style={{ marginTop: "0.75rem" }}>
                <table>
                  <tr>
                    <th>Table</th>
                    <th class="right">Rows</th>
                  </tr>
                  {Object.entries(d.db.counts).map(([table, n]) => (
                    <tr key={table}>
                      <td>
                        <code>{table}</code>
                      </td>
                      <td class="num">{n.toLocaleString()}</td>
                    </tr>
                  ))}
                </table>
              </div>
            </Panel>

            <Panel
              title="CI integration"
              aside={d.ci.armed ? <Pill kind="claimed">armed</Pill> : <Pill kind="queued">off</Pill>}
            >
              <p class="stub">
                {d.ci.armed
                  ? "Closing jobs with report_to.github_status post real commit statuses to GitHub."
                  : "Commit statuses are recorded but not posted. Arming needs both FLEET_GITHUB_STATUS=1 and FLEET_GITHUB_TOKEN."}
              </p>
              <div class="stats">
                <Stat label="FLEET_GITHUB_STATUS" value={d.ci.status_flag ? "1" : "unset"} />
                <Stat label="token" value={d.ci.token_present ? "present" : "unset"} />
              </div>
            </Panel>

            {!d.power.configured && (
              <Panel title="Power">
                <p class="empty">
                  No power config at <code>{d.paths.power_config}</code>. See <code>power.example.json</code>.
                </p>
              </Panel>
            )}

            <Panel title="Paths">
              <div class="scroll">
                <table>
                  {Object.entries(d.paths).map(([k, v]) => (
                    <tr key={k}>
                      <td class="dim">{k.replace(/_/g, " ")}</td>
                      <td class="wrap-anywhere">
                        <code>{v}</code>
                      </td>
                    </tr>
                  ))}
                </table>
              </div>
            </Panel>
          </>
        )}
      </Loaded>
    </>
  );
}
