/**
 * CompanionPrompt
 *
 * One-time bottom sheet shown to existing users on first launch after the
 * companion-app preference feature was introduced.
 *
 * Asks "Which apps do you use?" and persists selections to user_profile.
 * After the user taps Done (or dismisses), this sheet never appears again —
 * the profile now has a companionApps field set, which suppresses the prompt.
 *
 * Usage in index.tsx:
 *   <CompanionPrompt
 *     visible={showCompanionPrompt}
 *     onDone={(apps) => { setCompanionApps(apps); setShowCompanionPrompt(false); }}
 *   />
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
import { COMPANION_LABELS, type CompanionApp } from '@/utils/health-sources';

const ALL_COMPANIONS: CompanionApp[] = ['strava', 'whoop', 'garmin'];

type Props = {
  visible: boolean;
  onDone: (apps: CompanionApp[]) => void;
};

export function CompanionPrompt({ visible, onDone }: Props) {
  const { isDark, userTheme } = useAppTheme();
  const pal = getModalPalette(isDark, userTheme);
  const insets = useSafeAreaInsets();

  const [isShown, setIsShown] = useState(false);
  const [selected, setSelected] = useState<Set<CompanionApp>>(new Set());

  const slideY    = useRef(new Animated.Value(500)).current;
  const bgOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) setIsShown(true);
  }, [visible]);

  useEffect(() => {
    if (!isShown) return;
    slideY.setValue(500);
    bgOpacity.setValue(0);
    const t = setTimeout(() => {
      Animated.parallel([
        Animated.spring(slideY,    { toValue: 0, tension: 65, friction: 11, useNativeDriver: true }),
        Animated.timing(bgOpacity, { toValue: 1, duration: 240, useNativeDriver: true }),
      ]).start();
    }, 16);
    return () => clearTimeout(t);
  }, [isShown]);

  function animateOut(after?: () => void) {
    Animated.parallel([
      Animated.timing(slideY,    { toValue: 500, duration: 230, useNativeDriver: true }),
      Animated.timing(bgOpacity, { toValue: 0,   duration: 190, useNativeDriver: true }),
    ]).start(() => {
      setIsShown(false);
      after?.();
    });
  }

  function handleDone() {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    animateOut(() => onDone(Array.from(selected)));
  }

  function toggleApp(app: CompanionApp) {
    Haptics.selectionAsync().catch(() => {});
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(app)) next.delete(app); else next.add(app);
      return next;
    });
  }

  if (!isShown) return null;

  return (
    <Modal
      transparent
      visible={isShown}
      animationType="none"
      onRequestClose={handleDone}
      statusBarTranslucent
    >
      <View style={styles.outer}>
        <Animated.View style={[styles.backdrop, { opacity: bgOpacity }]} pointerEvents="none" />
        <Pressable style={StyleSheet.absoluteFill} onPress={handleDone} accessibilityLabel="Dismiss" />

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
          <View style={[styles.handle, { backgroundColor: pal.divider }]} />

          <ThemedText style={[styles.overline, { color: pal.textSecondary }]}>
            NEW IN BELLAHEALTH
          </ThemedText>

          <ThemedText style={[styles.title, { color: pal.text }]}>
            Which apps do you use?
          </ThemedText>

          <ThemedText style={[styles.body, { color: pal.textSecondary }]}>
            BellaHealth will show relevant apps in metric views so you can navigate there directly. We don't connect to these apps — this is just for your convenience.
          </ThemedText>

          <View style={[styles.appList, { borderTopColor: pal.divider, borderBottomColor: pal.divider }]}>
            {ALL_COMPANIONS.map((app, i) => {
              const isOn = selected.has(app);
              return (
                <TouchableOpacity
                  key={app}
                  style={[
                    styles.appRow,
                    i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: pal.divider },
                  ]}
                  onPress={() => toggleApp(app)}
                  activeOpacity={0.6}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: isOn }}
                  accessibilityLabel={COMPANION_LABELS[app]}
                >
                  <ThemedText style={[styles.appLabel, { color: pal.text }]}>
                    {COMPANION_LABELS[app]}
                  </ThemedText>
                  <View style={[
                    styles.checkbox,
                    { borderColor: isOn ? pal.accent : pal.divider },
                    isOn && { backgroundColor: pal.accent },
                  ]}>
                    {isOn && <ThemedText style={styles.checkmark}>✓</ThemedText>}
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>

          <TouchableOpacity
            style={[styles.doneBtn, { backgroundColor: pal.accent }]}
            onPress={handleDone}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Done"
          >
            <ThemedText style={styles.doneBtnText}>Done</ThemedText>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.skipRow}
            onPress={handleDone}
            activeOpacity={0.6}
            accessibilityRole="button"
            accessibilityLabel="Skip"
          >
            <ThemedText style={[styles.skipLabel, { color: pal.textSecondary }]}>
              Skip — I'll set this up in Profile
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
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
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
  overline: {
    fontSize: 9,
    letterSpacing: 2.5,
    textTransform: 'uppercase',
    marginBottom: Spacing.one,
  },
  title: {
    fontFamily: Fonts.serif,
    fontSize: 26,
    fontStyle: 'italic',
    fontWeight: '400',
    marginBottom: Spacing.two,
  },
  body: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: Spacing.three,
  },
  appList: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    marginBottom: Spacing.three,
  },
  appRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 16,
  },
  appLabel: {
    fontFamily: Fonts.serif,
    fontSize: 18,
    fontStyle: 'italic',
    fontWeight: '400',
    paddingRight: 4, // italic overhang — prevents last glyph clipping at row edge
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkmark: {
    fontSize: 13,
    color: '#fff',
    fontWeight: '700',
  },
  doneBtn: {
    borderRadius: 6,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: Spacing.two,
  },
  doneBtnText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#fff',
    letterSpacing: 0.3,
  },
  skipRow: {
    alignItems: 'center',
    paddingVertical: Spacing.two,
  },
  skipLabel: {
    fontSize: 12,
    letterSpacing: 0.2,
  },
});
