/**
 * Currency conversion for the "combined total" on /v1/analytics/overview —
 * frankfurter.app (ECB daily reference rates, free, no key, no signup).
 * Per-currency exact totals in `currencies[]` are never touched; this only
 * feeds a separate, clearly-labelled approximate combined figure.
 */

// frankfurter.app moved to frankfurter.dev in 2026 — the old host 301s here,
// but hitting the canonical URL directly avoids a redirect on every request.
const FRANKFURTER_URL = 'https://api.frankfurter.dev/v1/latest';
// ECB publishes once a day — no point re-fetching more often than that.
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

interface RateSet {
  base: string;
  date: string;
  rates: Record<string, number>;
  expiresAt: number;
}

let cache: RateSet | undefined;

async function fetchRates(base: string, symbols: string[]): Promise<{ date: string; rates: Record<string, number> } | undefined> {
  if (symbols.length === 0) return { date: new Date().toISOString().slice(0, 10), rates: {} };

  if (
    cache &&
    cache.base === base &&
    cache.expiresAt > Date.now() &&
    symbols.every((symbol) => symbol in cache!.rates)
  ) {
    return { date: cache.date, rates: cache.rates };
  }

  try {
    const url = `${FRANKFURTER_URL}?from=${encodeURIComponent(base)}&to=${symbols.map(encodeURIComponent).join(',')}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6_000) });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { date: string; rates: Record<string, number> };
    cache = { base, date: data.date, rates: data.rates, expiresAt: Date.now() + CACHE_TTL_MS };
    return { date: data.date, rates: data.rates };
  } catch {
    return undefined;
  }
}

/**
 * Converts a list of (currency, amount) pairs into one target currency and
 * sums them. Returns undefined on any failure — a missing symbol or a dead
 * API means the caller should fall back to showing currencies separately
 * rather than silently under- or over-reporting a combined total.
 */
export async function convertToCurrency(
  amounts: { currency: string; amount: number }[],
  target: string,
): Promise<{ total: number; ratesAsOf: string } | undefined> {
  const others = [...new Set(amounts.map((a) => a.currency).filter((c) => c !== target))];
  const fx = await fetchRates(target, others);
  if (!fx) return undefined;

  let total = 0;
  for (const { currency, amount } of amounts) {
    if (currency === target) {
      total += amount;
      continue;
    }
    // fx.rates[currency] is "1 target = X currency"; invert to get target terms.
    const rate = fx.rates[currency];
    if (!rate) return undefined;
    total += amount / rate;
  }
  return { total, ratesAsOf: fx.date };
}
