export type TextDirection = 'ltr' | 'rtl';

export type MessageNode =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'argument'; readonly name: string }
  | { readonly kind: 'number'; readonly name: string; readonly style: string | null }
  | { readonly kind: 'date'; readonly name: string; readonly style: string | null }
  | { readonly kind: 'time'; readonly name: string; readonly style: string | null }
  | { readonly kind: 'list'; readonly name: string; readonly style: string | null }
  | {
      readonly kind: 'plural';
      readonly name: string;
      readonly ordinal: boolean;
      readonly offset: number;
      readonly options: readonly MessageOption[];
    }
  | { readonly kind: 'select'; readonly name: string; readonly options: readonly MessageOption[] }
  | { readonly kind: 'pound' };

export interface MessageOption {
  readonly key: string;
  readonly value: readonly MessageNode[];
}

export const maximumMessageLength = 4000;
const maximumNesting = 6;

export const pluralKeywords: readonly string[] = ['zero', 'one', 'two', 'few', 'many', 'other'];
const dateStyles = new Set(['short', 'medium', 'long', 'full']);
const timeStyles = new Set(['short', 'medium']);
const listStyles = new Set(['and', 'or', 'unit']);
const numberStyles = new Set(['integer', 'percent']);
const skeletonTokens =
  /^(?:\.0+#*|precision-integer|percent|group-off|compact-short|sign-always|unit\/[a-z-]+|unit-width-narrow|unit-width-full-name)$/u;

export class MessageSyntaxError extends Error {
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(`${message} at offset ${offset}`);
    this.name = 'MessageSyntaxError';
    this.offset = offset;
  }
}

interface Cursor {
  readonly text: string;
  index: number;
}

export function parseMessage(text: string): MessageNode[] {
  if (typeof text !== 'string') throw new MessageSyntaxError('message is not text', 0);
  if (text.length > maximumMessageLength) {
    throw new MessageSyntaxError('message is too long', maximumMessageLength);
  }
  const cursor: Cursor = { text, index: 0 };
  const nodes = parseNodes(cursor, 0, false, false);
  if (cursor.index < text.length) throw new MessageSyntaxError('unmatched }', cursor.index);
  return nodes;
}

function parseNodes(
  cursor: Cursor,
  depth: number,
  inPlural: boolean,
  nested: boolean,
): MessageNode[] {
  if (depth > maximumNesting)
    throw new MessageSyntaxError('message nests too deeply', cursor.index);
  const nodes: MessageNode[] = [];
  let text = '';
  const flush = () => {
    if (text) nodes.push({ kind: 'text', value: text });
    text = '';
  };
  const { text: source } = cursor;
  while (cursor.index < source.length) {
    const character = source[cursor.index]!;
    if (character === "'") {
      const next = source[cursor.index + 1];
      if (next === "'") {
        text += "'";
        cursor.index += 2;
        continue;
      }
      if (next === '{' || next === '}' || next === '|' || (inPlural && next === '#')) {
        const start = cursor.index;
        cursor.index += 1;
        let closed = false;
        while (cursor.index < source.length) {
          const quoted = source[cursor.index]!;
          if (quoted === "'") {
            if (source[cursor.index + 1] === "'") {
              text += "'";
              cursor.index += 2;
              continue;
            }
            cursor.index += 1;
            closed = true;
            break;
          }
          text += quoted;
          cursor.index += 1;
        }
        if (!closed) throw new MessageSyntaxError('quoted text is not closed', start);
        continue;
      }
      text += "'";
      cursor.index += 1;
      continue;
    }
    if (character === '{') {
      flush();
      nodes.push(parseArgument(cursor, depth, inPlural));
      continue;
    }
    if (character === '}') {
      if (!nested) throw new MessageSyntaxError('unmatched }', cursor.index);
      break;
    }
    if (character === '#' && inPlural) {
      flush();
      nodes.push({ kind: 'pound' });
      cursor.index += 1;
      continue;
    }
    text += character;
    cursor.index += 1;
  }
  flush();
  return nodes;
}

function skipSpace(cursor: Cursor): void {
  while (cursor.index < cursor.text.length && /\s/u.test(cursor.text[cursor.index]!)) {
    cursor.index += 1;
  }
}

