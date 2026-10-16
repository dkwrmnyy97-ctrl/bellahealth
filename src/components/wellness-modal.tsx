import AsyncStorage from '@react-native-async-storage/async-storage';
import { appendWellnessSessionHistory } from '@/services/context-events';
import { SymbolView } from 'expo-symbols';
import React, { useContext, useEffect, useState } from 'react';
import { Modal, ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Fonts, Spacing } from '@/constants/theme';
import { useAppTheme } from '@/context/theme-context';
import { getModalPalette, type ModalPalette } from '@/utils/modal-palette';
import { trackEvent } from '@/services/analytics';
import { localDateString } from '@/utils/local-date';

// Universal functional colors — not gender/mode specific
const SAUNA_COLOR = '#E8C98A';
const COLD_COLOR  = '#9EC8D8';
const CLASS_COLOR = '#C4B7D4';

// Palette context — all sub-components read from this
const WellnessPaletteContext = React.createContext<ModalPalette>({
  background: '#FAF5F0', card: '#FFFFFF', text: '#2D1B1B', textSecondary: '#8B6B6B',
  divider: '#F0E4E0', shadow: 'rgba(180,140,130,0.22)', accent: '#C17B8E',
  accentBtn: '#A85878', plus: '#7A9E78', minus: '#C17B8E', viz: '#C17B8E',
});

// ─── Types ────────────────────────────────────────────────────────────────────

type SessionType = 'sauna' | 'cold_plunge';
type ClassType = 'yoga' | 'pilates' | 'hiit' | 'dance' | 'other';

type Session = {
  type: SessionType;
  minutes: number;
  timestamp: string;
};

type ClassEntry = {
  classType: ClassType;
  heated: boolean;
  linkedWorkout: WatchSession | null;
  timestamp: string;
  date?: string;
};

type WatchSession = {
  id: string;
  name: string;
  duration: number;
  time: string;
  calories: number;
};

const WELLNESS_KEY = 'wellness_log';
const CLASSES_HISTORY_KEY = 'wellness_classes_history';
// Uses local calendar date — toISOString().split('T')[0] returns UTC and would
// place late-evening sessions on the wrong (next) day for US-timezone users.
const today = () => localDateString();

const SESSION_ICONS: Record<SessionType, string> = {
  sauna:       'flame',
  cold_plunge: 'snowflake',
};

const classConfig: Record<ClassType, { label: string }> = {
  yoga:    { label: 'Yoga' },
  pilates: { label: 'Pilates' },
  hiit:    { label: 'HIIT' },
  dance:   { label: 'Dance' },
  other:   { label: 'Other' },
};

// ─── Recovery insights ────────────────────────────────────────────────────────

type Insight = { label: string; text: string };

function getSaunaInsights(minutes: number, postWorkout: boolean, timeOfDay: 'morning' | 'afternoon' | 'evening'): Insight[] {
  const insights: Insight[] = [];
  insights.push({
    label: 'HRV & Recovery',
    text: `${minutes} minutes of sauna triggers heat shock proteins that support cellular repair. Expect your Oura recovery score to reflect this over the next 1-2 days.`,
  });
  if (postWorkout) {
    insights.push({
      label: 'Post-Workout Benefit',
      text: 'Sauna after training amplifies cardiovascular adaptation and can increase growth hormone release. One of the highest-ROI recovery habits.',
    });
  }
  if (timeOfDay === 'evening') {
    insights.push({
      label: 'Sleep Timing',
      text: "Evening sauna is great for sleep — but finish at least 60-90 minutes before bed so your core temp has time to drop. The cooling process signals your body it's time to sleep.",
    });
  } else if (timeOfDay === 'morning') {
    insights.push({
      label: 'Morning Sauna',
      text: "Morning sauna raises cortisol naturally (the good kind) and primes your cardiovascular system for the day. Stay hydrated — your body's already slightly dehydrated from sleep.",
    });
  }
  insights.push({
    label: 'Hydration',
    text: `Add at least ${Math.round(minutes * 0.5)} oz of water to your intake today to compensate for what you sweated out.`,
  });
  return insights;
}

