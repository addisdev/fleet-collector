import { useLiveState } from "./live.js";
import { match, useRoute } from "./router.js";
import { Link, Panel } from "./ui.js";
import { Compose } from "./pages/Compose.js";
import { DeviceDetail } from "./pages/DeviceDetail.js";
import { Devices } from "./pages/Devices.js";
import { JobDetail } from "./pages/JobDetail.js";
import { Jobs } from "./pages/Jobs.js";
import { Overview } from "./pages/Overview.js";
import { Schedules } from "./pages/Schedules.js";
import { Results } from "./pages/Results.js";
import { STUBS, Stub } from "./pages/Stub.js";
import { System } from "./pages/System.js";

const NAV = [
  ["/", "Overview"],
  ["/devices", "Devices"],
  ["/jobs", "Jobs"],
  ["/results", "Results"],
  ["/schedules", "Schedules"],
  ["/artifacts", "Artifacts"],
  ["/events", "Events"],
  ["/system", "System"],
] as const;

const LIVE_LABEL: Record<string, string> = {
  live: "live",
  connecting: "connecting",
  down: "offline",
};

function LiveDot() {
  const state = useLiveState();
  return (
    <span
      class={`live ${state}`}
      title={
        state === "live"
          ? "Streaming updates from the collector"
          : "Not receiving updates — the collector may be restarting"
      }
    >
      <i />
      {LIVE_LABEL[state]}
    </span>
  );
}

function NotFound({ route }: { route: string }) {
  return (
    <>
      <h1>Not found</h1>
      <Panel>
        <p class="stub">
          No dashboard route at <code>{route}</code>. <Link to="/">Back to the overview</Link>.
        </p>
      </Panel>
    </>
  );
}

function Router() {
  const route = useRoute();

  if (match("/", route)) return <Overview />;
  if (match("/system", route)) return <System />;
  if (match("/devices", route)) return <Devices />;
  if (match("/jobs", route)) return <Jobs />;
  // Before /jobs/:id, or "new" would be read as a job id.
  if (match("/jobs/new", route)) return <Compose />;
  if (match("/results", route)) return <Results />;
  if (match("/schedules", route)) return <Schedules />;

  // Keyed on the id so switching between two detail pages remounts rather than
  // showing the previous device's charts under the new device's name.
  const device = match("/devices/:id", route);
  if (device) return <DeviceDetail key={device.id} id={device.id} />;
  const job = match("/jobs/:id", route);
  if (job) return <JobDetail key={job.id} id={job.id} />;

  for (const [path, key] of [
    ["/artifacts", "artifacts"],
    ["/events", "events"],
    ["/events/:topic", "events"],
  ] as const) {
    if (match(path, route)) return <Stub spec={STUBS[key]} />;
  }

  return <NotFound route={route} />;
}

export function App() {
  return (
    <div class="shell">
      <header class="topbar">
        <span class="brand">
          Fleet Runner <span>collector</span>
        </span>
        <nav class="nav">
          {NAV.map(([to, label]) => (
            <Link key={to} to={to}>
              {label}
            </Link>
          ))}
        </nav>
        <LiveDot />
      </header>
      <main>
        <Router />
      </main>
      <footer class="footer">
        <a href="/dash/legacy">legacy dashboard</a>
        <a href="/api/overview">/api/overview</a>
        <a href="/api/health">/api/health</a>
        <span>D3 — results</span>
      </footer>
    </div>
  );
}
