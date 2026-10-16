import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useEffect, useState } from 'react';
import { Modal, ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { calcGoalsFromTraining, type TrainingGoalResult } from '@/services/healthkit';

import { ThemedText } from '@/components/themed-text';
import { Fonts, Spacing } from '@/constants/theme';
import { useAppTheme } from '@/context/theme-context';
import { getModalPalette } from '@/utils/modal-palette';

type TrainingGoal = {
  id: string;
  label: string;
  detail: string;
  accent: string;
  icon: SFSymbol;
};

const bodyGoals: TrainingGoal[] = [
  { id: 'cut',         label: 'Cut',         detail: 'Lose body fat while preserving muscle',    accent: '#E8B4B8', icon: 'scalemass' },
  { id: 'bulk',        label: 'Bulk',        detail: 'Build muscle with a calorie surplus',      accent: '#B8C9B0', icon: 'figure.strengthtraining.traditional' },
  { id: 'maintenance', label: 'Maintenance', detail: 'Hold your current weight and composition', accent: '#A8C4D4', icon: 'equal' },
  { id: 'recomp',      label: 'Recomp',      detail: 'Lose fat and gain muscle simultaneously',  accent: '#C4B7D4', icon: 'arrow.triangle.2.circlepath' },
];

const performanceGoals: TrainingGoal[] = [
  { id: 'marathon',  label: 'Marathon / Race',   detail: '26.2 miles or any race distance',          accent: '#E8C98A', icon: 'figure.run' },
  { id: '5k',        label: '5K / 10K',          detail: 'Build speed and endurance',                accent: '#D4A99A', icon: 'timer' },
  { id: 'strength',  label: 'Strength PR',       detail: 'Hit a new max in a specific lift',         accent: '#C4B7D4', icon: 'dumbbell' },
  { id: 'sport',     label: 'Sport-Specific',    detail: 'Training for a sport or competition',      accent: '#B8C9B0', icon: 'sportscourt' },
  { id: 'general',   label: 'General Fitness',   detail: 'Move more, feel better, stay consistent', accent: '#E8B4B8', icon: 'heart.circle' },
];


export function TrainingModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { isDark, userTheme } = useAppTheme();
  const palette = getModalPalette(isDark, userTheme);

  const [selectedBody, setSelectedBody] = useState<string | null>(null);
  const [selectedPerf, setSelectedPerf] = useState<string | null>(null);
  const [goalResult, setGoalResult] = useState<TrainingGoalResult | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [loadedProfile, setLoadedProfile] = useState<any>(null);

  // Load saved selections and user profile together on open.
  useEffect(() => {
    if (!visible) return;
    Promise.all([
      AsyncStorage.getItem('training_goals'),
      AsyncStorage.getItem('user_profile'),
    ]).then(([goalsRaw, profileRaw]) => {
      if (goalsRaw) {
        const { body, perf } = JSON.parse(goalsRaw);
        setSelectedBody(body ?? null);
        setSelectedPerf(perf ?? null);
      }
      if (profileRaw) setLoadedProfile(JSON.parse(profileRaw));
    });
  }, [visible]);

  // Recalculate summary synchronously whenever selections change.
  // Using a useEffect guarantees goalResult always reflects the current
  // (fully-updated) selectedBody + selectedPerf — no stale closures.
  useEffect(() => {
    if (!loadedProfile || (selectedBody === null && selectedPerf === null)) {
      setGoalResult(null);
      return;
    }
    setGoalResult(calcGoalsFromTraining(loadedProfile, selectedBody, selectedPerf) ?? null);
  }, [selectedBody, selectedPerf, loadedProfile]);

  function selectBody(id: string) {
    setSelectedBody((prev) => (prev === id ? null : id));
  }

  function selectPerf(id: string) {
    setSelectedPerf((prev) => (prev === id ? null : id));
  }

  // Single atomic write on Done: no per-tap race conditions possible.
  async function handleDone() {
    await AsyncStorage.setItem('training_goals', JSON.stringify({ body: selectedBody, perf: selectedPerf }));
    if (loadedProfile && goalResult) {
      const updated = {
        ...loadedProfile,
        calGoal:   String(goalResult.calGoal),
        stepGoal:  String(goalResult.stepGoal),
        waterGoal: String(goalResult.waterGoal),
        sleepGoal: String(goalResult.sleepGoal),
      };
      await AsyncStorage.setItem('user_profile', JSON.stringify(updated));
    }
    onClose();
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <View style={[styles.container, { backgroundColor: palette.background, paddingTop: Spacing.three }]}>
        <View style={styles.header}>
          <View>
            <ThemedText style={[styles.title, { color: palette.text }]}>Training</ThemedText>
            <ThemedText style={[styles.subtitle, { color: palette.textSecondary }]}>set your goals and we'll tailor your insights</ThemedText>
          </View>
          <TouchableOpacity onPress={handleDone} activeOpacity={0.7}>
            <ThemedText style={[styles.doneBtn, { color: palette.accent }]}>Done</ThemedText>
          </TouchableOpacity>
        </View>

        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>

          <ThemedText style={[styles.sectionLabel, { color: palette.textSecondary }]}>Body Composition</ThemedText>
          <View style={[styles.goalGroup, { borderColor: palette.divider }]}>
            {bodyGoals.map((g, i) => (
              <TouchableOpacity
                key={g.id}
                style={[
                  styles.goalRow,
                  { borderBottomColor: palette.divider },
                  i < bodyGoals.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth },
                  selectedBody === g.id && { backgroundColor: g.accent + '12' },
                ]}
                onPress={() => selectBody(g.id)}
                activeOpacity={0.8}
              >
                <View style={[styles.goalIcon, { backgroundColor: g.accent + '20' }]}>
                  <SymbolView name={g.icon} size={11} weight="thin" type="monochrome" tintColor={g.accent} />
                </View>
                <View style={{ flex: 1 }}>
                  <ThemedText style={[styles.goalLabel, { color: palette.text }, selectedBody === g.id && { color: g.accent }]}>{g.label}</ThemedText>
                  <ThemedText style={[styles.goalDetail, { color: palette.textSecondary }]}>{g.detail}</ThemedText>
                </View>
                {selectedBody === g.id && <ThemedText style={[styles.checkMark, { color: g.accent }]}>✓</ThemedText>}
              </TouchableOpacity>
            ))}
          </View>

          <ThemedText style={[styles.sectionLabel, { color: palette.textSecondary }]}>Performance</ThemedText>
          <View style={[styles.goalGroup, { borderColor: palette.divider }]}>
            {performanceGoals.map((g, i) => (
              <TouchableOpacity
                key={g.id}
                style={[
                  styles.goalRow,
                  { borderBottomColor: palette.divider },
                  i < performanceGoals.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth },
                  selectedPerf === g.id && { backgroundColor: g.accent + '12' },
                ]}
                onPress={() => selectPerf(g.id)}
                activeOpacity={0.8}
              >
                <View style={[styles.goalIcon, { backgroundColor: g.accent + '20' }]}>
                  <SymbolView name={g.icon} size={11} weight="thin" type="monochrome" tintColor={g.accent} />
                </View>
                <View style={{ flex: 1 }}>
                  <ThemedText style={[styles.goalLabel, { color: palette.text }, selectedPerf === g.id && { color: g.accent }]}>{g.label}</ThemedText>
                  <ThemedText style={[styles.goalDetail, { color: palette.textSecondary }]}>{g.detail}</ThemedText>
                </View>
                {selectedPerf === g.id && <ThemedText style={[styles.checkMark, { color: g.accent }]}>✓</ThemedText>}
              </TouchableOpacity>
            ))}
          </View>

          {goalResult && (
            <View style={[styles.summaryCard, { borderColor: palette.accent + '40' }]}>
              <ThemedText style={[styles.summaryHeading, { color: palette.text }]}>Goals updated</ThemedText>
              <View style={styles.summaryGrid}>
                {[
                  { value: goalResult.calGoal, label: 'kcal / day' },
                  { value: goalResult.stepGoal.toLocaleString(), label: 'steps' },
                  { value: goalResult.waterGoal, label: 'oz water' },
                  { value: goalResult.sleepGoal, label: 'hrs sleep' },
                ].map((item) => (
                  <View key={item.label} style={[styles.summaryItem, { borderColor: palette.divider }]}>
                    <ThemedText style={[styles.summaryValue, { color: palette.text }]}>{item.value}</ThemedText>
                    <ThemedText style={[styles.summaryLabel, { color: palette.textSecondary }]}>{item.label}</ThemedText>
                  </View>
                ))}
              </View>
              <View style={styles.macroRow}>
                {[
                  { label: `P ${goalResult.proteinPct}%`, color: '#B8C9B0' },
                  { label: `C ${goalResult.carbPct}%`,   color: '#C4B7D4' },
                  { label: `F ${goalResult.fatPct}%`,    color: '#D4A99A' },
                ].map((m) => (
                  <View key={m.label} style={[styles.macroBadge, { borderColor: m.color + '60' }]}>
                    <ThemedText style={[styles.macroBadgeText, { color: m.color }]}>{m.label}</ThemedText>
                  </View>
                ))}
              </View>
              {goalResult.summaryLines.map((line, i) => (
                <ThemedText key={i} style={[styles.summaryLine, { color: palette.textSecondary }]}>· {line}</ThemedText>
              ))}
            </View>
          )}

          <View style={[styles.trainerRow, { borderColor: palette.divider }]}>
            <View style={{ flex: 1 }}>
              <ThemedText style={[styles.trainerLabel, { color: palette.text }]}>Invite Your Trainer</ThemedText>
              <ThemedText style={[styles.trainerDetail, { color: palette.textSecondary }]}>Give your trainer access to your insights</ThemedText>
            </View>
            <View style={[styles.soonBadge, { borderColor: palette.divider }]}>
              <ThemedText style={[styles.soonText, { color: palette.textSecondary }]}>Soon</ThemedText>
            </View>
          </View>

          <ThemedText style={[styles.trainerNote, { color: palette.textSecondary }]}>
            A dedicated trainer interface is in development. When ready, your trainer will be able to view your trends, recovery scores, and progress — with your permission.
          </ThemedText>

        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: Spacing.three },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: Spacing.three },
  title: { fontFamily: Fonts.serif, fontSize: 26, fontStyle: 'italic', fontWeight: '400', paddingTop: 3, paddingRight: 4 },
  subtitle: { fontSize: 13, fontStyle: 'italic', marginTop: 3 },
  doneBtn: { fontSize: 16, fontWeight: '400', paddingTop: 6 },
  scroll: { gap: Spacing.three, paddingBottom: Spacing.six },

  sectionLabel: { fontSize: 9, letterSpacing: 2.5, textTransform: 'uppercase' },

  goalGroup: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 2, overflow: 'hidden' },
  goalRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.two,
    paddingHorizontal: Spacing.three, paddingVertical: 14,
  },
  goalIcon: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  goalLabel: { fontSize: 15 },
  goalDetail: { fontSize: 12, marginTop: 2 },
  checkMark: { fontSize: 16 },

  summaryCard: {
    borderWidth: StyleSheet.hairlineWidth, borderRadius: 2,
    padding: Spacing.three, gap: Spacing.two,
  },
  summaryHeading: { fontFamily: Fonts.serif, fontSize: 18, fontStyle: 'italic', fontWeight: '400' },
  summaryGrid: { flexDirection: 'row', gap: Spacing.two },
  summaryItem: {
    flex: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: 2,
    padding: Spacing.two, alignItems: 'center',
  },
  summaryValue: { fontFamily: Fonts.serif, fontSize: 20, fontStyle: 'italic', fontWeight: '400' },
  summaryLabel: { fontSize: 11, marginTop: 2 },
  macroRow: { flexDirection: 'row', gap: Spacing.one },
  macroBadge: { flex: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: 2, paddingVertical: 5, alignItems: 'center' },
  macroBadgeText: { fontSize: 13 },
  summaryLine: { fontSize: 13, lineHeight: 19 },

  trainerRow: {
    flexDirection: 'row', alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth, borderRadius: 2,
    padding: Spacing.three, marginTop: Spacing.one,
  },
  trainerLabel: { fontSize: 15 },
  trainerDetail: { fontSize: 12, marginTop: 2 },
  soonBadge: { paddingHorizontal: 8, paddingVertical: 3, borderWidth: StyleSheet.hairlineWidth, borderRadius: 2 },
  soonText: { fontSize: 10, letterSpacing: 1 },
  trainerNote: { fontSize: 12, lineHeight: 18, fontStyle: 'italic' },
});
