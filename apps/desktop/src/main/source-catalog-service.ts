import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { DesktopError } from '../shared/desktop-error';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  SourceSnapshotCache,
  SourceByteLimitError,
  sourceMaximumFileBytes,
  sourceMaximumAggregateBytes,
  chargeSourceBytes as chargeCatalogBudget,
  type SourceByteBudget as CatalogByteBudget,
} from './source-snapshot-cache';
import { authorizedIncludeSourceIds } from './include-grants';
import { encodeSourceText } from './source-codec';
import { FileTooLargeError } from './bounded-file';
import { RequiredSourceLimitError } from './source-catalog-limits';
import type { SourceCatalogBatchBudget } from './source-catalog-batch';
import type { SourceCatalogDiscovery } from './source-catalog-discovery';
import {
  asciiFold,
  SourceCatalogDiscoveryError,
  SourceCatalogProbes,
  SourceDiscoveryBudget,
  type SourceCatalogProbeMatch,
} from './source-catalog-probes';
import type { PreviewGenerationResult, StandardIncludeAccess } from '../shared/api';
import type { SourceCatalogWorkspaceContext, WorkspaceService } from './workspace-service';

export const sourceCatalogMaximumSources = 4_096;
export const sourceCatalogMaximumFileBytes = sourceMaximumFileBytes;
export const sourceCatalogMaximumAggregateBytes = sourceMaximumAggregateBytes;
export const sourceCatalogMaximumMetadataBytes = 2 * 1024 * 1024;

export type MainSourceCatalogOrigin =
  'workspace' | 'dirty-buffer' | 'deployed-map' | 'game-data' | 'implicit-environment';
export type MainSourceCatalogRole = 'rms-entry' | 'rms-dependency' | 'external-xs';

export interface MainSourceCatalogEntry {
  normalizedPath: string;
  sourceId: string;
  rawHash: Uint8Array;
  source: Uint8Array;
  origin: MainSourceCatalogOrigin;
  role: MainSourceCatalogRole;
  bufferRevision?: number;
}

export interface MainSourceCatalog {
  contractVersion: Readonly<{ major: 1; minor: 0; patch: 0 }>;
  revision: number;
  entryPath: string;
  sources: readonly MainSourceCatalogEntry[];
  roots: Readonly<{
    openedOrConfigured: readonly string[];
    deployedMapContext?: string;
    gameGamedataX2?: string;
    implicitEnvironment?: string;
    gameXs?: string;
    standardIncludes: readonly string[];
    standardIncludesAuthorized: boolean;
  }>;
  caseSensitive: boolean;
  profileId: string;
  contentIdentity: string;
  implicitDefinitions: Readonly<Record<string, string>>;
  implicitEnvironmentHash: Uint8Array;
  catalogHash: Uint8Array;
  rmsGraphHash: Uint8Array;
  externalAssetHash: Uint8Array;
}

export interface LanguageDocumentOverlay {
  uri: string;
  version: number;
  text: string;
}

export interface AuthorizedGameRoots {
  gamedata: string | null;
  xs: string | null;
  randomMapDefinitions: string | null;
}

interface PhysicalCatalogRoot {
  path: string;
  virtualRoot: string;
}

interface CatalogRootPlan {
  collectionRoots: readonly PhysicalCatalogRoot[];
  workspacePhysicalRoot: string | null;
  deployedMapPhysicalRoot: string | null;
  workspaceVirtualRoot: string | null;
  gamedataVirtualRoot: string | null;
  xsVirtualRoot: string | null;
  excludedPathKeys: ReadonlySet<string>;
}

export interface SourceCatalogBuildRequest {
  documentUri: string;
  documentRevision: number;
  source: string;
  profileId: string;
  contentIdentity: string;
  implicitDefinitions: Readonly<Record<string, string>>;
  standardIncludes: readonly string[];
  standardIncludesRequested: boolean;
  installationRoot: string | null;
  overlays: readonly LanguageDocumentOverlay[];
  identityScope?: 'generation' | 'language';
  batchBudget?: SourceCatalogBatchBudget;
  assertCurrent?: () => void;
}

export interface DeploymentCatalogIdentity {
  revision: number;
  catalogHash: string;
  rmsGraphHash: string;
  externalAssetHash: string;
}

export interface AuthorizedDeploymentGraph {
  catalog: MainSourceCatalog;
  documentUri: string;
  documentRevision: number;
  resolvedRmsSourceIds: readonly string[];
  externalAssetSourceIds: readonly string[];
  semanticHash: string | null;
}

export class SourceCatalogService {
  private readonly revisions = new Map<'generation' | 'language', number>();
  private readonly latestIdentities = new Map<'generation' | 'language', string>();
  readonly snapshotCache = new SourceSnapshotCache();
  private readonly authorizedSourcePaths = new Map<
    'generation' | 'language',
    ReadonlyMap<string, string>
  >();
  private catalogInventoryEpoch = 0;
  private readonly catalogEpochs = new WeakMap<MainSourceCatalog, number>();
  private readonly catalogWitnesses = new WeakMap<
    MainSourceCatalog,
    {
      documentUri: string;
      contextIdentity: string;
      probes: SourceCatalogProbes;
      overlays: readonly SourceCatalogProbeMatch[];
      scope: 'generation' | 'language' | 'snapshot';
    }
  >();
  private latestGenerationCatalog: MainSourceCatalog | null = null;
  private latestLanguageCatalog: MainSourceCatalog | null = null;
  private latestDeploymentGraph: AuthorizedDeploymentGraph | null = null;

  constructor(
    private readonly workspace: WorkspaceService,
    private readonly discovery: SourceCatalogDiscovery,
    private readonly onInvalidated: () => void = () => {},
  ) {}

  identityEpoch(): number {
    return this.catalogInventoryEpoch;
  }

