import {
  mapTestFieldSignatures,
  mapTestMapSignatures,
  mapTestQualityModule,
  mapTestQualitySignatures,
  mapTestQualityValues,
  mapTestRmsSignatures,
  mapTestSampleSignatures,
} from '../shared/map-test-api-reference';

export type StarlarkTextKind = 'code' | 'string' | 'comment';

export const stringLiteralReceiver = '""';
export const expressionReceiver = '?';

export interface StarlarkOpenCall {
  callee: readonly string[];
  argumentIndex: number;
  keyword: string | null;
}

export interface StarlarkCursorContext {
  kind: StarlarkTextKind;
  call: StarlarkOpenCall | null;
}

interface Frame {
  open: '(' | '[' | '{';
  callee: string[] | null;
  commas: number;
  keyword: string | null;
  argumentTokens: number;
  firstName: string | null;
}

const keywords = new Set([
  'and',
  'break',
  'continue',
  'def',
  'elif',
  'else',
  'for',
  'if',
  'in',
  'lambda',
  'load',
  'not',
  'or',
  'pass',
  'return',
  'while',
]);

const statementKeywords = new Set(['def', 'load', 'return', 'pass', 'break', 'continue', 'while']);

const stringPrefixes = new Set(['r', 'b', 'rb', 'br']);

function isNameStart(character: string): boolean {
  return /[A-Za-z_]/u.test(character);
}

function isNamePart(character: string): boolean {
  return /[A-Za-z0-9_]/u.test(character);
}

export function starlarkCursorContext(source: string, offset: number): StarlarkCursorContext {
  const end = Math.max(0, Math.min(offset, source.length));
  const frames: Frame[] = [];
  let index = 0;
  let last: 'name' | 'dot' | 'string' | 'close' | 'other' = 'other';
  let chain: string[] | null = null;
  let lineHasToken = false;

  const countToken = (): void => {
    const top = frames.at(-1);
    if (top) top.argumentTokens += 1;
  };

  const skipString = (): boolean => {
    const quote = source[index]!;
    const triple = source.startsWith(quote.repeat(3), index);
    index += triple ? 3 : 1;
    while (index < end) {
      const character = source[index]!;
      if (character === '\\') {
        index += 2;
        continue;
      }
      if (triple ? source.startsWith(quote.repeat(3), index) : character === quote) {
        index += triple ? 3 : 1;
        return index > end;
      }
      if (!triple && (character === '\n' || character === '\r')) return false;
      index += 1;
    }
    return true;
  };

  while (index < end) {
    const character = source[index]!;
    if (character === '\n' || character === '\r') {
      index += 1;
      lineHasToken = false;
      continue;
    }
    if (character === ' ' || character === '\t' || character === '\f') {
      index += 1;
      continue;
    }
    if (character === '\\') {
      index += 2;
      continue;
    }
    if (character === '#') {
      while (index < end && source[index] !== '\n' && source[index] !== '\r') index += 1;
      if (index >= end) return { kind: 'comment', call: null };
      continue;
    }
    if (character === '"' || character === "'") {
      if (skipString()) return { kind: 'string', call: innermostCall(frames) };
      countToken();
      last = 'string';
      chain = [stringLiteralReceiver];
      lineHasToken = true;
      continue;
    }
    if (isNameStart(character)) {
      const start = index;
      while (index < end && isNamePart(source[index]!)) index += 1;
      const name = source.slice(start, index);
      const next = source[index];
      if (index < end && stringPrefixes.has(name.toLowerCase()) && (next === '"' || next === "'")) {
        continue;
      }
      if (!lineHasToken && statementKeywords.has(name)) frames.length = 0;
      lineHasToken = true;
      const top = frames.at(-1);
      if (top) {
        top.argumentTokens += 1;
        if (top.argumentTokens === 1) top.firstName = keywords.has(name) ? null : name;
      }
      if (keywords.has(name)) {
        last = 'other';
        chain = null;
      } else {
        chain = last === 'dot' && chain ? [...chain, name] : [name];
        last = 'name';
      }
      continue;
    }
    if (/[0-9]/u.test(character)) {
      while (index < end && /[0-9A-Za-z_.]/u.test(source[index]!)) {
        const exponentSign =
          /[eE]/u.test(source[index]!) && /[+-]/u.test(source[index + 1] ?? '') ? 2 : 1;
        index += exponentSign;
      }
      countToken();
      last = 'other';
      chain = null;
      lineHasToken = true;
      continue;
    }
    lineHasToken = true;
    index += 1;
    switch (character) {
      case '.':
        if (last === 'name' || last === 'string') {
          last = 'dot';
        } else if (last === 'close') {
          chain = [expressionReceiver];
          last = 'dot';
        } else {
          last = 'other';
          chain = null;
        }
        continue;
      case '(':
      case '[':
      case '{':
        countToken();
        frames.push({
          open: character,
          callee: character === '(' && last === 'name' && chain ? [...chain] : null,
          commas: 0,
          keyword: null,
          argumentTokens: 0,
          firstName: null,
        });
        last = 'other';
        chain = null;
        continue;
      case ')':
      case ']':
      case '}': {
        const open = character === ')' ? '(' : character === ']' ? '[' : '{';
        const match = frames.map((frame) => frame.open).lastIndexOf(open);
        if (match >= 0) frames.length = match;
        last = 'close';
        chain = null;
        continue;
      }
      case ',': {
        const top = frames.at(-1);
        if (top) {
          top.commas += 1;
          top.keyword = null;
          top.argumentTokens = 0;
          top.firstName = null;
        }
        last = 'other';
        chain = null;
        continue;
      }
      case '=': {
        const top = frames.at(-1);
        if (source[index] === '=') {
          index += 1;
        } else if (top && last === 'name' && top.argumentTokens === 1 && top.firstName) {
          top.keyword = top.firstName;
        }
        countToken();
        last = 'other';
        chain = null;
        continue;
      }
      default:
        if ('<>!'.includes(character) && source[index] === '=') index += 1;
        countToken();
        last = 'other';
        chain = null;
    }
  }
  return { kind: 'code', call: innermostCall(frames) };
}

