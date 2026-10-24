import { useEffect } from 'react';
import type { ConnectorRendererRequest } from '../shared/connector-api';
import {
  validateAppPictureTexturesRequest,
  type AppPictureTexturesMap,
  type AppPictureTexturesReply,
} from '../shared/connector-picture-api';
import {
  gameArtLookOffered,
  type GameArtStatus,
  type GameArtTerrainIndex,
} from '../shared/game-art';
import {
  GameArtAssetStore,
  loadTerrainSources,
  type GameArtImageSource,
} from './game-art-resources';
import { drawTerrainChunk, planTerrainChunk, type GameArtTerrainSources } from './game-art-terrain';

export type AppPictureTexturesApi = GameArtImageSource & {
  getGameArtStatus(): Promise<GameArtStatus>;
  getGameArtTerrain(): Promise<GameArtTerrainIndex | null>;
};

export type AppPictureTerrainDrawer = (
  map: AppPictureTexturesMap,
  sources: GameArtTerrainSources,
) => Uint8Array | null;

export function appPictureTexturesAvailable(status: GameArtStatus): boolean {
  return gameArtLookOffered(status) && status.state === 'ready';
}

export function drawAppPictureTerrain(
  map: AppPictureTexturesMap,
  sources: GameArtTerrainSources,
): Uint8Array | null {
  const r = map.texelsPerTile;
  const plan = planTerrainChunk(
    map,
    {
      minimumX: map.left,
      maximumX: map.left + map.columns - 1,
      minimumY: map.top,
      maximumY: map.top + map.rows - 1,
    },
    sources.terrains,
    null,
    (mode) => Boolean(sources.atlases[mode]),
  );
  const canvas = new OffscreenCanvas(map.columns * r, map.rows * r);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  drawTerrainChunk(context, plan, sources, r);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  return new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function answerAppPictureTextures(
  payload: unknown,
  api: AppPictureTexturesApi,
  draw: AppPictureTerrainDrawer = drawAppPictureTerrain,
): Promise<AppPictureTexturesReply> {
  const request = validateAppPictureTexturesRequest(payload);
  if (!appPictureTexturesAvailable(await api.getGameArtStatus())) return { available: false };
  const index = await api.getGameArtTerrain();
  if (!index) return { available: false };
  const store = new GameArtAssetStore(api);
  try {
    const textures: Uint8Array[] = [];
    for (const [position, map] of request.maps.entries()) {
      if (position > 0) await nextTask();
      const colors = new Map(map.colors.map((entry) => [entry.terrain, entry.color]));
      const used = new Set<number>(map.terrainIds);
      for (const layer of map.layerIds) if (layer !== 0xffff) used.add(layer);
      const sources = await loadTerrainSources(
        store,
        index,
        used,
        (terrain) => colors.get(terrain) ?? 0x808080,
      );
      const pixels = draw(map, sources);
      const expected = map.columns * map.rows * map.texelsPerTile ** 2 * 4;
      if (!pixels || pixels.length !== expected) throw new Error('the terrain could not be drawn');
      textures.push(pixels);
    }
    return { available: true, textures };
  } finally {
    store.retain(new Set());
  }
}

export function useAppPictureTexturesBridge(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return undefined;
    return window.rmside.onConnectorRequest((request: ConnectorRendererRequest) => {
      if (request.kind !== 'pictureTextures') return;
      void (async () => {
        try {
          const payload = await answerAppPictureTextures(request.payload, window.rmside);
          await window.rmside.replyToConnectorRequest({
            requestId: request.requestId,
            ok: true,
            payload,
          });
        } catch {
          await window.rmside
            .replyToConnectorRequest({
              requestId: request.requestId,
              ok: false,
              error: { code: 'internal', message: "The preview's textures could not be drawn." },
            })
            .catch(() => undefined);
        }
      })();
    });
  }, [enabled]);
}
