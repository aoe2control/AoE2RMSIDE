import type { GameArtSpriteSet, GameArtTerrainIndex } from '../shared/game-art';
import { maximumGameArtImagesPerRequest } from '../shared/game-art';
import type { GameArtTerrainSource, GameArtTerrainSources } from './game-art-terrain';

export const gameArtMemoryCapBytes = 96 * 1024 * 1024;
export const gameArtMinimumChunkBytes = 16 * 1024 * 1024;
export const gameArtMaximumSpriteBytes = 40 * 1024 * 1024;

export function gameArtSpriteBudget(sourceBytes: number): number {
  return Math.max(
    0,
    Math.min(
      gameArtMaximumSpriteBytes,
      gameArtMemoryCapBytes - gameArtMinimumChunkBytes - sourceBytes,
    ),
  );
}

export function gameArtChunkBudget(otherBytes: number): number {
  return Math.max(gameArtMinimumChunkBytes, gameArtMemoryCapBytes - otherBytes);
}

export interface DecodedAsset {
  image: CanvasImageSource;
  width: number;
  height: number;
  bytes: number;
}

export interface GameArtImageSource {
  getGameArtImages(keys: string[]): Promise<{ key: string; bytes: Uint8Array }[]>;
}

export type GameArtImageDecoder = (bytes: Uint8Array, alpha: boolean) => Promise<DecodedAsset>;

async function decodePng(bytes: Uint8Array): Promise<ImageBitmap> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return createImageBitmap(new Blob([copy.buffer], { type: 'image/png' }));
}

function alphaImage(bitmap: ImageBitmap): OffscreenCanvas {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.drawImage(bitmap, 0, 0);
  const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height);
  const data = pixels.data;
  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index]!;
    data[index] = 255;
    data[index + 1] = 255;
    data[index + 2] = 255;
    data[index + 3] = alpha;
  }
  context.putImageData(pixels, 0, 0);
  bitmap.close();
  return canvas;
}

async function decodeAsset(bytes: Uint8Array, alpha: boolean): Promise<DecodedAsset> {
  const bitmap = await decodePng(bytes);
  const width = bitmap.width;
  const height = bitmap.height;
  const image = alpha ? alphaImage(bitmap) : bitmap;
  return { image, width, height, bytes: width * height * 4 };
}

export class GameArtAssetStore {
  private readonly decoded = new Map<string, DecodedAsset>();
  private readonly failed = new Set<string>();
  private revision = -1;

  constructor(
    private readonly source: GameArtImageSource,
    private readonly decode: GameArtImageDecoder = decodeAsset,
  ) {}

  get bytes(): number {
    let total = 0;
    for (const asset of this.decoded.values()) total += asset.bytes;
    return total;
  }

  bytesOf(keys: Iterable<string>): number {
    let total = 0;
    for (const key of new Set(keys)) total += this.decoded.get(key)?.bytes ?? 0;
    return total;
  }

  get(key: string): DecodedAsset | undefined {
    return this.decoded.get(key);
  }

  reset(revision: number): void {
    if (revision === this.revision) return;
    this.revision = revision;
    this.decoded.clear();
    this.failed.clear();
  }

  retain(keys: ReadonlySet<string>): void {
    for (const key of [...this.decoded.keys()]) {
      if (!keys.has(key)) this.decoded.delete(key);
    }
  }

  async load(keys: Iterable<string>, alpha: ReadonlySet<string> = new Set()): Promise<void> {
    const missing = [...new Set(keys)].filter(
      (key) => !this.decoded.has(key) && !this.failed.has(key),
    );
    for (let start = 0; start < missing.length; start += maximumGameArtImagesPerRequest) {
      const batch = missing.slice(start, start + maximumGameArtImagesPerRequest);
      let images: { key: string; bytes: Uint8Array }[];
      try {
        images = await this.source.getGameArtImages(batch);
      } catch {
        images = [];
      }
      const received = new Set<string>();
      await Promise.all(
        images.map(async ({ key, bytes }) => {
          received.add(key);
          try {
            this.decoded.set(key, await this.decode(bytes, alpha.has(key)));
          } catch {
            this.failed.add(key);
          }
        }),
      );
      for (const key of batch) if (!received.has(key)) this.failed.add(key);
    }
  }
}

export async function loadTerrainSources(
  store: GameArtAssetStore,
  index: GameArtTerrainIndex,
  terrainIds: Iterable<number>,
  minimapColor: (terrainId: number) => number,
): Promise<GameArtTerrainSources> {
  store.reset(index.revision);
  const wanted = new Set(terrainIds);
  const byId = new Map(index.terrains.map((terrain) => [terrain.id, terrain]));
  const keys = new Set<string>();
  const alpha = new Set<string>();
  for (const id of wanted) {
    const terrain = byId.get(id);
    if (!terrain) continue;
    if (terrain.texture) keys.add(terrain.texture);
    if (terrain.overlayMask) {
      keys.add(terrain.overlayMask);
      alpha.add(terrain.overlayMask);
    }
  }
  for (const blend of index.blends) {
    if (!blend) continue;
    keys.add(blend);
    alpha.add(blend);
  }
  await store.load(keys, alpha);
  const terrains = new Map<number, GameArtTerrainSource>();
  for (const terrain of index.terrains) {
    const texture = terrain.texture ? store.get(terrain.texture) : undefined;
    const mask = terrain.overlayMask ? store.get(terrain.overlayMask) : undefined;
    terrains.set(terrain.id, {
      blendPriority: terrain.blendPriority,
      blendType: terrain.blendType,
      texture: wanted.has(terrain.id) ? (texture?.image ?? null) : null,
      textureSize: texture?.width ?? 1,
      overlayMask: wanted.has(terrain.id) ? (mask?.image ?? null) : null,
      overlayMaskSize: mask?.width ?? 1,
      color: minimapColor(terrain.id),
    });
  }
  const atlases = index.blends.map((key) => (key ? (store.get(key)?.image ?? null) : null));
  const atlasSize =
    index.blends.map((key) => (key ? store.get(key)?.width : undefined)).find(Boolean) ?? 512;
  return { terrains, atlases, atlasSize, assetKeys: [...keys].sort() };
}

export function spriteFacingKeys(
  set: GameArtSpriteSet,
  chosen: ReadonlyMap<number, ReadonlySet<number>>,
): string[] {
  const keys = new Set<string>();
  for (const graphic of set.graphics) {
    const facings = chosen.get(graphic.id);
    if (!facings) continue;
    for (const index of facings) {
      const facing = graphic.facings[index];
      if (!facing) continue;
      keys.add(facing.image);
      if (facing.playerMask) keys.add(facing.playerMask);
    }
  }
  return [...keys].sort();
}
