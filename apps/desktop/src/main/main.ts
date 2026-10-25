import { removeHarnessStartupGuard, underTestHarness } from './harness-startup-guard';
import { DesktopError } from '../shared/desktop-error';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { lstat, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { release as windowsRelease } from 'node:os';
import { basename, delimiter, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  dialog,
  ipcMain as electronIpcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  protocol,
  screen,
  session,
  shell,
  type MenuItem,
  type MenuItemConstructorOptions,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from 'electron';
import { dialogDirectory, type DialogPurpose } from './dialog-location';
import { nativeDialogOpen, withNativeDialog } from './native-dialog';
import {
  applicationMenuModel,
  findApplicationMenuItem,
  reportApplicationMenuClicks,
} from './application-menu-model';
import { isApplicationMenuKey } from '../shared/application-menu-model';
import {
  externalLinkUrls,
  ipcChannels,
  isDeploymentProfileId,
  validateMapIconRenderInput,
  type ApplicationMenuAction,
  type ConfigurationCatalog,
  type ContentPackDescriptor,
  type ControlConnectPurpose,
  type ControlLiveSynchronizationRequest,
  type ControlLiveWorkflowEvent,
  type ControlSessionEvent,
  type DesktopSession,
  type DevelopmentFixtureDescriptor,
  type DevelopmentFixtureRequest,
  type ExplorerClipboardWriteRequest,
  type ExplorerPasteRequest,
  type ExternalLinkTarget,
  type LanguageContentSelection,
  type LanguageServerNotificationMethod,
  type LanguageServerRequestMethod,
  type MapTestEvent,
  type MapTestReplayInput,
  type MapTestRunInput,
  type NativeProcessName,
  type NativeProcessStatus,
  type PreviewGenerationInput,
  type PreviewGenerationResult,
  type PreviewVersionOrigin,
  type RootExecutionKind,
  type ShellOpenTakeResult,
  type ManagedDeploymentApplyRequest,
  type ManagedDeploymentRequest,
  type ManualDeploymentApplyRequest,
  type ManualDeploymentPreviewRequest,
  type RememberedInstallationSelection,
  type ResolvedTheme,
  type SelectedMinimapPalette,
  type ThemePreference,
  type WorkspaceExternalChange,
  type WorkspaceCreateRequest,
  type WorkspaceDeleteRequest,
  type WorkspacePathChange,
  type WorkspaceRenameRequest,
  type WorkspaceSaveAsRequest,
  type WorkspaceSaveRequest,
} from '../shared/api';
import {
  applicationShortcuts,
  isBlockedDeveloperToolsKey,
  matchesShortcut,
  menuActionAllowed,
  menuShortcutItems,
} from '../shared/application-shortcuts';
import {
  aboutDialogButtons,
  aboutDialogText,
  definitionFilesAvailable,
  editionCapabilities,
  editionLanguageNotificationParams,
  externalLinkAllowed,
  inAppUpdateOffered,
  nativeProcessAllowed,
  productIdentity,
  refusedIpcChannels,
} from '../shared/edition';
import { packagedBehaviorProfiles } from '../shared/packaged-game-versions';
import { isExternalLinkTarget } from '../shared/external-links';
import {
  helpMenuItems,
  languageMenuItemVisible,
  liveGenerationStagesMenuState,
  mcpSettingsMenuItem,
  themePanelMenuItem,
} from './menu-items';
import { LocaleService } from './locale-service';
import { deploymentTargetFolderToOpen } from './deployment-target-folder';
import '../shared/i18n/bundled-catalogs';
import { parsePseudoLocaleOverride } from '../shared/i18n/locale';
import { setMessageProblemReporter, t } from '../shared/i18n/translator';
import type { ExecutionProgressEvent } from '../shared/execution-cost';
import {
  validatePreviewCandidateAcknowledgement,
  type PreviewCandidate,
} from '../shared/preview-candidate';
import { validateManualDeploymentMapIconRequest } from '../shared/map-icon-deployment';
import { isSelectedTexturePaletteOrAbsent } from '../shared/texture-palette';
import {
  previewGenerationCancellation,
  settlePreviewGeneration,
} from '../shared/preview-generation-settlement';
import { isMapTestWorkerSetting } from '../shared/map-test-contract';
import { validMapIconSourceRequestId } from '../shared/map-icon-source';
import { presentMessage } from '../shared/message-catalog';
import {
  disabledRmsLintRules,
  isRmsLintCode,
  rmsLintRules,
  withRmsLintRule,
  type RmsLintWorkspaceRules,
} from '../shared/rms-lint-rules';
import { outputNote, type OutputMessage } from '../shared/output-message';
import type { WorkspaceTreeChange } from '../shared/workspace-tree-change';
import { isInstallationReadersBusy, isProtocolCancellation } from './protocol-client';
import {
  cloneDefaultDesktopSession,
  DesktopSessionStore,
  validateDesktopSession,
} from './layout-store';
import {
  displayFingerprint,
  parseWindowDisplayOverride,
  resolveWindowPlacement,
  type PlacementDisplay,
} from './window-placement';
import {
  InstallationSelectionStore,
  detectGameExecutable,
  discoverManualInstallation,
  discoverSteamInstallations,
  installationAccountProfiles,
  nodeInstallationHost,
  readInstallationProductVersion,
  resolveDeploymentUserProfile,
} from './installation-discovery';
import { NativeSupervisor, type NativePaths } from './native-supervisor';
import { XsEnvironmentSource, type XsEnvironmentState } from './xs-environment';
import { xsStartCheckRequest, xsStartCheckWanted } from './xs-start-report';
import * as latencyProbe from './latency-probe';
import { ExecutionLease, type ExecutionLeaseOptions } from './execution-lease';
import {
  handleRendererProtocol,
  isRendererDocumentUrl,
  isRendererOrigin,
  registerRendererScheme,
  rendererDocumentUrl,
} from './renderer-protocol';
import { guardShutdownErrors, shutdownApplication } from './shutdown';
import { PreviewPresentationArbiter } from './preview-presentation-arbiter';
import { admitPreviewTraceLevel } from './preview-trace-policy';
import {
  currentMapTestReplaySourceInput,
  mapTestFindingSettings,
  mapTestReplayGenerationInput,
  mapTestReplayModeContext,
  maximumMapTestReportBytes,
  validateMapTestReportJson,
} from './map-test-report';
import {
  RecoveryStore,
  WorkspaceService,
  isSupportedSourcePath,
  validateRecoverySnapshot,
} from './workspace-service';
import { FileTooLargeError, readFileBounded } from './bounded-file';
import { ExplorerClipboard, electronExplorerClipboardHost } from './explorer-clipboard';
import { OwnSnippetStore, type OwnSnippetStoreReset } from './own-snippet-store';
import { AppTourStore } from './app-tour-store';
import { doneTourProgress, initialTourProgress, validateTourProgress } from '../shared/app-tour';
import {
  SnippetFileError,
  ownSnippetLimits,
  parseSnippetFile,
  serializeSnippetFile,
  validateOwnSnippet,
} from '../shared/own-snippets';
import {
  authorizedGameRoots,
  resolveStandardIncludeAccess,
  SourceCatalogService,
} from './source-catalog-service';
import {
  addPinnedMapTestSource,
  assertMapTestRootCount,
  SourceCatalogBatchBudget,
  SourceCatalogBatchError,
} from './source-catalog-batch';
import { SourceCatalogReadiness } from './source-catalog-readiness';
import { captureSourceExecution } from './source-catalog-execution';
import { EditorInventoryService } from './editor-inventory-service';
import { EditorInventoryCoordinator } from './editor-inventory-coordinator';
import { LanguageDiagnosticAdmission } from './language-diagnostic-admission';
import {
  catalogRefreshFailureReporter,
  editorAssistanceReporter,
  requiredSourceLimitReporter,
  sourceCatalogFailureMessage,
} from './source-catalog-presentation';
import { LocalContentService, type LinkedInstallation } from './local-content-service';
import { editorLanguageContentSelection } from './editor-language-content';
import {
  DefinitionFileService,
  validateDefinitionFileGenerateRequest,
  validateDefinitionFilePrepareRequest,
} from './definition-file-service';
import { LocalPresentationNameService, presentationLanguageFor } from './local-presentation-names';
import {
  GameArtService,
  gameArtTerrainTextureFolder,
  gameTexturesInstallationIdentity,
} from './game-art-service';
import { validateGameArtImageKeys, validateGameArtSpriteRequest } from '../shared/game-art';
import { readLocalStandardIncludePaths } from './standard-resource-policy';
import { InstalledSourceService } from './installed-source-service';
import { saveGeneratedMapIcon, saveManualMapIcon } from './map-icon-save';
import { copyImageToClipboard, savePreviewImage } from './image-export';
import { MapIconSourceCancelled, MapIconSourceGeneration } from './map-icon-source-generation';
import { linkedGameProcessState } from './linked-game-process';
import {
  ManagedDeploymentService,
  hasMatchingPreviewImage,
  managedModDirectoryName,
  type ManagedDeploymentTarget,
} from './managed-deployment-service';
import {
  ControlLauncherPreferenceStore,
  validateControlLauncherExecutable,
} from './control-launcher-preference';
import { NodeControlBridgeHost } from './control-node-host';
import { ControlSessionBridge } from './control-session-bridge';
import { ControlLiveSessionAdapter } from './control-live-adapter';
import { ControlLiveWorkflow } from './control-live-workflow';
import {
  assertAuthorizedControlLivePreview,
  controlLiveDocumentSourceHash,
  type AuthorizedControlLivePreview,
} from './control-live-authorization';
import { readDevelopmentOverrides, type DevelopmentOverrides } from './development-overrides';
import {
  nativeOcclusionFeature,
  showWindowAtBack,
  startWindowStacker,
  windowStackerCommand,
  withDisabledFeature,
  type WindowStacker,
} from './window-stacking';
import {
  createExternalLanguageServers,
  externalLanguageMenuItems,
} from './external-language-integration';
import type { ExternalLanguageServers } from './external-language-servers';
import {
  checkForNewerRelease,
  FileReleaseCheckCacheStore,
  fixtureReleaseTransport,
  releaseRepository,
  StartupReleaseCheck,
  type ReleaseTransport,
} from './release-check';
import {
  netReleaseTransport,
  releaseCheckPartition,
  type NetClientRequest,
} from './release-check-transport';
import { spawn } from 'node:child_process';
import { UpdateService, removeUpdateDownloads } from './update-service';
import { netDownloadTransport, type NetDownloadRequest } from './update-transport';
import { parseUpdateFixture, type UpdateFixture } from './update-fixture';
import {
  handOffOutcomeMessage,
  handOffToInstaller,
  HandOffRecordStore,
  spawnInstallerLauncher,
  unsignedReleasePublisherPolicy,
  type InstallerHandOff,
  type InstallerLauncher,
} from './update-handoff';
import { noUpdate, updateReleaseNotesUrl, type UpdateState } from '../shared/update';
import { editionIpcRegistrar } from './edition-ipc';
import {
  ShellOpenQueue,
  commandLineOpenRequest,
  executeShellOpenPlan,
  forwardedOpenRequest,
  parseForwardedOpenRequest,
  planShellOpen,
  shellOpenNotices,
  type ShellOpenRequest,
} from './shell-open-request';
import {
  defaultAppsNotice,
  defaultAppsSettingsUri,
  detectInstallationKind,
  sessionEndQuitDelayMs,
  windowsBuildNumber,
  type InstallationKind,
} from './windows-integration';
import { constantNamesField } from './content-constant-names';
import { provideConstantNames } from './constant-names-provider';
import { LatestValuePublisher } from './latest-value-publisher';
import { bundledConnectorCatalog } from './connector/catalog';
import { ConnectorService } from './connector/connector-service';
import { connectorSetupFor, registerConnectorIpc } from './connector/ipc';
import { registerFolderTools } from './connector/tools/folder-tools';
import { registerGuideTools } from './connector/tools/guide-tools';
import { ConnectorDiagnosticsStore } from './connector/diagnostics-store';
import { registerWorkspaceTools } from './connector/tools/workspace-tools';
import { validateAppQualityRun } from '../shared/connector-run-api';
import { qualityScriptName } from '../shared/quality-check';
import {
  AppLane,
  AppRunTickets,
  appExecutionLabel,
  busyError,
  isAppRunReference,
  type AppRunTicket,
} from './connector/lane';
import { resolveRunScript, workspaceRelativePath } from './connector/run-paths';
import { registerRunTools } from './connector/tools/run-tools';
import { registerPictureTools, type PictureSheetHost } from './connector/tools/picture-tools';
import { ShownPreviewMaps } from './connector/shown-preview-maps';
import { pictureMapFromPreviewResult } from './pictures/picture-map';
import {
  createBundledPictureWorker,
  createPictureService,
  type PictureService,
} from './pictures/picture-service';
import { createPictureStore } from './pictures/picture-store';
import { GameSession, registerGameTools } from './connector/tools/game-tools';
import type { IdeStatusPart } from './connector/tools/workspace-tools';
import type { ConnectorState } from '../shared/connector-api';

provideConstantNames(constantNamesField);

const ipcMain = editionIpcRegistrar(electronIpcMain, refusedIpcChannels(editionCapabilities));
if (productIdentity.userDataName && !app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', join(app.getPath('appData'), productIdentity.userDataName));
}

let mainWindow: BrowserWindow | undefined;
let supervisor: NativeSupervisor | undefined;
let languageDiagnosticAdmission: LanguageDiagnosticAdmission | undefined;
let externalLanguageServers: ExternalLanguageServers | undefined;
let scheduleEditorInventoryRefresh = () => {};
let disposeEditorInventory = () => {};
let shuttingDown = false;
let applicationMenu: Menu | undefined;
let modalSurfaceOpen = false;
let gameFolderLinked = false;
let openLinkedGameFolderAction: (() => Promise<void>) | undefined;
let resolvedTheme: ResolvedTheme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
let formatOnSavePreference = true;
let indentConditionalsPreference = true;
let liveGenerationStagesPreference = true;
let gpuMapRenderingPreference = true;
let mapTransitionsPreference = true;
let xsStartCheckPreference = true;
let inlayHintsPreference = true;
let outlineRowPreference = true;
let deletePermanentlyPreference = false;
let rmsLintRuleSettings: RmsLintWorkspaceRules[] = [];
let localeService: LocaleService | undefined;
const presentationArbiter = new PreviewPresentationArbiter<MapTestEvent>({
  candidate: (candidate) => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
      return false;
    }
    mainWindow.webContents.send(ipcChannels.previewCandidate, candidate);
    return true;
  },
  final: (event) => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send(ipcChannels.mapTestEvent, event);
    }
  },
});
let mapTestResultsVisible = false;
let mapTestPreviewShown = false;
let insertSnippetAvailable = false;
let saveSnippetAvailable = false;
let ownSnippetStore: OwnSnippetStore | undefined;
let appTourStore: AppTourStore | undefined;
let connectorService: ConnectorService | undefined;
let connectorDiagnostics: ConnectorDiagnosticsStore | undefined;
let publishedApplicationMenuModel = '';
let windowCloseApproved = false;
let rendererUnavailableForClose = false;
const executionLease = new ExecutionLease(publishExecutionState);
const appRunTickets = new AppRunTickets();
let pictureService: PictureService | undefined;
const shownPreviewMaps = new ShownPreviewMaps(pictureMapFromPreviewResult);
let appPictureSheets: PictureSheetHost | undefined;
function registerAppRunTools(service: ConnectorService, userDataPath: string): void {
  let catalog: ReturnType<typeof bundledConnectorCatalog>;
  try {
    catalog = bundledConnectorCatalog();
  } catch {
    return;
  }
  const root = () => workspaceServiceInstance?.workspaceRoot() ?? null;
  const guardWorkspace = {
    root,
    isProtected: (path: string) => workspaceServiceInstance?.isProtectedPath(path) ?? true,
  };
  const lane = new AppLane(executionLease, catalog.limits.busyWaitSeconds * 1000);
  const source = (sourceId: string) => {
    const document = supervisor?.languageDocument(sourceId);
    let file: string | null = null;
    try {
      const absolute = fileURLToPath(sourceId);
      file = workspaceRelativePath(root(), absolute) ?? basename(absolute);
    } catch {
      file = null;
    }
    return { file, text: document?.text ?? null };
  };
  registerRunTools(service.registry, {
    bridge: service.bridge,
    lane,
    tickets: appRunTickets,
    leaseState: () => executionLease.state(),
    resolveScript: (path, kind) => resolveRunScript(guardWorkspace, path, kind),
    relativePath: (absolute) => workspaceRelativePath(root(), absolute),
    source,
    pictureMap: pictureMapFromPreviewResult,
    stopExecution: (executionId) => {
      if (executionLease.state().executionId === executionId) void executionLease.stop();
    },
    qualityAvailable: () => supervisor?.mapTestQualitySupported() ?? false,
    qualityCases: catalog.qualityCases,
    freshSeed: () => randomInt(0, 0x1_0000_0000),
    now: () => Date.now(),
  });
  pictureService ??= createPictureService({
    createWorker: () => createBundledPictureWorker(__dirname),
  });
  const pictures = pictureService;
  const pictureStore = createPictureStore({ userData: userDataPath });
  const unavailable = () => Promise.reject(new Error('contact sheets are not available'));
  registerPictureTools(service.registry, {
    pictures,
    savePicture: (png) => pictureStore.save(png),
    bridge: service.bridge,
    lane,
    leaseState: () => executionLease.state(),
    sheets: {
      withLease: (label, app, stop, work) =>
        appPictureSheets ? appPictureSheets.withLease(label, app, stop, work) : unavailable(),
      generate: (input, seed, id) =>
        appPictureSheets ? appPictureSheets.generate(input, seed, id) : unavailable(),
      cancel: (id) => appPictureSheets?.cancel(id) ?? Promise.resolve(),
      stopAutomatic: () => appPictureSheets?.stopAutomatic(),
    },
    shownMap: (requestHash) =>
      connectorService?.currentSettings().enabled
        ? shownPreviewMaps.picture(requestHash)
        : undefined,
    resolveScript: (path, kind) => resolveRunScript(guardWorkspace, path, kind),
    relativePath: (absolute) => workspaceRelativePath(root(), absolute),
    source,
    pictureMap: pictureMapFromPreviewResult,
    now: () => Date.now(),
  });
}

function registerAppFolderTools(service: ConnectorService, workspace: WorkspaceService): void {
  let catalog: ReturnType<typeof bundledConnectorCatalog>;
  try {
    catalog = bundledConnectorCatalog();
  } catch {
    return;
  }
  registerFolderTools(service.registry, {
    folders: () => workspace.switchFolders(),
    root: () => workspace.workspaceRoot(),
    isProtected: (path) => workspace.isProtectedPath(path),
    lane: new AppLane(executionLease, catalog.limits.busyWaitSeconds * 1000),
    userBusy: () =>
      modalSurfaceOpen || nativeDialogOpen()
        ? 'dialog'
        : workspace.folderActivationPending()
          ? 'opening'
          : null,
    bridge: service.bridge,
  });
}

const appGameSession = new GameSession();

function registerAppGameTools(
  service: ConnectorService,
  addStatusPart: ((part: IdeStatusPart) => () => void) | undefined,
  controlReady: () => Promise<boolean>,
): void {
  let catalog: ReturnType<typeof bundledConnectorCatalog>;
  try {
    catalog = bundledConnectorCatalog();
  } catch {
    return;
  }
  const root = () => workspaceServiceInstance?.workspaceRoot() ?? null;
  registerGameTools(
    service.registry,
    {
      bridge: service.bridge,
      lane: new AppLane(executionLease, catalog.limits.busyWaitSeconds * 1000),
      tickets: appRunTickets,
      leaseState: () => executionLease.state(),
      resolveScript: (path, kind) =>
        resolveRunScript(
          {
            root,
            isProtected: (candidate: string) =>
              workspaceServiceInstance?.isProtectedPath(candidate) ?? true,
          },
          path,
          kind,
        ),
      relativePath: (absolute) => workspaceRelativePath(root(), absolute),
      stopExecution: (executionId) => {
        if (executionLease.state().executionId === executionId) void executionLease.stop();
      },
      session: appGameSession,
      allowedSince: (app) =>
        service.state().allowedApps.find((entry) => entry.name === app)?.firstAllowed ?? null,
      controlReady,
      gameFolderLinked: () => gameFolderLinked,
      freshSeed: () => randomInt(0, 0x1_0000_0000),
      now: () => Date.now(),
    },
    addStatusPart,
  );
}

function sourceFileDialogFilter(): Electron.FileFilter {
  return editionCapabilities.mapTests
    ? {
        name: t('native-dialog.source-files.filter.map-tests'),
        extensions: ['rms', 'rms2', 'inc', 'def', 'xs', 'rmstest'],
      }
    : {
        name: t('native-dialog.source-files.filter'),
        extensions: ['rms', 'rms2', 'inc', 'def', 'xs'],
      };
}

const developmentFixtureDescriptors: DevelopmentFixtureDescriptor[] = [
  {
    id: 'representative',
    label: 'Representative map',
    description: 'A fixed uncertified map using the current preview settings.',
  },
  {
    id: 'colocated',
    label: 'Colocated layers',
    description: 'An uncertified map with deterministically colocated foreground objects.',
  },
  {
    id: 'legend',
    label: 'Dense layer legend',
    description: 'An uncertified map with many layers and mixed provenance on one tile.',
  },
  {
    id: 'large',
    label: 'Largest map',
    description: 'A 480×480 uncertified map for chunking and interaction checks.',
  },
  {
    id: 'delayed',
    label: 'Delayed result',
    description: 'An uncertified map delayed long enough to expose live progress state.',
  },
  {
    id: 'failure',
    label: 'Failure after analysis',
    description: 'A deterministic generation failure used to verify preview failure handling.',
  },
  {
    id: 'cancellable',
    label: 'Cancellable slow result',
    description: 'A slow uncertified request used to verify supersession and cancellation timing.',
  },
];
let windowCloseRequestPending = false;
let sessionEndCloseStarted = false;
const shellOpenQueue = new ShellOpenQueue();
let installationKind: InstallationKind = 'development';
let startupReleaseCheck = new StartupReleaseCheck(null);
let checkForNewVersionsPreference = true;
let updateService: UpdateService | undefined;
let handOffRecords: HandOffRecordStore | undefined;
let pendingHandOffNote: OutputMessage | null = null;
let desktopSessionStore: DesktopSessionStore | undefined;
let workspaceServiceInstance: WorkspaceService | undefined;
let recoveryStoreInstance: RecoveryStore | undefined;
let controlSessionBridgeInstance: ControlSessionBridge | undefined;
const controlLiveAbortControllers = new Map<string, AbortController>();
let recentMenuEntries: Awaited<ReturnType<WorkspaceService['recentEntries']>> = [];
let windowStateTimer: NodeJS.Timeout | undefined;
const defaultWindowSize = Object.freeze({
  width: 1440,
  height: 900,
  minimumWidth: 960,
  minimumHeight: 600,
});

const titleBarPalette = {
  light: { background: '#f8f8f8', foreground: '#252525' },
  dark: { background: '#171717', foreground: '#fafafa' },
} as const;

const commandLineOptions = { skipLeadingPositional: Boolean(process.defaultApp) };
const launchOpenRequest = commandLineOpenRequest(process.argv, process.cwd(), commandLineOptions);
registerRendererScheme(protocol);

const hasSingleInstanceLock = app.requestSingleInstanceLock(
  forwardedOpenRequest(launchOpenRequest) as unknown as Record<string, unknown>,
);
const windowStacker: WindowStacker | null =
  hasSingleInstanceLock && developmentOverrides().windowsAtBack ? startTestWindowStacking() : null;

function startTestWindowStacking(): WindowStacker {
  app.commandLine.appendSwitch(
    'disable-features',
    withDisabledFeature(app.commandLine.getSwitchValue('disable-features'), nativeOcclusionFeature),
  );
  const { file, args } = windowStackerCommand(process.env.SystemRoot);
  return startWindowStacker(() =>
    spawn(file, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }),
  );
}
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  queueShellOpenRequest(launchOpenRequest);
  app.on('second-instance', (_event, commandLine, workingDirectory, additionalData) => {
    queueShellOpenRequest(
      parseForwardedOpenRequest(additionalData) ??
        commandLineOpenRequest(commandLine, workingDirectory, commandLineOptions),
    );
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    if (!mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send(ipcChannels.shellOpenPending);
    }
  });

  app
    .whenReady()
    .then(createApplication)
    .catch((error: unknown) => {
      console.error(error);
      app.exit(1);
    });
}

function queueShellOpenRequest(request: ShellOpenRequest): void {
  if (request.targets.length === 0 && request.refusal === null) return;
  shellOpenQueue.enqueue(planShellOpen(request, { realpath, stat }, isSupportedSourcePath));
}

async function readSmallText(path: string, maximumBytes: number): Promise<string | null> {
  try {
    return (await readFileBounded(path, maximumBytes)).toString('utf8');
  } catch {
    return null;
  }
}

async function openDefaultAppsSettings(): Promise<void> {
  try {
    await shell.openExternal(defaultAppsSettingsUri(windowsBuildNumber(windowsRelease())));
    publishWorkspaceDiagnostic(
      outputNote(
        'App',
        defaultAppsNotice.code,
        { id: 'app-menu.file.choose-default-app.notice.headline' },
        { cause: { id: 'app-menu.file.choose-default-app.notice.cause' } },
      ),
    );
  } catch (error) {
    publishWorkspaceDiagnostic(
      presentMessage({
        source: 'App',
        raw: errorMessage(error),
        fallbackHeadline: 'app-menu.file.choose-default-app.failed',
      }),
    );
  }
}

function developmentFixturesEnabled(): boolean {
  return developmentOverrides().developmentFixtures;
}

function developmentOverrides(): DevelopmentOverrides {
  return readDevelopmentOverrides(app.isPackaged, process.env);
}

