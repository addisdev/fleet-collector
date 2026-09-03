// Screenshot capture for the `web-shots` workload.
//
// This spec is a GENERATOR: it defines one test per page listed in the
// manifest named by SHOTS_MANIFEST, writing each screenshot to SHOTS_OUT.
// Running capture as a Playwright test — rather than via the library API —
// is what keeps the profile list honest: `--project=mobile-safari` here means
// exactly what it means for web-test, because both read the same project
// definitions from playwright.config.ts. A hand-rolled launcher would carry
// its own copy of the device presets, and a copy is where the emulated
// viewport and the tested viewport quietly stop being the same thing.
//
// With SHOTS_MANIFEST unset this file defines no tests at all, so a plain
// web-test run over the whole specs dir (`suite.flows: "."`) never captures
// screenshots by accident.
//
// Determinism, because a diff pipeline sits downstream (Phase 3): reduced
// motion is emulated, animations/transitions/caret are killed both by
// Playwright's screenshot option and by injected CSS, fonts are awaited, and
// the manifest may pin Date via freeze_time. Dynamic regions that remain are
// the manifest's job to mask.
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";

type ShotPage = {
  name: string;
  path: string;
  waitFor?: string;
  mask?: string[];
  fullPage?: boolean;
};
type Manifest = { pages?: ShotPage[]; freeze_time?: string };

const manifestPath = process.env.SHOTS_MANIFEST;
const outDir = process.env.SHOTS_OUT;
const manifest: Manifest = manifestPath ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};

for (const p of manifest.pages ?? []) {
  test(`shot: ${p.name}`, async ({ page }) => {
    if (!outDir) throw new Error("SHOTS_OUT is not set");
    // Before navigation, so the page never sees the real clock. setFixedTime
    // rather than clock.install: install takes over timers too, and a page
    // waiting on a setTimeout to render would wait forever.
    if (manifest.freeze_time) await page.clock.setFixedTime(new Date(manifest.freeze_time));
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(p.path, { waitUntil: "load" });
    if (p.waitFor) await page.locator(p.waitFor).first().waitFor({ timeout: 15_000 });
    await page.addStyleTag({
      content: "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }",
    });
    // A shot taken mid font-swap diffs against itself forever.
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.screenshot({
      path: path.join(outDir, `${p.name}.png`),
      fullPage: p.fullPage ?? true,
      animations: "disabled",
      mask: (p.mask ?? []).map((s) => page.locator(s)),
    });
  });
}
