// The shelf. What is online, what it is doing, and how to get to it.
import { useState } from "preact/hooks";
import { useApi, type Device, type DeviceList } from "../api.js";
import { Icon } from "../icons.js";
import { mutate, useMutation } from "../mutate.js";
import { refreshNames } from "../names.js";
import { useQuery } from "../router.js";
import { Filters, Link, Loaded, Panel, Pill, Search, Select, Stat, agoFrom } from "../ui.js";

/**
 * The device's name, editable by clicking it.
 *
 * No button and no separate column: the thing you want to change is the thing
 * you click. An unnamed device shows its id, because until you name it that is
 * its name — so the same click renames either case.
 */
function EditableName({ device, onDone }: { device: Device; onDone: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(device.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const commit = async () => {
    const next = value.trim();
    if (next === (device.name ?? "")) return setEditing(false);
    setBusy(true);
    try {
      await mutate("PATCH", `/api/devices/${encodeURIComponent(device.device_id)}`, { name: next || null });
      await refreshNames();
      setEditing(false);
      setError(null);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (editing)
    return (
      <span class="name-edit">
        <input
          autofocus
          disabled={busy}
          value={value}
          placeholder={device.device_id}
          onInput={(e) => setValue((e.target as HTMLInputElement).value)}
          // Blur commits too: clicking away from a half-typed name and losing
          // it is the most annoying way an inline editor can behave.
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") void commit();
            if (e.key === "Escape") {
              setValue(device.name ?? "");
              setEditing(false);
            }
          }}
        />
        {error && <span class="text-bad name-err">{error}</span>}
      </span>
    );

  return (
    <button
      type="button"
      class="name-btn"
      title={`${device.device_id} — click to rename`}
      onClick={() => {
        setValue(device.name ?? "");
        setEditing(true);
      }}
    >
      {device.name ? <strong>{device.name}</strong> : <code>{device.device_id}</code>}
    </button>
  );
}

export function Battery({ pct, charging }: { pct: number | null; charging: boolean | null }) {
  if (pct == null) return <span class="faint">—</span>;
  // Simulators report -1 rather than a battery level. Showing "-1%" would look
  // like a reading; it is the absence of one.
  if (pct < 0) return <span class="faint" title="Device reports no battery telemetry">n/a</span>;
  // .text-bad / .text-warn are the word-colouring classes; bare .bad and
  // .warn only exist scoped to stat tiles, so a low battery never went red.
  const tone = pct < 15 && !charging ? "text-bad" : pct < 30 && !charging ? "text-warn" : "";
  return (
    <span class={tone ? `with-icon ${tone}` : "with-icon"} title={charging ? "charging" : "on battery"}>
      {pct}%{charging && <Icon name="charging" title="charging" />}
    </span>
  );
}

export function Thermal({ state }: { state: string | null }) {
  if (!state) return <span class="faint">—</span>;
  return (
    <span class={`with-icon th-text th-${state}`}>
      <Icon name="thermal" />
      {state}
    </span>
  );
}

export function Devices() {
  const [q, setQuery] = useQuery();
  const status = q.get("status") ?? "";
  const pool = q.get("pool") ?? "";
  const platform = q.get("platform") ?? "";
  const search = q.get("q") ?? "";
  const hideSims = q.get("simulator") === "false";

  const params = new URLSearchParams();
  for (const [k, v] of [
    ["status", status],
    ["pool", pool],
    ["platform", platform],
    ["q", search],
    ["simulator", hideSims ? "false" : ""],
  ] as const)
    if (v) params.set(k, v);

  const state = useApi<DeviceList>(
    `/api/devices${params.toString() ? `?${params}` : ""}`,
    ["device", "beacon", "job", "lock"],
    30_000,
  );
  const active = !!(status || pool || platform || search || hideSims);

  return (
    <>
      <h1>
        Devices{" "}
        <Link to="/devices/new" class="newjob">
          + add a device
        </Link>
      </h1>
      <Loaded state={state} what="devices">
        {(d) => (
          <>
            <Panel>
              <Filters active={active} onClear={() => setQuery({ status: null, pool: null, platform: null, q: null, simulator: null })}>
                <Select label="status" value={status} options={["online", "stale", "offline"]} onChange={(v) => setQuery({ status: v })} />
                <Select label="pool" value={pool} options={d.pools} onChange={(v) => setQuery({ pool: v })} />
                <Select label="platform" value={platform} options={["android", "ios"]} onChange={(v) => setQuery({ platform: v })} />
                <Search label="find" value={search} placeholder="id, model, SoC" onChange={(v) => setQuery({ q: v })} />
                <label class="field checkbox">
                  <input type="checkbox" checked={hideSims} onChange={(e) => setQuery({ simulator: (e.target as HTMLInputElement).checked ? "false" : null })} />
                  <span>hardware only</span>
                </label>
              </Filters>
            </Panel>

            <Panel title={`${d.devices.length} device${d.devices.length === 1 ? "" : "s"}`}>
              {d.devices.length === 0 ? (
                <p class="empty">No device matches these filters.</p>
              ) : (
                <div class="scroll">
                  <table>
                    <tr>
                      <th>Device</th>
                      <th>Hardware</th>
                      <th>Pools</th>
                      <th>Runs</th>
                      <th>Battery</th>
                      <th>Thermal</th>
                      <th>Doing</th>
                      <th>Last seen</th>
                    </tr>
                    {d.devices.map((dev) => (
                      <tr key={dev.device_id}>
                        <td class="wrap-anywhere">
                          <EditableName device={dev} onDone={state.reload} />
                          <div>
                            <Link to={`/devices/${encodeURIComponent(dev.device_id)}`} class="faint open-link">
                              open
                            </Link>{" "}
                            <Pill kind={dev.status} />{" "}
                            {dev.simulator && (
                              <span class="faint with-icon">
                                <Icon name="simulator" />
                                simulator
                              </span>
                            )}
                          </div>
                        </td>
                        <td>
                          {String(dev.descriptor.model ?? "?")}
                          <div class="faint">
                            {String(dev.descriptor.os ?? "?")}
                            {dev.descriptor.soc ? ` · ${dev.descriptor.soc}` : ""}
                            {dev.descriptor.ram_mb ? ` · ${Math.round(Number(dev.descriptor.ram_mb) / 1024)} GB` : ""}
                          </div>
                        </td>
                        <td class="dim">{dev.pools.join(", ") || "—"}</td>
                        <td class="dim wrap-anywhere">
                          {dev.capabilities === null ? (
                            <span class="faint" title="Registered before capability routing; offered every workload.">
                              all
                            </span>
                          ) : (
                            dev.capabilities.join(", ") || "—"
                          )}
                        </td>
                        <td>
                          <Battery pct={dev.beacon?.battery_pct ?? null} charging={dev.beacon?.charging ?? null} />
                        </td>
                        <td>
                          <Thermal state={dev.beacon?.thermal ?? null} />
                        </td>
                        <td class="wrap-anywhere">
                          {dev.current_job ? (
                            <Link to={`/jobs/${encodeURIComponent(dev.current_job)}`}>
                              <code>{dev.current_job}</code>
                            </Link>
                          ) : (
                            <span class="faint">idle</span>
                          )}
                          {dev.lock && <div class="faint">locked</div>}
                        </td>
                        <td class="dim">
                          {agoFrom(dev.last_seen)}
                          {dev.last_net && <div class="faint">{dev.last_net}</div>}
                        </td>
                      </tr>
                    ))}
                  </table>
                </div>
              )}
            </Panel>

            <Panel title="Pools">
              <div class="stats">
                {d.pools.length === 0 ? (
                  <p class="empty">No pools yet.</p>
                ) : (
                  d.pools.map((p) => (
                    <Stat key={p} label={p} value={d.devices.filter((dev) => dev.pools.includes(p)).length} />
                  ))
                )}
              </div>
            </Panel>
          </>
        )}
      </Loaded>
    </>
  );
}
