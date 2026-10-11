export type PositionEncoding = 'utf-16' | 'utf-8' | 'utf-32';

export const offeredPositionEncodings: readonly PositionEncoding[] = ['utf-16', 'utf-8', 'utf-32'];

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export function isPositionEncoding(value: unknown): value is PositionEncoding {
  return value === 'utf-16' || value === 'utf-8' || value === 'utf-32';
}

export function isLspPosition(value: unknown): value is LspPosition {
  const position = value as Partial<LspPosition> | null;
  return (
    !!position &&
    typeof position === 'object' &&
    Number.isFinite(position.line) &&
    Number.isFinite(position.character)
  );
}

export function isLspRange(value: unknown): value is LspRange {
  const range = value as Partial<LspRange> | null;
  return (
    !!range && typeof range === 'object' && isLspPosition(range.start) && isLspPosition(range.end)
  );
}

export class DocumentLines {
  private readonly starts: number[] = [0];
  private readonly ends: number[] = [];

  constructor(readonly text: string) {
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code === 0x0a || code === 0x0d) {
        this.ends.push(index);
        if (code === 0x0d && text.charCodeAt(index + 1) === 0x0a) index += 1;
        this.starts.push(index + 1);
      }
    }
    this.ends.push(text.length);
  }

  get lineCount(): number {
    return this.starts.length;
  }

  line(index: number): string {
    if (index < 0 || index >= this.starts.length) return '';
    return this.text.slice(this.starts[index], this.ends[index]);
  }

  clamp(position: LspPosition): LspPosition {
    const lastLine = this.starts.length - 1;
    const rawLine = Number.isFinite(position.line) ? Math.floor(position.line) : 0;
    if (rawLine > lastLine) return { line: lastLine, character: this.line(lastLine).length };
    const line = Math.max(0, rawLine);
    const length = this.line(line).length;
    const rawCharacter = Number.isFinite(position.character) ? Math.floor(position.character) : 0;
    return { line, character: Math.min(length, Math.max(0, rawCharacter)) };
  }

  clampRange(range: LspRange): LspRange {
    const start = this.clamp(range.start);
    const end = this.clamp(range.end);
    return comparePositions(end, start) < 0 ? { start, end: start } : { start, end };
  }
}

function comparePositions(left: LspPosition, right: LspPosition): number {
  return left.line - right.line || left.character - right.character;
}

export function columnFromUtf16(line: string, column: number, encoding: PositionEncoding): number {
  const end = Math.min(Math.max(0, Math.floor(column)), line.length);
  if (encoding === 'utf-16') return end;
  let units = 0;
  for (let index = 0; index < end; index += 1) {
    const code = line.charCodeAt(index);
    const pair =
      code >= 0xd800 &&
      code <= 0xdbff &&
      index + 1 < end &&
      line.charCodeAt(index + 1) >= 0xdc00 &&
      line.charCodeAt(index + 1) <= 0xdfff;
    if (encoding === 'utf-32') units += 1;
    else units += pair ? 4 : code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    if (pair) index += 1;
  }
  return units;
}

export function columnToUtf16(line: string, column: number, encoding: PositionEncoding): number {
  const target = Math.max(0, Math.floor(Number.isFinite(column) ? column : 0));
  if (encoding === 'utf-16') return Math.min(target, line.length);
  let units = 0;
  let index = 0;
  while (index < line.length) {
    const code = line.charCodeAt(index);
    const pair =
      code >= 0xd800 &&
      code <= 0xdbff &&
      index + 1 < line.length &&
      line.charCodeAt(index + 1) >= 0xdc00 &&
      line.charCodeAt(index + 1) <= 0xdfff;
    const width = encoding === 'utf-32' ? 1 : pair ? 4 : code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    if (units + width > target) return index;
    units += width;
    index += pair ? 2 : 1;
  }
  return line.length;
}

export function positionToServer(
  lines: DocumentLines,
  position: LspPosition,
  encoding: PositionEncoding,
): LspPosition {
  const clamped = lines.clamp(position);
  return {
    line: clamped.line,
    character: columnFromUtf16(lines.line(clamped.line), clamped.character, encoding),
  };
}

export function positionFromServer(
  lines: DocumentLines,
  position: LspPosition,
  encoding: PositionEncoding,
): LspPosition {
  const lastLine = lines.lineCount - 1;
  const rawLine = Number.isFinite(position.line) ? Math.floor(position.line) : 0;
  if (rawLine > lastLine) return { line: lastLine, character: lines.line(lastLine).length };
  const line = Math.max(0, rawLine);
  return { line, character: columnToUtf16(lines.line(line), position.character, encoding) };
}

export function rangeToServer(
  lines: DocumentLines,
  range: LspRange,
  encoding: PositionEncoding,
): LspRange {
  const clamped = lines.clampRange(range);
  return {
    start: positionToServer(lines, clamped.start, encoding),
    end: positionToServer(lines, clamped.end, encoding),
  };
}

export function rangeFromServer(
  lines: DocumentLines,
  range: LspRange,
  encoding: PositionEncoding,
): LspRange {
  const start = positionFromServer(lines, range.start, encoding);
  const end = positionFromServer(lines, range.end, encoding);
  return comparePositions(end, start) < 0 ? { start, end: start } : { start, end };
}

export function asciiSubstitute(text: string): string {
  if (!/[^\x00-\x7f]/u.test(text)) return text;
  let result = '';
  for (const character of text) {
    result += character.codePointAt(0)! > 0x7f ? '?' : character;
  }
  return result;
}
