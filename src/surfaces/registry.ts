// Which surfaces this build knows how to watch.
//
// The registry exists for one behaviour: an operator pastes something into one
// box and the system works out what it is. Before this, "what is this link"
// was answered by `parseEventId` alone, so the answer could only ever be "an
// eBay Live show or an error" — which is why the paste box had to say eBay in
// its placeholder and why adding a second surface would have meant a second box.
//
// Resolution is first-match over registration order, and eBay Live is
// registered first on purpose: it is the reference surface and the one with the
// tightest pattern (a 16-character id, or its own URL path), so nothing else
// can steal a link that belongs to it. Seven adapters are registered, in this
// order: ebaylive · simulated · dm · reddit · whatnot · tiktoklive · twitch.
// `youtubelive` has a capabilities row and no adapter, so it is absent here.

import type { SurfaceAdapter, SurfaceId, SurfaceTarget } from "./types.js";
import { ebayLiveAdapter } from "./ebaylive/adapter.js";
import { simulatedAdapter } from "./simulated/adapter.js";
import { dmAdapter } from "./dm/adapter.js";
import { redditAdapter } from "./reddit/adapter.js";
import { whatnotAdapter } from "./whatnot/adapter.js";
import { tiktokLiveAdapter } from "./tiktoklive/adapter.js";
import { twitchAdapter } from "./twitch/adapter.js";

const adapters = new Map<SurfaceId, SurfaceAdapter>();

export function register(a: SurfaceAdapter): void {
  adapters.set(a.id, a);
}

export function get(id: SurfaceId | string): SurfaceAdapter | null {
  return adapters.get(id as SurfaceId) ?? null;
}

/** Every registered adapter, in registration order. */
export function all(): SurfaceAdapter[] {
  return [...adapters.values()];
}

/**
 * What did the operator just paste?
 *
 * Null when nothing claims it, and the caller says so in the operator's words —
 * a registry that guessed would attach the wrong surface to a mistyped link,
 * which is a far worse failure than "we do not recognise that".
 */
export function resolve(input: string): { adapter: SurfaceAdapter; target: SurfaceTarget } | null {
  const t = (input || "").trim();
  if (!t) return null;
  for (const adapter of adapters.values()) {
    const target = adapter.parseTarget(t);
    if (target) return { adapter, target };
  }
  return null;
}

// The built-ins, registered at import. Every one of them is a pure-local
// module — the scraped adapters defer their Playwright work to the watcher they
// wrap, and none of them touches a browser until `open()` — so importing the
// registry costs nothing a caller did not already pay.
//
// TikTok Live is registered even though it is off by default. An adapter that
// registered only when its switch was on would make the console's answer to
// "which surfaces exist" depend on the environment, so a surface would vanish
// from the UI rather than say why it cannot run. Capabilities resolve; `open()`
// is the thing that refuses, naming the variable (docs/SURFACES.md).
register(ebayLiveAdapter);
register(simulatedAdapter);
// The follow-up inbox parses `show:<id>` and `inbox:<handle>` — prefixes no
// other adapter looks at — and refuses `open()` with a typed error saying so,
// because an inbox built from a show that has ENDED has no feed to watch.
// Registered anyway: `resolve()` is how the console learns what a pasted
// string is, and "that is a follow-up inbox, built this other way" is a far
// better answer than "we do not recognise that".
register(dmAdapter);

// Reddit behind the exact-pattern adapters: its patterns are the widest (a bare
// `r/x` handle, every Reddit URL form), so it is the one most able to claim a
// link that belongs to somebody else. Nothing it accepts overlaps with an eBay
// event id, the scripted show or an inbox prefix, and registering it behind
// them keeps that true even if its patterns loosen later. It is not last —
// three adapters follow it, none of whose patterns it can reach.
register(redditAdapter);
register(whatnotAdapter);
register(tiktokLiveAdapter);
// Twitch is genuinely LAST, and for the same reason one rung sharper: it is the
// only adapter that accepts a bare word. `parseTarget("demo")` is a valid Twitch
// login and it is also how an operator asks for the scripted show, so every
// narrower claim has to be registered ahead of it. Like the rest it is a
// pure-local module — it opens no socket until `open()`.
//
// KNOWN DEFECT, not a design: the two `register` calls below re-register
// adapters already registered at the top of this block. `Map.set` on an existing
// key overwrites the value and leaves the insertion position alone, so the
// resolution order really is
//   ebaylive · simulated · dm · reddit · whatnot · tiktoklive · twitch
// and the duplicates change nothing. They are a merge artefact and the comment
// that arrived with them described a three-adapter registry that no longer
// exists. Left alone here because this file is documentation-only work; the
// calls should go.
register(ebayLiveAdapter);
register(simulatedAdapter);
register(twitchAdapter);
