import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, opendir, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mapIconIdentityPrefix,
  mapIconRenderContract,
  maximumManualDeploymentMapIconBytes,
  validateMapIconRenderInput,
  type ManagedDeploymentApplyRequest,
  type ManagedDeploymentChange,
  type ManagedDeploymentFileRole,
  type ManagedDeploymentPreview,
  type ManagedDeploymentRequest,
  type ManagedDeploymentResult,
  type ManualDeploymentModStatus,
  type ManualDeploymentDesiredFile,
  type ManualDeploymentMapIconPreview,
  type ManualDeploymentMapIconRender,
  type ManualDeploymentMapIconImage,
  type ManualDeploymentMapIconRequest,
  type ManualDeploymentOwnedTarget,
  type ManualDeploymentPreview,
} from '../shared/api';
import {
  validateGeneratedMapIconSaveRequest,
  validateManualDeploymentMapIconRequest,
} from '../shared/map-icon-deployment';
import { decodeMapIconPng, encodeMapIconPng, maximumMapIconPngBytes } from './map-icon-png';
import type {
  AuthorizedDeploymentGraph,
  MainSourceCatalogEntry,
  SourceCatalogService,
} from './source-catalog-service';
import { readFileBounded } from './bounded-file';
import { isSafeWindowsPathPart } from './windows-names';
import { ProfileXsStaging, type ProfileXsFile } from './profile-xs-staging';
import { enableLocalModStatus, ModStatusRefusedError, type ModStatusTarget } from './mod-status';
import { StandardResourcePolicy } from './standard-resource-policy';
import { atomicReplaceFile } from './workspace-service';
import { DesktopError } from '../shared/desktop-error';
import {
  isPersistentModName,
  isReservedPersistentModName,
  managedModDirectoryName,
} from '../shared/persistent-mod-name';
import { decodeSourceBytes } from './source-codec';
import type { XsSyntaxCheckFile, XsSyntaxCheckResult } from './native-supervisor';

export type XsSyntaxChecker = (
  files: readonly XsSyntaxCheckFile[],
) => Promise<readonly XsSyntaxCheckResult[]>;

export { managedModDirectoryName };
export const managedModName = 'AoE2RMSIDE Managed Maps';
export const managedModContract = 'aoe2rmside-managed-mod-v1';
export const persistentManagedModContract = 'aoe2rmside-persistent-mod-v1';
const managedModAuthor = 'AoE2RMSIDE';
const managedModDescription =
  'Local random-map sources managed by AoE2RMSIDE. Edit the workspace, not this deployment.';
const maximumDeploymentFiles = 2_048;
const maximumDeploymentBytes = 64 * 1024 * 1024;
const maximumPreviewImageBytes = maximumManualDeploymentMapIconBytes;
const maximumPreviewPlans = 8;
const maximumMarkerBytes = 1024 * 1024;
const maximumInventoryEntries = maximumDeploymentFiles * 4;

export interface ManagedDeploymentTarget {
  installationRoot: string;
  profileId: string;
  profileRoot: string;
  directoryName?: string;
  title?: string;
  kind?: 'live' | 'manual';
  ownershipId?: string;
}

export interface ManagedLiveSourceIdentity {
  changed: boolean;
  modIdentity: string;
  authoredSourceSha256: string;
  sourceCatalogHash: string;
  profileXsFiles: string[];
}

interface DesiredFile {
  path: string;
  bytes: Uint8Array;
  hash: string;
  role: ManagedDeploymentFileRole;
  xsIncludeName?: string;
}

type MapIconPolicy =
  | { kind: 'none' }
  | { kind: 'original' }
  | { kind: 'generated'; bytes: Uint8Array; identity: string };

interface DesiredTree {
  files: readonly DesiredFile[];
  mapIcon: Omit<ManualDeploymentMapIconPreview, 'mode'>;
}

interface DeploymentRecord {
  schemaVersion: '1.0.0';
  compatibility: { readerMajor: 1 };
  profileId: string;
  sourceCatalogHash: string;
  files: Record<string, string>;
  kind?: 'live' | 'manual';
  installationRoot?: string;
  profileRoot?: string;
  directoryName?: string;
  title?: string;
  ownershipId?: string;
  documentUri?: string;
  lastConfirmedAt?: string;
}

interface DeploymentState {
  schemaVersion: '1.0.0';
  compatibility: { readerMajor: 1 };
  deployments: Record<string, DeploymentRecord>;
}

interface DeploymentJournal {
  version: 1;
  phase: 'prepared' | 'target-backed-up' | 'committed';
  key: string;
  installationRoot: string;
  profileId: string;
  profileRoot: string;
  parent: string;
  target: string;
  stage: string;
  backup: string;
  record: DeploymentRecord;
}

interface DeploymentPlan {
  token: string;
  key: string;
  target: ManagedDeploymentTarget;
  targetPath: string;
  localModsPath: string;
  graph: AuthorizedDeploymentGraph;
  desired: readonly DesiredFile[];
  currentInventoryHash: string;
  conflicts: readonly string[];
  preview: ManagedDeploymentPreview;
  resourcePolicyRevision: number;
  currentExists: boolean;
  targetOwned: boolean;
  mapIcon: ManualDeploymentMapIconPreview | null;
}

export class ManagedDeploymentService {
  private readonly statePath: string;
  private readonly journalPath: string;
  private readonly plans = new Map<string, DeploymentPlan>();
  private operationTail: Promise<void> = Promise.resolve();
  private encodedMapIcon: { identity: string; bytes: Uint8Array } | null = null;

  constructor(
    userDataPath: string,
    private readonly sourceCatalogs: SourceCatalogService,
    private readonly standardResources = new StandardResourcePolicy(),
    private readonly acceptsIconSource: (
      graph: AuthorizedDeploymentGraph,
      semanticHash: string,
    ) => boolean = () => false,
    private readonly retireUnownedBackup: (path: string) => Promise<void> = (path) =>
      rm(path, { recursive: true, force: true }),
    private readonly xsSyntaxCheck: XsSyntaxChecker = async () => [],
    private readonly gameTexturesSource: () => string | null = () => null,
    private readonly profileXsStaging = new ProfileXsStaging(userDataPath),
  ) {
    this.statePath = join(resolve(userDataPath), 'managed-deployments-v1.json');
    this.journalPath = join(resolve(userDataPath), 'managed-deployment-recovery-v1.json');
  }

  async preview(
    request: ManagedDeploymentRequest,
    target: ManagedDeploymentTarget,
  ): Promise<ManagedDeploymentPreview> {
    return this.serialize(() => this.previewExclusive(request, target));
  }

  async apply(request: ManagedDeploymentApplyRequest): Promise<ManagedDeploymentResult> {
    return this.serialize(() => this.applyExclusive(request));
  }

  async previewManual(
    request: ManagedDeploymentRequest,
    target: ManagedDeploymentTarget,
    mapIcon?: ManualDeploymentMapIconRequest,
  ): Promise<ManualDeploymentPreview> {
    if (target.kind !== 'manual') throw new Error('persistent deployment target is invalid');
    const option = validateManualDeploymentMapIconRequest(
      mapIcon ?? { mode: request?.includePreviewImage ? 'retain-original' : 'none' },
    );
    if (request?.includePreviewImage !== (option.mode === 'retain-original')) {
      throw new Error('map icon option conflicts with original preview-image inclusion');
    }
    return this.serialize(async () => {
      this.invalidateManualPlans();
      const preview = await this.previewExclusive(request, target, option);
      const plan = this.plans.get(preview.token);
      if (!plan?.mapIcon) throw new Error('persistent deployment preview is unavailable');
      return {
        ...preview,
        targetPath: plan.targetPath,
        targetExists: plan.currentExists,
        targetOwned: plan.targetOwned,
        desiredFiles: plan.desired.map(({ path, bytes, role }) => ({
          path,
          bytes: bytes.byteLength,
          role,
        })) as ManualDeploymentDesiredFile[],
        mapIcon: { ...plan.mapIcon },
      };
    });
  }

