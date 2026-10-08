import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { isExternalLinkTarget } from '../shared/external-links';
import {
  ipcChannels,
  isDeploymentProfileId,
  liveWorkflowStages,
  maximumManualDeploymentMapIconBytes,
  validateMapIconRenderInput,
  type MapIconRenderInput,
  type ApplicationMenuAction,
  type ApplicationMenuName,
  type ApplicationMenuTriggerBounds,
  type ControlConnectPurpose,
  type ControlLiveSynchronizationRequest,
  type ControlLiveWorkflowEvent,
  type ControlSessionEvent,
  type DesktopSession,
  type DevelopmentFixtureRequest,
  type ExternalLinkTarget,
  type LanguageServerEvent,
  type LanguageServerNotificationMethod,
  type LanguageServerRequestMethod,
  type ManagedDeploymentApplyRequest,
  type ManagedDeploymentRequest,
  type ManualDeploymentApplyRequest,
  type ManualDeploymentMapIconImage,
  type ManualDeploymentPreviewRequest,
  type MapIconSourceRequest,
  type MapTestEvent,
  type MapTestReplayInput,
  type MapTestRunInput,
  type RootExecutionState,
  type NativeProcessName,
  type NativeProcessStatus,
  type PreviewGenerationInput,
  type PreviewGenerationEvent,
  type PreviewGenerationResult,
  type PreviewVersionOrigin,
  type RememberedInstallationSelection,
  type ResolvedTheme,
  type RecoverySnapshot,
  type RmsideDesktopApi,
  type GeneratedMapIconSaveRequest,
  type ThemePreference,
  type WorkspaceExternalChange,
  type WorkspaceCreateRequest,
  type DefinitionFileGenerateRequest,
  type DefinitionFilePrepareRequest,
  type WorkspaceDeleteRequest,
  type WorkspaceRenameRequest,
  type WorkspaceSaveAsRequest,
  type WorkspaceSaveRequest,
} from '../shared/api';
import { validateLocalPresentationNames } from '../shared/local-presentation-names';
import { definitionGroupIds, type DefinitionGroupId } from '../shared/definition-file';
import { isMapTestProgressCounts, isMapTestWorkerSetting } from '../shared/map-test-contract';
import { isRmsLintCode } from '../shared/rms-lint-rules';
import { validateOutputMessage, type OutputMessage } from '../shared/output-message';
import {
  isLanguagePreference,
  validateLocaleState,
  type LanguagePreference,
  type LocaleState,
} from '../shared/i18n/locale';
import {
  validateGameArtImageKeys,
  validateGameArtImages,
  validateGameArtSpriteRequest,
  validateGameArtSpriteSet,
  validateGameArtStatus,
  validateGameArtTerrainIndex,
  type GameArtSpriteRequestObject,
  type GameArtStatus,
} from '../shared/game-art';
import {
  validateGeneratedMapIconSaveRequest,
  validateManualDeploymentMapIconRequest,
} from '../shared/map-icon-deployment';
import {
  unwrapPreviewGenerationSettlement,
  withValidatedExecutionCost,
} from '../shared/preview-generation-settlement';
import {
  validateExecutionProgressEvent,
  type ExecutionProgressEvent,
} from '../shared/execution-cost';
import {
  validatePreviewCandidate,
  validatePreviewCandidateAcknowledgement,
  type PreviewCandidate,
  type PreviewCandidateAcknowledgement,
} from '../shared/preview-candidate';
import {
  validateMapIconSourceRequest,
  validMapIconSourceRequestId,
} from '../shared/map-icon-source';

function assertNativeName(value: NativeProcessName): NativeProcessName {
  if (value !== 'rmsd' && value !== 'rms-ls' && value !== 'rms-test' && value !== 'rms-test-lsp') {
    throw new Error('invalid native process name');
  }
  return value;
}

function assertApplicationMenuName(value: ApplicationMenuName): ApplicationMenuName {
  if (value !== 'file' && value !== 'edit' && value !== 'view' && value !== 'help') {
    throw new Error('invalid application menu name');
  }
  return value;
}

function assertExternalLinkTarget(value: ExternalLinkTarget): ExternalLinkTarget {
  if (!isExternalLinkTarget(value)) throw new Error('invalid external link target');
  return value;
}

function assertMenuCoordinate(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 16_384) {
    throw new Error('invalid application menu coordinate');
  }
  return Math.round(value);
}

function assertApplicationMenuBounds(
  value: ApplicationMenuTriggerBounds[],
): ApplicationMenuTriggerBounds[] {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error('application menu bounds must contain four entries');
  }
  const names = new Set<ApplicationMenuName>();
  const bounds = value.map((entry) => {
    const name = assertApplicationMenuName(entry?.name);
    if (names.has(name)) throw new Error('application menu bounds contain duplicate names');
    names.add(name);
    const x = assertMenuCoordinate(entry.x);
    const y = assertMenuCoordinate(entry.y);
    const width = assertMenuCoordinate(entry.width);
    const height = assertMenuCoordinate(entry.height);
    if (width < 1 || height < 1) throw new Error('application menu bounds must be non-empty');
    return Object.freeze({ name, x, y, width, height });
  });
  return Object.freeze(bounds) as unknown as ApplicationMenuTriggerBounds[];
}

function assertThemePreference(value: ThemePreference): ThemePreference {
  if (value !== 'system' && value !== 'light' && value !== 'dark') {
    throw new Error('invalid theme preference');
  }
  return value;
}

function assertResolvedTheme(value: ResolvedTheme): ResolvedTheme {
  if (value !== 'light' && value !== 'dark') throw new Error('invalid resolved theme');
  return value;
}

const languageServerRequestMethods = new Set<LanguageServerRequestMethod>([
  'textDocument/completion',
  'textDocument/signatureHelp',
  'textDocument/hover',
  'textDocument/definition',
  'textDocument/documentLink',
  'textDocument/references',
  'textDocument/documentHighlight',
  'textDocument/documentSymbol',
  'textDocument/foldingRange',
  'textDocument/semanticTokens/full',
  'workspace/symbol',
  'textDocument/formatting',
  'textDocument/prepareRename',
  'textDocument/rename',
  'textDocument/codeAction',
  'textDocument/inlayHint',
  'completionItem/resolve',
  'rms/semanticIdentity',
  'rms/validateSourceCatalogIdentity',
]);

const languageServerNotificationMethods = new Set<LanguageServerNotificationMethod>([
  'textDocument/didOpen',
  'textDocument/didChange',
  'textDocument/didClose',
  'workspace/didChangeWatchedFiles',
  'rms/previewContext',
]);

function assertLanguageServerRequestMethod(
  value: LanguageServerRequestMethod,
): LanguageServerRequestMethod {
  if (!languageServerRequestMethods.has(value)) {
    throw new Error('language-server request method is not allowed');
  }
  return value;
}

