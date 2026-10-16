import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';

const TOKEN_KEY = 'oura_access_token';
/** Keychain item: JSON { refreshToken, expiresAt } — see saveOuraCredentials. */
const CREDENTIALS_KEY = 'oura_refresh_credentials';
/** Non-secret AsyncStorage flag: Oura rejected our credentials; the user must reconnect. */
export const OURA_RECONNECT_KEY = 'oura_reconnect_required';
const KEYCHAIN_OPTS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};
const BASE_URL = 'https://api.ouraring.com/v2/usercollection';

// ─── OAuth constants ───────────────────────────────────────────────────────────
const OURA_REDIRECT    = 'bellahealth://oura-callback';
const OURA_CLIENT_ID   = process.env.EXPO_PUBLIC_OURA_CLIENT_ID ?? '';
// Token exchange is proxied through the Supabase Edge Function so the
// client_secret never lives in the app bundle.
const EXCHANGE_URL     = `${process.env.EXPO_PUBLIC_SUPABASE_URL ?? ''}/functions/v1/oura-token-exchange`;
const SUPABASE_ANON    = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

function base64urlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function generatePKCE() {
  const verifierBytes = await Crypto.getRandomBytesAsync(32);
  const verifier = base64urlEncode(verifierBytes);
  const challengeBytes = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256, verifier,
    { encoding: Crypto.CryptoEncoding.BASE64 }
  );
  const challenge = challengeBytes.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return { verifier, challenge };
}

/**
 * Initiates the Oura OAuth PKCE flow.
 * Returns true if a token was successfully obtained and saved.
 * Safe to call from any component — does not depend on React state.
 */
export async function initiateOuraConnect(): Promise<boolean> {
  const { verifier, challenge } = await generatePKCE();

  const authUrl =
    'https://cloud.ouraring.com/oauth/authorize?' +
    `client_id=${OURA_CLIENT_ID}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(OURA_REDIRECT)}` +
    `&scope=daily+heartrate+menstrual_cycle+personal+session+sleep+workout` +
    `&code_challenge=${challenge}` +
    `&code_challenge_method=S256`;

  const result = await WebBrowser.openAuthSessionAsync(authUrl, OURA_REDIRECT);
  if (result.type !== 'success' || !result.url) return false;

  const code = new URL(result.url).searchParams.get('code');
  if (!code) return false;

  const exRes = await fetch(EXCHANGE_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON },
    body:    JSON.stringify({ code, verifier, redirect_uri: OURA_REDIRECT }),
  });
  const data = await exRes.json();
  if (data.access_token) {
    await saveOuraCredentials(data);
    return true;
  }
  return false;
}

// ─── Token storage ────────────────────────────────────────────────────────────
//
// Access token: AsyncStorage 'oura_access_token' (unchanged key — its presence
//   is what "Connected" means across the app, and sign-out already clears it).
// Refresh token + expiry: iOS Keychain via expo-secure-store, this device only.
//   Long-lived and single-use (Oura rotates it on every refresh).
//
// Installs that connected before refresh support have an access token but no
// refresh credentials. Their refresh token was discarded by the old token
// exchange and cannot be recovered — once that access token stops working,
// only a reconnect (new authorization) restores access.

type OuraCredentials = { refreshToken: string; expiresAt: number | null };
type TokenResponse = { access_token: string; refresh_token?: string; expires_in?: number };

/** Refresh this long before the reported expiry to avoid using a token mid-expiry. */
const REFRESH_SKEW_MS = 10 * 60 * 1000;

