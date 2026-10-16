/**
 * MetricSourceSheet
 *
 * A compact BellaHealth-style bottom sheet for presenting health metric
 * source destinations (e.g. "Open in Oura", "Open in Apple Health").
 *
 * Usage:
 *   const [sheet, setSheet] = useState<{ title: string; sources: SourceItem[] } | null>(null);
 *   <MetricSourceSheet visible={!!sheet} title={sheet?.title ?? ''} sources={sheet?.sources ?? []} onDismiss={() => setSheet(null)} />
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Modal,
  Pressable,
  StyleSheet,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { Fonts, Spacing } from '@/constants/theme';
import { useAppTheme } from '@/context/theme-context';
import { getModalPalette } from '@/utils/modal-palette';

export type SourceItem = {
  key: string;
  label: string;
  onPress: () => void;
};

type Props = {
  visible: boolean;
  title: string;
  sources: SourceItem[];
  onDismiss: () => void;
};

export function MetricSourceSheet({ visible, title, sources, onDismiss }: Props) {
  const { isDark, userTheme } = useAppTheme();
  const pal = getModalPalette(isDark, userTheme);
  const insets = useSafeAreaInsets();

  // Keep the Modal mounted until the dismiss animation completes
  const [isShown, setIsShown] = useState(false);
  const slideY    = useRef(new Animated.Value(400)).current;
  const bgOpacity = useRef(new Animated.Value(0)).current;

  // Mount when parent makes visible
  useEffect(() => {
    if (visible) setIsShown(true);
  }, [visible]);

  // Animate in after mount
  useEffect(() => {
    if (!isShown) return;
    slideY.setValue(400);
    bgOpacity.setValue(0);
    const t = setTimeout(() => {
      Animated.parallel([
        Animated.spring(slideY,    { toValue: 0, tension: 65, friction: 11, useNativeDriver: true }),
        Animated.timing(bgOpacity, { toValue: 1, duration: 240, useNativeDriver: true }),
      ]).start();
    }, 16); // One frame — ensures Modal is fully mounted before animating
    return () => clearTimeout(t);
  }, [isShown]);

  function animateOut(after?: () => void) {
    Animated.parallel([
      Animated.timing(slideY,    { toValue: 400, duration: 230, useNativeDriver: true }),
      Animated.timing(bgOpacity, { toValue: 0,   duration: 190, useNativeDriver: true }),
    ]).start(() => {
      setIsShown(false);
      onDismiss();
      after?.();
    });
  }

  function handleSource(item: SourceItem) {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    animateOut(item.onPress);
  }

  function handleCancel() {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    animateOut();
  }

  if (!isShown) return null;

  return (
    <Modal
      transparent
      visible={isShown}
      animationType="none"
      onRequestClose={handleCancel}
      statusBarTranslucent
    >
      <View style={styles.outer}>
        {/* Semi-transparent backdrop (non-interactive, pointer-events handled by Pressable) */}
        <Animated.View
          style={[styles.backdrop, { opacity: bgOpacity }]}
          pointerEvents="none"
        />
        {/* Tapping outside the sheet dismisses it */}
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={handleCancel}
          accessibilityLabel="Dismiss"
        />

        {/* Sheet — renders on top of the Pressable (later in JSX = higher z-index) */}
        <Animated.View
          style={[
            styles.sheet,
            {
              backgroundColor: pal.background,
              paddingBottom: Math.max(insets.bottom, Spacing.three),
              transform: [{ translateY: slideY }],
            },
          ]}
        >
          {/* Drag handle */}
          <View style={[styles.handle, { backgroundColor: pal.divider }]} />

          {/* Title */}
          <ThemedText style={[styles.title, { color: pal.textSecondary }]}>
            {title}
          </ThemedText>

          {/* Source rows */}
          <View style={[styles.sourceList, { borderTopColor: pal.divider, borderBottomColor: pal.divider }]}>
            {sources.map((s, i) => (
              <TouchableOpacity
                key={s.key}
                style={[
                  styles.sourceRow,
                  i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: pal.divider },
                ]}
                onPress={() => handleSource(s)}
                activeOpacity={0.6}
                accessibilityRole="button"
                accessibilityLabel={s.label}
              >
                <ThemedText style={[styles.rowLabel, { color: pal.text }]}>
                  {s.label}
                </ThemedText>
                <ThemedText style={[styles.chevron, { color: pal.textSecondary }]}>›</ThemedText>
              </TouchableOpacity>
            ))}
          </View>

          {/* Cancel */}
          <TouchableOpacity
            style={[styles.cancelRow, { borderTopColor: pal.divider }]}
            onPress={handleCancel}
            activeOpacity={0.6}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
          >
            <ThemedText style={[styles.cancelLabel, { color: pal.textSecondary }]}>
              Cancel
            </ThemedText>
          </TouchableOpacity>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  outer: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.42)',
  },
  sheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: Spacing.three,
  },
  title: {
    fontSize: 9,
    letterSpacing: 2.5,
    textTransform: 'uppercase',
    textAlign: 'center',
    marginBottom: Spacing.two,
  },
  sourceList: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sourceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 18,
  },
  rowLabel: {
    fontFamily: Fonts.serif,
    fontSize: 18,
    fontStyle: 'italic',
    fontWeight: '400',
    paddingRight: 4, // italic overhang — prevents last glyph clipping at row edge
  },
  chevron: {
    fontSize: 22,
    lineHeight: 26,
  },
  cancelRow: {
    marginTop: Spacing.two,
    paddingVertical: 14,
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  cancelLabel: {
    fontSize: 11,
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
});
