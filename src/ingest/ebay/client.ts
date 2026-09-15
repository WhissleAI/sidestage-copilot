// The eBay developer APIs, and an honest account of which of them we can reach.
//
// Until now every eBay fact in this product came from one of two places: the
// live-stream page, scraped (the lot card, the chat), or a fixture (the comps).
// A developer application unlocks a third: the public read APIs, with real
// catalog structure and real listings behind them.
//
// What an APPLICATION token reaches — the client-credentials grant these three
// values can mint:
//
//   Browse                 active listings: title, price, condition, category.
//   Taxonomy               the category tree and the aspects eBay expects.
//   Marketplace Insights   SOLD prices — what things actually went for.
//
// That last one was recorded here as unavailable, on the strength of a 403. The
// 403 was ours: a client-credentials token only carries the scopes you ask for,
// and we were asking for `api_scope` alone. The application is approved for
// `buy.marketplace.insights`; requesting it returns 200. The lesson is worth
// keeping — an API that answers 403 because of how WE asked looks exactly like
// one we are not entitled to, and we documented the wrong conclusion for a day.
//
// Sold and asking remain different claims and are never conflated: "median
// SOLD" and "median ASKING" price a lot differently, and a card that says the
// first while showing the second is the confident wrongness the guardrails
// exist to prevent. Sandbox carries no sales history, so sold lookups there
// return nothing and the asking-price path still does the work.
//
// What an application token still does NOT reach:
//
//   Sell APIs (Inventory, Account, Fulfillment)   a seller's own listings.
//                          These need a USER token from the authorisation-code
//                          grant: a person signs in and consents in a browser,
//                          against a redirect URI registered on the app. There
//                          is no way to mint one from an app key alone.
//
//   eBay Live              no public API at all, in any tier. Discovery and the
//                          show watcher stay where they are.

import { config } from "../../config.js";

const HOST = {
  sandbox: { api: "https://api.sandbox.ebay.com", auth: "https://auth.sandbox.ebay.com" },
  production: { api: "https://api.ebay.com", auth: "https://auth.ebay.com" },
} as const;

/**
 * Every scope this application is granted for client credentials AND uses.
 *
 * One token carries all of them — verified against the sandbox rather than
 * assumed, because a token minted without a scope fails the call with a 403
 * that reads like a missing entitlement.
 */
const APP_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/buy.marketplace.insights",
];
/** What a keyset always has. Marketplace Insights is limited-release: the
 *  sandbox keyset carries it, the production keyset does not until eBay grants
 *  it on application. Asking for it on a keyset without it fails the WHOLE
 *  token with `invalid_scope`, taking Browse and Taxonomy down with it — so the
 *  request narrows to this and sold comps degrade by name instead. */
const BASE_SCOPES = [APP_SCOPES[0]];

export interface EbayListing {
  itemId: string;
  title: string;
  /** Cents, so it lines up with every other price in this codebase. */
  priceCents: number;
  currency: string;
  condition: string | null;
  categoryId: string | null;
  categoryName: string | null;
  sellerFeedback: number | null;
  imageUrl: string | null;
  itemWebUrl: string | null;
}

/** One completed sale. `soldAt` is what separates this from a listing. */
export interface EbaySale {
  itemId: string;
  title: string;
  priceCents: number;
  currency: string;
  condition: string | null;
  soldAt: string;
  itemWebUrl: string | null;
}

/** eBay reports a partly-honoured request here, with a 200. */
interface EbayWarning {
  errorId?: number;
  message?: string;
  category?: string;
}

export interface EbayAspect {
  name: string;
  required: boolean;
  values: string[];
}

export class EbayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** True when the call was refused for want of an approval or a user token —
     *  a fact about the application, not a transient failure to retry. */
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = "EbayError";
  }
}

type Fetcher = typeof fetch;

export class EbayClient {
  private token: { value: string; expiresAt: number } | null = null;
  private inFlight: Promise<string> | null = null;
  /** Scopes the application token is minted with; narrows once if the keyset lacks an optional one. */
  private scopes: string[] = APP_SCOPES;

