// The content-addressed store: models, app builds, JUnit reports, screenshots
// and batch outputs, with the reference counts that make garbage collection
// safe to reason about.
import { useState } from "preact/hooks";
import { useApi } from "../api.js";
import { getToken, mutate, useMutation } from "../mutate.js";
import { useQuery } from "../router.js";
import { Actions, Button, ConfirmButton, ErrorBox, Loaded, Pager, Panel, Pill, Search, bytes, clock } from "../ui.js";

type Artifact = {
  sha256: string; name: string | null; size: number; created_at: string | null;
  on_disk: boolean; references: number;
  /** Kept whatever the reference scan concludes. */
  pinned: boolean; pin_reason: string | null;
  /** Referenced by a baselines row rather than by any spec text, so its
   *  reference count reads 0 while it is undeletable. */
  baseline: boolean;
};
type ArtifactList = { page: number; per_page: number; total: number; pages: number; artifacts: Artifact[] };
type GcList = { days: number; count: number; bytes: number; candidates: { sha256: string; name: string | null; size: number; created_at: string | null }[] };

function Upload({ onDone }: { onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  const upload = useMutation(async () => {
    if (!file) return null;
    setProgress(`uploading ${file.name}…`);
    const token = getToken();
    // Streamed straight from the File object: the collector hashes to disk as
    // bytes arrive, so a multi-GB GGUF never has to fit in anyone's memory.
    const res = await fetch("/artifacts", {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-artifact-name": file.name,
        ...(token ? { "x-fleet-token": token } : {}),
      },
      body: file,
      duplex: "half",
    } as RequestInit & { duplex: string });
    const body = (await res.json().catch(() => ({}))) as { sha256?: string; error?: string };
    setProgress(null);
    if (!res.ok) throw new Error(body.error ?? `upload failed (${res.status})`);
    setFile(null);
    onDone();
    return body;
  });

  return (
    <>
      <div class="filters">
        <label class="field">
          <span>file</span>
          <input type="file" onChange={(e) => setFile((e.target as HTMLInputElement).files?.[0] ?? null)} />
        </label>
        <Button tone="primary" busy={upload.busy} disabled={!file} onClick={() => void upload.go()}>
          Upload
        </Button>
      </div>
      {progress && <p class="empty">{progress}</p>}
      {upload.error && <ErrorBox error={upload.error} />}
      {upload.result && (
        <p class="empty">
          Stored as <code>{(upload.result as { sha256?: string }).sha256}</code>
        </p>
      )}
    </>
  );
}

function Gc({ onDone }: { onDone: () => void }) {
  const [days, setDays] = useState(30);
  const state = useApi<GcList>(`/api/artifacts/gc-candidates?days=${days}`, ["artifact"], 0);

  const purge = useMutation(async () => {
    const list = state.data?.candidates ?? [];
    const results = await Promise.allSettled(
      list.map((c) => mutate("DELETE", `/api/artifacts/${c.sha256}`)),
    );
    state.reload();
    onDone();
    // Some may now be referenced by a job enqueued since the list was built;
    // those come back 409 and are reported rather than retried.
    return {
      deleted: results.filter((r) => r.status === "fulfilled").length,
      refused: results.filter((r) => r.status === "rejected").length,
    };
  });

  return (
    <Loaded state={state} what="GC candidates">
      {(d) => (
        <>
          <div class="filters">
            <label class="field">
              <span>older than (days)</span>
              <input type="number" min={0} value={days} onChange={(e) => setDays(Number((e.target as HTMLInputElement).value) || 0)} />
            </label>
          </div>
          <p class="empty">
            <strong>{d.count}</strong> artifact{d.count === 1 ? "" : "s"} ({bytes(d.bytes)}) older than {d.days} days
            are referenced by no job spec, result, schedule or template.
          </p>
          {d.count > 0 && (
            <>
              <div class="scroll">
                <table>
                  <tr>
                    <th>Name</th>
                    <th class="right">Size</th>
                    <th>Created</th>
                    <th>sha256</th>
                  </tr>
                  {d.candidates.slice(0, 25).map((c) => (
                    <tr key={c.sha256}>
                      <td>{c.name ?? <span class="faint">unnamed</span>}</td>
                      <td class="num">{bytes(c.size)}</td>
                      <td class="dim">{clock(c.created_at)}</td>
                      <td class="mono faint">{c.sha256.slice(0, 12)}…</td>
                    </tr>
                  ))}
                </table>
              </div>
              {d.candidates.length > 25 && <p class="empty">…and {d.candidates.length - 25} more.</p>}
              <Actions>
                <ConfirmButton
                  confirm={`Yes, delete ${d.count} artifacts (${bytes(d.bytes)})`}
                  busy={purge.busy}
                  onConfirm={() => void purge.go()}
                >
                  Delete unreferenced
                </ConfirmButton>
              </Actions>
              {purge.error && <ErrorBox error={purge.error} />}
              {purge.result && (
                <p class="empty">
                  Deleted {(purge.result as { deleted: number }).deleted}
                  {(purge.result as { refused: number }).refused > 0 &&
                    `, refused ${(purge.result as { refused: number }).refused} (referenced since the list was built)`}
                  .
                </p>
              )}
            </>
          )}
        </>
      )}
    </Loaded>
  );
}

