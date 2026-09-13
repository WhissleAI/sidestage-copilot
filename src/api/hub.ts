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
  | "shows" | "show" | "source"
  // Host speech from the listen-only Whissle session, with its voice metadata.
  | "transcript";

interface Client {
  id: number;
  reply: FastifyReply;
  /** Only events for this show reach this client. */
  showId: string;
}

export class EventHub {
  private clients = new Map<number, Client>();
  private nextId = 1;

  add(reply: FastifyReply, showId: string): number {
    const id = this.nextId++;
    this.clients.set(id, { id, reply, showId });
    return id;
  }

  remove(id: number): void {
    this.clients.delete(id);
  }

  get size(): number {
    return this.clients.size;
  }

  /**
   * Emit one named event to the consoles watching the show it came from.
   *
   * Filtering here rather than in the client is deliberate: several shows can be
   * watched at once, and a console that received every show's chat would render
   * two auctions interleaved into one queue. `shows` is the one event everyone
   * gets, because it is the switcher's data.
   *
   * A write to a socket the client already abandoned throws; drop that client
   * rather than let one dead connection break the broadcast for everyone else.
   */
  emit(event: EventName, data: unknown): void {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const from = (data as { showId?: string } | null)?.showId;
    for (const [id, c] of this.clients) {
      if (event !== "shows" && from && from !== c.showId) continue;
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
