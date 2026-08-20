/**
 * Which attached things the fleet should actually run work on.
 *
 * Its own module so the smoke suite can assert on it: the executor is a
 * long-running process with a main() loop and cannot be imported.
 */

/** Simulators join the fleet by name. Overridable for a host that names its own differently. */
export const SIM_PREFIX = process.env.FLEET_SIM_PREFIX ?? "fleet-";

/**
 * Is this something the fleet should be running work on?
 *
 * "Attached" is not the same as "in the fleet". Both hosts are working
 * machines: the Xcode Mac has scratch simulators booted for unrelated work,
 * and it had an Android emulator named `jerv-test` running too. Registering
 * those lets a nightly claim somebody's throwaway device and report the result
 * as fleet hardware.
 *
 * The rule is the same for every kind of virtual device, which is the point --
 * an earlier version gated iOS simulators only, and an Android emulator walked
 * straight in the day after.
 *
 *   physical hardware  -> in. Somebody cabled it up deliberately.
 *   virtual device     -> in only if its NAME opts in.
 *
 * Pass `null` for hardware, or the simulator/AVD name for anything virtual.
 */
export function fleetOwned(virtualName: string | null | undefined, prefix = SIM_PREFIX): boolean {
  if (virtualName === null || virtualName === undefined) return true;
  return virtualName.toLowerCase().startsWith(prefix.toLowerCase());
}

/**
 * The name of the virtual device behind this id, or null if it is real hardware.
 *
 * Decided by asking simctl, never by which enumerator produced the target:
 * devicectl also lists booted simulators as connected devices, so the same
 * UDID arrives twice, once as a simulator and once as a device. Trusting the
 * caller's label let that second copy walk past the check.
 */
export function simulatorName(
  udid: string,
  sims: Record<string, { udid: string; name: string }[]> | null,
): string | null {
  return Object.values(sims ?? {}).flat().find((d) => d.udid === udid)?.name ?? null;
}

/** An adb serial of the form `emulator-5554` is an emulator, not a phone. */
export function isAndroidEmulatorSerial(serial: string): boolean {
  return /^emulator-\d+$/.test(serial);
}

/** What `devicectl list devices` tells us about one entry. */
export type IosDeviceInfo = {
  identifier: string;
  name?: string;
  marketingName?: string;
  productType?: string;
  osVersion?: string;
  transport?: string;
  tunnelState?: string;
  platform?: string;
};

/**
 * Real, reachable iPhones and iPads -- not simulators, whatever devicectl calls them.
 *
 * devicectl lists SIMULATORS as devices, with no `isSimulated` flag to tell
 * them apart: on the fleet's Xcode Mac it reports 25 "devices", of which
 * exactly one is real hardware. The field that separates them is `transport`.
 * A simulator runs on this machine and is always `sameMachine`; hardware
 * arrives over `wired` or `localNetwork`.
 *
 * Filtering on tunnelState alone is what let a booted simulator register
 * itself as a physical device.
 */
export function physicalIos(all: IosDeviceInfo[]): IosDeviceInfo[] {
  return all.filter(
    (d) =>
      d.platform === "iOS" &&
      d.transport !== undefined &&
      d.transport !== "sameMachine" &&
      d.tunnelState === "connected",
  );
}
