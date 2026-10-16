import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  requestAuthorization,
  queryStatisticsForQuantity,
  queryCategorySamples,
  getMostRecentQuantitySample,
  queryWorkoutSamples,
  getBiologicalSexAsync,
  getDateOfBirthAsync,
  BiologicalSex,
  WorkoutActivityType,
} from '@kingstinct/react-native-healthkit';
import { trackEvent } from '@/services/analytics';

// ─── Permissions ──────────────────────────────────────────────────────────────

const READ_TYPES = [
  // Quantity types
  'HKQuantityTypeIdentifierStepCount',
  'HKQuantityTypeIdentifierHeartRateVariabilitySDNN',
  'HKQuantityTypeIdentifierRestingHeartRate',
  'HKQuantityTypeIdentifierActiveEnergyBurned',
  'HKQuantityTypeIdentifierHeight',
  'HKQuantityTypeIdentifierBodyMass',
  'HKQuantityTypeIdentifierDietaryWater',
  // Category types
  'HKCategoryTypeIdentifierSleepAnalysis',
  // Workouts
  'HKWorkoutTypeIdentifier',
  // Characteristics
  'HKCharacteristicTypeIdentifierBiologicalSex',
  'HKCharacteristicTypeIdentifierDateOfBirth',
] as const;

// ─── Init ─────────────────────────────────────────────────────────────────────

export async function initHealthKit(): Promise<void> {
  await requestAuthorization({ toRead: READ_TYPES, toShare: [] });
  // Track that the user engaged with the HealthKit authorization prompt.
  // Fires at most once per install regardless of how many times initHealthKit() is called.
  try {
    const already = await AsyncStorage.getItem('analytics_hk_connected_sent');
    if (!already) {
      await AsyncStorage.setItem('analytics_hk_connected_sent', '1');
      trackEvent('apple_health_connected');
    }
  } catch {}
}

// ─── Steps ────────────────────────────────────────────────────────────────────

export async function getTodaySteps(): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const result = await queryStatisticsForQuantity(
    'HKQuantityTypeIdentifierStepCount',
    ['cumulativeSum'],
    { filter: { date: { startDate: startOfDay, endDate: new Date() } } }
  );
  return Math.round(result.sumQuantity?.quantity ?? 0);
}

/** Returns step totals keyed by local YYYY-MM-DD for the past windowDays days. */
export async function getDailySteps(windowDays = 7): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (let i = 0; i < windowDays; i++) {
    const start = new Date();
    start.setDate(start.getDate() - i);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setHours(23, 59, 59, 999);
    const dateKey = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
    try {
      const data = await queryStatisticsForQuantity(
        'HKQuantityTypeIdentifierStepCount',
        ['cumulativeSum'],
        { filter: { date: { startDate: start, endDate: end } } },
      );
      result[dateKey] = Math.round(data.sumQuantity?.quantity ?? 0);
    } catch {
      result[dateKey] = 0;
    }
  }
  return result;
}

/** Returns daily HRV (ms) keyed by local YYYY-MM-DD for the past windowDays days.
 *  Populated by any device that writes HKQuantityTypeIdentifierHeartRateVariabilitySDNN
 *  to Apple Health — Oura, Garmin, WHOOP, Apple Watch, etc.
 */
export async function getDailyHRV(windowDays = 7): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (let i = 0; i < windowDays; i++) {
    const start = new Date();
    start.setDate(start.getDate() - i);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setHours(23, 59, 59, 999);
    const dateKey = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
    try {
      const data = await queryStatisticsForQuantity(
        'HKQuantityTypeIdentifierHeartRateVariabilitySDNN',
        ['discreteAverage'],
        { filter: { date: { startDate: start, endDate: end } } },
      );
      const val = Math.round(data.averageQuantity?.quantity ?? 0);
      if (val > 0) result[dateKey] = val;
    } catch {
      // no data for this day — omit from result
    }
  }
  return result;
}

// ─── HRV ──────────────────────────────────────────────────────────────────────

