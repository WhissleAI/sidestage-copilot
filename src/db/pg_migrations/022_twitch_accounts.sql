-- The Twitch account that speaks for a channel.
--
-- Reading a channel's chat and cutting a clip both act AS somebody. Twitch
-- will only mint a token for that after that person signs in and approves the
-- scopes in a browser, and the durable half of what comes back is a refresh
-- token — the thing this table holds, sealed, the same way ebay_accounts holds
-- eBay's.
--
-- One connection per account, not per environment. Twitch has no sandbox: the
-- same host serves every application, and a second row would be a second bot
-- for the same operator with no way to say which one a show should use.
--
-- `twitch_login` is stored alongside the id because every human names a channel
-- by its login and every Helix call takes the id. Keeping both is what lets the
-- console say "connected as @kicksbyrae" without a round trip.
CREATE TABLE IF NOT EXISTS twitch_accounts (
  account_id      TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  twitch_user_id  TEXT,
  twitch_login    TEXT,
  access_token    TEXT NOT NULL,
  access_expires  TIMESTAMPTZ NOT NULL,
  refresh_token   TEXT NOT NULL,
  -- What Twitch actually granted, which can be fewer than we asked for. That
  -- difference is the answer to "why did the clip fail and the poll not".
  scopes          TEXT NOT NULL DEFAULT '',
  connected_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Consent is a round trip through Twitch and back to us. The state parameter
-- proves the callback belongs to a request WE started, and pinning it to an
-- account is what stops one signed-in user's callback connecting a Twitch
-- account to somebody else's. Exactly the shape ebay_oauth_states has, for
-- exactly the same reason.
CREATE TABLE IF NOT EXISTS twitch_oauth_states (
  state       TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
