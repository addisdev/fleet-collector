// Token minting for the archive sources. Two grant flavors, no SDKs:
// Google's RS256 service-account JWT (Search Console, Play Console — same
// flow, different scope) and Apple's ES256 App Store Connect JWT.
import { createSign } from "node:crypto";

export const b64url = (s: Buffer | string) =>
  Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export type GoogleServiceAccount = { client_email: string; private_key: string };
export type AscApiKey = { key_id: string; issuer_id: string; private_key: string };

// Google's token endpoint, overridable so a stub can stand in. The name says
// GSC for historical reasons; every Google source exchanges here.
export const GOOGLE_TOKEN_URL = process.env.FLEET_GSC_TOKEN_URL ?? "https://oauth2.googleapis.com/token";

/** A one-hour Google access token via the service-account JWT grant. */
export async function googleAccessToken(sa: GoogleServiceAccount, scope: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope,
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const jwt = `${header}.${claims}.${b64url(signer.sign(sa.private_key))}`;

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`token exchange -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error("token exchange returned no access_token");
  return body.access_token;
}

/**
 * An App Store Connect bearer token: ES256, signed with the .p8 key.
 *
 * The trap this function exists to step around: node's ECDSA signatures come
 * out DER-encoded by default, and JWT ES256 requires the raw 64-byte R‖S
 * form. `dsaEncoding: "ieee-p1363"` makes node emit exactly that, so there is
 * no hand-rolled DER walker here to get subtly wrong.
 */
export function ascToken(key: AscApiKey): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "ES256", kid: key.key_id, typ: "JWT" }));
  // Apple caps token lifetime at 20 minutes; ask for less than the cap.
  const claims = b64url(JSON.stringify({
    iss: key.issuer_id,
    iat: now,
    exp: now + 15 * 60,
    aud: "appstoreconnect-v1",
  }));
  const signer = createSign("SHA256");
  signer.update(`${header}.${claims}`);
  const sig = signer.sign({ key: key.private_key, dsaEncoding: "ieee-p1363" });
  return `${header}.${claims}.${b64url(sig)}`;
}
