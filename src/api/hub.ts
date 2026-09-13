// SSE fan-out.
//
// Server-sent events rather than a WebSocket, for three reasons that matter here:
// the traffic is one-directional (commands go over plain REST, which is
// curl-able and therefore reviewable), EventSource reconnects on its own, and a
// dropped connection cannot lose a command — only events, which the next `hello`
// replaces wholesale.

import type { FastifyReply } from "fastify";

export type EventName =
  | "hello" | "chat" | "proposal" | "action" | "listing" | "audit" | "metrics" | "context"
  // Multi-show additions. Every payload above now also carries `showId`, so a
  // console can watch one show or all of them from a single stream.
  | "shows" | "show" | "source";

interface Client {
  id: number;
  reply: FastifyReply;
}

export class EventHub {
  private clients = new Map<number, Client>();
  private nextId = 1;

  add(reply: FastifyReply): number {
    const id = this.nextId++;
    this.clients.set(id, { id, reply });
    return id;
  }

  remove(id: number): void {
    this.clients.delete(id);
  }

  get size(): number {
    return this.clients.size;
  }

  /** Emit one named event to every connected console. A write to a socket the
   *  client already abandoned throws; drop that client rather than let one dead
   *  connection break the broadcast for everyone else. */
  emit(event: EventName, data: unknown): void {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const [id, c] of this.clients) {
      try {
        c.reply.raw.write(frame);
      } catch {
        this.clients.delete(id);
      }
    }
  }

  /** Keep intermediaries from closing an idle stream. */
  heartbeat(): void {
    for (const [id, c] of this.clients) {
      try {
        c.reply.raw.write(": ping\n\n");
      } catch {
        this.clients.delete(id);
      }
    }
  }
}
