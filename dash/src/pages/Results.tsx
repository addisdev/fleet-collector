// Results read as results: trends, comparisons, matrices and curves, one view
// per workload family.
//
// The metric-normalization rules from the plan are load-bearing here, not
// decoration. Prefill and decode are charted separately and never summed.
// Memory is only ever compared within one mem_method. Simulators are excluded
// from hardware comparisons unless asked for. And where a number had to be read
// out of a field that means something else, the view says so instead of
// presenting it as a measurement.
import { useApi } from "../api.js";
import { BATTERY_GAP_MS, Bars, MultiSeries, TimeSeries } from "../chart.js";
import { useQuery } from "../router.js";
import { Link, Loaded, Panel, Pill, Select, agoFrom, clock, duration, num } from "../ui.js";

const VIEWS = [
  ["bench", "Benchmarks"],
  ["thermal", "Thermal"],
  ["vision", "Vision eval"],
  ["ui", "UI tests"],
  ["cold-start", "Cold start"],
  ["drain", "Drain"],
  ["soak", "Soak"],
] as const;

/** Downloads what the view is showing. Built from the same rows the page
 *  renders, so an exported table cannot disagree with the screen. */
function download(name: string, rows: Record<string, unknown>[]) {
  if (rows.length === 0) return;
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v: unknown) => {
    const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

const Csv = ({ name, rows }: { name: string; rows: Record<string, unknown>[] }) => (
  <button type="button" class="linkish" onClick={() => download(name, rows)}>
    CSV
  </button>
);

// --- benchmarks ---

type BenchPoint = {
  job_id: string;
  at: string | null;
  prefill_tok_s: number | null;
  decode_tok_s: number | null;
  ttft_ms: number | null;
  load_ms: number | null;
  peak_mem_mb: number | null;
  mem_method: string | null;
};
type BenchConfig = {
  config: string;
  devices: { device_id: string; model: string | null; os: string | null; simulator: boolean; latest: BenchPoint; history: BenchPoint[] }[];
};

function Bench({ hideSims }: { hideSims: boolean }) {
  const state = useApi<{ configs: BenchConfig[] }>("/api/results/bench", ["result"], 60_000);

  return (
    <Loaded state={state} what="benchmarks">
      {(d) =>
        d.configs.length === 0 ? (
          <Panel>
            <p class="empty">No passing benchmark results yet.</p>
          </Panel>
        ) : (
          <>
            {d.configs.map((cfg) => {
              const devices = hideSims ? cfg.devices.filter((x) => !x.simulator) : cfg.devices;
              if (devices.length === 0) return null;
              // Memory is only comparable within one method, so a config mixing
              // iOS phys_footprint and Android PSS gets told, not averaged.
              const methods = [...new Set(devices.map((x) => x.latest.mem_method).filter(Boolean))];
              const rows = devices.map((x) => ({
                config: cfg.config,
                device_id: x.device_id,
                model: x.model,
                os: x.os,
                simulator: x.simulator,
                ...x.latest,
              }));

              return (
                <Panel key={cfg.config} title={cfg.config} aside={<Csv name={`bench-${cfg.config.replace(/\W+/g, "-")}`} rows={rows} />}>
                  <h3 class="sub">Decode tok/s — latest run per device</h3>
                  <Bars
                    items={devices.map((x) => ({
                      label: `${x.device_id}${x.simulator ? " (sim)" : ""}`,
                      value: x.latest.decode_tok_s,
                      muted: x.simulator,
                    }))}
                    unit="tok/s"
                  />

                  <h3 class="sub">Prefill tok/s — the other half, never merged with decode</h3>
                  <Bars
                    items={devices.map((x) => ({
                      label: `${x.device_id}${x.simulator ? " (sim)" : ""}`,
                      value: x.latest.prefill_tok_s,
                      muted: x.simulator,
                    }))}
                    unit="tok/s"
                  />

                  {devices.some((x) => x.history.length > 1) && (
                    <>
                      <h3 class="sub">Decode over time — a regression shows up here first</h3>
                      <MultiSeries
                        series={devices
                          .filter((x) => x.history.length > 1)
                          .map((x) => ({
                            name: x.device_id,
                            muted: x.simulator,
                            points: x.history.map((h) => ({ t: h.at ? new Date(h.at).getTime() : 0, v: h.decode_tok_s })),
                          }))}
                        unit="decode tok/s"
                      />
                    </>
                  )}

                  <div class="scroll" style={{ marginTop: "1rem" }}>
                    <table>
                      <tr>
                        <th>Device</th>
                        <th>OS</th>
                        <th class="right">Prefill</th>
                        <th class="right">Decode</th>
                        <th class="right">TTFT ms</th>
                        <th class="right">Load ms</th>
                        <th class="right">Peak mem</th>
                        <th>When</th>
                      </tr>
                      {devices.map((x) => (
                        <tr key={x.device_id} class={x.simulator ? "muted-row" : ""}>
                          <td class="wrap-anywhere">
                            <Link to={`/devices/${encodeURIComponent(x.device_id)}`}>
                              <code>{x.device_id}</code>
                            </Link>
                            {x.simulator && <div class="faint">simulator — not hardware</div>}
                          </td>
                          <td class="dim">{x.os ?? "—"}</td>
                          <td class="num">{num(x.latest.prefill_tok_s)}</td>
                          <td class="num">
                            <strong>{num(x.latest.decode_tok_s)}</strong>
                          </td>
                          <td class="num">{num(x.latest.ttft_ms, 0)}</td>
                          <td class="num">{x.latest.load_ms ?? "—"}</td>
                          <td class="num">
                            {x.latest.peak_mem_mb ?? "—"} <span class="faint">{x.latest.mem_method ?? "?"}</span>
                          </td>
                          <td class="dim">{clock(x.latest.at)}</td>
                        </tr>
                      ))}
                    </table>
                  </div>
                  {methods.length > 1 && (
                    <p class="empty">
                      Memory in this table was measured two different ways ({methods.join(" and ")}). Those are different
                      quantities — compare them within a method, never across.
                    </p>
                  )}
                </Panel>
              );
            })}
          </>
        )
      }
    </Loaded>
  );
}

// --- vision eval ---

type VisionRun = {
  job_id: string; device_id: string; device_model: string | null; simulator: boolean; at: string | null;
  model: string | null; quant: string | null; backend: string | null; accel: string | null;
  top1_pct: number | null; top5_pct: number | null; p50_ms: number | null; p95_ms: number | null;
  images_per_s: number | null; load_ms: number | null; peak_mem_mb: number | null; mem_method: string | null;
  inferred: boolean;
};

function Vision({ hideSims }: { hideSims: boolean }) {
  const state = useApi<{ runs: VisionRun[]; inferred_count: number; missing_top5: number }>(
    "/api/results/vision",
    ["result"],
    60_000,
  );

  return (
    <Loaded state={state} what="vision evals">
      {(d) => {
        const runs = hideSims ? d.runs.filter((r) => !r.simulator) : d.runs;
        if (runs.length === 0)
          return (
            <Panel>
              <p class="empty">No vision-eval results yet. These are batch jobs on a litert or coreml backend.</p>
            </Panel>
          );
        return (
          <>
            {(d.inferred_count > 0 || d.missing_top5 > 0) && (
              <Panel title="Read this before quoting these numbers">
                <p class="stub">
                  {d.inferred_count > 0 && (
                    <>
                      <strong>{d.inferred_count}</strong> of {d.runs.length} rows were written by a runner that predates
                      the named vision metrics. Those rows carry accuracy in <code>decode_tok_s</code>, latency in{" "}
                      <code>ttft_ms</code> and throughput in <code>prefill_tok_s</code>; this page reads them back
                      through that convention and marks them <em>inferred</em>.{" "}
                    </>
                  )}
                  {d.missing_top5 > 0 && (
                    <>
                      <strong>Top-5 and p95 are missing for {d.missing_top5} rows</strong> — no field ever carried them,
                      so they exist only in the hand-written eval report. Until the runners emit{" "}
                      <code>metrics.top5_pct</code> and <code>metrics.p95_ms</code> (now in{" "}
                      <code>schemas/result.schema.json</code>), this page cannot replace that report.
                    </>
                  )}
                </p>
                {runs.some((r) => r.inferred && r.top1_pct === 0) && (
                  <p class="stub">
                    Some inferred rows report <strong>0% top-1</strong>. In storage that is the same value a run that
                    never computed accuracy would leave behind, so it cannot be told apart from "not measured" — the
                    Core ML runs in the published report have real accuracy that these rows do not carry. Read a zero
                    here as unknown, not as a result.
                  </p>
                )}
              </Panel>
            )}

            <Panel title="Top-1 accuracy" aside={<Csv name="vision-eval" rows={runs as unknown as Record<string, unknown>[]} />}>
              <Bars
                items={runs.map((r) => ({
                  label: `${r.model ?? "?"}${r.quant ? ` ${r.quant}` : ""} · ${r.device_model ?? r.device_id}`,
                  value: r.top1_pct,
                  note: r.inferred ? "inferred" : undefined,
                  muted: r.simulator,
                }))}
                unit="%"
              />
              <h3 class="sub">p50 latency — lower is better, so the longest bar is the slowest</h3>
              <Bars
                items={runs.map((r) => ({
                  label: `${r.model ?? "?"}${r.quant ? ` ${r.quant}` : ""} · ${r.device_model ?? r.device_id}`,
                  value: r.p50_ms,
                  muted: r.simulator,
                }))}
                unit="ms"
              />
            </Panel>

            <Panel title={`Runs (${runs.length})`}>
              <div class="scroll">
                <table>
                  <tr>
                    <th>Device</th>
                    <th>Model</th>
                    <th>Backend</th>
                    <th class="right">Top-1</th>
                    <th class="right">Top-5</th>
                    <th class="right">p50 ms</th>
                    <th class="right">p95 ms</th>
                    <th class="right">Load ms</th>
                    <th>When</th>
                  </tr>
                  {runs.map((r) => (
                    <tr key={r.job_id} class={r.simulator ? "muted-row" : ""}>
                      <td class="wrap-anywhere">
                        <Link to={`/devices/${encodeURIComponent(r.device_id)}`}>
                          <code>{r.device_model ?? r.device_id}</code>
                        </Link>
                        {r.simulator && <div class="faint">simulator</div>}
                      </td>
                      <td>
                        <Link to={`/jobs/${encodeURIComponent(r.job_id)}`}>
                          {r.model ?? "?"}
                          {r.quant ? ` ${r.quant}` : ""}
                        </Link>
                      </td>
                      <td class="dim">
                        {r.backend ?? "?"}
                        {r.accel ? ` · ${r.accel}` : ""}
                      </td>
                      <td class="num">
                        {num(r.top1_pct)}
                        {r.inferred && <span class="faint" title="read from decode_tok_s"> ᵢ</span>}
                      </td>
                      <td class="num faint">{r.top5_pct == null ? "not stored" : num(r.top5_pct)}</td>
                      <td class="num">{num(r.p50_ms)}</td>
                      <td class="num faint">{r.p95_ms == null ? "not stored" : num(r.p95_ms)}</td>
                      <td class="num">{r.load_ms ?? "—"}</td>
                      <td class="dim">{clock(r.at)}</td>
                    </tr>
                  ))}
                </table>
              </div>
            </Panel>
          </>
        );
      }}
    </Loaded>
  );
}

// --- ui tests ---

type UiRun = { job_id: string; device_id: string; at: string | null; app: string | null; build: string | null; ok: boolean; passed: number | null; failed: number | null; artifacts: string[] };
type UiData = { runs: UiRun[]; builds: string[]; devices: string[]; matrix: { build: string; cells: { device: string; latest: UiRun | null; runs: number; flaky: boolean }[] }[] };

function UiTests() {
  const state = useApi<UiData>("/api/results/ui", ["result"], 60_000);
  return (
    <Loaded state={state} what="UI test runs">
      {(d) =>
        d.runs.length === 0 ? (
          <Panel>
            <p class="empty">No ui-test results yet.</p>
          </Panel>
        ) : (
          <>
            <Panel title="Build × device" aside={<Csv name="ui-tests" rows={d.runs as unknown as Record<string, unknown>[]} />}>
              <div class="scroll">
                <table>
                  <tr>
                    <th>Build</th>
                    {d.devices.map((dev) => (
                      <th key={dev}>
                        <span class="mono">{dev.length > 18 ? `${dev.slice(0, 17)}…` : dev}</span>
                      </th>
                    ))}
                  </tr>
                  {d.matrix.map((row) => (
                    <tr key={row.build}>
                      <td>{row.build}</td>
                      {row.cells.map((c) => (
                        <td key={c.device}>
                          {c.latest ? (
                            <Link to={`/jobs/${encodeURIComponent(c.latest.job_id)}`}>
                              <Pill kind={c.latest.ok ? "done" : "failed"}>
                                {c.latest.passed ?? 0}/{(c.latest.passed ?? 0) + (c.latest.failed ?? 0)}
                              </Pill>
                            </Link>
                          ) : (
                            <span class="faint">—</span>
                          )}
                          {/* Same build, same device, different verdicts: nothing
                              changed between those runs except luck. */}
                          {c.flaky && <div class="text-warn" title={`${c.runs} runs disagreed`}>flaky</div>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </table>
              </div>
            </Panel>

            <Panel title={`Runs (${d.runs.length})`}>
              <div class="scroll">
                <table>
                  <tr>
                    <th>Job</th>
                    <th>Device</th>
                    <th>Build</th>
                    <th class="right">Passed</th>
                    <th class="right">Failed</th>
                    <th>Artifacts</th>
                    <th>When</th>
                  </tr>
                  {d.runs.map((r) => (
                    <tr key={`${r.job_id}-${r.device_id}`}>
                      <td class="wrap-anywhere">
                        <Link to={`/jobs/${encodeURIComponent(r.job_id)}`}>
                          <code>{r.job_id}</code>
                        </Link>
                      </td>
                      <td class="wrap-anywhere dim">
                        <code>{r.device_id}</code>
                      </td>
                      <td class="dim">
                        {r.app ?? "?"} {r.build ?? ""}
                      </td>
                      <td class="num">{r.passed ?? "—"}</td>
                      <td class="num">{r.failed ? <span class="text-bad">{r.failed}</span> : (r.failed ?? "—")}</td>
                      <td>
                        {r.artifacts.length === 0 ? (
                          <span class="faint">none</span>
                        ) : (
                          r.artifacts.map((a) => (
                            <a key={a} href={`/artifacts/${a}`} class="mono" title={a}>
                              {a.slice(0, 8)}{" "}
                            </a>
                          ))
                        )}
                      </td>
                      <td class="dim">{agoFrom(r.at)}</td>
                    </tr>
                  ))}
                </table>
              </div>
            </Panel>
          </>
        )
      }
    </Loaded>
  );
}

// --- drain ---

type DrainRun = {
  job_id: string; status: string; app: string | null; build: string | null; scenario: string | null;
  started_at: string | null; finished_at: string | null;
  devices: { device_id: string; ok: boolean; battery_start_pct: number | null; battery_end_pct: number | null; pct_per_h: number | null; pct_per_h_inferred: boolean; error: string | null }[];
  curve: { device_id: string; ts: string | null; battery_pct: number | null }[];
};

type ThermalSample = {
  iter: number; elapsed_s: number | null; decode_tok_s: number | null; thermal_state: string | null;
};
type ThermalDevice = {
  device_id: string; samples: number; first_tok_s: number | null; last_tok_s: number | null;
  drop_pct: number | null; throttled_at_s: number | null; throttled_to: string | null;
  curve: ThermalSample[];
};
type ThermalRun = {
  job_id: string; status: string; model: string | null; quant: string | null; backend: string | null;
  duration_s: number | null; started_at: string | null; finished_at: string | null; devices: ThermalDevice[];
};

/** Sustained throughput. A benchmark says how fast a cold device is; this says
 *  whether that number survives the device getting warm, which is the number a
 *  user actually experiences. The headline is the drop, not the peak. */
function Thermal() {
  const state = useApi<{ runs: ThermalRun[] }>("/api/results/thermal", ["result"], 60_000);
  return (
    <Loaded state={state} what="thermal runs">
      {(d) =>
        d.runs.length === 0 ? (
          <Panel>
            <p class="empty">No thermal runs yet.</p>
          </Panel>
        ) : (
          <>
            {d.runs.map((r) => (
              <Panel
                key={r.job_id}
                title={`${r.model ?? "thermal"}${r.quant ? ` · ${r.quant}` : ""} — ${r.job_id}`}
                aside={<Csv name={`thermal-${r.job_id}`} rows={r.devices as unknown as Record<string, unknown>[]} />}
              >
                <p class="empty">
                  <Link to={`/jobs/${encodeURIComponent(r.job_id)}`}>
                    <code>{r.job_id}</code>
                  </Link>{" "}
                  · {clock(r.started_at)}
                  {r.duration_s ? ` · ${duration(r.duration_s)} requested` : ""}
                  {r.backend ? ` · ${r.backend}` : ""}
                </p>

                {r.devices.some((dev) => dev.curve.length > 0) && (
                  <MultiSeries
                    unit="tok/s"
                    series={r.devices.map((dev) => ({
                      name: dev.device_id,
                      // Elapsed seconds, not wall-clock: two runs on different
                      // days should lie on top of each other.
                      points: dev.curve
                        .filter((c) => c.elapsed_s !== null && c.decode_tok_s !== null)
                        .map((c) => ({ t: (c.elapsed_s as number) * 1000, v: c.decode_tok_s })),
                    }))}
                  />
                )}

                <div class="scroll">
                  <table>
                    <tr>
                      <th>Device</th>
                      <th>Samples</th>
                      <th>First</th>
                      <th>Last</th>
                      <th>Change</th>
                      <th>Throttled</th>
                    </tr>
                    {r.devices.map((dev) => (
                      <tr key={dev.device_id}>
                        <td class="wrap-anywhere">
                          <Link to={`/devices/${encodeURIComponent(dev.device_id)}`}>{dev.device_id}</Link>
                        </td>
                        <td class="dim">{dev.samples}</td>
                        <td>{num(dev.first_tok_s)}</td>
                        <td>{num(dev.last_tok_s)}</td>
                        <td class={dev.drop_pct !== null && dev.drop_pct <= -10 ? "bad" : undefined}>
                          {dev.drop_pct === null ? "—" : `${dev.drop_pct > 0 ? "+" : ""}${dev.drop_pct.toFixed(1)}%`}
                        </td>
                        <td class="dim">
                          {dev.throttled_at_s === null
                            ? "not while measured"
                            : `${duration(dev.throttled_at_s)} → ${dev.throttled_to}`}
                        </td>
                      </tr>
                    ))}
                  </table>
                </div>
              </Panel>
            ))}
          </>
        )
      }
    </Loaded>
  );
}

type ColdStartRun = {
  job_id: string; status: string; app: string | null; build: string | null;
  started_at: string | null; finished_at: string | null;
  devices: {
    device_id: string; error: string | null;
    states: { state: string; launches: number; p50_ms: number | null; p95_ms: number | null }[];
  }[];
};

/** Launch time per device, split by launch state. The oldest phone on the shelf
 *  is the one users complain about, and this is the table that says so. */
function ColdStart() {
  const state = useApi<{ runs: ColdStartRun[] }>("/api/results/cold-start", ["result"], 60_000);
  return (
    <Loaded state={state} what="cold-start runs">
      {(d) =>
        d.runs.length === 0 ? (
          <Panel>
            <p class="empty">No cold-start runs yet.</p>
          </Panel>
        ) : (
          <>
            {d.runs.map((r) => (
              <Panel
                key={r.job_id}
                title={`${r.app ?? "cold-start"}${r.build ? ` · ${r.build}` : ""} — ${r.job_id}`}
                aside={<Csv name={`cold-start-${r.job_id}`} rows={r.devices as unknown as Record<string, unknown>[]} />}
              >
                <p class="empty">
                  <Link to={`/jobs/${encodeURIComponent(r.job_id)}`}>
                    <code>{r.job_id}</code>
                  </Link>{" "}
                  · {clock(r.started_at)}
                </p>
                <div class="scroll">
                  <table>
                    <tr>
                      <th>Device</th>
                      <th>State</th>
                      <th>Launches</th>
                      <th>p50</th>
                      <th>p95</th>
                    </tr>
                    {r.devices.flatMap((dev) =>
                      dev.states.length === 0
                        ? [
                            <tr key={dev.device_id}>
                              <td class="wrap-anywhere">{dev.device_id}</td>
                              <td class="dim" colSpan={4}>
                                {dev.error ?? "no launches measured"}
                              </td>
                            </tr>,
                          ]
                        : dev.states.map((st, i) => (
                            <tr key={`${dev.device_id}-${st.state}`}>
                              <td class="wrap-anywhere">
                                {i === 0 ? (
                                  <Link to={`/devices/${encodeURIComponent(dev.device_id)}`}>{dev.device_id}</Link>
                                ) : (
                                  ""
                                )}
                              </td>
                              <td class="dim">{st.state}</td>
                              <td class="dim">{st.launches}</td>
                              <td>{st.p50_ms === null ? "—" : `${Math.round(st.p50_ms)} ms`}</td>
                              <td>{st.p95_ms === null ? "—" : `${Math.round(st.p95_ms)} ms`}</td>
                            </tr>
                          )),
                    )}
                  </table>
                </div>
              </Panel>
            ))}
          </>
        )
      }
    </Loaded>
  );
}

function Drain() {
  const state = useApi<{ runs: DrainRun[] }>("/api/results/drain", ["result"], 60_000);
  return (
    <Loaded state={state} what="drain runs">
      {(d) =>
        d.runs.length === 0 ? (
          <Panel>
            <p class="empty">No drain runs yet.</p>
          </Panel>
        ) : (
          <>
            {d.runs.map((r) => {
              const byDevice = [...new Set(r.curve.map((c) => c.device_id))];
              return (
                <Panel
                  key={r.job_id}
                  title={`${r.app ?? "drain"} — ${r.job_id}`}
                  aside={<Csv name={`drain-${r.job_id}`} rows={r.devices as unknown as Record<string, unknown>[]} />}
                >
                  <p class="empty">
                    <Link to={`/jobs/${encodeURIComponent(r.job_id)}`}>
                      <code>{r.job_id}</code>
                    </Link>{" "}
                    · {clock(r.started_at)} · {duration(
                      r.finished_at && r.started_at
                        ? (new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 1000
                        : null,
                    )}
                    {r.scenario ? ` · ${r.scenario}` : ""}
                  </p>

                  {byDevice.length > 0 && (
                    <MultiSeries
                      yMax={100}
                      unit="battery %"
                      // Same gap rule as the device battery chart: a run that
                      // went quiet for hours must not show a drain slope
                      // across them.
                      gapMs={BATTERY_GAP_MS}
                      series={byDevice.map((dev) => ({
                        name: dev,
                        points: r.curve
                          .filter((c) => c.device_id === dev && c.ts)
                          .map((c) => ({ t: new Date(c.ts!).getTime(), v: c.battery_pct })),
                      }))}
                    />
                  )}

                  <div class="scroll">
                    <table>
                      <tr>
                        <th>Device</th>
                        <th class="right">Start</th>
                        <th class="right">End</th>
                        <th class="right">%/hour</th>
                        <th>App survived</th>
                      </tr>
                      {r.devices.map((dev) => (
                        <tr key={dev.device_id}>
                          <td class="wrap-anywhere">
                            <Link to={`/devices/${encodeURIComponent(dev.device_id)}`}>
                              <code>{dev.device_id}</code>
                            </Link>
                          </td>
                          <td class="num">{dev.battery_start_pct ?? "—"}</td>
                          <td class="num">{dev.battery_end_pct ?? "—"}</td>
                          <td class="num">
                            {num(dev.pct_per_h)}
                            {/* Older runs stored this in decode_tok_s because
                                there was no field for it. Saying so beats
                                printing it as though there always had been. */}
                            {dev.pct_per_h_inferred && (
                              <span class="faint" title="read from decode_tok_s; predates metrics.drain_pct_per_h"> ᵢ</span>
                            )}
                          </td>
                          <td>
                            <Pill kind={dev.ok ? "done" : "failed"}>{dev.ok ? "yes" : "died"}</Pill>
                            {dev.error && <div class="faint">{dev.error}</div>}
                          </td>
                        </tr>
                      ))}
                    </table>
                  </div>
                </Panel>
              );
            })}
          </>
        )
      }
    </Loaded>
  );
}

// --- soak ---

type SoakRun = {
  job_id: string; status: string; app: string | null; started_at: string | null; finished_at: string | null;
  devices: { device_id: string; checks: { iter: number; alive: boolean; at: string | null }[]; survived: boolean; died_at_check: number | null; died_at: string | null }[];
};

function Soak() {
  const state = useApi<{ runs: SoakRun[] }>("/api/results/soak", ["result"], 60_000);
  return (
    <Loaded state={state} what="soak runs">
      {(d) => {
        const withChecks = d.runs.filter((r) => r.devices.length > 0);
        return withChecks.length === 0 ? (
          <Panel>
            <p class="empty">No soak runs with check data yet.</p>
          </Panel>
        ) : (
          <>
            {withChecks.map((r) => (
              <Panel
                key={r.job_id}
                title={`${r.app ?? "soak"} — ${r.job_id}`}
                aside={
                  <Csv
                    name={`soak-${r.job_id}`}
                    rows={r.devices.flatMap((dev) => dev.checks.map((c) => ({ device_id: dev.device_id, ...c })))}
                  />
                }
              >
                <p class="empty">
                  <Link to={`/jobs/${encodeURIComponent(r.job_id)}`}>
                    <code>{r.job_id}</code>
                  </Link>{" "}
                  · {clock(r.started_at)}
                </p>
                {/* The survival matrix: one tick per check, so a process killed
                    at check 2 reads differently from one killed at check 40. */}
                {r.devices.map((dev) => (
                  <div class="soak-row" key={dev.device_id}>
                    <span class="soak-name mono" title={dev.device_id}>
                      {dev.device_id}
                    </span>
                    <span class="soak-ticks">
                      {dev.checks.map((c) => (
                        <i
                          key={c.iter}
                          class={c.alive ? "alive" : "dead"}
                          title={`check ${c.iter} · ${c.alive ? "alive" : "not running"} · ${clock(c.at)}`}
                        />
                      ))}
                    </span>
                    <span class="soak-verdict">
                      {dev.survived ? (
                        <Pill kind="done">survived {dev.checks.length} checks</Pill>
                      ) : (
                        <Pill kind="failed">died at check {dev.died_at_check}</Pill>
                      )}
                    </span>
                  </div>
                ))}
              </Panel>
            ))}
          </>
        );
      }}
    </Loaded>
  );
}

// --- page ---

export function Results() {
  const [q, setQuery] = useQuery();
  const view = q.get("view") ?? "bench";
  const hideSims = q.get("simulator") !== "true";

  return (
    <>
      <h1>Results</h1>
      <Panel>
        <div class="filters">
          <Select
            label="view"
            value={view}
            options={VIEWS.map(([v, label]) => ({ value: v, label }))}
            onChange={(v) => setQuery({ view: v || "bench" })}
          />
          {(view === "bench" || view === "vision") && (
            <label class="field checkbox">
              <input
                type="checkbox"
                checked={!hideSims}
                onChange={(e) => setQuery({ simulator: (e.target as HTMLInputElement).checked ? "true" : null })}
              />
              {/* Off by default: simulator numbers are real measurements of a
                  simulator, and mean nothing about hardware. */}
              <span>include simulators</span>
            </label>
          )}
        </div>
      </Panel>

      {view === "bench" && <Bench hideSims={hideSims} />}
      {view === "thermal" && <Thermal />}
      {view === "cold-start" && <ColdStart />}
      {view === "vision" && <Vision hideSims={hideSims} />}
      {view === "ui" && <UiTests />}
      {view === "drain" && <Drain />}
      {view === "soak" && <Soak />}
    </>
  );
}
