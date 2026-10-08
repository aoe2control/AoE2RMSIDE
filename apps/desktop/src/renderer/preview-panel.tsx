import { outputNote } from '../shared/output-message';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';
import {
  BoxesIcon,
  ChartNoAxesColumnIcon,
  DropletIcon,
  EyeOffIcon,
  FootprintsIcon,
  ImageIcon,
  LayersIcon,
  LayoutGridIcon,
  MapIcon,
  MountainIcon,
  MoveDiagonal2Icon,
  RouteIcon,
  SunDimIcon,
} from '@animateicons/react/lucide';
import {
  Application,
  BufferImageSource,
  Container,
  FederatedPointerEvent,
  Graphics,
  Rectangle,
  Sprite,
  Texture,
  type ContainerChild,
} from 'pixi.js';
import { Grid3x3, Keyboard, MousePointer2, Scan, TestTube2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { t as translate } from '../shared/i18n/translator';
import appIconUrl from '../../../../assets/original/branding/aoe2rmside-icon-512.png';
import type {
  LocalPresentationNames,
  PreviewBackend,
  PreviewGenerationResult,
  SelectedMinimapPalette,
  TerrainMinimapColor,
} from '../shared/api';
import {
  flatPreviewLook,
  nextPreviewLook,
  shownPreviewLook,
  type PreviewLook,
  type PreviewPerspective,
} from '../shared/game-art';
import {
  lookMarkerObjectColors,
  textureLookColors,
  type TextureLookColors,
} from '../shared/texture-palette';
import { type AnimatedIconHandle, useAnimatedIconHover } from './animated-icon';
import { createPortal, flushSync } from 'react-dom';
import { type GameArtCliffBandLayer, cliffLegs } from './game-art-cliffs';
import {
  createGameArtPresentationState,
  destroyGameArtLayers,
  handOverGameArtPicture,
  setGameArtKindVisibility,
  syncGameArtLayers,
  writeGameArtDataset,
  type GameArtPresentationState,
} from './game-art-layers';
import { GameArtConversionProgress } from './game-art-progress';
import type { GameArtSpriteLayer } from './game-art-sprites';
import { teamColorResolver } from './game-art-team-colors';
import type { GameArtTerrainPicture } from './game-art-layers';
import {
  chooseMapRenderer,
  gpuMapRenderingMessageCode,
  lazyGpuMapProbe,
  probeGpuMapRendering,
  watchGpuContextLoss,
  type GpuMapUnavailableReason,
} from './gpu-map-rendering';
import { mapTestPreviewNotes, presentMessage } from '../shared/message-catalog';
import { decodeConnectionRoutes, type ConnectionRouteSet } from '../shared/connection-routes';
import {
  connectionOverlayPresentation,
  connectionOverlayStroke,
  connectionOverlayTargetKey,
  connectionPathsAvailability,
  connectionRouteBounds,
  connectionTargetPoints,
  dashedSegments,
  failedConnectionSearchColor,
  forEachConnectionOverlayElement,
  hitTestConnectionOverlay,
  nextConnectionOverlayMode,
  sameConnectionOverlayTarget,
  shownConnectionOverlayMode,
  type ConnectionOverlayGeometry,
  type ConnectionOverlayMode,
  type ConnectionOverlayTarget,
} from './preview-connection-routes';
import { gameArtPreviewMap, mapTestPreviewLook } from './map-test-preview';
import { RunningIndicator } from './running-indicator';
import { useI18n } from './i18n';
import {
  useGameArt,
  type GameArtCliffView,
  type GameArtSpriteView,
  type GameArtTerrainView,
} from './use-game-art';
import {
  fallbackTileGridColor,
  terrainLayerTransform,
  TileGridLayer,
  type TileGridColor,
} from './preview-tile-grid';
import { useAppPanelContext } from './app-context';
import { rovingKeyTarget } from './keyboard-navigation';
import type { PreviewExecutionController } from './preview-execution';
import { RunConfigurationPanel } from './run-configuration-panel';
import { ExecutionProfiler } from './execution-profiler-panel';
import { onGameInstallationChanged } from './game-installation';
import { presentPreviewNames, presentTerrainColorSources } from './presentation-names';
import {
  boundaryFrameSides,
  boundarySubpaths,
  type BoundaryMotion,
  cssDurationMilliseconds,
  insetBoundaryFrame,
  nextBoundaryMotion,
  visibleMapBoundary,
} from './preview-boundary';
import { documentTransitionEnvironment, watchSizeTransitions } from './layout-transition';
import { ListMotion } from './list-motion';
import { presenceProps, useHeld, usePresence } from './motion';
import { OverflowingLabel } from './overflow-label';
import { SearchField } from './search-field';
import {
  focusPreviewCanvasQuietly,
  previewLegendMaxHeight,
  rectContainsPoint,
  useCanvasKeyboardFocus,
  useKeyboardCueRise,
  useOverlayPointerHover,
  usePreviewLegendWidth,
  useReadoutLabelGlide,
} from './preview-overlay-interaction';
import { PreviewCandidateLayer, type CandidatePresentation } from './preview-candidate-layer';
import {
  previewLegendContent,
  ProvisionalLegendCounts,
  provisionalLegendLayers,
  selectionFitsCandidate,
  selectionKeptForView,
} from './preview-candidate-legend';
import * as latencyProbe from './latency-probe';
import { previewCandidateStageLabel, type PreviewCandidateView } from './preview-candidate-store';
import {
  cameraRevealingTile,
  describePreviewSelection,
  keyboardCursorFor,
  moveKeyboardSelection,
  panCameraByKeyboard,
  previewKeyboardCommand,
  previewKeyboardHelp,
  previewKeyboardShortcuts,
  type PreviewKeyboardCursor,
} from './preview-keyboard';
import {
  clampPreviewCamera,
  clampedTileAtScreenPoint,
  decodeTopDownScene,
  fitPreviewCamera,
  hasLandConnection,
  hitTestTopDownScene,
  mapRectangleScreenPolygon,
  mapScreenBounds,
  mapToScreen,
  panPreviewCamera,
  previewAppearanceMarkerMinimumRadius,
  previewCliffStrokeWidth,
  previewMarkerScreenRadius,
  previewMarkerVerticalScale,
  previewObjectFootprintSpan,
  previewObjectMarkerScreenRadius,
  previewObjectMarkerSpan,
  previewScale,
  previewScreenTransform,
  previewViewportIsCollapsed,
  rectangularSelectionFromDrag,
  screenToMap,
  visibleTerrainChunks,
  visibleTileRange,
  zoomPreviewCamera,
  type PreviewCamera,
  type PreviewHit,
  type PreviewProjection,
  type PreviewScreenTransform,
  type PreviewSelection,
  type PreviewViewport,
  type TopDownScene,
  type VisibleChunk,
} from './top-down-preview';
import {
  aggregateSelectionLayers,
  aggregateTileIndexLayers,
  cliffMaterial,
  connectionMaterial,
  hasVisiblePreviewFootprint,
  isDrawnPreviewObject,
  legendHighlightKey,
  markerShapePolygon,
  objectMaterial,
  objectNameForId,
  operationTileIndices,
  partitionHelperLayers,
  previewHelperObjectIds,
  previewLegendFilterMatches,
  previewLegendLabels,
  previewReadoutStacked,
  terrainColorSourcesIdentity,
  terrainMaterial,
  resolveAggregatedLayerActivation,
  type AggregatedSelectionLayer,
  type PreviewLayerLabel,
  type PreviewMaterial,
  type PreviewObjectVisibility,
} from './preview-materials';
import {
  terrainElevationRange,
  type ElevationDisplayMode,
  type ElevationRange,
} from './preview-terrain-mesh';
import { buildTerrainTexels } from './preview-terrain-texture';
import { OrderedMarkerLayer } from './preview-marker-mesh';
import { chunkSpriteMatrix } from './game-art-terrain';

const previewPadding = 28;
const narrowPreviewWidth = 380;
type PreviewPointerGesture =
  | {
      kind: 'selection';
      pointerId: number;
      start: PreviewHit;
      end: PreviewHit;
      startScreenX: number;
      startScreenY: number;
      camera: PreviewCamera;
      cancelled?: boolean;
    }
  | {
      kind: 'pan';
      pointerId: number;
      x: number;
      y: number;
      camera: PreviewCamera;
      startCamera: PreviewCamera;
    };

interface DiagnosticOverlays {
  cliffs: boolean;
  connectionTerrain: boolean;
  connections: ConnectionOverlayMode;
  helpers: boolean;
  objects: boolean;
}

const initialOverlays: DiagnosticOverlays = {
  cliffs: true,
  connectionTerrain: true,
  connections: 'off',
  helpers: false,
  objects: true,
};

const overlayButtons = [
  {
    key: 'objects',
    labelId: 'preview-panel.tool.objects',
    renderIcon: (ref: Ref<AnimatedIconHandle>) => (
      <BoxesIcon aria-hidden="true" ref={ref} size={14} />
    ),
  },
  {
    key: 'cliffs',
    labelId: 'preview-panel.tool.cliffs',
    renderIcon: (ref: Ref<AnimatedIconHandle>) => (
      <MountainIcon aria-hidden="true" ref={ref} size={14} />
    ),
  },
  {
    key: 'connectionTerrain',
    labelId: 'preview-panel.tool.connection-terrain',
    renderIcon: (ref: Ref<AnimatedIconHandle>) => (
      <LayersIcon aria-hidden="true" ref={ref} size={14} />
    ),
  },
] as const;

const connectionModeIcons: Record<
  ConnectionOverlayMode,
  (ref: Ref<AnimatedIconHandle>) => ReactNode
> = {
  off: (ref) => <RouteIcon aria-hidden="true" ref={ref} size={14} />,
  lines: (ref) => <RouteIcon aria-hidden="true" ref={ref} size={14} />,
  paths: (ref) => <FootprintsIcon aria-hidden="true" ref={ref} size={14} />,
};

const elevationModeButtons = [
  {
    key: 'off',
    labelId: 'preview-panel.tool.elevation.off',
    renderIcon: (ref: Ref<AnimatedIconHandle>) => (
      <EyeOffIcon aria-hidden="true" ref={ref} size={14} />
    ),
  },
  {
    key: 'terrain',
    labelId: 'preview-panel.tool.elevation.terrain',
    renderIcon: (ref: Ref<AnimatedIconHandle>) => (
      <SunDimIcon aria-hidden="true" ref={ref} size={14} />
    ),
  },
  {
    key: 'height-map',
    labelId: 'preview-panel.tool.elevation.height-map',
    renderIcon: (ref: Ref<AnimatedIconHandle>) => (
      <ChartNoAxesColumnIcon aria-hidden="true" ref={ref} size={14} />
    ),
  },
] as const;

const projectionModeButtons = [
  {
    key: 'orthographic',
    labelId: 'preview-panel.tool.perspective.top-down',
    renderIcon: (ref: Ref<AnimatedIconHandle>) => (
      <MoveDiagonal2Icon aria-hidden="true" ref={ref} size={14} />
    ),
  },
  {
    key: 'minimap',
    labelId: 'preview-panel.tool.perspective.diamond',
    renderIcon: (ref: Ref<AnimatedIconHandle>) => (
      <MapIcon aria-hidden="true" ref={ref} size={14} />
    ),
  },
] as const;

const lookButtons = [
  {
    key: 'minimap',
    labelId: 'preview-panel.tool.look.minimap',
    renderIcon: (ref: Ref<AnimatedIconHandle>) => (
      <LayoutGridIcon aria-hidden="true" ref={ref} size={14} />
    ),
  },
  {
    key: 'texture-colors',
    labelId: 'preview-panel.tool.look.texture-colors',
    renderIcon: (ref: Ref<AnimatedIconHandle>) => (
      <DropletIcon aria-hidden="true" ref={ref} size={14} />
    ),
  },
  {
    key: 'game-textures',
    labelId: 'preview-panel.tool.look.game-textures',
    renderIcon: (ref: Ref<AnimatedIconHandle>) => (
      <ImageIcon aria-hidden="true" ref={ref} size={14} />
    ),
  },
] as const;

const tileGridButton = {
  key: 'tileGrid',
  labelId: 'preview-panel.tool.tile-grid',
  renderIcon: () => <Grid3x3 aria-hidden="true" size={14} />,
} as const;

function perspectiveProjection(perspective: PreviewPerspective): PreviewProjection {
  return perspective === 'diamond' ? 'minimap' : 'orthographic';
}

function projectionPerspective(projection: PreviewProjection): PreviewPerspective {
  return projection === 'minimap' ? 'diamond' : 'top-down';
}

export function previewCanvasLabel(perspective: PreviewPerspective, look: PreviewLook): string {
  if (perspective === 'diamond') {
    if (look === 'game-textures') return translate('preview-panel.canvas.diamond.game-textures');
    return look === 'texture-colors'
      ? translate('preview-panel.canvas.diamond.texture-colors')
      : translate('preview-panel.canvas.diamond.minimap');
  }
  if (look === 'game-textures') return translate('preview-panel.canvas.top-down.game-textures');
  return look === 'texture-colors'
    ? translate('preview-panel.canvas.top-down.texture-colors')
    : translate('preview-panel.canvas.top-down.minimap');
}

function nextElevationDisplayMode(mode: ElevationDisplayMode): ElevationDisplayMode {
  const currentIndex = elevationModeButtons.findIndex(({ key }) => key === mode);
  return elevationModeButtons[(currentIndex + 1) % elevationModeButtons.length]!.key;
}

function nextPreviewProjection(mode: PreviewProjection): PreviewProjection {
  const currentIndex = projectionModeButtons.findIndex(({ key }) => key === mode);
  return projectionModeButtons[(currentIndex + 1) % projectionModeButtons.length]!.key;
}

function PreviewOverlayButton({
  active,
  className,
  label,
  onToggle,
  renderIcon,
}: {
  active: boolean;
  className?: string;
  label: string;
  onToggle(): void;
  renderIcon(ref: Ref<AnimatedIconHandle>): ReactNode;
}) {
  const { animationHandlers, iconRef } = useAnimatedIconHover();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            {...animationHandlers}
            aria-label={label}
            aria-pressed={active}
            className={className ? `preview-map-tool ${className}` : 'preview-map-tool'}
            onClick={onToggle}
            size="icon-compact"
            variant="secondary"
          />
        }
      >
        {renderIcon(iconRef)}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function PreviewElevationModeButton({
  mode,
  onCycle,
}: {
  mode: ElevationDisplayMode;
  onCycle(): void;
}) {
  const { t } = useI18n();
  const { animationHandlers, iconRef } = useAnimatedIconHover();
  const current = elevationModeButtons.find(({ key }) => key === mode)!;
  const label = t(current.labelId);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            {...animationHandlers}
            aria-label={label}
            className="preview-map-tool preview-elevation-mode-button"
            data-mode={mode}
            onClick={onCycle}
            size="icon-compact"
            variant="secondary"
          />
        }
      >
        {current.renderIcon(iconRef)}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function PreviewConnectionOverlayButton({
  label,
  mode,
  note,
  onCycle,
}: {
  label: string;
  mode: ConnectionOverlayMode;
  note: string | null;
  onCycle(): void;
}) {
  const { animationHandlers, iconRef } = useAnimatedIconHover();
  const noteId = useId();
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              {...animationHandlers}
              aria-describedby={note ? noteId : undefined}
              aria-label={label}
              className="preview-map-tool preview-connection-mode-button"
              data-mode={mode}
              onClick={onCycle}
              size="icon-compact"
              variant="secondary"
            />
          }
        >
          {connectionModeIcons[mode](iconRef)}
        </TooltipTrigger>
        <TooltipContent>
          <span className="preview-map-tool-tooltip" data-testid="connection-mode-tooltip">
            <span>{label}</span>
            {note ? <span className="preview-map-tool-tooltip-note">{note}</span> : null}
          </span>
        </TooltipContent>
      </Tooltip>
      {note ? (
        <span className="sr-only" id={noteId}>
          {note}
        </span>
      ) : null}
    </>
  );
}

function PreviewLookButton({
  look,
  lockedReason,
  onCycle,
  pending,
}: {
  look: PreviewLook;
  lockedReason: string | null;
  onCycle(): void;
  pending: boolean;
}) {
  const { t } = useI18n();
  const { animationHandlers, iconRef } = useAnimatedIconHover();
  const reasonId = useId();
  const current = lookButtons.find(({ key }) => key === look)!;
  const label = t(current.labelId);
  const locked = lockedReason !== null && !pending;
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              {...(locked ? {} : animationHandlers)}
              aria-busy={pending || undefined}
              aria-describedby={locked ? reasonId : undefined}
              aria-label={label}
              className="preview-map-tool preview-look-button"
              data-look={look}
              data-locked={locked || undefined}
              data-pending={pending || undefined}
              disabled={pending || locked}
              focusableWhenDisabled={locked}
              onClick={onCycle}
              size="icon-compact"
              variant="secondary"
            />
          }
        >
          {pending ? (
            <RunningIndicator size={14} testId="preview-look-pending" />
          ) : (
            current.renderIcon(iconRef)
          )}
        </TooltipTrigger>
        <TooltipContent>
          {pending ? t('preview-panel.tool.look.applying') : locked ? lockedReason : label}
        </TooltipContent>
      </Tooltip>
      {locked ? (
        <span className="sr-only" id={reasonId}>
          {lockedReason}
        </span>
      ) : null}
    </>
  );
}

function PreviewProjectionModeButton({
  mode,
  onCycle,
}: {
  mode: PreviewProjection;
  onCycle(): void;
}) {
  const { t } = useI18n();
  const { animationHandlers, iconRef } = useAnimatedIconHover();
  const current = projectionModeButtons.find(({ key }) => key === mode)!;
  const label = t(current.labelId);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            {...animationHandlers}
            aria-label={label}
            className="preview-map-tool preview-projection-mode-button"
            data-mode={mode}
            onClick={onCycle}
            size="icon-compact"
            variant="secondary"
          />
        }
      >
        {current.renderIcon(iconRef)}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

const cameraEaseDurationMs = 160;