function readWord(cursor: Cursor, pattern: RegExp, label: string): string {
  const match = pattern.exec(cursor.text.slice(cursor.index));
  if (!match || match.index !== 0) throw new MessageSyntaxError(`expected ${label}`, cursor.index);
  cursor.index += match[0].length;
  return match[0];
}

function expect(cursor: Cursor, character: string): void {
  if (cursor.text[cursor.index] !== character) {
    throw new MessageSyntaxError(`expected ${character}`, cursor.index);
  }
  cursor.index += 1;
}

function parseArgument(cursor: Cursor, depth: number, inPlural: boolean): MessageNode {
  const start = cursor.index;
  expect(cursor, '{');
  skipSpace(cursor);
  const name = readWord(cursor, /^[A-Za-z_][A-Za-z0-9_]*/u, 'an argument name');
  skipSpace(cursor);
  if (cursor.text[cursor.index] === '}') {
    cursor.index += 1;
    return { kind: 'argument', name };
  }
  expect(cursor, ',');
  skipSpace(cursor);
  const type = readWord(cursor, /^[a-z]+/u, 'an argument type');
  skipSpace(cursor);
  switch (type) {
    case 'number':
    case 'date':
    case 'time':
    case 'list': {
      let style: string | null = null;
      if (cursor.text[cursor.index] === ',') {
        cursor.index += 1;
        const end = cursor.text.indexOf('}', cursor.index);
        if (end < 0) throw new MessageSyntaxError('argument is not closed', start);
        style = cursor.text.slice(cursor.index, end).trim();
        cursor.index = end;
        validateStyle(type, style, start);
      }
      expect(cursor, '}');
      return { kind: type, name, style };
    }
    case 'plural':
    case 'selectordinal':
    case 'select': {
      expect(cursor, ',');
      skipSpace(cursor);
      let offset = 0;
      if (type !== 'select' && cursor.text.startsWith('offset:', cursor.index)) {
        cursor.index += 'offset:'.length;
        skipSpace(cursor);
        offset = Number(readWord(cursor, /^\d{1,6}/u, 'an offset'));
        skipSpace(cursor);
      }
      const options: MessageOption[] = [];
      const keys = new Set<string>();
      const plural = type !== 'select';
      while (cursor.text[cursor.index] !== '}') {
        if (cursor.index >= cursor.text.length) {
          throw new MessageSyntaxError('argument is not closed', start);
        }
        const keyStart = cursor.index;
        const key = plural
          ? readWord(cursor, /^(?:=-?\d{1,9}|[a-z]+)/u, 'a plural selector')
          : readWord(cursor, /^[A-Za-z0-9_-]+/u, 'a select key');
        if (plural && !key.startsWith('=') && !pluralKeywords.includes(key)) {
          throw new MessageSyntaxError(`unknown plural keyword ${key}`, keyStart);
        }
        if (keys.has(key)) throw new MessageSyntaxError(`repeated selector ${key}`, keyStart);
        keys.add(key);
        skipSpace(cursor);
        expect(cursor, '{');
        const value = parseNodes(cursor, depth + 1, plural || inPlural, true);
        expect(cursor, '}');
        options.push({ key, value });
        skipSpace(cursor);
      }
      cursor.index += 1;
      if (!keys.has('other')) throw new MessageSyntaxError('an other option is required', start);
      return plural
        ? { kind: 'plural', name, ordinal: type === 'selectordinal', offset, options }
        : { kind: 'select', name, options };
    }
    default:
      throw new MessageSyntaxError(`unknown argument type ${type}`, start);
  }
}

function validateStyle(type: string, style: string, offset: number): void {
  const valid =
    type === 'number'
      ? numberStyles.has(style) ||
        (style.startsWith('::') &&
          style
            .slice(2)
            .trim()
            .split(/\s+/u)
            .every((token) => skeletonTokens.test(token)))
      : type === 'date'
        ? dateStyles.has(style)
        : type === 'time'
          ? timeStyles.has(style)
          : listStyles.has(style);
  if (!valid) throw new MessageSyntaxError(`unknown ${type} style ${style}`, offset);
}

export type ArgumentKind =
  'string' | 'number' | 'date' | 'time' | 'list' | 'plural' | 'selectordinal' | 'select';

export interface ArgumentUse {
  kinds: Set<ArgumentKind>;
  keys: Set<string>;
}

