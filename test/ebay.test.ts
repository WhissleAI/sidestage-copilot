// The eBay client, without a network.
//
// Every assertion here is about a decision the client makes on our behalf —
// caching a token, sharing one mint between concurrent callers, and refusing to
// dress a 403 up as a transient failure. The network calls themselves are
// eBay's business and are verified by `GET /api/ebay/status` against the real
// sandbox, not by a mock that would only ever confirm the mock.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { EbayClient, EbayError } from "../src/ingest/ebay/client.js";

const CREDS = {
  env: "sandbox",
  appId: "app",
  certId: "cert",
  devId: "dev",
  marketplaceId: "EBAY_US",
  ruName: "",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("the eBay application client", () => {
  test("mints one token and reuses it", async () => {
    let mints = 0;
    const client = new EbayClient(CREDS, (async (url: string | URL | Request) => {
      if (String(url).includes("/identity/v1/oauth2/token")) {
        mints++;
        return jsonResponse({ access_token: "tok", expires_in: 7200 });
      }
      return jsonResponse({ itemSummaries: [] });
    }) as typeof fetch);

    await client.search("a");
    await client.search("b");
    await client.search("c");
    assert.equal(mints, 1, "re-authenticated on every call");
  });

  test("concurrent callers share one mint rather than racing", async () => {
    // A live show asks several questions a second. Three drafts starting
    // together must not each open their own token request.
    let mints = 0;
    const client = new EbayClient(CREDS, (async (url: string | URL | Request) => {
      if (String(url).includes("/oauth2/token")) {
        mints++;
        await new Promise((r) => setTimeout(r, 20));
        return jsonResponse({ access_token: "tok", expires_in: 7200 });
      }
      return jsonResponse({ itemSummaries: [] });
    }) as typeof fetch);

    await Promise.all([client.search("a"), client.search("b"), client.search("c")]);
    assert.equal(mints, 1);
  });

  test("the token asks for every scope the calls need, not just the base one", async () => {
    // The bug this locks down: a client-credentials token only carries the
    // scopes you request, and asking for `api_scope` alone made the sold-price
    // API answer 403 — which we read as "not entitled" and wrote into the docs.
    let body = "";
    const client = new EbayClient(CREDS, (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("/oauth2/token")) {
        body = String(init?.body ?? "");
        return jsonResponse({ access_token: "tok", expires_in: 7200 });
      }
      return jsonResponse({ itemSales: [] });
    }) as typeof fetch);

    await client.soldComps("jordan");
    assert.match(decodeURIComponent(body), /buy\.marketplace\.insights/);
  });

  test("a sale carries what it sold for AND when — that is what makes it a sale", async () => {
    const client = new EbayClient(CREDS, (async (url: string | URL | Request) => {
      if (String(url).includes("/oauth2/token")) return jsonResponse({ access_token: "t", expires_in: 7200 });
      return jsonResponse({
        itemSales: [
          {
            itemId: "v1|1|1", title: "Air Jordan 1 Chicago",
            lastSoldPrice: { value: "389.50", currency: "USD" },
            lastSoldDate: "2026-08-30T00:00:00.000Z", condition: "Pre-owned",
          },
          { itemId: "v1|2|2", title: "no price" },
        ],
      });
    }) as typeof fetch);

    const rows = await client.soldComps("jordan");
    assert.equal(rows.length, 1, "a sale with no price was kept");
    assert.equal(rows[0]!.priceCents, 38950);
    assert.equal(rows[0]!.soldAt, "2026-08-30T00:00:00.000Z");
  });

  test("a 403 is permanent — an entitlement we do not hold, not a blip", async () => {
    // Still true for anything the application genuinely is not approved for.
    // Retrying that on every show is spend with a known answer.
    const client = new EbayClient(CREDS, (async (url: string | URL | Request) => {
      if (String(url).includes("/oauth2/token")) return jsonResponse({ access_token: "t", expires_in: 7200 });
      return new Response("Insufficient permissions", { status: 403 });
    }) as typeof fetch);

    await assert.rejects(
      () => client.search("jordan"),
      (e: unknown) => e instanceof EbayError && e.permanent && e.status === 403,
    );
  });

  test("a rejected token names the environment, because eBay will not", async () => {
    // A sandbox key against the production host is a 400 whose message never
    // mentions either. That cost an afternoon once.
    const client = new EbayClient(CREDS, (async () =>
      jsonResponse({ error: "invalid_client" }, 400)) as typeof fetch);

    await assert.rejects(
      () => client.appToken(),
      (e: unknown) => e instanceof EbayError && /sandbox/.test((e as Error).message),
    );
  });

  test("a filter eBay silently dropped is a failure, not a result", async () => {
    // The worst bug found in this integration. Ask for one seller's listings
    // with a handle eBay does not recognise and it answers 200, drops the
    // filter, and returns the whole market — with the reason in `warnings`,
    // which nothing was reading. A show was prepared from that: 53 pitching
    // mounds and watch straps, attributed to a vintage card seller, uploaded
    // into an agent's knowledge base for it to cite.
    const client = new EbayClient(CREDS, (async (url: string | URL | Request) => {
      if (String(url).includes("/oauth2/token")) return jsonResponse({ access_token: "t", expires_in: 7200 });
      return jsonResponse({
        warnings: [
          { errorId: 12003, message: "A seller 'username' provided in the request filters is invalid." },
        ],
        itemSummaries: [
          { itemId: "1", title: "somebody else's stock", price: { value: "209.99" } },
        ],
      });
    }) as typeof fetch);

    await assert.rejects(
      () => client.search("baseball", { sellers: ["not-a-real-username"] }),
      (e: unknown) => e instanceof EbayError && /ignored a request filter/.test((e as Error).message),
    );
  });

  test("a summary with no price is not a comparable anything", async () => {
    const client = new EbayClient(CREDS, (async (url: string | URL | Request) => {
      if (String(url).includes("/oauth2/token")) return jsonResponse({ access_token: "t", expires_in: 7200 });
      return jsonResponse({
        itemSummaries: [
          { itemId: "1", title: "priced", price: { value: "412.00", currency: "USD" } },
          { itemId: "2", title: "no price at all" },
        ],
      });
    }) as typeof fetch);

    const rows = await client.search("jordan");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.priceCents, 41200, "dollars did not become cents");
  });

  test("with no application configured, nothing pretends to work", async () => {
    const client = new EbayClient({ ...CREDS, appId: "", certId: "" });
    assert.equal(client.configured, false);
    const status = await client.check();
    assert.equal(status.token, false);
    assert.equal(status.browse, false);
    assert.equal(status.soldComps, false);
  });
});

