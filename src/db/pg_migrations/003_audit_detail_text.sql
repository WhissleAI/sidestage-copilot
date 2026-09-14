-- The audit chain hashes `detail`, so `detail` must round-trip BYTE-for-byte.
--
-- `jsonb` does not. It normalises: keys are reordered into its own internal
-- order, whitespace is dropped, duplicate keys collapse, and numeric forms are
-- canonicalised. So the JSON we hashed on the way in is not the JSON that comes
-- back out, and `verify()` reported the chain broken at seq 1 on a chain nobody
-- had touched.
--
-- The fix is to store the exact serialisation that was hashed. `text` is not a
-- downgrade here: this column is never queried by content — it is evidence, and
-- evidence you reformat is evidence you cannot verify.

ALTER TABLE audit ALTER COLUMN detail TYPE TEXT USING detail::text;
ALTER TABLE audit ALTER COLUMN detail SET DEFAULT '{}';
