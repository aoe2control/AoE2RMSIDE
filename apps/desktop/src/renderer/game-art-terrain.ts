import { CanvasSource, Container, Matrix, Sprite, Texture } from 'pixi.js';
import {
  blendAtlasCell,
  noTerrainLayer,
  tileBlendQuads,
  type BlendGrid,
  type BlendTerrain,
  type TerrainPair,
} from './game-art-blend';
import { gameArtTextureRepeatTiles } from '../shared/game-art';
import { requestPreviewRender } from './preview-render-scheduler';
import type { VisibleChunk } from './top-down-preview';

export interface GameArtTerrainSource extends BlendTerrain {
  texture: CanvasImageSource | null;
  textureSize: number;
  overlayMask: CanvasImageSource | null;
  overlayMaskSize: number;
  color: number;
}

export interface GameArtTerrainSources {
  terrains: ReadonlyMap<number, GameArtTerrainSource>;
  atlases: readonly (CanvasImageSource | null)[];
  atlasSize: number;
  assetKeys: readonly string[];
}

export interface GameArtTerrainScene {
  width: number;
  height: number;
  terrainIds: ArrayLike<number>;
  layerIds: ArrayLike<number>;
}

export interface TerrainChunkPlan {
  minimumX: number;
  minimumY: number;
  width: number;
  height: number;
  base: Map<number, number[]>;
  fallback: Map<number, number[]>;
  layers: Map<number, number[]>;
  blends: { upper: TerrainPair; mode: number; quads: { tile: number; cell: number }[] }[];
  shading: TerrainChunkShading | null;
}

export interface TerrainChunkShading {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
}

export type TerrainTileOverlay = (x: number, y: number) => { color: number; alpha: number } | null;

export function gameArtPairAt(
  scene: GameArtTerrainScene,
  terrains: ReadonlyMap<number, BlendTerrain>,
  x: number,
  y: number,
): TerrainPair {
  const index = y * scene.width + x;
  const terrain = scene.terrainIds[index] ?? 0;
  const layer = scene.layerIds[index] ?? noTerrainLayer;
  return {
    terrain,
    layer:
      layer !== noTerrainLayer && layer !== terrain && terrains.has(layer) ? layer : noTerrainLayer,
  };
}

export function planTerrainChunk(
  scene: GameArtTerrainScene,
  chunk: VisibleChunk,
  terrains: ReadonlyMap<
    number,
    Pick<GameArtTerrainSource, 'blendPriority' | 'blendType' | 'texture' | 'overlayMask' | 'color'>
  >,
  overlay: TerrainTileOverlay | null,
  hasAtlas: (mode: number) => boolean,
): TerrainChunkPlan {
  const width = chunk.maximumX - chunk.minimumX + 1;
  const height = chunk.maximumY - chunk.minimumY + 1;
  const plan: TerrainChunkPlan = {
    minimumX: chunk.minimumX,
    minimumY: chunk.minimumY,
    width,
    height,
    base: new Map(),
    fallback: new Map(),
    layers: new Map(),
    blends: [],
    shading: overlay ? chunkShading(scene, chunk, overlay) : null,
  };
  const push = <K>(map: Map<K, number[]>, key: K, tile: number) => {
    const tiles = map.get(key);
    if (tiles) tiles.push(tile);
    else map.set(key, [tile]);
  };
  const grid: BlendGrid = {
    width: scene.width,
    height: scene.height,
    pairAt: (x, y) => gameArtPairAt(scene, terrains, x, y),
  };
  const blendGroups = new Map<string, TerrainChunkPlan['blends'][number] & { key: number }>();
  for (let y = chunk.minimumY; y <= chunk.maximumY; y += 1) {
    for (let x = chunk.minimumX; x <= chunk.maximumX; x += 1) {
      const local = (y - chunk.minimumY) * width + (x - chunk.minimumX);
      const pair = grid.pairAt(x, y);
      const terrain = terrains.get(pair.terrain);
      if (terrain?.texture) push(plan.base, pair.terrain, local);
      else push(plan.fallback, terrain?.color ?? 0x808080, local);
      if (pair.layer !== noTerrainLayer) {
        const layer = terrains.get(pair.layer);
        if (layer?.texture && layer.overlayMask) push(plan.layers, pair.layer, local);
      }
      for (const quad of tileBlendQuads(grid, x, y, terrains)) {
        if (!hasAtlas(quad.mode) || !terrains.get(quad.upper.terrain)?.texture) continue;
        const groupKey = `${quad.upperKey}:${quad.upper.terrain}:${quad.upper.layer}:${quad.mode}`;
        let group = blendGroups.get(groupKey);
        if (!group) {
          group = { key: quad.upperKey, upper: quad.upper, mode: quad.mode, quads: [] };
          blendGroups.set(groupKey, group);
        }
        group.quads.push({ tile: local, cell: quad.tile });
      }
    }
  }
  plan.blends = [...blendGroups.values()]
    .sort(
      (left, right) =>
        left.key - right.key ||
        left.upper.terrain - right.upper.terrain ||
        left.upper.layer - right.upper.layer ||
        left.mode - right.mode,
    )
    .map(({ upper, mode, quads }) => ({ upper, mode, quads }));
  return plan;
}

