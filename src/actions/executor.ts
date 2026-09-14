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

import type { Pool, Queryable } from "../db/pg.js";
import { tx } from "../db/pg.js";
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
  rationale: string; status: string;
  /** jsonb columns — already parsed by the driver. */
  params: Record<string, unknown>; before_state: Record<string, unknown>;
  preflight: ActionProposal["preflight"];
  idempotency_key: string; undoable_until: string | null; error: string | null; created_at: string;
}

const toAction = (r: ActionRow): ActionProposal => ({
  id: r.id, kind: r.kind as ActionKind, listingId: r.listing_id, listingTitle: r.listing_title,
  summary: r.summary, rationale: r.rationale,
  params: r.params,
  before: r.before_state,
  status: r.status as ActionStatus,
  preflight: r.preflight,
  idempotencyKey: r.idempotency_key,
  undoableUntil: r.undoable_until,
  ...(r.error ? { error: r.error } : {}),
  createdAt: r.created_at,
});

export class ActionStore {
  constructor(private d: Pool, private showId: string) {}

  /** The store bound to a transaction client, so a commit's listing mutation
   *  and its ledger row land together. */
  private on(c: Queryable): ActionStore {
    const s = new ActionStore(this.d, this.showId);
    (s as unknown as { d: Queryable }).d = c;
    return s;
  }

  async insert(a: ActionProposal): Promise<void> {
    await this.d.query(`
      INSERT INTO actions (show_id, id, kind, listing_id, listing_title, summary, rationale, params,
        before_state, status, preflight, idempotency_key, undoable_until, error, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11::jsonb,$12,$13,$14,$15)`,
      [this.showId, a.id, a.kind, a.listingId, a.listingTitle, a.summary, a.rationale,
       JSON.stringify(a.params), JSON.stringify(a.before), a.status, JSON.stringify(a.preflight),
       a.idempotencyKey, a.undoableUntil, a.error ?? null, a.createdAt],
    );
  }

  async get(id: string): Promise<ActionProposal | null> {
    const r = await this.d.query<ActionRow>(
      "SELECT * FROM actions WHERE show_id = $1 AND id = $2", [this.showId, id],
    );
    return r.rows[0] ? toAction(r.rows[0]) : null;
  }

  async list(limit = 100): Promise<ActionProposal[]> {
    const r = await this.d.query<ActionRow>(
      "SELECT * FROM actions WHERE show_id = $1 ORDER BY created_at DESC LIMIT $2", [this.showId, limit],
    );
    return r.rows.map(toAction);
  }

  async patch(
    id: string,
    p: { status?: ActionStatus; undoableUntil?: string | null; error?: string | null },
  ): Promise<ActionProposal> {
    const sets: string[] = [];
    const args: unknown[] = [this.showId, id];
    const put = (col: string, v: unknown) => { args.push(v); sets.push(`${col} = $${args.length}`); };
    if (p.status !== undefined) put("status", p.status);
    if (p.undoableUntil !== undefined) put("undoable_until", p.undoableUntil);
    if (p.error !== undefined) put("error", p.error);
    if (sets.length) {
      const r = await this.d.query<ActionRow>(
        `UPDATE actions SET ${sets.join(", ")} WHERE show_id = $1 AND id = $2 RETURNING *`, args,
      );
      if (r.rows[0]) return toAction(r.rows[0]);
    }
    return (await this.get(id))!;
  }

  /** The action carrying this idempotency key, if one already exists. */
  async byIdempotencyKey(key: string): Promise<ActionProposal | null> {
    const r = await this.d.query<ActionRow>(
      "SELECT * FROM actions WHERE show_id = $1 AND idempotency_key = $2", [this.showId, key],
    );
    return r.rows[0] ? toAction(r.rows[0]) : null;
  }

  /** Has this exact intent already been committed? */
  async commitFor(idemKey: string): Promise<{ action_id: string; committed_at: string; result: unknown } | null> {
    const r = await this.d.query<{ action_id: string; committed_at: string; result: unknown }>(
      "SELECT action_id, committed_at, result FROM action_commits WHERE show_id = $1 AND idempotency_key = $2",
      [this.showId, idemKey],
    );
    return r.rows[0] ?? null;
  }

  async committedThisShow(): Promise<number> {
    const r = await this.d.query<{ c: number }>(
      "SELECT COUNT(*)::int AS c FROM actions WHERE show_id = $1 AND status IN ('committed','rolled_back')",
      [this.showId],
    );
    return r.rows[0]?.c ?? 0;
  }

