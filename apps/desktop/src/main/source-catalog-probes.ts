import { lstat, opendir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Stats } from 'node:fs';
import { desktopErrorMessage } from '../shared/desktop-error';
import { FileTooLargeError, hashFileBounded } from './bounded-file';
import { RequiredSourceLimitError } from './source-catalog-limits';

const maximumPaths = 4096;
const maximumMetadataBytes = 2 * 1024 * 1024;
const maximumDirectoryVisits = 65_536;
const maximumDepth = 64;
const validationConcurrency = 8;

export class SourceCatalogDiscoveryError extends Error {
  readonly scope: string;
  constructor(
    readonly reason: 'paths' | 'metadata' | 'directory-visits' | 'depth' | 'stale' | 'authority',
    scope: string,
    readonly used: number,
    readonly maximum: number,
  ) {
    super(
      reason === 'stale'
        ? desktopErrorMessage(
            'source-catalog.stale',
            'Sources changed while includes were being checked. Run again.',
          )
        : desktopErrorMessage(
            `source-catalog.${reason}`,
            `Source catalog discovery ${reason}: ${scope.slice(0, 512)} (${used}/${maximum}). Keep required includes in a smaller authorized directory, or retry after source changes finish.`,
            { scope: scope.slice(0, 512), used, maximum },
          ),
    );
    this.name = 'SourceCatalogDiscoveryError';
    this.scope = scope.slice(0, 512);
  }
}

export class SourceDiscoveryBudget {
  metadataBytes = 0;
  constructor(private readonly beforeCharge?: (bytes: number) => void) {}

  charge(scope: string, bytes: number, required = false): void {
    this.beforeCharge?.(bytes);
    this.metadataBytes += bytes;
    if (this.metadataBytes > maximumMetadataBytes) {
      if (required)
        throw new RequiredSourceLimitError(
          'metadata',
          scope,
          this.metadataBytes,
          maximumMetadataBytes,
        );
      throw new SourceCatalogDiscoveryError(
        'metadata',
        scope,
        this.metadataBytes,
        maximumMetadataBytes,
      );
    }
  }
}

interface Root {
  path: string;
  virtualRoot: string;
}
interface DirectoryEntry {
  name: string;
  directory: boolean;
  file: boolean;
}
interface DirectorySnapshot {
  entries: readonly DirectoryEntry[];
  identity: string;
  root: string;
}
export interface SourceCatalogProbeMatch {
  path: string;
  normalizedPath: string;
}

export class SourceCatalogProbes {
  private readonly probes = new Map<string, readonly SourceCatalogProbeMatch[]>();
  private readonly directories = new Map<string, DirectorySnapshot>();
  private readonly files = new Map<string, { identity: string; root: string }>();
  private readonly rootIdentities = new Map<string, string>();
  private readonly bodies = new Map<string, { hash: string; bytes: number }>();
  private initialized: Promise<void> | undefined;
  private validation: Promise<void> | undefined;
  private nextValidation: Promise<void> | undefined;
  private directoryVisits = 0;

  constructor(
    private readonly roots: readonly Root[],
    private readonly budget = new SourceDiscoveryBudget(),
    private assertActive: () => void = () => {},
  ) {}

  finishReadPhase(): void {
    this.assertActive = () => {};
  }

  initialize(): Promise<void> {
    return (this.initialized ??= (async () => {
      for (const root of this.roots) {
        this.assertActive();
        const metadata = await checkedMetadata(root.path, root.path);
        if (!metadata?.isDirectory())
          throw new SourceCatalogDiscoveryError('stale', root.path, 1, 0);
        this.charge(
          root.path,
          Buffer.byteLength(root.path, 'utf8') + Buffer.byteLength(root.virtualRoot, 'utf8') + 48,
        );
        this.rootIdentities.set(root.path, `${metadata.dev}:${metadata.ino}`);
      }
    })());
  }

