/**
 * pattern-engine.ts
 *
 * Deterministic pattern detection engine for BellaHealth.
 * All analysis is computed from structured normalized data — no LLM inference.
 * Temporal direction is always validated before a relationship is evaluated.
 *
 * Public API:
 *   analyzeEventWindow(event, timeline)   → EventWindowAnalysis
 *   analyzeEventTypePattern(events, timeline) → EventTypePattern
 *   detectPatterns(timeline, registry)    → PatternResult[]
 *   buildHealthTimelineFromStorage()      → HealthDayRecord[] (local logs only)
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  RELATIONSHIP_REGISTRY,
  SIGNAL_DOMAIN,
  SIGNAL_FAMILY,
  SIGNAL_PROVIDER,
  STRUCTURAL_CLUSTERS,
  MEANINGFUL_EFFECT_THRESHOLD,
  EVENT_SIGNAL_RELEVANCE,
  type RelationshipDefinition,
  type SignalKey,
  type ConditionType,
  type SourceName,
} from './pattern-registry';
import {
  loadContextEvents,
  deriveDrinkEvents,
  loadWellnessSessionHistory,
  loadCaffeineHistory,
  type ContextEvent,
} from './context-events';

// ─── Health day record ─────────────────────────────────────────────────────────

/**
 * Normalized daily health snapshot.
 * All fields are optional — missing values stay undefined, never become 0.
 * Date = YYYY-MM-DD. For Oura fields, this is the wakeup/reporting date.
 */
export interface HealthDayRecord {
  date: string;

  // ── Oura Ring ──────────────────────────────────────────────────────────────
  /** Total sleep hours; date = wakeup date */
  sleepHours?: number;
  /** Oura sleep quality score 0-100; same wakeup date as sleepHours */
  sleepScore?: number;
  /** Average HRV in ms measured during sleep; same wakeup date */
  hrv?: number;
  /** Oura readiness score 0-100; same wakeup date as sleep/hrv */
  readiness?: number;
  /** Oura daily activity steps (may lag real-time) */
  ouraSteps?: number;

  // ── Apple Health / HealthKit ───────────────────────────────────────────────
  /** HealthKit step count (preferred over ouraSteps for real-time accuracy) */
  hkSteps?: number;
  /** Total workout minutes logged in Apple Health */
  workoutDurationMin?: number;
  /** Total active calories burned in workouts */
  workoutCaloriesBurned?: number;
  /** Number of distinct workouts */
  workoutCount?: number;
  /** Dietary water in oz */
  waterOz?: number;

  // ── Nutrition (Supabase / Kahunas) ────────────────────────────────────────
  calories?: number;
  protein?: number;
  carbs?: number;
  fat?: number;

  // ── BellaHealth lifestyle logs ─────────────────────────────────────────────
  /** Standard drinks consumed (from drink_log) */
  totalAlcoholDrinks?: number;
  /** Total caffeine in mg (from caffeine_history) */
  caffeineMg?: number;
  hasSaunaSession?: boolean;
  hasColdPlungeSession?: boolean;
  hasWellnessClass?: boolean;
  /** Number of gratitude sessions logged (from grounding modal) */
  gratitudeSessions?: number;
  /** Whether electrolytes were logged on this day */
  electrolytesLogged?: boolean;

  // ── Running workouts (preserved from HealthKit — not yet aggregated away) ──
  /** Total running distance in km across all running-type sessions this day */
  runningDistanceKm?: number;
  /** Number of running-type workout sessions this day */
  runningSessionCount?: number;
  /** Most common (by session count) or longest activity type logged this day */
  primaryActivityType?: string;

  // ── Oura daily stress signals ──────────────────────────────────────────────
  /** Minutes in high physiological stress state (from Oura daily_stress endpoint) */
  stressHighMinutes?: number;
  /** Minutes in high restorative/recovery state (from Oura daily_stress endpoint) */
  recoveryHighMinutes?: number;

  // ── Sleep timing (from Oura session bedtime_start / bedtime_end) ───────────
  /** ISO timestamp: when the user got into bed (Oura session bedtime_start) */
  bedtimeStart?: string;
  /** ISO timestamp: when the user woke up / got out of bed (Oura session bedtime_end) */
  bedtimeEnd?: string;

  // ── Context ────────────────────────────────────────────────────────────────
  /** Types of ContextEvents active on this date */
  activeContextTypes?: string[];
}

// ─── Pattern result types ──────────────────────────────────────────────────────

export type ConfidenceTier = 'INSUFFICIENT' | 'EARLY' | 'PATTERN' | 'CONSISTENT';
export type Direction = 'positive' | 'negative' | 'neutral' | 'unknown';