  async build(request: SourceCatalogBuildRequest): Promise<MainSourceCatalog> {
    validateBuildRequest(request);
    request.batchBudget?.charge('roots', 1);
    request.assertCurrent?.();
    const epoch = this.catalogInventoryEpoch;
    const context = this.workspace.sourceCatalogContext(request.documentUri);
    const contextIdentity = JSON.stringify(context);
    const workspaceRoot = await authorizedWorkspaceRoot(context);
    const deployedMapRoot = await authorizedDeployedMapRoot(context);
    const gameRoots = await authorizedGameRoots(request.installationRoot);
    request.assertCurrent?.();
    const standardIncludesAuthorized =
      standardIncludeAccess(
        request.standardIncludesRequested,
        request.installationRoot,
        gameRoots.gamedata,
      ) === 'authorized';
    const rootPlan = planCatalogRoots(
      workspaceRoot,
      deployedMapRoot,
      gameRoots,
      standardIncludesAuthorized,
    );
    const entryPath = context.entryPath
      ? virtualPathForDiskPath(context.entryPath, rootPlan)
      : `entry/${boundedVirtualName(request.documentUri)}`;
    if (!entryPath || !isRmsEntryPath(entryPath)) {
      throw new Error('source catalog entry must be an .rms or .rms2 document');
    }
    const implicitDefinitions = canonicalDefinitions(request.implicitDefinitions);
    let roots = catalogResolverRoots(
      rootPlan,
      virtualParent(entryPath),
      Object.keys(implicitDefinitions).length,
      canonicalStandardIncludes(request.standardIncludes),
      standardIncludesAuthorized,
    );
    const discoveryBudget = new SourceDiscoveryBudget(
      request.batchBudget ? (bytes) => request.batchBudget!.charge('metadata', bytes) : undefined,
    );
    discoveryBudget.charge(
      entryPath,
      validateCatalogMetadata(
        [],
        entryPath,
        roots,
        request.profileId,
        request.contentIdentity,
        implicitDefinitions,
      ) +
        utf8Length(entryPath) +
        utf8Length(request.documentUri) +
        64,
      true,
    );
    request.batchBudget?.charge('records', 1);
    const overlays = await requiredEncoding(entryPath, () =>
      encodedOverlays(
        context,
        request.overlays.filter(
          (overlay) =>
            fileUriPathKey(overlay.uri) === fileUriPathKey(request.documentUri) &&
            overlay.text === request.source,
        ),
        sourceCatalogMaximumFileBytes,
        request.batchBudget ? (bytes) => request.batchBudget!.checkBytes(bytes) : undefined,
      ),
    );
    const entries = new Map<string, MainSourceCatalogEntry>();
    const budget: CatalogByteBudget = {
      remainingBytes: sourceCatalogMaximumAggregateBytes,
      ...(request.batchBudget
        ? {
            beforeCharge: (bytes: number) => request.batchBudget!.charge('bytes', bytes),
            readCeiling: () => request.batchBudget!.remainingSourceBytes(),
          }
        : {}),
    };
    const entryBytes = await requiredEncoding(entryPath, () =>
      entrySourceBytes(request, context, overlays),
    );
    if (entryBytes.byteLength > sourceCatalogMaximumFileBytes) {
      throw new SourceByteLimitError(
        'file',
        entryBytes.byteLength,
        sourceCatalogMaximumFileBytes,
        entryPath,
      );
    }
    chargeCatalogBudget(budget, entryBytes.byteLength, entryPath);
    const origin = entryOrigin(request, context, entryBytes, rootPlan, gameRoots);
    entries.set(asciiFold(entryPath), {
      normalizedPath: entryPath,
      sourceId: request.documentUri,
      rawHash: sha256(entryBytes),
      source: entryBytes,
      origin,
      role: 'rms-entry',
      ...(origin === 'dirty-buffer' ? { bufferRevision: request.documentRevision } : {}),
    });

    const assertBuildCurrent = (): void => {
      request.assertCurrent?.();
      if (
        epoch !== this.catalogInventoryEpoch ||
        contextIdentity !== JSON.stringify(this.workspace.sourceCatalogContext(request.documentUri))
      ) {
        throw new SourceCatalogDiscoveryError('stale', request.documentUri, 1, 0);
      }
    };
    const probes = new SourceCatalogProbes(
      rootPlan.collectionRoots,
      discoveryBudget,
      assertBuildCurrent,
    );
    await probes.initialize();
    if (
      request.batchBudget &&
      context.entryPath &&
      !request.overlays.some(
        (overlay) => fileUriPathKey(overlay.uri) === fileUriPathKey(request.documentUri),
      )
    ) {
      await probes.recordClosedFile(
        { path: context.entryPath, normalizedPath: entryPath },
        entries.get(asciiFold(entryPath))!.rawHash,
        entryBytes.byteLength,
      );
    }
    let metadataBytes = validateCatalogMetadata(
      [...entries.values()],
      entryPath,
      roots,
      request.profileId,
      request.contentIdentity,
      implicitDefinitions,
    );
    const selectedOverlayMatches = new Map<string, SourceCatalogProbeMatch>();
    const matchesFor = async (path: string): Promise<readonly SourceCatalogProbeMatch[]> => {
      const matches = [...(await probes.probe(path))];
      for (const document of context.openedDocuments) {
        const virtualPath = virtualPathForDiskPath(document.path, rootPlan);
        if (
          !virtualPath ||
          asciiFold(virtualPath) !== asciiFold(path) ||
          !request.overlays.some(
            (overlay) => fileUriPathKey(overlay.uri) === fileUriPathKey(document.uri),
          )
        )
          continue;
        const match = { path: document.path, normalizedPath: virtualPath };
        await probes.authorizeOverlay(match);
        if (!selectedOverlayMatches.has(document.path)) {
          discoveryBudget.charge(
            virtualPath,
            Buffer.byteLength(document.path, 'utf8') + Buffer.byteLength(virtualPath, 'utf8') + 48,
            true,
          );
          selectedOverlayMatches.set(document.path, match);
        }
        if (!matches.some((candidate) => pathKey(candidate.path) === pathKey(document.path)))
          matches.push(match);
      }
      return matches;
    };
    const queue = [...entries.values()];
    const includeKeys = new Set<string>();
    for (let index = 0; index < queue.length; index += 1) {
      const source = queue[index]!;
      if (source.role === 'external-xs' || source.origin === 'implicit-environment') continue;
      const requests = await this.discovery.scan({
        sourceId: source.sourceId,
        source: source.source,
        profileId: request.profileId,
        implicitDefinitions,
      });
      for (const include of requests) {
        const key = `${include.kind}:${include.path}`;
        if (includeKeys.has(key)) continue;
        includeKeys.add(key);
        discoveryBudget.charge(source.normalizedPath, Buffer.byteLength(key, 'utf8') + 32);
        if (includeKeys.size > 4096)
          throw new SourceCatalogDiscoveryError(
            'paths',
            source.normalizedPath,
            includeKeys.size,
            4096,
          );
      }
      if (requests.length === 0) continue;
      const namespaceEvidence: Array<{ path: string; present: boolean }> = [];
      let lookup = await this.discovery.lookup({
        sourcePath: source.normalizedPath,
        requests,
        roots,
        caseSensitive: false,
        namespaceEvidence,
      });
      if ('namespacePaths' in lookup) {
        for (const path of lookup.namespacePaths) {
          namespaceEvidence.push({ path, present: (await matchesFor(path)).length > 0 });
        }
        lookup = await this.discovery.lookup({
          sourcePath: source.normalizedPath,
          requests,
          roots,
          caseSensitive: false,
          namespaceEvidence,
        });
      }
      if ('namespacePaths' in lookup)
        throw new Error('source discovery did not consume complete namespace evidence');
      const standardIncludes = canonicalStandardIncludes(lookup.standardIncludes);
      const standardMetadata =
        standardIncludes.reduce((bytes, name) => bytes + utf8Length(name) + 8, 0) -
        roots.standardIncludes.reduce((bytes, name) => bytes + utf8Length(name) + 8, 0);
      metadataBytes += standardMetadata;
      discoveryBudget.charge(source.normalizedPath, Math.max(0, standardMetadata), true);
      roots = { ...roots, standardIncludes };
      assertCatalogMetadataBudget(metadataBytes, source.normalizedPath);
      for (const plan of lookup.plans) {
        for (const path of plan.paths) {
          const matches = await matchesFor(path);
          if (matches.length > 1)
            throw new DesktopError(
              'source-catalog.case-variants',
              `source catalog contains ambiguous case variants for ${path}`,
              { path },
            );
          for (const match of matches) {
            if (rootPlan.excludedPathKeys.has(pathKey(match.path))) continue;
            const key = asciiFold(match.normalizedPath);
            if (entries.has(key)) continue;
            if (!isCatalogAssetPath(match.path))
              throw new DesktopError(
                'source-catalog.unsupported-include',
                `source catalog dependency has an unsupported extension: ${match.normalizedPath}`,
                { path: match.normalizedPath },
              );
            if (entries.size >= sourceCatalogMaximumSources)
              throw new RequiredSourceLimitError(
                'records',
                match.normalizedPath,
                entries.size + 1,
                sourceCatalogMaximumSources,
              );
            const relevant = request.overlays.filter(
              (overlay) => fileUriPathKey(overlay.uri) === pathKey(match.path),
            );
            if (relevant.length > 1)
              throw new Error('source catalog has conflicting open buffers for one file');
            const selectedMetadata =
              utf8Length(match.normalizedPath) +
              utf8Length(relevant[0]?.uri ?? pathToFileURL(match.path).href) +
              64;
            request.batchBudget?.charge('records', 1);
            metadataBytes += selectedMetadata;
            discoveryBudget.charge(match.normalizedPath, selectedMetadata, true);
            assertCatalogMetadataBudget(metadataBytes, match.normalizedPath);
            const overlay = (
              await requiredEncoding(match.normalizedPath, () =>
                encodedOverlays(context, relevant, sourceCatalogMaximumFileBytes, (bytes) => {
                  if (bytes > budget.remainingBytes)
                    throw new SourceByteLimitError(
                      'aggregate',
                      sourceCatalogMaximumAggregateBytes - budget.remainingBytes + bytes,
                      sourceCatalogMaximumAggregateBytes,
                      match.normalizedPath,
                    );
                  request.batchBudget?.checkBytes(bytes);
                }),
              )
            )[0];
            const snapshot = overlay
              ? null
              : await this.snapshotCache.read(match.path, budget, probes);
            if (overlay) {
              if (overlay.bytes.byteLength > sourceCatalogMaximumFileBytes)
                throw new SourceByteLimitError(
                  'file',
                  overlay.bytes.byteLength,
                  sourceCatalogMaximumFileBytes,
                  match.normalizedPath,
                );
              chargeCatalogBudget(budget, overlay.bytes.byteLength, match.normalizedPath);
            }
            const bytes = overlay?.bytes ?? snapshot!.bytes;
            const selected: MainSourceCatalogEntry = {
              normalizedPath: match.normalizedPath,
              sourceId: overlay?.uri ?? pathToFileURL(match.path).href,
              rawHash: snapshot?.rawHash ?? sha256(bytes),
              source: bytes,
              origin: overlay?.dirty
                ? 'dirty-buffer'
                : originForDiskPath(match.path, rootPlan, gameRoots),
              role: roleForPath(match.path, false),
              ...(overlay?.dirty ? { bufferRevision: overlay.version } : {}),
            };
            entries.set(key, selected);
            queue.push(selected);
          }
        }
      }
      assertBuildCurrent();
    }
    await probes.assertCurrent();
    for (const match of selectedOverlayMatches.values()) await probes.authorizeOverlay(match);
    assertBuildCurrent();
    const sources = [...entries.values()].sort(compareCatalogEntries);
    validateCatalogEntries(sources, entryPath);
    validateCatalogMetadata(
      sources,
      entryPath,
      roots,
      request.profileId,
      request.contentIdentity,
      implicitDefinitions,
    );
    const implicitEnvironmentHash = hashImplicitDefinitions(implicitDefinitions);
    const rmsGraphHash = hashSources(sources, false);
    const externalAssetHash = hashSources(sources, true);
    const identity = JSON.stringify({
      entryPath,
      sources: sources.map((source) => [
        source.normalizedPath,
        source.sourceId,
        Buffer.from(source.rawHash).toString('hex'),
        source.origin,
        source.role,
      ]),
      roots,
      request: [request.profileId, request.contentIdentity],
      implicitEnvironmentHash: Buffer.from(implicitEnvironmentHash).toString('hex'),
    });
    const identityScope = request.identityScope ?? 'generation';
    const openFolder = await openFolderRoot(context);
    assertBuildCurrent();
    if (!request.batchBudget)
      this.authorizedSourcePaths.set(
        identityScope,
        authorizedTextSourcePaths(sources, request.documentUri, openFolder, gameRoots, rootPlan),
      );
    let revision = request.batchBudget?.catalogRevision() ?? this.revisions.get(identityScope) ?? 0;
    if (!request.batchBudget && identity !== this.latestIdentities.get(identityScope)) {
      this.latestIdentities.set(identityScope, identity);
      revision += 1;
      this.revisions.set(identityScope, revision);
    }
    const catalogHash = hashCatalog({
      entryPath,
      sources,
      roots,
      profileId: request.profileId,
      contentIdentity: request.contentIdentity,
      implicitEnvironmentHash,
      rmsGraphHash,
      externalAssetHash,
    });
    const catalog = Object.freeze({
      contractVersion: Object.freeze({ major: 1, minor: 0, patch: 0 }),
      revision,
      entryPath,
      sources: Object.freeze(sources),
      roots: Object.freeze(roots),
      caseSensitive: false,
      profileId: request.profileId,
      contentIdentity: request.contentIdentity,
      implicitDefinitions: Object.freeze(implicitDefinitions),
      implicitEnvironmentHash,
      catalogHash,
      rmsGraphHash,
      externalAssetHash,
    });
    if (!request.batchBudget) {
      if (identityScope === 'generation') this.latestGenerationCatalog = catalog;
      else this.latestLanguageCatalog = catalog;
    }
    this.catalogEpochs.set(catalog, epoch);
    probes.finishReadPhase();
    this.catalogWitnesses.set(catalog, {
      documentUri: request.documentUri,
      contextIdentity,
      probes,
      overlays: [...selectedOverlayMatches.values()],
      scope: request.batchBudget ? 'snapshot' : identityScope,
    });
    return catalog;
  }

