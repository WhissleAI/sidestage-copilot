// HTTP surface. One SSE stream for state, plain REST for commands.
//
// Every route resolves a ShowRuntime from `?showId=`, defaulting to the demo
// show, so the single-show console contract is unchanged while multiple shows
// can be watched at once. SSE payloads all carry `showId`, so a console can
// filter client-side or render a switcher.

import type { FastifyInstance } from "fastify";
import type { AutonomyLevel } from "../domain/types.js";
import { LADDER } from "../autonomy/ladder.js";
import { discoverLiveShows, discoverSellerShows, parseEventId } from "../ingest/ebaylive/discovery.js";
import { Following, cachedDiscovery, cachedGrid, gridCheckedAt, liveGrid, rememberGrid } from "../sellers/following.js";
import { SurfaceRooms } from "../surfaces/rooms.js";
import { all as surfaceAdapters } from "../surfaces/registry.js";
import { SURFACE_CAPABILITIES, capabilitiesOf, type SurfaceId } from "../surfaces/types.js";
import { Preparer } from "../shows/prepareEvent.js";
import { sessionStatus } from "../ingest/ebaylive/session.js";
import { BudgetWatch, budgetState, setBudgetWatch } from "../llm/budget.js";
import { ebay } from "../ingest/ebay/client.js";
import { marketIndex } from "../shows/catalogMarket.js";
import { analyticsOverview } from "../shows/analytics.js";
import { EbayOAuth } from "../ingest/ebay/oauth.js";
import { importSellerListings } from "../ingest/ebay/import.js";
import { importCatalog, parseCatalogCsv, type CatalogItem } from "../shows/catalogImport.js";
import { addCatalogQa, applyCatalog, getCatalog, listCatalogs, reloadCatalogs } from "../shows/catalogs.js";
import { catalogFit, checkReadiness } from "../shows/readiness.js";
import { createStreamAgent, deleteStreamAgent } from "../llm/streamAgent.js";
import type { ShowReport } from "../shows/sessionRecord.js";
import { prdMetrics } from "../shows/prdMetrics.js";
import { promotionReadiness } from "../autonomy/promotion.js";
import { AUDIO_BRIDGE_HTML } from "./audioBridge.js";
import { normalizeDistribution } from "../ingest/signals.js";
import { extractJsonObject } from "../compose/composer.js";
import { meter } from "../llm/meter.js";
import { WhissleBilling, spendWindow } from "../llm/billing.js";
import { Accounts, AuthError, canWrite, type Account } from "../auth/accounts.js";
import {
  SettingsStore, sanitize, merge, diffFromDefaults, invalidPatterns, pushLayerA,
  type SettingsView,
} from "../settings/store.js";
import { policy, policyScope, DEFAULT_POLICY } from "../guardrails/policy.js";
import { WhissleSessions } from "../llm/sessions.js";
import { SessionSignals } from "../shows/signals.js";
import { showRecord } from "../shows/record.js";
import { challengeResponse, honourDeletion, parseNotice, verifyNotification } from "../ingest/ebay/deletion.js";
import { createReadStream, existsSync } from "node:fs";
import { db as pgPool } from "../db/pg.js";
import { config } from "../config.js";
import { WhissleClient } from "../llm/whissle.js";
import { describeFrames, describing } from "../shows/frameDescriber.js";
import { SendRefused } from "../pipeline/pipeline.js";
import type { AppContext } from "./context.js";

/** A keyframe is ~40-120 KB of base64 at the size we send. This is the ceiling
 *  before the request is refused rather than paid for. */
const MAX_FRAME_CHARS = 400_000;
/** Server-side floor between vision reads, per show. The client throttles too,
 *  but a client's throttle is a request, not a guarantee. */
const VISUAL_MIN_GAP_MS = 8_000;
const VISUAL_QUESTION =
  "Look at this frame from the seller's live show. In ONE short line of at most 12 words, " +
  "name the item being held up or shown, using the catalog name if you recognise it. " +
  "Do not describe the photo, the lighting or the background. If no item is clearly " +
  "visible, answer exactly: nothing clear.";

/**
 * Phrases that mean the model is describing the PICTURE rather than the item.
 *
 * A live stream between lots produces a dark or empty frame, and asked to
 * describe it the model returns a paragraph about how dark it is — which then
 * became "on camera: I'm looking at the image, but it appears to be completely
 * black…" in the seller's context, once a minute. The client now skips blank
 * frames before they cost a call; this is the second line of defence, because
 * "answer exactly X" is a request to a model, not a guarantee from one.
 */
const NOT_AN_ITEM =
  /(nothing clear|no visible|completely black|very dark|appears to be (?:black|dark|blank|empty)|cannot (?:see|make out)|can'?t (?:see|make out)|unable to|no (?:item|object|product)s? (?:is |are )?(?:visible|clear)|i'?m looking at the image|the image (?:is|appears)|blurry|too dark)/i;
const lastVisualRead = new Map<string, number>();

/** The agent replies in the reply JSON shape; take the answer, drop the rest. */
export function readingText(raw: string): string {
  const obj = extractJsonObject(raw);
  const answer = obj && typeof (obj as { answer?: unknown }).answer === "string"
    ? ((obj as { answer: string }).answer)
    : raw;
  const t = answer.trim();
  if (!t) return "";
  // Matched anywhere, not anchored: the model appends "nothing clear" to a
  // sentence at least as often as it answers with it, and an anchored test let
  // the whole paragraph through.
  if (NOT_AN_ITEM.test(t)) return "";
  // A reading this long is a description, not an item name.
  if (t.length > 120) return "";
  return t;
}

