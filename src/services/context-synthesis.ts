/**
 * context-synthesis.ts
 *
 * Cross-signal synthesis layer.
 * Takes PatternResults + today's health snapshot + active context events
 * and produces a single structured interpretation foundation.
 *
 * This is the SINGLE shared foundation for:
 *   - Future Context UI
 *   - "Talk more about your insights" chat bridge
 *
 * All output is structured data. No AI prose is generated here.
 * No LLM calls are made here.
 *
 * Contradiction prevention:
 *   If any signal argues for recovery, no simultaneous "push harder" signal
 *   is surfaced as a recommendation. Raw observations are always preserved.
 *
 * Privacy:
 *   Cycle/gratitude free text is never included.
 *   ContextSummary contains only minimum structured findings for Chat.
 */

import {
  buildHealthTimelineFromStorage,
  detectPatterns,
  type PatternResult,
  type HealthDayRecord,
  type EventWindowAnalysis,
  type EventTypePattern,
  type ConfidenceTier,
  type Direction,
} from './pattern-engine';
import { fetchContextSources, type ContextEvent } from './context-events';
import { RELATIONSHIP_REGISTRY, SOURCE_LABELS, type SourceName } from './pattern-registry';
import { CORRELATION_LANGUAGE } from '../constants/correlation-language';

// ─── Types ─────────────────────────────────────────────────────────────────────

export type SignalInterpretation = 'favorable' | 'concerning' | 'neutral' | 'mixed';

export interface SignalSnapshot {
  signal: string;
  value: number;
  /** Comparison vs this user's typical range */
  vsBaseline: 'above' | 'below' | 'within' | 'unknown';
  interpretation: SignalInterpretation;
  source: string;
}

export interface ConflictDescriptor {
  signalA: string;
  signalB: string;
  description: string;
  /** Which signal's recommendation was suppressed to resolve the conflict */
  suppressedRecommendation?: string;
}

export interface ThemeDescriptor {
  theme: 'recovery_needed' | 'performing_well' | 'mixed_signals' | 'insufficient_data';
  primarySignal: string | null;
  rationale: string[];
}

export interface SynthesisResult {
  generatedAt: string;
  /** Overall theme — the primary lens for today */
  primaryTheme: ThemeDescriptor;
  /** Positive signals from today's data */
  supportingSignals: SignalSnapshot[];
  /** Signals arguing against exertion or indicating stress */
  concerningSignals: SignalSnapshot[];
  /** Explicit contradiction pairs that were detected and resolved */
  conflictingSignals: ConflictDescriptor[];
  /** Active or recent ContextEvents relevant to today */
  relevantContext: ContextEvent[];
  /** Best-evidenced pattern from the pattern engine */
  strongestConnection: PatternResult | null;
  /** All patterns passed in, for full access */
  allPatterns: PatternResult[];
  /** All analyzed event windows (completed and ongoing) */
  eventWindows: EventWindowAnalysis[];
  /** Event type pattern if multiple events of the same type exist */
  eventTypePattern: EventTypePattern | null;
  /** True when readiness < 65 — gates any push-harder recommendations */
  recoveryConstrained: boolean;
  /** Source provenance for the full synthesis */
  sources: string[];
  /** User's daily water goal in oz, passed through from SynthesisInput. */
  waterGoalOz?: number;
}

// ─── ContextSummary (for Chat bridge) ─────────────────────────────────────────

/**
 * Minimum structured findings to pass to the Chat experience
 * when the user explicitly chooses to discuss Context.
 *
 * DO NOT automatically send to Claude.
 * DO NOT include raw health timelines.
 * DO NOT include cycle/gratitude journal text.
 */
