import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
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
  ApplicationMenuName,
  ApplicationMenuTriggerBounds,
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
import { AppPanelContext, type MapTestResultsState, type SourceSelection } from './app-context';
import { mapTestReplayInput } from './map-test-replay';
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
import {
  outputSeverityFilterDefault,
  problemsSeverityFilterDefault,
  toggleSeverity,
  type SeverityFilter,
} from './severity-filter';
import { SeverityFilterToggles } from './severity-filter-toggles';
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
import {
  noSourceHighlightOperations,
  operationsIntersectingByteRanges,
  sameSourceHighlightRequest,
  type SourceHighlightRequest,
} from './source-highlight';
import { useKeyboardNavigationFocus } from './keyboard-focus';
import { nextPaneIndex } from './keyboard-navigation';
import { navigateToPreviewOperation } from './source-navigation';
import { resolveTheme, type ThemePreference } from './theme';
import { useWorkspaceController } from './workspace-controller';
import { WorkspaceDialog } from './workspace-dialog';
import { LanguageSettingsDialog } from './language-settings-dialog';
import { DefinitionFileDialog, type DefinitionFileRequest } from './definition-file-dialog';
import { useI18n } from './i18n';
import type { MessageId } from '../shared/i18n/translator';
import { WorkspaceSidebar } from './workspace-sidebar';

const bottomPanelNavigationHeight = 34;
const explorerDefaultWidth = 248;
const explorerMinimumWidth = 220;
const explorerMaximumWidth = 420;
const editorMinimumWidth = 360;
const previewMinimumWidth = 300;
const snapThreshold = 96;
const keyboardResizeStep = 16;

const applicationMenus: { name: ApplicationMenuName; label: MessageId; accessKey: string }[] = [
  { name: 'file', label: 'app-menu.file.name', accessKey: 'f' },
  { name: 'edit', label: 'app-menu.edit.name', accessKey: 'e' },
  { name: 'view', label: 'app-menu.view.name', accessKey: 'v' },
  { name: 'help', label: 'app-menu.help.name', accessKey: 'h' },
];
type BottomPanelTab = 'problems' | 'output' | 'test-results';
type HorizontalDrag = {
  kind: 'explorer' | 'preview';
  pointerId: number;
  width: number;
  expanded: boolean;
  edge: number;
  maximum: number;
  handle: HTMLDivElement;
};
type BottomPanelResize = {
  pointerId: number;
  startHeight: number;
  startY: number;
  height: number;
  handle: HTMLDivElement;
};

