// A minimal SVG time-series chart.
//
// No charting library: this draws one line, one shaded band set, and an axis.
// uPlot earns its ~40 KB in D3 where thousands of benchmark points need
// panning; a day of 60 s beacons is ~1.4 k points and renders fine as a path.
// Colors come from CSS classes so the chart follows the theme.
import type { ComponentChildren } from "preact";

export type Point = { t: number; v: number | null };

/** A battery series is a continuous signal, so a stretch with no samples must
 *  break the line rather than draw a slope nobody measured. Shared so the device
 *  chart and the drain chart cannot drift apart on what counts as a gap. */
export const BATTERY_GAP_MS = 10 * 60 * 1000;

const W = 800;
const H = 170;
const PAD = { top: 10, right: 8, bottom: 20, left: 30 };

const hhmm = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/** Build an SVG path, breaking the line at gaps rather than drawing a straight
 *  line across hours when a device was off — a fabricated segment would read as
 *  a measurement. */
function linePath(points: Point[], x: (t: number) => number, y: (v: number) => number, gapMs: number): string {
  let d = "";
  let pen = false;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.v == null) {
      pen = false;
      continue;
    }
    const gap = i > 0 && p.t - points[i - 1].t > gapMs;
    if (!pen || gap) {
      d += `M${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`;
      pen = true;
    } else {
      d += `L${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`;
    }
  }
  return d;
}

/** Contiguous [start, end] runs where `flag` holds — used to shade the periods
 *  a device was on the charger, which is what explains a rising battery curve. */
export function runs<T>(items: T[], t: (x: T) => number, flag: (x: T) => boolean): [number, number][] {
  const out: [number, number][] = [];
  let start: number | null = null;
  for (let i = 0; i < items.length; i++) {
    const on = flag(items[i]);
    if (on && start === null) start = t(items[i]);
    if (!on && start !== null) {
      out.push([start, t(items[i])]);
      start = null;
    }
  }
  if (start !== null && items.length) out.push([start, t(items[items.length - 1])]);
  return out;
}

export function TimeSeries({
  points,
  bands = [],
  domain,
  yMin = 0,
  yMax = 100,
  unit = "",
  gapMs = BATTERY_GAP_MS,
  children,
}: {
  points: Point[];
  bands?: [number, number][];
  domain?: [number, number];
  yMin?: number;
  yMax?: number;
  unit?: string;
  gapMs?: number;
  children?: ComponentChildren;
}) {
  const real = points.filter((p) => p.v != null);
  if (real.length === 0) return <p class="empty">No samples in this window.</p>;

  const [t0, t1] = domain ?? [points[0].t, points[points.length - 1].t];
  const span = Math.max(1, t1 - t0);
  const x = (t: number) => PAD.left + ((t - t0) / span) * (W - PAD.left - PAD.right);
  const y = (v: number) =>
    PAD.top + (1 - (Math.max(yMin, Math.min(yMax, v)) - yMin) / (yMax - yMin)) * (H - PAD.top - PAD.bottom);

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => t0 + f * span);
  const yTicks = [yMin, (yMin + yMax) / 2, yMax];

  return (
    <div class="chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img">
        {bands.map(([a, b]) => (
          <rect key={`${a}-${b}`} class="chart-band" x={x(a)} y={PAD.top} width={Math.max(1, x(b) - x(a))} height={H - PAD.top - PAD.bottom} />
        ))}
        {yTicks.map((v) => (
          <g key={v}>
            <line class="chart-grid" x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} />
            <text class="chart-label" x={PAD.left - 5} y={y(v) + 3} text-anchor="end">
              {v}
            </text>
          </g>
        ))}
        {ticks.map((t, i) => (
          <text
            key={t}
            class="chart-label"
            x={x(t)}
            y={H - 6}
            text-anchor={i === 0 ? "start" : i === ticks.length - 1 ? "end" : "middle"}
          >
            {hhmm(t)}
          </text>
        ))}
        <path class="chart-line" d={linePath(points, x, y, gapMs)} />
      </svg>
      <div class="chart-legend">
        {children}
        <span class="faint">
          {real.length} samples{unit ? ` · ${unit}` : ""}
        </span>
      </div>
    </div>
  );
}

/** Horizontal bars for comparing one measurement across devices. Horizontal
 *  because device ids are long: vertical bars would need rotated labels. */