async function readCredentials(): Promise<OuraCredentials | null> {
  try {
    const raw = await SecureStore.getItemAsync(CREDENTIALS_KEY, KEYCHAIN_OPTS);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed.refreshToken === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

// ─── Credential write ordering ────────────────────────────────────────────────
//
// authEpoch changes (synchronously) whenever credentials are replaced or
// removed by the user: connect, disconnect, sign-out. A refresh records the
// epoch when it starts and may only write if it is unchanged, so a refresh
// that was in flight during a disconnect/sign-out can never restore cleared
// credentials. All credential writes run one at a time under credentialLock,
// so "check epoch, then write" can't interleave with a removal.

let authEpoch = 0;
let credentialLock: Promise<unknown> = Promise.resolve();

function withCredentialLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = credentialLock.then(fn, fn);
  credentialLock = run.catch(() => {});
  return run;
}

async function removeKeychainCredentials(): Promise<void> {
  await SecureStore.deleteItemAsync(CREDENTIALS_KEY, KEYCHAIN_OPTS).catch(() => {});
}

/**
 * Sign-out: invalidate any in-flight refresh and remove the Keychain
 * credentials. Resolves only after any credential write already in progress
 * has finished, so the caller's AsyncStorage removal runs after it.
 */
export async function deleteCredentials(): Promise<void> {
  authEpoch++;
  refreshCooldownUntil = 0;
  await withCredentialLock(removeKeychainCredentials);
}

async function writeCredentials(res: TokenResponse): Promise<void> {
  // Refresh token before access token: a crash in between can't pair a new
  // access token with a refresh token Oura has already invalidated.
  if (res.refresh_token) {
    const creds: OuraCredentials = {
      refreshToken: res.refresh_token,
      expiresAt: typeof res.expires_in === 'number' ? Date.now() + res.expires_in * 1000 : null,
    };
    await SecureStore.setItemAsync(CREDENTIALS_KEY, JSON.stringify(creds), KEYCHAIN_OPTS);
  } else {
    await removeKeychainCredentials();
  }
  await AsyncStorage.setItem(TOKEN_KEY, res.access_token);
  await AsyncStorage.removeItem(OURA_RECONNECT_KEY);
}

/** Persist a token response from a new authorization (connect). Supersedes any in-flight refresh. */
export async function saveOuraCredentials(res: TokenResponse): Promise<void> {
  authEpoch++;
  refreshCooldownUntil = 0;
  await withCredentialLock(() => writeCredentials(res));
}

/**
 * Current Oura access token, or null when Oura isn't connected. Refreshes
 * first when the stored expiry is near; if that refresh can't complete the
 * current token is returned and the request path classifies the outcome.
 */
export async function getOuraToken(): Promise<string | null> {
  const token = await AsyncStorage.getItem(TOKEN_KEY);
  if (!token) return null;
  const creds = await readCredentials();
  if (creds?.expiresAt != null && Date.now() >= creds.expiresAt - REFRESH_SKEW_MS) {
    try { return await refreshAfter(token); } catch { return token; }
  }
  return token;
}

/** @deprecated Saves an access token without refresh credentials. Use saveOuraCredentials. */
export async function saveOuraToken(token: string): Promise<void> {
  await saveOuraCredentials({ access_token: token });
}

/** Disconnect: removes Oura credentials only — no other app data. */
export async function clearOuraToken(): Promise<void> {
  authEpoch++;
  refreshCooldownUntil = 0;
  await withCredentialLock(async () => {
    await AsyncStorage.removeItem(TOKEN_KEY);
    await AsyncStorage.removeItem(OURA_RECONNECT_KEY);
    await removeKeychainCredentials();
  });
}

export type OuraAuthStatus =
  | 'not_connected'
  /** Access token with refresh credentials. */
  | 'connected'
  /** Access token only (connected before refresh support). Works until Oura rejects it. */
  | 'legacy_no_refresh'
  /** Oura rejected the credentials and they can't be renewed — reconnect needed. */
  | 'reconnect_required';

export async function getOuraAuthStatus(): Promise<OuraAuthStatus> {
  const [token, reconnect] = await Promise.all([
    AsyncStorage.getItem(TOKEN_KEY), AsyncStorage.getItem(OURA_RECONNECT_KEY),
  ]);
  if (!token) return 'not_connected';
  if (reconnect) return 'reconnect_required';
  return (await readCredentials()) ? 'connected' : 'legacy_no_refresh';
}

// ─── Token refresh ────────────────────────────────────────────────────────────

/** Bounded retry schedule for transient refresh failures (network / 5xx). */
const REFRESH_RETRY_DELAYS_MS = [400, 1200];

const sleepMs = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** The one in-flight refresh — concurrent callers share it (refresh tokens are single-use). */
let refreshInFlight: Promise<string> | null = null;

/**
 * After a refresh fails transiently (network / 5xx, retries exhausted), further
 * refresh attempts fail fast until this time, so repeated screen loads don't
 * each re-run the full retry sequence. Reset by connect/disconnect/sign-out.
 */
const REFRESH_COOLDOWN_MS = 60 * 1000;
let refreshCooldownUntil = 0;

/**
 * Return a token that supersedes `failedToken`. If another request already
 * refreshed (the stored token differs), reuse that instead of spending the
 * new refresh token — and never refresh twice concurrently.
 */
async function refreshAfter(failedToken: string): Promise<string> {
  if (refreshInFlight) return refreshInFlight;
  const current = await AsyncStorage.getItem(TOKEN_KEY);
  if (current && current !== failedToken) return current;
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = performRefresh().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

/** Error for a refresh superseded by disconnect/sign-out/reconnect — nothing was written. */
const supersededError = () => ouraError('unauthorized', 401);

async function markReconnectRequired(epoch: number): Promise<void> {
  await withCredentialLock(async () => {
    if (epoch !== authEpoch) return; // disconnected/reconnected meanwhile
    await AsyncStorage.setItem(OURA_RECONNECT_KEY, '1').catch(() => {});
    await removeKeychainCredentials();
  });
}

async function performRefresh(): Promise<string> {
  const epoch = authEpoch;
  const creds = await readCredentials();
  if (!creds) {
    // Legacy install (or credentials already invalidated) — nothing to refresh with.
    await markReconnectRequired(epoch);
    throw ouraError('reconnect_required', 401);
  }
  if (Date.now() < refreshCooldownUntil) throw ouraError('network', null);

  for (let attempt = 0; ; attempt++) {
    let res: Response | null = null;
    try {
      res = await fetch(EXCHANGE_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON },
        body:    JSON.stringify({ grant_type: 'refresh_token', refresh_token: creds.refreshToken }),
      });
    } catch {
      res = null; // network error — retry below
    }

    if (epoch !== authEpoch) throw supersededError();

    if (res?.ok) {
      const data = await res.json().catch(() => null);
      if (!data || typeof data.access_token !== 'string') throw ouraError('http', 502);
      const saved = await withCredentialLock(async () => {
        if (epoch !== authEpoch) return false;
        await writeCredentials(data);
        return true;
      });
      if (!saved) throw supersededError();
      return data.access_token;
    }
    if (res?.status === 401) {
      // invalid_grant: refresh token revoked, expired, or already used.
      await markReconnectRequired(epoch);
      throw ouraError('reconnect_required', 401);
    }
    const transient = res === null || res.status >= 500;
    if (!transient || attempt >= REFRESH_RETRY_DELAYS_MS.length) {
      // Any non-revoked failure pauses refresh attempts briefly — never a
      // refresh on every load.
      refreshCooldownUntil = Date.now() + REFRESH_COOLDOWN_MS;
      throw ouraError(res === null ? 'network' : 'http', res?.status ?? null);
    }
    await sleepMs(REFRESH_RETRY_DELAYS_MS[attempt]);
  }
}

