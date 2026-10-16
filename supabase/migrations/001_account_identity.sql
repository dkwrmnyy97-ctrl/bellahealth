-- 001_account_identity.sql
-- BellaHealth — Account Identity + Cloud Persistence
--
-- Creates four tables for V1 cloud sync scope:
--   user_profiles    — mirrors AsyncStorage 'user_profile'
--   training_goals   — mirrors AsyncStorage 'training_goals'
--   context_events   — structured events; notes column intentionally omitted
--   drink_log        — mirrors AsyncStorage 'drink_log'
--
-- RLS: every table is fully locked to auth.uid() = owner.
-- Anonymous users get a row immediately on first sync.
-- When anonymous is upgraded to Apple account, uid is preserved → rows carry over.

-- ── user_profiles ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.user_profiles (
  id               UUID         PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name             TEXT,
  age              INTEGER,
  gender           TEXT,
  height_display   TEXT,        -- stored as user entered, e.g. "5'6\""
  weight_lbs       REAL,
  weight_goal_lbs  REAL,
  step_goal        INTEGER      DEFAULT 10000,
  cal_goal         INTEGER      DEFAULT 2000,
  sleep_goal       REAL         DEFAULT 8,
  water_goal_oz    INTEGER      DEFAULT 80,
  supplements      TEXT,
  companion_apps   JSONB        DEFAULT '[]',
  units            TEXT         DEFAULT 'automatic',
  updated_at       TIMESTAMPTZ  DEFAULT now()
);

ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_profiles_owner ON public.user_profiles
  FOR ALL
  USING  (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- ── training_goals ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.training_goals (
  user_id     UUID         PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  body        TEXT,        -- 'cut' | 'bulk' | 'recomp' | 'maintenance' | null
  perf        TEXT,        -- 'marathon' | '5k' | 'strength' | 'sport' | 'general' | null
  updated_at  TIMESTAMPTZ  DEFAULT now()
);

ALTER TABLE public.training_goals ENABLE ROW LEVEL SECURITY;

CREATE POLICY training_goals_owner ON public.training_goals
  FOR ALL
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ── context_events ─────────────────────────────────────────────────────────────
-- Notes are intentionally absent — they are personal free-text and never leave
-- the device. All other structured fields are safe to sync.

CREATE TABLE IF NOT EXISTS public.context_events (
  id          TEXT         PRIMARY KEY,   -- client-generated UUID
  user_id     UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type        TEXT         NOT NULL,
  source      TEXT         NOT NULL,
  label       TEXT,
  start_date  DATE         NOT NULL,
  end_date    DATE,
  metadata    JSONB,
  created_at  TIMESTAMPTZ  NOT NULL,
  updated_at  TIMESTAMPTZ  NOT NULL
);

CREATE INDEX IF NOT EXISTS context_events_user_idx ON public.context_events(user_id);

ALTER TABLE public.context_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY context_events_owner ON public.context_events
  FOR ALL
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ── drink_log ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.drink_log (
  user_id        UUID     NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  date           DATE     NOT NULL,
  total_drinks   INTEGER  DEFAULT 0,
  total_calories INTEGER  DEFAULT 0,
  vibe           TEXT,
  counts         JSONB,
  PRIMARY KEY (user_id, date)
);

CREATE INDEX IF NOT EXISTS drink_log_user_idx ON public.drink_log(user_id);

ALTER TABLE public.drink_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY drink_log_owner ON public.drink_log
  FOR ALL
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