function innermostCall(frames: readonly Frame[]): StarlarkOpenCall | null {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index]!;
    if (frame.open !== '(' || !frame.callee) continue;
    return { callee: frame.callee, argumentIndex: frame.commas, keyword: frame.keyword };
  }
  return null;
}

export function starlarkCodeOnly(source: string): string {
  let result = '';
  let index = 0;
  const mask = (character: string): string =>
    character === '\r' || character === '\n' ? character : ' ';
  while (index < source.length) {
    const character = source[index]!;
    if (character === '#') {
      while (index < source.length && source[index] !== '\n' && source[index] !== '\r') {
        result += ' ';
        index += 1;
      }
      continue;
    }
    if (character !== '"' && character !== "'") {
      result += character;
      index += 1;
      continue;
    }
    const quote = character;
    const delimiter = source.startsWith(quote.repeat(3), index) ? quote.repeat(3) : quote;
    result += delimiter;
    index += delimiter.length;
    while (index < source.length) {
      if (source.startsWith(delimiter, index)) {
        result += delimiter;
        index += delimiter.length;
        break;
      }
      const current = source[index]!;
      if (delimiter.length === 1 && (current === '\n' || current === '\r')) break;
      if (current === '\\' && index + 1 < source.length) {
        result += mask(current) + mask(source[index + 1]!);
        index += 2;
        continue;
      }
      result += mask(current);
      index += 1;
    }
  }
  return result;
}

export interface StarlarkAliases {
  samples: ReadonlySet<string>;
  maps: ReadonlySet<string>;
  fields: ReadonlySet<string>;
  quality: ReadonlyMap<string, string>;
}

const qualityExports = new Set([
  ...mapTestQualitySignatures.keys(),
  ...mapTestQualityValues.keys(),
]);

