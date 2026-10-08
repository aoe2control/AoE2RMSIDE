import type { OutputMessage, OutputWords } from './output-message';
import type { ExternalLinkTarget } from './external-links';
import type { GameModeModifier } from './lobby-options';
import type { ConstructVerification } from './construct-verification';
import type { PreviewConnectionRoutesPayload } from './connection-routes';
import type { ExecutionCostSummary, ExecutionProgressEvent } from './execution-cost';
import type { PreviewCandidate, PreviewCandidateAcknowledgement } from './preview-candidate';
import type { RmsLintWorkspaceRules } from './rms-lint-rules';
import type { LanguagePreference, LocaleState } from './i18n/locale';
import type {
  DefinitionCandidates,
  DefinitionFileIdentities,
  DefinitionGroupId,
  ProjectDefinitionFile,
} from './definition-file';
import type {
  GameArtImage,
  GameArtSpriteRequestObject,
  GameArtSpriteSet,
  GameArtStatus,
  GameArtTerrainIndex,
  PreviewLook,
  PreviewPerspective,
} from './game-art';

export const ipcChannels = {
  getDesktopSession: 'rmside:desktop-session:get',
  saveDesktopSession: 'rmside:desktop-session:save',
  resetLayout: 'rmside:layout:reset',
  nativeStatus: 'rmside:native:status',
  restartNative: 'rmside:native:restart',
  configurationCatalog: 'rmside:generation:catalog',
  generatePreview: 'rmside:generation:run',
  cancelPreviewGeneration: 'rmside:generation:cancel',
  executionState: 'rmside:execution:state',
  executionStop: 'rmside:execution:stop',
  mapTestRun: 'rmside:map-test:run',
  mapTestReplay: 'rmside:map-test:replay',
  mapTestEvent: 'rmside:map-test:event',
  mapTestReportExport: 'rmside:map-test:report-export',
  mapTestReportImport: 'rmside:map-test:report-import',
  developmentFixtures: 'rmside:generation:development-fixtures',
  runDevelopmentFixture: 'rmside:generation:run-development-fixture',
  previewGenerationEvent: 'rmside:generation:event',
  previewExecutionProgress: 'rmside:generation:execution-progress',
  previewCandidate: 'rmside:generation:candidate',
  previewCandidateAcknowledge: 'rmside:generation:candidate-ack',
  discoverInstallations: 'rmside:installations:discover',
  pickManualInstallation: 'rmside:installations:pick-manual',
  rememberedInstallationSelection: 'rmside:installations:remembered-selection',
  rememberInstallationSelection: 'rmside:installations:remember-selection',
  forgetInstallationSelection: 'rmside:installations:forget-selection',
  standardIncludeAccess: 'rmside:installations:standard-include-access',
  localPresentationNames: 'rmside:installations:local-presentation-names',
  disableRmsLintRule: 'rmside:rms-lint:disable-rule',
  installedSourcesDiscover: 'rmside:installed-sources:discover',
  installedSourcesOpen: 'rmside:installed-sources:open',
  installedSourcesClone: 'rmside:installed-sources:clone',
  installedSourcesSelectProfile: 'rmside:installed-sources:select-profile',
  managedDeploymentPreview: 'rmside:deployment:preview',
  managedDeploymentApply: 'rmside:deployment:apply',
  manualDeploymentContext: 'rmside:manual-deployment:context',
  manualDeploymentPreview: 'rmside:manual-deployment:preview',
  manualDeploymentApply: 'rmside:manual-deployment:apply',
  manualDeploymentOpenFolder: 'rmside:manual-deployment:open-folder',
  manualDeploymentOpenTargetFolder: 'rmside:manual-deployment:open-target-folder',
  manualDeploymentMapIconRead: 'rmside:manual-deployment:map-icon-read',
  manualDeploymentMapIconSave: 'rmside:manual-deployment:map-icon-save',
  mapIconGeneratedSave: 'rmside:map-icon:generated-save',
  mapIconRenderInputGet: 'rmside:map-icon:render-input-get',
  mapIconRenderInputSet: 'rmside:map-icon:render-input-set',
  mapIconSourceGenerate: 'rmside:map-icon:source-generate',
  mapIconSourceCancel: 'rmside:map-icon:source-cancel',
  mapIconExecutionProgress: 'rmside:map-icon:execution-progress',
  controlLauncherStatus: 'rmside:control-launcher:status',
  controlLauncherSelect: 'rmside:control-launcher:select',
  controlLauncherForget: 'rmside:control-launcher:forget',
  controlSessionStatus: 'rmside:control-session:status',
  controlSessionConnect: 'rmside:control-session:connect',
  controlSessionDisconnect: 'rmside:control-session:disconnect',
  controlSessionEvent: 'rmside:control-session:event',
  controlLiveSynchronize: 'rmside:control-live:synchronize',
  controlLiveCancel: 'rmside:control-live:cancel',
  controlLiveEvent: 'rmside:control-live:event',
  nativeEvent: 'rmside:native:event',
  languageServerRequest: 'rmside:language-server:request',
  languageServerNotification: 'rmside:language-server:notification',
  languageServerEvent: 'rmside:language-server:event',
  languageGameVersion: 'rmside:language:game-version',
  openApplicationMenu: 'rmside:menu:open',
  openExternalLink: 'rmside:external-link:open',
  openDocumentLink: 'rmside:document-link:open',
  editorPaste: 'rmside:editor:paste',
  syncApplicationMenuBounds: 'rmside:menu:sync-bounds',
  syncMapTestResultsVisibility: 'rmside:map-test:results-visibility',
  syncMapTestPreviewShown: 'rmside:map-test:preview-shown',
  syncModalSurfaceOpen: 'rmside:modal:sync-open',
  menuAction: 'rmside:menu:action',
  syncNativeTheme: 'rmside:theme:sync-native',
  localeState: 'rmside:locale:state',
  setLanguagePreference: 'rmside:locale:set-preference',
  localeChanged: 'rmside:locale:changed',
  workspacePickFiles: 'rmside:workspace:pick-files',
  workspacePickFolder: 'rmside:workspace:pick-folder',
  workspaceOpenPaths: 'rmside:workspace:open-paths',
  workspaceOpenFile: 'rmside:workspace:open-file',
  workspaceOpenSource: 'rmside:workspace:open-source',
  workspaceOpenRecent: 'rmside:workspace:open-recent',
  shellOpenTake: 'rmside:shell-open:take',
  shellOpenPending: 'rmside:shell-open:pending',
  workspaceReadDirectory: 'rmside:workspace:read-directory',
  workspaceOpenFolderInExplorer: 'rmside:workspace:open-folder-in-explorer',
  workspaceSearch: 'rmside:workspace:search',
  workspaceCancelSearch: 'rmside:workspace:cancel-search',
  workspaceClose: 'rmside:workspace:close',
  workspaceCreate: 'rmside:workspace:create',
  definitionFilePrepare: 'rmside:definition-file:prepare',
  definitionFileGenerate: 'rmside:definition-file:generate',
  workspaceRename: 'rmside:workspace:rename',
  workspaceDelete: 'rmside:workspace:delete',
  workspaceSave: 'rmside:workspace:save',
  workspaceSaveAs: 'rmside:workspace:save-as',
  workspaceRecent: 'rmside:workspace:recent',
  workspaceExternalChange: 'rmside:workspace:external-change',
  workspaceDiagnostic: 'rmside:workspace:diagnostic',
  releaseNoticeTake: 'rmside:release-notice:take',
  recoveryRead: 'rmside:recovery:read',
  recoveryWrite: 'rmside:recovery:write',
  recoveryClear: 'rmside:recovery:clear',
  windowCloseRequested: 'rmside:window:close-requested',
  windowCloseResponse: 'rmside:window:close-response',
  gameArtStatus: 'rmside:game-art:status',
  gameArtPrepare: 'rmside:game-art:prepare',
  gameArtCancel: 'rmside:game-art:cancel',
  gameArtTerrain: 'rmside:game-art:terrain',
  gameArtSprites: 'rmside:game-art:sprites',
  gameArtImages: 'rmside:game-art:images',
  gameArtEvent: 'rmside:game-art:event',
  gameTexturesFirstLink: 'rmside:game-art:first-link',
} as const;

export type NativeProcessName = 'rmsd' | 'rms-ls' | 'rms-test' | 'rms-test-lsp';
export type NativeProcessState = 'stopped' | 'starting' | 'running' | 'failed';
export type ApplicationMenuName = 'file' | 'edit' | 'view' | 'help';
export type { ExternalLinkTarget } from './external-links';

export const mapIconRenderContract = {
  version: 10,
  size: 512,
  identityDomain: 'rmside-map-icon-render',
} as const;

export type MapIconRenderContract = typeof mapIconRenderContract;