export interface PatternResult {
  patternId: string;
  relationshipId: string;
  inputSignal: SignalKey;
  outcomeSignal: SignalKey;
  temporalRelationship: 'same_day' | 'next_day';
  observationUnit: 'day';
  observationCount: number;
  baselineCount: number;
  dateRange: { start: string; end: string } | null;
  /** Human description of the high-input condition */
  inputCondition: string;
  /** Mean outcome when condition is met */
  outcomeDuringCondition: number | null;
  /** Mean outcome in baseline group */
  outcomeBaseline: number | null;
  absoluteDifference: number | null;
  /** Only computed when baseline > 5 and makes sense for the scale */
  percentDifference: number | null;
  direction: Direction;
  /** 0–1: fraction of condition-met days where outcome was above its median */
  consistency: number;
  /** Number of days where the input condition was met (high-input days) */
  conditionCount: number;
  sources: string[];
  confidenceTier: ConfidenceTier;
  lastUpdated: string;
}

// ─── Event window types ────────────────────────────────────────────────────────

export interface PeriodStats {
  /** Number of days with data in this period */
  days: number;
  sleepHours: number | null;
  sleepScore: number | null;
  hrv: number | null;
  readiness: number | null;
  steps: number | null;
  workoutDurationMin: number | null;
  totalAlcoholDrinks: number | null;
  calories: number | null;
  protein: number | null;
}

export interface EventWindowAnalysis {
  event: ContextEvent;
  preWindow: PeriodStats;
  duringWindow: PeriodStats;
  /** Always empty when isOngoing=true — no after-period can be fabricated. */
  postWindow: PeriodStats;
  /**
   * True when the event has no end date and is still in progress.
   * duringWindow covers startDate → todayDate.
   * postWindow will always have 0 days.
   * UI must not imply an after period exists.
   */
  isOngoing: boolean;
  /** Signals with data in the pre OR during window (union). */
  availableSignals: Array<keyof PeriodStats>;
  sources: string[];
  /**
   * SINGLE_EVENT: use descriptive language only ("during this trip, sleep averaged X").
   * MULTI_EVENT: this analysis was averaged across repeated events of the same type.
   */
  languageGuard: 'SINGLE_EVENT' | 'MULTI_EVENT';
  observationCount: number;
}

export interface EventTypePattern {
  eventType: string;
  eventCount: number;
  /** averages from all events of this type */
  preAvg: PeriodStats;
  duringAvg: PeriodStats;
  postAvg: PeriodStats;
  availableSignals: Array<keyof PeriodStats>;
  sources: string[];
  /**
   * SINGLE_EVENT if only 1 event analyzed.
   * MULTI_EVENT if ≥ 2 independent events analyzed — can begin to describe tendencies.
   */
  languageGuard: 'SINGLE_EVENT' | 'MULTI_EVENT';
  confidenceTier: ConfidenceTier;
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T12:00:00Z');
  if (isNaN(d.getTime())) return dateStr;
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split('T')[0];
}

function isConsecutiveDays(d1: string, d2: string): boolean {
  return addDays(d1, 1) === d2;
}

function makeDateRange(dates: string[]): { start: string; end: string } | null {
  if (dates.length === 0) return null;
  const sorted = [...dates].sort();
  return { start: sorted[0], end: sorted[sorted.length - 1] };
}

export function getSignalValue(day: HealthDayRecord, signal: SignalKey): number | undefined {
  switch (signal) {
    case 'sleepHours':            return day.sleepHours;
    case 'sleepScore':            return day.sleepScore;
    case 'hrv':                   return day.hrv;
    case 'readiness':             return day.readiness;
    case 'steps':                 return day.hkSteps ?? day.ouraSteps;
    case 'workoutDurationMin':    return day.workoutDurationMin;
    case 'workoutCaloriesBurned': return day.workoutCaloriesBurned;
    case 'workoutCount':          return day.workoutCount;
    case 'totalAlcoholDrinks':    return day.totalAlcoholDrinks;
    case 'caffeineMg':            return day.caffeineMg;
    case 'waterOz':               return day.waterOz;
    case 'calories':              return day.calories;
    case 'protein':               return day.protein;
    case 'carbs':                 return day.carbs;
    case 'fat':                   return day.fat;
    // Lifestyle event signals — only defined when explicitly logged (no 0 baseline)
    case 'hasSaunaSession':       return day.hasSaunaSession       === true ? 1 : undefined;
    case 'hasColdPlungeSession':  return day.hasColdPlungeSession  === true ? 1 : undefined;
    case 'gratitudeSessions':     return day.gratitudeSessions     !== undefined ? day.gratitudeSessions : undefined;
    case 'electrolytesLogged':    return day.electrolytesLogged    === true ? 1 : undefined;
    case 'stressHighMinutes':     return day.stressHighMinutes;
    case 'recoveryHighMinutes':   return day.recoveryHighMinutes;
    default:                      return undefined;
  }
}

