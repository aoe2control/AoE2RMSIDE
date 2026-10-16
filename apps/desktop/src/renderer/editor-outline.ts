import {
  outlineSymbolKind,
  type SourceBlockStructure,
  type SourceOutlineSymbol,
} from './source-highlight';

export type OutlineEntryKind = 'section' | 'block' | 'function' | 'rule';

export interface OutlineEntry {
  readonly kind: OutlineEntryKind;
  readonly label: string;
  readonly line: number;
  readonly character: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly children: readonly OutlineEntry[];
}

export interface DocumentOutline {
  readonly entries: readonly OutlineEntry[];
}

export const emptyOutline: DocumentOutline = Object.freeze({ entries: Object.freeze([]) });

export const maximumOutlineLabelLength = 80;

const maximumLabelLines = 4;

export const xsOutlineSymbolKind = Object.freeze({ function: 12, rule: 24 });

export interface XsOutlineSymbol {
  kind: number;
  name: string;
  startLine: number;
  endLine: number;
  line: number;
  character: number;
}

export function outlineLabel(text: string): string {
  const collapsed = text.replace(/\s+/gu, ' ').trim();
  return collapsed.length > maximumOutlineLabelLength
    ? `${collapsed.slice(0, maximumOutlineLabelLength - 1).trimEnd()}…`
    : collapsed;
}

interface PositionedSymbol {
  symbol: SourceOutlineSymbol;
  line: number;
  character: number;
}

function comparePositions(
  leftLine: number,
  leftCharacter: number,
  rightLine: number,
  rightCharacter: number,
): number {
  return leftLine - rightLine || leftCharacter - rightCharacter;
}

