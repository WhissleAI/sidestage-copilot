-- What happened to a session, kept where a question can reach it.
--
-- The app had exactly three places to put a fact: Postgres (product state),
-- the SSE hub (a browser that may not be open), and `console` (which almost
-- nothing called). So a watcher that gave up after twenty reloads, a listen
-- session that was cut, a cost row that failed to write and a cap that tripped
-- all left the same trace: none. "It stopped answering mid-show" was answered
-- by asking the seller what they saw on screen.
--
-- Append-only. Nothing updates a row here and nothing should: this table is
-- the record of what the system did, and a record that can be edited after the
-- fact is not one.
--
-- `detail` carries COUNTS AND IDENTIFIERS ONLY — never a buyer's message, a
-- draft, a transcript segment or a token. The same rule the logger enforces.

CREATE TABLE IF NOT EXISTS session_events (
  seq        BIGSERIAL PRIMARY KEY,
  show_id    TEXT,
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind       TEXT NOT NULL,
  level      TEXT NOT NULL DEFAULT 'info',
  detail     JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- Deliberately NO foreign key to `shows`. An event about a session is a fact
-- about what the process did, and it stays true after the row it describes is
-- gone — including the attach that failed before any show row existed, and the
-- boot that named what it could not resume.

-- "What happened to this show, in order" — the timeline an incident is read on.
CREATE INDEX IF NOT EXISTS idx_session_events_show ON session_events (show_id, at DESC);
-- "Has any watcher given up today" — the cross-show question, asked by kind.
CREATE INDEX IF NOT EXISTS idx_session_events_kind ON session_events (kind, at DESC);

-- The listen session had a start time and nothing else: no end, no reason, no
-- stall count. A session cut at exactly 300 seconds was diagnosed by reading
-- another system's logs because ours could not say when ours stopped, or why.
ALTER TABLE shows ADD COLUMN IF NOT EXISTS listen_ended_at    TIMESTAMPTZ;
ALTER TABLE shows ADD COLUMN IF NOT EXISTS listen_end_reason  TEXT;
ALTER TABLE shows ADD COLUMN IF NOT EXISTS listen_stalls      INTEGER NOT NULL DEFAULT 0;