interface CameraAnimation {
  from: PreviewCamera;
  startedAt: number;
  target: PreviewCamera;
}

interface CachedTerrainChunk {
  container: Container;
  texture: Texture;
  tileCount: number;
}

interface TerrainChunkCache {
  backend: PreviewBackend;
  chunks: Map<string, CachedTerrainChunk>;
  container: Container;
  elevationMode: ElevationDisplayMode;
  elevationRange: ElevationRange;
  geometryBuilds: number;
  heightOverlayColor: number;
  key: string;
  minimapPalette: SelectedMinimapPalette | null;
  scene: TopDownScene;
  terrainColorSources: TerrainColorSources;
  lookTerrainColors: ReadonlyMap<number, number> | undefined;
  terrainIds: readonly number[];
  terrainSource: BufferImageSource | null;
  gameArtTerrain: { view: GameArtTerrainView; layer: GameArtTerrainPicture } | null;
  gameArtSprites: { view: GameArtSpriteView; layer: GameArtSpriteLayer } | null;
  gameArtStore: { bytes: number } | null;
  gameArtCliffs: { view: GameArtCliffView; layer: GameArtCliffBandLayer } | null;
  gameArtPresentation: GameArtPresentationState;
  tileGrid: TileGridLayer | null;
}

interface TerrainColorSources {
  identity: string;
  localTerrainColors: readonly TerrainMinimapColor[] | undefined;
  terrainNames: PreviewGenerationResult['terrainNames'];
}

function useBoundaryMotion(active: boolean): BoundaryMotion {
  const [motion, setMotion] = useState<BoundaryMotion>(active ? 'spinning' : 'rest');
  const next = nextBoundaryMotion(motion, active);
  if (next !== motion) setMotion(next);
  useEffect(() => {
    if (motion !== 'settling') return undefined;
    const settleMs = cssDurationMilliseconds(
      getComputedStyle(document.documentElement).getPropertyValue(
        '--motion-duration-rotation-settle',
      ),
    );
    const timer = window.setTimeout(
      () => setMotion((current) => (current === 'settling' ? 'rest' : current)),
      settleMs,
    );
    return () => window.clearTimeout(timer);
  }, [motion]);
  return next;
}

