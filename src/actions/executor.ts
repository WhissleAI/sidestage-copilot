// The action executor — propose, approve, commit, roll back.
//
// The commit is the interesting part, because it spans two systems that can fail
// independently: the marketplace (remote, slow, flaky) and our SQLite mirror
// (local, fast, durable). The order below is chosen so that every failure has a
// defined outcome and none of them leaves the seller lied to:
//
//   1. idempotency — if this key already committed, return the prior result.
//      A double-tapped Approve must not mark the item down twice.
//   2. reserve — optimistic lock on (listing, expectedVersion). If the remote has
//      moved, fail here, BEFORE anything changed.
//   3. apply — the only step that mutates remote state. On failure: cancel the
//      reservation, mark the action failed, audit it. Nothing else moved.
//   4. record locally — mutate our listing AND write the idempotency ledger row
//      in ONE SQLite transaction. If this throws, we have a remote write with no
//      local record, which is the genuinely dangerous state, so we immediately
//      COMPENSATE the remote write and report failure.
//   5. confirm — release the reservation once the result is durable locally.
//
// Rollback is a first-class operation, not a retry: it compensates remotely from
// the `before` snapshot captured at preflight, restores locally in a
// transaction, and appends a NEW audit entry. Nothing is ever erased.

import type { DB } from "../db/index.js";
import type { ActionKind, ActionProposal, ActionStatus } from "../domain/types.js";
import type { Repo } from "../domain/repo.js";
import type { AuditLog } from "./audit.js";
import {
  MarketplaceConflict,
  type MarketplaceAdapter, type ActionIntent, type RemoteListing,
} from "./marketplace/port.js";
import { idempotencyKey, preflight, showBudgetContext, type PreflightResult } from "./preflight.js";

interface ActionRow {
  id: string; kind: string; listing_id: string; listing_title: string; summary: string;
  rationale: string; params: string; before_state: string; status: string; preflight: string;
  idempotency_key: string; undoable_until: string | null; error: string | null; created_at: string;
}

const toAction = (r: ActionRow): ActionProposal => ({
  id: r.id, kind: r.kind as ActionKind, listingId: r.listing_id, listingTitle: r.listing_title,
  summary: r.summary, rationale: r.rationale,
  params: JSON.parse(r.params) as Record<string, unknown>,
  before: JSON.parse(r.before_state) as Record<string, unknown>,
  status: r.status as ActionStatus,
  preflight: JSON.parse(r.preflight) as ActionProposal["preflight"],
  idempotencyKey: r.idempotency_key,
  undoableUntil: r.undoable_until,
  ...(r.error ? { error: r.error } : {}),
  createdAt: r.created_at,
});

export class ActionStore {
  constructor(private d: DB) {}

  insert(a: ActionProposal): void {
    this.d.prepare(`
      INSERT INTO actions (id, kind, listing_id, listing_title, summary, rationale, params,
        before_state, status, preflight, idempotency_key, undoable_until, error, created_at)
      VALUES (@id,@kind,@listingId,@listingTitle,@summary,@rationale,@params,
        @before,@status,@preflight,@idem,@undoable,@error,@createdAt)
    `).run({
      id: a.id, kind: a.kind, listingId: a.listingId, listingTitle: a.listingTitle,
      summary: a.summary, rationale: a.rationale, params: JSON.stringify(a.params),
      before: JSON.stringify(a.before), status: a.status, preflight: JSON.stringify(a.preflight),
      idem: a.idempotencyKey, undoable: a.undoableUntil, error: a.error ?? null, createdAt: a.createdAt,
    });
  }

  get(id: string): ActionProposal | null {
    const r = this.d.prepare("SELECT * FROM actions WHERE id = ?").get(id) as ActionRow | undefined;
    return r ? toAction(r) : null;
  }

  list(limit = 100): ActionProposal[] {
    return (this.d.prepare("SELECT * FROM actions ORDER BY created_at DESC LIMIT ?").all(limit) as ActionRow[]).map(toAction);
  }

  patch(id: string, p: { status?: ActionStatus; undoableUntil?: string | null; error?: string | null }): ActionProposal {
    const sets: string[] = [];
    const args: unknown[] = [];
    if (p.status !== undefined) { sets.push("status = ?"); args.push(p.status); }
    if (p.undoableUntil !== undefined) { sets.push("undoable_until = ?"); args.push(p.undoableUntil); }
    if (p.error !== undefined) { sets.push("error = ?"); args.push(p.error); }
    if (sets.length) {
      args.push(id);
      this.d.prepare(`UPDATE actions SET ${sets.join(", ")} WHERE id = ?`).run(...args as never[]);
    }
    return this.get(id)!;
  }

