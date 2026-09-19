// What each surface still needs before it can answer for this operator.
//
// The home page used to carry a four-step checklist — eBay connected, catalog
// loaded, signed in to eBay Live, a show prepared — written when a session
// could only be one thing. Seven surfaces later that checklist is one surface's
// Before phase wearing the product's clothes: Twitch's Before is an application
// key and a consent, Reddit's is a script app and a list of subreddits, and the
// scraped rooms need nothing at all. A single list cannot say that, and a list
// that tries says the wrong thing about six surfaces out of seven.
//
// So the phase is per-surface, and this module computes it. Three properties
// are load-bearing:
//
//   1. **Pure.** Facts in, rows out. Every database read, every environment
//      read and every registry read happens in the caller, which is what lets
//      the whole table be tested without a Postgres, a browser or a key.
//   2. **Per account, never cached.** `connected` is a fact about one operator's
//      sealed OAuth connections; a process-wide memo of it would hand the
//      second seller the first seller's answer.
//   3. **Named the way the refusal names it.** `missing` carries the exact
//      environment variable `SurfaceUnavailable` puts in its message, because
//      an operator who reads "TWITCH_CLIENT_ID" here and "the twitch key" in a
//      409 has to work out that they are the same thing. The spellings come
//      from `missingTwitchKey` and `missingCredential` themselves rather than
//      from a second list that can drift.

import { capabilitiesOf, type SurfaceCapabilities, type SurfaceId, type Tempo } from "./types.js";
import { missingTwitchKey } from "./twitch/api.js";
import { missingCredential as missingRedditCredential } from "./reddit/api.js";
import { tiktokLiveEnabled } from "./tiktoklive/adapter.js";

/** One step in a surface's Before phase, with the operator's own state in it. */
export interface SurfaceStep {
  label: string;
  done: boolean;
  /** Where the step is done, when there is somewhere. A frontend route. */
  href?: string;
  /** What the button says. Only on steps that are not done. */
  cta?: string;
}

/** One row of the surface table: a phase story for one surface. */
export interface SurfaceReadiness {
  id: SurfaceId;
  label: string;
  /** Wired, with something to open. The follow-up inbox is wired and has not. */
  attachable: boolean;
  tempo: Tempo;
  delivery: SurfaceCapabilities["delivery"];
  /** Has whatever this surface needs to run at all, for THIS account. */
  connected: boolean;
  /** The environment variable or the consent that is missing, named. */
  missing: string | null;
  before: SurfaceStep[];
  during: string;
  after: string;
  /** Rooms this account watches here. Async surfaces always carry it, because
   *  a surface with no session has nothing else to count. */
  rooms?: number;
}

/**
 * Everything the readiness of a surface depends on, gathered by the caller.
 *
 * `env` is passed rather than read here so the value is whatever the process
 * holds AT REQUEST TIME: an operator who exports a key and restarts expects the
 * next read to see it, and a module-level capture would need a deploy to mean
 * anything.
 */
export interface ReadinessFacts {
  /** The surfaces to describe: id, label and attachability from the registry. */
  surfaces: { id: SurfaceId; label: string; attachable: boolean }[];
  env: NodeJS.ProcessEnv;
  /** A sealed eBay OAuth connection exists for this account. */
  ebayConnected: boolean;
  /** The eBay Live browser session is present, fresh, and not being served the
   *  anonymous grid — what Discover and Prepare actually need. */
  ebaySignedIn: boolean;
  /** This account has consented a Twitch account. */
  twitchConnected: boolean;
  /** Catalogs this account owns — imports and preparations, not the seeds. */
  ownCatalogs: number;
  /** Items across those catalogs: what a reply on a commerce surface can cite. */
  ownCatalogItems: number;
  /** Shows prepared and waiting to be monitored. */
  prepared: number;
  /** Sessions on air right now, per surface. */
  liveBySurface: Partial<Record<SurfaceId, number>>;
  /** Rooms this account has added, per surface. */
  roomsBySurface: Partial<Record<SurfaceId, number>>;
  /** Follow-ups this account has built, in any state. */
  followups: number;
}

/**
 * The credential variables are read as ABSENT under test.
 *
 * `config.ts` does the same thing and for the same reason: `.env` is loaded
 * into the process, so a suite that read the ambient keys would give a
 * developer with a working Twitch application a different answer from CI. A
 * test that wants a connected surface passes its own `env` object — which has
 * no NODE_ENV in it — and gets read normally.
 */
const blanked = (env: NodeJS.ProcessEnv, name: string): string =>
  env.NODE_ENV === "test" ? "" : env[name] ?? "";

/**
 * What the surface can do with a reply once it has written one.
 *
 * Read off the declared capabilities rather than hard-coded per surface: a
 * surface that loses `delivery: "api"` must stop claiming it can send, in the
 * same edit, without anybody remembering this file.
 */
