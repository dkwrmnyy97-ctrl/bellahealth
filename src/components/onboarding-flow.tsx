/**
 * OnboardingFlow
 *
 * Full-screen welcome experience shown once to brand-new users.
 * Steps: Welcome → Apple Health → Companion Apps → Oura
 *
 * After completion, writes:
 *   - AsyncStorage 'onboarding_complete' = 'true'
 *   - AsyncStorage 'user_profile' stub with { companionApps }
 *
 * Existing users (who have a user_profile) never see this.
 * The companion-app prompt for existing users (CompanionPrompt) is unaffected.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Modal,
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
import { initHealthKit } from '@/services/healthkit';
import { initiateOuraConnect } from '@/services/oura';
import { trackEvent } from '@/services/analytics';
import { signInWithApple } from '@/services/apple-auth';

type Step = 'welcome' | 'healthkit' | 'companions' | 'oura' | 'account';

type Props = {
  visible: boolean;
  onComplete: (companionApps: CompanionApp[]) => void;
  onExplore?: () => void;
};

/**
 * Apple Health pre-permission step (App Review Guideline 5.1.1(iv)).
 *
 * Continue goes straight to Apple's native authorization sheet; the screen
 * offers no way to skip or delay it. Onboarding always moves on afterwards,
 * whatever the user chose in the sheet — iOS does not reveal read denials,
 * and an unavailable or failed request must not block onboarding.
 */
export async function requestHealthAccessThenContinue(
  requestAccess: () => Promise<void>,
  advance: () => void,
): Promise<void> {
  try { await requestAccess(); } catch {}
  advance();
}

