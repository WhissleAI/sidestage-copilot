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
  // NOT named `error`: EventSource dispatches a server event named "error" to
  // the client's own `onerror` handler, which is its transport-failure hook. A
  // console told "no show is being monitored" therefore tore down a perfectly
  // healthy stream and reconnected, forever.
  | "stream_error"
  // What this show has cost against the seller's cap, and whether the cap has
  // stopped the copilot. Polled server-side; the console never computes it.
  | "budget"
  // The listen session's health as the backend sees it: `stalled` when loud
  // audio keeps arriving but no transcript has for a while, `ok` when it
  // resumes, `reconnecting` when the bridge is minting a new session.
  | "listen"
  // Host speech from the listen-only Whissle session, with its voice metadata.
  | "transcript"
  /** A frame the agent read was kept; the console can show it in the timeline. */
  | "frame"
  // The show's loudness envelope, ~10 Hz. High volume, never persisted — its
  // only consumer is a strip showing the last couple of minutes.
  | "levels";

interface Client {
  id: number;
  reply: FastifyReply;
  /** Only events for this show reach this client. Empty while the console is
   *  connected but following nothing — it still gets `shows` and heartbeats. */
  showId: string;
  /** Whose console this is. The `shows` switcher list is cut to their shows. */
  ownerId: string | null;
}

export class EventHub {
  private clients = new Map<number, Client>();
  private nextId = 1;

  add(reply: FastifyReply, showId: string, ownerId: string | null = null): number {
    const id = this.nextId++;
    this.clients.set(id, { id, reply, showId, ownerId });
    return id;
  }

  /** Point an existing client at a show. A stream opens before it knows which
   *  show it is following — sometimes before there is one. */
  retarget(id: number, showId: string): void {
    const c = this.clients.get(id);
    if (c) c.showId = showId;
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
      // Backpressure: a console that stopped reading (a laptop lid, a tab in
      // the background for an hour) must not grow a buffer for ever.
      if (c.reply.raw.writableLength > 8 * 1024 * 1024) {
        this.clients.delete(id);
        try { c.reply.raw.destroy(); } catch { /* already gone */ }
        continue;
      }
      try {
        if (event === "shows" && Array.isArray(data)) {
          // The switcher's list, cut to this console's own shows. Rows older
          // than ownership have no owner and are everyone's.
          const mine = (data as { ownerAccountId?: string | null }[]).filter(
            (s) => s.ownerAccountId == null || s.ownerAccountId === c.ownerId,
          );
          c.reply.raw.write(`event: shows\ndata: ${JSON.stringify(mine)}\n\n`);
          continue;
        }
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
