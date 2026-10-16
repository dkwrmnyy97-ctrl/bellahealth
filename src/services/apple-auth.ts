/**
 * apple-auth.ts
 *
 * Native Sign in with Apple via expo-apple-authentication.
 * Integrates with the existing Supabase anonymous session in auth.ts.
 *
 * Sign-in outcomes:
 *   'linked'    — anonymous user upgraded to Apple account; UID preserved.
 *   'resumed'   — returning Apple user; existing Apple session resumed.
 *   'collision' — Apple ID was already bound to a *different* BellaHealth
 *                 account; the returned uid is the Apple account's uid.
 *   'new'       — no prior session at all; Apple account created fresh.
 *
 * Nonce flow (prevents replay attacks):
 *   1. Generate a random UUID as rawNonce.
 *   2. SHA-256 hash it → hashedNonce.
 *   3. Send hashedNonce to Apple (embedded in the identity token).
 *   4. Send rawNonce to Supabase (Supabase verifies hash matches token).
 */

import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';

import { supabase } from '@/services/auth';

// ─── Types ────────────────────────────────────────────────────────────────────

export type AppleSignInOutcome = 'linked' | 'resumed' | 'collision' | 'new';

export type AppleSignInResult =
  | { ok: true;  uid: string; outcome: AppleSignInOutcome }
  | { ok: false; error: 'cancelled' | 'unavailable' | string };

// ─── Nonce ────────────────────────────────────────────────────────────────────

/**
 * Generates a one-time nonce pair for Apple Sign In.
 * Exported for unit testing; do not use outside of apple-auth.ts and its tests.
 */
export async function generateNonce(): Promise<{ rawNonce: string; hashedNonce: string }> {
  const rawNonce = Crypto.randomUUID();
  const hashedNonce = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    rawNonce,
  );
  return { rawNonce, hashedNonce };
}

// ─── Core sign-in ─────────────────────────────────────────────────────────────

/**
 * Signs in with Apple.  Safe to call whether or not a Supabase session exists.
 *
 * On first call from an anonymous session: Supabase upgrades the anonymous
 * account to a full Apple-backed account while preserving the uid.
 *
 * On subsequent calls: Supabase resumes the existing Apple session.
 */
export async function signInWithApple(): Promise<AppleSignInResult> {
  try {
    const available = await AppleAuthentication.isAvailableAsync();
    if (!available) {
      return { ok: false, error: 'unavailable' };
    }

    // Record uid before — null means no prior session
    const { data: { session: sessionBefore } } = await supabase.auth.getSession();
    const uidBefore = sessionBefore?.user?.id ?? null;

    const { rawNonce, hashedNonce } = await generateNonce();

    const credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
      nonce: hashedNonce,
    });

    if (!credential.identityToken) {
      return { ok: false, error: 'Apple did not return an identity token.' };
    }

    const { data, error } = await supabase.auth.signInWithIdToken({
      provider: 'apple',
      token: credential.identityToken,
      nonce: rawNonce,
    });

    if (error || !data.session) {
      return { ok: false, error: error?.message ?? 'Supabase sign-in failed.' };
    }

    // Fire-and-forget: exchange Apple's one-time authorizationCode server-side.
    // The Edge Function stores the resulting refresh_token in private.apple_tokens
    // for use at account-deletion time. Never blocks sign-in; never logs the code.
    if (credential.authorizationCode) {
      supabase.functions
        .invoke('exchange-apple-code', {
          body: { authorizationCode: credential.authorizationCode },
        })
        .catch(() => {
          console.error('[apple-auth] exchange-apple-code call failed (non-blocking)');
        });
    }

    const uidAfter = data.session.user.id;
    const outcome = classifyOutcome(uidBefore, uidAfter);

    return { ok: true, uid: uidAfter, outcome };

  } catch (err: unknown) {
    if (isAppleCancelError(err)) {
      return { ok: false, error: 'cancelled' };
    }
    return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

// ─── Identity check ───────────────────────────────────────────────────────────

/**
 * Returns true if the current session is backed by Apple Sign In.
 * Use this to decide whether to show "Sign in with Apple" vs "Already signed in".
 */
export async function isAppleLinked(): Promise<boolean> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    return (session?.user?.identities ?? []).some((id) => id.provider === 'apple');
  } catch {
    return false;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function classifyOutcome(
  uidBefore: string | null,
  uidAfter: string,
): AppleSignInOutcome {
  if (uidBefore === null)     return 'new';
  if (uidBefore === uidAfter) return 'linked';   // also covers 'resumed' — same uid
  return 'collision';
}

function isAppleCancelError(err: unknown): boolean {
  if (err instanceof Error) {
    const code = (err as Error & { code?: string }).code;
    return code === 'ERR_REQUEST_CANCELED';
  }
  return false;
}
