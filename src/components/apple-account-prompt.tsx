/**
 * AppleAccountPrompt
 *
 * Shown to existing users (onboarding_complete = 'true') who have not yet
 * linked their Apple account. Appears on every launch until they sign in.
 *
 * There is no permanent "Not Now" — dismissing defers to next launch only.
 * This matches the task requirement: "no permanent 'Not Now' bypass."
 *
 * Caller owns visibility state; this component is stateless beyond loading.
 */

import * as AppleAuthentication from 'expo-apple-authentication';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  StyleSheet,
  TouchableOpacity,
  View,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { BHRadius, Fonts, Spacing } from '@/constants/theme';
import { useAppTheme } from '@/context/theme-context';
import { getModalPalette } from '@/utils/modal-palette';
import { signInWithApple } from '@/services/apple-auth';
import { retrySyncIfPending } from '@/services/cloud-sync';
import { trackEvent } from '@/services/analytics';

type Props = {
  visible: boolean;
  /** Called after successful Apple sign-in or "Not Now" */
  onDismiss: (linked: boolean) => void;
};

export function AppleAccountPrompt({ visible, onDismiss }: Props) {
  const { isDark, userTheme } = useAppTheme();
  const pal = getModalPalette(isDark, userTheme);

  const [loading,   setLoading]   = useState(false);
  const [available, setAvailable] = useState(true);

  useEffect(() => {
    if (!visible) return;
    AppleAuthentication.isAvailableAsync()
      .then(setAvailable)
      .catch(() => setAvailable(false));
  }, [visible]);

  async function handleSignIn() {
    setLoading(true);
    try {
      const result = await signInWithApple();
      if (result.ok) {
        trackEvent('apple_linked', { source_screen: 'account_prompt' });
        // Fire-and-forget: retry any data that failed to reach the cloud before
        // linking. Never blocks sign-in success or dismissal.
        retrySyncIfPending().catch(() => {});
        onDismiss(true);
        return;
      }
      if (result.error === 'cancelled') {
        // Silent — user deliberately cancelled; stay on prompt
      } else {
        // Non-cancel failure: log type/code only — never log token, nonce, or credential data
        console.warn('[apple-account-prompt] sign-in failed:', result.error);
      }
    } catch (err) {
      console.warn('[apple-account-prompt] unexpected error during sign-in:', err instanceof Error ? err.message : String(err));
    }
    setLoading(false);
  }

  function handleNotNow() {
    onDismiss(false);
  }

  return (
    <Modal visible={visible} animationType="slide" transparent statusBarTranslucent>
      <View style={styles.overlay}>
        <View style={[styles.sheet, { backgroundColor: pal.background }]}>

          <View style={[styles.handle, { backgroundColor: pal.divider }]} />

          <ThemedText style={[styles.overline, { color: pal.textSecondary }]}>
            YOUR ACCOUNT
          </ThemedText>

          <ThemedText style={[styles.heading, { color: pal.text }]}>
            Back up your data.
          </ThemedText>

          <ThemedText style={[styles.body, { color: pal.textSecondary }]}>
            Sign in with Apple to save your profile, goals, and history — so it's there if you ever switch phones.
          </ThemedText>

          {available ? (
            <TouchableOpacity
              style={[styles.primaryBtn, { backgroundColor: pal.accent }]}
              onPress={handleSignIn}
              activeOpacity={0.85}
              disabled={loading}
            >
              {loading
                ? <ActivityIndicator color="#fff" />
                : <ThemedText style={styles.primaryBtnText}>Sign in with Apple</ThemedText>
              }
            </TouchableOpacity>
          ) : (
            <View style={[styles.primaryBtn, { backgroundColor: pal.divider }]}>
              <ThemedText style={[styles.primaryBtnText, { color: pal.textSecondary }]}>
                Sign in with Apple (not available)
              </ThemedText>
            </View>
          )}

          <TouchableOpacity style={styles.notNowBtn} onPress={handleNotNow} activeOpacity={0.6}>
            <ThemedText style={[styles.notNowText, { color: pal.textSecondary }]}>Not now</ThemedText>
          </TouchableOpacity>

        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.six,
    paddingTop: Spacing.two,
    gap: Spacing.two,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    marginBottom: Spacing.two,
  },
  overline: {
    fontSize: 9,
    letterSpacing: 2.5,
    textTransform: 'uppercase',
  },
  heading: {
    fontFamily: Fonts.serif,
    fontStyle: 'italic',
    fontSize: 26,
    fontWeight: '400',
    lineHeight: 33,
  },
  body: {
    fontSize: 15,
    lineHeight: 22,
    marginBottom: Spacing.one,
  },
  primaryBtn: {
    borderRadius: BHRadius.btn,
    paddingVertical: 14,
    alignItems: 'center',
  },
  primaryBtnText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#fff',
    letterSpacing: 0.3,
  },
  notNowBtn: {
    alignItems: 'center',
    paddingVertical: Spacing.two,
  },
  notNowText: {
    fontSize: 13,
    letterSpacing: 0.2,
  },
});