function createStartupReleaseCheck(userDataPath: string): StartupReleaseCheck {
  if (!editionCapabilities.releaseCheck) return new StartupReleaseCheck(null);
  let transport: () => ReleaseTransport | null;
  if (app.isPackaged) {
    if (underTestHarness()) return new StartupReleaseCheck(null);
    transport = () =>
      netReleaseTransport(
        (options) => net.request(options) as unknown as NetClientRequest,
        session.fromPartition(releaseCheckPartition),
      );
  } else {
    const fixture = developmentOverrides().releaseCheckFixture;
    if (fixture === undefined) return new StartupReleaseCheck(null);
    transport = () => fixtureReleaseTransport(fixture);
  }
  return new StartupReleaseCheck(
    async () => {
      const chosen = transport();
      if (!chosen) return { kind: 'quiet', reason: 'unavailable' };
      return checkForNewerRelease({
        currentVersion: productIdentity.version,
        transport: chosen,
        cache: new FileReleaseCheckCacheStore(userDataPath),
      });
    },
    {
      enabled: () => checkForNewVersionsPreference,
      onNewer: (outcome) => updateService?.offer(outcome.version),
    },
  );
}

function updateFixtureOverride(): UpdateFixture | null {
  if (app.isPackaged) return null;
  const text = developmentOverrides().updateFixture;
  return text === undefined ? null : parseUpdateFixture(text);
}

function createUpdateService(userDataPath: string): {
  service: UpdateService | undefined;
  launcher: InstallerLauncher;
} {
  const fixture = updateFixtureOverride();
  const offered = inAppUpdateOffered(
    editionCapabilities,
    fixture ? fixture.installation : installationKind,
  );
  const launcher: InstallerLauncher = fixture
    ? {
        launch: (path, args) =>
          writeFile(
            join(userDataPath, 'update-launch-fixture.json'),
            JSON.stringify({ path, args }),
          ),
      }
    : spawnInstallerLauncher(spawn);
  if (!offered) return { service: undefined, launcher };
  if (fixture) {
    (
      globalThis as typeof globalThis & { __rmsideUpdateFixtureRequests?: readonly string[] }
    ).__rmsideUpdateFixtureRequests = fixture.requests;
  }
  const downloadDirectory = fixture
    ? join(userDataPath, 'update-download')
    : join(app.getPath('temp'), 'AoE2RMSIDE-update');
  void removeUpdateDownloads(downloadDirectory);
  const releaseSession = () => session.fromPartition(releaseCheckPartition);
  const service = new UpdateService({
    currentVersion: productIdentity.version,
    offered: true,
    releaseTransport: () =>
      fixture
        ? fixture.releaseTransport
        : netReleaseTransport(
            (options) => net.request(options) as unknown as NetClientRequest,
            releaseSession(),
          ),
    downloadTransport: () =>
      fixture
        ? fixture.downloadTransport
        : netDownloadTransport(
            (options) => net.request(options) as unknown as NetDownloadRequest,
            releaseSession(),
          ),
    downloadDirectory,
    publisherPolicy: unsignedReleasePublisherPolicy,
    publish: publishWorkspaceDiagnostic,
    onState: publishUpdateState,
    requestClose: () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
      else app.quit();
    },
  });
  return { service, launcher };
}

function publishUpdateState(state: UpdateState): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(ipcChannels.updateEvent, state);
  }
}

let installerLauncher: InstallerLauncher = spawnInstallerLauncher(spawn);

async function finishQuit(): Promise<void> {
  const handOff: InstallerHandOff | null = updateService?.takeHandOff() ?? null;
  const bound = new Promise<void>((resolve) => setTimeout(resolve, 15_000));
  const work = (async () => {
    if (!handOff) {
      await updateService?.dispose();
      return;
    }
    try {
      await handOffToInstaller({
        handOff,
        records: handOffRecords ?? { write: async () => undefined },
        launcher: installerLauncher,
        environment: process.env,
      });
    } catch (error) {
      console.error('the update installer did not start', error);
      app.relaunch();
    }
  })();
  await Promise.race([work, bound]).catch(() => undefined);
  app.exit(0);
}

function userProfileOptions(): { userProfileRoot?: string } {
  const { userProfileRoot } = developmentOverrides();
  return userProfileRoot ? { userProfileRoot } : {};
}

async function createApplication(): Promise<void> {
  latencyProbe.startup('app-ready');
  windowCloseApproved = false;
  windowCloseRequestPending = false;
  rendererUnavailableForClose = false;
  mapTestResultsVisible = false;
  mapTestPreviewShown = false;
  insertSnippetAvailable = false;
  saveSnippetAvailable = false;
  disposeEditorInventory();
  scheduleEditorInventoryRefresh = () => {};
  disposeEditorInventory = () => {};
  languageDiagnosticAdmission = undefined;
  const nativePaths = resolveNativePaths();
  supervisor = new NativeSupervisor(
    nativePaths,
    publishNativeStatus,
    (method, params, nativeGeneration) => {
      if (
        method === 'textDocument/publishDiagnostics' &&
        nativeGeneration !== undefined &&
        languageDiagnosticAdmission
      ) {
        languageDiagnosticAdmission.enqueue(params, nativeGeneration);
      } else publishLanguageServerNotification(method, params);
    },
  );
  const userDataPath = app.getPath('userData');
  const protectedRoots = (developmentOverrides().protectedSourceRoots ?? '')
    .split(delimiter)
    .filter(Boolean);
  desktopSessionStore = new DesktopSessionStore(userDataPath);
  startupReleaseCheck = createStartupReleaseCheck(userDataPath);
  workspaceServiceInstance = new WorkspaceService(
    userDataPath,
    protectedRoots,
    publishWorkspaceExternalChange,
    publishWorkspaceDiagnostic,
  );
  workspaceServiceInstance.onTreeChange(publishWorkspaceTreeChange);
  const { externalRmsServerPath, externalXsServerPath } = developmentOverrides();
  externalLanguageServers = createExternalLanguageServers({
    userDataPath,
    workspaceRoot: () => workspaceServiceInstance?.workspaceRoot() ?? null,
    overrides: {
      ...(externalRmsServerPath ? { rms: externalRmsServerPath } : {}),
      ...(externalXsServerPath ? { xs: externalXsServerPath } : {}),
    },
    underTestHarness: underTestHarness(),
    clientVersion: productIdentity.version,
    publishOutput: publishWorkspaceDiagnostic,
    publishDiagnostics: (params) =>
      sendLanguageServerEvent('textDocument/publishDiagnostics', params),
    onAvailabilityChanged: () => {
      if (!shuttingDown) refreshApplicationMenu();
    },
  });
  recoveryStoreInstance = new RecoveryStore(userDataPath);
  ownSnippetStore = new OwnSnippetStore(userDataPath, (reset) =>
    publishWorkspaceDiagnostic(ownSnippetStoreResetNote(reset)),
  );
  appTourStore = new AppTourStore(
    userDataPath,
    developmentOverrides().tourDone ? doneTourProgress : initialTourProgress,
  );
  const installationSelectionStore = new InstallationSelectionStore(userDataPath);
  const controlLauncherPreference = new ControlLauncherPreferenceStore(userDataPath);
  controlSessionBridgeInstance = new ControlSessionBridge(
    controlLauncherPreference,
    new NodeControlBridgeHost(undefined, supervisor.controlPipeTransport),
    publishControlSessionEvent,
  );
  const initialSession = await desktopSessionStore.read();
  if (!app.isPackaged) setMessageProblemReporter((problem) => console.warn(`i18n: ${problem}`));
  localeService = new LocaleService({
    systemLocales: () => {
      const preferred = app.getPreferredSystemLanguages();
      return preferred.length > 0 ? preferred : [app.getLocale()];
    },
    developer: !app.isPackaged,
    preference: initialSession.languagePreference,
    pseudoOverride: app.isPackaged
      ? null
      : parsePseudoLocaleOverride(developmentOverrides().pseudoLocale),
  });
  formatOnSavePreference = initialSession.formatOnSave;
  indentConditionalsPreference = initialSession.indentConditionals;
  liveGenerationStagesPreference = initialSession.liveGenerationStages;
  gpuMapRenderingPreference = initialSession.gpuMapRendering;
  mapTransitionsPreference = developmentOverrides().mapTransitions ?? initialSession.mapTransitions;
  xsStartCheckPreference = initialSession.xsStartCheck;
  inlayHintsPreference = initialSession.inlayHints;
  outlineRowPreference = initialSession.outlineRow;
  deletePermanentlyPreference = initialSession.deletePermanently;
  rmsLintRuleSettings = initialSession.rmsLintRules;
  installationKind = await detectInstallationKind({
    isPackaged: app.isPackaged,
    executablePath: process.execPath,
    resourcesPath: process.resourcesPath,
    readText: readSmallText,
    realpath,
  });
  checkForNewVersionsPreference = initialSession.checkForNewVersions;
  const update = createUpdateService(userDataPath);
  updateService = update.service;
  installerLauncher = update.launcher;
  handOffRecords = updateService ? new HandOffRecordStore(userDataPath) : undefined;
  const handOffRecord = await handOffRecords?.take();
  pendingHandOffNote = handOffRecord
    ? handOffOutcomeMessage(handOffRecord, productIdentity.version)
    : null;
  resolvedTheme =
    initialSession.themePreference === 'system'
      ? nativeTheme.shouldUseDarkColors
        ? 'dark'
        : 'light'
      : initialSession.themePreference;
  registerIpc(
    supervisor,
    desktopSessionStore,
    workspaceServiceInstance,
    recoveryStoreInstance,
    installationSelectionStore,
    controlLauncherPreference,
    controlSessionBridgeInstance,
  );
  recentMenuEntries = await workspaceServiceInstance.recentEntries();
  workspaceServiceInstance.onWorkspaceRootChange(() => {
    applyRmsLintSettings();
    refreshApplicationMenu();
  });
  applyRmsLintSettings();
  const rememberedInstallation = await installationSelectionStore.read();
  gameFolderLinked = Boolean(
    rememberedInstallation &&
    (
      await discoverManualInstallation(
        rememberedInstallation.installationRoot,
        nodeInstallationHost,
        userProfileOptions(),
      )
    ).valid,
  );
  refreshApplicationMenu();
  if (editionCapabilities.gameTextures && gameFolderLinked && rememberedInstallation) {
    await desktopSessionStore.recordGameTexturesInstallation(
      gameTexturesInstallationIdentity(rememberedInstallation.installationRoot),
    );
  }

  const initialTitleBarPalette = titleBarPalette[resolvedTheme];
  const placement = initialWindowPlacement(initialSession);
  const placedBounds = placement.bounds;

  installRendererPermissionPolicy();
  handleRendererProtocol(session.defaultSession.protocol, join(__dirname, 'renderer'));
  mainWindow = new BrowserWindow({
    autoHideMenuBar: true,
    backgroundColor: initialTitleBarPalette.background,
    height: placedBounds?.height ?? defaultWindowSize.height,
    icon: resolveWindowIconPath(),
    minHeight: defaultWindowSize.minimumHeight,
    minWidth: defaultWindowSize.minimumWidth,
    ...(windowStacker ? { focusable: false } : {}),
    show: false,
    title: productIdentity.displayName,
    titleBarOverlay: {
      color: initialTitleBarPalette.background,
      height: 40,
      symbolColor: initialTitleBarPalette.foreground,
    },
    titleBarStyle: 'hidden',
    webPreferences: {
      ...(windowStacker ? { backgroundThrottling: false } : {}),
      contextIsolation: true,
      devTools: !app.isPackaged,
      nodeIntegration: false,
      preload: join(__dirname, 'preload.cjs'),
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
    width: placedBounds?.width ?? defaultWindowSize.width,
    ...(placedBounds ? { x: placedBounds.x, y: placedBounds.y } : {}),
  });
  removeHarnessStartupGuard();
  latencyProbe.startup('window-created');
  if (placedBounds) mainWindow.setBounds(placedBounds);
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isRendererDocumentUrl(url)) event.preventDefault();
  });
  mainWindow.webContents.on('will-frame-navigate', (event) => {
    if (!isRendererDocumentUrl(event.url)) event.preventDefault();
  });
  mainWindow.webContents.on('will-redirect', (event, url) => {
    if (!isRendererDocumentUrl(url)) event.preventDefault();
  });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.webContents.on('context-menu', (_event, parameters) => {
    showSelectionContextMenu(parameters.selectionText, parameters.editFlags.canCopy);
  });
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && dispatchMenuShortcut(input)) {
      event.preventDefault();
      return;
    }
    if (app.isPackaged && isBlockedDeveloperToolsKey(input)) event.preventDefault();
  });
  mainWindow.webContents.on('did-navigate', () => {
    modalSurfaceOpen = false;
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    modalSurfaceOpen = false;
    rendererUnavailableForClose = true;
    windowCloseRequestPending = false;
    console.error(`renderer process exited: ${details.reason}`);
  });
  mainWindow.on('unresponsive', () => {
    rendererUnavailableForClose = true;
    windowCloseRequestPending = false;
  });
  mainWindow.on('responsive', () => {
    rendererUnavailableForClose = false;
  });
  mainWindow.once('ready-to-show', () => {
    if (windowStacker && mainWindow) {
      void showWindowAtBack(mainWindow, windowStacker, placement.maximized);
      return;
    }
    if (placement.maximized) mainWindow?.maximize();
    mainWindow?.show();
  });
  mainWindow.on('move', scheduleWindowStateSave);
  mainWindow.on('resize', scheduleWindowStateSave);
  mainWindow.on('maximize', scheduleWindowStateSave);
  mainWindow.on('unmaximize', scheduleWindowStateSave);
  mainWindow.on('close', (event) => {
    if (
      windowCloseApproved ||
      rendererUnavailableForClose ||
      mainWindow?.webContents.isDestroyed() ||
      mainWindow?.webContents.isCrashed()
    ) {
      flushWindowStateSave();
      if (!sessionEndCloseStarted) updateService?.windowClosing();
      return;
    }
    event.preventDefault();
    if (windowCloseRequestPending) return;
    windowCloseRequestPending = true;
    mainWindow?.webContents.send(ipcChannels.windowCloseRequested);
  });
  mainWindow.on('session-end', () => closeForSessionEnd());
  mainWindow.on('closed', () => {
    modalSurfaceOpen = false;
    if (windowStateTimer) clearTimeout(windowStateTimer);
    windowStateTimer = undefined;
    rendererUnavailableForClose = false;
    mainWindow = undefined;
  });
  registerConnectorIpc(ipcMain, {
    service: () => connectorService,
    assertSender: (event) => {
      const invoke = event as Electron.IpcMainInvokeEvent;
      assertTrustedSender(invoke.senderFrame?.url);
      assertMainWindowSender(invoke.sender);
    },
  });
  if (editionCapabilities.mcp) {
    const sendToRenderer = (channel: string, value: unknown): boolean => {
      if (!mainWindow || mainWindow.isDestroyed() || rendererUnavailableForClose) return false;
      mainWindow.webContents.send(channel, value);
      return true;
    };
    const connectorStatePublisher = new LatestValuePublisher<ConnectorState>(
      (state) => sendToRenderer(ipcChannels.connectorStateEvent, state),
      100,
    );
    connectorService = new ConnectorService({
      userDataPath,
      ideVersion: productIdentity.version,
      catalog: bundledConnectorCatalog,
      publishState: (state) => connectorStatePublisher.offer(state),
      publishRow: (row) => sendToRenderer(ipcChannels.connectorOutputEvent, row),
      sendRequest: (request) => sendToRenderer(ipcChannels.connectorRequestEvent, request),
      setup: () =>
        connectorSetupFor({
          packaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          appPath: app.getAppPath(),
          appDataPath: app.getPath('appData'),
          userDataPath,
        }),
      onPairingRequested: () => {
        if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) {
          mainWindow.flashFrame(true);
        }
      },
      log: (message, error) =>
        error === undefined ? console.error(message) : console.error(message, error),
    });
    registerGuideTools(connectorService.registry, {
      lookupReference: (params) =>
        supervisor
          ? supervisor.referenceLookup(params)
          : Promise.reject(new Error('rms-ls is not running')),
    });
    connectorDiagnostics = new ConnectorDiagnosticsStore();
    const toolWorkspace = workspaceServiceInstance;
    const toolNatives = supervisor;
    let workspaceTools: ReturnType<typeof registerWorkspaceTools> | undefined;
    if (toolWorkspace && toolNatives) {
      workspaceTools = registerWorkspaceTools(connectorService.registry, {
        workspace: {
          root: () => toolWorkspace.workspaceRoot(),
          isProtected: (path) => toolWorkspace.isProtectedPath(path),
          isReservedName: (name) => toolWorkspace.standardResources.isReservedFileName(name),
          grantFolder: (path) => toolWorkspace.grantWorkspaceFolder(path),
          createEntry: (request) => toolWorkspace.createEntry(request),
        },
        documents: { document: (uri) => toolNatives.languageDocument(uri) },
        diagnostics: connectorDiagnostics,
        bridge: connectorService.bridge,
        lane: () => executionLease.state(),
        gameFolderLinked: () => gameFolderLinked,
      });
    }
    if (toolWorkspace) registerAppFolderTools(connectorService, toolWorkspace);
    registerAppRunTools(connectorService, userDataPath);
    registerAppGameTools(connectorService, workspaceTools?.addStatusPart, async () => {
      const status = await controlLauncherPreference.status().catch(() => null);
      return status?.state === 'ready';
    });
    mainWindow.webContents.on('did-navigate', () => connectorService?.rendererReset());
    mainWindow.webContents.on('render-process-gone', () => connectorService?.rendererReset());
    void connectorService
      .initialize()
      .catch((error: unknown) => console.error('the MCP connector did not start', error));
  }
  const nativesStarted = supervisor.startAll();
  await mainWindow.loadURL(rendererDocumentUrl);
  latencyProbe.startup('renderer-loaded');
  await nativesStarted;
  latencyProbe.startup('natives-ready');
  void externalLanguageServers?.start().catch((error: unknown) => console.error(error));
}

function mcpMenuItems(): MenuItemConstructorOptions[] {
  const item = mcpSettingsMenuItem(editionCapabilities);
  return item ? [{ ...item, click: () => publishMenuAction({ type: 'open-mcp-settings' }) }] : [];
}

function createApplicationMenu(): Menu {
  const linkedGameFolderItems: MenuItemConstructorOptions[] = gameFolderLinked
    ? [
        {
          id: 'file.open-linked-game-folder',
          label: t('app-menu.file.open-linked-game-folder'),
          click: () => {
            if (modalSurfaceOpen) return;
            void openLinkedGameFolderAction?.().catch((error: unknown) => {
              publishWorkspaceDiagnostic(
                presentMessage({
                  source: 'Game folder',
                  raw: errorMessage(error),
                  fallbackHeadline: 'app-menu.file.open-linked-game-folder.failed',
                }),
              );
            });
          },
        },
        {
          id: 'file.unlink-game-folder',
          label: t('app-menu.file.unlink-game-folder'),
          click: () => publishMenuAction({ type: 'unlink-game-folder' }),
        },
      ]
    : [];
  const stagesMenu = liveGenerationStagesMenuState(mapTestPreviewShown);
  const importMapTestReportItems: MenuItemConstructorOptions[] =
    mapTestResultsVisible || !editionCapabilities.mapTests
      ? []
      : [
          { type: 'separator' },
          {
            id: 'file.import-map-test-report',
            label: t('app-menu.file.import-map-test-report'),
            click: () => publishMenuAction({ type: 'import-map-test-report' }),
          },
        ];
  const defaultAppItems: MenuItemConstructorOptions[] =
    editionCapabilities.windowsRegistration && installationKind === 'installed'
      ? [
          { type: 'separator' },
          {
            id: 'file.choose-default-app',
            label: t('app-menu.file.choose-default-app'),
            click: () => {
              if (modalSurfaceOpen) return;
              void openDefaultAppsSettings();
            },
          },
        ]
      : [];
  const template: MenuItemConstructorOptions[] = [
    {
      id: 'menu.file',
      label: t('app-menu.file.name'),
      submenu: [
        ...(editionCapabilities.newRmsScript
          ? [
              {
                id: 'file.new',
                label: t('app-menu.file.new-file'),
                accelerator: 'CmdOrCtrl+N',
                click: () => publishMenuAction({ type: 'new-file' }),
              },
            ]
          : []),
        ...(editionCapabilities.mapTests
          ? [
              {
                id: 'file.new-map-test-script',
                label: t('app-menu.file.new-map-test-script'),
                click: () => publishMenuAction({ type: 'new-map-test-script' }),
              },
            ]
          : []),
        ...(definitionFilesAvailable(editionCapabilities)
          ? [
              {
                id: 'file.generate-definition-file',
                label: t('app-menu.file.generate-definition-file'),
                click: () => publishMenuAction({ type: 'generate-definition-file' }),
              },
            ]
          : []),
        {
          id: 'file.new-xs-script',
          label: t('app-menu.file.new-xs-script'),
          ...(editionCapabilities.newRmsScript ? {} : { accelerator: 'CmdOrCtrl+N' }),
          click: () => publishMenuAction({ type: 'new-xs-script' }),
        },
        {
          id: 'file.open-file',
          label: t('app-menu.file.open-file'),
          accelerator: 'CmdOrCtrl+O',
          click: () => publishMenuAction({ type: 'open-file' }),
        },
        {
          id: 'file.open-folder',
          label: t('app-menu.file.open-folder'),
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => publishMenuAction({ type: 'open-folder' }),
        },
        {
          id: 'file.find-in-files',
          label: t('app-menu.file.find-in-files'),
          accelerator: applicationShortcuts.findInFiles,
          enabled: Boolean(workspaceServiceInstance?.workspaceRoot()),
          click: () => {
            if (workspaceServiceInstance?.workspaceRoot()) {
              publishMenuAction({ type: 'find-in-files' });
            }
          },
        },
        ...(editionCapabilities.installedSourceBrowser
          ? [
              {
                id: 'file.browse-installed-sources',
                label: t('app-menu.file.browse-installed-sources'),
                accelerator: applicationShortcuts.browseInstalledSources,
                click: () => publishMenuAction({ type: 'browse-installed-sources' }),
              },
            ]
          : []),
        ...(editionCapabilities.deployment
          ? [
              {
                id: 'file.deploy-managed-mod',
                label: t('app-menu.file.deploy-managed-mod'),
                accelerator: applicationShortcuts.deployManagedMod,
                click: () => publishMenuAction({ type: 'deploy-managed-mod' }),
              },
            ]
          : []),
        ...linkedGameFolderItems,
        {
          id: 'file.open-recent',
          label: t('app-menu.file.open-recent'),
          submenu:
            recentMenuEntries.length > 0
              ? recentMenuEntries.map((entry, index) => ({
                  id: `file.open-recent.${index}`,
                  label: entry.name,
                  sublabel: entry.path,
                  click: () => publishMenuAction({ type: 'open-recent', path: entry.path }),
                }))
              : [{ enabled: false, label: t('app-menu.file.open-recent.empty') }],
        },
        ...importMapTestReportItems,
        { type: 'separator' },
        {
          id: 'file.save',
          label: t('app-menu.file.save'),
          accelerator: 'CmdOrCtrl+S',
          click: () => publishMenuAction({ type: 'save' }),
        },
        {
          id: 'file.save-as',
          label: t('app-menu.file.save-as'),
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => publishMenuAction({ type: 'save-as' }),
        },
        { type: 'separator' },
        {
          id: 'file.close-tab',
          label: t('app-menu.file.close-tab'),
          accelerator: 'CmdOrCtrl+W',
          click: () => publishMenuAction({ type: 'close-tab' }),
        },
        {
          id: 'file.close-folder',
          label: t('app-menu.file.close-folder'),
          click: () => publishMenuAction({ type: 'close-folder' }),
        },
        ...defaultAppItems,
        { type: 'separator' },
        { label: t('app-menu.file.close-window'), role: 'close' },
        { type: 'separator' },
        { label: t('app-menu.file.exit'), role: 'quit' },
      ],
    },
    {
      id: 'menu.edit',
      label: t('app-menu.edit.name'),
      submenu: [
        {
          id: 'edit.undo',
          label: t('app-menu.edit.undo'),
          accelerator: 'CmdOrCtrl+Z',
          click: () => publishMenuAction({ type: 'undo' }),
        },
        {
          id: 'edit.redo',
          label: t('app-menu.edit.redo'),
          accelerator: 'CmdOrCtrl+Y',
          click: () => publishMenuAction({ type: 'redo' }),
        },
        { type: 'separator' },
        { label: t('app-menu.edit.cut'), role: 'cut' },
        { label: t('app-menu.edit.copy'), role: 'copy' },
        { label: t('app-menu.edit.paste'), role: 'paste' },
        { label: t('app-menu.edit.select-all'), role: 'selectAll' },
        { type: 'separator' },
        {
          id: 'edit.insert-snippet',
          label: t('app-menu.edit.insert-snippet'),
          accelerator: applicationShortcuts.insertSnippet,
          enabled: insertSnippetAvailable,
          click: () => publishMenuAction({ type: 'insert-snippet' }),
        },
        {
          id: 'edit.save-snippet',
          label: t('app-menu.edit.save-snippet'),
          accelerator: applicationShortcuts.saveSnippet,
          enabled: saveSnippetAvailable,
          click: () => publishMenuAction({ type: 'save-snippet' }),
        },
        {
          id: 'edit.format-document',
          label: t('app-menu.edit.format-document'),
          accelerator: 'Shift+Alt+F',
          click: () => publishMenuAction({ type: 'format-document' }),
        },
        {
          id: 'edit.format-on-save',
          label: t('app-menu.edit.format-on-save'),
          type: 'checkbox',
          checked: formatOnSavePreference,
          click: (item) => {
            const enabled =
              item.checked === formatOnSavePreference ? !formatOnSavePreference : item.checked;
            item.checked = enabled;
            formatOnSavePreference = enabled;
            void desktopSessionStore?.updateFormatOnSave(enabled);
            publishMenuAction({ type: 'set-format-on-save', enabled });
          },
        },
        {
          id: 'edit.indent-conditionals',
          label: t('app-menu.edit.indent-conditionals'),
          type: 'checkbox',
          checked: indentConditionalsPreference,
          click: (item) => {
            const enabled =
              item.checked === indentConditionalsPreference
                ? !indentConditionalsPreference
                : item.checked;
            item.checked = enabled;
            indentConditionalsPreference = enabled;
            void desktopSessionStore?.updateIndentConditionals(enabled);
            publishMenuAction({ type: 'set-indent-conditionals', enabled });
          },
        },
        { type: 'separator' },
        {
          id: 'edit.delete-permanently',
          label: t('app-menu.edit.delete-permanently'),
          type: 'checkbox',
          checked: deletePermanentlyPreference,
          click: (item) => {
            const enabled =
              item.checked === deletePermanentlyPreference
                ? !deletePermanentlyPreference
                : item.checked;
            item.checked = enabled;
            deletePermanentlyPreference = enabled;
            void desktopSessionStore?.updateDeletePermanently(enabled);
            publishMenuAction({ type: 'set-delete-permanently', enabled });
          },
        },
      ],
    },
    {
      id: 'menu.view',
      label: t('app-menu.view.name'),
      submenu: [
        {
          id: 'view.reset-layout',
          label: t('app-menu.view.reset-layout'),
          click: () => publishMenuAction({ type: 'reset-layout' }),
        },
        { type: 'separator' },
        ...(editionCapabilities.preview
          ? ([
              {
                id: 'view.gpu-map-rendering',
                label: t('app-menu.view.gpu-map-rendering'),
                type: 'checkbox',
                checked: gpuMapRenderingPreference,
                click: (item) => {
                  const enabled =
                    item.checked === gpuMapRenderingPreference
                      ? !gpuMapRenderingPreference
                      : item.checked;
                  item.checked = enabled;
                  gpuMapRenderingPreference = enabled;
                  void desktopSessionStore?.updateGpuMapRendering(enabled);
                  publishMenuAction({ type: 'set-gpu-map-rendering', enabled });
                },
              },
              {
                id: 'view.live-generation-stages',
                label: t('app-menu.view.live-generation-stages'),
                type: 'checkbox',
                checked: liveGenerationStagesPreference,
                enabled: stagesMenu.enabled,
                click: (item) => {
                  const enabled =
                    item.checked === liveGenerationStagesPreference
                      ? !liveGenerationStagesPreference
                      : item.checked;
                  item.checked = enabled;
                  liveGenerationStagesPreference = enabled;
                  void desktopSessionStore?.updateLiveGenerationStages(enabled);
                  publishMenuAction({ type: 'set-live-generation-stages', enabled });
                },
              },
              ...(stagesMenu.note
                ? [{ id: stagesMenu.note.id, label: stagesMenu.note.label, enabled: false }]
                : []),
              {
                id: 'view.map-transitions',
                label: t('app-menu.view.map-transitions'),
                type: 'checkbox',
                checked: mapTransitionsPreference,
                click: (item) => {
                  const enabled =
                    item.checked === mapTransitionsPreference
                      ? !mapTransitionsPreference
                      : item.checked;
                  item.checked = enabled;
                  mapTransitionsPreference = enabled;
                  void desktopSessionStore?.updateMapTransitions(enabled);
                  publishMenuAction({ type: 'set-map-transitions', enabled });
                },
              },
              {
                id: 'view.xs-start-check',
                label: t('app-menu.view.xs-start-check'),
                type: 'checkbox',
                checked: xsStartCheckPreference,
                click: (item) => {
                  const enabled =
                    item.checked === xsStartCheckPreference
                      ? !xsStartCheckPreference
                      : item.checked;
                  item.checked = enabled;
                  xsStartCheckPreference = enabled;
                  void desktopSessionStore?.updateXsStartCheck(enabled);
                  publishMenuAction({ type: 'set-xs-start-check', enabled });
                },
              },
              { type: 'separator' },
            ] satisfies MenuItemConstructorOptions[])
          : []),
        {
          id: 'view.outline-row',
          label: t('app-menu.view.outline-row'),
          type: 'checkbox',
          checked: outlineRowPreference,
          click: (item) => {
            const enabled =
              item.checked === outlineRowPreference ? !outlineRowPreference : item.checked;
            item.checked = enabled;
            outlineRowPreference = enabled;
            void desktopSessionStore?.updateOutlineRow(enabled);
            publishMenuAction({ type: 'set-outline-row', enabled });
          },
        },
        {
          id: 'view.inlay-hints',
          label: t('app-menu.view.inlay-hints'),
          type: 'checkbox',
          checked: inlayHintsPreference,
          click: (item) => {
            const enabled =
              item.checked === inlayHintsPreference ? !inlayHintsPreference : item.checked;
            item.checked = enabled;
            inlayHintsPreference = enabled;
            void desktopSessionStore?.updateInlayHints(enabled);
            publishMenuAction({ type: 'set-inlay-hints', enabled });
          },
        },
        {
          id: 'view.rms-lint-rules',
          label: t('app-menu.view.lint-rules'),
          submenu: rmsLintRules.map((rule): MenuItemConstructorOptions => ({
            id: `view.rms-lint.${rule.code}`,
            label: t('app-menu.view.lint-rule', { title: rule.title, code: rule.code }),
            type: 'checkbox',
            checked: !disabledRmsLintRules(rmsLintRuleSettings, currentLintWorkspace()).includes(
              rule.code,
            ),
            click: (item) => {
              if (modalSurfaceOpen) {
                refreshApplicationMenu();
                return;
              }
              void setRmsLintRule(rule.code, item.checked).catch(console.error);
            },
          })),
        },
        ...(externalLanguageServers
          ? externalLanguageMenuItems(externalLanguageServers, {
              blocked: () => modalSurfaceOpen,
              refresh: refreshApplicationMenu,
              onError: console.error,
            })
          : []),
        { type: 'separator' },
        ...(languageMenuItemVisible(localeService?.state().languages.length ?? 1)
          ? [
              {
                id: 'view.language',
                label: t('app-menu.view.language'),
                click: () => publishMenuAction({ type: 'open-language-settings' }),
              },
            ]
          : []),
        {
          ...themePanelMenuItem(),
          click: () => publishMenuAction({ type: 'open-theme-settings' }),
        },
        ...mcpMenuItems(),
        { type: 'separator' },
        { label: t('app-menu.view.actual-size'), role: 'resetZoom' },
        { label: t('app-menu.view.zoom-in'), role: 'zoomIn' },
        { label: t('app-menu.view.zoom-out'), role: 'zoomOut' },
        { type: 'separator' },
        { label: t('app-menu.view.toggle-full-screen'), role: 'togglefullscreen' },
      ],
    },
    {
      id: 'menu.help',
      label: t('app-menu.help.name'),
      submenu: helpMenuItems(editionCapabilities, productIdentity.displayName).flatMap(
        (item): MenuItemConstructorOptions[] =>
          item.kind === 'tour'
            ? [
                {
                  id: item.id,
                  label: item.label,
                  click: () => publishMenuAction({ type: 'take-the-tour' }),
                },
              ]
            : item.kind === 'link'
              ? [
                  {
                    id: item.id,
                    label: item.label,
                    click: () => {
                      if (!modalSurfaceOpen)
                        void openExternalLink(item.target).catch(console.error);
                    },
                  },
                ]
              : [
                  ...newVersionsMenuItems(),
                  {
                    id: item.id,
                    label: item.label,
                    click: () => {
                      if (!mainWindow || modalSurfaceOpen) return;
                      void showAboutDialog(mainWindow).catch(console.error);
                    },
                  },
                ],
      ),
    },
  ];
  return Menu.buildFromTemplate(template);
}

