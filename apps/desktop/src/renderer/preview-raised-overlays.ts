import type { ElevationSurface } from './preview-elevation';
import { appendCornerArc, type HighlightCorners } from './preview-highlight-corners';
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

export interface MapRectangleEdges {
  minimumX: number;
  minimumY: number;
  maximumX: number;
  maximumY: number;
}

export function raisedRoundedRectangleOutline(
  surface: ElevationSurface,
  rectangle: MapRectangleEdges,
  radius: number,
  segments: number,
): RaisedPolyline[] {
  const loop = raisedRoundedRectangleLoop(surface, rectangle, radius, segments);
  if (!surface.hasSteps) return [loop];
  return visibleRuns(surface, loop);
}

const insideOffset = 1e-6;

function raisedRoundedRectangleLoop(
  surface: ElevationSurface,
  rectangle: MapRectangleEdges,
  radius: number,
  segments: number,
): number[] {
  const { minimumX: x0, minimumY: y0, maximumX: x1, maximumY: y1 } = rectangle;
  const r = Math.max(0, Math.min(radius, (x1 - x0) / 2, (y1 - y0) / 2));
  const loop: number[] = [];
  const push = (x: number, y: number, h: number) => {
    const last = loop.length - 3;
    if (last >= 0 && loop[last] === x && loop[last + 1] === y && loop[last + 2] === h) return;
    loop.push(x, y, h);
  };
  const side = (ax: number, ay: number, bx: number, by: number, nx: number, ny: number) => {
    const horizontal = ay === by;
    const from = horizontal ? ax : ay;
    const to = horizontal ? bx : by;
    const fixed = horizontal ? ay : ax;
    const direction = Math.sign(to - from);
    if (direction === 0) return;
    const cuts = [from];
    for (
      let cut = direction > 0 ? Math.floor(from) + 1 : Math.ceil(from) - 1;
      direction > 0 ? cut < to : cut > to;
      cut += direction
    ) {
      cuts.push(cut);
    }
    cuts.push(to);
    for (let piece = 0; piece + 1 < cuts.length; piece += 1) {
      const start = cuts[piece]!;
      const end = cuts[piece + 1]!;
      const middle = (start + end) / 2;
      const tileX = clampTile(horizontal ? middle : fixed + nx * insideOffset, surface.width);
      const tileY = clampTile(horizontal ? fixed + ny * insideOffset : middle, surface.height);
      const tile = tileY * surface.width + tileX;
      const point = (along: number) => {
        const x = horizontal ? along : fixed;
        const y = horizontal ? fixed : along;
        push(x, y, tileTopHeight(surface, tile, x - tileX, y - tileY));
      };
      point(start);
      const local = horizontal ? fixed - tileY : fixed - tileX;
      const foldLocal = surface.foldsTopBottom(tile) ? 1 - local : local;
      const fold = (horizontal ? tileX : tileY) + foldLocal;
      if ((fold - start) * (fold - end) < 0) point(fold);
      point(end);
    }
  };
  const corner = (px: number, py: number, sx: number, sy: number, from: number, to: number) => {
    if (r <= 0) return;
    const points: number[] = [];
    appendCornerArc(points, px, py, sx, sy, r, from, to, segments);
    const centreX = px + r * sx;
    const centreY = py + r * sy;
    for (let index = 0; index < points.length; index += 2) {
      const x = points[index]!;
      const y = points[index + 1]!;
      const tileX = clampTile(x + Math.sign(centreX - x) * insideOffset, surface.width);
      const tileY = clampTile(y + Math.sign(centreY - y) * insideOffset, surface.height);
      push(x, y, tileTopHeight(surface, tileY * surface.width + tileX, x - tileX, y - tileY));
    }
  };
  side(x0 + r, y0, x1 - r, y0, 0, 1);
  corner(x1, y0, -1, 1, 0, Math.PI / 2);
  side(x1, y0 + r, x1, y1 - r, -1, 0);
  corner(x1, y1, -1, -1, Math.PI / 2, 0);
  side(x1 - r, y1, x0 + r, y1, 0, -1);
  corner(x0, y1, 1, -1, 0, Math.PI / 2);
  side(x0, y1 - r, x0, y0 + r, 1, 0);
  corner(x0, y0, 1, 1, Math.PI / 2, 0);
  if (loop.length >= 3) push(loop[0]!, loop[1]!, loop[2]!);
  return loop;
}

function clampTile(value: number, size: number): number {
  return Math.min(size - 1, Math.max(0, Math.floor(value)));
}

