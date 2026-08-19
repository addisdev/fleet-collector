// The shelf. What is online, what it is doing, and how to get to it.
import { useState } from "preact/hooks";
import { useApi, type Device, type DeviceList } from "../api.js";
import { mutate, useMutation } from "../mutate.js";
import { refreshNames } from "../names.js";
import { useQuery } from "../router.js";
import { Filters, Link, Loaded, Panel, Pill, Search, Select, Stat, agoFrom } from "../ui.js";

/** Rename in place. Naming a shelf is a dozen small edits in one sitting, and
 *  making each one a trip to a detail page and back is how it does not happen. */
function Rename({ device, onDone }: { device: Device; onDone: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(device.nickname ?? "");

  const save = useMutation(async () => {
    const r = await mutate("PATCH", `/api/devices/${encodeURIComponent(device.device_id)}`, {
      nickname: value.trim() || null,
    });
    await refreshNames();
    setEditing(false);
    onDone();
    return r;
  });

  if (!editing)
    return (
      <button type="button" class="linkish" onClick={() => setEditing(true)}>
        {device.nickname ? "rename" : "name it"}
      </button>
    );

  return (
    <span class="rename">
      <input
        autofocus
        value={value}
        placeholder="shelf top left"
        onInput={(e) => setValue((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void save.go();
          if (e.key === "Escape") setEditing(false);
        }}
      />
      <button type="button" class="linkish" disabled={save.busy} onClick={() => void save.go()}>
        save
      </button>
      <button type="button" class="linkish" onClick={() => setEditing(false)}>
        cancel
      </button>
    </span>
  );
}

export function Battery({ pct, charging }: { pct: number | null; charging: boolean | null }) {
  if (pct == null) return <span class="faint">—</span>;
  // Simulators report -1 rather than a battery level. Showing "-1%" would look
  // like a reading; it is the absence of one.
  if (pct < 0) return <span class="faint" title="Device reports no battery telemetry">n/a</span>;
  const tone = pct < 15 && !charging ? "bad" : pct < 30 && !charging ? "warn" : "";
  return (
    <span class={tone} title={charging ? "charging" : "on battery"}>
      {pct}%{charging ? " ⚡" : ""}
    </span>
  );
}

export function Thermal({ state }: { state: string | null }) {
  if (!state) return <span class="faint">—</span>;
  return <span class={`th-text th-${state}`}>{state}</span>;
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
                      <th></th>
                      <th>Hardware</th>
                      <th>Pools</th>
                      <th>Battery</th>
                      <th>Thermal</th>
                      <th>Doing</th>
                      <th>Last seen</th>
                    </tr>
                    {d.devices.map((dev) => (
                      <tr key={dev.device_id}>
                        <td class="wrap-anywhere">
                          <Link to={`/devices/${encodeURIComponent(dev.device_id)}`}>
                            {dev.nickname ? (
                              <>
                                <strong>{dev.nickname}</strong>
                                <div class="faint mono devid">{dev.device_id}</div>
                              </>
                            ) : (
                              <code>{dev.device_id}</code>
                            )}
                          </Link>
                          <div>
                            <Pill kind={dev.status} />
                            {dev.simulator && <span class="faint"> simulator</span>}
                          </div>
                        </td>
                        <td>
                          <Rename device={dev} onDone={state.reload} />
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
                        <td class="dim">{agoFrom(dev.last_seen)}</td>
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
