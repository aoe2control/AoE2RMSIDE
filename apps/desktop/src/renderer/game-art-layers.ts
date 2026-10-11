import { Container } from 'pixi.js';
import { gameArtChunkBudget, gameArtSpriteBudget } from './game-art-resources';
import { GameArtCliffBandLayer } from './game-art-cliffs';
import { GameArtGpuTerrainLayer } from './game-art-gpu-terrain';
import { GameArtSpriteLayer } from './game-art-sprites';
import { requestPreviewRender } from './preview-render-scheduler';
import type { TeamColor } from './game-art-team-colors';
import { GameArtTerrainLayer } from './game-art-terrain';
import type { GpuMapUnavailableReason, MapRenderer } from './gpu-map-rendering';
import {
  heightMapObjectLightAt,
  lightTint,
  terrainElevationOverlay,
  type ElevationDisplayMode,
  type ElevationRange,
} from './preview-terrain-mesh';
import type { TopDownScene } from './top-down-preview';
import type { ElevationSurface } from './preview-elevation';
import type { RaisedTerrainUniforms } from './preview-raised-terrain';
import type { GameArtCliffView, GameArtSpriteView, GameArtTerrainView } from './use-game-art';

export type GameArtTerrainPicture = GameArtTerrainLayer | GameArtGpuTerrainLayer;

export interface GameArtPictureRaised {
  surface: ElevationSurface;
  uniforms: RaisedTerrainUniforms;
  overlayBias(): number;
}

export interface GameArtLayerCache {
  container: Container;
  chunks: ReadonlyMap<string, { container: Container }>;
  scene: TopDownScene;
  elevationRange: ElevationRange;
  gameArtTerrain: {
    view: GameArtTerrainView;
    layer: GameArtTerrainPicture;
    raised?: GameArtPictureRaised | null;
  } | null;
  gameArtSprites: { view: GameArtSpriteView; layer: GameArtSpriteLayer } | null;
  gameArtStore: { bytes: number } | null;
  gameArtCliffs: { view: GameArtCliffView; layer: GameArtCliffBandLayer } | null;
  gameArtPresentation: GameArtPresentationState;
}

interface OutgoingPicture {
  root: Container;
  layers: PictureLayer[];
  raised: GameArtPictureRaised | null;
}

interface PictureLayer {
  container: Container;
  destroy(): void;
}

export interface GameArtPresentationState {
  outgoing: OutgoingPicture | null;
  minimapShown: boolean;
  minimapHidden: boolean;
  kinds: { objects: boolean; cliffs: boolean };
  treeScale: number;
}

export function createGameArtPresentationState(): GameArtPresentationState {
  return {
    outgoing: null,
    minimapShown: false,
    minimapHidden: false,
    kinds: { objects: true, cliffs: true },
    treeScale: 1,
  };
}

export interface GameArtLayerInputs {
  expected: boolean;
  terrain: GameArtTerrainView | null;
  sprites: GameArtSpriteView | null;
  cliffBands: GameArtCliffView | null;
  store: { bytes: number };
  elevation: { backgroundColor: number; elevationMode: ElevationDisplayMode };
  teamColor(owner: number): TeamColor | null;
  renderer?: MapRenderer;
  maximumTextureSize?: number;
  onGpuUnavailable?(reason: GpuMapUnavailableReason): void;
  host: HTMLElement;
  onPresented(): void;
  raised?: { surface: ElevationSurface; uniforms: RaisedTerrainUniforms } | null;
}

const outgoingZIndex = 0.5;

function moveToOutgoing(
  cache: GameArtLayerCache,
  layers: PictureLayer[],
  raised: GameArtPictureRaised | null,
): void {
  const state = cache.gameArtPresentation;
  if (!state.outgoing) {
    const root = new Container({ label: 'game-textures-previous', sortableChildren: true });
    root.eventMode = 'none';
    root.zIndex = outgoingZIndex;
    cache.container.addChild(root);
    state.outgoing = { root, layers: [], raised };
  }
  for (const layer of layers) {
    state.outgoing.root.addChild(layer.container);
    state.outgoing.layers.push(layer);
  }
  state.outgoing.raised = raised;
}

export function gameArtStandIn(
  cache: GameArtLayerCache,
): { raised: GameArtPictureRaised | null } | null {
  const outgoing = cache.gameArtPresentation.outgoing;
  return outgoing ? { raised: outgoing.raised } : null;
}

