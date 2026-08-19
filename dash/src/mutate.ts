// Mutating calls, and the token they may need to carry.
//
// The token lives in localStorage rather than a cookie: it is a shared secret
// for a single-operator LAN tool, and a cookie would ride along on every
// request including the ones that do not need it.
import { useEffect, useState } from "preact/hooks";
import { ApiError } from "./api.js";

const KEY = "fleet.dash.token";

export const getToken = () => localStorage.getItem(KEY) ?? "";

export function setToken(token: string) {
  if (token) localStorage.setItem(KEY, token);
  else localStorage.removeItem(KEY);
  dispatchEvent(new Event("fleet:token"));
}

export function useToken(): [string, (t: string) => void] {
  const [token, set] = useState(getToken());
  useEffect(() => {
    const on = () => set(getToken());
    addEventListener("fleet:token", on);
    return () => removeEventListener("fleet:token", on);
  }, []);
  return [token, setToken];
}

export async function mutate<T>(method: "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    method,
    headers: {
      accept: "application/json",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { "x-fleet-token": token } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (res.status === 401) {
    // Naming the missing header is true and useless. Say what to do.
    throw new ApiError(401, token
      ? "That dashboard token was rejected. Check it on the System screen."
      : "This collector needs a dashboard token — paste it in the banner above, or on the System screen.");
  }
  if (!res.ok) throw new ApiError(res.status, json.error ?? `${res.status} ${res.statusText}`);
  return json as T;
}

/**
 * Wraps one mutation with the state a button needs: in-flight, error, and the
 * result note the server sent back. Errors are surfaced, never swallowed — a
 * cancel that silently failed is worse than one that visibly did.
 */
export function useMutation<T>(run: () => Promise<T>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [result, setResult] = useState<T | null>(null);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await run());
      return true;
    } catch (e) {
      setError(e as Error);
      return false;
    } finally {
      setBusy(false);
    }
  };

  return { busy, error, result, go, reset: () => { setError(null); setResult(null); } };
}
