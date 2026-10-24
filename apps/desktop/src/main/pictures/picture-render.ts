import { constants, deflateSync } from 'node:zlib';
import { lookMarkerObjectColors, textureLookColors } from '../../shared/texture-palette';
import {
  minimapSquareClassifier,
  minimapSquareColor,
  minimapSquareDrawLayer,
  minimapSquareSide,
  minimapSquareSizes,
  minimapSquareTownCenterBorderColor,
  minimapSquareTownCenterPolygon,
  type MinimapSquareClass,
} from '../../renderer/minimap-squares';
import {
  litColor,
  raisedLightStrength,
  raisedSurfaceFor,
  raisedWallLight,
  type ElevationSurface,
} from '../../renderer/preview-elevation';
import {
  cliffMaterial,
  isVisiblePreviewObject,
  markerShapePolygon,
  objectCategoryShapes,
  objectMaterial,
  ownerPreviewColor,
  terrainMaterial,
} from '../../renderer/preview-materials';
import { previewObjectCategory } from '../../renderer/preview-object-category';
import { terrainReliefLight, terrainReliefShadeLevel } from '../../renderer/preview-terrain-mesh';
import {
  previewObjectMarkerScreenRadius,
  previewObjectMarkerSpan,
} from '../../renderer/top-down-preview';
import { assembleRgbaPng, rgbaPngScanlines } from '../map-icon-png';
import { PictureCanvas } from './picture-canvas';
import {
  pictureColourLook,
  pictureContract,
  validatePictureRequest,
  type PictureCell,
  type PictureCellLayout,
  type PictureLook,
  type PicturePerspective,
  type PictureRegion,
  type PictureRequest,
  type PictureResult,
  type PictureTerrainTexture,
} from './picture-contract';
import { PictureError } from './picture-error';
import { pictureTextHeight, pictureTextWidth } from './picture-font';
import type { PictureMap } from './picture-map';

const background = 0x1c1c1c;
const labelColor = 0xe6e6e6;
const tickColor = 0x9a9a9a;
const outlineColor = 0x000000;
const errorColor = 0xff3b30;
const warningColor = 0xffb000;
const lineColor = 0xffffff;
const s = Math.SQRT1_2;

const deflateOptions = {
  level: 6,
  memLevel: 9,
  strategy: constants.Z_DEFAULT_STRATEGY,
  windowBits: 15,
} as const;

const unitProjections: Readonly<
  Record<PicturePerspective, { a: number; b: number; c: number; d: number; vertical: number }>
> = Object.freeze({
  grid: { a: 1, b: 0, c: 0, d: 1, vertical: 1 },
  top_down: { a: s, b: s, c: -s, d: s, vertical: 1 },
  diamond: { a: s, b: s, c: -s / 2, d: s / 2, vertical: 0.5 },
});

export interface PictureProjection {
  perspective: PicturePerspective;
  k: number;
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
  vertical: number;
  lift: number;
}

export function pictureScreenPoint(
  projection: PictureProjection,
  x: number,
  y: number,
): { x: number; y: number } {
  return {
    x: projection.e + projection.a * x + projection.b * y,
    y: projection.f + projection.c * x + projection.d * y,
  };
}

