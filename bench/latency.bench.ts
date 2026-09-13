// Latency benchmark — the empirical half of the latency spike.
//
// Replays a deterministic show script through the real pipeline against the real
// Whissle agent and reports per-stage p50/p95/p99, so the 2-second budget is a
// measured claim rather than an aspiration. Two passes:
//
//   pass 1  cold — every question hits the LLM
//   pass 2  warm — the SAME questions, so the version-keyed reply cache serves
//                  them and the effect on p95 is visible rather than asserted
//
//   npm run bench            40 questions, both passes
//   npm run bench -- 80      80 questions
//
// Numbers land in docs/EVALS.md. They move with the gateway's load, which is the
// honest situation for anything with a network hop in the path.

import { buildBench, stats } from "./harness.js";
import { QUESTIONS, rng } from "../src/ingest/script.js";
import { config } from "../src/config.js";
import type { ReplyProposal } from "../src/domain/types.js";

const N = Number(process.argv[2]) || 40;

function row(label: string, xs: number[], budget?: number): string {
  const s = stats(xs);
  const flag = budget && s.p95 > budget ? "  OVER BUDGET" : "";
  return `    ${label.padEnd(14)} n=${String(s.n).padEnd(4)} p50 ${String(s.p50).padStart(5)}  p95 ${String(s.p95).padStart(5)}  p99 ${String(s.p99).padStart(5)}  max ${String(s.max).padStart(5)}${flag}`;
}

function report(title: string, proposals: ReplyProposal[]): void {
  const spans = proposals.map((p) => p.spans);
  console.log(`\n  ${title}  (${proposals.length} replies, budget ${config.latencyBudgetMs}ms)`);
  console.log(row("admit", spans.map((s) => s.admitMs)));
  console.log(row("classify", spans.map((s) => s.classifyMs)));
  console.log(row("retrieve", spans.map((s) => s.retrieveMs)));
  console.log(row("compose (LLM)", spans.map((s) => s.composeMs)));
  console.log(row("guard", spans.map((s) => s.guardMs)));
  console.log(row("repair", spans.filter((s) => s.repairMs > 0).map((s) => s.repairMs)));
  console.log(row("TOTAL", spans.map((s) => s.totalMs), config.latencyBudgetMs));

  const over = spans.filter((s) => s.overBudget).length;
  const cached = spans.filter((s) => s.cacheHit).length;
  const repaired = proposals.filter((p) => p.repaired).length;
  const blocked = proposals.filter((p) => p.status === "blocked").length;
  const review = proposals.filter((p) => p.status === "needs_review").length;

  console.log(
    `    budget breaches ${over}/${spans.length} (${((over / spans.length) * 100).toFixed(1)}%)` +
    `   cache hits ${cached}/${spans.length}` +
    `   repaired ${repaired}` +
    `   blocked ${blocked}   needs-review ${review}`,
  );
}

async function pass(b: ReturnType<typeof buildBench>, questions: string[], label: string): Promise<ReplyProposal[]> {
  const before = new Set(b.settled.keys());
  const rand = rng(7);
  // Only ADMITTED messages become proposals — the relevance gate and the rate
  // cap drop the rest by design, so waiting on the submitted count would hang.
  let admitted = 0;
  for (let i = 0; i < questions.length; i++) {
    const m = b.pipeline.ingest({
      author: `bench_${Math.floor(rand() * 40)}`,
      text: questions[i],
      externalId: `${label}_${i}`,
    });
    if (m.admitted) admitted++;
  }
  if (admitted < questions.length) {
    console.log(`    (${questions.length - admitted}/${questions.length} dropped by the relevance gate or rate cap)`);
  }
  await b.waitFor(before.size + admitted);
  return [...b.settled.entries()].filter(([id]) => !before.has(id)).map(([, p]) => p);
}

async function main(): Promise<void> {
  const b = buildBench();
  const rand = rng(42);
  const questions = Array.from({ length: N }, () => QUESTIONS[Math.floor(rand() * QUESTIONS.length)].text);

  console.log(`\nSideStage latency benchmark`);
  console.log(`  agent      ${config.whissle.agentId.slice(0, 8)} via ${config.whissle.base}`);
  console.log(`  concurrency ${config.replyConcurrency}   budget ${config.latencyBudgetMs}ms   questions ${N}`);

  const t0 = Date.now();
  const cold = await pass(b, questions, "cold");
  report("PASS 1 — cold (every reply hits the LLM)", cold);

  const warm = await pass(b, questions, "warm");
  report("PASS 2 — warm (same questions, version-keyed cache)", warm);

  // The cache's correctness property, not just its speed: a markdown must make
  // every cached answer for that listing unreachable.
  const pinned = b.repo.pinned()!;
  b.repo.mutateListing(pinned.id, { priceCents: pinned.priceCents - 4200 });
  b.retriever.rebuild();
  const afterMarkdown = await pass(b, ["how much for the chicagos"], "post-markdown");
  const servedFromCache = afterMarkdown[0]?.spans.cacheHit;
  console.log(
    `\n  cache invalidation: after a markdown, "how much for the chicagos" was ` +
    `${servedFromCache ? "SERVED FROM CACHE — BUG" : "recomputed (correct)"}`,
  );

  console.log(`\n  wall clock ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  if (servedFromCache) process.exit(1);
}

main().catch((e) => {
  console.error(`bench failed — ${(e as Error).message}`);
  process.exit(1);
});
