import AsyncStorage from '@react-native-async-storage/async-storage';
import { SymbolView } from 'expo-symbols';
import React, { useContext, useEffect, useRef, useState } from 'react';
import { Animated, KeyboardAvoidingView, Modal, Platform, ScrollView, StyleSheet, TextInput, TouchableOpacity, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Fonts, Spacing } from '@/constants/theme';
import { useAppTheme } from '@/context/theme-context';
import { getModalPalette, type ModalPalette } from '@/utils/modal-palette';
import { getWorkoutCountsForPeriods } from '@/services/healthkit';
import { getOuraToken, fetchOuraWeekly, type OuraWeeklyDay } from '@/services/oura';
import { trackEvent } from '@/services/analytics';
import { localDateString } from '@/utils/local-date';

// All sub-components read palette from this context
const GroundingPaletteContext = React.createContext<ModalPalette>({
  background: '#FAF6F2', card: '#FFFFFF', text: '#3D2C2C', textSecondary: '#9E7E7E',
  divider: '#F0E8E4', shadow: 'rgba(180,140,130,0.22)', accent: '#C17B8E',
  accentBtn: '#A85878', plus: '#7A9E78', minus: '#C17B8E', viz: '#C17B8E',
});

// ─── Content ──────────────────────────────────────────────────────────────────

const gratitudeItems = [
  { text: 'There is air in my lungs right now.', detail: 'Your body is doing its job. You are alive.' },
  { text: 'I have clothes on my body.', detail: 'Basic needs are met. That is more than it might feel like right now.' },
  { text: 'I have a phone in my hand.', detail: "It connects you to people you love who you don't always get to see." },
  { text: 'I have a roof over my head.', detail: 'You have shelter. You have a place that is yours.' },
  { text: 'I am strong.', detail: "You have made it through hard days before. Every single one of them. You're still here." },
  { text: 'Someone loves me.', detail: 'Even when it is hard to feel it, it is true.' },
  { text: 'I woke up today.', detail: 'Another day is a gift — even on days it does not feel that way.' },
  { text: 'I have the ability to grow and change.', detail: 'No version of you is permanent. You are always becoming.' },
];