export function chunkShading(
  scene: Pick<GameArtTerrainScene, 'width' | 'height'>,
  chunk: VisibleChunk,
  overlay: TerrainTileOverlay,
): TerrainChunkShading | null {
  const width = chunk.maximumX - chunk.minimumX + 3;
  const height = chunk.maximumY - chunk.minimumY + 3;
  const pixels = new Uint8ClampedArray(width * height * 4);
  let shaded = false;
  for (let j = 0; j < height; j += 1) {
    const y = Math.min(scene.height - 1, Math.max(0, chunk.minimumY - 1 + j));
    for (let i = 0; i < width; i += 1) {
      const x = Math.min(scene.width - 1, Math.max(0, chunk.minimumX - 1 + i));
      const value = overlay(x, y);
      if (!value || value.alpha <= 0) continue;
      shaded = true;
      const offset = (j * width + i) * 4;
      pixels[offset] = (value.color >> 16) & 0xff;
      pixels[offset + 1] = (value.color >> 8) & 0xff;
      pixels[offset + 2] = value.color & 0xff;
      pixels[offset + 3] = Math.round(Math.min(1, value.alpha) * 255);
    }
  }
  return shaded ? { width, height, pixels } : null;
}

type Context2D = OffscreenCanvasRenderingContext2D;

function colorString(color: number, alpha = 1): string {
  return `rgba(${(color >> 16) & 0xff}, ${(color >> 8) & 0xff}, ${color & 0xff}, ${alpha})`;
}

function worldPattern(
  context: Context2D,
  image: CanvasImageSource,
  size: number,
  pixelsPerTile: number,
  x0: number,
  y0: number,
): CanvasPattern | null {
  const pattern = context.createPattern(image, 'repeat');
  if (!pattern) return null;
  const scale = (gameArtTextureRepeatTiles * pixelsPerTile) / size;
  pattern.setTransform(
    new DOMMatrix().translate(-x0 * pixelsPerTile, -y0 * pixelsPerTile).scale(scale),
  );
  return pattern;
}

function tilePath(tiles: readonly number[], width: number, pixelsPerTile: number): Path2D {
  const path = new Path2D();
  for (const tile of tiles) {
    path.rect(
      (tile % width) * pixelsPerTile,
      Math.floor(tile / width) * pixelsPerTile,
      pixelsPerTile,
      pixelsPerTile,
    );
  }
  return path;
}

let scratchCanvas: OffscreenCanvas | null = null;

function scratch(width: number, height: number): Context2D {
  if (!scratchCanvas || scratchCanvas.width < width || scratchCanvas.height < height) {
    scratchCanvas = new OffscreenCanvas(
      Math.max(width, scratchCanvas?.width ?? 0),
      Math.max(height, scratchCanvas?.height ?? 0),
    );
  }
  const context = scratchCanvas.getContext('2d')!;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalCompositeOperation = 'source-over';
  context.globalAlpha = 1;
  context.clearRect(0, 0, width, height);
  return context;
}

