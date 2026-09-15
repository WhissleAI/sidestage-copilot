-- Shows we have got ready for, before they start.
--
-- The copilot has always been useful only once a show was already running: you
-- pasted a link, it attached, and then it spent the first minutes of the auction
-- learning what was being sold. The expensive part of that — building a catalog
-- and standing up an agent with the catalog in its knowledge base — does not
-- need the show to be live. It needs the seller's handle, which the live grid
-- gives us, and their listings, which the Browse API gives us.
--
-- So a prepared show is an eBay Live event with its catalog already built and
-- its own Whissle agent already carrying it. Attaching afterwards is instant and
-- grounded from the first question rather than the fiftieth.
--
-- One agent per event, deliberately. Two shows sharing an agent share a
-- knowledge base, which is how a copilot answers about a lot that belongs to
-- somebody else's auction.
CREATE TABLE IF NOT EXISTS prepared_shows (
  event_id      TEXT PRIMARY KEY,
  account_id    TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  title         TEXT NOT NULL,
  host          TEXT NOT NULL DEFAULT '',
  seller_handle TEXT,
  tags          JSONB NOT NULL DEFAULT '[]'::jsonb,
  thumbnail_url TEXT,
  -- The catalog file this event's inventory was written to, and the agent that
  -- carries it. Both are OURS to delete when the prepared show is dropped.
  catalog_id    TEXT,
  agent_id      TEXT,
  items         INTEGER NOT NULL DEFAULT 0,
  -- What could not be done, kept rather than logged: a seller whose listings
  -- did not resolve should see why on the card, not in a server log.
  warnings      JSONB NOT NULL DEFAULT '[]'::jsonb,
  prepared_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