function buildWeeklyWins(
  days: OuraWeeklyDay[],
  workoutsThisWeek: number,
  mealDays: number,
  gratitudeDays: number,
  classesThisWeek: number,
  recoverySessionsToday: number,
  waterTodayOz: number,
  waterGoalOz: number,
  sleepGoal: number,
  stepGoal: number,
): string[] {
  const wins: string[] = [];

  const withSleep    = days.filter((d) => d.sleepHours > 0);
  const withSteps    = days.filter((d) => d.steps > 0);
  const withHrv      = days.filter((d) => d.hrv > 0);
  const withReadiness= days.filter((d) => d.readiness > 0);

  // Nights that hit the sleep goal — only show if user actually hit it at least once
  const sleepGoalNights = withSleep.filter((d) => d.sleepHours >= sleepGoal).length;
  if (sleepGoalNights >= 5) {
    wins.push(`You hit your ${sleepGoal}-hour sleep goal ${sleepGoalNights} out of 7 nights this week.`);
  } else if (sleepGoalNights >= 3) {
    wins.push(`You hit your ${sleepGoal}-hour sleep goal ${sleepGoalNights} nights this week.`);
  } else if (sleepGoalNights >= 1) {
    wins.push(`You hit your ${sleepGoal}-hour sleep goal ${sleepGoalNights} night${sleepGoalNights > 1 ? 's' : ''} this week.`);
  }

  // Average sleep score — only surface if genuinely good (≥75)
  if (withSleep.length >= 3) {
    const avg = Math.round(withSleep.reduce((a, d) => a + d.sleepScore, 0) / withSleep.length);
    if (avg >= 75) wins.push(`Your average sleep score this week was ${avg}.`);
  }

  // HRV — upward trend beats a raw average; fall back to average only if ≥40 ms
  if (withHrv.length >= 3) {
    const mid = Math.floor(withHrv.length / 2);
    const early = withHrv.slice(0, mid).reduce((a, d) => a + d.hrv, 0) / mid;
    const late  = withHrv.slice(mid).reduce((a, d) => a + d.hrv, 0) / (withHrv.length - mid);
    if (late > early + 2) {
      wins.push(`Your HRV has been trending upward this week — your nervous system is recovering.`);
    } else {
      const avg = Math.round(withHrv.reduce((a, d) => a + d.hrv, 0) / withHrv.length);
      if (avg >= 40) wins.push(`Your average HRV this week was ${avg} ms.`);
    }
  }

  // Days that hit the step goal — only show if at least one day
  const stepGoalDays = withSteps.filter((d) => d.steps >= stepGoal).length;
  if (stepGoalDays >= 5) {
    wins.push(`You hit your step goal ${stepGoalDays} out of 7 days this week.`);
  } else if (stepGoalDays >= 3) {
    wins.push(`You hit your ${stepGoal.toLocaleString()}-step goal ${stepGoalDays} days this week.`);
  } else if (stepGoalDays >= 1) {
    wins.push(`You hit your ${stepGoal.toLocaleString()}-step goal ${stepGoalDays} day${stepGoalDays > 1 ? 's' : ''} this week.`);
  }

  // Average readiness — only if good (≥75)
  if (withReadiness.length >= 3) {
    const avg = Math.round(withReadiness.reduce((a, d) => a + d.readiness, 0) / withReadiness.length);
    if (avg >= 75) wins.push(`Your average readiness score this week was ${avg}.`);
  }

  // Workouts — every count is a win
  if (workoutsThisWeek >= 4) {
    wins.push(`You worked out ${workoutsThisWeek} times this week.`);
  } else if (workoutsThisWeek === 3) {
    wins.push(`Three workouts this week — consistency is how bodies change.`);
  } else if (workoutsThisWeek === 2) {
    wins.push(`Two workouts in this week.`);
  } else if (workoutsThisWeek === 1) {
    wins.push(`You showed up for a workout this week.`);
  }

  // Meal tracking
  if (mealDays >= 5) {
    wins.push(`Meals logged ${mealDays} out of 7 days this week.`);
  } else if (mealDays >= 3) {
    wins.push(`Nutrition tracked ${mealDays} days this week.`);
  } else if (mealDays >= 1) {
    wins.push(`You logged your meals ${mealDays} day${mealDays > 1 ? 's' : ''} this week.`);
  }

  // Gratitude practice
  if (gratitudeDays >= 1) {
    wins.push(`You practiced gratitude ${gratitudeDays} time${gratitudeDays > 1 ? 's' : ''} this week.`);
  }

  // Classes logged this week (yoga, gym, etc.)
  if (classesThisWeek >= 3) {
    wins.push(`You attended ${classesThisWeek} classes this week.`);
  } else if (classesThisWeek >= 1) {
    wins.push(`You logged ${classesThisWeek} class${classesThisWeek > 1 ? 'es' : ''} this week.`);
  }

  // Recovery sessions today (sauna / cold plunge)
  if (recoverySessionsToday >= 1) {
    wins.push(`You logged a recovery session today — that is intentional self-care.`);
  }

  // Water — only show if they hit or nearly hit their goal today
  if (waterGoalOz > 0 && waterTodayOz >= waterGoalOz) {
    wins.push(`Hydration goal reached today — ${waterTodayOz} oz.`);
  } else if (waterGoalOz > 0 && waterTodayOz >= Math.round(waterGoalOz * 0.8)) {
    wins.push(`${waterTodayOz} oz of water logged today — almost at your goal.`);
  }

  // Only fall back to anchors if data produced nothing at all
  if (wins.length === 0) {
    wins.push('You are here, doing the work — even on hard days.');
    wins.push('You opened this app. That is paying attention to yourself.');
    wins.push('You made it through every day this week.');
  }

  return wins.slice(0, 6);
}

// ─── Storage ──────────────────────────────────────────────────────────────────

const GRATITUDE_KEY = 'gratitude_entries';

export type GratitudeEntry = { text: string; date: string };

async function loadGratitudeEntries(): Promise<GratitudeEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(GRATITUDE_KEY);
    return raw ? (JSON.parse(raw) as GratitudeEntry[]) : [];
  } catch {
    return [];
  }
}

async function saveGratitudeEntries(entries: GratitudeEntry[]): Promise<void> {
  try {
    await AsyncStorage.setItem(GRATITUDE_KEY, JSON.stringify(entries));
  } catch {}
}

// ─── Phases ───────────────────────────────────────────────────────────────────

type Phase = 'welcome' | 'breathing' | 'gratitude-choice' | 'gratitude' | 'gratitude-list' | 'gratitude-write' | 'verse' | 'wins';

// ─── Breathing animation ──────────────────────────────────────────────────────

type BreathPhase = 'inhale' | 'hold' | 'exhale' | 'rest';

const INHALE_MS    = 4000;
const HOLD_MS      = 4000;
const EXHALE_MS    = 6000;
const REST_MS      = 1000;
const TOTAL_ROUNDS = 4;

