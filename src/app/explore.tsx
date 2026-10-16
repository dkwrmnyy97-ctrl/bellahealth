import { SymbolView } from 'expo-symbols';
import React, { useContext, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { Fonts, Spacing } from '@/constants/theme';
import { useAppTheme } from '@/context/theme-context';
import { getModalPalette, type ModalPalette } from '@/utils/modal-palette';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getOuraToken, loadOuraTrends, OuraWeeklyDay } from '@/services/oura';
import { getTodaySteps, getDailySteps, getDailyHRV, getHistoricalSleepHours, getWorkoutCountsForPeriods } from '@/services/healthkit';
import { trackEvent } from '@/services/analytics';
import { DEMO_MODE } from '@/config/demo';
import { DEMO_WEEKLY_DAYS, DEMO_DRINKS_LOGGED } from '@/demo/demo-data';
import { useExplore } from '@/context/explore-context';
import { localDateString } from '@/utils/local-date';

// ─── Extended palette for Trends screen ───────────────────────────────────────

type ExplorePalette = ModalPalette & {
  positive: string;
  nudge:    string;
  warning:  string;
};

const EXPLORE_FALLBACK: ExplorePalette = {
  background: '#FFFFFF', card: '#FFFFFF', text: '#111111', textSecondary: '#6B6B6B',
  divider: '#E4E4E4', shadow: 'rgba(0,0,0,0.10)', accent: '#111111', accentBtn: '#111111',
  plus: '#5A9058', minus: '#888888', viz: '#3A3A3A',
  positive: '#B8C9B0', nudge: '#A8C4D4', warning: '#E8B4B8',
};

const ExplorePaletteContext = React.createContext<ExplorePalette>(EXPLORE_FALLBACK);

// ─── Default empty week ───────────────────────────────────────────────────────

function emptyDays(n: number): OuraWeeklyDay[] {
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return Array.from({ length: n }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (n - 1 - i));
    return {
      date: localDateString(d),
      dayLabel: dayNames[d.getDay()],
      sleepScore: 0, sleepHours: 0, hrv: 0, readiness: 0, steps: 0, activeCalories: 0,
    };
  });
}

// ─── Insight engine ───────────────────────────────────────────────────────────

type RecLevel = 'positive' | 'nudge' | 'warning';
type Rec = {
  id: string;
  headline: string;
  detail: string;
  level: RecLevel;
  kind: 'observation' | 'recommend-push' | 'recommend-recover';
  source: string;
  icon?: string; // SF Symbol name
};

type Posture = 'recover' | 'build' | 'maintain' | 'mixed';

type PeriodHealthContext = {
  period: '1w' | '1m';
  avgSleep: number;
  avgScore: number;
  avgHrv: number;
  avgReadiness: number;
  avgSteps: number;
  hrvTrend: number;
  todayHrv: number;
  todayReadiness: number;
  stepGoalDays: number;
  drinksTotal: number;
  /** Number of days within the period that have a drink log entry (not just zero-logged). */
  daysWithDrinkLog: number;
  workoutCount: number;
  /** Number of days with valid (non-zero) Oura sleep data. */
  validSleepNights: number;
  hasData: boolean;
  posture: Posture;
  stepGoal: number;
  recoveryConstrained: boolean;
  /** Whether this user's own data shows a next-day recovery dip on drink days. */
  alcoholHasPattern: boolean;
  /** Which metrics actually showed the effect — only metrics present here are named in copy. */
  alcoholAffectedMetrics: string[];
};

/** Re-fetch Trends on focus once the last successful load is older than this. */
const TRENDS_REFRESH_MS = 5 * 60 * 1000;

function periodAvg(vals: number[]) {
  const nonZero = vals.filter(v => v > 0);
  return nonZero.length ? nonZero.reduce((a, b) => a + b, 0) / nonZero.length : 0;
}

/**
 * Compare next-day readiness, HRV, and sleep score on post-drink vs no-drink days.
 * Returns which metrics (if any) are meaningfully lower on post-drink days,
 * using the user's own data — never generic epidemiology.
 *
 * Thresholds are conservative to avoid false positives:
 *   readiness:  ≥3 point drop  (Oura readiness scale 0-100)
 *   hrv:        ≥2 ms drop     (meaningful vs. day-to-day noise)
 *   sleepScore: ≥3 point drop  (Oura sleep score 0-100)
 *
 * Requires at least MIN_DRINK_DAYS days with drinks AND valid next-day Oura data
 * before any pattern is reported. Fewer data points → case A (observational) copy.
 */
const MIN_DRINK_DAYS_FOR_PATTERN = 3;

function computeAlcoholRecoverySignal(
  days: OuraWeeklyDay[],
  drinksLogged: (number | null)[],
): { hasPattern: boolean; affectedMetrics: string[] } {
  const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

  const postDrink = { readiness: [] as number[], hrv: [] as number[], sleepScore: [] as number[] };
  const noDrink   = { readiness: [] as number[], hrv: [] as number[], sleepScore: [] as number[] };

  for (let i = 0; i < days.length - 1; i++) {
    const next = days[i + 1];
    const logged = drinksLogged[i];
    // Skip days where logging is absent — null means unlogged, not confirmed alcohol-free
    if (logged === null) continue;
    const bucket = logged > 0 ? postDrink : noDrink;
    if (next.readiness  > 0) bucket.readiness.push(next.readiness);
    if (next.hrv        > 0) bucket.hrv.push(next.hrv);
    if (next.sleepScore > 0) bucket.sleepScore.push(next.sleepScore);
  }

  if (postDrink.readiness.length < MIN_DRINK_DAYS_FOR_PATTERN) {
    return { hasPattern: false, affectedMetrics: [] };
  }

  const affectedMetrics: string[] = [];
  const pdRead = avg(postDrink.readiness);
  const ndRead = avg(noDrink.readiness);
  if (pdRead !== null && ndRead !== null && ndRead - pdRead >= 3) affectedMetrics.push('readiness');

  const pdHrv = avg(postDrink.hrv);
  const ndHrv = avg(noDrink.hrv);
  if (pdHrv !== null && ndHrv !== null && ndHrv - pdHrv >= 2)  affectedMetrics.push('HRV');

  const pdSleep = avg(postDrink.sleepScore);
  const ndSleep = avg(noDrink.sleepScore);
  if (pdSleep !== null && ndSleep !== null && ndSleep - pdSleep >= 3) affectedMetrics.push('sleep score');

  return { hasPattern: affectedMetrics.length > 0, affectedMetrics };
}

