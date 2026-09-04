# fleet-collector has moved

This code now lives in **[addisdev/fleet-runner](https://github.com/addisdev/fleet-runner)**,
in the [`collector/`](https://github.com/addisdev/fleet-runner/tree/main/collector) directory.

The brain: device registry, job queue with leases, artifact store, results database, scheduler, alert engine, and the dashboard.

## Why

Fleet Runner was four repositories: a collector, two phone runners, and later a
desktop runner. They share no code, only a JSON protocol — and that protocol is
the thing that changes.

A metric name is declared in the collector's schema and mirrored by hand in
three runners. A capability list is declared by an agent and enforced by the
queue. A new workload touches a runner, the schema, a results endpoint and a
dashboard view. Each of those is one change that has to land in several places
at once, and across repositories it landed as several pull requests that could
each merge alone.

That drift was not hypothetical: an eval's accuracy once rode in a field named
`decode_tok_s` because vision had no field of its own, and no query can
reproduce that report's numbers today.

## Nothing was lost

Every commit came across with `git subtree`, so the full history and every
author survive in the mono repo, and `git log --follow` works through the move.
This repository is archived and read-only; it stays up because its URL appears
in old pull requests and in write-ups that should keep resolving.