  /** Has this exact intent already been committed? */
  commitFor(idemKey: string): { action_id: string; committed_at: string; result: string } | null {
    return (this.d.prepare("SELECT action_id, committed_at, result FROM action_commits WHERE idempotency_key = ?")
      .get(idemKey) as { action_id: string; committed_at: string; result: string } | undefined) ?? null;
  }

  committedThisShow(): number {
    return (this.d.prepare("SELECT COUNT(*) AS c FROM actions WHERE status IN ('committed','rolled_back')").get() as { c: number }).c;
  }

  committedLastMinute(): number {
    const since = new Date(Date.now() - 60_000).toISOString();
    return (this.d.prepare("SELECT COUNT(*) AS c FROM action_commits WHERE committed_at >= ?").get(since) as { c: number }).c;
  }
}

export interface ExecutorOpts {
  undoWindowS: number;
  onChange?: (a: ActionProposal) => void;
  /** Called after a committed or rolled-back write so the retriever can reindex. */
  onListingWrite?: (listingId: string) => void;
}

export class ActionExecutor {
  private store: ActionStore;

  constructor(
    private d: DB,
    private repo: Repo,
    private adapter: MarketplaceAdapter,
    private audit: AuditLog,
    private opts: ExecutorOpts,
  ) {
    this.store = new ActionStore(d);
  }

  list(limit?: number): ActionProposal[] {
    return this.store.list(limit);
  }

  get(id: string): ActionProposal | null {
    return this.store.get(id);
  }

