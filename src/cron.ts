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

/** The dedup key: schedules fire at most once per matching minute. */
export function minuteKey(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`;
}
