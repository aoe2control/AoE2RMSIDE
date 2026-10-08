import {
  isLanguagePreference,
  resolveLocale,
  type LanguagePreference,
  type LocaleState,
  type PseudoLocaleTag,
} from '../shared/i18n/locale';
import { availableLanguages, setActiveLocale } from '../shared/i18n/translator';

export interface LocaleServiceOptions {
  systemLocales: () => readonly string[];
  developer: boolean;
  preference: LanguagePreference;
  pseudoOverride?: PseudoLocaleTag | null;
}

export class LocaleService {
  private readonly options: LocaleServiceOptions;
  private preference: LanguagePreference;
  private override: PseudoLocaleTag | null;
  private current: LocaleState;

  constructor(options: LocaleServiceOptions) {
    this.options = options;
    this.preference = isLanguagePreference(options.preference) ? options.preference : 'system';
    this.override = options.developer ? (options.pseudoOverride ?? null) : null;
    this.current = this.resolve();
  }

  state(): LocaleState {
    return this.current;
  }

  rememberedPreference(): LanguagePreference {
    return this.preference;
  }

  setPreference(preference: unknown): LocaleState {
    if (!isLanguagePreference(preference)) throw new Error('language preference is invalid');
    this.preference = preference;
    this.override = null;
    this.current = this.resolve();
    return this.current;
  }

  refresh(): LocaleState {
    this.current = this.resolve();
    return this.current;
  }

  private resolve(): LocaleState {
    const languages = availableLanguages({ pseudo: this.options.developer });
    let systemLocales: readonly string[] = [];
    try {
      systemLocales = this.options.systemLocales();
    } catch {}
    const preference = this.override ?? this.preference;
    const resolution = resolveLocale({
      preference,
      systemLocales,
      available: languages.map((language) => language.tag),
    });
    const translator = setActiveLocale(resolution.locale);
    return {
      preference: this.preference,
      locale: translator.locale,
      direction: translator.direction,
      systemLocale: resolution.systemLocale,
      languages,
    };
  }
}