function newVersionsMenuItems(): MenuItemConstructorOptions[] {
  if (!editionCapabilities.releaseCheck) return [];
  return [
    { type: 'separator' },
    {
      id: 'help.check-for-new-versions',
      label: t('app-menu.help.check-for-new-versions'),
      type: 'checkbox',
      checked: checkForNewVersionsPreference,
      click: (item) => {
        if (modalSurfaceOpen) {
          item.checked = checkForNewVersionsPreference;
          return;
        }
        const enabled =
          item.checked === checkForNewVersionsPreference
            ? !checkForNewVersionsPreference
            : item.checked;
        item.checked = enabled;
        checkForNewVersionsPreference = enabled;
        void desktopSessionStore?.updateCheckForNewVersions(enabled);
      },
    },
    { type: 'separator' },
  ];
}

function dispatchMenuShortcut(input: Electron.Input): boolean {
  const keyEvent = {
    key: input.key,
    code: input.code,
    ctrlKey: input.control,
    shiftKey: input.shift,
    altKey: input.alt,
    metaKey: input.meta,
  };
  const shortcut = menuShortcutItems.find(({ accelerator }) =>
    matchesShortcut(keyEvent, accelerator),
  );
  const item = shortcut ? applicationMenu?.getMenuItemById(shortcut.id) : null;
  if (!item) return false;
  if (!input.isAutoRepeat && item.enabled) {
    item.click();
    publishApplicationMenuModel();
  }
  return true;
}

function publishMenuAction(action: ApplicationMenuAction): void {
  if (!menuActionAllowed(action.type, modalSurfaceOpen)) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(ipcChannels.menuAction, action);
  }
}

async function openExternalLink(target: ExternalLinkTarget): Promise<void> {
  const url = externalLinkUrls[target];
  if (!url) throw new Error('external link target is invalid');
  if (!externalLinkAllowed(target, editionCapabilities)) {
    throw new Error('this feature is not part of this edition');
  }
  await shell.openExternal(url);
}

async function showAboutDialog(window: BrowserWindow): Promise<void> {
  const { buttons, documentationButton } = aboutDialogButtons(editionCapabilities);
  const { response } = await dialog.showMessageBox(window, {
    ...aboutDialogText(productIdentity),
    buttons,
    cancelId: 0,
    defaultId: 0,
    noLink: true,
    type: 'info',
  });
  if (documentationButton !== null && response === documentationButton) {
    await openExternalLink('rmside-documentation');
  }
}

function publishWorkspaceExternalChange(change: WorkspaceExternalChange): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(ipcChannels.workspaceExternalChange, change);
  }
}

function sourceGraphRefreshFailure(error: unknown): OutputMessage {
  return (
    sourceCatalogFailureMessage(error) ??
    presentMessage({
      source: 'Files',
      raw: errorMessage(error),
      severity: 'warning',
      fallbackHeadline: 'file-actions.included-files.refresh-failed',
    })
  );
}

function publishWorkspaceTreeChange(change: WorkspaceTreeChange): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(ipcChannels.workspaceTreeChange, change);
  }
}

function publishWorkspaceDiagnostic(message: OutputMessage): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(ipcChannels.workspaceDiagnostic, message);
  }
}

function currentLintWorkspace(): string | null {
  return workspaceServiceInstance?.workspaceRoot() ?? null;
}

function applyRmsLintSettings(): void {
  supervisor?.updateLanguageLintSettings(
    disabledRmsLintRules(rmsLintRuleSettings, currentLintWorkspace()),
  );
}

async function setRmsLintRule(code: string, enabled: boolean): Promise<void> {
  rmsLintRuleSettings = withRmsLintRule(rmsLintRuleSettings, currentLintWorkspace(), code, enabled);
  applyRmsLintSettings();
  refreshApplicationMenu();
  await desktopSessionStore?.updateRmsLintRules(rmsLintRuleSettings);
}

async function refreshRecentApplicationMenu(): Promise<void> {
  if (!workspaceServiceInstance) return;
  recentMenuEntries = await workspaceServiceInstance.recentEntries();
  refreshApplicationMenu();
}

function refreshApplicationMenu(): void {
  applicationMenu = createApplicationMenu();
  reportApplicationMenuClicks(applicationMenu, publishApplicationMenuModel);
  Menu.setApplicationMenu(applicationMenu);
  publishApplicationMenuModel();
}

let firstGameFolderLinkHandler: (() => void) | undefined;

function updateGameFolderLinked(linked: boolean): void {
  if (linked !== gameFolderLinked) {
    gameFolderLinked = linked;
    refreshApplicationMenu();
  }
  if (linked) firstGameFolderLinkHandler?.();
}

function scheduleWindowStateSave(): void {
  if (windowStateTimer) clearTimeout(windowStateTimer);
  windowStateTimer = setTimeout(() => {
    windowStateTimer = undefined;
    void persistCurrentWindowState();
  }, 200);
}

function flushWindowStateSave(): void {
  if (!windowStateTimer) return;
  clearTimeout(windowStateTimer);
  windowStateTimer = undefined;
  void persistCurrentWindowState();
}

function closeForSessionEnd(): void {
  if (shuttingDown || sessionEndCloseStarted) return;
  sessionEndCloseStarted = true;
  windowCloseApproved = true;
  windowCloseRequestPending = false;
  flushWindowStateSave();
  setTimeout(() => app.quit(), sessionEndQuitDelayMs);
}

async function persistCurrentWindowState(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed() || !desktopSessionStore) return;
  const record = currentWindowRecord(mainWindow);
  await desktopSessionStore.updateWindow(record.bounds, record.maximized, record.display);
}

function currentWindowRecord(browserWindow: BrowserWindow): DesktopSession['window'] {
  const normal = browserWindow.getNormalBounds();
  const bounds = { x: normal.x, y: normal.y, width: normal.width, height: normal.height };
  return {
    bounds,
    maximized: browserWindow.isMaximized(),
    display: displayFingerprint(placementDisplay(screen.getDisplayMatching(bounds))),
  };
}

function initialWindowPlacement(session: DesktopSession) {
  const override = app.isPackaged
    ? null
    : parseWindowDisplayOverride(developmentOverrides().windowDisplay);
  return resolveWindowPlacement({
    remembered: session.window,
    displays: screen.getAllDisplays().map(placementDisplay),
    primaryDisplayId: screen.getPrimaryDisplay().id,
    cursorDisplayId:
      override?.kind === 'cursor' || override?.kind === 'away'
        ? screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id
        : null,
    override,
    defaults: defaultWindowSize,
  });
}

function placementDisplay(display: Electron.Display): PlacementDisplay {
  return {
    id: display.id,
    bounds: display.bounds,
    workArea: display.workArea,
    scaleFactor: display.scaleFactor,
  };
}

function applyNativeTheme(nextResolvedTheme: ResolvedTheme): void {
  resolvedTheme = nextResolvedTheme;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const palette = titleBarPalette[resolvedTheme];
  mainWindow.setBackgroundColor(palette.background);
  mainWindow.setTitleBarOverlay({
    color: palette.background,
    height: 40,
    symbolColor: palette.foreground,
  });
}

function publishApplicationMenuModel(): void {
  const model = JSON.stringify(applicationMenuModel(applicationMenu));
  if (model === publishedApplicationMenuModel) return;
  publishedApplicationMenuModel = model;
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send(ipcChannels.applicationMenuModelChanged, JSON.parse(model));
}

function activateApplicationMenuItem(browserWindow: BrowserWindow, key: string): void {
  const item = findApplicationMenuItem(applicationMenu, key) as MenuItem | undefined;
  if (!item) throw new Error('application menu item is unavailable');
  item.click({}, browserWindow, browserWindow.webContents);
  publishApplicationMenuModel();
}

function showSelectionContextMenu(selectionText: string, canCopy: boolean): void {
  if (!mainWindow || !selectionText || !canCopy) return;
  Menu.buildFromTemplate([
    { enabled: canCopy, label: t('app-menu.edit.copy'), role: 'copy' },
    { type: 'separator' },
    { label: t('app-menu.edit.select-all'), role: 'selectAll' },
  ]).popup({ window: mainWindow });
}

function resolveWindowIconPath(): string {
  const filename = 'aoe2rmside-icon.ico';
  if (app.isPackaged) return join(process.resourcesPath, filename);
  return resolve(app.getAppPath(), '..', '..', 'assets', 'original', 'branding', filename);
}

function showOpenDialog(browserWindow: BrowserWindow, options: OpenDialogOptions) {
  return withNativeDialog(
    browserWindow,
    () => dialog.showOpenDialog(browserWindow, options),
    () => screen.getCursorScreenPoint(),
  );
}

function showSaveDialog(browserWindow: BrowserWindow, options: SaveDialogOptions) {
  return withNativeDialog(
    browserWindow,
    () => dialog.showSaveDialog(browserWindow, options),
    () => screen.getCursorScreenPoint(),
  );
}