// ─── API helpers ──────────────────────────────────────────────────────────────

/** Local date string YYYY-MM-DD — avoids UTC/local mismatch with Oura's date keys */
function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function todayStr() {
  return localDate(new Date());
}

function yesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return localDate(d);
}

function tomorrowStr() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return localDate(d);
}

/**
 * From a per-day map of sleep sessions (longest-wins per date key), select the
 * session that represents last night's main sleep.
 *
 * Oura's `sleep` endpoint `day` field may use the sleep-session's wakeup date,
 * which can be the FOLLOWING calendar day for an overnight session (e.g. a session
 * ending at 7 AM on Day+1 gets `day = Day+1`). The query must extend to `end_date =
 * tomorrow` so those sessions are included, and we compare today vs tomorrow to
 * pick whichever is longer (overnight beats a same-evening nap).
 *
 * Falls back to yesterday if neither today nor tomorrow has a session.
 */
function pickMainSession(
  sessionsByDay: Record<string, any>,
  today: string,
  yesterday: string,
  tomorrow: string,
): any | null {
  const todayBest    = sessionsByDay[today]    ?? null;
  const tomorrowBest = sessionsByDay[tomorrow] ?? null;
  const primaryBest  =
    todayBest !== null && tomorrowBest !== null
      ? ((tomorrowBest.total_sleep_duration ?? 0) > (todayBest.total_sleep_duration ?? 0)
          ? tomorrowBest : todayBest)
      : (todayBest ?? tomorrowBest ?? null);
  return primaryBest ?? (sessionsByDay[yesterday] ?? null);
}

/**
 * Failure classes:
 *   unauthorized        — Oura returned 401 even after a successful refresh
 *   reconnect_required  — 401 and the credentials can't be renewed (legacy
 *                         install, or refresh token revoked/expired/used)
 *   http                — any other non-2xx (403 scope/membership, 429, 5xx)
 *   network             — no response
 * Errors carry only the class and HTTP status — never the token or body.
 */
export type OuraErrorKind = 'unauthorized' | 'reconnect_required' | 'http' | 'network';

