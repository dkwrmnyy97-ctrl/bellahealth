import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useEffect, useState } from 'react';
import { triggerDrinkWarning } from '@/services/notifications';
import { Keyboard, KeyboardAvoidingView, Modal, Platform, ScrollView, StyleSheet, TextInput, TouchableOpacity, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Fonts, Spacing } from '@/constants/theme';
import { useAppTheme } from '@/context/theme-context';
import { getModalPalette } from '@/utils/modal-palette';
import { trackEvent } from '@/services/analytics';
import { buildDrinkEntry } from '@/utils/drink-entry';
import type { DrinkItem } from '@/utils/drink-entry';

// Re-export for consumers that import from this module
export { buildDrinkEntry };
export type { DrinkItem };

// ─── Static drink lists ────────────────────────────────────────────────────────

const BEER: DrinkItem[] = [
  { id: 'light_lager',  name: 'Light Lager',       detail: '4.2% · 12 oz',  calories: 110, standardDrinks: 0.9 },
  { id: 'regular_beer', name: 'Lager / Ale',        detail: '5.0% · 12 oz',  calories: 150, standardDrinks: 1.0 },
  { id: 'ipa_craft',    name: 'IPA / Craft Beer',   detail: '6.5% · 12 oz',  calories: 195, standardDrinks: 1.3 },
  { id: 'stout',        name: 'Stout / Porter',     detail: '5.5% · 12 oz',  calories: 210, standardDrinks: 1.2 },
  { id: 'hard_seltzer', name: 'Hard Seltzer',       detail: '5.0% · 12 oz',  calories: 100, standardDrinks: 1.0 },
  { id: 'hard_cider',   name: 'Hard Cider',         detail: '5.0% · 12 oz',  calories: 190, standardDrinks: 1.0 },
];

const WINE: DrinkItem[] = [
  { id: 'white_wine',  name: 'White Wine',           detail: '~12% · 5 oz',   calories: 120, standardDrinks: 1.0 },
  { id: 'red_wine',    name: 'Red Wine',             detail: '~13% · 5 oz',   calories: 125, standardDrinks: 1.0 },
  { id: 'rose',        name: 'Rosé',                 detail: '~12% · 5 oz',   calories: 120, standardDrinks: 1.0 },
  { id: 'sparkling',   name: 'Sparkling / Prosecco', detail: '~11% · 5 oz',   calories: 95,  standardDrinks: 0.9 },
];

const COCKTAILS: DrinkItem[] = [
  { id: 'vodka_soda',       name: 'Vodka Soda',           detail: '~100 cal · 1.5 oz vodka',   calories: 100, standardDrinks: 1.0 },
  { id: 'gin_tonic',        name: 'Gin & Tonic',          detail: '~140 cal · 1.5 oz gin',     calories: 140, standardDrinks: 1.0 },
  { id: 'margarita',        name: 'Margarita',            detail: '~200 cal · 1.5 oz tequila', calories: 200, standardDrinks: 1.3 },
  { id: 'moscow_mule',      name: 'Moscow Mule',          detail: '~180 cal · 1.5 oz vodka',   calories: 180, standardDrinks: 1.1 },
  { id: 'whiskey_rocks',    name: 'Whiskey on the Rocks', detail: '~120 cal · 1.5 oz',         calories: 120, standardDrinks: 1.1 },
  { id: 'old_fashioned',    name: 'Old Fashioned',        detail: '~160 cal · 2 oz whiskey',   calories: 160, standardDrinks: 1.5 },
  { id: 'negroni',          name: 'Negroni',              detail: '~195 cal · 1 oz gin',       calories: 195, standardDrinks: 1.5 },
  { id: 'aperol_spritz',    name: 'Aperol Spritz',        detail: '~125 cal · 3 oz Aperol',    calories: 125, standardDrinks: 0.7 },
  { id: 'tequila_soda',     name: 'Tequila Soda',         detail: '~100 cal · 1.5 oz tequila', calories: 100, standardDrinks: 1.0 },
  { id: 'rum_coke',         name: 'Rum & Coke',           detail: '~180 cal · 1.5 oz rum',     calories: 180, standardDrinks: 1.1 },
  { id: 'espresso_martini', name: 'Espresso Martini',     detail: '~190 cal · 1.5 oz vodka',   calories: 190, standardDrinks: 1.3 },
];

