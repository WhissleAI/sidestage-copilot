-- A fuller reading of each kept frame, written after the show by the same
-- agent, for the report's timeline. NULL until described.
ALTER TABLE show_frames ADD COLUMN IF NOT EXISTS description TEXT;

-- Audio chunk numbering is the SERVER's now. The bridge used to number chunks
-- from 0 on every page load and the row was keyed on that number, so a bridge
-- reopened mid-show overwrote the first minutes of audio with the next ones
-- (measured on show ebay_5rJpObVGZ3OXj0un, 2026-09-15). The bridge sends a
-- per-run key instead; a retried upload replaces its own row, a new run gets
-- the next number.
ALTER TABLE show_audio ADD COLUMN IF NOT EXISTS client_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS show_audio_client_key
  ON show_audio (show_id, client_key) WHERE client_key IS NOT NULL;