function assertLanguageServerNotificationMethod(
  value: LanguageServerNotificationMethod,
): LanguageServerNotificationMethod {
  if (!languageServerNotificationMethods.has(value)) {
    throw new Error('language-server notification method is not allowed');
  }
  return value;
}

function assertLanguageServerPayload(value: unknown): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error('language-server payload is not serializable');
  }
  if (
    serialized === undefined ||
    new TextEncoder().encode(serialized).byteLength > 4 * 1024 * 1024
  ) {
    throw new Error('language-server payload exceeds its bounded size');
  }
  return value;
}

function assertBoundedString(value: string, label: string, maximumLength: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximumLength) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function assertPath(value: string): string {
  return assertBoundedString(value, 'path', 32_768);
}

function utf8ByteLengthWithin(value: string, limit: number): number {
  if (value.length > limit) return limit + 1;
  let bytes = 0;
  for (let index = 0; index < value.length && bytes <= limit; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

const maximumSourceContentBytes = 16 * 1024 * 1024;
const maximumRecoveryContentBytes = 64 * 1024 * 1024;

function assertContent(value: string): string {
  if (
    typeof value !== 'string' ||
    utf8ByteLengthWithin(value, maximumSourceContentBytes) > maximumSourceContentBytes
  ) {
    throw new Error('source content is invalid');
  }
  return value;
}

function assertSaveRequest(value: WorkspaceSaveRequest): WorkspaceSaveRequest {
  if (!value || typeof value !== 'object') throw new Error('save request is invalid');
  return Object.freeze({
    documentId: assertBoundedString(value.documentId, 'document id', 512),
    path: assertPath(value.path),
    content: assertContent(value.content),
    diskHash: assertBoundedString(value.diskHash, 'disk hash', 64),
    ...(value.overwriteExternalChange === undefined
      ? {}
      : { overwriteExternalChange: assertBoolean(value.overwriteExternalChange) }),
  });
}

function assertBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('boolean value is invalid');
  return value;
}

function assertControlConnectPurpose(value: ControlConnectPurpose): ControlConnectPurpose {
  if (value !== 'live-run' && value !== 'adopt-seed') {
    throw new Error('AoE2Control connection purpose is invalid');
  }
  return value;
}

function assertControlSessionEvent(value: ControlSessionEvent): ControlSessionEvent {
  const kinds = new Set([
    'startup',
    'game-detected',
    'attach',
    'handshake',
    'ready',
    'cancelled',
    'failure',
    'detached',
  ]);
  if (
    !value ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    !kinds.has(value.kind) ||
    typeof value.detailCode !== 'string' ||
    value.detailCode.length < 1 ||
    value.detailCode.length > 128 ||
    !optionalEventDetail(value.detail) ||
    (value.recovery !== undefined && value.recovery !== true)
  ) {
    throw new Error('AoE2Control session event is invalid');
  }
  return Object.freeze({ ...value });
}

function assertControlLiveSynchronizationRequest(
  value: ControlLiveSynchronizationRequest,
): ControlLiveSynchronizationRequest {
  const serialized = JSON.stringify(value);
  if (!serialized || new TextEncoder().encode(serialized).byteLength > 2 * 1024 * 1024) {
    throw new Error('live-test request is invalid or oversized');
  }
  const parsed = JSON.parse(serialized) as ControlLiveSynchronizationRequest;
  const hashes = [
    parsed.preview?.requestHash,
    parsed.preview?.semanticProgramHash,
    parsed.preview?.sourceCatalogHash,
    parsed.preview?.sourceGraphHash,
    parsed.preview?.externalAssetHash,
    parsed.preview?.profileHash,
    parsed.preview?.contentPackHash,
  ];
  if (
    parsed.contractVersion?.major !== 1 ||
    parsed.contractVersion.minor !== 0 ||
    parsed.contractVersion.patch !== 0 ||
    !/^[A-Za-z0-9._:-]{1,96}$/u.test(parsed.requestId) ||
    parsed.preview?.backend !== 'exact' ||
    parsed.preview.provenanceStatus !== 'exact' ||
    typeof parsed.preview.documentUri !== 'string' ||
    !Number.isSafeInteger(parsed.preview.documentRevision) ||
    typeof parsed.preview.currentDocumentUri !== 'string' ||
    !Number.isSafeInteger(parsed.preview.currentDocumentRevision) ||
    hashes.some((hash) => typeof hash !== 'string' || !/^[a-f0-9]{64}$/u.test(hash)) ||
    !Number.isSafeInteger(parsed.preview.seed) ||
    parsed.preview.seed < 0 ||
    parsed.preview.seed > 0xffff_ffff ||
    !parsed.setup ||
    parsed.setup.revealMap !== 'all-visible' ||
    !Array.isArray(parsed.setup.players) ||
    parsed.setup.players.length < 1 ||
    parsed.setup.players.length > 8 ||
    typeof parsed.replaceActiveMatch !== 'boolean' ||
    typeof parsed.overwriteDeploymentConflicts !== 'boolean'
  ) {
    throw new Error('live-test request is invalid');
  }
  parsed.deployment = assertManagedDeploymentRequest(parsed.deployment);
  return Object.freeze(parsed);
}

function optionalEventDetail(value: unknown): boolean {
  return (
    value === undefined || (typeof value === 'string' && value.length >= 1 && value.length <= 512)
  );
}

function assertControlLiveWorkflowEvent(value: ControlLiveWorkflowEvent): ControlLiveWorkflowEvent {
  const kinds = new Set([
    'startup',
    'stage',
    'handshake',
    'clean-end',
    'deploy',
    'catalog-refresh',
    'start',
    'effective-readback',
    'cancellation',
    'failure',
  ]);
  if (
    !value ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    !/^[A-Za-z0-9._:-]{1,96}$/u.test(value.requestId) ||
    !kinds.has(value.kind) ||
    typeof value.detailCode !== 'string' ||
    value.detailCode.length < 1 ||
    value.detailCode.length > 128 ||
    (value.kind === 'stage' &&
      !(liveWorkflowStages as readonly string[]).includes(value.detailCode)) ||
    !optionalEventDetail(value.detail) ||
    (value.seed !== undefined &&
      (!Number.isSafeInteger(value.seed) || value.seed < 0 || value.seed > 0xffff_ffff)) ||
    (value.matchEpoch !== undefined &&
      (!Number.isSafeInteger(value.matchEpoch) || value.matchEpoch < 0)) ||
    (value.xsFiles !== undefined &&
      (value.kind !== 'deploy' ||
        !Array.isArray(value.xsFiles) ||
        value.xsFiles.length < 1 ||
        value.xsFiles.length > 64 ||
        !value.xsFiles.every(
          (name) =>
            typeof name === 'string' &&
            name.length <= 255 &&
            /^[^<>:"/\\|?*\u0000-\u001f]+\.xs$/iu.test(name),
        )))
  ) {
    throw new Error('live-test workflow event is invalid');
  }
  return Object.freeze({
    ...value,
    ...(value.xsFiles ? { xsFiles: Object.freeze([...value.xsFiles]) as string[] } : {}),
  });
}

function assertEncoding(value: WorkspaceSaveAsRequest['encoding']) {
  if (value !== 'utf8' && value !== 'utf8-bom' && value !== 'windows-1252') {
    throw new Error('source encoding is invalid');
  }
  return value;
}

function assertNewlineStyle(value: WorkspaceSaveAsRequest['newlineStyle']) {
  if (
    value !== 'none' &&
    value !== 'lf' &&
    value !== 'crlf' &&
    value !== 'cr' &&
    value !== 'mixed'
  ) {
    throw new Error('source newline style is invalid');
  }
  return value;
}

function assertSaveAsRequest(value: WorkspaceSaveAsRequest): WorkspaceSaveAsRequest {
  if (!value || typeof value !== 'object') throw new Error('save-as request is invalid');
  return Object.freeze({
    documentId: assertBoundedString(value.documentId, 'document id', 512),
    content: assertContent(value.content),
    suggestedName: assertBoundedString(value.suggestedName, 'suggested name', 512),
    encoding: assertEncoding(value.encoding),
    newlineStyle: assertNewlineStyle(value.newlineStyle),
  });
}

function assertRecoverySnapshot(value: RecoverySnapshot): RecoverySnapshot {
  if (!value || value.version !== 1 || !Array.isArray(value.documents)) {
    throw new Error('recovery snapshot is invalid');
  }
  if (value.documents.length > 128) throw new Error('recovery snapshot has too many documents');
  let contentBytes = 0;
  for (const document of value.documents) {
    assertBoundedString(document.id, 'recovery document id', 512);
    contentBytes += utf8ByteLengthWithin(
      assertContent(document.content),
      maximumSourceContentBytes,
    );
    if (contentBytes > maximumRecoveryContentBytes) {
      throw new Error('recovery snapshot exceeds its bounded size');
    }
  }
  return value;
}

function assertDesktopSession(value: DesktopSession): DesktopSession {
  if (!value || value.version !== 1) throw new Error('desktop session is invalid');
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error('desktop session is not serializable');
  }
  if (new TextEncoder().encode(serialized).byteLength > 2 * 1024 * 1024) {
    throw new Error('desktop session exceeds its bounded size');
  }
  return JSON.parse(serialized) as DesktopSession;
}

function assertEntryId(value: string): string {
  return assertBoundedString(value, 'workspace entry identity', 256);
}

function assertEntryName(value: string): string {
  return assertBoundedString(value, 'workspace entry name', 255);
}

function assertCreateRequest(value: WorkspaceCreateRequest): WorkspaceCreateRequest {
  if (!value || (value.kind !== 'file' && value.kind !== 'folder')) {
    throw new Error('workspace create request is invalid');
  }
  if (
    value.template !== undefined &&
    value.template !== 'map-test-v1' &&
    value.template !== 'xs-v1'
  ) {
    throw new Error('workspace create template is invalid');
  }
  return Object.freeze({
    parentId: assertEntryId(value.parentId),
    kind: value.kind,
    name: assertEntryName(value.name),
    ...(value.template ? { template: value.template } : {}),
  });
}

function assertDefinitionFilePrepareRequest(
  value: DefinitionFilePrepareRequest,
): DefinitionFilePrepareRequest {
  if (!value || typeof value !== 'object') throw new Error('definition file request is invalid');
  return Object.freeze({
    folderId: value.folderId === null ? null : assertEntryId(value.folderId),
  });
}

function assertDefinitionFileGenerateRequest(
  value: DefinitionFileGenerateRequest,
): DefinitionFileGenerateRequest {
  if (!value || typeof value !== 'object' || !Array.isArray(value.groups)) {
    throw new Error('definition file request is invalid');
  }
  const groups = value.groups.slice(0, definitionGroupIds.length + 1);
  if (
    groups.length < 1 ||
    groups.length > definitionGroupIds.length ||
    groups.some((group) => !definitionGroupIds.includes(group as DefinitionGroupId))
  ) {
    throw new Error('definition file groups are invalid');
  }
  return Object.freeze({
    planId: assertBoundedString(value.planId, 'definition file plan', 64),
    fileName: assertEntryName(value.fileName),
    groups: [...groups],
    includeBuiltIn: assertBoolean(value.includeBuiltIn),
    overwrite: assertBoolean(value.overwrite),
  });
}

function assertRenameRequest(value: WorkspaceRenameRequest): WorkspaceRenameRequest {
  if (!value) throw new Error('workspace rename request is invalid');
  return Object.freeze({
    entryId: assertEntryId(value.entryId),
    name: assertEntryName(value.name),
  });
}

function assertDeleteRequest(value: WorkspaceDeleteRequest): WorkspaceDeleteRequest {
  if (!value) throw new Error('workspace delete request is invalid');
  if (value.permanent !== undefined && typeof value.permanent !== 'boolean') {
    throw new Error('workspace delete request is invalid');
  }
  return Object.freeze({
    entryId: assertEntryId(value.entryId),
    ...(value.permanent === true ? { permanent: true } : {}),
  });
}

function assertPreviewGenerationInput(value: PreviewGenerationInput): PreviewGenerationInput {
  if (
    !value ||
    typeof value !== 'object' ||
    (value.clientRequestId !== undefined &&
      (typeof value.clientRequestId !== 'string' || value.clientRequestId.length > 512)) ||
    typeof value.documentUri !== 'string' ||
    !Number.isSafeInteger(value.documentRevision) ||
    typeof value.source !== 'string' ||
    !Number.isInteger(value.width) ||
    !Number.isInteger(value.height) ||
    !Number.isSafeInteger(value.seed) ||
    !Array.isArray(value.players) ||
    value.players.length < 1 ||
    value.players.length > 8 ||
    (value.progressivePreview !== undefined && typeof value.progressivePreview !== 'boolean')
  ) {
    throw new Error('preview generation input is invalid');
  }
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).byteLength > 17 * 1024 * 1024) {
    throw new Error('preview generation input exceeds its bounded size');
  }
  return JSON.parse(serialized) as PreviewGenerationInput;
}