function BreathingExercise({ onDone }: { onDone: () => void }) {
  const pal = useContext(GroundingPaletteContext);
  const scale   = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(0.6)).current;
  const [breathPhase, setBreathPhase] = useState<BreathPhase>('inhale');
  const [round, setRound] = useState(1);
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function runCycle(currentRound: number) {
      if (cancelled) return;

      setBreathPhase('inhale');
      await new Promise<void>((resolve) => {
        Animated.parallel([
          Animated.timing(scale,   { toValue: 1.5, duration: INHALE_MS, useNativeDriver: true }),
          Animated.timing(opacity, { toValue: 1.0, duration: INHALE_MS, useNativeDriver: true }),
        ]).start(() => resolve());
      });
      if (cancelled) return;

      setBreathPhase('hold');
      await new Promise<void>((resolve) => setTimeout(resolve, HOLD_MS));
      if (cancelled) return;

      setBreathPhase('exhale');
      await new Promise<void>((resolve) => {
        Animated.parallel([
          Animated.timing(scale,   { toValue: 1.0, duration: EXHALE_MS, useNativeDriver: true }),
          Animated.timing(opacity, { toValue: 0.6, duration: EXHALE_MS, useNativeDriver: true }),
        ]).start(() => resolve());
      });
      if (cancelled) return;

      setBreathPhase('rest');
      await new Promise<void>((resolve) => setTimeout(resolve, REST_MS));
      if (cancelled) return;

      if (currentRound < TOTAL_ROUNDS) {
        setRound(currentRound + 1);
        runCycle(currentRound + 1);
      } else {
        setFinished(true);
      }
    }

    runCycle(1);
    return () => { cancelled = true; };
  }, []);

  const breathLabel: Record<BreathPhase, string> = {
    inhale: 'Breathe in...',
    hold:   'Hold...',
    exhale: 'Breathe out...',
    rest:   'Rest...',
  };

  return (
    <View style={breathStyles.container}>
      {!finished && (
        <View style={[breathStyles.benefitsCard, { borderColor: pal.divider }]}>
          <ThemedText style={[breathStyles.benefitsTitle, { color: pal.textSecondary }]}>Box breathing — why it helps</ThemedText>
          <ThemedText style={[breathStyles.benefitsText, { color: pal.text }]}>
            · Activates your parasympathetic nervous system — the "rest and digest" response{'\n'}
            · The extended exhale slows your heart rate and drops cortisol within minutes{'\n'}
            · Rebalances CO₂ levels, which directly reduces panic and shallow breathing{'\n'}
            · Used by Navy SEALs and athletes to reset under pressure
          </ThemedText>
        </View>
      )}

      <ThemedText style={[breathStyles.roundText, { color: pal.textSecondary }]}>Round {round} of {TOTAL_ROUNDS}</ThemedText>

      <View style={breathStyles.circleWrap}>
        <Animated.View style={[breathStyles.ring, {
          backgroundColor: pal.accent + '30',
          borderColor: pal.accent,
          transform: [{ scale }],
          opacity,
        }]} />
        <View style={breathStyles.center}>
          <ThemedText style={[breathStyles.breathLabel, { color: pal.text }]}>{breathLabel[breathPhase]}</ThemedText>
        </View>
      </View>

      <ThemedText style={[breathStyles.hint, { color: pal.textSecondary }]}>Inhale 4s · Hold 4s · Exhale 6s</ThemedText>

      {finished ? (
        <TouchableOpacity style={[breathStyles.continueBtn, { borderColor: pal.accent }]} onPress={onDone} activeOpacity={0.8}>
          <ThemedText style={[breathStyles.continueBtnText, { color: pal.accent }]}>Continue ›</ThemedText>
        </TouchableOpacity>
      ) : (
        <TouchableOpacity style={breathStyles.skipBtn} onPress={onDone} activeOpacity={0.7}>
          <ThemedText style={[breathStyles.skipBtnText, { color: pal.textSecondary }]}>Skip breathing</ThemedText>
        </TouchableOpacity>
      )}
    </View>
  );
}

const breathStyles = StyleSheet.create({
  container:    { alignItems: 'center', gap: Spacing.three, paddingVertical: Spacing.four },
  roundText:    { fontSize: 13, letterSpacing: 0.5 },
  circleWrap:   { width: 200, height: 200, alignItems: 'center', justifyContent: 'center' },
  ring: {
    position: 'absolute',
    width: 180, height: 180, borderRadius: 90,
    borderWidth: 2,
  },
  center:       { alignItems: 'center', justifyContent: 'center' },
  breathLabel:  { fontFamily: Fonts.serif, fontSize: 17, fontStyle: 'italic', textAlign: 'center' },
  hint:         { fontSize: 12, fontStyle: 'italic' },
  continueBtn:  { paddingVertical: 14, paddingHorizontal: 40, borderWidth: StyleSheet.hairlineWidth },
  continueBtnText: { fontFamily: Fonts.serif, fontSize: 16, fontStyle: 'italic' },
  skipBtn:      { paddingVertical: 8 },
  skipBtnText:  { fontSize: 13, textDecorationLine: 'underline' },
  benefitsCard: { borderWidth: StyleSheet.hairlineWidth, padding: Spacing.three, gap: 6, width: '100%' },
  benefitsTitle: { fontSize: 9, letterSpacing: 2.5, textTransform: 'uppercase' },
  benefitsText:  { fontFamily: Fonts.serif, fontSize: 13, fontStyle: 'italic', lineHeight: 21 },
});

