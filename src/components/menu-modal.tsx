import React, { useState } from 'react';
import { Modal, ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { SymbolView } from 'expo-symbols';

import { PaywallContent } from '@/components/paywall-modal';

import { ThemedText } from '@/components/themed-text';
import { Fonts, Spacing } from '@/constants/theme';
import { useAppTheme } from '@/context/theme-context';
import {
  GROUP_YOUR_HEALTH,
  GROUP_BELLAHEALTH,
  GROUP_PRESERVED,
  type MenuItem,
} from '@/config/menu-config';

export { GROUP_BELLAHEALTH };

// ─── Palette ───────────────────────────────────────────────────────────────────

function getMenuPalette(isDark: boolean, userTheme: import('@/constants/theme').UserTheme) {
  if (userTheme === 'forest') return isDark
    ? { background: '#141414', text: '#E8F0E6', textSecondary: '#7A9878', divider: 'rgba(255,255,255,0.08)', accent: '#6A9868', card: '#1C1C1E' }
    : { background: '#F8F2EC', text: '#1E2820', textSecondary: '#5A6E58', divider: '#C8D4C4',               accent: '#6A9878', card: '#FFFFFF'   };
  if (userTheme === 'mauve') return isDark
    ? { background: '#1A1218', text: '#F2E8EC', textSecondary: '#8A7888', divider: 'rgba(255,255,255,0.08)', accent: '#C07890', card: '#251D28' }
    : { background: '#F8F2EC', text: '#2D1B1B', textSecondary: '#8B6B6B', divider: '#E4D8D0',               accent: '#C17B8E', card: '#FFFFFF'   };
  // neutral
  return isDark
    ? { background: '#111111', text: '#FFFFFF', textSecondary: '#8E8E93', divider: 'rgba(255,255,255,0.08)', accent: '#F8F8F8', card: '#1C1C1E' }
    : { background: '#FFFFFF', text: '#111111', textSecondary: '#6B6B6B', divider: '#E4E4E4',               accent: '#111111', card: '#FFFFFF'   };
}

// ─── Menu groups ───────────────────────────────────────────────────────────────

// ─── Coming Soon screen ────────────────────────────────────────────────────────

const SOON_DESCRIPTIONS: Record<string, string> = {
  screensights: 'Insights from your Apple Health screen time data.',
  learn:        'Resources on health, fitness, nutrition, and recovery.',
  club:         'Join the club — influencers sharing goals, meals, and workouts.',
};

// Renders as a plain View — always shown inside the menu's existing pageSheet,
// so no nested Modal needed.
function ComingSoonView({ id, onClose, pal }: {
  id: string; onClose: () => void;
  pal: ReturnType<typeof getMenuPalette>;
}) {
  const label = [...GROUP_YOUR_HEALTH, ...GROUP_BELLAHEALTH, ...GROUP_PRESERVED].find(m => m.id === id)?.label ?? '';
  return (
    <View style={[soonStyles.container, { backgroundColor: pal.background }]}>
      <View style={[soonStyles.header, { borderBottomColor: pal.divider, paddingTop: Spacing.three }]}>
        <ThemedText style={[soonStyles.title, { color: pal.text }]}>{label}</ThemedText>
        <TouchableOpacity onPress={onClose} activeOpacity={0.7}>
          <ThemedText style={[soonStyles.done, { color: pal.accent }]}>Done</ThemedText>
        </TouchableOpacity>
      </View>
      <View style={soonStyles.body}>
        <ThemedText style={[soonStyles.soonLabel, { color: pal.textSecondary }]}>Coming Soon</ThemedText>
        <ThemedText style={[soonStyles.desc, { color: pal.text }]}>{SOON_DESCRIPTIONS[id] ?? ''}</ThemedText>
      </View>
    </View>
  );
}

const soonStyles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: Spacing.three, paddingBottom: Spacing.three,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontFamily: Fonts.serif, fontSize: 26, fontStyle: 'italic', fontWeight: '400', paddingTop: 3, paddingRight: 4 },
  done:  { fontSize: 14, letterSpacing: 0.3 },
  body:  { flex: 1, justifyContent: 'center', alignItems: 'center', gap: Spacing.two, paddingHorizontal: Spacing.four },
  soonLabel: { fontSize: 9, letterSpacing: 2.5, textTransform: 'uppercase' },
  desc: { fontFamily: Fonts.serif, fontSize: 17, fontStyle: 'italic', lineHeight: 26, textAlign: 'center' },
});

// ─── Row ──────────────────────────────────────────────────────────────────────

