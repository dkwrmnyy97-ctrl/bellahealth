// Modal colour palettes — three explicit user-selectable themes × dark/light.
// Import getModalPalette(isDark, userTheme) — never branch on gender here.

import type { UserTheme } from '@/constants/theme';

export type ModalPalette = {
  background: string;
  card: string;
  text: string;
  textSecondary: string;
  divider: string;
  shadow: string;
  accent: string;    // icons, arrows, borders
  accentBtn: string; // close / primary action buttons
  plus: string;      // add/increment button
  minus: string;     // remove/decrement button
  viz: string;       // chart / data-visualization bars
};

// ── Neutral — pure black/off-white, truly colourless (default) ───────────────

const NEUTRAL_LIGHT: ModalPalette = {
  background:    '#FFFFFF',
  card:          '#FFFFFF',
  text:          '#111111',
  textSecondary: '#6B6B6B',
  divider:       '#E4E4E4',
  shadow:        'rgba(0,0,0,0.10)',
  accent:        '#111111',
  accentBtn:     '#111111',
  plus:          '#444444',
  minus:         '#888888',
  viz:           '#3A3A3A',  // dark charcoal — less harsh than #111111 for chart bars
};

const NEUTRAL_DARK: ModalPalette = {
  background:    '#111111',
  card:          '#1C1C1E',
  text:          '#FFFFFF',
  textSecondary: '#8E8E93',
  divider:       'rgba(255,255,255,0.12)',
  shadow:        'rgba(0,0,0,0.55)',
  accent:        '#F8F8F8',
  accentBtn:     '#F8F8F8',
  plus:          '#F8F8F8',
  minus:         '#8E8E93',
  viz:           '#F8F8F8',  // near-white bars on dark canvas — unchanged
};

// ── Mauve — warm ivory / dusty rose ──────────────────────────────────────────

const MAUVE_LIGHT: ModalPalette = {
  background:    '#FAF5F0',
  card:          '#FFFFFF',
  text:          '#2D1B1B',
  textSecondary: '#8B6B6B',
  divider:       '#F0E4E0',
  shadow:        'rgba(180,140,130,0.22)',
  accent:        '#C17B8E',
  accentBtn:     '#A85878',
  plus:          '#7A9E78',
  minus:         '#C17B8E',
  viz:           '#C17B8E',
};

const MAUVE_DARK: ModalPalette = {
  background:    '#1E1620',
  card:          '#2A2030',
  text:          '#F2E8EC',
  textSecondary: '#9A8898',
  divider:       'rgba(255,255,255,0.10)',
  shadow:        'rgba(0,0,0,0.55)',
  accent:        '#C17B8E',
  accentBtn:     '#A86888',
  plus:          '#72A86E',
  minus:         '#C07880',
  viz:           '#C17B8E',
};

// ── Forest — warm ivory canvas, sage/olive accents. Values match PALETTE_MALE
// in index.tsx (the approved Forest home-screen treatment).

const FOREST_LIGHT: ModalPalette = {
  background:    '#F8F2EC',  // warm ivory canvas
  card:          '#FFFFFF',
  text:          '#1E2820',  // very dark green-black
  textSecondary: '#5A6E58',  // muted sage
  divider:       '#C8D4C4',  // sage divider
  shadow:        'rgba(30,40,32,0.18)',
  accent:        '#6A9878',  // sage green
  accentBtn:     '#6A9878',
  plus:          '#5A9058',
  minus:         '#888888',
  viz:           '#6A9878',
};

const FOREST_DARK: ModalPalette = {
  background:    '#141414',  // neutral dark — no green tint
  card:          '#1C1C1E',
  text:          '#E8F0E6',  // slight green tint on near-white
  textSecondary: '#7A9878',  // muted sage
  divider:       'rgba(255,255,255,0.10)',
  shadow:        'rgba(0,0,0,0.55)',
  accent:        '#6A9868',  // sage green dark
  accentBtn:     '#6A9868',
  plus:          '#72A86E',
  minus:         '#8E8E93',
  viz:           '#6A9868',
};

export function getModalPalette(isDark: boolean, userTheme: UserTheme = 'neutral'): ModalPalette {
  if (userTheme === 'mauve')  return isDark ? MAUVE_DARK  : MAUVE_LIGHT;
  if (userTheme === 'forest') return isDark ? FOREST_DARK : FOREST_LIGHT;
  return isDark ? NEUTRAL_DARK : NEUTRAL_LIGHT;
}
