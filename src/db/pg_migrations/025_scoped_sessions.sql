-- A session that can do one thing, for one show, for an hour.
--
-- The audio bridge is a bare HTML page the operator opens in a tab, so it
-- cannot carry a bearer header — it takes its token from the URL. Until now
-- that token was the CONSOLE session: thirty days, full account, sitting in
-- the address bar, in browser history, and in whatever the operator copies
-- when they send the link to their other machine. The page also loads a
-- script from a CDN, so a CDN compromise reads it out of `location.search`.
--
-- `scope_show_id` makes a second kind of session: minted on request by the
-- show's owner, good for that show's audio and visual ingest and nothing
-- else, and expiring in an hour rather than a month. NULL is a console
-- session — every row that exists today — so this is additive and no session
-- changes meaning.

ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS scope_show_id TEXT;
