-- What actually sold, and for how much.
--
-- GMV is the headline metric in the PRD and nothing computed it, because
-- nothing recorded a SALE. The information was always there and always thrown
-- away: an observed lot that goes `live → ended` with qty 0 is a lot the host
-- just hammered, and the price it carried at that moment is what it sold for.
--
-- Recorded as EVENTS rather than derived from listing state, for the same
-- reason the audit chain is append-only: the listing row keeps moving (the next
-- lot reuses the screen, prices churn), so a sum over current state answers a
-- different question every time you ask it.
CREATE TABLE IF NOT EXISTS sales (
  id          BIGSERIAL PRIMARY KEY,
  show_id     TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  listing_id  TEXT NOT NULL,
  title       TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  qty         INTEGER NOT NULL DEFAULT 1,
  at          TEXT NOT NULL,
  -- `observed` — inferred from a watched lot closing on someone else's stream.
  -- `action`   — a write this copilot committed against our own listing.
  source      TEXT NOT NULL CHECK (source IN ('observed','action')),
  -- One row per lot close. A watcher that re-observes an already-ended lot must
  -- not book the same sale twice.
  UNIQUE (show_id, listing_id, at)
);
CREATE INDEX IF NOT EXISTS idx_sales_show ON sales(show_id);

-- When the seller decided, so "median decision time per proposal" is measurable.
-- Null until they act; a proposal nobody ever touched is not a slow decision,
-- it is no decision, and averaging those in would flatter the number.
ALTER TABLE reply_proposals ADD COLUMN IF NOT EXISTS decided_at TEXT;
ALTER TABLE reply_proposals ADD COLUMN IF NOT EXISTS edited BOOLEAN NOT NULL DEFAULT FALSE;
