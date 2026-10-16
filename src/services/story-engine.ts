/**
 * story-engine.ts
 *
 * Structured intermediate representation for "Your Story" health narratives.
 *
 * INTERPRET FIRST, RENDER SECOND.
 *
 * Converts raw health data (timeline, event windows, synthesis) into a
 * StoryEpisode — a structured object describing what happened, what
 * behaviors were present, how the body responded vs personal baseline,
 * and where the body appears to be heading.
 *
 * Language rendering lives in pattern-language.ts.
 * No LLM calls. Entirely deterministic. Missing data ≠ 0.
 */

import type { HealthDayRecord, EventWindowAnalysis, PeriodStats, PatternResult, ConfidenceTier } from './pattern-engine';
import type { SynthesisResult } from './context-synthesis';
import type { ContextEvent } from './context-events';
import type { SignalKey } from './pattern-registry';
import type { DowPatternResult } from './dow-pattern-engine';
import type { PatternObservationNote } from './pattern-observation-store';

// ─── Evidence Strength ─────────────────────────────────────────────────────────

/**
 * How strong is the evidence for a claimed association?
 *
 *   isolated_coincidence      — 1 observed pairing; describe but never imply repetition
 *   weak_association          — 2–3 pairings; hedged language ("a couple of times…")
 *   repeated_pattern          — 4+ pairings, consistent direction; "tends to…"
 *   strong_contextual_pattern — event-window analysis + pattern detection both agree
 */
export type EvidenceStrength =
  | 'isolated_coincidence'
  | 'weak_association'
  | 'repeated_pattern'
  | 'strong_contextual_pattern';

export interface StoryEvidence {
  strength: EvidenceStrength;
  occurrenceCount: number;
}

// ─── Story layer types ─────────────────────────────────────────────────────────

export interface MetricFinding {
  /** Display label, e.g. "HRV", "Sleep", "Readiness" */
  metric: string;
  direction: 'above_baseline' | 'below_baseline' | 'near_baseline';
  magnitude: 'mild' | 'moderate' | 'substantial';
  actual: number;
  /** Personal median across available timeline history */
  baseline: number;
}

/** Layer 1 — The life context event (travel, illness, stress, training) */
export interface ContextEventLayer {
  eventType: string;
  eventLabel: string;
  isOngoing: boolean;
  durationDays: number;
  /** Metrics that changed meaningfully during the event vs. the pre-event window */
  metricChanges: Array<{
    metric: string;
    direction: 'lower' | 'higher';
    preValue: number;
    duringValue: number;
  }>;
  /** True when preWindow + duringWindow have enough days and at least one metric changed */
  hasEnoughEvidence: boolean;
}

/** Layer 2 — A behavioral input with its observed physiological association */
export interface BehavioralFinding {
  behaviorType:
    | 'alcohol'
    | 'caffeine'
    | 'sauna'
    | 'cold_plunge'
    | 'gratitude'
    | 'electrolytes'
    | 'water';
  behaviorLabel: string;
  outcomeMetric: string;
  outcomeDirection: 'better' | 'worse';
  timeRelationship: 'same_day' | 'next_day';
  evidence: StoryEvidence;
}

/** Layer 3 — How the body is doing today vs personal baseline */
export interface PhysiologicalStateLayer {
  findings: MetricFinding[];
  /** True if some metrics are above baseline while others are below */
  conflicting: boolean;
}

/** Layer 4 — Temporal bridge between two adjacent events */
export interface TransitionLayer {
  precedingEventType: string;
  precedingEventLabel: string;
  currentEventType: string;
  currentEventLabel: string;
  gapDays: number;
  /** Metric changes observed during the preceding event (max 2, deduplicated) */
  precedingMetricChanges: Array<{ metric: string; direction: 'lower' | 'higher' }>;
}

/** Layer 5 — Where the body appears to be heading */
export interface CurrentDirectionLayer {
  trajectory: 'recovering' | 'declining' | 'stable' | 'disrupted' | 'insufficient_data';
  improvingMetrics: string[];
  belowBaselineMetrics: string[];
  /** How many recent days informed this assessment */
  recentDays: number;
}

// ─── Nutrition types ───────────────────────────────────────────────────────────

/**
 * Completeness evidence for nutrition data.
 *
 * CRITICAL: missing or low-calorie days NEVER mean the user ate less —
 * they mean the user logged less. Only surface nutrition patterns when
 * logging coverage is sufficient to support the claim.
 *
 * A day "has logging" if calories ≥ MIN_LOGGED_CALORIES (proxy for credible log).
 */
export interface NutritionEvidence {
  /** Days where calories >= MIN_LOGGED_CALORIES */
  daysWithLogging: number;
  totalDays: number;
  /** Fraction of days with credible nutrition logging */
  loggingRate: number;
  /**
   * Confidence in the nutrition data quality:
   *   insufficient — < 7 logged days or < 30% rate; never surface claims
   *   low          — 7–13 days or 30–59% rate; suppress most claims
   *   moderate     — ≥ 14 logged days AND ≥ 60% rate; safe to surface patterns
   */
  confidence: 'insufficient' | 'low' | 'moderate';
}

/**
 * A single nutrition-related observation.
 *
 * Only generated when loggingEvidence.confidence = 'moderate'.
 * Language must be purely observational — never deficiency or causal claims.
 * All comparisons are relative (high-logging days vs lower-logging days),
 * never absolute thresholds.
 */
export interface NutritionFinding {
  signal: 'protein' | 'calories';
  signalLabel: string;
  outcomeMetric: string;
  outcomeDirection: 'better' | 'worse';
  timeRelationship: 'same_day' | 'next_day';
  evidence: StoryEvidence;
}

/** Layer 6 — Nutrition context with completeness-gated findings */
export interface NutritionLayer {
  loggingEvidence: NutritionEvidence;
  /** Only populated when confidence = 'moderate' and meaningful patterns exist */
  findings: NutritionFinding[];
}

// ─── HydrationContext ──────────────────────────────────────────────────────────

/**
 * Hydration tracking coverage over a relevant window.
 *
 * CRITICAL: not_tracked means NO DATA — never render as "didn't drink enough."
 * below_target means logged intake was below the user's personal baseline mean.
 * adequate means logged intake was at or above baseline.
 * Missing waterOz ≠ zero intake. Unlogged days are excluded from the comparison.
 */
export interface HydrationContext {
  status: 'not_tracked' | 'below_target' | 'adequate';
  /** Days in the window where waterOz was logged (non-undefined) */
  loggedDaysInWindow: number;
  windowDays: number;
  /** loggedDaysInWindow / windowDays */
  coverageRate: number;
  /** Number of logged completed days where waterOz was below the target (goal or baseline mean). */
  daysBelow?: number;
  /** The water goal in oz used for comparison. Null when baseline mean was used instead. */
  goalOz?: number | null;
}

// ─── InterpretationLayer ───────────────────────────────────────────────────────

/**
 * Multi-signal inference about a health pattern.
 *
 * Only populated when 2+ signals agree. Purely observational — no causation claims.
 * "that combination may have added strain" is the ceiling of inference.
 *
 *   strain_accumulation — load signals (travel/training) preceded illness/stress
 *   routine_disruption  — travel with 2+ metric changes (expected disruption)
 *   behavioral_cluster  — 2+ behavioral findings pointing to the same outcome
 */
export interface InterpretationLayer {
  connectionType: 'strain_accumulation' | 'routine_disruption' | 'behavioral_cluster';
  /** Physiological / load signals that changed meaningfully */
  loadSignals: string[];
  /** Behavioral signals observed in the same window */
  behaviorSignals: string[];
  /** The outcome event type (e.g. "illness"), or "" when no outcome event */
  outcomeEventType: string;
  hasInterpretation: boolean;
}

// ─── AftermathLayer ────────────────────────────────────────────────────────────

export interface AftermathObservation {
  signal: string;
  direction: 'higher' | 'lower';
  /** True when the direction is recovery-aligned for this event type */
  isRecoveryAligned: boolean;
}

/**
 * What the data shows in the days after a completed event.
 * Only populated for non-ongoing events with sufficient post-event timeline data.
 */
export interface AftermathLayer {
  observations: AftermathObservation[];
  /** Number of post-event days that informed this assessment */
  postEventDays: number;
  hasEvidence: boolean;
}

// ─── NextFocusLayer ────────────────────────────────────────────────────────────

export interface NextFocusPriority {
  area: string;
  rationale: string;
}

/**
 * 1–3 specific, evidence-grounded priorities.
 * NEVER generic boilerplate. Only surface when existing data supports the claim.
 */
export interface NextFocusLayer {
  priorities: NextFocusPriority[];
  context: 'recovery' | 'travel' | 'training' | 'stress' | 'general';
  hasRecommendation: boolean;
}

// ─── FutureLessonLayer ─────────────────────────────────────────────────────────

/**
 * A forward-looking observation drawn from a completed event.
 * "On your next trip..." — only when the event had clear metric changes.
 */
export interface FutureLessonLayer {
  eventType: string;
  /** Signals to watch on the next similar event (they dropped during this one) */
  monitorSignals: string[];
  /** Signals that stayed stable or improved (potentially protective) */
  protectSignals: string[];
  hasLesson: boolean;
}

// ─── ContextResponseContrastLayer ─────────────────────────────────────────────

/**
 * How physiology responded (or didn't) to a meaningful life/routine context.
 *   stable    — ≥2 tracked metrics stayed near personal baseline despite context
 *   responding — ≥1 tracked metric is notably off baseline while context is active
 */
export type PhysioResponseState = 'stable' | 'responding';

/**
 * A context-response contrast story.
 *
 * Fires when:
 *   1. A single meaningful life/routine event is active/recent
 *   2. Personal physiological baseline data exists (≥7 samples)
 *   3. Physiology has either stayed surprisingly close to baseline (stable)
 *      or moved notably while the context was active (responding)
 *
 * For the stable case: requires measurable behavioral disruption to avoid
 * manufacturing profundity from an ordinary healthy day.
 *
 * Never claims causation. Context is framing, not explanation.
 */
export interface ContextResponseContrastLayer {
  /**
   * The category of life context driving this story.
   * 'training_elevated' is special: elevated workout time with a perf goal,
   * not a logged ContextEvent.
   */
  contextType:
    | 'travel'
    | 'illness'
    | 'stressful_period'
    | 'alcohol_night'       // single-day: alcohol event from previous night
    | 'sleep_activity'      // notably short sleep + qualifying workout today (no alcohol/event needed)
    | 'training_elevated'   // workout time elevated above personal median
    | 'training_block'      // user-logged training block event
    | 'user_defined';       // user-named life event
  /** Human-readable label for the context */
  contextLabel: string;
  /** Whether physiology held near baseline or moved notably */
  physioResponse: PhysioResponseState;
  /**
   * Behavioral metric changes that demonstrate disruption (from contextEventLayer).
   * Empty for 'illness' (inherently meaningful without behavioral proof).
   * Empty for 'alcohol_night' (the disruption is the night itself).
   * Empty for 'training_elevated' (the elevated workouts IS the behavioral signal).
   */
  behavioralDisruptions: Array<{ metric: string; direction: 'lower' | 'higher' }>;
  /**
   * Physiology findings relevant to this story.
   * For 'stable': the near_baseline findings (shows what held).
   * For 'responding': the off-baseline findings with moderate/substantial magnitude.
   */
  physioFindings: MetricFinding[];
  /** Training/race goal type when relevant ('marathon', '5k', 'strength', 'sport', null) */
  perfGoal: string | null;
  /**
   * True when training is elevated simultaneously with another context type
   * (illness, travel, or sustained stress). Rendering acknowledges the complexity.
   */
  hasCompetingContext: boolean;
  /** Whether the triggering event is still ongoing */
  isOngoing: boolean;
  /**
   * Stable key used for once-per-change suppression.
   * Format: `{eventId}_{physioResponse}` | `alcohol_{date}_{physioResponse}` | `training_{weekStart}_{physioResponse}`
   */
  suppressionKey: string;
  /**
   * Today's total workout duration in minutes.
   * Populated for alcohol_night only — allows the renderer to weave same-day
   * activity into the story without requiring a separate gate.
   * Gates decide whether BellaHealth speaks; this lets it describe the full picture.
   */
  todayActivityMin?: number;
  /** Primary activity type today (e.g. "Running"), for natural language in the activity note. */
  todayActivityType?: string;
  /**
   * Hydration context from the completed-days window.
   * Only populated for alcohol_night and sleep_activity — used to enrich the story
   * with a neutral observation when hydration has been running low lately.
   */
  hydrationContext?: HydrationContext | null;
  /**
   * Number of drinks logged for the relevant night (alcohol_night only).
   * Used by the synthesis renderer to make the story specific without needing
   * the caller to re-read the drink log. Undefined for all other context types.
   */
  drinkCount?: number;
}