function ouraError(kind: OuraErrorKind, status: number | null) {
  const err = new Error(`Oura API error: ${status ?? kind}`) as Error & { status: number | null; kind: OuraErrorKind };
  err.status = status;
  err.kind = kind;
  return err;
}

/** HTTP status from an Oura failure; null for network errors. */
export function ouraErrorStatus(e: unknown): number | null {
  const status = (e as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : null;
}

export function ouraErrorKind(e: unknown): OuraErrorKind {
  const kind = (e as { kind?: unknown } | null)?.kind;
  return kind === 'unauthorized' || kind === 'reconnect_required' || kind === 'http' ? kind : 'network';
}

/** Data request delay before the single retry of a network error / 5xx. */
const GET_RETRY_DELAY_MS = 300;

async function ouraFetch(endpoint: string, token: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}/${endpoint}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!(res.status >= 500) || attempt >= 1) return res;
    } catch {
      if (attempt >= 1) throw ouraError('network', null);
    }
    await sleepMs(GET_RETRY_DELAY_MS);
  }
}

async function ouraGet(endpoint: string, token: string) {
  let res = await ouraFetch(endpoint, token);
  if (res.status === 401) {
    // Expired or revoked access token: refresh once (shared across concurrent
    // requests), then retry once. No further loops.
    const fresh = await refreshAfter(token);
    res = await ouraFetch(endpoint, fresh);
    if (res.status === 401) throw ouraError('unauthorized', 401);
  }
  if (!res.ok) throw ouraError('http', res.status);
  return res.json();
}

// ─── Data fetching ────────────────────────────────────────────────────────────

export type OuraWorkout = {
  type: string;       // e.g. "Running", "Strength Training"
  durationMins: number;
  calories: number;
  distance?: number;  // meters
  startTime: string;
  source: string;     // e.g. "apple_health", "oura"
};

export type OuraDaily = {
  fetchDate: string;     // YYYY-MM-DD — the calendar date this fetch queried for (today)
  sleepScore: number;
  readinessScore: number;
  sleepHours: number;    // actual duration in hours
  sleepDate?: string;    // YYYY-MM-DD of the sleep session (may be yesterday)
  hrvAvg: number;        // ms
  steps: number;
  activeCalories: number;
  workout: OuraWorkout | null;
};

