-- Sellers you follow.
--
-- Two paths lead to a show and they are not equally reliable. Pasting a link
-- always works: the operator is already watching the stream. Discovery asks
-- eBay for the live grid and is refused often enough that an empty result is
-- the normal case, not an error.
--
-- Following is the third: a short list of handles that are checked against the
-- grid whenever it answers, so a seller who runs the same show every Tuesday
-- does not have to go find it. It is still best effort — it rides on the same
-- grid — and the console says so rather than implying a subscription.
--
-- `last_seen_live_at` is what makes "we have not seen them since Tuesday"
-- answerable, which is the difference between a quiet follow and a broken one.
CREATE TABLE IF NOT EXISTS followed_sellers (
  account_id         TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  handle             TEXT NOT NULL,
  note               TEXT,
  added_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_checked_at    TIMESTAMPTZ,
  last_seen_live_at  TIMESTAMPTZ,
  last_event_id      TEXT,
  last_title         TEXT,
  PRIMARY KEY (account_id, handle)
);