export function duringPhrase(caps: SurfaceCapabilities): string {
  if (caps.delivery === "draft-only") {
    // An async surface is a queue of drafts and nothing else. A live one that
    // cannot deliver is still answering in the moment — the operator is the
    // one who presses send, in their own browser, while the room is open.
    return caps.tempo === "async" ? "drafts only" : "answers, you send";
  }
  // Delivery is ours. Whether it also ACTS is the question of whether it has
  // an action that changes something outside the conversation — a price, a
  // clip, a poll, a pin. `flag_for_human` and `post_reply` are the two that
  // never leave it.
  const acts = caps.actions.some((a) => a !== "post_reply" && a !== "flag_for_human");
  return acts ? "answers and acts" : "answers, you send";
}

/**
 * What the surface leaves behind when the phase ends.
 *
 * An async surface was described here as leaving a "weekly digest", which is
 * the thing we would like it to leave and not the thing it leaves. No digest
 * is built. What actually survives a Reddit watch or a follow-up inbox is the
 * queue's own memory of what you sent and what you skipped, which is real and
 * readable (`GET /api/drafts?status=sent`). Say that instead: a phase table
 * whose last column promises an unbuilt feature is the same lie as a landing
 * page doing it, just in smaller type.
 */
export const afterPhrase = (caps: SurfaceCapabilities): string =>
  caps.tempo === "live" ? "report and follow-ups" : "a record of what you sent";

/**
 * The order an operator should meet the surfaces in: the reference surface
 * first, then the other live rooms, then the asynchronous ones, and the
 * scripted show last because it is the thing you try, not the thing you run.
 * Anything unlisted keeps the caller's order, after these.
 */
const DISPLAY_ORDER: SurfaceId[] = [
  "ebaylive", "whatnot", "tiktoklive", "twitch", "youtubelive", "reddit", "dm", "simulated",
];

