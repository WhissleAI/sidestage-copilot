// Twitch writes, behind the port every other write in this product goes through.
//
// The temptation here was an "action handler" interface for creator surfaces,
// parallel to `MarketplaceAdapter`. That would have been a second executor: a
// second idempotency ledger, a second two-phase commit, a second audit trail,
// a second undo window — and the second one is always the one that is wrong,
// because it is the one nobody has watched fail in production.
//
// So a Twitch action target is a `MarketplaceAdapter`. Reserve, apply, confirm,
// cancel, compensate. `ActionExecutor` does not know it is talking to Twitch and
// does not need to: it runs the same protocol, writes the same ledger row in the
// same transaction, appends the same audit entries, and offers the same undo.
//
// Three places where Twitch does not give us what the mock does, stated rather
// than smoothed over:
//
//   NO VERSIONS, ANYWHERE. Nothing this file writes has a revision to take an
//   optimistic lock on. `reserve` therefore checks the things that actually
//   invalidate a planned action — the channel went offline, a poll is already
//   running — which is weaker than the mock's guarantee and is the strongest
//   one the platform supports. That is the same trade `marketplace/ebay.ts`
//   documents for offers, for the same reason.
//
//   A LISTING SHAPE FOR A CHANNEL. `RemoteListing` was born on a marketplace,
//   so it has a price and a quantity. A channel has neither. The zeros below
//   mean NOT APPLICABLE and never "free": nothing reads them, because every
//   Twitch action kind is outside `LISTING_KINDS` in preflight and outside the
//   executor's `applyLocal` switch. `version` is the only field given real
//   content — a count of writes made on this channel, so the audit entry's
//   `remoteVersion` says something true instead of zero forever.
//
//   UNDO IS NOT UNIFORM. A poll can be ended and a posted message can be
//   deleted, so those two roll back properly. A clip, a stream marker, a
//   shoutout and an announcement cannot be withdrawn — Helix exposes no
//   endpoint, and in the last two cases the thing being undone is something
//   the channel already read. `compensate` says so and fails, rather than
//   returning success for work it did not do.

import type {
  ActionIntent, MarketplaceAdapter, RemoteListing, Reservation,
} from "../../actions/marketplace/port.js";
import { MarketplaceApplyError } from "../../actions/marketplace/port.js";
import type { TwitchApi } from "./api.js";

/** What `apply` did, so `compensate` has something to undo. */
interface Applied {
  kind: string;
  clipId?: string;
  clipUrl?: string;
  markerId?: string;
  pollId?: string;
  messageId?: string;
}

export class TwitchActions implements MarketplaceAdapter {
  readonly name = "twitch";

  private broadcasterId: string | null = null;
  private moderatorId: string | null = null;
  private reservations = new Map<string, Reservation>();
  /**
   * Base idempotency key → what the apply produced.
   *
   * Keyed by the BASE key because `ActionExecutor.rollback` builds a fresh
   * reservation whose intent carries `<key>:rollback`, and the clip id it needs
   * was recorded under `<key>`. Stripping the suffix is the join.
   *
   * In memory, deliberately: `action_commits.result` already holds the same
   * ids durably, and reaching into that table from here would give this
   * adapter a database dependency the port does not have. The cost is that a
   * restart between commit and undo loses the poll id — `compensate` says
   * exactly that rather than failing with a null reference.
   */
  private applied = new Map<string, Applied>();
  private writes = 0;

  constructor(
    private readonly api: TwitchApi,
    /** The channel login these actions act on — also the `listingId` every
     *  proposal carries, since a channel is what a Twitch action targets. */
    private readonly channel: string,
  ) {}

  private async ids(): Promise<{ broadcasterId: string; moderatorId: string }> {
    if (!this.broadcasterId) {
      const c = await this.api.userByLogin(this.channel);
      if (!c) throw new MarketplaceApplyError(`twitch has no channel called "${this.channel}"`);
      this.broadcasterId = c.id;
    }
    if (!this.moderatorId) {
      // Every moderator-scoped call wants the id of the account the token
      // belongs to. It is the bot, and it must be a moderator of the channel —
      // a 401 here means the broadcaster never granted that, which is a thing
      // an operator fixes in Twitch and not in this codebase.
      this.moderatorId = (await this.api.self()).id;
    }
    return { broadcasterId: this.broadcasterId, moderatorId: this.moderatorId };
  }

