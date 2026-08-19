// Collector health and housekeeping. Real in D0 because it is all one
// endpoint, and because "how big is that unrotated log?" is the question the
// README warns about and nothing else answers.
import { useState } from "preact/hooks";
import { useApi, type Locks } from "../api.js";
import { useToken } from "../mutate.js";
import { Actions, Button, Field, Link, Loaded, Panel, Pill, Stat, bytes, clock, duration } from "../ui.js";

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

export function System() {
  const state = useApi<SystemData>("/api/system", ["artifact", "job"], 60_000);
  const locks = useApi<Locks>("/api/locks", ["lock", "job"], 30_000);

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
                        <Link to={`/devices/${encodeURIComponent(lk.device_id)}`}>
                          <code>{lk.device_id}</code>
                        </Link>
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
      <Loaded state={state} what="system info">
        {(d) => (
          <>
            <TokenPanel required={d.health.guard} />

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

            <Panel title="Power">
              {d.power.configured ? (
                <p class="stub">
                  Smart-plug webhooks configured for: {d.power.pools.map((p) => <code key={p}>{p} </code>)}
                  <br />
                  Firing them from here arrives in D4.
                </p>
              ) : (
                <p class="empty">
                  No power config at <code>{d.paths.power_config}</code>.
                </p>
              )}
            </Panel>

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
