import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import type {
  InstalledSourceCatalog,
  InstalledSourceCloneResult,
  InstalledSourceEntry,
  InstalledSourceOwnership,
  InstalledSourceRoot,
  InstallationReport,
  RememberedInstallationSelection,
  WorkspaceOpenResult,
} from '../shared/api';
import type { OutputWords } from '../shared/output-message';
import { managedModContract, managedModDirectoryName } from './managed-deployment-service';
import type { WorkspaceService } from './workspace-service';
import { readFileBounded } from './bounded-file';
import { DesktopError } from '../shared/desktop-error';

const maximumRoots = 4_096;
const maximumEntries = 20_000;
const maximumDepth = 64;
const maximumCloneFiles = 2_048;
const maximumCloneBytes = 64 * 1024 * 1024;
const maximumSourceBytes = 4 * 1024 * 1024;
const maximumOwnershipMarkerBytes = 64 * 1024;
const rmsEntryExtensions = new Set(['.rms', '.rms2']);
const cloneAssetExtensions = new Set(['.rms', '.rms2', '.inc', '.def', '.xs']);

interface RootCapability {
  rootId: string;
  installationRoot: string;
  profileId: string | null;
  ownership: InstalledSourceOwnership;
  readOnly: boolean;
  sourceRoot: string;
  ownershipRoot: string;
  xsRoot: string | null;
}

interface SourceCapability {
  sourceId: string;
  path: string;
  relativePath: string;
  root: RootCapability;
}

interface IndexedFile {
  path: string;
  relativePath: string;
}

interface IncludeDirective {
  kind: 'include' | 'include_drs' | 'includeXS';
  requested: string;
}

export class InstalledSourceService {
  private readonly roots = new Map<string, RootCapability>();
  private readonly sources = new Map<string, SourceCapability>();
  private readonly installations = new Map<string, string>();
  private protectedRoots: string[] = [];

  constructor(
    private readonly workspace: WorkspaceService,
    private readonly isOwnedPersistentTarget: (
      installationRoot: string,
      profileRoot: string,
      profileId: string,
      modName: string,
    ) => Promise<boolean> = async () => false,
  ) {}

