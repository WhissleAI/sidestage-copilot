import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { AgentApiError, explainAgentFailure } from "../src/llm/streamAgent.js";

// Transport noise is not operator copy.
//
// When agent creation failed, `prepareEvent` pushed the thrown message into
// `warnings`, and `DiscoverView` renders every warning verbatim under the
// prepared-show card. So the seller's product surface read:
//
//     agent not created: POST /api/agents → 429 {"detail":"…"}
//
// which names no cause they recognise and no move they can make. The status is
// what distinguishes the causes, so the error now carries it as a number rather
// than baking it into a string, and `explainAgentFailure` answers both halves.

const CAP = new AgentApiError("POST", "/api/agents", 429, '{"detail":"limit of 500 agents"}');

describe("an agent failure a seller can act on", () => {
  test("the cap names both moves, because the workspace is shared", () => {
    const s = explainAgentFailure(CAP);
    assert.match(s, /agent limit/);
    assert.match(s, /agents:gc/, "the move that does not need the Whissle console");
    assert.match(s, /Whissle console/, "and the one for agents this app did not create");
  });

  test("a cap reported as a message rather than a status is still a cap", () => {
    // The gateway has answered this as a 400 with the sentence in the body.
    const s = explainAgentFailure(new AgentApiError("POST", "/api/agents", 400, "limit of 50 agents"));
    assert.match(s, /agent limit/);
  });

  test("credit, auth and outage are distinguished — the fix differs for each", () => {
    assert.match(explainAgentFailure(new AgentApiError("POST", "/x", 402, "")), /out of credit/);
    assert.match(explainAgentFailure(new AgentApiError("POST", "/x", 401, "")), /API key/);
    assert.match(explainAgentFailure(new AgentApiError("POST", "/x", 503, "")), /unreachable/);
  });

  test("a network error carries no status and still gets a sentence", () => {
    const s = explainAgentFailure(new Error("fetch failed"));
    assert.match(s, /unreachable/);
    assert.ok(!/undefined|NaN/.test(s));
  });

  test("no branch leaks a method, a path or a status line into the copy", () => {
    const cases = [
      CAP,
      new AgentApiError("POST", "/api/agents", 402, "x"),
      new AgentApiError("POST", "/api/agents", 401, "x"),
      new AgentApiError("POST", "/api/agents", 500, "x"),
      new Error("boom"),
    ];
    for (const e of cases) {
      const s = explainAgentFailure(e);
      assert.ok(!s.includes("/api/agents"), `leaked a path: ${s}`);
      assert.ok(!s.includes("POST"), `leaked a method: ${s}`);
      assert.ok(!s.includes("→"), `leaked the status line: ${s}`);
    }
  });

  test("the unrecognised case still says who refused, and shows the status once", () => {
    const s = explainAgentFailure(new AgentApiError("POST", "/api/agents", 418, "teapot"));
    assert.match(s, /Whissle refused/);
    assert.match(s, /418/);
  });

  test("the raw detail is still on the error, for the log", () => {
    assert.equal(CAP.status, 429);
    assert.match(CAP.message, /POST \/api\/agents → 429/);
  });
});
