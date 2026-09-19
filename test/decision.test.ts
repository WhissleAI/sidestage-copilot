/**
 * The decision layer: what happens to a draft between "the model wrote it" and
 * "the buyer can read it".
 *
 * Every test here drives the REAL guard chain and the REAL pipeline against the
 * real catalog in Postgres. The only thing stubbed is the model itself, because
 * the model's output is the input to everything under test.
 *
 * The rules asserted, in the order they matter:
 *
 *   1. three verdicts mean three things. `revise` earns a repair pass and, if
 *      the repair does not clear it, a card the seller can still send, edit and
 *      regenerate. Only `block` holds a reply back.
 *   2. an operator's EDIT is judged as a human assertion: every guard that
 *      protects the buyer runs on it, and the one that audits the model's
 *      citation discipline does not.
 *   3a. a guard that reasons about a corpus does not fire on a surface that has
 *      none (policy, exactly as price and availability already did).
 *   3b. a money amount whose only source is the host's live speech is not a
 *      price we may quote.
 *   3. a held card's own instruction — "edit it and send, the edit is checked
 *      again" — is true. An edit that clears the block sends; one that does not
 *      is refused by name.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { rig, guardInput, cleanup, PINNED, type Rig } from "./helpers.js";
import { runChain } from "../src/guardrails/chain.js";
import { priceGuard, policyGuard } from "../src/guardrails/guards.js";
import type { GuardInput } from "../src/guardrails/types.js";
import type { Fact } from "../src/retrieval/facts.js";
import { ngramVector, terms } from "../src/retrieval/text.js";
import { capabilitiesOf } from "../src/surfaces/types.js";
import { decideReply } from "../src/autonomy/ladder.js";
import { admit, classify } from "../src/ingest/classify.js";
import { Pipeline, SendRefused } from "../src/pipeline/pipeline.js";
import { ActionProposer } from "../src/actions/proposer.js";
import { ResearchService } from "../src/research/research.js";
import { ShowContextEngine } from "../src/ingest/showContext.js";
import type { LlmPort } from "../src/llm/types.js";
import type { ReplyProposal } from "../src/domain/types.js";

after(cleanup);

// ── the model, scripted ─────────────────────────────────────────────────────
//
// `chatTurnStream` is the draft turn; `chatTurn` carrying the rejection banner
// is the repair turn. Distinguishing them by the prompt rather than by the
// method is what lets a test assert that the repair pass RAN.

/** Raw model output in the shape the composer parses. */
const say = (answer: string, claims: { text: string; factId: string }[] = []) =>
  JSON.stringify({ answer, claims });

class ScriptedLlm implements LlmPort {
  readonly name = "scripted";
  /** Successive draft turns. The last entry repeats once exhausted. */
  drafts: string[] = [say("Yes.")];
  /** Successive repair turns. Defaults to repeating the draft unchanged, which
   *  is the honest worst case: a repair that fixes nothing. */
  repairs: string[] | null = null;
  repairCalls = 0;
  lastFailures = "";

  private next(q: string[]): string {
    return q.length > 1 ? q.shift()! : q[0]!;
  }

  async chatTurn(_msg: string, context: string): Promise<string> {
    if (context.includes("YOUR PREVIOUS DRAFT WAS REJECTED")) {
      this.repairCalls++;
      this.lastFailures = context.slice(context.indexOf("YOUR PREVIOUS DRAFT WAS REJECTED"));
      return this.repairs ? this.next(this.repairs) : this.drafts[0]!;
    }
    return this.next(this.drafts);
  }

  async chatTurnStream(
    _msg: string,
    _context: string,
    onDelta: (text: string, full: string) => void,
  ): Promise<string> {
    const raw = this.next(this.drafts);
    onDelta(raw, raw);
    return raw;
  }

  async utilityTurn(): Promise<string> {
    return "{}";
  }
}

// ── the real pipeline, wired as the show runtime wires it ───────────────────

