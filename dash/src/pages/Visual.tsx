// The visual-regression review grid: pages × profiles from the latest
// web-shots run, each cell judged against the accepted baseline, with the
// side-by-side a person needs before clicking accept.
//
// Accepting is the one judgment this pipeline refuses to automate — the diff
// engine can say "0.4% of pixels changed", only a person can say "that's the
// redesign, not a regression". So the grid optimizes for exactly that moment:
// baseline, current and diff in one eyeline, accept one cell or the whole run.
import { useState } from "preact/hooks";
import { useApi } from "../api.js";
import { mutate, useMutation } from "../mutate.js";
import { useQuery } from "../router.js";
import { Actions, Button, ErrorBox, Link, Loaded, Panel, Pill, Select, Stat, agoFrom, num } from "../ui.js";

type CellHistory = { job_id: string; created_at: string | null; ok: boolean | null; diff_pct: number | null };
type Cell = {
  page: string;
  profile: string;
  status: "pass" | "diverged" | "new" | "missing";
  ok: boolean | null;
  diff_pct: number | null;
  note: string | null;
  sha256: string | null;
  diff_sha256: string | null;
  baseline_sha256: string | null;
  history: CellHistory[];
};
type Matrix = {
  suite: string;
  latest: { job_id: string; status: string; created_at: string | null } | null;
  runs: { job_id: string; status: string; created_at: string | null }[];
  profiles: string[];
  pages: string[];
  cells: Cell[];
};

const STATUS_PILL: Record<Cell["status"], string> = {
  pass: "done",
  diverged: "failed",
  new: "claimed",
  missing: "queued",
};

/** Last few runs as dots, newest on the right — a flapping cell reads as a
 *  pattern here rather than as tonight's one-off red. */
function History({ h }: { h: CellHistory[] }) {
  if (h.length === 0) return null;
  return (
    <span class="vr-history">
      {[...h].reverse().map((r) => (
        <i
          key={r.job_id}
          class={r.ok === null ? "none" : r.ok ? "ok" : "bad"}
          title={`${r.job_id}: ${r.ok === null ? "no shot" : r.ok ? "pass" : `${num(r.diff_pct ?? 0, 2)}% diff`}`}
        />
      ))}
    </span>
  );
}

function AcceptButton({ suite, cell, jobId, onDone, children }: {
  suite: string; cell: Cell; jobId: string | undefined; onDone: () => void; children: string;
}) {
  const accept = useMutation(async () => {
    const r = await mutate("POST", "/api/visual/baselines/accept", {
      suite, page: cell.page, profile: cell.profile, sha256: cell.sha256, job_id: jobId,
    });
    onDone();
    return r;
  });
  return (
    <>
      <Button tone="primary" busy={accept.busy} onClick={() => void accept.go()}>
        {children}
      </Button>
      {accept.error && <ErrorBox error={accept.error} />}
    </>
  );
}

function CellDetail({ suite, cell, jobId, onDone }: {
  suite: string; cell: Cell; jobId: string | undefined; onDone: () => void;
}) {
  const panes = [
    { label: "baseline", sha: cell.baseline_sha256 },
    { label: "current", sha: cell.sha256 },
    { label: "diff", sha: cell.diff_sha256 },
  ].filter((p) => p.sha);
  return (
    <Panel
      title={`${cell.page} · ${cell.profile}`}
      aside={<Pill kind={STATUS_PILL[cell.status]}>{cell.status}</Pill>}
    >
      <div class="stats">
        <Stat label="diff" value={cell.diff_pct === null ? "—" : `${num(cell.diff_pct, 2)}%`}
          tone={cell.status === "diverged" ? "bad" : cell.status === "pass" ? "ok" : undefined} />
        <Stat label="baseline" value={cell.baseline_sha256 ? <code>{cell.baseline_sha256.slice(0, 12)}</code> : "none"} />
        <Stat label="current" value={cell.sha256 ? <code>{cell.sha256.slice(0, 12)}</code> : "not captured"} />
      </div>
      {cell.note && <p class="empty">{cell.note}</p>}
      {panes.length > 0 ? (
        <div class="vr-compare">
          {panes.map((p) => (
            <figure key={p.label}>
              <figcaption>
                {p.label} · <a href={`/artifacts/${p.sha}`} target="_blank" rel="noreferrer">full size</a>
              </figcaption>
              <img src={`/artifacts/${p.sha}`} alt={`${cell.page} ${cell.profile} ${p.label}`} loading="lazy" />
            </figure>
          ))}
        </div>
      ) : (
        <p class="empty">No images: the capture failed, so there is nothing to compare.</p>
      )}
      {cell.sha256 && cell.sha256 !== cell.baseline_sha256 && (
        <Actions>
          <AcceptButton suite={suite} cell={cell} jobId={jobId} onDone={onDone}>
            {cell.baseline_sha256 ? "Accept current as the new baseline" : "Accept as the first baseline"}
          </AcceptButton>
        </Actions>
      )}
    </Panel>
  );
}

