// Unit tests for the pieces the two eval suites do not cover: the admission
// gate, the version-keyed cache, the autonomy ladder, and the action proposer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { rig, judge, PINNED } from "./helpers.js";
import { admit, classify, isHype, RateLimiter } from "../src/ingest/classify.js";
import { cacheKey, ReplyCache } from "../src/latency/cache.js";
import { decideAction, decideReply } from "../src/autonomy/ladder.js";
import { ActionProposer } from "../src/actions/proposer.js";
import { extractMoneyCents, formatMoney } from "../src/domain/money.js";
import { extractJsonObject, normalizeFactId, parseDraft, partialAnswer } from "../src/compose/composer.js";
import { toContentGuardrails, toActionPolicy, policy } from "../src/guardrails/policy.js";
import { buildRegenerateBlock } from "../src/compose/prompts.js";
import { normalizeDistribution } from "../src/ingest/signals.js";

// ── ingest ──────────────────────────────────────────────────────────────────

test("classify routes the live-chat question vocabulary", async () => {
  assert.equal(classify("whats the lowest on the chicagos?"), "discount_request");
  assert.equal(classify("how much for the pandas"), "price_question");
  assert.equal(classify("size 10 still there??"), "availability");
  assert.equal(classify("do the 990s run big"), "sizing");
  assert.equal(classify("ship to canada?"), "shipping");
  assert.equal(classify("whats the return policy"), "returns");
  assert.equal(classify("are these authenticated"), "authenticity");
  assert.equal(classify("chicago reimagined vs the 2015 which is better"), "comparison");
  assert.equal(classify("LETS GOOO"), "hype");
  assert.equal(classify("W"), "hype");
});

test("hype detection keeps reactions out of the reply queue", async () => {
  for (const s of ["W", "W W W", "LETS GOOO", "gg", "fire", "haha", "🔥🔥", "lol lol"]) {
    assert.equal(isHype(s), true, `"${s}" should be hype`);
  }
  for (const s of ["how much", "ship to canada", "size 10 still there"]) {
    assert.equal(isHype(s), false, `"${s}" should not be hype`);
  }
});

test("a question without a question mark is still a question", async () => {
  // Buyers on phones drop the "?" constantly. Treating these as hype silently
  // dropped real questions.
  assert.notEqual(classify("can you hold it til friday"), "hype");
  assert.equal(admit("can you hold it til friday", classify("can you hold it til friday"), true).admitted, true);
  assert.equal(admit("do you have these in a 12", "other", true).admitted, true);
});

test("the admission gate reports WHY it dropped a message", async () => {
  assert.match(admit("W", "hype", true).reason!, /reaction/);
  assert.match(admit("ok", "other", true).reason!, /too short/);
  assert.match(admit("these are clean", "other", true).reason!, /no question/);
  assert.match(admit("how much for the pandas", "price_question", false).reason!, /rate cap/);
});

test("the rate limiter spends its budget then refuses", async () => {
  const rl = new RateLimiter(3);
  assert.equal(rl.tryAdmit(), true);
  assert.equal(rl.tryAdmit(), true);
  assert.equal(rl.tryAdmit(), true);
  assert.equal(rl.tryAdmit(), false);
});

// ── money ───────────────────────────────────────────────────────────────────

test("money parses the shapes buyers and sellers actually type", async () => {
  assert.deepEqual(extractMoneyCents("it is $412.00"), [41200]);
  assert.deepEqual(extractMoneyCents("$1,180"), [118000]);
  assert.deepEqual(extractMoneyCents("412 dollars"), [41200]);
  assert.deepEqual(extractMoneyCents("can you do 380"), [38000]);
  assert.deepEqual(extractMoneyCents("would you take 360 shipped"), [36000]);
  // A percentage is not a price.
  assert.deepEqual(extractMoneyCents("discounts cap at 15% off"), []);
  // A quantity is not a price.
  assert.deepEqual(extractMoneyCents("there are 3 left"), []);
});

test("money formats with separators", async () => {
  assert.equal(formatMoney(41200), "$412.00");
  assert.equal(formatMoney(118000), "$1,180.00");
  assert.equal(formatMoney(0), "$0.00");
});

// ── composer parsing ────────────────────────────────────────────────────────