export function PreviewPanel() {
  const { t, translator } = useI18n();
  const host = useRef<HTMLDivElement>(null);
  const application = useRef<Application | null>(null);
  const gesture = useRef<PreviewPointerGesture | null>(null);
  const selectionOutline = useRef<Graphics | null>(null);
  const sourceHighlightOutline = useRef<Graphics | null>(null);
  const legendHoverOutline = useRef<Graphics | null>(null);
  const legendHoverTileIndices = useRef<number[]>([]);
  const mapBoundary = useRef<MapBoundaryElements>({
    arc: null,
    border: null,
    frame: null,
    outline: null,
    strokeWidth: 4,
  });
  const selectionDimensions = useRef<string | null>(null);
  const terrainChunkCache = useRef<TerrainChunkCache | null>(null);
  const candidateLayer = useRef<PreviewCandidateLayer | null>(null);
  const stashedCamera = useRef<{
    dimensions: string;
    camera: PreviewCamera;
    fitted: boolean;
  } | null>(null);
  const previousCommittedDimensions = useRef<string | null>(null);
  const renderedMapLayer = useRef<Container | null>(null);
  const renderedCamera = useRef<PreviewCamera>(fitPreviewCamera(1, 1));
  const displayedCamera = useRef<PreviewCamera>(fitPreviewCamera(1, 1));
  const cameraIsFitted = useRef(true);
  const pendingCamera = useRef<PreviewCamera | null>(null);
  const frozenCanvasTransform = useRef<
    ((width: number, height: number) => PreviewScreenTransform | null) | null
  >(null);
  const refreshFrozenCanvas = useRef<(() => void) | null>(null);
  const sceneBuilds = useRef(0);
  const cameraAnimation = useRef<CameraAnimation | null>(null);
  const cameraAnimationFrame = useRef<number | null>(null);
  const previousMapDimensions = useRef<string | null>(null);
  const keyboardInput = useRef<{
    fit(): void;
    pan(direction: { screenX: number; screenY: number }): void;
    reveal(tile: { x: number; y: number }): void;
    scene: TopDownScene | null;
    selection: PreviewSelection | null;
    zoom(factor: number): void;
  }>({ fit() {}, pan() {}, reveal() {}, scene: null, selection: null, zoom() {} });
  const keyboardCursor = useRef<{
    selection: PreviewSelection;
    state: PreviewKeyboardCursor;
  } | null>(null);
  const keyboardHelpId = useId();
  const [pixiReady, setPixiReady] = useState(false);
  const [presetControlHost, setPresetControlHost] = useState<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState<PreviewViewport>({
    width: 1,
    height: 1,
    padding: previewPadding,
    projection: 'orthographic',
  });
  const [camera, setCamera] = useState<PreviewCamera>(() => fitPreviewCamera(1, 1));
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const [overlays, setOverlays] = useState<DiagnosticOverlays>(initialOverlays);
  const [elevationMode, setElevationMode] = useState<ElevationDisplayMode>('terrain');
  const [hoveredCoordinate, setHoveredCoordinate] = useState<{ x: number; y: number } | null>(null);
  const [selection, setSelection] = useState<PreviewSelection | null>(null);
  const [selectionPreview, setSelectionPreview] = useState<PreviewSelection | null>(null);
  const {
    appendOutput,
    executionProfiler,
    expandPreview,
    highlightedPreviewOperationIndices,
    map,
    outputProfilerHost,
    outputVersionHost,
    previewCandidates,
    previewExecution,
    previewExpanded,
    profilerOpen,
    setProfilerOpen,
    resolvedTheme,
    selectPreviewOperation,
    previewPerspective,
    setPreviewPerspective,
    previewLook,
    setPreviewLook,
    previewTileGrid,
    setPreviewTileGrid,
    gpuMapRendering,
    previewMapOrigin,
    mapTestPreviewShown,
  } = useAppPanelContext();
  const drawnLook = mapTestPreviewLook(previewLook, mapTestPreviewShown);
  const [gpuUnavailable, setGpuUnavailable] = useState<GpuMapUnavailableReason | null>(null);
  const mapRenderer = chooseMapRenderer(gpuMapRendering, gpuUnavailable);
  const [gpuProbe] = useState(() =>
    lazyGpuMapProbe((renderer: object) => probeGpuMapRendering(renderer as never)),
  );
  const projectionMode = perspectiveProjection(previewPerspective);
  const scene = useMemo(() => (map ? decodeTopDownScene(map) : null), [map]);
  const connectionRoutes = useMemo<ConnectionRouteSet | null>(
    () => (map ? decodeConnectionRoutes(map) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [map?.connectionRoutes, map?.semanticHash],
  );
  const connectionRouteHitBounds = useMemo(
    () => (connectionRoutes ? connectionRouteBounds(connectionRoutes) : null),
    [connectionRoutes],
  );
  const [candidateView, setCandidateView] = useState<PreviewCandidateView | null>(
    () => previewCandidates.view,
  );
  useEffect(() => {
    setCandidateView(previewCandidates.view);
    return previewCandidates.subscribe((view) => setCandidateView(view));
  }, [previewCandidates]);
  const candidateActive = candidateView !== null;
  const candidateActiveRef = useRef(candidateActive);
  candidateActiveRef.current = candidateActive;
  const generationActivity = useSyncExternalStore(
    previewCandidates.subscribeActivity,
    previewCandidates.getActivity,
  );
  const generationActive = generationActivity !== null;
  const boundaryMotion = useBoundaryMotion(generationActive);
  useOverlayPointerHover(host);
  useReadoutLabelGlide(host);
  useCanvasKeyboardFocus(host);
  const outdatedMapShown = generationActive && !candidateActive;
  const connectionMapFinal = map !== null && !generationActive;
  const connectionPaths = connectionPathsAvailability(connectionRoutes, connectionMapFinal);
  const shownConnectionMode = shownConnectionOverlayMode(overlays.connections, connectionPaths);
  const connectionPresentation = connectionOverlayPresentation(
    shownConnectionMode,
    connectionPaths,
    connectionRoutes,
  );
  const candidateWidth = candidateView?.width ?? 0;
  const candidateHeight = candidateView?.height ?? 0;
  const candidateScene = useMemo(
    () =>
      candidateActive && candidateWidth > 0
        ? emptyViewScene(candidateWidth, candidateHeight)
        : null,
    [candidateActive, candidateHeight, candidateWidth],
  );
  const candidateCoversScene =
    candidateScene !== null &&
    (!scene || scene.width !== candidateScene.width || scene.height !== candidateScene.height);
  const viewScene = candidateCoversScene ? candidateScene : scene;
  const viewAvailable = viewScene !== null;
  const [localNames, setLocalNames] = useState<LocalPresentationNames | null>(null);
  const [installationRevision, setInstallationRevision] = useState(0);
  useEffect(() => {
    const reread = () => setInstallationRevision((current) => current + 1);
    const stopInstallation = onGameInstallationChanged(reread);
    const stopLocale = window.rmside.onLocaleChanged(reread);
    return () => {
      stopInstallation();
      stopLocale();
    };
  }, []);
  useEffect(() => {
    let current = true;
    void window.rmside
      .getLocalPresentationNames()
      .then((names) => {
        if (current) setLocalNames(names);
      })
      .catch(() => {
        if (current) setLocalNames(null);
      });
    return () => {
      current = false;
    };
  }, [installationRevision, map]);
  const presentedMap = useMemo(
    () => (map ? presentPreviewNames(map, localNames) : null),
    [localNames, map],
  );
  const terrainColorIdentity = presentedMap ? terrainColorSourcesIdentity(presentedMap) : '';
  const terrainColorSources = useMemo<TerrainColorSources>(
    () => ({
      identity: terrainColorIdentity,
      localTerrainColors: presentedMap?.localTerrainColors,
      terrainNames: presentedMap?.terrainNames ?? [],
    }),
    [terrainColorIdentity],
  );
  const shownHelperObjectIds = useRef<ReadonlySet<number>>(new Set<number>());
  const helperObjectIds = useMemo(() => {
    const next = map ? previewHelperObjectIds(map, localNames) : new Set<number>();
    const previous = shownHelperObjectIds.current;
    if (next.size === previous.size && [...next].every((id) => previous.has(id))) return previous;
    shownHelperObjectIds.current = next;
    return next;
  }, [localNames, map]);
  const objectVisibility = useMemo<PreviewObjectVisibility>(
    () => ({ helperObjectIds, helpers: overlays.helpers, objects: overlays.objects }),
    [helperObjectIds, overlays.helpers, overlays.objects],
  );
  const spriteEligible = useCallback(
    (object: TopDownScene['objects'][number]) =>
      isDrawnPreviewObject(object, {
        helperObjectIds,
        helpers: false,
        objects: true,
        decorations: true,
      }),
    [helperObjectIds],
  );
  const gameArtMinimapColor = useCallback(
    (terrainId: number) =>
      terrainMaterial(
        terrainId,
        map?.backend ?? 'synthetic',
        map?.minimapPalette ?? null,
        terrainColorSources.terrainNames,
        undefined,
        terrainColorSources.localTerrainColors,
      ).color,
    [map?.backend, map?.minimapPalette, terrainColorSources],
  );
  const presentedObjectNames = presentedMap?.objectNames;
  const gameArtObjectName = useCallback(
    (objectId: number) =>
      presentedObjectNames ? objectNameForId(presentedObjectNames, objectId) : null,
    [presentedObjectNames],
  );
  const gameArtMap = gameArtPreviewMap(map, previewMapOrigin);
  const gameArtScene = gameArtMap ? scene : null;
  const gameArt = useGameArt({
    look: drawnLook,
    perspective: previewPerspective,
    map: gameArtMap,
    scene: gameArtScene,
    terrainIds: gameArtScene
      ? overlays.connectionTerrain
        ? gameArtScene.terrainIds
        : gameArtScene.preConnectionTerrainIds
      : null,
    drawn: spriteEligible,
    objectsShown: overlays.objects,
    minimapColor: gameArtMinimapColor,
    objectName: gameArtObjectName,
    appendOutput,
  });
  const gameArtTerrainView = candidateCoversScene ? null : gameArt.terrain;
  const gameArtSpriteView =
    candidateCoversScene || previewPerspective !== 'diamond' ? null : gameArt.sprites;
  const gameArtCliffBandView =
    candidateCoversScene || previewPerspective !== 'top-down' ? null : gameArt.cliffs;
  const gameArtStore = gameArt.store;
  const gameArtExpected = gameArt.expected;
  const gameArtTeamColor = useMemo(
    () => teamColorResolver(gameArt.playerColors, map?.playerColorIds),
    [gameArt.playerColors, map?.playerColorIds],
  );
  const reportedGpuReason = useRef<GpuMapUnavailableReason | null>(null);
  useEffect(() => {
    if (!gpuMapRendering || !gpuUnavailable || reportedGpuReason.current === gpuUnavailable) {
      return;
    }
    if (!gameArtExpected) return;
    reportedGpuReason.current = gpuUnavailable;
    appendOutput(
      presentMessage({ source: 'Preview', code: gpuMapRenderingMessageCode(gpuUnavailable) }),
    );
  }, [appendOutput, gameArtExpected, gpuMapRendering, gpuUnavailable]);
  const [gameArtPresentedKey, setGameArtPresentedKey] = useState<string | null>(null);
  const gameArtPending =
    viewAvailable &&
    !candidateCoversScene &&
    gameArtMap !== null &&
    gameArtExpected &&
    (gameArt.pending ||
      gameArtTerrainView === null ||
      gameArtPresentedKey !== gameArtTerrainView.key);
  const shownLook = shownPreviewLook(drawnLook, gameArt.offered);
  const flatLook = flatPreviewLook(shownLook, gameArt.expected);
  const textureColorsShown: TextureLookColors | null =
    flatLook === 'texture-colors' && !candidateCoversScene && map?.texturePalette
      ? textureLookColors(map.texturePalette)
      : null;
  const lookPending = gameArtPending;
  const cliffLook: PreviewLook = gameArt.active
    ? 'game-textures'
    : textureColorsShown
      ? 'texture-colors'
      : 'minimap';
  const markerObjectColors = candidateCoversScene
    ? undefined
    : lookMarkerObjectColors(cliffLook, map?.texturePalette);
  const legendMap = useMemo(
    () =>
      presentedMap
        ? {
            ...presentedMap,
            look: cliffLook,
            ...(textureColorsShown
              ? { lookColors: textureColorsShown }
              : markerObjectColors
                ? {
                    lookColors: {
                      terrains: new Map<number, number>(),
                      gaiaObjects: markerObjectColors,
                      cliffs: new Map<number, number>(),
                    },
                  }
                : {}),
          }
        : presentedMap,
    [cliffLook, markerObjectColors, presentedMap, textureColorsShown],
  );
  const sourceHighlightTileIndices = useMemo(
    () =>
      map && scene && !generationActive
        ? operationTileIndices(map, scene, highlightedPreviewOperationIndices, {
            selection,
            visibility: objectVisibility,
          })
        : [],
    [generationActive, highlightedPreviewOperationIndices, map, objectVisibility, scene, selection],
  );
  const displaySelection = candidateActive
    ? selectionFitsCandidate(selection, candidateWidth, candidateHeight)
      ? selection
      : null
    : selection;
  const sourceHighlightTiles = useRef<readonly number[]>(sourceHighlightTileIndices);
  sourceHighlightTiles.current = sourceHighlightTileIndices;
  const connectionHover = useRef<ConnectionOverlayTarget | null>(null);
  const connectionFinal = useRef(connectionMapFinal);
  connectionFinal.current = connectionMapFinal;
  const clearConnectionHover = useRef<() => void>(() => {});
  useEffect(() => {
    if (!connectionMapFinal) clearConnectionHover.current();
  }, [connectionMapFinal]);
  const connectionActivation = useRef<(target: ConnectionOverlayTarget) => void>(() => {});
  connectionActivation.current = (target) => {
    if (!map || candidateActiveRef.current || target.operationIndex === null) return;
    if (!map.provenanceOperations[target.operationIndex]) return;
    selectPreviewOperation(target.operationIndex);
  };

  useEffect(() => {
    setViewport((current) =>
      current.projection === projectionMode ? current : { ...current, projection: projectionMode },
    );
    const canvas = application.current?.canvas;
    if (canvas) {
      canvas.setAttribute(
        'aria-label',
        previewCanvasLabel(
          projectionPerspective(projectionMode),
          gameArt.active && !gameArtPending
            ? 'game-textures'
            : textureColorsShown
              ? 'texture-colors'
              : 'minimap',
        ),
      );
      canvas.setAttribute(
        'aria-roledescription',
        translate('preview-panel.canvas.role-description'),
      );
    }
  }, [gameArt.active, gameArtPending, projectionMode, pixiReady, textureColorsShown, translator]);

  const stopCameraAnimation = useCallback(() => {
    if (cameraAnimationFrame.current !== null) {
      window.cancelAnimationFrame(cameraAnimationFrame.current);
      cameraAnimationFrame.current = null;
    }
    cameraAnimation.current = null;
    const container = host.current;
    if (container) delete container.dataset.cameraAnimation;
  }, []);

  const applyDisplayedCamera = useCallback(
    (next: PreviewCamera) => {
      if (!viewScene) return;
      displayedCamera.current = next;
      const terrainCache = terrainChunkCache.current;
      const container = host.current;
      if (terrainCache) transformTerrainLayer(terrainCache.container, next, viewScene, viewport);
      candidateLayer.current?.transform(next, viewport, viewScene);
      const layer = renderedMapLayer.current;
      if (layer) transformMapLayer(layer, renderedCamera.current, next, viewScene, viewport);
      drawPreviewOutlines(
        selectionOutline.current,
        sourceHighlightOutline.current,
        legendHoverOutline.current,
        mapBoundary.current,
        viewScene,
        next,
        viewport,
        displaySelection,
        sourceHighlightTiles.current,
        legendHoverTileIndices.current,
      );
      if (container) {
        setCameraDataset(container, viewScene, next, viewport);
        container.dataset.outlineCameraZoom = next.zoom.toFixed(4);
      }
    },
    [displaySelection, viewScene, viewport],
  );

  const commitCameraTransition = useCallback(() => {
    const next = displayedCamera.current;
    stopCameraAnimation();
    pendingCamera.current = null;
    return next;
  }, [stopCameraAnimation]);

  const scheduleCameraTransition = useCallback(
    (next: PreviewCamera) => {
      if (!viewScene) return;
      pendingCamera.current = next;
      const container = host.current;
      if (container) container.dataset.cameraAnimation = 'ease-out';
      const terrainCache = terrainChunkCache.current;
      if (terrainCache) {
        updateTerrainChunkVisibility(
          terrainCache,
          [displayedCamera.current, next],
          viewport,
          container,
        );
      }
      const reduceMotion = globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;
      cameraAnimation.current = {
        from: displayedCamera.current,
        startedAt: performance.now(),
        target: next,
      };
      const animate = (now: number) => {
        const active = cameraAnimation.current;
        if (!active) return;
        const progress = reduceMotion
          ? 1
          : Math.min(1, Math.max(0, (now - active.startedAt) / cameraEaseDurationMs));
        const easedProgress = 1 - (1 - progress) ** 3;
        const frameCamera = interpolateCamera(active.from, active.target, easedProgress);
        applyDisplayedCamera(frameCamera);
        if (progress < 1) {
          cameraAnimationFrame.current = window.requestAnimationFrame(animate);
          return;
        }
        cameraAnimationFrame.current = null;
        cameraAnimation.current = null;
        pendingCamera.current = null;
        displayedCamera.current = active.target;
        if (terrainCache) {
          updateTerrainChunkVisibility(terrainCache, [active.target], viewport, container);
        }
        if (container) delete container.dataset.cameraAnimation;
        setCamera(active.target);
      };
      if (cameraAnimationFrame.current === null) {
        cameraAnimationFrame.current = window.requestAnimationFrame(animate);
      }
    },
    [applyDisplayedCamera, viewScene, viewport],
  );

  const fit = useCallback(() => {
    if (!viewScene) return;
    cameraIsFitted.current = true;
    scheduleCameraTransition(fitPreviewCamera(viewScene.width, viewScene.height));
  }, [viewScene, scheduleCameraTransition]);

  const zoom = useCallback(
    (factor: number, anchor = { x: viewport.width / 2, y: viewport.height / 2 }) => {
      if (!viewScene) return;
      cameraIsFitted.current = false;
      scheduleCameraTransition(
        zoomPreviewCamera(
          pendingCamera.current ?? displayedCamera.current,
          factor,
          anchor,
          viewScene.width,
          viewScene.height,
          viewport,
        ),
      );
    },
    [viewScene, scheduleCameraTransition, viewport],
  );
  const pan = useCallback(
    (direction: { screenX: number; screenY: number }) => {
      if (!viewScene) return;
      cameraIsFitted.current = false;
      scheduleCameraTransition(
        panCameraByKeyboard(
          pendingCamera.current ?? displayedCamera.current,
          direction,
          viewScene.width,
          viewScene.height,
          viewport,
        ),
      );
    },
    [viewScene, scheduleCameraTransition, viewport],
  );
  const reveal = useCallback(
    (tile: { x: number; y: number }) => {
      if (!viewScene) return;
      const next = cameraRevealingTile(
        pendingCamera.current ?? displayedCamera.current,
        tile,
        viewScene.width,
        viewScene.height,
        viewport,
      );
      if (!next) return;
      cameraIsFitted.current = false;
      scheduleCameraTransition(next);
    },
    [viewScene, scheduleCameraTransition, viewport],
  );
  keyboardInput.current = { fit, pan, reveal, scene: viewScene, selection, zoom };

  useEffect(() => {
    const dimensions = scene ? `${scene.width}x${scene.height}` : null;
    const changed = previousCommittedDimensions.current !== dimensions;
    previousCommittedDimensions.current = dimensions;
    if (!scene || (changed && !selectionKeptForView(selectionDimensions.current, dimensions))) {
      selectionDimensions.current = null;
      setSelection(null);
      setSelectionPreview(null);
    }
  }, [scene]);
  useEffect(() => {
    if (candidateActive) return;
    const dimensions = scene ? `${scene.width}x${scene.height}` : null;
    if (!selectionKeptForView(selectionDimensions.current, dimensions)) {
      selectionDimensions.current = null;
      setSelection(null);
      setSelectionPreview(null);
    }
  }, [candidateActive, scene]);

  useEffect(() => {
    if (!viewScene) {
      previousMapDimensions.current = null;
      stashedCamera.current = null;
      stopCameraAnimation();
      pendingCamera.current = null;
      setHoveredCoordinate(null);
      return;
    }
    const transitionTarget = pendingCamera.current;
    stopCameraAnimation();
    pendingCamera.current = null;
    const previousDimensions = previousMapDimensions.current;
    const dimensions = `${viewScene.width}x${viewScene.height}`;
    const dimensionsChanged = previousDimensions !== dimensions;
    previousMapDimensions.current = dimensions;
    let nextCamera: PreviewCamera;
    if (!dimensionsChanged) {
      nextCamera = clampPreviewCamera(
        transitionTarget ?? displayedCamera.current,
        viewScene.width,
        viewScene.height,
        viewport,
      );
    } else if (candidateCoversScene && scene && previousDimensions) {
      stashedCamera.current = {
        dimensions: previousDimensions,
        camera: displayedCamera.current,
        fitted: cameraIsFitted.current,
      };
      cameraIsFitted.current = true;
      nextCamera = fitPreviewCamera(viewScene.width, viewScene.height);
    } else if (!candidateCoversScene && stashedCamera.current?.dimensions === dimensions) {
      cameraIsFitted.current = stashedCamera.current.fitted;
      nextCamera = clampPreviewCamera(
        stashedCamera.current.camera,
        viewScene.width,
        viewScene.height,
        viewport,
      );
    } else {
      cameraIsFitted.current = true;
      nextCamera = fitPreviewCamera(viewScene.width, viewScene.height);
    }
    if (!candidateCoversScene) stashedCamera.current = null;
    displayedCamera.current = nextCamera;
    setCamera((current) => (samePreviewCamera(current, nextCamera) ? current : nextCamera));
    setHoveredCoordinate(null);
  }, [
    candidateCoversScene,
    map?.semanticHash,
    stopCameraAnimation,
    viewScene?.height,
    viewScene?.width,
    viewport,
  ]);

  useEffect(() => {
    if (!viewScene) return;
    const transitionTarget = pendingCamera.current;
    stopCameraAnimation();
    const clampedCamera = cameraIsFitted.current
      ? fitPreviewCamera(viewScene.width, viewScene.height)
      : clampPreviewCamera(
          transitionTarget ?? displayedCamera.current,
          viewScene.width,
          viewScene.height,
          viewport,
        );
    pendingCamera.current = null;
    displayedCamera.current = clampedCamera;
    setCamera((current) => (samePreviewCamera(current, clampedCamera) ? current : clampedCamera));
  }, [viewScene?.height, viewScene?.width, stopCameraAnimation, viewport]);

  useEffect(() => () => stopCameraAnimation(), [stopCameraAnimation]);

  useEffect(() => {
    const container = host.current;
    if (!container || !viewAvailable) return undefined;
    const pixi = new Application();
    let disposed = false;
    let initialized = false;
    let stopContextWatch: (() => void) | null = null;
    setPixiReady(false);
    const initialWidth = Math.max(1, container.clientWidth);
    const initialHeight = Math.max(1, container.clientHeight);
    void pixi
      .init({
        antialias: false,
        autoDensity: true,
        backgroundAlpha: 0,
        height: initialHeight,
        preference: 'webgl',
        resolution: Math.min(globalThis.devicePixelRatio || 1, 2),
        width: initialWidth,
      })
      .then(() => {
        initialized = true;
        if (disposed) {
          pixi.destroy(true, { children: true });
          return;
        }
        pixi.canvas.setAttribute('aria-label', previewCanvasLabel('top-down', 'minimap'));
        pixi.canvas.setAttribute('data-testid', 'top-down-map-canvas');
        pixi.canvas.setAttribute('role', 'application');
        pixi.canvas.setAttribute(
          'aria-roledescription',
          translate('preview-panel.canvas.role-description'),
        );
        pixi.canvas.setAttribute('aria-describedby', keyboardHelpId);
        pixi.canvas.setAttribute('aria-keyshortcuts', previewKeyboardShortcuts);
        pixi.canvas.tabIndex = 0;
        pixi.canvas.style.cursor = 'crosshair';
        container.prepend(pixi.canvas);
        stopContextWatch = watchGpuContextLoss(pixi.canvas, () =>
          setGpuUnavailable('context-lost'),
        );
        application.current = pixi;
        const width = Math.max(1, container.clientWidth);
        const height = Math.max(1, container.clientHeight);
        pixi.renderer.resize(width, height);
        requestedSize = { width, height };
        setViewport((current) => ({
          width,
          height,
          padding: previewPadding,
          projection: current.projection,
        }));
        setPixiReady(true);
      });
    let viewportCommits = 0;
    let requestedSize: { width: number; height: number } | null = null;
    const commitViewport = (width: number, height: number, synchronous: boolean) => {
      clearFrozenCanvas(initialized && !disposed ? pixi.canvas : null);
      if (
        initialized &&
        !disposed &&
        (pixi.renderer.screen.width !== width || pixi.renderer.screen.height !== height)
      ) {
        pixi.renderer.resize(width, height);
      }
      const previous = requestedSize ?? viewportRef.current;
      if (previous.width === width && previous.height === height) return;
      requestedSize = { width, height };
      viewportCommits += 1;
      container.dataset.viewportCommits = String(viewportCommits);
      const update = () =>
        setViewport((current) =>
          current.width === width && current.height === height
            ? current
            : { width, height, padding: previewPadding, projection: current.projection },
        );
      if (!synchronous) {
        update();
        return;
      }
      flushSync(update);
      if (initialized && !disposed) pixi.render();
    };
    let frozenSize: { width: number; height: number } | null = null;
    const showFrozenCanvas = () => {
      if (!frozenSize || !initialized || disposed) return;
      const transform = frozenCanvasTransform.current?.(frozenSize.width, frozenSize.height);
      applyFrozenCanvas(pixi.canvas, transform ?? null);
    };
    refreshFrozenCanvas.current = showFrozenCanvas;
    const transitionWatch = watchSizeTransitions(
      (target) => target instanceof Node && target.contains(container),
      {
        onStart: () => {
          container.dataset.layoutTransition = 'running';
        },
        onSettle: () => {
          delete container.dataset.layoutTransition;
          const settled = frozenSize;
          frozenSize = null;
          if (!settled) return;
          const width = Math.max(1, container.clientWidth);
          const height = Math.max(1, container.clientHeight);
          if (
            frozenCanvasTransform.current &&
            !previewViewportIsCollapsed(viewportRef.current) &&
            previewViewportIsCollapsed({ ...viewportRef.current, width, height })
          ) {
            frozenSize = { width, height };
            showFrozenCanvas();
            frozenSize = null;
            return;
          }
          commitViewport(width, height, true);
        },
      },
      documentTransitionEnvironment(container.ownerDocument),
    );
    const resizeObserver = new ResizeObserver(() => {
      const width = Math.max(1, container.clientWidth);
      const height = Math.max(1, container.clientHeight);
      if (transitionWatch.active && frozenCanvasTransform.current) {
        frozenSize = { width, height };
        showFrozenCanvas();
        return;
      }
      commitViewport(width, height, false);
    });
    resizeObserver.observe(container);
    return () => {
      disposed = true;
      transitionWatch.dispose();
      if (refreshFrozenCanvas.current === showFrozenCanvas) refreshFrozenCanvas.current = null;
      delete container.dataset.layoutTransition;
      resizeObserver.disconnect();
      stopContextWatch?.();
      setPixiReady(false);
      if (application.current === pixi) application.current = null;
      candidateLayer.current?.destroy();
      candidateLayer.current = null;
      const terrainCache = terrainChunkCache.current;
      if (terrainCache) {
        destroyTerrainChunkCache(terrainCache);
        terrainChunkCache.current = null;
      }
      if (initialized) pixi.destroy(true, { children: true });
    };
  }, [viewAvailable]);

  useEffect(() => {
    const pixi = application.current;
    const container = host.current;
    const scene = viewScene;
    if (!pixiReady || !pixi || !container || !scene) return undefined;
    const canvas = pixi.canvas;
    latencyProbe.sceneBuild('start');
    const heightOverlayColor = cssColorToNumber(
      getComputedStyle(container).backgroundColor,
      resolvedTheme === 'dark' ? 0x0a0a0a : 0xededed,
    );
    const terrainCacheKey = `${candidateCoversScene ? `candidate-view:${scene.width}x${scene.height}` : (map?.semanticHash ?? '')}:${map?.backend ?? 'synthetic'}:${map?.minimapPalette?.paletteHash ?? 'fallback'}:${terrainColorSources.identity}:${textureColorsShown ? `texture-colors:${textureColorsShown.key}` : 'minimap-colors'}:${overlays.connectionTerrain ? 'post-connections' : 'pre-connections'}:${elevationMode}:${heightOverlayColor}`;
    let terrainCache = terrainChunkCache.current;
    if (!terrainCache || terrainCache.key !== terrainCacheKey) {
      const replaced = terrainCache;
      terrainCache = createTerrainChunkCache(
        terrainCacheKey,
        scene,
        overlays.connectionTerrain ? scene.terrainIds : scene.preConnectionTerrainIds,
        map?.backend ?? 'synthetic',
        elevationMode,
        heightOverlayColor,
        map?.minimapPalette ?? null,
        terrainColorSources,
        textureColorsShown?.terrains,
      );
      if (replaced) {
        if (gameArtExpected) handOverGameArtPicture(replaced, terrainCache);
        destroyTerrainChunkCache(replaced);
      }
      terrainChunkCache.current = terrainCache;
    }
    const liveCandidate = candidateLayer.current;
    destroyStageChildren(
      pixi.stage
        .removeChildren()
        .filter((child) => child !== terrainCache.container && child !== liveCandidate?.container),
    );
    pixi.stage.addChild(terrainCache.container);
    const presentationCache = terrainCache;
    let layerRenderer = mapRenderer;
    if (layerRenderer === 'gpu' && gameArtExpected) {
      const reason = gpuProbe(pixi.renderer);
      if (reason) {
        layerRenderer = 'cpu';
        setGpuUnavailable((current) => current ?? reason);
      }
    }
    syncGameArtLayers(terrainCache, {
      expected: gameArtExpected,
      terrain: gameArtTerrainView,
      sprites: gameArtSpriteView,
      cliffBands: gameArtCliffBandView,
      store: gameArtStore,
      elevation: { backgroundColor: heightOverlayColor, elevationMode },
      teamColor: gameArtTeamColor,
      renderer: layerRenderer,
      onGpuUnavailable: (reason) => setGpuUnavailable((current) => current ?? reason),
      host: container,
      onPresented: () => {
        setGameArtPresentedKey(presentationCache.gameArtTerrain?.view.key ?? null);
        if (renderedMapLayer.current) renderedMapLayer.current.visible = true;
      },
    });
    setGameArtPresentedKey(
      terrainCache.gameArtTerrain?.layer.presented ? terrainCache.gameArtTerrain.view.key : null,
    );
    setGameArtKindVisibility(terrainCache, {
      objects: objectVisibility.objects,
      cliffs: overlays.cliffs,
    });
    syncTileGrid(terrainCache, previewTileGrid, tileGridColor(container), container);
    transformTerrainLayer(terrainCache.container, camera, scene, viewport);
    updateTerrainChunkVisibility(terrainCache, [camera], viewport, container);
    const mapLayer = new Container();
    pixi.stage.addChild(mapLayer);
    mapLayer.visible = terrainCache.gameArtPresentation.outgoing === null;
    renderedMapLayer.current = mapLayer;
    renderedCamera.current = camera;
    displayedCamera.current = camera;
    const connectionGeometry = connectionOverlayGeometry(
      scene,
      map,
      shownConnectionMode === 'paths' ? connectionRoutes : null,
    );
    drawConnectionOverlay(
      mapLayer,
      connectionGeometry,
      scene,
      shownConnectionMode,
      camera,
      viewport,
      container,
    );
    drawCliffs(
      mapLayer,
      scene,
      camera,
      viewport,
      overlays,
      {
        look: cliffLook,
        minimapPalette: map?.minimapPalette ?? null,
        textureCliffColors: textureColorsShown?.cliffs,
      },
      cliffPresentation(
        scene,
        gameArtTerrainView !== null && Boolean(terrainCache.gameArtTerrain?.layer.presented),
        terrainCache,
      ),
    );
    const drawnObjects = drawObjects(
      mapLayer,
      scene,
      camera,
      viewport,
      objectVisibility,
      map?.playerColorIds,
      map?.minimapPalette ?? null,
      Number.POSITIVE_INFINITY,
      terrainCache.gameArtTerrain?.layer.presented
        ? terrainCache.gameArtSprites?.layer.presentedObjects
        : undefined,
      markerObjectColors,
    );
    container.dataset.drawnObjectCount = String(drawnObjects.objects);
    container.dataset.drawnHelperCount = String(drawnObjects.helpers);
    container.dataset.objectMarkerRadiusRange = drawnObjects.radiusRange;
    const connectionHoverGraphics = new Graphics();
    mapLayer.addChild(connectionHoverGraphics);
    const connectionMode = shownConnectionMode === 'off' ? null : shownConnectionMode;
    const connectionInteractive = () =>
      connectionMode !== null && connectionFinal.current && !candidateCoversScene;
    const keptConnectionHover = connectionHover.current;
    if (
      !connectionMode ||
      !connectionInteractive() ||
      !keptConnectionHover ||
      connectionTargetPoints(
        connectionGeometry,
        connectionMode,
        keptConnectionHover,
        camera,
        viewport,
      ).length === 0
    ) {
      connectionHover.current = null;
    }
    const paintConnectionHover = () => {
      connectionHoverGraphics.clear();
      const target = connectionHover.current;
      container.dataset.connectionHover = connectionOverlayTargetKey(target);
      if (!target || !connectionMode) return;
      const points = connectionTargetPoints(
        connectionGeometry,
        connectionMode,
        target,
        camera,
        viewport,
      );
      const first = points[0];
      if (!first) return;
      const color =
        target.kind === 'failed'
          ? failedConnectionSearchColor
          : connectionMaterial(scene.connections[target.connectionIndex] ?? { kind: 'unknown' })
              .color;
      for (const [width, strokeColor, alpha] of [
        [connectionOverlayStroke.hoverHalo, 0xffffff, 0.6],
        [connectionOverlayStroke.hover, color, 1],
      ] as const) {
        if (points.length === 1) {
          connectionHoverGraphics
            .circle(first.x, first.y, width / 2)
            .fill({ color: strokeColor, alpha });
          continue;
        }
        connectionHoverGraphics.moveTo(first.x, first.y);
        for (const point of points.slice(1)) connectionHoverGraphics.lineTo(point.x, point.y);
        connectionHoverGraphics.stroke({
          color: strokeColor,
          width,
          alpha,
          cap: 'round',
          join: 'round',
        });
      }
    };
    paintConnectionHover();
    let connectionHoverFrame: number | null = null;
    let connectionHoverPoint: { x: number; y: number } | null = null;
    const connectionTargetAt = (point: { x: number; y: number }) =>
      connectionInteractive() && connectionMode
        ? hitTestConnectionOverlay(
            point,
            connectionGeometry,
            connectionMode,
            displayedCamera.current,
            viewport,
            connectionMode === 'paths' ? connectionRouteHitBounds : null,
          )
        : null;
    let connectionPress: {
      pointerId: number;
      target: ConnectionOverlayTarget;
      x: number;
      y: number;
      moved: boolean;
    } | null = null;
    if (liveCandidate) {
      pixi.stage.addChild(liveCandidate.container);
      liveCandidate.transform(camera, viewport, scene);
    }
    const nextSelectionOutline = new Graphics();
    const nextSourceHighlightOutline = new Graphics();
    const nextLegendHoverOutline = new Graphics();
    const outlineLayer = new Container();
    outlineLayer.addChild(nextSelectionOutline, nextSourceHighlightOutline, nextLegendHoverOutline);
    pixi.stage.addChild(outlineLayer);
    selectionOutline.current = nextSelectionOutline;
    sourceHighlightOutline.current = nextSourceHighlightOutline;
    legendHoverOutline.current = nextLegendHoverOutline;
    drawPreviewOutlines(
      nextSelectionOutline,
      nextSourceHighlightOutline,
      nextLegendHoverOutline,
      mapBoundary.current,
      scene,
      camera,
      viewport,
      gesture.current?.kind === 'selection' && !gesture.current.cancelled
        ? rectangularSelectionFromDrag(
            gesture.current.start,
            gesture.current.end,
            scene.width,
            scene.height,
          )
        : displaySelection,
      sourceHighlightTiles.current,
      legendHoverTileIndices.current,
    );
    latencyProbe.sceneBuild('end', pixi.ticker);
    const interaction = new Graphics()
      .rect(0, 0, viewport.width, viewport.height)
      .fill({ color: 0, alpha: 0.001 });
    interaction.eventMode = 'static';
    interaction.cursor = connectionHover.current ? 'pointer' : 'crosshair';
    interaction.hitArea = new Rectangle(0, 0, viewport.width, viewport.height);
    const setConnectionHover = (target: ConnectionOverlayTarget | null) => {
      if (sameConnectionOverlayTarget(target, connectionHover.current)) return;
      connectionHover.current = target;
      const cursor = target ? 'pointer' : 'crosshair';
      interaction.cursor = cursor;
      if (!gesture.current) canvas.style.cursor = cursor;
      paintConnectionHover();
    };
    const hoverConnectionAt = (point: { x: number; y: number } | null) => {
      connectionHoverPoint = point ? { x: point.x, y: point.y } : null;
      if (!point) {
        if (connectionHoverFrame !== null) window.cancelAnimationFrame(connectionHoverFrame);
        connectionHoverFrame = null;
        setConnectionHover(null);
        return;
      }
      if (!connectionInteractive() || connectionHoverFrame !== null) return;
      connectionHoverFrame = window.requestAnimationFrame(() => {
        connectionHoverFrame = null;
        setConnectionHover(connectionHoverPoint ? connectionTargetAt(connectionHoverPoint) : null);
      });
    };
    clearConnectionHover.current = () => hoverConnectionAt(null);
    const updatePointer = (point: { x: number; y: number }, pointerId: number) => {
      const currentGesture = gesture.current;
      const interactionCamera = currentGesture?.camera ?? displayedCamera.current;
      const mapPoint = screenToMap(point, scene.width, scene.height, interactionCamera, viewport);
      const nextHoveredCoordinate =
        mapPoint.x >= 0 && mapPoint.x < scene.width && mapPoint.y >= 0 && mapPoint.y < scene.height
          ? { x: Math.floor(mapPoint.x), y: Math.floor(mapPoint.y) }
          : null;
      setHoveredCoordinate((current) =>
        sameMapCoordinate(current, nextHoveredCoordinate) ? current : nextHoveredCoordinate,
      );
      if (!currentGesture || currentGesture.pointerId !== pointerId) return;
      if (
        connectionPress?.pointerId === pointerId &&
        Math.hypot(point.x - connectionPress.x, point.y - connectionPress.y) > 4
      ) {
        connectionPress.moved = true;
      }
      if (currentGesture.kind === 'selection') {
        if (currentGesture.cancelled) return;
        const end = clampedTileAtScreenPoint(scene, interactionCamera, viewport, point);
        currentGesture.end = end;
        const nextSelectionPreview = rectangularSelectionFromDrag(
          currentGesture.start,
          end,
          scene.width,
          scene.height,
        );
        setSelectionPreview((current) =>
          samePreviewSelection(current, nextSelectionPreview) ? current : nextSelectionPreview,
        );
        drawSelectionOutline(
          selectionOutline.current,
          scene,
          currentGesture.camera,
          viewport,
          nextSelectionPreview,
        );
        return;
      }
      const deltaX = point.x - currentGesture.x;
      const deltaY = point.y - currentGesture.y;
      currentGesture.x = point.x;
      currentGesture.y = point.y;
      currentGesture.camera = panPreviewCamera(
        currentGesture.camera,
        deltaX,
        deltaY,
        scene.width,
        scene.height,
        viewport,
      );
      displayedCamera.current = currentGesture.camera;
      transformTerrainLayer(terrainCache.container, currentGesture.camera, scene, viewport);
      updateTerrainChunkVisibility(terrainCache, [currentGesture.camera], viewport, container);
      candidateLayer.current?.transform(currentGesture.camera, viewport, scene);
      transformMapLayer(mapLayer, renderedCamera.current, currentGesture.camera, scene, viewport);
      drawPreviewOutlines(
        selectionOutline.current,
        sourceHighlightOutline.current,
        legendHoverOutline.current,
        mapBoundary.current,
        scene,
        currentGesture.camera,
        viewport,
        displaySelection,
        sourceHighlightTiles.current,
        legendHoverTileIndices.current,
      );
      setCameraDataset(container, scene, currentGesture.camera, viewport);
      container.dataset.outlineCameraZoom = currentGesture.camera.zoom.toFixed(4);
    };
    interaction.on('pointerdown', (event: FederatedPointerEvent) => {
      if (event.button !== 0 && event.button !== 2) return;
      event.preventDefault();
      canvas.focus();
      if (event.button === 0) {
        const interactionCamera = commitCameraTransition();
        const pressedConnection = connectionTargetAt(event.global);
        connectionPress = pressedConnection
          ? {
              pointerId: event.pointerId,
              target: pressedConnection,
              x: event.global.x,
              y: event.global.y,
              moved: false,
            }
          : null;
        const hit = hitTestTopDownScene(scene, interactionCamera, viewport, event.global);
        if (!hit) {
          setCamera(interactionCamera);
          selectionDimensions.current = null;
          setSelection(null);
          setSelectionPreview(null);
          return;
        }
        gesture.current = {
          kind: 'selection',
          pointerId: event.pointerId,
          start: hit,
          end: hit,
          startScreenX: event.global.x,
          startScreenY: event.global.y,
          camera: interactionCamera,
        };
        setSelectionPreview(rectangularSelectionFromDrag(hit, hit, scene.width, scene.height));
        drawSelectionOutline(
          selectionOutline.current,
          scene,
          interactionCamera,
          viewport,
          rectangularSelectionFromDrag(hit, hit, scene.width, scene.height),
        );
      } else {
        const interactionCamera = commitCameraTransition();
        cameraIsFitted.current = false;
        gesture.current = {
          kind: 'pan',
          pointerId: event.pointerId,
          x: event.global.x,
          y: event.global.y,
          camera: interactionCamera,
          startCamera: interactionCamera,
        };
        canvas.style.cursor = 'grabbing';
      }
      try {
        canvas.setPointerCapture(event.pointerId);
        container.dataset.pointerCapture = canvas.hasPointerCapture(event.pointerId)
          ? gesture.current.kind
          : 'failed';
      } catch {
        container.dataset.pointerCapture = 'failed';
      }
    });
    interaction.on('pointermove', (event: FederatedPointerEvent) => {
      if (gesture.current?.pointerId === event.pointerId) return;
      updatePointer(event.global, event.pointerId);
      hoverConnectionAt(event.global);
    });
    const finishPointer = (pointerId: number, commitSelection: boolean) => {
      const finishedGesture = gesture.current;
      if (finishedGesture?.pointerId !== pointerId) return;
      const press = connectionPress?.pointerId === pointerId ? connectionPress : null;
      connectionPress = null;
      const connectionClick =
        press !== null &&
        !press.moved &&
        commitSelection &&
        finishedGesture.kind === 'selection' &&
        !finishedGesture.cancelled;
      if (finishedGesture.kind === 'selection') {
        if (commitSelection && !finishedGesture.cancelled && !connectionClick) {
          displayedCamera.current = finishedGesture.camera;
          setCamera(finishedGesture.camera);
          selectionDimensions.current = `${scene.width}x${scene.height}`;
          setSelection(
            rectangularSelectionFromDrag(
              finishedGesture.start,
              finishedGesture.end,
              scene.width,
              scene.height,
            ),
          );
        } else {
          displayedCamera.current = finishedGesture.camera;
          setCamera(finishedGesture.camera);
          drawSelectionOutline(selectionOutline.current, scene, camera, viewport, displaySelection);
        }
        setSelectionPreview(null);
      } else if (commitSelection) {
        pendingCamera.current = null;
        displayedCamera.current = finishedGesture.camera;
        setCamera(finishedGesture.camera);
      } else {
        displayedCamera.current = finishedGesture.startCamera;
        setCamera(finishedGesture.startCamera);
        transformTerrainLayer(terrainCache.container, finishedGesture.startCamera, scene, viewport);
        updateTerrainChunkVisibility(
          terrainCache,
          [finishedGesture.startCamera],
          viewport,
          container,
        );
        candidateLayer.current?.transform(finishedGesture.startCamera, viewport, scene);
        transformMapLayer(
          mapLayer,
          renderedCamera.current,
          finishedGesture.startCamera,
          scene,
          viewport,
        );
        drawPreviewOutlines(
          selectionOutline.current,
          sourceHighlightOutline.current,
          legendHoverOutline.current,
          mapBoundary.current,
          scene,
          finishedGesture.startCamera,
          viewport,
          displaySelection,
          sourceHighlightTiles.current,
          legendHoverTileIndices.current,
        );
      }
      gesture.current = null;
      try {
        if (canvas.hasPointerCapture(pointerId)) {
          canvas.releasePointerCapture(pointerId);
        }
      } catch {}
      canvas.style.cursor = connectionHover.current ? 'pointer' : 'crosshair';
      delete container.dataset.pointerCapture;
      if (connectionClick && press) connectionActivation.current(press.target);
    };
    const releasePointer = (event: FederatedPointerEvent) => finishPointer(event.pointerId, true);
    const cancelPointer = (event: FederatedPointerEvent) => finishPointer(event.pointerId, false);
    const pointerOutsideHost = (event: PointerEvent) =>
      !rectContainsPoint(container.getBoundingClientRect(), event.clientX, event.clientY);
    const leaveHost = () => {
      if (!gesture.current) setHoveredCoordinate(null);
      hoverConnectionAt(null);
    };
    const releaseNativePointer = (event: PointerEvent) => {
      finishPointer(event.pointerId, true);
      if (!gesture.current && pointerOutsideHost(event)) setHoveredCoordinate(null);
    };
    const cancelNativePointer = (event: PointerEvent) => finishPointer(event.pointerId, false);
    const moveNativePointer = (event: PointerEvent) => {
      if (!gesture.current || gesture.current.pointerId !== event.pointerId) return;
      const bounds = canvas.getBoundingClientRect();
      updatePointer(
        { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
        event.pointerId,
      );
    };
    interaction.on('pointerup', releasePointer);
    interaction.on('pointerupoutside', releasePointer);
    interaction.on('pointercancel', cancelPointer);
    interaction.on('pointerout', () => {
      if (!gesture.current) setHoveredCoordinate(null);
      hoverConnectionAt(null);
    });
    const suppressContextMenu = (event: MouseEvent) => event.preventDefault();
    canvas.addEventListener('contextmenu', suppressContextMenu);
    canvas.addEventListener('lostpointercapture', cancelNativePointer);
    canvas.addEventListener('pointercancel', cancelNativePointer);
    canvas.addEventListener('pointerup', releaseNativePointer);
    container.addEventListener('pointerleave', leaveHost);
    window.addEventListener('pointermove', moveNativePointer, true);
    window.addEventListener('pointerup', releaseNativePointer, true);
    window.addEventListener('pointercancel', cancelNativePointer, true);
    pixi.stage.addChild(interaction);
    setCameraDataset(container, scene, camera, viewport);
    container.dataset.outlineCameraZoom = camera.zoom.toFixed(4);
    sceneBuilds.current += 1;
    container.dataset.sceneBuilds = String(sceneBuilds.current);
    const drawnViewport = viewport;
    const transformFrozenCanvas = (width: number, height: number) => {
      if (previewViewportIsCollapsed(drawnViewport)) return null;
      const shownViewport = { ...drawnViewport, width, height };
      const drawnCamera = displayedCamera.current;
      const shownCamera = cameraIsFitted.current
        ? fitPreviewCamera(scene.width, scene.height)
        : clampPreviewCamera(
            pendingCamera.current ?? drawnCamera,
            scene.width,
            scene.height,
            shownViewport,
          );
      return previewScreenTransform(
        scene.width,
        scene.height,
        drawnCamera,
        drawnViewport,
        shownCamera,
        shownViewport,
      );
    };
    frozenCanvasTransform.current = transformFrozenCanvas;
    refreshFrozenCanvas.current?.();
    if (displaySelection) {
      container.dataset.selectionOutlineStyle = 'perimeter';
      container.dataset.selectionRange = `${displaySelection.minimumX},${displaySelection.minimumY}:${displaySelection.maximumX},${displaySelection.maximumY}`;
    } else {
      delete container.dataset.selectionOutlineStyle;
      delete container.dataset.selectionRange;
    }
    return () => {
      interaction.removeAllListeners();
      if (connectionHoverFrame !== null) window.cancelAnimationFrame(connectionHoverFrame);
      clearConnectionHover.current = () => {};
      if (frozenCanvasTransform.current === transformFrozenCanvas) {
        frozenCanvasTransform.current = null;
      }
      if (renderedMapLayer.current === mapLayer) renderedMapLayer.current = null;
      if (selectionOutline.current === nextSelectionOutline) selectionOutline.current = null;
      if (sourceHighlightOutline.current === nextSourceHighlightOutline)
        sourceHighlightOutline.current = null;
      if (legendHoverOutline.current === nextLegendHoverOutline) legendHoverOutline.current = null;
      canvas.removeEventListener('contextmenu', suppressContextMenu);
      canvas.removeEventListener('lostpointercapture', cancelNativePointer);
      canvas.removeEventListener('pointercancel', cancelNativePointer);
      canvas.removeEventListener('pointerup', releaseNativePointer);
      container.removeEventListener('pointerleave', leaveHost);
      window.removeEventListener('pointermove', moveNativePointer, true);
      window.removeEventListener('pointerup', releaseNativePointer, true);
      window.removeEventListener('pointercancel', cancelNativePointer, true);
    };
  }, [
    camera,
    candidateCoversScene,
    commitCameraTransition,
    displaySelection,
    elevationMode,
    gameArtCliffBandView,
    gameArtExpected,
    gameArtPresentedKey,
    gameArtSpriteView,
    gameArtStore,
    gameArtTeamColor,
    gameArtTerrainView,
    map?.semanticHash,
    mapRenderer,
    objectVisibility,
    overlays,
    connectionRouteHitBounds,
    connectionRoutes,
    shownConnectionMode,
    pixiReady,
    previewTileGrid,
    resolvedTheme,
    viewScene,
    selection,
    terrainColorSources,
    textureColorsShown,
    markerObjectColors,
    viewport,
  ]);
  const bindBoundaryOutline = useCallback((element: SVGPolygonElement | null) => {
    mapBoundary.current.outline = element;
    if (element) {
      mapBoundary.current.strokeWidth =
        Number.parseFloat(getComputedStyle(element).strokeWidth) || 4;
    }
  }, []);
  const bindBoundaryArc = useCallback((element: SVGSVGElement | null) => {
    mapBoundary.current.arc = element;
  }, []);
  const bindBoundaryBorder = useCallback((element: SVGPathElement | null) => {
    mapBoundary.current.border = element;
  }, []);
  const bindBoundaryFrame = useCallback((element: SVGPathElement | null) => {
    mapBoundary.current.frame = element;
  }, []);
  useLayoutEffect(() => {
    if (!viewScene) return;
    drawMapBoundaryOutline(mapBoundary.current, viewScene, displayedCamera.current, viewport);
  }, [camera, viewScene, viewport]);

  useEffect(() => {
    if (!viewScene) return;
    drawLegendHover(
      sourceHighlightOutline.current,
      viewScene,
      displayedCamera.current,
      viewport,
      sourceHighlightTileIndices,
    );
  }, [viewScene, sourceHighlightTileIndices, viewport]);

  const candidatePresentation = useRef<CandidatePresentation | null>(null);
  const heightOverlayColor = useMemo(
    () =>
      host.current
        ? cssColorToNumber(
            getComputedStyle(host.current).backgroundColor,
            resolvedTheme === 'dark' ? 0x0a0a0a : 0xededed,
          )
        : resolvedTheme === 'dark'
          ? 0x0a0a0a
          : 0xededed,
    [resolvedTheme, pixiReady],
  );
  const candidatePalette =
    generationActivity !== null
      ? generationActivity.minimapPalette
      : (presentedMap?.minimapPalette ?? null);
  const candidateTerrainSources = useMemo(
    () =>
      presentTerrainColorSources(map?.terrainNames ?? [], localNames, map?.constantNames?.terrains),
    [localNames, map?.constantNames?.terrains, map?.terrainNames],
  );
  const candidateTerrainIdentity = terrainColorSourcesIdentity(candidateTerrainSources);
  const candidateTexturePalette =
    generationActivity !== null
      ? (generationActivity.texturePalette ?? null)
      : (presentedMap?.texturePalette ?? null);
  const candidateLookColors =
    flatLook === 'texture-colors' && candidateTexturePalette
      ? textureLookColors(candidateTexturePalette)
      : undefined;
  const candidateLookTerrainColors = candidateLookColors?.terrains;
  const candidateLookObjectColors = lookMarkerObjectColors(flatLook, candidateTexturePalette);
  candidatePresentation.current = {
    elevationMode,
    heightOverlayColor,
    minimapPalette: candidatePalette,
    terrainNames: candidateTerrainSources.terrainNames,
    localTerrainColors: candidateTerrainSources.localTerrainColors,
    lookTerrainColors: candidateLookTerrainColors,
    lookObjectColors: candidateLookObjectColors,
    lookCliffColors: candidateLookColors?.cliffs,
    playerColorIds: presentedMap?.playerColorIds ?? [],
    visibility: objectVisibility,
    cliffs: overlays.cliffs,
    markerComponent: viewScene
      ? previewScale(viewScene.width, viewScene.height, camera, viewport) * Math.SQRT1_2
      : 1,
  };

  useEffect(() => {
    const pixi = application.current;
    const container = host.current;
    if (!pixiReady || !pixi || !container || !candidateActive) return undefined;
    const layer = new PreviewCandidateLayer(previewCandidates);
    candidateLayer.current = layer;
    const outline = selectionOutline.current?.parent;
    const outlineIndex = outline ? pixi.stage.getChildIndex(outline) : -1;
    if (outlineIndex >= 0) pixi.stage.addChildAt(layer.container, outlineIndex);
    else pixi.stage.addChild(layer.container);
    const record = () => {
      const view = previewCandidates.view;
      container.dataset.candidateChunks = String(layer.chunkCount);
      container.dataset.candidateRebuiltChunks = String(layer.rebuiltChunks);
      container.dataset.candidateDrawMs = layer.lastUpdateMilliseconds.toFixed(2);
      if (view) latencyProbe.candidateDrawn(view.requestId, layer.lastUpdateMilliseconds);
      container.dataset.candidateRevision = String(view?.revision ?? '');
      container.dataset.candidateStage = view?.stage ?? '';
      container.dataset.candidateUpdates = String(
        Number(container.dataset.candidateUpdates ?? 0) + 1,
      );
    };
    container.dataset.candidateUpdates = '0';
    layer.rebuildAll(candidatePresentation.current!);
    layer.transform(displayedCamera.current, viewportRef.current, {
      width: previewCandidates.view?.width ?? 1,
      height: previewCandidates.view?.height ?? 1,
    });
    record();
    const unsubscribe = previewCandidates.subscribe((_view, change) => {
      if (!change?.accepted) return;
      layer.update(change, candidatePresentation.current!);
      record();
    });
    return () => {
      unsubscribe();
      if (candidateLayer.current === layer) candidateLayer.current = null;
      layer.destroy();
      for (const key of [
        'candidateChunks',
        'candidateRebuiltChunks',
        'candidateDrawMs',
        'candidateRevision',
        'candidateStage',
        'candidateUpdates',
      ]) {
        delete container.dataset[key];
      }
    };
  }, [candidateActive, pixiReady, previewCandidates]);

  useEffect(() => {
    const layer = candidateLayer.current;
    if (layer) layer.container.visible = !gameArtExpected;
  }, [candidateActive, gameArtExpected, pixiReady]);

  useEffect(() => {
    candidateLayer.current?.rebuildAll(candidatePresentation.current!);
  }, [
    candidatePalette?.paletteHash,
    candidateTerrainIdentity,
    candidateLookTerrainColors,
    candidateLookObjectColors,
    elevationMode,
    heightOverlayColor,
    objectVisibility,
    overlays.cliffs,
    presentedMap?.playerColorIds,
  ]);

  useEffect(() => {
    const layer = candidateLayer.current;
    if (!viewScene || !layer) return;
    layer.transform(displayedCamera.current, viewport, viewScene);
    const component = candidatePresentation.current!.markerComponent;
    if (Math.abs(component / Math.max(layer.vectorComponent, 0.000_001) - 1) > 0.2) {
      layer.refreshVectors(candidatePresentation.current!);
    }
  }, [camera, candidateActive, viewScene, viewport]);

  const candidateSelection = candidateActive && displaySelection ? displaySelection : null;
  const [provisionalEntries, setProvisionalEntries] = useState<
    ReturnType<ProvisionalLegendCounts['entries']>
  >([]);
  useEffect(() => {
    if (!candidateSelection) {
      setProvisionalEntries([]);
      return undefined;
    }
    const counts = new ProvisionalLegendCounts(candidateSelection);
    const grid = previewCandidates.chunkGrid();
    if (grid) {
      counts.update(
        previewCandidates,
        Array.from({ length: grid.columns * grid.rows }, (_, index) => index),
        true,
      );
    }
    setProvisionalEntries(counts.entries());
    return previewCandidates.subscribe((_view, change) => {
      if (!change?.accepted) return;
      counts.update(previewCandidates, change.changedChunks, change.reset);
      const container = host.current;
      if (container) container.dataset.provisionalExaminedTiles = String(counts.lastExaminedTiles);
      setProvisionalEntries(counts.entries());
    });
  }, [
    previewCandidates,
    candidateSelection?.minimumX,
    candidateSelection?.minimumY,
    candidateSelection?.maximumX,
    candidateSelection?.maximumY,
  ]);

  const onPreviewKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const input = keyboardInput.current;
    if (!input.scene) return;
    const target = event.target as Element;
    const onCanvas = target === application.current?.canvas;
    const onToolbar = !onCanvas && target.closest('.preview-map-toolbar') !== null;
    if (!onCanvas && !onToolbar) return;
    const command = previewKeyboardCommand(event);
    if (!command) return;
    if (onToolbar && (command.kind === 'move' || command.kind === 'pan')) return;
    if (onToolbar && command.kind === 'select-all') return;
    event.preventDefault();
    const scene = input.scene;
    const dimensions = `${scene.width}x${scene.height}`;
    switch (command.kind) {
      case 'select-all': {
        const all = {
          minimumX: 0,
          maximumX: scene.width - 1,
          minimumY: 0,
          maximumY: scene.height - 1,
        };
        setSelectionPreview(null);
        selectionDimensions.current = dimensions;
        keyboardCursor.current = null;
        setSelection(all);
        return;
      }
      case 'clear':
        if (gesture.current?.kind === 'selection') gesture.current.cancelled = true;
        selectionDimensions.current = null;
        keyboardCursor.current = null;
        setSelection(null);
        setSelectionPreview(null);
        return;
      case 'fit':
        input.fit();
        return;
      case 'zoom':
        input.zoom(command.factor);
        return;
      case 'pan':
        input.pan(command);
        return;
      case 'move': {
        const current = input.selection;
        const previous = keyboardCursor.current;
        const state =
          previous && current && previous.selection === current
            ? previous.state
            : keyboardCursorFor(current, scene.width, scene.height);
        const moved = moveKeyboardSelection(
          state,
          current !== null,
          command,
          scene.width,
          scene.height,
        );
        keyboardCursor.current = { selection: moved.selection, state: moved.state };
        selectionDimensions.current = dimensions;
        setSelectionPreview(null);
        setSelection(moved.selection);
        input.reveal(moved.state.cursor);
        return;
      }
    }
  }, []);

  const onToolbarKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const tools = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])'),
    );
    const target = rovingKeyTarget(
      event.key,
      tools.indexOf(event.target as HTMLButtonElement),
      tools.length,
    );
    if (target === null) return;
    event.preventDefault();
    event.stopPropagation();
    tools[target]?.focus();
  }, []);

  const onWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (!viewScene || event.target !== application.current?.canvas) return;
      event.preventDefault();
      const bounds = event.currentTarget.getBoundingClientRect();
      zoom(event.deltaY < 0 ? 1.2 : 1 / 1.2, {
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      });
    },
    [viewScene, zoom],
  );

  const mapBounds = viewScene ? mapScreenBounds(viewScene, camera, viewport) : null;
  const selectionLayers = useMemo(
    () =>
      legendMap && scene && selection
        ? aggregateSelectionLayers(
            legendMap,
            scene,
            selection,
            objectVisibility,
            shownConnectionMode === 'paths' ? connectionRoutes : null,
          )
        : [],
    [connectionRoutes, legendMap, objectVisibility, scene, selection, shownConnectionMode],
  );
  const sourceHighlightLayers = useMemo(() => {
    if (!legendMap || !scene || sourceHighlightTileIndices.length === 0) return null;
    const layers = aggregateTileIndexLayers(
      legendMap,
      scene,
      sourceHighlightTileIndices,
      objectVisibility,
      new Set(highlightedPreviewOperationIndices),
    );
    return layers.length > 0 ? layers : null;
  }, [
    highlightedPreviewOperationIndices,
    legendMap,
    objectVisibility,
    scene,
    sourceHighlightTileIndices,
  ]);
  const candidateLegendLayers = useMemo(
    () =>
      candidateSelection
        ? provisionalLegendLayers(provisionalEntries, presentedMap, objectVisibility, {
            minimapPalette: candidatePalette,
            ...candidateTerrainSources,
          })
        : null,
    [
      candidatePalette,
      candidateSelection,
      candidateTerrainSources,
      objectVisibility,
      presentedMap,
      provisionalEntries,
    ],
  );
  const legendContent = previewLegendContent({
    generationActive,
    candidateActive,
    selection: candidateActive ? candidateSelection !== null : selection !== null,
    sourceHighlight: sourceHighlightLayers !== null,
  });
  const legendLayers =
    legendContent === 'provisional'
      ? candidateLegendLayers
      : legendContent === 'source-highlight'
        ? sourceHighlightLayers
        : legendContent === 'selection'
          ? selectionLayers
          : null;
  const hasLandConnections = scene
    ? hasLandConnection(scene) || (connectionRoutes?.totalAttempts ?? 0) > 0
    : false;
  const readoutSelection = selectionPreview ?? (candidateActive ? displaySelection : selection);
  const informationPresent = Boolean(legendLayers || readoutSelection || hoveredCoordinate);
  const information = usePresence(informationPresent);
  const informationWasMounted = useRef(false);
  const legendWasMounted = useRef(false);
  const legendPresence = usePresence(
    legendLayers !== null || (information.closing && legendWasMounted.current),
  );
  const holdLegend = legendPresence.closing || information.closing;
  const selectionLabelWasMounted = useRef(false);
  const cursorLabelWasMounted = useRef(false);
  const selectionLabel = usePresence(
    readoutSelection !== null || (information.closing && selectionLabelWasMounted.current),
  );
  const cursorLabel = usePresence(
    hoveredCoordinate !== null || (information.closing && cursorLabelWasMounted.current),
  );
  const shownReadoutSelection = useHeld(
    readoutSelection,
    selectionLabel.closing || information.closing,
  );
  const shownHoveredCoordinate = useHeld(
    hoveredCoordinate,
    cursorLabel.closing || information.closing,
  );
  const shownLegendLayers = useHeld(legendLayers, holdLegend);
  const shownLegendContent = useHeld(legendContent ?? 'selection', holdLegend);
  const legendShown = legendPresence.mounted && shownLegendLayers !== null;
  const legendEntersAlone = informationWasMounted.current;
  const [legendFilter, setLegendFilter] = useState('');
  const legendWidths = usePreviewLegendWidth(presentedMap?.objectNames, presentedMap?.terrainNames);
  const legendWidth = legendWidths?.panel ?? null;
  const readoutStacked =
    legendWidths !== null && previewReadoutStacked(legendWidths.readout, viewport.width);
  const [bindMapToolbar, keyboardCueRise] = useKeyboardCueRise();
  useEffect(() => {
    informationWasMounted.current = information.mounted;
    legendWasMounted.current = legendPresence.mounted;
    selectionLabelWasMounted.current = selectionLabel.mounted;
    cursorLabelWasMounted.current = cursorLabel.mounted;
  });
  const activateSelectionLayer = useCallback(
    (layer: AggregatedSelectionLayer) => {
      if (!map || candidateActiveRef.current) return;
      const activation = resolveAggregatedLayerActivation(map, layer);
      if (activation.ambiguityMessage) {
        appendOutput(
          outputNote('Preview', 'preview.selection-ambiguity', activation.ambiguityMessage),
        );
      }
      if (activation.operationIndex !== null) selectPreviewOperation(activation.operationIndex);
    },
    [appendOutput, map, selectPreviewOperation],
  );
  const hoverSelectionLayer = useCallback(
    (layer: AggregatedSelectionLayer | null) => {
      const indices = layer
        ? [...new Set(layer.instances.map((instance) => instance.tileIndex))]
        : [];
      legendHoverTileIndices.current = indices;
      if (viewScene) {
        drawLegendHover(
          legendHoverOutline.current,
          viewScene,
          displayedCamera.current,
          viewport,
          indices,
        );
      }
      const container = host.current;
      if (container) container.dataset.legendHoverCount = String(indices.length);
    },
    [viewScene, viewport],
  );
  const announcedLayers =
    legendContent === 'selection' || legendContent === 'provisional' ? legendLayers : null;
  const announcedLayerSummary = useRef<{ description: string; count: number }[] | null>(null);
  announcedLayerSummary.current = useMemo(() => {
    if (!announcedLayers) return null;
    const labels = previewLegendLabels(announcedLayers);
    return announcedLayers.map((layer) => ({
      count: layer.count,
      description: labels.get(layer.key)?.description ?? layer.key,
    }));
  }, [announcedLayers]);
  const [announcement, setAnnouncement] = useState({ sequence: 0, text: '' });
  const announce = useCallback(
    (text: string) => setAnnouncement((current) => ({ sequence: current.sequence + 1, text })),
    [],
  );
  const announcedSelection = useRef<PreviewSelection | null>(null);
  useEffect(() => {
    if (selection === announcedSelection.current) return undefined;
    const timer = window.setTimeout(() => {
      announcedSelection.current = selection;
      announce(describePreviewSelection(selection, announcedLayerSummary.current));
    }, 200);
    return () => window.clearTimeout(timer);
  }, [announce, selection]);
  const committedMapHash = map?.semanticHash ?? null;
  const announcedMapHash = useRef(committedMapHash);
  useEffect(() => {
    if (committedMapHash === announcedMapHash.current) return;
    const first = announcedMapHash.current === null;
    announcedMapHash.current = committedMapHash;
    if (committedMapHash) {
      announce(
        first
          ? translate('preview-panel.announce.ready')
          : translate('preview-panel.announce.updated'),
      );
    }
  }, [announce, committedMapHash]);
  const narrowPreview = viewScene !== null && pixiReady && viewport.width < narrowPreviewWidth;
  const blurOutdatedMap =
    (generationActivity !== null &&
      generationActivity.kind === 'preview' &&
      (gameArtExpected || (!generationActivity.progressive && !candidateActive))) ||
    lookPending;
  return (
    <section
      aria-label={t('preview-panel.panel.label')}
      className="panel preview-panel"
      data-narrow={narrowPreview || undefined}
    >
      <RunConfigurationPanel
        presetControlHost={presetControlHost}
        versionControlHost={outputVersionHost}
      />
      {outputVersionHost
        ? createPortal(<GameArtConversionProgress status={gameArt.status} />, outputVersionHost)
        : null}
      <div className="preview-preset-control-host" ref={setPresetControlHost} />
      <p className="sr-only" id={keyboardHelpId}>
        {previewKeyboardHelp()}
      </p>
      <div
        aria-atomic="false"
        aria-live="polite"
        className="sr-only"
        data-testid="preview-announcer"
      >
        {announcement.text ? <span key={announcement.sequence}>{announcement.text}</span> : null}
      </div>
      <div
        className="preview-canvas"
        dir="ltr"
        data-candidate-active={candidateActive}
        data-candidate-palette-hash={candidateActive ? (candidatePalette?.paletteHash ?? '') : ''}
        data-candidate-request={candidateView?.requestId ?? ''}
        data-generation-active={generationActive}
        data-outdated-map={outdatedMapShown && Boolean(map)}
        data-candidate-map-hash={map?.semanticHash ?? ''}
        data-connection-terrain={overlays.connectionTerrain}
        data-connection-overlay={shownConnectionMode}
        data-connection-paths={connectionPaths}
        data-connection-routes={map?.connectionRoutes?.state ?? 'absent'}
        data-connection-route-count={connectionRoutes?.count ?? ''}
        data-connection-route-total={connectionRoutes?.totalAttempts ?? ''}
        data-elevation-mode={elevationMode}
        data-fade-bottom={Boolean(mapBounds && mapBounds.bottom > viewport.height)}
        data-fade-left={Boolean(mapBounds && mapBounds.left < 0)}
        data-fade-right={Boolean(mapBounds && mapBounds.right > viewport.width)}
        data-fade-top={Boolean(mapBounds && mapBounds.top < 0)}
        data-legend-hover-color="white"
        data-legend-hover-opacity="0.6"
        data-legend-hover-style="fill"
        data-map-height={scene?.height ?? ''}
        data-map-projection={projectionMode}
        data-map-perspective={previewPerspective}
        data-map-look={previewLook}
        data-map-test-preview={mapTestPreviewShown}
        data-game-art-state={gameArt.status.state}
        data-map-renderer={mapRenderer}
        data-game-art-active={gameArt.active}
        data-game-art-pending={gameArtPending}
        data-texture-colors-active={textureColorsShown !== null}
        data-minimap-palette-hash={map?.minimapPalette?.paletteHash ?? ''}
        data-minimap-palette-selection={map?.minimapPalette?.selection ?? 'fallback'}
        data-minimap-palette-version={map?.minimapPalette?.productVersion ?? ''}
        data-map-width={scene?.width ?? ''}
        data-selection-outline-color="white"
        data-source-highlight-color="white"
        data-source-highlight-count={sourceHighlightTileIndices.length}
        data-source-highlight-opacity="0.6"
        data-source-highlight-style="fill"
        data-stable-map-hash={map?.semanticHash ?? ''}
        onKeyDown={onPreviewKeyDown}
        onWheel={onWheel}
        ref={host}
      >
        {!map && !candidateActive && (
          <>
            <img
              alt=""
              aria-hidden="true"
              className="preview-empty-branding"
              data-testid="preview-empty-branding"
              draggable={false}
              src={appIconUrl}
            />
            <DevelopmentFixtureMenu execution={previewExecution} mapActive={false} />
          </>
        )}
        {viewScene && (
          <>
            <svg
              aria-hidden="true"
              className="preview-map-boundary"
              data-generating={generationActive}
              data-testid="preview-map-boundary"
            >
              <polygon ref={bindBoundaryOutline} />
            </svg>
            <svg
              aria-hidden="true"
              className="preview-map-boundary-arc"
              data-boundary-motion={boundaryMotion}
              data-testid="preview-map-boundary-arc"
              ref={bindBoundaryArc}
            >
              <path className="preview-map-boundary-border" ref={bindBoundaryBorder} />
              <path className="preview-map-boundary-frame" ref={bindBoundaryFrame} />
            </svg>
            <div
              aria-label={t('preview-panel.toolbar.label')}
              className="preview-map-toolbar"
              onKeyDown={onToolbarKeyDown}
              ref={bindMapToolbar}
              role="toolbar"
            >
              <PreviewProjectionModeButton
                mode={projectionMode}
                onCycle={() =>
                  setPreviewPerspective(
                    projectionPerspective(nextPreviewProjection(projectionMode)),
                  )
                }
              />
              <PreviewLookButton
                look={shownLook}
                lockedReason={mapTestPreviewShown ? mapTestPreviewNotes.look : null}
                pending={lookPending}
                onCycle={() => {
                  const next = nextPreviewLook(shownLook, gameArt.offered);
                  setPreviewLook(next);
                  if (next !== 'game-textures' && gameArt.status.state === 'preparing') {
                    void window.rmside.cancelGameArt().catch(() => undefined);
                  }
                }}
              />
              <PreviewOverlayButton
                active={previewTileGrid}
                className="preview-tile-grid-button"
                label={t(tileGridButton.labelId)}
                onToggle={() => setPreviewTileGrid(!previewTileGrid)}
                renderIcon={tileGridButton.renderIcon}
              />
              {overlayButtons.slice(0, 2).map(({ key, labelId, renderIcon }) => (
                <PreviewOverlayButton
                  active={overlays[key]}
                  key={key}
                  label={t(labelId)}
                  onToggle={() => setOverlays((current) => ({ ...current, [key]: !current[key] }))}
                  renderIcon={renderIcon}
                />
              ))}
              {hasLandConnections ? (
                <div
                  aria-label={t('preview-panel.toolbar.connections')}
                  className="preview-map-tool-group"
                  role="group"
                >
                  {overlayButtons.slice(2).map(({ key, labelId, renderIcon }) => (
                    <PreviewOverlayButton
                      active={overlays[key]}
                      key={key}
                      label={t(labelId)}
                      onToggle={() =>
                        setOverlays((current) => ({ ...current, [key]: !current[key] }))
                      }
                      renderIcon={renderIcon}
                    />
                  ))}
                  <PreviewConnectionOverlayButton
                    label={connectionPresentation.label}
                    mode={shownConnectionMode}
                    note={connectionPresentation.note}
                    onCycle={() =>
                      setOverlays((current) => ({
                        ...current,
                        connections: nextConnectionOverlayMode(
                          shownConnectionOverlayMode(current.connections, connectionPaths),
                          connectionPaths,
                        ),
                      }))
                    }
                  />
                </div>
              ) : null}
              <PreviewElevationModeButton
                mode={elevationMode}
                onCycle={() => setElevationMode(nextElevationDisplayMode(elevationMode))}
              />
              <span aria-hidden="true" className="preview-keyboard-focus-cue">
                <Keyboard aria-hidden="true" />
                <span>{t('preview-panel.toolbar.keyboard-cue')}</span>
              </span>
            </div>
            {map ? <DevelopmentFixtureMenu execution={previewExecution} mapActive /> : null}
            {information.mounted ? (
              <div
                className="preview-map-information motion-surface motion-edge"
                data-has-legend={legendShown}
                data-motion-from="left"
                data-readout-stacked={readoutStacked || undefined}
                ref={information.ref}
                style={
                  legendWidth === null
                    ? undefined
                    : ({ '--preview-legend-width': `${legendWidth}px` } as React.CSSProperties)
                }
                {...presenceProps(information.closing)}
              >
                {(selectionLabel.mounted && shownReadoutSelection) ||
                (cursorLabel.mounted && shownHoveredCoordinate) ? (
                  <div className="preview-map-readout">
                    {selectionLabel.mounted && shownReadoutSelection ? (
                      <span
                        className="preview-map-readout-segment motion-surface"
                        data-kind="selection"
                        data-motion-enter={legendEntersAlone ? undefined : 'false'}
                        data-motion-from="left"
                        ref={selectionLabel.ref}
                        {...presenceProps(selectionLabel.closing && !information.closing)}
                      >
                        <Scan aria-hidden="true" />
                        <span>{`(${shownReadoutSelection.minimumX}, ${shownReadoutSelection.minimumY})–(${shownReadoutSelection.maximumX}, ${shownReadoutSelection.maximumY})`}</span>
                      </span>
                    ) : null}
                    {cursorLabel.mounted && shownHoveredCoordinate ? (
                      <span
                        className="preview-map-readout-segment motion-surface"
                        data-kind="cursor"
                        data-motion-enter={legendEntersAlone ? undefined : 'false'}
                        data-motion-from="left"
                        ref={cursorLabel.ref}
                        {...presenceProps(cursorLabel.closing && !information.closing)}
                      >
                        <MousePointer2 aria-hidden="true" />
                        <span>
                          {t('preview-panel.readout.cursor', {
                            x: shownHoveredCoordinate.x,
                            y: shownHoveredCoordinate.y,
                          })}
                        </span>
                      </span>
                    ) : null}
                  </div>
                ) : null}
                {legendShown && shownLegendLayers ? (
                  <SelectionLayerLegend
                    closing={legendPresence.closing}
                    content={shownLegendContent}
                    entersAlone={legendEntersAlone}
                    filter={legendFilter}
                    layers={shownLegendLayers}
                    maxHeight={previewLegendMaxHeight(viewport.height, {
                      narrow: narrowPreview,
                      readoutStacked,
                      keyboardCueRise,
                    })}
                    readOnly={shownLegendContent === 'provisional'}
                    onActivate={activateSelectionLayer}
                    onFilterChange={setLegendFilter}
                    onHover={hoverSelectionLayer}
                    onToggleHelpers={() =>
                      setOverlays((current) => ({ ...current, helpers: !current.helpers }))
                    }
                    resolvedTheme={resolvedTheme}
                    showHelpers={overlays.helpers}
                    surfaceRef={legendPresence.ref}
                  />
                ) : null}
              </div>
            ) : null}
            {candidateView ? (
              <span
                className="sr-only"
                data-stage={candidateView.stage}
                data-testid="preview-candidate-stage"
              >
                {previewCandidateStageLabel(candidateView)}
              </span>
            ) : null}
            {blurOutdatedMap ? (
              <div
                aria-hidden="true"
                className="preview-generation-blur"
                data-testid="preview-generation-blur"
              />
            ) : null}
            {previewExecution?.status ? (
              <div
                aria-label={t('preview-panel.status.label')}
                aria-live="off"
                className="sr-only"
                data-phase={previewExecution.status.phase}
                data-request-id={previewExecution.status.requestId}
                role="status"
              >
                <span>{previewStatusLabel(previewExecution.status.phase)}</span>
                {previewExecution.status.uncertified ? (
                  <span>{t('preview-panel.status.uncertified')}</span>
                ) : null}
                {previewExecution.status.certification ? (
                  <span data-testid="preview-status-certification">
                    {previewExecution.status.certification}
                  </span>
                ) : null}
                <span>
                  {t('preview-panel.status.seed', { seed: previewExecution.status.seed })}
                </span>
                <span>{previewExecution.status.profileId}</span>
                <span>{previewExecution.status.settings}</span>
                <span>
                  {t('preview-panel.status.revision', {
                    revision: previewExecution.status.documentRevision,
                  })}
                </span>
                {previewExecution.status.generationEvent ? (
                  <span data-testid="generation-progress">
                    {t('preview-panel.status.generation-progress', {
                      stage:
                        previewExecution.status.generationEvent.stage ||
                        t('preview-panel.status.generation'),
                      kind: previewExecution.status.generationEvent.kind,
                      completed: previewExecution.status.generationEvent.completed,
                      total: previewExecution.status.generationEvent.total,
                    })}
                  </span>
                ) : null}
                {previewExecution.status.generationMs === undefined ? null : (
                  <span>
                    {t('preview-panel.status.generation-time', {
                      milliseconds: Math.round(previewExecution.status.generationMs),
                    })}
                  </span>
                )}
                <span>
                  {t('preview-panel.status.cache', {
                    entries: previewExecution.cacheDiagnostics.entries,
                    hits: previewExecution.cacheDiagnostics.hits,
                  })}
                </span>
              </div>
            ) : null}
            {(['top', 'right', 'bottom', 'left'] as const).map((edge) => (
              <div aria-hidden="true" className="preview-edge-fade" data-edge={edge} key={edge} />
            ))}
          </>
        )}
      </div>
      <ExecutionProfiler
        expanded={previewExpanded}
        navbarHost={outputProfilerHost}
        onExpandPreview={expandPreview}
        onOpenChange={setProfilerOpen}
        open={profilerOpen}
        store={executionProfiler}
      />
    </section>
  );
}