function getColdPlungeInsights(minutes: number, postWorkout: boolean, timeOfDay: 'morning' | 'afternoon' | 'evening'): Insight[] {
  const insights: Insight[] = [];
  insights.push({
    label: 'Recovery & Inflammation',
    text: `Cold exposure reduces systemic inflammation and activates brown fat. Even ${minutes} minutes produces measurable benefits to soreness and circulation.`,
  });
  insights.push({
    label: 'Mood & Focus',
    text: 'Cold plunges significantly boost norepinephrine (up to 300%) — the neurotransmitter responsible for focus, alertness, and mood. Expect elevated energy over the next few hours.',
  });
  if (postWorkout) {
    insights.push({
      label: 'Timing Note',
      text: "Cold immediately after strength training can blunt muscle protein synthesis. If muscle building is the goal, wait 2+ hours post-lift. For cardio or endurance recovery, timing is fine.",
    });
  }
  if (timeOfDay === 'morning') {
    insights.push({
      label: 'Morning Boost',
      text: 'Perfect timing. Morning cold exposure sets your cortisol rhythm, boosts alertness, and gives you a mood and energy edge for the day.',
    });
  }
  return insights;
}

// ─── Sub-components ────────────────────────────────────────────────────────────

function InsightEntry({ label, text }: Insight) {
  const pal = useContext(WellnessPaletteContext);
  return (
    <View style={[entryStyles.container, { borderTopColor: pal.divider }]}>
      <ThemedText style={[entryStyles.label, { color: pal.textSecondary }]}>{label}</ThemedText>
      <ThemedText style={[entryStyles.text, { color: pal.text }]}>{text}</ThemedText>
    </View>
  );
}

const entryStyles = StyleSheet.create({
  container: { padding: Spacing.three, borderTopWidth: StyleSheet.hairlineWidth, gap: 4 },
  label:     { fontSize: 9, letterSpacing: 2.5, textTransform: 'uppercase' },
  text:      { fontFamily: Fonts.serif, fontSize: 14, fontStyle: 'italic', lineHeight: 21 },
});

function SectionDivider({ label }: { label: string }) {
  const pal = useContext(WellnessPaletteContext);
  return (
    <View style={divStyles.container}>
      <View style={[divStyles.line, { backgroundColor: pal.divider }]} />
      <ThemedText style={[divStyles.label, { color: pal.textSecondary }]}>{label}</ThemedText>
      <View style={[divStyles.line, { backgroundColor: pal.divider }]} />
    </View>
  );
}

const divStyles = StyleSheet.create({
  container: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  line:      { flex: 1, height: StyleSheet.hairlineWidth },
  label:     { fontSize: 9, letterSpacing: 2.5, textTransform: 'uppercase' },
});

function TodayLog({ sessions, classes }: { sessions: Session[]; classes: ClassEntry[] }) {
  const pal = useContext(WellnessPaletteContext);
  if (sessions.length === 0 && classes.length === 0) return null;
  return (
    <View style={logStyles.section}>
      <ThemedText style={[logStyles.title, { color: pal.textSecondary }]}>Today's Log</ThemedText>
      {sessions.map((s, i) => {
        const color = s.type === 'sauna' ? SAUNA_COLOR : COLD_COLOR;
        const label = s.type === 'sauna' ? 'Sauna' : 'Cold Plunge';
        return (
          <View key={`s${i}`} style={[logStyles.row, { borderBottomColor: pal.divider }]}>
            <View style={[logStyles.dot, { backgroundColor: color }]} />
            <ThemedText style={[logStyles.text, { color: pal.text }]}>{label} · {s.minutes} min</ThemedText>
            <ThemedText style={[logStyles.time, { color: pal.textSecondary }]}>{s.timestamp}</ThemedText>
          </View>
        );
      })}
      {classes.map((c, i) => {
        const cfg = classConfig[c.classType];
        return (
          <View key={`c${i}`} style={[logStyles.row, { borderBottomColor: pal.divider }]}>
            <View style={[logStyles.dot, { backgroundColor: CLASS_COLOR }]} />
            <ThemedText style={[logStyles.text, { color: pal.text }]}>
              {cfg.label}{c.heated ? ' · Heated' : ''}{c.linkedWorkout ? ` · ${c.linkedWorkout.duration} min` : ''}
            </ThemedText>
            <ThemedText style={[logStyles.time, { color: pal.textSecondary }]}>{c.timestamp}</ThemedText>
          </View>
        );
      })}
    </View>
  );
}