export async function getLatestHRV(): Promise<number> {
  const sample = await getMostRecentQuantitySample('HKQuantityTypeIdentifierHeartRateVariabilitySDNN');
  return sample ? Math.round(sample.quantity) : 0;
}

// ─── Sleep ────────────────────────────────────────────────────────────────────

export type SleepSample = {
  value: number; // 0=inBed, 1=asleepUnspecified, 2=awake, 3=core, 4=deep, 5=rem
  startDate: Date;
  endDate: Date;
};

export async function getLastNightSleep(): Promise<SleepSample[]> {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 1);
  start.setHours(18, 0, 0, 0);

  const samples = await queryCategorySamples('HKCategoryTypeIdentifierSleepAnalysis', {
    limit: 200,
    ascending: true,
    filter: { date: { startDate: start, endDate: end } },
  });

  return samples.map((s) => ({
    value: s.value as number,
    startDate: s.startDate,
    endDate: s.endDate,
  }));
}

export function getSleepHours(samples: SleepSample[]): number {
  // Multiple sources (Oura app + Apple Watch) can write overlapping stage samples
  // to HealthKit for the same period — merge intervals to avoid double-counting.
  const stages = samples.filter((s) => s.value === 3 || s.value === 4 || s.value === 5);
  const toSum = stages.length > 0 ? stages : samples.filter((s) => s.value === 1);
  if (toSum.length === 0) return 0;

  const sorted = [...toSum].sort((a, b) => a.startDate.getTime() - b.startDate.getTime());
  let totalMs = 0;
  let mergeStart = sorted[0].startDate.getTime();
  let mergeEnd = sorted[0].endDate.getTime();
  for (let i = 1; i < sorted.length; i++) {
    const s = sorted[i].startDate.getTime();
    const e = sorted[i].endDate.getTime();
    if (s <= mergeEnd) {
      mergeEnd = Math.max(mergeEnd, e);
    } else {
      totalMs += mergeEnd - mergeStart;
      mergeStart = s;
      mergeEnd = e;
    }
  }
  totalMs += mergeEnd - mergeStart;
  return Math.round((totalMs / 3600000) * 10) / 10;
}

/** Total time in bed (inBed=0 samples), in hours. Useful for non-Oura users. */
export function getSleepInBedHours(samples: SleepSample[]): number {
  const inBedMs = samples
    .filter((s) => s.value === 0)
    .reduce((sum, s) => sum + (s.endDate.getTime() - s.startDate.getTime()), 0);
  // Fall back: if no explicit inBed samples, use total asleep time as a proxy
  if (inBedMs === 0) return getSleepHours(samples);
  return Math.round((inBedMs / (1000 * 60 * 60)) * 10) / 10;
}

/**
 * Query HealthKit sleep samples over a rolling window and group by wakeup date.
 *
 * Wakeup date assignment:
 *   Samples whose endDate hour is >= 4 (normal wake: 4 AM – 2 PM) are assigned
 *   to the calendar date of endDate. Samples ending before 4 AM are treated as
 *   still part of the prior night and assigned to endDate + 1 day.
 *   This matches Oura's convention: the wakeup date is the date you got up.
 *
 * Returns: Record<YYYY-MM-DD, sleepHours> — wakeup date → total asleep hours.
 * Uses the same merge-intervals deduplication as getSleepHours().
 * Days with no sleep samples are absent from the result (not set to 0).
 */
export async function getHistoricalSleepHours(windowDays = 30): Promise<Record<string, number>> {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - windowDays);
  start.setHours(18, 0, 0, 0); // include the evening before the window start

  const samples = await queryCategorySamples('HKCategoryTypeIdentifierSleepAnalysis', {
    limit: windowDays * 60, // up to 60 sleep stage segments per night
    ascending: true,
    filter: { date: { startDate: start, endDate: end } },
  });

  const typed: SleepSample[] = samples.map((s) => ({
    value:     s.value as number,
    startDate: s.startDate,
    endDate:   s.endDate,
  }));

  // Group samples by wakeup date
  const byNight = new Map<string, SleepSample[]>();
  for (const s of typed) {
    const wakeupDate = assignWakeupDate(s.endDate);
    const group = byNight.get(wakeupDate) ?? [];
    group.push(s);
    byNight.set(wakeupDate, group);
  }

  const result: Record<string, number> = {};
  for (const [date, group] of byNight) {
    const hours = getSleepHours(group);
    if (hours > 0) result[date] = hours;
  }
  return result;
}

