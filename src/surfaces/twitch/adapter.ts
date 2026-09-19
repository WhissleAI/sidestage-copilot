// Twitch, as a surface.
//
// The first surface that is not a shop. Everything the copilot knew how to do
// was built around a catalog — a price to be stale, a quantity to run out, a
// lot to pin — and a Twitch channel has none of those. What it has instead is a
// person talking for four hours, a chat asking the same eight questions, a
// sponsor who wrote down what may and may not be said about their product, and
// a schedule the chat keeps asking about.
//
// So the mapping is: chat in (`chat.ts`), clips and polls and announcements out
// (`actions.ts`), and the things that ground an answer here are a schedule, a
// sponsor brief and the channel's own rules (`corpus.ts`) rather than a catalog
// row. The guards that reason about listings return n/a on their own, because
// this surface declares no `listing` corpus — see src/guardrails/guards.ts.
//
// What does NOT change: the reply path, the executor, preflight, the audit
// chain, the undo window. A Twitch action is proposed, preflighted, approved,
// committed and rolled back by exactly the code an eBay markdown goes through.

import { config } from "../../config.js";
import {
  capabilitiesOf,
  type SurfaceAdapter, type SurfaceConnection, type SurfaceEvents, type SurfaceTarget,
} from "../types.js";
import { TwitchApi, requireTwitchCreds } from "./api.js";
import { TwitchChat } from "./chat.js";

/**
 * Twitch logins: 4–25 characters, letters, digits and underscore.
 *
 * The bare-name form is the reason this is written out rather than "anything
 * without a space". `parseTarget` is tried by the registry against every paste
 * an operator makes, so a pattern any wider swallows links that belong to
 * another surface and hands the operator a channel that does not exist. The
 * registry tries Twitch LAST for the same reason (src/surfaces/registry.ts).
 */
const LOGIN = /^[a-zA-Z0-9_]{4,25}$/;

export const twitchAdapter: SurfaceAdapter = {
  id: "twitch",
  label: "Twitch",
  capabilities: capabilitiesOf("twitch"),

  /**
   * A link, an @handle, or the channel name on its own.
   *
   * All three are things operators actually type. The link is what a browser
   * gives them; `@name` is how the channel is written everywhere on Twitch
   * itself; the bare name is what somebody says out loud.
   */
  parseTarget(input: string): SurfaceTarget | null {
    const raw = (input || "").trim();
    if (!raw) return null;

    // A link, with or without a scheme, with or without www, with or without
    // the trailing path Twitch appends for a VOD or a clip — the channel is
    // always the first path segment.
    const url = /^(?:https?:\/\/)?(?:www\.|m\.)?twitch\.tv\/([^/?#\s]+)/i.exec(raw);
    if (url) {
      const login = url[1]!.toLowerCase();
      // twitch.tv/videos/12345 and twitch.tv/directory/… are Twitch links that
      // are not channels. Claiming them would attach a session to a channel
      // named "videos".
      if (!LOGIN.test(login) || RESERVED.has(login)) return null;
      return { externalId: login, handle: `@${login}`, meta: { url: `https://twitch.tv/${login}` } };
    }
    if (raw.includes("/") || /\s/.test(raw)) return null;

    const bare = raw.replace(/^@/, "").toLowerCase();
    if (!LOGIN.test(bare) || RESERVED.has(bare)) return null;
    return { externalId: bare, handle: `@${bare}`, meta: { url: `https://twitch.tv/${bare}` } };
  },

  /**
   * Start reading the channel's chat.
   *
   * The credential check is first and throws `SurfaceUnavailable` naming the
   * one variable that would fix it. That is the whole of what "absence is a
   * first-class state" buys: the adapter still registered, `/api/surfaces`
   * still reports what Twitch can do, and the attach route answers 409 with
   * the variable's name instead of a 500 that sends somebody to the logs.
   */
  async open(t: SurfaceTarget, ev: SurfaceEvents): Promise<SurfaceConnection> {
    const creds = requireTwitchCreds(config.twitch);
    const api = new TwitchApi(creds);
    const chat = new TwitchChat({ api, channel: t.externalId, events: ev });
    await chat.start();
    return { stop: () => chat.stop() };
  },
};

/** First path segments on twitch.tv that are pages, not channels. */
const RESERVED = new Set([
  "videos", "directory", "settings", "downloads", "jobs", "turbo", "subscriptions",
  "friends", "inventory", "wallet", "drops", "prime", "store", "search", "following",
]);
