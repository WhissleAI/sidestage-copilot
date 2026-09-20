// How many real Chrome processes this box can afford, in one place.
//
// The worst case used to be a number you DERIVED from four call sites. There
// are four independent launch families — eBay discovery and seller reads
// (behind `withProfileLock`, so one), the eBay Live show watcher (a shared
// Chromium, refcounted, so one), Whatnot browse discovery (behind
// `withWhatnotLock`, so one) and the scraped room watcher, which owns ONE
// BROWSER PER WATCHED ROOM. With `MAX_WATCHED_SHOWS = 6` that is 6 + 1 + 1 =
// eight real Chromes against `mem_limit: 1100m` for a container that also
// holds Node. Chrome with one page is 150–300 MB resident. The container OOMs
// long before the box does — which is the memory limit doing exactly its job,
// and also means the app DIES rather than degrades, taking every other watched
// show with it.
//
// This file is not the browser pool the audit asks for, and it deliberately
// does not try to be. The pool's real value is that ONE module owns the count
// and the admission decision; unifying the four launchers and the two
// teardowns is a separate and much riskier change, because nothing in the test
// suite executes any of that code (there is not a single Playwright import in
// `test/`). So the count and the admission move here now, where they are pure
// state and can be tested; the launches stay where they are, where they are
// hard-won against real pages.
//
// The rule this encodes: a box refuses the SEVENTH browser instead of being
// killed while holding six.

import { config } from "../config.js";
import { logWarn } from "../obs/log.js";

export interface BrowserLease {
  readonly purpose: string;
  /** Idempotent: releasing twice must not give a slot back twice, which is
   *  exactly the refcount bug this file exists to make unwritable. */
  release(): void;
}

const held = new Map<string, number>();
let open = 0;

function bump(purpose: string, by: number): void {
  const n = (held.get(purpose) ?? 0) + by;
  if (n <= 0) held.delete(purpose);
  else held.set(purpose, n);
}

/** Refused because the box cannot afford another browser right now. */
export class NoBrowserBudget extends Error {
  constructor(readonly purpose: string, readonly open: number, readonly max: number) {
    super(
      `cannot open another browser for ${purpose}: ${open} of ${max} are already open ` +
      `(MAX_BROWSERS). Stop watching a room, or raise the limit on a larger box.`,
    );
    this.name = "NoBrowserBudget";
  }
}

/**
 * Take a browser slot, or refuse.
 *
 * Synchronous and non-blocking on purpose. A caller that QUEUES for a browser
 * is a caller that hangs — `withProfileLock` is an unbounded queue with no
 * deadline and that is its own finding. Refusing is an answer a route can put
 * in a response; waiting is not.
 */
export function takeBrowser(purpose: string): BrowserLease {
  const max = config.maxBrowsers;
  if (open >= max) throw new NoBrowserBudget(purpose, open, max);
  open++;
  bump(purpose, 1);
  let released = false;
  return {
    purpose,
    release(): void {
      if (released) return;
      released = true;
      open--;
      bump(purpose, -1);
      if (open < 0) {
        // Impossible with an idempotent lease; if it ever happens the count is
        // lying and every later admission decision is wrong.
        logWarn("browser.budget_underflow", { purpose });
        open = 0;
      }
    },
  };
}

/** What is open right now, and what the ceiling is. Read by /health. */
export function browserBudget(): { open: number; max: number; held: Record<string, number> } {
  return { open, max: config.maxBrowsers, held: Object.fromEntries(held) };
}

/** Test seam only. */
export function resetBrowserBudget(): void {
  open = 0;
  held.clear();
}