test("the JSON extractor counts braces instead of matching greedily", async () => {
  const s = 'prose before {"answer":"a","claims":[{"text":"t","factId":"f"}]} and after {"other":1}';
  const o = extractJsonObject(s)!;
  assert.equal(o.answer, "a");
  // A greedy /\{[\s\S]*\}/ would swallow both objects and fail to parse.
  assert.ok(Array.isArray(o.claims));
});

test("a model that answers in prose still produces a checkable draft", async () => {
  const d = parseDraft("Sure — they're $412 and ship free.");
  assert.equal(d.parsedOk, false);
  assert.equal(d.claims.length, 0);
  assert.match(d.answer, /\$412/);
});

test("a factId copied back WITH its display brackets still resolves", async () => {
  // Facts are presented as `[listing:x#price] ...` and the live agent reliably
  // copies that display format into the citation. Left strict, the grounding
  // guard blocked a large fraction of perfectly good replies.
  assert.equal(normalizeFactId("[listing:lst_aj1_chi_10#price]"), "listing:lst_aj1_chi_10#price");
  assert.equal(normalizeFactId("  policy:pol_returns "), "policy:pol_returns");
  assert.equal(normalizeFactId('"qa:qa_box"'), "qa:qa_box");
  assert.equal(normalizeFactId("listing:x#price"), "listing:x#price");

  const d = parseDraft('{"answer":"$412.00","claims":[{"text":"$412.00","factId":"[listing:x#price]"}]}');
  assert.equal(d.claims[0].factId, "listing:x#price");
});

test("fenced JSON is handled", async () => {
  const d = parseDraft('```json\n{"answer":"Yes, $412.00.","claims":[{"text":"$412.00","factId":"listing:x#price"}]}\n```');
  assert.equal(d.parsedOk, true);
  assert.equal(d.claims[0].factId, "listing:x#price");
});

// ── cache ───────────────────────────────────────────────────────────────────

test("the cache key normalises wording but not meaning", async () => {
  const facts = [{ factId: "listing:x#price", text: "It is $412.00." }];
  assert.equal(
    cacheKey({ question: "how much for the pandas", facts }),
    cacheKey({ question: "the pandas, how much?", facts }),
  );
  assert.notEqual(
    cacheKey({ question: "how much for the pandas", facts }),
    cacheKey({ question: "how much for the dunks", facts }),
  );
});

test("the cache key ignores the ORDER retrieval happened to rank facts in", async () => {
  const a = [
    { factId: "policy:returns", text: "30-day returns." },
    { factId: "listing:x#price", text: "It is $412.00." },
  ];
  const b = [...a].reverse();
  assert.equal(cacheKey({ question: "whats the return policy", facts: a }),
               cacheKey({ question: "whats the return policy", facts: b }));
});

test("a changed FACT makes the old entry unreachable", async () => {
  const q = "how much for the chicagos";
  const before = [{ factId: "listing:x#price", text: "It is $412.00." }];
  const after = [{ factId: "listing:x#price", text: "It is $370.00." }];
  const k1 = cacheKey({ question: q, facts: before });
  const k2 = cacheKey({ question: q, facts: after });
  assert.notEqual(k1, k2);

  const c = new ReplyCache();
  const entry = { answer: "$412.00", claims: [], evidence: [], guards: [], verdict: "allow" as const, confidence: 0.9, repaired: false };
  c.set(k1, entry);
  assert.ok(c.get(k1));
  assert.equal(c.get(k2), null, "the post-markdown key must miss");
});

test("an unrelated lot taking a bid does NOT invalidate the answer", async () => {
  // The whole reason the hit rate sat at 0% on a live auction: keying on every
  // listing's VERSION meant one bid on a lot the answer never mentioned changed
  // the key. A return-policy answer does not depend on what the Chicagos sold for.
  const q = "whats the return policy";
  const facts = [
    { factId: "policy:pol_returns", text: "30-day returns on unworn items." },
    { factId: "listing:lst_aj1#identity", text: "Air Jordan 1, size 10, DS." },
  ];
  const sameAfterABid = [
    { factId: "policy:pol_returns", text: "30-day returns on unworn items." },
    { factId: "listing:lst_aj1#identity", text: "Air Jordan 1, size 10, DS." },
  ];
  assert.equal(cacheKey({ question: q, facts }), cacheKey({ question: q, facts: sameAfterABid }));
});

