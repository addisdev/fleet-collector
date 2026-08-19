// The SSE client: one EventSource for the whole page, shared by every hook.
//
// Pages subscribe to event *types*, not payloads. An event means "this part of
// the fleet changed" and the subscriber refetches — so a dropped or duplicated
// event costs a redundant GET, never a wrong screen.
import { useEffect, useState } from "preact/hooks";

export type LiveState = "connecting" | "live" | "down";

type Handler = (event: Record<string, unknown>) => void;

const TYPES = ["hello", "job", "device", "beacon", "result", "lock", "schedule", "artifact", "pipeline-event"] as const;

const handlers = new Map<string, Set<Handler>>();
const stateWatchers = new Set<(s: LiveState) => void>();

let source: EventSource | null = null;
let state: LiveState = "connecting";
let instance: string | null = null;

function setState(next: LiveState) {
  if (state === next) return;
  state = next;
  for (const w of stateWatchers) w(next);
}

function dispatch(type: string, raw: MessageEvent) {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(raw.data) as Record<string, unknown>;
  } catch {
    return;
  }
  if (type === "hello") {
    // A different instance id means the collector restarted under us. Anything
    // the page inferred from earlier events may be stale, so everyone refetches.
    const seen = data.instance as string;
    const restarted = instance !== null && instance !== seen;
    instance = seen;
    setState("live");
    if (restarted) for (const t of TYPES) for (const h of handlers.get(t) ?? []) h({ type: t, reason: "restart" });
    return;
  }
  for (const h of handlers.get(type) ?? []) h(data);
}

function connect() {
  if (source) return;
  setState(state === "live" ? "live" : "connecting");
  const es = new EventSource("/api/stream");
  source = es;
  for (const type of TYPES) es.addEventListener(type, (e) => dispatch(type, e as MessageEvent));
  es.addEventListener("open", () => setState("live"));
  es.addEventListener("error", () => {
    // EventSource reconnects on its own; the state flag is only so the UI can
    // stop claiming to be live while it does.
    setState(es.readyState === EventSource.CLOSED ? "down" : "connecting");
    if (es.readyState === EventSource.CLOSED) {
      source = null;
      // The collector caps concurrent streams, so back off rather than spin.
      setTimeout(connect, 3000);
    }
  });
}

/** Subscribe to live event types. Returns the unsubscribe function. */
export function onLive(types: string[], handler: Handler): () => void {
  connect();
  for (const t of types) {
    const set = handlers.get(t) ?? new Set<Handler>();
    set.add(handler);
    handlers.set(t, set);
  }
  return () => {
    for (const t of types) handlers.get(t)?.delete(handler);
  };
}

export function useLiveState(): LiveState {
  const [s, setS] = useState<LiveState>(state);
  useEffect(() => {
    connect();
    stateWatchers.add(setS);
    setS(state);
    return () => void stateWatchers.delete(setS);
  }, []);
  return s;
}
