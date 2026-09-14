-- What a show leaves behind.
--
-- Until now a session existed only in memory: chat messages and reply proposals
-- lived in maps on the ShowRuntime, so the moment the process restarted the
-- entire record of what buyers asked and what the copilot answered was gone.
-- Listings and the audit chain survived; the conversation did not.
--
-- That is fine for a console rendering "now" and useless for the question a
-- seller actually asks afterwards — what did I miss, and what should I add to
-- the catalog before next time. These three tables are what make a post-session
-- report possible at all.

-- Every buyer comment the watcher saw, admitted or not.
--
-- The DROPPED ones are the valuable half: a question the gate refused, or one
-- the catalog could not answer, is exactly the gap to close before the next
-- show. Keeping only what we replied to would keep only the successes.
CREATE TABLE IF NOT EXISTS chat_messages (
  show_id     TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  id          TEXT NOT NULL,
  author      TEXT NOT NULL,
  text        TEXT NOT NULL,
  at          TEXT NOT NULL,
  intent      TEXT,
  speech_act  TEXT,
  admitted    BOOLEAN NOT NULL DEFAULT FALSE,
  drop_reason TEXT,
  PRIMARY KEY (show_id, id)
);
CREATE INDEX IF NOT EXISTS idx_chat_show_at ON chat_messages(show_id, at);

-- Every reply the copilot drafted, with the verdict it earned.
--
-- `guards` is the per-guard verdict array, stored whole: the post-session
-- question is "which guard stopped what", and recomputing that from a summary
-- count would mean storing the answer instead of the evidence.
CREATE TABLE IF NOT EXISTS reply_proposals (
  show_id     TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  id          TEXT NOT NULL,
  message_id  TEXT NOT NULL,
  author      TEXT NOT NULL,
  question    TEXT NOT NULL,
  draft       TEXT NOT NULL DEFAULT '',
  sent_text   TEXT,
  status      TEXT NOT NULL,
  verdict     TEXT NOT NULL,
  confidence  REAL NOT NULL DEFAULT 0,
  repaired    BOOLEAN NOT NULL DEFAULT FALSE,
  abstained   BOOLEAN NOT NULL DEFAULT FALSE,
  latency_ms  REAL NOT NULL DEFAULT 0,
  cache_hit   BOOLEAN NOT NULL DEFAULT FALSE,
  guards      JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence    JSONB NOT NULL DEFAULT '[]'::jsonb,
  intent      TEXT,
  at          TEXT NOT NULL,
  PRIMARY KEY (show_id, id)
);
CREATE INDEX IF NOT EXISTS idx_props_show ON reply_proposals(show_id, at);

-- The report itself, computed once when a session ends and kept.
--
-- Stored rather than recomputed on read: it is a statement about a show that has
-- finished, and a number that changes after the fact is not a record of anything.
CREATE TABLE IF NOT EXISTS show_reports (
  show_id      TEXT PRIMARY KEY REFERENCES shows(id) ON DELETE CASCADE,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  report       JSONB NOT NULL
);