function destroyOutgoing(state: GameArtPresentationState): void {
  const outgoing = state.outgoing;
  if (!outgoing) return;
  state.outgoing = null;
  for (const layer of outgoing.layers) layer.destroy();
  outgoing.root.destroy({ children: true });
}

function terrainPresented(cache: GameArtLayerCache): boolean {
  return cache.gameArtTerrain?.layer.presented ?? false;
}

function applyKindVisibility(cache: GameArtLayerCache): void {
  const presented = terrainPresented(cache);
  const { kinds } = cache.gameArtPresentation;
  const sprites = cache.gameArtSprites?.layer;
  if (sprites) {
    sprites.container.visible = presented;
    sprites.setKindVisibility(kinds);
    sprites.setTreeScale(cache.gameArtPresentation.treeScale);
  }
  const bands = cache.gameArtCliffs?.layer;
  if (bands) bands.container.visible = presented && kinds.cliffs;
}

export function setGameArtKindVisibility(
  cache: GameArtLayerCache,
  kinds: { objects: boolean; cliffs: boolean },
): void {
  cache.gameArtPresentation.kinds = { ...kinds };
  applyKindVisibility(cache);
}

export function setGameArtTreeScale(cache: GameArtLayerCache, factor: number): void {
  cache.gameArtPresentation.treeScale = factor;
  cache.gameArtSprites?.layer.setTreeScale(factor);
}

export function gameArtMarkerSkips(cache: GameArtLayerCache): {
  spriteObjects: ReadonlySet<number> | undefined;
  awaitingPresentation: boolean;
} {
  const sprites = cache.gameArtSprites?.layer;
  if (!sprites) return { spriteObjects: undefined, awaitingPresentation: false };
  if (cache.gameArtPresentation.minimapHidden) {
    return { spriteObjects: sprites.presentedObjects, awaitingPresentation: false };
  }
  return { spriteObjects: undefined, awaitingPresentation: true };
}

export function applyMinimapChunkVisibility(cache: GameArtLayerCache, expected: boolean): void {
  const state = cache.gameArtPresentation;
  const hidden =
    expected && (terrainPresented(cache) || state.outgoing !== null || !state.minimapShown);
  state.minimapHidden = hidden;
  for (const chunk of cache.chunks.values()) chunk.container.visible = !hidden;
}

