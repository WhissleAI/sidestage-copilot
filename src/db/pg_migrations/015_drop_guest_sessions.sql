-- The guest door is closed. Sessions minted for guests would otherwise keep
-- resolving to accounts that can no longer do anything, and a console holding
-- one would render as signed-in while every write is refused. End them; the
-- console forgets a token the server no longer knows and shows the front door.
DELETE FROM auth_sessions WHERE account_id IN (SELECT id FROM accounts WHERE kind = 'guest');
