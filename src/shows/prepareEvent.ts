// Getting ready for a show before it starts.
//
// The copilot has only ever been useful once a show was already running: you
// paste a link, it attaches, and then it spends the opening minutes of the
// auction working out what is being sold. The expensive half of that does not
// need the show to be live. It needs two things the live grid already hands us
// — the seller's handle and eBay's own tags for the show — and one thing the
// Browse API hands us from those: the seller's actual listings.
//
// So this builds the catalog and stands up the agent ahead of time. Attaching
// afterwards is instant and grounded from the first question instead of the
// fiftieth.
//
// Three things it refuses to fake:
//
//   · A seller whose listings do not resolve gets a catalog with NO items and a
//     warning saying so. An empty catalog is honest; a catalog of plausible
//     sneakers we found by searching the show's title is not, and the copilot
//     would cite it.
//   · Policies are never invented. eBay exposes shipping and returns as account
//     settings, not as the clause text a reply can quote, so a prepared show
//     carries none and readiness reports their absence.
//   · Prices are marked INDICATIVE in the knowledge base, because they are —
//     they were read before the show and the live path supplies them fresh.

import type { Pool } from "../db/pg.js";
import { config } from "../config.js";
import { ebay } from "../ingest/ebay/client.js";
import { resolveSellerUsername, sellerListings } from "../ingest/ebaylive/sellerListings.js";
import { createStreamAgent, deleteStreamAgent } from "../llm/streamAgent.js";
import { addCatalogFile, removeCatalogFile, type Catalog } from "./catalogs.js";
import type { CatalogItem } from "./catalogImport.js";

export interface PreparedShow {
  eventId: string;
  title: string;
  host: string;
  sellerHandle: string | null;
  tags: string[];
  thumbnailUrl: string | null;
  catalogId: string | null;
  agentId: string | null;
  items: number;
  warnings: string[];
  preparedAt: string;
}

export interface PrepareInput {
  eventId: string;
  title: string;
  host?: string;
  sellerHandle?: string | null;
  tags?: string[];
  thumbnailUrl?: string | null;
  accountId?: string | null;
}

/** Enough to ground a show; not so many that the KB stops being searchable. */
const MAX_ITEMS = 80;

/**
 * What to ask Browse for.
 *
 * eBay's tags are the best pre-show signal there is — "$1 Starts", "Pokémon",
 * "Vintage" is a more accurate description of the lineup than the show's title,
 * which is written to be shouted. Tags that describe the FORMAT rather than the
 * goods are dropped: "$1 Starts" is a selling mechanic and matches nothing.
 */
const FORMAT_TAGS = /^(\$?\d+\s*starts?|auction|live|new seller spotlight|deals?)$/i;

function queriesFor(input: PrepareInput): string[] {
  const tags = (input.tags ?? []).filter((t) => t && !FORMAT_TAGS.test(t.trim()));
  if (tags.length) return tags.slice(0, 4);
  // No usable tag: fall back to the longest words in the title, which is weak
  // and is why the warning below says the catalog was built from the title.
  const words = input.title
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3);
  return words.slice(0, 3);
}

export class Preparer {
  constructor(private d: Pool) {}

  async list(accountId?: string | null): Promise<PreparedShow[]> {
    const { rows } = await this.d.query<{
      event_id: string; title: string; host: string; seller_handle: string | null;
      tags: string[]; thumbnail_url: string | null; catalog_id: string | null;
      agent_id: string | null; items: number; warnings: string[]; prepared_at: string;
    }>(
      accountId
        ? `SELECT * FROM prepared_shows WHERE account_id = $1 OR account_id IS NULL ORDER BY prepared_at DESC`
        : `SELECT * FROM prepared_shows ORDER BY prepared_at DESC`,
      accountId ? [accountId] : [],
    );
    return rows.map((r) => ({
      eventId: r.event_id,
      title: r.title,
      host: r.host,
      sellerHandle: r.seller_handle,
      tags: r.tags ?? [],
      thumbnailUrl: r.thumbnail_url,
      catalogId: r.catalog_id,
      agentId: r.agent_id,
      items: r.items,
      warnings: r.warnings ?? [],
      preparedAt: r.prepared_at,
    }));
  }

  async get(eventId: string): Promise<PreparedShow | null> {
    const all = await this.list();
    return all.find((p) => p.eventId === eventId) ?? null;
  }