function registerIpc(
  nativeSupervisor: NativeSupervisor,
  sessionStore: DesktopSessionStore,
  workspaceService: WorkspaceService,
  recoveryStore: RecoveryStore,
  installationSelectionStore: InstallationSelectionStore,
  controlLauncherPreference: ControlLauncherPreferenceStore,
  controlSessionBridge: ControlSessionBridge,
): void {
  const selectionDirectory = async (
    purpose: DialogPurpose,
    fallbacks: readonly (string | null)[] = [],
  ) =>
    dialogDirectory(
      (await sessionStore.read()).dialogLocations,
      purpose,
      (path) => workspaceService.validDialogPath('folder', path),
      fallbacks,
    );
  const withExecutionLease = async <T>(
    executionId: string,
    kind: RootExecutionKind,
    label: string,
    cooperativeStop: () => Promise<void>,
    forceStop: () => Promise<void>,
    operation: () => Promise<T>,
    options: ExecutionLeaseOptions = {},
  ): Promise<T> => {
    const token = executionLease.acquire(
      executionId,
      kind,
      label,
      cooperativeStop,
      forceStop,
      options,
    );
    try {
      return await operation();
    } finally {
      executionLease.release(token);
    }
  };
  let preparingRootExecution = false;
  const prepareRootExecution = async <T>(prepare: () => Promise<T>): Promise<T> => {
    if (preparingRootExecution) {
      throw new DesktopError(
        'execution.busy',
        'another application-global root execution is already being prepared',
      );
    }
    preparingRootExecution = true;
    try {
      return await prepare();
    } finally {
      preparingRootExecution = false;
    }
  };
  const settleRendererGeneration = (operation: Promise<PreviewGenerationResult>) =>
    settlePreviewGeneration(operation, isProtocolCancellation, (error) => error.protocolMessage);
  let invalidateEditorInventory = () => {};
  const sourceCatalogService = new SourceCatalogService(
    workspaceService,
    nativeSupervisor.sourceCatalogDiscovery,
    () => {
      publishLanguageServerNotification('rms/sourceCatalogInvalidated', {});
      nativeSupervisor.invalidateLanguageSourceCatalog(
        nativeSupervisor.currentLanguageSourceCatalog(),
      );
      invalidateEditorInventory();
    },
  );
  const editorInventoryService = new EditorInventoryService(
    workspaceService,
    sourceCatalogService.snapshotCache,
  );
  if (editionCapabilities.sourceCatalog) nativeSupervisor.enableEditorInventory();
  const mapIconSourceGeneration = new MapIconSourceGeneration({
    deploymentGraph: (identity) => sourceCatalogService.authorizedDeploymentGraph(identity),
    executionBusy: () => executionLease.state().phase !== 'idle',
    withExecutionLease: (executionId, label, cooperativeStop, forceStop, operation) =>
      withExecutionLease(executionId, 'map-icon', label, cooperativeStop, forceStop, operation),
    generate: (input, catalog, localProductVersion, onExecutionProgress) =>
      nativeSupervisor.generatePreview(
        input,
        catalog,
        undefined,
        undefined,
        localProductVersion,
        onExecutionProgress,
        localContentService.sourceFor(input.contentPack),
      ),
    cancel: (executionId) => nativeSupervisor.cancelPreview(executionId),
    forceStop: () =>
      shuttingDown
        ? nativeSupervisor.forceTerminateRmsd()
        : nativeSupervisor.forceTerminateRmsdAndRestart(),
  });
  const isMapIconSourceCancellation = (error: unknown): error is Error =>
    isProtocolCancellation(error) || error instanceof MapIconSourceCancelled;
  const managedDeploymentService = new ManagedDeploymentService(
    app.getPath('userData'),
    sourceCatalogService,
    workspaceService.standardResources,
    (graph, semanticHash) => mapIconSourceGeneration.acceptsIconSource(graph, semanticHash),
    (path) => shell.trashItem(path),
    (files) => nativeSupervisor.checkXsSyntax(files),
    () => gameArtService.currentSource(),
  );
  const installedSourceService = new InstalledSourceService(
    workspaceService,
    (installationRoot, profileRoot, profileId, modName) =>
      managedDeploymentService.isOwnedManualTarget(
        installationRoot,
        profileRoot,
        profileId,
        modName,
      ),
  );
  const configuredSteamRoots = developmentOverrides().steamRoots;
  const installationHost =
    configuredSteamRoots === undefined
      ? nodeInstallationHost
      : {
          ...nodeInstallationHost,
          steamRoots: async () =>
            configuredSteamRoots
              .split(delimiter)
              .filter(Boolean)
              .map((value) => ({ value: resolve(value), source: 'RMSIDE_STEAM_ROOTS' })),
        };
  const linkedInstallationReport = async () => {
    const selection = await installationSelectionStore.read();
    if (!selection) return null;
    const { userProfileRoot } = developmentOverrides();
    const report = await discoverManualInstallation(
      selection.installationRoot,
      installationHost,
      userProfileRoot ? { userProfileRoot } : {},
    );
    return report.valid ? report : null;
  };
  openLinkedGameFolderAction = async () => {
    const report = await linkedInstallationReport();
    if (!report) {
      updateGameFolderLinked(false);
      throw new DesktopError(
        'game-folder.unavailable',
        'the linked AoE2DE installation is unavailable; select the game folder again',
      );
    }
    const canonicalRoot = await realpath(report.evidence.installationRoot.value);
    const failure = await shell.openPath(canonicalRoot);
    if (failure) {
      throw new DesktopError('shell.open-failed', failure, { reason: failure });
    }
  };
  let installedSourceCatalogPromise: ReturnType<InstalledSourceService['discover']> | undefined;
  const discoverInstallationReports = async () => {
    const { userProfileRoot } = developmentOverrides();
    const reports = await discoverSteamInstallations(
      installationHost,
      userProfileRoot ? { userProfileRoot } : {},
    );
    const remembered = await installationSelectionStore.read();
    if (
      remembered &&
      !reports.some(
        (report) =>
          resolve(report.evidence.installationRoot.value).toLocaleLowerCase('en-US') ===
          resolve(remembered.installationRoot).toLocaleLowerCase('en-US'),
      )
    ) {
      reports.unshift(
        await discoverManualInstallation(
          remembered.installationRoot,
          installationHost,
          userProfileRoot ? { userProfileRoot } : {},
        ),
      );
    }
    return reports;
  };
  let installationDiscoveryTail = Promise.resolve();
  const syncLinkedResourceProtection = async () => {
    const selected = await installationSelectionStore.read();
    const localPaths = selected
      ? await readLocalStandardIncludePaths(selected.installationRoot)
      : [];
    const linkedScripts = selected
      ? join(selected.installationRoot, 'resources', '_common', 'random-map-scripts')
      : null;
    const canonicalScripts = linkedScripts
      ? await realpath(linkedScripts).catch(() => linkedScripts)
      : null;
    workspaceServiceInstance?.setInstalledProtectedRoots(
      linkedScripts && canonicalScripts
        ? [linkedScripts, canonicalScripts].map((path) => ({
            path,
            reason: 'game-installation' as const,
          }))
        : [],
      'linked-installation',
    );
    workspaceService.setLocalStandardIncludePaths(localPaths);
  };
  const discoverAndRememberInstallationReports = () => {
    const operation = installationDiscoveryTail.then(async () => {
      const reports = await discoverInstallationReports();
      const remembered = await installationSelectionStore.read();
      const automaticDiscoveryEnabled =
        await installationSelectionStore.automaticDiscoveryEnabled();
      const selected =
        reports.find(
          (report) =>
            report.valid &&
            remembered &&
            resolve(report.evidence.installationRoot.value).toLocaleLowerCase('en-US') ===
              resolve(remembered.installationRoot).toLocaleLowerCase('en-US'),
        ) ?? (automaticDiscoveryEnabled ? reports.find((report) => report.valid) : undefined);
      if (
        selected &&
        (!remembered ||
          resolve(selected.evidence.installationRoot.value).toLocaleLowerCase('en-US') !==
            resolve(remembered.installationRoot).toLocaleLowerCase('en-US'))
      ) {
        await installationSelectionStore.write({
          installationRoot: selected.evidence.installationRoot.value,
        });
        sourceCatalogService.invalidate();
        await refreshLanguageCatalogAndReportFailure(refreshOpenLanguageCatalog());
      }
      updateGameFolderLinked(Boolean(selected));
      await syncLinkedResourceProtection();
      return reports;
    });
    installationDiscoveryTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };
  const discoverInstalledSources = (refresh = false) => {
    if (refresh) installedSourceCatalogPromise = undefined;
    installedSourceCatalogPromise ??= discoverAndRememberInstallationReports().then(
      async (reports) => {
        const remembered = await installationSelectionStore.read();
        return installedSourceService.discover(remembered ? reports : [], remembered);
      },
    );
    return installedSourceCatalogPromise;
  };
  const managedDeploymentTarget = async (): Promise<ManagedDeploymentTarget> => {
    const selection = await installationSelectionStore.read();
    if (!selection) throw new Error('select an AoE2DE installation before deploying');
    const { userProfileRoot } = developmentOverrides();
    const report = await discoverManualInstallation(
      selection.installationRoot,
      installationHost,
      userProfileRoot ? { userProfileRoot } : {},
    );
    if (!report.valid) throw new Error('the selected AoE2DE installation is unavailable');
    const profiles = report.evidence.userProfiles;
    const steamProfiles = await installationAccountProfiles(report, installationHost);
    const profilesWithManagedOutput = (
      await Promise.all(
        profiles.map(async (candidate) => ({
          candidate,
          present:
            (await installationHost.pathKind(
              join(candidate.source, 'mods', 'local', managedModDirectoryName),
            )) === 'directory',
        })),
      )
    ).filter(({ present }) => present);
    const profile = resolveDeploymentUserProfile(profiles, {
      managedProfileIds: profilesWithManagedOutput.map(({ candidate }) => candidate.value),
      rememberedProfileId: selection.userProfileId,
      steamProfiles,
    });
    if (!profile) throw new Error('the current AoE2DE user profile could not be identified');
    if (selection.userProfileId !== profile.value) {
      await installationSelectionStore.write({
        installationRoot: report.evidence.installationRoot.value,
        userProfileId: profile.value,
      });
    }
    return {
      installationRoot: report.evidence.installationRoot.value,
      profileId: profile.value,
      profileRoot: profile.source,
    };
  };
  const manualDeploymentContext = async (documentUri: string) => {
    if (typeof documentUri !== 'string' || documentUri.length < 1 || documentUri.length > 4096) {
      throw new Error('authored entry identity is invalid');
    }
    const report = await linkedInstallationReport();
    if (!report) {
      updateGameFolderLinked(false);
      return null;
    }
    updateGameFolderLinked(true);
    const profiles = report.evidence.userProfiles;
    const ownedTargets = await managedDeploymentService.reconcileManualTargets(
      report.evidence.installationRoot.value,
      profiles.map((profile) => ({ profileId: profile.value, profileRoot: profile.source })),
      documentUri,
    );
    const fixedManagedProfiles = (
      await Promise.all(
        profiles.map(async (candidate) => ({
          candidate,
          present:
            (await installationHost.pathKind(
              join(candidate.source, 'mods', 'local', managedModDirectoryName),
            )) === 'directory',
        })),
      )
    )
      .filter(({ present }) => present)
      .map(({ candidate }) => candidate.value);
    const steamProfiles = await installationAccountProfiles(report, installationHost);
    const remembered = await installationSelectionStore.read();
    const suggested = resolveDeploymentUserProfile(profiles, {
      managedProfileIds: [
        ...new Set([...fixedManagedProfiles, ...ownedTargets.map((target) => target.profileId)]),
      ],
      rememberedProfileId: remembered?.userProfileId,
      steamProfiles,
    });
    const openedEntryPath = workspaceService.sourceCatalogContext(documentUri).entryPath;
    return {
      installationRoot: await realpath(report.evidence.installationRoot.value),
      profiles: profiles.map((profile) => ({
        profileId: profile.value,
        targetRoot: join(profile.source, 'mods', 'local'),
        suggested: profile.value === suggested?.value,
      })),
      selectedProfileId: suggested?.value ?? null,
      selectionSuggested: Boolean(suggested),
      ownedTargets,
      originalMapIconAvailable: openedEntryPath
        ? await hasMatchingPreviewImage(openedEntryPath)
        : false,
    };
  };
  const manualTarget = async (
    profileId: string,
    modName: string,
  ): Promise<ManagedDeploymentTarget> => {
    const report = await linkedInstallationReport();
    if (!report) {
      throw new DesktopError(
        'deploy.no-installation',
        'select a valid AoE2DE installation before deploying',
      );
    }
    const profile = report.evidence.userProfiles.find((candidate) => candidate.value === profileId);
    if (!profile) {
      throw new DesktopError(
        'deploy.profile',
        'select one of the linked installation numeric profiles',
      );
    }
    const ownershipId = await managedDeploymentService.manualOwnershipId(
      report.evidence.installationRoot.value,
      profile.source,
      profile.value,
      modName,
    );
    return {
      installationRoot: report.evidence.installationRoot.value,
      profileId: profile.value,
      profileRoot: profile.source,
      directoryName: modName,
      title: modName,
      kind: 'manual',
      ownershipId,
    };
  };
  let lastDeployedModFolder: string | null = null;
  let liveEventSequence = 0;
  const controlLiveWorkflow = new ControlLiveWorkflow(
    new ControlLiveSessionAdapter(controlSessionBridge),
    {
      ensureCurrent: async (request, options) =>
        managedDeploymentService.ensureCurrentForLiveTest(
          request,
          await managedDeploymentTarget(),
          options.overwriteExternalChanges,
        ),
      preflight: async (request) =>
        managedDeploymentService.preflightLiveTest(request, await managedDeploymentTarget()),
    },
    (workflowEvent) =>
      publishControlLiveEvent({
        sequence: ++liveEventSequence,
        requestId: workflowEvent.requestId,
        kind: workflowEvent.kind,
        detailCode: workflowEvent.code,
        ...(workflowEvent.kind === 'failure' && workflowEvent.detail
          ? { detail: workflowEvent.detail.slice(0, 512) }
          : {}),
        ...(workflowEvent.seed === undefined ? {} : { seed: workflowEvent.seed }),
        ...(workflowEvent.matchEpoch === undefined ? {} : { matchEpoch: workflowEvent.matchEpoch }),
        ...(workflowEvent.kind === 'deploy' && workflowEvent.xsFiles?.length
          ? { xsFiles: workflowEvent.xsFiles.slice(0, 64) }
          : {}),
      }),
  );
  let languageConfigurationCatalog:
    Awaited<ReturnType<NativeSupervisor['getConfigurationCatalog']>> | undefined;
  const getLanguageConfigurationCatalog = async () => {
    languageConfigurationCatalog ??= await nativeSupervisor.getConfigurationCatalog();
    return languageConfigurationCatalog;
  };
  const localContentService = new LocalContentService({
    importLocalContent: (source) => nativeSupervisor.importLocalContent(source),
    transient: isInstallationReadersBusy,
    fileStamp: async (path) => {
      try {
        const metadata = await stat(path);
        return metadata.isFile() ? { size: metadata.size, mtimeMs: metadata.mtimeMs } : null;
      } catch {
        return null;
      }
    },
    publish: publishWorkspaceDiagnostic,
  });
  const linkedInstallation = async (): Promise<LinkedInstallation | null> => {
    const selection = await installationSelectionStore.read();
    if (!selection) return null;
    return {
      installationRoot: selection.installationRoot,
      productVersion: await linkedProductVersionFor('local'),
    };
  };
  const localContentPack = async (
    configuration: Awaited<ReturnType<typeof getLanguageConfigurationCatalog>>,
  ): Promise<ContentPackDescriptor | null> => {
    try {
      return await localContentService.contentFor(await linkedInstallation(), configuration);
    } catch {
      return null;
    }
  };
  const configurationCatalogWithLocalContent = async () => {
    const configuration = await getLanguageConfigurationCatalog();
    const local = await localContentPack(configuration);
    return local
      ? { ...configuration, contentPacks: [...configuration.contentPacks, local] }
      : configuration;
  };
  const versionResourcesFor = async (
    contentPack: Pick<ContentPackDescriptor, 'packId' | 'packVersion' | 'contentHash'>,
    versionOrigin: PreviewVersionOrigin,
  ) => {
    const configuration = await configurationCatalogWithLocalContent();
    const authoritative = configuration.contentPacks.find(
      (candidate) =>
        candidate.packId === contentPack.packId &&
        candidate.packVersion === contentPack.packVersion &&
        candidate.contentHash === contentPack.contentHash,
    );
    if (!authoritative) {
      throw new DesktopError(
        'generation.content-unavailable',
        'the selected content pack is unavailable',
      );
    }
    return {
      contentIdentity: `${authoritative.packId}@${authoritative.packVersion}#${authoritative.sourceFingerprint}`,
      implicitDefinitions: authoritative.implicitDefinitions,
      standardIncludes: authoritative.standardIncludes,
      standardIncludesRequested: versionOrigin === 'local',
    };
  };
  const reportRequiredSourceLimit = requiredSourceLimitReporter(publishWorkspaceDiagnostic);
  const requiredSourceContext = (uri: string | null | undefined) =>
    JSON.stringify([
      nativeSupervisor.languageIdentityEpoch(),
      sourceCatalogService.identityEpoch(),
      uri,
    ]);
  const sourceCatalogFor = async (input: PreviewGenerationInput) => {
    const failureContext = requiredSourceContext(input.documentUri);
    const nativeEpoch = nativeSupervisor.languageIdentityEpoch();
    const catalogEpoch = sourceCatalogService.identityEpoch();
    const selection = await installationSelectionStore.read();
    const catalog = await sourceCatalogService
      .build({
        documentUri: input.documentUri,
        documentRevision: input.documentRevision,
        source: input.source,
        profileId: input.profile.profileId,
        ...(await versionResourcesFor(input.contentPack, input.versionOrigin)),
        installationRoot: selection?.installationRoot ?? null,
        overlays: nativeSupervisor.languageDocumentOverlays(),
        assertCurrent: () => {
          if (
            nativeEpoch !== nativeSupervisor.languageIdentityEpoch() ||
            catalogEpoch !== sourceCatalogService.identityEpoch()
          )
            throw new DesktopError(
              'generation.source-changed',
              'the source changed while preview includes were being checked',
            );
        },
      })
      .catch((error: unknown) => {
        if (failureContext === requiredSourceContext(input.documentUri))
          reportRequiredSourceLimit(error, failureContext);
        throw error;
      });
    if (
      nativeEpoch !== nativeSupervisor.languageIdentityEpoch() ||
      catalogEpoch !== sourceCatalogService.identityEpoch()
    )
      throw new DesktopError(
        'generation.source-changed',
        'the source changed while the preview was generating',
      );
    return catalog;
  };
  const sourceCatalogsForMapTest = async (input: MapTestRunInput) => {
    const nativeEpoch = nativeSupervisor.languageIdentityEpoch();
    const catalogEpoch = sourceCatalogService.identityEpoch();
    const relativePaths = extractMapTestSourcePaths(input.scriptSource);
    let defaultSourcePath: string | undefined;
    if (input.defaultSourceUri) {
      defaultSourcePath = workspaceService.mapTestRelativeRmsPath(
        input.scriptUri,
        input.defaultSourceUri,
      );
    }
    addPinnedMapTestSource(relativePaths, defaultSourcePath);
    if (relativePaths.size === 0) {
      throw new DesktopError(
        'map-test.source-path',
        'rms.source() needs an explicit authorized RMS path or a valid pin',
      );
    }
    const selection = await installationSelectionStore.read();
    const versionResources = await versionResourcesFor(input.contentPack, input.versionOrigin);
    const catalogs = [];
    const batchBudget = new SourceCatalogBatchBudget();
    const assertBatchCurrent = () => {
      if (
        nativeEpoch !== nativeSupervisor.languageIdentityEpoch() ||
        catalogEpoch !== sourceCatalogService.identityEpoch()
      )
        throw new DesktopError(
          'source-catalog.changed',
          'sources changed while map-test includes were being checked',
        );
    };
    for (const relativePath of [...relativePaths].sort((left, right) =>
      left.localeCompare(right, 'en-US'),
    )) {
      const diskDocument = await workspaceService.resolveMapTestRmsSource(
        input.scriptUri,
        relativePath,
        {
          maximumBytes: Math.min(4 * 1024 * 1024, batchBudget.remainingSourceBytes()),
          beforeRead: (metadata) => batchBudget.checkRootRead(metadata.size),
          current: assertBatchCurrent,
        },
      );
      const overlay = nativeSupervisor.languageDocument(diskDocument.uri);
      catalogs.push(
        await sourceCatalogService.build({
          documentUri: diskDocument.uri,
          batchBudget,
          documentRevision: overlay?.version ?? 0,
          source: overlay?.text ?? diskDocument.content,
          profileId: input.profile.profileId,
          ...versionResources,
          installationRoot: selection?.installationRoot ?? null,
          overlays: nativeSupervisor.languageDocumentOverlays(),
          assertCurrent: assertBatchCurrent,
        }),
      );
    }
    for (const catalog of catalogs) await sourceCatalogService.validateSnapshotWitnesses(catalog);
    if (
      nativeEpoch !== nativeSupervisor.languageIdentityEpoch() ||
      catalogEpoch !== sourceCatalogService.identityEpoch()
    )
      throw new DesktopError(
        'source-catalog.changed',
        'sources changed while map-test includes were being checked',
      );
    return {
      catalogs,
      defaultSourcePath,
      workspaceName: workspaceService.mapTestWorkspaceName(input.scriptUri),
    };
  };
  let languageCatalogEntryUri: string | undefined;
  let languageCatalogFailedUri: string | undefined;
  let languageContentSelection: LanguageContentSelection | undefined;
  const selectedLanguageContent = async () => {
    const configuration = await configurationCatalogWithLocalContent();
    const selected = editionCapabilities.preview
      ? languageContentSelection
      : (editorLanguageContentSelection(
          configuration,
          { profileId: languageGameVersionProfileId, versionOrigin: languageGameVersionOrigin },
          await localContentPack(await getLanguageConfigurationCatalog()),
        ) ?? undefined);
    const contentPack = selected
      ? configuration.contentPacks.find(
          (candidate) =>
            candidate.packId === selected.packId &&
            candidate.packVersion === selected.packVersion &&
            candidate.contentHash === selected.contentHash,
        )
      : configuration.contentPacks.find((candidate) => candidate.packagedBundle);
    const profile = contentPack
      ? configuration.behaviorProfiles.find(
          (candidate) =>
            (selected ? candidate.profileId === selected.profileId : true) &&
            contentPack.compatibleProfileIds.includes(candidate.profileId),
        )
      : undefined;
    return contentPack && profile ? { selected, contentPack, profile } : null;
  };
  let editorContextDocumentUri: string | undefined;
  const editorContextUri = () => {
    const documents = nativeSupervisor.languageDocumentOverlays();
    const current = documents.find((document) => document.uri === editorContextDocumentUri);
    if (current) return current.uri;
    return documents
      .filter((document) => /\.(?:rms|rms2|xs)$/iu.test(document.uri))
      .sort(
        (left, right) =>
          Number(/\.xs$/iu.test(left.uri)) - Number(/\.xs$/iu.test(right.uri)) ||
          left.uri.localeCompare(right.uri, 'en-US'),
      )[0]?.uri;
  };
  const editorContextEpoch = () =>
    createHash('sha256')
      .update(
        JSON.stringify([
          editorInventoryService.identityEpoch(),
          nativeSupervisor.languageEditorContextEpoch(),
          workspaceService.sourceCatalogContext(editorContextUri()),
          languageContentSelection,
          languageGameVersionProfileId,
          languageGameVersionOrigin,
        ]),
      )
      .digest('hex');
  const warnEditorAssistance = editorAssistanceReporter(
    editorContextEpoch,
    publishWorkspaceDiagnostic,
  );
  const editorInventoryCoordinator = editionCapabilities.sourceCatalog
    ? new EditorInventoryCoordinator({
        native: nativeSupervisor,
        contextEpoch: editorContextEpoch,
        prepare: async (assertCurrent) => {
          const contextEpoch = editorContextEpoch();
          const documentUri = editorContextUri();
          const content = await selectedLanguageContent();
          assertCurrent();
          if (!content) throw new Error('the current editor analysis version is unavailable');
          const selected = await installationSelectionStore.read();
          const resources = await versionResourcesFor(
            content.contentPack,
            content.selected?.versionOrigin ?? 'packaged',
          );
          assertCurrent();
          return editorInventoryService.build({
            documentUri,
            profileId: content.profile.profileId,
            ...resources,
            installationRoot: selected?.installationRoot ?? null,
            overlays: nativeSupervisor.languageDocumentOverlays(),
            contextEpoch,
            assertCurrent,
          });
        },
        warn: (error) => warnEditorAssistance(error, 'inventory'),
        generationAdmission: () => languageDiagnosticAdmission!.generationAdmission(),
      })
    : undefined;
  languageDiagnosticAdmission = editorInventoryCoordinator
    ? new LanguageDiagnosticAdmission({
        native: nativeSupervisor,
        catalogs: sourceCatalogService,
        editor: editorInventoryCoordinator,
        publish: (params) =>
          publishLanguageServerNotification('textDocument/publishDiagnostics', params),
        warn: warnEditorAssistance,
      })
    : undefined;
  invalidateEditorInventory = () => {
    editorInventoryService.invalidate();
    editorInventoryCoordinator?.invalidate();
    scheduleEditorInventoryRefresh();
  };

  const prepareLanguageCatalog = async (uri: string) => {
    if (!/\.(?:rms|rms2)$/iu.test(uri))
      throw new Error('an RMS entry is required for include analysis');
    const nativeEpoch = nativeSupervisor.languageIdentityEpoch();
    const document = nativeSupervisor.languageDocument(uri);
    if (!document) {
      throw new DesktopError('source-catalog.changed', 'the current RMS document is unavailable');
    }
    const content = await selectedLanguageContent();
    if (!content) {
      throw new DesktopError(
        'source-catalog.changed',
        'the current RMS analysis version is unavailable',
      );
    }
    const { selected, contentPack, profile } = content;
    const selection = await installationSelectionStore.read();
    const catalog = await sourceCatalogService.build({
      documentUri: uri,
      documentRevision: document.version,
      source: document.text,
      profileId: profile.profileId,
      ...(await versionResourcesFor(contentPack, selected?.versionOrigin ?? 'packaged')),
      installationRoot: selection?.installationRoot ?? null,
      overlays: nativeSupervisor.languageDocumentOverlays(),
      identityScope: 'language',
      assertCurrent: () => {
        if (nativeEpoch !== nativeSupervisor.languageIdentityEpoch())
          throw new DesktopError('source-catalog.changed', 'the RMS analysis context changed');
      },
    });
    return { catalog, documentVersion: document.version };
  };
  const languageReadiness = new SourceCatalogReadiness({
    epoch: () =>
      JSON.stringify([
        sourceCatalogService.identityEpoch(),
        nativeSupervisor.languageIdentityEpoch(),
        languageContentSelection,
        languageGameVersionProfileId,
        languageGameVersionOrigin,
      ]),
    prepare: prepareLanguageCatalog,
    validate: (catalog) => sourceCatalogService.validateWitnesses(catalog),
    analyze: (catalog, params) => {
      nativeSupervisor.updateLanguageSourceCatalog(catalog);
      return nativeSupervisor.requestLanguageServer('rms/semanticIdentity', params);
    },
  });
  const updateLanguageCatalog = async (uri: string) => {
    const epoch = nativeSupervisor.languageIdentityEpoch();
    const failureContext = requiredSourceContext(uri);
    const genericContext = requiredSourceContext(undefined);
    try {
      const { catalog } = await prepareLanguageCatalog(uri);
      if (epoch !== nativeSupervisor.languageIdentityEpoch())
        throw new DesktopError(
          'source-catalog.changed',
          'the RMS documents changed during include analysis',
        );
      nativeSupervisor.updateLanguageSourceCatalog(catalog);
      languageCatalogEntryUri = uri;
      if (languageCatalogFailedUri === uri) languageCatalogFailedUri = undefined;
    } catch (error) {
      if (failureContext === requiredSourceContext(uri))
        reportRequiredSourceLimit(error, failureContext);
      reportCatalogRefreshFailure(error, genericContext);
      throw error;
    }
  };
  let requestedLanguageCatalog: { uri: string } | undefined;
  let languageCatalogRequestSequence = 0;
  let languageCatalogWorker: Promise<void> | undefined;
  let languageProbeSequence = 0;
  const scheduleLanguageCatalogUpdate = (uri: string): Promise<void> => {
    if (!editionCapabilities.sourceCatalog) return Promise.resolve();
    requestedLanguageCatalog = { uri };
    languageCatalogRequestSequence += 1;
    languageCatalogWorker ??= (async () => {
      while (requestedLanguageCatalog) {
        const requestSequence = languageCatalogRequestSequence;
        await new Promise<void>((resolvePending) => setTimeout(resolvePending, 100));
        if (requestSequence !== languageCatalogRequestSequence) continue;
        const requested = requestedLanguageCatalog;
        requestedLanguageCatalog = undefined;
        try {
          await updateLanguageCatalog(requested.uri);
        } catch (error) {
          languageCatalogFailedUri = requested.uri;
          languageReadiness.invalidate(requested.uri);
          nativeSupervisor.invalidateLanguageSourceCatalog(
            nativeSupervisor.currentLanguageSourceCatalog(),
          );
          throw error;
        }
      }
    })().finally(() => {
      languageCatalogWorker = undefined;
    });
    return languageCatalogWorker;
  };
  const ensureLanguageCatalog = (uri: string): Promise<void> =>
    (languageCatalogEntryUri === uri || languageCatalogFailedUri === uri) && !languageCatalogWorker
      ? Promise.resolve()
      : scheduleLanguageCatalogUpdate(uri);
  const requestedLanguageDocumentSyncs = new Set<string>();
  let languageDocumentSyncSequence = 0;
  let languageDocumentSyncWorker: Promise<void> | undefined;
  let flushLanguageDocumentSync: (() => void) | undefined;
  scheduleEditorInventoryRefresh = () => {
    if (shuttingDown) return;
    editorInventoryCoordinator?.scheduleRefresh(async () => {
      if (languageDocumentSyncWorker) await languageDocumentSyncWorker;
    });
  };
  disposeEditorInventory = () => editorInventoryCoordinator?.dispose();
  const scheduleLanguageDocumentSync = (uri: string): Promise<void> => {
    requestedLanguageDocumentSyncs.add(uri);
    languageDocumentSyncSequence += 1;
    languageDocumentSyncWorker ??= (async () => {
      while (requestedLanguageDocumentSyncs.size > 0) {
        const requestSequence = languageDocumentSyncSequence;
        let flushed = false;
        await new Promise<void>((resolvePending) => {
          const timer = setTimeout(resolvePending, 25);
          flushLanguageDocumentSync = () => {
            flushed = true;
            clearTimeout(timer);
            resolvePending();
          };
        });
        flushLanguageDocumentSync = undefined;
        if (!flushed && requestSequence !== languageDocumentSyncSequence) continue;
        const uris = [...requestedLanguageDocumentSyncs].sort();
        requestedLanguageDocumentSyncs.clear();
        for (const requestedUri of uris) {
          nativeSupervisor.synchronizeLanguageDocument(requestedUri);
        }
      }
    })().finally(() => {
      languageDocumentSyncWorker = undefined;
    });
    return languageDocumentSyncWorker;
  };
  const cancelLanguageDocumentSync = (uri: string) => {
    if (requestedLanguageDocumentSyncs.delete(uri)) languageDocumentSyncSequence += 1;
  };
  const xsEnvironmentSource = new XsEnvironmentSource();
  let xsEnvironmentState: XsEnvironmentState | null = null;
  let languageGameVersionProfileId: string | null = null;
  let languageGameVersionOrigin: PreviewVersionOrigin = 'packaged';
  const refreshXsEnvironment = async () => {
    const selection = await installationSelectionStore.read().catch(() => null);
    const state = await xsEnvironmentSource.current(
      selection?.installationRoot ?? null,
      languageContentSelection?.profileId ?? languageGameVersionProfileId,
    );
    xsEnvironmentState = state;
    const previousContext = nativeSupervisor.languageEditorContextEpoch();
    nativeSupervisor.updateLanguageXsEnvironment(state.payload);
    if (previousContext !== nativeSupervisor.languageEditorContextEpoch())
      invalidateEditorInventory();
  };
  const linkedXsConstantsText = async (): Promise<string | null> => {
    const selection = await installationSelectionStore.read().catch(() => null);
    if (!selection?.installationRoot) return null;
    const state = await xsEnvironmentSource
      .current(selection.installationRoot, languageContentSelection?.profileId ?? null)
      .catch(() => null);
    return state?.payload.constants?.text ?? null;
  };
  const refreshOpenLanguageCatalog = async () => {
    await refreshXsEnvironment().catch(() => undefined);
    const entries = nativeSupervisor
      .languageDocumentOverlays()
      .filter((document) => /\.(?:rms|rms2)$/iu.test(document.uri));
    const entry =
      entries.find((document) => document.uri === languageCatalogEntryUri) ??
      entries.sort((left, right) => left.uri.localeCompare(right.uri, 'en-US')).at(0);
    if (entry) await scheduleLanguageCatalogUpdate(entry.uri);
  };
  const reportCatalogRefreshFailure = catalogRefreshFailureReporter(
    () => requiredSourceContext(undefined),
    (error) => publishWorkspaceDiagnostic(sourceGraphRefreshFailure(error)),
  );
  const refreshLanguageCatalogAndReportFailure = async (refresh: Promise<void>): Promise<void> => {
    const failureContext = requiredSourceContext(undefined);
    try {
      await refresh;
    } catch (error) {
      reportCatalogRefreshFailure(error, failureContext);
    }
  };
  void refreshXsEnvironment().catch(() => undefined);
  workspaceService.onSourceTreeChange((path) => {
    sourceCatalogService.invalidate(path);
    void refreshLanguageCatalogAndReportFailure(refreshOpenLanguageCatalog());
  });
  let linkedProductVersionCache: { key: string; value: string } | undefined;
  const linkedProductVersionFor = async (versionOrigin: PreviewVersionOrigin) => {
    if (versionOrigin !== 'local') return '';
    const selection = await installationSelectionStore.read();
    if (!selection) return '';
    const installationRoot = resolve(selection.installationRoot);
    const executableName = await detectGameExecutable(installationRoot, installationHost);
    if (!executableName) return '';
    const executablePath = join(installationRoot, executableName);
    let key: string;
    try {
      const metadata = await stat(executablePath);
      if (!metadata.isFile()) return '';
      key = `${executablePath.toLocaleLowerCase('en-US')}|${metadata.size}|${metadata.mtimeMs}`;
    } catch {
      return '';
    }
    if (linkedProductVersionCache?.key === key) return linkedProductVersionCache.value;
    let value = '';
    try {
      const productVersion = (
        await readInstallationProductVersion(installationRoot, executableName, installationHost)
      )?.value;
      if (productVersion && productVersion.length <= 64 && /^[\x20-\x7e]+$/u.test(productVersion)) {
        value = productVersion;
      }
    } catch {
      value = '';
    }
    linkedProductVersionCache = { key, value };
    return value;
  };
  let latestAuthorizedControlLivePreview: AuthorizedControlLivePreview | undefined;
  const generateWithCatalog = async (
    input: PreviewGenerationInput,
    onGenerationEvent: (
      event: Parameters<NonNullable<Parameters<NativeSupervisor['generatePreview']>[2]>>[0],
    ) => void,
    fixtureId?: DevelopmentFixtureDescriptor['id'],
    onExecutionProgress?: (event: ExecutionProgressEvent) => void,
    onPreviewCandidate?: (candidate: PreviewCandidate) => void,
    { previewBound = true }: { previewBound?: boolean } = {},
  ) => {
    const executionSource = captureSourceExecution({
      nativeEpoch: () => nativeSupervisor.languageIdentityEpoch(),
      sourceEpoch: () => sourceCatalogService.identityEpoch(),
    });
    const probeId = input.clientRequestId ?? '';
    const sourceCatalog = await sourceCatalogFor(input);
    executionSource.assertCurrent();
    const localProductVersion = sourceCatalog.roots.standardIncludesAuthorized
      ? await linkedProductVersionFor(input.versionOrigin)
      : '';
    executionSource.assertCurrent();
    latencyProbe.step(probeId, 'source-graph');
    const xsStartOptions = {
      capability: !fixtureId && nativeSupervisor.xsStartCheckSupported(),
      enabled: xsStartCheckPreference && input.xsStartCheck !== false,
      backend: input.backend,
      hasExternalXs: sourceCatalog.sources.some((source) => source.role === 'external-xs'),
    };
    const xsStart = xsStartCheckRequest({
      ...xsStartOptions,
      constantsText: xsStartCheckWanted(xsStartOptions) ? await linkedXsConstantsText() : null,
    });
    executionSource.assertCurrent();
    let current = sourceCatalog;
    const result = await executionSource.run(
      () =>
        nativeSupervisor.generatePreview(
          input,
          sourceCatalog,
          onGenerationEvent,
          fixtureId,
          localProductVersion,
          onExecutionProgress,
          localContentService.sourceFor(input.contentPack),
          onPreviewCandidate,
          xsStart,
        ),
      async () => {
        const latestDocument = nativeSupervisor.languageDocument(input.documentUri);
        if (!latestDocument || latestDocument.text === input.source) {
          await sourceCatalogService.validateWitnesses(sourceCatalog);
          current = sourceCatalog;
        } else {
          current = await sourceCatalogFor({
            ...input,
            documentRevision: latestDocument.version,
            source: latestDocument.text,
          });
        }
        executionSource.assertCurrent();
        sourceCatalogService.assertCurrent(sourceCatalog);
        if (!Buffer.from(current.catalogHash).equals(Buffer.from(sourceCatalog.catalogHash))) {
          throw new Error('source catalog changed while generation was in flight');
        }
      },
    );
    executionSource.assertCurrent();
    if (!previewBound) {
      latencyProbe.step(probeId, 'post-check');
      return result;
    }
    connectorDiagnostics?.recordXsStart(input.documentUri, result.xsStart);
    if (!fixtureId && result.backend === 'exact') {
      if (connectorService?.currentSettings().enabled) shownPreviewMaps.remember(result);
      else shownPreviewMaps.clear();
      const graph = sourceCatalogService.authorizeExactDeployment(current, result);
      mapIconSourceGeneration.remember(graph, input, localProductVersion, result);
      latestAuthorizedControlLivePreview = {
        documentSourceHash: controlLiveDocumentSourceHash(input.source),
        documentSourceLength: input.source.replace(/\r\n?/gu, '\n').length,
        binding: {
          backend: 'exact',
          provenanceStatus: 'exact',
          documentUri: result.documentUri,
          documentRevision: result.documentRevision,
          requestHash: result.requestHash,
          semanticProgramHash: result.semanticProgramHash,
          sourceCatalogRevision: result.sourceCatalogRevision,
          sourceCatalogHash: result.sourceCatalogHash,
          sourceGraphHash: result.sourceGraphHash,
          externalAssetHash: result.externalAssetHash,
          profileId: input.profile.profileId,
          profileHash: input.profile.profileHash,
          contentPackId: input.contentPack.packId,
          contentPackHash: input.contentPack.contentHash,
          width: input.width,
          height: input.height,
          mapSize: input.mapSize as AuthorizedControlLivePreview['binding']['mapSize'],
          seed: input.seed,
        },
        players: structuredClone(input.players),
        modeContext: input.modeContext,
      };
    }
    latencyProbe.step(probeId, 'post-check');
    return result;
  };
  appPictureSheets = {
    withLease: async (label, app, stop, work) => {
      let started = false;
      try {
        return await withExecutionLease(
          `pictures-${randomUUID()}`,
          'pictures',
          label,
          stop,
          () =>
            shuttingDown
              ? nativeSupervisor.forceTerminateRmsd()
              : nativeSupervisor.forceTerminateRmsdAndRestart(),
          () => {
            started = true;
            return work();
          },
          { origin: { kind: 'app', app } },
        );
      } catch (error) {
        if (!started && error instanceof DesktopError && error.code === 'execution.busy') {
          throw busyError(executionLease.state(), Date.now());
        }
        throw error;
      }
    },
    generate: async (template, seed, clientRequestId) => {
      const documentUri = typeof template.documentUri === 'string' ? template.documentUri : '';
      const document = nativeSupervisor.languageDocument(documentUri);
      if (!document) throw new Error('the script is not open in the language server');
      const input = validateGenerationInput({
        ...(template as unknown as PreviewGenerationInput),
        source: document.text,
        documentRevision: document.version,
        seed,
        clientRequestId,
        progressivePreview: false,
        xsStartCheck: false,
      });
      delete input.appRun;
      delete input.automatic;
      return generateWithCatalog(input, () => undefined, undefined, undefined, undefined, {
        previewBound: false,
      });
    },
    cancel: (clientRequestId) =>
      nativeSupervisor.cancelPreview(clientRequestId).then(() => undefined),
    stopAutomatic: () => {
      const state = executionLease.state();
      if (state.phase === 'running' && state.kind === 'rms' && state.automatic === true) {
        void executionLease.stop();
      }
    },
  };
  ipcMain.handle(ipcChannels.getDesktopSession, async (event) => {
    assertTrustedSender(event.senderFrame?.url);
    await discoverInstalledSources();
    const recovery = await recoveryStore.read().catch(() => null);
    const restored = await workspaceService.restoreDesktopSession(
      await sessionStore.read(),
      recovery,
    );
    return {
      ...restored,
      session: {
        ...restored.session,
        window: { bounds: null, maximized: false, display: null },
        dialogLocations: { ...cloneDefaultDesktopSession().dialogLocations },
        rmsLintRules: [],
        mapTransitions: mapTransitionsPreference,
        xsStartCheck: xsStartCheckPreference,
      },
    };
  });
  ipcMain.handle(ipcChannels.saveDesktopSession, async (event, session: DesktopSession) => {
    assertTrustedSender(event.senderFrame?.url);
    const browserWindow = assertMainWindowSender(event.sender);
    const current = await sessionStore.read();
    const authorized = workspaceService.authorizeDesktopSession(
      validateDesktopSession(session),
      (reason) => console.warn(`desktop session saved without stale state: ${reason}`),
    );
    formatOnSavePreference = authorized.formatOnSave;
    const formatMenuItem = applicationMenu?.getMenuItemById('edit.format-on-save');
    if (formatMenuItem) formatMenuItem.checked = formatOnSavePreference;
    indentConditionalsPreference = authorized.indentConditionals;
    const indentMenuItem = applicationMenu?.getMenuItemById('edit.indent-conditionals');
    if (indentMenuItem) indentMenuItem.checked = indentConditionalsPreference;
    liveGenerationStagesPreference = authorized.liveGenerationStages;
    const stagesMenuItem = applicationMenu?.getMenuItemById('view.live-generation-stages');
    if (stagesMenuItem) stagesMenuItem.checked = liveGenerationStagesPreference;
    gpuMapRenderingPreference = authorized.gpuMapRendering;
    const gpuMenuItem = applicationMenu?.getMenuItemById('view.gpu-map-rendering');
    if (gpuMenuItem) gpuMenuItem.checked = gpuMapRenderingPreference;
    mapTransitionsPreference = authorized.mapTransitions;
    const transitionsMenuItem = applicationMenu?.getMenuItemById('view.map-transitions');
    if (transitionsMenuItem) transitionsMenuItem.checked = mapTransitionsPreference;
    inlayHintsPreference = authorized.inlayHints;
    const inlayHintsMenuItem = applicationMenu?.getMenuItemById('view.inlay-hints');
    if (inlayHintsMenuItem) inlayHintsMenuItem.checked = inlayHintsPreference;
    outlineRowPreference = authorized.outlineRow;
    const outlineRowMenuItem = applicationMenu?.getMenuItemById('view.outline-row');
    if (outlineRowMenuItem) outlineRowMenuItem.checked = outlineRowPreference;
    deletePermanentlyPreference = authorized.deletePermanently;
    const deleteMenuItem = applicationMenu?.getMenuItemById('edit.delete-permanently');
    if (deleteMenuItem) deleteMenuItem.checked = deletePermanentlyPreference;
    publishApplicationMenuModel();
    return sessionStore.write({
      ...authorized,
      window: currentWindowRecord(browserWindow),
      dialogLocations: current.dialogLocations,
      gameTexturesFirstLinkApplied: current.gameTexturesFirstLinkApplied,
      gameTexturesFirstLinkInstallations: current.gameTexturesFirstLinkInstallations,
      rmsLintRules: current.rmsLintRules,
      languagePreference: current.languagePreference,
      checkForNewVersions: current.checkForNewVersions,
      xsStartCheck: current.xsStartCheck,
      mapIconReliefMode: current.mapIconReliefMode,
      mapIconTerrainSmoothing: current.mapIconTerrainSmoothing,
      mapIconSpawnMarkerStyle: current.mapIconSpawnMarkerStyle,
      mapIconSpawnMarkerSizePercent: current.mapIconSpawnMarkerSizePercent,
      mapIconPerspective: current.mapIconPerspective,
      mapIconLook: current.mapIconLook,
      mapIconTrees: current.mapIconTrees,
      mapIconTreeDensityLevel: current.mapIconTreeDensityLevel,
      mapIconTreeSize: current.mapIconTreeSize,
      mapIconTreeSpawnOverlap: current.mapIconTreeSpawnOverlap,
      mapIconResources: current.mapIconResources,
      mapIconResourceDensityLevel: current.mapIconResourceDensityLevel,
      mapIconResourceSize: current.mapIconResourceSize,
      mapIconResourceSpawnOverlap: current.mapIconResourceSpawnOverlap,
      mapIconMinimapObjects: current.mapIconMinimapObjects,
    });
  });
  ipcMain.handle(ipcChannels.disableRmsLintRule, async (event, code: unknown) => {
    assertTrustedSender(event.senderFrame?.url);
    if (!isRmsLintCode(code)) throw new Error('the code is not an RMS lint rule');
    await setRmsLintRule(code, false);
  });
  ipcMain.handle(ipcChannels.resetLayout, (event) => {
    assertTrustedSender(event.senderFrame?.url);
    return sessionStore.resetLayout();
  });
  ipcMain.handle(ipcChannels.nativeStatus, (event) => {
    assertTrustedSender(event.senderFrame?.url);
    return nativeSupervisor.getStatuses();
  });
  ipcMain.handle(ipcChannels.executionState, (event) => {
    assertTrustedSender(event.senderFrame?.url);
    assertMainWindowSender(event.sender);
    return executionLease.state();
  });
  ipcMain.handle(ipcChannels.executionStop, (event) => {
    assertTrustedSender(event.senderFrame?.url);
    assertMainWindowSender(event.sender);
    return executionLease.stop();
  });
  ipcMain.handle(ipcChannels.mapTestQualityAvailable, async (event) => {
    assertTrustedSender(event.senderFrame?.url);
    assertMainWindowSender(event.sender);
    return nativeSupervisor.mapTestQualitySupported();
  });
  ipcMain.handle(ipcChannels.mapTestRun, async (event, input: MapTestRunInput) => {
    assertTrustedSender(event.senderFrame?.url);
    assertMainWindowSender(event.sender);
    const validated = validateMapTestRunInput(input);
    const { appRun } = validated;
    delete validated.appRun;
    let appTicket: AppRunTicket | undefined;
    if (appRun) {
      const claimed = appRunTickets.claim(appRun.token, [
        validated.quality ? 'quality-check' : 'map-test',
      ]);
      if (claimed === undefined) throw new Error('map-test app run is unknown');
      if (claimed === 'cancelled') throw new Error('the AI app stopped the map test');
      appTicket = claimed;
      appTicket.executionId = validated.executionId;
    }
    const snapshot = await prepareRootExecution(() => sourceCatalogsForMapTest(validated)).catch(
      (error: unknown) => {
        if (error instanceof SourceCatalogBatchError)
          publishWorkspaceDiagnostic(sourceGraphRefreshFailure(error));
        throw error;
      },
    );
    const request: MapTestRunInput = {
      ...validated,
      workspaceName: snapshot.workspaceName,
      defaultSourcePath: snapshot.defaultSourcePath,
    };
    const qualityCheck = request.quality !== undefined;
    const mapTestLabel = qualityCheck
      ? `Quality check · ${qualityCheckMapName(request.scriptUri)}`
      : `Map test · ${request.scriptName}`;
    return withExecutionLease(
      request.executionId,
      'map-test',
      appTicket ? appExecutionLabel(appTicket.app, mapTestLabel) : mapTestLabel,
      () => nativeSupervisor.cancelMapTest(request.executionId).then(() => undefined),
      () => nativeSupervisor.forceTerminateMapTest(),
      async () => {
        presentationArbiter.beginFinals();
        event.sender.send(ipcChannels.mapTestEvent, {
          kind: 'started',
          executionId: request.executionId,
          text: `${mapTestLabel} started`,
        });
        try {
          const result = await nativeSupervisor.runMapTest(
            request,
            snapshot.catalogs,
            (mapTestEvent) => {
              if (mapTestEvent.kind === 'preview') presentationArbiter.offerFinal(mapTestEvent);
              else if (mapTestEvent.kind === 'progress') {
                if (!event.sender.isDestroyed()) {
                  event.sender.send(ipcChannels.mapTestEvent, mapTestEvent);
                }
                appTicket?.onProgress?.(mapTestEvent.completed, mapTestEvent.requested);
              } else {
                presentationArbiter.endFinals();
                event.sender.send(ipcChannels.mapTestEvent, mapTestEvent);
              }
            },
            localContentService.sourceFor(request.contentPack),
            await linkedXsConstantsText(),
          );
          presentationArbiter.endFinals();
          const currentScript = qualityCheck
            ? undefined
            : nativeSupervisor.languageDocument(request.scriptUri);
          if (currentScript && currentScript.text !== request.scriptSource) {
            throw new Error('map-test script changed while execution was in flight');
          }
          const current = await sourceCatalogsForMapTest(request);
          if (
            current.catalogs.length !== snapshot.catalogs.length ||
            current.catalogs.some(
              (catalog, index) =>
                Buffer.compare(
                  Buffer.from(catalog.catalogHash),
                  Buffer.from(snapshot.catalogs[index]!.catalogHash),
                ) !== 0,
            )
          ) {
            throw new Error('map-test source graph changed while execution was in flight');
          }
          event.sender.send(ipcChannels.mapTestEvent, {
            kind: 'completed',
            executionId: request.executionId,
            text: `${mapTestLabel} ${result.status} in ${result.elapsedMilliseconds} ms`,
          });
          if (appTicket) appRunTickets.capture(appTicket, result, Date.now());
          return result;
        } finally {
          presentationArbiter.endFinals();
        }
      },
      appTicket ? { origin: { kind: 'app', app: appTicket.app } } : {},
    );
  });
  ipcMain.handle(ipcChannels.mapTestReplay, async (event, input: MapTestReplayInput) => {
    assertTrustedSender(event.senderFrame?.url);
    assertMainWindowSender(event.sender);
    if (
      !input ||
      !/^[A-Za-z0-9._:-]{1,128}$/u.test(input.executionId) ||
      typeof input.scriptUri !== 'string' ||
      input.scriptUri.length > 4096 ||
      typeof input.scriptSource !== 'string' ||
      Buffer.byteLength(input.scriptSource, 'utf8') > 1024 * 1024 ||
      !/^[a-f0-9]{64}$/u.test(input.findingId) ||
      !isSelectedTexturePaletteOrAbsent(input.texturePalette) ||
      (input.versionOrigin !== 'packaged' && input.versionOrigin !== 'local')
    ) {
      throw new Error('map-test replay input is invalid');
    }
    const { finding, generationInput, sourceInput, catalog, executionSource } =
      await prepareRootExecution(async () => {
        const executionSource = captureSourceExecution({
          nativeEpoch: () => nativeSupervisor.languageIdentityEpoch(),
          sourceEpoch: () => sourceCatalogService.identityEpoch(),
        });
        const report = validateMapTestReportJson(JSON.stringify(input.report));
        const finding = report.findings.find(
          (candidate) => candidate.findingId === input.findingId,
        );
        if (!finding) throw new Error('the selected map-test finding is unavailable');
        const qualityReport =
          report.script.name === qualityScriptName && report.quality !== undefined;
        const currentScriptHash = createHash('sha256')
          .update(input.scriptSource.replaceAll('\r\n', '\n').replaceAll('\r', '\n'))
          .digest('hex');
        if (!qualityReport && currentScriptHash !== report.script.semanticHash) {
          throw new Error('the current map-test script identity differs from the report');
        }
        const settings = mapTestFindingSettings(report, finding);
        if (!settings) throw new Error('the finding settings are unavailable in the report');
        if (report.engineVersion !== 'exact-rms-v1') {
          throw new Error('the map-test report engine identity is unsupported');
        }
        const configuration = await configurationCatalogWithLocalContent();
        executionSource.assertCurrent();
        const profile = configuration.behaviorProfiles.find(
          (candidate) =>
            candidate.profileId === report.profile.id &&
            candidate.behaviorVersion === report.profile.version &&
            candidate.profileHash === report.profile.hash,
        );
        const contentPack = configuration.contentPacks.find(
          (candidate) =>
            candidate.packId === report.content.id &&
            candidate.packVersion === report.content.version &&
            candidate.contentHash === report.content.hash,
        );
        if (!profile || !contentPack) {
          throw new Error('the report profile or content identity is no longer available');
        }
        const sourceDocument = await workspaceService.resolveMapTestRmsSource(
          input.scriptUri,
          finding.sourcePath,
        );
        executionSource.assertCurrent();
        const overlay = nativeSupervisor.languageDocument(sourceDocument.uri);
        const sourceInput: PreviewGenerationInput = {
          clientRequestId: input.executionId,
          documentUri: sourceDocument.uri,
          documentRevision: overlay?.version ?? 0,
          source: overlay?.text ?? sourceDocument.content,
          profile,
          contentPack,
          versionOrigin: input.versionOrigin,
          backend: 'exact',
          width: settings.width,
          height: settings.height,
          mapSize: settings.mapSize,
          seed: finding.seed,
          players: settings.players.map(({ slot, team, civilizationId }) => ({
            slot,
            team,
            civilizationId,
          })),
          modeContext: mapTestReplayModeContext(report, settings),
          traceLevel: 'off',
          minimapPalette: input.minimapPalette,
          texturePalette: input.texturePalette ?? null,
        };
        const catalog = await sourceCatalogFor(sourceInput);
        executionSource.assertCurrent();
        if (Buffer.from(catalog.rmsGraphHash).toString('hex') !== finding.sourceGraphHash) {
          throw new Error('the current RMS source graph identity differs from the finding');
        }
        const generationInput = mapTestReplayGenerationInput(
          sourceInput,
          catalog.revision,
          report,
          finding,
        );
        return { finding, generationInput, sourceInput, catalog, executionSource };
      });
    return withExecutionLease(
      input.executionId,
      'map-test',
      `Replay finding · seed ${finding.seed}`,
      () => nativeSupervisor.cancelPreview(input.executionId).then(() => undefined),
      () => nativeSupervisor.forceTerminateRmsdAndRestart(),
      async () => {
        const result = await executionSource.run(
          () =>
            nativeSupervisor.generatePreview(generationInput, catalog, (generationEvent) => {
              if (generationEvent.kind !== 'delta-batch') {
                event.sender.send(ipcChannels.previewGenerationEvent, generationEvent);
              }
            }),
          async (result) => {
            const current = await sourceCatalogFor(
              currentMapTestReplaySourceInput(
                sourceInput,
                nativeSupervisor.languageDocument(sourceInput.documentUri),
              ),
            );
            executionSource.assertCurrent();
            sourceCatalogService.assertCurrent(catalog);
            if (!Buffer.from(current.catalogHash).equals(Buffer.from(catalog.catalogHash))) {
              throw new Error('source catalog changed while finding replay was in flight');
            }
            if (result.requestHash !== finding.requestHash) {
              throw new Error(
                'the regenerated finding request does not match its recorded identity',
              );
            }
            if (result.semanticHash !== finding.mapHash) {
              throw new Error('the regenerated finding map does not match its recorded identity');
            }
          },
        );
        executionSource.assertCurrent();
        return result;
      },
    );
  });
  ipcMain.handle(ipcChannels.mapTestReportExport, async (event, reportJson: string) => {
    assertTrustedSender(event.senderFrame?.url);
    const browserWindow = assertMainWindowSender(event.sender);
    const report = validateMapTestReportJson(reportJson);
    const directory = await selectionDirectory('mapTestReportExport');
    const name = `${basename(report.script.name, extname(report.script.name))}-map-test-report.json`;
    const selection = await showSaveDialog(browserWindow, {
      defaultPath: directory ? join(directory, name) : name,
      filters: [{ name: t('native-dialog.map-test-report.filter'), extensions: ['json'] }],
      title: t('native-dialog.map-test-report.export.title'),
    });
    if (selection.canceled || !selection.filePath) return null;
    await sessionStore.updateDialogLocation('mapTestReportExport', dirname(selection.filePath));
    await writeFile(selection.filePath, Buffer.from(reportJson, 'utf8'));
    return selection.filePath;
  });
  ipcMain.handle(ipcChannels.mapTestReportImport, async (event) => {
    assertTrustedSender(event.senderFrame?.url);
    const browserWindow = assertMainWindowSender(event.sender);
    const defaultPath = await selectionDirectory('mapTestReportImport');
    const selection = await showOpenDialog(browserWindow, {
      ...(defaultPath ? { defaultPath } : {}),
      filters: [{ name: t('native-dialog.map-test-report.filter'), extensions: ['json'] }],
      properties: ['openFile', 'dontAddToRecent'],
      title: t('native-dialog.map-test-report.import.title'),
    });
    const path = selection.filePaths[0];
    if (selection.canceled || !path) return null;
    await sessionStore.updateDialogLocation('mapTestReportImport', dirname(path));
    const bytes = await readFileBounded(path, maximumMapTestReportBytes).catch((error) => {
      if (error instanceof FileTooLargeError) {
        throw new DesktopError(
          'map-test.report-too-large',
          'map-test report exceeds the 16 MiB limit',
          {
            limit: 16,
          },
        );
      }
      throw error;
    });
    try {
      const reportJson = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return { report: validateMapTestReportJson(reportJson), reportJson };
    } catch (error) {
      throw new DesktopError(
        'map-test.report-invalid',
        error instanceof Error ? error.message : String(error),
      );
    }
  });
  ipcMain.handle(
    ipcChannels.languageServerRequest,
    async (event, method: LanguageServerRequestMethod, params: unknown) => {
      assertTrustedSender(event.senderFrame?.url);
      assertBoundedLanguagePayload(params);
      const editorRequest =
        editorInventoryCoordinator &&
        !nativeSupervisor.usesMapTestLanguage(params) &&
        method !== 'rms/semanticIdentity' &&
        method !== 'rms/validateSourceCatalogIdentity'
          ? editorInventoryCoordinator.capture(params)
          : undefined;
      const probeId = `language-${++languageProbeSequence}`;
      latencyProbe.openRequest(probeId, 'language');
      if (languageDocumentSyncWorker) {
        flushLanguageDocumentSync?.();
        try {
          await languageDocumentSyncWorker;
        } catch (error) {
          if (editorRequest) editorInventoryCoordinator?.release(editorRequest);
          latencyProbe.closeRequest(probeId, 'committed');
          throw error;
        }
      }
      latencyProbe.step(probeId, 'sync-wait');
      if (method === 'rms/semanticIdentity' || method === 'rms/validateSourceCatalogIdentity') {
        const failureUri = languageDocumentUri(params);
        const failureContext = requiredSourceContext(failureUri);
        try {
          if (!editionCapabilities.sourceCatalog)
            throw new Error('include analysis is unavailable in this edition');
          return method === 'rms/semanticIdentity'
            ? await languageReadiness.analyze(params)
            : await languageReadiness.validate(params);
        } catch (error) {
          if (
            failureContext === requiredSourceContext(failureUri) &&
            !reportRequiredSourceLimit(error, failureContext)
          )
            publishWorkspaceDiagnostic(sourceGraphRefreshFailure(error));
          throw error;
        } finally {
          latencyProbe.closeRequest(probeId, 'committed');
        }
      }
      if (!editorInventoryCoordinator && method !== 'textDocument/semanticTokens/full') {
        const uri = languageDocumentUri(params);
        if (uri && /\.(?:rms|rms2)$/iu.test(uri)) {
          await refreshLanguageCatalogAndReportFailure(ensureLanguageCatalog(uri));
        } else if (languageCatalogWorker) {
          await languageCatalogWorker.catch(() => undefined);
        }
      }
      latencyProbe.step(probeId, 'catalog');
      latencyProbe.languageContext(probeId);
      let builtInAsked = false;
      let captureReleased = false;
      const builtIn = (): Promise<unknown> => {
        builtInAsked = true;
        if (editorRequest && editorInventoryCoordinator && captureReleased) {
          return editorInventoryCoordinator.requestCurrent(method, params);
        }
        if (editorRequest && editorInventoryCoordinator) {
          const local =
            [
              'textDocument/semanticTokens/full',
              'textDocument/documentSymbol',
              'textDocument/foldingRange',
              'rms/snippets',
            ].includes(method) &&
            !!editorRequest.uri &&
            /\.(?:rms|rms2|inc|def)$/iu.test(editorRequest.uri);
          return local
            ? editorInventoryCoordinator.localRequest(method, params, editorRequest)
            : editorInventoryCoordinator.requestCurrent(method, params, editorRequest);
        }
        return nativeSupervisor.requestLanguageServer(method, params);
      };
      try {
        return await (externalLanguageServers
          ? externalLanguageServers.request(method, params, builtIn, () => {
              if (!editorRequest || builtInAsked) return;
              captureReleased = true;
              editorInventoryCoordinator?.release(editorRequest);
            })
          : builtIn());
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === -32801) return null;
        throw error;
      } finally {
        if (!builtInAsked && editorRequest) editorInventoryCoordinator?.release(editorRequest);
        latencyProbe.languageContext(undefined);
        latencyProbe.step(probeId, 'language-server');
        latencyProbe.closeRequest(probeId, 'committed');
      }
    },
  );
  ipcMain.handle(
    ipcChannels.languageServerNotification,
    async (event, method: LanguageServerNotificationMethod, params: unknown) => {
      assertTrustedSender(event.senderFrame?.url);
      assertBoundedLanguagePayload(params);
      const uri = languageDocumentUri(params);
      if (method === 'rms/previewContext') {
        const selection = languageContentSelectionFrom(params);
        const changed =
          JSON.stringify(selection) !== JSON.stringify(languageContentSelection ?? null);
        languageContentSelection = selection ?? undefined;
        nativeSupervisor.notifyLanguageServer(method, params);
        if (changed) {
          languageReadiness.invalidate();
          invalidateEditorInventory();
          publishLanguageServerNotification('rms/sourceCatalogInvalidated', {});
          await refreshLanguageCatalogAndReportFailure(refreshOpenLanguageCatalog());
        }
        return;
      }
      if (method === 'textDocument/didChange' && uri) {
        nativeSupervisor.mirrorLanguageServerNotification(method, params);
        externalLanguageServers?.didChange(params);
        await scheduleLanguageDocumentSync(uri);
        scheduleEditorInventoryRefresh();
      } else {
        if (method === 'textDocument/didClose' && uri) cancelLanguageDocumentSync(uri);
        try {
          nativeSupervisor.notifyLanguageServer(method, params);
        } catch (error) {
          if (method === 'textDocument/didClose') externalLanguageServers?.didClose(params);
          throw error;
        }
        if (method === 'textDocument/didOpen') externalLanguageServers?.didOpen(params);
        else if (method === 'textDocument/didClose') externalLanguageServers?.didClose(params);
      }
      if (!uri) return;
      if (method === 'textDocument/didOpen' || method === 'textDocument/didClose') {
        if (method === 'textDocument/didOpen' && /\.(?:rms|rms2)$/iu.test(uri))
          editorContextDocumentUri = uri;
        if (method === 'textDocument/didClose' && editorContextDocumentUri === uri)
          editorContextDocumentUri = undefined;
        invalidateEditorInventory();
      }
      if (method === 'textDocument/didClose') {
        if (languageCatalogEntryUri === uri) languageCatalogEntryUri = undefined;
        await refreshLanguageCatalogAndReportFailure(refreshOpenLanguageCatalog());
      } else if (/\.(?:rms|rms2)$/iu.test(uri)) {
        if (method === 'textDocument/didOpen') {
          await refreshLanguageCatalogAndReportFailure(scheduleLanguageCatalogUpdate(uri));
        } else if (languageCatalogWorker) {
          await refreshLanguageCatalogAndReportFailure(languageCatalogWorker);
        }
      } else if (/\.(?:inc|def|xs)$/iu.test(uri)) {
        await refreshLanguageCatalogAndReportFailure(refreshOpenLanguageCatalog());
      }
    },
  );
  ipcMain.handle(ipcChannels.restartNative, (event, name: NativeProcessName) => {
    assertTrustedSender(event.senderFrame?.url);
    if (name !== 'rmsd' && name !== 'rms-ls' && name !== 'rms-test' && name !== 'rms-test-lsp') {
      throw new Error('invalid native process name');
    }
    if (!nativeProcessAllowed(name, editionCapabilities)) {
      throw new Error('this feature is not part of this edition');
    }
    return nativeSupervisor.restart(name);
  });
  ipcMain.handle(ipcChannels.configurationCatalog, (event) => {
    assertTrustedSender(event.senderFrame?.url);
    return configurationCatalogWithLocalContent().then(productConfigurationCatalog);
  });
  ipcMain.handle(ipcChannels.generatePreview, async (event, input: PreviewGenerationInput) => {
    assertTrustedSender(event.senderFrame?.url);
    const probeStarted = latencyProbe.now();
    const validated = validateGenerationInput(input);
    if (validated.backend !== 'exact') {
      throw new Error('normal preview generation does not accept the synthetic backend');
    }
    const { appRun, automatic } = validated;
    delete validated.appRun;
    delete validated.automatic;
    let appTicket: AppRunTicket | undefined;
    if (appRun) {
      const claimed = appRunTickets.claim(appRun.token, ['generate']);
      if (claimed === undefined) throw new Error('generation app run is unknown');
      if (claimed === 'cancelled') {
        return {
          status: 'cancelled',
          cancellation: previewGenerationCancellation('the AI app stopped the run'),
        };
      }
      appTicket = claimed;
    }
    const executionId = validated.clientRequestId ?? `preview-${randomUUID()}`;
    validated.clientRequestId = executionId;
    if (appTicket) appTicket.executionId = executionId;
    const leaseLabel = `RMS · ${basename(validated.documentUri)}`;
    latencyProbe.openRequest(executionId, 'generation');
    latencyProbe.stepUntil(executionId, 'validate', probeStarted);
    latencyProbe.step(executionId, 'validate');
    const settled = settleRendererGeneration(
      withExecutionLease(
        executionId,
        'rms',
        appTicket ? appExecutionLabel(appTicket.app, leaseLabel) : leaseLabel,
        () => nativeSupervisor.cancelPreview(executionId).then(() => undefined),
        () =>
          shuttingDown
            ? nativeSupervisor.forceTerminateRmsd()
            : nativeSupervisor.forceTerminateRmsdAndRestart(),
        async () => {
          latencyProbe.step(executionId, 'lease');
          const progressive = validated.progressivePreview === true;
          if (progressive) presentationArbiter.beginCandidates(executionId);
          try {
            const result = await generateWithCatalog(
              validated,
              (generationEvent) => {
                if (generationEvent.kind !== 'delta-batch') {
                  event.sender.send(ipcChannels.previewGenerationEvent, generationEvent);
                }
              },
              undefined,
              (progress) => {
                if (!event.sender.isDestroyed()) {
                  event.sender.send(ipcChannels.previewExecutionProgress, progress);
                }
              },
              progressive
                ? (candidate) => presentationArbiter.offerCandidate(candidate)
                : undefined,
            );
            if (appTicket) {
              appRunTickets.capture(appTicket, result, Date.now(), {
                uri: validated.documentUri,
                text: validated.source,
              });
            }
            return result;
          } finally {
            presentationArbiter.revokeCandidates(executionId);
          }
        },
        appTicket
          ? { origin: { kind: 'app', app: appTicket.app } }
          : automatic === true
            ? { automatic: true }
            : {},
      ),
    );
    return settled.then(
      (settlement) => {
        latencyProbe.step(executionId, 'settle');
        latencyProbe.closeRequest(executionId, 'committed');
        return settlement;
      },
      (error: unknown) => {
        latencyProbe.closeRequest(executionId, 'failed');
        throw error;
      },
    );
  });
  ipcMain.on(ipcChannels.previewCandidateAcknowledge, (event, acknowledgement: unknown) => {
    if (
      !isRendererDocumentUrl(event.senderFrame?.url) ||
      event.sender !== mainWindow?.webContents
    ) {
      return;
    }
    try {
      presentationArbiter.acknowledge(validatePreviewCandidateAcknowledgement(acknowledgement));
    } catch {}
  });
  ipcMain.handle(ipcChannels.cancelPreviewGeneration, async (event, clientRequestId: string) => {
    assertTrustedSender(event.senderFrame?.url);
    if (
      typeof clientRequestId !== 'string' ||
      clientRequestId.length < 1 ||
      clientRequestId.length > 512
    ) {
      throw new Error('preview request identity is invalid');
    }
    return nativeSupervisor.cancelPreview(clientRequestId).catch(() => false);
  });
  ipcMain.handle(ipcChannels.mapIconSourceGenerate, (event, request: unknown) => {
    assertTrustedSender(event.senderFrame?.url);
    assertMainWindowSender(event.sender);
    return settlePreviewGeneration(
      mapIconSourceGeneration.generate(request, (progress) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send(ipcChannels.mapIconExecutionProgress, progress);
        }
      }),
      isMapIconSourceCancellation,
      (error) => (isProtocolCancellation(error) ? error.protocolMessage : error.message),
    );
  });
  ipcMain.handle(ipcChannels.mapIconSourceCancel, (event, clientRequestId: unknown) => {
    assertTrustedSender(event.senderFrame?.url);
    assertMainWindowSender(event.sender);
    if (!validMapIconSourceRequestId(clientRequestId)) {
      throw new Error('map icon generation request identity is invalid');
    }
    return mapIconSourceGeneration.cancel(clientRequestId);
  });
  ipcMain.handle(ipcChannels.developmentFixtures, (event) => {
    assertTrustedSender(event.senderFrame?.url);
    return developmentFixturesEnabled() ? structuredClone(developmentFixtureDescriptors) : [];
  });
  ipcMain.handle(
    ipcChannels.runDevelopmentFixture,
    async (event, request: DevelopmentFixtureRequest) => {
      assertTrustedSender(event.senderFrame?.url);
      if (!developmentFixturesEnabled()) {
        throw new Error('synthetic generation is unavailable outside the test harness');
      }
      if (!developmentFixtureDescriptors.some((fixture) => fixture.id === request?.fixtureId)) {
        throw new Error('development fixture is unknown');
      }
      const validated = validateGenerationInput(request.input);
      if (validated.backend !== 'exact') {
        throw new Error('development fixtures accept only a product request template');
      }
      const catalog = await nativeSupervisor.getConfigurationCatalog();
      const syntheticPacks = catalog.contentPacks.filter((pack) => pack.synthetic);
      const syntheticContentPack =
        syntheticPacks.find((pack) =>
          pack.compatibleProfileIds.includes(validated.profile.profileId),
        ) ?? syntheticPacks[0];
      const fixtureProfile = syntheticContentPack?.compatibleProfileIds.includes(
        validated.profile.profileId,
      )
        ? validated.profile
        : catalog.behaviorProfiles.find((profile) =>
            syntheticContentPack?.compatibleProfileIds.includes(profile.profileId),
          );
      if (!syntheticContentPack || !fixtureProfile) {
        throw new Error('development fixture synthetic content is unavailable');
      }
      const fixtureInput: PreviewGenerationInput = {
        ...validated,
        profile: fixtureProfile,
        backend: 'synthetic',
        contentPack: syntheticContentPack,
        ...(request.fixtureId === 'large' ? { width: 480, height: 480, mapSize: 'ludicrous' } : {}),
      };
      const executionId = fixtureInput.clientRequestId ?? `fixture-${randomUUID()}`;
      fixtureInput.clientRequestId = executionId;
      return settleRendererGeneration(
        withExecutionLease(
          executionId,
          'rms',
          `Internal RMS fixture · ${request.fixtureId}`,
          () => nativeSupervisor.cancelPreview(executionId).then(() => undefined),
          () => nativeSupervisor.forceTerminateRmsdAndRestart(),
          () =>
            generateWithCatalog(
              fixtureInput,
              (generationEvent) => {
                if (generationEvent.kind !== 'delta-batch') {
                  event.sender.send(ipcChannels.previewGenerationEvent, generationEvent);
                }
              },
              request.fixtureId,
            ),
        ),
      );
    },
  );
  ipcMain.handle(ipcChannels.discoverInstallations, async (event) => {
    assertTrustedSender(event.senderFrame?.url);
    return discoverAndRememberInstallationReports();
  });
  ipcMain.handle(ipcChannels.pickManualInstallation, async (event) => {
    assertTrustedSender(event.senderFrame?.url);
    const browserWindow = assertMainWindowSender(event.sender);
    const defaultPath = await selectionDirectory('gameFolder');
    const selection = await showOpenDialog(browserWindow, {
      ...(defaultPath ? { defaultPath } : {}),
      title: t('native-dialog.game-folder.title'),
      properties: ['openDirectory', 'dontAddToRecent'],
    });
    const path = selection.filePaths[0];
    if (selection.canceled || !path) return null;
    await sessionStore.updateDialogLocation('gameFolder', path);
    const { userProfileRoot } = developmentOverrides();
    const report = await discoverManualInstallation(
      path,
      installationHost,
      userProfileRoot ? { userProfileRoot } : {},
    );
    if (report.valid) {
      const remembered = await installationSelectionStore.read();
      const sameInstallation =
        remembered &&
        resolve(remembered.installationRoot).toLocaleLowerCase('en-US') ===
          resolve(report.evidence.installationRoot.value).toLocaleLowerCase('en-US');
      await installationSelectionStore.write({
        installationRoot: report.evidence.installationRoot.value,
        ...(sameInstallation && remembered.userProfileId
          ? { userProfileId: remembered.userProfileId }
          : {}),
      });
      updateGameFolderLinked(true);
      sourceCatalogService.invalidate();
      await discoverInstalledSources(true);
      await refreshLanguageCatalogAndReportFailure(refreshOpenLanguageCatalog());
    }
    return report;
  });
  ipcMain.handle(ipcChannels.rememberedInstallationSelection, (event) => {
    assertTrustedSender(event.senderFrame?.url);
    return installationSelectionStore.read();
  });
  ipcMain.handle(
    ipcChannels.rememberInstallationSelection,
    async (event, selection: RememberedInstallationSelection) => {
      assertTrustedSender(event.senderFrame?.url);
      const requestedRoot =
        selection && typeof selection.installationRoot === 'string'
          ? resolve(selection.installationRoot).toLocaleLowerCase('en-US')
          : null;
      const discovered = requestedRoot
        ? (await discoverInstallationReports()).find(
            (report) =>
              resolve(report.evidence.installationRoot.value).toLocaleLowerCase('en-US') ===
              requestedRoot,
          )
        : undefined;
      if (!discovered) throw new Error('installation selection is not a discovered installation');
      const remembered = await installationSelectionStore.read();
      const sameInstallation =
        remembered &&
        resolve(remembered.installationRoot).toLocaleLowerCase('en-US') === requestedRoot;
      await installationSelectionStore.write({
        ...selection,
        installationRoot: discovered.evidence.installationRoot.value,
        ...(selection.userProfileId === undefined && sameInstallation && remembered.userProfileId
          ? { userProfileId: remembered.userProfileId }
          : {}),
      });
      updateGameFolderLinked(true);
      sourceCatalogService.invalidate();
      await discoverInstalledSources(true);
      await refreshLanguageCatalogAndReportFailure(refreshOpenLanguageCatalog());
    },
  );
  ipcMain.handle(ipcChannels.forgetInstallationSelection, async (event) => {
    assertTrustedSender(event.senderFrame?.url);
    const operation = installationDiscoveryTail.then(async () => {
      await installationSelectionStore.unlink();
      updateGameFolderLinked(false);
      await syncLinkedResourceProtection();
      installedSourceCatalogPromise = undefined;
      await installedSourceService.discover([], null);
      sourceCatalogService.invalidate();
      await refreshLanguageCatalogAndReportFailure(refreshOpenLanguageCatalog());
    });
    installationDiscoveryTail = operation.then(
      () => undefined,
      () => undefined,
    );
    await operation;
  });
  ipcMain.handle(
    ipcChannels.languageGameVersion,
    async (event, profileId: unknown, versionOrigin: unknown = 'packaged') => {
      assertTrustedSender(event.senderFrame?.url);
      if (
        profileId !== null &&
        !packagedBehaviorProfiles.some(([, profile]) => profile.profileId === profileId)
      ) {
        throw new Error('the game version is not a packaged version');
      }
      if (versionOrigin !== 'packaged' && versionOrigin !== 'local') {
        throw new Error('the game version origin is invalid');
      }
      if (
        languageGameVersionProfileId === profileId &&
        languageGameVersionOrigin === versionOrigin
      ) {
        return;
      }
      languageGameVersionProfileId = profileId as string | null;
      languageGameVersionOrigin = versionOrigin;
      if (editionCapabilities.sourceCatalog && !editionCapabilities.preview) {
        await refreshLanguageCatalogAndReportFailure(refreshOpenLanguageCatalog());
      } else {
        await refreshXsEnvironment().catch(() => undefined);
      }
    },
  );
  ipcMain.handle(
    ipcChannels.standardIncludeAccess,
    async (event, versionOrigin: PreviewVersionOrigin) => {
      assertTrustedSender(event.senderFrame?.url);
      if (versionOrigin !== 'packaged' && versionOrigin !== 'local') {
        throw new Error('preview version origin is invalid');
      }
      const selection = await installationSelectionStore.read();
      return resolveStandardIncludeAccess(
        versionOrigin === 'local',
        selection?.installationRoot ?? null,
      );
    },
  );
  const localPresentationNames = new LocalPresentationNameService({
    stat: async (path) => {
      try {
        const metadata = await stat(path);
        return metadata.isFile() ? { size: metadata.size, mtimeMs: metadata.mtimeMs } : null;
      } catch {
        return null;
      }
    },
    readFile: async (path, maximumBytes) => {
      try {
        return await readFileBounded(path, maximumBytes);
      } catch {
        return null;
      }
    },
    listDirectory: async (path) => {
      try {
        return (await readdir(path, { withFileTypes: true }))
          .filter((entry) => entry.isFile())
          .map((entry) => entry.name);
      } catch {
        return null;
      }
    },
    readStringIds: (datPath) => nativeSupervisor.readPresentationStringIds(datPath),
  });
  const gameArtService = new GameArtService(
    {
      installation: async () => {
        const selection = await installationSelectionStore.read();
        if (!selection || !gameFolderLinked) return null;
        let installationRoot: string;
        try {
          installationRoot = await realpath(resolve(selection.installationRoot));
        } catch {
          return null;
        }
        let hasTerrainArt = false;
        try {
          hasTerrainArt = (
            await stat(join(installationRoot, ...gameArtTerrainTextureFolder))
          ).isDirectory();
        } catch {
          hasTerrainArt = false;
        }
        return {
          installationRoot,
          productVersion: await linkedProductVersionFor('local'),
          hasTerrainArt,
        };
      },
      prepare: (requestId, source, onProgress) =>
        nativeSupervisor.prepareGameArt(requestId, source, onProgress),
      sprites: (requestId, source, objects, onProgress) =>
        nativeSupervisor.gameArtSprites(requestId, source, objects, onProgress),
      cancel: (requestId) => nativeSupervisor.cancelGameArt(requestId),
      transient: isInstallationReadersBusy,
      readFile: async (path, maximumBytes) => {
        try {
          return new Uint8Array(await readFileBounded(path, maximumBytes));
        } catch {
          return null;
        }
      },
      publish: publishWorkspaceDiagnostic,
      emit: (status) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(ipcChannels.gameArtEvent, status);
        }
      },
    },
    app.getPath('userData'),
  );
  firstGameFolderLinkHandler = !editionCapabilities.gameTextures
    ? undefined
    : () => {
        gameArtService.relinked();
        void (async () => {
          const selection = await installationSelectionStore.read();
          if (!selection) return;
          const first = await sessionStore.recordGameTexturesInstallation(
            gameTexturesInstallationIdentity(selection.installationRoot),
          );
          if (!first) return;
          await gameArtService.prepare(() => {
            void sessionStore
              .updatePreviewView('diamond', 'game-textures')
              .then(() => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                  mainWindow.webContents.send(ipcChannels.gameTexturesFirstLink);
                }
              })
              .catch(() => undefined);
          });
        })().catch(() => undefined);
      };
  ipcMain.handle(ipcChannels.gameArtStatus, (event) => {
    assertTrustedSender(event.senderFrame?.url);
    return gameArtService.status();
  });
  ipcMain.handle(ipcChannels.gameArtPrepare, (event) => {
    assertTrustedSender(event.senderFrame?.url);
    return gameArtService.prepare();
  });
  ipcMain.handle(ipcChannels.gameArtCancel, (event) => {
    assertTrustedSender(event.senderFrame?.url);
    return gameArtService.cancel();
  });
  ipcMain.handle(ipcChannels.gameArtTerrain, (event) => {
    assertTrustedSender(event.senderFrame?.url);
    return gameArtService.terrainIndex();
  });
  ipcMain.handle(ipcChannels.gameArtSprites, (event, objects: unknown) => {
    assertTrustedSender(event.senderFrame?.url);
    return gameArtService.sprites(validateGameArtSpriteRequest(objects));
  });
  ipcMain.handle(ipcChannels.gameArtImages, (event, keys: unknown) => {
    assertTrustedSender(event.senderFrame?.url);
    return gameArtService.images(validateGameArtImageKeys(keys));
  });
  const currentLocalPresentationNames = async (language: string) => {
    const selection = await installationSelectionStore.read();
    if (!selection) return null;
    let roots: Awaited<ReturnType<typeof authorizedGameRoots>>;
    let installationRoot: string;
    try {
      installationRoot = await realpath(resolve(selection.installationRoot));
      roots = await authorizedGameRoots(installationRoot);
    } catch {
      return null;
    }
    if (!roots.gamedata) return null;
    const productVersion = (await linkedProductVersionFor('local')) || null;
    let productVersionVerified = false;
    let standardIncludes: string[] = [];
    try {
      const catalog = await nativeSupervisor.getConfigurationCatalog();
      productVersionVerified =
        productVersion !== null &&
        catalog.behaviorProfiles.some((profile) =>
          profile.productVersions.includes(productVersion),
        );
      standardIncludes = catalog.contentPacks
        .filter((pack) => pack.packagedBundle)
        .flatMap((pack) => pack.standardIncludes);
    } catch {}
    return localPresentationNames.names(
      {
        installationRoot,
        gamedataRoot: roots.gamedata,
        productVersion,
        productVersionVerified,
        standardIncludes,
      },
      language,
    );
  };
  ipcMain.handle(ipcChannels.localPresentationNames, (event) => {
    assertTrustedSender(event.senderFrame?.url);
    return currentLocalPresentationNames(presentationLanguageFor('preview'));
  });
  const definitionFileService = new DefinitionFileService({
    selectedContent: async () => {
      const content = await selectedLanguageContent();
      if (!content) return null;
      const localSource = localContentService.sourceFor(content.contentPack);
      return {
        profile: content.profile,
        contentPack: content.contentPack,
        productVersion: localSource?.productVersion ?? content.contentPack.productVersion,
        local: localSource !== undefined,
      };
    },
    localNames: () => currentLocalPresentationNames(presentationLanguageFor('definition-file')),
    reservedFileNames: () => workspaceService.standardResources.reservedFileNames(),
    target: (folderId) => workspaceService.generatedFileTarget(folderId),
    projectDefinitions: (relevant) => workspaceService.projectDefinitions(relevant),
    writeInFolder: (folderId, name, text, overwrite) =>
      workspaceService.writeGeneratedFile(folderId, name, text, overwrite),
    chooseSavePath: async (suggestedName) => {
      if (!mainWindow || mainWindow.isDestroyed()) return null;
      const rememberedFolder = await selectionDirectory('definitionSave');
      const result = await showSaveDialog(mainWindow, {
        defaultPath: rememberedFolder ? join(rememberedFolder, suggestedName) : suggestedName,
        filters: [{ name: t('definition-file.save-dialog.filter'), extensions: ['inc'] }],
        title: t('definition-file.save-dialog.title'),
      });
      if (result.canceled || !result.filePath) return null;
      await sessionStore.updateDialogLocation('definitionSave', dirname(result.filePath));
      return result.filePath;
    },
    writeAs: async (path, text) => {
      return workspaceService.writeGeneratedFileAs(path, text);
    },
  });
  ipcMain.handle(ipcChannels.definitionFilePrepare, (event, request: unknown) => {
    assertTrustedSender(event.senderFrame?.url);
    assertMainWindowSender(event.sender);
    return definitionFileService.prepare(validateDefinitionFilePrepareRequest(request));
  });
  ipcMain.handle(ipcChannels.definitionFileGenerate, (event, request: unknown) => {
    assertTrustedSender(event.senderFrame?.url);
    assertMainWindowSender(event.sender);
    return definitionFileService.generate(validateDefinitionFileGenerateRequest(request));
  });
  ipcMain.handle(ipcChannels.installedSourcesDiscover, async (event) => {
    assertTrustedSender(event.senderFrame?.url);
    return discoverInstalledSources(true);
  });
  ipcMain.handle(ipcChannels.installedSourcesOpen, async (event, sourceId: string) => {
    assertTrustedSender(event.senderFrame?.url);
    await discoverInstalledSources();
    return installedSourceService.open(sourceId);
  });
  ipcMain.handle(ipcChannels.installedSourcesClone, async (event, sourceId: string) => {
    assertTrustedSender(event.senderFrame?.url);
    await discoverInstalledSources();
    const browserWindow = assertMainWindowSender(event.sender);
    const defaultPath = await selectionDirectory('installedSourceClone');
    const result = await showOpenDialog(browserWindow, {
      ...(defaultPath ? { defaultPath } : {}),
      title: t('native-dialog.installed-map-clone.title'),
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
    });
    const destination = result.filePaths[0];
    if (result.canceled || !destination) return null;
    await sessionStore.updateDialogLocation('installedSourceClone', destination);
    return installedSourceService.clone(sourceId, destination);
  });
  ipcMain.handle(
    ipcChannels.installedSourcesSelectProfile,
    async (event, installationId: string, profileId: string) => {
      assertTrustedSender(event.senderFrame?.url);
      await discoverInstalledSources();
      await installationSelectionStore.write(
        installedSourceService.selection(installationId, profileId),
      );
      sourceCatalogService.invalidate();
      await discoverInstalledSources(true);
      await refreshLanguageCatalogAndReportFailure(refreshOpenLanguageCatalog());
    },
  );
  ipcMain.handle(
    ipcChannels.managedDeploymentPreview,
    async (event, request: ManagedDeploymentRequest) => {
      assertTrustedSender(event.senderFrame?.url);
      return managedDeploymentService.preview(request, await managedDeploymentTarget());
    },
  );
  ipcMain.handle(
    ipcChannels.managedDeploymentApply,
    async (event, request: ManagedDeploymentApplyRequest) => {
      assertTrustedSender(event.senderFrame?.url);
      return managedDeploymentService.apply(request);
    },
  );
  ipcMain.handle(ipcChannels.manualDeploymentContext, async (event, documentUri: string) => {
    assertTrustedSender(event.senderFrame?.url);
    return manualDeploymentContext(documentUri);
  });
  ipcMain.handle(
    ipcChannels.manualDeploymentPreview,
    async (event, request: ManualDeploymentPreviewRequest) => {
      assertTrustedSender(event.senderFrame?.url);
      if (!request || typeof request !== 'object') {
        throw new Error('persistent deployment preview request is invalid');
      }
      const mapIcon = validateManualDeploymentMapIconRequest(request.mapIcon);
      return managedDeploymentService.previewManual(
        request.deployment,
        await manualTarget(request.profileId, request.modName),
        mapIcon,
      );
    },
  );
  ipcMain.handle(
    ipcChannels.manualDeploymentApply,
    async (event, request: ManualDeploymentApplyRequest) => {
      assertTrustedSender(event.senderFrame?.url);
      const result = await managedDeploymentService.applyManual(
        request.token,
        request.confirmReplaceExisting,
        request.enableMod === true,
      );
      lastDeployedModFolder = result.targetPath ?? null;
      const report = await linkedInstallationReport();
      if (!report) {
        throw new DesktopError(
          'deploy.target-changed',
          'linked installation changed while deployment was applying',
        );
      }
      await installationSelectionStore.write({
        installationRoot: report.evidence.installationRoot.value,
        userProfileId: result.profileId,
      });
      if (result.modStatus?.enable === 'enabled' || result.modStatus?.enable === 'added') {
        result.modStatus.gameRunning =
          (await linkedGameProcessState(
            report.evidence.installationRoot.value,
            undefined,
            report.evidence.executable ? [report.evidence.executable.value] : undefined,
          )) === 'running';
      }
      return result;
    },
  );
  ipcMain.handle(ipcChannels.manualDeploymentOpenFolder, async (event) => {
    assertTrustedSender(event.senderFrame?.url);
    assertMainWindowSender(event.sender);
    const folder = lastDeployedModFolder;
    if (folder === null) throw new Error('no deployed mod folder is known');
    const metadata = await lstat(folder);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new DesktopError(
        'deploy.unsafe-target',
        'the deployed mod folder is no longer a plain folder',
      );
    }
    shell.showItemInFolder(folder);
  });
  ipcMain.handle(
    ipcChannels.manualDeploymentOpenTargetFolder,
    async (event, profileId: unknown) => {
      assertTrustedSender(event.senderFrame?.url);
      assertMainWindowSender(event.sender);
      if (!isDeploymentProfileId(profileId)) throw new Error('deployment profile is invalid');
      const report = await linkedInstallationReport();
      if (!report)
        throw new DesktopError(
          'deploy.no-installation',
          'select a valid AoE2DE installation before opening its mods folder',
        );
      const profile = report.evidence.userProfiles.find(
        (candidate) => candidate.value === profileId,
      );
      if (!profile) {
        throw new DesktopError(
          'deploy.profile',
          'select one of the linked installation numeric profiles',
        );
      }
      const folder = await deploymentTargetFolderToOpen(profile.source);
      const failure = await shell.openPath(folder);
      if (failure) {
        throw new DesktopError(
          'shell.open-failed',
          `Windows Explorer could not open the folder: ${failure}`,
          { reason: failure },
        );
      }
    },
  );
  ipcMain.handle(ipcChannels.manualDeploymentMapIconRead, async (event, token: unknown) => {
    assertTrustedSender(event.senderFrame?.url);
    return managedDeploymentService.manualMapIcon(token);
  });
  ipcMain.handle(ipcChannels.manualDeploymentMapIconSave, async (event, token: unknown) => {
    assertTrustedSender(event.senderFrame?.url);
    const browserWindow = assertMainWindowSender(event.sender);
    return saveManualMapIcon(token, {
      icon: (validToken) => managedDeploymentService.manualMapIcon(validToken),
      rememberedDirectory: async () => (await sessionStore.read()).dialogLocations.mapIconSave,
      validDirectory: (path) => workspaceService.validDialogPath('folder', path),
      fallbackDirectories: () =>
        (['pictures', 'documents'] as const).map((name) => {
          try {
            return app.getPath(name);
          } catch {
            return null;
          }
        }),
      showSaveDialog: (options) => showSaveDialog(browserWindow, options),
      writeFile: (path, bytes, exclusive) =>
        writeFile(path, bytes, exclusive ? { flag: 'wx' } : undefined),
      rememberDirectory: (path) => sessionStore.updateDialogLocation('mapIconSave', path),
    });
  });
  ipcMain.handle(ipcChannels.mapIconGeneratedSave, async (event, request: unknown) => {
    assertTrustedSender(event.senderFrame?.url);
    const browserWindow = assertMainWindowSender(event.sender);
    return saveGeneratedMapIcon(request, {
      generatedIcon: (value) => managedDeploymentService.generatedMapIconImage(value),
      rememberedDirectory: async () => (await sessionStore.read()).dialogLocations.mapIconSave,
      validDirectory: (path) => workspaceService.validDialogPath('folder', path),
      fallbackDirectories: () =>
        (['pictures', 'documents'] as const).map((name) => {
          try {
            return app.getPath(name);
          } catch {
            return null;
          }
        }),
      showSaveDialog: (options) => showSaveDialog(browserWindow, options),
      writeFile: (path, bytes, exclusive) =>
        writeFile(path, bytes, exclusive ? { flag: 'wx' } : undefined),
      rememberDirectory: (path) => sessionStore.updateDialogLocation('mapIconSave', path),
    });
  });
  ipcMain.handle(ipcChannels.clipboardWriteImage, async (event, request: unknown) => {
    assertTrustedSender(event.senderFrame?.url);
    assertMainWindowSender(event.sender);
    await copyImageToClipboard(request, {
      mapIcon: (token) => managedDeploymentService.manualMapIcon(token),
      writeImage: async (png) => {
        const bytes = Buffer.from(png);
        if (nativeImage.createFromBuffer(bytes).isEmpty()) return false;
        await clipboard.write([
          new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) }),
        ]);
        return true;
      },
    });
  });
  ipcMain.handle(ipcChannels.previewImageSave, async (event, request: unknown) => {
    assertTrustedSender(event.senderFrame?.url);
    const browserWindow = assertMainWindowSender(event.sender);
    return savePreviewImage(request, {
      rememberedDirectory: async () => (await sessionStore.read()).dialogLocations.previewImageSave,
      validDirectory: (path) => workspaceService.validDialogPath('folder', path),
      fallbackDirectories: () =>
        (['pictures', 'documents'] as const).map((name) => {
          try {
            return app.getPath(name);
          } catch {
            return null;
          }
        }),
      showSaveDialog: (options) => showSaveDialog(browserWindow, options),
      writeFile: (path, bytes, exclusive) =>
        writeFile(path, bytes, exclusive ? { flag: 'wx' } : undefined),
      rememberDirectory: (path) => sessionStore.updateDialogLocation('previewImageSave', path),
    });
  });
  ipcMain.handle(ipcChannels.mapIconRenderInputGet, async (event) => {
    assertTrustedSender(event.senderFrame?.url);
    const session = await sessionStore.read();
    return {
      perspective: session.mapIconPerspective,
      look: session.mapIconLook,
      relief: session.mapIconReliefMode,
      terrainSmoothing: session.mapIconTerrainSmoothing,
      spawnMarkers: session.mapIconSpawnMarkerStyle,
      spawnMarkerSizePercent: session.mapIconSpawnMarkerSizePercent,
      trees: session.mapIconTrees,
      treeDensity: session.mapIconTreeDensityLevel,
      treeSize: session.mapIconTreeSize,
      treeSpawnOverlap: session.mapIconTreeSpawnOverlap,
      resources: session.mapIconResources,
      resourceDensity: session.mapIconResourceDensityLevel,
      resourceSize: session.mapIconResourceSize,
      resourceSpawnOverlap: session.mapIconResourceSpawnOverlap,
      minimapObjects: session.mapIconMinimapObjects,
    };
  });
  ipcMain.handle(ipcChannels.mapIconRenderInputSet, async (event, input: unknown) => {
    assertTrustedSender(event.senderFrame?.url);
    assertMainWindowSender(event.sender);
    await sessionStore.updateMapIconRenderInput(validateMapIconRenderInput(input));
  });
  ipcMain.handle(ipcChannels.controlLauncherStatus, (event) => {
    assertTrustedSender(event.senderFrame?.url);
    assertMainWindowSender(event.sender);
    return controlLauncherPreference.status();
  });
  ipcMain.handle(ipcChannels.controlLauncherSelect, async (event) => {
    assertTrustedSender(event.senderFrame?.url);
    const browserWindow = assertMainWindowSender(event.sender);
    const defaultPath = await selectionDirectory('controlLauncher', [
      (await controlLauncherPreference.selectionDirectory()) ?? null,
    ]);
    const result = await showOpenDialog(browserWindow, {
      title: t('native-dialog.control-launcher.title'),
      filters: [{ name: t('native-dialog.control-launcher.filter'), extensions: ['exe'] }],
      properties: ['openFile', 'dontAddToRecent'],
      ...(defaultPath ? { defaultPath } : {}),
    });
    const candidate = result.filePaths[0];
    if (result.canceled || !candidate) return null;
    await sessionStore.updateDialogLocation('controlLauncher', dirname(candidate));
    await validateControlLauncherExecutable(candidate);
    await controlSessionBridge.disconnect();
    return controlLauncherPreference.select(candidate);
  });
  ipcMain.handle(ipcChannels.controlLauncherForget, async (event) => {
    assertTrustedSender(event.senderFrame?.url);
    assertMainWindowSender(event.sender);
    if (!(await sessionStore.read()).dialogLocations.controlLauncher) {
      const previousDirectory = await controlLauncherPreference.selectionDirectory();
      if (previousDirectory) {
        await sessionStore.updateDialogLocation('controlLauncher', previousDirectory);
      }
    }
    let disconnectError: unknown;
    try {
      await controlSessionBridge.disconnect();
    } catch (error) {
      disconnectError = error;
    }
    await controlLauncherPreference.forget();
    if (disconnectError) throw disconnectError;
    return controlLauncherPreference.status();
  });
  ipcMain.handle(ipcChannels.controlSessionStatus, (event) => {
    assertTrustedSender(event.senderFrame?.url);
    assertMainWindowSender(event.sender);
    return controlSessionBridge.snapshot();
  });
  ipcMain.handle(ipcChannels.controlSessionConnect, (event, purpose: ControlConnectPurpose) => {
    assertTrustedSender(event.senderFrame?.url);
    assertMainWindowSender(event.sender);
    if (purpose !== 'live-run' && purpose !== 'adopt-seed') {
      throw new Error('AoE2Control connection purpose is invalid');
    }
    return controlSessionBridge.connect(purpose);
  });
  ipcMain.handle(ipcChannels.controlSessionDisconnect, (event) => {
    assertTrustedSender(event.senderFrame?.url);
    assertMainWindowSender(event.sender);
    return controlSessionBridge.disconnect();
  });
  ipcMain.handle(
    ipcChannels.controlLiveSynchronize,
    async (event, request: ControlLiveSynchronizationRequest) => {
      assertTrustedSender(event.senderFrame?.url);
      assertMainWindowSender(event.sender);
      const { appRun } = request;
      delete request.appRun;
      let appTicket: AppRunTicket | undefined;
      if (appRun !== undefined) {
        if (!isAppRunReference(appRun)) throw new Error('live-test app run is invalid');
        const claimed = appRunTickets.claim(appRun.token, ['live-test']);
        if (claimed === undefined) throw new Error('live-test app run is unknown');
        if (claimed === 'cancelled') throw new Error('the AI app stopped the live test');
        appTicket = claimed;
        appTicket.executionId = request.requestId;
      }
      const liveDocument = nativeSupervisor.languageDocument(request.preview.documentUri);
      assertAuthorizedControlLivePreview(
        request,
        latestAuthorizedControlLivePreview,
        liveDocument
          ? {
              hash: controlLiveDocumentSourceHash(liveDocument.text),
              length: liveDocument.text.replace(/\r\n?/gu, '\n').length,
            }
          : undefined,
      );
      if (controlLiveAbortControllers.has(request.requestId)) {
        throw new Error('duplicate live-test request');
      }
      if (controlLiveAbortControllers.size >= 16) {
        throw new Error('live-test request queue is full');
      }
      const controller = new AbortController();
      controlLiveAbortControllers.set(request.requestId, controller);
      try {
        return await withExecutionLease(
          request.requestId,
          'control-live',
          appTicket
            ? appExecutionLabel(appTicket.app, 'AoE2Control live run')
            : 'AoE2Control live run',
          async () => controller.abort(),
          async () => {
            controller.abort();
            await controlSessionBridge.disconnect().catch(() => undefined);
          },
          async () => {
            await managedDeploymentTarget();
            return controlLiveWorkflow.synchronize(request, controller.signal);
          },
          appTicket ? { origin: { kind: 'app', app: appTicket.app } } : {},
        );
      } finally {
        controlLiveAbortControllers.delete(request.requestId);
      }
    },
  );
  ipcMain.handle(ipcChannels.controlLiveCancel, (event, requestId: string) => {
    assertTrustedSender(event.senderFrame?.url);
    assertMainWindowSender(event.sender);
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,96}$/u.test(requestId)) {
      throw new Error('live-test request identifier is invalid');
    }
    const controller = controlLiveAbortControllers.get(requestId);
    controller?.abort();
    return Boolean(controller);
  });
  ipcMain.handle(ipcChannels.applicationMenuModel, (event) => {
    assertTrustedSender(event.senderFrame?.url);
    assertMainWindowSender(event.sender);
    return applicationMenuModel(applicationMenu);
  });
  ipcMain.handle(ipcChannels.activateApplicationMenuItem, (event, key: unknown) => {
    assertTrustedSender(event.senderFrame?.url);
    const browserWindow = assertMainWindowSender(event.sender);
    if (!isApplicationMenuKey(key)) throw new Error('application menu item key is invalid');
    activateApplicationMenuItem(browserWindow, key);
  });
  ipcMain.handle(ipcChannels.openExternalLink, (event, target: ExternalLinkTarget) => {
    assertTrustedSender(event.senderFrame?.url);
    assertMainWindowSender(event.sender);
    if (!isExternalLinkTarget(target)) throw new Error('external link target is invalid');
    if (!externalLinkAllowed(target, editionCapabilities)) {
      throw new Error('this feature is not part of this edition');
    }
    return openExternalLink(target);
  });
  ipcMain.handle(ipcChannels.releaseNoticeTake, (event) => {
    assertTrustedSender(event.senderFrame?.url);
    assertMainWindowSender(event.sender);
    if (pendingHandOffNote) {
      publishWorkspaceDiagnostic(pendingHandOffNote);
      pendingHandOffNote = null;
    }
    return startupReleaseCheck.take();
  });
  ipcMain.handle(ipcChannels.updateState, (event) => {
    assertTrustedSender(event.senderFrame?.url);
    assertMainWindowSender(event.sender);
    return updateService?.state() ?? noUpdate;
  });
  ipcMain.handle(ipcChannels.updateStart, (event, version: unknown) => {
    assertTrustedSender(event.senderFrame?.url);
    assertMainWindowSender(event.sender);
    if (typeof version !== 'string') throw new Error('update version is invalid');
    return updateService?.start(version) ?? false;
  });
  ipcMain.handle(ipcChannels.updateCancel, (event) => {
    assertTrustedSender(event.senderFrame?.url);
    assertMainWindowSender(event.sender);
    updateService?.cancel();
  });
  ipcMain.handle(ipcChannels.updateReleaseNotes, async (event) => {
    assertTrustedSender(event.senderFrame?.url);
    assertMainWindowSender(event.sender);
    const state = updateService?.state() ?? noUpdate;
    if (state.phase === 'none') throw new Error('no update is offered');
    await shell.openExternal(updateReleaseNotesUrl(releaseRepository, state.version));
  });
  ipcMain.handle(ipcChannels.editorPaste, (event) => {
    assertTrustedSender(event.senderFrame?.url);
    assertMainWindowSender(event.sender);
    event.sender.paste();
  });
  ipcMain.handle(ipcChannels.openDocumentLink, (event, value: string) => {
    assertTrustedSender(event.senderFrame?.url);
    assertMainWindowSender(event.sender);
    if (typeof value !== 'string' || value.length < 1 || value.length > 2048) {
      throw new Error('document link is invalid');
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error('document link is invalid');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('document link protocol is not authorized');
    }
    return shell.openExternal(url.href);
  });
  ipcMain.handle(ipcChannels.syncMapTestResultsVisibility, (event, visible: boolean) => {
    assertTrustedSender(event.senderFrame?.url);
    if (typeof visible !== 'boolean') throw new Error('invalid map-test results visibility');
    if (visible === mapTestResultsVisible) return;
    mapTestResultsVisible = visible;
    refreshApplicationMenu();
  });
  ipcMain.handle(ipcChannels.syncMapTestPreviewShown, (event, shown: boolean) => {
    assertTrustedSender(event.senderFrame?.url);
    assertMainWindowSender(event.sender);
    if (typeof shown !== 'boolean') throw new Error('invalid map-test preview state');
    if (shown === mapTestPreviewShown) return;
    mapTestPreviewShown = shown;
    refreshApplicationMenu();
  });
  ipcMain.handle(ipcChannels.syncInsertSnippetAvailable, (event, available: boolean) => {
    assertTrustedSender(event.senderFrame?.url);
    assertMainWindowSender(event.sender);
    if (typeof available !== 'boolean') throw new Error('invalid insert snippet state');
    insertSnippetAvailable = available;
    const item = applicationMenu?.getMenuItemById('edit.insert-snippet');
    if (item) item.enabled = available;
    publishApplicationMenuModel();
  });
  ipcMain.handle(ipcChannels.syncSaveSnippetAvailable, (event, available: boolean) => {
    assertTrustedSender(event.senderFrame?.url);
    assertMainWindowSender(event.sender);
    if (typeof available !== 'boolean') throw new Error('invalid save snippet state');
    saveSnippetAvailable = available;
    const item = applicationMenu?.getMenuItemById('edit.save-snippet');
    if (item) item.enabled = available;
    publishApplicationMenuModel();
  });
  ipcMain.handle(ipcChannels.tourProgress, async (event) => {
    assertTrustedSender(event.senderFrame?.url);
    assertMainWindowSender(event.sender);
    return requireAppTourStore().read();
  });
  ipcMain.handle(ipcChannels.tourProgressSave, async (event, progress: unknown) => {
    assertTrustedSender(event.senderFrame?.url);
    assertMainWindowSender(event.sender);
    await requireAppTourStore().write(validateTourProgress(progress));
  });
  ipcMain.handle(ipcChannels.ownSnippetsList, async (event) => {
    assertTrustedSender(event.senderFrame?.url);
    assertMainWindowSender(event.sender);
    return requireOwnSnippetStore().list();
  });
  ipcMain.handle(
    ipcChannels.ownSnippetSave,
    async (event, snippet: unknown, previousName: unknown) => {
      assertTrustedSender(event.senderFrame?.url);
      assertMainWindowSender(event.sender);
      return requireOwnSnippetStore().save(
        validateOwnSnippet(snippet),
        previousName === null ? null : boundedSnippetName(previousName),
      );
    },
  );
  ipcMain.handle(ipcChannels.ownSnippetDelete, async (event, name: unknown) => {
    assertTrustedSender(event.senderFrame?.url);
    assertMainWindowSender(event.sender);
    return requireOwnSnippetStore().delete(boundedSnippetName(name));
  });
  ipcMain.handle(ipcChannels.ownSnippetsExport, async (event) => {
    assertTrustedSender(event.senderFrame?.url);
    const browserWindow = assertMainWindowSender(event.sender);
    const snippets = await requireOwnSnippetStore().list();
    if (snippets.length === 0) return null;
    const text = serializeSnippetFile(snippets);
    const directory = await selectionDirectory('snippetFile');
    const name = 'rms-snippets.json';
    const selection = await showSaveDialog(browserWindow, {
      defaultPath: directory ? join(directory, name) : name,
      filters: [{ name: t('native-dialog.snippets.filter'), extensions: ['json'] }],
      title: t('native-dialog.snippets.export.title'),
    });
    if (selection.canceled || !selection.filePath) return null;
    await sessionStore.updateDialogLocation('snippetFile', dirname(selection.filePath));
    await writeFile(selection.filePath, Buffer.from(text, 'utf8'));
    return { count: snippets.length };
  });
  ipcMain.handle(ipcChannels.ownSnippetsImport, async (event) => {
    assertTrustedSender(event.senderFrame?.url);
    const browserWindow = assertMainWindowSender(event.sender);
    const defaultPath = await selectionDirectory('snippetFile');
    const selection = await showOpenDialog(browserWindow, {
      ...(defaultPath ? { defaultPath } : {}),
      filters: [{ name: t('native-dialog.snippets.filter'), extensions: ['json'] }],
      properties: ['openFile', 'dontAddToRecent'],
      title: t('native-dialog.snippets.import.title'),
    });
    const path = selection.filePaths[0];
    if (selection.canceled || !path) return null;
    await sessionStore.updateDialogLocation('snippetFile', dirname(path));
    let bytes: Buffer;
    try {
      bytes = await readFileBounded(path, ownSnippetLimits.fileBytes);
    } catch (error) {
      return {
        status: 'refused',
        reason: error instanceof FileTooLargeError ? 'too-large' : 'unreadable',
      } as const;
    }
    try {
      const imported = parseSnippetFile(bytes);
      const { snippets, added, renamed } = await requireOwnSnippetStore().import(imported);
      return { status: 'imported', snippets, added, renamed } as const;
    } catch (error) {
      if (error instanceof SnippetFileError) {
        return { status: 'refused', reason: error.reason } as const;
      }
      throw error;
    }
  });
  ipcMain.handle(ipcChannels.syncModalSurfaceOpen, (event, open: boolean) => {
    assertTrustedSender(event.senderFrame?.url);
    assertMainWindowSender(event.sender);
    if (typeof open !== 'boolean') throw new Error('invalid modal surface state');
    modalSurfaceOpen = open;
  });
  ipcMain.handle(
    ipcChannels.syncNativeTheme,
    (event, preference: ThemePreference, nextResolvedTheme: ResolvedTheme) => {
      assertTrustedSender(event.senderFrame?.url);
      if (preference !== 'system' && preference !== 'light' && preference !== 'dark') {
        throw new Error('invalid theme preference');
      }
      if (nextResolvedTheme !== 'light' && nextResolvedTheme !== 'dark') {
        throw new Error('invalid resolved theme');
      }
      applyNativeTheme(nextResolvedTheme);
      return sessionStore.updateTheme(preference);
    },
  );
  ipcMain.handle(ipcChannels.localeState, (event) => {
    assertTrustedSender(event.senderFrame?.url);
    if (!localeService) throw new Error('interface language is unavailable');
    return localeService.state();
  });
  ipcMain.handle(ipcChannels.setLanguagePreference, async (event, preference: unknown) => {
    assertTrustedSender(event.senderFrame?.url);
    assertMainWindowSender(event.sender);
    if (!localeService) throw new Error('interface language is unavailable');
    const state = localeService.setPreference(preference);
    refreshApplicationMenu();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(ipcChannels.localeChanged, state);
    }
    await sessionStore.updateLanguagePreference(localeService.rememberedPreference());
    return state;
  });
  ipcMain.handle(ipcChannels.workspacePickFiles, async (event) => {
    assertTrustedSender(event.senderFrame?.url);
    const browserWindow = assertMainWindowSender(event.sender);
    const defaultPath = await selectionDirectory('file');
    const result = await showOpenDialog(browserWindow, {
      filters: [sourceFileDialogFilter()],
      ...(defaultPath ? { defaultPath } : {}),
      properties: ['openFile', 'multiSelections'],
      title: t('native-dialog.open-files.title'),
    });
    if (result.canceled) return null;
    const selectedPath = result.filePaths.at(-1);
    if (selectedPath) await sessionStore.updateDialogLocation('file', selectedPath);
    const opened = await workspaceService.openPaths(result.filePaths);
    await refreshRecentApplicationMenu();
    return opened;
  });
  ipcMain.handle(ipcChannels.workspacePickFolder, async (event) => {
    assertTrustedSender(event.senderFrame?.url);
    const browserWindow = assertMainWindowSender(event.sender);
    const defaultPath = await selectionDirectory('folder');
    const result = await showOpenDialog(browserWindow, {
      ...(defaultPath ? { defaultPath } : {}),
      properties: ['openDirectory'],
      title: t('native-dialog.open-folder.title'),
    });
    if (result.canceled) return null;
    const selectedPath = result.filePaths[0];
    if (selectedPath) await sessionStore.updateDialogLocation('folder', selectedPath);
    const opened = await workspaceService.openPaths(result.filePaths);
    await refreshRecentApplicationMenu();
    return opened;
  });
  ipcMain.handle(ipcChannels.workspaceOpenPaths, async (event, paths: string[]) => {
    assertTrustedSender(event.senderFrame?.url);
    const opened = await workspaceService.openDroppedPaths(paths);
    const lastPath = opened.documents.at(-1)?.path;
    if (lastPath) await sessionStore.updateDialogLocation('file', lastPath);
    if (opened.folder) await sessionStore.updateDialogLocation('folder', opened.folder.path);
    await refreshRecentApplicationMenu();
    return opened;
  });
  ipcMain.handle(ipcChannels.workspaceOpenFile, (event, path: string) => {
    assertTrustedSender(event.senderFrame?.url);
    return workspaceService.openGrantedPath(path);
  });
  ipcMain.handle(ipcChannels.workspaceOpenSource, async (event, sourceId: string) => {
    assertTrustedSender(event.senderFrame?.url);
    const constants = xsEnvironmentState;
    if (
      constants?.constantsPath &&
      constants.payload.constants &&
      sameSourceUri(sourceId, constants.payload.constants.uri)
    ) {
      return workspaceService.openCatalogSource(constants.constantsPath);
    }
    const navigationIdentity = () =>
      JSON.stringify([
        editorContextEpoch(),
        nativeSupervisor.languageIdentityEpoch(),
        sourceCatalogService.identityEpoch(),
      ]);
    const capturedNavigation = navigationIdentity();
    const currentNavigation = () => {
      if (capturedNavigation !== navigationIdentity())
        throw new DesktopError(
          'source-catalog.changed',
          'sources changed while navigation was being checked',
        );
    };
    if (languageDocumentSyncWorker) await languageDocumentSyncWorker;
    currentNavigation();
    let grant: Awaited<ReturnType<SourceCatalogService['authorizedTextSourceRead']>> | undefined;
    if (editorInventoryCoordinator) {
      const editorGrant = await editorInventoryCoordinator
        .navigationWitness(sourceId)
        .catch(() => undefined);
      currentNavigation();
      if (editorGrant)
        grant = {
          path: editorGrant.path,
          beforeRead: async (metadata) => {
            editorGrant.current();
            await editorGrant.witness.authorizeRead(editorGrant.path, metadata);
            editorGrant.current();
          },
          afterRead: () => editorGrant.witness.validate(),
          current: editorGrant.current,
        };
    }
    const authorized = grant ?? (await sourceCatalogService.authorizedTextSourceRead(sourceId));
    currentNavigation();
    return workspaceService.openCatalogSource(authorized.path, {
      beforeRead: async (metadata) => {
        currentNavigation();
        await authorized.beforeRead(metadata);
        currentNavigation();
      },
      afterRead: authorized.afterRead,
      current: () => {
        currentNavigation();
        authorized.current();
      },
    });
  });
  ipcMain.handle(ipcChannels.workspaceOpenRecent, async (event, path: string) => {
    assertTrustedSender(event.senderFrame?.url);
    const opened = await workspaceService.openRecent(path);
    await refreshRecentApplicationMenu();
    return opened;
  });
  ipcMain.handle(ipcChannels.workspaceSwitchFolders, (event) => {
    assertTrustedSender(event.senderFrame?.url);
    return workspaceService.switchFolders();
  });
  ipcMain.handle(ipcChannels.workspaceSwitchFolder, async (event, id: string) => {
    assertTrustedSender(event.senderFrame?.url);
    const outcome = await workspaceService.switchToFolder(id);
    await refreshRecentApplicationMenu();
    return outcome;
  });
  ipcMain.handle(ipcChannels.shellOpenTake, async (event): Promise<ShellOpenTakeResult | null> => {
    assertTrustedSender(event.senderFrame?.url);
    assertMainWindowSender(event.sender);
    const plan = await shellOpenQueue.take();
    if (!plan) return null;
    const outcome = await executeShellOpenPlan(plan, (paths) => workspaceService.openPaths(paths));
    const lastPath = outcome.opened?.documents.at(-1)?.path;
    if (lastPath) await sessionStore.updateDialogLocation('file', lastPath);
    if (outcome.opened?.folder) {
      await sessionStore.updateDialogLocation('folder', outcome.opened.folder.path);
    }
    if (outcome.opened) await refreshRecentApplicationMenu();
    for (const notice of shellOpenNotices(outcome, editionCapabilities.mapTests)) {
      publishWorkspaceDiagnostic(
        outputNote('Files', notice.code, notice.headline, {
          severity: 'warning',
          cause: notice.cause,
          ...(notice.detail ? { detail: notice.detail } : {}),
        }),
      );
    }
    return { opened: outcome.opened };
  });
  ipcMain.handle(ipcChannels.workspaceReadDirectory, (event, entryId: string) => {
    assertTrustedSender(event.senderFrame?.url);
    return workspaceService.readDirectory(entryId);
  });
  ipcMain.handle(ipcChannels.workspaceOpenFolderInExplorer, async (event, entryId: string) => {
    assertTrustedSender(event.senderFrame?.url);
    assertMainWindowSender(event.sender);
    const folderPath = await workspaceService.authorizedFolderPath(entryId);
    const error = await shell.openPath(folderPath);
    if (error) {
      throw new DesktopError(
        'shell.open-failed',
        `Windows Explorer could not open the folder: ${error}`,
        { reason: error },
      );
    }
  });
  ipcMain.handle(ipcChannels.workspaceSearch, (event, query: string) => {
    assertTrustedSender(event.senderFrame?.url);
    return workspaceService.searchWorkspace(query);
  });
  ipcMain.handle(ipcChannels.workspaceSearchContents, (event, request: unknown) => {
    assertTrustedSender(event.senderFrame?.url);
    return workspaceService.searchWorkspaceContents(request);
  });
  ipcMain.handle(ipcChannels.workspaceCancelSearch, (event) => {
    assertTrustedSender(event.senderFrame?.url);
    workspaceService.cancelSearch();
  });
  ipcMain.handle(ipcChannels.workspaceClose, (event) => {
    assertTrustedSender(event.senderFrame?.url);
    workspaceService.closeWorkspace();
  });
  ipcMain.handle(ipcChannels.workspaceCreate, (event, request: WorkspaceCreateRequest) => {
    assertTrustedSender(event.senderFrame?.url);
    return workspaceService.createEntry(request);
  });
  const remapPersistedPaths = async (changes: WorkspacePathChange[]) => {
    await sessionStore.remapPaths(changes);
    try {
      await recoveryStore.remapPaths(changes);
    } catch (error) {
      await sessionStore.remapPaths(
        changes.map((change) => ({
          oldId: change.newId,
          newId: change.oldId,
          oldPath: change.newPath,
          newPath: change.oldPath,
          newUri: pathToFileURL(change.oldPath).href,
        })),
      );
      throw error;
    }
  };
  ipcMain.handle(ipcChannels.workspaceRename, (event, request: WorkspaceRenameRequest) => {
    assertTrustedSender(event.senderFrame?.url);
    return workspaceService.renameEntry(request, remapPersistedPaths);
  });
  const explorerClipboard = new ExplorerClipboard(
    workspaceService,
    electronExplorerClipboardHost(clipboard, ClipboardItem),
  );
  ipcMain.handle(ipcChannels.workspaceClipboardWrite, (event, request: unknown) => {
    assertTrustedSender(event.senderFrame?.url);
    assertMainWindowSender(event.sender);
    return explorerClipboard.write(request as ExplorerClipboardWriteRequest);
  });
  ipcMain.handle(ipcChannels.workspaceClipboardState, (event) => {
    assertTrustedSender(event.senderFrame?.url);
    assertMainWindowSender(event.sender);
    return explorerClipboard.currentState();
  });
  ipcMain.handle(ipcChannels.workspacePaste, (event, request: unknown) => {
    assertTrustedSender(event.senderFrame?.url);
    assertMainWindowSender(event.sender);
    return explorerClipboard.paste(request as ExplorerPasteRequest, remapPersistedPaths);
  });
  ipcMain.handle(ipcChannels.workspaceDelete, (event, request: WorkspaceDeleteRequest) => {
    assertTrustedSender(event.senderFrame?.url);
    if ((request.permanent === true) !== deletePermanentlyPreference) {
      throw new DesktopError(
        'files.delete-setting-changed',
        'the Recycle Bin setting changed before the delete; delete the item again',
      );
    }
    return workspaceService.deleteEntry(
      request,
      (path) => shell.trashItem(path),
      async (path) => {
        await Promise.all([sessionStore.removePath(path), recoveryStore.removePath(path)]);
      },
    );
  });
  ipcMain.handle(ipcChannels.workspaceSave, (event, request: WorkspaceSaveRequest) => {
    assertTrustedSender(event.senderFrame?.url);
    return workspaceService.save(request);
  });
  ipcMain.handle(ipcChannels.workspaceSaveAs, async (event, request: WorkspaceSaveAsRequest) => {
    assertTrustedSender(event.senderFrame?.url);
    const browserWindow = assertMainWindowSender(event.sender);
    const rememberedFolder = await selectionDirectory('sourceSave');
    const extension = ['.rms', '.rms2', '.inc', '.def', '.rmstest', '.xs'].includes(
      extname(request.suggestedName).toLowerCase(),
    )
      ? extname(request.suggestedName)
      : '.rms';
    const suggestedName = workspaceService.standardResources.suggestUnreservedFileName(
      `${basename(request.suggestedName, extname(request.suggestedName))}${extension}`,
    );
    const result = await showSaveDialog(browserWindow, {
      defaultPath: rememberedFolder ? join(rememberedFolder, suggestedName) : suggestedName,
      filters: [sourceFileDialogFilter()],
      title: t('native-dialog.save-as.title'),
    });
    if (result.canceled || !result.filePath) return null;
    await sessionStore.updateDialogLocation('sourceSave', dirname(result.filePath));
    const saved = await workspaceService.saveAs(result.filePath, request);
    await refreshRecentApplicationMenu();
    return saved;
  });
  ipcMain.handle(ipcChannels.workspaceRecent, (event) => {
    assertTrustedSender(event.senderFrame?.url);
    return workspaceService.recentEntries();
  });
  ipcMain.handle(ipcChannels.recoveryRead, async (event) => {
    assertTrustedSender(event.senderFrame?.url);
    await discoverInstalledSources();
    let snapshot;
    try {
      snapshot = await recoveryStore.read();
    } catch (error) {
      publishWorkspaceDiagnostic(
        presentMessage({
          source: 'Recovery',
          raw: errorMessage(error),
          severity: 'warning',
          fallbackHeadline: 'notice.recovery.read-failed',
        }),
      );
      return null;
    }
    if (!snapshot) return null;
    const restored = await workspaceService.restoreRecovery(snapshot);
    for (const diagnostic of restored.diagnostics) {
      publishWorkspaceDiagnostic(
        outputNote('Recovery', 'recovery.restore-note', diagnostic, { severity: 'warning' }),
      );
    }
    return restored.snapshot;
  });
  ipcMain.handle(ipcChannels.recoveryWrite, (event, snapshot) => {
    assertTrustedSender(event.senderFrame?.url);
    return recoveryStore.write(
      workspaceService.authorizeRecoverySnapshot(validateRecoverySnapshot(snapshot)),
    );
  });
  ipcMain.handle(ipcChannels.recoveryClear, (event) => {
    assertTrustedSender(event.senderFrame?.url);
    return recoveryStore.clear();
  });
  ipcMain.handle(ipcChannels.windowCloseResponse, async (event, allow: boolean) => {
    assertTrustedSender(event.senderFrame?.url);
    assertMainWindowSender(event.sender);
    if (typeof allow !== 'boolean') throw new Error('window close response is invalid');
    windowCloseRequestPending = false;
    if (!allow) {
      updateService?.closeDeclined();
      return;
    }
    windowCloseApproved = true;
    await persistCurrentWindowState();
    mainWindow?.close();
  });
}

