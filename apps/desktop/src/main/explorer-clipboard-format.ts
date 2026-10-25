import { extname, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DesktopError } from '../shared/desktop-error';
import type { WorkspaceEntryKind } from '../shared/api';

export const explorerCopyBounds = Object.freeze({
  items: 64,
  entries: 4_096,
  bytes: 256 * 1024 * 1024,
});

const maximumFileListLength = explorerCopyBounds.items * 3 * 32_768;

export const maximumFileListBytes = maximumFileListLength * 3;

const maximumNameBytes = 255;

export function copyEntryName(name: string, kind: WorkspaceEntryKind, ordinal: number): string {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) throw new Error('copy ordinal is invalid');
  const extension = kind === 'file' ? extname(name) : '';
  let stem = [...name.slice(0, name.length - extension.length)];
  const suffix = ordinal === 1 ? ' - Copy' : ` - Copy (${ordinal})`;
  const bytes = (characters: readonly string[]) =>
    Buffer.byteLength(`${characters.join('')}${suffix}${extension}`, 'utf8');
  while (stem.length > 0 && bytes(stem) > maximumNameBytes) stem = stem.slice(0, -1);
  if (bytes(stem) > maximumNameBytes) throw new Error('copy name does not fit');
  return `${stem.join('')}${suffix}${extension}`;
}

export function encodeFileUriList(paths: readonly string[]): string {
  if (paths.length < 1 || paths.length > explorerCopyBounds.items) {
    throw new Error('clipboard file list must hold 1 to 64 paths');
  }
  return paths
    .map((path) => {
      if (!isAbsolute(path)) throw new Error('clipboard file list paths must be absolute');
      return pathToFileURL(path).href;
    })
    .join('\r\n');
}

export function decodeFileUriList(text: string): string[] | null {
  if (typeof text !== 'string') return null;
  if (text.length > maximumFileListLength) throw tooManyItemsError();
  const paths: string[] = [];
  for (const raw of text.split(/\r\n|\r|\n/u)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    if (!/^file:/iu.test(line)) return null;
    let path: string;
    try {
      path = fileURLToPath(line);
    } catch {
      return null;
    }
    if (!isAbsolute(path) || path.includes('\u0000')) return null;
    paths.push(path);
    if (paths.length > explorerCopyBounds.items) throw tooManyItemsError();
  }
  return paths.length > 0 ? paths : null;
}

export function tooManyItemsError(): DesktopError {
  return new DesktopError('files.paste-too-many', 'paste 1 to 64 items at once', {
    limit: explorerCopyBounds.items,
  });
}
