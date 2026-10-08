import { rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import {
  defaultMapIconRenderInput,
  inlayHintsSettingVersion,
  isMapIconArtDensity,
  isMapIconArtDensityV8,
  isMapIconArtSize,
  isMapIconSpawnMarkerSizePercent,
  isMapIconSpawnMarkerStyle,
  migrateMapIconArtDensityV8,
  migrateMapIconSpawnMarkersV9,
  mapIconPerspectives,
  mapIconRenderLooks,
  type BottomPanelSeverityFilter,
  type DesktopSession,
  type DesktopSessionTab,
  type InstalledSourceOriginFilter,
  type MapIconPerspective,
  type MapIconRenderInput,
  type MapIconRenderLook,
  type MapIconSpawnMarkerStyle,
  type MonacoViewState,
  type ThemePreference,
  type WindowBounds,
  type WindowDisplayFingerprint,
  type WorkspaceFolder,
  type WorkspacePathChange,
} from '../shared/api';
import { parseWindowDisplayFingerprint } from './window-placement';
import {
  isPreviewLook,
  isPreviewPerspective,
  type PreviewLook,
  type PreviewPerspective,
} from '../shared/game-art';
import { readFileBounded, replaceFileAtomically } from './bounded-file';
import { isLanguagePreference, type LanguagePreference } from '../shared/i18n/locale';
import {
  validateRmsLintWorkspaceRules,
  type RmsLintWorkspaceRules,
} from '../shared/rms-lint-rules';

const maximumSessionBytes = 2 * 1024 * 1024;
const maximumPathLength = 32_768;
const maximumTabs = 128;
const maximumExpandedPaths = 4096;
const maximumViewStateBytes = 256 * 1024;
export const maximumGameTexturesFirstLinkInstallations = 16;

export const defaultDesktopSession = Object.freeze<DesktopSession>({
  version: 1,
  themePreference: 'system',
  formatOnSave: true,
  indentConditionals: true,
  liveGenerationStages: true,
  gpuMapRendering: true,
  inlayHints: true,
  inlayHintsVersion: inlayHintsSettingVersion,
  deletePermanently: false,
  languagePreference: 'system',
  rmsLintRules: [],
  previewPerspective: 'top-down',
  previewLook: 'minimap',
  previewTileGrid: false,
  gameTexturesFirstLinkApplied: false,
  gameTexturesFirstLinkInstallations: [],
  mapIconRelief: defaultMapIconRenderInput.relief,
  mapIconTerrainSmoothing: defaultMapIconRenderInput.terrainSmoothing,
  mapIconSpawnMarkerStyle: defaultMapIconRenderInput.spawnMarkers,
  mapIconSpawnMarkerSizePercent: defaultMapIconRenderInput.spawnMarkerSizePercent,
  mapIconPerspective: defaultMapIconRenderInput.perspective,
  mapIconLook: defaultMapIconRenderInput.look,
  mapIconTrees: defaultMapIconRenderInput.trees,
  mapIconTreeDensityLevel: defaultMapIconRenderInput.treeDensity,
  mapIconTreeSize: defaultMapIconRenderInput.treeSize,
  mapIconTreeSpawnOverlap: defaultMapIconRenderInput.treeSpawnOverlap,
  mapIconResources: defaultMapIconRenderInput.resources,
  mapIconResourceDensityLevel: defaultMapIconRenderInput.resourceDensity,
  mapIconResourceSize: defaultMapIconRenderInput.resourceSize,
  mapIconResourceSpawnOverlap: defaultMapIconRenderInput.resourceSpawnOverlap,
  window: { bounds: null, maximized: false, display: null },
  layout: {
    explorerExpanded: true,
    explorerWidth: 248,
    previewExpanded: true,
    previewWidth: null,
    bottomPanelHeight: 150,
    bottomPanelTab: 'output',
    profilerOpen: false,
    outputSeverityFilter: { error: true, warning: true, info: true },
    problemsSeverityFilter: { error: true, warning: true, info: false },
    installedSourceOriginFilter: { 'built-in': true, local: true, subscribed: true },
  },
  workspace: {
    folder: null,
    expandedPaths: [],
    selectedPath: null,
    normalTabs: [],
    activePath: null,
  },
  dialogLocations: {
    file: null,
    folder: null,
    installedSourceClone: null,
    mapIconSave: null,
    sourceSave: null,
    definitionSave: null,
    mapTestReportImport: null,
    mapTestReportExport: null,
    gameFolder: null,
    controlLauncher: null,
  },
});

export class DesktopSessionStore {
  private readonly path: string;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(userDataPath: string) {
    this.path = join(userDataPath, 'desktop-session-v1.json');
  }

  async read(): Promise<DesktopSession> {
    await this.pendingWrite.catch(() => undefined);
    return this.readUnqueued();
  }

  write(session: DesktopSession): Promise<void> {
    const validated = validateDesktopSession(session);
    this.pendingWrite = this.pendingWrite
      .catch(() => undefined)
      .then(() => this.writeUnqueued(validated));
    return this.pendingWrite;
  }

  resetLayout(): Promise<void> {
    return this.update((session) => ({
      ...session,
      layout: { ...cloneDefaultDesktopSession().layout },
    }));
  }

  updateWindow(
    bounds: WindowBounds | null,
    maximized: boolean,
    display: WindowDisplayFingerprint | null,
  ): Promise<void> {
    return this.update((session) => ({ ...session, window: { bounds, maximized, display } }));
  }

  updateDialogLocation(kind: keyof DesktopSession['dialogLocations'], path: string): Promise<void> {
    return this.update((session) => ({
      ...session,
      dialogLocations: { ...session.dialogLocations, [kind]: path },
    }));
  }

  updateTheme(themePreference: ThemePreference): Promise<void> {
    return this.update((session) => ({ ...session, themePreference }));
  }

  updateFormatOnSave(formatOnSave: boolean): Promise<void> {
    return this.update((session) => ({ ...session, formatOnSave }));
  }

  updateIndentConditionals(indentConditionals: boolean): Promise<void> {
    return this.update((session) => ({ ...session, indentConditionals }));
  }

  updateLiveGenerationStages(liveGenerationStages: boolean): Promise<void> {
    return this.update((session) => ({ ...session, liveGenerationStages }));
  }

  updateGpuMapRendering(gpuMapRendering: boolean): Promise<void> {
    return this.update((session) => ({ ...session, gpuMapRendering }));
  }

  updateInlayHints(inlayHints: boolean): Promise<void> {
    return this.update((session) => ({ ...session, inlayHints }));
  }

  updateDeletePermanently(deletePermanently: boolean): Promise<void> {
    return this.update((session) => ({ ...session, deletePermanently }));
  }

  updateLanguagePreference(languagePreference: LanguagePreference): Promise<void> {
    return this.update((session) => ({ ...session, languagePreference }));
  }

  updateRmsLintRules(rmsLintRules: RmsLintWorkspaceRules[]): Promise<void> {
    return this.update((session) => ({ ...session, rmsLintRules }));
  }

  updatePreviewView(
    previewPerspective: PreviewPerspective,
    previewLook: PreviewLook,
  ): Promise<void> {
    return this.update((session) => ({ ...session, previewPerspective, previewLook }));
  }

  async recordGameTexturesInstallation(installation: string): Promise<boolean> {
    validateInstallationIdentity(installation);
    const current = await this.read();
    if (
      !current.gameTexturesFirstLinkApplied &&
      current.gameTexturesFirstLinkInstallations.at(-1) === installation
    ) {
      return false;
    }
    let first = false;
    await this.update((session) => {
      const known = session.gameTexturesFirstLinkInstallations.includes(installation);
      first = !known && !session.gameTexturesFirstLinkApplied;
      const others = session.gameTexturesFirstLinkInstallations.filter(
        (candidate) => candidate !== installation,
      );
      return {
        ...session,
        gameTexturesFirstLinkApplied: false,
        gameTexturesFirstLinkInstallations: [...others, installation].slice(
          -maximumGameTexturesFirstLinkInstallations,
        ),
      };
    });
    return first;
  }

  updateMapIconRenderInput(input: MapIconRenderInput): Promise<void> {
    return this.update((session) => ({
      ...session,
      mapIconRelief: input.relief,
      mapIconTerrainSmoothing: input.terrainSmoothing,
      mapIconSpawnMarkerStyle: input.spawnMarkers,
      mapIconSpawnMarkerSizePercent: input.spawnMarkerSizePercent,
      mapIconPerspective: input.perspective,
      mapIconLook: input.look,
      mapIconTrees: input.trees,
      mapIconTreeDensityLevel: input.treeDensity,
      mapIconTreeSize: input.treeSize,
      mapIconTreeSpawnOverlap: input.treeSpawnOverlap,
      mapIconResources: input.resources,
      mapIconResourceDensityLevel: input.resourceDensity,
      mapIconResourceSize: input.resourceSize,
      mapIconResourceSpawnOverlap: input.resourceSpawnOverlap,
    }));
  }

  remapPaths(changes: WorkspacePathChange[]): Promise<void> {
    return this.update((session) => remapDesktopSessionPaths(session, changes));
  }

  removePath(targetPath: string): Promise<void> {
    return this.update((session) => removeDesktopSessionPath(session, targetPath));
  }

  async remove(): Promise<void> {
    this.pendingWrite = this.pendingWrite
      .catch(() => undefined)
      .then(() => rm(this.path, { force: true }));
    return this.pendingWrite;
  }

  private update(transform: (session: DesktopSession) => DesktopSession): Promise<void> {
    this.pendingWrite = this.pendingWrite
      .catch(() => undefined)
      .then(async () => {
        const current = await this.readUnqueued();
        await this.writeUnqueued(validateDesktopSession(transform(current)));
      });
    return this.pendingWrite;
  }

  private async readUnqueued(): Promise<DesktopSession> {
    try {
      const text = (await readFileBounded(this.path, maximumSessionBytes)).toString('utf8');
      return validateDesktopSession(JSON.parse(text));
    } catch {
      return cloneDefaultDesktopSession();
    }
  }

  private async writeUnqueued(session: DesktopSession): Promise<void> {
    const text = JSON.stringify(session);
    if (Buffer.byteLength(text) > maximumSessionBytes) throw new Error('session is too large');
    await replaceFileAtomically(this.path, text);
  }
}

export function cloneDefaultDesktopSession(): DesktopSession {
  return {
    version: 1,
    themePreference: 'system',
    formatOnSave: true,
    indentConditionals: true,
    liveGenerationStages: true,
    gpuMapRendering: true,
    inlayHints: true,
    inlayHintsVersion: inlayHintsSettingVersion,
    deletePermanently: false,
    languagePreference: 'system',
    rmsLintRules: [],
    previewPerspective: 'top-down',
    previewLook: 'minimap',
    previewTileGrid: false,
    gameTexturesFirstLinkApplied: false,
    gameTexturesFirstLinkInstallations: [],
    mapIconRelief: defaultMapIconRenderInput.relief,
    mapIconTerrainSmoothing: defaultMapIconRenderInput.terrainSmoothing,
    mapIconSpawnMarkerStyle: defaultMapIconRenderInput.spawnMarkers,
    mapIconSpawnMarkerSizePercent: defaultMapIconRenderInput.spawnMarkerSizePercent,
    mapIconPerspective: defaultMapIconRenderInput.perspective,
    mapIconLook: defaultMapIconRenderInput.look,
    mapIconTrees: defaultMapIconRenderInput.trees,
    mapIconTreeDensityLevel: defaultMapIconRenderInput.treeDensity,
    mapIconTreeSize: defaultMapIconRenderInput.treeSize,
    mapIconTreeSpawnOverlap: defaultMapIconRenderInput.treeSpawnOverlap,
    mapIconResources: defaultMapIconRenderInput.resources,
    mapIconResourceDensityLevel: defaultMapIconRenderInput.resourceDensity,
    mapIconResourceSize: defaultMapIconRenderInput.resourceSize,
    mapIconResourceSpawnOverlap: defaultMapIconRenderInput.resourceSpawnOverlap,
    window: { bounds: null, maximized: false, display: null },
    layout: {
      explorerExpanded: true,
      explorerWidth: 248,
      previewExpanded: true,
      previewWidth: null,
      bottomPanelHeight: 150,
      bottomPanelTab: 'output',
      profilerOpen: false,
      outputSeverityFilter: { error: true, warning: true, info: true },
      problemsSeverityFilter: { error: true, warning: true, info: false },
      installedSourceOriginFilter: { 'built-in': true, local: true, subscribed: true },
    },
    workspace: {
      folder: null,
      expandedPaths: [],
      selectedPath: null,
      normalTabs: [],
      activePath: null,
    },
    dialogLocations: { ...defaultDesktopSession.dialogLocations },
  };
}

export function migrateInlayHints(value: unknown, version: unknown): boolean {
  if (version !== undefined && version !== inlayHintsSettingVersion) {
    throw new Error('inlay hints setting version is unsupported');
  }
  if (value === undefined) return true;
  const shown = validateBoolean(value, 'inlay hints preference');
  return version === inlayHintsSettingVersion ? shown : true;
}

export function validateDesktopSession(value: unknown): DesktopSession {
  if (!isRecord(value) || value.version !== 1) throw new Error('unsupported session version');
  if (!isRecord(value.window) || !isRecord(value.layout) || !isRecord(value.workspace)) {
    throw new Error('session sections are invalid');
  }
  if (!isRecord(value.dialogLocations)) throw new Error('dialog locations are invalid');
  const normalTabs = validateArray(value.workspace.normalTabs, maximumTabs, validateSessionTab);
  const activePath = validateNullablePath(value.workspace.activePath);
  if (activePath && !normalTabs.some((tab) => pathKey(tab.path) === pathKey(activePath))) {
    throw new Error('active session tab is missing');
  }
  return {
    version: 1,
    themePreference: validateTheme(value.themePreference),
    formatOnSave:
      value.formatOnSave === undefined
        ? true
        : validateBoolean(value.formatOnSave, 'format-on-save preference'),
    indentConditionals:
      value.indentConditionals === undefined
        ? true
        : validateBoolean(value.indentConditionals, 'indent-conditionals preference'),
    liveGenerationStages:
      value.liveGenerationStages === undefined
        ? true
        : validateBoolean(value.liveGenerationStages, 'live generation stages preference'),
    gpuMapRendering:
      value.gpuMapRendering === undefined
        ? true
        : validateBoolean(value.gpuMapRendering, 'GPU map rendering preference'),
    inlayHints: migrateInlayHints(value.inlayHints, value.inlayHintsVersion),
    inlayHintsVersion: inlayHintsSettingVersion,
    deletePermanently:
      value.deletePermanently === undefined
        ? false
        : validateBoolean(value.deletePermanently, 'delete permanently preference'),
    languagePreference:
      value.languagePreference === undefined
        ? 'system'
        : validateLanguagePreference(value.languagePreference),
    rmsLintRules: validateRmsLintWorkspaceRules(value.rmsLintRules),
    previewPerspective:
      value.previewPerspective === undefined
        ? 'top-down'
        : validatePreviewPerspective(value.previewPerspective),
    previewLook:
      value.previewLook === undefined ? 'minimap' : validatePreviewLook(value.previewLook),
    previewTileGrid:
      value.previewTileGrid === undefined
        ? false
        : validateBoolean(value.previewTileGrid, 'preview tile grid preference'),
    gameTexturesFirstLinkApplied:
      value.gameTexturesFirstLinkApplied === undefined
        ? false
        : validateBoolean(value.gameTexturesFirstLinkApplied, 'game textures first-link flag'),
    gameTexturesFirstLinkInstallations:
      value.gameTexturesFirstLinkInstallations === undefined
        ? []
        : validateInstallationIdentities(value.gameTexturesFirstLinkInstallations),
    mapIconRelief:
      value.mapIconRelief === undefined
        ? defaultMapIconRenderInput.relief
        : validateBoolean(value.mapIconRelief, 'map-icon relief preference'),
    mapIconTerrainSmoothing:
      value.mapIconTerrainSmoothing === undefined
        ? defaultMapIconRenderInput.terrainSmoothing
        : validateBoolean(value.mapIconTerrainSmoothing, 'map-icon terrain smoothing preference'),
    mapIconSpawnMarkerStyle: optionalSpawnMarkerStyle(
      value.mapIconSpawnMarkerStyle,
      value.mapIconSpawnMarkers,
    ),
    mapIconSpawnMarkerSizePercent:
      value.mapIconSpawnMarkerSizePercent === undefined
        ? defaultMapIconRenderInput.spawnMarkerSizePercent
        : validateSpawnMarkerSizePercent(value.mapIconSpawnMarkerSizePercent),
    mapIconPerspective:
      value.mapIconPerspective === undefined
        ? defaultMapIconRenderInput.perspective
        : validateMapIconPerspective(value.mapIconPerspective),
    mapIconLook:
      value.mapIconLook === undefined
        ? defaultMapIconRenderInput.look
        : validateMapIconLook(value.mapIconLook),
    mapIconTrees: optionalBoolean(value.mapIconTrees, defaultMapIconRenderInput.trees, 'trees'),
    mapIconTreeDensityLevel: optionalArtDensity(
      value.mapIconTreeDensityLevel,
      value.mapIconTreeDensity,
      defaultMapIconRenderInput.treeDensity,
      'tree density',
    ),
    mapIconTreeSize: optionalArtSize(
      value.mapIconTreeSize,
      defaultMapIconRenderInput.treeSize,
      'tree size',
    ),
    mapIconTreeSpawnOverlap: optionalBoolean(
      value.mapIconTreeSpawnOverlap,
      defaultMapIconRenderInput.treeSpawnOverlap,
      'tree spawn overlap',
    ),
    mapIconResources: optionalBoolean(
      value.mapIconResources,
      defaultMapIconRenderInput.resources,
      'gold and stone',
    ),
    mapIconResourceDensityLevel: optionalArtDensity(
      value.mapIconResourceDensityLevel,
      value.mapIconResourceDensity,
      defaultMapIconRenderInput.resourceDensity,
      'gold and stone density',
    ),
    mapIconResourceSize: optionalArtSize(
      value.mapIconResourceSize,
      defaultMapIconRenderInput.resourceSize,
      'gold and stone size',
    ),
    mapIconResourceSpawnOverlap: optionalBoolean(
      value.mapIconResourceSpawnOverlap,
      defaultMapIconRenderInput.resourceSpawnOverlap,
      'gold and stone spawn overlap',
    ),
    window: {
      bounds: value.window.bounds === null ? null : validateWindowBounds(value.window.bounds),
      maximized: validateBoolean(value.window.maximized, 'maximized state'),
      display:
        value.window.display === undefined
          ? null
          : parseWindowDisplayFingerprint(value.window.display),
    },
    layout: {
      explorerExpanded: validateBoolean(value.layout.explorerExpanded, 'Explorer state'),
      explorerWidth: validateInteger(value.layout.explorerWidth, 220, 420, 'Explorer width'),
      previewExpanded: validateBoolean(value.layout.previewExpanded, 'preview state'),
      previewWidth:
        value.layout.previewWidth === null
          ? null
          : validateInteger(value.layout.previewWidth, 300, 16_384, 'preview width'),
      bottomPanelHeight: validateInteger(
        value.layout.bottomPanelHeight,
        96,
        16_384,
        'bottom-panel height',
      ),
      bottomPanelTab: validateBottomPanelTab(value.layout.bottomPanelTab),
      profilerOpen:
        value.layout.profilerOpen === undefined
          ? false
          : validateBoolean(value.layout.profilerOpen, 'profiler state'),
      outputSeverityFilter:
        value.layout.outputSeverityFilter === undefined
          ? { error: true, warning: true, info: true }
          : validateSeverityFilter(value.layout.outputSeverityFilter, 'Output filter'),
      problemsSeverityFilter:
        value.layout.problemsSeverityFilter === undefined
          ? { error: true, warning: true, info: false }
          : validateSeverityFilter(value.layout.problemsSeverityFilter, 'Problems filter'),
      installedSourceOriginFilter:
        value.layout.installedSourceOriginFilter === undefined
          ? { 'built-in': true, local: true, subscribed: true }
          : validateInstalledSourceOriginFilter(value.layout.installedSourceOriginFilter),
    },
    workspace: {
      folder: value.workspace.folder === null ? null : validateFolder(value.workspace.folder),
      expandedPaths: validateArray(
        value.workspace.expandedPaths,
        maximumExpandedPaths,
        validatePath,
      ),
      selectedPath: validateNullablePath(value.workspace.selectedPath),
      normalTabs,
      activePath,
    },
    dialogLocations: {
      file: validateNullablePath(value.dialogLocations.file),
      folder: validateNullablePath(value.dialogLocations.folder),
      installedSourceClone:
        value.dialogLocations.installedSourceClone === undefined
          ? null
          : validateNullablePath(value.dialogLocations.installedSourceClone),
      mapIconSave:
        value.dialogLocations.mapIconSave === undefined
          ? null
          : validateNullablePath(value.dialogLocations.mapIconSave),
      sourceSave: validateNullablePath(value.dialogLocations.sourceSave ?? null),
      definitionSave: validateNullablePath(value.dialogLocations.definitionSave ?? null),
      mapTestReportImport: validateNullablePath(value.dialogLocations.mapTestReportImport ?? null),
      mapTestReportExport: validateNullablePath(value.dialogLocations.mapTestReportExport ?? null),
      gameFolder: validateNullablePath(value.dialogLocations.gameFolder ?? null),
      controlLauncher: validateNullablePath(value.dialogLocations.controlLauncher ?? null),
    },
  };
}

function validateSessionTab(value: unknown): DesktopSessionTab {
  if (!isRecord(value)) throw new Error('session tab is invalid');
  return {
    path: validatePath(value.path),
    viewState: value.viewState === null ? null : validateMonacoViewState(value.viewState),
  };
}

export function validateMonacoViewState(value: unknown): MonacoViewState {
  if (!isRecord(value)) throw new Error('Monaco view state is invalid');
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > maximumViewStateBytes) {
    throw new Error('Monaco view state is too large');
  }
  const clone = validatePlainData(JSON.parse(serialized), 0, { entries: 0 });
  if (!isRecord(clone) || !Array.isArray(clone.cursorState)) {
    throw new Error('Monaco cursor state is invalid');
  }
  if (!isRecord(clone.viewState) || !isRecord(clone.contributionsState)) {
    throw new Error('Monaco view sections are invalid');
  }
  if (clone.cursorState.length > 32) throw new Error('Monaco selection count is too large');
  return clone as unknown as MonacoViewState;
}