export interface MapIconRenderInput {
  perspective: MapIconPerspective;
  look: MapIconRenderLook;
  relief: boolean;
  terrainSmoothing: boolean;
  spawnMarkers: MapIconSpawnMarkerStyle;
  spawnMarkerSizePercent: number;
  trees: boolean;
  treeDensity: number;
  treeSize: number;
  treeSpawnOverlap: boolean;
  resources: boolean;
  resourceDensity: number;
  resourceSize: number;
  resourceSpawnOverlap: boolean;
}

export type MapIconSpawnMarkerStyle = 'hidden' | 'player-squares' | 'nomad-feet';

export const mapIconSpawnMarkerStyles: readonly MapIconSpawnMarkerStyle[] = Object.freeze([
  'player-squares',
  'nomad-feet',
  'hidden',
]);

export function isMapIconSpawnMarkerStyle(value: unknown): value is MapIconSpawnMarkerStyle {
  return mapIconSpawnMarkerStyles.includes(value as MapIconSpawnMarkerStyle);
}

export function migrateMapIconSpawnMarkersV9(spawnMarkers: boolean): MapIconSpawnMarkerStyle {
  return spawnMarkers ? 'player-squares' : 'hidden';
}

export type MapIconArtLayer = 'trees' | 'resources';

export const mapIconArtDensity = Object.freeze({
  minimum: 0,
  maximum: 16,
  step: 1,
  default: 10,
});

export const mapIconArtMergeDensities = 6;

export function migrateMapIconArtDensityV8(density: number): number {
  return density + mapIconArtMergeDensities;
}

export function isMapIconArtDensityV8(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10;
}

export const mapIconArtSize = Object.freeze({
  minimum: 0,
  maximum: 8,
  step: 1,
  default: 4,
});

export const mapIconArtSizePercents: readonly number[] = Object.freeze([
  50, 60, 70, 85, 100, 120, 140, 170, 200,
]);

export function isMapIconArtSize(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= mapIconArtSize.minimum &&
    value <= mapIconArtSize.maximum
  );
}

export function isMapIconArtDensity(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= mapIconArtDensity.minimum &&
    value <= mapIconArtDensity.maximum
  );
}

export type MapIconPerspective = 'top-down' | 'diamond';

export const mapIconPerspectives: readonly MapIconPerspective[] = Object.freeze([
  'top-down',
  'diamond',
]);

export type MapIconRenderLook = 'minimap' | 'texture-colors' | 'game-textures';

export const mapIconRenderLooks: readonly MapIconRenderLook[] = Object.freeze([
  'minimap',
  'texture-colors',
  'game-textures',
]);

export const mapIconGameTexturesSourcePattern = /^[0-9a-f]{8,64}$/u;

export const mapIconSpawnMarkerSizePercent = Object.freeze({
  minimum: 5,
  maximum: 13,
  step: 1,
  default: 10,
});

export const defaultMapIconRenderInput: Readonly<MapIconRenderInput> = Object.freeze({
  perspective: 'top-down',
  look: 'texture-colors',
  relief: true,
  terrainSmoothing: true,
  spawnMarkers: 'player-squares',
  spawnMarkerSizePercent: mapIconSpawnMarkerSizePercent.default,
  trees: true,
  treeDensity: mapIconArtDensity.default,
  treeSize: mapIconArtSize.default,
  treeSpawnOverlap: false,
  resources: true,
  resourceDensity: mapIconArtDensity.default,
  resourceSize: mapIconArtSize.default,
  resourceSpawnOverlap: false,
});

export const mapIconRenderInputKeys: readonly (keyof MapIconRenderInput)[] = Object.freeze([
  'perspective',
  'look',
  'relief',
  'terrainSmoothing',
  'spawnMarkers',
  'spawnMarkerSizePercent',
  'trees',
  'treeDensity',
  'treeSize',
  'treeSpawnOverlap',
  'resources',
  'resourceDensity',
  'resourceSize',
  'resourceSpawnOverlap',
]);

export function isMapIconSpawnMarkerSizePercent(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= mapIconSpawnMarkerSizePercent.minimum &&
    value <= mapIconSpawnMarkerSizePercent.maximum
  );
}

export function validateMapIconRenderInput(value: unknown): Readonly<MapIconRenderInput> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('map icon render input is invalid');
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => !mapIconRenderInputKeys.includes(key as keyof MapIconRenderInput),
    )
  ) {
    throw new Error('map icon render input is invalid');
  }
  if (!mapIconPerspectives.includes(record.perspective as MapIconPerspective)) {
    throw new Error('map icon perspective is invalid');
  }
  if (!mapIconRenderLooks.includes(record.look as MapIconRenderLook)) {
    throw new Error('map icon look is invalid');
  }
  if (typeof record.relief !== 'boolean') throw new Error('map icon relief choice is invalid');
  if (typeof record.terrainSmoothing !== 'boolean') {
    throw new Error('map icon terrain smoothing choice is invalid');
  }
  if (!isMapIconSpawnMarkerStyle(record.spawnMarkers)) {
    throw new Error('map icon spawn marker choice is invalid');
  }
  if (!isMapIconSpawnMarkerSizePercent(record.spawnMarkerSizePercent)) {
    throw new Error('map icon spawn marker size is invalid');
  }
  for (const key of ['trees', 'treeSpawnOverlap', 'resources', 'resourceSpawnOverlap'] as const) {
    if (typeof record[key] !== 'boolean') throw new Error(`map icon ${key} choice is invalid`);
  }
  for (const key of ['treeDensity', 'resourceDensity'] as const) {
    if (!isMapIconArtDensity(record[key])) throw new Error(`map icon ${key} is invalid`);
  }
  for (const key of ['treeSize', 'resourceSize'] as const) {
    if (!isMapIconArtSize(record[key])) throw new Error(`map icon ${key} is invalid`);
  }
  return Object.freeze({
    perspective: record.perspective as MapIconPerspective,
    look: record.look as MapIconRenderLook,
    relief: record.relief,
    terrainSmoothing: record.terrainSmoothing,
    spawnMarkers: record.spawnMarkers,
    spawnMarkerSizePercent: record.spawnMarkerSizePercent,
    trees: record.trees as boolean,
    treeDensity: record.treeDensity as number,
    treeSize: record.treeSize as number,
    treeSpawnOverlap: record.treeSpawnOverlap as boolean,
    resources: record.resources as boolean,
    resourceDensity: record.resourceDensity as number,
    resourceSize: record.resourceSize as number,
    resourceSpawnOverlap: record.resourceSpawnOverlap as boolean,
  });
}

export function mapIconIdentityPrefix(
  sourceSemanticHash: string,
  input: MapIconRenderInput,
  gameTexturesSource?: string,
): string {
  if (
    input.look === 'game-textures'
      ? gameTexturesSource === undefined ||
        !mapIconGameTexturesSourcePattern.test(gameTexturesSource)
      : gameTexturesSource !== undefined
  ) {
    throw new Error('map icon game textures source is invalid');
  }
  const { identityDomain, size, version } = mapIconRenderContract;
  const relief = input.relief ? 'relief' : 'flat';
  const smoothing = input.terrainSmoothing ? 'smooth-terrain' : 'sharp-terrain';
  const markers =
    input.spawnMarkers === 'hidden' ? 'no-spawn-markers' : `spawn-markers-${input.spawnMarkers}`;
  const markerSize = `spawn-size-${input.spawnMarkerSizePercent}`;
  const perspective = `perspective-${input.perspective}`;
  const look =
    input.look === 'game-textures'
      ? `look-game-textures-${gameTexturesSource}`
      : `look-${input.look}`;
  const trees = `${input.trees ? 'trees' : 'no-trees'}-density-${input.treeDensity}-size-${input.treeSize}-${input.treeSpawnOverlap ? 'overlap' : 'clear'}`;
  const resources = `${input.resources ? 'resources' : 'no-resources'}-density-${input.resourceDensity}-size-${input.resourceSize}-${input.resourceSpawnOverlap ? 'overlap' : 'clear'}`;
  return `${identityDomain}\0v${version}\0${size}x${size}\0${perspective}\0${look}\0${relief}\0${smoothing}\0${markers}\0${markerSize}\0${trees}\0${resources}\0${sourceSemanticHash}\0`;
}

export { externalLinkUrls } from './external-links';
export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = Exclude<ThemePreference, 'system'>;

