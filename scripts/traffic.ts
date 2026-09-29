/**
 * What buyers actually asked, and what the copilot could do about it.
 *
 * Written after restoring the first production dump on 2026-09-28 and finding
 * something no test could have told us: **three of the five auto-reply intents
 * had never fired once**, and 72% of every question ever asked landed in
 * `other`, which the autonomy ladder can never auto-reply to by construction.
 *
 * The five — shipping, returns, sizing, authenticity, availability — are an
 * e-commerce Q&A taxonomy. What a live show's chat actually asks is lineup
 * search ("any men's watches", "do you guys have an Oris coulson"), attribute
 * lookup ("aftermarket dial?", "how many grams is the bezel alone", "year?"),
 * auction mechanics ("did the 02 Tag go?", "is a box opened after each
 * auction?") and chatter. Whether the taxonomy should change is a product
 * decision; this makes it a number instead of an anecdote, re-runnable after
 * every show.
 *
 *   npm run traffic                                    # the test database
 *   DATABASE_URL=… npm run traffic                     # or a restored dump
 */
import pg from "pg";
import { AUTO_REPLY_INTENTS, AUTO_CONFIDENCE_FLOOR } from "../src/autonomy/ladder.js";

const url =
  process.env["DATABASE_URL"] ||
  process.env["TEST_DATABASE_URL"] ||
  "postgres://localhost:5432/sidestage_test";

const p = new pg.Pool({ connectionString: url });
const rows = async <T>(sql: string): Promise<T[]> => (await p.query(sql)).rows as T[];
const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(0)}%` : "—");

const total = Number((await rows<{ n: string }>("SELECT count(*) n FROM reply_proposals"))[0]!.n);
if (!total) {
  console.log(`no proposals in ${url}`);
  await p.end();
  process.exit(0);
}

console.log(`\n${url}\n${total} drafts\n`);

console.log("BY INTENT — and whether the ladder could ever send it");
const byIntent = await rows<{ intent: string | null; n: string; sent: string; conf: string | null }>(
  `SELECT intent, count(*) n, sum(CASE WHEN status='sent' THEN 1 ELSE 0 END) sent,
          round(avg(confidence)::numeric,2) conf
     FROM reply_proposals GROUP BY 1 ORDER BY 2 DESC`,
);
for (const r of byIntent) {
  const intent = r.intent ?? "(null)";
  const eligible = AUTO_REPLY_INTENTS.has(intent as never);
  console.log(
    `  ${intent.padEnd(18)} ${String(r.n).padStart(4)} ${pct(Number(r.n), total).padStart(5)}` +
      `  sent=${r.sent}  avg conf=${r.conf ?? "—"}` +
      `  ${eligible ? "auto-reply ELIGIBLE" : "never auto-replies"}`,
  );
}
const eligibleN = byIntent
  .filter((r) => AUTO_REPLY_INTENTS.has((r.intent ?? "") as never))
  .reduce((a, r) => a + Number(r.n), 0);
console.log(
  `\n  ${eligibleN}/${total} (${pct(eligibleN, total)}) are in an intent the ladder may auto-reply to.` +
    `\n  Of those, an auto-send also needs confidence >= ${AUTO_CONFIDENCE_FLOOR} and a surface that can post.`,
);

console.log("\nWHY A DRAFT NEEDED THE SELLER — non-allow guard verdicts");
for (const r of await rows<{ guard: string; verdict: string; n: string }>(
  `SELECT g->>'guard' guard, g->>'verdict' verdict, count(*) n
     FROM reply_proposals p, jsonb_array_elements(p.guards) g
    WHERE g->>'verdict' NOT IN ('allow','n/a') GROUP BY 1,2 ORDER BY 3 DESC`,
)) {
  console.log(`  ${r.guard.padEnd(18)} ${r.verdict.padEnd(8)} ${String(r.n).padStart(4)}`);
}

console.log("\nWHAT THE DRAFT HAD TO WORK WITH");
for (const r of await rows<{ status: string; n: string; noev: string; abst: string; conf: string | null }>(
  `SELECT status, count(*) n,
          sum(CASE WHEN jsonb_array_length(evidence)=0 THEN 1 ELSE 0 END) noev,
          sum(CASE WHEN abstained THEN 1 ELSE 0 END) abst,
          round(avg(confidence)::numeric,2) conf
     FROM reply_proposals GROUP BY 1 ORDER BY 2 DESC`,
)) {
  console.log(
    `  ${r.status.padEnd(14)} ${String(r.n).padStart(4)}  no evidence=${String(r.noev).padStart(3)}` +
      `  abstained=${String(r.abst).padStart(3)}  avg conf=${r.conf ?? "—"}`,
  );
}

console.log("\nTHE ANSWERED RATE, END TO END");
const q = (
  await rows<{ asked: string; drafted: string; sent: string }>(
    `SELECT (SELECT count(*) FROM chat_messages WHERE admitted) asked,
            (SELECT count(*) FROM reply_proposals) drafted,
            (SELECT count(*) FROM reply_proposals WHERE status='sent') sent`,
  )
)[0]!;
console.log(
  `  ${q.asked} admitted  →  ${q.drafted} drafted  →  ${q.sent} sent` +
    `   (${pct(Number(q.sent), Number(q.asked))} of what was asked)`,
);
console.log(
  "  A send is the SELLER pressing send. On eBay Live, Whatnot and TikTok the copilot\n" +
    "  cannot post — `delivery: \"draft-only\"` — so this measures the seller acting on a\n" +
    "  draft, never the copilot answering a buyer.\n",
);

await p.end();