// ─── Confirmed pattern finding ─────────────────────────────────────────────────

/**
 * A confirmed relationship from the pattern engine that is relevant to today's
 * physiology. Used as evidence for Your Story only when:
 *   1. The pattern has sufficient confidence (PATTERN or CONSISTENT tier — the
 *      same tiers shown in What's Connected).
 *   2. Today's outcome metric is meaningfully off-baseline (moderate or substantial
 *      magnitude). A pattern idling on an ordinary day is What's Connected territory.
 *
 * This is a read-only bridge into the pattern engine — the engine is not changed.
 * Never claims causation; observational language only.
 */
export interface ConfirmedPatternFinding {
  /** The pattern's input signal key (e.g. 'workoutDurationMin') */
  inputSignal:  SignalKey;
  /** The pattern's outcome signal key (e.g. 'hrv') */
  outcomeSignal: SignalKey;
  /** Human-readable label for the input (e.g. "Time spent training") */
  inputLabel:  string;
  /** Human-readable label for the outcome (e.g. "HRV") */
  outcomeLabel: string;
  /** What the pattern shows: input → better outcome (positive) or worse (negative) */
  patternDirection: 'positive' | 'negative';
  /** Today's outcome vs personal baseline — always above or below (never near) */
  todayOutcomeDirection: 'above_baseline' | 'below_baseline';
  /** How far today is from baseline */
  todayOutcomeMagnitude: 'moderate' | 'substantial';
  /** Today's raw value */
  todayOutcomeValue: number;
  /** Personal baseline median for the outcome metric */
  baselineValue: number;
  /** Number of observations supporting the pattern */
  observationCount: number;
  /** Confidence tier (PATTERN or CONSISTENT) */
  confidenceTier: ConfidenceTier;
}

// ─── DowObservationLayer ───────────────────────────────────────────────────────

/**
 * A single day-of-week pattern surfaced for user reflection.
 * Only present when the pattern meets full evidence gates (EARLY or above)
 * and the note has not already been answered or dismissed.
 */
export interface DowObservation {
  pattern: DowPatternResult;
  note: PatternObservationNote;
}

/**
 * Day-of-week recurring pattern observations for Your Story.
 *
 * Populated when detectDowPatterns() returns qualifying results AND at least
 * one pending, unanswered note exists. At most 2 observations are surfaced
 * at once (highest-strength first, one per signal family to avoid redundancy).
 *
 * When hasObservations is false this layer is absent from render —
 * no empty UI is ever shown.
 */
export interface DowObservationLayer {
  observations: DowObservation[];
  hasObservations: boolean;
}

// ─── StoryEpisode ──────────────────────────────────────────────────────────────