// ── the importer ────────────────────────────────────────────────────────────

import { importSellerListings } from "../src/ingest/ebay/import.js";
import { EbayMarketplace } from "../src/actions/marketplace/ebay.js";
import { MarketplaceConflict } from "../src/actions/marketplace/port.js";
import { readFileSync } from "node:fs";

describe("importing a seller's listings", () => {
  const inventory = {
    inventoryItems: [
      {
        sku: "AJ1-CHI",
        condition: "NEW",
        availability: { shipToLocationAvailability: { quantity: 2 } },
        product: {
          title: "Air Jordan 1 Retro High OG Chicago",
          aspects: { Brand: ["Jordan"], "US Shoe Size": ["10"], Color: ["Red/White"] },
        },
      },
      {
        sku: "NO-OFFER",
        product: { title: "Drafted, never listed" },
      },
      { sku: "NO-TITLE", product: {} },
    ],
  };
  const offers = {
    offers: [
      { sku: "AJ1-CHI", offerId: "of_1", status: "PUBLISHED", pricingSummary: { price: { value: "412.00" } } },
      { sku: "NO-TITLE", offerId: "of_3", status: "PUBLISHED", pricingSummary: { price: { value: "10.00" } } },
    ],
  };

  const fetcher = (async (url: string | URL | Request) => {
    const u = String(url);
    const body = u.includes("/inventory_item") ? inventory : u.includes("/offer") ? offers : {};
    // Page once: the importer pages until a short batch comes back.
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  test("maps eBay's aspects onto the fields a reply can cite", async () => {
    // Writes into the suite's own catalogs copy (see scripts/ensure-test-db),
    // and the assertions read the file the importer actually produced.
    const result = await importSellerListings({
      token: "t", env: "sandbox", catalogId: "probe", limit: 50, fetcher,
    });
    const written = JSON.parse(readFileSync(result.path, "utf8")) as {
      items: { sku: string; brand?: string; size?: string; colorway?: string; priceCents: number; qty: number }[];
      policies: unknown[];
    };
    const item = written.items.find((i) => i.sku === "AJ1-CHI")!;
    assert.equal(item.brand, "Jordan");
    assert.equal(item.size, "10");
    assert.equal(item.colorway, "Red/White");
    assert.equal(item.priceCents, 41200, "dollars did not become cents");
    assert.equal(item.qty, 2);
  });

  test("a listing with no price is skipped WITH a reason, not dropped", async () => {
    // Inventing a price is the single worst thing this product could do, and a
    // catalog that came back short without saying why is how it would happen.
    const result = await importSellerListings({
      token: "t", env: "sandbox", catalogId: "probe2", limit: 50, fetcher,
    });
    const skipped = result.skipped.find((s) => s.sku === "NO-OFFER");
    assert.ok(skipped, "an unlisted item was silently dropped");
    assert.match(skipped.why, /no offer|no price/);
    assert.ok(!result.skipped.some((s) => s.sku === "AJ1-CHI"));
  });

  test("policies do not come across, because eBay has none to give", async () => {
    // eBay's business policies are account settings, not the clause text a
    // reply can cite. Importing an empty list keeps readiness honest about it.
    const result = await importSellerListings({
      token: "t", env: "sandbox", catalogId: "probe3", limit: 50, fetcher,
    });
    const written = JSON.parse(readFileSync(result.path, "utf8")) as { policies: unknown[] };
    assert.deepEqual(written.policies, []);
  });
});

describe("writing to eBay", () => {
  const local = async () => ({
    id: "lst_1", sku: "AJ1-CHI", priceCents: 41200, qty: 2,
    version: 3, state: "live" as const, pinned: true,
  });
  const offerBody = (value: string, qty = 2) => ({
    offers: [
      { sku: "AJ1-CHI", offerId: "of_1", status: "PUBLISHED", availableQuantity: qty, pricingSummary: { price: { value } } },
    ],
  });

  test("refuses when the remote has moved under the plan", async () => {
    // The seller changed the price in eBay's own UI thirty seconds ago. The
    // markdown the copilot planned is against a number that no longer exists.
    const market = new EbayMarketplace(
      local,
      async () => "tok",
      "sandbox",
      (async () =>
        new Response(JSON.stringify(offerBody("399.00")), {
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    );
    await assert.rejects(
      () =>
        market.reserve({
          kind: "markdown_price", listingId: "lst_1", expectedVersion: 3,
          params: { priceCents: 38000 }, idempotencyKey: "k1",
        }),
      (e: unknown) => e instanceof MarketplaceConflict,
    );
  });

  test("ending a listing withdraws it — never deletes it", async () => {
    // The undo window promises a committed action is reversible for 90 seconds.
    // A deleted offer is not, so withdraw is the only correct verb here.
    const calls: string[] = [];
    const market = new EbayMarketplace(
      local,
      async () => "tok",
      "sandbox",
      (async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        calls.push(`${init?.method ?? "GET"} ${u.replace(/^https:\/\/[^/]+/, "")}`);
        return new Response(JSON.stringify(offerBody("412.00")), {
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    );
    const res = await market.reserve({
      kind: "end_listing", listingId: "lst_1", expectedVersion: 3, params: {}, idempotencyKey: "k2",
    });
    await market.apply(res);
    assert.ok(calls.some((c) => c.includes("/withdraw")), "did not withdraw");
    assert.ok(!calls.some((c) => c.includes("DELETE")), "deleted an offer");
  });

  test("a seller with no connection gets a sentence, not an auth dump", async () => {
    const market = new EbayMarketplace(local, async () => null, "sandbox");
    await assert.rejects(
      () => market.get("lst_1"),
      (e: unknown) => /connect one in Settings/.test((e as Error).message),
    );
  });
});
