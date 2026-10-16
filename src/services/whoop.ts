import AsyncStorage from '@react-native-async-storage/async-storage';

const TOKEN_KEY   = 'whoop_access_token';
const REFRESH_KEY = 'whoop_refresh_token';
const BASE_URL    = 'https://api.prod.whoop.com/developer/v1';

// NOTE: WHOOP OAuth PKCE does not require a client_secret from native apps.
// These env vars intentionally omit the EXPO_PUBLIC_ prefix so they are
// never bundled into the app binary. Set them only if routing token exchange
// through a server-side Edge Function in the future.
const CLIENT_ID     = process.env.WHOOP_CLIENT_ID     ?? '';
const CLIENT_SECRET = process.env.WHOOP_CLIENT_SECRET ?? '';

// ─── Token storage ────────────────────────────────────────────────────────────

export async function getWhoopToken(): Promise<string | null> {
  return AsyncStorage.getItem(TOKEN_KEY);
}

export async function saveWhoopTokens(accessToken: string, refreshToken?: string): Promise<void> {
  await AsyncStorage.setItem(TOKEN_KEY, accessToken);
  if (refreshToken) await AsyncStorage.setItem(REFRESH_KEY, refreshToken);
}

export async function clearWhoopTokens(): Promise<void> {
  await AsyncStorage.multiRemove([TOKEN_KEY, REFRESH_KEY]);
}

// ─── API helpers ──────────────────────────────────────────────────────────────

async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = await AsyncStorage.getItem(REFRESH_KEY);
  if (!refreshToken) return null;
  try {
    const res = await fetch('https://api.prod.whoop.com/oauth/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'refresh_token',
        refresh_token: refreshToken,
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
        scope:         'offline read:recovery read:sleep read:workout read:cycles',
      }).toString(),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.access_token) {
      await saveWhoopTokens(data.access_token, data.refresh_token ?? refreshToken);
      return data.access_token;
    }
  } catch {}
  return null;
}