function buildInputConditionLabel(signal: SignalKey, conditionType: ConditionType): string {
  const labels: Record<SignalKey, string> = {
    sleepHours:            'nights with more sleep',
    sleepScore:            'nights with higher sleep quality',
    hrv:                   'days with higher HRV',
    readiness:             'days with higher readiness',
    steps:                 'more active days',
    workoutDurationMin:    'longer workout days',
    workoutCaloriesBurned: 'higher-calorie workout days',
    workoutCount:          'days with more workouts',
    totalAlcoholDrinks:    'days when you had alcohol',
    caffeineMg:            'days with more caffeine',
    waterOz:               'days with more water',
    calories:              'days with higher nutrition intake',
    protein:               'days with higher nutrition intake',
    carbs:                 'days with higher nutrition intake',
    fat:                   'days with higher nutrition intake',
    hasSaunaSession:       'days you did sauna',
    hasColdPlungeSession:  'days you did cold plunge',
    gratitudeSessions:     'days you practiced gratitude',
    electrolytesLogged:    'days you logged electrolytes',
    stressHighMinutes:     'days with higher physiological stress',
    recoveryHighMinutes:   'days with higher restorative time',
  };
  if (conditionType === 'nonzero') return labels[signal] ?? signal;
  return labels[signal] ?? `days with higher ${signal}`;
}

function computeConfidenceTier(
  observationCount: number,
  consistency: number,
  minDayPairs: number
): ConfidenceTier {
  if (observationCount < minDayPairs) return 'INSUFFICIENT';
  if (observationCount >= minDayPairs * 4 && consistency >= 0.65) return 'CONSISTENT';
  if (observationCount >= minDayPairs * 2 && consistency >= 0.55) return 'PATTERN';
  return 'EARLY';
}

function computeEventTier(eventCount: number): ConfidenceTier {
  if (eventCount < 1) return 'INSUFFICIENT';
  if (eventCount === 1) return 'EARLY';
  if (eventCount >= 3) return 'PATTERN';
  return 'EARLY';
}

// ─── Core pair analysis ────────────────────────────────────────────────────────

interface PairAnalysis {
  observationCount: number;
  conditionCount: number;
  baselineCount: number;
  outcomeDuringCondition: number | null;
  outcomeBaseline: number | null;
  absoluteDifference: number | null;
  percentDifference: number | null;
  direction: Direction;
  consistency: number;
  confidenceTier: ConfidenceTier;
  inputDates: string[];
}

function analyzePairs(
  pairs: Array<{ input: number; outcome: number; date: string }>,
  conditionType: ConditionType,
  minDayPairs: number
): PairAnalysis {
  const empty: PairAnalysis = {
    observationCount: pairs.length,
    conditionCount: 0,
    baselineCount: 0,
    outcomeDuringCondition: null,
    outcomeBaseline: null,
    absoluteDifference: null,
    percentDifference: null,
    direction: 'unknown',
    consistency: 0,
    confidenceTier: 'INSUFFICIENT',
    inputDates: [],
  };

  if (pairs.length < minDayPairs) return empty;

  let conditionPairs: typeof pairs;
  let baselinePairs: typeof pairs;

  if (conditionType === 'nonzero') {
    conditionPairs = pairs.filter((p) => p.input > 0);
    baselinePairs  = pairs.filter((p) => p.input === 0);
  } else {
    const inputMedian = medianOf(pairs.map((p) => p.input)) ?? 0;
    conditionPairs = pairs.filter((p) => p.input > inputMedian);
    baselinePairs  = pairs.filter((p) => p.input <= inputMedian);
  }

  if (conditionPairs.length === 0 || baselinePairs.length === 0) return empty;

  const outcomeDuringCondition = mean(conditionPairs.map((p) => p.outcome))!;
  const outcomeBaseline        = mean(baselinePairs.map((p) => p.outcome))!;
  const absoluteDifference     = outcomeDuringCondition - outcomeBaseline;

  const percentDifference =
    outcomeBaseline > 5
      ? Math.round((absoluteDifference / outcomeBaseline) * 1000) / 10
      : null;

  const allOutcomeMedian = medianOf(pairs.map((p) => p.outcome)) ?? 0;
  const aboveMedianCount = conditionPairs.filter((p) => p.outcome > allOutcomeMedian).length;
  const consistency      = aboveMedianCount / conditionPairs.length;

  const direction: Direction =
    absoluteDifference >  0.1 ? 'positive' :
    absoluteDifference < -0.1 ? 'negative' :
    'neutral';

  const confidenceTier = computeConfidenceTier(pairs.length, consistency, minDayPairs);

  return {
    observationCount: pairs.length,
    conditionCount: conditionPairs.length,
    baselineCount: baselinePairs.length,
    outcomeDuringCondition,
    outcomeBaseline,
    absoluteDifference,
    percentDifference,
    direction,
    consistency,
    confidenceTier,
    inputDates: pairs.map((p) => p.date),
  };
}

// ─── Same-day analysis ─────────────────────────────────────────────────────────

