import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MenuIcon } from '@animateicons/react/lucide';
import { Bot, Check, Pencil, Plus, SlidersHorizontal, Trash2, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { IconToggleButton } from '@/components/ui/toggle-button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { externalLinkUrls } from '../shared/api';
import type {
  ConfigurationCatalog,
  ControlLiveSynchronizationRequest,
  ControlLauncherStatus,
  ControlSessionStatus,
  DevelopmentFixtureDescriptor,
  GenerationCertification,
  InstallationReport,
  LanguageServerPreviewContext,
  MapTestRunInput,
  PreviewGenerationInput,
  PreviewGenerationEvent,
  PreviewGenerationResult,
  PreviewVersionOrigin,
  RootExecutionState,
  StandardIncludeAccess,
} from '../shared/api';
import { gameModeModifierOptions, type LobbyOptionFlag } from '../shared/lobby-options';
import {
  isMapTestScriptName,
  isMapTestWorkerSetting,
  type MapTestWorkerSetting,
} from '../shared/map-test-contract';
import {
  generationResultWords,
  locateDocumentLine,
  presentMessage,
  type SourceLocator,
} from '../shared/message-catalog';
import { uncertifiedConstructKey } from '../shared/construct-verification';
import {
  constructVerificationMessage,
  outputRunConstructs,
} from './construct-verification-message';
import type { MessageId } from '../shared/i18n/translator';
import { outputNote, type OutputMessage, type OutputText } from '../shared/output-message';
import { isPreviewGenerationCancellation } from '../shared/preview-generation-settlement';
import { useAnimatedIconHover } from './animated-icon';
import { useAppPanelContext } from './app-context';
import { useI18n } from './i18n';
import {
  automaticGenerationAction,
  automaticGenerationIdentity,
  automaticRunApplies,
} from './automatic-generation';
import {
  controlPresentation,
  initialLiveOutputGate,
  liveFailureMessage,
  liveOutputGate,
  liveWorkflowMessage,
  matchSeedAvailability,
  unverifiedLiveGameMessage,
  workflowEventFromControl,
  workflowEventFromLive,
  unverifiedLiveGameVersion,
  type LiveWorkflowEvent,
} from './control-presentation';
import { buildControlLiveRequest, controlAcceptsLiveSetup } from './control-live-request';
import { liveControlAction } from './live-control-action';
import {
  idleLiveTestProgress,
  nextLiveTestProgress,
  type LiveTestProgressInput,
} from './live-test-progress';
import { LiveTestProgressBar } from './live-test-progress-bar';
import { MapTestProgressBar } from './map-test-progress-bar';
import { mapTestProgressivePreview } from './map-test-preview';
import {
  discoverGameInstallation,
  isUsableInstallation,
  onGameInstallationChanged,
  pickGameInstallation,
  refusedGameFolderMessage,
} from './game-installation';
import {
  LivePreviewCancellationError,
  LivePreviewCoordinator,
  LivePreviewSourceChangedError,
  type LivePreviewAnalysis,
  type LivePreviewJob,
  type LivePreviewStatus,
} from './live-preview';
import * as latencyProbe from './latency-probe';
import { markCachedPreview } from './execution-profiler';
import {
  forgetActiveMatchReplacement,
  hasAcceptedActiveMatchReplacement,
  rememberActiveMatchReplacement,
} from './live-test-preferences';
import {
  canonicalLanguageDocumentUri,
  notifyLanguageContextChanged,
  waitForRmsLanguageDocument,
} from './monaco-language';
import {
  availableCivilizationIds,
  packedCivilizationOptions,
  type PackedCivilizationOption,
} from './packed-game-options';
import { BoundedPreviewLru, type PreviewCacheDiagnostics } from './preview-cache';
import { previewResultBytes } from './preview-result-bytes';
import { remapEquivalentPreviewResult, remapHistoricalPreviewResult } from './preview-provenance';
import { SelectGameFolderItem } from './select-game-folder-button';
import {
  classifyMapTestRejection,
  failureReportedByMain,
  runFailureMessage,
  runOutcomeEffects,
  type RunOutcome,
  type RunTrigger,
} from './run-outcome';
import type { OutputRunHeader, OutputRunResult } from './output-log';
import { assertStreamMatchesResult } from './preview-reconstruction';
import {
  isPreviewScriptName,
  isPreviewSourceChangedError,
  runnableDocumentBlockingReason,
  type PinnedPreviewSource,
  type PreviewRunState,
  type PreviewSourceRunAcceptance,
  type ReusableCommittedPreview,
} from './preview-execution';
import {
  activeGameModeModifiers,
  buildPreviewGenerationInput,
  defaultRunPresetName,
  effectiveProfileSelection,
  generatedResultLabel,
  generationCertificationLabel,
  generationSettingsKey,
  installationSelectionKey,
  isStandardIncludeUnavailableMessage,
  isVerifiedLocalProductVersion,
  languageServerPreviewContext,
  localProductVersionLabel,
  localizeAutomaticPresetNames,
  nextRunPresetName,
  livePreviewEditDebounceMilliseconds,
  profileGameVersion,
  profileSelectionChange,
  profilesNewestFirst,
  randomSeed,
  readStoredRunConfiguration,
  resolvePreviewContentPack,
  resolvePreviewProfile,
  runGameModeOptions,
  runMapSizeOptions,
  runPlayerColorOptions,
  runPositionPolicyOptions,
  runPreset,
  runStartingAgeOptions,
  runStartingResourceOptions,
  samePreviewContext,
  standardIncludeRecovery,
  validateRunConfiguration,
  withGameModeModifier,
  withLiveComputerPlayers,
  withMapSize,
  withRandomMapTurbo,
  withPlayerCount,
  withSeed,
  writeStoredRunConfiguration,
  type RunConfiguration,
  type RunPreset,
  type StoredRunConfiguration,
  randomCivilizationResolutions,
} from './run-configuration';

interface PreviewGenerationWork {
  fixtureId?: DevelopmentFixtureDescriptor['id'];
  input: PreviewGenerationInput;
  previewContext: LanguageServerPreviewContext;
  outputRun: PreviewOutputRun;
}

interface PreviewOutputRun {
  id: string;
  script: string;
  seed: number;
  size: string;
  players: number;
  playerSlots: string;
}

export function RunConfigurationPanel({
  presetControlHost,
  versionControlHost,
}: {
  presetControlHost: HTMLElement | null;
  versionControlHost: HTMLElement | null;
}) {
  const {
    appendOutput,
    clearMapTestResults,
    commitPreview,
    executionProfiler,
    liveGenerationStages,
    mapTestProgress,
    markMapTestRun,
    pinnedPreviewSource,
    previewCandidates,
    publishMapTestResult,
    setPreviewExecution,
    settleOutputRun,
    settleRunOutcome,
    sourceInvalid,
    workspace,
  } = useAppPanelContext();
  const { t, state: localeState } = useI18n();
  const liveGenerationStagesRef = useRef(liveGenerationStages);
  liveGenerationStagesRef.current = liveGenerationStages;
  const previewCandidatesRef = useRef(previewCandidates);
  previewCandidatesRef.current = previewCandidates;
  const [catalog, setCatalog] = useState<ConfigurationCatalog | null>(null);
  const [configuration, setConfiguration] = useState<RunConfiguration | null>(null);
  const [presets, setPresets] = useState<RunPreset[]>([]);
  const [activePresetName, setActivePresetName] = useState(defaultRunPresetName);
  const [runState, setRunState] = useState<PreviewRunState>('idle');
  const [completedRunSequence, setCompletedRunSequence] = useState(0);
  const [executionState, setExecutionState] = useState<RootExecutionState>({ phase: 'idle' });
  const [liveStatus, setLiveStatus] = useState<LivePreviewStatus | null>(null);
  const [generationEvent, setGenerationEvent] = useState<PreviewGenerationEvent | undefined>();
  const [cacheDiagnostics, setCacheDiagnostics] = useState<PreviewCacheDiagnostics>({
    entries: 0,
    bytes: 0,
    hits: 0,
    misses: 0,
    evictions: 0,
  });
  const [developmentFixtures, setDevelopmentFixtures] = useState<DevelopmentFixtureDescriptor[]>(
    [],
  );
  const [selectedInstallation, setSelectedInstallation] = useState<InstallationReport | null>(null);
  const [installationBusy, setInstallationBusy] = useState(true);
  const [installationSelectionBusy, setInstallationSelectionBusy] = useState(false);
  const [liveTestOnRun, setLiveTestOnRun] = useState(false);
  const [controlLauncher, setControlLauncher] = useState<ControlLauncherStatus>({
    configured: false,
    state: 'unconfigured',
  });
  const [controlSession, setControlSession] = useState<ControlSessionStatus | null>(null);
  const [liveTestProgress, setLiveTestProgress] = useState(idleLiveTestProgress);
  const advanceLiveTestProgress = useCallback(
    (input: LiveTestProgressInput) =>
      setLiveTestProgress((current) => nextLiveTestProgress(current, input)),
    [],
  );
  const [controlBusy, setControlBusy] = useState(false);
  const [controlSelectionBusy, setControlSelectionBusy] = useState(false);
  const [controlDetaching, setControlDetaching] = useState(false);
  const controlBusyRef = useRef(false);
  const lastControlOutput = useRef({ message: '', timestamp: 0 });
  const liveOutputGateState = useRef(initialLiveOutputGate);
  const liveOutputRunId = useRef<string | null>(null);
  const settledOutputRuns = useRef(new Map<string, 'shown' | 'discarded'>());
  const outputRunSequence = useRef(0);
  const suppressNextAutomaticGeneration = useRef(false);
  const automaticGenerationDeferred = useRef(false);
  const installationDiscoveryStarted = useRef(false);
  const pickManualInstallationRef = useRef<() => void>(() => undefined);
  const handledSaveSequence = useRef(0);
  const pendingLiveRun = useRef<{
    requestId: string;
    configuration: RunConfiguration;
    documentUri: string;
    documentRevision: number;
    generationSettingsKey: string;
    outputRunId: string | null;
  } | null>(null);
  const activeLiveRequestId = useRef<string | null>(null);
  const committedLivePreviewHandler = useRef<(result: PreviewGenerationResult) => void>(() => {});
  const lastReportedBlockingReason = useRef<string | null>(null);
  const lastReportedStandardIncludeCause = useRef<string | null>(null);
  const pendingVersionRecoveryRun = useRef(false);
  const [committedCertification, setCommittedCertification] = useState<
    GenerationCertification | undefined
  >();
  const lastConstructNotes = useRef(new Map<string, string>());
  const [standardIncludeRefusedUris, setStandardIncludeRefusedUris] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [generationRefusedStandardInclude, setGenerationRefusedStandardInclude] = useState(false);
  const [standardIncludeAccess, setStandardIncludeAccess] = useState<{
    key: string;
    access: StandardIncludeAccess | null;
  } | null>(null);
  const pinnedWorkspaceDocument = workspace.documents.find(
    (document) => document.id === pinnedPreviewSource?.id,
  );
  const activeMapTest = isMapTestScriptName(workspace.activeDocument.name);
  const executionDocument = activeMapTest
    ? workspace.activeDocument
    : (pinnedWorkspaceDocument ?? pinnedPreviewSource ?? workspace.activeDocument);
  const sourceRevision = useRef({
    id: executionDocument.id,
    uri: executionDocument.uri,
    content: executionDocument.content,
    value: 1,
  });
  if (
    sourceRevision.current.id !== executionDocument.id ||
    sourceRevision.current.uri !== executionDocument.uri ||
    sourceRevision.current.content !== executionDocument.content
  ) {
    sourceRevision.current = {
      id: executionDocument.id,
      uri: executionDocument.uri,
      content: executionDocument.content,
      value: sourceRevision.current.value + 1,
    };
  }
  const currentDocument = useRef({
    id: executionDocument.id,
    uri: executionDocument.uri,
    content: executionDocument.content,
    revision: sourceRevision.current.value,
  });
  currentDocument.current = {
    id: executionDocument.id,
    uri: executionDocument.uri,
    content: executionDocument.content,
    revision: sourceRevision.current.value,
  };

  const appendRunOutput = useCallback(
    (runId: string | null | undefined, message: OutputMessage) => {
      if (!runId || settledOutputRuns.current.get(runId) === 'discarded') appendOutput(message);
      else appendOutput(message, { runId });
    },
    [appendOutput],
  );
  const settleRunOutput = useCallback(
    (runId: string, header: OutputRunHeader | null) => {
      if (settledOutputRuns.current.has(runId) && header === null) return;
      settledOutputRuns.current.set(runId, header ? 'shown' : 'discarded');
      if (settledOutputRuns.current.size > 64) {
        settledOutputRuns.current.delete(settledOutputRuns.current.keys().next().value!);
      }
      settleOutputRun(runId, header);
    },
    [settleOutputRun],
  );
  const executionDocumentName = useRef(executionDocument.name);
  executionDocumentName.current = executionDocument.name;
  const lastScheduledOutputRunId = useRef<string | null>(null);
  const appendControlOutput = useCallback(
    (message: OutputMessage) => {
      const now = Date.now();
      const identity = `${message.code}\n${message.headline}\n${message.cause ?? ''}`;
      if (
        lastControlOutput.current.message === identity &&
        now - lastControlOutput.current.timestamp < 1_000
      ) {
        return;
      }
      lastControlOutput.current = { message: identity, timestamp: now };
      appendRunOutput(liveOutputRunId.current, message);
    },
    [appendRunOutput],
  );
  const appendLiveWorkflow = useCallback(
    (event: LiveWorkflowEvent) => {
      const gate = liveOutputGate(liveOutputGateState.current, event);
      liveOutputGateState.current = gate.state;
      if (gate.visible) appendControlOutput(liveWorkflowMessage(event));
    },
    [appendControlOutput],
  );

  const refreshControlStatus = useCallback(async () => {
    const [launcher, session] = await Promise.all([
      window.rmside.getControlLauncherStatus(),
      window.rmside.getControlSessionStatus(),
    ]);
    setControlLauncher(launcher);
    setControlSession(session);
    return { launcher, session };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      window.rmside.getConfigurationCatalog(),
      window.rmside.getDevelopmentFixtures(),
    ])
      .then(([nextCatalog, fixtures]) => {
        if (cancelled) return;
        const stored = readStoredRunConfiguration(localStorage, nextCatalog);
        setCatalog(nextCatalog);
        setConfiguration(stored.current);
        setPresets(stored.presets);
        setActivePresetName(stored.activePresetName);
        setDevelopmentFixtures(fixtures);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setRunState('error');
          appendOutput(
            presentMessage({
              source: 'Preview',
              raw: errorMessage(error),
              fallbackHeadline: 'run-menu.settings.load-failed',
            }),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [appendOutput]);

  useEffect(() => {
    let disposed = false;
    void window.rmside.getExecutionState().then((state) => {
      if (!disposed) setExecutionState(state);
    });
    const unsubscribe = window.rmside.onExecutionState((state) => setExecutionState(state));
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void refreshControlStatus().catch(() => {
      if (!cancelled) {
        appendControlOutput(
          presentMessage({ source: 'Live test', code: 'live.status-unavailable' }),
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [appendControlOutput, refreshControlStatus]);

  useEffect(
    () =>
      window.rmside.onControlSessionEvent((event) => {
        advanceLiveTestProgress({ kind: 'session', event });
        appendLiveWorkflow(workflowEventFromControl(event));
        void window.rmside
          .getControlSessionStatus()
          .then((session) => {
            setControlLauncher(session.launcher);
            setControlSession(session);
          })
          .catch(() => undefined);
      }),
    [advanceLiveTestProgress, appendLiveWorkflow],
  );

  useEffect(
    () =>
      window.rmside.onControlLiveEvent((event) => {
        advanceLiveTestProgress({ kind: 'workflow', event });
        const step = workflowEventFromLive(event);
        if (step) appendLiveWorkflow(step);
      }),
    [advanceLiveTestProgress, appendLiveWorkflow],
  );

  useEffect(
    () =>
      window.rmside.onMapTestEvent((event) => {
        if (event.kind === 'preview') commitPreview(event.preview, 'map-test');
        else if (event.kind === 'progress') {
          mapTestProgress.advance({
            kind: 'counts',
            executionId: event.executionId,
            completed: event.completed,
            requested: event.requested,
          });
        } else if (event.kind === 'output') {
          appendOutput(
            {
              code: 'script.print',
              severity: 'info',
              source: 'Script',
              headline: event.text,
              monospace: true,
            },
            { runId: event.executionId },
          );
        }
      }),
    [appendOutput, commitPreview, mapTestProgress],
  );

  useEffect(() => {
    if (controlLauncher.state !== 'ready' || !selectedInstallation) setLiveTestOnRun(false);
  }, [controlLauncher.state, selectedInstallation]);

  useEffect(() => {
    if (!catalog || !configuration) return;
    const stored: StoredRunConfiguration = {
      version: 2,
      current: configuration,
      presets,
      activePresetName,
    };
    const timer = window.setTimeout(() => {
      try {
        writeStoredRunConfiguration(localStorage, stored);
      } catch (error) {
        appendOutput(
          presentMessage({
            source: 'Preview',
            raw: errorMessage(error),
            severity: 'warning',
            fallbackHeadline: 'run-menu.settings.save-failed',
          }),
        );
      }
    }, 150);
    return () => window.clearTimeout(timer);
  }, [activePresetName, appendOutput, catalog, configuration, presets]);

  const presetNamesLocale = useRef(localeState.locale);
  useEffect(() => {
    if (presetNamesLocale.current === localeState.locale) return;
    presetNamesLocale.current = localeState.locale;
    if (presets.length === 0) return;
    const localized = localizeAutomaticPresetNames(presets, activePresetName);
    if (localized.presets === presets) return;
    setPresets(localized.presets);
    if (localized.activePresetName) setActivePresetName(localized.activePresetName);
  }, [activePresetName, localeState.locale, presets]);

  useEffect(() => {
    if (!configuration) return;
    const nextActivePreset = runPreset(activePresetName, configuration);
    setPresets((current) => {
      const active = current.find((preset) => preset.name === activePresetName);
      if (!active) return current;
      if (JSON.stringify(active.configuration) === JSON.stringify(nextActivePreset.configuration)) {
        return current;
      }
      return current.map((preset) =>
        preset.name === activePresetName ? nextActivePreset : preset,
      );
    });
  }, [activePresetName, configuration]);

  const detectedProductVersion = selectedInstallation?.evidence.productVersion?.value ?? null;
  const detectedContentFingerprint = installationContentFingerprint(selectedInstallation);
  useEffect(() => {
    if (!detectedContentFingerprint) return;
    let cancelled = false;
    void window.rmside
      .getConfigurationCatalog()
      .then((nextCatalog) => {
        if (!cancelled) setCatalog(nextCatalog);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [detectedContentFingerprint]);
  const installationKey = installationSelectionKey(
    selectedInstallation?.evidence.installationRoot.value ?? null,
    detectedProductVersion,
  );
  const selectedProfileId = configuration
    ? effectiveProfileSelection(configuration, installationKey)
    : null;
  const preferredContentFingerprint =
    selectedProfileId === 'auto' ? detectedContentFingerprint : null;
  const versionOrigin: PreviewVersionOrigin =
    selectedProfileId === 'auto' && selectedInstallation ? 'local' : 'packaged';
  const civilizationProductVersion = versionOrigin === 'local' ? detectedProductVersion : null;
  const resolvedConfiguration = useMemo(() => {
    if (!configuration || !catalog || !selectedProfileId) return configuration;
    const profile = resolvePreviewProfile(catalog, selectedProfileId, detectedProductVersion);
    if (!profile) return null;
    return {
      ...configuration,
      profileId: profile.profileId,
      civilizationIds: availableCivilizationIds(
        configuration.civilizationIds,
        packedCivilizationOptions(profile.profileId, civilizationProductVersion),
      ),
    };
  }, [
    catalog,
    civilizationProductVersion,
    configuration,
    detectedProductVersion,
    selectedProfileId,
  ]);
  const effectiveConfiguration = useMemo(
    () =>
      resolvedConfiguration && liveTestOnRun
        ? withLiveComputerPlayers(resolvedConfiguration)
        : resolvedConfiguration,
    [liveTestOnRun, resolvedConfiguration],
  );
  const unverifiedLocalVersion =
    versionOrigin === 'local' &&
    catalog &&
    detectedProductVersion &&
    !isVerifiedLocalProductVersion(catalog, detectedProductVersion)
      ? detectedProductVersion
      : null;
  const previewContext = useMemo(() => {
    if (!resolvedConfiguration || !catalog) return null;
    try {
      const contentPack = resolvePreviewContentPack(
        catalog,
        resolvedConfiguration.profileId,
        preferredContentFingerprint,
      );
      return languageServerPreviewContext(
        resolvedConfiguration,
        contentPack
          ? {
              profileId: resolvedConfiguration.profileId,
              packId: contentPack.packId,
              packVersion: contentPack.packVersion,
              contentHash: contentPack.contentHash,
              versionOrigin,
            }
          : undefined,
      );
    } catch {
      return null;
    }
  }, [catalog, resolvedConfiguration, preferredContentFingerprint, versionOrigin]);
  const ambientPreviewContextRef = useRef(previewContext);
  ambientPreviewContextRef.current = previewContext;
  const requestedPreviewContext = useMemo(() => {
    if (!effectiveConfiguration?.seedLocked || !previewContext) return null;
    return languageServerPreviewContext(effectiveConfiguration, previewContext.contentSelection);
  }, [effectiveConfiguration, previewContext]);
  const ambientErrorsApplyToRequestedRun = samePreviewContext(
    previewContext,
    requestedPreviewContext,
  );
  useEffect(() => {
    if (!previewContext) return;
    void window.rmside
      .notifyLanguageServer('rms/previewContext', previewContext)
      .then(notifyLanguageContextChanged)
      .catch((error: unknown) =>
        appendOutput(
          presentMessage({
            source: 'Preview',
            raw: errorMessage(error),
            fallbackHeadline: 'run-menu.settings.editor-failed',
          }),
        ),
      );
  }, [appendOutput, previewContext]);
  const automaticConfigurationIdentity = useMemo(
    () => automaticGenerationIdentity(resolvedConfiguration),
    [resolvedConfiguration],
  );
  const previousAutomaticGenerationInput = useRef({
    configurationIdentity: automaticConfigurationIdentity,
    content: executionDocument.content,
    documentId: executionDocument.id,
    uri: executionDocument.uri,
  });
  const currentPreferredContentFingerprint = useRef<string | null>(preferredContentFingerprint);
  currentPreferredContentFingerprint.current = preferredContentFingerprint;
  const currentVersionOrigin = useRef<PreviewVersionOrigin>(versionOrigin);
  currentVersionOrigin.current = versionOrigin;
  const appendOutputRef = useRef(appendOutput);
  appendOutputRef.current = appendOutput;
  const appendRunOutputRef = useRef(appendRunOutput);
  appendRunOutputRef.current = appendRunOutput;
  const settleRunOutputRef = useRef(settleRunOutput);
  settleRunOutputRef.current = settleRunOutput;
  const documentsRef = useRef(workspace.documents);
  documentsRef.current = workspace.documents;
  const locateSource = useRef<SourceLocator>((uri, byteOffset) =>
    locateDocumentLine(documentsRef.current, uri, byteOffset),
  );
  const standardIncludeAccessHintRef = useRef<StandardIncludeAccess | null>(null);
  const commitPreviewRef = useRef(commitPreview);
  commitPreviewRef.current = commitPreview;
  const settleRunOutcomeRef = useRef(settleRunOutcome);
  settleRunOutcomeRef.current = settleRunOutcome;
  const executionProfilerRef = useRef(executionProfiler);
  executionProfilerRef.current = executionProfiler;
  const runKeys = useRef(new WeakMap<LivePreviewJob<PreviewGenerationWork>, string>());
  const runStartTimes = useRef(new WeakMap<LivePreviewJob<PreviewGenerationWork>, number>());
  const runKeySequence = useRef(0);
  const admitRun = useCallback((job: LivePreviewJob<PreviewGenerationWork>): string => {
    const admitted = runKeys.current.get(job);
    if (admitted !== undefined) return admitted;
    const key = `run-${++runKeySequence.current}`;
    runKeys.current.set(job, key);
    runStartTimes.current.set(job, performance.now());
    executionProfilerRef.current.anticipate(key, performance.now());
    previewCandidatesRef.current.admit(
      key,
      'preview',
      job.configuration.input.progressivePreview === true && !job.configuration.fixtureId,
      job.configuration.input.minimapPalette,
      job.configuration.input.texturePalette ?? null,
    );
    return key;
  }, []);
  const admitRunRef = useRef(admitRun);
  admitRunRef.current = admitRun;
  const sourceInvalidRef = useRef(sourceInvalid);
  sourceInvalidRef.current = sourceInvalid;
  const provenanceSourceContent = useRef(new WeakMap<PreviewGenerationResult, string>());
  const resultGenerationFacts = useRef(
    new WeakMap<PreviewGenerationResult, { configurationKey: string; seed: number }>(),
  );
  const lastCommittedResult = useRef<PreviewGenerationResult | null>(null);
  const pendingGenerationEvent = useRef<PreviewGenerationEvent | null>(null);
  const generationProgressFrame = useRef<number | null>(null);
  const previewCache = useRef(
    new BoundedPreviewLru<PreviewGenerationResult>(8, 128 * 1024 * 1024, previewResultBytes),
  );
  const activeLiveBackend = useRef<{ fixtureId?: DevelopmentFixtureDescriptor['id'] } | null>(null);
  const activePreviewExecutionId = useRef<string | null>(null);
  const lastScheduledJobIdentity = useRef<string | null>(null);
  const explicitSourceRevision = useRef(0);
  const liveCoordinator = useRef<
    LivePreviewCoordinator<PreviewGenerationResult, PreviewGenerationWork> | undefined
  >(undefined);
  if (!liveCoordinator.current) {
    liveCoordinator.current = new LivePreviewCoordinator(
      {
        analyze: async (job) => {
          admitRunRef.current(job);
          const { document } = job;
          const synchronizedUri = await waitForRmsLanguageDocument(document.uri);
          latencyProbe.runMark(job, 'analysis-synced');
          return parseLivePreviewAnalysis(
            await window.rmside.requestLanguageServer('rms/semanticIdentity', {
              textDocument: { uri: synchronizedUri },
              previewContext: job.configuration.previewContext,
            }),
          );
        },
        validateAnalysis: async (job, analysis) => {
          try {
            const current = await window.rmside.requestLanguageServer(
              'rms/validateSourceCatalogIdentity',
              {
                textDocument: { uri: canonicalLanguageDocumentUri(job.document.uri) },
                sourceCatalogProof: analysis.sourceCatalogProof,
              },
            );
            if (current !== true) throw new Error('the current include graph is unavailable');
          } catch (error) {
            throw new LivePreviewSourceChangedError(errorMessage(error));
          }
        },
        speculate: (job) => !sourceInvalidRef.current(job.document.uri),
        generate: async (job, pendingAnalysis, signal, requestId, responded) => {
          const { fixtureId, input } = job.configuration;
          const clientRequestId = `live-preview-${requestId}-${job.document.revision}`;
          const cancellableInput = { ...input, clientRequestId };
          activePreviewExecutionId.current = clientRequestId;
          latencyProbe.runRequest(job, clientRequestId);
          const runKey = admitRunRef.current(job);
          executionProfilerRef.current.begin(clientRequestId, runKey, performance.now());
          previewCandidatesRef.current.begin(clientRequestId, runKey);
          const cancel = () => {
            void window.rmside.cancelPreviewGeneration(clientRequestId).catch(() => false);
          };
          signal.addEventListener('abort', cancel, { once: true });
          try {
            let result: PreviewGenerationResult;
            try {
              latencyProbe.runMark(job, 'invoke-start');
              result = fixtureId
                ? await window.rmside.runDevelopmentFixture({ fixtureId, input: cancellableInput })
                : await window.rmside.generatePreview(cancellableInput);
              latencyProbe.runMark(job, 'invoke-end');
            } catch (error) {
              executionProfilerRef.current.end(clientRequestId);
              if (isPreviewGenerationCancellation(error)) {
                throw new LivePreviewCancellationError(error.message);
              }
              if (isPreviewSourceChangedError(errorMessage(error))) {
                throw new LivePreviewSourceChangedError(
                  'the source changed while the preview was generating',
                );
              }
              throw error;
            }
            if (signal.aborted) {
              executionProfilerRef.current.end(clientRequestId);
              throw abortError();
            }
            responded?.();
            const analysis = await pendingAnalysis;
            latencyProbe.runMark(job, 'analysis-joined');
            if (signal.aborted) {
              executionProfilerRef.current.end(clientRequestId);
              throw abortError();
            }
            executionProfilerRef.current.complete(clientRequestId, result.executionCost ?? null);
            const current = {
              ...result,
              semanticProgramHash: analysis.semanticHash,
              provenanceStatus: 'exact' as const,
            };
            await assertStreamMatchesResult(current);
            latencyProbe.runMark(job, 'stream-verified');
            provenanceSourceContent.current.set(current, job.document.content);
            resultGenerationFacts.current.set(current, {
              configurationKey: job.configurationKey,
              seed: input.seed,
            });
            return current;
          } finally {
            signal.removeEventListener('abort', cancel);
            if (activePreviewExecutionId.current === clientRequestId) {
              activePreviewExecutionId.current = null;
            }
          }
        },
        reuse: (result, analysis, document) => {
          const previousContent = provenanceSourceContent.current.get(result) ?? '';
          const remapped = remapEquivalentPreviewResult(
            result,
            analysis,
            document,
            previousContent,
          );
          provenanceSourceContent.current.set(remapped, document.content);
          return markCachedPreview(remapped);
        },
        historical: (result, document) => {
          const previousContent = provenanceSourceContent.current.get(result) ?? '';
          const historical = remapHistoricalPreviewResult(result, previousContent, document);
          provenanceSourceContent.current.set(historical, document.content);
          return markCachedPreview(historical);
        },
        commit: (result, job, kind) => {
          lastCommittedResult.current = result;
          commitPreviewRef.current(result);
          previewCandidatesRef.current.end();
          setCompletedRunSequence((current) => current + 1);
          setGenerationRefusedStandardInclude(false);
          setCommittedCertification(result.backend === 'exact' ? result.certification : undefined);
          const run = job.configuration.outputRun;
          const durationMs = runDuration(runStartTimes.current.get(job));
          if (kind === 'generated') {
            for (const warning of result.warnings) {
              appendRunOutputRef.current(
                run.id,
                presentMessage({
                  source: 'Run',
                  code: warning.code,
                  raw: warning.message,
                  severity: 'warning',
                  fallbackHeadline: 'run-menu.run.warning',
                }),
              );
            }
            const constructs = outputRunConstructs(result);
            const constructNote = uncertifiedConstructKey(
              result.backend === 'exact' ? result.constructVerification : undefined,
            );
            const constructNoteKey = result.documentUri;
            const constructMessage = constructVerificationMessage(
              result.backend === 'exact' ? result.constructVerification : undefined,
            );
            if (
              constructMessage &&
              lastConstructNotes.current.get(constructNoteKey) !== constructNote
            ) {
              appendRunOutputRef.current(run.id, constructMessage);
            }
            lastConstructNotes.current.set(constructNoteKey, constructNote);
            const exact = result.backend === 'exact';
            settleRunOutputRef.current(run.id, {
              ...previewRunHeader(run, durationMs),
              size: `${result.width}×${result.height}`,
              result: exact ? 'exact' : 'synthetic',
              resultLabel: exact
                ? generatedResultLabel(result.certification)
                : { id: 'run-menu.result.synthetic' },
              mapHash: result.semanticHash,
              requestHash: result.requestHash,
              ...(constructs ? { constructs } : {}),
            });
          } else if (kind === 'reused') {
            const constructsOf = (reused: PreviewGenerationResult) => {
              const constructs = outputRunConstructs(reused);
              return constructs ? { constructs } : {};
            };
            settleRunOutputRef.current(
              run.id,
              job.trigger === 'explicit'
                ? {
                    ...previewRunHeader(run, durationMs),
                    size: `${result.width}×${result.height}`,
                    result: 'unchanged',
                    resultLabel:
                      result.backend === 'exact'
                        ? generatedResultLabel(result.certification, { reused: true })
                        : { id: 'run-menu.result.synthetic-reused' },
                    mapHash: result.semanticHash,
                    ...constructsOf(result),
                  }
                : null,
            );
          }
          committedLivePreviewHandler.current(result);
        },
        reject: (rejected, job) => {
          latencyProbe.runMark(job, 'rejected');
          const runKey = runKeys.current.get(job);
          const run = job.configuration.outputRun;
          const durationMs = runDuration(runStartTimes.current.get(job));
          let outcome: RunOutcome = rejected;
          if (rejected.kind === 'failed') {
            const presentation = runFailureMessage(rejected, {
              locate: locateSource.current,
              standardIncludeAccess: standardIncludeAccessHint(
                standardIncludeAccessHintRef.current,
              ),
              params: { playerSlots: run.playerSlots },
            });
            outcome = { ...rejected, presentation };
            const quiet =
              job.trigger === 'automatic' &&
              (rejected.stage === 'analysis' || rejected.stage === 'request');
            if (quiet) settleRunOutputRef.current(run.id, null);
            else {
              if (!failureReportedByMain(presentation, 'preview')) {
                appendRunOutputRef.current(run.id, presentation);
              }
              settleRunOutputRef.current(run.id, {
                ...previewRunHeader(run, durationMs),
                result: 'failed',
                resultLabel: { id: 'run-menu.result.failed' },
              });
            }
          } else if (rejected.kind === 'cancelled') {
            settleRunOutputRef.current(run.id, {
              ...previewRunHeader(run, durationMs),
              result: 'stopped',
              resultLabel: { id: 'run-menu.result.stopped-kept' },
            });
          } else {
            settleRunOutputRef.current(run.id, null);
          }
          if (runOutcomeEffects(outcome, job.trigger).clearMap) {
            lastCommittedResult.current = null;
          }
          settleRunOutcomeRef.current(outcome, job.trigger, runKey);
        },
        status: (status) => {
          setLiveStatus(status);
          setCacheDiagnostics(previewCache.current.diagnostics());
          setRunState(
            status.phase === 'generating' || status.phase === 'analyzing'
              ? 'running'
              : status.phase === 'failed' || status.phase === 'invalid'
                ? 'error'
                : status.phase === 'current'
                  ? 'success'
                  : 'idle',
          );
          if (status.phase === 'failed' || status.phase === 'invalid') {
            const pending = pendingLiveRun.current;
            if (pending) {
              pendingLiveRun.current = null;
              liveOutputRunId.current = null;
              setLiveTestProgress((current) => nextLiveTestProgress(current, { kind: 'ended' }));
              appendRunOutputRef.current(
                pending.outputRunId,
                presentMessage({
                  source: 'Live test',
                  code:
                    status.phase === 'failed'
                      ? 'live.stopped.generation-failed'
                      : 'live.stopped.invalid-source',
                }),
              );
            }
            setGenerationRefusedStandardInclude(
              isStandardIncludeUnavailableMessage(status.message ?? ''),
            );
          } else if (status.phase === 'editing' && status.message) {
            const pending = pendingLiveRun.current;
            if (pending) {
              pendingLiveRun.current = null;
              liveOutputRunId.current = null;
              setLiveTestProgress((current) => nextLiveTestProgress(current, { kind: 'ended' }));
              appendRunOutputRef.current(
                pending.outputRunId,
                presentMessage({ source: 'Live test', code: 'live.stopped.source-changed' }),
              );
            }
          }
        },
      },
      previewCache.current,
    );
  }
  const cancelLiveCoordinator = useCallback(() => {
    liveCoordinator.current?.cancel();
    setRunState((current) => (current === 'running' ? 'idle' : current));
    setLiveTestProgress((current) => nextLiveTestProgress(current, { kind: 'preview-stopped' }));
  }, []);
  const stopExecution = useCallback(() => {
    cancelLiveCoordinator();
    executionProfilerRef.current.end();
    previewCandidatesRef.current.end();
    void window.rmside.stopExecution();
  }, [cancelLiveCoordinator]);
  useEffect(
    () =>
      window.rmside.onPreviewExecutionProgress((event) =>
        executionProfilerRef.current.progress(event, performance.now()),
      ),
    [],
  );
  useEffect(() => {
    if (executionState.phase !== 'stopping' || executionState.kind === 'map-icon') return;
    cancelLiveCoordinator();
  }, [cancelLiveCoordinator, executionState]);
  const effectiveContentPack = useMemo(
    () =>
      catalog && effectiveConfiguration
        ? resolvePreviewContentPack(
            catalog,
            effectiveConfiguration.profileId,
            preferredContentFingerprint,
          )
        : null,
    [catalog, effectiveConfiguration, preferredContentFingerprint],
  );
  const executionSourceInvalid =
    ambientErrorsApplyToRequestedRun && sourceInvalid(executionDocument.uri);

  useEffect(
    () =>
      window.rmside.onLanguageServerEvent((event) => {
        if (event.method === 'rms/sourceCatalogInvalidated') {
          liveCoordinator.current?.sourceInvalidated();
          return;
        }
        if (event.method !== 'textDocument/publishDiagnostics') return;
        const params = event.params as { uri?: unknown; diagnostics?: unknown };
        if (typeof params?.uri !== 'string' || !Array.isArray(params.diagnostics)) return;
        const uri = canonicalLanguageDocumentUri(params.uri);
        const refused = params.diagnostics.some(
          (diagnostic: unknown) =>
            typeof diagnostic === 'object' &&
            diagnostic !== null &&
            typeof (diagnostic as { message?: unknown }).message === 'string' &&
            isStandardIncludeUnavailableMessage((diagnostic as { message: string }).message),
        );
        setStandardIncludeRefusedUris((current) => {
          if (current.has(uri) === refused) return current;
          const next = new Set(current);
          if (refused) next.add(uri);
          else next.delete(uri);
          return next;
        });
      }),
    [],
  );
  const standardIncludeDiagnosed = standardIncludeRefusedUris.has(
    canonicalLanguageDocumentUri(executionDocument.uri),
  );
  const standardIncludeRefused = standardIncludeDiagnosed || generationRefusedStandardInclude;
  const standardIncludeAccessKey = `${versionOrigin}|${installationKey ?? ''}`;
  useEffect(() => {
    if (!standardIncludeRefused) {
      setStandardIncludeAccess(null);
      return undefined;
    }
    let cancelled = false;
    void window.rmside
      .getStandardIncludeAccess(versionOrigin)
      .catch(() => null)
      .then((access) => {
        if (!cancelled) setStandardIncludeAccess({ key: standardIncludeAccessKey, access });
      });
    return () => {
      cancelled = true;
    };
  }, [standardIncludeAccessKey, standardIncludeRefused, versionOrigin]);
  standardIncludeAccessHintRef.current = standardIncludeAccess?.access ?? null;
  const standardIncludeAccessPending =
    standardIncludeRefused && standardIncludeAccess?.key !== standardIncludeAccessKey;
  const localInstallationUsable = Boolean(selectedInstallation);
  const standardIncludeCause = useMemo(
    () =>
      standardIncludeRefused &&
      standardIncludeAccess?.key === standardIncludeAccessKey &&
      standardIncludeAccess.access
        ? standardIncludeRecovery(standardIncludeAccess.access, localInstallationUsable)
        : null,
    [
      localInstallationUsable,
      standardIncludeAccess,
      standardIncludeAccessKey,
      standardIncludeRefused,
      t,
    ],
  );

  const blockingReason = useMemo(() => {
    if (!catalog || !configuration) return null;
    const includeOnly = runnableDocumentBlockingReason(executionDocument.name);
    if (includeOnly) return includeOnly;
    if (!executionDocument.content) return t('run-menu.blocked.source-empty');
    if (executionSourceInvalid) {
      return standardIncludeCause?.cause ?? t(syntaxErrorsBlockingReason);
    }
    const errors = validateRunConfiguration(effectiveConfiguration ?? configuration);
    if (errors.length > 0) return errors[0]!;
    const profile = catalog.behaviorProfiles.find(
      (candidate) => candidate.profileId === effectiveConfiguration?.profileId,
    );
    if (!profile) return t('run-menu.blocked.profile-unavailable');
    if (!effectiveContentPack) {
      return t('run-menu.blocked.content-pack-unavailable');
    }
    if (profile.capabilities['exact-generation'] !== 'complete') {
      return generationResultWords.generationUnavailable;
    }
    return null;
  }, [
    catalog,
    configuration,
    effectiveContentPack,
    effectiveConfiguration,
    executionDocument.content,
    executionDocument.name,
    executionSourceInvalid,
    standardIncludeCause,
    t,
  ]);

  const automaticRunInput = {
    documentName: executionDocument.name,
    sourceEmpty: !executionDocument.content,
    blockingReason,
    sourceInvalid: executionSourceInvalid,
  };
  const automaticRunAllowed = useRef<(fixture: boolean) => boolean>(() => false);
  automaticRunAllowed.current = (fixture) => automaticRunApplies({ ...automaticRunInput, fixture });

  useEffect(() => {
    if (!blockingReason || standardIncludeCause?.cause !== blockingReason) {
      lastReportedBlockingReason.current = null;
      return;
    }
    if (standardIncludeAccessPending) return;
    if (lastReportedBlockingReason.current === blockingReason) return;
    lastReportedBlockingReason.current = blockingReason;
    appendOutput(standardIncludeNote(standardIncludeCause));
  }, [appendOutput, blockingReason, standardIncludeAccessPending, standardIncludeCause]);

  const explainBlockedRun = useCallback(() => {
    if (!blockingReason || blockingReason === t(syntaxErrorsBlockingReason)) return;
    if (standardIncludeAccessPending && executionSourceInvalid) return;
    const presentation =
      standardIncludeCause?.cause === blockingReason
        ? standardIncludeNote(standardIncludeCause)
        : outputNote(
            'Preview',
            'preview.unavailable',
            { id: 'run-menu.blocked.headline' },
            { cause: blockingReason },
          );
    appendOutput(presentation);
    settleRunOutcomeRef.current(
      { kind: 'failed', stage: 'request', message: blockingReason, presentation },
      'explicit',
    );
  }, [
    appendOutput,
    blockingReason,
    executionSourceInvalid,
    standardIncludeAccessPending,
    standardIncludeCause,
    t,
  ]);

  useEffect(() => {
    const cause = standardIncludeCause?.cause ?? null;
    if (!cause) {
      lastReportedStandardIncludeCause.current = null;
      return;
    }
    if (blockingReason === cause || lastReportedStandardIncludeCause.current === cause) return;
    lastReportedStandardIncludeCause.current = cause;
    appendOutput(standardIncludeNote(standardIncludeCause!));
  }, [appendOutput, blockingReason, standardIncludeCause]);

  const scheduleGeneration = useCallback(
    (
      trigger: RunTrigger,
      requestedConfiguration: RunConfiguration,
      fixtureId?: DevelopmentFixtureDescriptor['id'],
      debounceMs = 0,
      deduplicate = false,
      explicitSource?: PinnedPreviewSource,
      supersedeOwnPreview = false,
    ): string | null => {
      if (!catalog) return null;
      if (executionState.phase !== 'idle' && !supersedeOwnPreview) return null;
      const document = explicitSource
        ? {
            id: explicitSource.id,
            uri: explicitSource.uri,
            content: explicitSource.content,
            revision: ++explicitSourceRevision.current,
          }
        : { ...currentDocument.current };
      let input: PreviewGenerationInput;
      try {
        input = buildPreviewGenerationInput(
          requestedConfiguration,
          catalog,
          { uri: document.uri, content: document.content },
          document.revision,
          currentVersionOrigin.current,
          currentPreferredContentFingerprint.current,
          detectedProductVersion,
        );
      } catch (error) {
        setRunState('error');
        const failure = { stage: 'request' as const, message: errorMessage(error) };
        const presentation = runFailureMessage(failure);
        if (trigger === 'explicit') appendOutput(presentation);
        settleRunOutcomeRef.current({ kind: 'failed', ...failure, presentation }, trigger);
        return null;
      }
      const backendIdentity = fixtureId
        ? `synthetic:development-fixture-v1:${fixtureId}`
        : `exact:${input.profile.profileHash}:${input.contentPack.contentHash}`;
      const outputRun: PreviewOutputRun = {
        id: `preview-${++outputRunSequence.current}`,
        script: explicitSource?.name ?? executionDocumentName.current,
        seed: input.seed,
        size: `${input.width}×${input.height}`,
        players: input.players.length,
        playerSlots: requestedConfiguration.playerSlots
          .slice(0, requestedConfiguration.playerCount)
          .join(','),
      };
      const job: LivePreviewJob<PreviewGenerationWork> = {
        backendIdentity,
        trigger,
        configuration: {
          fixtureId,
          outputRun,
          input,
          previewContext: languageServerPreviewContext(requestedConfiguration, {
            profileId: input.profile.profileId,
            packId: input.contentPack.packId,
            packVersion: input.contentPack.packVersion,
            contentHash: input.contentPack.contentHash,
            versionOrigin: input.versionOrigin,
          }),
        },
        configurationKey: generationSettingsKey(input),
        document,
      };
      input = { ...input, progressivePreview: liveGenerationStagesRef.current };
      job.configuration.input = input;
      const jobIdentity = JSON.stringify({
        backendIdentity,
        configurationKey: job.configurationKey,
        documentId: document.id,
        documentRevision: document.revision,
        sourceInvalid:
          sourceInvalidRef.current(document.uri) &&
          samePreviewContext(ambientPreviewContextRef.current, job.configuration.previewContext),
      });
      if (deduplicate && lastScheduledJobIdentity.current === jobIdentity) return null;
      lastScheduledJobIdentity.current = jobIdentity;
      if (debounceMs <= 0) admitRun(job);
      clearMapTestResults();
      lastScheduledOutputRunId.current = outputRun.id;
      const randomCivilizations = randomCivilizationResolutions(requestedConfiguration);
      if (randomCivilizations.length > 0) {
        appendOutput(
          outputNote(
            'Run',
            'preview.random-civilizations',
            {
              id: 'run-menu.random-civilizations.headline',
              args: {
                players: randomCivilizations.map(({ playerIndex, name }) => ({
                  id: 'run-menu.random-civilizations.player',
                  args: { player: playerIndex + 1, civilization: name },
                })),
              },
            },
            { cause: { id: 'run-menu.random-civilizations.cause' } },
          ),
          { runId: outputRun.id },
        );
      }
      liveCoordinator.current!.schedule(job, { debounceMs });
      return job.configurationKey;
    },
    [
      admitRun,
      appendOutput,
      catalog,
      clearMapTestResults,
      detectedProductVersion,
      executionState.phase,
    ],
  );

  const runMapTest = useCallback(
    async (trigger: RunTrigger) => {
      if (
        blockingReason ||
        executionState.phase !== 'idle' ||
        !catalog ||
        !effectiveConfiguration ||
        !isMapTestScriptName(executionDocument.name)
      ) {
        return;
      }
      let generationTemplate: PreviewGenerationInput;
      try {
        generationTemplate = buildPreviewGenerationInput(
          effectiveConfiguration,
          catalog,
          { uri: executionDocument.uri, content: executionDocument.content },
          currentDocument.current.revision,
          currentVersionOrigin.current,
          currentPreferredContentFingerprint.current,
          detectedProductVersion,
        );
      } catch (error) {
        const failure = { stage: 'map-test' as const, message: errorMessage(error) };
        const presentation = runFailureMessage(failure);
        appendOutput(presentation);
        settleRunOutcomeRef.current({ kind: 'failed', ...failure, presentation }, trigger);
        return;
      }
      const input: MapTestRunInput = {
        executionId: `map-test-${crypto.randomUUID()}`,
        scriptUri: executionDocument.uri,
        scriptRevision: currentDocument.current.revision,
        scriptName: executionDocument.name,
        scriptSource: executionDocument.content,
        workspaceName: '',
        ...(pinnedPreviewSource && isPreviewScriptName(pinnedPreviewSource.name)
          ? { defaultSourceUri: pinnedPreviewSource.uri }
          : {}),
        profile: generationTemplate.profile,
        contentPack: generationTemplate.contentPack,
        versionOrigin: generationTemplate.versionOrigin,
        width: generationTemplate.width,
        height: generationTemplate.height,
        mapSize: generationTemplate.mapSize,
        players: generationTemplate.players,
        modeContext: generationTemplate.modeContext,
        workers: effectiveConfiguration.mapTestWorkers,
        minimapPalette: generationTemplate.minimapPalette,
        texturePalette: generationTemplate.texturePalette ?? null,
        progressivePreview: mapTestProgressivePreview,
      };
      setRunState('running');
      markMapTestRun('running');
      mapTestProgress.advance({ kind: 'started', executionId: input.executionId });
      previewCandidatesRef.current.begin(input.executionId, undefined, {
        kind: 'map-test',
        progressive: mapTestProgressivePreview,
        minimapPalette: input.minimapPalette,
        texturePalette: input.texturePalette ?? null,
      });
      const startedAt = performance.now();
      const mapTestHeader = (
        result: OutputRunResult,
        resultLabel: MessageId,
        extra: Partial<OutputRunHeader> = {},
      ): OutputRunHeader => ({
        kind: 'map-test',
        script: input.scriptName,
        durationMs: runDuration(startedAt),
        result,
        resultLabel: { id: resultLabel },
        ...extra,
      });
      try {
        const result = await window.rmside.runMapTest(input);
        mapTestProgress.advance({
          kind: result.status === 'passed' || result.status === 'failed' ? 'finished' : 'ended',
          executionId: input.executionId,
        });
        publishMapTestResult(executionDocument.uri, input, result);
        setRunState(
          result.status === 'passed' || result.status === 'failed'
            ? 'success'
            : result.status === 'cancelled'
              ? 'idle'
              : 'error',
        );
        const facts = {
          ...(result.report ? { maps: result.report.generatedMaps } : {}),
          durationMs: result.elapsedMilliseconds,
        };
        if (result.status === 'error') {
          const message = result.diagnostics[0]?.message ?? 'unknown error';
          const presentation = runFailureMessage({ stage: 'map-test', message });
          appendRunOutput(input.executionId, presentation);
          settleRunOutput(
            input.executionId,
            mapTestHeader('failed', 'run-menu.result.error', facts),
          );
          settleRunOutcomeRef.current(
            { kind: 'failed', stage: 'map-test', message, presentation },
            trigger,
          );
        } else {
          settleRunOutput(
            input.executionId,
            result.status === 'passed'
              ? mapTestHeader('passed', 'run-menu.result.passed', facts)
              : result.status === 'failed'
                ? mapTestHeader('test-failed', 'run-menu.result.failed', facts)
                : mapTestHeader('stopped', 'run-menu.result.stopped', facts),
          );
        }
      } catch (error) {
        const message = errorMessage(error);
        let outcome: RunOutcome = classifyMapTestRejection(message);
        markMapTestRun(outcome.kind === 'failed' ? 'error' : 'cancelled');
        mapTestProgress.advance({ kind: 'ended', executionId: input.executionId });
        if (outcome.kind === 'failed') {
          const presentation = runFailureMessage(outcome);
          outcome = { ...outcome, presentation };
          if (!failureReportedByMain(presentation, 'map-test')) {
            appendRunOutput(input.executionId, presentation);
          }
          settleRunOutput(input.executionId, mapTestHeader('failed', 'run-menu.result.error'));
          setRunState('error');
        } else {
          settleRunOutput(
            input.executionId,
            outcome.kind === 'cancelled'
              ? mapTestHeader('stopped', 'run-menu.result.stopped')
              : null,
          );
          setRunState('idle');
        }
        settleRunOutcomeRef.current(outcome, trigger);
      } finally {
        previewCandidatesRef.current.end(input.executionId);
      }
    },
    [
      appendOutput,
      appendRunOutput,
      blockingReason,
      catalog,
      detectedProductVersion,
      effectiveConfiguration,
      executionDocument.content,
      executionDocument.name,
      executionDocument.uri,
      executionState.phase,
      mapTestProgress,
      markMapTestRun,
      pinnedPreviewSource,
      publishMapTestResult,
      settleRunOutput,
    ],
  );

  const runPreview = useCallback(
    (trigger: RunTrigger, forceGeneration = false) => {
      if (
        blockingReason ||
        runState === 'running' ||
        executionState.phase !== 'idle' ||
        !effectiveConfiguration
      )
        return;
      const requestedConfiguration = effectiveConfiguration.seedLocked
        ? effectiveConfiguration
        : withSeed(effectiveConfiguration, randomSeed());
      if (!effectiveConfiguration.seedLocked) {
        setConfiguration((current) =>
          current
            ? {
                ...requestedConfiguration,
                profileId: current.profileId,
                profileInstallation: current.profileInstallation,
                computerPlayers: current.computerPlayers,
              }
            : current,
        );
      }
      activeLiveBackend.current = {};
      if (forceGeneration) liveCoordinator.current?.clearCache();
      scheduleGeneration(trigger, requestedConfiguration);
    },
    [blockingReason, effectiveConfiguration, executionState.phase, runState, scheduleGeneration],
  );

  const runSource = useCallback(
    (source: PinnedPreviewSource): PreviewSourceRunAcceptance => {
      if (runState === 'running' || executionState.phase !== 'idle') {
        return {
          status: 'blocked',
          reason: { id: 'run-menu.blocked.execution-busy' },
          retryable: true,
        };
      }
      if (!catalog || !configuration || !effectiveConfiguration) {
        return {
          status: 'blocked',
          reason: { id: 'run-menu.blocked.loading' },
          retryable: true,
        };
      }
      if (!isPreviewScriptName(source.name)) {
        return {
          status: 'blocked',
          reason: { id: 'run-menu.blocked.not-main-file' },
          retryable: false,
        };
      }
      if (!source.content) {
        return {
          status: 'blocked',
          reason: { id: 'run-menu.blocked.selected-source-empty' },
          retryable: false,
        };
      }
      if (ambientErrorsApplyToRequestedRun && sourceInvalidRef.current(source.uri)) {
        return {
          status: 'blocked',
          reason: { id: 'run-menu.blocked.selected-source-syntax' },
          retryable: false,
        };
      }
      const configurationErrors = validateRunConfiguration(effectiveConfiguration);
      if (configurationErrors.length > 0) {
        return {
          status: 'blocked',
          reason: configurationErrors[0]!,
          retryable: false,
        };
      }
      const profile = catalog.behaviorProfiles.find(
        (candidate) => candidate.profileId === effectiveConfiguration.profileId,
      );
      if (!profile) {
        return {
          status: 'blocked',
          reason: { id: 'run-menu.blocked.profile-unavailable' },
          retryable: false,
        };
      }
      if (!effectiveContentPack) {
        return {
          status: 'blocked',
          reason: { id: 'run-menu.blocked.content-pack-unavailable' },
          retryable: false,
        };
      }
      if (profile.capabilities['exact-generation'] !== 'complete') {
        return {
          status: 'blocked',
          reason: { id: 'message.generation-result.generation-unavailable' },
          retryable: false,
        };
      }

      const requestedConfiguration = effectiveConfiguration.seedLocked
        ? effectiveConfiguration
        : withSeed(effectiveConfiguration, randomSeed());
      if (!effectiveConfiguration.seedLocked) {
        suppressNextAutomaticGeneration.current = true;
        setConfiguration((current) =>
          current
            ? {
                ...requestedConfiguration,
                profileId: current.profileId,
                profileInstallation: current.profileInstallation,
                computerPlayers: current.computerPlayers,
              }
            : current,
        );
      }
      activeLiveBackend.current = null;
      liveCoordinator.current?.clearCache();
      return scheduleGeneration('explicit', requestedConfiguration, undefined, 0, false, source)
        ? { status: 'scheduled' }
        : {
            status: 'blocked',
            reason: t('run-menu.blocked.not-scheduled'),
            retryable: true,
          };
    },
    [
      ambientErrorsApplyToRequestedRun,
      catalog,
      configuration,
      effectiveConfiguration,
      effectiveContentPack,
      executionState.phase,
      runState,
      scheduleGeneration,
      t,
    ],
  );

  const reusableCommittedResult = useCallback(
    (source: PinnedPreviewSource): ReusableCommittedPreview | null => {
      const result = lastCommittedResult.current;
      const facts = result ? resultGenerationFacts.current.get(result) : undefined;
      if (
        !result ||
        !facts ||
        !catalog ||
        !effectiveConfiguration ||
        result.backend !== 'exact' ||
        result.documentUri !== source.uri ||
        runState === 'running' ||
        executionState.phase !== 'idle' ||
        liveStatus?.phase !== 'current' ||
        liveStatus.documentRevision !== result.documentRevision ||
        provenanceSourceContent.current.get(result) !== source.content
      ) {
        return null;
      }
      try {
        const current = buildPreviewGenerationInput(
          effectiveConfiguration,
          catalog,
          { uri: source.uri, content: source.content },
          result.documentRevision,
          currentVersionOrigin.current,
          currentPreferredContentFingerprint.current,
          detectedProductVersion,
        );
        if (generationSettingsKey(current) !== facts.configurationKey) return null;
      } catch {
        return null;
      }
      return { result, seed: facts.seed };
    },
    [
      catalog,
      detectedProductVersion,
      effectiveConfiguration,
      executionState.phase,
      liveStatus,
      runState,
    ],
  );

  const runDevelopmentFixture = useCallback(
    (fixtureId: DevelopmentFixtureDescriptor['id']) => {
      if (!effectiveConfiguration) return;
      if (!isPreviewScriptName(executionDocument.name) || !executionDocument.content) {
        appendOutput(
          outputNote(
            'Preview',
            'preview.fixture-needs-source',
            { id: 'run-menu.fixture.needs-source' },
            { severity: 'warning' },
          ),
        );
        return;
      }
      activeLiveBackend.current = { fixtureId };
      scheduleGeneration('explicit', effectiveConfiguration, fixtureId);
    },
    [
      appendOutput,
      effectiveConfiguration,
      executionDocument.content,
      executionDocument.name,
      scheduleGeneration,
    ],
  );

  const setSeed = useCallback((seed: number) => {
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) return;
    setConfiguration((current) => (current ? withSeed(current, seed) : current));
  }, []);

  const selectControl = useCallback(async () => {
    if (controlBusyRef.current || !selectedInstallation) return;
    controlBusyRef.current = true;
    setControlBusy(true);
    setControlSelectionBusy(true);
    try {
      const launcher = await window.rmside.selectControlLauncher();
      if (!launcher) return;
      setControlLauncher(launcher);
      const session = await window.rmside.getControlSessionStatus();
      setControlSession(session);
      if (launcher.state === 'ready') {
        appendControlOutput(presentMessage({ source: 'Live test', code: 'live.control-selected' }));
      } else {
        setLiveTestOnRun(false);
        appendControlOutput(presentMessage({ source: 'Live test', code: 'live.control-rejected' }));
      }
    } catch (error) {
      setLiveTestOnRun(false);
      appendControlOutput(
        presentMessage({
          source: 'Live test',
          code: 'live.control-rejected',
          raw: errorMessage(error),
        }),
      );
      await refreshControlStatus().catch(() => undefined);
    } finally {
      controlBusyRef.current = false;
      setControlBusy(false);
      setControlSelectionBusy(false);
    }
  }, [appendControlOutput, refreshControlStatus, selectedInstallation]);

  const forgetControl = useCallback(async () => {
    if (controlBusyRef.current) return;
    controlBusyRef.current = true;
    setControlBusy(true);
    try {
      const launcher = await window.rmside.forgetControlLauncher();
      forgetActiveMatchReplacement(window.localStorage);
      setControlLauncher(launcher);
      setControlSession(await window.rmside.getControlSessionStatus());
      setLiveTestOnRun(false);
      appendControlOutput(presentMessage({ source: 'Live test', code: 'live.control-forgotten' }));
    } catch (error) {
      appendControlOutput(
        presentMessage({
          source: 'Live test',
          code: 'live.control-forget-failed',
          raw: errorMessage(error),
        }),
      );
    } finally {
      controlBusyRef.current = false;
      setControlBusy(false);
    }
  }, [appendControlOutput]);

  const detachControl = useCallback(async () => {
    if (controlBusyRef.current) return;
    controlBusyRef.current = true;
    setControlBusy(true);
    setControlDetaching(true);
    try {
      const session = await window.rmside.disconnectControlSession();
      setControlLauncher(session.launcher);
      setControlSession(session);
    } catch (error) {
      appendControlOutput(liveFailureMessage(error));
      await refreshControlStatus().catch(() => undefined);
    } finally {
      controlBusyRef.current = false;
      setControlBusy(false);
      setControlDetaching(false);
    }
  }, [appendControlOutput, refreshControlStatus]);

  const adoptMatchSeed = useCallback(async () => {
    if (controlBusyRef.current || controlLauncher.state !== 'ready') return;
    controlBusyRef.current = true;
    setControlBusy(true);
    try {
      const session = await window.rmside.connectControlSession('adopt-seed');
      setControlLauncher(session.launcher);
      setControlSession(session);
      const availability = matchSeedAvailability(session.launcher, session);
      if (!availability.available || availability.seed === undefined) {
        appendControlOutput(
          presentMessage({
            source: 'Live test',
            code: 'live.seed-unavailable',
            params: {
              reason: availability.reason ?? t('live-test.seed.not-returned'),
            },
          }),
        );
        return;
      }
      const seed = availability.seed;
      setConfiguration((current) => {
        if (!current) return current;
        if (current.seed !== seed) suppressNextAutomaticGeneration.current = true;
        return { ...withSeed(current, seed), seedLocked: true };
      });
      appendControlOutput(
        presentMessage({ source: 'Live test', code: 'live.seed-imported', params: { seed } }),
      );
    } catch (error) {
      appendControlOutput(liveFailureMessage(error));
      await refreshControlStatus().catch(() => undefined);
    } finally {
      controlBusyRef.current = false;
      setControlBusy(false);
    }
  }, [appendControlOutput, controlLauncher.state, refreshControlStatus, t]);

  const executeCommittedLiveRun = useCallback(
    async (result: PreviewGenerationResult) => {
      const pending = pendingLiveRun.current;
      if (!pending) return;
      pendingLiveRun.current = null;
      liveOutputRunId.current = pending.outputRunId;
      let request: ControlLiveSynchronizationRequest;
      try {
        request = buildControlLiveRequest(result, pending.configuration, {
          requestId: pending.requestId,
          documentUri: pending.documentUri,
          documentRevision: pending.documentRevision,
          requestedGenerationSettingsKey: pending.generationSettingsKey,
          resultGenerationSettingsKey: resultGenerationFacts.current.get(result)?.configurationKey,
          includePreviewImage: false,
          replaceActiveMatch: false,
          overwriteDeploymentConflicts: true,
        });
      } catch {
        appendControlOutput(
          presentMessage({ source: 'Live test', code: 'live.stopped.stale-preview' }),
        );
        liveOutputRunId.current = null;
        advanceLiveTestProgress({ kind: 'ended' });
        return;
      }

      controlBusyRef.current = true;
      setControlBusy(true);
      advanceLiveTestProgress({ kind: 'control' });
      try {
        const session = await window.rmside.connectControlSession('live-run');
        setControlLauncher(session.launcher);
        setControlSession(session);
        if (!controlAcceptsLiveSetup(session, request.setup)) {
          appendControlOutput(
            presentMessage({
              source: 'Live test',
              code: 'control.control-lobby-options-unsupported',
              raw: `Lobby options need AoE2Control 1.1.1 or newer; the selected AoE2Control is ${session.capabilities?.identity.control.productVersion ?? 'unknown'} (control-lobby-options-unsupported).`,
            }),
          );
          return;
        }
        const unverifiedProductVersion = unverifiedLiveGameVersion(session);
        if (unverifiedProductVersion) {
          appendControlOutput(unverifiedLiveGameMessage(unverifiedProductVersion));
        }
        let replaceActiveMatch = false;
        if (session.endpoint?.match.active) {
          if (!hasAcceptedActiveMatchReplacement(window.localStorage)) {
            const choice = await workspace.requestConfirmation({
              title: t('live-test.replace-match.title'),
              description: t('live-test.replace-match.description'),
              primaryLabel: t('live-test.replace-match.confirm'),
              primaryVariant: 'warning',
              initialFocus: 'primary',
            });
            if (choice !== 'primary') {
              appendControlOutput(presentMessage({ source: 'Live test', code: 'live.match-kept' }));
              return;
            }
            if (!rememberActiveMatchReplacement(window.localStorage)) {
              appendControlOutput(
                presentMessage({ source: 'Live test', code: 'live.permission-not-saved' }),
              );
              return;
            }
          }
          replaceActiveMatch = true;
        }

        request = {
          ...request,
          replaceActiveMatch,
        };
        activeLiveRequestId.current = request.requestId;
        const synchronized = await window.rmside.runControlLiveTest(request);
        advanceLiveTestProgress({ kind: 'verified' });
        appendControlOutput(
          liveWorkflowMessage({
            kind: 'effective-readback',
            seed: synchronized.seed,
            matchEpoch: synchronized.matchEpoch,
            ...(unverifiedProductVersion ? { unverifiedProductVersion } : {}),
          }),
        );
        setControlSession(await window.rmside.getControlSessionStatus());
      } catch (error) {
        appendControlOutput(liveFailureMessage(error));
        await refreshControlStatus().catch(() => undefined);
      } finally {
        liveOutputRunId.current = null;
        activeLiveRequestId.current = null;
        controlBusyRef.current = false;
        setControlBusy(false);
        advanceLiveTestProgress({ kind: 'ended' });
      }
    },
    [advanceLiveTestProgress, appendControlOutput, refreshControlStatus, t, workspace],
  );
  committedLivePreviewHandler.current = (result) => void executeCommittedLiveRun(result);

  const runLive = useCallback(
    (trigger: RunTrigger) => {
      if (
        blockingReason ||
        runState === 'running' ||
        executionState.phase !== 'idle' ||
        controlBusyRef.current ||
        controlLauncher.state !== 'ready' ||
        !selectedInstallation ||
        !effectiveConfiguration
      ) {
        return;
      }
      const requestedConfiguration = effectiveConfiguration.seedLocked
        ? effectiveConfiguration
        : withSeed(effectiveConfiguration, randomSeed());
      if (!effectiveConfiguration.seedLocked) {
        setConfiguration((current) =>
          current
            ? {
                ...requestedConfiguration,
                profileId: current.profileId,
                profileInstallation: current.profileInstallation,
                computerPlayers: current.computerPlayers,
              }
            : current,
        );
      }
      const document = { ...currentDocument.current };
      activeLiveBackend.current = {};
      liveCoordinator.current?.clearCache();
      const generationSettingsKey = scheduleGeneration(trigger, requestedConfiguration);
      const outputRunId = generationSettingsKey ? lastScheduledOutputRunId.current : null;
      liveOutputRunId.current = outputRunId;
      pendingLiveRun.current = generationSettingsKey
        ? {
            outputRunId,
            requestId: `live-${Date.now()}-${crypto.randomUUID()}`,
            configuration: structuredClone(requestedConfiguration),
            documentUri: document.uri,
            documentRevision: document.revision,
            generationSettingsKey,
          }
        : null;
      if (generationSettingsKey) advanceLiveTestProgress({ kind: 'initiated' });
    },
    [
      advanceLiveTestProgress,
      blockingReason,
      controlLauncher.state,
      effectiveConfiguration,
      executionState.phase,
      runState,
      scheduleGeneration,
      selectedInstallation,
    ],
  );

  const runSelectedMode = useCallback(
    (trigger: RunTrigger) => {
      if (isMapTestScriptName(executionDocument.name)) void runMapTest(trigger);
      else if (liveTestOnRun) runLive(trigger);
      else runPreview(trigger);
    },
    [executionDocument.name, liveTestOnRun, runLive, runMapTest, runPreview],
  );

  const useLocalVersion = useCallback(() => {
    pendingVersionRecoveryRun.current = true;
    setGenerationRefusedStandardInclude(false);
    setConfiguration((current) =>
      current ? { ...current, ...profileSelectionChange('auto', null) } : current,
    );
    appendOutput(
      outputNote('Preview', 'preview.local-version', { id: 'run-menu.version.local-selected' }),
    );
  }, [appendOutput]);
  useEffect(() => {
    if (!pendingVersionRecoveryRun.current) return;
    if (versionOrigin !== 'local') return;
    if (blockingReason || runState === 'running' || executionState.phase !== 'idle') return;
    pendingVersionRecoveryRun.current = false;
    if (isMapTestScriptName(executionDocument.name)) void runMapTest('explicit');
    else runPreview('explicit', true);
  }, [
    blockingReason,
    executionDocument.name,
    executionState.phase,
    runMapTest,
    runPreview,
    runState,
    versionOrigin,
  ]);

  const toggleLiveTestOnRun = useCallback(() => {
    if (controlLauncher.state !== 'ready' || !selectedInstallation) return;
    setLiveTestOnRun((current) => !current);
  }, [controlLauncher.state, selectedInstallation]);

  const toggleSeedMode = useCallback(() => {
    setConfiguration((current) =>
      current ? { ...current, seedLocked: !current.seedLocked } : current,
    );
  }, []);

  const toggleRunOnSave = useCallback(() => {
    setConfiguration((current) =>
      current ? { ...current, runOnSave: !current.runOnSave } : current,
    );
  }, []);

  const toggleRunOnEdit = useCallback(() => {
    setConfiguration((current) =>
      current ? { ...current, runOnEdit: !current.runOnEdit } : current,
    );
  }, []);

  const setMapTestWorkers = useCallback((mapTestWorkers: MapTestWorkerSetting) => {
    if (!isMapTestWorkerSetting(mapTestWorkers)) return;
    setConfiguration((current) => (current ? { ...current, mapTestWorkers } : current));
  }, []);

  const clearPreviewCache = useCallback(() => {
    liveCoordinator.current?.clearCache();
    setCacheDiagnostics(previewCache.current.diagnostics());
    appendOutput(outputNote('Preview', 'preview.cache-cleared', { id: 'run-menu.cache-cleared' }));
  }, [appendOutput]);

  useEffect(() => {
    const previous = previousAutomaticGenerationInput.current;
    const current = {
      configurationIdentity: automaticConfigurationIdentity,
      content: executionDocument.content,
      documentId: executionDocument.id,
      uri: executionDocument.uri,
    };
    previousAutomaticGenerationInput.current = current;
    if (previous.documentId !== current.documentId || previous.uri !== current.uri) return;
    const contentChanged = previous.content !== current.content;
    const configurationChanged = previous.configurationIdentity !== current.configurationIdentity;
    if (!contentChanged && !configurationChanged) return;
    if (configurationChanged && !contentChanged && suppressNextAutomaticGeneration.current) {
      suppressNextAutomaticGeneration.current = false;
      return;
    }
    const active = activeLiveBackend.current;
    const action = automaticGenerationAction({
      contentChanged,
      configurationChanged,
      runOnEdit: configuration?.runOnEdit === true,
      previewActive: Boolean(active && effectiveConfiguration),
      execution: executionState,
      ownPreviewExecution:
        executionState.phase !== 'idle' &&
        executionState.executionId === activePreviewExecutionId.current,
      documentRunnable: automaticRunAllowed.current(Boolean(active?.fixtureId)),
    });
    if (action === 'none' || !active || !effectiveConfiguration) return;
    if (action === 'defer') {
      automaticGenerationDeferred.current = true;
      return;
    }
    const scheduled = scheduleGeneration(
      'automatic',
      effectiveConfiguration,
      active.fixtureId,
      livePreviewEditDebounceMilliseconds,
      true,
      undefined,
      action === 'supersede',
    );
    if (scheduled && action === 'supersede' && pendingLiveRun.current) {
      const pending = pendingLiveRun.current;
      pendingLiveRun.current = null;
      liveOutputRunId.current = null;
      setLiveTestProgress((current) => nextLiveTestProgress(current, { kind: 'ended' }));
      appendRunOutputRef.current(
        pending.outputRunId,
        presentMessage({ source: 'Live test', code: 'live.stopped.source-changed' }),
      );
    }
  }, [
    automaticConfigurationIdentity,
    configuration?.runOnEdit,
    effectiveConfiguration,
    executionDocument.content,
    executionDocument.id,
    executionDocument.uri,
    executionState,
    scheduleGeneration,
  ]);

  useEffect(() => {
    if (!automaticGenerationDeferred.current || executionState.phase !== 'idle') return;
    automaticGenerationDeferred.current = false;
    const active = activeLiveBackend.current;
    if (!active || !effectiveConfiguration) return;
    if (!automaticRunAllowed.current(Boolean(active.fixtureId))) return;
    scheduleGeneration(
      'automatic',
      effectiveConfiguration,
      active.fixtureId,
      livePreviewEditDebounceMilliseconds,
      true,
    );
  }, [effectiveConfiguration, executionState.phase, scheduleGeneration]);

  useEffect(() => {
    if (!effectiveConfiguration) return undefined;
    return window.rmside.onNativeEvent((status) => {
      const active = activeLiveBackend.current;
      if (status.name === 'rms-ls' && (status.state === 'stopped' || status.state === 'failed'))
        liveCoordinator.current?.sourceInvalidated();
      if (
        (status.name !== 'rmsd' && status.name !== 'rms-ls') ||
        status.state !== 'running' ||
        !active
      )
        return;
      if (!automaticRunAllowed.current(Boolean(active.fixtureId))) return;
      scheduleGeneration('automatic', effectiveConfiguration, active.fixtureId);
    });
  }, [effectiveConfiguration, scheduleGeneration]);

  useEffect(
    () =>
      window.rmside.onPreviewGenerationEvent((event) => {
        pendingGenerationEvent.current = event;
        if (generationProgressFrame.current === null) {
          generationProgressFrame.current = window.requestAnimationFrame(() => {
            generationProgressFrame.current = null;
            const latest = pendingGenerationEvent.current;
            pendingGenerationEvent.current = null;
            if (latest) setGenerationEvent(latest);
          });
        }
      }),
    [],
  );

  useEffect(
    () => () => {
      liveCoordinator.current?.cancel();
      pendingLiveRun.current = null;
      const requestId = activeLiveRequestId.current;
      if (requestId) void window.rmside.cancelControlLiveTest(requestId).catch(() => false);
      if (generationProgressFrame.current !== null) {
        window.cancelAnimationFrame(generationProgressFrame.current);
      }
    },
    [],
  );

  const activeFixtureId = activeLiveBackend.current?.fixtureId;
  const status = useMemo(
    () =>
      liveStatus && effectiveConfiguration
        ? {
            ...liveStatus,
            backendIdentity: activeFixtureId
              ? `synthetic:development-fixture-v1:${activeFixtureId}`
              : `exact:${effectiveConfiguration.profileId}`,
            profileId: effectiveConfiguration.profileId,
            seed: effectiveConfiguration.seed,
            settings: t('run-menu.status.settings', {
              size: effectiveConfiguration.mapSize,
              count: effectiveConfiguration.playerCount,
            }),
            uncertified: Boolean(activeFixtureId),
            ...(!activeFixtureId && generationCertificationLabel(committedCertification)
              ? { certification: generationCertificationLabel(committedCertification)! }
              : {}),
            ...(generationEvent ? { generationEvent } : {}),
          }
        : null,
    [
      activeFixtureId,
      committedCertification,
      effectiveConfiguration,
      generationEvent,
      liveStatus,
      t,
    ],
  );
  const versionNotice = useMemo(
    () =>
      standardIncludeCause
        ? { cause: standardIncludeCause.cause, action: standardIncludeCause.action }
        : null,
    [standardIncludeCause],
  );
  const unverifiedVersionDescription = unverifiedLocalVersion
    ? t('run-menu.version.unverified-description', {
        version: unverifiedLocalVersion,
        profile: effectiveConfiguration
          ? effectiveConfiguration.profileId
          : t('run-menu.version.profile-unavailable'),
        url: externalLinkUrls['rmside-issues'],
      })
    : null;
  const control = useMemo(
    () => controlPresentation(controlLauncher, controlSession),
    [controlLauncher, controlSession, t],
  );
  const controlAction = useMemo(
    () =>
      liveControlAction({
        connectionState: control.connectionState,
        detaching: controlDetaching,
        operationBusy: controlBusy,
      }),
    [control.connectionState, controlBusy, controlDetaching],
  );
  const currentMatchSeed = useMemo(
    () => matchSeedAvailability(controlLauncher, controlSession),
    [controlLauncher, controlSession, t],
  );
  const canAdoptMatchSeed =
    !controlBusy && controlLauncher.state === 'ready' && currentMatchSeed.available;
  const adoptMatchSeedBlockingReason = controlBusy
    ? t('live-test.seed.busy')
    : currentMatchSeed.reason;
  const settingsLoaded = configuration !== null;

  useEffect(() => {
    setPreviewExecution({
      blockingReason,
      canRun:
        !blockingReason &&
        runState !== 'running' &&
        executionState.phase === 'idle' &&
        (isMapTestScriptName(executionDocument.name) ||
          !liveTestOnRun ||
          (!controlBusy && Boolean(selectedInstallation))) &&
        Boolean(effectiveConfiguration),
      controlSelectionBusy,
      gameInstallationBusy: installationBusy,
      gameInstallationReady: Boolean(selectedInstallation),
      gameInstallationSelectionBusy: installationSelectionBusy,
      liveTestOnRun,
      runOnEdit: configuration?.runOnEdit ?? false,
      runOnSave: configuration?.runOnSave ?? false,
      mapTestWorkers: configuration?.mapTestWorkers ?? 'auto',
      setMapTestWorkers,
      run: () => runSelectedMode('explicit'),
      explainBlockedRun,
      runSource,
      reusableCommittedResult,
      stop: stopExecution,
      runState:
        executionState.phase === 'idle' || executionState.kind === 'map-icon'
          ? runState
          : 'running',
      executionState,
      seed: configuration?.seed ?? 0,
      seedLocked: configuration?.seedLocked ?? false,
      settingsLoaded,
      status,
      cacheDiagnostics,
      completedRunSequence,
      clearPreviewCache,
      developmentFixtures,
      control,
      controlAction,
      canAdoptMatchSeed,
      adoptMatchSeedBlockingReason,
      adoptMatchSeed: () => void adoptMatchSeed(),
      detachControl: () => void detachControl(),
      forgetControl: () => void forgetControl(),
      selectControl: () => void selectControl(),
      selectGameFolder: () => pickManualInstallationRef.current(),
      versionNotice,
      unverifiedVersionDescription,
      useLocalVersion,
      setSeed,
      runDevelopmentFixture,
      toggleLiveTestOnRun,
      toggleRunOnEdit,
      toggleRunOnSave,
      toggleSeedMode,
    });
    return () => setPreviewExecution(null);
  }, [
    adoptMatchSeed,
    adoptMatchSeedBlockingReason,
    blockingReason,
    cacheDiagnostics,
    canAdoptMatchSeed,
    clearPreviewCache,
    configuration?.mapTestWorkers,
    configuration?.runOnEdit,
    configuration?.runOnSave,
    configuration?.seed,
    configuration?.seedLocked,
    control,
    controlAction,
    controlBusy,
    controlSelectionBusy,
    completedRunSequence,
    detachControl,
    developmentFixtures,
    effectiveConfiguration,
    executionDocument.name,
    executionState,
    explainBlockedRun,
    forgetControl,
    installationBusy,
    installationSelectionBusy,
    liveTestOnRun,
    runDevelopmentFixture,
    reusableCommittedResult,
    runSelectedMode,
    runSource,
    runState,
    setPreviewExecution,
    selectControl,
    selectedInstallation,
    setMapTestWorkers,
    setSeed,
    settingsLoaded,
    status,
    stopExecution,
    toggleLiveTestOnRun,
    toggleRunOnEdit,
    toggleRunOnSave,
    toggleSeedMode,
    unverifiedVersionDescription,
    useLocalVersion,
    versionNotice,
  ]);

  useEffect(() => {
    const save = workspace.lastSave;
    if (!save || save.sequence <= handledSaveSequence.current) return;
    handledSaveSequence.current = save.sequence;
    if (!configuration?.runOnSave || save.documentId !== executionDocument.id) return;
    runSelectedMode('automatic');
  }, [configuration?.runOnSave, executionDocument.id, runSelectedMode, workspace.lastSave]);

  const detectInstallations = useCallback(async () => {
    setInstallationBusy(true);
    try {
      setSelectedInstallation(await discoverGameInstallation());
    } catch {
      setSelectedInstallation(null);
    } finally {
      setInstallationBusy(false);
    }
  }, []);

  const pickManualInstallation = useCallback(async () => {
    setInstallationBusy(true);
    setInstallationSelectionBusy(true);
    try {
      const report = await pickGameInstallation();
      if (report) {
        if (isUsableInstallation(report)) {
          setSelectedInstallation(report);
          setConfiguration((current) =>
            current ? { ...current, ...profileSelectionChange('auto', null) } : current,
          );
          appendOutput(
            outputNote(
              'Game folder',
              'game-folder.linked',
              report.evidence.productVersion
                ? {
                    id: 'run-menu.game-folder.linked-version',
                    args: { version: report.evidence.productVersion.value },
                  }
                : { id: 'run-menu.game-folder.linked' },
            ),
          );
        } else {
          appendOutput(refusedGameFolderMessage(report));
        }
      }
    } catch (error) {
      appendOutput(
        presentMessage({
          source: 'Game folder',
          raw: errorMessage(error),
          fallbackHeadline: 'message.fallback.game-folder',
        }),
      );
    } finally {
      setInstallationBusy(false);
      setInstallationSelectionBusy(false);
    }
  }, [appendOutput]);
  pickManualInstallationRef.current = () => void pickManualInstallation();

  useEffect(() => {
    if (installationDiscoveryStarted.current) return;
    installationDiscoveryStarted.current = true;
    void detectInstallations();
  }, [detectInstallations]);

  useEffect(
    () => onGameInstallationChanged(() => void detectInstallations()),
    [detectInstallations],
  );

  if (!catalog || !configuration) return null;

  const update = (changes: Partial<RunConfiguration>) =>
    setConfiguration((current) => (current ? { ...current, ...changes } : current));
  const selectPreset = (name: string) => {
    const preset = presets.find((candidate) => candidate.name === name);
    if (!preset) return;
    setActivePresetName(name);
    setConfiguration((current) => ({
      ...preset.configuration,
      recentSeeds: current?.recentSeeds ?? [preset.configuration.seed],
      mapTestWorkers: current?.mapTestWorkers ?? preset.configuration.mapTestWorkers,
    }));
  };
  const createPreset = (requestedName: string): boolean => {
    const nextName = requestedName.trim();
    if (!nextName || nextName.length > 64) {
      appendOutput(
        outputNote(
          'Preview',
          'preview.preset-name-length',
          { id: 'run-menu.preset.name-length' },
          { severity: 'warning' },
        ),
      );
      return false;
    }
    if (
      presets.some(
        (preset) => preset.name.localeCompare(nextName, undefined, { sensitivity: 'base' }) === 0,
      )
    ) {
      appendOutput(
        outputNote(
          'Preview',
          'preview.preset-exists',
          { id: 'run-menu.preset.exists', args: { name: nextName } },
          { severity: 'warning' },
        ),
      );
      return false;
    }
    if (presets.length >= 64) {
      appendOutput(
        outputNote(
          'Preview',
          'preview.preset-limit',
          { id: 'run-menu.preset.limit' },
          { severity: 'warning' },
        ),
      );
      return false;
    }
    setPresets((current) => [...current, runPreset(nextName, configuration)]);
    setActivePresetName(nextName);
    return true;
  };
  const renamePreset = (name: string, requestedName: string): boolean => {
    const nextName = requestedName.trim();
    if (!nextName || nextName.length > 64) {
      appendOutput(
        outputNote(
          'Preview',
          'preview.preset-name-length',
          { id: 'run-menu.preset.name-length' },
          { severity: 'warning' },
        ),
      );
      return false;
    }
    if (
      presets.some(
        (preset) =>
          preset.name !== name &&
          preset.name.localeCompare(nextName, undefined, { sensitivity: 'base' }) === 0,
      )
    ) {
      appendOutput(
        outputNote(
          'Preview',
          'preview.preset-exists',
          { id: 'run-menu.preset.exists', args: { name: nextName } },
          { severity: 'warning' },
        ),
      );
      return false;
    }
    setPresets((current) =>
      current.map((preset) => (preset.name === name ? { ...preset, name: nextName } : preset)),
    );
    if (activePresetName === name) setActivePresetName(nextName);
    return true;
  };
  const deletePreset = async (name: string) => {
    const choice = await workspace.requestConfirmation({
      title: t('run-menu.preset.delete.title', { name }),
      description: t('run-menu.preset.delete.description'),
      primaryLabel: t('run-menu.preset.delete.confirm'),
      destructive: true,
      initialFocus: 'primary',
    });
    if (choice !== 'primary') return;
    const remaining = presets.filter((preset) => preset.name !== name);
    if (remaining.length === 0) {
      const defaultName = defaultRunPresetName();
      setPresets([runPreset(defaultName, configuration)]);
      setActivePresetName(defaultName);
    } else {
      setPresets(remaining);
      if (activePresetName === name) {
        const nextPreset = remaining[0]!;
        setActivePresetName(nextPreset.name);
        setConfiguration((current) => ({
          ...nextPreset.configuration,
          recentSeeds: current?.recentSeeds ?? [nextPreset.configuration.seed],
        }));
      }
    }
  };

  return (
    <>
      {presetControlHost
        ? createPortal(
            <PreviewPresetControls
              activePresetName={activePresetName}
              civilizationOptions={packedCivilizationOptions(
                effectiveConfiguration?.profileId ?? null,
                civilizationProductVersion,
              )}
              configuration={configuration}
              liveTestOnRun={liveTestOnRun}
              onCreatePreset={createPreset}
              onDeletePreset={(name) => deletePreset(name)}
              onRenamePreset={renamePreset}
              onSelectMapSize={(mapSize) =>
                setConfiguration((current) => (current ? withMapSize(current, mapSize) : current))
              }
              onSelectPreset={selectPreset}
              onUpdate={update}
              presets={presets}
            />,
            presetControlHost,
          )
        : null}
      {versionControlHost
        ? createPortal(<MapTestProgressBar store={mapTestProgress} />, versionControlHost)
        : null}
      {versionControlHost
        ? createPortal(<LiveTestProgressBar progress={liveTestProgress} />, versionControlHost)
        : null}
      {versionControlHost
        ? createPortal(
            <PreviewVersionSelect
              busy={installationBusy}
              catalog={catalog}
              localInstallationSelected={Boolean(selectedInstallation)}
              localProductVersion={detectedProductVersion}
              onSelectFolder={() => void pickManualInstallation()}
              onSelectProfile={(profileId) =>
                update(profileSelectionChange(profileId, installationKey))
              }
              selectedProfileId={selectedProfileId ?? configuration.profileId}
            />,
            versionControlHost,
          )
        : null}
    </>
  );
}

function PreviewPresetControls({
  activePresetName,
  civilizationOptions,
  configuration,
  liveTestOnRun,
  onCreatePreset,
  onDeletePreset,
  onRenamePreset,
  onSelectMapSize,
  onSelectPreset,
  onUpdate,
  presets,
}: {
  activePresetName: string;
  civilizationOptions: readonly PackedCivilizationOption[];
  configuration: RunConfiguration;
  liveTestOnRun: boolean;
  onCreatePreset(name: string): boolean;
  onDeletePreset(name: string): void;
  onRenamePreset(name: string, nextName: string): boolean;
  onSelectMapSize(mapSize: RunConfiguration['mapSize']): void;
  onSelectPreset(name: string): void;
  onUpdate(changes: Partial<RunConfiguration>): void;
  presets: RunPreset[];
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [playersOpen, setPlayersOpen] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const [editingPresetName, setEditingPresetName] = useState<string | null>(null);
  const [presetNameDraft, setPresetNameDraft] = useState('');
  const [newPresetNameDraft, setNewPresetNameDraft] = useState<string | null>(null);
  const newPresetNameInput = useRef<HTMLInputElement | null>(null);
  const newPresetFinalized = useRef(false);
  const presetMenuIcon = useAnimatedIconHover();
  const { t } = useI18n();
  const commitRename = () => {
    if (!editingPresetName) return;
    if (onRenamePreset(editingPresetName, presetNameDraft)) {
      const focusKey = presetNameDraft.trim().toLowerCase();
      setEditingPresetName(null);
      window.setTimeout(() => {
        const presetButton = Array.from(
          document.querySelectorAll<HTMLButtonElement>('.preview-preset-select'),
        ).find((button) => button.dataset.presetFocusKey === focusKey);
        presetButton?.focus({ preventScroll: true });
      }, 0);
    }
  };
  const beginPresetCreation = () => {
    newPresetFinalized.current = false;
    setNewPresetNameDraft(nextRunPresetName(presets));
    setManagerOpen(false);
  };
  const finishPresetCreation = () => {
    if (newPresetFinalized.current || newPresetNameDraft === null) return;
    if (!onCreatePreset(newPresetNameDraft)) {
      queueMicrotask(() => newPresetNameInput.current?.focus());
      return;
    }
    newPresetFinalized.current = true;
    setNewPresetNameDraft(null);
    setSettingsOpen(true);
  };
  const cancelPresetCreation = () => {
    if (newPresetNameDraft === null) return;
    newPresetFinalized.current = true;
    setNewPresetNameDraft(null);
    setManagerOpen(true);
  };
  const updatePlayerValue = (
    field: 'playerSlots' | 'playerColors' | 'civilizationIds' | 'teamIds',
    index: number,
    value: number,
  ) => {
    const values = configuration[field].map((current, currentIndex) =>
      currentIndex === index ? value : current,
    );
    onUpdate({ [field]: values });
  };
  const togglePlayerController = (index: number) => {
    onUpdate({
      computerPlayers: configuration.computerPlayers.map((current, currentIndex) =>
        currentIndex === index ? !current : current,
      ),
    });
  };
  return (
    <>
      {newPresetNameDraft === null ? (
        <DropdownMenu
          modal={false}
          onOpenChange={(open) => {
            setSettingsOpen(open);
            if (!open) setPlayersOpen(false);
          }}
          open={settingsOpen}
        >
          <DropdownMenuTrigger
            render={
              <Button
                aria-label={t('run-menu.preset.settings')}
                className="preview-preset-trigger"
                variant="ghost"
              />
            }
          >
            <span>{activePresetName}</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            alignOffset={-32}
            className="preview-preset-menu"
            side="bottom"
          >
            <CompactSelect
              ariaLabel={t('run-menu.map-size')}
              className="preview-preset-option"
              fitAllOptions
              onValueChange={(value) => onSelectMapSize(value as RunConfiguration['mapSize'])}
              options={runMapSizeOptions.map((option) => ({
                value: option.value,
                label: t('game-options.map-size.option', {
                  size: option.label,
                  width: option.width,
                  height: option.height,
                }),
              }))}
              value={configuration.mapSize}
            />
            <div className="preview-player-count-row">
              <DropdownMenu modal={false} onOpenChange={setPlayersOpen} open={playersOpen}>
                <DropdownMenuTrigger
                  render={
                    <Button
                      aria-label={t('run-menu.players.configure')}
                      aria-pressed={playersOpen}
                      className="preview-player-menu-trigger"
                      size="icon"
                      variant="ghost"
                    />
                  }
                >
                  <UserRound aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  className="preview-player-menu"
                  collisionAvoidance={{ side: 'shift', align: 'shift', fallbackAxisSide: 'none' }}
                  side="left"
                  sideOffset={6}
                >
                  {Array.from({ length: configuration.playerCount }, (_, index) => {
                    const occupiedSlots = new Set(
                      configuration.playerSlots
                        .slice(0, configuration.playerCount)
                        .filter((_, currentIndex) => currentIndex !== index),
                    );
                    const occupiedColors = new Set(
                      configuration.playerColors
                        .slice(0, configuration.playerCount)
                        .filter((_, currentIndex) => currentIndex !== index),
                    );
                    return (
                      <div className="preview-player-row" key={index}>
                        <CompactSelect
                          ariaLabel={t('run-menu.players.slot', { player: index + 1 })}
                          className="preview-player-slot"
                          contentClassName="preview-player-option-menu"
                          onValueChange={(value) =>
                            updatePlayerValue('playerSlots', index, Number(value))
                          }
                          options={Array.from({ length: 8 }, (_, optionIndex) => ({
                            value: String(optionIndex + 1),
                            label: t('run-menu.players.slot-option', { slot: optionIndex + 1 }),
                            disabled: occupiedSlots.has(optionIndex + 1),
                          }))}
                          value={String(configuration.playerSlots[index])}
                        />
                        <CompactSelect
                          ariaLabel={t('run-menu.players.color', { player: index + 1 })}
                          className="preview-player-color"
                          contentClassName="preview-player-option-menu"
                          onValueChange={(value) =>
                            updatePlayerValue('playerColors', index, Number(value))
                          }
                          options={runPlayerColorOptions.map((option) => ({
                            value: String(option.value),
                            label: option.label,
                            disabled: occupiedColors.has(option.value),
                            swatch: option.color,
                          }))}
                          showSelectedLabel={false}
                          value={String(configuration.playerColors[index])}
                        />
                        <CompactSelect
                          ariaLabel={t('run-menu.players.civilization', { player: index + 1 })}
                          className="preview-player-civilization"
                          contentClassName="preview-player-civilization-menu"
                          onValueChange={(value) =>
                            updatePlayerValue('civilizationIds', index, Number(value))
                          }
                          options={civilizationOptions.map((option) => ({
                            value: String(option.id),
                            label: option.label,
                          }))}
                          value={String(
                            civilizationOptions.some(
                              (option) => option.id === configuration.civilizationIds[index],
                            ) || civilizationOptions.length <= 1
                              ? configuration.civilizationIds[index]
                              : 0,
                          )}
                        />
                        <CompactSelect
                          ariaLabel={t('run-menu.players.team', { player: index + 1 })}
                          className="preview-player-team"
                          contentClassName="preview-player-option-menu"
                          fitAllOptions
                          onValueChange={(value) =>
                            updatePlayerValue('teamIds', index, Number(value))
                          }
                          options={[
                            { value: '0', label: t('game-options.team.none') },
                            ...Array.from({ length: 4 }, (_, optionIndex) => ({
                              value: String(optionIndex + 1),
                              label: t('game-options.team.numbered', { team: optionIndex + 1 }),
                            })),
                          ]}
                          value={String(configuration.teamIds[index])}
                        />
                        {liveTestOnRun && configuration.playerSlots[index] !== 1 ? (
                          <IconToggleButton
                            aria-disabled="true"
                            aria-label={t('run-menu.players.computer', { player: index + 1 })}
                            className="preview-player-computer"
                            data-live-computer=""
                            pressed
                            size="icon"
                            title={t('run-menu.players.live-computer')}
                          >
                            <Bot aria-hidden="true" />
                          </IconToggleButton>
                        ) : (
                          <IconToggleButton
                            aria-label={t('run-menu.players.computer', { player: index + 1 })}
                            className="preview-player-computer"
                            onClick={() => togglePlayerController(index)}
                            pressed={configuration.computerPlayers[index] === true}
                            size="icon"
                            title={t('run-menu.players.computer-tooltip')}
                          >
                            <Bot aria-hidden="true" />
                          </IconToggleButton>
                        )}
                      </div>
                    );
                  })}
                  {liveTestOnRun && configuration.playerCount > 1 ? (
                    <p className="preview-menu-note" role="note">
                      {configuration.playerSlots.slice(0, configuration.playerCount).includes(1)
                        ? t('run-menu.players.live-note')
                        : t('run-menu.players.live-note.no-p1')}
                    </p>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
              <CompactSelect
                ariaLabel={t('run-menu.players.count')}
                className="preview-preset-option"
                fitAllOptions
                onValueChange={(value) => onUpdate(withPlayerCount(configuration, Number(value)))}
                options={Array.from({ length: 8 }, (_, index) => ({
                  value: String(index + 1),
                  label: t('run-menu.players.count-option', { count: index + 1 }),
                }))}
                value={String(configuration.playerCount)}
              />
            </div>
            <div className="preview-player-count-row">
              <LobbyOptionsMenu configuration={configuration} onUpdate={onUpdate} />
              <CompactSelect
                ariaLabel={t('run-menu.game-mode')}
                className="preview-preset-option"
                fitAllOptions
                onValueChange={(value) =>
                  onUpdate({ modeContext: value as RunConfiguration['modeContext'] })
                }
                options={runGameModeOptions.map((option) => option)}
                value={configuration.modeContext}
              />
            </div>
            {configuration.modeContext === 'turbo-random-map' ? (
              <div className="preview-menu-note preview-turbo-note" role="note">
                <p>{t('run-menu.turbo-note')}</p>
                <Button
                  onClick={() => onUpdate(withRandomMapTurbo(configuration))}
                  size="sm"
                  variant="secondary"
                >
                  {t('run-menu.turbo-note.use-turbo')}
                </Button>
              </div>
            ) : null}
            <CompactSelect
              ariaLabel={t('run-menu.starting-resources')}
              className="preview-preset-option"
              fitAllOptions
              onValueChange={(value) =>
                onUpdate({
                  startingResources: value as RunConfiguration['startingResources'],
                })
              }
              options={runStartingResourceOptions.map((option) => option)}
              value={configuration.startingResources}
            />
            <CompactSelect
              ariaLabel={t('run-menu.starting-age')}
              className="preview-preset-option"
              fitAllOptions
              onValueChange={(value) =>
                onUpdate({ startingAge: value as RunConfiguration['startingAge'] })
              }
              options={runStartingAgeOptions.map((option) => option)}
              value={configuration.startingAge}
            />
            <CompactSelect
              ariaLabel={t('run-menu.ending-age')}
              className="preview-preset-option"
              fitAllOptions
              onValueChange={(value) =>
                onUpdate({ endingAge: value as RunConfiguration['endingAge'] })
              }
              options={runStartingAgeOptions.map((option) => option)}
              value={configuration.endingAge}
            />
            <CompactSelect
              ariaLabel={t('run-menu.position-policy')}
              className="preview-preset-option"
              fitAllOptions
              onValueChange={(value) =>
                onUpdate({ positionPolicy: value as RunConfiguration['positionPolicy'] })
              }
              options={runPositionPolicyOptions.map((option) => option)}
              value={configuration.positionPolicy}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Input
          aria-label={t('run-menu.preset.new-name')}
          autoFocus
          className="preview-preset-create-input"
          maxLength={64}
          onBlur={finishPresetCreation}
          onChange={(event) => setNewPresetNameDraft(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter') {
              event.preventDefault();
              finishPresetCreation();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              cancelPresetCreation();
            }
          }}
          ref={newPresetNameInput}
          value={newPresetNameDraft}
        />
      )}
      <DropdownMenu
        modal={false}
        onOpenChange={(open) => {
          setManagerOpen(open);
          if (!open) setEditingPresetName(null);
        }}
        open={managerOpen}
      >
        <DropdownMenuTrigger
          render={
            <Button
              {...presetMenuIcon.animationHandlers}
              aria-label={t('run-menu.preset.manage')}
              className="preview-preset-manager-trigger"
              size="icon"
              variant="ghost"
            />
          }
        >
          <MenuIcon aria-hidden="true" ref={presetMenuIcon.iconRef} size={14} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="preview-preset-list-menu" side="bottom">
          {presets.map((preset) => {
            const active = preset.name === activePresetName;
            const editing = preset.name === editingPresetName;
            return (
              <div
                className="preview-preset-list-row"
                data-active={active || undefined}
                key={preset.name}
              >
                {editing ? (
                  <Input
                    aria-label={t('run-menu.preset.rename', { name: preset.name })}
                    autoFocus
                    className="preview-preset-name-input"
                    maxLength={64}
                    onChange={(event) => setPresetNameDraft(event.target.value)}
                    onFocus={(event) => event.currentTarget.select()}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        commitRename();
                      } else if (event.key === 'Escape') {
                        event.preventDefault();
                        setEditingPresetName(null);
                      }
                    }}
                    onKeyUp={(event) => {
                      if (event.key !== 'Enter' && event.key !== 'Escape') return;
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    value={presetNameDraft}
                  />
                ) : (
                  <Button
                    aria-pressed={active}
                    className="preview-preset-select"
                    data-preset-focus-key={preset.name.toLowerCase()}
                    onClick={() => {
                      onSelectPreset(preset.name);
                      setManagerOpen(false);
                    }}
                    variant="ghost"
                  >
                    <span>{preset.name}</span>
                    {active ? <Check aria-hidden="true" /> : null}
                  </Button>
                )}
                <Button
                  aria-label={
                    editing
                      ? t('run-menu.preset.save', { name: preset.name })
                      : t('run-menu.preset.edit', { name: preset.name })
                  }
                  className="preview-preset-row-action"
                  onClick={() => {
                    if (editing) {
                      commitRename();
                    } else {
                      setEditingPresetName(preset.name);
                      setPresetNameDraft(preset.name);
                    }
                  }}
                  size="icon-sm"
                  variant="ghost"
                >
                  {editing ? <Check aria-hidden="true" /> : <Pencil aria-hidden="true" />}
                </Button>
                <Button
                  aria-label={t('run-menu.preset.delete', { name: preset.name })}
                  className="preview-preset-row-action"
                  onClick={() => {
                    setManagerOpen(false);
                    onDeletePreset(preset.name);
                  }}
                  size="icon-sm"
                  variant="ghost"
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </div>
            );
          })}
          <DropdownMenuItem className="preview-preset-new" onClick={beginPresetCreation}>
            <Plus aria-hidden="true" />
            {t('run-menu.preset.new')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

const lobbyModifierTooltips: Record<(typeof gameModeModifierOptions)[number]['value'], MessageId> =
  {
    'empire-wars': 'run-menu.lobby.modifier.empire-wars.tooltip',
    'sudden-death': 'run-menu.lobby.modifier.sudden-death.tooltip',
    regicide: 'run-menu.lobby.modifier.regicide.tooltip',
    'king-of-the-hill': 'run-menu.lobby.modifier.king-of-the-hill.tooltip',
  };

const lobbyFlagOptions: readonly { flag: LobbyOptionFlag; label: MessageId; tooltip: MessageId }[] =
  [
    {
      flag: 'turboMode',
      label: 'game-options.flag.turbo',
      tooltip: 'run-menu.lobby.flag.turbo.tooltip',
    },
    {
      flag: 'fullTechTree',
      label: 'game-options.flag.full-tech-tree',
      tooltip: 'run-menu.lobby.flag.full-tech-tree.tooltip',
    },
    {
      flag: 'antiquityMode',
      label: 'game-options.flag.antiquity',
      tooltip: 'run-menu.lobby.flag.antiquity.tooltip',
    },
    {
      flag: 'solidFarms',
      label: 'game-options.flag.solid-farms',
      tooltip: 'run-menu.lobby.flag.solid-farms.tooltip',
    },
  ];

function LobbyOptionsMenu({
  configuration,
  onUpdate,
}: {
  configuration: RunConfiguration;
  onUpdate(changes: Partial<RunConfiguration>): void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const modifiers = activeGameModeModifiers(configuration);
  const selected =
    modifiers.length + lobbyFlagOptions.filter(({ flag }) => configuration[flag]).length;
  return (
    <DropdownMenu modal={false} onOpenChange={setOpen} open={open}>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={
              selected > 0
                ? t('run-menu.lobby.label.selected', { count: selected })
                : t('run-menu.lobby.label')
            }
            aria-pressed={open}
            className="preview-player-menu-trigger preview-lobby-options-trigger"
            data-selected={selected > 0 || undefined}
            size="icon"
            variant="ghost"
          />
        }
      >
        <SlidersHorizontal aria-hidden="true" />
        {selected > 0 ? (
          <span aria-hidden="true" className="preview-lobby-options-count">
            {selected}
          </span>
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="preview-lobby-options-menu"
        side="left"
        sideOffset={6}
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t('run-menu.lobby.modifiers')}</DropdownMenuLabel>
          {gameModeModifierOptions.map((option) => {
            const base = option.gameMode === configuration.modeContext;
            return (
              <LobbyOptionItem
                checked={modifiers.includes(option.value)}
                disabled={base}
                key={option.value}
                label={
                  base
                    ? t('run-menu.lobby.modifier.base', { mode: t(option.labelId) })
                    : t(option.labelId)
                }
                onCheckedChange={(checked) =>
                  onUpdate(withGameModeModifier(configuration, option.value, checked))
                }
                tooltip={t(lobbyModifierTooltips[option.value])}
              />
            );
          })}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t('run-menu.lobby.options')}</DropdownMenuLabel>
          {lobbyFlagOptions.map((option) => (
            <LobbyOptionItem
              checked={configuration[option.flag]}
              key={option.flag}
              label={t(option.label)}
              onCheckedChange={(checked) => onUpdate({ [option.flag]: checked })}
              tooltip={t(option.tooltip)}
            />
          ))}
        </DropdownMenuGroup>
        {modifiers.includes('regicide') ? (
          <p className="preview-menu-note" role="note">
            {t('run-menu.lobby.regicide-note')}
          </p>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LobbyOptionItem({
  checked,
  disabled = false,
  label,
  onCheckedChange,
  tooltip,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onCheckedChange(checked: boolean): void;
  tooltip: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <DropdownMenuCheckboxItem
            checked={checked}
            className="preview-lobby-option"
            closeOnClick={false}
            disabled={disabled}
            onCheckedChange={onCheckedChange}
          />
        }
      >
        {label}
      </TooltipTrigger>
      <TooltipContent side="left">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

const localProfileValue = '__local-profile__';
const selectGameFolderValue = '__select-game-folder__';

function PreviewVersionSelect({
  busy,
  catalog,
  localInstallationSelected,
  localProductVersion,
  onSelectFolder,
  onSelectProfile,
  selectedProfileId,
}: {
  busy: boolean;
  catalog: ConfigurationCatalog;
  localInstallationSelected: boolean;
  localProductVersion: string | null;
  onSelectFolder(): void;
  onSelectProfile(profileId: string): void;
  selectedProfileId: string;
}) {
  const { t } = useI18n();
  const profiles = profilesNewestFirst(catalog.behaviorProfiles);
  const resolvedProfile = resolvePreviewProfile(catalog, selectedProfileId, localProductVersion);
  const selectedValue =
    selectedProfileId === 'auto'
      ? localInstallationSelected
        ? localProfileValue
        : (resolvedProfile?.profileId ?? null)
      : selectedProfileId;
  const selectedLabel =
    selectedProfileId === 'auto' && localInstallationSelected
      ? localProductVersionLabel(catalog, localProductVersion)
      : resolvedProfile
        ? profileGameVersion(resolvedProfile)
        : t('run-menu.version.no-bundled');

  return (
    <Select
      modal={false}
      onValueChange={(next) => {
        if (!next) return;
        if (next === selectGameFolderValue) {
          onSelectFolder();
          return;
        }
        onSelectProfile(next === localProfileValue ? 'auto' : next);
      }}
      value={selectedValue}
    >
      <SelectTrigger
        aria-label={t('run-menu.version.preview-game-version')}
        className="preview-version-trigger"
      >
        <SelectValue>{selectedLabel}</SelectValue>
      </SelectTrigger>
      <SelectContent
        align="end"
        alignItemWithTrigger={false}
        className="preview-version-menu"
        collisionPadding={0}
        side="top"
      >
        {localInstallationSelected ? (
          <SelectItem value={localProfileValue}>
            {localProductVersionLabel(catalog, localProductVersion)}
          </SelectItem>
        ) : (
          <SelectGameFolderItem disabled={busy} value={selectGameFolderValue} />
        )}
        {profiles.length > 0 ? <SelectSeparator /> : null}
        {profiles.map((profile) => (
          <SelectItem key={profile.profileId} value={profile.profileId}>
            {profileGameVersion(profile)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function CompactSelect({
  ariaLabel,
  className,
  contentClassName,
  fitAllOptions = false,
  onValueChange,
  options,
  placeholder,
  showSelectedLabel = true,
  value,
}: {
  ariaLabel: string;
  className?: string;
  contentClassName?: string;
  fitAllOptions?: boolean;
  onValueChange(value: string): void;
  options: { value: string; label: string; disabled?: boolean; swatch?: string }[];
  placeholder?: string;
  showSelectedLabel?: boolean;
  value: string | null;
}) {
  const { t } = useI18n();
  const selectedOption = options.find((option) => option.value === value);
  return (
    <Select modal={false} onValueChange={(next) => next && onValueChange(next)} value={value}>
      <SelectTrigger aria-label={ariaLabel} className={className}>
        <SelectValue placeholder={placeholder ?? t('run-menu.select-placeholder')}>
          {selectedOption?.swatch ? (
            <span
              aria-hidden="true"
              className="preview-player-color-swatch"
              style={{ backgroundColor: selectedOption.swatch }}
            />
          ) : null}
          {showSelectedLabel && fitAllOptions ? (
            <span
              className="compact-select-fitted-label"
              data-option-labels={options.map((option) => option.label).join('\n')}
            >
              <span>{selectedOption?.label}</span>
            </span>
          ) : showSelectedLabel ? (
            selectedOption?.label
          ) : null}
        </SelectValue>
      </SelectTrigger>
      <SelectContent
        alignItemWithTrigger={false}
        className={`preview-preset-option-menu ${contentClassName ?? ''}`}
        collisionPadding={{ top: 44, right: 4, bottom: 4, left: 4 }}
      >
        {options.map((option) => (
          <SelectItem disabled={option.disabled} key={option.value} value={option.value}>
            {option.swatch ? (
              <span
                aria-hidden="true"
                className="preview-player-color-swatch"
                style={{ backgroundColor: option.swatch }}
              />
            ) : null}
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function installationContentFingerprint(report: InstallationReport | null): string | null {
  const revision = report?.evidence.contentRevision?.value;
  const match = revision?.match(/^sha256:([0-9a-f]{64});bytes:\d+$/u);
  return match?.[1] ?? null;
}

function parseLivePreviewAnalysis(value: unknown): LivePreviewAnalysis {
  const candidate = value as
    | (Partial<LivePreviewAnalysis> & {
        exactGenerationEligibility?: {
          supported?: unknown;
          code?: unknown;
          reason?: unknown;
        };
      })
    | null;
  if (
    !candidate ||
    typeof candidate.documentRevision !== 'string' ||
    typeof candidate.profileId !== 'string' ||
    typeof candidate.semanticHash !== 'string' ||
    typeof candidate.sourceCatalogProof !== 'string' ||
    !/^[0-9a-f-]{36}$/u.test(candidate.sourceCatalogProof) ||
    !/^[0-9a-f]{64}$/u.test(candidate.documentRevision) ||
    !/^[0-9a-f]{64}$/u.test(candidate.semanticHash) ||
    candidate.profileId.length === 0 ||
    !Array.isArray(candidate.operations)
  ) {
    throw new Error('language server returned an invalid strict semantic identity');
  }
  const eligibility = candidate.exactGenerationEligibility;
  if (
    !eligibility ||
    typeof eligibility.supported !== 'boolean' ||
    (eligibility.supported === false &&
      (typeof eligibility.code !== 'string' || typeof eligibility.reason !== 'string'))
  ) {
    throw new Error('language server returned an invalid generation eligibility');
  }
  if (!eligibility.supported) {
    throw new Error(`${eligibility.code}: ${eligibility.reason}`);
  }
  return {
    documentRevision: candidate.documentRevision,
    profileId: candidate.profileId,
    semanticHash: candidate.semanticHash,
    sourceCatalogProof: candidate.sourceCatalogProof,
    operations: candidate.operations.map(parseLivePreviewOperation),
  };
}

function parseLivePreviewOperation(
  value: unknown,
): PreviewGenerationResult['provenanceOperations'][number] {
  const candidate = value as Partial<
    PreviewGenerationResult['provenanceOperations'][number]
  > | null;
  if (
    !candidate ||
    typeof candidate.sourceId !== 'string' ||
    !Number.isSafeInteger(candidate.byteStart) ||
    !Number.isSafeInteger(candidate.byteEnd) ||
    (candidate.byteStart ?? -1) < 0 ||
    (candidate.byteEnd ?? -1) < (candidate.byteStart ?? 0) ||
    typeof candidate.operationIdentity !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(candidate.operationIdentity) ||
    !Array.isArray(candidate.includeChain) ||
    !candidate.includeChain.every((entry) => typeof entry === 'string') ||
    typeof candidate.displayName !== 'string'
  ) {
    throw new Error('language server returned invalid operation provenance');
  }
  return {
    sourceId: candidate.sourceId,
    byteStart: candidate.byteStart!,
    byteEnd: candidate.byteEnd!,
    operationIdentity: candidate.operationIdentity,
    includeChain: candidate.includeChain,
    displayName: candidate.displayName,
  };
}

function abortError(): Error {
  const error = new Error('preview generation was superseded');
  error.name = 'AbortError';
  return error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const syntaxErrorsBlockingReason: MessageId = 'run-menu.blocked.syntax-errors';

function standardIncludeNote(recovery: {
  cause: string;
  action: 'use-local-version' | 'link-game-folder' | null;
}): OutputMessage {
  const action: OutputText = {
    id:
      recovery.action === 'use-local-version'
        ? 'message.action.select-local-game-version'
        : recovery.action === 'link-game-folder'
          ? 'message.action.link-game-folder'
          : 'message.action.verify-game-files',
  };
  return outputNote(
    'Preview',
    'preview.standard-include',
    { id: 'run-menu.standard-include.headline' },
    { severity: 'warning', cause: recovery.cause, action: { text: action } },
  );
}

function standardIncludeAccessHint(
  access: StandardIncludeAccess | null,
): 'packaged-selection' | 'no-linked-installation' | 'missing-gamedata' | null {
  return access === 'packaged-selection' ||
    access === 'no-linked-installation' ||
    access === 'missing-gamedata'
    ? access
    : null;
}

function previewRunHeader(
  run: PreviewOutputRun,
  durationMs: number | undefined,
): Omit<OutputRunHeader, 'result' | 'resultLabel'> {
  return {
    kind: 'preview',
    script: run.script,
    seed: run.seed,
    size: run.size,
    players: run.players,
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

function runDuration(startedAt: number | undefined): number | undefined {
  return startedAt === undefined ? undefined : Math.max(0, performance.now() - startedAt);
}
