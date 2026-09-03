// "Add a device" — the screen that turns a phone on the shelf into a runner.
//
// The software side of enrolling is easy. The friction is typing the
// collector's address on a touch keyboard, correctly, once per device,
// and then not knowing whether it worked. So: a QR code, a download, and a
// panel that watches the registry and tells you the moment the device appears.
import { useEffect, useState } from "preact/hooks";
import qrcode from "qrcode-generator";
import { useApi, type DeviceList } from "../api.js";
import { onLive } from "../live.js";
import { Link, Loaded, Panel, Pill, bytes, clock } from "../ui.js";

type Enroll = {
  port: number;
  bases: { url: string; address: string; iface: string; kind: string }[];
  runner_apk: { sha256: string; name: string; size: number; created_at: string | null; download: string } | null;
  known_device_ids: string[];
  pools: string[];
};

/**
 * QR as SVG: one path of module rectangles, so it stays crisp at any size and
 * needs no canvas.
 *
 * Deliberately black-on-white in both themes. A dark-mode QR with a dark
 * background is the kind of thing that looks considered and then will not scan,
 * and the quiet zone matters as much as the modules — scanners need the margin.
 */
function QR({ text, size = 220 }: { text: string; size?: number }) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  const total = n + quiet * 2;

  let d = "";
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      if (qr.isDark(r, c)) d += `M${c + quiet},${r + quiet}h1v1h-1z`;

  return (
    <svg class="qr" width={size} height={size} viewBox={`0 0 ${total} ${total}`} role="img" aria-label={`QR code for ${text}`}>
      <rect width={total} height={total} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}

export function Enroll() {
  const state = useApi<Enroll>("/api/enroll", ["device", "artifact"]);
  const [chosen, setChosen] = useState<string | null>(null);
  // Snapshot at mount: anything not in here that shows up later is new.
  const [before, setBefore] = useState<Set<string> | null>(null);
  const [arrived, setArrived] = useState<string[]>([]);

  useEffect(() => {
    if (state.data && before === null) setBefore(new Set(state.data.known_device_ids));
  }, [state.data, before]);

  useEffect(() => {
    if (!before) return;
    const check = async () => {
      const list = (await (await fetch("/api/devices")).json()) as DeviceList;
      const fresh = list.devices.map((d) => d.device_id).filter((id) => !before.has(id));
      if (fresh.length) setArrived(fresh);
    };
    void check();
    return onLive(["device", "beacon"], () => void check());
  }, [before]);

  return (
    <>
      <h1>Add a device</h1>
      <Loaded state={state} what="enrolment info">
        {(d) => {
          // Prefer the address this browser actually used — if it works for
          // you it probably works for the phone. Unless it is loopback, which
          // means a tunnel, and a phone cannot reach your laptop's localhost.
          const origin = location.origin;
          const originIsLocal = /^https?:\/\/(localhost|127\.|\[::1\])/.test(origin);
          const candidates = [
            ...(originIsLocal ? [] : [{ url: origin, address: "this browser", iface: "—", kind: "current" }]),
            ...d.bases,
          ];
          const url = chosen ?? candidates[0]?.url ?? origin;

          return (
            <>
              {originIsLocal && (
                <Panel>
                  <p class="stub">
                    You are viewing this over <code>{origin}</code> — a tunnel or port-forward. A phone cannot reach
                    that. Pick the address below that is on the same network as the device.
                  </p>
                </Panel>
              )}

              <Panel title="1 · Point the device at this collector">
                <div class="enroll">
                  <div class="enroll-qr">
                    <QR text={url} />
                    <code class="enroll-url">{url}</code>
                  </div>
                  <div class="enroll-steps">
                    <p class="stub">
                      Scan it with the phone's camera, or type the address into the runner app's Collector URL field.
                      Nothing here is device-specific — the same code enrols every device.
                    </p>
                    {candidates.length > 1 && (
                      <>
                        <h3 class="sub">Address to encode</h3>
                        <div class="filters">
                          {candidates.map((c) => (
                            <label class="field checkbox" key={c.url}>
                              <input type="radio" name="base" checked={c.url === url} onChange={() => setChosen(c.url)} />
                              <span>
                                <code>{c.url}</code>{" "}
                                <span class="faint">
                                  {c.kind === "tailnet" ? "tailnet — works off-LAN" : c.kind === "lan" ? `LAN · ${c.iface}` : "as loaded"}
                                </span>
                              </span>
                            </label>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </Panel>

              <Panel title="2 · Install the runner">
                <h3 class="sub">Android</h3>
                {d.runner_apk ? (
                  <p class="stub">
                    <a href={d.runner_apk.download}>
                      <strong>{d.runner_apk.name}</strong>
                    </a>{" "}
                    <span class="faint">
                      {bytes(d.runner_apk.size)} · built {clock(d.runner_apk.created_at)}
                    </span>
                    <br />
                    Open that link on the phone itself (scan the code above, then browse to{" "}
                    <code>/dash/devices/new</code>), or sideload over USB:
                  </p>
                ) : (
                  <p class="empty">
                    No APK in the artifact store yet. Build one with <code>./gradlew :app:assembleDebug</code> and
                    upload it, or install over USB from the checkout.
                  </p>
                )}
                <pre class="cmd">
                  {`adb install -r ${d.runner_apk?.name ?? "app-debug.apk"}
adb shell am start -n com.taylab.fleetrunner/.MainActivity`}
                </pre>
                <p class="stub">
                  Then set the Collector URL to the address above and tap <strong>Start agent</strong>. The app keeps a
                  foreground service alive, so it survives the screen going off.
                </p>

                <h3 class="sub">iOS</h3>
                <p class="stub">
                  TestFlight internal build, or from the checkout onto a simulator:
                </p>
                <pre class="cmd">
                  {`xcodegen generate && xcodebuild -project FleetRunner.xcodeproj -scheme FleetRunner \\
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -derivedDataPath build build
xcrun simctl install booted build/Build/Products/Debug-iphonesimulator/FleetRunner.app
xcrun simctl launch booted com.taylab.fleetrunner -autostart 1`}
                </pre>
                <p class="stub">
                  A simulator reaches a collector on the same Mac at <code>127.0.0.1</code>; a real iPhone needs the LAN
                  or tailnet address. Simulators are flagged in the dashboard and kept out of hardware comparisons.
                </p>
              </Panel>

              <Panel
                title="3 · Watch for it"
                aside={arrived.length > 0 ? <Pill kind="done">{arrived.length} new</Pill> : undefined}
              >
                {arrived.length === 0 ? (
                  <p class="waiting">
                    <span class="spinner" /> Watching the registry — a device appears here the moment it registers.
                    {d.known_device_ids.length > 0 && (
                      <span class="faint"> ({d.known_device_ids.length} already enrolled.)</span>
                    )}
                  </p>
                ) : (
                  <>
                    {arrived.map((id) => (
                      <p class="arrived" key={id}>
                        <strong>{id}</strong> registered —{" "}
                        <Link to={`/devices/${encodeURIComponent(id)}`}>open it</Link> to give it a name, notes, or
                        a pool.
                      </p>
                    ))}
                  </>
                )}
                <p class="stub">
                  A device joins whatever pools its runner reports. You can override that per device on its page — the
                  override is what the queue claims through, and a re-registration cannot clobber it.
                  {d.pools.length > 0 && (
                    <>
                      {" "}
                      Pools in use today: {d.pools.map((p) => <code key={p}>{p} </code>)}
                    </>
                  )}
                </p>
              </Panel>
            </>
          );
        }}
      </Loaded>
    </>
  );
}
