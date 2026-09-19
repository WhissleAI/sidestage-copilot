// Reddit, as a surface: monitor, ground, draft. Never post.
//
// Reddit is **monitor-and-draft. Posting is off in code, not in
// configuration.** Undisclosed automation replying as a person breaks Reddit's
// own rules and is reputationally fatal; the value is a grounded draft with its
// sources, which a human sends from their own account.
//
// That sentence is the product decision, and the code says it three times so
// that no single edit can quietly undo it: `delivery` is the constant
// `DELIVERY` below, the action list does not contain `post_reply` at all, and
// preflight refuses any action a surface does not declare. A setting cannot
// reach any of the three.
//
// What the adapter does instead is the part that is actually hard: work out
// what a pasted link is, watch the right thing, carry Reddit's own ids through
// so the thread engine can rebuild the branch above a comment, and pull the
// subreddit's rules in as constraints on whatever gets drafted.

import { capabilitiesOf, type SurfaceAdapter, type SurfaceCapabilities, type SurfaceConnection, type SurfaceEvents, type SurfaceTarget } from "../types.js";
import { RedditClient, requireCreds } from "./api.js";
import { RedditPoller, type RedditWatch } from "./poll.js";
import { CommunityRules } from "./rules.js";

/**
 * Not a field on a config object, not a column, not an environment variable: a
 * constant in the module that talks to Reddit. The only way to turn posting on
 * here is to edit this line, in a diff, with a reviewer.
 */
const DELIVERY = "draft-only" as const;

/**
 * Reddit post ids are base36 and have been five characters or more since 2006.
 * A shorter segment after `/comments/` is a truncated or invented link, and a
 * truncated thread link must not silently degrade into "watch the whole
 * subreddit" — that is how a copilot ends up reading a room nobody pointed it
 * at.
 */
const POST_ID = /^[a-z0-9]{4,13}$/i;
const NAME = /^[A-Za-z0-9_-]{2,21}$/;

function fromPath(pathname: string): SurfaceTarget | null {
  const seg = pathname.split("/").map((s) => s.trim()).filter(Boolean);
  const i = seg.findIndex((s) => /^(r|u|user)$/i.test(s));
  if (i === -1) return null;
  const kind = seg[i]!.toLowerCase();
  const name = seg[i + 1];
  if (!name || !NAME.test(name)) return null;

  if (kind === "r") {
    const c = seg.indexOf("comments", i);
    if (c !== -1) {
      const id = seg[c + 1];
      if (!id || !POST_ID.test(id)) return null;
      // `/r/<sub>/comments/<id>/<slug>/<commentId>` — the last segment is the
      // comment someone actually linked to, and it is the message a draft
      // would answer. Keeping it is what makes "reply to this comment"
      // different from "reply to this thread".
      const focus = seg.length > c + 3 && POST_ID.test(seg[c + 3]!) ? seg[c + 3]! : undefined;
      return threadTarget(id, name, focus);
    }
    return subredditTarget(name);
  }
  return userTarget(name);
}

const subredditTarget = (sub: string): SurfaceTarget => ({
  externalId: `r/${sub}`,
  handle: `r/${sub}`,
  meta: { kind: "subreddit", subreddit: sub },
});

const userTarget = (username: string): SurfaceTarget => ({
  externalId: `u/${username}`,
  handle: `u/${username}`,
  meta: { kind: "user", username },
});

const threadTarget = (id: string, subreddit?: string, focusCommentId?: string): SurfaceTarget => ({
  // The fullname, because that is the id `parent_id` and `link_id` point at
  // and the id the thread engine walks. Storing the short form would mean
  // translating at every boundary and getting it wrong at one of them.
  externalId: `t3_${id}`,
  handle: subreddit ? `r/${subreddit}` : undefined,
  meta: {
    kind: "thread",
    threadId: `t3_${id}`,
    ...(subreddit ? { subreddit } : {}),
    ...(focusCommentId ? { focusCommentId: `t1_${focusCommentId}` } : {}),
  },
});

