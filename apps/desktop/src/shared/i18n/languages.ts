export interface InterfaceLanguage {
  readonly tag: string;
  readonly name: string;
  readonly gameLanguage: string | null;
}

export const interfaceLanguages: readonly InterfaceLanguage[] = Object.freeze([
  { tag: 'en', name: 'English', gameLanguage: 'en' },
  { tag: 'de', name: 'Deutsch', gameLanguage: 'de' },
  { tag: 'fr', name: 'Français', gameLanguage: 'fr' },
  { tag: 'es', name: 'Español (España)', gameLanguage: 'es' },
  { tag: 'es-MX', name: 'Español (México)', gameLanguage: 'mx' },
  { tag: 'it', name: 'Italiano', gameLanguage: 'it' },
  { tag: 'pt-BR', name: 'Português (Brasil)', gameLanguage: 'br' },
  { tag: 'ru', name: 'Русский', gameLanguage: 'ru' },
  { tag: 'pl', name: 'Polski', gameLanguage: 'pl' },
  { tag: 'tr', name: 'Türkçe', gameLanguage: 'tr' },
  { tag: 'zh-Hans', name: '简体中文', gameLanguage: 'zh' },
  { tag: 'zh-Hant', name: '繁體中文', gameLanguage: 'tw' },
  { tag: 'ja', name: '日本語', gameLanguage: 'jp' },
  { tag: 'ko', name: '한국어', gameLanguage: 'ko' },
  { tag: 'vi', name: 'Tiếng Việt', gameLanguage: 'vi' },
  { tag: 'ms', name: 'Bahasa Melayu', gameLanguage: 'ms' },
  { tag: 'hi', name: 'हिन्दी', gameLanguage: 'hi' },
  { tag: 'uk', name: 'Українська', gameLanguage: null },
  { tag: 'cs', name: 'Čeština', gameLanguage: null },
  { tag: 'nl', name: 'Nederlands', gameLanguage: null },
]);

export function interfaceLanguage(tag: string): InterfaceLanguage | null {
  return interfaceLanguages.find((language) => language.tag === tag) ?? null;
}

export function gameLanguageFor(tag: string): string {
  return interfaceLanguage(tag)?.gameLanguage ?? 'en';
}
