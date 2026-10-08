import type { PreviewProvenanceOperation } from '../shared/api';

export const outlineSymbolKind = Object.freeze({
  section: 3,
  command: 12,
  conditional: 17,
});

export interface SourceOutlineSymbol {
  kind: number;
  line: number;
  name?: string;
}

export interface SourceBlockStructure {
  symbols: readonly SourceOutlineSymbol[];
  folds: readonly { startLine: number; endLine: number }[];
}

export interface LineSpan {
  startLine: number;
  endLine: number;
}

export interface EditorSelectionPosition {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export interface SourceByteRange {
  start: number;
  end: number;
}

export interface SourceHighlightRequest {
  sourceId: string;
  byteRanges: readonly SourceByteRange[];
}

export interface SourceBraceBlock {
  header: number | null;
  span: LineSpan;
}

export interface SourceLineScopes {
  lineCount: number;
  start: Int32Array;
  end: Int32Array;
}

export function touchedLines(selection: EditorSelectionPosition): LineSpan {
  const first = Math.min(selection.startLineNumber, selection.endLineNumber);
  const last = Math.max(selection.startLineNumber, selection.endLineNumber);
  const lastColumn =
    selection.endLineNumber >= selection.startLineNumber
      ? selection.endColumn
      : selection.startColumn;
  const endLine = last > first && lastColumn === 1 ? last - 1 : last;
  return { startLine: first - 1, endLine: endLine - 1 };
}

export function sourceBraceBlocks(structure: SourceBlockStructure): SourceBraceBlock[] {
  const symbols = sortedSymbols(structure);
  const sectionLines = new Set(
    symbols.filter((symbol) => symbol.kind === outlineSymbolKind.section).map(({ line }) => line),
  );
  return structure.folds.flatMap((fold) => {
    if (fold.endLine <= fold.startLine || sectionLines.has(fold.startLine)) return [];
    const header = blockHeaderLine(symbols, fold.startLine);
    return [{ header, span: { startLine: header ?? fold.startLine, endLine: fold.endLine } }];
  });
}

function sortedSymbols(structure: SourceBlockStructure): SourceOutlineSymbol[] {
  return [...structure.symbols].sort((left, right) => left.line - right.line);
}

function blockHeaderLine(
  symbols: readonly SourceOutlineSymbol[],
  braceLine: number,
): number | null {
  let previous: SourceOutlineSymbol | null = null;
  for (const symbol of symbols) {
    if (symbol.line > braceLine) break;
    if (symbol.line === braceLine) {
      if (symbol.kind === outlineSymbolKind.command) return symbol.line;
      return null;
    }
    previous = symbol;
  }
  return previous?.kind === outlineSymbolKind.command ? previous.line : null;
}

type ConditionalRole = 'open' | 'branch' | 'close';

function conditionalRole(name: string | undefined): ConditionalRole | null {
  switch (name?.toLowerCase().replace(/^#/u, '')) {
    case 'if':
    case 'ifdef':
    case 'ifndef':
      return 'open';
    case 'elseif':
    case 'else':
      return 'branch';
    case 'endif':
      return 'close';
    default:
      return null;
  }
}

export function sourceConditionalScopes(
  structure: SourceBlockStructure,
  lineCount: number,
): Map<number, LineSpan> {
  const scopes = new Map<number, LineSpan>();
  for (const construct of conditionalConstructs(structure)) {
    const { close } = construct;
    const endLine = close ?? lineCount - 1;
    scopes.set(construct.line, { startLine: construct.line, endLine });
    if (close !== null) scopes.set(close, { startLine: construct.line, endLine });
    construct.branches.forEach((line, index) => {
      const next = construct.branches[index + 1] ?? close;
      scopes.set(line, { startLine: line, endLine: next === null ? endLine : next - 1 });
    });
  }
  return scopes;
}

interface ConditionalConstruct {
  line: number;
  branches: number[];
  close: number | null;
}

function conditionalConstructs(structure: SourceBlockStructure): ConditionalConstruct[] {
  const constructs: ConditionalConstruct[] = [];
  const open: ConditionalConstruct[] = [];
  for (const symbol of sortedSymbols(structure)) {
    if (symbol.kind !== outlineSymbolKind.conditional) continue;
    const role = conditionalRole(symbol.name);
    if (role === 'open') open.push({ line: symbol.line, branches: [], close: null });
    else if (role === 'branch') open.at(-1)?.branches.push(symbol.line);
    else if (role === 'close') {
      const construct = open.pop();
      if (construct) constructs.push({ ...construct, close: symbol.line });
    }
  }
  return [...constructs, ...open.reverse()];
}

export function sourceLineScopes(
  structure: SourceBlockStructure | null,
  lineCount: number,
): SourceLineScopes {
  const count = Math.max(0, lineCount);
  const start = new Int32Array(count);
  const end = new Int32Array(count);
  for (let line = 0; line < count; line += 1) {
    start[line] = line;
    end[line] = line;
  }
  const scopes = { lineCount: count, start, end };
  if (!structure) return scopes;
  const assign = (line: number, span: LineSpan) => {
    if (line < 0 || line >= count) return;
    start[line] = Math.max(0, span.startLine);
    end[line] = Math.min(count - 1, span.endLine);
  };
  const sectionLines = sortedSymbols(structure)
    .filter((symbol) => symbol.kind === outlineSymbolKind.section)
    .map(({ line }) => line);
  sectionLines.forEach((line, index) =>
    assign(line, {
      startLine: line,
      endLine: Math.max(line, (sectionLines[index + 1] ?? count) - 1),
    }),
  );
  const blocks = sourceBraceBlocks(structure).sort(
    (left, right) =>
      Number(left.header !== null) - Number(right.header !== null) ||
      right.span.endLine - right.span.startLine - (left.span.endLine - left.span.startLine),
  );
  const inHeadedBlock = new Uint8Array(count);
  for (const block of blocks) {
    const last = Math.min(count - 1, block.span.endLine);
    for (let line = Math.max(0, block.span.startLine); line <= last; line += 1) {
      assign(line, block.span);
      if (block.header !== null) inHeadedBlock[line] = 1;
    }
  }
  assignAlternativeHeaderTails(structure, blocks, scopes);
  for (const [line, span] of sourceConditionalScopes(structure, count)) {
    if (!inHeadedBlock[line]) assign(line, span);
  }
  return scopes;
}

function assignAlternativeHeaderTails(
  structure: SourceBlockStructure,
  blocks: readonly SourceBraceBlock[],
  scopes: SourceLineScopes,
): void {
  const byEnd = new Map<number, SourceBraceBlock[]>();
  for (const block of blocks) {
    if (block.header === null) continue;
    const group = byEnd.get(block.span.endLine);
    if (group) group.push(block);
    else byEnd.set(block.span.endLine, [block]);
  }
  const closed = conditionalConstructs(structure).filter(
    (construct): construct is ConditionalConstruct & { close: number } => construct.close !== null,
  );
  for (const [endLine, group] of byEnd) {
    if (group.length < 2) continue;
    const firstHeader = Math.min(...group.map((block) => block.span.startLine));
    const lastHeader = Math.max(...group.map((block) => block.span.startLine));
    const construct = closed
      .filter(({ line, close }) => line <= firstHeader && close > lastHeader && close < endLine)
      .reduce<(ConditionalConstruct & { close: number }) | null>(
        (innermost, candidate) =>
          innermost === null || candidate.line > innermost.line ? candidate : innermost,
        null,
      );
    if (!construct) continue;
    const starts = new Set(group.map((block) => block.span.startLine));
    const last = Math.min(scopes.lineCount - 1, endLine);
    for (let line = construct.close; line <= last; line += 1) {
      if (scopes.end[line] === last && starts.has(scopes.start[line]!)) {
        scopes.start[line] = firstHeader;
      }
    }
  }
}

export function sourceHighlightLineSpans(
  touched: readonly LineSpan[],
  scopes: SourceLineScopes | null,
): LineSpan[] {
  if (!scopes) return mergeLineSpans(touched.map((span) => ({ ...span })));
  const spans: LineSpan[] = [];
  for (const span of touched) {
    const first = Math.max(0, span.startLine);
    const last = Math.min(scopes.lineCount - 1, span.endLine);
    for (let line = first; line <= last; line += 1) {
      spans.push({ startLine: scopes.start[line]!, endLine: scopes.end[line]! });
    }
  }
  return mergeLineSpans(spans);
}

function mergeLineSpans(spans: LineSpan[]): LineSpan[] {
  const sorted = spans
    .filter((span) => span.endLine >= span.startLine && span.endLine >= 0)
    .sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);
  const merged: LineSpan[] = [];
  for (const span of sorted) {
    const last = merged.at(-1);
    if (last && span.startLine <= last.endLine + 1) {
      last.endLine = Math.max(last.endLine, span.endLine);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

export function lineByteRanges(content: string): SourceByteRange[] {
  const lines: SourceByteRange[] = [];
  let lineStart = 0;
  let bytes = 0;
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index);
    if (code === 0x0d || code === 0x0a) {
      lines.push({ start: lineStart, end: bytes });
      const crlf = code === 0x0d && content.charCodeAt(index + 1) === 0x0a;
      if (crlf) index += 1;
      bytes += crlf ? 2 : 1;
      lineStart = bytes;
    } else if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      (content.charCodeAt(index + 1) & 0xfc00) === 0xdc00
    ) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  lines.push({ start: lineStart, end: bytes });
  return lines;
}

export function lineSpanByteRanges(
  lines: readonly SourceByteRange[],
  spans: readonly LineSpan[],
): SourceByteRange[] {
  return spans.flatMap((span) => {
    if (span.startLine >= lines.length || span.endLine < 0) return [];
    const first = lines[Math.max(0, span.startLine)]!;
    const last = lines[Math.min(lines.length - 1, span.endLine)]!;
    return [{ start: first.start, end: last.end }];
  });
}

export function operationsIntersectingByteRanges(
  operations: readonly Pick<PreviewProvenanceOperation, 'sourceId' | 'byteStart' | 'byteEnd'>[],
  sourceId: string,
  byteRanges: readonly SourceByteRange[],
): number[] {
  if (byteRanges.length === 0) return [];
  return operations.flatMap((operation, operationIndex) => {
    if (operation.sourceId !== sourceId) return [];
    const intersects = byteRanges.some((range) =>
      operation.byteStart === operation.byteEnd
        ? range.start <= operation.byteStart && operation.byteStart <= range.end
        : operation.byteStart < range.end && operation.byteEnd > range.start,
    );
    return intersects ? [operationIndex] : [];
  });
}

export const noSourceHighlightOperations: readonly number[] = Object.freeze([]);

export function sameSourceHighlightRequest(
  left: SourceHighlightRequest | null,
  right: SourceHighlightRequest | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.sourceId === right.sourceId &&
    left.byteRanges.length === right.byteRanges.length &&
    left.byteRanges.every(
      (range, index) =>
        range.start === right.byteRanges[index]?.start &&
        range.end === right.byteRanges[index]?.end,
    )
  );
}
