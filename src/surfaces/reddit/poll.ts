// Watching Reddit: a subreddit's new posts, a person's comments, or one thread.
//
// There is no stream to open. Reddit is polled, which makes two decisions
// load-bearing.
//
// **Dedupe is by fullname.** `/new` is a sliding window, not a feed of things
// since you last looked: a post that was second last minute is fourth now, and
// the same rows come back on every poll. The fullname (`t3_…`, `t1_…`) is
// Reddit's own identity for a thing, so it is what we key on — not the text,
// which an author can edit, and not the position, which means nothing.
//
// **The first pass seeds and emits nothing.** Attaching to a room is a request
// to watch it from now on; emitting the hundred posts that were already there
// would fill the console with a backlog nobody asked for and hand the drafter a
// day of stale questions. Nothing is lost by it — a thread's history is rebuilt
// on demand by `thread.ts`, which is where history belongs.

import { config } from "../../config.js";
import type { SurfaceConnection, SurfaceEvents } from "../types.js";
import { RedditError, type RedditClient } from "./api.js";
import {
  messagesFromListing, parseCommentTree,
  type RedditListing, type RedditMessage,
} from "./thread.js";

export type RedditWatch =
  /** Every new post in a subreddit. */
  | { kind: "subreddit"; subreddit: string }
  /** Everything one account comments, wherever they comment it. */
  | { kind: "user"; username: string }
  /** One thread, and every comment that appears under it. */
  | { kind: "thread"; threadId: string; subreddit?: string };

/** How many fullnames to remember. Reddit returns 100 per page and a busy
 *  subreddit turns that over in an hour, so this is roughly a day of memory —
 *  far longer than anything can still be in a `/new` window, which is the only
 *  thing the set has to outlive. */
const SEEN_CAP = 4000;

/** Bounded, insertion-ordered. A `Set` keeps insertion order, so the oldest
 *  fullnames are the first ones iterated and the first ones evicted. */
class Seen {
  private ids = new Set<string>();

  has(id: string): boolean {
    return this.ids.has(id);
  }

  add(id: string): void {
    this.ids.add(id);
    if (this.ids.size > SEEN_CAP) {
      const oldest = this.ids.values().next().value;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
  }

  get size(): number {
    return this.ids.size;
  }
}

function pathFor(w: RedditWatch): { path: string; params: Record<string, string | number> } {
  switch (w.kind) {
    case "subreddit":
      return { path: `/r/${w.subreddit}/new`, params: { limit: 50 } };
    case "user":
      // `sort=new` is not the default on a profile, and the default (`hot`)
      // reorders as votes land — which means the newest comment can be on page
      // two and never seen.
      return { path: `/user/${w.username}/comments`, params: { limit: 50, sort: "new" } };
    case "thread":
      return { path: `/comments/${w.threadId.replace(/^t3_/, "")}`, params: { limit: 200, depth: 8, sort: "new" } };
  }
}

export interface RedditPollerOptions {
  client: RedditClient;
  watch: RedditWatch;
  events: SurfaceEvents;
  everyMs?: number;
  /** Injected in the suite so a poll cycle is a function call rather than a
   *  wall-clock wait. */
  schedule?: (fn: () => void, ms: number) => { cancel(): void };
}

const realSchedule = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms);
  // A poller must never be the reason a process refuses to exit.
  t.unref?.();
  return { cancel: () => clearTimeout(t) };
};

export class RedditPoller implements SurfaceConnection {
  private seen = new Seen();
  private primed = false;
  private stopped = false;
  private timer: { cancel(): void } | null = null;
  private readonly everyMs: number;

  constructor(private readonly o: RedditPollerOptions) {
    this.everyMs = o.everyMs ?? config.reddit.pollMs;
  }

  /** One pass. Separated from the loop so the suite can drive two of them and
   *  assert what the second emitted, with no clock involved. */
  async pollOnce(): Promise<RedditMessage[]> {
    const { path, params } = pathFor(this.o.watch);
    const payload = await this.o.client.get<unknown>(path, params);
    const messages =
      this.o.watch.kind === "thread"
        ? (() => {
            const t = parseCommentTree(payload);
            return [...(t.post ? [t.post] : []), ...t.comments];
          })()
        : messagesFromListing(payload as RedditListing);

    // Oldest first, so a burst arrives in the console in the order it was
    // written. Reddit answers `/new` newest-first, which is the wrong order for
    // reading a conversation.
    const fresh = messages.filter((m) => !this.seen.has(m.id)).reverse();
    for (const m of messages) this.seen.add(m.id);

    if (!this.primed) {
      this.primed = true;
      this.o.events.onStatus?.({
        connected: true,
        detail: `${describe(this.o.watch)} — ${this.seen.size} already here, watching for new`,
      });
      return [];
    }

    for (const m of fresh) {
      this.o.events.onMessage?.({
        id: m.id,
        author: m.author,
        text: m.text,
        at: m.at,
        // Both ids are the platform's own fullnames, which is what lets the
        // thread engine rebuild the branch above this message without a second
        // vocabulary to translate between.
        threadId: m.threadId,
        parentId: m.parentId,
        meta: { room: m.room, permalink: m.permalink },
      });
    }
    return fresh;
  }

  async start(): Promise<void> {
    const tick = async () => {
      if (this.stopped) return;
      try {
        await this.pollOnce();
      } catch (e) {
        const err = e as RedditError;
        // A permanent failure is a private subreddit, a deleted thread, a
        // suspended account or a credential that has stopped working. Polling
        // it every minute forever spends a rate-limit budget on an answer that
        // will not change, and hides the reason from the operator.
        if (err instanceof RedditError && err.permanent) {
          this.o.events.onStatus?.({ connected: false, detail: err.message });
          this.o.events.onEnded?.(err.message);
          this.stopped = true;
          return;
        }
        this.o.events.onStatus?.({ connected: false, detail: `reddit poll failed — ${(e as Error).message}` });
      }
      if (!this.stopped) this.timer = (this.o.schedule ?? realSchedule)(() => void tick(), this.everyMs);
    };
    await tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.timer?.cancel();
    this.timer = null;
  }
}

function describe(w: RedditWatch): string {
  switch (w.kind) {
    case "subreddit": return `r/${w.subreddit}`;
    case "user": return `u/${w.username}`;
    case "thread": return `thread ${w.threadId}`;
  }
}
