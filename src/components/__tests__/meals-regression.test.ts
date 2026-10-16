/**
 * meals-regression.test.ts
 *
 * Regression tests for My Meals storage logic.
 *
 * Guards against:
 *   - Multiple entries per meal type not being preserved
 *   - Deleting one entry removing others of the same type
 *   - Backdated entries being stored with wrong date
 *   - Totals being calculated from wrong date scope
 *   - Duplicate entries appearing after a save
 *
 * These tests exercise the AsyncStorage layer that the MealsModal
 * component reads and writes directly.
 */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import AsyncStorage from '@react-native-async-storage/async-storage';

const MEAL_LOG_KEY = 'meal_log';

// Mirror the LoggedMeal shape from meals-modal.tsx
type LoggedMeal = {
  id: string;
  name: string;
  time: string;
  date: string;
  items: string;
  photoUri?: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  source?: 'photo_ai' | 'text_ai' | 'manual';
  consumedAt?: string;
};

// ─── Storage helpers (mirrors meals-modal.tsx private functions) ───────────────

async function loadMealsForDate(dateStr: string): Promise<LoggedMeal[]> {
  const raw = await AsyncStorage.getItem(MEAL_LOG_KEY);
  const all: LoggedMeal[] = raw ? JSON.parse(raw) : [];
  return all.filter((m) => m.date === dateStr);
}

async function saveMeal(meal: LoggedMeal, editingId?: string): Promise<void> {
  const raw = await AsyncStorage.getItem(MEAL_LOG_KEY);
  const all: LoggedMeal[] = raw ? JSON.parse(raw) : [];
  const filtered = editingId ? all.filter((m) => m.id !== editingId) : all;
  await AsyncStorage.setItem(MEAL_LOG_KEY, JSON.stringify([...filtered, meal]));
}

async function deleteMeal(id: string): Promise<void> {
  const raw = await AsyncStorage.getItem(MEAL_LOG_KEY);
  const all: LoggedMeal[] = raw ? JSON.parse(raw) : [];
  await AsyncStorage.setItem(MEAL_LOG_KEY, JSON.stringify(all.filter((m) => m.id !== id)));
}

