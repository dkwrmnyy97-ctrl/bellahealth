/**
 * cloud-sync.ts
 *
 * V1 cloud persistence layer for BellaHealth.
 *
 * Sync scope (see 001_account_identity.sql):
 *   - user_profiles   ← AsyncStorage 'user_profile'
 *   - training_goals  ← AsyncStorage 'training_goals'
 *   - context_events  ← AsyncStorage 'context_events' (notes omitted — privacy)
 *   - drink_log       ← AsyncStorage 'drink_log'
 *
 * All functions are fire-and-forget-safe. They return a boolean indicating
 * success but callers may ignore it — local state is always authoritative.
 *
 * Idempotency: every write uses upsert with conflict on primary key.
 * No dirty-state flag is maintained at this layer; callers decide when to sync.
 *
 * Privacy invariant: the `notes` field on ContextEvent is NEVER uploaded.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '@/services/auth';
import type { SavedProfile } from '@/components/profile-modal';
import type { ContextEvent } from '@/services/context-events';
import type { DrinkEntry } from '@/utils/drink-entry';

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getUid(): Promise<string | null> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.user?.id ?? null;
  } catch {
    return null;
  }
}

// ─── User Profile ─────────────────────────────────────────────────────────────

/**
 * Upserts the local user profile to cloud.
 * Safe to call after every profile save; idempotent.
 */
export async function syncProfile(profile: SavedProfile): Promise<boolean> {
  const uid = await getUid();
  if (!uid) return false;

  try {
    const { error } = await supabase.from('user_profiles').upsert(
      {
        id:              uid,
        name:            profile.name    || null,
        age:             profile.age     ? parseInt(profile.age, 10)       : null,
        gender:          profile.gender  || null,
        height_display:  profile.height  || null,
        weight_lbs:      profile.weight  ? parseFloat(profile.weight)      : null,
        weight_goal_lbs: profile.weightGoal ? parseFloat(profile.weightGoal) : null,
        step_goal:       profile.stepGoal   ? parseInt(profile.stepGoal, 10)  : 10000,
        cal_goal:        profile.calGoal    ? parseInt(profile.calGoal, 10)   : 2000,
        sleep_goal:      profile.sleepGoal  ? parseFloat(profile.sleepGoal)   : 8,
        water_goal_oz:   profile.waterGoal  ? parseInt(profile.waterGoal, 10) : 80,
        supplements:     profile.supplements || null,
        companion_apps:  profile.companionApps ?? [],
        units:           profile.units ?? 'automatic',
        updated_at:      new Date().toISOString(),
      },
      { onConflict: 'id' },
    );
    if (error) {
      console.error('[cloud-sync] syncProfile:', error.message);
      await AsyncStorage.setItem('sync_pending', 'true').catch(() => {});
    }
    return !error;
  } catch (err) {
    console.error('[cloud-sync] syncProfile error:', err);
    await AsyncStorage.setItem('sync_pending', 'true').catch(() => {});
    return false;
  }
}

/**
 * Pulls the user's profile from cloud. Used when resuming a session on a new
 * device to restore data before the user has entered their profile locally.
 * Returns null if no cloud profile exists or on any error.
 */
export async function pullProfile(): Promise<SavedProfile | null> {
  const uid = await getUid();
  if (!uid) return null;

  try {
    const { data, error } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', uid)
      .single();

    if (error || !data) return null;

    return {
      name:         data.name            ?? '',
      age:          data.age             ? String(data.age)             : '',
      gender:       data.gender          ?? '',
      height:       data.height_display  ?? '',
      weight:       data.weight_lbs      ? String(data.weight_lbs)      : '',
      weightGoal:   data.weight_goal_lbs ? String(data.weight_goal_lbs) : '',
      stepGoal:     data.step_goal       ? String(data.step_goal)       : '10000',
      calGoal:      data.cal_goal        ? String(data.cal_goal)        : '2000',
      sleepGoal:    data.sleep_goal      ? String(data.sleep_goal)      : '8',
      waterGoal:    data.water_goal_oz   ? String(data.water_goal_oz)   : '80',
      supplements:  data.supplements     ?? '',
      companionApps: Array.isArray(data.companion_apps) ? data.companion_apps : [],
      units:        data.units           ?? 'automatic',
    };
  } catch (err) {
    console.error('[cloud-sync] pullProfile error:', err);
    return null;
  }
}

// ─── Training Goals ───────────────────────────────────────────────────────────

/**
 * Upserts training goals to cloud.
 * Safe to call after every training goal save.
 */
