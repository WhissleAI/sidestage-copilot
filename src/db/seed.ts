// Seed a realistic show: catalog, listings, policy clauses, market comps and a
// past-Q&A corpus. Deterministic — the evals and the latency bench replay
// against exactly this state, so their numbers are comparable run to run.
//
// The seller archetype (docs/PRD.md §1) is a solo sneaker/streetwear reseller, so
// the catalog is priced and conditioned the way that market actually works:
// DS/VNDS grading, authentication certs, thin margins over a cost basis, and a
// floor price the seller will not cross on air.

import { db, type DB } from "./index.js";
import { config } from "../config.js";

const now = () => new Date().toISOString();

interface SeedListing {
  id: string; sku: string; title: string; short: string; brand: string; model: string; colorway: string;
  size: string; condition: "DS" | "VNDS" | "USED"; price: number; floor: number; cost: number;
  qty: number; state: "draft" | "queued" | "live" | "ended"; pinned?: boolean;
  shipping: string; authenticated: boolean; certId: string | null; description: string;
  views: number;
}

const LISTINGS: SeedListing[] = [
  {
    id: "lst_aj1_chi_10", sku: "AJ1-CHI-REIMAGINED", title: 'Air Jordan 1 Retro High OG "Chicago Reimagined"',
    short: "AJ1 Chicago",
    brand: "Jordan", model: "Air Jordan 1 Retro High OG", colorway: "Chicago Reimagined / Lost & Found",
    size: "10", condition: "DS", price: 41200, floor: 35500, cost: 31000, qty: 1,
    state: "live", pinned: true, shipping: "us-free-2day", authenticated: true, certId: "CHK-88213-A",
    views: 1840,
    description:
      "2022 Lost & Found release, deadstock with the original box and the special-edition " +
      "aged-paper lid. Cracked-leather finish is factory-intended, not wear. Includes the " +
      "extra laces and the hangtag. Authenticated by CheckCheck, cert CHK-88213-A.",
  },
  {
    id: "lst_nb990_95", sku: "NB-990V6-GREY", title: "New Balance 990v6 Grey",
    short: "NB 990v6 Grey",
    brand: "New Balance", model: "990v6", colorway: "Grey / MR990GL6", size: "9.5",
    condition: "VNDS", price: 21800, floor: 19000, cost: 16500, qty: 1, state: "queued",
    shipping: "us-free-2day", authenticated: true, certId: "CHK-77120-B", views: 610,
    description:
      "Worn twice indoors. Midsole is clean, no creasing on the toe box, original box included. " +
      "Made in USA. Pigskin suede and mesh upper, FuelCell midsole.",
  },
  {
    id: "lst_bogo_l", sku: "SUP-BOGO-FW22-BLK", title: "Supreme Box Logo Hoodie FW22 Black",
    short: "Supreme Box Logo",
    brand: "Supreme", model: "Box Logo Hooded Sweatshirt", colorway: "Black", size: "L",
    condition: "DS", price: 56500, floor: 49000, cost: 44000, qty: 1, state: "queued",
    shipping: "us-free-2day", authenticated: true, certId: "CHK-90441-C", views: 2210,
    description:
      "FW22 box logo, deadstock with tags attached. Heavyweight cotton fleece, chenille box logo " +
      "applique. Kanagawa-style FW22 interior tag. Runs true to size.",
  },
  {
    id: "lst_dunk_panda_11", sku: "NK-DUNK-PANDA", title: "Nike Dunk Low Retro White/Black Panda",
    short: "Dunk Panda",
    brand: "Nike", model: "Dunk Low Retro", colorway: "White / Black (Panda)", size: "11",
    condition: "DS", price: 12800, floor: 11000, cost: 9500, qty: 3, state: "queued",
    shipping: "us-standard", authenticated: false, certId: null, views: 430,
    description:
      "Deadstock general release, original box. Leather upper, rubber cupsole. General release " +
      "pair, not authenticated — priced accordingly.",
  },
  {
    id: "lst_yz_slide_10", sku: "YZ-SLIDE-BONE", title: "Yeezy Slide Bone",
    short: "Yeezy Slide Bone",
    brand: "adidas", model: "Yeezy Slide", colorway: "Bone", size: "10", condition: "DS",
    price: 9200, floor: 8000, cost: 7000, qty: 2, state: "queued",
    shipping: "us-standard", authenticated: false, certId: null, views: 290,
    description: "Deadstock, no box (Yeezy Slides ship in a poly bag from adidas). EVA foam, runs large — size down.",
  },
  {
    id: "lst_sb_dunk_9", sku: "NK-SB-DUNK-CHUNKY", title: 'Nike SB Dunk Low "Chunky Dunky"',
    short: "SB Chunky Dunky",
    brand: "Nike", model: "SB Dunk Low", colorway: "Ben & Jerry's / Chunky Dunky", size: "9",
    condition: "USED", price: 92500, floor: 82000, cost: 74000, qty: 1, state: "queued",
    shipping: "us-free-2day", authenticated: true, certId: "CHK-61027-D", views: 3105,
    description:
      "2020 Ben & Jerry's collab. Worn roughly 5 times — light creasing on both toe boxes, " +
      "cow-print upper intact, no separation. Original box has shelf wear. Authenticated, cert CHK-61027-D.",
  },
  {
    id: "lst_tn_hoodie_m", sku: "TNF-NUPTSE-BLK-M", title: "The North Face Nuptse 1996 Jacket Black",
    short: "TNF Nuptse",
    brand: "The North Face", model: "Nuptse 1996 Retro", colorway: "TNF Black", size: "M",
    condition: "VNDS", price: 24500, floor: 21000, cost: 18000, qty: 1, state: "queued",
    shipping: "us-free-2day", authenticated: false, certId: null, views: 520,
    description: "700-fill goose down, worn one season, no rips or down leakage. Original hangtag included.",
  },
  {
    id: "lst_travis_9", sku: "AJ1-TRAVIS-LOW", title: "Air Jordan 1 Low OG Travis Scott Reverse Mocha",
    short: "AJ1 Travis Mocha",
    brand: "Jordan", model: "Air Jordan 1 Low OG SP", colorway: "Reverse Mocha", size: "9",
    condition: "DS", price: 118000, floor: 104000, cost: 96000, qty: 1, state: "draft",
    shipping: "us-free-2day", authenticated: true, certId: "CHK-55908-E", views: 4480,
    description:
      "Deadstock with box and all accessories. Reversed swoosh, Cactus Jack branding on the heel. " +
      "Authenticated by CheckCheck, cert CHK-55908-E.",
  },
];

