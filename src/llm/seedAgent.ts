// `npm run seed:agent` — provision the Whissle agent this app talks to.
//
// Idempotent: it reuses WHISSLE_AGENT_ID when set, otherwise finds the agent by
// name, otherwise creates it. Then it PATCHes the guardrail configuration,
// replaces the two knowledge documents, and READS BACK /guardrails to prove what
// is actually armed on the gateway rather than what we hoped we sent.

import { config } from "../config.js";
import { db } from "../db/index.js";
import { Repo } from "../domain/repo.js";
import { AGENT_NAME, catalogDoc, createBody, guardrailBody, policyDoc } from "./agentSpec.js";

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

async function main(): Promise<void> {
  if (!apiKey) {
    console.error("Set WHISSLE_API_KEY (a wsk_ workspace secret key) first. See .env.example.");
    process.exit(2);
  }

  const repo = new Repo(db());
  const show = repo.show();

  // ── 1. resolve or create the agent ──────────────────────────────────────
  let agentId = config.whissle.agentId;
  if (agentId) {
    try {
      await call<{ id: string }>("GET", `/api/agents/${agentId}`);
      console.log(`• reusing agent ${agentId} from WHISSLE_AGENT_ID`);
    } catch {
      console.log(`• WHISSLE_AGENT_ID ${agentId} is not reachable — falling back to lookup`);
      agentId = "";
    }
  }
  if (!agentId) {
    const list = await call<{ id: string; name: string }[] | { agents: { id: string; name: string }[] }>("GET", "/api/agents");
    const agents = Array.isArray(list) ? list : list.agents || [];
    const found = agents.find((a) => a.name === AGENT_NAME);
    if (found) {
      agentId = found.id;
      console.log(`• found existing agent "${AGENT_NAME}" -> ${agentId}`);
    } else {
      const created = await call<{ id: string }>("POST", "/api/agents", createBody(show.sellerHandle));
      agentId = created.id;
      console.log(`• created agent "${AGENT_NAME}" -> ${agentId}`);
    }
  }

  // ── 2. push identity + Layer-A guardrails ───────────────────────────────
  await call("PATCH", `/api/agents/${agentId}`, {
    system_prompt: createBody(show.sellerHandle).system_prompt,
    ...guardrailBody(),
  });
  console.log("• pushed system prompt + content_guardrails + action_policy");

  // ── 3. replace the knowledge documents ──────────────────────────────────
  const existing = await call<{ id: string; title?: string; filename?: string }[] | { documents?: { id: string; title?: string }[] }>(
    "GET", `/api/agents/${agentId}/kb`,
  ).catch(() => [] as { id: string; title?: string }[]);
  const docs = Array.isArray(existing) ? existing : existing.documents || [];
  for (const d of docs) {
    const title = (d.title || "").toLowerCase();
    if (title.startsWith("sidestage-")) {
      await call("DELETE", `/api/agents/${agentId}/kb/${d.id}`).catch(() => {});
    }
  }
  await uploadKb(agentId, "sidestage-catalog.md", catalogDoc(repo));
  await uploadKb(agentId, "sidestage-policies.md", policyDoc(repo));
  console.log("• uploaded sidestage-catalog.md + sidestage-policies.md");

  // ── 4. read back what is ACTUALLY armed ─────────────────────────────────
  const gr = await call<{ groups: { key: string; label: string; items: { key: string; label: string; configurable: boolean; value: unknown }[] }[] }>(
    "GET", `/api/agents/${agentId}/guardrails`,
  );
  console.log("\nLayer A — guardrails now armed on the Whissle agent:");
  for (const g of gr.groups) {
    for (const it of g.items) {
      if (!it.configurable) continue;
      console.log(`  [${g.label}] ${it.label}: ${JSON.stringify(it.value)}`);
    }
  }

  console.log(`\nDone. Put this in your .env:\n\n  WHISSLE_AGENT_ID=${agentId}\n`);
}

main().catch((e) => {
  console.error(`seed:agent failed — ${(e as Error).message}`);
  process.exit(1);
});
