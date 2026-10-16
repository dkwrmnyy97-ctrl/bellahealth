/**
 * pattern-registry.ts
 *
 * Curated registry of clinically/logically sensible candidate relationships
 * for deterministic pattern detection. This is NOT open-ended combinatorial
 * correlation — only registered, temporally-valid relationships are evaluated.
 *
 * Adding a relationship here means the engine will evaluate it.
 * Removing one means the engine will not. Keep this list conservative.
 *
 * Temporal direction is explicit and documented per relationship.
 * Never register a relationship where the supposed outcome could precede the input.
 */

// ─── Signal keys ───────────────────────────────────────────────────────────────

/** Maps to fields in HealthDayRecord. 'steps' is derived: hkSteps ?? ouraSteps. */
export type SignalKey =
  | 'sleepHours'
  | 'sleepScore'
  | 'hrv'
  | 'readiness'
  | 'steps'
  | 'workoutDurationMin'
  | 'workoutCaloriesBurned'
  | 'workoutCount'
  | 'totalAlcoholDrinks'
  | 'caffeineMg'
  | 'waterOz'
  | 'calories'
  | 'protein'
  | 'carbs'
  | 'fat'
  | 'hasSaunaSession'
  | 'hasColdPlungeSession'
  | 'gratitudeSessions'
  | 'electrolytesLogged'
  | 'stressHighMinutes'
  | 'recoveryHighMinutes';

// ─── Temporal relationships ────────────────────────────────────────────────────

export type TemporalRelationship =
  | 'same_day'    // input and outcome share the same date (e.g. Oura sleep + readiness)
  | 'next_day'    // input on date D, outcome on date D+1 (next consecutive calendar day)
  | 'event_window'; // analysis across a bounded ContextEvent; handled by analyzeEventWindow

// ─── Condition types ───────────────────────────────────────────────────────────

export type ConditionType =
  | 'median_split'  // high input (above median) vs low input (at or below median)
  | 'nonzero';      // any input > 0 vs input === 0 (for binary-ish signals like alcohol)

// ─── Source names ──────────────────────────────────────────────────────────────

export type SourceName =
  | 'oura_sleep'
  | 'oura_hrv'
  | 'oura_readiness'
  | 'oura_activity'
  | 'apple_health_workouts'
  | 'apple_health_steps'
  | 'apple_health_water'
  | 'bellahealth_drink_log'
  | 'bellahealth_caffeine'
  | 'bellahealth_nutrition'
  | 'bellahealth_context_event'
  | 'oura_stress';

// ─── Signal domain / family / provider metadata ────────────────────────────────

/**
 * Broad health domain each signal belongs to.
 * Used to detect cross-domain connections (more informative to the user)
 * and to enforce domain diversity in ranking.
 */
export const SIGNAL_DOMAIN: Record<SignalKey, string> = {
  sleepHours:            'SLEEP',
  sleepScore:            'SLEEP',
  hrv:                   'RECOVERY',
  readiness:             'RECOVERY',
  steps:                 'MOVEMENT',
  workoutDurationMin:    'MOVEMENT',
  workoutCaloriesBurned: 'MOVEMENT',
  workoutCount:          'MOVEMENT',
  totalAlcoholDrinks:    'LIFESTYLE',
  caffeineMg:            'LIFESTYLE',
  waterOz:               'LIFESTYLE',
  calories:              'NUTRITION',
  protein:               'NUTRITION',
  carbs:                 'NUTRITION',
  fat:                   'NUTRITION',
  hasSaunaSession:       'LIFESTYLE',
  hasColdPlungeSession:  'LIFESTYLE',
  gratitudeSessions:     'LIFESTYLE',
  electrolytesLogged:    'LIFESTYLE',
  stressHighMinutes:     'STRESS',
  recoveryHighMinutes:   'STRESS',
};

/**
 * Canonical signal family — tighter than domain.
 * Two patterns with identical (inputFamily, outcomeFamily) communicate
 * essentially the same user-facing insight and should be deduplicated
 * to one representative card in What's Connected.
 *
 * Examples that collapse to one card:
 *   sleepHours→readiness + sleepScore→readiness  (both: sleep_quality→recovery)
 *   sleepHours→hrv       + sleepScore→hrv         (both: sleep_quality→recovery)
 *   workoutDurationMin→readiness + workoutDurationMin→hrv  (both: activity→recovery)
 */
