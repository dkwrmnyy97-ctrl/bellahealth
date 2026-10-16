/**
 * context.tsx — BellaHealth Context screen
 *
 * "Your health, in context."
 *
 * Sections:
 *   1. Header + Your Story     — deterministic synthesis summary
 *   2. What's Connected        — top patterns from context engine
 *   3. Life + Health           — ContextEvent timeline with before/during/after
 *   4. Your Picture            — domain coverage
 *   5. Talk more CTA           — opens Chat with ContextSummary
 *
 * All visible text is derived from deterministic engine output.
 * No AI prose generated on page load. No auto-Claude calls.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';

import { ThemedText } from '@/components/themed-text';
import { ChatModal } from '@/components/chat-modal';
import { ContextWalkthrough, CONTEXT_TOUR_KEY } from '@/components/context-walkthrough';
import { Fonts, Spacing, BHRadius, BottomTabInset } from '@/constants/theme';
import { useAppTheme } from '@/context/theme-context';
import { getModalPalette, type ModalPalette } from '@/utils/modal-palette';
import { trackEvent } from '@/services/analytics';
import { DEMO_MODE } from '@/config/demo';
import { useExplore } from '@/context/explore-context';
import {
  DEMO_CONTEXT_DAYS, DEMO_CONTEXT_EVENTS, DEMO_CONTEXT_STORAGE_DAYS,
  DEMO_EXPLORE_STORY,
} from '@/demo/demo-data';

// Services
import {
  getOuraToken, fetchOuraWeekly, fetchOuraTodayPatch, type OuraWeeklyDay,
} from '@/services/oura';
import {
  getRecentWorkouts, getTodaySteps, getLatestHRV,
  getHistoricalSleepHours, type WorkoutSample,
} from '@/services/healthkit';
import {
  buildHealthTimelineFromStorage,
  detectPatterns, analyzeEventWindow, rankPatternsForDisplay,
  type PatternResult, type HealthDayRecord,
  type EventWindowAnalysis,
} from '@/services/pattern-engine';
import { Ionicons } from '@expo/vector-icons';
import {
  loadContextEvents, deriveDrinkEvents,
  createContextEvent, deleteContextEvent, updateContextEvent,
  type ContextEvent, type ContextEventType,
} from '@/services/context-events';
import {
  buildTimelineFromAdapters,
} from '@/services/timeline-builder';
import { fetchNutritionHistory } from '@/services/supabase';
import {
  synthesizeContext, buildContextSummary,
  type SynthesisResult, type ContextSummary,
} from '@/services/context-synthesis';
import {
  computeCoverageForDisplay, type CoverageReport, type CoverageLevel, type DomainCoverage,
} from '@/services/context-coverage';

// Utilities
import {
  patternHeadline, patternSentence, patternEvidenceChip,
  patternDetailSentence, TIER_DESCRIPTION, TIER_LABEL,
  PERIOD_STAT_LABEL, formatStatValue, CONTEXT_EVENT_LABEL, eventLabel,
  buildEnhancedStoryWithKey, SIGNAL_LABEL, collapseRepeatedParagraphs,
} from '@/utils/pattern-language';
import { buildStoryEpisode, type DowObservationLayer, type DowObservation } from '@/services/story-engine';
import { SOURCE_LABELS, SIGNAL_FAMILY, type SourceName } from '@/services/pattern-registry';
import { detectDowPatterns } from '@/services/dow-pattern-engine';
import { dowObservationText } from '@/utils/pattern-language';
import {
  createDowObservationNote, expireStalePendingNotes, getActivePendingNotes,
  answerPatternObservation, dismissPatternObservation,
} from '@/services/pattern-observation-store';

// ─── Palette ───────────────────────────────────────────────────────────────────

function usePalette(): ModalPalette {
  const { isDark, userTheme } = useAppTheme();
  return getModalPalette(isDark, userTheme);
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const STALE_MS          = 5 * 60 * 1000;   // 5 minutes
const MAX_PATTERNS      = 4;

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isEventActiveOn(event: ContextEvent, date: string): boolean {
  if (event.startDate > date) return false;
  return !event.endDate || event.endDate >= date;
}

function formatDateRange(startDate: string, endDate?: string): string {
  const fmt = (s: string) => {
    const d = new Date(s + 'T12:00:00Z');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };
  if (!endDate) return `${fmt(startDate)} · ongoing`;
  if (startDate === endDate) return fmt(startDate);
  return `${fmt(startDate)} – ${fmt(endDate)}`;
}

// ─── Data loading ──────────────────────────────────────────────────────────────

interface ContextState {
  synthesis:         SynthesisResult | null;
  coverage:          CoverageReport | null;
  contextEvents:     ContextEvent[];
  timeline:          HealthDayRecord[];
  /** All analyzed event windows (completed and ongoing), most recent first. */
  eventWindows:      EventWindowAnalysis[];
  /** Deduplicated, usefulness-ranked patterns for What's Connected display */
  rankedPatterns:    PatternResult[];
  /** True if any evidence-eligible patterns existed before ranking/dedup */
  hadPatternEvidence: boolean;
  /**
   * True if any HealthKit movement data (steps or workouts) is present in the
   * 30-day timeline. Used to distinguish "HK not authorized" from "HK authorized
   * but no workout today" when generating the Movement coverage hint.
   */
  hkMovementInTimeline: boolean;
  /** Training goals as set in the Training modal — passed as interpretation lens */
  trainingGoal?: { body: string | null; perf: string | null };
  /** Suppression keys for contrast-only Stories already shown to the user */
  seenContrastKeys: Set<string>;
  /** Active day-of-week pattern observations awaiting user response. Null until loaded. */
  dowObservationLayer: DowObservationLayer | null;
  /** Last story that passed story-worthiness gates, persisted across restarts. */
  persistedStory: PersistedStory | null;
  isLoading:         boolean;
  lastLoaded:        number;
}

const STORY_CONTRAST_STORAGE_KEY = 'story_contrast_seen_v1';
// TTL = 0 means keys expire at the next calendar day.
// Contrast keys embed the event date (e.g. 'alcohol_2026-09-30_responding'),
// so the same key can never fire on two different days regardless.
// Suppression only needs to apply within a single calendar day.
const CONTRAST_KEY_TTL_DAYS = 0;

// Last meaningful story: persisted so the user sees real insight even on days
// when Oura hasn't synced yet or today's data doesn't meet story-worthiness gates.
// No expiration — replaced whenever a new story generates. Cleared on sign-out.
const STORY_LAST_KEY = 'story_last_v1';
type PersistedStory = {
  storyText:   string;
  generatedAt: string;   // YYYY-MM-DD
  isContrast:  boolean;  // true if this was a contrast-only (not surfaceWorthyCore) story
  contrastKey: string | null;
};

const EMPTY_STATE: ContextState = {
  synthesis: null, coverage: null, contextEvents: [],
  timeline: [], eventWindows: [], rankedPatterns: [],
  hadPatternEvidence: false, hkMovementInTimeline: false,
  trainingGoal: undefined, seenContrastKeys: new Set(),
  dowObservationLayer: null, persistedStory: null,
  isLoading: true, lastLoaded: 0,
};

