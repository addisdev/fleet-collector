// A ~40-line History API router. The dashboard has eight routes and no need
// for nested layouts, loaders, or transitions.
import { useEffect, useState } from "preact/hooks";

export const BASE = "/dash";
const NAV = "fleet:navigate";

/** Path relative to /dash, always starting with "/" ("/", "/jobs", "/jobs/x"). */
export function currentRoute(): string {
  const p = location.pathname;
  const rel = p.startsWith(BASE) ? p.slice(BASE.length) : p;
  return rel === "" ? "/" : rel;
}

/** `to` may carry a query string ("/jobs?status=failed"); it replaces the
 *  current one wholesale, so a link never inherits the previous page's filters. */
export function navigate(to: string, replace = false) {
  const url = to.startsWith(BASE) ? to : `${BASE}${to === "/" ? "" : to}`;
  if (url === location.pathname + location.search) return;
  history[replace ? "replaceState" : "pushState"]({}, "", url);
  dispatchEvent(new Event(NAV));
  if (!replace) scrollTo(0, 0);
}

function useLocationChange(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const on = () => setN((x) => x + 1);
    addEventListener("popstate", on);
    addEventListener(NAV, on);
    return () => {
      removeEventListener("popstate", on);
      removeEventListener(NAV, on);
    };
  }, []);
  return n;
}

export function useRoute(): string {
  useLocationChange();
  return currentRoute();
}

/**
 * Filters live in the URL, not in component state — so a filtered view is a
 * link you can send, bookmark, or reload without losing it, and the back
 * button walks filter changes the way it walks pages.
 */
export function useQuery(): [URLSearchParams, (patch: Record<string, string | null>, replace?: boolean) => void] {
  useLocationChange();
  const params = new URLSearchParams(location.search);

  const setQuery = (patch: Record<string, string | null>, replace = true) => {
    const next = new URLSearchParams(location.search);
    for (const [k, v] of Object.entries(patch)) {
      // Empty means "no filter", and an empty key in the URL is just noise.
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    // Any filter change invalidates the page number you were on.
    if (!("page" in patch)) next.delete("page");
    const qs = next.toString();
    navigate(`${currentRoute()}${qs ? `?${qs}` : ""}`, replace);
  };

  return [params, setQuery];
}

/** Match "/jobs/:id" against the current route; returns params or null. */
export function match(pattern: string, route: string): Record<string, string> | null {
  const p = pattern.split("/").filter(Boolean);
  const r = route.split("/").filter(Boolean);
  if (p.length !== r.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(":")) params[p[i].slice(1)] = decodeURIComponent(r[i]);
    else if (p[i] !== r[i]) return null;
  }
  return params;
}