  async applyManual(
    token: string,
    confirmReplaceExisting: boolean,
    enableMod = false,
  ): Promise<ManagedDeploymentResult> {
    return this.serialize(() =>
      this.applyExclusive(
        {
          token,
          overwriteExternalChanges: confirmReplaceExisting,
          confirmReplaceExisting,
        },
        enableMod,
      ),
    );
  }

  async manualMapIcon(token: unknown): Promise<ManualDeploymentMapIconImage | null> {
    if (typeof token !== 'string' || !/^[a-f0-9-]{36}$/u.test(token)) {
      throw new Error('map icon preview token is invalid');
    }
    return this.serialize(async () => {
      const plan = this.plans.get(token);
      if (!plan || plan.target.kind !== 'manual' || !plan.mapIcon) {
        throw new DesktopError(
          'deploy.stale-preview',
          'deployment preview is stale or unavailable',
        );
      }
      const { path, source } = plan.mapIcon;
      if (source === 'none' || path === null) return null;
      const file = plan.desired.find((candidate) => pathKey(candidate.path) === pathKey(path));
      const expectedRole = source === 'generated' ? 'generated-map-icon' : 'preview-image';
      const limit = source === 'generated' ? maximumMapIconPngBytes : maximumPreviewImageBytes;
      if (!file || file.role !== expectedRole || file.bytes.byteLength > limit) {
        throw new Error('deployment preview map icon is unavailable');
      }
      return { source, fileName: basename(file.path), bytes: new Uint8Array(file.bytes) };
    });
  }

  async reconcileManualTargets(
    installationRoot: string,
    profiles: readonly { profileId: string; profileRoot: string }[],
    documentUri: string,
  ): Promise<ManualDeploymentOwnedTarget[]> {
    return this.serialize(async () => {
      await this.recoverExclusive();
      const canonicalInstallation = await canonicalDirectory(installationRoot);
      const profileById = new Map(profiles.map((profile) => [profile.profileId, profile]));
      const state = await this.readState();
      let changed = false;
      const suggestions: ManualDeploymentOwnedTarget[] = [];
      for (const [key, record] of Object.entries(state.deployments)) {
        if (
          record.kind !== 'manual' ||
          !record.installationRoot ||
          !record.profileRoot ||
          !record.directoryName ||
          !record.ownershipId ||
          !record.documentUri ||
          !record.lastConfirmedAt ||
          !samePath(record.installationRoot, canonicalInstallation)
        ) {
          continue;
        }
        const profile = profileById.get(record.profileId);
        if (!profile || !samePath(profile.profileRoot, record.profileRoot)) continue;
        let targetPath: string;
        try {
          targetPath = (
            await validateTarget(
              {
                installationRoot: canonicalInstallation,
                profileId: record.profileId,
                profileRoot: record.profileRoot,
                directoryName: record.directoryName,
                title: record.title,
                kind: 'manual',
                ownershipId: record.ownershipId,
              },
              false,
            )
          ).targetPath;
        } catch {
          continue;
        }
        let metadata;
        try {
          metadata = await lstat(targetPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue;
          try {
            await readdir(record.profileRoot);
          } catch {
            continue;
          }
          delete state.deployments[key];
          changed = true;
          continue;
        }
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) continue;
        const current = await inventory(targetPath);
        if (current.ownershipId !== record.ownershipId) continue;
        suggestions.push({
          profileId: record.profileId,
          modName: record.directoryName,
          documentUri: record.documentUri,
          lastConfirmedAt: record.lastConfirmedAt,
        });
      }
      if (changed) await this.writeState(state);
      return suggestions.sort((left, right) => {
        const entryOrder =
          Number(right.documentUri === documentUri) - Number(left.documentUri === documentUri);
        return entryOrder || right.lastConfirmedAt.localeCompare(left.lastConfirmedAt);
      });
    });
  }

  async manualOwnershipId(
    installationRoot: string,
    profileRoot: string,
    profileId: string,
    directoryName: string,
  ): Promise<string> {
    return this.serialize(async () => {
      const state = await this.readState();
      const key = deploymentKey({
        installationRoot,
        profileRoot,
        profileId,
        directoryName,
        kind: 'manual',
      });
      return state.deployments[key]?.ownershipId ?? randomUUID();
    });
  }

  async isOwnedManualTarget(
    installationRoot: string,
    profileRoot: string,
    profileId: string,
    directoryName: string,
  ): Promise<boolean> {
    return this.serialize(async () => {
      const state = await this.readState();
      const key = deploymentKey({
        installationRoot,
        profileRoot,
        profileId,
        directoryName,
        kind: 'manual',
      });
      const record = state.deployments[key];
      if (
        record?.kind !== 'manual' ||
        record.directoryName !== directoryName ||
        !record.ownershipId
      ) {
        return false;
      }
      try {
        const target = await validateTarget(
          {
            installationRoot,
            profileRoot,
            profileId,
            directoryName,
            title: directoryName,
            kind: 'manual',
            ownershipId: record.ownershipId,
          },
          false,
        );
        return (await inventory(target.targetPath)).ownershipId === record.ownershipId;
      } catch {
        return false;
      }
    });
  }

  async assertXsDependenciesParse(request: ManagedDeploymentRequest): Promise<void> {
    validateDeploymentRequest(request);
    const graph = this.sourceCatalogs.authorizedDeploymentGraph({
      revision: request.sourceCatalogRevision,
      catalogHash: request.sourceCatalogHash,
      rmsGraphHash: request.sourceGraphHash,
      externalAssetHash: request.externalAssetHash,
      documentUri: request.documentUri,
      documentRevision: request.documentRevision,
    });
    await this.checkXsDependencies(graph);
  }

  private async checkXsDependencies(graph: AuthorizedDeploymentGraph): Promise<void> {
    const byId = new Map(graph.catalog.sources.map((source) => [source.sourceId, source]));
    const files = graph.externalAssetSourceIds
      .map((sourceId) => byId.get(sourceId))
      .filter(
        (source): source is MainSourceCatalogEntry =>
          source?.role === 'external-xs' &&
          source.origin !== 'game-data' &&
          source.origin !== 'implicit-environment',
      );
    if (files.length === 0) return;
    const results = await this.xsSyntaxCheck(
      files.map((source) => ({
        uri: source.sourceId,
        text: decodeSourceBytes(source.source).content,
      })),
    );
    for (const source of files) {
      const first = results.find((result) => result.uri === source.sourceId)?.errors[0];
      if (!first) continue;
      const name = source.normalizedPath.replaceAll('\\', '/').split('/').pop() ?? '';
      throw new Error(
        `XS dependency ${name} does not parse: line ${first.line + 1}: ${first.message} (${first.code})`,
      );
    }
  }

  async preflightLiveTest(
    request: ManagedDeploymentRequest,
    target: ManagedDeploymentTarget,
  ): Promise<void> {
    await this.assertXsDependenciesParse(request);
    await this.serialize(async () => {
      if (target.kind === 'manual') throw new Error('live deployment target name is invalid');
      const canonicalTarget = await validateTarget(target, false);
      const graph = this.sourceCatalogs.authorizedDeploymentGraph({
        revision: request.sourceCatalogRevision,
        catalogHash: request.sourceCatalogHash,
        rmsGraphHash: request.sourceGraphHash,
        externalAssetHash: request.externalAssetHash,
        documentUri: request.documentUri,
        documentRevision: request.documentRevision,
      });
      const tree = await desiredFiles(
        graph,
        { kind: 'none' },
        canonicalTarget,
        this.standardResources,
      );
      await this.profileXsStaging.plan(canonicalTarget, profileXsFiles(tree.files));
    });
  }

