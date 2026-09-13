// Composition root. Everything is constructed once here and wired together, so
// there is exactly one place to read to understand what talks to what.

import { config, hasWhissleCreds } from "../config.js";
import { db } from "../db/index.js";
import { Repo } from "../domain/repo.js";
import { Retriever } from "../retrieval/retriever.js";
import { WhissleClient } from "../llm/whissle.js";
import type { LlmPort } from "../llm/types.js";
import { AuditLog } from "../actions/audit.js";
import { ActionExecutor } from "../actions/executor.js";
import { ActionProposer } from "../actions/proposer.js";
import { MockMarketplace } from "../actions/marketplace/mock.js";
import type { RemoteListing } from "../actions/marketplace/port.js";
import { ResearchService } from "../research/research.js";
import { ShowContextEngine } from "../ingest/showContext.js";
import { Pipeline } from "../pipeline/pipeline.js";
import { EventHub } from "./hub.js";
import type { ChatSource } from "../ingest/sources.js";
import { ScriptedHostAudio, SimulatedShowSource } from "../ingest/sources.js";

export interface AppContext {
  repo: Repo;
  retriever: Retriever;
  audit: AuditLog;
  executor: ActionExecutor;
  proposer: ActionProposer;
  research: ResearchService;
  showContext: ShowContextEngine;
  pipeline: Pipeline;
  hub: EventHub;
  market: MockMarketplace;
  llmName: string;
  chatSource: ChatSource | null;
  hostAudio: ScriptedHostAudio | null;
  snapshot(): Record<string, unknown>;
  start(): void;
  stop(): void;
}

export function buildContext(): AppContext {
  const d = db();
  const repo = new Repo(d);
  const retriever = new Retriever(repo);
  const audit = new AuditLog(d);
  const hub = new EventHub();

  if (!hasWhissleCreds()) {
    console.warn(
      "\n  WHISSLE_API_KEY / WHISSLE_AGENT_ID are not set.\n" +
      "  Retrieval, guardrails, actions, audit and the API all work without them,\n" +
      "  but no reply can be DRAFTED. Run `npm run seed:agent` first — see README.\n",
    );
  }

  const llm: LlmPort = new WhissleClient({
    apiKey: config.whissle.apiKey,
    agentId: config.whissle.agentId,
    baseUrl: config.whissle.base,
    timeoutMs: Math.max(4000, config.latencyBudgetMs * 3),
  });

  // The marketplace starts as a mirror of our catalog and then diverges as
  // writes land — which is the condition the two-phase commit exists for.
  const remote: RemoteListing[] = repo.listings().map((l) => ({
    id: l.id, priceCents: l.priceCents, qty: l.qty, state: l.state, pinned: l.pinned, version: l.version,
  }));
  const market = new MockMarketplace(remote);

  const executor = new ActionExecutor(d, repo, market, audit, {
    undoWindowS: config.undoWindowS,
    onChange: (a) => {
      hub.emit("action", a);
      hub.emit("audit", audit.list(1)[0]);
    },
    onListingWrite: (id) => {
      retriever.rebuild();
      const l = repo.listing(id);
      if (l) hub.emit("listing", l);
      for (const other of repo.listings()) if (other.id !== id) hub.emit("listing", other);
    },
  });

  const proposer = new ActionProposer(repo);
  const research = new ResearchService(repo);

  const showContext = new ShowContextEngine({
    llm,
    lotTitles: () => repo.listings().map((l) => ({ id: l.id, title: `${l.title} size ${l.size}` })),
    onUpdate: (c) => hub.emit("context", c),
  });

  const pipeline = new Pipeline({
    repo, llm, retriever, executor, proposer, showContext, audit,
    events: {
      onChat: (m) => hub.emit("chat", m),
      onProposal: (p) => hub.emit("proposal", p),
      onMetrics: (m) => hub.emit("metrics", m),
      onListingChanged: (id) => {
        const l = repo.listing(id);
        if (l) hub.emit("listing", l);
      },
    },
  });

  const chatSource: ChatSource | null = config.simulate ? new SimulatedShowSource() : null;
  const hostAudio = config.simulate ? new ScriptedHostAudio() : null;

  let heartbeat: NodeJS.Timeout | null = null;

  const ctx: AppContext = {
    repo, retriever, audit, executor, proposer, research, showContext, pipeline, hub, market,
    llmName: llm.name, chatSource, hostAudio,

    snapshot() {
      return {
        show: repo.show(),
        listings: repo.listings(),
        proposals: pipeline.list(),
        actions: executor.list(),
        audit: audit.list(200),
        metrics: pipeline.metrics(),
        context: showContext.current(),
      };
    },

    start() {
      showContext.start();
      hostAudio?.onSegment((t) => showContext.push(t));
      hostAudio?.start();
      chatSource?.onMessage((m) => pipeline.ingest(m));
      void chatSource?.start();
      heartbeat = setInterval(() => hub.heartbeat(), 20_000);
    },

    stop() {
      showContext.stop();
      hostAudio?.stop();
      chatSource?.stop();
      if (heartbeat) clearInterval(heartbeat);
    },
  };

  return ctx;
}