  async discover(
    reports: readonly InstallationReport[],
    remembered: RememberedInstallationSelection | null,
  ): Promise<InstalledSourceCatalog> {
    this.roots.clear();
    this.sources.clear();
    this.installations.clear();
    const profiles: InstalledSourceCatalog['profiles'] = [];
    const roots: InstalledSourceRoot[] = [];
    const entries: InstalledSourceEntry[] = [];
    const diagnostics: OutputWords[] = [];
    const protectedRoots: string[] = [];
    let managedOutputsOmitted = 0;

    for (const report of reports.slice(0, 32)) {
      if (!report.valid) {
        diagnostics.push({ id: 'linked-game.installed-maps.installation-unreadable' });
        continue;
      }
      const installationRoot = await canonicalDirectory(
        report.evidence.installationRoot.value,
      ).catch(() => null);
      if (!installationRoot) {
        diagnostics.push({ id: 'linked-game.installed-maps.installation-unavailable' });
        continue;
      }
      const installationId = opaqueId('installation', installationRoot);
      if (this.installations.has(installationId)) continue;
      this.installations.set(installationId, installationRoot);
      const installationLabel = report.evidence.productVersion?.value
        ? `${basename(installationRoot)} (${report.evidence.productVersion.value})`
        : basename(installationRoot);
      profiles.push({
        installationId,
        installationLabel,
        installationKind: report.kind,
        productVersion: report.evidence.productVersion?.value ?? null,
        profileId: null,
        profileSelected:
          samePath(remembered?.installationRoot ?? '', installationRoot) &&
          remembered?.userProfileId === undefined,
      });
      for (const evidence of report.evidence.builtInRmsRoots) {
        await this.addRoot({
          installationId,
          installationRoot,
          profileId: null,
          label: `Built-in · ${basename(evidence.value)}`,
          displayRoot: relative(installationRoot, evidence.value).replaceAll('\\', '/'),
          ownership: 'built-in',
          readOnly: true,
          requestedSourceRoot: evidence.value,
          requestedOwnershipRoot: evidence.value,
          requestedXsRoot: null,
          roots,
          entries,
          diagnostics,
        });
      }

      for (const profile of report.evidence.userProfiles) {
        protectedRoots.push(resolve(profile.source, 'mods', 'local', managedModDirectoryName));
        const canonicalProfile = await realpath(profile.source).catch(() => null);
        if (canonicalProfile) {
          protectedRoots.push(join(canonicalProfile, 'mods', 'local', managedModDirectoryName));
        }
        profiles.push({
          installationId,
          installationLabel,
          installationKind: report.kind,
          productVersion: report.evidence.productVersion?.value ?? null,
          profileId: profile.value,
          profileSelected:
            samePath(remembered?.installationRoot ?? '', installationRoot) &&
            remembered?.userProfileId === profile.value,
        });
        for (const ownership of ['local', 'subscribed'] as const) {
          const modsRoot = join(profile.source, 'mods', ownership);
          for (const modName of await listRegularDirectories(modsRoot)) {
            if (isLegacyEsMapsMod(modName)) continue;
            if (this.roots.size >= maximumRoots) {
              diagnostics.push({ id: 'linked-game.installed-maps.root-limit' });
              break;
            }
            const modRoot = join(modsRoot, modName);
            if (
              ownership === 'local' &&
              ((await isManagedDeploymentOutput(modName, modRoot)) ||
                (await this.isOwnedPersistentTarget(
                  installationRoot,
                  profile.source,
                  profile.value,
                  modName,
                )))
            ) {
              protectedRoots.push(await canonicalDirectory(modRoot).catch(() => resolve(modRoot)));
              managedOutputsOmitted += 1;
              continue;
            }
            const sourceRoot = join(modRoot, 'resources', '_common', 'random-map-scripts');
            if (!(await isRegularDirectory(sourceRoot))) continue;
            await this.addRoot({
              installationId,
              installationRoot,
              profileId: profile.value,
              label: `Profile ${profile.value} · ${ownership === 'local' ? 'Local' : 'Subscribed'} · ${modName}`,
              displayRoot: `mods/${ownership}/${modName}/resources/_common/random-map-scripts`,
              ownership,
              readOnly: ownership === 'subscribed',
              requestedSourceRoot: sourceRoot,
              requestedOwnershipRoot: modRoot,
              requestedXsRoot: join(modRoot, 'resources', '_common', 'xs'),
              roots,
              entries,
              diagnostics,
            });
          }
        }
      }
    }

    if (managedOutputsOmitted > 0) {
      diagnostics.push(
        `${managedOutputsOmitted} IDE-managed deployment output${managedOutputsOmitted === 1 ? ' was' : 's were'} omitted from editable installed sources.`,
      );
    }
    protectedRoots.push(...protectedRootsFor(this.roots.values()));
    this.protectedRoots = [...new Set(protectedRoots)];
    this.workspace.setInstalledProtectedRoots(this.protectedRoots);
    return Object.freeze({
      contractVersion: Object.freeze({ major: 1, minor: 1, patch: 0 }),
      profiles: profiles.sort(compareProfiles),
      roots: roots.sort((left, right) => compare(left.label, right.label)),
      entries: entries.sort((left, right) =>
        compare(`${left.relativePath}\0${left.rootId}`, `${right.relativePath}\0${right.rootId}`),
      ),
      diagnostics,
    });
  }

  async open(sourceId: string): Promise<WorkspaceOpenResult> {
    const source = this.requireSource(sourceId);
    const document = await this.workspace.openCatalogSource(source.path);
    return { documents: [document], folder: null };
  }

  selection(installationId: string, profileId: string): RememberedInstallationSelection {
    if (!/^installation:[a-f0-9]{64}$/u.test(installationId) || !/^[0-9]{3,20}$/u.test(profileId)) {
      throw new Error('installed profile selection is invalid');
    }
    const installationRoot = this.installations.get(installationId);
    if (!installationRoot) throw new Error('installed profile selection is stale');
    return { installationRoot, userProfileId: profileId };
  }

