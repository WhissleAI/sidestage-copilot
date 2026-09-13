// `npm run seed:agent` — provision ONE Whissle agent per catalog.
//
// Why per catalog, and not one shared agent or one per session:
//
//   * A catalog is a SELLER. It defines the persona, the voice, the never-say
//     list, the policies and the knowledge base — all of which are stable while
//     streams start and end. So the agent belongs to the catalog.
//
//   * One shared agent leaks. Uploading each show's lineup into a single agent
//     put two sellers' catalogs on the same `search_knowledge_base` corpus, so a
//     reply for one could retrieve the other's inventory. That was the state
//     before this file existed in this form, and it is a real tenancy bug.
//
//   * One agent per SESSION would litter the workspace with a new agent every
//     time someone attaches to a show, and re-upload an identical knowledge base
//     each time. Sessions are cheap and frequent; agents should not be.
//
// Idempotent: reuses an agent by name, patches its prompt and guardrails,
// replaces its knowledge base, writes the id back into the catalog file, and
// READS BACK /guardrails to print what is actually armed on the gateway rather
// than what we hoped we sent.

import { config } from "../config.js";
import { listCatalogs, getCatalog, setCatalogAgent, type Catalog } from "../shows/catalogs.js";
import { guardrailBody, systemPrompt } from "./agentSpec.js";
import { formatMoney } from "../domain/money.js";

const { apiKey, base } = config.whissle;

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