export interface StoryEpisode {
  contextEvent:        ContextEventLayer | null;
  behavioralFindings:  BehavioralFinding[];
  physiologicalState:  PhysiologicalStateLayer | null;
  transition:          TransitionLayer | null;
  currentDirection:    CurrentDirectionLayer | null;
  /** Completeness-gated nutrition observations. Null when no nutrition data exists. */
  nutritionLayer:      NutritionLayer | null;
  /** Hydration coverage over the relevant window. Null when no event and no recent data. */
  hydrationContext:    HydrationContext | null;
  /** Multi-signal cautious inference. Null when insufficient signals agree. */
  interpretation:      InterpretationLayer | null;
  /** Post-event recovery signals. Null for ongoing events or insufficient data. */
  aftermath:           AftermathLayer | null;
  /** Evidence-grounded next priorities. Null when no data supports a recommendation. */
  nextFocus:           NextFocusLayer | null;
  /** Forward-looking lesson for the next similar event. Null for ongoing events. */
  futureLesson:        FutureLessonLayer | null;
  /**
   * Context-response contrast story. Populated when a meaningful life/routine
   * event is active and physiological baseline data allows a responsible comparison.
   * Null when the 4 core evidence gates fired (those take priority).
   */
  contextResponseContrast: ContextResponseContrastLayer | null;
  /**
   * Confirmed-pattern bridge story. Populated when a pattern-engine relationship
   * with PATTERN or CONSISTENT confidence has today's outcome metric meaningfully
   * off-baseline. Null when core gates or contrast gate fired (those take priority).
   * Also null when today's physiology is unremarkable (near baseline).
   */
  confirmedPatternLayer: ConfirmedPatternFinding | null;
  /**
   * Established-pattern finding for synthesis augmentation.
   * Unlike confirmedPatternLayer (which is a standalone story), this is computed
   * even when contextResponseContrast fires — allowing alcohol_night and
   * sleep_activity synthesis to reference a known pattern when today's data matches.
   * Null when surfaceWorthyCore fires, when no confirmed pattern matches today's
   * physiology, or when physiologicalState has fewer than 2 findings.
   */
  contextualPattern: ConfirmedPatternFinding | null;
  /**
   * Day-of-week recurring pattern observations. Null when no qualifying
   * patterns exist or all have already been answered/dismissed.
   * Never adds empty UI — only populated with actionable pending observations.
   */
  dowObservations: DowObservationLayer | null;
  /**
   * True when at least one layer has non-trivial evidence.
   * The renderer should only produce output when surfaceWorthy = true.
   */
  surfaceWorthy: boolean;
  /**
   * True if surfaceWorthy via the original 4 evidence gates only.
   * False when the story surfaces only through the contrast or pattern gate.
   * Useful for suppression: contrast-only stories can be held back once shown.
   */
  surfaceWorthyCore: boolean;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

interface PersonalBaseline {
  mean:        number;
  median:      number;
  p25:         number;
  p75:         number;
  sampleCount: number;
}

function nextDateStr(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00Z');
  if (isNaN(d.getTime())) return dateStr;
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split('T')[0];
}

function addDaysToStr(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T12:00:00Z');
  if (isNaN(d.getTime())) return dateStr;
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split('T')[0];
}

function daysBetweenDates(a: string, b: string): number {
  const tA = new Date(a + 'T12:00:00Z').getTime();
  const tB = new Date(b + 'T12:00:00Z').getTime();
  return Math.round(Math.abs(tB - tA) / 86_400_000);
}

const EVENT_DISPLAY_LABEL: Record<string, string> = {
  travel:           'Travel',
  vacation:         'Travel',
  illness:          'Illness',
  stressful_period: 'Stressful period',
  training_block:   'Training block',
  alcohol_period:   'Drinking period',
  cycle_phase:      'Cycle phase',
  user_defined:     'Life event',
};

function displayEventLabel(type: string, label?: string): string {
  return label ?? EVENT_DISPLAY_LABEL[type] ?? 'Life event';
}

function evidenceStrengthForCount(count: number): EvidenceStrength {
  if (count >= 4) return 'repeated_pattern';
  if (count >= 2) return 'weak_association';
  return 'isolated_coincidence';
}

function computeMetricBaseline(
  timeline: HealthDayRecord[],
  getter: (d: HealthDayRecord) => number | undefined,
): PersonalBaseline | null {
  const values = timeline
    .map(getter)
    .filter((v): v is number => v !== undefined && v > 0);

  if (values.length < 5) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return {
    mean:        sorted.reduce((s, x) => s + x, 0) / n,
    median:      sorted[Math.floor(n / 2)],
    p25:         sorted[Math.floor(n * 0.25)],
    p75:         sorted[Math.floor(n * 0.75)],
    sampleCount: n,
  };
}

function classifyVsBaseline(
  actual: number,
  baseline: PersonalBaseline,
): Pick<MetricFinding, 'direction' | 'magnitude'> {
  const iqr = Math.max(baseline.p75 - baseline.p25, 1);

  let direction: MetricFinding['direction'];
  if (actual < baseline.p25) direction = 'below_baseline';
  else if (actual > baseline.p75) direction = 'above_baseline';
  else direction = 'near_baseline';

  const absDist = Math.abs(actual - baseline.median);
  let magnitude: MetricFinding['magnitude'];
  if (absDist > iqr) magnitude = 'substantial';
  else if (absDist > iqr * 0.4) magnitude = 'moderate';
  else magnitude = 'mild';

  return { direction, magnitude };
}

// ─── Period diff thresholds (local copy to avoid circular import) ─────────────

const PERIOD_DIFF: Partial<Record<keyof PeriodStats, number>> = {
  readiness:          5,
  hrv:                5,
  sleepHours:         0.5,
  sleepScore:         5,
  steps:              1500,
  workoutDurationMin: 10,
  calories:           150,
};

const PERIOD_METRIC_LABEL: Partial<Record<keyof PeriodStats, string>> = {
  sleepHours:         'Sleep',
  sleepScore:         'Sleep quality',
  hrv:                'HRV',
  readiness:          'Readiness',
  steps:              'Steps',
  workoutDurationMin: 'Activity',
  calories:           'Nutrition',
};

// ─── Layer 1: Context event ────────────────────────────────────────────────────

export function buildContextEventLayer(window: EventWindowAnalysis): ContextEventLayer | null {
  if (window.preWindow.days < 3 || window.duringWindow.days < 3) return null;

  const signalOrder: Array<keyof PeriodStats> = [
    'sleepHours', 'workoutDurationMin', 'sleepScore', 'hrv', 'readiness', 'steps', 'calories',
  ];

  const metricChanges: ContextEventLayer['metricChanges'] = [];
  const seenLabels = new Set<string>();

  for (const sig of signalOrder) {
    const pre    = window.preWindow[sig]    as number | null;
    const during = window.duringWindow[sig] as number | null;
    const thresh = PERIOD_DIFF[sig] ?? 999;
    if (pre === null || during === null) continue;
    if (Math.abs(during - pre) < thresh) continue;

    const label = PERIOD_METRIC_LABEL[sig] ?? String(sig);
    if (seenLabels.has(label)) continue;
    seenLabels.add(label);

    metricChanges.push({
      metric:      label,
      direction:   during < pre ? 'lower' : 'higher',
      preValue:    pre,
      duringValue: during,
    });
  }

  return {
    eventType:        window.event.type,
    eventLabel:       displayEventLabel(window.event.type, window.event.label),
    isOngoing:        window.isOngoing,
    durationDays:     window.duringWindow.days,
    metricChanges,
    hasEnoughEvidence: metricChanges.length > 0,
  };
}

// ─── Layer 4: Transition ───────────────────────────────────────────────────────

/** Only these event types can serve as the "current" event in a transition narrative */
const TRANSITION_CURRENT_TYPES = new Set(['illness', 'stressful_period']);

/** Maximum gap between preceding event end and current event start to qualify */
const TRANSITION_MAX_GAP_DAYS = 3;

export function buildTransitionLayer(eventWindows: EventWindowAnalysis[]): TransitionLayer | null {
  if (eventWindows.length < 2) return null;

  const sorted = [...eventWindows].sort((a, b) =>
    b.event.startDate.localeCompare(a.event.startDate)
  );

  const current = sorted[0];
  if (!TRANSITION_CURRENT_TYPES.has(current.event.type)) return null;
  if (current.duringWindow.days < 3) return null;

  const preceding = sorted.slice(1).find((w) => {
    if (!w.event.endDate) return false;
    const gap = daysBetweenDates(w.event.endDate, current.event.startDate);
    return gap <= TRANSITION_MAX_GAP_DAYS && w.event.endDate <= current.event.startDate;
  });

  if (!preceding) return null;
  if (preceding.preWindow.days < 3 || preceding.duringWindow.days < 3) return null;

  const signalOrder: Array<keyof PeriodStats> = [
    'sleepHours', 'workoutDurationMin', 'sleepScore', 'hrv', 'readiness',
  ];

  const precedingChanges: TransitionLayer['precedingMetricChanges'] = [];
  const seenLabels = new Set<string>();

  for (const sig of signalOrder) {
    const pre    = preceding.preWindow[sig]    as number | null;
    const during = preceding.duringWindow[sig] as number | null;
    const thresh = PERIOD_DIFF[sig] ?? 999;
    if (pre === null || during === null) continue;
    if (Math.abs(during - pre) < thresh) continue;

    const label = PERIOD_METRIC_LABEL[sig] ?? String(sig);
    if (!seenLabels.has(label)) {
      seenLabels.add(label);
      precedingChanges.push({ metric: label, direction: during < pre ? 'lower' : 'higher' });
    }
  }

  if (precedingChanges.length === 0) return null;

  return {
    precedingEventType:    preceding.event.type,
    precedingEventLabel:   displayEventLabel(preceding.event.type, preceding.event.label),
    currentEventType:      current.event.type,
    currentEventLabel:     displayEventLabel(current.event.type, current.event.label),
    gapDays:               daysBetweenDates(preceding.event.endDate!, current.event.startDate),
    precedingMetricChanges: precedingChanges.slice(0, 2),
  };
}

// ─── Layer 2: Behavioral findings ─────────────────────────────────────────────

interface BehaviorSpec {
  type:              BehavioralFinding['behaviorType'];
  label:             string;
  hasBehavior:       (d: HealthDayRecord) => boolean;
  outcomeMetric:     string;
  outcomeGetter:     (d: HealthDayRecord) => number | undefined;
  expectedDirection: 'worse' | 'better';
  timeRelationship:  'same_day' | 'next_day';
  /** PatternResult.relationshipId values that corroborate this behavior */
  corroborationIds?: string[];
  /**
   * Optional guard: if provided, a day is only eligible for the NON-behavior
   * comparison group when this returns true. Use for signals where missing
   * data ≠ zero (e.g. water logging — undefined means unlogged, not zero intake).
   */
  hasRelevantData?: (d: HealthDayRecord) => boolean;
}

const BEHAVIOR_SPECS: BehaviorSpec[] = [
  {
    type:              'alcohol',
    label:             'Alcohol',
    hasBehavior:       d => (d.totalAlcoholDrinks ?? 0) >= 1,
    outcomeMetric:     'Readiness',
    outcomeGetter:     d => d.readiness,
    expectedDirection: 'worse',
    timeRelationship:  'next_day',
    corroborationIds:  ['alcohol_drinks_next_readiness'],
  },
  {
    type:              'caffeine',
    label:             'Caffeine',
    hasBehavior:       d => (d.caffeineMg ?? 0) > 200,
    outcomeMetric:     'Sleep quality',
    outcomeGetter:     d => d.sleepScore,
    expectedDirection: 'worse',
    timeRelationship:  'next_day',
    corroborationIds:  ['caffeine_next_sleep_score'],
  },
  {
    type:              'sauna',
    label:             'Sauna',
    hasBehavior:       d => d.hasSaunaSession === true,
    outcomeMetric:     'Readiness',
    outcomeGetter:     d => d.readiness,
    expectedDirection: 'better',
    timeRelationship:  'same_day',
  },
  {
    type:              'cold_plunge',
    label:             'Cold plunge',
    hasBehavior:       d => d.hasColdPlungeSession === true,
    outcomeMetric:     'Readiness',
    outcomeGetter:     d => d.readiness ?? d.hrv,
    expectedDirection: 'better',
    timeRelationship:  'same_day',
  },
  {
    type:              'gratitude',
    label:             'Gratitude',
    hasBehavior:       d => (d.gratitudeSessions ?? 0) > 0,
    outcomeMetric:     'Readiness',
    outcomeGetter:     d => d.readiness,
    expectedDirection: 'better',
    timeRelationship:  'same_day',
    corroborationIds:  ['gratitude_next_readiness'],
  },
  {
    type:              'electrolytes',
    label:             'Electrolytes',
    hasBehavior:       d => d.electrolytesLogged === true,
    outcomeMetric:     'Readiness',
    outcomeGetter:     d => d.readiness,
    expectedDirection: 'better',
    timeRelationship:  'next_day',
    corroborationIds:  ['electrolytes_next_readiness'],
  },
  {
    type:              'water',
    label:             'Hydration',
    // ≥ 72 oz (~2.1 L) on a logged day = well-hydrated day
    hasBehavior:       d => (d.waterOz ?? 0) >= 72,
    outcomeMetric:     'Readiness',
    outcomeGetter:     d => d.readiness,
    expectedDirection: 'better',
    timeRelationship:  'same_day',
    // Only compare against days where water was actually logged.
    // Missing waterOz ≠ zero intake — exclude unlogged days from the comparison group.
    hasRelevantData:   d => d.waterOz !== undefined,
    corroborationIds:  ['water_next_readiness'],
  },
];

/** Minimum relative difference (behavior-day mean vs non-behavior-day mean) to register */
const MIN_RELATIVE_DIFF = 0.05;
/** Minimum non-behavior days needed as a comparison group */
const MIN_COMPARISON_DAYS = 3;

export function buildBehavioralFindings(
  timeline: HealthDayRecord[],
  allPatterns: PatternResult[],
): BehavioralFinding[] {
  const sorted = [...timeline].sort((a, b) => a.date.localeCompare(b.date));
  const dateToRecord = new Map(sorted.map(d => [d.date, d]));
  const findings: BehavioralFinding[] = [];

  for (const spec of BEHAVIOR_SPECS) {
    const behaviorOutcomes:    number[] = [];
    const nonBehaviorOutcomes: number[] = [];

    for (const day of sorted) {
      const outcomeDay =
        spec.timeRelationship === 'next_day'
          ? dateToRecord.get(nextDateStr(day.date))
          : day;
      if (!outcomeDay) continue;

      const outcome = spec.outcomeGetter(outcomeDay);
      if (outcome === undefined) continue;

      if (spec.hasBehavior(day)) {
        behaviorOutcomes.push(outcome);
      } else if (!spec.hasRelevantData || spec.hasRelevantData(day)) {
        // Only include in the comparison group when the signal was actually logged.
        // Prevents treating missing data as zero (e.g. unlogged water ≠ no water).
        nonBehaviorOutcomes.push(outcome);
      }
    }

    if (behaviorOutcomes.length === 0) continue;
    if (nonBehaviorOutcomes.length < MIN_COMPARISON_DAYS) continue;

    const bMean = behaviorOutcomes.reduce((s, x) => s + x, 0) / behaviorOutcomes.length;
    const nMean = nonBehaviorOutcomes.reduce((s, x) => s + x, 0) / nonBehaviorOutcomes.length;

    if (nMean === 0) continue;
    const relDiff = (bMean - nMean) / nMean;
    const observedDirection: 'better' | 'worse' = relDiff > 0 ? 'better' : 'worse';

    if (Math.abs(relDiff) < MIN_RELATIVE_DIFF) continue;
    if (observedDirection !== spec.expectedDirection) continue;

    const count = behaviorOutcomes.length;

    const hasCorroboration = spec.corroborationIds?.some(id =>
      allPatterns.some(p => p.relationshipId === id && p.confidenceTier !== 'INSUFFICIENT')
    ) ?? false;

    const strength: EvidenceStrength =
      hasCorroboration && count >= 3
        ? 'strong_contextual_pattern'
        : evidenceStrengthForCount(count);

    findings.push({
      behaviorType:     spec.type,
      behaviorLabel:    spec.label,
      outcomeMetric:    spec.outcomeMetric,
      outcomeDirection: observedDirection,
      timeRelationship: spec.timeRelationship,
      evidence:         { strength, occurrenceCount: count },
    });
  }

  return findings;
}

// ─── Layer 3: Physiological state ─────────────────────────────────────────────

const PHYSIO_METRICS: Array<{ key: keyof HealthDayRecord; label: string }> = [
  { key: 'readiness',  label: 'Readiness' },
  { key: 'hrv',        label: 'HRV' },
  { key: 'sleepScore', label: 'Sleep quality' },
  { key: 'sleepHours', label: 'Sleep' },
];

const MIN_BASELINE_SAMPLES = 7;

export function buildPhysiologicalState(
  today: HealthDayRecord,
  timeline: HealthDayRecord[],
): PhysiologicalStateLayer | null {
  const findings: MetricFinding[] = [];

  for (const { key, label } of PHYSIO_METRICS) {
    const actual = today[key] as number | undefined;
    if (actual === undefined) continue;

    const baseline = computeMetricBaseline(timeline, d => d[key] as number | undefined);
    if (!baseline || baseline.sampleCount < MIN_BASELINE_SAMPLES) continue;

    const { direction, magnitude } = classifyVsBaseline(actual, baseline);
    findings.push({ metric: label, direction, magnitude, actual, baseline: baseline.median });
  }

  if (findings.length === 0) return null;

  const hasAbove = findings.some(f => f.direction === 'above_baseline');
  const hasBelow = findings.some(f => f.direction === 'below_baseline');

  return { findings, conflicting: hasAbove && hasBelow };
}

// ─── Layer 5: Current direction ────────────────────────────────────────────────

const DIRECTION_METRICS: Array<{ key: keyof HealthDayRecord; label: string }> = [
  { key: 'readiness',  label: 'Readiness' },
  { key: 'hrv',        label: 'HRV' },
  { key: 'sleepScore', label: 'Sleep quality' },
];

const RECENT_DAYS_WINDOW = 3;
const PRIOR_DAYS_WINDOW  = 7;

export function buildCurrentDirectionLayer(
  timeline: HealthDayRecord[],
  today: HealthDayRecord,
): CurrentDirectionLayer | null {
  const sorted = [...timeline]
    .filter(d => d.date <= today.date)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (sorted.length < RECENT_DAYS_WINDOW + 2) {
    return {
      trajectory:          'insufficient_data',
      improvingMetrics:    [],
      belowBaselineMetrics: [],
      recentDays:          sorted.length,
    };
  }

  const recent = sorted.slice(-RECENT_DAYS_WINDOW);
  const prior  = sorted.slice(-(RECENT_DAYS_WINDOW + PRIOR_DAYS_WINDOW), -RECENT_DAYS_WINDOW);

  if (recent.length < 2) {
    return {
      trajectory:          'insufficient_data',
      improvingMetrics:    [],
      belowBaselineMetrics: [],
      recentDays:          recent.length,
    };
  }

  const improvingMetrics:    string[] = [];
  const belowBaselineMetrics: string[] = [];
  let hasDeclineSignal = false;

  for (const { key, label } of DIRECTION_METRICS) {
    const getter = (d: HealthDayRecord) => d[key] as number | undefined;
    const baseline = computeMetricBaseline(sorted, getter);
    if (!baseline) continue;

    const recentVals = recent.map(getter).filter((v): v is number => v !== undefined);
    const priorVals  = prior.map(getter).filter((v): v is number => v !== undefined);
    if (recentVals.length === 0) continue;

    const recentMean = recentVals.reduce((s, x) => s + x, 0) / recentVals.length;

    const priorMean = priorVals.length > 0
      ? priorVals.reduce((s, x) => s + x, 0) / priorVals.length
      : null;

    // "Below baseline" = below the personal median (not just p25).
    // This catches the full recovery arc: still below median even after
    // climbing above p25 from a disrupted period.
    const isBelowMedian = recentMean < baseline.median;

    if (isBelowMedian) {
      belowBaselineMetrics.push(label);

      if (priorMean !== null) {
        // Recovering: last 3 days average is ≥ 4% higher than the prior window
        if (recentMean > priorMean * 1.04) {
          improvingMetrics.push(label);
        }
      }
    } else if (priorMean !== null) {
      // Was at/above median in prior window — is it now sliding down?
      if (priorMean >= baseline.median && recentMean < priorMean * 0.95) {
        hasDeclineSignal = true;
      }
    }
  }

  let trajectory: CurrentDirectionLayer['trajectory'];

  if (belowBaselineMetrics.length === 0) {
    trajectory = hasDeclineSignal ? 'declining' : 'stable';
  } else if (improvingMetrics.length > 0) {
    trajectory = 'recovering';
  } else {
    trajectory = 'disrupted';
  }

  return { trajectory, improvingMetrics, belowBaselineMetrics, recentDays: recent.length };
}

// ─── Meal timing buckets ───────────────────────────────────────────────────────

/**
 * Coarse meal-timing classification based on meal category.
 *
 * These are ranges / buckets — never exact timestamps.
 *
 *   breakfast_window — morning   (Breakfast category, or consumed_at 5am–11am)
 *   lunch_window     — midday    (Lunch category,     or consumed_at 11am–4pm)
 *   dinner_window    — evening   (Dinner category,    or consumed_at 4pm–10pm)
 *   snack_ambiguous  — no fixed window (Snack category, or consumed_at outside all windows)
 *
 * NEVER use logged_at (upload time) for timing.
 * If consumed_at is absent, the meal category name is the only basis for bucketing.
 */
export type MealTimingBucket =
  | 'breakfast_window'
  | 'lunch_window'
  | 'dinner_window'
  | 'snack_ambiguous';

// Local-hour ranges [startInclusive, endExclusive) for each named bucket.
// Anything outside all three windows (10pm–5am) → snack_ambiguous.
const MEAL_BUCKET_HOURS: Record<Exclude<MealTimingBucket, 'snack_ambiguous'>, [number, number]> = {
  breakfast_window: [5,  11],   //  5:00 AM – 11:00 AM
  lunch_window:     [11, 16],   // 11:00 AM –  4:00 PM
  dinner_window:    [16, 23],   //  4:00 PM – 11:00 PM
};

// Category label → default bucket when no consumed_at is available.
const CATEGORY_BUCKET: Record<string, MealTimingBucket> = {
  breakfast: 'breakfast_window',
  lunch:     'lunch_window',
  dinner:    'dinner_window',
  snack:     'snack_ambiguous',
};

/**
 * Classify a meal into a coarse timing bucket.
 *
 * Priority:
 *   1. consumed_at (explicit user-declared ISO timestamp) → actual local-time window
 *   2. meal category name → default bucket
 *
 * NEVER uses logged_at (database write timestamp / upload time).
 * Returns a bucket, never an exact time.
 * A Breakfast uploaded at 9 PM with no consumed_at → breakfast_window.
 * A Breakfast with consumed_at at 7 PM local → dinner_window.
 *
 * @param mealName   - meal category: 'Breakfast' | 'Lunch' | 'Dinner' | 'Snack' (case-insensitive)
 * @param consumedAt - optional ISO timestamp of actual consumption; null/absent = use category
 */
export function classifyMealCategory(
  mealName: string,
  consumedAt?: string | null,
): MealTimingBucket {
  // 1. If consumed_at is explicitly provided, bucket by actual local hour.
  if (consumedAt) {
    const d = new Date(consumedAt);
    if (!isNaN(d.getTime())) {
      const hours = d.getHours() + d.getMinutes() / 60;
      for (const [bucket, [start, end]] of Object.entries(MEAL_BUCKET_HOURS) as Array<
        [Exclude<MealTimingBucket, 'snack_ambiguous'>, [number, number]]
      >) {
        if (hours >= start && hours < end) return bucket;
      }
      // Outside all named windows (10pm–5am) — no timing claim possible
      return 'snack_ambiguous';
    }
  }

  // 2. Fall back to category name (case-insensitive).
  return CATEGORY_BUCKET[mealName.toLowerCase()] ?? 'snack_ambiguous';
}

// ─── Layer 6: Nutrition ────────────────────────────────────────────────────────

/**
 * MEAL TIMING GUARD
 *
 * The nutrition_log table has two timestamp fields:
 *
 *   logged_at   — server write timestamp. Set by the Edge Function to now().
 *                 This is the UPLOAD time, not the eat time. A user who batch-
 *                 uploads three meals at 9 PM has logged_at ≈ 9 PM for all rows
 *                 regardless of when they actually ate.
 *
 *   consumed_at — user-declared consumption time (nullable).
 *                 NULL / absent = timing UNKNOWN.
 *
 * HealthDayRecord aggregates to daily totals — individual row timestamps
 * are not yet propagated here. Until a future update exposes consumed_at
 * through the aggregation pipeline, all meal timing analysis is BLOCKED:
 *
 *   - late-night eating      → BLOCKED (no consumed_at in HealthDayRecord)
 *   - meal spacing           → BLOCKED
 *   - meal frequency by time → BLOCKED
 *   - breakfast/lunch timing → BLOCKED
 *
 * When consumed_at IS available in HealthDayRecord (future), timing claims
 * must still only be made when consumed_at IS NOT NULL for a sufficient
 * fraction of rows in the analysis window.
 *
 * NEVER use logged_at, meal.time, or meal_name as a consumption time proxy.
 */

/**
 * Minimum calories for a day to count as "credibly logged".
 * A day with logged calories below this floor is likely an incomplete log,
 * not evidence of low intake. Such days are excluded from all comparisons.
 */
const MIN_LOGGED_CALORIES = 600;

export function assessNutritionEvidence(timeline: HealthDayRecord[]): NutritionEvidence {
  const totalDays = timeline.length;
  const daysWithLogging = timeline.filter(
    d => d.calories !== undefined && d.calories >= MIN_LOGGED_CALORIES,
  ).length;
  const loggingRate = totalDays > 0 ? daysWithLogging / totalDays : 0;

  let confidence: NutritionEvidence['confidence'];
  if (daysWithLogging < 7 || loggingRate < 0.3) {
    confidence = 'insufficient';
  } else if (daysWithLogging < 14 || loggingRate < 0.6) {
    confidence = 'low';
  } else {
    confidence = 'moderate';
  }

  return { daysWithLogging, totalDays, loggingRate, confidence };
}

interface NutritionSpec {
  signal:            NutritionFinding['signal'];
  label:             string;
  getter:            (d: HealthDayRecord) => number | undefined;
  outcomeMetric:     string;
  outcomeGetter:     (d: HealthDayRecord) => number | undefined;
  expectedDirection: 'better' | 'worse';
  timeRelationship:  'same_day' | 'next_day';
}

const NUTRITION_SPECS: NutritionSpec[] = [
  {
    signal:            'protein',
    label:             'Protein',
    getter:            d => d.protein,
    outcomeMetric:     'Readiness',
    outcomeGetter:     d => d.readiness,
    expectedDirection: 'better',
    timeRelationship:  'same_day',
  },
  {
    signal:            'calories',
    label:             'Nutrition',
    getter:            d => d.calories,
    outcomeMetric:     'Readiness',
    outcomeGetter:     d => d.readiness,
    expectedDirection: 'better',
    timeRelationship:  'same_day',
  },
];

/**
 * Build the completeness-gated nutrition layer.
 *
 * All comparisons are relative (high-logged days vs lower-logged days).
 * A finding never implies deficiency or that the user "ate too little" —
 * it only notes that on logged days with more X, Y tended to be higher.
 */
export function buildNutritionLayer(timeline: HealthDayRecord[]): NutritionLayer {
  const loggingEvidence = assessNutritionEvidence(timeline);

  // Only generate findings when logging history is sufficient.
  if (loggingEvidence.confidence !== 'moderate') {
    return { loggingEvidence, findings: [] };
  }

  const sorted = [...timeline].sort((a, b) => a.date.localeCompare(b.date));
  const dateToRecord = new Map(sorted.map(d => [d.date, d]));

  // Work only within days that have credible logging (calories >= floor).
  const loggedDays = sorted.filter(
    d => d.calories !== undefined && d.calories >= MIN_LOGGED_CALORIES,
  );

  if (loggedDays.length < MIN_COMPARISON_DAYS + 2) {
    return { loggingEvidence, findings: [] };
  }

  const findings: NutritionFinding[] = [];

  for (const spec of NUTRITION_SPECS) {
    const signalValues = loggedDays
      .map(d => spec.getter(d))
      .filter((v): v is number => v !== undefined);

    if (signalValues.length < 5) continue;

    // Split logged days into "high signal" vs "lower signal" using the median
    // of the signal itself. This is purely relative — no absolute thresholds.
    const signalSorted = [...signalValues].sort((a, b) => a - b);
    const signalMedian  = signalSorted[Math.floor(signalSorted.length / 2)];

    const highOutcomes:  number[] = [];
    const lowerOutcomes: number[] = [];

    for (const day of loggedDays) {
      const sigVal = spec.getter(day);
      if (sigVal === undefined) continue;

      const outcomeDay =
        spec.timeRelationship === 'next_day'
          ? dateToRecord.get(nextDateStr(day.date))
          : day;
      if (!outcomeDay) continue;

      const outcome = spec.outcomeGetter(outcomeDay);
      if (outcome === undefined) continue;

      if (sigVal > signalMedian) {
        highOutcomes.push(outcome);
      } else {
        lowerOutcomes.push(outcome);
      }
    }

    if (highOutcomes.length === 0 || lowerOutcomes.length < MIN_COMPARISON_DAYS) continue;

    const highMean  = highOutcomes.reduce((s, x) => s + x, 0) / highOutcomes.length;
    const lowerMean = lowerOutcomes.reduce((s, x) => s + x, 0) / lowerOutcomes.length;

    if (lowerMean === 0) continue;
    const relDiff = (highMean - lowerMean) / lowerMean;
    const observedDirection: 'better' | 'worse' = relDiff > 0 ? 'better' : 'worse';

    if (Math.abs(relDiff) < MIN_RELATIVE_DIFF) continue;
    if (observedDirection !== spec.expectedDirection) continue;

    findings.push({
      signal:           spec.signal,
      signalLabel:      spec.label,
      outcomeMetric:    spec.outcomeMetric,
      outcomeDirection: observedDirection,
      timeRelationship: spec.timeRelationship,
      evidence: {
        strength:        evidenceStrengthForCount(highOutcomes.length),
        occurrenceCount: highOutcomes.length,
      },
    });
  }

  return { loggingEvidence, findings };
}

// ─── HydrationContext builder ──────────────────────────────────────────────────

/** Minimum fraction of window days with waterOz logged to make a hydration claim (event-window path) */
const HYDRATION_COVERAGE_MIN   = 0.50;
/** If window mean is below this fraction of baseline mean, status = below_target (event-window fallback) */
const HYDRATION_BELOW_TARGET_RATIO = 0.85;
/** Number of completed days before today to inspect for the alcohol/sleep_activity path */
const HYDRATION_COMPLETED_DAYS_WINDOW = 7;
/** Minimum logged days required (out of HYDRATION_COMPLETED_DAYS_WINDOW) to make a hydration claim */
const HYDRATION_MIN_LOGGED_COMPLETED = 4;
/** Minimum days below target (out of logged days) to return below_target status */
const HYDRATION_MIN_DAYS_BELOW = 3;

/**
 * Assess hydration coverage.
 *
 * Two paths:
 *
 * 1. Completed-days path (todayDate provided, no eventStartDate):
 *    Uses the 7 most recent COMPLETED days before today (today is excluded — it's
 *    incomplete). Requires ≥4 logged days. Compares against waterGoalOz when provided,
 *    falls back to baseline mean. Returns below_target only when ≥3 logged days were
 *    demonstrably below the target — "one low day" is never enough.
 *
 * 2. Event-window path (eventStartDate provided): unchanged from prior behavior.
 *    Filters to the event date range, requires ≥50% coverage, compares to baseline mean.
 *
 * NEVER return below_target based on missing data. Only return below_target
 * when waterOz was actually logged AND was below the personal target.
 */
export function buildHydrationContext(
  timeline: HealthDayRecord[],
  eventStartDate?: string,
  eventEndDate?: string,
  waterGoalOz?: number,
  todayDate?: string,
): HydrationContext {

  // ── Completed-days path ─────────────────────────────────────────────────────
  if (!eventStartDate && todayDate) {
    const completedDays = [...timeline]
      .filter(d => d.date < todayDate)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, HYDRATION_COMPLETED_DAYS_WINDOW);

    const windowDays = completedDays.length;
    if (windowDays === 0) {
      return { status: 'not_tracked', loggedDaysInWindow: 0, windowDays: 0, coverageRate: 0, goalOz: waterGoalOz ?? null };
    }

    const logged = completedDays.filter(d => d.waterOz !== undefined);
    const coverageRate = logged.length / windowDays;

    if (logged.length < HYDRATION_MIN_LOGGED_COMPLETED) {
      return { status: 'not_tracked', loggedDaysInWindow: logged.length, windowDays, coverageRate, goalOz: waterGoalOz ?? null };
    }

    if (waterGoalOz != null && waterGoalOz > 0) {
      const daysBelow = logged.filter(d => (d.waterOz ?? 0) < waterGoalOz).length;
      const status: HydrationContext['status'] = daysBelow >= HYDRATION_MIN_DAYS_BELOW ? 'below_target' : 'adequate';
      return { status, loggedDaysInWindow: logged.length, windowDays, coverageRate, daysBelow, goalOz: waterGoalOz };
    }

    // Fallback: compare to baseline mean when no goal is set
    const baseline = computeMetricBaseline(timeline, d => d.waterOz);
    if (!baseline || baseline.mean === 0) {
      return { status: 'adequate', loggedDaysInWindow: logged.length, windowDays, coverageRate, goalOz: null };
    }
    const daysBelow = logged.filter(d => (d.waterOz ?? 0) < baseline.mean * HYDRATION_BELOW_TARGET_RATIO).length;
    const status: HydrationContext['status'] = daysBelow >= HYDRATION_MIN_DAYS_BELOW ? 'below_target' : 'adequate';
    return { status, loggedDaysInWindow: logged.length, windowDays, coverageRate, daysBelow, goalOz: null };
  }

