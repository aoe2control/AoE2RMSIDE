import {
  mapIconArtDensity,
  mapIconArtSize,
  mapIconRenderContract,
  mapIconRenderInputKeys,
  mapIconSpawnMarkerSizePercent,
  mapIconSpawnMarkerStyles,
  type GeneratedMapIconSaveRequest,
  type MapIconArtLayer,
  type ManualDeploymentMapIconMode,
  type ManualDeploymentMapIconPreview,
  type ManualDeploymentMapIconRender,
  type ManualDeploymentMapIconRequest,
  type MapIconRenderInput,
  type MapIconSpawnMarkerStyle,
  type PreviewGenerationResult,
} from '../shared/api';
import { t } from '../shared/i18n/translator';
import type { MapIconArtSheets } from './map-icon-art';
import { loadMapIconArtSheets } from './map-icon-art-sheets';
import {
  MapIconRenderError,
  mapIconNeedsArt,
  mapIconRenderIdentity,
  renderMapIcon,
} from './map-icon-render';

export interface MapIconOptionState {
  checked: boolean;
  mode: ManualDeploymentMapIconMode;
  settled: boolean;
}

export function resolveMapIconOption(
  preference: boolean | null,
  originalAvailable: boolean | null,
): MapIconOptionState {
  if (preference === null && originalAvailable === null) {
    return { checked: false, mode: 'retain-original', settled: false };
  }
  const checked = preference ?? originalAvailable === false;
  return { checked, mode: checked ? 'generate' : 'retain-original', settled: true };
}

export function mapIconRequestFor(
  mode: ManualDeploymentMapIconMode,
  icon: DeploymentMapIcon | null,
  exactResult: PreviewGenerationResult | null,
  input: MapIconRenderInput,
): ManualDeploymentMapIconRequest | null {
  if (mode !== 'generate') return { mode };
  if (!icon || !exactResult || icon.result !== exactResult) return null;
  if (icon.render.sourceSemanticHash !== exactResult.semanticHash) return null;
  if (!sameMapIconRenderInput(icon.render, input)) return null;
  return { mode: 'generate', render: icon.render };
}

export function sameMapIconRenderInput(left: MapIconRenderInput, right: MapIconRenderInput) {
  return mapIconRenderInputKeys.every((key) => left[key] === right[key]);
}

export function mapIconReliefLabel(): string {
  return t('map-icon.relief');
}

export function mapIconReliefActionLabel(relief: boolean): string {
  return relief ? t('map-icon.relief.hide') : t('map-icon.relief.show');
}

export function mapIconTerrainSmoothingLabel(): string {
  return t('map-icon.terrain-smoothing');
}

export function mapIconRandomSeedLabel(): string {
  return t('map-icon.random-seed');
}

export function mapIconSpawnMarkersLabel(spawnMarkers: MapIconSpawnMarkerStyle): string {
  switch (spawnMarkers) {
    case 'player-squares':
      return t('map-icon.spawn-markers.player-squares');
    case 'nomad-feet':
      return t('map-icon.spawn-markers.nomad-feet');
    default:
      return t('map-icon.spawn-markers.hidden');
  }
}

export function nextMapIconSpawnMarkers(
  spawnMarkers: MapIconSpawnMarkerStyle,
): MapIconSpawnMarkerStyle {
  const index = mapIconSpawnMarkerStyles.indexOf(spawnMarkers);
  return mapIconSpawnMarkerStyles[(index + 1) % mapIconSpawnMarkerStyles.length]!;
}

export function mapIconSpawnMarkerSizeLabel(): string {
  return t('map-icon.spawn-size');
}

export function mapIconArtLayerLabel(layer: MapIconArtLayer): string {
  return layer === 'trees' ? t('map-icon.art.trees.show') : t('map-icon.art.resources.show');
}

export function mapIconArtLayerActionLabel(layer: MapIconArtLayer, shown: boolean): string {
  return layer === 'trees'
    ? shown
      ? t('map-icon.art.trees.hide')
      : t('map-icon.art.trees.show')
    : shown
      ? t('map-icon.art.resources.hide')
      : t('map-icon.art.resources.show');
}

export function mapIconArtLayerOptionsLabel(layer: MapIconArtLayer): string {
  return layer === 'trees' ? t('map-icon.art.trees.options') : t('map-icon.art.resources.options');
}

export function mapIconArtDensityLabel(layer: MapIconArtLayer): string {
  return layer === 'trees' ? t('map-icon.art.trees.amount') : t('map-icon.art.resources.amount');
}
export function mapIconArtDensityEnds(): { minimum: string; maximum: string } {
  return { minimum: t('map-icon.art.amount.fewer'), maximum: t('map-icon.art.amount.more') };
}

export function mapIconArtDensityValueText(density: number): string {
  const { minimum, maximum } = mapIconArtDensity;
  if (density <= minimum) return t('map-icon.art.amount.one-per-kind');
  if (density >= maximum) return t('map-icon.art.amount.one-per-object');
  const third = (maximum - minimum) / 3;
  return density < minimum + third
    ? t('map-icon.art.amount.few')
    : density < minimum + 2 * third
      ? t('map-icon.art.amount.medium')
      : t('map-icon.art.amount.many');
}

