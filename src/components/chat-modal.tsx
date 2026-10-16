import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Keyboard, Modal, ScrollView, StyleSheet, TextInput, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { Fonts, Spacing } from '@/constants/theme';
import { buildDocumentContext, loadDocuments } from '@/services/document-ai';
import { buildCycleContext, loadCycleEntries, loadCycleProfile } from '@/components/cycle-modal';
import { claudeProxyPost } from '@/services/claude-proxy';
import { useAppTheme } from '@/context/theme-context';
import { getModalPalette } from '@/utils/modal-palette';
import { trackEvent } from '@/services/analytics';
import type { ContextSummary } from '@/services/context-synthesis';
import { TIER_LABEL } from '@/utils/pattern-language';
import { buildTodaySection, type HealthSnapshot } from '@/utils/chat-prompt';

export type { HealthSnapshot } from '@/utils/chat-prompt';

type Message = { role: 'user' | 'ai'; text: string };

/**
 * Builds a minimal structured context section from ContextSummary.
 * Only called when the user explicitly taps "Talk more about your insights."
 * Never auto-injected. Never includes raw timelines or cycle/journal text.
 */
function buildContextSection(summary: ContextSummary): string {
  const lines: string[] = [
    '\nCONTEXT INSIGHTS (user opened Chat from the Context screen):',
    `Current theme: ${summary.currentTheme.theme.replace(/_/g, ' ')}`,
  ];

  if (summary.todaySignals.length > 0) {
    const sigs = summary.todaySignals
      .map((s) => `${s.signal}: ${Math.round(s.value)} (${s.interpretation})`)
      .join(', ');
    lines.push(`Today\'s signals: ${sigs}`);
  }

  if (summary.strongestConnection) {
    const sc = summary.strongestConnection;
    lines.push(
      `Strongest connection: ${sc.description} — ${TIER_LABEL[sc.evidenceTier]} across ${sc.observationCount} days`
    );
  }

  if (summary.activeContextTypes.length > 0) {
    lines.push(`Active life context: ${summary.activeContextTypes.join(', ')}`);
  }

  lines.push(
    '\nThe user wants to discuss their patterns and what they might mean.',
    'Describe associations, not causes. Stay within what the data actually shows.',
    'Keep it concise and specific to their actual findings.'
  );

  return lines.join('\n');
}

function buildSystemPrompt(
  health: HealthSnapshot,
  userName: string,
  isMale: boolean,
  supplements: string,
  docContext: string,
  cycleContext: string,
  contextSummary?: ContextSummary,
): string {
  const docSection = docContext ? `\nHEALTH DOCUMENTS ON FILE:\n${docContext}\n` : '';
  const cycleSection = (cycleContext && !isMale) ? `\n${cycleContext}\n` : '';
  const supplementSection = supplements
    ? `\nSUPPLEMENTS ${userName} TAKES: ${supplements}\n`
    : '';

  const pronoun = isMale ? 'his' : 'her';

  const contextSection = contextSummary ? buildContextSection(contextSummary) : '';

  return `You are ${userName}'s personal health AI inside the BellaHealth app. You have real-time access to ${pronoun} health data, uploaded records, and daily journal entries. Use all of this to give specific, personalized answers — never generic advice.
${cycleSection}
TODAY'S DATA:
${buildTodaySection(health)}

Data sources: Oura Ring (sleep, HRV, readiness), Apple Health (workouts, water, steps).
${supplementSection}${docSection}${contextSection}
${docContext ? 'When health documents are on file, cross-reference them actively. If bloodwork shows relevant markers — connect findings to current data.\n\n' : ''}Be warm, direct, and specific. Reference their actual numbers. Keep responses concise — 2–4 sentences unless they ask for detail. You know their name is ${userName}.`;
}

async function callClaude(systemPrompt: string, messages: Message[]): Promise<string> {
  const apiMessages = messages.map((m) => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.text,
  }));

  return claudeProxyPost({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system: systemPrompt,
    messages: apiMessages,
  });
}

