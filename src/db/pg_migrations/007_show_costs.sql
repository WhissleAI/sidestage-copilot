-- What a show cost, kept.
--
-- The meter and the wallet-delta window both live in process memory: a restart
-- zeroed them, and nothing in Postgres recorded spend, calls or tokens. So the
-- Cost page could answer "what is this show costing right now" and nothing at
-- all about last week — the one question a seller actually asks about money.
--
-- One row per show, written when the session closes. `by_door` is the call
-- breakdown this app counted itself, which is exact; `wallet_delta_usd` is the
-- balance diff across the session window, which is an UPPER BOUND because the
-- wallet is workspace-wide. Both travel with the caveat wherever they render.

CREATE TABLE IF NOT EXISTS show_costs (
  show_id           TEXT PRIMARY KEY REFERENCES shows(id) ON DELETE CASCADE,
  opened_at         TIMESTAMPTZ NOT NULL,
  closed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  duration_min      INTEGER NOT NULL DEFAULT 0,
  calls             INTEGER NOT NULL DEFAULT 0,
  failures          INTEGER NOT NULL DEFAULT 0,
  context_chars     BIGINT  NOT NULL DEFAULT 0,
  -- { chat_turn: { calls, failures, totalMs }, ... }
  by_door           JSONB   NOT NULL DEFAULT '{}'::jsonb,
  -- Null when the wallet could not be read (a key without the billing scope).
  -- Null is "we do not know", which must never render as zero.
  wallet_delta_usd  NUMERIC(12,4),
  answered          INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS show_costs_closed_idx ON show_costs (closed_at DESC);