export function syncGameArtLayers(cache: GameArtLayerCache, inputs: GameArtLayerInputs): void {
  const state = cache.gameArtPresentation;
  cache.container.sortableChildren = true;
  cache.gameArtStore = inputs.store;
  if (!inputs.expected) state.minimapShown = true;
  const renderer = inputs.renderer ?? 'cpu';
  const current = cache.gameArtTerrain;
  if (current && (current.view !== inputs.terrain || current.layer.renderer !== renderer)) {
    if (inputs.terrain && current.layer.presented) {
      const kept: PictureLayer[] = [current.layer];
      if (cache.gameArtSprites) kept.push(cache.gameArtSprites.layer);
      if (cache.gameArtCliffs) kept.push(cache.gameArtCliffs.layer);
      moveToOutgoing(cache, kept, current.raised ?? null);
      cache.gameArtSprites = null;
      cache.gameArtCliffs = null;
    } else {
      current.layer.destroy();
    }
    cache.gameArtTerrain = null;
  }
  if (!inputs.expected) destroyOutgoing(state);
  if (
    cache.gameArtSprites &&
    (cache.gameArtSprites.view !== inputs.sprites ||
      cache.gameArtSprites.layer.gpu !== (renderer === 'gpu'))
  ) {
    cache.gameArtSprites.layer.destroy();
    cache.gameArtSprites = null;
  }
  if (cache.gameArtCliffs && cache.gameArtCliffs.view !== inputs.cliffBands) {
    cache.gameArtCliffs.layer.destroy();
    cache.gameArtCliffs = null;
  }
  if (!cache.gameArtCliffs && inputs.cliffBands) {
    const view = inputs.cliffBands;
    const layer = new GameArtCliffBandLayer(view.pieces, view.colors);
    layer.container.zIndex = 1.2;
    cache.gameArtCliffs = { view, layer };
    cache.container.addChild(layer.container);
  }
  if (!cache.gameArtSprites && inputs.sprites) {
    const view = inputs.sprites;
    const raised = renderer === 'gpu' ? inputs.raised : null;
    const layer = new GameArtSpriteLayer(
      view.plan,
      view.set,
      view.store,
      inputs.teamColor,
      renderer === 'gpu',
      {
        ...(inputs.maximumTextureSize ? { maximumTextureSize: inputs.maximumTextureSize } : {}),
        ...(raised ? { heightAt: (x: number, y: number) => raised.surface.heightAt(x, y) } : {}),
        ...(inputs.elevation.elevationMode === 'height-map'
          ? {
              objectTintAt: (x: number, y: number) =>
                lightTint(heightMapObjectLightAt(cache.scene, x, y, cache.elevationRange)),
            }
          : {}),
      },
    );
    cache.gameArtSprites = { view, layer };
    cache.container.addChild(layer.container);
  }
  if (!cache.gameArtTerrain && inputs.terrain) {
    const view = inputs.terrain;
    const scene = cache.scene;
    const range = cache.elevationRange;
    const terrainScene = {
      width: scene.width,
      height: scene.height,
      terrainIds: view.terrainIds,
      layerIds: scene.layerIds,
    };
    const overlay = (x: number, y: number) =>
      terrainElevationOverlay(scene, x, y, {
        backgroundColor: inputs.elevation.backgroundColor,
        elevationMode: inputs.elevation.elevationMode,
        elevationRange: range,
      });
    const onChange = () => {
      writeGameArtDataset(cache, inputs.host);
      requestPreviewRender(cache.container);
    };
    let layer: GameArtTerrainPicture | null = null;
    let raised: GameArtPictureRaised | null = null;
    const onPresented = () => {
      if (!layer || cache.gameArtTerrain?.layer !== layer) return;
      destroyOutgoing(state);
      applyKindVisibility(cache);
      applyMinimapChunkVisibility(cache, true);
      writeGameArtDataset(cache, inputs.host);
      requestPreviewRender(cache.container);
      inputs.onPresented();
    };
    if (renderer === 'gpu') {
      try {
        const gpu = new GameArtGpuTerrainLayer(
          terrainScene,
          view.sources,
          overlay,
          onChange,
          onPresented,
          inputs.raised ?? null,
        );
        layer = gpu;
        if (inputs.raised) {
          raised = {
            surface: inputs.raised.surface,
            uniforms: inputs.raised.uniforms,
            overlayBias: () => gpu.raisedOverlayBias,
          };
        }
      } catch {
        layer = null;
        inputs.onGpuUnavailable?.('layer-failed');
      }
    }
    layer ??= new GameArtTerrainLayer(
      terrainScene,
      view.sources,
      overlay,
      gameArtChunkBudget(inputs.store.bytes + gameArtSpriteBudget(inputs.store.bytes)),
      onChange,
      onPresented,
    );
    layer.container.zIndex = 1;
    cache.gameArtTerrain = { view, layer, raised };
    cache.container.addChild(layer.container);
  }
  applyKindVisibility(cache);
  applyMinimapChunkVisibility(cache, inputs.expected);
}

export function handOverGameArtPicture(from: GameArtLayerCache, to: GameArtLayerCache): void {
  if (from.scene.width !== to.scene.width || from.scene.height !== to.scene.height) return;
  const layers: PictureLayer[] = [];
  const outgoing = from.gameArtPresentation.outgoing;
  const presented = from.gameArtTerrain?.layer.presented ?? false;
  if (!presented && !outgoing) return;
  let raised: GameArtPictureRaised | null = outgoing?.raised ?? null;
  if (outgoing) {
    from.gameArtPresentation.outgoing = null;
    layers.push(...outgoing.layers);
    outgoing.root.removeChildren();
    outgoing.root.destroy();
  }
  if (presented && from.gameArtTerrain) {
    raised = from.gameArtTerrain.raised ?? null;
    layers.push(from.gameArtTerrain.layer);
    if (from.gameArtSprites) layers.push(from.gameArtSprites.layer);
    if (from.gameArtCliffs) layers.push(from.gameArtCliffs.layer);
    from.gameArtTerrain = null;
    from.gameArtSprites = null;
    from.gameArtCliffs = null;
  }
  moveToOutgoing(to, layers, raised);
}

export function destroyGameArtLayers(cache: GameArtLayerCache): void {
  destroyOutgoing(cache.gameArtPresentation);
  cache.gameArtTerrain?.layer.destroy();
  cache.gameArtTerrain = null;
  cache.gameArtSprites?.layer.destroy();
  cache.gameArtSprites = null;
  cache.gameArtCliffs?.layer.destroy();
  cache.gameArtCliffs = null;
}