// ─── Gratitude cards ───────────────────────────────────────────────────────────

function GratitudeSection({ onDone }: { onDone: () => void }) {
  const pal = useContext(GroundingPaletteContext);
  const [index, setIndex] = useState(0);
  const fadeAnim = useRef(new Animated.Value(1)).current;

  function advance() {
    Animated.timing(fadeAnim, { toValue: 0, duration: 250, useNativeDriver: true }).start(() => {
      if (index < gratitudeItems.length - 1) {
        setIndex((i) => i + 1);
        Animated.timing(fadeAnim, { toValue: 1, duration: 250, useNativeDriver: true }).start();
      } else {
        Animated.timing(fadeAnim, { toValue: 1, duration: 250, useNativeDriver: true }).start();
        onDone();
      }
    });
  }

  const item = gratitudeItems[index];
  const isLast = index === gratitudeItems.length - 1;

  return (
    <View style={gratStyles.container}>
      <ThemedText style={[gratStyles.heading, { color: pal.text }]}>Things to be grateful for</ThemedText>
      <ThemedText style={[gratStyles.progress, { color: pal.textSecondary }]}>{index + 1} of {gratitudeItems.length}</ThemedText>

      <Animated.View style={[gratStyles.card, { borderColor: pal.divider, opacity: fadeAnim }]}>
        <ThemedText style={[gratStyles.cardText, { color: pal.text }]}>{item.text}</ThemedText>
        <View style={[gratStyles.divider, { backgroundColor: pal.divider }]} />
        <ThemedText style={[gratStyles.cardDetail, { color: pal.textSecondary }]}>{item.detail}</ThemedText>
      </Animated.View>

      <TouchableOpacity style={[gratStyles.nextBtn, { borderColor: pal.accent }]} onPress={advance} activeOpacity={0.8}>
        <ThemedText style={[gratStyles.nextBtnText, { color: pal.accent }]}>{isLast ? 'Continue ›' : 'Next ›'}</ThemedText>
      </TouchableOpacity>
    </View>
  );
}

const gratStyles = StyleSheet.create({
  container:  { gap: Spacing.three },
  heading:    { fontFamily: Fonts.serif, fontSize: 22, fontStyle: 'italic', fontWeight: '400' },
  progress:   { fontSize: 12, fontStyle: 'italic' },
  card: {
    borderWidth: StyleSheet.hairlineWidth, padding: Spacing.four, gap: Spacing.two,
    minHeight: 140, justifyContent: 'center',
  },
  cardText:   { fontFamily: Fonts.serif, fontSize: 20, fontStyle: 'italic', fontWeight: '400', lineHeight: 28 },
  divider:    { height: StyleSheet.hairlineWidth },
  cardDetail: { fontFamily: Fonts.serif, fontSize: 14, lineHeight: 21, fontStyle: 'italic' },
  nextBtn:    { borderWidth: StyleSheet.hairlineWidth, paddingVertical: 14, alignItems: 'center' },
  nextBtnText:{ fontFamily: Fonts.serif, fontSize: 16, fontStyle: 'italic' },
});

// ─── Reminder ─────────────────────────────────────────────────────────────────

function VerseSection({ onDone }: { onDone: () => void }) {
  const pal = useContext(GroundingPaletteContext);

  return (
    <View style={verseStyles.container}>
      <ThemedText style={[verseStyles.heading, { color: pal.text }]}>A reminder for you</ThemedText>

      <View style={[verseStyles.card, { borderColor: pal.divider }]}>
        <ThemedText style={[verseStyles.verseText, { color: pal.text }]}>
          Take what you need. Then get back to your life.
        </ThemedText>
      </View>

      <TouchableOpacity style={[verseStyles.continueBtn, { borderColor: pal.accent }]} onPress={onDone} activeOpacity={0.8}>
        <ThemedText style={[verseStyles.continueBtnText, { color: pal.accent }]}>See this week's wins ›</ThemedText>
      </TouchableOpacity>
    </View>
  );
}

