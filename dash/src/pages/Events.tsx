// The pipeline rails. Topics, throughput, and a tail of what is flowing —
// enough to watch a tiered pipeline actually work rather than infer it from
// the jobs that consume it.
import { useApi } from "../api.js";
import { useQuery } from "../router.js";
import { Json, Loaded, Panel, agoFrom, clock } from "../ui.js";

type Topic = { topic: string; count: number; last_id: number; last_at: string | null };
type Event = { id: number; created_at: string | null; payload: Record<string, unknown> };

export function Events() {
  const [q, setQuery] = useQuery();
  const selected = q.get("topic") ?? "";

  const topics = useApi<{ topics: Topic[] }>("/api/events", ["pipeline-event"], 30_000);
  const tail = useApi<{ topic: string; events: Event[] }>(
    selected ? `/api/events/${encodeURIComponent(selected)}?limit=50` : null,
    ["pipeline-event"],
    20_000,
  );

  return (
    <>
      <h1>Events</h1>
      <Loaded state={topics} what="topics">
        {(d) =>
          d.topics.length === 0 ? (
            <Panel>
              <p class="empty">
                No topics yet. Pipeline jobs publish to a topic and their output lands on <code>&lt;topic&gt;.out</code>.
              </p>
            </Panel>
          ) : (
            <Panel title={`Topics (${d.topics.length})`}>
              <div class="scroll">
                <table>
                  <tr>
                    <th>Topic</th>
                    <th class="right">Events</th>
                    <th>Last</th>
                    <th></th>
                  </tr>
                  {d.topics.map((t) => (
                    <tr key={t.topic}>
                      <td>
                        <code>{t.topic}</code>
                      </td>
                      <td class="num">{t.count}</td>
                      <td class="dim">{agoFrom(t.last_at)}</td>
                      <td class="right">
                        <button
                          type="button"
                          class={`linkish${selected === t.topic ? " on" : ""}`}
                          onClick={() => setQuery({ topic: selected === t.topic ? null : t.topic })}
                        >
                          {selected === t.topic ? "hide" : "tail"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </table>
              </div>
            </Panel>
          )
        }
      </Loaded>

      {selected && (
        <Loaded state={tail} what={`events on ${selected}`}>
          {(d) => (
            <Panel title={`${selected} — newest first`}>
              {d.events.length === 0 ? (
                <p class="empty">No events on this topic.</p>
              ) : (
                d.events.map((e) => (
                  <div class="event-row" key={e.id}>
                    <span class="faint mono">#{e.id}</span> <span class="dim">{clock(e.created_at)}</span>
                    <Json value={e.payload} label="payload" />
                  </div>
                ))
              )}
            </Panel>
          )}
        </Loaded>
      )}
    </>
  );
}
