/**
 * pattern-language.ts
 *
 * Human-readable display strings for PatternResult fields.
 * All output is deterministic — no LLM inference.
 */

import type { PatternResult, ConfidenceTier, Direction, PeriodStats } from '../services/pattern-engine';
import type { SignalKey } from '../services/pattern-registry';
import { SIGNAL_FAMILY } from '../services/pattern-registry';
import type { DowPatternResult } from '../services/dow-pattern-engine';

// ─── Signal labels ──────────────────────────────────────────────────────────────

export const SIGNAL_LABEL: Record<SignalKey, string> = {
  sleepHours:            'Sleep',
  sleepScore:            'Sleep Quality',
  hrv:                   'HRV',
  readiness:             'Readiness',
  steps:                 'Steps',
  workoutDurationMin:    'Activity',
  workoutCaloriesBurned: 'Calories Burned',
  workoutCount:          'Workouts',
  totalAlcoholDrinks:    'Drinking',
  caffeineMg:            'Caffeine',
  waterOz:               'Hydration',
  calories:              'Nutrition',
  protein:               'Nutrition',
  carbs:                 'Nutrition',
  fat:                   'Nutrition',
  hasSaunaSession:       'Sauna',
  hasColdPlungeSession:  'Cold Plunge',
  gratitudeSessions:     'Gratitude',
  electrolytesLogged:    'Electrolytes',
  stressHighMinutes:     'Stress',
  recoveryHighMinutes:   'Recovery Time',
};

/** Short version for chips and tight spaces */
export const SIGNAL_LABEL_SHORT: Record<SignalKey, string> = {
  ...SIGNAL_LABEL,
  sleepScore:            'Sleep score',
  workoutDurationMin:    'Activity',
  workoutCaloriesBurned: 'Cal burned',
  totalAlcoholDrinks:    'Drinking',
  stressHighMinutes:     'Stress',
  recoveryHighMinutes:   'Recovery',
};

// ─── Evidence tier labels ──────────────────────────────────────────────────────

export const TIER_LABEL: Record<ConfidenceTier, string> = {
  INSUFFICIENT: 'Not enough data',
  EARLY:        'Early pattern',
  PATTERN:      'Pattern',
  CONSISTENT:   'Consistent pattern',
};

export const TIER_DESCRIPTION: Record<ConfidenceTier, string> = {
  INSUFFICIENT: 'More history is needed before anything meaningful can be said.',
  EARLY:        'A trend is forming, but not yet consistent enough to rely on.',
  PATTERN:      'Seen consistently across your history.',
  CONSISTENT:   'A reliable pattern across a significant portion of your history.',
};

// ─── Pattern card text ─────────────────────────────────────────────────────────

/** "SLEEP → READINESS" */
export function patternHeadline(p: PatternResult): string {
  return `${SIGNAL_LABEL[p.inputSignal].toUpperCase()} → ${SIGNAL_LABEL[p.outcomeSignal].toUpperCase()}`;
}

// ── Input: personal possessive subject for a high-input day ────────────────────
// "Your more active days have usually been followed by..."
const SIGNAL_PERSONAL_SUBJECT: Partial<Record<SignalKey, string>> = {
  sleepHours:            'your longer sleep nights',
  sleepScore:            'your best sleep-quality days',
  steps:                 'your more active days',
  workoutDurationMin:    'your higher-training days',
  workoutCount:          'your days with more workouts',
  waterOz:               'your higher-hydration days',
  calories:              'your higher-calorie days',
  protein:               'your higher-protein days',
  totalAlcoholDrinks:    'your higher-drinking evenings',
  caffeineMg:            'your higher-caffeine days',
  hrv:                   'your higher-HRV days',
  readiness:             'your stronger-readiness days',
  hasSaunaSession:       'your sauna days',
  hasColdPlungeSession:  'your cold plunge days',
};

// ── Input: noun form for count-based sentences ────────────────────────────────
// "On {count} of your last {obs} higher-training days, readiness was lower."
const SIGNAL_COUNTED_SUBJECT: Partial<Record<SignalKey, string>> = {
  sleepHours:            'longer sleep nights',
  sleepScore:            'stronger sleep-quality days',
  steps:                 'more active days',
  workoutDurationMin:    'higher-training days',
  workoutCount:          'days with more workouts',
  waterOz:               'higher-hydration days',
  calories:              'higher-calorie days',
  protein:               'higher-protein days',
  totalAlcoholDrinks:    'higher-drinking evenings',
  caffeineMg:            'higher-caffeine days',
  hrv:                   'higher-HRV days',
  readiness:             'stronger-readiness days',
};

// ── Same-day "when X" phrases ─────────────────────────────────────────────────
// "When your sleep quality is stronger, your readiness has usually been stronger too."
const SIGNAL_WHEN_PHRASE: Partial<Record<SignalKey, string>> = {
  sleepScore:         'when your sleep quality is stronger',
  sleepHours:         'on your longer sleep nights',
  hrv:                'when your HRV is higher',
  readiness:          'when your readiness is higher',
  steps:              'on your more active days',
  workoutDurationMin: 'on your higher-training days',
};

// ── Outcome descriptors (higher / lower) ─────────────────────────────────────
const SIGNAL_OUTCOME_HIGHER: Partial<Record<SignalKey, string>> = {
  sleepHours:            'longer sleep',
  sleepScore:            'stronger sleep quality',
  hrv:                   'higher HRV',
  readiness:             'higher readiness',
  steps:                 'more steps',
  workoutDurationMin:    'more activity',
  workoutCaloriesBurned: 'more calories burned',
};

const SIGNAL_OUTCOME_LOWER: Partial<Record<SignalKey, string>> = {
  sleepHours:            'shorter sleep',
  sleepScore:            'lower sleep quality',
  hrv:                   'lower HRV',
  readiness:             'lower readiness',
  steps:                 'fewer steps',
  workoutDurationMin:    'less activity',
  workoutCaloriesBurned: 'fewer calories burned',
};

// ── "your X" label for the outcome in same-day sentences ─────────────────────
const SIGNAL_OUTCOME_YOUR: Partial<Record<SignalKey, string>> = {
  sleepHours:         'your sleep',
  sleepScore:         'your sleep quality',
  hrv:                'your HRV',
  readiness:          'your readiness',
  steps:              'your step count',
  workoutDurationMin: 'your activity',
};

/**
 * Main card sentence — personal, observational, pattern-strength-aware.
 *
 * Language rules:
 *   - Personal: "your more active days" not "moving more"
 *   - Observational: "followed by" / "lined up with" — no causal verbs
 *   - Tier-aware: EARLY → "so far / often"; CONSISTENT → "consistently"; else "usually"
 *   - Count-based when conditionCount is reliable (≥5 high-input days, ≥12 total)
 *   - Graceful fallback for signals without personal phrases
 */
export function patternSentence(p: PatternResult): string {
  const isNextDay    = p.temporalRelationship === 'next_day';
  const isEarly      = p.confidenceTier === 'EARLY';
  const isConsistent = p.confidenceTier === 'CONSISTENT';
  const adverb       = isConsistent ? 'consistently' : isEarly ? 'often' : 'usually';

  const dir         = p.direction;
  const outcomeName = SIGNAL_LABEL[p.outcomeSignal].toLowerCase();
  const dirWord     = dir === 'positive' ? 'higher' : dir === 'negative' ? 'lower' : 'similar';

  const subject      = SIGNAL_PERSONAL_SUBJECT[p.inputSignal];
  const outcomeHigh  = SIGNAL_OUTCOME_HIGHER[p.outcomeSignal];
  const outcomeLow   = SIGNAL_OUTCOME_LOWER[p.outcomeSignal];
  const dirOutcome   = dir === 'positive' ? outcomeHigh : dir === 'negative' ? outcomeLow : null;

  // ── Count-based (only when conditionCount is reliable) ─────────────────────
  // Requires: ≥5 high-input days, ≥12 total observations, non-early tier
  const countedSubject = SIGNAL_COUNTED_SUBJECT[p.inputSignal];
  if (
    p.conditionCount >= 5 &&
    p.observationCount >= 12 &&
    !isEarly &&
    countedSubject
  ) {
    if (isNextDay) {
      return `On ${p.conditionCount} of your last ${p.observationCount} ${countedSubject}, ${outcomeName} was ${dirWord} the next day.`;
    }
    return `On ${p.conditionCount} of your last ${p.observationCount} ${countedSubject}, ${outcomeName} has been ${dirWord}.`;
  }

  // ── Next-day relationship ────────────────────────────────────────────────────
  if (isNextDay && subject && dirOutcome) {
    if (isEarly) return `So far, ${subject} have often been followed by ${dirOutcome}.`;
    return `${subject.charAt(0).toUpperCase() + subject.slice(1)} have ${adverb} been followed by ${dirOutcome}.`;
  }
  if (isNextDay && subject) {
    if (isEarly) return `So far, ${subject} have often been followed by ${dirWord} ${outcomeName}.`;
    return `${subject.charAt(0).toUpperCase() + subject.slice(1)} have ${adverb} been followed by ${dirWord} ${outcomeName}.`;
  }

  // ── Same-period relationship ─────────────────────────────────────────────────
  const whenPhrase  = SIGNAL_WHEN_PHRASE[p.inputSignal];
  const outcomeYour = SIGNAL_OUTCOME_YOUR[p.outcomeSignal];
  if (!isNextDay && whenPhrase && outcomeYour) {
    const dirAdj = dir === 'positive' ? 'stronger' : dir === 'negative' ? 'lower' : 'similar';
    if (isEarly) return `So far, ${whenPhrase}, ${outcomeYour} has often been ${dirAdj} too.`;
    return `${whenPhrase.charAt(0).toUpperCase() + whenPhrase.slice(1)}, ${outcomeYour} has ${adverb} been ${dirAdj} too.`;
  }
  if (!isNextDay && subject && dirOutcome) {
    if (isEarly) return `So far, ${subject} have often lined up with ${dirOutcome}.`;
    return `${subject.charAt(0).toUpperCase() + subject.slice(1)} have ${adverb} lined up with ${dirOutcome}.`;
  }

  // ── Fallback: observational ──────────────────────────────────────────────────
  const temporal = isNextDay ? ' the next day' : '';
  return `On ${p.inputCondition}, your ${outcomeName}${temporal} has ${adverb} been ${dirWord}.`;
}

/** "18 days · Pattern" */
export function patternEvidenceChip(p: PatternResult): string {
  const n    = p.observationCount;
  const unit = n === 1 ? 'day' : 'days';
  const tier = TIER_LABEL[p.confidenceTier];
  return `${n} ${unit} · ${tier}`;
}