async function loadContextState(isExploring = false): Promise<ContextState> {
  if (__DEV__) console.log('[loadContextState] called — isExploring:', isExploring, 'DEMO_MODE:', DEMO_MODE);
  const today = todayStr();

  if (DEMO_MODE || isExploring) {
    // Use the last day of demo data as the "today" anchor so that synthesis has
    // real signals. Using the real todayStr() (e.g. 2026-09-30) would find no
    // record in demo data (which ends at 2026-09-02) → empty synthesis → no story.
    const demoToday = DEMO_CONTEXT_DAYS[DEMO_CONTEXT_DAYS.length - 1].date;
    const timeline = buildTimelineFromAdapters({
      ouraWeeklyDays: DEMO_CONTEXT_DAYS,
      storageLogs:    DEMO_CONTEXT_STORAGE_DAYS,
    });
    const rawPatterns = detectPatterns(timeline);
    const baseTodayRec = timeline.find((d) => d.date === demoToday) ?? { date: demoToday };
    const activeEvts  = DEMO_CONTEXT_EVENTS.filter((e) => isEventActiveOn(e, demoToday));
    const todayRec: HealthDayRecord = {
      ...baseTodayRec,
      activeContextTypes: [
        ...(baseTodayRec.activeContextTypes ?? []),
        ...activeEvts.map((e) => e.type),
      ].filter((v, i, a) => a.indexOf(v) === i),
    };
    const activeEventTypes = activeEvts.map((e) => e.type);
    const { ranked: rankedPatterns, hadEvidence: hadPatternEvidence } =
      rankPatternsForDisplay(rawPatterns, activeEventTypes);
    const eventWindows = DEMO_CONTEXT_EVENTS.slice(0, 5).map((e) => analyzeEventWindow(e, timeline, demoToday));
    const synthesis   = synthesizeContext({
      today: todayRec, patterns: rankedPatterns,
      activeContextEvents: DEMO_CONTEXT_EVENTS, eventWindows,
    });
    const hkMovementInTimeline = timeline.some(
      (d) => d.hkSteps !== undefined || d.workoutDurationMin !== undefined || d.ouraSteps !== undefined
    );
    return {
      synthesis,
      coverage: computeCoverageForDisplay(todayRec, timeline),
      contextEvents: DEMO_CONTEXT_EVENTS,
      timeline, eventWindows, rankedPatterns, hadPatternEvidence, hkMovementInTimeline,
      seenContrastKeys: new Set(), dowObservationLayer: null, persistedStory: null,
      isLoading: false, lastLoaded: Date.now(),
    };
  }

  // ── Real data loading ────────────────────────────────────────────────────
  const [token, storageLogs, contextEvents, nutritionHistory, trainingGoalsRaw, contrastSeenRaw, savedProfileRaw, storyLastRaw] = await Promise.all([
    getOuraToken(),
    buildHealthTimelineFromStorage().catch((): HealthDayRecord[] => []),
    loadContextEvents().catch((): ContextEvent[] => []),
    fetchNutritionHistory(30).catch(() => new Map<string, { calories: number; protein_g: number; carbs_g: number; fat_g: number }>()),
    AsyncStorage.getItem('training_goals').catch(() => null),
    AsyncStorage.getItem(STORY_CONTRAST_STORAGE_KEY).catch(() => null),
    AsyncStorage.getItem('user_profile').catch(() => null),
    AsyncStorage.getItem(STORY_LAST_KEY).catch(() => null),
  ]);
  let trainingGoal: { body: string | null; perf: string | null } | undefined;
  try {
    if (trainingGoalsRaw) trainingGoal = JSON.parse(trainingGoalsRaw);
  } catch {}

  let waterGoalOz: number | undefined;
  try {
    if (savedProfileRaw) {
      const profile = JSON.parse(savedProfileRaw);
      const parsed = Number(profile.waterGoal);
      if (!isNaN(parsed) && parsed > 0) waterGoalOz = parsed;
    }
  } catch {}

  // Load last persisted story (shown as fallback when today's story is null).
  let persistedStory: PersistedStory | null = null;
  try {
    if (storyLastRaw) {
      persistedStory = JSON.parse(storyLastRaw) as PersistedStory;
      persistedStory.storyText = collapseRepeatedParagraphs(persistedStory.storyText);
    }
  } catch {}

  // Load and prune suppression keys older than TTL.
  let seenContrastKeys = new Set<string>();
  try {
    if (contrastSeenRaw) {
      const entries: Array<{ key: string; seenAt: string }> = JSON.parse(contrastSeenRaw);
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - CONTRAST_KEY_TTL_DAYS);
      const cutoff = cutoffDate.toISOString().split('T')[0];
      seenContrastKeys = new Set(
        entries.filter(e => e.seenAt >= cutoff).map(e => e.key),
      );
    }
  } catch {}

  const [hkWorkouts, hkStepsToday, hkHrv, hkSleepByDate] = await Promise.all([
    getRecentWorkouts(30).catch((): WorkoutSample[] => []),
    getTodaySteps().catch(()  => 0),
    getLatestHRV().catch(()   => 0),
    getHistoricalSleepHours(30).catch((): Record<string, number> => ({})),
  ]);

  let ouraWeeklyDays: OuraWeeklyDay[] = [];
  if (token) {
    ouraWeeklyDays = await fetchOuraWeekly(token, 30).catch(() => []);

    // fetchOuraWeekly always generates a today entry, but fills it with zeros
    // when Oura hasn't finished processing overnight data yet (common before ~10am).
    // adaptOuraWeekly excludes zero values, so today's timeline record ends up with
    // no Oura metrics — which silences the story engine. Patch with a direct
    // today-only query that returns null (not yesterday) if data isn't ready yet.
    const todayEntry = ouraWeeklyDays.find(d => d.date === today);
    const todayHasOuraData = todayEntry && (todayEntry.readiness > 0 || todayEntry.sleepScore > 0);
    if (!todayHasOuraData) {
      const patch = await fetchOuraTodayPatch(token).catch(() => null);
      if (patch) {
        ouraWeeklyDays = ouraWeeklyDays.map(d => d.date === today ? patch : d);
      }
    }
  }

  const timeline = buildTimelineFromAdapters({
    ouraWeeklyDays,
    hkWorkouts,
    hkSleepByDate,
    hkStepsToday:     hkStepsToday > 0   ? { steps: hkStepsToday, date: today } : undefined,
    hkHrvToday:       hkHrv > 0          ? { hrv: hkHrv,           date: today } : undefined,
    storageLogs,
    nutritionHistory: nutritionHistory.size > 0 ? nutritionHistory : undefined,
  });

  const rawPatterns = detectPatterns(timeline);
  const baseTodayRec = timeline.find((d) => d.date === today) ?? { date: today };
  const activeEvts  = contextEvents.filter((e) => isEventActiveOn(e, today));

  // Also include events from last 30 days as "relevant" (for Life + Health context).
  // deriveDrinkEvents() is ephemeral — only for synthesis, never stored in state.contextEvents
  // (which feeds the Life + Health UI and should only contain user-logged events).
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const cutoff = thirtyDaysAgo.toISOString().split('T')[0];
  const drinkContextEvents = await deriveDrinkEvents().catch((): ContextEvent[] => []);
  if (__DEV__) {
    console.log('[loadContextState] today:', today);
    console.log('[loadContextState] drinkContextEvents:', drinkContextEvents.length,
      drinkContextEvents.map(e => `date=${e.startDate} drinks=${e.metadata?.totalDrinks}`));
    console.log('[loadContextState] seenContrastKeys:', [...seenContrastKeys]);
  }
  const recentEvts = [
    ...contextEvents.filter((e) => e.startDate >= cutoff || (e.endDate ?? today) >= cutoff),
    ...drinkContextEvents.filter((e) => e.startDate >= cutoff),
  ];
  if (__DEV__) {
    console.log('[loadContextState] recentEvts:', recentEvts.length,
      recentEvts.map(e => `type=${e.type} date=${e.startDate}`));
  }

  // Merge active context event types into todayRec so coverage correctly reflects them
  const todayRec: HealthDayRecord = {
    ...baseTodayRec,
    activeContextTypes: [
      ...(baseTodayRec.activeContextTypes ?? []),
      ...activeEvts.map((e) => e.type),
    ].filter((v, i, a) => a.indexOf(v) === i),
  };

  const activeEventTypes = recentEvts.map((e) => e.type);
  const { ranked: rankedPatterns, hadEvidence: hadPatternEvidence } =
    rankPatternsForDisplay(rawPatterns, activeEventTypes);

  // Analyze ALL recent user-logged events — both completed and ongoing.
  // Previously only the most recently ended bounded event was analyzed, silently
  // ignoring ongoing events (e.g. illness with no endDate).
  const eventWindows: EventWindowAnalysis[] = recentEvts
    .sort((a, b) => b.startDate.localeCompare(a.startDate))  // most recent first
    .slice(0, 5)
    .flatMap((e) => {
      try { return [analyzeEventWindow(e, timeline, today)]; } catch { return []; }
    });

  const synthesis = synthesizeContext({
    today: todayRec, patterns: rankedPatterns, activeContextEvents: recentEvts, eventWindows,
    waterGoalOz,
  });

  // True when any HK movement signal reached the timeline — distinguishes
  // "HK not authorized / no data" from "HK authorized, just no workout today"
  const hkMovementInTimeline = timeline.some(
    (d) => d.hkSteps !== undefined || d.workoutDurationMin !== undefined
  );

  // ── Day-of-week pattern observations ──────────────────────────────────────
  // Detect recurring DOW patterns, expire stale notes, create new notes for
  // qualifying patterns, then surface at most 2 pending observations (one per
  // signal family) for the user to reflect on.
  let dowObservationLayer: DowObservationLayer | null = null;
  try {
    const dowPatterns = detectDowPatterns(timeline);
    const activePatternIds = new Set(dowPatterns.map((p) => p.id));

    // Silently expire notes whose patterns have dissolved
    await expireStalePendingNotes(activePatternIds);

    // Idempotently create notes for all qualifying patterns
    for (const pattern of dowPatterns) {
      const { observationText, questionText } = dowObservationText(pattern);
      await createDowObservationNote(pattern, observationText, questionText);
    }

    // Cap to 2, one per signal family (strongest first — detectDowPatterns sorts by strength)
    const pendingNotes = await getActivePendingNotes(activePatternIds);
    const seenFamilies = new Set<string>();
    const cappedNotes = pendingNotes.filter((note) => {
      const family = SIGNAL_FAMILY[note.signal as keyof typeof SIGNAL_FAMILY] ?? note.signal;
      if (seenFamilies.has(family)) return false;
      seenFamilies.add(family);
      return seenFamilies.size <= 2;
    });

    // Pair each note with its pattern for the render layer
    const observations: DowObservation[] = cappedNotes.flatMap((note) => {
      const pattern = dowPatterns.find((p) => p.id === note.id);
      return pattern ? [{ pattern, note }] : [];
    });

    dowObservationLayer = { observations, hasObservations: observations.length > 0 };
  } catch {
    // Non-critical — DOW observations degrade gracefully; page continues to render
  }

  return {
    synthesis,
    coverage: computeCoverageForDisplay(todayRec, timeline, recentEvts.length),
    contextEvents,
    timeline, eventWindows, rankedPatterns, hadPatternEvidence, hkMovementInTimeline,
    trainingGoal,
    seenContrastKeys,
    dowObservationLayer,
    persistedStory,
    isLoading: false, lastLoaded: Date.now(),
  };
}

// ─── DEV-only story diagnostic panel ─────────────────────────────────────────

