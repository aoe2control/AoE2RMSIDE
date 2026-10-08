import {
  mapIconSheetMaximumEdge,
  mapIconSpriteMaximumScale,
  mapIconVioletSafeKey,
  processMapIconSpriteSheet,
  type MapIconProcessedSheet,
  type MapIconSheetPixels,
  type MapIconSpriteCell,
} from './map-icon-art';
import { ownerPlayerColorIndex, playerColorCount } from './preview-materials';

export const mapIconPlayerSquaresSheetLayout = Object.freeze({ columns: 8, rows: 2, row: 1 });

export const mapIconNomadFeetSheetLayout = Object.freeze({ columns: 4, rows: 2 });

export const mapIconPlayerMarkerColors = Object.freeze([
  'blue',
  'red',
  'green',
  'yellow',
  'cyan',
  'purple',
  'grey',
  'orange',
] as const);

export const mapIconSpawnMarkerVisibleAlpha = 128;

const markerAnchors = new WeakMap<MapIconSpriteCell, Readonly<{ x: number; y: number }>>();

export function mapIconSpawnMarkerAnchor(
  cell: MapIconSpriteCell,
): Readonly<{ x: number; y: number }> {
  const cached = markerAnchors.get(cell);
  if (cached) return cached;
  let minimumX = cell.width;
  let minimumY = cell.height;
  let maximumX = -1;
  let maximumY = -1;
  for (let y = 0; y < cell.height; y += 1) {
    for (let x = 0; x < cell.width; x += 1) {
      if (cell.rgba[(y * cell.width + x) * 4 + 3]! < mapIconSpawnMarkerVisibleAlpha) continue;
      if (x < minimumX) minimumX = x;
      if (x > maximumX) maximumX = x;
      if (y < minimumY) minimumY = y;
      if (y > maximumY) maximumY = y;
    }
  }
  const anchor = Object.freeze(
    maximumX < 0
      ? { x: 0.5, y: 0.5 }
      : {
          x: (minimumX + maximumX + 1) / 2 / cell.width,
          y: (minimumY + maximumY + 1) / 2 / cell.height,
        },
  );
  markerAnchors.set(cell, anchor);
  return anchor;
}

export function processMapIconPlayerSquaresSheet(sheet: MapIconSheetPixels): MapIconProcessedSheet {
  const { columns, rows, row } = mapIconPlayerSquaresSheetLayout;
  const { width, height, rgba } = sheet;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < columns ||
    height < rows ||
    width % columns !== 0 ||
    height % rows !== 0 ||
    width > mapIconSheetMaximumEdge ||
    height > mapIconSheetMaximumEdge ||
    rgba.length !== width * height * 4
  ) {
    throw new Error('map icon player squares sheet is invalid');
  }
  const cellWidth = width / columns;
  const cellHeight = height / rows;
  const top = row * cellHeight;
  const cells: MapIconSpriteCell[] = [];
  for (let column = 0; column < columns; column += 1) {
    const left = column * cellWidth;
    let minimumX = cellWidth;
    let minimumY = cellHeight;
    let maximumX = -1;
    let maximumY = -1;
    for (let y = 0; y < cellHeight; y += 1) {
      for (let x = 0; x < cellWidth; x += 1) {
        if (rgba[((top + y) * width + left + x) * 4 + 3]! === 0) continue;
        if (x < minimumX) minimumX = x;
        if (x > maximumX) maximumX = x;
        if (y < minimumY) minimumY = y;
        if (y > maximumY) maximumY = y;
      }
    }
    if (maximumX < 0) {
      cells.push({ width: 0, height: 0, rgba: new Uint8ClampedArray(0) });
      continue;
    }
    const cropWidth = maximumX - minimumX + 1;
    const cropHeight = maximumY - minimumY + 1;
    const pixels = new Uint8ClampedArray(cropWidth * cropHeight * 4);
    for (let y = 0; y < cropHeight; y += 1) {
      const source = ((top + minimumY + y) * width + left + minimumX) * 4;
      pixels.set(rgba.subarray(source, source + cropWidth * 4), y * cropWidth * 4);
    }
    cells.push({ width: cropWidth, height: cropHeight, rgba: pixels });
  }
  return { columns, rows: 1, cellPixels: cellHeight, cells };
}

export function processMapIconNomadFeetSheet(sheet: MapIconSheetPixels): MapIconProcessedSheet {
  return processMapIconSpriteSheet(sheet, mapIconNomadFeetSheetLayout, mapIconVioletSafeKey);
}

export function mapIconSpawnMarkerCell(owner: number, playerColorIds: readonly number[]): number {
  return ownerPlayerColorIndex(owner, playerColorIds);
}

export const mapIconPlayerMarkerCellCount = playerColorCount;

export function mapIconSpawnMarkerWidthPixels(
  projection: { component: number },
  mapWidth: number,
  sizePercent: number,
): number {
  return Math.max(4, Math.round(2 * (sizePercent / 100) * mapWidth * projection.component));
}

export function mapIconSpawnMarkerScale(cell: MapIconSpriteCell, widthPixels: number): number {
  if (cell.width === 0) return 1;
  return Math.min(mapIconSpriteMaximumScale, widthPixels / cell.width);
}