export type ApplicationMenuAction =
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'new-file' }
  | { type: 'new-map-test-script' }
  | { type: 'generate-definition-file' }
  | { type: 'new-xs-script' }
  | { type: 'open-file' }
  | { type: 'open-folder' }
  | { type: 'browse-installed-sources' }
  | { type: 'deploy-managed-mod' }
  | { type: 'import-map-test-report' }
  | { type: 'unlink-game-folder' }
  | { type: 'open-recent'; path: string }
  | { type: 'save' }
  | { type: 'save-as' }
  | { type: 'format-document' }
  | { type: 'set-format-on-save'; enabled: boolean }
  | { type: 'set-indent-conditionals'; enabled: boolean }
  | { type: 'set-live-generation-stages'; enabled: boolean }
  | { type: 'set-gpu-map-rendering'; enabled: boolean }
  | { type: 'set-inlay-hints'; enabled: boolean }
  | { type: 'set-delete-permanently'; enabled: boolean }
  | { type: 'close-tab' }
  | { type: 'close-folder' }
  | { type: 'reset-layout' }
  | { type: 'set-theme'; theme: ThemePreference }
  | { type: 'open-language-settings' };

export interface ApplicationMenuTriggerBounds {
  name: ApplicationMenuName;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NativeProcessStatus {
  name: NativeProcessName;
  state: NativeProcessState;
  detail?: string;
}

export type PreviewTraceLevel = 'off' | 'summary' | 'full';
export type PreviewBackend = 'synthetic' | 'exact';

export type PreviewGenerationEventKind =
  | 'generation-started'
  | 'stage-started'
  | 'delta-batch'
  | 'stage-completed'
  | 'generation-completed'
  | 'failed'
  | 'cancelled'
  | 'diagnostic';

export type PreviewMutationOperation = 'replace' | 'remove';

export interface PreviewTileMutation {
  tileIndex: number;
  terrainId: number;
  elevation: number;
  terrainZone: number;
  landId: number;
  layerId: number;
  flags: number;
  operation: PreviewMutationOperation;
  provenanceOperationIndex: number;
}

export interface PreviewObjectMutation {
  objectIndex: number;
  objectId: number;
  x256: number;
  y256: number;
  owner: number;
  facet: number;
  footprintWidth256: number;
  footprintHeight256: number;
  presentationKind: number;
  resourceType: number;
  resourceQuantityF32Bits: number;
  operation: PreviewMutationOperation;
  provenanceOperationIndex: number;
}

export interface PreviewCliffMutation {
  cliffIndex: number;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  cliffType: number;
  operation: PreviewMutationOperation;
  provenanceOperationIndex: number;
}

export interface PreviewConnectionMutation {
  connectionIndex: number;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  kind: number;
  operation: PreviewMutationOperation;
  provenanceOperationIndex: number;
}

export interface PreviewGenerationEvent {
  requestId: string;
  sequence: number;
  kind: PreviewGenerationEventKind;
  stage: string;
  completed: number;
  total: number;
  stateHash?: string;
  delta?: {
    tiles: PreviewTileMutation[];
    objects: PreviewObjectMutation[];
    cliffs: PreviewCliffMutation[];
    connections: PreviewConnectionMutation[];
  };
  initialization?: {
    width: number;
    height: number;
    backendIdentity: string;
    semanticProgramHash: string;
    requestHash: string;
    sourceCatalogRevision: number;
    sourceCatalogHash: string;
    sourceGraphHash: string;
    externalAssetHash: string;
    provenanceOperations: PreviewProvenanceOperation[];
  };
  detail?: string;
}

export interface DevelopmentFixtureDescriptor {
  id: 'representative' | 'colocated' | 'legend' | 'large' | 'delayed' | 'failure' | 'cancellable';
  label: string;
  description: string;
}

export interface DevelopmentFixtureRequest {
  fixtureId: DevelopmentFixtureDescriptor['id'];
  input: PreviewGenerationInput;
}

export interface BehaviorProfileDescriptor {
  profileId: string;
  behaviorVersion: string;
  profileHash: string;
  productVersions: string[];
  capabilities: Record<string, 'unsupported' | 'partial' | 'complete'>;
  minimapPalettes: MinimapPaletteDescriptor[];
  texturePalettes?: TexturePaletteDescriptor[];
}

export interface MinimapPaletteDescriptor {
  paletteId: string;
  productVersion: string;
  paletteHash: string;
  terrainColors: TerrainMinimapColor[];
  neutralObjectColors: NeutralObjectMinimapColor[];
  cliffColors: CliffMinimapColor[];
}

export interface TerrainMinimapColor {
  terrainId: number;
  highColor: number;
  mediumColor: number;
  lowColor: number;
}

export interface NeutralObjectMinimapColor {
  objectId: number;
  color: number;
}

export interface CliffMinimapColor {
  cliffType: number;
  leftColor: number;
  rightColor: number;
}

export interface SelectedMinimapPalette extends MinimapPaletteDescriptor {
  selection: 'exact-version' | 'latest-fallback';
}

export interface TexturePaletteDescriptor {
  paletteId: string;
  productVersion: string;
  paletteHash: string;
  terrainColors: TerrainTextureColor[];
  objectColors: ObjectTextureColor[];
  cliffColors: CliffTextureColor[];
  provenance: { tool: string; installationBuild: string; derivedOn: string };
}

export interface CliffTextureColor {
  cliffType: number;
  color: number;
}

export interface TerrainTextureColor {
  terrainId: number;
  color: number;
}

export interface ObjectTextureColor {
  objectId: number;
  color: number;
}

export interface SelectedTexturePalette extends TexturePaletteDescriptor {
  selection: 'exact-version' | 'latest-fallback';
}

export interface ContentPackDescriptor {
  packId: string;
  packVersion: string;
  contentHash: string;
  sourceFingerprint: string;
  compatibleProfileIds: string[];
  synthetic: boolean;
  objectNames: ObjectNameDescriptor[];
  implicitDefinitions: Record<string, string>;
  standardIncludes: string[];
  productVersion: string;
  packagedBundle: boolean;
  graphiclessObjectIds?: number[];
  treeObjectIds?: number[];
  goldObjectIds?: number[];
  stoneObjectIds?: number[];
}

export type MapIconArtKind = 'tree' | 'gold' | 'stone';

export interface MapIconArtObjectDescriptor {
  objectId: number;
  kind: MapIconArtKind;
  constants: string[];
}

export type PreviewVersionOrigin = 'packaged' | 'local';

export type StandardIncludeAccess =
  'authorized' | 'no-linked-installation' | 'missing-gamedata' | 'packaged-selection';

export type GenerationCertification = 'version-mapped' | 'unverified-product-version';

export interface ObjectNameDescriptor {
  objectId: number;
  name: string;
}

export interface TerrainNameDescriptor {
  terrainId: number;
  name: string;
}

export interface RmsConstantNames {
  objects: ObjectNameDescriptor[];
  terrains: TerrainNameDescriptor[];
}

export interface LocalPresentationName {
  id: number;
  displayName: string | null;
  constant: string | null;
  aliases: string[];
}

export type LocalDisplayStringStatus = 'available' | 'unsupported-dat-layout' | 'unavailable';

export interface LocalPresentationNames {
  contractVersion: Readonly<{ major: 1; minor: 2; patch: 0 }>;
  productVersion: string | null;
  productVersionVerified: boolean;
  displayStrings: LocalDisplayStringStatus;
  objects: LocalPresentationName[];
  terrains: LocalPresentationName[];
  graphiclessObjectIds: number[];
  terrainColors: TerrainMinimapColor[];
}

export interface ConfigurationCatalog {
  behaviorProfiles: BehaviorProfileDescriptor[];
  contentPacks: ContentPackDescriptor[];
}

export interface PreviewPlayerConfiguration {
  slot: number;
  team: number;
  civilizationId: number;
}

export interface PreviewGenerationInput {
  clientRequestId?: string;
  documentUri: string;
  documentRevision: number;
  source: string;
  profile: BehaviorProfileDescriptor;
  contentPack: ContentPackDescriptor;
  versionOrigin: PreviewVersionOrigin;
  backend: PreviewBackend;
  width: number;
  height: number;
  mapSize: string;
  seed: number;
  players: PreviewPlayerConfiguration[];
  modeContext: string;
  traceLevel: PreviewTraceLevel;
  minimapPalette: SelectedMinimapPalette | null;
  texturePalette?: SelectedTexturePalette | null;
  progressivePreview?: boolean;
}

export interface PreviewGenerationResult {
  backend: PreviewBackend;
  backendIdentity: string;
  playerColorIds: number[];
  playerCivilizationIds?: number[];
  presentationSeed?: number;
  objectNames: ObjectNameDescriptor[];
  graphiclessObjectIds?: number[];
  mapIconArtObjects?: MapIconArtObjectDescriptor[];
  terrainNames: TerrainNameDescriptor[];
  constantNames?: RmsConstantNames;
  minimapPalette: SelectedMinimapPalette | null;
  texturePalette?: SelectedTexturePalette | null;
  documentUri: string;
  documentRevision: number;
  semanticProgramHash: string;
  width: number;
  height: number;
  terrainIdsLe: Uint8Array;
  preConnectionTerrainIdsLe: Uint8Array;
  elevations: Uint8Array;
  terrainZonesLe: Uint8Array;
  landIdsLe: Uint8Array;
  cliffEdges: Uint8Array;
  cliffPiecesLe?: Uint8Array;
  appearanceObjectsLe?: Uint8Array;
  objects: {
    idsLe: Uint8Array;
    xLe: Uint8Array;
    yLe: Uint8Array;
    owners: Uint8Array;
    facetsLe: Uint8Array;
    footprintWidths256Le: Uint8Array;
    footprintHeights256Le: Uint8Array;
    presentationKinds: Uint8Array;
    resourceTypeLe: Uint8Array;
    resourceQuantityF32BitsLe: Uint8Array;
    resourceDeltasLe: Uint8Array;
    statusesLe: Uint8Array;
    deathStates: Uint8Array;
    dataStatusesLe: Uint8Array;
    selectionFlags: Uint8Array;
    behaviorFlagsLe: Uint8Array;
  };
  layerIdsLe: Uint8Array;
  flagsLe: Uint8Array;
  connections: {
    startXLe: Uint8Array;
    startYLe: Uint8Array;
    endXLe: Uint8Array;
    endYLe: Uint8Array;
    kinds: Uint8Array;
  };
  connectionRoutes?: PreviewConnectionRoutesPayload;
  sourceIds: string[];
  tileSourceIndicesLe: Uint8Array;
  tileByteStartsLe: Uint8Array;
  tileByteEndsLe: Uint8Array;
  provenanceOperations: PreviewProvenanceOperation[];
  provenanceStatus: 'exact' | 'remapped' | 'approximate';
  tileOperationIndicesLe: Uint8Array;
  objectOperationIndicesLe: Uint8Array;
  cliffOperationIndicesLe: Uint8Array;
  connectionOperationIndicesLe: Uint8Array;
  semanticHash: string;
  requestHash: string;
  sourceCatalogRevision: number;
  sourceCatalogHash: string;
  sourceGraphHash: string;
  externalAssetHash: string;
  resolvedRmsSourceIds: string[];
  externalAssetSourceIds: string[];
  stageHashes: { stage: string; hash: string }[];
  warnings: { code: string; message: string }[];
  metrics: Record<string, number>;
  generationEvents: PreviewGenerationEvent[];
  traceIdentity: PreviewTraceIdentity;
  certification?: GenerationCertification;
  constructVerification?: ConstructVerification;
  executionCost?: ExecutionCostSummary;
}

export type RootExecutionKind = 'rms' | 'map-test' | 'control-live' | 'map-icon';
export type RootExecutionPhase = 'idle' | 'running' | 'stopping';

export interface RootExecutionState {
  phase: RootExecutionPhase;
  executionId?: string;
  kind?: RootExecutionKind;
  label?: string;
  startedAt?: number;
}

export interface MapTestRunInput {
  executionId: string;
  scriptUri: string;
  scriptRevision: number;
  scriptName: string;
  scriptSource: string;
  workspaceName: string;
  defaultSourceUri?: string;
  defaultSourcePath?: string;
  profile: BehaviorProfileDescriptor;
  contentPack: ContentPackDescriptor;
  versionOrigin: PreviewVersionOrigin;
  width: number;
  height: number;
  mapSize: string;
  players: PreviewPlayerConfiguration[];
  modeContext: string;
  workers: 'auto' | number;
  minimapPalette: SelectedMinimapPalette | null;
  texturePalette?: SelectedTexturePalette | null;
  progressivePreview?: boolean;
}

export interface MapTestFinding {
  findingId: string;
  assertionId: string;
  code: string | null;
  message: string;
  scriptLine: number;
  scriptColumn: number;
  seed: number;
  sourcePath: string;
  sourceGraphHash: string;
  requestDocumentRevision?: string;
  requestHash: string;
  mapHash: string;
  measurements: Record<string, boolean | number | string | null>;
}

export interface MapTestReport {
  $schema: string;
  schemaVersion: '1.0.0' | '1.1.0';
  compatibility: { minimumMajor: 1; maximumMajor: 1 };
  semanticApiMajor: 2;
  reportIdentity: string;
  status: 'passed' | 'failed' | 'error' | 'cancelled';
  script: { name: string; semanticHash: string };
  workspaceName: string;
  engineVersion: string;
  protocolVersion: string;
  profile: { id: string; version: string; hash: string };
  content: { id: string; version: string; hash: string };
  settings: {
    width: number;
    height: number;
    mapSize: string;
    players: Array<{ slot: number; team: number; civilizationId: number; color: number }>;
    setupContext: {
      contractVersion: { major: 1; minor: 0; patch: 0 };
      gameMode: string;
      startingResources: string;
      startingAge: string;
      positionPolicy: string;
    };
  };
  generatedMaps: number;
  assertionCount: number;
  findings: MapTestFinding[];
  output: string[];
  preview: {
    seed: number;
    requestHash: string;
    mapHash: string;
  } | null;
}

export interface MapTestRunResult {
  status: MapTestReport['status'];
  report: MapTestReport | null;
  reportJson: string | null;
  diagnostics: LanguageServerDiagnostic[];
  preview: PreviewGenerationResult | null;
  elapsedMilliseconds: number;
}

export interface MapTestReplayInput {
  executionId: string;
  scriptUri: string;
  scriptRevision: number;
  scriptSource: string;
  report: MapTestReport;
  findingId: string;
  minimapPalette: SelectedMinimapPalette | null;
  texturePalette?: SelectedTexturePalette | null;
  versionOrigin: PreviewVersionOrigin;
}

export type MapTestEvent =
  | { kind: 'started'; executionId: string; text: string }
  | { kind: 'output'; executionId: string; ordinal: number; text: string }
  | {
      kind: 'preview';
      executionId: string;
      ordinal: number;
      preview: PreviewGenerationResult;
    }
  | { kind: 'progress'; executionId: string; completed: number; requested: number }
  | { kind: 'completed'; executionId: string; text: string };

export interface ImportedMapTestReport {
  report: MapTestReport;
  reportJson: string;
}

export interface PreviewTraceIdentity {
  profileId: string;
  profileHash: string;
  contentPackId: string;
  contentPackVersion: string;
  contentPackHash: string;
  traceLevel: PreviewTraceLevel;
}

export interface PreviewProvenanceOperation {
  sourceId: string;
  byteStart: number;
  byteEnd: number;
  operationIdentity: string;
  includeChain: string[];
  displayName: string;
}

export interface InstallationEvidenceValue {
  value: string;
  source: string;
}

export interface InstallationReport {
  kind: 'steam' | 'manual';
  valid: boolean;
  evidence: {
    installationRoot: InstallationEvidenceValue;
    executable?: InstallationEvidenceValue;
    productVersion?: InstallationEvidenceValue;
    steamBuild?: InstallationEvidenceValue;
    datHeader?: InstallationEvidenceValue;
    contentRevision?: InstallationEvidenceValue;
    builtInRmsRoots: InstallationEvidenceValue[];
    userProfiles: InstallationEvidenceValue[];
  };
  uncertainty: string[];
}

export interface RememberedInstallationSelection {
  installationRoot: string;
  userProfileId?: string;
}

export type InstalledSourceOwnership = 'built-in' | 'local' | 'subscribed';

export interface InstalledSourceProfile {
  installationId: string;
  installationLabel: string;
  installationKind: InstallationReport['kind'];
  productVersion: string | null;
  profileId: string | null;
  profileSelected: boolean;
}

export interface InstalledSourceRoot {
  rootId: string;
  installationId: string;
  profileId: string | null;
  label: string;
  ownership: InstalledSourceOwnership;
  readOnly: boolean;
}

export interface InstalledSourceEntry {
  sourceId: string;
  rootId: string;
  name: string;
  relativePath: string;
  displayPath: string;
  extension: '.rms' | '.rms2';
  ownership: InstalledSourceOwnership;
  readOnly: boolean;
}

export interface InstalledSourceCatalog {
  contractVersion: Readonly<{ major: 1; minor: 1; patch: 0 }>;
  profiles: InstalledSourceProfile[];
  roots: InstalledSourceRoot[];
  entries: InstalledSourceEntry[];
  diagnostics: OutputWords[];
}

export interface InstalledSourceCloneResult {
  opened: WorkspaceOpenResult;
  entryPath: string;
  copiedRelativePaths: string[];
  unresolvedExternalDependencies: string[];
}

export interface MapIconSourceRequest {
  clientRequestId: string;
  documentUri: string;
  documentRevision: number;
  sourceCatalogRevision: number;
  sourceCatalogHash: string;
  sourceGraphHash: string;
  externalAssetHash: string;
  boundSemanticHash: string;
  seed: number;
}

export interface ManagedDeploymentRequest {
  contractVersion: Readonly<{ major: 1; minor: 0; patch: 0 }>;
  documentUri: string;
  documentRevision: number;
  sourceCatalogRevision: number;
  sourceCatalogHash: string;
  sourceGraphHash: string;
  externalAssetHash: string;
  resolvedRmsSourceIds: string[];
  externalAssetSourceIds: string[];
  includePreviewImage: boolean;
}

export type ManagedDeploymentChangeKind = 'add' | 'change' | 'remove' | 'unchanged';

export interface ManagedDeploymentChange {
  path: string;
  kind: ManagedDeploymentChangeKind;
  bytes: number;
}

export interface ManagedDeploymentPreview {
  contractVersion: Readonly<{ major: 1; minor: 0; patch: 0 }>;
  token: string;
  modName: string;
  profileId: string;
  changes: ManagedDeploymentChange[];
  conflicts: string[];
  sourceCatalogHash: string;
}

export interface ManagedDeploymentApplyRequest {
  token: string;
  overwriteExternalChanges: boolean;
  confirmReplaceExisting?: boolean;
}

export interface ManagedDeploymentResult {
  modName: string;
  profileId: string;
  deployedFiles: string[];
  sourceCatalogHash: string;
  targetPath?: string;
  modStatus?: ManualDeploymentModStatus;
}

export type ModStatusFailureReason =
  | 'malformed'
  | 'unexpected-layout'
  | 'duplicate-entry'
  | 'unexpected-entry'
  | 'changed'
  | 'unsafe-path'
  | 'write-failed';

export interface ManualDeploymentModStatus {
  enable: 'not-requested' | 'enabled' | 'already-enabled' | 'added' | 'failed';
  failure?: ModStatusFailureReason;
  detail?: string;
  gameRunning?: boolean;
}

export type ManagedDeploymentFileRole =
  | 'rms-entry'
  | 'rms-dependency'
  | 'external-xs'
  | 'metadata'
  | 'preview-image'
  | 'generated-map-icon';

export function isDeploymentProfileId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]{3,20}$/u.test(value);
}