  constructor(
    private readonly creds = config.ebay,
    /** Injected so the suite can exercise this without a network. */
    private readonly fetcher: Fetcher = fetch,
  ) {}

  get configured(): boolean {
    return Boolean(this.creds.appId && this.creds.certId);
  }

  get env(): "sandbox" | "production" {
    return this.creds.env as "sandbox" | "production";
  }

  private get hosts() {
    return HOST[this.env];
  }

  /**
   * An application token, cached until shortly before it expires.
   *
   * eBay issues these for two hours and rate-limits the mint. Concurrent
   * callers share one request rather than each starting their own — a live show
   * asks several questions a second and would otherwise spend its budget
   * re-authenticating.
   */
  async appToken(): Promise<string> {
    if (!this.configured) {
      throw new EbayError("no eBay application is configured (EBAY_APP_ID / EBAY_CERT_ID)", 0, true);
    }
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;
    if (this.inFlight) return this.inFlight;

    const basic = Buffer.from(`${this.creds.appId}:${this.creds.certId}`).toString("base64");
    this.inFlight = (async () => {
      const mint = (scopes: string[]) =>
        this.fetcher(`${this.hosts.api}/identity/v1/oauth2/token`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${basic}`,
          },
          body: `grant_type=client_credentials&scope=${encodeURIComponent(scopes.join(" "))}`,
        });
      type TokenBody = { access_token?: string; expires_in?: number; error_description?: string; error?: string };
      let res = await mint(this.scopes);
      let body = (await res.json().catch(() => ({}))) as TokenBody;
      if (body.error === "invalid_scope" && this.scopes.length > BASE_SCOPES.length) {
        // The keyset lacks an optional scope (Marketplace Insights, in
        // production). Narrow once and remember it; the sold-comps call then
        // fails on its own, and the status page says which capability is gone.
        this.scopes = BASE_SCOPES;
        res = await mint(this.scopes);
        body = (await res.json().catch(() => ({}))) as TokenBody;
      }
      if (!res.ok || !body.access_token) {
        // 400 here is nearly always the wrong environment: a sandbox key sent
        // to the production host, or the reverse. Say so, because eBay will not.
        const said = body.error_description || body.error || `${res.status}`;
        throw new EbayError(
          `eBay refused the ${this.env} application token — ${said}`,
          res.status,
          res.status === 401 || res.status === 400,
        );
      }
      // Renew a minute early rather than discovering expiry mid-reply.
      const ttl = Math.max(60, (body.expires_in ?? 7200) - 60) * 1000;
      this.token = { value: body.access_token, expiresAt: Date.now() + ttl };
      return body.access_token;
    })().finally(() => {
      this.inFlight = null;
    });

    return this.inFlight;
  }

  private async get<T>(path: string): Promise<T> {
    const token = await this.appToken();
    const res = await this.fetcher(`${this.hosts.api}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": this.creds.marketplaceId,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new EbayError(
        `eBay ${path.split("?")[0]} answered ${res.status}${text ? ` — ${text.slice(0, 200)}` : ""}`,
        res.status,
        // 403 on a read is an approval the application does not hold. Retrying
        // it on every show is spend with a known answer.
        res.status === 403 || res.status === 401,
      );
    }
    return (await res.json()) as T;
  }

  /**
   * Active listings matching a query.
   *
   * ACTIVE, not sold — see the header. The caller decides what to claim about
   * them; this returns what eBay actually said.
   */
  async search(
    q: string,
    opts: { limit?: number; categoryId?: string; sellers?: string[] } = {},
  ): Promise<EbayListing[]> {
    const params = new URLSearchParams({
      q: q.slice(0, 350),
      limit: String(Math.min(50, Math.max(1, opts.limit ?? 10))),
    });
    if (opts.categoryId) params.set("category_ids", opts.categoryId);
    // A seller filter is what turns "the market" into "this seller's lineup" —
    // it is the whole reason a show can be prepared from its host's handle.
    // Browse rejects it without a keyword, so it is always paired with `q`.
    if (opts.sellers?.length) {
      params.set("filter", `sellers:{${opts.sellers.map((x) => x.replace(/^@/, "")).join("|")}}`);
    }

    const body = await this.get<{ itemSummaries?: RawSummary[]; warnings?: EbayWarning[] }>(
      `/buy/browse/v1/item_summary/search?${params.toString()}`,
    );

    // eBay answers 200 for a request it only PARTLY honoured, and says which
    // part in `warnings`. The case that matters: an unrecognised seller filter
    // is dropped and the search runs unfiltered — so asking for one seller's
    // listings returns the whole market, with a 200, and nothing about the rows
    // says they are not that seller's. A catalog built from that is a stranger's
    // inventory attributed to the host of the show, which the agent would then
    // cite. A rejected filter is a failed call.
    const rejected = (body.warnings ?? []).find((w) => /filter/i.test(w.message ?? ""));
    if (rejected) {
      throw new EbayError(
        `eBay ignored a request filter and searched without it — ${rejected.message}`,
        200,
        true,
      );
    }

    return (body.itemSummaries ?? []).map(toListing).filter((l): l is EbayListing => l !== null);
  }

  /**
   * What things ACTUALLY SOLD for, over the last 90 days.
   *
   * The number a seller should price against, and a different claim from the
   * asking prices `search()` returns. Returns an empty array rather than
   * throwing when there is no sales history — sandbox has none at all, and "we
   * looked and found nothing" is a finding the caller reports as such.
   */
  async soldComps(q: string, opts: { limit?: number } = {}): Promise<EbaySale[]> {
    const params = new URLSearchParams({
      q: q.slice(0, 350),
      limit: String(Math.min(50, Math.max(1, opts.limit ?? 12))),
    });
    const body = await this.get<{ itemSales?: RawSale[] }>(
      `/buy/marketplace_insights/v1_beta/item_sales/search?${params.toString()}`,
    );
    return (body.itemSales ?? []).map(toSale).filter((s): s is EbaySale => s !== null);
  }

  /** The first of these sold-comp queries that finds anything, narrow to broad. */
  async soldWidening(
    queries: string[],
    opts: { limit?: number } = {},
  ): Promise<{ query: string; rows: EbaySale[] }> {
    const tried = queries.filter((q, i, all) => Boolean(q?.trim()) && all.indexOf(q) === i);
    for (const q of tried) {
      const rows = await this.soldComps(q, opts);
      if (rows.length) return { query: q, rows };
    }
    return { query: tried[tried.length - 1] ?? "", rows: [] };
  }

  /**
   * The first of these queries that finds anything, tried narrow to broad.
   *
   * A catalog title is written for a human — "Air Jordan 1 Retro High OG
   * Chicago Reimagined" — and matches zero listings, while "Air Jordan 1"
   * matches the market the lot actually lives in. Sequential on purpose: the
   * narrow query is the right answer when it works, and firing all of them at
   * once spends three calls to use one.
   */
  async searchWidening(
    queries: string[],
    opts: { limit?: number } = {},
  ): Promise<{ query: string; rows: EbayListing[] }> {
    const tried = queries.filter((q, i, all) => Boolean(q?.trim()) && all.indexOf(q) === i);
    for (const q of tried) {
      const rows = await this.search(q, opts);
      if (rows.length) return { query: q, rows };
    }
    return { query: tried[tried.length - 1] ?? "", rows: [] };
  }

  /** The marketplace's category tree id — needed by every taxonomy call. */
  async categoryTreeId(): Promise<string> {
    const body = await this.get<{ categoryTreeId: string }>(
      `/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${this.creds.marketplaceId}`,
    );
    return body.categoryTreeId;
  }

  /**
   * What eBay expects a listing in this category to carry.
   *
   * This is the useful half of taxonomy for a catalog: it is the difference
   * between "your listing is missing something" and "your listing is missing
   * Size, Colorway and Style Code, and buyers filter on all three".
   */
  async aspectsFor(categoryId: string, treeId?: string): Promise<EbayAspect[]> {
    const tree = treeId ?? (await this.categoryTreeId());
    const body = await this.get<{
      aspects?: {
        localizedAspectName: string;
        aspectConstraint?: { aspectRequired?: boolean };
        aspectValues?: { localizedValue: string }[];
      }[];
    }>(
      `/commerce/taxonomy/v1/category_tree/${encodeURIComponent(tree)}/get_item_aspects_for_category?category_id=${encodeURIComponent(categoryId)}`,
    );
    return (body.aspects ?? []).map((a) => ({
      name: a.localizedAspectName,
      required: Boolean(a.aspectConstraint?.aspectRequired),
      values: (a.aspectValues ?? []).map((v) => v.localizedValue).slice(0, 25),
    }));
  }

  /** One call, so a status route can say whether this actually works. */
  async check(): Promise<{
    configured: boolean;
    env: string;
    marketplaceId: string;
    token: boolean;
    browse: boolean;
    taxonomy: boolean;
    /** Whether the SOLD-price API answers us. Probed, not assumed either way —
     *  we once recorded it as permanently unavailable on the strength of a 403
     *  that was caused by the scope we asked for. */
    soldComps: boolean;
    error: string | null;
  }> {
    const base = {
      configured: this.configured,
      env: this.env,
      marketplaceId: this.creds.marketplaceId,
    };
    if (!this.configured) {
      return {
        ...base, token: false, browse: false, taxonomy: false, soldComps: false,
        error: "no application configured",
      };
    }
    try {
      await this.appToken();
    } catch (e) {
      return {
        ...base, token: false, browse: false, taxonomy: false, soldComps: false,
        error: (e as Error).message,
      };
    }
    const [browse, taxonomy, soldComps] = await Promise.all([
      this.search("test", { limit: 1 }).then(() => true).catch(() => false),
      this.categoryTreeId().then(() => true).catch(() => false),
      // Reachability, not data: an empty result from a 200 still means the
      // entitlement is there, and sandbox has no sales history at all.
      this.soldComps("test", { limit: 1 }).then(() => true).catch(() => false),
    ]);
    return { ...base, token: true, browse, taxonomy, soldComps, error: null };
  }
}

interface RawSale {
  itemId?: string;
  title?: string;
  lastSoldPrice?: { value?: string; currency?: string };
  lastSoldDate?: string;
  condition?: string;
  itemWebUrl?: string;
}

function toSale(s: RawSale): EbaySale | null {
  const cents = Math.round(Number(s.lastSoldPrice?.value ?? NaN) * 100);
  if (!s.itemId || !s.title || !Number.isFinite(cents)) return null;
  return {
    itemId: s.itemId,
    title: s.title,
    priceCents: cents,
    currency: s.lastSoldPrice?.currency ?? "USD",
    condition: s.condition ?? null,
    soldAt: s.lastSoldDate ?? new Date().toISOString(),
    itemWebUrl: s.itemWebUrl ?? null,
  };
}

interface RawSummary {
  itemId?: string;
  title?: string;
  price?: { value?: string; currency?: string };
  condition?: string;
  leafCategoryIds?: string[];
  categories?: { categoryId?: string; categoryName?: string }[];
  seller?: { feedbackScore?: number };
  image?: { imageUrl?: string };
  itemWebUrl?: string;
}

function toListing(s: RawSummary): EbayListing | null {
  const cents = Math.round(Number(s.price?.value ?? NaN) * 100);
  // A summary with no price is not a comparable anything.
  if (!s.itemId || !s.title || !Number.isFinite(cents)) return null;
  return {
    itemId: s.itemId,
    title: s.title,
    priceCents: cents,
    currency: s.price?.currency ?? "USD",
    condition: s.condition ?? null,
    categoryId: s.leafCategoryIds?.[0] ?? s.categories?.[0]?.categoryId ?? null,
    categoryName: s.categories?.[0]?.categoryName ?? null,
    sellerFeedback: s.seller?.feedbackScore ?? null,
    imageUrl: s.image?.imageUrl ?? null,
    itemWebUrl: s.itemWebUrl ?? null,
  };
}

/** Process-wide, so the token cache is actually shared. */
export const ebay = new EbayClient();
