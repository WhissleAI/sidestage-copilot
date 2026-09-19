-- Which rooms an operator watches, and whether we may speak in any of them.
--
-- Posting a reply into somebody else's room is the one thing this system does
-- that is irreversible in the way that matters: the undo window can delete the
-- comment, it cannot unsee it. And the penalty for getting it wrong is not a
-- bad reply — it is the operator's account banned from a subreddit they have
-- posted in for six years.
--
-- So the row exists to record a HUMAN turning it on, per room, and the default
-- is false everywhere. A missing row is not consent: preflight refuses a
-- post_reply it cannot find a `posting = true` for, and says which room.
--
-- `disclosure` is what we must say about who is talking when we do post. Kept
-- per room because the requirement is the room's, not ours: some say nothing,
-- some want "written with AI assistance" in the comment itself.
CREATE TABLE IF NOT EXISTS surface_rooms (
  account_id  TEXT NOT NULL,
  surface     TEXT NOT NULL,
  room        TEXT NOT NULL,          -- subreddit, channel, conversation id
  posting     BOOLEAN NOT NULL DEFAULT FALSE,
  disclosure  TEXT,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, surface, room)
);
