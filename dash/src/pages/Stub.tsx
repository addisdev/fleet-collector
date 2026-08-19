// Placeholder for screens whose API is live but whose UI lands in a later
// phase. It names the phase and links the backing endpoint, so the page is
// honest about being unfinished instead of looking broken.
import { Panel } from "../ui.js";

export type StubSpec = {
  title: string;
  phase: string;
  blurb: string;
  bullets: string[];
  endpoints: string[];
};

export function Stub({ spec }: { spec: StubSpec }) {
  return (
    <>
      <h1>{spec.title}</h1>
      <Panel title={`Arrives in ${spec.phase}`}>
        <div class="stub">
          <p>{spec.blurb}</p>
          <ul>
            {spec.bullets.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
          <p>
            The data is already served — these endpoints are live now:
          </p>
          <ul>
            {spec.endpoints.map((e) => (
              <li key={e}>
                <a href={e} target="_blank" rel="noreferrer">
                  <code>{e}</code>
                </a>
              </li>
            ))}
          </ul>
        </div>
      </Panel>
    </>
  );
}

export const STUBS: Record<string, StubSpec> = {
  results: {
    title: "Results",
    phase: "D3",
    blurb:
      "Results read as results: benchmark trends, UI-test matrices, drain curves, soak survival — with the honest-numbers rules enforced.",
    bullets: [
      "Prefill and decode charted separately; memory never mixed across mem_method",
      "Simulator rows flagged and excluded from hardware comparisons by default",
      "UI-test pass/fail matrix per build per device, with screenshots and JUnit detail",
      "CSV and JSON export of the rows behind every view",
    ],
    endpoints: ["/api/results/bench", "/api/results/ui", "/api/results/recent", "/api/results?workload=benchmark"],
  },
  artifacts: {
    title: "Artifacts",
    phase: "D4",
    blurb: "The content-addressed store: models, app builds, JUnit reports, screenshots, and batch outputs.",
    bullets: [
      "Reference counts, so an unreferenced 4 GB GGUF is visible before it fills the disk",
      "Streaming upload from the browser — the fix for Phase 0's in-memory buffering",
      "Garbage collection of unreferenced artifacts, on confirm",
    ],
    endpoints: ["/api/artifacts"],
  },
  events: {
    title: "Events",
    phase: "D4",
    blurb: "The pipeline rails: topics, throughput, and a tail of recent payloads, for watching a tiered pipeline flow.",
    bullets: ["Per-topic event counts and last-seen times", "Payload tail per topic", "Live updates as events publish"],
    endpoints: ["/api/events", "/api/events/:topic?limit=50"],
  },
};