  async clone(sourceId: string, destinationParent: string): Promise<InstalledSourceCloneResult> {
    const source = this.requireSource(sourceId);
    const parent = await canonicalDirectory(destinationParent);
    const cloneName = `${safeCloneName(basename(source.path, extname(source.path)))}-editable`;
    const cloneRoot = join(parent, cloneName);
    if (
      [...this.roots.values()].some((root) => isInside(cloneRoot, root.ownershipRoot)) ||
      this.protectedRoots.some((root) => isInside(cloneRoot, root)) ||
      isInside(cloneRoot, source.root.installationRoot)
    ) {
      throw new DesktopError(
        'installed-source.clone-destination',
        'clone destination must be an ordinary folder outside installed sources',
      );
    }

    if (await pathExists(cloneRoot)) {
      throw new DesktopError(
        'installed-source.clone-exists',
        `clone destination ${cloneName} already exists`,
        { name: cloneName },
      );
    }
    const { files, unresolved } = await this.cloneClosure(source);
    for (const file of files) {
      this.workspace.standardResources.assertCreatableFileName(basename(file.relativePath));
    }
    const stage = await mkdtemp(join(parent, '.rmside-clone-'));
    try {
      for (const file of files) {
        const target = safeJoin(stage, file.relativePath);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, await boundedFile(file.path, maximumSourceBytes), { flag: 'wx' });
      }
      await rename(stage, cloneRoot);
    } catch (error) {
      await rm(stage, { recursive: true, force: true });
      throw error;
    }
    const entryRelativePath = relative(source.root.ownershipRoot, source.path);
    const entryPath = safeJoin(cloneRoot, entryRelativePath);
    const opened = await this.workspace.openPaths([cloneRoot, entryPath]);
    return {
      opened,
      entryPath,
      copiedRelativePaths: files
        .map((file) => file.relativePath.replaceAll('\\', '/'))
        .sort(compare),
      unresolvedExternalDependencies: [...unresolved].sort(compare),
    };
  }

  private async addRoot(input: {
    installationId: string;
    installationRoot: string;
    profileId: string | null;
    label: string;
    displayRoot: string;
    ownership: InstalledSourceOwnership;
    readOnly: boolean;
    requestedSourceRoot: string;
    requestedOwnershipRoot: string;
    requestedXsRoot: string | null;
    roots: InstalledSourceRoot[];
    entries: InstalledSourceEntry[];
    diagnostics: OutputWords[];
  }): Promise<void> {
    const sourceRoot = await canonicalDirectory(input.requestedSourceRoot).catch(() => null);
    const ownershipRoot = await canonicalDirectory(input.requestedOwnershipRoot).catch(() => null);
    if (!sourceRoot || !ownershipRoot || !isInside(sourceRoot, ownershipRoot)) return;
    const xsRoot = input.requestedXsRoot
      ? await canonicalDirectory(input.requestedXsRoot).catch(() => null)
      : null;
    const rootId = opaqueId(
      'root',
      `${input.installationId}\0${input.profileId ?? ''}\0${input.ownership}\0${sourceRoot}`,
    );
    const capability: RootCapability = {
      rootId,
      installationRoot: input.installationRoot,
      profileId: input.profileId,
      ownership: input.ownership,
      readOnly: input.readOnly,
      sourceRoot,
      ownershipRoot,
      xsRoot,
    };
    this.roots.set(rootId, capability);
    input.roots.push({
      rootId,
      installationId: input.installationId,
      profileId: input.profileId,
      label: input.label,
      ownership: input.ownership,
      readOnly: input.readOnly,
    });
    try {
      const discovered = await collectEntryFiles(sourceRoot);
      for (const file of discovered) {
        if (this.sources.size >= maximumEntries) {
          input.diagnostics.push({ id: 'linked-game.installed-maps.entry-limit' });
          return;
        }
        const relativePath = relative(sourceRoot, file).replaceAll('\\', '/');
        const sourceId = opaqueId(
          'source',
          `${rootId}\0${relativePath.toLocaleLowerCase('en-US')}`,
        );
        const extension = extname(file).toLocaleLowerCase('en-US') as '.rms' | '.rms2';
        this.sources.set(sourceId, { sourceId, path: file, relativePath, root: capability });
        input.entries.push({
          sourceId,
          rootId,
          name: basename(file),
          relativePath,
          displayPath: input.displayRoot ? `${input.displayRoot}/${relativePath}` : relativePath,
          extension,
          ownership: input.ownership,
          readOnly: input.readOnly,
        });
      }
    } catch (error) {
      input.diagnostics.push({
        id: 'linked-game.installed-maps.root-unreadable',
        args: { folder: input.displayRoot || input.label, error: diagnosticReason(error) },
      });
    }
  }

  private async cloneClosure(source: SourceCapability): Promise<{
    files: IndexedFile[];
    unresolved: Set<string>;
  }> {
    const index = await buildCloneIndex(source.root);
    const entryRelativePath = relative(source.root.ownershipRoot, source.path);
    const entry = index.get(pathKey(entryRelativePath));
    if (!entry) {
      throw new DesktopError(
        'installed-source.changed',
        'installed source entry is absent from its bounded source index',
      );
    }
    const selected = new Map<string, IndexedFile>([[pathKey(entry.relativePath), entry]]);
    const unresolved = new Set<string>();
    const queue = [entry];
    let bytes = 0;
    while (queue.length > 0) {
      const current = queue.shift()!;
      const content = await boundedFile(current.path, maximumSourceBytes);
      bytes += content.byteLength;
      if (bytes > maximumCloneBytes || selected.size > maximumCloneFiles) {
        throw new DesktopError(
          'installed-source.limit',
          'clone dependency closure exceeds its safety limit',
        );
      }
      if (extname(current.path).toLocaleLowerCase('en-US') === '.xs') continue;
      for (const directive of parseIncludeDirectives(content.toString('utf8'))) {
        if (directive.kind === 'include_drs' && source.root.ownership === 'built-in') {
          unresolved.add(`#include_drs ${directive.requested} (game-provided)`);
          continue;
        }
        const dependency = resolveCloneDependency(index, current, source.root, directive);
        if (!dependency) {
          unresolved.add(`#${directive.kind} ${directive.requested}`);
          continue;
        }
        const key = pathKey(dependency.relativePath);
        if (selected.has(key)) continue;
        selected.set(key, dependency);
        queue.push(dependency);
      }
    }
    return { files: [...selected.values()].sort(compareIndexedFiles), unresolved };
  }

  private requireSource(sourceId: string): SourceCapability {
    if (typeof sourceId !== 'string' || !/^source:[a-f0-9]{64}$/u.test(sourceId)) {
      throw new Error('installed source identity is invalid');
    }
    const source = this.sources.get(sourceId);
    if (!source) {
      throw new DesktopError(
        'installed-source.changed',
        'installed source identity is stale or unauthorized',
      );
    }
    return source;
  }
}

