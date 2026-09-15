-- A seller's eBay connection.
--
-- Everything the product does against eBay today is READ, through an
-- application token: search, the category tree, the aspects a listing should
-- carry. None of that touches anyone's account, which is why it needed no
-- consent and no storage.
--
-- Writing does. Changing a price, adjusting stock or ending a listing acts AS
-- the seller, and eBay only issues a token for that after the person signs in
-- and consents in a browser. That token is the thing this table holds.
--
-- Two rules the shape enforces:
--
--   One connection per account per environment. Sandbox and production are
--   different eBay accounts with different listings, and a token minted against
--   one is rejected by the other. Storing them in one row would make "connected"
--   ambiguous on the one screen where it must not be.
--
--   The refresh token is the durable secret. Access tokens last two hours;
--   refresh tokens last eighteen months and are what makes a show that starts
--   at 8pm still able to act at 11. It is stored, and it is the reason this
--   table is worth protecting more carefully than any other here.
CREATE TABLE IF NOT EXISTS ebay_accounts (
  account_id     TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  env            TEXT NOT NULL CHECK (env IN ('sandbox','production')),
  ebay_user_id   TEXT,
  access_token   TEXT NOT NULL,
  access_expires TIMESTAMPTZ NOT NULL,
  refresh_token  TEXT NOT NULL,
  refresh_expires TIMESTAMPTZ,
  -- The scopes eBay actually granted, which can be fewer than we asked for.
  -- That difference is the answer to "why did that write fail".
  scopes         TEXT NOT NULL DEFAULT '',
  connected_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, env)
);

-- Consent is a round trip through eBay's servers and back to us. The state
-- parameter is what proves the callback belongs to a request WE started, and
-- pinning it to an account is what stops one signed-in user's callback
-- connecting eBay to somebody else's account.
CREATE TABLE IF NOT EXISTS ebay_oauth_states (
  state       TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  env         TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Which marketplace a show's write actions actually hit.
--
-- This is deliberately a stored, per-show CHOICE rather than something inferred
-- from whether a connection happens to exist. An operator must know, before they
-- approve a markdown, whether it lands on a mock or on a real listing that real
-- buyers are looking at. Inferring that from ambient state is how someone
-- discovers the answer afterwards.
--
-- Defaults to 'mock' for every show, including a seller's own: connecting eBay
-- grants the capability, it does not arm it.
ALTER TABLE shows ADD COLUMN IF NOT EXISTS write_target TEXT NOT NULL DEFAULT 'mock';
