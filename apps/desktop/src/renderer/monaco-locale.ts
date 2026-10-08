export const monacoLanguages = Object.freeze([
  'cs',
  'de',
  'es',
  'fr',
  'it',
  'ja',
  'ko',
  'pl',
  'ru',
  'tr',
  'zh-cn',
  'zh-tw',
] as const);
export type MonacoLanguage = (typeof monacoLanguages)[number];

const monacoLanguageByLocale: Readonly<Record<string, MonacoLanguage>> = Object.freeze({
  cs: 'cs',
  de: 'de',
  es: 'es',
  'es-MX': 'es',
  fr: 'fr',
  it: 'it',
  ja: 'ja',
  ko: 'ko',
  pl: 'pl',
  ru: 'ru',
  tr: 'tr',
  'zh-Hans': 'zh-cn',
  'zh-Hant': 'zh-tw',
});

export function monacoLanguageFor(locale: string): MonacoLanguage | null {
  return Object.hasOwn(monacoLanguageByLocale, locale) ? monacoLanguageByLocale[locale]! : null;
}

export type MonacoMessageLoaders = Readonly<Record<MonacoLanguage, () => Promise<unknown>>>;

const bundledMonacoMessages: MonacoMessageLoaders = Object.freeze({
  cs: () => import('monaco-editor/nls/lang/cs.js'),
  de: () => import('monaco-editor/nls/lang/de.js'),
  es: () => import('monaco-editor/nls/lang/es.js'),
  fr: () => import('monaco-editor/nls/lang/fr.js'),
  it: () => import('monaco-editor/nls/lang/it.js'),
  ja: () => import('monaco-editor/nls/lang/ja.js'),
  ko: () => import('monaco-editor/nls/lang/ko.js'),
  pl: () => import('monaco-editor/nls/lang/pl.js'),
  ru: () => import('monaco-editor/nls/lang/ru.js'),
  tr: () => import('monaco-editor/nls/lang/tr.js'),
  'zh-cn': () => import('monaco-editor/nls/lang/zh-cn.js'),
  'zh-tw': () => import('monaco-editor/nls/lang/zh-tw.js'),
});

type MonacoMessageGlobals = typeof globalThis & {
  _VSCODE_NLS_MESSAGES?: unknown;
  _VSCODE_NLS_LANGUAGE?: unknown;
};

let started: Promise<MonacoLanguage | null> | null = null;
let startLanguage: MonacoLanguage | null = null;

export function loadMonacoMessages(
  locale: string,
  loaders: MonacoMessageLoaders = bundledMonacoMessages,
): Promise<MonacoLanguage | null> {
  started ??= load(locale, loaders).then((language) => (startLanguage = language));
  return started;
}

async function load(locale: string, loaders: MonacoMessageLoaders): Promise<MonacoLanguage | null> {
  const language = monacoLanguageFor(locale);
  if (language === null) return null;
  const scope = globalThis as MonacoMessageGlobals;
  try {
    await loaders[language]();
  } catch (error) {
    console.error(`Monaco's ${language} messages did not load; the editor stays in English`, error);
  }
  if (scope._VSCODE_NLS_LANGUAGE === language && Array.isArray(scope._VSCODE_NLS_MESSAGES)) {
    repairModifierKeyNames(scope._VSCODE_NLS_MESSAGES);
    return language;
  }
  delete scope._VSCODE_NLS_MESSAGES;
  delete scope._VSCODE_NLS_LANGUAGE;
  return null;
}

const bracketedModifierKey = /^<(Alt|Ctrl|Control|Shift|Windows|Super|Option|Command|Cmd|Meta)>$/u;

export function repairModifierKeyNames(messages: unknown[]): void {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (typeof message !== 'string') continue;
    const key = bracketedModifierKey.exec(message);
    if (key) messages[index] = key[1]!;
  }
}

export function monacoStartLanguage(): MonacoLanguage | null {
  return startLanguage;
}

export function monacoWordsChangeAtNextStart(locale: string): boolean {
  return monacoLanguageFor(locale) !== startLanguage;
}
