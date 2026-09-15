-- What a show sounded and looked like — kept, not just heard.
--
-- The console has measured the host's speech all along: every finalised
-- utterance arrives with Whissle's emotion and intent DISTRIBUTIONS, a speech
-- rate and a loudness envelope, and every few seconds the agent reads a frame
-- of the video and says what is on screen. None of it survived the show. The
-- report could say how many replies were blocked and could not say whether the
-- host was rushing, what they were pitching when chat went quiet, or what the
-- camera was pointed at when a lot sold — which is most of what a seller wants
-- to relive, and all of what makes this a perception product rather than a
-- chat bot.
--
-- Three tables, one per signal. Media bytes live on disk under
-- data/shows/<show>/{audio,frames}/ and these rows are the index: Postgres is
-- for what needs querying, the filesystem for what needs streaming.

-- Every finalised utterance of the host, with the metadata as measured.
-- Distributions are stored whole (top-k with probabilities), never collapsed
-- to a label: the gateway's own note on this head says accuracy degrades on
-- low-arousal states, and a report that says "confident" over a 0.34 is lying.
CREATE TABLE IF NOT EXISTS show_transcript (
  show_id      TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  seq          BIGSERIAL,
  at           TIMESTAMPTZ NOT NULL,
  text         TEXT NOT NULL,
  emotion      JSONB,
  intent       JSONB,
  speech_rate  REAL,
  levels       REAL[],
  PRIMARY KEY (show_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_show_transcript_at ON show_transcript(show_id, at);

-- Frames the agent actually read, with what it read. Frames it skipped as
-- dark or throttled are not kept: a frame nobody interpreted is just a JPEG.
CREATE TABLE IF NOT EXISTS show_frames (
  show_id   TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  seq       BIGSERIAL,
  at        TIMESTAMPTZ NOT NULL,
  path      TEXT NOT NULL,
  bytes     INTEGER NOT NULL,
  reading   TEXT NOT NULL,
  PRIMARY KEY (show_id, seq)
);

-- The host's audio in ~10-second Opus chunks, so a report can play the show
-- back against its transcript. Offsets are milliseconds from the show's
-- started_at, which is what puts a transcript line and a frame on one timeline.
CREATE TABLE IF NOT EXISTS show_audio (
  show_id     TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  at          TIMESTAMPTZ NOT NULL,
  offset_ms   INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  path        TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  mime        TEXT NOT NULL DEFAULT 'audio/webm',
  PRIMARY KEY (show_id, seq)
);

-- The platform-side voice session the bridge published into, so its
-- end-of-session summary (outcome, next action, key points) can be fetched
-- and folded into the report rather than left on the gateway unread.
ALTER TABLE shows ADD COLUMN IF NOT EXISTS listen_room TEXT;
ALTER TABLE shows ADD COLUMN IF NOT EXISTS listen_started_at TIMESTAMPTZ;
