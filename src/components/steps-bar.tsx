import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useAppTheme } from '@/context/theme-context';

// Award tier colors
const GOLD = '#F5C842'; // crush-it tier — universal
const SAGE = '#7A9E78'; // above-goal tier — universal

// Below-goal accent per theme
const BELOW_NEUTRAL = '#888888';
const BELOW_MAUVE   = '#C4A8A8';
const BELOW_FOREST  = '#A8C4B0'; // muted sage green — analogous to BELOW_MAUVE's muted pink

function fmt(n: number) {
  if (n < 1000) return String(n);
  const k = Math.round(n / 100) / 10;
  return `${Number.isInteger(k) ? k : k.toFixed(1)}K`;
}

function getBarColor(steps: number, goalMin: number, goalMid: number, goalCrush: number, belowColor: string) {
  if (steps >= goalCrush) return GOLD;
  if (steps >= goalMid)   return SAGE;
  return belowColor;
}

function getAward(steps: number, goalMin: number, goalMid: number, goalCrush: number) {
  if (steps >= goalCrush) return 'CRUSHING IT';
  if (steps >= goalMid)   return 'ABOVE GOAL';
  if (steps >= goalMin)   return 'GOAL MET';
  return null;
}

export function StepsBar({ steps, goal = 10000 }: { steps: number; goal?: number }) {
  const { isDark, userTheme } = useAppTheme();

  const trackBg = isDark
    ? (userTheme === 'forest' ? '#2A3428' : userTheme === 'mauve' ? '#2A2030' : '#2A2A2A')
    : (userTheme === 'forest' ? '#CDD8C8' : userTheme === 'mauve' ? '#EEE0D8' : '#E4E4E4');

  const secondaryColor = isDark
    ? (userTheme === 'forest' ? '#8AA888' : userTheme === 'mauve' ? '#9A8898' : '#8E8E93')
    : (userTheme === 'forest' ? '#5A6E58' : userTheme === 'mauve' ? '#8B6B6B' : '#6B6B6B');

  const belowColor = userTheme === 'forest' ? BELOW_FOREST : userTheme === 'mauve' ? BELOW_MAUVE : BELOW_NEUTRAL;

  const goalMin   = goal;
  const goalMid   = Math.round(goal * 1.2);
  const goalCrush = Math.round(goal * 1.5);

  const fillPercent = Math.min(steps / goalCrush, 1);
  const midPercent  = goalMid / goalCrush;
  const minPercent  = goalMin / goalCrush;
  const award    = getAward(steps, goalMin, goalMid, goalCrush);
  const barColor = getBarColor(steps, goalMin, goalMid, goalCrush, belowColor);

  return (
    <View style={styles.container}>
      {award && (
        <View style={[styles.awardBadge, { backgroundColor: barColor }]}>
          <ThemedText style={styles.awardText}>{award}</ThemedText>
        </View>
      )}

      <View style={[styles.track, { backgroundColor: trackBg }]}>
        <View style={[styles.fill, { width: `${fillPercent * 100}%`, backgroundColor: barColor }]} />
        <View style={[styles.tick, { left: `${minPercent * 100}%` }]} />
        <View style={[styles.tick, { left: `${midPercent * 100}%` }]} />
      </View>

      <View style={styles.milestoneRow}>
        <View style={[styles.milestoneLabel, { left: `${minPercent * 100}%` }]}>
          <ThemedText style={[styles.milestoneText, { color: secondaryColor }]}>{fmt(goalMin)}</ThemedText>
        </View>
        <View style={[styles.milestoneLabel, { left: `${midPercent * 100}%` }]}>
          <ThemedText style={[styles.milestoneText, { color: secondaryColor }]}>{fmt(goalMid)}</ThemedText>
        </View>
        <View style={[styles.milestoneLabel, styles.milestoneLabelRight]}>
          <ThemedText style={[styles.milestoneText, { color: secondaryColor }]}>{fmt(goalCrush)}</ThemedText>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: Spacing.one,
  },
  awardBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    marginBottom: 2,
  },
  awardText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#fff',
    letterSpacing: 1,
  },
  track: {
    height: 10,
    borderRadius: 10,
    overflow: 'visible',
    position: 'relative',
  },
  fill: {
    height: '100%',
    borderRadius: 10,
  },
  tick: {
    position: 'absolute',
    top: -3,
    width: 2,
    height: 16,
    backgroundColor: '#fff',
    borderRadius: 1,
  },
  milestoneRow: {
    position: 'relative',
    height: 16,
    marginTop: 2,
  },
  milestoneLabel: {
    position: 'absolute',
    transform: [{ translateX: -8 }],
  },
  milestoneLabelRight: {
    // Right-aligns the label flush with the container right edge,
    // preventing "15K/18K/etc." from clipping on any iPhone width.
    right: 0,
    left: undefined,
    transform: [],
  },
  milestoneText: {
    fontSize: 10,
  },
});