interface Harness {
  r: Rig;
  llm: ScriptedLlm;
  pipeline: Pipeline;
  /** Ingest a question and wait for its proposal to reach a terminal status. */
  ask(text: string): Promise<ReplyProposal>;
  stop(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const r = await rig();
  const llm = new ScriptedLlm();
  const seen = new Map<string, ReplyProposal>();
  const pipeline = new Pipeline({
    repo: r.repo,
    llm,
    retriever: r.retriever,
    research: new ResearchService(r.repo),
    executor: r.exec,
    proposer: new ActionProposer(r.repo),
    showContext: new ShowContextEngine({ llm, lotTitles: () => [], onUpdate: () => {} }),
    audit: r.audit,
    events: {
      onChat: () => {},
      onProposal: (p) => seen.set(p.id, p),
      onMetrics: () => {},
      onListingChanged: () => {},
    },
  });

  const settled = (p: ReplyProposal | undefined) =>
    Boolean(p) && p!.status !== "drafting";

  return {
    r, llm, pipeline,
    async ask(text: string) {
      const msg = await pipeline.ingest({ author: "@buyer", text });
      assert.ok(msg.admitted, `"${text}" was dropped by the gate: ${msg.dropReason}`);
      const id = `prop_${msg.id}`;
      for (let i = 0; i < 400 && !settled(seen.get(id)); i++) {
        await new Promise((res) => setTimeout(res, 10));
      }
      const p = seen.get(id);
      assert.ok(settled(p), `proposal never settled (status ${p?.status})`);
      return p!;
    },
    async stop() {
      await pipeline.stop();
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 1. what the chain does with a revise
// ════════════════════════════════════════════════════════════════════════════

describe("three verdicts, three consequences", () => {
  let r: Rig;
  before(async () => { r = await rig(); });

  test("a draft whose only fault is an emoji is REVISE, not block", async () => {
    // The whole of DURING-01 in one case: a correct, grounded, in-policy reply
    // with one emoji in it. Aggregating revise to block made this unsendable,
    // uneditable and unregeneratable — Dismiss was the only control that worked.
    const chain = runChain(
      await guardInput(
        r, "how much for the chicagos",
        "The Chicago Reimagined in a size 10 is $412.00 right now 🔥",
        [{ text: "it is $412.00", factId: `listing:${PINNED}#price` }],
      ),
      { evidenceQuality: 0.9 },
    );
    assert.equal(chain.verdict, "revise");
    assert.equal(chain.guards.find((g) => g.guard === "tone")?.verdict, "revise",
      "the tone guard still names itself — the pills must not lose that");
    assert.ok(chain.failures.some((f) => /emoji/i.test(f.reason)),
      "and the repair pass is still told what to fix");
  });

  test("a reply over the character cap is REVISE, not block", async () => {
    const long = `The Chicago Reimagined is $412.00 and in excellent shape. ${"It is a great pair. ".repeat(25)}`;
    const chain = runChain(
      await guardInput(r, "how much for the chicagos", long,
        [{ text: "it is $412.00", factId: `listing:${PINNED}#price` }]),
      { evidenceQuality: 0.9 },
    );
    assert.equal(chain.verdict, "revise");
    assert.equal(chain.guards.find((g) => g.guard === "tone")?.verdict, "revise");
  });

  test("a real violation is still BLOCK", async () => {
    const chain = runChain(
      await guardInput(r, "how do i reach you", "Email me at rae@kicksbyrae.com and I'll sort it out."),
      { evidenceQuality: 0.9 },
    );
    assert.equal(chain.verdict, "block");
    assert.equal(chain.guards.find((g) => g.guard === "pii")?.verdict, "block");
  });

  test("a revise alongside a block is a block — the harder verdict wins", async () => {
    const chain = runChain(
      await guardInput(r, "how do i reach you", "Email me at rae@kicksbyrae.com 🔥"),
      { evidenceQuality: 0.9 },
    );
    assert.equal(chain.verdict, "block");
    assert.equal(chain.guards.find((g) => g.guard === "tone")?.verdict, "revise");
    assert.equal(chain.guards.find((g) => g.guard === "pii")?.verdict, "block");
  });

  test("the ladder turns a revise into a card the seller can act on", () => {
    const d = decideReply({
      level: "L1_SUGGEST", intent: "price_question", verdict: "revise",
      confidence: 0.6, abstained: false,
    });
    assert.equal(d.kind, "needs_review");
    // And a block is still a block, at every rung.
    for (const level of ["L1_SUGGEST", "L3_AUTO_REPLY", "L4_AUTO_ACT"] as const) {
      assert.equal(
        decideReply({ level, intent: "shipping", verdict: "block", confidence: 0.99, abstained: false }).kind,
        "blocked",
      );
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. the same thing, through the real pipeline
// ════════════════════════════════════════════════════════════════════════════

describe("a revise through the whole pipeline", () => {
  test("the repair pass runs, and a repair that fixes it sends clean", async () => {
    const h = await harness();
    h.llm.drafts = [say("The Chicago Reimagined in a size 10 is $412.00 right now 🔥",
      [{ text: "it is $412.00", factId: `listing:${PINNED}#price` }])];
    h.llm.repairs = [say("The Chicago Reimagined in a size 10 is $412.00 right now.",
      [{ text: "it is $412.00", factId: `listing:${PINNED}#price` }])];

    const p = await h.ask("how much for the chicagos");
    assert.equal(h.llm.repairCalls, 1, "exactly one repair pass — the bound is part of the design");
    assert.match(h.llm.lastFailures, /tone: .*emoji/i, "and it was told which guard asked for what");
    assert.equal(p.repaired, true, "`repaired` is a live wire field again, not always false");
    assert.ok(p.spans.repairMs >= 0 && "repairMs" in p.spans);
    assert.equal(p.status, "ready");
    assert.equal(p.verdict, "allow");
    assert.ok(!p.draft.includes("🔥"));

    const sent = await h.pipeline.send(p.id);
    assert.equal(sent.status, "sent");
    await h.stop();
  });

  test("a repair that does NOT fix it still leaves a card that can be sent", async () => {
    // The card reaches the seller as needs_review — "Send anyway", Edit and
    // Regenerate all work. Under the aggregation this replaces, the same draft
    // was struck through with Dismiss as its only control.
    const h = await harness();
    const emoji = say("The Chicago Reimagined in a size 10 is $412.00 right now 🔥",
      [{ text: "it is $412.00", factId: `listing:${PINNED}#price` }]);
    h.llm.drafts = [emoji];
    h.llm.repairs = [emoji];

    const p = await h.ask("how much for the chicagos");
    assert.equal(p.status, "needs_review");
    assert.equal(p.verdict, "revise");
    assert.equal(p.repaired, true);
    assert.equal(p.guards.find((g) => g.guard === "tone")?.verdict, "revise");

    const sent = await h.pipeline.send(p.id);
    assert.equal(sent.status, "sent", "the API must not refuse what the console offers");
    assert.equal(sent.sentText, p.draft);
    await h.stop();
  });

  test("a regenerate of a revised card is not refused", async () => {
    const h = await harness();
    h.llm.drafts = [say("The Chicago Reimagined in a size 10 is $412.00 right now 🔥",
      [{ text: "it is $412.00", factId: `listing:${PINNED}#price` }])];
    const p = await h.ask("how much for the chicagos");
    assert.equal(p.status, "needs_review");
    const again = await h.pipeline.regenerate(p.id);
    assert.ok(again, "regenerate returns a proposal rather than throwing");
    await h.stop();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. an operator's edit
// ════════════════════════════════════════════════════════════════════════════

describe("editing a draft and sending it", () => {
  test("the operator's own sentence is not rejected for citing nothing", async () => {
    // DURING-02. With a full grounding fact set present, every substantive edit
    // was refused: the re-guard fed `claims: []` to claim_grounding, which
    // returns revise for anything longer than a greeting, and revise was block.
    // The operator's words were rejected for not citing an id nobody asked
    // them to supply.
    const h = await harness();
    h.llm.drafts = [say("Ground Advantage, about three days.",
      [{ text: "ships Ground Advantage", factId: "policy:pol_ship_domestic" }])];
    const p = await h.ask("how does it ship and how long");

    const edit = "Yes, it ships USPS Ground Advantage and usually arrives in about 3 days.";
    const sent = await h.pipeline.send(p.id, edit);
    assert.equal(sent.status, "sent");
    assert.equal(sent.sentText, edit);
    assert.equal(
      sent.guards.find((g) => g.guard === "claim_grounding")?.verdict, "n/a",
      "the citation audit has nothing to say about a human assertion, and says so",
    );
    await h.stop();
  });

  test("a rewritten condition sentence sends, as does a plain 'yes'", async () => {
    const h = await harness();
    h.llm.drafts = [say("It is in good shape.",
      [{ text: "light creasing", factId: "listing:lst_sb_dunk_9#condition" }])];
    const p = await h.ask("how much creasing on the chunky dunkys");
    for (const edit of [
      "It's in great shape overall and the stitching is clean, just light creasing on the toe box.",
      "yes",
    ]) {
      const sent = await h.pipeline.send(p.id, edit);
      assert.equal(sent.sentText, edit);
    }
    await h.stop();
  });

  test("but every guard that protects the BUYER still runs on the edit", async () => {
    const h = await harness();
    h.llm.drafts = [say("The Chicago Reimagined in a size 10 is $412.00.",
      [{ text: "it is $412.00", factId: `listing:${PINNED}#price` }])];
    const p = await h.ask("how much for the chicagos");

    await assert.rejects(
      () => h.pipeline.send(p.id, "Sure — email me at rae@kicksbyrae.com and I'll sort it."),
      (e: Error) => e instanceof SendRefused && /pii/.test(e.message),
      "PII in the seller's own words is still PII",
    );
    await assert.rejects(
      () => h.pipeline.send(p.id, "I can let those go for $10.00, just for you."),
      (e: Error) => e instanceof SendRefused && /price/.test(e.message),
      "and a price below the floor is still below the floor",
    );
    // The proposal survived both refusals unsent.
    assert.equal(h.pipeline.get(p.id)?.status, "ready");
    await h.stop();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. the held card's promise
// ════════════════════════════════════════════════════════════════════════════

describe("a blocked card says 'edit it and send' — and now that is true", () => {
  test("an edit that clears the block is sent; the unedited draft is not", async () => {
    // DURING-03. `send` refused a blocked proposal BEFORE reaching the edit
    // re-guard, so no path existed — UI or API — that could do what the card's
    // own copy told the operator to do.
    const h = await harness();
    h.llm.drafts = [say("Sure — email me at rae@kicksbyrae.com and I'll sort it out.")];
    h.llm.repairs = [say("Sure — email me at rae@kicksbyrae.com and I'll sort it out.")];
    const p = await h.ask("how do i reach you about the chicagos");
    assert.equal(p.status, "blocked");
    assert.equal(p.guards.find((g) => g.guard === "pii")?.verdict, "block");

    await assert.rejects(
      () => h.pipeline.send(p.id),
      (e: Error) => e instanceof SendRefused && /unedited/.test(e.message),
      "as it stands, it still cannot be sent",
    );

    const fixed = "Drop me a message through the eBay app and I'll get back to you.";
    const sent = await h.pipeline.send(p.id, fixed);
    assert.equal(sent.status, "sent");
    assert.equal(sent.sentText, fixed);
    assert.notEqual(sent.verdict, "block");
    await h.stop();
  });

  test("an edit that does NOT clear the block is refused, by guard name", async () => {
    const h = await harness();
    h.llm.drafts = [say("Sure — email me at rae@kicksbyrae.com and I'll sort it out.")];
    h.llm.repairs = [say("Sure — email me at rae@kicksbyrae.com and I'll sort it out.")];
    const p = await h.ask("how do i reach you about the chicagos");
    assert.equal(p.status, "blocked");

    await assert.rejects(
      () => h.pipeline.send(p.id, "Sure — try rae@kicksbyrae.com instead."),
      (e: Error) => e instanceof SendRefused && /pii/.test(e.message),
    );
    assert.equal(h.pipeline.get(p.id)?.status, "blocked");
    await h.stop();
  });

  test("clearing a block by editing is written down as exactly that", async () => {
    const h = await harness();
    h.llm.drafts = [say("Sure — email me at rae@kicksbyrae.com and I'll sort it out.")];
    h.llm.repairs = [say("Sure — email me at rae@kicksbyrae.com and I'll sort it out.")];
    const p = await h.ask("how do i reach you about the chicagos");
    await h.pipeline.send(p.id, "Drop me a message through the eBay app.");
    // The audit append is deliberately not awaited on the send path — a buyer's
    // reply must not wait on a write — so give the chain a beat to land.
    let sentEntry: Awaited<ReturnType<typeof h.r.audit.list>>[number] | undefined;
    for (let i = 0; i < 100 && !sentEntry; i++) {
      sentEntry = (await h.r.audit.list()).find((e) => e.kind === "reply_sent");
      if (!sentEntry) await new Promise((res) => setTimeout(res, 10));
    }
    assert.ok(sentEntry, "the send is in the audit chain");
    assert.equal((sentEntry!.detail as Record<string, unknown>).clearedBlockByEdit, true);
    assert.equal((sentEntry!.detail as Record<string, unknown>).edited, true);
    await h.stop();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. guards that know which surface they are on
// ════════════════════════════════════════════════════════════════════════════

describe("the policy guard on a surface with no policy corpus", () => {
  const fact = (factId: string, text: string): Fact => ({
    factId, corpus: "schedule", source: "catalog", label: "the schedule", text,
    field: "description", tokens: terms(text), vector: ngramVector(text),
  });

  const input = (surface: string, answer: string): GuardInput => {
    const facts = [fact("schedule:merch", "Merch drops go out the week after the stream.")];
    return {
      draft: { answer, claims: [], parsedOk: true, raw: answer },
      question: "when does the merch ship",
      facts,
      factById: new Map(facts.map((f) => [f.factId, f])),
      currentListings: new Map(),
      slots: { listingIds: [], viaAnaphora: false } as unknown as GuardInput["slots"],
      policies: [],
      surface: capabilitiesOf(surface),
      community: [],
    };
  };

  test("a shipping answer on Twitch is not held for a clause that cannot exist", () => {
    // DURING-07. Twitch's corpora are schedule/sponsor/product/qa/community —
    // there is no policy corpus to retrieve a shipping clause from, so every
    // reply touching shipping, returns or authenticity was held forever. The
    // price and availability guards have had this gate since surfaces landed.
    const i = input("twitch", "Merch shipping goes out the week after the stream, straight from the printer.");
    assert.equal(policyGuard.run(i).verdict, "allow");
    assert.notEqual(runChain(i).verdict, "block");
  });

  test("the same answer on eBay Live, which HAS a policy corpus, is still checked", () => {
    const i = input("ebaylive", "Merch shipping goes out the week after the stream, straight from the printer.");
    const g = policyGuard.run(i);
    assert.equal(g.verdict, "revise");
    assert.match(g.reason!, /shipping/);
  });

  test("the never-say list is OUR rule and applies on every surface", () => {
    // The gate goes in below the prohibited-claim scan on purpose: a claim we
    // told the copilot never to make is not a claim about a corpus.
    const i = input("twitch", "These are guaranteed authentic, 100% legit, no question.");
    assert.equal(policyGuard.run(i).verdict, "block");
  });
});

describe("a money amount the host said out loud", () => {
  const hostFact = (text: string): Fact => ({
    factId: "host:1758294011234", source: "host", corpus: "listing",
    label: "the host said, 12s ago", text, field: "price",
    tokens: terms(text), vector: ngramVector(text),
  });

  async function priceInput(r: Rig, answer: string): Promise<GuardInput> {
    const i = await guardInput(r, "how much for the chicagos", answer);
    return { ...i, facts: [...i.facts, hostFact("these usually go for $200 all day")] };
  }

  let r: Rig;
  before(async () => { r = await rig(); });

  test("is NOT a price we may quote as this lot's", async () => {
    // DURING-14. The verbatim-in-a-fact escape was written for shipping charges
    // in listing prose and swallowed host speech by accident — so the copilot
    // quoted $200 for an $80 lot with a green price pill on it, through the one
    // guard whose entire purpose is stale prices.
    const i = await priceInput(r, "That one is $200.00.");
    const g = priceGuard.run(i);
    assert.equal(g.verdict, "block");
    assert.match(g.reason!, /the host said/i);
  });

  test("may be REPORTED, because reporting the room commits us to nothing", async () => {
    const i = await priceInput(r, "The host just said these usually go for $200.00 — the listed price is what stands.");
    assert.equal(priceGuard.run(i).verdict, "allow");
  });

  test("and passes untouched when it agrees with the live listing", async () => {
    const listing = (await r.repo.listings()).find((l) => l.id === PINNED)!;
    const i = await guardInput(r, "how much for the chicagos", `That one is $${(listing.priceCents / 100).toFixed(2)}.`);
    const withHost = {
      ...i,
      facts: [...i.facts, hostFact(`this one is $${(listing.priceCents / 100).toFixed(2)} right now`)],
    };
    assert.equal(priceGuard.run(withHost).verdict, "allow");
  });

  test("a shipping charge written into a POLICY clause still passes, as it always did", async () => {
    const i = await guardInput(
      r, "how much for the pandas and whats shipping",
      "The Panda Dunks are $128.00 and ship USPS Ground Advantage at a flat $9.95.",
      [
        { text: "they are $128.00", factId: "listing:lst_dunk_panda_11#price" },
        { text: "ships Ground Advantage at a flat $9.95", factId: "policy:pol_ship_domestic" },
      ],
    );
    assert.equal(priceGuard.run(i).verdict, "allow");
  });
});
