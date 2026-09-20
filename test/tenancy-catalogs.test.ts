/**
 * A catalog belongs to an account, and there is exactly one door to it.
 *
 * Catalogs are the one resource here with no owner column — they are files in
 * a shared directory, and ownership is read off the shape of the file name.
 * That rule lives in `visibleCatalogs`/`catalogFor`, and three of the six
 * catalog-touching routes did not call it:
 *
 *   ACCESS-02  POST /api/catalogs/:id/qa      wrote straight to <id>.json
 *   ACCESS-04  POST /api/ebay/import          replaced whatever id the body named
 *   ACCESS-05  POST /api/shows/attach         pointed a show at any catalog,
 *              POST /api/shows/:id/catalog/apply   and then read it back
 *
 * The ids to aim at are public: `GET /api/shows/prepared` is deliberately
 * unscoped. So every one of these is written from the SECOND seller's side,
 * and the ones that write also assert the bytes on disk did not move.
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";

// Its own catalogs directory: this suite WRITES catalogs, and the shared one
// is read by every other suite in the same run.
const DIR = resolve(".tmp/test-catalogs-tenancy");
process.env.CATALOGS_DIR = DIR;
mkdirSync(DIR, { recursive: true });

const { buildApp } = await import("../src/api/server.js");
type AppContext = Awaited<ReturnType<typeof buildApp>>["ctx"];

let app: FastifyInstance;
let ctx: AppContext;
const json = { "content-type": "application/json" };

const register = async (tag: string) => {
  const email = `${tag}-${Date.now()}-${Math.random().toString(16).slice(2)}@test.local`;
  const r = (
    await app.inject({
      method: "POST", url: "/api/auth/register", headers: json,
      payload: { email, password: "password-123", displayName: tag },
    })
  ).json() as { token: string; account: { id: string; handle: string } };
  return { headers: { authorization: `Bearer ${r.token}` }, id: r.account.id, handle: r.account.handle };
};

/** A catalog file of the shape an eBay import leaves behind. */
const writeCatalog = (id: string, handle: string) => {
  writeFileSync(
    join(DIR, `${id}.json`),
    JSON.stringify({
      id,
      name: `${handle}'s inventory`,
      seller: { handle, name: handle, about: "", voice: "" },
      policies: [],
      items: [{ sku: `${handle}-1`, title: "A jersey", priceCents: 12_000, qty: 1 }],
    }),
  );
};
const onDisk = (id: string) => JSON.parse(readFileSync(join(DIR, `${id}.json`), "utf8")) as { qa?: unknown[] };

let A: Awaited<ReturnType<typeof register>>;
let B: Awaited<ReturnType<typeof register>>;
let aCat: string;
let bCat: string;
let aShow: string;

before(async () => {
  ({ app, ctx } = await buildApp());
  A = await register("cata");
  B = await register("catb");
  aCat = `ebay-${A.handle}`;
  bCat = `ebay-${B.handle}`;
  writeCatalog(aCat, A.handle);
  writeCatalog(bCat, B.handle);
  await app.inject({ method: "POST", url: "/api/catalogs/reload", headers: A.headers });
  const rt = await ctx.shows.attach(`sim:c${Math.random().toString(36).slice(2, 10)}`, {
    ownerAccountId: A.id, title: "A's show",
  });
  aShow = rt.showId;
});

after(async () => {
  await ctx.shows.detach(aShow).catch(() => {});
  await app.close();
  await ctx.stop();
  rmSync(DIR, { recursive: true, force: true });
});

describe("writing a catalog", () => {
  test("its owner can still close a gap in it", async () => {
    const r = await app.inject({
      method: "POST", url: `/api/catalogs/${aCat}/qa`, headers: { ...A.headers, ...json },
      payload: { question: "Does it ship next day?", answer: "Yes, first class." },
    });
    assert.equal(r.statusCode, 200, r.body.slice(0, 200));
    assert.equal(onDisk(aCat).qa?.length, 1);
  });

  test("a second seller cannot write Q&A into it, by id", async () => {
    const r = await app.inject({
      method: "POST", url: `/api/catalogs/${aCat}/qa`, headers: { ...B.headers, ...json },
      payload: { question: "Is it authentic?", answer: "Guaranteed 100% authentic, no papers needed." },
    });
    assert.equal(r.statusCode, 404, `stranger got ${r.statusCode}: ${r.body.slice(0, 200)}`);
    // The fact, not just the status: an answer that landed would be cited to a
    // real buyer with A's account recorded as its source.
    const qa = onDisk(aCat).qa ?? [];
    assert.equal(qa.length, 1, "a stranger's answer reached A's corpus");
    assert.doesNotMatch(JSON.stringify(qa), /authentic/i);
  });

  test("an id that is a path is not an id", async () => {
    const outside = resolve(DIR, "..", "escaped.json");
    rmSync(outside, { force: true });
    for (const id of ["..%2F..%2Fescaped", "..%2Fescaped", "....%2F%2Fescaped"]) {
      const r = await app.inject({
        method: "POST", url: `/api/catalogs/${id}/qa`, headers: { ...B.headers, ...json },
        payload: { question: "q", answer: "a" },
      });
      assert.equal(r.statusCode, 404, `${id} → ${r.statusCode}`);
    }
    assert.equal(existsSync(outside), false, "a catalog id walked out of the catalogs directory");
  });
});

describe("importing over a catalog", () => {
  test("a second seller cannot aim an import at it", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/ebay/import", headers: { ...B.headers, ...json },
      payload: { catalogId: aCat },
    });
    assert.equal(r.statusCode, 400, `import at another account's catalog → ${r.statusCode}`);
    assert.match(r.json().error, /your own catalog/);
    assert.equal(onDisk(aCat).qa?.length, 1, "A's catalog was replaced");
  });

  test("and cannot aim one outside the catalogs directory", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/ebay/import", headers: { ...B.headers, ...json },
      payload: { catalogId: "../../data/whatever" },
    });
    assert.equal(r.statusCode, 400);
  });
});

describe("pointing a show at a catalog", () => {
  test("a seller cannot apply another account's catalog to their own show", async () => {
    const r = await app.inject({
      method: "POST", url: `/api/shows/${aShow}/catalog/apply`, headers: { ...A.headers, ...json },
      payload: { catalogId: bCat },
    });
    assert.equal(r.statusCode, 400, `applied a stranger's catalog: ${r.body.slice(0, 200)}`);
    // Which is the read the audit is about: with B's catalog applied, A reads
    // B's items, SKUs and prices straight out of /api/listings.
    const listings = await app.inject({ method: "GET", url: "/api/listings", headers: A.headers });
    assert.doesNotMatch(listings.body, new RegExp(B.handle), "B's inventory is readable from A's show");
  });

  test("their own catalog still applies", async () => {
    const r = await app.inject({
      method: "POST", url: `/api/shows/${aShow}/catalog/apply`, headers: { ...A.headers, ...json },
      payload: { catalogId: aCat },
    });
    assert.equal(r.statusCode, 200, r.body.slice(0, 300));
  });

  test("and attach refuses a catalog the caller cannot see", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/shows/attach", headers: { ...A.headers, ...json },
      payload: { url: "sim:notmine", catalogId: bCat },
    });
    assert.equal(r.statusCode, 400, `attach took a stranger's catalog: ${r.body.slice(0, 200)}`);
    assert.match(r.json().error, /unknown catalog/);
  });
});
