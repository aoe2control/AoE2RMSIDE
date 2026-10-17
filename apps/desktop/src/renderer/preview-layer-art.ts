import { useEffect, useMemo, useRef, useState } from 'react';
import {
  gameArtTextureRepeatTiles,
  maximumGameArtImagesPerRequest,
  type GameArtSpriteFacing,
  type GameArtSpriteGraphic,
  type GameArtSpriteObject,
  type GameArtSpriteSet,
  type GameArtTerrainIndex,
} from '../shared/game-art';
import { spriteDrawOrder } from './game-art-blend';
import {
  GameArtAssetStore,
  type DecodedAsset,
  type GameArtImageDecoder,
  type GameArtImageSource,
} from './game-art-resources';
import { teamColorKey, teamColorPixels, type TeamColor } from './game-art-team-colors';
import type { AggregatedSelectionLayer } from './preview-materials';
import { gameArtKeptPictureIdleMilliseconds } from './use-game-art';

export const layerIconCssPixels = 16;

export const maximumLayerArtThumbnails = 1024;

export const layerArtBatchBytes = 16 * 1024 * 1024;

export const maximumLayerArtCompositeSide = 2048;

export const layerArtSliceMilliseconds = 8;

export const layerArtOpaqueThreshold = 8;

const pixelsPerUnitX = 48;
const pixelsPerUnitY = 24;

export function layerIconPixelSize(devicePixelRatio: number): number {
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.max(
    layerIconCssPixels,
    Math.min(layerIconCssPixels * 3, Math.round(layerIconCssPixels * ratio)),
  );
}

export interface PixelImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayerArtPart {
  facing: GameArtSpriteFacing;
  x: number;
  y: number;
}

export type LayerArtRequest =
  | { kind: 'terrain'; key: string; pixelSize: number; texture: string }
  | { kind: 'object'; key: string; pixelSize: number; parts: LayerArtPart[]; team: TeamColor };

export interface LayerArtContext {
  index: GameArtTerrainIndex | null;
  spriteSet: GameArtSpriteSet | null;
  civilizationFor(owner: number): number;
  teamColor(owner: number): TeamColor;
  objects: boolean;
  pixelSize: number;
}

interface SetLookup {
  objects: Map<string, GameArtSpriteObject>;
  graphics: Map<number, GameArtSpriteGraphic>;
}

const setLookups = new WeakMap<GameArtSpriteSet, SetLookup>();

function setLookup(set: GameArtSpriteSet): SetLookup {
  let lookup = setLookups.get(set);
  if (!lookup) {
    lookup = {
      objects: new Map(
        set.objects.map((entry) => [`${entry.civilizationId}:${entry.objectId}`, entry]),
      ),
      graphics: new Map(set.graphics.map((graphic) => [graphic.id, graphic])),
    };
    setLookups.set(set, lookup);
  }
  return lookup;
}

const terrainTextures = new WeakMap<GameArtTerrainIndex, Map<number, string | null>>();

function terrainTexture(index: GameArtTerrainIndex, terrainId: number): string | null {
  let textures = terrainTextures.get(index);
  if (!textures) {
    textures = new Map(index.terrains.map((terrain) => [terrain.id, terrain.texture]));
    terrainTextures.set(index, textures);
  }
  return textures.get(terrainId) ?? null;
}

export function layerArtParts(
  set: GameArtSpriteSet,
  civilization: number,
  objectId: number,
): LayerArtPart[] | null {
  const { objects, graphics } = setLookup(set);
  const root = objects.get(`${civilization}:${objectId}`);
  if (!root || root.invisible) return null;
  const placed: { part: LayerArtPart; order: number }[] = [];
  const add = (id: number, mapX: number, mapY: number, depth: number) => {
    const art = objects.get(`${civilization}:${id}`);
    if (!art || art.invisible) return;
    for (const part of art.parts) {
      const graphic = graphics.get(part.graphic);
      const facing = graphic?.facings[0];
      if (!graphic || !facing) continue;
      placed.push({
        part: {
          facing,
          x: (mapX + mapY) * pixelsPerUnitX + part.offsetX - facing.anchorX,
          y: (mapY - mapX) * pixelsPerUnitY + part.offsetY - facing.anchorY,
        },
        order: spriteDrawOrder(graphic.layer, mapX, mapY) + placed.length,
      });
    }
    if (depth >= 3) return;
    for (const annex of art.annexes) {
      add(annex.objectId, mapX + annex.offsetX, mapY + annex.offsetY, depth + 1);
    }
  };
  add(objectId, 0, 0, 0);
  if (placed.length === 0) return null;
  placed.sort((left, right) => left.order - right.order);
  return placed.map((entry) => entry.part);
}