function analyzeSameDay(
  sortedTimeline: HealthDayRecord[],
  rel: RelationshipDefinition
): PatternResult | null {
  const pairs: Array<{ input: number; outcome: number; date: string }> = [];

  for (const day of sortedTimeline) {
    const input   = getSignalValue(day, rel.inputSignal);
    const outcome = getSignalValue(day, rel.outcomeSignal);
    if (input !== undefined && outcome !== undefined) {
      pairs.push({ input, outcome, date: day.date });
    }
  }

  const analysis = analyzePairs(pairs, rel.conditionType, rel.minDayPairs);
  if (analysis.confidenceTier === 'INSUFFICIENT' && pairs.length < rel.minDayPairs) return null;

  const dateRange = makeDateRange(analysis.inputDates);

  return {
    patternId:             `${rel.id}_${Date.now()}`,
    relationshipId:        rel.id,
    inputSignal:           rel.inputSignal,
    outcomeSignal:         rel.outcomeSignal,
    temporalRelationship:  'same_day',
    observationUnit:       'day',
    observationCount:      analysis.observationCount,
    baselineCount:         analysis.baselineCount,
    dateRange,
    inputCondition:        buildInputConditionLabel(rel.inputSignal, rel.conditionType),
    outcomeDuringCondition: analysis.outcomeDuringCondition,
    outcomeBaseline:       analysis.outcomeBaseline,
    absoluteDifference:    analysis.absoluteDifference,
    percentDifference:     analysis.percentDifference,
    direction:             analysis.direction,
    consistency:           analysis.consistency,
    conditionCount:        analysis.conditionCount,
    sources:               [...rel.inputSources, ...rel.outcomeSources],
    confidenceTier:        analysis.confidenceTier,
    lastUpdated:           new Date().toISOString(),
  };
}

// ─── Next-day analysis ─────────────────────────────────────────────────────────

function analyzeNextDay(
  sortedTimeline: HealthDayRecord[],
  rel: RelationshipDefinition
): PatternResult | null {
  const pairs: Array<{ input: number; outcome: number; date: string }> = [];

  for (let i = 0; i < sortedTimeline.length - 1; i++) {
    const today    = sortedTimeline[i];
    const tomorrow = sortedTimeline[i + 1];
    // Only use pairs from consecutive calendar days to preserve temporal direction
    if (!isConsecutiveDays(today.date, tomorrow.date)) continue;

    const input   = getSignalValue(today, rel.inputSignal);
    const outcome = getSignalValue(tomorrow, rel.outcomeSignal);
    if (input !== undefined && outcome !== undefined) {
      pairs.push({ input, outcome, date: today.date });
    }
  }

  const analysis = analyzePairs(pairs, rel.conditionType, rel.minDayPairs);
  if (analysis.confidenceTier === 'INSUFFICIENT' && pairs.length < rel.minDayPairs) return null;

  const dateRange = makeDateRange(analysis.inputDates);

  return {
    patternId:             `${rel.id}_${Date.now()}`,
    relationshipId:        rel.id,
    inputSignal:           rel.inputSignal,
    outcomeSignal:         rel.outcomeSignal,
    temporalRelationship:  'next_day',
    observationUnit:       'day',
    observationCount:      analysis.observationCount,
    baselineCount:         analysis.baselineCount,
    dateRange,
    inputCondition:        buildInputConditionLabel(rel.inputSignal, rel.conditionType),
    outcomeDuringCondition: analysis.outcomeDuringCondition,
    outcomeBaseline:       analysis.outcomeBaseline,
    absoluteDifference:    analysis.absoluteDifference,
    percentDifference:     analysis.percentDifference,
    direction:             analysis.direction,
    consistency:           analysis.consistency,
    conditionCount:        analysis.conditionCount,
    sources:               [...rel.inputSources, ...rel.outcomeSources],
    confidenceTier:        analysis.confidenceTier,
    lastUpdated:           new Date().toISOString(),
  };
}

// ─── Period statistics ─────────────────────────────────────────────────────────

function computePeriodStats(days: HealthDayRecord[]): PeriodStats {
  const collect = (fn: (d: HealthDayRecord) => number | undefined): number[] =>
    days.map(fn).filter((v): v is number => v !== undefined);

  const sleepHoursVals       = collect((d) => d.sleepHours);
  const sleepScoreVals       = collect((d) => d.sleepScore);
  const hrvVals              = collect((d) => d.hrv);
  const readinessVals        = collect((d) => d.readiness);
  const stepsVals            = collect((d) => d.hkSteps ?? d.ouraSteps);
  const workoutVals          = collect((d) => d.workoutDurationMin);
  const alcoholVals          = collect((d) => d.totalAlcoholDrinks);
  const caloriesVals         = collect((d) => d.calories);
  const proteinVals          = collect((d) => d.protein);

  return {
    days:               days.length,
    sleepHours:         mean(sleepHoursVals),
    sleepScore:         mean(sleepScoreVals),
    hrv:                mean(hrvVals),
    readiness:          mean(readinessVals),
    steps:              mean(stepsVals),
    workoutDurationMin: mean(workoutVals),
    totalAlcoholDrinks: mean(alcoholVals),
    calories:           mean(caloriesVals),
    protein:            mean(proteinVals),
  };
}