/** One row, for one surface, for one account. */
function rowFor(
  s: { id: SurfaceId; label: string; attachable: boolean },
  f: ReadinessFacts,
): SurfaceReadiness {
  const caps = capabilitiesOf(s.id);
  const live = f.liveBySurface[s.id] ?? 0;
  const rooms = f.roomsBySurface[s.id] ?? 0;
  const base = {
    id: s.id,
    label: s.label,
    attachable: s.attachable,
    tempo: caps.tempo,
    delivery: caps.delivery,
    during: duringPhrase(caps),
    after: afterPhrase(caps),
    // Async surfaces always report their rooms — with no session to count,
    // "how many rooms are watched" is the only measure of how much is on.
    ...(caps.tempo === "async" || rooms ? { rooms } : {}),
  };

  const groundTruth = (label: string): SurfaceStep => ({
    label,
    done: f.ownCatalogItems > 0,
    ...(f.ownCatalogItems > 0
      ? {}
      : { href: "/settings", cta: "Import listings" }),
  });

  switch (s.id) {
    case "ebaylive": {
      return {
        ...base,
        connected: f.ebayConnected,
        missing: f.ebayConnected ? null : "a connected eBay account",
        before: [
          {
            label: "Connect your eBay account",
            done: f.ebayConnected,
            ...(f.ebayConnected ? {} : { href: "/settings", cta: "Connect" }),
          },
          groundTruth("Load your listings"),
          {
            label: "Sign in to eBay Live",
            done: f.ebaySignedIn,
            ...(f.ebaySignedIn ? {} : { href: "/", cta: "How to sign in" }),
          },
          {
            label: live ? "A show is on air" : "Prepare your next show",
            done: live > 0 || f.prepared > 0,
            ...(live > 0 || f.prepared > 0 ? {} : { href: "/", cta: "Discover shows" }),
          },
        ],
      };
    }

    case "twitch": {
      // The refresh token is not part of THIS question: consent mints a
      // per-account one, which is what `twitch_accounts` holds. Passing a
      // placeholder keeps the answer to the two variables that matter while
      // still spelling them exactly as the refusal does.
      const missingKey = missingTwitchKey({
        clientId: blanked(f.env, "TWITCH_CLIENT_ID"),
        clientSecret: blanked(f.env, "TWITCH_CLIENT_SECRET"),
        botRefreshToken: "granted-by-consent",
      });
      const keyed = !missingKey;
      return {
        ...base,
        connected: keyed && f.twitchConnected,
        missing: missingKey ?? (f.twitchConnected ? null : "a connected Twitch account"),
        before: [
          {
            label: "Register a Twitch application",
            done: keyed,
            ...(keyed ? {} : { cta: `Set ${missingKey}` }),
          },
          {
            label: "Connect the account that speaks in chat",
            done: f.twitchConnected,
            ...(f.twitchConnected ? {} : { href: "/settings", cta: "Connect" }),
          },
          {
            label: "Load the channel's schedule and sponsor briefs",
            done: f.ownCatalogs > 0,
            ...(f.ownCatalogs > 0 ? {} : { href: "/catalog", cta: "Open knowledge" }),
          },
          {
            label: live ? "A channel is on air" : "Attach a channel",
            done: live > 0,
            ...(live > 0 ? {} : { href: "/", cta: "Attach" }),
          },
        ],
      };
    }

    case "reddit": {
      const missingCred = missingRedditCredential({
        clientId: blanked(f.env, "REDDIT_CLIENT_ID"),
        clientSecret: blanked(f.env, "REDDIT_CLIENT_SECRET"),
        username: blanked(f.env, "REDDIT_USERNAME"),
        password: blanked(f.env, "REDDIT_PASSWORD"),
        // The one variable that is not a secret, and the one Reddit blocks on.
        userAgent: f.env.REDDIT_USER_AGENT ?? "",
      });
      const credentialed = !missingCred;
      return {
        ...base,
        connected: credentialed,
        missing: missingCred,
        before: [
          {
            label: "Add the Reddit script application",
            done: credentialed,
            ...(credentialed ? {} : { cta: `Set ${missingCred}` }),
          },
          {
            label: "Choose the subreddits to watch",
            done: rooms > 0,
            ...(rooms > 0 ? {} : { href: "/rooms", cta: "Choose rooms" }),
          },
          {
            // Not a file anybody uploads: a room's rules are fetched from
            // Reddit when the room is attached, and they are the constraints
            // every draft there is checked against.
            label: "Each room's rules load when you attach it",
            done: credentialed && rooms > 0,
          },
          {
            // Said here as well as in `during`, because this is the step where
            // an operator decides whether to bother — and the answer to "will
            // it post for me" is no, in code, permanently.
            label: "Nothing is ever posted for you — every reply is a draft you send",
            done: true,
            href: "/drafts",
          },
        ],
      };
    }

    case "whatnot": {
      return {
        ...base,
        // Read through a browser. There is no key, no consent and no account:
        // a surface that needs nothing is connected the moment it exists, and
        // saying otherwise would put a red mark against a working surface.
        connected: true,
        missing: null,
        before: [
          { label: "Nothing to connect — the room is read in a browser", done: true },
          groundTruth("Load the ground truth: your listings and policies"),
          {
            label: live ? "A room is open" : "Attach a room",
            done: live > 0,
            ...(live > 0 ? {} : { href: "/", cta: "Attach" }),
          },
        ],
      };
    }

    case "tiktoklive": {
      // The one scraped surface with a switch, and it is a switch on purpose:
      // TikTok answers an unattended browser grinding against its challenge
      // with a restriction on the SELLER's account. `open()` refuses while it
      // is off and names this variable; so does this row.
      const enabled = tiktokLiveEnabled(f.env);
      return {
        ...base,
        connected: enabled,
        missing: enabled ? null : "TIKTOK_LIVE_ENABLED",
        before: [
          {
            label: "Turn TikTok Live on in the server settings",
            done: enabled,
            ...(enabled ? {} : { cta: "Set TIKTOK_LIVE_ENABLED" }),
          },
          groundTruth("Load the ground truth: your listings and policies"),
          {
            label: live ? "A room is open" : "Attach a room",
            done: live > 0,
            ...(live > 0 ? {} : { href: "/", cta: "Attach" }),
          },
        ],
      };
    }

    case "dm": {
      return {
        ...base,
        // The inbox is built out of shows that already ran. There is nothing
        // to connect and nothing that can be missing.
        connected: true,
        missing: null,
        before: [
          { label: "Nothing to connect — it is built from sessions you already ran", done: true },
          {
            label: "Finish a session, then build its follow-ups",
            done: f.followups > 0,
            ...(f.followups > 0 ? {} : { href: "/reports", cta: "Open reports" }),
          },
        ],
      };
    }

    case "simulated": {
      return {
        ...base,
        connected: true,
        missing: null,
        before: [
          { label: "Nothing to connect — the scripted show runs here", done: true },
          {
            label: live ? "The scripted show is running" : 'Attach it by pasting "demo"',
            done: live > 0,
            ...(live > 0 ? {} : { href: "/", cta: "Try it" }),
          },
        ],
      };
    }

    default: {
      // A surface with a capability row and no branch here. It exists, we know
      // what it can do, and we have nothing true to say about its setup —
      // which is exactly what an empty Before list says.
      return { ...base, connected: false, missing: null, before: [] };
    }
  }
}

/**
 * The surface table, for one account.
 *
 * Built from the surfaces the caller passes — which is the ADAPTER REGISTRY,
 * not the capability table. `youtubelive` has a capability row and no adapter
 * in this build; offering it as a row an operator could act on would be the
 * interface telling a lie the attach route then refuses.
 */
export function surfaceReadiness(f: ReadinessFacts): SurfaceReadiness[] {
  const rows = f.surfaces.map((s) => rowFor(s, f));
  return rows.sort((a, b) => {
    const rank = (id: SurfaceId) => {
      const i = DISPLAY_ORDER.indexOf(id);
      return i === -1 ? DISPLAY_ORDER.length : i;
    };
    return rank(a.id) - rank(b.id);
  });
}