export function Bars({
  items,
  unit = "",
  digits = 1,
}: {
  items: { label: string; value: number | null; note?: string; muted?: boolean }[];
  unit?: string;
  digits?: number;
}) {
  const real = items.filter((i) => typeof i.value === "number") as { label: string; value: number }[];
  if (real.length === 0) return <p class="empty">Nothing to compare yet.</p>;
  const max = Math.max(...real.map((i) => i.value), 0) || 1;

  return (
    <div class="bars">
      {items.map((i) => (
        <div class={`bar-row${i.muted ? " muted" : ""}`} key={i.label}>
          <span class="bar-label mono" title={i.label}>
            {i.label}
          </span>
          <span class="bar-track">
            <i style={{ width: `${typeof i.value === "number" ? Math.max(0.5, (i.value / max) * 100) : 0}%` }} />
          </span>
          <span class="bar-value">
            {typeof i.value === "number" ? i.value.toFixed(digits) : "—"}
            {unit && typeof i.value === "number" ? ` ${unit}` : ""}
            {i.note && <span class="faint"> {i.note}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

const SERIES_CLASSES = ["s0", "s1", "s2", "s3", "s4", "s5"];

/** Several lines on shared axes — benchmark trends over time, or two drain runs
 *  overlaid. Each series breaks on gaps for the same reason a single one does. */
export function MultiSeries({
  series,
  yMax,
  yMin = 0,
  unit = "",
  gapMs = Number.POSITIVE_INFINITY,
}: {
  series: { name: string; points: Point[]; muted?: boolean }[];
  yMax?: number;
  yMin?: number;
  unit?: string;
  gapMs?: number;
}) {
  const all = series.flatMap((s) => s.points).filter((p) => p.v != null) as { t: number; v: number }[];
  if (all.length === 0) return <p class="empty">No data in this view.</p>;

  const t0 = Math.min(...all.map((p) => p.t));
  const t1 = Math.max(...all.map((p) => p.t));
  // Headroom above the tallest point so a peak is not clipped by the axis.
  const top = yMax ?? (Math.max(...all.map((p) => p.v)) * 1.1 || 1);
  const span = Math.max(1, t1 - t0);
  const x = (t: number) => PAD.left + ((t - t0) / span) * (W - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - (v - yMin) / (top - yMin)) * (H - PAD.top - PAD.bottom);
  const yTicks = [yMin, (yMin + top) / 2, top];

  return (
    <div class="chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img">
        {yTicks.map((v) => (
          <g key={v}>
            <line class="chart-grid" x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} />
            <text class="chart-label" x={PAD.left - 5} y={y(v) + 3} text-anchor="end">
              {v.toFixed(top < 10 ? 1 : 0)}
            </text>
          </g>
        ))}
        {[t0, t0 + span / 2, t1].map((t, i) => (
          <text key={t} class="chart-label" x={x(t)} y={H - 6} text-anchor={i === 0 ? "start" : i === 2 ? "end" : "middle"}>
            {new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
          </text>
        ))}
        {series.map((s, i) => (
          <g key={s.name}>
            <path class={`chart-line ${SERIES_CLASSES[i % SERIES_CLASSES.length]}${s.muted ? " muted" : ""}`} d={linePath(s.points, x, y, gapMs)} />
            {/* A single sample has no line to draw, so mark the point itself —
                otherwise a device that ran once looks like it never ran. */}
            {s.points.filter((p) => p.v != null).length === 1 &&
              s.points
                .filter((p) => p.v != null)
                .map((p) => <circle key={p.t} class={`chart-dot ${SERIES_CLASSES[i % SERIES_CLASSES.length]}`} cx={x(p.t)} cy={y(p.v!)} r={3} />)}
          </g>
        ))}
      </svg>
      <div class="chart-legend">
        {series.map((s, i) => (
          <span class="chart-key" key={s.name}>
            <i class={`swatch ${SERIES_CLASSES[i % SERIES_CLASSES.length]}`} />
            <span class={s.muted ? "faint" : ""}>{s.name}</span>
          </span>
        ))}
        {unit && <span class="faint">{unit}</span>}
      </div>
    </div>
  );
}

// The shared thermal enum, worst last. The runners map every platform's native
// state onto these four so a strip like this is comparable across the fleet.
const THERMAL = ["nominal", "fair", "serious", "critical"];

/** A horizontal strip of thermal state over time — a curve, not a single
 *  state, which is the whole point of sampling it. */
export function ThermalStrip({
  samples,
  domain,
  gapMs = 10 * 60 * 1000,
}: {
  samples: { t: number; thermal: string | null }[];
  domain: [number, number];
  gapMs?: number;
}) {
  const known = samples.filter((s) => s.thermal && THERMAL.includes(s.thermal));
  if (known.length === 0) return <p class="empty">No thermal samples in this window.</p>;

  const [t0, t1] = domain;
  const span = Math.max(1, t1 - t0);
  const pct = (t: number) => ((t - t0) / span) * 100;

  // Collapse consecutive equal states into one segment — but never across a
  // reporting gap. Painting straight through hours the device was off would
  // claim a thermal state nobody measured, which is exactly what the battery
  // line above refuses to do when it breaks on the same gap.
  const segs: { from: number; to: number; state: string }[] = [];
  for (const s of known) {
    const last = segs[segs.length - 1];
    if (last && last.state === s.thermal && s.t - last.to <= gapMs) last.to = s.t;
    else segs.push({ from: s.t, to: s.t, state: s.thermal! });
  }

  return (
    <div class="thermal">
      <div class="thermal-track">
        {segs.map((s, i) => (
          <i
            key={i}
            class={`th-${s.state}`}
            style={{ left: `${pct(s.from)}%`, width: `${Math.max(0.4, pct(s.to) - pct(s.from))}%` }}
            title={`${s.state} · ${hhmm(s.from)}–${hhmm(s.to)}`}
          />
        ))}
      </div>
      <div class="chart-legend">
        {THERMAL.map((t) => (
          <span key={t} class="thermal-key">
            <i class={`th-${t}`} /> {t}
          </span>
        ))}
      </div>
    </div>
  );
}