function assertMapTestRunInput(value: MapTestRunInput): MapTestRunInput {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.executionId !== 'string' ||
    value.executionId.length < 1 ||
    value.executionId.length > 128 ||
    typeof value.scriptUri !== 'string' ||
    value.scriptUri.length < 1 ||
    value.scriptUri.length > 4096 ||
    !Number.isSafeInteger(value.scriptRevision) ||
    value.scriptRevision < 0 ||
    typeof value.scriptName !== 'string' ||
    !/\.rmstest$/iu.test(value.scriptName) ||
    typeof value.scriptSource !== 'string' ||
    new TextEncoder().encode(value.scriptSource).byteLength > 1024 * 1024 ||
    typeof value.workspaceName !== 'string' ||
    value.workspaceName.length > 256 ||
    (value.defaultSourceUri !== undefined &&
      (typeof value.defaultSourceUri !== 'string' || value.defaultSourceUri.length > 4096)) ||
    (value.defaultSourcePath !== undefined &&
      (typeof value.defaultSourcePath !== 'string' || value.defaultSourcePath.length > 1024)) ||
    !Number.isInteger(value.width) ||
    value.width < 1 ||
    value.width > 512 ||
    !Number.isInteger(value.height) ||
    value.height < 1 ||
    value.height > 512 ||
    !Array.isArray(value.players) ||
    value.players.length < 1 ||
    value.players.length > 8 ||
    !isMapTestWorkerSetting(value.workers) ||
    (value.progressivePreview !== undefined && typeof value.progressivePreview !== 'boolean')
  ) {
    throw new Error('map-test run input is invalid');
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error('map-test run input is not serializable');
  }
  if (serialized.length > 2 * 1024 * 1024) throw new Error('map-test run input is too large');
  return Object.freeze(structuredClone(value));
}

