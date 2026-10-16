-- 002_apple_tokens.sql
-- BellaHealth — Apple Token Storage (Server-Only)
--
-- Security architecture:
--
--   private schema
--     Not in Supabase/PostgREST exposed schemas. No REST API request — from
--     any role, with any JWT — can reach this schema or its tables. This is
--     the primary isolation boundary for the refresh token.
--
--   SECURITY DEFINER functions (in public schema)
--     Run as the function owner (postgres), who has full access to the private
--     schema. They are the only way for Edge Functions to read or write tokens.
--     Callers (anon, authenticated) cannot call them — EXECUTE is revoked from
--     PUBLIC and granted only to service_role.
--
--   anon / authenticated
--     Cannot reach private.apple_tokens via REST (schema not exposed).
--     Cannot call internal_* functions (no EXECUTE privilege).
--
--   service_role (used by Edge Functions)
--     Cannot reach private.apple_tokens via REST (schema not exposed).
--     Can call internal_* functions (EXECUTE granted explicitly).
--     Functions run as postgres (SECURITY DEFINER), which accesses the table.
--
--   Deletion
--     private.apple_tokens references auth.users(id) ON DELETE CASCADE.
--     Deleting the auth.users row in delete-account automatically removes
--     the token row — no explicit cleanup step needed in application code.

-- ── Private schema ─────────────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS private;

-- ── Token table ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS private.apple_tokens (
  user_id        UUID         PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  refresh_token  TEXT         NOT NULL,
  created_at     TIMESTAMPTZ  DEFAULT now(),
  updated_at     TIMESTAMPTZ  DEFAULT now()
);

-- No REVOKE on the table or schema is required: the private schema is not in
-- PostgREST's exposed schemas list, making the table unreachable via HTTP
-- regardless of PostgreSQL-level privileges. The SECURITY DEFINER functions
-- below are the sole controlled access path.

-- ── SECURITY DEFINER access functions ──────────────────────────────────────────
--
-- Both functions live in the public schema so PostgREST can route RPC calls
-- to them. They execute as their owner (postgres), not as the calling role,
-- so they can freely access the private schema.
--
-- SET search_path pins the execution context to prevent search_path-injection
-- attacks inside the function body.

-- Write: called by exchange-apple-code Edge Function after Apple sign-in.
CREATE OR REPLACE FUNCTION public.internal_upsert_apple_token(
  p_user_id       UUID,
  p_refresh_token TEXT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = private, public, pg_temp
AS $$
BEGIN
  INSERT INTO private.apple_tokens (user_id, refresh_token, updated_at)
  VALUES (p_user_id, p_refresh_token, now())
  ON CONFLICT (user_id) DO UPDATE
    SET refresh_token = EXCLUDED.refresh_token,
        updated_at    = now();
END;
$$;

-- Argument types included to avoid ambiguity; required for unambiguous REVOKE/GRANT.
REVOKE EXECUTE ON FUNCTION public.internal_upsert_apple_token(UUID, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.internal_upsert_apple_token(UUID, TEXT) TO   service_role;

-- Read: called by delete-account Edge Function before user deletion.
-- Returns NULL when no token exists (user never completed Apple sign-in).
CREATE OR REPLACE FUNCTION public.internal_get_apple_refresh_token(
  p_user_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = private, public, pg_temp
AS $$
DECLARE
  v_token TEXT;
BEGIN
  SELECT refresh_token INTO v_token
  FROM private.apple_tokens
  WHERE user_id = p_user_id;
  RETURN v_token;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.internal_get_apple_refresh_token(UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.internal_get_apple_refresh_token(UUID) TO   service_role;
