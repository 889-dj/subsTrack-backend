import crypto from 'node:crypto';
import { env } from './config.js';
import type { buildOverview } from './analytics.js';

export interface InsightsResult {
  insights: string[];
  generatedAt: string | null;
}

type Overview = ReturnType<typeof buildOverview>;

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Free-tier friendly: OpenRouter's no-cost models cap out around 200-1000
// requests/day account-wide, so a per-user result is reused for a while
// instead of re-calling the model on every Insights tab open. Keyed by a
// fingerprint of the underlying numbers (not wall-clock time) so an edited
// subscription still invalidates immediately even mid-TTL.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map<string, { fingerprint: string; result: InsightsResult; expiresAt: number }>();

const SYSTEM_PROMPT = `You are a terse financial assistant inside a subscription-tracking app.
You will receive a JSON summary of a user's active recurring subscriptions, grouped by currency,
with monthly totals, this-month vs last-month scheduled spend, and a category breakdown.

Reply with ONLY a JSON array of 2 to 4 short strings — no markdown, no code fences, no preamble.
Each string is one specific, concrete observation or suggestion a real person would find useful:
a category that dominates spend, a month-over-month jump, a currency worth consolidating, etc.
Keep each under 140 characters. Do not invent numbers that are not in the data. If the data is too
thin for a real observation, return fewer strings rather than a generic filler one.`;

function fingerprint(overview: Overview): string {
  return crypto.createHash('sha256').update(JSON.stringify(overview.currencies)).digest('hex');
}

function parseModelReply(raw: string): string[] {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map((item) => item.trim())
        .slice(0, 4);
    }
  } catch {
    // Fall through to line-based parsing below — the free model sometimes
    // ignores the "JSON only" instruction and replies with a bullet list.
  }

  return cleaned
    .split('\n')
    .map((line) => line.replace(/^[-*\d.)\s]+/, '').trim())
    .filter(Boolean)
    .slice(0, 4);
}

/** Calls OpenRouter for fresh insights. Any failure — missing key, timeout,
 * non-200, malformed reply — resolves to undefined rather than throwing, so
 * a flaky free model never breaks the request that asked for insights. */
async function requestInsights(overview: Overview): Promise<string[] | undefined> {
  if (!env.OPENROUTER_API_KEY) return undefined;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: env.OPENROUTER_MODEL,
        temperature: 0.4,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(overview.currencies) },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return undefined;

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return undefined;

    const insights = parseModelReply(content);
    return insights.length > 0 ? insights : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Per-user insights, cached until the underlying numbers change or the TTL
 * expires. `forceRefresh` bypasses the cache (e.g. a manual refresh) but
 * still writes the result back, so it doesn't compound rate-limit pressure.
 */
export async function getInsights(
  userId: string,
  overview: Overview,
  forceRefresh = false,
): Promise<InsightsResult> {
  const fp = fingerprint(overview);
  const cached = cache.get(userId);
  if (!forceRefresh && cached && cached.fingerprint === fp && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  const result: InsightsResult =
    overview.currencies.length === 0
      ? { insights: [], generatedAt: null }
      : await requestInsights(overview).then((insights) =>
          insights ? { insights, generatedAt: new Date().toISOString() } : { insights: [], generatedAt: null },
        );

  cache.set(userId, { fingerprint: fp, result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}
