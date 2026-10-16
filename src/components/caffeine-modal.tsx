import AsyncStorage from '@react-native-async-storage/async-storage';
import { appendCaffeineHistory } from '@/services/context-events';

function localDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
import React, { useEffect, useRef, useState } from 'react';
import { Modal, ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Fonts, Spacing } from '@/constants/theme';
import { useAppTheme } from '@/context/theme-context';
import { getModalPalette } from '@/utils/modal-palette';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { trackEvent } from '@/services/analytics';

// ─── Types ────────────────────────────────────────────────────────────────────

type DrinkType = 'matcha' | 'tea' | 'coffee' | 'cappuccino' | 'latte' | 'espresso';

type CaffeineEntry = {
  drink: DrinkType;
  milk: boolean;
  size: number;
  mg: number;
  timestamp: string;
};

// ─── Caffeine data ────────────────────────────────────────────────────────────

type DrinkConfig = {
  label: string;
  caffeine: Record<number, number>;
  sizes?: number[];
  sizeLabel?: (sz: number) => string;
};

const drinkConfig: Record<DrinkType, DrinkConfig> = {
  matcha:     { label: 'Matcha',     caffeine: { 12: 70,  16: 95,  20: 120 } },
  tea:        { label: 'Tea',        caffeine: { 12: 40,  16: 55,  20: 70  } },
  coffee:     { label: 'Coffee',     caffeine: { 12: 165, 16: 220, 20: 275 } },
  cappuccino: { label: 'Cappuccino', caffeine: { 12: 75,  16: 150, 20: 150 } },
  latte:      { label: 'Latte',      caffeine: { 12: 75,  16: 150, 20: 150 } },
  espresso:   { label: 'Espresso',   caffeine: { 1: 63, 2: 126 }, sizes: [1, 2], sizeLabel: (sz) => sz === 1 ? 'Single' : 'Double' },
};

const DEFAULT_SIZES = [12, 16, 20];

// ─── Personalized range ───────────────────────────────────────────────────────

type HealthContext = {
  sleepScore: number;
  hrv: number;
  waterOz: number;
  hadAlcoholLastNight: boolean;
};

type CaffeineRange = {
  low: number;
  high: number;
  notes: string[];
};

function getPersonalizedRange(ctx: HealthContext): CaffeineRange {
  let low  = 100;
  let high = 400;
  const notes: string[] = [];

  if (ctx.sleepScore < 70) {
    high -= 75;
    notes.push('Your sleep score was low — caffeine sensitivity is higher when under-rested. Stay toward the lower end.');
  }
  if (ctx.hrv < 40) {
    high -= 50;
    notes.push('Your HRV suggests your nervous system is under some stress. Excess caffeine will amplify that.');
  }
  if (ctx.hadAlcoholLastNight) {
    high -= 75;
    low  -= 25;
    notes.push("Alcohol last night means your liver is still recovering. Caffeine can mask fatigue without resolving it — don't overdo it.");
  }
  if (ctx.waterOz < 48) {
    high -= 50;
    notes.push('You are under-hydrated today. Caffeine is a mild diuretic — drink a full glass of water with every caffeinated drink.');
  }
  if (ctx.sleepScore >= 85 && ctx.hrv >= 50 && ctx.waterOz >= 64) {
    notes.push("Your recovery metrics are strong today — you're in a good position to handle your normal caffeine intake.");
  }

  return { low: Math.max(low, 50), high: Math.max(high, 100), notes };
}

// Status colors are universal functional colors, not gender-specific
function getCaffeineStatus(totalMg: number, range: CaffeineRange): { label: string; color: string } {
  if (totalMg === 0)               return { label: 'None logged yet',        color: '#9E7E7E' };
  if (totalMg <= range.low)        return { label: 'Well within range',      color: '#B8C9B0' };
  if (totalMg <= range.high)       return { label: 'Within your range',      color: '#B8C9B0' };
  if (totalMg <= range.high + 100) return { label: 'Approaching your limit', color: '#F5C842' };
  return                                { label: 'Over your range',          color: '#E8B4B8' };
}

// ─── Components ───────────────────────────────────────────────────────────────

type Pal = ReturnType<typeof getModalPalette>;

