import { addBillingCycle, monthKey, scheduledOccurrences, startOfUtcMonth } from './billing.js';
import type { SubscriptionRow } from './db/schema.js';

export interface TrendPoint {
  month: string;
  scheduledAmount: string;
  renewalCount: number;
}

export interface CurrencyTrend {
  currency: string;
  points: TrendPoint[];
}

const money = (value: number) => (Math.round(value * 100) / 100).toFixed(2);

export function monthlyContribution(sub: Pick<SubscriptionRow, 'cost' | 'billingCycle'>): number {
  return sub.billingCycle === 'yearly' ? sub.cost / 12 : sub.cost;
}

export function buildSpendTrend(
  subscriptions: SubscriptionRow[],
  months: number,
  now = new Date(),
): CurrencyTrend[] {
  const start = startOfUtcMonth(now);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + months);
  const monthKeys = Array.from({ length: months }, (_, index) => {
    const date = new Date(start);
    date.setUTCMonth(date.getUTCMonth() + index);
    return monthKey(date);
  });

  const grouped = new Map<string, Map<string, { amount: number; count: number }>>();
  for (const sub of subscriptions.filter((item) => item.status === 'active')) {
    const points = grouped.get(sub.currency) ?? new Map();
    grouped.set(sub.currency, points);
    for (const occurrence of scheduledOccurrences(sub, start, end)) {
      const key = monthKey(occurrence);
      const point = points.get(key) ?? { amount: 0, count: 0 };
      point.amount += sub.cost;
      point.count += 1;
      points.set(key, point);
    }
  }

  return [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, values]) => ({
      currency,
      points: monthKeys.map((month) => {
        const point = values.get(month) ?? { amount: 0, count: 0 };
        return {
          month,
          scheduledAmount: money(point.amount),
          renewalCount: point.count,
        };
      }),
    }));
}

export function buildOverview(subscriptions: SubscriptionRow[], now = new Date()) {
  const active = subscriptions.filter((item) => item.status === 'active');
  const currentStart = startOfUtcMonth(now);
  const nextStart = addBillingCycle(currentStart, 'monthly');
  const previousStart = addBillingCycle(currentStart, 'monthly', -1);
  const grouped = new Map<string, SubscriptionRow[]>();

  for (const sub of active) {
    const items = grouped.get(sub.currency) ?? [];
    items.push(sub);
    grouped.set(sub.currency, items);
  }

  return {
    asOf: now.toISOString(),
    currencies: [...grouped.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, items]) => {
        const monthly = items.reduce((sum, item) => sum + monthlyContribution(item), 0);
        const current = items.reduce(
          (sum, item) =>
            sum +
            scheduledOccurrences(item, currentStart, nextStart).reduce(
              (itemSum) => itemSum + item.cost,
              0,
            ),
          0,
        );
        const previous = items.reduce(
          (sum, item) =>
            sum +
            scheduledOccurrences(item, previousStart, currentStart).reduce(
              (itemSum) => itemSum + item.cost,
              0,
            ),
          0,
        );
        const categoryTotals = new Map<string, number>();
        for (const item of items) {
          const category = item.category || 'Other';
          categoryTotals.set(
            category,
            (categoryTotals.get(category) ?? 0) + monthlyContribution(item),
          );
        }

        return {
          currency,
          monthlyCommitment: money(monthly),
          annualRunRate: money(monthly * 12),
          activeCount: items.length,
          currentMonthScheduled: money(current),
          previousMonthScheduled: money(previous),
          changePercent: previous === 0 ? null : money(((current - previous) / previous) * 100),
          byCategory: [...categoryTotals.entries()]
            .map(([category, amount]) => ({
              category,
              monthlyCommitment: money(amount),
              percentage: monthly === 0 ? '0.00' : money((amount / monthly) * 100),
            }))
            .sort(
              (a, b) => Number(b.monthlyCommitment) - Number(a.monthlyCommitment),
            ),
        };
      }),
  };
}
