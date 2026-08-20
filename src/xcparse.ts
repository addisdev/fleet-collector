/**
 * Count the tests xcodebuild actually ran.
 *
 * Its own module so the smoke suite can assert on it directly: the executor is
 * a long-running process with a main() loop and cannot be imported.
 *
 * The exit code alone says only "something failed", which reported 1 passed /
 * 0 failed for a suite of sixteen. Once app repos run their own suites that is
 * not a rounding error, it is a wrong number on a dashboard -- and one failure
 * hidden among fifteen passes is exactly what a nightly exists to surface.
 *
 * `skipped` is counted for a sharper reason. XCTSkip is how a suite says "I
 * could not test this" -- greenfolio's UI tests skip every case when there is
 * no signed-in session -- and xcodebuild still exits 0. Counting only passes
 * and failures turns a suite that tested NOTHING into a green run with no
 * failures, which is the most expensive kind of wrong a nightly can be.
 */
export function countXcodebuildTests(out: string): { passed: number; failed: number; skipped: number } {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  // "Test Case '-[SuiteName testFoo]' passed (1.234 seconds)."
  //
  // Anchored to the line start and to the closing quote, so a test whose NAME
  // contains "failed" -- testFailedLoginShowsBanner is an entirely ordinary
  // name -- cannot be counted as a failure. `started` lines are ignored.
  for (const m of out.matchAll(/^Test Case '.*?' (passed|failed|skipped)\b/gm)) {
    if (m[1] === "passed") passed++;
    else if (m[1] === "failed") failed++;
    else skipped++;
  }
  return { passed, failed, skipped };
}