const POLICIES: { id: string; topic: string; title: string; body: string }[] = [
  {
    id: "pol_ship_domestic", topic: "shipping", title: "Domestic shipping",
    body:
      "US orders ship free via 2-day service on any item priced at $150 or more. Items under $150 " +
      "ship USPS Ground Advantage at a flat $9.95. Handling time is 1 business day; orders placed " +
      "during a Friday show go out Monday.",
  },
  {
    id: "pol_ship_intl", topic: "shipping", title: "International shipping",
    body:
      "We ship to Canada, the UK and the EU via DHL Express, calculated at checkout — typically " +
      "$38 to $65. Import duties and VAT are the buyer's responsibility and are not collected by us. " +
      "We do not ship to Australia, Brazil or Russia.",
  },
  {
    id: "pol_returns", topic: "returns", title: "Returns",
    body:
      "30-day returns on unworn items in original packaging. The buyer pays return shipping unless " +
      "the item arrived not as described, in which case we cover it and refund in full. Deadstock " +
      "items must be returned deadstock — worn soles void the return.",
  },
  {
    id: "pol_auth", topic: "authenticity", title: "Authentication",
    body:
      "Every item priced over $200 is authenticated by CheckCheck before it is listed, and ships " +
      "with its certificate number. General-release pairs under $200 are not third-party " +
      "authenticated; we describe them honestly and they carry the same 30-day return.",
  },
  {
    id: "pol_discount", topic: "discount", title: "Discounts on air",
    body:
      "Live-show discounts cap at 15% off the listed price and may never go below the item's floor " +
      "price. Bundle two or more items for an additional 5%. Codes from previous shows do not stack.",
  },
  {
    id: "pol_tone", topic: "tone", title: "Voice and tone",
    body:
      "Warm, fast and specific. One or two sentences. Answer the actual question first, then add at " +
      "most one detail. Use the buyer's name when they give it. Never hype an item beyond what the " +
      "condition notes support.",
  },
  {
    id: "pol_prohibited", topic: "prohibited", title: "Claims we never make",
    body:
      "Never describe an item as an investment or promise it will appreciate. Never say 'guaranteed " +
      "authentic' for an item without a certificate number. Never promise a delivery date we do not " +
      "control, never claim an item is the last one unless quantity is genuinely 1, and never make " +
      "health, safety or performance claims about footwear.",
  },
];

