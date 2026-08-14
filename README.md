# fleet-collector

Phase 0 of the Fleet Runner plan: the collector service — device registry, job
queue, artifact store, results DB, and dashboard for the device fleet.

Node + Fastify + SQLite (WAL). No auth: the collector is only reachable over the
Tailscale mesh. Runs under `launchd` on the Mac mini.

## Run

```
npm install
npm start          # listens on :8787 (FLEET_PORT to change)
npm run smoke      # end-to-end check against a running collector
```

Smoke against a collector you started for the purpose, never the live one — it
enqueues jobs a real device could claim. Give it its own port and data dir:

```bash
FLEET_DATA_DIR=/tmp/fleet-test FLEET_ARTIFACT_DIR=/tmp/fleet-test/store FLEET_PORT=8799 npm start
```

then `FLEET_URL=http://127.0.0.1:8799 npm run smoke`.

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
| `GET /dash` | Server-rendered dashboard |

Job and result shapes are documented in [`schemas/`](schemas/) (`"schema": 1`).

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
