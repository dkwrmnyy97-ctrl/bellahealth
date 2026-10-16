/**
 * Synthetic data for DEMO_MODE.
 * All values are realistic but entirely fabricated — no real health data is used.
 * Shapes must match exactly what the real data loaders produce.
 */
import type { WorkoutSample } from '@/services/healthkit';
import type { OuraWeeklyDay } from '@/services/oura';
import type { ContextEvent } from '@/services/context-events';
import type { HealthDayRecord } from '@/services/pattern-engine';

// ─── Home screen ──────────────────────────────────────────────────────────────

export const DEMO_HEALTH = {
  sleep:   { hours: 7.2, score: 78, hrv: 52, readiness: 74, inBedHours: 7.8, restingHR: 58 },
  steps:   { count: 6843, goal: 10000 },
  macros:  { calories: 1240, protein: 78, carbs: 142, fat: 38, calGoal: 2000 },
  workout: { type: 'Pilates', duration: 45, calories: 198, done: true },
  water:   { oz: 40, goalOz: 80 },
  hadAlcoholLastNight: false,
};

export const DEMO_USER_NAME = 'Bella';

export const DEMO_WORKOUTS: WorkoutSample[] = [
  {
    activityName: 'Pilates',
    calories: 198,
    duration: 45,
    startDate: new Date('2026-09-02T07:00:00'),
    endDate:   new Date('2026-09-02T07:45:00'),
  },
];

export const DEMO_CYCLE_DAY = 14;

export const DEMO_SLEEP_GOAL_HRS = 8;

// ─── Trends screen (7-day) ────────────────────────────────────────────────────

export const DEMO_WEEKLY_DAYS: OuraWeeklyDay[] = [
  { date: '2026-08-27', dayLabel: 'Thu', sleepScore: 74, sleepHours: 6.8, hrv: 48, readiness: 71, steps: 9245,  activeCalories: 342 },
  { date: '2026-08-28', dayLabel: 'Fri', sleepScore: 82, sleepHours: 7.4, hrv: 55, readiness: 79, steps: 11320, activeCalories: 418 },
  { date: '2026-08-29', dayLabel: 'Sat', sleepScore: 69, sleepHours: 6.1, hrv: 43, readiness: 65, steps: 7890,  activeCalories: 285 },
  { date: '2026-08-30', dayLabel: 'Sun', sleepScore: 86, sleepHours: 7.9, hrv: 61, readiness: 84, steps: 12450, activeCalories: 486 },
  { date: '2026-08-31', dayLabel: 'Mon', sleepScore: 88, sleepHours: 8.1, hrv: 64, readiness: 87, steps: 8732,  activeCalories: 310 },
  { date: '2026-09-01', dayLabel: 'Tue', sleepScore: 71, sleepHours: 6.6, hrv: 46, readiness: 68, steps: 5210,  activeCalories: 198 },
  { date: '2026-09-02', dayLabel: 'Wed', sleepScore: 78, sleepHours: 7.2, hrv: 52, readiness: 74, steps: 6843,  activeCalories: 255 },
];

// Demo drink log — 0 drinks each day (clean week for portfolio)
export const DEMO_DRINKS_LOGGED: (number | null)[] = [0, 0, 0, 0, 0, 0, 0];

// ─── Context screen (30-day history) ─────────────────────────────────────────
// Sleep duration and readiness are intentionally correlated so the context
// engine can surface genuine EARLY/PATTERN tier findings from this data.

