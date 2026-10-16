/**
 * BellaHealth+ Subscription Service
 *
 * Currently a STUB — subscription flow is designed but not yet live.
 * Set SUBSCRIPTION_READY = true once the checklist below is complete.
 *
 * OWNER ACTIVATION CHECKLIST:
 *  1. Create a recurring subscription product in App Store Connect:
 *       Product ID : com.isabellafugaro.BellaHealth.plus_yearly
 *       Price      : $9.99/year
 *       Reference name: BellaHealth+ Annual
 *  2. Create a RevenueCat account at app.revenuecat.com and add this app.
 *  3. Link App Store Connect to RevenueCat (follow RevenueCat docs).
 *  4. Add the RevenueCat Apple public API key to EAS env vars:
 *       EXPO_PUBLIC_REVENUECAT_API_KEY = <appl_xxxx>
 *  5. Run: npx expo install react-native-purchases
 *  6. Set SUBSCRIPTION_READY = true below.
 *  7. Uncomment the Purchases import and real implementation blocks.
 *  8. Trigger a new EAS production build.
 */

// import Purchases, { LOG_LEVEL, PurchasesPackage } from 'react-native-purchases';

export const SUBSCRIPTION_READY = false;

export const PRODUCT_ID        = 'com.isabellafugaro.BellaHealth.plus_yearly';
export const SUBSCRIPTION_PRICE = '$9.99';
export const SUBSCRIPTION_PERIOD = 'per year';

export type SubscriptionStatus = 'active' | 'inactive' | 'unknown';

/**
 * Call once at app startup when SUBSCRIPTION_READY = true:
 *   import { initSubscription } from '@/services/subscription';
 *   await initSubscription();
 */
export async function initSubscription(): Promise<void> {
  if (!SUBSCRIPTION_READY) return;
  // const apiKey = process.env.EXPO_PUBLIC_REVENUECAT_API_KEY ?? '';
  // if (!apiKey) return;
  // Purchases.setLogLevel(LOG_LEVEL.ERROR);
  // Purchases.configure({ apiKey });
}

/** Returns true if the user has an active BellaHealth+ subscription. */
export async function checkSubscription(): Promise<boolean> {
  if (!SUBSCRIPTION_READY) return false;
  try {
    // const info = await Purchases.getCustomerInfo();
    // return Object.keys(info.entitlements.active).length > 0;
    return false;
  } catch {
    return false;
  }
}

/** Initiates the App Store purchase flow. */
export async function subscribe(): Promise<{ success: boolean; error?: string }> {
  if (!SUBSCRIPTION_READY) {
    return { success: false, error: 'not_configured' };
  }
  try {
    // const offerings = await Purchases.getOfferings();
    // const pkg = offerings.current?.availablePackages[0];
    // if (!pkg) return { success: false, error: 'no_product' };
    // const { customerInfo } = await Purchases.purchasePackage(pkg);
    // return { success: Object.keys(customerInfo.entitlements.active).length > 0 };
    return { success: false, error: 'not_configured' };
  } catch (e: any) {
    if (e?.userCancelled) return { success: false, error: 'cancelled' };
    return { success: false, error: 'purchase_failed' };
  }
}

/** Restores previous purchases (required by App Store guidelines). */
export async function restorePurchases(): Promise<boolean> {
  if (!SUBSCRIPTION_READY) return false;
  try {
    // const info = await Purchases.restorePurchases();
    // return Object.keys(info.entitlements.active).length > 0;
    return false;
  } catch {
    return false;
  }
}
