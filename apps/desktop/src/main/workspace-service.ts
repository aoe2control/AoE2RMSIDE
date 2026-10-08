import { createHash, randomUUID } from 'node:crypto';
import { constants, watch, type FSWatcher, type Stats } from 'node:fs';
import { access, lstat, mkdir, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  DesktopSession,
  DesktopSessionRestore,
  RecentWorkspaceEntry,
  RecoveryDocument,
  RecoverySnapshot,
  WorkspaceCreateRequest,
  WorkspaceDeleteRequest,
  WorkspaceDirectoryEntry,
  WorkspaceDocument,
  WorkspaceExternalChange,
  WorkspaceFolder,
  WorkspaceMutationResult,
  WorkspaceOpenResult,
  WorkspacePathChange,
  WorkspaceRenameRequest,
  WorkspaceSaveAsRequest,
  WorkspaceSaveRequest,
  WorkspaceSaveResult,
  WorkspaceSearchResult,
  WorkspaceSourceKind,
} from '../shared/api';
import {
  definitionFileKey,
  projectDefinedNames,
  type ProjectDefinitionFile,
} from '../shared/definition-file';
import { mapTestStarterTemplate } from '../shared/map-test-contract';
import { isXsScriptName, xsStarterTemplate } from '../shared/xs-contract';
import { workspaceSearchMatch } from '../shared/workspace-search';
import { editionCapabilities } from '../shared/edition';
import { presentMessage } from '../shared/message-catalog';
import { outputNote, type OutputMessage, type OutputText } from '../shared/output-message';
import { t } from '../shared/i18n/translator';
import { validateMonacoViewState } from './layout-store';
import {
  decodeSourceBytes,
  encodeSourceText,
  isSourceEncoding,
  isSourceNewlineStyle,
} from './source-codec';
import { StandardResourcePolicy } from './standard-resource-policy';
import { readFileBounded } from './bounded-file';
import { DesktopError } from '../shared/desktop-error';
import { isReservedWindowsDeviceName } from './windows-names';

const maximumPathLength = 32_768;
const maximumSourceBytes = 16 * 1024 * 1024;
const maximumMapTestSourceBytes = 1024 * 1024;
const maximumRecoveryBytes = 64 * 1024 * 1024;
const maximumRecentEntries = 20;
const maximumDirectoryEntries = 4096;
const maximumTraversalEntries = 40_000;
const maximumTraversalDepth = 64;
const maximumSearchResults = 512;
const relevantSourceExtensions = new Set(
  editionCapabilities.mapTests
    ? ['.rms', '.rms2', '.inc', '.def', '.rmstest', '.xs']
    : ['.rms', '.rms2', '.inc', '.def', '.xs'],
);
const sourceGraphExtensions = new Set(['.rms', '.rms2', '.inc', '.def', '.xs']);
const projectDefinitionExtensions = new Set(['.rms', '.rms2', '.inc', '.def']);
const maximumProjectDefinitionFileBytes = 4 * 1024 * 1024;
const maximumProjectDefinitionFiles = 4096;
const maximumProjectDefinitionBytes = 64 * 1024 * 1024;

export interface GeneratedFileTarget {
  folderId: string;
  name: string;
  relativePath: string;
}

export type GeneratedFileWriteResult =
  { status: 'written'; path: string } | { status: 'exists'; fileName: string };

interface OpenedDocumentCapability {
  path: string;
  sourceKind: WorkspaceSourceKind;
  encoding: WorkspaceDocument['encoding'];
  newlineStyle: WorkspaceDocument['newlineStyle'];
  diskHash: string;
  lastNotifiedState?: string;
}

export interface SourceCatalogWorkspaceContext {
  workspaceRoot: string | null;
  entryPath: string | null;
  openedDocuments: ReadonlyArray<{
    path: string;
    uri: string;
    encoding: WorkspaceDocument['encoding'];
    newlineStyle: WorkspaceDocument['newlineStyle'];
    diskHash: string;
  }>;
}

interface EntryCapability {
  id: string;
  path: string;
  kind: 'file' | 'folder';
  writable: boolean;
  root: boolean;
}

interface DirectoryWatcher {
  watcher: FSWatcher;
  documentIds: Set<string>;
}

interface TraversalContext {
  signal?: AbortSignal;
  entries: number;
  diagnosticPublished: boolean;
}

export class WorkspaceService {
  private readonly entries = new Map<string, EntryCapability>();
  private readonly openedDocuments = new Map<string, OpenedDocumentCapability>();
  private readonly configuredProtectedRoots: string[];
  private installedProtectedRoots: string[] = [];
  private readonly protectedRootOwners = new Map<string, string[]>();
  private readonly recentStore: RecentStore;
  private readonly directoryWatchers = new Map<string, DirectoryWatcher>();
  private readonly watchTimers = new Map<string, NodeJS.Timeout>();
  private readonly savingDocuments = new Set<string>();
  private readonly relevanceCache = new Map<string, boolean>();
  private readonly sourceTreeListeners = new Set<(path: string | null) => void>();
  private readonly rootListeners = new Set<(root: string | null) => void>();
  private sourceTreeWatcher: FSWatcher | null = null;
  private sourceTreeTimer: NodeJS.Timeout | null = null;
  private activeWorkspaceRoot: string | null = null;
  private folderActivation: Promise<unknown> = Promise.resolve();
  private activeSearch: AbortController | null = null;
  private collisionScanRevision = 0;
  private collisionWarningSignature: string | null = null;

  constructor(
    userDataPath: string,
    protectedRoots: string[] = [],
    private readonly publishExternalChange: (change: WorkspaceExternalChange) => void = () => {},
    private readonly publishDiagnostic: (message: OutputMessage) => void = () => {},
    readonly standardResources = new StandardResourcePolicy(),
  ) {
    this.configuredProtectedRoots = protectedRoots.map((entry) => normalizeAbsolutePath(entry));
    this.recentStore = new RecentStore(join(userDataPath, 'recent-workspaces-v1.json'));
  }

  async openPaths(requestedPaths: string[]): Promise<WorkspaceOpenResult> {
    if (!Array.isArray(requestedPaths) || requestedPaths.length < 1 || requestedPaths.length > 64) {
      throw new DesktopError('files.too-many', 'open request must contain 1 to 64 paths', {
        limit: 64,
      });
    }

    const documents: WorkspaceDocument[] = [];
    let folder: WorkspaceFolder | null = null;
    for (const requestedPath of requestedPaths) {
      const canonicalPath = await canonicalExistingPath(requestedPath);
      const metadata = await stat(canonicalPath);
      if (metadata.isDirectory()) {
        folder ??= await this.activateFolder(canonicalPath);
        await this.recentStore.add({
          path: canonicalPath,
          name: basename(canonicalPath),
          kind: 'folder',
        });
      } else if (metadata.isFile()) {
        assertSupportedSourcePath(canonicalPath);
        if (!(await isRelevantSourceFile(canonicalPath))) {
          throw new DesktopError(
            'files.unsupported',
            'file is binary, oversized, unreadable, or unsupported',
          );
        }
        const document = await this.readGrantedFile(canonicalPath);
        documents.push(document);
        await this.recentStore.add({
          path: canonicalPath,
          name: basename(canonicalPath),
          kind: 'file',
        });
      }
    }
    if (documents.length === 0 && folder === null) {
      throw new Error('open request did not contain a regular file or folder');
    }
    return { documents, folder };
  }

  async openDroppedPaths(requestedPaths: string[]): Promise<WorkspaceOpenResult> {
    if (!Array.isArray(requestedPaths) || requestedPaths.length < 1 || requestedPaths.length > 64) {
      throw new DesktopError('files.too-many', 'drop must contain 1 to 64 paths', { limit: 64 });
    }
    for (const requestedPath of requestedPaths) {
      const canonicalPath = await canonicalExistingPath(requestedPath);
      if ((await stat(canonicalPath)).isDirectory()) return this.openPaths([canonicalPath]);
    }
    return this.openPaths(requestedPaths);
  }

  async restoreDesktopSession(
    session: DesktopSession,
    recovery: RecoverySnapshot | null = null,
  ): Promise<DesktopSessionRestore> {
    const diagnostics: OutputText[] = [];
    const candidates: Array<{
      path: string;
      unavailable: 'notice.recovery.folder-unavailable' | 'notice.recovery.previous-folder-skipped';
    }> = [];
    if (recovery?.folder) {
      candidates.push({
        path: recovery.folder.path,
        unavailable: 'notice.recovery.folder-unavailable',
      });
    }
    if (
      session.workspace.folder &&
      !candidates.some(
        (candidate) => pathKey(candidate.path) === pathKey(session.workspace.folder!.path),
      )
    ) {
      candidates.push({
        path: session.workspace.folder.path,
        unavailable: 'notice.recovery.previous-folder-skipped',
      });
    }
    let folder: WorkspaceFolder | null = null;
    for (const candidate of candidates) {
      try {
        const canonicalPath = await canonicalExistingPath(candidate.path);
        if (!(await stat(canonicalPath)).isDirectory()) throw new Error('not a folder');
        folder = await this.activateFolder(canonicalPath);
        break;
      } catch {
        diagnostics.push({ id: candidate.unavailable });
      }
    }

    const documents: WorkspaceDocument[] = [];
    const normalTabs: DesktopSession['workspace']['normalTabs'] = [];
    for (const tab of session.workspace.normalTabs) {
      try {
        assertSupportedSourcePath(tab.path);
        const canonicalPath = await canonicalExistingPath(tab.path);
        if (!(await isRelevantSourceFile(canonicalPath))) throw new Error('unsupported source');
        const document = await this.readGrantedFile(canonicalPath);
        documents.push(document);
        normalTabs.push({ path: canonicalPath, viewState: tab.viewState });
      } catch {
        diagnostics.push({ id: 'notice.recovery.tab-skipped', args: { name: basename(tab.path) } });
      }
    }
    const activeRequested = session.workspace.activePath;
    const activePath = activeRequested
      ? (normalTabs.find((tab) => pathKey(tab.path) === pathKey(activeRequested))?.path ??
        normalTabs[0]?.path ??
        null)
      : (normalTabs[0]?.path ?? null);
    const expandedPaths = session.workspace.expandedPaths.filter((path) =>
      folder ? isPathInside(path, folder.path) : false,
    );
    const selectedPath =
      session.workspace.selectedPath &&
      folder &&
      isPathInside(session.workspace.selectedPath, folder.path)
        ? session.workspace.selectedPath
        : null;
    return {
      session: {
        ...session,
        workspace: {
          folder,
          expandedPaths,
          selectedPath,
          normalTabs,
          activePath,
        },
      },
      documents,
      diagnostics,
    };
  }