async function collectEntryFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  await walk(root, 0, async (path) => {
    if (!rmsEntryExtensions.has(extname(path).toLocaleLowerCase('en-US'))) return;
    if (files.length >= maximumEntries) {
      throw new DesktopError(
        'installed-source.limit',
        'installed-source entry count reached its safety limit',
      );
    }
    files.push(path);
  });
  return files.sort(compare);
}

async function buildCloneIndex(root: RootCapability): Promise<Map<string, IndexedFile>> {
  const files = new Map<string, IndexedFile>();
  await walk(root.ownershipRoot, 0, async (path) => {
    if (!cloneAssetExtensions.has(extname(path).toLocaleLowerCase('en-US'))) return;
    if (files.size >= maximumEntries) {
      throw new DesktopError(
        'installed-source.limit',
        'clone source index exceeds its safety limit',
      );
    }
    const relativePath = relative(root.ownershipRoot, path);
    files.set(pathKey(relativePath), { path, relativePath });
  });
  return files;
}

async function walk(
  root: string,
  depth: number,
  accept: (path: string) => Promise<void>,
): Promise<void> {
  if (depth > maximumDepth) {
    throw new DesktopError('installed-source.limit', 'installed-source traversal depth exceeded');
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const candidate = join(root, entry.name);
    if (entry.isDirectory()) {
      await walk(candidate, depth + 1, accept);
    } else if (entry.isFile()) {
      await accept(candidate);
    }
  }
}

function parseIncludeDirectives(source: string): IncludeDirective[] {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|[^:])\/\/.*$/gmu, '$1');
  const directives: IncludeDirective[] = [];
  const pattern = /^\s*#(includeXS|include_drs|include)\s+(?:"([^"]+)"|<([^>]+)>|([^\s;]+))/gimu;
  for (const match of withoutComments.matchAll(pattern)) {
    const requested = (match[2] ?? match[3] ?? match[4] ?? '').trim();
    if (!requested) continue;
    const matchedKind = match[1]!.toLowerCase();
    const kind: IncludeDirective['kind'] =
      matchedKind === 'includexs'
        ? 'includeXS'
        : matchedKind === 'include_drs'
          ? 'include_drs'
          : 'include';
    directives.push({ kind, requested });
  }
  return directives;
}

