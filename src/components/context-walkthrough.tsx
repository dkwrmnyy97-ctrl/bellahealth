/**
 * ContextTour (exported as ContextWalkthrough for naming compatibility)
 *
 * 4-beat guided tour of the Context screen — shown the first time a user
 * intentionally opens Context (either via "Explore Context" CTA or organic
 * navigation). Lives in context.tsx, not index.tsx.
 *
 * Each beat explains a specific section of the actual Context screen.
 * This is a tour, not marketing copy.
 *
 * Keys are versioned and independent from the What's New announcement.
 * No AsyncStorage inside — caller owns persistence.
 */

import React, { useEffect, useState } from 'react';
import { Modal, StyleSheet, TouchableOpacity, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { BHRadius, Fonts, Spacing } from '@/constants/theme';
import { useAppTheme } from '@/context/theme-context';
import { getModalPalette } from '@/utils/modal-palette';

/** Versioned key for the Context feature tour. Independent from WHATS_NEW_KEY. */
export const CONTEXT_TOUR_KEY = 'context_tour_v1';

/**
 * @deprecated Use CONTEXT_TOUR_KEY. Kept for any imports that haven't migrated yet.
 */
export const WALKTHROUGH_KEY = CONTEXT_TOUR_KEY;

const BEATS = [
  {
    label:   'YOUR STORY',
    heading: 'What your data currently suggests.',
    body:    "A plain-English summary built from the patterns BellaHealth has observed across your history. It updates as your data builds up.",
  },
  {
    label:   "WHAT'S CONNECTED",
    heading: 'Relationships between your signals.',
    body:    "When BellaHealth notices that two signals tend to move together — like sleep affecting next-day readiness — it shows up here. These are associations, not causes.",
  },
  {
    label:   'LIFE + HEALTH',
    heading: 'Add what your wearable can\'t know.',
    body:    "Tap + to log travel, illness, stress, or training changes. BellaHealth compares your health data before, during, and after so those changes have meaning.",
  },
  {
    label:   'YOUR PICTURE',
    heading: 'What BellaHealth can reason about today.',
    body:    "Shows which health domains have enough history for Context to work with, and where more data would make the picture richer.",
  },
];

type Props = {
  visible:   boolean;
  /** Called on the final beat's CTA — caller handles persistence */
  onDone:    () => void;
  /** Called when user taps Skip — caller handles persistence */
  onSkip:    () => void;
};

export function ContextWalkthrough({ visible, onDone, onSkip }: Props) {
  const [beat, setBeat] = useState(0);
  const { isDark, userTheme } = useAppTheme();
  const pal = getModalPalette(isDark, userTheme);

  useEffect(() => {
    if (visible) setBeat(0);
  }, [visible]);

  const isLast = beat === BEATS.length - 1;

  return (
    <Modal visible={visible} animationType="fade" transparent statusBarTranslucent>
      <View style={styles.overlay}>
        <View style={[styles.card, { backgroundColor: pal.background }]}>

          <TouchableOpacity onPress={onSkip} style={styles.skip} activeOpacity={0.7}>
            <ThemedText style={[styles.skipText, { color: pal.textSecondary }]}>Skip</ThemedText>
          </TouchableOpacity>

          <View style={styles.dots}>
            {BEATS.map((_, i) => (
              <View key={i} style={[styles.dot, { backgroundColor: i === beat ? pal.accent : pal.divider }]} />
            ))}
          </View>

          <ThemedText style={[styles.beatLabel, { color: pal.accent }]}>
            {BEATS[beat].label}
          </ThemedText>
          <ThemedText style={[styles.heading, { color: pal.text }]}>
            {BEATS[beat].heading}
          </ThemedText>
          <ThemedText style={[styles.body, { color: pal.textSecondary }]}>
            {BEATS[beat].body}
          </ThemedText>

          <TouchableOpacity
            onPress={isLast ? onDone : () => setBeat((b) => b + 1)}
            style={[styles.cta, { backgroundColor: pal.accent }]}
            activeOpacity={0.8}
          >
            <ThemedText style={styles.ctaText}>{isLast ? 'Got it' : 'Next'}</ThemedText>
          </TouchableOpacity>

        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.65)',
    alignItems: 'center', justifyContent: 'center', padding: Spacing.three,
  },
  card: {
    width: '100%', borderRadius: 20, padding: Spacing.four, gap: Spacing.two,
  },
  skip:      { alignSelf: 'flex-end' },
  skipText:  { fontSize: 14 },
  dots:      { flexDirection: 'row', gap: Spacing.one, justifyContent: 'center', marginBottom: Spacing.one },
  dot:       { width: 6, height: 6, borderRadius: 3 },
  beatLabel: { fontSize: 9, letterSpacing: 2.5, textTransform: 'uppercase', textAlign: 'center' },
  heading:   { fontFamily: Fonts.serif, fontStyle: 'italic', fontSize: 22, lineHeight: 28, fontWeight: '400', textAlign: 'center' },
  body:      { fontSize: 14, lineHeight: 21, textAlign: 'center' },
  cta:       { borderRadius: BHRadius.btn, paddingVertical: 13, alignItems: 'center', marginTop: Spacing.one },
  ctaText:   { fontSize: 15, fontWeight: '500', color: '#fff' },
});
