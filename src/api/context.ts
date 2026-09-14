// Composition root. One LLM client, one event hub, one show registry — and the
// registry owns everything per-show, so this file stays a wiring diagram rather
// than a god object.

import { config, hasWhissleCreds } from "../config.js";
import { WhissleClient } from "../llm/whissle.js";
import { EventHub } from "./hub.js";
import { ShowRegistry, DEMO_SHOW_ID } from "../shows/registry.js";
import { KbSync } from "../llm/kbSync.js";
import { db as pgPool, migrate, closeDb } from "../db/pg.js";
import { seed, DEMO_SHOW_ID as SEED_SHOW } from "../db/seed.js";

export interface AppContext {
  hub: EventHub;
  shows: ShowRegistry;
  llm: WhissleClient;
  llmName: string;
  kb: KbSync;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function buildContext(): Promise<AppContext> {
  const hub = new EventHub();

  // Schema first: the app cannot answer a single question without it, so a
  // migration failure should stop the boot rather than surface as a confusing
  // "relation does not exist" on the first buyer message.
  const pool = pgPool();
  await migrate(pool);

  // The demo show is provisioned on an empty database so a fresh clone has
  // something real to open — the walkthrough, the stale-price failure path and
  // the whole write/rollback spike all run on it.
  const seeded = await pool.query<{ c: number }>(
    "SELECT COUNT(*)::int AS c FROM listings WHERE show_id = $1", [SEED_SHOW],
  );
  if ((seeded.rows[0]?.c ?? 0) === 0) await seed(pool);

  if (!hasWhissleCreds()) {
    console.warn(
      "\n  WHISSLE_API_KEY / WHISSLE_AGENT_ID are not set.\n" +
      "  Ingestion, retrieval, guardrails, actions, audit and the API all work without\n" +
      "  them, but no reply can be DRAFTED. Run `npm run seed:agent` first — see README.\n",
    );
  }

  const llm = new WhissleClient({
    apiKey: config.whissle.apiKey,
    agentId: config.whissle.agentId,
    baseUrl: config.whissle.base,
    timeoutMs: Math.max(4000, config.latencyBudgetMs * 3),
  });

  const shows = new ShowRegistry(hub);
  const kb = new KbSync();

  let heartbeat: NodeJS.Timeout | null = null;

  return {
    hub,
    shows,
    llm,
    llmName: llm.name,
    kb,

    async start() {
      await shows.ensureDemo();
      heartbeat = setInterval(() => hub.heartbeat(), 20_000);

      // Attach to eBay Live shows named at boot: WATCH_EBAY=id1,id2
      // The first one that attaches becomes the ACTIVE show, so a console that
      // opens without a showId lands on the live stream rather than the demo.
      const watch = (process.env.WATCH_EBAY || "").split(",").map((x) => x.trim()).filter(Boolean);
      let activated = false;
      for (const id of watch) {
        try {
          const rt = await shows.attachEbayLive(id);
          console.log(`  watching eBay Live ${id} as ${rt.showId}`);
          if (!activated) {
            shows.activate(rt.showId);
            activated = true;
          }
          void kb.syncShow(rt);
        } catch (e) {
          console.warn(`  could not attach eBay Live ${id}: ${(e as Error).message}`);
        }
      }
    },

    async stop() {
      if (heartbeat) clearInterval(heartbeat);
      await shows.stopAll();
      // The pool is process-wide; leaving it open holds the event loop and makes
      // a finished test suite look like it hung.
      await closeDb();
    },
  };
}

export { DEMO_SHOW_ID };
