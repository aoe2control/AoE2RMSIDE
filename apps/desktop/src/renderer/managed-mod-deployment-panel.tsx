import {
  presentDeploymentFailure,
  presentMessage,
  userFacingErrorText,
} from '../shared/message-catalog';
import {
  outputMessageText,
  outputNote,
  wordOutputWords,
  type OutputWords,
} from '../shared/output-message';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
} from 'react';
import {
  CheckIcon as AnimatedCheckIcon,
  DropletIcon,
  EyeOffIcon,
  FolderOpenIcon,
  ImageIcon,
  LayoutGridIcon,
  MapIcon,
  MoveDiagonal2Icon,
  SunDimIcon,
} from '@animateicons/react/lucide';
import {
  Blend,
  ChevronUp,
  Copy,
  Diamond,
  Dices,
  Download,
  Footprints,
  Gem,
  Grid2x2,
  History,
  MapPinOff,
  Minus,
  PackagePlus,
  Plus,
  Trees,
  Undo2,
  X,
} from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  IconToggleButton,
  ToggleButtonCheck,
  toggleButtonProps,
} from '@/components/ui/toggle-button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  defaultMapIconRenderInput,
  mapIconArtDensity,
  mapIconArtSize,
  mapIconRenderContract,
  mapIconSpawnMarkerSizePercent,
  type InstallationReport,
  type ManagedDeploymentRequest,
  type ManualDeploymentContext,
  type ManualDeploymentMapIconPreview,
  type ManualDeploymentMapIconRequest,
  type ManualDeploymentModStatus,
  type ManualDeploymentPreview,
  type MapIconRenderInput,
  type MapIconSpawnMarkerStyle,
  type PreviewGenerationResult,
} from '../shared/api';
import { type AnimatedIconHandle, playIconAnimation, useAnimatedIconHover } from './animated-icon';
import { useAppPanelContext } from './app-context';
import { RunningIndicator } from './running-indicator';
import { SelectGameFolderButton } from './select-game-folder-button';
import {
  isUsableInstallation,
  pickGameInstallation,
  refusedGameFolderText,
} from './game-installation';
import {
  clampMapIconArtDensity,
  clampMapIconArtSize,
  gameTexturesDeploymentMapIcon,
  mapIconArtDensityEnds,
  mapIconArtDensityLabel,
  mapIconArtDensityValueText,
  mapIconArtSizeEnds,
  mapIconArtSizeLabel,
  mapIconArtSizeValueText,
  mapIconArtLayerActionLabel,
  mapIconArtLayerFields,
  mapIconArtLayerLabel,
  mapIconArtLayerOptionsLabel,
  mapIconArtSpawnOverlapLabel,
  mapIconFrameContent,
  mapIconFrameLabel,
  mapIconFrameState,
  mapIconReliefActionLabel,
  mapIconRandomSeedLabel,
  mapIconReliefLabel,
  mapIconRequestFor,
  mapIconSaveTarget,
  mapIconShowsGenerating,
  mapIconSourceDescription,
  mapIconSpawnMarkerSizeLabel,
  mapIconSpawnMarkersLabel,
  nextMapIconSpawnMarkers,
  mapIconSwitchDisabledReason,
  mapIconTerrainSmoothingLabel,
  mapIconTreeAnnotations,
  previewMatchesMapIconRequest,
  renderDeploymentMapIcon,
  resolveMapIconOption,
  stepMapIconSpawnMarkerSize,
  type DeploymentMapIcon,
} from './managed-mod-map-icon';
import {
  closedModNameField,
  copyPathAlignment,
  deploymentCertificationNote,
  deploymentConstructNote,
  deploymentModStatusLines,
  deploymentOutputMessages,
  deploymentPanelError,
  deploymentTargetDirectory,
  deploymentPreviewPhase,
  deploymentPreviewShown,
  deploymentSourceFailureMessage,
  deploymentSourceFailureOutput,
  deploymentSourceGuidance,
  editedModNameField,
  initialModNameField,
  managedModTreePending,
  pendingSourceRunSettlement,
  readEnableModPreference,
  suggestedModName,
  withSuggestedModName,
  writeEnableModPreference,
  type CopyPathAlignment,
  type DeploymentPreviewOutcome,
  type ModNameField,
} from './managed-mod-deployment-state';
import { useEasedHeight } from './eased-height';
import { useI18n } from './i18n';
import type { Translator } from '../shared/i18n/translator';
import { formatManagedModTree } from './managed-mod-tree';
import {
  effectiveMapIconLook,
  mapIconGameTexturesFallbackNote,
  mapIconLookLabel,
  mapIconLookTooltip,
  mapIconPerspectiveLabel,
  nextMapIconLook,
  useMapIconGameTextures,
  type MapIconLook,
} from './map-icon-game-textures';
import { MapIconRenderError } from './map-icon-render';
import {
  ExecutionProfilerStore,
  profilerBarKey,
  runBarPercent,
  runBarPhase,
} from './execution-profiler';
import { ExecutionProgressBar, useExecutionProgressBar } from './execution-progress-bar';
import { usePrefersReducedMotion } from './motion';
import {
  beginMapIconProgress,
  initialMapIconSeedState,
  mapIconSeedDisplay,
  mapIconSeedEntry,
  mapIconSeedReducer,
  MapIconSeedRunner,
  mapIconSourceResult,
  randomMapIconSeed,
  settleMapIconProgress,
  settledMapIconSeed,
  type MapIconSeedDisplay,
} from './map-icon-seed';
import {
  isPreviewScriptName,
  isStaleExactPreviewError,
  type PinnedPreviewSource,
} from './preview-execution';

const missingSourceUri = 'file:///no-open-rms-entry.rms';

interface PendingSourceRun {
  baselineSequence: number;
  sourceId: string;
  uri: string;
  started: boolean;
}

interface ReplacementConfirmation {
  modName: string;
  preview: ManualDeploymentPreview;
}

interface SuccessfulDeployment {
  targetPath: string;
  modStatus: ManualDeploymentModStatus | undefined;
}

interface DeploymentGraphInputs {
  context: ManualDeploymentContext;
  deployment: ManagedDeploymentRequest;
  modName: string;
  profileId: string;
}

interface DeploymentPreviewInputs extends DeploymentGraphInputs {
  mapIcon: ManualDeploymentMapIconRequest;
  graph: DeploymentGraphInputs;
}

type MapIconRenderState =
  | { status: 'idle' }
  | { status: 'rendering' }
  | { status: 'ready'; icon: DeploymentMapIcon }
  | { status: 'error'; raw: string };

type DeploymentProblem =
  | { kind: 'deployment'; raw: string }
  | { kind: 'refused-folder'; report: InstallationReport }
  | { kind: 'source-failed'; detail: string }
  | { kind: 'source-cancelled' }
  | { kind: 'text'; text: OutputWords };

type MapIconImage =
  { kind: 'pixels'; pixels: Uint8ClampedArray } | { kind: 'bitmap'; bitmap: ImageBitmap };

interface SettledIconPreview {
  token: string;
  mapIcon: ManualDeploymentMapIconPreview;
}

interface OriginalIconImage {
  token: string;
  bitmap: ImageBitmap | null;
}