export function pictureMapPoint(
  projection: PictureProjection,
  screenX: number,
  screenY: number,
): { x: number; y: number } {
  const { a, b, c, d, e, f } = projection;
  const determinant = a * d - b * c;
  const dx = screenX - e;
  const dy = screenY - f;
  return { x: (d * dx - b * dy) / determinant, y: (a * dy - c * dx) / determinant };
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function pictureRegionUnitBox(
  region: PictureRegion,
  map: Pick<PictureMap, 'width' | 'height' | 'players'>,
  perspective: PicturePerspective,
  raisedLevels = 0,
): Box {
  const unit = unitProjections[perspective];
  if (region.kind === 'camera') {
    const padding = region.padding ?? 0;
    const available = Math.max(
      1,
      Math.min(region.viewportWidth - padding * 2, region.viewportHeight - padding * 2),
    );
    const scale = (available / (s * (map.width + map.height))) * region.zoom;
    const centerX = unit.a * region.centerX + unit.b * region.centerY;
    const centerY = unit.c * region.centerX + unit.d * region.centerY;
    const halfWidth = region.viewportWidth / scale / 2;
    const halfHeight = region.viewportHeight / scale / 2;
    return {
      left: centerX - halfWidth,
      top: centerY - halfHeight,
      right: centerX + halfWidth,
      bottom: centerY + halfHeight,
    };
  }
  const rectangle = pictureRegionTiles(region, map);
  const corners = [
    [rectangle.left, rectangle.top],
    [rectangle.right, rectangle.top],
    [rectangle.right, rectangle.bottom],
    [rectangle.left, rectangle.bottom],
  ] as const;
  const box: Box = {
    left: Number.POSITIVE_INFINITY,
    top: Number.POSITIVE_INFINITY,
    right: Number.NEGATIVE_INFINITY,
    bottom: Number.NEGATIVE_INFINITY,
  };
  for (const [x, y] of corners) {
    const px = unit.a * x + unit.b * y;
    const py = unit.c * x + unit.d * y;
    box.left = Math.min(box.left, px);
    box.right = Math.max(box.right, px);
    box.top = Math.min(box.top, py);
    box.bottom = Math.max(box.bottom, py);
  }
  box.top -= raisedLevels * (s / 2);
  return box;
}

export function pictureRegionTiles(
  region: Exclude<PictureRegion, { kind: 'camera' }>,
  map: Pick<PictureMap, 'width' | 'height' | 'players'>,
): Box {
  switch (region.kind) {
    case 'whole':
      return { left: 0, top: 0, right: map.width, bottom: map.height };
    case 'tiles':
      return {
        left: region.x,
        top: region.y,
        right: Math.min(map.width, region.x + region.w),
        bottom: Math.min(map.height, region.y + region.h),
      };
    case 'base': {
      const player = map.players.find((entry) => entry.owner === region.player);
      if (!player) throw new PictureError('invalid-request', 'the base names no player start');
      return {
        left: player.x - region.radius,
        top: player.y - region.radius,
        right: player.x + region.radius,
        bottom: player.y + region.radius,
      };
    }
  }
}

interface ResolvedCell extends PictureCell {
  look: PictureLook;
  perspective: PicturePerspective;
  raised: boolean;
  box: Box;
}

interface Layout {
  width: number;
  height: number;
  k: number;
  fontScale: number;
  columns: number;
  slots: { x: number; y: number }[];
  contentWidth: number;
  contentHeight: number;
  margins: { left: number; top: number; right: number; bottom: number; caption: number };
}

export function defaultPictureColumns(cells: number): number {
  if (cells <= 3) return cells;
  if (cells === 4) return 2;
  if (cells === 7 || cells === 8) return 4;
  return 3;
}

function fontScaleFor(maxSide: number): number {
  return maxSide >= 640 ? 2 : 1;
}

function computeLayout(request: PictureRequest, cells: readonly ResolvedCell[]): Layout {
  const fontScale = fontScaleFor(request.maxSide);
  const grid = request.overlays?.grid === true;
  const columns = request.columns ?? defaultPictureColumns(cells.length);
  const rows = Math.ceil(cells.length / columns);
  const textHeight = pictureTextHeight(fontScale);
  const labelWidth = pictureTextWidth('000', fontScale);
  const tick = 3 * fontScale;
  const pad = 4 * fontScale;
  const allGrid = cells.every((cell) => cell.perspective === 'grid');
  const margins = grid
    ? allGrid
      ? {
          left: labelWidth + tick + 2 * fontScale + pad,
          top: textHeight + tick + 2 * fontScale + pad,
          right: Math.ceil(labelWidth / 2) + pad,
          bottom: pad,
        }
      : (() => {
          const side = labelWidth + tick + 3 * fontScale + pad;
          return { left: side, top: side, right: side, bottom: side };
        })()
    : { left: pad, top: pad, right: pad, bottom: pad };
  const caption = cells.some((cell) => cell.caption) ? textHeight + 3 * fontScale : 0;
  const gap = cells.length > 1 ? 4 * fontScale : 0;
  const boxWidth = Math.max(...cells.map((cell) => cell.box.right - cell.box.left));
  const boxHeight = Math.max(...cells.map((cell) => cell.box.bottom - cell.box.top));
  const fixedWidth = columns * (margins.left + margins.right) + (columns - 1) * gap;
  const fixedHeight = rows * (margins.top + margins.bottom + caption) + (rows - 1) * gap;
  const availableWidth = request.maxSide - fixedWidth;
  const availableHeight = request.maxSide - fixedHeight;
  if (availableWidth < columns || availableHeight < rows) {
    throw new PictureError('too-large', 'the grid does not fit the picture size');
  }
  let k = Math.min(availableWidth / (columns * boxWidth), availableHeight / (rows * boxHeight));
  if (cells.some((cell) => cell.region.kind !== 'whole')) {
    k = Math.min(k, pictureContract.maximumAreaPixelsPerTile);
  }
  if (allGrid && k >= 1 && Math.floor(k + 1e-9) >= 0.85 * k) k = Math.floor(k + 1e-9);
  const contentWidth = Math.ceil(boxWidth * k - 1e-6);
  const contentHeight = Math.ceil(boxHeight * k - 1e-6);
  const slotWidth = margins.left + contentWidth + margins.right;
  const slotHeight = caption + margins.top + contentHeight + margins.bottom;
  let width = columns * slotWidth + (columns - 1) * gap;
  let height = rows * slotHeight + (rows - 1) * gap;
  let offsetX = 0;
  let offsetY = 0;
  if (Math.max(width, height) < pictureContract.minimumSide) {
    const grow = pictureContract.minimumSide - Math.max(width, height);
    if (width >= height) {
      offsetX = Math.floor(grow / 2);
      width += grow;
    } else {
      offsetY = Math.floor(grow / 2);
      height += grow;
    }
  }
  const slots = cells.map((_, index) => ({
    x: offsetX + (index % columns) * (slotWidth + gap),
    y: offsetY + Math.floor(index / columns) * (slotHeight + gap),
  }));
  return {
    width,
    height,
    k,
    fontScale,
    columns,
    slots,
    contentWidth,
    contentHeight,
    margins: { ...margins, caption },
  };
}

interface TerrainColors {
  base: Int32Array;
  shaded: Int32Array;
}

interface ReliefOverlay {
  lit: Float32Array;
  alpha: Float32Array;
}

class RenderCache {
  private readonly terrains = new Map<string, TerrainColors>();
  private readonly overlays = new Map<number, ReliefOverlay>();

  terrain(map: PictureMap, mapIndex: number, look: PictureLook, shaded: boolean): TerrainColors {
    const colourLook = pictureColourLook(look);
    const key = `${mapIndex}:${colourLook}:${shaded}`;
    let colors = this.terrains.get(key);
    if (!colors) {
      colors = terrainColors(map, colourLook, shaded);
      this.terrains.set(key, colors);
    }
    return colors;
  }

  reliefOverlay(map: PictureMap, mapIndex: number): ReliefOverlay {
    let overlay = this.overlays.get(mapIndex);
    if (!overlay) {
      overlay = reliefOverlay(map);
      this.overlays.set(mapIndex, overlay);
    }
    return overlay;
  }
}

function reliefOverlay(map: PictureMap): ReliefOverlay {
  const tiles = map.width * map.height;
  const lit = new Float32Array(tiles);
  const alpha = new Float32Array(tiles);
  const scene = { width: map.width, height: map.height, elevations: map.elevations };
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const level = terrainReliefShadeLevel(scene, x, y);
      if (level === 0) continue;
      const index = y * map.width + x;
      const amount = Math.min(0.2, Math.abs(level) * 0.065);
      alpha[index] = amount;
      lit[index] = level > 0 ? amount * 255 : 0;
    }
  }
  return { lit, alpha };
}