function availableStatsKeys(stats: PeriodStats): Array<keyof PeriodStats> {
  const keys: Array<keyof PeriodStats> = [
    'sleepHours', 'sleepScore', 'hrv', 'readiness',
    'steps', 'workoutDurationMin', 'totalAlcoholDrinks',
    'calories', 'protein',
  ];
  return keys.filter((k) => stats[k] !== null && k !== 'days');
}

// ─── Event window analysis ─────────────────────────────────────────────────────

const EVENT_WINDOW_PRE_DAYS  = 14;
const EVENT_WINDOW_POST_DAYS = 7;

/**
 * Analyzes a single ContextEvent (completed or ongoing) against the provided timeline.
 *
 * IMPORTANT: languageGuard is always SINGLE_EVENT here.
 * A single event must only produce descriptive comparisons:
 *   "During this trip, sleep averaged X compared with Y beforehand."
 * NOT: "Travel lowers your sleep."
 *
 * Ongoing events (no endDate):
 *   duringWindow covers startDate → todayDate.
 *   postWindow is always empty — never fabricated.
 *   isOngoing=true is set so callers and UI handle this correctly.
 *
 * @param todayDate  Pass the current date string (YYYY-MM-DD) for deterministic
 *                   behavior in tests and correct ongoing-event handling.
 *                   Defaults to the real current date.
 *
 * For repeated-event patterns, use analyzeEventTypePattern().
 */
export function analyzeEventWindow(
  event: ContextEvent,
  timeline: HealthDayRecord[],
  todayDate?: string,
): EventWindowAnalysis {
  const today     = todayDate ?? new Date().toISOString().split('T')[0];
  const isOngoing = !event.endDate;
  const sorted    = [...timeline].sort((a, b) => a.date.localeCompare(b.date));

  const preStart  = addDays(event.startDate, -EVENT_WINDOW_PRE_DAYS);
  // For ongoing events, capture all days from startDate through today.
  // Previously: eventEnd = event.endDate ?? event.startDate — this was wrong for ongoing events
  // because it collapsed the during-window to a single day.
  const eventEnd  = event.endDate ?? today;
  // No post-window for ongoing events — we never fabricate an after-period.
  const postEnd   = (!isOngoing && event.endDate)
    ? addDays(event.endDate, EVENT_WINDOW_POST_DAYS)
    : null;

  const preDays    = sorted.filter((d) => d.date >= preStart && d.date < event.startDate);
  const duringDays = sorted.filter((d) => d.date >= event.startDate && d.date <= eventEnd);
  const postDays   = postEnd
    ? sorted.filter((d) => d.date > eventEnd && d.date <= postEnd)
    : [];

  const preWindow    = computePeriodStats(preDays);
  const duringWindow = computePeriodStats(duringDays);
  const postWindow   = computePeriodStats(postDays);

  // Sources: infer from which signals have data across pre + during
  const allDays = [...preDays, ...duringDays];
  const sources: string[] = [];
  if (allDays.some((d) => d.sleepHours !== undefined)) sources.push('oura_sleep');
  if (allDays.some((d) => d.hrv !== undefined))        sources.push('oura_hrv');
  if (allDays.some((d) => d.readiness !== undefined))  sources.push('oura_readiness');
  if (allDays.some((d) => (d.hkSteps ?? d.ouraSteps) !== undefined)) sources.push('apple_health_steps');
  if (allDays.some((d) => d.workoutDurationMin !== undefined)) sources.push('apple_health_workouts');
  sources.push('bellahealth_context_event');

  // Available signals: union of pre + during (so comparison rows can show even if
  // a signal is missing from one window but present in the other)
  const preSignals    = availableStatsKeys(preWindow);
  const duringSignals = availableStatsKeys(duringWindow);
  const allSignals    = [...new Set([...preSignals, ...duringSignals])];

  return {
    event,
    preWindow,
    duringWindow,
    postWindow,
    isOngoing,
    availableSignals: allSignals,
    sources: [...new Set(sources)],
    languageGuard: 'SINGLE_EVENT',
    observationCount: 1,
  };
}

/**
 * Analyzes all events of a given type to detect a repeated-event pattern.
 * Averages each event's pre/during/post windows.
 *
 * languageGuard = MULTI_EVENT only when ≥ 2 independent events are analyzed.
 * Even then, language must describe tendency, not causation.
 */
