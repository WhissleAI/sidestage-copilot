// Push a watched show's catalog into the Whissle agent's knowledge base.
//
// The division of labour matters, and it is the reason this is a *sync* rather
// than "upload everything on every change":
//
//   * The KB carries what is STABLE about a show — which seller, what they are
//     selling tonight, the shape of the lineup, the house policies. It is a RAG
//     corpus the agent can search on its own (`search_knowledge_base`) when a
//     buyer asks something the per-turn facts did not anticipate.
//
//   * The per-turn `context` field carries what is VOLATILE — this lot, this
//     price, this version, right now. A knowledge base cannot be re-indexed
//     between two bids, so anything that moves during a show must never be
//     answered from it.
//
// So a KB doc is written when a show is attached and when its lineup materially
// grows, debounced hard. Prices deliberately appear only as "indicative".

import { config } from "../config.js";

/** Every per-show KB document starts with this, which is what makes it possible
 *  to tell a show corpus from the catalog corpus when cleaning up. */
const SHOW_DOC_PREFIX = "sidestage-show-";

interface KbDoc { id: string; title?: string; file_name?: string }
import type { ShowRuntime } from "../shows/runtime.js";
import { formatMoney } from "../domain/money.js";


export class KbSync {
  private timers = new Map<string, NodeJS.Timeout>();
  private lastSignature = new Map<string, string>();
  /** Shows whose foreign corpora have been purged this process. */
  private purged = new Set<string>();

  /** Sync now. Returns false when there was nothing new to say. */
  async syncShow(rt: ShowRuntime): Promise<{ uploaded: boolean; lots: number; reason?: string }> {
    // Sync to the show's OWN agent — the one its catalog owns — so a lineup
    // never lands on another seller's knowledge base.
    const agentId = rt.agentId;
    if (!config.whissle.apiKey || !agentId) {
      return { uploaded: false, lots: 0, reason: "no Whissle credentials" };
    }

    // A show we are syncing is by definition one we are watching.
    this.watching.add(rt.showId);

    const listings = await rt.repo.listings();
    const signature = listings.map((l) => l.id).sort().join(",");
    const title = `${SHOW_DOC_PREFIX}${rt.showId}`;

    // Purge OTHER shows' corpora once per session, BEFORE the unchanged-lineup
    // shortcut. Cleanup used to sit after it, so a show whose lineup had settled
    // never cleaned — and a resumed show, whose lineup is identical on the first
    // sync, never cleaned at all. Five dead shows accumulated on one agent that
    // way, each of them retrievable and answerable with total confidence.
    if (!this.purged.has(rt.showId)) {
      this.purged.add(rt.showId);
      // Keep every show this process is CURRENTLY watching, not just this one.
      // Two shows can share a catalog's agent, and a purge that keeps only the
      // caller made them delete each other's corpus and re-upload in a loop.
      await this.removeShowDocs(agentId, this.activeTitles(rt.showId));
    }

    if (this.lastSignature.get(rt.showId) === signature) {
      return { uploaded: false, lots: listings.length, reason: "lineup unchanged" };
    }
    const doc = await this.render(rt);

    // Replace rather than accumulate: an agent that collects six stale copies of
    // the same lineup will retrieve the wrong one.
    await this.removeShowDocs(agentId, [title]);
    await rt.llm.uploadKb(`${title}.md`, doc);

    this.lastSignature.set(rt.showId, signature);
    return { uploaded: true, lots: listings.length };
  }


  cancel(showId: string): void {
    const t = this.timers.get(showId);
    if (t) clearTimeout(t);
    this.timers.delete(showId);
    this.lastSignature.delete(showId);
    // No longer watched, so its corpus is now fair game for the next purge and
    // the next attach of this show should clean again.
    this.watching.delete(showId);
    this.purged.delete(showId);
  }