function terrainColors(
  map: PictureMap,
  look: 'minimap' | 'texture-colors',
  shaded: boolean,
): TerrainColors {
  const tiles = map.width * map.height;
  const base = new Int32Array(tiles);
  const lit = new Int32Array(tiles);
  const lookColors =
    look === 'texture-colors' && map.texturePalette
      ? textureLookColors(map.texturePalette).terrains
      : undefined;
  const materials = new Map<number, number>();
  const scene = { width: map.width, height: map.height, elevations: map.elevations };
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const index = y * map.width + x;
      const terrainId = map.terrainIds[index]!;
      let color = materials.get(terrainId);
      if (color === undefined) {
        color = terrainMaterial(
          terrainId,
          map.backend,
          map.minimapPalette,
          map.terrainNames,
          undefined,
          undefined,
          lookColors,
        ).color;
        materials.set(terrainId, color);
      }
      base[index] = color;
      lit[index] = shaded ? litColor(color, terrainReliefLight(scene, x, y)) : color;
    }
  }
  return { base, shaded: lit };
}

function cellProjection(
  cell: ResolvedCell,
  k: number,
  contentX: number,
  contentY: number,
  layout: Layout,
): PictureProjection {
  const unit = unitProjections[cell.perspective];
  const width = (cell.box.right - cell.box.left) * k;
  const height = (cell.box.bottom - cell.box.top) * k;
  const originX = contentX + (layout.contentWidth - width) / 2;
  const originY = contentY + (layout.contentHeight - height) / 2;
  return {
    perspective: cell.perspective,
    k,
    a: unit.a * k,
    b: unit.b * k,
    c: unit.c * k,
    d: unit.d * k,
    e: originX - cell.box.left * k,
    f: originY - cell.box.top * k,
    vertical: unit.vertical,
    lift: cell.raised ? (k * s) / 2 : 0,
  };
}

function liftedPoint(
  projection: PictureProjection,
  surface: ElevationSurface | null,
  x: number,
  y: number,
): { x: number; y: number } {
  const point = pictureScreenPoint(projection, x, y);
  if (surface) point.y -= surface.heightAt(x, y) * projection.lift;
  return point;
}

export function sampleTerrainTexture(texture: PictureTerrainTexture, x: number, y: number): number {
  const r = texture.texelsPerTile;
  const width = texture.columns * r;
  const height = texture.rows * r;
  const u = Math.min(width - 1, Math.max(0, (x - texture.left) * r - 0.5));
  const v = Math.min(height - 1, Math.max(0, (y - texture.top) * r - 0.5));
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = u - x0;
  const fy = v - y0;
  const data = texture.pixels;
  const topLeft = (y0 * width + x0) * 4;
  const topRight = (y0 * width + x1) * 4;
  const bottomLeft = (y1 * width + x0) * 4;
  const bottomRight = (y1 * width + x1) * 4;
  let color = 0;
  for (let channel = 0; channel < 3; channel += 1) {
    const value =
      (data[topLeft + channel]! * (1 - fx) + data[topRight + channel]! * fx) * (1 - fy) +
      (data[bottomLeft + channel]! * (1 - fx) + data[bottomRight + channel]! * fx) * fy;
    color |= Math.min(255, Math.max(0, Math.round(value))) << (16 - channel * 8);
  }
  return color;
}