function assertMapTestReplayInput(value: MapTestReplayInput): MapTestReplayInput {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error('map-test replay input is not serializable');
  }
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.executionId !== 'string' ||
    value.executionId.length < 1 ||
    value.executionId.length > 128 ||
    typeof value.scriptUri !== 'string' ||
    value.scriptUri.length < 1 ||
    value.scriptUri.length > 4096 ||
    !Number.isSafeInteger(value.scriptRevision) ||
    typeof value.scriptSource !== 'string' ||
    typeof value.findingId !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.findingId) ||
    serialized.length > 17 * 1024 * 1024
  ) {
    throw new Error('map-test replay input is invalid');
  }
  return Object.freeze(structuredClone(value));
}

function assertDevelopmentFixtureRequest(
  value: DevelopmentFixtureRequest,
): DevelopmentFixtureRequest {
  if (
    !value ||
    (value.fixtureId !== 'representative' &&
      value.fixtureId !== 'colocated' &&
      value.fixtureId !== 'legend' &&
      value.fixtureId !== 'large' &&
      value.fixtureId !== 'delayed' &&
      value.fixtureId !== 'failure' &&
      value.fixtureId !== 'cancellable')
  ) {
    throw new Error('development fixture request is invalid');
  }
  return Object.freeze({
    fixtureId: value.fixtureId,
    input: assertPreviewGenerationInput(value.input),
  });
}

function assertPreviewGenerationEvent(value: PreviewGenerationEvent): PreviewGenerationEvent {
  const kinds = new Set([
    'generation-started',
    'stage-started',
    'delta-batch',
    'stage-completed',
    'generation-completed',
    'failed',
    'cancelled',
    'diagnostic',
  ]);
  if (
    !value ||
    typeof value.requestId !== 'string' ||
    value.requestId.length > 512 ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 0 ||
    !kinds.has(value.kind) ||
    typeof value.stage !== 'string' ||
    value.stage.length > 128 ||
    !Number.isSafeInteger(value.completed) ||
    value.completed < 0 ||
    !Number.isSafeInteger(value.total) ||
    value.total < 0 ||
    (value.stateHash !== undefined && !/^[0-9a-f]{64}$/u.test(value.stateHash)) ||
    (value.detail !== undefined && (typeof value.detail !== 'string' || value.detail.length > 4096))
  ) {
    throw new Error('preview generation event is invalid');
  }
  if (value.delta) {
    const collections = [
      [value.delta.tiles, 1024],
      [value.delta.objects, 256],
      [value.delta.cliffs, 256],
      [value.delta.connections, 256],
    ] as const;
    if (
      collections.some(
        ([entries, maximum]) => !Array.isArray(entries) || entries.length > maximum,
      ) ||
      collections.some(([entries]) =>
        entries.some(
          (mutation) =>
            !mutation ||
            (mutation.operation !== 'replace' && mutation.operation !== 'remove') ||
            Object.entries(mutation).some(
              ([name, entry]) =>
                name !== 'operation' &&
                (!Number.isSafeInteger(entry) ||
                  (name === 'elevation'
                    ? (entry as number) < -0x8000 || (entry as number) > 0x7fff
                    : (entry as number) < 0 || (entry as number) > 0xffff_ffff)),
            ),
        ),
      )
    ) {
      throw new Error('preview generation delta is invalid');
    }
  }
  if (
    value.initialization &&
    (value.initialization.width < 1 ||
      value.initialization.height < 1 ||
      value.initialization.width > 512 ||
      value.initialization.height > 512 ||
      !/^[0-9a-f]{64}$/u.test(value.initialization.semanticProgramHash) ||
      !/^[0-9a-f]{64}$/u.test(value.initialization.requestHash) ||
      value.initialization.backendIdentity.length < 1 ||
      value.initialization.backendIdentity.length > 128 ||
      value.initialization.provenanceOperations.length > 1_000_000)
  ) {
    throw new Error('preview generation initialization is invalid');
  }
  return structuredClone(value);
}

function assertInstallationSelection(
  value: RememberedInstallationSelection,
): RememberedInstallationSelection {
  if (
    !value ||
    typeof value.installationRoot !== 'string' ||
    value.installationRoot.length < 1 ||
    value.installationRoot.length > 32_768 ||
    (value.userProfileId !== undefined &&
      (typeof value.userProfileId !== 'string' || !/^[0-9]{3,20}$/.test(value.userProfileId)))
  ) {
    throw new Error('installation selection is invalid');
  }
  return Object.freeze({ ...value });
}

function assertInstalledSourceId(value: string): string {
  const sourceId = assertBoundedString(value, 'installed source identity', 72);
  if (!/^source:[a-f0-9]{64}$/u.test(sourceId)) {
    throw new Error('installed source identity is invalid');
  }
  return sourceId;
}

function assertManagedDeploymentRequest(value: ManagedDeploymentRequest): ManagedDeploymentRequest {
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).byteLength > 1024 * 1024) {
    throw new Error('managed deployment request is oversized');
  }
  const parsed = JSON.parse(serialized) as ManagedDeploymentRequest;
  if (
    parsed?.contractVersion?.major !== 1 ||
    parsed.contractVersion.minor !== 0 ||
    parsed.contractVersion.patch !== 0 ||
    typeof parsed.documentUri !== 'string' ||
    !Number.isSafeInteger(parsed.documentRevision) ||
    !Number.isSafeInteger(parsed.sourceCatalogRevision) ||
    !Array.isArray(parsed.resolvedRmsSourceIds) ||
    !Array.isArray(parsed.externalAssetSourceIds) ||
    typeof parsed.includePreviewImage !== 'boolean'
  ) {
    throw new Error('managed deployment request is invalid');
  }
  return Object.freeze(parsed);
}

