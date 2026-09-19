// The Reddit API, as much of it as a monitor-and-draft surface needs: read.
//
// Reddit's script grant is a password grant against `/api/v1/access_token`,
// authenticated with the app's id and secret as HTTP Basic. That is five
// separate values and all five are required — the app identity and the account
// identity are different halves of one credential, and four of them
// authenticates nobody. `SurfaceUnavailable` names the one that is missing,
// because "reddit failed to open" sends an operator to the logs for something
// the response already knew.
//
// Two things here are not boilerplate:
//
//  1. **The User-Agent.** Reddit rate-limits by it, asks that it identify the
//     application and its owner, and answers a generic one with 429s that look
//     exactly like pacing we got wrong. It is required configuration, not a
//     default, and every request carries it — including the token mint, which
//     is the request most likely to be made from a cold process.
//
//  2. **`x-ratelimit-*`.** Reddit tells you, on every response, how many
//     requests remain in the current window and how many seconds until it
//     resets. A 429 from Reddit is therefore not an expected outcome to retry
//     through — it is proof we ignored a number it handed us. The client reads
//     the headers and waits BEFORE the request that would have spent the last
//     of the budget.

import { config } from "../../config.js";
import { SurfaceUnavailable } from "../types.js";

type Fetcher = typeof fetch;

const OAUTH = "https://oauth.reddit.com";
const WWW = "https://www.reddit.com";

export interface RedditCreds {
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  userAgent: string;
}

/** The variables, in the order a person filling in a `.env` meets them, so the
 *  refusal names the first gap rather than an arbitrary one. */
const REQUIRED: [keyof RedditCreds, string][] = [
  ["clientId", "REDDIT_CLIENT_ID"],
  ["clientSecret", "REDDIT_CLIENT_SECRET"],
  ["username", "REDDIT_USERNAME"],
  ["password", "REDDIT_PASSWORD"],
  ["userAgent", "REDDIT_USER_AGENT"],
];

/** The first missing credential, as its environment-variable name. */
export function missingCredential(creds: Partial<RedditCreds>): string | null {
  for (const [key, envName] of REQUIRED) if (!creds[key]) return envName;
  return null;
}

/** Throw the typed refusal the attach route turns into a 409. */
export function requireCreds(creds: Partial<RedditCreds> = config.reddit): RedditCreds {
  const missing = missingCredential(creds);
  if (missing) throw new SurfaceUnavailable("reddit", `reddit: ${missing} is not set`, missing);
  return creds as RedditCreds;
}

export class RedditError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** True when retrying cannot change the answer: bad credentials, a private
     *  or banned subreddit, a deleted thread. Worth distinguishing, because the
     *  poller should stop rather than spend a rate-limit budget on it. */
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = "RedditError";
  }
}

/** What Reddit says about our remaining budget, parsed off any response. */
export interface RateState {
  /** Requests left in this window. */
  remaining: number;
  /** Seconds until the window resets. */
  resetS: number;
  used: number;
}

export function parseRateHeaders(h: Headers): RateState | null {
  // Absent headers are read as null, never as a budget of zero. `Number(null)`
  // is 0, which would have every response without them stall the poller for a
  // reset window it was never told about.
  const rawRemaining = h.get("x-ratelimit-remaining");
  const rawReset = h.get("x-ratelimit-reset");
  if (rawRemaining === null || rawReset === null) return null;
  const remaining = Number(rawRemaining);
  const resetS = Number(rawReset);
  if (!Number.isFinite(remaining) || !Number.isFinite(resetS)) return null;
  const used = Number(h.get("x-ratelimit-used"));
  return { remaining, resetS, used: Number.isFinite(used) ? used : 0 };
}

/**
 * How long to wait before spending the next request.
 *
 * The shape matters more than the constant. With plenty of budget left the
 * answer is zero — pacing a quiet poller costs freshness for nothing. As the
 * window empties the wait stretches to cover the whole of the remaining reset
 * so the last few requests are spread across it rather than fired into the
 * final second. At zero there is no request left to spend and the only correct
 * move is to wait out the window.
 *
 * `RESERVE` is the point at which spreading starts. Reddit's OAuth window is
 * 600 requests per 10 minutes; a handful left is not a budget to use freely, it
 * is a budget to eke out.
 */
const RESERVE = 10;

