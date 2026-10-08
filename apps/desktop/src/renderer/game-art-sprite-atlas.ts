import { CanvasSource, Rectangle, Texture } from 'pixi.js';

export interface SpriteAtlasRect {
  key: string;
  width: number;
  height: number;
}

export interface SpriteAtlasPlacement {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SpriteAtlasLayout {
  pages: { width: number; height: number }[];
  placements: Map<string, SpriteAtlasPlacement>;
  oversized: string[];
}

export interface SpriteAtlasPackOptions {
  maximumPageSize: number;
  gutter?: number;
  minimumPageSize?: number;
}

export const spriteAtlasGutter = 2;
export const spriteAtlasPreferredPageSize = 2048;
const pageHeightStep = 4;

function roundUp(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}

function ordered(rects: readonly SpriteAtlasRect[]): SpriteAtlasRect[] {
  const unique = new Map<string, SpriteAtlasRect>();
  for (const rect of rects) if (!unique.has(rect.key)) unique.set(rect.key, rect);
  return [...unique.values()].sort(
    (left, right) =>
      right.height - left.height ||
      right.width - left.width ||
      (left.key < right.key ? -1 : left.key > right.key ? 1 : 0),
  );
}

function shelfPack(
  rects: readonly SpriteAtlasRect[],
  pageWidth: number,
  pageHeight: number,
  gutter: number,
): { placements: Map<string, SpriteAtlasPlacement>; usedHeights: number[] } {
  const placements = new Map<string, SpriteAtlasPlacement>();
  const usedHeights: number[] = [0];
  let page = 0;
  let x = 0;
  let y = 0;
  let shelf = 0;
  for (const rect of rects) {
    const width = rect.width + gutter * 2;
    const height = rect.height + gutter * 2;
    if (x + width > pageWidth) {
      x = 0;
      y += shelf;
      shelf = 0;
    }
    if (y + height > pageHeight) {
      page += 1;
      usedHeights.push(0);
      x = 0;
      y = 0;
      shelf = 0;
    }
    placements.set(rect.key, {
      page,
      x: x + gutter,
      y: y + gutter,
      width: rect.width,
      height: rect.height,
    });
    x += width;
    shelf = Math.max(shelf, height);
    usedHeights[page] = Math.max(usedHeights[page]!, y + shelf);
  }
  return { placements, usedHeights };
}

export function packSpriteAtlas(
  rects: readonly SpriteAtlasRect[],
  options: SpriteAtlasPackOptions,
): SpriteAtlasLayout {
  const gutter = options.gutter ?? spriteAtlasGutter;
  const maximum = Math.max(1, Math.floor(options.maximumPageSize));
  const fits = (rect: SpriteAtlasRect) =>
    rect.width > 0 &&
    rect.height > 0 &&
    rect.width + gutter * 2 <= maximum &&
    rect.height + gutter * 2 <= maximum;
  const sorted = ordered(rects);
  const oversized = sorted.filter((rect) => !fits(rect)).map((rect) => rect.key);
  oversized.sort();
  const packable = sorted.filter(fits);
  if (packable.length === 0) return { pages: [], placements: new Map(), oversized };
  const widest = Math.max(...packable.map((rect) => rect.width + gutter * 2));
  let best: {
    width: number;
    height: number;
    placements: Map<string, SpriteAtlasPlacement>;
  } | null = null;
  for (let width = Math.max(options.minimumPageSize ?? 64, 1); width <= maximum; width *= 2) {
    if (width < widest) continue;
    const { placements, usedHeights } = shelfPack(packable, width, maximum, gutter);
    if (usedHeights.length !== 1) continue;
    const height = Math.min(maximum, roundUp(usedHeights[0]!, pageHeightStep));
    const better =
      !best ||
      width * height < best.width * best.height ||
      (width * height === best.width * best.height &&
        Math.max(width, height) < Math.max(best.width, best.height));
    if (better) best = { width, height, placements };
  }
  if (best) {
    return {
      pages: [{ width: best.width, height: best.height }],
      placements: best.placements,
      oversized,
    };
  }
  const { placements, usedHeights } = shelfPack(packable, maximum, maximum, gutter);
  const pages = usedHeights.map((used, index) => ({
    width: maximum,
    height:
      index === usedHeights.length - 1 ? Math.min(maximum, roundUp(used, pageHeightStep)) : maximum,
  }));
  return { pages, placements, oversized };
}

export interface SpriteAtlasContext {
  drawImage(image: CanvasImageSource, x: number, y: number, width: number, height: number): void;
  putImageData(data: ImageData, x: number, y: number): void;
}

export interface SpriteAtlasCanvas {
  readonly width: number;
  readonly height: number;
  getContext(kind: '2d'): SpriteAtlasContext | null;
}

export type SpriteAtlasCanvasFactory = (width: number, height: number) => SpriteAtlasCanvas;

export interface SpriteAtlasEntry extends SpriteAtlasRect {
  draw(context: SpriteAtlasContext, x: number, y: number): void;
}

export interface SpriteAtlasBuildOptions {
  maximumTextureSize?: number;
  maximumBytes: number;
  createCanvas?: SpriteAtlasCanvasFactory;
}

export type SpriteAtlasFallbackReason =
  'empty' | 'oversized' | 'too-large' | 'no-canvas' | 'failed';

export class SpriteAtlas {
  private readonly textures = new Map<string, Texture>();
  private readonly sources: CanvasSource[] = [];

