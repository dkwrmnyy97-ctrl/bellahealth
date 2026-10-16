import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useEffect, useState } from 'react';
import { Modal, ScrollView, StyleSheet, Switch, TouchableOpacity, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Fonts, Spacing } from '@/constants/theme';
import { useAppTheme } from '@/context/theme-context';
import { getModalPalette } from '@/utils/modal-palette';
import { onVacationModeOn, onVacationModeOff } from '@/services/context-events';
import { TRAVEL_STEP_GOAL, TRAVEL_WATER_OZ, TRAVEL_SLEEP_HRS } from '@/utils/travel-goals';

type GoalEntry = { label: string; value: string; unit: string };
type GoalMap   = { steps: GoalEntry; calories: GoalEntry; water: GoalEntry; sleep: GoalEntry; workouts: GoalEntry };
type GoalKey   = keyof GoalMap;

const vacationGoals: GoalMap = {
  steps:    { label: 'Daily Steps',  value: TRAVEL_STEP_GOAL.toLocaleString(), unit: 'steps' },
  calories: { label: 'Calories',     value: 'Relaxed',                         unit: ''      },
  water:    { label: 'Water',        value: String(TRAVEL_WATER_OZ),            unit: 'oz'    },
  sleep:    { label: 'Sleep',        value: `${TRAVEL_SLEEP_HRS}+`,             unit: 'hrs'   },
  workouts: { label: 'Workouts',     value: 'Move when it feels good',          unit: ''      },
};

