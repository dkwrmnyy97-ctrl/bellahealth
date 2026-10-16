// Supabase Edge Function — analytics event ingestion
//
// Accepts POST { device_id, event_name, source_screen } from the BellaHealth
// mobile client. Validates the payload server-side against an allowlist, then
// writes to analytics_events using the service-role key (which bypasses RLS).
//
// The anon key CANNOT insert directly into analytics_events — all inserts flow
// through this function. The service-role key is never sent to the client.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ─── Allowlists ───────────────────────────────────────────────────────────────

const ALLOWED_EVENTS = new Set([
  // App lifecycle
  'app_first_open',
  'app_opened',
  'home_viewed',
  // Onboarding funnel
  'onboarding_started',
  'onboarding_completed',
  // Integrations
  'oura_connected',
  'apple_health_connected',
  // Feature engagement
  'trends_viewed',
  'trends_data_present',
  'trends_data_empty',
  'context_viewed',
  'context_added',
  'your_story_viewed',
  'pattern_prompt_viewed',
  'pattern_prompt_answered',
  'meal_logged',
  'water_logged',
  'ai_chat_used',
  'document_uploaded',
  'caffeine_logged',
  'drinking_plan_used',
  'recovery_logged',
  'breathing_started',
  'gratitude_logged',
  'daily_checkin_completed',
]);

const ALLOWED_SCREENS = new Set([
  'home',
  'profile',
  'context',
  'trends',
  'meals',
  'chat',
  'documents',
  'caffeine',
  'drinking',
  'wellness',
  'grounding',
  'cycle',
]);

// RFC 4122 v4 UUID
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ─── CORS ─────────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
};

// ─── Handler ──────────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return new Response(null, { status: 405, headers: CORS_HEADERS });
  }

  // ── Parse body ──────────────────────────────────────────────────────────────
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(null, { status: 400, headers: CORS_HEADERS });
  }

  if (typeof body !== 'object' || body === null) {
    return new Response(null, { status: 400, headers: CORS_HEADERS });
  }

  const { device_id, event_name, source_screen } =
    body as Record<string, unknown>;

  // ── Validate device_id ──────────────────────────────────────────────────────
  if (typeof device_id !== 'string' || !UUID_RE.test(device_id)) {
    return new Response(null, { status: 400, headers: CORS_HEADERS });
  }

  // ── Validate event_name against allowlist ───────────────────────────────────
  if (typeof event_name !== 'string' || !ALLOWED_EVENTS.has(event_name)) {
    return new Response(null, { status: 400, headers: CORS_HEADERS });
  }

  // ── Validate source_screen against allowlist (nullable) ─────────────────────
  const screen = source_screen ?? null;
  if (
    screen !== null &&
    (typeof screen !== 'string' || !ALLOWED_SCREENS.has(screen))
  ) {
    return new Response(null, { status: 400, headers: CORS_HEADERS });
  }

  // ── Insert via service role (bypasses RLS) ──────────────────────────────────
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { error } = await supabase.from('analytics_events').insert({
    device_id,
    event_name,
    source_screen: screen,
    // created_at is set by the DB default (now()) — never trust client timestamps
    // metadata column is left null — not accepted from the client
  });

  if (error) {
    console.error('[ingest-event] insert error:', error.message);
    return new Response(null, { status: 500, headers: CORS_HEADERS });
  }

  return new Response(null, { status: 204, headers: CORS_HEADERS });
});
