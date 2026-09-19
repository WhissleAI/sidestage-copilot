-- Who the operator IS, in their own words.
--
-- The settings table already carries one free-text "voice" paragraph, and for a
-- shopping question that is enough: a buyer asking whether a size 10 is still
-- there wants the answer, and the register is nearly invisible. It stops being
-- enough the moment the reply lands somewhere the register IS the credibility.
-- A subreddit reads a sentence written in brand-voice as an ad and downvotes it
-- before anyone checks whether it was true; a Twitch chat reads a formal one as
-- a bot. On those surfaces getting the facts right and the voice wrong still
-- loses.
--
-- So a persona is four things the single paragraph could not hold:
--   about / voice   the operator in prose, unchanged in kind from the paragraph
--   boundaries      what they never claim, never discuss, and always disclose
--   registers       how they sound PER SURFACE, because the same person writes
--                   differently in a subreddit than in a live selling chat
--   a voice corpus  their own past sent replies, in persona_voice below
--
-- `id` exists so an account can hold more than one persona later (a second
-- brand, a second channel) without a migration; today every route addresses
-- 'default' and one row is what an account has.
CREATE TABLE IF NOT EXISTS personas (
  account_id     TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  id             TEXT NOT NULL DEFAULT 'default',
  name           TEXT NOT NULL DEFAULT '',
  about          TEXT NOT NULL DEFAULT '',
  voice          TEXT NOT NULL DEFAULT '',
  -- { never_claim: [], never_discuss: [], must_disclose: [] }. The first two
  -- become never-say rules in the account's guard policy; the third cannot be
  -- one, and src/persona/boundaries.ts says why.
  boundaries     JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- What we must say about who is talking, when the persona itself demands it
  -- everywhere. A room that demands its own wording keeps it on surface_rooms.
  disclosure     TEXT,
  -- { [surfaceId]: { length, formality, emoji, notes } }
  registers      JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Reserved: which voice-corpus documents this persona draws on, when it draws
  -- on a subset. Empty means all of the account's corpus, which is what
  -- `POST /api/persona/learn` produces today. Deliberately NOT maintained as a
  -- mirror of persona_voice — two lists of the same rows drift, and the rows
  -- are the ones a style reference is picked from.
  corpus_doc_ids TEXT[] NOT NULL DEFAULT '{}',
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, id)
);

-- The voice corpus: text this operator has actually put their name to.
--
-- Scoped to the ACCOUNT, not to a show, because that is what makes it a voice
-- rather than a transcript — how someone wrote in March is evidence about how
-- they write, whichever show it happened in.
--
-- `doc_id` is derived from where the text came from (`sent:<show>:<proposal>`,
-- `paste:<digest>`), so learning twice over the same history re-indexes the
-- same rows instead of growing a duplicate corpus each time an operator presses
-- the button.
CREATE TABLE IF NOT EXISTS persona_voice (
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  doc_id      TEXT NOT NULL,
  -- What was being answered. Indexed alongside the text because a style
  -- reference is chosen by resemblance to the QUESTION in hand, not to the
  -- answer we have not written yet.
  question    TEXT NOT NULL DEFAULT '',
  text        TEXT NOT NULL,
  origin      TEXT NOT NULL,          -- 'sent' | 'pasted'
  show_id     TEXT,
  show_title  TEXT,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, doc_id)
);
CREATE INDEX IF NOT EXISTS idx_persona_voice_account ON persona_voice (account_id, at DESC);