  diagnostics(): { probePaths: number; metadataBytes: number; directoryVisits: number } {
    return {
      probePaths: this.probes.size,
      metadataBytes: this.budget.metadataBytes,
      directoryVisits: this.directoryVisits,
    };
  }

  recordContent(path: string, hash: Uint8Array, bytes: number): void {
    if (!this.files.has(path) || hash.byteLength !== 32)
      throw new SourceCatalogDiscoveryError('authority', path, 1, 0);
    const value = { hash: Buffer.from(hash).toString('hex'), bytes };
    const previous = this.bodies.get(path);
    if (previous && (previous.hash !== value.hash || previous.bytes !== value.bytes))
      throw new SourceCatalogDiscoveryError('stale', path, 1, 0);
    if (!previous) this.charge(path, 80);
    this.bodies.set(path, value);
  }

  async recordClosedFile(
    match: SourceCatalogProbeMatch,
    hash: Uint8Array,
    bytes: number,
  ): Promise<void> {
    await this.initialize();
    this.assertActive();
    const root = this.roots.find((candidate) =>
      asciiFold(match.normalizedPath).startsWith(`${asciiFold(candidate.virtualRoot)}/`),
    );
    if (!root || !inside(match.path, root.path))
      throw new SourceCatalogDiscoveryError('authority', match.normalizedPath, 1, 0);
    const metadata = await checkedMetadata(match.path, root.path);
    if (!metadata?.isFile() || metadata.size !== bytes)
      throw new SourceCatalogDiscoveryError('stale', match.normalizedPath, 1, 0);
    const previous = this.files.get(match.path);
    if (previous && previous.identity !== identity(metadata))
      throw new SourceCatalogDiscoveryError('stale', match.normalizedPath, 1, 0);
    if (!previous) {
      if (this.files.size >= maximumPaths)
        throw new SourceCatalogDiscoveryError(
          'paths',
          match.normalizedPath,
          this.files.size + 1,
          maximumPaths,
        );
      this.charge(
        match.normalizedPath,
        Buffer.byteLength(match.path, 'utf8') +
          Buffer.byteLength(match.normalizedPath, 'utf8') +
          48,
      );
      this.files.set(match.path, { identity: identity(metadata), root: root.path });
    }
    this.recordContent(match.path, hash, bytes);
    this.assertActive();
  }

  async probe(virtualPath: string): Promise<readonly SourceCatalogProbeMatch[]> {
    this.assertActive();
    await this.initialize();
    const key = asciiFold(virtualPath);
    const cached = this.probes.get(key);
    if (cached) return cached;
    if (this.probes.size >= maximumPaths)
      throw new SourceCatalogDiscoveryError(
        'paths',
        virtualPath,
        this.probes.size + 1,
        maximumPaths,
      );
    if (
      virtualPath.length > 16_384 ||
      virtualPath.includes('\\') ||
      virtualPath.includes(':') ||
      virtualPath.includes('\0') ||
      virtualPath.split('/').some((part) => !part || part === '.' || part === '..')
    ) {
      throw new SourceCatalogDiscoveryError('authority', virtualPath, 1, 0);
    }
    this.charge(virtualPath, Buffer.byteLength(virtualPath, 'utf8') + 32);
    const root = this.roots.find((candidate) =>
      key.startsWith(`${asciiFold(candidate.virtualRoot)}/`),
    );
    if (!root) {
      if (!key.startsWith('entry/') && !key.startsWith('implicit/'))
        throw new SourceCatalogDiscoveryError('authority', virtualPath, 1, 0);
      this.probes.set(key, []);
      return [];
    }
    const parts = virtualPath.slice(root.virtualRoot.length + 1).split('/');
    if (parts.length > maximumDepth)
      throw new SourceCatalogDiscoveryError('depth', virtualPath, parts.length, maximumDepth);
    let pending = [{ path: root.path, normalizedPath: root.virtualRoot }];
    for (const [index, part] of parts.entries()) {
      const last = index === parts.length - 1;
      const next: SourceCatalogProbeMatch[] = [];
      for (const parent of pending) {
        for (const entry of await this.directory(parent.path, root.path)) {
          if (asciiFold(entry.name) !== asciiFold(part) || (last ? !entry.file : !entry.directory))
            continue;
          const path = join(parent.path, entry.name);
          const metadata = await checkedMetadata(path, root.path);
          if (!metadata || (last ? !metadata.isFile() : !metadata.isDirectory())) continue;
          const match = { path, normalizedPath: `${parent.normalizedPath}/${entry.name}` };
          this.charge(path, Buffer.byteLength(match.normalizedPath, 'utf8') + 48);
          next.push(match);
          if (last) this.files.set(path, { identity: identity(metadata), root: root.path });
        }
      }
      pending = next;
      if (pending.length === 0) break;
    }
    pending.sort((left, right) =>
      Buffer.compare(Buffer.from(left.normalizedPath), Buffer.from(right.normalizedPath)),
    );
    this.probes.set(key, pending);
    return pending;
  }

