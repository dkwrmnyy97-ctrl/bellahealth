import React, { useEffect, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { ThemedText } from '@/components/themed-text';
import { Fonts, Spacing } from '@/constants/theme';
import { useAppTheme } from '@/context/theme-context';
import { getModalPalette } from '@/utils/modal-palette';

const SUPPORT_EMAIL = 'bellahealth.support@gmail.com';
const PRIVACY_POLICY_URL = 'https://bellahealth-beta.netlify.app/privacy';

type RequestType = 'bug' | 'feature' | null;

const TYPES: { id: RequestType; label: string; description: string }[] = [
  { id: 'bug',     label: 'Report a Bug',       description: 'Something isn\'t working right' },
  { id: 'feature', label: 'Request a Feature',  description: 'Suggest something new' },
];

export function SupportModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { isDark, userTheme } = useAppTheme();
  const palette = getModalPalette(isDark, userTheme);

  const [type, setType] = useState<RequestType>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [userName, setUserName] = useState('');
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem('user_profile').then((raw) => {
      if (!raw) return;
      try {
        const p = JSON.parse(raw);
        if (p.name) setUserName(p.name);
      } catch {}
    });
  }, []);

  function reset() {
    setType(null);
    setTitle('');
    setDescription('');
    setSubmitted(false);
  }

  async function submit() {
    if (!type || !title.trim() || !description.trim()) {
      Alert.alert('Missing info', 'Please fill in all fields before submitting.');
      return;
    }

    const typeLabel = type === 'bug' ? 'Bug Report' : 'Feature Request';
    const subject = encodeURIComponent(`[BellaHealth ${typeLabel}] ${title.trim()}`);
    const body = encodeURIComponent(
      `From: ${userName || 'BellaHealth User'}\nType: ${typeLabel}\n\n${description.trim()}\n\n---\nSent from BellaHealth app`
    );
    const mailto = `mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`;

    const canOpen = await Linking.canOpenURL(mailto);
    if (!canOpen) {
      Alert.alert(
        'No mail app found',
        `Please email us directly at ${SUPPORT_EMAIL} with your ${typeLabel.toLowerCase()}.`
      );
      return;
    }

    await Linking.openURL(mailto);
    setSubmitted(true);
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <KeyboardAvoidingView
        style={[styles.container, { backgroundColor: palette.background, paddingTop: Spacing.three }]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
      {submitted ? (
        <>
          <View style={styles.doneRow}>
            <TouchableOpacity onPress={() => { reset(); onClose(); }} activeOpacity={0.7}>
              <ThemedText style={[styles.doneBtn, { color: palette.accent }]}>Done</ThemedText>
            </TouchableOpacity>
          </View>
          <View style={styles.successContainer}>
            <ThemedText style={[styles.successTitle, { color: palette.text }]}>Thank you.</ThemedText>
            <ThemedText style={[styles.successText, { color: palette.textSecondary }]}>
              Your {type === 'bug' ? 'bug report' : 'feature request'} is ready to send — just hit send in your mail app.
            </ThemedText>
            <TouchableOpacity onPress={reset} activeOpacity={0.7}>
              <ThemedText style={[styles.resetLink, { color: palette.accent }]}>Submit another →</ThemedText>
            </TouchableOpacity>
          </View>
        </>
      ) : (
        <>
          <View style={styles.header}>
            <View>
              <ThemedText style={[styles.title, { color: palette.text }]}>Support</ThemedText>
              <ThemedText style={[styles.subtitle, { color: palette.textSecondary }]}>We read every message</ThemedText>
            </View>
            <TouchableOpacity onPress={onClose} activeOpacity={0.7}>
              <ThemedText style={[styles.doneBtn, { color: palette.accent }]}>Done</ThemedText>
            </TouchableOpacity>
          </View>
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
          <ThemedText style={[styles.sectionLabel, { color: palette.textSecondary }]}>What brings you here?</ThemedText>
          <View style={styles.typeCards}>
            {TYPES.map((t) => (
              <TouchableOpacity
                key={t.id}
                style={[
                  styles.typeCard,
                  { backgroundColor: palette.card, borderColor: type === t.id ? palette.accent : palette.divider },
                ]}
                onPress={() => setType(t.id)}
                activeOpacity={0.7}
              >
                <View style={{ flex: 1 }}>
                  <ThemedText style={[styles.typeLabel, { color: palette.text }]}>{t.label}</ThemedText>
                  <ThemedText style={[styles.typeDesc, { color: palette.textSecondary }]}>{t.description}</ThemedText>
                </View>
                {type === t.id && (
                  <ThemedText style={[styles.typeCheck, { color: palette.accent }]}>✓</ThemedText>
                )}
              </TouchableOpacity>
            ))}
          </View>

          {type && (
            <>
              <View style={[styles.inputCard, { borderColor: palette.divider }]}>
                <ThemedText style={[styles.fieldLabel, { color: palette.textSecondary }]}>
                  {type === 'bug' ? 'What went wrong?' : 'What would you like to see?'}
                </ThemedText>
                <TextInput
                  style={[styles.titleInput, { color: palette.text, borderBottomColor: palette.divider }]}
                  value={title}
                  onChangeText={setTitle}
                  placeholder={type === 'bug' ? 'e.g. Sleep data not loading' : 'e.g. Weekly nutrition summary'}
                  placeholderTextColor={palette.textSecondary}
                  returnKeyType="next"
                />
              </View>

              <View style={[styles.inputCard, { borderColor: palette.divider }]}>
                <ThemedText style={[styles.fieldLabel, { color: palette.textSecondary }]}>
                  {type === 'bug' ? 'Steps to reproduce / what you expected' : 'Describe the feature'}
                </ThemedText>
                <TextInput
                  style={[styles.descInput, { color: palette.text }]}
                  value={description}
                  onChangeText={setDescription}
                  placeholder={
                    type === 'bug'
                      ? 'What were you doing? What did you expect to happen vs. what actually happened?'
                      : 'What problem would this solve? How would it work?'
                  }
                  placeholderTextColor={palette.textSecondary}
                  multiline returnKeyType="done" blurOnSubmit textAlignVertical="top"
                />
              </View>

              <TouchableOpacity
                style={[
                  styles.submitBtn,
                  { borderColor: palette.accent },
                  (!title.trim() || !description.trim()) && { opacity: 0.35 },
                ]}
                onPress={submit} activeOpacity={0.8}
                disabled={!title.trim() || !description.trim()}
              >
                <ThemedText style={[styles.submitBtnText, { color: palette.accent }]}>
                  {type === 'bug' ? 'Send Bug Report →' : 'Send Feature Request →'}
                </ThemedText>
              </TouchableOpacity>

              <ThemedText style={[styles.footerNote, { color: palette.textSecondary }]}>
                Opens your mail app pre-filled — just hit Send.
              </ThemedText>
            </>
          )}

          <View style={[styles.contactRow, { borderColor: palette.divider }]}>
            <ThemedText style={[styles.contactText, { color: palette.textSecondary }]}>
              Or email directly:{' '}
              <ThemedText style={[styles.contactEmail, { color: palette.accent }]}>{SUPPORT_EMAIL}</ThemedText>
            </ThemedText>
          </View>

          <TouchableOpacity
            style={[styles.contactRow, { borderColor: palette.divider }]}
            onPress={() => {
              if (PRIVACY_POLICY_URL) {
                Linking.openURL(PRIVACY_POLICY_URL);
              } else {
                Alert.alert('Privacy Policy', 'Privacy Policy URL not yet configured.');
              }
            }}
            activeOpacity={0.7}
          >
            <ThemedText style={[styles.contactText, { color: palette.accent }]}>Privacy Policy →</ThemedText>
          </TouchableOpacity>
        </ScrollView>
        </>
      )}
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: Spacing.three },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: Spacing.three },
  doneRow: { flexDirection: 'row', justifyContent: 'flex-end', paddingBottom: Spacing.two },
  doneBtn: { fontSize: 16, fontWeight: '400', paddingTop: 6 },
  scroll: { gap: Spacing.three, paddingBottom: Spacing.six },

  title: { fontFamily: Fonts.serif, fontSize: 28, fontStyle: 'italic', fontWeight: '400', paddingTop: 4, paddingRight: 4 },
  subtitle: { fontSize: 14, fontStyle: 'italic', marginTop: 3 },

  sectionLabel: { fontSize: 9, letterSpacing: 2.5, textTransform: 'uppercase' },

  typeCards: { gap: Spacing.two },
  typeCard: { flexDirection: 'row', alignItems: 'center', borderWidth: StyleSheet.hairlineWidth, borderRadius: 2, paddingHorizontal: Spacing.three, paddingVertical: 14, gap: Spacing.two },
  typeLabel: { fontSize: 15 },
  typeDesc: { fontSize: 12, marginTop: 2 },
  typeCheck: { fontSize: 16 },

  inputCard: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 2, padding: Spacing.three, gap: Spacing.two },
  fieldLabel: { fontSize: 9, letterSpacing: 2.5, textTransform: 'uppercase' },
  titleInput: { fontSize: 16, borderBottomWidth: StyleSheet.hairlineWidth, paddingBottom: 8 },
  descInput: { fontSize: 15, minHeight: 120, lineHeight: 22 },

  submitBtn: {
    borderWidth: StyleSheet.hairlineWidth, borderRadius: 2,
    paddingVertical: 16, alignItems: 'center',
  },
  submitBtnText: { fontSize: 15 },
  footerNote: { fontSize: 12, textAlign: 'center', fontStyle: 'italic' },

  contactRow: {
    borderWidth: StyleSheet.hairlineWidth, borderRadius: 2,
    padding: Spacing.three,
  },
  contactText: { fontSize: 13 },
  contactEmail: { fontStyle: 'italic' },

  successContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.two, gap: Spacing.three },
  successTitle: { fontFamily: Fonts.serif, fontSize: 36, fontStyle: 'italic', fontWeight: '400', paddingTop: 8, paddingRight: 6 },
  successText: { fontSize: 16, textAlign: 'center', lineHeight: 24 },
  resetLink: { fontSize: 15, marginTop: Spacing.two },
});