/**
 * Detail sheet sentence — personal, observational, using inputCondition label.
 * "On nights with more sleep, your readiness has tended to be higher the following day."
 */
export function patternDetailSentence(p: PatternResult): string {
  const outcomeName = SIGNAL_LABEL[p.outcomeSignal].toLowerCase();
  const dir =
    p.direction === 'positive' ? 'higher' :
    p.direction === 'negative' ? 'lower'  :
    'similar';
  const temporal = p.temporalRelationship === 'next_day' ? ' the following day' : '';
  return `On ${p.inputCondition}, your ${outcomeName} has tended to be ${dir}${temporal}.`;
}

// ─── PeriodStats display ───────────────────────────────────────────────────────

type StatKey = keyof PeriodStats;

export const PERIOD_STAT_LABEL: Partial<Record<StatKey, string>> = {
  sleepHours:          'Sleep',
  sleepScore:          'Sleep quality',
  hrv:                 'HRV',
  readiness:           'Readiness',
  steps:               'Steps',
  workoutDurationMin:  'Activity',
  totalAlcoholDrinks:  'Drinks',
  calories:            'Calories',
  protein:             'Protein',
};

/** Format a PeriodStats value for display */
export function formatStatValue(key: StatKey, value: number | null): string {
  if (value === null) return '—';
  switch (key) {
    case 'sleepHours':         return `${value.toFixed(1)}h`;
    case 'sleepScore':
    case 'hrv':
    case 'readiness':          return String(Math.round(value));
    case 'steps':              return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(Math.round(value));
    case 'workoutDurationMin': return `${Math.round(value)}m`;
    case 'totalAlcoholDrinks': return String(Math.round(value * 10) / 10);
    case 'calories':           return `${Math.round(value)} kcal`;
    case 'protein':            return `${Math.round(value)}g`;
    default:                   return String(Math.round(value));
  }
}

// ─── Event type labels ──────────────────────────────────────────────────────────

export const CONTEXT_EVENT_LABEL: Record<string, string> = {
  vacation:         'Travel',   // legacy: normalized to 'travel' on load
  travel:           'Travel',
  illness:          'Illness',
  stressful_period: 'Stressful period',
  training_block:   'Training block',
  alcohol_period:   'Drinking period',
  cycle_phase:      'Cycle phase',
  user_defined:     'Life event',
};

export function eventLabel(type: string, label?: string): string {
  if (label) return label;
  return CONTEXT_EVENT_LABEL[type] ?? 'Event';
}

// ─── Your Story text generation ───────────────────────────────────────────────

import type { SynthesisResult } from '../services/context-synthesis';
import type { EventWindowAnalysis } from '../services/pattern-engine';

// ── Minimum data requirements for an event finding to enter Your Story ────────

/** Both windows must have at least this many days of data. */
const EVENT_FINDING_MIN_DAYS = 3;

/**
 * Minimum meaningful difference between period averages for a signal
 * to produce an event-window finding. These are larger than the per-day
 * MEANINGFUL_EFFECT_THRESHOLD values because period averages smooth noise.
 */
const PERIOD_DIFF_THRESHOLD: Partial<Record<keyof PeriodStats, number>> = {
  readiness:          5,
  hrv:                5,
  sleepHours:         0.5,
  sleepScore:         5,
  steps:              1500,
  workoutDurationMin: 10,
  calories:           150,  // kcal — meaningful daily intake difference across a period
  protein:            10,   // grams
};

/** Generic "during that period" phrases for single-event findings. */
const EVENT_TYPE_PHRASE: Record<string, string> = {
  vacation:         'your trip',           // legacy: normalizes to 'travel'
  travel:           'your trip',
  illness:          'your illness',
  stressful_period: 'your stressful period',
  training_block:   'your training block',
  alcohol_period:   'that period',
  cycle_phase:      'that phase',
  user_defined:     'that period',
};

/**
 * Produces one descriptive sentence about an event window if and only if:
 *   1. Both pre-window and during-window have ≥ EVENT_FINDING_MIN_DAYS of data
 *   2. At least one signal shows a difference ≥ PERIOD_DIFF_THRESHOLD
 *
 * Language is strictly descriptive and does NOT imply causation.
 * Returns null when data is insufficient or no meaningful difference exists —
 * event existence alone never generates a finding.
 */
export function buildEventFinding(window: EventWindowAnalysis): string | null {
  if (window.preWindow.days < EVENT_FINDING_MIN_DAYS)    return null;
  if (window.duringWindow.days < EVENT_FINDING_MIN_DAYS) return null;

  // Check signals in priority order — most clinically meaningful first
  const signalOrder: Array<keyof PeriodStats> = [
    'readiness', 'hrv', 'sleepHours', 'sleepScore', 'calories', 'protein',
  ];
  let bestSignal: keyof PeriodStats | null = null;
  let bestDiff = 0;

  for (const sig of signalOrder) {
    const pre    = window.preWindow[sig] as number | null;
    const during = window.duringWindow[sig] as number | null;
    const thresh = PERIOD_DIFF_THRESHOLD[sig] ?? 999;
    if (pre === null || during === null) continue;
    const diff = Math.abs(during - pre);
    if (diff >= thresh && diff > bestDiff) {
      bestDiff  = diff;
      bestSignal = sig;
    }
  }

  if (!bestSignal) return null;

  const pre    = window.preWindow[bestSignal] as number;
  const during = window.duringWindow[bestSignal] as number;
  const label  = PERIOD_STAT_LABEL[bestSignal as keyof typeof PERIOD_STAT_LABEL] ?? String(bestSignal);
  const preStr  = formatStatValue(bestSignal, pre);
  const durStr  = formatStatValue(bestSignal, during);
  const phrase  = EVENT_TYPE_PHRASE[window.event.type] ?? 'that period';
  const dir     = during < pre ? 'lower' : 'higher';

  if (window.isOngoing) {
    return `Since ${phrase} began, ${label.toLowerCase()} has been running ${dir} than usual.`;
  }
  return `During ${phrase}, ${label.toLowerCase()} ran ${dir} than your usual range.`;
}

// ─── Episodic story synthesis ─────────────────────────────────────────────────

/**
 * A health change that independently passes the PERIOD_DIFF_THRESHOLD gate
 * for a given event window.
 */
interface QualifyingChange {
  signal:      keyof PeriodStats;
  preValue:    number;
  duringValue: number;
  direction:   'lower' | 'higher';
}

/** Natural-language phrase for the period of a completed preceding event. */
const EPISODE_PERIOD_PHRASE: Record<string, string> = {
  travel:           'while traveling',
  vacation:         'while traveling',        // legacy compat
  training_block:   'during your training block',
  stressful_period: 'during that stressful period',
  illness:          'while you were sick',
  alcohol_period:   'during that time',
  cycle_phase:      'during that phase',
  user_defined:     'during that period',
};

/** Sentence bridging the preceding period to the current logged event. */
const EPISODE_CURRENT_BRIDGE: Partial<Record<string, string>> = {
  illness:          "You've since logged feeling sick.",
  stressful_period: "You've since logged a stressful period.",
};

/**
 * More specific bridge when we know both the preceding event type AND the current event type.
 * Outer key = preceding event type, inner key = current event type.
 * When present, replaces EPISODE_CURRENT_BRIDGE entirely for that combination.
 * Language is observational — no medical causation claims.
 */
const EPISODE_TRANSITION_BRIDGE: Partial<Record<string, Partial<Record<string, string>>>> = {
  travel: {
    illness:          'You logged feeling sick shortly after your trip.',
    stressful_period: "You've since logged a stressful period.",
  },
  stressful_period: {
    illness: 'You logged feeling sick shortly after that stressful period.',
  },
  training_block: {
    illness: 'You logged feeling sick shortly after your training block.',
  },
};

/** Optional general wellness suggestion for ongoing events. Never diagnostic. */
const EPISODE_RECOVERY_SUGGESTION: Partial<Record<string, string>> = {
  illness:          'Rest, hydration, and lighter activity may help.',
  stressful_period: 'Prioritizing sleep may help right now.',
};

/** Opening framing line — only for eligible ongoing events with sufficient evidence. */
const EPISODE_OPENING: Partial<Record<string, string>> = {
  illness:          'This may be a week to recover.',
  stressful_period: 'This may be a good time to prioritize rest.',
};

function capitalizeFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function daysBetween(dateA: string, dateB: string): number {
  const tA = new Date(dateA + 'T12:00:00Z').getTime();
  const tB = new Date(dateB + 'T12:00:00Z').getTime();
  return Math.round(Math.abs(tB - tA) / 86_400_000);
}

/**
 * Returns all signals in the preceding event window that independently qualify.
 * Ordered: sleep first, then activity, then recovery signals.
 */
function qualifyingChangesForWindow(window: EventWindowAnalysis): QualifyingChange[] {
  const signalOrder: Array<keyof PeriodStats> = [
    'sleepHours', 'workoutDurationMin', 'sleepScore', 'hrv', 'readiness', 'steps', 'calories', 'protein',
  ];
  const changes: QualifyingChange[] = [];
  const seenFamilies = new Set<string>();
  for (const sig of signalOrder) {
    const pre    = window.preWindow[sig]    as number | null;
    const during = window.duringWindow[sig] as number | null;
    const thresh = PERIOD_DIFF_THRESHOLD[sig as keyof typeof PERIOD_DIFF_THRESHOLD] ?? 999;
    if (pre === null || during === null) continue;
    if (Math.abs(during - pre) >= thresh) {
      // Deduplicate by signal family — only the first qualifying signal per family
      // (e.g. both calories and protein qualifying both say "eating less"; keep calories)
      const family = SIGNAL_FAMILY[sig as SignalKey];
      if (family && seenFamilies.has(family)) continue;
      if (family) seenFamilies.add(family);
      changes.push({
        signal:      sig,
        preValue:    pre,
        duringValue: during,
        direction:   during < pre ? 'lower' : 'higher',
      });
    }
  }
  return changes;
}

/** Human-readable description of a signal change within an episode. */
function describeSignalChange(signal: keyof PeriodStats, direction: 'lower' | 'higher'): string {
  switch (signal) {
    case 'sleepHours':
      return direction === 'lower' ? 'slept less than usual' : 'slept more than usual';
    case 'workoutDurationMin':
    case 'steps':
      return direction === 'higher' ? 'were more active than usual' : 'were less active than usual';
    case 'sleepScore':
      return direction === 'lower' ? 'had lower sleep quality than usual' : 'had better sleep quality than usual';
    case 'hrv':
      return direction === 'lower' ? 'had lower HRV than usual' : 'had higher HRV than usual';
    case 'readiness':
      return direction === 'lower' ? 'had lower readiness than usual' : 'had higher readiness than usual';
    case 'calories':
    case 'protein':
      return direction === 'lower' ? 'were eating less than usual' : 'were eating more than usual';
    default:
      return `had ${direction} ${String(signal)} than usual`;
  }
}