function DevDiagPanel({
  synthesis, timeline, today, trainingGoal, seenContrastKeys, story,
}: {
  synthesis: SynthesisResult;
  timeline: HealthDayRecord[];
  today: HealthDayRecord;
  trainingGoal?: { body: string | null; perf: string | null };
  seenContrastKeys?: Set<string>;
  story: string | null;
}) {
  const [open, setOpen] = React.useState(false);

  const diag = React.useMemo(() => {
    // ── 1. Dates ────────────────────────────────────────────────────────────
    const todayDate = today.date;
    const d = new Date(todayDate + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() - 1);
    const yesterday = d.toISOString().split('T')[0];

    // ── 2. Drink-log entries in relevantContext ──────────────────────────────
    const allDrinkEvents = synthesis.relevantContext.filter(e => e.type === 'alcohol_period');
    const alcoholNightMatch = allDrinkEvents.find(
      e => e.startDate === yesterday && ((e.metadata?.totalDrinks as number) ?? 0) >= 2,
    );

    // ── 3 + 4. Today and yesterday HealthDayRecords ──────────────────────────
    const todayRec = {
      date: today.date,
      sleepHours: today.sleepHours,
      sleepScore: today.sleepScore,
      hrv: today.hrv,
      readiness: today.readiness,
      workoutDurationMin: today.workoutDurationMin,
      primaryActivityType: today.primaryActivityType,
      workoutCaloriesBurned: today.workoutCaloriesBurned,
      hkSteps: today.hkSteps,
      ouraSteps: today.ouraSteps,
      waterOz: today.waterOz,
      totalAlcoholDrinks: today.totalAlcoholDrinks,
    };
    const yesterdayRec = timeline.find(d2 => d2.date === yesterday);
    const yesterdaySnap = yesterdayRec
      ? { sleepHours: yesterdayRec.sleepHours, hrv: yesterdayRec.hrv, readiness: yesterdayRec.readiness }
      : 'not in timeline';

    // ── 9. Water history ─────────────────────────────────────────────────────
    const waterEntries = timeline
      .filter(d2 => d2.waterOz !== undefined)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 10)
      .map(d2 => `${d2.date}=${d2.waterOz}oz`);

    // ── 11–16. Episode internals ─────────────────────────────────────────────
    const episode = buildStoryEpisode(synthesis, timeline, today, trainingGoal);
    const physioFindings = episode.physiologicalState?.findings ?? [];
    const contrastLayer = episode.contextResponseContrast;
    const contrastType = contrastLayer?.contextType ?? 'null';

    // Reconstruct gate logic for diagnostic
    const sleepFinding = physioFindings.find(
      f => f.metric === 'Sleep' && f.direction === 'below_baseline' &&
           (f.magnitude === 'moderate' || f.magnitude === 'substantial'),
    );
    const hasSleepWorkout = (today.workoutDurationMin ?? 0) >= 15;
    const meaningfulCtxEvent = synthesis.relevantContext.find(
      e => e.type !== 'alcohol_period' && e.startDate <= todayDate,
    );

    // ── Suppression state ────────────────────────────────────────────────────
    const contrastKey = contrastLayer?.suppressionKey ?? null;
    const suppressed = !!(contrastKey && !episode.surfaceWorthyCore && seenContrastKeys?.has(contrastKey));

    // ── 18. Fallback branch ──────────────────────────────────────────────────
    const noHistory = synthesis.primaryTheme.theme === 'insufficient_data';
    const hasPatterns = synthesis.allPatterns.length > 0;
    const hasCtxEvents = synthesis.relevantContext.length > 0;
    let fallbackBranch = 'n/a (story shown)';
    if (!story) {
      if (noHistory && hasPatterns) fallbackBranch = 'branch1: noHistory+hasPatterns';
      else if (!noHistory && hasCtxEvents) fallbackBranch = 'branch2: hasData+hasCtxEvents ← ACTIVE';
      else if (noHistory) fallbackBranch = 'branch3: noHistory (building baseline)';
      else fallbackBranch = 'branch4: nothing unusual';
    }

    return {
      '1_dates': { today: todayDate, yesterday },
      '2_drinkEvents': {
        count: allDrinkEvents.length,
        entries: allDrinkEvents.map(e => `${e.startDate}=${e.metadata?.totalDrinks}drks`),
        alcoholNightMatch: alcoholNightMatch
          ? `${alcoholNightMatch.startDate} (${alcoholNightMatch.metadata?.totalDrinks} drinks)`
          : 'NO MATCH (needs startDate===yesterday + ≥2 drinks)',
      },
      '3_today': todayRec,
      '4_yesterday': yesterdaySnap,
      '5_sleepHours': `${today.sleepHours ?? 'undef'} (Oura)`,
      '6_hrv': `${today.hrv ?? 'undef'} (Oura)`,
      '7_readiness': `${today.readiness ?? 'undef'} (Oura)`,
      '8_workout': `${today.workoutDurationMin ?? 'undef'}min | ${today.primaryActivityType ?? 'none'}`,
      '9_water': {
        waterGoalOz: synthesis.waterGoalOz ?? 'undef',
        loggedEntries: waterEntries,
        hydrationContext: episode.hydrationContext ?? 'null',
      },
      '10_relevantContext': synthesis.relevantContext.map(e => `${e.type}@${e.startDate}`),
      '11_physioFindings': physioFindings.length === 0
        ? 'EMPTY (gate fails if 0 findings)'
        : physioFindings.map(f => `${f.metric}=${f.direction}/${f.magnitude} actual=${f.actual} base=${f.baseline}`),
      '12_contextualPattern': episode.contextualPattern
        ? `${episode.contextualPattern.inputSignal}→${episode.contextualPattern.outcomeSignal}`
        : 'null',
      '13_contrastType': contrastType,
      '14_gates': {
        alcohol_night: {
          event: alcoholNightMatch ? 'FOUND' : 'NULL',
          physioFindings: physioFindings.length,
          pass: !!(alcoholNightMatch && physioFindings.length >= 1),
          reason: !alcoholNightMatch
            ? `no alcohol_period event with startDate=${yesterday} + ≥2 drinks`
            : physioFindings.length < 1
            ? 'physioFindings empty (need ≥1 — check baseline samples)'
            : 'PASS',
        },
        sleep_activity: {
          sleepFinding: sleepFinding
            ? `${sleepFinding.direction}/${sleepFinding.magnitude}`
            : 'NULL (need Sleep below_baseline moderate/substantial)',
          workoutMin: today.workoutDurationMin ?? 0,
          hasSleepWorkout,
          noAlcohol: !alcoholNightMatch,
          noMeaningfulCtx: !meaningfulCtxEvent,
          pass: !!(sleepFinding && hasSleepWorkout && !alcoholNightMatch && !meaningfulCtxEvent),
        },
        surfaceWorthyCore: episode.surfaceWorthyCore,
      },
      '15_contrastLayer': contrastLayer
        ? { contextType: contrastLayer.contextType, suppressionKey: contrastLayer.suppressionKey }
        : 'null (no contrast layer built)',
      '16_sleepActivityPath': {
        sleepFinding: sleepFinding ? `${sleepFinding.direction}/${sleepFinding.magnitude}` : 'null',
        workoutMin: today.workoutDurationMin ?? 0,
        evaluated: !!(episode.physiologicalState),
        result: sleepFinding && hasSleepWorkout ? 'WOULD PASS' : 'FAILS',
      },
      '17_story': story ?? 'null',
      '18_suppressionAndBranch': {
        contrastKey,
        seenKeys: seenContrastKeys ? [...seenContrastKeys] : [],
        suppressed,
        fallbackBranch,
      },
    };
  }, [synthesis, timeline, today, trainingGoal, seenContrastKeys, story]);

  return (
    <View style={{ marginTop: 10 }}>
      <Pressable
        onPress={() => setOpen(o => !o)}
        style={{
          backgroundColor: '#0d1117',
          borderRadius: 4,
          paddingHorizontal: 8,
          paddingVertical: 5,
          borderWidth: 1,
          borderColor: '#00ff88',
          alignSelf: 'flex-start',
        }}
      >
        <ThemedText style={{ color: '#00ff88', fontSize: 10 }}>
          {open ? '▼ STORY DIAG' : '▶ STORY DIAG'}
        </ThemedText>
      </Pressable>
      {open && (
        <ScrollView
          style={{ backgroundColor: '#0d1117', borderRadius: 4, marginTop: 4, maxHeight: 520, borderWidth: 1, borderColor: '#1e3a2e' }}
          contentContainerStyle={{ padding: 10 }}
          nestedScrollEnabled
        >
          {Object.entries(diag).map(([key, val]) => (
            <View key={key} style={{ marginBottom: 10 }}>
              <ThemedText style={{ color: '#00ff88', fontSize: 9.5 }}>
                [{key}]
              </ThemedText>
              <ThemedText style={{ color: '#e0e0e0', fontSize: 9.5 }}>
                {typeof val === 'string' ? val : JSON.stringify(val, null, 2)}
              </ThemedText>
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

// ─── Your Story ────────────────────────────────────────────────────────────────

function YourStory({
  synthesis, timeline, pal, overrideStory, trainingGoal, seenContrastKeys, onNewContrastKey,
  persistedStory, onStoryPersisted,
}: {
  synthesis: SynthesisResult;
  timeline: HealthDayRecord[];
  pal: ModalPalette;
  overrideStory?: string;
  trainingGoal?: { body: string | null; perf: string | null };
  seenContrastKeys?: Set<string>;
  onNewContrastKey?: (key: string) => void;
  persistedStory?: PersistedStory | null;
  onStoryPersisted?: (ps: PersistedStory) => void;
}) {
  const today = React.useMemo(() => {
    const todayDate = todayStr();
    return timeline.find(d => d.date === todayDate) ?? ({ date: todayDate } as HealthDayRecord);
  }, [timeline]);

  // Your Story is a persistent daily narrative, not a one-time notification.
  // seenContrastKeys must NOT suppress the display: a valid story must continue
  // to render across app restarts, same-day refreshes, and TestFlight updates.
  // We pass undefined so the suppression guard inside buildEnhancedStoryWithKey
  // never fires for the UI render path. The key is still tracked (via the
  // useEffect below) for deduplication in any future alert/notification path.
  const { story: builtStory, contrastKeyShown } = React.useMemo(
    () => overrideStory
      ? { story: overrideStory, contrastKeyShown: null }
      : buildEnhancedStoryWithKey(synthesis, timeline, today, trainingGoal, undefined),
    [synthesis, timeline, today, trainingGoal, overrideStory],
  );
  const story = builtStory;

  // Hidden diagnostic toggle — long-press "YOUR STORY" label to reveal/hide.
  // Works in production builds. Does not affect story state or suppress keys.
  const [diagVisible, setDiagVisible] = React.useState(false);

  // Persist any newly-shown contrast key so it won't re-surface identically.
  React.useEffect(() => {
    if (contrastKeyShown && onNewContrastKey) {
      onNewContrastKey(contrastKeyShown);
    }
  }, [contrastKeyShown, onNewContrastKey]);

  // Persist the story whenever a new one is generated, so it can be shown
  // on future opens when today's data doesn't reach story-worthiness gates.
  React.useEffect(() => {
    if (story && onStoryPersisted && story !== persistedStory?.storyText) {
      onStoryPersisted({
        storyText:   story,
        generatedAt: todayStr(),
        isContrast:  contrastKeyShown !== null,
        contrastKey: contrastKeyShown,
      });
    }
  }, [story, contrastKeyShown, onStoryPersisted, persistedStory?.storyText]);

  // Track when a real story (not fallback) is displayed.
  const storyTrackedRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (story && story !== storyTrackedRef.current) {
      storyTrackedRef.current = story;
      trackEvent('your_story_viewed', { source_screen: 'context' });
    }
  }, [story]);

  // Track when a cached (persisted) story is shown in place of today's story.
  const cachedTrackedRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!story && persistedStory && persistedStory.storyText !== cachedTrackedRef.current) {
      cachedTrackedRef.current = persistedStory.storyText;
      trackEvent('your_story_from_cache', { source_screen: 'context' });
    }
  }, [story, persistedStory]);

  if (!story) {
    // Show the last meaningful story if one exists — today's data may not have
    // reached story-worthiness gates yet (e.g. Oura hasn't synced), but real
    // insight from a prior day is better than a generic fallback message.
    if (persistedStory) {
      return (
        <View style={styles.section}>
          <Pressable onLongPress={() => setDiagVisible(v => !v)} delayLongPress={800}>
            <ThemedText style={[styles.sectionLabel, { color: pal.textSecondary }]}>YOUR STORY</ThemedText>
          </Pressable>
          <ThemedText style={[styles.storyText, { color: pal.textSecondary }]}>
            {persistedStory.storyText}
          </ThemedText>
          {diagVisible && (
            <DevDiagPanel
              synthesis={synthesis}
              timeline={timeline}
              today={today}
              trainingGoal={trainingGoal}
              seenContrastKeys={seenContrastKeys}
              story={null}
            />
          )}
        </View>
      );
    }

    const noHistory    = synthesis.primaryTheme.theme === 'insufficient_data';
    const hasPatterns  = synthesis.allPatterns.length > 0;
    const hasCtxEvents = synthesis.relevantContext.length > 0;

    let fallbackText: string;
    if (noHistory && hasPatterns) {
      // Oura hasn't synced today yet but patterns exist in What's Connected — don't say "still building"
      fallbackText = 'BellaHealth has found early connections \u2014 they\u2019re showing in What\u2019s Connected below. Your Story surfaces once today\u2019s signals are available to compare against your patterns.';
    } else if (!noHistory && hasCtxEvents) {
      // Today's signals exist and context events are logged, but the story-worthiness gate didn't pass
      fallbackText = 'BellaHealth is tracking your life events. Your Story surfaces when patterns connect to specific circumstances in your data \u2014 not just shifts visible in Trends or Life\u00a0+\u00a0Health.';
    } else if (noHistory) {
      fallbackText = 'BellaHealth is still building your baseline. Patterns surface once there\u2019s enough history to compare.';
    } else {
      fallbackText = 'Nothing unusual is standing out right now. BellaHealth surfaces patterns when they\u2019re specific to you \u2014 not just shifts that are already visible in Trends.';
    }

    return (
      <View style={styles.section}>
        <Pressable onLongPress={() => setDiagVisible(v => !v)} delayLongPress={800}>
          <ThemedText style={[styles.sectionLabel, { color: pal.textSecondary }]}>YOUR STORY</ThemedText>
        </Pressable>
        <ThemedText style={[styles.storyText, { color: pal.textSecondary }]}>
          {fallbackText}
        </ThemedText>
        {diagVisible && (
          <DevDiagPanel
            synthesis={synthesis}
            timeline={timeline}
            today={today}
            trainingGoal={trainingGoal}
            seenContrastKeys={seenContrastKeys}
            story={story}
          />
        )}
      </View>
    );
  }

  return (
    <View style={styles.section}>
      <Pressable onLongPress={() => setDiagVisible(v => !v)} delayLongPress={800}>
        <ThemedText style={[styles.sectionLabel, { color: pal.textSecondary }]}>YOUR STORY</ThemedText>
      </Pressable>
      <ThemedText style={[styles.storyText, { color: pal.text }]}>{story}</ThemedText>

      {(synthesis.supportingSignals.length > 0 || synthesis.concerningSignals.length > 0) && (
        <View style={styles.signalRow}>
          {[...synthesis.supportingSignals, ...synthesis.concerningSignals].slice(0, 4).map((s) => (
            <View
              key={s.signal}
              style={[
                styles.signalChip,
                { backgroundColor: s.interpretation === 'favorable' ? pal.plus + '22' : s.interpretation === 'concerning' ? pal.minus + '22' : pal.card },
                { borderColor: s.interpretation === 'favorable' ? pal.plus + '44' : s.interpretation === 'concerning' ? pal.minus + '44' : pal.divider },
              ]}
            >
              <ThemedText style={[styles.signalChipLabel, { color: pal.textSecondary }]}>
                {s.signal}
              </ThemedText>
              <ThemedText style={[styles.signalChipValue, {
                color: s.interpretation === 'favorable' ? pal.plus : s.interpretation === 'concerning' ? pal.minus : pal.text,
              }]}>
                {typeof s.value === 'number' ? Math.round(s.value) : s.value}
              </ThemedText>
            </View>
          ))}
        </View>
      )}
      {diagVisible && (
        <DevDiagPanel
          synthesis={synthesis}
          timeline={timeline}
          today={today}
          trainingGoal={trainingGoal}
          seenContrastKeys={seenContrastKeys}
          story={story}
        />
      )}
    </View>
  );
}

// ─── Connection card ───────────────────────────────────────────────────────────

function ConnectionCard({
  pattern, pal, onPress,
}: {
  pattern: PatternResult;
  pal: ModalPalette;
  onPress: () => void;
}) {
  const sources = [...new Set(pattern.sources)]
    .map((s) => SOURCE_LABELS[s as SourceName] ?? s)
    .join(' · ');

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.75}
      style={[styles.connectionCard, { backgroundColor: pal.card, borderColor: pal.divider }]}
    >
      <View style={styles.connectionCardTop}>
        <ThemedText style={[styles.connectionHeadline, { color: pal.textSecondary }]}>
          {patternHeadline(pattern)}
        </ThemedText>
        <ThemedText style={[styles.connectionChevron, { color: pal.textSecondary }]}>›</ThemedText>
      </View>
      <ThemedText style={[styles.connectionSentence, { color: pal.text }]}>
        {patternSentence(pattern)}
      </ThemedText>
      <View style={styles.connectionFooter}>
        <View style={[styles.evidenceChip, { backgroundColor: pal.accent + '18', borderColor: pal.accent + '35' }]}>
          <ThemedText style={[styles.evidenceChipText, { color: pal.accent }]}>
            {patternEvidenceChip(pattern)}
          </ThemedText>
        </View>
        {sources ? (
          <ThemedText style={[styles.connectionSource, { color: pal.textSecondary }]} numberOfLines={1}>
            {sources}
          </ThemedText>
        ) : null}
      </View>
    </TouchableOpacity>
  );
}

// ─── Connection detail sheet ──────────────────────────────────────────────────

