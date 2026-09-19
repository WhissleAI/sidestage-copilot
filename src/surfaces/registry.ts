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
// can steal a link that belongs to it.

import type { SurfaceAdapter, SurfaceId, SurfaceTarget } from "./types.js";
import { ebayLiveAdapter } from "./ebaylive/adapter.js";
import { simulatedAdapter } from "./simulated/adapter.js";
import { dmAdapter } from "./dm/adapter.js";

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

// The built-ins, registered at import. Both are pure-local modules — the eBay
// adapter defers its Playwright work to the watcher it wraps — so importing the
// registry costs nothing a caller did not already pay.
register(ebayLiveAdapter);
register(simulatedAdapter);
// The follow-up inbox parses `show:<id>` and `inbox:<handle>` — prefixes no
// other adapter looks at — and refuses `open()` with a typed error saying so,
// because an inbox built from a show that has ENDED has no feed to watch.
// Registered anyway: `resolve()` is how the console learns what a pasted
// string is, and "that is a follow-up inbox, built this other way" is a far
// better answer than "we do not recognise that".
register(dmAdapter);