function formatActivityType(raw: string): string {
  return raw.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function fetchOuraDaily(token: string): Promise<OuraDaily> {
  const today     = todayStr();
  const yesterday = yesterdayStr();
  const tomorrow  = tomorrowStr();
  const [dailySleepData, readinessData, sleepSessionData, activityData, workoutData] = await Promise.all([
    ouraGet(`daily_sleep?start_date=${yesterday}&end_date=${today}`, token),
    ouraGet(`daily_readiness?start_date=${yesterday}&end_date=${today}`, token),
    // Extend sleep sessions one day forward: overnight sessions ending tomorrow morning
    // (wakeup date = tomorrow) are outside end_date=today and never returned otherwise.
    ouraGet(`sleep?start_date=${yesterday}&end_date=${tomorrow}`, token),
    ouraGet(`daily_activity?start_date=${yesterday}&end_date=${today}`, token),
    ouraGet(`workout?start_date=${yesterday}&end_date=${today}`, token),
  ]);


  // Only use today's entry — never silently fall back to yesterday's data.
  // If today's scores haven't synced yet, return 0 rather than yesterday's values.
  const dailySleep = dailySleepData.data?.find((d: any) => d.day === today) ?? null;
  const readiness  = readinessData.data?.find((d: any) => d.day === today) ?? null;
  const activity   = activityData.data?.find((d: any) => d.day === today) ?? null;

  // Merge pre-midnight onset fragments, then build a per-day best-session map.
  const sessions: any[] = mergeContiguousSleepSessions(sleepSessionData.data ?? []);
  const sessionsByDay: Record<string, any> = {};
  for (const s of sessions) {
    const day = s.day;
    if (!day) continue;
    if (!sessionsByDay[day] || (s.total_sleep_duration ?? 0) > (sessionsByDay[day].total_sleep_duration ?? 0)) {
      sessionsByDay[day] = s;
    }
  }
  // pickMainSession compares today and tomorrow (wakeup-date convention places
  // overnight sessions on tomorrow), preferring the longer one. Falls back to
  // yesterday when neither has data (Oura not yet processed).
  const mainSession = pickMainSession(sessionsByDay, today, yesterday, tomorrow);

  // Use total_sleep_duration directly — stage fields (light/deep/rem) may be zero or
  // absent while Oura is still processing overnight data, causing a systematic undercount.
  const sleepSeconds = mainSession?.total_sleep_duration ?? 0;
  const sleepHours = sleepSeconds > 0
    ? Math.round((sleepSeconds / 3600) * 10) / 10
    : 0;

  const hrvAvg = mainSession?.average_hrv
    ? Math.round(mainSession.average_hrv)
    : 0;

  // Most recent workout — Oura syncs from Apple Health/Watch automatically
  const workouts: any[] = workoutData.data ?? [];
  const latestWorkout = workouts.slice(-1)[0] ?? null;
  const workout: OuraWorkout | null = latestWorkout ? {
    type: formatActivityType(latestWorkout.activity ?? 'Workout'),
    durationMins: Math.round((latestWorkout.duration ?? 0) / 60),
    calories: Math.round(latestWorkout.calories ?? 0),
    distance: latestWorkout.distance,
    startTime: latestWorkout.start_datetime ?? '',
    source: latestWorkout.source ?? 'oura',
  } : null;

  return {
    fetchDate: today,
    sleepScore: dailySleep?.score ?? 0,
    readinessScore: readiness?.score ?? 0,
    sleepHours,
    sleepDate: mainSession?.day ?? undefined,
    hrvAvg,
    steps: activity?.steps ?? 0,
    activeCalories: activity?.active_calories ?? 0,
    workout,
  };
}

// ─── Menstrual cycle ──────────────────────────────────────────────────────────

/**
 * Returns the most recent period start date (YYYY-MM-DD) from Oura, or null
 * if the menstrual_cycle scope isn't granted or no data exists.
 */
export async function fetchOuraPeriodStart(token: string): Promise<string | null> {
  try {
    const end = todayStr();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 90);
    const start = localDate(startDate);
    const data = await ouraGet(`menstrual_cycle?start_date=${start}&end_date=${end}`, token);
    const entries: any[] = data.data ?? [];
    if (entries.length === 0) return null;
    const starts = entries.filter((e: any) => e.cycle_start === true || e.cycle_start === 'true');
    if (starts.length === 0) {
      // Fallback: most recent logged day
      const sorted = [...entries].sort((a: any, b: any) => b.day.localeCompare(a.day));
      return sorted[0]?.day ?? null;
    }
    starts.sort((a: any, b: any) => b.day.localeCompare(a.day));
    return starts[0].day as string;
  } catch {
    return null;
  }
}

// ─── Weekly data for Trends page ──────────────────────────────────────────────

export type OuraWeeklyDay = {
  date: string;           // YYYY-MM-DD
  dayLabel: string;       // Mon, Tue, etc.
  sleepScore: number;
  sleepHours: number;
  hrv: number;
  readiness: number;
  steps: number;
  activeCalories: number;
  /** ISO timestamp when the user got into bed (from Oura sleep session bedtime_start) */
  bedtimeStart?: string;
  /** ISO timestamp when the user woke up (from Oura sleep session bedtime_end) */
  bedtimeEnd?: string;
  /** Minutes in high physiological stress state (from Oura daily_stress) */
  stressHighMinutes?: number;
  /** Minutes in high restorative/recovery state (from Oura daily_stress) */
  recoveryHighMinutes?: number;
  /** Oura's daily stress summary category */
  stressDaySummary?: 'restored' | 'normal' | 'stressful' | 'demanding';
};

/**
 * Merge consecutive Oura sleep sessions that represent a single sleep period
 * split at midnight.
 *
 * Oura Ring sometimes records a pre-midnight sleep onset (e.g. 11:30 PM –
 * midnight) as a separate short session, then the main overnight block as a
 * second session starting at or near midnight. Both belong to one night.
 *
 * Merging rule: sessions sorted by start time where the gap between
 * session[i].bedtime_end and session[i+1].bedtime_start is < 5 minutes are
 * merged into one record. The 5-minute window catches genuine at-midnight splits
 * (gap ≈ 0 s) while avoiding false merges of distinct naps or sleep periods. The merged record:
 *   - uses the LATER session's `day` field (= wakeup date, correct attribution)
 *   - sums total_sleep_duration across all merged segments
 *   - keeps the later segment's average_hrv (larger sample from main sleep block)
 *
 * Genuinely separate sleep periods (naps or sessions with a gap ≥ 5 min) are not merged.
 * Overlapping sessions (gapMs < 0) are also not merged here; they are handled
 * downstream by the "longest session wins" rule in sessionsByDay, preventing double-counting.
 */
