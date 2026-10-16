/**
 * context-events.ts
 *
 * One extensible ContextEvent architecture for all life/body context.
 * All data is on-device (AsyncStorage). No cross-user data. No new server storage.
 *
 * Privacy boundaries:
 *   - Gratitude journal free text: NEVER enters this pipeline.
 *   - Cycle journal `notes` free text: NEVER enters this pipeline.
 *   - Cycle `signs` (structured tags) and dates: OK to use.
 *   - Derived events (drink_log, wellness): read existing storage, not duplicated.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

// ─── Types ─────────────────────────────────────────────────────────────────────

export type ContextEventType =
  /** @deprecated Legacy records stored as 'vacation' normalize to 'travel' on load.
   *  New events always use 'travel'. Do not write 'vacation' in new code. */
  | 'vacation'
  | 'travel'
  | 'illness'
  | 'stressful_period'
  | 'training_block'
  | 'alcohol_period'
  | 'cycle_phase'
  | 'user_defined';

/** user_logged = the user explicitly created this event.
 *  derived     = inferred from an existing data source (drink_log, wellness, etc.) */
export type ContextEventSource = 'user_logged' | 'derived';

export interface ContextEvent {
  id: string;
  type: ContextEventType;
  source: ContextEventSource;
  /** Human-readable label override, required for user_defined type */
  label?: string;
  startDate: string;    // YYYY-MM-DD
  endDate?: string;     // YYYY-MM-DD; absent = open/ongoing
  /** Only user-provided text. Never populated by automated pipelines. */
  notes?: string;
  /** Flexible per-type payload. Never contains free text from journal notes. */
  metadata?: Record<string, unknown>;
  createdAt: string;    // ISO 8601 timestamp
  updatedAt: string;    // ISO 8601 timestamp
}

// ─── Storage ───────────────────────────────────────────────────────────────────

const CONTEXT_EVENTS_KEY = 'context_events';

// Storage keys for historical data (migrated from today-only formats)
export const CAFFEINE_HISTORY_KEY   = 'caffeine_history';
export const WELLNESS_SESSIONS_HISTORY_KEY = 'wellness_sessions_history';

// Storage keys for existing sources (read-only adapters — do not mutate)
const DRINK_LOG_KEY              = 'drink_log';
const WELLNESS_CLASSES_HISTORY_KEY = 'wellness_classes_history';
const CYCLE_JOURNAL_KEY          = 'cycle_journal';
const CYCLE_PROFILE_KEY          = 'cycle_profile';

