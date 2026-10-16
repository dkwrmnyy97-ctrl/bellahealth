/**
 * Below are the colors that are used in the app. The colors are defined in the light and dark mode.
 * There are many other ways to style your app. For example, [Nativewind](https://www.nativewind.dev/), [Tamagui](https://tamagui.dev/), [unistyles](https://reactnativeunistyles.vercel.app), etc.
 */

import '@/global.css';

import { Platform } from 'react-native';

export const Colors = {
  light: {
    text: '#000000',
    background: '#ffffff',
    backgroundElement: '#F0F0F3',
    backgroundSelected: '#E0E1E6',
    textSecondary: '#60646C',
  },
  dark: {
    text: '#ffffff',
    background: '#000000',
    backgroundElement: '#212225',
    backgroundSelected: '#2E3135',
    textSecondary: '#B0B4BA',
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
export const MaxContentWidth = 800;

// ── User-selectable colour themes ─────────────────────────────────────────────
// Completely decoupled from biological sex.
//   neutral — clean black/white, no tint (default for all new users)
//   mauve   — warm dusty rose / ivory (was "female" palette)
//   forest  — sage / olive / stone    (was "male" palette)
export type UserTheme = 'neutral' | 'mauve' | 'forest';

// ── BellaHealth brand tokens ──────────────────────────────────────────────────
// Use these everywhere instead of hardcoded hex strings.

export const BHColors = {
  // Female palette — dusty rose / sage / warm ivory
  female: {
    background:    '#F8F2EC',
    card:          '#FFFFFF',
    text:          '#2D1B1B',
    textSecondary: '#8B6B6B',
    divider:       '#EEE0D8',
    shadow:        'rgba(180,140,130,0.22)',
    cardBorder:    'rgba(45,27,27,0.07)',
    accent:        '#C17B8E',
    accentMuted:   '#D4A99A',
    sleep:         '#7A9E78',
    steps:         '#B85E68',
    nutrition:     '#A06050',
    workout:       '#8070A8',
    water:         '#5A90B0',
    drinking:      '#8C4252',
    cycle:         '#A85878',
  },
  femaleDark: {
    background:    '#1E1620',
    card:          '#2A2030',
    text:          '#F2E8EC',
    textSecondary: '#9A8898',
    divider:       'rgba(255,255,255,0.10)',
    shadow:        'rgba(0,0,0,0.55)',
    cardBorder:    'rgba(255,255,255,0.08)',
    accent:        '#C17B8E',
    accentMuted:   '#B87898',
    sleep:         '#72A86E',
    steps:         '#D47880',
    nutrition:     '#C06858',
    workout:       '#9888C8',
    water:         '#68A0C0',
    drinking:      '#B05868',
    cycle:         '#C07898',
  },
  // Male palette — sage / olive / stone (NOT blue)
  male: {
    background:    '#F8F2EC', // neutral warm ivory — same canvas as female
    card:          '#FFFFFF',
    text:          '#1E2820',
    textSecondary: '#5A6E58',
    divider:       '#CDD8C8',
    shadow:        'rgba(30,40,32,0.18)',
    cardBorder:    'rgba(30,40,32,0.07)',
    accent:        '#6A9878',
    accentMuted:   '#8AAE88',
    sleep:         '#6A9878',
    steps:         '#7A8E68',
    nutrition:     '#8A7A58',
    workout:       '#7A9870',
    water:         '#5A8878',
    drinking:      '#6A7858',
    cycle:         '#7A9878',
  },
  maleDark: {
    background:    '#141414', // neutral dark — no green tint
    card:          '#1C1C1E',
    text:          '#E8F0E6',
    textSecondary: '#8AA888',
    divider:       'rgba(255,255,255,0.10)',
    shadow:        'rgba(0,0,0,0.55)',
    cardBorder:    'rgba(255,255,255,0.08)',
    accent:        '#6A9868',
    accentMuted:   '#7AAA78',
    sleep:         '#5A9068',
    steps:         '#6A8858',
    nutrition:     '#7A6848',
    workout:       '#6A9060',
    water:         '#508878',
    drinking:      '#5A7850',
    cycle:         '#6A9068',
  },
  // Universal functional colors (never vary by gender/mode)
  functional: {
    gold:         '#F5C842',
    goldText:     '#7A6000',
    danger:       '#C83232',
    success:      '#5A9E58',
    successSoft:  '#B8C9B0',
    nudge:        '#A8C4D4',
    warning:      '#E8B4B8',
  },
} as const;

// Border radius tokens — reduced from 28 to editorial ~16
export const BHRadius = {
  card: 16,
  chip: 10,
  btn:  20,
  pill: 100,
} as const;