function mergeContiguousSleepSessions(sessions: any[]): any[] {
  if (sessions.length <= 1) return sessions;

  const sorted = [...sessions].sort((a, b) => {
    const ta = a.bedtime_start ? new Date(a.bedtime_start).getTime() : Infinity;
    const tb = b.bedtime_start ? new Date(b.bedtime_start).getTime() : Infinity;
    return ta - tb;
  });

  const merged: any[] = [];
  for (const s of sorted) {
    const prev = merged[merged.length - 1];
    if (prev && prev.bedtime_end && s.bedtime_start) {
      const prevEndMs  = new Date(prev.bedtime_end).getTime();
      const curStartMs = new Date(s.bedtime_start).getTime();
      const gapMs = curStartMs - prevEndMs;
      if (gapMs >= 0 && gapMs < 5 * 60 * 1000) {
        // Contiguous — merge into the running record
        prev.bedtime_end        = s.bedtime_end ?? prev.bedtime_end;
        prev.total_sleep_duration = (prev.total_sleep_duration ?? 0) + (s.total_sleep_duration ?? 0);
        // Re-attribute to the later session's day (= wakeup date of the combined period)
        if (s.day) prev.day = s.day;
        // HRV from the main (longer/later) block is more representative
        if (s.average_hrv) prev.average_hrv = s.average_hrv;
        continue;
      }
    }
    merged.push({ ...s });
  }
  return merged;
}

/**
 * Fetch today-only Oura metrics for patching the timeline when fetchOuraWeekly
 * hasn't yet received today's processed data (common before ~10am when Oura is
 * still syncing overnight data).
 *
 * Returns null rather than falling back to yesterday — callers should only use
 * this data if today's Oura data is actually available. Use alongside
 * fetchOuraWeekly, not as a replacement.
 */
export async function fetchOuraTodayPatch(token: string): Promise<OuraWeeklyDay | null> {
  const today    = todayStr();
  const tomorrow = tomorrowStr();
  const [sleepData, readinessData, sessionData, activityData] = await Promise.all([
    ouraGet(`daily_sleep?start_date=${today}&end_date=${today}`, token),
    ouraGet(`daily_readiness?start_date=${today}&end_date=${today}`, token),
    // Extend one day forward so overnight sessions with wakeup date = tomorrow are returned.
    ouraGet(`sleep?start_date=${today}&end_date=${tomorrow}`, token),
    ouraGet(`daily_activity?start_date=${today}&end_date=${today}`, token),
  ]);

  let todayStressData: any = null;
  try {
    todayStressData = await ouraGet(`daily_stress?start_date=${today}&end_date=${today}`, token);
  } catch { /* graceful degradation */ }
  const todayStress = (todayStressData?.data ?? []).find((d: any) => d.day === today);

  const sleepDay     = (sleepData.data     ?? []).find((d: any) => d.day === today);
  const readinessDay = (readinessData.data ?? []).find((d: any) => d.day === today);

  // Only return a patch if Oura has at least sleep score OR readiness for today.
  if (!sleepDay && !readinessDay) return null;

  // Merge contiguous sessions, then use the shared picker to handle the case where
  // the overnight session is attributed to tomorrow's wakeup date.
  const allSessions: any[] = mergeContiguousSleepSessions(sessionData.data ?? []);
  const patchSessionsByDay: Record<string, any> = {};
  for (const s of allSessions) {
    const day = s.day ?? s.start_datetime?.split('T')[0];
    if (!day) continue;
    if (!patchSessionsByDay[day] || (s.total_sleep_duration ?? 0) > (patchSessionsByDay[day].total_sleep_duration ?? 0)) {
      patchSessionsByDay[day] = s;
    }
  }
  // yesterdayStr() not needed here — TodayPatch only looks forward (today + tomorrow).
  const session = (patchSessionsByDay[tomorrow] !== undefined &&
    (patchSessionsByDay[tomorrow].total_sleep_duration ?? 0) > (patchSessionsByDay[today]?.total_sleep_duration ?? 0))
    ? patchSessionsByDay[tomorrow]
    : (patchSessionsByDay[today] ?? undefined);

  const activityDay = (activityData.data ?? []).find((d: any) => d.day === today);

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    date:     today,
    dayLabel: dayNames[new Date().getDay()],
    sleepScore:     sleepDay?.score ?? 0,
    sleepHours:     session?.total_sleep_duration
      ? Math.round((session.total_sleep_duration / 3600) * 10) / 10
      : 0,
    hrv:            session?.average_hrv ? Math.round(session.average_hrv) : 0,
    readiness:      readinessDay?.score ?? 0,
    steps:          activityDay?.steps ?? 0,
    activeCalories: activityDay?.active_calories ?? 0,
    bedtimeStart:        session?.bedtime_start ?? undefined,
    bedtimeEnd:          session?.bedtime_end   ?? undefined,
    stressHighMinutes:   todayStress?.stress_high    != null ? todayStress.stress_high    : undefined,
    recoveryHighMinutes: todayStress?.recovery_high  != null ? todayStress.recovery_high  : undefined,
    stressDaySummary:    todayStress?.day_summary    ?? undefined,
  };
}