export const DEMO_CONTEXT_DAYS: OuraWeeklyDay[] = [
  { date: '2026-08-03', dayLabel: 'Mon', sleepScore: 82, sleepHours: 7.6, hrv: 54, readiness: 78, steps: 8420,  activeCalories: 310 },
  { date: '2026-08-04', dayLabel: 'Tue', sleepScore: 70, sleepHours: 6.2, hrv: 43, readiness: 65, steps: 6130,  activeCalories: 230 },
  { date: '2026-08-05', dayLabel: 'Wed', sleepScore: 75, sleepHours: 6.9, hrv: 48, readiness: 70, steps: 5200,  activeCalories: 195 },
  { date: '2026-08-06', dayLabel: 'Thu', sleepScore: 67, sleepHours: 6.0, hrv: 41, readiness: 63, steps: 4850,  activeCalories: 180 },
  { date: '2026-08-07', dayLabel: 'Fri', sleepScore: 60, sleepHours: 5.8, hrv: 38, readiness: 58, steps: 3920,  activeCalories: 155 },
  { date: '2026-08-08', dayLabel: 'Sat', sleepScore: 85, sleepHours: 8.0, hrv: 57, readiness: 81, steps: 11200, activeCalories: 420 },
  { date: '2026-08-09', dayLabel: 'Sun', sleepScore: 88, sleepHours: 8.3, hrv: 60, readiness: 85, steps: 13400, activeCalories: 490 },
  { date: '2026-08-10', dayLabel: 'Mon', sleepScore: 77, sleepHours: 7.1, hrv: 51, readiness: 73, steps: 7650,  activeCalories: 285 },
  { date: '2026-08-11', dayLabel: 'Tue', sleepScore: 80, sleepHours: 7.4, hrv: 53, readiness: 76, steps: 8900,  activeCalories: 320 },
  { date: '2026-08-12', dayLabel: 'Wed', sleepScore: 65, sleepHours: 6.1, hrv: 42, readiness: 62, steps: 5400,  activeCalories: 205 },
  { date: '2026-08-13', dayLabel: 'Thu', sleepScore: 84, sleepHours: 7.8, hrv: 56, readiness: 80, steps: 9800,  activeCalories: 365 },
  { date: '2026-08-14', dayLabel: 'Fri', sleepScore: 79, sleepHours: 7.3, hrv: 52, readiness: 75, steps: 8300,  activeCalories: 305 },
  { date: '2026-08-15', dayLabel: 'Sat', sleepScore: 90, sleepHours: 8.5, hrv: 63, readiness: 88, steps: 14200, activeCalories: 510 },
  { date: '2026-08-16', dayLabel: 'Sun', sleepScore: 86, sleepHours: 8.1, hrv: 59, readiness: 83, steps: 12100, activeCalories: 445 },
  { date: '2026-08-17', dayLabel: 'Mon', sleepScore: 72, sleepHours: 6.5, hrv: 45, readiness: 68, steps: 6400,  activeCalories: 240 },
  { date: '2026-08-18', dayLabel: 'Tue', sleepScore: 74, sleepHours: 6.8, hrv: 47, readiness: 70, steps: 7100,  activeCalories: 262 },
  { date: '2026-08-19', dayLabel: 'Wed', sleepScore: 83, sleepHours: 7.7, hrv: 55, readiness: 79, steps: 9500,  activeCalories: 350 },
  { date: '2026-08-20', dayLabel: 'Thu', sleepScore: 87, sleepHours: 8.2, hrv: 61, readiness: 84, steps: 11800, activeCalories: 430 },
  { date: '2026-08-21', dayLabel: 'Fri', sleepScore: 68, sleepHours: 6.3, hrv: 43, readiness: 64, steps: 5100,  activeCalories: 195 },
  { date: '2026-08-22', dayLabel: 'Sat', sleepScore: 76, sleepHours: 7.0, hrv: 50, readiness: 72, steps: 8000,  activeCalories: 295 },
  { date: '2026-08-23', dayLabel: 'Sun', sleepScore: 89, sleepHours: 8.4, hrv: 62, readiness: 86, steps: 13800, activeCalories: 498 },
  { date: '2026-08-24', dayLabel: 'Mon', sleepScore: 81, sleepHours: 7.5, hrv: 54, readiness: 77, steps: 8650,  activeCalories: 318 },
  { date: '2026-08-25', dayLabel: 'Tue', sleepScore: 71, sleepHours: 6.6, hrv: 46, readiness: 67, steps: 6200,  activeCalories: 235 },
  { date: '2026-08-26', dayLabel: 'Wed', sleepScore: 78, sleepHours: 7.2, hrv: 51, readiness: 74, steps: 7900,  activeCalories: 290 },
  { date: '2026-08-27', dayLabel: 'Thu', sleepScore: 74, sleepHours: 6.8, hrv: 48, readiness: 71, steps: 9245,  activeCalories: 342 },
  { date: '2026-08-28', dayLabel: 'Fri', sleepScore: 82, sleepHours: 7.4, hrv: 55, readiness: 79, steps: 11320, activeCalories: 418 },
  { date: '2026-08-29', dayLabel: 'Sat', sleepScore: 69, sleepHours: 6.1, hrv: 43, readiness: 65, steps: 7890,  activeCalories: 285 },
  { date: '2026-08-30', dayLabel: 'Sun', sleepScore: 86, sleepHours: 7.9, hrv: 61, readiness: 84, steps: 12450, activeCalories: 486 },
  { date: '2026-08-31', dayLabel: 'Mon', sleepScore: 88, sleepHours: 8.1, hrv: 64, readiness: 87, steps: 8732,  activeCalories: 310 },
  { date: '2026-09-01', dayLabel: 'Tue', sleepScore: 71, sleepHours: 6.6, hrv: 46, readiness: 68, steps: 5210,  activeCalories: 198 },
  { date: '2026-09-02', dayLabel: 'Wed', sleepScore: 78, sleepHours: 7.2, hrv: 52, readiness: 74, steps: 6843,  activeCalories: 255 },
];