export function backoffMs(r: RateState | null): number {
  if (!r) return 0;
  if (r.remaining <= 0) return Math.max(1000, Math.ceil(r.resetS * 1000));
  if (r.remaining > RESERVE) return 0;
  // Spread what is left across what is left of the window.
  return Math.ceil((r.resetS * 1000) / r.remaining);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class RedditClient {
  private token: { value: string; expiresAt: number } | null = null;
  private inFlight: Promise<string> | null = null;
  private rate: RateState | null = null;
  /** Serialises the wait: two concurrent calls that each check the budget and
   *  then spend it have not paced anything. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly creds: Partial<RedditCreds> = config.reddit,
    /** Injected so the suite exercises token refresh, backoff and parsing with
     *  recorded fixtures and no network. */
    private readonly fetcher: Fetcher = fetch,
    private readonly wait: (ms: number) => Promise<unknown> = sleep,
  ) {}

  get configured(): boolean {
    return missingCredential(this.creds) === null;
  }

  /** What Reddit last told us about the budget. Exposed for the console and
   *  for the tests that prove we read it. */
  get rateState(): RateState | null {
    return this.rate;
  }

  /**
   * An access token, cached until shortly before it expires.
   *
   * Reddit issues these for an hour and counts the mint against the same
   * budget as everything else, so concurrent callers share one request rather
   * than each starting their own.
   */
  async accessToken(): Promise<string> {
    const creds = requireCreds(this.creds);
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;
    if (this.inFlight) return this.inFlight;

    const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64");
    this.inFlight = (async () => {
      const res = await this.fetcher(`${WWW}/api/v1/access_token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
          // The mint is a request like any other and is the one most likely to
          // come from a cold process, which is exactly when a missing agent
          // gets an account throttled.
          "User-Agent": creds.userAgent,
        },
        body: new URLSearchParams({
          grant_type: "password",
          username: creds.username,
          password: creds.password,
        }).toString(),
      });
      this.observe(res);
      const body = (await res.json().catch(() => ({}))) as {
        access_token?: string; expires_in?: number; error?: string;
      };
      if (!res.ok || !body.access_token) {
        // 401 here is the credential itself: a web-app client used as a script
        // app, or an account with 2FA on (the password grant needs
        // `password:otp`). Neither is fixed by trying again.
        throw new RedditError(
          `reddit refused the script token — ${body.error || res.status}`,
          res.status,
          res.status === 401 || res.status === 400,
        );
      }
      // Renew a minute early rather than discovering expiry mid-poll.
      const ttl = Math.max(60, (body.expires_in ?? 3600) - 60) * 1000;
      this.token = { value: body.access_token, expiresAt: Date.now() + ttl };
      return body.access_token;
    })().finally(() => {
      this.inFlight = null;
    });

    return this.inFlight;
  }

  private observe(res: { headers: Headers }): void {
    const r = parseRateHeaders(res.headers);
    if (r) this.rate = r;
  }

  /**
   * A read against the OAuth host, paced by what Reddit last told us.
   *
   * The wait happens before the request, not after a 429. By the time Reddit
   * answers 429 the request has already been counted and the account is closer
   * to a block; the headers said so one response earlier, for free.
   */
  async get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    const creds = requireCreds(this.creds);
    const token = await this.accessToken();
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
    // `raw_json=1` stops Reddit HTML-escaping &, < and > in every body it
    // returns. Without it a quoted price range arrives as "&gt;$200" and the
    // draft quotes the escape back at the person who wrote it.
    qs.set("raw_json", "1");
    const url = `${OAUTH}${path}?${qs.toString()}`;

    const run = async (): Promise<T> => {
      const pause = backoffMs(this.rate);
      if (pause > 0) await this.wait(pause);
      const res = await this.fetcher(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": creds.userAgent,
          Accept: "application/json",
        },
      });
      this.observe(res);
      if (res.status === 429) {
        // Not an expected outcome. Something spent budget outside this client,
        // or the headers lied; either way the honest move is to wait out the
        // window the response names and say what happened.
        throw new RedditError(
          `reddit rate-limited ${path} — our pacing was wrong, ${this.rate?.remaining ?? "?"} remaining`,
          429,
          false,
        );
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new RedditError(
          `reddit ${path} answered ${res.status}${text ? ` — ${text.slice(0, 160)}` : ""}`,
          res.status,
          res.status === 403 || res.status === 404 || res.status === 401,
        );
      }
      return (await res.json()) as T;
    };

    // One at a time. Concurrent callers that each read the budget and then
    // spend it have paced nothing.
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }
}