export async function fetchOuraWeekly(token: string, days: number = 7): Promise<OuraWeeklyDay[]> {
  const end = todayStr();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - (days - 1));
  const start = localDate(startDate);

  // Sleep sessions extend 1 day beyond the display range so overnight sessions
  // whose wakeup date falls on tomorrow (the day after the last chart slot) are
  // available for today's chart entry. daily_sleep/readiness/activity don't need
  // extension because they use daily aggregate records that use wakeup-date keys.
  const sessionEnd = tomorrowStr();
  const endpoints = [
    `daily_sleep?start_date=${start}&end_date=${end}`,
    `daily_readiness?start_date=${start}&end_date=${end}`,
    `sleep?start_date=${start}&end_date=${sessionEnd}`,
    `daily_activity?start_date=${start}&end_date=${end}`,
  ];
  // One failing endpoint (rate limit, a declined scope) must not blank every
  // chart. Only when every request fails is this a failed fetch — thrown so
  // callers can tell it apart from a genuinely empty week.
  const settled = await Promise.allSettled(endpoints.map(e => ouraGet(e, token)));
  if (settled.every(r => r.status === 'rejected')) {
    throw (settled[0] as PromiseRejectedResult).reason;
  }
  const [sleepData, readinessData, sessionData, activityData] = settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    if (__DEV__) console.warn('[fetchOuraWeekly]', endpoints[i].split('?')[0], 'failed, status', ouraErrorStatus(r.reason));
    return { data: [] };
  });
  if (__DEV__) {
    console.log('[fetchOuraWeekly] record counts', {
      daily_sleep: sleepData.data?.length ?? 0, daily_readiness: readinessData.data?.length ?? 0,
      sleep: sessionData.data?.length ?? 0, daily_activity: activityData.data?.length ?? 0,
    });
  }

  // daily_stress is fetched separately — graceful degradation if unavailable
  let stressData: any = null;
  try {
    stressData = await ouraGet(`daily_stress?start_date=${start}&end_date=${end}`, token);
  } catch {
    // Endpoint not available or scope not granted — stress signals will be absent
  }

  // Build maps keyed by date
  const sleepMap: Record<string, any> = {};
  for (const d of sleepData.data ?? []) sleepMap[d.day] = d;

  const readinessMap: Record<string, any> = {};
  for (const d of readinessData.data ?? []) readinessMap[d.day] = d;

  const activityMap: Record<string, any> = {};
  for (const d of activityData.data ?? []) activityMap[d.day] = d;

  const stressMap: Record<string, any> = {};
  for (const d of stressData?.data ?? []) stressMap[d.day] = d;

  // Merge contiguous sessions before indexing (handles pre-midnight onset fragments)
  const normalizedSessions = mergeContiguousSleepSessions(sessionData.data ?? []);

  // HRV per day — pick longest session per date
  const sessionsByDay: Record<string, any> = {};
  for (const s of normalizedSessions) {
    const day = s.day ?? s.start_datetime?.split('T')[0];
    if (!day) continue;
    if (!sessionsByDay[day] || (s.total_sleep_duration ?? 0) > (sessionsByDay[day].total_sleep_duration ?? 0)) {
      sessionsByDay[day] = s;
    }
  }

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // Track which session keys have already been used so a single Oura session
  // (tagged with the night-start date) is never borrowed by two consecutive days.
  const claimedSessionKeys = new Set<string>();

  // Build last N days oldest → newest (use local dates to match Oura's day keys)
  const result: OuraWeeklyDay[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = localDate(d);

    const prevDate = new Date(d);
    prevDate.setDate(prevDate.getDate() - 1);
    const prevDateStr = localDate(prevDate);

    // For today only (i=0): also check the next calendar day. An overnight session
    // ending this morning may be tagged by Oura with tomorrow's date (wakeup date).
    const nextDate = new Date(d);
    nextDate.setDate(nextDate.getDate() + 1);
    const nextDateStr = localDate(nextDate);

    const todayEntry = sessionsByDay[dateStr] ?? null;
    const nextEntry  = (i === 0 && sessionsByDay[nextDateStr] && !claimedSessionKeys.has(nextDateStr))
      ? sessionsByDay[nextDateStr] : null;
    const prevEntry  = (sessionsByDay[prevDateStr] && !claimedSessionKeys.has(prevDateStr))
      ? sessionsByDay[prevDateStr] : null;

    let sessionKey: string | null = null;
    if (todayEntry !== null && nextEntry !== null) {
      // Both today and next-day sessions present — pick the longer (overnight beats a nap)
      sessionKey = (nextEntry.total_sleep_duration ?? 0) > (todayEntry.total_sleep_duration ?? 0)
        ? nextDateStr : dateStr;
    } else if (todayEntry !== null) {
      sessionKey = dateStr;
    } else if (nextEntry !== null) {
      sessionKey = nextDateStr;
    } else if (prevEntry !== null) {
      sessionKey = prevDateStr;
    }
    if (sessionKey) claimedSessionKeys.add(sessionKey);
    const session = sessionKey ? sessionsByDay[sessionKey] : undefined;

    result.push({
      date: dateStr,
      dayLabel: dayNames[d.getDay()],
      sleepScore: sleepMap[dateStr]?.score ?? 0,
      sleepHours: session?.total_sleep_duration
        ? Math.round((session.total_sleep_duration / 3600) * 10) / 10
        : 0,
      hrv: session?.average_hrv ? Math.round(session.average_hrv) : 0,
      readiness: readinessMap[dateStr]?.score ?? 0,
      steps: activityMap[dateStr]?.steps ?? 0,
      activeCalories: activityMap[dateStr]?.active_calories ?? 0,
      // Preserve bedtime timestamps that already exist in the Oura session payload.
      // These are ISO strings (e.g. "2026-09-30T22:45:00+00:00"). No parsing here —
      // callers that need the local hour can parse them. Story logic deferred to V2.
      bedtimeStart:        session?.bedtime_start ?? undefined,
      bedtimeEnd:          session?.bedtime_end   ?? undefined,
      // Oura daily_stress fields — undefined when endpoint unavailable or no data for this day
      stressHighMinutes:   stressMap[dateStr]?.stress_high    != null ? stressMap[dateStr].stress_high    : undefined,
      recoveryHighMinutes: stressMap[dateStr]?.recovery_high  != null ? stressMap[dateStr].recovery_high  : undefined,
      stressDaySummary:    stressMap[dateStr]?.day_summary    ?? undefined,
    });
  }

  return result;
}

