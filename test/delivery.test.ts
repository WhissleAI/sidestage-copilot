/**
 * Who actually sends the reply.
 *
 * eBay Live declared `delivery: "api"`. Nothing in this build has ever posted a
 * character into an eBay Live chat — eBay publishes no chat-post API, which is
 * the whole reason the surface is read through a scraped browser session. The
 * console rendered its primary Send button off that declaration, toasted "Reply
 * sent to @buyer", the audit recorded `reply_sent`, and the answered-rate
 * counted it. The buyer got nothing, every time, on the reference surface's
 * most-used button.
 *
 * These tests hold the contract that replaced it: `delivery` is decided by the
 * server, from the surface AND from whether a delivery path is actually wired,
 * and nothing anywhere may report a delivery that did not happen.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { rig, cleanup, type Rig } from "./helpers.js";
import { Pipeline, type ReplyDeliverer } from "../src/pipeline/pipeline.js";
import { ResearchService } from "../src/research/research.js";
import { ActionProposer } from "../src/actions/proposer.js";
import { ShowContextEngine } from "../src/ingest/showContext.js";
import { capabilitiesOf } from "../src/surfaces/types.js";
import type { LlmPort } from "../src/llm/types.js";
import type { ReplyProposal } from "../src/domain/types.js";

after(cleanup);

/** A reply the guards allow: no money, no policy claim, nothing to ground. */
const ANSWER = '{"answer":"Sure thing, the host will cover that in a moment.","claims":[]}';

const llm: LlmPort = {
  name: "stub",
  chatTurn: async () => ANSWER,
  chatTurnStream: async (_m, _c, onDelta) => {
    onDelta(ANSWER, ANSWER);
    return ANSWER;
  },
  utilityTurn: async () => "{}",
};

function pipelineFor(r: Rig, deliver?: ReplyDeliverer): Pipeline {
  return new Pipeline({
    repo: r.repo,
    llm,
    retriever: r.retriever,
    research: new ResearchService(r.repo),
    executor: r.exec,
    proposer: new ActionProposer(r.repo),
    showContext: new ShowContextEngine({ llm, lotTitles: () => [], onUpdate: () => {} }),
    audit: r.audit,
    events: { onChat: () => {}, onProposal: () => {}, onMetrics: () => {}, onListingChanged: () => {} },
    ...(deliver ? { deliver } : {}),
  });
}

/** The audit chain is appended without the send waiting on it — a buyer's
 *  answer must not block on a hash chain write. Wait for the row. */
async function auditedSend(r: Rig) {
  for (let i = 0; i < 200; i++) {
    const found = (await r.audit.list(10)).find((e) => e.kind === "reply_sent");
    if (found) return found;
    await new Promise((x) => setTimeout(x, 10));
  }
  throw new Error("no reply_sent entry was ever written");
}

/** Ingest one question and wait for its proposal to settle. */
async function drafted(p: Pipeline, text = "can you tell me more about this one?"): Promise<ReplyProposal> {
  const msg = await p.ingest({ author: "@buyer", text }, { force: true });
  for (let i = 0; i < 200; i++) {
    const found = p.get(`prop_${msg.id}`);
    if (found && found.status !== "drafting") return found;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("the draft never settled");
}

test("a surface with no way to deliver never reports a delivery", async () => {
  const r = await rig();
  // The seeded show is `simulated`, which is eBay Live byte for byte — the
  // scripted show exists to exercise the live-commerce path, so a capability
  // that differed would make the demo test something production does not do.
  assert.equal(capabilitiesOf("ebaylive").delivery, "draft-only");
  assert.equal(capabilitiesOf("simulated").delivery, "draft-only");

  const p = pipelineFor(r);
  const proposal = await drafted(p);
  // The card knows before the operator touches it, so the console never offers
  // a Send button and then takes it away.
  assert.equal(proposal.delivery, "human");

  const sent = await p.send(proposal.id);
  assert.equal(sent.status, "sent");
  assert.equal(sent.delivery, "human", "nothing delivered this — a human will");

  const entry = await auditedSend(r);
  assert.match(
    entry.summary,
    /approved and recorded/,
    `the chain must not say "sent" for a reply nobody sent: ${entry.summary}`,
  );

  const m = await p.metrics();
  assert.equal(m.sent, 1, "the question was answered");
  assert.equal(m.delivered, 0, "and nothing was delivered");
  assert.equal(m.handedOff, 1, "it was handed to the operator");
});

test("a wired delivery path is the only thing that makes a send a delivery", async () => {
  const r = await rig();
  // Twitch is the one surface with a real mechanism — `post_reply` through the
  // Helix chat API. It still only counts as delivery when something is wired
  // to it: declaring the capability is not having it.
  await r.d.query("UPDATE shows SET source = 'twitch' WHERE id = $1", [r.showId]);
  assert.equal(capabilitiesOf("twitch").delivery, "api");

  const undelivered = await drafted(pipelineFor(r));
  assert.equal(
    undelivered.delivery,
    "human",
    "a surface that COULD deliver but has nothing wired must not claim it did",
  );

  const posted: { to: string; text: string }[] = [];
  const p = pipelineFor(r, async (m) => { posted.push({ to: m.to, text: m.text }); });
  const proposal = await drafted(p, "what time do you go live on fridays?");
  assert.equal(proposal.delivery, "api");

  const sent = await p.send(proposal.id);
  assert.equal(sent.delivery, "api");
  assert.equal(posted.length, 1, "the reply must actually have gone somewhere");
  assert.equal(posted[0]!.to, "@buyer");
  assert.equal(posted[0]!.text, sent.sentText);

  assert.match((await auditedSend(r)).summary, /delivered to @buyer/);

  const m = await p.metrics();
  assert.equal(m.delivered, 1);
  assert.equal(m.handedOff, 0);
});

test("a delivery that fails is not a send", async () => {
  const r = await rig();
  await r.d.query("UPDATE shows SET source = 'twitch' WHERE id = $1", [r.showId]);
  const p = pipelineFor(r, async () => { throw new Error("twitch dropped the message"); });
  const proposal = await drafted(p);

  await assert.rejects(() => p.send(proposal.id), /not delivered — twitch dropped the message/);
  // The proposal is still the operator's to use; nothing was recorded as sent.
  assert.equal(p.get(proposal.id)!.status, "ready");
  assert.equal((await p.metrics()).sent, 0);
  assert.equal((await r.audit.list(5)).some((e) => e.kind === "reply_sent"), false);
});

test("L3 does not auto-send on a surface that cannot deliver — it pre-approves", async () => {
  const r = await rig();
  await r.repo.updateShow({ autonomyLevel: "L3_AUTO_REPLY" });
  const p = pipelineFor(r);
  // An allow-listed intent, above the confidence floor, on a draft-only
  // surface. Before this contract it was filed `auto_sent`, with no human in
  // the loop at all and nobody receiving anything.
  const proposal = await drafted(p, "does this ship to canada?");
  assert.notEqual(proposal.status, "auto_sent");
  assert.equal(proposal.delivery, "human");
  assert.equal((await p.metrics()).autoSent, 0);
});
