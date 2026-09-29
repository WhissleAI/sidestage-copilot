// The auto-reply allow-list, against the questions that actually arrive.
//
// Measured on the first production dump, 2026-09-28 (`npm run traffic`):
//
//   other              39   72%   never auto-replies
//   hype                4    7%   never auto-replies
//   discount_request    4    7%   never auto-replies
//   price_question      3    6%   never auto-replies
//   availability        2    4%   auto-reply ELIGIBLE   avg conf 0.52
//   sizing              2    4%   auto-reply ELIGIBLE   avg conf 0.00
//
// 4 of 54 drafts were in an eligible intent, and the best of those averaged 0.52
// against a 0.8 floor — so **nothing in production has ever been eligible to
// auto-send on both counts**, and shipping, returns and authenticity have never
// fired once. The five are an e-commerce Q&A taxonomy; a live show's chat asks
// lineup search, attribute lookup, auction mechanics and chatter.
//
// Whether the taxonomy changes is a product decision. What is checkable is that
// the allow-list is not partly dead letters, and that the measurement exists.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AUTO_REPLY_INTENTS, AUTO_CONFIDENCE_FLOOR } from "../src/autonomy/ladder.js";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

/** The intents the classifier can actually produce, read off the type. */
function intentVocabulary(): Set<string> {
  const src = read("src/domain/types.ts");
  const decl = src.slice(src.indexOf("export type ChatIntent ="));
  const body = decl.slice(0, decl.indexOf(";"));
  return new Set([...body.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!));
}

describe("the auto-reply allow-list", () => {
  test("names only intents the classifier can emit", () => {
    const vocab = intentVocabulary();
    assert.ok(vocab.size >= 8, `only parsed ${vocab.size} intents from ChatIntent`);
    const dead = [...AUTO_REPLY_INTENTS].filter((i) => !vocab.has(i));
    assert.deepEqual(
      dead,
      [],
      "an allow-listed intent the classifier never produces is a dead letter: it reads as " +
        "permission in the code and can never be granted",
    );
  });

  test("does not allow-list the bucket that holds most of the traffic", () => {
    // 72% of production questions are `other`. If `other` were ever added here,
    // every unclassified comment would become auto-reply eligible — which is the
    // opposite of what an allow-list is for.
    assert.ok(!AUTO_REPLY_INTENTS.has("other"), "`other` must never be auto-replyable");
    assert.ok(!AUTO_REPLY_INTENTS.has("hype"), "chatter is not a question to answer");
    // `discount_request` is a negotiation, not a lookup.
    assert.ok(!AUTO_REPLY_INTENTS.has("discount_request"));
  });

  test("the floor is above the confidence production actually produces", () => {
    // Not a rule about the code — a note that the floor is doing its job. The
    // best eligible intent in production averaged 0.52.
    assert.ok(AUTO_CONFIDENCE_FLOOR >= 0.8, "the floor must not drift below 0.8 quietly");
  });

  test("the measurement is in the repo and wired to a command", () => {
    // A finding in a commit message is an anecdote. This one is re-runnable
    // after every show, against the test database or a restored dump.
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    assert.equal(pkg.scripts["traffic"], "tsx scripts/traffic.ts");
    const s = read("scripts/traffic.ts");
    assert.match(s, /AUTO_REPLY_INTENTS/, "it must read the real allow-list, not a copy of it");
    assert.match(s, /AUTO_CONFIDENCE_FLOOR/, "and the real floor");
    // The sentence that stops the answered rate being misread, which I have
    // misread three times: a send is the SELLER acting, not the copilot posting.
    assert.match(s, /draft-only/);
    assert.match(s, /never the copilot answering a buyer/);
  });
});
