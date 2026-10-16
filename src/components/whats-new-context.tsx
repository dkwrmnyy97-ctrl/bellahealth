/**
 * WhatsNewContext
 *
 * One-screen "What's New" announcement shown to existing users
 * upgrading to the release that introduces Context.
 *
 * This is NOT the Context feature tour. It introduces the feature
 * at the app level and offers to navigate the user there.
 *
 * Persistence key is versioned and independent from the Context tour key.
 */

import React from 'react';
import { Modal, StyleSheet, TouchableOpacity, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { BHRadius, Fonts, Spacing } from '@/constants/theme';
import { useAppTheme } from '@/context/theme-context';
import { getModalPalette } from '@/utils/modal-palette';

/** Versioned key — independent from CONTEXT_TOUR_KEY. */
export const WHATS_NEW_KEY = 'whats_new_context_v1';

type Props = {
  visible:   boolean;
  /** User taps "Explore Context" → caller navigates + marks seen */
  onExplore: () => void;
  /** User taps "Not now" → caller marks seen */
  onDismiss: () => void;
};

export function WhatsNewContext({ visible, onExplore, onDismiss }: Props) {
  const { isDark, userTheme } = useAppTheme();
  const pal = getModalPalette(isDark, userTheme);

  return (
    <Modal visible={visible} animationType="fade" transparent statusBarTranslucent>
      <View style={styles.overlay}>
        <View style={[styles.card, { backgroundColor: pal.background }]}>

          <ThemedText style={[styles.overline, { color: pal.accent }]}>
            WHAT'S NEW
          </ThemedText>

          <ThemedText style={[styles.headline, { color: pal.text }]}>
            Introducing Context
          </ThemedText>

          <ThemedText style={[styles.body, { color: pal.textSecondary }]}>
            Context connects your health signals with each other — and with what's actually happening in your life.
          </ThemedText>

          <View style={[styles.featureList, { borderTopColor: pal.divider }]}>
            {[
              { label: "What's connected",  desc: 'Patterns between sleep, recovery, and movement.' },
              { label: 'Life + Health',      desc: 'Add travel, illness, or stress so BellaHealth has the full picture.' },
              { label: 'Your Story',         desc: 'A plain-English synthesis of what your data currently suggests.' },
            ].map((f) => (
              <View key={f.label} style={[styles.featureRow, { borderBottomColor: pal.divider }]}>
                <ThemedText style={[styles.featureLabel, { color: pal.text }]}>{f.label}</ThemedText>
                <ThemedText style={[styles.featureDesc,  { color: pal.textSecondary }]}>{f.desc}</ThemedText>
              </View>
            ))}
          </View>

          <TouchableOpacity
            onPress={onExplore}
            style={[styles.primaryBtn, { backgroundColor: pal.accent }]}
            activeOpacity={0.85}
          >
            <ThemedText style={styles.primaryBtnText}>Explore Context</ThemedText>
          </TouchableOpacity>

          <TouchableOpacity onPress={onDismiss} activeOpacity={0.6} style={styles.secondaryBtn}>
            <ThemedText style={[styles.secondaryBtnText, { color: pal.textSecondary }]}>Not now</ThemedText>
          </TouchableOpacity>

        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.72)',
    alignItems: 'center', justifyContent: 'center', padding: Spacing.three,
  },
  card: {
    width: '100%', borderRadius: 24, padding: Spacing.four, gap: Spacing.two,
  },
  overline: {
    fontSize: 9, letterSpacing: 2.5, textTransform: 'uppercase',
  },
  headline: {
    fontFamily: Fonts.serif, fontStyle: 'italic', fontSize: 28,
    fontWeight: '400', lineHeight: 36, marginTop: 2,
  },
  body: {
    fontSize: 15, lineHeight: 22, marginBottom: Spacing.one,
  },
  featureList: {
    borderTopWidth: StyleSheet.hairlineWidth, marginTop: Spacing.one,
  },
  featureRow: {
    paddingVertical: Spacing.two, borderBottomWidth: StyleSheet.hairlineWidth, gap: 2,
  },
  featureLabel: { fontSize: 14, fontWeight: '500' },
  featureDesc:  { fontSize: 13, lineHeight: 18 },
  primaryBtn: {
    marginTop: Spacing.two, borderRadius: BHRadius.btn,
    paddingVertical: 14, alignItems: 'center',
  },
  primaryBtnText: { fontSize: 15, fontWeight: '600', color: '#fff', letterSpacing: 0.2 },
  secondaryBtn:   { alignItems: 'center', paddingVertical: Spacing.two },
  secondaryBtnText: { fontSize: 14 },
});
