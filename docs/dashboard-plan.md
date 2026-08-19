# Fleet Runner — Dashboard Plan

*Companion to `fleet-runner-plan.html`, which lives beside the repo checkouts and
covers all four components. This document is collector-only, so it lives here.
Written 2026-08-18.*

> **Status — the plan is complete. D0 through D6 are built and merged** (2026-08-19),
> across [PR #1](https://github.com/addisdev/fleet-collector/pull/1) (D0–D2) and
> [PR #2](https://github.com/addisdev/fleet-collector/pull/2) (D3–D6). The smoke
> suite grew from 44 to **207 checks** and survives repeated runs against one
> collector.
>
> **Original status note, D0–D2:** The read API, SSE stream, and
> Preact SPA ship in `fleet-collector`: `src/api/` (overview, devices, jobs,
> results, system, stream), `src/dash-static.ts`, and `dash/` for the UI. The
> old server-rendered dashboard moved to `/dash/legacy`. The smoke suite grew to
> 123 checks covering the API, the stream, and path traversal on the static
> route, and passes end to end.
>
> Real screens: **Overview, Devices (list + detail), Jobs (list + detail),
> Schedules (read-only), System.** Filters live in the URL. Device detail charts
> 24 h of battery and thermal from the beacon stream, breaking the line across
> gaps rather than drawing a segment no measurement supports. Results, Artifacts
> and Events remain stubs linking their live endpoints.
>
> **D2 adds control:** a job composer with a live "N devices match" preview that
> uses the same matcher fan-out uses, cancel / retry / priority, saved job
> templates, and device nickname / notes / pool editing. Cancelling is its own
> status, never `failed` — a person stopping a job is not a breakage, and the
> failure counts and alerts depend on that distinction. Pool edits live in a
> separate `pools_override` column because the runner rewrites `pools` on every
> registration. Mutations sit behind an optional `FLEET_DASH_TOKEN`.
>
> The `cancelled` status needed a CHECK-constraint widening, which SQLite only
> allows via table rebuild; that migration was tested against a hand-built
> pre-D2 database with data in it, and preserves rows, `last_error`, and indexes.
>
> **Legacy is not deletable yet** — one gap remains: the cross-device benchmark
> comparison at `/dash/legacy/bench`, which needs D3's trend charts.
> Details in [`README.md`](../README.md#dashboard).

## 0. Where we are

The collector already ships a dashboard: `GET /dash` in `fleet-collector/src/dash.ts` renders five static tables (devices, last 50 jobs, last 50 results, schedules, locks) and `GET /dash/bench` renders the cross-device benchmark table. It is read-only, has no filtering, no detail pages, no charts, no actions, and refreshes only on reload. Everything you can *do* to the fleet today is a `curl` against the JSON API.

The API underneath is in better shape than the UI: jobs with leases/attempts/`last_error`, fan-out, schedules, device locks, artifacts, events, power webhooks, status reports. So the dashboard is mostly a **read + control surface over data that already exists**, plus a handful of missing endpoints.

## 1. Goals

1. **See the fleet at a glance** — which devices are online, busy, charging, hot; what's queued/running/failed; whether the scheduler and collector are healthy.
2. **Manage jobs without curl** — inspect, enqueue (from templates), cancel, retry, re-run on a different pool, and follow a job's attempts and per-device results.
3. **Read results as results, not rows** — benchmark trends, UI-test pass/fail matrices, drain curves, soak survival timelines, with the honest-numbers rules baked in.
4. **Operate the collector** — schedules on/off, artifacts, power, sweeps, CI arming status, log/DB health.
5. **Get told when something breaks** — device offline, job failed, thermal critical, schedule missed.

Non-goals: auth/multi-tenant (stays LAN/Tailscale-only), editing job specs by hand in a text box as the *primary* path, anything that requires the phone apps to change protocol.

## 2. Architecture

```
fleet-collector/
  src/server.ts        ← existing routes  +  new /api/* JSON routes  +  SSE stream
  src/dash.ts          ← keep as /dash/legacy until the new UI covers it, then delete
  src/api/             ← new: jobs.ts, devices.ts, results.ts, system.ts, stream.ts
  dash/                ← new: Vite + Preact + TypeScript SPA
    src/pages/…        ← Overview, Devices, Jobs, Results, Schedules, Artifacts, System
    dist/              ← built assets, served by @fastify/static at /dash
```

**Decisions**

- **Same process, same SQLite.** The dashboard is served by the collector, not a second service. One thing to keep alive under launchd, one URL (`http://192.168.50.27:8788/dash`), no CORS. Reads go through prepared statements with hard `LIMIT`s; SQLite WAL means dashboard reads never block device long-polls.
- **JSON API first, UI second.** Every screen is backed by a `/api/*` endpoint that `curl` and future scripts can use. The old server-rendered `/dash` moves to `/dash/legacy` on day one and is removed once parity is reached.
- **Preact + Vite, no framework beyond that.** Small bundle (the collector host is a 2016 MacBook and the dashboard will be opened on phones on the shelf), TypeScript shared with the collector for the job/result types, `uPlot` for charts (≈40 KB, handles thousands of beacon points). Dark mode via `prefers-color-scheme` like today.
- **Live updates over SSE, not WebSockets.** `GET /api/stream` pushes `{type: "job"|"device"|"result"|"beacon", …}` events. The collector already has single write paths for each table (`POST /results`, `/jobs`, `/devices/register`, sweep, scheduler) — emit from those; no polling loop and no external broker (matches the events-rails philosophy).
- **No auth, but a mutation guard.** Reads are open. Mutating actions (cancel, retry, enable schedule, power off) require an `X-Fleet-Token` header if `FLEET_DASH_TOKEN` is set, and always a confirm dialog in the UI. Default unset = today's behavior.

## 3. Screens

### 3.1 Overview (`/dash`)
The "is the fleet OK" page. Fits on one phone screen.

- **Fleet strip:** devices online / stale / offline (derived from `last_seen` vs the 60 s beacon: online <3 min, stale <15 min, offline beyond), busy vs idle, how many charging, worst thermal state.
- **Queue strip:** queued / claimed / done-24h / failed-24h, oldest queued job age, jobs on their last attempt.
- **Running now:** each claimed job with device, workload, elapsed, lease remaining as a shrinking bar, latest beacon.
- **Recent failures:** last 10 failed jobs with `last_error` inline.
- **Scheduler:** enabled schedules with next-fire countdown; red if a schedule's `last_run` is more than one interval late.
- **Collector health:** uptime, sweep last ran, DB size, artifact store size, log file size (the README warns launchd doesn't rotate it), CI armed/unarmed badge.

### 3.2 Devices (`/dash/devices`, `/dash/devices/:id`)
- Table/grid with filter by platform, OS, pool, status; sort by last seen, battery, thermal. Columns: nickname/ID, model · SoC · RAM, OS, pools, battery + charging icon, thermal, current job, lock holder, last seen.
- **Detail page:** full descriptor JSON, pools (editable), free-text notes ("USB hub port 3", "screen cracked"), 24 h battery + thermal chart from `beacon_samples`, job history for this device, latest benchmark numbers, actions: **run job on this device** (opens composer pinned to it), **release lock**, **power on/off** (its pool's webhook), **forget device** (delete registry row).
- Cross-platform care: memory always shown with `mem_method`; iOS simulators flagged so they are never mistaken for hardware.

### 3.3 Jobs (`/dash/jobs`, `/dash/jobs/:id`)
- Paginated list with filters: status, workload, executor, pool, device, date range, "has error", free-text over `job_id`. Saved filters in the URL so links are shareable.
- Row: job_id, workload, executor, status pill, claimed_by, attempts `n/max`, lease countdown, created/finished, duration.
- **Detail page:** spec JSON (pretty, collapsible), attempts timeline (claimed → beacons → swept/requeued → done/failed), per-device results table, artifacts produced (JUnit XML, screenshots, batch outputs — inline viewer for images/XML), `last_error`, status report row if `report_to` was set, and — for fan-out parents — the child job matrix.
- **Actions:** cancel (queued → `cancelled`; claimed → mark cancelled and the runner sees `lease_renewed:false` on its next beacon), retry (clone spec to a new `job_id` with a `-r2` suffix, optionally onto a different pool/device), re-run fan-out, bump priority, force sweep.
- **Job composer** (`/dash/jobs/new`): form generated from `schemas/job.schema.json` with a workload picker that pre-fills sensible params per workload (benchmark, batch, pipeline, install, ui-test, drain, soak, vision-eval). Pick target by pool / `match` expression / pinned device with a live "N devices match" preview. Pick model/app from the artifact store or upload. Toggle fan-out. Shows the equivalent `curl` before submit so nothing is hidden. Templates can be saved and become the basis for schedules.

### 3.4 Results
- **Benchmarks** (`/dash/results/bench`): today's table, plus per-config **trend chart** (decode tok/s per device over time) so a regression after an app or model change is visible, a **device comparison** bar chart per model/quant, and a **sustained-load** view (tok/s vs thermal state over the run). Rules from the plan enforced in the UI: prefill and decode never merged, `mem_method` never mixed on one axis, simulator rows greyed and excluded from comparisons by default.
- **UI tests** (`/dash/results/ui`): build × device pass/fail matrix from JUnit artifacts, click-through to failing test names, screenshots/video, flaky detection (same test alternating over the last N runs).
- **Drain** (`/dash/results/drain`): battery % vs time per run, overlay multiple runs (app version A vs B, device vs device), slope in %/h.
- **Soak** (`/dash/results/soak`): process-alive timeline per device per night, the OEM-killer survival matrix.
- **Vision eval**: top-1/top-5 + p50/p95 per model per device (the GreenFolio eval), so the next eval is a page rather than a one-off report.
- **Export**: every result view has CSV/JSON download of the underlying rows.

### 3.5 Schedules (`/dash/schedules`)
List with cron (human-readable "every day at 02:00"), enabled toggle, last run, next run, the template summarized, and history of the jobs it fired. Actions: enable/disable, run now (`POST /schedules/tick` scoped to one id), edit template via the composer, delete.

### 3.6 Artifacts (`/dash/artifacts`)
Name, kind (model / apk / app zip / junit / screenshot / batch output — inferred from name and referencing job), size, sha256 (copy button), created, referenced-by jobs. Upload from the browser (streaming — this is the trigger to fix the in-memory upload buffer noted in Phase 0). **GC**: list unreferenced artifacts older than N days and delete on confirm.

### 3.7 Events / pipeline (`/dash/events`)
Topics with event count and last-event time, tail of recent payloads, per-topic throughput. Useful for watching a tiered pipeline actually flow.

### 3.8 System (`/dash/system`)
Power controls per pool (on/off webhook + last invocation result), sweep now, scheduler tick now, CI arming status and the `status_reports` audit trail, DB stats per table, retention controls (beacon_samples/events older than N days), tail of `~/Library/Logs/fleet-collector.log`, collector version + node version + uptime.

### 3.9 Alerts
Rules evaluated in the collector on a 60 s tick (piggyback on the sweep loop):

| Rule | Default |
|---|---|
| Device offline (no beacon) | > 15 min |
| Job failed (final attempt) | always |
| Job stuck: claimed with lease renewed but no result rows | > 2× expected duration |
| Thermal `critical` on any device | always |
| Battery < 15 % and not charging | always |
| Schedule missed (enabled, due, not fired) | > 5 min late |
| Collector disk / log size | > thresholds |

Delivered to: the dashboard (banner + `/dash/alerts` history), and optionally an ntfy/webhook URL and macOS notification on the host. Alerts have ack/snooze so a known-dead device doesn't nag.

## 4. API additions

New or extended endpoints, all JSON:

| Endpoint | Purpose |
|---|---|
| `GET /api/overview` | Everything the Overview page needs in one call |
| `GET /api/devices`, `GET /api/devices/:id`, `PATCH /api/devices/:id`, `DELETE /api/devices/:id` | List/detail/edit pools+nickname+notes/forget |
| `GET /api/devices/:id/beacons?since=` | Beacon history for charts |
| `GET /api/jobs?status=&workload=&executor=&pool=&device=&q=&from=&to=&page=` | Filtered, paginated list |
| `GET /api/jobs/:id` (extends existing) | Adds results, artifacts, children, attempts timeline |
| `POST /api/jobs/:id/cancel`, `POST /api/jobs/:id/retry`, `PATCH /api/jobs/:id` (priority) | Job actions |
| `POST /api/jobs/preview-targets` | "N devices match this target" for the composer |
| `GET /api/results?job=&device=&workload=&from=&to=` + `/api/results/bench|ui|drain|soak` | Result views, shaped for charts |
| `GET /api/schedules/:id/history`, `POST /api/schedules/:id/run` | Schedule detail |
| `GET /api/artifacts`, `DELETE /api/artifacts/:sha256`, `GET /api/artifacts/gc-candidates` | Artifact management |
| `GET /api/events` (topics), `GET /api/events/:topic?limit=` | Event browsing |
| `GET /api/health`, `GET /api/system` | Uptime, DB/artifact/log sizes, CI armed |
| `GET /api/alerts`, `POST /api/alerts/:id/ack` | Alert history |
| `GET /api/stream` | SSE |

Schema changes (all additive, following the existing `ALTER TABLE` pattern in `db.ts`):
- `jobs`: `priority INTEGER DEFAULT 0` (claim order becomes priority DESC, created_at ASC), `parent_job_id TEXT` (fan-out children), `cancelled` added to the status CHECK, `template_id TEXT`.
- `devices`: `nickname TEXT`, `notes TEXT`.
- `results`: index on `(device_id, created_at)`.
- new `alerts` table, new `job_templates` table.

## 5. Build phases

Each phase is shippable and leaves `/dash` working.

| Phase | Scope | Done when |
|---|---|---|
| **D0 — API + skeleton** ✅ **built** | `/api/*` read endpoints, SSE stream, Vite/Preact scaffold served at `/dash`, old dash at `/dash/legacy`, smoke tests for new endpoints | `curl /api/overview` returns the fleet; empty SPA loads over the LAN |
| **D1 — Overview + Devices + Jobs (read)** ✅ **built** | Screens 3.1, 3.2, 3.3 minus actions; live via SSE; filters in URL. Read-only Schedules added to close a legacy gap | Legacy dash can be deleted — *all but `/dash/legacy/bench`, which waits on D3* |
| **D2 — Job control** ✅ **built** | Cancel/retry/priority, composer with templates + target preview, device pools/notes editing, mutation token | A benchmark fan-out and a Maestro run can be launched and followed entirely from the browser |
| **D3 — Results** ✅ **built** | Bench trends + comparison, UI-test matrix + artifact viewer, drain curves, soak timeline, vision-eval page, CSV export | Next GreenFolio eval needs no hand-built report |
| **D4 — Operations** ✅ **built** | Schedules UI, artifacts (streaming upload + GC), events, system page, power controls | Nightly schedules can be enabled and monitored from the dashboard |
| **D5 — Alerts** ✅ **built** | Rule engine on the sweep tick, dashboard banner/history, ntfy/webhook, ack/snooze | A device pulled off the shelf shows up in the phone's notifications inside 15 min |
| **D6 — Polish** ✅ **built** | Phone layout pass, keyboard shortcuts (`g j` jobs, `/` search), retention jobs, docs | README "Endpoints" table updated; `fleet-runner-plan.html` status block updated |

## 6. Testing

- Extend `scripts/smoke.ts` with the `/api/*` endpoints (against a throwaway collector, per the README rule — never the live one).
- Unit tests for derived state: online/stale/offline thresholds, next-fire computation, alert rules, target preview.
- One Playwright flow: enqueue via composer → job appears in list → SSE update flips it to done when the smoke runner reports.
- Full smoke suite before every deploy to fleet-host (per your global testing rule).

## 7. Risks and mitigations

- **Beacon table growth** — 60 s beacons × N devices is ~1.4 k rows/device/day; charts query by index but the table needs retention. Add a nightly retention step (default 30 days raw; keep hourly rollups longer) in D4.
- **Dashboard load on the collector** — the host is a 2016 MacBook serving long-polls. Keep every dashboard query bounded, cache `/api/overview` for 2 s, and never compute charts server-side over unbounded ranges.
- **Cancelling a claimed job** — relies on the runner honoring `lease_renewed:false` on its next beacon; the Android/iOS agents already do this for swept leases, so cancel reuses that path rather than a new protocol message.
- **No auth on a mutation surface** — mitigated by LAN/Tailscale-only + optional token + confirm dialogs; explicitly not building login.
- **Artifact upload buffering** — streaming upload from the browser is the forcing function for the Phase-0 note about in-memory buffering; do it in D4, don't defer again.

## 8. Outstanding work — the runner apps

The dashboard is done. One thing it cannot finish on its own: **`vision-eval`
results still arrive in metric fields that mean something else.** Until the
runner apps change, the plant-ID report cannot be replaced by a query, and the
Results screen says so on the page rather than quietly presenting inferred
numbers as measurements.

### What is stored today

A `vision-eval` run is a `batch` job on a `litert` (Android) or `coreml` (iOS)
backend. Its final result row carries:

| Field written | What it actually holds | Should be |
|---|---|---|
| `metrics.decode_tok_s` | top-1 accuracy, percent | `metrics.top1_pct` |
| `metrics.ttft_ms` | median per-image latency | `metrics.p50_ms` |
| `metrics.prefill_tok_s` | images per second (1000 / p50) | `metrics.images_per_s` |
| — | **top-5 accuracy is not stored at all** | `metrics.top5_pct` |
| — | **p95 latency is not stored at all** | `metrics.p95_ms` |

Confirmed by matching stored rows against the published report: the ATD
emulator's fp32 run holds `decode_tok_s: 77.5` where the report says top-1
77.5%, `ttft_ms: 54` where it says p50 54 ms, and `prefill_tok_s: 18.518`,
which is exactly 1000/54.

Two consequences worth knowing before trusting the table:

- **Core ML rows carry `decode_tok_s: 0`.** In storage that is indistinguishable
  from a run that scored zero, so the dashboard shows those as unknown rather
  than as 0% accuracy. The report's iOS accuracy figures came from somewhere
  these rows do not record.
- **Top-5 and p95 have never been in the database.** No amount of dashboard work
  recovers them.

### What each repo needs to change

- **`fleet-runner-android`** — the LiteRT vision-eval path: emit `top1_pct`,
  `top5_pct`, `p50_ms`, `p95_ms` and `images_per_s` in `metrics`, instead of
  overloading the LLM fields.
- **`fleet-runner-ios`** — the Core ML path: the same fields, and actually
  compute accuracy, which the current rows do not.

The fields are already defined in
[`schemas/result.schema.json`](../schemas/result.schema.json), and
`GET /api/results/vision` prefers them the moment they appear, falling back to
the old convention for historical rows and marking those `inferred`. **No
collector or dashboard change is needed** — this is purely runner-side.

### Already done on the collector side

The drain workload had the same problem: `src/executor.ts` wrote
percent-per-hour into `decode_tok_s`, with a comment claiming it was "for the
bench page". It was not — both bench queries filter `workload = 'benchmark'`, so
a drain row could never appear there. The executor now writes
`metrics.drain_pct_per_h`, and the dashboard reads legacy rows with a flag.

## 9. What the build changed about the plan

Three things the plan did not anticipate, all settled in code:

- **Vision-eval and drain metrics had no fields.** They were smuggled through
  the LLM slots — vision put top-1 accuracy in `decode_tok_s`, p50 latency in
  `ttft_ms`, throughput in `prefill_tok_s`; drain put percent-per-hour in
  `decode_tok_s` — and top-5 and p95 were never stored at all. That is why the
  published plant-ID report carries numbers no query can reproduce.
  `result.schema.json` now names them, and the views mark anything inferred.
  **D3's aim — that the next eval needs no hand-written report — is therefore
  not met yet.** It needs the runner apps to emit the named fields, and those
  live in the runner repos.
- **`/dash/legacy` is kept, not deleted.** The plan had it retired at parity. It
  has no unique feature left, but it is the only dashboard with no build step,
  which is exactly what a bare checkout or a broken bundle needs.
- **Pool edits needed their own column.** The runner rewrites `pools` on every
  registration, so an operator edit sharing that column would vanish within the
  minute. Effective pools are `pools_override ?? pools`, and the queue claims
  through the effective set.

## 10. Open questions (defaults chosen; say so if you disagree)

- **Preact SPA vs. htmx.** ✅ Preact. The finished bundle is 28 KB gzipped with
  no router, charting or static-file dependency — the results pages would indeed
  have fought htmx.
- **Where alerts are delivered.** ✅ ntfy-shaped `FLEET_ALERT_WEBHOOK` plus the
  dashboard banner. Unset by default, so the dashboard is the only channel until
  you point it somewhere.
- **Should the dashboard also cover the executor host?** ✅ Done in D4, and more
  cheaply than proposed: an executor already announces itself every 25 s by
  long-polling for work, so recording that poll needed no new endpoint and no
  change to `executor.ts` at all. Attached-USB inventory would still need one.