function sameSourceUri(left: string, right: string): boolean {
  if (left === right) return true;
  try {
    return (
      resolve(fileURLToPath(left)).toLocaleLowerCase('en-US') ===
      resolve(fileURLToPath(right)).toLocaleLowerCase('en-US')
    );
  } catch {
    return false;
  }
}

function languageContentSelectionFrom(params: unknown): LanguageContentSelection | null {
  const selection = (params as { contentSelection?: unknown } | null)?.contentSelection;
  if (selection === undefined) return null;
  const value = selection as Partial<LanguageContentSelection> | null;
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.profileId !== 'string' ||
    value.profileId.length < 1 ||
    value.profileId.length > 256 ||
    typeof value.packId !== 'string' ||
    value.packId.length < 1 ||
    value.packId.length > 128 ||
    typeof value.packVersion !== 'string' ||
    value.packVersion.length < 1 ||
    value.packVersion.length > 64 ||
    typeof value.contentHash !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(value.contentHash) ||
    (value.versionOrigin !== 'packaged' && value.versionOrigin !== 'local')
  ) {
    throw new Error('language content selection is invalid');
  }
  return {
    profileId: value.profileId,
    packId: value.packId,
    packVersion: value.packVersion,
    contentHash: value.contentHash,
    versionOrigin: value.versionOrigin,
  };
}

