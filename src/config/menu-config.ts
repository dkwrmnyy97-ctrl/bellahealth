/**
 * menu-config.ts
 *
 * Menu item definitions for the profile/menu sheet.
 * Kept separate so the data is importable in tests without
 * pulling in the React Native component chain.
 */

export type MenuItem = {
  id: string;
  label: string;
  soon?: boolean;
};

export const GROUP_YOUR_HEALTH: MenuItem[] = [
  { id: 'profile',   label: 'Profile' },
  { id: 'documents', label: 'Documents' },
  { id: 'training',  label: 'Training' },
];

export const GROUP_BELLAHEALTH: MenuItem[] = [
  { id: 'chat',         label: 'Chat' },
  { id: 'screensights', label: 'ScreenSights', soon: true },
  { id: 'subscription', label: 'BellaHealth+',  soon: true },
  { id: 'vacation',     label: 'Travel Mode' },
  { id: 'support',      label: 'Support' },
];

// Preserved for future use — not currently shown in the menu.
export const GROUP_PRESERVED: MenuItem[] = [
  { id: 'learn', label: 'Learn', soon: true },
  { id: 'club',  label: 'BellaHealth Club', soon: true },
];

/**
 * Deterministic action mapping for menu items.
 * Mirrors the runtime logic in MenuModal.handleItemPress so it can be
 * tested independently of the React component/modal stack.
 *
 * 'paywall'  → open BellaHealth+ Coming Soon preview
 * 'soon'     → open generic ComingSoon sheet
 * 'navigate' → delegate to onOpenScreen(item.id)
 */
export function resolveMenuAction(item: MenuItem): 'paywall' | 'soon' | 'navigate' {
  if (item.id === 'subscription') return 'paywall';
  if (item.soon) return 'soon';
  return 'navigate';
}