  // ── Event-window path (backward-compatible) ─────────────────────────────────
  let windowRecords: HealthDayRecord[];

  if (eventStartDate) {
    const end = eventEndDate
      ?? [...timeline].sort((a, b) => b.date.localeCompare(a.date))[0]?.date
      ?? eventStartDate;
    windowRecords = timeline.filter(d => d.date >= eventStartDate && d.date <= end);
  } else {
    windowRecords = [...timeline]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 14);
  }

  const windowDays = windowRecords.length;
  if (windowDays === 0) {
    return { status: 'not_tracked', loggedDaysInWindow: 0, windowDays: 0, coverageRate: 0 };
  }

  const logged = windowRecords.filter(d => d.waterOz !== undefined);
  const coverageRate = logged.length / windowDays;

  if (coverageRate < HYDRATION_COVERAGE_MIN) {
    return { status: 'not_tracked', loggedDaysInWindow: logged.length, windowDays, coverageRate };
  }

  const baseline = computeMetricBaseline(timeline, d => d.waterOz);
  if (!baseline || baseline.mean === 0) {
    // Not enough history — can't say whether intake was low, so don't claim it
    return { status: 'adequate', loggedDaysInWindow: logged.length, windowDays, coverageRate };
  }

  const windowMean = logged.reduce((s, d) => s + (d.waterOz ?? 0), 0) / logged.length;
  const status: HydrationContext['status'] =
    windowMean < baseline.mean * HYDRATION_BELOW_TARGET_RATIO
      ? 'below_target'
      : 'adequate';

  return { status, loggedDaysInWindow: logged.length, windowDays, coverageRate };
}