test("a reply that failed a guardrail is never cached", async () => {
  const c = new ReplyCache();
  const blocked = { answer: "x", claims: [], evidence: [], guards: [], verdict: "block" as const, confidence: 0.1, repaired: false };
  c.set("k", blocked);
  assert.equal(c.get("k"), null);
  assert.equal(c.size, 0);
});

// ── autonomy ladder ─────────────────────────────────────────────────────────

test("a blocked draft never auto-sends, at any rung", async () => {
  for (const level of ["L1_SUGGEST", "L2_ONE_TAP", "L3_AUTO_REPLY", "L4_AUTO_ACT"] as const) {
    const d = decideReply({ level, intent: "shipping", verdict: "block", confidence: 0.99, abstained: false });
    assert.equal(d.kind, "blocked", `${level} must not auto-send a blocked draft`);
  }
});

test("L3 auto-sends only allow-listed intents above the confidence floor", async () => {
  const base = { level: "L3_AUTO_REPLY" as const, verdict: "allow" as const, abstained: false };
  assert.equal(decideReply({ ...base, intent: "shipping", confidence: 0.9 }).kind, "auto_send");
  assert.equal(decideReply({ ...base, intent: "returns", confidence: 0.9 }).kind, "auto_send");
  // Price and discount move during a show — never auto-answered.
  assert.equal(decideReply({ ...base, intent: "price_question", confidence: 0.99 }).kind, "needs_review");
  assert.equal(decideReply({ ...base, intent: "discount_request", confidence: 0.99 }).kind, "needs_review");
  // Below the floor, even an allow-listed intent waits for a human.
  assert.equal(decideReply({ ...base, intent: "shipping", confidence: 0.5 }).kind, "needs_review");
});

test("L1 suggests, L0 drops, and abstention always needs a human", async () => {
  assert.equal(decideReply({ level: "L1_SUGGEST", intent: "shipping", verdict: "allow", confidence: 0.9, abstained: false }).kind, "suggest");
  assert.equal(decideReply({ level: "L0_OBSERVE", intent: "shipping", verdict: "allow", confidence: 0.9, abstained: false }).kind, "drop");
  assert.equal(decideReply({ level: "L4_AUTO_ACT", intent: "shipping", verdict: "allow", confidence: 0.99, abstained: true }).kind, "needs_review");
});

test("actions auto-commit only at L4, only for bounded kinds, only after preflight", async () => {
  assert.equal(decideAction("L4_AUTO_ACT", "markdown_price", true).kind, "auto_commit");
  assert.equal(decideAction("L4_AUTO_ACT", "adjust_stock", true).kind, "auto_commit");
  // Ending a listing or swapping the pinned lot always needs a human.
  assert.equal(decideAction("L4_AUTO_ACT", "end_listing", true).kind, "propose_only");
  assert.equal(decideAction("L4_AUTO_ACT", "swap_pinned", true).kind, "propose_only");
  // Preflight is a precondition, not an override.
  assert.equal(decideAction("L4_AUTO_ACT", "markdown_price", false).kind, "propose_only");
  assert.equal(decideAction("L3_AUTO_REPLY", "markdown_price", true).kind, "propose_only");
});

// ── proposer ────────────────────────────────────────────────────────────────

test("sustained discount pressure from DISTINCT buyers proposes a markdown", async () => {
  const r = await rig();
  const p = new ActionProposer(r.repo, { discountThreshold: 3 });
  const now = Date.now();

  // One buyer asking three times is not a signal.
  for (let i = 0; i < 3; i++) p.record({ at: now, intent: "discount_request", listingId: PINNED, author: "mia" });
  assert.equal((await p.evaluate()).filter((x) => x.kind === "markdown_price").length, 0);

  // Three different buyers is.
  p.record({ at: now, intent: "discount_request", listingId: PINNED, author: "dre" });
  p.record({ at: now, intent: "discount_request", listingId: PINNED, author: "vic" });
  const proposals = (await p.evaluate()).filter((x) => x.kind === "markdown_price");
  assert.equal(proposals.length, 1);
  assert.match(proposals[0].rationale, /3 different buyers/);
});