export function Artifacts() {
  const [q, setQuery] = useQuery();
  const search = q.get("q") ?? "";
  const page = Number(q.get("page") ?? 1) || 1;
  const params = new URLSearchParams();
  if (search) params.set("q", search);
  if (page > 1) params.set("page", String(page));

  const state = useApi<ArtifactList>(`/api/artifacts${params.toString() ? `?${params}` : ""}`, ["artifact"], 60_000);

  return (
    <>
      <h1>Artifacts</h1>

      <Panel title="Upload">
        <Upload onDone={state.reload} />
      </Panel>

      <Panel title="Garbage collection">
        <Gc onDone={state.reload} />
      </Panel>

      <Panel>
        <div class="filters">
          <Search label="find" value={search} placeholder="name or sha256" onChange={(v) => setQuery({ q: v })} />
        </div>
      </Panel>

      <Loaded state={state} what="artifacts">
        {(d) => (
          <Panel title={`${d.total} artifact${d.total === 1 ? "" : "s"}`}>
            {d.artifacts.length === 0 ? (
              <p class="empty">Nothing in the store yet.</p>
            ) : (
              <>
                <div class="scroll">
                  <table>
                    <tr>
                      <th>Name</th>
                      <th class="right">Size</th>
                      <th class="right">Refs</th>
                      <th>Kept</th>
                      <th>On disk</th>
                      <th>Created</th>
                      <th>sha256</th>
                    </tr>
                    {d.artifacts.map((a) => (
                      <tr key={a.sha256}>
                        <td>{a.name ?? <span class="faint">unnamed</span>}</td>
                        <td class="num">{bytes(a.size)}</td>
                        <td class="num">{a.references === 0 ? <span class="faint">0</span> : a.references}</td>
                        <td>
                          {/* Why a row with no references is still safe. Without
                              this the only honest reading of "Refs 0" is "free to
                              delete", which for a baseline is exactly wrong. */}
                          {a.baseline ? (
                            <span class="faint with-icon" title="Accepted visual baseline; accept a different shot to release it.">
                              baseline
                            </span>
                          ) : (
                            <label class="with-icon" title={a.pin_reason ?? "Keep this artifact whatever the reference scan concludes."}>
                              <input
                                type="checkbox"
                                checked={a.pinned}
                                onChange={async (e) => {
                                  const pinned = (e.currentTarget as HTMLInputElement).checked;
                                  await mutate("POST", `/api/artifacts/${a.sha256}/pin`, { pinned });
                                  state.reload();
                                }}
                              />
                              <span class="faint">pin</span>
                            </label>
                          )}
                        </td>
                        <td>
                          {/* A row without its file is a download failure waiting
                              to happen for any job that references it. */}
                          {a.on_disk ? <Pill kind="done">yes</Pill> : <Pill kind="failed">missing</Pill>}
                        </td>
                        <td class="dim">{clock(a.created_at)}</td>
                        <td class="wrap-anywhere">
                          <a href={`/artifacts/${a.sha256}`} class="mono" title={a.sha256}>
                            {a.sha256.slice(0, 12)}…
                          </a>
                        </td>
                      </tr>
                    ))}
                  </table>
                </div>
                <Pager page={d.page} pages={d.pages} total={d.total} onPage={(p) => setQuery({ page: String(p) })} />
              </>
            )}
          </Panel>
        )}
      </Loaded>
    </>
  );
}
