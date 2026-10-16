/**
 * menu.test.ts
 *
 * Lightweight regression tests for the BellaHealth profile/menu cleanup
 * and BellaHealth+ Coming Soon preview.
 *
 * Tests cover:
 *  1. Removed menu items are no longer in GROUP_BELLAHEALTH
 *  2. BellaHealth+ is present in GROUP_BELLAHEALTH
 *  3. Chat navigation row is present
 *  4. Travel Mode navigation row is present
 *  5. Support navigation row is present
 *  6. No subscription/payment functionality was introduced
 *     (SUBSCRIPTION_READY remains false; subscribe() and restorePurchases()
 *      return no-op results — verified via subscription.ts directly)
 */

import { GROUP_BELLAHEALTH, GROUP_PRESERVED, resolveMenuAction } from '../../config/menu-config';
import {
  SUBSCRIPTION_READY,
  subscribe,
  restorePurchases,
} from '../../services/subscription';

// ─── Menu structure ────────────────────────────────────────────────────────────

describe('GROUP_BELLAHEALTH — active menu items', () => {
  it('contains Chat', () => {
    expect(GROUP_BELLAHEALTH.find((i) => i.id === 'chat')).toBeDefined();
  });

  it('contains ScreenSights with soon:true (restored)', () => {
    const item = GROUP_BELLAHEALTH.find((i) => i.id === 'screensights');
    expect(item).toBeDefined();
    expect(item!.label).toBe('ScreenSights');
    expect(item!.soon).toBe(true);
  });

  it('contains BellaHealth+ with soon:true (Coming Soon treatment)', () => {
    const item = GROUP_BELLAHEALTH.find((i) => i.id === 'subscription');
    expect(item).toBeDefined();
    expect(item!.label).toBe('BellaHealth+');
    expect(item!.soon).toBe(true);
  });

  it('contains Travel Mode', () => {
    const item = GROUP_BELLAHEALTH.find((i) => i.id === 'vacation');
    expect(item).toBeDefined();
    expect(item!.label).toBe('Travel Mode');
    expect(item!.soon).toBeUndefined();
  });

  it('contains Support', () => {
    const item = GROUP_BELLAHEALTH.find((i) => i.id === 'support');
    expect(item).toBeDefined();
    expect(item!.label).toBe('Support');
  });

  it('has exactly 5 items in order: Chat, ScreenSights, BellaHealth+, Travel Mode, Support', () => {
    expect(GROUP_BELLAHEALTH).toHaveLength(5);
    expect(GROUP_BELLAHEALTH.map((i) => i.id)).toEqual([
      'chat', 'screensights', 'subscription', 'vacation', 'support',
    ]);
  });

  it('only ScreenSights and BellaHealth+ are marked soon — Chat/Travel Mode/Support are not', () => {
    const soonIds = GROUP_BELLAHEALTH.filter((i) => i.soon).map((i) => i.id);
    expect(soonIds).toEqual(['screensights', 'subscription']);
  });
});

describe('GROUP_BELLAHEALTH — order', () => {
  it('Chat is first', () => {
    expect(GROUP_BELLAHEALTH[0].id).toBe('chat');
  });

  it('ScreenSights is second (restored original position)', () => {
    expect(GROUP_BELLAHEALTH[1].id).toBe('screensights');
  });

  it('BellaHealth+ is third', () => {
    expect(GROUP_BELLAHEALTH[2].id).toBe('subscription');
  });

  it('Travel Mode is fourth', () => {
    expect(GROUP_BELLAHEALTH[3].id).toBe('vacation');
  });

  it('Support is last', () => {
    expect(GROUP_BELLAHEALTH[4].id).toBe('support');
  });
});

describe('GROUP_PRESERVED — Learn and Club preserved for future use', () => {
  it('Learn code is preserved in GROUP_PRESERVED', () => {
    expect(GROUP_PRESERVED.find((i) => i.id === 'learn')).toBeDefined();
  });

  it('BellaHealth Club code is preserved in GROUP_PRESERVED', () => {
    expect(GROUP_PRESERVED.find((i) => i.id === 'club')).toBeDefined();
  });

  it('ScreenSights is NOT in GROUP_PRESERVED (it is back in the active menu)', () => {
    expect(GROUP_PRESERVED.find((i) => i.id === 'screensights')).toBeUndefined();
  });
});