// ─── Trends loader ────────────────────────────────────────────────────────────

export type OuraTrendsResult =
  | { ok: true; days: OuraWeeklyDay[] }
  /** status: HTTP status, or null for network errors. */
  | { ok: false; status: number | null; kind: OuraErrorKind };

/**
 * Weekly Oura data for the Trends screen. A failed fetch is reported as
 * { ok: false } rather than an all-zero week, so callers keep whatever valid
 * data they already show. Days with no Oura record stay 0 — the "no data"
 * value that charts render as an empty slot and averages skip.
 *
 * todaySteps: optional real-time step source (HealthKit) for today's slot,
 * since Oura daily_activity lags during the day.
 */
export async function loadOuraTrends(
  token: string,
  days: number,
  todaySteps?: () => Promise<number>,
): Promise<OuraTrendsResult> {
  let fetched: OuraWeeklyDay[];
  try {
    fetched = await fetchOuraWeekly(token, days);
  } catch (e) {
    return { ok: false, status: ouraErrorStatus(e), kind: ouraErrorKind(e) };
  }
  if (fetched.length > 0) {
    const todayEntry = fetched[fetched.length - 1];
    const prevEntry  = fetched[fetched.length - 2];
    const hkSteps = todaySteps ? await todaySteps().catch(() => 0) : 0;
    if (hkSteps > todayEntry.steps) todayEntry.steps = hkSteps;
    if (todayEntry.hrv === 0 && prevEntry?.hrv > 0) todayEntry.hrv = prevEntry.hrv;
  }
  return { ok: true, days: fetched };
}