export function analyzeEventTypePattern(
  events: ContextEvent[],
  timeline: HealthDayRecord[],
  todayDate?: string,
): EventTypePattern {
  const boundedEvents = events.filter((e) => !!e.endDate);
  const analyses      = boundedEvents.map((e) => analyzeEventWindow(e, timeline, todayDate));

  // Average the period stats across events
  function avgStats(period: 'preWindow' | 'duringWindow' | 'postWindow'): PeriodStats {
    const statsList = analyses.map((a) => a[period]);
    const keys: Array<keyof PeriodStats> = [
      'sleepHours', 'sleepScore', 'hrv', 'readiness',
      'steps', 'workoutDurationMin', 'totalAlcoholDrinks',
      'calories', 'protein',
    ];
    const result: PeriodStats = {
      days: Math.round(mean(statsList.map((s) => s.days)) ?? 0),
      sleepHours: null, sleepScore: null, hrv: null, readiness: null,
      steps: null, workoutDurationMin: null, totalAlcoholDrinks: null,
      calories: null, protein: null,
    };
    for (const key of keys) {
      const vals = statsList.map((s) => s[key]).filter((v): v is number => v !== null);
      (result as any)[key] = mean(vals);
    }
    return result;
  }

  const preAvg    = avgStats('preWindow');
  const duringAvg = avgStats('duringWindow');
  const postAvg   = avgStats('postWindow');

  const allSources = [...new Set(analyses.flatMap((a) => a.sources))];
  const allSignals = availableStatsKeys(duringAvg);
  const eventCount = boundedEvents.length;

  return {
    eventType:    events[0]?.type ?? 'user_defined',
    eventCount,
    preAvg,
    duringAvg,
    postAvg,
    availableSignals: allSignals,
    sources: allSources,
    languageGuard: eventCount >= 2 ? 'MULTI_EVENT' : 'SINGLE_EVENT',
    confidenceTier: computeEventTier(eventCount),
  };
}

// ─── detectPatterns ────────────────────────────────────────────────────────────

/**
 * Evaluates the registry against the provided timeline.
 * Returns PatternResult[] sorted by confidence (CONSISTENT first) then observationCount.
 * Suppresses INSUFFICIENT results and trivial differences (|absoluteDifference| < 0.1).
 *
 * Does NOT evaluate event_window relationships — call analyzeEventWindow separately.
 */
export function detectPatterns(
  timeline: HealthDayRecord[],
  registry: RelationshipDefinition[] = RELATIONSHIP_REGISTRY
): PatternResult[] {
  const sorted = [...timeline].sort((a, b) => a.date.localeCompare(b.date));
  const results: PatternResult[] = [];

  for (const rel of registry) {
    if (rel.temporalRelationship === 'event_window') continue;

    const result =
      rel.temporalRelationship === 'same_day'
        ? analyzeSameDay(sorted, rel)
        : rel.temporalRelationship === 'next_day'
        ? analyzeNextDay(sorted, rel)
        : null;

    if (!result) continue;
    if (result.confidenceTier === 'INSUFFICIENT') continue;
    const minEffect = MEANINGFUL_EFFECT_THRESHOLD[result.outcomeSignal as SignalKey] ?? 0.1;
    if (Math.abs(result.absoluteDifference ?? 0) < minEffect) continue;

    results.push(result);
  }

  const tierOrder: Record<ConfidenceTier, number> = {
    CONSISTENT: 3, PATTERN: 2, EARLY: 1, INSUFFICIENT: 0,
  };

  return results.sort((a, b) => {
    const td = tierOrder[b.confidenceTier] - tierOrder[a.confidenceTier];
    return td !== 0 ? td : b.observationCount - a.observationCount;
  });
}

// ─── rankPatternsForDisplay ────────────────────────────────────────────────────

/**
 * Ranking pipeline between detectPatterns output and What's Connected display.
 *
 *   Stage 1 — Canonical pair deduplication
 *     Group by (SIGNAL_FAMILY[input], SIGNAL_FAMILY[outcome]).
 *     Within each group keep only the best-scoring representative.
 *     Prevents: Sleep→Readiness + Sleep Quality→Readiness + Sleep→HRV
 *     from appearing as separate cards when they all say "better sleep = better recovery."
 *
 *   Stage 2 — Usefulness scoring
 *     Rank survivors by value to the user, not raw statistical evidence:
 *     · Cross-domain bonus    (MOVEMENT→RECOVERY > SLEEP→RECOVERY)
 *     · Cross-provider bonus  (Apple→Oura > Oura→Oura)
 *     · User-logged bonus     (BellaHealth logs require user action → more actionable)
 *     · Event relevance bonus (finding matches active life context)
 *     · Structural obviousness penalty (intra-provider within a tight domain cluster)
 *     · Registry intent       (includeInSynthesis:false signals secondary representation)
 *     Evidence strength (tier, observation count) anchors the base score.
 *
 *   Stage 3 — Domain diversity cap
 *     Max 2 patterns from any single input signal domain.
 *
 *   Stage 4 — Slice to maxResults.
 *
 * INVARIANT: Evidence threshold is NEVER relaxed for usefulness reasons.
 *   Only patterns that passed detectPatterns' evidence gates are eligible.
 *   rankPatternsForDisplay only reorders and deduplicates — it never rescues
 *   patterns that failed evidence requirements.
 *
 * @returns { ranked, hadEvidence }
 *   ranked      — ordered display list (may be empty)
 *   hadEvidence — true if any evidence-eligible patterns existed before ranking;
 *                 caller uses this to distinguish "still learning" (no evidence)
 *                 from "nothing new stands out" (evidence exists, all suppressed)
 */