export function writeGameArtDataset(cache: GameArtLayerCache, host: HTMLElement): void {
  const terrain = cache.gameArtTerrain?.layer;
  const sprites = cache.gameArtSprites?.layer;
  const storeBytes = terrain || sprites ? (cache.gameArtStore?.bytes ?? 0) : 0;
  const spriteBytes = sprites
    ? sprites.atlasActive
      ? sprites.statistics.atlasBytes
      : sprites.statistics.overlayBytes
    : 0;
  host.dataset.gameArtTextureBytes = String(
    storeBytes + spriteBytes + (terrain?.statistics.textureBytes ?? 0),
  );
  host.dataset.gameArtOutgoing = String(cache.gameArtPresentation.outgoing !== null);
  if (terrain) host.dataset.gameArtRenderer = terrain.renderer;
  else delete host.dataset.gameArtRenderer;
  host.dataset.minimapChunksHidden = String(cache.gameArtPresentation.minimapHidden);
  if (!terrain) {
    delete host.dataset.gameArtChunks;
    delete host.dataset.gameArtPendingChunks;
    delete host.dataset.gameArtFailedChunks;
    delete host.dataset.gameArtChunkBytes;
    delete host.dataset.gameArtRasterMilliseconds;
    delete host.dataset.gameArtPresented;
    delete host.dataset.gameArtDraws;
    delete host.dataset.gameArtRaisedQuads;
    delete host.dataset.gameArtRaisedWalls;
  } else {
    host.dataset.gameArtChunks = String(terrain.statistics.rasterizedChunks);
    if (terrain.renderer === 'gpu') host.dataset.gameArtDraws = String(terrain.drawCount);
    else delete host.dataset.gameArtDraws;
    if (terrain.renderer === 'gpu' && terrain.raisedQuads + terrain.raisedWallQuads > 0) {
      host.dataset.gameArtRaisedQuads = String(terrain.raisedQuads);
      host.dataset.gameArtRaisedWalls = String(terrain.raisedWallQuads);
    } else {
      delete host.dataset.gameArtRaisedQuads;
      delete host.dataset.gameArtRaisedWalls;
    }
    host.dataset.gameArtPendingChunks = String(terrain.statistics.pendingChunks);
    host.dataset.gameArtFailedChunks = String(terrain.statistics.failedChunks);
    host.dataset.gameArtChunkBytes = String(terrain.statistics.textureBytes);
    host.dataset.gameArtRasterMilliseconds = terrain.statistics.totalRasterMilliseconds.toFixed(1);
    host.dataset.gameArtPresented = String(terrain.presented);
  }
  if (!sprites) {
    delete host.dataset.gameArtSprites;
    delete host.dataset.gameArtSpriteObjects;
    delete host.dataset.gameArtGlyphObjects;
    delete host.dataset.gameArtInvisibleObjects;
    delete host.dataset.gameArtCliffSprites;
    delete host.dataset.gameArtCliffLines;
    delete host.dataset.gameArtTreeSprites;
    delete host.dataset.gameArtTreeScale;
    delete host.dataset.gameArtSpriteAtlas;
    delete host.dataset.gameArtSpriteAtlasPages;
    delete host.dataset.gameArtSpriteAtlasBytes;
    delete host.dataset.gameArtSpriteTextureSources;
    delete host.dataset.gameArtSpriteVisibilityWrites;
  } else {
    host.dataset.gameArtSpriteAtlas = sprites.statistics.atlasFallback ?? 'on';
    host.dataset.gameArtSpriteAtlasPages = String(sprites.statistics.atlasPages);
    host.dataset.gameArtSpriteAtlasBytes = String(sprites.statistics.atlasBytes);
    host.dataset.gameArtSpriteTextureSources = String(sprites.textureSourceCount);
    host.dataset.gameArtSpriteVisibilityWrites = String(sprites.statistics.visibilityWrites);
    host.dataset.gameArtSprites = String(sprites.statistics.createdSprites);
    host.dataset.gameArtSpriteObjects = String(sprites.drawnObjects.size);
    host.dataset.gameArtGlyphObjects = String(sprites.statistics.glyphObjects);
    host.dataset.gameArtInvisibleObjects = String(sprites.statistics.invisibleObjects);
    host.dataset.gameArtCliffSprites = String(sprites.statistics.cliffSprites);
    host.dataset.gameArtCliffLines = String(sprites.statistics.cliffLines);
    host.dataset.gameArtTreeSprites = String(sprites.treeSpriteCount);
    host.dataset.gameArtTreeScale = String(sprites.treeSpriteScale);
  }
  const bands = cache.gameArtCliffs?.layer;
  if (bands) host.dataset.gameArtCliffBands = String(bands.pieceCount);
  else delete host.dataset.gameArtCliffBands;
}