/** Assign the wakeup (reporting) date for a sleep sample based on its endDate. */
function assignWakeupDate(endDate: Date): string {
  const d = new Date(endDate);
  // If sleep ended before 4 AM, treat it as still the prior night → next calendar date
  if (d.getHours() < 4) {
    d.setDate(d.getDate() + 1);
  }
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function getRestingHeartRate(): Promise<number> {
  const sample = await getMostRecentQuantitySample('HKQuantityTypeIdentifierRestingHeartRate');
  return sample ? Math.round(sample.quantity) : 0;
}

// ─── Workouts ─────────────────────────────────────────────────────────────────

export type WorkoutSample = {
  activityName: string;
  calories: number;
  duration: number; // minutes
  startDate: Date;
  endDate: Date;
  distance?: number;
};

function formatActivityType(type: WorkoutActivityType): string {
  const name = WorkoutActivityType[type] ?? 'workout';
  // camelCase → Title Case with spaces
  return name
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

export async function getTodayWorkouts(): Promise<WorkoutSample[]> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const workouts = await queryWorkoutSamples({
    limit: 20,
    ascending: false,
    filter: { date: { startDate: startOfDay, endDate: new Date() } },
  });
  return workouts.map((w) => ({
    activityName: formatActivityType(w.workoutActivityType),
    calories: Math.round(w.totalEnergyBurned?.quantity ?? 0),
    duration: Math.round(w.duration.quantity / 60),
    startDate: w.startDate,
    endDate: w.endDate,
    distance: w.totalDistance?.quantity,
  }));
}

export async function getWorkoutCountsForPeriods(): Promise<{ week: number; month: number }> {
  const now = new Date();

  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay()); // Sunday
  startOfWeek.setHours(0, 0, 0, 0);

  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  startOfMonth.setHours(0, 0, 0, 0);

  const [weekWorkouts, monthWorkouts] = await Promise.all([
    queryWorkoutSamples({ limit: 100, ascending: false, filter: { date: { startDate: startOfWeek, endDate: now } } }),
    queryWorkoutSamples({ limit: 100, ascending: false, filter: { date: { startDate: startOfMonth, endDate: now } } }),
  ]);

  return { week: weekWorkouts.length, month: monthWorkouts.length };
}

export async function getRecentWorkouts(windowDays = 30): Promise<WorkoutSample[]> {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - windowDays);
  start.setHours(0, 0, 0, 0);
  const workouts = await queryWorkoutSamples({
    limit: windowDays * 3, // up to 3 workouts/day in the window
    ascending: false,
    filter: { date: { startDate: start, endDate: end } },
  });
  return workouts.map((w) => ({
    activityName: formatActivityType(w.workoutActivityType),
    calories: Math.round(w.totalEnergyBurned?.quantity ?? 0),
    duration: Math.round(w.duration.quantity / 60),
    startDate: w.startDate,
    endDate: w.endDate,
    distance: w.totalDistance?.quantity,
  }));
}

// ─── Water ────────────────────────────────────────────────────────────────────

export async function getTodayWater(): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const result = await queryStatisticsForQuantity(
    'HKQuantityTypeIdentifierDietaryWater',
    ['cumulativeSum'],
    { filter: { date: { startDate: startOfDay, endDate: new Date() } } }
  );
  // Library returns fl oz on US locale devices — no conversion needed
  return Math.round(result.sumQuantity?.quantity ?? 0);
}

// ─── Per-date queries (for historical Home browsing) ──────────────────────────

