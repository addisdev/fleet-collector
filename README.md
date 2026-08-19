# fleet-collector

Phase 0 of the Fleet Runner plan: the collector service — device registry, job
queue, artifact store, results DB, and dashboard for the device fleet.

Node + Fastify + SQLite (WAL). No auth: it is only reachable on the LAN, and
is meant to stay that way. Runs under `launchd` on **fleet-host** (see below).

## Run

```
npm install
npm start          # collector on :8788 (FLEET_PORT to change)
npm run executor   # host executor: claims host jobs, drives devices via adb + Maestro
npm run smoke      # end-to-end check against a running collector

npm run dash:install   # one-time: dashboard build deps (vite + preact)
npm run dash:build     # build the dashboard to dash/dist
npm run dash:dev       # dashboard dev server on :5178, proxying /api to FLEET_URL
```

The host executor (Phase 2) handles `install` (artifact → `adb install` on every
attached device) and `ui-test` (`maestro test` per device, JUnit report parsed
and uploaded back as an artifact). Flows resolve relative to `flows/`
(`FLEET_FLOWS_DIR` to change); iOS via devicectl/XCUITest is Phase 3.

Smoke against a collector you started for the purpose, never the live one — it
enqueues jobs a real device could claim. Give it its own port and data dir:

```bash
FLEET_DATA_DIR=/tmp/fleet-test FLEET_ARTIFACT_DIR=/tmp/fleet-test/store FLEET_PORT=8799 npm start
```

then `FLEET_URL=http://127.0.0.1:8799 npm run smoke`.

## Where it runs

The collector lives on **fleet-host** (`C02TF32MGTFM.local`, `192.168.50.27:8788`)
— a 2016 MacBook Pro that does nothing else. It is deliberately sudo-free:
Node is a user-local tarball in `~/.local/node`, the service is a LaunchAgent in
`~/Library/LaunchAgents`, and `better-sqlite3` installs from a prebuild, so the
whole stack can be rebuilt over SSH with nobody at the keyboard. Deploy with
[`deploy/adopt-fleet-host.sh`](deploy/adopt-fleet-host.sh) and the
`*.fleet-host.plist` variant.

Executors stay on whichever machine the devices are physically attached to —
they reach the collector over the LAN with `FLEET_URL`:

```bash
FLEET_URL=http://192.168.50.27:8788 npm run executor
```

Runner apps default to that address too. Give the host a DHCP reservation; a
lease change would strand every device at once.

## Running under launchd

[`deploy/com.addisdev.fleet-collector.plist`](deploy/com.addisdev.fleet-collector.plist)
keeps the collector up: `KeepAlive` revives it however it dies, which is the
point — the fleet's devices long-poll this service, so a crash that goes
unnoticed strands every runner.

```bash
cp deploy/com.addisdev.fleet-collector.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.addisdev.fleet-collector.plist
```

- **Stop it** with `launchctl bootout gui/$(id -u)/com.addisdev.fleet-collector`.
  Killing the process does nothing lasting; launchd starts it straight back.
- **Do not `npm start` while it is loaded** — the port is taken, and the second
  copy exits with `EADDRINUSE` while looking, for a moment, like it worked.
- **Logs** go to `~/Library/Logs/fleet-collector.log` (both streams). launchd
  does not rotate it and the collector logs a line per request, so check its size
  occasionally.
- **Paths inside the plist are absolute**, including the data and artifact dirs.
  Move the checkout and you must edit them.
- This is a LaunchAgent, so it starts **at login**, not at boot. A Mac mini that
  reboots unattended needs either automatic login, or the same job installed as a
  root-owned LaunchDaemon in `/Library/LaunchDaemons`.

After `npm install` upgrades tsx, confirm `node_modules/tsx/dist/cli.mjs` still
exists — the plist invokes it directly to avoid depending on a login `PATH`.

## Endpoints

