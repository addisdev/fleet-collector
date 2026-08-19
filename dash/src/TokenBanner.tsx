// Shown when the collector requires a dashboard token and this browser has not
// been given one.
//
// The alternative is what happened before it existed: you click something
// ordinary, like renaming a device, and get a 401 naming an HTTP header. The
// requirement is knowable up front — /api/health reports it — so say so up
// front, and take the token right here rather than sending someone to another
// screen to find the field.
import { useState } from "preact/hooks";
import { useApi, type Health } from "./api.js";
import { useToken } from "./mutate.js";

export function TokenBanner() {
  const health = useApi<Health>("/api/health", [], 0);
  const [token, setToken] = useToken();
  const [draft, setDraft] = useState("");

  // Silent unless the collector actually wants a token and we lack one.
  if (!health.data?.guard || token) return null;

  return (
    <div class="banner warning token-banner">
      <span>
        This collector requires a token before anything can be changed — renaming a device, cancelling a job, editing a
        schedule. Reads work without it.
      </span>
      <form
        class="token-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) setToken(draft.trim());
        }}
      >
        <input
          type="password"
          value={draft}
          placeholder="paste FLEET_DASH_TOKEN"
          onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
        />
        <button type="submit" class="btn" disabled={!draft.trim()}>
          Save
        </button>
      </form>
    </div>
  );
}
