import { mapIconArtSize, mapIconArtSizePercents } from '../shared/api';
import {
  mapIconSheetMaximumEdge,
  type MapIconSheetPixels,
  type MapIconSpriteCell,
} from './map-icon-art';
import type { MapPoint, TopDownObject } from './top-down-preview';

export type MapIconLandmarkKind = 'relic' | 'monument';

export interface MapIconLandmarkImages {
  relic: MapIconSpriteCell;
  monument: MapIconSpriteCell;
}

export const mapIconLandmarkAlphaLevels = Object.freeze({ floor: 8, ceiling: 248 });

export function mapIconLandmarkAlpha(alpha: number): number {
  const { floor, ceiling } = mapIconLandmarkAlphaLevels;
  if (alpha <= floor) return 0;
  if (alpha >= ceiling) return 255;
  return Math.round(((alpha - floor) * 255) / (ceiling - floor));
}

export function processMapIconLandmarkImage(image: MapIconSheetPixels): MapIconSpriteCell {
  const { width, height, rgba } = image;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > mapIconSheetMaximumEdge ||
    height > mapIconSheetMaximumEdge ||
    rgba.length !== width * height * 4
  ) {
    throw new Error('map icon landmark picture is invalid');
  }
  let minimumX = width;
  let minimumY = height;
  let maximumX = -1;
  let maximumY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (mapIconLandmarkAlpha(rgba[(y * width + x) * 4 + 3]!) === 0) continue;
      if (x < minimumX) minimumX = x;
      if (x > maximumX) maximumX = x;
      if (y < minimumY) minimumY = y;
      if (y > maximumY) maximumY = y;
    }
  }
  if (maximumX < 0) throw new Error('map icon landmark picture is empty');
  const cropWidth = maximumX - minimumX + 1;
  const cropHeight = maximumY - minimumY + 1;
  const pixels = new Uint8ClampedArray(cropWidth * cropHeight * 4);
  for (let y = 0; y < cropHeight; y += 1) {
    for (let x = 0; x < cropWidth; x += 1) {
      const source = ((minimumY + y) * width + minimumX + x) * 4;
      const alpha = mapIconLandmarkAlpha(rgba[source + 3]!);
      if (alpha === 0) continue;
      const target = (y * cropWidth + x) * 4;
      pixels[target] = rgba[source]!;
      pixels[target + 1] = rgba[source + 1]!;
      pixels[target + 2] = rgba[source + 2]!;
      pixels[target + 3] = alpha;
    }
  }
  return { width: cropWidth, height: cropHeight, rgba: pixels };
}

export const mapIconLandmarkAnchors = Object.freeze({
  relic: Object.freeze({ x: 0.5, y: 0.9 }),
  monument: Object.freeze({ x: 0.5, y: 0.86 }),
});

export const mapIconLandmarkHeightPixels = Object.freeze({
  relic: Object.freeze({ perTile: 4.5, minimum: 16, maximum: 28 }),
  monument: Object.freeze({ perTile: 5.6, minimum: 20, maximum: 35 }),
});

export function mapIconLandmarkHeight(
  kind: MapIconLandmarkKind,
  projection: { component: number; pixelScale?: number },
  size: number = mapIconArtSize.default,
): number {
  if (!Number.isInteger(size) || size < mapIconArtSize.minimum || size > mapIconArtSize.maximum) {
    throw new Error('map icon landmark size is invalid');
  }
  const pixelScale = projection.pixelScale ?? 1;
  const bounds = mapIconLandmarkHeightPixels[kind];
  const deployedPixelsPerTile = (2 * projection.component) / pixelScale;
  const height =
    Math.min(
      bounds.maximum,
      Math.max(bounds.minimum, Math.round(bounds.perTile * deployedPixelsPerTile)),
    ) * pixelScale;
  return Math.max(4, Math.round((height * mapIconArtSizePercents[size]!) / 100));
}

export const mapIconRelicObjectClass = 42;
export const mapIconRelicObjectId = 285;

export function isMapIconRelic(object: Pick<TopDownObject, 'objectId' | 'objectClass'>): boolean {
  return object.objectClass === undefined
    ? object.objectId === mapIconRelicObjectId
    : object.objectClass === mapIconRelicObjectClass;
}

export function mapIconKingOfTheHillCentre(mapWidth: number, mapHeight: number): MapPoint {
  const centre = (size: number) => Math.floor(size / 2) + (size % 2) + 0.5;
  return { x: centre(mapWidth), y: centre(mapHeight) };
}

export interface MapIconLandmarkPlacement extends MapPoint {
  kind: MapIconLandmarkKind;
}

export function mapIconLandmarkPlacements(
  scene: { width: number; height: number; objects: readonly TopDownObject[] },
  kingOfTheHill: boolean,
): MapIconLandmarkPlacement[] {
  const placements: MapIconLandmarkPlacement[] = [];
  for (const object of scene.objects) {
    if (object.appearance === undefined && isMapIconRelic(object)) {
      placements.push({ kind: 'relic', x: object.x, y: object.y });
    }
  }
  if (kingOfTheHill) {
    placements.push({ kind: 'monument', ...mapIconKingOfTheHillCentre(scene.width, scene.height) });
  }
  return placements;
}