  async openRecent(requestedPath: string): Promise<WorkspaceOpenResult> {
    const recent = await this.recentStore.read();
    const lexicalKey = pathKey(validateAbsolutePath(requestedPath));
    if (!recent.some((entry) => pathKey(entry.path) === lexicalKey)) {
      throw new DesktopError('files.recent-missing', 'path is not a recent workspace entry');
    }
    const canonicalPath = await canonicalExistingPath(requestedPath);
    if (!recent.some((entry) => pathKey(entry.path) === pathKey(canonicalPath))) {
      throw new DesktopError('files.recent-missing', 'path is not a recent workspace entry');
    }
    return this.openPaths([canonicalPath]);
  }

  async readDirectory(entryId: string): Promise<WorkspaceDirectoryEntry[]> {
    const parent = await this.resolveFolderCapability(entryId);
    const context: TraversalContext = { entries: 0, diagnosticPublished: false };
    try {
      const entries = await this.readDirectoryEntries(parent.path, context);
      const visible: WorkspaceDirectoryEntry[] = [];
      for (const entry of entries) {
        const path = join(parent.path, entry.name);
        if (entry.isFile()) {
          if (!(await isRelevantSourceFile(path))) continue;
          visible.push(
            this.grantEntry(path, 'file', parent.writable && (await this.isWritable(path)), false),
          );
          continue;
        }
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const canonical = await this.containedCanonicalDirectory(path, context);
        if (!canonical || !(await this.directoryHasRelevantSource(canonical, context, 1))) continue;
        visible.push({
          ...this.grantEntry(
            canonical,
            'folder',
            parent.writable && (await this.isWritable(canonical)),
            false,
          ),
          hasChildren: true,
        });
      }
      return visible.sort(compareDirectoryEntries);
    } catch (error) {
      this.publishTraversalDiagnostic(context, error);
      return [];
    }
  }

  async authorizedFolderPath(entryId: string): Promise<string> {
    return (await this.resolveFolderCapability(entryId)).path;
  }

  workspaceRoot(): string | null {
    return this.activeWorkspaceRoot;
  }

  onWorkspaceRootChange(listener: (root: string | null) => void): () => void {
    this.rootListeners.add(listener);
    return () => this.rootListeners.delete(listener);
  }

  private publishRootChange(): void {
    for (const listener of this.rootListeners) listener(this.activeWorkspaceRoot);
  }

  closeWorkspace(): void {
    const closedRoot = this.activeWorkspaceRoot;
    this.activeSearch?.abort();
    this.activeSearch = null;
    this.activeWorkspaceRoot = null;
    this.collisionScanRevision += 1;
    this.collisionWarningSignature = null;
    this.sourceTreeWatcher?.close();
    this.sourceTreeWatcher = null;
    if (this.sourceTreeTimer) clearTimeout(this.sourceTreeTimer);
    this.sourceTreeTimer = null;
    this.entries.clear();
    this.relevanceCache.clear();
    if (closedRoot) this.publishRootChange();
    if (closedRoot) {
      for (const [id, capability] of this.openedDocuments) {
        if (isPathInside(capability.path, closedRoot)) this.openedDocuments.delete(id);
      }
      this.rebuildWatchers();
    }
    for (const capability of this.openedDocuments.values()) {
      this.grantEntry(capability.path, 'file', capability.sourceKind === 'ordinary', false);
    }
  }

  cancelSearch(): void {
    this.activeSearch?.abort();
    this.activeSearch = null;
  }

  onSourceTreeChange(listener: (path: string | null) => void): () => void {
    this.sourceTreeListeners.add(listener);
    return () => this.sourceTreeListeners.delete(listener);
  }

