import englishCatalog from './catalogs/en.json' with { type: 'json' };
import { sourceLocale, type LanguageOption } from './locale';
import {
  formatDateValue,
  formatListValue,
  formatMessage,
  formatNumberValue,
  parseMessage,
  pseudoLocalize,
  validateCatalogFile,
  type CatalogFile,
  type FormatEnvironment,
  type ListStyle,
  type MessageArguments,
  type MessageNode,
  type PseudoMode,
  type TextDirection,
} from './message-format';

export type MessageId = keyof (typeof englishCatalog)['messages'];
export type { MessageArguments, TextDirection };

export interface Translator {
  readonly locale: string;
  readonly direction: TextDirection;
  readonly formatLocale: string;
  t(id: MessageId, args?: MessageArguments): string;
  formatNumber(value: number, options?: Intl.NumberFormatOptions): string;
  formatList(items: readonly string[], style?: ListStyle): string;
  formatDate(value: Date | number, options?: Intl.DateTimeFormatOptions): string;
  formatFileSize(bytes: number): string;
}

type ProblemReporter = (problem: string) => void;
let reportProblem: ProblemReporter = () => undefined;

export function setMessageProblemReporter(reporter: ProblemReporter): void {
  reportProblem = reporter;
}

interface LocaleDefinition {
  tag: string;
  name: string;
  direction: TextDirection;
  formatLocale: string;
  catalog: CatalogFile;
  pseudo: PseudoMode | null;
}

const english = validateCatalogFile(englishCatalog, { source: true });
const englishIds = Object.keys(english.messages);
export const translatableMessageIds: readonly string[] = englishIds.filter(
  (id) => english.messages[id]!.translate !== false,
);

export function isEnglishOnlyMessage(id: string): boolean {
  return english.messages[id]?.translate === false;
}

const definitions = new Map<string, LocaleDefinition>();
definitions.set(sourceLocale, {
  tag: sourceLocale,
  name: english.name,
  direction: english.direction,
  formatLocale: sourceLocale,
  catalog: english,
  pseudo: null,
});
definitions.set('en-XA', {
  tag: 'en-XA',
  name: 'Pseudo-accented (en-XA)',
  direction: 'ltr',
  formatLocale: sourceLocale,
  catalog: english,
  pseudo: 'accented',
});
definitions.set('ar-XB', {
  tag: 'ar-XB',
  name: 'Pseudo right-to-left (ar-XB)',
  direction: 'rtl',
  formatLocale: sourceLocale,
  catalog: english,
  pseudo: 'bidi',
});

export function registerTranslationCatalogs(files: Readonly<Record<string, unknown>>): void {
  for (const [path, data] of Object.entries(files).sort(([left], [right]) =>
    left.localeCompare(right, 'en'),
  )) {
    try {
      const catalog = validateCatalogFile(data, { source: false });
      if (!path.endsWith(`/${catalog.locale}.json`)) {
        throw new Error('file name differs from locale');
      }
      if (catalog.locale === sourceLocale || definitions.get(catalog.locale)?.pseudo) {
        throw new Error('locale is reserved');
      }
      definitions.set(catalog.locale, {
        tag: catalog.locale,
        name: catalog.name,
        direction: catalog.direction,
        formatLocale: catalog.locale,
        catalog,
        pseudo: null,
      });
      translators.delete(catalog.locale);
    } catch (error) {
      reportProblem(`message catalog ${path} is not used: ${(error as Error).message}`);
    }
  }
}

function complete(definition: LocaleDefinition): boolean {
  return (
    definition.catalog === english ||
    translatableMessageIds.every((id) => definition.catalog.messages[id] !== undefined)
  );
}

export function availableLanguages(options: { pseudo: boolean }): LanguageOption[] {
  const rank = (definition: LocaleDefinition) =>
    definition.tag === sourceLocale ? 0 : definition.pseudo ? 2 : 1;
  return [...definitions.values()]
    .filter((definition) => (definition.pseudo ? options.pseudo : complete(definition)))
    .sort(
      (left, right) =>
        rank(left) - rank(right) ||
        (rank(left) === 1 ? left.tag.localeCompare(right.tag, 'en') : 0),
    )
    .map((definition) => ({
      tag: definition.tag,
      name: definition.name,
      direction: definition.direction,
      pseudo: definition.pseudo !== null,
    }));
}