export const SIGNAL_FAMILY: Record<SignalKey, string> = {
  sleepHours:            'sleep_quality',
  sleepScore:            'sleep_quality',
  hrv:                   'recovery',
  readiness:             'recovery',
  steps:                 'activity',
  workoutDurationMin:    'activity',
  workoutCaloriesBurned: 'activity',
  workoutCount:          'activity',
  totalAlcoholDrinks:    'alcohol',
  caffeineMg:            'caffeine',
  waterOz:               'hydration',
  calories:              'nutrition',
  protein:               'nutrition',
  carbs:                 'nutrition',
  fat:                   'nutrition',
  hasSaunaSession:       'sauna',
  hasColdPlungeSession:  'cold_plunge',
  gratitudeSessions:     'gratitude',
  electrolytesLogged:    'electrolytes',
  // Same family → deduplication suppresses redundant stress/recovery observations
  stressHighMinutes:     'oura_stress',
  recoveryHighMinutes:   'oura_stress',
};

/**
 * The external provider that originally generates this signal.
 * Cross-provider connections (Apple Health → Oura, BellaHealth → Oura)
 * are preferred because the user could not discover them by opening
 * a single source app.
 */
export const SIGNAL_PROVIDER: Record<SignalKey, string> = {
  sleepHours:            'oura',
  sleepScore:            'oura',
  hrv:                   'oura',
  readiness:             'oura',
  steps:                 'apple',
  workoutDurationMin:    'apple',
  workoutCaloriesBurned: 'apple',
  workoutCount:          'apple',
  totalAlcoholDrinks:    'bellahealth',
  caffeineMg:            'bellahealth',
  waterOz:               'apple',
  calories:              'bellahealth',
  protein:               'bellahealth',
  carbs:                 'bellahealth',
  fat:                   'bellahealth',
  hasSaunaSession:       'bellahealth',
  hasColdPlungeSession:  'bellahealth',
  gratitudeSessions:     'bellahealth',
  electrolytesLogged:    'bellahealth',
  stressHighMinutes:     'oura',
  recoveryHighMinutes:   'oura',
};

/**
 * Provider-specific domain clusters where signals are structurally related.
 *
 * When a relationship's input AND output both fall within the same provider's
 * tight cluster, a structural-obviousness penalty is applied during ranking.
 * Rationale: the outcome is often algorithmically derived from (or tightly
 * coupled to) the input within that provider's system.
 *
 * Example: Oura's Readiness score is computed from sleep duration, HRV, and
 * other Oura ring measurements — so Sleep → Readiness (all Oura) is less
 * informative than Workout → Readiness (Apple → Oura).
 *
 * Add clusters here as new providers are integrated; do not hardcode
 * individual signal pairs.
 */
export const STRUCTURAL_CLUSTERS: Array<{ provider: string; domains: string[] }> = [
  { provider: 'oura', domains: ['SLEEP', 'RECOVERY'] },
];

// ─── Meaningful-effect thresholds ─────────────────────────────────────────────

/**
 * Minimum absolute difference in the OUTCOME signal required for a pattern
 * to be considered practically meaningful — not just statistically detectable.
 *
 * Applied in detectPatterns after evidence gates pass.
 * Keyed by OUTCOME signal because absoluteDifference is always in outcome units.
 * Conservative: false negatives preferred over surfacing trivial findings.
 *
 * Units match HealthDayRecord field definitions:
 *   readiness / sleepScore → Oura 0-100 score points
 *   hrv                    → milliseconds
 *   sleepHours             → hours (0.25h ≈ 15 min)
 *   steps                  → step count
 *   workoutDurationMin     → minutes
 *   workoutCaloriesBurned  → kcal
 *   totalAlcoholDrinks     → standard drinks
 *   caffeineMg             → mg
 *   waterOz                → fl oz
 *   calories               → kcal dietary
 *   protein                → grams
 *
 * Limitation: these are absolute thresholds. For HRV especially, a relative
 * threshold (% of user's personal baseline) would better reflect individual
 * variation (a 3ms shift means less to someone with 60ms HRV than to someone
 * with 25ms HRV). Per-user relative calibration is a future enhancement.
 */
