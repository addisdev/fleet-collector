// One shared device-name lookup for the whole dashboard.
//
// A device id is a machine's answer to "who are you" — `sm-x930-0d41`,
// `sdk-gphone64-arm64-b386`. Fine for a URL, useless for knowing which slab of
// glass on the shelf just went thermally critical at 3am. Nicknames existed
// since D2 but only appeared on the device's own page, so you could set a name
// and then never see it again.
//
// Every screen that prints a device id goes through here instead. One fetch,
// shared, refreshed when a device changes — not one request per table row.
import { useEffect, useState } from "preact/hooks";
import { onLive } from "./live.js";

type Names = Record<string, string>;

let cache: Names = {};
let inflight: Promise<Names> | null = null;
const watchers = new Set<(n: Names) => void>();

async function load(): Promise<Names> {
  const res = await fetch("/api/devices");
  const body = (await res.json()) as { devices: { device_id: string; name: string | null }[] };
  cache = Object.fromEntries(
    body.devices.filter((d) => d.name).map((d) => [d.device_id, d.name as string]),
  );
  for (const w of watchers) w(cache);
  return cache;
}

/** Refetch now — call after renaming so every table updates at once. */
export function refreshNames() {
  inflight = load().finally(() => (inflight = null));
  return inflight;
}

export function useDeviceNames(): Names {
  const [names, setNames] = useState<Names>(cache);
  useEffect(() => {
    watchers.add(setNames);
    if (!inflight) refreshNames();
    // A rename arrives as a device event, same as a registration.
    const off = onLive(["device"], () => void refreshNames());
    return () => {
      watchers.delete(setNames);
      off();
    };
  }, []);
  return names;
}