export function messageArguments(nodes: readonly MessageNode[]): Map<string, ArgumentUse> {
  const uses = new Map<string, ArgumentUse>();
  const use = (name: string) => {
    let entry = uses.get(name);
    if (!entry) {
      entry = { kinds: new Set(), keys: new Set() };
      uses.set(name, entry);
    }
    return entry;
  };
  const visit = (list: readonly MessageNode[]) => {
    for (const node of list) {
      switch (node.kind) {
        case 'text':
        case 'pound':
          break;
        case 'argument':
          use(node.name).kinds.add('string');
          break;
        case 'plural':
        case 'select': {
          const entry = use(node.name);
          entry.kinds.add(
            node.kind === 'select' ? 'select' : node.ordinal ? 'selectordinal' : 'plural',
          );
          for (const option of node.options) {
            entry.keys.add(option.key);
            visit(option.value);
          }
          break;
        }
        default:
          use(node.name).kinds.add(node.kind);
      }
    }
  };
  visit(nodes);
  return uses;
}

export function longestLiteralLength(nodes: readonly MessageNode[]): number {
  let total = 0;
  for (const node of nodes) {
    if (node.kind === 'text') total += [...node.value].length;
    else if (node.kind === 'plural' || node.kind === 'select') {
      total += Math.max(0, ...node.options.map((option) => longestLiteralLength(option.value)));
    }
  }
  return total;
}

export type MessageValue = string | number | Date | readonly string[] | null | undefined;
export type MessageArguments = Readonly<Record<string, MessageValue>>;

export interface ListPattern {
  two: string;
  start: string;
  middle: string;
  end: string;
}

export interface ListPatterns {
  and?: ListPattern;
  or?: ListPattern;
  unit?: ListPattern;
}

export type ListStyle = keyof ListPatterns;

export interface FormatEnvironment {
  readonly formatLocale: string;
  readonly direction: TextDirection;
  readonly listPatterns?: ListPatterns;
}

export type FormatProblemReporter = (problem: string) => void;

const firstStrongIsolate = '⁨';
const popDirectionalIsolate = '⁩';

const formatterCache = new Map<string, unknown>();

function cached<T>(key: string, create: () => T): T {
  let value = formatterCache.get(key) as T | undefined;
  if (value === undefined) {
    value = create();
    formatterCache.set(key, value);
  }
  return value;
}

function numberFormat(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  return cached(`number\0${locale}\0${JSON.stringify(options)}`, () => {
    return new Intl.NumberFormat(locale, options);
  });
}

function pluralRules(locale: string, ordinal: boolean): Intl.PluralRules {
  return cached(`plural\0${locale}\0${ordinal}`, () => {
    return new Intl.PluralRules(locale, { type: ordinal ? 'ordinal' : 'cardinal' });
  });
}

export function numberStyleOptions(style: string | null): Intl.NumberFormatOptions {
  if (style === null) return {};
  if (style === 'integer') return { maximumFractionDigits: 0 };
  if (style === 'percent') return { style: 'percent' };
  const options: Intl.NumberFormatOptions = {};
  for (const token of style.slice(2).trim().split(/\s+/u)) {
    if (token.startsWith('.')) {
      const zeros = /^\.(0+)/u.exec(token)![1]!.length;
      options.minimumFractionDigits = zeros;
      options.maximumFractionDigits = token.length - 1;
    } else if (token === 'precision-integer') options.maximumFractionDigits = 0;
    else if (token === 'percent') options.style = 'percent';
    else if (token === 'group-off') options.useGrouping = false;
    else if (token === 'compact-short') options.notation = 'compact';
    else if (token === 'sign-always') options.signDisplay = 'always';
    else if (token.startsWith('unit/')) {
      options.style = 'unit';
      options.unit = token.slice('unit/'.length);
      options.unitDisplay ??= 'short';
    } else if (token === 'unit-width-narrow') options.unitDisplay = 'narrow';
    else if (token === 'unit-width-full-name') options.unitDisplay = 'long';
  }
  return options;
}

export function formatNumberValue(
  value: number,
  formatLocale: string,
  options: Intl.NumberFormatOptions = {},
): string {
  return numberFormat(formatLocale, options).format(value);
}

export function formatDateValue(
  value: Date | number,
  formatLocale: string,
  options: Intl.DateTimeFormatOptions,
): string {
  const format = cached(`date\0${formatLocale}\0${JSON.stringify(options)}`, () => {
    return new Intl.DateTimeFormat(formatLocale, options);
  });
  return format.format(value);
}

