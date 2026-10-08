import type { GameArtSpriteGraphic } from '../shared/game-art';
import type { TopDownObject } from './top-down-preview';

export const wallObjectIds: ReadonlySet<number> = new Set([
  72, 117, 119, 155, 208, 231, 370, 788, 888, 889, 890, 1062, 1118, 1640, 1641, 1642, 1643, 1644,
  1645, 1654, 1693, 1694, 1695, 1696, 1700, 1758, 2068, 2416, 2421, 2425, 2426, 2427, 2428, 2433,
  2434, 2678, 2716, 2717, 2718,
]);

export const gateObjectIds: ReadonlySet<number> = new Set([
  63, 64, 67, 78, 80, 81, 85, 88, 90, 91, 92, 95, 487, 488, 490, 491, 659, 660, 661, 662, 663, 664,
  665, 666, 667, 668, 669, 670, 671, 672, 673, 674, 789, 790, 791, 792, 793, 794, 795, 796, 797,
  798, 799, 800, 801, 802, 803, 804, 1192, 1379, 1380, 1381, 1382, 1383, 1384, 1385, 1386, 1387,
  1388, 1389, 1390, 1391, 1392, 1393, 1394, 1579, 1580, 1581, 1582, 1583, 1584, 1585, 1586, 1587,
  1588, 1589, 1590, 1591, 1592, 1593, 1594, 2679, 2680, 2681, 2682, 2683, 2684, 2685, 2686, 2687,
  2688, 2689, 2690, 2691, 2692, 2693, 2694,
]);

export const wallFrames = {
  alongX: 0,
  alongY: 1,
  post: 2,
  diagonalDown: 3,
  diagonalUp: 4,
} as const;

export const wallFrameCount = 5;

export const wallConnection = {
  east: 1,
  south: 2,
  west: 4,
  north: 8,
  southEast: 16,
  southWest: 32,
  northWest: 64,
  northEast: 128,
} as const;

const neighbors: readonly { dx: number; dy: number; bit: number }[] = [
  { dx: 1, dy: 0, bit: wallConnection.east },
  { dx: 0, dy: 1, bit: wallConnection.south },
  { dx: -1, dy: 0, bit: wallConnection.west },
  { dx: 0, dy: -1, bit: wallConnection.north },
  { dx: 1, dy: 1, bit: wallConnection.southEast },
  { dx: -1, dy: 1, bit: wallConnection.southWest },
  { dx: -1, dy: -1, bit: wallConnection.northWest },
  { dx: 1, dy: -1, bit: wallConnection.northEast },
];

export function wallFrame(connections: number): number {
  switch (connections) {
    case wallConnection.east | wallConnection.west:
      return wallFrames.alongX;
    case wallConnection.north | wallConnection.south:
      return wallFrames.alongY;
    case wallConnection.southEast | wallConnection.northWest:
      return wallFrames.diagonalDown;
    case wallConnection.northEast | wallConnection.southWest:
      return wallFrames.diagonalUp;
    default:
      return wallFrames.post;
  }
}

const keySpan = 4096;

function tileKey(owner: number, x: number, y: number): number {
  return ((owner & 0xff) * keySpan + (y + 1)) * keySpan + (x + 1);
}

function coveredTiles(
  object: Pick<TopDownObject, 'x' | 'y' | 'footprintWidth' | 'footprintHeight'>,
): { x: number; y: number }[] {
  const halfWidth = Math.max(object.footprintWidth, 1) / 2;
  const halfHeight = Math.max(object.footprintHeight, 1) / 2;
  const minimumX = Math.round(object.x - halfWidth);
  const maximumX = Math.max(minimumX, Math.round(object.x + halfWidth) - 1);
  const minimumY = Math.round(object.y - halfHeight);
  const maximumY = Math.max(minimumY, Math.round(object.y + halfHeight) - 1);
  const tiles: { x: number; y: number }[] = [];
  for (let y = minimumY; y <= maximumY; y += 1) {
    for (let x = minimumX; x <= maximumX; x += 1) tiles.push({ x, y });
  }
  return tiles;
}

export function wallConnections(
  objects: readonly TopDownObject[],
  drawn: (object: TopDownObject) => boolean,
): Map<number, number> {
  const occupied = new Set<number>();
  const pieces: TopDownObject[] = [];
  for (const object of objects) {
    if (object.appearance || !drawn(object)) continue;
    const wall = wallObjectIds.has(object.objectId);
    if (!wall && !gateObjectIds.has(object.objectId)) continue;
    if (wall) pieces.push(object);
    const tiles = wall
      ? [{ x: Math.floor(object.x), y: Math.floor(object.y) }]
      : coveredTiles(object);
    for (const tile of tiles) {
      if (tile.x < 0 || tile.y < 0 || tile.x >= keySpan - 2 || tile.y >= keySpan - 2) continue;
      occupied.add(tileKey(object.owner, tile.x, tile.y));
    }
  }
  const connections = new Map<number, number>();
  for (const piece of pieces) {
    const x = Math.floor(piece.x);
    const y = Math.floor(piece.y);
    const at = (dx: number, dy: number) => occupied.has(tileKey(piece.owner, x + dx, y + dy));
    let bits = 0;
    for (const { dx, dy, bit } of neighbors) {
      if (!at(dx, dy)) continue;
      if (dx !== 0 && dy !== 0 && (at(dx, 0) || at(0, dy))) continue;
      bits |= bit;
    }
    connections.set(piece.index, bits);
  }
  return connections;
}

export function wallFramesFor(
  objects: readonly TopDownObject[],
  drawn: (object: TopDownObject) => boolean,
): Map<number, number> {
  const frames = new Map<number, number>();
  for (const [index, bits] of wallConnections(objects, drawn)) frames.set(index, wallFrame(bits));
  return frames;
}

function convertedFrame(image: string): number | null {
  const match = /-(\d{1,4})\.png$/u.exec(image);
  return match ? Number(match[1]) : null;
}

export function wallFacingIndex(
  graphic: Pick<GameArtSpriteGraphic, 'facings'>,
  frame: number,
): number | null {
  const index = graphic.facings.findIndex((facing) => convertedFrame(facing.image) === frame);
  if (index >= 0) return index;
  const named = graphic.facings.some((facing) => convertedFrame(facing.image) !== null);
  return !named && graphic.facings.length === wallFrameCount ? frame : null;
}

export function hasWallFrames(graphic: Pick<GameArtSpriteGraphic, 'facings'> | undefined): boolean {
  if (!graphic) return false;
  for (let frame = 0; frame < wallFrameCount; frame += 1) {
    if (wallFacingIndex(graphic, frame) === null) return false;
  }
  return true;
}

export function isGateObject(objectId: number): boolean {
  return gateObjectIds.has(objectId);
}