export interface ManualDeploymentProfile {
  profileId: string;
  targetRoot: string;
  suggested: boolean;
}

export interface ManualDeploymentOwnedTarget {
  profileId: string;
  modName: string;
  documentUri: string;
  lastConfirmedAt: string;
}

export interface ManualDeploymentContext {
  installationRoot: string;
  profiles: ManualDeploymentProfile[];
  selectedProfileId: string | null;
  selectionSuggested: boolean;
  ownedTargets: ManualDeploymentOwnedTarget[];
  originalMapIconAvailable: boolean;
}

export type ManualDeploymentMapIconMode = 'none' | 'retain-original' | 'generate';

export interface ManualDeploymentMapIconRender {
  contractVersion: MapIconRenderContract['version'];
  perspective: MapIconPerspective;
  look: MapIconRenderLook;
  relief: boolean;
  terrainSmoothing: boolean;
  spawnMarkers: MapIconSpawnMarkerStyle;
  spawnMarkerSizePercent: number;
  trees: boolean;
  treeDensity: number;
  treeSize: number;
  treeSpawnOverlap: boolean;
  resources: boolean;
  resourceDensity: number;
  resourceSize: number;
  resourceSpawnOverlap: boolean;
  sourceSemanticHash: string;
  gameTexturesSource?: string;
  identity: string;
  pixels: Uint8ClampedArray;
}