// ─── BellaHealth+ action mapping (navigation chain regression) ────────────────
//
// WHY THE PREVIOUS TEST WAS INSUFFICIENT:
// The original "BellaHealth+ navigation" tests only checked:
//   - SUBSCRIPTION_READY === false
//   - subscribe() returns {success:false}
//   - restorePurchases() returns false
//
// Those tests verify that the subscription SERVICE is dormant. They say nothing
// about whether tapping the BellaHealth+ row actually opens the Coming Soon
// preview. The old PaywallModal masked the silent Modal-presentation failure
// by calling Alert.alert("Coming Soon") — an Alert is independent of the Modal
// hierarchy and appears regardless. The new PaywallModal removed that Alert,
// so the silent failure became "nothing happens."
//
// These tests verify the ACTUAL decision-making path: given a menu item, does
// resolveMenuAction return the correct action? This is the deterministic logic
// that MenuModal.handleItemPress is built from. If resolveMenuAction returns
// 'paywall' for the subscription item, the component sets showPaywall=true,
// which mounts <PaywallModal visible> — the reliable pattern.

describe('resolveMenuAction — BellaHealth+ opens Coming Soon preview', () => {
  it('BellaHealth+ item (id=subscription) resolves to "paywall" action', () => {
    const item = GROUP_BELLAHEALTH.find((i) => i.id === 'subscription')!;
    expect(resolveMenuAction(item)).toBe('paywall');
  });

  it('only the subscription item resolves to "paywall" — no other active items trigger it', () => {
    const paywallItems = GROUP_BELLAHEALTH.filter((i) => resolveMenuAction(i) === 'paywall');
    expect(paywallItems).toHaveLength(1);
    expect(paywallItems[0].id).toBe('subscription');
  });
});

describe('resolveMenuAction — other menu items navigate correctly', () => {
  it('Chat resolves to "navigate"', () => {
    const item = GROUP_BELLAHEALTH.find((i) => i.id === 'chat')!;
    expect(resolveMenuAction(item)).toBe('navigate');
  });

  it('Travel Mode resolves to "navigate"', () => {
    const item = GROUP_BELLAHEALTH.find((i) => i.id === 'vacation')!;
    expect(resolveMenuAction(item)).toBe('navigate');
  });

  it('Support resolves to "navigate"', () => {
    const item = GROUP_BELLAHEALTH.find((i) => i.id === 'support')!;
    expect(resolveMenuAction(item)).toBe('navigate');
  });

  it('ScreenSights (active soon item) resolves to "soon"', () => {
    const item = GROUP_BELLAHEALTH.find((i) => i.id === 'screensights')!;
    expect(resolveMenuAction(item)).toBe('soon');
  });
});

describe('resolveMenuAction — BellaHealth+ resolves to paywall even though soon:true', () => {
  it('subscription id is checked before soon flag — always resolves to "paywall"', () => {
    const item = GROUP_BELLAHEALTH.find((i) => i.id === 'subscription')!;
    expect(item.soon).toBe(true);           // has the soon tag (visual)
    expect(resolveMenuAction(item)).toBe('paywall'); // but still opens preview
  });
});

describe('resolveMenuAction — exhaustive: only ScreenSights resolves to "soon" in active menu', () => {
  it('exactly one active item resolves to "soon" (ScreenSights)', () => {
    const soonActions = GROUP_BELLAHEALTH.filter((i) => resolveMenuAction(i) === 'soon');
    expect(soonActions).toHaveLength(1);
    expect(soonActions[0].id).toBe('screensights');
  });
});

// ─── No payment functionality introduced ──────────────────────────────────────

describe('subscription service — no payment functionality', () => {
  it('SUBSCRIPTION_READY is false — purchasing is not active', () => {
    expect(SUBSCRIPTION_READY).toBe(false);
  });

  it('subscribe() returns success:false when not configured', async () => {
    const result = await subscribe();
    expect(result.success).toBe(false);
  });

  it('restorePurchases() returns false when not configured', async () => {
    const restored = await restorePurchases();
    expect(restored).toBe(false);
  });
});