  /**
   * There is no catalog row behind a channel.
   *
   * Null is the honest answer and nothing on the commit path asks: the
   * executor calls `get` for listing writes only. A caller that does ask is
   * asking a catalog question about a Twitch channel, and inventing a row with
   * a price in it would answer it wrongly rather than not at all.
   */
  async get(): Promise<RemoteListing | null> {
    return null;
  }

  /**
   * Everything that can make a planned action impossible, checked BEFORE the
   * action is recorded as committing.
   *
   * Params are validated here rather than at apply for the same reason: a poll
   * with one choice is a bug in the proposer, and finding out at apply means an
   * audit entry that says a write was attempted when nothing was ever sendable.
   */
  async reserve(intent: ActionIntent): Promise<Reservation> {
    const { broadcasterId } = await this.ids();
    const p = intent.params as Record<string, unknown>;

    switch (intent.kind) {
      case "create_clip":
      case "mark_highlight": {
        // Both cut into the live video. An offline channel has no video, and
        // Helix answers with a 404 whose message does not say so.
        const live = await this.api.stream(broadcasterId);
        if (!live) {
          throw new MarketplaceApplyError(
            `#${this.channel} is not live — there is nothing to ${intent.kind === "create_clip" ? "clip" : "mark"}`,
          );
        }
        break;
      }
      case "run_poll": {
        const choices = asStrings(p.choices);
        if (choices.length < 2 || choices.length > 5) {
          throw new MarketplaceApplyError(`a twitch poll needs between 2 and 5 choices, not ${choices.length}`);
        }
        if (!String(p.title || "").trim()) throw new MarketplaceApplyError("a poll needs a question");
        const seconds = Number(p.durationSeconds ?? 0);
        if (!Number.isFinite(seconds) || seconds < 15 || seconds > 1800) {
          throw new MarketplaceApplyError("a twitch poll runs for between 15 and 1800 seconds");
        }
        // The nearest thing to a version conflict this surface has: somebody —
        // the host, another tool — started a poll after this one was planned.
        // Twitch would answer the POST with a 400 that reads like our bug.
        const running = (await this.api.polls(broadcasterId)).find((x) => x.status === "ACTIVE");
        if (running) {
          throw new MarketplaceApplyError(
            `a poll is already running on #${this.channel} ("${running.title}") — end it before starting another`,
          );
        }
        break;
      }
      case "shoutout": {
        const to = String(p.channel || "").trim().replace(/^@/, "");
        if (!to) throw new MarketplaceApplyError("a shoutout needs a channel to shout out");
        if (!(await this.api.userByLogin(to))) {
          throw new MarketplaceApplyError(`twitch has no channel called "${to}" to shout out`);
        }
        break;
      }
      case "pin_message":
      case "post_reply": {
        if (!String(p.message || "").trim()) throw new MarketplaceApplyError("there is no text to send");
        break;
      }
      default:
        throw new MarketplaceApplyError(`${intent.kind} has no twitch implementation`);
    }

    const res: Reservation = {
      token: `twitch_${intent.idempotencyKey}`,
      listingId: intent.listingId,
      expectedVersion: intent.expectedVersion,
      intent,
    };
    this.reservations.set(res.token, res);
    return res;
  }