export function drawTerrainChunk(
  context: Context2D,
  plan: TerrainChunkPlan,
  sources: GameArtTerrainSources,
  pixelsPerTile: number,
): void {
  const r = pixelsPerTile;
  const width = plan.width * r;
  const height = plan.height * r;
  const x0 = plan.minimumX;
  const y0 = plan.minimumY;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalCompositeOperation = 'source-over';
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'medium';
  context.clearRect(0, 0, width, height);
  for (const [color, tiles] of plan.fallback) {
    context.fillStyle = colorString(color);
    context.fill(tilePath(tiles, plan.width, r));
  }
  for (const [terrainId, tiles] of plan.base) {
    const terrain = sources.terrains.get(terrainId);
    if (!terrain?.texture) continue;
    const pattern = worldPattern(context, terrain.texture, terrain.textureSize, r, x0, y0);
    if (!pattern) continue;
    context.fillStyle = pattern;
    context.fill(tilePath(tiles, plan.width, r));
  }
  for (const [layerId, tiles] of plan.layers) {
    const layer = sources.terrains.get(layerId);
    if (!layer?.texture || !layer.overlayMask) continue;
    const temporary = scratch(width, height);
    const path = tilePath(tiles, plan.width, r);
    const texture = worldPattern(temporary, layer.texture, layer.textureSize, r, x0, y0);
    const mask = worldPattern(temporary, layer.overlayMask, layer.overlayMaskSize, r, x0, y0);
    if (!texture || !mask) continue;
    temporary.fillStyle = mask;
    temporary.fill(path);
    temporary.globalCompositeOperation = 'source-in';
    temporary.fillStyle = texture;
    temporary.fillRect(0, 0, width, height);
    context.drawImage(scratchCanvas!, 0, 0, width, height, 0, 0, width, height);
  }
  const cellSize = sources.atlasSize / 8;
  for (const group of plan.blends) {
    const atlas = sources.atlases[group.mode];
    const upper = sources.terrains.get(group.upper.terrain);
    if (!atlas || !upper?.texture) continue;
    const layered =
      group.upper.layer !== noTerrainLayer ? sources.terrains.get(group.upper.layer) : undefined;
    const passes: {
      texture: CanvasImageSource;
      size: number;
      mask: CanvasImageSource | null;
      maskSize: number;
    }[] = [{ texture: upper.texture, size: upper.textureSize, mask: null, maskSize: 0 }];
    if (layered?.texture && layered.overlayMask) {
      passes.push({
        texture: layered.texture,
        size: layered.textureSize,
        mask: layered.overlayMask,
        maskSize: layered.overlayMaskSize,
      });
    }
    for (const pass of passes) {
      const temporary = scratch(width, height);
      for (const quad of group.quads) {
        const cell = blendAtlasCell(quad.cell);
        temporary.drawImage(
          atlas,
          cell.column * cellSize,
          cell.row * cellSize,
          cellSize,
          cellSize,
          (quad.tile % plan.width) * r,
          Math.floor(quad.tile / plan.width) * r,
          r,
          r,
        );
      }
      if (pass.mask) {
        const mask = worldPattern(temporary, pass.mask, pass.maskSize, r, x0, y0);
        if (!mask) continue;
        temporary.globalCompositeOperation = 'destination-in';
        temporary.fillStyle = mask;
        temporary.fillRect(0, 0, width, height);
      }
      const texture = worldPattern(temporary, pass.texture, pass.size, r, x0, y0);
      if (!texture) continue;
      temporary.globalCompositeOperation = 'source-in';
      temporary.fillStyle = texture;
      temporary.fillRect(0, 0, width, height);
      context.drawImage(scratchCanvas!, 0, 0, width, height, 0, 0, width, height);
    }
  }
  if (plan.shading) {
    const { width: texels, height: rows, pixels } = plan.shading;
    const shading = new OffscreenCanvas(texels, rows);
    const shadingContext = shading.getContext('2d');
    if (shadingContext) {
      shadingContext.putImageData(new ImageData(new Uint8ClampedArray(pixels), texels, rows), 0, 0);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(shading, -r, -r, texels * r, rows * r);
    }
  }
}

export function chunkPixelsPerTile(screenPixelsPerTile: number): number {
  const wanted = Math.max(1, screenPixelsPerTile);
  return Math.min(32, Math.max(2, 2 ** Math.ceil(Math.log2(wanted))));
}

