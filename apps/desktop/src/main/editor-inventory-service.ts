import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { Stats } from 'node:fs';
import {
  sourceCatalogEnvironment as environment,
  sourceCatalogMaximumSources,
  type LanguageDocumentOverlay,
  type MainSourceCatalog,
  type MainSourceCatalogEntry,
} from './source-catalog-service';
import {
  asciiFold,
  SourceCatalogDiscoveryError,
  SourceCatalogProbes,
  SourceDiscoveryBudget,
  type SourceCatalogProbeMatch,
} from './source-catalog-probes';
import {
  SourceSnapshotCache,
  chargeSourceBytes,
  sourceMaximumAggregateBytes,
  sourceMaximumFileBytes,
} from './source-snapshot-cache';
import type { WorkspaceService } from './workspace-service';

export interface EditorInventoryBuildRequest {
  documentUri?: string;
  profileId: string;
  contentIdentity: string;
  implicitDefinitions: Readonly<Record<string, string>>;
  standardIncludes: readonly string[];
  standardIncludesRequested: boolean;
  installationRoot: string | null;
  overlays: readonly LanguageDocumentOverlay[];
  contextEpoch: string;
  assertCurrent(): void;
}

export interface MainEditorInventory {
  readonly kind: 'editor-inventory';
  readonly contextId: string;
  readonly inventoryId: string;
  readonly sources: readonly MainSourceCatalogEntry[];
  readonly roots: MainSourceCatalog['roots'];
  readonly caseSensitive: false;
  readonly profileId: string;
  readonly contentIdentity: string;
  readonly implicitDefinitions: Readonly<Record<string, string>>;
}

export interface PreparedEditorInventory {
  readonly inventory: MainEditorInventory;
  readonly witness: EditorInventoryWitness;
}

export class EditorInventoryWitness {
  constructor(
    private readonly workspace: WorkspaceService,
    readonly documentUri: string | undefined,
    private readonly contextIdentity: string,
    private readonly probes: SourceCatalogProbes,
    private readonly overlayMatches: readonly SourceCatalogProbeMatch[],
    private readonly grants: ReadonlyMap<string, string>,
    readonly contextEpoch: string,
    readonly serviceEpoch: number,
  ) {}

  async validate(): Promise<void> {
    this.checkWorkspace();
    await this.probes.assertCurrent();
    for (const match of this.overlayMatches) await this.probes.authorizeOverlay(match);
    this.checkWorkspace();
  }

  async pathForSource(sourceId: string): Promise<string> {
    await this.validate();
    const key = environment.fileUriPathKey(sourceId);
    const path = [...this.grants].find(([id]) => environment.fileUriPathKey(id) === key)?.[1];
    if (!path)
      throw new Error('source identity is absent from the current authorized editor inventory');
    return path;
  }

  authorizeRead(path: string, metadata: Stats): Promise<void> {
    this.checkWorkspace();
    return this.probes.authorizeRead(path, metadata);
  }

  private checkWorkspace(): void {
    if (
      JSON.stringify(this.workspace.sourceCatalogContext(this.documentUri)) !== this.contextIdentity
    )
      throw stale();
  }
}

export class EditorInventoryService {
  private epoch = 0;

  constructor(
    private readonly workspace: WorkspaceService,
    private readonly snapshots: SourceSnapshotCache,
  ) {}

  invalidate(): void {
    this.epoch += 1;
  }
  identityEpoch(): number {
    return this.epoch;
  }

