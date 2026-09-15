-- Where a listing lives on eBay, when the catalog knows (prepared and
-- imported items carry the item web URL; an observed lot has none).
ALTER TABLE listings ADD COLUMN IF NOT EXISTS url TEXT;

-- Who a show's cost belongs to, written at close so the per-seller cost page
-- does not depend on a join that legacy rows cannot satisfy.
ALTER TABLE show_costs ADD COLUMN IF NOT EXISTS account_id TEXT;
CREATE INDEX IF NOT EXISTS show_costs_account ON show_costs (account_id, closed_at);
