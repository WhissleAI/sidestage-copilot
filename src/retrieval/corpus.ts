// What KIND of ground truth a fact came from.
//
// The catalog was the only corpus for as long as the only surface was a live
// selling show, so "grounded" and "in the catalog" were the same sentence. They
// stop being the same sentence the moment a reply is drafted for a Twitch chat
// or a subreddit, where there is no catalog at all and the things that ground a
// claim are a schedule, a changelog, a sponsor's approved copy — or a rule the
// room imposes, which grounds nothing and CONSTRAINS everything.
//
// Naming the kind is what lets a guard ask a question it could not ask before:
// "is a listing price even a thing on this surface?" A price guard that fires on
// a Twitch reply quoting "$60" is not catching a stale listing, it is inventing
// a listing to be stale.

export type CorpusKind =
  | "listing"     // what is for sale (today's catalog)
  | "policy"      // the operator's own rules: shipping, returns, refunds
  | "schedule"    // what is on, when — a creator's calendar, a drop lineup
  | "sponsor"     // obligations and claims a sponsored segment MUST and MUST NOT make
  | "product"     // docs, changelog, pricing, known issues (async surfaces)
  | "community"   // the RULES OF THE ROOM: a subreddit's rules, a channel's chat rules
  | "qa";         // prior answered questions

/**
 * Every fact this codebase produced before surfaces existed came out of the
 * catalog or the seller's own policy corpus, both of which a live-commerce
 * surface declares. Defaulting to `listing` keeps every one of those facts
 * exactly as guard-checkable as it was.
 */
export const DEFAULT_CORPUS: CorpusKind = "listing";
