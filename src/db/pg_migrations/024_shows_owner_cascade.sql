-- A deleted account must not turn its shows into everybody's.
--
-- `shows.owner_account_id` was `REFERENCES accounts(id) ON DELETE SET NULL`.
-- An ownerless row is the historical wrinkle — rows written before ownership
-- existed — and the rest of the system treats it as "visible to everyone"
-- (`owner_account_id IS NULL OR = $n`, in six places). So the FK quietly
-- manufactured new ones: delete an account and every show it ever ran became
-- readable by every other seller on the box. That is a tenancy boundary
-- dissolving on a DELETE.
--
-- CASCADE instead. A show is one account's; when the account goes, the show
-- goes with it, along with everything that cascades off the show already
-- (listings, chat, proposals, audit, sales, report). The alternative — a
-- tombstone owner — keeps the rows readable by an account nobody can sign in
-- to, which is an account to secure rather than a row to delete.
--
-- EXISTING NULL ROWS ARE LEFT AS THEY ARE. There is nothing to backfill them
-- from: the owner was never recorded. They stay readable, and as of this
-- change they refuse every write (the ownership preHandler answers 403
-- `ownerless-show`, and `activeFor` will not hand one to a writer). To claim
-- one, re-attach the show; the attach records the owner.
--
-- Count them before and after a deploy:
--   SELECT count(*) FROM shows WHERE owner_account_id IS NULL;
-- On this box that is the demo row (`show_ep42`, only with DEMO_SHOW=1) and
-- anything attached before 2026-09-15. A demo show is read-only until it is
-- claimed, which is worth saying out loud: DEMO_SHOW=1 is now a walkthrough
-- you can read, not one you can drive.

ALTER TABLE shows DROP CONSTRAINT IF EXISTS shows_owner_account_id_fkey;
ALTER TABLE shows
  ADD CONSTRAINT shows_owner_account_id_fkey
  FOREIGN KEY (owner_account_id) REFERENCES accounts(id) ON DELETE CASCADE;
