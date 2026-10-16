import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useEffect, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Fonts, Spacing } from '@/constants/theme';
import { getOuraToken, fetchOuraPeriodStart } from '@/services/oura';
import { useAppTheme } from '@/context/theme-context';
import { getModalPalette } from '@/utils/modal-palette';
import { trackEvent } from '@/services/analytics';
import { buildCycleContext } from '@/utils/cycle-context';
import type { CycleEntry, CycleProfile } from '@/utils/cycle-context';

// Re-export for consumers that import from this module
export type { CycleEntry, CycleProfile };
export { buildCycleContext };

export const CYCLE_JOURNAL_KEY = 'cycle_journal';
export const CYCLE_PROFILE_KEY = 'cycle_profile';

export async function loadCycleEntries(): Promise<CycleEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(CYCLE_JOURNAL_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function loadCycleProfile(): Promise<CycleProfile> {
  try {
    const raw = await AsyncStorage.getItem(CYCLE_PROFILE_KEY);
    return raw ? JSON.parse(raw) : { lastPeriodDate: null };
  } catch {
    return { lastPeriodDate: null };
  }
}

const ENERGY_OPTS = [
  { value: 1, label: 'Drained' },
  { value: 2, label: 'Tired'   },
  { value: 3, label: 'Okay'    },
  { value: 4, label: 'Good'    },
  { value: 5, label: 'Great'   },
];

const STRESS_OPTS = [
  { value: 1, label: 'Calm'     },
  { value: 2, label: 'Mild'     },
  { value: 3, label: 'Moderate' },
  { value: 4, label: 'High'     },
  { value: 5, label: 'Very High' },
];

const SIGNS = [
  'Light flow',
  'Medium flow',
  'Heavy flow',
  'Light spotting',
  'Heavier spotting',
  'Discharge changes',
  'Cramping',
  'Breast tenderness',
  'Mood shifts',
  'Bloating',
];

// ─── Sub-components ───────────────────────────────────────────────────────────

function ScaleRow({
  label,
  options,
  selected,
  onSelect,
  accent,
  pal,
}: {
  label: string;
  options: { value: number; label: string }[];
  selected: number | null;
  onSelect: (v: number) => void;
  accent: string;
  pal: ReturnType<typeof getModalPalette>;
}) {
  return (
    <View style={[styles.scaleSection, { borderColor: pal.divider }]}>
      <ThemedText style={[styles.scaleLabel, { color: pal.textSecondary }]}>{label}</ThemedText>
      <View style={styles.scaleRow}>
        {options.map((opt) => {
          const active = selected === opt.value;
          return (
            <TouchableOpacity
              key={opt.value}
              style={[
                styles.scaleChip,
                { borderColor: pal.divider, backgroundColor: pal.background },
                active && { backgroundColor: accent + '18', borderColor: accent },
              ]}
              onPress={() => onSelect(opt.value)}
              activeOpacity={0.7}
            >
              <ThemedText style={[styles.scaleChipLabel, { color: active ? accent : pal.textSecondary }]}>{opt.label}</ThemedText>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

// ─── Main Modal ───────────────────────────────────────────────────────────────

type Props = {
  visible: boolean;
  onClose: () => void;
  onEntrySaved?: () => void;
};

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function daysSince(dateStr: string) {
  // T00:00:00 = local midnight, so "today" = 0, "yesterday" = 1, never negative
  return Math.floor((Date.now() - new Date(dateStr + 'T00:00:00').getTime()) / 86400000);
}

export function CycleModal({ visible, onClose, onEntrySaved }: Props) {
  const { isDark, userTheme } = useAppTheme();
  const pal = getModalPalette(isDark, userTheme);
  const dynPalette = pal; // alias kept for compatibility

  const [view, setView] = useState<'log' | 'history' | 'setup'>('log');
  const [energy, setEnergy] = useState<number | null>(null);
  const [stress, setStress] = useState<number | null>(null);
  const [signs, setSigns] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [entries, setEntries] = useState<CycleEntry[]>([]);
  const [profile, setProfile] = useState<CycleProfile>({ lastPeriodDate: null });
  const [lastPeriodInput, setLastPeriodInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [ouraSynced, setOuraSynced] = useState<string | null>(null); // date synced from Oura

  const today = todayStr();
  const todayEntry = entries.find((e) => e.date === today);

  useEffect(() => {
    if (!visible) return;
    loadCycleEntries().then(setEntries).catch(() => {});
    loadCycleProfile().then(async (p) => {
      // Try Oura first — it's the primary source
      try {
        const token = await getOuraToken();
        if (token) {
          const ouraDate = await fetchOuraPeriodStart(token);
          if (ouraDate) {
            // Use Oura date if it's more recent than what's stored locally
            const isNewer = !p.lastPeriodDate || ouraDate > p.lastPeriodDate;
            if (isNewer) {
              const updated: CycleProfile = { lastPeriodDate: ouraDate };
              setProfile(updated);
              await AsyncStorage.setItem(CYCLE_PROFILE_KEY, JSON.stringify(updated));
              setOuraSynced(ouraDate);
              return;
            }
            // Oura matches or is older — still mark as synced
            setOuraSynced(ouraDate);
          }
        }
      } catch {}
      setProfile(p);
      if (!p.lastPeriodDate) setView('setup');
    }).catch(() => {});
  }, [visible]);

  // Pre-fill if today already logged
  useEffect(() => {
    if (todayEntry) {
      setEnergy(todayEntry.energy);
      setStress(todayEntry.stress);
      setSigns(todayEntry.signs);
      setNotes(todayEntry.notes);
    } else {
      setEnergy(null);
      setStress(null);
      setSigns([]);
      setNotes('');
    }
  }, [entries]);

  function toggleSign(s: string) {
    setSigns((prev) => prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]);
  }

  async function handleSave() {
    if (energy === null || stress === null) {
      Alert.alert('Almost there', 'Please select an energy and stress level before saving.');
      return;
    }
    setSaving(true);
    try {
      const entry: CycleEntry = { date: today, energy, stress, signs, notes };
      const updated = [...entries.filter((e) => e.date !== today), entry]
        .sort((a, b) => a.date.localeCompare(b.date));
      setEntries(updated);
      await AsyncStorage.setItem(CYCLE_JOURNAL_KEY, JSON.stringify(updated));
      trackEvent('daily_checkin_completed', { source_screen: 'cycle' });
      onEntrySaved?.();
      setView('history');
    } catch {
      Alert.alert('Error', 'Could not save entry. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  async function handleMarkPeriodToday() {
    const updated: CycleProfile = { lastPeriodDate: today };
    setProfile(updated);
    setOuraSynced(null);
    await AsyncStorage.setItem(CYCLE_PROFILE_KEY, JSON.stringify(updated));
    Alert.alert('Period logged', `Day 1 marked as ${formatDate(today)}.`);
  }

  async function saveLastPeriod() {
    const trimmed = lastPeriodInput.trim();
    if (!trimmed) {
      Alert.alert('', 'Please enter your last period date, or tap Skip.');
      return;
    }
    const updated: CycleProfile = { lastPeriodDate: trimmed };
    setProfile(updated);
    setOuraSynced(null);
    await AsyncStorage.setItem(CYCLE_PROFILE_KEY, JSON.stringify(updated));
    setView('log');
  }

  function handleClose() {
    setView('log');
    onClose();
  }

  const dayCount = profile.lastPeriodDate ? daysSince(profile.lastPeriodDate) : null;

  // ── Setup screen ──────────────────────────────────────────────────────────

  if (view === 'setup') {
    return (
      <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
        <View style={[styles.container, { backgroundColor: dynPalette.background, paddingTop: Spacing.three }]}>
          <View style={styles.header}>
            <ThemedText style={[styles.title, { color: dynPalette.text }]}>Cycle & Hormones</ThemedText>
            <TouchableOpacity onPress={handleClose} activeOpacity={0.7}>
              <ThemedText style={[styles.doneBtn, { color: dynPalette.accent }]}>Done</ThemedText>
            </TouchableOpacity>
          </View>
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>
            <View style={[styles.setupCard, { borderColor: pal.divider }]}>
              <ThemedText style={[styles.setupTitle, { color: pal.text }]}>Let's start tracking</ThemedText>
              <ThemedText style={[styles.setupSubtitle, { color: pal.textSecondary }]}>
                When was your last period? This helps us measure progress and give better insights.
              </ThemedText>
              <TextInput
                style={[styles.setupInput, { backgroundColor: pal.background, color: pal.text, borderColor: pal.divider }]}
                placeholder="e.g. 2025-08-01"
                placeholderTextColor={pal.textSecondary}
                value={lastPeriodInput}
                onChangeText={setLastPeriodInput}
                autoCapitalize="none"
                keyboardType="numbers-and-punctuation"
              />
              <ThemedText style={[styles.setupHint, { color: pal.textSecondary }]}>Format: YYYY-MM-DD (year-month-day)</ThemedText>
              <TouchableOpacity
                style={[styles.flatBtn, { borderColor: pal.accent }]}
                onPress={saveLastPeriod}
                activeOpacity={0.8}
              >
                <ThemedText style={[styles.flatBtnText, { color: pal.accent }]}>Save & Continue →</ThemedText>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.skipBtn}
                onPress={() => {
                  setProfile({ lastPeriodDate: null });
                  setView('log');
                }}
                activeOpacity={0.7}
              >
                <ThemedText style={[styles.skipText, { color: pal.textSecondary }]}>Skip for now</ThemedText>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </Modal>
    );
  }

  // ── History screen ────────────────────────────────────────────────────────

  if (view === 'history') {
    const recent = [...entries].reverse().slice(0, 14);
    return (
      <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
        <View style={[styles.container, { backgroundColor: dynPalette.background, paddingTop: Spacing.three }]}>
          <View style={styles.header}>
            <ThemedText style={[styles.title, { color: dynPalette.text }]}>Cycle & Hormones</ThemedText>
            <TouchableOpacity onPress={handleClose} activeOpacity={0.7}>
              <ThemedText style={[styles.doneBtn, { color: dynPalette.accent }]}>Done</ThemedText>
            </TouchableOpacity>
          </View>
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>

            {dayCount !== null && (
              <View style={[styles.dayCountCard, { borderColor: pal.accent + '40' }]}>
                <ThemedText style={[styles.dayCountNumber, { color: pal.accent }]}>Day {dayCount + 1}</ThemedText>
                <ThemedText style={[styles.dayCountLabel, { color: pal.textSecondary }]}>of your cycle</ThemedText>
                <TouchableOpacity onPress={() => setView('setup')} activeOpacity={0.7}>
                  <ThemedText style={[styles.dayCountEdit, { color: pal.accent }]}>Update date →</ThemedText>
                </TouchableOpacity>
              </View>
            )}

            <TouchableOpacity
              style={[styles.flatBtn, { borderColor: pal.accent }]}
              onPress={() => setView('log')}
              activeOpacity={0.8}
            >
              <ThemedText style={[styles.flatBtnText, { color: pal.accent }]}>
                {todayEntry ? 'Edit Today\'s Check-In →' : 'Log Today\'s Check-In →'}
              </ThemedText>
            </TouchableOpacity>

            {recent.length === 0 ? (
              <View style={styles.emptyState}>
                <ThemedText style={[styles.emptyText, { color: pal.textSecondary }]}>No entries yet. Start by logging today.</ThemedText>
              </View>
            ) : (
              <>
                <ThemedText style={[styles.sectionLabel, { color: pal.textSecondary }]}>Recent Check-Ins</ThemedText>
                <View style={[styles.historyGroup, { borderColor: pal.divider }]}>
                  {recent.map((e, idx) => {
                    const energyOpt = ENERGY_OPTS.find((o) => o.value === e.energy);
                    const stressOpt = STRESS_OPTS.find((o) => o.value === e.stress);
                    return (
                      <View
                        key={e.date}
                        style={[
                          styles.historyRow,
                          { borderBottomColor: pal.divider },
                          idx < recent.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth },
                        ]}
                      >
                        <ThemedText style={[styles.historyDate, { color: pal.text }]}>{formatDate(e.date)}</ThemedText>
                        <View style={styles.historyBadges}>
                          {energyOpt && (
                            <ThemedText style={[styles.historyBadge, { color: '#5A8040' }]}>
                              Energy: {energyOpt.label}
                            </ThemedText>
                          )}
                          {stressOpt && (
                            <ThemedText style={[styles.historyBadge, { color: '#9E7020' }]}>
                              Stress: {stressOpt.label}
                            </ThemedText>
                          )}
                        </View>
                        {e.signs.length > 0 && (
                          <ThemedText style={[styles.historySigns, { color: pal.textSecondary }]}>{e.signs.join(' · ')}</ThemedText>
                        )}
                        {e.notes ? <ThemedText style={[styles.historyNotes, { color: pal.textSecondary }]}>"{e.notes}"</ThemedText> : null}
                      </View>
                    );
                  })}
                </View>
              </>
            )}
          </ScrollView>
        </View>
      </Modal>
    );
  }

  // ── Log screen ────────────────────────────────────────────────────────────

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <KeyboardAvoidingView
        style={[styles.container, { backgroundColor: dynPalette.background, paddingTop: Spacing.three }]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.header}>
          <ThemedText style={[styles.title, { color: dynPalette.text }]}>Today's Check-In</ThemedText>
          <View style={styles.headerRight}>
            <TouchableOpacity onPress={() => setView('history')} activeOpacity={0.7}>
              <ThemedText style={[styles.headerAction, { color: pal.accent }]}>History →</ThemedText>
            </TouchableOpacity>
            <TouchableOpacity onPress={handleClose} activeOpacity={0.7}>
              <ThemedText style={[styles.doneBtn, { color: pal.accent }]}>Done</ThemedText>
            </TouchableOpacity>
          </View>
        </View>

        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">

          {dayCount !== null && (
            <View style={[styles.dayCountCard, { borderColor: pal.accent + '40' }]}>
              <ThemedText style={[styles.dayCountNumber, { color: pal.accent }]}>Day {dayCount + 1}</ThemedText>
              <ThemedText style={[styles.dayCountLabel, { color: pal.textSecondary }]}>of your cycle</ThemedText>
              {ouraSynced && (
                <ThemedText style={[styles.ouraTagText, { color: pal.textSecondary }]}>
                  Synced from Oura · {formatDate(ouraSynced)}
                </ThemedText>
              )}
            </View>
          )}

          {/* Period start logging — only shown when not currently in a cycle (>5 days ago or never logged) */}
          {(dayCount === null || dayCount > 5) && (
            <View style={[styles.periodCard, { borderColor: pal.accent + '30' }]}>
              <ThemedText style={[styles.periodCardTitle, { color: pal.textSecondary }]}>Period started?</ThemedText>
              <TouchableOpacity
                style={[styles.flatBtn, { borderColor: pal.accent }]}
                onPress={handleMarkPeriodToday}
                activeOpacity={0.85}
              >
                <ThemedText style={[styles.flatBtnText, { color: pal.accent }]}>Mark Today as Day 1 →</ThemedText>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setView('setup')} activeOpacity={0.7}>
                <ThemedText style={[styles.periodAltText, { color: pal.textSecondary }]}>Started on a different day?</ThemedText>
              </TouchableOpacity>
            </View>
          )}

          <ThemedText style={[styles.contextText, { color: pal.textSecondary }]}>
            Logging energy and stress daily helps identify the patterns most connected to hormonal recovery — especially HRV, sleep, and relative energy availability.
          </ThemedText>

          <ScaleRow
            label="Energy Level"
            options={ENERGY_OPTS}
            selected={energy}
            onSelect={setEnergy}
            accent={pal.accent}
            pal={pal}
          />

          <ScaleRow
            label="Stress Level"
            options={STRESS_OPTS}
            selected={stress}
            onSelect={setStress}
            accent="#C4A0B0"
            pal={pal}
          />

          {/* Signs */}
          <View style={[styles.scaleSection, { borderColor: pal.divider }]}>
            <ThemedText style={[styles.scaleLabel, { color: pal.textSecondary }]}>
              Any Signs? <ThemedText style={styles.optional}>(optional)</ThemedText>
            </ThemedText>
            <View style={styles.signsGrid}>
              {SIGNS.map((s) => {
                const active = signs.includes(s);
                return (
                  <TouchableOpacity
                    key={s}
                    style={[
                      styles.signChip,
                      { borderColor: pal.divider },
                      active && { borderColor: pal.accent, backgroundColor: pal.accent + '18' },
                    ]}
                    onPress={() => toggleSign(s)}
                    activeOpacity={0.7}
                  >
                    <ThemedText style={[styles.signChipText, { color: active ? pal.accent : pal.textSecondary }]}>{s}</ThemedText>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {/* Notes */}
          <View style={[styles.scaleSection, { borderColor: pal.divider }]}>
            <ThemedText style={[styles.scaleLabel, { color: pal.textSecondary }]}>
              Notes <ThemedText style={styles.optional}>(optional)</ThemedText>
            </ThemedText>
            <TextInput
              style={[styles.notesInput, { backgroundColor: pal.background, color: pal.text, borderColor: pal.divider }]}
              placeholder="Anything worth noting about today — stress, food, sleep, how you feel..."
              placeholderTextColor={pal.textSecondary}
              value={notes}
              onChangeText={setNotes}
              multiline
              numberOfLines={3}
            />
          </View>

          <TouchableOpacity
            style={[
              styles.flatBtn,
              { borderColor: pal.accent },
              (energy === null || stress === null || saving) && { opacity: 0.35 },
            ]}
            onPress={handleSave}
            disabled={energy === null || stress === null || saving}
            activeOpacity={0.85}
          >
            <ThemedText style={[styles.flatBtnText, { color: pal.accent }]}>
              {todayEntry ? 'Update Today →' : 'Save Check-In →'}
            </ThemedText>
          </TouchableOpacity>

        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: Spacing.three,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.three,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  title: { fontFamily: Fonts.serif, fontSize: 24, fontStyle: 'italic', fontWeight: '400', paddingTop: 3, paddingRight: 4 },
  doneBtn: { fontSize: 16, fontWeight: '400' },
  headerAction: { fontSize: 14 },
  scroll: { gap: Spacing.three, paddingBottom: Spacing.six },

  sectionLabel: { fontSize: 9, letterSpacing: 2.5, textTransform: 'uppercase' },

  // Day count
  dayCountCard: {
    borderWidth: StyleSheet.hairlineWidth, borderRadius: 2,
    padding: Spacing.three, alignItems: 'center', gap: 4,
  },
  dayCountNumber: { fontFamily: Fonts.serif, fontSize: 40, fontStyle: 'italic', fontWeight: '400', lineHeight: 44, paddingTop: 8, paddingRight: 6 },
  dayCountLabel: { fontSize: 13 },
  dayCountEdit: { fontSize: 12, marginTop: 4 },
  ouraTagText: { fontSize: 11, fontStyle: 'italic', marginTop: 2 },

  // Period start card
  periodCard: {
    borderWidth: StyleSheet.hairlineWidth, borderRadius: 2,
    padding: Spacing.three, gap: Spacing.two, alignItems: 'center',
  },
  periodCardTitle: { fontSize: 9, letterSpacing: 2.5, textTransform: 'uppercase' },
  periodAltText: { fontSize: 12, textDecorationLine: 'underline' },

  // Context text
  contextText: { fontSize: 12, lineHeight: 18, fontStyle: 'italic' },

  // Scale
  scaleSection: {
    borderWidth: StyleSheet.hairlineWidth, borderRadius: 2,
    padding: Spacing.three, gap: Spacing.two,
  },
  scaleLabel: { fontSize: 9, letterSpacing: 2.5, textTransform: 'uppercase' },
  optional: { fontWeight: '400', letterSpacing: 0, textTransform: 'none', fontSize: 12 },
  scaleRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.one },
  scaleChip: {
    paddingVertical: 7, paddingHorizontal: 12,
    borderWidth: StyleSheet.hairlineWidth, borderRadius: 2,
  },
  scaleChipLabel: { fontSize: 13 },

  // Signs
  signsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.one },
  signChip: {
    paddingVertical: 6, paddingHorizontal: 10,
    borderWidth: StyleSheet.hairlineWidth, borderRadius: 2,
  },
  signChipText: { fontSize: 12 },

  // Notes
  notesInput: {
    borderWidth: StyleSheet.hairlineWidth, borderRadius: 2,
    padding: Spacing.two, fontSize: 14,
    minHeight: 72, textAlignVertical: 'top',
  },

  // Flat button (replaces all filled pills)
  flatBtn: {
    borderWidth: StyleSheet.hairlineWidth, borderRadius: 2,
    paddingVertical: 14, paddingHorizontal: Spacing.three, alignItems: 'center',
  },
  flatBtnText: { fontSize: 15 },

  // History
  historyGroup: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 2, overflow: 'hidden' },
  historyRow: {
    paddingHorizontal: Spacing.three, paddingVertical: 14, gap: 6,
  },
  historyDate: { fontSize: 14 },
  historyBadges: { flexDirection: 'row', gap: 12, flexWrap: 'wrap' },
  historyBadge: { fontSize: 12, fontStyle: 'italic' },
  historySigns: { fontSize: 12 },
  historyNotes: { fontSize: 12, fontStyle: 'italic' },

  // Empty state
  emptyState: { alignItems: 'center', gap: Spacing.two, paddingVertical: Spacing.six },
  emptyText: { fontSize: 14, textAlign: 'center' },

  // Setup
  setupCard: {
    borderWidth: StyleSheet.hairlineWidth, borderRadius: 2,
    padding: Spacing.four, gap: Spacing.two,
  },
  setupTitle: { fontFamily: Fonts.serif, fontSize: 20, fontStyle: 'italic', fontWeight: '400', textAlign: 'center' },
  setupSubtitle: { fontSize: 14, lineHeight: 21, textAlign: 'center' },
  setupInput: {
    borderWidth: StyleSheet.hairlineWidth, borderRadius: 2,
    padding: Spacing.two, fontSize: 15, marginTop: Spacing.one,
  },
  setupHint: { fontSize: 11, textAlign: 'center' },
  skipBtn: { alignItems: 'center', paddingVertical: 8 },
  skipText: { fontSize: 13, textDecorationLine: 'underline' },
});
