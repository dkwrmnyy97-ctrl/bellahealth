import React from 'react';
import {
  Modal,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  View,
} from 'react-native';
import { SymbolView } from 'expo-symbols';

import { ThemedText } from '@/components/themed-text';
import { Fonts, Spacing } from '@/constants/theme';
import { useAppTheme } from '@/context/theme-context';
import { getModalPalette } from '@/utils/modal-palette';

// ─── Content ──────────────────────────────────────────────────────────────────

type MembershipArea = {
  id: string;
  overline: string;
  headline: string;
  body: string;
};

const MEMBERSHIP_AREAS: MembershipArea[] = [
  {
    id: 'learn',
    overline: 'LEARN',
    headline: 'Understand your health, not just your numbers.',
    body: 'Thoughtful education across nutrition, sleep, hydration, training, recovery, hormones, and more.',
  },
  {
    id: 'deeper',
    overline: 'GO DEEPER',
    headline: 'More personalization when you want it.',
    body: 'Enhanced nutrition logging, deeper insights, and more ways to understand how your habits connect.',
  },
  {
    id: 'club',
    overline: 'THE CLUB',
    headline: 'See how others live well.',
    body: 'Discover anonymous community trends and inspiration across hydration, nutrition, movement, training, and everyday habits.',
  },
];

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * PaywallContent — the inner view without a <Modal> wrapper.
 * Rendered directly inside the menu's existing pageSheet to avoid
 * iOS's restriction on presenting a second sheet from within a sheet.
 */
export function PaywallContent({ onClose }: { onClose: () => void }) {
  const { isDark, userTheme } = useAppTheme();
  const pal = getModalPalette(isDark, userTheme);

  return (
    <View style={[styles.container, { backgroundColor: pal.background, paddingTop: Spacing.three }]}>

      <View style={[styles.header, { borderBottomColor: pal.divider }]}>
        <ThemedText style={[styles.title, { color: pal.text }]}>BellaHealth+</ThemedText>
        <TouchableOpacity onPress={onClose} activeOpacity={0.7}>
          <SymbolView name="xmark" size={16} tintColor={pal.textSecondary} weight="light" type="monochrome" />
        </TouchableOpacity>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scroll}
      >

        {/* ── Hero ── */}
        <View style={styles.heroBlock}>
          <ThemedText style={[styles.heroHeadline, { color: pal.text }]}>
            Go deeper with your health.
          </ThemedText>
          <ThemedText style={[styles.heroSub, { color: pal.textSecondary }]}>
            An annual membership for more insight, education, and inspiration.
          </ThemedText>
        </View>

        <View style={[styles.rule, { backgroundColor: pal.divider }]} />

        {/* ── Three areas ── */}
        <View style={styles.areasBlock}>
          {MEMBERSHIP_AREAS.map((area, i) => (
            <View key={area.id}>
              {i > 0 && <View style={[styles.areaRule, { backgroundColor: pal.divider }]} />}
              <View style={styles.areaRow}>
                <ThemedText style={[styles.areaOverline, { color: pal.textSecondary }]}>
                  {area.overline}
                </ThemedText>
                <ThemedText style={[styles.areaHeadline, { color: pal.text }]}>
                  {area.headline}
                </ThemedText>
                <ThemedText style={[styles.areaBody, { color: pal.textSecondary }]}>
                  {area.body}
                </ThemedText>
              </View>
            </View>
          ))}
        </View>

        <View style={[styles.rule, { backgroundColor: pal.divider }]} />

        {/* ── Coming Soon ── */}
        <View style={styles.comingSoonBlock}>
          <ThemedText style={[styles.comingSoonLabel, { color: pal.textSecondary }]}>
            COMING SOON
          </ThemedText>
          <ThemedText style={[styles.comingSoonCopy, { color: pal.textSecondary }]}>
            BellaHealth+ is being built as an annual membership.
          </ThemedText>
        </View>

      </ScrollView>
    </View>
  );
}

/** Standalone modal wrapper — kept for any future direct use. */
export function PaywallModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <PaywallContent onClose={onClose} />
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },

  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.three,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: {
    fontFamily: Fonts.serif,
    fontSize: 26,
    fontStyle: 'italic',
    fontWeight: '400',
    paddingTop: 3,
    paddingRight: 4,
  },

  scroll: {
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.four,
    paddingBottom: Spacing.six,
    gap: Spacing.four,
  },

  heroBlock: {
    gap: Spacing.two,
  },
  heroHeadline: {
    fontFamily: Fonts.serif,
    fontSize: 28,
    fontStyle: 'italic',
    fontWeight: '400',
    lineHeight: 36,
  },
  heroSub: {
    fontSize: 16,
    lineHeight: 24,
  },

  rule: {
    height: StyleSheet.hairlineWidth,
  },

  areasBlock: {
    gap: 0,
  },
  areaRule: {
    height: StyleSheet.hairlineWidth,
    marginVertical: Spacing.four,
  },
  areaRow: {
    gap: Spacing.one,
  },
  areaOverline: {
    fontSize: 9,
    letterSpacing: 2.5,
    textTransform: 'uppercase',
    marginBottom: Spacing.one,
  },
  areaHeadline: {
    fontFamily: Fonts.serif,
    fontSize: 19,
    fontStyle: 'italic',
    fontWeight: '400',
    lineHeight: 26,
  },
  areaBody: {
    fontSize: 15,
    lineHeight: 23,
    marginTop: 4,
  },

  comingSoonBlock: {
    gap: Spacing.two,
    paddingTop: Spacing.one,
  },
  comingSoonLabel: {
    fontSize: 9,
    letterSpacing: 2.5,
    textTransform: 'uppercase',
  },
  comingSoonCopy: {
    fontFamily: Fonts.serif,
    fontSize: 15,
    fontStyle: 'italic',
    lineHeight: 22,
  },
});