/**
 * Attempts to build a multi-event contextual narrative when:
 *   1. A current event (most recent) has a recognized bridge phrase (e.g., illness)
 *   2. An immediately preceding completed event ended ≤ 3 days before it started
 *   3. The preceding event has at least one independently qualifying health change
 *
 * NEVER implies causation. Temporal observation only.
 * Event adjacency alone is not sufficient — health evidence must qualify independently.
 * Returns null when conditions are not met.
 */
function buildEpisodicStory(synthesis: SynthesisResult): string | null {
  const { eventWindows } = synthesis;
  if (!eventWindows || eventWindows.length < 2) return null;

  // Most recent event first
  const sorted = [...eventWindows].sort((a, b) =>
    b.event.startDate.localeCompare(a.event.startDate)
  );

  const current = sorted[0];
  if (current.duringWindow.days < EVENT_FINDING_MIN_DAYS) return null;

  // Only compose when the current event type has a recognized bridge phrase
  if (!EPISODE_CURRENT_BRIDGE[current.event.type]) return null;

  // Preceding: completed event that ended at most 3 days before current started
  const preceding = sorted.slice(1).find((w) => {
    if (!w.event.endDate) return false;
    const gap = daysBetween(w.event.endDate, current.event.startDate);
    return gap <= 3 && w.event.endDate <= current.event.startDate;
  });

  if (!preceding) return null;
  if (preceding.preWindow.days    < EVENT_FINDING_MIN_DAYS) return null;
  if (preceding.duringWindow.days < EVENT_FINDING_MIN_DAYS) return null;

  const changes = qualifyingChangesForWindow(preceding);
  if (changes.length === 0) return null;

  // Build observation (max 2 signals for conciseness)
  const top2   = changes.slice(0, 2);
  const phrase = EPISODE_PERIOD_PHRASE[preceding.event.type] ?? 'during that period';

  const changeStr = top2.length === 1
    ? `you ${describeSignalChange(top2[0].signal, top2[0].direction)}`
    : `you ${describeSignalChange(top2[0].signal, top2[0].direction)} and ${describeSignalChange(top2[1].signal, top2[1].direction)}`;

  const bridge = EPISODE_TRANSITION_BRIDGE[preceding.event.type]?.[current.event.type]
    ?? EPISODE_CURRENT_BRIDGE[current.event.type]!;

  const observation = `${capitalizeFirst(phrase)}, ${changeStr}. ${bridge}`;
  const opening     = current.isOngoing ? (EPISODE_OPENING[current.event.type]             ?? null) : null;
  const suggestion  = current.isOngoing ? (EPISODE_RECOVERY_SUGGESTION[current.event.type] ?? null) : null;

  const parts: string[] = [];
  if (opening)    parts.push(opening);
  parts.push(observation);
  if (suggestion) parts.push(suggestion);

  return parts.join('\n\n');
}

// ─── Primary theme prose ──────────────────────────────────────────────────────

function buildPrimaryThemeSentence(synthesis: SynthesisResult): string | null {
  const { primaryTheme, supportingSignals, concerningSignals } = synthesis;

  switch (primaryTheme.theme) {
    case 'insufficient_data':
      return null;

    case 'recovery_needed': {
      const lines = primaryTheme.rationale.filter(Boolean);
      return lines.length === 0 ? 'Recovery signals are lower than your usual range.' : lines.join(' ');
    }

    case 'performing_well': {
      const list = supportingSignals.map((s) => s.signal.toLowerCase()).slice(0, 3).join(', ');
      if (!list) return 'Key signals are in a favorable range.';
      const first = list.charAt(0).toUpperCase() + list.slice(1);
      const tail  = primaryTheme.rationale.find(Boolean) ?? '';
      return tail ? `${first} ${tail}` : `${first} looks favorable today.`;
    }

    case 'mixed_signals': {
      const concernList = concerningSignals.map((s) => s.signal.toLowerCase());
      const supportList = supportingSignals.map((s) => s.signal.toLowerCase());
      if (concernList.length > 0 && supportList.length > 0) {
        const c = concernList.join(' and ');
        const s = supportList.join(' and ');
        return `${c.charAt(0).toUpperCase() + c.slice(1)} is running lower than your usual range, while ${s} looks favorable.`;
      }
      if (concernList.length > 0) {
        return primaryTheme.rationale.filter(Boolean).join(' ') ||
          `${concernList.join(' and ')} is below your usual range.`;
      }
      return 'Signals are pointing in different directions today.';
    }
  }
}

// ─── Enhanced story rendering (story-engine.ts intermediate rep) ─────────────

import type {
  StoryEpisode, BehavioralFinding, TransitionLayer, ContextEventLayer,
  PhysiologicalStateLayer, CurrentDirectionLayer, EvidenceStrength,
  NutritionFinding, HydrationContext, InterpretationLayer, AftermathLayer,
  NextFocusLayer, FutureLessonLayer,
  ContextResponseContrastLayer, ConfirmedPatternFinding,
} from '../services/story-engine';
import {
  buildStoryEpisode,
} from '../services/story-engine';
import type { HealthDayRecord } from '../services/pattern-engine';

const EVENT_PERIOD_PHRASE_MAP: Record<string, string> = {
  travel:           'while traveling',
  vacation:         'while traveling',
  illness:          'while you were sick',
  stressful_period: 'during that stressful period',
  training_block:   'during your training block',
  alcohol_period:   'during that time',
  cycle_phase:      'during that phase',
  user_defined:     'during that period',
};

const EVENT_ONGOING_PHRASE_MAP: Record<string, string> = {
  travel:           'your trip',
  vacation:         'your trip',
  illness:          'your illness',
  stressful_period: 'that period',
  training_block:   'your training block',
  alcohol_period:   'that period',
  cycle_phase:      'that phase',
  user_defined:     'that period',
};

const ENHANCED_TRANSITION_BRIDGE: Partial<Record<string, Partial<Record<string, string>>>> = {
  travel: {
    illness:          'You logged feeling sick shortly after your trip.',
    stressful_period: "You've since logged a stressful period.",
  },
  stressful_period: {
    illness: 'You logged feeling sick shortly after that stressful period.',
  },
  training_block: {
    illness: 'You logged feeling sick shortly after your training block.',
  },
};

const CURRENT_EVENT_BRIDGE_FALLBACK: Partial<Record<string, string>> = {
  illness:          "You've since logged feeling sick.",
  stressful_period: "You've since logged a stressful period.",
};

function evidenceRank(strength: EvidenceStrength): number {
  switch (strength) {
    case 'strong_contextual_pattern': return 4;
    case 'repeated_pattern':          return 3;
    case 'weak_association':          return 2;
    case 'isolated_coincidence':      return 1;
  }
}

function behaviorActionVerb(type: BehavioralFinding['behaviorType']): string {
  switch (type) {
    case 'alcohol':      return 'have drinks in the evening';
    case 'caffeine':     return 'have a lot of caffeine';
    case 'sauna':        return 'use the sauna';
    case 'cold_plunge':  return 'do a cold plunge';
    case 'gratitude':    return 'log a gratitude session';
    case 'electrolytes': return 'take electrolytes';
    case 'water':        return 'log higher hydration';
  }
}

/**
 * Render a nutrition finding.
 *
 * Language is purely observational — references "in your logs" to make clear
 * the claim is about logged data, not actual intake. Never implies deficiency.
 */
function renderNutritionFinding(f: NutritionFinding): string | null {
  if (f.evidence.strength === 'isolated_coincidence') return null;

  const outcome = f.outcomeMetric.toLowerCase();
  const temporal = f.timeRelationship === 'next_day' ? ' the next day' : '';

  if (f.evidence.strength === 'weak_association') {
    if (f.signal === 'protein') {
      return `On a couple of occasions where more protein was logged, ${outcome} was higher${temporal}.`;
    }
    return `On a couple of days with more logged nutrition, ${outcome} was higher${temporal}.`;
  }

  // repeated_pattern or strong_contextual_pattern
  if (f.signal === 'protein') {
    return `On days with more protein in your logs, ${outcome} tends to be higher${temporal}.`;
  }
  return `Days with more logged nutrition tend to align with higher ${outcome}${temporal}.`;
}

/**
 * First-person natural phrasing for sleep changes; generic fallback for all other metrics.
 * "sleep" + "lower"  → "you slept less than usual"
 * "sleep" + "higher" → "you slept more than usual"
 * anything else      → "HRV was lower than usual"
 */
function naturalMetricChangePhrase(metric: string, direction: string): string {
  const m = inlineLowercase(metric);
  if (m === 'sleep') {
    return direction === 'lower' ? 'you slept less than usual' : 'you slept more than usual';
  }
  return `${m} was ${direction} than usual`;
}

/** Preceding-event changes only — "While traveling, you slept less than usual and activity was higher than usual." */
function renderTransitionSetup(t: TransitionLayer): string {
  const phrase = EVENT_PERIOD_PHRASE_MAP[t.precedingEventType] ?? 'during that period';

  const changes = t.precedingMetricChanges.slice(0, 2);
  let changesStr: string;
  if (changes.length === 1) {
    changesStr = naturalMetricChangePhrase(changes[0].metric, changes[0].direction);
  } else {
    const c1 = changes[0], c2 = changes[1];
    const hasSleep = [c1.metric, c2.metric].some(m => inlineLowercase(m) === 'sleep');
    const sameDir  = c1.direction === c2.direction;
    if (!hasSleep && sameDir) {
      changesStr = `${inlineLowercase(c1.metric)} and ${inlineLowercase(c2.metric)} were ${c1.direction} than usual`;
    } else if (!hasSleep) {
      changesStr = `${inlineLowercase(c1.metric)} was ${c1.direction} and ${inlineLowercase(c2.metric)} was ${c2.direction} than usual`;
    } else {
      changesStr = `${naturalMetricChangePhrase(c1.metric, c1.direction)} and ${naturalMetricChangePhrase(c2.metric, c2.direction)}`;
    }
  }

  return `${capitalizeFirst(phrase)}, ${changesStr}.`;
}

/** Outcome bridge only — "You logged feeling sick shortly after your trip." */
function renderTransitionBridge(t: TransitionLayer): string {
  return ENHANCED_TRANSITION_BRIDGE[t.precedingEventType]?.[t.currentEventType]
    ?? CURRENT_EVENT_BRIDGE_FALLBACK[t.currentEventType]
    ?? `You've since logged ${CONTEXT_EVENT_LABEL[t.currentEventType]?.toLowerCase() ?? t.currentEventLabel.toLowerCase()}.`;
}