function buildPeriodContext(
  days: OuraWeeklyDay[],
  drinksLogged: (number | null)[],
  workoutCount: number,
  stepGoal: number,
  period: '1w' | '1m',
): PeriodHealthContext {
  const avgSleep     = periodAvg(days.map(d => d.sleepHours));
  const avgScore     = periodAvg(days.map(d => d.sleepScore));
  const avgHrv       = periodAvg(days.map(d => d.hrv));
  const avgReadiness = periodAvg(days.map(d => d.readiness));
  const avgSteps     = periodAvg(days.map(d => d.steps));
  const stepGoalDays = days.filter(d => d.steps >= stepGoal && d.steps > 0).length;
  // Only sum days where a log entry exists (null = unlogged, not zero)
  const drinksTotal  = drinksLogged.reduce<number>((a, b) => a + (b ?? 0), 0);
  const daysWithDrinkLog = drinksLogged.filter(v => v !== null).length;
  const validSleepNights = days.filter(d => d.sleepHours > 0).length;
  const todayHrv       = days[days.length - 1]?.hrv ?? 0;
  const todayReadiness = days[days.length - 1]?.readiness ?? 0;

  const hrvValid = days.map(d => d.hrv).filter(v => v > 0);
  const thirdLen = Math.ceil(hrvValid.length / 3);
  const hrvTrend = hrvValid.length >= 4
    ? periodAvg(hrvValid.slice(-thirdLen)) - periodAvg(hrvValid.slice(0, thirdLen))
    : 0;

  const hasData = avgScore > 0 || avgSteps > 0;

  // Posture signals
  const drinkThresh = period === '1w' ? 5 : 18;
  let recoverSignals = 0;
  let buildSignals   = 0;
  if (avgSleep > 0 && avgSleep < 6.5)          recoverSignals++;
  if (avgHrv > 0 && hrvTrend < -5)             recoverSignals++;
  if (avgReadiness > 0 && avgReadiness < 62)   recoverSignals++;
  if (drinksTotal > drinkThresh)               recoverSignals++;
  if (avgSleep >= 7.5)                         buildSignals++;
  if (avgHrv > 0 && hrvTrend > 3)             buildSignals++;
  if (avgReadiness >= 78)                      buildSignals++;
  if (avgSteps >= stepGoal && avgSteps > 0)   buildSignals++;

  let posture: Posture;
  if (recoverSignals >= 2 && buildSignals === 0)      posture = 'recover';
  else if (buildSignals >= 3 && recoverSignals === 0) posture = 'build';
  else if (recoverSignals > 0 && buildSignals > 0)    posture = 'mixed';
  else posture = 'maintain';

  const recoveryConstrained = todayReadiness > 0 && todayReadiness < 65;
  const { hasPattern: alcoholHasPattern, affectedMetrics: alcoholAffectedMetrics } =
    computeAlcoholRecoverySignal(days, drinksLogged);

  return {
    period, avgSleep, avgScore, avgHrv, avgReadiness, avgSteps,
    hrvTrend, todayHrv, todayReadiness, stepGoalDays, drinksTotal,
    daysWithDrinkLog, workoutCount, validSleepNights, hasData, posture,
    stepGoal, recoveryConstrained, alcoholHasPattern, alcoholAffectedMetrics,
  };
}

