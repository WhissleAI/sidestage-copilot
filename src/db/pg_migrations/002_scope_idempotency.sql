-- Idempotency keys are per SHOW, not global.
--
-- The key is a hash of (kind, listing id, listing version, params). Two shows
-- selling from the same catalog therefore produce the SAME key for the same
-- intent — which under a global UNIQUE meant the second show could never
-- propose an action the first had already proposed. Under the show-per-file
-- store this was scoped by the filesystem and invisible; moving to one database
-- turned it into a cross-tenant collision.

ALTER TABLE actions DROP CONSTRAINT IF EXISTS actions_idempotency_key_key;
ALTER TABLE actions ADD CONSTRAINT actions_show_idem_key UNIQUE (show_id, idempotency_key);

ALTER TABLE action_commits DROP CONSTRAINT IF EXISTS action_commits_pkey;
ALTER TABLE action_commits ADD PRIMARY KEY (show_id, idempotency_key);