function renderTransitionLayer(t: TransitionLayer): string {
  return `${renderTransitionSetup(t)} ${renderTransitionBridge(t)}`;
}

function renderContextEventLayer(layer: ContextEventLayer): string | null {
  if (!layer.hasEnoughEvidence || layer.metricChanges.length === 0) return null;

  const top    = layer.metricChanges.slice(0, 2);
  const phrase = EVENT_PERIOD_PHRASE_MAP[layer.eventType] ?? 'during that period';
  const ongoing = EVENT_ONGOING_PHRASE_MAP[layer.eventType] ?? 'that period';

  if (top.length === 1) {
    const c = top[0];
    if (layer.isOngoing) {
      return `Since ${ongoing} began, ${inlineLowercase(c.metric)} has been ${c.direction} than usual.`;
    }
    return `${capitalizeFirst(phrase)}, ${naturalMetricChangePhrase(c.metric, c.direction)}.`;
  }

  const c1 = top[0];
  const c2 = top[1];
  if (layer.isOngoing) {
    return `Since ${ongoing} began, ${inlineLowercase(c1.metric)} and ${inlineLowercase(c2.metric)} have both been ${c1.direction === c2.direction ? c1.direction : 'disrupted'} than usual.`;
  }
  const hasSleep = [c1.metric, c2.metric].some(m => inlineLowercase(m) === 'sleep');
  if (!hasSleep && c1.direction === c2.direction) {
    return `${capitalizeFirst(phrase)}, ${inlineLowercase(c1.metric)} and ${inlineLowercase(c2.metric)} were ${c1.direction} than usual.`;
  }
  if (!hasSleep) {
    return `${capitalizeFirst(phrase)}, ${inlineLowercase(c1.metric)} was ${c1.direction} and ${inlineLowercase(c2.metric)} was ${c2.direction} than usual.`;
  }
  return `${capitalizeFirst(phrase)}, ${naturalMetricChangePhrase(c1.metric, c1.direction)} and ${naturalMetricChangePhrase(c2.metric, c2.direction)}.`;
}

function renderBehavioralFinding(f: BehavioralFinding): string | null {
  if (f.evidence.strength === 'isolated_coincidence') return null;

  const dirWord = f.outcomeDirection === 'worse' ? 'lower' : 'higher';
  const temporal = f.timeRelationship === 'next_day' ? 'the next day' : 'on those days';
  const verb = behaviorActionVerb(f.behaviorType);

  if (f.evidence.strength === 'weak_association') {
    return `On a couple of occasions when you ${verb}, ${f.outcomeMetric.toLowerCase()} was ${dirWord} ${temporal}.`;
  }
  return `When you ${verb}, ${f.outcomeMetric.toLowerCase()} tends to be ${dirWord} ${temporal}.`;
}

function renderPhysiologicalStateLayer(state: PhysiologicalStateLayer): string | null {
  const notable = state.findings.filter(f => f.direction !== 'near_baseline');
  if (notable.length === 0) return null;

  if (state.conflicting) {
    const below = notable.filter(f => f.direction === 'below_baseline').map(f => inlineLowercase(f.metric));
    const above = notable.filter(f => f.direction === 'above_baseline').map(f => inlineLowercase(f.metric));
    if (below.length > 0 && above.length > 0) {
      return `${capitalizeFirst(below.join(' and '))} is running lower than your usual range, while ${above.join(' and ')} looks favorable.`;
    }
  }

  const below = notable.filter(f => f.direction === 'below_baseline').map(f => inlineLowercase(f.metric));
  const above = notable.filter(f => f.direction === 'above_baseline').map(f => inlineLowercase(f.metric));

  if (below.length > 0) {
    return `${capitalizeFirst(below.slice(0, 2).join(' and '))} is running lower than your usual range.`;
  }
  if (above.length > 0) {
    return `${capitalizeFirst(above.slice(0, 2).join(' and '))} looks favorable today.`;
  }
  return null;
}

function renderCurrentDirectionLayer(dir: CurrentDirectionLayer): string | null {
  switch (dir.trajectory) {
    case 'recovering': {
      const improving = dir.improvingMetrics.slice(0, 2).map(s => inlineLowercase(s));
      return improving.length > 0
        ? `${capitalizeFirst(improving.join(' and '))} is trending back toward your usual range.`
        : 'Things appear to be moving in the right direction.';
    }
    case 'disrupted': {
      const below = dir.belowBaselineMetrics.slice(0, 2).map(s => inlineLowercase(s));
      return below.length > 0
        ? `${capitalizeFirst(below.join(' and '))} is still below your usual range.`
        : null;
    }
    case 'declining':
      return 'Recovery signals have been trending lower recently.';
    default:
      return null;
  }
}

// ─── Arc render helpers ────────────────────────────────────────────────────────

/** Ensures known metric abbreviations are always properly capitalized. */
const METRIC_DISPLAY_NAMES: Record<string, string> = {
  'hrv':           'HRV',
  'readiness':     'Readiness',
  'sleep':         'Sleep',
  'sleep quality': 'Sleep quality',
  'activity':      'Activity',
  'hydration':     'Hydration',
  'nutrition':     'Nutrition',
  'steps':         'Steps',
};

function capitalizeMetric(name: string): string {
  return METRIC_DISPLAY_NAMES[name.toLowerCase()] ?? capitalizeFirst(name);
}

/** Properly capitalize a metric area that may contain " and " (e.g. "Readiness and HRV"). */
function formatMetricArea(area: string): string {
  return area.split(' and ').map(capitalizeMetric).join(' and ');
}

/**
 * Lowercase a metric name for inline sentence use, preserving all-caps abbreviations.
 * "HRV" → "HRV", "Readiness" → "readiness", "Sleep quality" → "sleep quality".
 */
function inlineLowercase(name: string): string {
  const display = capitalizeMetric(name);
  return display === display.toUpperCase() ? display : display.charAt(0).toLowerCase() + display.slice(1);
}

/**
 * One-line hydration enrichment for alcohol_night and sleep_activity stories.
 *
 * Only fires when logged intake was demonstrably below the user's personal target
 * across multiple recent completed days. Returns null in all other cases —
 * including when tracking is sparse, adequate, or the data is insufficient.
 *
 * Language rules:
 *   - "lately" because it reflects a recent window, not a single day
 *   - No shame: never "failed", "missed your goal", "poor hydration"
 *   - When a goal is known: reference it directly ("your daily goal")
 *   - When only baseline mean is known: describe it relatively ("your usual level")
 */
function buildHydrationEnrichment(h: HydrationContext | null | undefined): string | null {
  if (!h || h.status !== 'below_target') return null;
  if (h.goalOz != null) {
    return 'Water intake has been running below your daily goal most days lately.';
  }
  return 'Hydration has been running below your usual level lately.';
}

/**
 * Render hydration context with event-aware language.
 * not_tracked — acknowledges the data gap when hydration is relevant to the event.
 * below_target — states that logged hydration was below the user's usual level.
 * NEVER implies a deficit from missing data.
 */
function renderHydrationContext(h: HydrationContext, eventType?: string): string | null {
  const HYDRATION_RELEVANT_EVENTS = new Set([
    'travel', 'vacation', 'illness', 'training_block',
  ]);
  const phrase = eventType ? (EVENT_PERIOD_PHRASE_MAP[eventType] ?? 'during this period') : 'during this period';
  const label  = eventType ? (EVENT_ONGOING_PHRASE_MAP[eventType] ?? 'this period') : 'this period';

  if (h.status === 'not_tracked') {
    if (!eventType || !HYDRATION_RELEVANT_EVENTS.has(eventType)) return null;
    return `Hydration wasn't logged consistently during ${label}, so that part of the picture is unclear.`;
  }
  if (h.status === 'below_target') {
    return `Hydration also ran below your usual level on several days ${phrase}.`;
  }
  return null;
}

/**
 * Render interpretation.
 *
 * strain_accumulation — when a transition already described the load signals,
 *   just add "that combination may have added strain" without restating them.
 * routine_disruption  — never rendered; the setup sentence already covers it.
 * behavioral_cluster  — rendered when 2+ meaningful findings exist.
 */
function renderInterpretationLayer(
  i: InterpretationLayer,
  hasTransition: boolean,
): string | null {
  if (!i.hasInterpretation) return null;

  switch (i.connectionType) {
    case 'strain_accumulation': {
      if (hasTransition) {
        // Transition already described the load signals — just add the inference.
        return 'That combination may have added strain.';
      }
      const signals = i.loadSignals.slice(0, 2).map(s => inlineLowercase(s)).join(' and ');
      const outcome = i.outcomeEventType === 'illness'
        ? 'illness'
        : i.outcomeEventType === 'stressful_period'
          ? 'that stressful period'
          : 'what followed';
      return signals
        ? `${capitalizeFirst(signals)} was different than usual before ${outcome} — that combination may have added strain.`
        : `Several signals were off before ${outcome}.`;
    }
    case 'routine_disruption':
      // Always skip — restates what the setup already described.
      return null;
    case 'behavioral_cluster': {
      const behaviors = i.behaviorSignals.slice(0, 2).map(capitalizeMetric).join(' and ');
      return `${behaviors} have both appeared alongside shifts in your recovery — the connection showed up consistently enough to surface.`;
    }
  }
}

function renderAftermathLayer(a: AftermathLayer): string | null {
  if (!a.hasEvidence || a.observations.length === 0) return null;

  const recoveryAligned = a.observations.filter(o => o.isRecoveryAligned);
  if (recoveryAligned.length === 0) {
    const notAligned = a.observations.filter(o => !o.isRecoveryAligned);
    if (notAligned.length > 0) {
      const signals = notAligned.slice(0, 2).map(o => inlineLowercase(o.signal)).join(' and ');
      return `${capitalizeFirst(signals)} remained ${notAligned[0].direction} in the days that followed.`;
    }
    return null;
  }

  const upSignals   = recoveryAligned.filter(o => o.direction === 'higher').slice(0, 2).map(o => inlineLowercase(o.signal));
  const downSignals = recoveryAligned.filter(o => o.direction === 'lower').slice(0, 1).map(o => inlineLowercase(o.signal));

  if (upSignals.length > 0 && downSignals.length > 0) {
    // Mixed: activity lighter while recovery metrics improving
    const upText     = upSignals.length === 1 ? upSignals[0] : `${upSignals.slice(0, -1).join(', ')} and ${upSignals.slice(-1)[0]}`;
    const downSig    = downSignals[0];
    const itsOrTheir = upSignals.length === 1 ? 'its' : 'their';
    const downPhrase = downSig === 'activity' ? 'has been lighter' : 'has been lower';
    return `In the days after, ${downSig} ${downPhrase} while ${upText} started moving back toward ${itsOrTheir} usual range.`;
  }

  if (upSignals.length > 0) {
    const upText = upSignals.length === 1 ? upSignals[0] : `${upSignals.slice(0, -1).join(', ')} and ${upSignals.slice(-1)[0]}`;
    return `In the days after, ${upText} moved higher — a sign things are heading in the right direction.`;
  }

  const downSig    = downSignals[0];
  const downPhrase = downSig === 'activity' ? 'has been lighter since' : 'has been lower since';
  return `${capitalizeFirst(downSig)} ${downPhrase} — a natural response while recovery continues.`;
}

