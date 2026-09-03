import { defineConfig, devices } from "@playwright/test";

/**
 * Web suites for the fleet's `web-test` workload.
 *
 * The base URL comes from the job, not from here: a nightly should be able to
 * point the same suite at a preview deployment, a local build or production
 * without the suite knowing which. The executor passes it as
 * PLAYWRIGHT_BASE_URL.
 */
export default defineConfig({
  testDir: "web-specs",
  // No retries. A retry that turns red into green destroys the signal the
  // suite exists to produce; the dashboard's flaky detection is the gate.
  retries: 0,
  forbidOnly: true,
  reporter: "json",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL,
    // Both only on failure: a passing nightly should not upload a video of
    // itself every night to a store that has to be garbage collected.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    // Emulated mobile: real viewport, touch and UA on the desktop engines the
    // host already has — not real phones. Real-device capture is a later phase;
    // these exist so the matrix covers mobile layouts tonight, not eventually.
    { name: "mobile-chrome", use: { ...devices["Pixel 7"] } },
    { name: "mobile-safari", use: { ...devices["iPhone 14"] } },
  ],
});
