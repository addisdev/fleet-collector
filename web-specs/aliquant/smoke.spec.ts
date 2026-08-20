import { expect, test } from "@playwright/test";

// Aliquant web smoke: the page loads, is identifiably Aliquant, and renders
// without a console error. The equivalent of the Maestro launch flows — it
// proves the rail, and richer journeys belong beside the app.
test("loads and identifies itself", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  page.on("pageerror", (e) => consoleErrors.push(e.message));

  const res = await page.goto("/", { waitUntil: "domcontentloaded" });
  expect(res?.status(), "the page should not be an error response").toBeLessThan(400);

  await expect(page).toHaveTitle(/Aliquant/i);
  // Something must actually render: a blank body with a correct title is the
  // classic way a broken SPA build passes a naive smoke test.
  await expect(page.locator("body")).not.toBeEmpty();

  expect(consoleErrors, "page loaded with console errors").toEqual([]);
});
