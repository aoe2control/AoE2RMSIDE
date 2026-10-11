import type { ElevationSurface } from './preview-elevation';
import type { PreviewSelection, ScreenPoint } from './top-down-preview';

export type RaisedPolyline = number[];

export const raisedOutlineSamplesPerEdge = 4;

export function raisedSelectionOutline(
  surface: ElevationSurface,
  selection: PreviewSelection,
): RaisedPolyline[] {
  const loop = raisedRectangleLoop(surface, selection);
  if (!surface.hasSteps) return [loop];
  return visibleRuns(surface, loop);
}

function raisedRectangleLoop(
  surface: ElevationSurface,
  selection: Pick<PreviewSelection, 'minimumX' | 'maximumX' | 'minimumY' | 'maximumY'>,
): number[] {
  const loop: number[] = [];
  const add = (tileX: number, tileY: number, corner: number) => {
    const x = corner === 1 || corner === 2 ? tileX + 1 : tileX;
    const y = corner >= 2 ? tileY + 1 : tileY;
    const h = surface.corner(tileY * surface.width + tileX, corner);
    const last = loop.length - 3;
    if (last >= 0 && loop[last] === x && loop[last + 1] === y && loop[last + 2] === h) return;
    loop.push(x, y, h);
  };
  const { minimumX, maximumX, minimumY, maximumY } = selection;
  for (let x = minimumX; x <= maximumX; x += 1) {
    add(x, minimumY, 0);
    add(x, minimumY, 1);
  }
  for (let y = minimumY; y <= maximumY; y += 1) {
    add(maximumX, y, 1);
    add(maximumX, y, 2);
  }
  for (let x = maximumX; x >= minimumX; x -= 1) {
    add(x, maximumY, 2);
    add(x, maximumY, 3);
  }
  for (let y = maximumY; y >= minimumY; y -= 1) {
    add(minimumX, y, 3);
    add(minimumX, y, 0);
  }
  return loop;
}

export interface RaisedBoundaryLoop {
  points: number[];
  hidden: Uint8Array | null;
}

const boundaryLoops = new WeakMap<ElevationSurface, RaisedBoundaryLoop>();

export function raisedBoundaryLoop(surface: ElevationSurface): RaisedBoundaryLoop {
  const cached = boundaryLoops.get(surface);
  if (cached) return cached;
  const loop = raisedRectangleLoop(surface, {
    minimumX: 0,
    minimumY: 0,
    maximumX: surface.width - 1,
    maximumY: surface.height - 1,
  });
  if (loop.length > 3 && loop.slice(-3).join() === loop.slice(0, 3).join()) loop.length -= 3;
  let result: RaisedBoundaryLoop;
  if (!surface.hasSteps) {
    result = mergeStraightRuns(loop, null);
  } else {
    const samples: number[] = [];
    const visible: boolean[] = [];
    const points = loop.length / 3;
    for (let point = 0; point < points; point += 1) {
      const ax = loop[point * 3]!;
      const ay = loop[point * 3 + 1]!;
      const ah = loop[point * 3 + 2]!;
      const next = (point + 1) % points;
      const bx = loop[next * 3]!;
      const by = loop[next * 3 + 1]!;
      const bh = loop[next * 3 + 2]!;
      const steps = sampleSteps(ax, ay, ah, bx, by, bh);
      for (let step = 0; step < steps; step += 1) {
        const f = step / steps;
        const x = ax + (bx - ax) * f;
        const y = ay + (by - ay) * f;
        const h = ah + (bh - ah) * f;
        samples.push(x, y, h);
        visible.push(boundaryPointVisible(surface, x, y, h));
      }
    }
    const count = visible.length;
    const hidden = new Uint8Array(count);
    for (let edge = 0; edge < count; edge += 1) {
      hidden[edge] = visible[edge] && visible[(edge + 1) % count] ? 0 : 1;
    }
    result = mergeStraightRuns(samples, hidden);
    if (result.hidden && !result.hidden.includes(1)) result.hidden = null;
  }
  boundaryLoops.set(surface, result);
  return result;
}

const boundaryInset = 1e-6;

function boundaryPointVisible(surface: ElevationSurface, x: number, y: number, h: number): boolean {
  if (x <= 0 || y >= surface.height) return true;
  const px = x >= surface.width ? x - boundaryInset : x;
  const py = y <= 0 ? y + boundaryInset : y;
  return surface.pointVisible(px, py, h) || nearlyVisible(surface, px, py, h);
}

function sampleSteps(
  ax: number,
  ay: number,
  ah: number,
  bx: number,
  by: number,
  bh: number,
): number {
  const length = Math.max(Math.abs(bx - ax) + Math.abs(by - ay), Math.abs(bh - ah) / 2);
  return Math.max(1, Math.ceil(length * raisedOutlineSamplesPerEdge));
}

function mergeStraightRuns(
  points: readonly number[],
  hidden: Uint8Array | null,
): RaisedBoundaryLoop {
  const count = points.length / 3;
  const kept: number[] = [];
  const keptHidden: number[] = [];
  for (let point = 0; point < count; point += 1) {
    const previous = (point + count - 1) % count;
    const next = (point + 1) % count;
    if (
      count > 3 &&
      (!hidden || hidden[previous] === hidden[point]) &&
      straightThrough(points, previous, point, next)
    ) {
      continue;
    }
    kept.push(points[point * 3]!, points[point * 3 + 1]!, points[point * 3 + 2]!);
    if (hidden) keptHidden.push(hidden[point]!);
  }
  return { points: kept, hidden: hidden ? Uint8Array.from(keptHidden) : null };
}