  async inventory(
    include: (match: SourceCatalogProbeMatch) => boolean,
  ): Promise<readonly SourceCatalogProbeMatch[]> {
    await this.initialize();
    const files: SourceCatalogProbeMatch[] = [];
    for (const root of this.roots) {
      const pending = [{ path: root.path, normalizedPath: root.virtualRoot, depth: 0 }];
      for (let at = 0; at < pending.length; at += 1) {
        this.assertActive();
        const parent = pending[at]!;
        for (const entry of await this.directory(parent.path, root.path)) {
          this.assertActive();
          const match = {
            path: join(parent.path, entry.name),
            normalizedPath: `${parent.normalizedPath}/${entry.name}`,
          };
          if (entry.directory) {
            const depth = parent.depth + 1;
            if (depth >= maximumDepth)
              throw new SourceCatalogDiscoveryError(
                'depth',
                match.normalizedPath,
                depth + 1,
                maximumDepth,
              );
            this.charge(
              match.normalizedPath,
              Buffer.byteLength(match.path, 'utf8') +
                Buffer.byteLength(match.normalizedPath, 'utf8') +
                48,
            );
            pending.push({ ...match, depth });
          } else if (entry.file && include(match)) {
            if (files.length >= maximumPaths)
              throw new SourceCatalogDiscoveryError(
                'paths',
                match.normalizedPath,
                files.length + 1,
                maximumPaths,
              );
            const metadata = await checkedMetadata(match.path, root.path);
            if (!metadata?.isFile())
              throw new SourceCatalogDiscoveryError('stale', match.normalizedPath, 1, 0);
            this.charge(
              match.normalizedPath,
              Buffer.byteLength(match.path, 'utf8') +
                Buffer.byteLength(match.normalizedPath, 'utf8') +
                48,
            );
            this.files.set(match.path, { identity: identity(metadata), root: root.path });
            files.push(match);
          }
        }
      }
    }
    return files.sort((left, right) =>
      Buffer.compare(Buffer.from(left.normalizedPath), Buffer.from(right.normalizedPath)),
    );
  }