/**
 * Render next focus as a natural narrative closing sentence — not a dashboard label.
 *
 * loadSignals: from the interpretation layer; used to detect whether activity
 * was unusually high (informing the "before returning to activity" tail).
 */
function renderNextFocusLayer(n: NextFocusLayer): string | null {
  if (!n.hasRecommendation || n.priorities.length === 0) return null;

  const topAreas = n.priorities.slice(0, 2).map(p => inlineLowercase(formatMetricArea(p.area)));
  const isOrAre  = topAreas.length === 1 ? 'is' : 'are';
  const areaText = topAreas.length === 1
    ? topAreas[0]
    : `${topAreas.slice(0, -1).join(', ')} and ${topAreas.slice(-1)[0]}`;

  switch (n.context) {
    case 'recovery': {
      const topArea = n.priorities[0]?.area;
      if (topArea === 'Sleep') {
        return `For now, keeping sleep consistent while recovery stabilizes may be worth prioritizing.`;
      }
      return `For now, keeping activity lighter while prioritizing sleep, hydration, and recovery may be worthwhile.`;
    }
    case 'stress':
      return `With the stressful period still ongoing, keeping demands manageable while ${areaText} ${isOrAre} running lower may be worth prioritizing.`;
    case 'travel':
      return `For the next trip, ${areaText} ${isOrAre} worth watching more closely.`;
    case 'training':
      return `For now, ${areaText} ${isOrAre} worth monitoring before ramping training back up.`;
    default:
      return `For now, ${areaText} ${isOrAre} worth keeping an eye on.`;
  }
}

const FUTURE_LESSON_EVENT_LABEL: Record<string, string> = {
  travel:          'trip',
  vacation:        'trip',
  training_block:  'training block',
  illness:         'illness',
};

/**
 * Render a forward-looking lesson from a completed event.
 * When activity was higher during the event and sleep was affected,
 * makes the lesson specifically about protecting sleep on active days.
 */
function renderFutureLessonLayer(
  f: FutureLessonLayer,
  contextEvent?: ContextEventLayer | null,
): string | null {
  if (!f.hasLesson || f.monitorSignals.length === 0) return null;
  const label   = FUTURE_LESSON_EVENT_LABEL[f.eventType] ?? f.eventType.replace(/_/g, ' ');
  const signals = f.monitorSignals.slice(0, 2).map(s => inlineLowercase(s));
  const signalText = signals.length === 1
    ? signals[0]
    : `${signals.slice(0, -1).join(', ')} and ${signals.slice(-1)[0]}`;

  const hadHighActivity = contextEvent?.metricChanges.some(
    c => c.metric === 'Activity' && c.direction === 'higher',
  ) ?? false;
  const affectedSleep = f.monitorSignals.some(s => s.toLowerCase().includes('sleep'));

  if (hadHighActivity && affectedSleep) {
    return `On your next ${label}, protecting sleep on your higher-activity days may be worth prioritizing.`;
  }
  return `On your next ${label}, keeping ${signalText} more consistent from the start may be worth prioritizing.`;
}

/**
 * Renders a StoryEpisode to a human-readable narrative following this arc:
 *
 *   1. Setup      — what happened (transition bridge OR context event OR physio state)
 *   2. Hydration  — episode-specific note when logged water was off (optional)
 *   3. Interpretation — what the multi-signal picture suggests (strain_accumulation /
 *                       behavioral_cluster only; routine_disruption always skipped)
 *   4. Aftermath  — what changed after the event; OR episode-relevant recovery behavior
 *   5. Close      — NextFocus (prose) OR FutureLesson OR current direction
 *
 * Key rules:
 *   - Interpretation renders even when a transition exists (different jobs).
 *   - routine_disruption interpretation is always skipped (restates the setup).
 *   - When an event context is present, only recovery-aligned behavioral findings
 *     (gratitude, sauna, cold plunge, electrolytes) appear — general correlations
 *     (water, alcohol, caffeine) belong in "What's Connected," not "Your Story."
 *   - Signal density cap: at most 5 parts.
 *   - Returns null if not surface-worthy.
 */

// ─── Context-response contrast rendering ──────────────────────────────────────

/**
 * Render a physio finding list for inline use.
 * e.g. "readiness and HRV" or "readiness, HRV, and sleep"
 */
