// The eBay Live browser session, and why there has to be one.
//
// Everything on eBay Live is gated behind a signed-in session. This is not a
// rate limit or a timing problem — it was measured. A signed-out headless
// browser on `ebay.com/ebaylive`, waited out to forty seconds with scrolling,
// finds ZERO event links. The same page in a signed-in browser has fifty, with
// viewer counts, seller handles, titles and tags. The grid module streams in
// client-side and simply does not stream for an anonymous visitor.
//
// That is the whole reason Discover never worked, and no amount of better
// selectors would have fixed it. The fix is a session, which means a person
// signing in — us doing that on their behalf is not something to build.
//
// So: `npm run ebay:signin` opens a real browser, the seller signs in
// themselves, and Playwright's storage state is saved here. Discovery and the
// watcher reuse it. Three properties this file keeps honest:
//
//   · The state lives OUTSIDE the repo (`data/`, gitignored). It is a session
//     for a real eBay account and belongs in the same category as a password.
//   · Its age is reported. eBay sessions expire, and "no events found" and "the
//     session went stale last Tuesday" are different problems with different
//     fixes, which the UI must be able to tell apart.
//   · Nothing here ever reads a credential. The sign-in happens in a window the
//     person drives; we wait for the result and save the cookie jar.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { dirname, join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext } from "playwright";

const PATH = resolve(process.env.EBAY_SESSION_PATH || "./data/ebay-session.json");
/** The persistent browser profile `npm run ebay:signin` signs into. Preferred
 *  over the exported state: a profile refreshes its own cookies the way a
 *  normal browser does, an exported jar goes stale on its own schedule. */
const PROFILE = resolve(process.env.EBAY_PROFILE_DIR || "./data/ebay-profile");

export function profileDir(): string | null {
  // The directory exists the moment the sign-in window opens; a session exists
  // only once Chromium has written a cookie store. Closing the window without
  // signing in must not read as "signed in".
  const hasCookies = ["Default/Cookies", "Cookies"].some((f) => existsSync(join(PROFILE, f)));
  return hasCookies ? PROFILE : null;
}

export interface SessionStatus {
  present: boolean;
  /** When it was captured. Null when there is none. */
  savedAt: string | null;
  ageHours: number | null;
  /** eBay sessions do not last forever, and a stale one fails like an empty one. */
  stale: boolean;
  path: string;
}

/** Sessions older than this are reported as stale. Conservative on purpose: a
 *  false "stale" costs one sign-in, a false "fresh" costs a silent empty grid. */
const STALE_AFTER_H = 24 * 7;

export function sessionPath(): string {
  return PATH;
}

export function sessionStatus(): SessionStatus {
  if (!existsSync(PATH) && !profileDir()) {
    return { present: false, savedAt: null, ageHours: null, stale: false, path: PATH };
  }
  if (!existsSync(PATH)) {
    // A profile with no exported state: signed in, age unknown. Report it as
    // present and fresh; the grid read is what actually decides.
    return { present: true, savedAt: null, ageHours: null, stale: false, path: PROFILE };
  }
  const at = statSync(PATH).mtime;
  const ageHours = (Date.now() - at.getTime()) / 3_600_000;
  return {
    present: true,
    savedAt: at.toISOString(),
    ageHours: Math.round(ageHours * 10) / 10,
    stale: ageHours > STALE_AFTER_H,
    path: basename(PATH),
  };
}

/** The storage state Playwright wants, or undefined when there is none. */
export function loadSession(): Record<string, unknown> | undefined {
  if (!existsSync(PATH)) return undefined;
  try {
    return JSON.parse(readFileSync(PATH, "utf8")) as Record<string, unknown>;
  } catch {
    // A corrupt state file is the same as no state: better to say "sign in
    // again" than to hand Playwright something it will throw on.
    return undefined;
  }
}

export function saveSession(state: unknown): void {
  mkdirSync(dirname(PATH), { recursive: true });
  writeFileSync(PATH, JSON.stringify(state, null, 2), { mode: 0o600 });
}

/**
 * One browser on the profile at a time.
 *
 * Chromium locks a persistent profile; a second launch against it fails with
 * "browser is already running". Discovery, a seller-page read and a prepare
 * can all be asked for in the same second from one Discover screen, so every
 * use of the profile queues here rather than racing for the lock.
 */
let chain: Promise<unknown> = Promise.resolve();
export function withProfileLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

