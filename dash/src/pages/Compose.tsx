// The job composer: build a spec, see who it will land on, enqueue it.
//
// Deliberately not a generic JSON editor. Each workload pre-fills the params
// that workload actually takes, the target picker says how many devices match
// before anything is enqueued, and the equivalent curl is shown throughout — so
// the form teaches the API rather than hiding it.
import { useEffect, useState } from "preact/hooks";
import { api, useApi, type DeviceList } from "../api.js";
import { mutate, useMutation } from "../mutate.js";
import { navigate, useQuery } from "../router.js";
import { Actions, Button, ErrorBox, Field, Json, Loaded, Panel, Pill, Select } from "../ui.js";

type Template = { id: string; name: string | null; spec: Record<string, any> };

// Defaults per workload, matching schemas/job.schema.json. These are starting
// points a person edits, not validation.
const WORKLOADS: Record<string, { executor: "device" | "host"; blurb: string; spec: () => Record<string, any> }> = {
  benchmark: {
    executor: "device",
    blurb: "Warmup then measured inference iterations on the device itself.",
    spec: () => ({
      backend: "synthetic",
      params: { prompt_tokens: 512, gen_tokens: 128, warmup_iters: 1, measure_iters: 3 },
    }),
  },
  batch: {
    executor: "device",
    blurb: "Process every item of an input artifact and upload the outputs.",
    spec: () => ({ backend: "llama.cpp", params: { input_sha256: "" } }),
  },
  pipeline: {
    executor: "device",
    blurb: "Subscribe to a topic, process each event, publish to <topic>.out.",
    spec: () => ({ backend: "llama.cpp", params: { topic: "" } }),
  },
  install: {
    executor: "host",
    blurb: "Install a build on every attached device and verify it launches.",
    spec: () => ({ app: { name: "", build: "", sha256: "" } }),
  },
  "ui-test": {
    executor: "host",
    blurb: "Run a Maestro flow or XCUITest bundle against an installed build.",
    spec: () => ({
      app: { name: "", build: "", sha256: "" },
      suite: { kind: "maestro", flows: "flows/smoke/*.yaml" },
    }),
  },
  drain: {
    executor: "host",
    blurb: "Run unplugged from a fixed battery level and record the drain curve.",
    spec: () => ({ app: { name: "", build: "", sha256: "" }, params: { scenario: "" } }),
  },
  soak: {
    executor: "host",
    blurb: "Leave the app running overnight; the beacon reports process-alive.",
    spec: () => ({ app: { name: "", build: "", sha256: "" } }),
  },
  thermal: {
    executor: "device",
    blurb: "Benchmark back to back for a fixed duration; the answer is a curve, not a number.",
    spec: () => ({
      backend: "synthetic",
      // Fifteen minutes is long enough for a phone to reach the state a pocket
      // puts it in, which is the whole question this workload answers.
      params: { prompt_tokens: 512, gen_tokens: 128, duration_s: 900 },
      lease: { ttl_s: 1200 },
      // A device on battery throttles for a reason that has nothing to do with
      // heat, which would make the curve unreadable.
      constraints: { require_charging: true },
    }),
  },
  "cold-start": {
    executor: "host",
    blurb: "Launch the installed build from cold, warm and hot; report p50 and p95 per state.",
    spec: () => ({
      app: { name: "", build: "", sha256: "" },
      params: { app_id: "", launches: 10, states: ["cold", "warm", "hot"] },
    }),
  },
  "self-check": {
    executor: "host",
    blurb: "The host inspects itself: disk, tool versions, clock drift, agents loaded.",
    spec: () => ({ targets: { executor: "" } }),
  },
};