/** Parses a local YYYY-MM-DD string into a Date at midnight local time. */
function parseDateStr(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

/** Steps on a specific calendar date (local). */
export async function getStepsForDate(dateStr: string): Promise<number> {
  const start = parseDateStr(dateStr);
  const end = new Date(start);
  end.setHours(23, 59, 59, 999);
  const data = await queryStatisticsForQuantity(
    'HKQuantityTypeIdentifierStepCount',
    ['cumulativeSum'],
    { filter: { date: { startDate: start, endDate: end } } },
  );
  return Math.round(data.sumQuantity?.quantity ?? 0);
}

/** Workouts on a specific calendar date (local). */
export async function getWorkoutsForDate(dateStr: string): Promise<WorkoutSample[]> {
  const start = parseDateStr(dateStr);
  const end = new Date(start);
  end.setHours(23, 59, 59, 999);
  const workouts = await queryWorkoutSamples({
    limit: 20,
    ascending: false,
    filter: { date: { startDate: start, endDate: end } },
  });
  return workouts.map((w) => ({
    activityName: formatActivityType(w.workoutActivityType),
    calories: Math.round(w.totalEnergyBurned?.quantity ?? 0),
    duration: Math.round(w.duration.quantity / 60),
    startDate: w.startDate,
    endDate: w.endDate,
    distance: w.totalDistance?.quantity,
  }));
}

/** Sleep hours whose wakeup date matches the given local YYYY-MM-DD. */
export async function getSleepHoursForDate(dateStr: string): Promise<number> {
  const wakeDay = parseDateStr(dateStr);
  // Window: previous evening (18:00) to midday of wakeup day (14:00)
  const start = new Date(wakeDay);
  start.setDate(start.getDate() - 1);
  start.setHours(18, 0, 0, 0);
  const end = new Date(wakeDay);
  end.setHours(14, 0, 0, 0);

  const raw = await queryCategorySamples('HKCategoryTypeIdentifierSleepAnalysis', {
    limit: 120,
    ascending: true,
    filter: { date: { startDate: start, endDate: end } },
  });
  const samples: SleepSample[] = raw.map((s) => ({
    value: s.value as number,
    startDate: s.startDate,
    endDate: s.endDate,
  }));
  return getSleepHours(samples);
}

/** Water oz recorded by HealthKit on a specific calendar date (local). */
export async function getWaterForDate(dateStr: string): Promise<number> {
  const start = parseDateStr(dateStr);
  const end = new Date(start);
  end.setHours(23, 59, 59, 999);
  const data = await queryStatisticsForQuantity(
    'HKQuantityTypeIdentifierDietaryWater',
    ['cumulativeSum'],
    { filter: { date: { startDate: start, endDate: end } } },
  );
  return Math.round(data.sumQuantity?.quantity ?? 0);
}

// ─── Profile ──────────────────────────────────────────────────────────────────

export type HKProfile = {
  age: number;
  sex: string; // 'female' | 'male' | 'other' | 'notSet'
  heightInches: number;
  weightLbs: number;
};

export async function getHealthKitProfile(): Promise<Partial<HKProfile>> {
  const profile: Partial<HKProfile> = {};

  await Promise.allSettled([
    getDateOfBirthAsync().then((dob) => {
      if (dob) {
        profile.age = Math.floor((Date.now() - dob.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
      }
    }),
    getBiologicalSexAsync().then((sex) => {
      if (sex !== BiologicalSex.notSet) {
        profile.sex = BiologicalSex[sex];
      }
    }),
    getMostRecentQuantitySample('HKQuantityTypeIdentifierHeight', 'm').then((sample) => {
      if (sample) {
        profile.heightInches = Math.round(sample.quantity * 39.3701);
      }
    }),
    getMostRecentQuantitySample('HKQuantityTypeIdentifierBodyMass', 'kg').then((sample) => {
      if (sample) {
        profile.weightLbs = Math.round(sample.quantity * 2.20462);
      }
    }),
  ]);

  return profile;
}

/** Weight-based hydration goal: weight(lbs) ÷ 2 = oz, clamped 60–120 oz */
export function calcWaterGoalOz(weightLbs: number): number {
  const oz = Math.round(weightLbs / 2);
  return Math.max(60, Math.min(120, oz));
}

export type TrainingGoalResult = {
  calGoal: number;
  stepGoal: number;
  waterGoal: number;  // oz
  sleepGoal: number;  // hrs
  proteinPct: number; // % of calories
  carbPct: number;
  fatPct: number;
  tdee: number;
  summaryLines: string[];
};

/**
 * Calculate daily goals from training selection.
 * Uses Mifflin-St Jeor × 1.55 (moderately active — assumes they're training).
 * Body and performance goals stack.
 */
export function calcGoalsFromTraining(
  profile: { age: string; gender: string; height: string; weight: string },
  bodyGoal: string | null,
  perfGoal: string | null,
): TrainingGoalResult | null {
  const weight = parseFloat(profile.weight);
  const age    = parseInt(profile.age, 10);
  if (!weight || !age || !profile.height) return null;

  const heightInches = parseHeightToInches(profile.height);
  if (!heightInches) return null;

  const weightKg = weight * 0.453592;
  const heightCm = heightInches * 2.54;
  const isFemale = profile.gender?.toLowerCase().startsWith('f') ?? true;

  const bmr = isFemale
    ? 10 * weightKg + 6.25 * heightCm - 5 * age - 161
    : 10 * weightKg + 6.25 * heightCm - 5 * age + 5;
  const tdee = Math.round(bmr * 1.55); // moderately active

  let calAdj    = 0;
  let stepGoal  = 8000;
  let waterAdj  = 0;
  let sleepGoal = 8;
  let proteinPct = 30;
  let carbPct    = 40;
  let fatPct     = 30;
  const summaryLines: string[] = [];

  switch (bodyGoal) {
    case 'cut':
      calAdj = -400; stepGoal = 10000; waterAdj = 8;
      proteinPct = 35; carbPct = 35; fatPct = 30;
      summaryLines.push('Cut → −400 kcal deficit to preserve muscle while losing fat');
      summaryLines.push('Protein bumped to 35% — keeps you full and protects lean mass');
      break;
    case 'bulk':
      calAdj = 350; stepGoal = 7500; waterAdj = 8; sleepGoal = 8.5;
      proteinPct = 30; carbPct = 45; fatPct = 25;
      summaryLines.push('Bulk → +350 kcal surplus for muscle growth');
      summaryLines.push('Carbs raised to 45% to fuel heavy training sessions');
      summaryLines.push('Sleep goal raised to 8.5 hrs — growth hormone peaks during deep sleep');
      break;
    case 'recomp':
      calAdj = 0; stepGoal = 9000; waterAdj = 8; sleepGoal = 8.5;
      proteinPct = 38; carbPct = 35; fatPct = 27;
      summaryLines.push('Recomp → maintenance calories, very high protein (38%)');
      summaryLines.push('Higher protein at maintenance is the key driver of simultaneous fat loss + muscle gain');
      break;
    case 'maintenance':
      calAdj = 0; stepGoal = 8000;
      proteinPct = 28; carbPct = 42; fatPct = 30;
      summaryLines.push('Maintenance → calories matched to your TDEE');
      summaryLines.push('Balanced macro split to sustain energy and body composition');
      break;
  }

  switch (perfGoal) {
    case 'marathon':
      calAdj    += 500;
      stepGoal   = Math.max(stepGoal, 12000);
      waterAdj  += 16;
      sleepGoal  = Math.max(sleepGoal, 9);
      carbPct    = Math.min(60, carbPct + 12);
      proteinPct = Math.max(20, proteinPct - 5);
      fatPct     = 100 - carbPct - proteinPct;
      summaryLines.push('Marathon prep → +500 kcal, carbs to 60%, water +16 oz, sleep raised to 9 hrs');
      summaryLines.push('High carbs = glycogen for long runs. Sleep is non-negotiable for recovery.');
      break;
    case '5k':
      calAdj   += 150;
      stepGoal  = Math.max(stepGoal, 9000);
      waterAdj += 4;
      summaryLines.push('5K/10K → modest +150 kcal for speed work recovery');
      break;
    case 'strength':
      calAdj    += 200;
      sleepGoal  = Math.max(sleepGoal, 8.5);
      proteinPct = Math.min(40, proteinPct + 5);
      carbPct    = Math.max(30, carbPct - 3);
      fatPct     = 100 - carbPct - proteinPct;
      summaryLines.push('Strength PR → +200 kcal, protein raised, sleep to 8.5 hrs for CNS recovery');
      break;
    case 'sport':
      calAdj   += 200;
      stepGoal  = Math.max(stepGoal, 9000);
      waterAdj += 8;
      summaryLines.push('Sport-specific → +200 kcal and extra hydration for performance days');
      break;
    case 'general':
      stepGoal = Math.max(stepGoal, 8000);
      summaryLines.push('General fitness → balanced goals to support consistent movement');
      break;
  }

  // Normalize macro %s to exactly 100
  const total = proteinPct + carbPct + fatPct;
  if (total !== 100) fatPct += (100 - total);

  return {
    calGoal:    Math.max(1200, Math.min(5000, Math.round((tdee + calAdj) / 50) * 50)),
    stepGoal,
    waterGoal:  Math.min(140, calcWaterGoalOz(weight) + waterAdj),
    sleepGoal,
    proteinPct,
    carbPct,
    fatPct,
    tdee,
    summaryLines: summaryLines.length > 0 ? summaryLines : ['Goals set to balanced defaults based on your stats'],
  };
}

/** Parse height display string e.g. "5'6\"" → total inches */
function parseHeightToInches(display: string): number | null {
  const m = display.match(/(\d+)'(\d+)/);
  if (m) return parseInt(m[1]) * 12 + parseInt(m[2]);
  const plain = parseFloat(display);
  return plain > 0 ? plain : null;
}

/**
 * Calculates personalized daily calorie, step, and water goals
 * based on the user's profile and weight goal.
 * Uses Mifflin-St Jeor BMR × 1.4 (lightly active) as TDEE baseline.
 * Returns null if required fields are missing or unparseable.
 */
export function calcGoalsFromProfile(p: {
  age: string; gender: string; height: string;
  weight: string; weightGoal: string;
}): { calGoal: number; stepGoal: number; waterGoal: number } | null {
  const weight = parseFloat(p.weight);
  const weightGoal = parseFloat(p.weightGoal);
  const age = parseInt(p.age, 10);
  if (!weight || !weightGoal || !age) return null;

  const heightInches = parseHeightToInches(p.height);
  if (!heightInches) return null;

  const weightKg = weight * 0.453592;
  const heightCm = heightInches * 2.54;
  const isFemale = p.gender.toLowerCase().startsWith('f');

  // Mifflin-St Jeor BMR
  const bmr = isFemale
    ? 10 * weightKg + 6.25 * heightCm - 5 * age - 161
    : 10 * weightKg + 6.25 * heightCm - 5 * age + 5;

  const tdee = bmr * 1.4; // lightly active

  const diff = weightGoal - weight;

  let calGoal: number;
  let stepGoal: number;

  if (diff < -2) {
    // Weight loss: ~500 kcal deficit, higher step goal
    calGoal = Math.round((tdee - 500) / 50) * 50;
    stepGoal = 10000;
  } else if (diff > 2) {
    // Weight gain: ~250 kcal surplus, moderate steps
    calGoal = Math.round((tdee + 250) / 50) * 50;
    stepGoal = 7500;
  } else {
    // Maintenance
    calGoal = Math.round(tdee / 50) * 50;
    stepGoal = 8000;
  }

  // Clamp to reasonable range
  calGoal = Math.max(1200, Math.min(4000, calGoal));

  // Water: standard weight/2 formula, +8 oz for weight loss
  const waterGoal = Math.min(120, calcWaterGoalOz(weight) + (diff < -2 ? 8 : 0));

  return { calGoal, stepGoal, waterGoal };
}

/** Convert total inches to display string e.g. 66 → "5'6\"" */
export function inchesToDisplay(inches: number): string {
  const ft = Math.floor(inches / 12);
  const inn = inches % 12;
  return `${ft}'${inn}"`;
}
