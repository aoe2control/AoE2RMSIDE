import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { flushSync } from 'react-dom';
import { PanelLeftClose, PanelLeftOpen, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type {
  ApplicationMenuAction,
  PreviewGenerationResult,
  PreviewProvenanceOperation,
  DesktopSession,
  InstalledSourceOriginFilter,
  LanguageServerDiagnostic,
  MapTestRunInput,
  MapTestRunResult,
  NativeProcessName,
  NativeProcessStatus,
} from '../shared/api';
import { applicationKeyAllowed, menuActionAllowed } from '../shared/application-shortcuts';
import { definitionFilesAvailable, editionCapabilities } from '../shared/edition';
import {
  inlineErrorText,
  presentMapTestReplayFailure,
  presentMessage,
} from '../shared/message-catalog';
import { createSessionAutosaveReporter } from './session-autosave';
import { outputNote, type OutputMessage } from '../shared/output-message';
import type { PreviewLook, PreviewPerspective } from '../shared/game-art';
import {
  defaultOverlayEditorShown,
  defaultPreviewLayout,
  nextPreviewLayout,
  previewLayoutShowsEditor,
  previewLayoutShowsPreview,
  type PreviewLayout,
} from '../shared/preview-layout';
import {
  AppPanelContext,
  type EditorFindRequest,
  type MapTestResultsState,
  type SourceSelection,
} from './app-context';
import { AppTour } from './app-tour';
import { isUntitledDocument } from './untitled-documents';
import { mapTestReplayInput, replayedRunSeed } from './map-test-replay';
import { replayedLobbySettings, type PreviewBeforeReplay } from './replay-run-preset';
import { contentMatchStep, type ContentMatchGesture, type ContentMatchVisit } from './monaco-find';
import { mapTestPreviewShown, type PreviewMapOrigin } from './map-test-preview';
import {
  anchorMapTestRunDiagnostics,
  readablePathName,
  type MapTestResultsOrigin,
} from './map-test-results-model';
import { MapTestProgressStore } from './map-test-progress';
import { MapTestResultsPanel } from './map-test-results-panel';
import { EditorGameVersionSelect } from './editor-game-version-select';
import { EditorPanel } from './editor-panel';
import { PreviewCandidateStore, previewCandidateHoldMilliseconds } from './preview-candidate-store';
import { ExecutionProfilerStore } from './execution-profiler';
import { unlinkGameInstallation } from './game-installation';
import { InstalledSourceBrowser } from './installed-source-browser';
import { installedSourceOriginFilterDefault } from './installed-source-filter';
import {
  appendOutputMessage,
  clearOutputLog,
  emptyOutputLog,
  outputMessageCount,
  outputSeverityCounts,
  settleOutputRun as settleOutputRunState,
  toggleOutputGroup,
  type OutputRunHeader,
} from './output-log';
import { OutputPanel } from './output-panel';
import { ProblemsPanel } from './problems-panel';
import {
  isStandardGameSource,
  problemCount,
  problemGroups,
  problemSeverityCounts,
  readableSourceName,
  sourcePathKey,
  type ProblemTarget,
} from './problems-model';
import { xsStartProblemMessage } from './xs-start-output';
import {
  isQualityReport,
  qualityProblemDiagnostics,
  qualityProblemMessage,
} from './quality-check-output';
import {
  outputSeverityFilterDefault,
  problemsSeverityFilterDefault,
  toggleSeverity,
  type SeverityFilter,
} from './severity-filter';
import { SeverityFilterToggles } from './severity-filter-toggles';
import { SeparatorPill } from './separator-pill-view';
import { isSnippetCodeUri } from './snippet-code';
import { ManagedModDeploymentPanel } from './managed-mod-deployment-panel';
import { PreviewPanel } from './preview-panel';
import type { PinnedPreviewSource, PreviewExecutionController } from './preview-execution';
import {
  failureReportedByMain,
  runOutcomeEffects,
  type ExecutionFailureNoticeContent,
  type RunOutcome,
  type RunTrigger,
} from './run-outcome';
import { isModalSurfaceOpen } from './modal-surfaces';
import { usePresence } from './motion';
import { runEditorHistoryCommand, setRmsConditionalIndentation } from './monaco-language';
import { requestInsertSnippet, requestSaveSnippet } from './insert-snippet';
import {
  noSourceHighlightOperations,
  operationsIntersectingByteRanges,
  sameSourceHighlightRequest,
  sourceHighlightRangesForMap,
  type SourceHighlightRequest,
} from './source-highlight';
import { previewSourceContents } from './preview-source-content';
import { useEditorListHandoff } from './editor-list-handoff';
import { nextPaneIndex } from './keyboard-navigation';
import { navigateToPreviewOperation } from './source-navigation';
import { resolveTheme, type ThemePreference } from './theme';
import { useWorkspaceController } from './workspace-controller';
import { WorkspaceDialog } from './workspace-dialog';
import { LanguageSettingsDialog } from './language-settings-dialog';
import { ThemeSettingsDialog } from './theme-settings-dialog';
import { defaultEditorColorScheme, type EditorColorSchemeId } from '../shared/editor-color-scheme';
import { DefinitionFileDialog, type DefinitionFileRequest } from './definition-file-dialog';
import { useI18n } from './i18n';
import { WorkspaceSidebar } from './workspace-sidebar';
import { ApplicationMenuBar } from './application-menu-bar';
import {
  UpdateDialog,
  UpdateHeaderControl,
  UpdateProvider,
  useUpdateController,
} from './update-control';
import {
  connectorAppsConnected,
  connectorDeployNotice,
  connectorOutputMessage,
  type ConnectorDeployNotice,
} from './mcp-connector-model';
import { useConnectorState } from './mcp-connector-state';
import { McpPrompts } from './mcp-prompts';
import { useAppPictureTexturesBridge } from './app-picture-textures';
import { McpSettingsDialog } from './mcp-settings-dialog';
import { McpStatusIndicator } from './mcp-status-indicator';

const bottomPanelNavigationHeight = 34;
const explorerDefaultWidth = 248;
const explorerMinimumWidth = 220;
const explorerMaximumWidth = 420;
const editorMinimumWidth = 360;
const previewMinimumWidth = 300;
const previewSeparatorWidth = 1;
const snapThreshold = 96;

const previewLayoutSettleMilliseconds = 1_000;

type BottomPanelTab = 'problems' | 'output' | 'test-results';
type HorizontalDrag = {
  kind: 'explorer' | 'preview';
  pointerId: number;
  width: number;
  expanded: boolean;
  layout: PreviewLayout;
  edge: number;
  maximum: number;
};
type BottomPanelResize = {
  pointerId: number;
  startHeight: number;
  startY: number;
  height: number;
};

export function App() {
  const [map, setMap] = useState<PreviewGenerationResult | null>(null);
  const mapRef = useRef(map);
  mapRef.current = map;
  const [previewMapOrigin, setPreviewMapOrigin] = useState<PreviewMapOrigin>('generation');
  const previewMapOriginRef = useRef(previewMapOrigin);
  previewMapOriginRef.current = previewMapOrigin;
  const [executionFailure, setExecutionFailure] = useState<{
    raised: number;
    notice: ExecutionFailureNoticeContent | null;
  }>({ raised: 0, notice: null });
  const [previewExecution, setPreviewExecution] = useState<PreviewExecutionController | null>(null);
  const [pinnedPreviewSource, setPinnedPreviewSource] = useState<PinnedPreviewSource | null>(null);
  const [selection, setSelection] = useState<SourceSelection | null>(null);
  const [sourceHighlightRequest, setSourceHighlightRequest] =
    useState<SourceHighlightRequest | null>(null);
  const [failedStatuses, setFailedStatuses] = useState<NativeProcessStatus[]>([]);
  const [restartingProcesses, setRestartingProcesses] = useState<Set<NativeProcessName>>(new Set());
  const [languageDiagnostics, setLanguageDiagnostics] = useState<
    Map<string, LanguageServerDiagnostic[]>
  >(new Map());
  const [outputLog, setOutputLog] = useState(emptyOutputLog);
  const [mapTestResults, setMapTestResults] = useState<MapTestResultsState | null>(null);
  const [mapTestResultsOrigin, setMapTestResultsOrigin] = useState<MapTestResultsOrigin>('current');
  const [mapTestDiagnostics, setMapTestDiagnostics] = useState<
    Map<string, LanguageServerDiagnostic[]>
  >(new Map());
  const [xsStartDiagnostics, setXsStartDiagnostics] = useState<
    ReadonlyMap<string, LanguageServerDiagnostic[]>
  >(new Map());
  const [qualityDiagnostics, setQualityDiagnostics] = useState<
    ReadonlyMap<string, LanguageServerDiagnostic[]>
  >(new Map());
  const publishXsStartFindings = useCallback(
    (findings: ReadonlyMap<string, LanguageServerDiagnostic[]>) =>
      setXsStartDiagnostics((current) =>
        current.size === 0 && findings.size === 0 ? current : findings,
      ),
    [],
  );
  const [bottomPanelOpen, setBottomPanelOpen] = useState(false);
  const [bottomPanelHeight, setBottomPanelHeight] = useState(150);
  const bottomPanelPresence = usePresence(bottomPanelOpen);
  const bottomPanelPresenceRef = bottomPanelPresence.ref;
  const [bottomPanelTab, setBottomPanelTab] = useState<BottomPanelTab>('output');
  const [explorerExpanded, setExplorerExpanded] = useState(true);
  const [explorerWidth, setExplorerWidth] = useState(explorerDefaultWidth);
  const [findInFilesRequest, setFindInFilesRequest] = useState(0);
  const [tourRestartRequest, setTourRestartRequest] = useState(0);
  const [previewLayoutState, setPreviewLayoutState] = useState<{
    layout: PreviewLayout;
    from: PreviewLayout;
  }>({ layout: defaultPreviewLayout, from: defaultPreviewLayout });
  const previewLayout = previewLayoutState.layout;
  const previewExpanded = previewLayoutShowsPreview(previewLayout);
  const [overlayEditorShown, setOverlayEditorShown] = useState(defaultOverlayEditorShown);
  const editorShown =
    !editionCapabilities.preview || previewLayoutShowsEditor(previewLayout, overlayEditorShown);
  const previewLayoutRef = useRef(previewLayout);
  previewLayoutRef.current = previewLayout;
  const setEditorShownBehindPreview = useCallback((shown: boolean) => {
    if (previewLayoutRef.current === 'behind-editor') setOverlayEditorShown(shown);
  }, []);
  const showEditor = useCallback(
    () => setEditorShownBehindPreview(true),
    [setEditorShownBehindPreview],
  );
  const hideEditor = useCallback(
    () => setEditorShownBehindPreview(false),
    [setEditorShownBehindPreview],
  );
  const changePreviewLayout = useCallback(
    (next: PreviewLayout | ((current: PreviewLayout) => PreviewLayout)) =>
      setPreviewLayoutState((state) => {
        const layout = typeof next === 'function' ? next(state.layout) : next;
        return layout === state.layout ? state : { layout, from: state.layout };
      }),
    [],
  );
  const [profilerOpen, setProfilerOpen] = useState(false);
  const [executionProfiler] = useState(() => new ExecutionProfilerStore());
  const [previewCandidates] = useState(
    () => new PreviewCandidateStore({ holdMilliseconds: previewCandidateHoldMilliseconds }),
  );
  const [mapTestProgress] = useState(() => new MapTestProgressStore());
  const generationActivityKind = useSyncExternalStore(
    previewCandidates.subscribeActivity,
    () => previewCandidates.activity?.kind ?? null,
  );
  const mapTestPreview = mapTestPreviewShown({
    mapOrigin: map ? previewMapOrigin : null,
    activityKind: generationActivityKind,
  });
  const [outputProfilerHost, setOutputProfilerHost] = useState<HTMLDivElement | null>(null);
  const [outputVersionHost, setOutputVersionHost] = useState<HTMLDivElement | null>(null);
  const expandPreview = useCallback(
    () =>
      changePreviewLayout((current) =>
        previewLayoutShowsPreview(current) ? current : defaultPreviewLayout,
      ),
    [changePreviewLayout],
  );
  const settlePreviewLayout = useCallback(
    () =>
      setPreviewLayoutState((state) =>
        state.from === state.layout ? state : { ...state, from: state.layout },
      ),
    [],
  );
  useEffect(() => {
    if (previewLayoutState.from === previewLayoutState.layout) return undefined;
    const timer = window.setTimeout(settlePreviewLayout, previewLayoutSettleMilliseconds);
    return () => window.clearTimeout(timer);
  }, [previewLayoutState, settlePreviewLayout]);
  const cyclePreviewLayout = useCallback(
    () => changePreviewLayout((current) => nextPreviewLayout(current)),
    [changePreviewLayout],
  );
  const [previewWidth, setPreviewWidth] = useState<number | null>(null);
  const [horizontalDragKind, setHorizontalDragKind] = useState<HorizontalDrag['kind'] | null>(null);
  const [sessionApplied, setSessionApplied] = useState(false);
  const [systemIsDark, setSystemIsDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  const [themePreference, setThemePreference] = useState<ThemePreference>('system');
  const [editorColorScheme, setEditorColorScheme] =
    useState<EditorColorSchemeId>(defaultEditorColorScheme);
  const [previewBlur, setPreviewBlur] = useState(false);
  const [themeSettingsOpen, setThemeSettingsOpen] = useState(false);
  const [formatOnSave, setFormatOnSave] = useState(true);
  const [indentConditionals, setIndentConditionals] = useState(true);
  const [liveGenerationStages, setLiveGenerationStages] = useState(true);
  const [gpuMapRendering, setGpuMapRendering] = useState(true);
  const [mapTransitions, setMapTransitions] = useState(true);
  const [xsStartCheck, setXsStartCheck] = useState(true);
  const [inlayHints, setInlayHints] = useState(true);
  const [outlineRow, setOutlineRow] = useState(true);
  const [deletePermanently, setDeletePermanently] = useState(false);
  const [previewPerspective, setPreviewPerspective] = useState<PreviewPerspective>('top-down');
  const [previewLook, setPreviewLook] = useState<PreviewLook>('minimap');
  const [previewTileGrid, setPreviewTileGrid] = useState(false);
  const [previewSmallTrees, setPreviewSmallTrees] = useState(false);
  const [gameTexturesNoticeOpen, setGameTexturesNoticeOpen] = useState(false);
  const closeGameTexturesNotice = useCallback(() => setGameTexturesNoticeOpen(false), []);
  useEffect(
    () =>
      window.rmside.onGameTexturesFirstLink(() => {
        setPreviewPerspective('diamond');
        setPreviewLook('game-textures');
        setGameTexturesNoticeOpen(true);
      }),
    [],
  );
  const [installedSourceBrowserOpen, setInstalledSourceBrowserOpen] = useState(false);
  const [languageSettingsOpen, setLanguageSettingsOpen] = useState(false);
  const [connectorState, setConnectorState] = useConnectorState(editionCapabilities.mcp);
  useAppPictureTexturesBridge(editionCapabilities.mcp);
  const [mcpSettingsOpen, setMcpSettingsOpen] = useState(false);
  const openMcpSettings = useCallback(() => setMcpSettingsOpen(true), []);
  const [appDeployNotice, setAppDeployNotice] = useState<ConnectorDeployNotice | null>(null);
  const dismissAppDeployNotice = useCallback(() => setAppDeployNotice(null), []);
  const [definitionFileRequest, setDefinitionFileRequest] = useState<DefinitionFileRequest | null>(
    null,
  );
  const definitionFileRequestKey = useRef(0);
  const openDefinitionFile = useCallback((folderId: string | null) => {
    if (!definitionFilesAvailable(editionCapabilities)) return;
    definitionFileRequestKey.current += 1;
    setDefinitionFileRequest({ key: definitionFileRequestKey.current, folderId });
  }, []);
  const { t } = useI18n();
  const [managedModDeploymentOpen, setManagedModDeploymentOpen] = useState(false);
  const [managedModDeploymentSourceId, setManagedModDeploymentSourceId] = useState<string | null>(
    null,
  );
  const resolvedTheme = resolveTheme(themePreference, systemIsDark);
  const horizontalDrag = useRef<HorizontalDrag | null>(null);
  const bottomPanelResize = useRef<BottomPanelResize | null>(null);
  const horizontalResizeFrame = useRef<number | null>(null);
  const bottomResizeFrame = useRef<number | null>(null);
  const appShellElement = useRef<HTMLElement>(null);
  const bindAppShell = useCallback(
    (element: HTMLElement | null) => {
      appShellElement.current = element;
      bottomPanelPresenceRef(element);
    },
    [bottomPanelPresenceRef],
  );
  const mapTestResultsRef = useRef<MapTestResultsState | null>(mapTestResults);
  const layoutElement = useRef<HTMLDivElement>(null);
  const splitElement = useRef<HTMLDivElement>(null);
  const previewRegionElement = useRef<HTMLDivElement>(null);
  mapTestResultsRef.current = mapTestResults;

  const appendOutput = useCallback((message: OutputMessage, options?: { runId?: string }) => {
    setOutputLog((current) => appendOutputMessage(current, message, Date.now(), options?.runId));
  }, []);
  const settleOutputRun = useCallback((runId: string, header: OutputRunHeader | null) => {
    setOutputLog((current) => settleOutputRunState(current, runId, header, Date.now()));
  }, []);
  const toggleOutputRun = useCallback((runId: string) => {
    setOutputLog((current) => toggleOutputGroup(current, runId));
  }, []);
  const clearOutput = useCallback(() => {
    setOutputLog((current) => clearOutputLog(current));
  }, []);
  const openManagedModDeployment = useCallback((sourceId: string | null) => {
    setManagedModDeploymentSourceId(sourceId);
    setManagedModDeploymentOpen(true);
  }, []);
  const workspace = useWorkspaceController(appendOutput, formatOnSave, deletePermanently);
  const [layoutMotionReady, setLayoutMotionReady] = useState(false);
  const sessionLayoutShown =
    sessionApplied || (workspace.sessionReady && workspace.restoredSession === null);
  useEffect(() => {
    if (!sessionLayoutShown) return undefined;
    let frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(() => setLayoutMotionReady(true));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [sessionLayoutShown]);
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const showTourEditorTab = useCallback(() => {
    const current = workspaceRef.current;
    const automatic = current.documents.find(
      (document) => isUntitledDocument(document) && document.preview && !document.dirty,
    );
    if (automatic && automatic.id !== current.activeDocument.id) {
      current.setActiveDocument(automatic.id);
    }
  }, []);
  const lastContentMatch = useRef<ContentMatchVisit | null>(null);
  const openContentSearchMatch = useCallback(
    async (path: string, gesture: ContentMatchGesture, find: EditorFindRequest) => {
      const activeUriBefore = workspaceRef.current.activeDocument.uri;
      const document = await workspaceRef.current.openWorkspaceFile(path, gesture === 'pin');
      if (!document) return;
      const step = contentMatchStep(
        lastContentMatch.current,
        { uri: document.uri, find, activeUriBefore },
        gesture,
      );
      if (step === 'stay') return;
      lastContentMatch.current = { uri: document.uri, find, step };
      setSelection({
        uri: document.uri,
        utf16StartOffset: 0,
        utf16EndOffset: 0,
        marker: `${document.name}, ${step} occurrence of ${JSON.stringify(find.query)}`,
        find,
        ...(step === 'next' ? { findNext: true } : {}),
      });
    },
    [],
  );
  const readOnlySourceKeys = useMemo(
    () =>
      new Set(
        workspace.documents
          .filter((document) => document.readOnly)
          .map((document) => sourcePathKey(document.uri)),
      ),
    [workspace.documents],
  );
  const problemFileGroups = useMemo(
    () =>
      problemGroups(
        [
          ...languageDiagnostics,
          ...mapTestDiagnostics,
          ...xsStartDiagnostics,
          ...qualityDiagnostics,
        ],
        {
          isProtected: (uri) => isStandardGameSource(uri, readOnlySourceKeys),
          present: (diagnostic, severity) =>
            xsStartProblemMessage(diagnostic, severity) ??
            qualityProblemMessage(diagnostic, severity),
        },
      ),
    [
      languageDiagnostics,
      mapTestDiagnostics,
      xsStartDiagnostics,
      qualityDiagnostics,
      readOnlySourceKeys,
    ],
  );
  const problemsTotal = problemCount(problemFileGroups);
  const [outputSeverityFilter, setOutputSeverityFilter] = useState<SeverityFilter>(
    outputSeverityFilterDefault,
  );
  const [problemsSeverityFilter, setProblemsSeverityFilter] = useState<SeverityFilter>(
    problemsSeverityFilterDefault,
  );
  const [installedSourceOriginFilter, setInstalledSourceOriginFilter] =
    useState<InstalledSourceOriginFilter>(installedSourceOriginFilterDefault);
  const navigateToProblem = useCallback(
    async (target: ProblemTarget, location: string) => {
      const key = sourcePathKey(target.uri);
      const uri =
        workspace.documents.find((document) => sourcePathKey(document.uri) === key)?.uri ??
        target.uri;
      const document = await workspace.openWorkspaceSource(uri, true);
      if (!document) return;
      const offset = utf16OffsetForPosition(document.content, target.line, target.character);
      setSelection({
        uri,
        utf16StartOffset: offset,
        utf16EndOffset: offset,
        marker: location,
      });
    },
    [workspace],
  );
  const navigateToProblemLatest = useRef(navigateToProblem);
  navigateToProblemLatest.current = navigateToProblem;
  const openProblem = useCallback((target: ProblemTarget, location: string) => {
    void navigateToProblemLatest.current(target, location);
  }, []);
  const openSourceLocation = useCallback(
    async (uri: string, line: number, character: number): Promise<boolean> => {
      const key = sourcePathKey(uri);
      const known =
        workspace.documents.find((document) => sourcePathKey(document.uri) === key)?.uri ?? uri;
      const document = await workspace.openWorkspaceSource(known, true);
      if (!document) return false;
      const offset = utf16OffsetForPosition(document.content, line, character);
      setSelection({
        uri: known,
        utf16StartOffset: offset,
        utf16EndOffset: offset,
        marker: `${readableSourceName(known)}, line ${line + 1}`,
      });
      return true;
    },
    [workspace],
  );
  const sourceInvalid = useCallback(
    (uri: string) =>
      (languageDiagnostics.get(uri) ?? []).some((diagnostic) => diagnostic.severity === 1),
    [languageDiagnostics],
  );

  useEffect(() => {
    setPinnedPreviewSource((current) => {
      if (!current) return current;
      const document = workspace.documents.find((candidate) => candidate.id === current.id);
      if (!document || !/\.(?:rms|rms2)$/iu.test(document.name)) return null;
      if (
        current.name === document.name &&
        current.uri === document.uri &&
        current.content === document.content
      ) {
        return current;
      }
      return {
        id: document.id,
        uri: document.uri,
        name: document.name,
        content: document.content,
      };
    });
  }, [workspace.documents]);

  const selectPreviewOperation = useCallback(
    async (operationIndex: number) => {
      const current = mapRef.current;
      if (!current) return;
      const next = await navigateToPreviewOperation(current, operationIndex, workspace);
      if (!next) return;
      setSelection(next);
    },
    [workspace],
  );

  const navigateToOutputOperation = useCallback(
    async (operation: PreviewProvenanceOperation) => {
      const next = await navigateToPreviewOperation(
        { provenanceOperations: [operation], provenanceStatus: 'exact' },
        0,
        workspace,
      );
      if (next) setSelection(next);
    },
    [workspace],
  );
  const navigateToOutputOperationRef = useRef(navigateToOutputOperation);
  navigateToOutputOperationRef.current = navigateToOutputOperation;
  const openOutputOperation = useCallback(
    (operation: PreviewProvenanceOperation) => void navigateToOutputOperationRef.current(operation),
    [],
  );

  const highlightPreviewSource = useCallback((request: SourceHighlightRequest | null) => {
    setSourceHighlightRequest((current) =>
      sameSourceHighlightRequest(current, request) ? current : request,
    );
  }, []);
  const stableSourceHighlightOperations = useRef(noSourceHighlightOperations);
  const sourceHighlightOperationIndices = useMemo(() => {
    const current = mapRef.current;
    const next =
      current && sourceHighlightRequest
        ? operationsIntersectingByteRanges(
            current.provenanceOperations,
            sourceHighlightRequest.sourceId,
            sourceHighlightRangesForMap(sourceHighlightRequest, {
              documentUri: current.documentUri,
              content: previewSourceContents.get(current),
            }),
          )
        : noSourceHighlightOperations;
    const previous = stableSourceHighlightOperations.current;
    if (
      next.length === previous.length &&
      next.every((operation, index) => operation === previous[index])
    ) {
      return previous;
    }
    stableSourceHighlightOperations.current = next;
    return next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, sourceHighlightRequest]);
  const {
    operations: highlightedPreviewOperationIndices,
    setPointerInside: setEditorPointerInside,
  } = useEditorListHandoff(sourceHighlightOperationIndices, noSourceHighlightOperations, map);

  const commitPreview = useCallback(
    (result: PreviewGenerationResult, origin: PreviewMapOrigin = 'generation') => {
      previewCandidates.clear();
      setMap(result);
      setPreviewMapOrigin(origin);
      executionProfiler.settle(result);
      setExecutionFailure((current) => (current.notice ? { ...current, notice: null } : current));
      setSelection(null);
    },
    [executionProfiler, previewCandidates],
  );

  const replaySequence = useRef(0);
  const replayActivityRef = useRef<string | null>(null);
  const restorePreviewBeforeReplay = useCallback(
    (shown: PreviewBeforeReplay) => {
      replaySequence.current += 1;
      if (replayActivityRef.current !== null) {
        previewCandidates.end(replayActivityRef.current);
        replayActivityRef.current = null;
      }
      if (shown.map) {
        commitPreview(shown.map, shown.origin);
        return;
      }
      previewCandidates.clear();
      setMap(null);
      setPreviewMapOrigin('generation');
      executionProfiler.settle(null);
      setSelection(null);
    },
    [commitPreview, executionProfiler, previewCandidates],
  );

  const settleRunOutcome = useCallback(
    (outcome: RunOutcome, trigger: RunTrigger, runKey?: string) => {
      const { clearMap, discardCandidate, notice } = runOutcomeEffects(outcome, trigger);
      if (runKey !== undefined) {
        executionProfiler.end(runKey);
        previewCandidates.end(runKey);
      } else if (discardCandidate) previewCandidates.end();
      if (clearMap) {
        setMap(null);
        setPreviewMapOrigin('generation');
        executionProfiler.settle(null);
        setSelection(null);
      }
      if (notice) setExecutionFailure((current) => ({ raised: current.raised + 1, notice }));
    },
    [executionProfiler, previewCandidates],
  );

  useEffect(
    () =>
      window.rmside.onPreviewCandidate((candidate) => {
        const { accepted } = previewCandidates.apply(candidate);
        window.requestAnimationFrame(() =>
          window.rmside.acknowledgePreviewCandidate({
            requestId: candidate.requestId,
            revision: candidate.revision,
            accepted,
          }),
        );
      }),
    [previewCandidates],
  );

  const publishMapTestResult = useCallback(
    (scriptUri: string, input: MapTestRunInput, result: MapTestRunResult) => {
      setMapTestDiagnostics((current) => {
        const next = new Map(current);
        if (result.status === 'error' && result.diagnostics.length > 0) {
          next.set(scriptUri, anchorMapTestRunDiagnostics(result.diagnostics, input.scriptName));
        } else next.delete(scriptUri);
        return next;
      });
      const qualityCheck = input.quality !== undefined;
      if (qualityCheck) {
        const qualityReport =
          result.report && isQualityReport(result.report) ? result.report : null;
        setQualityDiagnostics(
          qualityReport
            ? new Map([[scriptUri, qualityProblemDiagnostics(qualityReport.quality)]])
            : new Map(),
        );
      }
      if (result.report && result.reportJson) {
        const nextResults = {
          report: result.report,
          reportJson: result.reportJson,
          scriptUri,
          runInput: structuredClone(input),
          imported: false,
        } satisfies MapTestResultsState;
        const resultsTabAppearing = mapTestResultsRef.current === null;
        mapTestResultsRef.current = nextResults;
        setMapTestResults(nextResults);
        setMapTestResultsOrigin('current');
        if (resultsTabAppearing && !qualityCheck) {
          setBottomPanelOpen(true);
          setBottomPanelTab('test-results');
        }
      } else {
        setMapTestResultsOrigin(result.status === 'cancelled' ? 'after-stop' : 'after-error');
      }
      if (result.preview && !qualityCheck) commitPreview(result.preview, 'map-test');
    },
    [commitPreview],
  );

  const markMapTestRun = useCallback((activity: 'running' | 'error' | 'cancelled') => {
    setMapTestResultsOrigin(
      activity === 'running' ? 'running' : activity === 'error' ? 'after-error' : 'after-stop',
    );
  }, []);

  const clearMapTestResults = useCallback(() => {
    mapTestResultsRef.current = null;
    setMapTestResults(null);
    setQualityDiagnostics((current) => (current.size === 0 ? current : new Map()));
    setMapTestResultsOrigin('current');
    setBottomPanelTab((current) => (current === 'test-results' ? 'output' : current));
  }, []);

  const importMapTestReport = useCallback(async () => {
    try {
      const imported = await window.rmside.importMapTestReport();
      if (!imported) return;
      const nextResults = {
        report: imported.report,
        reportJson: imported.reportJson,
        scriptUri: null,
        runInput: null,
        imported: true,
      } satisfies MapTestResultsState;
      mapTestResultsRef.current = nextResults;
      setMapTestResults(nextResults);
      setMapTestResultsOrigin('current');
      setBottomPanelOpen(true);
      setBottomPanelTab('test-results');
      appendOutput(
        outputNote('Map test', 'map-test.report-imported', {
          id: 'workbench.map-test.report-imported',
          args: { name: readablePathName(imported.report.script.name) },
        }),
      );
    } catch (error) {
      appendOutput(
        presentMessage({
          source: 'Map test',
          raw: errorMessage(error),
          fallbackHeadline: 'workbench.map-test.import-failed',
        }),
      );
    }
  }, [appendOutput]);

  const dismissExecutionFailureNotice = useCallback(
    () =>
      setExecutionFailure((current) => (current.notice ? { ...current, notice: null } : current)),
    [],
  );

  const panelContext = useMemo(
    () => ({
      workspace,
      map: mapRef.current,
      selection,
      highlightedPreviewOperationIndices,
      highlightPreviewSource,
      setEditorPointerInside,
      selectPreviewOperation,
      commitPreview,
      restorePreviewBeforeReplay,
      previewMapOrigin,
      mapTestPreviewShown: mapTestPreview,
      settleRunOutcome,
      appendOutput,
      settleOutputRun,
      mapTestResults,
      clearMapTestResults,
      publishMapTestResult,
      publishXsStartFindings,
      markMapTestRun,
      mapTestProgress,
      sourceInvalid,
      previewExecution,
      setPreviewExecution,
      pinnedPreviewSource,
      setPinnedPreviewSource,
      openManagedModDeployment,
      openSourceLocation,
      resolvedTheme,
      editorColorScheme,
      executionProfiler,
      previewCandidates,
      liveGenerationStages,
      gpuMapRendering,
      mapTransitions,
      xsStartCheck,
      previewPerspective,
      setPreviewPerspective,
      previewLook,
      setPreviewLook,
      previewTileGrid,
      setPreviewTileGrid,
      previewSmallTrees,
      setPreviewSmallTrees,
      gameTexturesNoticeOpen,
      closeGameTexturesNotice,
      previewExpanded,
      expandPreview,
      profilerOpen,
      setProfilerOpen,
      outputProfilerHost,
      outputVersionHost,
    }),
    [
      openSourceLocation,
      executionProfiler,
      previewCandidates,
      liveGenerationStages,
      gpuMapRendering,
      mapTransitions,
      xsStartCheck,
      previewPerspective,
      previewLook,
      previewTileGrid,
      previewSmallTrees,
      gameTexturesNoticeOpen,
      closeGameTexturesNotice,
      expandPreview,
      outputProfilerHost,
      outputVersionHost,
      previewExpanded,
      profilerOpen,
      appendOutput,
      settleOutputRun,
      clearMapTestResults,
      mapTestResults,
      markMapTestRun,
      mapTestProgress,
      publishMapTestResult,
      publishXsStartFindings,
      commitPreview,
      restorePreviewBeforeReplay,
      previewMapOrigin,
      mapTestPreview,
      settleRunOutcome,
      highlightedPreviewOperationIndices,
      highlightPreviewSource,
      map,
      openManagedModDeployment,
      pinnedPreviewSource,
      previewExecution,
      resolvedTheme,
      editorColorScheme,
      selectPreviewOperation,
      selection,
      setEditorPointerInside,
      sourceInvalid,
      workspace,
    ],
  );

  const resetLayout = useCallback(async () => {
    if (horizontalResizeFrame.current !== null) {
      window.cancelAnimationFrame(horizontalResizeFrame.current);
      horizontalResizeFrame.current = null;
    }
    if (bottomResizeFrame.current !== null) {
      window.cancelAnimationFrame(bottomResizeFrame.current);
      bottomResizeFrame.current = null;
    }
    cleanupHorizontalDrag(horizontalDrag);
    setHorizontalDragKind(null);
    cleanupBottomResize(bottomPanelResize);
    setExplorerExpanded(true);
    setExplorerWidth(explorerDefaultWidth);
    changePreviewLayout(defaultPreviewLayout);
    setOverlayEditorShown(defaultOverlayEditorShown);
    setPreviewWidth(null);
    setProfilerOpen(false);
    setBottomPanelOpen(false);
    setBottomPanelHeight(150);
    setBottomPanelTab('output');
    await window.rmside.resetLayout();
  }, [changePreviewLayout]);

  const openInstalledSources = useCallback(() => {
    setInstalledSourceBrowserOpen(true);
  }, []);

  const unlinkSelectedGameInstallation = useCallback(async () => {
    try {
      await unlinkGameInstallation();
    } catch (error) {
      appendOutput(
        presentMessage({
          source: 'Game folder',
          raw: errorMessage(error),
          fallbackHeadline: 'workbench.game-folder.unlink-failed',
        }),
      );
    }
  }, [appendOutput]);

  const restart = useCallback(
    async (name: NativeProcessName) => {
      setRestartingProcesses((current) => new Set(current).add(name));
      try {
        const status = await window.rmside.restartNative(name);
        setFailedStatuses((current) => current.filter((entry) => entry.name !== name));
        appendOutput(
          outputNote('Recovery', 'recovery.native-restarted', {
            id: 'workbench.native.restarted',
            args: { name: status.name },
          }),
        );
      } catch (error) {
        appendOutput(
          presentMessage({
            source: 'Recovery',
            raw: errorMessage(error),
            fallbackHeadline: { id: 'workbench.native.restart-failed', args: { name } },
          }),
        );
      } finally {
        setRestartingProcesses((current) => {
          const next = new Set(current);
          next.delete(name);
          return next;
        });
      }
    },
    [appendOutput],
  );

  useEffect(() => {
    setRmsConditionalIndentation(indentConditionals);
  }, [indentConditionals]);

  useEffect(() => {
    if (!workspace.sessionReady || !workspace.restoredSession || sessionApplied) return;
    const session = workspace.restoredSession;
    setThemePreference(session.themePreference);
    setEditorColorScheme(session.editorColorScheme);
    setPreviewBlur(session.previewBlur);
    setFormatOnSave(session.formatOnSave);
    setIndentConditionals(session.indentConditionals);
    setLiveGenerationStages(session.liveGenerationStages);
    setGpuMapRendering(session.gpuMapRendering);
    setMapTransitions(session.mapTransitions);
    setXsStartCheck(session.xsStartCheck);
    setInlayHints(session.inlayHints);
    setOutlineRow(session.outlineRow);
    setDeletePermanently(session.deletePermanently);
    setPreviewPerspective(session.previewPerspective);
    setPreviewLook(session.previewLook);
    setPreviewTileGrid(session.previewTileGrid);
    setPreviewSmallTrees(session.previewSmallTrees);
    setExplorerExpanded(session.layout.explorerExpanded);
    setExplorerWidth(session.layout.explorerWidth);
    setPreviewLayoutState({
      layout: session.layout.previewLayout,
      from: session.layout.previewLayout,
    });
    setOverlayEditorShown(session.layout.overlayEditorShown);
    setPreviewWidth(session.layout.previewWidth);
    setProfilerOpen(session.layout.profilerOpen);
    setBottomPanelHeight(session.layout.bottomPanelHeight);
    setBottomPanelTab(session.layout.bottomPanelTab);
    setOutputSeverityFilter(session.layout.outputSeverityFilter);
    setProblemsSeverityFilter(session.layout.problemsSeverityFilter);
    setInstalledSourceOriginFilter(session.layout.installedSourceOriginFilter);
    setBottomPanelOpen(false);
    setSessionApplied(true);
  }, [sessionApplied, workspace.restoredSession, workspace.sessionReady]);

  const releaseNoticeRequested = useRef(false);
  useEffect(() => {
    if (!sessionApplied || !editionCapabilities.releaseCheck) return;
    if (releaseNoticeRequested.current) return;
    releaseNoticeRequested.current = true;
    void window.rmside.takeReleaseNotice().then(
      (notice) => {
        if (notice) appendOutput(notice);
      },
      () => undefined,
    );
  }, [appendOutput, sessionApplied]);

  const update = useUpdateController(editionCapabilities.releaseCheck);

  const sessionAutosave = useMemo(
    () => createSessionAutosaveReporter(appendOutput),
    [appendOutput],
  );

  useEffect(() => {
    if (!sessionApplied || !workspace.restoredSession) return undefined;
    const timer = window.setTimeout(() => {
      const normalDocuments = workspace.documents.filter(
        (document) => document.path && !document.preview,
      );
      const lastNormalDocument = workspace.lastNormalActivePath
        ? normalDocuments.find((document) => document.path === workspace.lastNormalActivePath)
        : undefined;
      const activePath =
        workspace.activeDocument.path && !workspace.activeDocument.preview
          ? workspace.activeDocument.path
          : (lastNormalDocument?.path ?? normalDocuments[0]?.path ?? null);
      const session: DesktopSession = {
        ...workspace.restoredSession!,
        version: 1,
        themePreference,
        editorColorScheme,
        previewBlur,
        formatOnSave,
        indentConditionals,
        liveGenerationStages,
        gpuMapRendering,
        mapTransitions,
        inlayHints,
        outlineRow,
        deletePermanently,
        previewPerspective,
        previewLook,
        previewTileGrid,
        previewSmallTrees,
        layout: {
          explorerExpanded,
          explorerWidth,
          previewExpanded,
          previewLayout,
          overlayEditorShown,
          previewWidth,
          bottomPanelHeight,
          bottomPanelTab,
          profilerOpen,
          outputSeverityFilter,
          problemsSeverityFilter,
          installedSourceOriginFilter,
        },
        workspace: {
          folder: workspace.folder,
          expandedPaths: workspace.expandedPaths,
          selectedPath: workspace.selectedPath,
          normalTabs: normalDocuments.map((document) => ({
            path: document.path!,
            viewState: document.viewState ?? null,
          })),
          activePath,
        },
      };
      void sessionAutosave.save(() => window.rmside.saveDesktopSession(session));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    sessionAutosave,
    bottomPanelHeight,
    bottomPanelTab,
    editorColorScheme,
    previewBlur,
    explorerExpanded,
    explorerWidth,
    formatOnSave,
    indentConditionals,
    liveGenerationStages,
    gpuMapRendering,
    mapTransitions,
    inlayHints,
    outlineRow,
    deletePermanently,
    previewPerspective,
    previewLook,
    previewTileGrid,
    previewSmallTrees,
    previewExpanded,
    previewLayout,
    overlayEditorShown,
    previewWidth,
    profilerOpen,
    outputSeverityFilter,
    problemsSeverityFilter,
    installedSourceOriginFilter,
    sessionApplied,
    themePreference,
    workspace.activeDocument.path,
    workspace.activeDocument.preview,
    workspace.documents,
    workspace.expandedPaths,
    workspace.folder,
    workspace.lastNormalActivePath,
    workspace.restoredSession,
    workspace.selectedPath,
  ]);

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const updateSystemTheme = (event: MediaQueryListEvent) => setSystemIsDark(event.matches);
    query.addEventListener('change', updateSystemTheme);
    return () => query.removeEventListener('change', updateSystemTheme);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolvedTheme === 'dark');
    document.documentElement.dataset.theme = themePreference;
    document.documentElement.style.colorScheme = resolvedTheme;
    if (sessionApplied) void window.rmside.syncNativeTheme(themePreference, resolvedTheme);
  }, [resolvedTheme, sessionApplied, themePreference]);

  useEffect(() => {
    document.documentElement.dataset.previewBlur = String(previewBlur);
  }, [previewBlur]);

  useEffect(() => {
    if (!editionCapabilities.mapTests) return;
    void window.rmside.syncMapTestResultsVisibility(mapTestResults !== null);
  }, [mapTestResults]);

  useEffect(() => {
    if (!editionCapabilities.mapTests) return;
    void window.rmside.syncMapTestPreviewShown(mapTestPreview);
  }, [mapTestPreview]);

  useEffect(() => {
    const cycleFocus = (event: KeyboardEvent) => {
      if (event.key !== 'F6' || event.altKey || event.ctrlKey || event.metaKey) return;
      if (!applicationKeyAllowed(isModalSurfaceOpen())) return;
      const shell = appShellElement.current;
      if (!shell) return;
      const active = document.activeElement;
      if (
        active?.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')
      ) {
        return;
      }
      const panes = [
        shell.querySelector<HTMLElement>('.workspace-sidebar[data-expanded="true"]'),
        shell.querySelector<HTMLElement>('.editor-panel'),
        shell.querySelector<HTMLElement>('.workspace-preview-region[data-expanded="true"]'),
        shell.querySelector<HTMLElement>('.bottom-panel'),
      ];
      const current = panes.findIndex((pane) => pane?.contains(document.activeElement) ?? false);
      const target = nextPaneIndex(
        current,
        panes.map((pane) => pane !== null && paneFocusTarget(pane) !== null),
        event.shiftKey,
      );
      if (target === null) return;
      event.preventDefault();
      event.stopPropagation();
      paneFocusTarget(panes[target]!)?.focus();
    };
    window.addEventListener('keydown', cycleFocus, true);
    return () => window.removeEventListener('keydown', cycleFocus, true);
  }, []);

  useEffect(() => {
    const runMenuAction = (action: ApplicationMenuAction) => {
      const currentWorkspace = workspaceRef.current;
      if (action.type === 'undo' || action.type === 'redo') runEditorHistoryCommand(action.type);
      else if (action.type === 'set-theme') setThemePreference(action.theme);
      else if (action.type === 'open-theme-settings') setThemeSettingsOpen(true);
      else if (action.type === 'open-language-settings') setLanguageSettingsOpen(true);
      else if (action.type === 'open-mcp-settings') {
        if (editionCapabilities.mcp) setMcpSettingsOpen(true);
      } else if (action.type === 'reset-layout') void resetLayout();
      else if (action.type === 'new-file') currentWorkspace.newFile();
      else if (action.type === 'new-map-test-script') currentWorkspace.newMapTestScript();
      else if (action.type === 'generate-definition-file') openDefinitionFile(null);
      else if (action.type === 'new-xs-script') currentWorkspace.newXsScript();
      else if (action.type === 'open-file') void currentWorkspace.pickFiles();
      else if (action.type === 'open-folder') void currentWorkspace.pickFolder();
      else if (action.type === 'find-in-files') {
        if (currentWorkspace.folder) {
          setExplorerExpanded(true);
          setFindInFilesRequest((request) => request + 1);
        }
      } else if (action.type === 'browse-installed-sources') openInstalledSources();
      else if (action.type === 'deploy-managed-mod') openManagedModDeployment(null);
      else if (action.type === 'import-map-test-report') void importMapTestReport();
      else if (action.type === 'unlink-game-folder') void unlinkSelectedGameInstallation();
      else if (action.type === 'open-recent') void currentWorkspace.openRecent(action.path);
      else if (action.type === 'save') void currentWorkspace.saveActive();
      else if (action.type === 'save-as') void currentWorkspace.saveActiveAs();
      else if (action.type === 'format-document') {
        showEditor();
        void currentWorkspace.formatActive();
      } else if (action.type === 'insert-snippet') {
        showEditor();
        requestInsertSnippet();
      } else if (action.type === 'save-snippet') {
        showEditor();
        requestSaveSnippet();
      } else if (action.type === 'set-format-on-save') {
        setFormatOnSave(action.enabled);
      } else if (action.type === 'set-indent-conditionals') {
        setIndentConditionals(action.enabled);
      } else if (action.type === 'set-gpu-map-rendering') {
        setGpuMapRendering(action.enabled);
      } else if (action.type === 'set-map-transitions') {
        setMapTransitions(action.enabled);
      } else if (action.type === 'set-xs-start-check') {
        setXsStartCheck(action.enabled);
      } else if (action.type === 'set-inlay-hints') {
        setInlayHints(action.enabled);
      } else if (action.type === 'set-outline-row') {
        setOutlineRow(action.enabled);
      } else if (action.type === 'set-delete-permanently') {
        setDeletePermanently(action.enabled);
      } else if (action.type === 'set-live-generation-stages') {
        setLiveGenerationStages(action.enabled);
        if (previewCandidates.activity) {
          appendOutput(
            outputNote('Preview', 'preview.stages-next-run', {
              id: action.enabled
                ? 'workbench.preview.stages-shown-next-run'
                : 'workbench.preview.stages-hidden-next-run',
            }),
          );
        }
      } else if (action.type === 'take-the-tour') setTourRestartRequest((request) => request + 1);
      else if (action.type === 'close-tab') void currentWorkspace.closeActive();
      else void currentWorkspace.closeFolder();
    };
    return window.rmside.onApplicationMenuAction((action) => {
      if (!menuActionAllowed(action.type, isModalSurfaceOpen())) return;
      flushSync(() => runMenuAction(action));
    });
  }, [
    appendOutput,
    importMapTestReport,
    openDefinitionFile,
    openManagedModDeployment,
    openInstalledSources,
    previewCandidates,
    resetLayout,
    showEditor,
    unlinkSelectedGameInstallation,
  ]);

  useEffect(() => {
    let cancelled = false;
    void window.rmside.getNativeStatus().then((statuses) => {
      if (!cancelled) setFailedStatuses(sortFailedStatuses(statuses));
    });
    const unsubscribe = window.rmside.onNativeEvent((next) => {
      setFailedStatuses((current) => {
        const withoutProcess = current.filter((status) => status.name !== next.name);
        return sortFailedStatuses(
          next.state === 'failed' ? [...withoutProcess, next] : withoutProcess,
        );
      });
      if (next.state === 'failed') {
        appendOutput(
          presentMessage({
            source: 'Recovery',
            raw: next.detail ?? '',
            fallbackHeadline: { id: 'workbench.native.stopped', args: { name: next.name } },
          }),
        );
      }
    });
    const unsubscribeDiagnostic = window.rmside.onWorkspaceDiagnostic((message) =>
      appendOutput(message),
    );
    const unsubscribeConnector = editionCapabilities.mcp
      ? window.rmside.onConnectorOutput((row) => {
          appendOutput(connectorOutputMessage(row));
          const notice = connectorDeployNotice(row);
          if (notice) setAppDeployNotice(notice);
        })
      : () => undefined;
    return () => {
      cancelled = true;
      unsubscribe();
      unsubscribeDiagnostic();
      unsubscribeConnector();
    };
  }, [appendOutput]);

  useEffect(
    () =>
      window.rmside.onLanguageServerEvent((event) => {
        if (event.method !== 'textDocument/publishDiagnostics') return;
        const params = event.params as { uri?: unknown; diagnostics?: unknown };
        if (typeof params?.uri !== 'string' || !Array.isArray(params.diagnostics)) return;
        if (isSnippetCodeUri(params.uri)) return;
        const diagnostics = params.diagnostics.filter(isLanguageServerDiagnostic);
        setLanguageDiagnostics((current) => {
          const next = new Map(current);
          if (diagnostics.length === 0) next.delete(params.uri as string);
          else next.set(params.uri as string, diagnostics);
          return next;
        });
      }),
    [],
  );

  useEffect(() => {
    const cancel = () => {
      const drag = horizontalDrag.current;
      if (drag?.kind === 'explorer') setExplorerWidth(drag.width);
      else if (drag?.kind === 'preview') setPreviewWidth(drag.width);
      const bottomResize = bottomPanelResize.current;
      if (bottomResize) setBottomPanelHeight(bottomResize.height);
      if (horizontalResizeFrame.current !== null) {
        window.cancelAnimationFrame(horizontalResizeFrame.current);
        horizontalResizeFrame.current = null;
      }
      if (bottomResizeFrame.current !== null) {
        window.cancelAnimationFrame(bottomResizeFrame.current);
        bottomResizeFrame.current = null;
      }
      cleanupHorizontalDrag(horizontalDrag);
      setHorizontalDragKind(null);
      cleanupBottomResize(bottomPanelResize);
    };
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('blur', cancel);
      cancel();
    };
  }, []);

  const selectBottomPanelTab = useCallback(
    (tab: BottomPanelTab) => {
      if (bottomPanelOpen && bottomPanelTab === tab) {
        cleanupBottomResize(bottomPanelResize);
        setBottomPanelOpen(false);
      } else {
        setBottomPanelTab(tab);
        setBottomPanelOpen(true);
      }
    },
    [bottomPanelOpen, bottomPanelTab],
  );

  const toggleBottomPanel = useCallback(() => {
    if (bottomPanelOpen) cleanupBottomResize(bottomPanelResize);
    setBottomPanelOpen((current) => !current);
  }, [bottomPanelOpen]);

  const handleBottomPanelNavigationClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (
        target.closest(
          ".bottom-tabs [data-slot='tabs-trigger'], .native-restart-controls, .bottom-panel-resize-handle, .bottom-panel-trailing-controls",
        )
      ) {
        return;
      }
      toggleBottomPanel();
    },
    [toggleBottomPanel],
  );

  const beginBottomPanelResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!bottomPanelOpen || event.button !== 0) return;
      event.preventDefault();
      bottomPanelResize.current = {
        pointerId: event.pointerId,
        startHeight: bottomPanelHeight,
        startY: event.clientY,
        height: bottomPanelHeight,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      document.body.classList.add('resizing-bottom-panel');
    },
    [bottomPanelHeight, bottomPanelOpen],
  );

  const resizeBottomPanel = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const resize = bottomPanelResize.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    const maximumHeight = Math.max(180, Math.floor(window.innerHeight * 0.65));
    resize.height = Math.round(
      Math.min(maximumHeight, Math.max(96, resize.startHeight + resize.startY - event.clientY)),
    );
    if (bottomResizeFrame.current !== null) return;
    bottomResizeFrame.current = window.requestAnimationFrame(() => {
      bottomResizeFrame.current = null;
      const current = bottomPanelResize.current;
      if (!current) return;
      appShellElement.current?.style.setProperty(
        'grid-template-rows',
        workspaceGridRows(current.height),
      );
    });
  }, []);

  const finishBottomPanelResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const resize = bottomPanelResize.current;
    if (resize) setBottomPanelHeight(resize.height);
    if (bottomResizeFrame.current !== null) {
      window.cancelAnimationFrame(bottomResizeFrame.current);
      bottomResizeFrame.current = null;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    cleanupBottomResize(bottomPanelResize);
  }, []);

  const beginHorizontalResize = useCallback(
    (kind: HorizontalDrag['kind'], event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const bounds = (
        kind === 'explorer' ? layoutElement.current : splitElement.current
      )?.getBoundingClientRect();
      if (!bounds) return;
      const maximum =
        kind === 'explorer'
          ? Math.min(explorerMaximumWidth, Math.floor(bounds.width * 0.4))
          : Math.max(
              previewMinimumWidth,
              bounds.width - editorMinimumWidth - previewSeparatorWidth,
            );
      horizontalDrag.current = {
        kind,
        pointerId: event.pointerId,
        width: kind === 'explorer' ? explorerWidth : (previewWidth ?? Math.floor(bounds.width / 2)),
        expanded: kind === 'explorer' ? explorerExpanded : previewExpanded,
        layout: previewExpanded ? previewLayout : defaultPreviewLayout,
        edge:
          kind === 'explorer'
            ? event.clientX - explorerWidth
            : event.clientX + shownPreviewWidth(previewRegionElement.current),
        maximum,
      };
      setHorizontalDragKind(kind);
      event.currentTarget.setPointerCapture(event.pointerId);
      document.body.classList.add('resizing-horizontal');
    },
    [explorerExpanded, explorerWidth, previewExpanded, previewLayout, previewWidth],
  );

  const resizeHorizontally = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = horizontalDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.kind === 'explorer') {
      const requested = Math.round(event.clientX - drag.edge);
      if (requested <= snapThreshold) {
        if (drag.expanded) {
          drag.expanded = false;
          setExplorerExpanded(false);
        }
        return;
      }
      drag.width = clamp(requested, explorerMinimumWidth, drag.maximum);
      if (!drag.expanded) {
        drag.expanded = true;
        setExplorerExpanded(true);
      }
    } else {
      const requested = Math.round(drag.edge - event.clientX);
      if (requested <= snapThreshold) {
        if (drag.expanded) {
          drag.expanded = false;
          changePreviewLayout('editor-only');
        }
        return;
      }
      drag.width = clamp(requested, previewMinimumWidth, drag.maximum);
      if (!drag.expanded) {
        drag.expanded = true;
        changePreviewLayout(drag.layout);
      }
    }
    if (horizontalResizeFrame.current !== null) return;
    horizontalResizeFrame.current = window.requestAnimationFrame(() => {
      horizontalResizeFrame.current = null;
      const current = horizontalDrag.current;
      if (!current) return;
      if (current.kind === 'explorer') {
        layoutElement.current?.style.setProperty(
          'grid-template-columns',
          explorerGridColumns(current.expanded, current.width),
        );
      } else {
        previewRegionElement.current?.style.setProperty(
          '--preview-side-width',
          `${current.width}px`,
        );
      }
    });
  }, []);

  const finishHorizontalResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = horizontalDrag.current;
    if (drag?.kind === 'explorer') setExplorerWidth(drag.width);
    else if (drag?.kind === 'preview') setPreviewWidth(drag.width);
    if (horizontalResizeFrame.current !== null) {
      window.cancelAnimationFrame(horizontalResizeFrame.current);
      horizontalResizeFrame.current = null;
    }
    finishCapturedPointer(event, horizontalDrag);
    setHorizontalDragKind(null);
  }, []);

  const exportMapTestReport = useCallback(async () => {
    if (!mapTestResults) return;
    try {
      const path = await window.rmside.exportMapTestReport(mapTestResults.reportJson);
      if (path) {
        appendOutput(
          outputNote('Map test', 'map-test.report-exported', {
            id: 'workbench.map-test.report-exported',
          }),
        );
      }
    } catch (error) {
      appendOutput(
        presentMessage({
          source: 'Map test',
          raw: errorMessage(error),
          fallbackHeadline: 'workbench.map-test.export-failed',
        }),
      );
    }
  }, [appendOutput, mapTestResults]);

  const previewExecutionRef = useRef(previewExecution);
  previewExecutionRef.current = previewExecution;
  const replayMapTestFinding = useCallback(
    async (findingId: string) => {
      if (!mapTestResults) return;
      const qualityCheck = isQualityReport(mapTestResults.report);
      const scriptDocument = mapTestResults.scriptUri
        ? workspace.documents.find((document) => document.uri === mapTestResults.scriptUri)
        : workspace.activeDocument;
      const scriptName = qualityCheck
        ? readablePathName(
            mapTestResults.report.findings.find((entry) => entry.findingId === findingId)
              ?.sourcePath ?? mapTestResults.report.script.name,
          )
        : readablePathName(mapTestResults.report.script.name);
      if (
        !scriptDocument ||
        (qualityCheck
          ? scriptDocument.name.toLowerCase() !== scriptName.toLowerCase()
          : !/\.rmstest$/iu.test(scriptDocument.name))
      ) {
        appendOutput(
          presentMessage({
            source: qualityCheck ? 'Quality check' : 'Map test',
            code: 'map-test.replay-needs-script',
            params: { script: scriptName },
          }),
        );
        return;
      }
      const shownMap = mapRef.current;
      const shownBefore: PreviewBeforeReplay = {
        map: shownMap,
        origin: shownMap ? previewMapOriginRef.current : 'generation',
        sourceText: shownMap
          ? (previewSourceContents.get(shownMap) ??
            workspace.documents.find((document) => document.uri === shownMap.documentUri)
              ?.content ??
            null)
          : null,
      };
      const sequence = replaySequence.current;
      workspace.setActiveDocument(scriptDocument.id);
      const replayInput = mapTestReplayInput({
        executionId: `map-test-replay-${crypto.randomUUID()}`,
        results: mapTestResults,
        script: scriptDocument,
        findingId,
      });
      const replayActivity = previewCandidates.activity === null ? replayInput.executionId : null;
      if (replayActivity !== null) {
        replayActivityRef.current = replayActivity;
        previewCandidates.begin(replayActivity, undefined, {
          kind: 'map-test',
          progressive: false,
          minimapPalette: replayInput.minimapPalette,
          texturePalette: replayInput.texturePalette ?? null,
        });
      }
      try {
        const result = await window.rmside.replayMapTestFinding(replayInput);
        if (replaySequence.current !== sequence) return;
        commitPreview(result, 'map-test');
        if (replayActivity !== null) previewCandidates.end(replayActivity);
        const replayedSeed = mapTestResults.report.findings.find(
          (entry) => entry.findingId === findingId,
        )?.seed;
        const runSeed = replayedRunSeed(mapTestResults.report, findingId);
        const execution = previewExecutionRef.current;
        const locked =
          runSeed !== null && execution?.settingsLoaded
            ? (execution.lockReplayedSeed?.(
                runSeed,
                replayedLobbySettings(mapTestResults.report, findingId),
                shownBefore,
              ) ?? null)
            : null;
        appendOutput(
          outputNote(
            'Map test',
            'map-test.replayed',
            runSeed !== null && locked?.temporaryName
              ? {
                  id: 'workbench.map-test.replayed-seed-locked-preset',
                  args: { seed: runSeed, name: locked.temporaryName },
                }
              : runSeed !== null && locked
                ? { id: 'workbench.map-test.replayed-seed-locked', args: { seed: runSeed } }
                : replayedSeed === undefined
                  ? { id: 'workbench.map-test.replayed' }
                  : { id: 'workbench.map-test.replayed-with-seed', args: { seed: replayedSeed } },
          ),
        );
      } catch (error) {
        if (replaySequence.current !== sequence) return;
        const failure = presentMapTestReplayFailure(errorMessage(error));
        if (!failureReportedByMain(failure, 'preview')) appendOutput(failure);
      } finally {
        if (replayActivity !== null) previewCandidates.end(replayActivity);
        if (replayActivityRef.current === replayActivity) replayActivityRef.current = null;
      }
    },
    [appendOutput, commitPreview, mapTestResults, previewCandidates, workspace],
  );

  const goToMapTestCheck = useCallback(
    (line: number, column: number) => {
      if (!mapTestResults) return;
      const scriptName = readablePathName(mapTestResults.report.script.name);
      const uri =
        mapTestResults.scriptUri ??
        workspace.documents.find(
          (document) => document.name.toLowerCase() === scriptName.toLowerCase(),
        )?.uri;
      if (!uri) {
        appendOutput(
          presentMessage({
            source: 'Map test',
            code: 'map-test.check-needs-script',
            params: { script: scriptName },
          }),
        );
        return;
      }
      void openSourceLocation(uri, Math.max(0, line - 1), Math.max(0, column - 1));
    },
    [appendOutput, mapTestResults, openSourceLocation, workspace.documents],
  );

  const renderedExplorerWidth =
    horizontalDrag.current?.kind === 'explorer' ? horizontalDrag.current.width : explorerWidth;
  const renderedPreviewWidth =
    horizontalDrag.current?.kind === 'preview' ? horizontalDrag.current.width : previewWidth;
  const shellStyle = {
    gridTemplateRows: workspaceGridRows(
      bottomPanelOpen ? bottomPanelHeight : bottomPanelNavigationHeight,
    ),
  } satisfies CSSProperties;
  const workspaceLayoutStyle = {
    gridTemplateColumns: explorerGridColumns(explorerExpanded, renderedExplorerWidth),
  } satisfies CSSProperties;
  const previewRegionStyle = {
    '--preview-side-width': renderedPreviewWidth === null ? '50%' : `${renderedPreviewWidth}px`,
  } as CSSProperties;

  return (
    <AppPanelContext.Provider value={panelContext}>
      <main
        className="app-shell"
        data-session-ready={workspace.sessionReady}
        ref={bindAppShell}
        style={shellStyle}
      >
        <header className="window-titlebar">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-expanded={explorerExpanded}
                  aria-label={t(
                    explorerExpanded ? 'workbench.explorer.collapse' : 'workbench.explorer.expand',
                  )}
                  className="sidebar-toggle"
                  onClick={() => setExplorerExpanded((current) => !current)}
                  size="icon-sm"
                  variant="ghost"
                />
              }
            >
              {explorerExpanded ? <PanelLeftClose /> : <PanelLeftOpen />}
            </TooltipTrigger>
            <TooltipContent>
              {t(
                explorerExpanded
                  ? 'workbench.explorer.collapse-tooltip'
                  : 'workbench.explorer.expand-tooltip',
              )}
            </TooltipContent>
          </Tooltip>
          <ApplicationMenuBar />
          <div aria-hidden="true" className="window-drag-region" />
        </header>

        <div
          className="workspace-layout"
          data-dragging={horizontalDragKind ?? ''}
          data-sidebar-expanded={explorerExpanded}
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes('Files')) event.preventDefault();
          }}
          onDrop={(event) => {
            event.preventDefault();
            const files = Array.from(event.dataTransfer.files);
            if (files.length > 0) void workspace.openDroppedFiles(files);
          }}
          ref={layoutElement}
          style={workspaceLayoutStyle}
        >
          <WorkspaceSidebar
            expanded={explorerExpanded}
            findInFilesRequest={findInFilesRequest}
            onGenerateDefinitionFile={openDefinitionFile}
            onOpenContentMatch={openContentSearchMatch}
            workspace={workspace}
          />
          {explorerExpanded || horizontalDragKind === 'explorer' ? (
            <div
              aria-label={t('workbench.explorer.resize')}
              aria-orientation="vertical"
              className="workspace-separator explorer-separator"
              onLostPointerCapture={finishHorizontalResize}
              onPointerCancel={finishHorizontalResize}
              onPointerDown={(event) => beginHorizontalResize('explorer', event)}
              onPointerMove={resizeHorizontally}
              onPointerUp={finishHorizontalResize}
              role="separator"
            >
              <SeparatorPill orientation="vertical" />
            </div>
          ) : null}
          <div className="workspace-main">
            <div
              className="workspace fixed-workspace"
              data-editor-shown={editorShown}
              data-layout-motion={layoutMotionReady ? 'on' : 'off'}
              data-preview-layout={editionCapabilities.preview ? previewLayout : 'editor-only'}
              data-preview-overlay={
                editionCapabilities.preview &&
                (previewLayout === 'behind-editor' || previewLayoutState.from === 'behind-editor')
              }
              data-testid="fixed-workspace"
              onTransitionEnd={(event) => {
                if (
                  event.target === event.currentTarget &&
                  event.propertyName === '--workspace-overlay'
                ) {
                  settlePreviewLayout();
                }
              }}
              ref={splitElement}
            >
              <div className="workspace-editor-region" data-pointer-surface="editor">
                <EditorPanel
                  inlayHints={inlayHints}
                  outlineRow={outlineRow}
                  executionFailureNotice={executionFailure.notice}
                  executionFailureSequence={executionFailure.raised}
                  onDismissExecutionFailureNotice={dismissExecutionFailureNotice}
                  onDismissRecoveryNotice={workspace.dismissRecoveryNotice}
                  appDeployNotice={appDeployNotice}
                  onDismissAppDeployNotice={dismissAppDeployNotice}
                  onCyclePreviewLayout={cyclePreviewLayout}
                  editorShown={editorShown}
                  onHideEditor={hideEditor}
                  onShowEditor={showEditor}
                  previewExpanded={previewExpanded}
                  previewLayout={previewLayout}
                  recoveryNotice={workspace.recoveryNotice}
                />
              </div>
              {editionCapabilities.preview &&
              (previewExpanded || horizontalDragKind === 'preview') ? (
                <div
                  aria-hidden={!editorShown || undefined}
                  aria-label={t('workbench.preview.resize')}
                  aria-orientation="vertical"
                  className="workspace-separator preview-separator"
                  onLostPointerCapture={finishHorizontalResize}
                  onPointerCancel={finishHorizontalResize}
                  onPointerDown={(event) => beginHorizontalResize('preview', event)}
                  onPointerMove={resizeHorizontally}
                  onPointerUp={finishHorizontalResize}
                  role="separator"
                >
                  <SeparatorPill orientation="vertical" />
                </div>
              ) : null}
              {editionCapabilities.preview ? (
                <div
                  aria-hidden={!previewExpanded}
                  className="workspace-preview-region"
                  data-expanded={previewExpanded}
                  data-layout={previewLayout}
                  data-layout-from={previewLayoutState.from}
                  data-pointer-surface="preview"
                  inert={!previewExpanded ? true : undefined}
                  ref={previewRegionElement}
                  style={previewRegionStyle}
                >
                  <PreviewPanel />
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <Tabs
          className="bottom-panel"
          data-collapsed={!bottomPanelOpen}
          value={bottomPanelPresence.mounted ? bottomPanelTab : ''}
        >
          <div
            aria-label={t(
              editionCapabilities.mapTests
                ? 'workbench.bottom-panel.label-with-test-results'
                : 'workbench.bottom-panel.label',
            )}
            className="bottom-panel-navigation"
            onClick={handleBottomPanelNavigationClick}
            role="group"
          >
            {bottomPanelOpen ? (
              <div
                aria-label={t('workbench.bottom-panel.resize')}
                aria-orientation="horizontal"
                className="bottom-panel-resize-handle"
                onLostPointerCapture={finishBottomPanelResize}
                onPointerCancel={finishBottomPanelResize}
                onPointerDown={beginBottomPanelResize}
                onPointerMove={resizeBottomPanel}
                onPointerUp={finishBottomPanelResize}
                role="separator"
              >
                <SeparatorPill orientation="horizontal" />
              </div>
            ) : null}
            <TabsList className="bottom-tabs" variant="line">
              <TabsTrigger onClick={() => selectBottomPanelTab('output')} value="output">
                {t('workbench.bottom-panel.tab.output', { count: outputMessageCount(outputLog) })}
              </TabsTrigger>
              <TabsTrigger onClick={() => selectBottomPanelTab('problems')} value="problems">
                {t('workbench.bottom-panel.tab.problems', { count: problemsTotal })}
              </TabsTrigger>
              {mapTestResults ? (
                <TabsTrigger
                  onClick={() => selectBottomPanelTab('test-results')}
                  value="test-results"
                >
                  {t('workbench.bottom-panel.tab.test-results', {
                    count: mapTestResults.report.findings.length,
                  })}
                </TabsTrigger>
              ) : null}
            </TabsList>
            {bottomPanelOpen && (bottomPanelTab === 'output' || bottomPanelTab === 'problems') ? (
              <div
                className="bottom-panel-filter"
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
              >
                {bottomPanelTab === 'output' ? (
                  <>
                    <SeverityFilterToggles
                      counts={outputSeverityCounts(outputLog)}
                      filter={outputSeverityFilter}
                      label={t('workbench.bottom-panel.output')}
                      onToggle={(severity) =>
                        setOutputSeverityFilter((current) => toggleSeverity(current, severity))
                      }
                    />
                    <Tooltip disableHoverablePopup>
                      <TooltipTrigger
                        delay={0}
                        render={
                          <Button
                            aria-label={t('output.clear')}
                            className="output-clear"
                            onClick={clearOutput}
                            size="xs"
                            variant="ghost"
                          />
                        }
                      >
                        <Trash2 aria-hidden="true" />
                      </TooltipTrigger>
                      <TooltipContent>{t('output.clear')}</TooltipContent>
                    </Tooltip>
                  </>
                ) : (
                  <SeverityFilterToggles
                    counts={problemSeverityCounts(problemFileGroups)}
                    filter={problemsSeverityFilter}
                    label={t('workbench.bottom-panel.problems')}
                    onToggle={(severity) =>
                      setProblemsSeverityFilter((current) => toggleSeverity(current, severity))
                    }
                  />
                )}
              </div>
            ) : null}
            <div className="native-restart-controls">
              {failedStatuses.map((status) => (
                <Tooltip key={status.name}>
                  <TooltipTrigger
                    render={
                      <Button
                        aria-label={t('workbench.native.restart-label', { name: status.name })}
                        disabled={restartingProcesses.has(status.name)}
                        onClick={(event) => {
                          event.stopPropagation();
                          void restart(status.name);
                        }}
                        size="icon-sm"
                        variant="ghost"
                      />
                    }
                  >
                    <RefreshCw
                      className={restartingProcesses.has(status.name) ? 'animate-spin' : ''}
                    />
                  </TooltipTrigger>
                  <TooltipContent>
                    {status.detail
                      ? inlineErrorText(status.detail)
                      : t('workbench.native.failed', { name: status.name })}
                  </TooltipContent>
                </Tooltip>
              ))}
            </div>
            <div
              className="bottom-panel-trailing-controls"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
            >
              {editionCapabilities.executionProfiler ? (
                <div className="output-profiler-host" ref={setOutputProfilerHost} />
              ) : null}
              {editionCapabilities.mcp ? (
                <McpStatusIndicator onOpenSettings={openMcpSettings} state={connectorState} />
              ) : null}
              {editionCapabilities.preview ? (
                <div className="output-version-host" ref={setOutputVersionHost} />
              ) : (
                <div className="output-version-host">
                  <EditorGameVersionSelect appendOutput={appendOutput} />
                </div>
              )}
              <UpdateHeaderControl controller={update.controller} />
            </div>
          </div>
          <TabsContent
            className="bottom-content problems-content"
            inert={bottomPanelPresence.closing || undefined}
            value="problems"
          >
            <ProblemsPanel
              filter={problemsSeverityFilter}
              groups={problemFileGroups}
              onNavigate={openProblem}
            />
          </TabsContent>
          <TabsContent
            className="bottom-content output-content"
            inert={bottomPanelPresence.closing || undefined}
            value="output"
          >
            <UpdateProvider value={update.controller}>
              <OutputPanel
                filter={outputSeverityFilter}
                onNavigateOperation={openOutputOperation}
                onToggleGroup={toggleOutputRun}
                state={outputLog}
              />
            </UpdateProvider>
          </TabsContent>
          <TabsContent
            className="bottom-content test-results-content"
            inert={bottomPanelPresence.closing || undefined}
            value="test-results"
          >
            {mapTestResults ? (
              <MapTestResultsPanel
                onExport={() => void exportMapTestReport()}
                onGoToCheck={goToMapTestCheck}
                onReplay={(findingId) => void replayMapTestFinding(findingId)}
                origin={mapTestResultsOrigin}
                progress={mapTestProgress}
                results={mapTestResults}
              />
            ) : null}
          </TabsContent>
        </Tabs>
        <WorkspaceDialog
          answer={workspace.answerConfirmation}
          confirmation={workspace.confirmation}
        />
        <LanguageSettingsDialog
          onOpenChange={setLanguageSettingsOpen}
          open={languageSettingsOpen}
        />
        <ThemeSettingsDialog
          editorColorScheme={editorColorScheme}
          onEditorColorSchemeChange={setEditorColorScheme}
          onPreviewBlurChange={setPreviewBlur}
          previewBlur={previewBlur}
          onOpenChange={setThemeSettingsOpen}
          onThemePreferenceChange={setThemePreference}
          open={themeSettingsOpen}
          themePreference={themePreference}
        />
        {definitionFilesAvailable(editionCapabilities) ? (
          <DefinitionFileDialog
            onClose={() => setDefinitionFileRequest(null)}
            onFailure={appendOutput}
            onWritten={(path) => void workspace.openGeneratedFile(path)}
            request={definitionFileRequest}
          />
        ) : null}
        {editionCapabilities.installedSourceBrowser ? (
          <InstalledSourceBrowser
            appendOutput={appendOutput}
            onOpenChange={setInstalledSourceBrowserOpen}
            onOriginFilterChange={setInstalledSourceOriginFilter}
            open={installedSourceBrowserOpen}
            originFilter={installedSourceOriginFilter}
            workspace={workspace}
          />
        ) : null}
        {editionCapabilities.deployment ? (
          <ManagedModDeploymentPanel
            onOpenChange={(next) => {
              setManagedModDeploymentOpen(next);
              if (!next) setManagedModDeploymentSourceId(null);
            }}
            open={managedModDeploymentOpen}
            requestedSourceId={managedModDeploymentSourceId}
          />
        ) : null}
        {editionCapabilities.mcp ? (
          <>
            <McpSettingsDialog
              onOpenChange={setMcpSettingsOpen}
              onStateChange={setConnectorState}
              open={mcpSettingsOpen}
              state={connectorState}
            />
            <McpPrompts state={connectorState} />
          </>
        ) : null}
        {editionCapabilities.releaseCheck ? (
          <UpdateDialog
            aiAppsConnected={connectorAppsConnected(connectorState)}
            controller={update.controller}
            onOpenChange={update.setDialogOpen}
            open={update.dialogOpen}
          />
        ) : null}
        <AppTour
          onEditorCard={showTourEditorTab}
          previewReady={map !== null && previewMapOrigin === 'generation'}
          ready={layoutMotionReady}
          restartRequest={tourRestartRequest}
          runActive={
            generationActivityKind !== null ||
            (previewExecution !== null && previewExecution.executionState.phase !== 'idle')
          }
          targets={{
            explorer: explorerExpanded ? 'shown' : 'absent',
            editor: editorShown ? 'shown' : 'hidden',
            run: 'shown',
            preview: previewExpanded ? 'shown' : 'absent',
            output: 'shown',
          }}
        />
      </main>
    </AppPanelContext.Provider>
  );
}