class CatalogTranslator implements Translator {
  readonly locale: string;
  readonly direction: TextDirection;
  readonly formatLocale: string;
  private readonly definition: LocaleDefinition;
  private readonly environment: FormatEnvironment;
  private readonly compiled = new Map<string, readonly MessageNode[] | null>();

  constructor(definition: LocaleDefinition) {
    this.definition = definition;
    this.locale = definition.tag;
    this.direction = definition.direction;
    this.formatLocale = definition.formatLocale;
    const listPatterns = definition.catalog.listPatterns;
    this.environment = {
      formatLocale: definition.formatLocale,
      direction: definition.direction,
      ...(listPatterns ? { listPatterns } : {}),
    };
  }

  private nodes(id: string): readonly MessageNode[] | null {
    if (this.compiled.has(id)) return this.compiled.get(id)!;
    const englishOnly = isEnglishOnlyMessage(id);
    const entry = (englishOnly ? english : this.definition.catalog).messages[id];
    let nodes: readonly MessageNode[] | null = null;
    if (entry) {
      const parsed = parseMessage(entry.message);
      nodes =
        this.definition.pseudo && !englishOnly
          ? pseudoLocalize(parsed, this.definition.pseudo)
          : parsed;
    }
    this.compiled.set(id, nodes);
    return nodes;
  }

  t(id: MessageId, args: MessageArguments = {}): string {
    if (this.locale !== sourceLocale && isEnglishOnlyMessage(id)) {
      return englishTranslator.t(id, args);
    }
    const nodes = this.nodes(id);
    if (!nodes) {
      if (this.definition.catalog !== english) {
        reportProblem(`${this.locale} has no message ${id}; English is shown`);
        return englishTranslator.t(id, args);
      }
      reportProblem(`message ${id} does not exist`);
      return id;
    }
    return formatMessage(nodes, args, this.environment, (problem) =>
      reportProblem(`${this.locale} ${id}: ${problem}`),
    );
  }

  formatNumber(value: number, options: Intl.NumberFormatOptions = {}): string {
    return formatNumberValue(value, this.formatLocale, options);
  }

  formatList(items: readonly string[], style: ListStyle = 'and'): string {
    return formatListValue(items, this.environment, style);
  }

  formatDate(
    value: Date | number,
    options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
  ): string {
    return formatDateValue(value, this.formatLocale, options);
  }

  formatFileSize(bytes: number): string {
    const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const;
    let value = Math.max(0, bytes);
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return formatNumberValue(value, this.formatLocale, {
      style: 'unit',
      unit: units[unit],
      unitDisplay: 'short',
      maximumFractionDigits: unit === 0 ? 0 : 1,
    });
  }
}

const translators = new Map<string, Translator>();

export function translatorFor(tag: string): Translator | null {
  const definition = definitions.get(tag);
  if (!definition) return null;
  let translator = translators.get(tag);
  if (!translator) {
    translator = new CatalogTranslator(definition);
    translators.set(tag, translator);
  }
  return translator;
}

export const englishTranslator: Translator = translatorFor(sourceLocale)!;

export function translatorForCatalog(data: unknown): Translator {
  const catalog = validateCatalogFile(data, { source: false });
  return new CatalogTranslator({
    tag: catalog.locale,
    name: catalog.name,
    direction: catalog.direction,
    formatLocale: catalog.locale,
    catalog,
    pseudo: null,
  });
}

let active: Translator = englishTranslator;
const listeners = new Set<(translator: Translator) => void>();

export function setActiveLocale(tag: string): Translator {
  const next = translatorFor(tag) ?? englishTranslator;
  if (next !== active) {
    active = next;
    for (const listener of listeners) listener(active);
  }
  return active;
}

export function activeTranslator(): Translator {
  return active;
}

export function onActiveLocaleChange(listener: (translator: Translator) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function t(id: MessageId, args?: MessageArguments): string {
  return active.t(id, args);
}

export function withTranslator<T>(translator: Translator, words: () => T): T {
  const previous = active;
  active = translator;
  try {
    return words();
  } finally {
    active = previous;
  }
}
