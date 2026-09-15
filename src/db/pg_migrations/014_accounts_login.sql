-- Real accounts. The guest session was the right first door — anyone could open
-- the console and watch a live show work — but everything a seller does here is
-- attributed: sends, approvals, an eBay consent, a deleted show. Attribution to
-- "quiet-otter-3f1a" is not attribution. A seller registers with an email and a
-- password; the audit chain then names a person.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS password_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_email ON accounts (lower(email)) WHERE email IS NOT NULL;
