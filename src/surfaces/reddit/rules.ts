// A subreddit's rules, as facts the guard chain can enforce.
//
// This is the one corpus in the system that nobody here wrote and nobody here
// can argue with. A subreddit's rules are the terms on which an account is
// allowed to speak in it, they are different in every room, and the penalty for
// breaking one is not a bad reply — it is a ban from a community the operator
// may have been part of for years. So they are fetched per room, cited by id,
// and handed to `communityRuleGuard` as CONSTRAINTS. They never ground a claim:
// a fact from this corpus is a thing the draft must not do, never a thing the
// draft may assert (see ingest/threadContext.ts).
//
// Cached for an hour. Rules change a few times a year and the endpoint is
// public, so re-reading it per draft would spend a rate-limit budget the
// message polling needs, to learn nothing.

import { terms, ngramVector } from "../../retrieval/text.js";
import type { Fact } from "../../retrieval/facts.js";
import type { RedditClient } from "./api.js";

export interface RawRule {
  kind?: string;
  /** The short name is the rule as moderators quote it: "No self-promotion". */
  short_name?: string;
  description?: string;
  /** What a report for this rule says, when the short name is only a heading. */
  violation_reason?: string;
  priority?: number;
}

export interface RawRules {
  rules?: RawRule[];
  site_rules?: unknown[];
}

export const RULES_TTL_MS = 60 * 60 * 1000;

/**
 * One fact per rule.
 *
 * The **number** is in the label because that is how a rule is cited in a
 * subreddit ("removed, rule 3") and the operator's next question about a
 * blocked draft is always "says who". The **short name** is in the label with
 * it because "r/mechmarket rule 3" alone is a citation nobody can check.
 *
 * The text carries the short name AND the description. The short name is a
 * heading — "No self-promotion" — and the teeth are often in the sentence
 * below it: "...including linking your own store, in comments or posts". The
 * guard reads prohibitions out of the text, so a description left out is a
 * prohibition not enforced. It cuts the other way too — more text is more
 * phrases to trip on, and this guard blocks — and that asymmetry is settled
 * deliberately: an over-blocked draft costs a human one glance, an under-
 * blocked one costs the account.
 */
export function rulesToFacts(subreddit: string, raw: RawRules): Fact[] {
  const sub = subreddit.replace(/^\/?r\//i, "");
  const out: Fact[] = [];
  (raw.rules ?? []).forEach((r, idx) => {
    const n = idx + 1;
    const shortName = (r.short_name || r.violation_reason || "").trim();
    const description = (r.description || "").trim();
    // Joined with a full stop, not a dash: `communityRuleGuard` reads a
    // prohibition as everything up to the next sentence end, so a dash here
    // would run the heading's subject ("no vendor self-promotion") into the
    // description's first clause and dilute the phrase it looks for.
    const text = [shortName.replace(/[.\s]+$/, ""), description].filter(Boolean).join(". ");
    if (!text) return;
    const label = `r/${sub} rule ${n}${shortName ? ` — ${shortName}` : ""}`;
    const indexable = `${label} ${text}`;
    out.push({
      // Addressable and stable: the console shows it on the blocked card and
      // the number is the same one the subreddit uses.
      factId: `community:${sub}#${n}`,
      // The narrowest existing producer that is not the catalog. Nothing keys
      // off it — `policyGuard` and the retriever both additionally require a
      // `policyTopic`, which a room rule has not got — and `corpus` is the axis
      // that actually decides how this fact is treated.
      source: "policy",
      corpus: "community",
      label,
      text,
      field: "prohibited",
      tokens: terms(indexable),
      vector: ngramVector(indexable),
    });
  });
  return out;
}

/**
 * The rules of each room we watch, cached.
 *
 * A class rather than a module-level map so the suite can hold its own and the
 * cache cannot leak between tests — the bug that produces is one subreddit's
 * rules enforced against another's draft, which is worse than no rules at all.
 */
export class CommunityRules {
  private cache = new Map<string, { at: number; facts: Fact[] }>();

  constructor(
    private readonly client: RedditClient,
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = RULES_TTL_MS,
  ) {}

  async forSubreddit(subreddit: string): Promise<Fact[]> {
    const sub = subreddit.replace(/^\/?r\//i, "");
    const hit = this.cache.get(sub);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.facts;
    const raw = await this.client.get<RawRules>(`/r/${sub}/about/rules`);
    const facts = rulesToFacts(sub, raw);
    this.cache.set(sub, { at: this.now(), facts });
    return facts;
  }

  /** What is cached right now, without fetching. The draft path uses this when
   *  it must not block on a network call; an empty answer means the guard
   *  reports n/a, which is honestly "we had nothing to check against". */
  cached(subreddit: string): Fact[] {
    return this.cache.get(subreddit.replace(/^\/?r\//i, ""))?.facts ?? [];
  }

  forget(subreddit?: string): void {
    if (subreddit) this.cache.delete(subreddit.replace(/^\/?r\//i, ""));
    else this.cache.clear();
  }
}