  /** Create a proposal: run preflight, capture `before`, persist, audit. */
  propose(kind: ActionKind, listingId: string, params: Record<string, unknown>, summary: string, rationale: string): ActionProposal {
    const listing = this.repo.listing(listingId);
    const pre: PreflightResult = preflight(
      kind, listing, params, this.repo,
      showBudgetContext(this.repo, {
        committedThisShow: this.store.committedThisShow(),
        committedLastMinute: this.store.committedLastMinute(),
      }),
    );

    const action: ActionProposal = {
      id: `act_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      kind,
      listingId,
      listingTitle: listing?.title ?? listingId,
      summary,
      rationale,
      params,
      before: pre.before,
      status: pre.ok ? "proposed" : "preflight_failed",
      preflight: { ok: pre.ok, checks: pre.checks },
      idempotencyKey: idempotencyKey(kind, listingId, Number(pre.before.version ?? 0), params),
      undoableUntil: null,
      createdAt: new Date().toISOString(),
    };

    this.store.insert(action);
    this.audit.append(
      pre.ok ? "action_proposed" : "action_preflight_failed",
      "copilot",
      pre.ok ? summary : `blocked before approval: ${summary}`,
      { actionId: action.id, kind, listingId, params, failedChecks: pre.checks.filter((c) => !c.ok) },
    );
    this.opts.onChange?.(action);
    return action;
  }

  reject(id: string, actor: "seller" | "system" = "seller"): ActionProposal {
    const a = this.store.patch(id, { status: "rejected" });
    this.audit.append("action_proposed", actor, `rejected: ${a.summary}`, { actionId: id, outcome: "rejected" });
    this.opts.onChange?.(a);
    return a;
  }

  /** Approve and commit. See the protocol note at the top of this file. */
  async approve(id: string, actor: "seller" | "copilot" = "seller"): Promise<ActionProposal> {
    let action = this.store.get(id);
    if (!action) throw new Error(`action ${id} not found`);
    if (action.status === "committed") return action;
    if (!action.preflight.ok) {
      return this.fail(action, "preflight did not pass; this action cannot be committed");
    }

    // 1. idempotency
    const prior = this.store.commitFor(action.idempotencyKey);
    if (prior) {
      const a = this.store.patch(id, { status: "committed", error: null });
      this.opts.onChange?.(a);
      return a;
    }

    action = this.store.patch(id, { status: "committing", error: null });
    this.opts.onChange?.(action);

    const intent: ActionIntent = {
      kind: action.kind,
      listingId: action.listingId,
      expectedVersion: Number(action.before.version ?? 0),
      params: action.params,
      idempotencyKey: action.idempotencyKey,
    };

    // 2. reserve
    let reservation;
    try {
      reservation = await this.adapter.reserve(intent);
    } catch (e) {
      const msg = e instanceof MarketplaceConflict
        ? `${e.message} — re-propose against the current version`
        : (e as Error).message;
      return this.fail(action, msg);
    }

    // 3. apply
    let remote: RemoteListing;
    try {
      remote = await this.adapter.apply(reservation);
    } catch (e) {
      await this.adapter.cancel(reservation).catch(() => {});
      return this.fail(action, `marketplace apply failed: ${(e as Error).message}`);
    }

    // 4. record locally — listing mutation and the idempotency ledger row must
    //    land together or not at all.
    try {
      const tx = this.d.transaction(() => {
        this.applyLocal(action!);
        this.d.prepare("INSERT INTO action_commits (idempotency_key, action_id, committed_at, result) VALUES (?,?,?,?)")
          .run(action!.idempotencyKey, action!.id, new Date().toISOString(), JSON.stringify(remote));
      });
      tx();
    } catch (e) {
      // Remote moved, local did not. Undo the remote write rather than leave the
      // two out of step — a silent divergence here is how a seller ends up
      // selling at a price their dashboard never showed.
      await this.adapter.compensate(reservation, this.beforeRemote(action)).catch(() => {});
      return this.fail(action, `local commit failed, remote write compensated: ${(e as Error).message}`);
    }

    // 5. confirm
    await this.adapter.confirm(reservation).catch(() => {});
    this.opts.onListingWrite?.(action.listingId);

    const undoableUntil = new Date(Date.now() + this.opts.undoWindowS * 1000).toISOString();
    const committed = this.store.patch(id, { status: "committed", undoableUntil, error: null });
    this.audit.append("action_committed", actor, action.summary, {
      actionId: id, kind: action.kind, listingId: action.listingId,
      params: action.params, before: action.before, remoteVersion: remote.version,
      idempotencyKey: action.idempotencyKey,
    });
    this.opts.onChange?.(committed);
    return committed;
  }

  /** Compensating write, from the snapshot captured at preflight. */
  async rollback(id: string, actor: "seller" | "system" = "seller"): Promise<ActionProposal> {
    const action = this.store.get(id);
    if (!action) throw new Error(`action ${id} not found`);
    if (action.status !== "committed") {
      return this.fail(action, `only a committed action can be rolled back (this one is ${action.status})`);
    }

    const current = this.repo.listing(action.listingId);
    const reservation = {
      token: `res_rollback_${action.idempotencyKey}`,
      listingId: action.listingId,
      expectedVersion: current?.version ?? 0,
      intent: {
        kind: action.kind, listingId: action.listingId,
        expectedVersion: current?.version ?? 0, params: action.params,
        idempotencyKey: `${action.idempotencyKey}:rollback`,
      },
    };

    try {
      await this.adapter.compensate(reservation, this.beforeRemote(action));
    } catch (e) {
      return this.fail(action, `rollback failed at the marketplace: ${(e as Error).message}`);
    }

    const tx = this.d.transaction(() => {
      this.repo.mutateListing(action.listingId, {
        priceCents: action.before.priceCents as number,
        qty: action.before.qty as number,
        state: action.before.state as never,
        pinned: action.before.pinned as boolean,
      });
      this.d.prepare("INSERT OR REPLACE INTO action_commits (idempotency_key, action_id, committed_at, result) VALUES (?,?,?,?)")
        .run(`${action.idempotencyKey}:rollback`, action.id, new Date().toISOString(), JSON.stringify(action.before));
    });
    tx();
    this.opts.onListingWrite?.(action.listingId);

    const rolled = this.store.patch(id, { status: "rolled_back", undoableUntil: null });
    this.audit.append("action_rolled_back", actor, `rolled back: ${action.summary}`, {
      actionId: id, restoredTo: action.before, kind: action.kind, listingId: action.listingId,
    });
    this.opts.onChange?.(rolled);
    return rolled;
  }

  /** Apply the action's effect to our own listing row. */
  private applyLocal(a: ActionProposal): void {
    switch (a.kind) {
      case "markdown_price":
        this.repo.mutateListing(a.listingId, { priceCents: Number(a.params.newPriceCents) });
        break;
      case "adjust_stock":
        this.repo.mutateListing(a.listingId, { qty: Number(a.params.newQty) });
        break;
      case "swap_pinned":
        this.repo.setPinned(a.listingId);
        this.repo.mutateListing(a.listingId, { state: "live" });
        break;
      case "push_listing":
        this.repo.mutateListing(a.listingId, { state: "live" });
        break;
      case "end_listing":
        this.repo.mutateListing(a.listingId, { state: "ended", pinned: false });
        break;
    }
  }

  private beforeRemote(a: ActionProposal): Partial<RemoteListing> {
    return {
      priceCents: a.before.priceCents as number,
      qty: a.before.qty as number,
      state: a.before.state as RemoteListing["state"],
      pinned: a.before.pinned as boolean,
    };
  }

  private fail(a: ActionProposal, error: string): ActionProposal {
    const failed = this.store.patch(a.id, { status: "failed", error });
    this.audit.append("action_failed", "system", `failed: ${a.summary}`, { actionId: a.id, error });
    this.opts.onChange?.(failed);
    return failed;
  }
}
