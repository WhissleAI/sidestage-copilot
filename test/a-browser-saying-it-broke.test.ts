// The frontend's only error reporter was a no-op in production.
//
// `reportLovableError` is what BOTH of the console's error boundaries call — the
// route-level one and the per-panel one added the same day to stop one panel's
// failure blanking a seller's console mid-show. It forwards to
// `window.__lovableEvents` and `window.__lovableReportRuntimeError`, two globals
// the Lovable editor injects. Verified against the deployed site: no `lovable`
// script in the HTML of `/` or `/console`, so both are undefined and the whole
// function does nothing.
//
// So the console degraded correctly and told nobody. The backend records its own
// failures in `session_events` — a watcher giving up, an unhandled rejection, a
// ledger write that failed — and the browser threw its away.
//
// `POST /api/client-error` is the other half. The tests below are mostly about it
// being a write a BROWSER can make.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { db, migrate, closeDb, type Pool } from "../src/db/pg.js";
import { buildApp } from "../src/api/server.js";
import { Accounts } from "../src/auth/accounts.js";

let app: Awaited<ReturnType<typeof buildApp>>["app"];
let p: Pool;
let auth: Record<string, string>;

before(async () => {
  p = db();
  await migrate(p);
  ({ app } = await buildApp());
  const a = new Accounts(p);
  const s = await a.register(`client-err-${process.pid}@invalid.test`, "a-long-enough-password", "probe");
  auth = { authorization: `Bearer ${s.token}` };
});

after(async () => {
  await app?.close().catch(() => {});
  await closeDb();
});

const post = (payload: Record<string, unknown>, headers: Record<string, string> = auth) =>
  app.inject({
    method: "POST",
    url: "/api/client-error",
    headers: { ...headers, "content-type": "application/json" },
    payload,
  }) as unknown as Promise<{ statusCode: number; json: () => { error: string } }>;

const events = async (kind: string) =>
  (
    await p.query<{ detail: Record<string, unknown> }>(
      "SELECT detail FROM session_events WHERE kind = $1 ORDER BY seq DESC LIMIT 1",
      [kind],
    )
  ).rows[0];

describe("a browser saying it broke", () => {
  test("a panel failure reaches session_events, beside the backend's own failures", async () => {
    const r = await post({
      kind: "panel",
      where: "Buyer chat",
      route: "/console",
      err: "Cannot read properties of null (reading 'toFixed')",
      build: "20260929T0400",
    });
    assert.equal(r.statusCode, 200);
    const e = await events("client.panel");
    assert.ok(e, "nothing was recorded");
    assert.equal(e.detail["where"], "Buyer chat");
    assert.equal(e.detail["route"], "/console");
    assert.match(String(e.detail["err"]), /toFixed/);
    // Which bundle the browser was running: a seller on a stale tab is a
    // different report from a seller on the current one.
    assert.equal(e.detail["build"], "20260929T0400");
  });

  test("a kind nobody defined is refused, rather than letting a client invent a taxonomy", async () => {
    const r = await post({ kind: "whatever-the-frontend-felt-like", err: "x" });
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /kind must be one of/);
  });

  test("only the four named fields are stored, whatever else is posted", async () => {
    // `session_events.detail` is contracted to counts and identifiers. A browser
    // must not be able to post arbitrary JSON into it.
    await post({
      kind: "route",
      where: "w",
      route: "/r",
      err: "e",
      build: "b",
      token: "sst_do_not_store_me",
      chat: "a buyer's actual message",
      nested: { deep: true },
    });
    const e = await events("client.route");
    assert.deepEqual(Object.keys(e!.detail).sort(), ["build", "err", "route", "where"]);
    assert.ok(!JSON.stringify(e!.detail).includes("sst_do_not_store_me"));
    assert.ok(!JSON.stringify(e!.detail).includes("a buyer's actual message"));
  });

  test("every field is bounded, so one report cannot be a payload", async () => {
    await post({ kind: "unhandled", where: "w".repeat(500), route: "/r".repeat(500), err: "e".repeat(5000), build: "b".repeat(500) });
    const e = await events("client.unhandled");
    assert.equal(String(e!.detail["where"]).length, 60);
    assert.equal(String(e!.detail["route"]).length, 120);
    assert.equal(String(e!.detail["err"]).length, 300);
    assert.equal(String(e!.detail["build"]).length, 40);
  });

  test("control characters do not survive, because a log line is structured", async () => {
    await post({ kind: "rejection", where: "a\nb", route: "/x\ty", err: "boom\r\nfake: line", build: "b" });
    const e = await events("client.rejection");
    for (const k of ["where", "route", "err"]) {
      assert.ok(!/[\u0000-\u001f\u007f]/.test(String(e!.detail[k])), `${k} kept a control character`);
    }
  });

  test("a signed-out browser cannot write to our log", async () => {
    const r = await post({ kind: "panel", err: "x" }, {});
    assert.equal(r.statusCode, 401);
  });
});
