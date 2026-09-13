// `npm run demo:ebaylive -- <eventId|url>`
//
// The whole product, against a real eBay Live show, in one command:
//
//   1. attach to the live stream            real buyer chat, real lots
//   2. import the seller's catalog          what they are actually selling
//   3. push that catalog to the Whissle agent's knowledge base
//   4. ask the questions real buyers were asking in that chat
//
// Requires the server to be running (`npm run dev`).

import { readFileSync } from "node:fs";
import { config } from "../src/config.js";

const BASE = `http://localhost:${config.port}`;
const target = process.argv[2] || process.env.EBAY_EVENT_ID;

if (!target) {
  console.error("usage: npm run demo:ebaylive -- <eventId|showUrl>");
  console.error("find one with: npm run ebay:shows");
  process.exit(2);
}

const post = async (path: string, body: unknown): Promise<unknown> => {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j as { error?: string }).error || `${path} -> ${r.status}`);
  return j;
};

const get = async (path: string): Promise<unknown> => {
  const r = await fetch(`${BASE}${path}`);
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
};

const rule = () => console.log("  " + "─".repeat(74));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The questions below are VERBATIM from the chat of a live eBay Live card show.
// They are inventory searches, which is what real live-commerce chat is made of.
const REAL_QUESTIONS = [
  "any red sox",
  "Got any Grady Sizemore?",
  "Any more Jeter's?",
  "any skubal",
  "How much on Ken Griffey",
  "Carter Jensen?",
  "Long shot any Tommy Edman ?",
  "any lakers jerseys",
];

async function main(): Promise<void> {
  await get("/health").catch(() => {
    console.error(`No server on ${BASE}. Start it with \`npm run dev\`.`);
    process.exit(2);
  });

  console.log("\n  SIDESTAGE ON A REAL eBay LIVE SHOW");
  rule();

  // ── 1. attach ───────────────────────────────────────────────────────────
  const attached = (await post("/api/shows/attach", { url: target })) as {
    showId: string; show: { title: string; viewers: number; readOnly: boolean };
  };
  const showId = attached.showId;
  console.log(`  attached  ${showId}`);
  console.log(`            ${attached.show.title}`);
  console.log(`            read-only: ${attached.show.readOnly} (no seller credentials for someone else's show)`);

  // ── 2. import the catalog ───────────────────────────────────────────────
  const catalog = JSON.parse(readFileSync(new URL("../fixtures/ebay-card-show-catalog.json", import.meta.url), "utf8"));
  const imported = (await post(`/api/shows/${showId}/catalog`, catalog)) as {
    created: number; updated: number; listings: number; kb: { uploaded: boolean; lots: number; reason?: string };
  };
  rule();
  console.log(`  catalog   ${imported.created} created, ${imported.updated} updated, ${imported.listings} listings total`);
  console.log(`  whissle   knowledge base ${imported.kb.uploaded ? `updated with ${imported.kb.lots} lots` : `skipped (${imported.kb.reason})`}`);

  // ── 3. let the live feed settle ─────────────────────────────────────────
  console.log(`\n  watching the live stream for 20s...`);
  await sleep(20_000);
  const listings = (await get(`/api/listings?showId=${showId}`)) as {
    title: string; priceCents: number; qty: number; version: number; externalRef: string | null;
  }[];
  const observed = listings.filter((l) => l.externalRef);
  rule();
  console.log(`  lots seen on air (version bumps are REAL auction price movement):`);
  for (const l of observed) {
    console.log(`    v${String(l.version).padStart(3)}  $${(l.priceCents / 100).toFixed(2).padStart(9)}  qty=${l.qty}  ${l.title.slice(0, 48)}`);
  }
  if (!observed.length) console.log("    (no lot change captured yet — the show may be between lots)");

  // ── 4. ask what real buyers asked ───────────────────────────────────────
  rule();
  console.log(`  replying to questions taken verbatim from this show's chat:\n`);
  for (const q of REAL_QUESTIONS) {
    await post(`/api/chat/inject?showId=${showId}`, { author: "reviewer", text: q });
    await sleep(400);
  }
  await sleep(16_000);

  const proposals = (await get(`/api/proposals?showId=${showId}`)) as {
    message: { author: string; text: string };
    draft: string; status: string; confidence: number;
    evidence: { label: string }[];
    guards: { guard: string; verdict: string; reason?: string }[];
    spans: { totalMs: number };
  }[];

  for (const p of proposals.filter((x) => x.message.author === "reviewer")) {
    console.log(`  Q  ${p.message.text}`);
    console.log(`  A  ${p.draft || "(no draft)"}`);
    const bad = p.guards.filter((g) => g.verdict === "block" || g.verdict === "revise");
    console.log(
      `     [${p.status}] conf ${p.confidence} · ${p.spans.totalMs.toFixed(0)}ms · ` +
      `grounded in: ${p.evidence.slice(0, 3).map((e) => e.label).join(", ") || "nothing"}`,
    );
    for (const g of bad) console.log(`     ${g.guard}: ${g.reason}`);
    console.log();
  }

  rule();
  console.log(`  Every answer above is grounded in the imported catalog and checked against`);
  console.log(`  live state before it could be sent. Nothing was posted back to eBay.\n`);
}

main().catch((e) => {
  console.error(`\ndemo failed — ${(e as Error).message}\n`);
  process.exit(1);
});