function validatePlainData(value: unknown, depth: number, count: { entries: number }): unknown {
  if (depth > 16 || count.entries > 4096) throw new Error('view state exceeds its bounds');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    count.entries += value.length;
    return value.map((entry) => validatePlainData(entry, depth + 1, count));
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    count.entries += entries.length;
    return Object.fromEntries(
      entries.map(([key, entry]) => {
        if (!/^[A-Za-z0-9_.-]{1,128}$/.test(key)) throw new Error('view state key is invalid');
        return [key, validatePlainData(entry, depth + 1, count)];
      }),
    );
  }
  throw new Error('view state contains unsupported data');
}

function validateWindowBounds(value: unknown): WindowBounds {
  if (!isRecord(value)) throw new Error('window bounds are invalid');
  return {
    x: validateInteger(value.x, -100_000, 100_000, 'window x'),
    y: validateInteger(value.y, -100_000, 100_000, 'window y'),
    width: validateInteger(value.width, 960, 16_384, 'window width'),
    height: validateInteger(value.height, 600, 16_384, 'window height'),
  };
}

function validateFolder(value: unknown): WorkspaceFolder {
  if (!isRecord(value)) throw new Error('workspace folder is invalid');
  return {
    id: validateString(value.id, 'folder id', 256),
    path: validatePath(value.path),
    name: validateString(value.name, 'folder name', 512),
    writable: validateBoolean(value.writable, 'folder writability'),
  };
}