  async validateWitnesses(catalog: MainSourceCatalog): Promise<void> {
    await this.validateCatalogWitnesses(catalog, true);
  }

  async validateSnapshotWitnesses(catalog: MainSourceCatalog): Promise<void> {
    await this.validateCatalogWitnesses(catalog, false);
  }

  private async validateCatalogWitnesses(
    catalog: MainSourceCatalog,
    requireLatest: boolean,
  ): Promise<void> {
    const witness = this.catalogWitnesses.get(catalog);
    if (!witness) throw new Error('source catalog has no current witness set');
    const current = () => {
      if (requireLatest) {
        if (witness.scope === 'snapshot')
          throw new Error('map-test snapshot is not current generation authority');
        this.assertCurrent(catalog, witness.scope);
      } else if (this.catalogEpochs.get(catalog) !== this.catalogInventoryEpoch)
        throw new SourceCatalogDiscoveryError('stale', witness.documentUri, 1, 0);
      if (
        !sourceContextMatches(
          witness.contextIdentity,
          this.workspace.sourceCatalogContext(witness.documentUri),
          witness.scope === 'snapshot',
        )
      )
        throw new SourceCatalogDiscoveryError('stale', witness.documentUri, 1, 0);
    };
    current();
    await witness.probes.assertCurrent();
    for (const overlay of witness.overlays) await witness.probes.authorizeOverlay(overlay);
    current();
  }

