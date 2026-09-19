/**
 * The market median has to reach the model, not just the chips.
 *
 * Research was pushed onto `r.evidence` and nowhere else. `r.evidence` is the
 * operator's citation strip; `r.facts` is what the composer is handed, what
 * `buildContextBlock` renders as GROUNDING FACTS, and what becomes `factById`
 * for the guards. So a buyer asking "is that a good price?" got a card showing
 * a **Market · asking now** chip beside a reply saying the host would cover it
 * — the median was fetched, billed and attached, and shown to nothing. Worse:
 * had the model quoted it anyway, `claimGroundingGuard` would have blocked the
 * reply for citing an id that resolved to nothing.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { rig, cleanup, PINNED, type Rig } from "./helpers.js";
import { Pipeline } from "../src/pipeline/pipeline.js";
import { ResearchService } from "../src/research/research.js";
import { ActionProposer } from "../src/actions/proposer.js";
import { ShowContextEngine } from "../src/ingest/showContext.js";
import type { LlmPort } from "../src/llm/types.js";
import type { ReplyProposal } from "../src/domain/types.js";

after(cleanup);

const QUESTION = "is that a good price for it?";

/**
 * A model that answers out of whatever it was actually given.
 *
 * It quotes the market fact by id and by amount if the context block carries
 * one, and abstains if it does not — which is precisely what the real model
 * did, for the same reason, before this was fixed.
 */
function citingLlm(seen: string[]): LlmPort {
  const reply = (context: string) => {
    seen.push(context);
    const m = context.match(/(market:[^\]\s]+#median)/);
    // The amount as the market fact states it — read from that fact's own line,
    // the way the model is told to.
    const money = m ? context.slice(m.index ?? 0).match(/\$[\d,]+\.\d\d/) : null;
    return m && money
      ? JSON.stringify({
          answer: `Comparable ones are asking around ${money[0]} right now.`,
          claims: [{ text: `asking around ${money[0]}`, factId: m[1] }],
        })
      : JSON.stringify({ answer: "The host will cover that in a moment.", claims: [] });
  };
  return {
    name: "stub",
    chatTurn: async (_m, context) => reply(context),
    chatTurnStream: async (_m, context, onDelta) => {
      const r = reply(context);
      onDelta(r, r);
      return r;
    },
    utilityTurn: async () => "{}",
  };
}

function pipelineFor(r: Rig, llm: LlmPort): Pipeline {
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
  });
}

/**
 * A show whose comparables are NOT in the retrieval index.
 *
 * The index builds one `market:<sku>#median` fact per SKU at rebuild time, so
 * on the seeded demo catalog research's own market fact is a duplicate and gets
 * deduped away — which is exactly why this defect survived a green suite. The
 * real case is a catalog whose comps arrived after the index was built, or come
 * from eBay's live asking prices, which the index never sees at all. This
 * reproduces it with the first: delete the comps, rebuild, then put them back.
 */
async function compsOutsideTheIndex(r: Rig): Promise<number> {
  const listing = (await r.repo.listing(PINNED))!;
  await r.repo.updateShow({ pinnedListingId: PINNED });
  await r.d.query("DELETE FROM comps WHERE show_id = $1", [r.showId]);
  await r.retriever.rebuild();
  const medianCents = 39000;
  for (const priceCents of [medianCents - 1500, medianCents, medianCents + 1500]) {
    await r.repo.insertComp({
      sku: listing.sku, title: listing.title, priceCents, basis: "sold",
      soldAt: new Date(Date.now() - 86_400_000).toISOString(),
      condition: listing.condition, size: listing.size,
    });
  }
  assert.equal(
    r.retriever.retrieve(QUESTION, { pinnedId: PINNED }).facts.some((f) => f.factId.startsWith("market:")),
    false,
    "the index must not already carry the median, or this proves nothing",
  );
  return medianCents;
}

async function drafted(p: Pipeline, text: string): Promise<ReplyProposal> {
  const msg = await p.ingest({ author: "@buyer", text }, { force: true });
  for (let i = 0; i < 200; i++) {
    const found = p.get(`prop_${msg.id}`);
    if (found && found.status !== "drafting") return found;
    await new Promise((x) => setTimeout(x, 10));
  }
  throw new Error("the draft never settled");
}

test("a market question is grounded in the median, not merely decorated with it", async () => {
  const r = await rig();
  await compsOutsideTheIndex(r);
  const seen: string[] = [];
  const proposal = await drafted(pipelineFor(r, citingLlm(seen)), QUESTION);

  const context = seen.at(-1) ?? "";
  assert.match(
    context,
    /market:[^\]\s]+#median/,
    "the composer must be GIVEN the median it is expected to answer from",
  );
  assert.match(context, /Median/i);

  // And the same fact is on the card, as it always was.
  assert.ok(
    proposal.evidence.some((e) => e.factId.startsWith("market:") && e.source === "market"),
    "the operator's citation chips keep the market evidence",
  );
});

test("a reply that CITES the median passes the guards instead of being blocked by them", async () => {
  const r = await rig();
  await compsOutsideTheIndex(r);
  const proposal = await drafted(pipelineFor(r, citingLlm([])), QUESTION);

  assert.match(proposal.draft, /asking around \$/, "the model answered from the median");
  assert.equal(proposal.claims[0]?.factId.startsWith("market:"), true);

  const grounding = proposal.guards.find((g) => g.guard === "claim_grounding");
  assert.notEqual(
    grounding?.verdict,
    "block",
    `citing the median must resolve: ${grounding?.reason ?? ""}`,
  );
  const price = proposal.guards.find((g) => g.guard === "price");
  assert.notEqual(price?.verdict, "block", `the median is a grounded amount: ${price?.reason ?? ""}`);
  assert.notEqual(proposal.status, "blocked");
});

test("a question that is not about the market pays for no market lookup", async () => {
  const r = await rig();
  const seen: string[] = [];
  await drafted(pipelineFor(r, citingLlm(seen)), "does this ship to canada?");
  assert.doesNotMatch(
    seen.at(-1) ?? "",
    /market:[^\]\s]+#median/,
    "comps belong in a reply that compares or prices, and nowhere else",
  );
});
