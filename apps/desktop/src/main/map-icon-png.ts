import { constants, deflateSync, inflateSync } from 'node:zlib';
import { mapIconRenderContract } from '../shared/api';

export const mapIconPngSize = mapIconRenderContract.size;
export const maximumMapIconPngBytes = 2 * 1024 * 1024;
export const mapIconPngRawBytes = mapIconPngSize * (1 + mapIconPngSize * 4);

const pngSignature = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const ihdrLength = 13;
const rgbaColorType = 6;
const bitDepth = 8;
const deflateOptions = {
  level: 9,
  memLevel: 9,
  strategy: constants.Z_DEFAULT_STRATEGY,
  windowBits: 15,
} as const;

export type MapIconPngErrorCode =
  | 'invalid-input'
  | 'too-large'
  | 'signature'
  | 'truncated'
  | 'chunk-crc'
  | 'chunk-order'
  | 'unsupported-chunk'
  | 'ihdr'
  | 'dimensions'
  | 'color-format'
  | 'missing-idat'
  | 'missing-iend'
  | 'trailing-data'
  | 'pixel-data';

export class MapIconPngError extends Error {
  constructor(
    readonly code: MapIconPngErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MapIconPngError';
  }
}

export interface MapIconPngHeader {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  compression: number;
  filter: number;
  interlace: number;
}

