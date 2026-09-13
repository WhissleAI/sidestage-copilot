// HTTP surface. One SSE stream for state, plain REST for commands.
//
// Every route resolves a ShowRuntime from `?showId=`, defaulting to the demo
// show, so the single-show console contract is unchanged while multiple shows
// can be watched at once. SSE payloads all carry `showId`, so a console can
// filter client-side or render a switcher.

import type { FastifyInstance } from "fastify";
import type { AutonomyLevel } from "../domain/types.js";
import { LADDER } from "../autonomy/ladder.js";
import { discoverLiveShows } from "../ingest/ebaylive/discovery.js";
import { importCatalog, parseCatalogCsv, type CatalogItem } from "../shows/catalogImport.js";
import { applyCatalog, getCatalog, listCatalogs, reloadCatalogs } from "../shows/catalogs.js";
import { AUDIO_BRIDGE_HTML } from "./audioBridge.js";
import type { AppContext } from "./context.js";

export async function registerRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { hub, shows, kb } = ctx;

  /** Resolve the target show, or 404 with something actionable. */
  const rt = (showId?: string) => shows.get(showId);

  // ── health ────────────────────────────────────────────────────────────────
  app.get("/health", async () => ({
    ok: true,
    llm: ctx.llmName,
    shows: shows.list(),
    clients: hub.size,
  }));

  // ── the event stream ──────────────────────────────────────────────────────
  app.get<{ Querystring: { showId?: string } }>("/api/stream", (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    });

    let id = -1;
    try {
      const target = rt(req.query.showId);
      id = hub.add(reply, target.showId);
      reply.raw.write(`event: hello\ndata: ${JSON.stringify({ showId: target.showId, ...target.snapshot() })}\n\n`);
      reply.raw.write(`event: shows\ndata: ${JSON.stringify(shows.list())}\n\n`);
    } catch (e) {
      reply.raw.write(`event: error\ndata: ${JSON.stringify({ error: (e as Error).message })}\n\n`);
    }
    req.raw.on("close", () => { if (id >= 0) hub.remove(id); });
  });

  // ── catalogs ──────────────────────────────────────────────────────────────
  // What the operator picks first: which of my inventories am I selling tonight.
  app.get("/api/catalogs", async () => listCatalogs());

  app.post("/api/catalogs/reload", async () => {
    reloadCatalogs();
    return listCatalogs();
  });

  // ── shows ─────────────────────────────────────────────────────────────────
  app.get("/api/shows", async () => shows.list());

  /** Best-effort list of eBay Live shows currently on air. */
  app.get<{ Querystring: { limit?: string } }>("/api/shows/discover", async (req, reply) => {
    try {
      return await discoverLiveShows({ limit: Math.min(30, Number(req.query.limit) || 12) });
    } catch (e) {
      return reply.code(502).send({ error: `discovery failed: ${(e as Error).message}` });
    }
  });

  /**
   * Start a monitoring session: attach to a live eBay show AND load the catalog
   * the operator is selling from, in one call.
   *
   * The two belong together. A show with no catalog can only answer about the
   * lot on screen, and a catalog with no show has nothing to listen to — so the
   * setup screen asks for both and this is the one call it makes.
   */
  app.post<{ Body: { eventId?: string; url?: string; title?: string; host?: string; catalogId?: string } }>(
    "/api/shows/attach",
    async (req, reply) => {
      const input = (req.body?.eventId || req.body?.url || "").trim();
      if (!input) return reply.code(400).send({ error: "eventId or url is required" });

      const catalogId = (req.body?.catalogId || "").trim();
      const catalog = catalogId ? getCatalog(catalogId) : null;
      if (catalogId && !catalog) return reply.code(400).send({ error: `unknown catalog "${catalogId}"` });

      try {
        const target = await shows.attachEbayLive(input, { title: req.body?.title, host: req.body?.host });

        let applied = null;
        if (catalog) {
          applied = applyCatalog(target.repo, catalog);
          target.seller = catalog.seller;
          target.catalogId = catalog.id;
          // Answer as THIS seller's agent, with THIS seller's knowledge base.
          if (catalog.agentId) target.useAgent(catalog.agentId);
          target.retriever.rebuild();
          for (const l of target.repo.listings()) hub.emit("listing", { showId: target.showId, ...l });
        }

        // A newly started session becomes the one a console without a showId sees.
        shows.activate(target.showId);

        // Seed the agent's knowledge base in the background — the reply path is
        // grounded per-turn regardless.
        void kb.syncShow(target).catch(() => {});
        return { showId: target.showId, show: target.show, catalog: applied, snapshot: target.snapshot() };
      } catch (e) {
        return reply.code(502).send({ error: (e as Error).message });
      }
    },
  );

  /** Load (or swap) the catalog on an already-attached show. */
  app.post<{ Params: { showId: string }; Body: { catalogId?: string } }>(
    "/api/shows/:showId/catalog/apply",
    async (req, reply) => {
      const catalog = getCatalog((req.body?.catalogId || "").trim());
      if (!catalog) return reply.code(400).send({ error: "a known catalogId is required" });
      try {
        const target = rt(req.params.showId);
        const applied = applyCatalog(target.repo, catalog);
        target.seller = catalog.seller;
        target.catalogId = catalog.id;
        if (catalog.agentId) target.useAgent(catalog.agentId);
        target.retriever.rebuild();
        for (const l of target.repo.listings()) hub.emit("listing", { showId: target.showId, ...l });
        const kbResult = await kb.syncShow(target).catch((e) => ({ uploaded: false, lots: 0, reason: (e as Error).message }));
        return { ...applied, kb: kbResult };
      } catch (e) {
        return reply.code(404).send({ error: (e as Error).message });
      }
    },
  );

  /** Make this the show a console sees when it does not name one. */
  app.post<{ Params: { showId: string } }>("/api/shows/:showId/activate", async (req, reply) => {
    try {
      return shows.activate(req.params.showId);
    } catch (e) {
      return reply.code(404).send({ error: (e as Error).message });
    }
  });

  app.post<{ Params: { showId: string } }>("/api/shows/:showId/detach", async (req, reply) => {
    try {
      kb.cancel(req.params.showId);
      await shows.detach(req.params.showId);
      return { ok: true, shows: shows.list() };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  /**
   * Import the seller's catalog for a show — JSON items or a CSV body.
   *
   * eBay Live only exposes the lot on screen, so without this the copilot learns
   * a monitored lineup one lot at a time and honestly abstains on everything
   * else. A seller running this on their own show supplies their inventory once
   * and the copilot can answer across the whole lineup.
   */
  app.post<{ Params: { showId: string }; Body: unknown }>("/api/shows/:showId/catalog", async (req, reply) => {
    try {
      const target = rt(req.params.showId);
      const ct = String(req.headers["content-type"] || "");
      let items: CatalogItem[];

      if (ct.includes("csv") || typeof req.body === "string") {
        items = parseCatalogCsv(String(req.body));
      } else {
        const body = req.body as { items?: CatalogItem[] } | CatalogItem[];
        items = Array.isArray(body) ? body : body?.items || [];
      }
      if (!items.length) return reply.code(400).send({ error: "no catalog items found in the body" });

      const result = importCatalog(target.repo, items);
      target.retriever.rebuild();
      // An import is the one time emitting the whole catalog is right.
      for (const l of target.repo.listings()) hub.emit("listing", { showId: target.showId, ...l });

      // Push the imported lineup to the agent's knowledge base so it can also be
      // searched by the agent's own retrieval, not just ours.
      const kbResult = await kb.syncShow(target).catch((e) => ({ uploaded: false, lots: 0, reason: (e as Error).message }));
      return { ...result, kb: kbResult, listings: target.repo.listings().length };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  // ── host audio ────────────────────────────────────────────────────────────
  //
  // The operator opens this page, picks the eBay Live tab and ticks "Share tab
  // audio". Browsers will not hand a page tab audio without that gesture, which
  // is why capture cannot be started from the backend — by us or by anyone.
  app.get("/audio-bridge", async (_req, reply) => {
    return reply.type("text/html; charset=utf-8").send(AUDIO_BRIDGE_HTML);
  });

  /** Mint a LISTEN-ONLY Whissle session: STT + emotion, no LLM, no TTS. The
   *  wsk_ key stays here; the browser receives only a short-lived room token. */
  app.post<{ Params: { showId: string } }>("/api/shows/:showId/audio/session", async (req, reply) => {
    try {
      rt(req.params.showId); // 404 early if the show is not watched
      const session = await ctx.llm.startListenSession();
      return session;
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  /**
   * A finalized transcript segment of the host's speech, with whatever voice
   * metadata Whissle emitted alongside it (emotion, intent, speech rate).
   *
   * The metadata is surfaced to the console as well as fed to the context
   * engine: an operator watching "host tone: excited" against a lot that is not
   * selling is reading something the transcript alone does not say.
   */
  app.post<{
    Params: { showId: string };
    Body: {
      text?: string;
      emotion?: { label: string; p?: number } | string;
      intent?: { label: string; p?: number } | string;
      speechRate?: number;
      final?: boolean;
    };
  }>("/api/shows/:showId/audio/transcript", async (req, reply) => {
    const text = (req.body?.text || "").trim();
    if (!text) return reply.code(400).send({ error: "text is required" });
    try {
      const target = rt(req.params.showId);
      const norm = (v: { label: string; p?: number } | string | undefined) =>
        typeof v === "string" ? { label: v } : v && v.label ? v : null;

      const segment = {
        showId: target.showId,
        text,
        emotion: norm(req.body?.emotion),
        intent: norm(req.body?.intent),
        speechRate: typeof req.body?.speechRate === "number" ? req.body.speechRate : null,
        at: new Date().toISOString(),
      };

      target.showContext.push(text);
      hub.emit("transcript", segment);
      return { ok: true, ...segment };
    } catch (e) {
      return reply.code(404).send({ error: (e as Error).message });
    }
  });

  /** Force a knowledge-base sync for one show. */
  app.post<{ Params: { showId: string } }>("/api/shows/:showId/kb-sync", async (req, reply) => {
    try {
      return await kb.syncShow(rt(req.params.showId));
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  // ── reply proposals ───────────────────────────────────────────────────────
  app.post<{ Params: { id: string }; Querystring: { showId?: string }; Body: { text?: string } }>(
    "/api/proposals/:id/send",
    async (req, reply) => {
      try {
        return rt(req.query.showId).pipeline.send(req.params.id, req.body?.text);
      } catch (e) {
        return reply.code(404).send({ error: (e as Error).message });
      }
    },
  );

  app.post<{ Params: { id: string }; Querystring: { showId?: string } }>(
    "/api/proposals/:id/dismiss",
    async (req, reply) => {
      try {
        return rt(req.query.showId).pipeline.dismiss(req.params.id);
      } catch (e) {
        return reply.code(404).send({ error: (e as Error).message });
      }
    },
  );

  app.post<{ Params: { id: string }; Querystring: { showId?: string } }>(
    "/api/proposals/:id/regenerate",
    async (req, reply) => {
      try {
        return await rt(req.query.showId).pipeline.regenerate(req.params.id);
      } catch (e) {
        return reply.code(404).send({ error: (e as Error).message });
      }
    },
  );

  // ── operational actions ───────────────────────────────────────────────────
  app.post<{ Params: { id: string }; Querystring: { showId?: string } }>(
    "/api/actions/:id/approve",
    async (req, reply) => {
      try {
        return await rt(req.query.showId).executor.approve(req.params.id, "seller");
      } catch (e) {
        return reply.code(404).send({ error: (e as Error).message });
      }
    },
  );

  app.post<{ Params: { id: string }; Querystring: { showId?: string } }>(
    "/api/actions/:id/reject",
    async (req, reply) => {
      try {
        return rt(req.query.showId).executor.reject(req.params.id);
      } catch (e) {
        return reply.code(404).send({ error: (e as Error).message });
      }
    },
  );

  app.post<{ Params: { id: string }; Querystring: { showId?: string } }>(
    "/api/actions/:id/rollback",
    async (req, reply) => {
      try {
        return await rt(req.query.showId).executor.rollback(req.params.id, "seller");
      } catch (e) {
        return reply.code(404).send({ error: (e as Error).message });
      }
    },
  );

  // ── show controls ─────────────────────────────────────────────────────────
  app.post<{ Querystring: { showId?: string }; Body: { level: AutonomyLevel } }>(
    "/api/autonomy",
    async (req, reply) => {
      const level = req.body?.level;
      if (!level || !LADDER.includes(level)) {
        return reply.code(400).send({ error: `level must be one of ${LADDER.join(", ")}` });
      }
      try {
        const target = rt(req.query.showId);
        const show = target.setAutonomy(level);
        hub.emit("audit", { showId: target.showId, ...target.audit.list(1)[0] });
        return show;
      } catch (e) {
        return reply.code(404).send({ error: (e as Error).message });
      }
    },
  );

  app.post<{ Querystring: { showId?: string }; Body: { author?: string; text?: string } }>(
    "/api/chat/inject",
    async (req, reply) => {
      const text = (req.body?.text || "").trim();
      if (!text) return reply.code(400).send({ error: "text is required" });
      try {
        return rt(req.query.showId).pipeline.ingest({ author: (req.body?.author || "you").trim(), text });
      } catch (e) {
        return reply.code(404).send({ error: (e as Error).message });
      }
    },
  );

  // ── research ──────────────────────────────────────────────────────────────
  app.post<{ Querystring: { showId?: string }; Body: { query?: string; listingId?: string } }>(
    "/api/research",
    async (req, reply) => {
      const query = (req.body?.query || "").trim();
      if (!query) return reply.code(400).send({ error: "query is required" });
      try {
        const target = rt(req.query.showId);
        return target.research.run(query, req.body?.listingId ?? target.show.pinnedListingId);
      } catch (e) {
        return reply.code(404).send({ error: (e as Error).message });
      }
    },
  );

  // ── read models ───────────────────────────────────────────────────────────
  const read = <T>(fn: (showId?: string) => T) =>
    async (req: { query: { showId?: string } }, reply: { code(n: number): { send(b: unknown): unknown } }) => {
      try {
        return fn(req.query.showId);
      } catch (e) {
        return reply.code(404).send({ error: (e as Error).message });
      }
    };

  app.get<{ Querystring: { showId?: string; limit?: string } }>("/api/audit", read((s) => rt(s).audit.list(200)));
  app.get<{ Querystring: { showId?: string } }>("/api/audit/verify", read((s) => rt(s).audit.verify()));
  app.get<{ Querystring: { showId?: string } }>("/api/metrics", read((s) => rt(s).pipeline.metrics()));
  app.get<{ Querystring: { showId?: string } }>("/api/show", read((s) => rt(s).show));
  app.get<{ Querystring: { showId?: string } }>("/api/listings", read((s) => rt(s).repo.listings()));
  app.get<{ Querystring: { showId?: string } }>("/api/context", read((s) => rt(s).showContext.current()));
  app.get<{ Querystring: { showId?: string } }>("/api/actions", read((s) => rt(s).executor.list()));
  app.get<{ Querystring: { showId?: string } }>("/api/proposals", read((s) => rt(s).pipeline.list()));
}