// ─── InterpretationLayer builder ───────────────────────────────────────────────

/**
 * Synthesize across layers to detect a multi-signal pattern.
 *
 * Priority:
 *   1. strain_accumulation — a transition exists (preceding → current event with load signals)
 *   2. behavioral_cluster  — 2+ behavioral findings of non-trivial evidence
 *   3. routine_disruption  — travel event with 2+ metric changes
 */
export function buildInterpretationLayer(
  contextEvent: ContextEventLayer | null,
  behavioralFindings: BehavioralFinding[],
  transition: TransitionLayer | null,
  _physiologicalState: PhysiologicalStateLayer | null,
): InterpretationLayer {
  // 1. strain_accumulation: a qualifying transition exists with load signals
  if (transition !== null && transition.precedingMetricChanges.length > 0) {
    return {
      connectionType:    'strain_accumulation',
      loadSignals:       transition.precedingMetricChanges.map(c => c.metric),
      behaviorSignals:   [],
      outcomeEventType:  transition.currentEventType,
      hasInterpretation: true,
    };
  }

  // 2. behavioral_cluster: 2+ non-trivial behavioral findings
  const meaningful = behavioralFindings.filter(
    f => f.evidence.strength !== 'isolated_coincidence',
  );
  if (meaningful.length >= 2) {
    return {
      connectionType:    'behavioral_cluster',
      loadSignals:       [],
      behaviorSignals:   meaningful.map(f => f.behaviorLabel),
      outcomeEventType:  '',
      hasInterpretation: true,
    };
  }

  // 3. routine_disruption: travel/vacation event with 2+ metric changes
  if (
    contextEvent?.hasEnoughEvidence &&
    contextEvent.metricChanges.length >= 2 &&
    (contextEvent.eventType === 'travel' || contextEvent.eventType === 'vacation')
  ) {
    return {
      connectionType:    'routine_disruption',
      loadSignals:       contextEvent.metricChanges.map(c => c.metric),
      behaviorSignals:   [],
      outcomeEventType:  contextEvent.eventType,
      hasInterpretation: true,
    };
  }

  return {
    connectionType:    'routine_disruption',
    loadSignals:       [],
    behaviorSignals:   [],
    outcomeEventType:  '',
    hasInterpretation: false,
  };
}

// ─── AftermathLayer builder ────────────────────────────────────────────────────

const MIN_AFTERMATH_DAYS         = 3;
const MAX_AFTERMATH_LOOKAHEAD    = 7;
const MIN_RELATIVE_AFTERMATH     = 0.05;

interface AftermathSignalSpec {
  key:                  keyof HealthDayRecord;
  label:                string;
  recoveryAlignedDir:   'higher' | 'lower';
  applicableEventTypes: string[];
}

const AFTERMATH_SIGNALS: AftermathSignalSpec[] = [
  { key: 'sleepHours',         label: 'Sleep',     recoveryAlignedDir: 'higher', applicableEventTypes: ['illness', 'stressful_period', 'travel'] },
  { key: 'readiness',          label: 'Readiness', recoveryAlignedDir: 'higher', applicableEventTypes: ['illness', 'stressful_period', 'travel', 'training_block'] },
  { key: 'hrv',                label: 'HRV',       recoveryAlignedDir: 'higher', applicableEventTypes: ['illness', 'stressful_period', 'training_block'] },
  { key: 'waterOz',            label: 'Hydration', recoveryAlignedDir: 'higher', applicableEventTypes: ['illness', 'stressful_period'] },
  { key: 'workoutDurationMin', label: 'Activity',  recoveryAlignedDir: 'lower',  applicableEventTypes: ['illness'] },
];

/**
 * Describe what happened in the days AFTER a completed event ended.
 * Only for non-ongoing events with sufficient during + post-event data.
 */
export function buildAftermathLayer(
  timeline: HealthDayRecord[],
  eventType: string,
  eventEndDate: string | undefined,
  eventStartDate: string,
  isOngoing: boolean,
): AftermathLayer {
  if (isOngoing || !eventEndDate) {
    return { observations: [], postEventDays: 0, hasEvidence: false };
  }

  const duringDays = timeline.filter(d => d.date >= eventStartDate && d.date <= eventEndDate);
  const cutoffDate = addDaysToStr(eventEndDate, MAX_AFTERMATH_LOOKAHEAD);
  const postDays   = timeline
    .filter(d => d.date > eventEndDate && d.date <= cutoffDate)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (duringDays.length < 2 || postDays.length < MIN_AFTERMATH_DAYS) {
    return { observations: [], postEventDays: postDays.length, hasEvidence: false };
  }

  const observations: AftermathObservation[] = [];

  for (const spec of AFTERMATH_SIGNALS) {
    if (!spec.applicableEventTypes.includes(eventType)) continue;

    const duringVals = duringDays
      .map(d => d[spec.key] as number | undefined)
      .filter((v): v is number => v !== undefined);
    if (duringVals.length < 2) continue;
    const duringMean = duringVals.reduce((s, x) => s + x, 0) / duringVals.length;
    if (duringMean === 0) continue;

    const postVals = postDays
      .map(d => d[spec.key] as number | undefined)
      .filter((v): v is number => v !== undefined);
    if (postVals.length < 2) continue;
    const postMean = postVals.reduce((s, x) => s + x, 0) / postVals.length;

    let referenceForRelDiff: number;
    if (spec.key === 'workoutDurationMin') {
      // Compare post-event activity to personal baseline, not to during-event.
      // During-illness activity is already suppressed, so post > during is misleading;
      // what matters is whether post is still lighter than the user's normal level.
      const baseline = computeMetricBaseline(timeline, d => d.workoutDurationMin);
      if (!baseline || baseline.mean === 0) continue;
      referenceForRelDiff = baseline.mean;
    } else {
      referenceForRelDiff = duringMean;
    }
    const relDiff = (postMean - referenceForRelDiff) / referenceForRelDiff;
    if (Math.abs(relDiff) < MIN_RELATIVE_AFTERMATH) continue;

    const direction: AftermathObservation['direction'] = relDiff > 0 ? 'higher' : 'lower';
    const isRecoveryAligned = direction === spec.recoveryAlignedDir;
    observations.push({ signal: spec.label, direction, isRecoveryAligned });
  }

  return {
    observations,
    postEventDays: postDays.length,
    hasEvidence:   observations.length > 0,
  };
}

// ─── NextFocusLayer builder ────────────────────────────────────────────────────

/**
 * Derive 1–3 evidence-grounded priorities.
 *
 * Each priority must cite actual data as its rationale.
 * No generic boilerplate ("eat more vegetables", "drink more water" without data).
 */
export function buildNextFocusLayer(
  contextEvent: ContextEventLayer | null,
  currentDirection: CurrentDirectionLayer | null,
  behavioralFindings: BehavioralFinding[],
  hydrationContext: HydrationContext | null,
): NextFocusLayer {
  const priorities: NextFocusPriority[] = [];

  let context: NextFocusLayer['context'] = 'general';
  const traj = currentDirection?.trajectory;
  if (traj === 'recovering' || traj === 'disrupted') {
    context = 'recovery';
  } else if (contextEvent?.eventType === 'travel' || contextEvent?.eventType === 'vacation') {
    context = 'travel';
  } else if (contextEvent?.eventType === 'training_block') {
    context = 'training';
  } else if (contextEvent?.eventType === 'stressful_period') {
    context = 'stress';
  }

  // Priority 1: recovery metrics still below baseline (from currentDirection)
  if (traj === 'recovering' || traj === 'disrupted') {
    const below = currentDirection!.belowBaselineMetrics;
    const hasSleep = below.some(m => m === 'Sleep' || m === 'Sleep quality');
    if (hasSleep) {
      priorities.push({
        area:      'Sleep',
        rationale: `${below.slice(0, 2).join(' and ')} is still running below your usual range.`,
      });
    } else if (below.length > 0) {
      priorities.push({
        area:      'Recovery',
        rationale: `${below.slice(0, 2).join(' and ')} is still below your usual range.`,
      });
    }
  }

  // For ongoing events: add metric drops from the contextEvent as priorities.
  // This surfaces the right focus when currentDirection can't detect the change
  // (e.g. timeline is uniformly disrupted so there's no "before" to compare against).
  if (contextEvent?.hasEnoughEvidence && contextEvent.isOngoing && priorities.length < 3) {
    const coveredMetrics = new Set(priorities.flatMap(p => p.area.toLowerCase().split(' and ')));
    const hasRecoveryPriority = priorities.some(p => p.area === 'Recovery');
    // HRV, Readiness, and Sleep quality are subsumed by 'Recovery' — don't add them separately
    const RECOVERY_METRICS = new Set(['HRV', 'Readiness', 'Sleep quality']);
    const drops = contextEvent.metricChanges
      .filter(c => c.direction === 'lower')
      .filter(c => !coveredMetrics.has(c.metric.toLowerCase()))
      .filter(c => !(hasRecoveryPriority && RECOVERY_METRICS.has(c.metric)))
      // Skip 'Sleep quality' when 'Sleep' is already covered or will be added
      .filter((c, _, arr) =>
        c.metric !== 'Sleep quality' ||
        (!coveredMetrics.has('sleep') && !arr.some(x => x.metric === 'Sleep')),
      );
    for (const drop of drops.slice(0, 3 - priorities.length)) {
      coveredMetrics.add(drop.metric.toLowerCase());
      priorities.push({
        area:      drop.metric,
        rationale: `${drop.metric} has been running lower since ${contextEvent.eventLabel.toLowerCase()} began.`,
      });
    }
  }

  // Hydration: only when it was logged and below target
  if (hydrationContext?.status === 'below_target' && priorities.length < 3) {
    priorities.push({
      area:      'Hydration',
      rationale: 'Your logged hydration was below your usual level during this period.',
    });
  }

  return {
    priorities:        priorities.slice(0, 3),
    context,
    hasRecommendation: priorities.length > 0,
  };
}

