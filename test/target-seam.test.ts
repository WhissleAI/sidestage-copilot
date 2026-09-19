/**
 * What the operator pasted is what the adapter is asked to watch.
 *
 * `ShowRegistry.attach` used to keep one field of the target it was handed —
 * `externalId` — and `ShowRuntime` rebuilt `{ externalId }` out of it to give
 * back to the adapter, because for a long time a target WAS an eBay Live event
 * id and nothing was lost by the round trip. Everything an async surface knows
 * that a live one does not died in it: a Reddit thread link arrived at the
 * poller as a watch on a subreddit called `t3_1n4k2qp`, and a profile as one
 * called `u/linear_fan` — rooms that do not exist, which 404 on the first poll
 * and end the session seconds after it started.
 *
 * So the assertions here are on the WATCH the poller would actually run, read
 * back off the target the adapter was opened with. "The adapter was called" is
 * the thing that was true the whole time it was broken.
 *
 * The adapter registered below is a stub for `open()` ONLY: parsing goes
 * through the real `redditAdapter.parseTarget`, because the parse is the half
 * that was always right and the half the assertion depends on. Registering it
 * replaces Reddit for this file's process (node:test gives each file its own),
 * which is what keeps the suite off the network and out of a credential check.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { ShowRegistry } from "../src/shows/registry.js";
import { EventHub } from "../src/api/hub.js";
import { db, migrate, closeDb } from "../src/db/pg.js";
import { register } from "../src/surfaces/registry.js";
import { redditAdapter, watchFor } from "../src/surfaces/reddit/adapter.js";
import type {
  SurfaceAdapter, SurfaceConnection, SurfaceEvents, SurfaceTarget,
} from "../src/surfaces/types.js";

/** Every target an `open()` was asked for, in order. */
const opened: SurfaceTarget[] = [];
/** The events each stub connection was wired with, so a test can drive them. */
const wired: SurfaceEvents[] = [];

const stub = (id: SurfaceAdapter["id"], parse: SurfaceAdapter["parseTarget"]): SurfaceAdapter => ({
  id,
  label: id,
  capabilities: redditAdapter.capabilities,
  parseTarget: parse,
  async open(t: SurfaceTarget, ev: SurfaceEvents): Promise<SurfaceConnection> {
    opened.push(t);
    wired.push(ev);
    return { stop: async () => {} };
  },
});

let shows: ShowRegistry;
const created: string[] = [];

before(async () => {
  await migrate(db());
  register(stub("reddit", (input: string) => redditAdapter.parseTarget(input)));
  shows = new ShowRegistry(new EventHub());
});

after(async () => {
  await shows.stopAll();
  for (const id of created) await db().query("DELETE FROM shows WHERE id = $1", [id]).catch(() => {});
  await closeDb();
});

const attach = async (input: string, owner: string | null = null) => {
  opened.length = 0;
  const rt = await shows.attach(input, { ownerAccountId: owner });
  created.push(rt.showId);
  return rt;
};

describe("the target survives attach", () => {
  test("a thread link opens as a watch on that THREAD, not on a subreddit named after it", async () => {
    const rt = await attach("https://www.reddit.com/r/mechmarket/comments/1n4k2qp/are_lubed_linears_worth_it/");

    assert.equal(opened.length, 1, "the surface was opened once");
    const t = opened[0]!;
    // The parse was never the problem. What reached the adapter was.
    assert.equal(t.meta?.kind, "thread");
    assert.equal(t.meta?.threadId, "t3_1n4k2qp");
    assert.equal(t.meta?.subreddit, "mechmarket");
    // And the watch the poller would run off it — the thing that used to be
    // `{ kind: "subreddit", subreddit: "t3_1n4k2qp" }` and 404.
    assert.deepEqual(watchFor(t), { kind: "thread", threadId: "t3_1n4k2qp", subreddit: "mechmarket" });

    // The same target, whole, on the runtime — and on the row, so a restart
    // reopens what was pasted rather than a string that was inside it.
    assert.equal(rt.target?.meta?.kind, "thread");
    const stored = (
      await db().query<{ surface_target: SurfaceTarget | null }>(
        "SELECT surface_target FROM shows WHERE id = $1", [rt.showId],
      )
    ).rows[0]?.surface_target;
    assert.equal(stored?.meta?.kind, "thread");
    assert.equal(stored?.meta?.threadId, "t3_1n4k2qp");
  });

  test("a profile opens as a watch on that PERSON", async () => {
    await attach("u/linear_fan");
    const t = opened[0]!;
    assert.equal(t.meta?.kind, "user");
    assert.deepEqual(watchFor(t), { kind: "user", username: "linear_fan" });
  });

  test("a subreddit is unchanged — the one kind that survived the old round trip", async () => {
    await attach("r/mechmarket");
    assert.deepEqual(watchFor(opened[0]!), { kind: "subreddit", subreddit: "mechmarket" });
  });

  test("a restart reopens the thread, from the row rather than from memory", async () => {
    const first = await attach("https://www.reddit.com/r/mechmarket/comments/1n4kaaa/x/");
    const showId = first.showId;
    // What a restart is: the runtime is gone, the row is not.
    await shows.detach(showId).catch(() => {});

    const { ShowRuntime } = await import("../src/shows/runtime.js");
    const resumed = new ShowRuntime({
      showId,
      title: "resumed",
      sellerHandle: "r/mechmarket",
      source: "reddit",
      externalId: "t3_1n4kaaa",
      events: { emit: () => {} },
    });
    opened.length = 0;
    await resumed.init();
    await resumed.start();
    try {
      assert.deepEqual(watchFor(opened[0]!), { kind: "thread", threadId: "t3_1n4kaaa", subreddit: "mechmarket" });
    } finally {
      await resumed.close();
    }
  });
});
