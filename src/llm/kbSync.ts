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
import type { ShowRuntime } from "../shows/runtime.js";
import { formatMoney } from "../domain/money.js";

/** Wait this long after the last lineup change before writing. A card show
 *  opens a lot every ~40s; re-uploading per lot would be pointless churn. */
const DEBOUNCE_MS = 45_000;

export class KbSync {
  private timers = new Map<string, NodeJS.Timeout>();
  private lastSignature = new Map<string, string>();

  /** Sync now. Returns false when there was nothing new to say. */
  async syncShow(rt: ShowRuntime): Promise<{ uploaded: boolean; lots: number; reason?: string }> {
    // Sync to the show's OWN agent — the one its catalog owns — so a lineup
    // never lands on another seller's knowledge base.
    const agentId = rt.agentId;
    if (!config.whissle.apiKey || !agentId) {
      return { uploaded: false, lots: 0, reason: "no Whissle credentials" };
    }

    const listings = rt.repo.listings();
    const signature = listings.map((l) => l.id).sort().join(",");
    if (this.lastSignature.get(rt.showId) === signature) {
      return { uploaded: false, lots: listings.length, reason: "lineup unchanged" };
    }

    const title = `sidestage-show-${rt.showId}`;
    const doc = this.render(rt);

    // Replace rather than accumulate: an agent that collects six stale copies of
    // the same lineup will retrieve the wrong one.
    await this.removePrevious(agentId, title);
    await rt.llm.uploadKb(`${title}.md`, doc);

    this.lastSignature.set(rt.showId, signature);
    return { uploaded: true, lots: listings.length };
  }

  /** Coalesce a burst of lineup changes into one upload. */
  scheduleSync(rt: ShowRuntime): void {
    const existing = this.timers.get(rt.showId);
    if (existing) clearTimeout(existing);
    this.timers.set(
      rt.showId,
      setTimeout(() => {
        this.timers.delete(rt.showId);
        void this.syncShow(rt).catch((e) => console.warn(`[kb] ${rt.showId}: ${(e as Error).message}`));
      }, DEBOUNCE_MS),
    );
  }

  cancel(showId: string): void {
    const t = this.timers.get(showId);
    if (t) clearTimeout(t);
    this.timers.delete(showId);
    this.lastSignature.delete(showId);
  }

  private async removePrevious(agentId: string, title: string): Promise<void> {
    try {
      const r = await fetch(`${config.whissle.base}/api/agents/${agentId}/kb`, {
        headers: { Authorization: `Bearer ${config.whissle.apiKey}` },
      });
      if (!r.ok) return;
      const body = (await r.json()) as { id: string; title?: string }[] | { documents?: { id: string; title?: string }[] };
      const docs = Array.isArray(body) ? body : body.documents || [];
      for (const d of docs) {
        if ((d.title || "").startsWith(title)) {
          await fetch(`${config.whissle.base}/api/agents/${agentId}/kb/${d.id}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${config.whissle.apiKey}` },
          }).catch(() => {});
        }
      }
    } catch {
      // A failed cleanup must not block the upload; a duplicate is recoverable,
      // a missing corpus is not.
    }
  }

  private render(rt: ShowRuntime): string {
    const show = rt.repo.show();
    const listings = rt.repo.listings();
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

    const policies = rt.repo.policies();
    if (policies.length) {
      out.push("## Store policies", "");
      for (const p of policies) out.push(`### ${p.title} (${p.topic})`, "", p.body, "");
    }

    const qa = rt.repo.qa();
    if (qa.length) {
      out.push("## Frequently asked in chat", "");
      for (const q of qa) out.push(`**${q.question}?** ${q.answer}`, "");
    }

    return out.join("\n");
  }
}
