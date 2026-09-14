-- SideStage, on Postgres.
--
-- What changed from the SQLite schema, and why:
--
--  * `show_id` is a real column on every per-show table. SQLite gave tenancy for
--    free by putting each show in its own FILE; Postgres gives it by scoping,
--    and scoping is only safe if it is structural. So `Repo` is CONSTRUCTED with
--    a show id and injects it into every statement — no caller is ever trusted
--    to remember a WHERE clause.
--  * `audit.seq` is per SHOW, not global. The hash chain is a per-show chain, so
--    a global sequence would make one show's writes perturb another's chain.
--  * Booleans are BOOLEAN. SQLite had no such type and used 0/1 integers, which
--    is exactly the sort of thing that reads as truthy when it should not.
--  * Timestamps stay TEXT (ISO-8601, UTC). The wire contract in domain/types.ts
--    is ISO strings, and a driver that hands back Date objects would silently
--    change what every API response looks like. `observed_at`-style analytics
--    columns that nothing serialises use timestamptz.

CREATE TABLE IF NOT EXISTS accounts (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('guest','seller')),
  handle       TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Bearer tokens for the console. A guest gets one on first load; it is the
-- thing that makes `audit.actor_type` able to answer "who", which it could not
-- when every write was anonymous.
CREATE TABLE IF NOT EXISTS auth_sessions (
  token      TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_account ON auth_sessions(account_id);

-- Per-account overrides of the guardrail policy, autonomy defaults and budgets.
-- One row per account; the shape is the SellerGuardrailPolicy object plus the
-- operational knobs, stored whole because it is read and written whole.
CREATE TABLE IF NOT EXISTS settings (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  policy     JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shows (
  id                TEXT PRIMARY KEY,
  owner_account_id  TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  title             TEXT NOT NULL,
  short_name        TEXT NOT NULL DEFAULT '',
  seller_handle     TEXT NOT NULL,
  started_at        TEXT NOT NULL,
  viewers           INTEGER NOT NULL DEFAULT 0,
  pinned_listing_id TEXT,
  lot_queue         JSONB NOT NULL DEFAULT '[]'::jsonb,
  autonomy_level    TEXT NOT NULL DEFAULT 'L1_SUGGEST',
  undo_window_s     INTEGER NOT NULL DEFAULT 90,
  source            TEXT NOT NULL DEFAULT 'simulated',
  external_id       TEXT,
  read_only         BOOLEAN NOT NULL DEFAULT FALSE,
  status            TEXT NOT NULL DEFAULT 'live',
  catalog_id        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shows_owner ON shows(owner_account_id);

CREATE TABLE IF NOT EXISTS listings (
  show_id           TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  id                TEXT NOT NULL,
  sku               TEXT NOT NULL,
  title             TEXT NOT NULL,
  short_name        TEXT NOT NULL DEFAULT '',
  brand             TEXT NOT NULL DEFAULT '',
  model             TEXT NOT NULL DEFAULT '',
  colorway          TEXT NOT NULL DEFAULT '',
  size              TEXT NOT NULL DEFAULT '',
  condition         TEXT NOT NULL CHECK (condition IN ('DS','VNDS','USED')),
  price_cents       INTEGER NOT NULL CHECK (price_cents >= 0),
  floor_price_cents INTEGER NOT NULL CHECK (floor_price_cents >= 0),
  cost_cents        INTEGER NOT NULL CHECK (cost_cents >= 0),
  qty               INTEGER NOT NULL CHECK (qty >= 0),
  sold_this_show    INTEGER NOT NULL DEFAULT 0,
  views             INTEGER NOT NULL DEFAULT 0,
  state             TEXT NOT NULL CHECK (state IN ('draft','queued','live','ended')),
  pinned            BOOLEAN NOT NULL DEFAULT FALSE,
  -- Bumped on EVERY write, in the same statement as the write. This is what
  -- makes a reply grounded on a stale read provable rather than merely unlikely.
  version           INTEGER NOT NULL DEFAULT 1,
  image_url         TEXT NOT NULL DEFAULT '',
  shipping_profile  TEXT NOT NULL DEFAULT 'us-standard',
  authenticated     BOOLEAN NOT NULL DEFAULT FALSE,
  cert_id           TEXT,
  description       TEXT NOT NULL DEFAULT '',
  updated_at        TEXT NOT NULL,
  external_ref      TEXT,
  observed_at       TEXT,
  PRIMARY KEY (show_id, id)
);
CREATE INDEX IF NOT EXISTS idx_listings_state ON listings(show_id, state);
CREATE INDEX IF NOT EXISTS idx_listings_external ON listings(show_id, external_ref);

CREATE TABLE IF NOT EXISTS policies (
  show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  id      TEXT NOT NULL,
  topic   TEXT NOT NULL CHECK (topic IN ('shipping','returns','authenticity','discount','tone','prohibited')),
  title   TEXT NOT NULL,
  body    TEXT NOT NULL,
  PRIMARY KEY (show_id, id)
);

CREATE TABLE IF NOT EXISTS comps (
  id               BIGSERIAL PRIMARY KEY,
  show_id          TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  sku              TEXT NOT NULL,
  title            TEXT NOT NULL,
  sold_price_cents INTEGER NOT NULL,
  sold_at          TEXT NOT NULL,
  condition        TEXT NOT NULL,
  size             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comps_sku ON comps(show_id, sku);

CREATE TABLE IF NOT EXISTS qa (
  show_id  TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  id       TEXT NOT NULL,
  question TEXT NOT NULL,
  answer   TEXT NOT NULL,
  tags     TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (show_id, id)
);

-- Append-only, hash-chained, PER SHOW. Never UPDATE or DELETE a row here: a
-- rollback is a NEW entry recording the reversal, not an erasure.
CREATE TABLE IF NOT EXISTS audit (
  show_id     TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  at          TEXT NOT NULL,
  hash        TEXT NOT NULL,
  prev_hash   TEXT NOT NULL,
  kind        TEXT NOT NULL,
  actor_type  TEXT NOT NULL,
  -- WHO, when an account is attached. `actor_type` says copilot/seller/system;
  -- this says which seller. "Who approved that markdown" was unanswerable while
  -- the console had no accounts at all.
  actor_id    TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  summary     TEXT NOT NULL,
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (show_id, seq)
);

CREATE TABLE IF NOT EXISTS actions (
  show_id         TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  id              TEXT NOT NULL,
  kind            TEXT NOT NULL,
  listing_id      TEXT NOT NULL,
  listing_title   TEXT NOT NULL,
  summary         TEXT NOT NULL,
  rationale       TEXT NOT NULL DEFAULT '',
  params          JSONB NOT NULL DEFAULT '{}'::jsonb,
  before_state    JSONB NOT NULL DEFAULT '{}'::jsonb,
  status          TEXT NOT NULL,
  preflight       JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT NOT NULL UNIQUE,
  undoable_until  TEXT,
  error           TEXT,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (show_id, id)
);

-- The idempotency ledger. An apply is recorded here INSIDE the same transaction
-- that mutates the listing, so a retried commit is a no-op rather than a
-- double-apply.
CREATE TABLE IF NOT EXISTS action_commits (
  idempotency_key TEXT PRIMARY KEY,
  show_id         TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  action_id       TEXT NOT NULL,
  committed_at    TEXT NOT NULL,
  result          JSONB NOT NULL DEFAULT '{}'::jsonb
);