function SelectionLayerLegend({
  closing,
  content,
  entersAlone,
  filter,
  layers,
  maxHeight,
  readOnly = false,
  onActivate,
  onFilterChange: setFilter,
  onHover,
  onToggleHelpers,
  resolvedTheme,
  showHelpers,
  surfaceRef,
}: {
  closing: boolean;
  content: 'selection' | 'source-highlight' | 'provisional';
  readOnly?: boolean;
  entersAlone: boolean;
  filter: string;
  layers: AggregatedSelectionLayer[];
  maxHeight: number;
  onActivate(layer: AggregatedSelectionLayer): void;
  onFilterChange(filter: string): void;
  onHover(layer: AggregatedSelectionLayer | null): void;
  onToggleHelpers(): void;
  resolvedTheme: 'light' | 'dark';
  showHelpers: boolean;
  surfaceRef(element: HTMLElement | null): void;
}) {
  const { t } = useI18n();
  const { helperCount, helperLayers, mainLayers } = partitionHelperLayers(layers);
  const allListedLayers = showHelpers ? [...mainLayers, ...helperLayers] : mainLayers;
  const labels = previewLegendLabels(allListedLayers);
  const listedLayers = filter.trim()
    ? allListedLayers.filter((layer) => previewLegendFilterMatches(labels.get(layer.key)!, filter))
    : allListedLayers;
  const [pointerLayerKey, setPointerLayerKey] = useState<string | null>(null);
  const [focusedLayerKey, setFocusedLayerKey] = useState<string | null>(null);
  const [listedContent, setListedContent] = useState(content);
  if (listedContent !== content) {
    setListedContent(content);
    setPointerLayerKey(null);
    setFocusedLayerKey(null);
  }
  const highlightedLayerKey = closing ? null : legendHighlightKey(pointerLayerKey, focusedLayerKey);
  const highlightedLayer =
    highlightedLayerKey === null
      ? null
      : (listedLayers.find((layer) => layer.key === highlightedLayerKey) ?? null);
  useEffect(() => {
    onHover(highlightedLayer);
  }, [highlightedLayer, onHover]);
  const rows = useRef<HTMLDivElement>(null);
  const scrollShell = useRef<HTMLDivElement>(null);
  const ghosts = useRef<HTMLDivElement>(null);
  const [listMotion] = useState(
    () =>
      new ListMotion({
        ghostClassName: 'preview-legend-ghost',
        keyAttribute: 'layerKey',
        rowSelector: ':scope > .preview-layer-row',
        valueSelector: '.preview-layer-count',
      }),
  );
  const [fades, setFades] = useState({ top: false, bottom: false });
  const updateFades = useCallback(() => {
    const viewport = rows.current;
    if (!viewport) return;
    const hasOverflow = viewport.scrollHeight > viewport.clientHeight + 1;
    if (!hasOverflow && viewport.scrollTop !== 0) viewport.scrollTop = 0;
    const next = {
      top: hasOverflow && viewport.scrollTop > 1,
      bottom: hasOverflow && viewport.scrollTop + viewport.clientHeight < viewport.scrollHeight - 1,
    };
    setFades((current) =>
      current.top === next.top && current.bottom === next.bottom ? current : next,
    );
  }, []);
  const contentIdentity = `${showHelpers}|${listedLayers
    .map((layer) => `${layer.key}:${layer.count}`)
    .join('|')}`;
  const motionContent = useRef(content);
  useLayoutEffect(() => {
    const shell = scrollShell.current;
    const viewport = rows.current;
    const ghostLayer = ghosts.current;
    if (!shell || !viewport || !ghostLayer) return;
    if (motionContent.current !== content) {
      motionContent.current = content;
      viewport.scrollTop = 0;
    }
    listMotion.update({ ghosts: ghostLayer, rows: viewport, shell });
  }, [content, contentIdentity, listMotion]);
  useLayoutEffect(() => {
    updateFades();
    const frame = requestAnimationFrame(updateFades);
    return () => cancelAnimationFrame(frame);
  }, [contentIdentity, maxHeight, resolvedTheme, updateFades]);
  useEffect(() => {
    const viewport = rows.current;
    if (!viewport) return undefined;
    const resizeObserver = new ResizeObserver(updateFades);
    resizeObserver.observe(viewport);
    const rootObserver = new MutationObserver(updateFades);
    rootObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
    const visualViewport = window.visualViewport;
    visualViewport?.addEventListener('resize', updateFades);
    document.fonts.addEventListener('loadingdone', updateFades);
    void document.fonts.ready.then(updateFades);
    return () => {
      resizeObserver.disconnect();
      rootObserver.disconnect();
      visualViewport?.removeEventListener('resize', updateFades);
      document.fonts.removeEventListener('loadingdone', updateFades);
    };
  }, [updateFades]);
  useEffect(() => () => onHover(null), [onHover]);
  return (
    <div
      aria-label={t('preview-panel.legend.label')}
      className="preview-map-legend motion-surface motion-edge"
      data-legend-content={content}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        const canvas = event.currentTarget
          .closest('.preview-canvas')
          ?.querySelector<HTMLCanvasElement>(':scope > canvas');
        if (!canvas) return;
        event.preventDefault();
        event.stopPropagation();
        canvas.focus();
      }}
      role="region"
      data-read-only={readOnly ? 'true' : undefined}
      data-motion-enter={entersAlone ? undefined : 'false'}
      data-motion-from="left"
      data-theme={resolvedTheme}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerLeave={() => setPointerLayerKey(null)}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      ref={surfaceRef}
      style={{ maxHeight }}
      {...presenceProps(closing)}
    >
      <SearchField
        className="preview-legend-filter"
        clearLabel={t('preview-panel.legend.filter.clear')}
        label={t('preview-panel.legend.filter.label')}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            const canvas = event.currentTarget
              .closest('.preview-canvas')
              ?.querySelector<HTMLCanvasElement>(':scope > canvas');
            event.preventDefault();
            event.stopPropagation();
            if (canvas) focusPreviewCanvasQuietly(canvas);
            else event.currentTarget.blur();
            return;
          }
          if (event.key !== 'Escape' || !filter) return;
          event.preventDefault();
          event.stopPropagation();
          setFilter('');
        }}
        onValueChange={setFilter}
        placeholder={t('preview-panel.legend.filter.placeholder')}
        value={filter}
        variant="overlay"
      />
      <div className="preview-legend-scroll-shell" ref={scrollShell}>
        <div
          aria-label={t('preview-panel.legend.rows')}
          className="preview-legend-rows"
          role="group"
          data-fade-bottom={fades.bottom}
          data-fade-top={fades.top}
          onScroll={updateFades}
          onWheel={(event) => event.stopPropagation()}
          ref={rows}
          tabIndex={0}
        >
          {listedLayers.map((layer) => {
            const activation = !readOnly && resolveAggregatedLayerActivationForAvailability(layer);
            const label = labels.get(layer.key)!;
            return (
              <Tooltip disableHoverablePopup key={layer.key}>
                <TooltipTrigger
                  delay={0}
                  render={
                    <button
                      aria-label={
                        readOnly
                          ? t('preview-panel.legend.row.provisional', {
                              name: label.description,
                              count: layer.count,
                            })
                          : t('preview-panel.legend.row.open-source', {
                              name: label.description,
                              count: layer.count,
                            })
                      }
                      className="preview-layer-row"
                      data-helper={layer.material.helper ? 'true' : undefined}
                      data-kind={layer.kind}
                      data-layer-key={layer.key}
                      aria-disabled={activation ? undefined : true}
                      onBlur={() =>
                        setFocusedLayerKey((current) => (current === layer.key ? null : current))
                      }
                      onClick={() => {
                        if (activation) onActivate(layer);
                      }}
                      onFocus={() => setFocusedLayerKey(layer.key)}
                      onPointerEnter={() => setPointerLayerKey(layer.key)}
                      onPointerLeave={() =>
                        setPointerLayerKey((current) => (current === layer.key ? null : current))
                      }
                      type="button"
                    />
                  }
                >
                  <LayerIcon material={layer.material} />
                  <LayerName label={label} />
                  <span className="preview-layer-count">{layer.count}</span>
                </TooltipTrigger>
                <TooltipContent className="preview-layer-tooltip" side="right">
                  <LayerTooltip label={label} />
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
        <div aria-hidden="true" className="preview-legend-ghosts" inert ref={ghosts} />
      </div>
      {filter.trim() && listedLayers.length === 0 ? (
        <p className="preview-legend-empty">{t('preview-panel.legend.filter.empty')}</p>
      ) : null}
      {helperCount > 0 ? (
        <div className="preview-legend-helper-summary" data-testid="preview-legend-helper-summary">
          <Button
            aria-pressed={showHelpers}
            className="preview-legend-helper-toggle"
            onClick={onToggleHelpers}
            size="xs"
            type="button"
            variant="ghost"
          >
            {showHelpers
              ? t('preview-panel.legend.helpers.hide', { count: helperCount })
              : t('preview-panel.legend.helpers.show', { count: helperCount })}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function resolveAggregatedLayerActivationForAvailability(layer: AggregatedSelectionLayer): boolean {
  return layer.instances.some((instance) => instance.operationIndex !== null);
}

function DevelopmentFixtureMenu({
  execution,
  mapActive,
}: {
  execution: PreviewExecutionController | null;
  mapActive: boolean;
}) {
  const { t } = useI18n();
  if (!execution || execution.developmentFixtures.length === 0) return null;
  if (mapActive) {
    return (
      <select
        aria-label={t('preview-panel.fixtures.label')}
        className="preview-fixture-select"
        defaultValue=""
        onChange={(event) => {
          const fixtureId = event.currentTarget.value;
          const fixture = execution.developmentFixtures.find(
            (candidate) => candidate.id === fixtureId,
          );
          if (fixture) execution.runDevelopmentFixture(fixture.id);
          event.currentTarget.value = '';
        }}
      >
        <option value="">{t('preview-panel.fixtures.select-placeholder')}</option>
        {execution.developmentFixtures.map((fixture) => (
          <option key={fixture.id} value={fixture.id}>
            {fixture.label}
          </option>
        ))}
      </select>
    );
  }
  return (
    <div
      aria-label={t('preview-panel.fixtures.label')}
      className="preview-fixture-tool"
      data-map-active={mapActive}
      role="group"
    >
      <span className="preview-fixture-heading">
        <TestTube2 aria-hidden="true" /> {t('preview-panel.fixtures.heading')}
      </span>
      {execution.developmentFixtures.map((fixture) => (
        <Button
          aria-label={t('preview-panel.fixtures.run', { fixture: fixture.label })}
          key={fixture.id}
          onClick={() => execution.runDevelopmentFixture(fixture.id)}
          size="sm"
          variant="secondary"
        >
          {fixture.label}
        </Button>
      ))}
    </div>
  );
}

function previewStatusLabel(
  phase: NonNullable<PreviewExecutionController['status']>['phase'],
): string {
  switch (phase) {
    case 'editing':
      return translate('preview-panel.status.phase.editing');
    case 'analyzing':
      return translate('preview-panel.status.phase.analyzing');
    case 'unchanged':
      return translate('preview-panel.status.phase.unchanged');
    case 'invalid':
      return translate('preview-panel.status.phase.invalid');
    case 'generating':
      return translate('preview-panel.status.phase.generating');
    case 'current':
      return translate('preview-panel.status.phase.current');
    case 'failed':
      return translate('preview-panel.status.phase.failed');
  }
}

function connectionOverlayGeometry(
  scene: TopDownScene,
  map: PreviewGenerationResult | null,
  routes: ConnectionRouteSet | null,
): ConnectionOverlayGeometry {
  const operations =
    map && map.connectionOperationIndicesLe.byteLength === scene.connections.length * 4
      ? new DataView(
          map.connectionOperationIndicesLe.buffer,
          map.connectionOperationIndicesLe.byteOffset,
          map.connectionOperationIndicesLe.byteLength,
        )
      : null;
  return {
    width: scene.width,
    height: scene.height,
    connections: scene.connections,
    connectionOperation: (index) => (operations ? operations.getUint32(index * 4, true) : null),
    routes,
  };
}

function drawConnectionOverlay(
  stage: Application['stage'],
  geometry: ConnectionOverlayGeometry,
  scene: TopDownScene,
  mode: ConnectionOverlayMode,
  camera: PreviewCamera,
  viewport: PreviewViewport,
  container: HTMLElement,
): void {
  const probes: { drawn?: { x: number; y: number }; failed?: { x: number; y: number } } = {};
  let drawn = 0;
  let failed = 0;
  if (mode !== 'off') {
    const graphics = new Graphics();
    const stroke = connectionOverlayStroke;
    forEachConnectionOverlayElement(geometry, mode, camera, viewport, (target, points) => {
      const first = points[0];
      const last = points[points.length - 1];
      if (!first || !last) return;
      if (target.kind === 'failed') {
        for (const [from, to] of dashedSegments(first, last)) {
          graphics.moveTo(from.x, from.y).lineTo(to.x, to.y);
        }
        graphics.stroke({
          color: failedConnectionSearchColor,
          width: stroke.failed,
          alpha: stroke.failedAlpha,
        });
        probes.failed ??= { x: (first.x + last.x) / 2, y: (first.y + last.y) / 2 };
        failed += 1;
        return;
      }
      const color = connectionMaterial(
        scene.connections[target.connectionIndex] ?? { kind: 'unknown' },
      ).color;
      if (target.kind === 'line') {
        graphics
          .moveTo(first.x, first.y)
          .lineTo(last.x, last.y)
          .stroke({ color, width: stroke.line, alpha: 1 });
        probes.drawn ??= { x: (first.x + last.x) / 2, y: (first.y + last.y) / 2 };
        drawn += 1;
        return;
      }
      if (points.length > 1) {
        graphics.moveTo(first.x, first.y);
        for (const point of points.slice(1)) graphics.lineTo(point.x, point.y);
        graphics.stroke({
          color,
          width: stroke.path,
          alpha: stroke.pathAlpha,
          cap: 'round',
          join: 'round',
        });
      }
      graphics
        .circle(first.x, first.y, stroke.endpointRadius)
        .circle(last.x, last.y, stroke.endpointRadius)
        .fill({ color, alpha: 1 });
      probes.drawn ??= points[Math.floor(points.length / 2)] ?? first;
      drawn += 1;
    });
    stage.addChild(graphics);
  }
  container.dataset.connectionDrawn = String(drawn);
  container.dataset.connectionDrawnFailed = String(failed);
  for (const [key, point] of [
    ['connectionProbe', probes.drawn],
    ['connectionFailedProbe', probes.failed],
  ] as const) {
    if (point) container.dataset[key] = `${point.x.toFixed(2)},${point.y.toFixed(2)}`;
    else delete container.dataset[key];
  }
}

interface CliffStyle {
  look: PreviewLook;
  minimapPalette: SelectedMinimapPalette | null;
  textureCliffColors?: ReadonlyMap<number, number>;
}

function drawCliffs(
  stage: Application['stage'],
  scene: TopDownScene,
  camera: PreviewCamera,
  viewport: PreviewViewport,
  overlays: DiagnosticOverlays,
  style: CliffStyle,
  presentation: CliffPresentation = { kind: 'lines' },
): void {
  if (!overlays.cliffs) return;
  const graphics = new Graphics();
  const flat = style.look !== 'game-textures';
  const width = flat
    ? previewCliffStrokeWidth(previewScale(scene.width, scene.height, camera, viewport))
    : 3;
  const color = (cliffType: number) =>
    cliffMaterial(cliffType, style.look, style.minimapPalette, style.textureCliffColors).color;
  const stroke = (from: { x: number; y: number }, to: { x: number; y: number }, rgb: number) => {
    const start = mapToScreen(from, scene.width, scene.height, camera, viewport);
    const end = mapToScreen(to, scene.width, scene.height, camera, viewport);
    graphics
      .moveTo(start.x, start.y)
      .lineTo(end.x, end.y)
      .stroke(
        flat
          ? { color: rgb, width, alpha: 1, cap: 'round', join: 'round' }
          : { color: rgb, width, alpha: 1 },
      );
  };
  if (presentation.kind === 'lines') {
    for (const cliff of scene.cliffs) {
      stroke(cliff.from, cliff.to, color(cliff.cliffType));
    }
  } else {
    const pieceColor = color(scene.cliffs[0]?.cliffType ?? 0);
    for (const [index, piece] of (scene.cliffPieces ?? []).entries()) {
      if (presentation.drawnPieces.has(index)) continue;
      for (const leg of cliffLegs(piece)) stroke(leg.from, leg.to, pieceColor);
    }
  }
  stage.addChild(graphics);
}

type CliffPresentation = { kind: 'lines' } | { kind: 'pieces'; drawnPieces: ReadonlySet<number> };

function cliffPresentation(
  scene: TopDownScene,
  gameTextures: boolean,
  cache: TerrainChunkCache,
): CliffPresentation {
  const pieces = scene.cliffPieces ?? [];
  if (!gameTextures || pieces.length === 0) return { kind: 'lines' };
  if (cache.gameArtCliffs) {
    return { kind: 'pieces', drawnPieces: new Set(pieces.keys()) };
  }
  return {
    kind: 'pieces',
    drawnPieces: cache.gameArtSprites?.layer.drawnCliffPieces ?? new Set<number>(),
  };
}

function drawObjects(
  stage: Application['stage'],
  scene: TopDownScene,
  camera: PreviewCamera,
  viewport: PreviewViewport,
  visibility: PreviewObjectVisibility,
  playerColorIds: readonly number[] = [],
  minimapPalette: SelectedMinimapPalette | null = null,
  maximumObjects = Number.POSITIVE_INFINITY,
  spriteObjects: ReadonlySet<number> = new Set(),
  lookObjectColors?: ReadonlyMap<number, number>,
): { helpers: number; objects: number; radiusRange: string } {
  const drawn = { helpers: 0, objects: 0, radiusRange: '' };
  if (!visibility.objects) return drawn;
  const layer = new OrderedMarkerLayer(stage);
  const scale = previewScale(scene.width, scene.height, camera, viewport);
  const verticalScale = previewMarkerVerticalScale(viewport);
  const colocatedOrdinals = new Map<number, number>();
  const materials = new Map<number, PreviewMaterial>();
  let minimumRadius = Number.POSITIVE_INFINITY;
  let maximumRadius = 0;
  for (const [objectIndex, object] of scene.objects.entries()) {
    if (objectIndex >= maximumObjects) break;
    if (!isDrawnPreviewObject(object, visibility)) continue;
    if (spriteObjects.has(object.index)) continue;
    const tileKey = Math.floor(object.y) * (scene.width + 1) + Math.floor(object.x);
    const colocatedOrdinal = colocatedOrdinals.get(tileKey) ?? 0;
    colocatedOrdinals.set(tileKey, colocatedOrdinal + 1);
    const center = mapToScreen(object, scene.width, scene.height, camera, viewport);
    const reach =
      previewMarkerScreenRadius.maximum +
      scale * Math.max(1, object.footprintWidth, object.footprintHeight);
    if (
      center.x < -reach ||
      center.y < -reach ||
      center.x > viewport.width + reach ||
      center.y > viewport.height + reach
    ) {
      continue;
    }
    const offset = colocatedCompositionOffset(colocatedOrdinal, scale);
    offset.y *= verticalScale;
    center.x += offset.x;
    center.y += offset.y;
    const footprintWidth = previewObjectFootprintSpan(object.footprintWidth);
    const footprintHeight = previewObjectFootprintSpan(object.footprintHeight);
    const footprint = mapRectangleScreenPolygon(
      {
        x: object.x - footprintWidth / 2,
        y: object.y - footprintHeight / 2,
      },
      {
        x: object.x + footprintWidth / 2,
        y: object.y + footprintHeight / 2,
      },
      scene.width,
      scene.height,
      camera,
      viewport,
    ).map((coordinate, index) => coordinate + (index % 2 === 0 ? offset.x : offset.y));
    const footprintBounds = polygonBounds(footprint);
    if (
      footprintBounds.right < 0 ||
      footprintBounds.left > viewport.width ||
      footprintBounds.bottom < 0 ||
      footprintBounds.top > viewport.height
    ) {
      continue;
    }
    const materialKey =
      (object.objectId * 256 + (object.owner & 0xff)) * 2 +
      (object.presentationKind === 'wall' ? 1 : 0);
    let material = materials.get(materialKey);
    if (!material) {
      material = objectMaterial(
        object,
        playerColorIds,
        [],
        minimapPalette,
        undefined,
        visibility.helperObjectIds,
        lookObjectColors,
      );
      materials.set(materialKey, material);
    }
    const radius = previewObjectMarkerScreenRadius(
      scale,
      previewObjectMarkerSpan(object),
      object.appearance ? previewAppearanceMarkerMinimumRadius : undefined,
    );
    minimumRadius = Math.min(minimumRadius, radius);
    maximumRadius = Math.max(maximumRadius, radius);
    if (material.helper) {
      drawn.helpers += 1;
      drawAtomicShape(layer.stroke, center.x, center.y, radius, material, 'outline', verticalScale);
      continue;
    }
    drawn.objects += 1;
    if (hasVisiblePreviewFootprint(object)) {
      layer.stroke.poly(footprint).stroke({ color: material.color, width: 1, alpha: 1 });
    }
    fillAtomicShape(layer, center.x, center.y, radius, material, verticalScale);
  }
  layer.finish();
  if (maximumRadius > 0) {
    drawn.radiusRange = `${minimumRadius.toFixed(2)},${maximumRadius.toFixed(2)}`;
  }
  return drawn;
}

function drawSelectionOutline(
  graphics: Graphics | null,
  scene: TopDownScene,
  camera: PreviewCamera,
  viewport: PreviewViewport,
  selection: PreviewSelection | null,
): void {
  if (!graphics) return;
  graphics.clear();
  if (!selection) return;
  const polygon = mapRectangleScreenPolygon(
    { x: selection.minimumX, y: selection.minimumY },
    { x: selection.maximumX + 1, y: selection.maximumY + 1 },
    scene.width,
    scene.height,
    camera,
    viewport,
  );
  graphics.poly(polygon).stroke({ color: 0xffffff, width: 2, alpha: 1 });
}

function drawLegendHover(
  graphics: Graphics | null,
  scene: TopDownScene,
  camera: PreviewCamera,
  viewport: PreviewViewport,
  tileIndices: Iterable<number>,
): void {
  if (!graphics) return;
  graphics.clear();
  const indices = [...tileIndices];
  if (indices.length === 0) return;
  for (const tileIndex of indices) {
    const x = tileIndex % scene.width;
    const y = Math.floor(tileIndex / scene.width);
    graphics.poly(
      mapRectangleScreenPolygon(
        { x, y },
        { x: x + 1, y: y + 1 },
        scene.width,
        scene.height,
        camera,
        viewport,
      ),
    );
  }
  graphics.fill({ color: 0xffffff, alpha: 0.6 });
}

interface MapBoundaryElements {
  outline: SVGPolygonElement | null;
  arc: SVGSVGElement | null;
  border: SVGPathElement | null;
  frame: SVGPathElement | null;
  strokeWidth: number;
}

function drawMapBoundaryOutline(
  elements: MapBoundaryElements,
  scene: Pick<TopDownScene, 'width' | 'height'>,
  camera: PreviewCamera,
  viewport: PreviewViewport,
): void {
  const polygon = elements.outline;
  if (!polygon) return;
  const points = mapRectangleScreenPolygon(
    { x: 0, y: 0 },
    { x: scene.width, y: scene.height },
    scene.width,
    scene.height,
    camera,
    viewport,
  );
  const pairs: string[] = [];
  for (let index = 0; index < points.length; index += 2) {
    pairs.push(`${points[index]!.toFixed(2)},${points[index + 1]!.toFixed(2)}`);
  }
  polygon.setAttribute('points', pairs.join(' '));
  const { arc, border, frame } = elements;
  if (!arc || !border || !frame) return;
  const visible = visibleMapBoundary(
    points,
    insetBoundaryFrame(viewport.width, viewport.height, elements.strokeWidth),
  );
  const paths = boundarySubpaths(visible);
  border.setAttribute('d', paths.border);
  frame.setAttribute('d', paths.frame);
  const center = visible.center ?? { x: viewport.width / 2, y: viewport.height / 2 };
  arc.style.setProperty('--preview-boundary-center-x', `${center.x.toFixed(2)}px`);
  arc.style.setProperty('--preview-boundary-center-y', `${center.y.toFixed(2)}px`);
  arc.dataset.frameSides = boundaryFrameSides(visible).join(' ');
}

function drawPreviewOutlines(
  selectionGraphics: Graphics | null,
  sourceGraphics: Graphics | null,
  legendHoverGraphics: Graphics | null,
  boundary: MapBoundaryElements,
  scene: TopDownScene,
  camera: PreviewCamera,
  viewport: PreviewViewport,
  selection: PreviewSelection | null,
  sourceHighlightTileIndices: Iterable<number>,
  legendHoverTileIndices: Iterable<number>,
): void {
  drawSelectionOutline(selectionGraphics, scene, camera, viewport, selection);
  drawLegendHover(sourceGraphics, scene, camera, viewport, sourceHighlightTileIndices);
  drawLegendHover(legendHoverGraphics, scene, camera, viewport, legendHoverTileIndices);
  drawMapBoundaryOutline(boundary, scene, camera, viewport);
}

function drawAtomicShape(
  graphics: Graphics,
  x: number,
  y: number,
  radius: number,
  material: PreviewMaterial,
  style: 'fill' | 'outline' = 'fill',
  verticalScale = 1,
): void {
  const paint = (shape: Graphics) =>
    style === 'outline'
      ? shape.stroke({ color: material.color, width: 1, alpha: 0.75 })
      : shape.fill({ color: material.color });
  if (material.shape === 'double-line') {
    const wallGap = Math.min(2, Math.max(1, radius * 0.5)) * verticalScale;
    graphics
      .moveTo(x - radius, y - wallGap)
      .lineTo(x + radius, y - wallGap)
      .stroke({ color: material.color, width: style === 'outline' ? 1 : 2, alpha: 1 });
    graphics
      .moveTo(x - radius, y + wallGap)
      .lineTo(x + radius, y + wallGap)
      .stroke({ color: material.color, width: 1, alpha: 1 });
    return;
  }
  const polygon = markerShapePolygon(material.shape, x, y, radius, verticalScale);
  if (polygon.length === 0) {
    paint(graphics.ellipse(x, y, radius, radius * verticalScale));
    return;
  }
  paint(graphics.poly(polygon));
}

function fillAtomicShape(
  layer: OrderedMarkerLayer,
  x: number,
  y: number,
  radius: number,
  material: PreviewMaterial,
  verticalScale: number,
): void {
  if (material.shape === 'double-line') {
    drawAtomicShape(layer.stroke, x, y, radius, material, 'fill', verticalScale);
    return;
  }
  const polygon = markerShapePolygon(material.shape, x, y, radius, verticalScale);
  if (polygon.length === 0) {
    layer.fill.ellipse(x, y, radius, radius * verticalScale, material.color);
    return;
  }
  layer.fill.polygon(polygon, material.color);
}

function colocatedCompositionOffset(ordinal: number, scale: number): { x: number; y: number } {
  if (ordinal === 0) return { x: 0, y: 0 };
  const angle = (ordinal - 1) * 2.399963229728653;
  const distance = Math.min(Math.max(2, scale * 0.16), 8) * Math.ceil(ordinal / 6);
  return { x: Math.cos(angle) * distance, y: Math.sin(angle) * distance };
}

function polygonBounds(points: number[]): {
  left: number;
  right: number;
  top: number;
  bottom: number;
} {
  const xs = points.filter((_, index) => index % 2 === 0);
  const ys = points.filter((_, index) => index % 2 === 1);
  return {
    left: Math.min(...xs),
    right: Math.max(...xs),
    top: Math.min(...ys),
    bottom: Math.max(...ys),
  };
}

function LayerName({ label }: { label: PreviewLayerLabel }) {
  const text = [label.name, label.disambiguation, label.owner].filter(Boolean).join(' ');
  return (
    <OverflowingLabel
      className="preview-layer-name"
      name={text}
      textClassName="preview-layer-name-text"
    >
      <span
        className="preview-layer-name-primary"
        data-muted={label.nameMuted ? 'true' : undefined}
      >
        {label.name}
      </span>
      {label.disambiguation ? (
        <>
          {' '}
          <span className="preview-layer-name-muted" data-part="identity">
            {label.disambiguation}
          </span>
        </>
      ) : null}
      {label.owner ? (
        <>
          {' '}
          <span className="preview-layer-name-muted" data-part="owner">
            {label.owner}
          </span>
        </>
      ) : null}
    </OverflowingLabel>
  );
}

function LayerTooltip({ label }: { label: PreviewLayerLabel }) {
  return (
    <div className="preview-layer-tooltip-body" data-testid="preview-layer-tooltip">
      <span className="preview-layer-tooltip-name">{label.name}</span>
      {label.details.map((detail) => (
        <span className="preview-layer-tooltip-detail" key={detail}>
          {detail}
        </span>
      ))}
    </div>
  );
}

function LayerIcon({ material }: { material: PreviewMaterial }) {
  const color = `#${material.color.toString(16).padStart(6, '0')}`;
  return (
    <span
      aria-hidden="true"
      className="preview-layer-icon"
      data-color={color}
      data-color-source={material.colorSource}
      data-helper={material.helper ? 'true' : undefined}
      data-shape={material.shape}
      style={{ '--preview-layer-color': color } as React.CSSProperties}
    />
  );
}

function createTerrainChunkCache(
  key: string,
  scene: TopDownScene,
  terrainIds: readonly number[],
  backend: PreviewBackend,
  elevationMode: ElevationDisplayMode,
  heightOverlayColor: number,
  minimapPalette: SelectedMinimapPalette | null,
  terrainColorSources: TerrainColorSources,
  lookTerrainColors: ReadonlyMap<number, number> | undefined,
): TerrainChunkCache {
  const container = new Container({ label: 'cached-terrain-chunks' });
  container.eventMode = 'none';
  return {
    backend,
    chunks: new Map(),
    container,
    elevationMode,
    elevationRange: terrainElevationRange(scene.elevations),
    geometryBuilds: 0,
    heightOverlayColor,
    key,
    minimapPalette,
    scene,
    terrainColorSources,
    lookTerrainColors,
    terrainIds,
    terrainSource: null,
    gameArtTerrain: null,
    gameArtSprites: null,
    gameArtStore: null,
    gameArtCliffs: null,
    gameArtPresentation: createGameArtPresentationState(),
    tileGrid: null,
  };
}

function emptyViewScene(width: number, height: number): TopDownScene {
  return {
    width,
    height,
    terrainIds: [],
    preConnectionTerrainIds: [],
    elevations: [],
    terrainZones: [],
    landZones: [],
    layerIds: [],
    flags: [],
    cliffs: [],
    connections: [],
    objects: [],
  };
}

function cssColorToNumber(color: string, fallback: number): number {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return fallback;
  try {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
    if (alpha === 0 || red === undefined || green === undefined || blue === undefined) {
      return fallback;
    }
    return (red << 16) | (green << 8) | blue;
  } catch {
    return fallback;
  }
}

function updateTerrainChunkVisibility(
  cache: TerrainChunkCache,
  cameras: readonly PreviewCamera[],
  viewport: PreviewViewport,
  host: HTMLElement | null,
): void {
  const visibleKeys = new Set<string>();
  const visibleChunks: VisibleChunk[] = [];
  const overscan = terrainOverscanPixels(viewport);
  const viewportPolygon = [
    -overscan,
    -overscan,
    viewport.width + overscan,
    -overscan,
    viewport.width + overscan,
    viewport.height + overscan,
    -overscan,
    viewport.height + overscan,
  ];
  for (const camera of cameras) {
    const range = visibleTileRange(cache.scene, camera, viewport, overscan);
    for (const chunk of visibleTerrainChunks(range, cache.scene.width, cache.scene.height)) {
      if (!terrainChunkIntersectsViewport(chunk, cache.scene, camera, viewport, viewportPolygon)) {
        continue;
      }
      const key = `${chunk.minimumX}:${chunk.minimumY}`;
      if (!visibleKeys.has(key)) visibleChunks.push(chunk);
      visibleKeys.add(key);
      if (cache.chunks.has(key)) continue;
      const debugName = `terrain-chunk-${key}`;
      const container = new Container({ label: debugName });
      container.eventMode = 'none';
      container.visible = !cache.gameArtPresentation.minimapHidden;
      const chunkWidth = chunk.maximumX - chunk.minimumX + 1;
      const chunkHeight = chunk.maximumY - chunk.minimumY + 1;
      const texture = new Texture({
        source: terrainTextureSource(cache),
        frame: new Rectangle(chunk.minimumX, chunk.minimumY, chunkWidth, chunkHeight),
      });
      const sprite = new Sprite({ texture, label: 'terrain' });
      sprite.eventMode = 'none';
      sprite.setFromMatrix(chunkSpriteMatrix(chunk.minimumX, chunk.minimumY, 1));
      container.addChild(sprite);
      const tileCount = chunkWidth * chunkHeight;
      cache.geometryBuilds += 1;
      cache.chunks.set(key, { container, texture, tileCount });
      cache.container.addChild(container);
    }
  }

  let renderedTiles = 0;
  for (const [key, chunk] of cache.chunks) {
    const visible = visibleKeys.has(key);
    chunk.container.renderable = visible;
    if (visible) renderedTiles += chunk.tileCount;
  }
  const targetCamera = cameras[cameras.length - 1];
  if (cache.gameArtTerrain && targetCamera) {
    const resolution = Math.min(globalThis.devicePixelRatio || 1, 2);
    cache.gameArtTerrain.layer.update(
      visibleChunks,
      previewScale(cache.scene.width, cache.scene.height, targetCamera, viewport) * resolution,
    );
  }
  cache.gameArtSprites?.layer.update(visibleChunks);
  if (host) writeGameArtDataset(cache, host);
  if (!host) return;
  host.dataset.cachedTerrainChunks = String(cache.chunks.size);
  host.dataset.renderedTiles = String(renderedTiles);
  host.dataset.terrainGeometryBuilds = String(cache.geometryBuilds);
  host.dataset.renderedElevationMode = cache.elevationMode;
  host.dataset.terrainOverscanPixels = String(overscan);
  host.dataset.visibleChunks = String(visibleKeys.size);
}

function terrainTextureSource(cache: TerrainChunkCache): BufferImageSource {
  if (cache.terrainSource) return cache.terrainSource;
  const texels = buildTerrainTexels(cache.scene, cache.terrainIds, cache.backend, {
    backgroundColor: cache.heightOverlayColor,
    elevationMode: cache.elevationMode,
    elevationRange: cache.elevationRange,
    localTerrainColors: cache.terrainColorSources.localTerrainColors,
    lookTerrainColors: cache.lookTerrainColors,
    minimapPalette: cache.minimapPalette,
    terrainNames: cache.terrainColorSources.terrainNames,
  });
  cache.terrainSource = new BufferImageSource({
    resource: texels,
    width: cache.scene.width,
    height: cache.scene.height,
    format: 'rgba8unorm',
    alphaMode: 'premultiplied-alpha',
    scaleMode: 'nearest',
    addressMode: 'clamp-to-edge',
    autoGenerateMipmaps: false,
  });
  return cache.terrainSource;
}

function terrainOverscanPixels(viewport: PreviewViewport): number {
  return Math.round(Math.min(160, Math.max(64, Math.min(viewport.width, viewport.height) * 0.18)));
}

function terrainChunkIntersectsViewport(
  chunk: VisibleChunk,
  scene: Pick<TopDownScene, 'width' | 'height'>,
  camera: PreviewCamera,
  viewport: PreviewViewport,
  viewportPolygon: number[],
): boolean {
  const chunkPolygon = mapRectangleScreenPolygon(
    { x: chunk.minimumX, y: chunk.minimumY },
    { x: chunk.maximumX + 1, y: chunk.maximumY + 1 },
    scene.width,
    scene.height,
    camera,
    viewport,
  );
  return convexPolygonsIntersect(chunkPolygon, viewportPolygon);
}

function convexPolygonsIntersect(left: number[], right: number[]): boolean {
  const axes: [number, number][] = [
    [1, 0],
    [0, 1],
  ];
  for (let index = 0; index < left.length; index += 2) {
    const next = (index + 2) % left.length;
    const edgeX = left[next]! - left[index]!;
    const edgeY = left[next + 1]! - left[index + 1]!;
    axes.push([-edgeY, edgeX]);
  }
  for (const [axisX, axisY] of axes) {
    const leftProjection = polygonProjection(left, axisX, axisY);
    const rightProjection = polygonProjection(right, axisX, axisY);
    if (leftProjection.maximum < rightProjection.minimum) return false;
    if (rightProjection.maximum < leftProjection.minimum) return false;
  }
  return true;
}

function polygonProjection(
  polygon: number[],
  axisX: number,
  axisY: number,
): { maximum: number; minimum: number } {
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < polygon.length; index += 2) {
    const projection = polygon[index]! * axisX + polygon[index + 1]! * axisY;
    minimum = Math.min(minimum, projection);
    maximum = Math.max(maximum, projection);
  }
  return { maximum, minimum };
}

function transformTerrainLayer(
  layer: Container,
  camera: PreviewCamera,
  scene: Pick<TopDownScene, 'width' | 'height'>,
  viewport: PreviewViewport,
): void {
  const transform = terrainLayerTransform(scene, camera, viewport);
  layer.scale.set(transform.scaleX, transform.scaleY);
  layer.position.set(transform.x, transform.y);
  tileGridLayers.get(layer)?.update(scene, camera, viewport);
}

const tileGridLayers = new WeakMap<Container, TileGridLayer>();

function syncTileGrid(
  cache: TerrainChunkCache,
  enabled: boolean,
  color: TileGridColor,
  host: HTMLElement,
): void {
  if (!enabled) {
    if (cache.tileGrid) {
      tileGridLayers.delete(cache.container);
      cache.tileGrid.destroy();
      cache.tileGrid = null;
    }
    host.dataset.tileGrid = 'off';
    delete host.dataset.tileGridLines;
    return;
  }
  if (!cache.tileGrid) {
    const layer = new TileGridLayer(cache.scene.width, cache.scene.height, color);
    layer.container.zIndex = 1.1;
    cache.container.sortableChildren = true;
    cache.container.addChild(layer.container);
    cache.tileGrid = layer;
    tileGridLayers.set(cache.container, layer);
  } else {
    cache.tileGrid.setColor(color);
  }
  host.dataset.tileGrid = 'on';
  host.dataset.tileGridLines = String(cache.tileGrid.lineCount);
}

function tileGridColor(element: HTMLElement): TileGridColor {
  const value = getComputedStyle(element).getPropertyValue('--preview-tile-grid').trim();
  if (!value) return fallbackTileGridColor;
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return fallbackTileGridColor;
  try {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
    if (!alpha || red === undefined || green === undefined || blue === undefined) {
      return fallbackTileGridColor;
    }
    return { color: (red << 16) | (green << 8) | blue, alpha: alpha / 255 };
  } catch {
    return fallbackTileGridColor;
  }
}

function destroyTerrainChunkCache(cache: TerrainChunkCache): void {
  destroyGameArtLayers(cache);
  cache.tileGrid?.destroy();
  cache.tileGrid = null;
  cache.container.destroy({ children: true });
  for (const chunk of cache.chunks.values()) chunk.texture.destroy(false);
  cache.chunks.clear();
  cache.terrainSource?.destroy();
  cache.terrainSource = null;
}

function destroyStageChildren(children: ContainerChild[]): void {
  for (const child of children) child.destroy({ children: true });
}

function sameMapCoordinate(
  left: { x: number; y: number } | null,
  right: { x: number; y: number } | null,
): boolean {
  return (
    left === right || (left !== null && right !== null && left.x === right.x && left.y === right.y)
  );
}

function samePreviewSelection(
  left: PreviewSelection | null,
  right: PreviewSelection | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.minimumX === right.minimumX &&
      left.maximumX === right.maximumX &&
      left.minimumY === right.minimumY &&
      left.maximumY === right.maximumY)
  );
}

function interpolateCamera(
  from: PreviewCamera,
  target: PreviewCamera,
  progress: number,
): PreviewCamera {
  return {
    centerX: from.centerX + (target.centerX - from.centerX) * progress,
    centerY: from.centerY + (target.centerY - from.centerY) * progress,
    zoom: from.zoom + (target.zoom - from.zoom) * progress,
  };
}

function transformMapLayer(
  layer: Container,
  renderedCamera: PreviewCamera,
  targetCamera: PreviewCamera,
  scene: Pick<TopDownScene, 'width' | 'height'>,
  viewport: PreviewViewport,
): void {
  const transform = previewScreenTransform(
    scene.width,
    scene.height,
    renderedCamera,
    viewport,
    targetCamera,
    viewport,
  );
  layer.scale.set(transform.scale);
  layer.position.set(transform.x, transform.y);
}

function samePreviewCamera(left: PreviewCamera, right: PreviewCamera): boolean {
  return (
    left.centerX === right.centerX && left.centerY === right.centerY && left.zoom === right.zoom
  );
}

function applyFrozenCanvas(
  canvas: HTMLCanvasElement,
  transform: PreviewScreenTransform | null,
): void {
  canvas.dataset.layoutFrozen = 'true';
  if (!transform) {
    canvas.style.visibility = 'hidden';
    canvas.style.removeProperty('transform');
    canvas.style.removeProperty('transform-origin');
    return;
  }
  canvas.style.removeProperty('visibility');
  canvas.style.transformOrigin = '0 0';
  canvas.style.transform = `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`;
}

function clearFrozenCanvas(canvas: HTMLCanvasElement | null): void {
  if (!canvas || canvas.dataset.layoutFrozen === undefined) return;
  delete canvas.dataset.layoutFrozen;
  canvas.style.removeProperty('visibility');
  canvas.style.removeProperty('transform');
  canvas.style.removeProperty('transform-origin');
}

function setCameraDataset(
  container: HTMLElement,
  scene: Pick<TopDownScene, 'width' | 'height'>,
  camera: PreviewCamera,
  viewport: PreviewViewport,
): void {
  const bounds = mapScreenBounds(scene, camera, viewport);
  const origin = mapToScreen({ x: 0, y: 0 }, scene.width, scene.height, camera, viewport);
  container.dataset.cameraCenterX = camera.centerX.toFixed(4);
  container.dataset.cameraCenterY = camera.centerY.toFixed(4);
  container.dataset.cameraZoom = camera.zoom.toFixed(4);
  container.dataset.mapLeft = bounds.left.toFixed(4);
  container.dataset.mapRight = bounds.right.toFixed(4);
  container.dataset.mapTop = bounds.top.toFixed(4);
  container.dataset.mapBottom = bounds.bottom.toFixed(4);
  container.dataset.mapOriginX = origin.x.toFixed(4);
  container.dataset.mapOriginY = origin.y.toFixed(4);
  container.dataset.mapScale = previewScale(scene.width, scene.height, camera, viewport).toFixed(4);
}
