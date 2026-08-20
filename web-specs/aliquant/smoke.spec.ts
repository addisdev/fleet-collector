import { expect, test } from "@playwright/test";

/**
 * Aliquant web smoke: the page loads, is identifiably Aliquant, and renders
 * without an error the app is responsible for.
 *
 * That last qualifier is doing real work. Cloudflare injects its Web Analytics
 * beacon at the edge, and the app's own CSP -- `default-src 'none'`, no inline
 * scripts -- correctly refuses to run it. The console error that produces is a
 * true report of a real condition, but it is not the app misbehaving: the app
 * never asked for that script. Failing the nightly on it every night would
 * teach everyone to ignore a red nightly, which is the one outcome worse than
 * having no suite at all.
 *
 * So third-party injections are recorded as an annotation and everything else
 * still fails the run.
 */

// Hosts whose scripts the app does not ship and cannot control. Kept explicit
// and short: this list is a place bugs can hide, so anything added here needs
// to be something the app genuinely does not own.
const INJECTED_AT_THE_EDGE = [/cloudflareinsights\.com/];

test("loads and identifies itself", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));

  const res = await page.goto("/", { waitUntil: "domcontentloaded" });
  expect(res?.status(), "the page should not be an error response").toBeLessThan(400);

  await expect(page).toHaveTitle(/Aliquant/i);
  // Something must actually render: a blank body with a correct title is the
  // classic way a broken SPA build passes a naive smoke test.
  await expect(page.locator("body")).not.toBeEmpty();

  const thirdParty = errors.filter((e) => INJECTED_AT_THE_EDGE.some((r) => r.test(e)));
  const ours = errors.filter((e) => !INJECTED_AT_THE_EDGE.some((r) => r.test(e)));

  // Visible in the report and in the artifact the fleet stores, so this stays
  // a known condition rather than a silenced one.
  for (const e of thirdParty) {
    testInfo.annotations.push({ type: "edge-injected script blocked by CSP", description: e });
  }

  expect(ours, "page loaded with console errors").toEqual([]);
});
