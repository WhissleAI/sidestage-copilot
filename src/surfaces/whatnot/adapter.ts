// Whatnot, as a surface.
//
// The same shape as the eBay adapter: parse what the operator pasted, open the
// page, rename the page's vocabulary to the one every surface answers to. The
// difference is that eBay Live's reader already existed and this one did not,
// so the reading lives next door in `scrape.ts` (the selectors) and in
// `../scrapeWatcher.ts` (the loop, shared with TikTok Live).

import { ScrapedPageWatcher } from "../scrapeWatcher.js";
import {
  SCRAPED_LIVE_CAPABILITIES,
  type SurfaceAdapter, type SurfaceConnection, type SurfaceEvents, type SurfaceTarget,
} from "../types.js";
import { whatnotSpec } from "./scrape.js";

/** A Whatnot live room id, as it appears in `/live/<id>`. Long and hyphenated
 *  (the app issues UUIDs), matched loosely on purpose — the id is opaque to us
 *  and pinning its exact shape would reject the next generation of it. */
const ROOM = /^[A-Za-z0-9][A-Za-z0-9_-]{5,63}$/;
/** A Whatnot username. */
const HANDLE = /^[A-Za-z0-9._-]{3,30}$/;

/**
 * What did the operator paste?
 *
 * Three accepted forms, and one deliberate refusal.
 *
 * The refusal is a BARE `@handle`. It is not a link, it is a name, and the same
 * name exists on Whatnot and on TikTok — so the registry, which resolves by
 * first match over registration order, would hand `@kicksbyrae` to whichever
 * adapter happens to be registered first. That is a coin toss deciding which
 * stranger's room a seller's copilot attaches to. A handle is accepted when
 * something in the string says which platform it belongs to, and refused when
 * nothing does.
 */
function parseWhatnot(input: string): SurfaceTarget | null {
  const t = (input || "").trim();

  // `whatnot:<id>` / `whatnot:@handle` — how an operator says "this name, on
  // Whatnot", and how the console will address a room it already knows.
  const prefixed = t.match(/^whatnot:@?([A-Za-z0-9._-]{3,64})$/i);
  if (prefixed) {
    const v = prefixed[1]!;
    return t.includes("@")
      ? { externalId: v, handle: `@${v}`, meta: { kind: "handle" } }
      : { externalId: v, meta: { kind: "room" } };
  }

  const url = t.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  if (!/^whatnot\.com\//i.test(url)) return null;
  const path = url.slice("whatnot.com/".length).split(/[?#]/)[0]!.replace(/\/+$/, "");
  const seg = path.split("/");

  // whatnot.com/live/<id>
  if (seg[0]?.toLowerCase() === "live" && seg[1] && ROOM.test(seg[1])) {
    return { externalId: seg[1], meta: { kind: "room" } };
  }
  // whatnot.com/user/<handle>[/live] — a seller's own page. Addressing the
  // HOST rather than the room is the form a seller reaches for, because their
  // room id changes every show and their profile URL never does.
  if (seg[0]?.toLowerCase() === "user" && seg[1] && HANDLE.test(seg[1]) && (!seg[2] || seg[2] === "live")) {
    return { externalId: seg[1], handle: `@${seg[1]}`, meta: { kind: "handle" } };
  }
  // whatnot.com/@handle
  if (seg.length === 1 && seg[0]?.startsWith("@") && HANDLE.test(seg[0].slice(1))) {
    const h = seg[0].slice(1);
    return { externalId: h, handle: `@${h}`, meta: { kind: "handle" } };
  }
  return null;
}

export const whatnotAdapter: SurfaceAdapter = {
  id: "whatnot",
  label: "Whatnot",
  capabilities: SCRAPED_LIVE_CAPABILITIES,
  parseTarget: parseWhatnot,

  async open(t: SurfaceTarget, ev: SurfaceEvents): Promise<SurfaceConnection> {
    const watcher = new ScrapedPageWatcher(whatnotSpec, t, ev);
    await watcher.start();
    return { stop: () => watcher.stop() };
  },
};