function physioFindingNames(findings: ContextResponseContrastLayer['physioFindings']): string {
  const names = [...new Set(findings.map(f => inlineLowercase(f.metric)))];
  if (names.length === 0) return 'your recovery signals';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

/**
 * Render a behavioral disruption list for inline use.
 * e.g. "you slept less than usual and activity was lower"
 */
function renderBehavioralDisruptionList(
  disruptions: ContextResponseContrastLayer['behavioralDisruptions'],
): string {
  if (disruptions.length === 0) return '';
  const phrases = disruptions.slice(0, 2).map(d => naturalMetricChangePhrase(d.metric, d.direction));
  if (phrases.length === 1) return phrases[0];
  return `${phrases[0]} and ${phrases[1]}`;
}

/**
 * Builds a neutral, observational note about today's workout for the alcohol story.
 *
 * Philosophy: the workout is part of the day's picture — not framed as compensation,
 * recovery, or redemption for the previous night. It's simply another data point.
 * Returns null when activity was too brief (< 15 min) to warrant mentioning.
 */
function buildTodayActivityNote(layer: ContextResponseContrastLayer): string | null {
  const mins = layer.todayActivityMin;
  if (!mins || mins < 15) return null;
  const actType = (layer.todayActivityType ?? '').toLowerCase();
  if (
    actType.includes('run') ||
    actType === 'outdoor run' ||
    actType === 'treadmill'
  ) {
    return 'You also logged a run today.';
  }
  return 'You also got some activity in today.';
}

// ─── Synthesis helpers (alcohol_night / sleep_activity) ───────────────────────

/**
 * Build a pattern-led narrative when an established personal pattern matches today's state.
 *
 * When a confirmed pattern fires alongside a contrast story, the pattern is the strongest
 * observation. Restructure so the pattern leads and other signals add framing context.
 *
 * Structure:
 *   P1: Today's outcome state → input observation → BellaHealth connection
 *   P2 (optional): Secondary context (drinks, short sleep, hydration) as framing
 *
 * Language: noncausal ("seen a connection", "move together"), no judgment.
 */
function buildPatternLeadStory(
  pattern: ConfirmedPatternFinding,
  ctx: {
    hasDrinks:      boolean;
    hasShortSleep:  boolean;
    hydrationBelow: boolean;
  },
): string {
  const { inputLabel, outcomeLabel, todayOutcomeDirection,
          todayOutcomeValue, baselineValue, observationCount } = pattern;

  const runningDir  = todayOutcomeDirection === 'above_baseline' ? 'higher' : 'lower';
  const nObs        = observationCount >= 10 ? 'consistently' : 'repeatedly';
  const rounded     = (v: number) => Math.round(v);

  const valueStr =
    outcomeLabel === 'Sleep' ? `${todayOutcomeValue.toFixed(1)}h`
    : outcomeLabel === 'HRV' ? `${rounded(todayOutcomeValue)}ms`
    : String(rounded(todayOutcomeValue));
  const baselineStr =
    outcomeLabel === 'Sleep' ? `${baselineValue.toFixed(1)}h`
    : outcomeLabel === 'HRV' ? `${rounded(baselineValue)}ms`
    : String(rounded(baselineValue));

  const inputLower = inputLabel.toLowerCase();
  const inputObservation =
    (inputLower.includes('train') || inputLower.includes('activity') || inputLower.includes('workout'))
      ? `You've also been more active lately`
      : `${capitalizeFirst(inputLower)} has also been higher lately`;

  // P1: today's metric state → input observation → BellaHealth connection
  const p1 =
    `Your ${inlineLowercase(outcomeLabel)} is running ${runningDir} than usual today — ` +
    `${valueStr} vs. your usual ${baselineStr}. ` +
    `${inputObservation}, and BellaHealth has ${nObs} seen a connection between ` +
    `${inputLower} and ${inlineLowercase(outcomeLabel)} in your data — consistent with what's showing up today.`;

  // P2: secondary context as framing (noncausal — these coexist, they don't explain)
  const ctxPieces: string[] = [];
  if (ctx.hasDrinks)      ctxPieces.push('an evening with drinks');
  if (ctx.hasShortSleep)  ctxPieces.push('a shorter night');
  if (ctx.hydrationBelow) ctxPieces.push('recent lower hydration');

  if (ctxPieces.length === 0) return p1;

  const ctxList =
    ctxPieces.length === 1 ? ctxPieces[0]
    : ctxPieces.length === 2 ? `${ctxPieces[0]} and ${ctxPieces[1]}`
    : `${ctxPieces.slice(0, -1).join(', ')}, and ${ctxPieces[ctxPieces.length - 1]}`;

  const p2 = `${capitalizeFirst(ctxList)} ${ctxPieces.length > 1 ? 'add' : 'adds'} context to today's recovery picture.`;

  return `${p1}\n\n${p2}`;
}

/**
 * Synthesized story for the alcohol_night context type.
 *
 * Produces integrated prose that answers "why is this interesting together today?"
 * rather than listing observations. Drinks are described neutrally ("an evening with
 * drinks" / "you logged drinks"), hydration appears as background context, and
 * coexisting signals are framed with "alongside" — never causal language.
 *
 * Structure (no pattern):
 *   Para 1  — neutral frame + physio state + coexisting signals woven with "alongside"
 *   Para 2  — today's activity (if any)
 *   Para 3  — recovery outlook (warmer, broader than metric-specific)
 *
 * When a confirmed pattern matches today's state, the story restructures around
 * the pattern as the lead — see buildPatternLeadStory().
 *
 * Voice: observational, curious, nonjudgmental. No causation. No moralizing.
 */
function buildAlcoholNightSynthesis(
  layer: ContextResponseContrastLayer,
  contextualPattern?: ConfirmedPatternFinding | null,
): string {
  const shiftedBelow   = layer.physioFindings.filter(f => f.direction === 'below_baseline');
  const shiftedAbove   = layer.physioFindings.filter(f => f.direction === 'above_baseline');
  const stableFindings = layer.physioFindings.filter(f => f.direction === 'near_baseline');
  const hasShift       = shiftedBelow.length > 0 || shiftedAbove.length > 0;
  const hydrationBelow = layer.hydrationContext?.status === 'below_target';
  const hasActivity    = (layer.todayActivityMin ?? 0) >= 15;

  const actType = (layer.todayActivityType ?? '').toLowerCase();
  const actNote = actType.includes('run') ? 'You got a run in today.' : 'You got some activity in today.';

  // ── Pattern-lead restructure ─────────────────────────────────────────────────
  // When a confirmed pattern matches today's state, it is the strongest observation.
  // Restructure: lead with today's metric + pattern connection, fold other signals as framing.
  if (contextualPattern) {
    const dominated     = shiftedBelow.length >= shiftedAbove.length ? shiftedBelow : shiftedAbove;
    const hasShortSleep = dominated.some(f => inlineLowercase(f.metric).includes('sleep'));
    return buildPatternLeadStory(contextualPattern, {
      hasDrinks: true,
      hasShortSleep,
      hydrationBelow,
    });
  }

  const opener = 'Last night was a little outside your usual routine.';
  const parts: string[] = [];

  // ── Para 1: neutral frame + physio state + coexisting signals ────────────────
  // Drinks are named neutrally. Hydration appears as background context.
  // "Alongside" signals coexistence without implying causation.
  if (hasShift) {
    const dominated = shiftedBelow.length >= shiftedAbove.length ? shiftedBelow : shiftedAbove;
    const direction  = shiftedBelow.length >= shiftedAbove.length ? 'lower' : 'higher';
    const topTwo     = dominated.slice(0, 2);
    const metricStr  = physioFindingNames(topTwo);

    // Build "alongside" clause: drinks first, then hydration when present
    const contextPieces = ['an evening with drinks'];
    if (hydrationBelow) contextPieces.push('a recent stretch of lower hydration');
    const alongsideClause = contextPieces.length === 1
      ? `alongside ${contextPieces[0]}`
      : `alongside ${contextPieces[0]}, and ${contextPieces[1]}`;

    if (stableFindings.length > 0) {
      // Some metrics held near baseline — note both shifted and stable, then context
      parts.push(
        `${opener} ${capitalizeFirst(metricStr)} came in ${direction} than your usual range, ` +
        `${alongsideClause}, while your other recovery signals are staying close to your normal.`,
      );
    } else {
      parts.push(
        `${opener} ${capitalizeFirst(metricStr)} came in ${direction} than your usual range, ${alongsideClause}.`,
      );
    }
  } else {
    // Stable physio — mention drinks plainly; recovery picture is not alarming
    const physioRef = stableFindings.length > 0
      ? `${physioFindingNames(stableFindings.slice(0, 2))} ${stableFindings.length === 1 ? 'is' : 'are'} sitting near your usual range`
      : 'your recovery is sitting near your usual range';
    if (hydrationBelow) {
      parts.push(
        `${opener} You logged drinks, and ${physioRef}, alongside a recent stretch of lower hydration.`,
      );
    } else {
      parts.push(`${opener} You logged drinks, and ${physioRef} today.`);
    }
    // Stable physio: story is intentionally brief — no forward-looking watch needed
    if (hasActivity) parts.push(actNote);
    return parts.join('\n\n');
  }

  // ── Para 2: today's activity ─────────────────────────────────────────────────
  if (hasActivity) parts.push(actNote);

  // ── Para 3: recovery outlook (warmer, broader than metric-specific watch) ─────
  parts.push('BellaHealth will watch whether your recovery signals shift as your routine settles back toward normal.');

  return parts.join('\n\n');
}

/**
 * Synthesized story for the sleep_activity context type.
 *
 * Fires when sleep is notably below the personal baseline AND a qualifying
 * workout was logged today — without requiring alcohol, a life event, or a
 * training goal.
 *
 * Coexisting signals (activity, hydration) are woven into Para 1 with "alongside"
 * rather than appearing as separate paragraphs. When a confirmed pattern matches
 * today's state, the story restructures around it — see buildPatternLeadStory().
 */
function buildSleepActivitySynthesis(
  layer: ContextResponseContrastLayer,
  contextualPattern?: ConfirmedPatternFinding | null,
): string {
  const shiftedFindings = layer.physioFindings.filter(f => f.direction !== 'near_baseline');
  const hydrationBelow  = layer.hydrationContext?.status === 'below_target';
  const hasMultiShift   = shiftedFindings.length >= 2;

  const actType  = (layer.todayActivityType ?? '').toLowerCase();
  const actLabel = actType.includes('run') ? 'a run today' : 'some activity today';

  // ── Pattern-lead restructure ─────────────────────────────────────────────────
  if (contextualPattern) {
    const hasShortSleep = shiftedFindings.some(f => inlineLowercase(f.metric).includes('sleep'));
    return buildPatternLeadStory(contextualPattern, {
      hasDrinks: false,
      hasShortSleep,
      hydrationBelow,
    });
  }

  const parts: string[] = [];

  // ── Para 1: core observation with coexisting signals woven in ─────────────────
  // Activity and hydration are folded into the same sentence — not separate paragraphs.
  if (hasMultiShift) {
    const topTwo    = shiftedFindings.slice(0, 2);
    const metricStr = physioFindingNames(topTwo);
    if (hydrationBelow) {
      parts.push(
        `Your recovery picture is a little mixed today — ${metricStr} came in lower than your usual range, ` +
        `alongside ${actLabel} and a recent stretch of lower hydration.`,
      );
    } else {
      parts.push(
        `Your recovery picture is a little mixed today — ${metricStr} came in lower than your usual range, ` +
        `alongside ${actLabel}.`,
      );
    }
  } else {
    if (hydrationBelow) {
      parts.push(`Your night was shorter than usual, alongside ${actLabel} and a recent stretch of lower hydration.`);
    } else {
      parts.push(`Your night was shorter than usual, alongside ${actLabel}.`);
    }
  }

  // ── Para 2: forward-looking ──────────────────────────────────────────────────
  // Hydration is now woven into Para 1 — there is no standalone hydration paragraph.
  parts.push(
    `BellaHealth will watch whether this is a one-off shorter night or part of a broader shift in your sleep.`,
  );

  return parts.join('\n\n');
}

/**
 * Render the context-response contrast story.
 *
 * Product rules:
 *   - Never claim causation ("travel CAUSED the dip")
 *   - Never moralize ("despite your poor choice to drink")
 *   - User-defined events: no emotional valence assumed
 *   - "You lived your life, now love your body" tone for chosen life experiences
 *   - Do NOT use that framing for illness
 *   - Training: use "time spent training" / "workout time", not "training load" or "intensity"
 */
function renderContextResponseContrast(
  layer: ContextResponseContrastLayer,
  contextualPattern?: ConfirmedPatternFinding | null,
): string | null {
  const { contextType, contextLabel, physioResponse, behavioralDisruptions,
          physioFindings, perfGoal, hasCompetingContext, isOngoing } = layer;

  const physioNames = physioFindingNames(physioFindings);
  const disruptionPhrase = renderBehavioralDisruptionList(behavioralDisruptions);

  // ── Travel ──────────────────────────────────────────────────────────────
  if (contextType === 'travel') {
    if (physioResponse === 'stable') {
      if (disruptionPhrase) {
        return `While traveling, ${disruptionPhrase}. Even so, ${physioNames} stayed close to your usual range.`;
      }
      return `Your recovery has stayed close to your usual range so far on this trip.`;
    }
    // responding
    if (disruptionPhrase) {
      return `While traveling, ${disruptionPhrase}${isOngoing ? '' : ' during the trip'}, and ${physioNames} ${isOngoing ? 'has' : 'had'} dipped below your usual range.`;
    }
    return isOngoing
      ? `Your recovery has been lower than usual during the trip — ${physioNames} is running below your normal range.`
      : `Your recovery dipped during the trip — ${physioNames} was below your usual range.`;
  }

  // ── Illness ──────────────────────────────────────────────────────────────
  if (contextType === 'illness') {
    if (physioResponse === 'stable') {
      return isOngoing
        ? `You've been under the weather, but ${physioNames} has stayed close to your usual range so far.`
        : `Even while sick, ${physioNames} stayed relatively close to your usual range.`;
    }
    return isOngoing
      ? `${capitalizeFirst(physioNames)} is running below your usual range while you're under the weather.`
      : `${capitalizeFirst(physioNames)} dipped below your usual range during that illness.`;
  }

  // ── Stressful period ────────────────────────────────────────────────────
  if (contextType === 'stressful_period') {
    if (physioResponse === 'stable') {
      return isOngoing
        ? `You've been carrying a lot lately, but ${physioNames} has stayed steady.`
        : `Through that stressful stretch, ${physioNames} held relatively close to your usual range.`;
    }
    return isOngoing
      ? `${capitalizeFirst(physioNames)} has been running lower during this stressful stretch.`
      : `${capitalizeFirst(physioNames)} ran below your usual range during that stressful period.`;
  }

  // ── Alcohol / late night (next-day view) ─────────────────────────────────
  //
  // Replaced by synthesis renderer: integrated prose, not paragraph-per-fact.
  // Evidence is woven into 2–4 sentences that answer "why interesting today?"
  // See buildAlcoholNightSynthesis() for full voice/structure documentation.
  //
  if (contextType === 'alcohol_night') {
    return buildAlcoholNightSynthesis(layer, contextualPattern);
  }

  // ── Short sleep + same-day activity ─────────────────────────────────────────
  //
  // Replaced by synthesis renderer: integrated prose, not paragraph-per-fact.
  // See buildSleepActivitySynthesis() for full voice/structure documentation.
  //
  if (contextType === 'sleep_activity') {
    return buildSleepActivitySynthesis(layer, contextualPattern);
  }

  // ── Training elevated (no competing context) ─────────────────────────────
  if (contextType === 'training_elevated') {
    const goalPhrase = perfGoal && perfGoal !== 'general'
      ? ` with ${perfGoal === 'marathon' ? 'marathon' : perfGoal === '5k' ? '5K' : perfGoal === 'strength' ? 'strength' : 'your'} training`
      : '';
    if (physioResponse === 'stable') {
      return `You've been putting in more workout time${goalPhrase}, and your body appears to be keeping up — ${physioNames} is staying near your usual range.`;
    }
    return `Your workout time has been higher than usual${goalPhrase}, and ${physioNames} has dipped. Worth keeping an eye on as training continues.`;
  }

  // ── User-logged training block ────────────────────────────────────────────
  if (contextType === 'training_block') {
    if (hasCompetingContext) {
      // Training + another context simultaneously — acknowledge complexity
      return physioResponse === 'stable'
        ? `Training has been in the picture, and your recovery has stayed close to your usual range despite the additional demand.`
        : `There's more than one thing going on — training and other context are both active, and ${physioNames} has been lower than usual.`;
    }
    if (physioResponse === 'stable') {
      return isOngoing
        ? `Your training block is ongoing, and ${physioNames} has been staying close to your usual range.`
        : `${capitalizeFirst(physioNames)} held near your usual range through your training block.`;
    }
    return isOngoing
      ? `During your training block, ${physioNames} has been lower than usual.`
      : `${capitalizeFirst(physioNames)} dipped during your training block.`;
  }

  // ── User-defined (no emotional valence assumed) ───────────────────────────
  if (contextType === 'user_defined') {
    const label = contextLabel.toLowerCase();
    if (physioResponse === 'stable') {
      return isOngoing
        ? `${contextLabel} has been in the picture, and your recovery has stayed close to your usual range.`
        : `Through ${label}, ${physioNames} stayed relatively close to your usual range.`;
    }
    return isOngoing
      ? `${contextLabel} is ongoing, and ${physioNames} has been running lower than usual.`
      : `${capitalizeFirst(physioNames)} was below your usual range during ${label}.`;
  }

  return null;
}

/**
 * Render a confirmed-pattern bridge story.
 *
 * Language constraints (per product spec):
 *   - Observational: state what the data shows, not what it means physiologically
 *   - No mechanism claims ("your nervous system is adapting", "your body is managing")
 *   - No causation ("X caused Y")
 *   - Present the pattern as something BellaHealth learned, not a fact about the user's body
 *   - Present today's metric as a fact about today's data
 */
function renderConfirmedPatternStory(finding: ConfirmedPatternFinding): string | null {
  const {
    inputLabel, outcomeLabel, patternDirection,
    todayOutcomeDirection, todayOutcomeValue, baselineValue,
    observationCount,
  } = finding;

  // Format today's value concisely
  const rounded = (v: number) => Math.round(v);
  const valueStr =
    outcomeLabel === 'Sleep' ? `${todayOutcomeValue.toFixed(1)}h` :
    outcomeLabel === 'HRV'   ? `${rounded(todayOutcomeValue)}ms`  :
    String(rounded(todayOutcomeValue));
  const baselineStr =
    outcomeLabel === 'Sleep' ? `${baselineValue.toFixed(1)}h` :
    outcomeLabel === 'HRV'   ? `${rounded(baselineValue)}ms`  :
    String(rounded(baselineValue));

  const aboveBelow   = todayOutcomeDirection === 'above_baseline' ? 'above' : 'below';
  const runningDir   = todayOutcomeDirection === 'above_baseline' ? 'higher' : 'lower';
  const nObs         = observationCount >= 10 ? 'consistently' : 'repeatedly';

  // Is today's outcome in the direction the pattern predicts?
  const aligned =
    (patternDirection === 'positive' && todayOutcomeDirection === 'above_baseline') ||
    (patternDirection === 'negative' && todayOutcomeDirection === 'below_baseline');

  // Lead with what's happening today; reference the pattern as framing context —
  // not the other way around. This creates the "aha" rather than a statistics report.
  const valueLine =
    `Your ${inlineLowercase(outcomeLabel)} is running ${runningDir} than your usual range today — ` +
    `${valueStr} vs. your baseline of ${baselineStr}.`;

  if (aligned) {
    return (
      `${valueLine}\n\n` +
      `BellaHealth has ${nObs} seen a connection between ${inputLabel.toLowerCase()} and ` +
      `${inlineLowercase(outcomeLabel)} in your data — consistent with what's showing up today.`
    );
  } else {
    // Counter to the pattern direction — also worth noting (resilience signal)
    return (
      `${valueLine}\n\n` +
      `BellaHealth has ${nObs} tracked a connection between ${inputLabel.toLowerCase()} and ` +
      `${inlineLowercase(outcomeLabel)} in your data — today's reading is running in the other direction.`
    );
  }
}

export function renderStoryEpisode(episode: StoryEpisode): string | null {
  if (!episode.surfaceWorthy) return null;

  // ── Context-response contrast path ────────────────────────────────────────
  // Only fires when core gates did not — contrast stories have lower evidence
  // bars and should not compete with the richer core stories.
  if (episode.contextResponseContrast !== null && !episode.surfaceWorthyCore) {
    return renderContextResponseContrast(episode.contextResponseContrast, episode.contextualPattern);
  }

  // ── Confirmed-pattern bridge path ─────────────────────────────────────────
  // Only fires when neither core gates nor contrast gate fired.
  if (episode.confirmedPatternLayer !== null && !episode.surfaceWorthyCore) {
    return renderConfirmedPatternStory(episode.confirmedPatternLayer);
  }

  const parts: string[] = [];

  const hasEventContext = !!(episode.contextEvent?.hasEnoughEvidence || episode.transition);

  // ── 1–3. Setup, hydration, interpretation ──────────────────────────────────
  // For transitions: render only the preceding-event changes here.
  // The outcome bridge ("You logged feeling sick…") comes AFTER interpretation (slot 3b).
  let setupText: string | null = null;
  let setupIsPhysiological = false;
  if (episode.transition) {
    const s = renderTransitionSetup(episode.transition);
    if (s) setupText = s;
  } else if (episode.contextEvent?.hasEnoughEvidence) {
    const s = renderContextEventLayer(episode.contextEvent);
    if (s) setupText = s;
  } else if (episode.physiologicalState) {
    const s = renderPhysiologicalStateLayer(episode.physiologicalState);
    if (s) { setupText = s; setupIsPhysiological = true; }
  }

  // Use the event type that the hydrationContext was computed for:
  //   when a transition exists → preceding event type (e.g. travel)
  //   otherwise → current context event type
  const hydrationEventType =
    episode.transition?.precedingEventType ?? episode.contextEvent?.eventType;
  let hydrationText: string | null = null;
  if (episode.hydrationContext) {
    const h = renderHydrationContext(episode.hydrationContext, hydrationEventType);
    if (h) hydrationText = h;
  }

  // routine_disruption is always skipped (setup already covered it).
  let interpretationText: string | null = null;
  if (episode.interpretation?.hasInterpretation &&
      episode.interpretation.connectionType !== 'routine_disruption') {
    const i = renderInterpretationLayer(episode.interpretation, !!episode.transition);
    if (i) interpretationText = i;
  }

  // When a context event + strain_accumulation + no hydration note: merge setup+interpretation
  // into a single lead paragraph so the insight leads instead of being buried in paragraph 3.
  const canMerge =
    !episode.transition &&
    episode.contextEvent?.hasEnoughEvidence &&
    episode.interpretation?.connectionType === 'strain_accumulation' &&
    hydrationText === null &&
    setupText !== null &&
    interpretationText !== null;

  if (canMerge) {
    parts.push(`${setupText} ${interpretationText}`);
  } else {
    if (setupText)          parts.push(setupText);
    if (hydrationText)      parts.push(hydrationText);
    if (interpretationText) parts.push(interpretationText);
  }

  // ── 3b. Transition bridge ───────────────────────────────────────────────
  // "You logged feeling sick shortly after your trip." — placed AFTER interpretation
  // so the narrative reads: what was different → why it may matter → what happened next.
  if (episode.transition) {
    const bridge = renderTransitionBridge(episode.transition);
    if (bridge) parts.push(bridge);
  }

  // ── 4. Aftermath OR episode-relevant behavioral detail ────────────────────
  if (episode.aftermath?.hasEvidence) {
    const a = renderAftermathLayer(episode.aftermath);
    if (a) parts.push(a);
  } else {
    // Behavioral findings only appear in Your Story when there is event context.
    // Without event context, historical correlations (sauna, alcohol, etc.) belong
    // in What's Connected — not Your Story.
    // Within event context, only recovery-aligned behaviors are shown:
    // gratitude, sauna, cold_plunge, electrolytes.
    const RECOVERY_BEHAVIOR_TYPES = new Set<BehavioralFinding['behaviorType']>([
      'gratitude', 'sauna', 'cold_plunge', 'electrolytes',
    ]);
    const topBehavior = hasEventContext
      ? [...episode.behavioralFindings]
          .filter(f => f.evidence.strength !== 'isolated_coincidence')
          .filter(f => RECOVERY_BEHAVIOR_TYPES.has(f.behaviorType))
          .sort((a, b) => evidenceRank(b.evidence.strength) - evidenceRank(a.evidence.strength))[0]
      : null;

    if (topBehavior) {
      const t = renderBehavioralFinding(topBehavior);
      if (t) parts.push(t);
    } else if (episode.physiologicalState?.conflicting) {
      // Without event context the setup slot already rendered this exact
      // physiological sentence — don't repeat it.
      if (!setupIsPhysiological) {
        const t = renderPhysiologicalStateLayer(episode.physiologicalState);
        if (t) parts.push(t);
      }
    } else if (!hasEventContext) {
      if (episode.currentDirection) {
        const t = renderCurrentDirectionLayer(episode.currentDirection);
        if (t) parts.push(t);
      }
    }
  }

  // ── 5. Closing thought ────────────────────────────────────────────────────
  // For completed episodes, prefer a specific futureLesson over a generic nextFocus.
  // Illness/recovery episodes use nextFocus or currentDirection (no futureLesson).
  // For ongoing episodes, futureLesson is never populated so nextFocus takes priority.
  const isCompletedEpisode = !!(episode.contextEvent && !episode.contextEvent.isOngoing);

  if (isCompletedEpisode && episode.futureLesson?.hasLesson) {
    const f = renderFutureLessonLayer(episode.futureLesson, episode.contextEvent);
    if (f) parts.push(f);
  } else if (episode.nextFocus?.hasRecommendation) {
    const n = renderNextFocusLayer(episode.nextFocus);
    if (n) parts.push(n);
  } else if (episode.futureLesson?.hasLesson) {
    const f = renderFutureLessonLayer(episode.futureLesson, episode.contextEvent);
    if (f) parts.push(f);
  } else if (hasEventContext && episode.currentDirection) {
    const t = renderCurrentDirectionLayer(episode.currentDirection);
    if (t) parts.push(t);
  }

  // ── Nutrition observation (appended when density allows) ──────────────────
  if (parts.length < 5) {
    const topNutrition = [...(episode.nutritionLayer?.findings ?? [])]
      .filter(f => f.evidence.strength !== 'isolated_coincidence')
      .sort((a, b) => evidenceRank(b.evidence.strength) - evidenceRank(a.evidence.strength))[0];
    if (topNutrition) {
      const t = renderNutritionFinding(topNutrition);
      if (t) parts.push(t);
    }
  }

  return parts.length > 0 ? parts.join('\n\n') : null;
}

// ─── USER-FACING STORY RULES ──────────────────────────────────────────────────
//
// These rules govern ALL Story output (real engine + demo). Enforced via
// polishStoryForConsumer() as a final pass in buildEnhancedStory().
//
// 1. One primary insight per Story — not a list of observations.
// 2. Short paragraphs (3–5 is the default).
// 3. Lead with the most surprising or useful observation.
// 4. Use the minimum numbers needed for credibility — don't quote metrics twice.
// 5. No analytical language: "correlation", "dip depth", "recovery duration",
//    "independent of", "statistically", "recovery-aligned", "recovery signals".
// 6. Cautious causal language only: "appeared alongside", "looks consistent with"
//    — never "caused" or "led to".
// 7. No moralizing, no optimization coaching, no "you should" framing.
// 8. Target voice: "I wouldn't have noticed that on my own."
// 9. Never sacrifice the "aha" to make the sentence shorter.
//    Simplify sentence structure, not the underlying meaning.
//    Preserve: metric names, direction of pattern, relevant context, the specific
//    finding that made the insight valuable.
//    Avoid vague nouns (things, signals, changes, patterns) when the engine knows
//    the actual metric. Every Story should answer: "What did BellaHealth notice?"
//
// ─────────────────────────────────────────────────────────────────────────────

const CONSUMER_PHRASE_MAP: ReadonlyArray<[RegExp, string]> = [
  // Replace generic "Recovery signals" with named metrics and natural phrasing
  [/\bRecovery signals have been trending lower recently\b/gi, 'Readiness and HRV have both been trending lower over the past few days'],
  // Replace remaining analytical-language phrases
  [/\brecovery signals\b/gi,   'readiness and HRV'],
  [/\brecovery duration\b/gi,  'how long recovery took'],
  [/\bindependent of\b/gi,     'regardless of'],
  [/\bstatistically\b/gi,      ''],
  [/\bdip depth\b/gi,          'how far it fell'],
];

/**
 * Final-pass phrase cleanup applied to all Story output.
 * Converts analytical/clinical phrasing to natural consumer language
 * without touching the detection or composition logic.
 */
/**
 * Drop a paragraph that exactly repeats the one before it. Used for stories
 * persisted by builds where renderStoryEpisode() could emit the same
 * physiological sentence in two slots.
 */
export function collapseRepeatedParagraphs(story: string): string {
  const paras = story.split(/\n{2,}/);
  return paras.filter((p, i) => i === 0 || p.trim() !== paras[i - 1].trim()).join('\n\n');
}

function polishStoryForConsumer(story: string): string {
  let result = story;
  for (const [pattern, replacement] of CONSUMER_PHRASE_MAP) {
    result = result.replace(pattern, replacement);
  }
  return result.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Builds "Your Story" text using the structured StoryEpisode intermediate rep.
 * Returns null when no story-worthy finding exists — the caller is responsible
 * for showing an appropriate empty state.
 *
 * The story-worthiness gate lives in buildStoryEpisode() (story-engine.ts).
 * A null result means the engine found data but nothing meaningfully worth
 * surfacing as a Story. This is intentional — it is better to say nothing
 * than to dress up a metric observation as an insight.
 *
 * Applies polishStoryForConsumer() as a final pass on all output.
 */
// ─── Training goal type ───────────────────────────────────────────────────────

/**
 * Training goal set by the user.
 * body:  body-composition goal (cut | bulk | maintenance | recomp | null)
 * perf:  performance/sport goal (marathon | 5k | strength | sport | general | null)
 *
 * The goal is an interpretation lens, not copy.
 * It is passed into buildStoryEpisode() where it influences what the engine
 * prioritises and how behavior changes are framed — not appended as flavor text.
 */
export type TrainingGoal = { body: string | null; perf: string | null };

/**
 * Builds "Your Story" text using the structured StoryEpisode intermediate rep.
 *
 * The training goal passes into buildStoryEpisode() where it acts as an
 * interpretation lens: elevated workout time with a perf goal becomes context
 * that the engine uses to frame physiological findings appropriately.
 *
 * seenContrastKeys: an optional Set of suppression keys already shown to the user.
 * When provided, a contrast-only story whose key is in this set is suppressed
 * (the same observation should not surface every day). Returns null in that case,
 * allowing the caller to show the normal empty state instead.
 *
 * Returns { story, contrastKeyShown } so callers can persist new keys.
 */
export function buildEnhancedStoryWithKey(
  synthesis: SynthesisResult,
  timeline: HealthDayRecord[],
  today: HealthDayRecord,
  trainingGoal?: TrainingGoal,
  seenContrastKeys?: Set<string>,
  now?: Date,
): { story: string | null; contrastKeyShown: string | null } {
  const episode = buildStoryEpisode(synthesis, timeline, today, trainingGoal, now);

  // Suppress contrast-only stories we've already shown (same event + same physio state).
  const contrastKey = episode.contextResponseContrast?.suppressionKey ?? null;
  if (__DEV__) {
    console.log('[buildEnhancedStoryWithKey] contrastKey:', contrastKey,
      '| surfaceWorthyCore:', episode.surfaceWorthyCore,
      '| seenKeys:', seenContrastKeys ? [...seenContrastKeys] : 'undefined',
      '| suppressed:', !!(contrastKey && !episode.surfaceWorthyCore && seenContrastKeys?.has(contrastKey)));
  }
  if (
    contrastKey &&
    !episode.surfaceWorthyCore &&
    seenContrastKeys?.has(contrastKey)
  ) {
    return { story: null, contrastKeyShown: null };
  }

  const rendered = renderStoryEpisode(episode);
  if (!rendered) return { story: null, contrastKeyShown: null };

  const polished = polishStoryForConsumer(rendered);
  // Only report the key as "shown" when it was a contrast-only story.
  const keyShown = (!episode.surfaceWorthyCore && contrastKey) ? contrastKey : null;
  return { story: polished, contrastKeyShown: keyShown };
}

/**
 * Convenience wrapper — same as buildEnhancedStoryWithKey but returns only
 * the story string. Use when suppression tracking is not needed (e.g. tests,
 * demo mode).
 */
export function buildEnhancedStory(
  synthesis: SynthesisResult,
  timeline: HealthDayRecord[],
  today: HealthDayRecord,
  trainingGoal?: TrainingGoal,
  seenContrastKeys?: Set<string>,
  now?: Date,
): string | null {
  return buildEnhancedStoryWithKey(synthesis, timeline, today, trainingGoal, seenContrastKeys, now).story;
}

// ─── (existing) buildYourStory ────────────────────────────────────────────────

/**
 * Builds a plain-English Your Story summary from SynthesisResult.
 * Entirely deterministic — no LLM. Three mutually exclusive tiers:
 *
 *   Tier 1 — Episodic synthesis (highest priority):
 *     Multi-event contextual narrative when a current event is immediately
 *     preceded by another event whose health changes independently qualify.
 *     Example: Travel → lower sleep + higher activity → ongoing Illness.
 *     Prevents contradiction: the episodic narrative replaces both the
 *     metric theme AND the event finding with a single coherent story.
 *
 *   Tier 2 — Single-event finding:
 *     Describes one qualified event window. Used alone — never combined with
 *     the metric theme — to prevent semantic contradiction.
 *
 *   Tier 3 — Primary metric theme:
 *     Today's metric state, only when no event context qualifies.
 *
 * Event existence alone never produces output.
 * No causation language. No population-norm comparisons.
 */
export function buildYourStory(synthesis: SynthesisResult): string | null {
  // Tier 1: episodic multi-event synthesis
  const episodic = buildEpisodicStory(synthesis);
  if (episodic) return episodic;

  // Tier 2: single-event finding (used alone to prevent metric+event contradiction)
  const eventFinding = (synthesis.eventWindows ?? [])
    .map(buildEventFinding)
    .find((f): f is string => f !== null) ?? null;
  if (eventFinding) return eventFinding;

  // Tier 3: primary metric theme
  return buildPrimaryThemeSentence(synthesis);
}

// ─── Day-of-week observation text ─────────────────────────────────────────────

// Human-readable signal descriptions for DOW observation sentences.
const DOW_SIGNAL_LABEL: Partial<Record<string, string>> = {
  readiness:           'readiness',
  hrv:                 'HRV',
  sleepScore:          'sleep quality',
  sleepHours:          'sleep duration',
  stressHighMinutes:   'physiological stress',
  recoveryHighMinutes: 'restorative time',
};

const DOW_DIRECTION_PHRASE: Record<'above_baseline' | 'below_baseline', Record<string, string>> = {
  above_baseline: {
    readiness:           'higher',
    hrv:                 'higher',
    sleepScore:          'better',
    sleepHours:          'longer',
    stressHighMinutes:   'elevated',
    recoveryHighMinutes: 'higher',
  },
  below_baseline: {
    readiness:           'lower',
    hrv:                 'lower',
    sleepScore:          'lower',
    sleepHours:          'shorter',
    stressHighMinutes:   'lower',
    recoveryHighMinutes: 'lower',
  },
};

/**
 * Generate the observation sentence and open-ended follow-up question
 * for a day-of-week pattern.
 *
 * Language rules:
 *   - Purely observational — no causal verbs, no diagnoses.
 *   - Personal: "your readiness tends to be lower" not "readiness is lower".
 *   - Hedged for EARLY tier ("so far", "often").
 *   - Question is open-ended, never leading ("Does anything usually happen on X?").
 */
export function dowObservationText(
  pattern: DowPatternResult,
): { observationText: string; questionText: string } {
  const signalLabel = DOW_SIGNAL_LABEL[pattern.signal] ?? pattern.signal;
  const dirPhrase =
    DOW_DIRECTION_PHRASE[pattern.direction]?.[pattern.signal] ??
    (pattern.direction === 'above_baseline' ? 'higher' : 'lower');
  const day = pattern.dayLabel;   // e.g. "Thursdays"
  const dayPlural = day.endsWith('s') ? day : `${day}s`; // "Thursday" → "Thursdays"

  const isEarly = pattern.confidenceTier === 'EARLY';
  const tendVerb = isEarly ? 'has often been' : 'tends to be';

  const observationText = isEarly
    ? `So far, your ${signalLabel} has often been ${dirPhrase} on ${dayPlural}.`
    : `Your ${signalLabel} ${tendVerb} ${dirPhrase} on ${dayPlural}.`;

  const questionText = `Does anything usually happen on ${dayPlural}?`;

  return { observationText, questionText };
}
