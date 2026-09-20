// Every outbound request has a deadline, or it is not a dependency — it is a
// hang.
//
// Node's `fetch` has NO default request timeout. Undici's headers and body
// timeouts are 300 seconds, so a hung upstream holds a Fastify connection for
// five minutes; a browser `fetch` has no ceiling at all, so the console's
// spinner never stops. Three of the five upstreams — eBay, Twitch, Reddit —
// had no `AbortSignal` anywhere, and neither did the gateway's own admin paths
// (`streamAgent`, on the ATTACH path), `kbSync`, `settings/store` (the
// guardrail push, on the settings-save request path), `shows/readiness` or
// `prepareEvent`.
//
// The behaviours each client needs already existed in this codebase — Reddit
// paces and serialises properly, the eBay client classifies fatal from
// retryable, the Whissle chat path times out and meters — they just existed
// five times and disagreed, and the omissions were invisible because each
// client is only ever read on its own. This file is the one place they agree.
//
// Shaped as `typeof fetch` on purpose: every client in this repo already takes
// an injectable `Fetcher`, so making a client honest is changing its DEFAULT
// rather than editing its call sites, and the recorded-fixture tests that
// inject their own fetcher keep working untouched.

import { logWarn } from "../obs/log.js";

/** An upstream that did not answer in time. Distinguished from an upstream
 *  that answered badly, because the operator's next move is different. */
export class UpstreamTimeout extends Error {
  constructor(readonly upstream: string, readonly ms: number, readonly url: string) {
    super(`${upstream} did not answer within ${ms}ms`);
    this.name = "UpstreamTimeout";
  }
}

/** Default deadlines, per upstream. Generous enough for a cold token mint,
 *  short enough that a seller is told something went wrong inside a show. */
export const DEADLINES = {
  /** Browse/comps reads and the token mint. */
  ebay: 15_000,
  /** Helix reads and the token mint. */
  twitch: 10_000,
  /** Listing reads; Reddit's own pacing is slower than its latency. */
  reddit: 15_000,
  /** The gateway's ADMIN paths — agent create/delete, KB push, guardrail push.
   *  Not the chat turn, which has its own budget derived from the latency
   *  target (`context.ts`) and must stay that way. */
  gateway: 20_000,
} as const;

/** What the URL is, with nothing identifying in it. A query string can carry a
 *  token, an account id or a buyer's words; a path rarely can. */
function safeUrl(input: RequestInfo | URL): string {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return raw.split("?")[0] ?? "";
  }
}

/**
 * A `fetch` that cannot outlive its deadline.
 *
 * Composes with a caller's own signal rather than replacing it, so a request
 * that is ALREADY cancellable stays cancellable — the deadline is a ceiling,
 * not a policy override.
 */
export function withDeadline(upstream: string, ms: number): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    // `unref` so a pending deadline never holds the process open on shutdown.
    (timer as { unref?: () => void }).unref?.();
    const caller = init?.signal ?? null;
    const onCallerAbort = () => ctl.abort();
    caller?.addEventListener("abort", onCallerAbort, { once: true });
    const started = Date.now();
    try {
      return await fetch(input, { ...init, signal: ctl.signal });
    } catch (e) {
      // An abort from the CALLER is the caller's business and is rethrown as
      // it was. An abort from the deadline is ours, and it gets a name, a
      // number and a line — "it just hung" was the whole problem.
      if (caller?.aborted) throw e;
      if ((e as Error)?.name === "AbortError") {
        const url = safeUrl(input);
        logWarn("upstream.timeout", { upstream, ms, url, elapsedMs: Date.now() - started });
        throw new UpstreamTimeout(upstream, ms, url);
      }
      throw e;
    } finally {
      clearTimeout(timer);
      caller?.removeEventListener("abort", onCallerAbort);
    }
  };
}

/** The four named upstreams, each already carrying its deadline. */
export const ebayFetch = withDeadline("ebay", DEADLINES.ebay);
export const twitchFetch = withDeadline("twitch", DEADLINES.twitch);
export const redditFetch = withDeadline("reddit", DEADLINES.reddit);
export const gatewayFetch = withDeadline("whissle-gateway", DEADLINES.gateway);
