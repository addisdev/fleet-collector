// Metric names are declared in four places and enforced in none of them.
//
// schemas/result.schema.json is the contract. The collector's API reshapes rows
// by reading metric names out of the stored payload; the Android runner mirrors
// them in Protocol.kt and the iOS runner in Protocol.swift, independently, in
// two other repositories. Nothing has ever checked that the four agree, and the
// last time they drifted the cost was real: the plant-ID eval's accuracy rode
// in `decode_tok_s` because vision had no named fields yet, and the numbers in
// that write-up can no longer be reproduced by any query.
//
// This checks what one repository can check: every metric name the collector's
// own code reads must exist in the schema. A name that only the runners write
// is fine (the schema is the union), but a name the API reads and the schema
// has never heard of is a typo that silently reads undefined forever.
//
// The runner side is checked in each runner repo against schemas/metrics.json,
// which this script regenerates so there is one source and three copies of it.
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA = path.join(ROOT, "schemas/result.schema.json");
const MIRROR = path.join(ROOT, "schemas/metrics.json");

const schema = JSON.parse(readFileSync(SCHEMA, "utf8")) as {
  properties?: { metrics?: { properties?: Record<string, unknown> } };
};
const declared = Object.keys(schema.properties?.metrics?.properties ?? {});
if (declared.length === 0) {
  console.error("result.schema.json declares no metrics properties; refusing to pass");
  process.exit(1);
}
const known = new Set(declared);

/** Every .ts/.tsx file under src/ and dash/src/, skipping build output. */
function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

// Two shapes reach a metric: a property access on something called metrics, and
// a SQLite json_extract path. Both are matched; anything else (a computed key,
// a spread) is out of reach of a grep and out of scope for this check.
const ACCESS = /\bmetrics\??\.([a-z][a-z0-9_]*)\b/g;
const INDEX = /\bmetrics\??\[["']([a-z][a-z0-9_]*)["']\]/g;
const JSONPATH = /\$\.metrics\.([a-z][a-z0-9_]*)/g;

const problems: string[] = [];
for (const file of [...sources(path.join(ROOT, "src")), ...sources(path.join(ROOT, "dash/src"))]) {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  for (const pattern of [ACCESS, INDEX, JSONPATH]) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text))) {
      const name = m[1];
      if (known.has(name)) continue;
      const line = text.slice(0, m.index).split("\n").length;
      problems.push(`${path.relative(ROOT, file)}:${line}  metrics.${name} — not in result.schema.json`);
      void lines;
    }
  }
}

if (problems.length) {
  console.error("metric names read by the collector but never declared:\n");
  for (const p of [...new Set(problems)].sort()) console.error(`  ${p}`);
  console.error(
    "\nAdd the field to schemas/result.schema.json (and mirror it in the two runner\n" +
      "protocols) rather than deleting the read: a workload writing an undeclared\n" +
      "metric is exactly how the vision numbers ended up unqueryable.",
  );
  process.exit(1);
}

// Regenerated so the runner repos have something to check against without
// vendoring the whole schema.
//
// It is also checked, not merely written. The mirror is what an agent working
// in another repository reads, and a mirror that lags result.schema.json is
// worse than none: it states a contract confidently and wrongly, and the reader
// has no way to tell. Locally the file is rewritten and the run continues; in
// CI a stale mirror fails, so what is committed is what the schema says.
const mirror = JSON.stringify({ schema: 1, metrics: declared.sort() }, null, 2) + "\n";
const before = (() => { try { return readFileSync(MIRROR, "utf8"); } catch { return ""; } })();
if (before !== mirror) {
  writeFileSync(MIRROR, mirror);
  if (process.env.CI) {
    console.error(
      "schemas/metrics.json is out of date with schemas/result.schema.json.\n" +
        "It has been regenerated — commit it. Anything reading the mirror instead of\n" +
        "the schema was reading a stale contract until now.",
    );
    process.exit(1);
  }
  console.log(`metric names: ${declared.length} declared, schemas/metrics.json refreshed`);
} else {
  console.log(`metric names: ${declared.length} declared, all reads accounted for`);
}
