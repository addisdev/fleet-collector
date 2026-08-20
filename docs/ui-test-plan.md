# Nightly UI tests across iOS, Android and web

*Written 2026-08-19. Companion to [`dashboard-plan.md`](dashboard-plan.md).*

## 0. What actually exists

Surveyed rather than assumed, because the answer changes the plan.

| App | iOS | Android | Web |
|---|---|---|---|
| **GreenFolio** | `greenfolio-ios` (1214 Swift), `greenfolio-care` (272), `gf-watch` (966, watchOS) | `greenfolio-android` (333 Kotlin) | — none |
| **Jerv** | `jerv-ios` (305) | `jerv-android` (120) | `jerv-web/app`, `jerv-web/admin` — **plan only, no source** |
| **Aliquant** | `aliquant-ios` (193) | `aliquant-android` (439) | `aliquant-web/app` (62 TS, Vite + React + vitest) |

So the real target list is **eight clients**, not nine-times-three:

- **5 iOS** — greenfolio-ios, greenfolio-care, gf-watch, jerv-ios, aliquant-ios
- **3 Android** — greenfolio-android, jerv-android, aliquant-android
- **1 web** — aliquant-web

Jerv's web app and admin are planning documents with no code. They get a place in
the rails and no flows until there is something to open.

What the fleet has today: **one** Maestro flow per app for two apps
(`flows/greenfolio/smoke.yaml`, `flows/fleetrunner/smoke.yaml`), each of which
asserts the app launches and renders one screen. That is a rail test, not a test
suite.

## 1. The four things standing in the way

Worth naming before the phases, because three of them are infrastructure and
only one is test-writing.

### 1.1 iOS cannot run on fleet-host, at all

`simctl` and `devicectl` ship with full Xcode. fleet-host has only Command Line
Tools — its `xcrun` cannot find `simctl`. That is deliberate: the machine is
kept sudo-free and bare so it can be rebuilt over SSH.

**Five of the eight clients are iOS.** So a nightly that covers them needs a
second executor on a Mac with Xcode. The executor already supports this — it
identifies itself with `FLEET_EXECUTOR_NAME` and the collector tracks each one
separately — but nothing routes a job to a *particular* executor today. Any host
executor claims any host job.

### 1.2 Web is not a workload

There is no browser anywhere in the fleet. `ui-test` supports `maestro` and
`xcuitest`; there is no third kind, no browser driver, and no notion of a target
that is a URL rather than a device.

### 1.3 Nightly tests need a nightly build

The fleet tests whatever artifact a job names. Today that is a hash someone
uploaded by hand — and the schedule spent six days pointing at an APK older than
the code it was meant to guard, which is exactly the failure this catches.

CI integration is **built and dark**: `scripts/ci-enqueue.ts` uploads a build,
enqueues a job, polls to a verdict and exits 0/1; `report_to.github_status`
records a commit status and only posts when armed. Nothing in any app repo uses
it. Nightly UI tests are the reason to turn it on.

### 1.4 The flows that exist are aimed at the wrong package

`flows/greenfolio/smoke.yaml` targets `com.taylab.greenfolio.debug`. The
emulator has `com.taylab.greenfolio`. That flow cannot pass as written — which
nobody noticed, because no scheduled run has ever executed it.

## 2. Shape

```
                         ┌──────────────── collector (fleet-host) ────────────────┐
   app repo CI  ──push──►│  artifact store · job queue · results · dashboard      │
                         └───┬───────────────────┬────────────────────┬──────────┘
                             │ host jobs         │ host jobs          │ web jobs
                    ┌────────▼────────┐  ┌───────▼────────┐  ┌────────▼─────────┐
                    │ executor        │  │ executor       │  │ executor         │
                    │ fleet-host      │  │ mac-xcode      │  │ (either)         │
                    │ adb + Maestro   │  │ simctl+XCUITest│  │ Playwright       │
                    │ Android devices │  │ iOS sims/devs  │  │ headless Chromium│
                    └─────────────────┘  └────────────────┘  └──────────────────┘
```

Three additions to the collector, one per gap:

1. **`targets.executor`** — a job may name the executor that should claim it, so
   iOS work reaches the Mac with Xcode and Android work reaches the shelf.
2. **`web-test` workload** — Playwright against a URL, no device involved.
3. **CI enqueue turned on** in each app repo, so the nightly tests the build that
   was pushed rather than one someone remembered to upload.

## 3. Phases

Each ends with something demonstrably working, in the order that removes the most
uncertainty first.

