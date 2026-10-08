import { useEffect, useMemo, useRef, useState } from 'react';
import {
  gameArtLookOffered,
  nextPreviewLook,
  type GameArtStatus,
  type GameArtTerrainIndex,
} from '../shared/game-art';
import {
  mapIconGameTexturesSourcePattern,
  mapIconRenderContract,
  mapIconRenderInputKeys,
  type MapIconRenderInput,
  type MapIconRenderLook,
  type PreviewGenerationResult,
} from '../shared/api';
import { t } from '../shared/i18n/translator';
import { drawTerrainChunk, planTerrainChunk } from './game-art-terrain';
import { GameArtAssetStore, loadTerrainSources } from './game-art-resources';
import type { MapIconArtSheets } from './map-icon-art';
import { loadMapIconArtSheets } from './map-icon-art-sheets';
import {
  mapIconNeedsArt,
  mapIconProjection,
  mapIconScreenPoint,
  renderMapIconArtLayer,
  type MapIconProjection,
} from './map-icon-render';
import { cliffMaterial, terrainMaterial } from './preview-materials';
import { terrainElevationOverlay } from './preview-terrain-mesh';
import { decodeTopDownScene, type TopDownScene } from './top-down-preview';
import { useGameArtPreparation, useGameArtStatus } from './use-game-art';

export type MapIconLook = MapIconRenderLook;

export function mapIconLookLabel(look: MapIconLook): string {
  if (look === 'game-textures') return t('map-icon.look.game-textures');
  return look === 'texture-colors' ? t('map-icon.look.texture-colors') : t('map-icon.look.minimap');
}

export function mapIconLookTooltip(look: MapIconLook): string {
  return mapIconLookLabel(look);
}

export function mapIconGameTexturesFallbackNote(): string {
  return t('map-icon.look.fallback');
}

export function nextMapIconLook(look: MapIconLook, offered: boolean): MapIconLook {
  return nextPreviewLook(look, offered);
}

export function effectiveMapIconLook(look: MapIconLook, available: boolean): MapIconLook {
  return look === 'game-textures' && !available ? 'texture-colors' : look;
}

export function mapIconPerspectiveLabel(perspective: MapIconRenderInput['perspective']): string {
  return perspective === 'diamond'
    ? t('map-icon.perspective.diamond')
    : t('map-icon.perspective.top-down');
}

export const mapIconGameTexturesCanvasLimit = 2048;

export function mapIconGameTexturesPixelsPerTile(dimension: number): number {
  return Math.max(
    1,
    Math.min(8, Math.floor(mapIconGameTexturesCanvasLimit / Math.max(1, dimension))),
  );
}

export function mapIconTextureTransform(
  projection: MapIconProjection,
  pixelsPerTile: number,
): [number, number, number, number, number, number] {
  const { component, verticalComponent, centerX, centerY, halfMapWidth, halfMapHeight } =
    projection;
  const r = pixelsPerTile;
  return [
    component / r,
    -verticalComponent / r,
    component / r,
    verticalComponent / r,
    centerX - component * (halfMapWidth + halfMapHeight),
    centerY - verticalComponent * (halfMapHeight - halfMapWidth),
  ];
}

export interface MapIconGameTexturesRender {
  pixels: Uint8ClampedArray;
  source: string;
}

export interface MapIconGameTexturesState {
  offered: boolean;
  render: MapIconGameTexturesRender | null;
  pending: boolean;
  failed: boolean;
}

export function mapIconGameTexturesFailed(state: {
  wanted: boolean;
  status: GameArtStatus;
  indexFailed: boolean;
  requestFailed: boolean;
}): boolean {
  return (
    state.wanted &&
    (state.status.state === 'failed' ||
      state.status.state === 'unavailable' ||
      state.indexFailed ||
      state.requestFailed)
  );
}

export function mapIconGameTexturesPending(state: {
  wanted: boolean;
  status: GameArtStatus;
  sceneDecoded: boolean;
  indexFailed: boolean;
  requestFailed: boolean;
  bitmapReady: boolean;
}): boolean {
  const statusUsable =
    state.status.state === 'idle' ||
    state.status.state === 'preparing' ||
    state.status.state === 'ready';
  return (
    state.wanted &&
    statusUsable &&
    state.sceneDecoded &&
    !state.indexFailed &&
    !state.requestFailed &&
    !state.bitmapReady
  );
}