function productConfigurationCatalog(catalog: ConfigurationCatalog): ConfigurationCatalog {
  return {
    behaviorProfiles: catalog.behaviorProfiles.map((profile) => ({
      ...profile,
      capabilities: Object.fromEntries(
        Object.entries(profile.capabilities).filter(([name]) => name !== 'synthetic-generation'),
      ),
      minimapPalettes: profile.minimapPalettes.map((palette) => ({ ...palette })),
    })),
    contentPacks: catalog.contentPacks
      .filter((contentPack) => !contentPack.synthetic)
      .map((contentPack) => ({
        ...contentPack,
        objectNames: [...contentPack.objectNames],
        implicitDefinitions: { ...contentPack.implicitDefinitions },
        standardIncludes: [...contentPack.standardIncludes],
      })),
  };
}

function resolveNativePaths(): NativePaths {
  const executableSuffix = process.platform === 'win32' ? '.exe' : '';
  const developmentRoot = resolve(app.getAppPath(), '..', '..', 'target', 'debug');
  const packagedRoot = join(process.resourcesPath, 'native');
  const nativeRoot = app.isPackaged ? packagedRoot : developmentRoot;
  const overrides = developmentOverrides();
  const rmsdOverride = overrides.rmsdPath;
  const languageServerOverride = overrides.rmsLsPath;
  const mapTestOverride = overrides.rmsTestPath;
  return {
    ...(nativeProcessAllowed('rmsd', editionCapabilities)
      ? { rmsd: rmsdOverride ?? join(nativeRoot, `rmsd${executableSuffix}`) }
      : {}),
    'rms-ls': languageServerOverride ?? join(nativeRoot, `rms-ls${executableSuffix}`),
    ...(nativeProcessAllowed('rms-test', editionCapabilities)
      ? { 'rms-test': mapTestOverride ?? join(nativeRoot, `rms-test${executableSuffix}`) }
      : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function extractMapTestSourcePaths(script: string): Set<string> {
  const paths = new Set<string>();
  const uncommented = script
    .split(/\r\n?|\n/u)
    .filter((line) => !/^\s*#/u.test(line))
    .join('\n');
  const calls = uncommented.matchAll(/\brms\.source\s*\(([^)]*)\)/gu);
  for (const call of calls) {
    const argument = call[1]!.trim();
    if (argument.length === 0) continue;
    const literal = /^(?:"([^"\\]*)"|'([^'\\]*)')$/u.exec(argument);
    const path = literal?.[1] ?? literal?.[2];
    if (!path) {
      throw new DesktopError(
        'map-test.source-path',
        'rms.source(path) requires a literal authorized relative path in v1',
      );
    }
    paths.add(path.replaceAll('\\', '/'));
    assertMapTestRootCount(paths.size);
  }
  return paths;
}

function qualityCheckMapName(uri: string): string {
  try {
    return basename(fileURLToPath(uri));
  } catch {
    return qualityScriptName;
  }
}

function validateMapTestRunInput(input: MapTestRunInput): MapTestRunInput {
  const scriptBytes = Buffer.byteLength(input?.scriptSource ?? '', 'utf8');
  const quality = input?.quality;
  if (quality !== undefined) {
    try {
      validateAppQualityRun(quality, 'quality');
    } catch {
      throw new Error('map-test run input is invalid');
    }
  }
  const scriptShape =
    quality === undefined
      ? /\.rmstest$/iu.test(input?.scriptName ?? '') && scriptBytes >= 1
      : input?.scriptName === qualityScriptName &&
        scriptBytes === 0 &&
        typeof input.defaultSourceUri === 'string' &&
        input.defaultSourceUri.length >= 1;
  if (
    !input ||
    typeof input !== 'object' ||
    !/^[A-Za-z0-9._:-]{1,128}$/u.test(input.executionId) ||
    typeof input.scriptUri !== 'string' ||
    input.scriptUri.length < 1 ||
    input.scriptUri.length > 4096 ||
    !Number.isSafeInteger(input.scriptRevision) ||
    input.scriptRevision < 0 ||
    typeof input.scriptName !== 'string' ||
    input.scriptName.length < 1 ||
    input.scriptName.length > 512 ||
    !scriptShape ||
    scriptBytes > 1024 * 1024 ||
    (input.defaultSourceUri !== undefined &&
      (typeof input.defaultSourceUri !== 'string' || input.defaultSourceUri.length > 4096)) ||
    !Number.isInteger(input.width) ||
    input.width < 1 ||
    input.width > 512 ||
    !Number.isInteger(input.height) ||
    input.height < 1 ||
    input.height > 512 ||
    !isMapTestWorkerSetting(input.workers) ||
    !Array.isArray(input.players) ||
    input.players.length < 1 ||
    input.players.length > 8 ||
    !input.profile ||
    !input.contentPack ||
    (input.versionOrigin !== 'packaged' && input.versionOrigin !== 'local') ||
    (input.progressivePreview !== undefined && typeof input.progressivePreview !== 'boolean') ||
    (input.appRun !== undefined && !isAppRunReference(input.appRun))
  ) {
    throw new Error('map-test run input is invalid');
  }
  return structuredClone(input);
}

function installRendererPermissionPolicy(): void {
  const allowed = new Set(['clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) =>
    callback(allowed.has(permission) && isRendererDocumentUrl(details.requestingUrl)),
  );
  session.defaultSession.setPermissionCheckHandler(
    (_contents, permission, requestingOrigin) =>
      allowed.has(permission) && isRendererOrigin(requestingOrigin),
  );
}

function assertTrustedSender(url: string | undefined): void {
  if (!isRendererDocumentUrl(url)) throw new Error('untrusted IPC sender');
}

function assertMainWindowSender(sender: Electron.WebContents): BrowserWindow {
  const browserWindow = BrowserWindow.fromWebContents(sender);
  if (!browserWindow || browserWindow !== mainWindow)
    throw new Error('untrusted application window');
  return browserWindow;
}

function publishNativeStatus(status: NativeProcessStatus): void {
  if (status.name === 'rms-ls' && status.state === 'running') scheduleEditorInventoryRefresh();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(ipcChannels.nativeEvent, status);
  }
}

function publishExecutionState(state: ReturnType<ExecutionLease['state']>): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(ipcChannels.executionState, state);
  }
}