  assertCurrent(): Promise<void> {
    if (!this.validation) {
      const pass: Promise<void> = this.validatePass().finally(() => {
        if (this.validation === pass) this.validation = undefined;
      });
      this.validation = pass;
      return pass;
    }
    this.nextValidation ??= this.validation
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => {
        this.nextValidation = undefined;
        return this.assertCurrent();
      });
    return this.nextValidation;
  }

  private async validatePass(): Promise<void> {
    await this.initialize();
    await this.assertRootIdentities();
    const ancestors: AncestorChecks = new Map();
    let visits = 0;
    await boundedEach([...this.directories], validationConcurrency, async ([path, snapshot]) => {
      this.assertActive();
      const before = await checkedMetadata(path, snapshot.root, ancestors);
      if (!before?.isDirectory() || identity(before) !== snapshot.identity)
        throw new SourceCatalogDiscoveryError('stale', path, 1, 0);
      const remaining = new Map(snapshot.entries.map((entry) => [entry.name, entry]));
      const directory = await opendir(path);
      for await (const entry of directory) {
        this.assertActive();
        visits += 1;
        if (visits > maximumDirectoryVisits)
          throw new SourceCatalogDiscoveryError(
            'directory-visits',
            path,
            visits,
            maximumDirectoryVisits,
          );
        if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) continue;
        const expected = remaining.get(entry.name);
        if (
          !expected ||
          expected.directory !== entry.isDirectory() ||
          expected.file !== entry.isFile()
        )
          throw new SourceCatalogDiscoveryError('stale', path, 1, 0);
        remaining.delete(entry.name);
      }
      const after = await checkedMetadata(path, snapshot.root, ancestors);
      if (!after || identity(after) !== snapshot.identity || remaining.size !== 0)
        throw new SourceCatalogDiscoveryError('stale', path, 1, 0);
    });
    await boundedEach([...this.files], validationConcurrency, async ([path, snapshot]) => {
      this.assertActive();
      const body = this.bodies.get(path);
      if (!body) {
        const metadata = await checkedMetadata(path, snapshot.root, ancestors);
        if (!metadata || identity(metadata) !== snapshot.identity)
          throw new SourceCatalogDiscoveryError('stale', path, 1, 0);
        return;
      }
      const hash = await hashFileBounded(path, body.bytes, (opened) =>
        this.authorizePassRead(path, opened, ancestors),
      ).catch((error: unknown) => {
        if (error instanceof FileTooLargeError)
          throw new SourceCatalogDiscoveryError('stale', path, 1, 0);
        throw error;
      });
      if (hash.toString('hex') !== body.hash)
        throw new SourceCatalogDiscoveryError('stale', path, 1, 0);
      await this.authorizePassRead(path, await lstat(path), ancestors);
    });
    await this.assertRootIdentities();
  }

  private async assertRootIdentities(): Promise<void> {
    for (const [path, expected] of this.rootIdentities) {
      this.assertActive();
      const metadata = await checkedMetadata(path, path);
      if (!metadata?.isDirectory() || `${metadata.dev}:${metadata.ino}` !== expected)
        throw new SourceCatalogDiscoveryError('stale', path, 1, 0);
    }
  }

  private async authorizePassRead(
    path: string,
    metadata: Stats,
    ancestors: AncestorChecks,
  ): Promise<void> {
    this.assertActive();
    const expected = this.files.get(path);
    if (!expected || !metadata.isFile() || identity(metadata) !== expected.identity)
      throw new SourceCatalogDiscoveryError('stale', path, 1, 0);
    const current = await checkedMetadata(path, expected.root, ancestors);
    if (!current?.isFile() || identity(current) !== expected.identity)
      throw new SourceCatalogDiscoveryError('stale', path, 1, 0);
    this.assertActive();
  }

  async authorizeRead(path: string, metadata: Stats): Promise<void> {
    this.assertActive();
    const expected = this.files.get(path);
    if (!expected || !metadata.isFile() || identity(metadata) !== expected.identity)
      throw new SourceCatalogDiscoveryError('stale', path, 1, 0);
    const root = await checkedMetadata(expected.root, expected.root);
    if (
      !root?.isDirectory() ||
      `${root.dev}:${root.ino}` !== this.rootIdentities.get(expected.root)
    )
      throw new SourceCatalogDiscoveryError('stale', expected.root, 1, 0);
    const current = await checkedMetadata(path, expected.root);
    if (!current?.isFile() || identity(current) !== expected.identity)
      throw new SourceCatalogDiscoveryError('stale', path, 1, 0);
    this.assertActive();
  }

  async authorizeOverlay(match: SourceCatalogProbeMatch): Promise<void> {
    await this.initialize();
    const root = this.roots.find((root) =>
      asciiFold(match.normalizedPath).startsWith(`${asciiFold(root.virtualRoot)}/`),
    );
    if (!root || !inside(match.path, root.path))
      throw new SourceCatalogDiscoveryError('authority', match.normalizedPath, 1, 0);
    await checkedMetadata(match.path, root.path);
  }

  private async directory(path: string, root: string): Promise<readonly DirectoryEntry[]> {
    const known = this.directories.get(path);
    if (known) return known.entries;
    const before = await checkedMetadata(path, root);
    if (!before || !before.isDirectory()) return [];
    const entries: DirectoryEntry[] = [];
    const directory = await opendir(path);
    for await (const entry of directory) {
      this.assertActive();
      this.directoryVisits += 1;
      if (this.directoryVisits > maximumDirectoryVisits)
        throw new SourceCatalogDiscoveryError(
          'directory-visits',
          path,
          this.directoryVisits,
          maximumDirectoryVisits,
        );
      this.charge(path, Buffer.byteLength(entry.name, 'utf8') + 24);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() || entry.isFile())
        entries.push({ name: entry.name, directory: entry.isDirectory(), file: entry.isFile() });
    }
    const after = await checkedMetadata(path, root);
    if (!after || identity(before) !== identity(after))
      throw new SourceCatalogDiscoveryError('stale', path, 1, 0);
    const snapshot = { entries, identity: identity(after), root };
    this.directories.set(path, snapshot);
    return entries;
  }

  private charge(scope: string, bytes: number): void {
    this.budget.charge(scope, bytes);
  }
}