function nowIso(): string {
  return new Date().toISOString();
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function makeId(): string {
  return `evt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// ─── CRUD ──────────────────────────────────────────────────────────────────────

export async function loadContextEvents(): Promise<ContextEvent[]> {
  const raw = await AsyncStorage.getItem(CONTEXT_EVENTS_KEY);
  const events = raw ? (JSON.parse(raw) as ContextEvent[]) : [];
  // Normalize legacy 'vacation' records to 'travel' at the read boundary.
  // Storage is never mutated — normalization is transparent to callers.
  return events.map((e) =>
    e.type === 'vacation' ? { ...e, type: 'travel' as ContextEventType } : e
  );
}

async function saveContextEvents(events: ContextEvent[]): Promise<void> {
  await AsyncStorage.setItem(CONTEXT_EVENTS_KEY, JSON.stringify(events));
}

/** Create and persist a new ContextEvent. Returns the created event. */
export async function createContextEvent(
  fields: Omit<ContextEvent, 'id' | 'createdAt' | 'updatedAt'>
): Promise<ContextEvent> {
  const now = nowIso();
  const event: ContextEvent = { ...fields, id: makeId(), createdAt: now, updatedAt: now };
  const events = await loadContextEvents();
  await saveContextEvents([...events, event]);
  return event;
}

/** Update fields on an existing event. Returns the updated event, or null if not found. */
export async function updateContextEvent(
  id: string,
  patch: Partial<Omit<ContextEvent, 'id' | 'createdAt'>>
): Promise<ContextEvent | null> {
  const events = await loadContextEvents();
  const idx = events.findIndex((e) => e.id === id);
  if (idx === -1) return null;
  const updated: ContextEvent = { ...events[idx], ...patch, updatedAt: nowIso() };
  events[idx] = updated;
  await saveContextEvents(events);
  return updated;
}

/** Delete a ContextEvent by id. Returns true if found and deleted. */
export async function deleteContextEvent(id: string): Promise<boolean> {
  const events = await loadContextEvents();
  const next = events.filter((e) => e.id !== id);
  if (next.length === events.length) return false;
  await saveContextEvents(next);
  return true;
}

// ─── Validation ────────────────────────────────────────────────────────────────

export function validateContextEventDates(
  startDate: string,
  endDate?: string
): { valid: boolean; error?: string } {
  const today = todayStr();
  if (startDate > today) {
    return { valid: false, error: 'Start date cannot be in the future.' };
  }
  if (endDate !== undefined) {
    if (endDate > today) {
      return { valid: false, error: 'End date cannot be in the future.' };
    }
    if (endDate < startDate) {
      return { valid: false, error: 'End date must be on or after start date.' };
    }
  }
  return { valid: true };
}

// ─── Vacation mode adapter ─────────────────────────────────────────────────────

/**
 * Call when Travel Mode is toggled ON.
 * Creates an open-ended travel event starting today.
 * Closes any previously open travel events first (safe for old users with no events).
 * Legacy 'vacation' records are normalized to 'travel' by loadContextEvents.
 */
export async function onVacationModeOn(): Promise<void> {
  const events = await loadContextEvents(); // 'vacation' already normalized to 'travel'
  const now = nowIso();
  const today = todayStr();

  // If a travel event already started today (open or recently closed), reopen it.
  // This prevents duplicate same-day records when the user toggles ON→OFF→ON.
  const sameDayIdx = events.findIndex((e) => e.type === 'travel' && e.startDate === today);
  if (sameDayIdx !== -1) {
    const { endDate: _removed, ...reopened } = events[sameDayIdx];
    const updated = events.map((e, i): ContextEvent =>
      i === sameDayIdx ? { ...reopened, updatedAt: now } : e
    );
    await saveContextEvents(updated);
    return;
  }

  // No same-day travel event — close any older open ones, then create a new event.
  const updated = events.map((e): ContextEvent =>
    e.type === 'travel' && !e.endDate
      ? { ...e, endDate: today, updatedAt: now }
      : e
  );
  const newEvent: ContextEvent = {
    id: makeId(),
    type: 'travel',
    source: 'user_logged',
    startDate: today,
    createdAt: now,
    updatedAt: now,
  };
  await saveContextEvents([...updated, newEvent]);
}

/**
 * Call when Travel Mode is toggled OFF.
 * Closes the most recently started open travel event.
 * No-ops gracefully if there is no open travel event (old users, first-time).
 */
export async function onVacationModeOff(): Promise<void> {
  const events = await loadContextEvents(); // normalized: only 'travel' type active
  const openTravel = events
    .filter((e) => e.type === 'travel' && !e.endDate)
    .sort((a, b) => b.startDate.localeCompare(a.startDate));
  if (openTravel.length === 0) return;
  await updateContextEvent(openTravel[0].id, { endDate: todayStr() });
}

// ─── Derived: drink log ────────────────────────────────────────────────────────

type DrinkLogEntry = {
  date: string;
  totalDrinks: number;
  totalCalories: number;
  vibe?: string | null;
  counts?: Record<string, number>;
};

/**
 * Returns ContextEvents derived from the existing drink_log.
 * These are ephemeral — derived on read, not persisted to context_events.
 * Source provenance: derived.
 */
export async function deriveDrinkEvents(): Promise<ContextEvent[]> {
  const raw = await AsyncStorage.getItem(DRINK_LOG_KEY);
  const log: DrinkLogEntry[] = raw ? JSON.parse(raw) : [];
  return log
    .filter((e) => e.totalDrinks > 0)
    .map((e) => ({
      id: `derived_drink_${e.date}`,
      type: 'alcohol_period' as ContextEventType,
      source: 'derived' as ContextEventSource,
      startDate: e.date,
      endDate: e.date,
      metadata: {
        totalDrinks: e.totalDrinks,
        totalCalories: e.totalCalories,
        vibe: e.vibe ?? null,
      },
      createdAt: `${e.date}T23:59:00.000Z`,
      updatedAt: `${e.date}T23:59:00.000Z`,
    }));
}

// ─── Derived: wellness classes ─────────────────────────────────────────────────

type ClassEntry = {
  classType: string;
  heated: boolean;
  linkedWorkout: unknown | null;
  timestamp: string;
  date?: string;
};

/**
 * Returns ContextEvents derived from wellness_classes_history.
 * Ephemeral — derived on read.
 */
export async function deriveWellnessClassEvents(): Promise<ContextEvent[]> {
  const raw = await AsyncStorage.getItem(WELLNESS_CLASSES_HISTORY_KEY);
  const history: ClassEntry[] = raw ? JSON.parse(raw) : [];
  return history
    .filter((e) => !!e.date)
    .map((e, i) => ({
      id: `derived_class_${e.date}_${i}`,
      type: 'training_block' as ContextEventType,
      source: 'derived' as ContextEventSource,
      label: e.classType,
      startDate: e.date!,
      endDate: e.date!,
      metadata: { classType: e.classType, heated: e.heated },
      createdAt: `${e.date}T12:00:00.000Z`,
      updatedAt: `${e.date}T12:00:00.000Z`,
    }));
}

// ─── Wellness sessions (sauna/cold) — historical storage ───────────────────────

export type WellnessSessionHistoryEntry = {
  date: string;
  type: 'sauna' | 'cold_plunge';
  minutes: number;
  timestamp: string;
};

/**
 * Appends a recovery session to the historical log.
 * Called from WellnessModal when a session is logged.
 * Preserves the existing today-only wellness_log key untouched.
 */
export async function appendWellnessSessionHistory(
  entry: WellnessSessionHistoryEntry
): Promise<void> {
  const raw = await AsyncStorage.getItem(WELLNESS_SESSIONS_HISTORY_KEY);
  const history: WellnessSessionHistoryEntry[] = raw ? JSON.parse(raw) : [];
  await AsyncStorage.setItem(
    WELLNESS_SESSIONS_HISTORY_KEY,
    JSON.stringify([...history, entry])
  );
}

export async function loadWellnessSessionHistory(): Promise<WellnessSessionHistoryEntry[]> {
  const raw = await AsyncStorage.getItem(WELLNESS_SESSIONS_HISTORY_KEY);
  return raw ? JSON.parse(raw) : [];
}

/**
 * Returns ContextEvents derived from the wellness sessions history.
 * Ephemeral — derived on read.
 */
export async function deriveWellnessSessionEvents(): Promise<ContextEvent[]> {
  const history = await loadWellnessSessionHistory();
  return history.map((e, i) => ({
    id: `derived_session_${e.date}_${e.type}_${i}`,
    type: 'training_block' as ContextEventType,
    source: 'derived' as ContextEventSource,
    label: e.type === 'sauna' ? 'Sauna' : 'Cold Plunge',
    startDate: e.date,
    endDate: e.date,
    metadata: { sessionType: e.type, minutes: e.minutes },
    createdAt: `${e.date}T12:00:00.000Z`,
    updatedAt: `${e.date}T12:00:00.000Z`,
  }));
}

// ─── Water — historical storage ───────────────────────────────────────────────

export const WATER_HISTORY_KEY = 'water_history';

/**
 * One entry per day: today's cumulative manually-logged water in oz.
 * Same upsert pattern as CaffeineHistoryEntry.
 * Source: BellaHealth logWater() taps only. Does NOT include HealthKit dietary water
 * from other apps (Apple Health, MyFitnessPal, etc.) — those are not stored by BellaHealth.
 */
export type WaterHistoryEntry = { date: string; oz: number };

/**
 * Upserts today's manual water total into the historical log.
 * Called from the Home screen logWater() each time the user taps to add water.
 */
export async function appendWaterHistory(entry: WaterHistoryEntry): Promise<void> {
  const raw = await AsyncStorage.getItem(WATER_HISTORY_KEY);
  const history: WaterHistoryEntry[] = raw ? JSON.parse(raw) : [];
  const filtered = history.filter((e) => e.date !== entry.date);
  await AsyncStorage.setItem(
    WATER_HISTORY_KEY,
    JSON.stringify([...filtered, entry]),
  );
}

export async function loadWaterHistory(): Promise<WaterHistoryEntry[]> {
  const raw = await AsyncStorage.getItem(WATER_HISTORY_KEY);
  return raw ? JSON.parse(raw) : [];
}

// ─── Caffeine — historical storage ────────────────────────────────────────────

export type CaffeineHistoryEntry = {
  date: string;
  totalMg: number;
  itemCount: number;
};

/**
 * Upserts today's caffeine total into the historical log.
 * Called from CaffeineModal each time a drink is logged.
 * Preserves the existing caffeine_log today-only key untouched.
 */
export async function appendCaffeineHistory(entry: CaffeineHistoryEntry): Promise<void> {
  const raw = await AsyncStorage.getItem(CAFFEINE_HISTORY_KEY);
  const history: CaffeineHistoryEntry[] = raw ? JSON.parse(raw) : [];
  const filtered = history.filter((e) => e.date !== entry.date);
  await AsyncStorage.setItem(
    CAFFEINE_HISTORY_KEY,
    JSON.stringify([...filtered, entry])
  );
}

export async function loadCaffeineHistory(): Promise<CaffeineHistoryEntry[]> {
  const raw = await AsyncStorage.getItem(CAFFEINE_HISTORY_KEY);
  return raw ? JSON.parse(raw) : [];
}

// ─── Derived: cycle phases ─────────────────────────────────────────────────────

type CycleEntry = {
  date: string;
  energy: number;
  stress: number;
  signs: string[];
  notes: string;  // NEVER passed downstream — privacy boundary
};

type CycleProfile = {
  lastPeriodDate: string | null;
};

/** Signs that indicate a period day (structured tags only — no free text). */
const PERIOD_SIGNS = new Set(['Light flow', 'Medium flow', 'Heavy flow', 'Light spotting', 'Heavier spotting']);

/**
 * Returns ContextEvents derived from the cycle journal and profile.
 * Privacy-aware: only uses `signs` (structured tags) and dates.
 * The `notes` free-text field is NEVER read or included.
 */
export async function deriveCyclePhaseEvents(): Promise<ContextEvent[]> {
  const [journalRaw, profileRaw] = await Promise.all([
    AsyncStorage.getItem(CYCLE_JOURNAL_KEY),
    AsyncStorage.getItem(CYCLE_PROFILE_KEY),
  ]);

  const entries: CycleEntry[] = journalRaw ? JSON.parse(journalRaw) : [];
  const profile: CycleProfile = profileRaw ? JSON.parse(profileRaw) : { lastPeriodDate: null };
  const events: ContextEvent[] = [];

  // Period days from journal signs
  for (const entry of entries) {
    const isPeriodDay = entry.signs.some((s) => PERIOD_SIGNS.has(s));
    if (!isPeriodDay) continue;
    events.push({
      id: `derived_cycle_${entry.date}`,
      type: 'cycle_phase',
      source: 'derived',
      label: 'period',
      startDate: entry.date,
      endDate: entry.date,
      // Only structured data — no notes, no energy/stress scores
      metadata: { signs: entry.signs.filter((s) => PERIOD_SIGNS.has(s)) },
      createdAt: `${entry.date}T12:00:00.000Z`,
      updatedAt: `${entry.date}T12:00:00.000Z`,
    });
  }

  // Period start from profile (if no journal entry covers that date)
  if (profile.lastPeriodDate) {
    const alreadyCovered = events.some((e) => e.startDate === profile.lastPeriodDate);
    if (!alreadyCovered) {
      events.push({
        id: `derived_cycle_profile_${profile.lastPeriodDate}`,
        type: 'cycle_phase',
        source: 'derived',
        label: 'period_start',
        startDate: profile.lastPeriodDate,
        endDate: profile.lastPeriodDate,
        metadata: { source: 'profile' },
        createdAt: `${profile.lastPeriodDate}T12:00:00.000Z`,
        updatedAt: `${profile.lastPeriodDate}T12:00:00.000Z`,
      });
    }
  }

  return events;
}

// ─── Aggregate source loader ───────────────────────────────────────────────────

export type ContextSources = {
  userEvents: ContextEvent[];
  drinkEvents: ContextEvent[];
  wellnessClassEvents: ContextEvent[];
  wellnessSessionEvents: ContextEvent[];
  cyclePhaseEvents: ContextEvent[];
};

/**
 * Loads all context sources in parallel.
 * The entry point for anything that needs to reason about the user's context.
 */
export async function fetchContextSources(): Promise<ContextSources> {
  const [
    userEvents,
    drinkEvents,
    wellnessClassEvents,
    wellnessSessionEvents,
    cyclePhaseEvents,
  ] = await Promise.all([
    loadContextEvents(),
    deriveDrinkEvents(),
    deriveWellnessClassEvents(),
    deriveWellnessSessionEvents(),
    deriveCyclePhaseEvents(),
  ]);
  return { userEvents, drinkEvents, wellnessClassEvents, wellnessSessionEvents, cyclePhaseEvents };
}