  /** Titles of every show this process is watching, so a purge does not delete
   *  a sibling show's corpus off a shared catalog agent. */
  private activeTitles(selfShowId: string): string[] {
    const ids = new Set<string>([selfShowId, ...this.watching]);
    return [...ids].map((id) => `${SHOW_DOC_PREFIX}${id}`);
  }

  /** Shows currently being monitored. Fed by the registry. */
  private watching = new Set<string>();

  /** Drop every `sidestage-show-*` document not in `keepTitles`. */
  private async removeShowDocs(agentId: string, keepTitles: string[]): Promise<void> {
    try {
      const r = await fetch(`${config.whissle.base}/api/agents/${agentId}/kb`, {
        headers: { Authorization: `Bearer ${config.whissle.apiKey}` },
      });
      if (!r.ok) return;
      // The gateway returns `{items: [...]}`. This read only `documents` and a
      // bare array, so it silently found zero documents and deleted nothing —
      // which is why show corpora piled up on the agent for weeks while the
      // code looked like it was cleaning them.
      const body = (await r.json()) as
        | KbDoc[]
        | { items?: KbDoc[]; documents?: KbDoc[] };
      const docs: KbDoc[] = Array.isArray(body) ? body : body.items ?? body.documents ?? [];
      for (const d of docs) {
        const name = d.title || d.file_name || "";
        if (name.startsWith(SHOW_DOC_PREFIX) && !keepTitles.some((k) => name.startsWith(k))) {
          const del = await fetch(`${config.whissle.base}/api/agents/${agentId}/kb/${d.id}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${config.whissle.apiKey}` },
          }).catch((e: Error) => ({ ok: false, status: 0, statusText: e.message }) as Response);
          // Say so. A purge that silently fails is how five dead show corpora
          // accumulated on one agent while the code looked like it cleaned.
          console.log(
            `[kb] ${del.ok ? "removed" : `FAILED (${del.status})`} stale corpus ${name}`,
          );
        }
      }
    } catch {
      // A failed cleanup must not block the upload; a duplicate is recoverable,
      // a missing corpus is not.
    }
  }

  private async render(rt: ShowRuntime): Promise<string> {
    const show = await rt.repo.show();
    const listings = await rt.repo.listings();
    const out: string[] = [
      `# ${show.title}`,
      "",
      `Seller: ${show.sellerHandle}`,
      `Source: ${show.source}${show.externalId ? ` (event ${show.externalId})` : ""}`,
      "",
      "> Prices and quantities in this document are INDICATIVE ONLY. They change",
      "> during a live show and are supplied fresh with every turn. Never answer a",
      "> price or availability question from this document.",
      "",
      "## Tonight's lineup",
      "",
    ];

    const sellable = listings.filter((l) => l.state !== "ended");
    for (const l of sellable) {
      out.push(`### ${l.title}`);
      if (l.brand || l.model) out.push(`- Brand / model: ${[l.brand, l.model].filter(Boolean).join(" ")}`);
      if (l.colorway) out.push(`- Colorway: ${l.colorway}`);
      if (l.size) out.push(`- Size: ${l.size}`);
      out.push(`- Condition grade: ${l.condition}`);
      out.push(
        `- Authentication: ${l.authenticated && l.certId ? `certificate ${l.certId}` : "not third-party authenticated"}`,
      );
      out.push(`- Indicative price at the time this document was written: ${formatMoney(l.priceCents)}`);
      if (l.description) out.push("", l.description);
      out.push("");
    }

    const policies = await rt.repo.policies();
    if (policies.length) {
      out.push("## Store policies", "");
      for (const p of policies) out.push(`### ${p.title} (${p.topic})`, "", p.body, "");
    }

    const qa = await rt.repo.qa();
    if (qa.length) {
      out.push("## Frequently asked in chat", "");
      for (const q of qa) out.push(`**${q.question}?** ${q.answer}`, "");
    }

    return out.join("\n");
  }
}
