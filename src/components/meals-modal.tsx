import AsyncStorage from '@react-native-async-storage/async-storage';
import { Image } from 'expo-image';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Fonts, Spacing } from '@/constants/theme';
import { analyzeMealPhoto, estimateMacrosFromText } from '@/services/food-ai';
import { logMeal } from '@/services/supabase';
import { useAppTheme } from '@/context/theme-context';
import { getModalPalette } from '@/utils/modal-palette';
import { trackEvent } from '@/services/analytics';

const MEAL_LOG_KEY = 'meal_log';

// Universal functional colors for macro pills — not brand-specific
const MACRO_PROTEIN = '#7A9E78';
const MACRO_CARBS   = '#9888C8';
const MACRO_FAT     = '#C06050';

export type LoggedMeal = {
  id:       string;
  name:     string;    // display label: 'Breakfast' | 'Lunch' | 'Dinner' | 'Snack'
  /**
   * Display string for when this entry was LOGGED (upload time).
   * Shown in the meal card UI only — never used for analytical purposes.
   * Example: "3:47 PM"
   */
  time:     string;
  date:     string;
  items:    string;
  photoUri?: string;
  calories: number;
  protein:  number;
  carbs:    number;
  fat:      number;
  source?:  'photo_ai' | 'text_ai' | 'manual';
  /**
   * When the user actually consumed this meal (ISO timestamp).
   * Absent = timing is UNKNOWN — do not use 'time' as a fallback for analysis.
   * Only set when the user has explicitly declared or confirmed the eat time.
   * Future UI: defaults to now(), allows Breakfast/Lunch/Dinner/Snack presets
   * or a custom time picker.
   */
  consumedAt?: string;
};

type MacroTotals = { calories: number; protein: number; carbs: number; fat: number };

const MEAL_TYPES = ['Breakfast', 'Lunch', 'Dinner', 'Snack'] as const;
type MealType = typeof MEAL_TYPES[number];

// ─── Date helpers ─────────────────────────────────────────────────────────────

function localDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function localDateStrFromDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function timeStr() {
  return new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function dateLabelFor(date: Date): string {
  const now = new Date();
  const todayStr = localDateStr();
  const dateStr  = localDateStrFromDate(date);
  if (dateStr === todayStr) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (dateStr === localDateStrFromDate(yesterday)) return 'Yesterday';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

async function loadMealsForDate(dateStr: string): Promise<LoggedMeal[]> {
  const raw = await AsyncStorage.getItem(MEAL_LOG_KEY);
  const all: LoggedMeal[] = raw ? JSON.parse(raw) : [];
  return all.filter((m) => m.date === dateStr);
}


type FlowView = 'log' | 'analyzing' | 'confirm' | 'text-entry';

type PendingMeal = {
  editingId?: string;   // set when editing an existing meal
  mealType: MealType;
  photoUri?: string;    // optional — not present for text-entry meals
  itemsText: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  source?: 'photo_ai' | 'text_ai' | 'manual';
  /**
   * User-declared consumption time (ISO string), or null if timing is unknown.
   * Defaults to now() when a new meal is created — user can adjust or clear it.
   * null = user explicitly chose "unknown timing".
   * Never use the logged_at / time field as a proxy for when food was eaten.
   */
  consumedAt?: string | null;
};

// ─── Sub-components ───────────────────────────────────────────────────────────

/** Format a macro gram value to at most 1 decimal place, trimming trailing zeros. */
function fmtMacro(g: number): string {
  return parseFloat(g.toFixed(1)).toString();
}

function MacroPill({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <View style={[styles.macroPill, { borderColor: color + '60' }]}>
      <ThemedText style={[styles.macroPillLabel, { color }]}>{label}</ThemedText>
      <ThemedText style={[styles.macroPillValue, { color }]}>{fmtMacro(value)}g</ThemedText>
    </View>
  );
}

/** One logged entry within a meal section. */
function MealEntryRow({
  meal,
  mealType,
  isFirst,
  onEdit,
  onDelete,
  pal,
}: {
  meal: LoggedMeal;
  mealType: MealType;
  isFirst: boolean;
  onEdit: (meal: LoggedMeal, mealType: MealType) => void;
  onDelete: (id: string) => void;
  pal: ReturnType<typeof getModalPalette>;
}) {
  return (
    <View style={isFirst ? undefined : [styles.entryDivider, { borderTopColor: pal.divider }]}>
      {meal.photoUri && (
        <Image source={{ uri: meal.photoUri }} style={styles.mealPhoto} contentFit="cover" />
      )}
      <View style={styles.mealHeader}>
        <ThemedText style={[styles.mealItems, { color: pal.textSecondary, flex: 1, paddingRight: 8 }]}>
          {meal.items}
        </ThemedText>
        <View style={styles.mealActions}>
          <TouchableOpacity onPress={() => onEdit(meal, mealType)} activeOpacity={0.7}>
            <ThemedText style={[styles.editLink, { color: pal.accent }]}>{meal.calories} kcal · Edit</ThemedText>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => onDelete(meal.id)} activeOpacity={0.7} style={styles.deleteBtn}>
            <ThemedText style={[styles.deleteLink, { color: pal.textSecondary }]}>Delete</ThemedText>
          </TouchableOpacity>
        </View>
      </View>
      <View style={styles.macroRow}>
        <MacroPill label="Protein" value={meal.protein} color={MACRO_PROTEIN} />
        <MacroPill label="Carbs" value={meal.carbs} color={MACRO_CARBS} />
        <MacroPill label="Fat" value={meal.fat} color={MACRO_FAT} />
      </View>
    </View>
  );
}

/**
 * A meal category card supporting zero or more logged entries.
 *
 * Empty: shows Photo → and Type it in → add buttons.
 * Populated: shows each entry with edit/delete, then compact + add buttons.
 */
function MealSection({
  mealType,
  meals,
  onAddPhoto,
  onTypeText,
  onEdit,
  onDelete,
  pal,
}: {
  mealType: MealType;
  meals: LoggedMeal[];
  onAddPhoto: (mealType: MealType) => void;
  onTypeText: (mealType: MealType) => void;
  onEdit: (meal: LoggedMeal, mealType: MealType) => void;
  onDelete: (id: string) => void;
  pal: ReturnType<typeof getModalPalette>;
}) {
  const isEmpty = meals.length === 0;

  return (
    <View style={[styles.mealCard, { borderColor: pal.divider }]}>
      <ThemedText style={[styles.mealName, { color: pal.text }]}>{mealType}</ThemedText>

      {isEmpty ? (
        <View style={styles.addButtonsRow}>
          <TouchableOpacity
            style={[styles.addBtn, { borderColor: pal.divider }]}
            onPress={() => onAddPhoto(mealType)}
            activeOpacity={0.7}
          >
            <ThemedText style={[styles.addBtnText, { color: pal.accent }]}>Photo →</ThemedText>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.addBtn, { borderColor: pal.divider }]}
            onPress={() => onTypeText(mealType)}
            activeOpacity={0.7}
          >
            <ThemedText style={[styles.addBtnText, { color: pal.accent }]}>Type it in →</ThemedText>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          {meals.map((meal, idx) => (
            <MealEntryRow
              key={meal.id}
              meal={meal}
              mealType={mealType}
              isFirst={idx === 0}
              onEdit={onEdit}
              onDelete={onDelete}
              pal={pal}
            />
          ))}
          {/* Add another item to this category */}
          <View style={[styles.addButtonsRow, styles.addMoreRow, { borderTopColor: pal.divider }]}>
            <TouchableOpacity
              style={[styles.addBtn, { borderColor: pal.divider }]}
              onPress={() => onAddPhoto(mealType)}
              activeOpacity={0.7}
            >
              <ThemedText style={[styles.addBtnText, { color: pal.accent }]}>+ Photo</ThemedText>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.addBtn, { borderColor: pal.divider }]}
              onPress={() => onTypeText(mealType)}
              activeOpacity={0.7}
            >
              <ThemedText style={[styles.addBtnText, { color: pal.accent }]}>+ Type it in</ThemedText>
            </TouchableOpacity>
          </View>
        </>
      )}
    </View>
  );
}

// ─── Main Modal ───────────────────────────────────────────────────────────────