| Phase | Scope | Done when |
|---|---|---|
| **U0 — route jobs to an executor** | `targets.executor` honoured in the claim path; dashboard shows which executor a job wants; smoke covers it | A job tagged `mac-xcode` is never claimed by fleet-host |
| **U1 — the iOS executor** | Second executor on the Xcode Mac under launchd, `FLEET_EXECUTOR_NAME=mac-xcode`; XCUITest path exercised end to end | `jerv-ios` smoke runs on a simulator, green, from the queue |
| **U2 — Android suites** | Real Maestro suites for the 3 Android apps, replacing launch-only smokes; fix the `.debug` appId mismatch | Each Android app has ≥1 flow beyond "it opened", running nightly |
| **U3 — iOS suites** | XCUITest schemes wired for the 5 iOS clients; watchOS scoped explicitly (see risks) | Each iOS client has a suite the queue can run |
| **U4 — web-test workload** | New workload, Playwright runner, `targets.url`, trace/screenshot artifacts | aliquant-web suite runs from the queue and uploads a trace |
| **U5 — nightly + CI** | Per-app schedules; `ci-enqueue` wired in each app repo; commit statuses armed | A push produces a build the nightly then tests, and a red suite is visible without opening the dashboard |

## 3.1 Status, 2026-08-19

**Built and running: U0, U1, U4, U5.**

| Phase | State |
|---|---|
| U0 — route jobs to an executor | done, merged |
| U1 — the iOS executor | done, `mac-xcode` under launchd, XCUITest green on a simulator |
| U2 — Android suites | **blocked on builds, not on writing flows** — see below |
| U3 — iOS suites | not started — see below |
| U4 — web-test workload | done, `aliquant-web` green against the live deployment |
| U5 — nightly + CI | done; two nightlies enabled and proven to fire |

### What U5 changed about §1.3

The plan said a nightly needs a nightly build. The fix turned out to be smaller
and more useful than wiring CI into eight repos: **artifacts now know which app
they are**, and a schedule can ask for `"sha256": "latest"` instead of a hash.

An artifact uploaded with `x-artifact-app` belongs to that app; `latest`
resolves at fire time to the newest one. A nightly for an app nobody has built
yet is *skipped rather than failed*, because a job pinned to a build that does
not exist fails in a way indistinguishable from the app being broken.

So the schedule never has to be edited again, and CI's only obligation is to
publish — `ci/publish-build.yml`, one step on merge to main.

### What the first real nightly caught

The proving run failed, and the reason was worth the exercise:
`nightly-fleet-ui-smoke` had `targets: { exclusive: true }` and nothing else, so
an **Android APK was claimed by `mac-xcode` and run against an iOS simulator.**
That is §1.4's defect again in a new place, and it would have failed silently at
02:30 every night.

Routing it (`match: os ~ 'android'` **and** `executor: fleet-host`) fixed it:
three consecutive runs then went to fleet-host and passed on the physical S8,
1 passed / 0 failed in 26s.

Both halves are needed and neither substitutes for the other — the match says
what the job needs, the executor says which machine can physically reach it.

### Why U2 and U3 are not built

Not reluctance, and not the 40 flows. **The apps are not on the devices.**

```
$ adb -s 988a1b3541354f565a shell pm list packages | grep -E 'greenfolio|jerv|aliquant'
(nothing)
```

The one Android device on the shelf has `com.taylab.fleetrunner` and nothing
else. There is no greenfolio, jerv or aliquant build installed anywhere in the
fleet, and none has ever been published to the artifact store. §1.4's `.debug`
appId mismatch is real but it is not the blocker; the blocker is that there is
nothing to launch.

That is exactly what `ci/publish-build.yml` unblocks: once an app repo publishes
on merge, its nightly resolves `latest`, the install workload puts it on the
shelf, and a suite has something to drive. Writing 40 flows against screens
nobody can open would produce flows that assert on screens I have never seen —
which is how a suite nobody trusts gets written.

**The order that works:** publish builds → install on the shelf → then write
flows against the app that is actually running.

### What the web suite caught on its first run against production

`my.aliquant.app` returns a console error on every load: Cloudflare injects its
Web Analytics beacon at the edge, and the app's own CSP — `default-src 'none'`,
`script-src 'self'` — correctly refuses to run it. **Cloudflare Web Analytics is
silently collecting nothing on that site.**

The CSP is not the bug. It is deliberate, documented in `worker/index.ts`, and
good. The fix is to turn off the analytics auto-injection for that zone in the
Cloudflare dashboard, which is a decision for whoever owns it.

The suite records it as an annotation rather than failing on it, on the grounds
that the app never asked for that script and cannot remove it. Everything else
in the console still fails the run. That line is worth keeping narrow: the list
of hosts treated this way is one entry long and is a place bugs could hide.

### Commit statuses: still dark, deliberately

`report_to.github_status` records a row for every job that asks, and posts
nothing unless `FLEET_GITHUB_STATUS=1` and `FLEET_GITHUB_TOKEN` are both set on
the collector. Unarmed rows are visible on the dashboard, so you can see what
*would* have been posted before anything reaches GitHub.