function RangeBar({ totalMg, range, pal }: { totalMg: number; range: CaffeineRange; pal: Pal }) {
  const max = range.high + 150;
  const fillPercent = Math.min(totalMg / max, 1);
  const lowPercent  = range.low  / max;
  const highPercent = range.high / max;
  const status = getCaffeineStatus(totalMg, range);
  // "None logged yet" used a hardcoded mauve-gray; use pal.textSecondary instead so
  // it adapts to Forest and Neutral. Functional status colors (green/yellow/red) are
  // universal and unchanged.
  const displayColor = totalMg === 0 ? pal.textSecondary : status.color;

  return (
    <View style={barStyles.container}>
      <View style={barStyles.labelRow}>
        <ThemedText style={[barStyles.totalMg, { color: pal.text }]}>{totalMg} mg</ThemedText>
        <ThemedText style={[barStyles.statusText, { color: displayColor }]}>{status.label}</ThemedText>
      </View>

      <View style={[barStyles.track, { backgroundColor: pal.divider }]}>
        <View style={[barStyles.fill, { width: `${fillPercent * 100}%`, backgroundColor: displayColor }]} />
        <View style={[barStyles.tick, { left: `${lowPercent * 100}%` }]} />
        <View style={[barStyles.tick, { left: `${highPercent * 100}%` }]} />
      </View>

      <View style={barStyles.markerRow}>
        <View style={[barStyles.marker, { left: `${lowPercent * 100}%` }]}>
          <ThemedText style={[barStyles.markerText, { color: pal.textSecondary }]}>{range.low}</ThemedText>
        </View>
        <View style={[barStyles.marker, { left: `${highPercent * 100}%`, transform: [{ translateX: -16 }] }]}>
          <ThemedText style={[barStyles.markerText, { color: pal.textSecondary }]}>{range.high} mg</ThemedText>
        </View>
      </View>

      <ThemedText style={[barStyles.rangeLabel, { color: pal.textSecondary }]}>
        your range today: {range.low}–{range.high} mg
      </ThemedText>
    </View>
  );
}

const barStyles = StyleSheet.create({
  container:  { gap: Spacing.one },
  labelRow:   { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 },
  totalMg:    { fontFamily: Fonts.serif, fontSize: 32, fontStyle: 'italic', fontWeight: '400', lineHeight: 38, paddingTop: 6, paddingRight: 4 },
  statusText: { fontSize: 11, letterSpacing: 0.3 },
  track:      { height: 10, borderRadius: 10, overflow: 'visible', position: 'relative' },
  fill:       { height: '100%', borderRadius: 10 },
  tick:       { position: 'absolute', top: -3, width: 2, height: 16, backgroundColor: '#fff', borderRadius: 1 },
  markerRow:  { position: 'relative', height: 16, marginTop: 2 },
  marker:     { position: 'absolute', transform: [{ translateX: -8 }] },
  markerText: { fontSize: 10 },
  rangeLabel: { fontSize: 11, fontStyle: 'italic', marginTop: 2 },
});

// ─── Main Modal ───────────────────────────────────────────────────────────────

type Props = {
  visible: boolean;
  onClose: () => void;
  sleepScore: number;
  hrv: number;
  waterOz: number;
  hadAlcoholLastNight: boolean;
};

