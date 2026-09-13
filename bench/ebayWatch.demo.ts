// `npm run ebay:watch -- <eventId|url> [seconds]`
//
// Attach to a real eBay Live show and print what the ingestion adapter sees:
// buyer comments, the current lot, and viewer count. No copilot, no LLM — this
// is the raw feed, so a reviewer can confirm the data is real before believing
// anything built on top of it.

import { EbayLiveWatcher } from "../src/ingest/ebaylive/watcher.js";
import { parseEventId } from "../src/ingest/ebaylive/discovery.js";
import { formatMoney } from "../src/domain/money.js";

const raw = process.argv[2];
const seconds = Number(process.argv[3]) || 45;

if (!raw) {
  console.error("usage: npm run ebay:watch -- <eventId|showUrl> [seconds]");
  process.exit(2);
}
const eventId = parseEventId(raw);
if (!eventId) {
  console.error(`could not read an event id out of "${raw}"`);
  process.exit(2);
}

const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`.padStart(6);
let comments = 0;
let lots = 0;

const w = new EbayLiveWatcher({
  eventId,
  onStatus: (s) => console.log(`${el()}  [${s.connected ? "ok" : "!!"}] ${s.detail}`),
  onViewers: (n) => console.log(`${el()}  viewers ${n}`),
  onComment: (c) => {
    comments++;
    console.log(`${el()}  ${c.author}: ${c.text}`);
  },
  onLot: (l) => {
    lots++;
    console.log(
      `${el()}  LOT  ${l.title}  ${formatMoney(l.priceCents)}` +
      `${l.highBidder ? `  (${l.highBidder} winning)` : ""}` +
      `${l.secondsLeft !== null ? `  ${l.secondsLeft}s left` : ""}` +
      `${l.soldOut ? "  SOLD OUT" : ""}`,
    );
  },
});

console.log(`\nattaching to eBay Live event ${eventId} for ${seconds}s...\n`);
await w.start();
await new Promise((r) => setTimeout(r, seconds * 1000));
await w.stop();
console.log(`\ncaptured ${comments} new comments and ${lots} lot changes in ${seconds}s\n`);
process.exit(0);