const SHOTS: DrinkItem[] = [
  { id: 'shot_straight', name: 'Straight Shot',     detail: '~65 cal · 1.5 oz spirit', calories: 65,  standardDrinks: 1.0 },
  { id: 'shot_sweet',    name: 'Sweet / Mixed Shot', detail: '~100 cal · with mixer',   calories: 100, standardDrinks: 0.8 },
];

const STATIC_ITEMS: DrinkItem[] = [...BEER, ...WINE, ...COCKTAILS, ...SHOTS];

const CUSTOM_DRINKS_KEY = 'custom_drinks';

// ─── Vibe / Plan Ahead ─────────────────────────────────────────────────────────

type Vibe = {
  id: string;
  label: string;
  insights: { macros: string; tomorrow: string; sleep: string; workout: string };
};

const vibes: Vibe[] = [
  {
    id: 'happy_hour', label: 'Happy Hour',
    insights: {
      macros: 'Save ~150-200 kcal from dinner carbs. Keep protein high to minimize muscle impact.',
      tomorrow: 'High-protein breakfast tomorrow. Avoid fasted workouts in the morning.',
      sleep: 'Expect slightly lower HRV. Wind down earlier than usual.',
      workout: 'Morning workout is fine — keep intensity moderate.',
    },
  },
  {
    id: 'with_meal', label: 'Drink with Meal',
    insights: {
      macros: 'Food slows absorption — good call. Reduce meal carbs ~20-30g and skip dessert.',
      tomorrow: 'No major adjustments. Stay hydrated before bed.',
      sleep: 'Minimal sleep impact. Oura may flag a slight dip in deep sleep.',
      workout: "No restrictions tomorrow. You're good.",
    },
  },
  {
    id: 'night_out', label: 'Night Out',
    insights: {
      macros: 'Eat a solid high-protein, higher-fat meal beforehand. Drink water between every drink.',
      tomorrow: 'Increase protein by ~20g. Prioritize whole foods, skip heavy sugar.',
      sleep: "Expect significant HRV drop and disrupted deep sleep. Normal — don't stress.",
      workout: 'Skip intense training. A walk or light yoga supports recovery better.',
    },
  },
];

type InsightConfig = { label: string; text: string };

// ─── Warning card ──────────────────────────────────────────────────────────────

function buildWarningInsights(
  totalDrinks: number,
  totalCalories: number,
  sleepScore: number,
  hrv: number,
  waterOz: number,
  workoutDone: boolean
): string[] {
  const hydrationStatus = waterOz < 48 ? 'low' : waterOz < 64 ? 'moderate' : 'good';
  const sleepStatus = sleepScore < 70 ? 'poor' : sleepScore < 85 ? 'fair' : 'good';
  const lines: string[] = [];

  lines.push(`You've logged ${totalDrinks} drinks (${totalCalories} cal from alcohol tonight).`);

  if (sleepStatus === 'poor') {
    lines.push('Your sleep score was low last night — alcohol tonight will likely compound fatigue and suppress HRV recovery.');
  } else if (sleepStatus === 'fair') {
    lines.push("Your sleep was fair last night. A 4th drink will likely push tomorrow's recovery into the red.");
  }

  if (hydrationStatus === 'low') {
    lines.push("You're under-hydrated today. Drink 8 oz of water before your next drink and again before bed.");
  } else if (hydrationStatus === 'moderate') {
    lines.push('Hydration is moderate. Match each remaining drink with a glass of water.');
  }

  if (hrv < 40) {
    lines.push("Your HRV is lower than baseline. Alcohol at this point will measurably impact tomorrow's recovery score.");
  }

  if (workoutDone) {
    lines.push("You worked out today — your muscles are recovering. Alcohol slows protein synthesis, so this is a good place to stop.");
  }

  lines.push(`Based on your weight and height, your liver processes ~1 drink/hour. Spacing out from here is your best move.`);
  lines.push('Before bed tonight: drink 16 oz of water with electrolytes — it will meaningfully reduce how tomorrow feels.');

  return lines;
}