const verseStyles = StyleSheet.create({
  container:       { gap: Spacing.three },
  heading:         { fontFamily: Fonts.serif, fontSize: 22, fontStyle: 'italic', fontWeight: '400' },
  card:            { borderWidth: StyleSheet.hairlineWidth, padding: Spacing.four },
  verseText:       { fontFamily: Fonts.serif, fontSize: 17, lineHeight: 26, fontStyle: 'italic', textAlign: 'center' },
  continueBtn:     { borderWidth: StyleSheet.hairlineWidth, paddingVertical: 14, alignItems: 'center' },
  continueBtnText: { fontFamily: Fonts.serif, fontSize: 16, fontStyle: 'italic' },
});

// ─── Weekly wins ───────────────────────────────────────────────────────────────

function WinsSection({ wins, onDone }: { wins: string[]; onDone: () => void }) {
  const pal = useContext(GroundingPaletteContext);
  return (
    <View style={winsStyles.container}>
      <ThemedText style={[winsStyles.heading, { color: pal.text }]}>This week's accomplishments</ThemedText>
      <ThemedText style={[winsStyles.sub, { color: pal.textSecondary }]}>Look at everything you did.</ThemedText>

      {wins.map((win, i) => (
        <View key={i} style={winsStyles.winRow}>
          <View style={[winsStyles.dot, { backgroundColor: pal.accent }]} />
          <ThemedText style={[winsStyles.winText, { color: pal.text }]}>{win}</ThemedText>
        </View>
      ))}

      <View style={[winsStyles.closing, { borderColor: pal.divider }]}>
        <ThemedText style={[winsStyles.closingText, { color: pal.text }]}>
          Anxiety lies. The data doesn't. You are doing better than you think.
        </ThemedText>
      </View>

      <TouchableOpacity style={[winsStyles.doneBtn, { borderColor: pal.accent }]} onPress={onDone} activeOpacity={0.8}>
        <ThemedText style={[winsStyles.doneBtnText, { color: pal.accent }]}>I'm ready</ThemedText>
      </TouchableOpacity>
    </View>
  );
}

const winsStyles = StyleSheet.create({
  container: { gap: Spacing.three },
  heading:   { fontFamily: Fonts.serif, fontSize: 22, fontStyle: 'italic', fontWeight: '400' },
  sub:       { fontSize: 14, fontStyle: 'italic', marginTop: -Spacing.two },
  winRow:    { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.two },
  dot:       { width: 6, height: 6, borderRadius: 3, marginTop: 8, flexShrink: 0 },
  winText:   { flex: 1, fontSize: 15, lineHeight: 22 },
  closing:   { borderWidth: StyleSheet.hairlineWidth, padding: Spacing.three },
  closingText: { fontFamily: Fonts.serif, fontSize: 14, lineHeight: 21, fontStyle: 'italic' },
  doneBtn:   { borderWidth: StyleSheet.hairlineWidth, paddingVertical: 14, alignItems: 'center' },
  doneBtnText: { fontFamily: Fonts.serif, fontSize: 16, fontStyle: 'italic' },
});

// ─── Gratitude choice ──────────────────────────────────────────────────────────

function GratitudeChoiceSection({
  entryCount,
  onExercises,
  onMyList,
}: {
  entryCount: number;
  onExercises: () => void;
  onMyList: () => void;
}) {
  const pal = useContext(GroundingPaletteContext);
  return (
    <View style={choiceStyles.container}>
      <ThemedText style={[choiceStyles.heading, { color: pal.text }]}>Your gratitude practice</ThemedText>
      <ThemedText style={[choiceStyles.sub, { color: pal.textSecondary }]}>
        You have {entryCount} things saved in your gratitude list.
      </ThemedText>

      <TouchableOpacity style={[choiceStyles.primaryBtn, { borderColor: pal.accent }]} onPress={onExercises} activeOpacity={0.8}>
        <ThemedText style={[choiceStyles.primaryBtnText, { color: pal.accent }]}>Guided exercises ›</ThemedText>
      </TouchableOpacity>

      <TouchableOpacity style={choiceStyles.secondaryBtn} onPress={onMyList} activeOpacity={0.8}>
        <ThemedText style={[choiceStyles.secondaryBtnText, { color: pal.textSecondary }]}>My Gratitude List ›</ThemedText>
      </TouchableOpacity>
    </View>
  );
}

