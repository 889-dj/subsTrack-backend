import { env } from './config.js';

/**
 * Aliases for names that don't reduce to their real domain by stripping
 * punctuation (brand name != registrable domain, or the user typed a plan
 * variant like "Netflix Premium"). Sorted by length at lookup time so a
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

/** Best-effort guess at the registrable domain for a free-form subscription name. */
export function deriveDomain(name: string): string | undefined {
  const key = name.trim().toLowerCase();
  if (!key) return undefined;

  const alias = KNOWN_ALIASES.find((candidate) => key.includes(candidate));
  if (alias) return KNOWN_DOMAINS[alias];

  const slug = key.replace(/\+/g, 'plus').replace(/[^a-z0-9]+/g, '');
  return slug ? `${slug}.com` : undefined;
}

/**
 * Logo image URL for a subscription name, or undefined when no domain could
 * be guessed. Uses logo.dev (Clearbit's official successor) when a
 * publishable token is configured, falling back to Google's key-free favicon
 * service — lower resolution, but always available with zero setup.
 */
export function buildLogoUrl(name: string): string | undefined {
  const domain = deriveDomain(name);
  if (!domain) return undefined;

  if (env.LOGO_DEV_TOKEN) {
    return `https://img.logo.dev/${domain}?token=${env.LOGO_DEV_TOKEN}&size=128&format=png`;
  }
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
}