const logStyles = StyleSheet.create({
  section: { gap: Spacing.one },
  title: { fontSize: 9, letterSpacing: 2.5, textTransform: 'uppercase', marginBottom: 4 },
  row:   { flexDirection: 'row', alignItems: 'center', gap: Spacing.two, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  dot:   { width: 6, height: 6, borderRadius: 3, flexShrink: 0 },
  text:  { flex: 1, fontSize: 14 },
  time:  { fontSize: 12 },
});

function ClassHistoryList({ history }: { history: ClassEntry[] }) {
  const pal = useContext(WellnessPaletteContext);
  if (history.length === 0) return null;

  function friendlyDate(dateStr?: string): string {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T12:00:00');
    const t = new Date();
    const diff = Math.round((t.getTime() - d.getTime()) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  return (
    <View style={[histStyles.container, { borderColor: pal.divider }]}>
      <ThemedText style={[histStyles.title, { color: pal.textSecondary }]}>Class History</ThemedText>
      {history.map((entry, i) => {
        const cfg = classConfig[entry.classType];
        return (
          <View key={i} style={[histStyles.row, { borderTopColor: pal.divider }]}>
            <View style={histStyles.rowLeft}>
              <ThemedText style={[histStyles.label, { color: pal.text }]}>
                {cfg.label}{entry.heated ? ' · Heated' : ''}
              </ThemedText>
              {entry.linkedWorkout && (
                <ThemedText style={[histStyles.detail, { color: pal.textSecondary }]}>
                  {entry.linkedWorkout.name} · {entry.linkedWorkout.duration} min · {entry.linkedWorkout.calories} kcal
                </ThemedText>
              )}
            </View>
            <ThemedText style={[histStyles.date, { color: pal.textSecondary }]}>{friendlyDate(entry.date)}</ThemedText>
          </View>
        );
      })}
    </View>
  );
}

const histStyles = StyleSheet.create({
  container: { borderWidth: StyleSheet.hairlineWidth },
  title:     { fontSize: 9, letterSpacing: 2.5, textTransform: 'uppercase', padding: Spacing.three, paddingBottom: Spacing.two },
  row:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: Spacing.three, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth },
  rowLeft:   { flex: 1 },
  label:     { fontSize: 14 },
  detail:    { fontSize: 12, marginTop: 2 },
  date:      { fontSize: 12, flexShrink: 0, marginLeft: Spacing.two },
});

// ─── Main Modal ───────────────────────────────────────────────────────────────

type Props = {
  visible: boolean;
  onClose: () => void;
  postWorkout: boolean;
  watchSessions?: WatchSession[];
};

export function WellnessModal({ visible, onClose, postWorkout, watchSessions = [] }: Props) {
  const { isDark, userTheme } = useAppTheme();
  const pal = getModalPalette(isDark, userTheme);

  const [selectedType, setSelectedType] = useState<SessionType | null>(null);
  const [minutes, setMinutes] = useState(15);
  const [sessions, setSessions] = useState<Session[]>([]);

  const [selectedClass, setSelectedClass] = useState<ClassType | null>(null);
  const [heated, setHeated] = useState<boolean | null>(null);
  const [linkedWorkout, setLinkedWorkout] = useState<WatchSession | null>(null);
  const [loggedClasses, setLoggedClasses] = useState<ClassEntry[]>([]);
  const [classHistory, setClassHistory] = useState<ClassEntry[]>([]);

  useEffect(() => {
    if (!visible) return;
    AsyncStorage.getItem(WELLNESS_KEY).then((raw) => {
      if (!raw) return;
      const { date, savedSessions, savedClasses } = JSON.parse(raw);
      if (date === today()) {
        setSessions(savedSessions ?? []);
        setLoggedClasses(savedClasses ?? []);
      }
    });
    AsyncStorage.getItem(CLASSES_HISTORY_KEY).then((raw) => {
      if (!raw) return;
      const all: ClassEntry[] = JSON.parse(raw);
      setClassHistory(all.slice(-30).reverse());
    });
  }, [visible]);

  const hour = new Date().getHours();
  const timeOfDay: 'morning' | 'afternoon' | 'evening' =
    hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';

  const recoveryInsights =
    selectedType === 'sauna'
      ? getSaunaInsights(minutes, postWorkout, timeOfDay)
      : selectedType === 'cold_plunge'
      ? getColdPlungeInsights(minutes, postWorkout, timeOfDay)
      : [];

  const showWatchPicker = selectedClass && selectedClass !== 'other';

  function logSession() {
    if (!selectedType) return;
    const sessionType = selectedType;
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const newSession = { type: sessionType, minutes, timestamp };
    const next = [...sessions, newSession];
    setSessions(next);
    AsyncStorage.setItem(WELLNESS_KEY, JSON.stringify({ date: today(), savedSessions: next, savedClasses: loggedClasses }));
    // Append to historical log for context engine
    appendWellnessSessionHistory({ date: today(), type: sessionType, minutes, timestamp }).catch(() => {});
    trackEvent('recovery_logged', { source_screen: 'wellness' });
    setSelectedType(null);
    setMinutes(15);
  }

  function logClass() {
    if (!selectedClass || heated === null) return;
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const newEntry: ClassEntry = { classType: selectedClass, heated, linkedWorkout, timestamp, date: today() };
    const nextToday = [...loggedClasses, newEntry];
    setLoggedClasses(nextToday);
    AsyncStorage.setItem(WELLNESS_KEY, JSON.stringify({ date: today(), savedSessions: sessions, savedClasses: nextToday }));
    AsyncStorage.getItem(CLASSES_HISTORY_KEY).then((raw) => {
      const all: ClassEntry[] = raw ? JSON.parse(raw) : [];
      const updated = [...all, newEntry];
      AsyncStorage.setItem(CLASSES_HISTORY_KEY, JSON.stringify(updated));
      setClassHistory(updated.slice(-30).reverse());
    });
    setSelectedClass(null);
    setHeated(null);
    setLinkedWorkout(null);
  }

  function handleClose() {
    setSelectedType(null);
    setMinutes(15);
    setSelectedClass(null);
    setHeated(null);
    setLinkedWorkout(null);
    onClose();
  }

  const recoveryColor = selectedType === 'sauna' ? SAUNA_COLOR : selectedType === 'cold_plunge' ? COLD_COLOR : pal.accent;

  return (
    <WellnessPaletteContext.Provider value={pal}>
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <View style={[styles.container, { backgroundColor: pal.background, paddingTop: Spacing.three }]}>

        <View style={[styles.header, { borderBottomColor: pal.divider }]}>
          <ThemedText style={[styles.title, { color: pal.text }]}>Treat yourself</ThemedText>
          <TouchableOpacity onPress={handleClose} activeOpacity={0.7}>
            <ThemedText style={[styles.doneBtn, { color: pal.accent }]}>Done</ThemedText>
          </TouchableOpacity>
        </View>

        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>

          <TodayLog sessions={sessions} classes={loggedClasses} />

          <SectionDivider label="Recovery" />

          {/* Type selector */}
          <View style={styles.typeRow}>
            {(['sauna', 'cold_plunge'] as SessionType[]).map((type) => {
              const color = type === 'sauna' ? SAUNA_COLOR : COLD_COLOR;
              const label = type === 'sauna' ? 'Sauna' : 'Cold Plunge';
              const isSelected = selectedType === type;
              return (
                <TouchableOpacity
                  key={type}
                  style={[
                    styles.typeCard,
                    { borderColor: isSelected ? color : pal.divider },
                  ]}
                  onPress={() => setSelectedType(isSelected ? null : type)}
                  activeOpacity={0.7}
                >
                  <SymbolView
                    name={SESSION_ICONS[type] as any}
                    size={15}
                    tintColor={isSelected ? color : pal.textSecondary}
                    weight="thin"
                    type="monochrome"
                    style={{ marginBottom: 5 }}
                  />
                  <ThemedText style={[styles.typeLabel, { color: isSelected ? color : pal.textSecondary }]}>
                    {label}
                  </ThemedText>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Duration */}
          {selectedType && (
            <View style={[styles.durationSection, { borderColor: pal.divider }]}>
              <ThemedText style={[styles.overline, { color: pal.textSecondary }]}>Duration</ThemedText>
              <View style={styles.durationControls}>
                <TouchableOpacity
                  style={[styles.durationBtn, { borderColor: pal.divider }]}
                  onPress={() => setMinutes((m) => Math.max(m - 5, 5))}
                  activeOpacity={0.7}
                >
                  <ThemedText style={[styles.durationBtnText, { color: pal.text }]}>−</ThemedText>
                </TouchableOpacity>
                <View style={styles.durationDisplay}>
                  <ThemedText style={[styles.durationMinutes, { color: pal.text }]}>{minutes}</ThemedText>
                  <ThemedText style={[styles.durationUnit, { color: pal.textSecondary }]}>min</ThemedText>
                </View>
                <TouchableOpacity
                  style={[styles.durationBtn, { borderColor: pal.divider }]}
                  onPress={() => setMinutes((m) => Math.min(m + 5, 120))}
                  activeOpacity={0.7}
                >
                  <ThemedText style={[styles.durationBtnText, { color: pal.text }]}>+</ThemedText>
                </TouchableOpacity>
              </View>
            </View>
          )}

          <TouchableOpacity
            style={[styles.logButton, { borderColor: recoveryColor, opacity: selectedType ? 1 : 0.3 }]}
            onPress={logSession}
            disabled={!selectedType}
            activeOpacity={0.8}
          >
            <ThemedText style={[styles.logButtonText, { color: recoveryColor }]}>Log Recovery Session</ThemedText>
          </TouchableOpacity>

          {/* Insights */}
          {recoveryInsights.length > 0 && (
            <View style={[styles.insightBlock, { borderColor: pal.divider }]}>
              <ThemedText style={[styles.overline, { color: pal.textSecondary, padding: Spacing.three, paddingBottom: 0 }]}>
                What This Does For You
              </ThemedText>
              {recoveryInsights.map((ins, i) => <InsightEntry key={i} {...ins} />)}
            </View>
          )}

          {/* Contrast therapy note */}
          {sessions.some((s) => s.type === 'sauna') && sessions.some((s) => s.type === 'cold_plunge') && (
            <View style={[styles.contrastCard, { borderColor: pal.divider }]}>
              <ThemedText style={[styles.contrastText, { color: pal.text }]}>
                Contrast therapy logged today. Alternating heat and cold is one of the most powerful recovery protocols — expect a strong Oura readiness score tomorrow.
              </ThemedText>
            </View>
          )}

          <SectionDivider label="Log a Class" />

          {/* Class grid */}
          <View style={styles.classGrid}>
            {(Object.keys(classConfig) as ClassType[]).map((ct) => {
              const cfg = classConfig[ct];
              const isSelected = selectedClass === ct;
              return (
                <TouchableOpacity
                  key={ct}
                  style={[
                    styles.classCard,
                    { borderColor: isSelected ? CLASS_COLOR : pal.divider },
                  ]}
                  onPress={() => { setSelectedClass(isSelected ? null : ct); setHeated(null); setLinkedWorkout(null); }}
                  activeOpacity={0.7}
                >
                  <ThemedText style={[styles.classCardLabel, { color: isSelected ? CLASS_COLOR : pal.textSecondary }]}>
                    {cfg.label}
                  </ThemedText>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Heated toggle */}
          {selectedClass && (
            <View style={[styles.toggleSection, { borderColor: pal.divider }]}>
              <ThemedText style={[styles.overline, { color: pal.textSecondary }]}>Heated or infrared?</ThemedText>
              <View style={styles.toggleOptions}>
                {[true, false].map((val) => (
                  <TouchableOpacity
                    key={String(val)}
                    style={[
                      styles.toggleBtn,
                      { borderColor: heated === val ? (val ? SAUNA_COLOR : CLASS_COLOR) : pal.divider },
                    ]}
                    onPress={() => setHeated(val)}
                    activeOpacity={0.7}
                  >
                    <ThemedText style={[
                      styles.toggleBtnText,
                      { color: heated === val ? (val ? SAUNA_COLOR : CLASS_COLOR) : pal.textSecondary },
                    ]}>
                      {val ? 'Yes' : 'No'}
                    </ThemedText>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          )}

          {/* Watch session picker */}
          {showWatchPicker && heated !== null && watchSessions.length > 0 && (
            <View style={[styles.watchSection, { borderColor: pal.divider }]}>
              <ThemedText style={[styles.overline, { color: pal.textSecondary }]}>
                Link an Apple Watch Session
                {'  '}<ThemedText style={[styles.overlineOptional, { color: pal.textSecondary }]}>optional</ThemedText>
              </ThemedText>
              {watchSessions.map((ws) => {
                const isLinked = linkedWorkout?.id === ws.id;
                return (
                  <TouchableOpacity
                    key={ws.id}
                    style={[
                      styles.watchRow,
                      { borderTopColor: pal.divider },
                      isLinked && { backgroundColor: CLASS_COLOR + '18' },
                    ]}
                    onPress={() => setLinkedWorkout(isLinked ? null : ws)}
                    activeOpacity={0.7}
                  >
                    <View style={styles.watchRowLeft}>
                      <ThemedText style={[styles.watchName, { color: pal.text }]}>{ws.name}</ThemedText>
                      <ThemedText style={[styles.watchDetail, { color: pal.textSecondary }]}>
                        {ws.time} · {ws.duration} min · {ws.calories} kcal
                      </ThemedText>
                    </View>
                    {isLinked && <ThemedText style={[styles.watchCheck, { color: CLASS_COLOR }]}>✓</ThemedText>}
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          {/* Log class button */}
          {selectedClass && (
            <TouchableOpacity
              style={[styles.logButton, { borderColor: CLASS_COLOR, opacity: heated !== null ? 1 : 0.3 }]}
              onPress={logClass}
              disabled={heated === null}
              activeOpacity={0.8}
            >
              <ThemedText style={[styles.logButtonText, { color: CLASS_COLOR }]}>Log Class</ThemedText>
            </TouchableOpacity>
          )}

          <ClassHistoryList history={classHistory} />

          {/* Coming soon */}
          <View style={[styles.comingSoonCard, { borderColor: pal.divider }]}>
            <ThemedText style={[styles.comingSoonTitle, { color: pal.textSecondary }]}>Studio Integrations — Coming Soon</ThemedText>
            <ThemedText style={[styles.comingSoonText, { color: pal.textSecondary }]}>
              Solidcore, Club Pilates, CorePower, Barry's, and others — sync your class bookings and check-ins directly into BellaHealth.
            </ThemedText>
          </View>

        </ScrollView>
      </View>
    </Modal>
    </WellnessPaletteContext.Provider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: Spacing.three, paddingBottom: Spacing.three,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title:   { fontFamily: Fonts.serif, fontSize: 26, fontStyle: 'italic', fontWeight: '400', paddingTop: 3, paddingRight: 4 },
  doneBtn: { fontSize: 14, letterSpacing: 0.3 },
  scroll:  { gap: Spacing.three, paddingHorizontal: Spacing.three, paddingTop: Spacing.three, paddingBottom: Spacing.six },

  overline: { fontSize: 9, letterSpacing: 2.5, textTransform: 'uppercase' },
  overlineOptional: { fontSize: 9, fontStyle: 'italic', letterSpacing: 0 },

  typeRow:  { flexDirection: 'row', gap: Spacing.two },
  typeCard: {
    flex: 1, alignItems: 'center', paddingVertical: Spacing.two + 4,
    borderWidth: StyleSheet.hairlineWidth,
  },
  typeLabel: { fontFamily: Fonts.serif, fontSize: 16, fontStyle: 'italic' },

  durationSection: {
    borderWidth: StyleSheet.hairlineWidth, padding: Spacing.three, gap: Spacing.two,
  },
  durationControls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.four },
  durationBtn: { width: 44, height: 44, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  durationBtnText: { fontSize: 22, fontWeight: '300', lineHeight: 26 },
  durationDisplay: { alignItems: 'center', minWidth: 64 },
  durationMinutes: { fontFamily: Fonts.serif, fontSize: 40, fontStyle: 'italic', fontWeight: '400', lineHeight: 44, paddingTop: 8, paddingRight: 6 },
  durationUnit:    { fontSize: 13 },

  logButton:     { borderWidth: StyleSheet.hairlineWidth, paddingVertical: 16, alignItems: 'center' },
  logButtonText: { fontFamily: Fonts.serif, fontSize: 16, fontStyle: 'italic' },

  insightBlock: { borderWidth: StyleSheet.hairlineWidth },

  contrastCard: { borderWidth: StyleSheet.hairlineWidth, padding: Spacing.three },
  contrastText: { fontFamily: Fonts.serif, fontSize: 13, fontStyle: 'italic', lineHeight: 20 },

  classGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.one },
  classCard: {
    width: '31%', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 14, borderWidth: StyleSheet.hairlineWidth,
  },
  classCardLabel: { fontFamily: Fonts.serif, fontSize: 13, fontStyle: 'italic' },

  toggleSection: { borderWidth: StyleSheet.hairlineWidth, padding: Spacing.three, gap: Spacing.two },
  toggleOptions: { flexDirection: 'row', gap: Spacing.one },
  toggleBtn:     { flex: 1, paddingVertical: 10, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center' },
  toggleBtnText: { fontFamily: Fonts.serif, fontSize: 15, fontStyle: 'italic' },

  watchSection: { borderWidth: StyleSheet.hairlineWidth },
  watchRow: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 12,
    paddingHorizontal: Spacing.three, borderTopWidth: StyleSheet.hairlineWidth,
  },
  watchRowLeft: { flex: 1, gap: 2 },
  watchName:    { fontSize: 14 },
  watchDetail:  { fontSize: 12 },
  watchCheck:   { fontSize: 16 },

  comingSoonCard:  { borderWidth: StyleSheet.hairlineWidth, padding: Spacing.three, gap: 4 },
  comingSoonTitle: { fontSize: 9, letterSpacing: 2.5, textTransform: 'uppercase' },
  comingSoonText:  { fontFamily: Fonts.serif, fontSize: 13, fontStyle: 'italic', lineHeight: 19 },
});