export function useMapIconGameTextures(options: {
  enabled: boolean;
  result: PreviewGenerationResult | null;
  input: MapIconRenderInput | null;
}): MapIconGameTexturesState {
  const { enabled, result, input } = options;
  const status = useGameArtStatus();
  const offered = gameArtLookOffered(status);
  const wanted = enabled && offered && result !== null && input !== null;
  const storeRef = useRef<GameArtAssetStore | null>(null);
  storeRef.current ??= new GameArtAssetStore(window.rmside);
  const store = storeRef.current;

  useGameArtPreparation(status.state, wanted, result);

  const revision = status.state === 'ready' ? status.revision : null;
  const [index, setIndex] = useState<GameArtTerrainIndex | null>(null);
  const [indexFailed, setIndexFailed] = useState(false);
  useEffect(() => {
    setIndexFailed(false);
    if (!wanted || revision === null) {
      setIndex(null);
      return undefined;
    }
    let current = true;
    void window.rmside
      .getGameArtTerrain()
      .then((next) => {
        if (!current) return;
        const usable =
          next !== null &&
          next.source !== undefined &&
          mapIconGameTexturesSourcePattern.test(next.source);
        setIndex(usable ? next : null);
        if (!usable) setIndexFailed(true);
      })
      .catch(() => {
        if (!current) return;
        setIndex(null);
        setIndexFailed(true);
      });
    return () => {
      current = false;
    };
  }, [revision, wanted]);

  const treesShown = input?.trees ?? false;
  const scene = useMemo(() => {
    if (!wanted || !result) return null;
    try {
      return decodeTopDownScene(result, { appearances: treesShown });
    } catch {
      return null;
    }
  }, [result, treesShown, wanted]);

  const [rendered, setRendered] = useState<{
    key: string;
    render: MapIconGameTexturesRender;
  } | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const requestKey =
    wanted && index && scene && result && input
      ? [
          index.revision,
          index.source,
          result.semanticHash,
          ...mapIconRenderInputKeys.map((key) => String(input[key])),
        ].join('\0')
      : null;
  useEffect(() => {
    if (!requestKey || !index || !scene || !result || !input) return undefined;
    let current = true;
    const minimapColor = (terrainId: number) =>
      terrainMaterial(terrainId, result.backend, result.minimapPalette, result.terrainNames).color;
    const used = new Set<number>(scene.terrainIds);
    for (const layer of scene.layerIds) if (layer !== 0xffff) used.add(layer);
    const art = mapIconNeedsArt(input)
      ? loadMapIconArtSheets().catch(() => null)
      : Promise.resolve(null);
    void Promise.all([loadTerrainSources(store, index, used, minimapColor), art])
      .then(([sources, sheets]) => {
        if (!current) return;
        store.retain(new Set(sources.assetKeys));
        const pixels = rasterizeMapIconGameTextures(scene, result, input, sources, sheets);
        if (!current) return;
        if (!pixels || !index.source) {
          setFailedKey(requestKey);
          setRendered(null);
          return;
        }
        setRendered({ key: requestKey, render: { pixels, source: index.source } });
      })
      .catch(() => {
        if (!current) return;
        setFailedKey(requestKey);
        setRendered(null);
      });
    return () => {
      current = false;
    };
  }, [index, input, requestKey, result, scene, store]);

  useEffect(() => {
    if (wanted) return;
    setRendered(null);
    store.retain(new Set());
  }, [store, wanted]);

  useEffect(
    () => () => {
      store.retain(new Set());
    },
    [store],
  );

  const render = rendered && rendered.key === requestKey ? rendered.render : null;
  const requestFailed = requestKey !== null && failedKey === requestKey;
  const pending = mapIconGameTexturesPending({
    wanted,
    status,
    sceneDecoded: scene !== null,
    indexFailed,
    requestFailed,
    bitmapReady: render !== null,
  });
  const failed = mapIconGameTexturesFailed({ wanted, status, indexFailed, requestFailed });
  return { offered, render, pending, failed };
}

export function rasterizeMapIconGameTextures(
  scene: TopDownScene,
  result: Pick<PreviewGenerationResult, 'minimapPalette' | 'playerColorIds' | 'mapIconArtObjects'>,
  input: MapIconRenderInput,
  sources: Parameters<typeof drawTerrainChunk>[2],
  art: MapIconArtSheets | null = null,
): Uint8ClampedArray | null {
  const size = mapIconRenderContract.size;
  const r = mapIconGameTexturesPixelsPerTile(Math.max(scene.width, scene.height));
  const relief = input.relief;
  const plan = planTerrainChunk(
    {
      width: scene.width,
      height: scene.height,
      terrainIds: scene.terrainIds,
      layerIds: scene.layerIds,
    },
    { minimumX: 0, minimumY: 0, maximumX: scene.width - 1, maximumY: scene.height - 1 },
    sources.terrains,
    relief
      ? (x, y) =>
          terrainElevationOverlay(scene, x, y, {
            backgroundColor: 0,
            elevationMode: 'terrain',
            elevationRange: { minimum: 0, maximum: 0 },
          })
      : null,
    (mode) => Boolean(sources.atlases[mode]),
  );
  const terrain = new OffscreenCanvas(scene.width * r, scene.height * r);
  const terrainContext = terrain.getContext('2d');
  const icon = new OffscreenCanvas(size, size);
  const context = icon.getContext('2d');
  if (!terrainContext || !context) return null;
  drawTerrainChunk(terrainContext, plan, sources, r);
  const projection = mapIconProjection(scene.width, scene.height, input.perspective);
  context.save();
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.setTransform(...mapIconTextureTransform(projection, r));
  context.drawImage(terrain, 0, 0);
  context.restore();
  context.lineCap = 'butt';
  context.lineWidth = 3;
  for (const cliff of scene.cliffs) {
    const start = mapIconScreenPoint(cliff.from, projection);
    const end = mapIconScreenPoint(cliff.to, projection);
    context.strokeStyle = cssColor(
      cliffMaterial(cliff.cliffType, 'game-textures', result.minimapPalette).color,
    );
    context.beginPath();
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
    context.stroke();
  }
  if (art && mapIconNeedsArt(input)) {
    const layer = new OffscreenCanvas(size, size);
    const layerContext = layer.getContext('2d');
    if (layerContext) {
      const pixels = renderMapIconArtLayer(
        scene,
        {
          ...input,
          playerColorIds: result.playerColorIds,
          artObjects: result.mapIconArtObjects ?? [],
          art,
        },
        projection,
      );
      layerContext.putImageData(new ImageData(new Uint8ClampedArray(pixels), size, size), 0, 0);
      context.drawImage(layer, 0, 0);
    }
  }
  return new Uint8ClampedArray(context.getImageData(0, 0, size, size).data);
}

function cssColor(rgb: number): string {
  return `#${rgb.toString(16).padStart(6, '0')}`;
}