// ─── FutureLessonLayer builder ─────────────────────────────────────────────────

/**
 * Event types that warrant a forward-looking lesson.
 * Only repeatable/planned contexts are included — illness is excluded because
 * "On your next illness..." is not a natural or useful framing.
 * Illness/recovery episodes end with aftermath + nextFocus instead.
 */
const FUTURE_LESSON_EVENT_TYPES = new Set([
  'travel', 'vacation', 'training_block',
]);

/**
 * Draw a forward-looking lesson from a completed event.
 * monitorSignals — metrics that dropped (worth watching next time).
 * protectSignals — metrics that held or rose, or behaviors with 'better' outcomes.
 */
export function buildFutureLessonLayer(
  contextEvent: ContextEventLayer | null,
  behavioralFindings: BehavioralFinding[],
): FutureLessonLayer {
  const empty = { eventType: '', monitorSignals: [], protectSignals: [], hasLesson: false };

  if (!contextEvent?.hasEnoughEvidence || contextEvent.isOngoing) return empty;
  if (!FUTURE_LESSON_EVENT_TYPES.has(contextEvent.eventType)) {
    return { ...empty, eventType: contextEvent.eventType };
  }

  const monitorSignals = contextEvent.metricChanges
    .filter(c => c.direction === 'lower')
    .map(c => c.metric);

  if (monitorSignals.length === 0) {
    return { ...empty, eventType: contextEvent.eventType };
  }

  const protectSignals = [
    ...contextEvent.metricChanges
      .filter(c => c.direction === 'higher')
      .map(c => c.metric),
    ...behavioralFindings
      .filter(f => f.outcomeDirection === 'better' && f.evidence.strength !== 'isolated_coincidence')
      .map(f => f.behaviorLabel),
  ];

  return {
    eventType:      contextEvent.eventType,
    monitorSignals,
    protectSignals,
    hasLesson:      true,
  };
}

// ─── Context-response contrast layer helpers ──────────────────────────────────

/** Minimum drinks on a single night for the alcohol contrast path to fire. */
const ALCOHOL_CONTRAST_MIN_DRINKS = 2;

/**
 * Type-specific look-back windows for life-context events.
 *
 * Each value is the number of days AFTER the event ended that it remains
 * relevant for the contrast story. An event that ended exactly N days ago
 * still qualifies; one that ended N+1 days ago does not.
 *
 * Design rationale:
 *   alcohol    — next-day only (handled separately in findAlcoholNightEvent)
 *   travel     — 7 days: jet lag and routine disruption take time to resolve
 *   illness    — 10 days: recovery arc is often the most interesting story
 *   stress     — 5 days: acute; shorter aftermath than travel
 *   training   — 3 days: interpretation lens; completed blocks fade faster
 *   user_defined — 7 days: user named it; treat with proportional respect
 *   default    — 4 days for anything unclassified
 */
const CONTRAST_LOOKBACK_BY_TYPE: Partial<Record<string, number>> = {
  travel:           7,
  vacation:         7,  // normalized to 'travel' at load time, kept for safety
  illness:          10,
  stressful_period: 5,
  training_block:   3,
  user_defined:     7,
};
const CONTRAST_LOOKBACK_DEFAULT = 4;

/** Return the cutoff date string for a specific context event type. */
function contrastRelevanceCutoff(eventType: string, todayStr: string): string {
  const days = CONTRAST_LOOKBACK_BY_TYPE[eventType] ?? CONTRAST_LOOKBACK_DEFAULT;
  return addDaysToStr(todayStr, -days);
}
/** Minimum historical weeks needed to compute a reliable training baseline. */
const MIN_TRAINING_HISTORY_WEEKS = 3;
/** % above personal weekly workout-time median to qualify as "elevated" (no perf goal). */
const TRAINING_ELEVATED_THRESHOLD = 0.25;
/** % above median to qualify as "elevated" when a perf goal is set. */
const TRAINING_ELEVATED_THRESHOLD_PERF = 0.15;
/** Minimum weekly workout-time median (minutes) required to make an elevation claim. */
const TRAINING_MEDIAN_FLOOR_MIN = 30;

/**
 * Classify how physiology responded to a context event.
 *
 * 'stable'      — ≥2 tracked metrics are near_baseline; none are moderately/substantially off.
 * 'responding'  — ≥1 tracked metric is below_baseline or above_baseline at moderate/substantial magnitude.
 * 'insufficient' — fewer than 2 metrics with baseline data, or only mild deviations (not story-worthy).
 */
function classifyPhysioResponse(state: PhysiologicalStateLayer): 'stable' | 'responding' | 'insufficient' {
  const findings = state.findings;
  if (findings.length < 2) return 'insufficient';

  const notableDeviation = findings.filter(
    f => f.direction !== 'near_baseline' &&
         (f.magnitude === 'moderate' || f.magnitude === 'substantial'),
  );
  const nearBaseline = findings.filter(f => f.direction === 'near_baseline');

  if (notableDeviation.length >= 1) return 'responding';
  if (nearBaseline.length >= 2) return 'stable';
  // Only mild deviations — not interesting enough on its own.
  return 'insufficient';
}

/**
 * Return the most recent meaningful ContextEvent from relevantContext that
 * is active or ended within its type-specific relevance window (see CONTRAST_LOOKBACK_BY_TYPE).
 *
 * Meaningful thresholds per type:
 *   travel / vacation   — always meaningful (7-day window after end)
 *   illness             — always meaningful (10-day window after end)
 *   stressful_period    — only if duration ≥ 2 days; 5-day window after end
 *   training_block      — only user_logged; 3-day window after end
 *   user_defined        — always meaningful (7-day window after end)
 *   alcohol_period      — handled separately in findAlcoholNightEvent (next-day only)
 *   cycle_phase         — excluded (too variable for this iteration)
 */
function findMeaningfulContextEvent(
  relevantContext: ContextEvent[],
  todayStr: string,
): ContextEvent | null {
  // Priority order: illness > travel > stressful_period > training_block > user_defined
  const PRIORITY_ORDER = ['illness', 'travel', 'vacation', 'stressful_period', 'training_block', 'user_defined'];

  const candidates: ContextEvent[] = [];

  for (const event of relevantContext) {
    if (event.startDate > todayStr) continue;
    const effectiveEnd = event.endDate ?? todayStr;
    // Each event type has its own relevance window after it ends.
    const cutoff = contrastRelevanceCutoff(event.type, todayStr);
    if (effectiveEnd < cutoff) continue;

    switch (event.type) {
      case 'travel':
      case 'vacation':
        candidates.push(event);
        break;
      case 'illness':
        candidates.push(event);
        break;
      case 'stressful_period': {
        // Only surface stress stories when the period is ≥2 days.
        const start = new Date(event.startDate + 'T12:00:00Z');
        const end   = new Date((event.endDate ?? todayStr) + 'T12:00:00Z');
        const days  = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
        if (days >= 2) candidates.push(event);
        break;
      }
      case 'training_block':
        if (event.source === 'user_logged') candidates.push(event);
        break;
      case 'user_defined':
        candidates.push(event);
        break;
      // 'alcohol_period' — handled by the single-day branch below
      // 'cycle_phase' — excluded
    }
  }

  if (candidates.length === 0) return null;

  // Return highest-priority candidate.
  candidates.sort((a, b) => {
    const pa = PRIORITY_ORDER.indexOf(a.type);
    const pb = PRIORITY_ORDER.indexOf(b.type);
    const ai = pa === -1 ? 999 : pa;
    const bi = pb === -1 ? 999 : pb;
    return ai - bi;
  });
  return candidates[0];
}

/**
 * Find a single-day alcohol event representing "last night's drinking session".
 *
 * Overnight boundary handling:
 *   Drinks logged after midnight (e.g. 1 AM on Oct 3) are stored with the
 *   current calendar date (Oct 3 = "today"), not the behavioural night's date
 *   (Oct 2 = "yesterday"). We combine both calendar dates into a single session
 *   count when the local clock is before OVERNIGHT_CUTOFF_HOUR (4 AM) — a
 *   reliable heuristic that the morning-of context is still "last night."
 *
 *   If the combined drink count across yesterday + early-today ≥ threshold,
 *   we treat it as a single session. The event returned uses yesterday's anchor
 *   date so the suppressionKey is stable across the full morning.
 *
 * Returns null when no qualifying session is found.
 */

/**
 * Hours (local, 0–23) before which a "today" entry is considered still part of
 * last night's behavioral session. After midnight but before this cutoff, drinks
 * belong to the prior evening. At or after this hour they belong to the current day.
 */
const OVERNIGHT_CUTOFF_HOUR = 4;

/**
 * Returns true when `now` is within the overnight spillover window — i.e., after
 * midnight but before OVERNIGHT_CUTOFF_HOUR. Pure function; never calls new Date().
 */
function isOvernightSpillover(now: Date): boolean {
  return now.getHours() < OVERNIGHT_CUTOFF_HOUR;
}

function findAlcoholNightEvent(
  relevantContext: ContextEvent[],
  todayStr: string,
  now: Date = new Date(),
): ContextEvent | null {
  const yesterday = addDaysToStr(todayStr, -1);
  const isEarlyMorning = isOvernightSpillover(now);

  if (__DEV__) {
    console.log('[findAlcoholNightEvent] today:', todayStr, '→ yesterday:', yesterday,
      '| localHour:', now.getHours(), '| earlyMorning:', isEarlyMorning);
    const alcoholEvents = relevantContext.filter(e => e.type === 'alcohol_period');
    console.log('[findAlcoholNightEvent] alcohol events in context:', alcoholEvents.length,
      alcoholEvents.map(e => `date=${e.startDate} drinks=${e.metadata?.totalDrinks}`));
  }

  // Primary: event dated yesterday (standard case — drinks finished before midnight)
  let yesterdayEvent: ContextEvent | null = null;
  let yesterdayDrinks = 0;
  for (const event of relevantContext) {
    if (event.type !== 'alcohol_period' || event.startDate !== yesterday) continue;
    yesterdayEvent = event;
    yesterdayDrinks = (event.metadata?.totalDrinks as number | undefined) ?? 0;
    break;
  }

  // Early-morning supplement: drinks logged after midnight but still "tonight"
  // (before OVERNIGHT_CUTOFF_HOUR) belong to the same behavioural session.
  let earlyTodayDrinks = 0;
  if (isEarlyMorning) {
    for (const event of relevantContext) {
      if (event.type !== 'alcohol_period' || event.startDate !== todayStr) continue;
      earlyTodayDrinks = (event.metadata?.totalDrinks as number | undefined) ?? 0;
      break;
    }
  }

  const totalSessionDrinks = yesterdayDrinks + earlyTodayDrinks;

  if (totalSessionDrinks >= ALCOHOL_CONTRAST_MIN_DRINKS && yesterdayEvent !== null) {
    // Return a patched event with the combined drink count so the renderer
    // can describe the full session accurately. Date anchor = yesterday.
    return totalSessionDrinks !== yesterdayDrinks
      ? { ...yesterdayEvent, metadata: { ...yesterdayEvent.metadata, totalDrinks: totalSessionDrinks } }
      : yesterdayEvent;
  }

  // Edge case: drinks were ONLY logged after midnight (no yesterday entry at all),
  // e.g. the user opened the app at 1 AM for the first time. Treat early-today
  // as last night using a synthetic yesterday anchor so the story can still surface.
  if (earlyTodayDrinks >= ALCOHOL_CONTRAST_MIN_DRINKS && yesterdayEvent === null) {
    const earlyTodayEvent = relevantContext.find(
      e => e.type === 'alcohol_period' && e.startDate === todayStr,
    );
    if (earlyTodayEvent) {
      return { ...earlyTodayEvent, startDate: yesterday };
    }
  }

  if (__DEV__) {
    console.log('[findAlcoholNightEvent] → null (totalSessionDrinks:', totalSessionDrinks,
      '/ threshold:', ALCOHOL_CONTRAST_MIN_DRINKS, ')');
  }
  return null;
}

/**
 * Compute this week's total workout minutes vs. the personal historical weekly median.
 * Returns null when there isn't enough history to make a responsible claim.
 */
