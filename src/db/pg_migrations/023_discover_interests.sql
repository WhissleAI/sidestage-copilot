-- The terms an operator sells around, and therefore discovers around.
--
-- An interest is the unit of discovery on every surface: "Pokémon", "Omega
-- Seamaster", "mechanical keyboards". They are DERIVED from what the operator
-- already loaded into Knowledge — listing titles and the eBay aspects that came
-- with them — and then OWNED, because what somebody sells next month is not in
-- last month's catalog.
--
-- Two columns carry the whole of that arrangement.
--
-- `origin` says where a term came from, so the interface can show it: a derived
-- chip explains itself ("12 of your listings say this"), a term the operator
-- typed does not need to.
--
-- `deleted` is a TOMBSTONE, and it is the reason this is a table and not a
-- recomputation. A derived term the operator removes must stay removed across
-- every future catalog import — otherwise the next import silently puts it back
-- and the removal reads as a bug in the product rather than a decision the
-- operator made. Deriving again therefore skips any slug that carries this
-- flag, and a row is never hard-deleted by the ordinary edit path.
--
-- `slug` is the identity, `term` is the display form. "Pokémon", "pokemon" and
-- "POKEMON" are one interest with whichever spelling the operator last used;
-- matching a hit is done on the slug, so an accent cannot decide whether a card
-- appears.
CREATE TABLE IF NOT EXISTS discover_interests (
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  slug        TEXT NOT NULL,
  term        TEXT NOT NULL,
  origin      TEXT NOT NULL DEFAULT 'derived',   -- 'derived' | 'own'
  -- Pinned terms sort first and are never pushed out by a derived one.
  pinned      BOOLEAN NOT NULL DEFAULT FALSE,
  deleted     BOOLEAN NOT NULL DEFAULT FALSE,
  -- How many of this account's listings carry the term. Zero for a term the
  -- operator typed that nothing in the catalog mentions — which is legitimate:
  -- it is what they are about to sell.
  weight      INTEGER NOT NULL DEFAULT 0,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, slug)
);

-- Every read is "this account's live interests, best first".
CREATE INDEX IF NOT EXISTS discover_interests_live
  ON discover_interests (account_id, pinned DESC, weight DESC)
  WHERE NOT deleted;