  assertCurrent(
    catalog: MainSourceCatalog,
    identityScope: 'generation' | 'language' = 'generation',
  ): void {
    if (
      this.catalogWitnesses.get(catalog)?.scope === 'snapshot' ||
      this.catalogEpochs.get(catalog) !== this.catalogInventoryEpoch ||
      catalog.revision !== (this.revisions.get(identityScope) ?? 0)
    ) {
      throw new DesktopError(
        'source-catalog.changed',
        'source catalog changed while generation was in flight',
      );
    }
  }

  authorizedTextSourcePath(sourceId: string): string {
    if (typeof sourceId !== 'string' || sourceId.length < 1 || sourceId.length > 4096) {
      throw new Error('source identity is invalid');
    }
    for (const scope of ['generation', 'language'] as const) {
      const path = this.authorizedSourcePaths.get(scope)?.get(sourceId);
      if (path) return path;
    }
    let requested: string | null = null;
    try {
      requested = pathKey(fileURLToPath(sourceId));
    } catch {
      requested = null;
    }
    if (requested) {
      for (const scope of ['generation', 'language'] as const) {
        for (const path of this.authorizedSourcePaths.get(scope)?.values() ?? []) {
          if (pathKey(path) === requested) return path;
        }
      }
    }
    throw new DesktopError(
      'source-catalog.changed',
      'source identity is absent from the current authorized catalog',
    );
  }

  async authorizedTextSourceRead(sourceId: string): Promise<{
    path: string;
    beforeRead(metadata: Stats): Promise<void>;
    afterRead(): Promise<void>;
    current(): void;
  }> {
    const requested = fileUriPathKey(sourceId);
    let refused: unknown;
    for (const catalog of [this.latestGenerationCatalog, this.latestLanguageCatalog]) {
      if (!catalog) continue;
      const witness = this.catalogWitnesses.get(catalog);
      if (!witness || witness.scope === 'snapshot') continue;
      const scope = witness.scope;
      const path = [...(this.authorizedSourcePaths.get(scope) ?? [])].find(
        ([uri]) => fileUriPathKey(uri) === requested,
      )?.[1];
      if (!path) continue;
      const current = () => {
        this.assertCurrent(catalog, scope);
        if (
          witness.contextIdentity !==
          JSON.stringify(this.workspace.sourceCatalogContext(witness.documentUri))
        )
          throw new SourceCatalogDiscoveryError('stale', sourceId, 1, 0);
      };
      try {
        await this.validateWitnesses(catalog);
        current();
      } catch (error) {
        refused = error;
        continue;
      }
      return {
        path,
        current,
        beforeRead: async (metadata) => {
          current();
          await witness.probes.authorizeRead(path, metadata);
          current();
        },
        afterRead: () => this.validateWitnesses(catalog),
      };
    }
    if (refused) throw refused;
    throw new DesktopError(
      'source-catalog.changed',
      'source identity is absent from the current authorized catalog',
    );
  }

  deploymentCatalog(identity: DeploymentCatalogIdentity): MainSourceCatalog {
    const catalog = this.latestGenerationCatalog;
    if (!catalog || catalog.revision !== identity.revision) {
      throw new DesktopError(
        'source-catalog.preview-stale',
        'the preview source catalog is stale or unavailable',
      );
    }
    const identities = [
      [identity.catalogHash, catalog.catalogHash],
      [identity.rmsGraphHash, catalog.rmsGraphHash],
      [identity.externalAssetHash, catalog.externalAssetHash],
    ] as const;
    if (
      identities.some(
        ([requested, actual]) => !/^[a-f0-9]{64}$/u.test(requested) || requested !== hex(actual),
      )
    ) {
      throw new DesktopError(
        'source-catalog.preview-stale',
        'the preview source identities do not match the current catalog',
      );
    }
    this.assertCurrent(catalog);
    return catalog;
  }