export interface ManualDeploymentMapIconRequest {
  mode: ManualDeploymentMapIconMode;
  render?: ManualDeploymentMapIconRender;
}

export type ManualDeploymentMapIconSource = 'none' | 'original' | 'generated';

export interface ManualDeploymentMapIconPreview {
  mode: ManualDeploymentMapIconMode;
  source: ManualDeploymentMapIconSource;
  originalAvailable: boolean;
  path: string | null;
  renderIdentity: string | null;
}

export interface ManualDeploymentPreviewRequest {
  deployment: ManagedDeploymentRequest;
  profileId: string;
  modName: string;
  mapIcon: ManualDeploymentMapIconRequest;
}

export interface ManualDeploymentDesiredFile {
  path: string;
  bytes: number;
  role: ManagedDeploymentFileRole;
}

export interface ManualDeploymentPreview extends ManagedDeploymentPreview {
  targetPath: string;
  targetExists: boolean;
  targetOwned: boolean;
  desiredFiles: ManualDeploymentDesiredFile[];
  mapIcon: ManualDeploymentMapIconPreview;
}

export interface ManualDeploymentApplyRequest {
  token: string;
  confirmReplaceExisting: boolean;
  enableMod: boolean;
}

export const maximumManualDeploymentMapIconBytes = 4 * 1024 * 1024;

export interface ManualDeploymentMapIconImage {
  source: 'original' | 'generated';
  fileName: string;
  bytes: Uint8Array;
}

export interface GeneratedMapIconSaveRequest {
  documentUri: string;
  documentRevision: number;
  sourceCatalogRevision: number;
  sourceCatalogHash: string;
  sourceGraphHash: string;
  externalAssetHash: string;
  render: ManualDeploymentMapIconRender;
}

export type ManualDeploymentMapIconSaveResult =
  { status: 'saved'; fileName: string } | { status: 'cancelled' };

export type ControlLauncherState = 'unconfigured' | 'ready' | 'missing' | 'changed' | 'invalid';

export interface ControlLauncherStatus {
  configured: boolean;
  state: ControlLauncherState;
  executableName?: string;
  fingerprintSha256?: string;
}

export type ControlConnectPurpose = 'live-run' | 'adopt-seed';
export type ControlConnectionState =
  'disconnected' | 'launching' | 'game-detected' | 'handshaking' | 'ready' | 'failed';

export interface ControlEngineIdentity {
  control: {
    productVersion: string;
    capabilityRevision: 'rms-session-3';
    buildFlavor: 'release' | 'release-packed';
  };
  gameBuild: {
    fileVersion: string;
    peTimestamp: string;
  };
  engine: {
    gameProcessId: number;
    injectionId: string;
    endpointInstanceId: string;
  };
}

export interface ControlCapabilityFeatures {
  typedStartTransaction: true;
  managedLocalMod: true;
  requestedEffectiveReadback: true;
  transactionRollback: true;
  explicitCleanEnd: true;
  sourceCatalogRefresh: true;
  managedSourceSelection: true;
  typedSetup: true;
  exactUnsignedSeed: true;
  effectiveReadback: true;
  cleanEnd: true;
  freshMatchDispatch: true;
  statusReadback: true;
  matchEpochs: true;
  lobbyOptions?: boolean;
  activeMatchAtomicReplacement: false;
  directPath: false;
  inlineSource: false;
  intermediateSemanticStages: false;
  reviewedFailClosedMultiplayerRefusal: true;
}

export type ControlSafetySessionState =
  | 'single-player-ready'
  | 'single-player-active'
  | 'multiplayer'
  | 'replay'
  | 'changing'
  | 'unknown';

export interface ControlSafetyAttestation {
  contract: 'rmside-multiplayer-refusal-1';
  verified: true;
  sessionState: ControlSafetySessionState;
  observationSequence: number;
}

export interface ControlCapabilities {
  contractVersion: '1.0.0';
  supportedContract: { minimumMajor: 1; maximumMajor: 1 };
  safetyContract: 'rmside-multiplayer-refusal-1';
  safety: ControlSafetyAttestation;
  identity: ControlEngineIdentity;
  features: ControlCapabilityFeatures;
  setupContextVersions?: string[];
}

export interface ControlMatchStatus {
  observationSequence: number;
  matchEpoch: number;
  active: boolean;
  replay: boolean;
  multiplayer: boolean;
}

export interface ControlResetEvidence {
  sequence: number;
  previousMatchEpoch: number;
  requested: boolean;
  dispatchAccepted: boolean;
  inactiveBoundaryObserved: boolean;
  completed: boolean;
}

export interface ControlSetupPlayer {
  slot: number;
  team: number;
  civilizationId: number;
  color: number;
}

export type ControlSetupContextVersion = '1.0.0' | '1.1.0' | '1.2.0';