export function tileTopHeight(
  surface: ElevationSurface,
  tile: number,
  fx: number,
  fy: number,
): number {
  const base = tile * 4;
  const h0 = surface.corners[base]!;
  const h1 = surface.corners[base + 1]!;
  const h2 = surface.corners[base + 2]!;
  const h3 = surface.corners[base + 3]!;
  if (surface.foldsTopBottom(tile)) {
    return fx + fy <= 1
      ? h0 + fx * (h1 - h0) + fy * (h3 - h0)
      : h2 + (1 - fx) * (h3 - h2) + (1 - fy) * (h1 - h2);
  }
  return fx >= fy ? h0 + fx * (h1 - h0) + fy * (h2 - h1) : h0 + fy * (h3 - h0) + fx * (h2 - h3);
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

const tileCornerFrames = [
  { x: 0, y: 0, sx: 1, sy: 1 },
  { x: 1, y: 0, sx: -1, sy: 1 },
  { x: 1, y: 1, sx: -1, sy: -1 },
  { x: 0, y: 1, sx: 1, sy: -1 },
] as const;

export function raisedRoundedTileFill(
  surface: ElevationSurface,
  corners: HighlightCorners,
  radius: number,
  segments: number,
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
  const height = surface.height;
  const { runs, convex, concave } = corners;
  const local: number[] = [];
  const fan = (tile: number, tileX: number, tileY: number, points: readonly number[]) => {
    const first = vertex(
      tileX + points[0]!,
      tileY + points[1]!,
      tileTopHeight(surface, tile, points[0]!, points[1]!),
    );
    let previous = -1;
    for (let index = 2; index < points.length; index += 2) {
      const next = vertex(
        tileX + points[index]!,
        tileY + points[index + 1]!,
        tileTopHeight(surface, tile, points[index]!, points[index + 1]!),
      );
      if (previous >= 0) indices.push(first, previous, next);
      previous = next;
    }
  };
  const triangle = (
    tile: number,
    tileX: number,
    tileY: number,
    cornerIds: number[],
    mask: number,
  ) => {
    local.length = 0;
    for (let index = 0; index < 3; index += 1) {
      const id = cornerIds[index]!;
      const frame = tileCornerFrames[id]!;
      if (!(mask & (1 << id))) {
        local.push(frame.x, frame.y);
        continue;
      }
      const angle = (neighbour: number) => {
        const other = tileCornerFrames[neighbour]!;
        const along = (other.x - frame.x) * frame.sx;
        const across = (other.y - frame.y) * frame.sy;
        return Math.atan2(across, along);
      };
      appendCornerArc(
        local,
        frame.x,
        frame.y,
        frame.sx,
        frame.sy,
        radius,
        angle(cornerIds[(index + 2) % 3]!),
        angle(cornerIds[(index + 1) % 3]!),
        segments,
      );
    }
    fan(tile, tileX, tileY, local);
  };
  for (let run = 0; run < runs.length / 3; run += 1) {
    const y = runs[run * 3]!;
    const first = runs[run * 3 + 1]!;
    const end = runs[run * 3 + 2]!;
    if (y < 0 || y >= height) continue;
    const runCorners = radius > 0 ? convex[run]! : 0;
    for (let x = Math.max(0, first); x < Math.min(end, width); x += 1) {
      const tile = y * width + x;
      const mask =
        (x === first ? runCorners & 0b1001 : 0) | (x === end - 1 ? runCorners & 0b0110 : 0);
      const h = (corner: number) => surface.corners[tile * 4 + corner]!;
      if (mask === 0) {
        const left = vertex(x, y, h(0));
        const top = vertex(x + 1, y, h(1));
        const right = vertex(x + 1, y + 1, h(2));
        const bottom = vertex(x, y + 1, h(3));
        if (surface.foldsTopBottom(tile)) indices.push(left, top, bottom, top, right, bottom);
        else indices.push(left, top, right, left, right, bottom);
      } else if (surface.foldsTopBottom(tile)) {
        triangle(tile, x, y, [0, 1, 3], mask);
        triangle(tile, x, y, [1, 2, 3], mask);
      } else {
        triangle(tile, x, y, [0, 1, 2], mask);
        triangle(tile, x, y, [0, 2, 3], mask);
      }
      const walls = surface.frontWalls(x, y);
      if (walls & 1) {
        const neighbour = (tile - 1) * 4;
        const left = vertex(x, y, h(0));
        const bottom = vertex(x, y + 1, h(3));
        const footLeft = vertex(x, y, Math.min(h(0), surface.corners[neighbour + 1]!));
        const footBottom = vertex(x, y + 1, Math.min(h(3), surface.corners[neighbour + 2]!));
        indices.push(left, bottom, footBottom, left, footBottom, footLeft);
      }
      if (walls & 2) {
        const neighbour = (tile + width) * 4;
        const bottom = vertex(x, y + 1, h(3));
        const right = vertex(x + 1, y + 1, h(2));
        const footBottom = vertex(x, y + 1, Math.min(h(3), surface.corners[neighbour]!));
        const footRight = vertex(x + 1, y + 1, Math.min(h(2), surface.corners[neighbour + 1]!));
        indices.push(bottom, right, footRight, bottom, footRight, footBottom);
      }
    }
  }
  if (radius > 0) {
    for (let index = 0; index < concave.length; index += 4) {
      const vx = concave[index]!;
      const vy = concave[index + 1]!;
      const sx = concave[index + 2]!;
      const sy = concave[index + 3]!;
      const tileX = sx > 0 ? vx : vx - 1;
      const tileY = sy > 0 ? vy : vy - 1;
      const besideX = tileX - sx;
      const besideY = tileY - sy;
      if (tileX < 0 || tileY < 0 || tileX >= width || tileY >= height) continue;
      if (besideX < 0 || besideY < 0 || besideX >= width || besideY >= height) continue;
      const cornerAt = (cx: number, cy: number) =>
        surface.corners[(cy * width + cx) * 4 + cornerIndex(vx - cx, vy - cy)]!;
      const level = cornerAt(tileX, tileY);
      if (cornerAt(besideX, tileY) !== level || cornerAt(tileX, besideY) !== level) continue;
      const tile = tileY * width + tileX;
      const points: number[] = [vx - tileX, vy - tileY];
      appendCornerArc(points, vx - tileX, vy - tileY, sx, sy, radius, 0, Math.PI / 2, segments);
      fan(tile, tileX, tileY, points);
    }
  }
  return {
    positions: Float32Array.from(positions),
    depths: Float32Array.from(depths),
    indices: Uint32Array.from(indices),
  };
}

function cornerIndex(dx: number, dy: number): number {
  if (dy === 0) return dx === 0 ? 0 : 1;
  return dx === 0 ? 3 : 2;
}