function computeWeeklyWorkoutElevation(
  timeline: HealthDayRecord[],
  todayStr: string,
): { weeklyTotal: number; medianWeekly: number; elevated: boolean } | null {
  const weekStart = addDaysToStr(todayStr, -6);
  const thisWeek  = timeline.filter(d => d.date >= weekStart && d.date <= todayStr);
  const weeklyTotal = thisWeek.reduce((s, d) => s + (d.workoutDurationMin ?? 0), 0);
  if (weeklyTotal === 0) return null;

  // Build historical weekly totals from prior weeks.
  const historicalTotals: number[] = [];
  for (let i = 1; i <= 8; i++) {
    const wStart = addDaysToStr(weekStart, -7 * i);
    const wEnd   = addDaysToStr(weekStart, -7 * i + 6);
    const wDays  = timeline.filter(d => d.date >= wStart && d.date <= wEnd);
    // Only count weeks where we have at least some workout data.
    if (wDays.some(d => d.workoutDurationMin !== undefined)) {
      historicalTotals.push(wDays.reduce((s, d) => s + (d.workoutDurationMin ?? 0), 0));
    }
  }

  if (historicalTotals.length < MIN_TRAINING_HISTORY_WEEKS) return null;

  const sorted = [...historicalTotals].sort((a, b) => a - b);
  const medianWeekly = sorted[Math.floor(sorted.length / 2)];
  if (medianWeekly < TRAINING_MEDIAN_FLOOR_MIN) return null; // baseline too low to be meaningful

  return { weeklyTotal, medianWeekly, elevated: false }; // elevated set by caller based on threshold
}

// ─── Human-readable labels for pattern-engine input signals ──────────────────
// Used only for ConfirmedPatternFinding rendering. Keeps "time spent training"
// language consistent with the product spec (never "training load/volume/intensity").
const CONFIRMED_PATTERN_INPUT_LABELS: Partial<Record<string, string>> = {
  workoutDurationMin:    'Time spent training',
  workoutCaloriesBurned: 'Time spent training',
  workoutCount:          'Workout frequency',
  steps:                 'Daily steps',
  sleepHours:            'Sleep',
  sleepScore:            'Sleep quality',
  totalAlcoholDrinks:    'Alcohol',
  caffeineMg:            'Caffeine',
  waterOz:               'Hydration',
};

// Maps PhysiologicalStateLayer finding labels back to HealthDayRecord keys.
// Used to match pattern-engine outcome signals to physio findings.
const PHYSIO_METRIC_KEY: Record<string, keyof HealthDayRecord> = {
  'Readiness':    'readiness',
  'HRV':          'hrv',
  'Sleep quality': 'sleepScore',
  'Sleep':        'sleepHours',
};

/**
 * Build a ConfirmedPatternFinding when a pattern-engine relationship with
 * PATTERN or CONSISTENT confidence has today's outcome metric meaningfully
 * off-baseline.
 *
 * Returns null when:
 *   - No patterns reach PATTERN or CONSISTENT tier
 *   - Today's outcome metric for any confirmed pattern is near_baseline (ordinary day)
 *   - Physio baseline is unavailable or has fewer than 2 metrics
 *
 * Only fires when both the pattern AND today's physiology warrant it.
 * The guard is the notably-off-baseline requirement — an existing pattern
 * on an ordinary day remains What's Connected territory.
 */
export function buildConfirmedPatternLayer(
  allPatterns: PatternResult[],
  physiologicalState: PhysiologicalStateLayer | null,
): ConfirmedPatternFinding | null {
  if (!physiologicalState || physiologicalState.findings.length < 2) return null;

  // Only use patterns the engine considers confirmed (same tiers shown in What's Connected).
  const confirmed = allPatterns.filter(
    p => p.confidenceTier === 'CONSISTENT' || p.confidenceTier === 'PATTERN',
  );
  if (confirmed.length === 0) return null;

  // We need today's physiology to be meaningfully off-baseline for the outcome metric.
  // near_baseline on a pattern outcome = ordinary day = no story.
  const notableFindings = physiologicalState.findings.filter(
    f => f.direction !== 'near_baseline' &&
         (f.magnitude === 'moderate' || f.magnitude === 'substantial'),
  );
  if (notableFindings.length === 0) return null;

  // Find the first confirmed pattern whose outcome signal has a notable finding today.
  // Prefer CONSISTENT over PATTERN; within the same tier prefer higher observationCount.
  const sorted = [...confirmed].sort((a, b) => {
    const tierOrder = { CONSISTENT: 0, PATTERN: 1 };
    const ta = tierOrder[a.confidenceTier as keyof typeof tierOrder] ?? 2;
    const tb = tierOrder[b.confidenceTier as keyof typeof tierOrder] ?? 2;
    if (ta !== tb) return ta - tb;
    return (b.observationCount ?? 0) - (a.observationCount ?? 0);
  });

  for (const pattern of sorted) {
    if (pattern.direction === 'neutral' || pattern.direction === 'unknown') continue;

    const outcomeFinding = notableFindings.find(
      f => PHYSIO_METRIC_KEY[f.metric] === pattern.outcomeSignal,
    );
    if (!outcomeFinding) continue;
    // Only above or below baseline qualify (never near_baseline — already filtered above)
    if (outcomeFinding.direction === 'near_baseline') continue;

    const inputLabel  = CONFIRMED_PATTERN_INPUT_LABELS[pattern.inputSignal]  ?? String(pattern.inputSignal);
    const outcomeLabel = outcomeFinding.metric; // already display-ready from PHYSIO_METRICS

    return {
      inputSignal:            pattern.inputSignal,
      outcomeSignal:          pattern.outcomeSignal,
      inputLabel,
      outcomeLabel,
      patternDirection:       pattern.direction === 'positive' ? 'positive' : 'negative',
      todayOutcomeDirection:  outcomeFinding.direction as 'above_baseline' | 'below_baseline',
      todayOutcomeMagnitude:  outcomeFinding.magnitude as 'moderate' | 'substantial',
      todayOutcomeValue:      outcomeFinding.actual,
      baselineValue:          outcomeFinding.baseline,
      observationCount:       pattern.observationCount,
      confidenceTier:         pattern.confidenceTier,
    };
  }

  return null;
}

/**
 * Build the context-response contrast layer.
 *
 * Returns null when:
 *   - No meaningful context is present
 *   - Physiological baseline is unavailable or has too few metrics
 *   - Physio response is 'insufficient' (only mild deviations, not story-worthy)
 *   - For stable stories: no behavioral disruption can be demonstrated
 *     (prevents manufacturing "stable despite disruption" when nothing disrupted)
 */
export function buildContextResponseContrastLayer(
  relevantContext: ContextEvent[],
  contextEventLayer: ContextEventLayer | null,
  physiologicalState: PhysiologicalStateLayer | null,
  timeline: HealthDayRecord[],
  today: HealthDayRecord,
  trainingGoal?: { body: string | null; perf: string | null },
  hydrationContext?: HydrationContext | null,
  now?: Date,
): ContextResponseContrastLayer | null {
  // ── Branch 2: Single-day alcohol / late-night (checked BEFORE any physio gate) ──────────
  // The drinking itself is the interpretive frame. We only need 1 physio metric to tell the
  // story — common when Oura hasn't synced today but HealthKit sleep or HRV is already in.
  // (Oura syncs can lag until mid-morning; HK metrics arrive earlier via Apple Watch.)
  const alcoholEvent = findAlcoholNightEvent(relevantContext, today.date, now);
  if (__DEV__) {
    console.log('[buildContextResponseContrastLayer] alcoholEvent:', alcoholEvent ? `found (date=${alcoholEvent.startDate} drinks=${alcoholEvent.metadata?.totalDrinks})` : 'null');
    console.log('[buildContextResponseContrastLayer] physiologicalState:', physiologicalState ? `${physiologicalState.findings.length} findings` : 'null');
  }
  if (alcoholEvent && physiologicalState && physiologicalState.findings.length >= 1) {
    const drinks = (alcoholEvent.metadata?.totalDrinks as number | undefined) ?? 0;
    const label  = drinks >= 3 ? 'A late night' : 'An evening out';

    // Direction-only classification: any off-baseline signal (including mild) qualifies.
    // With ≥1 finding guaranteed by the guard above, this is never null.
    const directional = physiologicalState.findings.filter(f => f.direction !== 'near_baseline');
    const alcoholPhysioResponse: PhysioResponseState =
      directional.length >= 1 ? 'responding' : 'stable';

    // Pass ALL findings (stable + responding) so the renderer can independently describe
    // what shifted and what stayed normal — enabling "sleep came in lower, but HRV is holding"
    // without pre-filtering here. Stable case: all findings are near_baseline by definition.

    return {
      contextType:           'alcohol_night',
      contextLabel:           label,
      physioResponse:         alcoholPhysioResponse,
      behavioralDisruptions: [],
      physioFindings:         physiologicalState.findings,
      perfGoal:               trainingGoal?.perf ?? null,
      hasCompetingContext:    false,
      isOngoing:              false,
      suppressionKey:         `alcohol_${alcoholEvent.startDate}_${alcoholPhysioResponse}`,
      todayActivityMin:       today.workoutDurationMin,
      todayActivityType:      today.primaryActivityType,
      hydrationContext:       hydrationContext ?? null,
      drinkCount:             drinks > 0 ? drinks : undefined,
    };
  }

  // ── Branch X: Short sleep + same-day activity (checked BEFORE Gate 1) ──────────
  // "Your night was shorter than usual. You also logged a run today."
  // Fires when sleep is notably below personal baseline AND a qualifying workout
  // exists today — without requiring alcohol, a logged life event, or a training goal.
  // sleepHours from HealthKit is sufficient: Oura doesn't need to have synced yet.
  // Does NOT fire when a life event (illness/travel/stress) provides a better frame.
  const sleepActivityFinding = physiologicalState?.findings.find(
    f => f.metric === 'Sleep' &&
         f.direction === 'below_baseline' &&
         (f.magnitude === 'moderate' || f.magnitude === 'substantial'),
  );
  const hasSleepActivityWorkout = (today.workoutDurationMin ?? 0) >= 15;
  if (
    !alcoholEvent &&
    sleepActivityFinding &&
    hasSleepActivityWorkout &&
    !findMeaningfulContextEvent(relevantContext, today.date)
  ) {
    return {
      contextType:           'sleep_activity',
      contextLabel:           'A shorter night',
      physioResponse:         'responding',
      behavioralDisruptions: [],
      physioFindings:         physiologicalState!.findings,
      perfGoal:               trainingGoal?.perf ?? null,
      hasCompetingContext:    false,
      isOngoing:              false,
      suppressionKey:         `sleep_activity_${today.date}_${sleepActivityFinding.magnitude}`,
      todayActivityMin:       today.workoutDurationMin,
      todayActivityType:      today.primaryActivityType,
      hydrationContext:       hydrationContext ?? null,
    };
  }

  // Gate 1: need physiological baseline with at least 2 metrics to compare.
  if (!physiologicalState || physiologicalState.findings.length < 2) return null;

  // Gate 2: strict physio response required for multi-day life events and training elevation.
  // Requires moderate/substantial deviation OR ≥2 near-baseline metrics.
  const physioClass = classifyPhysioResponse(physiologicalState);
  if (physioClass === 'insufficient') return null;

  const physioResponse: PhysioResponseState = physioClass;

  // Collect physio findings relevant for rendering.
  const physioFindings: MetricFinding[] = physioResponse === 'stable'
    ? physiologicalState.findings.filter(f => f.direction === 'near_baseline')
    : physiologicalState.findings.filter(
        f => f.direction !== 'near_baseline' &&
             (f.magnitude === 'moderate' || f.magnitude === 'substantial'),
      );

  // ── Branch 1: Multi-day life context events ──────────────────────────────
  const meaningfulEvent = findMeaningfulContextEvent(relevantContext, today.date);
  if (meaningfulEvent) {
    // Is training also elevated? (affects rendering when both are present)
    let trainingAlsoElevated = false;
    if (trainingGoal?.perf) {
      const te = computeWeeklyWorkoutElevation(timeline, today.date);
      if (te) {
        const threshold = TRAINING_ELEVATED_THRESHOLD_PERF;
        trainingAlsoElevated = te.weeklyTotal > te.medianWeekly * (1 + threshold);
      }
    }

    // For 'stable' stories: we need evidence of behavioral disruption to avoid
    // claiming "stable despite disruption" when nothing was actually disrupted.
    const behavioralDisruptions = contextEventLayer?.hasEnoughEvidence
      ? contextEventLayer.metricChanges
      : [];

    const hasDisruption =
      behavioralDisruptions.length > 0 ||
      meaningfulEvent.type === 'illness'; // illness is inherently disruptive

    if (physioResponse === 'stable' && !hasDisruption) {
      // Travel/stress logged but no behavioral evidence of disruption →
      // Not enough to claim "stable despite disruption."
      return null;
    }

    const isOngoing = !meaningfulEvent.endDate || meaningfulEvent.endDate >= today.date;
    const eventLabel = meaningfulEvent.label ??
      (meaningfulEvent.type === 'travel' || meaningfulEvent.type === 'vacation' ? 'Travel'
        : meaningfulEvent.type === 'illness'          ? 'Illness'
        : meaningfulEvent.type === 'stressful_period' ? 'A stressful period'
        : meaningfulEvent.type === 'training_block'   ? 'Your training block'
        : 'A recent life event');

    const contextType: ContextResponseContrastLayer['contextType'] =
      meaningfulEvent.type === 'vacation' ? 'travel'
        : (meaningfulEvent.type as ContextResponseContrastLayer['contextType']);

    return {
      contextType,
      contextLabel: eventLabel,
      physioResponse,
      behavioralDisruptions,
      physioFindings,
      perfGoal:           trainingGoal?.perf ?? null,
      hasCompetingContext: trainingAlsoElevated,
      isOngoing,
      suppressionKey: `${meaningfulEvent.id}_${physioResponse}`,
    };
  }

  // ── Branch 3: Training elevation (only when no life event is active) ─────
  if (trainingGoal?.perf) {
    const te = computeWeeklyWorkoutElevation(timeline, today.date);
    if (te) {
      const threshold = TRAINING_ELEVATED_THRESHOLD_PERF;
      if (te.weeklyTotal > te.medianWeekly * (1 + threshold)) {
        // Compute week start for the suppression key.
        const weekStart = addDaysToStr(today.date, -6);

        return {
          contextType:        'training_elevated',
          contextLabel:        'Training',
          physioResponse,
          behavioralDisruptions: [], // training time IS the behavioral signal
          physioFindings,
          perfGoal:           trainingGoal.perf,
          hasCompetingContext: false,
          isOngoing:           true,
          suppressionKey: `training_${weekStart}_${physioResponse}`,
        };
      }
    }
  }

  return null;
}

