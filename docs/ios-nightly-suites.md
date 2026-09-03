# Nightly iOS UI tests for GreenFolio, Jerv and Aliquant

*Written 2026-08-20. Follows [`ui-test-plan.md`](ui-test-plan.md), which built the
rails; this is about filling them for the three iOS apps.*

## 0. Where the three actually stand

Surveyed, because the three are in genuinely different states and a plan that
treats them alike would be wrong three times.

| | Project | Swift files | UI test target | Identifiers | On device |
|---|---|---|---|---|---|
| **greenfolio-ios** | `GreenFolio.xcodeproj` (XcodeGen) | 1214 | `GreenFolioUITests`, 22 tests | 23 | **green** |
| **jerv-ios** | `Jerv.xcodeproj` (XcodeGen) | 305 | none | **0** | — |
| **aliquant-ios** | `App/Aliquant.xcodeproj` + `Core/` SPM | 212 | none | **0** | — |

Only greenfolio has a UI test target at all. The other two have `Jerv` /
`JervTests` and a single `Aliquant` target respectively.

**The dominant cost of this plan is accessibility identifiers, not tests.**
Two of the three apps have none, and greenfolio's own history says what that
costs: its comments record `blooms.row` that never existed at runtime because
SwiftUI pushes a parent's identifier down over its children, and a card
identifier that matched twice so every tap failed with "Find single matching
element". Those were each found by a failing test and fixed by reading an
accessibility dump. Budget that discovery twice more.

## 1. The three problems are not the same problem

### GreenFolio — extend what works

The only app where the next test written runs tonight. It signs in, 10 of 12
tests pass on an iPhone 12 Pro, and the whole Blooms suite is green. What it
lacks is breadth: no offline behaviour, no regression flows, nothing for
`greenfolio-care`.

### Jerv — a GPS app that must not need a walk

Jerv records tracks from real movement. A nightly cannot go for a bike ride,
and location simulation via a scheme's GPX file does not survive a job launched
by `xcodebuild test` on a device.

**The app already solves this.** `AppModel` owns a `RouteSimulator`, and
`ControlBar` has a `Simulate` toggle with a 1–60× speed slider in Settings.
A suite that drives Simulate exercises the real recording pipeline — modes,
territory, heat — deterministically and in seconds rather than minutes. That
makes Jerv *more* testable than GreenFolio once identifiers exist, not less.

The constraint that follows: **Simulate is disabled mid-ride** (`ControlBar`
says so), so a flow must set it before starting, never during.

One more constraint, learned the hard way on 2026-08-20: Jerv requests real
location permission on launch, and the system dialog it triggers outlives the
job — it was found parked on the shared `fleet-iphone-1`, blocking whatever ran
next. Jerv's job spec must declare

```json
"suite": { "permissions": [{ "service": "location-always", "bundle_id": "com.taylab.jerv" }] }
```

which the executor applies per simulator target (`xcrun simctl privacy grant`)
before `xcodebuild test`, so the dialog never appears.

### Aliquant — a finance app that must not touch a real bank

Its own onboarding copy is the specification: *"Connecting an account hands you
to your bank, and what comes back is a token this app cannot read."* That
handoff is a third-party web flow. **It cannot be automated and should not be** —
a nightly that drives a real bank login is a nightly that will eventually lock
an account.

So Aliquant's suite stops at the boundary: onboarding, the intro, the bucket
UI over *seeded* balances, and the signed-out state. Anything past the bank
handoff needs a sandbox institution or a fixture, and that is a backend
decision rather than a test one. `Fixtures/` already exists at the repo root —
that is where to look first.

## 2. What to write, per app

Five flows per app, as [`ui-test-plan.md`](ui-test-plan.md) §4.3 set out. Concretely:

| | GreenFolio | Jerv | Aliquant |
|---|---|---|---|
| launch | ✅ have | map renders, modes offered | intro renders |
| auth | ✅ have | — (no account) | onboarding → signed-out state |
| core loop | ✅ Blooms | **Simulate a ride, save a track** | buckets over seeded balances |
| offline | airplane mode, honest message | recording continues without network | balances cached, no crash |
| regression | one per user-visible bug | one per user-visible bug | one per user-visible bug |

