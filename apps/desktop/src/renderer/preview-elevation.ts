export const raisedLightRange = Object.freeze({ minimum: 0.45, maximum: 1.6 });

export const raisedLightWeights = Object.freeze({ x: 0.2, y: 0.28 });

export const raisedLightStrength = Object.freeze({ colorLooks: 1, gameTextures: 0.5 });

const topBottomFolds = new Set([1, 2, 11, 12, 13, 14]);

export const raisedCornerFractions: readonly (readonly [number, number])[] = Object.freeze([
  Object.freeze([0, 0] as const),
  Object.freeze([1, 0] as const),
  Object.freeze([1, 1] as const),
  Object.freeze([0, 1] as const),
]);

export const raisedElevationLimit = 4096;

function saturatingI16(value: number): number {
  return value > 32_767 ? 32_767 : value < -32_768 ? -32_768 : value;
}

export function terrainShapeCode(
  index: number,
  elevation: ArrayLike<number>,
  width: number,
  height: number,
): number {
  const x = index % width;
  return terrainShapeCodeAt(elevation, width, height, x, (index - x) / width);
}

export function terrainShapeCodeAt(
  elevation: ArrayLike<number>,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  const index = y * width + x;
  const center = elevation[index] ?? 0;
  const hasNorth = y > 0;
  const hasSouth = y + 1 < height;
  const hasWest = x > 0;
  const hasEast = x + 1 < width;
  const higher = saturatingI16(center + 1);
  const north = hasNorth ? (elevation[index - width] ?? center) : center;
  const east = hasEast ? (elevation[index + 1] ?? center) : center;
  const south = hasSouth ? (elevation[index + width] ?? center) : center;
  const west = hasWest ? (elevation[index - 1] ?? center) : center;
  if (north === higher && east === higher) return 14;
  if (west === higher && south === higher) return 13;
  if (north === higher && west === higher) return 16;
  if (east === higher && south === higher) return 15;
  if (north === higher) return 6;
  if (east === higher) return 8;
  if (west === higher) return 5;
  if (south === higher) return 7;
  const lower = saturatingI16(center - 1);
  const northEast = hasNorth && hasEast ? (elevation[index - width + 1] ?? center) : center;
  if (northEast === higher) return west === lower && south === lower ? 2 : 10;
  const southWest = hasSouth && hasWest ? (elevation[index + width - 1] ?? center) : center;
  if (southWest === higher) return north === lower && east === lower ? 1 : 9;
  const northWest = hasNorth && hasWest ? (elevation[index - width - 1] ?? center) : center;
  if (northWest === higher) return east === lower && south === lower ? 3 : 11;
  const southEast = hasSouth && hasEast ? (elevation[index + width + 1] ?? center) : center;
  if (southEast === higher) return north === lower && west === lower ? 4 : 12;
  return 0;
}

export function terrainShapeHeightOffset(shape: number, x: number, y: number): number {
  const inverseX = 1 - x;
  const inverseY = 1 - y;
  switch (shape) {
    case 1:
      return Math.min(y, inverseX);
    case 2:
      return Math.min(x, inverseY);
    case 3:
      return 1 - Math.max(x, y);
    case 4:
      return Math.min(x, y);
    case 5:
      return inverseX;
    case 6:
      return inverseY;
    case 7:
      return y;
    case 8:
      return x;
    case 9:
      return Math.max(y - x, 0);
    case 10:
      return Math.max(x - y, 0);
    case 11:
      return Math.max(1 - x - y, 0);
    case 12:
      return Math.max(x + y - 1, 0);
    case 13:
      return Math.max(y, inverseX);
    case 14:
      return Math.max(x, inverseY);
    case 15:
      return Math.max(x, y);
    case 16:
      return 1 - Math.min(x, y);
    default:
      return 0;
  }
}

export function terrainSurfaceHeight(
  x: number,
  y: number,
  width: number,
  height: number,
  elevation: ArrayLike<number>,
): number {
  let px = Math.max(0, x);
  let py = Math.max(0, y);
  if (px >= width) px = width - 0.001;
  if (py >= height) py = height - 0.001;
  const tileX = Math.trunc(px);
  const tileY = Math.trunc(py);
  const index = tileY * width + tileX;
  return (
    (elevation[index] ?? 0) +
    terrainShapeHeightOffset(
      terrainShapeCode(index, elevation, width, height),
      px - tileX,
      py - tileY,
    )
  );
}