export function chunkSpriteMatrix(x0: number, y0: number, pixelsPerTile: number): Matrix {
  const inverse = 1 / pixelsPerTile;
  return new Matrix(inverse, -inverse, inverse, inverse, x0 + y0, y0 - x0);
}

interface RasterizedChunk {
  key: string;
  pixelsPerTile: number;
  sprite: Sprite;
  texture: Texture;
  bytes: number;
  lastUsed: number;
}

export interface GameArtTerrainStatistics {
  rasterizedChunks: number;
  pendingChunks: number;
  failedChunks: number;
  textureBytes: number;
  lastRasterMilliseconds: number;
  totalRasterMilliseconds: number;
}

export class GameArtTerrainLayer {
  readonly container = new Container({ label: 'game-textures-terrain' });
  readonly renderer = 'cpu' as const;
  private readonly chunks = new Map<string, RasterizedChunk>();
  private queue: { chunk: VisibleChunk; pixelsPerTile: number }[] = [];
  private frame: number | null = null;
  private visible = new Set<string>();
  private clock = 0;
  private destroyed = false;
  private shown = false;
  readonly statistics: GameArtTerrainStatistics = {
    rasterizedChunks: 0,
    pendingChunks: 0,
    failedChunks: 0,
    textureBytes: 0,
    lastRasterMilliseconds: 0,
    totalRasterMilliseconds: 0,
  };

  constructor(
    private readonly scene: GameArtTerrainScene,
    private readonly sources: GameArtTerrainSources,
    private readonly overlay: TerrainTileOverlay | null,
    private readonly budgetBytes: number,
    private readonly onChange: () => void,
    private readonly onPresented: () => void = () => undefined,
  ) {
    this.container.eventMode = 'none';
    this.container.visible = false;
  }

  get presented(): boolean {
    return this.shown;
  }

  private presentWhenComplete(): void {
    if (this.shown || this.destroyed || this.queue.length > 0) return;
    for (const key of this.visible) if (!this.chunks.has(key)) return;
    this.shown = true;
    this.container.visible = true;
    this.onPresented();
  }

  update(visibleChunks: readonly VisibleChunk[], wantedPixelsPerTile: number): void {
    if (this.destroyed) return;
    const pixelsPerTile = fittedPixelsPerTile(visibleChunks, wantedPixelsPerTile, this.budgetBytes);
    this.clock += 1;
    this.visible = new Set(visibleChunks.map((chunk) => chunkKey(chunk)));
    const wanted: typeof this.queue = [];
    for (const chunk of visibleChunks) {
      const key = chunkKey(chunk);
      const current = this.chunks.get(key);
      if (current) {
        current.lastUsed = this.clock;
        current.sprite.renderable = true;
        if (current.pixelsPerTile === pixelsPerTile) continue;
      }
      wanted.push({ chunk, pixelsPerTile });
    }
    for (const [key, chunk] of this.chunks) chunk.sprite.renderable = this.visible.has(key);
    this.queue = wanted;
    this.statistics.pendingChunks = this.queue.length;
    this.presentWhenComplete();
    this.schedule();
    requestPreviewRender(this.container);
  }

