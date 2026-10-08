import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { LanguagePreference, LocaleState } from '../shared/i18n/locale';
import { setActiveLocale, type Translator } from '../shared/i18n/translator';

interface I18nContextValue {
  state: LocaleState;
  translator: Translator;
  t: Translator['t'];
  setPreference(preference: LanguagePreference): Promise<void>;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export const englishLocaleState: LocaleState = {
  preference: 'system',
  locale: 'en',
  direction: 'ltr',
  systemLocale: 'en',
  languages: [{ tag: 'en', name: 'English', direction: 'ltr', pseudo: false }],
};

export function applyLocaleState(state: LocaleState): Translator {
  const translator = setActiveLocale(state.locale);
  document.documentElement.lang = translator.locale;
  document.documentElement.dir = translator.direction;
  return translator;
}

export function I18nProvider({ initial, children }: { initial: LocaleState; children: ReactNode }) {
  const [state, setState] = useState(initial);
  useEffect(
    () =>
      window.rmside.onLocaleChanged((next) => {
        applyLocaleState(next);
        setState(next);
      }),
    [],
  );
  const setPreference = useCallback(async (preference: LanguagePreference) => {
    const next = await window.rmside.setLanguagePreference(preference);
    applyLocaleState(next);
    setState(next);
  }, []);
  const value = useMemo<I18nContextValue>(() => {
    const translator = setActiveLocale(state.locale);
    return { state, translator, t: (id, args) => translator.t(id, args), setPreference };
  }, [setPreference, state]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n needs an I18nProvider');
  return value;
}