export function CaffeineModal({ visible, onClose, sleepScore, hrv, waterOz, hadAlcoholLastNight }: Props) {
  const { isDark, userTheme } = useAppTheme();
  const palette = getModalPalette(isDark, userTheme);

  const [selectedDrink, setSelectedDrink] = useState<DrinkType | null>(null);
  const [milk, setMilk] = useState<boolean | null>(null);
  const [selectedSize, setSelectedSize] = useState<number | null>(null);
  const [entries, setEntries] = useState<CaffeineEntry[]>([]);
  const caffeineLoggedRef = useRef(false);

  const range = getPersonalizedRange({ sleepScore, hrv, waterOz, hadAlcoholLastNight });
  const totalMg = entries.reduce((sum, e) => sum + e.mg, 0);

  const activeSizes = selectedDrink ? (drinkConfig[selectedDrink].sizes ?? DEFAULT_SIZES) : DEFAULT_SIZES;
  const getSizeLabel = (sz: number) => selectedDrink ? (drinkConfig[selectedDrink].sizeLabel?.(sz) ?? `${sz} oz`) : `${sz} oz`;

  const canLog = selectedDrink !== null && milk !== null && selectedSize !== null;
  const previewMg = selectedDrink && selectedSize ? drinkConfig[selectedDrink].caffeine[selectedSize] : null;

  useEffect(() => {
    if (visible) caffeineLoggedRef.current = false;
    AsyncStorage.getItem('caffeine_log').then((raw) => {
      if (!raw) return;
      const { date, items } = JSON.parse(raw);
      if (date === localDateStr()) setEntries(items ?? []);
    }).catch(() => {});
  }, [visible]);

  function logDrink() {
    if (!selectedDrink || milk === null || !selectedSize) return;
    const mg = drinkConfig[selectedDrink].caffeine[selectedSize];
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const next = [...entries, { drink: selectedDrink, milk, size: selectedSize, mg, timestamp }];
    setEntries(next);
    AsyncStorage.setItem('caffeine_log', JSON.stringify({ date: localDateStr(), items: next })).catch(() => {});
    // Append/upsert to historical log for context engine
    const totalMg = next.reduce((sum, e) => sum + e.mg, 0);
    appendCaffeineHistory({ date: localDateStr(), totalMg, itemCount: next.length }).catch(() => {});
    if (!caffeineLoggedRef.current) {
      caffeineLoggedRef.current = true;
      trackEvent('caffeine_logged', { source_screen: 'caffeine' });
    }
    setSelectedDrink(null);
    setMilk(null);
    setSelectedSize(null);
  }

  function handleClose() {
    setSelectedDrink(null);
    setMilk(null);
    setSelectedSize(null);
    onClose();
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <View style={[styles.container, { backgroundColor: palette.background, paddingTop: Spacing.three }]}>

        <View style={[styles.header, { borderBottomColor: palette.divider }]}>
          <ThemedText style={[styles.title, { color: palette.text }]}>Caffeine</ThemedText>
          <TouchableOpacity onPress={handleClose} activeOpacity={0.7}>
            <ThemedText style={[styles.doneBtn, { color: palette.accent }]}>Done</ThemedText>
          </TouchableOpacity>
        </View>

        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>

          {/* Running total + range bar */}
          <View style={[styles.rangeSection, { borderColor: palette.divider }]}>
            <RangeBar totalMg={totalMg} range={range} pal={palette} />
          </View>

          {/* Personalized notes */}
          {range.notes.length > 0 && (
            <View style={[styles.notesSection, { borderColor: palette.divider }]}>
              <ThemedText style={[styles.overline, { color: palette.textSecondary }]}>Today's Guidance</ThemedText>
              {range.notes.map((note, i) => (
                <View key={i} style={styles.noteRow}>
                  <ThemedText style={[styles.noteBullet, { color: palette.accent }]}>·</ThemedText>
                  <ThemedText style={[styles.noteText, { color: palette.text }]}>{note}</ThemedText>
                </View>
              ))}
            </View>
          )}

          {/* Today's log */}
          {entries.length > 0 && (
            <View style={styles.logSection}>
              <ThemedText style={[styles.overline, { color: palette.textSecondary }]}>Today's Log</ThemedText>
              {entries.map((e, i) => {
                const cfg = drinkConfig[e.drink];
                return (
                  <View key={i} style={[styles.logRow, { borderBottomColor: palette.divider }]}>
                    <ThemedText style={[styles.logText, { color: palette.text }]}>
                      {cfg.label}{e.milk ? ' with milk' : ''} · {cfg.sizeLabel ? cfg.sizeLabel(e.size) : `${e.size} oz`}
                    </ThemedText>
                    <ThemedText style={[styles.logMg, { color: palette.accent }]}>{e.mg} mg</ThemedText>
                    <ThemedText style={[styles.logTime, { color: palette.textSecondary }]}>{e.timestamp}</ThemedText>
                  </View>
                );
              })}
            </View>
          )}

          {/* Drink selector */}
          <ThemedText style={[styles.overline, { color: palette.textSecondary }]}>What are you having?</ThemedText>
          <View style={styles.drinkGrid}>
            {(Object.keys(drinkConfig) as DrinkType[]).map((dt) => {
              const cfg = drinkConfig[dt];
              const isSelected = selectedDrink === dt;
              return (
                <TouchableOpacity
                  key={dt}
                  style={[
                    styles.drinkCard,
                    { borderColor: palette.divider, backgroundColor: palette.card },
                    isSelected && { borderColor: palette.accent },
                  ]}
                  onPress={() => { setSelectedDrink(isSelected ? null : dt); setMilk(null); setSelectedSize(null); }}
                  activeOpacity={0.7}
                >
                  <ThemedText style={[
                    styles.drinkCardLabel,
                    { color: palette.textSecondary },
                    isSelected && { color: palette.accent },
                  ]}>{cfg.label}</ThemedText>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Milk toggle */}
          {selectedDrink && (
            <View style={[styles.toggleSection, { borderColor: palette.divider }]}>
              <ThemedText style={[styles.toggleQuestion, { color: palette.textSecondary }]}>Milk?</ThemedText>
              <View style={styles.toggleOptions}>
                {[true, false].map((val) => (
                  <TouchableOpacity
                    key={String(val)}
                    style={[
                      styles.toggleBtn,
                      { borderColor: palette.divider },
                      milk === val && { borderColor: palette.accent },
                    ]}
                    onPress={() => setMilk(val)}
                    activeOpacity={0.7}
                  >
                    <ThemedText style={[
                      styles.toggleBtnText,
                      { color: palette.textSecondary },
                      milk === val && { color: palette.accent },
                    ]}>
                      {val ? 'Yes' : 'No'}
                    </ThemedText>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          )}

          {/* Size selector */}
          {selectedDrink && milk !== null && (
            <View style={[styles.toggleSection, { borderColor: palette.divider }]}>
              <ThemedText style={[styles.toggleQuestion, { color: palette.textSecondary }]}>Size</ThemedText>
              <View style={styles.toggleOptions}>
                {activeSizes.map((sz) => (
                  <TouchableOpacity
                    key={sz}
                    style={[
                      styles.toggleBtn,
                      { borderColor: palette.divider },
                      selectedSize === sz && { borderColor: palette.accent },
                    ]}
                    onPress={() => setSelectedSize(sz)}
                    activeOpacity={0.7}
                  >
                    <ThemedText style={[
                      styles.toggleBtnText,
                      { color: palette.textSecondary },
                      selectedSize === sz && { color: palette.accent },
                    ]}>
                      {getSizeLabel(sz)}
                    </ThemedText>
                    {selectedSize === sz && previewMg && (
                      <ThemedText style={[styles.toggleBtnSub, { color: palette.accent }]}>~{previewMg} mg</ThemedText>
                    )}
                    {!selectedSize && (
                      <ThemedText style={[styles.toggleBtnSub, { color: palette.textSecondary }]}>
                        ~{drinkConfig[selectedDrink].caffeine[sz]} mg
                      </ThemedText>
                    )}
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          )}

          {/* Log button */}
          <TouchableOpacity
            style={[styles.logButton, { borderColor: palette.accent, opacity: canLog ? 1 : 0.3 }]}
            onPress={logDrink}
            disabled={!canLog}
            activeOpacity={0.8}
          >
            <ThemedText style={[styles.logButtonText, { color: palette.accent }]}>Log Drink</ThemedText>
          </TouchableOpacity>

        </ScrollView>
      </View>
    </Modal>
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

  rangeSection: {
    borderWidth: StyleSheet.hairlineWidth, borderRadius: 2,
    padding: Spacing.three,
  },

  notesSection: {
    borderWidth: StyleSheet.hairlineWidth, borderRadius: 2,
    padding: Spacing.three, gap: Spacing.two,
  },
  noteRow:   { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  noteBullet: { fontSize: 16, lineHeight: 20, marginTop: -1 },
  noteText:  { flex: 1, fontFamily: Fonts.serif, fontSize: 13, fontStyle: 'italic', lineHeight: 20 },

  logSection: { gap: Spacing.one },
  logRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.two,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  logText: { flex: 1, fontSize: 14 },
  logMg:   { fontSize: 13 },
  logTime: { fontSize: 12 },

  drinkGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.one },
  drinkCard: {
    width: '31%', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 14, borderWidth: StyleSheet.hairlineWidth, borderRadius: 2,
  },
  drinkCardLabel: { fontFamily: Fonts.serif, fontSize: 13, fontStyle: 'italic', textAlign: 'center' },

  toggleSection: {
    borderWidth: StyleSheet.hairlineWidth, borderRadius: 2,
    padding: Spacing.three, gap: Spacing.two,
  },
  toggleQuestion: { fontSize: 9, letterSpacing: 2.5, textTransform: 'uppercase' },
  toggleOptions:  { flexDirection: 'row', gap: Spacing.one },
  toggleBtn: {
    flex: 1, paddingVertical: 10,
    borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', gap: 2,
  },
  toggleBtnText: { fontFamily: Fonts.serif, fontSize: 15, fontStyle: 'italic' },
  toggleBtnSub:  { fontSize: 10 },

  logButton: {
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 16, alignItems: 'center',
  },
  logButtonText: { fontFamily: Fonts.serif, fontSize: 16, fontStyle: 'italic' },
});