function resolveCloneDependency(
  index: ReadonlyMap<string, IndexedFile>,
  current: IndexedFile,
  root: RootCapability,
  directive: IncludeDirective,
): IndexedFile | null {
  const requested = directive.requested.replaceAll('/', '\\');
  if (isAbsolute(requested) || requested.split(/[\\/]/u).includes('..')) return null;
  const extensions = extname(requested)
    ? ['']
    : directive.kind === 'includeXS'
      ? ['', '.xs']
      : ['', '.inc', '.def', '.rms', '.rms2'];
  const currentParent = dirname(current.relativePath);
  const bases =
    directive.kind === 'includeXS' && root.xsRoot
      ? [relative(root.ownershipRoot, root.xsRoot)]
      : directive.kind === 'include_drs'
        ? [relative(root.ownershipRoot, root.sourceRoot)]
        : [currentParent, relative(root.ownershipRoot, root.sourceRoot)];
  for (const base of bases) {
    for (const extension of extensions) {
      const candidate = join(base, `${requested}${extension}`);
      if (candidate.split(/[\\/]/u).includes('..')) continue;
      const found = index.get(pathKey(candidate));
      if (found) return found;
    }
  }
  return null;
}

async function canonicalDirectory(path: string): Promise<string> {
  const canonical = await realpath(resolve(path));
  const metadata = await lstat(canonical);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('path is not a regular directory');
  }
  return canonical;
}

async function listRegularDirectories(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort(compare);
  } catch {
    return [];
  }
}

async function isRegularDirectory(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

async function isManagedDeploymentOutput(name: string, root: string): Promise<boolean> {
  if (pathKey(name) === pathKey(managedModDirectoryName)) return true;
  try {
    const markerPath = join(root, 'info.json');
    const metadata = await lstat(markerPath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > maximumOwnershipMarkerBytes
    ) {
      return false;
    }
    const marker = JSON.parse(
      (await readFileBounded(markerPath, maximumOwnershipMarkerBytes)).toString('utf8'),
    ) as {
      RmsideManagedContract?: unknown;
    };
    return marker.RmsideManagedContract === managedModContract;
  } catch {
    return false;
  }
}

async function boundedFile(path: string, maximumBytes: number): Promise<Buffer> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumBytes) {
    throw new DesktopError(
      'installed-source.limit',
      'installed source is not a bounded regular file',
    );
  }
  return readFileBounded(path, maximumBytes);
}

function protectedRootsFor(roots: Iterable<RootCapability>): string[] {
  return [...roots].filter((root) => root.readOnly).map((root) => root.ownershipRoot);
}

function safeJoin(root: string, child: string): string {
  const target = resolve(root, child);
  if (!isInside(target, root)) throw new Error('source path escapes its authorized root');
  return target;
}

function safeCloneName(value: string): string {
  const sanitized = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '-')
    .trim()
    .slice(0, 96);
  return sanitized || 'rms-map';
}

function opaqueId(kind: 'installation' | 'root' | 'source', value: string): string {
  return `${kind}:${createHash('sha256').update(pathKey(value)).digest('hex')}`;
}

function isInside(path: string, root: string): boolean {
  const child = relative(resolve(root), resolve(path));
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

function samePath(left: string, right: string): boolean {
  return left.length > 0 && pathKey(resolve(left)) === pathKey(resolve(right));
}

function pathKey(path: string): string {
  return path.replaceAll('\\', '/').toLocaleLowerCase('en-US');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function compareProfiles(
  left: InstalledSourceCatalog['profiles'][number],
  right: InstalledSourceCatalog['profiles'][number],
): number {
  return compare(
    `${left.installationLabel}/${left.profileId ?? ''}`,
    `${right.installationLabel}/${right.profileId ?? ''}`,
  );
}

function compareIndexedFiles(left: IndexedFile, right: IndexedFile): number {
  return compare(left.relativePath, right.relativePath);
}

function compare(left: string, right: string): number {
  return left.localeCompare(right, 'en-US', { sensitivity: 'base' });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function diagnosticReason(error: unknown): OutputWords {
  if (error instanceof DesktopError && error.code === 'installed-source.limit') {
    return { id: 'message.installed-source.limit.cause' };
  }
  return errorMessage(error);
}

function isLegacyEsMapsMod(name: string): boolean {
  return /^(?:[0-9]+_)?legacy\s+es\s+maps$/iu.test(name.trim());
}
