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
    // Acknowledged, but not honoured: nothing signed it. eBay's retry rules
    // still want the 2xx.
    assert.equal(r.json().honoured, false);
    assert.equal(r.json().removed, undefined);
    const other = await app.inject({ method: "POST", url: "/api/ebay/account-deletion", headers: { "content-type": "application/json" }, payload: { hello: 1 } });
    assert.equal(other.statusCode, 200);
    assert.equal(other.json().ignored, true);
  });
});

// ── the signature is the only lock on this door ─────────────────────────────
import { generateKeyPairSync, createSign } from "node:crypto";
import { verifyNotification, parseSignatureHeader, toPem } from "../src/ingest/ebay/deletion.js";

test("a notice eBay signed verifies; the same bytes with a forged or missing signature do not", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  // eBay hands the key back stripped of PEM line breaks.
  const stripped = pubPem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "").replace(/\s+/g, "");
  const body = JSON.stringify({ metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION" }, notification: { notificationId: "n1", data: { username: "someone", userId: "u1" } } });
  const s = createSign("SHA1"); s.update(body);
  const header = Buffer.from(JSON.stringify({ kid: "k1", alg: "ecdsa", digest: "SHA1", signature: s.sign(privateKey, "base64") })).toString("base64");
  const fetchKey = async (kid: string) => (kid === "k1" ? { key: stripped, digest: "SHA1" } : null);

  assert.ok(parseSignatureHeader(header)?.kid === "k1");
  assert.ok(toPem(stripped).includes("-----BEGIN PUBLIC KEY-----\n"));
  assert.equal((await verifyNotification(body, header, fetchKey)).ok, true);
  assert.equal((await verifyNotification(body + " ", header, fetchKey)).ok, false, "a changed body must not verify");
  assert.equal((await verifyNotification(body, undefined, fetchKey)).ok, false, "no header, no deletion");
  const forged = Buffer.from(JSON.stringify({ kid: "k1", signature: Buffer.from("nope").toString("base64") })).toString("base64");
  assert.equal((await verifyNotification(body, forged, fetchKey)).ok, false);
});