function ConnectionDetailSheet({
  pattern, visible, onClose, pal,
}: {
  pattern: PatternResult | null;
  visible: boolean;
  onClose: () => void;
  pal: ModalPalette;
}) {
  const insets = useSafeAreaInsets();
  if (!pattern) return null;

  const sources = [...new Set(pattern.sources)]
    .map((s) => SOURCE_LABELS[s as SourceName] ?? s)
    .join(' · ');

  const hasNums = pattern.outcomeDuringCondition !== null && pattern.outcomeBaseline !== null;
  const outcomeLabel = SIGNAL_LABEL[pattern.outcomeSignal];

  const dateRangeStr = pattern.dateRange
    ? `${pattern.dateRange.start} – ${pattern.dateRange.end}`
    : null;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="formSheet" onRequestClose={onClose}>
      <ScrollView
        style={{ flex: 1, backgroundColor: pal.background }}
        contentContainerStyle={[styles.detailContent, { paddingBottom: insets.bottom + Spacing.five }]}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.detailHeader}>
          <ThemedText style={[styles.detailHeadline, { color: pal.textSecondary }]}>
            {patternHeadline(pattern)}
          </ThemedText>
          <TouchableOpacity onPress={onClose} activeOpacity={0.7}>
            <ThemedText style={[styles.detailClose, { color: pal.accent }]}>Done</ThemedText>
          </TouchableOpacity>
        </View>

        {/* Description */}
        <ThemedText style={[styles.detailSentence, { color: pal.text }]}>
          {patternDetailSentence(pattern)}
        </ThemedText>

        <View style={[styles.detailDivider, { backgroundColor: pal.divider }]} />

        {/* Evidence */}
        <ThemedText style={[styles.detailMetaLabel, { color: pal.textSecondary }]}>EVIDENCE</ThemedText>
        <ThemedText style={[styles.detailMetaValue, { color: pal.text }]}>
          {TIER_LABEL[pattern.confidenceTier]}
        </ThemedText>
        <ThemedText style={[styles.detailMetaSub, { color: pal.textSecondary }]}>
          {TIER_DESCRIPTION[pattern.confidenceTier]}
        </ThemedText>
        <ThemedText style={[styles.detailMetaSub, { color: pal.textSecondary }]}>
          Based on {pattern.observationCount} {pattern.observationCount === 1 ? 'day' : 'days'} of data.
          {dateRangeStr ? ` Data from ${dateRangeStr}.` : ''}
        </ThemedText>

        {/* Comparison */}
        {hasNums && (
          <>
            <View style={[styles.detailDivider, { backgroundColor: pal.divider }]} />
            <ThemedText style={[styles.detailMetaLabel, { color: pal.textSecondary }]}>COMPARISON</ThemedText>
            <View style={styles.comparisonRow}>
              <View style={styles.comparisonCol}>
                <ThemedText style={[styles.comparisonColLabel, { color: pal.textSecondary }]}>
                  {pattern.inputCondition.charAt(0).toUpperCase() + pattern.inputCondition.slice(1)}
                </ThemedText>
                <ThemedText style={[styles.comparisonValue, { color: pal.accent }]}>
                  {outcomeLabel} avg {typeof pattern.outcomeDuringCondition === 'number' ? Math.round(pattern.outcomeDuringCondition) : '—'}
                </ThemedText>
              </View>
              <View style={[styles.comparisonSep, { backgroundColor: pal.divider }]} />
              <View style={styles.comparisonCol}>
                <ThemedText style={[styles.comparisonColLabel, { color: pal.textSecondary }]}>
                  All other days
                </ThemedText>
                <ThemedText style={[styles.comparisonValue, { color: pal.textSecondary }]}>
                  {outcomeLabel} avg {typeof pattern.outcomeBaseline === 'number' ? Math.round(pattern.outcomeBaseline) : '—'}
                </ThemedText>
              </View>
            </View>
            {pattern.absoluteDifference !== null && Math.abs(pattern.absoluteDifference) >= 1 && (
              <ThemedText style={[styles.detailMetaSub, { color: pal.textSecondary }]}>
                Difference of {Math.abs(Math.round(pattern.absoluteDifference))} points on average.
              </ThemedText>
            )}
          </>
        )}

        {/* Provenance */}
        <View style={[styles.detailDivider, { backgroundColor: pal.divider }]} />
        <ThemedText style={[styles.detailMetaLabel, { color: pal.textSecondary }]}>BASED ON</ThemedText>
        <ThemedText style={[styles.detailMetaValue, { color: pal.text }]}>{sources || '—'}</ThemedText>

        {/* Caution note */}
        <ThemedText style={[styles.detailCaution, { color: pal.textSecondary }]}>
          Connections are based on your own history and describe associations, not causes.
        </ThemedText>
      </ScrollView>
    </Modal>
  );
}

// ─── What's Connected section ──────────────────────────────────────────────────