  /**
   * Build the catalog and stand up the agent for one event.
   *
   * Sequential and slow by nature — several Browse calls and an agent creation.
   * The caller runs it in the background and polls; nothing waits on it.
   */
  async prepare(input: PrepareInput): Promise<PreparedShow> {
    const warnings: string[] = [];
    const catalogId = `ebay-${input.eventId}`;

    // ── the lineup ─────────────────────────────────────────────────────────
    const items: CatalogItem[] = [];
    if (!ebay.configured) {
      warnings.push("no eBay application configured — the catalog is empty");
    } else if (!input.sellerHandle) {
      warnings.push(
        "the live grid gave no seller handle for this show, so their listings could not be read",
      );
    } else {
      const seen = new Set<string>();
      const queries = queriesFor(input);
      if (!(input.tags ?? []).some((t) => !FORMAT_TAGS.test(t))) {
        warnings.push("no descriptive tags on this show — the catalog was built from its title");
      }

      // The handle on an eBay Live card is that seller's LIVE page slug, which
      // is not always their eBay username — and Browse only filters on the
      // username. A slug that does not resolve makes eBay drop the filter and
      // search the whole market, which the client now treats as a failure. One
      // probe decides it, rather than discovering it per query.
      // Two candidates for the eBay username. The card's DISPLAY name
      // ("pokesino777", "mvpv_0") is usually the username; the seller-page slug
      // ("hxvamauntf-") never is. Try the likely one first, and probe each,
      // because an unrecognised username makes eBay drop the filter and hand
      // back the whole market with a 200.
      // The account username, resolved from the seller's Live page, comes
      // first: it is the only name that is guaranteed to key their listings.
      // The display name is next (it often IS the username), the slug last.
      const resolved = input.sellerHandle
        ? await resolveSellerUsername(input.sellerHandle).catch(() => null)
        : null;
      const candidates = [resolved, input.host, input.sellerHandle].filter(
        (c, i, all): c is string => Boolean(c && c.trim()) && all.indexOf(c) === i,
      );
      let username: string | null = null;
      for (const c of candidates) {
        if (await sellerFilterWorks(c)) {
          username = c;
          break;
        }
      }
      const usable = username !== null;
      if (!usable) {
        // The API does not know this seller — always true with a sandbox key
        // and a real seller. The seller's public results page has no such
        // limit, and the signed-in session can read it. A catalog from there
        // says so, because it is a scrape and a scrape drifts.
        const fromPage = await sellerListings(candidates[0]!, MAX_ITEMS).catch((e: unknown) => {
          warnings.push(`could not read the seller's listings page: ${(e as Error).message}`);
          return [];
        });
        if (fromPage.length) {
          warnings.push(
            `built from ${candidates[0]}'s public listings page (${fromPage.length} items) — the ${config.ebay.env} API does not recognise them as a seller, so this is a page read, not an API read`,
          );
          for (const r of fromPage) {
            if (seen.has(r.itemId) || items.length >= MAX_ITEMS) continue;
            seen.add(r.itemId);
            items.push({
              sku: r.itemId,
              title: r.title,
              priceCents: r.priceCents,
              floorPriceCents: r.priceCents,
              qty: 1,
              state: "queued",
              condition: /new/i.test(r.condition ?? "") ? "DS" : "USED",
              ...(r.imageUrl ? { imageUrl: r.imageUrl } : {}),
              ...(r.itemWebUrl ? { url: r.itemWebUrl } : {}),
            });
          }
        } else {
          warnings.push(
            `eBay does not recognise ${candidates.map((c) => `"${c}"`).join(" or ")} as a seller username, and their listings page could not be read — the catalog is empty rather than full of somebody else's stock`,
          );
        }
      }

      for (const q of usable ? queries : []) {
        if (items.length >= MAX_ITEMS) break;
        // Seller-filtered: these are THIS seller's listings, not the market's.
        // Browse rejects a seller filter with no keyword, which is why the tag
        // list above matters.
        const rows = await ebay
          .search(q, { limit: 50, sellers: [username!] })
          .catch((e: unknown) => {
            warnings.push(`eBay refused "${q}": ${(e as Error).message}`);
            return [];
          });
        for (const r of rows) {
          if (seen.has(r.itemId) || items.length >= MAX_ITEMS) continue;
          seen.add(r.itemId);
          items.push({
            sku: r.itemId,
            title: r.title,
            priceCents: r.priceCents,
            // The seller's floor is theirs to set. Defaulting it to the list
            // price means no markdown passes preflight until they do, which is
            // the safe direction to be wrong in.
            floorPriceCents: r.priceCents,
            qty: 1,
            state: "queued",
            condition: /new/i.test(r.condition ?? "") ? "DS" : "USED",
            ...(r.imageUrl ? { imageUrl: r.imageUrl } : {}),
            ...(r.categoryName ? { model: r.categoryName } : {}),
          });
        }
      }
      if (items.length === 0 && warnings.length === 0) {
        warnings.push(
          `eBay returned no active listings for @${input.sellerHandle} matching this show's tags`,
        );
      }
    }

    const catalog: Catalog = {
      id: catalogId,
      name: `${input.title}`.slice(0, 120),
      seller: {
        handle: input.sellerHandle ? `@${input.sellerHandle}` : input.host || input.eventId,
        name: input.host || input.sellerHandle || "eBay Live seller",
        about: `Prepared from the eBay Live show "${input.title}".`,
        voice: "Answer the actual question first, then at most one detail.",
      },
      // Not invented. eBay's business policies are account settings, not the
      // clause text a reply can cite; readiness reports the absence.
      policies: [],
      items,
    };
    addCatalogFile(catalog);

    // ── the agent ──────────────────────────────────────────────────────────
    let agentId: string | null = null;
    // A re-prepare used to mint a second agent and forget the first; with a
    // fifty-agent workspace cap that is a leak with a deadline.
    const previous = await this.get(input.eventId).catch(() => null);
    if (previous?.agentId) await deleteStreamAgent(previous.agentId).catch(() => undefined);
    if (!config.whissle.apiKey) {
      warnings.push("no Whissle credentials — no agent was created");
    } else {
      try {
        agentId = await createStreamAgent({
          showId: `ebay_${input.eventId}`,
          showTitle: input.title,
          host: input.host || input.sellerHandle || "eBay Live seller",
          monitored: true,
        });
        await uploadCatalogKb(agentId, catalog);
      } catch (e) {
        warnings.push(`agent not created: ${(e as Error).message}`);
      }
    }

    await this.d.query(
      `INSERT INTO prepared_shows
         (event_id, account_id, title, host, seller_handle, tags, thumbnail_url,
          catalog_id, agent_id, items, warnings)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11::jsonb)
       ON CONFLICT (event_id) DO UPDATE SET
         title = EXCLUDED.title, host = EXCLUDED.host, seller_handle = EXCLUDED.seller_handle,
         tags = EXCLUDED.tags, thumbnail_url = EXCLUDED.thumbnail_url,
         catalog_id = EXCLUDED.catalog_id, agent_id = EXCLUDED.agent_id,
         items = EXCLUDED.items, warnings = EXCLUDED.warnings, prepared_at = now()`,
      [
        input.eventId, input.accountId ?? null, input.title, input.host ?? "",
        input.sellerHandle ?? null, JSON.stringify(input.tags ?? []),
        input.thumbnailUrl ?? null, catalogId, agentId, items.length,
        JSON.stringify(warnings),
      ],
    );

    return {
      eventId: input.eventId,
      title: input.title,
      host: input.host ?? "",
      sellerHandle: input.sellerHandle ?? null,
      tags: input.tags ?? [],
      thumbnailUrl: input.thumbnailUrl ?? null,
      catalogId,
      agentId,
      items: items.length,
      warnings,
      preparedAt: new Date().toISOString(),
    };
  }

