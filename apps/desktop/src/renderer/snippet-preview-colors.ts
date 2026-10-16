import { codeTokenRoles, type CodeColors, type EditorColorHalf } from './editor-color-schemes';
import { codeSemanticTokenTypes } from './semantic-tokens';

export interface SnippetPreviewToken {
  line: number;
  character: number;
  length: number;
  type: number;
}

export type SnippetPreviewRole =
  keyof CodeColors | 'bracket-1' | 'bracket-2' | 'bracket-3' | 'bracket-unexpected';

export interface SnippetPreviewSpan {
  text: string;
  role: SnippetPreviewRole | null;
}

const maximumTokens = 16_384;
const maximumNumber = 2 ** 31 - 1;

function invalid(): never {
  throw new Error('rms-ls answered with invalid snippet preview tokens');
}

export function decodePreviewTokens(data: unknown, text: string): SnippetPreviewToken[] {
  if (!Array.isArray(data) || data.length % 5 !== 0 || data.length > maximumTokens * 5) invalid();
  const lines = text.split('\n');
  const tokens: SnippetPreviewToken[] = [];
  let line = 0;
  let character = 0;
  let previousEnd = 0;
  const numberAt = (index: number): number => {
    const value: unknown = data[index];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > maximumNumber)
      invalid();
    return value;
  };
  for (let index = 0; index < data.length; index += 5) {
    const deltaLine = numberAt(index);
    const deltaStart = numberAt(index + 1);
    const length = numberAt(index + 2);
    const type = numberAt(index + 3);
    numberAt(index + 4);
    if (deltaLine > 0) {
      line += deltaLine;
      character = deltaStart;
      previousEnd = 0;
    } else {
      character += deltaStart;
    }
    const lineText = lines[line];
    if (
      lineText === undefined ||
      length === 0 ||
      character < previousEnd ||
      character + length > lineText.length ||
      type >= codeSemanticTokenTypes.length
    ) {
      invalid();
    }
    tokens.push({ line, character, length, type });
    previousEnd = character + length;
  }
  return tokens;
}

function standaloneBrace(lineText: string, offset: number): '{' | '}' | null {
  const brace = lineText[offset];
  if (brace !== '{' && brace !== '}') return null;
  const before = offset === 0 ? ' ' : lineText[offset - 1]!;
  const after = offset + 1 >= lineText.length ? ' ' : lineText[offset + 1]!;
  return /\s/u.test(before) && /\s/u.test(after) ? brace : null;
}

export function snippetPreviewSpans(
  text: string,
  tokens: readonly SnippetPreviewToken[],
): SnippetPreviewSpan[][] {
  const lines = text.split('\n');
  const byLine = new Map<number, SnippetPreviewToken[]>();
  for (const token of tokens) {
    const list = byLine.get(token.line) ?? [];
    list.push(token);
    byLine.set(token.line, list);
  }
  let depth = 0;
  const bracketRole = (brace: '{' | '}'): SnippetPreviewRole => {
    if (brace === '{') {
      const level = depth % 3;
      depth += 1;
      return `bracket-${level + 1}` as SnippetPreviewRole;
    }
    if (depth === 0) return 'bracket-unexpected';
    depth -= 1;
    return `bracket-${(depth % 3) + 1}` as SnippetPreviewRole;
  };
  return lines.map((lineText, lineIndex) => {
    const spans: SnippetPreviewSpan[] = [];
    const plain = (from: number, to: number) => {
      let start = from;
      for (let offset = from; offset < to; offset += 1) {
        const brace = standaloneBrace(lineText, offset);
        if (!brace) continue;
        if (offset > start) spans.push({ text: lineText.slice(start, offset), role: null });
        spans.push({ text: brace, role: bracketRole(brace) });
        start = offset + 1;
      }
      if (to > start) spans.push({ text: lineText.slice(start, to), role: null });
    };
    let cursor = 0;
    for (const token of byLine.get(lineIndex) ?? []) {
      plain(cursor, token.character);
      const end = token.character + token.length;
      const type = codeSemanticTokenTypes[token.type]!;
      spans.push({ text: lineText.slice(token.character, end), role: codeTokenRoles[type] });
      cursor = end;
    }
    plain(cursor, lineText.length);
    return spans;
  });
}

export function snippetPreviewColor(half: EditorColorHalf, role: SnippetPreviewRole): string {
  switch (role) {
    case 'bracket-1':
      return half.brackets.first;
    case 'bracket-2':
      return half.brackets.second;
    case 'bracket-3':
      return half.brackets.third;
    case 'bracket-unexpected':
      return half.brackets.unexpected;
    default:
      return half.code[role];
  }
}
