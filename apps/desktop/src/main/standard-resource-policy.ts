import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DesktopError } from '../shared/desktop-error';
import { t } from '../shared/i18n/translator';

interface PackagedStandardIncludeInventory {
  $schema: string;
  schemaVersion: string;
  build: string;
  compatibility: { minimumMajor: number; maximumMajor: number };
  reservedFileNames: string[];
  standardIncludes: string[];
}

const inventories = Object.entries(
  import.meta.glob<PackagedStandardIncludeInventory>(
    '../../../../crates/rms-content/data/aoe2de-*-standard-includes.json',
    { eager: true, import: 'default' },
  ),
);
const expectedNames = new Set(['random_map.def']);
if (inventories.length < 1 || inventories.length > 16) {
  throw new Error('packaged standard resource inventory is invalid');
}
for (const [file, inventory] of inventories) {
  const includes = inventory.standardIncludes;
  const names = new Set(['random_map.def']);
  let previousInclude = '';
  for (const path of includes) {
    const canonical = path.toLowerCase();
    if (
      canonical <= previousInclude ||
      path.includes('..') ||
      !/^(?:includes\/)?[a-z0-9_.-]+\.inc$/iu.test(path)
    ) {
      throw new Error('packaged standard resource inventory is invalid');
    }
    previousInclude = canonical;
    names.add(path.split('/').at(-1)!.toLowerCase());
  }
  const expectedReserved = [...names].sort();
  if (
    /aoe2de-(\d{1,10}\.\d{1,10}\.\d{1,10})-standard-includes\.json$/u.exec(file)?.[1] !==
      inventory.build ||
    inventory.$schema !== 'https://rmside.invalid/schemas/standard-includes/v1' ||
    inventory.schemaVersion !== '1.0.0' ||
    inventory.compatibility.minimumMajor !== 1 ||
    inventory.compatibility.maximumMajor !== 1 ||
    includes.length < 1 ||
    includes.length > 512 ||
    inventory.reservedFileNames.length !== expectedReserved.length ||
    inventory.reservedFileNames.some((name, index) => name !== expectedReserved[index])
  ) {
    throw new Error('packaged standard resource inventory is invalid');
  }
  for (const name of names) expectedNames.add(name);
}
const maximumLocalEntries = 512;
const maximumLocalDepth = 8;

export async function readLocalStandardIncludePaths(installationRoot: string): Promise<string[]> {
  const root = join(installationRoot, 'resources', '_common', 'random-map-scripts');
  try {
    if (!(await lstat(root)).isDirectory())
      throw new DesktopError('game-folder.unsafe', 'standard include root is not a directory');
  } catch (error) {
    if (isMissingPath(error)) return [];
    throw error;
  }
  const paths: string[] = [];
  let visited = 0;
  const visit = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > maximumLocalDepth) {
      throw new DesktopError('game-folder.unsafe', 'standard include tree exceeds depth limit');
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      visited += 1;
      if (visited > maximumLocalEntries)
        throw new DesktopError('game-folder.unsafe', 'standard include tree exceeds entry limit');
      if (entry.isSymbolicLink()) continue;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await visit(join(directory, entry.name), relativePath, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.inc')) {
        paths.push(relativePath);
      }
    }
  };
  await visit(root, '', 0);
  return paths.sort((left, right) => left.localeCompare(right, 'en-US'));
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export class StandardResourcePolicy {
  private localNames = new Set<string>();
  private localRevision = 0;

  get revision(): number {
    return this.localRevision;
  }

  setLocalIncludePaths(paths: readonly string[]): boolean {
    if (paths.length > maximumLocalEntries) throw new Error('too many local standard includes');
    const next = new Set<string>();
    for (const path of paths) {
      if (path.includes('..') || !/^[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)*\.inc$/iu.test(path)) {
        throw new DesktopError('game-folder.unsafe', 'invalid local standard include path');
      }
      next.add(path.split('/').at(-1)!.toLowerCase());
    }
    if (
      next.size === this.localNames.size &&
      [...next].every((name) => this.localNames.has(name))
    ) {
      return false;
    }
    this.localNames = next;
    this.localRevision += 1;
    return true;
  }

  isReservedFileName(fileName: string): boolean {
    const name = fileName.toLocaleLowerCase('en-US');
    return expectedNames.has(name) || this.localNames.has(name);
  }

  reservedFileNames(): string[] {
    return [...new Set([...expectedNames, ...this.localNames])].sort();
  }

  assertCreatableFileName(fileName: string): void {
    if (this.isReservedFileName(fileName)) {
      throw new Error(t('file-actions.entry.reserved-name', { name: fileName }));
    }
  }

  suggestUnreservedFileName(fileName: string): string {
    if (!this.isReservedFileName(fileName)) return fileName;
    const dot = fileName.lastIndexOf('.');
    const stem = dot < 0 ? fileName : fileName.slice(0, dot);
    const extension = dot < 0 ? '' : fileName.slice(dot);
    for (let ordinal = 1; ordinal <= expectedNames.size + this.localNames.size + 1; ordinal += 1) {
      const suffix = ordinal === 1 ? '-local' : `-local-${ordinal}`;
      const candidate = `${stem.slice(0, 255 - extension.length - suffix.length)}${suffix}${extension}`;
      if (!this.isReservedFileName(candidate)) return candidate;
    }
    throw new Error('no safe filename suggestion is available');
  }
}
