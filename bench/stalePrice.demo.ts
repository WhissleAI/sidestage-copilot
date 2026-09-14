// The concrete failure path, demonstrated end to end.
//
//   npm run demo:stale-price
//
// A markdown lands mid-show, in the window between a reply being grounded and
// that reply being sent. The draft is now quoting a price that was true four
// seconds ago and is not true any more. Nothing in the model's output looks
// wrong — it is fluent, on-topic, and cites a real fact. The only thing that can
// catch it is state the model does not have: the listing's CURRENT version.
//
// This script forces exactly that race, and shows the guard catching it, the
// repair pass re-grounding against the new version, and both events landing in
// the hash-chained audit log.

import { buildBench } from "./harness.js";
import { formatMoney } from "../src/domain/money.js";
import { runChain } from "../src/guardrails/chain.js";
import { Composer } from "../src/compose/composer.js";
import { WhissleClient } from "../src/llm/whissle.js";
import { config } from "../src/config.js";
import { buildContextBlock } from "../src/compose/prompts.js";

const line = (s = "") => console.log(s);
const rule = () => line("  " + "─".repeat(72));

async function main(): Promise<void> {
  const b = await buildBench();
  const llm = new WhissleClient({
    apiKey: config.whissle.apiKey, agentId: config.whissle.agentId,
    baseUrl: config.whissle.base, timeoutMs: 20_000,
  });
  const composer = new Composer(llm);

  const show = await b.repo.show();
  const question = "how much for the chicagos?";
  const author = "mia_k";

  line();
  line("  STALE PRICE — the race a live seller actually loses");
  rule();

  // ── t0: a buyer asks. We ground the answer against the catalog as it is now.
  const before = (await b.repo.pinned())!;
  line(`  t+0.0s  ${before.title}`);
  line(`          listed ${formatMoney(before.priceCents)}, listing version ${before.version}`);
  line(`  t+0.1s  buyer @${author}: "${question}"`);

  const grounded = b.retriever.retrieve(question, { pinnedId: show.pinnedListingId });
  const priceFact = grounded.facts.find((f) => f.factId === `listing:${before.id}#price`)!;
  line(`  t+0.1s  retrieved ${priceFact.factId} @ v${priceFact.listingVersion} — "${priceFact.text}"`);

  const inputs = {
    show, pinned: before, context: null,
    facts: grounded.facts, abstain: grounded.abstain, viaAnaphora: grounded.slots.viaAnaphora,
  };
  const { draft } = await composer.draft(inputs, author, question);
  line(`  t+1.3s  drafted: "${draft.answer}"`);
  line(`          claims: ${draft.claims.map((c) => c.factId).join(", ") || "(none)"}`);

  // ── t+1.4s: the seller marks the item down. A real, audited write.
  rule();
  const action = await b.exec.propose(
    "markdown_price", before.id, { newPriceCents: 37000 },
    `Mark down ${before.title} — ${formatMoney(before.priceCents)} to ${formatMoney(37000)}`,
    "Four buyers asked for a discount in the last three minutes.",
  );
  await b.exec.approve(action.id, "seller");
  const after = (await b.repo.listing(before.id))!;
  line(`  t+1.4s  SELLER MARKS DOWN — ${formatMoney(before.priceCents)} to ${formatMoney(after.priceCents)}`);
  line(`          listing is now version ${after.version}; the draft above is grounded on v${priceFact.listingVersion}`);

  // ── t+1.5s: the draft is about to be sent. Guards run against CURRENT state.
  rule();
  // Read CURRENT state once, after the markdown landed — that gap is the point
  // of the whole demonstration.
  const [nowListings, nowPolicies] = await Promise.all([b.repo.listings(), b.repo.policies()]);
  const guardInput = (d: typeof draft) => ({
    draft: d,
    question,
    facts: grounded.facts,
    factById: new Map(grounded.facts.map((f) => [f.factId, f])),
    currentListings: new Map(nowListings.map((l) => [l.id, l])),
    slots: grounded.slots,
    policies: nowPolicies,
  });

  const verdict = runChain(guardInput(draft), { evidenceQuality: grounded.evidence[0]?.score ?? 0 });
  line(`  t+1.5s  guardrail chain: ${verdict.verdict.toUpperCase()}`);
  for (const g of verdict.guards) {
    if (g.verdict === "allow" || g.verdict === "n/a") continue;
    line(`          ${g.guard}: ${g.reason}`);
    if (g.detail) line(`            expected ${g.detail.expected}   found ${g.detail.found}`);
  }

  if (verdict.verdict === "allow") {
    line();
    line("  The guard did NOT catch it. Either the model happened not to quote a price,");
    line("  or the staleness check has regressed — either way, look at the draft above.");
    line();
    return;
  }

  // ── repair: re-ground against the listing as it is NOW.
  rule();
  await b.retriever.rebuild();
  const fresh = b.retriever.retrieve(question, { pinnedId: show.pinnedListingId });
  const freshFact = fresh.facts.find((f) => f.factId === `listing:${before.id}#price`)!;
  line(`  t+1.6s  re-grounding: ${freshFact.factId} @ v${freshFact.listingVersion} — "${freshFact.text}"`);

  const repaired = await composer.repair(
    buildContextBlock({ ...inputs, pinned: after, facts: fresh.facts, abstain: fresh.abstain }),
    author, question, verdict.failures,
  );
  const after2 = runChain(
    {
      ...guardInput(repaired),
      facts: fresh.facts,
      factById: new Map(fresh.facts.map((f) => [f.factId, f])),
      slots: fresh.slots,
    },
    { evidenceQuality: fresh.evidence[0]?.score ?? 0 },
  );
  line(`  t+2.8s  repaired: "${repaired.answer}"`);
  line(`  t+2.8s  guardrail chain: ${after2.verdict.toUpperCase()}`);

  // ── the audit trail
  rule();
  line("  audit log");
  for (const e of await b.audit.list()) {
    line(`    #${e.seq}  ${e.kind.padEnd(20)} ${e.actorType.padEnd(8)} ${e.summary}`);
  }
  const v = await b.audit.verify();
  line(`    chain ${v.ok ? "intact" : `BROKEN at #${v.brokenAt}`} (${v.height} entries)`);

  rule();
  line(`  Net: a fluent, plausible, well-cited reply that would have quoted a price`);
  line(`  ${formatMoney(before.priceCents - after.priceCents)} too high was stopped by comparing the fact's listing version`);
  line(`  against the live one. No model was asked whether the reply was correct.`);
  line();
}

main().catch((e) => {
  console.error(`demo failed — ${(e as Error).message}`);
  process.exit(1);
});