function lastSymbolBefore(
  symbols: readonly PositionedSymbol[],
  line: number,
  character: number,
): number {
  let low = 0;
  let high = symbols.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const symbol = symbols[middle]!;
    if (comparePositions(symbol.line, symbol.character, line, character) < 0) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

function firstSymbolFrom(symbols: readonly PositionedSymbol[], line: number): number {
  return lastSymbolBefore(symbols, line, 0) + 1;
}

function statementText(
  symbol: SourceOutlineSymbol,
  lineText: (line: number) => string,
  lineCount: number,
): string {
  const { character, endLine, endCharacter } = symbol;
  if (
    character === undefined ||
    endLine === undefined ||
    endCharacter === undefined ||
    endLine < symbol.line ||
    symbol.line >= lineCount
  ) {
    return symbol.name ?? '';
  }
  const parts: string[] = [];
  const last = Math.min(endLine, symbol.line + maximumLabelLines - 1, lineCount - 1);
  for (let line = symbol.line; line <= last; line += 1) {
    const text = lineText(line);
    const start = line === symbol.line ? character : 0;
    const end = line === endLine ? endCharacter : text.length;
    parts.push(text.slice(start, Math.max(start, end)));
  }
  const text = parts.join(' ');
  return text.trim() === '' ? (symbol.name ?? '') : text;
}

interface BlockCandidate {
  header: PositionedSymbol;
  startLine: number;
  endLine: number;
}

function headedBlocks(
  structure: SourceBlockStructure,
  symbols: readonly PositionedSymbol[],
  lineText: (line: number) => string,
  lineCount: number,
): BlockCandidate[] {
  const blocks: BlockCandidate[] = [];
  const headers = new Set<PositionedSymbol>();
  const sectionStarts = new Set(
    symbols
      .filter(({ symbol }) => symbol.kind === outlineSymbolKind.section)
      .map(({ line, character }) => `${line}:${character}`),
  );
  const sectionLines = new Set(
    symbols
      .filter(({ symbol }) => symbol.kind === outlineSymbolKind.section)
      .map(({ line }) => line),
  );
  for (const fold of structure.folds) {
    if (fold.endLine <= fold.startLine) continue;
    let header: PositionedSymbol | undefined;
    if (fold.startCharacter !== undefined) {
      if (sectionStarts.has(`${fold.startLine}:${fold.startCharacter}`)) continue;
      header = symbols[lastSymbolBefore(symbols, fold.startLine, fold.startCharacter)];
    } else {
      if (sectionLines.has(fold.startLine)) continue;
      const first = symbols[firstSymbolFrom(symbols, fold.startLine)];
      header =
        first && first.line === fold.startLine
          ? first
          : symbols[lastSymbolBefore(symbols, fold.startLine, 0)];
    }
    if (!header || header.symbol.kind !== outlineSymbolKind.command || headers.has(header)) {
      continue;
    }
    headers.add(header);
    blocks.push({ header, startLine: header.line, endLine: Math.max(header.line, fold.endLine) });
  }
  for (const positioned of symbols) {
    const { symbol } = positioned;
    if (symbol.kind !== outlineSymbolKind.command || headers.has(positioned)) continue;
    if (symbol.endLine === undefined || symbol.endCharacter === undefined) continue;
    if (symbol.endLine >= lineCount) continue;
    if (!/^\s*\{/u.test(lineText(symbol.endLine).slice(symbol.endCharacter))) continue;
    blocks.push({ header: positioned, startLine: positioned.line, endLine: symbol.endLine });
  }
  return blocks.sort(
    (left, right) =>
      comparePositions(
        left.header.line,
        left.header.character,
        right.header.line,
        right.header.character,
      ) || right.endLine - left.endLine,
  );
}

interface MutableEntry {
  kind: OutlineEntryKind;
  label: string;
  line: number;
  character: number;
  startLine: number;
  endLine: number;
  children: MutableEntry[];
}

function topLevelBlocks(
  candidates: readonly BlockCandidate[],
  lineText: (line: number) => string,
  lineCount: number,
): MutableEntry[] {
  const accepted: MutableEntry[] = [];
  let container: { startLine: number; endLine: number } | null = null;
  for (const candidate of candidates) {
    if (
      container &&
      candidate.startLine > container.startLine &&
      candidate.endLine < container.endLine
    ) {
      continue;
    }
    const previous = accepted.at(-1);
    if (previous && candidate.startLine <= previous.endLine) {
      previous.endLine = Math.max(previous.startLine, candidate.startLine - 1);
    }
    accepted.push({
      kind: 'block',
      label: outlineLabel(statementText(candidate.header.symbol, lineText, lineCount)),
      line: candidate.header.line,
      character: candidate.header.character,
      startLine: candidate.startLine,
      endLine: candidate.endLine,
      children: [],
    });
    container = { startLine: candidate.startLine, endLine: candidate.endLine };
  }
  return accepted;
}

export function rmsOutline(
  structure: SourceBlockStructure,
  lineCount: number,
  lineText: (line: number) => string,
): DocumentOutline {
  const count = Math.max(0, lineCount);
  if (count === 0) return emptyOutline;
  const symbols: PositionedSymbol[] = structure.symbols
    .filter((symbol) => symbol.line >= 0 && symbol.line < count)
    .map((symbol) => ({ symbol, line: symbol.line, character: symbol.character ?? 0 }))
    .sort((left, right) =>
      comparePositions(left.line, left.character, right.line, right.character),
    );
  const sectionSymbols = symbols.filter(({ symbol }) => symbol.kind === outlineSymbolKind.section);
  const sections: MutableEntry[] = sectionSymbols.map((positioned, index) => ({
    kind: 'section',
    label: outlineLabel(
      positioned.symbol.name ?? statementText(positioned.symbol, lineText, count),
    ),
    line: positioned.line,
    character: positioned.character,
    startLine: positioned.line,
    endLine: Math.max(positioned.line, (sectionSymbols[index + 1]?.line ?? count) - 1),
    children: [],
  }));
  const blocks = topLevelBlocks(headedBlocks(structure, symbols, lineText, count), lineText, count);
  const entries: MutableEntry[] = [];
  let sectionIndex = -1;
  for (const block of blocks) {
    while (
      sectionIndex + 1 < sections.length &&
      sections[sectionIndex + 1]!.startLine <= block.startLine
    ) {
      sectionIndex += 1;
    }
    const section = sections[sectionIndex];
    if (section && block.startLine <= section.endLine) {
      block.endLine = Math.min(block.endLine, section.endLine);
      const previous = section.children.at(-1);
      if (previous && previous.startLine === block.startLine) section.children.pop();
      section.children.push(block);
    } else {
      const next = sections[sectionIndex + 1];
      if (next) block.endLine = Math.min(block.endLine, next.startLine - 1);
      const previous = entries.at(-1);
      if (previous && previous.startLine === block.startLine) entries.pop();
      entries.push(block);
    }
  }
  return freezeOutline([...entries, ...sections]);
}

export function xsOutline(symbols: readonly XsOutlineSymbol[]): DocumentOutline {
  const entries: MutableEntry[] = symbols
    .filter(
      (symbol) =>
        (symbol.kind === xsOutlineSymbolKind.function ||
          symbol.kind === xsOutlineSymbolKind.rule) &&
        symbol.name.trim() !== '' &&
        symbol.endLine >= symbol.startLine,
    )
    .map((symbol) => ({
      kind: symbol.kind === xsOutlineSymbolKind.rule ? ('rule' as const) : ('function' as const),
      label: outlineLabel(symbol.name),
      line: symbol.line,
      character: symbol.character,
      startLine: symbol.startLine,
      endLine: symbol.endLine,
      children: [],
    }))
    .sort((left, right) => left.startLine - right.startLine || right.endLine - left.endLine);
  return freezeOutline(withoutOverlap(entries));
}

export function mapTestFunctionDefinition(
  line: string,
): { name: string; character: number; indented: boolean } | null {
  const match = /^(\s*)(def\s+)([A-Za-z_]\w*)\s*\(/u.exec(line);
  if (!match) return null;
  return {
    name: match[3]!,
    character: match[1]!.length + match[2]!.length,
    indented: match[1]!.length > 0,
  };
}

export function mapTestOutline(lines: readonly string[]): DocumentOutline {
  const entries: MutableEntry[] = [];
  let open: MutableEntry | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const topLevel = line !== '' && !/^\s/u.test(line) && !line.startsWith('#');
    if (!topLevel) continue;
    if (open) {
      open.endLine = Math.max(open.startLine, index - 1);
      open = null;
    }
    const definition = mapTestFunctionDefinition(line);
    if (!definition || definition.indented) continue;
    open = {
      kind: 'function',
      label: outlineLabel(definition.name),
      line: index,
      character: definition.character,
      startLine: index,
      endLine: index,
      children: [],
    };
    entries.push(open);
  }
  if (open) open.endLine = Math.max(open.startLine, lines.length - 1);
  return freezeOutline(entries);
}

function withoutOverlap(entries: MutableEntry[]): MutableEntry[] {
  const kept: MutableEntry[] = [];
  for (const entry of entries) {
    const previous = kept.at(-1);
    if (previous && entry.startLine <= previous.endLine) {
      if (entry.startLine === previous.startLine) continue;
      previous.endLine = entry.startLine - 1;
    }
    kept.push(entry);
  }
  return kept;
}

function freezeEntry(entry: MutableEntry): OutlineEntry {
  return Object.freeze({
    ...entry,
    children: Object.freeze(entry.children.map(freezeEntry)),
  });
}

function freezeOutline(entries: readonly MutableEntry[]): DocumentOutline {
  if (entries.length === 0) return emptyOutline;
  return Object.freeze({ entries: Object.freeze(entries.map(freezeEntry)) });
}

function entryAt(entries: readonly OutlineEntry[], line: number): OutlineEntry | null {
  let low = 0;
  let high = entries.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (entries[middle]!.startLine <= line) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  const entry = entries[found];
  return entry && line <= entry.endLine ? entry : null;
}

export function outlinePathAt(outline: DocumentOutline, line: number): OutlineEntry[] {
  const path: OutlineEntry[] = [];
  let entries = outline.entries;
  for (let entry = entryAt(entries, line); entry; entry = entryAt(entries, line)) {
    path.push(entry);
    entries = entry.children;
  }
  return path;
}

export type OutlineLevelKind = 'section' | 'block' | 'function';

export interface OutlineLevel {
  readonly kind: OutlineLevelKind;
  readonly entries: readonly OutlineEntry[];
  readonly current: OutlineEntry | null;
}

export function outlineLevels(
  outline: DocumentOutline,
  path: readonly OutlineEntry[],
): OutlineLevel[] {
  const { entries } = outline;
  if (entries.length === 0) return [];
  const kind: OutlineLevelKind = entries.some((entry) => entry.kind === 'section')
    ? 'section'
    : entries.some((entry) => entry.kind === 'function' || entry.kind === 'rule')
      ? 'function'
      : 'block';
  const levels: OutlineLevel[] = [{ kind, entries, current: path[0] ?? null }];
  for (let index = 0; index < path.length; index += 1) {
    const children = path[index]!.children;
    if (children.length === 0) break;
    levels.push({ kind: 'block', entries: children, current: path[index + 1] ?? null });
  }
  return levels;
}

export function outlineRowVisible(outline: DocumentOutline | null, previous: boolean): boolean {
  return outline === null ? previous : outline.entries.length > 0;
}

export function sameOutlinePath(
  left: readonly OutlineEntry[],
  right: readonly OutlineEntry[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const other = right[index]!;
      return (
        entry === other ||
        (entry.kind === other.kind &&
          entry.label === other.label &&
          entry.line === other.line &&
          entry.character === other.character &&
          entry.startLine === other.startLine &&
          entry.endLine === other.endLine)
      );
    })
  );
}

export const maximumOutlineMenuEntries = 500;

export function outlineMenuWindow(
  entries: readonly OutlineEntry[],
  current: OutlineEntry | null,
  maximum: number = maximumOutlineMenuEntries,
): readonly OutlineEntry[] {
  if (entries.length <= maximum) return entries;
  const index = current ? entries.indexOf(current) : -1;
  const start = Math.max(
    0,
    Math.min(entries.length - maximum, (index < 0 ? 0 : index) - Math.floor(maximum / 2)),
  );
  return entries.slice(start, start + maximum);
}