export function mapIconArtSizeLabel(layer: MapIconArtLayer): string {
  return layer === 'trees' ? t('map-icon.art.trees.size') : t('map-icon.art.resources.size');
}
export function mapIconArtSizeEnds(): { minimum: string; maximum: string } {
  return { minimum: t('map-icon.art.size.smaller'), maximum: t('map-icon.art.size.larger') };
}

export function mapIconArtSizeValueText(size: number): string {
  const { minimum, maximum } = mapIconArtSize;
  if (size <= minimum) return t('map-icon.art.size.smallest');
  if (size >= maximum) return t('map-icon.art.size.largest');
  if (size === mapIconArtSize.default) return t('map-icon.art.size.medium');
  return size < mapIconArtSize.default
    ? t('map-icon.art.size.small')
    : t('map-icon.art.size.large');
}

export function clampMapIconArtSize(value: number): number {
  const { minimum, maximum } = mapIconArtSize;
  if (!Number.isFinite(value)) return mapIconArtSize.default;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

export function mapIconArtSpawnOverlapLabel(): string {
  return t('map-icon.art.spawn-overlap');
}

export const mapIconArtLayerFields = Object.freeze({
  trees: Object.freeze({
    shown: 'trees',
    density: 'treeDensity',
    size: 'treeSize',
    overlap: 'treeSpawnOverlap',
  } as const),
  resources: Object.freeze({
    shown: 'resources',
    density: 'resourceDensity',
    size: 'resourceSize',
    overlap: 'resourceSpawnOverlap',
  } as const),
});

export function clampMapIconArtDensity(value: number): number {
  const { minimum, maximum } = mapIconArtDensity;
  if (!Number.isFinite(value)) return mapIconArtDensity.default;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

export function stepMapIconSpawnMarkerSize(
  current: number,
  action: 'decrement' | 'increment' | 'minimum' | 'maximum',
): number | null {
  const { minimum, maximum, step } = mapIconSpawnMarkerSizePercent;
  const next =
    action === 'minimum'
      ? minimum
      : action === 'maximum'
        ? maximum
        : Math.min(maximum, Math.max(minimum, current + (action === 'increment' ? step : -step)));
  return next === current ? null : next;
}

export interface MapIconSwitchAvailability {
  checked: boolean;
  sourceSelected: boolean;
  exactPending: boolean;
  exactResultAvailable: boolean;
  renderError: string | null;
}

export function mapIconSwitchDisabledReason(state: MapIconSwitchAvailability): string | null {
  if (!state.sourceSelected) return t('map-icon.switch.no-source');
  if (state.checked || state.exactPending) return null;
  if (!state.exactResultAvailable) return t('map-icon.switch.needs-preview');
  return state.renderError ? t('map-icon.switch.unavailable', { reason: state.renderError }) : null;
}

export function previewMatchesMapIconRequest(
  preview: ManualDeploymentMapIconPreview | null | undefined,
  request: ManualDeploymentMapIconRequest | null,
): boolean {
  if (!preview || !request || preview.mode !== request.mode) return false;
  return request.mode !== 'generate' || preview.renderIdentity === request.render?.identity;
}

export function mapIconSourceDescription(
  preview: ManualDeploymentMapIconPreview | null | undefined,
): string {
  if (!preview) return t('map-icon.status.waiting');
  const file = String(preview.path ? (preview.path.split('/').pop() ?? preview.path) : null);
  switch (preview.source) {
    case 'generated':
      return preview.originalAvailable
        ? t('map-icon.status.generated-replacing', { file })
        : t('map-icon.status.generated', { file });
    case 'original':
      return t('map-icon.status.original', { file });
    default:
      return t('map-icon.status.none');
  }
}

export function mapIconTreeAnnotations(
  preview: ManualDeploymentMapIconPreview | null | undefined,
): ReadonlyMap<string, string> {
  if (!preview?.path || preview.source === 'none') return new Map();
  return new Map([
    [
      preview.path,
      preview.source === 'generated' ? t('map-icon.tree.generated') : t('map-icon.tree.original'),
    ],
  ]);
}

export interface DeploymentMapIcon {
  result: PreviewGenerationResult;
  render: ManualDeploymentMapIconRender;
}

export async function renderDeploymentMapIcon(
  result: PreviewGenerationResult,
  input: MapIconRenderInput,
  signal: AbortSignal,
  loadArt: () => Promise<MapIconArtSheets> = loadMapIconArtSheets,
): Promise<DeploymentMapIcon> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  throwIfCancelled(signal);
  let art: MapIconArtSheets | null = null;
  if (mapIconNeedsArt(input)) {
    try {
      art = await loadArt();
    } catch {
      throw new MapIconRenderError('art-unavailable', 'map icon sprite sheets could not be loaded');
    }
    throwIfCancelled(signal);
  }
  const render = renderMapIcon(result, input, { signal, art });
  const identity = await mapIconRenderIdentity(render);
  throwIfCancelled(signal);
  return {
    result,
    render: {
      contractVersion: render.contractVersion,
      perspective: render.perspective,
      look: render.look,
      relief: render.relief,
      terrainSmoothing: render.terrainSmoothing,
      spawnMarkers: render.spawnMarkers,
      spawnMarkerSizePercent: render.spawnMarkerSizePercent,
      trees: render.trees,
      treeDensity: render.treeDensity,
      treeSize: render.treeSize,
      treeSpawnOverlap: render.treeSpawnOverlap,
      resources: render.resources,
      resourceDensity: render.resourceDensity,
      resourceSize: render.resourceSize,
      resourceSpawnOverlap: render.resourceSpawnOverlap,
      sourceSemanticHash: render.sourceSemanticHash,
      identity,
      pixels: render.pixels,
    },
  };
}

export async function gameTexturesDeploymentMapIcon(
  result: PreviewGenerationResult,
  input: MapIconRenderInput,
  textured: { pixels: Uint8ClampedArray; source: string },
): Promise<DeploymentMapIcon> {
  if (input.look !== 'game-textures') {
    throw new MapIconRenderError('invalid-input', 'map icon look is not game textures');
  }
  const render: ManualDeploymentMapIconRender = {
    contractVersion: mapIconRenderContract.version,
    perspective: input.perspective,
    look: input.look,
    relief: input.relief,
    terrainSmoothing: input.terrainSmoothing,
    spawnMarkers: input.spawnMarkers,
    spawnMarkerSizePercent: input.spawnMarkerSizePercent,
    trees: input.trees,
    treeDensity: input.treeDensity,
    treeSize: input.treeSize,
    treeSpawnOverlap: input.treeSpawnOverlap,
    resources: input.resources,
    resourceDensity: input.resourceDensity,
    resourceSize: input.resourceSize,
    resourceSpawnOverlap: input.resourceSpawnOverlap,
    sourceSemanticHash: result.semanticHash,
    gameTexturesSource: textured.source,
    identity: '',
    pixels: textured.pixels,
  };
  render.identity = await mapIconRenderIdentity(render);
  return { result, render };
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new MapIconRenderError('cancelled', 'map icon render was cancelled');
}

export type MapIconFrameContent = 'generated' | 'original' | 'placeholder';

export function mapIconFrameContent(
  checked: boolean,
  generatedRenderAvailable: boolean,
  preview: ManualDeploymentMapIconPreview | null | undefined,
): MapIconFrameContent {
  if (checked) return generatedRenderAvailable ? 'generated' : 'placeholder';
  return preview?.source === 'original' ? 'original' : 'placeholder';
}

export function mapIconSaveAvailable(
  content: MapIconFrameContent,
  preview: ManualDeploymentMapIconPreview | null | undefined,
): boolean {
  return content !== 'placeholder' && preview?.source === content && preview.path !== null;
}

export type MapIconSaveTarget =
  { kind: 'generated'; request: GeneratedMapIconSaveRequest } | { kind: 'plan'; token: string };

export interface MapIconSaveState {
  content: MapIconFrameContent;
  pending: boolean;
  boundResult: PreviewGenerationResult | null;
  render: ManualDeploymentMapIconRender | null;
  preview: { token: string; mapIcon: ManualDeploymentMapIconPreview } | null;
}

export function mapIconSaveTarget(state: MapIconSaveState): MapIconSaveTarget | null {
  if (state.pending) return null;
  if (state.content === 'generated') {
    if (!state.render || !state.boundResult) return null;
    const result = state.boundResult;
    return {
      kind: 'generated',
      request: {
        documentUri: result.documentUri,
        documentRevision: result.documentRevision,
        sourceCatalogRevision: result.sourceCatalogRevision,
        sourceCatalogHash: result.sourceCatalogHash,
        sourceGraphHash: result.sourceGraphHash,
        externalAssetHash: result.externalAssetHash,
        render: state.render,
      },
    };
  }
  return state.preview && mapIconSaveAvailable(state.content, state.preview.mapIcon)
    ? { kind: 'plan', token: state.preview.token }
    : null;
}

export type MapIconFrameState = 'ready' | 'original' | 'empty' | 'generating';

export interface MapIconProgressInput {
  checked: boolean;
  seedGenerating: boolean;
  exactPending: boolean;
  rendering: boolean;
  retainedPixels: boolean;
}

export function mapIconShowsGenerating(state: MapIconProgressInput): boolean {
  if (!state.checked) return false;
  return state.seedGenerating || state.exactPending || (state.rendering && !state.retainedPixels);
}

export function mapIconFrameState(
  content: MapIconFrameContent,
  originalDecoded: boolean,
  generating = false,
): MapIconFrameState {
  if (generating && content !== 'original') return 'generating';
  if (content === 'generated') return 'ready';
  return content === 'original' && originalDecoded ? 'original' : 'empty';
}

export function mapIconFrameLabel(state: MapIconFrameState, content: MapIconFrameContent): string {
  if (state === 'generating') return t('map-icon.frame.generating');
  if (state === 'ready') return t('map-icon.frame.ready');
  if (state === 'original') return t('map-icon.frame.original');
  return content === 'original'
    ? t('map-icon.frame.original-unavailable')
    : t('map-icon.frame.none');
}
