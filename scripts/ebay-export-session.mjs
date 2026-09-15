#!/usr/bin/env node
// Export the signed-in eBay Live session from the local Chrome profile as
// Playwright storage state — the form that travels to a server.
//
// The profile itself cannot be copied: macOS Chrome encrypts its cookies with
// the Keychain, and a Linux Chrome reads them as garbage. The storage-state
// file is the same cookies in plain form, written by the browser that can read
// them. It is treated like a password: `data/` is gitignored and the deploy
// script ships it over ssh only.
//
// Usage: npm run ebay:export        (with the local server stopped, so the
//        profile is not locked by a discovery read)
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const PROFILE = resolve(process.env.EBAY_PROFILE_DIR || "./data/ebay-profile");
const OUT = resolve(process.env.EBAY_SESSION_PATH || "./data/ebay-session.json");
if (!existsSync(PROFILE)) {
  console.error(`no profile at ${PROFILE} — run \`npm run ebay:signin\` first`);
  process.exit(1);
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
const launch = (channel) =>
  chromium.launchPersistentContext(PROFILE, {
    headless: true,
    channel,
    viewport: { width: 1440, height: 1200 },
    args: ["--disable-blink-features=AutomationControlled"],
    ...(discoveryProxy() ? { proxy: discoveryProxy() } : {}),
  });
let ctx;
try {
  ctx = await launch("chrome").catch(() => launch());
} catch (e) {
  console.error(`could not open the profile — is the server running a discovery read? ${e.message}`);
  process.exit(1);
}
try {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto("https://www.ebay.com/ebaylive", { waitUntil: "domcontentloaded", timeout: 60_000 });
  // The grid streams in; give it the same patience discovery does.
  let events = 0;
  for (let i = 0; i < 6 && !events; i++) {
    await page.waitForTimeout(5_000);
    events = await page.evaluate(() => document.querySelectorAll('a[href*="/ebaylive/events/"]').length);
  }
  const signedIn = state => state.cookies.some((c) => c.name === "nonsession") && state.cookies.some((c) => c.name === "ebay");
  const state = await ctx.storageState();
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(state, null, 2));
  console.log(`saved ${state.cookies.length} cookies to ${OUT}`);
  console.log(`grid check: ${events} event links · ${signedIn(state) ? "session cookies present" : "NO session cookies — run npm run ebay:signin"}`);
  if (!events) console.log("no events seen — the exported state may not be enough; sign in again and re-export");
} finally {
  await ctx.close().catch(() => {});
}