export function MealsModal({
  visible,
  onClose,
  onMealLogged,
}: {
  visible: boolean;
  onClose: () => void;
  onMealLogged?: (totals: MacroTotals, date: string) => void;
}) {
  const { isDark, userTheme } = useAppTheme();
  const dynPalette = getModalPalette(isDark, userTheme);

  const [view, setView] = useState<FlowView>('log');
  const [meals, setMeals] = useState<LoggedMeal[]>([]);
  const [pending, setPending] = useState<PendingMeal | null>(null);
  const [itemsEdited, setItemsEdited] = useState(false);
  const [recalcLoading, setRecalcLoading] = useState(false);
  const [textEntryMealType, setTextEntryMealType] = useState<MealType>('Breakfast');
  const [textEntryInput, setTextEntryInput] = useState('');
  const [textAnalyzing, setTextAnalyzing] = useState(false);

  // ── Date picker ──────────────────────────────────────────────────────────────
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const selectedDateStr = localDateStrFromDate(selectedDate);
  const isToday = selectedDateStr === localDateStr();

  function goToPrevDay() {
    setSelectedDate((d) => { const n = new Date(d); n.setDate(n.getDate() - 1); return n; });
  }
  function goToNextDay() {
    if (isToday) return;
    setSelectedDate((d) => { const n = new Date(d); n.setDate(n.getDate() + 1); return n; });
  }

  // Reset state when modal opens
  useEffect(() => {
    if (!visible) return;
    setView('log');
    setPending(null);
    setTextEntryInput('');
    setSelectedDate(new Date());
  }, [visible]);

  // Reload meals when date changes
  useEffect(() => {
    if (!visible) return;
    loadMealsForDate(selectedDateStr).then(setMeals).catch(() => {});
  }, [visible, selectedDateStr]);

  async function handleAddPhoto(mealType: MealType) {
    // Pre-request permissions so they're ready before the Alert fires
    await Promise.allSettled([
      ImagePicker.requestCameraPermissionsAsync(),
      ImagePicker.requestMediaLibraryPermissionsAsync(),
    ]);

    Alert.alert('Add Photo', 'Choose source', [
      {
        text: 'Camera',
        // Delay so the Alert has time to fully dismiss before iOS presents the camera
        onPress: () => setTimeout(() => openPicker('camera', mealType), 300),
      },
      {
        text: 'Photo Library',
        onPress: () => setTimeout(() => openPicker('library', mealType), 300),
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

  async function openPicker(source: 'camera' | 'library', mealType: MealType) {
    const opts: ImagePicker.ImagePickerOptions = {
      mediaTypes: ['images' as any],
      quality: 1,  // pick full quality — we resize ourselves below
    };

    let result: ImagePicker.ImagePickerResult;
    try {
      result = source === 'camera'
        ? await ImagePicker.launchCameraAsync(opts)
        : await ImagePicker.launchImageLibraryAsync(opts);
    } catch {
      Alert.alert('Could not open camera', 'Please check camera and photo access in Settings.');
      return;
    }

    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];

    setView('analyzing');

    try {
      // Resize to max 1024px wide (maintains aspect ratio) and compress to JPEG
      // This keeps the base64 payload under ~150KB regardless of source resolution
      const resized = await ImageManipulator.manipulateAsync(
        asset.uri,
        [{ resize: { width: 1024 } }],
        { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG, base64: true },
      );
      if (!resized.base64) throw new Error('Could not process image.');

      const detected = await analyzeMealPhoto(resized.base64, 'image/jpeg');
      const itemsText = detected.items.map((i) => `${i.quantity} ${i.name}`).join('\n');
      setPending({
        mealType,
        photoUri: asset.uri,
        itemsText,
        calories:   detected.macros.calories,
        protein:    detected.macros.protein,
        carbs:      detected.macros.carbs,
        fat:    detected.macros.fat,
        source: 'photo_ai',
        // consumedAt not set — category (mealType) is used as coarse bucket instead
      });
      setItemsEdited(false);
      setView('confirm');
    } catch (e: any) {
      setView('log');
      const msg = String(e?.message ?? '');
      // Don't show raw HTML from gateway errors
      const display = msg.includes('<') ? 'Could not connect to AI. Please try again.' : msg;
      Alert.alert('Could not analyze photo', display);
    }
  }

  function handleTypeText(mealType: MealType) {
    setTextEntryMealType(mealType);
    setTextEntryInput('');
    setView('text-entry');
  }

  function handleEditMeal(meal: LoggedMeal, mealType: MealType) {
    setPending({
      editingId: meal.id,
      mealType,
      photoUri:  meal.photoUri,
      itemsText: meal.items,
      calories:  meal.calories,
      protein:   meal.protein,
      carbs:     meal.carbs,
      fat:       meal.fat,
      // Preserve existing consumedAt if the user had set one; otherwise absent
      consumedAt: meal.consumedAt,
    });
    setItemsEdited(false);
    setView('confirm');
  }

  async function handleDeleteMeal(id: string) {
    Alert.alert('Delete meal?', "This can't be undone.", [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
          const raw = await AsyncStorage.getItem(MEAL_LOG_KEY);
          const all: LoggedMeal[] = raw ? JSON.parse(raw) : [];
          const filtered = all.filter((m) => m.id !== id);
          await AsyncStorage.setItem(MEAL_LOG_KEY, JSON.stringify(filtered));
          } catch (e: any) {
            Alert.alert('Could not delete meal', e?.message ?? 'Please try again.');
            return;
          }
          const updated = meals.filter((m) => m.id !== id);
          setMeals(updated);
          const totals = updated
            .filter((m) => m.date === selectedDateStr)
            .reduce<MacroTotals>(
              (acc, m) => ({
                calories: acc.calories + m.calories,
                protein:  acc.protein + m.protein,
                carbs:    acc.carbs + m.carbs,
                fat:      acc.fat + m.fat,
              }),
              { calories: 0, protein: 0, carbs: 0, fat: 0 },
            );
          onMealLogged?.(totals, selectedDateStr);
        },
      },
    ]);
  }

  async function analyzeText() {
    if (!textEntryInput.trim()) return;
    setTextAnalyzing(true);
    try {
      const macros = await estimateMacrosFromText(textEntryInput.trim());
      setPending({
        mealType:   textEntryMealType,
        itemsText:  textEntryInput.trim(),
        calories: macros.calories,
        protein:  macros.protein,
        carbs:    macros.carbs,
        fat:      macros.fat,
        source:   'text_ai',
        // consumedAt not set — category (mealType) is used as coarse bucket instead
      });
      setItemsEdited(false);
      setView('confirm');
    } catch (e: any) {
      Alert.alert('Could not analyze', e?.message ?? 'Please try again.');
    } finally {
      setTextAnalyzing(false);
    }
  }

  async function recalculate() {
    if (!pending) return;
    setRecalcLoading(true);
    try {
      const macros = await estimateMacrosFromText(pending.itemsText);
      setPending((p) => p ? { ...p, ...macros } : p);
      setItemsEdited(false);
    } catch (e: any) {
      const msg = String(e?.message ?? '');
      const display = msg.includes('<') ? 'Could not connect to AI. Try again.' : (msg || 'Could not recalculate. Try again.');
      Alert.alert('Error', display);
    } finally {
      setRecalcLoading(false);
    }
  }

  async function saveMeal() {
    if (!pending) return;
    const meal: LoggedMeal = {
      id:        pending.editingId ?? Date.now().toString(),
      name:      pending.mealType,
      time:      timeStr(),             // upload/log display time — not consumption time
      date:      selectedDateStr,       // use selected (possibly backdated) date
      items:     pending.itemsText.replace(/\n/g, ', '),
      photoUri:  pending.photoUri,
      calories:  pending.calories,
      protein:   pending.protein,
      carbs:     pending.carbs,
      fat:       pending.fat,
      source:    pending.source,
      // null (user chose unknown) → undefined (absent from stored record = unknown)
      consumedAt: pending.consumedAt ?? undefined,
    };

    try {
      const raw = await AsyncStorage.getItem(MEAL_LOG_KEY);
      const all: LoggedMeal[] = raw ? JSON.parse(raw) : [];
      const filtered = pending.editingId ? all.filter((m) => m.id !== pending.editingId) : all;
      await AsyncStorage.setItem(MEAL_LOG_KEY, JSON.stringify([...filtered, meal]));
    } catch (e: any) {
      Alert.alert('Could not save meal', e?.message ?? 'Please try again.');
      return;
    }

    // Persist to the server in the background.
    // The local save above has already succeeded — a server failure must never
    // affect the locally saved meal or surface any error to the user.
    logMeal({
      meal_name:   meal.name,
      items:       meal.items,
      calories:    meal.calories,
      protein_g:   meal.protein,
      carbs_g:     meal.carbs,
      fat_g:       meal.fat,
      source:      meal.source ?? 'manual',
      consumed_at: meal.consumedAt,   // undefined = unknown = omitted from request
    }).catch((e) => console.error('[meals] server sync failed:', e));

    const updated = pending.editingId
      ? meals.map((m) => (m.id === pending.editingId ? meal : m))
      : [...meals, meal];
    setMeals(updated);

    const totals = updated.reduce<MacroTotals>(
      (acc, m) => ({
        calories: acc.calories + m.calories,
        protein: acc.protein + m.protein,
        carbs: acc.carbs + m.carbs,
        fat: acc.fat + m.fat,
      }),
      { calories: 0, protein: 0, carbs: 0, fat: 0 },
    );
    onMealLogged?.(totals, selectedDateStr);
    trackEvent('meal_logged', { source_screen: 'meals' });

    setPending(null);
    setView('log');
  }

  const mealsByType   = (type: MealType) => meals.filter((m) => m.name === type);
  const snackMeals    = meals.filter((m) => m.name === 'Snack');
  const totalCals     = meals.reduce((s, m) => s + m.calories, 0);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <View style={[styles.container, { backgroundColor: dynPalette.background, paddingTop: Spacing.three }]}>

        {/* ── Header ── */}
        <View style={styles.header}>
          {view !== 'log' ? (
            <TouchableOpacity
              onPress={() => { setPending(null); setView('log'); }}
              style={styles.backBtn}
              activeOpacity={0.7}
            >
              <ThemedText style={[styles.backBtnText, { color: dynPalette.accent }]}>← Back</ThemedText>
            </TouchableOpacity>
          ) : (
            <View>
              <ThemedText style={[styles.title, { color: dynPalette.text }]}>My Meals</ThemedText>
              {/* Date picker */}
              <View style={styles.datePicker}>
                <TouchableOpacity onPress={goToPrevDay} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <ThemedText style={[styles.dateArrow, { color: dynPalette.accent }]}>‹</ThemedText>
                </TouchableOpacity>
                <ThemedText style={[styles.dateLabel, { color: dynPalette.textSecondary }]}>
                  {dateLabelFor(selectedDate)}
                </ThemedText>
                <TouchableOpacity
                  onPress={goToNextDay}
                  disabled={isToday}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <ThemedText style={[styles.dateArrow, { color: isToday ? dynPalette.divider : dynPalette.accent }]}>›</ThemedText>
                </TouchableOpacity>
              </View>
              {totalCals > 0 && (
                <ThemedText style={[styles.subtitle, { color: dynPalette.textSecondary }]}>
                  {totalCals} kcal
                </ThemedText>
              )}
            </View>
          )}
          <TouchableOpacity onPress={onClose} activeOpacity={0.7}>
            <ThemedText style={[styles.doneBtn, { color: dynPalette.accent }]}>Done</ThemedText>
          </TouchableOpacity>
        </View>

        {/* ── LOG VIEW ── */}
        {view === 'log' && (
          <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
            {/* Breakfast, Lunch, Dinner — unlimited entries per type */}
            {(['Breakfast', 'Lunch', 'Dinner'] as const).map((type) => (
              <MealSection
                key={type}
                mealType={type}
                meals={mealsByType(type)}
                onAddPhoto={handleAddPhoto}
                onTypeText={handleTypeText}
                onEdit={handleEditMeal}
                onDelete={handleDeleteMeal}
                pal={dynPalette}
              />
            ))}

            {/* Snack — all snack entries in one section */}
            <MealSection
              mealType="Snack"
              meals={snackMeals}
              onAddPhoto={handleAddPhoto}
              onTypeText={handleTypeText}
              onEdit={handleEditMeal}
              onDelete={handleDeleteMeal}
              pal={dynPalette}
            />

            {/* + Add snack — prominent shortcut below the snack card */}
            <TouchableOpacity
              style={[styles.addSnackBtn, { borderColor: dynPalette.divider }]}
              onPress={() => handleTypeText('Snack')}
              activeOpacity={0.7}
            >
              <ThemedText style={[styles.addBtnText, { color: dynPalette.accent }]}>+ Add snack</ThemedText>
            </TouchableOpacity>
          </ScrollView>
        )}

        {/* ── ANALYZING ── */}
        {view === 'analyzing' && (
          <View style={styles.centeredContent}>
            <ActivityIndicator size="large" color={dynPalette.accent} />
            <ThemedText style={[styles.analyzingTitle, { color: dynPalette.text }]}>Analyzing your meal…</ThemedText>
            <ThemedText style={[styles.analyzingSubText, { color: dynPalette.textSecondary }]}>
              Claude is identifying foods and estimating macros
            </ThemedText>
          </View>
        )}

        {/* ── TEXT ENTRY ── */}
        {view === 'text-entry' && (
          <View style={styles.textEntryContainer}>
            <ThemedText style={[styles.textEntryLabel, { color: dynPalette.text }]}>
              What did you have for {textEntryMealType}?
            </ThemedText>
            <TextInput
              style={[styles.textEntryInput, { backgroundColor: dynPalette.card, color: dynPalette.text, borderColor: dynPalette.divider }]}
              value={textEntryInput}
              onChangeText={setTextEntryInput}
              placeholder="e.g. grilled chicken breast, brown rice, broccoli"
              placeholderTextColor={dynPalette.textSecondary}
              multiline
              returnKeyType="done"
              blurOnSubmit
              autoFocus
            />
            <TouchableOpacity
              style={[styles.actionBtn, { borderColor: dynPalette.accent }, textAnalyzing && { opacity: 0.6 }]}
              onPress={analyzeText}
              disabled={textAnalyzing || !textEntryInput.trim()}
              activeOpacity={0.8}
            >
              {textAnalyzing
                ? <ActivityIndicator size="small" color={dynPalette.accent} />
                : <ThemedText style={[styles.actionBtnText, { color: dynPalette.accent }]}>Estimate Macros →</ThemedText>
              }
            </TouchableOpacity>
          </View>
        )}

        {/* ── CONFIRM ── */}
        {view === 'confirm' && pending && (
          <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>

            {pending.photoUri && (
              <Image
                source={{ uri: pending.photoUri }}
                style={styles.confirmPhoto}
                contentFit="cover"
              />
            )}

            {/* Detected foods — editable */}
            <View style={[styles.card, { borderColor: dynPalette.divider }]}>
              <View style={styles.cardLabelRow}>
                <ThemedText style={[styles.cardLabel, { color: dynPalette.textSecondary }]}>Detected Foods</ThemedText>
                <ThemedText style={[styles.cardHint, { color: dynPalette.accent }]}>Edit if anything's off</ThemedText>
              </View>
              <TextInput
                style={[styles.itemsInput, { color: dynPalette.text }]}
                value={pending.itemsText}
                onChangeText={(t) => {
                  setPending((p) => p ? { ...p, itemsText: t } : p);
                  setItemsEdited(true);
                }}
                multiline
                returnKeyType="done"
                blurOnSubmit
                placeholderTextColor={dynPalette.textSecondary}
              />
              {itemsEdited && (
                <TouchableOpacity
                  style={[styles.recalcBtn, { borderColor: dynPalette.accent + '60' }]}
                  onPress={recalculate}
                  disabled={recalcLoading}
                  activeOpacity={0.8}
                >
                  {recalcLoading
                    ? <ActivityIndicator size="small" color={dynPalette.accent} />
                    : <ThemedText style={[styles.recalcBtnText, { color: dynPalette.accent }]}>Recalculate Macros →</ThemedText>
                  }
                </TouchableOpacity>
              )}
            </View>

            {/* Macro estimate */}
            <View style={[styles.card, { borderColor: dynPalette.divider }]}>
              <ThemedText style={[styles.cardLabel, { color: dynPalette.textSecondary }]}>Estimated Nutrition for {pending.mealType}</ThemedText>
              <ThemedText style={[styles.bigCalories, { color: dynPalette.text }]}>{pending.calories} kcal</ThemedText>
              <View style={styles.macroRow}>
                <MacroPill label="Protein" value={pending.protein} color={MACRO_PROTEIN} />
                <MacroPill label="Carbs" value={pending.carbs} color={MACRO_CARBS} />
                <MacroPill label="Fat" value={pending.fat} color={MACRO_FAT} />
              </View>
            </View>

            <TouchableOpacity
              style={[styles.actionBtn, { borderColor: dynPalette.accent }]}
              onPress={saveMeal}
              activeOpacity={0.8}
            >
              <ThemedText style={[styles.actionBtnText, { color: dynPalette.accent }]}>Save {pending.mealType} →</ThemedText>
            </TouchableOpacity>

          </ScrollView>
        )}

      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: Spacing.three,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: Spacing.three,
  },
  title: { fontFamily: Fonts.serif, fontSize: 28, fontStyle: 'italic', fontWeight: '400', paddingTop: 4, paddingRight: 4 },
  subtitle: { fontSize: 14, fontStyle: 'italic', marginTop: 2 },
  doneBtn: { fontSize: 16, fontWeight: '400', paddingTop: 6 },
  backBtn: { paddingVertical: 6 },
  backBtnText: { fontSize: 16 },
  scroll: { gap: Spacing.three, paddingBottom: Spacing.six },

  // Date picker
  datePicker: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    marginTop: 4,
  },
  dateArrow: {
    fontSize: 22,
    lineHeight: 26,
  },
  dateLabel: {
    fontSize: 13,
  },

  // Meal card
  mealCard: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 2,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  mealHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  mealActions: {
    alignItems: 'flex-end',
    gap: 4,
  },
  mealName: { fontFamily: Fonts.serif, fontSize: 18, fontStyle: 'italic', fontWeight: '400', paddingRight: 4 }, // italic overhang
  mealTime: { fontSize: 12, marginTop: 2 },
  mealItems: { fontSize: 14, fontStyle: 'italic' },
  mealPhoto: { width: '100%', height: 160, borderRadius: 4 },
  macroRow: { flexDirection: 'row', gap: Spacing.two },
  macroPill: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 10, paddingVertical: 4,
    borderWidth: StyleSheet.hairlineWidth, borderRadius: 2, gap: 4,
  },
  macroPillLabel: { fontSize: 11 },
  macroPillValue: { fontSize: 12 },
  editLink: { fontSize: 14 },
  deleteBtn: { marginTop: 2 },
  deleteLink: { fontSize: 12 },

  // Add buttons row
  addButtonsRow: {
    flexDirection: 'row',
    gap: Spacing.two,
    marginTop: 4,
  },
  addBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 2,
  },
  addBtnText: { fontSize: 13 },

  // Entry divider between multiple items in the same section
  entryDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: Spacing.two,
    marginTop: Spacing.two,
  },

  // Add-more row shown at the bottom of a populated section
  addMoreRow: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: Spacing.two,
    marginTop: Spacing.two,
  },

  // Standalone "+ Add snack" button below the Snack section
  addSnackBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 11,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 2,
    marginTop: -Spacing.one,  // tuck it close to the snack card
  },

  // Text entry view
  textEntryContainer: {
    flex: 1,
    paddingTop: Spacing.three,
    gap: Spacing.three,
  },
  textEntryLabel: { fontFamily: Fonts.serif, fontSize: 18, fontStyle: 'italic', fontWeight: '400' },
  textEntryInput: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 2,
    padding: Spacing.three,
    fontSize: 15,
    lineHeight: 24,
    minHeight: 120,
    textAlignVertical: 'top',
  },

  // Analyzing
  centeredContent: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: Spacing.three, gap: Spacing.two,
  },
  analyzingTitle: { fontFamily: Fonts.serif, fontSize: 18, fontStyle: 'italic', fontWeight: '400', marginTop: Spacing.three },
  analyzingSubText: { fontSize: 13, textAlign: 'center' },

  // Confirm
  confirmPhoto: { width: '100%', height: 200, borderRadius: 4 },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 2,
    padding: Spacing.three, gap: Spacing.two,
  },
  cardLabelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardLabel: { fontSize: 9, letterSpacing: 2.5, textTransform: 'uppercase' },
  cardHint: { fontSize: 11, fontStyle: 'italic' },
  itemsInput: { fontSize: 15, lineHeight: 24, minHeight: 80, textAlignVertical: 'top' },
  recalcBtn: {
    alignSelf: 'flex-start', paddingVertical: 6, paddingHorizontal: 14,
    borderWidth: StyleSheet.hairlineWidth, borderRadius: 2,
  },
  recalcBtnText: { fontSize: 13 },
  bigCalories: {
    fontFamily: Fonts.serif, fontSize: 32, fontStyle: 'italic', fontWeight: '400',
    // lineHeight prevents serif italic ascenders from being clipped at the top.
    // paddingLeft guards the leftward lean of italic characters.
    lineHeight: 46, paddingTop: 10, paddingLeft: 4, paddingRight: 4,
  },
  actionBtn: {
    borderWidth: StyleSheet.hairlineWidth, borderRadius: 2,
    paddingVertical: 16, alignItems: 'center',
  },
  actionBtnText: { fontSize: 15 },
});