  authorizeExactDeployment(
    catalog: MainSourceCatalog,
    result: PreviewGenerationResult,
  ): AuthorizedDeploymentGraph {
    this.assertCurrent(catalog);
    if (
      result.sourceCatalogRevision !== catalog.revision ||
      result.sourceCatalogHash !== hex(catalog.catalogHash) ||
      result.sourceGraphHash !== hex(catalog.rmsGraphHash) ||
      result.externalAssetHash !== hex(catalog.externalAssetHash)
    ) {
      throw new Error('the generated result cannot authorize a mismatched deployment graph');
    }
    const sources = new Map(catalog.sources.map((source) => [source.sourceId, source]));
    const resolved = new Set(result.resolvedRmsSourceIds);
    const external = new Set(result.externalAssetSourceIds);
    const entry = sources.get(result.documentUri);
    if (
      resolved.size !== result.resolvedRmsSourceIds.length ||
      external.size !== result.externalAssetSourceIds.length ||
      !entry ||
      entry.role !== 'rms-entry' ||
      !resolved.has(result.documentUri) ||
      result.resolvedRmsSourceIds.some((sourceId) => {
        const source = sources.get(sourceId);
        return !source || source.role === 'external-xs' || external.has(sourceId);
      }) ||
      result.externalAssetSourceIds.some(
        (sourceId) => sources.get(sourceId)?.role !== 'external-xs',
      )
    ) {
      throw new Error('the generated result contains an invalid deployment allowlist');
    }
    const graph: AuthorizedDeploymentGraph = Object.freeze({
      catalog,
      documentUri: result.documentUri,
      documentRevision: result.documentRevision,
      resolvedRmsSourceIds: Object.freeze([...result.resolvedRmsSourceIds]),
      externalAssetSourceIds: Object.freeze([...result.externalAssetSourceIds]),
      semanticHash:
        typeof result.semanticHash === 'string' && /^[a-f0-9]{64}$/u.test(result.semanticHash)
          ? result.semanticHash
          : null,
    });
    this.latestDeploymentGraph = graph;
    return graph;
  }

  authorizedDeploymentGraph(
    identity: DeploymentCatalogIdentity & { documentUri: string; documentRevision: number },
  ): AuthorizedDeploymentGraph {
    const catalog = this.deploymentCatalog(identity);
    const graph = this.latestDeploymentGraph;
    if (
      !graph ||
      graph.catalog !== catalog ||
      graph.documentUri !== identity.documentUri ||
      graph.documentRevision !== identity.documentRevision
    ) {
      throw new DesktopError(
        'source-catalog.preview-stale',
        'deployment requires the current successful preview revision',
      );
    }
    return graph;
  }

  invalidate(path: string | null = null): void {
    this.catalogInventoryEpoch += 1;
    this.onInvalidated();
    this.latestGenerationCatalog = null;
    this.latestLanguageCatalog = null;
    this.latestDeploymentGraph = null;
    if (path) {
      this.snapshotCache.invalidate(path);
      for (const [scope, sources] of this.authorizedSourcePaths) {
        this.authorizedSourcePaths.set(
          scope,
          new Map([...sources].filter(([, sourcePath]) => !isInside(sourcePath, path))),
        );
      }
    } else {
      this.snapshotCache.invalidate();
      this.authorizedSourcePaths.clear();
    }
  }
}

function sourceContextMatches(
  expected: string,
  current: SourceCatalogWorkspaceContext,
  snapshot: boolean,
): boolean {
  if (!snapshot) return expected === JSON.stringify(current);
  const original = JSON.parse(expected) as SourceCatalogWorkspaceContext;
  const uris = new Set(original.openedDocuments.map((document) => document.uri));
  return (
    expected ===
    JSON.stringify({
      ...current,
      openedDocuments: current.openedDocuments.filter((document) => uris.has(document.uri)),
    })
  );
}

function authorizedTextSourcePaths(
  sources: readonly MainSourceCatalogEntry[],
  entrySourceId: string,
  openFolder: string | null,
  gameRoots: AuthorizedGameRoots,
  rootPlan: CatalogRootPlan,
): ReadonlyMap<string, string> {
  const broadRoots = [openFolder, gameRoots.gamedata, gameRoots.xs].filter(
    (root): root is string => root !== null,
  );
  const granted = authorizedIncludeSourceIds(sources, {
    entrySourceId,
    broadRoots,
    resolutionRoots: [
      ...new Set(
        [
          rootPlan.workspacePhysicalRoot,
          rootPlan.deployedMapPhysicalRoot,
          gameRoots.gamedata,
          gameRoots.xs,
        ].filter((root): root is string => root !== null),
      ),
    ],
  });
  const paths = new Map<string, string>();
  for (const source of sources) {
    if (!granted.has(source.sourceId)) continue;
    try {
      paths.set(source.sourceId, fileURLToPath(source.sourceId));
    } catch {}
  }
  return paths;
}

async function openFolderRoot(context: SourceCatalogWorkspaceContext): Promise<string | null> {
  if (!context.workspaceRoot) return null;
  try {
    return await realpath(context.workspaceRoot);
  } catch {
    return null;
  }
}

async function authorizedWorkspaceRoot(
  context: SourceCatalogWorkspaceContext,
): Promise<string | null> {
  const requested =
    context.workspaceRoot ?? (context.entryPath ? dirname(context.entryPath) : null);
  if (!requested) return null;
  const canonical = await realpath(requested);
  const metadata = await lstat(canonical);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('source catalog workspace root is not a regular directory');
  }
  return canonical;
}

async function authorizedDeployedMapRoot(
  context: SourceCatalogWorkspaceContext,
): Promise<string | null> {
  if (!context.entryPath) return null;
  const canonical = await realpath(dirname(context.entryPath));
  const metadata = await lstat(canonical);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('source catalog deployed-map root is not a regular directory');
  }
  return canonical;
}

export function standardIncludeAccess(
  requested: boolean,
  installationRoot: string | null,
  gamedataRoot: string | null,
): StandardIncludeAccess {
  if (!installationRoot) return 'no-linked-installation';
  if (!gamedataRoot) return 'missing-gamedata';
  if (!requested) return 'packaged-selection';
  return 'authorized';
}

export async function resolveStandardIncludeAccess(
  requested: boolean,
  installationRoot: string | null,
): Promise<StandardIncludeAccess> {
  if (!installationRoot) return 'no-linked-installation';
  let gameRoots: AuthorizedGameRoots;
  try {
    gameRoots = await authorizedGameRoots(installationRoot);
  } catch {
    return 'no-linked-installation';
  }
  return standardIncludeAccess(requested, installationRoot, gameRoots.gamedata);
}

