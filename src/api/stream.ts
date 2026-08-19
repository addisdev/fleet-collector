// Server-sent events: the dashboard's live channel.
//
// Why SSE and not WebSockets — the traffic is one-directional (collector →
// browser), it survives proxies and Tailscale without an upgrade handshake, and
// the browser reconnects on its own. Mutations still go over plain HTTP.
//
// Every table the dashboard reads has exactly one write path in server.ts, so
// each of those calls publish() after its write commits. Nothing polls.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export type FleetEvent = { type: string; [k: string]: unknown };

// The collector runs on a 2016 MacBook whose real job is serving long-polls to
// the fleet. A stuck browser tab must never cost more than one socket, and the
// dashboard is a single-operator tool — a cap this low is a safety net, not a
// limit anyone should reach.
const MAX_CLIENTS = 20;
// Under the 30 s most proxies use as an idle timeout, and under Tailscale's.
const HEARTBEAT_MS = 25_000;

type Client = { id: number; reply: FastifyReply };

const clients = new Set<Client>();
let nextId = 1;

/** Server identity: a changed value means the collector restarted, so the
 *  dashboard knows to refetch rather than trust the state it accumulated. */
export const SERVER_INSTANCE = `${process.pid}-${Date.now()}`;
export const STARTED_AT = new Date();

function write(client: Client, event: string, data: unknown) {
  try {
    client.reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    drop(client);
  }
}

function drop(client: Client) {
  clients.delete(client);
  try {
    client.reply.raw.end();
  } catch {
    /* already gone */
  }
}

/** Fan an event out to every connected dashboard. Never throws: a broken pipe
 *  to a closed tab must not fail the write path that published the event. */
export function publish(event: FleetEvent) {
  if (clients.size === 0) return;
  for (const client of [...clients]) write(client, event.type, { ...event, at: new Date().toISOString() });
}

export function clientCount() {
  return clients.size;
}

export function registerStream(app: FastifyInstance) {
  app.get("/api/stream", async (req: FastifyRequest, reply: FastifyReply) => {
    if (clients.size >= MAX_CLIENTS)
      return reply.code(503).send({ error: `too many stream clients (${MAX_CLIENTS})` });

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // nginx and friends buffer text/event-stream into uselessness otherwise.
      "x-accel-buffering": "no",
    });

    const client: Client = { id: nextId++, reply };
    clients.add(client);
    // Retry hint for the browser's own reconnect logic, then the handshake.
    reply.raw.write("retry: 3000\n\n");
    write(client, "hello", {
      type: "hello",
      instance: SERVER_INSTANCE,
      started_at: STARTED_AT.toISOString(),
      at: new Date().toISOString(),
    });

    const beat = setInterval(() => {
      // A comment line: keeps the socket warm without waking the EventSource
      // handlers in the page.
      try {
        reply.raw.write(`: ping ${Date.now()}\n\n`);
      } catch {
        drop(client);
      }
    }, HEARTBEAT_MS);
    beat.unref();

    const close = () => {
      clearInterval(beat);
      clients.delete(client);
    };
    req.raw.on("close", close);
    req.raw.on("error", close);

    // Hand the socket to us: Fastify must not try to serialize a reply.
    reply.hijack();
  });
}