export function layerArtPartBounds(parts: readonly LayerArtPart[]): PixelRect {
  let minimumX = Infinity;
  let minimumY = Infinity;
  let maximumX = -Infinity;
  let maximumY = -Infinity;
  for (const part of parts) {
    minimumX = Math.min(minimumX, part.x);
    minimumY = Math.min(minimumY, part.y);
    maximumX = Math.max(maximumX, part.x + part.facing.width);
    maximumY = Math.max(maximumY, part.y + part.facing.height);
  }
  return { x: minimumX, y: minimumY, width: maximumX - minimumX, height: maximumY - minimumY };
}

export function layerArtRequest(
  layer: Pick<AggregatedSelectionLayer, 'kind' | 'material'>,
  context: LayerArtContext,
): LayerArtRequest | null {
  const { subject } = layer.material;
  if (layer.kind === 'terrain' && subject.kind === 'terrain') {
    const texture = context.index ? terrainTexture(context.index, subject.id) : null;
    return texture
      ? {
          kind: 'terrain',
          key: `terrain:${context.pixelSize}:${texture}`,
          pixelSize: context.pixelSize,
          texture,
        }
      : null;
  }
  if (
    layer.kind !== 'object' ||
    subject.kind !== 'object' ||
    layer.material.helper ||
    !context.objects ||
    !context.spriteSet
  ) {
    return null;
  }
  const civilization = context.civilizationFor(subject.owner);
  const parts = layerArtParts(context.spriteSet, civilization, subject.id);
  if (!parts) return null;
  const bounds = layerArtPartBounds(parts);
  if (
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    bounds.width > maximumLayerArtCompositeSide ||
    bounds.height > maximumLayerArtCompositeSide
  ) {
    return null;
  }
  const team = context.teamColor(subject.owner);
  const masked = parts.some((part) => part.facing.playerMask !== null);
  return {
    kind: 'object',
    key: `object:${context.pixelSize}:${civilization}:${subject.id}:${masked ? teamColorKey(team) : 'plain'}`,
    pixelSize: context.pixelSize,
    parts,
    team,
  };
}

export function terrainCropRect(width: number, height: number, pixelSize: number): PixelRect {
  const shorter = Math.max(1, Math.min(width, height));
  const side = Math.min(
    shorter,
    Math.max(pixelSize, Math.round(shorter / gameArtTextureRepeatTiles)),
  );
  return {
    x: Math.floor((width - side) / 2),
    y: Math.floor((height - side) / 2),
    width: side,
    height: side,
  };
}

export function fitLayerArt(width: number, height: number, box: number): PixelRect {
  const scale = box / Math.max(width, height, 1);
  const fittedWidth = Math.max(1, Math.min(box, Math.round(width * scale)));
  const fittedHeight = Math.max(1, Math.min(box, Math.round(height * scale)));
  return {
    x: Math.floor((box - fittedWidth) / 2),
    y: Math.floor((box - fittedHeight) / 2),
    width: fittedWidth,
    height: fittedHeight,
  };
}

export function opaqueBounds(
  image: PixelImage,
  threshold = layerArtOpaqueThreshold,
): PixelRect | null {
  const { width, height, data } = image;
  let minimumX = width;
  let minimumY = height;
  let maximumX = -1;
  let maximumY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3]! <= threshold) continue;
      if (x < minimumX) minimumX = x;
      if (x > maximumX) maximumX = x;
      if (y < minimumY) minimumY = y;
      if (y > maximumY) maximumY = y;
    }
  }
  return maximumX < 0
    ? null
    : { x: minimumX, y: minimumY, width: maximumX - minimumX + 1, height: maximumY - minimumY + 1 };
}