function paneFocusTarget(pane: HTMLElement): HTMLElement | null {
  const preferred = [
    '[role="tree"] [role="treeitem"][tabindex="0"]',
    '.monaco-editor [role="textbox"]',
    '.preview-canvas > canvas',
    '[role="tab"][aria-selected="true"]',
    '[role="tab"]',
  ];
  for (const selector of preferred) {
    const element = pane.querySelector<HTMLElement>(selector);
    if (element && element.getClientRects().length > 0) return element;
  }
  return (
    Array.from(
      pane.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]:not([disabled])',
      ),
    ).find((element) => element.getClientRects().length > 0 && !element.closest('[inert]')) ?? null
  );
}

function isLanguageServerDiagnostic(value: unknown): value is LanguageServerDiagnostic {
  if (!value || typeof value !== 'object') return false;
  const diagnostic = value as Partial<LanguageServerDiagnostic>;
  return (
    typeof diagnostic.message === 'string' &&
    typeof diagnostic.range?.start?.line === 'number' &&
    typeof diagnostic.range.start.character === 'number' &&
    typeof diagnostic.range.end?.line === 'number' &&
    typeof diagnostic.range.end.character === 'number'
  );
}

function sortFailedStatuses(statuses: NativeProcessStatus[]): NativeProcessStatus[] {
  const order: Record<NativeProcessName, number> = {
    rmsd: 0,
    'rms-ls': 1,
    'rms-test': 2,
    'rms-test-lsp': 3,
  };
  return statuses
    .filter((status) => status.state === 'failed')
    .sort((left, right) => order[left.name] - order[right.name]);
}