// Demo lifestyle logs for the Context screen
// (drink events on a few days to give the pattern engine drinking data)
export const DEMO_CONTEXT_STORAGE_DAYS: HealthDayRecord[] = [
  { date: '2026-08-07', totalAlcoholDrinks: 3, caffeineMg: 200 },
  { date: '2026-08-14', totalAlcoholDrinks: 2, caffeineMg: 180 },
  { date: '2026-08-21', totalAlcoholDrinks: 4, caffeineMg: 220 },
  { date: '2026-08-28', totalAlcoholDrinks: 0, caffeineMg: 250, hasSaunaSession: true },
  { date: '2026-09-01', totalAlcoholDrinks: 0, caffeineMg: 300 },
  { date: '2026-09-02', totalAlcoholDrinks: 0, caffeineMg: 280 },
];

/**
 * Bundled narrative for the Explore/demo "Your Story" section.
 *
 * Bypasses the deterministic engine (which needs real user history) and shows
 * a handcrafted story that demonstrates BellaHealth's core differentiator:
 * surfacing multi-day patterns that aren't visible from any single day.
 *
 * The specific insight here — recovery speed tracked with when the first
 * full-length sleep followed, not with how far readiness fell — is
 * supported by all six readiness dips in DEMO_CONTEXT_DAYS:
 *
 *   08-07: readiness 58 → 08-08 sleep 8.0h → recovered in 1 night (→81)
 *   08-12: readiness 62 → 08-13 sleep 7.8h → recovered in 1 night (→80)
 *   08-17: readiness 68 → 08-18: 6.8h, 08-19: 7.7h → 2 nights (→79)
 *   08-21: readiness 64 → 08-22: 7.0h, 08-23: 8.4h → 2 nights (→86)
 *   08-25: readiness 67 → 08-26: 7.2h, 08-27: 6.8h, 08-28: 7.4h → 3 nights (→79)
 *   08-29: readiness 65 → 08-30 sleep 7.9h → recovered in 1 night (→84)
 *
 * No demo data modifications were needed — the pattern was already present.
 * Language follows BellaHealth style: observational, no medical causation.
 */
export const DEMO_EXPLORE_STORY =
  `Your readiness hit its lowest point of the month during the trip — and came back the fastest, bouncing over 20 points overnight.\n\nA shallower low a few weeks later, during the training block, took three nights to work through.\n\nWhat appeared to matter most wasn't how far readiness had fallen. It was how long sleep ran on the night immediately after. When it crossed roughly seven and a half hours right away, readiness was back the next morning. When it stayed in the six-to-seven-hour range for a few nights in a row, recovery stretched out to match.\n\nThe lowest point of the month recovered the fastest — because a full night of sleep happened to follow it directly.`;

// Demo ContextEvents — show the Life + Health timeline
export const DEMO_CONTEXT_EVENTS: ContextEvent[] = [
  {
    id: 'demo_vacation_1',
    type: 'travel',
    source: 'user_logged',
    startDate: '2026-08-04',
    endDate:   '2026-08-11',
    createdAt: '2026-08-04T09:00:00.000Z',
    updatedAt: '2026-08-11T18:00:00.000Z',
  },
  {
    id: 'demo_training_1',
    type: 'training_block',
    source: 'user_logged',
    label: 'Strength phase',
    startDate: '2026-08-20',
    createdAt: '2026-08-20T07:00:00.000Z',
    updatedAt: '2026-08-20T07:00:00.000Z',
  },
];