export function resampleArea(
  image: PixelImage,
  source: PixelRect,
  width: number,
  height: number,
): Uint8ClampedArray {
  const result = new Uint8ClampedArray(width * height * 4);
  const scaleX = source.width / width;
  const scaleY = source.height / height;
  for (let y = 0; y < height; y += 1) {
    const top = source.y + y * scaleY;
    const bottom = top + scaleY;
    for (let x = 0; x < width; x += 1) {
      const left = source.x + x * scaleX;
      const right = left + scaleX;
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      let area = 0;
      for (let sy = Math.floor(top); sy < Math.ceil(bottom); sy += 1) {
        const coverY = Math.min(bottom, sy + 1) - Math.max(top, sy);
        if (coverY <= 0 || sy < 0 || sy >= image.height) continue;
        for (let sx = Math.floor(left); sx < Math.ceil(right); sx += 1) {
          const coverX = Math.min(right, sx + 1) - Math.max(left, sx);
          if (coverX <= 0 || sx < 0 || sx >= image.width) continue;
          const weight = coverX * coverY;
          const offset = (sy * image.width + sx) * 4;
          const a = image.data[offset + 3]! * weight;
          red += image.data[offset]! * a;
          green += image.data[offset + 1]! * a;
          blue += image.data[offset + 2]! * a;
          alpha += a;
          area += weight;
        }
      }
      const offset = (y * width + x) * 4;
      if (alpha > 0) {
        result[offset] = Math.round(red / alpha);
        result[offset + 1] = Math.round(green / alpha);
        result[offset + 2] = Math.round(blue / alpha);
      }
      result[offset + 3] = area > 0 ? Math.round(alpha / area) : 0;
    }
  }
  return result;
}

function drawOver(target: PixelImage, source: PixelImage, x: number, y: number): void {
  for (let sy = 0; sy < source.height; sy += 1) {
    const ty = y + sy;
    if (ty < 0 || ty >= target.height) continue;
    for (let sx = 0; sx < source.width; sx += 1) {
      const tx = x + sx;
      if (tx < 0 || tx >= target.width) continue;
      const from = (sy * source.width + sx) * 4;
      const sourceAlpha = source.data[from + 3]! / 255;
      if (sourceAlpha <= 0) continue;
      const to = (ty * target.width + tx) * 4;
      const targetAlpha = target.data[to + 3]! / 255;
      const alpha = sourceAlpha + targetAlpha * (1 - sourceAlpha);
      for (let channel = 0; channel < 3; channel += 1) {
        target.data[to + channel] =
          (source.data[from + channel]! * sourceAlpha +
            target.data[to + channel]! * targetAlpha * (1 - sourceAlpha)) /
          alpha;
      }
      target.data[to + 3] = alpha * 255;
    }
  }
}

export function compositeLayerArt(
  parts: readonly { x: number; y: number; main: PixelImage; mask: PixelImage | null }[],
  team: TeamColor,
): PixelImage {
  let minimumX = Infinity;
  let minimumY = Infinity;
  let maximumX = -Infinity;
  let maximumY = -Infinity;
  for (const part of parts) {
    minimumX = Math.min(minimumX, part.x);
    minimumY = Math.min(minimumY, part.y);
    maximumX = Math.max(maximumX, part.x + part.main.width);
    maximumY = Math.max(maximumY, part.y + part.main.height);
  }
  const width = Math.max(0, maximumX - minimumX);
  const height = Math.max(0, maximumY - minimumY);
  const target: PixelImage = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  for (const part of parts) {
    const x = part.x - minimumX;
    const y = part.y - minimumY;
    drawOver(target, part.main, x, y);
    if (part.mask) {
      drawOver(
        target,
        {
          width: part.main.width,
          height: part.main.height,
          data: teamColorPixels(part.main.data, part.mask.data, team),
        },
        x,
        y,
      );
    }
  }
  return target;
}

export function terrainThumbnail(crop: PixelImage, pixelSize: number): PixelImage {
  const data = resampleArea(
    crop,
    { x: 0, y: 0, width: crop.width, height: crop.height },
    pixelSize,
    pixelSize,
  );
  for (let offset = 3; offset < data.length; offset += 4) data[offset] = 255;
  return { width: pixelSize, height: pixelSize, data };
}

export function objectThumbnail(composite: PixelImage, pixelSize: number): PixelImage | null {
  const bounds = opaqueBounds(composite);
  if (!bounds) return null;
  const fitted = fitLayerArt(bounds.width, bounds.height, pixelSize);
  const pixels = resampleArea(composite, bounds, fitted.width, fitted.height);
  const result: PixelImage = {
    width: pixelSize,
    height: pixelSize,
    data: new Uint8ClampedArray(pixelSize * pixelSize * 4),
  };
  for (let y = 0; y < fitted.height; y += 1) {
    result.data.set(
      pixels.subarray(y * fitted.width * 4, (y + 1) * fitted.width * 4),
      ((fitted.y + y) * pixelSize + fitted.x) * 4,
    );
  }
  return result;
}