function applyPattern(pattern: string, first: string, second: string): string {
  return pattern.replace(/\{([01])\}/gu, (_, index: string) => (index === '0' ? first : second));
}

export function formatListValue(
  items: readonly string[],
  environment: FormatEnvironment,
  style: ListStyle = 'and',
): string {
  const pattern = environment.listPatterns?.[style];
  if (!pattern) {
    const format = cached(`list\0${environment.formatLocale}\0${style}`, () => {
      return new Intl.ListFormat(environment.formatLocale, {
        type: style === 'or' ? 'disjunction' : style === 'unit' ? 'unit' : 'conjunction',
      });
    });
    return format.format(items);
  }
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return applyPattern(pattern.two, items[0]!, items[1]!);
  let result = applyPattern(pattern.end, items.at(-2)!, items.at(-1)!);
  for (let index = items.length - 3; index >= 1; index -= 1) {
    result = applyPattern(pattern.middle, items[index]!, result);
  }
  return applyPattern(pattern.start, items[0]!, result);
}

function isolate(text: string, environment: FormatEnvironment): string {
  return environment.direction === 'rtl'
    ? `${firstStrongIsolate}${text}${popDirectionalIsolate}`
    : text;
}

export function formatMessage(
  nodes: readonly MessageNode[],
  args: MessageArguments,
  environment: FormatEnvironment,
  report: FormatProblemReporter = () => undefined,
  pound: string | null = null,
): string {
  let output = '';
  for (const node of nodes) {
    if (node.kind === 'text') {
      output += node.value;
      continue;
    }
    if (node.kind === 'pound') {
      output += pound ?? '#';
      continue;
    }
    const value = args[node.name];
    if (value === undefined || value === null) {
      report(`argument ${node.name} is missing`);
      output += `{${node.name}}`;
      continue;
    }
    switch (node.kind) {
      case 'argument':
        if (Array.isArray(value)) {
          output += formatListValue(
            value.map((item) => isolate(String(item), environment)),
            environment,
          );
        } else if (value instanceof Date) {
          output += formatDateValue(value, environment.formatLocale, { dateStyle: 'medium' });
        } else if (typeof value === 'string') {
          output += isolate(value, environment);
        } else {
          output += String(value);
        }
        break;
      case 'number': {
        const number = Number(value);
        if (Number.isNaN(number)) {
          report(`argument ${node.name} is not a number`);
          output += String(value);
        } else {
          output += formatNumberValue(
            number,
            environment.formatLocale,
            numberStyleOptions(node.style),
          );
        }
        break;
      }
      case 'date':
      case 'time': {
        const date = value instanceof Date ? value : new Date(Number(value));
        if (Number.isNaN(date.getTime())) {
          report(`argument ${node.name} is not a date`);
          output += String(value);
        } else {
          const style = (node.style ?? (node.kind === 'date' ? 'medium' : 'short')) as
            'short' | 'medium' | 'long' | 'full';
          output += formatDateValue(
            date,
            environment.formatLocale,
            node.kind === 'date' ? { dateStyle: style } : { timeStyle: style },
          );
        }
        break;
      }
      case 'list': {
        const items = Array.isArray(value) ? value.map(String) : [String(value)];
        output += formatListValue(
          items.map((item) => isolate(item, environment)),
          environment,
          node.style === 'or' || node.style === 'unit' ? node.style : 'and',
        );
        break;
      }
      case 'plural': {
        const number = Number(value);
        if (Number.isNaN(number)) report(`argument ${node.name} is not a number`);
        const relative = number - node.offset;
        const exact = node.options.find((option) => option.key === `=${number}`);
        const category = Number.isNaN(number)
          ? 'other'
          : pluralRules(environment.formatLocale, node.ordinal).select(relative);
        const option =
          exact ??
          node.options.find((candidate) => candidate.key === category) ??
          node.options.find((candidate) => candidate.key === 'other')!;
        const formatted = Number.isNaN(number)
          ? String(value)
          : formatNumberValue(relative, environment.formatLocale);
        output += formatMessage(option.value, args, environment, report, formatted);
        break;
      }
      case 'select': {
        const key = String(value);
        const option =
          node.options.find((candidate) => candidate.key === key) ??
          node.options.find((candidate) => candidate.key === 'other')!;
        output += formatMessage(option.value, args, environment, report, pound);
        break;
      }
    }
  }
  return output;
}