  async committedLastMinute(): Promise<number> {
    const since = new Date(Date.now() - 60_000).toISOString();
    const r = await this.d.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM action_commits ac
       WHERE ac.show_id = $1 AND ac.committed_at >= $2`, [this.showId, since],
    );
    return r.rows[0]?.c ?? 0;
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
    private d: Pool,
    private repo: Repo,
    private adapter: MarketplaceAdapter,
    private audit: AuditLog,
    private opts: ExecutorOpts,
  ) {
    this.store = new ActionStore(d, repo.showId);
  }

  list(limit?: number): Promise<ActionProposal[]> {
    return this.store.list(limit);
  }

  get(id: string): Promise<ActionProposal | null> {
    return this.store.get(id);
  }

  /** Create a proposal: run preflight, capture `before`, persist, audit. */
  async propose(kind: ActionKind, listingId: string, params: Record<string, unknown>, summary: string, rationale: string): Promise<ActionProposal> {
    const listing = await this.repo.listing(listingId);
    const pre: PreflightResult = preflight(
      kind, listing, params,
      await showBudgetContext(this.repo, {
        committedThisShow: await this.store.committedThisShow(),
        committedLastMinute: await this.store.committedLastMinute(),
      }),
    );

    // The same intent against the same listing VERSION is the same action, not a
    // new one — that is what the idempotency key means. Returning the existing
    // row keeps a restarted process (whose in-memory dedupe set is empty) from
    // colliding with actions already on disk.
    const key = idempotencyKey(kind, listingId, Number(pre.before.version ?? 0), params);
    const prior = await this.store.byIdempotencyKey(key);
    if (prior) return prior;

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
      idempotencyKey: key,
      undoableUntil: null,
      createdAt: new Date().toISOString(),
    };

    await this.store.insert(action);
    await this.audit.append(
      pre.ok ? "action_proposed" : "action_preflight_failed",
      "copilot",
      pre.ok ? summary : `blocked before approval: ${summary}`,
      { actionId: action.id, kind, listingId, params, failedChecks: pre.checks.filter((c) => !c.ok) },
    );
    this.opts.onChange?.(action);
    return action;
  }

  async reject(id: string, actor: "seller" | "system" = "seller"): Promise<ActionProposal> {
    const a = await this.store.patch(id, { status: "rejected" });
    await this.audit.append("action_proposed", actor, `rejected: ${a.summary}`, { actionId: id, outcome: "rejected" });
    this.opts.onChange?.(a);
    return a;
  }

  /** Approve and commit. See the protocol note at the top of this file. */
  async approve(id: string, actor: "seller" | "copilot" = "seller"): Promise<ActionProposal> {
    let action = await this.store.get(id);
    if (!action) throw new Error(`action ${id} not found`);
    if (action.status === "committed") return action;
    if (!action.preflight.ok) {
      return this.fail(action, "preflight did not pass; this action cannot be committed");
    }

    // 1. idempotency
    const prior = await this.store.commitFor(action.idempotencyKey);
    if (prior) {
      const a = await this.store.patch(id, { status: "committed", error: null });
      this.opts.onChange?.(a);
      return a;
    }

    action = await this.store.patch(id, { status: "committing", error: null });
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
      await tx(this.d, async (c) => {
        // The repo is REBOUND to this client, so the listing mutation and the
        // ledger insert are one atomic unit. That pairing is the whole of the
        // idempotency claim: a retried commit finds the ledger row and stops.
        await this.applyLocal(action!, this.repo.bind(c));
        await c.query(
          "INSERT INTO action_commits (idempotency_key, show_id, action_id, committed_at, result) VALUES ($1,$2,$3,$4,$5::jsonb)",
          [action!.idempotencyKey, this.repo.showId, action!.id, new Date().toISOString(), JSON.stringify(remote)],
        );
      });
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
    const committed = await this.store.patch(id, { status: "committed", undoableUntil, error: null });
    await this.audit.append("action_committed", actor, action.summary, {
      actionId: id, kind: action.kind, listingId: action.listingId,
      params: action.params, before: action.before, remoteVersion: remote.version,
      idempotencyKey: action.idempotencyKey,
    });
    this.opts.onChange?.(committed);
    return committed;
  }

  /** Compensating write, from the snapshot captured at preflight. */
  async rollback(id: string, actor: "seller" | "system" = "seller"): Promise<ActionProposal> {
    const action = await this.store.get(id);
    if (!action) throw new Error(`action ${id} not found`);
    if (action.status !== "committed") {
      return this.fail(action, `only a committed action can be rolled back (this one is ${action.status})`);
    }

    const current = await this.repo.listing(action.listingId);
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

    await tx(this.d, async (c) => {
      await this.repo.bind(c).mutateListing(action.listingId, {
        priceCents: action.before.priceCents as number,
        qty: action.before.qty as number,
        state: action.before.state as never,
        pinned: action.before.pinned as boolean,
      });
      await c.query(
        `INSERT INTO action_commits (idempotency_key, show_id, action_id, committed_at, result)
         VALUES ($1,$2,$3,$4,$5::jsonb)
         ON CONFLICT (show_id, idempotency_key) DO UPDATE SET committed_at = EXCLUDED.committed_at, result = EXCLUDED.result`,
        [`${action.idempotencyKey}:rollback`, this.repo.showId, action.id, new Date().toISOString(),
         JSON.stringify(action.before)],
      );
    });
    this.opts.onListingWrite?.(action.listingId);

    const rolled = await this.store.patch(id, { status: "rolled_back", undoableUntil: null });
    await this.audit.append("action_rolled_back", actor, `rolled back: ${action.summary}`, {
      actionId: id, restoredTo: action.before, kind: action.kind, listingId: action.listingId,
    });
    this.opts.onChange?.(rolled);
    return rolled;
  }

  /** Apply the action's effect to our own listing row. */
  private async applyLocal(a: ActionProposal, repo: Repo = this.repo): Promise<void> {
    switch (a.kind) {
      case "markdown_price":
        await repo.mutateListing(a.listingId, { priceCents: Number(a.params.newPriceCents) });
        break;
      case "adjust_stock":
        await repo.mutateListing(a.listingId, { qty: Number(a.params.newQty) });
        break;
      case "swap_pinned":
        await repo.setPinned(a.listingId);
        await repo.mutateListing(a.listingId, { state: "live" });
        break;
      case "push_listing":
        await repo.mutateListing(a.listingId, { state: "live" });
        break;
      case "end_listing":
        await repo.mutateListing(a.listingId, { state: "ended", pinned: false });
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

  private async fail(a: ActionProposal, error: string): Promise<ActionProposal> {
    const failed = await this.store.patch(a.id, { status: "failed", error });
    await this.audit.append("action_failed", "system", `failed: ${a.summary}`, { actionId: a.id, error });
    this.opts.onChange?.(failed);
    return failed;
  }
}
