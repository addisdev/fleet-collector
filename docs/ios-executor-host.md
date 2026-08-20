# Standing up the iOS executor on a new Mac

The iOS executor must run on a Mac with **full Xcode** — `simctl` and
`devicectl` ship with it, and Command Line Tools alone are not enough. That is
why fleet-host cannot do this job and why iOS work is pinned with
`targets.executor` rather than left to whichever executor is free.

It also has to be the Mac the iPhone is **physically cabled to**. Presence,
installs and XCUITest all go over that cable.

## 1. The executor

Copy `deploy/com.addisdev.fleet-executor-ios.plist` to
`~/Library/LaunchAgents/` on the new host and adjust:

| Key | What it must be on the new host |
|---|---|
| `ProgramArguments[0]` | that host's `node` |
| `ProgramArguments[1]`, `WorkingDirectory` | where `fleet-collector` is checked out there |
| `FLEET_EXECUTOR_NAME` | keep `mac-xcode` to inherit existing job routing, or pick a new name and update the schedules that pin it |
| `FLEET_URL` | the collector. Loopback via the SSH tunnel if this host also hits the macOS local-network gate; the LAN address otherwise |
| `FLEET_IOS_PROJECT` | only needed for the generic FleetRunner bundle |

Then:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.addisdev.fleet-executor-ios.plist
```

**Run one iOS executor at a time.** Two hosts sharing `FLEET_EXECUTOR_NAME`
both claim jobs pinned to that name, and each will run them on whatever it can
see. Bootout the old one before bootstrapping the new.

## 2. The phone

1. Cable it to the new host, unlock, tap **Trust**.
2. Settings → Privacy & Security → **Developer Mode** → on, restart, confirm.
3. Settings → Display & Brightness → Auto-Lock → **Never**. A locked phone
   stops xcodebuild dead with "Unlock to Continue", and a nightly at 02:30 has
   nobody to unlock it.
4. Register its UDID at developer.apple.com → Devices, or the build fails with
   "isn't registered in your developer account".

The executor reports what it can see every 60s, so the phone appears in the
fleet by itself. If it does not, the log says why:

```
iPhone 12 Pro is paired but not reachable (transport=wired, tunnel=disconnected)
  -- unlock it, trust this Mac, and check Developer Mode is on
```

Note that `tunnelState: disconnected` is normal for a wired phone that works
fine — devicectl opens the tunnel on demand. Membership is decided by
`transport`, not by that field.

## 3. Sign-in credentials

Suites that need an account skip every test that touches one — greenfolio's
skips 8 of 12 — so this is the difference between testing the app and testing
that the app launches.

The password lives in that host's login Keychain and nowhere else:

```bash
security add-generic-password -s fleet-ui-test -a showcase@greenfol.io -w
```

`-w` prompts rather than taking the password as an argument, because argv is
world-readable via `ps`. The same reasoning as greenfolio's own
`ci/set-test-credentials.sh`.

Reading it from the executor works because a LaunchAgent runs inside your GUI
session, where the login keychain is already unlocked -- verified with a probe
agent, not assumed. It does **not** work if nobody has logged in since boot:
the login keychain stays locked and every lookup fails. The executor says which
of the two it hit, because the remedies are opposite:

```
no Keychain item for X ... add one with: security add-generic-password ...
the Keychain item for X exists but could not be read ... locked, or not allowed
```

The job then names only the account:

```json
"suite": {
  "kind": "xcuitest",
  "credentials": { "account": "showcase@greenfol.io",
                   "email_var": "GREENFOLIO_TEST_EMAIL",
                   "password_var": "GREENFOLIO_TEST_PASSWORD" }
}
```

The executor resolves the password locally, passes it to xcodebuild as
`TEST_RUNNER_*`, and scrubs it from the log before that log becomes a
downloadable artifact. **A password must never appear in a job spec** — specs
are stored in SQLite, served by the API and rendered on the dashboard, so one
that lands there is published to everyone on the LAN. The collector refuses
such specs with a 400.

Writes stay off. `GREENFOLIO_UI_TEST_ALLOW_WRITES=1` un-skips a test that
creates data, and greenfolio's own script guards it for disposable accounts
only. Turn it on deliberately or not at all.

## 4. Targeting the phone rather than a simulator

Once a host has both, say which you mean:

```json
"targets": { "executor": "mac-xcode", "device_kind": "device", "match": "os ~ 'ios-18'" }
```

`match` is evaluated by the executor as well as at claim time, so it means the
same thing in both places. Without `device_kind` a job runs on every iOS target
attached — simulators included.
