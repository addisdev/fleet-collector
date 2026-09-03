// Shared presentational bits and the formatters every page needs.
import type { ComponentChildren, JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Icon, type IconName } from "./icons.js";
import { BASE, navigate, useRoute } from "./router.js";

export function Link({
  to,
  children,
  ...rest
}: { to: string; children: ComponentChildren } & JSX.HTMLAttributes<HTMLAnchorElement>) {
  const route = useRoute();
  // A nav link stays "current" whatever filters the page carries.
  const path = to.split("?")[0];
  const onClick = (e: MouseEvent) => {
    // Leave modified clicks alone: cmd-click into a new tab must still work.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a href={`${BASE}${to === "/" ? "" : to}`} onClick={onClick} aria-current={route === path ? "page" : undefined} {...rest}>
      {children}
    </a>
  );
}

export function Panel({ title, children, aside }: { title?: string; children: ComponentChildren; aside?: ComponentChildren }) {
  return (
    <section class="panel">
      {title && (
        <div class="panel-head">
          <h2>{title}</h2>
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, tone }: { label: string; value: ComponentChildren; tone?: "ok" | "warn" | "bad" }) {
  return (
    <div class={`stat${tone ? ` ${tone}` : ""}`}>
      <b>{value}</b>
      <small>{label}</small>
    </div>
  );
}

/* Device states get an icon; job states do not. Online/stale/offline are
   read across a whole shelf at a glance, job status is read one row at a time. */
const PILL_ICON: Partial<Record<string, IconName>> = { online: "online", stale: "stale", offline: "offline" };

export const Pill = ({ kind, children }: { kind: string; children?: ComponentChildren }) => {
  const icon = PILL_ICON[kind];
  return (
    <span class={`pill ${kind}`}>
      {icon && <Icon name={icon} size={11} />}
      {children ?? kind}
    </span>
  );
};

export function Loading({ what }: { what: string }) {
  return <p class="skeleton">Loading {what}…</p>;
}

export function ErrorBox({ error }: { error: Error }) {
  return <p class="error">{error.message}</p>;
}

export const Empty = ({ children }: { children: ComponentChildren }) => <p class="empty">{children}</p>;

/** Renders the three states every fetched panel has, so no page reimplements them. */
export function Loaded<T>({
  state,
  what,
  children,
}: {
  state: { data: T | null; error: Error | null; loading: boolean };
  what: string;
  children: (data: T) => ComponentChildren;
}) {
  if (state.error) return <ErrorBox error={state.error} />;
  if (!state.data) return state.loading ? <Loading what={what} /> : <Empty>No {what}.</Empty>;
  return <>{children(state.data)}</>;
}

// --- formatters ---

/** Compact duration: the dashboard is read at a glance, so "3h 12m", not "3:12:44". */
export function duration(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  const s = Math.abs(Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

export function ago(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  return seconds < 5 ? "just now" : `${duration(seconds)} ago`;
}

export function agoFrom(iso: string | null | undefined): string {
  if (!iso) return "—";
  return ago((Date.now() - new Date(iso).getTime()) / 1000);
}

export function bytes(n: number | null | undefined): string {
  if (n == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Local wall-clock time; the fleet and its owner share a timezone. */
export function clock(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export const short = (id: string, max = 34) => (id.length <= max ? id : `${id.slice(0, max - 1)}…`);

/** Round for reading, not for precision: benchmark tables want 47.4, not
 *  47.38271604938272. Never applied to a stored value, only to its display. */
export function num(v: unknown, digits = 1): string {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "—";
}

// --- form controls ---

export function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: (string | { value: string; label: string })[];
  onChange: (v: string) => void;
}) {
  const norm = options.map((o) => (typeof o === "string" ? { value: o, label: o } : o));
  return (
    <label class="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange((e.target as HTMLSelectElement).value)}>
        <option value="">any</option>
        {norm.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Search({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label class="field">
      <span>{label}</span>
      <input
        type="search"
        value={value}
        placeholder={placeholder}
        // Committed on Enter/blur rather than per keystroke: each change is a
        // history entry and a refetch, and neither should happen mid-word.
        onChange={(e) => onChange((e.target as HTMLInputElement).value)}
      />
    </label>
  );
}

export function Filters({ children, onClear, active }: { children: ComponentChildren; onClear?: () => void; active?: boolean }) {
  return (
    <div class="filters">
      {children}
      {active && onClear && (
        <button type="button" class="linkish" onClick={onClear}>
          clear
        </button>
      )}
    </div>
  );
}

export function Pager({ page, pages, total, onPage }: { page: number; pages: number; total: number; onPage: (p: number) => void }) {
  if (pages <= 1) return <p class="empty">{total} total</p>;
  return (
    <div class="pager">
      <button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        ← prev
      </button>
      <span class="dim">
        page {page} of {pages} · {total} total
      </span>
      <button type="button" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        next →
      </button>
    </div>
  );
}

/** Collapsed by default: a job spec is reference material, not the first thing
 *  you need to see on the page. */
export function Json({ value, label = "JSON", open = false }: { value: unknown; label?: string; open?: boolean }) {
  return (
    <details class="json" open={open}>
      <summary>{label}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

export function Button({
  children,
  onClick,
  tone,
  busy,
  disabled,
  title,
}: {
  children: ComponentChildren;
  onClick: () => void;
  tone?: "danger" | "primary";
  busy?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button type="button" class={`btn${tone ? ` ${tone}` : ""}`} onClick={onClick} disabled={busy || disabled} title={title}>
      {busy ? "…" : children}
    </button>
  );
}

/**
 * A two-step button. Destructive actions get a deliberate second click rather
 * than a modal: the confirm state names what will happen, and wanders off after
 * a few seconds so a half-pressed cancel does not sit armed on a shared screen.
 */
export function ConfirmButton({
  children,
  confirm,
  onConfirm,
  tone = "danger",
  busy,
  disabled,
}: {
  children: ComponentChildren;
  confirm: string;
  onConfirm: () => void;
  tone?: "danger" | "primary";
  busy?: boolean;
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 6000);
    return () => clearTimeout(t);
  }, [armed]);

  if (!armed)
    return (
      <Button tone={tone} onClick={() => setArmed(true)} busy={busy} disabled={disabled}>
        {children}
      </Button>
    );
  return (
    <span class="confirm">
      <Button
        tone={tone}
        busy={busy}
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
      >
        {confirm}
      </Button>
      <button type="button" class="linkish" onClick={() => setArmed(false)}>
        cancel
      </button>
    </span>
  );
}

export const Actions = ({ children }: { children: ComponentChildren }) => <div class="actions">{children}</div>;

export function Field({ label, hint, children }: { label: string; hint?: string; children: ComponentChildren }) {
  return (
    <label class="field wide">
      <span>{label}</span>
      {children}
      {hint && <small class="faint">{hint}</small>}
    </label>
  );
}

/**
 * A device, by name.
 *
 * One name, not a name and an id stacked together. The id is still what job
 * specs pin and what `adb devices` prints, so it stays available on hover and
 * on the device's own page — but a list of machines should read like a list of
 * machines.
 */
export function DeviceName({ id, names, link = true }: { id: string; names: Record<string, string>; link?: boolean }) {
  const named = names[id];
  const body = named ? <span>{named}</span> : <code>{id}</code>;
  return link ? (
    <Link to={`/devices/${encodeURIComponent(id)}`} title={id}>
      {body}
    </Link>
  ) : (
    <span title={id}>{body}</span>
  );
}

export function CopyId({ text }: { text: string }) {
  return (
    <button
      type="button"
      class="linkish"
      title="Copy to clipboard"
      onClick={() => void navigator.clipboard?.writeText(text)}
    >
      copy
    </button>
  );
}