function makeMeal(overrides: Partial<LoggedMeal> & { id: string; date: string; name: string }): LoggedMeal {
  return {
    time: '12:00 PM',
    items: 'test food',
    calories: 300,
    protein: 20,
    carbs: 30,
    fat: 10,
    source: 'text_ai',
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('Meals: multiple entries per meal type', () => {
  it('two Breakfast entries on the same date both persist', async () => {
    const date = '2026-09-30';
    await saveMeal(makeMeal({ id: 'b1', name: 'Breakfast', date, calories: 400 }));
    await saveMeal(makeMeal({ id: 'b2', name: 'Breakfast', date, calories: 350 }));

    const meals = await loadMealsForDate(date);
    const breakfasts = meals.filter((m) => m.name === 'Breakfast');
    expect(breakfasts).toHaveLength(2);
    expect(breakfasts.map((m) => m.id).sort()).toEqual(['b1', 'b2']);
  });

  it('two Snack entries on the same date both persist', async () => {
    const date = '2026-09-30';
    await saveMeal(makeMeal({ id: 's1', name: 'Snack', date, calories: 150 }));
    await saveMeal(makeMeal({ id: 's2', name: 'Snack', date, calories: 200 }));

    const meals = await loadMealsForDate(date);
    const snacks = meals.filter((m) => m.name === 'Snack');
    expect(snacks).toHaveLength(2);
  });

  it('meals of different types coexist on the same date', async () => {
    const date = '2026-09-30';
    await saveMeal(makeMeal({ id: 'b1', name: 'Breakfast', date }));
    await saveMeal(makeMeal({ id: 'l1', name: 'Lunch',     date }));
    await saveMeal(makeMeal({ id: 'd1', name: 'Dinner',    date }));
    await saveMeal(makeMeal({ id: 's1', name: 'Snack',     date }));

    const meals = await loadMealsForDate(date);
    expect(meals).toHaveLength(4);
    expect(new Set(meals.map((m) => m.name)).size).toBe(4);
  });
});

describe('Meals: delete individual entry', () => {
  it('deleting Snack #1 preserves Snack #2', async () => {
    const date = '2026-09-30';
    await saveMeal(makeMeal({ id: 's1', name: 'Snack', date, calories: 150 }));
    await saveMeal(makeMeal({ id: 's2', name: 'Snack', date, calories: 200 }));

    await deleteMeal('s1');

    const meals = await loadMealsForDate(date);
    const snacks = meals.filter((m) => m.name === 'Snack');
    expect(snacks).toHaveLength(1);
    expect(snacks[0].id).toBe('s2');
  });

  it('deleting one Breakfast preserves the other and all other meal types', async () => {
    const date = '2026-09-30';
    await saveMeal(makeMeal({ id: 'b1', name: 'Breakfast', date }));
    await saveMeal(makeMeal({ id: 'b2', name: 'Breakfast', date }));
    await saveMeal(makeMeal({ id: 'l1', name: 'Lunch',     date }));

    await deleteMeal('b1');

    const meals = await loadMealsForDate(date);
    const ids = meals.map((m) => m.id);
    expect(ids).not.toContain('b1');
    expect(ids).toContain('b2');
    expect(ids).toContain('l1');
  });
});

describe('Meals: backdated entries', () => {
  it('backdated meal is stored with the selected date, not today', async () => {
    const yesterday = '2026-09-29';
    const today     = '2026-09-30';
    await saveMeal(makeMeal({ id: 'y1', name: 'Breakfast', date: yesterday }));

    const todayMeals = await loadMealsForDate(today);
    const yestMeals  = await loadMealsForDate(yesterday);

    expect(todayMeals).toHaveLength(0);
    expect(yestMeals).toHaveLength(1);
    expect(yestMeals[0].id).toBe('y1');
  });

  it('meals from different dates do not bleed into each other', async () => {
    const d1 = '2026-09-28';
    const d2 = '2026-09-29';
    const d3 = '2026-09-30';
    await saveMeal(makeMeal({ id: 'm1', name: 'Breakfast', date: d1 }));
    await saveMeal(makeMeal({ id: 'm2', name: 'Lunch',     date: d2 }));
    await saveMeal(makeMeal({ id: 'm3', name: 'Dinner',    date: d3 }));

    expect(await loadMealsForDate(d1)).toHaveLength(1);
    expect(await loadMealsForDate(d2)).toHaveLength(1);
    expect(await loadMealsForDate(d3)).toHaveLength(1);
    expect((await loadMealsForDate(d1))[0].id).toBe('m1');
    expect((await loadMealsForDate(d2))[0].id).toBe('m2');
    expect((await loadMealsForDate(d3))[0].id).toBe('m3');
  });
});

describe('Meals: nutrition totals', () => {
  it('totals sum across all entries for the date', async () => {
    const date = '2026-09-30';
    await saveMeal(makeMeal({ id: 'm1', name: 'Breakfast', date, calories: 400, protein: 30, carbs: 40, fat: 15 }));
    await saveMeal(makeMeal({ id: 'm2', name: 'Lunch',     date, calories: 600, protein: 40, carbs: 60, fat: 20 }));
    await saveMeal(makeMeal({ id: 'm3', name: 'Snack',     date, calories: 200, protein: 10, carbs: 25, fat:  8 }));

    const meals = await loadMealsForDate(date);
    const totals = meals.reduce(
      (acc, m) => ({
        calories: acc.calories + m.calories,
        protein:  acc.protein  + m.protein,
        carbs:    acc.carbs    + m.carbs,
        fat:      acc.fat      + m.fat,
      }),
      { calories: 0, protein: 0, carbs: 0, fat: 0 },
    );
    expect(totals.calories).toBe(1200);
    expect(totals.protein).toBe(80);
    expect(totals.carbs).toBe(125);
    expect(totals.fat).toBe(43);
  });

  it('totals after deleting one entry exclude the deleted meal', async () => {
    const date = '2026-09-30';
    await saveMeal(makeMeal({ id: 's1', name: 'Snack', date, calories: 150 }));
    await saveMeal(makeMeal({ id: 's2', name: 'Snack', date, calories: 200 }));

    await deleteMeal('s1');

    const meals  = await loadMealsForDate(date);
    const cals   = meals.reduce((s, m) => s + m.calories, 0);
    expect(cals).toBe(200);
  });
});

describe('Meals: edit (no duplicate on save)', () => {
  it('editing a meal replaces the existing entry — no duplicate', async () => {
    const date = '2026-09-30';
    await saveMeal(makeMeal({ id: 'b1', name: 'Breakfast', date, calories: 300 }));

    // Simulate "edit": save with editingId set
    await saveMeal(makeMeal({ id: 'b1', name: 'Breakfast', date, calories: 450 }), 'b1');

    const meals = await loadMealsForDate(date);
    const breakfasts = meals.filter((m) => m.name === 'Breakfast');
    expect(breakfasts).toHaveLength(1);
    expect(breakfasts[0].calories).toBe(450);
  });
});

describe('Meals: fmtMacro — floating-point display formatting', () => {
  // Mirror fmtMacro from meals-modal.tsx and index.tsx (identical logic).
  function fmtMacro(g: number): string {
    return parseFloat(g.toFixed(1)).toString();
  }

  it('154.60000000000002 → "154.6" (JS float accumulation)', () => {
    expect(fmtMacro(154.60000000000002)).toBe('154.6');
  });

  it('105.10000000000001 → "105.1" (JS float accumulation)', () => {
    expect(fmtMacro(105.10000000000001)).toBe('105.1');
  });

  it('124.7 → "124.7" (clean value unchanged)', () => {
    expect(fmtMacro(124.7)).toBe('124.7');
  });

  it('120 → "120" (whole number — no trailing .0)', () => {
    expect(fmtMacro(120)).toBe('120');
  });

  it('0 → "0" (zero state)', () => {
    expect(fmtMacro(0)).toBe('0');
  });

  it('35.16 → "35.2" (rounds up when second decimal ≥ 5)', () => {
    expect(fmtMacro(35.16)).toBe('35.2');
  });

  it('running sum of three meal proteins stays ≤ 1 decimal place', () => {
    // Simulates the accumulation pattern from the home dashboard
    const meals = [
      { protein: 41.5, carbs: 51.5, fat: 35.0 },
      { protein: 41.7, carbs: 51.7, fat: 35.1 },
      { protein: 41.5, carbs: 51.4, fat: 35.0 },
    ];
    const totals = meals.reduce(
      (acc, m) => ({ protein: acc.protein + m.protein, carbs: acc.carbs + m.carbs, fat: acc.fat + m.fat }),
      { protein: 0, carbs: 0, fat: 0 },
    );
    // The raw sums may have float noise; fmtMacro cleans them for display
    expect(fmtMacro(totals.protein)).toMatch(/^\d+(\.\d)?$/);
    expect(fmtMacro(totals.carbs)).toMatch(/^\d+(\.\d)?$/);
    expect(fmtMacro(totals.fat)).toMatch(/^\d+(\.\d)?$/);
  });
});

describe('Meals: persistence across reload', () => {
  it('saved entries survive a fresh read of AsyncStorage', async () => {
    const date = '2026-09-30';
    await saveMeal(makeMeal({ id: 'p1', name: 'Dinner', date, items: 'salmon, rice', calories: 520 }));

    // Simulate app reload by reading from scratch
    const fresh = await loadMealsForDate(date);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].items).toBe('salmon, rice');
    expect(fresh[0].calories).toBe(520);
  });
});
