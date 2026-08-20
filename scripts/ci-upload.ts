// Publish a build to the fleet's artifact store and tag it with the app it is,
// so nightlies can ask for the latest one instead of a hash somebody has to
// remember to bump.
//
//   npx tsx scripts/ci-upload.ts --artifact app.apk --app greenfolio-android \
//     --build "$(git describe --tags --always)" [--platform android]
//
// This is deliberately NOT ci-enqueue: publishing a build and testing a build
// are different events. A merge to main should publish whether or not a device
// is free, and the nightly picks it up later. Coupling them means a busy shelf
// silently stops builds from being published.
import { readFileSync } from "node:fs";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}

const BASE = (args.get("collector") ?? process.env.FLEET_URL ?? "http://127.0.0.1:8788").replace(/\/$/, "");
const ARTIFACT = args.get("artifact");
const APP = args.get("app");
const BUILD = args.get("build");
const PLATFORM = args.get("platform");
const TOKEN = process.env.FLEET_DASH_TOKEN;

if (!ARTIFACT || !APP || !BUILD) {
  console.error("usage: ci-upload --artifact <file> --app <name> --build <version> [--platform <p>] [--collector <url>]");
  process.exit(2);
}

const body = readFileSync(ARTIFACT);
const res = await fetch(`${BASE}/artifacts`, {
  method: "POST",
  headers: {
    "content-type": "application/octet-stream",
    "x-artifact-name": ARTIFACT.split("/").pop()!,
    "x-artifact-app": APP,
    "x-artifact-build": BUILD,
    ...(PLATFORM ? { "x-artifact-platform": PLATFORM } : {}),
    ...(TOKEN ? { "x-fleet-token": TOKEN } : {}),
  },
  body,
});
if (!res.ok) {
  console.error(`ci-upload: ${res.status} ${await res.text()}`);
  process.exit(1);
}
const { sha256, size } = (await res.json()) as { sha256: string; size: number };
console.log(`published ${APP} ${BUILD} -> ${sha256} (${size} bytes)`);
console.log(`nightlies asking for the latest ${APP} will now test this build`);