function assertManagedDeploymentApplyRequest(
  value: ManagedDeploymentApplyRequest,
): ManagedDeploymentApplyRequest {
  if (
    !value ||
    typeof value.token !== 'string' ||
    !/^[a-f0-9-]{36}$/u.test(value.token) ||
    typeof value.overwriteExternalChanges !== 'boolean'
  ) {
    throw new Error('managed deployment apply request is invalid');
  }
  return Object.freeze({ ...value });
}

function assertManualDeploymentPreviewRequest(
  value: ManualDeploymentPreviewRequest,
): ManualDeploymentPreviewRequest {
  if (
    !value ||
    !isDeploymentProfileId(value.profileId) ||
    typeof value.modName !== 'string' ||
    value.modName.length < 1 ||
    value.modName.length > 120
  ) {
    throw new Error('persistent deployment preview request is invalid');
  }
  const deployment = assertManagedDeploymentRequest(value.deployment);
  const mapIcon = validateManualDeploymentMapIconRequest(value.mapIcon);
  if (deployment.includePreviewImage !== (mapIcon.mode === 'retain-original')) {
    throw new Error('map icon option conflicts with original preview-image inclusion');
  }
  return Object.freeze({
    deployment,
    profileId: value.profileId,
    modName: value.modName,
    mapIcon,
  });
}

function assertManualDeploymentApplyRequest(
  value: ManualDeploymentApplyRequest,
): ManualDeploymentApplyRequest {
  if (
    !value ||
    typeof value.token !== 'string' ||
    !/^[a-f0-9-]{36}$/u.test(value.token) ||
    typeof value.confirmReplaceExisting !== 'boolean' ||
    typeof value.enableMod !== 'boolean'
  ) {
    throw new Error('persistent deployment apply request is invalid');
  }
  return Object.freeze({
    token: value.token,
    confirmReplaceExisting: value.confirmReplaceExisting,
    enableMod: value.enableMod,
  });
}

function assertManualDeploymentPreviewToken(value: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/u.test(value)) {
    throw new Error('map icon preview token is invalid');
  }
  return value;
}

function assertManualDeploymentMapIconImage(value: unknown): ManualDeploymentMapIconImage | null {
  if (value === null) return null;
  const image = value as Partial<ManualDeploymentMapIconImage> | undefined;
  if (
    !image ||
    (image.source !== 'original' && image.source !== 'generated') ||
    typeof image.fileName !== 'string' ||
    !/^[^\\/]{1,255}\.png$/iu.test(image.fileName) ||
    !(image.bytes instanceof Uint8Array) ||
    image.bytes.byteLength > maximumManualDeploymentMapIconBytes
  ) {
    throw new Error('map icon image is invalid');
  }
  return Object.freeze({ source: image.source, fileName: image.fileName, bytes: image.bytes });
}