export type LayerArtPixelReader = (image: CanvasImageSource, rect: PixelRect) => Uint8ClampedArray;
export type LayerArtEncoder = (image: PixelImage) => string;

function readCanvasPixels(image: CanvasImageSource, rect: PixelRect): Uint8ClampedArray {
  const canvas = new OffscreenCanvas(rect.width, rect.height);
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.drawImage(image, -rect.x, -rect.y);
  return context.getImageData(0, 0, rect.width, rect.height).data;
}

function encodeCanvasDataUrl(image: PixelImage): string {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  canvas
    .getContext('2d')!
    .putImageData(
      new ImageData(new Uint8ClampedArray(image.data), image.width, image.height),
      0,
      0,
    );
  return canvas.toDataURL('image/png');
}

export interface LayerArtDependencies {
  source: GameArtImageSource;
  decode?: GameArtImageDecoder;
  readPixels?: LayerArtPixelReader;
  encode?: LayerArtEncoder;
}

function requestImages(request: LayerArtRequest): { key: string; bytes: number }[] {
  if (request.kind === 'terrain') return [{ key: request.texture, bytes: 512 * 512 * 4 }];
  const images: { key: string; bytes: number }[] = [];
  for (const { facing } of request.parts) {
    const bytes = facing.width * facing.height * 4;
    images.push({ key: facing.image, bytes });
    if (facing.playerMask) images.push({ key: facing.playerMask, bytes });
  }
  return images;
}

export class LayerArtCache {
  private readonly urls = new Map<string, string | null>();
  private readonly pending = new Set<string>();
  private revision: number | null = null;
  private generation = 0;
  private readonly readPixels: LayerArtPixelReader;
  private readonly encode: LayerArtEncoder;
  made = 0;

  constructor(private readonly dependencies: LayerArtDependencies) {
    this.readPixels = dependencies.readPixels ?? readCanvasPixels;
    this.encode = dependencies.encode ?? encodeCanvasDataUrl;
  }

  get(key: string): string | null | undefined {
    return this.urls.get(key);
  }

  get size(): number {
    return this.urls.size;
  }

  get bytes(): number {
    let total = 0;
    for (const url of this.urls.values()) total += url?.length ?? 0;
    return total;
  }

  reset(revision: number): void {
    if (revision === this.revision) return;
    this.revision = revision;
    this.clear();
  }

  clear(): void {
    this.urls.clear();
    this.pending.clear();
    this.generation += 1;
  }

  private remember(key: string, url: string | null): void {
    this.urls.delete(key);
    this.urls.set(key, url);
    while (this.urls.size > maximumLayerArtThumbnails) {
      const oldest = this.urls.keys().next().value as string;
      this.urls.delete(oldest);
    }
  }

  async generate(
    requests: readonly LayerArtRequest[],
    shared: { get(key: string): DecodedAsset | undefined } | null = null,
    onBatch?: () => void,
  ): Promise<boolean> {
    const generation = this.generation;
    const wanted: LayerArtRequest[] = [];
    const seen = new Set<string>();
    for (const request of requests) {
      if (seen.has(request.key) || this.urls.has(request.key) || this.pending.has(request.key)) {
        continue;
      }
      seen.add(request.key);
      wanted.push(request);
    }
    if (wanted.length === 0) return false;
    for (const request of wanted) this.pending.add(request.key);
    let changed = false;
    try {
      let start = 0;
      while (start < wanted.length) {
        const batch: LayerArtRequest[] = [];
        const keys = new Set<string>();
        let bytes = 0;
        while (start < wanted.length) {
          const request = wanted[start]!;
          const images = requestImages(request).filter(({ key }) => !shared?.get(key));
          const added = images.filter(({ key }) => !keys.has(key));
          const addedBytes = added.reduce((total, image) => total + image.bytes, 0);
          if (
            batch.length > 0 &&
            (bytes + addedBytes > layerArtBatchBytes ||
              keys.size + added.length > maximumGameArtImagesPerRequest)
          ) {
            break;
          }
          for (const image of added) keys.add(image.key);
          bytes += addedBytes;
          batch.push(request);
          start += 1;
        }
        const store = new GameArtAssetStore(this.dependencies.source, this.dependencies.decode);
        await store.load(keys);
        const dropped = batch
          .flatMap(requestImages)
          .map(({ key }) => key)
          .filter((key) => !shared?.get(key) && !store.get(key) && !keys.has(key));
        if (dropped.length > 0) {
          for (const key of dropped) keys.add(key);
          await store.load(dropped);
        }
        if (generation !== this.generation) return false;
        const image = (key: string) => shared?.get(key) ?? store.get(key);
        let slice = performance.now();
        for (const request of batch) {
          if (performance.now() - slice > layerArtSliceMilliseconds) {
            await new Promise((resume) => setTimeout(resume, 0));
            if (generation !== this.generation) return false;
            slice = performance.now();
          }
          let url: string | null = null;
          try {
            const thumbnail = this.thumbnail(request, image);
            url = thumbnail ? this.encode(thumbnail) : null;
          } catch {
            url = null;
          }
          this.pending.delete(request.key);
          this.remember(request.key, url);
          this.made += 1;
          changed = true;
        }
        for (const key of keys) {
          const decoded = store.get(key)?.image as { close?: () => void } | undefined;
          decoded?.close?.();
        }
        store.retain(new Set());
        onBatch?.();
      }
    } finally {
      if (generation === this.generation) {
        for (const request of wanted) this.pending.delete(request.key);
      }
    }
    return changed;
  }