function publishLanguageServerNotification(method: string, params: unknown): void {
  sendLanguageServerEvent(
    method,
    method === 'textDocument/publishDiagnostics' && externalLanguageServers
      ? externalLanguageServers.acceptBuiltInDiagnostics(params)
      : params,
  );
}

function sendLanguageServerEvent(method: string, params: unknown): void {
  const shown = editionLanguageNotificationParams(method, params, editionCapabilities);
  if (method === 'textDocument/publishDiagnostics') connectorDiagnostics?.accept(shown);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(ipcChannels.languageServerEvent, { method, params: shown });
  }
}

function publishControlSessionEvent(event: ControlSessionEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(ipcChannels.controlSessionEvent, event);
  }
}

function publishControlLiveEvent(event: ControlLiveWorkflowEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(ipcChannels.controlLiveEvent, event);
  }
}

function validateGenerationInput(input: PreviewGenerationInput): PreviewGenerationInput {
  if (
    !input ||
    typeof input !== 'object' ||
    (input.clientRequestId !== undefined &&
      (typeof input.clientRequestId !== 'string' || input.clientRequestId.length > 512)) ||
    typeof input.documentUri !== 'string' ||
    input.documentUri.length < 1 ||
    input.documentUri.length > 4096 ||
    !Number.isSafeInteger(input.documentRevision) ||
    input.documentRevision < 0 ||
    typeof input.source !== 'string' ||
    Buffer.byteLength(input.source, 'utf8') < 1 ||
    Buffer.byteLength(input.source, 'utf8') > 16 * 1024 * 1024 ||
    !Number.isInteger(input.width) ||
    input.width < 1 ||
    input.width > 512 ||
    !Number.isInteger(input.height) ||
    input.height < 1 ||
    input.height > 512 ||
    !Number.isSafeInteger(input.seed) ||
    input.seed < 0 ||
    input.seed > 0xffff_ffff ||
    !Array.isArray(input.players) ||
    input.players.length < 1 ||
    input.players.length > 8 ||
    (input.backend !== 'synthetic' && input.backend !== 'exact') ||
    (input.versionOrigin !== 'packaged' && input.versionOrigin !== 'local') ||
    !/^[0-9a-f]{64}$/.test(input.profile?.profileHash ?? '') ||
    !/^[0-9a-f]{64}$/.test(input.contentPack?.contentHash ?? '') ||
    !/^[0-9a-f]{64}$/.test(input.contentPack?.sourceFingerprint ?? '') ||
    !validSelectedMinimapPalette(input.minimapPalette) ||
    !isSelectedTexturePaletteOrAbsent(input.texturePalette) ||
    (input.progressivePreview !== undefined && typeof input.progressivePreview !== 'boolean') ||
    (input.xsStartCheck !== undefined && typeof input.xsStartCheck !== 'boolean') ||
    (input.appRun !== undefined && !isAppRunReference(input.appRun)) ||
    (input.automatic !== undefined && typeof input.automatic !== 'boolean') ||
    (input.appRun !== undefined && input.automatic === true)
  ) {
    throw new Error('generation input is invalid or exceeds its bounds');
  }
  admitPreviewTraceLevel(input.traceLevel, latencyProbe.fullTraceAllowed());
  const playerSlots = new Set<number>();
  for (const player of input.players) {
    if (
      !Number.isInteger(player.slot) ||
      player.slot < 1 ||
      player.slot > 8 ||
      playerSlots.has(player.slot) ||
      !Number.isInteger(player.team) ||
      player.team < 0 ||
      player.team > 8 ||
      !Number.isInteger(player.civilizationId) ||
      player.civilizationId < 0 ||
      player.civilizationId > 0xffff_ffff
    ) {
      throw new Error('generation player configuration is invalid');
    }
    playerSlots.add(player.slot);
  }
  return structuredClone(input);
}

