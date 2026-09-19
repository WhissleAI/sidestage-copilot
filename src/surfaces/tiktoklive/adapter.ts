// TikTok Live, as a surface — shipped, registered, and off.
//
// `TIKTOK_LIVE_ENABLED` is unset by default and `open()` refuses while it is.
// The reason is not that the integration is unfinished; it is that this page is
// actively hostile to automation in a way the others are not. A signed-out
// fetch already ships the verification host with it, and TikTok can drop any
// session into that challenge at any moment — including one that has been
// reading a room happily for an hour. The failure mode of "retry it
// unattended" is a browser quietly grinding against a captcha, and TikTok's
// answer to a browser that does that is a restriction on the ACCOUNT, which
// here is a real seller's account and not a service credential we can rotate.
//
// So the switch is a person saying "I am here, run it". Everything else about
// the surface is live: it is registered, it resolves a pasted link, and it
// reports its capabilities, so the console can say what this surface WOULD do
// without anybody having to guess from a config file. Absence of a key is a
// first-class state on every other surface (docs/SURFACES.md); a deliberate
// off-switch reuses the same machinery, and the refusal names the variable so
// the attach route can 409 with it rather than logging a stack trace.

import { ScrapedPageWatcher } from "../scrapeWatcher.js";
import {
  SCRAPED_LIVE_CAPABILITIES, SurfaceUnavailable,
  type SurfaceAdapter, type SurfaceConnection, type SurfaceEvents, type SurfaceTarget,
} from "../types.js";
import { tiktokLiveSpec } from "./scrape.js";

/** A TikTok username. */
const HANDLE = /^[A-Za-z0-9._]{2,24}$/;

/** Read at `open()`, never cached. The operator turns this on in front of the
 *  process and expects the next attach to obey — a value captured at import
 *  would need a restart to mean anything.
 *
 *  The environment is a parameter so the surface table can ask the same
 *  question of the same spelling without a second copy of this predicate
 *  (src/surfaces/readiness.ts); it defaults to the process, which is what
 *  every caller before it passed implicitly. */
export function tiktokLiveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test((env.TIKTOK_LIVE_ENABLED || "").trim());
}

/**
 * `tiktok.com/@handle/live`, and `tiktok.com/@handle` for the same host.
 *
 * A bare `@handle` is refused for the reason the Whatnot adapter refuses it:
 * the name exists on both platforms and the registry resolves by first match,
 * so accepting it would let registration order decide which platform a seller's
 * copilot attached to.
 *
 * A link to a VIDEO (`/@handle/video/123`) is refused too. It is a real TikTok
 * URL for a real thing that is not a live room, and resolving it to the host's
 * current stream would silently attach to something the operator did not name.
 */
function parseTikTok(input: string): SurfaceTarget | null {
  const t = (input || "").trim();

  const prefixed = t.match(/^tiktok(?:live)?:@?([A-Za-z0-9._]{2,24})$/i);
  if (prefixed) return { externalId: prefixed[1]!, handle: `@${prefixed[1]}` };

  const url = t.replace(/^https?:\/\//i, "").replace(/^(www|m|vm)\./i, "");
  if (!/^tiktok\.com\//i.test(url)) return null;
  const path = url.slice("tiktok.com/".length).split(/[?#]/)[0]!.replace(/\/+$/, "");
  const seg = path.split("/");
  if (!seg[0]?.startsWith("@")) return null;
  const handle = seg[0].slice(1);
  if (!HANDLE.test(handle)) return null;
  if (seg[1] && seg[1].toLowerCase() !== "live") return null;
  return { externalId: handle, handle: `@${handle}` };
}

export const tiktokLiveAdapter: SurfaceAdapter = {
  id: "tiktoklive",
  label: "TikTok Live",
  capabilities: SCRAPED_LIVE_CAPABILITIES,
  parseTarget: parseTikTok,

  async open(t: SurfaceTarget, ev: SurfaceEvents): Promise<SurfaceConnection> {
    if (!tiktokLiveEnabled()) {
      throw new SurfaceUnavailable(
        "tiktoklive",
        "tiktoklive: TIKTOK_LIVE_ENABLED is not set — TikTok challenges automated browsers, " +
          "and a session that grinds against that challenge unattended costs the seller's own account",
        "TIKTOK_LIVE_ENABLED",
      );
    }
    const watcher = new ScrapedPageWatcher(tiktokLiveSpec, t, ev);
    await watcher.start();
    return { stop: () => watcher.stop() };
  },
};