// ─── buildStoryEpisode ─────────────────────────────────────────────────────────

/**
 * Convert raw health data into a structured StoryEpisode.
 *
 * Call buildEnhancedStory() in pattern-language.ts to render this to text.
 */
export function buildStoryEpisode(
  synthesis: SynthesisResult,
  timeline: HealthDayRecord[],
  today: HealthDayRecord,
  trainingGoal?: { body: string | null; perf: string | null },
  now?: Date,
): StoryEpisode {
  const eventWindows = synthesis.eventWindows ?? [];
  const allPatterns  = synthesis.allPatterns  ?? [];

  // Layer 1: Most relevant event window.
  // Ongoing events take priority over completed ones (the user is currently IN them).
  // Within each group, sort by most recent startDate.
  const mostRecentWindow = [...eventWindows].sort((a, b) => {
    if (a.isOngoing !== b.isOngoing) return a.isOngoing ? -1 : 1;
    return b.event.startDate.localeCompare(a.event.startDate);
  })[0];
  const contextEvent = mostRecentWindow
    ? buildContextEventLayer(mostRecentWindow)
    : null;

  // Layer 2: Behavioral associations (alcohol, caffeine, sauna, cold plunge,
  //           gratitude, electrolytes, water/hydration)
  const behavioralFindings = buildBehavioralFindings(timeline, allPatterns);

  // Layer 3: Today vs personal baseline
  const physiologicalState = buildPhysiologicalState(today, timeline);

  // Layer 4: Event transition narrative
  const transition = buildTransitionLayer(eventWindows);

  // Layer 5: Recent trajectory
  const currentDirection = buildCurrentDirectionLayer(timeline, today);

  // Layer 6: Nutrition (completeness-gated — never surfaces unless logging is sufficient)
  const nutritionLayer = buildNutritionLayer(timeline);

  // Layer 7: Hydration context.
  // When a transition exists (e.g. travel → illness), use the PRECEDING event's window
  // for hydration — that's where hydration data is most relevant and available.
  // Falls back to the most recent event window, then to last 14 days.
  const hydrationSourceWindow = transition
    ? eventWindows.find(w => w.event.type === transition.precedingEventType)
    : mostRecentWindow;
  const hydrationContext = buildHydrationContext(
    timeline,
    hydrationSourceWindow?.event.startDate,
    hydrationSourceWindow?.event.endDate,
    synthesis.waterGoalOz,
    today.date,
  );

  // Layer 8: Interpretation — cross-layer pattern synthesis
  const interpretation = buildInterpretationLayer(
    contextEvent,
    behavioralFindings,
    transition,
    physiologicalState,
  );

  // Layer 9: Aftermath — post-event recovery signals (completed events only)
  const aftermath =
    mostRecentWindow && contextEvent && !contextEvent.isOngoing
      ? buildAftermathLayer(
          timeline,
          mostRecentWindow.event.type,
          mostRecentWindow.event.endDate,
          mostRecentWindow.event.startDate,
          false,
        )
      : null;

  // Layer 10: NextFocus — evidence-grounded priorities
  const nextFocus = buildNextFocusLayer(
    contextEvent,
    currentDirection,
    behavioralFindings,
    hydrationContext,
  );

  // Layer 11: FutureLesson — forward-looking lesson for next similar event
  const futureLesson = buildFutureLessonLayer(contextEvent, behavioralFindings);

  // ── Story-worthiness gate (two layers) ────────────────────────────────────
  //
  // GATE 1 — Evidence: multi-factor data must exist.
  //   Rejected: single metric state, single trajectory signal, single-signal event.
  //
  // GATE 2 — Insight Value: the finding must be non-obvious.
  //   Question: could the user infer this from today's dashboard, one trend chart,
  //   or the event itself?
  //   If yes → NOT a Story. Surface it in Home or Trends instead.
  //
  // BOTH gates must pass. Having data ≠ having something worth telling.
  //
  // The four structural conditions that pass BOTH gates:
  //
  //   1. transition — two events connected temporally; the second follows within days
  //      of the first. Requires two logged events, both qualifying data windows, and a
  //      preceding-event metric change. The temporal connection between a trip and a
  //      subsequent illness is non-obvious from any single chart view.
  //
  //   2. strong_contextual_pattern behavioral finding — 3+ occurrences where both the
  //      direct behavioral analysis AND the statistical pattern engine independently
  //      agree on the relationship. Two independent data paths must agree. This is
  //      the only behavioral tier that guarantees "you wouldn't see this yourself."
  //
  //   3. conflicting physiological state (substantial) — HRV substantially above
  //      baseline while readiness is substantially below (or vice versa). An
  //      unexpected contradiction between metrics that share the same root cause.
  //
  //   4. strong_contextual_pattern nutrition finding — same dual-corroboration
  //      standard as behavioral.
  //
  // NOT passing this gate (removed from prior version):
  //   contextEvent.metricChanges.length >= 2  → "sleep and steps both changed during
  //     travel" is visible in Trends. Two bars moving together is not an insight.
  //   aftermath.hasEvidence alone             → "readiness recovered after travel"
  //     is expected. Recovery after disruption is not a story.
  //   behavioral finding at repeated_pattern  → 4+ same-direction occurrences without
  //     independent corroboration. Compelling longitudinal data, but "X appeared
  //     alongside Y" is not specific enough to be an aha without rendering the count
  //     and direction clearly — which requires the engine to produce more than it
  //     currently does for this tier.
  //
  const surfaceWorthyCore = Boolean(
    // Temporal multi-event sequence (non-obvious by structural definition)
    transition !== null ||
    // Behavioral relationship corroborated by two independent data paths
    behavioralFindings.some(f => f.evidence.strength === 'strong_contextual_pattern') ||
    // Conflicting signals: substantially above baseline on one metric, substantially
    // below on another — an unexpected pattern that requires context to understand
    (physiologicalState?.conflicting === true &&
     physiologicalState.findings.some(f => f.magnitude === 'substantial')) ||
    // Nutrition corroborated by two independent data paths
    nutritionLayer.findings.some(f => f.evidence.strength === 'strong_contextual_pattern'),
  );

  // Alcohol night stories bypass the surfaceWorthyCore gate when there is a
  // confirmed yesterday alcohol event. The drinking IS the interpretive frame —
  // conflicting physio signals (e.g. OK readiness despite bad sleep) are explained
  // BY the drinking, not competing with it.
  //
  // We only bypass for the standard case (drinks dated yesterday). The early-morning
  // edge case (drinks logged after midnight, dated today) remains gated by
  // surfaceWorthyCore to avoid a time-of-day flap at the overnight boundary.
  const yesterdayStr = addDaysToStr(today.date, -1);
  const hasAlcoholYesterday = synthesis.relevantContext.some(
    (e) => e.type === 'alcohol_period' && e.startDate === yesterdayStr,
  );

  // When there are confirmed yesterday drinks, compute the contrast layer regardless
  // of surfaceWorthyCore so the alcohol story can surface.
  const earlyContrast = (surfaceWorthyCore && !hasAlcoholYesterday)
    ? null
    : buildContextResponseContrastLayer(
        synthesis.relevantContext,
        contextEvent,
        physiologicalState,
        timeline,
        today,
        trainingGoal,
        hydrationContext,
        now,
      );

  const alcoholFired = earlyContrast?.contextType === 'alcohol_night';

  // When alcohol fires, override surfaceWorthyCore → false so the contrast render
  // path in renderStoryEpisode is chosen (it checks !surfaceWorthyCore).
  const effectiveSurfaceWorthyCore = alcoholFired ? false : surfaceWorthyCore;

  const contextResponseContrast = alcoholFired
    ? earlyContrast                          // alcohol story wins
    : surfaceWorthyCore
      ? null                                 // core gates block all other contrasts
      : earlyContrast;                       // no core gate — use whatever contrast found

  // Confirmed-pattern bridge: only computed when neither core gates nor contrast fired.
  const confirmedPatternLayer = (effectiveSurfaceWorthyCore || contextResponseContrast !== null)
    ? null
    : buildConfirmedPatternLayer(allPatterns, physiologicalState);

  // Contextual pattern for synthesis augmentation: computed independently so
  // alcohol_night / sleep_activity stories can reference a known relationship
  // when today's state actively matches the pattern.
  const contextualPattern = (!effectiveSurfaceWorthyCore && contextResponseContrast !== null)
    ? buildConfirmedPatternLayer(allPatterns, physiologicalState)
    : null;

  const surfaceWorthy = effectiveSurfaceWorthyCore || contextResponseContrast !== null || confirmedPatternLayer !== null;

  if (__DEV__) {
    console.log('[buildStoryEpisode] today.date:', today.date,
      '| surfaceWorthyCore:', effectiveSurfaceWorthyCore,
      '| alcoholFired:', alcoholFired,
      '| contrastType:', contextResponseContrast?.contextType ?? 'null',
      '| confirmedPattern:', confirmedPatternLayer ? 'yes' : 'null',
      '| surfaceWorthy:', surfaceWorthy);
    if (physiologicalState) {
      console.log('[buildStoryEpisode] physio findings:', physiologicalState.findings.map(f => `${f.metric}=${f.direction}/${f.magnitude}`));
    } else {
      console.log('[buildStoryEpisode] physiologicalState: null (today has no physio metrics or < 7 baseline samples)');
    }
  }

  return {
    contextEvent,
    behavioralFindings,
    physiologicalState,
    transition,
    currentDirection,
    nutritionLayer,
    hydrationContext,
    interpretation,
    aftermath,
    nextFocus,
    futureLesson,
    contextResponseContrast,
    confirmedPatternLayer,
    contextualPattern,
    // Populated externally by the Context screen after detectDowPatterns() runs.
    // buildStoryEpisode() does not call the DOW engine directly — the caller
    // assembles the full StoryEpisode from both sources.
    dowObservations: null,
    surfaceWorthy,
    surfaceWorthyCore: effectiveSurfaceWorthyCore,
  };
}