  async ensureCurrentForLiveTest(
    request: ManagedDeploymentRequest,
    target: ManagedDeploymentTarget,
    overwriteExternalChanges: boolean,
  ): Promise<ManagedLiveSourceIdentity> {
    return this.serialize(async () => {
      const preview = await this.previewExclusive(request, target);
      const plan = this.plans.get(preview.token);
      if (!plan) throw new Error('managed live-test deployment preview is unavailable');
      this.assertResourcePolicyCurrent(plan);
      const entries = plan.desired.filter((file) => file.role === 'rms-entry');
      if (entries.length !== 1) {
        this.plans.delete(preview.token);
        throw new Error('managed live-test deployment requires a single RMS entry');
      }
      const changed = preview.changes.some((change) => change.kind !== 'unchanged');
      if (changed && preview.conflicts.length > 0 && !overwriteExternalChanges) {
        this.plans.delete(preview.token);
        throw new Error('managed deployment has conflicting external edits');
      }
      let staging;
      try {
        staging = await this.profileXsStaging.plan(plan.target, profileXsFiles(plan.desired));
      } catch (error) {
        this.plans.delete(preview.token);
        throw error;
      }
      if (changed) {
        await this.applyExclusive({
          token: preview.token,
          overwriteExternalChanges,
        });
      } else {
        this.plans.delete(preview.token);
      }
      const staged = await this.profileXsStaging.apply(staging);
      return {
        changed: changed || staged.changed,
        modIdentity: managedModDirectoryName.toLocaleLowerCase('en-US'),
        authoredSourceSha256: entries[0]!.hash,
        sourceCatalogHash: preview.sourceCatalogHash,
        profileXsFiles: staged.files,
      };
    });
  }

  async generatedMapIconImage(request: unknown): Promise<ManualDeploymentMapIconImage> {
    const valid = validateGeneratedMapIconSaveRequest(request);
    return this.serialize(async () => {
      const graph = this.sourceCatalogs.authorizedDeploymentGraph({
        revision: valid.sourceCatalogRevision,
        catalogHash: valid.sourceCatalogHash,
        rmsGraphHash: valid.sourceGraphHash,
        externalAssetHash: valid.externalAssetHash,
        documentUri: valid.documentUri,
        documentRevision: valid.documentRevision,
      });
      const policy = this.generatedMapIcon(valid.render, graph);
      if (policy.kind !== 'generated') throw new Error('generated map icon is unavailable');
      const entry = graph.catalog.sources.find((source) => source.sourceId === graph.documentUri);
      const entryName = entry?.normalizedPath.replaceAll('\\', '/').split('/').pop() ?? '';
      const stem = basename(entryName, extname(entryName));
      if (!entry || entry.role !== 'rms-entry' || !stem || !validPathPart(`${stem}.png`)) {
        throw new Error('generated map icon has no valid file name');
      }
      return { source: 'generated', fileName: `${stem}.png`, bytes: new Uint8Array(policy.bytes) };
    });
  }

  async recover(): Promise<void> {
    return this.serialize(() => this.recoverExclusive());
  }

  private async previewExclusive(
    request: ManagedDeploymentRequest,
    target: ManagedDeploymentTarget,
    mapIcon: ManualDeploymentMapIconRequest | null = null,
  ): Promise<ManagedDeploymentPreview> {
    validateDeploymentRequest(request);
    if (mapIcon !== null && target.kind !== 'manual') {
      throw new Error('map icon options are limited to persistent named deployments');
    }
    await this.recoverExclusive();
    const canonicalTarget = await validateTarget(target, false);
    const graph = this.sourceCatalogs.authorizedDeploymentGraph({
      revision: request.sourceCatalogRevision,
      catalogHash: request.sourceCatalogHash,
      rmsGraphHash: request.sourceGraphHash,
      externalAssetHash: request.externalAssetHash,
      documentUri: request.documentUri,
      documentRevision: request.documentRevision,
    });
    if (
      !sameStringSet(request.resolvedRmsSourceIds, graph.resolvedRmsSourceIds) ||
      !sameStringSet(request.externalAssetSourceIds, graph.externalAssetSourceIds)
    ) {
      throw new Error('renderer deployment allowlist does not match the generation evidence');
    }
    await this.checkXsDependencies(graph);
    const iconPolicy: MapIconPolicy =
      mapIcon === null
        ? { kind: request.includePreviewImage ? 'original' : 'none' }
        : mapIcon.mode === 'generate'
          ? this.generatedMapIcon(mapIcon.render, graph)
          : { kind: mapIcon.mode === 'retain-original' ? 'original' : 'none' };
    const tree = await desiredFiles(graph, iconPolicy, canonicalTarget, this.standardResources);
    const desired = tree.files;
    const state = await this.readState();
    const key = deploymentKey(canonicalTarget);
    const previous = state.deployments[key];
    const current = await inventory(canonicalTarget.targetPath);
    const desiredByPath = new Map(desired.map((file) => [pathKey(file.path), file]));
    const currentByPath = new Map(current.files.map((file) => [pathKey(file.path), file]));
    const previousFiles = previous?.files ?? {};
    const recognizedGameMetadataRewrite =
      canonicalTarget.kind === 'manual'
        ? false
        : isRecognizedGameMetadataRewrite(current, previousFiles, desiredByPath);
    if (
      canonicalTarget.kind !== 'manual' &&
      current.exists &&
      !current.managed &&
      !recognizedGameMetadataRewrite
    ) {
      throw new Error('the fixed deployment target exists but is not an IDE-managed mod');
    }
    const conflicts =
      canonicalTarget.kind === 'manual'
        ? []
        : current.files.flatMap((file) => {
            const expected = previousFiles[file.path];
            return expected === undefined ||
              (expected !== file.hash &&
                !(pathKey(file.path) === 'info.json' && recognizedGameMetadataRewrite))
              ? [file.path]
              : [];
          });
    const changes: ManagedDeploymentChange[] = [];
    for (const file of desired) {
      const existing = currentByPath.get(pathKey(file.path));
      changes.push({
        path: file.path,
        kind:
          canonicalTarget.kind === 'manual'
            ? current.exists
              ? 'change'
              : 'add'
            : !existing
              ? 'add'
              : existing.hash === file.hash ||
                  (pathKey(file.path) === 'info.json' && recognizedGameMetadataRewrite)
                ? 'unchanged'
                : 'change',
        bytes: file.bytes.byteLength,
      });
    }
    for (const file of current.files) {
      if (!desiredByPath.has(pathKey(file.path))) {
        changes.push({ path: file.path, kind: 'remove', bytes: file.bytes });
      }
    }
    changes.sort((left, right) => compare(left.path, right.path));
    const token = randomUUID();
    const preview = Object.freeze({
      contractVersion: Object.freeze({ major: 1, minor: 0, patch: 0 }),
      token,
      modName: canonicalTarget.title ?? managedModName,
      profileId: canonicalTarget.profileId,
      changes,
      conflicts: [...new Set(conflicts)].sort(compare),
      sourceCatalogHash: request.sourceCatalogHash,
    });
    const plan: DeploymentPlan = {
      token,
      key,
      target: canonicalTarget,
      targetPath: canonicalTarget.targetPath,
      localModsPath: canonicalTarget.localModsPath,
      graph,
      desired,
      currentInventoryHash: current.hash,
      conflicts: preview.conflicts,
      preview,
      resourcePolicyRevision: this.standardResources.revision,
      currentExists: current.exists,
      targetOwned: Boolean(
        canonicalTarget.ownershipId && current.ownershipId === canonicalTarget.ownershipId,
      ),
      mapIcon: mapIcon === null ? null : Object.freeze({ mode: mapIcon.mode, ...tree.mapIcon }),
    };
    this.plans.set(token, plan);
    while (this.plans.size > maximumPreviewPlans) {
      this.plans.delete(this.plans.keys().next().value as string);
    }
    return preview;
  }