export function ManagedModDeploymentPanel({
  onOpenChange,
  open,
  requestedSourceId,
}: {
  onOpenChange(open: boolean): void;
  open: boolean;
  requestedSourceId: string | null;
}) {
  const { appendOutput, map, pinnedPreviewSource, previewExecution, workspace } =
    useAppPanelContext();
  const { t } = useI18n();
  const sources = useMemo<PinnedPreviewSource[]>(
    () =>
      workspace.documents
        .filter((document) => isPreviewScriptName(document.name))
        .map(({ id, uri, name, content }) => ({ id, uri, name, content })),
    [workspace.documents],
  );
  const sourceIdentity = sources.map((source) => `${source.id}\0${source.uri}`).join('\n');
  const [selectedSourceId, setSelectedSourceId] = useState('');
  const selectedSource = sources.find((source) => source.id === selectedSourceId) ?? null;
  const [refreshSequence, setRefreshSequence] = useState(0);
  const [pendingSourceRun, setPendingSourceRun] = useState<PendingSourceRun | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [exactResult, setExactResult] = useState<PreviewGenerationResult | null>(null);
  const [exactResultReused, setExactResultReused] = useState(false);
  const [context, setContext] = useState<ManualDeploymentContext | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextLoaded, setContextLoaded] = useState(false);
  const [profileId, setProfileId] = useState('');
  const [modNameField, setModNameField] = useState<ModNameField>(initialModNameField);
  const modName = modNameField.value;
  const [previewOutcome, setPreviewOutcome] = useState<DeploymentPreviewOutcome<
    DeploymentPreviewInputs,
    ManualDeploymentPreview
  > | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<DeploymentProblem | null>(null);
  const [contextError, setContextError] = useState<DeploymentProblem | null>(null);
  const [sourceError, setSourceError] = useState<DeploymentProblem | null>(null);
  const [confirmation, setConfirmation] = useState<ReplacementConfirmation | null>(null);
  const [successfulDeployment, setSuccessfulDeployment] = useState<SuccessfulDeployment | null>(
    null,
  );
  const [enableMod, setEnableMod] = useState(() => readEnableModPreference(window.localStorage));
  const [openFolderBusy, setOpenFolderBusy] = useState(false);
  const [openTargetBusy, setOpenTargetBusy] = useState(false);
  const finishButton = useRef<HTMLButtonElement>(null);
  const [mapIconPreference, setMapIconPreference] = useState<boolean | null>(null);
  const [originalIconAvailable, setOriginalIconAvailable] = useState<boolean | null>(null);
  const [mapIconRender, setMapIconRender] = useState<MapIconRenderState>({ status: 'idle' });
  const [mapIconInput, setMapIconInput] = useState<MapIconRenderInput | null>(null);
  const [settledIconPreview, setSettledIconPreview] = useState<SettledIconPreview | null>(null);
  const [originalIconImage, setOriginalIconImage] = useState<OriginalIconImage | null>(null);
  const [iconLightboxOpen, setIconLightboxOpen] = useState(false);
  const [iconSaveBusy, setIconSaveBusy] = useState(false);
  const [iconSeed, dispatchIconSeed] = useReducer(mapIconSeedReducer, initialMapIconSeedState);
  const [editorSeed, setEditorSeed] = useState<number | null>(null);
  const [lastGeneratedPixels, setLastGeneratedPixels] = useState<Uint8ClampedArray | null>(null);
  const iconSeedRunner = useRef<MapIconSeedRunner | null>(null);
  const [iconProgress] = useState(() => new ExecutionProfilerStore());
  const openLargerButton = useRef<HTMLButtonElement>(null);
  const mapIconDescriptionId = useId();
  const mapIconSwitchReasonId = useId();
  const mapIconRequestSequence = useRef(0);
  const initializedOpen = useRef(false);
  const attemptedRefresh = useRef('');
  const reuseRefused = useRef(false);
  const contextRequestSequence = useRef(0);
  const profileIdRef = useRef(profileId);
  profileIdRef.current = profileId;
  const mapIconOption = useMemo(
    () => resolveMapIconOption(mapIconPreference, originalIconAvailable),
    [mapIconPreference, originalIconAvailable],
  );
  const mapIconMode = mapIconOption.mode;
  const iconSourceResult = useMemo(
    () => mapIconSourceResult(iconSeed, exactResult),
    [exactResult, iconSeed],
  );
  const gameTextures = useMapIconGameTextures({
    enabled: open && mapIconOption.checked && mapIconInput?.look === 'game-textures',
    result: iconSourceResult,
    input: mapIconInput,
  });
  const gameTexturesAvailable = gameTextures.offered && !gameTextures.failed;
  const effectiveIconInput = useMemo<MapIconRenderInput | null>(
    () =>
      mapIconInput
        ? { ...mapIconInput, look: effectiveMapIconLook(mapIconInput.look, gameTexturesAvailable) }
        : null,
    [gameTexturesAvailable, mapIconInput],
  );
  const gameTexturesRender = gameTextures.render;
  const requestMapIconRender =
    mapIconMode === 'generate' && mapIconRender.status === 'ready' ? mapIconRender.icon : null;
  const mapIcon = useMemo(
    () =>
      effectiveIconInput
        ? mapIconRequestFor(mapIconMode, requestMapIconRender, iconSourceResult, effectiveIconInput)
        : mapIconMode === 'generate'
          ? null
          : { mode: mapIconMode },
    [effectiveIconInput, iconSourceResult, mapIconMode, requestMapIconRender],
  );
  const deployment = useMemo(
    () =>
      exactResult ? deploymentRequest(exactResult, mapIconOption.mode === 'retain-original') : null,
    [exactResult, mapIconOption.mode],
  );
  const installationRequired = contextLoaded && context === null;
  const certificationNote = deploymentCertificationNote(exactResult?.certification);
  const constructNote = deploymentConstructNote(exactResult);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    void window.rmside
      .getMapIconRenderInput()
      .catch((): MapIconRenderInput => ({ ...defaultMapIconRenderInput }))
      .then((input) => {
        if (!cancelled) setMapIconInput((current) => current ?? input);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const resetForSource = useCallback((hasSource = true) => {
    setPendingSourceRun(null);
    setSourceLoading(hasSource);
    setExactResult(null);
    setExactResultReused(false);
    setOriginalIconAvailable(null);
    setSettledIconPreview(null);
    setPreviewOutcome(null);
    setConfirmation(null);
    setActionError(null);
    setSourceError(null);
    setRefreshSequence((current) => current + 1);
  }, []);

  useEffect(() => {
    if (!open) {
      initializedOpen.current = false;
      attemptedRefresh.current = '';
      reuseRefused.current = false;
      contextRequestSequence.current += 1;
      setPendingSourceRun(null);
      setSourceLoading(false);
      setExactResult(null);
      setExactResultReused(false);
      setContext(null);
      setContextLoaded(false);
      setPreviewOutcome(null);
      setConfirmation(null);
      setActionError(null);
      setContextError(null);
      setSourceError(null);
      setMapIconPreference(null);
      setOriginalIconAvailable(null);
      setSettledIconPreview(null);
      setIconLightboxOpen(false);
      setModNameField(closedModNameField);
      return;
    }
    if (initializedOpen.current) return;
    initializedOpen.current = true;
    const initial =
      sources.find((source) => source.id === requestedSourceId) ??
      preferredSource(sources, pinnedPreviewSource?.id ?? null, workspace.activeDocumentId);
    setSelectedSourceId(initial?.id ?? '');
    setSourceLoading(Boolean(initial));
    setRefreshSequence((current) => current + 1);
  }, [
    open,
    pinnedPreviewSource?.id,
    requestedSourceId,
    sourceIdentity,
    sources,
    workspace.activeDocumentId,
  ]);

  useEffect(() => {
    if (!open || !initializedOpen.current || !selectedSourceId) return;
    if (sources.some((source) => source.id === selectedSourceId)) return;
    const fallback = preferredSource(
      sources,
      pinnedPreviewSource?.id ?? null,
      workspace.activeDocumentId,
    );
    setSelectedSourceId(fallback?.id ?? '');
    resetForSource(Boolean(fallback));
  }, [
    open,
    pinnedPreviewSource?.id,
    resetForSource,
    selectedSourceId,
    sourceIdentity,
    sources,
    workspace.activeDocumentId,
  ]);

  const selectedSourceUri = selectedSource?.uri;
  const selectedSourceName = selectedSource?.name;
  useEffect(() => {
    if (!open || refreshSequence < 1) return;
    const requestSequence = ++contextRequestSequence.current;
    const source =
      selectedSourceUri !== undefined && selectedSourceName !== undefined
        ? { uri: selectedSourceUri, name: selectedSourceName }
        : null;
    setContextLoading(true);
    setContextLoaded(false);
    setContextError(null);
    void window.rmside
      .getManualDeploymentContext(selectedSourceUri ?? missingSourceUri)
      .then((next) => {
        if (requestSequence !== contextRequestSequence.current) return;
        setContext(next);
        setContextLoaded(true);
        if (next) {
          setOriginalIconAvailable((current) => current ?? next.originalMapIconAvailable);
          const retainedProfileId = next.profiles.some(
            (profile) => profile.profileId === profileIdRef.current,
          )
            ? profileIdRef.current
            : (next.selectedProfileId ?? '');
          setProfileId(retainedProfileId);
          profileIdRef.current = retainedProfileId;
          const suggestion = suggestedModName(next.ownedTargets, retainedProfileId, source);
          setModNameField((field) => withSuggestedModName(field, suggestion));
        } else {
          const suggestion = suggestedModName([], '', source);
          setModNameField((field) => withSuggestedModName(field, suggestion));
        }
      })
      .catch((loadError: unknown) => {
        if (requestSequence === contextRequestSequence.current) {
          setContext(null);
          setContextLoaded(true);
          setContextError({ kind: 'deployment', raw: errorMessage(loadError) });
        }
      })
      .finally(() => {
        if (requestSequence === contextRequestSequence.current) setContextLoading(false);
      });
  }, [open, refreshSequence, selectedSourceName, selectedSourceUri]);

  useEffect(() => {
    if (!open || !selectedSource || !previewExecution || refreshSequence < 1) return;
    const refreshIdentity = `${refreshSequence}\0${selectedSource.id}\0${selectedSource.uri}`;
    if (attemptedRefresh.current === refreshIdentity) return;
    const reusable = reuseRefused.current
      ? null
      : (previewExecution.reusableCommittedResult?.(selectedSource) ?? null);
    if (reusable && reusable.result === map) {
      attemptedRefresh.current = refreshIdentity;
      setExactResult(reusable.result);
      setExactResultReused(true);
      setEditorSeed(reusable.seed);
      setSourceLoading(false);
      appendOutput(
        outputNote('Deploy', 'deploy.preview-reused', {
          id: 'deploy-panel.output.preview-reused',
          args: { name: selectedSource.name },
        }),
      );
      return;
    }
    const acceptance = previewExecution.runSource(selectedSource);
    if (acceptance.status === 'blocked') {
      if (acceptance.retryable) return;
      attemptedRefresh.current = refreshIdentity;
      setSourceLoading(false);
      setSourceError({ kind: 'text', text: acceptance.reason });
      return;
    }
    attemptedRefresh.current = refreshIdentity;
    setPendingSourceRun({
      baselineSequence: previewExecution.completedRunSequence,
      sourceId: selectedSource.id,
      uri: selectedSource.uri,
      started: false,
    });
  }, [appendOutput, map, open, previewExecution, refreshSequence, selectedSource]);

  useEffect(() => {
    if (!pendingSourceRun || !previewExecution) return;
    const settlement = pendingSourceRunSettlement({
      started: pendingSourceRun.started,
      runState: previewExecution.runState,
      executionIdle: previewExecution.executionState.phase === 'idle',
      completedSinceScheduled:
        previewExecution.completedRunSequence > pendingSourceRun.baselineSequence,
      committedForSource: map?.documentUri === pendingSourceRun.uri,
    });
    switch (settlement) {
      case 'started':
        setPendingSourceRun((current) => (current ? { ...current, started: true } : current));
        return;
      case 'completed':
        setExactResult(map);
        setEditorSeed(previewExecution.seed);
        setPendingSourceRun(null);
        setSourceLoading(false);
        return;
      case 'failed': {
        setPendingSourceRun(null);
        setSourceLoading(false);
        const detail = previewExecution.status?.message ?? '';
        if (detail) appendOutput(deploymentSourceFailureOutput(detail));
        setSourceError({ kind: 'source-failed', detail });
        return;
      }
      case 'cancelled':
        setPendingSourceRun(null);
        setSourceLoading(false);
        setSourceError({ kind: 'source-cancelled' });
        return;
      default:
        return;
    }
  }, [appendOutput, map, pendingSourceRun, previewExecution]);

  useEffect(() => {
    iconSeedRunner.current?.cancel();
    iconProgress.end();
    dispatchIconSeed({ type: 'reset' });
    setLastGeneratedPixels(null);
  }, [exactResult, iconProgress, open]);

  useEffect(() => () => iconSeedRunner.current?.cancel(), []);

  useEffect(
    () =>
      window.rmside.onMapIconExecutionProgress((event) =>
        iconProgress.progress(event, performance.now()),
      ),
    [iconProgress],
  );

  useEffect(() => {
    const requestSequence = ++mapIconRequestSequence.current;
    if (!open || !iconSourceResult || !effectiveIconInput) {
      setMapIconRender({ status: 'idle' });
      return undefined;
    }
    const controller = new AbortController();
    setMapIconRender({ status: 'rendering' });
    if (effectiveIconInput.look === 'game-textures' && !gameTexturesRender) return undefined;
    (effectiveIconInput.look === 'game-textures' && gameTexturesRender
      ? gameTexturesDeploymentMapIcon(iconSourceResult, effectiveIconInput, gameTexturesRender)
      : renderDeploymentMapIcon(iconSourceResult, effectiveIconInput, controller.signal)
    )
      .then((icon) => {
        if (requestSequence === mapIconRequestSequence.current) {
          setMapIconRender({ status: 'ready', icon });
        }
      })
      .catch((renderError: unknown) => {
        if (
          requestSequence !== mapIconRequestSequence.current ||
          (renderError instanceof MapIconRenderError && renderError.code === 'cancelled')
        ) {
          return;
        }
        setMapIconRender({ status: 'error', raw: errorMessage(renderError) });
      });
    return () => controller.abort();
  }, [effectiveIconInput, gameTexturesRender, iconSourceResult, open]);

  const graphInputs = useMemo<DeploymentGraphInputs | null>(
    () =>
      open && deployment && context && profileId && !sourceLoading
        ? { context, deployment, modName, profileId }
        : null,
    [context, deployment, modName, open, profileId, sourceLoading],
  );
  const previewInputs = useMemo<DeploymentPreviewInputs | null>(
    () => (graphInputs && mapIcon ? { ...graphInputs, mapIcon, graph: graphInputs } : null),
    [graphInputs, mapIcon],
  );

  useEffect(() => {
    if (!previewInputs) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const { deployment, mapIcon, modName, profileId } = previewInputs;
      void window.rmside
        .previewManualDeployment({ deployment, profileId, modName, mapIcon })
        .then((next) => {
          if (cancelled) return;
          setPreviewOutcome({ inputs: previewInputs, preview: next, error: null });
          setOriginalIconAvailable(next.mapIcon.originalAvailable);
        })
        .catch((previewError: unknown) => {
          if (cancelled) return;
          if (
            exactResultReused &&
            !reuseRefused.current &&
            isStaleExactPreviewError(errorMessage(previewError))
          ) {
            reuseRefused.current = true;
            attemptedRefresh.current = '';
            appendOutput(
              outputNote(
                'Deploy',
                'deploy.preview-regenerating',
                { id: 'deploy-panel.output.preview-regenerating' },
                { detail: errorMessage(previewError) },
              ),
            );
            resetForSource(true);
            return;
          }
          setPreviewOutcome({
            inputs: previewInputs,
            preview: null,
            error: errorMessage(previewError),
          });
        });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [appendOutput, exactResultReused, previewInputs, resetForSource]);

  const previewPhase = deploymentPreviewPhase(previewInputs, previewOutcome);
  const preview = previewPhase.preview;
  const currentPreview = previewMatchesMapIconRequest(preview?.mapIcon, mapIcon) ? preview : null;
  const mapIconRenderError =
    mapIconRender.status === 'error'
      ? userFacingErrorText(mapIconRender.raw, 'Deploy', 'map-icon.render-failed')
      : null;
  const mapIconBlocked = mapIconOption.mode === 'generate' ? mapIconRenderError : null;
  const awaitingIconRender =
    deployment !== null &&
    context !== null &&
    Boolean(profileId) &&
    !sourceLoading &&
    mapIcon === null &&
    mapIconBlocked === null;
  const shownPreview = deploymentPreviewShown(
    graphInputs,
    previewPhase,
    awaitingIconRender,
    previewOutcome,
  );

  useEffect(() => {
    if (currentPreview) {
      setSettledIconPreview({ token: currentPreview.token, mapIcon: currentPreview.mapIcon });
    }
  }, [currentPreview]);

  const originalIconToken =
    settledIconPreview?.mapIcon.source === 'original' ? settledIconPreview.token : null;
  useEffect(() => {
    if (!originalIconToken) {
      setOriginalIconImage(null);
      return undefined;
    }
    let cancelled = false;
    void window.rmside
      .readManualDeploymentMapIcon(originalIconToken)
      .then(async (image) => {
        if (!image || image.source !== 'original') throw new Error('original icon is unavailable');
        const bitmap = await createImageBitmap(
          new Blob([image.bytes as Uint8Array<ArrayBuffer>], { type: 'image/png' }),
        );
        if (cancelled) bitmap.close();
        else setOriginalIconImage({ token: originalIconToken, bitmap });
      })
      .catch(() => {
        if (!cancelled) setOriginalIconImage({ token: originalIconToken, bitmap: null });
      });
    return () => {
      cancelled = true;
    };
  }, [originalIconToken]);

  useEffect(() => () => originalIconImage?.bitmap?.close(), [originalIconImage]);

  const selectGameFolder = async () => {
    setActionBusy(true);
    setActionError(null);
    try {
      const report = await pickGameInstallation();
      if (!report) return;
      if (!isUsableInstallation(report)) {
        setActionError({ kind: 'refused-folder', report });
        return;
      }
      attemptedRefresh.current = '';
      resetForSource(Boolean(selectedSource));
    } catch (selectionError) {
      setActionError({ kind: 'deployment', raw: errorMessage(selectionError) });
    } finally {
      setActionBusy(false);
    }
  };

  const apply = async (fresh: ManualDeploymentPreview, confirmed: boolean) => {
    setActionBusy(true);
    setActionError(null);
    try {
      const result = await window.rmside.applyManualDeployment({
        token: fresh.token,
        confirmReplaceExisting: confirmed,
        enableMod,
      });
      for (const message of deploymentOutputMessages(result)) appendOutput(message);
      setConfirmation(null);
      setSuccessfulDeployment({ targetPath: fresh.targetPath, modStatus: result.modStatus });
      onOpenChange(false);
    } catch (applyError) {
      setConfirmation(null);
      const raw = errorMessage(applyError);
      setActionError({ kind: 'deployment', raw });
      appendOutput(presentDeploymentFailure(raw));
    } finally {
      setActionBusy(false);
    }
  };

  const submit = async () => {
    if (!previewInputs || !modName) return;
    const inputs = previewInputs;
    const { deployment, mapIcon } = inputs;
    setActionBusy(true);
    setActionError(null);
    try {
      const fresh = await window.rmside.previewManualDeployment({
        deployment,
        profileId,
        modName,
        mapIcon,
      });
      if (!previewMatchesMapIconRequest(fresh.mapIcon, mapIcon)) {
        throw new Error('The map icon option changed while the deployment was being prepared.');
      }
      setPreviewOutcome({ inputs, preview: fresh, error: null });
      if (fresh.targetExists) {
        setConfirmation({ modName, preview: fresh });
        setActionBusy(false);
      } else await apply(fresh, false);
    } catch (submitError) {
      const raw = errorMessage(submitError);
      setActionError({ kind: 'deployment', raw });
      appendOutput(presentDeploymentFailure(raw));
      setActionBusy(false);
    }
  };

  const toggleEnableMod = () => {
    const next = !enableMod;
    setEnableMod(next);
    writeEnableModPreference(window.localStorage, next);
  };

  const openDeployedModFolder = async () => {
    setOpenFolderBusy(true);
    try {
      await window.rmside.openDeployedModFolder();
    } catch (openError) {
      appendOutput(
        presentMessage({
          source: 'Deploy',
          raw: errorMessage(openError),
          fallbackHeadline: 'deploy-panel.open-folder.failed',
        }),
      );
    } finally {
      setOpenFolderBusy(false);
    }
  };

  const openTargetDirectory = async () => {
    if (!profileId) return;
    setOpenTargetBusy(true);
    try {
      await window.rmside.openDeploymentTargetFolder(profileId);
    } catch (openError) {
      appendOutput(
        presentMessage({
          source: 'Deploy',
          raw: errorMessage(openError),
          fallbackHeadline: 'deploy-panel.target.open-folder.failed',
        }),
      );
    } finally {
      setOpenTargetBusy(false);
    }
  };

  const ownedForProfile =
    context?.ownedTargets.filter((target) => target.profileId === profileId) ?? [];
  const chooseProfile = (value: string | null) => {
    const next = value ?? '';
    if (next === profileId) return;
    profileIdRef.current = next;
    setProfileId(next);
    setActionError(null);
    const suggestion = suggestedModName(context?.ownedTargets ?? [], next, selectedSource);
    setModNameField((field) => withSuggestedModName(field, suggestion));
  };
  const chooseSource = (value: string | null) => {
    const next = value ?? '';
    if (!next || next === selectedSourceId) return;
    attemptedRefresh.current = '';
    setSelectedSourceId(next);
    setMapIconPreference(null);
    resetForSource();
  };
  const toggleMapIcon = () => {
    setMapIconPreference(!mapIconOption.checked);
    setActionError(null);
  };
  const openIconLightbox = () => {
    if (!mapIconOption.checked && !actionBusy && mapIconSwitchReason === null) toggleMapIcon();
    setIconLightboxOpen(true);
  };
  const changeMapIconInput = (change: Partial<MapIconRenderInput>) => {
    if (mapIconInput === null) return;
    const next = { ...mapIconInput, ...change };
    setMapIconInput(next);
    setActionError(null);
    void window.rmside.setMapIconRenderInput(next).catch((saveError: unknown) =>
      appendOutput(
        presentMessage({
          source: 'Deploy',
          raw: errorMessage(saveError),
          severity: 'warning',
          fallbackHeadline: 'map-icon.output.options-not-remembered',
        }),
      ),
    );
  };
  const randomizeIconSeed = () => {
    const settled = settledMapIconSeed(iconSeed);
    generateIconFromSeed(
      randomMapIconSeed([editorSeed, settled.phase === 'seeded' ? settled.seed : null]),
    );
  };
  const generateIconFromSeed = (seed: number) => {
    if (!exactResult) return;
    const runner = (iconSeedRunner.current ??= new MapIconSeedRunner(window.rmside));
    const { requestId, outcome } = runner.start(
      {
        documentUri: exactResult.documentUri,
        documentRevision: exactResult.documentRevision,
        sourceCatalogRevision: exactResult.sourceCatalogRevision,
        sourceCatalogHash: exactResult.sourceCatalogHash,
        sourceGraphHash: exactResult.sourceGraphHash,
        externalAssetHash: exactResult.externalAssetHash,
        boundSemanticHash: exactResult.semanticHash,
      },
      seed,
    );
    dispatchIconSeed({ type: 'generate', requestId, seed });
    beginMapIconProgress(iconProgress, requestId, performance.now());
    void outcome.then((settlement) => {
      settleMapIconProgress(iconProgress, requestId, settlement);
      switch (settlement.status) {
        case 'completed':
          dispatchIconSeed({ type: 'completed', requestId, result: settlement.result });
          return;
        case 'cancelled':
          dispatchIconSeed({ type: 'cancelled', requestId });
          return;
        case 'failed':
          dispatchIconSeed({ type: 'failed', requestId });
          appendOutput(
            presentMessage({
              source: 'Deploy',
              raw: settlement.message,
              fallbackHeadline: { id: 'map-icon.output.seed-failed', args: { seed } },
            }),
          );
          return;
        default:
          return;
      }
    });
  };
  const restoreEditorIconSeed = () => {
    iconSeedRunner.current?.cancel();
    iconProgress.end();
    dispatchIconSeed({ type: 'use-editor' });
  };
  const iconSeedShown = mapIconSeedDisplay(iconSeed, editorSeed);
  const commitIconSeed = (text: string): boolean => {
    const entry = mapIconSeedEntry(text, iconSeedShown, editorSeed);
    switch (entry.type) {
      case 'generate':
        generateIconFromSeed(entry.seed);
        return true;
      case 'use-editor':
        restoreEditorIconSeed();
        return true;
      case 'unchanged':
        return true;
      default:
        return false;
    }
  };
  const chooseOwnedTarget = (name: string) => {
    setModNameField(editedModNameField(name));
    if (name !== modName) setActionError(null);
  };
  const selectedProfile = context?.profiles.find((profile) => profile.profileId === profileId);
  const targetDirectory = deploymentTargetDirectory(
    shownPreview.preview?.targetPath,
    selectedProfile?.targetRoot,
  );
  const errorProblem = deploymentPanelError<DeploymentProblem>({
    action: actionError,
    context: contextError,
    source: installationRequired ? null : sourceError,
    preview: shownPreview.error === null ? null : { kind: 'deployment', raw: shownPreview.error },
  });
  const error = errorProblem ? deploymentProblemText(errorProblem, t) : null;
  const treeLoading = managedModTreePending({
    open,
    initializing: sources.length > 0 && !initializedOpen.current,
    sourceLoading,
    contextLoading,
    previewLoading: previewPhase.loading && !shownPreview.retained,
    awaitingIconRender: awaitingIconRender && !shownPreview.retained,
  });
  const treePreview = currentPreview ?? (shownPreview.retained ? shownPreview.preview : null);
  const resultHeight = useEasedHeight();
  const tree = treePreview
    ? formatManagedModTree(
        modName,
        treePreview.desiredFiles.map((file) => file.path),
        mapIconTreeAnnotations(treePreview.mapIcon),
      )
    : null;
  const mapIconSwitchReason = mapIconSwitchDisabledReason({
    checked: mapIconOption.checked,
    sourceSelected: Boolean(selectedSource),
    exactPending: sourceLoading || pendingSourceRun !== null,
    exactResultAvailable: exactResult !== null,
    renderError: mapIconRenderError,
  });
  const iconSeedGenerating = iconSeed.phase === 'generating';
  const mapIconStatus = mapIconBlocked
    ? t('map-icon.status.unavailable', { reason: mapIconBlocked })
    : mapIconOption.checked && iconSeed.phase === 'generating'
      ? t('map-icon.status.generating-seed', { seed: iconSeed.seed })
      : !exactResult && !sourceLoading && selectedSource
        ? t('map-icon.status.needs-preview')
        : currentPreview
          ? mapIconSourceDescription(currentPreview.mapIcon)
          : mapIconOption.checked && mapIconRender.status === 'rendering'
            ? t('map-icon.status.rendering')
            : t('map-icon.status.waiting');
  const generatedIconPixels =
    mapIconOption.checked && mapIcon?.mode === 'generate' ? (mapIcon.render?.pixels ?? null) : null;
  const iconRenderPending =
    mapIconOption.checked &&
    iconSourceResult !== null &&
    generatedIconPixels === null &&
    mapIconRender.status !== 'error';
  const iconGenerating = mapIconShowsGenerating({
    checked: mapIconOption.checked,
    seedGenerating: iconSeedGenerating,
    exactPending: sourceLoading || pendingSourceRun !== null,
    rendering: iconRenderPending && !exactResultReused,
    retainedPixels: lastGeneratedPixels !== null,
  });
  useEffect(() => {
    if (generatedIconPixels) setLastGeneratedPixels(generatedIconPixels);
  }, [generatedIconPixels]);
  const displayedGeneratedPixels =
    generatedIconPixels ?? (iconGenerating || iconRenderPending ? lastGeneratedPixels : null);
  const iconFrameContent = mapIconFrameContent(
    mapIconOption.checked,
    displayedGeneratedPixels !== null,
    currentPreview?.mapIcon ?? settledIconPreview?.mapIcon,
  );
  const originalBitmap =
    originalIconImage && originalIconImage.token === originalIconToken
      ? originalIconImage.bitmap
      : null;
  const iconFrameState = mapIconFrameState(
    iconFrameContent,
    originalBitmap !== null,
    iconGenerating,
  );
  const iconFrameLabel = mapIconFrameLabel(iconFrameState, iconFrameContent);
  const shownMapIconLook: MapIconLook = effectiveIconInput?.look ?? 'texture-colors';
  const gameTexturesFellBack =
    mapIconOption.checked &&
    mapIconInput?.look === 'game-textures' &&
    gameTextures.offered &&
    gameTextures.failed;
  const iconImage = useMemo<MapIconImage | null>(
    () =>
      (iconFrameState === 'ready' || iconFrameState === 'generating') && displayedGeneratedPixels
        ? { kind: 'pixels', pixels: displayedGeneratedPixels }
        : iconFrameState === 'original' && originalBitmap
          ? { kind: 'bitmap', bitmap: originalBitmap }
          : null,
    [displayedGeneratedPixels, iconFrameState, originalBitmap],
  );
  const mapIconDescription = gameTexturesFellBack
    ? t('map-icon.status.with-fallback', {
        status: mapIconStatus,
        note: mapIconGameTexturesFallbackNote(),
      })
    : mapIconStatus;
  const saveImageLabel = t('map-icon.save-image.tooltip');
  const mapIconViewTools =
    mapIconOption.checked && mapIconInput !== null
      ? {
          disabled: actionBusy,
          look: shownMapIconLook,
          lookPending: shownMapIconLook === 'game-textures' && gameTextures.pending,
          onToggleLook: () => {
            let next = nextMapIconLook(shownMapIconLook, gameTextures.offered);
            if (next === mapIconInput.look && next !== shownMapIconLook) {
              next = nextMapIconLook(next, gameTextures.offered);
            }
            if (next !== mapIconInput.look) changeMapIconInput({ look: next });
          },
          onTogglePerspective: () =>
            changeMapIconInput({
              perspective: mapIconInput.perspective === 'diamond' ? 'top-down' : 'diamond',
            }),
          perspective: mapIconInput.perspective,
        }
      : null;
  const iconSaveTarget = mapIconSaveTarget({
    content: iconFrameContent,
    pending: iconGenerating || iconRenderPending,
    boundResult: exactResult,
    render: mapIconOption.checked && mapIcon?.mode === 'generate' ? (mapIcon.render ?? null) : null,
    preview: currentPreview,
  });
  const otherExecutionActive = previewExecution
    ? previewExecution.executionState.phase !== 'idle' &&
      previewExecution.executionState.kind !== 'map-icon'
    : false;
  const iconSeedSettled = settledMapIconSeed(iconSeed);
  const iconFileName =
    (currentPreview?.mapIcon ?? settledIconPreview?.mapIcon)?.path?.split('/').pop() ??
    (iconSaveTarget?.kind === 'generated' && selectedSource
      ? `${selectedSource.name.replace(/\.[^.]*$/u, '')}.png`
      : undefined);
  const saveMapIcon = async () => {
    if (!iconSaveTarget) return;
    setIconSaveBusy(true);
    try {
      const result =
        iconSaveTarget.kind === 'generated'
          ? await window.rmside.saveGeneratedMapIcon(iconSaveTarget.request)
          : await window.rmside.saveManualDeploymentMapIcon(iconSaveTarget.token);
      if (result.status === 'saved') {
        appendOutput(
          outputNote('Deploy', 'deploy.icon-saved', {
            id: 'map-icon.output.saved',
            args: { name: result.fileName },
          }),
        );
      }
    } catch (saveError) {
      appendOutput(
        presentMessage({
          source: 'Deploy',
          raw: errorMessage(saveError),
          fallbackHeadline: 'map-icon.output.save-failed',
        }),
      );
    } finally {
      setIconSaveBusy(false);
    }
  };

  return (
    <>
      <Dialog onOpenChange={onOpenChange} open={open}>
        <DialogContent
          className="managed-mod-dialog"
          data-compact={installationRequired || undefined}
        >
          <DialogClose
            aria-label={t('deploy-panel.close')}
            className="managed-mod-close"
            size="icon-compact"
            variant="ghost"
          >
            <X aria-hidden="true" />
          </DialogClose>
          <DialogHeader>
            <DialogTitle>
              <PackagePlus aria-hidden="true" /> {t('deploy-panel.title')}
            </DialogTitle>
          </DialogHeader>

          {installationRequired ? (
            <div className="managed-mod-prerequisite">
              <span>{t('deploy-panel.select-game-folder')}</span>
              <SelectGameFolderButton
                disabled={actionBusy}
                onClick={() => void selectGameFolder()}
              />
            </div>
          ) : (
            <div className="managed-mod-body owned-scrollbars">
              <div className="managed-mod-overview">
                <div className="managed-mod-fields">
                  <label>
                    <span>{t('deploy-panel.source')}</span>
                    <Select onValueChange={chooseSource} value={selectedSourceId || null}>
                      <SelectTrigger aria-label={t('deploy-panel.source')}>
                        <SelectValue placeholder={t('deploy-panel.source.placeholder')}>
                          {selectedSource?.name}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {sources.map((source) => (
                          <SelectItem key={source.id} value={source.id}>
                            {source.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                  <div className="managed-mod-field">
                    <label htmlFor="managed-mod-name">{t('deploy-panel.mod-name')}</label>
                    <div className="managed-mod-name-field">
                      <Input
                        aria-label={t('deploy-panel.mod-name')}
                        autoComplete="off"
                        id="managed-mod-name"
                        onChange={(event) => {
                          setActionError(null);
                          setModNameField(editedModNameField(event.target.value));
                        }}
                        value={modName}
                      />
                      {ownedForProfile.length > 0 ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            aria-label={t('deploy-panel.mod-name.history')}
                            className="managed-mod-name-trigger"
                            render={<Button size="icon-compact" type="button" variant="ghost" />}
                          >
                            <History aria-hidden="true" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent
                            align="end"
                            className="managed-mod-name-menu owned-scrollbars"
                          >
                            {ownedForProfile.map((target) => (
                              <DropdownMenuItem
                                className="managed-mod-name-option"
                                key={`${target.profileId}-${target.modName}`}
                                onClick={() => chooseOwnedTarget(target.modName)}
                              >
                                {target.modName}
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : null}
                    </div>
                  </div>
                  <label>
                    <span>{t('deploy-panel.profile')}</span>
                    <Select onValueChange={chooseProfile} value={profileId || null}>
                      <SelectTrigger aria-label={t('deploy-panel.profile')}>
                        <SelectValue placeholder={t('deploy-panel.profile.placeholder')} />
                      </SelectTrigger>
                      <SelectContent>
                        {(context?.profiles ?? []).map((profile) => (
                          <SelectItem key={profile.profileId} value={profile.profileId}>
                            {profile.suggested
                              ? t('deploy-panel.profile.suggested', { profile: profile.profileId })
                              : profile.profileId}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                  <div className="managed-mod-target">
                    <span>{t('deploy-panel.target')}</span>
                    <div className="managed-mod-target-field">
                      <CopyPathField
                        copiedLabel={t('deploy-panel.target.copied')}
                        copyLabel={t('deploy-panel.target.copy')}
                        inputLabel={t('deploy-panel.target')}
                        placeholder={t('deploy-panel.profile.placeholder')}
                        value={targetDirectory}
                      />
                      <OpenFolderButton
                        busy={openTargetBusy}
                        className="managed-mod-target-open"
                        disabled={!profileId || targetDirectory === null}
                        label={t('deploy-panel.target.open-folder')}
                        onOpen={() => void openTargetDirectory()}
                      />
                    </div>
                  </div>
                </div>
                <div className="managed-mod-icon-field">
                  <div className="managed-mod-icon-row">
                    <MapIconColumn
                      canSave={iconSaveTarget !== null}
                      checked={mapIconOption.checked}
                      description={mapIconDescription}
                      descriptionId={mapIconDescriptionId}
                      image={iconImage}
                      label={iconFrameLabel}
                      onOpen={openIconLightbox}
                      onSave={() => void saveMapIcon()}
                      onToggle={toggleMapIcon}
                      openRef={openLargerButton}
                      generating={iconFrameState === 'generating'}
                      saveBusy={iconSaveBusy}
                      saveLabel={saveImageLabel}
                      state={iconFrameState}
                      switchBusy={actionBusy}
                      switchReason={mapIconSwitchReason}
                      switchReasonId={mapIconSwitchReasonId}
                    />
                    <span
                      aria-live="polite"
                      className="sr-only"
                      data-testid="managed-mod-map-icon-source"
                      id={mapIconDescriptionId}
                    >
                      {mapIconDescription}
                    </span>
                  </div>
                </div>
              </div>
              <div className="managed-mod-result" ref={resultHeight.shellRef}>
                <div className="managed-mod-result-content" ref={resultHeight.contentRef}>
                  {treeLoading ? <ManagedModTreeSkeleton /> : null}
                  {tree ? (
                    <pre
                      aria-label={t('deploy-panel.tree')}
                      className="managed-mod-tree owned-scrollbars"
                    >
                      {tree}
                    </pre>
                  ) : null}
                  {!selectedSource && !treeLoading ? (
                    <p className="managed-mod-state">{t('deploy-panel.no-source')}</p>
                  ) : null}
                  {error ? (
                    <p className="managed-mod-error" role="alert">
                      {error}
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          )}
          {installationRequired && error ? (
            <p className="managed-mod-error" role="alert">
              {error}
            </p>
          ) : null}
          {!installationRequired ? (
            <div className="managed-mod-actions">
              {certificationNote ? (
                <span className="managed-mod-certification" data-testid="managed-mod-certification">
                  {certificationNote}
                </span>
              ) : null}
              {constructNote ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        aria-label={t('deploy-panel.constructs.label', {
                          note: constructNote.note,
                          names: constructNote.names,
                        })}
                        className="managed-mod-certification managed-mod-constructs"
                        data-testid="managed-mod-constructs"
                        tabIndex={0}
                      />
                    }
                  >
                    <span aria-hidden="true">{constructNote.note}</span>
                  </TooltipTrigger>
                  <TooltipContent className="managed-mod-constructs-tooltip">
                    {constructNote.names}
                  </TooltipContent>
                </Tooltip>
              ) : null}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      {...toggleButtonProps({
                        checked: enableMod,
                        className: 'managed-mod-enable',
                      })}
                      data-testid="managed-mod-enable"
                      disabled={actionBusy}
                      onClick={toggleEnableMod}
                    />
                  }
                >
                  {t('deploy-panel.enable-mod')}
                  <ToggleButtonCheck checked={enableMod} />
                </TooltipTrigger>
                <TooltipContent className="managed-mod-enable-tooltip">
                  {t('deploy-panel.enable-mod.tooltip')}
                </TooltipContent>
              </Tooltip>
              <Button
                disabled={actionBusy || treeLoading || !currentPreview || !profileId || !mapIcon}
                onClick={() => void submit()}
              >
                {t('deploy-panel.deploy')}
              </Button>
            </div>
          ) : null}
          <Dialog onOpenChange={setIconLightboxOpen} open={iconLightboxOpen}>
            <DialogPortal>
              <DialogOverlay data-testid="managed-mod-map-icon-lightbox-backdrop" forceRender />
            </DialogPortal>
            <DialogContent
              className="managed-mod-icon-lightbox"
              data-testid="managed-mod-map-icon-lightbox"
              finalFocus={openLargerButton}
            >
              <div className="managed-mod-icon-lightbox-actions">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        aria-label={t('map-icon.save-image')}
                        data-testid="managed-mod-map-icon-lightbox-save"
                        disabled={iconSaveBusy || !iconSaveTarget}
                        onClick={() => void saveMapIcon()}
                        size="icon-compact"
                        type="button"
                        variant="ghost"
                      />
                    }
                  >
                    <Download aria-hidden="true" />
                  </TooltipTrigger>
                  <TooltipContent>{saveImageLabel}</TooltipContent>
                </Tooltip>
                <DialogClose
                  aria-label={t('map-icon.lightbox.close')}
                  size="icon-compact"
                  variant="ghost"
                >
                  <X aria-hidden="true" />
                </DialogClose>
              </div>
              <DialogHeader>
                <DialogTitle>{iconFileName ?? t('map-icon.lightbox.title')}</DialogTitle>
              </DialogHeader>
              <div className="managed-mod-icon-lightbox-stage">
                <div
                  aria-busy={iconFrameState === 'generating' || undefined}
                  aria-label={iconFrameLabel}
                  className="managed-mod-icon-lightbox-image"
                  data-state={iconFrameState}
                  data-testid="managed-mod-map-icon-lightbox-image"
                  role="img"
                >
                  {iconImage ? <MapIconCanvas image={iconImage} /> : <MapIconPlaceholder />}
                  {iconFrameState === 'generating' ? <MapIconProgress size={32} /> : null}
                  <MapIconRunProgress store={iconProgress} />
                </div>
                {mapIconViewTools && mapIconInput !== null ? (
                  <div
                    aria-label={t('map-icon.view-tools')}
                    className="managed-mod-icon-lightbox-view-tools"
                    data-testid="managed-mod-map-icon-view-tools"
                    role="group"
                  >
                    <MapIconViewToolButtons {...mapIconViewTools} />
                    <MapIconReliefButton
                      disabled={actionBusy}
                      onToggle={() => changeMapIconInput({ relief: !mapIconInput.relief })}
                      relief={mapIconInput.relief}
                    />
                  </div>
                ) : null}
              </div>
              {mapIconOption.checked ? (
                <div className="managed-mod-icon-lightbox-toolbar">
                  {exactResult ? (
                    <div className="managed-mod-icon-lightbox-seed">
                      <MapIconSeedInput
                        disabled={actionBusy || sourceLoading || otherExecutionActive}
                        onCommit={commitIconSeed}
                        shown={iconSeedShown}
                      />
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              aria-label={mapIconRandomSeedLabel()}
                              data-testid="managed-mod-map-icon-randomize"
                              disabled={actionBusy || sourceLoading || otherExecutionActive}
                              onClick={randomizeIconSeed}
                              size="icon"
                              type="button"
                              variant="ghost"
                            />
                          }
                        >
                          <Dices aria-hidden="true" />
                        </TooltipTrigger>
                        <TooltipContent>{mapIconRandomSeedLabel()}</TooltipContent>
                      </Tooltip>
                      {iconSeedSettled.phase === 'seeded' || iconSeedGenerating ? (
                        <Button
                          data-testid="managed-mod-map-icon-editor-seed"
                          disabled={actionBusy}
                          onClick={restoreEditorIconSeed}
                          type="button"
                          variant="ghost"
                        >
                          <Undo2 aria-hidden="true" /> {t('map-icon.use-editor-seed')}
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                  {mapIconInput !== null ? (
                    <div className="managed-mod-icon-lightbox-options">
                      <MapIconTerrainSmoothingButton
                        disabled={actionBusy}
                        onToggle={() =>
                          changeMapIconInput({ terrainSmoothing: !mapIconInput.terrainSmoothing })
                        }
                        terrainSmoothing={mapIconInput.terrainSmoothing}
                      />
                      <MapIconSpawnMarkersButton
                        disabled={actionBusy}
                        onToggle={() =>
                          changeMapIconInput({
                            spawnMarkers: nextMapIconSpawnMarkers(mapIconInput.spawnMarkers),
                          })
                        }
                        spawnMarkers={mapIconInput.spawnMarkers}
                      />
                      <MapIconSpawnSizeStepper
                        disabled={actionBusy || mapIconInput.spawnMarkers === 'hidden'}
                        onChange={(spawnMarkerSizePercent) =>
                          changeMapIconInput({ spawnMarkerSizePercent })
                        }
                        value={mapIconInput.spawnMarkerSizePercent}
                      />
                      {(['trees', 'resources'] as const).map((layer) => (
                        <MapIconArtLayerControl
                          disabled={actionBusy}
                          input={mapIconInput}
                          key={layer}
                          layer={layer}
                          onChange={changeMapIconInput}
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </DialogContent>
          </Dialog>
        </DialogContent>
      </Dialog>
      <AlertDialog
        onOpenChange={(next) => {
          if (!next) setConfirmation(null);
        }}
        open={confirmation !== null}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deploy-panel.replace.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              <ReplaceModDescription modName={confirmation?.modName ?? ''} />
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionBusy}>
              {t('dialog.confirm.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={actionBusy}
              onClick={() => confirmation && void apply(confirmation.preview, true)}
            >
              {t('deploy-panel.replace.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        onOpenChange={(next) => {
          if (!next) setSuccessfulDeployment(null);
        }}
        open={successfulDeployment !== null}
      >
        <AlertDialogContent initialFocus={finishButton}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deploy-panel.success.title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('deploy-panel.success.saved-to')}</AlertDialogDescription>
          </AlertDialogHeader>
          <CopyPathField
            copiedLabel={t('deploy-panel.success.path.copied')}
            copyLabel={t('deploy-panel.success.path.copy')}
            inputLabel={t('deploy-panel.success.path')}
            value={successfulDeployment?.targetPath ?? null}
          />
          {successfulDeployment ? (
            <DeploymentModStatusText status={successfulDeployment.modStatus} />
          ) : null}
          <AlertDialogFooter>
            <Button
              disabled={openFolderBusy}
              onClick={() => void openDeployedModFolder()}
              type="button"
              variant="secondary"
            >
              {t('deploy-panel.success.open-folder')}
            </Button>
            <AlertDialogAction
              onClick={() => setSuccessfulDeployment(null)}
              ref={finishButton}
              type="button"
            >
              {t('deploy-panel.success.finish')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function DeploymentModStatusText({ status }: { status: ManualDeploymentModStatus | undefined }) {
  useI18n();
  const lines = deploymentModStatusLines(status);
  return (
    <div className="managed-mod-success-status" data-testid="managed-mod-success-status">
      {lines.failure ? (
        <p className="managed-mod-success-warning" data-testid="managed-mod-enable-failed">
          {lines.failure}
        </p>
      ) : null}
      <p className="managed-mod-success-note">{lines.note}</p>
      {lines.warning ? (
        <p className="managed-mod-success-warning" data-testid="managed-mod-game-running">
          {lines.warning}
        </p>
      ) : null}
    </div>
  );
}

function OpenFolderButton({
  busy,
  className,
  disabled,
  label,
  onOpen,
}: {
  busy: boolean;
  className: string;
  disabled: boolean;
  label: string;
  onOpen(): void;
}) {
  const { animationHandlers, iconRef } = useAnimatedIconHover();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-disabled={busy || undefined}
            aria-label={label}
            className={className}
            disabled={disabled}
            onClick={() => {
              if (!busy) onOpen();
            }}
            onMouseEnter={animationHandlers.onMouseEnter}
            onMouseLeave={animationHandlers.onMouseLeave}
            size="icon-compact"
            type="button"
            variant="ghost"
          />
        }
      >
        <FolderOpenIcon aria-hidden="true" duration={0.4} ref={iconRef} size={14} />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function layoutWidth(element: HTMLElement): number {
  return Number.parseFloat(getComputedStyle(element).width);
}

function CopyPathField({
  copiedLabel,
  copyLabel,
  inputLabel,
  placeholder,
  value,
}: {
  copiedLabel: string;
  copyLabel: string;
  inputLabel: string;
  placeholder?: string;
  value: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const [alignment, setAlignment] = useState<CopyPathAlignment>('start');
  const field = useRef<HTMLSpanElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  const copiedTimer = useRef<number | null>(null);
  const copiedCheck = useRef<AnimatedIconHandle>(null);
  useLayoutEffect(() => {
    const fieldElement = field.current;
    const textElement = text.current;
    if (!fieldElement || !textElement) return undefined;
    let active = true;
    const measure = () => {
      if (!active) return;
      const next = copyPathAlignment(layoutWidth(textElement), layoutWidth(fieldElement));
      if (next) setAlignment(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(fieldElement);
    observer.observe(textElement);
    void document.fonts.ready.then(measure);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [placeholder, value]);
  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );
  useEffect(() => setCopied(false), [value]);
  useLayoutEffect(() => {
    if (copied) playIconAnimation(copiedCheck.current);
  }, [copied]);
  const copy = async () => {
    if (value === null) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      return;
    }
    setCopied(true);
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => {
      copiedTimer.current = null;
      setCopied(false);
    }, 1_600);
  };
  return (
    <div
      className="managed-mod-copy-path"
      data-alignment={value === null ? undefined : alignment}
      data-empty={value === null || undefined}
    >
      <Input aria-label={inputLabel} placeholder={placeholder} readOnly value={value ?? ''} />
      <span aria-hidden="true" className="managed-mod-copy-path-label" ref={field}>
        <span ref={text}>{value ?? placeholder ?? ''}</span>
      </span>
      {value !== null ? (
        <button
          aria-label={copied ? copiedLabel : copyLabel}
          className="managed-mod-copy-path-button"
          data-copied={copied || undefined}
          onClick={() => void copy()}
          type="button"
        >
          {copied ? (
            <AnimatedCheckIcon aria-hidden="true" ref={copiedCheck} size={14} />
          ) : (
            <Copy aria-hidden="true" />
          )}
        </button>
      ) : null}
    </div>
  );
}

function MapIconColumn({
  canSave,
  checked,
  description,
  descriptionId,
  generating,
  image,
  label,
  onOpen,
  onSave,
  onToggle,
  openRef,
  saveBusy,
  saveLabel,
  state,
  switchBusy,
  switchReason,
  switchReasonId,
}: {
  canSave: boolean;
  checked: boolean;
  description: string;
  descriptionId: string;
  generating: boolean;
  image: MapIconImage | null;
  label: string;
  onOpen(): void;
  onSave(): void;
  onToggle(): void;
  openRef: RefObject<HTMLButtonElement | null>;
  saveBusy: boolean;
  state: string;
  switchBusy: boolean;
  switchReason: string | null;
  switchReasonId: string;
  saveLabel: string;
}) {
  const { t } = useI18n();
  const isolated = (action: () => void) => (event: MouseEvent) => {
    event.stopPropagation();
    action();
  };
  return (
    <div
      className="managed-mod-icon-column"
      data-generate={checked || undefined}
      data-testid="managed-mod-map-icon-widget"
    >
      <Tooltip disabled={switchReason === null}>
        <TooltipTrigger
          render={
            <Button
              {...toggleButtonProps({
                checked,
                className: 'managed-mod-icon-switch toggle-button-part',
                density: 'compact',
              })}
              aria-describedby={switchReason ? switchReasonId : undefined}
              data-testid="managed-mod-map-icon-toggle"
              disabled={switchBusy || switchReason !== null}
              focusableWhenDisabled
              onClick={onToggle}
            />
          }
        >
          {t('map-icon.generate')}
          <ToggleButtonCheck checked={checked} />
        </TooltipTrigger>
        <TooltipContent className="managed-mod-icon-tooltip">{switchReason}</TooltipContent>
      </Tooltip>
      {switchReason ? (
        <span className="sr-only" id={switchReasonId}>
          {switchReason}
        </span>
      ) : null}
      <div className="managed-mod-icon-frame" data-generate={checked || undefined}>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-describedby={descriptionId}
                aria-label={t('map-icon.open-larger')}
                className="managed-mod-icon-open"
                data-testid="managed-mod-map-icon-open"
                onClick={onOpen}
                ref={openRef}
                type="button"
                variant="ghost"
              />
            }
          >
            <span
              aria-busy={generating || undefined}
              aria-label={label}
              className="managed-mod-icon-preview"
              data-state={state}
              data-testid="managed-mod-map-icon-preview"
              role="img"
            >
              {image ? <MapIconCanvas image={image} /> : <MapIconPlaceholder />}
              {generating ? <MapIconProgress size={22} /> : null}
            </span>
          </TooltipTrigger>
          <TooltipContent className="managed-mod-icon-tooltip" side="bottom">
            {description}
          </TooltipContent>
        </Tooltip>
        {canSave ? (
          <div className="managed-mod-icon-actions managed-mod-icon-overlay">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label={t('map-icon.save-image')}
                    data-testid="managed-mod-map-icon-save"
                    disabled={saveBusy}
                    onClick={isolated(onSave)}
                    size="icon-sm"
                    type="button"
                    variant="secondary"
                  />
                }
              >
                <Download aria-hidden="true" />
              </TooltipTrigger>
              <TooltipContent>{saveLabel}</TooltipContent>
            </Tooltip>
          </div>
        ) : null}
      </div>
    </div>
  );
}

interface MapIconViewTools {
  disabled: boolean;
  look: MapIconLook;
  lookPending: boolean;
  onToggleLook(): void;
  onTogglePerspective(): void;
  perspective: MapIconRenderInput['perspective'];
}

function MapIconViewToolButtons({
  disabled,
  look,
  lookPending,
  onToggleLook,
  onTogglePerspective,
  perspective,
}: MapIconViewTools) {
  const { t } = useI18n();
  const perspectiveIcon = useAnimatedIconHover();
  const lookIcon = useAnimatedIconHover();
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              {...perspectiveIcon.animationHandlers}
              aria-label={mapIconPerspectiveLabel(perspective)}
              data-perspective={perspective}
              className="managed-mod-icon-view-tool"
              data-testid="managed-mod-map-icon-perspective"
              disabled={disabled}
              onClick={(event) => {
                event.stopPropagation();
                onTogglePerspective();
              }}
              size="icon-compact"
              type="button"
              variant="secondary"
            />
          }
        >
          {perspective === 'diamond' ? (
            <MapIcon aria-hidden="true" ref={perspectiveIcon.iconRef} size={14} />
          ) : (
            <MoveDiagonal2Icon aria-hidden="true" ref={perspectiveIcon.iconRef} size={14} />
          )}
        </TooltipTrigger>
        <TooltipContent>{mapIconPerspectiveLabel(perspective)}</TooltipContent>
      </Tooltip>
      {
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                {...lookIcon.animationHandlers}
                aria-busy={lookPending || undefined}
                aria-label={mapIconLookLabel(look)}
                aria-description={mapIconLookTooltip(look)}
                data-look={look}
                data-pending={lookPending || undefined}
                className="managed-mod-icon-view-tool"
                data-testid="managed-mod-map-icon-look"
                disabled={disabled || lookPending}
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleLook();
                }}
                size="icon-compact"
                type="button"
                variant="secondary"
              />
            }
          >
            {lookPending ? (
              <RunningIndicator size={14} testId="managed-mod-map-icon-look-pending" />
            ) : look === 'game-textures' ? (
              <ImageIcon aria-hidden="true" ref={lookIcon.iconRef} size={14} />
            ) : look === 'texture-colors' ? (
              <DropletIcon aria-hidden="true" ref={lookIcon.iconRef} size={14} />
            ) : (
              <LayoutGridIcon aria-hidden="true" ref={lookIcon.iconRef} size={14} />
            )}
          </TooltipTrigger>
          <TooltipContent className="managed-mod-icon-tooltip">
            {lookPending ? t('map-icon.look.pending') : mapIconLookTooltip(look)}
          </TooltipContent>
        </Tooltip>
      }
    </>
  );
}

function MapIconReliefButton({
  disabled,
  onToggle,
  relief,
}: {
  disabled: boolean;
  onToggle(): void;
  relief: boolean;
}) {
  useI18n();
  const { animationHandlers, iconRef } = useAnimatedIconHover();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            {...animationHandlers}
            aria-label={mapIconReliefLabel()}
            aria-pressed={relief}
            className="managed-mod-icon-view-tool managed-mod-icon-relief"
            data-testid="managed-mod-map-icon-relief"
            disabled={disabled}
            onClick={onToggle}
            size="icon-compact"
            type="button"
            variant="secondary"
          />
        }
      >
        {relief ? (
          <SunDimIcon aria-hidden="true" ref={iconRef} size={14} />
        ) : (
          <EyeOffIcon aria-hidden="true" ref={iconRef} size={14} />
        )}
      </TooltipTrigger>
      <TooltipContent>{mapIconReliefActionLabel(relief)}</TooltipContent>
    </Tooltip>
  );
}

function MapIconTerrainSmoothingButton({
  disabled,
  onToggle,
  terrainSmoothing,
}: {
  disabled: boolean;
  onToggle(): void;
  terrainSmoothing: boolean;
}) {
  useI18n();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <IconToggleButton
            aria-label={mapIconTerrainSmoothingLabel()}
            data-testid="managed-mod-map-icon-smoothing"
            disabled={disabled}
            onClick={onToggle}
            pressed={terrainSmoothing}
            size="icon"
          />
        }
      >
        {terrainSmoothing ? <Blend aria-hidden="true" /> : <Grid2x2 aria-hidden="true" />}
      </TooltipTrigger>
      <TooltipContent>{mapIconTerrainSmoothingLabel()}</TooltipContent>
    </Tooltip>
  );
}

function MapIconSpawnMarkersButton({
  disabled,
  onToggle,
  spawnMarkers,
}: {
  disabled: boolean;
  onToggle(): void;
  spawnMarkers: MapIconSpawnMarkerStyle;
}) {
  useI18n();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={mapIconSpawnMarkersLabel(spawnMarkers)}
            className="managed-mod-icon-spawn-markers"
            data-spawn-markers={spawnMarkers}
            data-testid="managed-mod-map-icon-spawn-markers"
            disabled={disabled}
            onClick={onToggle}
            size="icon"
            type="button"
            variant="ghost"
          />
        }
      >
        {spawnMarkers === 'player-squares' ? (
          <Diamond aria-hidden="true" />
        ) : spawnMarkers === 'nomad-feet' ? (
          <Footprints aria-hidden="true" />
        ) : (
          <MapPinOff aria-hidden="true" />
        )}
      </TooltipTrigger>
      <TooltipContent>{mapIconSpawnMarkersLabel(spawnMarkers)}</TooltipContent>
    </Tooltip>
  );
}

function MapIconArtLayerControl({
  disabled,
  input,
  layer,
  onChange,
}: {
  disabled: boolean;
  input: MapIconRenderInput;
  layer: 'trees' | 'resources';
  onChange(change: Partial<MapIconRenderInput>): void;
}) {
  const fields = mapIconArtLayerFields[layer];
  const shown = input[fields.shown];
  const density = input[fields.density];
  const size = input[fields.size];
  const overlap = input[fields.overlap];
  const [draft, setDraft] = useState<number | null>(null);
  const [sizeDraft, setSizeDraft] = useState<number | null>(null);
  useI18n();
  const densityEnds = mapIconArtDensityEnds();
  const sizeEnds = mapIconArtSizeEnds();
  const Icon = layer === 'trees' ? Trees : Gem;
  return (
    <div className="managed-mod-icon-art" data-layer={layer}>
      <Tooltip>
        <TooltipTrigger
          render={
            <IconToggleButton
              aria-label={mapIconArtLayerLabel(layer)}
              className="managed-mod-icon-art-toggle"
              data-testid={`managed-mod-map-icon-${layer}`}
              disabled={disabled}
              onClick={() => onChange({ [fields.shown]: !shown })}
              pressed={shown}
              size="icon"
            />
          }
        >
          <Icon aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent>{mapIconArtLayerActionLabel(layer, shown)}</TooltipContent>
      </Tooltip>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger
          render={
            <Button
              aria-label={mapIconArtLayerOptionsLabel(layer)}
              className="managed-mod-icon-art-menu-trigger"
              data-testid={`managed-mod-map-icon-${layer}-options`}
              disabled={disabled}
              size="icon"
              type="button"
              variant="ghost"
            />
          }
        >
          <ChevronUp aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="managed-mod-icon-art-menu"
          data-testid={`managed-mod-map-icon-${layer}-menu`}
          side="top"
        >
          <div
            className="managed-mod-icon-art-amount"
            onKeyDown={(event) => {
              if (
                [
                  'ArrowLeft',
                  'ArrowRight',
                  'ArrowUp',
                  'ArrowDown',
                  'Home',
                  'End',
                  'PageUp',
                  'PageDown',
                ].includes(event.key)
              ) {
                event.stopPropagation();
              }
            }}
          >
            <div className="managed-mod-icon-art-amount-row">
              <span aria-hidden="true">{densityEnds.minimum}</span>
              <Slider
                data-testid={`managed-mod-map-icon-${layer}-amount`}
                disabled={disabled}
                getAriaLabel={() => mapIconArtDensityLabel(layer)}
                getAriaValueText={(_formatted, value) => mapIconArtDensityValueText(value)}
                max={mapIconArtDensity.maximum}
                min={mapIconArtDensity.minimum}
                onValueChange={(value) => setDraft(clampMapIconArtDensity(value))}
                onValueCommitted={(value) => {
                  setDraft(null);
                  const next = clampMapIconArtDensity(value);
                  if (next !== density) onChange({ [fields.density]: next });
                }}
                step={mapIconArtDensity.step}
                value={draft ?? density}
              />
              <span aria-hidden="true">{densityEnds.maximum}</span>
            </div>
            <div className="managed-mod-icon-art-amount-row">
              <span aria-hidden="true">{sizeEnds.minimum}</span>
              <Slider
                data-testid={`managed-mod-map-icon-${layer}-size`}
                disabled={disabled}
                getAriaLabel={() => mapIconArtSizeLabel(layer)}
                getAriaValueText={(_formatted, value) => mapIconArtSizeValueText(value)}
                max={mapIconArtSize.maximum}
                min={mapIconArtSize.minimum}
                onValueChange={(value) => setSizeDraft(clampMapIconArtSize(value))}
                onValueCommitted={(value) => {
                  setSizeDraft(null);
                  const next = clampMapIconArtSize(value);
                  if (next !== size) onChange({ [fields.size]: next });
                }}
                step={mapIconArtSize.step}
                value={sizeDraft ?? size}
              />
              <span aria-hidden="true">{sizeEnds.maximum}</span>
            </div>
          </div>
          <DropdownMenuCheckboxItem
            checked={overlap}
            data-testid={`managed-mod-map-icon-${layer}-overlap`}
            disabled={disabled}
            onCheckedChange={(checked) => onChange({ [fields.overlap]: checked })}
          >
            {mapIconArtSpawnOverlapLabel()}
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function MapIconSpawnSizeStepper({
  disabled,
  onChange,
  value,
}: {
  disabled: boolean;
  onChange(value: number): void;
  value: number;
}) {
  const { t } = useI18n();
  const { minimum, maximum } = mapIconSpawnMarkerSizePercent;
  const step = (action: Parameters<typeof stepMapIconSpawnMarkerSize>[1]) => {
    if (disabled) return;
    const next = stepMapIconSpawnMarkerSize(value, action);
    if (next !== null) onChange(next);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    const action =
      event.key === 'ArrowUp' || event.key === 'ArrowRight'
        ? 'increment'
        : event.key === 'ArrowDown' || event.key === 'ArrowLeft'
          ? 'decrement'
          : event.key === 'Home'
            ? 'minimum'
            : event.key === 'End'
              ? 'maximum'
              : null;
    if (!action) return;
    event.preventDefault();
    step(action);
  };
  return (
    <div className="managed-mod-icon-size">
      <Button
        aria-label={t('map-icon.spawn-size.decrease')}
        disabled={disabled || value <= minimum}
        onClick={() => step('decrement')}
        size="icon"
        type="button"
        variant="ghost"
      >
        <Minus aria-hidden="true" />
      </Button>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              aria-disabled={disabled || undefined}
              aria-label={mapIconSpawnMarkerSizeLabel()}
              aria-valuemax={maximum}
              aria-valuemin={minimum}
              aria-valuenow={value}
              aria-valuetext={t('map-icon.spawn-size.value-text', { value })}
              className="managed-mod-icon-size-value"
              data-testid="managed-mod-map-icon-spawn-size"
              onKeyDown={onKeyDown}
              role="spinbutton"
              tabIndex={disabled ? -1 : 0}
            />
          }
        >
          {t('map-icon.spawn-size.value', { value })}
        </TooltipTrigger>
        <TooltipContent>{t('map-icon.spawn-size.tooltip')}</TooltipContent>
      </Tooltip>
      <Button
        aria-label={t('map-icon.spawn-size.increase')}
        disabled={disabled || value >= maximum}
        onClick={() => step('increment')}
        size="icon"
        type="button"
        variant="ghost"
      >
        <Plus aria-hidden="true" />
      </Button>
    </div>
  );
}

function MapIconSeedInput({
  disabled,
  onCommit,
  shown,
}: {
  disabled: boolean;
  onCommit(text: string): boolean;
  shown: MapIconSeedDisplay;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    onCommit(draft);
    setDraft(null);
  };
  const placeholder = t('map-icon.seed.placeholder');
  return (
    <div
      className="managed-mod-icon-seed-box text-sm md:text-xs/relaxed"
      data-placeholder={placeholder}
    >
      <div className="managed-mod-icon-seed-field">
        <Input
          aria-label={t('map-icon.seed')}
          autoComplete="off"
          data-editor-seed={shown.editor || undefined}
          data-testid="managed-mod-map-icon-seed"
          disabled={disabled}
          inputMode="numeric"
          maxLength={10}
          onBlur={commit}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            } else if (event.key === 'Escape' && draft !== null) {
              event.preventDefault();
              event.stopPropagation();
              setDraft(null);
            }
          }}
          placeholder={placeholder}
          spellCheck={false}
          value={draft ?? (shown.seed === null ? '' : String(shown.seed))}
        />
      </div>
    </div>
  );
}

function MapIconCanvas({ image }: { image: MapIconImage }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const context = canvas.current?.getContext('2d');
    if (!context) return;
    const size = mapIconRenderContract.size;
    context.clearRect(0, 0, size, size);
    if (image.kind === 'pixels') {
      context.putImageData(new ImageData(new Uint8ClampedArray(image.pixels), size, size), 0, 0);
      return;
    }
    const scale = Math.min(size / image.bitmap.width, size / image.bitmap.height);
    const width = image.bitmap.width * scale;
    const height = image.bitmap.height * scale;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image.bitmap, (size - width) / 2, (size - height) / 2, width, height);
  }, [image]);
  return (
    <canvas
      aria-hidden="true"
      height={mapIconRenderContract.size}
      ref={canvas}
      width={mapIconRenderContract.size}
    />
  );
}

function MapIconProgress({ size }: { size: number }) {
  return (
    <span
      aria-hidden="true"
      className="managed-mod-icon-progress"
      data-testid="managed-mod-map-icon-progress"
    >
      <RunningIndicator size={size} />
    </span>
  );
}

function MapIconRunProgress({ store }: { store: ExecutionProfilerStore }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const reducedMotion = usePrefersReducedMotion();
  const bar = useExecutionProgressBar(runBarPhase(snapshot), reducedMotion);
  if (!bar.shown) return null;
  return (
    <span
      aria-hidden="true"
      className="managed-mod-icon-run-progress"
      data-testid="managed-mod-map-icon-run-progress"
    >
      <ExecutionProgressBar
        fading={bar.fading}
        identity={profilerBarKey(snapshot.run)}
        onFadeEnd={bar.onFadeEnd}
        percent={runBarPercent(snapshot.run)}
      />
    </span>
  );
}

function MapIconPlaceholder() {
  return (
    <svg aria-hidden="true" className="managed-mod-icon-placeholder" viewBox="0 0 100 100">
      <polygon className="managed-mod-icon-placeholder-fill" points="50,10 90,50 50,90 10,50" />
      <polygon className="managed-mod-icon-placeholder-outline" points="50,10 90,50 50,90 10,50" />
    </svg>
  );
}

function ManagedModTreeSkeleton() {
  const { t } = useI18n();
  return (
    <div
      aria-label={t('deploy-panel.tree.loading')}
      className="managed-mod-tree-skeleton"
      role="status"
    >
      {Array.from({ length: 7 }, (_, index) => (
        <span aria-hidden="true" className="animate-pulse" key={index} />
      ))}
    </div>
  );
}

function preferredSource(
  sources: readonly PinnedPreviewSource[],
  pinnedId: string | null,
  activeId: string,
): PinnedPreviewSource | null {
  return (
    sources.find((source) => source.id === pinnedId) ??
    sources.find((source) => source.id === activeId) ??
    sources[0] ??
    null
  );
}

function deploymentRequest(
  result: PreviewGenerationResult,
  includePreviewImage: boolean,
): ManagedDeploymentRequest {
  return {
    contractVersion: { major: 1, minor: 0, patch: 0 },
    documentUri: result.documentUri,
    documentRevision: result.documentRevision,
    sourceCatalogRevision: result.sourceCatalogRevision,
    sourceCatalogHash: result.sourceCatalogHash,
    sourceGraphHash: result.sourceGraphHash,
    externalAssetHash: result.externalAssetHash,
    resolvedRmsSourceIds: [...result.resolvedRmsSourceIds],
    externalAssetSourceIds: [...result.externalAssetSourceIds],
    includePreviewImage,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deploymentErrorText(raw: string): string {
  return outputMessageText(presentDeploymentFailure(raw));
}

function deploymentProblemText(problem: DeploymentProblem, t: Translator['t']): string {
  switch (problem.kind) {
    case 'deployment':
      return deploymentErrorText(problem.raw);
    case 'refused-folder':
      return refusedGameFolderText(problem.report);
    case 'source-failed':
      return deploymentSourceFailureMessage(deploymentSourceGuidance(problem.detail));
    case 'source-cancelled':
      return t('deploy-panel.source.cancelled');
    case 'text':
      return wordOutputWords(problem.text);
  }
}

const emphasisMarker = '\uE000';

function ReplaceModDescription({ modName }: { modName: string }) {
  const { t } = useI18n();
  const parts = t('deploy-panel.replace.description', { name: emphasisMarker }).split(
    emphasisMarker,
  );
  if (parts.length !== 2) return <>{t('deploy-panel.replace.description', { name: modName })}</>;
  return (
    <>
      {parts[0]}
      <strong>{modName}</strong>
      {parts[1]}
    </>
  );
}
