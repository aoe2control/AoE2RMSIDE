import { outputNote } from '../shared/output-message';
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type SetStateAction,
  type ReactNode,
  type Ref,
} from 'react';
import {
  BoxIcon,
  BoxesIcon,
  ChartNoAxesColumnIcon,
  DropletIcon,
  EyeOffIcon,
  FootprintsIcon,
  HoverScaleIcon,
  ImageIcon,
  LayersIcon,
  LayoutGridIcon,
  MapIcon,
  MountainIcon,
  MonitorIcon,
  MoveDiagonal2Icon,
  RouteIcon,
  SunDimIcon,
} from './hover-scale-icon';
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
import { Copy, Grid3x3, MousePointer2, Save, Scan, TestTube2, TreePine } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuItem } from '@/components/ui/context-menu';
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
  previewColourLayerLook,
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
import { previewImageFileName } from '../shared/image-export';
import { previewToolTooltipRoot, previewToolTooltipTrigger } from './preview-tool-tooltip';
import { shownCodeHighlightTiles } from './editor-list-handoff';
import { listSurfaceMode, useListSurfaceGeometry } from './selection-list-surface';
import {
  capturePreviewImage,
  moveRightPress,
  rightClickOpensMenu,
  type RightPress,
} from './preview-image';
import { createPortal, flushSync } from 'react-dom';
import { type GameArtCliffBandLayer, cliffLegs } from './game-art-cliffs';
import {
  createGameArtPresentationState,
  destroyGameArtLayers,
  framedGameArtTerrain,
  gameArtPictureKey,
  gameArtStandIn,
  gameArtMarkerSkips,
  handOverGameArtPicture,
  keepsGameArtPicture,
  setGameArtKindVisibility,
  setGameArtTreeScale,
  syncGameArtLayers,
  writeGameArtDataset,
  type GameArtPictureRaised,
  type GameArtPresentationState,
} from './game-art-layers';
import { GameArtConversionProgress } from './game-art-progress';
import { treeSpriteScale } from './game-art-small-trees';
import type { GameArtSpriteLayer } from './game-art-sprites';
import { teamColorResolver } from './game-art-team-colors';
import type { GameArtTerrainPicture } from './game-art-layers';
import {
  chooseMapRenderer,
  gpuMapRenderingMessageCode,
  lazyGpuMapProbe,
  probeGpuMapRendering,
  probeRaisedTerrain,
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
import { previewTerrainCacheKeys } from './preview-terrain-cache-key';
import { useDelayedFlag } from './use-delayed-flag';
import { useI18n } from './i18n';
import { usePreviewLayerArt } from './preview-layer-art';
import {
  gameArtCivilizationKey,
  gameArtCivilizationResolver,
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
import {
  attachPreviewRenderScheduler,
  detachPreviewRenderScheduler,
  framePixelBounds,
  framePixelHash,
  PreviewRenderScheduler,
  requestPreviewRender,
} from './preview-render-scheduler';
import { mapLayerKeptForCamera, markerCullMargin, type BuiltMapLayer } from './preview-scene-reuse';
import { useAppPanelContext } from './app-context';
import { rovingKeyTarget } from './keyboard-navigation';
import { developmentFixtureRunnable, type PreviewExecutionController } from './preview-execution';
import { RunConfigurationPanel } from './run-configuration-panel';
import { ExecutionProfiler } from './execution-profiler-panel';
import { onGameInstallationChanged } from './game-installation';
import { presentPreviewNames, presentTerrainColorSources } from './presentation-names';
import {
  boundaryFrameSides,
  boundaryOutlinePath,
  boundarySubpaths,
  type BoundaryMotion,
  cssDurationMilliseconds,
  boundaryEdgePixelsPerTile,
  boundaryEntranceMargin,
  cssNumber,
  cssPixels,
  expandBoundaryLoop,
  insetBoundaryFrame,
  nextBoundaryMotion,
  visibleMapBoundary,
} from './preview-boundary';
import {
  isPreviewLayout,
  previewLayoutShowsPreview,
  previewLayoutSwitchGlides,
} from '../shared/preview-layout';
import { documentTransitionEnvironment, watchSizeTransitions } from './layout-transition';
import { ListMotion } from './list-motion';
import {
  motionDuration,
  prefersReducedMotion,
  presenceProps,
  useHeld,
  usePresence,
} from './motion';
import { useFinishedWork, useRowsMountedInFrames } from './sliced-work';
import { OverflowingLabel } from './overflow-label';
import { SearchField } from './search-field';
import {
  focusPreviewCanvasQuietly,
  previewLegendMaxHeight,
  rectContainsPoint,
  selectionListRowHeight,
  selectionListRowsPerFrame,
  useCanvasKeyboardFocus,
  useOverlayPointerHover,
  usePreviewLegendWidth,
  useReadoutLabelGlide,
} from './preview-overlay-interaction';
import { PreviewCandidateLayer, type CandidatePresentation } from './preview-candidate-layer';
import {
  morphPicture,
  PreviewMapTransitions,
  type MorphTerrainData,
  type RetiredTerrain,
} from './preview-map-transitions';
import {
  fitTransitionToScene,
  nextLiveStageHold,
  planLiveStageMorph,
  releasesLiveStageHold,
  type LiveStageHold,
  type TransitionPicture,
} from './preview-transitions';
import {
  candidateObjectClassLookup,
  previewLegendContent,
  ProvisionalLegendCounts,
  provisionalLegendLayers,
  selectionFitsCandidate,
  selectionKeptForView,
} from './preview-candidate-legend';
import * as latencyProbe from './latency-probe';
import { previewCandidateStageLabel, type PreviewCandidateView } from './preview-candidate-store';
import {
  describePreviewSelection,
  keyboardCursorFor,
  moveKeyboardSelection,
  panCameraByKeyboard,
  previewKeyboardCommand,
  previewKeyboardHelp,
  previewKeyboardShortcuts,
  type PreviewKeyboardCursor,
} from './preview-keyboard';
import { panDragCamera, type PreviewPanDrag } from './preview-pan-drag';
import {
  cameraTransitionFrame,
  cameraTransitionTo,
  wheelZoomFactor,
  zoomStepStartsTransition,
  zoomTransitionTarget,
  type CameraTransition,
} from './preview-camera-zoom';
import {
  cameraCommittedOnDragRelease,
  followSelectionDrag,
  sceneBuildCamera,
  selectionDragRectangle,
  type PreviewSelectionDrag,
} from './preview-selection-drag';
import {
  clampPreviewCamera,
  decodeTopDownScene,
  fitPreviewCamera,
  hasLandConnection,
  hitTestTopDownScene,
  mapRectangleScreenPolygon,
  mapScreenBounds,
  mapToScreen,
  previewCameraForCentre,
  previewCameraIsCentred,
  previewCliffStrokeWidth,
  previewMarkerVerticalScale,
  previewLevelPixels,
  previewScale,
  previewScreenTransform,
  previewViewCenter,
  previewViewportIsCollapsed,
  previewVisibleWidth,
  rectangularSelectionFromDrag,
  raisedMapToScreen,
  samePreviewEditorInsets,
  samePreviewFocus,
  samePreviewViewport,
  screenToVisibleMap,
  visibleTerrainChunks,
  visibleTileRange,
  zoomPreviewCamera,
  type PreviewCamera,
  type PreviewProjection,
  type PreviewScreenTransform,
  type PreviewSelection,
  type PreviewViewport,
  type TopDownScene,
  type VisibleChunk,
} from './top-down-preview';
import {
  aggregatedLayerTileIndices,
  aggregateTileIndexLayers,
  cliffMaterial,
  connectionMaterial,
  isDrawnPreviewObject,
  layerInstanceIdRange,
  layerResourceTotals,
  legendHighlightKey,
  objectNameForId,
  operationTileIndices,
  operationWrittenTiles,
  partitionHelperLayers,
  previewHelperObjectIds,
  previewLegendFilterMatches,
  previewLegendLabels,
  previewReadoutStacked,
  previewResourceTotalMessages,
  terrainColorSourcesIdentity,
  terrainMaterial,
  resolveAggregatedLayerActivation,
  selectionLayerAggregation,
  type AggregatedSelectionLayer,
  type PreviewLayerLabel,
  type PreviewMaterial,
  type PreviewObjectVisibility,
} from './preview-materials';
import {
  flatElevationMode,
  nextElevationDisplayMode,
  shownElevationDisplayMode,
  terrainElevationRange,
  type ElevationDisplayMode,
  type ElevationRange,
} from './preview-terrain-mesh';
import { buildTerrainTexels } from './preview-terrain-texture';
import { MarkerCoverage } from './preview-marker-coverage';
import { markerExtensionLabel, OrderedMarkerLayer, zoomMarkerMeshes } from './preview-marker-mesh';
import {
  bindPreviewOverlayFades,
  overlayFadeOf,
  usePreviewOverlayFades,
  type OverlayFade,
} from './preview-overlay-fade';
import {
  allCorners,
  concaveCornerPolygon,
  cornerArcSegments,
  highlightCornerRadius,
  highlightCorners,
  roundedRectanglePolygon,
} from './preview-highlight-corners';
import { highlightTileRuns } from './preview-highlight-runs';
import {
  SelectionEase,
  selectionEdges,
  selectionFollowFallbackMilliseconds,
} from './preview-selection-ease';
import {
  applyPreviewResizeAnchor,
  composePreviewTransforms,
  invertPreviewTransform,
  previewFocusShownShare,
  previewLayoutSwitchAnchor,
  previewLayoutSwitchCamera,
  previewLayoutSwitchPlan,
  previewLayoutSwitchSettles,
  previewMotionFocus,
  previewResizeAnchor,
  previewSwitchRestoreCamera,
  previewSwitchRestoreView,
  type PreviewCanvasSize,
  type PreviewLayoutSwitchPlan,
  type PreviewSwitchRestore,
} from './preview-resize-anchor';
import { drawObjects, objectHeightMapLight } from './preview-object-markers';
import { chunkSpriteMatrix } from './game-art-terrain';
import { litColor, raisedSurfaceFor, type ElevationSurface } from './preview-elevation';
import {
  minimapSquareTownCenterPolygon,
  minimapSquareClassifier,
  minimapSquareColor,
  minimapSquareDrawLayer,
  minimapSquareGaiaObjectColors,
  minimapSquarePolygon,
  minimapSquareSide,
  minimapSquareTownCenterBorderColor,
  nextPreviewObjectsMode,
  previewMinimapSquareSizeLaws,
  previewMinimapSquareSizes,
  type MinimapSquareClass,
  type PreviewObjectsMode,
} from './minimap-squares';
import {
  RaisedColorTerrainLayer,
  RaisedTerrainUniforms,
  RaisedTileGrid,
  ShownRaisedHighlight,
  raisedDepthBiasStep,
  raisedViewRect,
} from './preview-raised-terrain';
import {
  raisedBoundaryLoop,
  raisedRoundedRectangleOutline,
  raisedRoundedTileFill,
  raisedTileFill,
} from './preview-raised-overlays';
import { useAppPictureViewBridge } from './app-pictures';
import type { AppPictureView } from '../shared/connector-picture-api';
import {
  finalPictureReady,
  gameTexturesLiveStages,
  generationBlurShown,
  keepLastLiveStage,
  lookPendingDelayMilliseconds,
  liveStageLook,
  shownPicture,
  type ShownPicture,
  type ShownRaisedPicture,
} from './preview-shown-picture';
import { destroyPixiTree, trackRenderGroupBatchers } from './pixi-destroy';
import { holdPixiSystemTicker } from './pixi-system-ticker';

const previewPadding = 28;
const noHighlightTiles: readonly number[] = [];
const narrowPreviewWidth = 380;
type PreviewPointerGesture =
  ({ kind: 'selection' } & PreviewSelectionDrag) | ({ kind: 'pan' } & PreviewPanDrag);

interface DiagnosticOverlays {
  cliffs: boolean;
  connectionTerrain: boolean;
  connections: ConnectionOverlayMode;
  helpers: boolean;
  objects: PreviewObjectsMode;
}

const initialOverlays: DiagnosticOverlays = {
  cliffs: true,
  connectionTerrain: true,
  connections: 'off',
  helpers: false,
  objects: 'markers',
};

const objectsModeButtons = [
  {
    key: 'markers',
    labelId: 'preview-panel.tool.objects',
    renderIcon: (ref: Ref<AnimatedIconHandle>) => (
      <BoxesIcon aria-hidden="true" ref={ref} size={14} />
    ),
  },
  {
    key: 'minimap',
    labelId: 'preview-panel.tool.objects.minimap',
    renderIcon: (ref: Ref<AnimatedIconHandle>) => (
      <MonitorIcon aria-hidden="true" ref={ref} size={14} />
    ),
  },
  {
    key: 'off',
    labelId: 'preview-panel.tool.objects.off',
    renderIcon: (ref: Ref<AnimatedIconHandle>) => (
      <EyeOffIcon aria-hidden="true" ref={ref} size={14} />
    ),
  },
] as const;

const overlayButtons = [
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
    key: 'raised',
    labelId: 'preview-panel.tool.elevation.raised',
    renderIcon: (ref: Ref<AnimatedIconHandle>) => (
      <BoxIcon aria-hidden="true" ref={ref} size={14} />
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
  renderIcon: (ref: Ref<AnimatedIconHandle>) => (
    <HoverScaleIcon ref={ref}>
      <Grid3x3 aria-hidden="true" size={14} />
    </HoverScaleIcon>
  ),
} as const;

const smallTreesButton = {
  key: 'smallTrees',
  labelId: 'preview-panel.tool.small-trees',
  renderIcon: (ref: Ref<AnimatedIconHandle>) => (
    <HoverScaleIcon ref={ref}>
      <TreePine aria-hidden="true" size={14} />
    </HoverScaleIcon>
  ),
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
    <Tooltip {...previewToolTooltipRoot}>
      <TooltipTrigger
        {...previewToolTooltipTrigger}
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
    <Tooltip {...previewToolTooltipRoot}>
      <TooltipTrigger
        {...previewToolTooltipTrigger}
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

function PreviewObjectsModeButton({
  mode,
  onCycle,
}: {
  mode: PreviewObjectsMode;
  onCycle(): void;
}) {
  const { t } = useI18n();
  const { animationHandlers, iconRef } = useAnimatedIconHover();
  const current = objectsModeButtons.find(({ key }) => key === mode)!;
  const label = t(current.labelId);
  const note = mode === 'minimap' ? t('preview-panel.tool.objects.minimap.note') : null;
  return (
    <Tooltip {...previewToolTooltipRoot}>
      <TooltipTrigger
        {...previewToolTooltipTrigger}
        render={
          <Button
            {...animationHandlers}
            aria-description={note ?? undefined}
            aria-label={label}
            className="preview-map-tool preview-objects-mode-button"
            data-mode={mode}
            onClick={onCycle}
            size="icon-compact"
            variant="secondary"
          />
        }
      >
        {current.renderIcon(iconRef)}
      </TooltipTrigger>
      <TooltipContent>
        <span className="preview-map-tool-tooltip" data-testid="objects-mode-tooltip">
          <span>{label}</span>
          {note ? <span className="preview-map-tool-tooltip-note">{note}</span> : null}
        </span>
      </TooltipContent>
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
      <Tooltip {...previewToolTooltipRoot}>
        <TooltipTrigger
          {...previewToolTooltipTrigger}
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
      <Tooltip {...previewToolTooltipRoot}>
        <TooltipTrigger
          {...previewToolTooltipTrigger}
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
              focusableWhenDisabled={pending || locked}
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
    <Tooltip {...previewToolTooltipRoot}>
      <TooltipTrigger
        {...previewToolTooltipTrigger}
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

export const wheelBurstSettleMs = 150;

interface CameraAnimation extends CameraTransition {
  wheel: boolean;
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
  sceneKey: string;
  minimapPalette: SelectedMinimapPalette | null;
  scene: TopDownScene;
  terrainColorSources: TerrainColorSources;
  lookTerrainColors: ReadonlyMap<number, number> | undefined;
  terrainIds: readonly number[];
  terrainSource: BufferImageSource | null;
  gameArtTerrain: {
    view: GameArtTerrainView;
    layer: GameArtTerrainPicture;
    raised?: GameArtPictureRaised | null;
  } | null;
  gameArtSprites: { view: GameArtSpriteView; layer: GameArtSpriteLayer } | null;
  gameArtStore: { bytes: number } | null;
  gameArtCliffs: { view: GameArtCliffView; layer: GameArtCliffBandLayer } | null;
  gameArtPresentation: GameArtPresentationState;
  tileGrid: TileGridLayer | RaisedTileGrid | null;
  raised: RaisedTerrainState | null;
}

interface RaisedTerrainState {
  surface: ElevationSurface;
  uniforms: RaisedTerrainUniforms;
  layer: RaisedColorTerrainLayer | null;
  texels: Uint8Array | null;
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
  const renderScheduler = useRef<PreviewRenderScheduler | null>(null);
  const mapTransitions = useRef<PreviewMapTransitions | null>(null);
  const shownTransitionPicture = useRef<TransitionPicture | null>(null);
  const liveStageEndedAt = useRef<number | null>(null);
  const liveStageHold = useRef<LiveStageHold>('none');
  const [, setLiveStageHoldRevision] = useState(0);
  const stageMorphTerrain = useRef<Container | null>(null);
  const builtMapLayer = useRef<(BuiltMapLayer & { key: PreviewCamera }) | null>(null);
  const gesture = useRef<PreviewPointerGesture | null>(null);
  const followSelectionDragCamera = useRef<() => PreviewSelection | null>(() => null);
  const selectionOutline = useRef<Graphics | null>(null);
  const sourceHighlightOutline = useRef<Graphics | null>(null);
  const legendHoverOutline = useRef<Graphics | null>(null);
  const legendHoverTileIndices = useRef<readonly number[]>([]);
  const captureLayers = useRef<{
    outline: Container;
    selection: Graphics;
    others: readonly Container[];
  } | null>(null);
  const rightPress = useRef<RightPress | null>(null);
  const openImageMenu = useRef<(point: { x: number; y: number }) => void>(() => {});
  const overlayFades = usePreviewOverlayFades(renderScheduler, host);
  const selectionEaseRedraw = useRef<() => void>(() => {});
  const [selectionEase] = useState(
    () =>
      new SelectionEase({
        timeConstant: () =>
          motionDuration('--motion-duration-selection-follow', selectionFollowFallbackMilliseconds),
        redraw: () => selectionEaseRedraw.current(),
      }),
  );
  useEffect(() => () => selectionEase.destroy(), [selectionEase]);
  const shownPictureNow = useRef<() => ShownPicture>(() => ({ source: 'none', raised: null }));
  const shownRaisedSurface = useRef<() => ElevationSurface | null>(() => null);
  const followedSurface = useRef<ElevationSurface | null | undefined>(undefined);
  const keptLiveStage = useRef<PreviewCandidateLayer | null>(null);
  const followShownPicture = useRef<() => boolean>(() => false);
  const releaseKeptLiveStage = useRef<() => boolean>(() => false);
  const sceneBuilding = useRef(false);
  const liveStageRun = useRef<{
    layer: PreviewCandidateLayer;
    startMap: PreviewGenerationResult | null;
  } | null>(null);
  const keepLiveStageAtEnd = useRef(false);
  const mapBoundary = useRef<MapBoundaryElements>({
    arc: null,
    border: null,
    frame: null,
    outline: null,
    strokeWidth: 4,
    shown: false,
    marginFraction: 0,
    surface: () => null,
  });
  const selectionDimensions = useRef<string | null>(null);
  const terrainChunkCache = useRef<TerrainChunkCache | null>(null);
  const keptTerrainCache = useRef<TerrainChunkCache | null>(null);
  const candidateLayer = useRef<PreviewCandidateLayer | null>(null);
  const stashedCamera = useRef<{
    dimensions: string;
    camera: PreviewCamera;
    fitted: boolean;
  } | null>(null);
  const previousCommittedDimensions = useRef<string | null>(null);
  const renderedMapLayer = useRef<Container | null>(null);
  const mapLayerAwaitsSprites = useRef(false);
  const renderedCamera = useRef<PreviewCamera>(fitPreviewCamera(1, 1));
  const displayedCamera = useRef<PreviewCamera>(fitPreviewCamera(1, 1));
  const cameraIsFitted = useRef(true);
  const pendingCamera = useRef<PreviewCamera | null>(null);
  const layoutSwitchPlan = useRef<
    (PreviewLayoutSwitchPlan & { committed: boolean; expiresAt: number }) | null
  >(null);
  const staleLayerCamera = useRef<{ camera: PreviewCamera; viewport: PreviewViewport } | null>(
    null,
  );
  const switchRestore = useRef<PreviewSwitchRestore | null>(null);
  const frozenCanvasTransform = useRef<
    ((size: PreviewCanvasSize) => PreviewScreenTransform | null) | null
  >(null);
  const refreshFrozenCanvas = useRef<(() => void) | null>(null);
  const sceneBuilds = useRef(0);
  const cameraAnimation = useRef<CameraAnimation | null>(null);
  const cameraAnimationFrame = useRef<number | null>(null);
  const wheelCommitTimer = useRef<number | null>(null);
  const previousMapDimensions = useRef<string | null>(null);
  const outgoingSizeCamera = useRef<PreviewCamera | null>(null);
  const keyboardInput = useRef<{
    fit(): void;
    pan(direction: { screenX: number; screenY: number }): void;
    scene: TopDownScene | null;
    selection: PreviewSelection | null;
    zoom(factor: number): void;
  }>({ fit() {}, pan() {}, scene: null, selection: null, zoom() {} });
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
  const [chosenElevationMode, setElevationMode] = useState<ElevationDisplayMode>('raised');
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
    previewSmallTrees,
    setPreviewSmallTrees,
    gpuMapRendering,
    previewMapOrigin,
    mapTestPreviewShown,
    mapTransitions: mapTransitionsSetting,
  } = useAppPanelContext();
  const mapTransitionsSettingRef = useRef(mapTransitionsSetting);
  mapTransitionsSettingRef.current = mapTransitionsSetting;
  useEffect(() => {
    if (mapTransitions.current) mapTransitions.current.enabled = mapTransitionsSetting;
  }, [mapTransitionsSetting]);
  const drawnLook = mapTestPreviewLook(previewLook, mapTestPreviewShown);
  const [gpuUnavailable, setGpuUnavailable] = useState<GpuMapUnavailableReason | null>(null);
  const mapRenderer = chooseMapRenderer(gpuMapRendering, gpuUnavailable);
  const [gpuProbe] = useState(() =>
    lazyGpuMapProbe((renderer: object) => probeGpuMapRendering(renderer as never)),
  );
  const [raisedProbe] = useState(() =>
    lazyGpuMapProbe((renderer: object) => probeRaisedTerrain(renderer as never)),
  );
  const projectionMode = perspectiveProjection(previewPerspective);
  const shownElevationMode = shownElevationDisplayMode(
    chosenElevationMode,
    projectionMode === 'minimap',
  );
  const raisedChosen = shownElevationMode === 'raised';
  const elevationMode = flatElevationMode(shownElevationMode);
  const appPictureView = useRef<() => AppPictureView>(() => ({ shown: false }));
  appPictureView.current = () => {
    if (!map || typeof map.requestHash !== 'string') return { shown: false };
    const shownViewport = viewportRef.current;
    const shownCamera = displayedCamera.current;
    return {
      shown: true,
      requestHash: map.requestHash,
      look: drawnLook,
      perspective: previewPerspective,
      relief: shownElevationMode,
      objects: overlays.objects,
      camera: {
        centerX: shownCamera.centerX,
        centerY: shownCamera.centerY,
        zoom: shownCamera.zoom,
      },
      viewport: {
        width: previewVisibleWidth(shownViewport),
        height: shownViewport.height,
        padding: shownViewport.padding,
      },
      mapTest: mapTestPreviewShown,
    };
  };
  useAppPictureViewBridge(appPictureView);
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
  const [shownSurface, setShownSurface] = useState<ElevationSurface | null>(null);
  const [liveStageKept, setLiveStageKept] = useState(false);
  const latestMap = useRef(map);
  latestMap.current = map;
  const generationActivity = useSyncExternalStore(
    previewCandidates.subscribeActivity,
    previewCandidates.getActivity,
  );
  const generationActive = generationActivity !== null;
  const boundaryMotion = useBoundaryMotion(generationActive);
  useOverlayPointerHover(host);
  useReadoutLabelGlide(host);
  useCanvasKeyboardFocus(host);
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
    () => ({ helperObjectIds, helpers: overlays.helpers, objects: overlays.objects !== 'off' }),
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
    objectsShown: overlays.objects === 'markers',
    minimapColor: gameArtMinimapColor,
    objectName: gameArtObjectName,
    appendOutput,
  });
  liveStageHold.current = nextLiveStageHold(liveStageHold.current, {
    candidateActive,
    enabled: mapTransitionsSetting,
    reducedMotion: prefersReducedMotion(),
    colourMapShown: map !== null && scene !== null && !gameArt.expected,
    stagesShown: !gameArt.expected || gameTexturesLiveStages(gameArt.expected, generationActivity),
  });
  const liveStageHeld = liveStageHold.current === 'holding';
  const candidateShown = candidateActive && !liveStageHeld;
  const outdatedMapShown = generationActive && !candidateShown;
  const candidateCoversScene =
    candidateScene !== null &&
    !liveStageHeld &&
    (!scene || scene.width !== candidateScene.width || scene.height !== candidateScene.height);
  const viewScene = candidateCoversScene ? candidateScene : scene;
  const viewAvailable = viewScene !== null;
  const gameArtTerrainView = candidateCoversScene ? null : gameArt.terrain;
  const gameArtSpriteView =
    candidateCoversScene || previewPerspective !== 'diamond' ? null : gameArt.sprites;
  const gameArtCliffBandView =
    candidateCoversScene || previewPerspective !== 'top-down' ? null : gameArt.cliffs;
  const gameArtStore = gameArt.store;
  const gameArtExpected = gameArt.expected;
  const gameArtLiveStages = gameTexturesLiveStages(gameArtExpected, generationActivity);
  const candidateLayerShown = !gameArtExpected || gameArtLiveStages;
  const candidateLayerShownRef = useRef(candidateLayerShown);
  candidateLayerShownRef.current = candidateLayerShown;
  shownPictureNow.current = () => {
    const live = candidateLayer.current;
    const kept = keptLiveStage.current;
    const cache = terrainChunkCache.current;
    const standIn = cache ? gameArtStandIn(cache) : null;
    return shownPicture({
      live: live && live.container.visible ? { raised: candidateShownRaised(live) } : null,
      kept: kept ? { raised: candidateShownRaised(kept) } : null,
      standIn: standIn ? { raised: standInShownRaised(standIn.raised) } : null,
      map: cache ? { raised: committedShownRaised(cache) } : null,
    });
  };
  shownRaisedSurface.current = () => shownPictureNow.current().raised?.surface ?? null;
  mapBoundary.current.surface = () => shownRaisedSurface.current();
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
  const [gameArtMarkerRedraws, setGameArtMarkerRedraws] = useState(0);
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
  const colourLayerColors: TextureLookColors | null =
    previewColourLayerLook(shownLook) === 'texture-colors' &&
    !candidateCoversScene &&
    map?.texturePalette
      ? textureLookColors(map.texturePalette)
      : null;
  const textureColorsShown: TextureLookColors | null =
    flatLook === 'texture-colors' ? colourLayerColors : null;
  const gameTexturesShown = gameArt.active && !gameArtPending;
  const shownColourColors: TextureLookColors | null =
    textureColorsShown ?? (gameArtExpected && !gameTexturesShown ? colourLayerColors : null);
  const lookPending = gameArtPending;
  const lookPendingShown = useDelayedFlag(lookPending, lookPendingDelayMilliseconds);
  const minimapObjectsShown = overlays.objects === 'minimap';
  const cliffLook: PreviewLook = gameTexturesShown
    ? 'game-textures'
    : shownColourColors
      ? 'texture-colors'
      : 'minimap';
  const markerObjectColors = candidateCoversScene
    ? undefined
    : lookMarkerObjectColors(cliffLook, map?.texturePalette);
  const minimapObjectsLegendColors = useMemo(
    () =>
      minimapObjectsShown && !candidateCoversScene && scene
        ? minimapSquareGaiaObjectColors(
            scene.objects,
            minimapSquareClassifier({
              artObjects: map?.mapIconArtObjects,
              minimapPalette: map?.minimapPalette ?? null,
              helperObjectIds: objectVisibility.helperObjectIds,
            }),
          )
        : undefined,
    [candidateCoversScene, map, minimapObjectsShown, objectVisibility.helperObjectIds, scene],
  );
  const legendObjectColors = minimapObjectsLegendColors ?? markerObjectColors;
  const gameTexturesTerrainColors =
    cliffLook === 'game-textures' ? colourLayerColors?.terrains : undefined;
  const legendMap = useMemo(
    () =>
      presentedMap
        ? {
            ...presentedMap,
            look: cliffLook,
            ...(shownColourColors
              ? {
                  lookColors: minimapObjectsLegendColors
                    ? { ...shownColourColors, gaiaObjects: minimapObjectsLegendColors }
                    : shownColourColors,
                }
              : legendObjectColors || gameTexturesTerrainColors
                ? {
                    lookColors: {
                      terrains: gameTexturesTerrainColors ?? new Map<number, number>(),
                      gaiaObjects: legendObjectColors ?? new Map<number, number>(),
                      cliffs: new Map<number, number>(),
                    },
                  }
                : {}),
          }
        : presentedMap,
    [
      cliffLook,
      gameTexturesTerrainColors,
      legendObjectColors,
      minimapObjectsLegendColors,
      presentedMap,
      shownColourColors,
    ],
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
  const displaySelection = candidateShown
    ? selectionFitsCandidate(selection, candidateWidth, candidateHeight)
      ? selection
      : null
    : selection;
  const displaySelectionNow = useRef(displaySelection);
  displaySelectionNow.current = displaySelection;
  const codeHighlightTiles = useRef<readonly number[]>(sourceHighlightTileIndices);
  codeHighlightTiles.current = sourceHighlightTileIndices;
  const sourceHighlightTiles = useRef<readonly number[]>(sourceHighlightTileIndices);
  const legendListsCode = useRef(false);
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
        previewCanvasLabel(projectionPerspective(projectionMode), cliffLook),
      );
      canvas.setAttribute(
        'aria-roledescription',
        translate('preview-panel.canvas.role-description'),
      );
    }
  }, [cliffLook, projectionMode, pixiReady, translator]);

  const stopCameraAnimation = useCallback(() => {
    if (cameraAnimationFrame.current !== null) {
      window.cancelAnimationFrame(cameraAnimationFrame.current);
      cameraAnimationFrame.current = null;
    }
    if (wheelCommitTimer.current !== null) {
      window.clearTimeout(wheelCommitTimer.current);
      wheelCommitTimer.current = null;
    }
    cameraAnimation.current = null;
    const container = host.current;
    if (container) {
      delete container.dataset.cameraAnimation;
      delete container.dataset.cameraCommit;
    }
  }, []);

  const applyDisplayedCamera = useCallback(
    (next: PreviewCamera) => {
      if (!viewScene) return;
      displayedCamera.current = next;
      const terrainCache = terrainChunkCache.current;
      const container = host.current;
      if (terrainCache) transformTerrainLayer(terrainCache.container, next, viewScene, viewport);
      candidateLayer.current?.transform(next, viewport, viewScene);
      keptLiveStage.current?.transform(next, viewport, viewScene);
      const layer = renderedMapLayer.current;
      if (layer) transformMapLayer(layer, renderedCamera.current, next, viewScene, viewport);
      const dragSelection = followSelectionDragCamera.current();
      drawPreviewOutlines(
        selectionOutline.current,
        sourceHighlightOutline.current,
        legendHoverOutline.current,
        mapBoundary.current,
        viewScene,
        next,
        viewport,
        dragSelection ?? displaySelectionNow.current,
        sourceHighlightTiles.current,
        legendHoverTileIndices.current,
      );
      if (container) {
        setCameraDataset(container, viewScene, next, viewport);
        container.dataset.outlineCameraZoom = next.zoom.toFixed(4);
      }
    },
    [viewScene, viewport],
  );

  const commitCameraTransition = useCallback(() => {
    const next = displayedCamera.current;
    if (cameraAnimation.current?.settle) return next;
    stopCameraAnimation();
    pendingCamera.current = null;
    return next;
  }, [stopCameraAnimation]);

  const scheduleCameraTransition = useCallback(
    (next: PreviewCamera, wheel = false, anchor?: { x: number; y: number }, pan = false) => {
      if (!viewScene) return;
      const transition = cameraTransitionTo(
        displayedCamera.current,
        performance.now(),
        next,
        anchor,
        viewScene.width,
        viewScene.height,
        viewport,
        pan,
      );
      pendingCamera.current = transition.target;
      const container = host.current;
      if (container) container.dataset.cameraAnimation = 'ease-out';
      const terrainCache = terrainChunkCache.current;
      if (terrainCache) {
        updateTerrainChunkVisibility(
          terrainCache,
          [displayedCamera.current, next, transition.target],
          viewport,
          container,
        );
      }
      const reduceMotion = globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;
      cameraAnimation.current = { ...transition, wheel };
      if (wheelCommitTimer.current !== null) {
        window.clearTimeout(wheelCommitTimer.current);
        wheelCommitTimer.current = null;
      }
      const animate = (now: number) => {
        const active = cameraAnimation.current;
        if (!active) return;
        const pan = gesture.current?.kind === 'pan' ? gesture.current : null;
        const anchor = active.settle ? undefined : (pan?.pointer ?? active.anchor);
        const frame = cameraTransitionFrame(
          active,
          now,
          displayedCamera.current,
          anchor,
          reduceMotion,
          viewScene.width,
          viewScene.height,
          viewport,
        );
        if (anchor) {
          active.target = frame.target;
          pendingCamera.current = frame.target;
        }
        applyDisplayedCamera(frame.camera);
        if (!frame.done) {
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
        if (!active.wheel) {
          if (gesture.current?.kind !== 'pan') setCamera(active.target);
          return;
        }
        if (container) container.dataset.cameraCommit = 'deferred';
        wheelCommitTimer.current = window.setTimeout(() => {
          wheelCommitTimer.current = null;
          if (container) delete container.dataset.cameraCommit;
          if (cameraAnimation.current || gesture.current?.kind === 'pan') return;
          setCamera(displayedCamera.current);
        }, wheelBurstSettleMs);
      };
      if (cameraAnimationFrame.current !== null) {
        window.cancelAnimationFrame(cameraAnimationFrame.current);
      }
      cameraAnimationFrame.current = window.requestAnimationFrame(animate);
    },
    [applyDisplayedCamera, viewScene, viewport],
  );

  const fit = useCallback(() => {
    if (!viewScene) return;
    cameraIsFitted.current = true;
    scheduleCameraTransition(fitPreviewCamera(viewScene.width, viewScene.height));
  }, [viewScene, scheduleCameraTransition]);

  const zoom = useCallback(
    (factor: number, anchor = previewViewCenter(viewport), wheel = false) => {
      if (!viewScene) return;
      if (wheel) {
        const shown = displayedCamera.current;
        const base = pendingCamera.current ?? shown;
        const target = zoomTransitionTarget(
          shown,
          base,
          factor,
          anchor,
          viewScene.width,
          viewScene.height,
          viewport,
        );
        if (!zoomStepStartsTransition(base, target, viewScene.width, viewScene.height, viewport)) {
          return;
        }
        cameraIsFitted.current = false;
        scheduleCameraTransition(target, true, anchor);
        return;
      }
      const base = pendingCamera.current ?? displayedCamera.current;
      const target = zoomPreviewCamera(
        base,
        factor,
        anchor,
        viewScene.width,
        viewScene.height,
        viewport,
      );
      if (
        cameraAnimation.current?.settle &&
        !zoomStepStartsTransition(base, target, viewScene.width, viewScene.height, viewport)
      ) {
        return;
      }
      cameraIsFitted.current = false;
      scheduleCameraTransition(target);
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
        false,
        undefined,
        true,
      );
    },
    [viewScene, scheduleCameraTransition, viewport],
  );
  keyboardInput.current = { fit, pan, scene: viewScene, selection, zoom };

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

  const cameraViewport = useRef(viewport);
  useLayoutEffect(() => {
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
    let restoresSwitch = false;
    const switchPlan = layoutSwitchPlan.current;
    const restored =
      !dimensionsChanged && transitionTarget === null && !previewViewportIsCollapsed(viewport)
        ? previewSwitchRestoreCamera(
            viewScene,
            switchRestore.current,
            displayedCamera.current,
            viewport,
          )
        : null;
    const adoptsSwitch =
      !dimensionsChanged &&
      switchPlan !== null &&
      !switchPlan.committed &&
      previewLayoutSwitchSettles(switchPlan.settled, viewport);
    if (adoptsSwitch) {
      switchPlan.committed = true;
      const built = builtMapLayer.current;
      if (built) {
        const stale = staleLayerCamera.current;
        staleLayerCamera.current = {
          camera:
            stale && stale.viewport === built.viewport ? stale.camera : displayedCamera.current,
          viewport: built.viewport,
        };
      }
      const before = transitionTarget ?? displayedCamera.current;
      const fittedBefore = cameraIsFitted.current;
      const laidOutBefore = cameraViewport.current;
      cameraIsFitted.current = switchPlan.fitted;
      nextCamera = previewLayoutSwitchCamera(viewScene, switchPlan, viewport);
      cameraViewport.current = viewport;
      switchRestore.current = {
        before,
        fitted: fittedBefore,
        viewport: laidOutBefore,
        after: nextCamera,
        behindEditor: !(viewport.behindEditor ?? false),
      };
    } else if (restored) {
      switchRestore.current = {
        before: displayedCamera.current,
        fitted: cameraIsFitted.current,
        viewport: cameraViewport.current,
        after: restored.camera,
        behindEditor: !(viewport.behindEditor ?? false),
      };
      restoresSwitch = true;
      cameraIsFitted.current = restored.fitted;
      nextCamera = restored.camera;
      cameraViewport.current = viewport;
    } else if (!dimensionsChanged && previewViewportIsCollapsed(viewport)) {
      nextCamera = transitionTarget ?? displayedCamera.current;
    } else if (
      !dimensionsChanged &&
      !(switchPlan && !switchPlan.committed) &&
      !previewViewportIsCollapsed(cameraViewport.current) &&
      (cameraViewport.current.behindEditor ?? false) !== (viewport.behindEditor ?? false)
    ) {
      const laidOut = cameraViewport.current;
      const kept = transitionTarget ?? displayedCamera.current;
      nextCamera = cameraIsFitted.current
        ? fitPreviewCamera(viewScene.width, viewScene.height)
        : clampPreviewCamera(
            previewCameraForCentre(
              clampPreviewCamera(kept, viewScene.width, viewScene.height, viewport),
              viewScene.width,
              viewScene.height,
              laidOut,
              viewport,
            ),
            viewScene.width,
            viewScene.height,
            viewport,
          );
      cameraViewport.current = viewport;
      switchRestore.current = {
        before: kept,
        fitted: cameraIsFitted.current,
        viewport: laidOut,
        after: nextCamera,
        behindEditor: laidOut.behindEditor ?? false,
      };
    } else if (!dimensionsChanged) {
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
    outgoingSizeCamera.current =
      (dimensionsChanged || adoptsSwitch || restoresSwitch) &&
      !samePreviewCamera(camera, nextCamera)
        ? camera
        : null;
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
    if (previewViewportIsCollapsed(viewport)) return;
    const laidOut = cameraViewport.current;
    cameraViewport.current = viewport;
    const clampedCamera = cameraIsFitted.current
      ? fitPreviewCamera(viewScene.width, viewScene.height)
      : clampPreviewCamera(
          previewCameraForCentre(
            transitionTarget ?? displayedCamera.current,
            viewScene.width,
            viewScene.height,
            laidOut,
            viewport,
          ),
          viewScene.width,
          viewScene.height,
          viewport,
        );
    pendingCamera.current = null;
    displayedCamera.current = clampedCamera;
    setCamera((current) => (samePreviewCamera(current, clampedCamera) ? current : clampedCamera));
  }, [viewScene?.height, viewScene?.width, stopCameraAnimation, viewport]);

  useEffect(() => () => stopCameraAnimation(), [stopCameraAnimation]);

  useLayoutEffect(() => {
    const container = host.current;
    const section = container?.closest<HTMLElement>('.preview-panel');
    if (!container || !section) return undefined;
    const publish = () => {
      const { insetLeft, insetRight } = previewEditorInsets(
        container,
        Math.max(1, container.clientWidth),
      );
      section.style.setProperty('--preview-inset-left', `${insetLeft}px`);
      section.style.setProperty('--preview-inset-right', `${insetRight}px`);
      const behind = insetLeft > 0 ? 'left' : insetRight > 0 ? 'right' : null;
      if (behind) section.dataset.behindEditor = behind;
      else delete section.dataset.behindEditor;
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(container);
    const editorRegion = workspaceEditorRegion(container);
    if (editorRegion) observer.observe(editorRegion);
    const region = container.closest<HTMLElement>('.workspace-preview-region');
    const layoutObserver = new MutationObserver(publish);
    if (region) {
      layoutObserver.observe(region, {
        attributeFilter: ['data-layout', 'data-layout-from', 'data-expanded'],
        attributes: true,
      });
    }
    return () => {
      observer.disconnect();
      layoutObserver.disconnect();
      section.style.removeProperty('--preview-inset-left');
      section.style.removeProperty('--preview-inset-right');
      delete section.dataset.behindEditor;
    };
  }, []);

  useEffect(() => {
    const container = host.current;
    if (!container || !viewAvailable) return undefined;
    const pixi = new Application();
    const systemTicker = holdPixiSystemTicker();
    let disposed = false;
    let initialized = false;
    let stopContextWatch: (() => void) | null = null;
    let stopBatcherTracking: (() => void) | null = null;
    setPixiReady(false);
    const initialWidth = Math.max(1, container.clientWidth);
    const initialHeight = Math.max(1, container.clientHeight);
    let scheduler: PreviewRenderScheduler | null = null;
    let transitions: PreviewMapTransitions | null = null;
    let blankTerrainFrames = 0;
    let uncoveredMarkerFrames = 0;
    void pixi
      .init({
        antialias: false,
        autoStart: false,
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
        stopBatcherTracking = trackRenderGroupBatchers(pixi.renderer);
        scheduler = new PreviewRenderScheduler(
          () => {
            if (layoutGlide && frozenSize === null) {
              const width = Math.max(1, container.clientWidth);
              const height = Math.max(1, container.clientHeight);
              if (
                Math.abs(pixi.renderer.screen.width - width) >= 0.5 ||
                Math.abs(pixi.renderer.screen.height - height) >= 0.5
              ) {
                pixi.renderer.resize(width, height);
              }
            }
            const screen = pixi.renderer.screen;
            const unrevealed = layoutGlide
              ? previewUnrevealedInsets(container, screen.width)
              : noPreviewInsets;
            if (layoutGlide) {
              if (unrevealed.insetLeft > 0 || unrevealed.insetRight > 0) glideRevealed = true;
              else if (glideRevealed || !previewLayoutSwitching(region)) layoutGlide = false;
            }
            const behindEditor = previewLaidOutBehindEditor(container);
            const focus = behindEditor
              ? previewFocusInsets(container, screen.width, true)
              : previewRegionShowsPreview(container)
                ? noPreviewFocus
                : laidOutPreviewFocus(viewportRef.current);
            shownFocus = focus;
            drawnRegionReach = behindEditor || layoutGlide ? previewRegionReach(container) : 0;
            const size: PreviewCanvasSize = {
              width: screen.width,
              height: screen.height,
              ...unrevealed,
              behindEditor,
              ...focus,
            };
            const built = builtMapLayer.current;
            const stale = staleLayerCamera.current;
            const staleLayers =
              stale !== null && built !== null && stale.viewport === built.viewport;
            if (!staleLayers) staleLayerCamera.current = null;
            const drawnCamera = staleLayers ? stale.camera : displayedCamera.current;
            let plan = layoutSwitchPlan.current;
            if (plan && (plan.committed ? !layoutGlide : performance.now() > plan.expiresAt)) {
              layoutSwitchPlan.current = null;
              plan = null;
            }
            let anchor: PreviewScreenTransform | null;
            if (plan && built && !previewViewportIsCollapsed(built.viewport)) {
              const shownViewport = { ...built.viewport, ...size };
              const switchCamera = !plan.committed
                ? layoutGlide
                  ? plan.target
                  : previewLayoutSwitchCamera(built.scene, plan, shownViewport)
                : cameraIsFitted.current
                  ? fitPreviewCamera(built.scene.width, built.scene.height)
                  : displayedCamera.current;
              const drawn = { camera: drawnCamera, viewport: built.viewport };
              anchor = layoutGlide
                ? previewLayoutSwitchAnchor(
                    built.scene,
                    drawn,
                    switchCamera,
                    plan,
                    previewLayoutSwitchShare(container, region),
                  )
                : previewScreenTransform(
                    built.scene.width,
                    built.scene.height,
                    drawnCamera,
                    built.viewport,
                    switchCamera,
                    shownViewport,
                  );
            } else {
              anchor = previewResizeAnchor(
                built,
                displayedCamera.current,
                cameraIsFitted.current,
                size,
                staleLayers ? { drawnCamera, laidOut: viewportRef.current } : {},
              );
            }
            applyPreviewResizeAnchor(pixi.stage, anchor, container);
            systemTicker.advance();
            pixi.render();
            if (frozenSize !== null) showFrozenCanvas();
          },
          {
            verify: () => container.dataset.previewFrameCheck === 'on',
            frameHash: () => previewFrameHash(pixi),
            onFrame: (current) => {
              container.dataset.previewRenders = String(current.statistics.renders);
              container.dataset.previewFrameChecks = String(current.statistics.checks);
              container.dataset.previewStaleFrames = String(current.statistics.staleFrames);
              if (container.dataset.previewFrameBounds !== undefined) {
                container.dataset.previewFrameBounds = previewFrameBounds(pixi);
              }
              const markerLayer = renderedMapLayer.current;
              const markers = markerLayer ? markerCoverages.get(markerLayer) : undefined;
              if (
                markers &&
                markerLayer?.visible &&
                markers.viewport === viewportRef.current &&
                !markers.coverage.covers(displayedCamera.current)
              ) {
                uncoveredMarkerFrames += 1;
                container.dataset.markerUncoveredFrames = String(uncoveredMarkerFrames);
              }
              const framedCache = terrainChunkCache.current;
              const framed = framedCache ? framedGameArtTerrain(framedCache) : 'none';
              container.dataset.framedTerrain = framed;
              container.dataset.framedBlur = String(
                container.querySelector('[data-testid="preview-generation-blur"]') !== null,
              );
              if (framed === 'none' && framedCache && framedCache.scene.terrainIds.length > 0) {
                blankTerrainFrames += 1;
                container.dataset.blankTerrainFrames = String(blankTerrainFrames);
              }
            },
          },
        );
        attachPreviewRenderScheduler(pixi.stage, scheduler);
        renderScheduler.current = scheduler;
        transitions = new PreviewMapTransitions({
          host: container,
          application: () => application.current,
          scheduler: () => renderScheduler.current,
          mapLayer: () => renderedMapLayer.current,
        });
        transitions.enabled = mapTransitionsSettingRef.current;
        mapTransitions.current = transitions;
        const size = measureSize();
        pixi.renderer.resize(size.width, size.height);
        scheduler.request();
        requestedSize = size;
        setViewport((current) => ({
          ...size,
          padding: previewPadding,
          projection: current.projection,
        }));
        setPixiReady(true);
      });
    let viewportCommits = 0;
    let requestedSize: PreviewCanvasSize | null = null;
    const measureSize = (): PreviewCanvasSize => {
      const width = Math.max(1, container.clientWidth);
      const behindEditor = previewLaidOutBehindEditor(container);
      return {
        width,
        height: Math.max(1, container.clientHeight),
        behindEditor,
        ...(behindEditor ? previewFocusInsets(container, width, false) : noPreviewFocus),
      };
    };
    const measureMotionSize = (): PreviewCanvasSize => {
      const width = Math.max(1, container.clientWidth);
      const behindEditor = previewLaidOutBehindEditor(container);
      return {
        width,
        height: Math.max(1, container.clientHeight),
        behindEditor,
        ...(behindEditor
          ? previewFocusInsets(container, width, true)
          : previewMotionFocus(
              previewEditorInsets(container, width),
              previewFocusShownShare(viewportRef.current),
            )),
      };
    };
    let shownFocus: ReturnType<typeof previewFocusInsets> = noPreviewFocus;
    const region = container.closest<HTMLElement>('.workspace-preview-region');
    let layoutGlide = false;
    let glideRevealed = false;
    let glideFrame: number | null = null;
    let drawnRegionReach = previewRegionReach(container);
    let seenLayout = region?.dataset.layout;
    let planExpiry: number | null = null;
    const planLayoutSwitch = () => {
      const layout = region?.dataset.layout;
      const from = seenLayout;
      seenLayout = layout;
      if (
        layout === from ||
        !isPreviewLayout(layout) ||
        !isPreviewLayout(from) ||
        !previewLayoutSwitchGlides(layout, from)
      ) {
        return;
      }
      layoutSwitchPlan.current = null;
      const built = builtMapLayer.current;
      if (!initialized || disposed || !built || previewViewportIsCollapsed(built.viewport)) return;
      const reach = previewRegionReach(container);
      if (
        (cameraViewport.current.behindEditor ?? false) === previewLaidOutBehindEditor(container)
      ) {
        drawnRegionReach = reach;
        return;
      }
      const stale = staleLayerCamera.current;
      const drawnCamera =
        stale && stale.viewport === built.viewport ? stale.camera : displayedCamera.current;
      const camera = pendingCamera.current ?? displayedCamera.current;
      const { settled } = previewLayoutSwitchAt(
        container,
        Math.max(1, container.clientWidth),
        Math.max(1, container.clientHeight),
      );
      const plan = previewLayoutSwitchPlan(
        built.scene,
        { camera: drawnCamera, viewport: built.viewport },
        { scale: pixi.stage.scale.x, x: pixi.stage.position.x, y: pixi.stage.position.y },
        reach - drawnRegionReach,
        { ...viewportRef.current, ...settled },
        cameraIsFitted.current ||
          previewCameraIsCentred(camera, built.scene.width, built.scene.height),
        previewSwitchRestoreView(switchRestore.current, camera, settled.behindEditor ?? false),
      );
      const entry = {
        ...plan,
        committed: false,
        expiresAt: performance.now() + layoutSwitchPlanLifetimeMs,
      };
      layoutSwitchPlan.current = entry;
      drawnRegionReach = reach;
      if (planExpiry !== null) window.clearTimeout(planExpiry);
      planExpiry = window.setTimeout(() => {
        planExpiry = null;
        if (!disposed && layoutSwitchPlan.current === entry && !entry.committed) {
          scheduler?.request();
        }
      }, layoutSwitchPlanLifetimeMs + 50);
    };
    const followLayoutGlide = () => {
      glideFrame = null;
      if (disposed || !initialized || !layoutGlide) return;
      if (frozenSize === null) scheduler?.renderNow();
      glideFrame = requestAnimationFrame(followLayoutGlide);
    };
    const layoutObserver = new MutationObserver(() => {
      planLayoutSwitch();
      if (!previewLayoutSwitching(region) || prefersReducedMotion()) return;
      layoutGlide = true;
      glideRevealed = false;
      if (glideFrame === null) glideFrame = requestAnimationFrame(followLayoutGlide);
    });
    if (region) {
      layoutObserver.observe(region, {
        attributeFilter: ['data-layout', 'data-layout-from'],
        attributes: true,
      });
    }
    const commitViewport = (size: PreviewCanvasSize, synchronous: boolean) => {
      const { width, height } = size;
      clearFrozenCanvas(initialized && !disposed ? pixi.canvas : null);
      const previous = requestedSize ?? viewportRef.current;
      if (
        initialized &&
        !disposed &&
        (pixi.renderer.screen.width !== width || pixi.renderer.screen.height !== height)
      ) {
        pixi.renderer.resize(width, height);
        if (synchronous) scheduler?.request();
        else scheduler?.renderNow();
      }
      if (
        previous.width === width &&
        previous.height === height &&
        (previous.behindEditor ?? false) === (size.behindEditor ?? false) &&
        samePreviewFocus(previous, size) &&
        samePreviewEditorInsets(previous, size)
      ) {
        return;
      }
      requestedSize = size;
      viewportCommits += 1;
      container.dataset.viewportCommits = String(viewportCommits);
      const update = () =>
        setViewport((current) =>
          samePreviewViewport(current, { ...current, ...size })
            ? current
            : { ...size, padding: previewPadding, projection: current.projection },
        );
      if (!synchronous) {
        update();
        return;
      }
      flushSync(update);
      if (initialized && !disposed) scheduler?.renderNow();
    };
    let frozenSize: PreviewCanvasSize | null = null;
    let keptCollapsed = false;
    const showFrozenCanvas = () => {
      if (!frozenSize || !initialized || disposed) return;
      const transform = frozenCanvasTransform.current?.(frozenSize);
      const stage = pixi.stage;
      applyFrozenCanvas(
        pixi.canvas,
        transform
          ? composePreviewTransforms(
              transform,
              invertPreviewTransform({
                scale: stage.scale.x,
                x: stage.position.x,
                y: stage.position.y,
              }),
            )
          : null,
      );
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
          const size = measureSize();
          if (
            frozenCanvasTransform.current &&
            !previewViewportIsCollapsed(viewportRef.current) &&
            previewViewportIsCollapsed({ ...viewportRef.current, ...size })
          ) {
            frozenSize = size;
            showFrozenCanvas();
            frozenSize = null;
            keptCollapsed = true;
            return;
          }
          keptCollapsed = false;
          commitViewport(size, true);
        },
      },
      documentTransitionEnvironment(container.ownerDocument),
    );
    const resizeObserver = new ResizeObserver(() => {
      if (transitionWatch.active && frozenCanvasTransform.current && !layoutGlide) {
        frozenSize = measureMotionSize();
        showFrozenCanvas();
        return;
      }
      const size = measureSize();
      if (keptCollapsed && previewViewportIsCollapsed({ ...viewportRef.current, ...size })) return;
      keptCollapsed = false;
      commitViewport(size, false);
    });
    resizeObserver.observe(container);
    const workspace = container.closest<HTMLElement>('.fixed-workspace');
    let centreFrame: number | null = null;
    let centreStill = 0;
    const centreRestFrames = 8;
    const followCentre = () => {
      centreFrame = null;
      if (disposed || !initialized) return;
      if (!previewLaidOutBehindEditor(container)) return;
      const live = previewFocusInsets(container, pixi.renderer.screen.width, true);
      const moved = !samePreviewFocus(live, shownFocus);
      if (moved && frozenSize === null && !layoutGlide) scheduler?.renderNow();
      const size = measureSize();
      const dragging = container.ownerDocument.body.classList.contains('resizing-horizontal');
      centreStill = moved || dragging || !samePreviewFocus(live, size) ? 0 : centreStill + 1;
      if (centreStill >= centreRestFrames) {
        if (frozenSize === null) commitViewport(size, false);
        return;
      }
      centreFrame = requestAnimationFrame(followCentre);
    };
    const startFollowingCentre = () => {
      centreStill = 0;
      if (centreFrame === null && initialized && !disposed) {
        centreFrame = requestAnimationFrame(followCentre);
      }
    };
    const editorShownObserver = new MutationObserver(startFollowingCentre);
    if (workspace) {
      editorShownObserver.observe(workspace, { attributeFilter: ['data-editor-shown'] });
    }
    const editorRegionObserver = new ResizeObserver(startFollowingCentre);
    const editorRegion = workspaceEditorRegion(container);
    if (editorRegion) editorRegionObserver.observe(editorRegion);
    return () => {
      disposed = true;
      if (planExpiry !== null) window.clearTimeout(planExpiry);
      layoutObserver.disconnect();
      editorShownObserver.disconnect();
      editorRegionObserver.disconnect();
      if (centreFrame !== null) cancelAnimationFrame(centreFrame);
      if (glideFrame !== null) cancelAnimationFrame(glideFrame);
      transitionWatch.dispose();
      if (refreshFrozenCanvas.current === showFrozenCanvas) refreshFrozenCanvas.current = null;
      delete container.dataset.layoutTransition;
      resizeObserver.disconnect();
      stopContextWatch?.();
      setPixiReady(false);
      if (transitions) {
        transitions.destroy();
        if (mapTransitions.current === transitions) mapTransitions.current = null;
      }
      shownTransitionPicture.current = null;
      if (application.current === pixi) application.current = null;
      if (scheduler) {
        scheduler.destroy();
        detachPreviewRenderScheduler(pixi.stage);
        if (renderScheduler.current === scheduler) renderScheduler.current = null;
      }
      candidateLayer.current?.destroy();
      candidateLayer.current = null;
      keptLiveStage.current?.destroy();
      keptLiveStage.current = null;
      const terrainCache = terrainChunkCache.current;
      if (terrainCache) {
        destroyTerrainChunkCache(terrainCache);
        terrainChunkCache.current = null;
      }
      if (keptTerrainCache.current) {
        destroyTerrainChunkCache(keptTerrainCache.current);
        keptTerrainCache.current = null;
      }
      stopBatcherTracking?.();
      if (initialized) pixi.destroy(true, { children: true });
    };
  }, [viewAvailable]);

  const sceneCamera = mapLayerKeptForCamera(builtMapLayer.current, camera, viewport, viewScene)
    ? builtMapLayer.current!.key
    : camera;
  const stateCamera = camera;
  useEffect(() => {
    mapTransitions.current?.finish();
  }, [viewport.width, viewport.height, viewport.projection]);
  useEffect(() => {
    const pixi = application.current;
    const container = host.current;
    const scene = viewScene;
    if (!pixiReady || !pixi || !container || !scene) return undefined;
    const camera = sceneBuildCamera(
      stateCamera,
      displayedCamera.current,
      outgoingSizeCamera.current === stateCamera ||
        cameraAnimation.current !== null ||
        wheelCommitTimer.current !== null ||
        gesture.current !== null,
    );
    outgoingSizeCamera.current = null;
    const canvas = pixi.canvas;
    latencyProbe.sceneBuild('start');
    const heightOverlayColor = cssColorToNumber(
      getComputedStyle(container).backgroundColor,
      resolvedTheme === 'dark' ? 0x0a0a0a : 0xededed,
    );
    let layerRenderer = mapRenderer;
    if (layerRenderer === 'gpu' && gameArtExpected) {
      const reason = gpuProbe(pixi.renderer);
      if (reason) {
        layerRenderer = 'cpu';
        setGpuUnavailable((current) => current ?? reason);
      }
    }
    const raisedView =
      projectionMode === 'minimap' &&
      raisedChosen &&
      !candidateCoversScene &&
      scene.elevations.length === scene.width * scene.height &&
      !(gameArtExpected && layerRenderer === 'cpu') &&
      raisedProbe(pixi.renderer) === null;
    const { key: terrainCacheKey, sceneKey: terrainSceneKey } = previewTerrainCacheKeys({
      map: candidateCoversScene
        ? `candidate-view:${scene.width}x${scene.height}`
        : (map?.semanticHash ?? ''),
      backend: map?.backend ?? 'synthetic',
      minimapPalette: map?.minimapPalette?.paletteHash ?? 'fallback',
      terrainColors: terrainColorSources.identity,
      colourLayer: colourLayerColors ? { textureColors: colourLayerColors.key } : 'minimap-colors',
      connections: overlays.connectionTerrain,
      elevationMode,
      heightOverlayColor,
      raised: raisedView,
    });
    const transitions = mapTransitions.current;
    const transitionPicture: TransitionPicture = {
      map: candidateCoversScene
        ? `candidate-view:${scene.width}x${scene.height}`
        : (map?.semanticHash ?? ''),
      look: gameArtExpected ? 'game-textures' : textureColorsShown ? 'texture-colors' : 'minimap',
      relief: raisedView ? 'raised' : elevationMode,
      gameTextures: gameArtExpected,
      view: projectionMode,
      liveStageView: candidateCoversScene,
    };
    const previousTransitionPicture = shownTransitionPicture.current;
    shownTransitionPicture.current = transitionPicture;
    let terrainCache = terrainChunkCache.current;
    const replacingTerrain = !terrainCache || terrainCache.key !== terrainCacheKey;
    const transition =
      transitions && replacingTerrain
        ? fitTransitionToScene(
            transitions.plan(previousTransitionPicture, transitionPicture, {
              liveStageShown: liveStageShown(shownPictureNow.current()),
              afterLiveStage:
                liveStageEndedAt.current !== null &&
                liveStageEndedAt.current === renderScheduler.current?.statistics.renders,
            }),
            {
              replacing: terrainCache !== null,
              previousFlat: terrainCache?.terrainSource != null && !terrainCache.raised,
              previousRaised: terrainCache?.raised?.layer != null,
              nextRaised: raisedView && !gameArtExpected,
            },
          )
        : null;
    const crossFading = transition?.crossFade === true && transitions!.captureOutgoing();
    if (transition?.kind) transitions!.finish();
    else if (replacingTerrain) transitions?.finishTerrain();
    let morphFrom: ReturnType<typeof morphPicture> = null;
    let heightMorphFrom: { retired: RetiredTerrain; picture: MorphTerrainData } | null = null;
    if (!terrainCache || terrainCache.key !== terrainCacheKey) {
      const replaced = terrainCache;
      const kept = keptTerrainCache.current;
      if (kept && kept.key === terrainCacheKey) {
        keptTerrainCache.current = null;
        terrainCache = kept;
      } else {
        terrainCache = createTerrainChunkCache(
          terrainCacheKey,
          terrainSceneKey,
          scene,
          overlays.connectionTerrain ? scene.terrainIds : scene.preConnectionTerrainIds,
          map?.backend ?? 'synthetic',
          elevationMode,
          heightOverlayColor,
          map?.minimapPalette ?? null,
          terrainColorSources,
          colourLayerColors?.terrains,
          raisedView ? raisedSurfaceFor(scene) : null,
        );
      }
      if (replaced) {
        if (gameArtExpected) handOverGameArtPicture(replaced, terrainCache);
      }
      if (replaced && keepsGameArtPicture(replaced, terrainCache, gameArt.keptKey)) {
        if (keptTerrainCache.current) destroyTerrainChunkCache(keptTerrainCache.current);
        keptTerrainCache.current = replaced;
      } else if (replaced) {
        const heightMorphPicture =
          transition?.kind === 'morph' && transition.heights
            ? committedMorphPicture(replaced)
            : null;
        if (transition?.kind === 'morph' && !transition.heights) {
          morphFrom = morphPicture(
            replaced.terrainSource,
            replaced.scene.width,
            replaced.scene.height,
          );
          if (morphFrom) replaced.terrainSource = null;
        }
        if (transition?.kind === 'flatten' && replaced.raised) {
          const retired = replaced;
          transitions!.flatten({
            retired: retired.container,
            uniforms: retired.raised!.uniforms,
            incoming: terrainCache.container,
            dispose: () => destroyTerrainChunkCache(retired),
          });
        } else if (heightMorphPicture) {
          const retired = replaced;
          heightMorphFrom = {
            picture: heightMorphPicture,
            retired: {
              container: retired.container,
              dispose: () => destroyTerrainChunkCache(retired),
            },
          };
        } else if (
          !transitions?.retire({
            container: replaced.container,
            dispose: () => destroyTerrainChunkCache(replaced),
          })
        ) {
          destroyTerrainChunkCache(replaced);
        }
      }
      terrainChunkCache.current = terrainCache;
    }
    const keptCache = keptTerrainCache.current;
    if (
      keptCache &&
      (keptCache.sceneKey !== terrainCache.sceneKey ||
        gameArtPictureKey(keptCache) !== gameArt.keptKey)
    ) {
      destroyTerrainChunkCache(keptCache);
      keptTerrainCache.current = null;
    }
    const liveCandidate = candidateLayer.current;
    const keptStage = keptLiveStage.current;
    destroyStageChildren(
      pixi.stage
        .removeChildren()
        .filter(
          (child) =>
            child !== terrainCache.container &&
            child !== keptTerrainCache.current?.container &&
            child !== liveCandidate?.container &&
            child !== keptStage?.container &&
            child !== heightMorphFrom?.retired.container &&
            !transitions?.keeps(child),
        ),
    );
    pixi.stage.addChild(terrainCache.container);
    sceneBuilding.current = true;
    const presentationCache = terrainCache;
    const raised = terrainCache.raised;
    const surface = raised?.surface ?? null;
    writeRaisedDataset(container, terrainCache);
    writeRaisedProbe(container, surface, scene, camera, viewport);
    syncGameArtLayers(terrainCache, {
      expected: gameArtExpected,
      terrain: gameArtTerrainView,
      sprites: gameArtSpriteView,
      cliffBands: gameArtCliffBandView,
      store: gameArtStore,
      elevation: { backgroundColor: heightOverlayColor, elevationMode },
      teamColor: gameArtTeamColor,
      renderer: layerRenderer,
      maximumTextureSize: maximumTextureSize(pixi),
      onGpuUnavailable: (reason) => setGpuUnavailable((current) => current ?? reason),
      host: container,
      raised: raised ? { surface: raised.surface, uniforms: raised.uniforms } : null,
      keep: gameArt.keptKey,
      onPresented: () => {
        queueMicrotask(() => {
          if (terrainChunkCache.current !== presentationCache || !renderScheduler.current) return;
          const awaiting = mapLayerAwaitsSprites.current;
          const layerBefore = renderedMapLayer.current;
          flushSync(() => {
            setGameArtPresentedKey(presentationCache.gameArtTerrain?.view.key ?? null);
            if (awaiting) setGameArtMarkerRedraws((count) => count + 1);
          });
          const layer = renderedMapLayer.current;
          if (layer) {
            if (layer === layerBefore && mapLayerAwaitsSprites.current) {
              layer.visible = false;
              mapLayerAwaitsSprites.current = false;
              setGameArtMarkerRedraws((count) => count + 1);
            } else layer.visible = true;
          }
          const released = releaseKeptLiveStage.current();
          const followed = followShownPicture.current();
          if (released || followed) renderScheduler.current?.renderNow();
          else renderScheduler.current?.request();
        });
      },
    });
    setGameArtPresentedKey(
      gameArtPictureKey(terrainCache) ??
        (keptTerrainCache.current ? gameArtPictureKey(keptTerrainCache.current) : null),
    );
    container.dataset.gameArtKept = String(
      terrainCache.gameArtPresentation.parked !== null || keptTerrainCache.current !== null,
    );
    setGameArtKindVisibility(terrainCache, {
      objects: minimapObjectsShown ? false : objectVisibility.objects,
      cliffs: overlays.cliffs,
    });
    setGameArtTreeScale(terrainCache, treeSpriteScale(previewSmallTrees));
    syncTileGrid(
      terrainCache,
      previewTileGrid,
      tileGridColor(container),
      container,
      overlayFades.tileGrid,
    );
    transformTerrainLayer(terrainCache.container, camera, scene, viewport);
    updateTerrainChunkVisibility(terrainCache, [camera], viewport, container);
    if (morphFrom) {
      const morphTo = morphPicture(terrainCache.terrainSource, scene.width, scene.height);
      if (morphTo) transitions!.morph(terrainCache.container, morphFrom, morphTo, true);
      else morphFrom.source.destroy();
    }
    if (heightMorphFrom) {
      const { retired, picture: previous } = heightMorphFrom;
      const target = terrainCache;
      const next = target.raised;
      const incoming = next?.layer?.container;
      const nextTexels = next?.texels;
      if (next && incoming && nextTexels) {
        transitions!.morphLater({
          track: 'morph',
          heights: true,
          place: (mesh) => {
            mesh.zIndex = 1.05;
            target.container.sortableChildren = true;
            target.container.addChild(mesh);
          },
          incoming,
          incomingUniforms: next.uniforms,
          objects: null,
          objectsFadeIn: transition!.objectsFadeIn,
          retired,
          pictures: () => ({
            previous,
            next: {
              texels: nextTexels,
              width: target.scene.width,
              height: target.scene.height,
              surface: next.surface,
            },
          }),
        });
      } else {
        retired.dispose();
        if (next) transitions!.rise(next.uniforms, target.container, transition!.objectsFadeIn);
      }
    }
    if (transition?.kind === 'rise' && terrainCache.raised) {
      transitions!.rise(
        terrainCache.raised.uniforms,
        terrainCache.container,
        transition.objectsFadeIn,
      );
    }
    const mapLayer = new Container({ isRenderGroup: true });
    pixi.stage.addChild(mapLayer);
    mapLayer.visible = terrainCache.gameArtPresentation.outgoing === null;
    renderedMapLayer.current = mapLayer;
    renderedCamera.current = camera;
    displayedCamera.current = camera;
    const connectionGeometry = connectionOverlayGeometry(
      scene,
      map,
      shownConnectionMode === 'paths' ? connectionRoutes : null,
      surface,
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
    connectionProbeHosts.set(mapLayer, container);
    drawCliffs(
      mapLayer,
      scene,
      camera,
      viewport,
      overlays,
      {
        look: cliffLook,
        minimapPalette: map?.minimapPalette ?? null,
        textureCliffColors: shownColourColors?.cliffs,
      },
      cliffPresentation(
        scene,
        gameArtTerrainView !== null && Boolean(terrainCache.gameArtTerrain?.layer.presented),
        terrainCache,
      ),
      surface,
    );
    const heightMapRange = elevationMode === 'height-map' ? terrainCache.elevationRange : null;
    const markerSkips = gameArtMarkerSkips(terrainCache);
    mapLayerAwaitsSprites.current = !minimapObjectsShown && markerSkips.awaitingPresentation;
    const coverage = new MarkerCoverage(scene, viewport, scene.objects.length);
    const drawMarkers = (
      target: Container,
      markerCamera: PreviewCamera,
      margin: { x: number; y: number },
    ) =>
      minimapObjectsShown
        ? drawMinimapObjects(
            target,
            scene,
            markerCamera,
            viewport,
            objectVisibility,
            map?.playerColorIds,
            map?.minimapPalette ?? null,
            map?.mapIconArtObjects,
            margin,
            surface,
            heightMapRange,
            coverage.drawn,
          )
        : drawObjects(
            target,
            scene,
            markerCamera,
            viewport,
            objectVisibility,
            map?.playerColorIds,
            map?.minimapPalette ?? null,
            Number.POSITIVE_INFINITY,
            markerSkips.spriteObjects,
            markerObjectColors,
            margin,
            surface,
            heightMapRange,
            coverage.drawn,
          );
    const drawnObjects = drawMarkers(mapLayer, camera, markerCullMargin(viewport));
    coverage.add({ camera, margin: markerCullMargin(viewport) }, drawnObjects.culled);
    container.dataset.drawnObjectCount = String(drawnObjects.objects);
    container.dataset.drawnHelperCount = String(drawnObjects.helpers);
    container.dataset.drawnWallJoins = String(
      'wallJoins' in drawnObjects ? drawnObjects.wallJoins : 0,
    );
    container.dataset.objectMarkerRadiusRange = drawnObjects.radiusRange;
    const connectionHoverGraphics = new Graphics();
    mapLayer.addChild(connectionHoverGraphics);
    markerCoverages.set(mapLayer, {
      coverage,
      viewport,
      extend: (shown) => {
        const margin = markerCullMargin(viewport);
        const part = new Container({ label: markerExtensionLabel });
        const started = performance.now();
        const extension = drawMarkers(part, shown, margin);
        coverage.add({ camera: shown, margin }, extension.culled);
        const placed = previewScreenTransform(
          scene.width,
          scene.height,
          shown,
          viewport,
          camera,
          viewport,
        );
        part.scale.set(placed.scale);
        part.position.set(placed.x, placed.y);
        mapLayer.addChildAt(part, mapLayer.getChildIndex(connectionHoverGraphics));
        container.dataset.markerParts = String(coverage.parts);
        container.dataset.markerExtendMs = (performance.now() - started).toFixed(2);
      },
    });
    container.dataset.markerParts = '1';
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
    const keptNow = keptLiveStage.current;
    if (keptNow) {
      pixi.stage.addChild(keptNow.container);
      keptNow.transform(camera, viewport, scene);
    }
    if (liveCandidate) {
      pixi.stage.addChild(liveCandidate.container);
      liveCandidate.transform(camera, viewport, scene);
    }
    const shownNow = shownPictureNow.current();
    coverCommittedLayers(
      coveredCommittedTerrain(terrainCache.container, stageMorphTerrain.current),
      mapLayer,
      liveStageShown(shownNow),
    );
    container.dataset.shownPicture = shownNow.source;
    const nextSelectionOutline = new Graphics();
    const nextSourceHighlightOutline = new Graphics();
    const nextLegendHoverOutline = new Graphics();
    const nextSourceLeavingOutline = new Graphics();
    const nextLegendLeavingOutline = new Graphics();
    leavingHighlightOverlays.set(nextSourceHighlightOutline, nextSourceLeavingOutline);
    leavingHighlightOverlays.set(nextLegendHoverOutline, nextLegendLeavingOutline);
    const outlineLayer = new Container();
    outlineLayer.addChild(
      nextSelectionOutline,
      nextSourceLeavingOutline,
      nextSourceHighlightOutline,
      nextLegendLeavingOutline,
      nextLegendHoverOutline,
    );
    selectionOutlineSurfaces.set(nextSelectionOutline, () => shownRaisedSurface.current());
    selectionOutlineEases.set(nextSelectionOutline, selectionEase);
    selectionOutlineReports.set(nextSelectionOutline, (edges) => {
      if (edges) {
        container.dataset.selectionDrawn = [
          edges.minimumX,
          edges.minimumY,
          edges.maximumX,
          edges.maximumY,
        ]
          .map((value) => String(Math.round(value * 1000) / 1000))
          .join(',');
      } else {
        delete container.dataset.selectionDrawn;
      }
    });
    const redrawEasedSelection = () => {
      const drag = gesture.current;
      if (drag?.kind === 'selection') {
        if (drag.cancelled) return;
        drawSelectionOutline(
          selectionOutline.current,
          scene,
          displayedCamera.current,
          viewport,
          selectionDragRectangle(drag, scene),
        );
        return;
      }
      const outline = selectionOutline.current;
      if (!outline) return;
      drawSelectionOutline(
        outline,
        scene,
        displayedCamera.current,
        viewport,
        selectionOutlineShown.get(outline) ?? null,
      );
    };
    selectionEaseRedraw.current = redrawEasedSelection;
    const raisedFills: ShownRaisedHighlight[] = [];
    for (const graphics of [
      nextSourceHighlightOutline,
      nextLegendHoverOutline,
      nextLegendLeavingOutline,
      nextSourceLeavingOutline,
    ]) {
      const highlight = new ShownRaisedHighlight(
        outlineLayer,
        graphics,
        () => shownPictureNow.current().raised,
      );
      raisedFills.push(highlight);
      raisedOverlays.set(graphics, highlight);
    }
    pixi.stage.addChild(outlineLayer);
    selectionOutline.current = nextSelectionOutline;
    sourceHighlightOutline.current = nextSourceHighlightOutline;
    legendHoverOutline.current = nextLegendHoverOutline;
    const releaseOverlayFades = bindPreviewOverlayFades(overlayFades, {
      selection: nextSelectionOutline,
      source: [nextSourceHighlightOutline, raisedFills[0] ?? null],
      sourceLeaving: [nextSourceLeavingOutline, raisedFills[3] ?? null],
      legend: [nextLegendHoverOutline, raisedFills[1] ?? null],
      legendLeaving: [nextLegendLeavingOutline, raisedFills[2] ?? null],
    });
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
        : displaySelectionNow.current,
      sourceHighlightTiles.current,
      legendHoverTileIndices.current,
    );
    followedSurface.current = shownNow.raised?.surface ?? null;
    sceneBuilding.current = false;
    if (
      keptLiveStage.current &&
      finalPictureReady({
        gameTexturesExpected: gameArtExpected,
        presented:
          Boolean(terrainCache.gameArtTerrain?.layer.presented) && !gameArtStandIn(terrainCache),
      })
    ) {
      releaseKeptLiveStage.current();
    }
    latencyProbe.sceneBuild('end', renderScheduler.current ?? undefined);
    const interaction = new Graphics()
      .rect(0, 0, viewport.width, viewport.height)
      .fill({ color: 0, alpha: 0.001 });
    interaction.eventMode = 'static';
    interaction.cursor = connectionHover.current ? 'pointer' : 'crosshair';
    interaction.hitArea = new Rectangle(0, 0, viewport.width, viewport.height);
    const sceneCaptureLayers = {
      outline: outlineLayer,
      selection: nextSelectionOutline,
      others: [connectionHoverGraphics, interaction],
    };
    captureLayers.current = sceneCaptureLayers;
    const setConnectionHover = (target: ConnectionOverlayTarget | null) => {
      if (sameConnectionOverlayTarget(target, connectionHover.current)) return;
      connectionHover.current = target;
      const cursor = target ? 'pointer' : 'crosshair';
      interaction.cursor = cursor;
      if (!gesture.current) canvas.style.cursor = cursor;
      paintConnectionHover();
      requestPreviewRender(connectionHoverGraphics);
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
    const pickSurface = () => shownRaisedSurface.current();
    const followDrag = (drag: PreviewSelectionDrag, point: { x: number; y: number }) => {
      const nextSelectionPreview = followSelectionDrag(
        drag,
        scene,
        displayedCamera.current,
        viewport,
        pickSurface(),
        point,
      );
      setSelectionPreview((current) =>
        samePreviewSelection(current, nextSelectionPreview) ? current : nextSelectionPreview,
      );
      selectionEase.follow(nextSelectionPreview);
      return nextSelectionPreview;
    };
    const updatePointer = (
      point: { x: number; y: number },
      pointerId: number,
      drawOutline = true,
    ) => {
      const currentGesture = gesture.current;
      const interactionCamera = displayedCamera.current;
      const mapPoint = screenToVisibleMap(
        point,
        scene.width,
        scene.height,
        interactionCamera,
        viewport,
        pickSurface(),
      );
      const nextHoveredCoordinate =
        mapPoint &&
        mapPoint.x >= 0 &&
        mapPoint.x < scene.width &&
        mapPoint.y >= 0 &&
        mapPoint.y < scene.height
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
        const nextSelectionPreview = followDrag(currentGesture, point);
        if (drawOutline) {
          drawSelectionOutline(
            selectionOutline.current,
            scene,
            interactionCamera,
            viewport,
            nextSelectionPreview,
          );
        }
        return;
      }
      if (cameraAnimation.current?.settle) {
        currentGesture.pointer = { x: point.x, y: point.y };
        return;
      }
      const panned = panDragCamera(
        currentGesture,
        displayedCamera.current,
        point,
        scene.width,
        scene.height,
        viewport,
      );
      displayedCamera.current = panned;
      transformTerrainLayer(terrainCache.container, panned, scene, viewport);
      updateTerrainChunkVisibility(terrainCache, [panned], viewport, container);
      candidateLayer.current?.transform(panned, viewport, scene);
      transformMapLayer(mapLayer, renderedCamera.current, panned, scene, viewport);
      drawPreviewOutlines(
        selectionOutline.current,
        sourceHighlightOutline.current,
        legendHoverOutline.current,
        mapBoundary.current,
        scene,
        panned,
        viewport,
        displaySelectionNow.current,
        sourceHighlightTiles.current,
        legendHoverTileIndices.current,
      );
      setCameraDataset(container, scene, panned, viewport);
      container.dataset.outlineCameraZoom = panned.zoom.toFixed(4);
    };
    const followCameraDuringDrag = () => {
      const drag = gesture.current;
      if (drag?.kind !== 'selection' || drag.cancelled) return null;
      updatePointer(drag.pointer, drag.pointerId, false);
      return selectionDragRectangle(drag, scene);
    };
    followSelectionDragCamera.current = followCameraDuringDrag;
    interaction.on('pointerdown', (event: FederatedPointerEvent) => {
      rightPress.current =
        event.button === 2 ? { x: event.clientX, y: event.clientY, travelled: 0 } : null;
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
        const hit = hitTestTopDownScene(
          scene,
          interactionCamera,
          viewport,
          event.global,
          pickSurface(),
        );
        if (!hit) {
          setCamera(interactionCamera);
          selectionDimensions.current = null;
          setSelection(null);
          setSelectionPreview(null);
          return;
        }
        const drag: PreviewSelectionDrag = {
          pointerId: event.pointerId,
          start: hit,
          end: hit,
          pointer: { x: event.global.x, y: event.global.y },
        };
        gesture.current = { kind: 'selection', ...drag };
        const pressedSelection = selectionDragRectangle(drag, scene);
        selectionEase.begin(pressedSelection);
        setSelectionPreview(pressedSelection);
        drawSelectionOutline(
          selectionOutline.current,
          scene,
          interactionCamera,
          viewport,
          pressedSelection,
        );
      } else {
        const interactionCamera = commitCameraTransition();
        cameraIsFitted.current = false;
        gesture.current = {
          kind: 'pan',
          pointerId: event.pointerId,
          pointer: { x: event.global.x, y: event.global.y },
          startCamera: cameraAnimation.current?.settle
            ? cameraAnimation.current.target
            : clampPreviewCamera(interactionCamera, scene.width, scene.height, viewport),
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
      const target = event.nativeEvent?.target;
      if (target instanceof Node && !container.contains(target)) {
        if (!gesture.current) setHoveredCoordinate(null);
        hoverConnectionAt(null);
        return;
      }
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
        const releasedCamera = cameraCommittedOnDragRelease(
          displayedCamera.current,
          cameraAnimation.current !== null || wheelCommitTimer.current !== null,
        );
        if (releasedCamera) setCamera(releasedCamera);
        if (commitSelection && !finishedGesture.cancelled && !connectionClick) {
          const committed = selectionDragRectangle(finishedGesture, scene);
          selectionEase.release(committed);
          selectionDimensions.current = `${scene.width}x${scene.height}`;
          setSelection(committed);
          drawSelectionOutline(
            selectionOutline.current,
            scene,
            displayedCamera.current,
            viewport,
            committed,
          );
        } else {
          selectionEase.end();
          drawSelectionOutline(
            selectionOutline.current,
            scene,
            displayedCamera.current,
            viewport,
            displaySelectionNow.current,
          );
        }
        setSelectionPreview(null);
      } else if (commitSelection) {
        const active = cameraAnimation.current;
        if (active && !active.settle) active.anchor = { ...finishedGesture.pointer };
        const releasedCamera = cameraCommittedOnDragRelease(
          displayedCamera.current,
          active !== null || wheelCommitTimer.current !== null,
        );
        if (releasedCamera) {
          pendingCamera.current = null;
          setCamera(releasedCamera);
        }
      } else {
        stopCameraAnimation();
        pendingCamera.current = null;
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
          displaySelectionNow.current,
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
      if (rightPress.current) {
        rightPress.current = moveRightPress(rightPress.current, event.clientX, event.clientY);
      }
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
    const suppressContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      const press = rightPress.current;
      rightPress.current = null;
      if (rightClickOpensMenu(press, event.clientX, event.clientY)) {
        openImageMenu.current({ x: event.clientX, y: event.clientY });
      }
    };
    canvas.addEventListener('contextmenu', suppressContextMenu);
    canvas.addEventListener('lostpointercapture', cancelNativePointer);
    canvas.addEventListener('pointercancel', cancelNativePointer);
    canvas.addEventListener('pointerup', releaseNativePointer);
    container.addEventListener('pointerleave', leaveHost);
    window.addEventListener('pointermove', moveNativePointer, true);
    window.addEventListener('pointerup', releaseNativePointer, true);
    window.addEventListener('pointercancel', cancelNativePointer, true);
    pixi.stage.addChild(interaction);
    if (crossFading) transitions!.crossFade();
    transitions?.placeStageNodes(pixi.stage, terrainCache.container);
    setCameraDataset(container, scene, camera, viewport);
    container.dataset.outlineCameraZoom = camera.zoom.toFixed(4);
    sceneBuilds.current += 1;
    container.dataset.sceneBuilds = String(sceneBuilds.current);
    builtMapLayer.current = {
      camera,
      key: sceneCamera,
      viewport,
      scene,
      culled: drawnObjects.culled,
    };
    renderScheduler.current?.request();
    const drawnViewport = viewport;
    const transformFrozenCanvas = (size: PreviewCanvasSize) => {
      if (previewViewportIsCollapsed(drawnViewport)) return null;
      const shownViewport = { ...drawnViewport, ...size };
      const drawnCamera = displayedCamera.current;
      const switchPlan = layoutSwitchPlan.current;
      const restored =
        pendingCamera.current === null &&
        previewRegionShowsPreview(container) &&
        !(switchPlan && !switchPlan.committed)
          ? previewSwitchRestoreCamera(scene, switchRestore.current, drawnCamera, shownViewport)
          : null;
      const shownCamera =
        switchPlan && !switchPlan.committed
          ? previewLayoutSwitchCamera(scene, switchPlan, shownViewport)
          : restored
            ? restored.camera
            : cameraIsFitted.current
              ? fitPreviewCamera(scene.width, scene.height)
              : clampPreviewCamera(
                  previewCameraForCentre(
                    pendingCamera.current ?? drawnCamera,
                    scene.width,
                    scene.height,
                    drawnViewport,
                    shownViewport,
                  ),
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
    writeSelectionDataset(container, displaySelectionNow.current);
    return () => {
      interaction.removeAllListeners();
      if (captureLayers.current === sceneCaptureLayers) captureLayers.current = null;
      releaseOverlayFades();
      for (const fill of raisedFills) fill.destroy();
      if (connectionHoverFrame !== null) window.cancelAnimationFrame(connectionHoverFrame);
      clearConnectionHover.current = () => {};
      if (followSelectionDragCamera.current === followCameraDuringDrag) {
        followSelectionDragCamera.current = () => null;
      }
      if (selectionEaseRedraw.current === redrawEasedSelection) {
        selectionEaseRedraw.current = () => {};
      }
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
    sceneCamera,
    candidateCoversScene,
    commitCameraTransition,
    elevationMode,
    raisedChosen,
    gameArtCliffBandView,
    gameArtExpected,
    gameArt.keptKey,
    gameArtMarkerRedraws,
    gameArtPresentedKey,
    gameArtSpriteView,
    gameArtStore,
    gameArtTeamColor,
    gameArtTerrainView,
    map?.semanticHash,
    mapRenderer,
    objectVisibility,
    overlays,
    overlayFades,
    connectionRouteHitBounds,
    connectionRoutes,
    shownConnectionMode,
    pixiReady,
    previewSmallTrees,
    previewTileGrid,
    resolvedTheme,
    viewScene,
    terrainColorSources,
    textureColorsShown,
    colourLayerColors,
    shownColourColors,
    cliffLook,
    markerObjectColors,
    minimapObjectsShown,
    viewport,
  ]);
  useLayoutEffect(() => {
    const container = host.current;
    if (container) writeSelectionDataset(container, displaySelection);
    const outline = selectionOutline.current;
    if (!viewScene || !outline) return;
    const drag = gesture.current;
    if (drag?.kind === 'selection' && !drag.cancelled) return;
    const shown = selectionOutlineShown.get(outline);
    if (shown !== undefined && samePreviewSelection(shown, displaySelection)) return;
    drawSelectionOutline(outline, viewScene, displayedCamera.current, viewport, displaySelection);
  }, [displaySelection]);
  useEffect(() => {
    if (sceneCamera === camera || !viewScene) return;
    if (cameraAnimation.current || gesture.current) return;
    applyDisplayedCamera(camera);
    const terrainCache = terrainChunkCache.current;
    if (terrainCache) {
      updateTerrainChunkVisibility(terrainCache, [camera], viewport, host.current);
    }
  }, [applyDisplayedCamera, camera, sceneCamera, viewScene, viewport]);
  const bindBoundaryOutline = useCallback((element: SVGPathElement | null) => {
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
  const boundaryShown = generationActive || boundaryMotion !== 'rest';
  useLayoutEffect(() => {
    mapBoundary.current.shown = boundaryShown;
    if (!viewScene) return;
    drawMapBoundaryOutline(mapBoundary.current, viewScene, displayedCamera.current, viewport);
  }, [boundaryShown, camera, candidateActive, shownSurface, gameArtExpected, viewScene, viewport]);
  const drawBoundaryFrame = useRef<() => void>(() => undefined);
  drawBoundaryFrame.current = () => {
    if (!viewScene) return;
    drawMapBoundaryOutline(
      mapBoundary.current,
      viewScene,
      displayedCamera.current,
      viewportRef.current,
    );
  };
  useEffect(() => {
    if (boundaryMotion === 'rest') return undefined;
    let frame = 0;
    const step = () => {
      drawBoundaryFrame.current();
      const elements = mapBoundary.current;
      frame = elements.shown && elements.marginFraction > 0 ? requestAnimationFrame(step) : 0;
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [boundaryMotion]);

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
  const candidateObjectClasses = candidateObjectClassLookup(generationActivity, presentedMap);
  const candidateLook = liveStageLook(flatLook, gameArtLiveStages);
  const candidateLookColors =
    candidateLook === 'texture-colors' && candidateTexturePalette
      ? textureLookColors(candidateTexturePalette)
      : undefined;
  const candidateLookTerrainColors = candidateLookColors?.terrains;
  const candidateLookObjectColors = lookMarkerObjectColors(candidateLook, candidateTexturePalette);
  const candidateMinimapClassifier = useMemo(
    () =>
      minimapObjectsShown
        ? minimapSquareClassifier({
            artObjects: presentedMap?.mapIconArtObjects,
            minimapPalette: candidatePalette,
            helperObjectIds: objectVisibility.helperObjectIds,
          })
        : null,
    [candidatePalette, minimapObjectsShown, objectVisibility.helperObjectIds, presentedMap],
  );
  const pixiRenderer = pixiReady ? application.current?.renderer : undefined;
  const candidateRaisable =
    projectionMode === 'minimap' &&
    raisedChosen &&
    candidateLayerShown &&
    pixiRenderer !== undefined &&
    raisedProbe(pixiRenderer) === null;
  candidatePresentation.current = {
    raised: candidateRaisable,
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
    minimapSquares:
      candidateMinimapClassifier && viewScene
        ? {
            classifier: candidateMinimapClassifier,
            sizes: previewMinimapSquareSizes(viewScene.width, viewScene.height, camera, viewport),
          }
        : null,
    verticalScale: previewMarkerVerticalScale(viewport),
    ...(candidateObjectClasses ? { objectClasses: candidateObjectClasses } : {}),
  };
  const liveRun = liveStageRun.current;
  const keepingLiveStage =
    !candidateActive &&
    liveRun !== null &&
    keepLastLiveStage({
      committed: map !== null && map !== liveRun.startMap,
      stageShown: liveRun.layer.container.visible && liveRun.layer.chunkCount > 0,
      finalInGameTextures: gameArtExpected && gameArtMap !== null,
      sameDimensions:
        scene !== null &&
        scene.width === liveRun.layer.dimensions.width &&
        scene.height === liveRun.layer.dimensions.height,
    });
  keepLiveStageAtEnd.current = keepingLiveStage;

  followShownPicture.current = () => {
    const shown = shownPictureNow.current();
    coverCommittedLayers(
      coveredCommittedTerrain(
        terrainChunkCache.current?.container ?? null,
        stageMorphTerrain.current,
      ),
      renderedMapLayer.current,
      liveStageShown(shown),
    );
    const container = host.current;
    if (container) container.dataset.shownPicture = shown.source;
    const surface = shown.raised?.surface ?? null;
    if (followedSurface.current === surface) return false;
    followedSurface.current = surface;
    if (viewScene) {
      const current = gesture.current;
      drawSelectionOutline(
        selectionOutline.current,
        viewScene,
        displayedCamera.current,
        viewport,
        current?.kind === 'selection' && !current.cancelled
          ? selectionDragRectangle(current, viewScene)
          : displaySelection,
      );
      drawLegendHover(
        sourceHighlightOutline.current,
        viewScene,
        displayedCamera.current,
        viewport,
        sourceHighlightTiles.current,
      );
      drawLegendHover(
        legendHoverOutline.current,
        viewScene,
        displayedCamera.current,
        viewport,
        legendHoverTileIndices.current,
      );
      drawMapBoundaryOutline(mapBoundary.current, viewScene, displayedCamera.current, viewport);
      const layer = candidateLayer.current;
      if (container && layer) {
        writeCandidateRaisedDataset(container, layer, viewScene, viewport, displayedCamera.current);
      }
    }
    setShownSurface(surface);
    return true;
  };

  releaseKeptLiveStage.current = () => {
    const kept = keptLiveStage.current;
    if (!kept) return false;
    keptLiveStage.current = null;
    kept.destroy();
    const container = host.current;
    if (container) delete container.dataset.liveStageKept;
    setLiveStageKept(false);
    followShownPicture.current();
    return true;
  };

  useEffect(() => {
    const pixi = application.current;
    const container = host.current;
    if (!pixiReady || !pixi || !container || !candidateActive) return undefined;
    const layer = new PreviewCandidateLayer(previewCandidates);
    candidateLayer.current = layer;
    liveStageRun.current = { layer, startMap: latestMap.current };
    layer.container.visible = candidateLayerShownRef.current && liveStageHold.current !== 'holding';
    const outline = selectionOutline.current?.parent;
    const outlineIndex = outline ? pixi.stage.getChildIndex(outline) : -1;
    if (outlineIndex >= 0) pixi.stage.addChildAt(layer.container, outlineIndex);
    else pixi.stage.addChild(layer.container);
    const record = (drawMilliseconds: number, counted: boolean) => {
      const view = previewCandidates.view;
      container.dataset.candidateChunks = String(layer.chunkCount);
      container.dataset.candidateRebuiltChunks = String(layer.rebuiltChunks);
      container.dataset.candidateDrawMs = drawMilliseconds.toFixed(2);
      if (view) latencyProbe.candidateDrawn(view.requestId, drawMilliseconds);
      container.dataset.candidateRevision = String(view?.revision ?? '');
      container.dataset.candidateStage = view?.stage ?? '';
      container.dataset.candidateRaised = layer.raisedSurface ? 'on' : 'off';
      container.dataset.candidateRaisedPending = String(layer.raisedPending);
      container.dataset.candidateRaisedBuildMs = layer.raisedBuildMilliseconds.toFixed(2);
      container.dataset.candidateRaisedSlices = String(layer.raisedSlices);
      if (counted) {
        container.dataset.candidateUpdates = String(
          Number(container.dataset.candidateUpdates ?? 0) + 1,
        );
      }
      releaseLiveStageHold();
      followShownPicture.current();
    };
    const releaseLiveStageHold = () => {
      if (
        !releasesLiveStageHold(
          liveStageHold.current,
          previewCandidates.view?.stage ?? null,
          layer.raisedPending,
        )
      ) {
        return;
      }
      liveStageHold.current = 'released';
      layer.container.visible = candidateLayerShownRef.current;
      requestPreviewRender(layer.container);
      const transitions = mapTransitions.current;
      const committed = terrainChunkCache.current;
      const stageRaised = layer.raisedPicture;
      const plan = transitions
        ? planLiveStageMorph(shownTransitionPicture.current, stageRaised !== null, {
            enabled: transitions.enabled,
            reducedMotion: transitions.reducedMotionPreferred,
          })
        : null;
      if (plan) transitions!.countSkip(plan);
      const previous = committed ? committedMorphPicture(committed) : null;
      if (plan?.kind === 'morph' && committed && previous && layer.container.visible) {
        stageMorphTerrain.current = committed.container;
        transitions!.morphLater({
          track: 'stage-morph',
          heights: plan.heights,
          place: (mesh) => {
            layer.container.addChildAt(mesh, layer.container.getChildIndex(layer.objectNode));
          },
          incoming: layer.terrainNode,
          incomingUniforms: stageRaised?.uniforms ?? null,
          objects: layer.objectNode,
          objectsFadeIn: plan.objectsFadeIn,
          retired: null,
          keepsOldTerrain: true,
          onOldTerrainReleased: () => {
            stageMorphTerrain.current = null;
            followShownPicture.current();
            renderScheduler.current?.request();
          },
          pictures: () => {
            const next = layer.stagePicture();
            return next ? { previous, next } : null;
          },
        });
      }
      setLiveStageHoldRevision((revision) => revision + 1);
    };
    container.dataset.candidateUpdates = '0';
    layer.onSwap = () => record(layer.raisedLaterMilliseconds, false);
    let stageFading = false;
    layer.onPictureChange = (phase, change) => {
      const transitions = mapTransitions.current;
      if (!transitions || !layer.container.visible) return;
      if (transitions.stageMorphRunning) {
        if (phase === 'after') transitions.stageChanged();
        return;
      }
      if (phase === 'before') {
        stageFading = transitions.liveStageAllowed() && transitions.captureOutgoing();
        return;
      }
      if (change.turningRaised && change.uniforms && transitions.allowed) {
        transitions.rise(change.uniforms, layer.container, false);
      }
      if (stageFading) transitions.crossFade();
      stageFading = false;
    };
    layer.rebuildAll(candidatePresentation.current!);
    layer.transform(displayedCamera.current, viewportRef.current, {
      width: previewCandidates.view?.width ?? 1,
      height: previewCandidates.view?.height ?? 1,
    });
    releaseKeptLiveStage.current();
    record(layer.lastUpdateMilliseconds, true);
    const unsubscribe = previewCandidates.subscribe((_view, change) => {
      if (!change?.accepted) return;
      layer.update(change, candidatePresentation.current!);
      record(layer.lastUpdateMilliseconds, true);
    });
    return () => {
      unsubscribe();
      if (candidateLayer.current === layer) candidateLayer.current = null;
      layer.onSwap = null;
      layer.onPictureChange = null;
      liveStageEndedAt.current =
        layer.container.visible && layer.chunkCount > 0
          ? (renderScheduler.current?.statistics.renders ?? null)
          : null;
      mapTransitions.current?.finishStageMorph();
      const keep = keepLiveStageAtEnd.current && liveStageRun.current?.layer === layer;
      if (liveStageRun.current?.layer === layer) liveStageRun.current = null;
      if (keep) {
        releaseKeptLiveStage.current();
        layer.freeze();
        keptLiveStage.current = layer;
        container.dataset.liveStageKept = 'true';
        setLiveStageKept(true);
      } else layer.destroy();
      followShownPicture.current();
      for (const key of [
        'candidateChunks',
        'candidateRebuiltChunks',
        'candidateDrawMs',
        'candidateRevision',
        'candidateStage',
        'candidateUpdates',
        'candidateRaised',
        'candidateRaisedPending',
        'candidateRaisedBuildMs',
        'candidateRaisedSlices',
        'candidateRaisedDrawnChunks',
        'candidateRaisedProbe',
      ]) {
        delete container.dataset[key];
      }
    };
  }, [candidateActive, pixiReady, previewCandidates]);

  useEffect(() => {
    const layer = candidateLayer.current;
    const shown = candidateLayerShown && !liveStageHeld;
    if (!layer || layer.container.visible === shown) return;
    layer.container.visible = shown;
    requestPreviewRender(layer.container);
    followShownPicture.current();
  }, [candidateActive, candidateLayerShown, liveStageHeld, pixiReady]);

  useEffect(() => {
    releaseKeptLiveStage.current();
  }, [projectionMode, elevationMode, raisedChosen]);

  useEffect(() => {
    const layer = candidateLayer.current;
    if (!layer) return;
    layer.rebuildAll(candidatePresentation.current!);
    followShownPicture.current();
  }, [
    candidatePalette?.paletteHash,
    candidateRaisable,
    candidateTerrainIdentity,
    candidateLookTerrainColors,
    candidateLookObjectColors,
    candidateMinimapClassifier,
    elevationMode,
    heightOverlayColor,
    objectVisibility,
    overlays.cliffs,
    presentedMap?.playerColorIds,
  ]);

  useEffect(() => {
    if (!viewScene) return;
    keptLiveStage.current?.transform(displayedCamera.current, viewport, viewScene);
    const layer = candidateLayer.current;
    if (!layer) return;
    layer.transform(displayedCamera.current, viewport, viewScene);
    const component = candidatePresentation.current!.markerComponent;
    const minimapSized =
      candidatePresentation.current!.minimapSquares != null &&
      (component !== layer.vectorComponent ||
        candidatePresentation.current!.verticalScale !== layer.vectorVerticalScale);
    if (
      minimapSized ||
      Math.abs(component / Math.max(layer.vectorComponent, 0.000_001) - 1) > 0.2
    ) {
      layer.refreshVectors(candidatePresentation.current!);
    }
    const container = host.current;
    if (container)
      writeCandidateRaisedDataset(container, layer, viewScene, viewport, displayedCamera.current);
  }, [camera, candidateActive, liveStageKept, shownSurface, viewScene, viewport]);

  const candidateSelection = candidateShown && displaySelection ? displaySelection : null;
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
        selectionEase.end();
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
        return;
      }
    }
  }, []);

  const imageAvailable = viewScene !== null && pixiReady;
  const imageFileName = previewImageFileName(map?.documentUri);
  const captureMapImage = () => {
    const pixi = application.current;
    if (!pixi || !viewScene) throw new Error('the map preview shows no map');
    const surface = shownRaisedSurface.current();
    const layers = captureLayers.current;
    const selectionFade = overlayFades.selection.state;
    const selection =
      layers && (selectionFade === 'in' || selectionFade === 'shown') ? layers.selection : null;
    const image = capturePreviewImage({
      application: pixi,
      scene: viewScene,
      camera: displayedCamera.current,
      viewport: viewportRef.current,
      lift: surface ? { minimum: surface.minimum, maximum: surface.maximum } : null,
      transient: layers
        ? [...layers.outline.children.filter((layer) => layer !== selection), ...layers.others]
        : [],
      selection,
    });
    if (!image) throw new Error('no part of the map is in view');
    return image;
  };
  const copyMapImage = async () => {
    const image = captureMapImage();
    await window.rmside.copyImageToClipboard({ kind: 'pixels', ...image });
  };
  const mapImageCopyFailed = (copyError: unknown) =>
    appendOutput(
      presentMessage({
        source: 'Preview',
        raw: copyError instanceof Error ? copyError.message : String(copyError),
        fallbackHeadline: 'preview-panel.output.image-copy-failed',
      }),
    );
  const savingMapImage = useRef(false);
  const saveMapImage = async () => {
    if (savingMapImage.current) return;
    savingMapImage.current = true;
    try {
      const result = await window.rmside.savePreviewImage({
        ...captureMapImage(),
        fileName: imageFileName,
      });
      if (result.status === 'saved') {
        appendOutput(
          outputNote('Preview', 'preview.image-saved', {
            id: 'preview-panel.output.image-saved',
            args: { name: result.fileName },
          }),
        );
      }
    } catch (saveError) {
      appendOutput(
        presentMessage({
          source: 'Preview',
          raw: saveError instanceof Error ? saveError.message : String(saveError),
          fallbackHeadline: 'preview-panel.output.image-save-failed',
        }),
      );
    } finally {
      savingMapImage.current = false;
    }
  };
  const [imageMenu, setImageMenu] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [imageMenuOpen, setImageMenuOpen] = useState(false);
  const imageMenuFocusReturn = useRef<HTMLElement | null>(null);
  openImageMenu.current = (point) => {
    if (!imageAvailable) return;
    imageMenuFocusReturn.current = application.current?.canvas ?? null;
    setImageMenu(point);
    setImageMenuOpen(true);
  };
  const imageMenuAnchor = useMemo(
    () => ({
      getBoundingClientRect: () =>
        DOMRect.fromRect({ x: imageMenu.x, y: imageMenu.y, width: 0, height: 0 }),
    }),
    [imageMenu],
  );
  useLayoutEffect(() => {
    if (!imageMenuOpen) return undefined;
    const dismiss = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('.preview-image-menu')) return;
      setImageMenuOpen(false);
    };
    document.addEventListener('pointerdown', dismiss, { capture: true });
    return () => document.removeEventListener('pointerdown', dismiss, { capture: true });
  }, [imageMenuOpen]);
  useEffect(() => {
    if (!imageAvailable) setImageMenuOpen(false);
  }, [imageAvailable]);

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
      const factor = wheelZoomFactor(event);
      if (factor === null) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      zoom(
        factor,
        {
          x: event.clientX - bounds.left,
          y: event.clientY - bounds.top,
        },
        true,
      );
    },
    [viewScene, zoom],
  );

  const mapBounds = viewScene ? mapScreenBounds(viewScene, camera, viewport) : null;
  const selectionAggregation = useMemo(
    () =>
      legendMap && scene && selection
        ? selectionLayerAggregation(
            legendMap,
            scene,
            selection,
            objectVisibility,
            shownConnectionMode === 'paths' ? connectionRoutes : null,
          )
        : null,
    [connectionRoutes, legendMap, objectVisibility, scene, selection, shownConnectionMode],
  );
  const finishedSelectionAggregation = useFinishedWork(selectionAggregation);
  const selectionLayersPending =
    selectionAggregation !== null && finishedSelectionAggregation !== selectionAggregation;
  const shownSelectionAggregation = useRef<typeof selectionAggregation>(null);
  if (!selectionAggregation) shownSelectionAggregation.current = null;
  else if (!selectionLayersPending) shownSelectionAggregation.current = selectionAggregation;
  const heldSelectionAggregation = shownSelectionAggregation.current;
  const selectionLayers = !selectionAggregation
    ? []
    : !selectionLayersPending
      ? selectionAggregation.result
      : heldSelectionAggregation?.scene === selectionAggregation.scene
        ? heldSelectionAggregation.result
        : null;
  const sourceHighlightLayers = useMemo(() => {
    if (!map || !legendMap || !scene || sourceHighlightTileIndices.length === 0) return null;
    const layers = aggregateTileIndexLayers(
      legendMap,
      scene,
      sourceHighlightTileIndices,
      objectVisibility,
      new Set(highlightedPreviewOperationIndices),
      null,
      operationWrittenTiles(map, scene, highlightedPreviewOperationIndices),
    );
    return layers.length > 0 ? layers : null;
  }, [
    highlightedPreviewOperationIndices,
    legendMap,
    map,
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
            objectClasses: candidateObjectClasses,
          })
        : null,
    [
      candidateObjectClasses,
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
    candidateActive: candidateShown,
    selection: candidateShown ? candidateSelection !== null : selection !== null,
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
  const readoutSelection = selectionPreview ?? (candidateShown ? displaySelection : selection);
  const informationPresent = Boolean(legendLayers || readoutSelection || hoveredCoordinate);
  const informationWasMounted = useRef(false);
  const legendWasMounted = useRef(false);
  const selectionLabelWasMounted = useRef(false);
  const information = usePresence(informationPresent, {
    reversible:
      (!legendWasMounted.current || legendLayers !== null) &&
      (!selectionLabelWasMounted.current || readoutSelection !== null),
  });
  const legendPresence = usePresence(
    legendLayers !== null || (information.closing && legendWasMounted.current),
  );
  const holdLegend = legendPresence.closing || information.closing;
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
  legendListsCode.current = shownLegendContent === 'source-highlight';
  sourceHighlightTiles.current = shownCodeHighlightTiles(
    sourceHighlightTileIndices,
    legendHoverTileIndices.current,
    legendListsCode.current,
    noHighlightTiles,
  );
  useEffect(() => {
    const shown = sourceHighlightTiles.current;
    const container = host.current;
    if (container) container.dataset.sourceHighlightShown = String(shown.length);
    if (!viewScene) return;
    drawLegendHover(
      sourceHighlightOutline.current,
      viewScene,
      displayedCamera.current,
      viewport,
      shown,
    );
  }, [viewScene, sourceHighlightTileIndices, shownLegendContent, viewport]);
  const legendShown = legendPresence.mounted && shownLegendLayers !== null;
  const layerArtCivilizationKey = gameArtCivilizationKey(map?.playerCivilizationIds);
  const layerArtCivilizationFor = useMemo(
    () => gameArtCivilizationResolver(layerArtCivilizationKey.split(',').map(Number)),
    [layerArtCivilizationKey],
  );
  const layerArtContext = useMemo(
    () => ({
      index: gameArt.terrainIndex,
      spriteSet: gameArt.spriteSet,
      civilizationFor: layerArtCivilizationFor,
      teamColor: gameArtTeamColor,
      objects: !minimapObjectsShown,
    }),
    [
      gameArt.spriteSet,
      gameArt.terrainIndex,
      gameArtTeamColor,
      layerArtCivilizationFor,
      minimapObjectsShown,
    ],
  );
  const layerArtListed = shownLegendContent !== 'provisional';
  const layerArt = usePreviewLayerArt({
    enabled: gameArtExpected && !candidateCoversScene && layerArtListed,
    shown: cliffLook === 'game-textures' && layerArtListed,
    layers: legendShown ? shownLegendLayers : null,
    context: layerArtContext,
    shared: gameArtStore,
  });
  const legendEntersAlone = informationWasMounted.current;
  const listSurface = listSurfaceMode({
    listsCode: legendShown && shownLegendContent === 'source-highlight',
    leaving: legendPresence.closing || information.closing,
    layout: viewport.behindEditor ? 'behind-editor' : 'side-by-side',
  });
  const listSurfacePresence = usePresence(listSurface.shown);
  const listSurfaceGeometryRef = useListSurfaceGeometry(
    listSurface.shown,
    `${information.mounted}|${legendShown}`,
  );
  const shownListSurfaceTone = useHeld(listSurface.tone, listSurfacePresence.closing);
  const listSurfaceRef = useCallback(
    (element: HTMLElement | null) => {
      listSurfacePresence.ref(element);
      listSurfaceGeometryRef(element);
    },
    [listSurfaceGeometryRef, listSurfacePresence.ref],
  );
  const [legendFilter, setLegendFilter] = useState('');
  const legendWidths = usePreviewLegendWidth(presentedMap);
  const legendWidth = legendWidths?.panel ?? null;
  const informationWidth = legendWidths?.information ?? null;
  const readoutStacked =
    legendWidths !== null &&
    previewReadoutStacked(legendWidths.readout, previewVisibleWidth(viewport));
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
  const openProfilerStepOperation = useCallback(
    (operationIndex: number) => {
      if (!map || candidateActiveRef.current || !map.provenanceOperations[operationIndex]) return;
      selectPreviewOperation(operationIndex);
    },
    [map, selectPreviewOperation],
  );
  const hoverSelectionLayer = useCallback(
    (layer: AggregatedSelectionLayer | null) => {
      const indices = layer ? aggregatedLayerTileIndices(layer) : [];
      legendHoverTileIndices.current = indices;
      const shownSource = shownCodeHighlightTiles(
        codeHighlightTiles.current,
        indices,
        legendListsCode.current,
        noHighlightTiles,
      );
      const sourceChanged = shownSource !== sourceHighlightTiles.current;
      sourceHighlightTiles.current = shownSource;
      if (viewScene) {
        drawLegendHover(
          legendHoverOutline.current,
          viewScene,
          displayedCamera.current,
          viewport,
          indices,
        );
        if (sourceChanged) {
          drawLegendHover(
            sourceHighlightOutline.current,
            viewScene,
            displayedCamera.current,
            viewport,
            shownSource,
          );
        }
      }
      const container = host.current;
      if (container) {
        container.dataset.sourceHighlightShown = String(shownSource.length);
        container.dataset.legendHoverCount = String(indices.length);
        container.dataset.legendHoverRuns = viewScene
          ? String(highlightTileRuns(indices, viewScene.width).length / 3)
          : '0';
        if (viewScene) {
          const corners = highlightCorners(indices, viewScene.width);
          let outer = 0;
          for (const bits of corners.convex) {
            outer += (bits & 1) + ((bits >> 1) & 1) + ((bits >> 2) & 1) + ((bits >> 3) & 1);
          }
          container.dataset.legendHoverCorners = `${outer} ${corners.concave.length / 4}`;
        } else {
          container.dataset.legendHoverCorners = '0 0';
        }
      }
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
  const announcedLayersPending = legendContent === 'selection' && selectionLayersPending;
  useEffect(() => {
    if (selection === announcedSelection.current || announcedLayersPending) return undefined;
    const timer = window.setTimeout(() => {
      announcedSelection.current = selection;
      announce(describePreviewSelection(selection, announcedLayerSummary.current));
    }, 200);
    return () => window.clearTimeout(timer);
  }, [announce, announcedLayersPending, selection]);
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
  useEffect(() => {
    renderScheduler.current?.request();
  });
  const narrowPreview =
    viewScene !== null && pixiReady && previewVisibleWidth(viewport) < narrowPreviewWidth;
  const blurOutdatedMap = generationBlurShown({
    activity: generationActivity,
    gameTexturesExpected: gameArtExpected,
    liveInGameTextures: gameArtLiveStages,
    candidateActive,
    lookPending: lookPendingShown,
    lastStageKept: liveStageKept || keepingLiveStage,
  });
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
        data-live-stage-hold={liveStageHold.current}
        data-candidate-look={candidateActive && candidateLayerShown ? candidateLook : ''}
        data-live-stage-kept={liveStageKept}
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
        data-elevation-mode={shownElevationMode}
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
        data-game-art-builds={gameArt.builds}
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
              <path ref={bindBoundaryOutline} />
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
                pending={lookPendingShown}
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
              <PreviewObjectsModeButton
                mode={overlays.objects}
                onCycle={() =>
                  setOverlays((current) => ({
                    ...current,
                    objects: nextPreviewObjectsMode(current.objects),
                  }))
                }
              />
              {overlayButtons.slice(0, 1).map(({ key, labelId, renderIcon }) => (
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
                  {overlayButtons.slice(1).map(({ key, labelId, renderIcon }) => (
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
                mode={shownElevationMode}
                onCycle={() =>
                  setElevationMode(
                    nextElevationDisplayMode(chosenElevationMode, projectionMode === 'minimap'),
                  )
                }
              />
              {shownLook === 'game-textures' &&
              previewPerspective === 'diamond' &&
              !minimapObjectsShown ? (
                <PreviewOverlayButton
                  active={previewSmallTrees}
                  className="preview-small-trees-button"
                  label={t(smallTreesButton.labelId)}
                  onToggle={() => setPreviewSmallTrees(!previewSmallTrees)}
                  renderIcon={smallTreesButton.renderIcon}
                />
              ) : null}
            </div>
            <ContextMenu onOpenChange={setImageMenuOpen} open={imageMenuOpen}>
              <ContextMenuContent
                anchor={imageMenuAnchor}
                className="preview-image-menu"
                data-testid="preview-image-menu"
                finalFocus={imageMenuFocusReturn}
                surface="popup"
              >
                <ContextMenuItem
                  data-testid="preview-image-menu-copy"
                  onClick={() => {
                    void copyMapImage().catch(mapImageCopyFailed);
                  }}
                >
                  <Copy aria-hidden="true" /> {t('preview-panel.image-menu.copy')}
                </ContextMenuItem>
                <ContextMenuItem
                  data-testid="preview-image-menu-save"
                  onClick={() => void saveMapImage()}
                >
                  <Save aria-hidden="true" /> {t('preview-panel.image-menu.save')}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
            {map ? <DevelopmentFixtureMenu execution={previewExecution} mapActive /> : null}
            {information.mounted ? (
              <div
                className="preview-map-information motion-surface motion-edge"
                data-has-legend={legendShown}
                data-list-surface={listSurface.shown || undefined}
                data-motion-from="left"
                data-readout-stacked={readoutStacked || undefined}
                ref={information.ref}
                style={
                  legendWidth === null || informationWidth === null
                    ? undefined
                    : ({
                        '--preview-legend-width': `${legendWidth}px`,
                        '--preview-information-width': `${informationWidth}px`,
                      } as React.CSSProperties)
                }
                {...presenceProps(information.closing)}
              >
                {legendShown ||
                (selectionLabel.mounted && shownReadoutSelection) ||
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
                    busy={shownLegendContent === 'selection' && selectionLayersPending}
                    closing={legendPresence.closing}
                    content={shownLegendContent}
                    entersAlone={legendEntersAlone}
                    filter={legendFilter}
                    layerArt={layerArt}
                    layers={shownLegendLayers}
                    maxHeight={previewLegendMaxHeight(viewport.height, {
                      narrow: narrowPreview,
                      readoutStacked,
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
            {listSurfacePresence.mounted ? (
              <div
                aria-hidden="true"
                className="preview-list-surface motion-backdrop"
                data-testid="preview-list-surface"
                data-tone={shownListSurfaceTone}
                ref={listSurfaceRef}
                {...presenceProps(listSurfacePresence.closing)}
              />
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
        onNavigateToOperation={openProfilerStepOperation}
        onOpenChange={setProfilerOpen}
        open={profilerOpen}
        store={executionProfiler}
      />
    </section>
  );
}

function SelectionLayerLegend({
  busy,
  closing,
  content,
  entersAlone,
  filter,
  layerArt,
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
  busy: boolean;
  closing: boolean;
  content: 'selection' | 'source-highlight' | 'provisional';
  readOnly?: boolean;
  entersAlone: boolean;
  filter: string;
  layerArt: ReadonlyMap<string, string> | null;
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
  const { helperCount, helperLayers, mainLayers } = useMemo(
    () => partitionHelperLayers(layers),
    [layers],
  );
  const allListedLayers = useMemo(
    () => (showHelpers ? [...mainLayers, ...helperLayers] : mainLayers),
    [helperLayers, mainLayers, showHelpers],
  );
  const labels = useMemo(() => previewLegendLabels(allListedLayers), [allListedLayers]);
  const listedLayers = useMemo(
    () =>
      filter.trim()
        ? allListedLayers.filter((layer) =>
            previewLegendFilterMatches(labels.get(layer.key)!, filter),
          )
        : allListedLayers,
    [allListedLayers, filter, labels],
  );
  const mountedRows = useRowsMountedInFrames(
    listedLayers,
    Math.ceil(maxHeight / selectionListRowHeight) + 1,
    selectionListRowsPerFrame,
  );
  const mountedLayers =
    mountedRows < listedLayers.length ? listedLayers.slice(0, mountedRows) : listedLayers;
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
        cullToShell: true,
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
  const contentIdentity = useMemo(
    () => `${showHelpers}|${listedLayers.map((layer) => `${layer.key}:${layer.count}`).join('|')}`,
    [listedLayers, showHelpers],
  );
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
  }, [content, contentIdentity, listMotion, mountedRows]);
  useLayoutEffect(() => {
    updateFades();
    const frame = requestAnimationFrame(updateFades);
    return () => cancelAnimationFrame(frame);
  }, [contentIdentity, maxHeight, mountedRows, resolvedTheme, updateFades]);
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
      aria-busy={busy || mountedRows < listedLayers.length || undefined}
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
          {mountedLayers.map((layer) => (
            <SelectionLayerRow
              art={layerArt?.get(layer.key)}
              key={layer.key}
              label={labels.get(layer.key)!}
              layer={layer}
              onActivate={onActivate}
              readOnly={readOnly}
              setFocusedLayerKey={setFocusedLayerKey}
              setPointerLayerKey={setPointerLayerKey}
            />
          ))}
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

const SelectionLayerRow = memo(function SelectionLayerRow({
  art,
  label,
  layer,
  onActivate,
  readOnly,
  setFocusedLayerKey,
  setPointerLayerKey,
}: {
  art: string | undefined;
  label: PreviewLayerLabel;
  layer: AggregatedSelectionLayer;
  onActivate(layer: AggregatedSelectionLayer): void;
  readOnly: boolean;
  setFocusedLayerKey: Dispatch<SetStateAction<string | null>>;
  setPointerLayerKey: Dispatch<SetStateAction<string | null>>;
}) {
  const { t } = useI18n();
  const activation = useMemo(
    () => !readOnly && resolveAggregatedLayerActivationForAvailability(layer),
    [layer, readOnly],
  );
  return (
    <Tooltip disableHoverablePopup>
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
            onBlur={() => setFocusedLayerKey((current) => (current === layer.key ? null : current))}
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
        <LayerIcon art={art} material={layer.material} />
        <LayerName label={label} />
        <span className="preview-layer-count">{layer.count}</span>
      </TooltipTrigger>
      <TooltipContent className="preview-layer-tooltip" side="right">
        <LayerTooltip label={label} layer={layer} />
      </TooltipContent>
    </Tooltip>
  );
});

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
  const unavailable = !developmentFixtureRunnable(execution);
  if (mapActive) {
    return (
      <select
        aria-label={t('preview-panel.fixtures.label')}
        className="preview-fixture-select"
        defaultValue=""
        disabled={unavailable}
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
          disabled={unavailable}
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
  surface: ElevationSurface | null = null,
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
    ...(surface
      ? {
          heightAt: (x: number, y: number) => surface.heightAt(x, y),
          maximumHeight: Math.max(Math.abs(surface.minimum), Math.abs(surface.maximum)),
        }
      : {}),
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
  connectionProbePoints.set(stage, probes);
  writeConnectionProbes(container, stage);
}

const connectionProbePoints = new WeakMap<
  Container,
  { drawn?: { x: number; y: number }; failed?: { x: number; y: number } }
>();
const connectionProbeHosts = new WeakMap<Container, HTMLElement>();

const markerCoverages = new WeakMap<
  Container,
  { coverage: MarkerCoverage; viewport: PreviewViewport; extend(camera: PreviewCamera): void }
>();

function writeConnectionProbes(container: HTMLElement, layer: Container): void {
  const probes = connectionProbePoints.get(layer) ?? {};
  for (const [key, point] of [
    ['connectionProbe', probes.drawn],
    ['connectionFailedProbe', probes.failed],
  ] as const) {
    if (!point) {
      delete container.dataset[key];
      continue;
    }
    const x = layer.position.x + point.x * layer.scale.x;
    const y = layer.position.y + point.y * layer.scale.y;
    container.dataset[key] = `${x.toFixed(2)},${y.toFixed(2)}`;
  }
}

function maximumTextureSize(pixi: Application): number | undefined {
  const gl = (pixi.renderer as { gl?: WebGLRenderingContext }).gl;
  if (!gl) return undefined;
  const size = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE));
  return Number.isFinite(size) && size > 0 ? size : undefined;
}

function previewFrameHash(pixi: Application): number | null {
  const gl = (pixi.renderer as { gl?: WebGLRenderingContext }).gl;
  if (!gl) return null;
  const width = gl.drawingBufferWidth;
  const height = gl.drawingBufferHeight;
  const pixels = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  return framePixelHash(pixels);
}

function previewFrameBounds(pixi: Application): string {
  const gl = (pixi.renderer as { gl?: WebGLRenderingContext }).gl;
  if (!gl) return 'none';
  const width = gl.drawingBufferWidth;
  const height = gl.drawingBufferHeight;
  const pixels = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  const bounds = framePixelBounds(pixels, width, height);
  if (!bounds) return 'none';
  const resolution = pixi.renderer.resolution;
  return [bounds.left, bounds.top, bounds.right, bounds.bottom]
    .map((value) => (value / resolution).toFixed(1))
    .join(',');
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
  surface: ElevationSurface | null = null,
): void {
  if (!overlays.cliffs) return;
  const graphics = new Graphics();
  const flat = style.look !== 'game-textures';
  const width = flat
    ? previewCliffStrokeWidth(previewScale(scene.width, scene.height, camera, viewport))
    : 3;
  const color = (cliffType: number) =>
    cliffMaterial(cliffType, style.look, style.minimapPalette, style.textureCliffColors).color;
  const lifted = (point: { x: number; y: number }) =>
    surface
      ? raisedMapToScreen(
          point,
          surface.heightAt(point.x, point.y),
          scene.width,
          scene.height,
          camera,
          viewport,
        )
      : mapToScreen(point, scene.width, scene.height, camera, viewport);
  const stroke = (from: { x: number; y: number }, to: { x: number; y: number }, rgb: number) => {
    const start = lifted(from);
    const end = lifted(to);
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

function drawMinimapObjects(
  stage: Application['stage'],
  scene: TopDownScene,
  camera: PreviewCamera,
  viewport: PreviewViewport,
  visibility: PreviewObjectVisibility,
  playerColorIds: readonly number[] = [],
  minimapPalette: SelectedMinimapPalette | null = null,
  artObjects: PreviewGenerationResult['mapIconArtObjects'],
  cullMargin: { x: number; y: number } = { x: 0, y: 0 },
  surface: ElevationSurface | null = null,
  heightMap: ElevationRange | null = null,
  drawnMask: Uint8Array | null = null,
): { helpers: number; objects: number; radiusRange: string; culled: boolean } {
  const drawn = { helpers: 0, objects: 0, radiusRange: '', culled: false };
  if (!visibility.objects) return drawn;
  const classifier = minimapSquareClassifier({
    artObjects,
    minimapPalette,
    helperObjectIds: visibility.helperObjectIds,
  });
  const sizes = previewMinimapSquareSizes(scene.width, scene.height, camera, viewport);
  const levelPixels = surface ? previewLevelPixels(scene.width, scene.height, camera, viewport) : 0;
  const reach = Math.max(sizes.townCenter, sizes.object);
  const layers: { kind: MinimapSquareClass; x: number; y: number; color: number }[][] = [
    [],
    [],
    [],
    [],
  ];
  for (let objectIndex = 0; objectIndex < scene.objects.length; objectIndex += 1) {
    if (drawnMask?.[objectIndex]) continue;
    const object = scene.objects[objectIndex]!;
    const kind = classifier.classify(object);
    if (!kind) continue;
    const center = mapToScreen(object, scene.width, scene.height, camera, viewport);
    if (surface) center.y -= surface.heightAt(object.x, object.y) * levelPixels;
    if (
      center.x < -reach - cullMargin.x ||
      center.y < -reach - cullMargin.y ||
      center.x > viewport.width + reach + cullMargin.x ||
      center.y > viewport.height + reach + cullMargin.y
    ) {
      drawn.culled = true;
      continue;
    }
    let color = minimapSquareColor(kind, object.owner, playerColorIds);
    if (heightMap) color = litColor(color, objectHeightMapLight(scene, object, heightMap));
    layers[minimapSquareDrawLayer(kind)]!.push({ kind, x: center.x, y: center.y, color });
    if (drawnMask) drawnMask[objectIndex] = 1;
  }
  const layer = new OrderedMarkerLayer(stage);
  const laws = previewMinimapSquareSizeLaws(scene.width, scene.height, camera, viewport);
  for (const entries of layers) {
    for (const entry of entries) {
      drawn.objects += 1;
      const law =
        entry.kind === 'town-center'
          ? laws.townCenter
          : entry.kind === 'tree'
            ? laws.tree
            : laws.object;
      layer.marks.anchor(entry.x, entry.y, entry.x, entry.y, law.base, law.minimum, law.maximum);
      if (entry.kind === 'town-center') {
        const hall = minimapSquareTownCenterPolygon(entry.x, entry.y, sizes.townCenter);
        layer.marks.polygon(hall, entry.color);
        layer.marks.stroke(hall, true, {
          color: minimapSquareTownCenterBorderColor,
          width: 1.5,
          alpha: 1,
        });
        continue;
      }
      layer.marks.polygon(
        minimapSquarePolygon(entry.x, entry.y, minimapSquareSide(entry.kind, sizes)),
        entry.color,
      );
    }
  }
  layer.finish();
  if (drawn.objects > 0) {
    const half = (side: number) => (side / 2).toFixed(2);
    drawn.radiusRange = `${half(sizes.tree)},${half(sizes.townCenter)}`;
  }
  return drawn;
}

const raisedOverlays = new WeakMap<Graphics, ShownRaisedHighlight>();

const leavingHighlightOverlays = new WeakMap<Graphics, Graphics>();

const minimumRaisedOverlayBias = 16 * raisedDepthBiasStep;

function candidateShownRaised(layer: PreviewCandidateLayer): ShownRaisedPicture | null {
  const picture = layer.raisedPicture;
  return picture ? { ...picture, overlayBias: () => minimumRaisedOverlayBias } : null;
}

function committedShownRaised(cache: TerrainChunkCache): ShownRaisedPicture | null {
  const raised = cache.raised;
  if (!raised) return null;
  return {
    surface: raised.surface,
    uniforms: raised.uniforms,
    overlayBias: () =>
      Math.max(
        minimumRaisedOverlayBias,
        cache.gameArtTerrain?.layer.renderer === 'gpu'
          ? cache.gameArtTerrain.layer.raisedOverlayBias
          : 0,
      ),
  };
}

function standInShownRaised(raised: GameArtPictureRaised | null): ShownRaisedPicture | null {
  return raised
    ? {
        surface: raised.surface,
        uniforms: raised.uniforms,
        overlayBias: () => Math.max(minimumRaisedOverlayBias, raised.overlayBias()),
      }
    : null;
}

function liveStageShown(shown: ShownPicture): boolean {
  return shown.source === 'live-stage' || shown.source === 'kept-live-stage';
}

const selectionOutlineSurfaces = new WeakMap<Graphics, () => ElevationSurface | null>();

const raisedOutlineCache = new WeakMap<
  ElevationSurface,
  { key: string; runs: ReturnType<typeof raisedRoundedRectangleOutline> }
>();

const selectionOutlineEases = new WeakMap<Graphics, SelectionEase>();

const selectionOutlineShown = new WeakMap<Graphics, PreviewSelection | null>();

const selectionOutlineReports = new WeakMap<
  Graphics,
  (edges: { minimumX: number; minimumY: number; maximumX: number; maximumY: number } | null) => void
>();

function mapScreenBasis(
  scene: Pick<TopDownScene, 'width' | 'height'>,
  camera: PreviewCamera,
  viewport: PreviewViewport,
) {
  const origin = mapToScreen({ x: 0, y: 0 }, scene.width, scene.height, camera, viewport);
  const unitX = mapToScreen({ x: 1, y: 0 }, scene.width, scene.height, camera, viewport);
  const unitY = mapToScreen({ x: 0, y: 1 }, scene.width, scene.height, camera, viewport);
  const xx = unitX.x - origin.x;
  const xy = unitX.y - origin.y;
  const yx = unitY.x - origin.x;
  const yy = unitY.y - origin.y;
  return {
    origin,
    xx,
    xy,
    yx,
    yy,
    edge: Math.min(Math.hypot(xx, xy), Math.hypot(yx, yy)),
  };
}

function projectMapPoints(points: number[], basis: ReturnType<typeof mapScreenBasis>): number[] {
  for (let index = 0; index < points.length; index += 2) {
    const x = points[index]!;
    const y = points[index + 1]!;
    points[index] = basis.origin.x + x * basis.xx + y * basis.yx;
    points[index + 1] = basis.origin.y + x * basis.xy + y * basis.yy;
  }
  return points;
}

function drawSelectionOutline(
  graphics: Graphics | null,
  scene: TopDownScene,
  camera: PreviewCamera,
  viewport: PreviewViewport,
  shownSelection: PreviewSelection | null,
): void {
  if (!graphics) return;
  graphics.clear();
  requestPreviewRender(graphics);
  selectionOutlineShown.set(graphics, shownSelection);
  const fade = overlayFadeOf<PreviewSelection>(graphics);
  const selection = fade
    ? fade.show(shownSelection, `${scene.width}x${scene.height}`)
    : shownSelection;
  const report = selectionOutlineReports.get(graphics);
  if (!selection) {
    report?.(null);
    return;
  }
  const edges = selectionOutlineEases.get(graphics)?.drawn(selection) ?? selectionEdges(selection);
  report?.(edges);
  const basis = mapScreenBasis(scene, camera, viewport);
  const radius = highlightCornerRadius(basis.edge);
  const segments = cornerArcSegments(radius * basis.edge);
  const surface = selectionOutlineSurfaces.get(graphics)?.() ?? null;
  if (surface && surface.width === scene.width && surface.height === scene.height) {
    const key = `${edges.minimumX},${edges.minimumY},${edges.maximumX},${edges.maximumY},${radius.toFixed(5)},${segments}`;
    let cached = raisedOutlineCache.get(surface);
    if (!cached || cached.key !== key) {
      cached = { key, runs: raisedRoundedRectangleOutline(surface, edges, radius, segments) };
      raisedOutlineCache.set(surface, cached);
    }
    const loop = !surface.hasSteps;
    for (const run of cached.runs) {
      const points: number[] = [];
      for (let point = 0; point < run.length; point += 3) {
        const screen = raisedMapToScreen(
          { x: run[point]!, y: run[point + 1]! },
          run[point + 2]!,
          scene.width,
          scene.height,
          camera,
          viewport,
        );
        points.push(screen.x, screen.y);
      }
      if (loop) graphics.poly(points, true);
      else {
        graphics.moveTo(points[0]!, points[1]!);
        for (let point = 2; point < points.length; point += 2) {
          graphics.lineTo(points[point]!, points[point + 1]!);
        }
      }
    }
    graphics.stroke({ color: 0xffffff, width: 2, alpha: 1 });
    return;
  }
  const polygon = projectMapPoints(
    roundedRectanglePolygon(
      edges.minimumX,
      edges.minimumY,
      edges.maximumX,
      edges.maximumY,
      allCorners,
      radius,
      segments,
    ),
    basis,
  );
  graphics.poly(polygon).stroke({ color: 0xffffff, width: 2, alpha: 1 });
}

function drawLegendHover(
  graphics: Graphics | null,
  scene: TopDownScene,
  camera: PreviewCamera,
  viewport: PreviewViewport,
  tileIndices: readonly number[],
): void {
  if (!graphics) return;
  drawHighlightFill(graphics, scene, camera, viewport, tileIndices);
  const leaving = leavingHighlightOverlays.get(graphics);
  if (leaving) drawHighlightFill(leaving, scene, camera, viewport, []);
}

function drawHighlightFill(
  graphics: Graphics,
  scene: TopDownScene,
  camera: PreviewCamera,
  viewport: PreviewViewport,
  tileIndices: readonly number[],
): void {
  graphics.clear();
  requestPreviewRender(graphics);
  let indices = tileIndices;
  const fade = overlayFadeOf<readonly number[]>(graphics);
  if (fade) {
    indices =
      fade.show(indices.length > 0 ? indices : null, `${scene.width}x${scene.height}`) ?? [];
  }
  const highlight = raisedOverlays.get(graphics);
  if (indices.length === 0) {
    highlight?.clear();
    return;
  }
  const basis = mapScreenBasis(scene, camera, viewport);
  const radius = highlightCornerRadius(basis.edge);
  const segments = cornerArcSegments(radius * basis.edge);
  const raised = highlight?.current(scene) ?? null;
  if (raised) {
    const { surface, fill } = raised;
    const level = previewLevelPixels(scene.width, scene.height, camera, viewport);
    const project = (x: number, y: number, h: number) => ({
      x: basis.origin.x + x * basis.xx + y * basis.yx,
      y: basis.origin.y + x * basis.xy + y * basis.yy - h * level,
    });
    const geometry =
      radius > 0
        ? raisedRoundedTileFill(
            surface,
            highlightCorners(indices, scene.width),
            radius,
            segments,
            project,
          )
        : raisedTileFill(surface, indices, project);
    fill.set(geometry.positions, geometry.depths, geometry.indices);
    return;
  }
  if (radius > 0) {
    const { runs, convex, concave } = highlightCorners(indices, scene.width);
    for (let run = 0; run < runs.length / 3; run += 1) {
      const y = runs[run * 3]!;
      graphics.poly(
        projectMapPoints(
          roundedRectanglePolygon(
            runs[run * 3 + 1]!,
            y,
            runs[run * 3 + 2]!,
            y + 1,
            convex[run]!,
            radius,
            segments,
          ),
          basis,
        ),
      );
    }
    for (let corner = 0; corner < concave.length; corner += 4) {
      graphics.poly(
        projectMapPoints(
          concaveCornerPolygon(
            concave[corner]!,
            concave[corner + 1]!,
            concave[corner + 2]!,
            concave[corner + 3]!,
            radius,
            segments,
          ),
          basis,
        ),
      );
    }
  } else {
    const runs = highlightTileRuns(indices, scene.width);
    for (let run = 0; run < runs.length; run += 3) {
      const y = runs[run]!;
      graphics.poly(
        projectMapPoints(
          [runs[run + 1]!, y, runs[run + 2]!, y, runs[run + 2]!, y + 1, runs[run + 1]!, y + 1],
          basis,
        ),
      );
    }
  }
  graphics.fill({ color: 0xffffff, alpha: 0.6 });
}

interface MapBoundaryElements {
  outline: SVGPathElement | null;
  arc: SVGSVGElement | null;
  border: SVGPathElement | null;
  frame: SVGPathElement | null;
  strokeWidth: number;
  shown: boolean;
  marginFraction: number;
  surface: () => ElevationSurface | null;
}

function drawMapBoundaryOutline(
  elements: MapBoundaryElements,
  scene: Pick<TopDownScene, 'width' | 'height'>,
  camera: PreviewCamera,
  viewport: PreviewViewport,
): void {
  const outline = elements.outline;
  if (!outline || !elements.shown) return;
  const surface = elements.surface();
  let points: number[];
  let hidden: Uint8Array | null = null;
  let loop: ReturnType<typeof raisedBoundaryLoop> | null = null;
  if (surface && surface.width === scene.width && surface.height === scene.height) {
    loop = raisedBoundaryLoop(surface);
    points = projectRaisedBoundaryLoop(loop.points, terrainLayerTransform(scene, camera, viewport));
    hidden = loop.hidden;
  } else {
    points = mapRectangleScreenPolygon(
      { x: 0, y: 0 },
      { x: scene.width, y: scene.height },
      scene.width,
      scene.height,
      camera,
      viewport,
    );
  }
  outline.setAttribute('d', boundaryOutlinePath(points, hidden));
  const { arc, border, frame } = elements;
  if (!arc || !border || !frame) return;
  const style = getComputedStyle(arc);
  const fraction = Math.min(
    1,
    Math.max(0, cssNumber(style.getPropertyValue('--preview-boundary-margin'), 0)),
  );
  elements.marginFraction = fraction;
  let arcPoints = points;
  if (fraction > 0) {
    const transform = terrainLayerTransform(scene, camera, viewport);
    const perTile = boundaryEdgePixelsPerTile(transform.scaleX, transform.scaleY);
    const margin = boundaryEntranceMargin(
      cssPixels(style.getPropertyValue('--motion-distance-edge')),
      fraction,
      (perTile * Math.min(scene.width, scene.height)) / 2,
    );
    const tiles = perTile > 0 ? margin / perTile : 0;
    if (tiles > 0) {
      arcPoints =
        loop !== null
          ? projectRaisedBoundaryLoop(
              expandBoundaryLoop(loop.points, scene.width, scene.height, tiles),
              transform,
            )
          : mapRectangleScreenPolygon(
              { x: -tiles, y: -tiles },
              { x: scene.width + tiles, y: scene.height + tiles },
              scene.width,
              scene.height,
              camera,
              viewport,
            );
    }
  }
  const visible = visibleMapBoundary(
    arcPoints,
    insetBoundaryFrame(viewport.width, viewport.height, elements.strokeWidth),
    hidden,
  );
  const paths = boundarySubpaths(visible);
  border.setAttribute('d', paths.border);
  frame.setAttribute('d', paths.frame);
  const center = visible.center ?? previewViewCenter(viewport);
  arc.style.setProperty('--preview-boundary-center-x', `${center.x.toFixed(2)}px`);
  arc.style.setProperty('--preview-boundary-center-y', `${center.y.toFixed(2)}px`);
  arc.dataset.frameSides = boundaryFrameSides(visible).join(' ');
}

function projectRaisedBoundaryLoop(
  loopPoints: readonly number[],
  transform: { scaleX: number; scaleY: number; x: number; y: number },
): number[] {
  const points = new Array<number>((loopPoints.length / 3) * 2);
  for (let from = 0, to = 0; from < loopPoints.length; from += 3, to += 2) {
    const x = loopPoints[from]!;
    const y = loopPoints[from + 1]!;
    points[to] = transform.x + (x + y) * transform.scaleX;
    points[to + 1] = transform.y + (y - x - loopPoints[from + 2]!) * transform.scaleY;
  }
  return points;
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
  sourceHighlightTileIndices: readonly number[],
  legendHoverTileIndices: readonly number[],
): void {
  drawSelectionOutline(selectionGraphics, scene, camera, viewport, selection);
  drawLegendHover(sourceGraphics, scene, camera, viewport, sourceHighlightTileIndices);
  drawLegendHover(legendHoverGraphics, scene, camera, viewport, legendHoverTileIndices);
  drawMapBoundaryOutline(boundary, scene, camera, viewport);
}

function LayerName({ label }: { label: PreviewLayerLabel }) {
  const text = [label.name, label.disambiguation, label.owner].filter(Boolean).join(' ');
  return (
    <OverflowingLabel
      className="preview-layer-name"
      name={text}
      slideWhenHoverOverflows
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

function LayerTooltip({
  label,
  layer,
}: {
  label: PreviewLayerLabel;
  layer: AggregatedSelectionLayer;
}) {
  const { t } = useI18n();
  const resources = useMemo(() => layerResourceTotals(layer), [layer]);
  const instanceIds = useMemo(() => layerInstanceIdRange(layer), [layer]);
  return (
    <div className="preview-layer-tooltip-body" data-testid="preview-layer-tooltip">
      <span className="preview-layer-tooltip-name">{label.fullName}</span>
      {label.details.map((detail) => (
        <span className="preview-layer-tooltip-detail" key={detail}>
          {detail}
        </span>
      ))}
      {resources.map(({ kind, amount }) => (
        <span
          className="preview-layer-tooltip-detail"
          data-part="resource"
          data-resource={kind}
          key={kind}
        >
          {t(previewResourceTotalMessages[kind], { amount })}
        </span>
      ))}
      {instanceIds ? (
        <span className="preview-layer-tooltip-detail" data-part="instance-ids">
          {instanceIds.low === instanceIds.high
            ? t('preview-panel.legend.instance-id.one', { id: String(instanceIds.low) })
            : t('preview-panel.legend.instance-id.range', {
                low: String(instanceIds.low),
                high: String(instanceIds.high),
              })}
        </span>
      ) : null}
    </div>
  );
}

function LayerIcon({ art, material }: { art?: string | undefined; material: PreviewMaterial }) {
  const color = `#${material.color.toString(16).padStart(6, '0')}`;
  return (
    <span
      aria-hidden="true"
      className="preview-layer-icon"
      data-art={art ? material.subject.kind : undefined}
      data-color={color}
      data-color-source={material.colorSource}
      data-helper={material.helper ? 'true' : undefined}
      data-shape={material.shape}
      style={
        {
          '--preview-layer-color': color,
          ...(art ? { backgroundImage: `url("${art}")` } : {}),
        } as React.CSSProperties
      }
    />
  );
}

function createTerrainChunkCache(
  key: string,
  sceneKey: string,
  scene: TopDownScene,
  terrainIds: readonly number[],
  backend: PreviewBackend,
  elevationMode: ElevationDisplayMode,
  heightOverlayColor: number,
  minimapPalette: SelectedMinimapPalette | null,
  terrainColorSources: TerrainColorSources,
  lookTerrainColors: ReadonlyMap<number, number> | undefined,
  surface: ElevationSurface | null = null,
): TerrainChunkCache {
  const container = new Container({ label: 'cached-terrain-chunks', isRenderGroup: true });
  container.eventMode = 'none';
  return {
    raised: surface
      ? { surface, uniforms: new RaisedTerrainUniforms(surface), layer: null, texels: null }
      : null,
    backend,
    chunks: new Map(),
    container,
    elevationMode,
    elevationRange: terrainElevationRange(scene.elevations),
    geometryBuilds: 0,
    heightOverlayColor,
    key,
    sceneKey,
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
  const raised = cache.raised;
  const builtLayer = Boolean(raised && !raised.layer);
  if (raised && !raised.layer) {
    const texels = buildTerrainTexels(cache.scene, cache.terrainIds, cache.backend, {
      backgroundColor: cache.heightOverlayColor,
      elevationMode: 'off',
      elevationRange: cache.elevationRange,
      localTerrainColors: cache.terrainColorSources.localTerrainColors,
      lookTerrainColors: cache.lookTerrainColors,
      minimapPalette: cache.minimapPalette,
      terrainNames: cache.terrainColorSources.terrainNames,
    });
    raised.layer = new RaisedColorTerrainLayer(raised.surface, texels, raised.uniforms);
    raised.texels = texels;
    raised.layer.container.visible = !cache.gameArtPresentation.minimapHidden;
    cache.geometryBuilds += 1;
    cache.chunks.set(raisedChunkKey, {
      container: raised.layer.container,
      texture: Texture.EMPTY,
      tileCount: cache.scene.width * cache.scene.height,
    });
    cache.container.addChild(raised.layer.container);
    if (host) {
      host.dataset.raisedColorQuads = String(raised.layer.quads);
      host.dataset.raisedColorWalls = String(raised.layer.wallQuads);
      host.dataset.raisedColorBuildMs = raised.layer.buildMilliseconds.toFixed(1);
    }
  }
  if (raised) visibleKeys.add(raisedChunkKey);
  if (raised?.layer) {
    const changed = raised.layer.updateView(
      raisedViewRect(cache.scene, cameras, viewport, overscan),
    );
    if (host && (changed || builtLayer)) {
      host.dataset.raisedColorChunks = String(raised.layer.chunkCount);
      host.dataset.raisedColorDrawnChunks = String(raised.layer.drawnChunks);
      host.dataset.raisedColorTriangles = String(raised.layer.triangleCount);
      host.dataset.raisedColorDrawnTriangles = String(raised.layer.drawnTriangles);
    }
  }
  const lift = raised ? { minimum: raised.surface.minimum, maximum: raised.surface.maximum } : null;
  for (const camera of cameras) {
    const range = visibleTileRange(cache.scene, camera, viewport, overscan, lift);
    const level = lift
      ? previewLevelPixels(cache.scene.width, cache.scene.height, camera, viewport)
      : 0;
    const raisedPolygon = lift
      ? [
          -overscan,
          -overscan + Math.min(0, lift.minimum) * level,
          viewport.width + overscan,
          -overscan + Math.min(0, lift.minimum) * level,
          viewport.width + overscan,
          viewport.height + overscan + Math.max(0, lift.maximum) * level,
          -overscan,
          viewport.height + overscan + Math.max(0, lift.maximum) * level,
        ]
      : viewportPolygon;
    for (const chunk of visibleTerrainChunks(range, cache.scene.width, cache.scene.height)) {
      if (!terrainChunkIntersectsViewport(chunk, cache.scene, camera, viewport, raisedPolygon)) {
        continue;
      }
      const key = `${chunk.minimumX}:${chunk.minimumY}`;
      if (!visibleKeys.has(key)) visibleChunks.push(chunk);
      visibleKeys.add(key);
      if (raised || cache.chunks.has(key)) continue;
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
  requestPreviewRender(cache.container);
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
  requestPreviewRender(layer);
}

const tileGridLayers = new WeakMap<Container, TileGridLayer | RaisedTileGrid>();

function syncTileGrid(
  cache: TerrainChunkCache,
  enabled: boolean,
  color: TileGridColor,
  host: HTMLElement,
  fade: OverlayFade<true>,
): void {
  host.dataset.tileGrid = enabled ? 'on' : 'off';
  const target = {
    setOpacity: (visibility: number) => cache.tileGrid?.setVisibility(visibility),
    clear: () => removeTileGrid(cache, host),
  };
  if (fade.show(enabled ? true : null) === null) {
    fade.attach(target);
    removeTileGrid(cache, host);
    return;
  }
  if (!cache.tileGrid && cache.raised) {
    const grid = new RaisedTileGrid(
      cache.scene.width,
      cache.scene.height,
      cache.raised.uniforms,
      color,
      cache.container,
    );
    cache.tileGrid = grid;
    tileGridLayers.set(cache.container, grid);
  } else if (!cache.tileGrid) {
    const layer = new TileGridLayer(cache.scene.width, cache.scene.height, color);
    layer.container.zIndex = 1.1;
    cache.container.sortableChildren = true;
    cache.container.addChild(layer.container);
    cache.tileGrid = layer;
    tileGridLayers.set(cache.container, layer);
  } else {
    cache.tileGrid.setColor(color);
  }
  host.dataset.tileGridLines = String(cache.tileGrid.lineCount);
  fade.attach(target);
}

function removeTileGrid(cache: TerrainChunkCache, host: HTMLElement): void {
  if (cache.tileGrid) {
    tileGridLayers.delete(cache.container);
    cache.tileGrid.destroy();
    cache.tileGrid = null;
  }
  delete host.dataset.tileGridLines;
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
  if (cache.raised) {
    cache.raised.layer?.destroy();
    cache.raised.layer = null;
    cache.chunks.delete(raisedChunkKey);
  }
  destroyPixiTree(cache.container);
  for (const chunk of cache.chunks.values()) chunk.texture.destroy(false);
  cache.chunks.clear();
  cache.terrainSource?.destroy();
  cache.terrainSource = null;
}

const raisedChunkKey = 'raised';

function coverCommittedLayers(
  terrain: Container | null,
  mapLayer: Container | null,
  covered: boolean,
): void {
  for (const layer of [terrain, mapLayer]) {
    if (!layer || layer.destroyed || layer.renderable === !covered) continue;
    layer.renderable = !covered;
    requestPreviewRender(layer);
  }
}

function coveredCommittedTerrain(
  terrain: Container | null,
  morphTerrain: Container | null,
): Container | null {
  return terrain && terrain === morphTerrain ? null : terrain;
}

function committedMorphPicture(cache: TerrainChunkCache): MorphTerrainData | null {
  const { width, height } = cache.scene;
  const raised = cache.raised;
  if (raised) {
    return raised.texels ? { texels: raised.texels, width, height, surface: raised.surface } : null;
  }
  const texels = cache.terrainSource?.resource;
  return texels instanceof Uint8Array && texels.length === width * height * 4
    ? { texels, width, height, surface: null }
    : null;
}

function writeCandidateRaisedDataset(
  host: HTMLElement,
  layer: PreviewCandidateLayer,
  scene: Pick<TopDownScene, 'width' | 'height'>,
  viewport: PreviewViewport,
  camera: PreviewCamera,
): void {
  host.dataset.candidateRaised = layer.raisedSurface ? 'on' : 'off';
  host.dataset.candidateRaisedDrawnChunks = String(layer.drawnRaisedChunks);
  writeRaisedProbe(host, layer.raisedSurface, scene, camera, viewport, 'candidateRaisedProbe');
}

function writeRaisedProbe(
  host: HTMLElement,
  surface: ElevationSurface | null,
  scene: Pick<TopDownScene, 'width' | 'height'>,
  camera: PreviewCamera,
  viewport: PreviewViewport,
  name: 'raisedProbe' | 'candidateRaisedProbe' = 'raisedProbe',
): void {
  if (!surface || surface.width !== scene.width || surface.height !== scene.height) {
    delete host.dataset[name];
    return;
  }
  let best: { index: number; x: number; y: number } | null = null;
  const inset = 24;
  const range = visibleTileRange(scene, camera, viewport, 0, surface);
  for (let tileY = range.minimumY; tileY <= range.maximumY; tileY += 1) {
    for (let tileX = range.minimumX; tileX <= range.maximumX; tileX += 1) {
      const index = tileY * scene.width + tileX;
      if (best && surface.elevation[index]! <= surface.elevation[best.index]!) continue;
      const height = surface.heightAt(tileX + 0.5, tileY + 0.5);
      const screen = raisedMapToScreen(
        { x: tileX + 0.5, y: tileY + 0.5 },
        height,
        scene.width,
        scene.height,
        camera,
        viewport,
      );
      if (
        screen.x < inset ||
        screen.y < inset ||
        screen.x > viewport.width - inset ||
        screen.y > viewport.height - inset ||
        !surface.pointVisible(tileX + 0.5, tileY + 0.5, height)
      ) {
        continue;
      }
      best = { index, x: screen.x, y: screen.y };
    }
  }
  if (!best) {
    delete host.dataset[name];
    return;
  }
  host.dataset[name] =
    `${best.x.toFixed(2)},${best.y.toFixed(2)},${best.index % scene.width},${Math.floor(best.index / scene.width)}`;
}

function writeRaisedDataset(host: HTMLElement, cache: TerrainChunkCache): void {
  const raised = cache.raised;
  host.dataset.raisedTerrain = raised ? 'on' : 'off';
  if (!raised) {
    for (const key of [
      'raisedSteps',
      'raisedWalls',
      'raisedMinimum',
      'raisedMaximum',
      'raisedColorQuads',
      'raisedColorWalls',
      'raisedColorBuildMs',
      'raisedColorChunks',
      'raisedColorDrawnChunks',
      'raisedColorTriangles',
      'raisedColorDrawnTriangles',
    ]) {
      delete host.dataset[key];
    }
    return;
  }
  host.dataset.raisedSteps = String(raised.surface.hasSteps);
  host.dataset.raisedWalls = String(raised.surface.wallCount);
  host.dataset.raisedMinimum = String(raised.surface.minimum);
  host.dataset.raisedMaximum = String(raised.surface.maximum);
}

function destroyStageChildren(children: ContainerChild[]): void {
  for (const child of children) destroyPixiTree(child);
}

function sameMapCoordinate(
  left: { x: number; y: number } | null,
  right: { x: number; y: number } | null,
): boolean {
  return (
    left === right || (left !== null && right !== null && left.x === right.x && left.y === right.y)
  );
}

function writeSelectionDataset(container: HTMLElement, selection: PreviewSelection | null): void {
  if (selection) {
    container.dataset.selectionOutlineStyle = 'perimeter';
    container.dataset.selectionRange = `${selection.minimumX},${selection.minimumY}:${selection.maximumX},${selection.maximumY}`;
  } else {
    delete container.dataset.selectionOutlineStyle;
    delete container.dataset.selectionRange;
  }
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
  const markers = markerCoverages.get(layer);
  if (markers && markers.viewport === viewport && !markers.coverage.covers(targetCamera)) {
    markers.extend(targetCamera);
  }
  layer.scale.set(transform.scale);
  layer.position.set(transform.x, transform.y);
  zoomMarkerMeshes(layer, transform.scale);
  requestPreviewRender(layer);
  const host = connectionProbeHosts.get(layer);
  if (host) writeConnectionProbes(host, layer);
}

const noPreviewInsets = { insetLeft: 0, insetRight: 0 } as const;
const noPreviewFocus = {
  focusInsetLeft: 0,
  focusInsetRight: 0,
  editorInsetLeft: 0,
  editorInsetRight: 0,
} as const;

function previewFocusInsets(
  container: HTMLElement,
  width: number,
  eased: boolean,
): {
  focusInsetLeft: number;
  focusInsetRight: number;
  editorInsetLeft: number;
  editorInsetRight: number;
} {
  const covered = previewEditorInsets(container, width);
  if (covered.insetLeft === 0 && covered.insetRight === 0) return noPreviewFocus;
  let shown: number;
  if (eased) {
    const hidden = Number.parseFloat(
      getComputedStyle(container).getPropertyValue('--editor-hidden-amount'),
    );
    shown = 1 - Math.min(1, Math.max(0, Number.isFinite(hidden) ? hidden : 0));
  } else {
    const workspace = container.closest<HTMLElement>('.fixed-workspace');
    shown = workspace?.dataset.editorShown === 'false' ? 0 : 1;
  }
  return {
    focusInsetLeft: covered.insetLeft * shown,
    focusInsetRight: covered.insetRight * shown,
    editorInsetLeft: covered.insetLeft,
    editorInsetRight: covered.insetRight,
  };
}

function previewLayoutSwitching(region: HTMLElement | null): boolean {
  if (!region) return false;
  const { layout, layoutFrom } = region.dataset;
  return (
    isPreviewLayout(layout) &&
    isPreviewLayout(layoutFrom) &&
    previewLayoutSwitchGlides(layout, layoutFrom)
  );
}

function previewLayoutSwitchAt(
  container: HTMLElement,
  width: number,
  height: number,
): { settled: PreviewCanvasSize } {
  const behindEditor = previewLaidOutBehindEditor(container);
  return {
    settled: {
      width,
      height,
      ...(behindEditor ? noPreviewInsets : previewEditorInsets(container, width)),
      behindEditor,
      ...(behindEditor ? previewFocusInsets(container, width, false) : noPreviewFocus),
    },
  };
}

function previewLayoutSwitchShare(container: HTMLElement, region: HTMLElement | null): number {
  if (!previewLayoutSwitching(region)) return 1;
  const overlay = Number.parseFloat(
    getComputedStyle(container).getPropertyValue('--workspace-overlay'),
  );
  if (!Number.isFinite(overlay)) return 1;
  const amount = Math.min(1, Math.max(0, overlay));
  return previewLaidOutBehindEditor(container) ? amount : 1 - amount;
}

const layoutSwitchPlanLifetimeMs = 2000;

function previewRegionReach(container: HTMLElement): number {
  const region = container.closest<HTMLElement>('.workspace-preview-region');
  if (!region) return 0;
  return Math.max(0, -Number.parseFloat(getComputedStyle(region).marginLeft) || 0);
}

function previewUnrevealedInsets(
  container: HTMLElement,
  width: number,
): { insetLeft: number; insetRight: number } {
  const covered = previewEditorInsets(container, width);
  if (covered.insetLeft === 0 && covered.insetRight === 0) return noPreviewInsets;
  const overlay = Number.parseFloat(
    getComputedStyle(container).getPropertyValue('--workspace-overlay'),
  );
  const unrevealed = 1 - Math.min(1, Math.max(0, Number.isFinite(overlay) ? overlay : 1));
  return {
    insetLeft: covered.insetLeft * unrevealed,
    insetRight: covered.insetRight * unrevealed,
  };
}

function previewEditorInsets(
  container: HTMLElement,
  width: number,
): { insetLeft: number; insetRight: number } {
  const region = container.closest<HTMLElement>('.workspace-preview-region');
  if (!region) return { insetLeft: 0, insetRight: 0 };
  const style = getComputedStyle(region);
  const covered = (margin: string) =>
    Math.min(width, Math.max(0, Math.round(-parseFloat(margin) || 0)));
  return { insetLeft: covered(style.marginLeft), insetRight: covered(style.marginRight) };
}

function previewLaidOutBehindEditor(container: HTMLElement): boolean {
  const layout = container.closest<HTMLElement>('.workspace-preview-region')?.dataset.layout;
  return layout === 'behind-editor';
}

function laidOutPreviewFocus(viewport: PreviewViewport): {
  focusInsetLeft: number;
  focusInsetRight: number;
  editorInsetLeft: number;
  editorInsetRight: number;
} {
  return {
    focusInsetLeft: viewport.focusInsetLeft ?? 0,
    focusInsetRight: viewport.focusInsetRight ?? 0,
    editorInsetLeft: viewport.editorInsetLeft ?? 0,
    editorInsetRight: viewport.editorInsetRight ?? 0,
  };
}

function previewRegionShowsPreview(container: HTMLElement): boolean {
  const layout = container.closest<HTMLElement>('.workspace-preview-region')?.dataset.layout;
  return !isPreviewLayout(layout) || previewLayoutShowsPreview(layout);
}

function workspaceEditorRegion(container: HTMLElement): HTMLElement | null {
  return (
    container
      .closest<HTMLElement>('.workspace-preview-region')
      ?.parentElement?.querySelector<HTMLElement>(':scope > .workspace-editor-region') ?? null
  );
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
