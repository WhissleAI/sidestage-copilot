-- The people who asked and did not buy.
--
-- A live show's reply queue is a queue: the seller is running an auction with
-- one hand and reading it with the other, and what does not get answered in the
-- next thirty seconds does not get answered at all. On `ebay_47tK1SX0VsiHEXN1`
-- that was 29 distinct buyers with 60 answerable questions and not one reply
-- sent. Those people are the warmest leads this product will ever see, and
-- until now the only trace of them was a count in a report.
--
-- One row is one buyer from one show, which is why the uniqueness is
-- (show_id, buyer) rather than the question: two messages three hours later
-- from a seller you asked one thing reads as a stranger who wants something.
--
-- `draft` is the only content column, and there is deliberately no `sent_text`
-- beside it. We do not send. eBay exposes no messaging API to us and
-- Instagram's is behind an app review this project has not applied for, so the
-- seller copies the draft into their own account and marks it sent. `sent_at`
-- records a human's claim about something that happened somewhere else; it is
-- never written by a delivery we performed. Stamped once, by COALESCE, because
-- a retried mark must not move when the message actually went.
CREATE TABLE IF NOT EXISTS followups (
  id           TEXT PRIMARY KEY,
  show_id      TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  account_id   TEXT NOT NULL,
  buyer        TEXT NOT NULL,
  question     TEXT NOT NULL,
  message_id   TEXT,
  draft        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'dismissed')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at      TIMESTAMPTZ,
  dismissed_at TIMESTAMPTZ,
  UNIQUE (show_id, buyer)
);

-- The inbox's own query: one account's follow-ups, newest first, usually
-- filtered to `draft`.
CREATE INDEX IF NOT EXISTS idx_followups_account ON followups(account_id, status, created_at DESC);
