// Inline stroke icons on a 16 grid, from the dashboard's asset sheet.
//
// Every icon is currentColor, so it takes the colour of the text it sits
// beside and needs no theme rule of its own — and every icon sits next to its
// word, never instead of it: the pills, battery and workload cells still read
// as text, the icon only makes them faster to scan.
import type { ComponentChildren } from "preact";

const PATHS = {
  phone: (
    <>
      <rect x="4.25" y="1.75" width="7.5" height="12.5" rx="1.75" />
      <path d="M7 12h2" />
    </>
  ),
  // Dashed outline: a phone that is not really there.
  simulator: (
    <>
      <rect x="4.25" y="1.75" width="7.5" height="12.5" rx="1.75" stroke-dasharray="2 1.6" />
      <path d="M7 12h2" />
    </>
  ),
  host: (
    <>
      <rect x="2.75" y="3.25" width="10.5" height="7.5" rx="1.25" />
      <path d="M1.5 12.75h13" />
    </>
  ),
  online: (
    <>
      <circle cx="8" cy="8" r="2" />
      <path d="M4.1 11.9a5.5 5.5 0 0 1 0-7.8M11.9 4.1a5.5 5.5 0 0 1 0 7.8" />
    </>
  ),
  stale: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 4.5V8l2.5 1.5" />
    </>
  ),
  offline: (
    <>
      <circle cx="8" cy="8" r="2" />
      <path d="M4.1 11.9a5.5 5.5 0 0 1 0-7.8M11.9 4.1a5.5 5.5 0 0 1 0 7.8" />
      <path d="M2.5 13.5l11-11" />
    </>
  ),
  busy: <path d="M5 3.25v9.5l7.5-4.75z" />,
  charging: <path d="M9 1.75L3.75 9h4l-.75 5.25L12.25 7h-4z" />,
  thermal: (
    <>
      <path d="M6 9.4V3.25a2 2 0 0 1 4 0V9.4a3 3 0 1 1-4 0z" />
      <path d="M8 7v3.5" />
    </>
  ),
  stopwatch: (
    <>
      <circle cx="8" cy="9.25" r="4.75" />
      <path d="M8 9.25V6.5M6.25 1.75h3.5M12.25 4.75l1 1" />
    </>
  ),
  heartbeat: (
    <>
      <path d="M1.75 8h3l1.5-3.5L9 11.5l1.5-3.5h3.75" />
    </>
  ),
  install: (
    <>
      <path d="M8 2v8M4.5 6.5L8 10l3.5-3.5" />
      <path d="M2.5 11.5v1.25a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V11.5" />
    </>
  ),
  uitest: <path d="M2.75 4.5l1.5 1.5 3-3M2.75 10.5l1.5 1.5 3-3M9.5 4.75h4M9.5 10.75h4" />,
  benchmark: (
    <>
      <path d="M2.5 11.5a6 6 0 1 1 11 0" />
      <path d="M8 11.5l3-4" />
      <circle cx="8" cy="11.5" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  batch: (
    <>
      <path d="M8 2.5l6 3-6 3-6-3z" />
      <path d="M2 8.5l6 3 6-3M2 11.5l6 3 6-3" />
    </>
  ),
  visual: (
    <>
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
      <path d="M8 2.75v10.5" stroke-dasharray="1.6 1.6" />
    </>
  ),
  soak: (
    <>
      <rect x="1.75" y="4.75" width="10.5" height="6.5" rx="1.5" />
      <path d="M13.25 7v2M4 7v2M6.5 7v2" />
    </>
  ),
  audit: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M1.75 8h12.5M8 1.75c2 2 2 10.5 0 12.5M8 1.75c-2 2-2 10.5 0 12.5" />
    </>
  ),
  // Three stages, left to right, joined: a pipeline is stages in an order.
  pipeline: (
    <>
      <rect x="1.75" y="5.75" width="3.5" height="4.5" rx="1" />
      <rect x="6.25" y="5.75" width="3.5" height="4.5" rx="1" />
      <rect x="10.75" y="5.75" width="3.5" height="4.5" rx="1" />
      <path d="M5.25 8h1M9.75 8h1" />
    </>
  ),
  archive: (
    <>
      <rect x="1.75" y="2.75" width="12.5" height="3" rx="1" />
      <path d="M3 5.75v6.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-6.5" />
      <path d="M6.5 8.75h3" />
    </>
  ),
  digest: (
    <>
      <path d="M4.25 1.75h5l3 3v8.5a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1V2.75a1 1 0 0 1 1-1z" />
      <path d="M9.25 1.75v3h3" />
      <path d="M6 8h4M6 10.5h4" />
    </>
  ),
} satisfies Record<string, ComponentChildren>;

export type IconName = keyof typeof PATHS;

/** A 16-grid stroke icon. Decorative unless given a title, in which case it
 *  is announced — use a title only when the icon carries meaning the text
 *  beside it does not (the charging bolt). */
export function Icon({ name, size = 14, title }: { name: IconName; size?: number; title?: string }) {
  return (
    <svg
      class="icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      {PATHS[name]}
    </svg>
  );
}

/** The Fleet Runner glyph: the pulse from the launcher mark, on its ink
 *  square. This is the under-24px form of the mark, the same drawing as
 *  public/favicon.svg — the tile carries its ink as an attribute, so it is
 *  right with no stylesheet at all, and style.css lifts it on the dark shell
 *  where ink on near-ink would leave the pulse floating with no square.
 *  Decorative: the wordmark beside it says the name. */
export function Glyph({ size = 20 }: { size?: number }) {
  return (
    <svg class="glyph" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <rect class="tile" width="16" height="16" rx="3.5" fill="#1c2025" />
      <path
        d="M3 8.5h2.2l1.4-4 2.4 8 1.5-4H13"
        fill="none"
        stroke="#e3a44a"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

/** Which icon a workload gets. Covers every workload the collector accepts
 *  (WORKLOADS in src/server.ts); anything else shows its name alone, because a
 *  wrong icon would be worse than none. */
const WORKLOAD_ICON: Record<string, IconName> = {
  install: "install",
  "ui-test": "uitest",
  "web-test": "uitest",
  benchmark: "benchmark",
  batch: "batch",
  soak: "soak",
  drain: "soak",
  "web-shots": "visual",
  "web-audit": "audit",
  "web-unfurl": "audit",
  pipeline: "pipeline",
  archive: "archive",
  digest: "digest",
  thermal: "thermal",
  "cold-start": "stopwatch",
  "self-check": "heartbeat",
};

/** The workload's name with its icon, for job tables. */
export function Workload({ name, children }: { name: string; children?: ComponentChildren }) {
  const icon = WORKLOAD_ICON[name];
  return (
    <span class="with-icon">
      {icon && <Icon name={icon} />}
      {name}
      {children}
    </span>
  );
}
