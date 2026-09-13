-- SideStage schema. Everything the copilot grounds against, and everything it
-- writes, lives here. Two invariants shape the design:
--   1. `listings.version` is bumped on every write. Retrieved evidence records the
--      version it was read at, so a reply grounded on a stale read is DETECTABLE
--      rather than merely unlikely.
--   2. `audit` is append-only and hash-chained. `action_commits` is the
--      idempotency ledger — a retried commit is a no-op, not a double-apply.

CREATE TABLE IF NOT EXISTS listings (
  id                TEXT PRIMARY KEY,
  sku               TEXT NOT NULL,
  title             TEXT NOT NULL,
  -- Chip-sized name for the operator console. Guessing this from the title gave
  -- "1 Retro High OG"; it is display metadata and belongs with the product.
  short_name        TEXT NOT NULL DEFAULT '',
  brand             TEXT NOT NULL,
  model             TEXT NOT NULL,
  colorway          TEXT NOT NULL,
  size              TEXT NOT NULL,
  condition         TEXT NOT NULL CHECK (condition IN ('DS','VNDS','USED')),
  price_cents       INTEGER NOT NULL CHECK (price_cents >= 0),
  floor_price_cents INTEGER NOT NULL CHECK (floor_price_cents >= 0),
  cost_cents        INTEGER NOT NULL CHECK (cost_cents >= 0),
  qty               INTEGER NOT NULL CHECK (qty >= 0),
  sold_this_show    INTEGER NOT NULL DEFAULT 0,
  views             INTEGER NOT NULL DEFAULT 0,
  state             TEXT NOT NULL CHECK (state IN ('draft','queued','live','ended')),
  pinned            INTEGER NOT NULL DEFAULT 0,
  version           INTEGER NOT NULL DEFAULT 1,
  image_url         TEXT NOT NULL DEFAULT '',
  shipping_profile  TEXT NOT NULL DEFAULT 'us-standard',
  authenticated     INTEGER NOT NULL DEFAULT 0,
  cert_id           TEXT,
  description       TEXT NOT NULL DEFAULT '',
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_listings_state ON listings(state);

CREATE TABLE IF NOT EXISTS policies (
  id    TEXT PRIMARY KEY,
  topic TEXT NOT NULL CHECK (topic IN ('shipping','returns','authenticity','discount','tone','prohibited')),
  title TEXT NOT NULL,
  body  TEXT NOT NULL
);

-- Recent comparable sales, the grounding source for product research.
CREATE TABLE IF NOT EXISTS comps (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  sku              TEXT NOT NULL,
  title            TEXT NOT NULL,
  sold_price_cents INTEGER NOT NULL,
  sold_at          TEXT NOT NULL,
  condition        TEXT NOT NULL,
  size             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comps_sku ON comps(sku);

-- Past buyer Q&A. The unstructured leg of retrieval.
CREATE TABLE IF NOT EXISTS qa (
  id       TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  answer   TEXT NOT NULL,
  tags     TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS show (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  -- Chip-sized name for the operator console. Guessing this from the title gave
  -- "1 Retro High OG"; it is display metadata and belongs with the product.
  short_name        TEXT NOT NULL DEFAULT '',
  seller_handle     TEXT NOT NULL,
  started_at        TEXT NOT NULL,
  viewers           INTEGER NOT NULL DEFAULT 0,
  pinned_listing_id TEXT,
  lot_queue         TEXT NOT NULL DEFAULT '[]',
  autonomy_level    TEXT NOT NULL DEFAULT 'L1_SUGGEST',
  undo_window_s     INTEGER NOT NULL DEFAULT 90
);

-- Append-only, hash-chained. Never UPDATE or DELETE a row here.
CREATE TABLE IF NOT EXISTS audit (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,
  hash       TEXT NOT NULL,
  prev_hash  TEXT NOT NULL,
  kind       TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  summary    TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS actions (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,
  listing_id      TEXT NOT NULL,
  listing_title   TEXT NOT NULL,
  summary         TEXT NOT NULL,
  rationale       TEXT NOT NULL DEFAULT '',
  params          TEXT NOT NULL DEFAULT '{}',
  before_state    TEXT NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL,
  preflight       TEXT NOT NULL DEFAULT '{}',
  idempotency_key TEXT NOT NULL UNIQUE,
  undoable_until  TEXT,
  error           TEXT,
  created_at      TEXT NOT NULL
);

-- The idempotency ledger. An apply is recorded here INSIDE the same transaction
-- that mutates the listing, so a duplicate commit can be detected and skipped.
CREATE TABLE IF NOT EXISTS action_commits (
  idempotency_key TEXT PRIMARY KEY,
  action_id       TEXT NOT NULL,
  committed_at    TEXT NOT NULL,
  result          TEXT NOT NULL DEFAULT '{}'
);