  /**
   * Drop a prepared show — including its agent and its catalog file.
   *
   * Both were created by us for this event and nothing else uses them. Leaving
   * either behind is how an account accumulates agents nobody can account for.
   */
  async drop(eventId: string): Promise<{ agent: { ok: boolean; detail: string } | null }> {
    const row = await this.get(eventId);
    if (!row) return { agent: null };
    const agent = row.agentId ? await deleteStreamAgent(row.agentId) : null;
    if (row.catalogId) removeCatalogFile(row.catalogId);
    await this.d.query("DELETE FROM prepared_shows WHERE event_id = $1", [eventId]);
    return { agent };
  }
}

/**
 * The catalog, as a document the agent can search.
 *
 * Deliberately says prices are indicative. They were read before the show and
 * the live path supplies them fresh with every turn; an agent that answers a
 * price from this document is answering from a snapshot.
 */
async function uploadCatalogKb(agentId: string, c: Catalog): Promise<void> {
  const lines = [
    `# ${c.name}`,
    "",
    `Seller: ${c.seller.name} (${c.seller.handle})`,
    c.seller.about,
    "",
    "> Prices and quantities below are INDICATIVE ONLY. They were read before the",
    "> show started and are supplied fresh with every turn. Never answer a price",
    "> or availability question from this document.",
    "",
    "## Inventory",
    "",
  ];
  for (const i of c.items) {
    lines.push(`### ${i.title}`);
    if (i.model) lines.push(`- Category: ${i.model}`);
    if (i.condition) lines.push(`- Condition: ${i.condition}`);
    lines.push(`- Listed around $${(i.priceCents / 100).toFixed(2)} (indicative)`);
    lines.push("");
  }
  if (!c.items.length) {
    lines.push("_No listings were resolved for this seller before the show._");
  }

  const form = new FormData();
  const name = `${c.id}-inventory.md`;
  form.append("file", new Blob([lines.join("\n")], { type: "text/markdown" }), name);
  form.append("title", name.replace(/\.md$/, ""));
  const r = await fetch(`${config.whissle.base}/api/agents/${agentId}/kb/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.whissle.apiKey}` },
    body: form,
  });
  if (!r.ok) throw new Error(`kb upload ${r.status}: ${(await r.text()).slice(0, 160)}`);
}

/**
 * Does eBay recognise this handle as a seller?
 *
 * One cheap request, because the alternative is finding out per query — and the
 * failure mode is silent: eBay drops an unrecognised seller filter, runs the
 * search anyway, and answers 200 with the whole market. `EbayClient.search`
 * turns that warning into an error, so this is simply "did it throw".
 */
async function sellerFilterWorks(handle: string): Promise<boolean> {
  try {
    await ebay.search("a", { limit: 1, sellers: [handle] });
    return true;
  } catch {
    return false;
  }
}