export async function registerRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { hub, shows, kb } = ctx;

  /** Resolve the target show, or 404 with something actionable. */
  // No showId means "my show": the caller's newest live one. It used to mean
  // the process's single active show, which on a host with several sellers
  // was somebody else's.
  const rt = (showId?: string | null, req?: object) => {
    if (showId) return shows.get(showId);
    const a = req ? actorOf(req) : null;
    return shows.get(shows.activeFor(a?.id));
  };

  // ── who is asking ─────────────────────────────────────────────────────────
  //
  // Every request carries an actor, resolved once. A caller with no session may READ the open routes
  // and change nothing; only a seller can send a reply, approve an action or
  // detach a show. The distinction is enforced here rather than in each handler
  // so a route added later is not accidentally left open.
  const accounts = new Accounts(pgPool());
  // Declared up here with the other stores: the eBay routes below are defined
  // before the `following` block, and a `const` used above its declaration is a
  // runtime error rather than a compile one.
  const ebayAuth = new EbayOAuth(pgPool());
  const preparer = new Preparer(pgPool());
  const actors = new WeakMap<object, Account | null>();

  // Paths a signed-out caller may reach: the front door, health, eBay's own
  // callbacks, and the bridge page (which carries its token as a query
  // parameter because it is a bare HTML page, not the console).
  const OPEN = [/^\/health$/, /^\/api\/auth\/(register|login)$/, /^\/api\/ebay\/callback/, /^\/api\/ebay\/account-deletion/, /^\/audio-bridge/];
  app.addHook("onRequest", async (req, reply) => {
    const header = req.headers.authorization;
    const q = (req.query ?? {}) as { token?: string };
    // EventSource cannot set headers; the stream and the bridge send the token as a query parameter.
    const token = header?.startsWith("Bearer ") ? header.slice(7) : typeof q.token === "string" ? q.token : null;
    const actor = await accounts.resolve(token);
    actors.set(req as object, actor);
    const path = req.url.split("?")[0]!;
    if (!actor && !OPEN.some((re) => re.test(path))) {
      return reply.code(401).send({ error: "sign in to use SideStage", actor: null });
    }
  });

  const actorOf = (req: object): Account | null => actors.get(req) ?? null;

  // Everything this request does — drafting, guarding, proposing — reads the
  // CALLER's guard settings, not whatever was activated last. Callback-style
  // on purpose: `policyScope.run(p, done)` puts the rest of the request
  // lifecycle inside the scope.
  app.addHook("onRequest", (req, _reply, done) => {
    const a = actorOf(req as object);
    if (!a) return done();
    settings
      .forAccount(a.id)
      .then((p) => policyScope.run(p, done))
      .catch(() => done());
  });

  // ── whose show ────────────────────────────────────────────────────────────
  //
  // A show belongs to the account that attached it. Any route that names a
  // show — path, query or body — answers 404 to anyone else, and 404 rather
  // than 403 because another seller's show should not even be confirmed to
  // exist. Rows older than ownership have no owner and stay visible; every
  // show attached since has exactly one.
  const ownerOf = async (showId: string): Promise<string | null | undefined> => {
    if (shows.has(showId)) return shows.get(showId).ownerAccountId;
    const r = await pgPool().query<{ owner_account_id: string | null }>(
      "SELECT owner_account_id FROM shows WHERE id = $1", [showId],
    );
    return r.rows[0] ? r.rows[0].owner_account_id : undefined;
  };
  app.addHook("preHandler", async (req, reply) => {
    const p = (req.params ?? {}) as { showId?: string };
    const q = (req.query ?? {}) as { showId?: string };
    const b = (req.body ?? {}) as { showId?: unknown };
    const showId = p.showId || q.showId || (typeof b.showId === "string" ? b.showId : undefined);
    if (!showId) return;
    const a = actorOf(req as object);
    if (!a) return; // onRequest already refused a signed-out caller on a closed path
    const owner = await ownerOf(showId);
    if (owner === undefined) return; // no such show: the handler says so its own way
    if (owner !== null && owner !== a.id) return reply.code(404).send({ error: `no such show ${showId}` });
  });

  // Every mutation needs a signed-in seller. There is no guest kind any more,
  // so this is belt-and-braces over onRequest — but a route added later that
  // forgets its own check is still not an open write.
  app.addHook("preHandler", async (req, reply) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return;
    const path = req.url.split("?")[0]!;
    if (OPEN.some((re) => re.test(path))) return;
    if (!canWrite(actorOf(req as object))) return reply.code(403).send({ error: "sign in with a seller account to do that" });
  });

  /** The audit's answer to "who did that": the account's handle, never a
   *  literal "seller". */
  const who = (req: object): string => {
    const a = actorOf(req);
    return a ? `seller:${a.handle}` : "seller";
  };

  /** Refuse a write from anyone who is not a signed-in seller. */
  const mustWrite = (
    req: object,
    reply: { code(n: number): { send(b: unknown): unknown } },
    // What was being attempted. A guest told they "cannot send replies" after
    // trying to follow a seller is being answered about a different action.
    what = "send replies or approve actions",
  ): Account | null => {
    const a = actorOf(req);
    if (canWrite(a)) return a;
    reply.code(403).send({
      error: a
        ? `this session is a guest — it can watch the show but cannot ${what}`
        : "no session — the console mints one on load; send it as `Authorization: Bearer <token>`",
      actor: a?.kind ?? null,
    });
    return null;
  };

  app.post<{ Body: { email?: string; password?: string; displayName?: string } }>("/api/auth/register", async (req, reply) => {
    try {
      const s = await accounts.register(req.body?.email ?? "", req.body?.password ?? "", req.body?.displayName ?? "");
      return { token: s.token, account: s.account, expiresAt: s.expiresAt };
    } catch (e) {
      return reply.code(e instanceof AuthError ? e.status : 500).send({ error: (e as Error).message });
    }
  });

  app.post<{ Body: { email?: string; password?: string } }>("/api/auth/login", async (req, reply) => {
    try {
      const s = await accounts.login(req.body?.email ?? "", req.body?.password ?? "");
      return { token: s.token, account: s.account, expiresAt: s.expiresAt };
    } catch (e) {
      return reply.code(e instanceof AuthError ? e.status : 500).send({ error: (e as Error).message });
    }
  });

  app.post("/api/auth/logout", async (req) => {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
    if (token) await accounts.endSession(token);
    return { ok: true };
  });

  app.get("/api/auth/me", async (req) => ({ account: actorOf(req as object) }));

  // ── analytics ─────────────────────────────────────────────────────────────
  //
  // Three questions a seller actually has, and the source that answers each:
  //
  //   did it help      our own Metrics — answered rate, time-to-answer, blocks
  //   can I trust it   guard block rate per guard, rollbacks, chain integrity
  //   what does it cost  the wallet, plus the agent's own per-turn trace
  //
  // The trace is the part that has never been surfaced. `/api/sessions` carries
  // `agent_id` (the metering rows do not), so this is where per-agent
  // attribution actually lives: which provider and model answered, whether it
  // failed over, the latency and the tokens, per hop.
  const sessionsApi = new WhissleSessions(config.whissle.base, config.whissle.apiKey);
  // One store for every show's signals; the runtime has its own handle on the
  // same tables for the report. Media reads below do not need a live runtime —
  // a report is read after the show is gone.
  const signals = new SessionSignals(pgPool());

  /**
   * Per-show health of the host-audio path. Three clocks: the last loud level
   * frame, the last transcript, the last audio chunk. Loud for a while with no
   * transcript is `stalled`; the first transcript after that is `ok` again.
   */
  const STALL_MS = 45_000;
  class ListenHealth {
    private loudSince = 0;
    private lastLoud = 0;
    private lastTranscript = 0;
    private state: "ok" | "stalled" = "ok";
    reset(): void { this.loudSince = 0; this.lastLoud = 0; this.lastTranscript = Date.now(); this.state = "ok"; }
    touch(what: "loud" | "transcript" | "audio"): void {
      const now = Date.now();
      if (what === "loud") { if (!this.loudSince || now - this.lastLoud > 10_000) this.loudSince = now; this.lastLoud = now; }
      if (what === "transcript") { this.lastTranscript = now; this.loudSince = 0; }
    }
    check(emit: (state: "ok" | "stalled", detail: string) => void): void {
      const now = Date.now();
      const quiet = now - (this.lastTranscript || now);
      const loudFor = this.loudSince ? now - this.loudSince : 0;
      if (this.state === "ok" && loudFor > STALL_MS && quiet > STALL_MS) {
        this.state = "stalled";
        emit("stalled", `audio has been live for ${Math.round(loudFor / 1000)}s with no transcript for ${Math.round(quiet / 1000)}s`);
      } else if (this.state === "stalled" && quiet < 5_000) {
        this.state = "ok";
        emit("ok", "transcript resumed");
      }
    }
  }
  const listenHealth = new Map<string, ListenHealth>();
  const lastUtteranceAt = new Map<string, number>();
  const health = (showId: string): ListenHealth => {
    let h = listenHealth.get(showId);
    if (!h) { h = new ListenHealth(); listenHealth.set(showId, h); }
    return h;
  };
  // Audio chunks arrive as raw bytes, not JSON. Registered once; the route
  // caps the size.
  for (const mime of ["audio/webm", "audio/ogg", "audio/mp4", "application/octet-stream"]) {
    app.addContentTypeParser(mime, { parseAs: "buffer", bodyLimit: 12 * 1024 * 1024 }, (_req, body, done) => done(null, body));
  }

  /**
   * Is the loaded catalog actually about what this show is selling?
   *
   * Polled by the console once a show has observed a few lots. A mismatch is
   * silent otherwise: nothing errors, retrieval just grounds nothing and every
   * answer abstains.
   */
  app.get<{ Querystring: { showId?: string } }>("/api/show/fit", async (req, reply) => {
    let target;
    try {
      target = rt(req.query.showId, req as object);
    } catch (e) {
      return reply.code(404).send({ error: (e as Error).message });
    }
    const listings = await target.repo.listings();
    // Sellers pin "$1 Live show link" placeholders between lots and eBay pads
    // grids with "Shop on eBay" filler. Neither is a lot, and judging catalog
    // fit against them reported "mismatch — 0% of 4 lots" for a catalog that
    // matched every real lot the show had put on screen.
    const placeholder = (t: string) => /live show link|^shop on ebay$/i.test(t);
    const observed = listings
      .filter((l) => l.externalRef && !placeholder(l.title))
      .map((l) => l.title);
    const own = listings.filter((l) => !l.externalRef).map((l) => l.title);
    // Too few observed lots to judge — saying "mismatch" off two titles would
    // cry wolf in the first minute of every show.
    if (observed.length < 3 || own.length === 0) {
      return { verdict: "unknown", overlap: 0, sampled: observed.length, catalogId: target.catalogId };
    }
    return { ...catalogFit(own, observed), catalogId: target.catalogId };
  });

  /** The PRD's success metrics for a show, live. */
  app.get<{ Querystring: { showId?: string } }>("/api/show/prd", async (req, reply) => {
    try {
      const target = rt(req.query.showId, req as object);
      return await prdMetrics(pgPool(), target.showId);
    } catch (e) {
      return reply.code(404).send({ error: (e as Error).message });
    }
  });

  /** Has this seller earned the next rung? Computed, not asserted — and
   *  computed over THEIR shows: promotion on a stranger's clean numbers is
   *  exactly the guarantee the ladder exists to make. */
  app.get<{ Querystring: { showId?: string } }>("/api/autonomy/readiness", async (req, reply) => {
    try {
      const target = rt(req.query.showId, req as object);
      const show = await target.show();
      return await promotionReadiness(pgPool(), show.autonomyLevel, actorOf(req as object)?.id ?? null);
    } catch (e) {
      return reply.code(404).send({ error: (e as Error).message });
    }
  });

  /**
   * Analytics across every finished show in the window. Needs no live show:
   * every number is a sum or a rate over persisted reports, which is what makes
   * it the same number tomorrow.
   */
  app.get<{ Querystring: { days?: string } }>("/api/analytics/overview", async (req) => {
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    const [overview, readiness] = await Promise.all([
      analyticsOverview(pgPool(), days, actorOf(req as object)?.id ?? null),
      promotionReadiness(pgPool(), "L1_SUGGEST", actorOf(req as object)?.id ?? null).catch(() => null),
    ]);
    // Which of the caller's shows is on air, if any, so the page can offer its live view.
    const live = shows.activeFor(actorOf(req as object)?.id) ?? null;
    return { ...overview, liveShowId: live, readiness };
  });

  app.get<{ Querystring: { showId?: string; days?: string } }>("/api/analytics", async (req, reply) => {
    let target;
    try {
      target = rt(req.query.showId, req as object);
    } catch (e) {
      return reply.code(404).send({ error: (e as Error).message });
    }
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));

    // Everything in flight together: this page reads five sources and doing it
    // sequentially is five round trips a seller waits through between lots.
    const [metrics, chain, actions, walletR, usageR, agent] = await Promise.all([
      target.pipeline.metrics(),
      target.audit.verify(),
      target.executor.list(500),
      billing.wallet(),
      billing.usage(days),
      target.agentId
        ? sessionsApi.activity(target.agentId, 25)
        : Promise.resolve(null),
    ]);

    const wallet = walletR.ok ? walletR.value : null;
    if (wallet) spendWindow.open(target.showId, wallet.balanceUsd);

    return {
      showId: target.showId,
      agentId: target.agentId || null,
      copilot: {
        ...metrics,
        // Integrity is part of "can I trust it", not a separate curiosity.
        auditChain: chain,
        actionsByStatus: actions.reduce<Record<string, number>>((acc, a) => {
          acc[a.status] = (acc[a.status] ?? 0) + 1;
          return acc;
        }, {}),
      },
      agent,
      cost: {
        wallet,
        walletError: walletR.ok ? null : walletR.error,
        usage: usageR.ok ? usageR.value : null,
        usageError: usageR.ok ? null : usageR.error,
        meter: meter.snapshot(),
        spend: wallet ? spendWindow.since(wallet.balanceUsd) : {},
      },
      policy: {
        maxDiscountPct: policy().maxDiscountPct,
        neverSayRules: policy().neverSay.length,
        // The documented asymmetry, as a number: rules marked `unlessCertified`
        // stay app-side because the gateway matcher has no catalog access.
        armedOnAgent: policy().neverSay.filter((r) => !r.unlessCertified).length,
      },
    };
  });

  // ── settings ──────────────────────────────────────────────────────────────
  //
  // The guardrail policy is the whole of this surface, because it is the one
  // setting where editing it visibly changes what the agent is ALLOWED to say —
  // in this process on the next reply, and on the agent itself for every other
  // channel it answers on.
  const settings = new SettingsStore(pgPool());
  shows.policyFor = (accountId) => settings.forAccount(accountId);

  /** The agents a save has to reach: one per catalog, and the active show's. */
  const armTargets = async (): Promise<string[]> => {
    const ids = new Set<string>();
    for (const s of await shows.list()) if (s.agentId) ids.add(s.agentId);
    for (const c of listCatalogs()) if (c.agentId) ids.add(c.agentId);
    return [...ids];
  };

  const view = async (accountId: string | null, armed: SettingsView["armed"] = null): Promise<SettingsView> => {
    const loaded = accountId ? await settings.load(accountId) : { overrides: {}, updatedAt: null };
    const active = merge(loaded.overrides);
    return {
      policy: active,
      defaults: DEFAULT_POLICY,
      overrides: diffFromDefaults(active),
      armed,
      updatedAt: loaded.updatedAt,
    };
  };

  app.get("/api/settings", async (req) => ({ ...(await view(actorOf(req as object)?.id ?? null)), enforcing: policy() }));

  app.put<{ Body: unknown }>("/api/settings", async (req, reply) => {
    const actor = mustWrite(req as object, reply);
    if (!actor) return;

    const overrides = sanitize(req.body);
    // A seller-authored regex that does not compile would throw inside the
    // policy guard, and a guard that throws returns `block` — every reply, until
    // someone read the logs. Refuse it here, where it is a form error.
    const bad = invalidPatterns(overrides);
    if (bad.length) {
      return reply.code(400).send({ error: "these patterns are not valid regular expressions", patterns: bad });
    }

    await settings.persist(actor.id, overrides);
    // Layer B first: it is in-process and cannot fail, so the seller's own
    // console is never checking against a policy it does not show.
    const active = merge(overrides);
    settings.activate(active);

    // Layer A second, per agent, reporting rather than throwing — a gateway
    // that refuses the push must not lose the edit.
    const targets = await armTargets();
    const reports = await Promise.all(
      targets.map((id) => pushLayerA(config.whissle.base, config.whissle.apiKey, id)),
    );
    const armed = reports.find((r) => !r.ok) ?? reports[0] ?? null;

    return view(actor.id, armed ?? null);
  });

  app.post("/api/settings/reset", async (req, reply) => {
    const actor = mustWrite(req as object, reply);
    if (!actor) return;
    await settings.persist(actor.id, {});
    settings.activate(DEFAULT_POLICY);
    const targets = await armTargets();
    const reports = await Promise.all(
      targets.map((id) => pushLayerA(config.whissle.base, config.whissle.apiKey, id)),
    );
    return view(actor.id, reports.find((r) => !r.ok) ?? reports[0] ?? null);
  });



  // ── health ────────────────────────────────────────────────────────────────
  app.get("/health", async () => ({
    ok: true,
    llm: ctx.llmName,
    shows: await shows.list(),
    clients: hub.size,
  }));

  // ── the event stream ──────────────────────────────────────────────────────
  app.get<{ Querystring: { showId?: string } }>("/api/stream", async (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    });

    // Registered BEFORE the show is resolved, and with an empty show id when
    // there is no show to resolve.
    //
    // The stream is the console's connection to the product, not to one show.
    // When resolving failed, this handler used to return without registering —
    // Fastify then ended the response, the browser's EventSource fired onerror,
    // and the console sat in a reconnect loop rendering a skeleton forever. Now
    // an idle console holds a real stream: it gets the heartbeat, it gets
    // `shows` (which every client receives), and the moment a show is attached
    // it hears about it on the connection it already has.
    const id = hub.add(reply, "", actorOf(req as object)?.id ?? null);
    req.raw.on("close", () => hub.remove(id));

    try {
      const target = rt(req.query.showId, req as object);
      hub.retarget(id, target.showId);
      // Both awaited BEFORE writing. An unresolved promise serialises to `{}`,
      // which would hand the console an empty hello it happily rendered as a
      // show with no listings, no proposals and no audit.
      const [snapshot, list] = await Promise.all([target.snapshot(), shows.list(actorOf(req as object)?.id)]);
      reply.raw.write(`event: hello\ndata: ${JSON.stringify({ showId: target.showId, ...snapshot })}\n\n`);
      reply.raw.write(`event: shows\ndata: ${JSON.stringify(list)}\n\n`);
    } catch (e) {
      reply.raw.write(`event: stream_error\ndata: ${JSON.stringify({ error: (e as Error).message })}\n\n`);
      reply.raw.write(`event: shows\ndata: ${JSON.stringify(await shows.list(actorOf(req as object)?.id).catch(() => []))}\n\n`);
    }
  });

  // ── catalogs ──────────────────────────────────────────────────────────────
  // What the operator picks first: which of my inventories am I selling tonight.
  // ── what this is costing ──────────────────────────────────────────────────
  //
  // Two sources that must not be conflated, and one honest gap between them.
  //
  //   wallet   dollars, from the platform. The seller's real balance.
  //   usage    tokens/seconds/characters consumed, ORG-wide.
  //   meter    OUR calls, per show — the only per-show attribution that exists,
  //            because /usage/sessions returns agent_id: null for text turns.
  //
  // The wallet delta is reported as an upper bound, never as an invoice: it is
  // org-wide, so concurrent work in the same workspace lands inside it.
  const billing = new WhissleBilling(config.whissle.apiKey, config.whissle.base);

  /**
   * The per-show cap, made real.
   *
   * `automation.perShowCapUsd` was settable and read by nothing: a seller could
   * save a $2 limit, watch the page confirm it, and spend $9. The watch polls
   * the wallet while a show is live and latches the show when the bound crosses
   * the cap; the pipeline refuses to draft from there, and the chain records
   * it, because the cap changed what the copilot did.
   *
   * Constructed here, STARTED from the server entry point — a test suite must
   * not poll a billing gateway.
   */
  setBudgetWatch(
    new BudgetWatch(
      billing,
      () => policy().automation,
      async () => (await shows.list()).map((s) => s.showId),
      (showId, state) => {
        hub.emit("budget", { showId, ...state });
        const rt = shows.get(showId);
        void rt.audit
          .append(
            "budget_cap_reached",
            "system",
            `spend cap reached — drafting stopped at $${(state.spentUsd ?? 0).toFixed(2)} of $${(state.capUsd ?? 0).toFixed(2)}`,
            { showId, spentUsd: state.spentUsd, capUsd: state.capUsd, basis: "wallet-delta upper bound" },
          )
          .then((e) => hub.emit("audit", { showId, ...e }))
          .catch((e) => console.warn(`  audit: budget-cap entry for ${showId} not written — ${(e as Error).message}`));
      },
    ),
  );

  /** What this show has spent against the cap. The console polls it beside the
   *  cost rail; the `budget` stream event carries the moment it trips. */
  app.get<{ Querystring: { showId?: string } }>("/api/budget", async (req, reply) => {
    try {
      const target = rt(req.query.showId, req as object);
      return { showId: target.showId, ...budgetState(target.showId) };
    } catch (e) {
      return reply.code(404).send({ error: (e as Error).message });
    }
  });

  /**
   * Anchor a show's spend window when the SESSION starts.
   *
   * It used to open on the first `/api/billing` read, which is whenever the
   * operator happened to open the cost rail — so "wallet moved" measured from
   * the moment they looked, reported ≤ $0.0000, and was useless as a session
   * cost. One wallet read at attach is the price of the number meaning what it
   * says.
   */
  // Shows resumed at boot never had their spend anchored, so the per-show cap
  // could not trip on them. Anchor every live show once the app is up.
  setTimeout(() => {
    void (async () => {
      for (const s of await shows.list().catch(() => [])) await anchorSpend(s.showId).catch(() => {});
    })();
  }, 5_000).unref?.();
  const anchorSpend = async (showId: string): Promise<void> => {
    const w = await billing.wallet();
    if (w.ok) spendWindow.open(showId, w.value.balanceUsd);
  };

  /** One reader, two routes: `/api/billing` is the live rail, `/api/cost` is the
   *  history. They must never disagree about what the wallet says. */
  const billingSnapshot = async (days: number) => {
    // Both reads in flight together — this panel is polled, and two sequential
    // round-trips to the gateway is a visibly slower page for no reason.
    const [walletR, usageR] = await Promise.all([billing.wallet(), billing.usage(days)]);

    const wallet = walletR.ok ? walletR.value : null;
    if (wallet) {
      // The process window opens on the first successful read, so "spent since
      // the server started" is available without a separate bootstrap step.
      spendWindow.open("process", wallet.balanceUsd);
      for (const s of await shows.list()) spendWindow.open(s.showId, wallet.balanceUsd);
    }

    return {
      // A failed read reports WHY. A missing scope and a zero balance are
      // different facts and must never render the same.
      wallet: walletR.ok ? walletR.value : null,
      walletError: walletR.ok ? null : walletR.error,
      usage: usageR.ok ? usageR.value : null,
      usageError: usageR.ok ? null : usageR.error,
      meter: meter.snapshot(),
      spend: wallet ? spendWindow.since(wallet.balanceUsd) : {},
      attribution: {
        perShow: "app-metered",
        // Said in the payload, not only in the docs, so any client that renders
        // this cannot accidentally present the bound as an exact cost.
        note:
          "Wallet deltas are org-wide upper bounds. Per-show call counts come from " +
          "this app's own meter because the platform's usage rows carry no agent_id " +
          "for text turns.",
      },
    };
  };

  app.get<{ Querystring: { days?: string } }>("/api/billing", async (req) =>
    billingSnapshot(Math.min(90, Math.max(1, Number(req.query.days) || 7))),
  );

  /** The report a finished session left behind. */
  app.get<{ Params: { showId: string } }>("/api/shows/:showId/report", async (req, reply) => {
    const r = await pgPool().query<{ report: unknown; generated_at: Date }>(
      "SELECT report, generated_at FROM show_reports WHERE show_id = $1", [req.params.showId],
    );
    if (!r.rows[0]) return reply.code(404).send({ error: "no report for this show yet" });
    return { ...(r.rows[0].report as object), generatedAt: r.rows[0].generated_at };
  });

  /**
   * Delete a past session — and the agent it owned.
   *
   * An agent per stream means agents accumulate, so a session the operator is
   * finished with has to be able to take its agent with it. Only an agent THIS
   * app created for THIS show is removed: a catalog's long-lived agent is
   * shared and must survive a session that merely borrowed it.
   *
   * The row goes whether or not the gateway agreed to delete the agent. A
   * session the operator asked to remove should disappear from their list, and
   * an agent we failed to delete is a thing to report rather than a reason to
   * keep the session.
   */
  app.delete<{ Params: { showId: string } }>("/api/shows/:showId", async (req, reply) => {
    if (!mustWrite(req as object, reply)) return;
    const showId = req.params.showId;

    const row = (
      await pgPool().query<{ agent_id: string | null; agent_owned: boolean }>(
        "SELECT agent_id, agent_owned FROM shows WHERE id = $1", [showId],
      )
    ).rows[0];
    if (!row) return reply.code(404).send({ error: `no show ${showId}` });

    // Stop watching before deleting: a live watcher would keep writing lots
    // into rows that are on their way out.
    kb.cancel(showId);
    await shows.detach(showId).catch(() => null);

    const agent = row.agent_id && row.agent_owned
      ? await deleteStreamAgent(row.agent_id)
      : { ok: true, detail: row.agent_id ? "agent is shared — left in place" : "no agent" };

    // Everything else cascades: listings, chat, proposals, audit, sales, report.
    await pgPool().query("DELETE FROM shows WHERE id = $1", [showId]);
    // The rows cascade; the bytes on disk do not.
    signals.purge(showId);
    hub.emit("shows", await shows.list());
    return { ok: true, showId, agent };
  });

  /**
   * Every show behind this seller — the "past shows" list.
   *
   * Built from `shows`, LEFT JOINed to its report, not from `show_reports`:
   * report generation is fire-and-forget at session close (`runtime.ts`), so a
   * session that ended badly produced no report — and a list built from reports
   * made exactly the show you most want to look at disappear. A row with no
   * report is still a row; it says so.
   */
  app.get<{ Querystring: { limit?: string } }>("/api/reports", async (req) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const r = await pgPool().query<{
      show_id: string; title: string; source: string; started_at: Date; status: string;
      viewers: number; agent_id: string | null; generated_at: Date | null; report: ShowReport | null;
    }>(
      `SELECT s.id AS show_id, s.title, s.source, s.started_at, s.status, s.viewers, s.agent_id,
              r.generated_at, r.report
         FROM shows s
         LEFT JOIN show_reports r ON r.show_id = s.id
        WHERE s.owner_account_id IS NULL OR s.owner_account_id = $2
        ORDER BY COALESCE(r.generated_at, s.started_at::timestamptz) DESC
        LIMIT $1`,
      [limit, actorOf(req as object)?.id ?? null],
    );
    return r.rows.map((x) => ({
      showId: x.show_id,
      title: x.report?.title ?? x.title,
      source: x.source,
      status: x.status,
      startedAt: x.started_at,
      viewers: x.viewers,
      agentId: x.agent_id,
      generatedAt: x.generated_at,
      /** Null on a session whose report never generated — which is a state to
       *  show, not a row to hide. */
      durationMin: x.report?.durationMin ?? null,
      questionsAsked: x.report?.engagement.questionsAsked ?? null,
      answered: x.report?.engagement.answered ?? null,
      sent: x.report?.engagement.sent ?? null,
      blocked: x.report?.safety.blocked ?? null,
      hasReport: Boolean(x.report),
    }));
  });

  /**
   * Cost, with a history.
   *
   * `/api/billing` answers "right now" from process memory, which a restart
   * erases. This reads the rows every finished session writes, so the seller
   * can see what last week cost — and it keeps the two kinds of number apart:
   * calls are EXACT (this app makes them), dollars are an UPPER BOUND (the
   * wallet is workspace-wide, and the caveat travels with the figure).
   */
  app.get<{ Querystring: { days?: string } }>("/api/cost", async (req, reply) => {
    const actor = actorOf(req as object);
    if (!actor) return reply.code(401).send({ error: "sign in to see your costs" });
    const days = Math.min(120, Math.max(1, Number(req.query.days) || 30));
    const since = new Date(Date.now() - days * 86_400_000).toISOString();

    // This page is the SELLER's, not the workspace's. The backend holds one
    // Whissle key for everyone, so the wallet is shared and its balance is
    // nobody's number to see. What a seller can see is what their own shows
    // consumed: the app's own meter per show, and the wallet delta while the
    // show ran — which is theirs only when no other show ran at the same time.
    const [rows, snapshot, learned] = await Promise.all([
      pgPool().query<{
        show_id: string; title: string; opened_at: Date; closed_at: Date; duration_min: number;
        calls: number; failures: number; context_chars: number;
        by_door: Record<string, { calls: number; failures: number; totalMs: number }>;
        wallet_delta_usd: string | null; answered: number; exclusive: boolean;
      }>(
        `SELECT c.show_id, s.title, c.opened_at, c.closed_at, c.duration_min, c.calls, c.failures,
                c.context_chars, c.by_door, c.wallet_delta_usd, c.answered,
                NOT EXISTS (
                  SELECT 1 FROM show_costs o
                   WHERE o.show_id <> c.show_id AND o.opened_at < c.closed_at AND o.closed_at > c.opened_at
                ) AS exclusive
           FROM show_costs c JOIN shows s ON s.id = c.show_id
          WHERE c.closed_at >= $1 AND (c.account_id = $2 OR (c.account_id IS NULL AND s.owner_account_id = $2))
          ORDER BY c.closed_at DESC`,
        [since, actor.id],
      ),
      billingSnapshot(7),
      // The measured price of one gateway call, from every show that ran
      // alone with a readable wallet — across all sellers, because the key
      // and the tariff are shared even though the spend is not.
      pgPool().query<{ usd: string | null; calls: string | null }>(
        `SELECT SUM(c.wallet_delta_usd) AS usd, SUM(c.calls) AS calls
           FROM show_costs c
          WHERE c.wallet_delta_usd IS NOT NULL AND c.wallet_delta_usd > 0 AND c.calls > 0
            AND NOT EXISTS (
              SELECT 1 FROM show_costs o
               WHERE o.show_id <> c.show_id AND o.opened_at < c.closed_at AND o.closed_at > c.opened_at
            )`,
      ),
    ]);
    const learnedUsd = Number(learned.rows[0]?.usd ?? 0);
    const learnedCalls = Number(learned.rows[0]?.calls ?? 0);
    /** Measured 2026-09-15: $0.52 over 80 calls on a nine-minute show. */
    const usdPerCall = learnedCalls >= 20 && learnedUsd > 0 ? learnedUsd / learnedCalls : 0.0065;

    const shows = rows.rows.map((r) => {
      const walletDeltaUsd = r.wallet_delta_usd == null ? null : Number(r.wallet_delta_usd);
      const basis: "wallet-exclusive" | "metered" | "none" =
        walletDeltaUsd != null && r.exclusive ? "wallet-exclusive" : r.calls > 0 ? "metered" : "none";
      const estimatedUsd =
        basis === "wallet-exclusive" ? walletDeltaUsd! : basis === "metered" ? Math.round(r.calls * usdPerCall * 10000) / 10000 : null;
      return {
        showId: r.show_id,
        title: r.title,
        openedAt: r.opened_at,
        closedAt: r.closed_at,
        durationMin: r.duration_min,
        calls: r.calls,
        failures: r.failures,
        contextChars: Number(r.context_chars),
        byDoor: r.by_door ?? {},
        /** The wallet's movement while this show ran. Shared wallet: only a
         *  show that ran alone can call it its own. Null = unreadable. */
        walletDeltaUsd,
        estimatedUsd,
        basis,
        answered: r.answered,
      };
    });

    // Totals are summed from the rows, so the page's two tables cannot disagree.
    const byDoor: Record<string, { calls: number; failures: number; totalMs: number }> = {};
    for (const s of shows) {
      for (const [door, d] of Object.entries(s.byDoor)) {
        const acc = byDoor[door] ?? { calls: 0, failures: 0, totalMs: 0 };
        acc.calls += d.calls; acc.failures += d.failures; acc.totalMs += d.totalMs;
        byDoor[door] = acc;
      }
    }
    const estimatedUsd = shows.reduce((a, s) => a + (s.estimatedUsd ?? 0), 0);
    const answered = shows.reduce((a, s) => a + s.answered, 0);
    const minutes = shows.reduce((a, s) => a + s.durationMin, 0);

    return {
      days,
      scope: { accountId: actor.id, handle: actor.handle },
      shows,
      totals: {
        shows: shows.length,
        calls: shows.reduce((a, s) => a + s.calls, 0),
        contextChars: shows.reduce((a, s) => a + s.contextChars, 0),
        estimatedUsd: Math.round(estimatedUsd * 10000) / 10000,
        /** Kept for older clients; the same number. */
        spentUsd: Math.round(estimatedUsd * 10000) / 10000,
        metered: shows.filter((s) => s.basis === "metered").length,
        answered,
        minutes,
        perAnsweredUsd: answered ? Math.round((estimatedUsd / answered) * 100000) / 100000 : null,
        perHourUsd: minutes ? Math.round((estimatedUsd / (minutes / 60)) * 10000) / 10000 : null,
        showsWithoutWallet: shows.filter((s) => s.basis === "none").length,
        usdPerCall: Math.round(usdPerCall * 100000) / 100000,
      },
      byDoor,
      /** What is running right now, for this seller, which the rows cannot know yet. */
      live: Object.fromEntries(
        Object.entries(snapshot.meter.byShow).filter(([id]) => {
          const s = shows.find((x) => x.showId === id);
          return s ? true : shows.length === 0 ? false : true;
        }),
      ),
      attribution: snapshot.attribution,
    };
  });

  /**
   * Every catalog, with where it came from. A catalog named `ebay-<eventId>`
   * is a preparation of someone's live show; `ebay-<handle>` is the seller's
   * own listings, imported; anything else shipped as a demo. The name alone
   * told an operator none of that, so the Catalog page could not say which
   * show a lineup belonged to or link back to it.
   */
  /** Which catalogs this account may see: the seeds, its own imports, and the
   *  shows it prepared. Another seller's preparation is not a thing it can
   *  even list. */
  const visibleCatalogs = async (req: object) => {
    const a = actorOf(req);
    const prepared = await preparer.list(a?.id ?? null).catch(() => []);
    const mine = new Set(prepared.map((p) => p.catalogId).filter(Boolean) as string[]);
    return {
      prepared,
      list: listCatalogs().filter((c) => {
        const eventShaped = /^ebay-[A-Za-z0-9]{16}$/.test(c.id);
        if (mine.has(c.id)) return true;
        if (eventShaped) return false; // somebody else's preparation
        if (c.id.startsWith("ebay-")) return a ? c.id === `ebay-${a.handle}` : false; // imports are per account
        return true; // seeds
      }),
    };
  };
  const catalogFor = async (req: object, id: string) => (await visibleCatalogs(req)).list.find((c) => c.id === id) ? getCatalog(id) : null;

  app.get("/api/catalogs", async (req) => {
    const { prepared, list } = await visibleCatalogs(req as object);
    const byCatalog = new Map(prepared.filter((p) => p.catalogId).map((p) => [p.catalogId as string, p]));
    return list.map((c) => {
      const p = byCatalog.get(c.id);
      // An event id is sixteen alphanumerics; a seller handle is not. A
      // catalog shaped like a preparation whose row is gone (dropped, or made
      // on another machine) is still a show's lineup, not "your listings".
      const eventShaped = /^ebay-[A-Za-z0-9]{16}$/.test(c.id);
      const origin = p
        ? { kind: "prepared" as const, eventId: p.eventId, showTitle: p.title, host: p.host, sellerHandle: p.sellerHandle, preparedAt: p.preparedAt as string | null }
        : eventShaped
          ? { kind: "prepared" as const, eventId: c.id.slice(5), showTitle: c.name, host: c.seller?.name ?? "", sellerHandle: c.seller?.handle ?? null, preparedAt: null as string | null }
          : c.id.startsWith("ebay-")
            ? { kind: "imported" as const, handle: c.id.slice(5) }
            : { kind: "seed" as const };
      return { ...c, origin };
    });
  });

  /**
   * Is this catalog ready to run a show?
   *
   * Asked BEFORE monitoring starts, because a session that begins with half its
   * grounding missing does not fail — it abstains on every question, which
   * reads as a cautious model rather than an absent corpus.
   */
  app.get<{ Params: { id: string }; Querystring: { showId?: string } }>(
    "/api/catalogs/:id/readiness",
    async (req, reply) => {
      const cat = await catalogFor(req as object, req.params.id);
      if (!cat) return reply.code(404).send({ error: `no catalog ${req.params.id}` });
      // The show's own agent outranks whatever the catalog file remembers.
      let agentId: string | null = null;
      if (req.query.showId) {
        try {
          agentId = shows.get(req.query.showId).agentId || null;
        } catch {
          agentId = null;
        }
      }
      const readiness = await checkReadiness(cat, { agentId });
      // The gaps the last finished show on this catalog left behind — carried
      // here because this is where they can still be closed.
      const last = await pgPool().query<{ show_id: string; title: string; report: ShowReport }>(
        `SELECT r.show_id, s.title, r.report FROM show_reports r JOIN shows s ON s.id = r.show_id
          WHERE s.catalog_id = $1 AND s.status = 'ended' AND ($2::text IS NULL OR s.id <> $2)
            AND (s.owner_account_id IS NULL OR s.owner_account_id = $3)
          ORDER BY r.generated_at DESC LIMIT 1`,
        [cat.id, req.query.showId ?? null, actorOf(req as object)?.id ?? null],
      ).catch(() => null);
      const row = last?.rows[0];
      readiness.carried = row?.report?.gaps?.unanswered?.length
        ? {
            fromShowId: row.show_id,
            title: row.title,
            endedAt: row.report.endedAt,
            gaps: row.report.gaps.unanswered.slice(0, 10),
          }
        : null;
      return readiness;
    },
  );

  /**
   * The evidence behind a report: every comment, proposal, action and audit
   * entry, from the tables that kept them. Works after the show is gone.
   */
  app.get<{ Params: { showId: string } }>("/api/shows/:showId/record", async (req, reply) => {
    const exists = await pgPool().query("SELECT 1 FROM shows WHERE id = $1", [req.params.showId]);
    if (!exists.rowCount) return reply.code(404).send({ error: `no show ${req.params.showId}` });
    return showRecord(pgPool(), req.params.showId);
  });

  /**
   * Everything the product knows about one show, as one JSON document: the
   * show row, its report, the full record and the signal timeline. Media bytes
   * are referenced by their routes rather than inlined — a two-hour show is
   * thirty megabytes of audio, and a download is not the place for it.
   */
  app.get<{ Params: { showId: string } }>("/api/shows/:showId/export", async (req, reply) => {
    const id = req.params.showId;
    const show = await pgPool().query(
      `SELECT id, title, seller_handle, source, external_id, status, started_at, viewers, catalog_id,
              agent_id, write_target, autonomy_level, read_only
         FROM shows WHERE id = $1`, [id],
    );
    if (!show.rowCount) return reply.code(404).send({ error: `no show ${id}` });
    const [report, record, utterances, frames, audio, host] = await Promise.all([
      pgPool().query<{ report: unknown; generated_at: Date }>(
        "SELECT report, generated_at FROM show_reports WHERE show_id = $1", [id],
      ),
      showRecord(pgPool(), id),
      signals.utterances(id), signals.frames(id), signals.audio(id), signals.hostSummary(id),
    ]);
    reply.header("content-disposition", `attachment; filename="sidestage-${id}.json"`);
    return {
      exportedAt: new Date().toISOString(),
      show: show.rows[0],
      report: report.rows[0]?.report ?? null,
      reportGeneratedAt: report.rows[0]?.generated_at ?? null,
      record,
      signals: {
        host,
        utterances,
        frames: frames.map((f) => ({ ...f, path: undefined, url: `/api/shows/${id}/media/frames/${f.seq}` })),
        audio: audio.map((a) => ({ ...a, path: undefined, url: `/api/shows/${id}/media/audio/${a.seq}` })),
      },
    };
  });

  /**
   * Close a gap: the answer a question should have had, written into the
   * catalog so the NEXT show is grounded on it.
   *
   * The report has listed unanswered questions since it was written, and there
   * was nothing to do about one except edit JSON by hand. When the named show
   * is still live, the answer lands in its own Q&A table too, so the gap closes
   * now rather than next Friday.
   */
  app.post<{
    Params: { id: string };
    Body: { question?: string; answer?: string; tags?: string; showId?: string };
  }>("/api/catalogs/:id/qa", async (req, reply) => {
    const actor = mustWrite(req as object, reply, "edit the catalog");
    if (!actor) return reply;

    const question = (req.body?.question ?? "").trim();
    const answer = (req.body?.answer ?? "").trim();
    if (!question || !answer) {
      return reply.code(400).send({ error: "both a question and an answer are required" });
    }
    const row = addCatalogQa(req.params.id, {
      question,
      answer,
      ...(req.body?.tags ? { tags: req.body.tags } : {}),
      ...(req.body?.showId ? { fromShowId: req.body.showId } : {}),
    });
    if (!row) return reply.code(404).send({ error: `no catalog ${req.params.id}` });

    // If that show is still running, ground it immediately rather than at the
    // next attach — the seller answered the question thirty seconds ago.
    let appliedLive = false;
    try {
      const live = rt(req.body?.showId ?? null, req as object);
      if (live) {
        await live.repo.insertQa({ id: row.id, question: row.question, answer: row.answer, tags: row.tags ?? "" });
        await live.refreshIndex();
        appliedLive = true;
      }
    } catch {
      /* the show has ended — the catalog write is the point either way */
    }

    return { qa: row, catalogId: req.params.id, appliedLive };
  });

  /**
   * The catalog priced against the real market — the whole lineup, not one lot.
   *
   * Served from cache and never blocking on eBay: a miss comes back
   * `checking: true` and the page polls. `warm=1` kicks the whole catalog off
   * in the background, which is what the page does when it first opens.
   */
  app.get<{ Params: { id: string }; Querystring: { warm?: string } }>(
    "/api/catalogs/:id/market",
    async (req, reply) => {
      const cat = await catalogFor(req as object, req.params.id);
      if (!cat) return reply.code(404).send({ error: `no catalog ${req.params.id}` });
      if (req.query.warm === "1") void marketIndex.warm(cat.items).catch(() => {});
      return marketIndex.read(cat.id, cat.items);
    },
  );

  /**
   * Search eBay's live catalog directly.
   *
   * The seller's own inventory is one question; "what else is out there" is
   * another, and it is the one they ask when pricing a lot they have not listed
   * yet. This one DOES wait on eBay, because a human typed a query and pressed
   * enter — nothing is watching a queue.
   */
  app.get<{ Querystring: { q?: string; limit?: string; sold?: string } }>(
    "/api/ebay/search",
    async (req, reply) => {
      const q = (req.query.q ?? "").trim();
      if (!q) return reply.code(400).send({ error: "a query is required" });
      const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 12));
      try {
        if (req.query.sold === "1") {
          const rows = await ebay.soldComps(q, { limit });
          return { basis: "sold", query: q, rows };
        }
        const rows = await ebay.search(q, { limit });
        return { basis: "asking", query: q, rows };
      } catch (e) {
        return reply.code(502).send({ error: (e as Error).message });
      }
    },
  );

  app.post("/api/catalogs/reload", async () => {
    reloadCatalogs();
    return listCatalogs();
  });

  // ── shows ─────────────────────────────────────────────────────────────────
  app.get("/api/shows", async (req) => shows.list(actorOf(req as object)?.id));

  /**
   * Best-effort list of eBay Live shows currently on air.
   *
   * `sellerHandle` is the field the console reads; `host` is kept because the
   * CLI printed it first. They are the same string — the console showed "—"
   * under every card for as long as only one of them existed.
   */
  app.get<{ Querystring: { limit?: string } }>("/api/shows/discover", async (req, reply) => {
    try {
      const limit = Math.min(30, Number(req.query.limit) || 12);
      const { shows, reason, session } = await discoverLiveShows({ limit });
      if (reason === "ok") rememberGrid(shows);
      // The reason travels with the list. "Nobody is on air" and "sign in to
      // eBay first" are both empty grids and completely different instructions.
      return { shows, reason, session };
    } catch (e) {
      return reply.code(502).send({ error: `discovery failed: ${(e as Error).message}` });
    }
  });

  /**
   * Is the eBay application actually reachable, and what does it reach?
   *
   * Names the two APIs an app token gets and the one it does not, so nobody has
   * to discover the sold-comps 403 from a research card that quietly said
   * "median comp" over asking prices.
   */
  app.get("/api/ebay/status", async (req) => {
    const [read, actor] = [await ebay.check(), actorOf(req as object)];
    const connection = actor ? await ebayAuth.connection(actor.id).catch(() => null) : null;
    return {
      ...read,
      // The two halves are genuinely different capabilities and the UI must not
      // merge them: reads work for everyone with an application key; writes need
      // this particular seller to have consented.
      write: {
        connected: Boolean(connection?.valid),
        connectedAt: connection?.connectedAt ?? null,
        scopes: connection?.scopes ?? [],
        blockers: ebayAuth.blockers,
      },
    };
  });

  /**
   * Begin the consent round trip.
   *
   * Returns the URL rather than redirecting: the console is a single-page app
   * and a 302 out of an XHR is a silent failure. The caller opens it.
   */
  /**
   * eBay's Marketplace Account Deletion endpoint — unauthenticated by design,
   * because eBay is the caller. The GET is eBay checking we own the URL and
   * the token; the POST is a member having closed their account, after which
   * nothing about them may remain here. See ingest/ebay/deletion.ts.
   */
  app.get<{ Querystring: { challenge_code?: string } }>("/api/ebay/account-deletion", async (req, reply) => {
    const { verificationToken: token, endpoint } = config.ebayDeletion;
    if (!token || !endpoint) {
      return reply.code(503).send({ error: "account-deletion notifications are not configured (EBAY_DELETION_VERIFICATION_TOKEN, EBAY_DELETION_ENDPOINT)" });
    }
    const code = (req.query.challenge_code || "").trim();
    if (!code) return reply.code(400).send({ error: "challenge_code is required" });
    return reply.type("application/json").send({
      challengeResponse: challengeResponse(code, { verificationToken: token, endpointUrl: endpoint }),
    });
  });

  // Registered in its own scope so this one route keeps the RAW body: the
  // signature is over the bytes eBay sent, not over our re-serialisation.
  await app.register(async (sub) => {
    // The inherited JSON parser has already consumed the body by the time a
    // handler runs; this scope replaces it with one that keeps the bytes.
    sub.removeContentTypeParser("application/json");
    sub.addContentTypeParser("application/json", { parseAs: "string" }, (rq, body, done) => {
      (rq as unknown as { rawBody: string }).rawBody = String(body);
      try {
        done(null, body ? JSON.parse(String(body)) : {});
      } catch (e) {
        done(e as Error, undefined);
      }
    });
    sub.post("/api/ebay/account-deletion", async (req, reply) => {
      const notice = parseNotice(req.body);
      // Anything that is not a deletion notice is acknowledged and ignored: eBay
      // retries on non-2xx, and there is nothing to retry.
      if (!notice) return reply.code(200).send({ ok: true, ignored: true });
      // Acknowledge always; honour only what eBay signed. A forged notice was
      // a way to disconnect any seller by username, and eBay's own retry
      // semantics mean a 2xx is still the right answer to a bad one.
      const raw = (req as unknown as { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {});
      const verdict = await verifyNotification(raw, req.headers["x-ebay-signature"] as string | undefined, async (kid) => {
        const token = await ebay.appToken();
        const r = await fetch(`${config.ebay.env === "production" ? "https://api.ebay.com" : "https://api.sandbox.ebay.com"}/commerce/notification/v1/public_key/${encodeURIComponent(kid)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        return r.ok ? ((await r.json()) as { key: string; digest?: string }) : null;
      });
      if (!verdict.ok) {
        console.warn(`  ebay: deletion notice ${notice.notificationId} NOT honoured — ${verdict.reason}`);
        return reply.code(200).send({ ok: true, honoured: false, reason: verdict.reason });
      }
      const removed = await honourDeletion(pgPool(), notice).catch(() => 0);
      return reply.code(200).send({ ok: true, honoured: true, removed });
    });
  });

  app.post("/api/ebay/connect", async (req, reply) => {
    const actor = mustWrite(req as object, reply, "connect an eBay account");
    if (!actor) return reply;
    try {
      return await ebayAuth.begin(actor.id);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  /**
   * Where eBay sends the seller back.
   *
   * A browser lands here, not an XHR, so it answers with a page rather than
   * JSON — and it never echoes the code or the state back into the document.
   */
  app.get<{ Querystring: { code?: string; state?: string; error_description?: string } }>(
    "/api/ebay/callback",
    async (req, reply) => {
      const { code, state } = req.query;
      const fail = (msg: string) =>
        reply.code(400).type("text/html").send(closingPage("Could not connect eBay", msg, false));

      if (req.query.error_description) return fail(req.query.error_description);
      if (!code) return fail("eBay sent no authorisation code.");
      // The developer portal's "Test Sign-In" lands here with a code but no
      // state, because it did not start from an account in this app. Say so,
      // rather than blaming eBay for a code that is plainly in the URL.
      if (!state) {
        return fail(
          "This sign-in did not start from SideStage, so there is no account to attach it to. " +
            "Open Settings → eBay in the app and press Connect eBay; that link carries the state eBay hands back here.",
        );
      }
      try {
        await ebayAuth.complete(code, state);
        return reply
          .type("text/html")
          .send(
            closingPage(
              "eBay connected",
              "Price, stock and end-listing actions now act on your real listings.",
              true,
            ),
          );
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  /**
   * Arm this show's writes against eBay, or put them back on the mock.
   *
   * Explicit and per show. The alternative — inferring it from whether a
   * connection exists — means an operator finds out which marketplace they
   * edited after the fact, which is the one thing the audit chain exists to
   * make impossible.
   */
  app.post<{ Params: { showId: string }; Body: { target?: "mock" | "ebay" } }>(
    "/api/shows/:showId/write-target",
    async (req, reply) => {
      const actor = mustWrite(req as object, reply, "change where writes land");
      if (!actor) return reply;
      const target = req.body?.target === "ebay" ? "ebay" : "mock";
      try {
        const rt = shows.get(req.params.showId);
        const now = await rt.setWriteTarget(target);
        await rt.audit.append(
          "autonomy_changed",
          "seller",
          `write target set to ${now === "ebay" ? "the seller's real eBay listings" : "the mock marketplace"}`,
          { writeTarget: now },
          actor.id,
        );
        hub.emit("shows", await shows.list());
        return { showId: req.params.showId, writeTarget: now };
      } catch (e) {
        return reply.code(409).send({ error: (e as Error).message });
      }
    },
  );

  app.delete("/api/ebay/connect", async (req, reply) => {
    const actor = mustWrite(req as object, reply, "disconnect an eBay account");
    if (!actor) return reply;
    await ebayAuth.disconnect(actor.id);
    return { ok: true };
  });

  /**
   * Import the seller's own eBay listings as a catalog.
   *
   * This is the other half of connecting: until now a catalog was a JSON file
   * someone wrote by hand, which is fine for a fixture and absurd for a seller
   * with four hundred listings. Their inventory already exists; this reads it.
   */
  app.post<{ Body: { catalogId?: string; limit?: number } }>(
    "/api/ebay/import",
    async (req, reply) => {
      const actor = mustWrite(req as object, reply, "import listings");
      if (!actor) return reply;
      const token = await ebayAuth.userToken(actor.id).catch(() => null);
      if (!token) {
        return reply.code(409).send({ error: "connect an eBay account before importing" });
      }
      try {
        const result = await importSellerListings({
          token,
          env: config.ebay.env as "sandbox" | "production",
          catalogId: (req.body?.catalogId || `ebay-${actor.handle}`).slice(0, 60),
          limit: Math.min(500, Math.max(1, req.body?.limit ?? 200)),
        });
        reloadCatalogs();
        return result;
      } catch (e) {
        return reply.code(502).send({ error: (e as Error).message });
      }
    },
  );

  // ── getting ready for a show before it starts ────────────────────────────
  /** Preparations running right now, so the UI can show progress per event. */
  const preparing = new Set<string>();

  // Unscoped on purpose. A prepared show's agent is created on the workspace's
  // Whissle key and its catalog sits in the shared catalogs directory — it is a
  // workspace resource, and scoping the LIST by whichever session happened to
  // click "prepare" made the same show read as prepared in one browser and not
  // in another.
  app.get("/api/shows/prepared", async () => {
    return {
      prepared: await preparer.list(),
      preparing: [...preparing],
      session: sessionStatus(),
    };
  });

  /**
   * Build a catalog and an agent for one eBay Live event.
   *
   * Answers immediately and works in the background: several Browse calls plus
   * an agent creation take the better part of a minute, and a seller clicking
   * "prepare" on four shows should not be watching a spinner for four of them.
   */
  app.post<{
    Body: {
      eventId?: string; title?: string; host?: string;
      sellerHandle?: string | null; tags?: string[]; thumbnailUrl?: string | null;
    };
  }>("/api/shows/prepare", async (req, reply) => {
    const actor = mustWrite(req as object, reply, "prepare a show");
    if (!actor) return reply;
    const eventId = (req.body?.eventId ?? "").trim();
    const title = (req.body?.title ?? "").trim();
    if (!eventId || !title) {
      return reply.code(400).send({ error: "an eventId and a title are required" });
    }
    if (preparing.has(eventId)) return { eventId, status: "already-preparing" };

    preparing.add(eventId);
    void preparer
      .prepare({
        eventId,
        title,
        host: req.body?.host ?? "",
        sellerHandle: req.body?.sellerHandle ?? null,
        tags: req.body?.tags ?? [],
        thumbnailUrl: req.body?.thumbnailUrl ?? null,
        accountId: actor.id,
      })
      .catch((e) => console.warn(`[prepare] ${eventId}: ${(e as Error).message}`))
      .finally(() => preparing.delete(eventId));

    return { eventId, status: "preparing" };
  });

  app.delete<{ Params: { eventId: string } }>(
    "/api/shows/prepared/:eventId",
    async (req, reply) => {
      const actor = mustWrite(req as object, reply, "drop a prepared show");
      if (!actor) return reply;
      const mine = (await preparer.list(actor.id)).some((p) => p.eventId === req.params.eventId);
      if (!mine) return reply.code(404).send({ error: `no prepared show ${req.params.eventId}` });
      return preparer.drop(req.params.eventId);
    },
  );

  /**
   * One seller's eBay Live page: their live show and what they have scheduled.
   *
   * The only place eBay puts an upcoming show. Reads a page, so it is on
   * demand — per seller, when asked — never fanned out across the whole grid.
   */
  app.get<{ Params: { handle: string } }>("/api/shows/seller/:handle", async (req, reply) => {
    try {
      const r = await discoverSellerShows(req.params.handle);
      return { handle: req.params.handle, shows: r.shows, reason: r.reason };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  /** The whole home surface in one read: live now, what is prepared, your shows. */
  app.get<{ Querystring: { refresh?: string } }>("/api/home", async (req) => {
    const [discovery, prepared, watched] = await Promise.all([
      req.query.refresh === "1"
        ? discoverLiveShows({ limit: 24 })
        : Promise.resolve(cachedDiscovery()),
      preparer.list(actorOf(req as object)?.id ?? null),
      shows.list(actorOf(req as object)?.id),
    ]);
    return {
      live: discovery.shows,
      // `checkedAt` is when the grid was last actually read — the number the
      // Discover tab should show beside Refresh. The session's age is a
      // different fact and was being mistaken for it.
      discovery: { reason: discovery.reason, session: discovery.session, checkedAt: gridCheckedAt() },
      prepared,
      preparing: [...preparing],
      watching: watched,
    };
  });

  // ── sellers you follow ────────────────────────────────────────────────────
  //
  // Not a subscription: there is nothing to subscribe to. A follow is a handle
  // we match against the live grid whenever the grid answers, and every response
  // carries `checkedAt` so the console can say how long ago that was instead of
  // rendering "not live" over a check that never happened.
  const following = new Following(pgPool());

  app.get("/api/following", async (req) => {
    const a = actorOf(req as object);
    const sellers = a ? await following.list(a.id) : [];
    return { sellers, checkedAt: gridCheckedAt(), checking: cachedGrid().checking };
  });

  app.post("/api/following/refresh", async (req, reply) => {
    const actor = mustWrite(req as object, reply, "keep a list of sellers");
    if (!actor) return reply;
    await liveGrid({ force: true });
    return { sellers: await following.list(actor.id), checkedAt: gridCheckedAt(), checking: false };
  });

  app.post<{ Body: { handle?: string; note?: string } }>("/api/following", async (req, reply) => {
    const actor = mustWrite(req as object, reply, "keep a list of sellers");
    if (!actor) return reply;
    const handle = (req.body?.handle ?? "").trim();
    if (!handle) return reply.code(400).send({ error: "a seller handle is required" });
    try {
      const sellers = await following.add(actor.id, handle, req.body?.note);
      return { sellers, checkedAt: gridCheckedAt(), checking: cachedGrid().checking };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.delete<{ Params: { handle: string } }>("/api/following/:handle", async (req, reply) => {
    const actor = mustWrite(req as object, reply, "keep a list of sellers");
    if (!actor) return reply;
    return {
      sellers: await following.remove(actor.id, req.params.handle),
      checkedAt: gridCheckedAt(),
      checking: cachedGrid().checking,
    };
  });

  // ── the rooms we are allowed to speak in ──────────────────────────────────
  //
  // Posting into somebody else's room is irreversible in the way that matters:
  // the undo window can delete the comment, it cannot unsee it, and the price
  // of getting it wrong is the operator's own account banned from a place they
  // have posted in for years. So a room is a record of a HUMAN switching it on,
  // it is off until they do, and a room with no row is off rather than unknown.
  const rooms = new SurfaceRooms(pgPool());

  /** A surface we actually know about. 404 rather than an empty list, because
   *  "no rooms on twitchh" reads as an answer and is a typo. */
  const knownSurface = (
    raw: string,
    reply: { code(n: number): { send(b: unknown): unknown } },
  ): SurfaceId | null => {
    const id = raw.trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(SURFACE_CAPABILITIES, id)) return id as SurfaceId;
    reply.code(404).send({ error: `no surface called "${raw}"`, surfaces: Object.keys(SURFACE_CAPABILITIES) });
    return null;
  };

  /** Every surface this build knows, with what it can do and whether an
   *  adapter is wired for it yet. The console reads this to decide which
   *  columns a session even has. */
  app.get("/api/surfaces", async () => {
    const wired = new Set(surfaceAdapters().map((a) => a.id));
    return {
      surfaces: (Object.keys(SURFACE_CAPABILITIES) as SurfaceId[]).map((id) => ({
        id,
        label: surfaceAdapters().find((a) => a.id === id)?.label ?? id,
        capabilities: capabilitiesOf(id),
        attachable: wired.has(id),
      })),
    };
  });

  app.get<{ Params: { surface: string } }>("/api/surfaces/:surface/rooms", async (req, reply) => {
    const surface = knownSurface(req.params.surface, reply);
    if (!surface) return reply;
    const a = actorOf(req as object);
    return { surface, rooms: a ? await rooms.list(a.id, surface) : [] };
  });

  app.post<{ Params: { surface: string }; Body: { room?: string; posting?: boolean; disclosure?: string | null } }>(
    "/api/surfaces/:surface/rooms",
    async (req, reply) => {
      const actor = mustWrite(req as object, reply, "watch a room");
      if (!actor) return reply;
      const surface = knownSurface(req.params.surface, reply);
      if (!surface) return reply;
      const room = (req.body?.room ?? "").trim();
      if (!room) return reply.code(400).send({ error: "a room is required — a subreddit, a channel or a conversation id" });
      // Turning posting ON for a surface that cannot deliver is not a setting
      // we are willing to store: it would show as on in the console and be
      // refused at preflight every time, which is worse than refusing here.
      if (req.body?.posting && capabilitiesOf(surface).delivery !== "api") {
        return reply.code(409).send({
          error: `${surface} is draft-only — replies there are yours to send, so posting cannot be turned on`,
          code: "draft-only",
        });
      }
      const saved = await rooms.upsert(actor.id, surface, room, {
        posting: req.body?.posting,
        disclosure: req.body?.disclosure,
      });
      return { surface, room: saved, rooms: await rooms.list(actor.id, surface) };
    },
  );

  app.delete<{ Params: { surface: string }; Querystring: { room?: string } }>(
    "/api/surfaces/:surface/rooms",
    async (req, reply) => {
      const actor = mustWrite(req as object, reply, "stop watching a room");
      if (!actor) return reply;
      const surface = knownSurface(req.params.surface, reply);
      if (!surface) return reply;
      const room = (req.query?.room ?? "").trim();
      if (!room) return reply.code(400).send({ error: "a room is required" });
      const removed = await rooms.remove(actor.id, surface, room);
      if (!removed) return reply.code(404).send({ error: `${room} is not on the list` });
      return { surface, removed: room, rooms: await rooms.list(actor.id, surface) };
    },
  );

  /**
   * Start a monitoring session: attach to a live eBay show AND load the catalog
   * the operator is selling from, in one call.
   *
   * The two belong together. A show with no catalog can only answer about the
   * lot on screen, and a catalog with no show has nothing to listen to — so the
   * setup screen asks for both and this is the one call it makes.
   */
  app.post<{ Body: { eventId?: string; url?: string; title?: string; host?: string; catalogId?: string; allowUnprepared?: boolean } }>(
    "/api/shows/attach",
    async (req, reply) => {
      const actor = mustWrite(req as object, reply, "attach a show");
      if (!actor) return reply;
      const input = (req.body?.eventId || req.body?.url || "").trim();
      if (!input) return reply.code(400).send({ error: "eventId or url is required" });

      // A show that was PREPARED is the whole reason preparing exists: its
      // catalog and its agent are already built. Attaching used to ignore that
      // and mint a second agent with an empty knowledge base — so the operator
      // did the preparation and then watched the copilot start from nothing.
      const eventId = parseEventId(input);
      let prepared = eventId ? await preparer.get(eventId).catch(() => null) : null;
      // The live grid we already read knows this show's real title and host;
      // the player page's own <title> is generic. Without this a show attached
      // by link was called "eBay Live 47tK1SX0VsiHEXN1" for its whole life.
      const seen = eventId ? cachedDiscovery().shows.find((s) => s.eventId === eventId) : undefined;

      let preparedCatalogId = prepared?.catalogId ?? null;
      if (preparedCatalogId && !getCatalog(preparedCatalogId)) {
        // The preparation's catalog file is gone (a deploy once wiped every
        // app-written catalog on the box). A stale preparation must not stop a
        // seller attaching to a live show: forget it, say so, and attach the
        // way an unprepared show attaches — its own agent, grounded from the
        // stream — rather than answering 400 to a perfectly good link.
        console.warn(`  attach: prepared catalog ${preparedCatalogId} for ${eventId} is missing — dropping the preparation`);
        await preparer.drop(eventId!).catch(() => {});
        preparedCatalogId = null;
        prepared = null; // its agent went with it; the attach below mints a fresh one
      }
      // Preparing is where a show's catalog and knowledge base come from. An
      // attach without it minted an agent with an empty knowledge base and the
      // copilot started from nothing — so preparation is the door now, unless
      // the caller brings a catalog of its own or says it knows what it is doing.
      if (!prepared && !req.body?.catalogId && !req.body?.allowUnprepared) {
        return reply.code(409).send({
          error: "prepare the agent for this show first — that is where its catalog and knowledge base are built",
          code: "prepare-first",
          eventId: eventId ?? null,
        });
      }
      const catalogId = (req.body?.catalogId || preparedCatalogId || "").trim();
      const catalog = catalogId ? getCatalog(catalogId) : null;
      if (catalogId && !catalog) return reply.code(400).send({ error: `unknown catalog "${catalogId}"` });

      try {
        // Is this the seller's OWN show? The only proof we accept is the eBay
        // username behind their consent matching the show's seller handle.
        // Everything else is watched read-only, and preflight refuses writes.
        const sellerHandle = (prepared?.sellerHandle || seen?.sellerHandle || req.body?.host || "").replace(/^@/, "").toLowerCase();
        const connection = await ebayAuth.connection(actor.id).catch(() => null);
        const own = Boolean(sellerHandle && connection?.ebayUsername && connection.ebayUsername.toLowerCase() === sellerHandle);
        const target = await shows.attachEbayLive(input, {
          ownerAccountId: actor.id,
          readOnly: !own,
          title: req.body?.title || prepared?.title || seen?.title,
          host:
            req.body?.host || prepared?.host || seen?.host || prepared?.sellerHandle || seen?.sellerHandle || undefined,
        });

        // ── this show's own agent ──────────────────────────────────────
        //
        // Created per STREAM, not per catalog. Every stream has a different
        // lineup, and several shows sharing one agent meant several shows
        // writing their lots into one knowledge base — which is exactly how
        // five dead show corpora ended up on one agent, each answerable with
        // total confidence about lots that sold days ago.
        //
        // The config is the same config; what is tweaked is the part that is
        // genuinely per-show. The show OWNS this agent and deleting the session
        // deletes it.
        try {
          const show = await target.show();
          // Reuse the prepared agent rather than creating a second one: it
          // already carries this show's lineup in its knowledge base.
          const agentId =
            prepared?.agentId ??
            (await createStreamAgent({
              showId: target.showId,
              showTitle: show.title,
              host: show.sellerHandle,
              seller: catalog?.seller,
              monitored: show.readOnly,
            }));
          target.useAgent(agentId);
          await pgPool().query(
            "UPDATE shows SET agent_id = $2, agent_owned = TRUE WHERE id = $1",
            [target.showId, agentId],
          );
        } catch (e) {
          // A show that cannot get its own agent falls back to the shared one
          // rather than refusing to start — degraded, and said so in readiness.
          console.warn(`  ${target.showId}: own agent not created (${(e as Error).message})`);
        }

        let applied = null;
        if (catalog) {
          // AWAITED. This used to be assigned unawaited, so the response
          // serialised a pending promise as `{}` and the row below was never
          // written — the catalog landed in memory, invisibly, and was gone on
          // the next restart because resume had no catalog_id to re-apply.
          applied = await applyCatalog(target.repo, catalog);
          target.seller = catalog.seller;
          target.catalogId = catalog.id;
          await pgPool().query(
            `UPDATE shows SET catalog_id = $2,
                    title = CASE WHEN title LIKE 'eBay Live %' AND $3 <> '' THEN $3 ELSE title END
              WHERE id = $1`,
            [target.showId, catalog.id, prepared?.title ?? ""],
          );
          // Answer as THIS seller's agent, with THIS seller's knowledge base.
          // NOTE: the catalog's own agent is deliberately NOT adopted here.
          // The stream agent created above already carries this seller's
          // persona and guardrails, and pointing at the shared catalog agent
          // would put this show's lots back into a corpus other shows read.
          await target.retriever.rebuild();
          for (const l of await target.repo.listings()) hub.emit("listing", { showId: target.showId, ...l });
        }

        // A newly started session becomes the one a console without a showId sees.
        shows.activate(target.showId);

        // Seed the agent's knowledge base in the background — the reply path is
        // grounded per-turn regardless.
        void kb.syncShow(target).catch(() => {});
        // And anchor the cost window here, at the start of the session, not
        // whenever someone first opens the cost rail.
        void anchorSpend(target.showId).catch(() => {});
        return {
          showId: target.showId, show: await target.show(),
          catalog: applied, snapshot: await target.snapshot(),
        };
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
        await target.retriever.rebuild();
        for (const l of await target.repo.listings()) hub.emit("listing", { showId: target.showId, ...l });
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
      const report = await shows.detach(req.params.showId);
      return { ok: true, report, shows: await shows.list(actorOf(req as object)?.id) };
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

      const result = await importCatalog(target.repo, items);
      await target.retriever.rebuild();
      // An import is the one time emitting the whole catalog is right.
      for (const l of await target.repo.listings()) hub.emit("listing", { showId: target.showId, ...l });

      // Push the imported lineup to the agent's knowledge base so it can also be
      // searched by the agent's own retrieval, not just ours.
      const kbResult = await kb.syncShow(target).catch((e) => ({ uploaded: false, lots: 0, reason: (e as Error).message }));
      return { ...result, kb: kbResult, listings: (await target.repo.listings()).length };
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
    let target;
    try {
      target = rt(req.params.showId);
    } catch (e) {
      return reply.code(404).send({ error: (e as Error).message });
    }
    try {
      // The SHOW's agent, not the shared client. It used to be the shared one,
      // which minted every listen session on the seed agent: the transcript
      // still arrived, but the gateway's emotion head, its end-of-session
      // summary and its per-agent session list all belonged to the wrong
      // agent, and the report could never find them.
      const session = await target.llm.startListenSession();
      health(target.showId).reset();
      hub.emit("listen", { showId: target.showId, at: new Date().toISOString(), state: "ok", detail: "listen session started" });
      await pgPool()
        .query("UPDATE shows SET listen_room = $2, listen_started_at = now() WHERE id = $1", [
          target.showId, session.room || null,
        ])
        // Without this row the report cannot find the platform session that
        // holds the host's emotion and intent — worth a line in the log.
        .catch((e) => console.warn(`  listen: room for ${target.showId} not recorded — ${(e as Error).message}`));
      return session;
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  /**
   * One chunk of the host's audio, as the bridge's MediaRecorder cut it.
   *
   * `seq` is the recorder's own counter, so a chunk re-sent after a flaky
   * upload replaces itself. Kept beside the transcript on the same clock, so
   * the report can play the show back against what was said and shown.
   */
  app.post<{ Params: { showId: string }; Querystring: { seq?: string; durationMs?: string; run?: string } }>(
    "/api/shows/:showId/audio/chunk",
    async (req, reply) => {
      if (!policy().ingest.hostAudio) {
        return reply.code(409).send({ error: "host audio is off in settings", ingest: "hostAudio" });
      }
      const seq = Number(req.query.seq);
      const durationMs = Number(req.query.durationMs);
      // `run` identifies one bridge page load; with it a retry replaces its own
      // row. Without it (an older bridge) every upload is a new chunk.
      const run = typeof req.query.run === "string" ? req.query.run.slice(0, 40) : "";
      if (!Number.isInteger(seq) || seq < 0) return reply.code(400).send({ error: "seq must be a non-negative integer" });
      if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 120_000) {
        return reply.code(400).send({ error: "durationMs must be between 1 and 120000" });
      }
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) return reply.code(400).send({ error: "audio bytes are required" });
      let target;
      try {
        target = rt(req.params.showId);
      } catch (e) {
        return reply.code(404).send({ error: (e as Error).message });
      }
      const mime = (req.headers["content-type"] || "audio/webm").split(";")[0]!.trim();
      const row = await target.signals.recordAudio(target.showId, run ? `${run}:${seq}` : null, body, { durationMs, mime });
      listenHealth.get(target.showId)?.touch("audio");
      return { ok: true, seq: row.seq, offsetMs: row.offsetMs, bytes: row.bytes };
    },
  );

  /**
   * The show on one clock: utterances, frames and audio chunks, milliseconds
   * from `started_at`, plus the host summary. This is what the report's
   * playable timeline is drawn from, and it works after the show has ended.
   */
  app.get<{ Params: { showId: string } }>("/api/shows/:showId/timeline", async (req, reply) => {
    const exists = await pgPool().query("SELECT 1 FROM shows WHERE id = $1", [req.params.showId]);
    if (!exists.rowCount) return reply.code(404).send({ error: `no show ${req.params.showId}` });
    const id = req.params.showId;
    const [utterances, frames, audio, host] = await Promise.all([
      signals.utterances(id), signals.frames(id), signals.audio(id), signals.hostSummary(id),
    ]);
    return {
      showId: id,
      host,
      utterances,
      frames: frames.map((f) => ({ seq: f.seq, at: f.at, offsetMs: f.offsetMs, reading: f.reading, description: f.description, bytes: f.bytes })),
      audio: audio.map((a) => ({ seq: a.seq, at: a.at, offsetMs: a.offsetMs, durationMs: a.durationMs, bytes: a.bytes, mime: a.mime })),
      describing: describing(id),
    };
  });

  /**
   * Describe this show's frames for the timeline, in the background. Runs on
   * its own after a detach; this is for shows that ended before descriptions
   * existed, or whose describer was interrupted. Needs the show's agent, which
   * agent GC retires a day after the report.
   */
  app.post<{ Params: { showId: string } }>("/api/shows/:showId/timeline/describe", async (req, reply) => {
    const row = await pgPool().query<{ agent_id: string | null }>("SELECT agent_id FROM shows WHERE id = $1", [req.params.showId]);
    if (!row.rowCount) return reply.code(404).send({ error: `no show ${req.params.showId}` });
    const agentId = row.rows[0]!.agent_id || config.whissle.agentId;
    if (!agentId) return reply.code(409).send({ error: "this show has no agent left to read its frames" });
    if (describing(req.params.showId)) return { ok: true, describing: true };
    const reader = new WhissleClient({ baseUrl: config.whissle.base, apiKey: config.whissle.apiKey, agentId, showId: req.params.showId });
    void describeFrames(req.params.showId, signals, reader).then((r) =>
      console.log(`  frames: ${req.params.showId} described ${r.described}, skipped ${r.skipped}`),
    );
    return { ok: true, describing: true };
  });

  app.get<{ Params: { showId: string; seq: string } }>("/api/shows/:showId/media/frames/:seq", async (req, reply) => {
    const f = await signals.frame(req.params.showId, Number(req.params.seq));
    if (!f || !existsSync(f.path)) return reply.code(404).send({ error: "no such frame" });
    return reply
      .type(f.path.endsWith(".png") ? "image/png" : "image/jpeg")
      .header("cache-control", "private, max-age=86400")
      .send(createReadStream(f.path));
  });

  app.get<{ Params: { showId: string; seq: string } }>("/api/shows/:showId/media/audio/:seq", async (req, reply) => {
    const a = await signals.audioChunk(req.params.showId, Number(req.params.seq));
    if (!a || !existsSync(a.path)) return reply.code(404).send({ error: "no such audio chunk" });
    return reply.type(a.mime).header("cache-control", "private, max-age=86400").send(createReadStream(a.path));
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
    Body: { text?: string; emotion?: unknown; intent?: unknown; speechRate?: number; final?: boolean; levels?: unknown };
  }>("/api/shows/:showId/audio/transcript", async (req, reply) => {
    // The seller's switch, honoured at the door rather than in the UI. With
    // host audio off the copilot never hears "last one in this waist" — and it
    // then abstains on those questions instead of guessing, which is the whole
    // point of the setting.
    if (!policy().ingest.hostAudio) {
      return reply.code(409).send({ error: "host audio is off in settings", ingest: "hostAudio" });
    }
    const text = (req.body?.text || "").trim();
    if (!text) return reply.code(400).send({ error: "text is required" });
    try {
      const target = rt(req.params.showId);

      // Distributions, not labels. The gateway's own note on this head says
      // accuracy degrades sharply on low-arousal states, so collapsing it to one
      // word would present a coin flip as a fact.
      const segment = {
        showId: target.showId,
        text,
        emotion: normalizeDistribution(req.body?.emotion as never),
        intent: normalizeDistribution(req.body?.intent as never),
        speechRate: typeof req.body?.speechRate === "number" ? req.body.speechRate : null,
        at: new Date().toISOString(),
        // The loudness envelope the bridge measured while this was being said.
        // Bounded: a long utterance must not put a thousand floats on the wire.
        levels: Array.isArray(req.body?.levels)
          ? (req.body.levels as unknown[])
              .slice(-240)
              .map((n) => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0))
          : null,
      };

      // The DISTRIBUTION goes into show context alongside the text, not just to
      // the console. It used to stop at the UI: the panel rendered emotion and
      // intent while the reply path saw only the words, so a measurement we were
      // already paying for shaded nothing. `push` keeps it only while the head
      // itself reports it trusted, and expires it after one utterance's worth.
      // Pace, when the gateway sent none: words over the loudness window the
      // bridge measured while this was being said (10 Hz), else over the gap
      // since the previous utterance. The report's Pace tile read "—" on a
      // host who talked for five minutes because words_per_minute never came.
      if (segment.speechRate == null) {
        const words = text.split(/\s+/).filter(Boolean).length;
        const prev = lastUtteranceAt.get(target.showId) ?? 0;
        const spanS = segment.levels?.length ? segment.levels.length / 10 : prev ? (Date.now() - prev) / 1000 : 0;
        if (words >= 2 && spanS >= 0.8 && spanS <= 15) segment.speechRate = Math.round(Math.min(300, Math.max(40, (words / spanS) * 60)));
      }
      lastUtteranceAt.set(target.showId, Date.now());
      const meanLevel = segment.levels?.length ? segment.levels.reduce((a, b) => a + b, 0) / segment.levels.length : null;
      target.showContext.push(text, segment.emotion, segment.intent, { level: meanLevel, wpm: segment.speechRate });
      // Kept, distribution and all — this is the row the post-show "what the
      // host did" section is computed from.
      target.signals.recordUtterance(segment);
      hub.emit("transcript", segment);
      health(target.showId).touch("transcript");
      health(target.showId).check((state, detail) =>
        hub.emit("listen", { showId: target.showId, at: new Date().toISOString(), state, detail }),
      );
      return { ok: true, ...segment };
    } catch (e) {
      return reply.code(404).send({ error: (e as Error).message });
    }
  });

  /** Force a knowledge-base sync for one show. */
  /**
   * One keyframe from the show's video, read into show context.
   *
   * The bridge already holds a video track — Chrome will not hand over tab
   * AUDIO without it — and until now that track was stopped on arrival. For a
   * live SELLING show that is the wrong instinct: the host is holding the item
   * up to camera, and "what's that one?" is answerable from the frame and from
   * nothing else in the system.
   *
   * Throttled hard, on the SERVER, because a client can be wrong or hostile and
   * each read costs a vision call. The reading is show context and never a
   * grounding fact — see the boundary enforced in compose/prompts.ts.
   */
  /**
   * The show's loudness, independent of any utterance.
   *
   * The transcript only exists where words were recognised, so a strip built
   * from it alone freezes during a pause and looks like a dead capture. This
   * keeps the timeline honest through silence — and silence on a selling show
   * is information: it is the host waiting for bids.
   */
  app.post<{ Params: { showId: string }; Body: { levels?: unknown } }>(
    "/api/shows/:showId/audio/levels",
    async (req, reply) => {
      const raw = Array.isArray(req.body?.levels) ? (req.body.levels as unknown[]) : null;
      if (!raw) return reply.code(400).send({ error: "levels must be an array" });
      try {
        const target = rt(req.params.showId);
        const levels = raw
          .slice(-240)
          .map((n) => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0));
        // Straight to the console. Deliberately NOT persisted: this is a
        // 10 Hz waveform whose only consumer is a strip showing the last two
        // minutes, and writing it would be the highest-volume table in the
        // database in exchange for nothing anyone reads later.
        hub.emit("levels", { showId: target.showId, at: new Date().toISOString(), levels });
        // Loud audio with no transcript is the signature of a listen session
        // that has stopped transcribing while the bridge is still publishing
        // — measured on 2026-09-15: ninety seconds of speech-level chunks
        // after the last utterance. The console is told, and the bridge
        // reconnects; neither can see it from the transcript alone.
        const loud = levels.length ? levels.reduce((a, b) => a + b, 0) / levels.length : 0;
        if (loud > 0.25) health(target.showId).touch("loud");
        health(target.showId).check((state, detail) =>
          hub.emit("listen", { showId: target.showId, at: new Date().toISOString(), state, detail }),
        );
        return { ok: true, n: levels.length };
      } catch (e) {
        return reply.code(404).send({ error: (e as Error).message });
      }
    },
  );

  app.post<{ Params: { showId: string }; Body: { frame?: string } }>(
    "/api/shows/:showId/visual/frame",
    async (req, reply) => {
      if (!policy().ingest.cameraFrames) {
        return reply.code(409).send({ error: "camera frames are off in settings", ingest: "cameraFrames" });
      }
      const dataUrl = (req.body?.frame || "").trim();
      if (!dataUrl.startsWith("data:image/")) {
        return reply.code(400).send({ error: "frame must be an image data URL" });
      }
      if (dataUrl.length > MAX_FRAME_CHARS) {
        return reply.code(413).send({ error: `frame too large (${dataUrl.length} chars, cap ${MAX_FRAME_CHARS})` });
      }
      let target;
      try {
        target = rt(req.params.showId);
      } catch (e) {
        return reply.code(404).send({ error: (e as Error).message });
      }

      const last = lastVisualRead.get(target.showId) ?? 0;
      if (Date.now() - last < VISUAL_MIN_GAP_MS) {
        return { ok: true, skipped: "throttled", nextInMs: VISUAL_MIN_GAP_MS - (Date.now() - last) };
      }
      lastVisualRead.set(target.showId, Date.now());

      try {
        // The frame reader gets what the host just said and the lot on the
        // table as hints: a white sneaker read as "smartphone" on 2026-09-15
        // while the host was saying "size ten men, Nike". The hint narrows
        // the answer; it must not invent one, so the question still ends
        // with "nothing clear".
        const ctx = target.showContext.current();
        const pinnedTitle = (await target.repo.show().catch(() => null))?.pinnedListingId
          ? (await target.repo.listing((await target.repo.show()).pinnedListingId!).catch(() => null))?.title ?? null
          : null;
        const hints = [
          ctx.recentPoints.length ? `The host just said: ${ctx.recentPoints.slice(0, 3).map((p) => `"${p.slice(0, 120)}"`).join("; ")}.` : "",
          pinnedTitle ? `The lot on the table is listed as "${pinnedTitle.slice(0, 100)}".` : "",
        ].filter(Boolean).join(" ");
        const question = hints
          ? `${VISUAL_QUESTION} Context, which may help you name the item but must not replace what you see: ${hints}`
          : VISUAL_QUESTION;
        const reading = await target.llm.readFrame(dataUrl, question);
        // The agent answers in the reply JSON shape, because it is the same
        // agent with the same persona. Take the answer and drop the rest.
        const text = readingText(reading);
        if (!text) return { ok: true, skipped: "no reading" };
        target.showContext.setOnScreen(text);
        hub.emit("context", { showId: target.showId, ...target.showContext.current() });
        // The frame is kept WITH its reading, and only then. What the agent
        // saw and what it said it saw are one record; a seller reviewing a
        // wrong reading needs the picture to judge it.
        const kept = await target.signals.recordFrame(target.showId, dataUrl, text).catch(() => null);
        if (kept) hub.emit("frame", { showId: target.showId, seq: kept.seq, at: kept.at, offsetMs: kept.offsetMs, reading: text });
        return { ok: true, onScreen: text, frameSeq: kept?.seq ?? null };
      } catch (e) {
        // A failed vision call costs this frame and nothing else — the next one
        // is seconds away and the reply path never depended on it.
        return reply.code(502).send({ error: (e as Error).message });
      }
    },
  );

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
      if (!mustWrite(req as object, reply)) return;
      try {
        try {
          return await rt(req.query.showId, req as object).pipeline.send(req.params.id, req.body?.text, who(req as object));
        } catch (e) {
          // A refusal is not a failure: the guards did their job at the last
          // moment they could. 409, with the reason, so the console can say it.
          if (e instanceof SendRefused) return reply.code(409).send({ error: (e as Error).message, refused: true });
          throw e;
        }
      } catch (e) {
        return reply.code(404).send({ error: (e as Error).message });
      }
    },
  );

  app.post<{ Params: { id: string }; Querystring: { showId?: string } }>(
    "/api/proposals/:id/dismiss",
    async (req, reply) => {
      if (!mustWrite(req as object, reply)) return;
      try {
        return rt(req.query.showId, req as object).pipeline.dismiss(req.params.id);
      } catch (e) {
        return reply.code(404).send({ error: (e as Error).message });
      }
    },
  );

  app.post<{ Params: { id: string }; Querystring: { showId?: string } }>(
    "/api/proposals/:id/regenerate",
    async (req, reply) => {
      if (!mustWrite(req as object, reply)) return;
      try {
        return await rt(req.query.showId, req as object).pipeline.regenerate(req.params.id);
      } catch (e) {
        return reply.code(404).send({ error: (e as Error).message });
      }
    },
  );

  // ── operational actions ───────────────────────────────────────────────────
  app.post<{ Params: { id: string }; Querystring: { showId?: string } }>(
    "/api/actions/:id/approve",
    async (req, reply) => {
      if (!mustWrite(req as object, reply)) return;
      try {
        return await rt(req.query.showId, req as object).executor.approve(req.params.id, who(req as object));
      } catch (e) {
        return reply.code(404).send({ error: (e as Error).message });
      }
    },
  );

  app.post<{ Params: { id: string }; Querystring: { showId?: string } }>(
    "/api/actions/:id/reject",
    async (req, reply) => {
      if (!mustWrite(req as object, reply)) return;
      try {
        return rt(req.query.showId, req as object).executor.reject(req.params.id);
      } catch (e) {
        return reply.code(404).send({ error: (e as Error).message });
      }
    },
  );

  app.post<{ Params: { id: string }; Querystring: { showId?: string } }>(
    "/api/actions/:id/rollback",
    async (req, reply) => {
      if (!mustWrite(req as object, reply)) return;
      try {
        return await rt(req.query.showId, req as object).executor.rollback(req.params.id, who(req as object));
      } catch (e) {
        return reply.code(404).send({ error: (e as Error).message });
      }
    },
  );

  // ── show controls ─────────────────────────────────────────────────────────
  app.post<{ Querystring: { showId?: string }; Body: { level: AutonomyLevel } }>(
    "/api/autonomy",
    async (req, reply) => {
      // Moving the rung is the most consequential write in the product — L3 lets
      // the copilot answer a buyer with nobody watching — and it was the one
      // write with no guard on it. A guest could switch a show to auto-reply.
      if (!mustWrite(req as object, reply)) return;
      const level = req.body?.level;
      if (!level || !LADDER.includes(level)) {
        return reply.code(400).send({ error: `level must be one of ${LADDER.join(", ")}` });
      }
      try {
        const target = rt(req.query.showId, req as object);
        const show = await target.setAutonomy(level);
        const [entry] = await target.audit.list(1);
        if (entry) hub.emit("audit", { showId: target.showId, ...entry });
        return show;
      } catch (e) {
        return reply.code(404).send({ error: (e as Error).message });
      }
    },
  );

  /**
   * Mark a sent reply wrong.
   *
   * The PRD names "wrong replies reaching a buyer" and marks it not
   * self-measurable, which is correct — and leaves the number at nothing. The
   * operator is the only one who can see it, so this is the control that turns
   * it into a count. It is a FLOOR, never a total, and every surface that shows
   * it says so.
   *
   * The flag is also an eval case. The guardrail suite has only ever learned
   * from its own author; this is the first thing in it that came from a buyer.
   */
  app.post<{ Params: { id: string }; Querystring: { showId?: string }; Body: { reason?: string } }>(
    "/api/proposals/:id/flag",
    async (req, reply) => {
      const actor = mustWrite(req as object, reply);
      if (!actor) return;
      const reason = (req.body?.reason || "wrong fact").trim().slice(0, 80);
      try {
        const target = rt(req.query.showId, req as object);
        const r = await pgPool().query<{ question: string; sent_text: string | null; draft: string }>(
          `UPDATE reply_proposals
              SET flagged_wrong = TRUE, flag_reason = $3, flagged_at = now()
            WHERE show_id = $1 AND id = $2
            RETURNING question, sent_text, draft`,
          [target.showId, req.params.id, reason],
        );
        const row = r.rows[0];
        if (!row) return reply.code(404).send({ error: `no proposal ${req.params.id}` });

        // In the audit chain, because "who said this was wrong, and when" is
        // exactly the kind of question the chain exists to answer.
        await target.audit.append(
          "reply_flagged_wrong",
          "seller",
          `reply flagged wrong · ${reason}`,
          { proposalId: req.params.id, reason, question: row.question, sent: row.sent_text ?? row.draft },
          actor.id,
        );
        const [entry] = await target.audit.list(1);
        if (entry) hub.emit("audit", { showId: target.showId, ...entry });
        return { ok: true, id: req.params.id, reason };
      } catch (e) {
        return reply.code(404).send({ error: (e as Error).message });
      }
    },
  );

  /**
   * Tell the copilot what is actually on screen.
   *
   * eBay Live names lots for the seller — "#007 — As seen on eBay LIVE" — so a
   * monitored show has a price for something it cannot name. `enrichLot` names
   * it from host speech and a camera frame, which is a guess, and when the
   * guess is wrong every answer after it is wrong in the same direction. The
   * operator is the only one who can see that, and this is the one input that
   * fixes all of it at once.
   */
  app.post<{ Params: { listingId: string }; Querystring: { showId?: string }; Body: { title?: string } }>(
    "/api/listings/:listingId/name",
    async (req, reply) => {
      const actor = mustWrite(req as object, reply);
      if (!actor) return;
      const title = (req.body?.title || "").trim().slice(0, 200);
      if (title.length < 3) return reply.code(400).send({ error: "title is required" });
      try {
        const target = rt(req.query.showId, req as object);
        const before = (await target.repo.listings()).find((l) => l.id === req.params.listingId);
        if (!before) return reply.code(404).send({ error: `no listing ${req.params.listingId}` });

        // Named, not re-priced: this does not bump the listing version, because
        // naming a lot is not a change to what is being sold — and the staleness
        // guard reads that version.
        await target.repo.nameObservedLot(req.params.listingId, title, "the operator");
        await target.refreshIndex();
        const after = (await target.repo.listings()).find((l) => l.id === req.params.listingId) ?? null;
        await target.audit.append(
          "lot_corrected",
          "seller",
          `lot renamed · ${before.title} → ${title}`,
          { listingId: req.params.listingId, from: before.title, to: title },
          actor.id,
        );
        const [entry] = await target.audit.list(1);
        if (entry) hub.emit("audit", { showId: target.showId, ...entry });
        if (after) hub.emit("listing", { showId: target.showId, ...after });
        return after ?? { ok: true };
      } catch (e) {
        return reply.code(404).send({ error: (e as Error).message });
      }
    },
  );

  /**
   * Ask what the copilot WOULD say, without a show and without sending.
   *
   * The same pipeline, the same six guards, against the catalog as it stands
   * right now. A guardrail change was previously only testable on a live buyer,
   * which is the worst possible place to find out a regex blocks every reply.
   */
  app.post<{ Querystring: { showId?: string }; Body: { question?: string } }>(
    "/api/dry-run",
    async (req, reply) => {
      const question = (req.body?.question || "").trim();
      if (!question) return reply.code(400).send({ error: "question is required" });
      try {
        const target = rt(req.query.showId, req as object);
        return await target.pipeline.dryRun(question);
      } catch (e) {
        return reply.code(404).send({ error: (e as Error).message });
      }
    },
  );

  /**
   * Draft a reply for a comment the admission gate dropped.
   *
   * One show dropped 1,204 messages as reaction. The gate is right about nearly
   * all of them and wrong about some, and when it is wrong the operator has no
   * way to say "answer that one" — which makes the gate unarguable rather than
   * merely strict.
   */
  app.post<{ Params: { id: string }; Querystring: { showId?: string } }>(
    "/api/chat/:id/answer",
    async (req, reply) => {
      if (!mustWrite(req as object, reply)) return;
      try {
        const target = rt(req.query.showId, req as object);
        // Read from the persisted record rather than memory: the operator may
        // be answering something that scrolled past a while ago.
        const row = (
          await pgPool().query<{ author: string; text: string }>(
            "SELECT author, text FROM chat_messages WHERE show_id = $1 AND id = $2",
            [target.showId, req.params.id],
          )
        ).rows[0];
        if (!row) return reply.code(404).send({ error: `no message ${req.params.id}` });
        // Forced past the gate, and recorded as forced: a drop the operator
        // overruled is a data point about the gate, not just about this reply.
        return await target.pipeline.ingest({ author: row.author, text: row.text }, { force: true });
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
        return rt(req.query.showId, req as object).pipeline.ingest({ author: (req.body?.author || "you").trim(), text });
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
        const target = rt(req.query.showId, req as object);
        return target.research.run(query, req.body?.listingId ?? (await target.show()).pinnedListingId);
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
  app.get<{ Querystring: { showId?: string } }>("/api/show", read((s) => rt(s).show()));
  app.get<{ Querystring: { showId?: string } }>("/api/listings", read((s) => rt(s).repo.listings()));
  app.get<{ Querystring: { showId?: string } }>("/api/context", read((s) => rt(s).showContext.current()));
  app.get<{ Querystring: { showId?: string } }>("/api/actions", read((s) => rt(s).executor.list()));
  app.get<{ Querystring: { showId?: string } }>("/api/proposals", read((s) => rt(s).pipeline.list()));
}

/**
 * The page eBay's redirect lands on.
 *
 * A browser arrives here, not an XHR, so it gets a document. Deliberately
 * minimal and self-closing: the seller started this from the console and should
 * end up back there, not on a page that becomes another thing to navigate away
 * from. Nothing from the query string is echoed into it — the code and state are
 * secrets that have no business in a rendered document or a browser history
 * entry's page text.
 */
function closingPage(title: string, detail: string, ok: boolean): string {
  const esc = (x: string) =>
    x.replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
    );
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  body{margin:0;display:grid;place-items:center;min-height:100vh;background:#f4f5f7;
       font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#1c1f24}
  .card{background:#fff;border-radius:10px;padding:28px 32px;max-width:420px;
        box-shadow:0 1px 2px rgb(28 31 36/.06),0 8px 28px rgb(28 31 36/.10)}
  h1{margin:0 0 8px;font-size:17px;color:${ok ? "#1a7f4b" : "#b4232c"}}
  p{margin:0;color:#5b6270}
  small{display:block;margin-top:16px;color:#8b919c}
</style>
<div class="card">
  <h1>${esc(title)}</h1>
  <p>${esc(detail)}</p>
  <small>You can close this tab.</small>
</div>
<script>setTimeout(function(){ try { window.close(); } catch (e) {} }, ${ok ? 1500 : 6000});</script>`;
}
