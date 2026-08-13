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

## Endpoints

| Method & path | Purpose |
|---|---|
| `POST /devices/register` | Device checks in with descriptor + pool tags (upsert) |
| `GET /devices/:id/next-job` | Long-poll (~25 s) for `executor: "device"` work; 204 when none |
| `GET /executor/next-job` | Long-poll for `executor: "host"` work (`?name=` labels the claimant) |
| `POST /jobs` | Enqueue a job spec (curl, CI, or the future scheduler); 409 on duplicate `job_id` |
| `GET /jobs/:id` | Job status |
| `POST /results` | Result rows (`kind: "result"`, idempotent by job/device/iter) and telemetry (`kind: "beacon"`); `final: true` closes the job |
| `POST /artifacts` | Upload raw bytes (models or app builds); returns `sha256` |
| `GET /artifacts/:sha256` | Download, supports Range requests |
| `GET /dash` | Server-rendered dashboard |

Job and result shapes are documented in [`schemas/`](schemas/) (`"schema": 1`).

## Phase 0 scope notes

- Artifact uploads are buffered in memory — fine for smoke tests and APKs,
  needs streaming before multi-GB models (Phase 2).
- `targets.match` expressions and `targets.exclusive` locks are accepted but not
  enforced yet (Phase 4 alongside pools/scheduler).
- No scheduler yet: nightly runs arrive when cron enqueues land in Phase 4.