function validSelectedMinimapPalette(value: SelectedMinimapPalette | null): boolean {
  if (value === null) return true;
  const validColor = (color: number) => Number.isInteger(color) && color >= 0 && color <= 0xffffff;
  return (
    typeof value === 'object' &&
    (value.selection === 'exact-version' || value.selection === 'latest-fallback') &&
    typeof value.paletteId === 'string' &&
    value.paletteId.length > 0 &&
    value.paletteId.length <= 96 &&
    typeof value.productVersion === 'string' &&
    value.productVersion.length > 0 &&
    value.productVersion.length <= 64 &&
    typeof value.paletteHash === 'string' &&
    /^[0-9a-f]{64}$/.test(value.paletteHash) &&
    Array.isArray(value.terrainColors) &&
    value.terrainColors.length > 0 &&
    value.terrainColors.length <= 4096 &&
    value.terrainColors.every(
      (color, index) =>
        (index === 0 || value.terrainColors[index - 1]!.terrainId < color.terrainId) &&
        validColor(color.highColor) &&
        validColor(color.mediumColor) &&
        validColor(color.lowColor),
    ) &&
    Array.isArray(value.neutralObjectColors) &&
    value.neutralObjectColors.length > 0 &&
    value.neutralObjectColors.length <= 100_000 &&
    value.neutralObjectColors.every(
      (color, index) =>
        (index === 0 || value.neutralObjectColors[index - 1]!.objectId < color.objectId) &&
        validColor(color.color),
    ) &&
    Array.isArray(value.cliffColors) &&
    value.cliffColors.length > 0 &&
    value.cliffColors.length <= 4096 &&
    value.cliffColors.every(
      (color, index) =>
        (index === 0 || value.cliffColors[index - 1]!.cliffType < color.cliffType) &&
        validColor(color.leftColor) &&
        validColor(color.rightColor),
    )
  );
}

function requireAppTourStore(): AppTourStore {
  if (!appTourStore) throw new Error('the tour store is unavailable');
  return appTourStore;
}

function requireOwnSnippetStore(): OwnSnippetStore {
  if (!ownSnippetStore) throw new Error('the snippet store is unavailable');
  return ownSnippetStore;
}

function boundedSnippetName(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > ownSnippetLimits.name) {
    throw new Error('invalid snippet name');
  }
  return value;
}

function ownSnippetStoreResetNote(reset: OwnSnippetStoreReset): OutputMessage {
  return outputNote(
    'App',
    'snippet-store.reset',
    { id: 'code-editor.snippets.store-reset' },
    {
      severity: 'warning',
      cause: reset.backupPath
        ? {
            id: 'code-editor.snippets.store-reset.backup',
            args: { name: basename(reset.backupPath) },
          }
        : { id: 'code-editor.snippets.store-reset.kept' },
      detail: reset.reason,
    },
  );
}

function assertBoundedLanguagePayload(value: unknown): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error('language-server payload is not serializable');
  }
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > 4 * 1024 * 1024) {
    throw new Error('language-server payload exceeds its bounded size');
  }
}

function languageDocumentUri(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const textDocument = (value as { textDocument?: unknown }).textDocument;
  if (!textDocument || typeof textDocument !== 'object') return null;
  const uri = (textDocument as { uri?: unknown }).uri;
  return typeof uri === 'string' && uri.length <= 4096 ? uri : null;
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (shuttingDown || !supervisor) return;
  if (mainWindow && !mainWindow.isDestroyed() && !windowCloseApproved) {
    event.preventDefault();
    mainWindow.close();
    return;
  }
  event.preventDefault();
  shuttingDown = true;
  disposeEditorInventory();
  const activeSupervisor = supervisor;
  const logShutdown = (message: string, error?: unknown) =>
    error === undefined ? console.error(message) : console.error(message, error);
  guardShutdownErrors(process, logShutdown);
  for (const controller of controlLiveAbortControllers.values()) controller.abort();
  const connectorStopped =
    connectorService
      ?.stop(updateService?.state().phase === 'installing' ? 'ide-updating' : 'ide-closing')
      .catch((error: unknown) => logShutdown('stopping the MCP connector failed', error)) ??
    Promise.resolve();
  void shutdownApplication({
    stopExecution: () => executionLease.stop(),
    stopServices: () =>
      Promise.all([
        connectorStopped,
        controlSessionBridgeInstance?.shutdown(),
        pictureService?.dispose(),
      ])
        .catch((error: unknown) =>
          logShutdown('detaching AoE2Control failed while quitting', error),
        )
        .then(() =>
          Promise.allSettled([activeSupervisor.stopAll(), externalLanguageServers?.stop()]),
        )
        .then(() => undefined),
    killChildren: () => {
      externalLanguageServers?.kill();
      activeSupervisor.killAll();
    },
    exit: () => void finishQuit(),
    log: logShutdown,
  });
});
