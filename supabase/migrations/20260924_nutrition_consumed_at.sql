-- ─── nutrition_log: add consumed_at ──────────────────────────────────────────
--
-- Adds an optional user-declared consumption timestamp to each meal row.
--
-- CRITICAL DISTINCTION:
--   logged_at   = when the row was written (server timestamp, set by log-meal
--                 Edge Function). This is the UPLOAD time, not the eat time.
--                 A user batch-uploading three meals at 9 PM will have all
--                 three rows with logged_at ≈ 9 PM, regardless of when they ate.
--
--   consumed_at = when the user actually ate the meal, as explicitly declared
--                 by the user. NULL means timing is UNKNOWN.
--
-- RULES:
--   - consumed_at is always NULL for rows created before this migration.
--   - consumed_at must NEVER be inferred, estimated, or defaulted from
--     logged_at, meal_name, or any other existing field.
--   - No system should infer late-night eating, meal spacing, or meal
--     frequency from logged_at or meal_name alone.
--   - Only claim something about meal timing when consumed_at IS NOT NULL
--     for a sufficient number of rows in the analysis window.
--
-- UI note (not implemented here):
--   When the user logs a meal, the UI should default consumed_at = now()
--   and allow the user to change it via:
--     Breakfast  → preset (e.g. 08:00 local time)
--     Lunch      → preset (e.g. 12:30 local time)
--     Dinner     → preset (e.g. 19:00 local time)
--     Snack      → now (default, no strong time prior)
--     Custom     → time picker
--   For batch uploads, the user can adjust consumed_at before saving.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE nutrition_log
  ADD COLUMN IF NOT EXISTS consumed_at timestamptz NULL;

COMMENT ON COLUMN nutrition_log.consumed_at IS
  'When the user actually consumed this meal, as explicitly declared by the user. '
  'NULL = timing unknown (e.g. retrospective batch logging without time selection). '
  'NEVER use logged_at as a proxy for consumed_at — logged_at is the server '
  'write timestamp and carries no information about when food was eaten.';

-- Partial index: only index rows where timing is actually known.
-- The WHERE clause keeps the index small — no wasted space for the NULL majority.
CREATE INDEX IF NOT EXISTS nutrition_log_consumed_at_idx
  ON nutrition_log (user_id, consumed_at)
  WHERE consumed_at IS NOT NULL;
