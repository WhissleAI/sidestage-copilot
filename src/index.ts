// SideStage copilot server.
//
//   npm run seed         seed the catalog, policies, comps and Q&A
//   npm run seed:agent   create/update the Whissle agent + push its guardrails
//   npm run dev          start this server on :8790
//
// The operator console (the separate frontend repo) points at this with
// VITE_API_BASE=http://localhost:8790 and VITE_USE_MOCKS=false.

import { config } from "./config.js";
import { buildApp } from "./api/server.js";

async function main(): Promise<void> {
  const { app, ctx } = await buildApp();

  await app.listen({ port: config.port, host: "0.0.0.0" });
  await ctx.start();

  const rows = await ctx.shows.list();
  console.log(
    `\nSideStage copilot on http://localhost:${config.port}\n` +
    `  llm      ${ctx.llmName}${config.whissle.agentId ? ` · agent ${config.whissle.agentId.slice(0, 8)}` : " · NO AGENT SET"}\n` +
    `  budget   p95 target ${config.latencyBudgetMs}ms\n` +
    `  shows    ${rows.length} watched\n` +
    rows.map((s) =>
      `           ${s.showId.padEnd(24)} ${s.source.padEnd(10)} ${s.readOnly ? "read-only" : "writable "} ${s.title.slice(0, 40)}\n`,
    ).join("") +
    `\n  attach a real eBay Live show:\n` +
    `    curl -X POST localhost:${config.port}/api/shows/attach -H 'content-type: application/json' \\\n` +
    `      -d '{"url":"https://www.ebay.com/ebaylive/events/<eventId>/stream"}'\n`,
  );

  const shutdown = async () => {
    await ctx.stop();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