  setInstalledProtectedRoots(
    roots: readonly string[],
    owner: 'installed-sources' | 'linked-installation' = 'installed-sources',
  ): void {
    this.protectedRootOwners.set(owner, roots.map(normalizeAbsolutePath));
    const seen = new Set<string>();
    const next = [...this.protectedRootOwners.values()].flat().filter((root) => {
      const key = pathKey(root);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (
      next.length === this.installedProtectedRoots.length &&
      next.every((root, index) => pathKey(root) === pathKey(this.installedProtectedRoots[index]!))
    ) {
      return;
    }
    this.installedProtectedRoots = next;
    this.collisionWarningSignature = null;
    if (this.activeWorkspaceRoot)
      void this.warnAboutStandardNameCollisions(this.activeWorkspaceRoot);
  }

  setLocalStandardIncludePaths(paths: readonly string[]): void {
    if (!this.standardResources.setLocalIncludePaths(paths)) return;
    this.collisionWarningSignature = null;
    if (this.activeWorkspaceRoot)
      void this.warnAboutStandardNameCollisions(this.activeWorkspaceRoot);
  }

  sourceCatalogContext(documentUri?: string): SourceCatalogWorkspaceContext {
    const requestedPath = documentUri ? filePathFromUri(documentUri) : null;
    const entry = [...this.openedDocuments.values()].find(
      (candidate) => requestedPath !== null && pathKey(candidate.path) === pathKey(requestedPath),
    );
    return {
      workspaceRoot: this.activeWorkspaceRoot,
      entryPath: entry?.path ?? null,
      openedDocuments: [...this.openedDocuments.values()].map((document) => ({
        path: document.path,
        uri: pathToFileURL(document.path).href,
        encoding: document.encoding,
        newlineStyle: document.newlineStyle,
        diskHash: document.diskHash,
      })),
    };
  }

  mapTestWorkspaceName(scriptUri: string): string {
    return basename(this.mapTestAuthorizedRoot(scriptUri));
  }

  async resolveMapTestRmsSource(
    scriptUri: string,
    requestedRelativePath: string,
    guard?: {
      maximumBytes: number;
      beforeRead(metadata: Stats): void;
      current(): void;
    },
  ): Promise<WorkspaceDocument> {
    const normalized = normalizeMapTestRelativePath(requestedRelativePath);
    const root = this.mapTestAuthorizedRoot(scriptUri);
    const requested = resolve(root, ...normalized.split('/'));
    if (!isPathInside(requested, root)) {
      throw new Error('RMS source path escaped the authorized workspace root');
    }
    const canonical = await canonicalExistingPath(requested);
    if (!isPathInside(canonical, root)) {
      throw new DesktopError(
        'map-test.source-path',
        'RMS source path escaped through a filesystem link',
      );
    }
    if (!isSupportedSourcePath(canonical)) {
      throw new DesktopError('map-test.source-path', 'source file is unsupported');
    }
    const rootIdentity = await lstat(root);
    const sourceIdentity = await lstat(canonical);
    const identity = (value: Stats) =>
      `${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`;
    const assertCurrent = async () => {
      guard?.current();
      const currentRoot = await lstat(root);
      if (
        pathKey(this.mapTestAuthorizedRoot(scriptUri)) !== pathKey(root) ||
        pathKey(await canonicalExistingPath(requested)) !== pathKey(canonical) ||
        currentRoot.dev !== rootIdentity.dev ||
        currentRoot.ino !== rootIdentity.ino ||
        identity(await lstat(canonical)) !== identity(sourceIdentity)
      )
        throw new DesktopError(
          'source-catalog.changed',
          'RMS source changed while map-test sources were being checked',
        );
      guard?.current();
    };
    let guardError: unknown;
    const bytes = await readBoundedFile(
      canonical,
      Math.min(maximumSourceBytes, guard?.maximumBytes ?? maximumSourceBytes),
      async (metadata) => {
        try {
          if (identity(metadata) !== identity(sourceIdentity))
            throw new DesktopError(
              'source-catalog.changed',
              'RMS source changed before its map-test read',
            );
          await assertCurrent();
          guard?.beforeRead(metadata);
        } catch (error) {
          guardError = error;
          throw error;
        }
      },
    ).catch((error: unknown) => {
      if (error === guardError) throw error;
      throw new DesktopError('files.unsupported', 'source file is unsupported');
    });
    if (bytes.includes(0))
      throw new DesktopError('files.unsupported', 'source file is unsupported');
    await assertCurrent();
    guard?.current();
    return this.documentFromBytes(canonical, bytes, true);
  }

  mapTestRelativeRmsPath(scriptUri: string, sourceUri: string): string {
    const root = this.mapTestAuthorizedRoot(scriptUri);
    const sourcePath = filePathFromUri(sourceUri);
    if (!sourcePath || !isPathInside(sourcePath, root)) {
      throw new DesktopError(
        'map-test.default-source-outside',
        'the default RMS target is outside the authorized workspace root',
      );
    }
    const relativePath = relative(root, sourcePath).replaceAll('\\', '/');
    return normalizeMapTestRelativePath(relativePath);
  }

  private mapTestAuthorizedRoot(scriptUri: string): string {
    const scriptPath = filePathFromUri(scriptUri);
    if (!scriptPath) {
      if (this.activeWorkspaceRoot) return this.activeWorkspaceRoot;
      throw new DesktopError(
        'map-test.untitled-needs-folder',
        'an untitled map-test script needs an open folder',
      );
    }
    const capability = [...this.openedDocuments.values()].find(
      (candidate) => pathKey(candidate.path) === pathKey(scriptPath),
    );
    if (!capability || !isMapTestPath(capability.path)) {
      if (this.activeWorkspaceRoot && isPathInside(scriptPath, this.activeWorkspaceRoot)) {
        return this.activeWorkspaceRoot;
      }
      throw new Error('the map-test script is not authorized');
    }
    if (this.activeWorkspaceRoot && isPathInside(capability.path, this.activeWorkspaceRoot)) {
      return this.activeWorkspaceRoot;
    }
    return dirname(capability.path);
  }

  authorizeDesktopSession(
    session: DesktopSession,
    onSkipped: (reason: string) => void = () => {},
  ): DesktopSession {
    const requestedFolder = session.workspace.folder;
    let folder: WorkspaceFolder | null = null;
    if (requestedFolder) {
      folder = this.activeRootFolder(requestedFolder.path);
      if (!folder) onSkipped('the session folder is no longer the open workspace folder');
    }
    const normalTabs: DesktopSession['workspace']['normalTabs'] = [];
    let skippedTabs = 0;
    for (const tab of session.workspace.normalTabs) {
      const capability = [...this.openedDocuments.values()].find(
        (entry) => pathKey(entry.path) === pathKey(tab.path),
      );
      if (capability) normalTabs.push({ ...tab, path: capability.path });
      else skippedTabs += 1;
    }
    if (skippedTabs > 0) {
      onSkipped(
        skippedTabs === 1
          ? 'one session tab is no longer an open document'
          : `${skippedTabs} session tabs are no longer open documents`,
      );
    }
    const expandedPaths = session.workspace.expandedPaths.filter(
      (path) => folder && isPathInside(path, folder.path),
    );
    const selectedPath =
      session.workspace.selectedPath &&
      folder &&
      isPathInside(session.workspace.selectedPath, folder.path)
        ? session.workspace.selectedPath
        : null;
    const activePath = session.workspace.activePath
      ? (normalTabs.find((tab) => pathKey(tab.path) === pathKey(session.workspace.activePath!))
          ?.path ?? null)
      : null;
    return {
      ...session,
      workspace: { folder, expandedPaths, selectedPath, normalTabs, activePath },
    };
  }

  async searchWorkspace(query: string): Promise<WorkspaceSearchResult[]> {
    if (typeof query !== 'string' || query.length < 1 || query.length > 256) {
      throw new Error('workspace search query is invalid');
    }
    if (!this.activeWorkspaceRoot) throw new Error('no workspace folder is open');
    this.activeSearch?.abort();
    const controller = new AbortController();
    this.activeSearch = controller;
    const context: TraversalContext = {
      signal: controller.signal,
      entries: 0,
      diagnosticPublished: false,
    };
    const root = this.activeWorkspaceRoot;
    const rootWritable = this.entries.get(entryId(root, 'folder'))?.writable ?? false;
    try {
      return await this.searchDirectory(
        root,
        root,
        rootWritable,
        query,
        { matched: 0 },
        context,
        0,
      );
    } catch (error) {
      if (controller.signal.aborted) throw error;
      this.publishTraversalDiagnostic(context, error);
      return [];
    } finally {
      if (this.activeSearch === controller) this.activeSearch = null;
    }
  }

  async openGrantedPath(requestedPath: string): Promise<WorkspaceDocument> {
    assertSupportedSourcePath(requestedPath);
    const lexicalPath = validateAbsolutePath(requestedPath);
    if (
      !this.entries.has(entryId(lexicalPath, 'file')) &&
      (!this.activeWorkspaceRoot || !isPathInside(lexicalPath, this.activeWorkspaceRoot))
    ) {
      throw new DesktopError('files.outside-folder', 'file is outside the authorized workspace');
    }
    const canonicalPath = await canonicalExistingPath(requestedPath);
    if (!(await isRelevantSourceFile(canonicalPath))) {
      throw new DesktopError('files.unsupported', 'source file is unsupported');
    }
    const entry = this.entries.get(entryId(canonicalPath, 'file'));
    if (
      !entry &&
      (!this.activeWorkspaceRoot || !isPathInside(canonicalPath, this.activeWorkspaceRoot))
    ) {
      throw new DesktopError('files.outside-folder', 'file is outside the authorized workspace');
    }
    return this.readGrantedFile(canonicalPath);
  }

  async openCatalogSource(
    requestedPath: string,
    guard?: {
      beforeRead(metadata: Stats): Promise<void>;
      afterRead(): Promise<void>;
      current(): void;
    },
  ): Promise<WorkspaceDocument> {
    assertSupportedSourcePath(requestedPath);
    guard?.current();
    const canonicalPath = await canonicalExistingPath(requestedPath);
    guard?.current();
    if (guard) return this.readDocument(canonicalPath, true, guard);
    if (!(await isRelevantSourceFile(canonicalPath))) {
      throw new DesktopError('files.unsupported', 'source file is unsupported');
    }
    return this.readGrantedFile(canonicalPath);
  }

  async createEntry(request: WorkspaceCreateRequest): Promise<WorkspaceMutationResult> {
    validateCreateRequest(request);
    const parent = await this.resolveFolderCapability(request.parentId);
    this.assertMutable(parent, true);
    validateWindowsBasename(request.name, request.kind);
    this.standardResources.assertCreatableFileName(request.name);
    await assertNoSiblingCollision(parent.path, request.name);
    const targetPath = join(parent.path, request.name);
    let created = false;
    try {
      if (request.kind === 'file') {
        const handle = await open(targetPath, 'wx', 0o600);
        created = true;
        if (request.template === 'map-test-v1') {
          await handle.writeFile(Buffer.from(withCrlf(mapTestStarterTemplate), 'utf8'));
          await handle.sync();
        } else if (request.template === 'xs-v1') {
          await handle.writeFile(Buffer.from(withCrlf(xsStarterTemplate), 'utf8'));
          await handle.sync();
        }
        await handle.close();
      } else {
        await mkdir(targetPath);
        created = true;
      }
      const canonicalPath = await canonicalExistingPath(targetPath);
      if (!this.activeWorkspaceRoot || !isPathInside(canonicalPath, this.activeWorkspaceRoot)) {
        throw new Error('created entry escaped its authorized workspace');
      }
      const entry = this.grantEntry(canonicalPath, request.kind, true, false);
      this.invalidateRelevance(parent.path);
      return {
        entry,
        kind: request.kind,
        pathChanges: [],
        targetName: entry.name,
        targetPath: entry.path,
      };
    } catch (error) {
      if (created) await rm(targetPath, { force: true }).catch(() => undefined);
      this.invalidateRelevance(parent.path);
      throw error;
    }
  }

  async generatedFileTarget(folderId: string | null): Promise<GeneratedFileTarget | null> {
    const root = this.activeWorkspaceRoot;
    if (!root) {
      if (folderId !== null) throw new Error('no workspace folder is open');
      return null;
    }
    const folder = await this.resolveFolderCapability(folderId ?? entryId(root, 'folder'));
    this.assertMutable(folder, true);
    if (!isPathInside(folder.path, root)) throw new Error('folder is outside the open workspace');
    return {
      folderId: folder.id,
      name: basename(folder.path),
      relativePath: relative(root, folder.path).replaceAll('\\', '/'),
    };
  }

  async writeGeneratedFile(
    folderId: string,
    name: string,
    text: string,
    overwrite: boolean,
  ): Promise<GeneratedFileWriteResult> {
    const folder = await this.resolveFolderCapability(folderId);
    this.assertMutable(folder, true);
    validateWindowsBasename(name, 'file');
    if (extname(name).toLocaleLowerCase('en-US') !== '.inc') {
      throw new DesktopError(
        'files.extension-required',
        'a definition file name must end in .inc',
        { extension: '.inc' },
      );
    }
    this.standardResources.assertCreatableFileName(name);
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.byteLength > maximumSourceBytes) throw new Error('generated file is too large');
    const nameKey = name.toLocaleLowerCase('en-US');
    const existing = (await readdir(folder.path)).find(
      (candidate) => candidate.toLocaleLowerCase('en-US') === nameKey,
    );
    let targetPath: string;
    if (existing !== undefined) {
      if (!overwrite) return { status: 'exists', fileName: existing };
      targetPath = join(folder.path, existing);
      const metadata = await lstat(targetPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new DesktopError('files.not-a-file', 'the existing entry is not a regular file');
      }
      const canonicalExisting = await canonicalExistingPath(targetPath);
      if (
        !this.activeWorkspaceRoot ||
        !isPathInside(canonicalExisting, this.activeWorkspaceRoot) ||
        this.sourceKind(canonicalExisting) === 'protected'
      ) {
        throw new DesktopError(
          'files.outside-folder',
          'the existing file is outside the authorized workspace',
        );
      }
      await atomicReplaceFile(targetPath, bytes);
    } else {
      targetPath = join(folder.path, name);
      let created = false;
      try {
        const handle = await open(targetPath, 'wx', 0o600);
        created = true;
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (created) await rm(targetPath, { force: true }).catch(() => undefined);
        this.invalidateRelevance(folder.path);
        throw error;
      }
    }
    const canonicalPath = await canonicalExistingPath(targetPath);
    if (!this.activeWorkspaceRoot || !isPathInside(canonicalPath, this.activeWorkspaceRoot)) {
      throw new Error('generated file escaped its authorized workspace');
    }
    this.grantEntry(canonicalPath, 'file', true, false);
    this.invalidateRelevance(folder.path);
    return { status: 'written', path: canonicalPath };
  }

  async writeGeneratedFileAs(targetPath: string, text: string): Promise<string> {
    const normalizedTarget = normalizeAbsolutePath(targetPath);
    validateWindowsBasename(basename(normalizedTarget), 'file');
    if (extname(normalizedTarget).toLocaleLowerCase('en-US') !== '.inc') {
      throw new DesktopError(
        'files.extension-required',
        'a definition file name must end in .inc',
        { extension: '.inc' },
      );
    }
    const canonicalParent = await canonicalExistingPath(dirname(normalizedTarget));
    const canonicalTarget = join(canonicalParent, basename(normalizedTarget));
    this.standardResources.assertCreatableFileName(basename(canonicalTarget));
    if (this.sourceKind(canonicalTarget) === 'protected') {
      throw new DesktopError('files.protected-target', 'cannot save into a protected source root');
    }
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.byteLength > maximumSourceBytes) throw new Error('generated file is too large');
    try {
      const metadata = await lstat(canonicalTarget);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new DesktopError('files.not-a-file', 'the existing entry is not a regular file');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await atomicReplaceFile(canonicalTarget, bytes);
    const savedPath = await canonicalExistingPath(canonicalTarget);
    this.grantEntry(savedPath, 'file', true, false);
    this.grantEntry(canonicalParent, 'folder', await this.isWritable(canonicalParent), false);
    this.invalidateRelevance(canonicalParent);
    return savedPath;
  }

  async projectDefinitions(
    relevant: (name: string) => boolean,
  ): Promise<{ files: ProjectDefinitionFile[]; complete: boolean }> {
    const root = this.activeWorkspaceRoot;
    if (!root || this.sourceKind(root) === 'protected') return { files: [], complete: true };
    const context: TraversalContext = { entries: 0, diagnosticPublished: true };
    const files: ProjectDefinitionFile[] = [];
    let complete = true;
    let read = 0;
    let readBytes = 0;
    const visit = async (directory: string, depth: number): Promise<void> => {
      this.assertTraversal(context, depth);
      for (const entry of await this.readDirectoryEntries(directory, context)) {
        const path = join(directory, entry.name);
        if (entry.isFile() && projectDefinitionExtensions.has(extname(entry.name).toLowerCase())) {
          const metadata = await stat(path).catch(() => null);
          if (!metadata?.isFile()) continue;
          if (
            metadata.size > maximumProjectDefinitionFileBytes ||
            read >= maximumProjectDefinitionFiles ||
            readBytes + metadata.size > maximumProjectDefinitionBytes
          ) {
            complete = false;
            continue;
          }
          read += 1;
          readBytes += metadata.size;
          const bytes = await readFileBounded(path, maximumProjectDefinitionFileBytes).catch(
            () => null,
          );
          if (!bytes) {
            complete = false;
            continue;
          }
          const names = projectDefinedNames(bytes.toString('latin1')).filter(relevant);
          if (names.length > 0) {
            files.push({ file: definitionFileKey(relative(root, path)), names });
          }
        } else if (entry.isDirectory() && !entry.isSymbolicLink()) {
          const canonical = await this.containedCanonicalDirectory(path, context);
          if (canonical && this.sourceKind(canonical) !== 'protected') {
            await visit(canonical, depth + 1);
          }
        }
      }
    };
    try {
      await visit(root, 0);
    } catch {
      complete = false;
    }
    files.sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0));
    return { files, complete };
  }

  async renameEntry(
    request: WorkspaceRenameRequest,
    persist: (changes: WorkspacePathChange[]) => Promise<void> = async () => {},
  ): Promise<WorkspaceMutationResult> {
    validateRenameRequest(request);
    const capability = await this.resolveEntryCapability(request.entryId);
    this.assertMutable(capability, false);
    validateWindowsBasename(request.name, capability.kind);
    if (request.name === basename(capability.path)) {
      return {
        entry: this.toDirectoryEntry(capability),
        kind: capability.kind,
        pathChanges: [],
        targetName: request.name,
        targetPath: capability.path,
      };
    }
    this.standardResources.assertCreatableFileName(request.name);
    const parentPath = dirname(capability.path);
    await assertNoSiblingCollision(parentPath, request.name, basename(capability.path));
    const targetPath = join(parentPath, request.name);
    const changes = this.collectPathChanges(capability.path, targetPath);
    const reverseChanges = changes.map((change) => ({
      oldId: change.newId,
      newId: change.oldId,
      oldPath: change.newPath,
      newPath: change.oldPath,
      newUri: pathToFileURL(change.oldPath).href,
    }));
    const recentBefore = await this.recentStore.read();
    const recentAfter = recentBefore.map((entry) =>
      isPathInside(entry.path, capability.path)
        ? {
            ...entry,
            path: `${targetPath}${entry.path.slice(capability.path.length)}`,
            name: basename(`${targetPath}${entry.path.slice(capability.path.length)}`),
          }
        : entry,
    );
    const caseOnly = pathKey(targetPath) === pathKey(capability.path);
    let finalSource = capability.path;
    let temporaryPath: string | null = null;
    if (caseOnly) {
      temporaryPath = join(parentPath, `.${basename(capability.path)}.${randomUUID()}.rename`);
      await rename(capability.path, temporaryPath);
      finalSource = temporaryPath;
    }
    try {
      await assertPathAbsent(targetPath);
      await rename(finalSource, targetPath);
      let persistenceCommitted = false;
      try {
        const canonicalTarget = await canonicalExistingPath(targetPath);
        if (!this.activeWorkspaceRoot || !isPathInside(canonicalTarget, this.activeWorkspaceRoot)) {
          throw new Error('renamed entry escaped its authorized workspace');
        }
        await persist(changes);
        persistenceCommitted = true;
        await this.recentStore.replace(recentAfter);
      } catch (error) {
        let rollbackError: unknown = null;
        if (persistenceCommitted) {
          try {
            await persist(reverseChanges);
          } catch (failure) {
            rollbackError = failure;
          }
        }
        try {
          await rename(targetPath, capability.path);
        } catch (failure) {
          rollbackError ??= failure;
        }
        if (rollbackError) {
          throw new AggregateError([error, rollbackError], 'rename rollback failed');
        }
        throw error;
      }
    } catch (error) {
      if (temporaryPath) {
        await rename(temporaryPath, capability.path).catch(() => undefined);
      }
      this.invalidateRelevance(parentPath);
      throw error;
    }
    this.applyPathChanges(changes);
    this.invalidateRelevance(parentPath);
    const renamed = this.entries.get(entryId(targetPath, capability.kind));
    if (!renamed) throw new Error('renamed entry capability was not committed');
    return {
      entry: this.toDirectoryEntry(renamed),
      kind: capability.kind,
      pathChanges: changes,
      targetName: request.name,
      targetPath,
    };
  }

  async deleteEntry(
    request: WorkspaceDeleteRequest,
    trash: (path: string) => Promise<void>,
    persist: (path: string) => Promise<void> = async () => {},
  ): Promise<WorkspaceMutationResult> {
    validateDeleteRequest(request);
    const capability = await this.resolveEntryCapability(request.entryId);
    this.assertMutable(capability, false);
    const wasNonEmptyFolder =
      capability.kind === 'folder' && (await readdir(capability.path)).length > 0;
    if (request.permanent === true) await this.deletePermanently(capability);
    else await trash(capability.path);
    await persist(capability.path).catch((error: unknown) => {
      this.publishDiagnostic(
        presentMessage({
          source: 'Files',
          raw: errorMessage(error),
          severity: 'warning',
          fallbackHeadline: 'file-actions.delete.session-not-updated',
        }),
      );
    });
    this.removeCapabilitiesAt(capability.path);
    await this.recentStore.remove(capability.path);
    this.invalidateRelevance(dirname(capability.path));
    return {
      kind: capability.kind,
      pathChanges: [],
      targetName: basename(capability.path),
      targetPath: capability.path,
      wasNonEmptyFolder,
    };
  }

  private async deletePermanently(capability: EntryCapability): Promise<void> {
    const root = this.activeWorkspaceRoot;
    if (
      !root ||
      pathKey(capability.path) === pathKey(root) ||
      !isPathInside(capability.path, root)
    ) {
      throw new Error('only entries inside the open workspace folder can be deleted permanently');
    }
    const status = await lstat(capability.path);
    if (
      status.isSymbolicLink() ||
      (capability.kind === 'folder' ? !status.isDirectory() : !status.isFile())
    ) {
      throw new DesktopError(
        'files.entry-stale',
        'workspace entry changed before the permanent delete',
      );
    }
    await rm(capability.path, { recursive: capability.kind === 'folder', force: false });
  }

  async save(request: WorkspaceSaveRequest): Promise<WorkspaceSaveResult> {
    validateSaveRequest(request);
    assertSupportedSourcePath(request.path);
    const capability = this.openedDocuments.get(request.documentId);
    if (!capability || pathKey(capability.path) !== pathKey(request.path)) {
      throw new Error('document is not authorized for saving');
    }
    if (capability.sourceKind === 'protected' || this.sourceKind(request.path) === 'protected') {
      throw new DesktopError('files.protected', 'protected sources require Clone or Save As');
    }
    assertMapTestEncoding(request.path, capability.encoding);
    assertMapTestContentSize(request.path, request.content);

    const current = await this.readDocument(capability.path, false);
    if (!request.overwriteExternalChange && current.diskHash !== request.diskHash) {
      return { status: 'external-change', current };
    }
    if (current.diskHash === request.diskHash && current.content === request.content) {
      return { status: 'saved', document: await this.readGrantedFile(capability.path) };
    }

    if (pathKey(await canonicalExistingPath(capability.path)) !== pathKey(capability.path)) {
      throw new DesktopError(
        'files.entry-stale',
        'document no longer resolves to its authorized path',
      );
    }

    this.savingDocuments.add(request.documentId);
    try {
      const bytes = encodeSourceText(request.content, capability.encoding, capability.newlineStyle);
      await atomicReplaceFile(capability.path, bytes);
      this.invalidateRelevance(dirname(capability.path));
      return { status: 'saved', document: await this.readGrantedFile(capability.path) };
    } finally {
      this.savingDocuments.delete(request.documentId);
    }
  }

  async saveAs(targetPath: string, request: WorkspaceSaveAsRequest): Promise<WorkspaceDocument> {
    validateSaveAsRequest(request);
    assertSupportedSourcePath(targetPath);
    const normalizedTarget = normalizeAbsolutePath(targetPath);
    const canonicalParent = await canonicalExistingPath(dirname(normalizedTarget));
    const canonicalTarget = join(canonicalParent, basename(normalizedTarget));
    this.standardResources.assertCreatableFileName(basename(canonicalTarget));
    assertMapTestEncoding(canonicalTarget, request.encoding);
    assertMapTestContentSize(canonicalTarget, request.content);
    if (this.sourceKind(canonicalTarget) === 'protected') {
      throw new DesktopError('files.protected-target', 'cannot save into a protected source root');
    }
    await atomicReplaceFile(
      canonicalTarget,
      encodeSourceText(request.content, request.encoding, request.newlineStyle),
    );
    const savedPath = await canonicalExistingPath(canonicalTarget);
    this.grantEntry(savedPath, 'file', true, false);
    this.grantEntry(canonicalParent, 'folder', await this.isWritable(canonicalParent), false);
    this.invalidateRelevance(canonicalParent);
    await this.recentStore.add({ path: savedPath, name: basename(savedPath), kind: 'file' });
    return this.readGrantedFile(savedPath);
  }

  recentEntries(): Promise<RecentWorkspaceEntry[]> {
    return this.recentStore.read();
  }

  async validDialogPath(
    kind: 'file' | 'folder',
    requestedPath: string | null,
  ): Promise<string | undefined> {
    if (!requestedPath) return undefined;
    try {
      const canonical = await canonicalExistingPath(requestedPath);
      const metadata = await stat(canonical);
      if (kind === 'folder') return metadata.isDirectory() ? canonical : undefined;
      if (!metadata.isFile()) return undefined;
      assertSupportedSourcePath(canonical);
      return (await isRelevantSourceFile(canonical)) ? canonical : undefined;
    } catch {
      return undefined;
    }
  }

  authorizeRecoverySnapshot(snapshot: RecoverySnapshot): RecoverySnapshot {
    const folder = snapshot.folder ? this.activeRootFolder(snapshot.folder.path) : null;
    const replacedIds = new Map<string, string>();
    const documents = snapshot.documents.map((document): RecoveryDocument => {
      if (!document.path) return document;
      const requested = pathKey(document.path);
      const match = [...this.openedDocuments].find(
        ([, capability]) => pathKey(capability.path) === requested,
      );
      if (match) {
        const [id, capability] = match;
        replacedIds.set(document.id, id);
        return {
          ...document,
          id,
          uri: pathToFileURL(capability.path).href,
          path: capability.path,
          sourceKind: capability.sourceKind,
          readOnly: capability.sourceKind === 'protected',
        };
      }
      const recoveredId = `recovered:${randomUUID()}`;
      replacedIds.set(document.id, recoveredId);
      return {
        ...document,
        id: recoveredId,
        uri: `untitled://recovered/${encodeURIComponent(document.name)}`,
        path: null,
        sourceKind: 'ordinary',
        readOnly: false,
        diskHash: '0'.repeat(64),
      };
    });
    const activeDocumentId =
      snapshot.activeDocumentId === null
        ? null
        : (replacedIds.get(snapshot.activeDocumentId) ??
          (documents.some((document) => document.id === snapshot.activeDocumentId)
            ? snapshot.activeDocumentId
            : (documents[0]?.id ?? null)));
    return { ...snapshot, folder, documents, activeDocumentId };
  }

  async restoreRecovery(
    snapshot: RecoverySnapshot,
  ): Promise<{ snapshot: RecoverySnapshot; diagnostics: OutputText[] }> {
    const diagnostics: OutputText[] = [];
    const documents: RecoveryDocument[] = [];
    for (const document of snapshot.documents) {
      if (!document.path) {
        documents.push(document);
        continue;
      }
      try {
        assertSupportedSourcePath(document.path);
        const canonicalPath = await canonicalExistingPath(document.path);
        if (!(await isRelevantSourceFile(canonicalPath))) throw new Error('unsupported source');
        const sourceKind = this.sourceKind(canonicalPath);
        const id = documentId(canonicalPath);
        const restored = {
          ...document,
          id,
          uri: pathToFileURL(canonicalPath).href,
          path: canonicalPath,
          name: basename(canonicalPath),
          sourceKind,
          readOnly: sourceKind === 'protected',
        };
        documents.push(restored);
        this.openedDocuments.set(id, {
          path: canonicalPath,
          sourceKind,
          encoding: restored.encoding,
          newlineStyle: restored.newlineStyle,
          diskHash: restored.diskHash,
        });
        this.grantEntry(canonicalPath, 'file', sourceKind === 'ordinary', false);
        this.watchDocument(id, canonicalPath);
      } catch {
        diagnostics.push({
          id: 'notice.recovery.recovered-unsaved',
          args: { name: document.name },
        });
        documents.push({
          ...document,
          id: `recovered:${randomUUID()}`,
          uri: `untitled://recovered/${encodeURIComponent(document.name)}`,
          path: null,
          sourceKind: 'ordinary',
          readOnly: false,
          diskHash: '0'.repeat(64),
        });
      }
    }
    const activeDocumentId = documents.some((entry) => entry.id === snapshot.activeDocumentId)
      ? snapshot.activeDocumentId
      : (documents[0]?.id ?? null);
    return {
      snapshot: { ...snapshot, activeDocumentId, folder: null, documents },
      diagnostics,
    };
  }

  private activeRootFolder(requestedPath: string): WorkspaceFolder | null {
    const root = this.activeWorkspaceRoot;
    if (!root || pathKey(requestedPath) !== pathKey(root)) return null;
    const capability = this.entries.get(entryId(root, 'folder'));
    return {
      id: entryId(root, 'folder'),
      path: root,
      name: basename(root),
      writable: capability?.writable ?? false,
    };
  }

  private activateFolder(canonicalPath: string): Promise<WorkspaceFolder> {
    const activation = this.folderActivation.then(() => this.activateFolderNow(canonicalPath));
    this.folderActivation = activation.catch(() => undefined);
    return activation;
  }

  private async activateFolderNow(canonicalPath: string): Promise<WorkspaceFolder> {
    if (!(await stat(canonicalPath)).isDirectory()) {
      throw new Error('workspace root is not a folder');
    }
    const writable = await this.isWritable(canonicalPath);
    const entry = this.grantEntry(canonicalPath, 'folder', writable, true);
    const changedRoot =
      this.activeWorkspaceRoot === null ||
      pathKey(this.activeWorkspaceRoot) !== pathKey(canonicalPath);
    if (changedRoot) {
      this.collisionWarningSignature = null;
      const previous = this.activeWorkspaceRoot
        ? this.entries.get(entryId(this.activeWorkspaceRoot, 'folder'))
        : undefined;
      if (previous) this.entries.set(previous.id, { ...previous, root: false });
    }
    this.activeWorkspaceRoot = canonicalPath;
    if (changedRoot) this.publishRootChange();
    this.watchSourceTree(canonicalPath);
    if (changedRoot || this.collisionWarningSignature?.startsWith('scan-error:')) {
      await this.warnAboutStandardNameCollisions(canonicalPath);
    }
    return { id: entry.id, path: canonicalPath, name: basename(canonicalPath), writable };
  }

  private async warnAboutStandardNameCollisions(root: string): Promise<void> {
    const revision = ++this.collisionScanRevision;
    if (this.sourceKind(root) === 'protected') return;
    const context: TraversalContext = { entries: 0, diagnosticPublished: false };
    const collisions: string[] = [];
    const visit = async (directory: string, depth: number): Promise<void> => {
      this.assertTraversal(context, depth);
      const entries = await this.readDirectoryEntries(directory, context);
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isFile() && this.standardResources.isReservedFileName(entry.name)) {
          collisions.push(relative(root, path).replaceAll('\\', '/'));
        } else if (entry.isDirectory() && !entry.isSymbolicLink()) {
          const canonical = await this.containedCanonicalDirectory(path, context);
          if (canonical && this.sourceKind(canonical) !== 'protected') {
            await visit(canonical, depth + 1);
          }
        }
      }
    };
    try {
      await visit(root, 0);
      if (
        revision !== this.collisionScanRevision ||
        this.activeWorkspaceRoot === null ||
        pathKey(root) !== pathKey(this.activeWorkspaceRoot)
      ) {
        return;
      }
      collisions.sort(compareText);
      const signature = JSON.stringify(collisions);
      if (signature === this.collisionWarningSignature) return;
      this.collisionWarningSignature = signature;
      if (collisions.length === 0) return;
      const shown = collisions
        .slice(0, 8)
        .map((path) => (path.length > 160 ? `${path.slice(0, 157)}...` : path));
      this.publishDiagnostic(
        outputNote(
          'Files',
          'files.standard-resource-conflict',
          { id: 'file-actions.standard-resource-conflict', args: { count: collisions.length } },
          {
            severity: 'warning',
            cause:
              collisions.length > 8
                ? {
                    id: 'file-actions.standard-resource-conflict.cause.more',
                    args: { paths: shown, count: collisions.length - 8 },
                  }
                : { id: 'file-actions.standard-resource-conflict.cause', args: { paths: shown } },
            action: { text: { id: 'file-actions.standard-resource-conflict.action' } },
          },
        ),
      );
    } catch (error) {
      if (revision !== this.collisionScanRevision) return;
      const signature = `scan-error:${errorMessage(error)}`;
      if (signature !== this.collisionWarningSignature) {
        this.collisionWarningSignature = signature;
        this.publishDiagnostic(
          presentMessage({
            source: 'Files',
            raw: errorMessage(error),
            severity: 'warning',
            fallbackHeadline: 'file-actions.standard-resource-conflict.check-incomplete',
          }),
        );
      }
    }
  }

  private async readGrantedFile(canonicalPath: string): Promise<WorkspaceDocument> {
    this.grantEntry(canonicalPath, 'file', this.sourceKind(canonicalPath) === 'ordinary', false);
    return this.readDocument(canonicalPath, true);
  }

  private async readDocument(
    canonicalPath: string,
    registerCapability: boolean,
    guard?: {
      beforeRead(metadata: Stats): Promise<void>;
      afterRead(): Promise<void>;
      current(): void;
    },
  ): Promise<WorkspaceDocument> {
    assertSupportedSourcePath(canonicalPath);
    const bytes = await readBoundedFile(
      canonicalPath,
      isMapTestPath(canonicalPath) ? maximumMapTestSourceBytes : maximumSourceBytes,
      guard?.beforeRead,
    );
    await guard?.afterRead();
    guard?.current();
    return this.documentFromBytes(canonicalPath, bytes, registerCapability);
  }

  private documentFromBytes(
    canonicalPath: string,
    bytes: Buffer,
    registerCapability: boolean,
  ): WorkspaceDocument {
    if (bytes.includes(0)) {
      throw new DesktopError('files.unsupported', 'binary source files are not supported');
    }
    const decoded = isMapTestPath(canonicalPath)
      ? decodeMapTestBytes(bytes)
      : decodeSourceBytes(bytes);
    const sourceKind = this.sourceKind(canonicalPath);
    const id = documentId(canonicalPath);
    const document = {
      id,
      uri: pathToFileURL(canonicalPath).href,
      path: canonicalPath,
      name: basename(canonicalPath),
      content: decoded.content,
      encoding: decoded.encoding,
      newlineStyle: decoded.newlineStyle,
      sourceKind,
      readOnly: sourceKind === 'protected',
      diskHash: hashBytes(bytes),
    };
    if (registerCapability) {
      this.grantEntry(canonicalPath, 'file', sourceKind === 'ordinary', false);
      this.openedDocuments.set(id, {
        path: canonicalPath,
        sourceKind,
        encoding: decoded.encoding,
        newlineStyle: decoded.newlineStyle,
        diskHash: document.diskHash,
      });
      this.watchDocument(id, canonicalPath);
    }
    return document;
  }

  private async searchDirectory(
    root: string,
    directory: string,
    writable: boolean,
    query: string,
    state: { matched: number },
    context: TraversalContext,
    depth: number,
  ): Promise<WorkspaceSearchResult[]> {
    this.assertTraversal(context, depth);
    const entries = await this.readDirectoryEntries(directory, context);
    const shown: Array<{ entry: WorkspaceDirectoryEntry; results: WorkspaceSearchResult[] }> = [];
    for (const entry of entries) {
      this.assertTraversal(context, depth);
      if (state.matched >= maximumSearchResults) break;
      const path = join(directory, entry.name);
      if (entry.isFile()) {
        const relativePath = relative(root, path).replaceAll('\\', '/');
        if (!workspaceSearchMatch(query, relativePath)) continue;
        if (!(await isRelevantSourceFile(path))) continue;
        state.matched += 1;
        const granted = this.grantEntry(
          path,
          'file',
          writable && (await this.isWritable(path)),
          false,
        );
        shown.push({ entry: granted, results: [{ ...granted, relativePath, matched: true }] });
        continue;
      }
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const canonical = await this.containedCanonicalDirectory(path, context);
      if (!canonical) continue;
      const relativePath = relative(root, canonical).replaceAll('\\', '/');
      const matched = workspaceSearchMatch(query, relativePath) !== null;
      if (matched) state.matched += 1;
      const folderWritable = writable && (await this.isWritable(canonical));
      const contents = await this.searchDirectory(
        root,
        canonical,
        folderWritable,
        query,
        state,
        context,
        depth + 1,
      );
      const visible =
        contents.length > 0 ||
        (matched && (await this.directoryHasRelevantSource(canonical, context, depth + 1)));
      if (!visible) {
        if (matched) state.matched -= 1;
        continue;
      }
      const granted = {
        ...this.grantEntry(canonical, 'folder', folderWritable, false),
        hasChildren: true,
      };
      shown.push({
        entry: granted,
        results: [{ ...granted, relativePath, matched }, ...contents],
      });
    }
    return shown
      .sort((left, right) => compareDirectoryEntries(left.entry, right.entry))
      .flatMap((item) => item.results);
  }

  private async directoryHasRelevantSource(
    directory: string,
    context: TraversalContext,
    depth: number,
  ): Promise<boolean> {
    const key = pathKey(directory);
    const cached = this.relevanceCache.get(key);
    if (cached !== undefined) return cached;
    try {
      this.assertTraversal(context, depth);
      const entries = await this.readDirectoryEntries(directory, context);
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isFile() && (await isRelevantSourceFile(path))) {
          this.relevanceCache.set(key, true);
          return true;
        }
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const canonical = await this.containedCanonicalDirectory(path, context);
        if (canonical && (await this.directoryHasRelevantSource(canonical, context, depth + 1))) {
          this.relevanceCache.set(key, true);
          return true;
        }
      }
      this.relevanceCache.set(key, false);
      return false;
    } catch (error) {
      this.publishTraversalDiagnostic(context, error);
      return false;
    }
  }

  private async readDirectoryEntries(directory: string, context: TraversalContext) {
    this.assertTraversal(context, 0);
    const entries = await readdir(directory, { withFileTypes: true });
    context.entries += entries.length;
    if (entries.length > maximumDirectoryEntries || context.entries > maximumTraversalEntries) {
      throw new DesktopError('files.traversal-limit', 'workspace traversal limit exceeded');
    }
    return entries.sort((left, right) => compareText(left.name, right.name));
  }

  private async containedCanonicalDirectory(
    candidate: string,
    context: TraversalContext,
  ): Promise<string | null> {
    try {
      const canonical = await canonicalExistingPath(candidate);
      if (!this.activeWorkspaceRoot || !isPathInside(canonical, this.activeWorkspaceRoot)) {
        throw new Error('workspace link escaped its root');
      }
      return canonical;
    } catch (error) {
      this.publishTraversalDiagnostic(context, error);
      return null;
    }
  }

  private assertTraversal(context: TraversalContext, depth: number): void {
    if (context.signal?.aborted) throw new Error('workspace search was cancelled');
    if (depth > maximumTraversalDepth || context.entries > maximumTraversalEntries) {
      throw new DesktopError('files.traversal-limit', 'workspace traversal limit exceeded');
    }
  }

  private publishTraversalDiagnostic(context: TraversalContext, error: unknown): void {
    if (context.diagnosticPublished) return;
    context.diagnosticPublished = true;
    this.publishDiagnostic(
      presentMessage({
        source: 'Files',
        raw: errorMessage(error),
        severity: 'warning',
        fallbackHeadline: 'file-actions.explorer.folders-unreadable',
      }),
    );
  }

  private async resolveEntryCapability(id: string): Promise<EntryCapability> {
    if (typeof id !== 'string' || id.length < 1 || id.length > 256) {
      throw new Error('workspace entry identity is invalid');
    }
    const capability = this.entries.get(id);
    if (!capability) {
      throw new DesktopError(
        'files.entry-stale',
        'workspace entry identity is stale or unauthorized',
      );
    }
    const canonical = await canonicalExistingPath(capability.path);
    if (pathKey(canonical) !== pathKey(capability.path)) {
      throw new DesktopError(
        'files.entry-stale',
        'workspace entry identity no longer resolves to its authorized path',
      );
    }
    if (this.activeWorkspaceRoot && !isPathInside(canonical, this.activeWorkspaceRoot)) {
      throw new Error('workspace entry escaped its authorized root');
    }
    return capability;
  }

  private async resolveFolderCapability(id: string): Promise<EntryCapability> {
    const capability = await this.resolveEntryCapability(id);
    if (capability.kind !== 'folder') throw new Error('workspace entry is not a folder');
    if (!(await stat(capability.path)).isDirectory()) {
      throw new DesktopError(
        'files.entry-stale',
        'workspace folder capability no longer names a folder',
      );
    }
    return capability;
  }

  private assertMutable(capability: EntryCapability, allowRoot: boolean): void {
    if (!capability.writable || this.sourceKind(capability.path) === 'protected') {
      throw new Error(t('file-actions.entry.read-only'));
    }
    if (!allowRoot && capability.root) throw new Error(t('file-actions.entry.root-locked'));
  }

  private grantEntry(
    path: string,
    kind: 'file' | 'folder',
    writable: boolean,
    root: boolean,
  ): WorkspaceDirectoryEntry {
    const id = entryId(path, kind);
    const keepsRoot =
      kind === 'folder' &&
      this.entries.get(id)?.root === true &&
      this.activeWorkspaceRoot !== null &&
      pathKey(path) === pathKey(this.activeWorkspaceRoot);
    const capability = { id, path, kind, writable, root: root || keepsRoot };
    this.entries.set(id, capability);
    return this.toDirectoryEntry(capability);
  }

  private toDirectoryEntry(capability: EntryCapability): WorkspaceDirectoryEntry {
    return {
      id: capability.id,
      path: capability.path,
      name: basename(capability.path),
      kind: capability.kind,
      writable: capability.writable,
    };
  }

  private collectPathChanges(oldRoot: string, newRoot: string): WorkspacePathChange[] {
    const paths = new Map<string, { path: string; kind: 'file' | 'folder' }>();
    for (const capability of this.entries.values()) {
      if (isPathInside(capability.path, oldRoot)) {
        paths.set(pathKey(capability.path), { path: capability.path, kind: capability.kind });
      }
    }
    for (const capability of this.openedDocuments.values()) {
      if (isPathInside(capability.path, oldRoot)) {
        paths.set(pathKey(capability.path), { path: capability.path, kind: 'file' });
      }
    }
    if (!paths.has(pathKey(oldRoot))) {
      const capability = [...this.entries.values()].find(
        (entry) => pathKey(entry.path) === pathKey(oldRoot),
      );
      paths.set(pathKey(oldRoot), { path: oldRoot, kind: capability?.kind ?? 'file' });
    }
    return [...paths.values()]
      .map(({ path, kind }) => {
        const suffix = relative(oldRoot, path);
        const newPath = suffix ? join(newRoot, suffix) : newRoot;
        return {
          oldId: kind === 'file' ? documentId(path) : entryId(path, kind),
          newId: kind === 'file' ? documentId(newPath) : entryId(newPath, kind),
          oldPath: path,
          newPath,
          newUri: pathToFileURL(newPath).href,
        };
      })
      .sort((left, right) => compareText(left.oldPath, right.oldPath));
  }

  private applyPathChanges(changes: WorkspacePathChange[]): void {
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const capability of entries) {
      const change = changes.find((entry) => pathKey(entry.oldPath) === pathKey(capability.path));
      const path = change?.newPath ?? capability.path;
      const id = entryId(path, capability.kind);
      this.entries.set(id, { ...capability, id, path });
    }
    const documents = [...this.openedDocuments.entries()];
    this.openedDocuments.clear();
    for (const [oldId, capability] of documents) {
      const change = changes.find((entry) => pathKey(entry.oldPath) === pathKey(capability.path));
      const path = change?.newPath ?? capability.path;
      this.openedDocuments.set(change?.newId ?? oldId, { ...capability, path });
    }
    this.rebuildWatchers();
  }

  private removeCapabilitiesAt(targetPath: string): void {
    for (const [id, capability] of this.entries) {
      if (isPathInside(capability.path, targetPath)) this.entries.delete(id);
    }
    for (const [id, capability] of this.openedDocuments) {
      if (isPathInside(capability.path, targetPath)) this.openedDocuments.delete(id);
    }
    this.rebuildWatchers();
  }

  private invalidateRelevance(path: string): void {
    if (!this.activeWorkspaceRoot) {
      this.relevanceCache.clear();
      return;
    }
    let current = normalizeAbsolutePath(path);
    while (isPathInside(current, this.activeWorkspaceRoot)) {
      this.relevanceCache.delete(pathKey(current));
      if (pathKey(current) === pathKey(this.activeWorkspaceRoot)) break;
      current = dirname(current);
    }
  }

  private async isWritable(path: string): Promise<boolean> {
    if (this.sourceKind(path) === 'protected') return false;
    try {
      await access(path, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  private watchDocument(documentId: string, canonicalPath: string): void {
    const directory = dirname(canonicalPath);
    const key = pathKey(directory);
    const existing = this.directoryWatchers.get(key);
    if (existing) {
      existing.documentIds.add(documentId);
      return;
    }
    const documentIds = new Set([documentId]);
    const watcher = watch(directory, { persistent: false }, (_eventType, fileName) => {
      const changedPath = fileName ? join(directory, fileName.toString()) : null;
      for (const candidateId of documentIds) {
        const capability = this.openedDocuments.get(candidateId);
        if (!capability) continue;
        if (changedPath && pathKey(changedPath) !== pathKey(capability.path)) continue;
        this.scheduleExternalChangeCheck(candidateId);
      }
    });
    watcher.on('error', () => this.directoryWatchers.delete(key));
    this.directoryWatchers.set(key, { watcher, documentIds });
  }

  private rebuildWatchers(): void {
    for (const { watcher } of this.directoryWatchers.values()) watcher.close();
    this.directoryWatchers.clear();
    for (const timer of this.watchTimers.values()) clearTimeout(timer);
    this.watchTimers.clear();
    for (const [id, capability] of this.openedDocuments) this.watchDocument(id, capability.path);
  }

  private watchSourceTree(root: string): void {
    this.sourceTreeWatcher?.close();
    this.sourceTreeWatcher = watch(
      root,
      { persistent: false, recursive: process.platform === 'win32' },
      (_eventType, fileName) => {
        const changedPath = fileName ? join(root, fileName.toString()) : null;
        if (
          changedPath &&
          !sourceGraphExtensions.has(extname(changedPath).toLocaleLowerCase('en-US'))
        ) {
          return;
        }
        if (this.sourceTreeTimer) clearTimeout(this.sourceTreeTimer);
        this.sourceTreeTimer = setTimeout(() => {
          this.sourceTreeTimer = null;
          this.invalidateRelevance(changedPath ?? root);
          for (const listener of this.sourceTreeListeners) listener(changedPath);
          void this.warnAboutStandardNameCollisions(root);
        }, 100);
      },
    );
    this.sourceTreeWatcher.on('error', () => {
      this.sourceTreeWatcher = null;
    });
  }

  private scheduleExternalChangeCheck(documentId: string): void {
    const existing = this.watchTimers.get(documentId);
    if (existing) clearTimeout(existing);
    this.watchTimers.set(
      documentId,
      setTimeout(() => {
        this.watchTimers.delete(documentId);
        if (this.savingDocuments.has(documentId)) {
          this.scheduleExternalChangeCheck(documentId);
          return;
        }
        void this.checkExternalChange(documentId);
      }, 100),
    );
  }

  private async checkExternalChange(documentId: string): Promise<void> {
    const capability = this.openedDocuments.get(documentId);
    if (!capability) return;
    try {
      const document = await this.readDocument(capability.path, false);
      if (
        document.diskHash === capability.diskHash ||
        document.diskHash === capability.lastNotifiedState
      ) {
        return;
      }
      capability.lastNotifiedState = document.diskHash;
      this.publishExternalChange({ kind: 'changed', document });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
      if (capability.lastNotifiedState === 'deleted') return;
      capability.lastNotifiedState = 'deleted';
      this.publishExternalChange({ kind: 'deleted', documentId, path: capability.path });
    }
  }

  private sourceKind(targetPath: string): WorkspaceSourceKind {
    return [...this.configuredProtectedRoots, ...this.installedProtectedRoots].some((root) =>
      isPathInside(targetPath, root),
    )
      ? 'protected'
      : 'ordinary';
  }
}

function filePathFromUri(uri: string): string | null {
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

export class RecoveryStore {
  private readonly path: string;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(userDataPath: string) {
    this.path = join(userDataPath, 'recovery-v1.json');
  }

  async read(): Promise<RecoverySnapshot | null> {
    await this.pendingWrite.catch(() => undefined);
    try {
      const bytes = await readBoundedFile(this.path, maximumRecoveryBytes);
      return validateRecoverySnapshot(JSON.parse(bytes.toString('utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new DesktopError(
        'files.recovery-invalid',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  write(snapshot: RecoverySnapshot): Promise<void> {
    const validated = validateRecoverySnapshot(snapshot);
    const bytes = Buffer.from(JSON.stringify(validated), 'utf8');
    if (bytes.length > maximumRecoveryBytes) {
      throw new DesktopError('files.recovery-too-large', 'recovery snapshot is too large');
    }
    this.pendingWrite = this.pendingWrite.then(() => atomicReplaceFile(this.path, bytes));
    return this.pendingWrite;
  }

  clear(): Promise<void> {
    this.pendingWrite = this.pendingWrite.then(() => rm(this.path, { force: true }));
    return this.pendingWrite;
  }

  async remapPaths(changes: WorkspacePathChange[]): Promise<void> {
    const snapshot = await this.read();
    if (!snapshot) return;
    const documents = snapshot.documents.map((document) => {
      if (!document.path) return document;
      const change = changes
        .filter((entry) => isPathInside(document.path!, entry.oldPath))
        .sort((left, right) => left.oldPath.length - right.oldPath.length)[0];
      if (!change) return document;
      const newPath = `${change.newPath}${document.path.slice(change.oldPath.length)}`;
      return {
        ...document,
        id: documentId(newPath),
        uri: pathToFileURL(newPath).href,
        path: newPath,
        name: basename(newPath),
      };
    });
    const activeDocument = documents.find((entry, index) => {
      const previous = snapshot.documents[index];
      return previous?.id === snapshot.activeDocumentId && entry.id !== previous.id;
    });
    await this.write({
      ...snapshot,
      activeDocumentId: activeDocument?.id ?? snapshot.activeDocumentId,
      documents,
    });
  }

  async removePath(targetPath: string): Promise<void> {
    const snapshot = await this.read();
    if (!snapshot) return;
    const documents = snapshot.documents.filter(
      (document) => !document.path || !isPathInside(document.path, targetPath),
    );
    await this.write({
      ...snapshot,
      activeDocumentId: documents.some((entry) => entry.id === snapshot.activeDocumentId)
        ? snapshot.activeDocumentId
        : (documents[0]?.id ?? null),
      documents,
    });
  }
}

class RecentStore {
  private pendingOperation: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  read(): Promise<RecentWorkspaceEntry[]> {
    return this.enqueue(async () => {
      const { entries, needsRewrite } = await this.readUnqueued();
      if (needsRewrite) await this.writeUnqueued(entries);
      return entries;
    });
  }

  add(entry: RecentWorkspaceEntry): Promise<void> {
    const validated = validateRecentEntry(entry);
    return this.enqueue(async () => {
      const current = (await this.readUnqueued()).entries;
      const next = [
        validated,
        ...current.filter((item) => pathKey(item.path) !== pathKey(validated.path)),
      ].slice(0, maximumRecentEntries);
      await this.writeUnqueued(next);
    });
  }

  replace(entries: RecentWorkspaceEntry[]): Promise<void> {
    const validated = entries.map(validateRecentEntry).slice(0, maximumRecentEntries);
    return this.enqueue(() => this.writeUnqueued(validated));
  }

  remove(targetPath: string): Promise<void> {
    return this.enqueue(async () => {
      const current = (await this.readUnqueued()).entries;
      await this.writeUnqueued(current.filter((entry) => !isPathInside(entry.path, targetPath)));
    });
  }

  private async readUnqueued(): Promise<{
    entries: RecentWorkspaceEntry[];
    needsRewrite: boolean;
  }> {
    let raw: RecentWorkspaceEntry[];
    try {
      const bytes = await readBoundedFile(this.path, 256 * 1024);
      const value: unknown = JSON.parse(bytes.toString('utf8'));
      if (!Array.isArray(value)) throw new Error('recent entries must be an array');
      raw = value.slice(0, maximumRecentEntries).map(validateRecentEntry);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { entries: [], needsRewrite: false };
      }
      return { entries: [], needsRewrite: false };
    }
    const valid: RecentWorkspaceEntry[] = [];
    for (const entry of raw) {
      try {
        const canonical = await canonicalExistingPath(entry.path);
        const metadata = await stat(canonical);
        if (entry.kind === 'folder' ? !metadata.isDirectory() : !metadata.isFile()) continue;
        if (entry.kind === 'file') {
          assertSupportedSourcePath(canonical);
          if (!(await isRelevantSourceFile(canonical))) continue;
        }
        valid.push({ ...entry, path: canonical, name: basename(canonical) });
      } catch {}
    }
    return { entries: valid, needsRewrite: valid.length !== raw.length };
  }

  private writeUnqueued(entries: RecentWorkspaceEntry[]): Promise<void> {
    return atomicReplaceFile(this.path, Buffer.from(JSON.stringify(entries), 'utf8'));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pendingOperation.then(operation);
    this.pendingOperation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export async function atomicReplaceFile(targetPath: string, bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength > maximumRecoveryBytes) throw new Error('atomic write exceeds maximum size');
  const directory = dirname(targetPath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(directory, `.${basename(targetPath)}.${randomUUID()}.new`);
  let handle;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function validateRecoverySnapshot(value: unknown): RecoverySnapshot {
  if (!isPlainRecord(value) || value.version !== 1) {
    throw new Error('unsupported recovery snapshot version');
  }
  if (!Array.isArray(value.documents) || value.documents.length > 128) {
    throw new Error('recovery documents must be a bounded array');
  }
  const documents = value.documents.map(validateRecoveryDocument);
  let contentBytes = 0;
  for (const document of documents) {
    contentBytes += Buffer.byteLength(document.content, 'utf8');
    if (contentBytes > maximumRecoveryBytes) {
      throw new DesktopError('files.recovery-too-large', 'recovery snapshot is too large');
    }
  }
  const activeDocumentId =
    value.activeDocumentId === null
      ? null
      : validateString(value.activeDocumentId, 'active id', 512);
  if (activeDocumentId && !documents.some((document) => document.id === activeDocumentId)) {
    throw new Error('recovery active document is missing');
  }
  const savedAt = value.savedAt;
  if (typeof savedAt !== 'number' || !Number.isFinite(savedAt) || savedAt < 0) {
    throw new Error('recovery timestamp is invalid');
  }
  return {
    version: 1,
    activeDocumentId,
    folder: value.folder === null ? null : validateFolder(value.folder),
    documents,
    savedAt,
  };
}

function validateRecoveryDocument(value: unknown): RecoveryDocument {
  if (!isPlainRecord(value)) throw new Error('recovery document must be plain data');
  const sourceKind = value.sourceKind;
  if (sourceKind !== 'ordinary' && sourceKind !== 'protected') {
    throw new Error('recovery source kind is invalid');
  }
  if (typeof value.readOnly !== 'boolean' || value.readOnly !== (sourceKind === 'protected')) {
    throw new Error('recovery read-only state is invalid');
  }
  if (typeof value.dirty !== 'boolean') throw new Error('recovery dirty state is invalid');
  const path = value.path === null ? null : validateAbsolutePath(value.path);
  const content = value.content;
  validateContent(content);
  return {
    id: validateString(value.id, 'document id', 512),
    uri: validateString(value.uri, 'document URI', maximumPathLength),
    path,
    name: validateString(value.name, 'document name', 512),
    content,
    encoding: validateEncoding(value.encoding),
    newlineStyle: validateNewlineStyle(value.newlineStyle),
    sourceKind,
    readOnly: value.readOnly,
    diskHash: validateHash(value.diskHash),
    dirty: value.dirty,
    ...(value.viewState === undefined
      ? {}
      : { viewState: value.viewState === null ? null : validateMonacoViewState(value.viewState) }),
  };
}

function validateCreateRequest(value: WorkspaceCreateRequest): void {
  if (!isPlainRecord(value) || (value.kind !== 'file' && value.kind !== 'folder')) {
    throw new Error('create request is invalid');
  }
  validateString(value.parentId, 'parent identity', 256);
  validateString(value.name, 'entry name', 255);
  if (
    value.template !== undefined &&
    value.template !== 'map-test-v1' &&
    value.template !== 'xs-v1'
  ) {
    throw new Error('create template is invalid');
  }
  if (value.template === 'xs-v1' && (value.kind !== 'file' || !isXsScriptName(value.name))) {
    throw new DesktopError('files.extension-required', 'the XS template requires a .xs file', {
      extension: '.xs',
    });
  }

  if (value.template === 'map-test-v1' && (value.kind !== 'file' || !isMapTestPath(value.name))) {
    throw new DesktopError(
      'files.extension-required',
      'the map-test template requires a .rmstest file',
      { extension: '.rmstest' },
    );
  }
}

function validateRenameRequest(value: WorkspaceRenameRequest): void {
  if (!isPlainRecord(value)) throw new Error('rename request is invalid');
  validateString(value.entryId, 'entry identity', 256);
  validateString(value.name, 'entry name', 255);
}

function validateDeleteRequest(value: WorkspaceDeleteRequest): void {
  if (!isPlainRecord(value)) throw new Error('delete request is invalid');
  validateString(value.entryId, 'entry identity', 256);
  if (value.permanent !== undefined && typeof value.permanent !== 'boolean') {
    throw new Error('delete request permanence is invalid');
  }
}

function validateWindowsBasename(name: string, kind: 'file' | 'folder'): void {
  if (
    name.trim().length === 0 ||
    (kind === 'file' && /^\.(?:rms|inc)$/i.test(name.trim())) ||
    name !== basename(name) ||
    name === '.' ||
    name === '..' ||
    /[<>:"/\\|?*\u0000-\u001f]/.test(name) ||
    /[. ]$/.test(name) ||
    isReservedWindowsDeviceName(name) ||
    Buffer.byteLength(name, 'utf8') > 255
  ) {
    throw new Error(t('file-actions.entry.invalid-name'));
  }
  if (kind === 'file') assertSupportedSourcePath(name);
}

async function assertNoSiblingCollision(
  parentPath: string,
  requestedName: string,
  currentName?: string,
): Promise<void> {
  const requestedKey = requestedName.toLocaleLowerCase('en-US');
  const currentKey = currentName?.toLocaleLowerCase('en-US');
  const collision = (await readdir(parentPath)).some((name) => {
    const key = name.toLocaleLowerCase('en-US');
    return key === requestedKey && key !== currentKey;
  });
  if (collision) throw new Error(t('file-actions.entry.name-exists'));
}

function validateSaveAsRequest(request: WorkspaceSaveAsRequest): void {
  if (!isPlainRecord(request)) throw new Error('save-as request must be plain data');
  validateString(request.documentId, 'document id', 512);
  validateContent(request.content);
  validateString(request.suggestedName, 'suggested name', 512);
  validateEncoding(request.encoding);
  validateNewlineStyle(request.newlineStyle);
}

function validateEncoding(value: unknown): WorkspaceDocument['encoding'] {
  if (!isSourceEncoding(value)) throw new Error('source encoding is invalid');
  return value;
}

function validateNewlineStyle(value: unknown): WorkspaceDocument['newlineStyle'] {
  if (!isSourceNewlineStyle(value)) throw new Error('source newline style is invalid');
  return value;
}

function validateFolder(value: unknown): WorkspaceFolder {
  if (!isPlainRecord(value)) throw new Error('workspace folder must be plain data');
  if (typeof value.writable !== 'boolean') throw new Error('workspace writability is invalid');
  return {
    id: validateString(value.id, 'folder identity', 256),
    path: validateAbsolutePath(value.path),
    name: validateString(value.name, 'folder name', 512),
    writable: value.writable,
  };
}

function validateRecentEntry(value: unknown): RecentWorkspaceEntry {
  if (!isPlainRecord(value) || (value.kind !== 'file' && value.kind !== 'folder')) {
    throw new Error('recent workspace entry is invalid');
  }
  return {
    path: validateAbsolutePath(value.path),
    name: validateString(value.name, 'recent name', 512),
    kind: value.kind,
  };
}

function validateSaveRequest(request: WorkspaceSaveRequest): void {
  if (!isPlainRecord(request)) throw new Error('save request must be plain data');
  validateString(request.documentId, 'document id', 512);
  validateAbsolutePath(request.path);
  validateContent(request.content);
  validateHash(request.diskHash);
  if (
    request.overwriteExternalChange !== undefined &&
    typeof request.overwriteExternalChange !== 'boolean'
  ) {
    throw new Error('external-change override is invalid');
  }
}

function validateContent(content: unknown): asserts content is string {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > maximumSourceBytes) {
    throw new Error('source content is not a bounded string');
  }
}

function validateAbsolutePath(value: unknown): string {
  const path = validateString(value, 'path', maximumPathLength);
  if (!isAbsolute(path)) throw new Error('path must be absolute');
  return normalizeAbsolutePath(path);
}

function validateHash(value: unknown): string {
  const hash = validateString(value, 'disk hash', 64);
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('disk hash is invalid');
  return hash;
}

function validateString(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximumLength) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function canonicalExistingPath(requestedPath: string): Promise<string> {
  const normalizedPath = validateAbsolutePath(requestedPath);
  return normalizeAbsolutePath(await realpath(normalizedPath));
}

function normalizeAbsolutePath(targetPath: string): string {
  if (
    typeof targetPath !== 'string' ||
    targetPath.length < 1 ||
    targetPath.length > maximumPathLength
  ) {
    throw new Error('path is invalid');
  }
  const normalized = resolve(targetPath);
  if (!isAbsolute(normalized)) throw new Error('path must be absolute');
  return normalized;
}

function pathKey(targetPath: string): string {
  const normalized = normalizeAbsolutePath(targetPath);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function isPathInside(targetPath: string, rootPath: string): boolean {
  const result = relative(pathKey(rootPath), pathKey(targetPath));
  return result === '' || (!result.startsWith('..') && !isAbsolute(result));
}

function documentId(targetPath: string): string {
  return `file:${createHash('sha256').update(pathKey(targetPath)).digest('hex')}`;
}

function entryId(targetPath: string, kind: 'file' | 'folder'): string {
  return `entry:${kind}:${createHash('sha256').update(pathKey(targetPath)).digest('hex')}`;
}

function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function isSupportedSourcePath(targetPath: string): boolean {
  return relevantSourceExtensions.has(extname(targetPath).toLocaleLowerCase('en-US'));
}

function assertSupportedSourcePath(targetPath: string): void {
  if (!isSupportedSourcePath(targetPath)) {
    throw new Error(
      t(
        editionCapabilities.mapTests
          ? 'file-actions.entry.unsupported-kind.map-tests'
          : 'file-actions.entry.unsupported-kind',
      ),
    );
  }
}

function isMapTestPath(targetPath: string): boolean {
  return extname(targetPath).toLocaleLowerCase('en-US') === '.rmstest';
}

function normalizeMapTestRelativePath(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  if (
    normalized.length < 1 ||
    normalized.length > 1024 ||
    normalized.startsWith('/') ||
    normalized.includes(':') ||
    normalized
      .split('/')
      .some((component) => component.length === 0 || component === '.' || component === '..') ||
    !/\.(?:rms|rms2)$/iu.test(normalized)
  ) {
    throw new DesktopError(
      'map-test.source-path',
      'rms.source() requires an authorized relative .rms or .rms2 path',
    );
  }
  return normalized;
}

function assertMapTestEncoding(targetPath: string, encoding: WorkspaceDocument['encoding']): void {
  if (isMapTestPath(targetPath) && encoding === 'windows-1252') {
    throw new DesktopError('files.encoding', 'map-test scripts must be UTF-8 with an optional BOM');
  }
}

function assertMapTestContentSize(targetPath: string, content: string): void {
  if (isMapTestPath(targetPath) && Buffer.byteLength(content, 'utf8') > maximumMapTestSourceBytes) {
    throw new DesktopError('files.too-large', 'map-test script exceeds the 1 MiB source limit', {
      limit: 1,
    });
  }
}

function decodeMapTestBytes(bytes: Uint8Array): {
  content: string;
  encoding: WorkspaceDocument['encoding'];
  newlineStyle: WorkspaceDocument['newlineStyle'];
} {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hasBom =
    buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  const body = hasBom ? buffer.subarray(3) : buffer;
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    throw new DesktopError('files.encoding', 'map-test script is not valid UTF-8');
  }
  const newlineStyle = content.includes('\r\n')
    ? content.replaceAll('\r\n', '').includes('\n') || content.replaceAll('\r\n', '').includes('\r')
      ? 'mixed'
      : 'crlf'
    : content.includes('\r')
      ? content.includes('\n')
        ? 'mixed'
        : 'cr'
      : content.includes('\n')
        ? 'lf'
        : 'none';
  return { content, encoding: hasBom ? 'utf8-bom' : 'utf8', newlineStyle };
}

async function isRelevantSourceFile(targetPath: string): Promise<boolean> {
  if (!isSupportedSourcePath(targetPath)) return false;
  try {
    const bytes = await readBoundedFile(
      targetPath,
      isMapTestPath(targetPath) ? maximumMapTestSourceBytes : maximumSourceBytes,
    );
    return !bytes.includes(0);
  } catch {
    return false;
  }
}

async function assertPathAbsent(targetPath: string): Promise<void> {
  try {
    await lstat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error(t('file-actions.entry.name-or-alias-exists'));
}

async function readBoundedFile(
  targetPath: string,
  maximumBytes: number,
  beforeRead?: (metadata: Stats) => Promise<void>,
): Promise<Buffer> {
  return readFileBounded(targetPath, maximumBytes, beforeRead);
}

function compareDirectoryEntries(left: WorkspaceDirectoryEntry, right: WorkspaceDirectoryEntry) {
  if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1;
  return compareText(left.name, right.name);
}

function compareText(left: string, right: string): number {
  const leftName = left.toLocaleLowerCase('en-US');
  const rightName = right.toLocaleLowerCase('en-US');
  return leftName < rightName
    ? -1
    : leftName > rightName
      ? 1
      : left < right
        ? -1
        : left > right
          ? 1
          : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withCrlf(text: string): string {
  return text.replace(/\r\n|\r|\n/g, '\r\n');
}