export function OnboardingFlow({ visible, onComplete, onExplore }: Props) {
  const { isDark, userTheme } = useAppTheme();
  const pal = getModalPalette(isDark, userTheme);
  const insets = useSafeAreaInsets();

  const [step, setStep]               = useState<Step>('welcome');
  const [selected, setSelected]       = useState<Set<CompanionApp>>(new Set());
  const [hkLoading, setHkLoading]     = useState(false);
  const [ouraLoading, setOuraLoading] = useState(false);
  const [ouraConnected, setOuraConnected] = useState(false);
  const [appleLoading, setAppleLoading]   = useState(false);

  const opacity      = useRef(new Animated.Value(1)).current;
  const startedRef   = useRef(false);

  // Fire onboarding_started once when the flow first becomes visible.
  React.useEffect(() => {
    if (visible && !startedRef.current) {
      startedRef.current = true;
      trackEvent('onboarding_started');
    }
  }, [visible]);

  function fadeToStep(next: Step) {
    Animated.timing(opacity, { toValue: 0, duration: 150, useNativeDriver: true }).start(() => {
      setStep(next);
      Animated.timing(opacity, { toValue: 1, duration: 220, useNativeDriver: true }).start();
    });
  }

  async function handleHealthKit() {
    setHkLoading(true);
    await requestHealthAccessThenContinue(initHealthKit, () => {
      setHkLoading(false);
      fadeToStep('companions');
    });
  }

  function toggleApp(app: CompanionApp) {
    Haptics.selectionAsync().catch(() => {});
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(app)) next.delete(app); else next.add(app);
      return next;
    });
  }

  async function handleOuraConnect() {
    setOuraLoading(true);
    try {
      const ok = await initiateOuraConnect();
      setOuraConnected(ok);
    } catch {}
    setOuraLoading(false);
  }

  async function handleAppleSignIn() {
    setAppleLoading(true);
    try {
      const result = await signInWithApple();
      if (result.ok) {
        trackEvent('apple_linked', { source_screen: 'onboarding' });
        handleEnter();
        return;
      }
      if (result.error === 'unavailable') {
        // Not an Apple device — cannot sign in; proceed without account.
        handleEnter();
        return;
      }
      // 'cancelled' or other error — stay on step so user can retry.
    } catch {}
    setAppleLoading(false);
  }

  function handleEnter() {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    const apps = Array.from(selected);
    // Persist companion apps and mark onboarding done before calling onComplete
    AsyncStorage.getItem('user_profile').then((raw) => {
      const existing = raw ? JSON.parse(raw) : {};
      AsyncStorage.setItem('user_profile', JSON.stringify({ ...existing, companionApps: apps })).catch(() => {});
    }).catch(() => {});
    AsyncStorage.setItem('onboarding_complete', 'true').catch(() => {});
    onComplete(apps);
  }

  // ── Step renders ────────────────────────────────────────────────────────────

  function renderContent() {
    switch (step) {

      case 'welcome':
        return (
          <>
            <View style={styles.mid}>
              <ThemedText style={[styles.overline, { color: pal.textSecondary }]}>BELLAHEALTH</ThemedText>
              <ThemedText style={[styles.headline, { color: pal.text }]}>
                Your health, finally clear.
              </ThemedText>
              <ThemedText style={[styles.body, { color: pal.textSecondary }]}>
                Sleep, movement, nutrition, and recovery — brought together and explained in a way that actually makes sense.
              </ThemedText>
            </View>
            <View style={styles.bottom}>
              <TouchableOpacity
                style={[styles.primaryBtn, { backgroundColor: pal.accent }]}
                onPress={() => fadeToStep('healthkit')}
                activeOpacity={0.85}
              >
                <ThemedText style={styles.primaryBtnText}>Get Started</ThemedText>
              </TouchableOpacity>
              {onExplore && (
                <TouchableOpacity
                  style={styles.skipRow}
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
                    onExplore();
                  }}
                  activeOpacity={0.6}
                >
                  <ThemedText style={[styles.skipLabel, { color: pal.textSecondary }]}>
                    Explore BellaHealth first
                  </ThemedText>
                </TouchableOpacity>
              )}
            </View>
          </>
        );

      case 'healthkit':
        return (
          <>
            <View style={styles.mid}>
              <ThemedText style={[styles.overline, { color: pal.textSecondary }]}>APPLE HEALTH</ThemedText>
              <ThemedText style={[styles.headline, { color: pal.text }]}>
                Apple Health data.
              </ThemedText>
              <ThemedText style={[styles.body, { color: pal.textSecondary }]}>
                BellaHealth reads sleep, steps, workouts, heart rate variability, and resting heart rate from Apple Health to show them in the app. On the next screen, Apple asks which data to share. You can change this later in the Health app.
              </ThemedText>
            </View>
            <View style={styles.bottom}>
              <TouchableOpacity
                style={[styles.primaryBtn, { backgroundColor: pal.accent }]}
                onPress={handleHealthKit}
                activeOpacity={0.85}
                disabled={hkLoading}
              >
                {hkLoading
                  ? <ActivityIndicator color="#fff" />
                  : <ThemedText style={styles.primaryBtnText}>Continue</ThemedText>
                }
              </TouchableOpacity>
            </View>
          </>
        );

      case 'companions':
        return (
          <>
            <View style={styles.mid}>
              <ThemedText style={[styles.overline, { color: pal.textSecondary }]}>YOUR APPS</ThemedText>
              <ThemedText style={[styles.headline, { color: pal.text }]}>
                Which apps do you use?
              </ThemedText>
              <ThemedText style={[styles.body, { color: pal.textSecondary }]}>
                We'll add quick links in relevant metric views so you can navigate to your other health apps directly. We don't connect to them.
              </ThemedText>
              <View style={[styles.appList, { borderTopColor: pal.divider, borderBottomColor: pal.divider }]}>
                {(['strava', 'whoop', 'garmin'] as CompanionApp[]).map((app, i) => {
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
            </View>
            <View style={styles.bottom}>
              <TouchableOpacity
                style={[styles.primaryBtn, { backgroundColor: pal.accent }]}
                onPress={() => fadeToStep('oura')}
                activeOpacity={0.85}
              >
                <ThemedText style={styles.primaryBtnText}>Continue</ThemedText>
              </TouchableOpacity>
              <TouchableOpacity style={styles.skipRow} onPress={() => fadeToStep('oura')} activeOpacity={0.6}>
                <ThemedText style={[styles.skipLabel, { color: pal.textSecondary }]}>None / Not now</ThemedText>
              </TouchableOpacity>
            </View>
          </>
        );

      case 'account':
        return (
          <>
            <View style={styles.mid}>
              <ThemedText style={[styles.overline, { color: pal.textSecondary }]}>YOUR ACCOUNT</ThemedText>
              <ThemedText style={[styles.headline, { color: pal.text }]}>
                Back up your data.
              </ThemedText>
              <ThemedText style={[styles.body, { color: pal.textSecondary }]}>
                Sign in with Apple to save your profile, goals, and history to your account — so it's there if you ever switch phones.
              </ThemedText>
            </View>
            <View style={styles.bottom}>
              <TouchableOpacity
                style={[styles.primaryBtn, { backgroundColor: pal.accent }]}
                onPress={handleAppleSignIn}
                activeOpacity={0.85}
                disabled={appleLoading}
              >
                {appleLoading
                  ? <ActivityIndicator color="#fff" />
                  : <ThemedText style={styles.primaryBtnText}>Sign in with Apple</ThemedText>
                }
              </TouchableOpacity>
            </View>
          </>
        );

      case 'oura':
        return (
          <>
            <View style={styles.mid}>
              <ThemedText style={[styles.overline, { color: pal.textSecondary }]}>
                OURA RING — OPTIONAL
              </ThemedText>
              <ThemedText style={[styles.headline, { color: pal.text }]}>
                {ouraConnected ? 'Oura connected.' : 'Connect your Oura Ring.'}
              </ThemedText>
              <ThemedText style={[styles.body, { color: pal.textSecondary }]}>
                {ouraConnected
                  ? 'Sleep scores, HRV, and readiness data will appear on your dashboard.'
                  : 'Get sleep scores, HRV, and readiness from your ring — BellaHealth\'s richest data source. You can always connect it later in Profile.'
                }
              </ThemedText>
            </View>
            <View style={styles.bottom}>
              {!ouraConnected && (
                <TouchableOpacity
                  style={[styles.primaryBtn, { backgroundColor: pal.accent }]}
                  onPress={handleOuraConnect}
                  activeOpacity={0.85}
                  disabled={ouraLoading}
                >
                  {ouraLoading
                    ? <ActivityIndicator color="#fff" />
                    : <ThemedText style={styles.primaryBtnText}>Connect Oura</ThemedText>
                  }
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={[styles.enterBtn, { borderColor: pal.accent }]}
                onPress={() => fadeToStep('account')}
                activeOpacity={0.85}
              >
                <ThemedText style={[styles.enterBtnText, { color: pal.accent }]}>
                  Continue →
                </ThemedText>
              </TouchableOpacity>
              {!ouraConnected && (
                <TouchableOpacity style={styles.skipRow} onPress={() => fadeToStep('account')} activeOpacity={0.6}>
                  <ThemedText style={[styles.skipLabel, { color: pal.textSecondary }]}>
                    I don't have one — skip
                  </ThemedText>
                </TouchableOpacity>
              )}
            </View>
          </>
        );
    }
  }

  return (
    <Modal visible={visible} animationType="none" presentationStyle="fullScreen">
      <View style={[styles.container, { backgroundColor: pal.background }]}>
        <View style={[
          styles.inner,
          {
            paddingTop: insets.top + Spacing.four,
            paddingBottom: Math.max(insets.bottom, Spacing.four),
          },
        ]}>
          <Animated.View style={[styles.animated, { opacity }]}>
            {renderContent()}
          </Animated.View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  inner: {
    flex: 1,
    paddingHorizontal: Spacing.three,
  },
  animated: {
    flex: 1,
    flexDirection: 'column',
  },

  mid: {
    flex: 1,
    justifyContent: 'center',
    paddingBottom: Spacing.four,
  },
  bottom: {
    gap: Spacing.two,
    paddingBottom: Spacing.two,
  },

  overline: {
    fontSize: 9,
    letterSpacing: 2.5,
    textTransform: 'uppercase',
    marginBottom: Spacing.three,
  },
  headline: {
    fontFamily: Fonts.serif,
    fontSize: 32,
    fontStyle: 'italic',
    fontWeight: '400',
    lineHeight: 40,
    paddingTop: 6,
    paddingRight: 4,
    marginBottom: Spacing.three,
  },
  body: {
    fontSize: 15,
    lineHeight: 23,
  },

  // Companion app list
  appList: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    marginTop: Spacing.three,
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

  // Buttons
  primaryBtn: {
    borderRadius: 6,
    paddingVertical: 14,
    alignItems: 'center',
  },
  primaryBtnText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#fff',
    letterSpacing: 0.3,
  },
  enterBtn: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    paddingVertical: 14,
    alignItems: 'center',
  },
  enterBtnText: {
    fontSize: 15,
    fontWeight: '500',
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
