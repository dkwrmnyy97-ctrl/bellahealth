-- ─── BellaHealth Analytics Summary Function ──────────────────────────────────
--
-- Returns all founder dashboard metrics as a single JSONB object.
-- Called exclusively by the analytics-summary Edge Function using the
-- service-role key. No anon/authenticated access is granted.
--
-- Security:
--   SECURITY DEFINER ensures the function runs as its owner (postgres),
--   bypassing RLS regardless of the calling role.
--   REVOKE statements below ensure only service_role can call it.
--
-- Performance note:
--   Designed for private-beta scale (<100k rows). If analytics_events grows
--   significantly, replace individual subqueries with materialized aggregates
--   or a scheduled rollup table.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION get_analytics_summary(p_since timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total_devices    bigint;
  v_active_devices   bigint;
  v_new_devices      bigint;
  v_returning        bigint;
  v_funnel           jsonb;
  v_integrations     jsonb;
  v_feature_usage    jsonb;
  v_feature_repeat   jsonb;
BEGIN

  -- Total distinct devices ever recorded
  SELECT COUNT(DISTINCT device_id)
  INTO v_total_devices
  FROM analytics_events;

  -- Active devices: at least one event in the requested period
  SELECT COUNT(DISTINCT device_id)
  INTO v_active_devices
  FROM analytics_events
  WHERE p_since IS NULL OR created_at >= p_since;

  -- New devices: first ever event falls within the period
  SELECT COUNT(*)
  INTO v_new_devices
  FROM (
    SELECT device_id
    FROM analytics_events
    GROUP BY device_id
    HAVING MIN(created_at) >= COALESCE(p_since, '-infinity'::timestamptz)
  ) t;

  -- Returning devices: events on 2 or more different calendar days in the period
  SELECT COUNT(*)
  INTO v_returning
  FROM (
    SELECT device_id
    FROM analytics_events
    WHERE p_since IS NULL OR created_at >= p_since
    GROUP BY device_id
    HAVING COUNT(DISTINCT created_at::date) >= 2
  ) t;

  -- Onboarding funnel — always all-time (funnel is cumulative, not period-scoped)
  SELECT jsonb_build_object(
    'first_open',           COUNT(DISTINCT CASE WHEN event_name = 'app_first_open'          THEN device_id END),
    'onboarding_started',   COUNT(DISTINCT CASE WHEN event_name = 'onboarding_started'       THEN device_id END),
    'onboarding_completed', COUNT(DISTINCT CASE WHEN event_name = 'onboarding_completed'     THEN device_id END)
  )
  INTO v_funnel
  FROM analytics_events;

  -- Integrations — always all-time (connection events are one-time per install)
  SELECT jsonb_build_object(
    'oura',         COUNT(DISTINCT CASE WHEN event_name = 'oura_connected'         THEN device_id END),
    'apple_health', COUNT(DISTINCT CASE WHEN event_name = 'apple_health_connected' THEN device_id END)
  )
  INTO v_integrations
  FROM analytics_events;

  -- Feature usage: distinct devices that fired each event at least once in the period
  SELECT jsonb_object_agg(event_name, cnt)
  INTO v_feature_usage
  FROM (
    SELECT event_name, COUNT(DISTINCT device_id) AS cnt
    FROM analytics_events
    WHERE (p_since IS NULL OR created_at >= p_since)
      AND event_name IN (
        'context_viewed', 'context_added',
        'trends_viewed',
        'meal_logged',
        'ai_chat_used',
        'daily_checkin_completed',
        'recovery_logged',
        'caffeine_logged',
        'gratitude_logged',
        'document_uploaded',
        'drinking_plan_used',
        'breathing_started'
      )
    GROUP BY event_name
  ) t;

  -- Repeat usage: distinct devices that fired each event on 2+ different calendar days
  SELECT jsonb_object_agg(event_name, cnt)
  INTO v_feature_repeat
  FROM (
    SELECT event_name, COUNT(*) AS cnt
    FROM (
      SELECT device_id, event_name
      FROM analytics_events
      WHERE (p_since IS NULL OR created_at >= p_since)
        AND event_name IN (
          'context_viewed', 'context_added',
          'trends_viewed',
          'meal_logged',
          'ai_chat_used',
          'daily_checkin_completed',
          'recovery_logged',
          'caffeine_logged',
          'gratitude_logged',
          'document_uploaded',
          'drinking_plan_used',
          'breathing_started'
        )
      GROUP BY device_id, event_name
      HAVING COUNT(DISTINCT created_at::date) >= 2
    ) inner_t
    GROUP BY event_name
  ) outer_t;

  RETURN jsonb_build_object(
    'total_devices',     v_total_devices,
    'active_devices',    v_active_devices,
    'new_devices',       v_new_devices,
    'returning_devices', v_returning,
    'funnel',            v_funnel,
    'integrations',      v_integrations,
    'feature_usage',     COALESCE(v_feature_usage,  '{}'::jsonb),
    'feature_repeat',    COALESCE(v_feature_repeat, '{}'::jsonb),
    'generated_at',      now(),
    'period_start',      p_since
  );

END;
$$;

-- Only service_role may execute this function.
-- The anon key and authenticated JWT cannot call it directly.
REVOKE EXECUTE ON FUNCTION get_analytics_summary(timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_analytics_summary(timestamptz) FROM anon;
REVOKE EXECUTE ON FUNCTION get_analytics_summary(timestamptz) FROM authenticated;
GRANT  EXECUTE ON FUNCTION get_analytics_summary(timestamptz) TO service_role;