function buildInsights(ctx: PeriodHealthContext): Rec[] {
  const { period, avgSleep, avgScore, avgHrv, avgReadiness, avgSteps,
          hrvTrend, todayHrv, todayReadiness, stepGoalDays, drinksTotal,
          daysWithDrinkLog, workoutCount, validSleepNights, hasData, posture,
          stepGoal, recoveryConstrained, alcoholHasPattern, alcoholAffectedMetrics } = ctx;

  if (!hasData) {
    return [{ id: 'no_data', kind: 'observation', level: 'nudge',
      headline: 'Syncing your health data…',
      detail: 'Your insights will appear here once data loads. Make sure your Oura Ring is connected in Profile and Apple Health access is granted.',
      source: 'BellaHealth', icon: 'wifi.slash' }];
  }

  const candidates: Rec[] = [];

  // ── Sleep ──────────────────────────────────────────────────────────────────
  // Minimum nights required before drawing conclusions about the period average.
  const sleepNightsThresh = period === '1w' ? 4 : 18;
  const sleepCoverageNote = validSleepNights < sleepNightsThresh
    ? ` (${validSleepNights}/${period === '1w' ? 7 : 30} nights recorded)`
    : '';

  if (avgSleep > 0) {
    if (avgSleep < 6.5) {
      // Only flag as a warning when there's enough coverage to trust the average.
      const level = validSleepNights >= sleepNightsThresh ? 'warning' : 'nudge';
      const coverageSuffix = sleepCoverageNote
        ? ` Note: only ${validSleepNights} nights recorded — average may shift as more data syncs.`
        : '';
      candidates.push({ id: 'sleep_low', kind: 'observation', level,
        headline: 'Sleep is your biggest lever right now',
        detail: `You've averaged ${avgSleep.toFixed(1)} hrs ${period === '1w' ? 'this week' : 'this month'}${sleepCoverageNote}. Most recovery — HRV, muscle repair, metabolism — happens during sleep. Even 30 more minutes will show up in your scores within a few days.${coverageSuffix}`,
        source: 'Oura Sleep', icon: 'moon.zzz' });
    } else if (avgSleep < 7.0) {
      candidates.push({ id: 'sleep_low_moderate', kind: 'observation', level: 'nudge',
        headline: `Sleep averaging ${avgSleep.toFixed(1)} hrs — room to grow`,
        detail: `You're close to the 7-hour threshold where recovery meaningfully improves. A consistent 20-minute earlier bedtime ${period === '1w' ? 'this week' : 'over the next few weeks'} adds up fast.`,
        source: 'Oura Sleep', icon: 'moon.zzz' });
    } else if (avgSleep >= 7.5) {
      candidates.push({ id: 'sleep_great', kind: 'observation', level: 'positive',
        headline: `Sleep excellent — ${avgSleep.toFixed(1)} hrs average`,
        detail: `Sleep score ${Math.round(avgScore)} ${period === '1w' ? 'this week' : 'this month'}. You're in peak recovery mode. This is the foundation everything else builds on.`,
        source: 'Oura Sleep', icon: 'moon.stars' });
    }
  }

  // ── HRV ───────────────────────────────────────────────────────────────────
  if (avgHrv > 0) {
    if (period === '1w') {
      if (hrvTrend < -5) {
        candidates.push({ id: 'hrv_down', kind: 'recommend-recover', level: 'warning',
          headline: 'HRV trending down — time to recover',
          detail: `HRV has dropped ${Math.abs(hrvTrend).toFixed(0)} ms this week. Your body is signaling stress or under-recovery. Prioritize sleep, dial back intensity, and cut alcohol.`,
          source: 'Oura HRV', icon: 'waveform.path.ecg' });
      } else if (posture !== 'recover' && todayHrv > 50) {
        if (!recoveryConstrained) {
          // HRV strong AND today's readiness is not constrained: can recommend pushing
          candidates.push({ id: 'hrv_high', kind: 'recommend-push', level: 'positive',
            headline: `HRV strong at ${todayHrv} ms — body is ready`,
            detail: `With readiness at ${todayReadiness}, your recovery is dialed in. A great day to push in cardio or strength — go harder than usual.`,
            source: 'Oura HRV', icon: 'heart' });
        } else {
          // HRV strong but readiness is low: observe the positive signal, don't prescribe intensity
          candidates.push({ id: 'hrv_strong', kind: 'observation', level: 'positive',
            headline: `HRV strong at ${todayHrv} ms — recovery holding up`,
            detail: `Your nervous system is recovering well. With lower readiness today, this is a positive signal — prioritize rest to let both metrics align.`,
            source: 'Oura HRV', icon: 'heart' });
        }
      }
    } else {
      if (hrvTrend < -6) {
        candidates.push({ id: 'hrv_down', kind: 'recommend-recover', level: 'warning',
          headline: `HRV declined ${Math.abs(Math.round(hrvTrend))} ms this month`,
          detail: `A sustained HRV decline signals overtraining, chronic stress, or compounding poor sleep. Prioritize recovery: sleep, hydration, and 2 rest days per week minimum.`,
          source: 'Oura HRV', icon: 'waveform.path.ecg' });
      } else if (hrvTrend > 4) {
        candidates.push({ id: 'hrv_up', kind: 'observation', level: 'positive',
          headline: `HRV up ${Math.round(hrvTrend)} ms over 30 days — real fitness progress`,
          detail: `One of the strongest signals of genuine adaptation. Your recovery capacity has grown — your training and habits are working.`,
          source: 'Oura HRV', icon: 'heart' });
      } else if (avgHrv >= 45) {
        candidates.push({ id: 'hrv_solid', kind: 'observation', level: 'positive',
          headline: `HRV averaging ${Math.round(avgHrv)} ms — solid recovery all month`,
          detail: `Consistent HRV means your nervous system has been recovering well. Keep the habits that got you here.`,
          source: 'Oura HRV', icon: 'heart' });
      } else if (avgHrv < 40) {
        candidates.push({ id: 'hrv_moderate', kind: 'observation', level: 'nudge',
          headline: `HRV averaging ${Math.round(avgHrv)} ms — recovery has room to grow`,
          detail: `Lower HRV often reflects sleep debt, high stress, or insufficient recovery time. Consistent sleep timing and reducing late-night stress moves the needle.`,
          source: 'Oura HRV', icon: 'waveform.path.ecg' });
      }
    }
  }

  // ── Steps ─────────────────────────────────────────────────────────────────
  if (avgSteps > 0) {
    const goalDaysThresh = period === '1w' ? 5 : 20;
    const halfThresh     = period === '1w' ? 3 : 12;
    if (stepGoalDays >= goalDaysThresh) {
      candidates.push({ id: 'steps_great', kind: 'observation', level: 'positive',
        headline: `Step goal hit ${stepGoalDays}/${period === '1w' ? 7 : 30} days — keep the streak`,
        detail: `Averaging ${Math.round(avgSteps).toLocaleString()} steps/day. Consistent daily movement is one of the highest-impact habits for longevity.`,
        source: 'Oura + Apple Health', icon: 'figure.walk' });
    } else if (avgSteps < 6000) {
      candidates.push({ id: 'steps_low', kind: 'observation', level: 'nudge',
        headline: `Movement low — ${Math.round(avgSteps).toLocaleString()} steps/day`,
        detail: `Even a 15-minute walk after meals adds ~3,000 steps. Small increases in daily movement have outsized benefits for metabolism, mood, and longevity.`,
        source: 'Oura + Apple Health', icon: 'figure.walk' });
    } else if (stepGoalDays >= halfThresh) {
      candidates.push({ id: 'steps_midway', kind: 'observation', level: 'nudge',
        headline: `Steps building — ${Math.round(avgSteps).toLocaleString()}/day`,
        detail: `You're hitting your goal about half the time. One more consistent walk${period === '1w' ? ' this week' : ' daily'} would push you over more often.`,
        source: 'Oura + Apple Health', icon: 'figure.walk' });
    }
  }

  // ── Readiness ─────────────────────────────────────────────────────────────
  if (period === '1w') {
    if (posture !== 'recover' && todayReadiness >= 80) {
      candidates.push({ id: 'readiness_high', kind: 'recommend-push', level: 'positive',
        headline: `Readiness ${todayReadiness} — primed to push today`,
        detail: 'Recovery metrics are strong. Add intensity — increase resistance, duration, or pace.',
        source: 'Oura Readiness', icon: 'bolt' });
    } else if (todayReadiness > 0 && todayReadiness < 65) {
      candidates.push({ id: 'readiness_low', kind: 'recommend-recover', level: 'nudge',
        headline: `Low readiness (${todayReadiness}) — keep it light today`,
        detail: 'Your body needs recovery more than intensity right now. A walk, yoga, or rest day will serve you better than a hard session.',
        source: 'Oura Readiness', icon: 'bolt.slash' });
    }
  } else {
    if (avgReadiness >= 78) {
      candidates.push({ id: 'readiness_great', kind: 'observation', level: 'positive',
        headline: `Excellent readiness month — avg ${Math.round(avgReadiness)}`,
        detail: `Sustained high readiness means your body has been consistently recovering. Your training-recovery balance is working.`,
        source: 'Oura Readiness', icon: 'bolt' });
    } else if (avgReadiness > 0 && avgReadiness < 65) {
      candidates.push({ id: 'readiness_low', kind: 'recommend-recover', level: 'nudge',
        headline: `Readiness averaged ${Math.round(avgReadiness)} this month — recovery gap`,
        detail: `Low readiness over a full month means your body hasn't been getting enough recovery. More sleep and rest days will reset this.`,
        source: 'Oura Readiness', icon: 'bolt.slash' });
    }
  }

  // ── Workout count (HealthKit) ─────────────────────────────────────────────
  // Note: HealthKit workout records include Oura-auto-detected walks and passive
  // movement — not just intentional training sessions. Copy avoids claiming
  // intentional workouts; uses "activity sessions" to reflect the actual signal.
  if (period === '1w') {
    if (workoutCount >= 4) {
      candidates.push({ id: 'workout_consistent', kind: 'observation', level: 'positive',
        headline: `${workoutCount} activity sessions this week`,
        detail: `Consistent movement frequency — including Apple Health auto-detected sessions — adds up. If you're doing structured training, keep it up; if not, consider adding intentional cardio or strength work.`,
        source: 'Apple Health', icon: 'flame' });
    } else if (workoutCount === 0) {
      candidates.push({ id: 'workout_zero', kind: 'observation', level: 'nudge',
        headline: 'No activity sessions recorded this week',
        detail: `Even two structured sessions — cardio + strength — keeps your fitness from sliding. Your steps help, but intentional training builds what walking can't.`,
        source: 'Apple Health', icon: 'flame' });
    }
  } else {
    if (workoutCount >= 14) {
      candidates.push({ id: 'workout_great', kind: 'observation', level: 'positive',
        headline: `${workoutCount} activity sessions this month`,
        detail: `That's an average of 3–4 sessions per week. Sustained movement frequency compounds into real adaptation over time.`,
        source: 'Apple Health', icon: 'flame' });
    } else if (workoutCount > 0 && workoutCount < 6) {
      candidates.push({ id: 'workout_low', kind: 'observation', level: 'nudge',
        headline: `${workoutCount} activity sessions this month — frequency has room to grow`,
        detail: `Aim for 3 structured sessions per week as a minimum for cardiovascular and strength adaptation. Even 2 intentional sessions beats zero.`,
        source: 'Apple Health', icon: 'flame' });
    }
  }

  // ── Alcohol ───────────────────────────────────────────────────────────────
  const drinkWarnThresh = period === '1w' ? 6 : 20;
  if (drinksTotal >= drinkWarnThresh) {
    // Build detail copy based on whether this user's own data shows a pattern.
    // Case A: no established personal signal → observational, forward-looking.
    // Case B: user's data shows post-drink recovery dip → describe what their data shows,
    //         naming only the metrics that actually reflect it.
    let alcoholDetail: string;
    if (alcoholHasPattern && alcoholAffectedMetrics.length > 0) {
      const metricList = alcoholAffectedMetrics.length === 1
        ? alcoholAffectedMetrics[0]
        : alcoholAffectedMetrics.length === 2
          ? `${alcoholAffectedMetrics[0]} and ${alcoholAffectedMetrics[1]}`
          : `${alcoholAffectedMetrics.slice(0, -1).join(', ')}, and ${alcoholAffectedMetrics[alcoholAffectedMetrics.length - 1]}`;
      const verb = alcoholAffectedMetrics.length === 1 ? 'has' : 'have';
      alcoholDetail = `On days following alcohol, your ${metricList} ${verb} tended to run lower than your usual range. We'll keep watching whether that holds.`;
    } else {
      alcoholDetail = `Alcohol has been higher than your recent baseline. We'll watch how your recovery responds over the coming days.`;
    }
    candidates.push({ id: 'drinking_high', kind: 'observation', level: 'warning',
      headline: `Alcohol elevated — ${Math.round(drinksTotal * 10) / 10} drinks ${period === '1w' ? 'this week' : 'this month'}`,
      detail: alcoholDetail,
      source: 'BellaHealth', icon: 'drop' });
  } else if (drinksTotal === 0 && daysWithDrinkLog > 0 && avgScore >= 78) {
    const totalDays = period === '1w' ? 7 : 30;
    const minLoggedThresh = period === '1w' ? 4 : 18;
    if (daysWithDrinkLog === totalDays) {
      // Every day in the period is logged and shows zero drinks.
      // Only now can we make a full-period "alcohol-free" claim.
      candidates.push({ id: 'alcohol_free', kind: 'observation', level: 'positive',
        headline: `Alcohol-free ${period === '1m' ? 'this month' : 'this week'}`,
        detail: `No drinks on any of your ${totalDays} logged days. Recovery metrics look solid.`,
        source: 'BellaHealth', icon: 'drop' });
    } else if (daysWithDrinkLog >= minLoggedThresh) {
      // Partial coverage: scope the claim strictly to the days actually logged.
      // Days without a log entry are unknown — not assumed zero.
      const unlogged = totalDays - daysWithDrinkLog;
      candidates.push({ id: 'alcohol_free_partial', kind: 'observation', level: 'positive',
        headline: `No alcohol on your ${daysWithDrinkLog} logged days this ${period === '1m' ? 'month' : 'week'}`,
        detail: `${unlogged} day${unlogged !== 1 ? 's' : ''} without a log entry — those remain unknown.`,
        source: 'BellaHealth', icon: 'drop' });
    }
    // Fewer than minLoggedThresh logged days: no insight (evidence too sparse).
  }

  // ── Cross-metric insight ───────────────────────────────────────────────────
  if (avgSleep > 0 && avgSleep < 7 && avgHrv > 50 && posture !== 'recover') {
    candidates.push({ id: 'hrv_resilient', kind: 'observation', level: 'positive',
      headline: 'HRV resilient despite some sleep debt',
      detail: `HRV at ${Math.round(avgHrv)} ms with only ${avgSleep.toFixed(1)} hrs average sleep. Your baseline fitness is carrying you — improving sleep will push HRV higher still.`,
      source: 'Oura', icon: 'sparkles' });
  }

  // ── Posture-aware filtering: suppress "push harder" in recover posture ─────
  const suppressInRecover = new Set(['hrv_high', 'readiness_high', 'workout_consistent']);
  let filtered = posture === 'recover'
    ? candidates.filter(r => !suppressInRecover.has(r.id))
    : candidates;

  // ── Cross-signal consistency: no "push harder" recommendations when any
  //    "recover" recommendation is present. Observations are never suppressed.
  const hasRecoverRec = filtered.some(r => r.kind === 'recommend-recover');
  if (hasRecoverRec) {
    filtered = filtered.filter(r => r.kind !== 'recommend-push');
  }

  // Rank: warnings → nudges → positives; cap at 4
  const warnings  = filtered.filter(r => r.level === 'warning');
  const nudges    = filtered.filter(r => r.level === 'nudge');
  const positives = filtered.filter(r => r.level === 'positive');
  return [...warnings, ...nudges, ...positives].slice(0, 4);
}

