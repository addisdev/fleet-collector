import { useState } from "preact/hooks";
import { useApi, type BeaconHistory, type DeviceDetail as Detail } from "../api.js";
import { ThermalStrip, TimeSeries, runs } from "../chart.js";
import { mutate, useMutation } from "../mutate.js";
import { navigate, useQuery } from "../router.js";
import { Actions, Button, ConfirmButton, CopyId, ErrorBox, Field, Json, Link, Loaded, Panel, Pill, Stat, agoFrom, clock, num } from "../ui.js";
import { Icon, Workload } from "../icons.js";
import { Battery, Thermal } from "./Devices.js";

const WINDOWS = [6, 24, 72, 168];

function DeviceEditor({ device, onDone }: { device: Detail; onDone: () => void }) {
  const [name, setNickname] = useState(device.name ?? "");
  const [notes, setNotes] = useState(device.notes ?? "");
  const [pools, setPools] = useState((device.pools_override ?? device.pools).join(", "));

  const save = useMutation(async () => {
    const list = pools.split(",").map((p) => p.trim()).filter(Boolean);
    const r = await mutate("PATCH", `/api/devices/${encodeURIComponent(device.device_id)}`, {
      name: name || null,
      notes: notes || null,
      pools: list,
    });
    onDone();
    return r;
  });

  // Clearing the override is not the same as an override of "no pools": it
  // hands the device back to whatever its runner reports at next registration.
  const clearOverride = useMutation(async () => {
    const r = await mutate("PATCH", `/api/devices/${encodeURIComponent(device.device_id)}`, { pools: null });
    setPools(device.pools_reported.join(", "));
    onDone();
    return r;
  });

  const releaseLock = useMutation(async () => {
    const r = await mutate("POST", `/api/devices/${encodeURIComponent(device.device_id)}/release-lock`, {});
    onDone();
    return r;
  });

  const forget = useMutation(async () => {
    const r = await mutate("DELETE", `/api/devices/${encodeURIComponent(device.device_id)}`);
    navigate("/devices");
    return r;
  });

  return (
    <>
      <div class="filters">
        <Field label="name" hint="what this device is called everywhere in the dashboard">
          <input value={name} onChange={(e) => setNickname((e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="pools" hint="comma separated — overrides what the runner reports">
          <input value={pools} onChange={(e) => setPools((e.target as HTMLInputElement).value)} />
        </Field>
      </div>
      <Field label="notes" hint="USB hub port, cracked screen, whatever you need to remember">
        <textarea rows={2} value={notes} onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)} />
      </Field>

      <Actions>
        <Button tone="primary" busy={save.busy} onClick={() => void save.go()}>
          Save
        </Button>
        {device.pools_override && (
          <Button busy={clearOverride.busy} onClick={() => void clearOverride.go()} title="Use the runner's own pools again">
            Clear pool override
          </Button>
        )}
        {device.lock && (
          <ConfirmButton confirm="Yes, release the lock" busy={releaseLock.busy} onConfirm={() => void releaseLock.go()}>
            Release lock
          </ConfirmButton>
        )}
        <ConfirmButton confirm="Yes, forget this device" busy={forget.busy} onConfirm={() => void forget.go()}>
          Forget device
        </ConfirmButton>
      </Actions>

      {[save, clearOverride, releaseLock, forget].map((m, i) => (m.error ? <ErrorBox key={i} error={m.error} /> : null))}
      {device.pools_override && (
        <p class="empty">
          Pools are overridden. The runner reports{" "}
          <code>{device.pools_reported.join(", ") || "none"}</code>; the queue uses the override.
        </p>
      )}
      <p class="empty faint">
        A live device re-registers within the minute, so forgetting one only sticks if it is off the shelf. Results and
        beacon history are kept either way.
      </p>
    </>
  );
}

export function DeviceDetail({ id }: { id: string }) {
  const [q, setQuery] = useQuery();
  const hours = Number(q.get("hours") ?? 24) || 24;

  const state = useApi<Detail>(`/api/devices/${encodeURIComponent(id)}`, ["device", "beacon", "job", "lock"], 30_000);
  const beacons = useApi<BeaconHistory>(`/api/devices/${encodeURIComponent(id)}/beacons?hours=${hours}`, ["beacon"], 60_000);

  return (
    <>
      <h1 class="wrap-anywhere">
        {state.data?.name ? (
          <>
            {state.data.name} <span class="faint mono">{id}</span>
          </>
        ) : (
          <code>{id}</code>
        )}{" "}
        <CopyId text={id} />
      </h1>

      <Loaded state={state} what="device">
        {(d) => (
          <>
            <Panel
              title="Status"
              aside={
                <span>
                  <Pill kind={d.status} />
                  {d.simulator && (
                    <span class="faint">
                      {" · "}
                      <span class="with-icon">
                        <Icon name="simulator" />
                        simulator
                      </span>
                    </span>
                  )}
                </span>
              }
            >
              <div class="stats">
                <Stat label="battery" value={<Battery pct={d.beacon?.battery_pct ?? null} charging={d.beacon?.charging ?? null} />} />
                <Stat label="thermal" value={<Thermal state={d.beacon?.thermal ?? null} />} />
                <Stat label="last seen" value={agoFrom(d.last_seen)} />
                <Stat label="results" value={d.counts.results} />
                <Stat label="beacons" value={d.counts.beacons} />
                <Stat label="platform" value={d.platform} />
              </div>
              <p class="empty">
                {String(d.descriptor.model ?? "unknown model")} · {String(d.descriptor.os ?? "unknown os")}
                {d.descriptor.soc ? ` · ${d.descriptor.soc}` : ""}
                {d.descriptor.ram_mb ? ` · ${d.descriptor.ram_mb} MB RAM` : ""}
                {d.pools.length ? ` · pools: ${d.pools.join(", ")}` : " · no pools"}
              </p>
              {d.current_job && (
                <p class="empty">
                  Running{" "}
                  <Link to={`/jobs/${encodeURIComponent(d.current_job)}`}>
                    <code>{d.current_job}</code>
                  </Link>
                  {d.lock && " (held by a host-executor lock)"}
                </p>
              )}
            </Panel>

            <Panel
              title="Battery"
              aside={
                <span class="windows">
                  {WINDOWS.map((h) => (
                    <button key={h} type="button" class={`linkish${h === hours ? " on" : ""}`} onClick={() => setQuery({ hours: String(h) })}>
                      {h}h
                    </button>
                  ))}
                </span>
              }
            >
              <Loaded state={beacons} what="beacons">
                {(b) => {
                  const pts = b.samples
                    .filter((s) => s.ts)
                    .map((s) => ({ t: new Date(s.ts!).getTime(), v: s.battery_pct != null && s.battery_pct >= 0 ? s.battery_pct : null }));
                  const now = Date.now();
                  const domain: [number, number] = [now - hours * 3600_000, now];
                  const charging = runs(
                    b.samples.filter((s) => s.ts),
                    (s) => new Date(s.ts!).getTime(),
                    (s) => s.charging === true,
                  );
                  return (
                    <>
                      <TimeSeries points={pts} bands={charging} domain={domain} unit="% charge">
                        <span class="chart-key">
                          <i class="chart-band-key" /> charging
                        </span>
                      </TimeSeries>
                      <h2 style={{ marginTop: "1rem" }}>Thermal</h2>
                      <ThermalStrip
                        samples={b.samples.filter((s) => s.ts).map((s) => ({ t: new Date(s.ts!).getTime(), thermal: s.thermal }))}
                        domain={domain}
                      />
                    </>
                  );
                }}
              </Loaded>
            </Panel>

            <Panel title={`Benchmarks (${d.benchmarks.length})`}>
              {d.benchmarks.length === 0 ? (
                <p class="empty">No passing benchmark results from this device.</p>
              ) : (
                <div class="scroll">
                  <table>
                    <tr>
                      <th>Model</th>
                      <th>Backend</th>
                      <th class="right">Prefill tok/s</th>
                      <th class="right">Decode tok/s</th>
                      <th class="right">TTFT ms</th>
                      <th class="right">Peak mem</th>
                      <th>When</th>
                    </tr>
                    {d.benchmarks.map((b) => (
                      <tr key={b.job_id}>
                        <td>
                          <Link to={`/jobs/${encodeURIComponent(b.job_id)}`}>
                            {b.model}
                            {b.quant ? ` ${b.quant}` : ""}
                          </Link>
                        </td>
                        <td class="dim">{b.backend}</td>
                        <td class="num">{num(b.metrics?.prefill_tok_s)}</td>
                        <td class="num">
                          <strong>{num(b.metrics?.decode_tok_s)}</strong>
                        </td>
                        <td class="num">{num(b.metrics?.ttft_ms, 0)}</td>
                        {/* Memory always carries the method that produced it: iOS
                            phys_footprint and Android PSS are different quantities. */}
                        <td class="num">
                          {b.metrics?.peak_mem_mb ?? "—"}{" "}
                          <span class="faint">{b.metrics?.mem_method ?? "?"}</span>
                        </td>
                        <td class="dim">{clock(b.at)}</td>
                      </tr>
                    ))}
                  </table>
                </div>
              )}
            </Panel>

            <Panel title={`Jobs (${d.jobs.length})`}>
              {d.jobs.length === 0 ? (
                <p class="empty">This device has never claimed a job.</p>
              ) : (
                <div class="scroll">
                  <table>
                    <tr>
                      <th>Job</th>
                      <th>Workload</th>
                      <th>Status</th>
                      <th>Attempts</th>
                      <th>When</th>
                    </tr>
                    {d.jobs.map((j) => (
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
                          <td class="num">
                            {j.attempts}/{j.max_attempts}
                          </td>
                          <td class="dim">{clock(j.finished_at ?? j.created_at)}</td>
                        </tr>
                        {j.last_error && (
                          <tr class="note">
                            <td colSpan={5}>↳ {j.last_error}</td>
                          </tr>
                        )}
                      </>
                    ))}
                  </table>
                </div>
              )}
            </Panel>

            <Panel title="Edit">
              <DeviceEditor device={d} onDone={state.reload} />
            </Panel>

            <Panel title="Descriptor">
              <Json value={d.descriptor} label="registered descriptor" />
            </Panel>
          </>
        )}
      </Loaded>
    </>
  );
}