export const MEANINGFUL_EFFECT_THRESHOLD: Partial<Record<SignalKey, number>> = {
  readiness:            3,    // perceivable daily readiness shift on Oura 0-100 scale
  hrv:                  3,    // ms; conservative floor that works across most user ranges
  sleepHours:           0.25, // hours; ~15 min — smaller differences are within measurement noise
  sleepScore:           3,    // same reasoning as readiness
  steps:                500,  // ~5-10 min of brisk walking
  workoutDurationMin:   5,    // minutes; sub-5-min differences below device precision
  workoutCaloriesBurned: 25,  // kcal; below typical consumer-device rounding error
  workoutCount:         0.3,  // workouts; effectively "roughly one additional workout on average"
  totalAlcoholDrinks:   0.3,  // standard drinks
  caffeineMg:           25,   // mg; ~¼ cup of coffee
  waterOz:              4,    // fl oz; ~half a cup
  calories:             50,   // kcal dietary
  protein:              5,    // grams
  carbs:                10,   // grams
  fat:                  5,    // grams
  // Boolean signals (0/1) — any difference is meaningful
  hasSaunaSession:      0.3,
  hasColdPlungeSession: 0.3,
  gratitudeSessions:    0.3,
  electrolytesLogged:   0.3,
  // Oura daily_stress — 15 min threshold avoids surfacing minor measurement noise
  stressHighMinutes:    15,
  recoveryHighMinutes:  15,
};

// ─── Event–signal relevance ────────────────────────────────────────────────────

/**
 * Maps ContextEvent types to the SIGNAL_FAMILY values they are meaningfully
 * related to — used exclusively for the event-relevance ranking bonus in
 * rankPatternsForDisplay / scorePattern.
 *
 * The bonus fires when an active event type has the candidate pattern's
 * INPUT or OUTPUT signal family in this list.
 *
 * Rules:
 *   - Event presence does NOT create evidence. This only affects ranking
 *     among already evidence-qualified patterns.
 *   - Lists are conservative: only families where the relationship to the
 *     event type is plausible to a health-literate user.
 *   - 'user_defined' is empty because the type is too generic to infer relevance.
 *
 * Examples of what fires / what does not:
 *   illness     active + workoutDurationMin→readiness:  input=activity ✓  bonus
 *   illness     active + caffeineMg→readiness:          input=caffeine ✗  output=recovery ✓  bonus
 *   training_block + totalAlcoholDrinks→readiness:      input=alcohol ✗   output=recovery ✓  bonus (marginal; acceptable)
 *   user_defined + any pattern:                         no bonus (empty list)
 *
 * Known limitation: checking both input AND output families means some marginally
 * relevant combinations receive the bonus (e.g., caffeine during illness via output=recovery).
 * The bonus (+8 pts) is small relative to cross-domain (+15) and cross-provider (+20)
 * bonuses, so false-positive boosts rarely affect final ordering.
 */
export const EVENT_SIGNAL_RELEVANCE: Record<string, string[]> = {
  illness:          ['recovery', 'sleep_quality', 'activity'],
  vacation:         ['sleep_quality', 'activity', 'recovery'],
  travel:           ['sleep_quality', 'activity', 'recovery'],
  alcohol_period:   ['alcohol', 'sleep_quality', 'recovery'],
  training_block:   ['activity', 'recovery', 'sleep_quality'],
  stressful_period: ['recovery', 'sleep_quality', 'oura_stress'],
  cycle_phase:      ['recovery', 'sleep_quality'],
  user_defined:     [],
};

/** Human-readable source labels for display in "Based on:" provenance UI. */
export const SOURCE_LABELS: Record<SourceName, string> = {
  oura_sleep:               'Oura Sleep',
  oura_hrv:                 'Oura HRV',
  oura_readiness:           'Oura Readiness',
  oura_activity:            'Oura Activity',
  apple_health_workouts:    'Apple Health Workouts',
  apple_health_steps:       'Apple Health Steps',
  apple_health_water:       'Apple Health Water',
  bellahealth_drink_log:    'BellaHealth Drinking Log',
  bellahealth_caffeine:     'BellaHealth Caffeine Log',
  bellahealth_nutrition:    'BellaHealth Nutrition',
  bellahealth_context_event:'BellaHealth Context Event',
  oura_stress:              'Oura Stress',
};

// ─── Relationship definition ───────────────────────────────────────────────────

