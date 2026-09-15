// An agent per stream.
//
// A catalog's agent was the right unit while a catalog WAS the inventory: it
// carried the seller's persona, guardrails and knowledge base, and two sellers
// could never retrieve each other's stock.
//
// Monitoring broke that. Every stream has a different lineup — the lots it puts
// on screen — so several monitored shows sharing one catalog agent meant several
// shows writing their lots into one knowledge base. The symptom was five dead
// show corpora on one agent, each retrievable and each answerable with total
// confidence about lots that sold days ago. The purge that fixed it had to be
// exactly right, and a fix that has to be exactly right is a fix waiting to be
// wrong.
//
// One agent per stream makes it impossible rather than handled: one show, one
// corpus, nothing to purge and nothing to leak.
//
// The config is the SAME config — same persona shape, same guardrails, same
// action policy, projected from the same `SellerGuardrailPolicy` object. What
// is tweaked is the part that is genuinely per-show: who is hosting, what they
// are selling, and that this is someone else's shop.
//
// The cost is that agents accumulate. So the show OWNS its agent, and deleting
// the session deletes it — see `deleteStreamAgent`.

import { config } from "../config.js";
import { systemPrompt } from "./agentSpec.js";
import { policy, toContentGuardrails, toActionPolicy } from "../guardrails/policy.js";
import type { SellerProfile } from "../shows/catalogs.js";

export interface StreamAgentSpec {
  showId: string;
  /** What eBay calls the show, once the watcher has read it. */
  showTitle: string;
  /** The seller running it, as the stream reports them. */
  host: string;
  /** Present only when the operator said this is their own show. */
  seller?: SellerProfile | undefined;
  /** True when the show belongs to someone else. */
  monitored: boolean;
}

/** How the platform should summarise the audio session at its end. */
export function scoringPrompt(s: StreamAgentSpec): string {
  return [
    `This session is the host's audio from a live selling show ("${s.showTitle}", host ${s.host}). You only listened; the host never spoke to you.`,
    "Summarise the SHOW, not a conversation: what was pitched, how the host paced it, where energy rose or dropped, what sold or stalled if audible.",
    "outcome: one of strong / steady / rough / quiet. next_action: the one thing the host should change before the next show. key_points: 3-5, each tied to something said.",
    "Do not describe it as a call, a customer, or a support interaction.",
  ].join(" ");
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${config.whissle.base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.whissle.apiKey}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${(await r.text()).slice(0, 200)}`);
  const text = await r.text();
  return (text ? JSON.parse(text) : {}) as T;
}

/**
 * The per-show half of the prompt.
 *
 * Everything here is a fact about THIS stream that the base prompt cannot know,
 * and the most important of them is the last: on a show we do not own, the
 * copilot must never speak about the lineup as though it were ours. That is the
 * same boundary the `catalog:lineup` fact enforces at retrieval time, stated
 * again where the agent will read it on every channel — including the ones this
 * app is not in the loop for.
 */
function showPreamble(s: StreamAgentSpec): string {
  const lines = [
    ``,
    `THIS SHOW`,
    `- You are answering buyers in "${s.showTitle}", hosted by ${s.host}.`,
    `- The lineup is whatever the host puts on screen. Lots arrive, take bids and close`,
    `  during the show, and their prices move while you are drafting — so price and`,
    `  availability come from the facts supplied with the turn, never from memory.`,
  ];
  if (s.monitored) {
    lines.push(
      `- This show belongs to ${s.host}, not to you. You have no seller catalog behind it and`,
      `  no authority over the listings. If a buyer asks about something you cannot see in the`,
      `  supplied facts, say you do not have that one to hand — NEVER that the show does not`,
      `  have it. Denying someone else's stock is the one mistake you can make here that a`,
      `  buyer will remember.`,
    );
  }
  return lines.join("\n");
}

/** Create an agent that belongs to this show. */
/**
 * Something that can make room when the workspace's agent cap is hit —
 * registered by the server (it needs the database); absent in tests.
 */
let makeRoom: (() => Promise<unknown>) | null = null;
export function onAgentCap(fn: () => Promise<unknown>): void {
  makeRoom = fn;
}

export async function createStreamAgent(s: StreamAgentSpec): Promise<string> {
  const handle = s.seller?.handle || s.host || "the seller";
  const create = () => call<{ id: string }>("POST", "/api/agents", {
    // Named for the show so an operator looking at the Whissle console can tell
    // what a given agent is for, and so an orphan is recognisable as one.
    name: `SideStage · ${s.showTitle}`.slice(0, 80),
    agent_type: "text_assistant",
    direction: "inbound",
    system_prompt: systemPrompt(handle, s.seller) + showPreamble(s),
    greeting: "",
    language_mode: policy().languageMode,
    // Same tool set as the catalog agents: retrieval is done in this app, and
    // the agent keeps a knowledge-base fallback plus the web for the naming
    // turn, where the show itself is sometimes not enough.
    tools: [
      { name: "search_knowledge_base", enabled: true },
      { name: "search_web", enabled: true },
      { name: "read_url", enabled: true },
    ],
  });
  let created: { id: string };
  try {
    created = await create();
  } catch (e) {
    // The workspace caps agents at fifty. Retire what is finished and try
    // once more before telling the operator to go and delete things by hand.
    if (!/limit of \d+ agents|429/.test(String((e as Error).message)) || !makeRoom) throw e;
    await makeRoom().catch(() => undefined);
    created = await create();
  }

  // Layer A, armed at creation rather than on a later save: a show that starts
  // before anyone opens the settings page is still guarded.
  await call("PATCH", `/api/agents/${created.id}`, {
    content_guardrails: toContentGuardrails(),
    action_policy: toActionPolicy(),
    // The gateway runs its own emotion/intent head over the listen-only audio
    // session and writes an end-of-session summary; both are read back into
    // the post-show report (see shows/conclusion.ts and llm/sessions.ts). The
    // rubric tells that summary what a SHOW is, so it does not grade a
    // two-hour selling stream as an unresolved support call.
    emotion_analysis_enabled: true,
    scoring_prompt: scoringPrompt(s),
  }).catch(() => {
    // The agent exists and works; it is just not carrying Layer A yet. Readiness
    // reports that honestly rather than the session failing to start.
  });

  return created.id;
}

/**
 * Delete an agent this app created for a show.
 *
 * Returns what happened rather than throwing: a session the operator asked to
 * delete should disappear from their list whether or not the gateway agreed to
 * remove the agent, and an agent we failed to delete is a thing to report, not
 * a reason to keep the session.
 */
export async function deleteStreamAgent(agentId: string): Promise<{ ok: boolean; detail: string }> {
  try {
    // `confirm=true` because the gateway refuses to silently drop an agent's
    // knowledge documents — a good guard, and this is precisely the case it is
    // asking about: the documents ARE this show's corpus and go with it. An
    // unconfirmed delete 409s and leaves the agent orphaned with its lots still
    // in it, which is the outcome the whole per-stream design exists to avoid.
    await call("DELETE", `/api/agents/${agentId}?confirm=true`);
    return { ok: true, detail: `agent ${agentId.slice(0, 8)} and its corpus deleted` };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}
