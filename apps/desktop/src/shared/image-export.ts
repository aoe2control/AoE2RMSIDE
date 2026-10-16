import { isSafeWindowsPathPart } from './windows-names';

export const maximumExportImageSide = 8192;
export const maximumExportImagePixels = (40 * 1024 * 1024) / 4;

export interface ExportImagePixels {
  width: number;
  height: number;
  pixels: Uint8Array | Uint8ClampedArray;
}

export type ClipboardImageRequest =
  ({ kind: 'pixels' } & ExportImagePixels) | { kind: 'map-icon'; token: string };

export interface PreviewImageSaveRequest extends ExportImagePixels {
  fileName: string;
}

export type PreviewImageSaveResult =
  { status: 'saved'; fileName: string } | { status: 'cancelled' };

export function exportImageSizeAllowed(width: number, height: number): boolean {
  return (
    Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) &&
    width >= 1 &&
    height >= 1 &&
    width <= maximumExportImageSide &&
    height <= maximumExportImageSide &&
    width * height <= maximumExportImagePixels
  );
}

export function validateExportImagePixels(value: unknown): Readonly<ExportImagePixels> {
  if (!isPlainRecord(value)) throw new Error('image is invalid');
  const { width, height, pixels } = value;
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !exportImageSizeAllowed(width, height)
  ) {
    throw new Error('image size is invalid');
  }
  if (
    !(pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray) ||
    pixels.byteLength !== width * height * 4
  ) {
    throw new Error('image pixels are invalid');
  }
  return Object.freeze({ width, height, pixels: new Uint8Array(pixels) });
}

const pixelsKeys = ['height', 'kind', 'pixels', 'width'].join(',');
const mapIconKeys = ['kind', 'token'].join(',');
const saveKeys = ['fileName', 'height', 'pixels', 'width'].join(',');

export function validateClipboardImageRequest(value: unknown): Readonly<ClipboardImageRequest> {
  if (!isPlainRecord(value)) throw new Error('clipboard image request is invalid');
  const keys = Object.keys(value).sort().join(',');
  if (value.kind === 'pixels' && keys === pixelsKeys) {
    return Object.freeze({ kind: 'pixels', ...validateExportImagePixels(value) });
  }
  if (
    value.kind === 'map-icon' &&
    keys === mapIconKeys &&
    typeof value.token === 'string' &&
    /^[a-f0-9-]{36}$/u.test(value.token)
  ) {
    return Object.freeze({ kind: 'map-icon', token: value.token });
  }
  throw new Error('clipboard image request is invalid');
}

export function validatePreviewImageSaveRequest(value: unknown): Readonly<PreviewImageSaveRequest> {
  if (!isPlainRecord(value) || Object.keys(value).sort().join(',') !== saveKeys) {
    throw new Error('image save request is invalid');
  }
  const { fileName } = value;
  if (
    typeof fileName !== 'string' ||
    !fileName.toLowerCase().endsWith('.png') ||
    fileName.length <= '.png'.length ||
    !isSafeWindowsPathPart(fileName)
  ) {
    throw new Error('image file name is invalid');
  }
  return Object.freeze({ fileName, ...validateExportImagePixels(value) });
}

export function previewImageFileName(documentUri: string | null | undefined): string {
  const fallback = 'map.png';
  if (!documentUri) return fallback;
  let name = documentUri.replace(/[?#].*$/su, '');
  name = name.split(/[\\/]/u).pop() ?? '';
  name = name.replace(/^[a-z][a-z0-9+.-]*:/iu, '');
  try {
    name = decodeURIComponent(name);
  } catch {
    return fallback;
  }
  const stem = name.replace(/\.[^.]*$/u, '').trim();
  const candidate = `${stem}.png`;
  return stem && isSafeWindowsPathPart(candidate) ? candidate : fallback;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
