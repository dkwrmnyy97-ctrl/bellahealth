-- ─── BellaHealth Analytics — add new events to summary function ───────────────
--
-- Adds home_viewed, water_logged, your_story_viewed,
-- pattern_prompt_viewed, and pattern_prompt_answered to the feature_usage
-- and feature_repeat aggregations in get_analytics_summary().
--
-- Also adds a new top-level 'story' block tracking whether Your Story
-- is actually surfacing real content vs. sitting in fallback.
--
-- The ingest-event Edge Function allowlist was updated in the same release
-- to accept these new event names. Historical data will show 0 for these
-- events until the corresponding app build ships.
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
  v_story            jsonb;
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
        -- Navigation / surface views
        'home_viewed',
        'context_viewed',
        'trends_viewed',
        'your_story_viewed',
        -- Pattern engagement
        'pattern_prompt_viewed',
        'pattern_prompt_answered',
        -- Logging actions
        'water_logged',
        'meal_logged',
        'caffeine_logged',
        'drinking_plan_used',
        'recovery_logged',
        -- Context & reflection
        'context_added',
        'gratitude_logged',
        'daily_checkin_completed',
        -- Other features
        'ai_chat_used',
        'breathing_started',
        'document_uploaded'
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
          'home_viewed',
          'context_viewed',
          'trends_viewed',
          'your_story_viewed',
          'pattern_prompt_viewed',
          'pattern_prompt_answered',
          'water_logged',
          'meal_logged',
          'caffeine_logged',
          'drinking_plan_used',
          'recovery_logged',
          'context_added',
          'gratitude_logged',
          'daily_checkin_completed',
          'ai_chat_used',
          'breathing_started',
          'document_uploaded'
        )
      GROUP BY device_id, event_name
      HAVING COUNT(DISTINCT created_at::date) >= 2
    ) inner_t
    GROUP BY event_name
  ) outer_t;

  -- Story engagement: how many devices saw a real story vs. just the fallback
  -- your_story_viewed fires only when a real (non-fallback) story is shown.
  -- context_viewed fires every time the Context screen opens.
  -- Ratio gives a rough sense of how often Story has real content.
  SELECT jsonb_build_object(
    'story_shown',      COUNT(DISTINCT CASE WHEN event_name = 'your_story_viewed' THEN device_id END),
    'context_opened',   COUNT(DISTINCT CASE WHEN event_name = 'context_viewed'    THEN device_id END)
  )
  INTO v_story
  FROM analytics_events
  WHERE p_since IS NULL OR created_at >= p_since;

  RETURN jsonb_build_object(
    'total_devices',     v_total_devices,
    'active_devices',    v_active_devices,
    'new_devices',       v_new_devices,
    'returning_devices', v_returning,
    'funnel',            v_funnel,
    'integrations',      v_integrations,
    'feature_usage',     COALESCE(v_feature_usage,  '{}'::jsonb),
    'feature_repeat',    COALESCE(v_feature_repeat, '{}'::jsonb),
    'story',             v_story,
    'generated_at',      now(),
    'period_start',      p_since
  );

END;
$$;

-- Preserve the same permission model — only service_role may call this.
REVOKE EXECUTE ON FUNCTION get_analytics_summary(timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_analytics_summary(timestamptz) FROM anon;
REVOKE EXECUTE ON FUNCTION get_analytics_summary(timestamptz) FROM authenticated;
GRANT  EXECUTE ON FUNCTION get_analytics_summary(timestamptz) TO service_role;
