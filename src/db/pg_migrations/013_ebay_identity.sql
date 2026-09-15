-- Who the connected eBay account IS, so a Marketplace Account Deletion
-- notification can be honoured.
--
-- eBay will not enable a production keyset until the application answers its
-- account-deletion notifications: when a member closes their eBay account, eBay
-- posts their userId and username, and every record about them has to go. That
-- is only possible if the connection remembered who it was for — until now it
-- stored tokens and never the identity behind them.
ALTER TABLE ebay_accounts ADD COLUMN IF NOT EXISTS ebay_username TEXT;

-- Every notice received, whether or not it matched a connection. eBay expects
-- an acknowledgement in seconds and the deletion to follow; this is the record
-- that it did.
CREATE TABLE IF NOT EXISTS ebay_deletion_notices (
  id            BIGSERIAL PRIMARY KEY,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  notification_id TEXT,
  ebay_user_id  TEXT,
  ebay_username TEXT,
  connections_removed INTEGER NOT NULL DEFAULT 0
);