export function ChatModal({
  visible,
  onClose,
  healthData,
  userName,
  isMale,
  supplements,
  contextSummary,
}: {
  visible: boolean;
  onClose: () => void;
  healthData: HealthSnapshot;
  userName: string;
  isMale: boolean;
  supplements: string;
  /** Passed only when user explicitly taps "Talk more about your insights" from Context screen. */
  contextSummary?: ContextSummary;
}) {
  const { isDark, userTheme } = useAppTheme();
  const palette = getModalPalette(isDark, userTheme);
  const insets = useSafeAreaInsets();

  const CHAT_KEY = 'chat_history';
  const INITIAL_MSG: Message = {
    role: 'ai',
    text: `Hi ${userName || 'there'}. Ask me anything — nutrition, recovery, how your body might be responding to something, or anything else on your mind.`,
  };

  const [messages, setMessages] = useState<Message[]>([INITIAL_MSG]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [docContext, setDocContext] = useState('');
  const [cycleContext, setCycleContext] = useState('');
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const scrollRef = useRef<ScrollView>(null);
  const sessionTrackedRef = useRef(false);

  useEffect(() => {
    const show = Keyboard.addListener('keyboardWillShow', (e) => setKeyboardHeight(e.endCoordinates.height));
    const hide = Keyboard.addListener('keyboardWillHide', () => setKeyboardHeight(0));
    return () => { show.remove(); hide.remove(); };
  }, []);

  useEffect(() => {
    if (!visible) return;
    sessionTrackedRef.current = false;
    loadDocuments().then((docs) => setDocContext(buildDocumentContext(docs))).catch(() => {});
    if (!isMale) {
      Promise.all([loadCycleEntries(), loadCycleProfile()])
        .then(([entries, profile]) => setCycleContext(buildCycleContext(entries, profile)))
        .catch(() => {});
    }
    AsyncStorage.getItem(CHAT_KEY).then((raw) => {
      if (!raw) return;
      const saved: Message[] = JSON.parse(raw);
      if (saved.length === 0) return;
      // Update the greeting if it was saved with a different name
      if (saved[0].role === 'ai' && saved[0].text.startsWith('Hi ')) {
        saved[0] = INITIAL_MSG;
      }
      setMessages(saved);
    }).catch(() => {});
  }, [visible]);

  async function clearHistory() {
    setMessages([INITIAL_MSG]);
    await AsyncStorage.removeItem(CHAT_KEY);
  }

  async function send() {
    const text = input.trim();
    if (!text || loading) return;
    setInput('');

    const userMsg: Message = { role: 'user', text };
    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    setLoading(true);

    try {
      const systemPrompt = buildSystemPrompt(healthData, userName, isMale, supplements, docContext, cycleContext, contextSummary);
      const reply = await callClaude(systemPrompt, nextMessages);
      const withReply = [...nextMessages, { role: 'ai' as const, text: reply }];
      const toSave = withReply.slice(-40);
      setMessages(toSave);
      AsyncStorage.setItem(CHAT_KEY, JSON.stringify(toSave)).catch(() => {});
      if (!sessionTrackedRef.current) {
        sessionTrackedRef.current = true;
        trackEvent('ai_chat_used', { source_screen: 'chat' });
      }
    } catch (e: any) {
      setMessages((prev) => [...prev, { role: 'ai', text: `Sorry, I couldn't connect right now. (${e?.message ?? 'unknown error'})` }]);
    } finally {
      setLoading(false);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <View style={[styles.container, { backgroundColor: palette.background, paddingBottom: keyboardHeight > 0 ? keyboardHeight : insets.bottom }]}>
        <View style={[styles.header, { borderBottomColor: palette.divider, paddingTop: Spacing.three }]}>
          <View>
            <ThemedText style={[styles.title, { color: palette.text }]}>Chat</ThemedText>
            <ThemedText style={[styles.subtitle, { color: palette.textSecondary }]}>your personal health AI</ThemedText>
          </View>
          <View style={{ flexDirection: 'row', gap: Spacing.three, alignItems: 'center' }}>
            <TouchableOpacity onPress={clearHistory} activeOpacity={0.7}>
              <ThemedText style={[styles.headerAction, { color: palette.textSecondary }]}>Clear</ThemedText>
            </TouchableOpacity>
            <TouchableOpacity onPress={onClose} activeOpacity={0.7}>
              <ThemedText style={[styles.headerAction, { color: palette.accent }]}>Done</ThemedText>
            </TouchableOpacity>
          </View>
        </View>

        <ScrollView
          ref={scrollRef}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.messages}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
        >
          {messages.map((msg, i) => (
            <View key={i} style={[styles.bubbleWrap, msg.role === 'user' && styles.bubbleWrapUser]}>
              {msg.role === 'ai' && (
                <View style={[styles.aiAvatar, { backgroundColor: palette.accent + '30' }]}>
                  <ThemedText style={{ fontSize: 10, color: palette.accent }}>✦</ThemedText>
                </View>
              )}
              <View style={[
                styles.bubble,
                msg.role === 'user'
                  ? [styles.userBubble, { backgroundColor: palette.accent }]
                  : [styles.aiBubble, { backgroundColor: palette.card, borderColor: palette.divider }],
              ]}>
                <ThemedText style={[styles.bubbleText, { color: msg.role === 'user' ? '#fff' : palette.text }]}>
                  {msg.text}
                </ThemedText>
              </View>
            </View>
          ))}
        </ScrollView>

        <View style={[styles.inputRow, { borderTopColor: palette.divider, backgroundColor: palette.background }]}>
          <TextInput
            style={[styles.input, { backgroundColor: palette.card, color: palette.text, borderColor: palette.divider }]}
            value={input}
            onChangeText={setInput}
            placeholder="Ask anything..."
            placeholderTextColor={palette.textSecondary}
            returnKeyType="send"
            onSubmitEditing={send}
            multiline
          />
          <TouchableOpacity
            style={[styles.sendBtn, { backgroundColor: palette.accent, opacity: (input.trim() && !loading) ? 1 : 0.4 }]}
            onPress={send}
            disabled={!input.trim() || loading}
            activeOpacity={0.8}
          >
            {loading
              ? <ActivityIndicator size="small" color="#fff" />
              : <ThemedText style={styles.sendBtnText}>↑</ThemedText>
            }
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start',
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.two,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontFamily: Fonts.serif, fontSize: 26, fontStyle: 'italic', fontWeight: '400', paddingTop: 3, paddingRight: 4 },
  subtitle: { fontSize: 11, fontStyle: 'italic', marginTop: 2 },
  headerAction: { fontSize: 16, fontWeight: '400' },
  messages: { padding: Spacing.three, gap: Spacing.two, paddingBottom: Spacing.three },
  bubbleWrap: { flexDirection: 'row', alignItems: 'flex-end', gap: Spacing.one, maxWidth: '88%' },
  bubbleWrapUser: { alignSelf: 'flex-end', flexDirection: 'row-reverse' },
  aiAvatar: {
    width: 22, height: 22, borderRadius: 11,
    alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  bubble: { borderRadius: 8, padding: Spacing.two, paddingHorizontal: Spacing.three, maxWidth: '100%' },
  aiBubble: { borderWidth: StyleSheet.hairlineWidth },
  userBubble: {},
  bubbleText: { fontSize: 15, lineHeight: 22 },
  inputRow: {
    flexDirection: 'row', alignItems: 'flex-end',
    gap: Spacing.two, padding: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingBottom: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 4,
    paddingHorizontal: Spacing.three,
    paddingVertical: 10, fontSize: 15,
    maxHeight: 100, lineHeight: 22,
  },
  sendBtn: {
    width: 38, height: 38, borderRadius: 19,
    alignItems: 'center', justifyContent: 'center',
  },
  sendBtnText: { fontSize: 18, color: '#fff', fontWeight: '600' },
});