  private thumbnail(
    request: LayerArtRequest,
    image: (key: string) => DecodedAsset | undefined,
  ): PixelImage | null {
    const { pixelSize } = request;
    if (request.kind === 'terrain') {
      const texture = image(request.texture);
      if (!texture) return null;
      const crop = terrainCropRect(texture.width, texture.height, pixelSize);
      return terrainThumbnail(
        { width: crop.width, height: crop.height, data: this.readPixels(texture.image, crop) },
        pixelSize,
      );
    }
    const parts: { x: number; y: number; main: PixelImage; mask: PixelImage | null }[] = [];
    for (const part of request.parts) {
      const main = image(part.facing.image);
      if (!main) continue;
      const { width, height } = part.facing;
      const whole = { x: 0, y: 0, width, height };
      const mask = part.facing.playerMask ? image(part.facing.playerMask) : undefined;
      parts.push({
        x: part.x,
        y: part.y,
        main: { width, height, data: this.readPixels(main.image, whole) },
        mask: mask ? { width, height, data: this.readPixels(mask.image, whole) } : null,
      });
    }
    if (parts.length === 0) return null;
    return objectThumbnail(compositeLayerArt(parts, request.team), pixelSize);
  }
}

export function usePreviewLayerArt(options: {
  enabled: boolean;
  shown: boolean;
  layers: readonly AggregatedSelectionLayer[] | null;
  context: Omit<LayerArtContext, 'pixelSize'>;
  shared: { get(key: string): DecodedAsset | undefined } | null;
}): ReadonlyMap<string, string> | null {
  const { enabled, shown, layers, context, shared } = options;
  const cacheRef = useRef<LayerArtCache | null>(null);
  cacheRef.current ??= new LayerArtCache({ source: window.rmside });
  const cache = cacheRef.current;
  const [version, setVersion] = useState(0);
  const revision = context.index?.revision ?? null;
  if (enabled && revision !== null) cache.reset(revision);
  const pixelSize = layerIconPixelSize(globalThis.devicePixelRatio || 1);
  const { index, spriteSet, civilizationFor, teamColor, objects } = context;
  const requests = useMemo(() => {
    if (!enabled || !layers || !index) return null;
    const byLayer = new Map<string, LayerArtRequest>();
    const full: LayerArtContext = {
      index,
      spriteSet,
      civilizationFor,
      teamColor,
      objects,
      pixelSize,
    };
    for (const layer of layers) {
      const request = layerArtRequest(layer, full);
      if (request) byLayer.set(layer.key, request);
    }
    return byLayer;
  }, [civilizationFor, enabled, index, layers, objects, pixelSize, spriteSet, teamColor]);
  useEffect(() => {
    if (!requests || requests.size === 0) return undefined;
    void cache
      .generate([...requests.values()], shared, () => setVersion((value) => value + 1))
      .catch(() => undefined);
    return undefined;
  }, [cache, requests, shared]);
  useEffect(() => {
    if (enabled) return undefined;
    const timer = window.setTimeout(() => cache.clear(), gameArtKeptPictureIdleMilliseconds);
    return () => window.clearTimeout(timer);
  }, [cache, enabled]);
  return useMemo(() => {
    if (!shown || !requests) return null;
    const urls = new Map<string, string>();
    for (const [layerKey, request] of requests) {
      const url = cache.get(request.key);
      if (url) urls.set(layerKey, url);
    }
    return urls;
  }, [cache, requests, shown, version]);
}
