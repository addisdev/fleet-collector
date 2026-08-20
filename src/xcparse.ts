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

/**
 * The error and warning lines out of an xcodebuild log, errors first.
 *
 * Two things this gets right that the obvious version does not.
 *
 * It matches xcodebuild's actual diagnostic shapes -- a bare `error:` at line
 * start, or `file:line:col: error:` -- rather than any line containing
 * "error:". A loose match also catches echoed SOURCE, because
 * `try? outbox.markFailed(op, error: ...)` is an ordinary Swift argument
 * label, and those echoes crowd out the real thing.
 *
 * And it takes errors BEFORE warnings rather than the first N in document
 * order. An Xcode build routinely emits hundreds of deprecation warnings, so
 * with 250 of them ahead of it the single `error:` line falls outside any cap
 * applied to the document order -- which is exactly the blindness that
 * capturing diagnostics at all was meant to remove.
 */
export function xcodebuildDiagnostics(out: string, cap = 100): string[] {
  // The column is OPTIONAL, and that is not a detail. A compiler diagnostic is
  // `File.swift:90:23: warning:` but an XCTest FAILURE is `File.swift:228:
  // error: -[Suite testFoo] : failed - ...` with no column at all. Requiring
  // one dropped every test failure from the artifact -- the single line most
  // worth reading -- while faithfully preserving a hundred deprecation
  // warnings. Observed on a real run: 10 passed, 1 failed, and the artifact
  // reported zero errors.
  const all = out.match(/^(?:\S.*?:\d+(?::\d+)?:\s*)?(?:error|warning):.*$/gm) ?? [];
  const errors = all.filter((l) => /(?:^|\s)error:/.test(l));
  const warnings = all.filter((l) => !/(?:^|\s)error:/.test(l));
  return [...errors.slice(0, cap), ...warnings.slice(0, cap)];
}
