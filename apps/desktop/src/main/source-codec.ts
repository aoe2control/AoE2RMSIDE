import type { SourceEncodingName, SourceNewlineStyle } from '../shared/api';
import { FileTooLargeError } from './bounded-file';

const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf]);
const undefinedWindows1252Bytes = new Set([0x81, 0x8d, 0x8f, 0x90, 0x9d]);
const windows1252SpecialCharacters = new Map<number, string>([
  [0x80, '€'],
  [0x82, '‚'],
  [0x83, 'ƒ'],
  [0x84, '„'],
  [0x85, '…'],
  [0x86, '†'],
  [0x87, '‡'],
  [0x88, 'ˆ'],
  [0x89, '‰'],
  [0x8a, 'Š'],
  [0x8b, '‹'],
  [0x8c, 'Œ'],
  [0x8e, 'Ž'],
  [0x91, '‘'],
  [0x92, '’'],
  [0x93, '“'],
  [0x94, '”'],
  [0x95, '•'],
  [0x96, '–'],
  [0x97, '—'],
  [0x98, '˜'],
  [0x99, '™'],
  [0x9a, 'š'],
  [0x9b, '›'],
  [0x9c, 'œ'],
  [0x9e, 'ž'],
  [0x9f, 'Ÿ'],
]);
const windows1252SpecialBytes = new Map(
  [...windows1252SpecialCharacters].map(([byte, character]) => [character, byte]),
);

export interface DecodedSource {
  content: string;
  encoding: SourceEncodingName;
  newlineStyle: SourceNewlineStyle;
}

export function decodeSourceBytes(bytes: Uint8Array): DecodedSource {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.subarray(0, utf8Bom.length).equals(utf8Bom)) {
    const content = decodeUtf8(buffer.subarray(utf8Bom.length));
    return { content, encoding: 'utf8-bom', newlineStyle: detectNewlineStyle(content) };
  }
  try {
    const content = decodeUtf8(buffer);
    return { content, encoding: 'utf8', newlineStyle: detectNewlineStyle(content) };
  } catch {
    const content = decodeWindows1252(buffer);
    return { content, encoding: 'windows-1252', newlineStyle: detectNewlineStyle(content) };
  }
}

export function encodeSourceText(
  content: string,
  encoding: SourceEncodingName,
  newlineStyle: SourceNewlineStyle,
  maximumBytes?: number,
  beforeEncode?: (bytes: number) => void,
): Buffer {
  const normalized = normalizeNewlines(content, newlineStyle);
  if (maximumBytes !== undefined || beforeEncode) {
    const encodedLength =
      encoding === 'windows-1252'
        ? normalized.length
        : Buffer.byteLength(normalized, 'utf8') + (encoding === 'utf8-bom' ? 3 : 0);
    if (maximumBytes !== undefined && encodedLength > maximumBytes)
      throw new FileTooLargeError(maximumBytes, encodedLength);
    beforeEncode?.(encodedLength);
  }
  if (encoding === 'utf8') return Buffer.from(normalized, 'utf8');
  if (encoding === 'utf8-bom') return Buffer.concat([utf8Bom, Buffer.from(normalized, 'utf8')]);
  if (encoding !== 'windows-1252') throw new Error('unsupported source encoding');
  return encodeWindows1252(normalized);
}

export function isSourceEncoding(value: unknown): value is SourceEncodingName {
  return value === 'utf8' || value === 'utf8-bom' || value === 'windows-1252';
}

export function isSourceNewlineStyle(value: unknown): value is SourceNewlineStyle {
  return (
    value === 'none' || value === 'lf' || value === 'crlf' || value === 'cr' || value === 'mixed'
  );
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

function decodeWindows1252(bytes: Uint8Array): string {
  let content = '';
  for (const byte of bytes) {
    if (undefinedWindows1252Bytes.has(byte)) {
      throw new Error(
        `the file contains byte 0x${byte.toString(16).padStart(2, '0')}, which is not a character in its encoding`,
      );
    }
    content += windows1252SpecialCharacters.get(byte) ?? String.fromCodePoint(byte);
  }
  return content;
}

function encodeWindows1252(content: string): Buffer {
  const bytes: number[] = [];
  let characterIndex = 0;
  for (const character of content) {
    const codePoint = character.codePointAt(0);
    const special = windows1252SpecialBytes.get(character);
    if (special !== undefined) bytes.push(special);
    else if (
      codePoint !== undefined &&
      (codePoint <= 0x7f || (codePoint >= 0xa0 && codePoint <= 0xff))
    ) {
      bytes.push(codePoint);
    } else {
      throw new Error(
        `character ${JSON.stringify(character)} at character index ${characterIndex} is not representable in Windows-1252`,
      );
    }
    characterIndex += 1;
  }
  return Buffer.from(bytes);
}

function detectNewlineStyle(content: string): SourceNewlineStyle {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '\r' && content[index + 1] === '\n') {
      crlf += 1;
      index += 1;
    } else if (content[index] === '\r') cr += 1;
    else if (content[index] === '\n') lf += 1;
  }
  const styles = Number(crlf > 0) + Number(lf > 0) + Number(cr > 0);
  if (styles === 0) return 'none';
  if (styles > 1) return 'mixed';
  if (crlf > 0) return 'crlf';
  if (lf > 0) return 'lf';
  return 'cr';
}

function normalizeNewlines(content: string, style: SourceNewlineStyle): string {
  if (style === 'mixed') return content;
  if (style === 'none') return content.replace(/\r\n|\r|\n/g, '\r\n');
  const replacement = style === 'crlf' ? '\r\n' : style === 'cr' ? '\r' : '\n';
  return content.replace(/\r\n|\r|\n/g, replacement);
}
