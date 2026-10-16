-- ─── BellaHealth Analytics v2 ────────────────────────────────────────────────
--
-- Replaces get_analytics_summary with get_analytics_v2, which returns a
-- substantially richer payload used by the upgraded founder dashboard.
--
-- New sections added:
--   trends      — Trends viewer breakdown by integration status, avg/median
--                 visits, data-present/empty signals (new events, start at 0)
--   retention   — Day 1/7/30 cohort retention (all-time); per-period retention
--                 segmented by integration status, Trends use, and logging activity
--   daily_activity — 30-day DAU sparkline (always the trailing 30 calendar days)
--   logging     — Per-action logging engagement: unique, repeat, returning
--   first_action — First meaningful action each device took (all-time)
--   activation  — Enhanced onboarding → first integration → first use → return
--
-- Privacy:
--   Returns only aggregated counts. No device IDs, no health values, no
--   individual-level data. Callers must supply SUPABASE_SERVICE_ROLE_KEY
--   (enforced via REVOKE below; same model as v1).
--
-- Backward compatibility:
--   All keys present in get_analytics_summary are preserved under the same
--   names so the existing dashboard continues to work while the new
--   sections are added incrementally.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION get_analytics_v2(p_since timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- ── Core overview ─────────────────────────────────────────────────────────
  v_total_devices    bigint;
  v_active_devices   bigint;
  v_new_devices      bigint;
  v_returning        bigint;
  v_funnel           jsonb;
  v_integrations     jsonb;
  v_feature_usage    jsonb;
  v_feature_repeat   jsonb;
  v_story            jsonb;

  -- ── Trends breakdown ──────────────────────────────────────────────────────
  v_trends_viewers      bigint;
  v_trends_w_oura       bigint;
  v_trends_w_apple      bigint;
  v_trends_w_any        bigint;
  v_trends_no_integ     bigint;
  v_trends_avg          numeric;
  v_trends_median       numeric;
  v_trends_multiday     bigint;
  v_trends_data_present bigint := 0;
  v_trends_data_empty   bigint := 0;

  -- ── Retention cohorts (all-time) ──────────────────────────────────────────
  v_d1_cohort  bigint := 0; v_d1_retained  bigint := 0;
  v_d7_cohort  bigint := 0; v_d7_retained  bigint := 0;
  v_d30_cohort bigint := 0; v_d30_retained bigint := 0;

  -- ── Retention by segment (period-scoped activity) ─────────────────────────
  v_ret_integ_active      bigint := 0; v_ret_integ_returning      bigint := 0;
  v_ret_nointeg_active    bigint := 0; v_ret_nointeg_returning    bigint := 0;
  v_ret_trends_active     bigint := 0; v_ret_trends_returning     bigint := 0;
  v_ret_notrends_active   bigint := 0; v_ret_notrends_returning   bigint := 0;
  v_ret_log_active        bigint := 0; v_ret_log_returning        bigint := 0;
  v_ret_nolog_active      bigint := 0; v_ret_nolog_returning      bigint := 0;

  -- ── Other ─────────────────────────────────────────────────────────────────
  v_daily_activity jsonb;
  v_logging        jsonb;
  v_first_action   jsonb;

  -- ── Activation funnel (all-time) ──────────────────────────────────────────
  v_act_first_open      bigint := 0;
  v_act_onb_completed   bigint := 0;
  v_act_any_integ       bigint := 0;
  v_act_trends          bigint := 0;
  v_act_first_log       bigint := 0;
  v_act_returned        bigint := 0;

BEGIN

  -- ════════════════════════════════════════════════════════════════════════════
  -- CORE OVERVIEW
  -- ════════════════════════════════════════════════════════════════════════════

  SELECT COUNT(DISTINCT device_id)
  INTO v_total_devices FROM analytics_events;

  SELECT COUNT(DISTINCT device_id)
  INTO v_active_devices
  FROM analytics_events
  WHERE p_since IS NULL OR created_at >= p_since;

  SELECT COUNT(*)
  INTO v_new_devices
  FROM (
    SELECT device_id FROM analytics_events
    GROUP BY device_id
    HAVING MIN(created_at) >= COALESCE(p_since, '-infinity'::timestamptz)
  ) t;

  SELECT COUNT(*)
  INTO v_returning
  FROM (
    SELECT device_id FROM analytics_events
    WHERE p_since IS NULL OR created_at >= p_since
    GROUP BY device_id
    HAVING COUNT(DISTINCT created_at::date) >= 2
  ) t;

  -- Onboarding funnel — always all-time (cumulative, not period-scoped)
  SELECT jsonb_build_object(
    'first_open',           COUNT(DISTINCT CASE WHEN event_name = 'app_first_open'       THEN device_id END),
    'onboarding_started',   COUNT(DISTINCT CASE WHEN event_name = 'onboarding_started'   THEN device_id END),
    'onboarding_completed', COUNT(DISTINCT CASE WHEN event_name = 'onboarding_completed' THEN device_id END)
  ) INTO v_funnel FROM analytics_events;

  -- Integrations — always all-time (connection events fire once per install)
  SELECT jsonb_build_object(
    'oura',         COUNT(DISTINCT CASE WHEN event_name = 'oura_connected'         THEN device_id END),
    'apple_health', COUNT(DISTINCT CASE WHEN event_name = 'apple_health_connected' THEN device_id END)
  ) INTO v_integrations FROM analytics_events;

  -- Feature usage: distinct devices, at least one event in period
  SELECT jsonb_object_agg(event_name, cnt)
  INTO v_feature_usage
  FROM (
    SELECT event_name, COUNT(DISTINCT device_id) AS cnt
    FROM analytics_events
    WHERE (p_since IS NULL OR created_at >= p_since)
      AND event_name IN (
        'home_viewed', 'context_viewed', 'trends_viewed', 'your_story_viewed',
        'pattern_prompt_viewed', 'pattern_prompt_answered',
        'water_logged', 'meal_logged', 'caffeine_logged', 'drinking_plan_used',
        'recovery_logged', 'context_added', 'gratitude_logged',
        'daily_checkin_completed', 'ai_chat_used', 'breathing_started', 'document_uploaded'
      )
    GROUP BY event_name
  ) t;

  -- Feature repeat: distinct devices that used a feature on 2+ different calendar days
  SELECT jsonb_object_agg(event_name, cnt)
  INTO v_feature_repeat
  FROM (
    SELECT event_name, COUNT(*) AS cnt
    FROM (
      SELECT device_id, event_name
      FROM analytics_events
      WHERE (p_since IS NULL OR created_at >= p_since)
        AND event_name IN (
          'home_viewed', 'context_viewed', 'trends_viewed', 'your_story_viewed',
          'pattern_prompt_viewed', 'pattern_prompt_answered',
          'water_logged', 'meal_logged', 'caffeine_logged', 'drinking_plan_used',
          'recovery_logged', 'context_added', 'gratitude_logged',
          'daily_checkin_completed', 'ai_chat_used', 'breathing_started', 'document_uploaded'
        )
      GROUP BY device_id, event_name
      HAVING COUNT(DISTINCT created_at::date) >= 2
    ) inner_t
    GROUP BY event_name
  ) outer_t;

  -- Story engagement
  SELECT jsonb_build_object(
    'story_shown',    COUNT(DISTINCT CASE WHEN event_name = 'your_story_viewed' THEN device_id END),
    'context_opened', COUNT(DISTINCT CASE WHEN event_name = 'context_viewed'    THEN device_id END)
  ) INTO v_story
  FROM analytics_events
  WHERE p_since IS NULL OR created_at >= p_since;


  -- ════════════════════════════════════════════════════════════════════════════
  -- TRENDS BREAKDOWN
  -- Primary question: are Trends users returning because they have data?
  -- Integration lookup is always all-time (connection events are one-time).
  -- ════════════════════════════════════════════════════════════════════════════

  SELECT COUNT(DISTINCT device_id)
  INTO v_trends_viewers
  FROM analytics_events
  WHERE event_name = 'trends_viewed'
    AND (p_since IS NULL OR created_at >= p_since);

  -- Viewers who also have an all-time Oura connection event
  SELECT COUNT(DISTINCT tv.device_id)
  INTO v_trends_w_oura
  FROM (
    SELECT DISTINCT device_id FROM analytics_events
    WHERE event_name = 'trends_viewed' AND (p_since IS NULL OR created_at >= p_since)
  ) tv
  WHERE EXISTS (
    SELECT 1 FROM analytics_events i
    WHERE i.device_id = tv.device_id AND i.event_name = 'oura_connected'
  );

  -- Viewers who also have an all-time Apple Health connection event
  SELECT COUNT(DISTINCT tv.device_id)
  INTO v_trends_w_apple
  FROM (
    SELECT DISTINCT device_id FROM analytics_events
    WHERE event_name = 'trends_viewed' AND (p_since IS NULL OR created_at >= p_since)
  ) tv
  WHERE EXISTS (
    SELECT 1 FROM analytics_events i
    WHERE i.device_id = tv.device_id AND i.event_name = 'apple_health_connected'
  );

  -- Viewers with Oura OR Apple Health (either/both)
  SELECT COUNT(DISTINCT tv.device_id)
  INTO v_trends_w_any
  FROM (
    SELECT DISTINCT device_id FROM analytics_events
    WHERE event_name = 'trends_viewed' AND (p_since IS NULL OR created_at >= p_since)
  ) tv
  WHERE EXISTS (
    SELECT 1 FROM analytics_events i
    WHERE i.device_id = tv.device_id
      AND i.event_name IN ('oura_connected', 'apple_health_connected')
  );

  v_trends_no_integ := GREATEST(0, v_trends_viewers - v_trends_w_any);

  -- Avg and median Trends opens per device (over the period)
  SELECT
    ROUND(AVG(visits)::numeric, 1),
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY visits)::numeric
  INTO v_trends_avg, v_trends_median
  FROM (
    SELECT COUNT(*) AS visits
    FROM analytics_events
    WHERE event_name = 'trends_viewed' AND (p_since IS NULL OR created_at >= p_since)
    GROUP BY device_id
  ) counts;

  -- Devices that opened Trends on 2+ different calendar days
  SELECT COUNT(*)
  INTO v_trends_multiday
  FROM (
    SELECT device_id FROM analytics_events
    WHERE event_name = 'trends_viewed' AND (p_since IS NULL OR created_at >= p_since)
    GROUP BY device_id
    HAVING COUNT(DISTINCT created_at::date) >= 2
  ) t;

  -- Data quality events (new — zero until Build 133+ ships)
  SELECT COUNT(DISTINCT device_id)
  INTO v_trends_data_present
  FROM analytics_events
  WHERE event_name = 'trends_data_present' AND (p_since IS NULL OR created_at >= p_since);

  SELECT COUNT(DISTINCT device_id)
  INTO v_trends_data_empty
  FROM analytics_events
  WHERE event_name = 'trends_data_empty' AND (p_since IS NULL OR created_at >= p_since);


  -- ════════════════════════════════════════════════════════════════════════════
  -- RETENTION COHORTS — always all-time regardless of p_since
  -- Window definition: Day 1 = returned on days 1-3 after first seen
  --                    Day 7 = returned on days 6-9
  --                    Day 30 = returned on days 28-33
  -- Using a ±1-2 day window avoids punishing users who open every other day.
  -- ════════════════════════════════════════════════════════════════════════════

  WITH first_seen AS (
    SELECT device_id, MIN(created_at)::date AS first_day
    FROM analytics_events
    GROUP BY device_id
  ),
  all_active_days AS (
    SELECT DISTINCT device_id, created_at::date AS active_day
    FROM analytics_events
  )
  SELECT
    COUNT(DISTINCT CASE WHEN fs.first_day <= CURRENT_DATE - 2
      THEN fs.device_id END),
    COUNT(DISTINCT CASE WHEN fs.first_day <= CURRENT_DATE - 2 AND EXISTS (
      SELECT 1 FROM all_active_days a
      WHERE a.device_id = fs.device_id
        AND a.active_day BETWEEN fs.first_day + 1 AND fs.first_day + 3
    ) THEN fs.device_id END),
    COUNT(DISTINCT CASE WHEN fs.first_day <= CURRENT_DATE - 7
      THEN fs.device_id END),
    COUNT(DISTINCT CASE WHEN fs.first_day <= CURRENT_DATE - 7 AND EXISTS (
      SELECT 1 FROM all_active_days a
      WHERE a.device_id = fs.device_id
        AND a.active_day BETWEEN fs.first_day + 6 AND fs.first_day + 9
    ) THEN fs.device_id END),
    COUNT(DISTINCT CASE WHEN fs.first_day <= CURRENT_DATE - 30
      THEN fs.device_id END),
    COUNT(DISTINCT CASE WHEN fs.first_day <= CURRENT_DATE - 30 AND EXISTS (
      SELECT 1 FROM all_active_days a
      WHERE a.device_id = fs.device_id
        AND a.active_day BETWEEN fs.first_day + 28 AND fs.first_day + 33
    ) THEN fs.device_id END)
  INTO
    v_d1_cohort,  v_d1_retained,
    v_d7_cohort,  v_d7_retained,
    v_d30_cohort, v_d30_retained
  FROM first_seen fs;


  -- ════════════════════════════════════════════════════════════════════════════
  -- RETENTION BY SEGMENT
  -- Uses period-scoped activity (p_since), but integration status is all-time.
  -- Correlation note: returning users in a segment may have returned for
  -- reasons unrelated to that segment's characteristic. These numbers show
  -- co-occurrence, not causation.
  -- ════════════════════════════════════════════════════════════════════════════

  WITH integ AS (
    -- Devices that ever connected an integration (all-time)
    SELECT DISTINCT device_id FROM analytics_events
    WHERE event_name IN ('oura_connected', 'apple_health_connected')
  ),
  trends_devs AS (
    -- Devices that opened Trends in this period
    SELECT DISTINCT device_id FROM analytics_events
    WHERE event_name = 'trends_viewed'
      AND (p_since IS NULL OR created_at >= p_since)
  ),
  log_devs AS (
    -- Devices that logged anything in this period
    SELECT DISTINCT device_id FROM analytics_events
    WHERE event_name IN (
      'meal_logged','caffeine_logged','drinking_plan_used','recovery_logged',
      'gratitude_logged','daily_checkin_completed','water_logged',
      'breathing_started','context_added'
    )
    AND (p_since IS NULL OR created_at >= p_since)
  ),
  period_activity AS (
    SELECT device_id, COUNT(DISTINCT created_at::date) AS days_active
    FROM analytics_events
    WHERE p_since IS NULL OR created_at >= p_since
    GROUP BY device_id
  )
  SELECT
    -- integration segment
    COUNT(CASE WHEN EXISTS (SELECT 1 FROM integ x WHERE x.device_id = pa.device_id)
               THEN 1 END),
    COUNT(CASE WHEN EXISTS (SELECT 1 FROM integ x WHERE x.device_id = pa.device_id)
               AND pa.days_active >= 2 THEN 1 END),
    COUNT(CASE WHEN NOT EXISTS (SELECT 1 FROM integ x WHERE x.device_id = pa.device_id)
               THEN 1 END),
    COUNT(CASE WHEN NOT EXISTS (SELECT 1 FROM integ x WHERE x.device_id = pa.device_id)
               AND pa.days_active >= 2 THEN 1 END),
    -- Trends segment
    COUNT(CASE WHEN EXISTS (SELECT 1 FROM trends_devs td WHERE td.device_id = pa.device_id)
               THEN 1 END),
    COUNT(CASE WHEN EXISTS (SELECT 1 FROM trends_devs td WHERE td.device_id = pa.device_id)
               AND pa.days_active >= 2 THEN 1 END),
    COUNT(CASE WHEN NOT EXISTS (SELECT 1 FROM trends_devs td WHERE td.device_id = pa.device_id)
               THEN 1 END),
    COUNT(CASE WHEN NOT EXISTS (SELECT 1 FROM trends_devs td WHERE td.device_id = pa.device_id)
               AND pa.days_active >= 2 THEN 1 END),
    -- logging segment
    COUNT(CASE WHEN EXISTS (SELECT 1 FROM log_devs ld WHERE ld.device_id = pa.device_id)
               THEN 1 END),
    COUNT(CASE WHEN EXISTS (SELECT 1 FROM log_devs ld WHERE ld.device_id = pa.device_id)
               AND pa.days_active >= 2 THEN 1 END),
    COUNT(CASE WHEN NOT EXISTS (SELECT 1 FROM log_devs ld WHERE ld.device_id = pa.device_id)
               THEN 1 END),
    COUNT(CASE WHEN NOT EXISTS (SELECT 1 FROM log_devs ld WHERE ld.device_id = pa.device_id)
               AND pa.days_active >= 2 THEN 1 END)
  INTO
    v_ret_integ_active,    v_ret_integ_returning,
    v_ret_nointeg_active,  v_ret_nointeg_returning,
    v_ret_trends_active,   v_ret_trends_returning,
    v_ret_notrends_active, v_ret_notrends_returning,
    v_ret_log_active,      v_ret_log_returning,
    v_ret_nolog_active,    v_ret_nolog_returning
  FROM period_activity pa;


  -- ════════════════════════════════════════════════════════════════════════════
  -- DAILY ACTIVITY SPARKLINE — always trailing 30 calendar days
  -- ════════════════════════════════════════════════════════════════════════════

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object('day', day_str, 'devices', active_devices)
      ORDER BY day_str
    ),
    '[]'::jsonb
  )
  INTO v_daily_activity
  FROM (
    SELECT
      to_char(created_at::date, 'YYYY-MM-DD') AS day_str,
      COUNT(DISTINCT device_id) AS active_devices
    FROM analytics_events
    WHERE created_at >= CURRENT_DATE - 30
    GROUP BY created_at::date
  ) t;


  -- ════════════════════════════════════════════════════════════════════════════
  -- LOGGING ENGAGEMENT
  -- For each log action: unique loggers, repeat loggers (2+ events),
  -- total events, and returning loggers (logged AND returned on 2+ days).
  -- "Returning" shows co-occurrence with retention, not causation.
  -- ════════════════════════════════════════════════════════════════════════════

  WITH period_returners AS (
    SELECT device_id FROM analytics_events
    WHERE p_since IS NULL OR created_at >= p_since
    GROUP BY device_id
    HAVING COUNT(DISTINCT created_at::date) >= 2
  ),
  log_counts AS (
    SELECT device_id, event_name, COUNT(*) AS event_count
    FROM analytics_events
    WHERE event_name IN (
      'meal_logged','caffeine_logged','drinking_plan_used','recovery_logged',
      'gratitude_logged','daily_checkin_completed','water_logged','breathing_started'
    )
    AND (p_since IS NULL OR created_at >= p_since)
    GROUP BY device_id, event_name
  )
  SELECT jsonb_object_agg(
    lc.event_name,
    jsonb_build_object(
      'unique_loggers',    agg.unique_loggers,
      'total_events',      agg.total_events,
      'repeat_loggers',    agg.repeat_loggers,
      'returning_loggers', agg.returning_loggers
    )
  )
  INTO v_logging
  FROM (
    SELECT
      event_name,
      COUNT(DISTINCT device_id)                                                 AS unique_loggers,
      SUM(event_count)                                                          AS total_events,
      COUNT(DISTINCT CASE WHEN event_count >= 2 THEN device_id END)             AS repeat_loggers,
      COUNT(DISTINCT CASE WHEN device_id IN (SELECT device_id FROM period_returners)
                          THEN device_id END)                                   AS returning_loggers
    FROM log_counts
    GROUP BY event_name
  ) agg
  -- alias needed for jsonb_object_agg (it needs a FROM alias)
  JOIN (SELECT DISTINCT event_name FROM log_counts) lc USING (event_name);


  -- ════════════════════════════════════════════════════════════════════════════
  -- FIRST MEANINGFUL ACTION (all-time)
  -- The first non-lifecycle event each device ever fired — indicates what
  -- initially drew users beyond onboarding.
  -- ════════════════════════════════════════════════════════════════════════════

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object('event', event_name, 'devices', device_count)
      ORDER BY device_count DESC
    ),
    '[]'::jsonb
  )
  INTO v_first_action
  FROM (
    SELECT event_name, COUNT(DISTINCT device_id) AS device_count
    FROM (
      -- For each device, the earliest non-lifecycle event
      SELECT DISTINCT ON (device_id) device_id, event_name
      FROM analytics_events
      WHERE event_name NOT IN (
        'app_first_open','app_opened','home_viewed',
        'onboarding_started','onboarding_completed'
      )
      ORDER BY device_id, created_at ASC
    ) first_non_lifecycle
    GROUP BY event_name
    ORDER BY device_count DESC
    LIMIT 10
  ) t;


  -- ════════════════════════════════════════════════════════════════════════════
  -- ACTIVATION FUNNEL (all-time, cumulative)
  -- Tracks the journey from first open to return visit.
  -- Each stage is all-time distinct devices — not a strict sequential funnel
  -- (a device can appear in "first_log" without appearing in "any_integration").
  -- ════════════════════════════════════════════════════════════════════════════

  SELECT
    COUNT(DISTINCT CASE WHEN event_name = 'app_first_open'       THEN device_id END),
    COUNT(DISTINCT CASE WHEN event_name = 'onboarding_completed' THEN device_id END),
    COUNT(DISTINCT CASE WHEN event_name = 'trends_viewed'        THEN device_id END),
    COUNT(DISTINCT CASE WHEN event_name IN (
      'meal_logged','caffeine_logged','drinking_plan_used','recovery_logged',
      'gratitude_logged','daily_checkin_completed','water_logged',
      'breathing_started','context_added'
    ) THEN device_id END)
  INTO v_act_first_open, v_act_onb_completed, v_act_trends, v_act_first_log
  FROM analytics_events;

  SELECT COUNT(DISTINCT device_id)
  INTO v_act_any_integ
  FROM analytics_events
  WHERE event_name IN ('oura_connected', 'apple_health_connected');

  SELECT COUNT(*)
  INTO v_act_returned
  FROM (
    SELECT device_id FROM analytics_events
    GROUP BY device_id
    HAVING COUNT(DISTINCT created_at::date) >= 2
  ) t;


  -- ════════════════════════════════════════════════════════════════════════════
  -- RETURN PAYLOAD
  -- ════════════════════════════════════════════════════════════════════════════

  RETURN jsonb_build_object(

    -- ── Core (v1-compatible keys) ──────────────────────────────────────────
    'total_devices',     v_total_devices,
    'active_devices',    v_active_devices,
    'new_devices',       v_new_devices,
    'returning_devices', v_returning,
    'funnel',            v_funnel,
    'integrations',      v_integrations,
    'feature_usage',     COALESCE(v_feature_usage,  '{}'::jsonb),
    'feature_repeat',    COALESCE(v_feature_repeat, '{}'::jsonb),
    'story',             v_story,

    -- ── Trends breakdown ──────────────────────────────────────────────────
    'trends', jsonb_build_object(
      'unique_viewers',       v_trends_viewers,
      'with_oura',            v_trends_w_oura,
      'with_apple_health',    v_trends_w_apple,
      'with_any_integration', v_trends_w_any,
      'no_known_integration', v_trends_no_integ,
      'avg_visits',           v_trends_avg,
      'median_visits',        v_trends_median,
      'multiday_viewers',     v_trends_multiday,
      'data_present',         v_trends_data_present,
      'data_empty',           v_trends_data_empty
    ),

    -- ── Retention ─────────────────────────────────────────────────────────
    'retention', jsonb_build_object(
      'cohorts', jsonb_build_object(
        'day1',  jsonb_build_object('cohort', v_d1_cohort,  'retained', v_d1_retained),
        'day7',  jsonb_build_object('cohort', v_d7_cohort,  'retained', v_d7_retained),
        'day30', jsonb_build_object('cohort', v_d30_cohort, 'retained', v_d30_retained)
      ),
      'by_integration', jsonb_build_object(
        'with_integration',     jsonb_build_object('active', v_ret_integ_active,   'returning', v_ret_integ_returning),
        'no_known_integration', jsonb_build_object('active', v_ret_nointeg_active, 'returning', v_ret_nointeg_returning)
      ),
      'by_trends_use', jsonb_build_object(
        'trends_users', jsonb_build_object('active', v_ret_trends_active,   'returning', v_ret_trends_returning),
        'no_trends',    jsonb_build_object('active', v_ret_notrends_active, 'returning', v_ret_notrends_returning)
      ),
      'by_logging', jsonb_build_object(
        'logged_something', jsonb_build_object('active', v_ret_log_active,  'returning', v_ret_log_returning),
        'no_logging',       jsonb_build_object('active', v_ret_nolog_active, 'returning', v_ret_nolog_returning)
      )
    ),

    -- ── Supporting data ───────────────────────────────────────────────────
    'daily_activity', v_daily_activity,
    'logging',        COALESCE(v_logging, '{}'::jsonb),
    'first_action',   COALESCE(v_first_action, '[]'::jsonb),
    'activation',     jsonb_build_object(
      'first_open',           v_act_first_open,
      'onboarding_completed', v_act_onb_completed,
      'any_integration',      v_act_any_integ,
      'first_trends_view',    v_act_trends,
      'first_log',            v_act_first_log,
      'returned',             v_act_returned
    ),

    -- ── Meta ──────────────────────────────────────────────────────────────
    'generated_at',   now(),
    'period_start',   p_since,
    'schema_version', 2
  );

END;
$$;

-- ─── Permissions (same model as v1) ──────────────────────────────────────────
-- Only service_role (used by the Edge Function) may call this function.
-- anon and authenticated callers are explicitly denied.
REVOKE EXECUTE ON FUNCTION get_analytics_v2(timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_analytics_v2(timestamptz) FROM anon;
REVOKE EXECUTE ON FUNCTION get_analytics_v2(timestamptz) FROM authenticated;
GRANT  EXECUTE ON FUNCTION get_analytics_v2(timestamptz) TO service_role;