test("a proposed markdown respects the floor and the discount cap", async () => {
  const r = await rig();
  const listing = (await r.repo.listing(PINNED))!;
  const p = new ActionProposer(r.repo, { discountThreshold: 2 });
  const now = Date.now();
  for (const a of ["mia", "dre", "vic", "rae"]) {
    p.record({ at: now, intent: "discount_request", listingId: PINNED, author: a });
  }
  const md = (await p.evaluate()).find((x) => x.kind === "markdown_price")!;
  const next = Number(md.params.newPriceCents);
  assert.ok(next >= listing.floorPriceCents, `${next} must clear the floor ${listing.floorPriceCents}`);
  const off = ((listing.priceCents - next) / listing.priceCents) * 100;
  assert.ok(off <= policy().maxDiscountPct + 0.001, `${off.toFixed(1)}% must respect the cap`);
});

test("interest in an unpinned lot proposes a swap", async () => {
  const r = await rig();
  const p = new ActionProposer(r.repo, { swapThreshold: 3 });
  const now = Date.now();
  for (const a of ["mia", "dre", "vic"]) {
    p.record({ at: now, intent: "price_question", listingId: "lst_dunk_panda_11", author: a });
  }
  const swap = (await p.evaluate()).find((x) => x.kind === "swap_pinned");
  assert.ok(swap, "expected a swap_pinned proposal");
  assert.equal(swap!.listingId, "lst_dunk_panda_11");
});

test("a sold-out lot that chat is still asking about proposes an end", async () => {
  const r = await rig();
  await r.repo.mutateListing(PINNED, { qty: 0 });
  const p = new ActionProposer(r.repo);
  const now = Date.now();
  p.record({ at: now, intent: "availability", listingId: PINNED, author: "mia" });
  p.record({ at: now, intent: "availability", listingId: PINNED, author: "dre" });
  assert.ok((await p.evaluate()).some((x) => x.kind === "end_listing"));
});

// ── the two-layer guardrail policy ──────────────────────────────────────────

test("the policy projects into the gateway's content_guardrails shape", async () => {
  const cg = toContentGuardrails();
  assert.equal(cg.enabled, true);
  assert.equal(cg.redact_pii, true);
  assert.ok(cg.never_say.includes("investment"));
  assert.ok(cg.never_say.includes("venmo"));
  // Regex rules are wrapped in slashes, which is how content_guard.py reads them.
  assert.ok(cg.never_say.some((s) => s.startsWith("/") && s.endsWith("/")));
});

test("certificate-conditional rules stay OUT of the agent config", async () => {
  // The gateway's guard is a pure string match with no catalog access, so
  // pushing "100% authentic" there would blanket-block the phrase even on a
  // listing that genuinely carries a certificate. Those rules live app-side.
  const cg = toContentGuardrails();
  assert.ok(!cg.never_say.some((s) => s.includes("100%")), "conditional rules must not be pushed to the agent");
  assert.ok(policy().neverSay.some((r) => r.unlessCertified), "…but they must still exist app-side");
});

test("the policy projects into the gateway's action_policy shape", async () => {
  const ap = toActionPolicy();
  assert.equal(ap.send_email, "approve");
  assert.equal(ap.send_sms, "approve");
});

test("fact ids never reach the buyer-facing answer", async () => {
  // Observed against the live agent: it wrote the citation inline, producing
  // "Mookie Betts ($92) listing:lst_83de657499aa#price, Rafael Devers ...".
  const d = parseDraft(JSON.stringify({
    answer: "We have Betts ($92) listing:lst_83de657499aa#price and Devers ($38) [listing:lst_c2#price].",
    claims: [{ text: "Betts is $92", factId: "listing:lst_83de657499aa#price" }],
  }));
  assert.ok(!/listing:/.test(d.answer), `answer still contains an id: ${d.answer}`);
  assert.match(d.answer, /Betts \(\$92\)/);
  assert.match(d.answer, /Devers \(\$38\)/);
  // The citation itself must survive — only the buyer-facing copy is cleaned.
  assert.equal(d.claims[0].factId, "listing:lst_83de657499aa#price");
});

// ── inventory search: how collectors actually type ──────────────────────────

test("collector shorthand is recognised as an inventory search", async () => {
  const r = await rig();
  const q = (text: string) =>
    r.retriever.retrieve(text, { pinnedId: PINNED }).slots.inventoryQuery;

  // "1/1" is a one-of-one card. The term regex excluded "/" and "#", so these
  // fell through to a generic defer instead of a grounded "not in the lineup".
  assert.equal(q("Any 1/1?"), "1/1");
  assert.equal(q("any #/25"), "#/25");
  assert.equal(q("got any rc"), "rc");
  // Attribute questions must still not be read as inventory hunts.
  assert.equal(q("any deal if i take two"), null);
  assert.equal(q("whats the return policy"), null);
});

