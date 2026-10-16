// Supabase Edge Function — log-meal
//
// Persists a BellaHealth Food AI meal to nutrition_log.
//
// SECURITY:
//   - Requires a valid Supabase session JWT (Authorization: Bearer <token>).
//   - auth.uid() is derived exclusively from the verified JWT — never from
//     the request body. Any client-supplied user_id field is silently ignored.
//   - The service-role key is never sent to or visible from the client.
//
// POST body (required fields + one optional):
//   {
//     meal_name   : 'Breakfast' | 'Lunch' | 'Dinner' | 'Snack',
//     items       : string (food description, max 2 000 chars),
//     calories    : number (0–10 000),
//     protein_g   : number (0–500),
//     carbs_g     : number (0–500),
//     fat_g       : number (0–500),
//     source      : 'photo_ai' | 'text_ai' | 'manual',
//     consumed_at?: ISO 8601 timestamp — when the user actually ate this meal.
//                   Omit when timing is unknown (e.g. batch upload).
//                   NEVER derived from the request arrival time.
//                   If present, must parse to a valid Date and be within ±48h of now.
//   }
//
// Returns 201 { id } on success.
//
// Required secrets (auto-injected by Supabase):
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── Validation allowlists ─────────────────────────────────────────────────────
const VALID_MEAL_NAMES = new Set(['Breakfast', 'Lunch', 'Dinner', 'Snack']);
const VALID_SOURCES    = new Set(['photo_ai', 'text_ai', 'manual']);
const MAX_ITEMS_LEN    = 2000;
const MAX_CALORIES     = 10000;
const MAX_MACRO_G      = 500;

// ── CORS ──────────────────────────────────────────────────────────────────────
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

// ── Handler ───────────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== 'POST')   return new Response(null, { status: 405, headers: CORS_HEADERS });

  // ── Verify JWT ──────────────────────────────────────────────────────────────
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return json({ error: 'Authorization required' }, 401);
  }

  const supabaseUser = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const { data: { user }, error: authError } = await supabaseUser.auth.getUser();
  if (authError || !user) {
    return json({ error: 'Unauthorized' }, 401);
  }

  // auth.uid() is now established — never overridden by client data
  const userId = user.id;

  // ── Parse and validate body ─────────────────────────────────────────────────
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Request body must be valid JSON' }, 400);
  }

  const { meal_name, items, calories, protein_g, carbs_g, fat_g, source, consumed_at } = body;

  if (typeof meal_name !== 'string' || !VALID_MEAL_NAMES.has(meal_name)) {
    return json({ error: 'meal_name must be Breakfast, Lunch, Dinner, or Snack' }, 400);
  }
  if (typeof items !== 'string' || items.length > MAX_ITEMS_LEN) {
    return json({ error: `items must be a string of at most ${MAX_ITEMS_LEN} characters` }, 400);
  }
  if (typeof calories  !== 'number' || calories  < 0 || calories  > MAX_CALORIES) {
    return json({ error: `calories must be a number between 0 and ${MAX_CALORIES}` }, 400);
  }
  if (typeof protein_g !== 'number' || protein_g < 0 || protein_g > MAX_MACRO_G) {
    return json({ error: `protein_g must be a number between 0 and ${MAX_MACRO_G}` }, 400);
  }
  if (typeof carbs_g   !== 'number' || carbs_g   < 0 || carbs_g   > MAX_MACRO_G) {
    return json({ error: `carbs_g must be a number between 0 and ${MAX_MACRO_G}` }, 400);
  }
  if (typeof fat_g     !== 'number' || fat_g     < 0 || fat_g     > MAX_MACRO_G) {
    return json({ error: `fat_g must be a number between 0 and ${MAX_MACRO_G}` }, 400);
  }
  if (typeof source !== 'string' || !VALID_SOURCES.has(source)) {
    return json({ error: 'source must be photo_ai, text_ai, or manual' }, 400);
  }

  // consumed_at is optional. When provided it must be a valid ISO timestamp
  // and must fall within ±48 hours of now (guards against far-future or
  // clearly-wrong dates while allowing retroactive batch logging).
  let consumedAtValue: string | null = null;
  if (consumed_at !== undefined) {
    if (typeof consumed_at !== 'string') {
      return json({ error: 'consumed_at must be an ISO 8601 timestamp string if provided' }, 400);
    }
    const parsed = new Date(consumed_at);
    if (isNaN(parsed.getTime())) {
      return json({ error: 'consumed_at is not a valid ISO 8601 timestamp' }, 400);
    }
    const diffHours = Math.abs(Date.now() - parsed.getTime()) / 3_600_000;
    if (diffHours > 48) {
      return json({ error: 'consumed_at must be within 48 hours of now' }, 400);
    }
    consumedAtValue = parsed.toISOString();
  }

  // ── Insert via service role ─────────────────────────────────────────────────
  // user_id is set from the verified JWT, not from body. Service role bypasses
  // RLS; auth identity was already verified above.
  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data, error: insertError } = await supabaseAdmin
    .from('nutrition_log')
    .insert({
      user_id:     userId,                  // derived from verified JWT only
      logged_at:   new Date().toISOString(), // server write time — NOT consumption time
      consumed_at: consumedAtValue,          // user-declared eat time; null = unknown
      meal_name,
      items,
      calories,
      protein_g,
      carbs_g,
      fat_g,
      water_oz: 0,                           // meals do not track water
      source,
    })
    .select('id')
    .single();

  if (insertError) {
    console.error('[log-meal] insert error:', insertError.message);
    return json({ error: 'Failed to save meal' }, 500);
  }

  return json({ id: data.id }, 201);
});
