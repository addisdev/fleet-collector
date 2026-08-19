// Minimal 5-field cron matcher: minute hour day-of-month month day-of-week.
// Supports *, numbers, lists (a,b), ranges (a-b), and steps (*/n, a-b/n).
// No deps, evaluated against local time — the fleet and its owner share a
// timezone; revisit if the collector ever moves off the home Mac.

const BOUNDS: [number, number][] = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6], // day of week (0 = Sunday)
];

function fieldMatches(field: string, value: number, index: number): boolean {
  return field.split(",").some((part) => {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart !== undefined ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step < 1) return false;

    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      [lo, hi] = BOUNDS[index];
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-").map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b)) return false;
      [lo, hi] = [a, b];
    } else {
      const n = Number(rangePart);
      if (!Number.isInteger(n)) return false;
      if (stepPart === undefined) return value === n;
      [lo, hi] = [n, BOUNDS[index][1]];
    }
    return value >= lo && value <= hi && (value - lo) % step === 0;
  });
}

export function isValidCron(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  return (
    fields.length === 5 &&
    fields.every((f, i) => /^[\d*,/-]+$/.test(f) && fieldMatches(f, BOUNDS[i][0], i) !== undefined)
  );
}

export function cronMatches(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const values = [
    date.getMinutes(),
    date.getHours(),
    date.getDate(),
    date.getMonth() + 1,
    date.getDay(),
  ];
  return fields.every((field, i) => fieldMatches(field, values[i], i));
}

// Walking minute by minute is the honest way to answer "when next?" for an
// expression this permissive (day-of-month and day-of-week both matching is a
// real case), and 7 days of minutes is ~10k cheap comparisons. Schedules rarer
// than weekly report null rather than making the dashboard scan a year.
const HORIZON_MINUTES = 7 * 24 * 60;

function walk(expr: string, from: Date, step: 1 | -1): Date | null {
  if (!isValidCron(expr)) return null;
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  for (let i = 0; i < HORIZON_MINUTES; i++) {
    d.setMinutes(d.getMinutes() + step);
    if (cronMatches(expr, d)) return new Date(d.getTime());
  }
  return null;
}

/** The next minute at or after `from` when this schedule fires. */
export const nextRun = (expr: string, from = new Date()) => walk(expr, from, 1);

/** The most recent minute before `from` when it should have fired — what a
 *  missed-schedule check compares `last_run` against. */
export const prevRun = (expr: string, from = new Date()) => walk(expr, from, -1);

/** The dedup key: schedules fire at most once per matching minute. */
export function minuteKey(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`;
}
