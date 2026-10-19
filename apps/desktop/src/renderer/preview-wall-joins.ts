import { previewObjectCategory, type PreviewCategoryObject } from './preview-object-category';
import type { TopDownObject } from './top-down-preview';

export const gateObjectClass = 39;

export const wallJoin = Object.freeze({
  east: 1,
  south: 2,
  west: 4,
  north: 8,
  southEast: 16,
  southWest: 32,
  northWest: 64,
  northEast: 128,
});

export const wallJoinDirections: readonly { dx: number; dy: number; bit: number }[] = [
  { dx: 1, dy: 0, bit: wallJoin.east },
  { dx: 0, dy: 1, bit: wallJoin.south },
  { dx: -1, dy: 0, bit: wallJoin.west },
  { dx: 0, dy: -1, bit: wallJoin.north },
  { dx: 1, dy: 1, bit: wallJoin.southEast },
  { dx: -1, dy: 1, bit: wallJoin.southWest },
  { dx: -1, dy: -1, bit: wallJoin.northWest },
  { dx: 1, dy: -1, bit: wallJoin.northEast },
];

export type WallJoinObject = PreviewCategoryObject &
  Pick<TopDownObject, 'x' | 'y' | 'owner' | 'footprintWidth' | 'footprintHeight'> &
  Partial<Pick<TopDownObject, 'appearance'>>;

export function wallJoinRole(object: WallJoinObject): 'wall' | 'gate' | null {
  if (object.appearance) return null;
  if (previewObjectCategory(object) === 'wall') return 'wall';
  return object.objectClass === gateObjectClass ? 'gate' : null;
}

export function isStraightWallRun(bits: number): boolean {
  return (
    bits === (wallJoin.east | wallJoin.west) ||
    bits === (wallJoin.north | wallJoin.south) ||
    bits === (wallJoin.southEast | wallJoin.northWest) ||
    bits === (wallJoin.northEast | wallJoin.southWest)
  );
}

function coveredTiles(object: WallJoinObject): {
  minimumX: number;
  maximumX: number;
  minimumY: number;
  maximumY: number;
} {
  const width = Math.max(Number.isFinite(object.footprintWidth) ? object.footprintWidth : 1, 1);
  const height = Math.max(Number.isFinite(object.footprintHeight) ? object.footprintHeight : 1, 1);
  const minimumX = Math.round(object.x - width / 2);
  const minimumY = Math.round(object.y - height / 2);
  return {
    minimumX,
    maximumX: Math.max(minimumX, Math.round(object.x + width / 2) - 1),
    minimumY,
    maximumY: Math.max(minimumY, Math.round(object.y + height / 2) - 1),
  };
}

function ownerKey(owner: number): number {
  return owner > 0 ? owner & 0xff : 0;
}

export function wallJoins<T extends WallJoinObject>(
  objects: readonly T[],
  width: number,
  height: number,
  include: (object: T) => boolean = () => true,
  classOf?: (object: T) => number | undefined,
): Map<number, number> {
  const joins = new Map<number, number>();
  if (!(width > 0) || !(height > 0)) return joins;
  const tileCount = width * height;
  const occupied = new Set<number>();
  const pieces: number[] = [];
  for (let position = 0; position < objects.length; position += 1) {
    const object = objects[position]!;
    const objectClass = object.objectClass ?? classOf?.(object);
    const role = wallJoinRole(
      objectClass === object.objectClass ? object : { ...object, objectClass },
    );
    if (!role || !include(object)) continue;
    if (role === 'wall') pieces.push(position);
    const tiles = coveredTiles(object);
    const owner = ownerKey(object.owner) * tileCount;
    for (let y = Math.max(0, tiles.minimumY); y <= Math.min(height - 1, tiles.maximumY); y += 1) {
      for (let x = Math.max(0, tiles.minimumX); x <= Math.min(width - 1, tiles.maximumX); x += 1) {
        occupied.add(owner + y * width + x);
      }
    }
  }
  for (const position of pieces) {
    const piece = objects[position]!;
    const x = Math.floor(piece.x);
    const y = Math.floor(piece.y);
    if (x < 0 || y < 0 || x >= width || y >= height) {
      joins.set(position, 0);
      continue;
    }
    const own = coveredTiles(piece);
    const owner = ownerKey(piece.owner) * tileCount;
    const at = (dx: number, dy: number) => {
      const tileX = x + dx;
      const tileY = y + dy;
      if (tileX < 0 || tileY < 0 || tileX >= width || tileY >= height) return false;
      if (
        tileX >= own.minimumX &&
        tileX <= own.maximumX &&
        tileY >= own.minimumY &&
        tileY <= own.maximumY
      ) {
        return false;
      }
      return occupied.has(owner + tileY * width + tileX);
    };
    let bits = 0;
    for (const { dx, dy, bit } of wallJoinDirections) {
      if (!at(dx, dy)) continue;
      if (dx !== 0 && dy !== 0 && (at(dx, 0) || at(0, dy))) continue;
      bits |= bit;
    }
    joins.set(position, bits);
  }
  return joins;
}

export const previewWallStroke = Object.freeze({ tileFraction: 0.3, minimum: 2, maximum: 12 });

export function previewWallStrokeWidth(tileEdgePixels: number): number {
  const { tileFraction, minimum, maximum } = previewWallStroke;
  if (!Number.isFinite(tileEdgePixels) || tileEdgePixels <= 0) return minimum;
  return Math.min(Math.max(tileEdgePixels * tileFraction, minimum), maximum);
}

export const previewWallPost = Object.freeze({ post: 0.8, joint: 0.5, minimumTilePixels: 8 });

export function previewWallPostHalfWidth(
  bits: number,
  strokeWidth: number,
  tileEdgePixels: number,
): number {
  if (isStraightWallRun(bits)) return 0;
  const post =
    bits === 0 || tileEdgePixels >= previewWallPost.minimumTilePixels
      ? previewWallPost.post
      : previewWallPost.joint;
  return strokeWidth * post;
}

export function wallPostPolygon(
  centerX: number,
  centerY: number,
  halfWidth: number,
  component: number,
  verticalComponent: number,
): number[] {
  const edge = (2 * component * verticalComponent) / Math.hypot(component, verticalComponent) || 1;
  const half = halfWidth / edge;
  const points: number[] = [];
  for (const [signX, signY] of postCorners) {
    const deltaX = signX * half;
    const deltaY = signY * half;
    points.push(
      centerX + (deltaX + deltaY) * component,
      centerY + (deltaY - deltaX) * verticalComponent,
    );
  }
  return points;
}

const postCorners: readonly (readonly [number, number])[] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

const sceneJoinCache = new WeakMap<
  readonly TopDownObject[],
  {
    width: number;
    height: number;
    key: readonly unknown[];
    joins: Map<number, number>;
  }
>();

export function sceneWallJoins(
  scene: { width: number; height: number; objects: readonly TopDownObject[] },
  include: (object: TopDownObject) => boolean,
  key: readonly unknown[],
): Map<number, number> {
  const cached = sceneJoinCache.get(scene.objects);
  if (
    cached &&
    cached.width === scene.width &&
    cached.height === scene.height &&
    sameKey(cached.key, key)
  ) {
    return cached.joins;
  }
  const joins = wallJoins(scene.objects, scene.width, scene.height, include);
  sceneJoinCache.set(scene.objects, {
    width: scene.width,
    height: scene.height,
    key: [...key],
    joins,
  });
  return joins;
}

function sameKey(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