function WhatsConnected({
  patterns, hadEvidence, pal, onTap,
}: {
  patterns:    PatternResult[];
  hadEvidence: boolean;
  pal:         ModalPalette;
  onTap?:      (p: PatternResult) => void;
}) {
  if (patterns.length === 0) {
    return (
      <View style={styles.section}>
        <ThemedText style={[styles.sectionLabel, { color: pal.textSecondary }]}>WHAT&apos;S CONNECTED</ThemedText>
        <View style={[styles.emptyCard, { backgroundColor: pal.card, borderColor: pal.divider }]}>
          {hadEvidence ? (
            <>
              <ThemedText style={[styles.emptyCardTitle, { color: pal.text }]}>
                Nothing new stands out yet.
              </ThemedText>
              <ThemedText style={[styles.emptyCardSub, { color: pal.textSecondary }]}>
                BellaHealth will keep looking for meaningful connections as your history and context grow.
              </ThemedText>
            </>
          ) : (
            <>
              <ThemedText style={[styles.emptyCardTitle, { color: pal.text }]}>
                BellaHealth is learning your patterns.
              </ThemedText>
              <ThemedText style={[styles.emptyCardSub, { color: pal.textSecondary }]}>
                Connections appear as enough of your own history builds up.
              </ThemedText>
            </>
          )}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.section}>
      <ThemedText style={[styles.sectionLabel, { color: pal.textSecondary }]}>WHAT&apos;S CONNECTED</ThemedText>
      <View style={{ gap: Spacing.three }}>
        {patterns.map((p) => {
          const sources = [...new Set(p.sources)].map((s) => SOURCE_LABELS[s as SourceName] ?? s).join(' · ');
          return (
            <TouchableOpacity
              key={p.patternId}
              style={[styles.connectionCard, { backgroundColor: pal.card, borderColor: pal.divider }]}
              onPress={() => onTap?.(p)}
              activeOpacity={0.85}
            >
              <View style={styles.connectionCardTop}>
                <ThemedText style={[styles.connectionHeadline, { color: pal.textSecondary }]}>
                  {patternHeadline(p)}
                </ThemedText>
              </View>
              <ThemedText style={[styles.connectionSentence, { color: pal.text }]}>
                {patternSentence(p)}
              </ThemedText>
              <View style={styles.connectionFooter}>
                <View style={[styles.evidenceChip, { backgroundColor: pal.accent + '18', borderColor: pal.accent + '35' }]}>
                  <ThemedText style={[styles.evidenceChipText, { color: pal.accent }]}>
                    {patternEvidenceChip(p)}
                  </ThemedText>
                </View>
                {sources ? (
                  <ThemedText style={[styles.connectionSource, { color: pal.textSecondary }]} numberOfLines={1}>
                    {sources}
                  </ThemedText>
                ) : null}
              </View>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

// ─── Life + Health timeline ────────────────────────────────────────────────────

function PeriodRow({
  label, before, during, after, hideAfter, pal,
}: {
  label: string;
  before: string | null;
  during: string | null;
  after:  string | null;
  /** When true (ongoing events), the After column is not rendered at all. */
  hideAfter?: boolean;
  pal: ModalPalette;
}) {
  const colLabels = hideAfter ? (['Before', 'During'] as const) : (['Before', 'During', 'After'] as const);
  const colValues = hideAfter ? [before, during] : [before, during, after];
  // Only show row if at least two periods have data
  if (colValues.filter((v) => v !== null).length < 2) return null;

  return (
    <View style={styles.periodRow}>
      <ThemedText style={[styles.periodRowLabel, { color: pal.textSecondary }]}>{label}</ThemedText>
      <View style={styles.periodCols}>
        {colLabels.map((col, i) => {
          const val = colValues[i];
          return (
            <View key={col} style={styles.periodCol}>
              <ThemedText style={[styles.periodColHead, { color: pal.textSecondary }]}>{col}</ThemedText>
              <ThemedText style={[styles.periodColVal, { color: val === null ? pal.textSecondary : pal.text }]}>
                {val ?? '—'}
              </ThemedText>
            </View>
          );
        })}
      </View>
    </View>
  );
}

function TimelineEvent({
  event, eventWindows, pal, onDelete, onEnd, readonly,
}: {
  event: ContextEvent;
  eventWindows: EventWindowAnalysis[];
  pal: ModalPalette;
  onDelete?: () => void;
  onEnd?: () => void;
  readonly?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const window = eventWindows.find((w) => w.event.id === event.id) ?? null;
  // Show expand affordance only when both pre and during have data for at least 2 signals
  const hasWindow = !!window && window.availableSignals.length > 1;
  const label = eventLabel(event.type, event.label);
  const isDeletable = !readonly && event.source === 'user_logged';
  const isOngoing = isDeletable && !event.endDate;

  const expandLabel = window?.isOngoing
    ? (expanded ? 'Hide comparison ↑' : 'View before / during →')
    : (expanded ? 'Hide comparison ↑' : 'View before / during / after ↓');

  function handleDeletePress() {
    Alert.alert(
      'Delete this event?',
      'This will remove it from your timeline and future health insights.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            deleteContextEvent(event.id).then(() => onDelete?.()).catch(() => {});
          },
        },
      ],
    );
  }

  function handleEndPress() {
    Alert.alert(
      'Mark as ended today?',
      `This will close the ongoing "${label}" event with today as the end date.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'End today',
          onPress: () => {
            const d = new Date();
            const todayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            updateContextEvent(event.id, { endDate: todayStr }).then(() => onEnd?.()).catch(() => {});
          },
        },
      ],
    );
  }

  return (
    <View style={styles.timelineEvent}>
      <View style={styles.timelineDotCol}>
        <View style={[styles.timelineDot, { backgroundColor: pal.accent }]} />
        <View style={[styles.timelineLine, { backgroundColor: pal.divider }]} />
      </View>
      <View style={styles.timelineContent}>
        <View style={styles.timelineRow}>
          <TouchableOpacity
            style={styles.timelineMain}
            onPress={() => hasWindow && setExpanded((e) => !e)}
            activeOpacity={hasWindow ? 0.7 : 1}
          >
            <ThemedText style={[styles.timelineEventLabel, { color: pal.text }]}>{label}</ThemedText>
            <ThemedText style={[styles.timelineEventDate, { color: pal.textSecondary }]}>
              {formatDateRange(event.startDate, event.endDate)}
            </ThemedText>
            {hasWindow && (
              <ThemedText style={[styles.timelineExpand, { color: pal.accent }]}>
                {expandLabel}
              </ThemedText>
            )}
          </TouchableOpacity>
          {isOngoing && (
            <TouchableOpacity onPress={handleEndPress} activeOpacity={0.7} hitSlop={8} style={styles.deleteBtn}>
              <Ionicons name="checkmark-circle-outline" size={17} color={pal.accent} />
            </TouchableOpacity>
          )}
          {isDeletable && (
            <TouchableOpacity onPress={handleDeletePress} activeOpacity={0.7} hitSlop={8} style={styles.deleteBtn}>
              <Ionicons name="trash-outline" size={17} color={pal.textSecondary} />
            </TouchableOpacity>
          )}
        </View>

        {expanded && hasWindow && window && (
          <View style={[styles.windowTable, { borderColor: pal.divider }]}>
            {(window.availableSignals as Array<keyof typeof PERIOD_STAT_LABEL>)
              .filter((k) => PERIOD_STAT_LABEL[k])
              .map((sig) => {
                const b = window.preWindow[sig as keyof typeof window.preWindow];
                const d = window.duringWindow[sig as keyof typeof window.duringWindow];
                const a = window.postWindow[sig as keyof typeof window.postWindow];
                const bFmt = typeof b === 'number' ? formatStatValue(sig, b) : null;
                const dFmt = typeof d === 'number' ? formatStatValue(sig, d) : null;
                // Do not pass after data for ongoing events — the after period does not exist yet
                const aFmt = (!window.isOngoing && typeof a === 'number') ? formatStatValue(sig, a) : null;
                return (
                  <PeriodRow
                    key={sig}
                    label={PERIOD_STAT_LABEL[sig] ?? sig}
                    before={bFmt}
                    during={dFmt}
                    after={aFmt}
                    hideAfter={window.isOngoing}
                    pal={pal}
                  />
                );
              })}
            <ThemedText style={[styles.windowNote, { color: pal.textSecondary }]}>
              {window.isOngoing
                ? 'This event is ongoing — after-period data will appear once it ends.'
                : 'Descriptive — based on this single event.'}
            </ThemedText>
          </View>
        )}
      </View>
    </View>
  );
}

function LifeAndHealth({
  events, eventWindows, pal, onAddContext, onDeleteEvent, onEndEvent, readonly,
}: {
  events: ContextEvent[];
  eventWindows: EventWindowAnalysis[];
  pal: ModalPalette;
  onAddContext: () => void;
  onDeleteEvent: (id: string) => void;
  onEndEvent: (id: string, endDate: string) => void;
  readonly?: boolean;
}) {
  const sorted = [...events].sort((a, b) => b.startDate.localeCompare(a.startDate)).slice(0, 10);

  return (
    <View style={styles.section}>
      <View style={styles.sectionLabelRow}>
        <ThemedText style={[styles.sectionLabel, { color: pal.textSecondary }]}>LIFE + HEALTH</ThemedText>
        {!readonly && (
          <TouchableOpacity onPress={onAddContext} activeOpacity={0.7}>
            <ThemedText style={[styles.addContextLink, { color: pal.accent }]}>+ Add context</ThemedText>
          </TouchableOpacity>
        )}
      </View>

      {sorted.length === 0 ? (
        <View style={[styles.emptyCard, { backgroundColor: pal.card, borderColor: pal.divider }]}>
          <ThemedText style={[styles.emptyCardTitle, { color: pal.text }]}>
            Add moments that might explain changes in your health.
          </ThemedText>
          <ThemedText style={[styles.emptyCardSub, { color: pal.textSecondary }]}>
            Travel, illness, stress, training blocks — add life context so changes have meaning.
          </ThemedText>
        </View>
      ) : (
        <View style={styles.timeline}>
          {sorted.map((evt) => (
            <TimelineEvent
              key={evt.id}
              event={evt}
              eventWindows={eventWindows}
              pal={pal}
              onDelete={() => onDeleteEvent(evt.id)}
              onEnd={() => {
                const d = new Date();
                const todayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                onEndEvent(evt.id, todayStr);
              }}
              readonly={readonly}
            />
          ))}
        </View>
      )}
    </View>
  );
}

// ─── Date picker wheel ─────────────────────────────────────────────────────────

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const ITEM_H = 44;
const VISIBLE = 5;
const PAD = Math.floor(VISIBLE / 2);

function parseYMD(s: string): [number, number, number] {
  const [y, m, d] = s.split('-').map(Number);
  return [y || new Date().getFullYear(), m || 1, d || 1];
}

function fmtYMD(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

function humanDate(s: string): string {
  if (!s) return '';
  const [y, m, d] = parseYMD(s);
  return `${MONTHS[m-1]} ${d}, ${y}`;
}

function WheelCol({ items, selected, onSelect, pal }: {
  items: string[]; selected: number; onSelect: (i: number) => void; pal: ModalPalette;
}) {
  const ref = useRef<FlatList>(null);
  const ignoreScroll = useRef(false);

  useEffect(() => {
    if (selected >= 0 && selected < items.length) {
      ignoreScroll.current = true;
      ref.current?.scrollToOffset({ offset: selected * ITEM_H, animated: false });
      setTimeout(() => { ignoreScroll.current = false; }, 100);
    }
  }, [selected, items.length]);

  return (
    <FlatList
      ref={ref}
      data={['', '', ...items, '', '']}
      keyExtractor={(_, i) => String(i)}
      showsVerticalScrollIndicator={false}
      snapToInterval={ITEM_H}
      decelerationRate="fast"
      style={{ height: ITEM_H * VISIBLE, flex: 1 }}
      getItemLayout={(_, i) => ({ length: ITEM_H, offset: i * ITEM_H, index: i })}
      onMomentumScrollEnd={(e) => {
        if (ignoreScroll.current) return;
        const idx = Math.round(e.nativeEvent.contentOffset.y / ITEM_H);
        if (idx >= 0 && idx < items.length) onSelect(idx);
      }}
      renderItem={({ item, index }) => {
        const realIdx = index - PAD;
        const isSelected = realIdx === selected;
        return (
          <View style={{ height: ITEM_H, alignItems: 'center', justifyContent: 'center' }}>
            <ThemedText style={{
              fontSize: isSelected ? 17 : 15,
              fontWeight: isSelected ? '500' : '400',
              color: isSelected ? pal.text : pal.textSecondary + 'AA',
            }}>
              {item}
            </ThemedText>
          </View>
        );
      }}
    />
  );
}

function DatePickerSheet({ value, onConfirm, onCancel, pal }: {
  value: string;
  onConfirm: (date: string) => void;
  onCancel: () => void;
  pal: ModalPalette;
}) {
  const [y, m, d] = parseYMD(value || fmtYMD(new Date().getFullYear(), new Date().getMonth()+1, new Date().getDate()));
  const [selYear,  setSelYear]  = useState(y);
  const [selMonth, setSelMonth] = useState(m - 1);   // 0-indexed
  const [selDay,   setSelDay]   = useState(d - 1);   // 0-indexed

  const todayY = new Date().getFullYear();
  const years  = Array.from({ length: 11 }, (_, i) => String(todayY - 10 + i));
  const days   = Array.from({ length: 31 }, (_, i) => String(i + 1));

  function confirm() {
    const day = Math.min(selDay + 1, 31);
    onConfirm(fmtYMD(selYear, selMonth + 1, day));
  }

  return (
    <Modal animationType="slide" transparent presentationStyle="overFullScreen">
      <View style={styles.pickerOverlay}>
        {/* Backdrop Pressable as sibling — renders BEHIND the sheet, dismisses on tap */}
        <Pressable style={StyleSheet.absoluteFill} onPress={onCancel} />
        {/* Sheet renders on top (later in JSX = higher z-index) — no gesture conflict */}
        <View style={[styles.pickerSheet, { backgroundColor: pal.background }]}>
          <View style={[styles.pickerHeader, { borderBottomColor: pal.divider }]}>
            <TouchableOpacity onPress={onCancel} activeOpacity={0.7}>
              <ThemedText style={{ fontSize: 16, color: pal.textSecondary }}>Cancel</ThemedText>
            </TouchableOpacity>
            <TouchableOpacity onPress={confirm} activeOpacity={0.7}>
              <ThemedText style={{ fontSize: 16, color: pal.accent, fontWeight: '600' }}>Done</ThemedText>
            </TouchableOpacity>
          </View>

          {/* Selection highlight */}
          <View style={[styles.pickerHighlight, { borderColor: pal.divider }]} pointerEvents="none" />

          <View style={styles.pickerColumns}>
            <WheelCol items={MONTHS} selected={selMonth} onSelect={setSelMonth} pal={pal} />
            <WheelCol items={days}   selected={selDay}   onSelect={setSelDay}   pal={pal} />
            <WheelCol items={years}  selected={years.indexOf(String(selYear))} onSelect={(i) => setSelYear(Number(years[i]))} pal={pal} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ─── Add Context sheet ─────────────────────────────────────────────────────────

const EVENT_TYPES: Array<{ type: ContextEventType; label: string }> = [
  { type: 'travel',           label: 'Travel'          },
  { type: 'illness',          label: 'Illness'         },
  { type: 'stressful_period', label: 'Stressful period'},
  { type: 'training_block',   label: 'Training block'  },
  { type: 'user_defined',     label: 'Other'           },
];

function AddContextSheet({
  visible, onClose, onSaved, pal,
}: {
  visible: boolean;
  onClose: () => void;
  onSaved: () => void;
  pal: ModalPalette;
}) {
  const insets = useSafeAreaInsets();
  const [selectedType, setSelectedType] = useState<ContextEventType | null>(null);
  const [label, setLabel]               = useState('');
  const [startDate, setStartDate]       = useState(todayStr());
  const [endDate, setEndDate]           = useState(todayStr());
  const [ongoing, setOngoing]           = useState(true);
  const [saving, setSaving]             = useState(false);
  const [pickingStart, setPickingStart] = useState(false);
  const [pickingEnd, setPickingEnd]     = useState(false);

  function reset() {
    setSelectedType(null); setLabel(''); setStartDate(todayStr());
    setEndDate(todayStr()); setOngoing(true); setSaving(false);
    setPickingStart(false); setPickingEnd(false);
  }

  async function handleSave() {
    if (!selectedType) {
      Alert.alert('Select an event type to continue.');
      return;
    }
    // Basic date validation
    if (startDate > todayStr()) {
      Alert.alert('Start date cannot be in the future.');
      return;
    }
    if (!ongoing && endDate && endDate < startDate) {
      Alert.alert('End date must be on or after start date.');
      return;
    }
    setSaving(true);
    try {
      await createContextEvent({
        type:      selectedType,
        source:    'user_logged',
        startDate,
        endDate:   ongoing ? undefined : (endDate || undefined),
        label:     selectedType === 'user_defined' ? (label.trim() || undefined) : undefined,
      });
      trackEvent('context_added', { source_screen: 'context' });
      reset();
      onSaved();
    } catch {
      setSaving(false);
      Alert.alert('Something went wrong. Please try again.');
    }
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="formSheet" onRequestClose={onClose}>
      <ScrollView
        style={{ flex: 1, backgroundColor: pal.background }}
        contentContainerStyle={[styles.addSheetContent, { paddingBottom: insets.bottom + Spacing.four }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.addSheetHeader}>
          <ThemedText style={[styles.addSheetTitle, { color: pal.text }]}>Add context</ThemedText>
          <TouchableOpacity onPress={() => { reset(); onClose(); }} activeOpacity={0.7}>
            <ThemedText style={[styles.detailClose, { color: pal.accent }]}>Cancel</ThemedText>
          </TouchableOpacity>
        </View>

        <ThemedText style={[styles.addFieldLabel, { color: pal.textSecondary }]}>WHAT HAPPENED</ThemedText>
        <View style={styles.typeGrid}>
          {EVENT_TYPES.map((et) => (
            <TouchableOpacity
              key={et.type}
              onPress={() => setSelectedType(et.type)}
              activeOpacity={0.7}
              style={[
                styles.typeChip,
                { borderColor: selectedType === et.type ? pal.accent : pal.divider },
                { backgroundColor: selectedType === et.type ? pal.accent + '18' : pal.card },
              ]}
            >
              <ThemedText style={[
                styles.typeChipText,
                { color: selectedType === et.type ? pal.accent : pal.text },
              ]}>
                {et.label}
              </ThemedText>
            </TouchableOpacity>
          ))}
        </View>

        {selectedType === 'user_defined' && (
          <>
            <ThemedText style={[styles.addFieldLabel, { color: pal.textSecondary }]}>LABEL (optional)</ThemedText>
            <TextInput
              style={[styles.textField, { backgroundColor: pal.card, color: pal.text, borderColor: pal.divider }]}
              value={label}
              onChangeText={setLabel}
              placeholder="e.g. Job interview week"
              placeholderTextColor={pal.textSecondary}
              maxLength={40}
            />
          </>
        )}

        <ThemedText style={[styles.addFieldLabel, { color: pal.textSecondary }]}>START DATE</ThemedText>
        <TouchableOpacity
          onPress={() => setPickingStart(true)}
          activeOpacity={0.7}
          style={[styles.dateField, { backgroundColor: pal.card, borderColor: pal.divider }]}
        >
          <ThemedText style={{ fontSize: 15, color: pal.text }}>{humanDate(startDate)}</ThemedText>
          <ThemedText style={{ fontSize: 13, color: pal.textSecondary }}>›</ThemedText>
        </TouchableOpacity>

        <View style={styles.ongoingRow}>
          <ThemedText style={[styles.addFieldLabel, { color: pal.textSecondary, marginBottom: 0 }]}>
            STILL ONGOING
          </ThemedText>
          <TouchableOpacity
            onPress={() => setOngoing((v) => !v)}
            activeOpacity={0.7}
            style={[
              styles.togglePill,
              { backgroundColor: ongoing ? pal.accent : pal.card, borderColor: pal.divider },
            ]}
          >
            <ThemedText style={[styles.toggleText, { color: ongoing ? '#fff' : pal.textSecondary }]}>
              {ongoing ? 'Yes' : 'No'}
            </ThemedText>
          </TouchableOpacity>
        </View>

        {!ongoing && (
          <>
            <ThemedText style={[styles.addFieldLabel, { color: pal.textSecondary }]}>END DATE</ThemedText>
            <TouchableOpacity
              onPress={() => setPickingEnd(true)}
              activeOpacity={0.7}
              style={[styles.dateField, { backgroundColor: pal.card, borderColor: pal.divider }]}
            >
              <ThemedText style={{ fontSize: 15, color: pal.text }}>{humanDate(endDate)}</ThemedText>
              <ThemedText style={{ fontSize: 13, color: pal.textSecondary }}>›</ThemedText>
            </TouchableOpacity>
          </>
        )}

        {pickingStart && (
          <DatePickerSheet
            value={startDate}
            onConfirm={(d) => { setStartDate(d); setPickingStart(false); }}
            onCancel={() => setPickingStart(false)}
            pal={pal}
          />
        )}
        {pickingEnd && (
          <DatePickerSheet
            value={endDate}
            onConfirm={(d) => { setEndDate(d); setPickingEnd(false); }}
            onCancel={() => setPickingEnd(false)}
            pal={pal}
          />
        )}

        <TouchableOpacity
          onPress={handleSave}
          disabled={saving || !selectedType}
          activeOpacity={0.8}
          style={[
            styles.saveBtn,
            { backgroundColor: selectedType ? pal.accent : pal.divider },
          ]}
        >
          {saving
            ? <ActivityIndicator color="#fff" />
            : <ThemedText style={styles.saveBtnText}>Save</ThemedText>
          }
        </TouchableOpacity>
      </ScrollView>
    </Modal>
  );
}

// ─── Your Picture ──────────────────────────────────────────────────────────────

const COVERAGE_LABEL: Record<string, string> = {
  available:   'Available',
  limited:     'Limited',
  unavailable: 'Not enough data',
};

function sleepHint(level: CoverageLevel, detail: string): string {
  if (level === 'limited') {
    if (detail.includes('duration only')) {
      return "We have sleep duration history, but sleep-quality coverage is limited.";
    }
    if (detail.includes('score only')) {
      return "Sleep quality scores are available, but duration data is missing from recent logs.";
    }
    return "We have some sleep history, but recent coverage has gaps. More consistent syncing will improve pattern accuracy.";
  }
  return "No sleep data found yet. Make sure your wearable is syncing.";
}

function recoveryHint(level: CoverageLevel, detail: string): string {
  if (level === 'limited') {
    if (detail.includes('HRV only')) {
      return "HRV data is available, but readiness coverage is incomplete. Full recovery insights use both.";
    }
    return "Partial recovery data is available. Recovery insights use both readiness and HRV when available.";
  }
  return "No recovery data found yet. Recovery insights are based on readiness and HRV scores from a connected wearable.";
}

function lifeContextHint(level: CoverageLevel): string {
  if (level === 'limited') {
    return "Behavior logs are tracked here (drinks, caffeine, wellness sessions). Add life events — travel, illness, training blocks — using the + button in Life + Health for deeper context.";
  }
  return "Add life events using the + button in Life + Health. When you log caffeine, sauna, cold plunge, gratitude sessions, or electrolytes, those are tracked here and available as context.";
}

function buildDomainHint(
  d: DomainCoverage,
  hkMovementInTimeline: boolean,
  nutritionDaysLogged: number,
  waterDaysLogged: number,
): string {
  switch (d.domain) {
    case 'SLEEP':        return sleepHint(d.level, d.detail);
    case 'RECOVERY':     return recoveryHint(d.level, d.detail);
    case 'MOVEMENT':     return movementHint(d.level, hkMovementInTimeline);
    case 'NUTRITION':    return nutritionHint(nutritionDaysLogged, waterDaysLogged, d.level);
    case 'LIFE_CONTEXT': return lifeContextHint(d.level);
    default:             return '';
  }
}

/**
 * Nutrition expanded-hint text. Uses the longitudinal coverage level to
 * distinguish states rather than a hardcoded day-count threshold — the
 * underlying engine (majority-vote over 30 days) governs when coverage
 * moves from unavailable → limited → available.
 *
 * States:
 *   daysWithMeals > 0 + unavailable → "Still learning" hint (data exists, patterns not yet reliable)
 *   daysWithMeals > 0 + limited/available → accuracy-maintenance hint
 *   daysWithMeals = 0 + water > 0 → hydration-only hint (with or without reliable patterns)
 *   daysWithMeals = 0 + water = 0 → zero-state: start logging
 */
function nutritionHint(daysWithMeals: number, daysWithWater: number, level: CoverageLevel): string {
  if (daysWithMeals > 0) {
    return level === 'unavailable'
      ? 'Meal data is available. Keep logging to help BellaHealth identify reliable patterns over time.'
      : 'Meal data is available. Keep logging to maintain pattern accuracy.';
  }
  if (daysWithWater > 0) {
    return level === 'unavailable'
      ? 'Hydration data is available. Keep logging meals and water to help BellaHealth build reliable patterns over time.'
      : 'Hydration data is available for analysis. Log meals too to unlock nutrition patterns.';
  }
  return 'Log meals in the Nutrition section to start building your nutrition picture.';
}

/**
 * Returns the appropriate hint for the Movement domain based on data state.
 *
 * Connection state and data sufficiency are separate concepts:
 *   - HK authorized, data present → describe what we have; do NOT say "grant access"
 *   - HK not returning data → suggest enabling access (neutral tone)
 */
function movementHint(level: CoverageLevel, hkMovementInTimeline: boolean): string {
  if (level === 'limited') {
    return hkMovementInTimeline
      ? 'Step data is available. Workout sessions appear when tracked in Apple Health or Apple Fitness.'
      : 'Enable Apple Health access in Settings → Privacy & Security → Health → BellaHealth to include movement data.';
  }
  // unavailable
  return hkMovementInTimeline
    ? 'Apple Health is connected, but no step or workout data was found in the last 30 days.'
    : 'Enable Apple Health access in Settings → Privacy & Security → Health → BellaHealth to include workout and step data.';
}

function YourPicture({
  coverage, hkMovementInTimeline, nutritionDaysLogged, waterDaysLogged, pal,
}: {
  coverage: CoverageReport;
  hkMovementInTimeline: boolean;
  nutritionDaysLogged: number;
  waterDaysLogged: number;
  pal: ModalPalette;
}) {
  const [expandedDomain, setExpandedDomain] = useState<string | null>(null);

  function domainLabel(domain: string) {
    return domain === 'LIFE_CONTEXT' ? 'Life Context'
      : domain.charAt(0) + domain.slice(1).toLowerCase();
  }

  return (
    <View style={styles.section}>
      <ThemedText style={[styles.sectionLabel, { color: pal.textSecondary }]}>YOUR PICTURE</ThemedText>
      <View style={[styles.pictureCard, { backgroundColor: pal.card, borderColor: pal.divider }]}>
        {coverage.domains.map((d, i) => {
          const isActionable = d.level !== 'available';
          const hint = buildDomainHint(d, hkMovementInTimeline, nutritionDaysLogged, waterDaysLogged);
          const isExpanded = expandedDomain === d.domain;
          const levelColor = d.level === 'available' ? pal.plus
            : d.level === 'limited' ? pal.accent
            : pal.textSecondary;
          // Nutrition-specific label: distinguish "no data at all" from "data exists but
          // not yet enough for reliable patterns." All other domains use the static map.
          const displayLabel =
            d.domain === 'NUTRITION' && d.level === 'unavailable' && nutritionDaysLogged > 0
              ? 'Still learning'
              : COVERAGE_LABEL[d.level];

          return (
            <View key={d.domain}>
              {i > 0 && <View style={[styles.pictureRow_divider, { backgroundColor: pal.divider }]} />}
              <TouchableOpacity
                disabled={!isActionable}
                activeOpacity={0.7}
                onPress={() => setExpandedDomain(isExpanded ? null : d.domain)}
                style={styles.pictureRow}
              >
                <ThemedText style={[styles.pictureDomain, { color: pal.text }]}>
                  {domainLabel(d.domain)}
                </ThemedText>
                <View style={styles.pictureLevelRow}>
                  <ThemedText style={[styles.pictureLevel, { color: levelColor }]}>
                    {displayLabel}
                  </ThemedText>
                  {isActionable && (
                    <ThemedText style={[styles.pictureChevron, { color: levelColor }]}>
                      {isExpanded ? '∧' : '∨'}
                    </ThemedText>
                  )}
                </View>
              </TouchableOpacity>
              {isExpanded && hint && (
                <View style={[styles.pictureHintInline, { borderTopColor: pal.divider }]}>
                  <ThemedText style={[styles.pictureHintInlineText, { color: pal.textSecondary }]}>
                    {hint}
                  </ThemedText>
                </View>
              )}
            </View>
          );
        })}
      </View>
    </View>
  );
}

// ─── Pattern observations ──────────────────────────────────────────────────────

function ObservationCard({
  observation, pal, onAnswer, onDismiss,
}: {
  observation: DowObservation;
  pal: ModalPalette;
  onAnswer: (id: string, response: string) => Promise<void>;
  onDismiss: (id: string) => Promise<void>;
}) {
  const [contextExpanded, setContextExpanded] = React.useState(false);
  const [contextText, setContextText] = React.useState('');
  const [saving, setSaving] = React.useState(false);

  // Track when this observation card surfaces.
  const trackedRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (observation.note.id !== trackedRef.current) {
      trackedRef.current = observation.note.id;
      trackEvent('pattern_prompt_viewed', { source_screen: 'context' });
    }
  }, [observation.note.id]);

  async function handleResponse(response: 'usually' | 'sometimes' | 'no') {
    if (saving) return;
    setSaving(true);
    const responseWithNote = contextText.trim()
      ? `${response}: ${contextText.trim()}`
      : response;
    await onAnswer(observation.note.id, responseWithNote);
    trackEvent('pattern_prompt_answered', { source_screen: 'context' });
    setSaving(false);
  }

  async function handleDismiss() {
    if (saving) return;
    setSaving(true);
    await onDismiss(observation.note.id);
    setSaving(false);
  }

  return (
    <View style={[styles.observationCard, { backgroundColor: pal.card, borderColor: pal.divider }]}>
      <ThemedText style={[styles.observationText, { color: pal.text }]}>
        {observation.note.observationText}
      </ThemedText>
      <ThemedText style={[styles.observationQuestion, { color: pal.textSecondary }]}>
        {observation.note.questionText}
      </ThemedText>

      {/* Compact response buttons */}
      <View style={styles.responseRow}>
        {(['usually', 'sometimes', 'no'] as const).map((opt) => (
          <TouchableOpacity
            key={opt}
            style={[styles.responseBtn, { borderColor: pal.divider }]}
            onPress={() => handleResponse(opt)}
            disabled={saving}
            activeOpacity={0.7}
          >
            <ThemedText style={[styles.responseBtnText, { color: pal.text }]}>
              {opt.charAt(0).toUpperCase() + opt.slice(1)}
            </ThemedText>
          </TouchableOpacity>
        ))}
      </View>

      {/* Optional context + Dismiss row */}
      <View style={styles.observationSecondaryRow}>
        <TouchableOpacity
          onPress={() => setContextExpanded((v) => !v)}
          activeOpacity={0.7}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          disabled={saving}
        >
          <ThemedText style={[styles.addContextLink, { color: pal.accent }]}>
            {contextExpanded ? '− Context' : '+ Add context'}
          </ThemedText>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={handleDismiss}
          disabled={saving}
          activeOpacity={0.7}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <ThemedText style={[styles.observationDismissText, { color: pal.textSecondary }]}>
            Dismiss
          </ThemedText>
        </TouchableOpacity>
      </View>

      {contextExpanded && (
        <TextInput
          style={[styles.observationInput, { backgroundColor: pal.background, color: pal.text, borderColor: pal.divider }]}
          value={contextText}
          onChangeText={setContextText}
          placeholder="Optional note…"
          placeholderTextColor={pal.textSecondary}
          multiline
          maxLength={300}
          editable={!saving}
        />
      )}
    </View>
  );
}

function PatternObservationsSection({
  layer, pal, onAnswer, onDismiss,
}: {
  layer: DowObservationLayer | null;
  pal: ModalPalette;
  onAnswer: (id: string, response: string) => Promise<void>;
  onDismiss: (id: string) => Promise<void>;
}) {
  const { width: windowWidth } = useWindowDimensions();
  // Card width = screen width minus the scrollContent's horizontal padding (Spacing.three × 2 = 32)
  const cardWidth = windowWidth - Spacing.three * 2;

  const [activeIndex, setActiveIndex] = useState(0);
  const scrollRef = useRef<ScrollView>(null);
  // Track prev count via ref so the effect can compare without adding activeIndex to deps
  const prevCountRef = useRef(layer?.observations.length ?? 0);
  const activeIndexRef = useRef(0);

  const obs = layer?.observations ?? [];
  const count = obs.length;

  // When an observation is answered/dismissed the array shrinks. Clamp the active
  // index so it stays in-bounds and scroll to the (now visible) neighbour card.
  useEffect(() => {
    const prev = prevCountRef.current;
    if (count < prev && count > 0) {
      const clamped = Math.min(activeIndexRef.current, count - 1);
      activeIndexRef.current = clamped;
      setActiveIndex(clamped);
      scrollRef.current?.scrollTo({ x: clamped * cardWidth, animated: true });
    }
    prevCountRef.current = count;
  }, [count, cardWidth]);

  if (!layer?.hasObservations) return null;

  return (
    <View style={styles.section}>
      {/* Heading row: label + subtle "1 of N" counter when multiple patterns */}
      <View style={styles.sectionLabelRow}>
        <ThemedText style={[styles.sectionLabel, { color: pal.textSecondary, marginBottom: 0 }]}>
          PATTERNS WE&apos;VE NOTICED
        </ThemedText>
        {count > 1 && (
          <ThemedText style={[styles.carouselCounter, { color: pal.textSecondary }]}>
            {activeIndex + 1} of {count}
          </ThemedText>
        )}
      </View>

      {/* Horizontal carousel — one card per page, no visible overflow */}
      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        scrollEnabled={count > 1}
        onMomentumScrollEnd={(e) => {
          const idx = Math.round(e.nativeEvent.contentOffset.x / cardWidth);
          const clamped = Math.max(0, Math.min(idx, count - 1));
          activeIndexRef.current = clamped;
          setActiveIndex(clamped);
        }}
      >
        {obs.map((o) => (
          <View key={o.note.id} style={{ width: cardWidth }}>
            <ObservationCard
              observation={o}
              pal={pal}
              onAnswer={onAnswer}
              onDismiss={onDismiss}
            />
          </View>
        ))}
      </ScrollView>

      {/* Pagination dots — only shown when there are multiple patterns */}
      {count > 1 && (
        <View style={styles.carouselDots}>
          {obs.map((o, i) => (
            <View
              key={o.note.id}
              style={[styles.carouselDot, {
                backgroundColor: pal.accent,
                opacity: i === activeIndex ? 1 : 0.25,
              }]}
            />
          ))}
        </View>
      )}
    </View>
  );
}

// ─── Main screen ───────────────────────────────────────────────────────────────

export default function ContextScreen() {
  const { isDark, isMale } = useAppTheme();
  const pal                = usePalette();
  const insets             = useSafeAreaInsets();
  const { isExploring }    = useExplore();

  const [state, setState]           = useState<ContextState>(EMPTY_STATE);
  const [selectedPattern, setSelectedPattern] = useState<PatternResult | null>(null);
  const [showDetail, setShowDetail]           = useState(false);
  const [showAddContext, setShowAddContext]    = useState(false);
  const [showChat, setShowChat]               = useState(false);
  const [contextSummary, setContextSummary]   = useState<ContextSummary | null>(null);
  const [showTour, setShowTour]               = useState(false);
  const tourChecked = useRef(false);
  const loadingRef = useRef(false);
  // Tracks the current load request. Any async result with a stale gen is discarded,
  // preventing a concurrent real-data load from overwriting a later demo-data load.
  const loadGenRef = useRef(0);
  // Always holds the current isExploring value so load() reads the right mode
  // even when called from the stale useFocusEffect closure.
  const isExploringRef = useRef(isExploring);

  // Show the Context tour the first time the user intentionally visits this screen.
  useEffect(() => {
    if (tourChecked.current) return;
    tourChecked.current = true;
    AsyncStorage.getItem(CONTEXT_TOUR_KEY).then((seen) => {
      if (!seen) setTimeout(() => setShowTour(true), 400);
    }).catch(() => {});
  }, []);

  async function load(force = false) {
    if (loadingRef.current && !force) return;
    if (!force && state.lastLoaded > 0 && Date.now() - state.lastLoaded < STALE_MS) return;
    const gen = ++loadGenRef.current;
    loadingRef.current = true;
    setState((s) => ({ ...s, isLoading: true }));
    try {
      const next = await loadContextState(isExploringRef.current);
      if (gen !== loadGenRef.current) return;   // stale — a newer load supersedes this one
      setState(next);
    } catch {
      if (gen !== loadGenRef.current) return;
      setState((s) => ({ ...s, isLoading: false }));
    } finally {
      if (gen === loadGenRef.current) loadingRef.current = false;
    }
  }

  useFocusEffect(
    useCallback(() => {
      if (__DEV__) console.log('[Context] useFocusEffect fired — isExploringRef:', isExploringRef.current);
      load();
      trackEvent('context_viewed', { source_screen: 'context' });
    }, [])   // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Reload whenever explore mode changes (demo ↔ real data).
  //
  // Deliberately calls loadContextState(isExploring) with the closure-captured value
  // rather than routing through load()/isExploringRef, eliminating any window where
  // the ref could be stale relative to the triggering render. React's cleanup function
  // (active = false) cancels a superseded in-flight load, which is simpler and more
  // reliable than the gen-counter approach for this specific path.
  useEffect(() => {
    if (__DEV__) console.log('[Context] isExploring effect →', isExploring);
    isExploringRef.current = isExploring;  // keep ref in sync for useFocusEffect
    loadGenRef.current++;                  // invalidate any in-flight gen-based load
    loadingRef.current = false;           // unblock future load() calls

    let active = true;
    setState(EMPTY_STATE);
    loadContextState(isExploring)          // closure-captured: always correct
      .then((next) => {
        if (__DEV__) console.log('[Context] loadContextState(' + isExploring + ') resolved —',
          'events:', next.contextEvents.length,
          'patterns:', next.rankedPatterns.length,
          'theme:', next.synthesis?.primaryTheme?.theme,
          'active:', active);
        if (active) setState(next);
      })
      .catch((err) => {
        if (__DEV__) console.log('[Context] loadContextState error:', err);
        if (active) setState((s) => ({ ...s, isLoading: false }));
      });
    return () => { active = false; };
  }, [isExploring]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleAnswerObservation(id: string, response: string) {
    await answerPatternObservation(id, response);
    setState((prev) => {
      if (!prev.dowObservationLayer) return prev;
      const observations = prev.dowObservationLayer.observations.filter((o) => o.note.id !== id);
      return { ...prev, dowObservationLayer: { observations, hasObservations: observations.length > 0 } };
    });
  }

  async function handleDismissObservation(id: string) {
    await dismissPatternObservation(id);
    setState((prev) => {
      if (!prev.dowObservationLayer) return prev;
      const observations = prev.dowObservationLayer.observations.filter((o) => o.note.id !== id);
      return { ...prev, dowObservationLayer: { observations, hasObservations: observations.length > 0 } };
    });
  }

  function handleTalkMore() {
    if (state.synthesis) {
      setContextSummary(buildContextSummary(state.synthesis));
    }
    setShowChat(true);
  }

  function handlePatternTap(p: PatternResult) {
    setSelectedPattern(p);
    setShowDetail(true);
  }

  // Persist a newly-generated story so it can be shown on future opens when
  // today's data doesn't reach story-worthiness gates.
  const handleStoryPersisted = React.useCallback((ps: PersistedStory) => {
    setState(prev => {
      if (prev.persistedStory?.storyText === ps.storyText) return prev;
      AsyncStorage.setItem(STORY_LAST_KEY, JSON.stringify(ps)).catch(() => {});
      return { ...prev, persistedStory: ps };
    });
  }, []);

  // Persist a newly-shown contrast suppression key so the same observation
  // doesn't surface every day for an ongoing event.
  const handleNewContrastKey = React.useCallback((key: string) => {
    setState(prev => {
      if (prev.seenContrastKeys.has(key)) return prev;
      const next = new Set(prev.seenContrastKeys);
      next.add(key);
      // Persist to AsyncStorage (fire-and-forget; non-critical).
      AsyncStorage.getItem(STORY_CONTRAST_STORAGE_KEY).then(raw => {
        const existing: Array<{ key: string; seenAt: string }> = raw ? JSON.parse(raw) : [];
        const today2 = new Date().toISOString().split('T')[0];
        if (!existing.some(e => e.key === key)) {
          existing.push({ key, seenAt: today2 });
          AsyncStorage.setItem(STORY_CONTRAST_STORAGE_KEY, JSON.stringify(existing)).catch(() => {});
        }
      }).catch(() => {});
      return { ...prev, seenContrastKeys: next };
    });
  }, []);

  const isLoading  = state.isLoading;
  const synthesis  = state.synthesis;
  const coverage   = state.coverage;
  const events     = state.contextEvents;

  return (
    <View style={{ flex: 1, backgroundColor: pal.background }}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingTop: insets.top + Spacing.three, paddingBottom: insets.bottom + BottomTabInset + Spacing.five },
        ]}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={isLoading}
            onRefresh={() => load(true)}
            tintColor={pal.textSecondary}
          />
        }
      >
        {/* ── Page header ── */}
        <View style={styles.pageHeader}>
          <ThemedText style={[styles.pageLabel, { color: pal.textSecondary }]}>CONTEXT</ThemedText>
          <ThemedText style={[styles.pageHeadline, { color: pal.text }]}>
            Your health, in context.
          </ThemedText>
          <ThemedText style={[styles.pageSubhead, { color: pal.textSecondary }]}>
            What seems connected. What changed. What's different from your normal.
          </ThemedText>
        </View>

        {isLoading && !synthesis ? (
          <View style={styles.loadingWrap}>
            <ActivityIndicator color={pal.accent} />
            <ThemedText style={[styles.loadingText, { color: pal.textSecondary }]}>
              Building your picture…
            </ThemedText>
          </View>
        ) : (
          <>
            {/* ── Your Story ── */}
            {synthesis && (
              <YourStory
                synthesis={synthesis}
                timeline={state.timeline}
                pal={pal}
                overrideStory={(DEMO_MODE || isExploring) ? DEMO_EXPLORE_STORY : undefined}
                trainingGoal={state.trainingGoal}
                seenContrastKeys={state.seenContrastKeys}
                onNewContrastKey={handleNewContrastKey}
                persistedStory={(DEMO_MODE || isExploring) ? null : state.persistedStory}
                onStoryPersisted={handleStoryPersisted}
              />
            )}

            <View style={[styles.rule, { backgroundColor: pal.divider }]} />

            {/* ── What's Connected ── */}
            <WhatsConnected
              patterns={state.rankedPatterns}
              hadEvidence={state.hadPatternEvidence}
              pal={pal}
              onTap={handlePatternTap}
            />

            <View style={[styles.rule, { backgroundColor: pal.divider }]} />

            {/* ── Patterns We've Noticed (DOW observations) ── */}
            {!DEMO_MODE && !isExploring && (
              <PatternObservationsSection
                layer={state.dowObservationLayer}
                pal={pal}
                onAnswer={handleAnswerObservation}
                onDismiss={handleDismissObservation}
              />
            )}
            {state.dowObservationLayer?.hasObservations && !DEMO_MODE && !isExploring && (
              <View style={[styles.rule, { backgroundColor: pal.divider }]} />
            )}

            {/* ── Life + Health ── */}
            <LifeAndHealth
              events={events}
              eventWindows={state.eventWindows}
              pal={pal}
              onAddContext={() => setShowAddContext(true)}
              onDeleteEvent={(id) => {
                setState((s) => ({ ...s, contextEvents: s.contextEvents.filter((e) => e.id !== id) }));
              }}
              onEndEvent={(id, endDate) => {
                setState((s) => ({
                  ...s,
                  contextEvents: s.contextEvents.map((e) => e.id === id ? { ...e, endDate } : e),
                }));
              }}
              readonly={(DEMO_MODE || isExploring)}
            />

            <View style={[styles.rule, { backgroundColor: pal.divider }]} />

            {/* ── Your Picture ── */}
            {coverage && (
              <YourPicture
                coverage={coverage}
                hkMovementInTimeline={state.hkMovementInTimeline}
                nutritionDaysLogged={state.timeline.filter((d) => d.calories !== undefined).length}
                waterDaysLogged={state.timeline.filter((d) => d.waterOz !== undefined).length}
                pal={pal}
              />
            )}

            {/* ── Talk more CTA ── */}
            <View style={styles.ctaSection}>
              <TouchableOpacity
                onPress={handleTalkMore}
                activeOpacity={0.8}
                style={[styles.talkMoreBtn, { borderColor: pal.divider, backgroundColor: pal.card }]}
              >
                <ThemedText style={[styles.talkMoreText, { color: pal.text }]}>
                  Talk more about your insights
                </ThemedText>
                <ThemedText style={[styles.talkMoreSub, { color: pal.textSecondary }]}>
                  Open Chat with your current context
                </ThemedText>
              </TouchableOpacity>
            </View>
          </>
        )}
      </ScrollView>

      {/* ── Modals ── */}
      <ConnectionDetailSheet
        pattern={selectedPattern}
        visible={showDetail}
        onClose={() => setShowDetail(false)}
        pal={pal}
      />

      <AddContextSheet
        visible={showAddContext}
        onClose={() => setShowAddContext(false)}
        onSaved={() => { setShowAddContext(false); load(true); }}
        pal={pal}
      />

      {/* ── Context screen tour (shown once, on first visit after WhatsNew) ── */}
      <ContextWalkthrough
        visible={showTour}
        onDone={() => {
          AsyncStorage.setItem(CONTEXT_TOUR_KEY, '1').catch(() => {});
          setShowTour(false);
        }}
        onSkip={() => {
          AsyncStorage.setItem(CONTEXT_TOUR_KEY, '1').catch(() => {});
          setShowTour(false);
        }}
      />

      <ChatModal
        visible={showChat}
        onClose={() => setShowChat(false)}
        healthData={{
          sleep:   { hours: 0, score: 0, hrv: 0, readiness: 0 },
          steps:   { count: 0, goal: 10000 },
          macros:  { calories: 0, protein: 0, carbs: 0, fat: 0, calGoal: 2000 },
          workout: { type: '—', duration: 0, calories: 0, done: false },
          water:   { oz: 0, goalOz: 80 },
          hadAlcoholLastNight: false,
        }}
        userName="there"
        isMale={isMale}
        supplements=""
        contextSummary={contextSummary ?? undefined}
      />

    </View>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  scrollContent: { paddingHorizontal: Spacing.three },

  pageHeader:   { marginBottom: Spacing.four, paddingTop: Spacing.two },
  pageLabel:    { fontSize: 10, fontWeight: '500', letterSpacing: 1.5, marginBottom: Spacing.two },
  pageHeadline: { fontFamily: Fonts.serif, fontSize: 28, fontStyle: 'italic', fontWeight: '400', lineHeight: 34, marginBottom: Spacing.two },
  pageSubhead:  { fontSize: 14, lineHeight: 20 },

  loadingWrap:  { paddingVertical: Spacing.five, alignItems: 'center', gap: Spacing.three },
  loadingText:  { fontSize: 14 },

  rule: { height: StyleSheet.hairlineWidth, marginVertical: Spacing.four },

  section:      { marginBottom: Spacing.one },
  sectionLabel: { fontSize: 10, fontWeight: '500', letterSpacing: 1.5, marginBottom: Spacing.three },
  sectionLabelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.three },

  // Your Story
  storyText:   { fontFamily: Fonts.serif, fontStyle: 'italic', fontSize: 17, lineHeight: 26 },
  signalRow:   { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two, marginTop: Spacing.three },
  signalChip:  { flexDirection: 'row', alignItems: 'baseline', gap: Spacing.one, paddingHorizontal: Spacing.two, paddingVertical: Spacing.one, borderRadius: BHRadius.chip, borderWidth: StyleSheet.hairlineWidth },
  signalChipLabel: { fontSize: 11, fontWeight: '400' },
  signalChipValue: { fontSize: 13, fontWeight: '500' },

  // What's Connected
  connectionList: { gap: Spacing.three },
  connectionDivider:  { borderTopWidth: StyleSheet.hairlineWidth, marginTop: Spacing.two, marginBottom: Spacing.two },
  connectionQuestion: { fontSize: 13, lineHeight: 18 },
  responseRow:        { flexDirection: 'row', gap: Spacing.two },
  responseBtn:        { flex: 1, paddingVertical: 8, borderRadius: BHRadius.chip, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center' },
  responseBtnText:    { fontSize: 13, fontWeight: '500' },
  connectionCard: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: BHRadius.card,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  connectionCardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  connectionHeadline: { fontSize: 10, fontWeight: '600', letterSpacing: 1.2 },
  connectionChevron:  { fontSize: 20, fontWeight: '200' },
  connectionSentence: { fontSize: 15, lineHeight: 22 },
  connectionFooter:   { flexDirection: 'row', alignItems: 'center', gap: Spacing.two, flexWrap: 'wrap' },
  evidenceChip:       { paddingHorizontal: Spacing.two, paddingVertical: 3, borderRadius: BHRadius.chip, borderWidth: StyleSheet.hairlineWidth },
  evidenceChipText:   { fontSize: 11, fontWeight: '500' },
  connectionSource:   { fontSize: 11, flex: 1 },

  // Empty states
  emptyCard:      { borderWidth: StyleSheet.hairlineWidth, borderRadius: BHRadius.card, padding: Spacing.three, gap: Spacing.two },
  emptyCardTitle: { fontSize: 15, lineHeight: 22 },
  emptyCardSub:   { fontSize: 13, lineHeight: 19 },

  // Connection detail
  detailContent:  { padding: Spacing.three },
  detailHeader:   { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.three },
  detailHeadline: { fontSize: 10, fontWeight: '600', letterSpacing: 1.5 },
  detailClose:    { fontSize: 17 },
  detailSentence: { fontFamily: Fonts.serif, fontStyle: 'italic', fontSize: 18, lineHeight: 27, marginBottom: Spacing.three },
  detailDivider:  { height: StyleSheet.hairlineWidth, marginVertical: Spacing.three },
  detailMetaLabel:{ fontSize: 10, fontWeight: '500', letterSpacing: 1.5, marginBottom: Spacing.one },
  detailMetaValue:{ fontSize: 16, fontWeight: '400', marginBottom: Spacing.one },
  detailMetaSub:  { fontSize: 13, lineHeight: 19, marginTop: 2 },
  comparisonRow:  { flexDirection: 'row', marginTop: Spacing.two, gap: Spacing.three },
  comparisonCol:  { flex: 1, gap: Spacing.one },
  comparisonColLabel: { fontSize: 11 },
  comparisonValue:    { fontSize: 20, fontWeight: '500' },
  comparisonSep:  { width: StyleSheet.hairlineWidth, alignSelf: 'stretch' },
  detailCaution:  { fontSize: 11, lineHeight: 17, marginTop: Spacing.four, fontStyle: 'italic' },

  // Life + Health
  addContextLink: { fontSize: 14, fontWeight: '500' },
  timeline:       { gap: 0 },
  timelineEvent:  { flexDirection: 'row', gap: Spacing.two },
  timelineDotCol: { alignItems: 'center', width: 12, paddingTop: 3 },
  timelineDot:    { width: 8, height: 8, borderRadius: 4 },
  timelineLine:   { flex: 1, width: 1, marginTop: 4, minHeight: 20 },
  timelineContent: { flex: 1, paddingBottom: Spacing.four },
  timelineRow:     { flexDirection: 'row', alignItems: 'flex-start' },
  timelineMain:    { flex: 1 },
  deleteBtn:       { paddingLeft: Spacing.two, paddingTop: 2 },
  timelineEventLabel: { fontSize: 16, fontWeight: '500', marginBottom: 2 },
  timelineEventDate:  { fontSize: 13 },
  timelineExpand:     { fontSize: 12, marginTop: Spacing.two },
  windowTable:    { marginTop: Spacing.two, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: Spacing.two, gap: Spacing.two },
  periodRow:      { gap: 4 },
  periodRowLabel: { fontSize: 11, fontWeight: '500', letterSpacing: 0.5 },
  periodCols:     { flexDirection: 'row', gap: Spacing.three },
  periodCol:      { flex: 1, gap: 1 },
  periodColHead:  { fontSize: 10 },
  periodColVal:   { fontSize: 15, fontWeight: '400' },
  windowNote:     { fontSize: 11, fontStyle: 'italic', marginTop: Spacing.two },

  // Your Picture
  pictureCard:    { borderWidth: StyleSheet.hairlineWidth, borderRadius: BHRadius.card, overflow: 'hidden' },
  pictureRow:     { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: Spacing.three, paddingVertical: 13 },
  pictureRow_divider: { height: StyleSheet.hairlineWidth },
  pictureDomain:       { fontSize: 15 },
  pictureLevelRow:     { flexDirection: 'row', alignItems: 'center', gap: 4 },
  pictureLevel:        { fontSize: 13, fontWeight: '400' },
  pictureChevron:      { fontSize: 10 },
  pictureHintInline:   { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: Spacing.three, paddingVertical: 10 },
  pictureHintInlineText: { fontSize: 13, lineHeight: 18, fontStyle: 'italic' },

  // Pattern observations
  observationCard: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: BHRadius.card,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  observationText:     { fontFamily: Fonts.serif, fontStyle: 'italic', fontSize: 16, lineHeight: 24 },
  observationQuestion: { fontSize: 14, lineHeight: 20 },
  observationInput: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: BHRadius.chip,
    paddingHorizontal: Spacing.three,
    paddingVertical: 10,
    fontSize: 14,
    lineHeight: 20,
    minHeight: 72,
    textAlignVertical: 'top',
    marginTop: Spacing.one,
  },
  observationSecondaryRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: Spacing.two },
  observationDismissText:  { fontSize: 13 },

  // Pattern carousel pagination
  carouselDots:    { flexDirection: 'row', justifyContent: 'center', gap: 5, marginTop: Spacing.two },
  carouselDot:     { width: 4, height: 4, borderRadius: 2 },
  carouselCounter: { fontSize: 11, fontWeight: '400', letterSpacing: 0.3 },

  // Add Context sheet
  addSheetContent:{ padding: Spacing.three },
  addSheetHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.four },
  addSheetTitle:  { fontFamily: Fonts.serif, fontStyle: 'italic', fontSize: 24, fontWeight: '400', paddingRight: 4 }, // italic overhang
  addFieldLabel:  { fontSize: 10, fontWeight: '500', letterSpacing: 1.5, marginBottom: Spacing.two, marginTop: Spacing.three },
  typeGrid:       { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two },
  typeChip:       { borderWidth: 1, borderRadius: BHRadius.chip, paddingHorizontal: Spacing.three, paddingVertical: Spacing.two },
  typeChipText:   { fontSize: 14 },
  textField:      {
    borderWidth: StyleSheet.hairlineWidth, borderRadius: BHRadius.chip,
    paddingHorizontal: Spacing.three, paddingVertical: 12,
    fontSize: 15,
  },
  dateField: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth, borderRadius: BHRadius.chip,
    paddingHorizontal: Spacing.three, paddingVertical: 14,
  },
  pickerOverlay:  { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  pickerSheet:    { borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingBottom: 24 },
  pickerHeader:   { flexDirection: 'row', justifyContent: 'space-between', padding: Spacing.three, borderBottomWidth: StyleSheet.hairlineWidth },
  pickerColumns:  { flexDirection: 'row', paddingHorizontal: Spacing.three },
  pickerHighlight:{ position: 'absolute', top: 56 + ITEM_H * PAD, left: Spacing.three, right: Spacing.three, height: ITEM_H, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth },
  ongoingRow:     { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: Spacing.three },
  togglePill:     { paddingHorizontal: Spacing.three, paddingVertical: Spacing.one, borderRadius: BHRadius.pill, borderWidth: 1 },
  toggleText:     { fontSize: 13, fontWeight: '500' },
  saveBtn:        { marginTop: Spacing.four, borderRadius: BHRadius.btn, paddingVertical: 14, alignItems: 'center' },
  saveBtnText:    { fontSize: 16, fontWeight: '500', color: '#fff' },

  // Talk more CTA
  ctaSection:   { paddingTop: Spacing.four },
  talkMoreBtn:  {
    borderWidth: StyleSheet.hairlineWidth, borderRadius: BHRadius.card,
    paddingHorizontal: Spacing.three, paddingVertical: Spacing.three, gap: 4,
  },
  talkMoreText: { fontSize: 17, fontWeight: '400' },
  talkMoreSub:  { fontSize: 12 },

});
