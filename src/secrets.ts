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
 * Returns null when there is no entry, which the caller reports as a clear
 * "no credentials on this host" rather than letting the suite skip with the
 * vaguer message it prints when the environment is simply empty.
 */
export async function keychainPassword(account: string, service = KEYCHAIN_SERVICE): Promise<string | null> {
  try {
    // -w prints ONLY the password; the account is not a secret, so passing it
    // as an argument is fine. The password is never an argument anywhere.
    const { stdout } = await exec("security", ["find-generic-password", "-s", service, "-a", account, "-w"], {
      timeout: 10_000,
    });
    const pw = stdout.replace(/\n$/, "");
    return pw.length > 0 ? pw : null;
  } catch {
    return null; // no such item, or no Keychain on this host
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