export async function authorizedGameRoots(
  installationRoot: string | null,
): Promise<AuthorizedGameRoots> {
  if (!installationRoot) return { gamedata: null, xs: null, randomMapDefinitions: null };
  const root = await realpath(resolve(installationRoot));
  const gamedata = await optionalCanonicalDirectory(
    join(root, 'resources', '_common', 'drs', 'gamedata_x2'),
    root,
  );
  const xs = await optionalCanonicalDirectory(join(root, 'resources', '_common', 'xs'), root);
  const randomMapDefinitions = gamedata
    ? await optionalCanonicalFile(join(gamedata, 'random_map.def'), gamedata)
    : null;
  return { gamedata, xs, randomMapDefinitions };
}

async function optionalCanonicalDirectory(candidate: string, root: string): Promise<string | null> {
  try {
    const canonical = await realpath(candidate);
    if (!isInside(canonical, root)) {
      throw new DesktopError('game-folder.unsafe', 'catalog root escaped the installation');
    }
    const metadata = await lstat(canonical);
    return metadata.isDirectory() && !metadata.isSymbolicLink() ? canonical : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function optionalCanonicalFile(candidate: string, root: string): Promise<string | null> {
  try {
    const canonical = await realpath(candidate);
    if (!isInside(canonical, root)) {
      throw new DesktopError('game-folder.unsafe', 'implicit definitions escaped the game root');
    }
    const metadata = await lstat(canonical);
    return metadata.isFile() && !metadata.isSymbolicLink() ? canonical : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function planCatalogRoots(
  workspaceRoot: string | null,
  deployedMapRoot: string | null,
  gameRoots: AuthorizedGameRoots,
  standardIncludesAuthorized: boolean,
): CatalogRootPlan {
  const requestedRoots = [
    workspaceRoot ? { path: workspaceRoot, virtualRoot: 'workspace' } : null,
    deployedMapRoot ? { path: deployedMapRoot, virtualRoot: 'deployed' } : null,
    gameRoots.gamedata ? { path: gameRoots.gamedata, virtualRoot: 'game' } : null,
    gameRoots.xs ? { path: gameRoots.xs, virtualRoot: 'game-xs' } : null,
  ].filter((root): root is PhysicalCatalogRoot => root !== null);
  const uniqueRoots: PhysicalCatalogRoot[] = [];
  for (const root of requestedRoots) {
    if (!uniqueRoots.some((candidate) => pathKey(candidate.path) === pathKey(root.path))) {
      uniqueRoots.push(root);
    }
  }
  const collectionRoots = uniqueRoots.filter(
    (root) =>
      !uniqueRoots.some(
        (candidate) =>
          pathKey(candidate.path) !== pathKey(root.path) && isInside(root.path, candidate.path),
      ),
  );
  const virtualRootFor = (path: string | null): string | null => {
    if (!path) return null;
    const owner = collectionRoots.find((root) => isInside(path, root.path));
    if (!owner) throw new Error('source catalog root has no canonical physical owner');
    const suffix = relative(owner.path, path).replaceAll('\\', '/');
    return suffix ? `${owner.virtualRoot}/${suffix}` : owner.virtualRoot;
  };
  return {
    collectionRoots,
    workspacePhysicalRoot: workspaceRoot,
    deployedMapPhysicalRoot: deployedMapRoot,
    workspaceVirtualRoot: virtualRootFor(workspaceRoot),
    gamedataVirtualRoot: virtualRootFor(gameRoots.gamedata),
    xsVirtualRoot: virtualRootFor(gameRoots.xs),
    excludedPathKeys: new Set(
      gameRoots.randomMapDefinitions && !standardIncludesAuthorized
        ? [pathKey(gameRoots.randomMapDefinitions)]
        : [],
    ),
  };
}

async function encodedOverlays(
  context: SourceCatalogWorkspaceContext,
  overlays: readonly LanguageDocumentOverlay[],
  maximumBytes = sourceCatalogMaximumFileBytes,
  beforeEncode?: (bytes: number) => void,
): Promise<Array<LanguageDocumentOverlay & { path: string; bytes: Uint8Array; dirty: boolean }>> {
  const metadata = new Map(
    context.openedDocuments.map((document) => [fileUriPathKey(document.uri), document]),
  );
  return overlays.flatMap((overlay) => {
    const document = metadata.get(fileUriPathKey(overlay.uri));
    if (!document || !isCatalogAssetPath(document.path)) return [];
    const bytes = encodeSourceText(
      overlay.text,
      document.encoding,
      document.newlineStyle,
      maximumBytes,
      beforeEncode,
    );
    return [
      { ...overlay, path: document.path, bytes, dirty: hex(sha256(bytes)) !== document.diskHash },
    ];
  });
}

function fileUriPathKey(uri: string): string {
  try {
    return pathKey(fileURLToPath(uri));
  } catch {
    return uri.toLocaleLowerCase('en-US');
  }
}

async function entrySourceBytes(
  request: SourceCatalogBuildRequest,
  context: SourceCatalogWorkspaceContext,
  overlays: Readonly<Awaited<ReturnType<typeof encodedOverlays>>>,
): Promise<Uint8Array> {
  const overlay = overlays.find((candidate) => candidate.uri === request.documentUri);
  if (overlay && overlay.text === request.source) return overlay.bytes;
  const metadata = context.openedDocuments.find((document) => document.uri === request.documentUri);
  const beforeEncode = request.batchBudget
    ? (bytes: number) => request.batchBudget!.checkBytes(bytes)
    : undefined;
  return metadata
    ? encodeSourceText(
        request.source,
        metadata.encoding,
        metadata.newlineStyle,
        sourceCatalogMaximumFileBytes,
        beforeEncode,
      )
    : encodeSourceText(
        request.source,
        'utf8',
        'mixed',
        sourceCatalogMaximumFileBytes,
        beforeEncode,
      );
}

async function requiredEncoding<T>(scope: string, encode: () => T | Promise<T>): Promise<T> {
  try {
    return await encode();
  } catch (error) {
    if (error instanceof FileTooLargeError)
      throw new SourceByteLimitError(
        'file',
        error.observedBytes,
        sourceCatalogMaximumFileBytes,
        scope,
      );
    throw error;
  }
}

function entryOrigin(
  request: SourceCatalogBuildRequest,
  context: SourceCatalogWorkspaceContext,
  bytes: Uint8Array,
  rootPlan: CatalogRootPlan,
  gameRoots: AuthorizedGameRoots,
): MainSourceCatalogOrigin {
  const metadata = context.openedDocuments.find(
    (document) => fileUriPathKey(document.uri) === fileUriPathKey(request.documentUri),
  );
  if (!context.entryPath || metadata?.diskHash !== hex(sha256(bytes))) return 'dirty-buffer';
  return originForDiskPath(context.entryPath, rootPlan, gameRoots);
}

const maximumStandardIncludes = 4096;

function canonicalDefinitions(
  definitions: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const entries = Object.entries(definitions);
  if (entries.length > 65_536) throw new Error('implicit definition count exceeds its bound');
  for (const [name, value] of entries) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ||
      name.length > 256 ||
      typeof value !== 'string' ||
      value.length < 1 ||
      value.length > 256
    ) {
      throw new Error('implicit definition is invalid');
    }
  }
  return Object.freeze(Object.fromEntries(entries.sort(([left], [right]) => compare(left, right))));
}

function canonicalStandardIncludes(identifiers: readonly string[]): readonly string[] {
  const canonical = new Set(['random_map.def']);
  for (const identifier of identifiers) {
    const path = asciiFold(identifier.replaceAll('\\', '/'));
    if (
      path.length < 1 ||
      path.length > 4096 ||
      path.startsWith('/') ||
      path.includes(':') ||
      path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
    ) {
      throw new Error('standard include identifier is invalid');
    }
    canonical.add(path);
  }
  if (canonical.size > maximumStandardIncludes) {
    throw new Error('standard include inventory exceeds its bound');
  }
  return Object.freeze([...canonical].sort(compare));
}

function hashImplicitDefinitions(definitions: Readonly<Record<string, string>>): Uint8Array {
  const hash = createHash('sha256').update('rms-implicit-environment-v1');
  for (const [name, value] of Object.entries(definitions).sort(([left], [right]) =>
    compare(left, right),
  )) {
    updateString(hash, name);
    updateString(hash, value);
  }
  return hash.digest();
}

function hashSources(sources: readonly MainSourceCatalogEntry[], external: boolean): Uint8Array {
  const hash = createHash('sha256').update(
    external ? 'rms-external-assets-v1' : 'rms-source-graph-v1',
  );
  for (const source of sources) {
    if ((source.role === 'external-xs') !== external) continue;
    updateString(hash, source.normalizedPath);
    updateString(hash, source.sourceId);
    hash.update(source.rawHash);
    hash.update(Uint8Array.of(originOrdinal(source.origin), roleOrdinal(source.role)));
  }
  return hash.digest();
}

function hashCatalog(input: {
  entryPath: string;
  sources: readonly MainSourceCatalogEntry[];
  roots: MainSourceCatalog['roots'];
  profileId: string;
  contentIdentity: string;
  implicitEnvironmentHash: Uint8Array;
  rmsGraphHash: Uint8Array;
  externalAssetHash: Uint8Array;
}): Uint8Array {
  const hash = createHash('sha256').update('source-catalog-v1');
  hash.update(u32(1));
  hash.update(u32(0));
  hash.update(u32(0));
  updateString(hash, input.entryPath);
  updateString(hash, input.profileId);
  updateString(hash, input.contentIdentity);
  hash.update(Uint8Array.of(0));
  for (const root of input.roots.openedOrConfigured) updateString(hash, root);
  for (const root of [
    input.roots.deployedMapContext,
    input.roots.gameGamedataX2,
    input.roots.implicitEnvironment,
    input.roots.gameXs,
  ]) {
    hash.update(Uint8Array.of(root ? 1 : 0));
    if (root) updateString(hash, root);
  }
  for (const source of input.sources) {
    updateString(hash, source.normalizedPath);
    updateString(hash, source.sourceId);
    hash.update(source.rawHash);
    hash.update(Uint8Array.of(originOrdinal(source.origin), roleOrdinal(source.role)));
  }
  hash.update(input.implicitEnvironmentHash);
  hash.update(input.rmsGraphHash);
  hash.update(input.externalAssetHash);
  const { standardIncludes, standardIncludesAuthorized } = input.roots;
  if (standardIncludes.length > 0 || standardIncludesAuthorized) {
    hash.update('standard-include-access-v1');
    hash.update(Uint8Array.of(standardIncludesAuthorized ? 1 : 0));
    hash.update(u32(standardIncludes.length));
    for (const identifier of standardIncludes) updateString(hash, identifier);
  }
  return hash.digest();
}

function updateString(hash: ReturnType<typeof createHash>, value: string): void {
  const bytes = Buffer.from(value);
  hash.update(u32(bytes.byteLength));
  hash.update(bytes);
}

function validateCatalogEntries(
  sources: readonly MainSourceCatalogEntry[],
  entryPath: string,
): void {
  if (sources.length < 1) throw new Error('source catalog entry is absent');
  if (sources.length > sourceCatalogMaximumSources)
    throw new RequiredSourceLimitError(
      'records',
      entryPath,
      sources.length,
      sourceCatalogMaximumSources,
    );
  let aggregate = 0;
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const source of sources) {
    aggregate += source.source.byteLength;
    if (source.source.byteLength > sourceCatalogMaximumFileBytes)
      throw new SourceByteLimitError(
        'file',
        source.source.byteLength,
        sourceCatalogMaximumFileBytes,
        source.normalizedPath,
      );
    if (aggregate > sourceCatalogMaximumAggregateBytes)
      throw new SourceByteLimitError(
        'aggregate',
        aggregate,
        sourceCatalogMaximumAggregateBytes,
        source.normalizedPath,
      );
    if (ids.has(source.sourceId) || paths.has(asciiFold(source.normalizedPath))) {
      throw new Error('source catalog contains a duplicate source identity or path');
    }
    ids.add(source.sourceId);
    paths.add(asciiFold(source.normalizedPath));
  }
  if (
    !sources.some((source) => source.normalizedPath === entryPath && source.role === 'rms-entry')
  ) {
    throw new Error('source catalog entry is absent');
  }
}

function validateCatalogMetadata(
  sources: readonly MainSourceCatalogEntry[],
  entryPath: string,
  roots: MainSourceCatalog['roots'],
  profileId: string,
  contentIdentity: string,
  implicitDefinitions: Readonly<Record<string, string>>,
): number {
  let bytes = utf8Length(entryPath) + utf8Length(profileId) + utf8Length(contentIdentity);
  for (const root of [
    ...roots.openedOrConfigured,
    roots.deployedMapContext,
    roots.gameGamedataX2,
    roots.implicitEnvironment,
    roots.gameXs,
  ]) {
    if (root) bytes += utf8Length(root) + 8;
  }
  for (const identifier of roots.standardIncludes) bytes += utf8Length(identifier) + 8;
  for (const [name, value] of Object.entries(implicitDefinitions)) {
    bytes += utf8Length(name) + utf8Length(value) + 16;
  }
  for (const source of sources) {
    bytes += utf8Length(source.normalizedPath) + utf8Length(source.sourceId) + 64;
  }
  assertCatalogMetadataBudget(bytes, entryPath);
  return bytes;
}

function assertCatalogMetadataBudget(bytes: number, scope: string): void {
  if (!Number.isSafeInteger(bytes)) throw new Error('source catalog metadata amount is invalid');
  if (bytes > sourceCatalogMaximumMetadataBytes)
    throw new RequiredSourceLimitError('metadata', scope, bytes, sourceCatalogMaximumMetadataBytes);
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function validateBuildRequest(request: SourceCatalogBuildRequest): void {
  if (
    !request.documentUri ||
    request.documentUri.length > 4096 ||
    !Number.isSafeInteger(request.documentRevision) ||
    request.documentRevision < 0
  ) {
    throw new Error('source catalog document identity is invalid');
  }
  if (!request.profileId || !request.contentIdentity)
    throw new Error('source catalog context is invalid');
}

function catalogResolverRoots(
  plan: CatalogRootPlan,
  entryParent: string | undefined,
  implicitDefinitionCount: number,
  standardIncludes: readonly string[],
  standardIncludesAuthorized: boolean,
): MainSourceCatalog['roots'] {
  const used = new Set<string>();
  const distinct = (root: string | null | undefined): string | undefined => {
    if (!root || used.has(asciiFold(root))) return undefined;
    used.add(asciiFold(root));
    return root;
  };
  const authorizedGameRoot = standardIncludesAuthorized
    ? distinct(plan.gamedataVirtualRoot)
    : undefined;
  const openedRoot = distinct(plan.workspaceVirtualRoot ?? 'entry');
  const deployedMapContext = distinct(entryParent);
  const gameGamedataX2 = authorizedGameRoot ?? distinct(plan.gamedataVirtualRoot);
  const implicitEnvironment = distinct(implicitDefinitionCount > 0 ? 'implicit' : undefined);
  const gameXs = distinct(plan.xsVirtualRoot);
  return {
    openedOrConfigured: openedRoot ? [openedRoot] : [],
    ...(deployedMapContext ? { deployedMapContext } : {}),
    ...(gameGamedataX2 ? { gameGamedataX2 } : {}),
    ...(implicitEnvironment ? { implicitEnvironment } : {}),
    ...(gameXs ? { gameXs } : {}),
    standardIncludes,
    standardIncludesAuthorized,
  };
}

function virtualPathForDiskPath(path: string, plan: CatalogRootPlan): string | null {
  for (const root of plan.collectionRoots) {
    if (!isInside(path, root.path)) continue;
    const suffix = relative(root.path, path).replaceAll('\\', '/');
    return suffix ? `${root.virtualRoot}/${suffix}` : root.virtualRoot;
  }
  return null;
}

function boundedVirtualName(uri: string): string {
  const name = decodeURIComponent(uri.split('/').at(-1) ?? 'entry.rms');
  return /^[A-Za-z0-9._ -]{1,255}$/u.test(name) ? name : 'entry.rms';
}

function roleForPath(path: string, entry: boolean): MainSourceCatalogRole {
  if (entry) return 'rms-entry';
  return extname(path).toLocaleLowerCase('en-US') === '.xs' ? 'external-xs' : 'rms-dependency';
}

function originForDiskPath(
  path: string,
  plan: CatalogRootPlan,
  gameRoots: AuthorizedGameRoots,
): MainSourceCatalogOrigin {
  if (gameRoots.randomMapDefinitions && pathKey(path) === pathKey(gameRoots.randomMapDefinitions)) {
    return 'implicit-environment';
  }
  return (gameRoots.gamedata && isInside(path, gameRoots.gamedata)) ||
    (gameRoots.xs && isInside(path, gameRoots.xs))
    ? 'game-data'
    : plan.workspacePhysicalRoot && isInside(path, plan.workspacePhysicalRoot)
      ? 'workspace'
      : plan.deployedMapPhysicalRoot && isInside(path, plan.deployedMapPhysicalRoot)
        ? 'deployed-map'
        : 'workspace';
}

function isCatalogAssetPath(path: string): boolean {
  return ['.rms', '.rms2', '.inc', '.def', '.xs'].includes(
    extname(path).toLocaleLowerCase('en-US'),
  );
}

function isRmsEntryPath(path: string): boolean {
  return ['.rms', '.rms2'].includes(extname(path).toLocaleLowerCase('en-US'));
}

function originOrdinal(origin: MainSourceCatalogOrigin): number {
  return ['workspace', 'dirty-buffer', 'deployed-map', 'game-data', 'implicit-environment'].indexOf(
    origin,
  );
}

function roleOrdinal(role: MainSourceCatalogRole): number {
  return ['rms-entry', 'rms-dependency', 'external-xs'].indexOf(role);
}

function sha256(bytes: Uint8Array): Uint8Array {
  return createHash('sha256').update(bytes).digest();
}

function u32(value: number): Uint8Array {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function pathKey(path: string): string {
  return path.replaceAll('\\', '/').toLocaleLowerCase('en-US');
}

function isInside(path: string, root: string): boolean {
  const child = relative(resolve(root), resolve(path));
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

export const sourceCatalogPathIsInside = isInside;

function compareCatalogEntries(
  left: MainSourceCatalogEntry,
  right: MainSourceCatalogEntry,
): number {
  return (
    compare(left.normalizedPath, right.normalizedPath) || compare(left.sourceId, right.sourceId)
  );
}

function virtualParent(path: string): string | undefined {
  const separator = path.lastIndexOf('/');
  return separator > 0 ? path.slice(0, separator) : undefined;
}

function compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

export const sourceCatalogEnvironment = {
  authorizedWorkspaceRoot,
  authorizedDeployedMapRoot,
  authorizedGameRoots,
  standardIncludeAccess,
  planCatalogRoots,
  canonicalDefinitions,
  canonicalStandardIncludes,
  catalogResolverRoots,
  virtualPathForDiskPath,
  virtualParent,
  encodedOverlays,
  originForDiskPath,
  roleForPath,
  isCatalogAssetPath,
  isRmsEntryPath,
  validateCatalogMetadata,
  compareCatalogEntries,
  fileUriPathKey,
  pathKey,
  sha256,
  authorizedTextSourcePaths,
  openFolderRoot,
};
