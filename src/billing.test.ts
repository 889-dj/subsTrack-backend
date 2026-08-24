import assert from 'node:assert/strict';
import test from 'node:test';
import { addBillingCycles, scheduledOccurrences } from './billing.js';

test('monthly calendar arithmetic preserves a month-end anchor', () => {
  const anchor = new Date('2024-01-31T12:00:00.000Z');
  assert.equal(addBillingCycles(anchor, 'monthly', 1).toISOString(), '2024-02-29T12:00:00.000Z');
  assert.equal(addBillingCycles(anchor, 'monthly', 2).toISOString(), '2024-03-31T12:00:00.000Z');
});

test('yearly arithmetic handles leap day deterministically', () => {
  const anchor = new Date('2024-02-29T09:30:00.000Z');
  assert.equal(addBillingCycles(anchor, 'yearly', 1).toISOString(), '2025-02-28T09:30:00.000Z');
  assert.equal(addBillingCycles(anchor, 'yearly', 4).toISOString(), '2028-02-29T09:30:00.000Z');
});

test('scheduled occurrences use calendar cadence instead of 30-day intervals', () => {
  const occurrences = scheduledOccurrences(
    { nextRenewalDate: new Date('2024-01-31T12:00:00.000Z'), billingCycle: 'monthly' },
    new Date('2024-01-01T00:00:00.000Z'),
    new Date('2024-04-01T00:00:00.000Z'),
  );
  assert.deepEqual(
    occurrences.map((date) => date.toISOString()),
    [
      '2024-01-31T12:00:00.000Z',
      '2024-02-29T12:00:00.000Z',
      '2024-03-31T12:00:00.000Z',
    ],
  );
});
