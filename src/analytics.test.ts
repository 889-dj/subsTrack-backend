import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOverview, buildSpendTrend } from './analytics.js';
import type { SubscriptionRow } from './db/schema.js';

function subscription(overrides: Partial<SubscriptionRow>): SubscriptionRow {
  return {
    id: crypto.randomUUID(),
    userId: 'user_test',
    name: 'Example',
    cost: 100,
    currency: 'INR',
    billingCycle: 'monthly',
    nextRenewalDate: new Date('2026-08-15T12:00:00.000Z'),
    category: 'Software',
    source: null,
    plan: null,
    note: null,
    status: 'active',
    createdAt: new Date('2026-01-01T12:00:00.000Z'),
    updatedAt: new Date('2026-01-01T12:00:00.000Z'),
    ...overrides,
  };
}

test('trend data never combines different currencies', () => {
  const result = buildSpendTrend(
    [
      subscription({ currency: 'INR', cost: 500 }),
      subscription({ currency: 'USD', cost: 20 }),
    ],
    1,
    new Date('2026-08-01T00:00:00.000Z'),
  );
  assert.deepEqual(result.map((series) => series.currency), ['INR', 'USD']);
  assert.equal(result[0]?.points[0]?.scheduledAmount, '500.00');
  assert.equal(result[1]?.points[0]?.scheduledAmount, '20.00');
});

test('paused subscriptions are excluded from totals and forecasts', () => {
  const active = subscription({ cost: 120 });
  const paused = subscription({ cost: 900, status: 'paused' });
  const overview = buildOverview([active, paused], new Date('2026-08-01T00:00:00.000Z'));
  assert.equal(overview.currencies[0]?.monthlyCommitment, '120.00');
  assert.equal(overview.currencies[0]?.activeCount, 1);
});

test('month-over-month change is neutral when the previous month is zero', () => {
  const yearly = subscription({
    billingCycle: 'yearly',
    cost: 1_200,
    nextRenewalDate: new Date('2026-08-15T12:00:00.000Z'),
  });
  const overview = buildOverview([yearly], new Date('2026-08-01T00:00:00.000Z'));
  assert.equal(overview.currencies[0]?.currentMonthScheduled, '1200.00');
  assert.equal(overview.currencies[0]?.previousMonthScheduled, '0.00');
  assert.equal(overview.currencies[0]?.changePercent, null);
});