test("a question with no match in the lineup retrieves ONE fact, not a pile", async () => {
  const r = await rig();
  const res = r.retriever.retrieve("any lakers jerseys", { pinnedId: PINNED });
  assert.equal(res.evidence.length, 1, "an honest 'we don't have that' needs only the lineup");
  assert.equal(res.evidence[0].factId, "catalog:lineup");
});

test("regenerate asks for a DIFFERENT reply, not the same prompt again", async () => {
  // The agent is effectively deterministic: re-running an identical prompt
  // returns identical text, so Regenerate appeared to do nothing at all.
  const base = "=== GROUNDING FACTS ===\n[listing:x#price] It is $10.";
  const block = buildRegenerateBlock(base, "It is ten dollars.");
  assert.ok(block.startsWith(base), "the grounding must be preserved verbatim");
  assert.match(block, /REGENERATE/);
  assert.match(block, /It is ten dollars\./, "the rejected draft must be shown to the model");
  assert.match(block, /DIFFERENT reply/);
  assert.match(block, /SAME facts/);
});

// ── Whissle live-signal distributions ───────────────────────────────────────

test("gateway emotion/intent arrive as distributions, not labels", async () => {
  // Shape from docs/live-signal-stream.md §4.5. Labels are SCREAMING_SNAKE and
  // namespaced on the wire; an operator should read "happy", not "EMOTION_HAPPY".
  const d = normalizeDistribution({
    top_k: [
      { label: "EMOTION_HAPPY", p: 0.58 },
      { label: "EMOTION_NEUTRAL", p: 0.31 },
      { label: "EMOTION_SAD", p: 0.11 },
    ],
    top_label: "EMOTION_HAPPY",
    top_p: 0.58,
    changed: true,
    prev_label: "EMOTION_NEUTRAL",
    held_ms: 0,
    flips: 3,
    trusted: true,
  })!;

  assert.equal(d.topLabel, "happy");
  assert.equal(d.topP, 0.58);
  assert.deepEqual(d.topK.map((k) => k.label), ["happy", "neutral", "sad"]);
  assert.equal(d.changed, true);
  assert.equal(d.prevLabel, "neutral");
  assert.equal(d.flips, 3);
});

test("a bare label is kept but marked untrusted, never dressed up", async () => {
  // Older gateways emit a flat label. Synthesising a fake probability for it
  // would present a guess as a measurement.
  const d = normalizeDistribution("EMOTION_NEUTRAL")!;
  assert.equal(d.topLabel, "neutral");
  assert.equal(d.topP, 0);
  assert.equal(d.trusted, false);
  assert.equal(d.topK.length, 1);
});

test("normalising junk yields nothing rather than a fake reading", async () => {
  assert.equal(normalizeDistribution(null), null);
  assert.equal(normalizeDistribution(undefined), null);
  assert.equal(normalizeDistribution(""), null);
  assert.equal(normalizeDistribution({}), null);
});

// ── grounding holes found on a live show ────────────────────────────────────

test("a reply written from the host transcript alone is NOT waved through", async () => {
  // Seen live, at confidence 0.10 with a green grounding pill — unverified AND
  // presented as verified, which is the worst combination available. It carried
  // no digits and no catalog keywords, so the old FACTUAL test never fired.
  const r = await rig();
  const res = await judge(
    r,
    "what's up next",
    "Next up I'm diving into the rarity and significance of a historic coin, as I just discussed its volume and surviving examples.",
    [],
  );
  const g = res.guards.find((x) => x.guard === "claim_grounding")!;
  assert.equal(g.verdict, "revise", `expected revise, got ${g.verdict}`);
});

test("a greeting or an explicit deferral may still go uncited", async () => {
  const r = await rig();
  for (const text of [
    "Right here — what can I get you?",
    "The host will cover that shortly.",
    "Let me check on that for you.",
  ]) {
    const g = (await judge(r, "you there?", text, [])).guards.find((x) => x.guard === "claim_grounding")!;
    assert.equal(g.verdict, "allow", `"${text}" should need no citation, got ${g.verdict}`);
  }
});

