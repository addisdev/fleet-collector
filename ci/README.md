# Wiring an app repo to the fleet

Two independent paths. Most apps want both, but they answer different questions
and neither depends on the other.

## 1. Publish builds — `publish-build.yml`

On merge to `main`, build and publish to the fleet's artifact store tagged with
the app name. Nothing is tested; nothing waits for a device.

This is what makes a nightly meaningful. A schedule that pins a literal
`sha256` tests that build forever — one of ours spent six days guarding an APK
older than the code it was meant to guard. A schedule that asks for
`"sha256": "latest"` tests whatever was published most recently, and never has
to be edited.

The contract is one header: an artifact uploaded with `x-artifact-app` belongs
to that app, and `latest` resolves to the newest one. If no build has ever been
published for an app, its nightly is **skipped rather than failed** — a job
pinned to a build that does not exist would fail in a way indistinguishable
from the app being broken.

## 2. Test a pull request — `example-workflow.yml`

Enqueue a job against real hardware and block the PR on the verdict.
`ci-enqueue` uploads the build, enqueues, polls to a verdict, and exits 0/1, so
the check fails on a red suite whether or not commit statuses are armed.

## Commit statuses are built and dark

`report_to.github_status` records a status row for every job that asks for one,
and posts nothing unless **both** are set on the collector:

```
FLEET_GITHUB_STATUS=1
FLEET_GITHUB_TOKEN=<token with repo:status>
```

Unarmed, rows accumulate with `posted=0` and are visible on the dashboard — you
can see exactly what would have been posted before anything reaches GitHub.

Arming it makes a red nightly block a PR. That is the point, and it is also a
decision with consequences for everyone who pushes, so it stays off until
somebody chooses it deliberately.