export interface ControlSetupContext {
  $schema?: 'https://rmside.invalid/schemas/setup-context/v1';
  schemaVersion: ControlSetupContextVersion;
  compatibility: { minimumMajor: 1; maximumMajor: 1 };
  gameMode:
    | 'random-map'
    | 'regicide'
    | 'death-match'
    | 'king-of-the-hill'
    | 'wonder-race'
    | 'defend-the-wonder'
    | 'turbo-random-map'
    | 'capture-the-relic'
    | 'sudden-death'
    | 'battle-royale'
    | 'empire-wars';
  startingResources: 'standard' | 'low' | 'medium' | 'high' | 'ultra-high' | 'infinite' | 'random';
  startingAge: ControlAge;
  revealMap: 'all-visible';
  positionPolicy: 'random' | 'fixed' | 'team-together';
  players: ControlSetupPlayer[];
  computerPlayerSlots?: number[];
  gameModeModifiers?: GameModeModifier[];
  turboMode?: boolean;
  fullTechTree?: boolean;
  antiquityMode?: boolean;
  solidFarms?: boolean;
}

export interface ControlLobbyOptions {
  computerPlayerSlots: number[];
  gameModeModifiers: GameModeModifier[];
  turboMode: boolean;
  fullTechTree: boolean;
  antiquityMode: boolean;
  solidFarms: boolean;
}

export interface ControlEffectiveSetupContext extends ControlSetupContext {
  mapSize: ControlMapSize;
  endingAge: ControlAge;
}

export type ControlAge =
  'standard' | 'dark-age' | 'feudal-age' | 'castle-age' | 'imperial-age' | 'post-imperial-age';

export type ControlMapSize =
  'tiny' | 'small' | 'medium' | 'normal' | 'large' | 'huge' | 'ludicrous';

export interface ControlManagedSourceSelection {
  catalogGeneration: number;
  sourceIdentity: string;
  authoredSourceSha256: string;
  modIdentity: string;
}

export interface ControlRandomMapSource {
  displayName: string;
  nativeMapId: number;
  sourceKind: string;
  modIdentity: string | null;
  sourceIdentity: string;
  authoredSourceSha256: string | null;
  catalogGeneration: number;
}

export interface ControlCatalog {
  identity: ControlEngineIdentity;
  safety: ControlSafetyAttestation;
  catalogGeneration: number;
  sources: ControlRandomMapSource[];
}

export interface ControlStartRandomMapRequest {
  requestId: string;
  setup: ControlSetupContext;
  mapSize: ControlMapSize;
  endingAge: ControlAge;
  seed: number;
  source: ControlManagedSourceSelection;
}

export interface ControlLastTransaction {
  requestId: string;
  setupIdentity: string;
  state: 'dispatched' | 'active-verifying' | 'active-verified' | 'active-readback-mismatch';
  requestedSetup: ControlEffectiveSetupContext;
  effectiveSetup: ControlEffectiveSetupContext | null;
  requestedSeed: number;
  effectiveSeed: number | null;
  sourceIdentity: string;
  authoredSourceSha256: string;
  catalogGeneration: number;
  matchEpoch: number | null;
  route: string;
}

export interface ControlEndpointStatus {
  identity: ControlEngineIdentity;
  safety: ControlSafetyAttestation;
  match: ControlMatchStatus;
  resetEvidence: ControlResetEvidence;
  lastTransaction: ControlLastTransaction | null;
  currentSetup: ControlEffectiveSetupContext | null;
  currentLobbyOptions?: ControlLobbyOptions | null;
  currentGameMode?: ControlSetupContext['gameMode'] | null;
  requestedSeed: number | null;
  effectiveSeed: number | null;
  effectiveSource: ControlRandomMapSource | null;
}

export interface ControlCleanEndResult {
  status: 'already-inactive' | 'queued';
  identity: ControlEngineIdentity;
  safety: ControlSafetyAttestation;
  resetEvidence: ControlResetEvidence;
}

export interface ControlStartRandomMapResult {
  requestId: string;
  setupIdentity: string;
  capabilityRevision: 'rms-session-3';
  route: string;
  detail: string;
  rollbackComplete: boolean;
  dispatchAccepted: boolean;
  requestedSetup: ControlEffectiveSetupContext;
  effectiveSetup: ControlEffectiveSetupContext | null;
  requestedSeed: number;
  source: ControlRandomMapSource | null;
  catalogGeneration: number;
  resetEvidence: ControlResetEvidence;
  identity: ControlEngineIdentity;
  safety: ControlSafetyAttestation;
}

export interface ControlDetachResult {
  status: 'accepted';
  identity: ControlEngineIdentity;
  safety: ControlSafetyAttestation;
}

export interface ControlSessionStatus {
  contractVersion: Readonly<{ major: 1; minor: 0; patch: 0 }>;
  connection: ControlConnectionState;
  detailCode?: string;
  launcher: ControlLauncherStatus;
  capabilities?: ControlCapabilities;
  endpoint?: ControlEndpointStatus;
  gameVersion?: { productVersion: string; verification: 'verified' | 'unverified' };
}

export type ControlSessionEventKind =
  | 'startup'
  | 'game-detected'
  | 'attach'
  | 'handshake'
  | 'ready'
  | 'cancelled'
  | 'failure'
  | 'detached';

export interface ControlSessionEvent {
  sequence: number;
  kind: ControlSessionEventKind;
  detailCode: string;
  detail?: string;
  recovery?: true;
}

export interface ControlLivePreviewBinding {
  backend: 'exact';
  provenanceStatus: 'exact';
  documentUri: string;
  documentRevision: number;
  currentDocumentUri: string;
  currentDocumentRevision: number;
  requestHash: string;
  semanticProgramHash: string;
  sourceCatalogRevision: number;
  sourceCatalogHash: string;
  sourceGraphHash: string;
  externalAssetHash: string;
  profileId: string;
  profileHash: string;
  contentPackId: string;
  contentPackHash: string;
  width: number;
  height: number;
  mapSize: ControlMapSize;
  seed: number;
}

export interface ControlLiveSynchronizationRequest {
  contractVersion: Readonly<{ major: 1; minor: 0; patch: 0 }>;
  requestId: string;
  preview: ControlLivePreviewBinding;
  deployment: ManagedDeploymentRequest;
  setup: ControlSetupContext;
  endingAge: ControlAge;
  replaceActiveMatch: boolean;
  overwriteDeploymentConflicts: boolean;
}

export interface ControlLiveSynchronizationResult {
  preview: 'current';
  live: 'active-verified';
  requestId: string;
  matchEpoch: number;
  seed: number;
  sourceIdentity: string;
  processIdentity: {
    gameProcessId: number;
    injectionId: string;
    endpointInstanceId: string;
  };
}

export type ControlLiveWorkflowEventKind =
  | 'startup'
  | 'stage'
  | 'handshake'
  | 'clean-end'
  | 'deploy'
  | 'catalog-refresh'
  | 'start'
  | 'effective-readback'
  | 'cancellation'
  | 'failure';

export interface ControlLiveWorkflowEvent {
  sequence: number;
  requestId: string;
  kind: ControlLiveWorkflowEventKind;
  detailCode: string;
  detail?: string;
  seed?: number;
  matchEpoch?: number;
  xsFiles?: string[];
}

export const liveWorkflowStages = [
  'checking-game',
  'ending-match',
  'copying-map',
  'selecting-map',
  'starting-match',
  'verifying',
] as const;
export type LiveWorkflowStage = (typeof liveWorkflowStages)[number];

export const inlayHintsSettingVersion = 2;

export type LanguageServerRequestMethod =
  | 'textDocument/completion'
  | 'textDocument/signatureHelp'
  | 'textDocument/hover'
  | 'textDocument/definition'
  | 'textDocument/documentLink'
  | 'textDocument/references'
  | 'textDocument/documentHighlight'
  | 'textDocument/documentSymbol'
  | 'textDocument/foldingRange'
  | 'textDocument/semanticTokens/full'
  | 'workspace/symbol'
  | 'textDocument/formatting'
  | 'textDocument/prepareRename'
  | 'textDocument/rename'
  | 'textDocument/codeAction'
  | 'textDocument/inlayHint'
  | 'completionItem/resolve'
  | 'rms/semanticIdentity'
  | 'rms/validateSourceCatalogIdentity';

export type LanguageServerNotificationMethod =
  | 'textDocument/didOpen'
  | 'textDocument/didChange'
  | 'textDocument/didClose'
  | 'workspace/didChangeWatchedFiles'
  | 'rms/previewContext';

export interface LanguageServerPreviewContext {
  contractVersion: Readonly<{ major: 1; minor: 0 | 1 | 2; patch: 0 }>;
  computerPlayerSlots?: number[];
  gameModeModifiers?: GameModeModifier[];
  turboMode?: boolean;
  fullTechTree?: boolean;
  antiquityMode?: boolean;
  solidFarms?: boolean;
  contentSelection?: LanguageContentSelection;
  seed: number;
  width: number;
  height: number;
  mapSize: string;
  players: Array<PreviewPlayerConfiguration & { color: number }>;
  gameMode: string;
  startingResources: string;
  startingAge: string;
  positionPolicy: string;
}

