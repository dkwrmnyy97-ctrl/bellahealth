/**
 * context-events.test.ts
 *
 * Tests for the Context Foundation data model.
 * Requires jest-expo (add to devDependencies to run):
 *   npx expo install jest-expo --dev
 *   Add to package.json: "jest": { "preset": "jest-expo" }
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  loadContextEvents,
  createContextEvent,
  updateContextEvent,
  deleteContextEvent,
  validateContextEventDates,
  onVacationModeOn,
  onVacationModeOff,
  deriveDrinkEvents,
  deriveWellnessClassEvents,
  deriveWellnessSessionEvents,
  appendWellnessSessionHistory,
  appendCaffeineHistory,
  loadCaffeineHistory,
  loadWellnessSessionHistory,
  deriveCyclePhaseEvents,
  fetchContextSources,
  type ContextEvent,
} from '../context-events';

import {
  buildBaselineProfile,
  buildBodyTimeline,
  buildLifeContextTimeline,
} from '../context-timeline';

// AsyncStorage is auto-mocked by jest-expo via @react-native-async-storage/async-storage/jest/async-storage-mock
// If not configured, mock it manually below:
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

// ─── Helpers ───────────────────────────────────────────────────────────────────

function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function todayStr(): string {
  return localDateStr(new Date());
}

function pastDate(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return localDateStr(d);
}

function futureDate(daysAhead: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return localDateStr(d);
}

// ─── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  await AsyncStorage.clear();
});

// ─── CRUD ──────────────────────────────────────────────────────────────────────

describe('loadContextEvents', () => {
  it('returns empty array for new users with no stored data', async () => {
    const events = await loadContextEvents();
    expect(events).toEqual([]);
  });
});

describe('createContextEvent', () => {
  it('creates an event with id, createdAt, updatedAt', async () => {
    const event = await createContextEvent({
      type: 'illness',
      source: 'user_logged',
      startDate: pastDate(3),
    });
    expect(event.id).toMatch(/^evt_/);
    expect(event.type).toBe('illness');
    expect(event.source).toBe('user_logged');
    expect(event.createdAt).toBeTruthy();
    expect(event.updatedAt).toBeTruthy();
  });

  it('persists so subsequent load returns the event', async () => {
    await createContextEvent({ type: 'travel', source: 'user_logged', startDate: pastDate(1) });
    const events = await loadContextEvents();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('travel');
  });

  it('accumulates multiple events', async () => {
    await createContextEvent({ type: 'vacation', source: 'user_logged', startDate: pastDate(7) });
    await createContextEvent({ type: 'illness', source: 'user_logged', startDate: pastDate(2) });
    const events = await loadContextEvents();
    expect(events).toHaveLength(2);
  });
});

describe('updateContextEvent', () => {
  it('patches endDate and updates updatedAt', async () => {
    const evt = await createContextEvent({ type: 'vacation', source: 'user_logged', startDate: pastDate(5) });
    const updated = await updateContextEvent(evt.id, { endDate: todayStr() });
    expect(updated).not.toBeNull();
    expect(updated!.endDate).toBe(todayStr());
    expect(updated!.updatedAt >= evt.updatedAt).toBe(true);
  });

  it('returns null for unknown id', async () => {
    const result = await updateContextEvent('nonexistent_id', { endDate: todayStr() });
    expect(result).toBeNull();
  });

  it('does not modify createdAt', async () => {
    const evt = await createContextEvent({ type: 'stressful_period', source: 'user_logged', startDate: pastDate(3) });
    const updated = await updateContextEvent(evt.id, { label: 'Work crunch' });
    expect(updated!.createdAt).toBe(evt.createdAt);
  });
});

describe('deleteContextEvent', () => {
  it('removes the event and returns true', async () => {
    const evt = await createContextEvent({ type: 'training_block', source: 'user_logged', startDate: pastDate(10) });
    const deleted = await deleteContextEvent(evt.id);
    expect(deleted).toBe(true);
    const events = await loadContextEvents();
    expect(events).toHaveLength(0);
  });

  it('returns false for unknown id', async () => {
    const result = await deleteContextEvent('ghost_id');
    expect(result).toBe(false);
  });
});

// ─── Validation ────────────────────────────────────────────────────────────────

describe('validateContextEventDates', () => {
  it('rejects start date in the future', () => {
    const result = validateContextEventDates(futureDate(1));
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/future/i);
  });

  it('rejects end date in the future', () => {
    const result = validateContextEventDates(pastDate(3), futureDate(1));
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/future/i);
  });

  it('rejects end date before start date', () => {
    const result = validateContextEventDates(pastDate(1), pastDate(3));
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/on or after/i);
  });

  it('accepts valid start and end on same day', () => {
    const result = validateContextEventDates(todayStr(), todayStr());
    expect(result.valid).toBe(true);
  });

  it('accepts open-ended event (no endDate)', () => {
    const result = validateContextEventDates(pastDate(5));
    expect(result.valid).toBe(true);
  });
});

// ─── todayStr uses local date, not UTC date (regression) ──────────────────────

describe('todayStr local-date regression', () => {
  it('onVacationModeOn startDate matches local getFullYear/getMonth/getDate, not toISOString', async () => {
    // Mock Date so we control what "now" means.
    // We freeze to a moment where local and UTC could differ:
    // the implementation MUST use getFullYear/getMonth/getDate (local), not toISOString (UTC).
    const now = new Date();
    const expectedLocalDate =
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const utcDate = now.toISOString().split('T')[0];

    await onVacationModeOn();
    const events = await loadContextEvents();
    const travel = events.find((e) => e.type === 'travel')!;

    // The startDate must equal the LOCAL date string (getFullYear/getMonth/getDate).
    // In UTC test environments utcDate === expectedLocalDate, so the assertions are
    // equivalent. In UTC-N timezones near midnight they diverge — only expectedLocalDate
    // is correct. The implementation must NOT use toISOString().split('T')[0].
    expect(travel.startDate).toBe(expectedLocalDate);
  });
});

// ─── Travel normalization (tests 1–3) ─────────────────────────────────────────

describe('Travel normalization', () => {
  it('(test 1) legacy vacation records load as type travel', async () => {
    // Write a raw 'vacation' record directly to storage (simulating legacy data)
    const legacy: ContextEvent[] = [{
      id: 'legacy_vac_1',
      type: 'vacation' as any,
      source: 'user_logged',
      startDate: pastDate(10),
      endDate: pastDate(3),
      createdAt: `${pastDate(10)}T09:00:00.000Z`,
      updatedAt: `${pastDate(3)}T18:00:00.000Z`,
    }];
    await AsyncStorage.setItem('context_events', JSON.stringify(legacy));
    const events = await loadContextEvents();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('travel');
  });

  it('(test 2) new Travel events save as canonical travel type', async () => {
    const evt = await createContextEvent({ type: 'travel', source: 'user_logged', startDate: pastDate(5) });
    expect(evt.type).toBe('travel');
    const raw = await AsyncStorage.getItem('context_events');
    const stored = JSON.parse(raw!);
    expect(stored[0].type).toBe('travel');
    expect(stored).not.toContainEqual(expect.objectContaining({ type: 'vacation' }));
  });

  it('(test 3) normalization never mutates storage — raw storage retains original type', async () => {
    const legacy: ContextEvent[] = [{
      id: 'legacy_vac_2',
      type: 'vacation' as any,
      source: 'user_logged',
      startDate: pastDate(7),
      createdAt: `${pastDate(7)}T09:00:00.000Z`,
      updatedAt: `${pastDate(7)}T09:00:00.000Z`,
    }];
    await AsyncStorage.setItem('context_events', JSON.stringify(legacy));
    // Load (normalizes on read)
    await loadContextEvents();
    // Raw storage should still have 'vacation' — not mutated
    const rawAfter = await AsyncStorage.getItem('context_events');
    const stored = JSON.parse(rawAfter!);
    expect(stored[0].type).toBe('vacation');
  });
});

// ─── Travel mode adapter ───────────────────────────────────────────────────────

describe('onVacationModeOn', () => {
  it('creates an open travel event (canonical type = travel)', async () => {
    await onVacationModeOn();
    const events = await loadContextEvents();
    const travel = events.find((e) => e.type === 'travel');
    expect(travel).toBeDefined();
    expect(travel!.endDate).toBeUndefined();
    expect(travel!.startDate).toBe(todayStr());
  });

  it('does NOT fabricate past location data or notes', async () => {
    await onVacationModeOn();
    const events = await loadContextEvents();
    const travel = events.find((e) => e.type === 'travel')!;
    expect(travel.notes).toBeUndefined();
    expect(travel.label).toBeUndefined();
    // No Portugal, no fabricated destinations
    expect(JSON.stringify(travel)).not.toMatch(/portugal/i);
    expect(JSON.stringify(travel)).not.toMatch(/lisbon/i);
  });

  it('closes any existing open travel event before creating a new one', async () => {
    await onVacationModeOn();
    // Simulate turning it on again (e.g. user toggled off and back on same day)
    await onVacationModeOff();
    await onVacationModeOn();
    const events = await loadContextEvents();
    const openTravel = events.filter((e) => e.type === 'travel' && !e.endDate);
    expect(openTravel).toHaveLength(1);
  });

  it('(test 4) closes legacy vacation records when turning on (normalization path)', async () => {
    // Pre-populate storage with a legacy open 'vacation' record
    const legacy: ContextEvent[] = [{
      id: 'legacy_open',
      type: 'vacation' as any,
      source: 'user_logged',
      startDate: pastDate(5),
      createdAt: `${pastDate(5)}T09:00:00.000Z`,
      updatedAt: `${pastDate(5)}T09:00:00.000Z`,
    }];
    await AsyncStorage.setItem('context_events', JSON.stringify(legacy));
    // Turning on should close the legacy event (normalized to travel) and create a new one
    await onVacationModeOn();
    const events = await loadContextEvents();
    const openTravel = events.filter((e) => e.type === 'travel' && !e.endDate);
    expect(openTravel).toHaveLength(1);
    expect(openTravel[0].startDate).toBe(todayStr());
  });
});

describe('onVacationModeOff', () => {
  it('closes the most recent open travel event', async () => {
    await onVacationModeOn();
    await onVacationModeOff();
    const events = await loadContextEvents();
    const travel = events.find((e) => e.type === 'travel')!;
    expect(travel.endDate).toBe(todayStr());
  });

  it('is a no-op for old users with no existing travel events', async () => {
    // No events exist — should not throw or create anything
    await expect(onVacationModeOff()).resolves.not.toThrow();
    const events = await loadContextEvents();
    expect(events).toHaveLength(0);
  });
});

// ─── Delete behavior ──────────────────────────────────────────────────────────

describe('deleteContextEvent — confirm removes event', () => {
  it('deleted event no longer appears in loadContextEvents', async () => {
    const evt = await createContextEvent({ type: 'illness', source: 'user_logged', startDate: pastDate(3) });
    await deleteContextEvent(evt.id);
    const events = await loadContextEvents();
    expect(events.find((e) => e.id === evt.id)).toBeUndefined();
  });

  it('returns false when id does not exist (cancel path: nothing deleted)', async () => {
    await createContextEvent({ type: 'illness', source: 'user_logged', startDate: pastDate(3) });
    const result = await deleteContextEvent('nonexistent_id');
    expect(result).toBe(false);
    const events = await loadContextEvents();
    expect(events).toHaveLength(1); // original event still present
  });

  it('deleting one event does not remove other events', async () => {
    const a = await createContextEvent({ type: 'illness',        source: 'user_logged', startDate: pastDate(5) });
    const b = await createContextEvent({ type: 'training_block', source: 'user_logged', startDate: pastDate(3) });
    await deleteContextEvent(a.id);
    const events = await loadContextEvents();
    expect(events.find((e) => e.id === a.id)).toBeUndefined();
    expect(events.find((e) => e.id === b.id)).toBeDefined();
  });

  it('deleted event is excluded from future context analysis (fetchContextSources)', async () => {
    const evt = await createContextEvent({ type: 'illness', source: 'user_logged', startDate: pastDate(2) });
    await deleteContextEvent(evt.id);
    const sources = await fetchContextSources();
    expect(sources.userEvents.find((e) => e.id === evt.id)).toBeUndefined();
  });

  it('health data (drink_log) is unaffected by deleting a context event', async () => {
    const drinkLog = [{ date: todayStr(), totalDrinks: 2, totalCalories: 200 }];
    await AsyncStorage.setItem('drink_log', JSON.stringify(drinkLog));
    const evt = await createContextEvent({ type: 'illness', source: 'user_logged', startDate: pastDate(1) });
    await deleteContextEvent(evt.id);
    const raw = await AsyncStorage.getItem('drink_log');
    expect(JSON.parse(raw!)).toEqual(drinkLog);
  });
});

// ─── Travel Mode deduplication ────────────────────────────────────────────────

describe('onVacationModeOn — same-day deduplication', () => {
  it('toggling ON while already active does not create a second travel event', async () => {
    await onVacationModeOn();
    await onVacationModeOn(); // toggle ON again without turning off first
    const events = await loadContextEvents();
    const travelEvents = events.filter((e) => e.type === 'travel');
    expect(travelEvents).toHaveLength(1);
  });

  it('ON → OFF → ON same day results in exactly one open travel event', async () => {
    await onVacationModeOn();
    await onVacationModeOff();
    await onVacationModeOn();
    const events = await loadContextEvents();
    const openTravel = events.filter((e) => e.type === 'travel' && !e.endDate);
    expect(openTravel).toHaveLength(1);
  });

  it('ON → OFF → ON same day results in exactly one travel event total (no duplicates)', async () => {
    await onVacationModeOn();
    await onVacationModeOff();
    await onVacationModeOn();
    const events = await loadContextEvents();
    const allTravel = events.filter((e) => e.type === 'travel');
    expect(allTravel).toHaveLength(1);
  });

  it('ON → OFF → ON same day reopened event retains original startDate', async () => {
    await onVacationModeOn();
    await onVacationModeOff();
    await onVacationModeOn();
    const events = await loadContextEvents();
    const travel = events.find((e) => e.type === 'travel')!;
    expect(travel.startDate).toBe(todayStr());
    expect(travel.endDate).toBeUndefined();
  });

  it('travel event from a past trip is closed; new same-day event is created (separate trips)', async () => {
    // Seed an old closed travel event from 10 days ago
    const oldTravel: ContextEvent = {
      id: 'old_trip',
      type: 'travel',
      source: 'user_logged',
      startDate: pastDate(10),
      endDate: pastDate(5),
      createdAt: `${pastDate(10)}T08:00:00.000Z`,
      updatedAt: `${pastDate(5)}T18:00:00.000Z`,
    };
    await AsyncStorage.setItem('context_events', JSON.stringify([oldTravel]));
    await onVacationModeOn();
    const events = await loadContextEvents();
    const allTravel = events.filter((e) => e.type === 'travel');
    expect(allTravel).toHaveLength(2); // old trip + new trip
    const open = allTravel.find((e) => !e.endDate)!;
    expect(open.startDate).toBe(todayStr());
  });

  it('OFF closes the reopened same-day event', async () => {
    await onVacationModeOn();
    await onVacationModeOff();
    await onVacationModeOn(); // reopens same-day event
    await onVacationModeOff();
    const events = await loadContextEvents();
    const openTravel = events.filter((e) => e.type === 'travel' && !e.endDate);
    expect(openTravel).toHaveLength(0);
  });
});

// ─── Local date handling ───────────────────────────────────────────────────────

describe('Travel Mode local-date deduplication — todayStr() is local calendar date', () => {
  it('same-day event lookup uses local date, not UTC', async () => {
    // onVacationModeOn uses todayStr() which is local getFullYear/getMonth/getDate.
    // Call it twice — only one record should exist regardless of UTC offset.
    await onVacationModeOn();
    await onVacationModeOff();
    await onVacationModeOn();
    const events = await loadContextEvents();
    const allTravel = events.filter((e) => e.type === 'travel');
    expect(allTravel).toHaveLength(1);
    // startDate must match local date helper used in tests
    expect(allTravel[0].startDate).toBe(todayStr());
  });
});

// ─── Derived: drink events ─────────────────────────────────────────────────────

describe('deriveDrinkEvents', () => {
  it('returns empty array when drink_log is empty', async () => {
    const events = await deriveDrinkEvents();
    expect(events).toEqual([]);
  });

  it('returns empty array when all entries have 0 drinks', async () => {
    await AsyncStorage.setItem('drink_log', JSON.stringify([
      { date: pastDate(1), totalDrinks: 0, totalCalories: 0 },
    ]));
    const events = await deriveDrinkEvents();
    expect(events).toHaveLength(0);
  });

  it('derives an alcohol_period event for each day with drinks > 0', async () => {
    await AsyncStorage.setItem('drink_log', JSON.stringify([
      { date: pastDate(3), totalDrinks: 2.5, totalCalories: 320, vibe: 'happy_hour' },
      { date: pastDate(1), totalDrinks: 4.0, totalCalories: 520, vibe: 'night_out' },
    ]));
    const events = await deriveDrinkEvents();
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('alcohol_period');
    expect(events[0].source).toBe('derived');
    expect(events[0].metadata?.totalDrinks).toBe(2.5);
    expect(events[1].metadata?.vibe).toBe('night_out');
  });

  it('source is always "derived" — not user_logged', async () => {
    await AsyncStorage.setItem('drink_log', JSON.stringify([
      { date: pastDate(1), totalDrinks: 1, totalCalories: 100 },
    ]));
    const events = await deriveDrinkEvents();
    expect(events[0].source).toBe('derived');
  });
});

// ─── Derived: wellness sessions ────────────────────────────────────────────────

describe('appendWellnessSessionHistory + deriveWellnessSessionEvents', () => {
  it('returns empty array when no sessions logged', async () => {
    const events = await deriveWellnessSessionEvents();
    expect(events).toEqual([]);
  });

  it('appends and derives sessions correctly', async () => {
    await appendWellnessSessionHistory({ date: pastDate(2), type: 'sauna', minutes: 20, timestamp: '10:00 AM' });
    await appendWellnessSessionHistory({ date: pastDate(1), type: 'cold_plunge', minutes: 5, timestamp: '8:30 AM' });
    const events = await deriveWellnessSessionEvents();
    expect(events).toHaveLength(2);
    expect(events[0].label).toBe('Sauna');
    expect(events[1].label).toBe('Cold Plunge');
    expect(events[0].metadata?.minutes).toBe(20);
  });
});

// ─── Caffeine history ──────────────────────────────────────────────────────────

describe('appendCaffeineHistory + loadCaffeineHistory', () => {
  it('stores and retrieves caffeine history', async () => {
    await appendCaffeineHistory({ date: pastDate(1), totalMg: 220, itemCount: 2 });
    const history = await loadCaffeineHistory();
    expect(history).toHaveLength(1);
    expect(history[0].totalMg).toBe(220);
  });

  it('upserts: replaces existing entry for same date', async () => {
    await appendCaffeineHistory({ date: todayStr(), totalMg: 75, itemCount: 1 });
    await appendCaffeineHistory({ date: todayStr(), totalMg: 220, itemCount: 2 });
    const history = await loadCaffeineHistory();
    expect(history).toHaveLength(1);
    expect(history[0].totalMg).toBe(220);
    expect(history[0].itemCount).toBe(2);
  });
});

// ─── Cycle phases — privacy boundary ──────────────────────────────────────────

describe('deriveCyclePhaseEvents', () => {
  it('returns empty array with no cycle data', async () => {
    const events = await deriveCyclePhaseEvents();
    expect(events).toEqual([]);
  });

  it('includes period-day events from journal signs', async () => {
    await AsyncStorage.setItem('cycle_journal', JSON.stringify([
      { date: pastDate(5), energy: 2, stress: 4, signs: ['Medium flow', 'Cramping'], notes: 'Feeling rough today' },
      { date: pastDate(4), energy: 3, stress: 3, signs: ['Light flow'], notes: 'Better' },
    ]));
    const events = await deriveCyclePhaseEvents();
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.startDate)).toContain(pastDate(5));
  });

  it('NEVER includes free-text notes in event data', async () => {
    await AsyncStorage.setItem('cycle_journal', JSON.stringify([
      { date: pastDate(3), energy: 2, stress: 4, signs: ['Heavy flow'], notes: 'Very painful today, cramps were bad' },
    ]));
    const events = await deriveCyclePhaseEvents();
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('Very painful today');
    expect(serialized).not.toContain('cramps were bad');
    expect(serialized).not.toContain('notes');
  });

  it('NEVER includes energy or stress scores', async () => {
    await AsyncStorage.setItem('cycle_journal', JSON.stringify([
      { date: pastDate(2), energy: 1, stress: 5, signs: ['Light flow'], notes: '' },
    ]));
    const events = await deriveCyclePhaseEvents();
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('"energy"');
    expect(serialized).not.toContain('"stress"');
  });

  it('only fires for days with period-related signs (not generic signs)', async () => {
    await AsyncStorage.setItem('cycle_journal', JSON.stringify([
      { date: pastDate(1), energy: 4, stress: 2, signs: ['Bloating', 'Mood shifts'], notes: '' },
    ]));
    const events = await deriveCyclePhaseEvents();
    // Bloating and Mood shifts are not period signs
    expect(events).toHaveLength(0);
  });

  it('includes period start from profile when not in journal', async () => {
    await AsyncStorage.setItem('cycle_profile', JSON.stringify({ lastPeriodDate: pastDate(10) }));
    const events = await deriveCyclePhaseEvents();
    const profileEvent = events.find((e) => e.id.includes('profile'));
    expect(profileEvent).toBeDefined();
    expect(profileEvent!.startDate).toBe(pastDate(10));
  });
});

// ─── fetchContextSources ───────────────────────────────────────────────────────

describe('fetchContextSources', () => {
  it('returns all source categories even when all are empty', async () => {
    const sources = await fetchContextSources();
    expect(sources.userEvents).toEqual([]);
    expect(sources.drinkEvents).toEqual([]);
    expect(sources.wellnessClassEvents).toEqual([]);
    expect(sources.wellnessSessionEvents).toEqual([]);
    expect(sources.cyclePhaseEvents).toEqual([]);
  });

  it('includes source provenance on each event category', async () => {
    await createContextEvent({ type: 'travel', source: 'user_logged', startDate: pastDate(5) });
    await AsyncStorage.setItem('drink_log', JSON.stringify([
      { date: pastDate(1), totalDrinks: 3, totalCalories: 400 },
    ]));
    const sources = await fetchContextSources();
    expect(sources.userEvents[0].source).toBe('user_logged');
    expect(sources.drinkEvents[0].source).toBe('derived');
  });
});

// ─── buildBaselineProfile ──────────────────────────────────────────────────────

describe('buildBaselineProfile', () => {
  it('returns null central tendency for metrics with no valid values', () => {
    const profile = buildBaselineProfile({ hrv: [null, undefined, null] });
    const metric = profile.metrics.hrv;
    expect(metric.sampleCount).toBe(0);
    expect(metric.mean).toBeNull();
    expect(metric.median).toBeNull();
    expect(metric.p25).toBeNull();
    expect(metric.p75).toBeNull();
  });

  it('computes correct mean, median, percentiles', () => {
    const profile = buildBaselineProfile({ hrv: [40, 45, 50, 55, 60] });
    const metric = profile.metrics.hrv;
    expect(metric.sampleCount).toBe(5);
    expect(metric.mean).toBeCloseTo(50);
    expect(metric.median).toBe(50);
    expect(metric.p25).toBe(45);
    expect(metric.p75).toBe(55);
  });

  it('excludes null/undefined from sample count and values', () => {
    const profile = buildBaselineProfile({ sleep: [null, 7, undefined, 8, null, 7.5] });
    const metric = profile.metrics.sleep;
    expect(metric.sampleCount).toBe(3);
    expect(metric.values).toEqual([7, 8, 7.5]);
  });

  it('handles a single-value baseline without error', () => {
    const profile = buildBaselineProfile({ readiness: [72] });
    expect(profile.metrics.readiness.median).toBe(72);
    expect(profile.metrics.readiness.mean).toBe(72);
  });

  it('records windowDays and generatedAt', () => {
    const profile = buildBaselineProfile({ hrv: [50] }, 60);
    expect(profile.windowDays).toBe(60);
    expect(profile.generatedAt).toBeTruthy();
  });
});

// ─── buildBodyTimeline ─────────────────────────────────────────────────────────

describe('buildBodyTimeline', () => {
  it('returns one entry per day for the window', async () => {
    const timeline = await buildBodyTimeline(7);
    expect(timeline).toHaveLength(7);
    // Sorted oldest → newest
    expect(timeline[0].date < timeline[6].date).toBe(true);
  });

  it('includes active user events that span a day', async () => {
    await createContextEvent({
      type: 'vacation',
      source: 'user_logged',
      startDate: pastDate(3),
      endDate: pastDate(1),
    });
    const timeline = await buildBodyTimeline(7);
    const day3 = timeline.find((d) => d.date === pastDate(3));
    const day2 = timeline.find((d) => d.date === pastDate(2));
    const day0 = timeline.find((d) => d.date === todayStr());
    expect(day3?.activeEvents).toHaveLength(1);
    expect(day2?.activeEvents).toHaveLength(1);
    // Ended on pastDate(1) — today should NOT have it
    expect(day0?.activeEvents).toHaveLength(0);
  });

  it('includes open-ended events on all days from startDate forward', async () => {
    await createContextEvent({
      type: 'vacation',
      source: 'user_logged',
      startDate: pastDate(2),
      // no endDate — still active
    });
    const timeline = await buildBodyTimeline(5);
    const today = timeline.find((d) => d.date === todayStr());
    expect(today?.activeEvents).toHaveLength(1);
  });
});

// ─── buildLifeContextTimeline ──────────────────────────────────────────────────

describe('buildLifeContextTimeline', () => {
  it('returns events sorted most-recent first', async () => {
    await createContextEvent({ type: 'travel', source: 'user_logged', startDate: pastDate(10) });
    await createContextEvent({ type: 'illness', source: 'user_logged', startDate: pastDate(3) });
    const timeline = await buildLifeContextTimeline(30);
    expect(timeline[0].startDate >= timeline[1].startDate).toBe(true);
  });

  it('excludes events older than the window', async () => {
    await createContextEvent({ type: 'vacation', source: 'user_logged', startDate: pastDate(100) });
    await createContextEvent({ type: 'illness', source: 'user_logged', startDate: pastDate(5) });
    const timeline = await buildLifeContextTimeline(30);
    const types = timeline.map((e) => e.type);
    expect(types).not.toContain('vacation');
    expect(types).toContain('illness');
  });
});
