-- Rename fats_g → fat_g in nutrition_log to match the application's naming convention.
--
-- The application code (NutritionLog type, MealPayload type, log-meal Edge Function,
-- fetchNutritionHistory) consistently uses fat_g (singular).
-- The production table was created manually with fats_g (plural), causing the
-- log-meal Edge Function to return HTTP 500 on every insert attempt:
--
--   [log-meal] insert error: Could not find the 'fat_g' column of 'nutrition_log'
--   in the schema cache
--
-- Confirmed actual column names from information_schema (2026-10-06):
--   protein_g ✓  carbs_g ✓  fats_g ← rename target
--
-- Confirmed safe to apply: nutrition_log has 0 rows as of 2026-10-06.
-- No data loss. No RLS changes. No authentication changes.
-- No index changes required (consumed_at index references only user_id and consumed_at).

ALTER TABLE nutrition_log RENAME COLUMN fats_g TO fat_g;