function finishCapturedPointer(
  event: ReactPointerEvent<HTMLDivElement>,
  drag: MutableRefObject<HorizontalDrag | null>,
): void {
  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
    event.currentTarget.releasePointerCapture(event.pointerId);
  }
  cleanupHorizontalDrag(drag);
}

function cleanupHorizontalDrag(drag: MutableRefObject<HorizontalDrag | null>): void {
  drag.current = null;
  document.body.classList.remove('resizing-horizontal');
}

function cleanupBottomResize(resize: MutableRefObject<BottomPanelResize | null>): void {
  resize.current = null;
  document.body.classList.remove('resizing-bottom-panel');
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function shownPreviewWidth(region: HTMLElement | null): number {
  if (!region) return 0;
  const margin = Number.parseFloat(getComputedStyle(region).marginInlineStart) || 0;
  return Math.max(0, region.getBoundingClientRect().width + margin);
}

function workspaceGridRows(bottomHeight: number): string {
  return `40px minmax(0, 1fr) ${bottomHeight}px`;
}

function explorerGridColumns(expanded: boolean, width: number): string {
  return expanded ? `${width}px 5px minmax(0, 1fr)` : '0 0 minmax(0, 1fr)';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function utf16OffsetForPosition(content: string, line: number, character: number): number {
  let offset = 0;
  for (let current = 0; current < line; current += 1) {
    const next = content.indexOf('\n', offset);
    if (next < 0) return content.length;
    offset = next + 1;
  }
  const lineEnd = content.indexOf('\n', offset);
  const end = lineEnd < 0 ? content.length : lineEnd;
  return Math.min(offset + Math.max(0, character), end);
}
