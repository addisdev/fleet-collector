// The fleet's nightly and weekly runs, as code.
//
//   npm run seed:schedules            # against FLEET_URL, default :8788
//
// These existed only in the collector's database until now: created by hand
// with curl, recorded nowhere, and gone if fleet.db were ever rebuilt from a
// backup taken before them. This file is the source of truth.
//
// Idempotent, and deliberately careful about one thing: a schedule that is
// already enabled stays enabled. Re-running this must never quietly switch off
// a nightly run that someone turned on.
//
// Targeting note: these use `targets.match` rather than a curated pool. A pool
// is a label someone has to keep accurate as the shelf changes; a match is a
// statement about what the job actually needs, checked against each device's
// own descriptor at claim time. The plant-id eval is the case that proves it --
// it is litert with a .tflite model, so it is Android-only, and under the old
// `pool: ml-capable` targeting it fanned out to three iOS simulators that could
// not load it at all.

const BASE = process.env.FLEET_URL ?? "http://127.0.0.1:8788";
const TOKEN = process.env.FLEET_DASH_TOKEN;

type Schedule = { cron: string; template: Record<string, unknown> };

const SCHEDULES: Record<string, Schedule> = {
  "nightly-fleet-ui-smoke": {
    "cron": "30 2 * * *",
    "template": {
      "schema": 1,
      "workload": "ui-test",
      "executor": "host",
      "app": {
        "name": "fleet-runner",
        // Resolved at fire time to the newest build CI uploaded under this
        // name. A literal hash here is how this schedule spent six days
        // guarding an APK older than the code it was meant to guard; if no
        // build has ever been uploaded the run is skipped, not failed.
        "build": "latest",
        "sha256": "latest"
      },
      "suite": {
        "kind": "maestro",
        "flows": "fleetrunner/smoke.yaml"
      },
      // Both halves matter, and the run that proved it failed without them.
      //
      // `match` because this is an Android APK driven by Maestro: unrouted, it
      // was claimed and run against an iOS simulator, which is the same defect
      // that had the plant-id eval fanning out to three simulators that could
      // not load its model.
      //
      // `executor` because the phones are cabled to fleet-host and no match
      // expression can say that -- which machine can physically reach a device
      // is not a property of the device.
      "targets": {
        "match": "os ~ 'android'",
        "executor": "fleet-host",
        "exclusive": true
      },
      "lease": {
        "ttl_s": 1200
      }
    }
  },
  "nightly-aliquant-web": {
    "cron": "0 4 * * *",
    "template": {
      "schema": 1,
      "workload": "web-test",
      "executor": "host",
      "app": {
        "name": "aliquant-web",
        "build": "nightly"
      },
      "suite": {
        "kind": "playwright",
        "flows": "aliquant"
      },
      "params": {
        // Every project in playwright.config.ts, resolved by the executor at
        // run time so a project added to the config joins the nightly without
        // touching this. Firefox is included on evidence: it wedges on launch
        // on the DEV MacBook (macOS 27, GraphicsCriticalError) but passed
        // clean on mac-xcode/runner-host (macOS 26.6.1) on 2026-08-21 — the
        // breakage is the dev machine's, and this job is pinned to mac-xcode.
        "browser": "all"
      },
      // Pinned: browsers live on the Mac with Xcode, and an unpinned web job
      // claimed by fleet-host is refused rather than run without a browser.
      "targets": {
        "executor": "mac-xcode",
        "url": "https://my.aliquant.app"
      },
      // Per-PROJECT budget, not the whole matrix: the executor beacons between
      // projects, and each beacon renews the lease.
      "lease": {
        "ttl_s": 900
      }
    }
  },
  "nightly-aliquant-shots": {
    // After the 04:00 web suite: same host, and a functional failure showing
    // up before its screenshots keeps the two red flags in a readable order.
    "cron": "15 4 * * *",
    "template": {
      "schema": 1,
      "workload": "web-shots",
      "executor": "host",
      "app": {
        "name": "aliquant-web",
        "build": "nightly"
      },
      "suite": {
        "kind": "playwright",
        "flows": "aliquant"
      },
      // Profiles come from web-specs/aliquant/shots.json; pages diff against
      // the baselines accepted on the dashboard's Visual page. A new page (or
      // a first run) passes with a "new: no baseline" note until someone
      // accepts it there — capture failures and threshold-crossing diffs are
      // what fail this job.
      "targets": {
        "executor": "mac-xcode",
        "url": "https://my.aliquant.app"
      },
      "lease": {
        "ttl_s": 900
      }
    }
  },
  "nightly-aliquant-unfurl": {
    // Raw-HTML link previews. No browser involved, but pinned to the same
    // executor as the rest of the web suite so its results file next to them.
    "cron": "30 4 * * *",
    "template": {
      "schema": 1,
      "workload": "web-unfurl",
      "executor": "host",
      "app": { "name": "aliquant-web", "build": "nightly" },
      "suite": { "kind": "playwright", "flows": "aliquant" },
      "targets": { "executor": "mac-xcode", "url": "https://my.aliquant.app" },
      "lease": { "ttl_s": 600 }
    }
  },
  "nightly-aliquant-audit": {
    // The crawl (desktop checks + mobile-friendliness pass). Errors fail it;
    // warnings only show in the report and the issues_warn metric.
    "cron": "45 4 * * *",
    "template": {
      "schema": 1,
      "workload": "web-audit",
      "executor": "host",
      "app": { "name": "aliquant-web", "build": "nightly" },
      "suite": { "kind": "playwright", "flows": "aliquant" },
      "targets": { "executor": "mac-xcode", "url": "https://my.aliquant.app" },
      // The crawl beacons every 10 pages, so the lease budgets a segment,
      // not the whole site.
      "lease": { "ttl_s": 900 }
    }
  },
  "daily-gsc-archive": {
    // Search Console keeps 16 months; this keeps forever. Pulls the day that
    // finalized three days ago. Until the Keychain item and the Google Cloud
    // service account exist (see the error the job posts), every run fails
    // with instructions — seeded disabled like everything else.
    "cron": "0 6 * * *",
    "template": {
      "schema": 1,
      "workload": "archive",
      "executor": "host",
      "params": {
        "source": "gsc",
        "property": "sc-domain:aliquant.app",
        "account": "gsc-service-account"
      },
      "targets": { "executor": "mac-xcode" },
      "lease": { "ttl_s": 600 }
    }
  },
  // --- reviews: daily pulls + weekly digest ---
  //
  // The Play API returns roughly the last SEVEN DAYS of reviews and nothing
  // older, so the pulls are daily: a lazy cadence loses reviews permanently.
  // One schedule per (store, app); clone a block to add an app. All of these
  // need a Keychain item on the executor host before they can run — the
  // job's failure message carries the exact `security add-generic-password`
  // command — and the ASC blocks additionally need the app's numeric App
  // Store id filled in below.
  "daily-reviews-play-greenfolio": {
    "cron": "20 5 * * *",
    "template": {
      "schema": 1, "workload": "archive", "executor": "host",
      "params": { "source": "play", "app": "greenfolio", "package": "com.taylab.greenfolio" },
      "targets": { "executor": "mac-xcode" },
      "lease": { "ttl_s": 600 }
    }
  },
  "daily-reviews-play-jerv": {
    "cron": "25 5 * * *",
    "template": {
      "schema": 1, "workload": "archive", "executor": "host",
      "params": { "source": "play", "app": "jerv", "package": "com.taylab.jerv" },
      "targets": { "executor": "mac-xcode" },
      "lease": { "ttl_s": 600 }
    }
  },
  "daily-reviews-asc-greenfolio": {
    "cron": "30 5 * * *",
    "template": {
      "schema": 1, "workload": "archive", "executor": "host",
      // app_id is Apple's numeric identifier (App Store Connect -> App
      // Information -> Apple ID). The placeholder fails with a clear message
      // rather than silently pulling nothing.
      "params": { "source": "asc", "app": "greenfolio", "app_id": "SET-ME-numeric-app-id" },
      "targets": { "executor": "mac-xcode" },
      "lease": { "ttl_s": 600 }
    }
  },
  "weekly-review-digest": {
    // Monday morning, after that day's pulls: the week's reviews, classified
    // and summarized by the shelf's own models, assembled into a markdown
    // digest artifact. The host executor orchestrates; the LLM work runs as
    // ordinary batch jobs on charging Android devices with >=4GB RAM.
    "cron": "0 7 * * 1",
    "template": {
      "schema": 1, "workload": "digest", "executor": "host",
      // Which gguf the shelf should use. Name a model artifact that is
      // already in the store (Artifacts page lists them); the placeholder
      // sha fails the batch job with a missing-artifact error, not silence.
      "model": {
        "name": "SET-ME-digest-model", "format": "gguf", "quant": "q4_k_m",
        "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
      },
      "params": { "days": 7 },
      "targets": { "executor": "mac-xcode" },
      // The digest beacons every poll while shelf batches run, so the lease
      // budgets the orchestrator's own gaps, not the whole run.
      "lease": { "ttl_s": 900 }
    }
  },
  "nightly-synthetic-shelf": {
    "cron": "0 2 * * *",
    "template": {
      "schema": 1,
      "workload": "benchmark",
      "executor": "device",
      "backend": "synthetic",
      "fanout": true,
      "params": {
        "prompt_tokens": 256,
        "gen_tokens": 64,
        "warmup_iters": 1,
        "measure_iters": 3
      }
    }
  },
  "weekly-plant-id-eval": {
    "cron": "0 3 * * 1",
    "template": {
      "schema": 1,
      "workload": "batch",
      "executor": "device",
      "backend": "litert",
      "fanout": true,
      "model": {
        "name": "plantnet-300k-resnet18",
        "format": "tflite",
        "quant": "fp32",
        "sha256": "6f59f046c6a86593713aca76a3ab7bb55b520265eb66f5a77a114e450b1ccbf5"
      },
      "params": {
        "input_sha256": "acdcf4effbf6feef2744416bc84eb41c0b0e48fd7b50f7141b825741ee785203",
        "input_layout": "nchw",
        "normalize": "imagenet",
        "accelerator": "gpu",
        "warmup_iters": 3
      },
      "targets": {
        "match": "os ~ 'android' && ram_mb >= 3000"
      },
      "lease": {
        "ttl_s": 1800
      }
    }
  }
};

async function main() {
  const existing = new Map<string, boolean>(
    (
      (await (await fetch(`${BASE}/api/schedules`)).json()) as {
        schedules: { id: string; enabled: boolean }[];
      }
    ).schedules.map((s) => [s.id, s.enabled]),
  );

  let failed = 0;
  for (const [id, s] of Object.entries(SCHEDULES)) {
    // Preserve the on/off state of anything already there; new ones arrive off,
    // which is how every schedule in this fleet has always been seeded.
    const enabled = existing.get(id) ?? false;
    const res = await fetch(`${BASE}/schedules`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(TOKEN ? { "x-fleet-token": TOKEN } : {}),
      },
      body: JSON.stringify({ id, cron: s.cron, enabled, template: s.template }),
    });
    const verb = existing.has(id) ? "updated" : "created";
    if (res.status === 201) console.log(`  ok    ${id} ${verb}${enabled ? " (enabled, left on)" : ""}`);
    else {
      failed++;
      console.error(`  FAIL  ${id}: ${res.status} ${await res.text()}`);
    }
  }
  console.log(failed === 0 ? "\nschedules seeded" : `\n${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