async function uploadKb(agentId: string, filename: string, content: string): Promise<void> {
  const form = new FormData();
  form.append("file", new Blob([content], { type: "text/markdown" }), filename);
  form.append("title", filename.replace(/\.md$/, ""));
  const r = await fetch(`${base}/api/agents/${agentId}/kb/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!r.ok) throw new Error(`kb upload ${filename} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
}

/** Remove every document on this agent, so a re-seed REPLACES rather than
 *  accumulates. An agent holding six stale copies of a lineup retrieves the
 *  wrong one. */
async function clearKb(agentId: string): Promise<number> {
  const body = await call<{ id: string }[] | { documents?: { id: string }[] }>("GET", `/api/agents/${agentId}/kb`)
    .catch(() => [] as { id: string }[]);
  const docs = Array.isArray(body) ? body : body.documents || [];
  for (const d of docs) {
    await call("DELETE", `/api/agents/${agentId}/kb/${d.id}`).catch(() => {});
  }
  return docs.length;
}

const agentName = (c: Catalog) => `SideStage · ${c.seller.name}`;

/** The catalog's stable facts. Volatile ones (price, quantity) are injected per
 *  turn instead — a knowledge base cannot be re-indexed between two bids. */
function catalogDoc(c: Catalog): string {
  const out = [
    `# ${c.name}`,
    "",
    `Seller: ${c.seller.name} (${c.seller.handle})`,
    c.seller.about,
    "",
    "> Prices and quantities below are INDICATIVE ONLY. They change during a live",
    "> show and are supplied fresh with every turn. Never answer a price or",
    "> availability question from this document.",
    "",
    "## Inventory",
    "",
  ];
  for (const i of c.items) {
    out.push(`### ${i.title}`);
    if (i.brand || i.model) out.push(`- Brand / model: ${[i.brand, i.model].filter(Boolean).join(" ")}`);
    if (i.colorway) out.push(`- ${i.colorway}`);
    if (i.size) out.push(`- Size / team: ${i.size}`);
    out.push(`- Condition: ${i.condition ?? "USED"}`);
    out.push(`- Authentication: ${i.authenticated && i.certId ? `certificate ${i.certId}` : "not third-party authenticated"}`);
    out.push(`- Indicative price: ${formatMoney(i.priceCents)}`);
    if (i.description) out.push("", i.description);
    out.push("");
  }
  return out.join("\n");
}

function policyDoc(c: Catalog): string {
  const out = [`# ${c.seller.name} — store policies`, ""];
  for (const p of c.policies) out.push(`## ${p.title} (${p.topic})`, "", p.body, "");
  return out.join("\n");
}

async function provision(catalogId: string): Promise<void> {
  const catalog = getCatalog(catalogId);
  if (!catalog) throw new Error(`unknown catalog ${catalogId}`);

  console.log(`\n── ${catalog.name}  (${catalog.seller.name})`);

  // ── resolve or create ────────────────────────────────────────────────────
  let agentId = catalog.agentId || "";
  if (agentId) {
    const ok = await call<{ id: string }>("GET", `/api/agents/${agentId}`).then(() => true).catch(() => false);
    if (!ok) {
      console.log(`   recorded agent ${agentId} is gone — re-creating`);
      agentId = "";
    }
  }
  if (!agentId) {
    const list = await call<{ id: string; name: string }[] | { agents: { id: string; name: string }[] }>("GET", "/api/agents");
    const agents = Array.isArray(list) ? list : list.agents || [];
    const found = agents.find((a) => a.name === agentName(catalog));
    if (found) {
      agentId = found.id;
      console.log(`   reusing agent ${agentId}`);
    } else {
      const created = await call<{ id: string }>("POST", "/api/agents", {
        name: agentName(catalog),
        agent_type: "text_assistant",
        direction: "inbound",
        system_prompt: systemPrompt(catalog.seller.handle, catalog.seller),
        greeting: "Hey! Ask me anything about what's on the block.",
        tools: [{ name: "search_knowledge_base", enabled: true }],
      });
      agentId = created.id;
      console.log(`   created agent ${agentId}`);
    }
  }

  // ── identity + Layer-A guardrails ────────────────────────────────────────
  await call("PATCH", `/api/agents/${agentId}`, {
    system_prompt: systemPrompt(catalog.seller.handle, catalog.seller),
    ...guardrailBody(),
  });
  console.log("   pushed system prompt + content_guardrails + action_policy");

  // ── knowledge base, replaced not appended ────────────────────────────────
  const removed = await clearKb(agentId);
  await uploadKb(agentId, `${catalog.id}-inventory.md`, catalogDoc(catalog));
  await uploadKb(agentId, `${catalog.id}-policies.md`, policyDoc(catalog));
  console.log(`   knowledge base: removed ${removed}, uploaded inventory (${catalog.items.length} items) + policies (${catalog.policies.length})`);

  setCatalogAgent(catalog.id, agentId);

  // ── read back what is ACTUALLY armed ─────────────────────────────────────
  const gr = await call<{ groups: { label: string; items: { label: string; configurable: boolean; value: unknown }[] }[] }>(
    "GET", `/api/agents/${agentId}/guardrails`,
  );
  for (const g of gr.groups) {
    for (const it of g.items) {
      if (!it.configurable) continue;
      if (/content|language|approval/i.test(it.label)) {
        console.log(`   armed · ${it.label}: ${JSON.stringify(it.value)}`);
      }
    }
  }
}

async function main(): Promise<void> {
  if (!apiKey) {
    console.error("Set WHISSLE_API_KEY (a wsk_ workspace secret key) first. See .env.example.");
    process.exit(2);
  }

  const catalogs = listCatalogs();
  if (!catalogs.length) {
    console.error(`No catalogs found in ${config.catalogsDir}.`);
    process.exit(2);
  }

  const only = process.argv[2];
  const targets = only ? catalogs.filter((c) => c.id === only) : catalogs;
  if (!targets.length) {
    console.error(`No catalog with id "${only}".`);
    process.exit(2);
  }

  console.log(`Provisioning ${targets.length} agent(s) — one per catalog.`);
  for (const c of targets) await provision(c.id);

  console.log("\nEach catalog now owns its own agent, with its own knowledge base.");
  console.log("The app picks the agent from the catalog the operator chose at setup.\n");
}

main().catch((e) => {
  console.error(`seed:agent failed — ${(e as Error).message}`);
  process.exit(1);
});