export interface ContextSummary {
  /** ISO timestamp of when this summary was built */
  generatedAt: string;
  /** Current theme and rationale bullets */
  currentTheme: ThemeDescriptor;
  /** Today's key signals (value + interpretation) */
  todaySignals: SignalSnapshot[];
  /** The single strongest pattern from the engine, if any */
  strongestConnection: {
    description: string;
    evidenceTier: ConfidenceTier;
    observationCount: number;
    direction: Direction;
    sources: string[];
  } | null;
  /** Evidence tiers of all surfaced patterns */
  patternSummary: Array<{ id: string; tier: ConfidenceTier; direction: Direction }>;
  /** Active life context (event types only — no notes or free text) */
  activeContextTypes: string[];
  /** Provenance labels for the UI "Based on:" display */
  provenanceLabels: string[];
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function isRecoveryConstrained(today: HealthDayRecord): boolean {
  return (today.readiness ?? 0) > 0 && (today.readiness ?? 0) < 65;
}

function isSleepDeficit(today: HealthDayRecord): boolean {
  return (today.sleepHours ?? 999) < 6 || (today.sleepScore ?? 999) < 65;
}

function provenanceLabels(sources: string[]): string[] {
  return [...new Set(sources.map((s) => SOURCE_LABELS[s as SourceName] ?? s))];
}

function snapshotSignal(
  label: string,
  value: number | undefined,
  source: string,
  goodThreshold: number,
  concernThreshold: number,
  higherIsBetter: boolean,
  baselineValue?: number
): SignalSnapshot | null {
  if (value === undefined) return null;
  const isFavorable = higherIsBetter ? value >= goodThreshold : value <= goodThreshold;
  const isConcerning = higherIsBetter ? value <= concernThreshold : value >= concernThreshold;

  let vsBaseline: SignalSnapshot['vsBaseline'] = 'unknown';
  if (baselineValue !== undefined) {
    const delta = value - baselineValue;
    vsBaseline = Math.abs(delta) < 3 ? 'within' : delta > 0 ? 'above' : 'below';
  }

  return {
    signal: label,
    value,
    vsBaseline,
    interpretation: isFavorable ? 'favorable' : isConcerning ? 'concerning' : 'neutral',
    source,
  };
}

// ─── synthesizeContext ─────────────────────────────────────────────────────────

export interface SynthesisInput {
  today: HealthDayRecord;
  patterns: PatternResult[];
  activeContextEvents: ContextEvent[];
  /** All analyzed event windows (completed and ongoing). Defaults to []. */
  eventWindows?: EventWindowAnalysis[];
  eventTypePattern?: EventTypePattern | null;
  /** Optional: user's baseline HRV for comparison */
  baselineHrv?: number;
  /** Optional: user's baseline readiness for comparison */
  baselineReadiness?: number;
  /** Optional: user's daily water goal in oz (from saved profile). Used by buildHydrationContext. */
  waterGoalOz?: number;
}

export function synthesizeContext(input: SynthesisInput): SynthesisResult {
  const {
    today,
    patterns,
    activeContextEvents,
    eventWindows = [],
    eventTypePattern = null,
    baselineHrv,
    baselineReadiness,
  } = input;

  const recoveryConstrained = isRecoveryConstrained(today);
  const sleepDeficit        = isSleepDeficit(today);

  // ── Build signal snapshots ─────────────────────────────────────────────────

  const candidateSignals: (SignalSnapshot | null)[] = [
    snapshotSignal('Readiness',   today.readiness,  'Oura Readiness', 75, 60, true,  baselineReadiness),
    snapshotSignal('HRV',         today.hrv,        'Oura HRV',       50, 35, true,  baselineHrv),
    snapshotSignal('Sleep hours', today.sleepHours, 'Oura Sleep',     7.5, 6, true),
    snapshotSignal('Sleep score', today.sleepScore, 'Oura Sleep',     80, 65, true),
  ];

  const allSignals = candidateSignals.filter((s): s is SignalSnapshot => s !== null);
  const supportingSignals = allSignals.filter((s) => s.interpretation === 'favorable');
  const concerningSignals = allSignals.filter((s) => s.interpretation === 'concerning');

  // ── Contradiction detection ────────────────────────────────────────────────
  // Identify HRV-favorable + readiness-concerning conflict (the classic case)

  const conflictingSignals: ConflictDescriptor[] = [];
  const hrvSignal       = allSignals.find((s) => s.signal === 'HRV');
  const readinessSignal = allSignals.find((s) => s.signal === 'Readiness');

  if (
    hrvSignal?.interpretation === 'favorable' &&
    readinessSignal?.interpretation === 'concerning'
  ) {
    conflictingSignals.push({
      signalA: 'HRV',
      signalB: 'Readiness',
      description:
        `HRV is favorable but readiness is below threshold. ` +
        `HRV is preserved as a positive observation, but no push-harder recommendation is made.`,
      suppressedRecommendation: 'increase training intensity',
    });
  }

  // ── Pattern filtering: contradiction prevention ────────────────────────────
  // Patterns that suggest increased training are suppressed when recovery is constrained.
  // Raw patterns are kept in allPatterns for full access — only the PRIMARY recommendation
  // is adjusted.

  const synthesisPatterns = patterns.filter((p) => {
    // The workout_duration_next_readiness/hrv patterns in the "high workout → low recovery"
    // direction could be misread as "work out more." Suppress from primary theme if constrained.
    if (!recoveryConstrained && !sleepDeficit) return true;
    // Keep all patterns — contradiction is handled at theme level, not by removing evidence
    return true;
  });

  // Patterns that suggest "push harder": only surface if not recovery-constrained
  const canRecommendPush = !recoveryConstrained && !sleepDeficit;

  // ── Strongest connection ───────────────────────────────────────────────────
  // Prefer synthesis-eligible patterns, then highest tier, then most observations

  const eligiblePatterns = patterns.filter((p) => {
    const rel = p.relationshipId;
    // drinking patterns are always worth surfacing as observations (not push recommendations)
    return true;
  });

  const strongestConnection = eligiblePatterns[0] ?? null; // already sorted by detectPatterns

  // ── Primary theme ──────────────────────────────────────────────────────────

  const allSourcesSet = new Set<string>();
  patterns.forEach((p) => p.sources.forEach((s) => allSourcesSet.add(s)));
  if (today.readiness !== undefined)  allSourcesSet.add('oura_readiness');
  if (today.hrv !== undefined)        allSourcesSet.add('oura_hrv');
  if (today.sleepHours !== undefined) allSourcesSet.add('oura_sleep');

  let theme: ThemeDescriptor;

  if (allSignals.length === 0) {
    theme = {
      theme: 'insufficient_data',
      primarySignal: null,
      rationale: ['No health signals are available for today.'],
    };
  } else if (recoveryConstrained || sleepDeficit) {
    theme = {
      theme: 'recovery_needed',
      primarySignal: recoveryConstrained ? 'Readiness' : 'Sleep',
      rationale: [
        recoveryConstrained ? `Readiness is ${today.readiness} — below the recovery threshold.` : '',
        sleepDeficit       ? `Sleep is lower than optimal.` : '',
        today.hrv !== undefined && hrvSignal?.interpretation === 'favorable'
          ? `HRV is a positive signal — noted as an observation, not an action item.`
          : '',
      ].filter(Boolean),
    };
  } else if (concerningSignals.length === 0 && supportingSignals.length > 0) {
    theme = {
      theme: 'performing_well',
      primarySignal: supportingSignals[0].signal,
      rationale: supportingSignals.map((s) => `${s.signal} is ${s.value} — favorable.`),
    };
  } else if (concerningSignals.length > 0 && supportingSignals.length > 0) {
    theme = {
      theme: 'mixed_signals',
      primarySignal: concerningSignals[0].signal,
      rationale: [
        ...concerningSignals.map((s) => `${s.signal} is ${s.value} — below optimal.`),
        ...supportingSignals.map((s) => `${s.signal} is ${s.value} — favorable.`),
      ],
    };
  } else {
    theme = {
      theme: 'mixed_signals',
      primarySignal: null,
      rationale: ['Signals are available but do not clearly point in one direction.'],
    };
  }

  return {
    generatedAt: new Date().toISOString(),
    primaryTheme: theme,
    supportingSignals,
    concerningSignals,
    conflictingSignals,
    relevantContext: activeContextEvents,
    strongestConnection,
    allPatterns: patterns,
    eventWindows,
    eventTypePattern,
    recoveryConstrained,
    sources: [...allSourcesSet],
    waterGoalOz: input.waterGoalOz,
  };
}

// ─── buildContextSummary ───────────────────────────────────────────────────────

/**
 * Produces the minimum structured summary to pass to the Chat experience.
 * Called ONLY when user explicitly taps "Talk more about your insights."
 * DO NOT automatically inject into Chat system prompts.
 *
 * Privacy: no cycle notes, no gratitude text, no raw health timelines.
 */
export function buildContextSummary(synthesis: SynthesisResult): ContextSummary {
  const sc = synthesis.strongestConnection;

  return {
    generatedAt: synthesis.generatedAt,
    currentTheme: synthesis.primaryTheme,
    todaySignals: [...synthesis.supportingSignals, ...synthesis.concerningSignals],
    strongestConnection: sc
      ? {
          description:    `${sc.inputCondition} ${CORRELATION_LANGUAGE.ASSOCIATED_WITH} ${sc.outcomeSignal}`,
          evidenceTier:   sc.confidenceTier,
          observationCount: sc.observationCount,
          direction:      sc.direction,
          sources:        sc.sources,
        }
      : null,
    patternSummary: synthesis.allPatterns.map((p) => ({
      id:        p.relationshipId,
      tier:      p.confidenceTier,
      direction: p.direction,
    })),
    activeContextTypes: synthesis.relevantContext.map((e) => e.type),
    provenanceLabels: provenanceLabels(synthesis.sources),
  };
}

// ─── validateEngineWithLocalData ──────────────────────────────────────────────

/**
 * Reads available local storage (lifestyle logs, context events) and runs the
 * pattern engine in READ-ONLY mode.
 *
 * Note: This function produces a partial timeline because Oura and HealthKit
 * data are not available without in-app API calls. For full validation, call
 * this from within the running app after Oura/HK data has been fetched.
 *
 * Does NOT modify any stored data. Does NOT fabricate context events.
 */
export async function validateEngineWithLocalData(): Promise<ValidationReport> {
  const timeline = await buildHealthTimelineFromStorage();
  const sources  = await fetchContextSources();
  const patterns = detectPatterns(timeline);

  const daysWithOura  = timeline.filter((d) => d.sleepHours !== undefined || d.readiness !== undefined).length;
  const daysWithHk    = timeline.filter((d) => d.hkSteps !== undefined || d.workoutDurationMin !== undefined).length;
  const daysWithDrink = timeline.filter((d) => (d.totalAlcoholDrinks ?? 0) > 0).length;
  const daysWithCaf   = timeline.filter((d) => d.caffeineMg !== undefined).length;

  const insufficient = RELATIONSHIP_REGISTRY.filter(
    (r) => !patterns.find((p) => p.relationshipId === r.id)
  ).map((r) => ({ id: r.id, reason: 'below minDayPairs or no data' }));

  return {
    timelineDays:    timeline.length,
    daysWithOura,
    daysWithHk,
    daysWithDrink,
    daysWithCaffeine: daysWithCaf,
    contextEventCount: sources.userEvents.length,
    detectedPatterns: patterns.map((p) => ({
      id:         p.relationshipId,
      tier:       p.confidenceTier,
      direction:  p.direction,
      n:          p.observationCount,
      absDiff:    p.absoluteDifference,
      sources:    p.sources,
    })),
    insufficientRelationships: insufficient,
    note: daysWithOura === 0
      ? 'No Oura data found in local storage. Run this validation from within the app after Oura sync.'
      : undefined,
  };
}

export interface ValidationReport {
  timelineDays: number;
  daysWithOura: number;
  daysWithHk: number;
  daysWithDrink: number;
  daysWithCaffeine: number;
  contextEventCount: number;
  detectedPatterns: Array<{
    id: string;
    tier: ConfidenceTier;
    direction: Direction;
    n: number;
    absDiff: number | null;
    sources: string[];
  }>;
  insufficientRelationships: Array<{ id: string; reason: string }>;
  note?: string;
}
