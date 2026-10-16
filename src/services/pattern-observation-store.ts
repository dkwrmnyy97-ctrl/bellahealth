/**
 * pattern-observation-store.ts
 *
 * Persistent storage for physiological pattern observations and user responses.
 *
 * Architecture is designed for forward-compatibility with intraday time-window
 * patterns (e.g., "elevated HR at 11am on Tuesdays"). The patternType field
 * discriminates between the two modes; intraday fields are reserved but unused
 * until the intraday data layer is built.
 *
 * Privacy:
 *   - All data is on-device (AsyncStorage). No server storage.
 *   - userResponse is free text entered by the user only.
 *   - patternSnapshot contains only numeric summary statistics, never raw data.
 *
 * Deduplication:
 *   - Note IDs are deterministic: `${signal}_dow_${dayOfWeek}` for day-of-week
 *     patterns. The same pattern never generates two simultaneous pending notes.
 *   - Once answered or dismissed, a note is never re-surfaced for that pattern ID.
 *   - If the underlying pattern disappears from the timeline (insufficient data),
 *     the pending note is expired silently via expireStalePendingNotes().
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { DowPatternResult } from './dow-pattern-engine';

const STORE_KEY = 'pattern_observation_notes';

// ─── Types ────────────────────────────────────────────────────────────────────

export type PatternObservationStatus = 'pending' | 'answered' | 'dismissed';

export interface PatternObservationNote {
  /**
   * Deterministic ID for day-of-week patterns: `${signal}_dow_${dayOfWeek}`.
   * Future intraday format: `${signal}_tw_${timeWindowStart}_${dayOfWeek}`.
   * Stable across sessions — deduplication key.
   */
  id: string;

  /** Discriminates pattern type for forward-compatible rendering. */
  patternType: 'day_of_week' | 'intraday_time_window';

  /** The signal that triggered this observation (e.g. 'readiness', 'hrv'). */
  signal: string;

  // ── day_of_week fields ─────────────────────────────────────────────────────
  /** 0=Sun … 6=Sat. Present when patternType = 'day_of_week'. */
  dayOfWeek?: number;

  // ── intraday_time_window fields (reserved — not yet populated) ─────────────
  /** 'HH:MM' local time. Present when patternType = 'intraday_time_window'. */
  timeWindowStart?: string;
  /** 'HH:MM' local time. Present when patternType = 'intraday_time_window'. */
  timeWindowEnd?: string;
  /**
   * Workout/activity type exclusion list applied when computing the pattern.
   * Preserved here so we can explain to the user that workouts were excluded.
   * Reserved for intraday; unused for day_of_week.
   */
  excludedActivityTypes?: string[];

  // ── Observation display text (generated at creation time) ─────────────────
  /** Factual observation. E.g. "Your readiness tends to be lower on Thursdays." */
  observationText: string;
  /** Open-ended follow-up question. E.g. "Does anything usually happen on Thursdays?" */
  questionText: string;

  // ── User response ─────────────────────────────────────────────────────────
  status: PatternObservationStatus;
  /** Free text from the user. Null if dismissed without answering. */
  userResponse?: string;
  respondedAt?: string;   // ISO timestamp
  dismissedAt?: string;   // ISO timestamp

  // ── Pattern snapshot at creation ──────────────────────────────────────────
  /**
   * Numeric summary of the pattern when this note was created.
   * Used to detect whether the pattern has since disappeared from the timeline.
   */
  patternSnapshot: {
    occurrences: number;
    consistencyRate: number;
    absoluteDiff: number;
    confidenceTier: string;
  };

  createdAt: string;  // ISO timestamp
}

// ─── Storage helpers ──────────────────────────────────────────────────────────

async function loadNotes(): Promise<PatternObservationNote[]> {
  const raw = await AsyncStorage.getItem(STORE_KEY);
  return raw ? (JSON.parse(raw) as PatternObservationNote[]) : [];
}

async function saveNotes(notes: PatternObservationNote[]): Promise<void> {
  await AsyncStorage.setItem(STORE_KEY, JSON.stringify(notes));
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Load all pattern observation notes.
 */
export async function loadPatternObservationNotes(): Promise<PatternObservationNote[]> {
  return loadNotes();
}

/**
 * Create a new observation note from a DowPatternResult if one doesn't already exist.
 * No-ops if a note with this ID already exists (any status).
 * Returns the note (new or existing).
 */
export async function createDowObservationNote(
  pattern: DowPatternResult,
  observationText: string,
  questionText: string,
): Promise<PatternObservationNote> {
  const notes = await loadNotes();
  const existing = notes.find((n) => n.id === pattern.id);
  if (existing) return existing;

  const note: PatternObservationNote = {
    id: pattern.id,
    patternType: 'day_of_week',
    signal: pattern.signal,
    dayOfWeek: pattern.dayOfWeek,
    observationText,
    questionText,
    status: 'pending',
    patternSnapshot: {
      occurrences: pattern.occurrences,
      consistencyRate: pattern.consistencyRate,
      absoluteDiff: pattern.absoluteDiff,
      confidenceTier: pattern.confidenceTier,
    },
    createdAt: new Date().toISOString(),
  };

  await saveNotes([...notes, note]);
  return note;
}

/**
 * Save the user's free-text response to an observation note.
 * Marks the note as 'answered'. No-op if note not found.
 */
export async function answerPatternObservation(
  id: string,
  userResponse: string,
): Promise<void> {
  const notes = await loadNotes();
  const idx = notes.findIndex((n) => n.id === id);
  if (idx === -1) return;
  notes[idx] = {
    ...notes[idx],
    status: 'answered',
    userResponse,
    respondedAt: new Date().toISOString(),
  };
  await saveNotes(notes);
}

/**
 * Dismiss an observation note without answering.
 * Marks it 'dismissed' — will never be re-surfaced for this pattern ID.
 */
export async function dismissPatternObservation(id: string): Promise<void> {
  const notes = await loadNotes();
  const idx = notes.findIndex((n) => n.id === id);
  if (idx === -1) return;
  notes[idx] = {
    ...notes[idx],
    status: 'dismissed',
    dismissedAt: new Date().toISOString(),
  };
  await saveNotes(notes);
}

/**
 * Expire pending notes whose patterns are no longer present in the current
 * timeline. Call after detectDowPatterns() with the live pattern IDs.
 *
 * A note is expired (set to dismissed) when:
 *   - Its status is 'pending'
 *   - Its pattern ID is NOT in the current active pattern set
 *
 * This prevents stale questions from surfacing after the underlying
 * signal pattern has dissolved (e.g., life changed, data corrected).
 */
export async function expireStalePendingNotes(
  activePatternIds: Set<string>,
): Promise<void> {
  const notes = await loadNotes();
  let changed = false;
  const updated = notes.map((n) => {
    if (n.status === 'pending' && !activePatternIds.has(n.id)) {
      changed = true;
      return { ...n, status: 'dismissed' as PatternObservationStatus, dismissedAt: new Date().toISOString() };
    }
    return n;
  });
  if (changed) await saveNotes(updated);
}

/**
 * Returns only the pending notes whose pattern IDs are in the active set.
 * Safe to call on every Context screen load — returns [] when no new patterns.
 */
export async function getActivePendingNotes(
  activePatternIds: Set<string>,
): Promise<PatternObservationNote[]> {
  const notes = await loadNotes();
  return notes.filter((n) => n.status === 'pending' && activePatternIds.has(n.id));
}
