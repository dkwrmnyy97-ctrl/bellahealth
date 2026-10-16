-- ─── BellaHealth Analytics Events ────────────────────────────────────────────
--
-- Product usage analytics for the private beta.
-- Uses device_id (stable anonymous UUID generated client-side) rather than a
-- Supabase Auth user ID because BellaHealth does not currently use Supabase Auth.
--
-- Security model:
--   - Anon key:          NO direct table access (all inserts via Edge Function)
--   - Edge Function:     Inserts using service-role key after server-side validation
--   - Service role:      Full read/write access (Supabase dashboard / future admin)
--   - No PII stored:     No email, name, free text, or health values in this table
--
-- Ingestion path:
--   Mobile client → POST /functions/v1/ingest-event (anon key as Bearer)
--   Edge Function validates event_name + source_screen against allowlists, then
--   writes using SUPABASE_SERVICE_ROLE_KEY (server-side only, never in the app).
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS analytics_events (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id     uuid        NOT NULL,
  event_name    text        NOT NULL,
  source_screen text,
  metadata      jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Indexes for the queries you will actually run during the beta:
--   • events by device  → "which features does this user use?"
--   • events by name    → "how many users logged a meal this week?"
--   • events over time  → "is daily active usage growing?"
CREATE INDEX IF NOT EXISTS analytics_events_device_id_idx
  ON analytics_events (device_id);

CREATE INDEX IF NOT EXISTS analytics_events_event_name_idx
  ON analytics_events (event_name);

CREATE INDEX IF NOT EXISTS analytics_events_created_at_idx
  ON analytics_events (created_at DESC);

-- ─── Row Level Security ───────────────────────────────────────────────────────

ALTER TABLE analytics_events ENABLE ROW LEVEL SECURITY;

-- No permissive policies are granted to the anon or authenticated roles.
-- When RLS is enabled and no permissive policy exists, Postgres denies all
-- operations for that role by default.
--
-- This means:
--   • anon cannot INSERT, SELECT, UPDATE, or DELETE any row directly.
--   • The service-role key (used by the Edge Function) bypasses RLS entirely
--     and does not require a policy.
--
-- Direct writes via the Supabase REST API with the anon key are therefore
-- impossible — all analytics must flow through the ingest-event Edge Function.