async function whoopGet(endpoint: string, token: string): Promise<any> {
  let res = await fetch(`${BASE_URL}/${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 401) {
    const newToken = await refreshAccessToken();
    if (!newToken) throw new Error('Whoop token expired — please reconnect');
    res = await fetch(`${BASE_URL}/${endpoint}`, {
      headers: { Authorization: `Bearer ${newToken}` },
    });
  }

  if (!res.ok) throw new Error(`Whoop API error: ${res.status}`);
  return res.json();
}

// ─── Daily data ───────────────────────────────────────────────────────────────

export type WhoopDaily = {
  recoveryScore: number;   // 0–100 (maps to "readiness" on home screen)
  sleepScore:    number;   // sleep_performance_percentage 0–100
  sleepHours:    number;
  hrv:           number;   // hrv_rmssd_milli, rounded to ms
  restingHR:     number;
  strain:        number;   // daily strain (Whoop-specific)
};

export async function fetchWhoopDaily(token: string): Promise<WhoopDaily> {
  // Fetch most recent cycle and sleep in parallel
  const [cycleData, sleepData] = await Promise.all([
    whoopGet('cycle?limit=1', token),
    whoopGet('sleep?limit=1', token),
  ]);

  const cycle = cycleData.records?.[0] ?? null;

  // Recovery is per-cycle; fetch if we have a cycle id
  let recovery: any = null;
  if (cycle?.id) {
    try { recovery = await whoopGet(`recovery/${cycle.id}`, token); } catch {}
  }

  // Sleep: exclude naps, take most recent main sleep
  const sleepRecords: any[] = sleepData.records ?? [];
  const mainSleep = sleepRecords.find((s: any) => !s.is_nap) ?? sleepRecords[0] ?? null;
  const stageSummary = mainSleep?.score?.stage_summary;
  const sleepMs = stageSummary
    ? (stageSummary.total_light_sleep_time_milli   ?? 0) +
      (stageSummary.total_slow_wave_sleep_time_milli ?? 0) +
      (stageSummary.total_rem_sleep_time_milli       ?? 0)
    : 0;

  return {
    recoveryScore: recovery?.score?.recovery_score                    ?? 0,
    sleepScore:    mainSleep?.score?.sleep_performance_percentage     ?? 0,
    sleepHours:    sleepMs > 0 ? Math.round((sleepMs / 3_600_000) * 10) / 10 : 0,
    hrv:           recovery?.score?.hrv_rmssd_milli
                     ? Math.round(recovery.score.hrv_rmssd_milli) : 0,
    restingHR:     recovery?.score?.resting_heart_rate                ?? 0,
    strain:        cycle?.score?.strain
                     ? Math.round(cycle.score.strain * 10) / 10 : 0,
  };
}

// ─── Weekly data for Trends page ──────────────────────────────────────────────

export type WhoopWeeklyDay = {
  date:          string;
  dayLabel:      string;
  recoveryScore: number;
  sleepScore:    number;
  sleepHours:    number;
  hrv:           number;
  strain:        number;
};

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function fetchWhoopWeekly(token: string, days: number = 7): Promise<WhoopWeeklyDay[]> {
  const end   = new Date();
  const start = new Date();
  start.setDate(start.getDate() - (days - 1));
  start.setHours(0, 0, 0, 0);

  const startISO = start.toISOString();
  const endISO   = end.toISOString();

  const [cycleData, sleepData] = await Promise.all([
    whoopGet(`cycle?start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(endISO)}&limit=${days + 3}`, token),
    whoopGet(`sleep?start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(endISO)}&limit=${days + 3}`, token),
  ]);

  const cycles: any[]       = cycleData.records ?? [];
  const sleepRecords: any[] = sleepData.records ?? [];

  // Fetch recoveries for all cycles in parallel
  const recoveries: (any | null)[] = await Promise.all(
    cycles.map(async (c: any) => {
      try { return await whoopGet(`recovery/${c.id}`, token); } catch { return null; }
    })
  );

  // Build maps keyed by YYYY-MM-DD (use start date of cycle/sleep)
  const cycleByDate:    Record<string, any> = {};
  const recoveryByDate: Record<string, any> = {};
  const sleepByDate:    Record<string, any> = {};

  for (let i = 0; i < cycles.length; i++) {
    const dateStr = cycles[i].start?.split('T')[0];
    if (dateStr) {
      cycleByDate[dateStr]    = cycles[i];
      if (recoveries[i]) recoveryByDate[dateStr] = recoveries[i];
    }
  }
  for (const s of sleepRecords) {
    if (!s.is_nap) {
      const dateStr = s.start?.split('T')[0];
      if (dateStr && !sleepByDate[dateStr]) sleepByDate[dateStr] = s;
    }
  }

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const result: WhoopWeeklyDay[] = [];

  for (let i = days - 1; i >= 0; i--) {
    const d       = new Date();
    d.setDate(d.getDate() - i);
    const dateStr   = localDate(d);
    const recovery  = recoveryByDate[dateStr];
    const sleep     = sleepByDate[dateStr];
    const cycle     = cycleByDate[dateStr];

    const stageSummary = sleep?.score?.stage_summary;
    const sleepMs = stageSummary
      ? (stageSummary.total_light_sleep_time_milli     ?? 0) +
        (stageSummary.total_slow_wave_sleep_time_milli ?? 0) +
        (stageSummary.total_rem_sleep_time_milli       ?? 0)
      : 0;

    result.push({
      date:          dateStr,
      dayLabel:      dayNames[d.getDay()],
      recoveryScore: recovery?.score?.recovery_score                ?? 0,
      sleepScore:    sleep?.score?.sleep_performance_percentage     ?? 0,
      sleepHours:    sleepMs > 0 ? Math.round((sleepMs / 3_600_000) * 10) / 10 : 0,
      hrv:           recovery?.score?.hrv_rmssd_milli
                       ? Math.round(recovery.score.hrv_rmssd_milli) : 0,
      strain:        cycle?.score?.strain
                       ? Math.round(cycle.score.strain * 10) / 10 : 0,
    });
  }

  return result;
}