const choiceStyles = StyleSheet.create({
  container:      { alignItems: 'center', gap: Spacing.three, paddingTop: Spacing.four },
  heading:        { fontFamily: Fonts.serif, fontSize: 24, fontStyle: 'italic', fontWeight: '400', lineHeight: 32, textAlign: 'center' },
  sub:            { fontSize: 15, textAlign: 'center', lineHeight: 22 },
  primaryBtn:     { borderWidth: StyleSheet.hairlineWidth, paddingVertical: 14, paddingHorizontal: 36, width: '100%', alignItems: 'center' },
  primaryBtnText: { fontFamily: Fonts.serif, fontSize: 16, fontStyle: 'italic' },
  secondaryBtn:   { paddingVertical: 8 },
  secondaryBtnText: { fontSize: 14, textDecorationLine: 'underline' },
});

// ─── Gratitude write-in ────────────────────────────────────────────────────────

function GratitudeWriteSection({ onDone }: { onDone: (entries: string[]) => void }) {
  const pal = useContext(GroundingPaletteContext);
  const [values, setValues] = useState(['', '', '']);

  function update(index: number, text: string) {
    setValues((prev) => {
      const next = [...prev];
      next[index] = text;
      return next;
    });
  }

  function handleSave() {
    const filled = values.filter((v) => v.trim().length > 0);
    onDone(filled);
  }

  const hasAny = values.some((v) => v.trim().length > 0);

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      <View style={writeStyles.container}>
        <ThemedText style={[writeStyles.heading, { color: pal.text }]}>Your turn</ThemedText>
        <ThemedText style={[writeStyles.sub, { color: pal.textSecondary }]}>Write three things you are grateful for right now.</ThemedText>

        {values.map((val, i) => (
          <View key={i} style={writeStyles.inputRow}>
            <ThemedText style={[writeStyles.numberText, { color: pal.textSecondary }]}>{i + 1}.</ThemedText>
            <TextInput
              style={[writeStyles.input, { color: pal.text, borderColor: pal.divider }]}
              value={val}
              onChangeText={(t) => update(i, t)}
              placeholder="I'm grateful for..."
              placeholderTextColor={pal.textSecondary}
              returnKeyType="next"
            />
          </View>
        ))}

        <TouchableOpacity
          style={[writeStyles.saveBtn, { borderColor: pal.accent }, !hasAny && writeStyles.saveBtnDisabled]}
          onPress={hasAny ? handleSave : undefined}
          activeOpacity={0.8}
        >
          <ThemedText style={[writeStyles.saveBtnText, { color: pal.accent }]}>Save & Continue ›</ThemedText>
        </TouchableOpacity>

        <TouchableOpacity onPress={() => onDone([])} style={writeStyles.skipBtn} activeOpacity={0.7}>
          <ThemedText style={[writeStyles.skipBtnText, { color: pal.textSecondary }]}>Skip for now</ThemedText>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const writeStyles = StyleSheet.create({
  container:        { gap: Spacing.three },
  heading:          { fontFamily: Fonts.serif, fontSize: 22, fontStyle: 'italic', fontWeight: '400', lineHeight: 30 },
  sub:              { fontSize: 14, lineHeight: 21, fontStyle: 'italic', marginTop: -Spacing.one },
  inputRow:         { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  numberText:       { fontSize: 15, width: 20 },
  input: {
    flex: 1, fontSize: 15,
    borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 10,
  },
  saveBtn:          { borderWidth: StyleSheet.hairlineWidth, paddingVertical: 14, alignItems: 'center', marginTop: Spacing.one },
  saveBtnDisabled:  { opacity: 0.4 },
  saveBtnText:      { fontFamily: Fonts.serif, fontSize: 16, fontStyle: 'italic' },
  skipBtn:          { alignItems: 'center', paddingVertical: 6 },
  skipBtnText:      { fontSize: 13, textDecorationLine: 'underline' },
});

// ─── My gratitude list ────────────────────────────────────────────────────────

function GratitudeMyListSection({
  entries,
  onContinue,
}: {
  entries: GratitudeEntry[];
  onContinue: () => void;
}) {
  const pal = useContext(GroundingPaletteContext);
  return (
    <View style={listStyles.container}>
      <ThemedText style={[listStyles.heading, { color: pal.text }]}>My Gratitude List</ThemedText>
      <ThemedText style={[listStyles.sub, { color: pal.textSecondary }]}>{entries.length} things you have been grateful for</ThemedText>

      {entries.map((entry, i) => (
        <View key={i} style={[listStyles.entryRow, { borderTopColor: pal.divider }]}>
          <View style={[listStyles.dot, { backgroundColor: pal.accent }]} />
          <View style={listStyles.entryContent}>
            <ThemedText style={[listStyles.entryText, { color: pal.text }]}>{entry.text}</ThemedText>
            <ThemedText style={[listStyles.entryDate, { color: pal.textSecondary }]}>
              {new Date(entry.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            </ThemedText>
          </View>
        </View>
      ))}

      <TouchableOpacity style={[listStyles.continueBtn, { borderColor: pal.accent }]} onPress={onContinue} activeOpacity={0.8}>
        <ThemedText style={[listStyles.continueBtnText, { color: pal.accent }]}>Continue ›</ThemedText>
      </TouchableOpacity>
    </View>
  );
}

const listStyles = StyleSheet.create({
  container:    { gap: Spacing.two },
  heading:      { fontFamily: Fonts.serif, fontSize: 22, fontStyle: 'italic', fontWeight: '400', lineHeight: 30, marginBottom: Spacing.one },
  sub:          { fontSize: 13, fontStyle: 'italic', marginBottom: Spacing.two },
  entryRow:     { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.two, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth },
  dot:          { width: 6, height: 6, borderRadius: 3, marginTop: 8, flexShrink: 0 },
  entryContent: { flex: 1, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: Spacing.two },
  entryText:    { flex: 1, fontSize: 15, lineHeight: 22 },
  entryDate:    { fontSize: 11, marginTop: 3, flexShrink: 0 },
  continueBtn:  { borderWidth: StyleSheet.hairlineWidth, paddingVertical: 14, alignItems: 'center', marginTop: Spacing.three },
  continueBtnText: { fontFamily: Fonts.serif, fontSize: 16, fontStyle: 'italic' },
});

// ─── Main Modal ───────────────────────────────────────────────────────────────

type Props = { visible: boolean; onClose: () => void };

export function GroundingModal({ visible, onClose }: Props) {
  const { isDark, userTheme } = useAppTheme();
  const pal = getModalPalette(isDark, userTheme);

  const [phase, setPhase] = useState<Phase>('welcome');
  const [storedEntries, setStoredEntries] = useState<GratitudeEntry[]>([]);
  const [wins, setWins] = useState<string[]>([]);

  useEffect(() => {
    if (!visible) return;

    // Load gratitude entries (used for the gratitude flow + wins count)
    loadGratitudeEntries().then(setStoredEntries);

    // Load all weekly data in parallel, then compute wins
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    const cutoffStr = localDateString(cutoff);

    const todayStr = localDateString();

    Promise.all([
      getOuraToken(),
      getWorkoutCountsForPeriods().catch(() => ({ week: 0, month: 0 })),
      // Meal logging days this week
      AsyncStorage.getItem('meal_log').then((raw) => {
        if (!raw) return 0;
        const all: Array<{ date: string }> = JSON.parse(raw);
        return new Set(all.filter((m) => m.date >= cutoffStr).map((m) => m.date)).size;
      }).catch(() => 0),
      // User goals
      AsyncStorage.getItem('user_profile').then((raw) => {
        if (!raw) return { sleepGoal: 8, stepGoal: 10000, waterGoalOz: 80 };
        const p = JSON.parse(raw);
        return {
          sleepGoal:   parseFloat(p.sleepGoal) || 8,
          stepGoal:    parseInt(p.stepGoal, 10) || 10000,
          waterGoalOz: parseInt(p.goalOz, 10)  || 80,
        };
      }).catch(() => ({ sleepGoal: 8, stepGoal: 10000, waterGoalOz: 80 })),
      loadGratitudeEntries(),
      // Classes logged this week (yoga, gym, etc.)
      AsyncStorage.getItem('wellness_classes_history').then((raw) => {
        if (!raw) return 0;
        const all: Array<{ date: string }> = JSON.parse(raw);
        return all.filter((c) => c.date >= cutoffStr).length;
      }).catch(() => 0),
      // Recovery sessions logged today (sauna / cold plunge)
      AsyncStorage.getItem('wellness_log').then((raw) => {
        if (!raw) return 0;
        const { date, savedSessions } = JSON.parse(raw);
        return date === todayStr ? (savedSessions?.length ?? 0) : 0;
      }).catch(() => 0),
      // Water logged today
      AsyncStorage.getItem('manual_water').then((raw) => {
        if (!raw) return 0;
        const { date, oz } = JSON.parse(raw);
        return date === todayStr ? (oz ?? 0) : 0;
      }).catch(() => 0),
    ]).then(async ([token, workoutCounts, mealDays, goals, entries, classesThisWeek, recoveryToday, waterTodayOz]) => {
      let ouraWeek: OuraWeeklyDay[] = [];
      if (token) {
        try { ouraWeek = await fetchOuraWeekly(token, 7); } catch {}
      }
      const gratitudeDays = entries.filter((e) => e.date >= cutoffStr).length;
      setStoredEntries(entries);
      setWins(buildWeeklyWins(
        ouraWeek, workoutCounts.week, mealDays, gratitudeDays,
        classesThisWeek, recoveryToday, waterTodayOz, goals.waterGoalOz,
        goals.sleepGoal, goals.stepGoal,
      ));
    });
  }, [visible]);

  function handleClose() {
    setPhase('welcome');
    onClose();
  }

  function handleAfterBreathing() {
    if (storedEntries.length >= 12) {
      setPhase('gratitude-choice');
    } else {
      setPhase('gratitude');
    }
  }

  async function handleWriteDone(newTexts: string[]) {
    if (newTexts.length > 0) {
      const date = new Date().toISOString();
      const newEntries: GratitudeEntry[] = newTexts.map((text) => ({ text, date }));
      const updated = [...storedEntries, ...newEntries];
      setStoredEntries(updated);
      await saveGratitudeEntries(updated);
      trackEvent('gratitude_logged', { source_screen: 'grounding' });
    }
    setPhase('verse');
  }

  const scrollEnabled = phase === 'wins' || phase === 'gratitude-list';

  return (
    <GroundingPaletteContext.Provider value={pal}>
    <Modal visible={visible} animationType="fade" presentationStyle="pageSheet">
      <View style={[styles.container, { backgroundColor: pal.background }]}>
        <View style={[styles.header, { borderBottomColor: pal.divider, paddingTop: Spacing.three }]}>
          <ThemedText style={[styles.headerOverline, { color: pal.textSecondary }]}>Grounding</ThemedText>
          <TouchableOpacity onPress={handleClose} style={styles.closeBtn} activeOpacity={0.7}>
            <SymbolView name="xmark" size={16} tintColor={pal.textSecondary} weight="light" type="monochrome" />
          </TouchableOpacity>
        </View>

        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.scroll}
          scrollEnabled={scrollEnabled}
        >
          {phase === 'welcome' && (
            <View style={styles.welcomeContainer}>
              <ThemedText style={[styles.welcomeTitle, { color: pal.text }]}>Life is a beautiful gift.</ThemedText>
              <ThemedText style={[styles.welcomeBody, { color: pal.textSecondary }]}>
                A five-minute space just for you. Breathe, slow down, and be present.
              </ThemedText>
              <TouchableOpacity style={[styles.startBtn, { borderColor: pal.accent }]} onPress={() => { setPhase('breathing'); trackEvent('breathing_started', { source_screen: 'grounding' }); }} activeOpacity={0.8}>
                <ThemedText style={[styles.startBtnText, { color: pal.accent }]}>Begin</ThemedText>
              </TouchableOpacity>
            </View>
          )}

          {phase === 'breathing' && <BreathingExercise onDone={handleAfterBreathing} />}

          {phase === 'gratitude-choice' && (
            <GratitudeChoiceSection
              entryCount={storedEntries.length}
              onExercises={() => setPhase('gratitude')}
              onMyList={() => setPhase('gratitude-list')}
            />
          )}

          {phase === 'gratitude' && (
            <GratitudeSection onDone={() => setPhase('gratitude-write')} />
          )}

          {phase === 'gratitude-list' && (
            <GratitudeMyListSection
              entries={storedEntries}
              onContinue={() => setPhase('gratitude-write')}
            />
          )}

          {phase === 'gratitude-write' && (
            <GratitudeWriteSection onDone={handleWriteDone} />
          )}

          {phase === 'verse' && <VerseSection onDone={() => setPhase('wins')} />}

          {phase === 'wins' && <WinsSection wins={wins} onDone={handleClose} />}
        </ScrollView>
      </View>
    </Modal>
    </GroundingPaletteContext.Provider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.three,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerOverline: { fontSize: 9, letterSpacing: 3, textTransform: 'uppercase', fontFamily: Fonts.serif },
  closeBtn: { padding: 4 },
  scroll: {
    paddingTop: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.six,
  },
  welcomeContainer: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingTop: Spacing.six, gap: Spacing.three,
  },
  welcomeTitle: { fontFamily: Fonts.serif, fontSize: 32, fontStyle: 'italic', fontWeight: '400', lineHeight: 40, textAlign: 'center', paddingTop: 6, paddingRight: 4 },
  welcomeBody:  { fontSize: 16, textAlign: 'center', lineHeight: 25, paddingHorizontal: Spacing.two },
  startBtn:     { marginTop: Spacing.three, borderWidth: StyleSheet.hairlineWidth, paddingVertical: 14, paddingHorizontal: 60 },
  startBtnText: { fontFamily: Fonts.serif, fontSize: 18, fontStyle: 'italic' },
});