export type PseudoMode = 'accented' | 'bidi';

const accented: Readonly<Record<string, string>> = {
  a: 'á',
  b: 'ƀ',
  c: 'ç',
  d: 'ð',
  e: 'é',
  f: 'ƒ',
  g: 'ĝ',
  h: 'ĥ',
  i: 'í',
  j: 'ĵ',
  k: 'ķ',
  l: 'ļ',
  m: 'ɱ',
  n: 'ñ',
  o: 'ö',
  p: 'þ',
  q: 'ǫ',
  r: 'ŕ',
  s: 'š',
  t: 'ţ',
  u: 'û',
  v: 'ṽ',
  w: 'ŵ',
  x: 'ẋ',
  y: 'ý',
  z: 'ž',
  A: 'Å',
  B: 'Ɓ',
  C: 'Ç',
  D: 'Ð',
  E: 'É',
  F: 'Ƒ',
  G: 'Ĝ',
  H: 'Ĥ',
  I: 'Î',
  J: 'Ĵ',
  K: 'Ķ',
  L: 'Ļ',
  M: 'Ṁ',
  N: 'Ñ',
  O: 'Ö',
  P: 'Þ',
  Q: 'Ǫ',
  R: 'Ŕ',
  S: 'Š',
  T: 'Ţ',
  U: 'Û',
  V: 'Ṽ',
  W: 'Ŵ',
  X: 'Ẋ',
  Y: 'Ý',
  Z: 'Ž',
};

const rightToLeftOverride = '‮';
const popDirectionalFormatting = '‬';
const rightToLeftMark = '‏';

function pseudoText(text: string, mode: PseudoMode): string {
  if (mode === 'accented')
    return [...text].map((character) => accented[character] ?? character).join('');
  return text.replace(
    /[^\s.,:;!?()[\]{}"'“”‘’…·—–-]+/gu,
    (word) => `${rightToLeftOverride}${word}${popDirectionalFormatting}`,
  );
}

function pseudoNodes(nodes: readonly MessageNode[], mode: PseudoMode): MessageNode[] {
  return nodes.map((node): MessageNode => {
    if (node.kind === 'text') return { kind: 'text', value: pseudoText(node.value, mode) };
    if (node.kind === 'plural' || node.kind === 'select') {
      return {
        ...node,
        options: node.options.map((option) => ({
          key: option.key,
          value: pseudoNodes(option.value, mode),
        })),
      };
    }
    return node;
  });
}

export function pseudoLocalize(nodes: readonly MessageNode[], mode: PseudoMode): MessageNode[] {
  const transformed = pseudoNodes(nodes, mode);
  if (mode === 'bidi') return [{ kind: 'text', value: rightToLeftMark }, ...transformed];
  const length = longestLiteralLength(nodes);
  const padding = Math.max(0, Math.round(length * 0.35) - 2);
  const filler = padding >= 2 ? ` ${'~'.repeat(padding - 1)}` : '~'.repeat(padding);
  return [{ kind: 'text', value: '[' }, ...transformed, { kind: 'text', value: `${filler}]` }];
}

export const messageCatalogSchemaId = 'https://rmside.invalid/schemas/message-catalog/v1';
export const supportedCatalogMajor = 1;

export const messageControls: readonly string[] = [
  'menu',
  'menu-item',
  'button',
  'dialog-title',
  'dialog-text',
  'label',
  'option',
  'tooltip',
  'accessible-name',
  'message-headline',
  'message-cause',
  'message-action',
  'fragment',
  'tab',
  'heading',
  'placeholder',
  'status',
  'notice',
  'toggle',
  'empty-state',
];

export interface CatalogEntry {
  message: string;
  screen?: string;
  control?: string;
  maxLength?: number;
  meaning?: string;
  placeholders?: Record<string, string>;
  translate?: false;
}

export interface CatalogFile {
  $schema: string;
  schemaVersion: string;
  compatibility: { minimumMajor: number; maximumMajor: number };
  locale: string;
  name: string;
  direction: TextDirection;
  listPatterns?: ListPatterns;
  messages: Record<string, CatalogEntry>;
}

export const messageIdPattern = /^[a-z][a-z0-9-]*(?:\.[A-Za-z0-9_-]+)+$/u;
export const localeTagPattern = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|\d{3}))?$/u;
const screenPattern = /^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/u;
const maximumMessages = 10_000;