function validateTheme(value: unknown): ThemePreference {
  if (value !== 'system' && value !== 'light' && value !== 'dark') {
    throw new Error('theme preference is invalid');
  }
  return value;
}

function validateLanguagePreference(value: unknown): LanguagePreference {
  if (!isLanguagePreference(value)) throw new Error('language preference is invalid');
  return value;
}

function validateBottomPanelTab(value: unknown): 'problems' | 'output' | 'test-results' {
  if (value !== 'problems' && value !== 'output' && value !== 'test-results') {
    throw new Error('bottom-panel tab is invalid');
  }
  return value;
}

function validateArray<T>(value: unknown, maximum: number, validate: (entry: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error('array is invalid');
  return value.map(validate);
}

function validateNullablePath(value: unknown): string | null {
  return value === null ? null : validatePath(value);
}

function validatePath(value: unknown): string {
  const path = validateString(value, 'path', maximumPathLength);
  if (!isAbsolute(path)) throw new Error('path must be absolute');
  return resolve(path);
}

function validateString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function validateSeverityFilter(value: unknown, label: string): BottomPanelSeverityFilter {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  const filter = value as Record<string, unknown>;
  return {
    error: validateBoolean(filter.error, label),
    warning: validateBoolean(filter.warning, label),
    info: validateBoolean(filter.info, label),
  };
}

function validateInstalledSourceOriginFilter(value: unknown): InstalledSourceOriginFilter {
  const label = 'installed-maps origin filter';
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  const filter = value as Record<string, unknown>;
  return {
    'built-in': validateBoolean(filter['built-in'], label),
    local: validateBoolean(filter.local, label),
    subscribed: validateBoolean(filter.subscribed, label),
  };
}

function validateBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} is invalid`);
  return value;
}

function validateInstallationIdentity(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{32}$/u.test(value)) {
    throw new Error('game textures installation identity is invalid');
  }
  return value;
}

function validateInstallationIdentities(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > maximumGameTexturesFirstLinkInstallations) {
    throw new Error('game textures first-link installations are invalid');
  }
  const identities = value.map(validateInstallationIdentity);
  if (new Set(identities).size !== identities.length) {
    throw new Error('game textures first-link installations repeat');
  }
  return identities;
}

function validateMapIconPerspective(value: unknown): MapIconPerspective {
  if (!mapIconPerspectives.includes(value as MapIconPerspective)) {
    throw new Error('map-icon perspective preference is invalid');
  }
  return value as MapIconPerspective;
}

function validateMapIconLook(value: unknown): MapIconRenderLook {
  if (!mapIconRenderLooks.includes(value as MapIconRenderLook)) {
    throw new Error('map-icon look preference is invalid');
  }
  return value as MapIconRenderLook;
}

function optionalBoolean(value: unknown, fallback: boolean, label: string): boolean {
  return value === undefined ? fallback : validateBoolean(value, `map-icon ${label} preference`);
}

function optionalArtDensity(
  value: unknown,
  legacy: unknown,
  fallback: number,
  label: string,
): number {
  if (value === undefined) {
    if (legacy === undefined) return fallback;
    if (!isMapIconArtDensityV8(legacy)) throw new Error(`map-icon ${label} preference is invalid`);
    return migrateMapIconArtDensityV8(legacy);
  }
  if (!isMapIconArtDensity(value)) throw new Error(`map-icon ${label} preference is invalid`);
  return value;
}

function optionalArtSize(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!isMapIconArtSize(value)) throw new Error(`map-icon ${label} preference is invalid`);
  return value;
}

function optionalSpawnMarkerStyle(value: unknown, legacy: unknown): MapIconSpawnMarkerStyle {
  if (value !== undefined) {
    if (!isMapIconSpawnMarkerStyle(value)) {
      throw new Error('map-icon spawn marker preference is invalid');
    }
    return value;
  }
  if (legacy === undefined) return defaultMapIconRenderInput.spawnMarkers;
  return migrateMapIconSpawnMarkersV9(validateBoolean(legacy, 'map-icon spawn marker preference'));
}

function validateSpawnMarkerSizePercent(value: unknown): number {
  if (!isMapIconSpawnMarkerSizePercent(value)) {
    throw new Error('map-icon spawn marker size preference is invalid');
  }
  return value;
}

function validateInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function remapDesktopSessionPaths(
  session: DesktopSession,
  changes: WorkspacePathChange[],
): DesktopSession {
  const remap = (path: string | null): string | null => {
    if (!path) return null;
    const containing = changes
      .filter((change) => isPathInside(path, change.oldPath))
      .sort((left, right) => left.oldPath.length - right.oldPath.length)[0];
    return containing ? `${containing.newPath}${path.slice(containing.oldPath.length)}` : path;
  };
  return {
    ...session,
    workspace: {
      ...session.workspace,
      expandedPaths: session.workspace.expandedPaths.map((path) => remap(path) as string),
      selectedPath: remap(session.workspace.selectedPath),
      normalTabs: session.workspace.normalTabs.map((tab) => ({ ...tab, path: remap(tab.path)! })),
      activePath: remap(session.workspace.activePath),
    },
    dialogLocations: {
      ...session.dialogLocations,
      file: remap(session.dialogLocations.file),
      folder: remap(session.dialogLocations.folder),
      installedSourceClone: remap(session.dialogLocations.installedSourceClone),
      mapIconSave: remap(session.dialogLocations.mapIconSave),
      sourceSave: remap(session.dialogLocations.sourceSave),
      definitionSave: remap(session.dialogLocations.definitionSave),
      mapTestReportImport: remap(session.dialogLocations.mapTestReportImport),
      mapTestReportExport: remap(session.dialogLocations.mapTestReportExport),
      gameFolder: remap(session.dialogLocations.gameFolder),
      controlLauncher: remap(session.dialogLocations.controlLauncher),
    },
  };
}

function removeDesktopSessionPath(session: DesktopSession, targetPath: string): DesktopSession {
  const beneath = (path: string | null) => path !== null && isPathInside(path, targetPath);
  const normalTabs = session.workspace.normalTabs.filter((tab) => !beneath(tab.path));
  const activePath = beneath(session.workspace.activePath)
    ? (normalTabs[0]?.path ?? null)
    : session.workspace.activePath;
  return {
    ...session,
    workspace: {
      ...session.workspace,
      expandedPaths: session.workspace.expandedPaths.filter((path) => !beneath(path)),
      selectedPath: beneath(session.workspace.selectedPath) ? null : session.workspace.selectedPath,
      normalTabs,
      activePath,
    },
  };
}

function isPathInside(targetPath: string, rootPath: string): boolean {
  const target = pathKey(targetPath);
  const root = pathKey(rootPath).replace(/[\\/]$/, '');
  return target === root || target.startsWith(`${root}\\`) || target.startsWith(`${root}/`);
}

function pathKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function validatePreviewPerspective(value: unknown): PreviewPerspective {
  if (!isPreviewPerspective(value)) throw new Error('preview perspective is invalid');
  return value;
}

function validatePreviewLook(value: unknown): PreviewLook {
  if (!isPreviewLook(value)) throw new Error('preview look is invalid');
  return value;
}
