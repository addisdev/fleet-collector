// archive: pull an external API's data into the fleet's own artifact store.
//
// One workload, one source per module: gsc (Search Console — Google keeps 16
// months, the fleet keeps forever), asc (App Store reviews), play (Play
// Store reviews — Google returns roughly the LAST WEEK only, which is why
// the review pulls run daily; a lazy cadence loses data permanently).
//
// Auth follows the fleet's secrets rule everywhere: the job spec names a
// Keychain ACCOUNT, never a credential. The executor host holds each key
// (base64 of its JSON) in its login Keychain.
import { NAME } from "../../fleet-client.js";
import type { Job } from "../../executor.js";
import { keychainPassword, KEYCHAIN_SERVICE } from "../../secrets.js";
import { runGsc } from "./gsc.js";
import { runAscReviews } from "./asc.js";
import { runPlayReviews } from "./play.js";

/** One review, the same shape whichever store it came from — normalized at
 *  pull time so the digest never needs to know a source's field names. */
export type Review = {
  id: string;
  source: "asc" | "play";
  app: string;
  rating: number;
  title: string | null;
  body: string;
  author: string | null;
  date: string;              // ISO
  territory: string | null;  // ASC country / Play reviewer language
};

/**
 * A credential from the executor host's Keychain, parsed from base64 JSON.
 * The error message carries the exact fix, because "missing keychain item"
 * discovered at 05:30 should not need this file to decode.
 */
export async function keychainJson<T>(account: string, shapeHint: string, extraHint = ""): Promise<T> {
  const got = await keychainPassword(account);
  if (!got.ok) {
    throw new Error(
      got.reason === "missing"
        ? `no Keychain item for ${account} (service "${KEYCHAIN_SERVICE}") on ${NAME}; store base64 of ${shapeHint} ` +
          `with: security add-generic-password -s ${KEYCHAIN_SERVICE} -a ${account} -w "$(base64 -i key.json)"${extraHint}`
        : `the Keychain item for ${account} exists on ${NAME} but could not be read (${got.detail})`,
    );
  }
  try {
    return JSON.parse(Buffer.from(got.password, "base64").toString("utf8")) as T;
  } catch (e) {
    throw new Error(`Keychain item ${account} is not base64 of ${shapeHint} (${(e as Error).message.slice(0, 80)})`);
  }
}

export async function runArchive(job: Job) {
  const source = (job.params ?? {}).source;
  if (source === "gsc") return runGsc(job);
  if (source === "asc") return runAscReviews(job);
  if (source === "play") return runPlayReviews(job);
  throw new Error(`archive supports sources "gsc", "asc", "play"; got ${JSON.stringify(source)}`);
}