/** The watch a target describes, in the poller's vocabulary. */
export function watchFor(t: SurfaceTarget): RedditWatch {
  const m = t.meta ?? {};
  if (m.kind === "user") return { kind: "user", username: m.username! };
  if (m.kind === "thread") return { kind: "thread", threadId: m.threadId!, subreddit: m.subreddit };
  return { kind: "subreddit", subreddit: m.subreddit ?? t.externalId.replace(/^\/?r\//i, "") };
}

export const redditAdapter: SurfaceAdapter = {
  id: "reddit",
  label: "Reddit",

  // The static table is what guards and preflight actually read — sometimes
  // before this module has been imported at all — so the adapter takes its
  // capabilities from there rather than declaring a second opinion. `delivery`
  // is the one field restated from the constant above: if the table were ever
  // edited to say `api`, the adapter would still say draft-only, and the test
  // that asserts the two agree would fail loudly rather than the product rule
  // changing quietly.
  capabilities: { ...capabilitiesOf("reddit"), delivery: DELIVERY },

  /**
   * A subreddit, a user, or a thread — as a bare handle, a slashed handle, or
   * any of Reddit's URL forms (www, old, np, the `redd.it` shortener).
   *
   * Null for anything else, including a `/comments/` link whose id is not an
   * id. A registry that guessed would attach the wrong room to a mistyped link,
   * and on this surface the wrong room is the whole failure mode.
   */
  parseTarget(input: string): SurfaceTarget | null {
    const raw = (input || "").trim();
    if (!raw) return null;

    // A fullname pasted straight out of the API or a moderator log.
    const full = raw.match(/^t3_([a-z0-9]{4,13})$/i);
    if (full) return threadTarget(full[1]!);

    if (/^https?:\/\//i.test(raw) || /^(?:www\.|old\.|np\.|new\.)?reddit\.com\//i.test(raw) || /^redd\.it\//i.test(raw)) {
      let url: URL;
      try {
        url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      } catch {
        return null;
      }
      const host = url.hostname.toLowerCase();
      if (host === "redd.it") {
        const id = url.pathname.replace(/\//g, "");
        return POST_ID.test(id) ? threadTarget(id) : null;
      }
      // Only Reddit's own hosts. `reddit.com.example.com` is not Reddit, and a
      // suffix match is how that becomes a request we sign with a real token.
      if (host !== "reddit.com" && !host.endsWith(".reddit.com")) return null;
      return fromPath(url.pathname);
    }

    // Bare handles, with or without a leading slash: r/mechmarket, /u/someone,
    // /user/someone. Not a bare word — "mechmarket" on its own is as likely to
    // be a typo as a subreddit, and this box is shared with every other surface.
    const handle = raw.match(/^\/?(r|u|user)\/([A-Za-z0-9_-]{2,21})\/?$/i);
    if (handle) {
      return handle[1]!.toLowerCase() === "r" ? subredditTarget(handle[2]!) : userTarget(handle[2]!);
    }
    return null;
  },

  async open(t: SurfaceTarget, ev: SurfaceEvents): Promise<SurfaceConnection> {
    // Before anything is scheduled: five values, and the refusal names the
    // first one missing so the attach route can 409 with something actionable.
    requireCreds();
    const client = redditClient();

    // The room's rules, fetched at attach rather than at draft time. They are
    // the constraints every draft in this room is checked against, they change
    // a few times a year, and a draft path that had to fetch them would either
    // block on a network call or compose without them — and composing without
    // them is the failure this surface exists to avoid.
    const subreddit = t.meta?.subreddit;
    if (subreddit) {
      rules().forSubreddit(subreddit).then(
        (facts) => ev.onStatus?.({ connected: true, detail: `r/${subreddit}: ${facts.length} rules in force` }),
        // A room whose rules we could not read is still a room worth watching.
        // The guard reports n/a, which is honestly "we had nothing to check
        // against" rather than "we checked and found nothing wrong".
        (e: Error) => ev.onStatus?.({ connected: true, detail: `r/${subreddit}: rules unavailable — ${e.message}` }),
      );
    }

    const poller = new RedditPoller({ client, watch: watchFor(t), events: ev });
    await poller.start();
    return poller;
  },
};

/**
 * ONE Reddit client for this process, and therefore one rate-limit budget.
 *
 * Reddit meters per account, not per caller. A poller watching a subreddit, the
 * rules fetch behind it and Discover searching for an operator's interests all
 * spend from the same 600-requests-per-10-minutes window — so a second client
 * is not a second budget, it is the same budget with two halves that cannot see
 * each other, each convinced it has the whole thing. `RedditClient` reads
 * `x-ratelimit-*` off every response and paces BEFORE the request that would
 * spend the last of it (api.ts); that pacing only works if everything goes
 * through the same instance.
 *
 * Built lazily so importing the adapter — which the registry does at startup —
 * does not construct a client against credentials that may not be there.
 */
let shared: RedditClient | null = null;
export function redditClient(): RedditClient {
  shared ??= new RedditClient();
  return shared;
}

// One cache for the process, because the rules of a room are a property of the
// room and not of whoever happens to be watching it.
let sharedRules: CommunityRules | null = null;

/** Where the draft path asks what is in force in a room. */
export function rules(): CommunityRules {
  sharedRules ??= new CommunityRules(redditClient());
  return sharedRules;
}

/** Exported for the test that proves the product rule, and for anything that
 *  wants to assert on it rather than trust a comment. */
export const REDDIT_DELIVERY: SurfaceCapabilities["delivery"] = DELIVERY;
