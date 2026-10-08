import { localeTagPattern, type TextDirection } from './message-format';

export type LanguagePreference = 'system' | string;

export const sourceLocale = 'en';

export const pseudoLocaleTags = ['en-XA', 'ar-XB'] as const;
export type PseudoLocaleTag = (typeof pseudoLocaleTags)[number];

export function isPseudoLocale(tag: string): tag is PseudoLocaleTag {
  return (pseudoLocaleTags as readonly string[]).includes(tag);
}

export interface LanguageOption {
  tag: string;
  name: string;
  direction: TextDirection;
  pseudo: boolean;
}

export interface LocaleState {
  preference: LanguagePreference;
  locale: string;
  direction: TextDirection;
  systemLocale: string;
  languages: LanguageOption[];
}

const maximumLanguages = 64;

export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return value === 'system' || (typeof value === 'string' && localeTagPattern.test(value));
}

export function validateLocaleState(value: unknown): LocaleState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  if (!isLanguagePreference(state.preference)) return null;
  if (typeof state.locale !== 'string' || !localeTagPattern.test(state.locale)) return null;
  if (typeof state.systemLocale !== 'string' || !localeTagPattern.test(state.systemLocale)) {
    return null;
  }
  if (state.direction !== 'ltr' && state.direction !== 'rtl') return null;
  if (!Array.isArray(state.languages) || state.languages.length > maximumLanguages) return null;
  const languages: LanguageOption[] = [];
  for (const entry of state.languages as unknown[]) {
    if (!entry || typeof entry !== 'object') return null;
    const option = entry as Record<string, unknown>;
    if (typeof option.tag !== 'string' || !localeTagPattern.test(option.tag)) return null;
    if (typeof option.name !== 'string' || option.name.length < 1 || option.name.length > 64) {
      return null;
    }
    if (option.direction !== 'ltr' && option.direction !== 'rtl') return null;
    if (typeof option.pseudo !== 'boolean') return null;
    languages.push({
      tag: option.tag,
      name: option.name,
      direction: option.direction,
      pseudo: option.pseudo,
    });
  }
  return {
    preference: state.preference,
    locale: state.locale,
    direction: state.direction,
    systemLocale: state.systemLocale,
    languages,
  };
}

const latinAmericanRegions = new Set([
  '419',
  'AR',
  'BO',
  'BR',
  'BZ',
  'CL',
  'CO',
  'CR',
  'CU',
  'DO',
  'EC',
  'GT',
  'HN',
  'MX',
  'NI',
  'PA',
  'PE',
  'PR',
  'PY',
  'SV',
  'US',
  'UY',
  'VE',
]);

interface ParsedLocale {
  tag: string;
  language: string;
  script: string;
  region: string;
  explicitRegion: boolean;
}

function parseLocale(tag: string): ParsedLocale | null {
  try {
    const locale = new Intl.Locale(tag);
    const maximized = locale.maximize();
    return {
      tag,
      language: maximized.language,
      script: maximized.script ?? '',
      region: maximized.region ?? '',
      explicitRegion: locale.region !== undefined,
    };
  } catch {
    return null;
  }
}

function regionGroup(language: string, region: string): string {
  return language === 'es' && latinAmericanRegions.has(region) ? '419' : region;
}

export function matchLocale(requested: string, available: readonly string[]): string | null {
  const exact = available.find((tag) => tag.toLowerCase() === requested.toLowerCase());
  if (exact) return exact;
  const wanted = parseLocale(requested);
  if (!wanted) return null;
  const candidates = available
    .map(parseLocale)
    .filter(
      (candidate): candidate is ParsedLocale =>
        candidate !== null &&
        candidate.language === wanted.language &&
        candidate.script === wanted.script,
    );
  if (candidates.length === 0) return null;
  const sameRegion = candidates.find((candidate) => candidate.region === wanted.region);
  if (sameRegion) return sameRegion.tag;
  const group = regionGroup(wanted.language, wanted.region);
  const sameGroup = candidates.find(
    (candidate) =>
      candidate.explicitRegion && regionGroup(candidate.language, candidate.region) === group,
  );
  if (sameGroup) return sameGroup.tag;
  return (candidates.find((candidate) => !candidate.explicitRegion) ?? candidates[0]!).tag;
}

export interface LocaleResolutionInput {
  preference: LanguagePreference;
  systemLocales: readonly string[];
  available: readonly string[];
}

export interface LocaleResolution {
  locale: string;
  systemLocale: string;
  source: 'preference' | 'system' | 'default';
}

export function resolveLocale(input: LocaleResolutionInput): LocaleResolution {
  const real = input.available.filter((tag) => !isPseudoLocale(tag));
  let systemLocale: string | null = null;
  for (const requested of input.systemLocales.slice(0, 16)) {
    systemLocale = matchLocale(requested, real);
    if (systemLocale) break;
  }
  const fallback = real.includes(sourceLocale) ? sourceLocale : (real[0] ?? sourceLocale);
  const system = systemLocale ?? fallback;
  if (input.preference !== 'system') {
    const chosen = matchLocale(input.preference, input.available);
    if (chosen) return { locale: chosen, systemLocale: system, source: 'preference' };
  }
  return { locale: system, systemLocale: system, source: systemLocale ? 'system' : 'default' };
}

export function parsePseudoLocaleOverride(value: string | undefined): PseudoLocaleTag | null {
  if (value === 'accented' || value === 'en-XA') return 'en-XA';
  if (value === 'rtl' || value === 'ar-XB') return 'ar-XB';
  return null;
}