export interface RelationshipDefinition {
  id: string;
  description: string;
  inputSignal: SignalKey;
  outcomeSignal: SignalKey;
  temporalRelationship: TemporalRelationship;
  /** How to split input values into condition-met vs baseline groups */
  conditionType: ConditionType;
  inputSources: SourceName[];
  outcomeSources: SourceName[];
  /** Minimum number of valid day-pairs to produce a result above INSUFFICIENT */
  minDayPairs: number;
  /** Explicit temporal mapping — documents what each date offset means */
  temporalNote: string;
  /** Whether to include in cross-signal synthesis (false = tracked but not surfaced) */
  includeInSynthesis: boolean;
}

// ─── Registry ─────────────────────────────────────────────────────────────────

export const RELATIONSHIP_REGISTRY: RelationshipDefinition[] = [

  // ── Sleep quality → same-day recovery signals ──────────────────────────────
  // Oura reports sleep, HRV, and readiness on the same wakeup date — they all
  // reflect the same overnight sleep period. These are same_day relationships.
  {
    id: 'sleep_hours_readiness',
    description: 'Sleep duration and same-day readiness score',
    inputSignal: 'sleepHours',
    outcomeSignal: 'readiness',
    temporalRelationship: 'same_day',
    conditionType: 'median_split',
    inputSources: ['oura_sleep'],
    outcomeSources: ['oura_readiness'],
    minDayPairs: 7,
    temporalNote: 'Oura sleep hours and readiness share the same wakeup date — both reflect the same overnight sleep period.',
    includeInSynthesis: true,
  },
  {
    id: 'sleep_score_readiness',
    description: 'Sleep quality score and same-day readiness',
    inputSignal: 'sleepScore',
    outcomeSignal: 'readiness',
    temporalRelationship: 'same_day',
    conditionType: 'median_split',
    inputSources: ['oura_sleep'],
    outcomeSources: ['oura_readiness'],
    minDayPairs: 7,
    temporalNote: 'Same wakeup date. Sleep score and readiness both reflect the same overnight sleep period.',
    includeInSynthesis: false, // sleep_hours_readiness is primary; avoid duplicate
  },
  {
    id: 'sleep_hours_hrv',
    description: 'Sleep duration and same-day HRV',
    inputSignal: 'sleepHours',
    outcomeSignal: 'hrv',
    temporalRelationship: 'same_day',
    conditionType: 'median_split',
    inputSources: ['oura_sleep'],
    outcomeSources: ['oura_hrv'],
    minDayPairs: 7,
    temporalNote: 'Oura HRV is measured during sleep and reported on the wakeup date alongside sleep hours.',
    includeInSynthesis: true,
  },

  // ── Sleep quality → next-day carryover ────────────────────────────────────
  // For carryover effects: how does sleep on morning of day N affect the
  // morning of day N+1? Requires consecutive days in the timeline.
  {
    id: 'sleep_score_next_readiness',
    description: 'Sleep score on day N and readiness on day N+1',
    inputSignal: 'sleepScore',
    outcomeSignal: 'readiness',
    temporalRelationship: 'next_day',
    conditionType: 'median_split',
    inputSources: ['oura_sleep'],
    outcomeSources: ['oura_readiness'],
    minDayPairs: 14,
    temporalNote: 'Sleep score on morning of day N compared with readiness on morning of day N+1. Looks for multi-day recovery carryover.',
    includeInSynthesis: false, // same-day version already covers this; suppress duplicate
  },

  // ── Workout load → next-day recovery ──────────────────────────────────────
  // Workout on day N → recovery signals on day N+1 (the following morning).
  // Duration is a reasonable proxy for load without needing heart-rate data.
  {
    id: 'workout_duration_next_readiness',
    description: 'Workout duration and next-day readiness',
    inputSignal: 'workoutDurationMin',
    outcomeSignal: 'readiness',
    temporalRelationship: 'next_day',
    conditionType: 'median_split',
    inputSources: ['apple_health_workouts'],
    outcomeSources: ['oura_readiness'],
    minDayPairs: 7,
    temporalNote: 'Apple Health workout minutes on day N compared with Oura readiness on morning of day N+1.',
    includeInSynthesis: true,
  },
  {
    id: 'workout_duration_next_hrv',
    description: 'Workout duration and next-day HRV',
    inputSignal: 'workoutDurationMin',
    outcomeSignal: 'hrv',
    temporalRelationship: 'next_day',
    conditionType: 'median_split',
    inputSources: ['apple_health_workouts'],
    outcomeSources: ['oura_hrv'],
    minDayPairs: 7,
    temporalNote: 'Apple Health workout minutes on day N compared with Oura HRV on morning of day N+1.',
    includeInSynthesis: true,
  },

  // ── Daily activity → following-night sleep ────────────────────────────────
  // Steps on day N → sleep starting night of N, reported morning of N+1.
  {
    id: 'steps_next_sleep_hours',
    description: 'Daily steps and following-night sleep duration',
    inputSignal: 'steps',
    outcomeSignal: 'sleepHours',
    temporalRelationship: 'next_day',
    conditionType: 'median_split',
    inputSources: ['apple_health_steps', 'oura_activity'],
    outcomeSources: ['oura_sleep'],
    minDayPairs: 10,
    temporalNote: 'Step count on day N compared with sleep hours on morning of day N+1 (the night following the active day).',
    includeInSynthesis: true,
  },

  // NOTE: totalAlcoholDrinks is intentionally NOT registered here.
  // Like caffeine, a single drinking occasion is meaningful context for Claude
  // (e.g. one night of drinks → poor sleep/HRV) without requiring repeated
  // occurrences. It exists in HealthDayRecord and flows through the timeline.

  // ── Hydration → recovery ──────────────────────────────────────────────────
  {
    id: 'water_next_readiness',
    description: 'Daily water intake and next-day readiness',
    inputSignal: 'waterOz',
    outcomeSignal: 'readiness',
    temporalRelationship: 'next_day',
    conditionType: 'median_split',
    inputSources: ['apple_health_water'],
    outcomeSources: ['oura_readiness'],
    minDayPairs: 7,
    temporalNote: 'Water intake on day N compared with Oura readiness on morning of day N+1.',
    includeInSynthesis: true,
  },

  // ── Nutrition → next-day recovery and sleep ────────────────────────────────
  // Meals logged on day N → Oura recovery/sleep on morning of day N+1.
  // All use median_split: higher vs lower intake days compared against
  // next-morning recovery signals.
  {
    id: 'calories_next_readiness',
    description: 'Calorie intake and next-day readiness',
    inputSignal: 'calories',
    outcomeSignal: 'readiness',
    temporalRelationship: 'next_day',
    conditionType: 'median_split',
    inputSources: ['bellahealth_nutrition'],
    outcomeSources: ['oura_readiness'],
    minDayPairs: 7,
    temporalNote: 'Dietary calories logged on day N compared with Oura readiness on morning of day N+1.',
    includeInSynthesis: true,
  },
  {
    id: 'calories_next_sleep_hours',
    description: 'Calorie intake and following-night sleep duration',
    inputSignal: 'calories',
    outcomeSignal: 'sleepHours',
    temporalRelationship: 'next_day',
    conditionType: 'median_split',
    inputSources: ['bellahealth_nutrition'],
    outcomeSources: ['oura_sleep'],
    minDayPairs: 7,
    temporalNote: 'Dietary calories logged on day N compared with Oura sleep hours on morning of day N+1.',
    includeInSynthesis: true,
  },
  {
    id: 'protein_next_readiness',
    description: 'Protein intake and next-day readiness',
    inputSignal: 'protein',
    outcomeSignal: 'readiness',
    temporalRelationship: 'next_day',
    conditionType: 'median_split',
    inputSources: ['bellahealth_nutrition'],
    outcomeSources: ['oura_readiness'],
    minDayPairs: 7,
    temporalNote: 'Dietary protein logged on day N compared with Oura readiness on morning of day N+1.',
    includeInSynthesis: true,
  },
  {
    id: 'protein_next_hrv',
    description: 'Protein intake and next-day HRV',
    inputSignal: 'protein',
    outcomeSignal: 'hrv',
    temporalRelationship: 'next_day',
    conditionType: 'median_split',
    inputSources: ['bellahealth_nutrition'],
    outcomeSources: ['oura_hrv'],
    minDayPairs: 7,
    temporalNote: 'Dietary protein logged on day N compared with Oura HRV on morning of day N+1.',
    includeInSynthesis: true,
  },
  {
    id: 'carbs_next_sleep_hours',
    description: 'Carbohydrate intake and following-night sleep duration',
    inputSignal: 'carbs',
    outcomeSignal: 'sleepHours',
    temporalRelationship: 'next_day',
    conditionType: 'median_split',
    inputSources: ['bellahealth_nutrition'],
    outcomeSources: ['oura_sleep'],
    minDayPairs: 7,
    temporalNote: 'Dietary carbs logged on day N compared with Oura sleep hours on morning of day N+1.',
    includeInSynthesis: true,
  },
  {
    id: 'carbs_next_readiness',
    description: 'Carbohydrate intake and next-day readiness',
    inputSignal: 'carbs',
    outcomeSignal: 'readiness',
    temporalRelationship: 'next_day',
    conditionType: 'median_split',
    inputSources: ['bellahealth_nutrition'],
    outcomeSources: ['oura_readiness'],
    minDayPairs: 7,
    temporalNote: 'Dietary carbs logged on day N compared with Oura readiness on morning of day N+1.',
    includeInSynthesis: false, // calories_next_readiness is the primary caloric intake → recovery signal
  },
  {
    id: 'fat_next_readiness',
    description: 'Fat intake and next-day readiness',
    inputSignal: 'fat',
    outcomeSignal: 'readiness',
    temporalRelationship: 'next_day',
    conditionType: 'median_split',
    inputSources: ['bellahealth_nutrition'],
    outcomeSources: ['oura_readiness'],
    minDayPairs: 7,
    temporalNote: 'Dietary fat logged on day N compared with Oura readiness on morning of day N+1.',
    includeInSynthesis: true,
  },
  {
    id: 'fat_next_hrv',
    description: 'Fat intake and next-day HRV',
    inputSignal: 'fat',
    outcomeSignal: 'hrv',
    temporalRelationship: 'next_day',
    conditionType: 'median_split',
    inputSources: ['bellahealth_nutrition'],
    outcomeSources: ['oura_hrv'],
    minDayPairs: 7,
    temporalNote: 'Dietary fat logged on day N compared with Oura HRV on morning of day N+1.',
    includeInSynthesis: false, // protein_next_hrv is the primary nutrition → HRV signal
  },

  // ── Alcohol → next-day recovery ──────────────────────────────────────────
  // Uses nonzero condition: any-drinks days vs no-drinks days.
  // The question is "does drinking at all change your next-morning recovery?"
  // rather than "does drinking more than average change it?"
  {
    id: 'alcohol_drinks_next_readiness',
    description: 'Alcohol consumption and next-day readiness',
    inputSignal: 'totalAlcoholDrinks',
    outcomeSignal: 'readiness',
    temporalRelationship: 'next_day',
    conditionType: 'nonzero',
    inputSources: ['bellahealth_drink_log'],
    outcomeSources: ['oura_readiness'],
    minDayPairs: 7,
    temporalNote: 'Drinks logged on day N compared with Oura readiness on morning of day N+1.',
    includeInSynthesis: true,
  },
  {
    id: 'alcohol_drinks_next_hrv',
    description: 'Alcohol consumption and next-day HRV',
    inputSignal: 'totalAlcoholDrinks',
    outcomeSignal: 'hrv',
    temporalRelationship: 'next_day',
    conditionType: 'nonzero',
    inputSources: ['bellahealth_drink_log'],
    outcomeSources: ['oura_hrv'],
    minDayPairs: 7,
    temporalNote: 'Drinks logged on day N compared with Oura HRV on morning of day N+1.',
    includeInSynthesis: true,
  },

  // ── Caffeine → next-night sleep quality ──────────────────────────────────
  // Uses median_split: higher-caffeine days vs lower-caffeine days.
  // Not nonzero — many people have caffeine daily, so the question is
  // "does more caffeine correlate with worse sleep?" not "coffee vs. no coffee."
  {
    id: 'caffeine_next_sleep_score',
    description: 'Caffeine intake and following-night sleep quality',
    inputSignal: 'caffeineMg',
    outcomeSignal: 'sleepScore',
    temporalRelationship: 'next_day',
    conditionType: 'median_split',
    inputSources: ['bellahealth_caffeine'],
    outcomeSources: ['oura_sleep'],
    minDayPairs: 7,
    temporalNote: 'Caffeine logged on day N compared with Oura sleep score on morning of day N+1.',
    includeInSynthesis: true,
  },

  // ── Electrolytes → next-day readiness ────────────────────────────────────
  // Uses nonzero condition: electrolyte-logged days vs. non-logged days.
  // Binary signal (logged or not) rather than a dose quantity.
  {
    id: 'electrolytes_next_readiness',
    description: 'Electrolyte supplementation and next-day readiness',
    inputSignal: 'electrolytesLogged',
    outcomeSignal: 'readiness',
    temporalRelationship: 'next_day',
    conditionType: 'nonzero',
    inputSources: ['bellahealth_drink_log'],
    outcomeSources: ['oura_readiness'],
    minDayPairs: 7,
    temporalNote: 'Electrolytes logged on day N compared with Oura readiness on morning of day N+1.',
    includeInSynthesis: true,
  },

  // ── Gratitude practice → next-day readiness ───────────────────────────────
  // next_day is more valid than same_day: readiness reflects last night's sleep,
  // not today's practice. The causal direction (gratitude → sleep quality →
  // readiness) operates overnight.
  {
    id: 'gratitude_next_readiness',
    description: 'Gratitude practice and next-day readiness',
    inputSignal: 'gratitudeSessions',
    outcomeSignal: 'readiness',
    temporalRelationship: 'next_day',
    conditionType: 'nonzero',
    inputSources: ['bellahealth_drink_log'],
    outcomeSources: ['oura_readiness'],
    minDayPairs: 7,
    temporalNote: 'Gratitude sessions logged on day N compared with Oura readiness on morning of day N+1.',
    includeInSynthesis: true,
  },

  // ── Oura daily stress → next-day recovery ────────────────────────────────
  // High physiological stress on day N → recovery signals on morning of day N+1.
  // Both use median_split: higher vs lower stress/recovery days.
  // Registered as same family ('oura_stress') — deduplication suppresses one
  // when both fire with the same directional conclusion.
  {
    id: 'stress_high_min_next_readiness',
    description: 'High-stress minutes and next-day readiness',
    inputSignal: 'stressHighMinutes',
    outcomeSignal: 'readiness',
    temporalRelationship: 'next_day',
    conditionType: 'median_split',
    inputSources: ['oura_stress'],
    outcomeSources: ['oura_readiness'],
    minDayPairs: 7,
    temporalNote: 'Oura high-stress minutes on day N compared with readiness on morning of day N+1.',
    includeInSynthesis: true,
  },
  {
    id: 'stress_high_min_next_hrv',
    description: 'High-stress minutes and next-day HRV',
    inputSignal: 'stressHighMinutes',
    outcomeSignal: 'hrv',
    temporalRelationship: 'next_day',
    conditionType: 'median_split',
    inputSources: ['oura_stress'],
    outcomeSources: ['oura_hrv'],
    minDayPairs: 7,
    temporalNote: 'Oura high-stress minutes on day N compared with HRV on morning of day N+1.',
    includeInSynthesis: false, // stress_high_min_next_readiness is the primary signal
  },
  {
    id: 'recovery_high_min_next_readiness',
    description: 'High restorative minutes and next-day readiness',
    inputSignal: 'recoveryHighMinutes',
    outcomeSignal: 'readiness',
    temporalRelationship: 'next_day',
    conditionType: 'median_split',
    inputSources: ['oura_stress'],
    outcomeSources: ['oura_readiness'],
    minDayPairs: 7,
    temporalNote: 'Oura high-recovery minutes on day N compared with readiness on morning of day N+1.',
    includeInSynthesis: false, // stress_high_min_next_readiness is primary; same-family deduplication
  },
  {
    id: 'recovery_high_min_next_hrv',
    description: 'High restorative minutes and next-day HRV',
    inputSignal: 'recoveryHighMinutes',
    outcomeSignal: 'hrv',
    temporalRelationship: 'next_day',
    conditionType: 'median_split',
    inputSources: ['oura_stress'],
    outcomeSources: ['oura_hrv'],
    minDayPairs: 7,
    temporalNote: 'Oura high-recovery minutes on day N compared with HRV on morning of day N+1.',
    includeInSynthesis: true,
  },

  // NOTE: hasSaunaSession, hasColdPlungeSession are intentionally NOT registered
  // here. These are too occasional for 7+ paired observations to accumulate.
  // A single sauna session is meaningful context for Claude but does not require
  // statistical frequency to be relevant. Add registry entries if the user
  // accumulates enough consistent data to warrant pattern detection.
];