export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new CatalogError(`${where} has unknown field ${key}`);
  }
}

function validateListPattern(value: unknown, where: string): ListPattern {
  if (!isRecord(value)) throw new CatalogError(`${where} is not an object`);
  onlyKeys(value, ['two', 'start', 'middle', 'end'], where);
  for (const key of ['two', 'start', 'middle', 'end'] as const) {
    const pattern = value[key];
    if (
      typeof pattern !== 'string' ||
      pattern.length > 64 ||
      !pattern.includes('{0}') ||
      !pattern.includes('{1}')
    ) {
      throw new CatalogError(`${where}.${key} must hold {0} and {1}`);
    }
  }
  return value as unknown as ListPattern;
}

export function validateCatalogFile(value: unknown, options: { source: boolean }): CatalogFile {
  if (!isRecord(value)) throw new CatalogError('catalog is not an object');
  onlyKeys(
    value,
    [
      '$schema',
      'schemaVersion',
      'compatibility',
      'locale',
      'name',
      'direction',
      'listPatterns',
      'messages',
    ],
    'catalog',
  );
  if (value.$schema !== messageCatalogSchemaId) throw new CatalogError('catalog schema is unknown');
  const version = typeof value.schemaVersion === 'string' ? value.schemaVersion : '';
  const major = /^(\d{1,4})\.\d{1,4}\.\d{1,4}$/u.exec(version)?.[1];
  if (major === undefined) throw new CatalogError('catalog schemaVersion is malformed');
  if (Number(major) !== supportedCatalogMajor) {
    throw new CatalogError(`catalog major version ${major} is not supported`);
  }
  const compatibility = value.compatibility;
  if (
    !isRecord(compatibility) ||
    compatibility.minimumMajor !== supportedCatalogMajor ||
    compatibility.maximumMajor !== supportedCatalogMajor ||
    Object.keys(compatibility).length !== 2
  ) {
    throw new CatalogError('catalog compatibility is not supported');
  }
  if (typeof value.locale !== 'string' || !localeTagPattern.test(value.locale)) {
    throw new CatalogError('catalog locale is malformed');
  }
  if (typeof value.name !== 'string' || value.name.length < 1 || value.name.length > 64) {
    throw new CatalogError('catalog name is malformed');
  }
  if (value.direction !== 'ltr' && value.direction !== 'rtl') {
    throw new CatalogError('catalog direction is malformed');
  }
  if (value.listPatterns !== undefined) {
    if (!isRecord(value.listPatterns)) throw new CatalogError('listPatterns is not an object');
    onlyKeys(value.listPatterns, ['and', 'or', 'unit'], 'listPatterns');
    for (const [style, pattern] of Object.entries(value.listPatterns)) {
      validateListPattern(pattern, `listPatterns.${style}`);
    }
  }
  if (!isRecord(value.messages)) throw new CatalogError('catalog messages are not an object');
  const ids = Object.keys(value.messages);
  if (ids.length > maximumMessages) throw new CatalogError('catalog has too many messages');
  for (const id of ids) {
    if (!messageIdPattern.test(id)) throw new CatalogError(`message id ${id} is malformed`);
    validateEntry(id, value.messages[id], options.source);
  }
  return value as unknown as CatalogFile;
}

