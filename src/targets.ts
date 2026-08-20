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
 * "Attached" is not the same as "in the fleet". The Mac hosting the iOS
 * executor is a workstation with Xcode, so at any moment it may have scratch
 * simulators booted for something unrelated -- and registering those would let
 * a nightly claim a developer's throwaway device and report the result as
 * fleet hardware.
 *
 * Membership is decided by asking simctl, never by which enumerator produced
 * the target: devicectl also lists booted simulators as connected devices, so
 * the same UDID arrives twice, once as a simulator and once as a device.
 * Trusting the caller's label let that second copy walk straight past this
 * check -- observed, not theorised.
 */
export function fleetOwned(
  udid: string,
  sims: Record<string, { udid: string; name: string }[]> | null,
  prefix = SIM_PREFIX,
): boolean {
  const name = Object.values(sims ?? {}).flat().find((d) => d.udid === udid)?.name;
  // simctl has never heard of it, so it is not a simulator: real hardware is
  // in by virtue of somebody having cabled it to the shelf.
  if (name === undefined) return true;
  return name.toLowerCase().startsWith(prefix.toLowerCase());
}