Arming it makes a red nightly block a PR — open question 5, and a decision with
consequences for everyone who pushes. Left off.

## 4. Design decisions

### 4.1 Route by executor, not by pool

Pools were removed from job targeting for good reason — a label someone has to
keep accurate drifts. But `targets.executor` is not a capability label; it is a
statement about *which machine* can physically reach the device or toolchain.
That is not a property of the device, so match expressions cannot express it.

Fallback stays permissive: a job with no `targets.executor` is claimable by any
executor, exactly as today.

### 4.2 Suites live with the app, not with the collector

`flows/` in the collector was right for proving the rail and is wrong as a home
for real suites: a flow and the screen it drives change together, and a flow
stored in a different repo silently rots when the screen moves.

So each app repo owns `e2e/` (Maestro YAML for Android, XCUITest target for iOS,
Playwright specs for web), and CI uploads the suite alongside the build as a
second artifact. The job names both hashes. That makes a nightly reproducible:
build *and* suite are pinned, and an old result can be re-run exactly.

### 4.3 One flow per user journey, not per screen

The catalogue to aim at, per app — deliberately small, because a suite nobody
trusts is worse than no suite:

- **launch** — opens, renders, no crash (what exists today)
- **auth** — sign in, sign out, and the signed-out state
- **core loop** — the one thing the app is for: GreenFolio identifies a plant,
  Jerv records a track, Aliquant shows a balance
- **offline** — airplane mode, the app still opens and says something honest
- **regression** — one flow per bug that reached a user

Five flows × 8 clients is 40 flows. That is the real work in this plan, and it
is app-side, not fleet-side.

### 4.4 Web runs headless, on whichever executor is free

A browser needs no device, so `web-test` has no target device and takes
`targets.url` instead. Playwright's own browsers install into the executor's
home directory — no sudo, consistent with how fleet-host is built.

Chromium first. Adding WebKit and Firefox later is a config change, not a
rewrite; doing all three from the start triples the flake surface before there
is a single passing suite.

## 5. What this will cost in flake, and what to do about it

The honest risk in nightly UI tests is not that they fail; it is that they fail
*sometimes*, get ignored, and stop being read.

- **The matrix already shows flaky detection** — same build, same device,
  different verdicts. It is live and currently flagging three devices. Use it as
  the gate: a flow that flakes twice gets quarantined, not retried.
- **No blind retries.** A retry that turns red into green destroys the signal
  the suite exists to produce.
- **Fixtures, not shared state.** The GreenFolio flow says it out loud: it does
  not `clearState` because the emulator's logged-in session *is* the fixture.
  That is fine for a rail test and unacceptable for a suite — U2 replaces it
  with seeded state.
- **Device count is the real variable.** Two Android devices are online today,
  and one is a 2017 phone on Android 9. Wide OS coverage is the point of a
  device fleet; it is also where flake comes from.

## 6. Risks

- **watchOS.** `gf-watch` is 966 Swift files and needs a paired-simulator setup
  XCUITest handles badly. I would scope it out of U3 and treat it separately
  rather than let it hold up four other iOS clients.
- **fleet-host is an Intel 2016 MacBook.** It runs the collector, an executor,
  and now possibly Playwright. Watch its load before adding web there; the Xcode
  Mac may be the better home for browser work.
- **Jerv web does not exist.** If it lands during this work, it inherits the
  rails from U4 for free. Nothing here should wait for it.
- **Xcode Mac availability.** If the Xcode Mac is a laptop that sleeps, iOS
  nightlies will be flaky for reasons that have nothing to do with the apps.
  That is an argument for an always-on Mac, or for accepting iOS runs on demand
  rather than nightly.
- **Simulators are not hardware.** The dashboard already flags them and excludes
  them from hardware comparisons. UI tests on a simulator prove the flow, not the
  device.

## 7. Open questions

1. **Which Mac hosts the iOS executor?** This workstation has Xcode 26.6 and
   works today. An always-on Mac would be better. Is there one?
2. **Is `greenfolio-care` a separate app or a variant?** It shares a bundle
   prefix and most of its source with `greenfolio-ios`. If it is a variant, it
   needs a suite run against the variant build, not its own catalogue.
3. ~~**Where is aliquant-web deployed?**~~ **Answered:** `my.aliquant.app`,
   from `wrangler.jsonc`'s custom-domain route. The nightly points there. A
   preview deployment per build is still better and is still a CI decision.
4. **Real devices or simulators for iOS nightlies?** Simulators are reliable and
   prove less. The fleet exists because real hardware behaves differently.
5. **Arm the GitHub commit statuses?** U5 assumes yes. It is currently dark by
   design, and turning it on makes a red nightly block a PR.