export interface LanguageContentSelection {
  profileId: string;
  packId: string;
  packVersion: string;
  contentHash: string;
  versionOrigin: PreviewVersionOrigin;
}

export interface LanguageServerEvent {
  method: string;
  params: unknown;
}

export interface LanguageServerDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  severity?: number;
  code?: string | number;
  message: string;
  data?: unknown;
}

export type WorkspaceEntryKind = 'file' | 'folder';
export type WorkspaceSourceKind = 'ordinary' | 'protected';
export type SourceEncodingName = 'utf8' | 'utf8-bom' | 'windows-1252';
export type SourceNewlineStyle = 'none' | 'lf' | 'crlf' | 'cr' | 'mixed';

export interface WorkspaceDocument {
  id: string;
  uri: string;
  path: string;
  name: string;
  content: string;
  encoding: SourceEncodingName;
  newlineStyle: SourceNewlineStyle;
  sourceKind: WorkspaceSourceKind;
  readOnly: boolean;
  diskHash: string;
}

export interface WorkspaceFolder {
  id: string;
  path: string;
  name: string;
  writable: boolean;
}

export interface WorkspaceDirectoryEntry {
  id: string;
  path: string;
  name: string;
  kind: WorkspaceEntryKind;
  writable: boolean;
  hasChildren?: boolean;
}

export interface WorkspaceSearchResult extends WorkspaceDirectoryEntry {
  relativePath: string;
  matched: boolean;
}

export interface WorkspaceCreateRequest {
  parentId: string;
  kind: WorkspaceEntryKind;
  name: string;
  template?: 'map-test-v1' | 'xs-v1';
}

export interface DefinitionFilePrepareRequest {
  folderId: string | null;
}

export type DefinitionFileGameFolderNames = 'used' | 'no-game-folder' | 'other-version' | 'no-text';

export interface DefinitionFilePlan {
  planId: string;
  status: 'ready' | 'unavailable';
  identities: DefinitionFileIdentities | null;
  candidates: DefinitionCandidates;
  project: ProjectDefinitionFile[];
  projectComplete: boolean;
  gameFolderNames: DefinitionFileGameFolderNames;
  target: { kind: 'folder'; name: string; relativePath: string } | { kind: 'save-dialog' };
  reservedFileNames: string[];
}

export interface DefinitionFileGenerateRequest {
  planId: string;
  fileName: string;
  groups: DefinitionGroupId[];
  includeBuiltIn: boolean;
  overwrite: boolean;
}

export type DefinitionFileGenerateResult =
  | { status: 'written'; path: string }
  | { status: 'exists'; fileName: string }
  | { status: 'cancelled' };

export interface WorkspaceRenameRequest {
  entryId: string;
  name: string;
}

export interface WorkspaceDeleteRequest {
  entryId: string;
  permanent?: boolean;
}

export interface WorkspacePathChange {
  oldId: string;
  newId: string;
  oldPath: string;
  newPath: string;
  newUri: string;
}

export interface WorkspaceMutationResult {
  entry?: WorkspaceDirectoryEntry;
  kind: WorkspaceEntryKind;
  pathChanges: WorkspacePathChange[];
  targetName: string;
  targetPath: string;
  wasNonEmptyFolder?: boolean;
}

export interface WorkspaceOpenResult {
  documents: WorkspaceDocument[];
  folder: WorkspaceFolder | null;
}

export interface ShellOpenTakeResult {
  opened: WorkspaceOpenResult | null;
}

export interface RecentWorkspaceEntry {
  path: string;
  name: string;
  kind: WorkspaceEntryKind;
}

export interface WorkspaceSaveRequest {
  documentId: string;
  path: string;
  content: string;
  diskHash: string;
  overwriteExternalChange?: boolean;
}

export interface WorkspaceSaveAsRequest {
  documentId: string;
  content: string;
  suggestedName: string;
  encoding: SourceEncodingName;
  newlineStyle: SourceNewlineStyle;
}

export type WorkspaceSaveResult =
  | { status: 'saved'; document: WorkspaceDocument }
  | { status: 'external-change'; current: WorkspaceDocument };

export type WorkspaceExternalChange =
  | { kind: 'changed'; document: WorkspaceDocument }
  | { kind: 'deleted'; documentId: string; path: string };

export interface RecoveryDocument {
  id: string;
  uri: string;
  path: string | null;
  name: string;
  content: string;
  encoding: SourceEncodingName;
  newlineStyle: SourceNewlineStyle;
  sourceKind: WorkspaceSourceKind;
  readOnly: boolean;
  diskHash: string;
  dirty: boolean;
  viewState?: MonacoViewState | null;
}

