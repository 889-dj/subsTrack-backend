/**
 * Shared domain constants mirroring the mobile client (`src/types.ts` in the
 * subsTrack app). The app can also refresh these at runtime via GET /v1/meta.
 */

export const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD', 'CAD', 'JPY'] as const;

export const BILLING_CYCLES = ['monthly', 'yearly'] as const;

export const CATEGORIES = [
  'Entertainment',
  'Music',
  'Software',
  'Cloud & Storage',
  'News & Reading',
  'Fitness',
  'Food & Delivery',
  'Utilities',
  'Other',
] as const;

export const SUBSCRIPTION_STATUSES = ['active', 'paused', 'cancelled'] as const;

export const API_VERSION = '1.0.0';
