// eBay will not enable a production keyset until this endpoint answers.
//
// The challenge is a documented hash and the notice is a documented envelope;
// both are pinned here so a refactor cannot quietly break the one route eBay
// calls without a person in the loop.
process.env.EBAY_DELETION_VERIFICATION_TOKEN = "test-token-0123456789-0123456789-0123456789";
process.env.EBAY_DELETION_ENDPOINT = "https://example.test/api/ebay/account-deletion";

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../src/api/context.js";
import { challengeResponse, parseNotice } from "../src/ingest/ebay/deletion.js";

let app: FastifyInstance;
let ctx: AppContext;
before(async () => {
  const { buildApp } = await import("../src/api/server.js");
  ({ app, ctx } = await buildApp());
});
after(async () => {
  await app.close();
  await ctx.stop();
});

describe("eBay account-deletion notifications", () => {
  test("the challenge hash is sha256(code + token + endpoint), hex", () => {
    const cfg = { verificationToken: "tok", endpointUrl: "https://x.test/cb" };
    const expected = createHash("sha256").update("abc" + "tok" + "https://x.test/cb").digest("hex");
    assert.equal(challengeResponse("abc", cfg), expected);
  });

  test("GET answers eBay's verification with the hash of OUR registered values", async () => {
    const r = await app.inject({ method: "GET", url: "/api/ebay/account-deletion?challenge_code=c0de" });
    assert.equal(r.statusCode, 200);
    assert.match(r.headers["content-type"] as string, /application\/json/);
    assert.equal(
      r.json().challengeResponse,
      createHash("sha256").update("c0de" + process.env.EBAY_DELETION_VERIFICATION_TOKEN + process.env.EBAY_DELETION_ENDPOINT).digest("hex"),
    );
    assert.equal((await app.inject({ method: "GET", url: "/api/ebay/account-deletion" })).statusCode, 400);
  });

  test("only a MARKETPLACE_ACCOUNT_DELETION envelope is a notice", () => {
    assert.equal(parseNotice({ metadata: { topic: "SOMETHING_ELSE" } }), null);
    assert.deepEqual(
      parseNotice({ metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION" }, notification: { notificationId: "n1", data: { userId: "u1", username: "seller_x", eiasToken: "e" } } }),
      { notificationId: "n1", userId: "u1", username: "seller_x" },
    );
  });

  test("POST acknowledges immediately and records the notice", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/ebay/account-deletion", headers: { "content-type": "application/json" },
      payload: { metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION" }, notification: { notificationId: "n-test", data: { userId: "nobody-here", username: "nobody_here" } } },
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().removed, 0);
    const other = await app.inject({ method: "POST", url: "/api/ebay/account-deletion", headers: { "content-type": "application/json" }, payload: { hello: 1 } });
    assert.equal(other.statusCode, 200);
    assert.equal(other.json().ignored, true);
  });
});