export function rankPatternsForDisplay(
  patterns: PatternResult[],
  activeEventTypes: string[] = [],
  maxResults = 4,
): { ranked: PatternResult[]; hadEvidence: boolean } {
  const hadEvidence = patterns.length > 0;
  if (!hadEvidence) return { ranked: [], hadEvidence: false };

  // ── Stage 1: Canonical pair deduplication ───────────────────────────────────

  const pairGroups = new Map<string, PatternResult[]>();
  for (const p of patterns) {
    const inputFam   = SIGNAL_FAMILY[p.inputSignal]   ?? p.inputSignal;
    const outcomeFam = SIGNAL_FAMILY[p.outcomeSignal] ?? p.outcomeSignal;
    const key = `${inputFam}||${outcomeFam}`;
    const grp = pairGroups.get(key) ?? [];
    grp.push(p);
    pairGroups.set(key, grp);
  }

  const deduplicated: PatternResult[] = [];
  for (const grp of pairGroups.values()) {
    // Keep the representative with the highest usefulness score
    const best = grp.reduce((a, b) =>
      scorePattern(b, activeEventTypes) >= scorePattern(a, activeEventTypes) ? b : a
    );
    deduplicated.push(best);
  }

  // ── Stage 2: Sort by usefulness score ───────────────────────────────────────

  deduplicated.sort(
    (a, b) => scorePattern(b, activeEventTypes) - scorePattern(a, activeEventTypes)
  );

  // ── Stage 3: Domain diversity cap ───────────────────────────────────────────
  // At most 2 patterns per input signal domain.
  // Never lowers evidence threshold — only selects among already-qualified patterns.

  const inputDomainCount = new Map<string, number>();
  const ranked: PatternResult[] = [];

  for (const p of deduplicated) {
    const dom   = SIGNAL_DOMAIN[p.inputSignal] ?? 'OTHER';
    const count = inputDomainCount.get(dom) ?? 0;
    if (count >= 2) continue;
    inputDomainCount.set(dom, count + 1);
    ranked.push(p);
    if (ranked.length >= maxResults) break;
  }

  return { ranked, hadEvidence };
}

/**
 * Internal usefulness score — never shown in UI.
 * Evidence strength is the floor; cross-domain/cross-source/actionability bonuses
 * determine ordering among evidence-qualified patterns.
 */
export function scorePattern(p: PatternResult, activeEventTypes: string[] = []): number {
  const TIER_SCORE: Record<ConfidenceTier, number> = {
    CONSISTENT: 30, PATTERN: 20, EARLY: 10, INSUFFICIENT: 0,
  };

  const inputDomain    = SIGNAL_DOMAIN[p.inputSignal]    ?? '';
  const outcomeDomain  = SIGNAL_DOMAIN[p.outcomeSignal]  ?? '';
  const inputProvider  = SIGNAL_PROVIDER[p.inputSignal]  ?? '';
  const outcomeProvider = SIGNAL_PROVIDER[p.outcomeSignal] ?? '';

  let score = TIER_SCORE[p.confidenceTier];

  // Observation count contribution (log-scale, capped at 6 pts)
  score += Math.min(Math.floor(Math.log2(Math.max(p.observationCount, 1))), 6);

  // Cross-domain: different health domains → more informative
  if (inputDomain && outcomeDomain && inputDomain !== outcomeDomain) score += 15;

  // Cross-provider: cannot be learned from one single source app
  if (inputProvider && outcomeProvider && inputProvider !== outcomeProvider) score += 20;

  // User-logged input: BellaHealth data requires deliberate logging → highly actionable
  if (inputProvider === 'bellahealth') score += 10;

  // Event relevance: boost only when the active event type is meaningfully related
  // to this pattern's signal families (not a blanket lifestyle-signal boost)
  if (activeEventTypes.length > 0) {
    const inputFam   = SIGNAL_FAMILY[p.inputSignal]   ?? '';
    const outcomeFam = SIGNAL_FAMILY[p.outcomeSignal] ?? '';
    const isRelevant = activeEventTypes.some((evtType) => {
      const families = EVENT_SIGNAL_RELEVANCE[evtType] ?? [];
      return families.includes(inputFam) || families.includes(outcomeFam);
    });
    if (isRelevant) score += 8;
  }

  // Structural obviousness penalty:
  // Intra-provider patterns where the provider's outputs are known to be tightly coupled
  // (e.g., Oura Readiness is algorithmically derived from Oura Sleep + HRV)
  if (inputProvider && inputProvider === outcomeProvider) {
    const inTightCluster = STRUCTURAL_CLUSTERS.some(
      (c) =>
        c.provider === inputProvider &&
        c.domains.includes(inputDomain) &&
        c.domains.includes(outcomeDomain)
    );
    if (inTightCluster) score -= 15;
  }

  // Registry intent: relationships marked includeInSynthesis:false are
  // secondary representations (e.g., duplicate lag variant); prefer primary
  const regEntry = RELATIONSHIP_REGISTRY.find((r) => r.id === p.relationshipId);
  if (regEntry && !regEntry.includeInSynthesis) score -= 5;

  return score;
}