function MenuRow({ item, onPress, pal }: {
  item: MenuItem;
  onPress: () => void;
  pal: ReturnType<typeof getMenuPalette>;
}) {
  return (
    <TouchableOpacity
      style={[styles.row, { borderTopColor: pal.divider }]}
      onPress={onPress}
      activeOpacity={0.65}
    >
      <ThemedText style={[styles.rowLabel, { color: pal.text }, item.soon && { color: pal.textSecondary }]}>
        {item.label}
      </ThemedText>
      <View style={styles.rowRight}>
        {item.soon && (
          <ThemedText style={[styles.soonTag, { color: pal.textSecondary }]}>Soon</ThemedText>
        )}
        <ThemedText style={[styles.chevron, { color: pal.textSecondary }]}>›</ThemedText>
      </View>
    </TouchableOpacity>
  );
}

function GroupLabel({ label, pal }: { label: string; pal: ReturnType<typeof getMenuPalette> }) {
  return (
    <ThemedText style={[styles.groupLabel, { color: pal.textSecondary }]}>{label}</ThemedText>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export function MenuModal({ visible, onClose, onOpenScreen }: {
  visible: boolean;
  onClose: () => void;
  onOpenScreen: (screen: string) => void;
}) {
  const { isDark, userTheme } = useAppTheme();
  const pal = getMenuPalette(isDark, userTheme);
  const [activeSoonId, setActiveSoonId] = useState<string | null>(null);
  const [showPaywall, setShowPaywall] = useState(false);

  function handleClose() {
    setActiveSoonId(null);
    onClose();
  }

  function handleItemPress(item: MenuItem) {
    if (item.id === 'subscription') {
      setShowPaywall(true);
    } else if (item.soon) {
      setActiveSoonId(item.id);
    } else {
      onOpenScreen(item.id);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      {/* Paywall content replaces menu content inside the SAME sheet —
          iOS blocks presenting a second pageSheet from within an existing one,
          so we avoid nested modals entirely. */}
      {showPaywall ? (
        <PaywallContent onClose={() => setShowPaywall(false)} />
      ) : activeSoonId ? (
        <ComingSoonView
          id={activeSoonId}
          pal={pal}
          onClose={() => setActiveSoonId(null)}
        />
      ) : (
        <View style={[styles.container, { backgroundColor: pal.background, paddingTop: Spacing.three }]}>
          <View style={styles.handleWrap}>
            <View style={[styles.handle, { backgroundColor: pal.divider }]} />
          </View>

          <View style={[styles.header, { borderBottomColor: pal.divider }]}>
            <View>
              <ThemedText style={[styles.headerOverline, { color: pal.textSecondary }]}>BellaHealth</ThemedText>
            </View>
            <TouchableOpacity onPress={handleClose} activeOpacity={0.7}>
              <SymbolView name="xmark" size={16} tintColor={pal.textSecondary} weight="light" type="monochrome" />
            </TouchableOpacity>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>

            <GroupLabel label="Your Health" pal={pal} />
            {GROUP_YOUR_HEALTH.map((item) => (
              <MenuRow key={item.id} item={item} pal={pal} onPress={() => handleItemPress(item)} />
            ))}

            <View style={styles.groupGap} />
            <GroupLabel label="BellaHealth" pal={pal} />
            {GROUP_BELLAHEALTH.map((item) => (
              <MenuRow key={item.id} item={item} pal={pal} onPress={() => handleItemPress(item)} />
            ))}

          </ScrollView>
        </View>
      )}
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  handleWrap: { alignItems: 'center', paddingTop: Spacing.two, paddingBottom: Spacing.one },
  handle:     { width: 36, height: 4, borderRadius: 2 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.three,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerOverline: {
    fontSize: 9,
    letterSpacing: 3,
    textTransform: 'uppercase',
    fontFamily: Fonts.serif,
  },
  scroll: {
    paddingTop: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.six,
  },
  groupLabel: {
    fontSize: 9,
    letterSpacing: 2.5,
    textTransform: 'uppercase',
    marginBottom: 2,
    marginTop: 4,
  },
  groupGap: { height: Spacing.four },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  rowLabel: {
    fontFamily: Fonts.serif,
    fontSize: 20,
    fontStyle: 'italic',
    fontWeight: '400',
    lineHeight: 28,  // prevents descender clipping (g, p, y, etc.)
    paddingRight: 8, // prevents italic right-edge overhang clipping
  },
  rowRight: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one },
  soonTag:  { fontSize: 10, letterSpacing: 0.5 },
  chevron:  { fontSize: 22, fontWeight: '300', lineHeight: 28 },
});