const COMPS: { sku: string; title: string; price: number; daysAgo: number; condition: string; size: string }[] = [
  { sku: "AJ1-CHI-REIMAGINED", title: "AJ1 High OG Lost & Found", price: 39500, daysAgo: 2, condition: "DS", size: "10" },
  { sku: "AJ1-CHI-REIMAGINED", title: "AJ1 High OG Lost & Found", price: 36800, daysAgo: 5, condition: "DS", size: "10" },
  { sku: "AJ1-CHI-REIMAGINED", title: "AJ1 High OG Lost & Found", price: 37500, daysAgo: 9, condition: "DS", size: "10.5" },
  { sku: "AJ1-CHI-REIMAGINED", title: "AJ1 High OG Lost & Found", price: 34200, daysAgo: 14, condition: "VNDS", size: "10" },
  { sku: "AJ1-CHI-REIMAGINED", title: "AJ1 High OG Lost & Found", price: 40100, daysAgo: 21, condition: "DS", size: "10" },
  { sku: "NB-990V6-GREY", title: "New Balance 990v6 Grey", price: 20500, daysAgo: 3, condition: "VNDS", size: "9.5" },
  { sku: "NB-990V6-GREY", title: "New Balance 990v6 Grey", price: 22000, daysAgo: 8, condition: "DS", size: "9.5" },
  { sku: "NB-990V6-GREY", title: "New Balance 990v6 Grey", price: 19800, daysAgo: 16, condition: "VNDS", size: "10" },
  { sku: "SUP-BOGO-FW22-BLK", title: "Supreme Box Logo Hoodie FW22", price: 58000, daysAgo: 4, condition: "DS", size: "L" },
  { sku: "SUP-BOGO-FW22-BLK", title: "Supreme Box Logo Hoodie FW22", price: 54500, daysAgo: 11, condition: "DS", size: "L" },
  { sku: "SUP-BOGO-FW22-BLK", title: "Supreme Box Logo Hoodie FW22", price: 56000, daysAgo: 19, condition: "VNDS", size: "M" },
  { sku: "NK-DUNK-PANDA", title: "Nike Dunk Low Panda", price: 12000, daysAgo: 1, condition: "DS", size: "11" },
  { sku: "NK-DUNK-PANDA", title: "Nike Dunk Low Panda", price: 13100, daysAgo: 6, condition: "DS", size: "11" },
  { sku: "NK-DUNK-PANDA", title: "Nike Dunk Low Panda", price: 11800, daysAgo: 12, condition: "DS", size: "10.5" },
  { sku: "YZ-SLIDE-BONE", title: "Yeezy Slide Bone", price: 9000, daysAgo: 3, condition: "DS", size: "10" },
  { sku: "YZ-SLIDE-BONE", title: "Yeezy Slide Bone", price: 9800, daysAgo: 10, condition: "DS", size: "10" },
  { sku: "NK-SB-DUNK-CHUNKY", title: "SB Dunk Low Chunky Dunky", price: 89000, daysAgo: 7, condition: "USED", size: "9" },
  { sku: "NK-SB-DUNK-CHUNKY", title: "SB Dunk Low Chunky Dunky", price: 96500, daysAgo: 15, condition: "VNDS", size: "9" },
  { sku: "TNF-NUPTSE-BLK-M", title: "TNF Nuptse 1996 Black", price: 23500, daysAgo: 5, condition: "VNDS", size: "M" },
  { sku: "AJ1-TRAVIS-LOW", title: "AJ1 Low Travis Reverse Mocha", price: 114000, daysAgo: 6, condition: "DS", size: "9" },
];