test("a generic colour word alone does not match an item", async () => {
  // "Do you have any $2.50 incuse Indian gold coin" matched an Ivan Rodriguez
  // card, because "gold" appears in "Topps Gold".
  const r = await rig();
  const res = r.retriever.retrieve("Do you have any $2.50 incuse Indian gold coin", { pinnedId: PINNED });
  const listingChips = res.evidence.filter((e) => e.factId.startsWith("listing:"));
  assert.equal(listingChips.length, 0, `matched on a generic word: ${listingChips.map((e) => e.factId).join(", ")}`);
  assert.equal(res.evidence[0]?.factId, "catalog:lineup");
});

test("item descriptions survive a catalog that is not sneaker-shaped", async () => {
  const r = await rig();
  // brand === the leading word of model, and no size — the card shape.
  await r.repo.insertListing({
    sku: "SS-PUDGE-92", title: "Ivan Rodriguez 1992 Topps Gold #78", shortName: "Pudge 92 Gold",
    brand: "Topps", model: "Topps Gold", colorway: "Ivan Rodriguez", size: "",
    condition: "USED", priceCents: 2200, floorPriceCents: 1800, costCents: 1400, qty: 2,
    state: "queued", shippingProfile: "us-standard", authenticated: false, certId: null,
    description: "1992 Topps Gold parallel.", imageUrl: "",
  });
  await r.retriever.rebuild();

  const facts = r.retriever.retrieve("any pudge", { pinnedId: PINNED }).facts;
  const ident = facts.find((f) => f.field === "identity" && f.text.includes("Ivan Rodriguez"));
  assert.ok(ident, "the card's identity fact should be retrievable");
  assert.ok(!/Topps Topps/.test(ident!.text), `brand duplicated into model: ${ident!.text}`);
  assert.ok(!/size ,/.test(ident!.text), `dangling empty size: ${ident!.text}`);
  assert.ok(!/colorway/i.test(ident!.text), `"colorway" is wrong for a card: ${ident!.text}`);
});

// ── streaming (W-3) ─────────────────────────────────────────────────────────
//
// The gateway's streaming door hands back the reply a piece at a time, but the
// reply is JSON — so a partial stream is partial JSON, and showing it to a
// seller verbatim would put `{"answer":"The Air Jo` on screen. `partialAnswer`
// reads whatever of the answer STRING has arrived, which is the only part of
// the payload a human can read mid-flight.

test("partialAnswer reads the answer out of half-written JSON", async () => {
  assert.equal(partialAnswer(""), "");
  assert.equal(partialAnswer('{"ans'), "", "nothing to show before the key lands");
  assert.equal(partialAnswer('{"answer":"The Air Jo'), "The Air Jo");
  assert.equal(
    partialAnswer('{"answer":"They are $412.00.","claims":[]}'),
    "They are $412.00.",
    "stops at the closing quote rather than running into the claims",
  );
});

test("partialAnswer survives escapes split across chunks", async () => {
  // A chunk boundary can fall between a backslash and the character it escapes.
  // Treating the dangling backslash as literal would show a stray "\" and then
  // silently swallow the next character when the rest arrived.
  assert.equal(partialAnswer('{"answer":"line one\\'), "line one");
  assert.equal(partialAnswer('{"answer":"line one\\nline two'), "line one\nline two");
  assert.equal(partialAnswer('{"answer":"he said \\"hi'), 'he said "hi', "an escaped quote does not end the answer");
});

test("a streamed reply is judged on the COMPLETE draft, never the partial", async () => {
  // The safety property of W-3: streaming shortens time-to-first-token in the
  // operator's view and never time-to-send. A partially generated reply has
  // been checked by nothing, so it must never be sendable.
  const r = await rig();
  const partial = "The Chicago Reimagined is $3";       // a truncated price
  const complete = "The Chicago Reimagined is $412.00.";

  const onPartial = await judge(r, "how much for the chicagos", partial, [
    { text: partial, factId: `listing:${PINNED}#price` },
  ]);
  const onComplete = await judge(r, "how much for the chicagos", complete, [
    { text: complete, factId: `listing:${PINNED}#price` },
  ]);

  // $3 is not a price any fact states, so the partial WOULD be blocked — which
  // is exactly why the chain runs once, at the end, on the whole thing.
  assert.notEqual(onPartial.verdict, "allow");
  assert.equal(onComplete.verdict, "allow");
});