Jerv's core loop is the valuable one and the one that does not exist anywhere
else: it is the only app in the fleet whose feature can be exercised end to end
without a human.

## 3. Phases

Ordered so each ends with something running nightly, and so the cheapest
signal arrives first.

| Phase | Scope | Done when |
|---|---|---|
| **N0 — identifiers for Jerv** | ✅ **done.** 16 identifiers, on the control never the container | Dump shows each exactly once — it does |
| **N1 — Jerv UI target + launch flow** | ✅ **done.** `JervUITests`, launch flow green on the iPhone | Runs from the queue on hardware — it does |
| **N2 — Jerv core loop** | ✅ **done.** Simulate on, record, assert saved, stop | A ride proven without anyone moving — 133.8s |
| **N3 — identifiers + target for Aliquant** | Same, plus a decision on seeded balances | Intro and signed-out flows green |
| **N4 — GreenFolio breadth** | Offline flow, care variant, first regression flows | Each new flow runs nightly |
| **N5 — three nightlies** | One schedule per app, pinned to hardware | Three green runs, and a red one is visible without opening the dashboard |

N0 before N1 deliberately. Writing a test against a screen with no identifiers
means writing it against labels, and label-matched tests break on copy changes
that are not defects — which is how a suite stops being trusted.

**But N0 cannot be verified without N1, and that was an error in this plan.**
Its done-criterion is a dump showing each identifier exactly once, and nothing
produces that dump without a UI test target. Doing N0 meant building the target
anyway. The lesson generalises to N3: budget the Aliquant target as part of the
identifier work, not after it.

### What N0–N2 actually cost, for estimating N3

Jerv went from zero identifiers to a recorded ride in one sitting, which is
faster than this plan implied. Three reasons, all worth knowing before
Aliquant:

- **`DEVELOPMENT_TEAM` was already at base level** in Jerv's `project.yml`, so
  the new target inherited it. The signing gap that blocked GreenFolio on
  device did not exist. Check Aliquant's before assuming.
- **The audit test paid for itself immediately.** It caught nothing on the
  first run, which is the point: the counts are what let the identifier work be
  called done rather than believed done.
- **The container rule bit once during the work itself.** `metric()` returns a
  `VStack` of two `Text`s, so an identifier on its result published on the
  number and its caption both. Caught by writing the rule down first and then
  noticing the code broke it.

## 4. What the fleet still needs

Three gaps, all small, all real:

**Source has to reach the executor host.** greenfolio-ios is on the runner host
because I rsynced it by hand. That does not scale to three apps and does not
survive a rebuild. `ui-test-plan.md` §4.2 already says suites should be
published with the build; until that exists, a `git clone` per app on the host
is the honest stopgap — and it should be written down rather than remembered.

**One device, three apps.** The iPhone 12 Pro is the only iOS hardware in the
fleet. Nightlies must be scheduled apart rather than at one time, and
`targets.exclusive` set, or they will contend for it. GreenFolio's full suite
takes ~220s; three apps is comfortable, three apps at 02:30 is not.

**Each app needs its own test account**, and none may carry a password in a job
spec. GreenFolio uses `showcase@greenfol.io` with the password in the executor
host's Keychain; Jerv appears to need no account at all; Aliquant needs a
decision about seeded data before it needs an account.

## 5. Risks

- **Identifier work touches app code.** N0 and N3 modify Jerv and Aliquant
  views. That is production code changed for testing, which is worth doing —
  greenfolio's identifiers are load-bearing — but it is not a test-only change
  and should be reviewed as such.
- **`switch.tap()` lies on device.** A SwiftUI `Toggle` in a `Form` is not
  reliably flipped by a tap at its frame's centre, because that centre is the
  label. GreenFolio's `setSwitch` helper is the fix; copy it rather than
  rediscover it. It cost a year of a green-on-simulator, wrong-on-device test.
- **Aliquant's bank handoff will tempt someone to automate it.** Do not.
- **A simulator proves less than the plan implies.** Every defect this fleet has
  found in app code was found on hardware; the simulator agreed the whole time.