function qualityLoads(source: string, code: string): Map<string, string> {
  const loaded = new Map<string, string>();
  for (const match of code.matchAll(/(?<![\w.])load\s*\(/gu)) {
    const start = match.index + match[0].length;
    const end = code.indexOf(')', start);
    if (end < 0) continue;
    const parts = [
      ...source
        .slice(start, end)
        .matchAll(/(?:([A-Za-z_]\w*)\s*=\s*)?(?:"([^"\\\n]*)"|'([^'\\\n]*)')/gu),
    ];
    const [module, ...names] = parts;
    if (!module || module[1] !== undefined || (module[2] ?? module[3]) !== mapTestQualityModule) {
      continue;
    }
    for (const name of names) {
      const exported = (name[2] ?? name[3])!;
      if (qualityExports.has(exported)) loaded.set(name[1] ?? exported, exported);
    }
  }
  return loaded;
}

export function starlarkAliases(source: string): StarlarkAliases {
  const code = starlarkCodeOnly(source);
  const samples = new Set(
    [...code.matchAll(/\bfor\s+([A-Za-z_]\w*)\s+in\s+rms\s*\.\s*generate\s*\(/gu)].map(
      (match) => match[1]!,
    ),
  );
  const collections = new Set(
    [...code.matchAll(/^[ \t]*([A-Za-z_]\w*)\s*=\s*rms\s*\.\s*generate\s*\(/gmu)].map(
      (match) => match[1]!,
    ),
  );
  for (const collection of collections) {
    for (const match of code.matchAll(
      new RegExp(
        `\\bfor\\s+([A-Za-z_]\\w*)\\s+in\\s+${collection}\\b(?!\\s*[.(\\[])|^[ \\t]*([A-Za-z_]\\w*)\\s*=\\s*${collection}\\s*\\[`,
        'gmu',
      ),
    )) {
      samples.add((match[1] ?? match[2])!);
    }
  }
  const maps = new Set(
    [...code.matchAll(/\b([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\s*\.\s*map\b(?!\s*\()/gu)]
      .filter((match) => samples.has(match[2]!))
      .map((match) => match[1]!),
  );
  const fields = new Set(
    [
      ...code.matchAll(
        /\b([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\s*\.\s*(map\s*\.\s*)?distance_field\s*\(/gu,
      ),
    ]
      .filter((match) => (match[3] === undefined ? maps.has(match[2]!) : samples.has(match[2]!)))
      .map((match) => match[1]!),
  );
  return { samples, maps, fields, quality: qualityLoads(source, code) };
}

export interface StarlarkSignatureParameter {
  label: [number, number];
  name: string;
}

export interface StarlarkSignature {
  label: string;
  documentation?: string;
  parameters: StarlarkSignatureParameter[];
}

export interface StarlarkSignatureHelp {
  signature: StarlarkSignature;
  activeParameter: number;
}

interface SignatureDefinition {
  parameters: readonly string[];
  documentation?: string;
}

const stringSignatures = new Map<string, SignatureDefinition>([
  [
    'format',
    {
      parameters: ['*args', '**kwargs'],
      documentation: 'Substitutes positional or named values into `{}` fields.',
    },
  ],
]);

function signatureOf(
  prefix: string | null,
  name: string,
  definition: SignatureDefinition,
): StarlarkSignature {
  let label = `${prefix === null ? '' : `${prefix}.`}${name}(`;
  const parameters: StarlarkSignatureParameter[] = [];
  definition.parameters.forEach((parameter, index) => {
    if (index > 0) label += ', ';
    parameters.push({
      label: [label.length, label.length + parameter.length],
      name: /^\**[A-Za-z_]\w*/u.exec(parameter)?.[0] ?? parameter,
    });
    label += parameter;
  });
  label += ')';
  return {
    label,
    ...(definition.documentation === undefined ? {} : { documentation: definition.documentation }),
    parameters,
  };
}

export function starlarkCalleeSignature(
  callee: readonly string[],
  aliases: StarlarkAliases,
): StarlarkSignature | null {
  const [receiver, method] = callee;
  if (callee.length === 1 && aliases.quality.has(receiver!)) {
    const definition = mapTestQualitySignatures.get(aliases.quality.get(receiver!)!);
    return definition ? signatureOf(null, receiver!, definition) : null;
  }
  if (callee.length === 2 && receiver === 'rms') {
    const definition = mapTestRmsSignatures.get(method!);
    return definition ? signatureOf('rms', method!, definition) : null;
  }
  if (callee.length === 2 && aliases.samples.has(receiver!)) {
    const definition = mapTestSampleSignatures.get(method!);
    return definition ? signatureOf('sample', method!, definition) : null;
  }
  if (callee.length === 2 && aliases.fields.has(receiver!)) {
    const definition = mapTestFieldSignatures.get(method!);
    return definition ? signatureOf('field', method!, definition) : null;
  }
  const mapMethod =
    callee.length === 3 && aliases.samples.has(receiver!) && method === 'map'
      ? callee[2]!
      : callee.length === 2 && aliases.maps.has(receiver!)
        ? method!
        : null;
  if (mapMethod !== null) {
    const definition = mapTestMapSignatures.get(mapMethod);
    return definition ? signatureOf('map', mapMethod, definition) : null;
  }
  if (callee.length >= 2) {
    const name = callee.at(-1)!;
    const definition = stringSignatures.get(name);
    if (definition) return signatureOf('string', name, definition);
  }
  return null;
}

function activeParameterOf(signature: StarlarkSignature, call: StarlarkOpenCall): number {
  const names = signature.parameters.map((parameter) => parameter.name);
  const variadic = names.findIndex((name) => name.startsWith('*') && !name.startsWith('**'));
  const keywords = names.findIndex((name) => name.startsWith('**'));
  if (call.keyword !== null) {
    const named = names.indexOf(call.keyword);
    if (named >= 0) return named;
    return keywords >= 0 ? keywords : names.length;
  }
  if (variadic >= 0 && call.argumentIndex >= variadic) return variadic;
  return Math.min(call.argumentIndex, names.length);
}

export function starlarkSignatureHelp(
  source: string,
  offset: number,
  aliases: StarlarkAliases = starlarkAliases(source),
): StarlarkSignatureHelp | null {
  const context = starlarkCursorContext(source, offset);
  if (context.kind === 'comment' || !context.call) return null;
  const signature = starlarkCalleeSignature(context.call.callee, aliases);
  if (!signature) return null;
  return { signature, activeParameter: activeParameterOf(signature, context.call) };
}