export function asciiFold(value: string): string {
  return value.replace(/[A-Z]/gu, (letter) => letter.toLowerCase());
}
function inside(path: string, root: string): boolean {
  const suffix = relative(resolve(root), resolve(path));
  return suffix === '' || (!suffix.startsWith('..') && !isAbsolute(suffix));
}
type AncestorChecks = Map<string, Promise<void>>;

async function checkedComponent(cursor: string, path: string): Promise<void> {
  try {
    if ((await lstat(cursor)).isSymbolicLink())
      throw new SourceCatalogDiscoveryError('authority', path, 1, 0);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
      (error as NodeJS.ErrnoException).code !== 'ENOTDIR'
    )
      throw error;
  }
}

async function checkedMetadata(path: string, root: string, ancestors?: AncestorChecks) {
  if (!inside(path, root)) throw new SourceCatalogDiscoveryError('authority', path, 1, 0);
  for (let cursor = path; ; cursor = dirname(cursor)) {
    if (cursor === path || !ancestors) {
      await checkedComponent(cursor, path);
    } else {
      let check = ancestors.get(cursor);
      if (!check) {
        check = checkedComponent(cursor, path);
        ancestors.set(cursor, check);
      }
      await check;
    }
    if (resolve(cursor) === resolve(root)) break;
    if (dirname(cursor) === cursor) throw new SourceCatalogDiscoveryError('authority', path, 1, 0);
  }
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new SourceCatalogDiscoveryError('authority', path, 1, 0);
    const canonical = await realpath(path);
    if (!inside(canonical, root)) throw new SourceCatalogDiscoveryError('authority', path, 1, 0);
    return metadata;
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'ENOENT' ||
      (error as NodeJS.ErrnoException).code === 'ENOTDIR'
    )
      return null;
    throw error;
  }
}
async function boundedEach<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async () => {
    while (!failure && next < items.length) {
      const item = items[next++]!;
      try {
        await work(item);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw failure.error;
}
function identity(metadata: NonNullable<Awaited<ReturnType<typeof checkedMetadata>>>): string {
  return `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`;
}