| Method & path | Purpose |
|---|---|
| `POST /devices/register` | Device checks in with descriptor + pool tags (upsert) |
| `GET /devices/:id/next-job` | Long-poll (~25 s) for `executor: "device"` work; 204 when none |
| `GET /executor/next-job` | Long-poll for `executor: "host"` work (`?name=` labels the claimant) |
| `POST /jobs` | Enqueue a job spec (curl, CI, or the future scheduler); 409 on duplicate `job_id` |
| `GET /jobs/:id` | Job status, including `attempts`, `lease_deadline`, and `last_error` |
| `POST /jobs/sweep` | Force a lease sweep now; returns the `job_id`s requeued and failed |
| `POST /results` | Result rows (`kind: "result"`, idempotent by job/device/iter) and telemetry (`kind: "beacon"`, which renews the job's lease); `final: true` closes the job |
| `POST /artifacts` | Upload raw bytes (models or app builds); returns `sha256` |
| `GET /artifacts/:sha256` | Download, supports Range requests |
| `POST /schedules` / `GET /schedules` | Upsert / list cron schedules (5-field cron + job template, `enabled` off by default) |
| `PATCH /schedules/:id` / `DELETE /schedules/:id` | Enable/disable or remove a schedule |
| `POST /schedules/tick` | Force a scheduler evaluation now (fires due schedules at most once per minute) |
| `POST /locks/acquire` / `POST /locks/release` | Host-executor device locks for `targets.exclusive` jobs; device-executor claims lock implicitly |
| `POST /power/:pool/:state` | Fire the pool's smart-plug webhook (`on`/`off`) from `power.json` — see `power.example.json` |
| `POST /events/:topic` | Publish a pipeline event (JSON payload); returns its id |
| `GET /events/:topic/poll?after=<id>` | Long-poll the next event past the cursor; 204 on expiry |
| `GET /dash` | Dashboard SPA (see below) |
| `GET /dash/legacy` / `GET /dash/legacy/bench` | Server-rendered dashboard / cross-device benchmark comparison |
| `GET /api/*` | Dashboard read API (see below) |

Batch jobs (`workload: batch`) take `params.input_sha256` (an artifact of
`{"items": [...]}`), process each item on the device (llama.cpp generates,
synthetic digests), and upload the outputs as a new artifact referenced from
the final result. Pipeline jobs (`workload: pipeline`) subscribe to
`params.topic`, process each event's `prompt`, and publish to `<topic>.out` —
the tiered-pipeline pattern with the collector as the broker. Runners enforce
`constraints.require_charging` / `min_battery_pct` before running: an
on-battery Samsung was observed to throttle decode ~100x with the screen off,
which is exactly the lie those constraints exist to prevent.

`POST /jobs` with `"fanout": true` (device-executor only) enqueues one pinned
child job per registered device in `targets.pool` — a whole-shelf benchmark is
one request. Nightly runs are schedules whose template does exactly that.

## CI integration — built, deliberately OFF

Nothing in any app repo or CI system references the fleet today. What exists,
dark, is the full contract:

- Jobs may carry `report_to.github_status: "owner/repo@sha"`. When such a job
  closes, the collector records a row in `status_reports` — and **only posts a
  real GitHub commit status when armed** with `FLEET_GITHUB_STATUS=1` and
  `FLEET_GITHUB_TOKEN`. Unarmed (the default), the row says `posted=0, dry run`;
  `GET /status-reports` is the audit trail either way.
- [`scripts/ci-enqueue.ts`](scripts/ci-enqueue.ts) is the CI step: uploads the
  build artifact, enqueues the job, polls to the verdict, exits 0/1.
- [`ci/example-workflow.yml`](ci/example-workflow.yml) documents the workflow an
  app repo would adopt at connect time. It is installed nowhere.

Turning CI on later is: arm the two env vars on the collector, add the secret +
workflow to an app repo, and let its self-hosted runner reach the collector
over Tailscale. Until then the fleet stays fully disconnected from real CI.

Job and result shapes are documented in [`schemas/`](schemas/) (`"schema": 1`).

## Dashboard

The plan this was built from, including what is still outstanding on the runner
side, is [`docs/dashboard-plan.md`](docs/dashboard-plan.md).

`/dash` is a Preact SPA in [`dash/`](dash/), built by Vite to `dash/dist` and
served straight from this process — one service, one URL, no CORS. The build is
**optional**: with no `dash/dist` the collector serves a page telling you to run
`npm run dash:build`, and everything else keeps working. `dash/dist` is
gitignored, so a fresh checkout on fleet-host needs `npm run dash:install &&
npm run dash:build` once (pure-JS deps plus esbuild's per-platform binary — no
sudo, same as the rest of the stack).

The server-rendered tables that used to be `/dash` still live at
[`/dash/legacy`](src/dash.ts). They have no build step, so they remain the
fallback when the bundle is missing or broken. They go away once the SPA reaches
parity.

Building the dashboard is what `dash:build` does; `dash:dev` runs Vite's dev
server on :5178 and proxies `/api` to `FLEET_URL` (default `127.0.0.1:8788`), so
you can develop the UI against the live fleet without a mock.

**What is built (plan D0–D6 — the dashboard plan is complete):** the read API, the live event stream, and the
Overview, Devices, Jobs, Schedules and System screens — including device detail
with a 24 h battery/thermal chart, job detail with per-device results and
artifacts, and filters that live in the URL so a filtered view is a link you can
send. Jobs can be composed, enqueued, cancelled, retried and reprioritised from
the browser; devices can be renamed, annotated and re-pooled. Results has views
for benchmarks, vision evals, UI tests, drain and soak. Schedules can be
enabled, fired now and deleted; artifacts can be uploaded and garbage-collected;
events can be tailed; and the System screen runs sweeps, scheduler ticks, pool
power and retention. Alerts appear as a banner on every screen. The layout works
on a phone, and `?` lists the keyboard shortcuts (`g j` jobs, `g d` devices,
`g n` new job, `/` search).

The legacy dashboard has **no unique feature left** — the cross-device benchmark
comparison now lives in the SPA — but it is deliberately kept. It is
server-rendered with no build step, so it is the only dashboard that works from
a bare checkout or when a bundle fails to build. That, and nothing else, is now
its job.

### Adding a device

`/dash/devices/new` is the enrolment screen: a QR code of the collector's
address, a download of the newest runner APK straight from the artifact store,
per-platform install steps, and a panel that watches the registry and names the
device the moment it registers.

The QR encodes an address derived from the **host's own network interfaces**,
not from the browser's origin — view the dashboard through an SSH tunnel and
your origin is `127.0.0.1`, which is a fine URL for you and a useless one for a
phone. The screen says so and offers the LAN and tailnet addresses instead.

Artifact downloads take `?filename=`, which sets a `content-disposition` so the
runner arrives on the phone as `fleet-runner-0.2.0.apk` rather than a
64-character hash Android will not offer to install. The name is stripped to
`[A-Za-z0-9._-]` before it reaches the header.

### Vision-eval and drain metrics

Both used to ride in the LLM metric slots — vision put top-1 accuracy in
`decode_tok_s`, p50 in `ttft_ms`, throughput in `prefill_tok_s`; drain put
percent-per-hour in `decode_tok_s` — and top-5 and p95 were computed but had
nowhere to go, reaching only the uploaded report artifact.

**Fixed as of 2026-08-19.** `schemas/result.schema.json` defines `top1_pct`,
`top5_pct`, `p50_ms`, `p95_ms`, `images_per_s` and `drain_pct_per_h`; the
executor and both runner apps emit them. Verified end-to-end against the real
int8 Core ML model and the 120-image eval set, reproducing the published
plant-ID figures (75.8% top-1, 90.8% top-5) from the results table for the first
time.

Rows written before that keep working: the Results screen prefers the named
fields, falls back to the old convention, and marks anything it had to infer.
A pre-fix Core ML row reads `top1: 0.0` because the old code defaulted a missing
accuracy to zero — read those as unknown, not as a result.

### Read API

Every endpoint is `GET` and side-effect free. Timestamps are ISO-8601 **UTC with
a `Z`** — SQLite stores `YYYY-MM-DD HH:MM:SS` with no zone marker, which
JavaScript parses as local time, so the API normalizes rather than leaving each
client to get it wrong. Every list is bounded.

| Endpoint | Purpose |
|---|---|
| `GET /api/overview` | Everything the Overview screen needs, in one call (cached 2 s; `?fresh=1` bypasses) |
| `GET /api/health` | Uptime, node version, collector instance id, connected dashboards |
| `GET /api/system` | DB/artifact/log sizes, row counts per table, CI armed state, power pools, paths |
| `GET /api/devices` | Registry with derived `online`/`stale`/`offline`, current job, lock, flattened beacon; filters: `status`, `pool`, `platform`, `simulator`, `q` |
| `GET /api/devices/:id` | Descriptor, job history, latest benchmarks, counts |
| `GET /api/devices/:id/beacons?hours=24` | Beacon history for the battery/thermal charts, oldest first |
| `GET /api/jobs` | Filters: `status`, `workload`, `executor`, `pool`, `device`, `q`, `has_error`, `from`, `to`; `page`/`per_page`, `sort`/`dir`; returns status facets |
| `GET /api/jobs/:id` | Spec, results, beacons, artifacts (input vs output, and whether they are actually in the store), locks, fan-out parent/siblings/children, status report |
| `GET /api/results` | Filters: `job`, `device`, `workload`, `final`, `ok`, `from`, `to` |
| `GET /api/results/bench` | Latest passing run per device per configuration, with per-device history for trends |
| `GET /api/results/ui` | Per-run verdicts plus a build x device matrix with flaky detection |
| `GET /api/results/vision` | Vision-eval accuracy and latency per model per device; flags inferred values |
| `GET /api/results/drain` | Drain runs: battery curve per device and percent-per-hour |
| `GET /api/results/soak` | Soak runs: the per-check process-alive timeline per device |
| `GET /api/results/recent` | Newest result rows with a one-line summary |
| `GET /api/schedules` | Schedules with computed `next_run` and missed-fire detection |
| `GET /api/artifacts` | Store listing with on-disk state and reference counts |
| `GET /api/events` / `GET /api/events/:topic` | Pipeline topics and their payload tail |
| `GET /api/locks` | Held device locks and how long they have been held |
| `GET /api/stream` | SSE: `job`, `device`, `beacon`, `result`, `lock`, `schedule`, `artifact`, `pipeline-event` |

`/api/stream` carries a nudge, not a payload — an event says "this changed" and
the client refetches. A dropped or duplicated event therefore costs a redundant
GET, never a wrong screen. The `hello` frame carries an `instance` id; a change
in it means the collector restarted and clients should refetch everything.

### Mutations

| Endpoint | Purpose |
|---|---|
| `POST /api/jobs` | Enqueue (the composer's path); forwards to `POST /jobs` so validation and fan-out have one implementation |
| `POST /api/jobs/:id/cancel` | Queued → `cancelled`; claimed → `cancelled` plus lock release |
| `POST /api/jobs/:id/retry` | Clone the spec under `<id>-r2`, optionally onto a different pool or device |
| `PATCH /api/jobs/:id` | Set `priority` |
| `POST /api/jobs/preview-targets` | "N devices match", using the same matcher fan-out uses |
| `PATCH /api/devices/:id` | Nickname, notes, pool override (`pools: null` clears the override) |
| `DELETE /api/devices/:id` | Forget a device; refuses while it is running a job |
| `POST /api/devices/:id/release-lock` | Drop a stuck host-executor lock |
| `GET/POST/DELETE /api/templates[/:id]` | Saved job specs for the composer |
| `POST/PATCH/DELETE /api/schedules[/:id]` | Upsert, enable/disable, delete — forwarded to the `/schedules` routes |
| `POST /api/schedules/:id/run` | Fire one schedule now, without consuming its cron dedup key |
| `GET /api/artifacts/gc-candidates?days=` | Artifacts nothing references, oldest first |
| `DELETE /api/artifacts/:sha256` | Delete one; refuses while a job still references it |
| `POST /api/system/sweep`, `POST /api/system/scheduler-tick` | Force a pass now |
| `POST /api/power/:pool/:state` | Fire a pool's smart-plug webhook |
| `POST /api/system/retention` | Prune old beacons and events; dry-runs unless `dry_run:false` |
| `GET /api/executors` | Host-executor liveness, derived from their long-poll traffic |
| `GET /api/enroll` | Addresses a device can reach this collector on, the newest runner APK, and who is already enrolled |
| `GET /api/alerts?state=` | Current alerts; `open,acked,snoozed` unless asked otherwise |
| `POST /api/alerts/:id/ack`, `POST /api/alerts/:id/snooze` | Quiet one alert; snooze takes `minutes` |
| `POST /api/alerts/tick` | Force an evaluation now |

**Cancelling a claimed job** does not reach into the device. The row goes to
`cancelled`, which means the runner's next beacon returns `lease_renewed: false`
— the same signal a swept lease produces, which runners already handle. Work
already in flight finishes; nothing new starts. A cancelled job is deliberately
*not* `failed`: the overview's failure counts and every alert built on them
would otherwise count deliberate stops as breakage.

**Pool edits** are stored in `devices.pools_override`, not in `pools`. The
runner rewrites `pools` on every registration, so an edit sharing that column
would be gone within the minute. Effective pools — what the queue actually
claims through — are the override when set, otherwise the runner's report; both
stay visible in `GET /api/devices`.

**`FLEET_DASH_TOKEN`** guards every mutation above: set it and the dashboard
must send `X-Fleet-Token` (enter it on the System screen; it is kept in that
browser's localStorage). Unset, the default, leaves mutations open exactly as
before. On fleet-host it lives in the installed LaunchAgent, which `chmod 600`
because it now holds a secret — deploying by rsync does not touch
`~/Library/LaunchAgents`, so the token survives a redeploy, but reinstalling the
plist from `deploy/` would drop it. Generate one with:

```bash
openssl rand -base64 24 | tr -d '/+=' | cut -c1-32
```

Note the device and executor paths (`/devices/:id/next-job`,
`/executor/next-job`, `POST /results`) are deliberately **not** guarded — the
fleet must keep running whether or not anyone has a token. This is a speed bump, not authentication — `POST /jobs` stays open for
CI and curl, so anyone who can reach the collector can still enqueue. What the
token buys is that a stray tab or misfired script cannot *cancel* or *delete*.

## Alerts

Evaluated every 60 s (`FLEET_ALERT_TICK_MS`). Alerts are **state, not events**:
one row per (rule, subject) for as long as the condition holds, resolved when it
stops. A device offline for six hours is one row with a rising `seen_count`, not
360 notifications — and nothing is notified twice, ever.

| Rule | Fires when |
|---|---|
| `device-offline` | no check-in for `FLEET_ALERT_DEVICE_OFFLINE_S` (default 15 min) |
| `thermal-critical` | a device still reporting is thermally critical |
| `low-battery` | below `FLEET_ALERT_LOW_BATTERY_PCT` (default 15) and not charging |
| `job-failed` | a job failed in the last 24 h |
| `job-stuck` | claimed, lease still being renewed, but no result rows after 2× the lease TTL |
| `schedule-missed` | an enabled schedule that has run before missed its firing by 5 min |
| `db-size` / `log-size` | past `FLEET_ALERT_DB_BYTES` / `FLEET_ALERT_LOG_BYTES` |

`job-stuck` is the case the lease sweep cannot see: beacons keep renewing the
claim, so the job never lapses, and without this rule a runner that is alive but
producing nothing looks identical to one that is working.

Battery and thermal are only judged on devices still checking in — a reading
from a silent device describes whenever it went silent, not now. And a device
reporting `-1` has no battery telemetry rather than a flat one.

Set `FLEET_ALERT_WEBHOOK` to push newly opened alerts to ntfy or any webhook
receiver; unset (the default) makes the dashboard the only channel. Acknowledge
keeps an alert listed but stops it nagging; snooze quiets it for N minutes and it
returns on its own. Only the condition clearing resolves an alert.

## Leases

A claim is a lease, not a permanent handoff. Without one, a runner that dies
mid-job — an emulator's low-memory killer taking out the process, a flat
battery, a yanked cable — leaves the job `claimed` forever and someone has to
mark it failed by hand in sqlite.

- Claiming a job sets `lease_deadline = now + lease.ttl_s` and bumps `attempts`.
- The runner posts `POST /results` with `kind: "beacon"` and the `job_id` to push
  the deadline out. The response's `lease_renewed: false` means the claim is
  gone (swept or already closed) and the runner should stop working the job.
- A sweep runs every 15 s (`FLEET_SWEEP_MS`) and on startup, and can be forced
  with `POST /jobs/sweep`. Lapsed claims go back to `queued` for another device
  to pick up; once `attempts` reaches `lease.max_attempts` the job is marked
  `failed` instead. Either way `last_error` records what happened, and the
  dashboard shows it under the job row.

Defaults are 600 s and 3 attempts, per job via `lease.ttl_s` / `lease.max_attempts`.
`drain` and `soak` default to 14400 s, since they run for hours between beacons.
Pick a TTL longer than the worst-case gap between beacons for that workload — too
short and the collector requeues a job that is still running fine.

## Phase 0 scope notes

- Artifact uploads are buffered in memory — fine for smoke tests and APKs,
  needs streaming before multi-GB models (Phase 2).
- `targets.match` expressions and `targets.exclusive` locks are accepted but not
  enforced yet (Phase 4 alongside pools/scheduler).
- No scheduler yet: nightly runs arrive when cron enqueues land in Phase 4.