  private schedule(): void {
    if (this.frame !== null || this.queue.length === 0 || this.destroyed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.work();
    });
  }

  work(budgetMilliseconds = 10): void {
    const started = performance.now();
    let changed = false;
    while (this.queue.length > 0 && performance.now() - started < budgetMilliseconds) {
      const next = this.queue.shift()!;
      this.rasterize(next.chunk, next.pixelsPerTile);
      changed = true;
    }
    this.statistics.pendingChunks = this.queue.length;
    this.presentWhenComplete();
    if (changed) {
      this.onChange();
      requestPreviewRender(this.container);
    }
    this.schedule();
  }

  flush(): void {
    this.work(Number.POSITIVE_INFINITY);
  }

  private rasterize(chunk: VisibleChunk, pixelsPerTile: number): void {
    try {
      this.rasterizeChunk(chunk, pixelsPerTile, this.sources);
    } catch {
      this.statistics.failedChunks += 1;
      try {
        this.rasterizeChunk(chunk, pixelsPerTile, colorOnlySources(this.sources));
      } catch {}
    }
  }

  private rasterizeChunk(
    chunk: VisibleChunk,
    pixelsPerTile: number,
    sources: GameArtTerrainSources,
  ): void {
    const started = performance.now();
    const plan = planTerrainChunk(this.scene, chunk, sources.terrains, this.overlay, (mode) =>
      Boolean(sources.atlases[mode]),
    );
    const canvas = new OffscreenCanvas(plan.width * pixelsPerTile, plan.height * pixelsPerTile);
    const context = canvas.getContext('2d');
    if (!context) return;
    drawTerrainChunk(context, plan, sources, pixelsPerTile);
    const texture = new Texture({
      source: new CanvasSource({
        resource: canvas,
        autoGenerateMipmaps: true,
        scaleMode: 'linear',
      }),
    });
    const sprite = new Sprite({ texture });
    sprite.eventMode = 'none';
    sprite.setFromMatrix(chunkSpriteMatrix(chunk.minimumX, chunk.minimumY, pixelsPerTile));
    const key = chunkKey(chunk);
    const previous = this.chunks.get(key);
    if (previous) this.release(previous);
    const bytes = chunkTextureBytes(canvas.width, canvas.height);
    const record: RasterizedChunk = {
      key,
      pixelsPerTile,
      sprite,
      texture,
      bytes,
      lastUsed: this.clock,
    };
    sprite.renderable = this.visible.has(key);
    this.chunks.set(key, record);
    this.container.addChild(sprite);
    this.statistics.textureBytes += bytes;
    this.statistics.rasterizedChunks += 1;
    const elapsed = performance.now() - started;
    this.statistics.lastRasterMilliseconds = elapsed;
    this.statistics.totalRasterMilliseconds += elapsed;
    this.evict();
  }

  private release(chunk: RasterizedChunk): void {
    chunk.sprite.destroy();
    chunk.texture.destroy(true);
    this.statistics.textureBytes -= chunk.bytes;
    this.chunks.delete(chunk.key);
  }

  private evict(): void {
    if (this.statistics.textureBytes <= this.budgetBytes) return;
    const candidates = [...this.chunks.values()].sort(
      (left, right) =>
        Number(this.visible.has(left.key)) - Number(this.visible.has(right.key)) ||
        left.lastUsed - right.lastUsed,
    );
    for (const chunk of candidates) {
      if (this.statistics.textureBytes <= this.budgetBytes) break;
      if (this.visible.has(chunk.key)) break;
      this.release(chunk);
    }
  }

  get textureBytes(): number {
    return this.statistics.textureBytes;
  }

  destroy(): void {
    this.destroyed = true;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    for (const chunk of [...this.chunks.values()]) this.release(chunk);
    this.container.destroy({ children: true });
  }
}

export function colorOnlySources(sources: GameArtTerrainSources): GameArtTerrainSources {
  const terrains = new Map<number, GameArtTerrainSource>();
  for (const [id, terrain] of sources.terrains) {
    terrains.set(id, { ...terrain, texture: null, overlayMask: null });
  }
  return {
    terrains,
    atlases: sources.atlases.map(() => null),
    atlasSize: sources.atlasSize,
    assetKeys: sources.assetKeys,
  };
}

export function chunkKey(chunk: Pick<VisibleChunk, 'minimumX' | 'minimumY'>): string {
  return `${chunk.minimumX}:${chunk.minimumY}`;
}

export function chunkTextureBytes(width: number, height: number): number {
  return Math.round(width * height * 4 * 1.34);
}

export function fittedPixelsPerTile(
  visibleChunks: readonly Pick<VisibleChunk, 'minimumX' | 'maximumX' | 'minimumY' | 'maximumY'>[],
  wanted: number,
  budgetBytes: number,
): number {
  let pixelsPerTile = chunkPixelsPerTile(wanted);
  const tiles = visibleChunks.reduce(
    (total, chunk) =>
      total + (chunk.maximumX - chunk.minimumX + 1) * (chunk.maximumY - chunk.minimumY + 1),
    0,
  );
  while (
    pixelsPerTile > 2 &&
    chunkTextureBytes(tiles * pixelsPerTile, pixelsPerTile) > budgetBytes
  ) {
    pixelsPerTile /= 2;
  }
  return pixelsPerTile;
}