export interface MapIconPngValidation {
  width: typeof mapIconRenderContract.size;
  height: typeof mapIconRenderContract.size;
  byteLength: number;
  idatChunkCount: number;
  idatByteLength: number;
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb8_8320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array, start = 0, end = bytes.byteLength): number {
  let crc = 0xffff_ffff;
  for (let index = start; index < end; index += 1) {
    crc = crcTable[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

export function encodeMapIconPng(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): Uint8Array {
  if (width !== mapIconPngSize || height !== mapIconPngSize) {
    throw new MapIconPngError(
      'dimensions',
      `map icon must be ${mapIconPngSize} x ${mapIconPngSize} pixels`,
    );
  }
  if (
    !(rgba instanceof Uint8Array || rgba instanceof Uint8ClampedArray) ||
    rgba.byteLength !== width * height * 4
  ) {
    throw new MapIconPngError('invalid-input', 'map icon RGBA pixel buffer has an invalid length');
  }
  const rowBytes = width * 4;
  const raw = new Uint8Array(height * (1 + rowBytes));
  for (let row = 0; row < height; row += 1) {
    const target = row * (1 + rowBytes);
    raw[target] = 0;
    raw.set(rgba.subarray(row * rowBytes, (row + 1) * rowBytes), target + 1);
  }
  const compressed = deflateSync(raw, deflateOptions);
  const header = new Uint8Array(ihdrLength);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header[8] = bitDepth;
  header[9] = rgbaColorType;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  const total = pngSignature.byteLength + (12 + ihdrLength) + (12 + compressed.byteLength) + 12;
  if (total > maximumMapIconPngBytes) {
    throw new MapIconPngError('too-large', 'encoded map icon exceeds the byte limit');
  }
  const output = new Uint8Array(total);
  output.set(pngSignature, 0);
  let offset = pngSignature.byteLength;
  offset = writeChunk(output, offset, 'IHDR', header);
  offset = writeChunk(output, offset, 'IDAT', compressed);
  writeChunk(output, offset, 'IEND', new Uint8Array(0));
  return output;
}

export function readMapIconPngHeader(bytes: Uint8Array): MapIconPngHeader {
  assertBytes(bytes);
  assertSignature(bytes);
  if (bytes.byteLength < pngSignature.byteLength + 12 + ihdrLength) {
    throw new MapIconPngError('truncated', 'map icon PNG is truncated before IHDR ends');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = pngSignature.byteLength;
  if (view.getUint32(offset) !== ihdrLength || chunkType(bytes, offset + 4) !== 'IHDR') {
    throw new MapIconPngError('ihdr', 'map icon PNG must begin with a 13-byte IHDR chunk');
  }
  assertChunkCrc(bytes, view, offset, ihdrLength);
  const data = offset + 8;
  return {
    width: view.getUint32(data),
    height: view.getUint32(data + 4),
    bitDepth: bytes[data + 8]!,
    colorType: bytes[data + 9]!,
    compression: bytes[data + 10]!,
    filter: bytes[data + 11]!,
    interlace: bytes[data + 12]!,
  };
}

export function validateMapIconPng(bytes: Uint8Array): MapIconPngValidation {
  const header = readMapIconPngHeader(bytes);
  if (header.width !== mapIconPngSize || header.height !== mapIconPngSize) {
    throw new MapIconPngError(
      'dimensions',
      `map icon PNG must be ${mapIconPngSize} x ${mapIconPngSize} pixels`,
    );
  }
  if (
    header.bitDepth !== bitDepth ||
    header.colorType !== rgbaColorType ||
    header.compression !== 0 ||
    header.filter !== 0 ||
    header.interlace !== 0
  ) {
    throw new MapIconPngError(
      'color-format',
      'map icon PNG must be 8-bit non-interlaced RGBA (color type 6)',
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = pngSignature.byteLength + 12 + ihdrLength;
  let idatChunkCount = 0;
  let idatByteLength = 0;
  for (;;) {
    if (offset === bytes.byteLength) {
      throw new MapIconPngError('missing-iend', 'map icon PNG has no IEND chunk');
    }
    if (bytes.byteLength - offset < 12) {
      throw new MapIconPngError('truncated', 'map icon PNG chunk header is truncated');
    }
    const length = view.getUint32(offset);
    if (length > bytes.byteLength - offset - 12) {
      throw new MapIconPngError('truncated', 'map icon PNG chunk data is truncated');
    }
    const type = chunkType(bytes, offset + 4);
    assertChunkCrc(bytes, view, offset, length);
    if (type === 'IDAT') {
      idatChunkCount += 1;
      idatByteLength += length;
    } else if (type === 'IEND') {
      if (idatChunkCount === 0) {
        throw new MapIconPngError('missing-idat', 'map icon PNG has no IDAT chunk');
      }
      if (length !== 0) throw new MapIconPngError('chunk-order', 'map icon PNG IEND must be empty');
      offset += 12;
      if (offset !== bytes.byteLength) {
        throw new MapIconPngError('trailing-data', 'map icon PNG has data after IEND');
      }
      return {
        width: mapIconPngSize,
        height: mapIconPngSize,
        byteLength: bytes.byteLength,
        idatChunkCount,
        idatByteLength,
      };
    } else if (type === 'IHDR') {
      throw new MapIconPngError('chunk-order', 'map icon PNG has a duplicate IHDR chunk');
    } else {
      throw new MapIconPngError('unsupported-chunk', `map icon PNG chunk ${type} is not allowed`);
    }
    offset += 12 + length;
  }
}

export function decodeMapIconPng(bytes: Uint8Array): Uint8Array {
  validateMapIconPng(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts: Uint8Array[] = [];
  let offset = pngSignature.byteLength + 12 + ihdrLength;
  while (offset < bytes.byteLength) {
    const length = view.getUint32(offset);
    if (chunkType(bytes, offset + 4) === 'IDAT') {
      parts.push(bytes.subarray(offset + 8, offset + 8 + length));
    }
    offset += 12 + length;
  }
  let raw: Uint8Array;
  try {
    raw = inflateSync(Buffer.concat(parts), { maxOutputLength: mapIconPngRawBytes + 1 });
  } catch {
    throw new MapIconPngError('pixel-data', 'map icon PNG pixel data does not inflate');
  }
  if (raw.byteLength !== mapIconPngRawBytes) {
    throw new MapIconPngError('pixel-data', 'map icon PNG pixel data has an invalid length');
  }
  const rowBytes = mapIconPngSize * 4;
  const rgba = new Uint8Array(mapIconPngSize * rowBytes);
  for (let row = 0; row < mapIconPngSize; row += 1) {
    const source = row * (1 + rowBytes);
    if (raw[source] !== 0) {
      throw new MapIconPngError('pixel-data', 'map icon PNG scanlines must use filter type 0');
    }
    rgba.set(raw.subarray(source + 1, source + 1 + rowBytes), row * rowBytes);
  }
  return rgba;
}

function writeChunk(output: Uint8Array, offset: number, type: string, data: Uint8Array): number {
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  view.setUint32(offset, data.byteLength);
  for (let index = 0; index < 4; index += 1) output[offset + 4 + index] = type.charCodeAt(index);
  output.set(data, offset + 8);
  view.setUint32(
    offset + 8 + data.byteLength,
    crc32(output, offset + 4, offset + 8 + data.byteLength),
  );
  return offset + 12 + data.byteLength;
}

function assertBytes(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array)) {
    throw new MapIconPngError('invalid-input', 'map icon PNG must be a byte array');
  }
  if (bytes.byteLength > maximumMapIconPngBytes) {
    throw new MapIconPngError('too-large', 'map icon PNG exceeds the byte limit');
  }
}

function assertSignature(bytes: Uint8Array): void {
  if (bytes.byteLength < pngSignature.byteLength) {
    throw new MapIconPngError('signature', 'map icon PNG signature is missing');
  }
  for (let index = 0; index < pngSignature.byteLength; index += 1) {
    if (bytes[index] !== pngSignature[index]) {
      throw new MapIconPngError('signature', 'map icon PNG signature is invalid');
    }
  }
}

function assertChunkCrc(bytes: Uint8Array, view: DataView, offset: number, length: number): void {
  const expected = view.getUint32(offset + 8 + length);
  if (crc32(bytes, offset + 4, offset + 8 + length) !== expected) {
    throw new MapIconPngError('chunk-crc', 'map icon PNG chunk CRC is invalid');
  }
}

function chunkType(bytes: Uint8Array, offset: number): string {
  let type = '';
  for (let index = 0; index < 4; index += 1) {
    const code = bytes[offset + index]!;
    const isLetter = (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
    if (!isLetter) throw new MapIconPngError('chunk-order', 'map icon PNG chunk type is invalid');
    type += String.fromCharCode(code);
  }
  return type;
}