function stamp(workload: string) {
  // Local time, no separators — readable in a job list and sortable.
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${workload}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function Compose() {
  const [q] = useQuery();
  const devices = useApi<DeviceList>("/api/devices", ["device"]);
  const templates = useApi<{ templates: Template[] }>("/api/templates", ["template"]);

  const [workload, setWorkload] = useState(q.get("workload") ?? "benchmark");
  const [jobId, setJobId] = useState(stamp(q.get("workload") ?? "benchmark"));
  const [pool, setPool] = useState(q.get("pool") ?? "");
  const [matchExpr, setMatchExpr] = useState("");
  const [deviceId, setDeviceId] = useState(q.get("device") ?? "");
  const [fanout, setFanout] = useState(false);
  const [exclusive, setExclusive] = useState(false);
  const [priority, setPriority] = useState(0);
  const [rest, setRest] = useState<string>(JSON.stringify(WORKLOADS[workload].spec(), null, 2));
  const [restError, setRestError] = useState<string | null>(null);

  const executor = WORKLOADS[workload]?.executor ?? "device";

  const applyWorkload = (w: string) => {
    setWorkload(w);
    setJobId(stamp(w));
    setRest(JSON.stringify(WORKLOADS[w].spec(), null, 2));
    setRestError(null);
    if (WORKLOADS[w].executor === "host") setFanout(false);
  };

  const loadTemplate = (t: Template) => {
    const { workload: w, executor: _e, targets, fanout: f, priority: p, ...body } = t.spec;
    if (w && WORKLOADS[w]) setWorkload(w);
    setJobId(stamp(w ?? workload));
    setPool(targets?.pool ?? "");
    setMatchExpr(targets?.match ?? "");
    setDeviceId(targets?.device_id ?? "");
    setExclusive(!!targets?.exclusive);
    setFanout(!!f);
    setPriority(typeof p === "number" ? p : 0);
    setRest(JSON.stringify(body, null, 2));
    setRestError(null);
  };

  // The spec as it stands, or null when the free-form half is not valid JSON.
  let spec: Record<string, any> | null = null;
  try {
    const body = JSON.parse(rest) as Record<string, any>;
    const targets: Record<string, unknown> = {};
    if (pool) targets.pool = pool;
    if (matchExpr) targets.match = matchExpr;
    if (deviceId) targets.device_id = deviceId;
    if (exclusive) targets.exclusive = true;
    spec = {
      schema: 1,
      job_id: jobId,
      workload,
      executor,
      ...body,
      ...(Object.keys(targets).length ? { targets } : {}),
      ...(fanout ? { fanout: true } : {}),
      ...(priority ? { priority } : {}),
    };
  } catch (e) {
    spec = null;
  }
  useEffect(() => {
    try {
      JSON.parse(rest);
      setRestError(null);
    } catch (e) {
      setRestError((e as Error).message);
    }
  }, [rest]);

  // Live target preview. Runs the same matcher fan-out will run.
  const [preview, setPreview] = useState<{ count: number; devices: { device_id: string }[] } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  useEffect(() => {
    if (executor === "host") {
      setPreview(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      mutate<{ count: number; devices: { device_id: string }[] }>("POST", "/api/jobs/preview-targets", {
        targets: { pool: pool || undefined, match: matchExpr || undefined, device_id: deviceId || undefined },
        // Sent so the count means "agents that can run this", not "agents this
        // pool selects" — otherwise the preview promises devices the queue
        // would then refuse to hand the job to.
        workload,
      })
        .then((r) => live && (setPreview(r), setPreviewError(null)))
        .catch((e) => live && (setPreview(null), setPreviewError((e as Error).message)));
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [pool, matchExpr, deviceId, executor, workload]);

  const enqueue = useMutation(async () => {
    const out = await mutate<{ ok: boolean; job_id?: string; fanout?: string[] }>("POST", "/api/jobs", spec);
    // Fan-out returns children; a single job returns its id. Land on whichever
    // page can actually show what just happened.
    if (out.fanout?.length) navigate(`/jobs?q=${encodeURIComponent(jobId)}`);
    else if (out.job_id) navigate(`/jobs/${encodeURIComponent(out.job_id)}`);
    return out;
  });

  const saveTemplate = useMutation(async () => {
    const id = prompt("Template id", `${workload}-template`);
    if (!id) return null;
    const { job_id: _drop, ...body } = spec ?? {};
    await mutate("POST", "/api/templates", { id, name: id, spec: body });
    templates.reload();
    return { id };
  });

  const curl = spec
    ? `curl -X POST ${location.origin}/jobs \\\n  -H 'content-type: application/json' \\\n  -d '${JSON.stringify(spec)}'`
    : "";

  return (
    <>
      <h1>New job</h1>

      <Panel title="Workload">
        <div class="filters">
          <Select label="workload" value={workload} options={Object.keys(WORKLOADS)} onChange={(v) => v && applyWorkload(v)} />
          <Field label="job id">
            <input value={jobId} onChange={(e) => setJobId((e.target as HTMLInputElement).value)} />
          </Field>
          <Field label="priority" hint="higher runs first">
            <input type="number" value={priority} onChange={(e) => setPriority(Number((e.target as HTMLInputElement).value) || 0)} />
          </Field>
        </div>
        <p class="empty">
          {WORKLOADS[workload]?.blurb} Runs on the <strong>{executor}</strong> executor.
        </p>
      </Panel>

      <Panel title="Target">
        <Loaded state={devices} what="devices">
          {(d) => (
            <>
              <div class="filters">
                <Select label="pool" value={pool} options={d.pools} onChange={setPool} />
                <Select
                  label="pin to device"
                  value={deviceId}
                  options={d.devices.map((dev) => dev.device_id)}
                  onChange={setDeviceId}
                />
                <Field label="match expression" hint="e.g. ram_mb >= 4000 && os ~ 'android'">
                  <input value={matchExpr} onChange={(e) => setMatchExpr((e.target as HTMLInputElement).value)} />
                </Field>
              </div>
              <div class="filters" style={{ marginTop: "0.75rem" }}>
                <label class="field checkbox">
                  <input
                    type="checkbox"
                    checked={fanout}
                    disabled={executor === "host"}
                    onChange={(e) => setFanout((e.target as HTMLInputElement).checked)}
                  />
                  <span>fan out — one pinned child job per matching device</span>
                </label>
                <label class="field checkbox">
                  <input type="checkbox" checked={exclusive} onChange={(e) => setExclusive((e.target as HTMLInputElement).checked)} />
                  <span>exclusive — hold a device lock while it runs</span>
                </label>
              </div>

              {executor === "host" ? (
                <p class="empty">
                  Host-executor jobs are claimed by the executor on the Mac, which fans across whatever devices are
                  attached to it — so there is nothing to preview here.
                </p>
              ) : previewError ? (
                <p class="error">{previewError}</p>
              ) : preview ? (
                <p class="empty">
                  <strong>{preview.count}</strong> device{preview.count === 1 ? "" : "s"} match
                  {preview.count === 1 ? "es" : ""} this target
                  {fanout && preview.count > 0 ? ` — fan-out would enqueue ${preview.count} child jobs` : ""}.
                  {preview.count > 0 && (
                    <span class="faint"> {preview.devices.map((x) => x.device_id).join(", ")}</span>
                  )}
                  {preview.count === 0 && <span class="text-bad"> Nothing would ever claim this job.</span>}
                </p>
              ) : null}
            </>
          )}
        </Loaded>
      </Panel>

      <Panel title="Spec">
        <Field label="model, app, backend, params — the rest of the job spec">
          <textarea
            rows={12}
            spellcheck={false}
            value={rest}
            onInput={(e) => setRest((e.target as HTMLTextAreaElement).value)}
          />
        </Field>
        {restError && <p class="error">Not valid JSON: {restError}</p>}
      </Panel>

      <Panel title="Enqueue">
        {enqueue.error && <ErrorBox error={enqueue.error} />}
        {saveTemplate.error && <ErrorBox error={saveTemplate.error} />}
        <Actions>
          <Button tone="primary" busy={enqueue.busy} disabled={!spec} onClick={() => void enqueue.go()}>
            Enqueue job
          </Button>
          <Button busy={saveTemplate.busy} disabled={!spec} onClick={() => void saveTemplate.go()}>
            Save as template
          </Button>
        </Actions>
        {spec && (
          <>
            <Json value={spec} label="spec that will be posted" />
            <details class="json">
              <summary>the same thing as curl</summary>
              <pre>{curl}</pre>
            </details>
          </>
        )}
      </Panel>

      <Loaded state={templates} what="templates">
        {(t) =>
          t.templates.length === 0 ? (
            <></>
          ) : (
            <Panel title={`Templates (${t.templates.length})`}>
              <div class="scroll">
                <table>
                  {t.templates.map((tpl) => (
                    <tr key={tpl.id}>
                      <td>
                        <code>{tpl.id}</code>
                      </td>
                      <td class="dim">
                        {tpl.spec.workload ?? "?"} <Pill kind="queued">{tpl.spec.executor ?? "?"}</Pill>
                      </td>
                      <td class="right">
                        <button type="button" class="linkish" onClick={() => loadTemplate(tpl)}>
                          load
                        </button>{" "}
                        <button
                          type="button"
                          class="linkish"
                          onClick={() => void mutate("DELETE", `/api/templates/${encodeURIComponent(tpl.id)}`).then(() => templates.reload())}
                        >
                          delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </table>
              </div>
            </Panel>
          )
        }
      </Loaded>
    </>
  );
}
