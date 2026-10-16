// Supabase REST API client — nutrition data
//
// nutrition_log is protected by RLS. Reads require a valid Supabase session JWT
// so that auth.uid() = user_id is enforced server-side. The anon key identifies
// the project; the JWT identifies the user. Both are required.
//
// Writes go through the log-meal Edge Function, which verifies the JWT and
// derives auth.uid() server-side. user_id is never accepted from the client.

import { getAuthToken } from '@/services/auth';

const SUPABASE_URL      = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
const LOG_MEAL_URL      = `${SUPABASE_URL}/functions/v1/log-meal`;

export type NutritionLog = {
  id:         number;
  /**
   * Server-set timestamp of when the row was written to the database.
   * This is the UPLOAD time, not the consumption time.
   * A user batch-uploading meals at 9 PM will have logged_at ≈ 9 PM for all rows,
   * regardless of when the meals were actually eaten.
   * NEVER use this field to infer meal timing.
   */
  logged_at:    string;
  /**
   * User-declared time of actual consumption (ISO timestamptz).
   * NULL / absent = timing is UNKNOWN — no timing analysis should be performed.
   * Only populated on rows created after the 20260924_nutrition_consumed_at migration
   * when the user explicitly provided or confirmed the time.
   */
  consumed_at?: string;
  water_oz:     number;
  calories:     number;
  protein_g:    number;
  carbs_g:      number;
  fat_g:        number;
  source:       string;
  meal_name?:   string;
  items?:       string;
};

/**
 * The shape of a meal write sent to the log-meal Edge Function.
 * Mirrors LoggedMeal from meals-modal but uses the nutrition_log column names.
 * user_id is intentionally absent — the Edge Function derives it from the JWT.
 */
export type MealPayload = {
  meal_name:    string;   // 'Breakfast' | 'Lunch' | 'Dinner' | 'Snack'
  items:        string;   // food description
  calories:     number;
  protein_g:    number;
  carbs_g:      number;
  fat_g:        number;
  source:       string;   // 'photo_ai' | 'text_ai' | 'manual'
  /**
   * When the user actually ate this meal (ISO timestamptz).
   * Omit when timing is unknown (e.g. batch upload without time selection).
   * NEVER set this to the logging/upload time — that is logged_at, which the
   * Edge Function sets server-side. This field is only meaningful when the
   * user has explicitly declared or confirmed the consumption time.
   */
  consumed_at?: string;
};

/**
 * Fetch today's nutrition rows and sum them into a single total.
 *
 * Requires an active Supabase session. The Authorization header carries the
 * user's JWT; RLS enforces that only rows where user_id = auth.uid() are
 * returned. Throws immediately if not authenticated so the caller can decide
 * how to handle the unauthenticated state (e.g. show zeros during first-launch
 * auth initialization).
 */
export async function fetchTodayNutrition(): Promise<{
  water_oz:  number;
  calories:  number;
  protein_g: number;
  carbs_g:   number;
  fat_g:     number;
}> {
  const token = await getAuthToken();
  if (!token) throw new Error('Not authenticated');

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const isoStart = startOfDay.toISOString();

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/nutrition_log?logged_at=gte.${isoStart}&order=logged_at.asc`,
    {
      headers: {
        apikey:          SUPABASE_ANON_KEY,
        Authorization:   `Bearer ${token}`,
        'Content-Type':  'application/json',
      },
    },
  );

  if (!res.ok) throw new Error(`Supabase error: ${res.status}`);

  const rows: NutritionLog[] = await res.json();

  return rows.reduce(
    (sum, r) => ({
      water_oz:  sum.water_oz  + (r.water_oz  ?? 0),
      calories:  sum.calories  + (r.calories  ?? 0),
      protein_g: sum.protein_g + (r.protein_g ?? 0),
      carbs_g:   sum.carbs_g   + (r.carbs_g   ?? 0),
      fat_g:     sum.fat_g     + (r.fat_g     ?? 0),
    }),
    { water_oz: 0, calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 },
  );
}

/**
 * Fetch daily nutrition totals for the past N days, grouped by date.
 * Returns a map of YYYY-MM-DD → { calories, protein_g, carbs_g, fat_g }.
 * Days with no logged meals are absent from the map.
 */
export async function fetchNutritionHistory(days: number): Promise<Map<string, {
  calories: number; protein_g: number; carbs_g: number; fat_g: number;
}>> {
  const token = await getAuthToken();
  if (!token) return new Map();

  const since = new Date();
  since.setDate(since.getDate() - days);
  since.setHours(0, 0, 0, 0);
  const isoSince = since.toISOString();

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/nutrition_log?logged_at=gte.${isoSince}&order=logged_at.asc`,
    {
      headers: {
        apikey:         SUPABASE_ANON_KEY,
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    },
  );

  if (!res.ok) return new Map();

  const rows: NutritionLog[] = await res.json();
  const map = new Map<string, { calories: number; protein_g: number; carbs_g: number; fat_g: number }>();

  for (const row of rows) {
    const date = row.logged_at.slice(0, 10);
    const existing = map.get(date) ?? { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
    map.set(date, {
      calories:  existing.calories  + (row.calories  ?? 0),
      protein_g: existing.protein_g + (row.protein_g ?? 0),
      carbs_g:   existing.carbs_g   + (row.carbs_g   ?? 0),
      fat_g:     existing.fat_g     + (row.fat_g     ?? 0),
    });
  }

  return map;
}

/**
 * Persist a Food AI meal to the server via the log-meal Edge Function.
 *
 * The Edge Function verifies the JWT and writes user_id = auth.uid()
 * server-side. user_id is never sent from this client.
 *
 * Fire-and-forget safe: callers should call `.catch(() => {})` so that a
 * network or server failure never surfaces to the user or blocks the UI.
 * The local AsyncStorage save must complete before this is called.
 *
 * Returns silently (does not throw) if no auth session is established yet —
 * handles the first-launch race condition where the meal is logged before
 * the anonymous session is ready.
 */
export async function logMeal(meal: MealPayload): Promise<void> {
  const token = await getAuthToken();
  if (!token) return; // No session yet — skip server persistence silently

  const res = await fetch(LOG_MEAL_URL, {
    method:  'POST',
    headers: {
      apikey:          SUPABASE_ANON_KEY,
      Authorization:   `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
    // user_id intentionally absent — derived server-side from the JWT
    body: JSON.stringify(meal),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`log-meal ${res.status}: ${text.slice(0, 120)}`);
  }
}
