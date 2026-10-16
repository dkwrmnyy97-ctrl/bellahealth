// BellaHealth — Anonymous Supabase Auth
//
// Creates and recovers a persistent anonymous Supabase session on every app
// launch. The resulting JWT is used to authenticate:
//   - nutrition_log reads (supabase.ts)
//   - Claude proxy calls (claude-proxy.ts)
//   - Account deletion (delete-account Edge Function)
//
// Users see no login UI — BellaHealth remains accountless from their
// perspective. The anonymous session is transparent to the product.
//
// Session storage: @react-native-async-storage/async-storage
// (supabase-js manages the storage key automatically under the 'sb-' prefix).

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { deleteCredentials as deleteOuraCredentials } from '@/services/oura';

const SUPABASE_URL      = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

const DELETE_ACCOUNT_URL =
  `${process.env.EXPO_PUBLIC_SUPABASE_URL ?? ''}/functions/v1/delete-account`;

// Single shared Supabase client for the entire app.
// autoRefreshToken handles silent JWT renewal before expiry.
// persistSession stores the session in AsyncStorage so it survives restarts.
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage:            AsyncStorage,
    autoRefreshToken:   true,
    persistSession:     true,
    detectSessionInUrl: false,
  },
});

/**
 * Initialize (or recover) the anonymous session. Called once on app launch.
 *
 * - On subsequent launches the stored session is restored from AsyncStorage
 *   immediately without a network call.
 * - On first launch, signInAnonymously() creates a real auth.users row with
 *   a cryptographically signed JWT. The resulting auth.uid() is the stable
 *   identity used for RLS on nutrition_log.
 *
 * This is fire-and-forget-safe: failures are logged but never surface to
 * the user. The app works offline; auth just won't be available until the
 * device is online for the first time.
 */
export async function initializeAuth(): Promise<void> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      const { error } = await supabase.auth.signInAnonymously();
      if (error) {
        console.error('[auth] signInAnonymously failed:', error.message);
      }
    }
  } catch (err) {
    console.error('[auth] initializeAuth error:', err);
  }
}

/**
 * Returns the current session's JWT access token, or null if no session
 * has been established yet. Callers that require authentication should
 * treat null as an error.
 */
export async function getAuthToken(): Promise<string | null> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token ?? null;
  } catch {
    return null;
  }
}

/**
 * Returns the anonymous user's auth.uid() UUID.
 *
 * Exposed only for the Nutrition Sync setup UI so the user can paste it
 * into a Zapier Zap. Not shown in the primary product experience.
 */
export async function getAuthUserId(): Promise<string | null> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.user?.id ?? null;
  } catch {
    return null;
  }
}

// ─── Sign-out key classification ──────────────────────────────────────────────
//
// A. Account-personal — belong to the authenticated user; cleared on sign-out.
// B. Wearable credential — OAuth token for THIS user's wearable; cleared.
// C. Device-level non-personal — analytics device identity; PRESERVED.
// D. Personal health log / session data — cleared on sign-out.
//
// AsyncStorage.clear() is intentionally NOT used: it would wipe analytics
// device-identity markers that are not personal and must survive account
// changes on a shared device.

const SIGN_OUT_KEYS: readonly string[] = [
  // A — account-personal
  'user_profile',
  'training_goals',
  'context_events',
  'drink_log',
  'gratitude_entries',
  'cycle_journal',
  'cycle_profile',
  'is_male',
  'user_theme',
  'onboarding_complete',
  'context_walkthrough_v1',
  'context_walkthrough_seen',   // legacy key; included for safety
  // B — wearable credential
  'oura_access_token',
  'oura_reconnect_required',
  // D — personal health logs / session data
  'caffeine_log',
  'caffeine_history',
  'electrolytes_log',
  'electrolytes_history',
  'manual_water',
  'meal_log',
  'water_history',
  'wellness_log',
  'wellness_sessions_history',
  'wellness_classes_history',
  'vacation_mode',
  'theme_mode',
  // story persistence
  'story_last_v1',
  // pending sync flag
  'sync_pending',
  // Apple prompt dismissal state — cleared on sign-out so a new account gets a fresh start
  'apple_prompt_dismissed_count',
  'apple_prompt_dismissed_at',
];

// Keys that are intentionally preserved on sign-out (device-level, non-personal):
//   'analytics_first_open_sent'
//   'analytics_hk_connected_sent'
//   'analytics_oura_catchup_sent'
//   'open_chat_flag'

/**
 * Signs out the current user, clears all personal data from the device, and
 * re-initializes an anonymous Supabase session.
 *
 * Deliberately removes every account-personal key so a previous user's data
 * cannot remain visible to another person picking up the device.
 * Device-level non-personal analytics markers are preserved.
 *
 * Does NOT call AsyncStorage.clear() — that would wipe analytics device identity.
 */
export async function signOut(): Promise<void> {
  try {
    await supabase.auth.signOut();
  } catch (err) {
    console.error('[auth] signOut error:', err);
  }

  // Oura refresh credentials live in the Keychain, outside AsyncStorage.
  // First: invalidates any in-flight Oura refresh and waits out a write in
  // progress, so it can't re-save tokens after the removal below.
  await deleteOuraCredentials();

  try {
    await AsyncStorage.multiRemove([...SIGN_OUT_KEYS]);
  } catch (err) {
    console.error('[auth] signOut key-removal error:', err);
  }

  // Re-initialize anonymous session so RLS-gated features keep working.
  await initializeAuth();
}

// Export for tests only — do not call from product code.
export { SIGN_OUT_KEYS };

/**
 * Permanently deletes the user's BellaHealth server-side data:
 *   1. Calls the delete-account Edge Function (authenticated via JWT).
 *      That function deletes all nutrition_log rows and the auth.users entry.
 *   2. Signs out the local Supabase session.
 *
 * Returns true on success. Returns false if the server call fails — the
 * caller must still proceed with local data deletion regardless.
 *
 * Note: analytics_events rows use an anonymous device_id and contain no
 * personal or health data; they are not deleted by this action.
 */
export async function deleteAccount(): Promise<boolean> {
  try {
    const token = await getAuthToken();
    if (!token) return false;

    const res = await fetch(DELETE_ACCOUNT_URL, {
      method:  'POST',
      headers: {
        apikey:          SUPABASE_ANON_KEY,
        Authorization:   `Bearer ${token}`,
        'Content-Type':  'application/json',
      },
    });

    if (!res.ok) {
      console.error('[auth] delete-account responded', res.status);
      return false;
    }

    await supabase.auth.signOut();
    return true;
  } catch (err) {
    console.error('[auth] deleteAccount error:', err);
    return false;
  }
}
