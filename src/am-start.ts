/**
 * Parsing `adb shell am start -W` output.
 *
 * Its own module, and pure, for the same reason targets.ts is: the executor is
 * a long-running process with a main() loop and cannot be imported, so anything
 * only reachable from inside it is only ever tested by plugging in a phone.
 * This is the one piece of cold-start that decides what number gets stored, so
 * it is the piece that has to be checkable without hardware.
 *
 * The output shape, from a device that launched something:
 *
 *   Starting: Intent { act=android.intent.action.MAIN ... cmp=com.x/.MainActivity }
 *   Status: ok
 *   LaunchState: COLD
 *   Activity: com.x/.MainActivity
 *   TotalTime: 412
 *   WaitTime: 431
 *   Complete
 *
 * Three details cost real measurements if they are missed:
 *
 * 1. adb's shell transport converts LF to CRLF, so every line arrives with a
 *    trailing \r. `/TotalTime: (\d+)/` still matches, but a naive line-equality
 *    or end-anchored pattern does not, and `Status: ok\r` !== "ok".
 *
 * 2. `am start` on an activity that is ALREADY foreground answers
 *    "Warning: Activity not started, its current task has been brought to the
 *    front" and, on most builds, prints no TotalTime at all. There is no launch
 *    to time; a parser returning 0 there would report an instant launch that
 *    never happened.
 *
 * 3. LaunchState (Android 10+) is the framework's own verdict on whether that
 *    launch was cold, warm or hot. It is ground truth in a way our
 *    force-stop-then-start choreography is not -- a "cold" launch of an app the
 *    OS still had warm in memory really is a warm launch, and filing it as cold
 *    is how a p95 stops describing anything.
 */

export type AmStartLaunch = {
  /** `Status:` verbatim (lowercased), usually "ok"; null when absent. */
  status: string | null;
  /** `TotalTime:` — the framework's launch time in ms. Null when not reported. */
  totalMs: number | null;
  /** `WaitTime:` — TotalTime plus the ActivityManager's own bookkeeping. */
  waitMs: number | null;
  /** `ThisTime:` — the last activity in a launch chain; equals TotalTime for a single activity. */
  thisMs: number | null;
  /** `LaunchState:` normalised, when the platform reports one (Android 10+). */
  launchState: "cold" | "warm" | "hot" | null;
  /** `Warning:` line, verbatim. Present when nothing was actually launched. */
  warning: string | null;
  /** `Error:` line, verbatim. Present when the intent could not be resolved. */
  error: string | null;
};

const num = (lines: string[], key: string): number | null => {
  for (const l of lines) {
    const m = new RegExp(`^${key}:\\s*(-?\\d+)$`).exec(l);
    if (m) return Number(m[1]);
  }
  return null;
};

const str = (lines: string[], key: string): string | null => {
  for (const l of lines) {
    const m = new RegExp(`^${key}:\\s*(.+)$`).exec(l);
    if (m) return m[1].trim();
  }
  return null;
};

export function parseAmStart(out: string): AmStartLaunch {
  // \r first: adb's shell hands back CRLF, and every field below is anchored.
  const lines = out.replace(/\r/g, "").split("\n").map((l) => l.trim());
  const state = str(lines, "LaunchState")?.toLowerCase();
  return {
    status: str(lines, "Status")?.toLowerCase() ?? null,
    totalMs: num(lines, "TotalTime"),
    waitMs: num(lines, "WaitTime"),
    thisMs: num(lines, "ThisTime"),
    launchState: state === "cold" || state === "warm" || state === "hot" ? state : null,
    warning: str(lines, "Warning"),
    error: str(lines, "Error"),
  };
}

/**
 * Why this launch cannot be reported as a measurement, or null if it can.
 *
 * Separate from the parse so the rule is stated once and is testable: a row is
 * only a launch time if the framework said ok AND printed a TotalTime. Every
 * other shape -- an unresolvable intent, a task merely brought to the front, a
 * `Status: timeout` -- has no launch time in it, and the honest result is a
 * failed row naming what the device said rather than a number.
 */
export function amStartProblem(r: AmStartLaunch): string | null {
  if (r.error) return `am start failed: ${r.error}`;
  if (r.status !== null && r.status !== "ok") return `am start reported Status: ${r.status}`;
  if (r.totalMs === null) {
    return r.warning
      ? `am start reported no TotalTime (${r.warning})`
      : "am start reported no TotalTime";
  }
  return null;
}
