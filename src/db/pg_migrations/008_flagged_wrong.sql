-- The one metric the product could not measure.
--
-- docs/PRD.md §4 lists "wrong replies reaching a buyer — target 0" and marks it
-- ✗ not self-measurable, which is true: a reply this system judged correct is
-- exactly the reply it cannot mark wrong. The operator CAN, though, and they are
-- the only one who can. One control on a sent reply turns the unmeasurable
-- metric into a counted one — a floor rather than a total, and the report says
-- so wherever it renders.
--
-- The reason is kept because it is the eval case: "wrong fact" and "should have
-- abstained" are different failures and get fixed in different places.

ALTER TABLE reply_proposals ADD COLUMN IF NOT EXISTS flagged_wrong BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE reply_proposals ADD COLUMN IF NOT EXISTS flag_reason TEXT;
ALTER TABLE reply_proposals ADD COLUMN IF NOT EXISTS flagged_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS reply_proposals_flagged_idx
  ON reply_proposals (show_id) WHERE flagged_wrong;