// ─── Chart components ─────────────────────────────────────────────────────────

function MiniBarChart({
  data,
  dayLabels,
  color,
  goal,
  formatValue,
  compact,
}: {
  data: number[];
  dayLabels: string[];
  color: string;
  goal?: number;
  formatValue?: (v: number) => string;
  compact?: boolean;
}) {
  const pal = useContext(ExplorePaletteContext);
  const max = goal ? Math.max(...data, goal) : Math.max(...data, 1);
  const today = data.length - 1;
  const maxLabel = formatValue ? formatValue(max) : String(Math.round(max));
  const midLabel = formatValue ? formatValue(Math.round(max / 2)) : String(Math.round(max / 2));

  return (
    <View style={chartStyles.container}>
      <View style={chartStyles.yAxis}>
        <ThemedText style={[chartStyles.yLabel, { color: pal.textSecondary }]}>{maxLabel}</ThemedText>
        <ThemedText style={[chartStyles.yLabel, { color: pal.textSecondary }]}>{midLabel}</ThemedText>
        <ThemedText style={[chartStyles.yLabel, { color: pal.textSecondary }]}>0</ThemedText>
      </View>
      <View style={chartStyles.barsRow}>
        {data.map((val, i) => {
          const height = Math.max((val / max) * 80, 4);
          const isToday = i === today;
          const barColor = val > 0 ? color : (pal.divider ?? '#E8E0E0');
          return (
            <View key={i} style={chartStyles.barCol}>
              <View style={chartStyles.barTrack}>
                <View style={[chartStyles.bar, { height, backgroundColor: barColor }]} />
              </View>
              {!compact && (
                <ThemedText style={[chartStyles.valueLabel, { color: isToday ? color : pal.textSecondary }]}>
                  {val > 0 && formatValue ? formatValue(val) : ' '}
                </ThemedText>
              )}
              <ThemedText style={[chartStyles.dayLabel, { color: isToday ? pal.text : pal.textSecondary },
                isToday && { fontWeight: '600' }]}>
                {dayLabels[i]}
              </ThemedText>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const chartStyles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingTop: Spacing.two,
  },
  yAxis: {
    width: 36,
    height: 80,
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    paddingRight: 6,
  },
  yLabel: {
    fontSize: 9,
    letterSpacing: 0.3,
  },
  barsRow: {
    flex: 1,
    flexDirection: 'row',
    gap: 3,
  },
  barCol: {
    flex: 1,
    alignItems: 'center',
  },
  barTrack: {
    height: 80,
    width: '100%',
    justifyContent: 'flex-end',
  },
  bar: {
    width: '100%',
    borderRadius: 2,
    minHeight: 4,
  },
  valueLabel: {
    fontSize: 9,
    marginTop: 4,
  },
  dayLabel: {
    fontSize: 10,
    marginTop: 2,
  },
});

// ─── Line chart (1M view) ─────────────────────────────────────────────────────

function LineChart({
  data,
  dayLabels,
  color,
  formatValue,
}: {
  data: number[];
  dayLabels: string[];
  color: string;
  formatValue?: (v: number) => string;
}) {
  const pal = useContext(ExplorePaletteContext);
  const [w, setW] = React.useState(0);
  const H = 90;
  const nonZero = data.filter(v => v > 0);
  const max = nonZero.length > 0 ? Math.max(...nonZero) : 1;
  const n = data.length;

  const maxLabel = formatValue ? formatValue(max) : String(Math.round(max));
  const midLabel = formatValue ? formatValue(Math.round(max / 2)) : String(Math.round(max / 2));

  const pts = data.map((val, i) => ({
    x: n > 1 ? (i / (n - 1)) * w : w / 2,
    y: val > 0 ? H - (val / max) * H : null as number | null,
    label: dayLabels[i],
  }));

  type Seg = { cx: number; cy: number; len: number; angle: number };
  const segs: Seg[] = w > 0 ? pts.reduce<Seg[]>((acc, pt, i) => {
    if (i === 0 || pts[i - 1].y === null || pt.y === null) return acc;
    const prev = pts[i - 1];
    const dx = pt.x - prev.x;
    const dy = (pt.y as number) - (prev.y as number);
    const len = Math.sqrt(dx * dx + dy * dy);
    acc.push({
      cx: (prev.x + pt.x) / 2,
      cy: ((prev.y as number) + (pt.y as number)) / 2,
      len,
      angle: Math.atan2(dy, dx) * 180 / Math.PI,
    });
    return acc;
  }, []) : [];

  return (
    <View style={lineStyles.wrapper}>
      <View style={lineStyles.yAxis}>
        <ThemedText style={[lineStyles.yLabel, { color: pal.textSecondary }]}>{maxLabel}</ThemedText>
        <ThemedText style={[lineStyles.yLabel, { color: pal.textSecondary }]}>{midLabel}</ThemedText>
        <ThemedText style={[lineStyles.yLabel, { color: pal.textSecondary }]}>0</ThemedText>
      </View>
      <View style={{ flex: 1 }}>
        <View style={{ height: H }} onLayout={e => setW(e.nativeEvent.layout.width)}>
          {segs.map((s, i) => (
            <View key={i} style={{
              position: 'absolute',
              left: s.cx - s.len / 2,
              top: s.cy - 1,
              width: s.len,
              height: 2,
              borderRadius: 1,
              backgroundColor: color,
              transform: [{ rotate: `${s.angle}deg` }],
            }} />
          ))}
          {w > 0 && pts.map((pt, i) => pt.y !== null ? (
            <View key={i} style={{
              position: 'absolute',
              left: pt.x - 3,
              top: (pt.y as number) - 3,
              width: 6, height: 6, borderRadius: 3,
              backgroundColor: color,
            }} />
          ) : null)}
        </View>
        <View style={{ height: 28, position: 'relative' }}>
          {w > 0 && pts.map((pt, i) => pt.label ? (
            <ThemedText key={i} style={{
              position: 'absolute',
              left: pt.x - 16,
              top: 4,
              width: 32,
              fontSize: 9,
              textAlign: 'center',
              color: pal.textSecondary,
            }}>
              {pt.label}
            </ThemedText>
          ) : null)}
        </View>
      </View>
    </View>
  );
}

const lineStyles = StyleSheet.create({
  wrapper: { flexDirection: 'row', paddingTop: Spacing.two },
  yAxis: { width: 36, height: 90, justifyContent: 'space-between', alignItems: 'flex-end', paddingRight: 6 },
  yLabel: { fontSize: 9, letterSpacing: 0.3 },
});

// ─── Chart section (flat, no card) ────────────────────────────────────────────

function ChartSection({
  label, aside, children,
}: {
  label: string; aside?: string; children: React.ReactNode;
}) {
  const pal = useContext(ExplorePaletteContext);
  return (
    <View style={styles.chartSection}>
      <View style={[styles.rule, { backgroundColor: pal.divider }]} />
      <View style={styles.chartHeader}>
        <ThemedText style={[styles.sectionLabel, { color: pal.textSecondary }]}>{label}</ThemedText>
        {aside !== undefined && (
          <ThemedText style={[styles.sectionAside, { color: pal.textSecondary }]}>{aside}</ThemedText>
        )}
      </View>
      {children}
    </View>
  );
}

// ─── Recommendation entry (flat, editorial) ───────────────────────────────────

function RecEntry({ rec }: { rec: Rec }) {
  const pal = useContext(ExplorePaletteContext);
  const dotColor = rec.level === 'positive' ? pal.positive : rec.level === 'nudge' ? pal.nudge : pal.warning;
  return (
    <View style={[styles.recEntry, { borderTopColor: pal.divider }]}>
      {rec.icon ? (
        <View style={[styles.recIconWrap, { backgroundColor: dotColor + '33' }]}>
          <SymbolView name={rec.icon as any} size={13} tintColor={dotColor} weight="thin" type="monochrome" />
        </View>
      ) : (
        <View style={[styles.recDot, { backgroundColor: dotColor }]} />
      )}
      <View style={styles.recContent}>
        <ThemedText style={[styles.recHeadline, { color: pal.text }]}>{rec.headline}</ThemedText>
        <ThemedText style={[styles.recDetail, { color: pal.textSecondary }]}>{rec.detail}</ThemedText>
        <ThemedText style={[styles.recSource, { color: pal.textSecondary }]}>{rec.source}</ThemedText>
      </View>
    </View>
  );
}

// ─── Talk more CTA ───────────────────────────────────────────────────────────

function TalkMoreCTA({ onPress }: { onPress: () => void }) {
  const pal = useContext(ExplorePaletteContext);
  return (
    <TouchableOpacity
      style={[styles.talkMoreCTA, { borderTopColor: pal.divider }]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <ThemedText style={[styles.talkMoreText, { color: pal.accent }]}>
        Talk more about your insights
      </ThemedText>
      <SymbolView name="chevron.right" size={13} tintColor={pal.accent} weight="light" type="monochrome" />
    </TouchableOpacity>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function TrendsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { isDark, userTheme } = useAppTheme();
  const dynPalette = getModalPalette(isDark, userTheme);

  const explorePal: ExplorePalette = {
    ...dynPalette,
    positive: '#B8C9B0',
    nudge:    '#A8C4D4',
    warning:  '#E8B4B8',
  };

  const { isExploring } = useExplore();
  const [range, setRange] = useState<'1w' | '1m'>('1w');
  const days = range === '1w' ? 7 : 30;
  const [data, setData] = useState<OuraWeeklyDay[]>(emptyDays(7));
  const [hasOura, setHasOura] = useState(true);
  const [waterByDay, setWaterByDay]       = useState<Record<string, number>>({});
  const [caffeineByDay, setCaffeineByDay] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [stepGoal, setStepGoal] = useState(10000);
  const [sleepGoal, setSleepGoal] = useState(8);
  const [workoutCounts, setWorkoutCounts] = useState<{ week: number; month: number }>({ week: 0, month: 0 });
  const viewTrackedRef        = React.useRef(false);
  const dataQualityTrackedRef = React.useRef<string | null>(null);

  // Track trends_viewed once per mount — fires when user navigates to this tab
  React.useEffect(() => {
    if (!viewTrackedRef.current) {
      viewTrackedRef.current = true;
      trackEvent('trends_viewed', { source_screen: 'trends' });
    }
  }, []);

  // Track whether Trends had data when it loaded — fires once per range change
  // after loading completes. Resets when range changes so each range is measured.
  React.useEffect(() => {
    if (loading) return;
    if (DEMO_MODE || isExploring) return;
    const key = range;
    if (dataQualityTrackedRef.current === key) return;
    dataQualityTrackedRef.current = key;
    const hasAnyData = data.some(
      d => d.sleepScore > 0 || d.steps > 0 || d.hrv > 0 || d.readiness > 0,
    );
    trackEvent(hasAnyData ? 'trends_data_present' : 'trends_data_empty', { source_screen: 'trends' });
  }, [loading, range, data, isExploring]);

  useEffect(() => {
    AsyncStorage.getItem('user_profile').then((raw) => {
      if (!raw) return;
      const p = JSON.parse(raw);
      if (p.stepGoal)  setStepGoal(parseInt(p.stepGoal, 10));
      if (p.sleepGoal) setSleepGoal(parseFloat(p.sleepGoal));
    }).catch(() => {});
  }, []);

  // Trends stays mounted under NativeTabs, so the load effect alone runs once
  // per session. Re-load on focus when the last load failed, is stale, or the
  // Oura connection changed since (connected/disconnected in Settings).
  const [reloadTick, setReloadTick] = useState(0);
  const lastLoadRef = React.useRef<{ ok: boolean; at: number; hadToken: boolean } | null>(null);
  const loadSeqRef  = React.useRef(0);
  const loadKeyRef  = React.useRef<string | null>(null);
  useFocusEffect(React.useCallback(() => {
    const last = lastLoadRef.current;
    if (!last) return;
    if (!last.ok || Date.now() - last.at > TRENDS_REFRESH_MS) {
      setReloadTick(t => t + 1);
      return;
    }
    getOuraToken().then(t => {
      if (!!t !== lastLoadRef.current?.hadToken) setReloadTick(n => n + 1);
    }).catch(() => {});
  }, []));

  useEffect(() => {
    // Clear only when the range/mode changes — a refresh keeps the current
    // (valid) data on screen until new data arrives.
    const loadKey = `${range}|${isExploring}`;
    if (loadKeyRef.current !== loadKey) {
      loadKeyRef.current = loadKey;
      setData(emptyDays(days));
    }
    setLoading(true);
    const seq = ++loadSeqRef.current;
    const isCurrent = () => seq === loadSeqRef.current;
    async function load() {
      // ── DEMO / EXPLORE MODE: substitute synthetic data, skip Oura API ─────
      if (DEMO_MODE || isExploring) {
        setData(DEMO_WEEKLY_DAYS);
        setLoading(false);
        return;
      }
      let ok = false;
      let hadToken = false;
      try {
        const token = await getOuraToken();
        hadToken = !!token;

        // Load manually-logged water + caffeine history (available regardless of Oura)
        AsyncStorage.getItem('water_history').then(raw => {
          if (!raw) return;
          const hist: Array<{ date: string; oz: number }> = JSON.parse(raw);
          const byDay: Record<string, number> = {};
          hist.forEach(e => { if (e.oz > 0) byDay[e.date] = e.oz; });
          setWaterByDay(byDay);
        }).catch(() => {});
        AsyncStorage.getItem('caffeine_history').then(raw => {
          if (!raw) return;
          const hist: Array<{ date: string; totalMg: number }> = JSON.parse(raw);
          const byDay: Record<string, number> = {};
          hist.forEach(e => { if (e.totalMg > 0) byDay[e.date] = e.totalMg; });
          setCaffeineByDay(byDay);
        }).catch(() => {});

        if (!token) {
          // No Oura connected — populate steps and sleep from HealthKit so
          // Trends is useful for users without a wearable.
          setHasOura(false);
          const [hkStepsByDay, hkSleepByDay, hkHrvByDay] = await Promise.all([
            getDailySteps(days).catch(() => ({} as Record<string, number>)),
            getHistoricalSleepHours(days).catch(() => ({} as Record<string, number>)),
            getDailyHRV(days).catch(() => ({} as Record<string, number>)),
          ]);
          const base = emptyDays(days);
          const filled = base.map(d => ({
            ...d,
            steps:      hkStepsByDay[d.date] ?? 0,
            sleepHours: hkSleepByDay[d.date] ?? 0,
            hrv:        hkHrvByDay[d.date]   ?? 0,
          }));
          if (!isCurrent()) return;
          setData(filled);
          const counts = await getWorkoutCountsForPeriods().catch(() => ({ week: 0, month: 0 }));
          setWorkoutCounts(counts);
          lastLoadRef.current = { ok: true, at: Date.now(), hadToken };
          setLoading(false);
          return;
        }
        setHasOura(true);
        const result = await loadOuraTrends(token, days, range === '1w' ? getTodaySteps : undefined);
        if (!isCurrent()) return;
        if (result.ok) {
          ok = true;
          setData(result.days);
        } else if (__DEV__) {
          // Class + status only — no token or payload.
          console.warn('[Trends] Oura weekly fetch failed:', result.kind, result.status);
        }
        const counts = await getWorkoutCountsForPeriods().catch(() => ({ week: 0, month: 0 }));
        setWorkoutCounts(counts);
      } catch {}
      if (!isCurrent()) return;
      lastLoadRef.current = { ok, at: Date.now(), hadToken };
      setLoading(false);
    }
    load();
  }, [range, isExploring, reloadTick]); // eslint-disable-line react-hooks/exhaustive-deps

  const [drinksLogged, setDrinksLogged] = useState<(number | null)[]>(Array(7).fill(null));
  useEffect(() => {
    async function loadDrinks() {
      if (DEMO_MODE || isExploring) { setDrinksLogged(DEMO_DRINKS_LOGGED); return; }
      try {
        const raw = await (await import('@react-native-async-storage/async-storage')).default.getItem('drink_log');
        const log: any[] = raw ? JSON.parse(raw) : [];
        const counts = data.map((day) => {
          const entry = log.find((e) => e.date === day.date);
          // null = no log entry for this day (unknown), not confirmed zero
          return entry !== undefined ? (entry.totalDrinks ?? 0) : null;
        });
        setDrinksLogged(counts);
      } catch {}
    }
    loadDrinks();
  }, [data]);

  const compact = range === '1m';
  const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const dayLabels = data.map((d, i) => {
    if (!compact) return d.dayLabel;
    if (i % 5 !== 0) return '';
    const dt = new Date(d.date + 'T12:00:00');
    const prevLabeledMonth = i >= 5 ? new Date(data[i - 5].date + 'T12:00:00').getMonth() : -1;
    return dt.getMonth() !== prevLabeledMonth ? MONTH_ABBR[dt.getMonth()] : String(dt.getDate());
  });

  const avgSleepHours   = periodAvg(data.map(d => d.sleepHours));
  const avgSleepScore   = periodAvg(data.map(d => d.sleepScore));
  const avgHrv          = periodAvg(data.map(d => d.hrv));
  const avgReadiness    = periodAvg(data.map(d => d.readiness));
  const avgSteps        = periodAvg(data.map(d => d.steps));

  const periodCtx = buildPeriodContext(
    data, drinksLogged, range === '1w' ? workoutCounts.week : workoutCounts.month, stepGoal, range,
  );
  const ordered = buildInsights(periodCtx);

  const accentColor = explorePal.viz;

  return (
    <ExplorePaletteContext.Provider value={explorePal}>
      <View style={[styles.container, { backgroundColor: dynPalette.background }]}>
        <View style={[styles.safeArea, { paddingTop: insets.top + Spacing.two }]}>

          {/* ── Header ── */}
          <View style={styles.headerRow}>
            <View>
              <ThemedText style={[styles.pageLabel, { color: dynPalette.textSecondary }]}>
                {range === '1w' ? 'Last 7 Days' : 'Last 30 Days'}
              </ThemedText>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <ThemedText style={[styles.pageName, { color: dynPalette.text }]}>Trends</ThemedText>
                {loading && <ActivityIndicator size="small" color={dynPalette.textSecondary} />}
              </View>
            </View>

            {/* ── Range toggle — quiet text links ── */}
            <View style={styles.rangeToggle}>
              {(['1w', '1m'] as const).map((r) => (
                <TouchableOpacity key={r} onPress={() => setRange(r)} activeOpacity={0.6}>
                  <ThemedText style={[
                    styles.rangeOption,
                    { color: range === r ? dynPalette.text : dynPalette.textSecondary },
                    range === r && styles.rangeOptionActive,
                  ]}>
                    {r === '1w' ? '1W' : '1M'}
                  </ThemedText>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>

            <ChartSection label="Sleep Duration" aside={avgSleepHours > 0 ? `${avgSleepHours.toFixed(1)}h avg` : undefined}>
              {compact
                ? <LineChart data={data.map(d => d.sleepHours)} dayLabels={dayLabels} color={accentColor} formatValue={v => `${v}h`} />
                : <MiniBarChart data={data.map(d => d.sleepHours)} dayLabels={dayLabels} color={accentColor} goal={sleepGoal} formatValue={v => `${v}h`} compact={false} />}
            </ChartSection>

            {hasOura && (
              <ChartSection label="Sleep Score" aside={avgSleepScore > 0 ? `${Math.round(avgSleepScore)} avg` : undefined}>
                {compact
                  ? <LineChart data={data.map(d => d.sleepScore)} dayLabels={dayLabels} color={accentColor} formatValue={v => `${v}`} />
                  : <MiniBarChart data={data.map(d => d.sleepScore)} dayLabels={dayLabels} color={accentColor} goal={85} formatValue={v => `${v}`} compact={false} />}
              </ChartSection>
            )}

            {avgHrv > 0 && (
              <ChartSection label="HRV" aside={`${Math.round(avgHrv)} ms avg`}>
                {compact
                  ? <LineChart data={data.map(d => d.hrv)} dayLabels={dayLabels} color={accentColor} formatValue={v => `${v}ms`} />
                  : <MiniBarChart data={data.map(d => d.hrv)} dayLabels={dayLabels} color={accentColor} formatValue={v => `${v}ms`} compact={false} />}
              </ChartSection>
            )}

            {hasOura && (
              <ChartSection label="Readiness" aside={avgReadiness > 0 ? `${Math.round(avgReadiness)} avg` : undefined}>
                {compact
                  ? <LineChart data={data.map(d => d.readiness)} dayLabels={dayLabels} color={accentColor} formatValue={v => `${v}`} />
                  : <MiniBarChart data={data.map(d => d.readiness)} dayLabels={dayLabels} color={accentColor} goal={85} formatValue={v => `${v}`} compact={false} />}
              </ChartSection>
            )}

            <ChartSection label="Steps" aside={avgSteps > 0 ? `${(avgSteps / 1000).toFixed(1)}K avg` : undefined}>
              {compact
                ? <LineChart data={data.map(d => d.steps)} dayLabels={dayLabels} color={accentColor} formatValue={v => `${(v / 1000).toFixed(1)}K`} />
                : <MiniBarChart data={data.map(d => d.steps)} dayLabels={dayLabels} color={accentColor} goal={10000} formatValue={v => `${(v / 1000).toFixed(1)}K`} compact={false} />}
            </ChartSection>

            {(() => {
              const waterVals = data.map(d => waterByDay[d.date] ?? 0);
              const avgWater  = periodAvg(waterVals);
              if (waterVals.every(v => v === 0)) return null;
              return (
                <ChartSection label="Water" aside={avgWater > 0 ? `${Math.round(avgWater)} oz avg` : undefined}>
                  {compact
                    ? <LineChart data={waterVals} dayLabels={dayLabels} color={accentColor} formatValue={v => `${Math.round(v)}oz`} />
                    : <MiniBarChart data={waterVals} dayLabels={dayLabels} color={accentColor} formatValue={v => `${Math.round(v)}oz`} compact={false} />}
                </ChartSection>
              );
            })()}

            {(() => {
              const cafVals  = data.map(d => caffeineByDay[d.date] ?? 0);
              const avgCaf   = periodAvg(cafVals);
              if (cafVals.every(v => v === 0)) return null;
              return (
                <ChartSection label="Caffeine" aside={avgCaf > 0 ? `${Math.round(avgCaf)} mg avg` : undefined}>
                  {compact
                    ? <LineChart data={cafVals} dayLabels={dayLabels} color={accentColor} formatValue={v => `${Math.round(v)}mg`} />
                    : <MiniBarChart data={cafVals} dayLabels={dayLabels} color={accentColor} formatValue={v => `${Math.round(v)}mg`} compact={false} />}
                </ChartSection>
              );
            })()}

            {/* ── Insights ── */}
            <View style={[styles.rule, { backgroundColor: dynPalette.divider, marginTop: Spacing.three }]} />
            <View style={styles.insightsHeader}>
              <ThemedText style={[styles.insightsLabel, { color: dynPalette.textSecondary }]}>Insights</ThemedText>
              <ThemedText style={[styles.insightsSub, { color: dynPalette.textSecondary }]}>
                Based on sleep, HRV, readiness, steps, workouts, and logged activity.
              </ThemedText>
            </View>

            {ordered.map((rec) => (
              <RecEntry key={rec.id} rec={rec} />
            ))}

            {periodCtx.hasData && ordered[0]?.id !== 'no_data' && (
              <TalkMoreCTA onPress={async () => {
                await AsyncStorage.setItem('open_chat_flag', '1').catch(() => {});
                router.navigate('/');
              }} />
            )}

            <ThemedText style={[styles.footerText, { color: dynPalette.textSecondary }]}>
              Insights update daily as health data syncs.
            </ThemedText>

          </ScrollView>
        </View>
      </View>
    </ExplorePaletteContext.Provider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
    paddingHorizontal: Spacing.three,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingTop: Spacing.two,
    paddingBottom: Spacing.three,
  },
  pageLabel: {
    fontFamily: Fonts.serif,
    fontSize: 10,
    letterSpacing: 2.5,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  pageName: {
    fontFamily: Fonts.serif,
    fontSize: 36,
    fontWeight: '400',
    fontStyle: 'italic',
    lineHeight: 40,
  },
  rangeToggle: {
    flexDirection: 'row',
    gap: 16,
    paddingBottom: 4,
  },
  rangeOption: {
    fontFamily: Fonts.serif,
    fontSize: 14,
    fontStyle: 'italic',
  },
  rangeOptionActive: {
    textDecorationLine: 'underline',
  },
  scroll: {
    paddingBottom: Spacing.six,
  },
  rule: {
    height: StyleSheet.hairlineWidth,
  },
  chartSection: {
    marginTop: Spacing.three,
  },
  chartHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginTop: Spacing.two,
    marginBottom: 2,
  },
  sectionLabel: {
    fontSize: 9,
    letterSpacing: 2.5,
    textTransform: 'uppercase',
  },
  sectionAside: {
    fontSize: 11,
    fontStyle: 'italic',
  },
  insightsHeader: {
    marginTop: Spacing.two,
    marginBottom: Spacing.two,
    gap: 4,
  },
  insightsLabel: {
    fontFamily: Fonts.serif,
    fontSize: 9,
    letterSpacing: 2.5,
    textTransform: 'uppercase',
  },
  insightsSub: {
    fontFamily: Fonts.serif,
    fontSize: 13,
    fontStyle: 'italic',
    lineHeight: 20,
  },
  recEntry: {
    flexDirection: 'row',
    paddingVertical: Spacing.three,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 14,
    alignItems: 'flex-start',
  },
  recDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginTop: 5,
    flexShrink: 0,
  },
  recIconWrap: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
    flexShrink: 0,
  },
  recContent: {
    flex: 1,
    gap: 5,
  },
  recHeadline: {
    fontFamily: Fonts.serif,
    fontSize: 15,
    fontStyle: 'italic',
    lineHeight: 21,
  },
  recDetail: {
    fontSize: 13,
    lineHeight: 19,
  },
  recSource: {
    fontSize: 9,
    textTransform: 'uppercase',
    letterSpacing: 1.5,
    marginTop: 2,
  },
  footerText: {
    fontSize: 11,
    textAlign: 'center',
    fontStyle: 'italic',
    lineHeight: 17,
    marginTop: Spacing.four,
  },
  talkMoreCTA: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.three,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  talkMoreText: {
    fontFamily: Fonts.serif,
    fontSize: 15,
    fontStyle: 'italic',
  },
});