/** Everything the latest run wants a human decision on, accepted in one go —
 *  for the first run of a new suite, or a deliberate redesign. */
function AcceptAll({ suite, pending, jobId, onDone }: {
  suite: string; pending: Cell[]; jobId: string | undefined; onDone: () => void;
}) {
  const accept = useMutation(async () => {
    for (const c of pending) {
      await mutate("POST", "/api/visual/baselines/accept", {
        suite, page: c.page, profile: c.profile, sha256: c.sha256, job_id: jobId,
      });
    }
    onDone();
    return { accepted: pending.length };
  });
  if (pending.length === 0) return null;
  return (
    <>
      <Button busy={accept.busy} onClick={() => void accept.go()}
        title="Sets the baseline for every new and diverged cell to what the latest run captured">
        Accept all {pending.length} pending
      </Button>
      {accept.error && <ErrorBox error={accept.error} />}
    </>
  );
}

export function Visual() {
  const [query, setQuery] = useQuery();
  const suites = useApi<{ suites: string[] }>("/api/visual/suites", ["job"], 60_000);
  const suite = query.get("suite") ?? suites.data?.suites[0] ?? null;
  const state = useApi<Matrix>(
    suite ? `/api/visual/matrix?suite=${encodeURIComponent(suite)}` : null,
    ["job", "result"],
    30_000,
  );
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <>
      <h1>Visual</h1>
      {suites.data && suites.data.suites.length > 1 && (
        <Panel>
          <div class="filters">
            <Select label="suite" value={suite ?? ""} onChange={(v) => setQuery({ suite: v })}
              options={suites.data.suites} />
          </div>
        </Panel>
      )}
      {suites.data && suites.data.suites.length === 0 && (
        <Panel>
          <p class="stub">
            No visual history yet. Enqueue a <code>web-shots</code> job — its captures land here,
            and the first accepted shot per page × profile becomes the baseline every later run
            is judged against.
          </p>
        </Panel>
      )}
      {suite && (
        <Loaded state={state} what="visual matrix">
          {(d) => {
            const cell = (page: string, profile: string) =>
              d.cells.find((c) => c.page === page && c.profile === profile);
            const pending = d.cells.filter((c) => c.sha256 && (c.status === "new" || c.status === "diverged"));
            const sel = d.cells.find((c) => `${c.page}|${c.profile}` === selected) ?? null;
            return (
              <>
                <Panel
                  title={`latest run`}
                  aside={d.latest && (
                    <span>
                      <Link to={`/jobs/${encodeURIComponent(d.latest.job_id)}`}>{d.latest.job_id}</Link>{" "}
                      <Pill kind={d.latest.status}>{d.latest.status}</Pill>
                    </span>
                  )}
                >
                  <div class="stats">
                    <Stat label="pages" value={d.pages.length} />
                    <Stat label="profiles" value={d.profiles.length} />
                    <Stat label="diverged" value={d.cells.filter((c) => c.status === "diverged").length}
                      tone={d.cells.some((c) => c.status === "diverged") ? "bad" : "ok"} />
                    <Stat label="awaiting accept" value={pending.length}
                      tone={pending.length ? "warn" : undefined} />
                    <Stat label="captured" value={d.latest?.created_at ? agoFrom(d.latest.created_at) : "—"} />
                  </div>
                  <div class="scroll">
                    <table class="vr-grid">
                      <thead>
                        <tr>
                          <th />
                          {d.profiles.map((p) => <th key={p}>{p}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {d.pages.map((page) => (
                          <tr key={page}>
                            <th>{page}</th>
                            {d.profiles.map((profile) => {
                              const c = cell(page, profile);
                              if (!c) return <td key={profile} class="dim">—</td>;
                              const key = `${c.page}|${c.profile}`;
                              return (
                                <td key={profile}>
                                  <button
                                    class={`vr-cell ${c.status}${selected === key ? " selected" : ""}`}
                                    onClick={() => setSelected(selected === key ? null : key)}
                                    title={c.note ?? c.status}
                                  >
                                    <b>{c.status === "pass" || c.status === "diverged"
                                      ? `${num(c.diff_pct ?? 0, 2)}%` : c.status}</b>
                                    <History h={c.history} />
                                  </button>
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <Actions>
                    <AcceptAll suite={d.suite} pending={pending} jobId={d.latest?.job_id} onDone={state.reload} />
                  </Actions>
                </Panel>
                {sel && (
                  <CellDetail suite={d.suite} cell={sel} jobId={d.latest?.job_id} onDone={state.reload} />
                )}
              </>
            );
          }}
        </Loaded>
      )}
    </>
  );
}