function validateEntry(id: string, entry: unknown, source: boolean): void {
  if (!isRecord(entry)) throw new CatalogError(`${id} is not an object`);
  onlyKeys(
    entry,
    ['message', 'screen', 'control', 'maxLength', 'meaning', 'placeholders', 'translate'],
    id,
  );
  if (entry.translate !== undefined && (entry.translate !== false || !source)) {
    throw new CatalogError(`${id} translate is malformed`);
  }
  if (typeof entry.message !== 'string' || entry.message.length === 0) {
    throw new CatalogError(`${id} has no message`);
  }
  let nodes: MessageNode[];
  try {
    nodes = parseMessage(entry.message);
  } catch (error) {
    throw new CatalogError(`${id}: ${(error as Error).message}`);
  }
  if (entry.screen !== undefined) {
    if (typeof entry.screen !== 'string' || !screenPattern.test(entry.screen)) {
      throw new CatalogError(`${id} screen is malformed`);
    }
  } else if (source) throw new CatalogError(`${id} has no screen`);
  if (entry.control !== undefined) {
    if (typeof entry.control !== 'string' || !messageControls.includes(entry.control)) {
      throw new CatalogError(`${id} control is unknown`);
    }
  } else if (source) throw new CatalogError(`${id} has no control`);
  if (entry.meaning !== undefined) {
    if (
      typeof entry.meaning !== 'string' ||
      entry.meaning.length < 3 ||
      entry.meaning.length > 600
    ) {
      throw new CatalogError(`${id} meaning is malformed`);
    }
  } else if (source) throw new CatalogError(`${id} has no meaning`);
  if (entry.maxLength !== undefined) {
    if (
      !Number.isInteger(entry.maxLength) ||
      (entry.maxLength as number) < 1 ||
      (entry.maxLength as number) > maximumMessageLength
    ) {
      throw new CatalogError(`${id} maxLength is malformed`);
    }
    if (longestLiteralLength(nodes) > (entry.maxLength as number)) {
      throw new CatalogError(`${id} is longer than its maxLength`);
    }
  }
  const names = [...messageArguments(nodes).keys()].sort();
  if (entry.placeholders !== undefined) {
    if (!isRecord(entry.placeholders)) throw new CatalogError(`${id} placeholders are malformed`);
    const described = Object.keys(entry.placeholders).sort();
    if (JSON.stringify(described) !== JSON.stringify(names)) {
      throw new CatalogError(`${id} placeholders do not match its arguments`);
    }
    for (const description of Object.values(entry.placeholders)) {
      if (typeof description !== 'string' || description.length < 3 || description.length > 300) {
        throw new CatalogError(`${id} placeholder description is malformed`);
      }
    }
  } else if (source && names.length > 0) {
    throw new CatalogError(`${id} does not describe its placeholders`);
  }
}

export function translationProblems(
  sourceNodes: readonly MessageNode[],
  translatedNodes: readonly MessageNode[],
  formatLocale: string,
): string[] {
  const problems: string[] = [];
  const source = messageArguments(sourceNodes);
  const translated = messageArguments(translatedNodes);
  const sourceNames = [...source.keys()].sort();
  const translatedNames = [...translated.keys()].sort();
  if (JSON.stringify(sourceNames) !== JSON.stringify(translatedNames)) {
    problems.push(
      `placeholders differ: source {${sourceNames.join('}, {')}}, translation {${translatedNames.join('}, {')}}`,
    );
  }
  for (const [name, use] of translated) {
    const expected = source.get(name);
    if (!expected) continue;
    for (const kind of ['number', 'date', 'time', 'list'] as const) {
      if (expected.kinds.has(kind) !== use.kinds.has(kind)) {
        problems.push(
          `{${name}} must ${expected.kinds.has(kind) ? '' : 'not '}use ${kind} formatting`,
        );
      }
    }
    const pluralKinds = ['plural', 'selectordinal'] as const;
    for (const kind of pluralKinds) {
      if (expected.kinds.has(kind) !== use.kinds.has(kind)) {
        problems.push(`{${name}} must ${expected.kinds.has(kind) ? '' : 'not '}be a ${kind}`);
      }
    }
    if (expected.kinds.has('select') !== use.kinds.has('select')) {
      problems.push(`{${name}} must ${expected.kinds.has('select') ? '' : 'not '}be a select`);
    }
    if (use.kinds.has('select')) {
      for (const key of use.keys) {
        if (!expected.keys.has(key))
          problems.push(`{${name}} has select key ${key} the source lacks`);
      }
    }
    for (const kind of pluralKinds) {
      if (!use.kinds.has(kind)) continue;
      const categories = new Intl.PluralRules(formatLocale, {
        type: kind === 'selectordinal' ? 'ordinal' : 'cardinal',
      }).resolvedOptions().pluralCategories as string[];
      const keywords = [...use.keys].filter((key) => !key.startsWith('='));
      for (const category of categories) {
        if (!keywords.includes(category)) {
          problems.push(`{${name}} lacks the ${category} plural category of ${formatLocale}`);
        }
      }
      for (const keyword of keywords) {
        if (!categories.includes(keyword)) {
          problems.push(`{${name}} has plural category ${keyword}, which ${formatLocale} lacks`);
        }
      }
    }
  }
  return problems;
}
