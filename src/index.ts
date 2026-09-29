// SideStage copilot server.
//
//   npm run seed         seed the catalog, policies, comps and Q&A
//   npm run seed:agent   create/update the Whissle agent + push its guardrails
//   npm run dev          start this server on :8790
//
// The operator console (the separate frontend repo) points at this with
// VITE_API_BASE=http://localhost:8790 and VITE_USE_MOCKS=false.

import { checkConfig, config, configSummary } from "./config.js";
import { buildApp } from "./api/server.js";
import { db as pgPool } from "./db/pg.js";
import { startFollowingPoller } from "./sellers/following.js";
import { startBudgetWatch, stopBudgetWatch } from "./llm/budget.js";
import { retireStaleAgents, startAgentGc } from "./llm/agentGc.js";
import { Accounts, startSessionPrune } from "./auth/accounts.js";
import { onAgentCap } from "./llm/streamAgent.js";
import { logError } from "./obs/log.js";
import { recordEvent } from "./obs/events.js";

/**
 * A dropped promise must not take the show down with it.
 *
 * Node's default for an unhandled rejection has been to throw since v15, which
 * ends the process. That default is right for a script and wrong for THIS: one container
 * serves the whole site, a show is on air inside it, and `restart:
 * unless-stopped` brings it back in a few seconds having lost the watcher, the
 * proposals held in memory and the host audio session.
 *
 * Three unawaited `audit.append` calls on the reply path were exactly this bug
 * (PR #54): a failed INSERT, on a box that has been OOM-killed before, ended the
 * process. Those three are awaited now. This is the class rather than the
 * instances — the next dropped promise, wherever it is, becomes a loud line and
 * a row instead of an outage.
 *
 * It does NOT swallow. Both channels get it, and `level: "error"` puts it in the
 * report: an unhandled rejection is a bug in this code every time, and one that
 * is invisible is one nobody fixes. A `uncaughtException` is deliberately left
 * alone — that one means the process state is unknown, and continuing is worse
 * than restarting.
 */
function keepServingThroughDroppedPromises(): void {
  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logError("process.unhandled_rejection", { err: err.message, stack: err.stack?.slice(0, 2000) });
    void recordEvent({
      kind: "process.unhandled_rejection",
      level: "error",
      // No showId: a rejection arrives with no context, and guessing one would
      // put this box's most confusing failure on the wrong session's timeline.
      detail: { err: err.message },
    });
  });
}

async function main(): Promise<void> {
  keepServingThroughDroppedPromises();
  // Configuration is checked HERE, before a port is opened and before a
  // migration runs. Every variable used to be discovered at first use — no
  // schema, no required set, no report of what was read — so a malformed one
  // surfaced as a 500 on whichever workflow touched it first, at whatever hour
  // that happened to be, and a missing one surfaced as nothing at all.
  const problems = checkConfig();
  const refuse = problems.filter((p) => p.level === "refuse");
  const warn = problems.filter((p) => p.level === "warn");
  if (warn.length) {
    // Boxed, because the thing this exists for — a seller's eBay credential
    // with nowhere safe to go — was previously ONE line in a process that
    // emitted eleven in sixteen hours.
    process.stderr.write(
      `\n${"!".repeat(74)}\n` +
      warn.map((p) => `!! ${p.name} ${p.detail}`).join(`\n${"!".repeat(74)}\n`) +
      `\n${"!".repeat(74)}\n\n`,
    );
  }
  if (refuse.length) {
    process.stderr.write(
      `\nSideStage will not start — the configuration is wrong:\n` +
      refuse.map((p) => `  ${p.name} ${p.detail}`).join("\n") +
      `\n\nFix the value and start again. Nothing has been changed.\n\n`,
    );
    process.exit(78); // EX_CONFIG
  }
  for (const [k, v] of Object.entries(configSummary())) console.log(`  config  ${k.padEnd(20)} ${v}`);

  const { app, ctx } = await buildApp();

  await app.listen({ port: config.port, host: "0.0.0.0" });
  await ctx.start();

  // Keeps the live grid warm for anyone following a seller. Started here and
  // not in `buildApp` on purpose: the test suite should neither drive a headless
  // browser nor depend on eBay answering.
  const stopFollowing = startFollowingPoller(pgPool());
  // Same reason: the cap is only real if something reads the wallet while the
  // show runs, and a wallet read is a gateway round trip the tests must not make.
  startBudgetWatch();
  // Agents are capped per workspace; finished shows give theirs back.
  const stopAgentGc = startAgentGc(pgPool());
  // Expired auth rows. Cheap, and now load-bearing: a scoped media token is
  // minted on every report view and dead within the hour.
  const stopSessionPrune = startSessionPrune(new Accounts(pgPool()));
  onAgentCap(() => retireStaleAgents(pgPool(), { reportAgeH: 1, preparedAgeH: 24 }));

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
    // try/finally, because this used to be a bare sequence registered directly
    // as the signal handler: a rejection from `app.close()` rejected the
    // handler's promise, so `process.exit` never ran and the container waited
    // out its grace period to SIGKILL — which is how orphaned Chrome processes
    // are made.
    try {
      stopFollowing();
      stopAgentGc();
      stopSessionPrune();
      stopBudgetWatch();
      await ctx.stop();
      await app.close();
    } catch (e) {
      console.error(`  shutdown: ${(e as Error).message}`);
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