  constructor(
    readonly layout: SpriteAtlasLayout,
    readonly canvases: readonly SpriteAtlasCanvas[],
  ) {
    for (const canvas of canvases) {
      this.sources.push(
        new CanvasSource({
          resource: canvas as unknown as HTMLCanvasElement,
          scaleMode: 'linear',
          autoGenerateMipmaps: false,
        }),
      );
    }
    for (const [key, at] of layout.placements) {
      this.textures.set(
        key,
        new Texture({
          source: this.sources[at.page]!,
          frame: new Rectangle(at.x, at.y, at.width, at.height),
        }),
      );
    }
  }

  texture(key: string): Texture | undefined {
    return this.textures.get(key);
  }

  owns(texture: Texture): boolean {
    return this.sources.includes(texture.source as CanvasSource);
  }

  get pageCount(): number {
    return this.layout.pages.length;
  }

  get bytes(): number {
    return spriteAtlasBytes(this.layout);
  }

  destroy(): void {
    for (const texture of this.textures.values()) texture.destroy(false);
    this.textures.clear();
    for (const source of this.sources) source.destroy();
    this.sources.length = 0;
  }
}

export function spriteAtlasBytes(layout: Pick<SpriteAtlasLayout, 'pages'>): number {
  return layout.pages.reduce((total, page) => total + page.width * page.height * 4, 0);
}

function offscreenCanvas(width: number, height: number): SpriteAtlasCanvas {
  return new OffscreenCanvas(width, height) as unknown as SpriteAtlasCanvas;
}

export function buildSpriteAtlas(
  entries: readonly SpriteAtlasEntry[],
  options: SpriteAtlasBuildOptions,
): { atlas: SpriteAtlas } | { fallback: SpriteAtlasFallbackReason } {
  if (entries.length === 0) return { fallback: 'empty' };
  const maximumPageSize = Math.min(
    spriteAtlasPreferredPageSize,
    options.maximumTextureSize ?? spriteAtlasPreferredPageSize,
  );
  const layout = packSpriteAtlas(entries, { maximumPageSize });
  if (layout.oversized.length > 0) return { fallback: 'oversized' };
  if (spriteAtlasBytes(layout) > options.maximumBytes) return { fallback: 'too-large' };
  const create = options.createCanvas ?? offscreenCanvas;
  const canvases: SpriteAtlasCanvas[] = [];
  const contexts: SpriteAtlasContext[] = [];
  try {
    for (const page of layout.pages) {
      const canvas = create(page.width, page.height);
      const context = canvas.getContext('2d');
      if (!context) return { fallback: 'no-canvas' };
      canvases.push(canvas);
      contexts.push(context);
    }
  } catch {
    return { fallback: 'no-canvas' };
  }
  try {
    const byKey = new Map(entries.map((entry) => [entry.key, entry]));
    for (const [key, at] of layout.placements) {
      byKey.get(key)!.draw(contexts[at.page]!, at.x, at.y);
    }
    return { atlas: new SpriteAtlas(layout, canvases) };
  } catch {
    return { fallback: 'failed' };
  }
}
