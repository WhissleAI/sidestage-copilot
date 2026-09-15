// Sign in to eBay once, so the product can see eBay Live.
//
//   npm run ebay:signin          open a window and sign in
//   npm run ebay:signin -- --url just print the URL, change nothing
//
// Why a window and not a link: eBay Live renders nothing for a signed-out
// visitor — measured, zero event links at forty seconds on a page that shows
// fifty to a signed-in one. Seeing it needs a session, and a session is cookies
// in a browser, so it has to be a browser we can reuse afterwards. Signing in
// somewhere else cannot hand those cookies to a server process.
//
// The profile is PERSISTENT (`data/ebay-profile/`). That is the whole trick:
// you sign in once in this window, the profile keeps the session the way your
// everyday browser does, and discovery reuses the profile directly rather than
// juggling an exported cookie jar that goes stale on its own schedule.
//
// Two rules this script learned the hard way:
//   · A signed-in session is saved even if the grid does not render. The first
//     version discarded one because a later check failed, which threw away the
//     only thing the person had actually done.
//   · Closing the window is a normal way to finish, not a crash.

import { chromium } from "playwright";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const PROFILE = resolve(process.env.EBAY_PROFILE_DIR || "./data/ebay-profile");
const OUT = resolve(process.env.EBAY_SESSION_PATH || "./data/ebay-session.json");
const SIGNIN_URL = "https://www.ebay.com/signin/";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

if (process.argv.includes("--url")) {
  console.log(`\n  ${SIGNIN_URL}\n
  Opening that in your everyday browser will not help on its own — the cookies
  have to end up in the browser this product drives. Run \`npm run ebay:signin\`
  without --url and sign in there; that window keeps its profile.\n`);
  process.exit(0);
}

// Same egress as the server's discovery browser (see src/ingest/ebaylive/session.ts):
// a session signed in through a fixed-IP proxy and then used through that proxy
// is one eBay keeps; one born on a laptop and replayed from a datacenter is
// one eBay ends.
function discoveryProxy() {
  const raw = (process.env.EBAY_DISCOVERY_PROXY || "").trim();
  if (!raw) return undefined;
  const u = new URL(raw);
  return {
    server: `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}`,
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
  };
}

mkdirSync(PROFILE, { recursive: true });

// A persistent context, not a throwaway one: this is what makes the session
// outlive the script. Chromium locks the profile, so this cannot run while the
// server is driving it — the error Playwright gives for that mentions a
// "ProcessSingleton", which is not a sentence a person should have to decode.
let ctx;
try {
  ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    userAgent: UA,
    args: ["--disable-blink-features=AutomationControlled"],
    ...(discoveryProxy() ? { proxy: discoveryProxy() } : {}),
  });
  if (discoveryProxy()) console.log(`  signing in through ${discoveryProxy().server} — tick "Stay signed in"`);
} catch (e) {
  if (/ProcessSingleton|already in use/i.test(String(e.message))) {
    console.error(`
  The browser profile is in use — almost certainly by the running server, which
  drives it for Discover. Stop the server (npm run dev), run this, start it again.
`);
    process.exit(2);
  }
  throw e;
}

const page = ctx.pages()[0] ?? (await ctx.newPage());

console.log(`
  A browser window is open on eBay's sign-in page:

      ${SIGNIN_URL}

  Sign in there. Nothing is typed for you and no credential is read by this
  script. When eBay says you are signed in, the session is saved and you can
  close the window — closing it is a normal way to finish.

  Profile: ${PROFILE}
`);

// eBay's own verdict, not the absence of a word: a page that has not painted
// yet has no "Sign in" in it either, and once saved a signed-out jar is a
// signed-out jar. Signed in means the header greets a name.
const signedIn = async () => {
  if (page.isClosed()) return false;
  if (/signin\.ebay\.com/i.test(page.url())) return false;
  return page
    .evaluate(() => {
      const header = (document.querySelector("#gh, header")?.innerText ?? document.body.innerText.slice(0, 600)).replace(/\s+/g, " ");
      return /\bHi\s+[^!\s]/.test(header) && !/Sign in or register/i.test(header);
    })
    .catch(() => false);
};

const save = async (note) => {
  try {
    const state = await ctx.storageState();
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(state, null, 2));
    console.log(`\n  Session saved to ${OUT}`);
    console.log(`  Profile kept at ${PROFILE} — discovery reuses it directly.`);
    if (note) console.log(`  ${note}`);
    return true;
  } catch (e) {
    console.error(`\n  Could not save the session: ${e.message}`);
    return false;
  }
};

let closed = false;
ctx.on("close", () => {
  closed = true;
});

await page.goto(SIGNIN_URL, { waitUntil: "domcontentloaded" }).catch(() => {});

const deadline = Date.now() + 10 * 60_000;
let ok = false;

while (Date.now() < deadline && !closed) {
  await new Promise((r) => setTimeout(r, 3000));
  if (closed || page.isClosed()) break;
  if (!(await signedIn())) continue;

  // Signed in. Save FIRST — that is the thing that was actually accomplished,
  // and it must not depend on anything below succeeding.
  ok = await save(null);

  // Then try to confirm the grid renders, which is the point of the session.
  // A failure here is reported, never a reason to discard what we just saved.
  try {
    await page.goto("https://www.ebay.com/ebaylive", { waitUntil: "domcontentloaded" });
    await page
      .waitForSelector('a[href*="/ebaylive/events/"]', { timeout: 30_000 })
      .catch(() => null);
    for (let i = 0; i < 3 && !page.isClosed(); i++) {
      await page.mouse.wheel(0, 1600).catch(() => {});
      await page.waitForTimeout(1200).catch(() => {});
    }
    const events = page.isClosed()
      ? 0
      : await page
          .evaluate(() => document.querySelectorAll('a[href*="/ebaylive/events/"]').length)
          .catch(() => 0);
    if (events > 0) {
      console.log(`  The live grid is showing ${events} event links — Discover will work.`);
    } else {
      console.log(
        "  The grid did not render in this window. The session is saved anyway;\n" +
          "  check Discover, and re-run this if it still comes back empty.",
      );
    }
  } catch {
    console.log("  Window closed before the grid check. The session is saved.");
  }
  break;
}

if (!ok && !closed) {
  // They closed it, or ran out of time, without ever appearing signed in.
  const late = await signedIn().catch(() => false);
  if (late) ok = await save(null);
}
if (!ok) {
  console.error(
    "\n  Nothing was saved — eBay never reported a signed-in session.\n" +
      "  Run it again; the window stays open for ten minutes.",
  );
}

await ctx.close().catch(() => {});
process.exit(ok ? 0 : 1);