export interface RecoverySnapshot {
  version: 1;
  activeDocumentId: string | null;
  folder: WorkspaceFolder | null;
  documents: RecoveryDocument[];
  savedAt: number;
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowDisplayFingerprint {
  version: 1;
  id: number;
  bounds: WindowBounds;
  scaleFactor: number;
}

export interface MonacoViewState {
  cursorState: unknown[];
  viewState: object;
  contributionsState: object;
}

export interface DesktopSessionTab {
  path: string;
  viewState: MonacoViewState | null;
}

export interface BottomPanelSeverityFilter {
  error: boolean;
  warning: boolean;
  info: boolean;
}

export type InstalledSourceOriginFilter = Record<InstalledSourceOwnership, boolean>;

export interface DesktopSession {
  version: 1;
  themePreference: ThemePreference;
  formatOnSave: boolean;
  indentConditionals: boolean;
  liveGenerationStages: boolean;
  gpuMapRendering: boolean;
  inlayHints: boolean;
  inlayHintsVersion: typeof inlayHintsSettingVersion;
  deletePermanently: boolean;
  languagePreference: LanguagePreference;
  rmsLintRules: RmsLintWorkspaceRules[];
  previewPerspective: PreviewPerspective;
  previewLook: PreviewLook;
  previewTileGrid: boolean;
  previewSmallTrees: boolean;
  gameTexturesFirstLinkApplied: boolean;
  gameTexturesFirstLinkInstallations: string[];
  mapIconRelief: boolean;
  mapIconTerrainSmoothing: boolean;
  mapIconSpawnMarkerStyle: MapIconSpawnMarkerStyle;
  mapIconSpawnMarkerSizePercent: number;
  mapIconPerspective: MapIconPerspective;
  mapIconLook: MapIconRenderLook;
  mapIconTrees: boolean;
  mapIconTreeDensityLevel: number;
  mapIconTreeSize: number;
  mapIconTreeSpawnOverlap: boolean;
  mapIconResources: boolean;
  mapIconResourceDensityLevel: number;
  mapIconResourceSize: number;
  mapIconResourceSpawnOverlap: boolean;
  window: {
    bounds: WindowBounds | null;
    maximized: boolean;
    display: WindowDisplayFingerprint | null;
  };
  layout: {
    explorerExpanded: boolean;
    explorerWidth: number;
    previewExpanded: boolean;
    previewWidth: number | null;
    bottomPanelHeight: number;
    bottomPanelTab: 'problems' | 'output' | 'test-results';
    profilerOpen: boolean;
    outputSeverityFilter: BottomPanelSeverityFilter;
    problemsSeverityFilter: BottomPanelSeverityFilter;
    installedSourceOriginFilter: InstalledSourceOriginFilter;
  };
  workspace: {
    folder: WorkspaceFolder | null;
    expandedPaths: string[];
    selectedPath: string | null;
    normalTabs: DesktopSessionTab[];
    activePath: string | null;
  };
  dialogLocations: {
    file: string | null;
    folder: string | null;
    installedSourceClone: string | null;
    mapIconSave: string | null;
    sourceSave: string | null;
    definitionSave: string | null;
    mapTestReportImport: string | null;
    mapTestReportExport: string | null;
    gameFolder: string | null;
    controlLauncher: string | null;
  };
}

export interface DesktopSessionRestore {
  session: DesktopSession;
  documents: WorkspaceDocument[];
  diagnostics: OutputWords[];
}

export interface RmsideDesktopApi {
  getDesktopSession(): Promise<DesktopSessionRestore>;
  saveDesktopSession(session: DesktopSession): Promise<void>;
  resetLayout(): Promise<void>;
  getNativeStatus(): Promise<NativeProcessStatus[]>;
  restartNative(name: NativeProcessName): Promise<NativeProcessStatus>;
  getConfigurationCatalog(): Promise<ConfigurationCatalog>;
  generatePreview(input: PreviewGenerationInput): Promise<PreviewGenerationResult>;
  cancelPreviewGeneration(clientRequestId: string): Promise<boolean>;
  getExecutionState(): Promise<RootExecutionState>;
  stopExecution(): Promise<boolean>;
  runMapTest(input: MapTestRunInput): Promise<MapTestRunResult>;
  replayMapTestFinding(input: MapTestReplayInput): Promise<PreviewGenerationResult>;
  onMapTestEvent(listener: (event: MapTestEvent) => void): () => void;
  exportMapTestReport(reportJson: string): Promise<string | null>;
  importMapTestReport(): Promise<ImportedMapTestReport | null>;
  onExecutionState(listener: (state: RootExecutionState) => void): () => void;
  getDevelopmentFixtures(): Promise<DevelopmentFixtureDescriptor[]>;
  runDevelopmentFixture(request: DevelopmentFixtureRequest): Promise<PreviewGenerationResult>;
  onPreviewGenerationEvent(listener: (event: PreviewGenerationEvent) => void): () => void;
  onPreviewExecutionProgress(listener: (event: ExecutionProgressEvent) => void): () => void;
  onPreviewCandidate(listener: (candidate: PreviewCandidate) => void): () => void;
  acknowledgePreviewCandidate(acknowledgement: PreviewCandidateAcknowledgement): void;
  discoverInstallations(): Promise<InstallationReport[]>;
  pickManualInstallation(): Promise<InstallationReport | null>;
  getRememberedInstallationSelection(): Promise<RememberedInstallationSelection | null>;
  rememberInstallationSelection(selection: RememberedInstallationSelection): Promise<void>;
  forgetRememberedInstallationSelection(): Promise<void>;
  selectLanguageGameVersion(
    profileId: string | null,
    versionOrigin?: PreviewVersionOrigin,
  ): Promise<void>;
  getStandardIncludeAccess(versionOrigin: PreviewVersionOrigin): Promise<StandardIncludeAccess>;
  getLocalPresentationNames(): Promise<LocalPresentationNames | null>;
  getGameArtStatus(): Promise<GameArtStatus>;
  prepareGameArt(): Promise<GameArtStatus>;
  cancelGameArt(): Promise<void>;
  getGameArtTerrain(): Promise<GameArtTerrainIndex | null>;
  getGameArtSprites(objects: GameArtSpriteRequestObject[]): Promise<GameArtSpriteSet | null>;
  getGameArtImages(keys: string[]): Promise<GameArtImage[]>;
  onGameArtStatus(listener: (status: GameArtStatus) => void): () => void;
  onGameTexturesFirstLink(listener: () => void): () => void;
  discoverInstalledSources(): Promise<InstalledSourceCatalog>;
  openInstalledSource(sourceId: string): Promise<WorkspaceOpenResult>;
  cloneInstalledSource(sourceId: string): Promise<InstalledSourceCloneResult | null>;
  selectInstalledProfile(installationId: string, profileId: string): Promise<void>;
  previewManagedDeployment(request: ManagedDeploymentRequest): Promise<ManagedDeploymentPreview>;
  applyManagedDeployment(request: ManagedDeploymentApplyRequest): Promise<ManagedDeploymentResult>;
  getManualDeploymentContext(documentUri: string): Promise<ManualDeploymentContext | null>;
  previewManualDeployment(
    request: ManualDeploymentPreviewRequest,
  ): Promise<ManualDeploymentPreview>;
  applyManualDeployment(request: ManualDeploymentApplyRequest): Promise<ManagedDeploymentResult>;
  openDeployedModFolder(): Promise<void>;
  openDeploymentTargetFolder(profileId: string): Promise<void>;
  readManualDeploymentMapIcon(token: string): Promise<ManualDeploymentMapIconImage | null>;
  saveManualDeploymentMapIcon(token: string): Promise<ManualDeploymentMapIconSaveResult>;
  saveGeneratedMapIcon(
    request: GeneratedMapIconSaveRequest,
  ): Promise<ManualDeploymentMapIconSaveResult>;
  getMapIconRenderInput(): Promise<MapIconRenderInput>;
  setMapIconRenderInput(input: MapIconRenderInput): Promise<void>;
  generateMapIconSource(request: MapIconSourceRequest): Promise<PreviewGenerationResult>;
  cancelMapIconSource(clientRequestId: string): Promise<boolean>;
  onMapIconExecutionProgress(listener: (event: ExecutionProgressEvent) => void): () => void;
  getControlLauncherStatus(): Promise<ControlLauncherStatus>;
  selectControlLauncher(): Promise<ControlLauncherStatus | null>;
  forgetControlLauncher(): Promise<ControlLauncherStatus>;
  getControlSessionStatus(): Promise<ControlSessionStatus>;
  connectControlSession(purpose: ControlConnectPurpose): Promise<ControlSessionStatus>;
  disconnectControlSession(): Promise<ControlSessionStatus>;
  onControlSessionEvent(listener: (event: ControlSessionEvent) => void): () => void;
  runControlLiveTest(
    request: ControlLiveSynchronizationRequest,
  ): Promise<ControlLiveSynchronizationResult>;
  cancelControlLiveTest(requestId: string): Promise<boolean>;
  onControlLiveEvent(listener: (event: ControlLiveWorkflowEvent) => void): () => void;
  onNativeEvent(listener: (status: NativeProcessStatus) => void): () => void;
  disableRmsLintRule(code: string): Promise<void>;
  requestLanguageServer(method: LanguageServerRequestMethod, params: unknown): Promise<unknown>;
  notifyLanguageServer(method: LanguageServerNotificationMethod, params: unknown): Promise<void>;
  onLanguageServerEvent(listener: (event: LanguageServerEvent) => void): () => void;
  openApplicationMenu(name: ApplicationMenuName, x: number, y: number): Promise<void>;
  openExternalLink(target: ExternalLinkTarget): Promise<void>;
  openDocumentLink(url: string): Promise<void>;
  pasteIntoEditor(): Promise<void>;
  syncApplicationMenuBounds(bounds: ApplicationMenuTriggerBounds[]): Promise<void>;
  syncMapTestResultsVisibility(visible: boolean): Promise<void>;
  syncMapTestPreviewShown(shown: boolean): Promise<void>;
  syncModalSurfaceOpen(open: boolean): Promise<void>;
  syncNativeTheme(preference: ThemePreference, resolved: ResolvedTheme): Promise<void>;
  getLocaleState(): Promise<LocaleState>;
  setLanguagePreference(preference: LanguagePreference): Promise<LocaleState>;
  onLocaleChanged(listener: (state: LocaleState) => void): () => void;
  onApplicationMenuAction(listener: (action: ApplicationMenuAction) => void): () => void;
  pickFiles(): Promise<WorkspaceOpenResult | null>;
  pickFolder(): Promise<WorkspaceOpenResult | null>;
  openDroppedFiles(files: File[]): Promise<WorkspaceOpenResult>;
  openWorkspaceFile(path: string): Promise<WorkspaceDocument>;
  openWorkspaceSource(sourceId: string): Promise<WorkspaceDocument>;
  openRecent(path: string): Promise<WorkspaceOpenResult>;
  takeShellOpenRequest(): Promise<ShellOpenTakeResult | null>;
  onShellOpenPending(listener: () => void): () => void;
  readDirectory(entryId: string): Promise<WorkspaceDirectoryEntry[]>;
  openWorkspaceFolderInExplorer(entryId: string): Promise<void>;
  searchWorkspace(query: string): Promise<WorkspaceSearchResult[]>;
  cancelWorkspaceSearch(): Promise<void>;
  closeWorkspace(): Promise<void>;
  createWorkspaceEntry(request: WorkspaceCreateRequest): Promise<WorkspaceMutationResult>;
  prepareDefinitionFile(request: DefinitionFilePrepareRequest): Promise<DefinitionFilePlan>;
  generateDefinitionFile(
    request: DefinitionFileGenerateRequest,
  ): Promise<DefinitionFileGenerateResult>;
  renameWorkspaceEntry(request: WorkspaceRenameRequest): Promise<WorkspaceMutationResult>;
  deleteWorkspaceEntry(request: WorkspaceDeleteRequest): Promise<WorkspaceMutationResult>;
  saveFile(request: WorkspaceSaveRequest): Promise<WorkspaceSaveResult>;
  saveFileAs(request: WorkspaceSaveAsRequest): Promise<WorkspaceDocument | null>;
  recentEntries(): Promise<RecentWorkspaceEntry[]>;
  readRecovery(): Promise<RecoverySnapshot | null>;
  writeRecovery(snapshot: RecoverySnapshot): Promise<void>;
  clearRecovery(): Promise<void>;
  onWindowCloseRequested(listener: () => void): () => void;
  onWorkspaceExternalChange(listener: (change: WorkspaceExternalChange) => void): () => void;
  onWorkspaceDiagnostic(listener: (message: OutputMessage) => void): () => void;
  respondToWindowClose(allow: boolean): Promise<void>;
  takeReleaseNotice(): Promise<OutputMessage | null>;
}
