// HTTP surface. Exactly the contract the operator console consumes — one SSE
// stream for state, plain REST for commands. Nothing here holds business logic;
// every route is a thin adapter onto the pipeline, executor or research service.

import type { FastifyInstance } from "fastify";
import type { AutonomyLevel } from "../domain/types.js";
import { LADDER } from "../autonomy/ladder.js";
import type { AppContext } from "./context.js";

export async function registerRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { repo, pipeline, executor, research, audit, hub, showContext } = ctx;

  // ── health ────────────────────────────────────────────────────────────────
  app.get("/health", async () => ({
    ok: true,
    llm: ctx.llmName,
    listings: repo.listings().length,
    facts: ctx.retriever.size,
    auditHeight: audit.height(),
    clients: hub.size,
  }));

  // ── the event stream ──────────────────────────────────────────────────────
  app.get("/api/stream", (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    });

    const id = hub.add(reply);
    reply.raw.write(`event: hello\ndata: ${JSON.stringify(ctx.snapshot())}\n\n`);
    req.raw.on("close", () => hub.remove(id));
  });

  // ── reply proposals ───────────────────────────────────────────────────────
  app.post<{ Params: { id: string }; Body: { text?: string } }>("/api/proposals/:id/send", async (req, reply) => {
    try {
      return pipeline.send(req.params.id, req.body?.text);
    } catch (e) {
      return reply.code(404).send({ error: (e as Error).message });
    }
  });

  app.post<{ Params: { id: string } }>("/api/proposals/:id/dismiss", async (req, reply) => {
    try {
      return pipeline.dismiss(req.params.id);
    } catch (e) {
      return reply.code(404).send({ error: (e as Error).message });
    }
  });

  app.post<{ Params: { id: string } }>("/api/proposals/:id/regenerate", async (req, reply) => {
    try {
      return await pipeline.regenerate(req.params.id);
    } catch (e) {
      return reply.code(404).send({ error: (e as Error).message });
    }
  });

  // ── operational actions ───────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>("/api/actions/:id/approve", async (req, reply) => {
    try {
      return await executor.approve(req.params.id, "seller");
    } catch (e) {
      return reply.code(404).send({ error: (e as Error).message });
    }
  });

  app.post<{ Params: { id: string } }>("/api/actions/:id/reject", async (req, reply) => {
    try {
      return executor.reject(req.params.id);
    } catch (e) {
      return reply.code(404).send({ error: (e as Error).message });
    }
  });

  app.post<{ Params: { id: string } }>("/api/actions/:id/rollback", async (req, reply) => {
    try {
      return await executor.rollback(req.params.id, "seller");
    } catch (e) {
      return reply.code(404).send({ error: (e as Error).message });
    }
  });

  // ── show controls ─────────────────────────────────────────────────────────
  app.post<{ Body: { level: AutonomyLevel } }>("/api/autonomy", async (req, reply) => {
    const level = req.body?.level;
    if (!level || !LADDER.includes(level)) {
      return reply.code(400).send({ error: `level must be one of ${LADDER.join(", ")}` });
    }
    pipeline.setAutonomy(level);
    const show = repo.show();
    hub.emit("audit", audit.list(1)[0]);
    return show;
  });

  app.post<{ Body: { author?: string; text?: string } }>("/api/chat/inject", async (req, reply) => {
    const text = (req.body?.text || "").trim();
    if (!text) return reply.code(400).send({ error: "text is required" });
    return pipeline.ingest({ author: (req.body?.author || "you").trim(), text });
  });

  // ── research ──────────────────────────────────────────────────────────────
  app.post<{ Body: { query?: string; listingId?: string } }>("/api/research", async (req, reply) => {
    const query = (req.body?.query || "").trim();
    if (!query) return reply.code(400).send({ error: "query is required" });
    return research.run(query, req.body?.listingId ?? repo.show().pinnedListingId);
  });

  // ── read models ───────────────────────────────────────────────────────────
  app.get<{ Querystring: { limit?: string } }>("/api/audit", async (req) =>
    audit.list(Math.min(1000, Number(req.query.limit) || 200)));

  app.get("/api/audit/verify", async () => audit.verify());

  app.get("/api/metrics", async () => pipeline.metrics());

  app.get("/api/show", async () => repo.show());

  app.get("/api/listings", async () => repo.listings());

  app.get("/api/context", async () => showContext.current());

  app.get("/api/actions", async () => executor.list());

  app.get("/api/proposals", async () => pipeline.list());
}
