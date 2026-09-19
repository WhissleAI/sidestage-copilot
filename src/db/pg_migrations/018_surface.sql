-- Which surface a show is a conversation on.
--
-- `shows.source` has answered this since the first migration, when the only two
-- answers were 'simulated' and 'ebaylive' and "source" meant "where chat comes
-- from". It is the same axis under an older name, so this column is backfilled
-- from it and reads go through COALESCE(surface, source): nothing that writes
-- `source` today has to change, and nothing that reads a legacy row sees a null.
-- The new name is the one a Twitch or Reddit session writes, because "the
-- source of chat" stops describing a subreddit thread the moment there is one.
ALTER TABLE shows ADD COLUMN IF NOT EXISTS surface TEXT NOT NULL DEFAULT 'ebaylive';
UPDATE shows SET surface = source WHERE source IS NOT NULL AND source <> surface;

-- An asynchronous conversation is a TREE, not a stream.
--
-- On a live show the last ninety seconds are the context and a comment's only
-- neighbour is the comment before it. In a subreddit or a DM the message being
-- answered sits under an opening post and a branch of replies, and a copilot
-- that cannot see that branch answers the words instead of the conversation.
-- Nullable, and every read tolerates them being absent: a live-commerce row has
-- no thread and never will.
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS thread_id TEXT;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS parent_id TEXT;
CREATE INDEX IF NOT EXISTS idx_chat_thread ON chat_messages(show_id, thread_id, at);
