import { useEffect, useMemo, useRef, useState } from 'react';
import {
  gameArtLookOffered,
  nextPreviewLook,
  type GameArtStatus,
  type GameArtTerrainIndex,
} from '../shared/game-art';
import {
  effectiveMapIconRelief,
  mapIconGameTexturesSourcePattern,
  mapIconRenderContract,
  mapIconRenderInputKeys,
  type MapIconRenderInput,
  type MapIconSaveSize,
  type MapIconRenderLook,
  type PreviewGenerationResult,
} from '../shared/api';
import { t } from '../shared/i18n/translator';
import { drawTerrainChunk, planTerrainChunk } from './game-art-terrain';
import {
  GameArtAssetStore,
  loadTerrainSources,
  type GameArtImageSource,
} from './game-art-resources';
import type { MapIconArtSheets } from './map-icon-art';
import { loadMapIconArtSheets } from './map-icon-art-sheets';
import {
  forEachRaisedIconPixel,
  litColor,
  mapIconDrawnLayers,
  mapIconNeedsArt,
  mapIconProjection,
  mapIconRaisedSurface,
  mapIconScreenPoint,
  renderMapIconArtLayer,
  type MapIconProjection,
} from './map-icon-render';
import { raisedLightStrength, raisedWallLight } from './preview-elevation';
import { cliffMaterial, previewHelperObjectIds, terrainMaterial } from './preview-materials';
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
  renderAtSize(size: MapIconSaveSize): MapIconGameTexturesRender | null;
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

  const treesShown = (input?.trees ?? false) || (input?.minimapObjects ?? false);
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
  const loadedRef = useRef<{
    key: string;
    sources: Parameters<typeof drawTerrainChunk>[2];
    sheets: MapIconArtSheets | null;
  } | null>(null);
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
    const art = mapIconNeedsArt(mapIconDrawnLayers(input))
      ? loadMapIconArtSheets().catch(() => null)
      : Promise.resolve(null);
    void Promise.all([loadTerrainSources(store, index, used, minimapColor), art])
      .then(([sources, sheets]) => {
        if (!current) return;
        store.retain(new Set(sources.assetKeys));
        loadedRef.current = { key: requestKey, sources, sheets };
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
    loadedRef.current = null;
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
  const renderAtSize = (size: MapIconSaveSize): MapIconGameTexturesRender | null => {
    const loaded = loadedRef.current;
    if (!render || !loaded || loaded.key !== requestKey || !scene || !result || !input) {
      return null;
    }
    if (size === mapIconRenderContract.size) return render;
    try {
      const pixels = rasterizeMapIconGameTextures(
        scene,
        result,
        input,
        loaded.sources,
        loaded.sheets,
        size,
      );
      return pixels ? { pixels, source: render.source } : null;
    } catch {
      return null;
    }
  };
  return { offered, render, pending, failed, renderAtSize };
}

export async function drawMapIconGameTextures(
  api: GameArtImageSource & {
    getGameArtStatus(): Promise<GameArtStatus>;
    getGameArtTerrain(): Promise<GameArtTerrainIndex | null>;
  },
  result: PreviewGenerationResult,
  input: MapIconRenderInput,
): Promise<MapIconGameTexturesRender | null> {
  const store = new GameArtAssetStore(api);
  try {
    const status = await api.getGameArtStatus();
    if (!gameArtLookOffered(status) || status.state !== 'ready') return null;
    const index = await api.getGameArtTerrain();
    const source = index?.source;
    if (!index || source === undefined || !mapIconGameTexturesSourcePattern.test(source)) {
      return null;
    }
    const scene = decodeTopDownScene(result, { appearances: input.trees || input.minimapObjects });
    const minimapColor = (terrainId: number) =>
      terrainMaterial(terrainId, result.backend, result.minimapPalette, result.terrainNames).color;
    const used = new Set<number>(scene.terrainIds);
    for (const layer of scene.layerIds) if (layer !== 0xffff) used.add(layer);
    const [sources, sheets] = await Promise.all([
      loadTerrainSources(store, index, used, minimapColor),
      mapIconNeedsArt(mapIconDrawnLayers(input))
        ? loadMapIconArtSheets().catch(() => null)
        : Promise.resolve(null),
    ]);
    const pixels = rasterizeMapIconGameTextures(scene, result, input, sources, sheets);
    return pixels ? { pixels, source } : null;
  } catch {
    return null;
  } finally {
    store.retain(new Set());
  }
}

export function rasterizeMapIconGameTextures(
  scene: TopDownScene,
  result: Pick<
    PreviewGenerationResult,
    | 'minimapPalette'
    | 'playerColorIds'
    | 'mapIconArtObjects'
    | 'objectNames'
    | 'graphiclessObjectIds'
  >,
  input: MapIconRenderInput,
  sources: Parameters<typeof drawTerrainChunk>[2],
  art: MapIconArtSheets | null = null,
  size: MapIconSaveSize = mapIconRenderContract.size,
): Uint8ClampedArray | null {
  const r = mapIconGameTexturesPixelsPerTile(Math.max(scene.width, scene.height));
  const raised = mapIconRaisedSurface(scene, input);
  const relief = effectiveMapIconRelief(input) !== 'off' && !raised;
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
  const projection = mapIconProjection(scene.width, scene.height, input.perspective, size);
  if (raised) {
    const texels = terrainContext.getImageData(0, 0, terrain.width, terrain.height);
    const image = context.createImageData(size, size);
    const strength = raisedLightStrength.gameTextures;
    forEachRaisedIconPixel(size, raised, projection, (px, py, hit) => {
      const light = hit.wall
        ? raisedWallLight(hit.wall, strength)
        : raised.smoothLightAt(hit.x, hit.y, strength);
      const color = litColor(sampleTexels(texels, hit.x * r - 0.5, hit.y * r - 0.5), light);
      const offset = (py * size + px) * 4;
      image.data[offset] = (color >> 16) & 0xff;
      image.data[offset + 1] = (color >> 8) & 0xff;
      image.data[offset + 2] = color & 0xff;
      image.data[offset + 3] = 255;
    });
    context.putImageData(image, 0, 0);
  } else {
    context.save();
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.setTransform(...mapIconTextureTransform(projection, r));
    context.drawImage(terrain, 0, 0);
    context.restore();
  }
  context.lineCap = 'butt';
  context.lineWidth = (3 * size) / mapIconRenderContract.size;
  for (const cliff of scene.cliffs) {
    const start = mapIconScreenPoint(cliff.from, projection);
    const end = mapIconScreenPoint(cliff.to, projection);
    if (raised) {
      start.y -= raised.heightAt(cliff.from.x, cliff.from.y) * projection.verticalComponent;
      end.y -= raised.heightAt(cliff.to.x, cliff.to.y) * projection.verticalComponent;
    }
    context.strokeStyle = cssColor(
      cliffMaterial(cliff.cliffType, 'game-textures', result.minimapPalette).color,
    );
    context.beginPath();
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
    context.stroke();
  }
  const drawn = mapIconDrawnLayers(input);
  const sprites = art !== null && mapIconNeedsArt(drawn);
  if (sprites || drawn.minimapObjects) {
    const layer = new OffscreenCanvas(size, size);
    const layerContext = layer.getContext('2d');
    if (layerContext) {
      const pixels = renderMapIconArtLayer(
        scene,
        {
          ...drawn,
          playerColorIds: result.playerColorIds,
          artObjects: result.mapIconArtObjects ?? [],
          minimapPalette: result.minimapPalette,
          helperObjectIds: previewHelperObjectIds(result, null),
          art,
          raised,
        },
        projection,
      );
      layerContext.putImageData(new ImageData(new Uint8ClampedArray(pixels), size, size), 0, 0);
      context.drawImage(layer, 0, 0);
    }
  }
  return new Uint8ClampedArray(context.getImageData(0, 0, size, size).data);
}

function sampleTexels(texels: ImageData, u: number, v: number): number {
  const { width, height, data } = texels;
  const x = Math.min(width - 1, Math.max(0, u));
  const y = Math.min(height - 1, Math.max(0, v));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  let color = 0;
  for (let channel = 0; channel < 3; channel += 1) {
    const at = (cx: number, cy: number) => data[(cy * width + cx) * 4 + channel]!;
    const value =
      (at(x0, y0) * (1 - fx) + at(x1, y0) * fx) * (1 - fy) +
      (at(x0, y1) * (1 - fx) + at(x1, y1) * fx) * fy;
    color |= Math.round(value) << (16 - channel * 8);
  }
  return color;
}

function cssColor(rgb: number): string {
  return `#${rgb.toString(16).padStart(6, '0')}`;
}
