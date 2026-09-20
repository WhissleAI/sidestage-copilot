-- The drafts queue, after a restart.
--
-- `GET /api/drafts` read the async half of the queue out of live in-memory
-- runtimes: `shows.list()` → `shows.get(id).pipeline.list()`. The drafts
-- themselves were durable the whole time — `SessionRecord.recordProposal`
-- writes every one of them to `reply_proposals` — but nothing read them back,
-- so a deploy, a detach, or a subreddit going private silently emptied the page
-- of every reply written for that room, and the session appeared in neither
-- "now" nor "behind you". Nothing said it had happened.
--
-- Three columns are what the table was missing to be able to answer the queue's
-- questions on its own.
--
-- `sent_at` — the moment a human said they had pasted it somewhere. The
-- follow-up inbox has had one since it was written (`021_followups.sql`), and
-- the other half of the same queue had nowhere to keep it, so the Sent list
-- showed a time for one kind of draft and a blank for the other. NOT derived
-- from `decided_at`, which is also stamped by a dismissal.
--
-- `rules` and `thread` — the rules of the room this draft was checked against,
-- and the branch above the comment it answers. Both are per-draft facts about a
-- conversation that has moved on, not things to recompute later: a subreddit's
-- rules change, a thread grows, and a card that re-read either would show the
-- operator something other than what the copilot was actually working from.
-- `url` and `room` — where the comment this answers actually is, and which
-- room's rules bound the answer. A watch on a PROFILE spans rooms, so the room
-- is a property of the draft rather than of the session, and the permalink is
-- the "open" link on the question. Both arrive with the message now
-- (`ShowRuntime.onMessage`) and would otherwise be lost with the runtime.
ALTER TABLE reply_proposals ADD COLUMN IF NOT EXISTS sent_at TEXT;
ALTER TABLE reply_proposals ADD COLUMN IF NOT EXISTS url     TEXT;
ALTER TABLE reply_proposals ADD COLUMN IF NOT EXISTS room    TEXT;
ALTER TABLE reply_proposals ADD COLUMN IF NOT EXISTS rules   JSONB;
ALTER TABLE reply_proposals ADD COLUMN IF NOT EXISTS thread  JSONB;

-- The queue reads one account's async sessions newest-first.
CREATE INDEX IF NOT EXISTS idx_props_status_at ON reply_proposals(status, at DESC);