export function App() {
  const [map, setMap] = useState<PreviewGenerationResult | null>(null);
  const mapRef = useRef(map);
  mapRef.current = map;
  const [previewMapOrigin, setPreviewMapOrigin] = useState<PreviewMapOrigin>('generation');
  const [executionFailure, setExecutionFailure] = useState<{
    raised: number;
    notice: ExecutionFailureNoticeContent | null;
  }>({ raised: 0, notice: null });
  const [previewExecution, setPreviewExecution] = useState<PreviewExecutionController | null>(null);
  const [pinnedPreviewSource, setPinnedPreviewSource] = useState<PinnedPreviewSource | null>(null);
  const [selection, setSelection] = useState<SourceSelection | null>(null);
  const [sourceHighlightRequest, setSourceHighlightRequest] =
    useState<SourceHighlightRequest | null>(null);
  const [editorPointerInside, setEditorPointerInside] = useState(false);
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
  const [bottomPanelOpen, setBottomPanelOpen] = useState(false);
  const [bottomPanelHeight, setBottomPanelHeight] = useState(150);
  const bottomPanelPresence = usePresence(bottomPanelOpen);
  const bottomPanelPresenceRef = bottomPanelPresence.ref;
  const [bottomPanelTab, setBottomPanelTab] = useState<BottomPanelTab>('output');
  const [explorerExpanded, setExplorerExpanded] = useState(true);
  const [explorerWidth, setExplorerWidth] = useState(explorerDefaultWidth);
  const [previewExpanded, setPreviewExpanded] = useState(true);
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
  const expandPreview = useCallback(() => setPreviewExpanded(true), []);
  const [previewWidth, setPreviewWidth] = useState<number | null>(null);
  const [horizontalDragKind, setHorizontalDragKind] = useState<HorizontalDrag['kind'] | null>(null);
  const [sessionApplied, setSessionApplied] = useState(false);
  const [systemIsDark, setSystemIsDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  const [themePreference, setThemePreference] = useState<ThemePreference>('system');
  const [formatOnSave, setFormatOnSave] = useState(true);
  const [indentConditionals, setIndentConditionals] = useState(true);
  const [liveGenerationStages, setLiveGenerationStages] = useState(true);
  const [gpuMapRendering, setGpuMapRendering] = useState(true);
  const [inlayHints, setInlayHints] = useState(true);
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
  const [definitionFileRequest, setDefinitionFileRequest] = useState<DefinitionFileRequest | null>(
    null,
  );
  const definitionFileRequestKey = useRef(0);
  const openDefinitionFile = useCallback((folderId: string | null) => {
    if (!definitionFilesAvailable(editionCapabilities)) return;
    definitionFileRequestKey.current += 1;
    setDefinitionFileRequest({ key: definitionFileRequestKey.current, folderId });
  }, []);
  const { state: localeState, t } = useI18n();
  const [managedModDeploymentOpen, setManagedModDeploymentOpen] = useState(false);
  const [managedModDeploymentSourceId, setManagedModDeploymentSourceId] = useState<string | null>(
    null,
  );
  const resolvedTheme = resolveTheme(themePreference, systemIsDark);
  const horizontalDrag = useRef<HorizontalDrag | null>(null);
  const bottomPanelResize = useRef<BottomPanelResize | null>(null);
  const horizontalResizeFrame = useRef<number | null>(null);
  const bottomResizeFrame = useRef<number | null>(null);
  const applicationMenuElement = useRef<HTMLElement>(null);
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
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
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
      problemGroups([...languageDiagnostics, ...mapTestDiagnostics], {
        isProtected: (uri) => isStandardGameSource(uri, readOnlySourceKeys),
      }),
    [languageDiagnostics, mapTestDiagnostics, readOnlySourceKeys],
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
            sourceHighlightRequest.byteRanges,
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
  const highlightedPreviewOperationIndices = editorPointerInside
    ? sourceHighlightOperationIndices
    : noSourceHighlightOperations;

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
        if (resultsTabAppearing) {
          setBottomPanelOpen(true);
          setBottomPanelTab('test-results');
        }
      } else {
        setMapTestResultsOrigin(result.status === 'cancelled' ? 'after-stop' : 'after-error');
      }
      if (result.preview) commitPreview(result.preview, 'map-test');
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
      previewMapOrigin,
      mapTestPreviewShown: mapTestPreview,
      settleRunOutcome,
      appendOutput,
      settleOutputRun,
      mapTestResults,
      clearMapTestResults,
      publishMapTestResult,
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
      executionProfiler,
      previewCandidates,
      liveGenerationStages,
      gpuMapRendering,
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
      commitPreview,
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
      selectPreviewOperation,
      selection,
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
    setPreviewExpanded(true);
    setPreviewWidth(null);
    setProfilerOpen(false);
    setBottomPanelOpen(false);
    setBottomPanelHeight(150);
    setBottomPanelTab('output');
    await window.rmside.resetLayout();
  }, []);

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
    setFormatOnSave(session.formatOnSave);
    setIndentConditionals(session.indentConditionals);
    setLiveGenerationStages(session.liveGenerationStages);
    setGpuMapRendering(session.gpuMapRendering);
    setInlayHints(session.inlayHints);
    setDeletePermanently(session.deletePermanently);
    setPreviewPerspective(session.previewPerspective);
    setPreviewLook(session.previewLook);
    setPreviewTileGrid(session.previewTileGrid);
    setPreviewSmallTrees(session.previewSmallTrees);
    setExplorerExpanded(session.layout.explorerExpanded);
    setExplorerWidth(session.layout.explorerWidth);
    setPreviewExpanded(session.layout.previewExpanded);
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
        formatOnSave,
        indentConditionals,
        liveGenerationStages,
        gpuMapRendering,
        inlayHints,
        deletePermanently,
        previewPerspective,
        previewLook,
        previewTileGrid,
        previewSmallTrees,
        layout: {
          explorerExpanded,
          explorerWidth,
          previewExpanded,
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
    explorerExpanded,
    explorerWidth,
    formatOnSave,
    indentConditionals,
    liveGenerationStages,
    gpuMapRendering,
    inlayHints,
    deletePermanently,
    previewPerspective,
    previewLook,
    previewTileGrid,
    previewSmallTrees,
    previewExpanded,
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
    const menuElement = applicationMenuElement.current;
    if (!menuElement) return undefined;
    const syncBounds = () => {
      const bounds = Array.from(
        menuElement.querySelectorAll<HTMLButtonElement>('[data-application-menu]'),
      ).map((element) => {
        const rectangle = element.getBoundingClientRect();
        return {
          name: element.dataset.applicationMenu as ApplicationMenuName,
          x: rectangle.left,
          y: rectangle.top,
          width: rectangle.width,
          height: rectangle.height,
        } satisfies ApplicationMenuTriggerBounds;
      });
      if (bounds.length === applicationMenus.length)
        void window.rmside.syncApplicationMenuBounds(bounds);
    };
    const observer = new ResizeObserver(syncBounds);
    observer.observe(menuElement);
    window.addEventListener('resize', syncBounds);
    syncBounds();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', syncBounds);
    };
  }, [localeState.locale]);

  useEffect(() => {
    const runMenuAction = (action: ApplicationMenuAction) => {
      const currentWorkspace = workspaceRef.current;
      if (action.type === 'undo' || action.type === 'redo') runEditorHistoryCommand(action.type);
      else if (action.type === 'set-theme') setThemePreference(action.theme);
      else if (action.type === 'open-language-settings') setLanguageSettingsOpen(true);
      else if (action.type === 'reset-layout') void resetLayout();
      else if (action.type === 'new-file') currentWorkspace.newFile();
      else if (action.type === 'new-map-test-script') currentWorkspace.newMapTestScript();
      else if (action.type === 'generate-definition-file') openDefinitionFile(null);
      else if (action.type === 'new-xs-script') currentWorkspace.newXsScript();
      else if (action.type === 'open-file') void currentWorkspace.pickFiles();
      else if (action.type === 'open-folder') void currentWorkspace.pickFolder();
      else if (action.type === 'browse-installed-sources') openInstalledSources();
      else if (action.type === 'deploy-managed-mod') openManagedModDeployment(null);
      else if (action.type === 'import-map-test-report') void importMapTestReport();
      else if (action.type === 'unlink-game-folder') void unlinkSelectedGameInstallation();
      else if (action.type === 'open-recent') void currentWorkspace.openRecent(action.path);
      else if (action.type === 'save') void currentWorkspace.saveActive();
      else if (action.type === 'save-as') void currentWorkspace.saveActiveAs();
      else if (action.type === 'format-document') void currentWorkspace.formatActive();
      else if (action.type === 'set-format-on-save') {
        setFormatOnSave(action.enabled);
      } else if (action.type === 'set-indent-conditionals') {
        setIndentConditionals(action.enabled);
      } else if (action.type === 'set-gpu-map-rendering') {
        setGpuMapRendering(action.enabled);
      } else if (action.type === 'set-inlay-hints') {
        setInlayHints(action.enabled);
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
      } else if (action.type === 'close-tab') void currentWorkspace.closeActive();
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
    return () => {
      cancelled = true;
      unsubscribe();
      unsubscribeDiagnostic();
    };
  }, [appendOutput]);

  useEffect(
    () =>
      window.rmside.onLanguageServerEvent((event) => {
        if (event.method !== 'textDocument/publishDiagnostics') return;
        const params = event.params as { uri?: unknown; diagnostics?: unknown };
        if (typeof params?.uri !== 'string' || !Array.isArray(params.diagnostics)) return;
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

  const focusBeforeApplicationMenu = useRef<HTMLElement | null>(null);
  const applicationMenuKeyboardFocus = useKeyboardNavigationFocus();
  useEffect(() => {
    const remember = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && !target.closest('.application-menu')) {
        focusBeforeApplicationMenu.current = target;
      }
    };
    document.addEventListener('focusin', remember, true);
    return () => document.removeEventListener('focusin', remember, true);
  }, []);
  const openApplicationMenu = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>, name: ApplicationMenuName) => {
      const trigger = event.currentTarget;
      const bounds = trigger.getBoundingClientRect();
      if (document.activeElement === trigger) {
        const previous = focusBeforeApplicationMenu.current;
        if (previous?.isConnected) previous.focus({ focusVisible: false, preventScroll: true });
        else trigger.blur();
      }
      void window.rmside.openApplicationMenu(name, bounds.left, bounds.bottom);
    },
    [],
  );

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
        handle: event.currentTarget,
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
      current.handle.setAttribute('aria-valuenow', String(current.height));
    });
  }, []);

  const resizeBottomPanelWithKeyboard = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    event.stopPropagation();
    const maximumHeight = Math.max(180, Math.floor(window.innerHeight * 0.65));
    setBottomPanelHeight((current) =>
      clamp(
        current + (event.key === 'ArrowUp' ? keyboardResizeStep : -keyboardResizeStep),
        96,
        maximumHeight,
      ),
    );
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
          : Math.max(previewMinimumWidth, bounds.width - editorMinimumWidth - 5);
      horizontalDrag.current = {
        kind,
        pointerId: event.pointerId,
        width: kind === 'explorer' ? explorerWidth : (previewWidth ?? Math.floor(bounds.width / 2)),
        expanded: kind === 'explorer' ? explorerExpanded : previewExpanded,
        edge: kind === 'explorer' ? bounds.left : bounds.right,
        maximum,
        handle: event.currentTarget,
      };
      setHorizontalDragKind(kind);
      event.currentTarget.setPointerCapture(event.pointerId);
      document.body.classList.add('resizing-horizontal');
    },
    [explorerExpanded, explorerWidth, previewExpanded, previewWidth],
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
          setPreviewExpanded(false);
        }
        return;
      }
      drag.width = clamp(requested, previewMinimumWidth, drag.maximum);
      if (!drag.expanded) {
        drag.expanded = true;
        setPreviewExpanded(true);
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
          'flex-basis',
          current.expanded ? `${current.width}px` : '0px',
        );
      }
      current.handle.setAttribute('aria-valuenow', String(current.width));
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

  const resizePaneWithKeyboard = useCallback(
    (kind: HorizontalDrag['kind'], event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      if (kind === 'explorer') {
        const bounds = layoutElement.current?.getBoundingClientRect();
        const maximum = Math.min(
          explorerMaximumWidth,
          Math.floor((bounds?.width ?? explorerMaximumWidth) * 0.4),
        );
        setExplorerWidth((current) =>
          clamp(
            current + (event.key === 'ArrowRight' ? keyboardResizeStep : -keyboardResizeStep),
            explorerMinimumWidth,
            maximum,
          ),
        );
      } else {
        const bounds = splitElement.current?.getBoundingClientRect();
        const maximum = Math.max(
          previewMinimumWidth,
          (bounds?.width ?? 960) - editorMinimumWidth - 5,
        );
        const current = previewWidth ?? Math.floor((bounds?.width ?? 960) / 2);
        setPreviewWidth(
          clamp(
            current + (event.key === 'ArrowLeft' ? keyboardResizeStep : -keyboardResizeStep),
            previewMinimumWidth,
            maximum,
          ),
        );
      }
    },
    [previewWidth],
  );

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

  const replayMapTestFinding = useCallback(
    async (findingId: string) => {
      if (!mapTestResults) return;
      const scriptDocument = mapTestResults.scriptUri
        ? workspace.documents.find((document) => document.uri === mapTestResults.scriptUri)
        : workspace.activeDocument;
      if (!scriptDocument || !/\.rmstest$/iu.test(scriptDocument.name)) {
        appendOutput(
          presentMessage({
            source: 'Map test',
            code: 'map-test.replay-needs-script',
            params: { script: readablePathName(mapTestResults.report.script.name) },
          }),
        );
        return;
      }
      workspace.setActiveDocument(scriptDocument.id);
      try {
        const result = await window.rmside.replayMapTestFinding(
          mapTestReplayInput({
            executionId: `map-test-replay-${crypto.randomUUID()}`,
            results: mapTestResults,
            script: scriptDocument,
            findingId,
          }),
        );
        commitPreview(result, 'map-test');
        const replayedSeed = mapTestResults.report.findings.find(
          (entry) => entry.findingId === findingId,
        )?.seed;
        appendOutput(
          outputNote(
            'Map test',
            'map-test.replayed',
            replayedSeed === undefined
              ? { id: 'workbench.map-test.replayed' }
              : { id: 'workbench.map-test.replayed-with-seed', args: { seed: replayedSeed } },
          ),
        );
      } catch (error) {
        const failure = presentMapTestReplayFailure(errorMessage(error));
        if (!failureReportedByMain(failure, 'preview')) appendOutput(failure);
      }
    },
    [appendOutput, commitPreview, mapTestResults, workspace],
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

  const explorerMaximum = Math.min(
    explorerMaximumWidth,
    Math.floor((layoutElement.current?.clientWidth ?? 1440) * 0.4),
  );
  const previewMaximum = Math.max(
    previewMinimumWidth,
    (splitElement.current?.clientWidth ?? 960) - editorMinimumWidth - 5,
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
    flexBasis: previewExpanded
      ? renderedPreviewWidth === null
        ? '50%'
        : `${renderedPreviewWidth}px`
      : '0px',
    maxWidth: `calc(100% - ${editorMinimumWidth + 5}px)`,
  } satisfies CSSProperties;

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
          <nav
            aria-label={t('workbench.application-menu.label')}
            className="application-menu"
            ref={applicationMenuElement}
          >
            {applicationMenus.map((menu) => (
              <Button
                accessKey={menu.accessKey}
                aria-haspopup="menu"
                className="application-menu-trigger"
                data-application-menu={menu.name}
                key={menu.name}
                onBlur={applicationMenuKeyboardFocus.onBlur}
                onClick={(event) => openApplicationMenu(event, menu.name)}
                onFocus={applicationMenuKeyboardFocus.onFocus}
                onMouseDown={(event) => event.preventDefault()}
                size="sm"
                variant="ghost"
              >
                {t(menu.label)}
              </Button>
            ))}
          </nav>
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
            onGenerateDefinitionFile={openDefinitionFile}
            workspace={workspace}
          />
          {explorerExpanded || horizontalDragKind === 'explorer' ? (
            <div
              aria-label={t('workbench.explorer.resize')}
              aria-orientation="vertical"
              aria-valuemax={explorerMaximum}
              aria-valuemin={explorerMinimumWidth}
              aria-valuenow={renderedExplorerWidth}
              className="workspace-separator explorer-separator"
              onKeyDown={(event) => resizePaneWithKeyboard('explorer', event)}
              onLostPointerCapture={finishHorizontalResize}
              onPointerCancel={finishHorizontalResize}
              onPointerDown={(event) => beginHorizontalResize('explorer', event)}
              onPointerMove={resizeHorizontally}
              onPointerUp={finishHorizontalResize}
              role="separator"
              tabIndex={0}
            />
          ) : null}
          <div className="workspace-main">
            <div
              className="workspace fixed-workspace"
              data-testid="fixed-workspace"
              ref={splitElement}
            >
              <div className="workspace-editor-region">
                <EditorPanel
                  inlayHints={inlayHints}
                  executionFailureNotice={executionFailure.notice}
                  executionFailureSequence={executionFailure.raised}
                  onDismissExecutionFailureNotice={dismissExecutionFailureNotice}
                  onDismissRecoveryNotice={workspace.dismissRecoveryNotice}
                  onTogglePreview={() => setPreviewExpanded((current) => !current)}
                  previewExpanded={previewExpanded}
                  recoveryNotice={workspace.recoveryNotice}
                />
              </div>
              {editionCapabilities.preview &&
              (previewExpanded || horizontalDragKind === 'preview') ? (
                <div
                  aria-label={t('workbench.preview.resize')}
                  aria-orientation="vertical"
                  aria-valuemax={previewMaximum}
                  aria-valuemin={previewMinimumWidth}
                  aria-valuenow={
                    renderedPreviewWidth ??
                    Math.floor((splitElement.current?.clientWidth ?? 960) / 2)
                  }
                  className="workspace-separator preview-separator"
                  onKeyDown={(event) => resizePaneWithKeyboard('preview', event)}
                  onLostPointerCapture={finishHorizontalResize}
                  onPointerCancel={finishHorizontalResize}
                  onPointerDown={(event) => beginHorizontalResize('preview', event)}
                  onPointerMove={resizeHorizontally}
                  onPointerUp={finishHorizontalResize}
                  role="separator"
                  tabIndex={0}
                />
              ) : null}
              {editionCapabilities.preview ? (
                <div
                  aria-hidden={!previewExpanded}
                  className="workspace-preview-region"
                  data-expanded={previewExpanded}
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
                aria-valuemax={Math.floor(window.innerHeight * 0.65)}
                aria-valuemin={96}
                aria-valuenow={bottomPanelHeight}
                className="bottom-panel-resize-handle"
                onKeyDown={resizeBottomPanelWithKeyboard}
                onLostPointerCapture={finishBottomPanelResize}
                onPointerCancel={finishBottomPanelResize}
                onPointerDown={beginBottomPanelResize}
                onPointerMove={resizeBottomPanel}
                onPointerUp={finishBottomPanelResize}
                role="separator"
                tabIndex={0}
              />
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
              {editionCapabilities.preview ? (
                <div className="output-version-host" ref={setOutputVersionHost} />
              ) : (
                <div className="output-version-host">
                  <EditorGameVersionSelect appendOutput={appendOutput} />
                </div>
              )}
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
              onNavigate={(target, location) => void navigateToProblem(target, location)}
            />
          </TabsContent>
          <TabsContent
            className="bottom-content output-content"
            inert={bottomPanelPresence.closing || undefined}
            value="output"
          >
            <OutputPanel
              filter={outputSeverityFilter}
              onNavigateOperation={openOutputOperation}
              onToggleGroup={toggleOutputRun}
              state={outputLog}
            />
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
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]',
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