function straightThrough(points: readonly number[], a: number, b: number, c: number): boolean {
  const ux = points[b * 3]! - points[a * 3]!;
  const uy = points[b * 3 + 1]! - points[a * 3 + 1]!;
  const uh = points[b * 3 + 2]! - points[a * 3 + 2]!;
  const vx = points[c * 3]! - points[b * 3]!;
  const vy = points[c * 3 + 1]! - points[b * 3 + 1]!;
  const vh = points[c * 3 + 2]! - points[b * 3 + 2]!;
  const dot = ux * vx + uy * vy + uh * vh;
  if (!(dot > 0)) return false;
  const cx = uy * vh - uh * vy;
  const cy = uh * vx - ux * vh;
  const cz = ux * vy - uy * vx;
  const scale = (ux * ux + uy * uy + uh * uh) * (vx * vx + vy * vy + vh * vh);
  return cx * cx + cy * cy + cz * cz <= scale * 1e-18;
}

function visibleRuns(surface: ElevationSurface, loop: readonly number[]): RaisedPolyline[] {
  const runs: RaisedPolyline[] = [];
  let current: number[] = [];
  const flush = () => {
    if (current.length >= 6) runs.push(current);
    current = [];
  };
  const points = loop.length / 3;
  for (let point = 0; point < points; point += 1) {
    const ax = loop[point * 3]!;
    const ay = loop[point * 3 + 1]!;
    const ah = loop[point * 3 + 2]!;
    const next = (point + 1) % points;
    const bx = loop[next * 3]!;
    const by = loop[next * 3 + 1]!;
    const bh = loop[next * 3 + 2]!;
    const length = Math.max(Math.abs(bx - ax) + Math.abs(by - ay), Math.abs(bh - ah) / 2);
    const steps = Math.max(1, Math.ceil(length * raisedOutlineSamplesPerEdge));
    for (let step = point === 0 ? 0 : 1; step <= steps; step += 1) {
      const f = step / steps;
      const x = ax + (bx - ax) * f;
      const y = ay + (by - ay) * f;
      const h = ah + (bh - ah) * f;
      if (surface.pointVisible(x, y, h) || nearlyVisible(surface, x, y, h)) current.push(x, y, h);
      else flush();
    }
  }
  const closed =
    current.length > 0 &&
    runs.length > 0 &&
    runs[0]!.slice(0, 3).join() === loop.slice(0, 3).join();
  flush();
  if (closed && runs.length > 1) {
    const last = runs.pop()!;
    runs[0] = [...last, ...runs[0]!.slice(3)];
  }
  return runs;
}

function nearlyVisible(surface: ElevationSurface, x: number, y: number, h: number): boolean {
  const hit = surface.pickPoint(x, y, h);
  if (!hit) return false;
  return Math.abs(hit.x - x) + Math.abs(hit.y - y) <= 1e-3;
}

export interface RaisedFillGeometry {
  positions: Float32Array;
  depths: Float32Array;
  indices: Uint32Array;
}

export function raisedTileFill(
  surface: ElevationSurface,
  tileIndices: Iterable<number>,
  project: (x: number, y: number, h: number) => ScreenPoint,
): RaisedFillGeometry {
  const positions: number[] = [];
  const depths: number[] = [];
  const indices: number[] = [];
  const vertex = (x: number, y: number, h: number) => {
    const screen = project(x, y, h);
    positions.push(screen.x, screen.y);
    depths.push(y - x + h);
    return depths.length - 1;
  };
  const width = surface.width;
  for (const tile of tileIndices) {
    if (tile < 0 || tile >= width * surface.height) continue;
    const x = tile % width;
    const y = (tile - x) / width;
    const h = (corner: number) => surface.corners[tile * 4 + corner]!;
    const left = vertex(x, y, h(0));
    const top = vertex(x + 1, y, h(1));
    const right = vertex(x + 1, y + 1, h(2));
    const bottom = vertex(x, y + 1, h(3));
    if (surface.foldsTopBottom(tile)) indices.push(left, top, bottom, top, right, bottom);
    else indices.push(left, top, right, left, right, bottom);
    const walls = surface.frontWalls(x, y);
    if (walls & 1) {
      const neighbour = (tile - 1) * 4;
      const footLeft = vertex(x, y, Math.min(h(0), surface.corners[neighbour + 1]!));
      const footBottom = vertex(x, y + 1, Math.min(h(3), surface.corners[neighbour + 2]!));
      indices.push(left, bottom, footBottom, left, footBottom, footLeft);
    }
    if (walls & 2) {
      const neighbour = (tile + width) * 4;
      const footBottom = vertex(x, y + 1, Math.min(h(3), surface.corners[neighbour]!));
      const footRight = vertex(x + 1, y + 1, Math.min(h(2), surface.corners[neighbour + 1]!));
      indices.push(bottom, right, footRight, bottom, footRight, footBottom);
    }
  }
  return {
    positions: Float32Array.from(positions),
    depths: Float32Array.from(depths),
    indices: Uint32Array.from(indices),
  };
}