const api: RmsideDesktopApi = Object.freeze({
  getDesktopSession: () => ipcRenderer.invoke(ipcChannels.getDesktopSession),
  saveDesktopSession: (session: DesktopSession) =>
    ipcRenderer.invoke(ipcChannels.saveDesktopSession, assertDesktopSession(session)),
  resetLayout: () => ipcRenderer.invoke(ipcChannels.resetLayout),
  getNativeStatus: () => ipcRenderer.invoke(ipcChannels.nativeStatus),
  restartNative: (name: NativeProcessName) =>
    ipcRenderer.invoke(ipcChannels.restartNative, assertNativeName(name)),
  getConfigurationCatalog: () => ipcRenderer.invoke(ipcChannels.configurationCatalog),
  generatePreview: (input: PreviewGenerationInput) =>
    ipcRenderer
      .invoke(ipcChannels.generatePreview, assertPreviewGenerationInput(input))
      .then(unwrapPreviewGenerationSettlement),
  cancelPreviewGeneration: (clientRequestId: string) =>
    ipcRenderer.invoke(
      ipcChannels.cancelPreviewGeneration,
      assertBoundedString(clientRequestId, 'preview request identity', 512),
    ),
  getExecutionState: () => ipcRenderer.invoke(ipcChannels.executionState),
  stopExecution: () => ipcRenderer.invoke(ipcChannels.executionStop),
  runMapTest: (input: MapTestRunInput) =>
    ipcRenderer.invoke(ipcChannels.mapTestRun, assertMapTestRunInput(input)),
  replayMapTestFinding: (input: MapTestReplayInput) =>
    ipcRenderer
      .invoke(ipcChannels.mapTestReplay, assertMapTestReplayInput(input))
      .then((result: PreviewGenerationResult) => withValidatedExecutionCost(result)),
  onMapTestEvent: (listener: (event: MapTestEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, event: MapTestEvent) => {
      if (event?.kind === 'preview') withValidatedExecutionCost(event.preview);
      if (
        event?.kind === 'progress' &&
        (typeof event.executionId !== 'string' ||
          !isMapTestProgressCounts(event.completed, event.requested))
      ) {
        return;
      }
      listener(event);
    };
    ipcRenderer.on(ipcChannels.mapTestEvent, handler);
    return () => ipcRenderer.removeListener(ipcChannels.mapTestEvent, handler);
  },
  exportMapTestReport: (reportJson: string) =>
    ipcRenderer.invoke(
      ipcChannels.mapTestReportExport,
      assertBoundedString(reportJson, 'map-test report', 16 * 1024 * 1024),
    ),
  importMapTestReport: () => ipcRenderer.invoke(ipcChannels.mapTestReportImport),
  onExecutionState: (listener: (state: RootExecutionState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: RootExecutionState) =>
      listener(state);
    ipcRenderer.on(ipcChannels.executionState, handler);
    return () => ipcRenderer.removeListener(ipcChannels.executionState, handler);
  },
  getDevelopmentFixtures: () => ipcRenderer.invoke(ipcChannels.developmentFixtures),
  runDevelopmentFixture: (request: DevelopmentFixtureRequest) =>
    ipcRenderer
      .invoke(ipcChannels.runDevelopmentFixture, assertDevelopmentFixtureRequest(request))
      .then(unwrapPreviewGenerationSettlement),
  onPreviewGenerationEvent: (listener: (event: PreviewGenerationEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, event: PreviewGenerationEvent) =>
      listener(assertPreviewGenerationEvent(event));
    ipcRenderer.on(ipcChannels.previewGenerationEvent, handler);
    return () => ipcRenderer.removeListener(ipcChannels.previewGenerationEvent, handler);
  },
  onPreviewExecutionProgress: (listener: (event: ExecutionProgressEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, event: unknown) => {
      let progress: ExecutionProgressEvent;
      try {
        progress = validateExecutionProgressEvent(event);
      } catch {
        return;
      }
      listener(progress);
    };
    ipcRenderer.on(ipcChannels.previewExecutionProgress, handler);
    return () => ipcRenderer.removeListener(ipcChannels.previewExecutionProgress, handler);
  },
  onPreviewCandidate: (listener: (candidate: PreviewCandidate) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) => {
      let candidate: PreviewCandidate;
      try {
        candidate = validatePreviewCandidate(value);
      } catch {
        const named = value as Partial<PreviewCandidate> | null;
        try {
          ipcRenderer.send(
            ipcChannels.previewCandidateAcknowledge,
            validatePreviewCandidateAcknowledgement({
              requestId: named?.requestId,
              revision: named?.revision,
              accepted: false,
            }),
          );
        } catch {}
        return;
      }
      listener(candidate);
    };
    ipcRenderer.on(ipcChannels.previewCandidate, handler);
    return () => ipcRenderer.removeListener(ipcChannels.previewCandidate, handler);
  },
  acknowledgePreviewCandidate: (acknowledgement: PreviewCandidateAcknowledgement) =>
    ipcRenderer.send(
      ipcChannels.previewCandidateAcknowledge,
      validatePreviewCandidateAcknowledgement(acknowledgement),
    ),
  discoverInstallations: () => ipcRenderer.invoke(ipcChannels.discoverInstallations),
  pickManualInstallation: () => ipcRenderer.invoke(ipcChannels.pickManualInstallation),
  getRememberedInstallationSelection: () =>
    ipcRenderer.invoke(ipcChannels.rememberedInstallationSelection),
  rememberInstallationSelection: (selection: RememberedInstallationSelection) =>
    ipcRenderer.invoke(
      ipcChannels.rememberInstallationSelection,
      assertInstallationSelection(selection),
    ),
  forgetRememberedInstallationSelection: () =>
    ipcRenderer.invoke(ipcChannels.forgetInstallationSelection),
  selectLanguageGameVersion: async (
    profileId: string | null,
    versionOrigin: PreviewVersionOrigin = 'packaged',
  ) => {
    if (
      profileId !== null &&
      (typeof profileId !== 'string' || !/^[A-Za-z0-9._-]{1,256}$/u.test(profileId))
    ) {
      throw new TypeError('language game version is invalid');
    }
    if (versionOrigin !== 'packaged' && versionOrigin !== 'local') {
      throw new TypeError('language game version origin is invalid');
    }
    await ipcRenderer.invoke(ipcChannels.languageGameVersion, profileId, versionOrigin);
  },
  getStandardIncludeAccess: async (versionOrigin: PreviewVersionOrigin) => {
    if (versionOrigin !== 'packaged' && versionOrigin !== 'local') {
      throw new TypeError('preview version origin is invalid');
    }
    const access: unknown = await ipcRenderer.invoke(
      ipcChannels.standardIncludeAccess,
      versionOrigin,
    );
    if (
      access !== 'authorized' &&
      access !== 'no-linked-installation' &&
      access !== 'missing-gamedata' &&
      access !== 'packaged-selection'
    ) {
      throw new TypeError('standard include access is invalid');
    }
    return access;
  },
  getLocalPresentationNames: async () =>
    validateLocalPresentationNames(await ipcRenderer.invoke(ipcChannels.localPresentationNames)),
  getGameArtStatus: async () =>
    validateGameArtStatus(await ipcRenderer.invoke(ipcChannels.gameArtStatus)),
  prepareGameArt: async () =>
    validateGameArtStatus(await ipcRenderer.invoke(ipcChannels.gameArtPrepare)),
  cancelGameArt: async () => {
    await ipcRenderer.invoke(ipcChannels.gameArtCancel);
  },
  getGameArtTerrain: async () => {
    const index: unknown = await ipcRenderer.invoke(ipcChannels.gameArtTerrain);
    return index === null ? null : validateGameArtTerrainIndex(index);
  },
  getGameArtSprites: async (objects: GameArtSpriteRequestObject[]) => {
    const set: unknown = await ipcRenderer.invoke(
      ipcChannels.gameArtSprites,
      validateGameArtSpriteRequest(objects),
    );
    return set === null ? null : validateGameArtSpriteSet(set);
  },
  getGameArtImages: async (keys: string[]) =>
    validateGameArtImages(
      await ipcRenderer.invoke(ipcChannels.gameArtImages, validateGameArtImageKeys(keys)),
    ),
  onGameArtStatus: (listener: (status: GameArtStatus) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: unknown) => {
      let validated: GameArtStatus;
      try {
        validated = validateGameArtStatus(status);
      } catch {
        return;
      }
      listener(validated);
    };
    ipcRenderer.on(ipcChannels.gameArtEvent, handler);
    return () => ipcRenderer.removeListener(ipcChannels.gameArtEvent, handler);
  },
  onGameTexturesFirstLink: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on(ipcChannels.gameTexturesFirstLink, handler);
    return () => ipcRenderer.removeListener(ipcChannels.gameTexturesFirstLink, handler);
  },
  discoverInstalledSources: () => ipcRenderer.invoke(ipcChannels.installedSourcesDiscover),
  openInstalledSource: (sourceId: string) =>
    ipcRenderer.invoke(ipcChannels.installedSourcesOpen, assertInstalledSourceId(sourceId)),
  cloneInstalledSource: (sourceId: string) =>
    ipcRenderer.invoke(ipcChannels.installedSourcesClone, assertInstalledSourceId(sourceId)),
  selectInstalledProfile: (installationId: string, profileId: string) =>
    ipcRenderer.invoke(
      ipcChannels.installedSourcesSelectProfile,
      assertBoundedString(installationId, 'installation identity', 80),
      assertBoundedString(profileId, 'profile identity', 20),
    ),
  previewManagedDeployment: (request: ManagedDeploymentRequest) =>
    ipcRenderer.invoke(
      ipcChannels.managedDeploymentPreview,
      assertManagedDeploymentRequest(request),
    ),
  applyManagedDeployment: (request: ManagedDeploymentApplyRequest) =>
    ipcRenderer.invoke(
      ipcChannels.managedDeploymentApply,
      assertManagedDeploymentApplyRequest(request),
    ),
  getManualDeploymentContext: (documentUri: string) =>
    ipcRenderer.invoke(
      ipcChannels.manualDeploymentContext,
      assertBoundedString(documentUri, 'authored entry identity', 4096),
    ),
  previewManualDeployment: (request: ManualDeploymentPreviewRequest) =>
    ipcRenderer.invoke(
      ipcChannels.manualDeploymentPreview,
      assertManualDeploymentPreviewRequest(request),
    ),
  applyManualDeployment: (request: ManualDeploymentApplyRequest) =>
    ipcRenderer.invoke(
      ipcChannels.manualDeploymentApply,
      assertManualDeploymentApplyRequest(request),
    ),
  openDeployedModFolder: () => ipcRenderer.invoke(ipcChannels.manualDeploymentOpenFolder),
  openDeploymentTargetFolder: (profileId: string) => {
    if (!isDeploymentProfileId(profileId)) throw new Error('deployment profile is invalid');
    return ipcRenderer.invoke(ipcChannels.manualDeploymentOpenTargetFolder, profileId);
  },
  readManualDeploymentMapIcon: async (token: string) =>
    assertManualDeploymentMapIconImage(
      await ipcRenderer.invoke(
        ipcChannels.manualDeploymentMapIconRead,
        assertManualDeploymentPreviewToken(token),
      ),
    ),
  saveManualDeploymentMapIcon: (token: string) =>
    ipcRenderer.invoke(
      ipcChannels.manualDeploymentMapIconSave,
      assertManualDeploymentPreviewToken(token),
    ),
  saveGeneratedMapIcon: (request: GeneratedMapIconSaveRequest) =>
    ipcRenderer.invoke(
      ipcChannels.mapIconGeneratedSave,
      validateGeneratedMapIconSaveRequest(request),
    ),
  getMapIconRenderInput: async () => ({
    ...validateMapIconRenderInput(await ipcRenderer.invoke(ipcChannels.mapIconRenderInputGet)),
  }),
  generateMapIconSource: (request: MapIconSourceRequest) =>
    ipcRenderer
      .invoke(ipcChannels.mapIconSourceGenerate, validateMapIconSourceRequest(request))
      .then(unwrapPreviewGenerationSettlement),
  cancelMapIconSource: (clientRequestId: string) => {
    if (!validMapIconSourceRequestId(clientRequestId)) {
      return Promise.reject(new Error('map icon generation request identity is invalid'));
    }
    return ipcRenderer.invoke(ipcChannels.mapIconSourceCancel, clientRequestId);
  },
  onMapIconExecutionProgress: (listener: (event: ExecutionProgressEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, event: unknown) => {
      let progress: ExecutionProgressEvent;
      try {
        progress = validateExecutionProgressEvent(event);
        if (!validMapIconSourceRequestId(progress.requestId)) return;
      } catch {
        return;
      }
      listener(progress);
    };
    ipcRenderer.on(ipcChannels.mapIconExecutionProgress, handler);
    return () => ipcRenderer.removeListener(ipcChannels.mapIconExecutionProgress, handler);
  },
  setMapIconRenderInput: (input: MapIconRenderInput) =>
    ipcRenderer.invoke(ipcChannels.mapIconRenderInputSet, validateMapIconRenderInput(input)),
  getControlLauncherStatus: () => ipcRenderer.invoke(ipcChannels.controlLauncherStatus),
  selectControlLauncher: () => ipcRenderer.invoke(ipcChannels.controlLauncherSelect),
  forgetControlLauncher: () => ipcRenderer.invoke(ipcChannels.controlLauncherForget),
  getControlSessionStatus: () => ipcRenderer.invoke(ipcChannels.controlSessionStatus),
  connectControlSession: (purpose: ControlConnectPurpose) =>
    ipcRenderer.invoke(ipcChannels.controlSessionConnect, assertControlConnectPurpose(purpose)),
  disconnectControlSession: () => ipcRenderer.invoke(ipcChannels.controlSessionDisconnect),
  onControlSessionEvent: (listener: (event: ControlSessionEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, event: ControlSessionEvent) =>
      listener(assertControlSessionEvent(event));
    ipcRenderer.on(ipcChannels.controlSessionEvent, handler);
    return () => ipcRenderer.removeListener(ipcChannels.controlSessionEvent, handler);
  },
  runControlLiveTest: (request: ControlLiveSynchronizationRequest) =>
    ipcRenderer.invoke(
      ipcChannels.controlLiveSynchronize,
      assertControlLiveSynchronizationRequest(request),
    ),
  cancelControlLiveTest: (requestId: string) =>
    ipcRenderer.invoke(
      ipcChannels.controlLiveCancel,
      assertBoundedString(requestId, 'live-test request identifier', 96),
    ),
  onControlLiveEvent: (listener: (event: ControlLiveWorkflowEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, event: ControlLiveWorkflowEvent) =>
      listener(assertControlLiveWorkflowEvent(event));
    ipcRenderer.on(ipcChannels.controlLiveEvent, handler);
    return () => ipcRenderer.removeListener(ipcChannels.controlLiveEvent, handler);
  },
  onNativeEvent: (listener: (status: NativeProcessStatus) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: NativeProcessStatus) =>
      listener(status);
    ipcRenderer.on(ipcChannels.nativeEvent, handler);
    return () => ipcRenderer.removeListener(ipcChannels.nativeEvent, handler);
  },
  disableRmsLintRule: (code: string) => {
    if (!isRmsLintCode(code)) {
      return Promise.reject(new Error('the code is not an RMS lint rule'));
    }
    return ipcRenderer.invoke(ipcChannels.disableRmsLintRule, code);
  },
  requestLanguageServer: (method: LanguageServerRequestMethod, params: unknown) =>
    ipcRenderer.invoke(
      ipcChannels.languageServerRequest,
      assertLanguageServerRequestMethod(method),
      assertLanguageServerPayload(params),
    ),
  notifyLanguageServer: (method: LanguageServerNotificationMethod, params: unknown) =>
    ipcRenderer.invoke(
      ipcChannels.languageServerNotification,
      assertLanguageServerNotificationMethod(method),
      assertLanguageServerPayload(params),
    ),
  onLanguageServerEvent: (listener: (event: LanguageServerEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, event: LanguageServerEvent) =>
      listener(event);
    ipcRenderer.on(ipcChannels.languageServerEvent, handler);
    return () => ipcRenderer.removeListener(ipcChannels.languageServerEvent, handler);
  },
  openApplicationMenu: (name: ApplicationMenuName, x: number, y: number) =>
    ipcRenderer.invoke(
      ipcChannels.openApplicationMenu,
      assertApplicationMenuName(name),
      assertMenuCoordinate(x),
      assertMenuCoordinate(y),
    ),
  openExternalLink: (target: ExternalLinkTarget) =>
    ipcRenderer.invoke(ipcChannels.openExternalLink, assertExternalLinkTarget(target)),
  pasteIntoEditor: () => ipcRenderer.invoke(ipcChannels.editorPaste),
  openDocumentLink: (url: string) =>
    ipcRenderer.invoke(
      ipcChannels.openDocumentLink,
      assertBoundedString(url, 'document link', 2048),
    ),
  syncApplicationMenuBounds: (bounds: ApplicationMenuTriggerBounds[]) =>
    ipcRenderer.invoke(ipcChannels.syncApplicationMenuBounds, assertApplicationMenuBounds(bounds)),
  syncMapTestResultsVisibility: (visible: boolean) =>
    ipcRenderer.invoke(ipcChannels.syncMapTestResultsVisibility, assertBoolean(visible)),
  syncMapTestPreviewShown: (shown: boolean) =>
    ipcRenderer.invoke(ipcChannels.syncMapTestPreviewShown, assertBoolean(shown)),
  syncModalSurfaceOpen: (open: boolean) =>
    ipcRenderer.invoke(ipcChannels.syncModalSurfaceOpen, assertBoolean(open)),
  syncNativeTheme: (preference: ThemePreference, resolved: ResolvedTheme) =>
    ipcRenderer.invoke(
      ipcChannels.syncNativeTheme,
      assertThemePreference(preference),
      assertResolvedTheme(resolved),
    ),
  getLocaleState: async (): Promise<LocaleState> => {
    const state = validateLocaleState(await ipcRenderer.invoke(ipcChannels.localeState));
    if (!state) throw new Error('locale state is invalid');
    return state;
  },
  setLanguagePreference: async (preference: LanguagePreference): Promise<LocaleState> => {
    if (!isLanguagePreference(preference)) throw new Error('language preference is invalid');
    const state = validateLocaleState(
      await ipcRenderer.invoke(ipcChannels.setLanguagePreference, preference),
    );
    if (!state) throw new Error('locale state is invalid');
    return state;
  },
  onLocaleChanged: (listener: (state: LocaleState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: unknown) => {
      const validated = validateLocaleState(state);
      if (validated) listener(validated);
    };
    ipcRenderer.on(ipcChannels.localeChanged, handler);
    return () => ipcRenderer.removeListener(ipcChannels.localeChanged, handler);
  },
  onApplicationMenuAction: (listener: (action: ApplicationMenuAction) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, action: ApplicationMenuAction) =>
      listener(action);
    ipcRenderer.on(ipcChannels.menuAction, handler);
    return () => ipcRenderer.removeListener(ipcChannels.menuAction, handler);
  },
  pickFiles: () => ipcRenderer.invoke(ipcChannels.workspacePickFiles),
  pickFolder: () => ipcRenderer.invoke(ipcChannels.workspacePickFolder),
  openDroppedFiles: (files: File[]) => {
    if (!Array.isArray(files) || files.length < 1 || files.length > 64) {
      throw new Error('drop must contain 1 to 64 files');
    }
    const paths = files.map((file) => assertPath(webUtils.getPathForFile(file)));
    return ipcRenderer.invoke(ipcChannels.workspaceOpenPaths, paths);
  },
  openWorkspaceFile: (path: string) =>
    ipcRenderer.invoke(ipcChannels.workspaceOpenFile, assertPath(path)),
  openWorkspaceSource: (sourceId: string) =>
    ipcRenderer.invoke(
      ipcChannels.workspaceOpenSource,
      assertBoundedString(sourceId, 'source identity', 4096),
    ),
  openRecent: (path: string) =>
    ipcRenderer.invoke(ipcChannels.workspaceOpenRecent, assertPath(path)),
  takeShellOpenRequest: () => ipcRenderer.invoke(ipcChannels.shellOpenTake),
  onShellOpenPending: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on(ipcChannels.shellOpenPending, handler);
    return () => ipcRenderer.removeListener(ipcChannels.shellOpenPending, handler);
  },
  readDirectory: (entryId: string) =>
    ipcRenderer.invoke(ipcChannels.workspaceReadDirectory, assertEntryId(entryId)),
  openWorkspaceFolderInExplorer: (entryId: string) =>
    ipcRenderer.invoke(ipcChannels.workspaceOpenFolderInExplorer, assertEntryId(entryId)),
  searchWorkspace: (query: string) =>
    ipcRenderer.invoke(
      ipcChannels.workspaceSearch,
      assertBoundedString(query, 'workspace search query', 256),
    ),
  cancelWorkspaceSearch: () => ipcRenderer.invoke(ipcChannels.workspaceCancelSearch),
  closeWorkspace: () => ipcRenderer.invoke(ipcChannels.workspaceClose),
  createWorkspaceEntry: (request: WorkspaceCreateRequest) =>
    ipcRenderer.invoke(ipcChannels.workspaceCreate, assertCreateRequest(request)),
  prepareDefinitionFile: (request: DefinitionFilePrepareRequest) =>
    ipcRenderer.invoke(
      ipcChannels.definitionFilePrepare,
      assertDefinitionFilePrepareRequest(request),
    ),
  generateDefinitionFile: (request: DefinitionFileGenerateRequest) =>
    ipcRenderer.invoke(
      ipcChannels.definitionFileGenerate,
      assertDefinitionFileGenerateRequest(request),
    ),
  renameWorkspaceEntry: (request: WorkspaceRenameRequest) =>
    ipcRenderer.invoke(ipcChannels.workspaceRename, assertRenameRequest(request)),
  deleteWorkspaceEntry: (request: WorkspaceDeleteRequest) =>
    ipcRenderer.invoke(ipcChannels.workspaceDelete, assertDeleteRequest(request)),
  saveFile: (request: WorkspaceSaveRequest) =>
    ipcRenderer.invoke(ipcChannels.workspaceSave, assertSaveRequest(request)),
  saveFileAs: (request: WorkspaceSaveAsRequest) =>
    ipcRenderer.invoke(ipcChannels.workspaceSaveAs, assertSaveAsRequest(request)),
  recentEntries: () => ipcRenderer.invoke(ipcChannels.workspaceRecent),
  readRecovery: () => ipcRenderer.invoke(ipcChannels.recoveryRead),
  writeRecovery: (snapshot: RecoverySnapshot) =>
    ipcRenderer.invoke(ipcChannels.recoveryWrite, assertRecoverySnapshot(snapshot)),
  clearRecovery: () => ipcRenderer.invoke(ipcChannels.recoveryClear),
  onWindowCloseRequested: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on(ipcChannels.windowCloseRequested, handler);
    return () => ipcRenderer.removeListener(ipcChannels.windowCloseRequested, handler);
  },
  onWorkspaceExternalChange: (listener: (change: WorkspaceExternalChange) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, change: WorkspaceExternalChange) =>
      listener(change);
    ipcRenderer.on(ipcChannels.workspaceExternalChange, handler);
    return () => ipcRenderer.removeListener(ipcChannels.workspaceExternalChange, handler);
  },
  onWorkspaceDiagnostic: (listener: (message: OutputMessage) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, message: unknown) => {
      const validated = validateOutputMessage(message);
      if (validated) listener(validated);
    };
    ipcRenderer.on(ipcChannels.workspaceDiagnostic, handler);
    return () => ipcRenderer.removeListener(ipcChannels.workspaceDiagnostic, handler);
  },
  respondToWindowClose: (allow: boolean) =>
    ipcRenderer.invoke(ipcChannels.windowCloseResponse, assertBoolean(allow)),
  takeReleaseNotice: async () =>
    validateOutputMessage(await ipcRenderer.invoke(ipcChannels.releaseNoticeTake)),
});

contextBridge.exposeInMainWorld('rmside', api);