  async apply(res: Reservation): Promise<RemoteListing> {
    const { broadcasterId, moderatorId } = await this.ids();
    const p = res.intent.params as Record<string, unknown>;
    const key = baseKey(res.intent.idempotencyKey);
    const record = (a: Applied) => this.applied.set(key, a);

    switch (res.intent.kind) {
      case "create_clip": {
        const clip = await this.api.createClip(broadcasterId);
        record({ kind: res.intent.kind, clipId: clip.id, clipUrl: clip.url });
        break;
      }
      case "mark_highlight": {
        const marker = await this.api.createMarker(broadcasterId, String(p.note || "highlight"));
        record({ kind: res.intent.kind, markerId: marker.id });
        break;
      }
      case "run_poll": {
        const poll = await this.api.createPoll(broadcasterId, {
          title: String(p.title),
          choices: asStrings(p.choices),
          durationSeconds: Number(p.durationSeconds),
        });
        record({ kind: res.intent.kind, pollId: poll.id });
        break;
      }
      case "shoutout": {
        const to = await this.api.userByLogin(String(p.channel).replace(/^@/, ""));
        await this.api.shoutout(broadcasterId, moderatorId, to!.id);
        record({ kind: res.intent.kind });
        break;
      }
      case "pin_message": {
        // Helix has no pin. The closest a bot can get is an announcement: the
        // line is highlighted in chat and stays legible in the scrollback,
        // which is the job "pin this" is actually asking for. Naming the kind
        // after the intent and the call after the platform is the honest split;
        // the console says "announce" on the card.
        await this.api.announce(broadcasterId, moderatorId, String(p.message));
        record({ kind: res.intent.kind });
        break;
      }
      case "post_reply": {
        const sent = await this.api.sendMessage(
          broadcasterId,
          moderatorId,
          String(p.message),
          p.replyToMessageId ? String(p.replyToMessageId) : undefined,
        );
        // A 200 whose body says the message was dropped is not a send. AutoMod
        // holds messages, and reporting this as committed would put a reply in
        // the audit log that no viewer ever saw.
        if (!sent.isSent) {
          throw new MarketplaceApplyError(
            `twitch accepted the reply and did not post it${sent.dropReason ? ` — ${sent.dropReason}` : ""}`,
          );
        }
        record({ kind: res.intent.kind, messageId: sent.messageId });
        break;
      }
      default:
        throw new MarketplaceApplyError(`${res.intent.kind} has no twitch implementation`);
    }

    return this.channelRow();
  }

  async confirm(res: Reservation): Promise<void> {
    this.reservations.delete(res.token);
  }

  async cancel(res: Reservation): Promise<void> {
    this.reservations.delete(res.token);
  }

  /**
   * Undo, where Twitch has an undo.
   *
   * `before` is empty for every kind here — preflight captures a listing
   * snapshot and a channel has no listing — so the inverse is reconstructed
   * from what `apply` recorded instead.
   *
   * Two kinds reverse cleanly. The rest do not, and the refusal is the point:
   * the executor marks the action failed and keeps the commit in the audit
   * chain, so what the operator sees is "this stands, and here is where to go",
   * rather than an undo button that reported success and changed nothing.
   */
  async compensate(res: Reservation): Promise<RemoteListing> {
    const { broadcasterId, moderatorId } = await this.ids();
    const key = baseKey(res.intent.idempotencyKey);
    const done = this.applied.get(key);
    const kind = done?.kind ?? res.intent.kind;

    if (!done) {
      throw new MarketplaceApplyError(
        `nothing recorded for this ${kind} on #${this.channel} — the process restarted since it committed, so the id it would need is gone. Undo it in the Twitch dashboard.`,
      );
    }

    switch (kind) {
      case "run_poll": {
        // Archived rather than terminated: an undo should take the poll off the
        // screen, not end it and leave the result standing.
        await this.api.endPoll(broadcasterId, done.pollId!, "ARCHIVED");
        return this.channelRow();
      }
      case "post_reply": {
        await this.api.deleteMessage(broadcasterId, moderatorId, done.messageId!);
        return this.channelRow();
      }
      case "create_clip":
        // Helix lists exactly two clip endpoints, Create and Get. There is no
        // delete, so this cannot be undone by us at any level of effort.
        throw new MarketplaceApplyError(
          `twitch exposes no way to delete a clip — ${done.clipUrl || done.clipId} still exists and has to be removed from the Creator Dashboard`,
        );
      case "mark_highlight":
        throw new MarketplaceApplyError(
          "twitch exposes no way to delete a stream marker — remove it in the video editor when the VOD is published",
        );
      case "shoutout":
        throw new MarketplaceApplyError(
          `the shoutout was shown to everyone watching #${this.channel} and cannot be taken back`,
        );
      case "pin_message":
        throw new MarketplaceApplyError(
          `the announcement was posted in #${this.channel} chat and cannot be unsaid — a moderator can delete the line`,
        );
      default:
        throw new MarketplaceApplyError(`${kind} has no twitch compensation`);
    }
  }

  /** The port's shape, filled in as far as a channel can fill it. See the
   *  note at the top of this file about what the zeros mean. */
  private channelRow(): RemoteListing {
    return {
      id: this.channel,
      priceCents: 0,
      qty: 0,
      state: "live",
      pinned: false,
      version: ++this.writes,
    };
  }
}

/** `ActionExecutor.rollback` suffixes the key; the apply recorded under the
 *  base. Nothing else in the codebase mints a key ending this way. */
const baseKey = (k: string): string => k.replace(/:rollback$/, "");

const asStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
