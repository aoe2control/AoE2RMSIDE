import {
  validateAppPictureTexturesReply,
  validateAppPictureTexturesRequest,
  appPictureTextureLimits,
  type AppPictureTexturesRequest,
} from '../../shared/connector-picture-api';
import { terrainMaterial } from '../../renderer/preview-materials';
import {
  validatePictureRequest,
  type PictureRequest,
  type PictureTerrainTexture,
} from '../pictures/picture-contract';
import type { PictureMap } from '../pictures/picture-map';
import { pictureTextureNeeds, type PictureTextureNeed } from '../pictures/picture-render';
import { ConnectorToolError } from './dispatcher';

export const pictureTexturesTimeoutMilliseconds = 20_000;

export type PictureTexturesOutcome = 'none' | 'shown' | 'unavailable';

export interface PictureTexturesBridge {
  request(
    kind: 'pictureTextures',
    payload: unknown,
    options: { timeoutMilliseconds: number; signal?: AbortSignal },
  ): Promise<unknown>;
}

function layerColumn(map: PictureMap): Uint16Array {
  return map.layerIds ?? new Uint16Array(map.width * map.height).fill(0xffff);
}

export function wantsTerrainTextures(request: PictureRequest): boolean {
  return request.cells.some((cell) => (cell.look ?? request.look) === 'terrain-textures');
}

export function withoutTerrainTextures(request: PictureRequest): PictureRequest {
  const { terrainTextures: _dropped, ...rest } = request;
  const swap = <T extends string | undefined>(look: T) =>
    look === 'terrain-textures' ? 'texture-colors' : look;
  return {
    ...rest,
    look: swap(request.look),
    cells: request.cells.map((cell) =>
      cell.look === undefined ? cell : { ...cell, look: swap(cell.look) },
    ),
  };
}

export function texturedPictureNeeds(request: PictureRequest): PictureTextureNeed[] {
  const plain = validatePictureRequest(withoutTerrainTextures(request));
  return pictureTextureNeeds({
    ...plain,
    look: request.look,
    cells: plain.cells.map((cell, index) => {
      const look = request.cells[index]!.look;
      return look === undefined ? cell : { ...cell, look };
    }),
  });
}

export function pictureTexturesRequest(
  request: PictureRequest,
  needs: readonly PictureTextureNeed[],
): AppPictureTexturesRequest {
  return {
    maps: needs.map((need) => {
      const map = request.maps[need.map]!;
      const layerIds = layerColumn(map);
      const used = new Set<number>(map.terrainIds);
      for (const layer of layerIds) if (layer !== 0xffff) used.add(layer);
      const colors = [...used]
        .sort((left, right) => left - right)
        .slice(0, appPictureTextureLimits.colors)
        .map((terrain) => ({
          terrain,
          color:
            terrainMaterial(terrain, map.backend, map.minimapPalette, map.terrainNames).color &
            0xffffff,
        }));
      return {
        width: map.width,
        height: map.height,
        terrainIds: map.terrainIds,
        layerIds,
        colors,
        left: need.left,
        top: need.top,
        columns: need.columns,
        rows: need.rows,
        texelsPerTile: need.texelsPerTile,
      };
    }),
  };
}

export async function resolvePictureTextures(
  request: PictureRequest,
  bridge: PictureTexturesBridge,
  signal: AbortSignal,
): Promise<{ request: PictureRequest; outcome: PictureTexturesOutcome }> {
  if (!wantsTerrainTextures(request)) return { request, outcome: 'none' };
  const needs = texturedPictureNeeds(request);
  const unavailable = { request: withoutTerrainTextures(request), outcome: 'unavailable' as const };
  if (needs.length === 0) return unavailable;
  let payload: AppPictureTexturesRequest;
  try {
    payload = validateAppPictureTexturesRequest(pictureTexturesRequest(request, needs));
  } catch {
    return unavailable;
  }
  let answer: unknown;
  try {
    answer = await bridge.request('pictureTextures', payload, {
      timeoutMilliseconds: pictureTexturesTimeoutMilliseconds,
      signal,
    });
  } catch (error) {
    if (signal.aborted || (error instanceof ConnectorToolError && error.code === 'cancelled')) {
      throw new ConnectorToolError('cancelled', 'The call was cancelled.');
    }
    return unavailable;
  }
  let reply;
  try {
    reply = validateAppPictureTexturesReply(answer, payload);
  } catch {
    return unavailable;
  }
  if (!reply.available) return unavailable;
  const terrainTextures: (PictureTerrainTexture | null)[] = request.maps.map(() => null);
  needs.forEach((need, index) => {
    terrainTextures[need.map] = {
      left: need.left,
      top: need.top,
      columns: need.columns,
      rows: need.rows,
      texelsPerTile: need.texelsPerTile,
      pixels: reply.textures[index]!,
    };
  });
  return { request: { ...request, terrainTextures }, outcome: 'shown' };
}