const QA: { id: string; q: string; a: string; tags: string }[] = [
  { id: "qa_box", q: "does it come with the original box", a: "Every pair ships in its original box unless the listing says otherwise. Yeezy Slides are the exception — adidas ships those in a poly bag, not a box.", tags: "box packaging shipping" },
  { id: "qa_ds_meaning", q: "what does DS mean", a: "DS is deadstock — brand new, never worn, with the original packaging. VNDS is very near deadstock, worn a couple of times with no visible flaws.", tags: "condition ds vnds grading" },
  { id: "qa_cert_lookup", q: "how do I check the authentication certificate", a: "Each authenticated item ships with a CheckCheck certificate number on the card in the box; you can verify it on CheckCheck's site with that number.", tags: "authenticity certificate legit check" },
  { id: "qa_size_990", q: "do New Balance 990s run big", a: "The 990v6 runs about half a size large. Most buyers take a half size down from their usual Nike size.", tags: "sizing fit new balance" },
  { id: "qa_size_slide", q: "do yeezy slides run big", a: "Yeezy Slides run large. Size down one full size from your usual sneaker size, or down two if you like them snug.", tags: "sizing fit yeezy slides" },
  { id: "qa_bundle", q: "can I bundle two items", a: "Yes — bundle two or more items from the same show and you get an extra 5% off on top of any show discount.", tags: "discount bundle" },
  { id: "qa_hold", q: "can you hold an item for me", a: "We can hold an item until the end of the show, but not overnight. Drop your handle in chat and we'll tag it.", tags: "hold reserve" },
  { id: "qa_crease", q: "is the cracked leather on the lost and found a defect", a: "No — the aged, cracked finish on the Lost & Found AJ1 is how Nike made them. It is a design feature, not wear.", tags: "condition defect chicago lost and found" },
  { id: "qa_payment", q: "what payment methods do you take", a: "Whatever the marketplace supports at checkout — card, PayPal and the platform's own wallet. We never take payment outside the platform.", tags: "payment checkout" },
  { id: "qa_ship_speed", q: "how fast do you ship", a: "Handling time is one business day. Orders placed during a Friday show go out on Monday.", tags: "shipping speed handling" },
];

export function seed(d: DB): void {
  const tx = d.transaction(() => {
    d.exec("DELETE FROM listings; DELETE FROM policies; DELETE FROM comps; DELETE FROM qa; DELETE FROM show; DELETE FROM actions; DELETE FROM action_commits; DELETE FROM audit;");

    const ins = d.prepare(`
      INSERT INTO listings (id, sku, title, short_name, brand, model, colorway, size, condition, price_cents,
        floor_price_cents, cost_cents, qty, sold_this_show, views, state, pinned, version, image_url,
        shipping_profile, authenticated, cert_id, description, updated_at)
      VALUES (@id, @sku, @title, @short, @brand, @model, @colorway, @size, @condition, @price,
        @floor, @cost, @qty, 0, @views, @state, @pinned, 1, @image,
        @shipping, @authenticated, @certId, @description, @updated)
    `);
    for (const l of LISTINGS) {
      ins.run({
        ...l, pinned: l.pinned ? 1 : 0, authenticated: l.authenticated ? 1 : 0,
        image: `https://picsum.photos/seed/${l.id}/320/320`, updated: now(),
      });
    }

    const pol = d.prepare("INSERT INTO policies (id, topic, title, body) VALUES (?, ?, ?, ?)");
    for (const p of POLICIES) pol.run(p.id, p.topic, p.title, p.body);

    const cmp = d.prepare("INSERT INTO comps (sku, title, sold_price_cents, sold_at, condition, size) VALUES (?, ?, ?, ?, ?, ?)");
    for (const c of COMPS) {
      const at = new Date(Date.now() - c.daysAgo * 86_400_000).toISOString();
      cmp.run(c.sku, c.title, c.price, at, c.condition, c.size);
    }

    const qa = d.prepare("INSERT INTO qa (id, question, answer, tags) VALUES (?, ?, ?, ?)");
    for (const x of QA) qa.run(x.id, x.q, x.a, x.tags);

    const queue = LISTINGS.filter((l) => l.state === "queued").map((l) => l.id);
    d.prepare(`
      INSERT INTO show (id, title, seller_handle, started_at, viewers, pinned_listing_id, lot_queue, autonomy_level, undo_window_s)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "show_ep42", "Friday Night Grails — Ep. 42", "@kicksbyrae",
      new Date(Date.now() - 72 * 60_000).toISOString(), 247,
      "lst_aj1_chi_10", JSON.stringify(queue), config.autonomyDefault, config.undoWindowS,
    );
  });
  tx();
}

export { LISTINGS, POLICIES, QA };

// `npm run seed`
if (import.meta.url === `file://${process.argv[1]}`) {
  const d = db();
  seed(d);
  const n = d.prepare("SELECT COUNT(*) AS c FROM listings").get() as { c: number };
  console.log(`seeded ${n.c} listings, ${POLICIES.length} policy clauses, ${COMPS.length} comps, ${QA.length} Q&A into ${config.dbPath}`);
}