  async build(request: EditorInventoryBuildRequest): Promise<PreparedEditorInventory> {
    if (!request.profileId || !request.contentIdentity || (request.documentUri?.length ?? 0) > 4096)
      throw new Error('editor inventory context is invalid');
    const epoch = this.epoch;
    const deadline = performance.now() + 30_000;
    const context = this.workspace.sourceCatalogContext(request.documentUri);
    const contextIdentity = JSON.stringify(context);
    const current = () => {
      request.assertCurrent();
      if (
        performance.now() >= deadline ||
        epoch !== this.epoch ||
        contextIdentity !== JSON.stringify(this.workspace.sourceCatalogContext(request.documentUri))
      )
        throw stale();
    };
    current();
    const workspaceRoot = await environment.authorizedWorkspaceRoot(context);
    const deployedRoot = await environment.authorizedDeployedMapRoot(context);
    const gameRoots = await environment.authorizedGameRoots(request.installationRoot);
    current();
    const standardAuthorized =
      environment.standardIncludeAccess(
        request.standardIncludesRequested,
        request.installationRoot,
        gameRoots.gamedata,
      ) === 'authorized';
    const plan = environment.planCatalogRoots(
      workspaceRoot,
      deployedRoot,
      gameRoots,
      standardAuthorized,
    );
    const definitions = environment.canonicalDefinitions(request.implicitDefinitions);
    const entryPath = context.entryPath
      ? environment.virtualPathForDiskPath(context.entryPath, plan)
      : null;
    const roots = environment.catalogResolverRoots(
      plan,
      entryPath ? environment.virtualParent(entryPath) : undefined,
      Object.keys(definitions).length,
      environment.canonicalStandardIncludes(request.standardIncludes),
      standardAuthorized,
    );
    const metadata = new SourceDiscoveryBudget();
    metadata.charge(
      'editor inventory',
      environment.validateCatalogMetadata(
        [],
        '',
        roots,
        request.profileId,
        request.contentIdentity,
        definitions,
      ),
    );
    const probes = new SourceCatalogProbes(plan.collectionRoots, metadata, current);
    const matches = [
      ...(await probes.inventory(
        (match) =>
          environment.isCatalogAssetPath(match.path) &&
          !plan.excludedPathKeys.has(environment.pathKey(match.path)),
      )),
    ];
    const overlayMatches: SourceCatalogProbeMatch[] = [];
    const overlays = new Map<string, LanguageDocumentOverlay>();
    for (const overlay of request.overlays) {
      const key = environment.fileUriPathKey(overlay.uri);
      if (overlays.has(key))
        throw new Error('editor inventory has conflicting open buffers for one file');
      overlays.set(key, overlay);
    }
    for (const document of context.openedDocuments) {
      current();
      const pathKey = environment.pathKey(document.path);
      const normalizedPath = environment.virtualPathForDiskPath(document.path, plan);
      if (
        !normalizedPath ||
        !environment.isCatalogAssetPath(document.path) ||
        plan.excludedPathKeys.has(pathKey) ||
        !overlays.has(pathKey)
      )
        continue;
      const match = { path: document.path, normalizedPath };
      await probes.authorizeOverlay(match);
      overlayMatches.push(match);
      if (!matches.some((candidate) => environment.pathKey(candidate.path) === pathKey)) {
        metadata.charge(
          normalizedPath,
          Buffer.byteLength(document.path, 'utf8') + Buffer.byteLength(normalizedPath, 'utf8') + 48,
        );
        matches.push(match);
      }
    }
    if (matches.length > sourceCatalogMaximumSources)
      throw new SourceCatalogDiscoveryError(
        'paths',
        'editor inventory',
        matches.length,
        sourceCatalogMaximumSources,
      );
    const sources: MainSourceCatalogEntry[] = [];
    const names = new Set<string>();
    const ids = new Set<string>();
    const bytes = { remainingBytes: sourceMaximumAggregateBytes };
    for (const match of matches) {
      current();
      const pathKey = environment.pathKey(match.path);
      const open = overlays.get(pathKey);
      const sourceId = open?.uri ?? pathToFileURL(match.path).href;
      const name = asciiFold(match.normalizedPath);
      if (names.has(name) || ids.has(sourceId))
        throw new Error('editor inventory contains ambiguous source identities or paths');
      names.add(name);
      ids.add(sourceId);
      metadata.charge(
        match.normalizedPath,
        Buffer.byteLength(match.normalizedPath, 'utf8') + Buffer.byteLength(sourceId, 'utf8') + 64,
      );
      const overlay = open
        ? (
            await environment.encodedOverlays(
              context,
              [open],
              Math.min(sourceMaximumFileBytes, bytes.remainingBytes),
            )
          )[0]
        : undefined;
      const snapshot = overlay ? null : await this.snapshots.read(match.path, bytes, probes);
      current();
      if (overlay) chargeSourceBytes(bytes, overlay.bytes.byteLength);
      const body = overlay?.bytes ?? snapshot!.bytes;
      sources.push({
        normalizedPath: match.normalizedPath,
        sourceId,
        source: body,
        rawHash: snapshot?.rawHash ?? environment.sha256(body),
        origin: overlay?.dirty
          ? 'dirty-buffer'
          : environment.originForDiskPath(match.path, plan, gameRoots),
        role: environment.roleForPath(
          match.path,
          match.normalizedPath === entryPath && environment.isRmsEntryPath(match.path),
        ),
        ...(overlay?.dirty ? { bufferRevision: overlay.version } : {}),
      });
    }
    sources.sort(environment.compareCatalogEntries);
    environment.validateCatalogMetadata(
      sources,
      '',
      roots,
      request.profileId,
      request.contentIdentity,
      definitions,
    );
    await probes.assertCurrent();
    for (const match of overlayMatches) await probes.authorizeOverlay(match);
    const openFolder = await environment.openFolderRoot(context);
    current();
    const grants = environment.authorizedTextSourcePaths(
      sources,
      request.documentUri ?? '',
      openFolder,
      gameRoots,
      plan,
    );
    probes.finishReadPhase();
    return {
      inventory: Object.freeze({
        kind: 'editor-inventory',
        contextId: randomUUID(),
        inventoryId: randomUUID(),
        sources: Object.freeze(sources),
        roots,
        caseSensitive: false,
        profileId: request.profileId,
        contentIdentity: request.contentIdentity,
        implicitDefinitions: definitions,
      }),
      witness: new EditorInventoryWitness(
        this.workspace,
        request.documentUri,
        contextIdentity,
        probes,
        overlayMatches,
        grants,
        request.contextEpoch,
        epoch,
      ),
    };
  }
}

function stale(): Error {
  return new SourceCatalogDiscoveryError('stale', 'editor inventory', 1, 0);
}