// ─── Sub-components ────────────────────────────────────────────────────────────

type Pal = ReturnType<typeof getModalPalette>;

function DrinkRow({
  item, count, onAdd, onRemove, onDelete, pal,
}: {
  item: DrinkItem; count: number; onAdd: () => void; onRemove: () => void;
  onDelete?: () => void; pal: Pal;
}) {
  return (
    <View style={[styles.drinkRow, { borderBottomColor: pal.divider }]}>
      <View style={styles.drinkInfo}>
        <ThemedText style={[styles.drinkName, { color: pal.text }]}>{item.name}</ThemedText>
        <ThemedText style={[styles.drinkDetail, { color: pal.textSecondary }]}>{item.detail}</ThemedText>
      </View>
      <View style={styles.counter}>
        {onDelete && (
          <TouchableOpacity onPress={onDelete} activeOpacity={0.7} style={styles.deleteBtn}>
            <ThemedText style={[styles.deleteBtnText, { color: pal.textSecondary }]}>✕</ThemedText>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={[styles.counterBtn, { borderColor: pal.divider }]}
          onPress={onRemove}
          disabled={count === 0}
          activeOpacity={0.7}
        >
          <ThemedText style={[styles.counterBtnText, { color: count === 0 ? pal.textSecondary : pal.text }]}>−</ThemedText>
        </TouchableOpacity>
        <ThemedText style={[styles.counterCount, { color: pal.text }]}>{count}</ThemedText>
        <TouchableOpacity
          style={[styles.counterBtn, { borderColor: pal.accent }]}
          onPress={onAdd}
          activeOpacity={0.7}
        >
          <ThemedText style={[styles.counterBtnText, { color: pal.accent }]}>+</ThemedText>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function Section({
  title, items, counts, onAdd, onRemove, onDelete, pal, defaultOpen = true,
}: {
  title: string; items: DrinkItem[];
  counts: Record<string, number>; onAdd: (id: string) => void; onRemove: (id: string) => void;
  onDelete?: (id: string) => void; pal: Pal; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <View style={[styles.section, { borderColor: pal.divider }]}>
      <TouchableOpacity
        style={[styles.sectionHeader, { borderBottomColor: pal.divider }]}
        onPress={() => setOpen((v) => !v)}
        activeOpacity={0.8}
      >
        <ThemedText style={[styles.sectionTitle, { color: pal.textSecondary }]}>{title}</ThemedText>
        <ThemedText style={[styles.sectionChevron, { color: pal.textSecondary }]}>{open ? '›' : '›'}</ThemedText>
      </TouchableOpacity>
      {open && (
        <View style={styles.sectionItems}>
          {items.map((item) => (
            <DrinkRow
              key={item.id}
              item={item}
              count={counts[item.id] ?? 0}
              onAdd={() => onAdd(item.id)}
              onRemove={() => onRemove(item.id)}
              onDelete={onDelete ? () => onDelete(item.id) : undefined}
              pal={pal}
            />
          ))}
        </View>
      )}
    </View>
  );
}

function WarningCard({ insights }: { insights: string[] }) {
  return (
    <View style={styles.warningCard}>
      <ThemedText style={styles.warningTitle}>Heads Up — 4 Drinks Logged</ThemedText>
      {insights.map((line, i) => (
        <View key={i} style={styles.warningLine}>
          <ThemedText style={styles.warningBullet}>·</ThemedText>
          <ThemedText style={styles.warningText}>{line}</ThemedText>
        </View>
      ))}
    </View>
  );
}

function InsightEntry({ label, text, pal }: InsightConfig & { pal: Pal }) {
  return (
    <View style={[styles.insightEntry, { borderTopColor: pal.divider }]}>
      <ThemedText style={[styles.insightLabel, { color: pal.textSecondary }]}>{label}</ThemedText>
      <ThemedText style={[styles.insightText, { color: pal.text }]}>{text}</ThemedText>
    </View>
  );
}

const CUSTOM_DRINK_DEFAULT_CALORIES = 150;

function AddDrinkForm({ pal, onSave, onCancel }: {
  pal: Pal;
  onSave: (drink: DrinkItem) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');

  function handleSave() {
    if (!name.trim()) return;
    const drink: DrinkItem = {
      id: `custom_${Date.now()}`,
      name: name.trim(),
      detail: `~${CUSTOM_DRINK_DEFAULT_CALORIES} cal · custom`,
      calories: CUSTOM_DRINK_DEFAULT_CALORIES,
      standardDrinks: 1.0,
    };
    onSave(drink);
    setName('');
    Keyboard.dismiss();
  }

  const canSave = name.trim().length > 0;

  return (
    <View style={[styles.addForm, { borderColor: pal.divider, backgroundColor: pal.card }]}>
      <ThemedText style={[styles.addFormTitle, { color: pal.textSecondary }]}>ADD A DRINK</ThemedText>
      <TextInput
        style={[styles.addFormInput, { color: pal.text, borderColor: pal.divider }]}
        value={name}
        onChangeText={setName}
        placeholder="Drink name"
        placeholderTextColor={pal.textSecondary}
        returnKeyType="done"
        onSubmitEditing={handleSave}
        autoFocus
      />
      <ThemedText style={[styles.addFormHint, { color: pal.textSecondary }]}>
        Estimated ~{CUSTOM_DRINK_DEFAULT_CALORIES} cal · counts as 1 standard drink · saved to Your Drinks
      </ThemedText>
      <View style={styles.addFormButtons}>
        <TouchableOpacity
          onPress={onCancel}
          style={[styles.addFormBtn, { borderColor: pal.divider }]}
          activeOpacity={0.7}
        >
          <ThemedText style={[styles.addFormBtnText, { color: pal.textSecondary }]}>Cancel</ThemedText>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={handleSave}
          style={[styles.addFormBtn, { borderColor: canSave ? pal.accent : pal.divider, backgroundColor: canSave ? pal.accent : 'transparent' }]}
          disabled={!canSave}
          activeOpacity={0.8}
        >
          <ThemedText style={[styles.addFormBtnText, { color: canSave ? '#fff' : pal.textSecondary }]}>Save</ThemedText>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function localDateStrFromDate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}


function today() { return new Date(); }

function dateLabelFor(d: Date): string {
  const todayStr = localDateStrFromDate(today());
  const str = localDateStrFromDate(d);
  if (str === todayStr) return 'Tonight';
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  if (str === localDateStrFromDate(yesterday)) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function countsFromEntry(entry: any): Record<string, number> {
  return entry?.counts ?? {};
}

// ─── Main Modal ────────────────────────────────────────────────────────────────

type Props = {
  visible: boolean;
  onClose: () => void;
  sleepScore: number;
  hrv: number;
  waterOz: number;
  workoutDone: boolean;
};

export function DrinkingModal({ visible, onClose, sleepScore, hrv, waterOz, workoutDone }: Props) {
  const { isDark, userTheme } = useAppTheme();
  const palette = getModalPalette(isDark, userTheme);

  const [counts, setCounts]               = useState<Record<string, number>>({});
  const [selectedVibe, setSelectedVibe]   = useState<string | null>(null);
  const [selectedDate, setSelectedDate]   = useState<Date>(today());
  const [customDrinks, setCustomDrinks]   = useState<DrinkItem[]>([]);
  const [showAddForm, setShowAddForm]     = useState(false);

  const allItems = [...STATIC_ITEMS, ...customDrinks];

  // Load custom drinks
  useEffect(() => {
    AsyncStorage.getItem(CUSTOM_DRINKS_KEY).then((raw) => {
      if (raw) setCustomDrinks(JSON.parse(raw));
    }).catch(() => {});
  }, []);

  // Load drink log for selected date.
  // Cleanup cancels stale in-flight reads: if selectedDate changes (e.g. because
  // Effect2 reset it to today, or the user navigated), the previous async read
  // is discarded so it cannot overwrite counts with the wrong date's data.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    AsyncStorage.getItem('drink_log').then((raw) => {
      if (cancelled) return;
      const log: any[] = raw ? JSON.parse(raw) : [];
      const entry = log.find((e) => e.date === localDateStrFromDate(selectedDate));
      if (entry) {
        setCounts(countsFromEntry(entry));
        setSelectedVibe(entry.vibe ?? null);
      } else {
        setCounts({});
        setSelectedVibe(null);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [visible, selectedDate]);

  // Reset to today on every modal open.
  // Compare date strings before setting to avoid creating a new Date object
  // reference when already on today — which would trigger a needless Effect1
  // re-fire and a brief stale-load window.
  useEffect(() => {
    if (!visible) return;
    const todayDate = today();
    if (localDateStrFromDate(selectedDate) !== localDateStrFromDate(todayDate)) {
      setSelectedDate(todayDate);
    }
    setShowAddForm(false);
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const totalDrinks   = allItems.reduce((sum, item) => sum + (counts[item.id] ?? 0) * item.standardDrinks, 0);
  const totalCalories = allItems.reduce((sum, item) => sum + (counts[item.id] ?? 0) * item.calories, 0);
  const drinkCount    = Math.round(totalDrinks * 10) / 10;
  const isToday       = localDateStrFromDate(selectedDate) === localDateStrFromDate(today());
  const showWarning   = totalDrinks >= 4 && isToday;
  const dateLabel     = dateLabelFor(selectedDate);

  function goToPrevDay() {
    setSelectedDate((d) => { const n = new Date(d); n.setDate(n.getDate() - 1); return n; });
  }
  function goToNextDay() {
    if (isToday) return;
    setSelectedDate((d) => { const n = new Date(d); n.setDate(n.getDate() + 1); return n; });
  }

  // Persist current counts to AsyncStorage immediately — called after every
  // add/remove so a force-kill never loses a completed logged drink.
  async function persistCounts(nextCounts: Record<string, number>): Promise<void> {
    try {
      const dateStr = localDateStrFromDate(selectedDate);
      const raw     = await AsyncStorage.getItem('drink_log');
      const log: any[] = raw ? JSON.parse(raw) : [];
      const filtered   = log.filter((e) => e.date !== dateStr);
      const entry      = buildDrinkEntry(nextCounts, allItems, selectedVibe, dateStr);
      await AsyncStorage.setItem(
        'drink_log',
        JSON.stringify(entry ? [...filtered, entry] : filtered),
      );
    } catch {}
  }

  function add(id: string) {
    const next = { ...counts, [id]: (counts[id] ?? 0) + 1 };
    const prevTotal = allItems.reduce((sum, item) => sum + (counts[item.id] ?? 0) * item.standardDrinks, 0);
    const nextTotal = allItems.reduce((sum, item) => sum + (next[item.id] ?? 0) * item.standardDrinks, 0);
    if (prevTotal < 4 && nextTotal >= 4) {
      triggerDrinkWarning().catch(() => {});
    }
    setCounts(next);
    persistCounts(next).catch(() => {});
  }

  function remove(id: string) {
    const next = { ...counts };
    if ((next[id] ?? 0) > 0) next[id] -= 1;
    setCounts(next);
    persistCounts(next).catch(() => {});
  }

  function saveCustomDrink(drink: DrinkItem) {
    const updated = [...customDrinks, drink];
    setCustomDrinks(updated);
    AsyncStorage.setItem(CUSTOM_DRINKS_KEY, JSON.stringify(updated)).catch(() => {});
    setShowAddForm(false);
  }

  function deleteCustomDrink(id: string) {
    const updated = customDrinks.filter((d) => d.id !== id);
    setCustomDrinks(updated);
    AsyncStorage.setItem(CUSTOM_DRINKS_KEY, JSON.stringify(updated)).catch(() => {});
    // Remove any logged counts for deleted drink
    setCounts((prev) => { const next = { ...prev }; delete next[id]; return next; });
  }

  async function handleClose() {
    // Safety-net persist: catches vibe changes and any edge cases where
    // persistCounts wasn't called (e.g. the user changed vibe then closed).
    await persistCounts(counts);
    if (drinkCount > 0) {
      trackEvent('drinking_plan_used', { source_screen: 'drinking' });
    }
    setCounts({});
    setSelectedVibe(null);
    onClose();
  }

  const warningInsights  = showWarning
    ? buildWarningInsights(drinkCount, totalCalories, sleepScore, hrv, waterOz, workoutDone)
    : [];
  const activeVibe       = vibes.find((v) => v.id === selectedVibe);
  const vibeInsightEntries: InsightConfig[] = activeVibe
    ? [
        { label: 'Macros Today',      text: activeVibe.insights.macros   },
        { label: 'Tomorrow',          text: activeVibe.insights.tomorrow  },
        { label: 'Sleep Prediction',  text: activeVibe.insights.sleep     },
        { label: 'Workout Impact',    text: activeVibe.insights.workout   },
      ]
    : [];

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <KeyboardAvoidingView
        style={styles.keyboardAvoid}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
      <View style={[styles.container, { backgroundColor: palette.background, paddingTop: Spacing.three }]}>

        {/* Header */}
        <View style={[styles.header, { borderBottomColor: palette.divider }]}>
          <View>
            <ThemedText style={[styles.title, { color: palette.text }]}>Drink Log</ThemedText>
            <View style={styles.datePicker}>
              <TouchableOpacity onPress={goToPrevDay} activeOpacity={0.7}>
                <ThemedText style={[styles.dateArrow, { color: palette.accent }]}>‹</ThemedText>
              </TouchableOpacity>
              <ThemedText style={[styles.dateLabel, { color: palette.textSecondary }]}>{dateLabel}</ThemedText>
              <TouchableOpacity onPress={goToNextDay} activeOpacity={isToday ? 1 : 0.7} disabled={isToday}>
                <ThemedText style={[styles.dateArrow, { color: isToday ? palette.divider : palette.accent }]}>›</ThemedText>
              </TouchableOpacity>
            </View>
          </View>
          <TouchableOpacity onPress={handleClose} activeOpacity={0.7}>
            <ThemedText style={[styles.doneBtn, { color: palette.accent }]}>Done</ThemedText>
          </TouchableOpacity>
        </View>

        {/* Running total */}
        <View style={[styles.totalBar, { borderBottomColor: palette.divider }]}>
          <View style={styles.totalCell}>
            <ThemedText style={[styles.totalNumber, { color: palette.text }]}>{drinkCount}</ThemedText>
            <ThemedText style={[styles.totalLabel, { color: palette.textSecondary }]}>drinks</ThemedText>
          </View>
          <View style={[styles.totalDivider, { backgroundColor: palette.divider }]} />
          <View style={styles.totalCell}>
            <ThemedText style={[styles.totalNumber, { color: palette.text }]}>{totalCalories}</ThemedText>
            <ThemedText style={[styles.totalLabel, { color: palette.textSecondary }]}>cal from alcohol</ThemedText>
          </View>
        </View>

        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
          {showWarning && <WarningCard insights={warningInsights} />}

          {/* Your Drinks — only shown when custom drinks exist */}
          {customDrinks.length > 0 && (
            <Section
              title="Your Drinks"
              items={customDrinks}
              counts={counts}
              onAdd={add}
              onRemove={remove}
              onDelete={deleteCustomDrink}
              pal={palette}
            />
          )}

          <Section title="Beer"      items={BEER}      counts={counts} onAdd={add} onRemove={remove} pal={palette} defaultOpen={false} />
          <Section title="Wine"      items={WINE}      counts={counts} onAdd={add} onRemove={remove} pal={palette} defaultOpen={false} />
          <Section title="Cocktails" items={COCKTAILS} counts={counts} onAdd={add} onRemove={remove} pal={palette} defaultOpen={false} />
          <Section title="Shots"     items={SHOTS}     counts={counts} onAdd={add} onRemove={remove} pal={palette} defaultOpen={false} />

          {/* Add custom drink */}
          {showAddForm ? (
            <AddDrinkForm
              pal={palette}
              onSave={saveCustomDrink}
              onCancel={() => setShowAddForm(false)}
            />
          ) : (
            <TouchableOpacity
              style={[styles.addDrinkBtn, { borderColor: palette.divider }]}
              onPress={() => setShowAddForm(true)}
              activeOpacity={0.7}
            >
              <ThemedText style={[styles.addDrinkBtnText, { color: palette.textSecondary }]}>+ Add a drink</ThemedText>
            </TouchableOpacity>
          )}

          {/* Plan Ahead */}
          <View style={styles.planSection}>
            <ThemedText style={[styles.planTitle, { color: palette.text }]}>Plan Ahead</ThemedText>
            <ThemedText style={[styles.planSubtitle, { color: palette.textSecondary }]}>
              pick your vibe for personalized macro and recovery tips
            </ThemedText>

            <View style={styles.vibeCards}>
              {vibes.map((v) => (
                <TouchableOpacity
                  key={v.id}
                  style={[
                    styles.vibeCard,
                    { backgroundColor: palette.card, borderColor: selectedVibe === v.id ? palette.accent : palette.divider },
                  ]}
                  onPress={() => setSelectedVibe(selectedVibe === v.id ? null : v.id)}
                  activeOpacity={0.7}
                >
                  <ThemedText style={[
                    styles.vibeLabel,
                    { color: selectedVibe === v.id ? palette.accent : palette.text },
                  ]}>
                    {v.label}
                  </ThemedText>
                </TouchableOpacity>
              ))}
            </View>

            {activeVibe && (
              <View style={[styles.vibeInsights, { borderColor: palette.divider }]}>
                {vibeInsightEntries.map((entry) => (
                  <InsightEntry key={entry.label} {...entry} pal={palette} />
                ))}
              </View>
            )}
          </View>

        </ScrollView>
      </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  keyboardAvoid: { flex: 1 },
  container: { flex: 1 },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start',
    paddingHorizontal: Spacing.three, paddingBottom: Spacing.three,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title:    { fontFamily: Fonts.serif, fontSize: 26, fontStyle: 'italic', fontWeight: '400', paddingTop: 3, paddingRight: 4 },
  doneBtn:  { fontSize: 14, letterSpacing: 0.3 },
  datePicker:   { flexDirection: 'row', alignItems: 'center', gap: Spacing.one, marginTop: 4 },
  dateArrow:    { fontFamily: Fonts.serif, fontSize: 22, fontStyle: 'italic', paddingHorizontal: 4 },
  dateLabel:    { fontSize: 14, minWidth: 70, textAlign: 'center' },
  totalBar: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.three, paddingVertical: Spacing.three,
    gap: Spacing.three,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  totalCell:    { flex: 1 },
  totalDivider: { width: 1, height: 36 },
  totalNumber:  { fontFamily: Fonts.serif, fontSize: 32, fontStyle: 'italic', fontWeight: '400', lineHeight: 36, paddingTop: 6, paddingRight: 4 },
  totalLabel:   { fontSize: 11, marginTop: 2 },

  scroll: { gap: Spacing.three, paddingHorizontal: Spacing.three, paddingTop: Spacing.three, paddingBottom: Spacing.six },

  warningCard: {
    borderWidth: StyleSheet.hairlineWidth, borderColor: '#F5C842',
    padding: Spacing.three, gap: Spacing.two,
  },
  warningTitle: { fontSize: 9, letterSpacing: 2, textTransform: 'uppercase', color: '#7A6000', fontWeight: '600' },
  warningLine:  { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  warningBullet:{ fontSize: 16, lineHeight: 20, color: '#7A6000', marginTop: -1 },
  warningText:  { flex: 1, fontSize: 13, color: '#5A4800', lineHeight: 19 },

  section: { borderWidth: StyleSheet.hairlineWidth },
  sectionHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: Spacing.three, paddingVertical: Spacing.two,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sectionTitle:   { fontSize: 9, letterSpacing: 1.5, textTransform: 'uppercase' },
  sectionChevron: { fontSize: 18, fontWeight: '300' },
  sectionItems:   { paddingHorizontal: Spacing.three },

  drinkRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  drinkInfo:   { flex: 1, gap: 2 },
  drinkName:   { fontSize: 15 },
  drinkDetail: { fontSize: 12 },
  counter:     { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  counterBtn:  { width: 30, height: 30, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  counterBtnText: { fontSize: 20, fontWeight: '300', lineHeight: 24 },
  counterCount:   { fontFamily: Fonts.serif, fontSize: 18, fontStyle: 'italic', minWidth: 24, textAlign: 'center' },
  deleteBtn:      { paddingHorizontal: 6, paddingVertical: 4 },
  deleteBtnText:  { fontSize: 13 },

  addDrinkBtn: {
    borderWidth: StyleSheet.hairlineWidth, borderStyle: 'dashed',
    paddingVertical: 14, alignItems: 'center',
  },
  addDrinkBtnText: { fontSize: 14, letterSpacing: 0.3 },

  addForm: {
    borderWidth: StyleSheet.hairlineWidth,
    padding: Spacing.three, gap: Spacing.two,
  },
  addFormTitle: { fontSize: 9, letterSpacing: 1.5, textTransform: 'uppercase' },
  addFormInput: {
    borderWidth: StyleSheet.hairlineWidth, borderRadius: 4,
    paddingHorizontal: Spacing.two, paddingVertical: 10, fontSize: 15,
  },
  addFormHint:    { fontSize: 12, fontStyle: 'italic' },
  addFormButtons: { flexDirection: 'row', gap: Spacing.two, marginTop: Spacing.one },
  addFormBtn: {
    flex: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: 4,
    paddingVertical: 10, alignItems: 'center',
  },
  addFormBtnText: { fontSize: 14, fontWeight: '500' },

  planSection: { gap: Spacing.two },
  planTitle:    { fontFamily: Fonts.serif, fontSize: 20, fontStyle: 'italic', fontWeight: '400' },
  planSubtitle: { fontSize: 13, fontStyle: 'italic' },

  vibeCards: { flexDirection: 'row', gap: Spacing.two },
  vibeCard: {
    flex: 1, alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: Spacing.three, paddingHorizontal: Spacing.one,
  },
  vibeLabel: { fontFamily: Fonts.serif, fontSize: 13, fontStyle: 'italic', textAlign: 'center' },

  vibeInsights: { borderWidth: StyleSheet.hairlineWidth },
  insightEntry: {
    padding: Spacing.three, borderTopWidth: StyleSheet.hairlineWidth, gap: 4,
  },
  insightLabel: { fontSize: 9, letterSpacing: 1.5, textTransform: 'uppercase' },
  insightText:  { fontFamily: Fonts.serif, fontSize: 14, fontStyle: 'italic', lineHeight: 20 },
});
