import type { SubscriptionRow } from './db/schema.js';

/**
 * Calendar-safe subscription arithmetic. A month is not 30 days and a year
 * is not 365 days. Calculations use UTC because PostgreSQL returns absolute
 * instants; the app stores renewal selections at a stable local time.
 */

const ITERATION_CAP = 600;

export type BillingCycle = SubscriptionRow['billingCycle'];

export function addBillingCycles(
  input: Date,
  cycle: BillingCycle,
  count: number,
): Date {
  const result = new Date(input);
  const originalDay = result.getUTCDate();
  const months = (cycle === 'yearly' ? 12 : 1) * count;

  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(originalDay, lastDay));
  return result;
}

export function addBillingCycle(
  input: Date,
  cycle: BillingCycle,
  direction: 1 | -1 = 1,
): Date {
  return addBillingCycles(input, cycle, direction);
}

export function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function startOfUtcMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

export function scheduledOccurrences(
  sub: Pick<SubscriptionRow, 'nextRenewalDate' | 'billingCycle'>,
  startInclusive: Date,
  endExclusive: Date,
): Date[] {
  const anchor = new Date(sub.nextRenewalDate);
  let step = 0;
  let renewal = new Date(anchor);
  let guard = 0;

  while (renewal >= endExclusive && guard < ITERATION_CAP) {
    step -= 1;
    renewal = addBillingCycles(anchor, sub.billingCycle, step);
    guard += 1;
  }
  while (renewal < startInclusive && guard < ITERATION_CAP) {
    step += 1;
    renewal = addBillingCycles(anchor, sub.billingCycle, step);
    guard += 1;
  }

  const occurrences: Date[] = [];
  while (renewal < endExclusive && guard < ITERATION_CAP) {
    if (renewal >= startInclusive) occurrences.push(new Date(renewal));
    step += 1;
    renewal = addBillingCycles(anchor, sub.billingCycle, step);
    guard += 1;
  }
  return occurrences;
}

export function chargeTimestamps(sub: {
  createdAt: Date;
  nextRenewalDate: Date;
  billingCycle: BillingCycle;
}): number[] {
  return scheduledOccurrences(sub, sub.createdAt, new Date(Date.now() + 1)).map(
    (date) => date.getTime(),
  );
}