const shapeCornerOffsets = Int8Array.from({ length: 17 * 4 }, (_, slot) => {
  const [fx, fy] = raisedCornerFractions[slot % 4]!;
  return terrainShapeHeightOffset(Math.floor(slot / 4), fx, fy);
});

export function raisedShapeLight(shape: number, strength: number): number {
  const base = shape * 4;
  return raisedTileLight(
    shapeCornerOffsets[base] ?? 0,
    shapeCornerOffsets[base + 1] ?? 0,
    shapeCornerOffsets[base + 2] ?? 0,
    shapeCornerOffsets[base + 3] ?? 0,
    strength,
  );
}

export function terrainShapeFoldsTopBottom(shape: number): boolean {
  return topBottomFolds.has(shape);
}

export function raisedLight(gx: number, gy: number, strength: number): number {
  const light = 1 - strength * (raisedLightWeights.x * gx + raisedLightWeights.y * gy);
  return Math.min(raisedLightRange.maximum, Math.max(raisedLightRange.minimum, light));
}

export function raisedTileLight(
  left: number,
  top: number,
  right: number,
  bottom: number,
  strength: number,
): number {
  return raisedLight(
    (top + right - left - bottom) / 2,
    (right + bottom - left - top) / 2,
    strength,
  );
}

export function litColor(color: number, light: number): number {
  if (light === 1) return color;
  const channel = (shift: number) => Math.min(255, Math.round(((color >> shift) & 0xff) * light));
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

export type RaisedWallFacing = 'left' | 'right';

export function raisedWallLight(facing: RaisedWallFacing, strength: number): number {
  return facing === 'left' ? raisedLight(1, 0, strength) : raisedLight(0, -1, strength);
}

export interface RaisedSurfaceHit {
  x: number;
  y: number;
  tileX: number;
  tileY: number;
  height: number;
  wall: RaisedWallFacing | null;
  resumable: boolean;
}

const visibilityTolerance = 1e-6;

const edgeContactTolerance = 1e-9;

export class ElevationSurface {
  readonly elevation: Int32Array;
  readonly shapes: Uint8Array;
  readonly corners: Int32Array;
  readonly minimum: number;
  readonly maximum: number;
  readonly hasSteps: boolean;
  readonly wallCount: number;
  private readonly hit: RaisedSurfaceHit = {
    x: 0,
    y: 0,
    tileX: 0,
    tileY: 0,
    height: 0,
    wall: null,
    resumable: false,
  };
  private readonly cornerLights = new Map<number, Float32Array>();

  constructor(
    readonly width: number,
    readonly height: number,
    elevations: ArrayLike<number>,
  ) {
    const count = width * height;
    const elevation = new Int32Array(count);
    for (let index = 0; index < count; index += 1) {
      const value = Math.trunc(+(elevations[index] ?? 0)) || 0;
      elevation[index] =
        value > raisedElevationLimit
          ? raisedElevationLimit
          : value < -raisedElevationLimit
            ? -raisedElevationLimit
            : value;
    }
    this.elevation = elevation;
    const shapes = new Uint8Array(count);
    const corners = new Int32Array(count * 4);
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    for (let y = 0; y < height; y += 1) {
      const interiorRow = y > 0 && y < height - 1;
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        const center = elevation[index]!;
        let shape: number;
        if (interiorRow && x > 0 && x < width - 1) {
          const higher = center + 1;
          const lower = center - 1;
          const north = elevation[index - width]!;
          const east = elevation[index + 1]!;
          const south = elevation[index + width]!;
          const west = elevation[index - 1]!;
          if (north === higher && east === higher) shape = 14;
          else if (west === higher && south === higher) shape = 13;
          else if (north === higher && west === higher) shape = 16;
          else if (east === higher && south === higher) shape = 15;
          else if (north === higher) shape = 6;
          else if (east === higher) shape = 8;
          else if (west === higher) shape = 5;
          else if (south === higher) shape = 7;
          else if (elevation[index - width + 1] === higher) {
            shape = west === lower && south === lower ? 2 : 10;
          } else if (elevation[index + width - 1] === higher) {
            shape = north === lower && east === lower ? 1 : 9;
          } else if (elevation[index - width - 1] === higher) {
            shape = east === lower && south === lower ? 3 : 11;
          } else if (elevation[index + width + 1] === higher) {
            shape = north === lower && west === lower ? 4 : 12;
          } else shape = 0;
        } else {
          shape = terrainShapeCode(index, elevation, width, height);
        }
        shapes[index] = shape;
        const base = index * 4;
        const offsets = shape * 4;
        for (let corner = 0; corner < 4; corner += 1) {
          const value = center + shapeCornerOffsets[offsets + corner]!;
          corners[base + corner] = value;
          if (value < minimum) minimum = value;
          if (value > maximum) maximum = value;
        }
      }
    }
    this.shapes = shapes;
    this.corners = corners;
    this.minimum = Number.isFinite(minimum) ? minimum : 0;
    this.maximum = Number.isFinite(maximum) ? maximum : 0;
    let steps = false;
    let walls = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        const base = index * 4;
        if (x + 1 < width) {
          const next = base + 4;
          if (corners[base + 1] !== corners[next] || corners[base + 2] !== corners[next + 3]) {
            steps = true;
          }
        }
        if (x > 0) {
          const neighbour = base - 4;
          if (
            corners[base]! > corners[neighbour + 1]! ||
            corners[base + 3]! > corners[neighbour + 2]!
          ) {
            walls += 1;
          }
        }
        if (y + 1 < height) {
          const below = base + width * 4;
          if (corners[base + 3] !== corners[below] || corners[base + 2] !== corners[below + 1]) {
            steps = true;
          }
          if (corners[base + 3]! > corners[below]! || corners[base + 2]! > corners[below + 1]!) {
            walls += 1;
          }
        }
      }
    }
    this.hasSteps = steps;
    this.wallCount = walls;
  }

  corner(index: number, corner: number): number {
    return this.corners[index * 4 + corner]!;
  }

  flat(index: number): boolean {
    const base = index * 4;
    const h = this.corners[base]!;
    return (
      this.corners[base + 1] === h && this.corners[base + 2] === h && this.corners[base + 3] === h
    );
  }

  foldsTopBottom(index: number): boolean {
    return topBottomFolds.has(this.shapes[index]!);
  }

  heightAt(x: number, y: number): number {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
    let px = Math.max(0, x);
    let py = Math.max(0, y);
    if (px >= this.width) px = this.width - 0.001;
    if (py >= this.height) py = this.height - 0.001;
    const tileX = Math.trunc(px);
    const tileY = Math.trunc(py);
    const index = tileY * this.width + tileX;
    return (
      this.elevation[index]! + terrainShapeHeightOffset(this.shapes[index]!, px - tileX, py - tileY)
    );
  }

  frontWalls(x: number, y: number): number {
    const index = y * this.width + x;
    const base = index * 4;
    let walls = 0;
    if (x > 0) {
      const neighbour = base - 4;
      if (
        this.corners[base]! > this.corners[neighbour + 1]! ||
        this.corners[base + 3]! > this.corners[neighbour + 2]!
      ) {
        walls |= 1;
      }
    }
    if (y + 1 < this.height) {
      const neighbour = (index + this.width) * 4;
      if (
        this.corners[base + 3]! > this.corners[neighbour]! ||
        this.corners[base + 2]! > this.corners[neighbour + 1]!
      ) {
        walls |= 2;
      }
    }
    return walls;
  }

  cornerLight(strength: number): Float32Array {
    const cached = this.cornerLights.get(strength);
    if (cached) return cached;
    const { width, height } = this;
    const tile = new Float32Array(width * height);
    for (let index = 0; index < width * height; index += 1) {
      tile[index] = this.tileLight(index, strength);
    }
    const stride = width + 1;
    const light = new Float32Array(stride * (height + 1));
    for (let y = 0; y <= height; y += 1) {
      for (let x = 0; x <= width; x += 1) {
        let sum = 0;
        let count = 0;
        for (let ty = y - 1; ty <= y; ty += 1) {
          if (ty < 0 || ty >= height) continue;
          for (let tx = x - 1; tx <= x; tx += 1) {
            if (tx < 0 || tx >= width) continue;
            sum += tile[ty * width + tx]!;
            count += 1;
          }
        }
        light[y * stride + x] = count > 0 ? sum / count : 1;
      }
    }
    this.cornerLights.set(strength, light);
    return light;
  }

  smoothLightAt(x: number, y: number, strength: number): number {
    const light = this.cornerLight(strength);
    const stride = this.width + 1;
    const cx = Math.min(this.width, Math.max(0, x));
    const cy = Math.min(this.height, Math.max(0, y));
    const x0 = Math.min(this.width - 1, Math.floor(cx));
    const y0 = Math.min(this.height - 1, Math.floor(cy));
    const fx = cx - x0;
    const fy = cy - y0;
    const a = light[y0 * stride + x0]!;
    const b = light[y0 * stride + x0 + 1]!;
    const c = light[(y0 + 1) * stride + x0]!;
    const d = light[(y0 + 1) * stride + x0 + 1]!;
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }

  tileLight(index: number, strength: number): number {
    const base = index * 4;
    return raisedTileLight(
      this.corners[base]!,
      this.corners[base + 1]!,
      this.corners[base + 2]!,
      this.corners[base + 3]!,
      strength,
    );
  }

  private tileHeight(tileX: number, tileY: number, x: number, y: number): number {
    const index = tileY * this.width + tileX;
    return (
      this.elevation[index]! + terrainShapeHeightOffset(this.shapes[index]!, x - tileX, y - tileY)
    );
  }

  pickInto(
    s: number,
    t: number,
    fromX: number = Number.NEGATIVE_INFINITY,
  ): RaisedSurfaceHit | null {
    return this.pickWith(s, t, fromX, false, false);
  }

  pick(s: number, t: number, fromX?: number): RaisedSurfaceHit | null {
    const hit = this.pickInto(s, t, fromX);
    return hit ? { ...hit } : null;
  }

  pickPoint(x: number, y: number, h: number): RaisedSurfaceHit | null {
    return this.pickWith(
      x + y,
      y - x - h,
      Number.NEGATIVE_INFINITY,
      true,
      x <= 0 || y >= this.height,
    );
  }

  pointVisible(x: number, y: number, h: number): boolean {
    if (!this.hasSteps) return x >= 0 && y >= 0 && x <= this.width && y <= this.height;
    const hit = this.pickPoint(x, y, h);
    return (
      hit !== null &&
      Math.abs(hit.x - x) <= visibilityTolerance &&
      Math.abs(hit.y - y) <= visibilityTolerance
    );
  }

  private pickWith(
    s: number,
    t: number,
    fromX: number,
    exitContact: boolean,
    entryContact: boolean,
  ): RaisedSurfaceHit | null {
    if (!Number.isFinite(s) || !Number.isFinite(t)) return null;
    const first = Math.max(0, s - this.height);
    const last = Math.min(this.width, s);
    if (first === last && entryContact) return this.pickMapCorner(s, t, first);
    if (!(first < last)) return null;
    const above = (s - t - this.maximum) / 2;
    const below = (s - t - this.minimum) / 2;
    if (
      above > last + (exitContact ? edgeContactTolerance : 0) ||
      below < first - (entryContact ? edgeContactTolerance : 0)
    ) {
      return null;
    }
    const from = Math.max(first, Math.min(above, last), fromX);
    return this.pickScan(
      s,
      t,
      from,
      Math.min(last, Math.max(below, first)),
      exitContact,
      entryContact && from === first,
    );
  }

  private pickMapCorner(s: number, t: number, x: number): RaisedSurfaceHit | null {
    const tileX = x > 0 ? this.width - 1 : 0;
    const tileY = x > 0 ? this.height - 1 : 0;
    if (tileX < 0 || tileY < 0 || tileX >= this.width || tileY >= this.height) return null;
    const depth = this.depthOn(tileX, tileY, s, t, x);
    return Math.abs(depth) <= edgeContactTolerance
      ? this.found(tileX, tileY, x, s, t, null, true)
      : null;
  }

  private readonly segment = { tileX: 0, tileY: 0, start: 0, end: 0, valid: false };

  private lineSegment(s: number, k: number): void {
    const n = Math.floor(s);
    const f = s - n;
    const i = Math.floor(k / 2);
    const segment = this.segment;
    segment.tileX = i;
    if (k % 2 === 0) {
      segment.tileY = n - i;
      segment.start = i;
      segment.end = i + f;
    } else {
      segment.tileY = n - i - 1;
      segment.start = i + f;
      segment.end = i + 1;
    }
    segment.valid =
      segment.tileX >= 0 &&
      segment.tileY >= 0 &&
      segment.tileX < this.width &&
      segment.tileY < this.height;
  }

  private segmentIndex(s: number, x: number): number {
    const f = s - Math.floor(s);
    const i = Math.floor(x);
    return 2 * i + (x - i < f ? 0 : 1);
  }

  private depthOn(tileX: number, tileY: number, s: number, t: number, x: number): number {
    return this.tileHeight(tileX, tileY, x, s - x) + 2 * x - s + t;
  }

  private crossing(
    tileX: number,
    tileY: number,
    s: number,
    t: number,
    start: number,
    startDepth: number,
    end: number,
  ): number {
    let from = start;
    let previous = startDepth;
    if (!this.foldsTopBottom(tileY * this.width + tileX)) {
      const fold = (s - tileY + tileX) / 2;
      if (fold > start && fold < end) {
        const depth = this.depthOn(tileX, tileY, s, t, fold);
        if (depth >= 0) return interpolateRoot(from, previous, fold, depth);
        from = fold;
        previous = depth;
      }
    }
    const depth = this.depthOn(tileX, tileY, s, t, end);
    return depth >= 0 ? interpolateRoot(from, previous, end, depth) : Number.NaN;
  }

  private found(
    tileX: number,
    tileY: number,
    x: number,
    s: number,
    t: number,
    wall: RaisedWallFacing | null,
    resumable: boolean,
  ): RaisedSurfaceHit {
    const hit = this.hit;
    hit.tileX = tileX;
    hit.tileY = tileY;
    hit.height = wall ? s - 2 * x - t : this.tileHeight(tileX, tileY, x, s - x);
    hit.x = insideTile(x, tileX);
    hit.y = insideTile(s - x, tileY);
    hit.wall = wall;
    hit.resumable = resumable;
    return hit;
  }

  private pickScan(
    s: number,
    t: number,
    from: number,
    to: number,
    exitContact: boolean,
    entryContact: boolean,
  ): RaisedSurfaceHit | null {
    if (!(from <= to)) return null;
    const firstPiece = this.segmentIndex(s, from) - 1;
    const lastPiece = this.segmentIndex(s, to) + 1;
    const throughCorners = s === Math.floor(s);
    let previous = Number.NaN;
    let under = false;
    let entering = entryContact;
    let lastTileX = -1;
    let lastTileY = -1;
    let lastEnd = 0;
    let afterRightCorner = false;
    for (let k = firstPiece; k <= lastPiece; k += 1) {
      this.lineSegment(s, k);
      const { tileX, tileY, start, end, valid } = this.segment;
      if (!valid) {
        if (exitContact && lastTileX >= 0 && previous < 0 && previous >= -edgeContactTolerance) {
          return this.found(lastTileX, lastTileY, lastEnd, s, t, null, !under);
        }
        previous = Number.NaN;
        if (
          entering &&
          throughCorners &&
          k % 2 === 0 &&
          tileY === this.height &&
          tileX >= 1 &&
          tileX <= this.width
        ) {
          const depth = this.depthOn(tileX - 1, this.height - 1, s, t, tileX);
          if (depth >= 0 && depth <= edgeContactTolerance) {
            return this.found(tileX - 1, this.height - 1, tileX, s, t, null, true);
          }
          previous = depth;
          afterRightCorner = true;
          if (depth >= 0) under = true;
        }
        continue;
      }
      const startDepth = this.depthOn(tileX, tileY, s, t, start);
      if (previous < 0 && startDepth >= 0) {
        const facing = afterRightCorner || k % 2 === 0 ? 'left' : 'right';
        return this.found(tileX, tileY, start, s, t, facing, !under);
      }
      afterRightCorner = false;
      if (entering && startDepth >= 0 && startDepth <= edgeContactTolerance) {
        return this.found(tileX, tileY, start, s, t, null, !under);
      }
      if (startDepth >= 0) under = true;
      if (startDepth < 0 && end > start) {
        const root = this.crossing(tileX, tileY, s, t, start, startDepth, end);
        if (!Number.isNaN(root)) return this.found(tileX, tileY, root, s, t, null, !under);
      }
      previous = this.depthOn(tileX, tileY, s, t, end);
      if (end > start) entering = false;
      lastTileX = tileX;
      lastTileY = tileY;
      lastEnd = end;
    }
    return null;
  }
}

function interpolateRoot(a: number, da: number, b: number, db: number): number {
  const span = db - da;
  return span > 0 ? a + ((b - a) * -da) / span : b;
}

function insideTile(value: number, tile: number): number {
  const upper = tile + 1 - 1e-9 * Math.max(1, Math.abs(tile + 1));
  return value < tile ? tile : value > upper ? upper : value;
}

const surfaces = new WeakMap<object, ElevationSurface>();

export function raisedSurfaceFor(scene: {
  width: number;
  height: number;
  elevations: ArrayLike<number>;
}): ElevationSurface {
  const key = scene.elevations as unknown as object;
  let surface = surfaces.get(key);
  if (!surface || surface.width !== scene.width || surface.height !== scene.height) {
    surface = new ElevationSurface(scene.width, scene.height, scene.elevations);
    surfaces.set(key, surface);
  }
  return surface;
}