export async function syncTrainingGoals(
  goals: { body: string | null; perf: string | null },
): Promise<boolean> {
  const uid = await getUid();
  if (!uid) return false;

  try {
    const { error } = await supabase.from('training_goals').upsert(
      {
        user_id:    uid,
        body:       goals.body ?? null,
        perf:       goals.perf ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    );
    if (error) {
      console.error('[cloud-sync] syncTrainingGoals:', error.message);
      await AsyncStorage.setItem('sync_pending', 'true').catch(() => {});
    }
    return !error;
  } catch (err) {
    console.error('[cloud-sync] syncTrainingGoals error:', err);
    await AsyncStorage.setItem('sync_pending', 'true').catch(() => {});
    return false;
  }
}

// ─── Context Events ───────────────────────────────────────────────────────────

/**
 * Upserts all context events to cloud.
 *
 * Privacy invariant: the `notes` field is intentionally excluded.
 * Notes are personal free-text and remain local-only forever.
 */
export async function syncContextEvents(events: ContextEvent[]): Promise<boolean> {
  if (events.length === 0) return true;

  const uid = await getUid();
  if (!uid) return false;

  try {
    const rows = events.map((e) => ({
      id:         e.id,
      user_id:    uid,
      type:       e.type,
      source:     e.source,
      label:      e.label      ?? null,
      start_date: e.startDate,
      end_date:   e.endDate    ?? null,
      metadata:   e.metadata   ?? null,
      created_at: e.createdAt,
      updated_at: e.updatedAt,
      // e.notes intentionally omitted
    }));

    const { error } = await supabase
      .from('context_events')
      .upsert(rows, { onConflict: 'id' });

    if (error) {
      console.error('[cloud-sync] syncContextEvents:', error.message);
      await AsyncStorage.setItem('sync_pending', 'true').catch(() => {});
    }
    return !error;
  } catch (err) {
    console.error('[cloud-sync] syncContextEvents error:', err);
    await AsyncStorage.setItem('sync_pending', 'true').catch(() => {});
    return false;
  }
}

// ─── Drink Log ────────────────────────────────────────────────────────────────

/**
 * Upserts drink log entries to cloud.
 * Safe to call after every drink-log save; conflict on (user_id, date).
 */
export async function syncDrinkLog(entries: DrinkEntry[]): Promise<boolean> {
  if (entries.length === 0) return true;

  const uid = await getUid();
  if (!uid) return false;

  try {
    const rows = entries.map((e) => ({
      user_id:        uid,
      date:           e.date,
      total_drinks:   e.totalDrinks,
      total_calories: e.totalCalories,
      vibe:           e.vibe   ?? null,
      counts:         e.counts ?? null,
    }));

    const { error } = await supabase
      .from('drink_log')
      .upsert(rows, { onConflict: 'user_id,date' });

    if (error) {
      console.error('[cloud-sync] syncDrinkLog:', error.message);
      await AsyncStorage.setItem('sync_pending', 'true').catch(() => {});
    }
    return !error;
  } catch (err) {
    console.error('[cloud-sync] syncDrinkLog error:', err);
    await AsyncStorage.setItem('sync_pending', 'true').catch(() => {});
    return false;
  }
}

// ─── Durability: pending-sync retry ───────────────────────────────────────────

/**
 * Called once on app launch (after initializeAuth).
 *
 * If a previous sync failed (e.g. device was offline or network dropped), the
 * 'sync_pending' flag is set in AsyncStorage. This function reads all local
 * data and retries every sync operation.  The flag is cleared only when every
 * operation succeeds, ensuring that no write is silently lost across restarts.
 *
 * Uses idempotent upserts — safe to call multiple times; no duplicate rows.
 */
export async function retrySyncIfPending(): Promise<void> {
  try {
    const pending = await AsyncStorage.getItem('sync_pending');
    if (pending !== 'true') return;

    const [[, profileRaw], [, goalsRaw], [, eventsRaw], [, drinkRaw]] =
      await AsyncStorage.multiGet(['user_profile', 'training_goals', 'context_events', 'drink_log']);

    const profile: SavedProfile | null    = profileRaw ? JSON.parse(profileRaw) : null;
    const goals:   { body: string | null; perf: string | null } | null =
      goalsRaw ? JSON.parse(goalsRaw) : null;
    const events:  ContextEvent[] = eventsRaw ? JSON.parse(eventsRaw) : [];
    const drinks:  DrinkEntry[]   = drinkRaw  ? JSON.parse(drinkRaw)  : [];

    const results = await Promise.all([
      profile ? syncProfile(profile)          : Promise.resolve(true),
      goals   ? syncTrainingGoals(goals)      : Promise.resolve(true),
      syncContextEvents(events),
      syncDrinkLog(drinks),
    ]);

    if (results.every(Boolean)) {
      await AsyncStorage.removeItem('sync_pending');
    }
  } catch (err) {
    console.error('[cloud-sync] retrySyncIfPending error:', err);
  }
}
