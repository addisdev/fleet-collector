// Typed access to the collector's read API, plus the hooks the pages use.
import { useEffect, useRef, useState } from "preact/hooks";
import { onLive } from "./live.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path.startsWith("/") ? path : `/api/${path}`, {
    ...init,
    headers: { accept: "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    // The API answers unknown /api paths with JSON, so an HTML body here means
    // something upstream (a proxy, a stale bundle) is answering instead.
    const body = await res.json().catch(() => ({}) as { error?: string });
    throw new ApiError(res.status, body.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export type Loadable<T> = { data: T | null; error: Error | null; loading: boolean; reload: () => void };

/**
 * Fetch on mount, again whenever a live event names one of `topics`, and on a
 * slow timer if `refreshMs` is set. The stream carries a nudge, not a payload:
 * the page refetches the endpoint it already trusts rather than trying to patch
 * its own copy of the state.
 *
 * The timer is not a fallback for the stream — it exists because a screen full
 * of "3m ago" and lease countdowns goes stale on its own, with no event to say so.
 */
export function useApi<T>(path: string | null, topics: string[] = [], refreshMs = 0): Loadable<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [nonce, setNonce] = useState(0);
  // Guards against a slow first response overwriting a fast second one.
  const seq = useRef(0);

  useEffect(() => {
    if (path === null) return;
    const mine = ++seq.current;
    setLoading(true);
    api<T>(path)
      .then((d) => {
        if (seq.current === mine) {
          setData(d);
          setError(null);
        }
      })
      .catch((e) => {
        if (seq.current === mine) setError(e as Error);
      })
      .finally(() => {
        if (seq.current === mine) setLoading(false);
      });
  }, [path, nonce]);

  const reload = () => setNonce((n) => n + 1);

  useEffect(() => {
    if (topics.length === 0) return;
    // Coalesce bursts: a fan-out enqueue publishes one event per child, and
    // refetching once per child would hammer the collector.
    let timer: number | undefined;
    return onLive(topics, () => {
      clearTimeout(timer);
      timer = setTimeout(reload, 250) as unknown as number;
    });
  }, [topics.join(",")]);

  useEffect(() => {
    if (!refreshMs) return;
    // A hidden tab left open for a week should not keep waking the collector.
    const tick = () => document.visibilityState === "visible" && reload();
    const id = setInterval(tick, refreshMs);
    return () => clearInterval(id);
  }, [refreshMs]);

  return { data, error, loading, reload };
}

// --- response shapes (mirrors src/api/*.ts) ---

export type DeviceStatus = "online" | "stale" | "offline";

export type Beacon = {
  battery_pct: number | null;
  charging: boolean | null;
  thermal: string | null;
  mem_mb: number | null;
  mem_method: string | null;
  process_alive: boolean | null;
  job_id: string | null;
} | null;

export type Device = {
  device_id: string;
  name: string | null;
  notes: string | null;
  descriptor: Record<string, unknown>;
  /** Effective pools: the override when set, otherwise what the runner reports. */
  pools: string[];
  /** null = an agent that predates capability routing; it is offered everything. */
  capabilities: string[] | null;
  /** /24 the agent last registered from. Distinguishes "offline" from "elsewhere". */
  last_net: string | null;
  pools_reported: string[];
  pools_override: string[] | null;
  platform: "ios" | "android";
  simulator: boolean;
  status: DeviceStatus;
  age_s: number | null;
  last_seen: string | null;
  beacon: Beacon;
  current_job: string | null;
  lock: { job_id: string; acquired_at: string | null } | null;
};

export type Job = {
  job_id: string;
  workload: string;
  executor: "device" | "host";
  status: "queued" | "claimed" | "done" | "failed" | "cancelled";
  claimed_by: string | null;
  attempts: number;
  max_attempts: number;
  priority: number;
  template_id: string | null;
  lease_ttl_s: number;
  lease_deadline: string | null;
  lease_remaining_s: number | null;
  duration_s: number | null;
  last_error: string | null;
  created_at: string | null;
  claimed_at: string | null;
  finished_at: string | null;
  pool: string | null;
  match: string | null;
  device_id: string | null;
  exclusive: boolean;
  backend: string | null;
  model: string | null;
  app: string | null;
  report_to: Record<string, string> | null;
};

export type Overview = {
  generated_at: string;
  devices: {
    total: number;
    online: number;
    stale: number;
    offline: number;
    busy: number;
    idle: number;
    charging: number;
    low_battery: number;
    low_battery_devices: string[];
    worst_thermal: string | null;
    by_pool: Record<string, number>;
  };
  queue: {
    queued: number;
    claimed: number;
    done_24h: number;
    failed_24h: number;
    last_attempt: number;
    oldest_queued_age_s: number | null;
  };
  running: {
    job_id: string;
    workload: string;
    executor: string;
    claimed_by: string | null;
    claimed_at: string | null;
    attempts: number;
    max_attempts: number;
    lease_deadline: string | null;
    lease_remaining_s: number | null;
    lease_fraction: number | null;
    elapsed_s: number | null;
  }[];
  recent_failures: {
    job_id: string;
    workload: string;
    executor: string;
    claimed_by: string | null;
    last_error: string | null;
    finished_at: string | null;
    attempts: number;
    max_attempts: number;
  }[];
  schedules: {
    total: number;
    enabled: number;
    missed: number;
    next: { id: string; cron: string; next_run: string | null; next_run_in_s: number | null; missed: boolean }[];
  };
  health: Health;
};

export type DeviceList = { total: number; pools: string[]; devices: Device[] };

export type DeviceDetail = Device & {
  counts: { results: number; beacons: number };
  jobs: {
    job_id: string;
    workload: string;
    executor: string;
    status: Job["status"];
    created_at: string | null;
    finished_at: string | null;
    attempts: number;
    max_attempts: number;
    last_error: string | null;
  }[];
  benchmarks: {
    job_id: string;
    at: string | null;
    model: string;
    quant: string | null;
    backend: string;
    metrics: Record<string, any> | null;
  }[];
};

export type BeaconSample = {
  ts: string | null;
  battery_pct: number | null;
  charging: boolean | null;
  thermal: string | null;
  mem_mb: number | null;
  mem_method: string | null;
  process_alive: boolean | null;
  job_id: string | null;
};

export type BeaconHistory = { device_id: string; hours: number; count: number; samples: BeaconSample[] };

export type JobList = {
  page: number;
  per_page: number;
  total: number;
  pages: number;
  status_counts: Record<string, number>;
  workloads: string[];
  pools: string[];
  jobs: Job[];
};

export type ResultRow = {
  device_id: string;
  iter: number;
  created_at: string | null;
  payload: Record<string, any>;
};

export type JobDetail = Job & {
  spec: Record<string, any>;
  parent: string | null;
  children: Job[];
  siblings: Job[];
  results: ResultRow[];
  beacons: (BeaconSample & { device_id: string })[];
  artifacts: {
    sha256: string;
    name: string | null;
    size: number | null;
    created_at: string | null;
    in_store: boolean;
    role: "input" | "output";
  }[];
  locks: { device_id: string; acquired_at: string | null }[];
  status_report: { target: string; state: string; posted: boolean; detail: string | null; created_at: string | null } | null;
  derived_timeline: { at: string | null; what: string }[];
};

export type RecentResults = {
  results: {
    job_id: string;
    device_id: string;
    iter: number;
    workload: string;
    final: boolean;
    ok: boolean;
    created_at: string | null;
    age_s: number;
    summary: string;
  }[];
};

export type Locks = { locks: { device_id: string; job_id: string; acquired_at: string | null; held_s: number }[] };

export type Health = {
  ok: boolean;
  instance: string;
  started_at: string;
  uptime_s: number;
  now: string;
  node: string;
  pid: number;
  stream_clients: number;
  guard: boolean;
};
