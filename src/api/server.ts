// Building the server is separate from starting it, so a test can drive the
// REAL routing table — parsers, serializers, error handling and all — without
// opening a socket.
//
// This split exists because of a specific bug: every bodyless POST the console
// sent (regenerate, dismiss, approve, reject, rollback, detach) returned 400,
// and none of the 53 unit tests could see it, because they all stopped at the
// module boundary one level below HTTP. The seam that broke was the only seam
// nothing tested.

import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { buildContext, type AppContext } from "./context.js";
import { registerRoutes } from "./routes.js";

export async function buildApp(): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  // `forceCloseConnections` because this server's main transport is SSE, and an
  // SSE connection never ends on its own: without it a shutdown hangs for as
  // long as any console is open, which also hung the test suite.
  const app = Fastify({ logger: false, forceCloseConnections: true });

  // The console is served from a different origin in development. Commands are
  // idempotent-by-key or explicitly confirmed, and there is no cookie auth to
  // abuse, so a permissive policy is correct for a local operator tool. A
  // deployment behind a shared origin would tighten this.
  await app.register(cors, { origin: true });

  // Tolerate an empty body on a request that declares JSON.
  //
  // Fastify's default parser rejects that as malformed, which 400s every
  // bodyless command a browser sends with a default `content-type` header.
  // The client is fixed too, but an API should not depend on every caller
  // getting a header habit right.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const raw = typeof body === "string" ? body.trim() : "";
    if (!raw) return done(null, {});
    try {
      done(null, JSON.parse(raw));
    } catch (e) {
      // Broken JSON is the CLIENT's error. Handing Fastify a bare Error made it
      // a 500, so a caller with a typo in their payload was told the server had
      // failed — and would reasonably retry it.
      const err = e as Error & { statusCode?: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  const ctx = await buildContext();
  await registerRoutes(app, ctx);
  return { app, ctx };
}