function overlaidColor(
  map: PictureMap,
  overlay: ReliefOverlay,
  color: number,
  x: number,
  y: number,
): number {
  const cx = Math.min(map.width - 1, Math.max(0, x - 0.5));
  const cy = Math.min(map.height - 1, Math.max(0, y - 0.5));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(map.width - 1, x0 + 1);
  const y1 = Math.min(map.height - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const corners = [
    [y0 * map.width + x0, (1 - fx) * (1 - fy)],
    [y0 * map.width + x1, fx * (1 - fy)],
    [y1 * map.width + x0, (1 - fx) * fy],
    [y1 * map.width + x1, fx * fy],
  ] as const;
  let alpha = 0;
  let lit = 0;
  for (const [index, weight] of corners) {
    alpha += overlay.alpha[index]! * weight;
    lit += overlay.lit[index]! * weight;
  }
  if (alpha <= 0) return color;
  let result = 0;
  for (let channel = 0; channel < 3; channel += 1) {
    const value = ((color >> (16 - channel * 8)) & 0xff) * (1 - alpha) + lit;
    result |= Math.min(255, Math.max(0, Math.round(value))) << (16 - channel * 8);
  }
  return result;
}

interface TexturedTerrain {
  texture: PictureTerrainTexture;
  overlay: ReliefOverlay | null;
}

function drawTerrain(
  canvas: PictureCanvas,
  map: PictureMap,
  colors: TerrainColors,
  projection: PictureProjection,
  surface: ElevationSurface | null,
  textured: TexturedTerrain | null = null,
): void {
  const clip = canvas.clip;
  if (surface && textured) {
    const component = projection.k * s;
    const vertical = component / 2;
    const strength = raisedLightStrength.gameTextures;
    for (let px = clip.left; px < clip.right; px += 1) {
      canvas.tickRow();
      const sum = (px + 0.5 - projection.e) / component;
      let from = Number.NEGATIVE_INFINITY;
      for (let py = clip.bottom - 1; py >= clip.top; py -= 1) {
        const difference = (py + 0.5 - projection.f) / vertical;
        const hit = surface.pickInto(sum, difference, from);
        if (!hit) {
          from = Number.NEGATIVE_INFINITY;
          continue;
        }
        from = hit.resumable ? hit.x - 1e-9 : Number.NEGATIVE_INFINITY;
        const light = hit.wall
          ? raisedWallLight(hit.wall, strength)
          : surface.smoothLightAt(hit.x, hit.y, strength);
        canvas.setPixel(
          px,
          py,
          litColor(sampleTerrainTexture(textured.texture, hit.x, hit.y), light),
        );
      }
    }
    return;
  }
  if (surface) {
    const component = projection.k * s;
    const vertical = component / 2;
    for (let px = clip.left; px < clip.right; px += 1) {
      canvas.tickRow();
      const sum = (px + 0.5 - projection.e) / component;
      let from = Number.NEGATIVE_INFINITY;
      for (let py = clip.bottom - 1; py >= clip.top; py -= 1) {
        const difference = (py + 0.5 - projection.f) / vertical;
        const hit = surface.pickInto(sum, difference, from);
        if (!hit) {
          from = Number.NEGATIVE_INFINITY;
          continue;
        }
        from = hit.resumable ? hit.x - 1e-9 : Number.NEGATIVE_INFINITY;
        const index = hit.tileY * map.width + hit.tileX;
        const light = hit.wall
          ? raisedWallLight(hit.wall, raisedLightStrength.colorLooks)
          : surface.tileLight(index, raisedLightStrength.colorLooks);
        canvas.setPixel(px, py, litColor(colors.base[index]!, light));
      }
    }
    return;
  }
  const tiles = colors.shaded;
  const { a, b, c, d, e, f } = projection;
  const determinant = a * d - b * c;
  for (let py = clip.top; py < clip.bottom; py += 1) {
    canvas.tickRow();
    const dy = py + 0.5 - f;
    for (let px = clip.left; px < clip.right; px += 1) {
      const dx = px + 0.5 - e;
      const x = (d * dx - b * dy) / determinant;
      const y = (a * dy - c * dx) / determinant;
      if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
      if (textured) {
        const color = sampleTerrainTexture(textured.texture, x, y);
        canvas.setPixel(
          px,
          py,
          textured.overlay ? overlaidColor(map, textured.overlay, color, x, y) : color,
        );
        continue;
      }
      canvas.setPixel(px, py, tiles[Math.floor(y) * map.width + Math.floor(x)]!);
    }
  }
}

function drawCliffs(
  canvas: PictureCanvas,
  map: PictureMap,
  look: 'minimap' | 'texture-colors',
  projection: PictureProjection,
  surface: ElevationSurface | null,
): void {
  const textureCliffs =
    look === 'texture-colors' && map.texturePalette
      ? textureLookColors(map.texturePalette).cliffs
      : undefined;
  const colors = new Map<number, number>();
  const width = Math.min(18, Math.max(1.5, projection.k * 0.7));
  const { points, types } = map.cliffs;
  for (let index = 0; index < types.length; index += 1) {
    if (index % 4096 === 0) canvas.checkCancelled();
    const type = types[index]!;
    let color = colors.get(type);
    if (color === undefined) {
      color = cliffMaterial(type, look, null, textureCliffs).color;
      colors.set(type, color);
    }
    const from = liftedPoint(projection, surface, points[index * 4]!, points[index * 4 + 1]!);
    const to = liftedPoint(projection, surface, points[index * 4 + 2]!, points[index * 4 + 3]!);
    canvas.strokeSegment(from.x, from.y, to.x, to.y, width, color);
  }
}

function nearClip(canvas: PictureCanvas, x: number, y: number, margin: number): boolean {
  const clip = canvas.clip;
  return (
    x >= clip.left - margin &&
    x < clip.right + margin &&
    y >= clip.top - margin &&
    y < clip.bottom + margin
  );
}

function drawMarkerObjects(
  canvas: PictureCanvas,
  map: PictureMap,
  look: 'minimap' | 'texture-colors',
  projection: PictureProjection,
  surface: ElevationSurface | null,
): void {
  const objects = map.objects;
  const helpers = new Set(map.helperObjectIds);
  const neutralColors = lookMarkerObjectColors(look, map.texturePalette);
  const colorCache = new Map<number, number>();
  const layers: number[][] = [[], [], []];
  for (let index = 0; index < objects.ids.length; index += 1) {
    if (objects.trees[index] === 1) continue;
    const objectId = objects.ids[index]!;
    if (!isVisiblePreviewObject({ objectId }) || helpers.has(objectId)) continue;
    const category = previewObjectCategory(categoryObject(map, index));
    const layer =
      category === 'building' || category === 'farm' || category === 'wall'
        ? 0
        : category === 'tree'
          ? 1
          : 2;
    layers[layer]!.push(index);
  }
  const outlineMinimum = 6;
  let drawn = 0;
  for (const indices of layers) {
    for (const index of indices) {
      if (drawn % 1024 === 0) canvas.checkCancelled();
      drawn += 1;
      const object = categoryObject(map, index);
      const objectId = objects.ids[index]!;
      const owner = objects.owners[index]!;
      const key = objectId * 512 + owner * 2 + objects.walls[index]!;
      let color = colorCache.get(key);
      if (color === undefined) {
        color = objectMaterial(
          { ...object, objectId, owner },
          map.playerColorIds,
          [],
          map.minimapPalette,
          undefined,
          helpers,
          neutralColors,
        ).color;
        colorCache.set(key, color);
      }
      const x = objects.x[index]!;
      const y = objects.y[index]!;
      const category = previewObjectCategory(object);
      const center = liftedPoint(projection, surface, x, y);
      if (category === 'building' || category === 'farm' || category === 'wall') {
        const halfWidth = Math.max(0.5, object.footprintWidth) / 2;
        const halfHeight = Math.max(0.5, object.footprintHeight) / 2;
        if (!nearClip(canvas, center.x, center.y, (halfWidth + halfHeight) * projection.k + 2)) {
          continue;
        }
        const lift = center.y - pictureScreenPoint(projection, x, y).y;
        const quad: number[] = [];
        for (const [cornerX, cornerY] of [
          [x - halfWidth, y - halfHeight],
          [x + halfWidth, y - halfHeight],
          [x + halfWidth, y + halfHeight],
          [x - halfWidth, y + halfHeight],
        ] as const) {
          const corner = pictureScreenPoint(projection, cornerX, cornerY);
          quad.push(corner.x, corner.y + lift);
        }
        canvas.fillPolygon(quad, color);
        if (projection.k * Math.min(halfWidth, halfHeight) * 2 >= outlineMinimum) {
          const edge = litColor(color, 0.55);
          for (let corner = 0; corner < 4; corner += 1) {
            const next = (corner + 1) % 4;
            canvas.strokeSegment(
              quad[corner * 2]!,
              quad[corner * 2 + 1]!,
              quad[next * 2]!,
              quad[next * 2 + 1]!,
              1,
              edge,
            );
          }
        }
        continue;
      }
      const radius = previewObjectMarkerScreenRadius(
        projection.k,
        previewObjectMarkerSpan(object, object.presentationKind),
      );
      if (!nearClip(canvas, center.x, center.y, radius + 1)) continue;
      const shape = objectCategoryShapes[category];
      const vertical = projection.vertical;
      if (shape === 'circle' || shape === 'crown') {
        canvas.fillEllipse(center.x, center.y, radius, radius * vertical, color);
      } else if (shape === 'cluster') {
        const dot = radius * 0.5;
        for (const [offsetX, offsetY] of [
          [-0.5, 0.35],
          [0.5, 0.35],
          [0, -0.5],
        ] as const) {
          canvas.fillEllipse(
            center.x + offsetX * radius,
            center.y + offsetY * radius * vertical,
            dot,
            dot * vertical,
            color,
          );
        }
      } else {
        canvas.fillPolygon(markerShapePolygon(shape, center.x, center.y, radius, vertical), color);
      }
    }
  }
}

function categoryObject(map: PictureMap, index: number) {
  const objects = map.objects;
  const objectClass = objects.classes[index]!;
  return {
    presentationKind: objects.walls[index] === 1 ? ('wall' as const) : ('object' as const),
    ...(objectClass >= 0 ? { objectClass } : {}),
    resourceType: objects.resourceTypes[index]!,
    footprintWidth: objects.footprintWidths[index]!,
    footprintHeight: objects.footprintHeights[index]!,
    ...(objects.trees[index] === 1 ? { appearance: 'tree' as const } : {}),
  };
}

function drawMinimapObjects(
  canvas: PictureCanvas,
  map: PictureMap,
  projection: PictureProjection,
  surface: ElevationSurface | null,
  unit: number,
  wholeMapK: number,
): void {
  const objects = map.objects;
  const classifier = minimapSquareClassifier({
    artObjects: map.artObjects,
    minimapPalette: map.minimapPalette,
    helperObjectIds: new Set(map.helperObjectIds),
  });
  const tileWidth = projection.perspective === 'grid' ? projection.k : projection.k * Math.SQRT2;
  const baseWidth = (tileWidth * Math.min(projection.k, wholeMapK)) / projection.k;
  const sizes = minimapSquareSizes({
    component: tileWidth / 2,
    baseComponent: baseWidth / 2,
    verticalScale: projection.vertical,
    unit,
  });
  const layers: { index: number; kind: MinimapSquareClass }[][] = [[], [], [], []];
  for (let index = 0; index < objects.ids.length; index += 1) {
    const kind = classifier.classify({
      objectId: objects.ids[index]!,
      owner: objects.owners[index]!,
      resourceType: objects.resourceTypes[index]!,
      ...(objects.trees[index] === 1 ? { appearance: 'tree' as const } : {}),
    });
    if (kind) layers[minimapSquareDrawLayer(kind)]!.push({ index, kind });
  }
  let drawn = 0;
  for (const layer of layers) {
    for (const { index, kind } of layer) {
      if (drawn % 1024 === 0) canvas.checkCancelled();
      drawn += 1;
      const center = liftedPoint(projection, surface, objects.x[index]!, objects.y[index]!);
      const color = minimapSquareColor(kind, objects.owners[index]!, map.playerColorIds);
      if (kind === 'town-center') {
        if (!nearClip(canvas, center.x, center.y, sizes.townCenter)) continue;
        const border = 1.5 * unit;
        canvas.fillPolygon(
          minimapSquareTownCenterPolygon(center.x, center.y, sizes.townCenter + 2 * border),
          minimapSquareTownCenterBorderColor,
        );
        canvas.fillPolygon(
          minimapSquareTownCenterPolygon(center.x, center.y, sizes.townCenter),
          color,
        );
        continue;
      }
      const half = minimapSquareSide(kind, sizes) / 2;
      canvas.fillBox(center.x - half, center.y - half, center.x + half, center.y + half, color);
    }
  }
}

function playerColor(map: PictureMap, owner: number): number {
  return ownerPreviewColor(owner, map.playerColorIds);
}

function relativeLuminance(rgb: number): number {
  return 0.2126 * ((rgb >> 16) & 0xff) + 0.7152 * ((rgb >> 8) & 0xff) + 0.0722 * (rgb & 0xff);
}

function drawPlayers(
  canvas: PictureCanvas,
  map: PictureMap,
  projection: PictureProjection,
  surface: ElevationSurface | null,
  fontScale: number,
): void {
  const tileWidth = projection.perspective === 'grid' ? projection.k : projection.k * Math.SQRT2;
  const outer = Math.min(20 * fontScale, Math.max(6 * fontScale, 2 * tileWidth));
  const width = 2 * fontScale;
  for (const player of map.players) {
    const center = liftedPoint(projection, surface, player.x, player.y);
    const color = playerColor(map, player.owner);
    canvas.strokeRing(
      center.x,
      center.y,
      outer - width - fontScale,
      outer + fontScale,
      projection.vertical,
      outlineColor,
    );
    canvas.strokeRing(center.x, center.y, outer - width, outer, projection.vertical, color);
    const text = String(player.owner);
    const textWidth = pictureTextWidth(text, fontScale);
    const textHeight = pictureTextHeight(fontScale);
    const left = Math.round(center.x + outer * 0.7);
    const top = Math.round(center.y - outer * 0.7 * projection.vertical - textHeight);
    canvas.fillRect(
      left - 2 * fontScale,
      top - 2 * fontScale,
      textWidth + 4 * fontScale,
      textHeight + 4 * fontScale,
      outlineColor,
    );
    canvas.fillRect(
      left - fontScale,
      top - fontScale,
      textWidth + 2 * fontScale,
      textHeight + 2 * fontScale,
      color,
    );
    canvas.drawText(
      text,
      left,
      top,
      fontScale,
      relativeLuminance(color) > 140 ? 0x000000 : 0xffffff,
    );
  }
}

function drawMarks(
  canvas: PictureCanvas,
  request: PictureRequest,
  mapIndex: number,
  projection: PictureProjection,
  surface: ElevationSurface | null,
  fontScale: number,
): void {
  const size = 5 * fontScale;
  for (const mark of request.overlays?.marks ?? []) {
    if (mark.map !== mapIndex) continue;
    const center = liftedPoint(projection, surface, mark.x, mark.y);
    if (mark.kind === 'error') {
      for (const [width, color] of [
        [4 * fontScale, outlineColor],
        [2 * fontScale, errorColor],
      ] as const) {
        canvas.strokeSegment(
          center.x - size,
          center.y - size,
          center.x + size,
          center.y + size,
          width,
          color,
        );
        canvas.strokeSegment(
          center.x - size,
          center.y + size,
          center.x + size,
          center.y - size,
          width,
          color,
        );
      }
    } else {
      canvas.strokeRing(
        center.x,
        center.y,
        size - 2 * fontScale,
        size + fontScale,
        1,
        outlineColor,
      );
      canvas.strokeRing(center.x, center.y, size - fontScale, size, 1, warningColor);
    }
  }
}

function drawLines(
  canvas: PictureCanvas,
  request: PictureRequest,
  map: PictureMap,
  mapIndex: number,
  projection: PictureProjection,
  surface: ElevationSurface | null,
  fontScale: number,
): void {
  for (const line of request.overlays?.lines ?? []) {
    if (line.map !== mapIndex) continue;
    const from = liftedPoint(projection, surface, line.from.x, line.from.y);
    const to = liftedPoint(projection, surface, line.to.x, line.to.y);
    const color = line.player === undefined ? lineColor : playerColor(map, line.player);
    canvas.strokeSegment(from.x, from.y, to.x, to.y, 3 * fontScale, outlineColor);
    canvas.strokeSegment(from.x, from.y, to.x, to.y, 1.5 * fontScale, color);
  }
}

export function pictureTickStep(
  map: Pick<PictureMap, 'width' | 'height'>,
  spacing: number,
  fontScale: number,
): number {
  const base = Math.max(map.width, map.height) > 240 ? 20 : 10;
  const needed = pictureTextWidth('000', fontScale) + 3 * fontScale;
  for (const step of [10, 20, 25, 50, 100, 200, 500]) {
    if (step >= base && step * spacing >= needed) return step;
  }
  return 500;
}

function visibleTiles(
  projection: PictureProjection,
  map: PictureMap,
  left: number,
  top: number,
  width: number,
  height: number,
): Box {
  const corners = [
    pictureMapPoint(projection, left, top),
    pictureMapPoint(projection, left + width, top),
    pictureMapPoint(projection, left + width, top + height),
    pictureMapPoint(projection, left, top + height),
  ];
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  return {
    left: Math.max(0, Math.min(...xs)),
    top: Math.max(0, Math.min(...ys)),
    right: Math.min(map.width, Math.max(...xs)),
    bottom: Math.min(map.height, Math.max(...ys)),
  };
}

function drawGrid(
  canvas: PictureCanvas,
  map: PictureMap,
  projection: PictureProjection,
  contentX: number,
  contentY: number,
  layout: Layout,
): number {
  const fontScale = layout.fontScale;
  const textHeight = pictureTextHeight(fontScale);
  const tick = 3 * fontScale;
  const visible = visibleTiles(
    projection,
    map,
    contentX,
    contentY,
    layout.contentWidth,
    layout.contentHeight,
  );
  const tileEdge =
    projection.perspective === 'grid'
      ? projection.k
      : projection.perspective === 'top_down'
        ? projection.k
        : projection.k * Math.hypot(s, s / 2);
  const step = pictureTickStep(map, tileEdge, fontScale);
  const first = (minimum: number) => Math.ceil(minimum / step - 1e-9) * step;
  if (projection.perspective === 'grid') {
    const top = contentY;
    for (let value = first(visible.left); value <= visible.right + 1e-9; value += step) {
      const x = Math.round(projection.e + projection.a * value);
      canvas.fillRect(x - Math.floor(fontScale / 2), top - tick, fontScale, tick, tickColor);
      const text = String(value);
      canvas.drawText(
        text,
        Math.round(x - pictureTextWidth(text, fontScale) / 2),
        top - tick - fontScale - textHeight,
        fontScale,
        labelColor,
      );
    }
    const left = contentX;
    for (let value = first(visible.top); value <= visible.bottom + 1e-9; value += step) {
      const y = Math.round(projection.f + projection.d * value);
      canvas.fillRect(left - tick, y - Math.floor(fontScale / 2), tick, fontScale, tickColor);
      const text = String(value);
      canvas.drawText(
        text,
        left - tick - fontScale - pictureTextWidth(text, fontScale),
        Math.round(y - textHeight / 2),
        fontScale,
        labelColor,
      );
    }
    return step;
  }
  const outward = (dx: number, dy: number) => {
    const length = Math.hypot(dx, dy);
    return { x: -dx / length, y: -dy / length };
  };
  const awayFromY = outward(projection.b, projection.d);
  const awayFromX = outward(projection.a, projection.c);
  const label = (value: number, mapX: number, mapY: number, away: { x: number; y: number }) => {
    const point = pictureScreenPoint(projection, mapX, mapY);
    canvas.strokeSegment(
      point.x,
      point.y,
      point.x + away.x * tick,
      point.y + away.y * tick,
      fontScale,
      tickColor,
    );
    const text = String(value);
    const width = pictureTextWidth(text, fontScale);
    const reach = tick + fontScale + Math.hypot(width, textHeight) / 2;
    canvas.drawText(
      text,
      Math.round(point.x + away.x * reach - width / 2),
      Math.round(point.y + away.y * reach - textHeight / 2),
      fontScale,
      labelColor,
      outlineColor,
    );
  };
  for (let value = first(visible.left); value <= visible.right + 1e-9; value += step) {
    label(value, value, visible.top, awayFromY);
  }
  for (let value = first(visible.top); value <= visible.bottom + 1e-9; value += step) {
    label(value, visible.left, value, awayFromX);
  }
  return step;
}

export interface PicturePixels {
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
  pixelsPerTile: number;
  description: string;
  cells: PictureCellLayout[];
}

function resolveCells(request: PictureRequest): ResolvedCell[] {
  return request.cells.map((cell) => {
    const map = request.maps[cell.map]!;
    const perspective = cell.perspective ?? request.perspective;
    const raised = request.relief === 'raised' && perspective === 'diamond';
    const levels = raised ? Math.max(0, raisedSurfaceFor(map).maximum) : 0;
    return {
      ...cell,
      look: cell.look ?? request.look,
      perspective,
      raised,
      box: pictureRegionUnitBox(cell.region, map, perspective, levels),
    };
  });
}

function cellContentOrigin(layout: Layout, index: number): { x: number; y: number } {
  const slot = layout.slots[index]!;
  return {
    x: slot.x + layout.margins.left,
    y: slot.y + layout.margins.caption + layout.margins.top,
  };
}

export interface PictureTextureNeed {
  map: number;
  left: number;
  top: number;
  columns: number;
  rows: number;
  texelsPerTile: number;
}

export function pictureTextureNeeds(request: PictureRequest): PictureTextureNeed[] {
  const cells = resolveCells(request);
  if (!cells.some((cell) => cell.look === 'terrain-textures')) return [];
  const layout = computeLayout(request, cells);
  const boxes = new Map<number, Box>();
  cells.forEach((cell, index) => {
    if (cell.look !== 'terrain-textures') return;
    const map = request.maps[cell.map]!;
    const origin = cellContentOrigin(layout, index);
    const projection = cellProjection(cell, layout.k, origin.x, origin.y, layout);
    const visible = visibleTiles(
      projection,
      map,
      origin.x,
      origin.y,
      layout.contentWidth,
      layout.contentHeight,
    );
    const reach = 1 + (cell.raised ? Math.max(0, raisedSurfaceFor(map).maximum) : 0);
    const grown: Box = {
      left: Math.max(0, Math.floor(visible.left - reach)),
      top: Math.max(0, Math.floor(visible.top - reach)),
      right: Math.min(map.width, Math.ceil(visible.right + reach)),
      bottom: Math.min(map.height, Math.ceil(visible.bottom + reach)),
    };
    const known = boxes.get(cell.map);
    boxes.set(
      cell.map,
      known
        ? {
            left: Math.min(known.left, grown.left),
            top: Math.min(known.top, grown.top),
            right: Math.max(known.right, grown.right),
            bottom: Math.max(known.bottom, grown.bottom),
          }
        : grown,
    );
  });
  const perMap = Math.min(
    pictureContract.maximumTextureTexels,
    Math.floor(pictureContract.maximumRequestTextureTexels / boxes.size),
  );
  const wanted = Math.min(pictureContract.maximumTexelsPerTile, Math.max(1, Math.ceil(layout.k)));
  return [...boxes.entries()]
    .sort(([left], [right]) => left - right)
    .map(([mapIndex, box]) => {
      const map = request.maps[mapIndex]!;
      const left = Math.min(map.width - 1, box.left);
      const top = Math.min(map.height - 1, box.top);
      const columns = Math.max(1, box.right - left);
      const rows = Math.max(1, box.bottom - top);
      let texelsPerTile = wanted;
      while (texelsPerTile > 1 && columns * rows * texelsPerTile ** 2 > perMap) texelsPerTile -= 1;
      return { map: mapIndex, left, top, columns, rows, texelsPerTile };
    });
}

export function renderPicturePixels(request: PictureRequest, signal?: AbortSignal): PicturePixels {
  const cells = resolveCells(request);
  const layout = computeLayout(request, cells);
  const canvas = new PictureCanvas(layout.width, layout.height, background, signal);
  const cache = new RenderCache();
  const layouts: PictureCellLayout[] = [];
  let tickStep: number | null = null;
  cells.forEach((cell, index) => {
    canvas.checkCancelled();
    const map = request.maps[cell.map]!;
    const slot = layout.slots[index]!;
    const { x: contentX, y: contentY } = cellContentOrigin(layout, index);
    const projection = cellProjection(cell, layout.k, contentX, contentY, layout);
    const surface = cell.raised ? raisedSurfaceFor(map) : null;
    const unit = Math.min(
      2,
      Math.max(0.5, Math.max(layout.contentWidth, layout.contentHeight) / 512),
    );
    canvas.setClip({
      left: contentX,
      top: contentY,
      right: contentX + layout.contentWidth,
      bottom: contentY + layout.contentHeight,
    });
    const flatRelief = request.relief !== 'off' && !cell.raised;
    const texture =
      cell.look === 'terrain-textures' ? (request.terrainTextures?.[cell.map] ?? null) : null;
    drawTerrain(
      canvas,
      map,
      cache.terrain(map, cell.map, cell.look, flatRelief),
      projection,
      surface,
      texture ? { texture, overlay: flatRelief ? cache.reliefOverlay(map, cell.map) : null } : null,
    );
    const colourLook = pictureColourLook(cell.look);
    drawCliffs(canvas, map, colourLook, projection, surface);
    if (request.objects === 'markers')
      drawMarkerObjects(canvas, map, colourLook, projection, surface);
    if (request.objects === 'minimap') {
      const whole = pictureRegionUnitBox({ kind: 'whole' }, map, cell.perspective);
      const wholeMapK = Math.min(
        layout.contentWidth / (whole.right - whole.left),
        layout.contentHeight / (whole.bottom - whole.top),
      );
      drawMinimapObjects(canvas, map, projection, surface, unit, wholeMapK);
    }
    drawLines(canvas, request, map, cell.map, projection, surface, layout.fontScale);
    if (request.overlays?.players) drawPlayers(canvas, map, projection, surface, layout.fontScale);
    drawMarks(canvas, request, cell.map, projection, surface, layout.fontScale);
    canvas.setClip(null);
    if (request.overlays?.grid) {
      tickStep = drawGrid(canvas, map, projection, contentX, contentY, layout);
    }
    if (cell.caption) {
      canvas.drawText(cell.caption, contentX, slot.y, layout.fontScale, labelColor);
    }
    const round = (value: number) => Math.round(value * 100) / 100;
    layouts.push({
      map: cell.map,
      x: round(projection.e + cell.box.left * layout.k),
      y: round(projection.f + cell.box.top * layout.k),
      width: round((cell.box.right - cell.box.left) * layout.k),
      height: round((cell.box.bottom - cell.box.top) * layout.k),
    });
  });
  return {
    pixels: canvas.pixels,
    width: layout.width,
    height: layout.height,
    pixelsPerTile: Math.round(layout.k * 100) / 100,
    description: describePicture(request, cells, layout, tickStep),
    cells: layouts,
  };
}

const lookNames: Readonly<Record<PictureLook, string>> = Object.freeze({
  minimap: 'Minimap colors',
  'texture-colors': 'Texture colors',
  'terrain-textures': 'Preview terrain textures',
});

const perspectiveWords: Readonly<Record<PicturePerspective, string>> = Object.freeze({
  grid: 'square grid, x grows right, y grows down, tile 0,0 top left',
  top_down:
    "the preview's Top-down view, the map turned 45 degrees, tile 0,0 at the left corner, x grows up-right, y grows down-right",
  diamond:
    "the preview's Diamond view, the turned map flattened like the in-game minimap, tile 0,0 at the left corner, x grows up-right, y grows down-right",
});

function describeRegion(cell: ResolvedCell, map: PictureMap): string {
  const region = cell.region;
  switch (region.kind) {
    case 'whole':
      return `whole map ${map.width}x${map.height}`;
    case 'tiles':
      return `tiles x ${region.x}-${region.x + region.w - 1}, y ${region.y}-${region.y + region.h - 1}`;
    case 'base':
      return `player ${region.player} base, ${region.radius} tiles around the start`;
    case 'camera':
      return 'the preview framing';
  }
}

const maximumDescriptionLength = 600;

function describePicture(
  request: PictureRequest,
  cells: readonly ResolvedCell[],
  layout: Layout,
  tickStep: number | null,
): string {
  const parts: string[] = [];
  const looks = new Set(cells.map((cell) => cell.look));
  const perspectives = new Set(cells.map((cell) => cell.perspective));
  if (cells.length === 1) {
    parts.push(`${capitalize(describeRegion(cells[0]!, request.maps[cells[0]!.map]!))}.`);
  } else {
    const sideBySide = layout.columns === cells.length && cells.length === 2;
    parts.push(
      sideBySide
        ? 'Two pictures side by side at one scale'
        : `${cells.length} pictures in ${layout.columns} columns at one scale, in reading order`,
    );
    const each = cells.map((cell) => {
      const bits: string[] = [];
      if (cell.caption) bits.push(cell.caption.trim());
      bits.push(describeRegion(cell, request.maps[cell.map]!));
      if (looks.size > 1) bits.push(lookNames[cell.look]);
      if (perspectives.size > 1) bits.push(cell.perspective);
      return bits.join(' ');
    });
    parts[parts.length - 1] += `: ${each.join('; ')}.`;
  }
  if (looks.size === 1) parts.push(`${lookNames[cells[0]!.look]}.`);
  for (const perspective of perspectives)
    parts.push(`${capitalize(perspectiveWords[perspective])}.`);
  parts.push(
    perspectives.size === 1 && perspectives.has('grid')
      ? `${layout.k >= 1 ? layout.k : layout.k.toFixed(2)} px per tile.`
      : `About ${layout.k.toFixed(1)} px per tile edge.`,
  );
  if (tickStep !== null) parts.push(`Edge numbers: tile coordinates every ${tickStep} tiles.`);
  if (request.overlays?.players) parts.push('Rings: player starts with the player number.');
  if (request.objects === 'markers')
    parts.push('Objects as shapes, player objects in player colors.');
  if (request.objects === 'minimap') parts.push('Objects as minimap squares.');
  if (
    request.relief === 'shaded' ||
    (request.relief === 'raised' && !cells.some((cell) => cell.raised))
  ) {
    parts.push('Slopes shaded.');
  }
  if (cells.some((cell) => cell.raised)) parts.push('Terrain raised by its height.');
  if (request.overlays?.marks?.length) parts.push('Red crosses: errors; amber rings: warnings.');
  if (request.overlays?.lines?.length) parts.push('Lines join the points asked for.');
  const textured = cells.filter((cell) => cell.look === 'terrain-textures').length;
  if (textured === 0) parts.push('Colors are averaged, so blending cannot be judged.');
  else if (textured === cells.length) {
    parts.push('Terrain blending can be judged; cliffs and objects use Texture colors.');
  } else {
    parts.push(
      'Terrain blending can be judged only in the preview terrain textures; other colors are averaged.',
    );
  }
  let text = parts.join(' ');
  if (text.length > maximumDescriptionLength) {
    text = `${text.slice(0, maximumDescriptionLength - 3).trimEnd()}...`;
  }
  return text;
}

function capitalize(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

export function encodePicturePng(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8Array {
  const compressed = deflateSync(rgbaPngScanlines(pixels, width, height), deflateOptions);
  return assembleRgbaPng(width, height, compressed);
}

export function renderPicture(
  value: unknown,
  signal?: AbortSignal,
  maximumPngBytes: number = pictureContract.maximumPngBytes,
): PictureResult {
  const request = validatePictureRequest(value);
  let maxSide = request.maxSide;
  for (;;) {
    const pixels = renderPicturePixels({ ...request, maxSide }, signal);
    if (signal?.aborted) throw new PictureError('cancelled', 'the picture was cancelled');
    const png = encodePicturePng(pixels.pixels, pixels.width, pixels.height);
    if (png.byteLength <= Math.min(maximumPngBytes, pictureContract.maximumPngBytes)) {
      return {
        png,
        width: pixels.width,
        height: pixels.height,
        pixelsPerTile: pixels.pixelsPerTile,
        description: pixels.description,
        cells: pixels.cells,
      };
    }
    if (maxSide <= pictureContract.minimumSide) {
      throw new PictureError('too-large', 'the picture does not fit the PNG size limit');
    }
    maxSide = Math.max(pictureContract.minimumSide, Math.floor(maxSide * 0.75));
  }
}
