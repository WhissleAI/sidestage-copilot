// Everything derived from the listing set has to move with it.
//
// `retriever.rebuild()` indexes the lots for retrieval. `refreshIndex()` does
// that AND the four other things the listing set feeds: the runtime's
// `lotRows`, the `lots` list the action proposer reads to spot a swap, the
// marketplace mirror an action commits against, and research warming.
//
// The catalog SWAP route says so in its own comment. The IMPORT route, three
// routes down, called the bare rebuild — so an import answered questions about
// lots the proposer could not see and the executor could not write to.
//
// Found while tracing why a live show with 53 good lots abstained on all 13 of
// its questions. It is not proven to be that cause; it is a real gap of the
// right shape, with the reason already written down next door.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const routes = readFileSync(
  new URL("../src/api/routes.ts", import.meta.url),
  "utf8",
);

describe("every catalog write refreshes what the listing set feeds", () => {
  test("no catalog route settles for a bare retriever rebuild", () => {
    // `target.retriever.rebuild()` anywhere in the routes layer means some
    // derived state was left behind.
    const bare = routes.match(/target\.retriever\.rebuild\(\)/g) ?? [];
    assert.deepEqual(bare, [], "use target.refreshIndex() — see ShowRuntime.refreshIndex");
  });

  test("the import route refreshes", () => {
    const i = routes.indexOf("await importCatalog(target.repo, items)");
    assert.ok(i > 0, "the import route still exists");
    const after = routes.slice(i, i + 900);
    assert.match(after, /await target\.refreshIndex\(\)/);
  });

  test("and so do both apply routes", () => {
    const applies = [...routes.matchAll(/await applyCatalog\(target\.repo, catalog\)/g)];
    assert.equal(applies.length, 2, "two apply sites");
    for (const m of applies) {
      assert.match(routes.slice(m.index!, m.index! + 900), /await target\.refreshIndex\(\)/);
    }
  });
});
