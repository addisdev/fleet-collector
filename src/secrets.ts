/**
 * Test-account credentials for UI suites.
 *
 * The rule this follows is not mine -- greenfolio's own
 * `ci/set-test-credentials.sh` sets it out, and it is a good one:
 *
 *   "The password is read from the terminal and piped to `gh` on stdin. It is
 *    never an argument (argv is world-readable via `ps`), never written to
 *    disk, and never echoed."
 *
 * So the fleet does not carry passwords either. In particular a password must
 * NEVER travel in a job spec: specs are stored in SQLite, returned by the API
 * and rendered on the dashboard, so anything in one is effectively published
 * to everyone on the LAN.
 *
 * Instead the job names the ACCOUNT -- an email address, not a secret, and
 * genuinely useful to see on a dashboard -- and the executor resolves the
 * password locally from the login Keychain of whichever host it runs on. The
 * secret never leaves that machine, is never on argv, and is never persisted
 * by the fleet.
 *
 * Add one on the executor host with:
 *
 *   security add-generic-password -s fleet-ui-test -a showcase@greenfol.io -w
 *
 * which prompts for the password rather than taking it as an argument.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const KEYCHAIN_SERVICE = process.env.FLEET_KEYCHAIN_SERVICE ?? "fleet-ui-test";

/** What a suite needs to sign in. `password` is resolved locally, never carried. */
export type Credentials = { account: string; password: string; emailVar: string; passwordVar: string };

/**
 * Look up the password for `account` in the executor host's login Keychain.
 *
 * Verified to work from a LaunchAgent, which is how the executor runs: the
 * agent lives in the user's GUI session, so the login keychain is unlocked and
 * `security` reads the item without prompting. It does NOT work if nobody has
 * logged in since boot -- the login keychain stays locked and every lookup
 * fails, which is worth knowing before blaming the suite.
 *
 * Distinguishes "no such item" from "cannot read it", because the remedy is
 * opposite: add the entry, versus unlock the keychain or grant access. Telling
 * someone to add an item that already exists is the kind of advice that costs
 * an hour.
 */
export type KeychainResult =
  | { ok: true; password: string }
  | { ok: false; reason: "missing" | "denied"; detail: string };

export async function keychainPassword(
  account: string,
  service = KEYCHAIN_SERVICE,
): Promise<KeychainResult> {
  try {
    // -w prints ONLY the password; the account is not a secret, so passing it
    // as an argument is fine. The password is never an argument anywhere.
    const { stdout } = await exec("security", ["find-generic-password", "-s", service, "-a", account, "-w"], {
      timeout: 10_000,
    });
    const pw = stdout.replace(/\n$/, "");
    return pw.length > 0
      ? { ok: true, password: pw }
      : { ok: false, reason: "missing", detail: "the keychain item is empty" };
  } catch (e) {
    const err = e as { code?: string; stderr?: string; message?: string };
    const text = `${err.stderr ?? ""} ${err.message ?? ""}`;
    // No `security` binary at all means this is not a Mac. That is a miss,
    // not a denial: "unlock your keychain" is the wrong advice on a Linux CI
    // runner, and the honest detail is that there is no keychain to unlock.
    if (err.code === "ENOENT" || /ENOENT/.test(text)) {
      return { ok: false, reason: "missing", detail: "no `security` command on this host (macOS Keychain only)" };
    }
    // "The specified item could not be found in the keychain." is the miss;
    // anything else -- a locked keychain, a denied ACL -- is a read failure.
    const missing = /could not be found/i.test(text);
    return {
      ok: false,
      reason: missing ? "missing" : "denied",
      detail: (err.stderr ?? err.message ?? "unknown").trim().slice(0, 200),
    };
  }
}

/**
 * Remove secret values from text bound for the artifact store.
 *
 * xcodebuild echoes its environment in places, and the log tail is uploaded as
 * an artifact that anyone on the dashboard can download. A password that
 * reaches the store has leaked regardless of how carefully it was fetched.
 */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (!s || s.length < 4) continue; // too short to match safely
    out = out.split(s).join("[redacted]");
  }
  return out;
}
