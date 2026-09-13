# Guardrails — what they check, and what they let through

The six pills on every proposal card, in fixed order, so the operator learns the
positions: **price · stock · policy · grounding · tone · pii**.

```
− price   ✓ stock   ✓ policy   ✓ grounding   ✓ tone   ✓ pii
```

| Pill | Meaning |
|---|---|
| **✓ green** | `allow` — this guard checked the reply and found nothing wrong |
| **⚠ amber** | `revise` — one bounded repair pass, then the seller sees it |
| **✕ red** | `block` — never sendable without the seller editing it |
| **− grey** | `n/a` — this guard had nothing to check (no price claim in a shipping answer) |

`−` is **not** a failure. It is the most common source of confusion on the card
and it means the guard was not applicable.

---

## The rule every guard obeys

**No model is asked whether a reply is safe.** A guard either points at a fact
that contradicts the draft, or it allows. That is the difference between a
guardrail and a second opinion: a checker that shares the generator's blind spots
fails in the same direction at the same time, and adds a network hop inside a
2-second budget while doing it.

A guard that *throws* returns `block` (`chain.ts`). A crashing safety check that
silently passes is worse than no check.

All six run on every reply, even after one has blocked — so the operator sees the
complete picture, and the eval can measure each guard's precision independently
rather than only the first to fire.

---

## Two layers, one policy object

`src/guardrails/policy.ts` is a single configurable object projected into two
enforcement points that cannot drift.

### Layer A — inside the Whissle agent (preventive, channel-portable, state-blind)

`npm run seed:agent` pushes `content_guardrails` onto each catalog's agent:

```json
{ "enabled": true,
  "never_say": ["investment", "venmo", "/will (definitely )?arrive (by|on|before)/", …],
  "on_violation": "Let me get the host to answer that one directly.",
  "redact_pii": true }
```

The gateway's `services/content_guard.py` enforces this on the **live reply**, in
`text_turn` *and* in the voice `ContentGuardProcessor` — the same rule whether the
buyer is typing in show chat, using the embed widget, or on a call. It fires even
when this app is not in the loop.

Verified by read-back, not by hope: `seed:agent` re-reads `/api/agents/{id}/guardrails`
and prints what is actually armed (currently **15 never-say rules, PII redaction on**).

It also pushes `action_policy: {send_email: "approve", send_sms: "approve"}`, which
makes the gateway **hold** a sensitive tool call and raise an approve/discard
affordance instead of firing it.

**What Layer A cannot do:** know that the pinned lot's price changed four seconds ago.

### Layer B — inside this app (detective, state-aware, deterministic)

The six guards below, run against catalog state **re-read at guard time** — not the
state retrieval saw. The gap between those two is the whole point.

### The deliberate asymmetry

Rules marked `unlessCertified` — "guaranteed authentic", "100% authentic" — are
**not** pushed to the agent. The gateway's matcher is a pure string comparison
with no catalog access, so pushing them there would blanket-block the phrase even
on a listing that genuinely carries a CheckCheck certificate. Those rules live
only in Layer B, where `listing.authenticated` and `certId` are in hand.

That asymmetry is the honest version of "we have guardrails", and it is asserted
in `test/copilot.test.ts`.

---

## The six guards

### 1 · `price` — the signature check

Every money amount in the reply must be one of:

- **a grounding fact's exact value, at the listing's CURRENT version.** A fact read
  at `v12` when the live listing is `v13` is stale → **block**, naming both.
- **the buyer's own number, in a clause that declines it.** "I can't do $300" names
  an offer in order to refuse it, which commits to nothing.
- **an amount some retrieved fact states verbatim** — a shipping charge, a
  free-shipping threshold. Repeating a fact is not making an offer.
- **a discount on the resolved listing**, which the discount policy authorises — and
  which must then clear the floor price and the 15% cap.

Anything else is invented → **block**.

> This is the mechanism behind `npm run demo:stale-price`. A markdown landing
> between grounding and send produces a reply that is fluent, on-topic, cites a
> real fact, and is wrong. Nothing in the text gives it away — only the version does.

### 2 · `stock` (availability)

- Claims availability while every grounded lot has `qty 0` → **block**
- Says sold out while stock remains → **revise**
- "last one" when no cited lot has `qty 1` → **block**
- States a count no cited lot has → **block**

Scoped to the **named** item when the buyer named one, so scarcity claims stay
strict; widened to every grounded lot for an inventory search, where "the 1989 has
2 and the 1994 is the last one" is a correct sentence about two lots.

### 3 · `policy`

- The **never-say list** from the policy object — investment claims, promised
  delivery dates, off-platform payment, health claims, absolute authenticity
  without a certificate → **block**
- A claim about a policy topic (shipping / returns / authenticity) with **no clause
  of that topic in evidence** → **revise**

### 4 · `grounding` (claim grounding)

- A cited `factId` that **was never in the evidence set** → **block**. A fabricated
  citation is worse than none: it looks like provenance.
- A reply that **asserts something and cites nothing** → **revise**. Only a greeting
  or an explicit deferral may go uncited.
- A claim **not lexically connected** to the fact it cites → **revise**. Token
  overlap backed by trigram cosine — a cheap "is there any connection at all" test,
  not entailment. A guard that needs an LLM to decide is not a guard.

### 5 · `tone`

From the seller's voice guide: length cap (400 chars), no markdown, no emoji, no
hype beyond what condition notes support, no shouting, no profanity, never empty.

### 6 · `pii`

No email, phone number, card-like digit run or street address into public chat → **block**.
A certificate number is **not** PII and passes.

---

## Confidence

A reported quantity, never a model output — so it means the same thing on every
reply and the autonomy ladder can threshold on it:

```
0.45 + 0.50 × evidence_quality   −0.60 per block   −0.22 per revise
abstained → 0.10
```

A card reading **0.10 with all-green pills** is the signature of a reply that was
never really checked. That combination is what exposed the transcript-only hole.

---

## What the guards do NOT do

Stated plainly, because the pills look more authoritative than they are:

- **They do not check whether a reply is *good*** — only whether it is *safe*.
  A correct, dull, unhelpful answer passes all six.
- **They do not verify entailment.** `grounding` asks whether a claim is lexically
  connected to its fact, not whether the fact proves it.
- **They cannot catch what retrieval never surfaced.** If the right fact was not
  retrieved, no guard knows it is missing. Abstention is the defence, and it is
  driven by slot resolution failing — not by these guards.
- **They do not police the host's speech**, only the drafted reply.

---

## Measured

`npm run eval` — 46 labelled cases over the real catalog, ~half of which **should
pass** (a suite made only of violations measures nothing: a chain that blocks
everything scores perfectly on it).

```
caught 25   missed 0   false alarms 0   clean passes 21
precision 1.000   recall 1.000   f1 1.000

availability     fired on 4/4 of its own cases
claim_grounding  fired on 4/4
pii              fired on 2/2
policy           fired on 6/6
price            fired on 4/4
tone             fired on 5/5
```

Thresholds asserted in the suite are **asymmetric** — recall ≥ 0.95, precision ≥
0.90 — because a miss is a wrong answer sent to a buyer and a false alarm costs
the seller a glance.

**What that number does not mean.** 46 cases is small, they were written by the
same person who wrote the guards, and a perfect score on a self-authored suite
mostly demonstrates internal consistency. The suite's real value has been as a
bug-finder: it caught five during development, and live traffic caught four more
it never would have — including the transcript-only reply that passed with a
green pill.

Full methodology and the bug list: [`EVALS.md`](EVALS.md) and [`REVIEW.md`](REVIEW.md).