// ─── buildHealthTimelineFromStorage ───────────────────────────────────────────

/**
 * Builds a partial HealthDayRecord[] from AsyncStorage logs (lifestyle data only).
 * This does NOT include Oura or HealthKit data — those require API calls in-app.
 * Useful for testing the engine with whatever local logs exist.
 *
 * For full timelines, the app should call Oura + HealthKit APIs and construct
 * HealthDayRecord[] with all fields populated, then pass to detectPatterns().
 */
export async function buildHealthTimelineFromStorage(): Promise<HealthDayRecord[]> {
  const map: Map<string, HealthDayRecord> = new Map();

  function getOrCreate(date: string): HealthDayRecord {
    if (!map.has(date)) map.set(date, { date });
    return map.get(date)!;
  }

  try {
    // Drink log
    const drinkRaw = await AsyncStorage.getItem('drink_log');
    if (drinkRaw) {
      const log: Array<{ date: string; totalDrinks: number }> = JSON.parse(drinkRaw);
      for (const entry of log) {
        getOrCreate(entry.date).totalAlcoholDrinks = entry.totalDrinks;
      }
    }

    // Caffeine history
    const cafRaw = await AsyncStorage.getItem('caffeine_history');
    if (cafRaw) {
      const hist: Array<{ date: string; totalMg: number }> = JSON.parse(cafRaw);
      for (const entry of hist) {
        getOrCreate(entry.date).caffeineMg = entry.totalMg;
      }
    }

    // Wellness sessions history
    const wellRaw = await AsyncStorage.getItem('wellness_sessions_history');
    if (wellRaw) {
      const hist: Array<{ date: string; type: string }> = JSON.parse(wellRaw);
      for (const entry of hist) {
        const day = getOrCreate(entry.date);
        if (entry.type === 'sauna')       day.hasSaunaSession    = true;
        if (entry.type === 'cold_plunge') day.hasColdPlungeSession = true;
      }
    }

    // Wellness classes history
    const classRaw = await AsyncStorage.getItem('wellness_classes_history');
    if (classRaw) {
      const hist: Array<{ date?: string }> = JSON.parse(classRaw);
      for (const entry of hist) {
        if (entry.date) getOrCreate(entry.date).hasWellnessClass = true;
      }
    }

    // Gratitude sessions history
    const gratRaw = await AsyncStorage.getItem('gratitude_entries');
    if (gratRaw) {
      const entries: Array<{ date: string }> = JSON.parse(gratRaw);
      for (const entry of entries) {
        if (!entry.date) continue;
        const day = getOrCreate(entry.date);
        day.gratitudeSessions = (day.gratitudeSessions ?? 0) + 1;
      }
    }

    // Electrolytes history
    const elecRaw = await AsyncStorage.getItem('electrolytes_history');
    if (elecRaw) {
      const hist: Array<{ date: string }> = JSON.parse(elecRaw);
      for (const entry of hist) {
        getOrCreate(entry.date).electrolytesLogged = true;
      }
    }

    // Water history (BellaHealth manually-logged water, cumulative daily oz)
    const waterRaw = await AsyncStorage.getItem('water_history');
    if (waterRaw) {
      const hist: Array<{ date: string; oz: number }> = JSON.parse(waterRaw);
      for (const entry of hist) {
        if (entry.oz > 0) getOrCreate(entry.date).waterOz = entry.oz;
      }
    }

    // Context events → activeContextTypes
    const ctxEvents = await loadContextEvents();
    for (const event of ctxEvents) {
      // Mark every day in the event's range
      const end = event.endDate ?? event.startDate;
      let cur = event.startDate;
      while (cur <= end) {
        const day = getOrCreate(cur);
        day.activeContextTypes = [...(day.activeContextTypes ?? []), event.type];
        cur = addDays(cur, 1);
      }
    }
  } catch {
    // Partial failure — return whatever was built
  }

  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}
