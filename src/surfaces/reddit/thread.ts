// Reddit's wire shapes, and the branch a draft has to answer.
//
// Reddit calls everything a "thing" and gives each one a **fullname** — `t3_…`
// for a post, `t1_…` for a comment — which is the id its `parent_id` and
// `link_id` point at. Every id in this file is a fullname for exactly that
// reason: the thread engine rebuilds a branch by following parents, so the ids
// it walks and the ids the platform links with have to be the same strings. Use
// the short `id` instead and every parent lookup misses, the branch comes back
// empty, and the draft answers a comment with no idea what it is replying to.
//
// A comment tree arrives as two listings in one array — the post, then the
// comments — with `more` placeholders where Reddit declined to expand a deep
// subthread. The placeholders are skipped rather than followed: expanding them
// costs a request each, and the branch ABOVE the message being answered is
// never behind one (Reddit collapses siblings, not ancestors).

import { buildThreadContext, type ThreadContext, type ThreadMessage } from "../../ingest/threadContext.js";
import type { Fact } from "../../retrieval/facts.js";
import type { RedditClient } from "./api.js";

// ── what Reddit sends ─────────────────────────────────────────────────────────

export interface RedditPostData {
  name: string;          // fullname, t3_…
  id: string;
  author: string;
  title: string;
  selftext?: string;
  created_utc: number;
  subreddit: string;
  permalink?: string;
  num_comments?: number;
  link_flair_text?: string | null;
}

export interface RedditCommentData {
  name: string;          // fullname, t1_…
  id: string;
  author: string;
  body: string;
  created_utc: number;
  subreddit: string;
  permalink?: string;
  /** `t3_…` when the comment is top level, `t1_…` when it replies to one. */
  parent_id?: string;
  /** The post the comment lives under, always `t3_…`. */
  link_id?: string;
  link_title?: string;
  replies?: RedditListing | "" | null;
}

export type RedditThing =
  | { kind: "t3"; data: RedditPostData }
  | { kind: "t1"; data: RedditCommentData }
  | { kind: "more"; data: unknown };

export interface RedditListing {
  kind: "Listing";
  data: { after?: string | null; before?: string | null; children: RedditThing[] };
}

/** A comment or post, in this codebase's vocabulary. */
export interface RedditMessage {
  /** The fullname. Also the dedupe key and the id the thread engine walks. */
  id: string;
  author: string;
  text: string;
  at: string;
  /** The post this belongs to — `t3_…` for both posts and comments. */
  threadId: string;
  /** The thing directly above it, absent for a post. */
  parentId?: string;
  room: string;
  permalink?: string;
}

const at = (createdUtc: number): string => new Date(Math.round(createdUtc * 1000)).toISOString();

/** Reddit's tombstones. A deleted body is not content to answer and not an
 *  author to address, but it is still a rung in the branch — dropping it would
 *  silently reparent everything below it. */
export const DELETED = new Set(["[deleted]", "[removed]"]);

export function postToMessage(p: RedditPostData): RedditMessage {
  // Title and body are one utterance to a reader: a post whose whole question
  // is in its title has an empty `selftext`, and carrying only the body would
  // hand the composer a thread that opens with nothing.
  const body = (p.selftext || "").trim();
  return {
    id: p.name,
    author: p.author,
    text: body ? `${p.title}\n\n${body}` : p.title,
    at: at(p.created_utc),
    threadId: p.name,
    room: `r/${p.subreddit}`,
    permalink: p.permalink,
  };
}

export function commentToMessage(c: RedditCommentData): RedditMessage {
  return {
    id: c.name,
    author: c.author,
    text: c.body,
    at: at(c.created_utc),
    // A comment with no `link_id` is not something Reddit sends, but a fixture
    // or a truncated response could: fall back to the parent so the message
    // still groups with its conversation rather than becoming its own thread.
    threadId: c.link_id || c.parent_id || c.name,
    parentId: c.parent_id,
    room: `r/${c.subreddit}`,
    permalink: c.permalink,
  };
}

/** Every post and comment in a listing, `more` placeholders skipped. */
export function messagesFromListing(listing: RedditListing | null | undefined): RedditMessage[] {
  const out: RedditMessage[] = [];
  for (const child of listing?.data?.children ?? []) {
    if (child.kind === "t3") out.push(postToMessage(child.data));
    else if (child.kind === "t1") out.push(commentToMessage(child.data));
  }
  return out;
}

/**
 * Flatten a comment tree.
 *
 * Reddit nests replies inside each comment rather than returning a flat list,
 * so the shape has to be walked. Depth is bounded because `replies` is data
 * from another platform: a cycle or a pathological nesting would otherwise take
 * the poller's process with it.
 */
export function flattenTree(listing: RedditListing | null | undefined, depth = 0): RedditMessage[] {
  if (!listing || depth > 32) return [];
  const out: RedditMessage[] = [];
  for (const child of listing.data?.children ?? []) {
    if (child.kind === "t1") {
      out.push(commentToMessage(child.data));
      const replies = child.data.replies;
      if (replies && typeof replies === "object") out.push(...flattenTree(replies, depth + 1));
    } else if (child.kind === "t3") {
      out.push(postToMessage(child.data));
    }
  }
  return out;
}

export interface RedditThread {
  /** The opening post. Null only for a tree fetched without its post. */
  post: RedditMessage | null;
  /** Every comment, flattened, in the order Reddit returned them. */
  comments: RedditMessage[];
  room: string;
  threadId: string;
}

/** The two-listing payload `/comments/<id>` returns, as a thread. */
export function parseCommentTree(payload: unknown): RedditThread {
  const parts = Array.isArray(payload) ? (payload as RedditListing[]) : [];
  const post = messagesFromListing(parts[0]).find((m) => m.id.startsWith("t3_")) ?? null;
  const comments = flattenTree(parts[1]);
  const threadId = post?.id ?? comments[0]?.threadId ?? "";
  return { post, comments, room: post?.room ?? comments[0]?.room ?? "", threadId, };
}

/**
 * The thread as the composer sees it: the opening post, then the branch above
 * the message being answered, oldest first.
 *
 * The post is spliced in as the root when it is not already an ancestor,
 * because a top-level comment's parent IS the post and `branchAbove` will only
 * find it if it is in the same list. Without that, every reply to a top-level
 * comment would arrive with no idea what the thread was about.
 */
export function threadContextFor(
  thread: RedditThread,
  leafId: string,
  rules: Fact[] = [],
  summary: string | null = null,
): ThreadContext {
  const messages: ThreadMessage[] = [
    ...(thread.post ? [thread.post] : []),
    ...thread.comments,
  ].map((m) => ({ id: m.id, author: m.author, text: m.text, at: m.at, parentId: m.parentId ?? null }));

  return buildThreadContext({
    threadId: thread.threadId,
    room: thread.room,
    messages,
    leafId,
    rules,
    summary,
  });
}

/**
 * Fetch one thread.
 *
 * `depth` and `limit` are bounded here rather than left to Reddit's defaults:
 * a front-page thread has thousands of comments, all but a handful of which are
 * other people arguing with each other, and the branch this exists to rebuild
 * is at most eight deep.
 */
export async function fetchThread(
  client: RedditClient,
  o: { subreddit?: string; threadId: string; limit?: number },
): Promise<RedditThread> {
  const id = o.threadId.replace(/^t3_/, "");
  const path = o.subreddit ? `/r/${o.subreddit}/comments/${id}` : `/comments/${id}`;
  const payload = await client.get<unknown>(path, { limit: o.limit ?? 200, depth: 8, sort: "old" });
  return parseCommentTree(payload);
}