export function TravelModal({ visible, onClose, onModeChange }: {
  visible: boolean;
  onClose: () => void;
  onModeChange?: (enabled: boolean) => void;
}) {
  const { isDark, userTheme } = useAppTheme();
  const palette = getModalPalette(isDark, userTheme);

  const [enabled, setEnabled] = useState(false);
  const [normalGoals, setNormalGoals] = useState<GoalMap>({
    steps:    { label: 'Daily Steps',  value: '10,000', unit: 'steps' },
    calories: { label: 'Calories',     value: '2,000',  unit: 'kcal'  },
    water:    { label: 'Water',        value: '80',     unit: 'oz'    },
    sleep:    { label: 'Sleep',        value: '8',      unit: 'hrs'   },
    workouts: { label: 'Workouts',     value: '4',      unit: '/ week' },
  });

  useEffect(() => {
    AsyncStorage.getItem('vacation_mode').then((v) => { if (v !== null) setEnabled(v === 'true'); });
    AsyncStorage.getItem('user_profile').then((raw) => {
      if (!raw) return;
      const p = JSON.parse(raw);
      setNormalGoals((prev) => ({
        ...prev,
        steps:    { ...prev.steps,    value: p.stepGoal  ? Number(p.stepGoal).toLocaleString() : prev.steps.value },
        calories: { ...prev.calories, value: p.calGoal   ? Number(p.calGoal).toLocaleString()  : prev.calories.value },
        water:    { ...prev.water,    value: p.waterGoal  ? String(p.waterGoal)                : prev.water.value },
        sleep:    { ...prev.sleep,    value: p.sleepGoal ? String(p.sleepGoal)                 : prev.sleep.value },
      }));
    });
  }, []);

  function toggleEnabled(val: boolean) {
    setEnabled(val);
    AsyncStorage.setItem('vacation_mode', String(val));
    onModeChange?.(val);
    // Write ContextEvent for timeline / context engine
    if (val) {
      onVacationModeOn().catch(() => {});
    } else {
      onVacationModeOff().catch(() => {});
    }
  }

  const current = enabled ? vacationGoals : normalGoals;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <View style={[styles.container, { backgroundColor: palette.background, paddingTop: Spacing.three }]}>
        <View style={styles.header}>
          <ThemedText style={[styles.title, { color: palette.text }]}>Travel Mode</ThemedText>
          <TouchableOpacity onPress={onClose} activeOpacity={0.7}>
            <ThemedText style={[styles.doneBtn, { color: palette.accent }]}>Done</ThemedText>
          </TouchableOpacity>
        </View>

        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>

          <View style={[styles.toggleRow, { borderBottomColor: palette.divider, borderColor: palette.divider }]}>
            <View style={styles.toggleLeft}>
              <ThemedText style={[styles.toggleLabel, { color: palette.text }]}>
                {enabled ? 'Travel mode on' : 'Travel mode off'}
              </ThemedText>
              <ThemedText style={[styles.toggleSub, { color: palette.textSecondary }]}>
                {enabled ? 'Goals are relaxed. Enjoy yourself.' : 'Your normal goals are active.'}
              </ThemedText>
            </View>
            <Switch
              value={enabled}
              onValueChange={toggleEnabled}
              trackColor={{ false: palette.divider, true: palette.accent }}
              thumbColor="#fff"
            />
          </View>

          {enabled && (
            <View style={[styles.messageRow, { borderColor: palette.accent + '40', backgroundColor: palette.accent + '10' }]}>
              <ThemedText style={[styles.messageText, { color: palette.text }]}>
                Rest is productive. Your body recovers, your mind resets, and you come back stronger. Enjoy every moment — the data will be here when you get back.
              </ThemedText>
            </View>
          )}

          <ThemedText style={[styles.sectionLabel, { color: palette.textSecondary }]}>
            {enabled ? 'Your goals while away' : 'Goals that get adjusted'}
          </ThemedText>

          <View style={[styles.goalsCard, { borderColor: palette.divider }]}>
            {(Object.keys(normalGoals) as GoalKey[]).map((key, i, arr) => {
              const normal  = normalGoals[key];
              const vac     = vacationGoals[key];
              return (
                <View key={key} style={[styles.goalRow, i < arr.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.divider }]}>
                  <ThemedText style={[styles.goalLabel, { color: palette.text }]}>{normal.label}</ThemedText>
                  <View style={styles.goalValues}>
                    {enabled && normal.value !== vac.value && (
                      <ThemedText style={[styles.goalOld, { color: palette.textSecondary }]}>{normal.value}{normal.unit ? ` ${normal.unit}` : ''}</ThemedText>
                    )}
                    <ThemedText style={[styles.goalNew, { color: enabled ? palette.accent : palette.text }]}>
                      {current[key].value}{current[key].unit ? ` ${current[key].unit}` : ''}
                    </ThemedText>
                  </View>
                </View>
              );
            })}
          </View>

          <ThemedText style={[styles.footnote, { color: palette.textSecondary }]}>
            Tracking continues as normal — your data is still collected. Travel mode adjusts your goals and takes the pressure off while you're away.
          </ThemedText>

        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: Spacing.three },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.three },
  title: { fontFamily: Fonts.serif, fontSize: 26, fontStyle: 'italic', fontWeight: '400', paddingTop: 3, paddingRight: 4 },
  doneBtn: { fontSize: 16, fontWeight: '400' },
  scroll: { gap: Spacing.three, paddingBottom: Spacing.six },

  toggleRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    borderWidth: StyleSheet.hairlineWidth, borderRadius: 2,
    paddingHorizontal: Spacing.three, paddingVertical: Spacing.three,
  },
  toggleLeft: { flex: 1, marginRight: Spacing.three, gap: 4 },
  toggleLabel: { fontSize: 16 },
  toggleSub: { fontSize: 12 },

  messageRow: {
    borderWidth: StyleSheet.hairlineWidth, borderRadius: 2,
    paddingHorizontal: Spacing.three, paddingVertical: Spacing.two,
  },
  messageText: { fontSize: 14, lineHeight: 22, fontStyle: 'italic' },

  sectionLabel: { fontSize: 9, letterSpacing: 2.5, textTransform: 'uppercase' },

  goalsCard: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 2, overflow: 'hidden' },
  goalRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: Spacing.three, paddingVertical: 14,
  },
  goalLabel: { fontSize: 15 },
  goalValues: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one },
  goalOld: { fontSize: 13, textDecorationLine: 'line-through' },
  goalNew: { fontSize: 15 },

  footnote: { fontSize: 12, lineHeight: 18, fontStyle: 'italic' },
});