  private async applyExclusive(
    request: ManagedDeploymentApplyRequest,
    enableMod = false,
  ): Promise<ManagedDeploymentResult> {
    validateApplyRequest(request);
    const plan = this.plans.get(request.token);
    if (!plan) {
      throw new DesktopError('deploy.stale-preview', 'deployment preview is stale or unavailable');
    }
    this.plans.delete(request.token);
    this.sourceCatalogs.assertCurrent(plan.graph.catalog);
    this.assertResourcePolicyCurrent(plan);
    const target = await validateTarget(plan.target, true);
    if (!samePath(target.targetPath, plan.targetPath)) {
      throw new Error('managed deployment target changed after preview');
    }
    const current = await inventory(target.targetPath);
    if (current.hash !== plan.currentInventoryHash) {
      throw new Error('managed deployment target changed after preview');
    }
    if (
      plan.target.kind === 'manual' &&
      plan.currentExists &&
      request.confirmReplaceExisting !== true
    ) {
      throw new Error('existing persistent mod replacement was not confirmed');
    }
    if (plan.conflicts.length > 0 && !request.overwriteExternalChanges) {
      throw new Error('managed deployment has conflicting external edits');
    }

    const directoryName = target.directoryName ?? managedModDirectoryName;
    const stage = join(target.localModsPath, `.${directoryName}.stage-${randomUUID()}`);
    const backup = join(target.localModsPath, `.${directoryName}.backup-${randomUUID()}`);
    await mkdir(stage);
    try {
      for (const file of plan.desired) {
        const destination = safeJoin(stage, file.path);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, file.bytes, { flag: 'wx' });
      }
      const record: DeploymentRecord = {
        schemaVersion: '1.0.0',
        compatibility: { readerMajor: 1 },
        profileId: target.profileId,
        sourceCatalogHash: plan.preview.sourceCatalogHash,
        files: Object.fromEntries(plan.desired.map((file) => [file.path, file.hash])),
        kind: target.kind ?? 'live',
        installationRoot: target.installationRoot,
        profileRoot: target.profileRoot,
        directoryName,
        title: target.title ?? managedModName,
        ...(target.ownershipId ? { ownershipId: target.ownershipId } : {}),
        documentUri: plan.graph.documentUri,
        lastConfirmedAt: new Date().toISOString(),
      };
      let journal: DeploymentJournal = {
        version: 1,
        phase: 'prepared',
        key: plan.key,
        installationRoot: target.installationRoot,
        profileId: target.profileId,
        profileRoot: target.profileRoot,
        parent: target.localModsPath,
        target: target.targetPath,
        stage,
        backup,
        record,
      };
      await this.writeJournal(journal);
      if (current.exists) {
        await rename(target.targetPath, backup);
        journal = { ...journal, phase: 'target-backed-up' };
        await this.writeJournal(journal);
      }
      try {
        await rename(stage, target.targetPath);
      } catch (error) {
        if (await pathExists(backup)) await rename(backup, target.targetPath);
        throw error;
      }
      journal = { ...journal, phase: 'committed' };
      await this.writeJournal(journal);
      await this.writeRecord(plan.key, record);
      if (plan.target.kind === 'manual' && current.exists && !plan.targetOwned) {
        await this.retireBackup(backup);
      } else {
        await rm(backup, { recursive: true, force: true });
      }
      await rm(this.journalPath, { force: true });
      this.invalidatePlans(plan.key);
      const result: ManagedDeploymentResult = {
        modName: target.title ?? managedModName,
        profileId: target.profileId,
        deployedFiles: plan.desired.map((file) => file.path).sort(compare),
        sourceCatalogHash: plan.preview.sourceCatalogHash,
      };
      if (plan.target.kind !== 'manual') return result;
      return {
        ...result,
        targetPath: target.targetPath,
        modStatus: await enableDeployedMod(
          { profileRoot: target.profileRoot, directoryName, title: target.title ?? directoryName },
          enableMod,
        ),
      };
    } catch (error) {
      if (await pathExists(stage)) await rm(stage, { recursive: true, force: true });
      throw error;
    }
  }

  private async retireBackup(path: string): Promise<void> {
    try {
      await this.retireUnownedBackup(path);
    } catch {}
  }

  private assertResourcePolicyCurrent(plan: DeploymentPlan): void {
    if (plan.resourcePolicyRevision !== this.standardResources.revision) {
      throw new Error('standard resource policy changed after deployment preview');
    }
    for (const file of plan.desired) {
      this.standardResources.assertCreatableFileName(basename(file.path));
    }
  }

  private async recoverExclusive(): Promise<void> {
    const journal = await this.readJournal();
    if (!journal) return;
    this.plans.clear();
    const target = await validateTarget(
      {
        installationRoot: journal.installationRoot,
        profileId: journal.profileId,
        profileRoot: journal.profileRoot,
        directoryName: journal.record.directoryName,
        title: journal.record.title,
        kind: journal.record.kind,
        ownershipId: journal.record.ownershipId,
      },
      false,
    );
    validateJournalPaths(journal, target);
    await assertRecoveryPath(journal.stage);
    await assertRecoveryPath(journal.backup);

    const targetExists = await pathExists(journal.target);
    const stageExists = await pathExists(journal.stage);
    const backupExists = await pathExists(journal.backup);
    if (journal.phase === 'committed' && targetExists) {
      const current = await inventory(journal.target);
      if (!inventoryMatchesRecord(current, journal.record)) {
        throw new Error('committed recovery target is not IDE-managed');
      }
      await this.writeRecord(journal.key, journal.record);
      if (backupExists && journal.record.kind === 'manual') {
        await this.retireBackup(journal.backup);
      } else {
        await rm(journal.backup, { recursive: true, force: true });
      }
      await rm(journal.stage, { recursive: true, force: true });
    } else if (backupExists) {
      if (targetExists) {
        const current = await inventory(journal.target);
        if (!inventoryMatchesRecord(current, journal.record)) {
          throw new Error('recovery target changed outside the IDE');
        }
        await rm(journal.target, { recursive: true });
      }
      await rename(journal.backup, journal.target);
      await rm(journal.stage, { recursive: true, force: true });
    } else if (journal.phase === 'prepared') {
      if (targetExists && !stageExists) {
        const current = await inventory(journal.target);
        if (!inventoryMatchesRecord(current, journal.record)) {
          throw new Error('prepared recovery target changed outside the IDE');
        }
        await this.writeRecord(journal.key, journal.record);
      } else {
        await rm(journal.stage, { recursive: true, force: true });
      }
    } else {
      throw new DesktopError(
        'deploy.state-invalid',
        'managed deployment recovery state is incomplete',
      );
    }
    await rm(this.journalPath, { force: true });
  }

  private generatedMapIcon(
    render: ManualDeploymentMapIconRender | undefined,
    graph: AuthorizedDeploymentGraph,
  ): MapIconPolicy {
    if (!render || render.contractVersion !== mapIconRenderContract.version) {
      throw new Error('generated map icon render contract is unsupported');
    }
    const input = validateMapIconRenderInput({
      perspective: render.perspective,
      look: render.look,
      relief: render.relief,
      terrainSmoothing: render.terrainSmoothing,
      spawnMarkers: render.spawnMarkers,
      spawnMarkerSizePercent: render.spawnMarkerSizePercent,
      trees: render.trees,
      treeDensity: render.treeDensity,
      treeSize: render.treeSize,
      treeSpawnOverlap: render.treeSpawnOverlap,
      resources: render.resources,
      resourceDensity: render.resourceDensity,
      resourceSize: render.resourceSize,
      resourceSpawnOverlap: render.resourceSpawnOverlap,
    });
    if (
      input.look === 'game-textures' &&
      (render.gameTexturesSource === undefined ||
        render.gameTexturesSource !== this.gameTexturesSource())
    ) {
      throw new DesktopError(
        'deploy.map-icon-textures-changed',
        'generated map icon game textures do not belong to the linked game',
      );
    }
    if (
      graph.semanticHash === null ||
      (render.sourceSemanticHash !== graph.semanticHash &&
        !this.acceptsIconSource(graph, render.sourceSemanticHash))
    ) {
      throw new DesktopError(
        'deploy.map-icon-preview-changed',
        'generated map icon does not belong to the current final preview',
      );
    }
    const identity = createHash('sha256')
      .update(
        mapIconIdentityPrefix(render.sourceSemanticHash, input, render.gameTexturesSource),
        'utf8',
      )
      .update(render.pixels)
      .digest('hex');
    if (identity !== render.identity) {
      throw new Error('generated map icon identity does not match its pixels');
    }
    if (this.encodedMapIcon?.identity === identity) {
      return { kind: 'generated', bytes: this.encodedMapIcon.bytes, identity };
    }
    let bytes: Uint8Array;
    try {
      bytes = encodeMapIconPng(
        render.pixels,
        mapIconRenderContract.size,
        mapIconRenderContract.size,
      );
      const decoded = decodeMapIconPng(bytes);
      if (
        bytes.byteLength > maximumMapIconPngBytes ||
        !Buffer.from(decoded.buffer, decoded.byteOffset, decoded.byteLength).equals(
          Buffer.from(render.pixels.buffer, render.pixels.byteOffset, render.pixels.byteLength),
        )
      ) {
        throw new Error('round trip mismatch');
      }
    } catch (error) {
      throw new Error(
        `generated map icon PNG is invalid: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
    this.encodedMapIcon = { identity, bytes };
    return { kind: 'generated', bytes, identity };
  }

  private invalidateManualPlans(): void {
    for (const [token, plan] of this.plans) {
      if (plan.target.kind === 'manual') this.plans.delete(token);
    }
  }

  private invalidatePlans(key: string): void {
    for (const [token, plan] of this.plans) {
      if (plan.key === key) this.plans.delete(token);
    }
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>((resolveOperation) => {
      release = resolveOperation;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async readState(): Promise<DeploymentState> {
    try {
      const bytes = await readFileBounded(this.statePath, 2 * 1024 * 1024);
      return validateState(JSON.parse(bytes.toString('utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw deploymentStateUnreadable(error);
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          schemaVersion: '1.0.0',
          compatibility: { readerMajor: 1 },
          deployments: {},
        };
      }
      throw error;
    }
  }

  private async writeRecord(key: string, record: DeploymentRecord): Promise<void> {
    const state = await this.readState();
    state.deployments[key] = record;
    await this.writeState(state);
  }

  private writeState(state: DeploymentState): Promise<void> {
    if (Object.keys(state.deployments).length > 128) {
      throw new Error('deployment state is oversized');
    }
    return atomicReplaceFile(
      this.statePath,
      Buffer.from(`${JSON.stringify(state, null, 2)}\n`, 'utf8'),
    );
  }

  private async readJournal(): Promise<DeploymentJournal | null> {
    try {
      const bytes = await readFileBounded(this.journalPath, 2 * 1024 * 1024);
      return validateJournal(JSON.parse(bytes.toString('utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw deploymentStateUnreadable(error);
    }
  }

  private writeJournal(journal: DeploymentJournal): Promise<void> {
    return atomicReplaceFile(
      this.journalPath,
      Buffer.from(`${JSON.stringify(journal, null, 2)}\n`, 'utf8'),
    );
  }
}

async function desiredFiles(
  graph: AuthorizedDeploymentGraph,
  iconPolicy: MapIconPolicy,
  target: ManagedDeploymentTarget,
  standardResources: StandardResourcePolicy,
): Promise<DesiredTree> {
  const byId = new Map(graph.catalog.sources.map((source) => [source.sourceId, source]));
  const entry = byId.get(graph.documentUri);
  if (!entry || entry.role !== 'rms-entry' || entry.origin === 'game-data') {
    throw new Error('built-in sources must be cloned into an ordinary workspace before deployment');
  }
  const desired = new Map<string, DesiredFile>();
  const rmsSources = graph.resolvedRmsSourceIds
    .map((sourceId) => byId.get(sourceId))
    .filter(
      (source): source is MainSourceCatalogEntry =>
        Boolean(source) &&
        source?.role !== 'external-xs' &&
        source?.origin !== 'game-data' &&
        source?.origin !== 'implicit-environment',
    );
  const externalSources = graph.externalAssetSourceIds
    .map((sourceId) => byId.get(sourceId))
    .filter(
      (source): source is MainSourceCatalogEntry =>
        source?.role === 'external-xs' &&
        source.origin !== 'game-data' &&
        source.origin !== 'implicit-environment',
    );
  const rmsPortableRoot = target.kind === 'manual' ? commonSourceDirectory(rmsSources) : null;
  const xsPortableRoot = target.kind === 'manual' ? commonSourceDirectory(externalSources) : null;
  const xsGameNames = gameXsIncludeNames(
    [entry, ...rmsSources.filter((source) => source.sourceId !== entry.sourceId)],
    externalSources,
    [
      ...graph.catalog.roots.openedOrConfigured,
      ...(graph.catalog.roots.deployedMapContext ? [graph.catalog.roots.deployedMapContext] : []),
    ],
  );
  for (const sourceId of graph.resolvedRmsSourceIds) {
    const source = byId.get(sourceId);
    if (!source || source.role === 'external-xs') {
      throw new Error('RMS deployment allowlist is invalid');
    }
    if (source.origin === 'game-data' || source.origin === 'implicit-environment') continue;
    addDesired(
      desired,
      sourceDestination(source, 'rms', rmsPortableRoot),
      source.source,
      source.role,
      standardResources,
    );
  }
  for (const sourceId of graph.externalAssetSourceIds) {
    const source = byId.get(sourceId);
    if (!source || source.role !== 'external-xs') {
      throw new Error('XS deployment allowlist is invalid');
    }
    if (source.origin === 'game-data' || source.origin === 'implicit-environment') continue;
    const gameName = xsGameNames.get(source.sourceId);
    addDesired(
      desired,
      gameName
        ? ['resources/_common/xs', gameName].join('/')
        : sourceDestination(source, 'xs', xsPortableRoot),
      source.source,
      'external-xs',
      standardResources,
      gameName,
    );
  }
  if (![...desired.values()].some((file) => file.role === 'rms-entry')) {
    throw new Error('deployment has no authorized user-owned RMS entry');
  }

  const info = Buffer.from(
    `${JSON.stringify(
      {
        Author: managedModAuthor,
        Description:
          target.kind === 'manual'
            ? 'Persistent random-map snapshot exported by AoE2RMSIDE.'
            : managedModDescription,
        RmsideManagedContract:
          target.kind === 'manual' ? persistentManagedModContract : managedModContract,
        ...(target.ownershipId ? { RmsideOwnershipId: target.ownershipId } : {}),
        Title: target.title ?? managedModName,
        Version: '1.0',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  addDesired(desired, 'info.json', info, 'metadata', standardResources);
  if (target.kind === 'manual' && target.ownershipId) {
    addDesired(
      desired,
      '.aoe2rmside-ownership.json',
      Buffer.from(
        `${JSON.stringify({
          contract: persistentManagedModContract,
          ownershipId: target.ownershipId,
          name: target.directoryName,
        })}\n`,
        'utf8',
      ),
      'metadata',
      standardResources,
    );
  }

  const entryDestination = sourceDestination(entry, 'rms', rmsPortableRoot);
  const iconPath = join(
    dirname(entryDestination),
    `${basename(entryDestination, extname(entryDestination))}.png`,
  ).replaceAll('\\', '/');
  const original =
    iconPolicy.kind === 'original' || target.kind === 'manual'
      ? await matchingPreviewImage(entry)
      : null;
  let mapIcon: DesiredTree['mapIcon'] = {
    source: 'none',
    originalAvailable: original !== null,
    path: null,
    renderIdentity: null,
  };
  if (iconPolicy.kind === 'original' && original) {
    addDesired(desired, iconPath, original, 'preview-image', standardResources);
    mapIcon = { ...mapIcon, source: 'original', path: iconPath };
  } else if (iconPolicy.kind === 'generated') {
    if (target.kind !== 'manual') {
      throw new Error('map icon options are limited to persistent named deployments');
    }
    addDesired(desired, iconPath, iconPolicy.bytes, 'generated-map-icon', standardResources);
    mapIcon = {
      ...mapIcon,
      source: 'generated',
      path: iconPath,
      renderIdentity: iconPolicy.identity,
    };
  }
  const files = [...desired.values()].sort((left, right) => compare(left.path, right.path));
  const bytes = files.reduce((total, file) => total + file.bytes.byteLength, 0);
  if (files.length > maximumDeploymentFiles || bytes > maximumDeploymentBytes) {
    throw new Error('managed deployment exceeds its safety limit');
  }
  return { files: Object.freeze(files), mapIcon };
}

async function enableDeployedMod(
  target: ModStatusTarget,
  enable: boolean,
): Promise<ManualDeploymentModStatus> {
  if (!enable) return { enable: 'not-requested' };
  try {
    return { enable: await enableLocalModStatus(target) };
  } catch (error) {
    return {
      enable: 'failed',
      failure: error instanceof ModStatusRefusedError ? error.reason : 'write-failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function sourceDestination(
  source: MainSourceCatalogEntry,
  kind: 'rms' | 'xs',
  portableRoot: string | null = null,
): string {
  const path = source.normalizedPath.replaceAll('\\', '/');
  const marker = kind === 'rms' ? 'resources/_common/random-map-scripts/' : 'resources/_common/xs/';
  const markerIndex = path.toLocaleLowerCase('en-US').indexOf(marker);
  const suffix =
    markerIndex >= 0
      ? path.slice(markerIndex + marker.length)
      : portableRoot && pathKey(path).startsWith(`${pathKey(portableRoot)}/`)
        ? path.slice(portableRoot.length + 1)
        : path.split('/').slice(1).join('/');
  if (!suffix || suffix.split('/').some((part) => !validPathPart(part))) {
    throw new DesktopError(
      'deploy.unplaceable-source',
      'resolved source has no safe game-relative deployment path',
    );
  }
  const extension = extname(suffix).toLocaleLowerCase('en-US');
  if (
    (kind === 'rms' && !['.rms', '.rms2', '.inc', '.def'].includes(extension)) ||
    (kind === 'xs' && extension !== '.xs')
  ) {
    throw new DesktopError(
      'deploy.unplaceable-source',
      'resolved source has an invalid deployment role or extension',
    );
  }
  const parent = kind === 'rms' ? 'resources/_common/random-map-scripts' : 'resources/_common/xs';
  return join(parent, ...suffix.split('/')).replaceAll('\\', '/');
}

const gameIncludeXsPattern = /#includeXS\s+(?:"([^"]+)"|(\S+))/u;

export function gameXsIncludeNames(
  rmsSources: readonly Pick<MainSourceCatalogEntry, 'normalizedPath' | 'source'>[],
  externalSources: readonly Pick<MainSourceCatalogEntry, 'normalizedPath' | 'sourceId'>[],
  roots: readonly string[],
): Map<string, string> {
  const byPath = new Map(
    externalSources.map((source) => [
      pathKey(normalizedVirtualPath(source.normalizedPath) ?? ''),
      source.sourceId,
    ]),
  );
  const names = new Map<string, string>();
  for (const rms of rmsSources) {
    const folder = rms.normalizedPath.replaceAll('\\', '/').split('/').slice(0, -1).join('/');
    const text = Buffer.from(rms.source).toString('latin1');
    for (const line of text.split('\n')) {
      const match = gameIncludeXsPattern.exec(line);
      const written = (match?.[1] ?? match?.[2])?.trim();
      if (!written) continue;
      const parts = written.replaceAll('\\', '/').split('/');
      if (
        parts.some((part) => !validPathPart(part)) ||
        extname(written).toLocaleLowerCase('en-US') !== '.xs'
      ) {
        continue;
      }
      const name = parts.join('/');
      for (const root of [folder, ...roots]) {
        const candidate = normalizedVirtualPath(`${root}/${name}`);
        const sourceId = candidate ? byPath.get(pathKey(candidate)) : undefined;
        if (sourceId === undefined) continue;
        if (!names.has(sourceId)) names.set(sourceId, name);
        break;
      }
    }
  }
  return names;
}

function normalizedVirtualPath(path: string): string | null {
  const parts: string[] = [];
  for (const part of path.replaceAll('\\', '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join('/');
}

function commonSourceDirectory(sources: readonly MainSourceCatalogEntry[]): string | null {
  if (sources.length === 0) return null;
  const directories = sources.map((source) => {
    const parts = source.normalizedPath.replaceAll('\\', '/').split('/');
    parts.pop();
    return parts;
  });
  const common = [...directories[0]!];
  for (const directory of directories.slice(1)) {
    let index = 0;
    while (
      index < common.length &&
      index < directory.length &&
      common[index]!.localeCompare(directory[index]!, 'en-US', { sensitivity: 'accent' }) === 0
    ) {
      index += 1;
    }
    common.length = index;
  }
  return common.length > 0 ? common.join('/') : null;
}

async function matchingPreviewImage(entry: MainSourceCatalogEntry): Promise<Uint8Array | null> {
  try {
    const previewPath = await matchingPreviewImagePath(fileURLToPath(entry.sourceId));
    return previewPath ? await readFileBounded(previewPath, maximumPreviewImageBytes) : null;
  } catch {
    return null;
  }
}

export async function hasMatchingPreviewImage(entryPath: string): Promise<boolean> {
  try {
    return (await matchingPreviewImagePath(entryPath)) !== null;
  } catch {
    return false;
  }
}

async function matchingPreviewImagePath(entryPath: string): Promise<string | null> {
  const previewPath = join(dirname(entryPath), `${basename(entryPath, extname(entryPath))}.png`);
  const metadata = await lstat(previewPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumPreviewImageBytes) {
    return null;
  }
  return previewPath;
}

function addDesired(
  desired: Map<string, DesiredFile>,
  path: string,
  bytes: Uint8Array,
  role: DesiredFile['role'],
  standardResources: StandardResourcePolicy,
  xsIncludeName?: string,
): void {
  const normalized = path.replaceAll('\\', '/');
  standardResources.assertCreatableFileName(basename(normalized));
  const key = pathKey(normalized);
  if (desired.has(key)) {
    throw new DesktopError('deploy.path-collision', `deployment path collision at ${normalized}`, {
      path: normalized,
    });
  }
  desired.set(key, {
    path: normalized,
    bytes,
    hash: hashBytes(bytes),
    role,
    ...(xsIncludeName ? { xsIncludeName } : {}),
  });
}

function profileXsFiles(files: readonly DesiredFile[]): ProfileXsFile[] {
  return files.flatMap((file) =>
    file.role === 'external-xs' && file.xsIncludeName
      ? [{ name: file.xsIncludeName, bytes: file.bytes }]
      : [],
  );
}

async function validateTarget(
  requested: ManagedDeploymentTarget,
  createLocalRoot: boolean,
): Promise<ManagedDeploymentTarget & { localModsPath: string; targetPath: string }> {
  if (!/^[0-9]{3,20}$/u.test(requested.profileId)) {
    throw new Error('managed deployment requires an explicitly selected numeric profile');
  }
  const directoryName = requested.directoryName ?? managedModDirectoryName;
  if (requested.kind === 'manual') {
    validatePersistentModName(directoryName);
    if (
      requested.title !== directoryName ||
      !/^[a-f0-9-]{36}$/u.test(requested.ownershipId ?? '')
    ) {
      throw new Error('persistent deployment identity is invalid');
    }
  } else if (directoryName !== managedModDirectoryName) {
    throw new Error('live deployment target name is invalid');
  }
  const installationRoot = await canonicalDirectory(requested.installationRoot);
  const profileRoot = await canonicalDirectory(requested.profileRoot);
  if (isInside(profileRoot, installationRoot) || isInside(installationRoot, profileRoot)) {
    throw new DesktopError(
      'deploy.unsafe-target',
      'managed deployment profile must be outside the game installation',
    );
  }
  const localModsPath = await safeDirectoryTree(profileRoot, ['mods', 'local'], createLocalRoot);
  const targetPath = join(localModsPath, directoryName);
  if (await pathExists(targetPath)) {
    const metadata = await lstat(targetPath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new DesktopError(
        'deploy.unsafe-target',
        'managed deployment target is not a regular directory',
      );
    }
    const canonicalTarget = await realpath(targetPath);
    if (!samePath(canonicalTarget, targetPath) || !isInside(canonicalTarget, localModsPath)) {
      throw new Error('managed deployment target is redirected outside its local-mod root');
    }
  }
  return {
    installationRoot,
    profileId: requested.profileId,
    profileRoot,
    directoryName,
    title: requested.title,
    kind: requested.kind ?? 'live',
    ownershipId: requested.ownershipId,
    localModsPath,
    targetPath,
  };
}

async function safeDirectoryTree(
  root: string,
  parts: readonly string[],
  create: boolean,
): Promise<string> {
  let current = root;
  for (const part of parts) {
    const next = join(current, part);
    if (!(await pathExists(next))) {
      if (!create) return join(current, ...parts.slice(parts.indexOf(part)));
      await mkdir(next);
    }
    const metadata = await lstat(next);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error('managed local-mod path contains a redirection');
    }
    const canonical = await realpath(next);
    if (!samePath(canonical, next) || !isInside(canonical, root)) {
      throw new DesktopError(
        'deploy.unsafe-target',
        'managed local-mod path escaped the selected profile',
      );
    }
    current = canonical;
  }
  return current;
}

interface CurrentInventory {
  exists: boolean;
  managed: boolean;
  gameNormalizedInfo: boolean;
  ownershipId: string | null;
  files: Array<{ path: string; hash: string; bytes: number }>;
  hash: string;
}

async function inventory(target: string): Promise<CurrentInventory> {
  if (!(await pathExists(target))) {
    return {
      exists: false,
      managed: false,
      gameNormalizedInfo: false,
      ownershipId: null,
      files: [],
      hash: hashInventory([]),
    };
  }
  const files: CurrentInventory['files'] = [];
  await collectInventory(target, target, files, 0, { bytes: 0, entries: 0 });
  files.sort((left, right) => compare(left.path, right.path));
  const info = files.find((file) => pathKey(file.path) === 'info.json');
  let managed = false;
  let gameNormalizedInfo = false;
  let ownershipId: string | null = null;
  if (info) {
    try {
      const content = JSON.parse(
        (await readFileBounded(safeJoin(target, info.path), maximumMarkerBytes)).toString('utf8'),
      ) as unknown;
      managed = isRecord(content) && content.RmsideManagedContract === managedModContract;
      ownershipId =
        isRecord(content) &&
        content.RmsideManagedContract === persistentManagedModContract &&
        typeof content.RmsideOwnershipId === 'string' &&
        /^[a-f0-9-]{36}$/u.test(content.RmsideOwnershipId)
          ? content.RmsideOwnershipId
          : null;
      gameNormalizedInfo = isGameNormalizedManagedInfo(content);
    } catch {
      managed = false;
      gameNormalizedInfo = false;
    }
  }
  const ownership = files.find((file) => pathKey(file.path) === '.aoe2rmside-ownership.json');
  if (ownership) {
    try {
      const content = JSON.parse(
        (await readFileBounded(safeJoin(target, ownership.path), maximumMarkerBytes)).toString(
          'utf8',
        ),
      ) as unknown;
      ownershipId =
        isRecord(content) &&
        content.contract === persistentManagedModContract &&
        typeof content.ownershipId === 'string' &&
        /^[a-f0-9-]{36}$/u.test(content.ownershipId)
          ? content.ownershipId
          : null;
    } catch {
      ownershipId = null;
    }
  }
  return {
    exists: true,
    managed,
    gameNormalizedInfo,
    ownershipId,
    files,
    hash: hashInventory(files),
  };
}

function isGameNormalizedManagedInfo(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort(compare);
  return (
    keys.length === 4 &&
    keys[0] === 'Author' &&
    keys[1] === 'CacheStatus' &&
    keys[2] === 'Description' &&
    keys[3] === 'Title' &&
    value.Author === managedModAuthor &&
    (value.CacheStatus === 0 || value.CacheStatus === 1) &&
    value.Description === managedModDescription &&
    value.Title === managedModName
  );
}

function isRecognizedGameMetadataRewrite(
  current: CurrentInventory,
  previousFiles: Readonly<Record<string, string>>,
  desiredByPath: ReadonlyMap<string, DesiredFile>,
): boolean {
  const desiredInfo = desiredByPath.get('info.json');
  return (
    current.gameNormalizedInfo &&
    desiredInfo !== undefined &&
    previousFiles['info.json'] === desiredInfo.hash
  );
}

function isInventoryGameMetadataRewrite(
  current: CurrentInventory,
  recordedFiles: Readonly<Record<string, string>>,
): boolean {
  return current.gameNormalizedInfo && typeof recordedFiles['info.json'] === 'string';
}

async function collectInventory(
  root: string,
  current: string,
  files: CurrentInventory['files'],
  depth: number,
  budget: { bytes: number; entries: number },
): Promise<void> {
  if (depth > 64) {
    throw new Error('managed deployment inventory exceeds its safety limit');
  }
  const directory = await opendir(current);
  for await (const entry of directory) {
    budget.entries += 1;
    if (budget.entries > maximumInventoryEntries) {
      throw new Error('managed deployment inventory exceeds its safety limit');
    }
    if (entry.isSymbolicLink()) throw new Error('managed deployment contains a redirected path');
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      await collectInventory(root, path, files, depth + 1, budget);
    } else if (entry.isFile()) {
      if (files.length >= maximumDeploymentFiles) {
        throw new Error('managed deployment inventory exceeds its safety limit');
      }
      const metadata = await lstat(path);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.size > maximumDeploymentBytes - budget.bytes
      ) {
        throw new Error('managed deployment inventory exceeds its safety limit');
      }
      const bytes = await readFileBounded(path, maximumDeploymentBytes - budget.bytes);
      budget.bytes += bytes.byteLength;
      if (budget.bytes > maximumDeploymentBytes) {
        throw new Error('managed deployment inventory exceeds its safety limit');
      }
      files.push({
        path: relative(root, path).replaceAll('\\', '/'),
        hash: hashBytes(bytes),
        bytes: bytes.byteLength,
      });
    } else {
      throw new DesktopError(
        'deploy.unsafe-target',
        'managed deployment contains an unsupported filesystem entry',
      );
    }
  }
}

function inventoryMatchesRecord(current: CurrentInventory, record: DeploymentRecord): boolean {
  const recorded = new Map(
    Object.entries(record.files).map(([path, hash]) => [pathKey(path), hash] as const),
  );
  if (current.files.length !== recorded.size) return false;
  const identityMatches =
    record.kind === 'manual'
      ? current.ownershipId === record.ownershipId
      : current.managed || isInventoryGameMetadataRewrite(current, record.files);
  return (
    identityMatches &&
    current.files.every((file) => {
      const expected = recorded.get(pathKey(file.path));
      return (
        expected === file.hash ||
        (record.kind !== 'manual' &&
          pathKey(file.path) === 'info.json' &&
          current.gameNormalizedInfo &&
          expected !== undefined)
      );
    })
  );
}

function hashInventory(files: CurrentInventory['files']): string {
  const hash = createHash('sha256').update('managed-deployment-inventory-v1');
  for (const file of files) {
    hash.update(file.path);
    hash.update(file.hash);
    hash.update(String(file.bytes));
  }
  return hash.digest('hex');
}

function validateDeploymentRequest(value: ManagedDeploymentRequest): void {
  if (
    !value ||
    value.contractVersion?.major !== 1 ||
    value.contractVersion.minor !== 0 ||
    value.contractVersion.patch !== 0 ||
    typeof value.documentUri !== 'string' ||
    value.documentUri.length < 1 ||
    value.documentUri.length > 4096 ||
    !Number.isSafeInteger(value.documentRevision) ||
    value.documentRevision < 0 ||
    !Number.isSafeInteger(value.sourceCatalogRevision) ||
    value.sourceCatalogRevision < 1 ||
    !validHash(value.sourceCatalogHash) ||
    !validHash(value.sourceGraphHash) ||
    !validHash(value.externalAssetHash) ||
    !Array.isArray(value.resolvedRmsSourceIds) ||
    !Array.isArray(value.externalAssetSourceIds) ||
    value.resolvedRmsSourceIds.length > maximumDeploymentFiles ||
    value.externalAssetSourceIds.length > maximumDeploymentFiles ||
    ![...value.resolvedRmsSourceIds, ...value.externalAssetSourceIds].every(
      (sourceId) => typeof sourceId === 'string' && sourceId.length >= 1 && sourceId.length <= 4096,
    ) ||
    typeof value.includePreviewImage !== 'boolean'
  ) {
    throw new Error('managed deployment request is invalid');
  }
}

function validateApplyRequest(value: ManagedDeploymentApplyRequest): void {
  if (
    !value ||
    typeof value.token !== 'string' ||
    !/^[a-f0-9-]{36}$/u.test(value.token) ||
    typeof value.overwriteExternalChanges !== 'boolean' ||
    (value.confirmReplaceExisting !== undefined &&
      typeof value.confirmReplaceExisting !== 'boolean')
  ) {
    throw new Error('managed deployment apply request is invalid');
  }
}

function validateState(value: unknown): DeploymentState {
  if (
    !isRecord(value) ||
    value.schemaVersion !== '1.0.0' ||
    !isRecord(value.compatibility) ||
    value.compatibility.readerMajor !== 1 ||
    !isRecord(value.deployments)
  ) {
    throw new Error('managed deployment state is invalid');
  }
  if (Object.keys(value.deployments).length > 128) {
    throw new Error('managed deployment state is oversized');
  }
  const deployments: Record<string, DeploymentRecord> = {};
  for (const [key, record] of Object.entries(value.deployments)) {
    if (!/^[a-f0-9]{64}$/u.test(key) || !isRecord(record)) {
      throw new Error('managed deployment state entry is invalid');
    }
    const profileId = record.profileId;
    const sourceCatalogHash = record.sourceCatalogHash;
    if (
      record.schemaVersion !== '1.0.0' ||
      !isRecord(record.compatibility) ||
      record.compatibility.readerMajor !== 1 ||
      !validProfileId(profileId) ||
      !validHash(sourceCatalogHash) ||
      !isRecord(record.files)
    ) {
      throw new Error('managed deployment state entry is invalid');
    }
    const files: Record<string, string> = {};
    for (const [path, hash] of Object.entries(record.files)) {
      if (!validRelativePath(path) || !validHash(hash)) {
        throw new Error('managed deployment state file is invalid');
      }
      files[path] = hash;
    }
    deployments[key] = {
      schemaVersion: '1.0.0',
      compatibility: { readerMajor: 1 },
      profileId,
      sourceCatalogHash,
      files,
      ...(record.kind === 'manual' || record.kind === 'live' ? { kind: record.kind } : {}),
      ...(typeof record.installationRoot === 'string'
        ? { installationRoot: record.installationRoot }
        : {}),
      ...(typeof record.profileRoot === 'string' ? { profileRoot: record.profileRoot } : {}),
      ...(typeof record.directoryName === 'string' ? { directoryName: record.directoryName } : {}),
      ...(typeof record.title === 'string' ? { title: record.title } : {}),
      ...(typeof record.ownershipId === 'string' ? { ownershipId: record.ownershipId } : {}),
      ...(typeof record.documentUri === 'string' ? { documentUri: record.documentUri } : {}),
      ...(typeof record.lastConfirmedAt === 'string'
        ? { lastConfirmedAt: record.lastConfirmedAt }
        : {}),
    };
    if (deployments[key]!.kind === 'manual') {
      const manual = deployments[key]!;
      if (
        !manual.installationRoot ||
        !isAbsolute(manual.installationRoot) ||
        !manual.profileRoot ||
        !isAbsolute(manual.profileRoot) ||
        !manual.directoryName ||
        !isPersistentModName(manual.directoryName) ||
        manual.title !== manual.directoryName ||
        !/^[a-f0-9-]{36}$/u.test(manual.ownershipId ?? '') ||
        !manual.documentUri ||
        manual.documentUri.length > 4096 ||
        !manual.lastConfirmedAt ||
        !Number.isFinite(Date.parse(manual.lastConfirmedAt))
      ) {
        throw new Error('persistent deployment state entry is invalid');
      }
    }
  }
  return { schemaVersion: '1.0.0', compatibility: { readerMajor: 1 }, deployments };
}

function validateJournal(value: unknown): DeploymentJournal {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !['prepared', 'target-backed-up', 'committed'].includes(String(value.phase)) ||
    typeof value.key !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.key) ||
    !validProfileId(value.profileId) ||
    !['installationRoot', 'profileRoot', 'parent', 'target', 'stage', 'backup'].every(
      (field) => typeof value[field] === 'string' && isAbsolute(value[field]),
    )
  ) {
    throw new Error('managed deployment recovery journal is invalid');
  }
  const record = validateState({
    schemaVersion: '1.0.0',
    compatibility: { readerMajor: 1 },
    deployments: { [value.key]: value.record },
  }).deployments[value.key]!;
  return {
    version: 1,
    phase: value.phase as DeploymentJournal['phase'],
    key: value.key,
    installationRoot: value.installationRoot as string,
    profileId: value.profileId,
    profileRoot: value.profileRoot as string,
    parent: value.parent as string,
    target: value.target as string,
    stage: value.stage as string,
    backup: value.backup as string,
    record,
  };
}

export { validateState as validateDeploymentState, validateJournal as validateDeploymentJournal };

function validateJournalPaths(
  journal: DeploymentJournal,
  target: ManagedDeploymentTarget & { localModsPath: string; targetPath: string },
): void {
  const directoryName = target.directoryName ?? managedModDirectoryName;
  if (
    !samePath(journal.installationRoot, target.installationRoot) ||
    journal.profileId !== target.profileId ||
    !samePath(journal.profileRoot, target.profileRoot) ||
    journal.key !== deploymentKey(target) ||
    journal.record.profileId !== target.profileId ||
    !samePath(journal.parent, target.localModsPath) ||
    !samePath(journal.target, target.targetPath) ||
    basename(journal.target) !== directoryName ||
    dirname(journal.target) !== journal.parent ||
    dirname(journal.stage) !== journal.parent ||
    dirname(journal.backup) !== journal.parent ||
    !basename(journal.stage).startsWith(`.${directoryName}.stage-`) ||
    !basename(journal.backup).startsWith(`.${directoryName}.backup-`)
  ) {
    throw new DesktopError('deploy.state-invalid', 'managed deployment recovery paths are unsafe');
  }
}

async function assertRecoveryPath(path: string): Promise<void> {
  if (!(await pathExists(path))) return;
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('managed deployment recovery path is redirected');
  }
}

const validPathPart = isSafeWindowsPathPart;

export function validatePersistentModName(value: string): void {
  if (!isPersistentModName(value)) {
    throw new Error(
      'mod name must be one Windows-safe folder name without reserved characters, traversal, or trailing dots/spaces',
    );
  }
  if (isReservedPersistentModName(value)) {
    throw new Error('the live-test managed mod name is reserved');
  }
}

function validRelativePath(path: string): boolean {
  return (
    typeof path === 'string' &&
    path.length <= 4096 &&
    !isAbsolute(path) &&
    path.split(/[\\/]/u).every(validPathPart)
  );
}

function safeJoin(root: string, child: string): string {
  if (!validRelativePath(child)) throw new Error('managed deployment path is invalid');
  const target = resolve(root, child);
  if (!isInside(target, root)) throw new Error('managed deployment path escaped its root');
  return target;
}

function deploymentStateUnreadable(error: unknown): DesktopError {
  return new DesktopError(
    'deploy.state-invalid',
    error instanceof Error ? error.message : String(error),
  );
}

async function canonicalDirectory(path: string): Promise<string> {
  const canonical = await realpath(resolve(path));
  const metadata = await lstat(canonical);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new DesktopError(
      'deploy.unsafe-target',
      'managed deployment root is not a regular directory',
    );
  }
  return canonical;
}

function deploymentKey(target: ManagedDeploymentTarget): string {
  return createHash('sha256')
    .update(
      `${pathKey(target.installationRoot)}\0${pathKey(target.profileRoot)}\0${target.profileId}${target.kind === 'manual' ? `\0manual\0${pathKey(target.directoryName ?? '')}` : ''}`,
    )
    .digest('hex');
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    [...left].sort(compare).every((value, index) => value === [...right].sort(compare)[index])
  );
}

function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function validHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function validProfileId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]{3,20}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isInside(path: string, root: string): boolean {
  const child = relative(resolve(root), resolve(path));
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

function samePath(left: string, right: string): boolean {
  return pathKey(resolve(left)) === pathKey(resolve(right));
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

function compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}
