// ─── Allowed observation/correlation language ──────────────────────────────────
// Use these when surfacing patterns in insights, AI prompts, or UI copy.
// Language centers on "your health / your context / your patterns" — not on
// the brand as an actor ("Bella noticed", "Bella thinks" are PROHIBITED).

export const CORRELATION_LANGUAGE = {
  TENDS_TO:              'tends to',
  COINCIDED_WITH:        'coincided with',
  ASSOCIATED_WITH:       'associated with',
  OFTEN_FOLLOWS:         'often follows',
  HAS_TRACKED_WITH:      'has tracked with',
  ON_DAYS_WITH:          'on days with',
  AFTER:                 'after',
  FOLLOWING:             'following',
  YOUR_DATA_SHOWS:       'your data shows',
  YOUR_PATTERNS_SUGGEST: 'your patterns suggest',
  WORTH_NOTING:          'worth noting',
} as const;

// ─── Brand / product language ──────────────────────────────────────────────────
// Always attribute findings to the user's data, never to the app as a persona.

export const PRODUCT_LANGUAGE = {
  APP_NAME:             'BellaHealth',
  DATA_ATTRIBUTION:     'your data',
  PATTERN_ATTRIBUTION:  'your patterns',
  CONTEXT_ATTRIBUTION:  'your context',
  BASELINE_ATTRIBUTION: 'your baseline',
} as const;

// ─── Prohibited causal language ────────────────────────────────────────────────
// These phrases must never appear in generated insights, AI system prompts,
// or UI copy. Used as a review reference — not enforced at runtime.

export const PROHIBITED_CAUSAL_LANGUAGE: readonly string[] = [
  'caused',
  'causes',
  'because of',
  'resulted in',
  'results in',
  'led to',
  'leads to',
  'proves',
  'confirms that',
  'definitely',
  'always',
  'never',
  'guarantees',
] as const;
