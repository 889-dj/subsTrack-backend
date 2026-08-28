import { env } from './config.js';

/**
 * Aliases for names that don't reduce to their real domain by stripping
 * punctuation (brand name != registrable domain, or the user typed a plan
 * variant like "Netflix Premium"). Checked first — free and instant — before
 * falling back to a live name lookup. Sorted by length at lookup time so a
 * longer alias ("prime video") wins over a shorter one it contains ("prime").
 */
const KNOWN_DOMAINS: Record<string, string> = {
  netflix: 'netflix.com',
  spotify: 'spotify.com',
  'amazon prime': 'amazon.com',
  'prime video': 'primevideo.com',
  // Bare "Prime" is ambiguous (shopping membership vs. the streaming app),
  // but in a subscription tracker it almost always means Prime Video.
  prime: 'primevideo.com',
  'disney+': 'disneyplus.com',
  disneyplus: 'disneyplus.com',
  'youtube premium': 'youtube.com',
  'youtube music': 'youtube.com',
  youtube: 'youtube.com',
  'apple music': 'apple.com',
  'apple tv+': 'apple.com',
  'apple tv': 'apple.com',
  'apple one': 'apple.com',
  'icloud+': 'apple.com',
  icloud: 'apple.com',
  hulu: 'hulu.com',
  'hbo max': 'max.com',
  max: 'max.com',
  'paramount+': 'paramountplus.com',
  peacock: 'peacocktv.com',
  'adobe creative cloud': 'adobe.com',
  adobe: 'adobe.com',
  'microsoft 365': 'microsoft.com',
  'office 365': 'microsoft.com',
  'google one': 'google.com',
  'google workspace': 'google.com',
  dropbox: 'dropbox.com',
  notion: 'notion.so',
  slack: 'slack.com',
  zoom: 'zoom.us',
  github: 'github.com',
  'chatgpt plus': 'openai.com',
  chatgpt: 'openai.com',
  openai: 'openai.com',
  'playstation plus': 'playstation.com',
  'xbox game pass': 'xbox.com',
  'xbox live': 'xbox.com',
  audible: 'audible.com',
  duolingo: 'duolingo.com',
  canva: 'canva.com',
  figma: 'figma.com',
  linkedin: 'linkedin.com',
  nordvpn: 'nordvpn.com',
  expressvpn: 'expressvpn.com',
  twitch: 'twitch.tv',
  crunchyroll: 'crunchyroll.com',
};

const KNOWN_ALIASES = Object.keys(KNOWN_DOMAINS).sort((a, b) => b.length - a.length);

/** Checks the curated alias table only — no network, no fallback guess. */
function knownDomain(name: string): string | undefined {
  const key = name.trim().toLowerCase();
  if (!key) return undefined;
  const alias = KNOWN_ALIASES.find((candidate) => key.includes(candidate));
  return alias ? KNOWN_DOMAINS[alias] : undefined;
}

/** Last-resort guess when nothing else resolved: strip punctuation, add .com. */
function guessDomain(name: string): string | undefined {
  const key = name.trim().toLowerCase();
  if (!key) return undefined;
  const slug = key.replace(/\+/g, 'plus').replace(/[^a-z0-9]+/g, '');
  return slug ? `${slug}.com` : undefined;
}

/**
 * Live company-name-to-domain lookup for names outside the curated table —
 * Clearbit's free, keyless Autocomplete API (still served independently of
 * their now-defunct Logo API). Best-effort: any failure or timeout resolves
 * to undefined so the caller falls back to guessDomain instead of blocking.
 */
async function lookupDomain(name: string): Promise<string | undefined> {
  const query = name.trim();
  if (!query) return undefined;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const res = await fetch(
      `https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(query)}`,
      { signal: controller.signal },
    );
    if (!res.ok) return undefined;
    const results = (await res.json()) as Array<{ domain?: string }>;
    return results[0]?.domain || undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

/** Best-effort domain for a free-form subscription name: known alias, then live lookup, then a guess. */
export async function deriveDomain(name: string): Promise<string | undefined> {
  return knownDomain(name) ?? (await lookupDomain(name)) ?? guessDomain(name);
}

/** Turns a resolved domain into an actual logo image URL. */
function logoUrlForDomain(domain: string): string {
  if (env.LOGO_DEV_TOKEN) {
    return `https://img.logo.dev/${domain}?token=${env.LOGO_DEV_TOKEN}&size=128&format=png`;
  }
  // Key-free fallback: lower resolution, but always available with zero setup.
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
}

/**
 * Resolves a subscription name straight to a logo image URL. Called once at
 * create/rename time and the result is stored on the row — see
 * src/routes/subscriptions.ts — so reads never pay for this lookup.
 */
export async function resolveLogoUrl(name: string): Promise<string | undefined> {
  const domain = await deriveDomain(name);
  return domain ? logoUrlForDomain(domain) : undefined;
}
