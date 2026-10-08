import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface IncludeGrantSource {
  sourceId: string;
  source: Uint8Array;
}

export interface IncludeGrantContext {
  entrySourceId: string;
  broadRoots: readonly string[];
  resolutionRoots: readonly string[];
}

const rmsIncludePattern = /#include(?:_drs|xs)?[ \t]+(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"']+))/giu;
const xsIncludePattern = /\binclude[ \t]+"([^"\r\n]+)"/gu;
const rmsFamilyExtensions = new Set(['.rms', '.rms2', '.inc', '.def']);

export function namedIncludePaths(path: string, bytes: Uint8Array): string[] {
  const extension = extname(path).toLocaleLowerCase('en-US');
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
  const pattern =
    extension === '.xs'
      ? xsIncludePattern
      : rmsFamilyExtensions.has(extension)
        ? rmsIncludePattern
        : null;
  if (!pattern) return [];
  const paths: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const named = (match[1] ?? match[2] ?? match[3] ?? '').trim().replaceAll('\\', '/');
    if (named) paths.push(named);
  }
  return paths;
}

export function includeTargetPath(base: string, includePath: string): string | null {
  const segments = includePath.split('/');
  if (
    includePath.length > 1024 ||
    includePath.startsWith('/') ||
    includePath.includes(':') ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    return null;
  }
  const target = resolve(base, ...segments);
  return isInside(target, base) ? target : null;
}

export function authorizedIncludeSourceIds(
  sources: readonly IncludeGrantSource[],
  context: IncludeGrantContext,
): Set<string> {
  const byPath = new Map<string, IncludeGrantSource & { path: string }>();
  for (const source of sources) {
    const path = diskPath(source.sourceId);
    if (path) byPath.set(pathKey(path), { ...source, path });
  }
  const authorized = new Set<string>();
  for (const source of byPath.values()) {
    if (context.broadRoots.some((root) => isInside(source.path, root))) {
      authorized.add(source.sourceId);
    }
  }
  const entry =
    sources.find((source) => source.sourceId === context.entrySourceId) ??
    [...byPath.values()].find(
      (source) =>
        diskPath(context.entrySourceId) !== null &&
        pathKey(source.path) === pathKey(diskPath(context.entrySourceId)!),
    );
  if (!entry) return authorized;
  const entryPath = diskPath(entry.sourceId);
  const bases = [...(entryPath ? [dirname(entryPath)] : []), ...context.resolutionRoots];
  const visited = new Set<string>();
  const pending: IncludeGrantSource[] = [entry];
  authorized.add(entry.sourceId);
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current.sourceId)) continue;
    visited.add(current.sourceId);
    const currentPath = diskPath(current.sourceId);
    const currentBases = currentPath ? [dirname(currentPath), ...bases] : bases;
    const name = currentPath ?? entryPath ?? 'entry.rms';
    for (const includePath of namedIncludePaths(name, current.source)) {
      for (const base of currentBases) {
        const target = includeTargetPath(base, includePath);
        const source = target ? byPath.get(pathKey(target)) : undefined;
        if (!source) continue;
        authorized.add(source.sourceId);
        if (!visited.has(source.sourceId)) pending.push(source);
      }
    }
  }
  return authorized;
}

function diskPath(sourceId: string): string | null {
  if (!sourceId.startsWith('file:')) return null;
  try {
    return fileURLToPath(sourceId);
  } catch {
    return null;
  }
}

function pathKey(path: string): string {
  return resolve(path).replaceAll('\\', '/').toLocaleLowerCase('en-US');
}

function isInside(path: string, root: string): boolean {
  const child = relative(pathKey(root), pathKey(path));
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}