/**
 * A signed-in browser context, however the session was kept.
 *
 * Two ways a machine can hold the session: the persistent profile the sign-in
 * script created (a developer's laptop), or only the exported storage state
 * (a server — a macOS Chrome profile's cookies are Keychain-encrypted and do
 * not travel). Both paths launch REAL Chrome. The second used to launch
 * Playwright's bundled headless shell, which is exactly the browser eBay Live
 * refuses to stream to, so a server with a perfectly good session read zero
 * events and reported "blocked". Falls back to the bundled build only on a
 * machine with no Chrome at all.
 */
export async function openContext(o: {
  headless: boolean;
  userAgent: string;
  viewport?: { width: number; height: number };
}): Promise<{ ctx: BrowserContext; close: () => Promise<void> }> {
  const viewport = o.viewport ?? { width: 1440, height: 1200 };
  const args = [
    "--disable-blink-features=AutomationControlled",
    // /dev/shm is tmpfs and its pages count against the container's memory
    // limit, so a browser that fills it OOMs the app rather than slowing down.
    // The watcher has always passed this; discovery did not, and discovery is
    // the path that runs every five minutes forever.
    "--disable-dev-shm-usage",
    "--disable-gpu",
  ];
  const proxy = discoveryProxy();
  const profile = profileDir();
  if (profile) {
    const persistent = (channel?: "chrome") =>
      chromium.launchPersistentContext(profile, {
        headless: o.headless, viewport, userAgent: o.userAgent, args,
        ...(channel ? { channel } : {}),
        ...(proxy ? { proxy } : {}),
      });
    const ctx = await persistent("chrome").catch(() => persistent());
    return { ctx, close: () => closeAll(ctx) };
  }
  const launch = (channel?: "chrome") =>
    chromium.launch({ headless: o.headless, args, ...(channel ? { channel } : {}), ...(proxy ? { proxy } : {}) });
  const browser = await launch("chrome").catch(() => launch());
  const state = loadSession();
  const ctx = await browser.newContext({
    viewport, userAgent: o.userAgent,
    ...(state ? { storageState: state as never } : {}),
  });
  return { ctx, close: () => closeAll(ctx, browser) };
}

/**
 * Put the browser down, and say so when it will not go.
 *
 * Closing the CONTEXT is not closing the browser. On the persistent path this
 * used to be the whole teardown, and `.catch(() => {})` meant a close that
 * failed was indistinguishable from one that worked. Measured on the deployed
 * box, 2026-09-18: four defunct `[chrome]` / `[chrome_crashpad]` entries left
 * behind by every five-minute discovery poll, and a host that thrashed itself
 * to a standstill after about twenty hours of it. So: close the context, then
 * the browser it belongs to, and log whichever one refuses — a silent failure
 * here is a leak nobody can see until the box stops answering.
 */
async function closeAll(ctx: BrowserContext, browser?: Browser): Promise<void> {
  try {
    await ctx.close();
  } catch (e) {
    console.warn(`  ebay: browser context would not close — ${(e as Error).message.slice(0, 120)}`);
  }
  const b = browser ?? ctx.browser() ?? null;
  if (!b) return;
  try {
    await b.close();
  } catch (e) {
    console.warn(`  ebay: browser would not close — ${(e as Error).message.slice(0, 120)}`);
  }
}

/**
 * Where the discovery browser's traffic leaves from.
 *
 * eBay Live serves its challenge page and an anonymous grid to a signed-in
 * session arriving from a datacenter address — measured, not guessed — so a
 * hosted copilot can hold a perfectly good session and still read nothing.
 * `EBAY_DISCOVERY_PROXY` routes ONLY this browser (never the API client, never
 * the player attach) through an egress eBay treats as a person: a residential
 * or ISP proxy, or a SOCKS tunnel back to a machine on a home connection.
 * Accepts `http(s)://`, `socks5://`, with credentials in the URL.
 */
export function discoveryProxy(): { server: string; username?: string; password?: string } | null {
  const raw = process.env.EBAY_DISCOVERY_PROXY?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return {
      server: `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}`,
      ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
      ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    };
  } catch {
    throw new Error(`EBAY_DISCOVERY_PROXY is not a URL: ${raw}`);
  }
}

/** Whether any kept session exists — a profile or the exported state. */
export function hasSession(): boolean {
  return Boolean(profileDir()) || existsSync(PATH);
}
