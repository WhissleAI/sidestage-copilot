-- Live-show ingestion.
--
-- Each watched show gets its OWN SQLite file (data/shows/<showId>.db) rather
-- than a show_id column on every table. Two reasons: a show is a natural tenant
-- boundary with no cross-show queries, and isolating them means attaching a
-- third show cannot corrupt or slow the two already running.

ALTER TABLE show ADD COLUMN source TEXT NOT NULL DEFAULT 'simulated';
-- The eBay Live event id, when source = 'ebaylive'.
ALTER TABLE show ADD COLUMN external_id TEXT;
-- A show we do not own. Every write action is refused at preflight: we have no
-- seller credentials for someone else's stream, so proposing a markdown we could
-- never commit would be theatre.
ALTER TABLE show ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0;
ALTER TABLE show ADD COLUMN status TEXT NOT NULL DEFAULT 'live';

-- Lots observed on a live stream, keyed by the title eBay renders. A lot is
-- upserted the first time it appears and version-bumped whenever its price or
-- availability moves, which is what feeds the staleness guard with REAL
-- mid-show movement instead of a forced demo.
ALTER TABLE listings ADD COLUMN external_ref TEXT;
ALTER TABLE listings ADD COLUMN observed_at TEXT;
CREATE INDEX IF NOT EXISTS idx_listings_external ON listings(external_ref);
