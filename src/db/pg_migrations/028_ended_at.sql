-- When a session STOPPED.
--
-- The schema recorded `started_at` and a status, and nothing recorded the
-- moment a session ended. Three files independently worked around that and
-- each of them worked around it differently:
--
--   * `sessionRecord.buildReport` invented one — `endedAt: new Date()` and a
--     duration of `Date.now() - started_at`, both measured at the moment the
--     REPORT was generated rather than the moment the show stopped.
--   * `prdMetrics` divided GMV by the same `Date.now()`-relative span, so the
--     PRD's headline figure — gross per show hour — was divided by an inflated
--     denominator and quietly understated.
--   * `api/home.behindBand` fell back through four timestamps (the report's
--     invented end, then when the report was written, then the last message the
--     session heard, then when it started) and said so in a comment.
--
-- The cost of the workaround was not tidiness. A console left attached after a
-- show was over — or the fifteen-minute silence timeout finishing a session
-- forty minutes after the last word — added that whole gap to "hours on air"
-- for one seller and not another, which makes two sellers' sessions not
-- comparable and makes the flagship metric wrong in the direction that flatters
-- nobody.
--
-- Nullable on purpose, and it stays null for a session that is still live: an
-- end time for a session that has not ended would be the same invention in a
-- column. Backfilled from the stored report's own `endedAt` where one exists,
-- because that is the best statement anybody ever made about when these
-- sessions stopped — and it is at least a real moment in the past, which
-- `now()` at migration time would not be.
ALTER TABLE shows ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ;

UPDATE shows s
   SET ended_at = (r.report ->> 'endedAt')::timestamptz
  FROM show_reports r
 WHERE r.show_id = s.id
   AND s.ended_at IS NULL
   AND r.report ->> 'endedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T';

-- Analytics and the home page both ask "what finished, newest first".
CREATE INDEX IF NOT EXISTS idx_shows_ended ON shows(ended_at DESC) WHERE status = 'ended';
