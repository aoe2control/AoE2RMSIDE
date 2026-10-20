import { highlightTileRuns } from './preview-highlight-runs';

export const highlightCornerRadiusShare = 0.2;
export const highlightCornerRadiusMaximumPixels = 5;
export const highlightCornerRadiusMinimumPixels = 1;

export const allCorners = 0b1111;

export interface HighlightCorners {
  runs: Int32Array;
  convex: Uint8Array;
  concave: Int32Array;
}

const cornersCache = new WeakMap<readonly number[], { width: number; corners: HighlightCorners }>();

export function highlightCorners(tileIndices: readonly number[], width: number): HighlightCorners {
  const cached = cornersCache.get(tileIndices);
  if (cached && cached.width === width) return cached.corners;
  const corners = highlightCornersOfRuns(highlightTileRuns(tileIndices, width));
  cornersCache.set(tileIndices, { width, corners });
  return corners;
}

export function highlightCornersOfRuns(runs: Int32Array): HighlightCorners {
  const count = runs.length / 3;
  const convex = new Uint8Array(count);
  const concave: number[] = [];
  if (count === 0) return { runs, convex, concave: new Int32Array(0) };
  const firstRow = runs[0]!;
  const lastRow = runs[runs.length - 3]!;
  const rowStart = new Int32Array(lastRow - firstRow + 2);
  for (let run = 0, row = firstRow; row <= lastRow + 1; row += 1) {
    while (run < count && runs[run * 3]! < row) run += 1;
    rowStart[row - firstRow] = run;
  }
  const covered = (x: number, y: number): boolean => {
    if (y < firstRow || y > lastRow) return false;
    let low = rowStart[y - firstRow]!;
    let high = rowStart[y - firstRow + 1]! - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const first = runs[middle * 3 + 1]!;
      if (x < first) high = middle - 1;
      else if (x >= runs[middle * 3 + 2]!) low = middle + 1;
      else return true;
    }
    return false;
  };
  for (let run = 0; run < count; run += 1) {
    const y = runs[run * 3]!;
    const first = runs[run * 3 + 1]!;
    const end = runs[run * 3 + 2]!;
    let bits = 0;
    const ends = [
      [0, first, first - 1, y - 1, -1, 1],
      [1, end - 1, end, y - 1, 1, 1],
      [2, end - 1, end, y + 1, 1, -1],
      [3, first, first - 1, y + 1, -1, -1],
    ] as const;
    for (const [corner, tileX, besideX, otherY, sx, sy] of ends) {
      if (!covered(tileX, otherY)) bits |= 1 << corner;
      else if (covered(besideX, otherY)) {
        const vertexX = sx < 0 ? first : end;
        const vertexY = sy > 0 ? y : y + 1;
        concave.push(vertexX, vertexY, sx, sy);
      }
    }
    convex[run] = bits;
  }
  return { runs, convex, concave: Int32Array.from(concave) };
}

export function highlightCornerRadius(tileEdgePixels: number): number {
  if (!Number.isFinite(tileEdgePixels) || tileEdgePixels <= 0) return 0;
  const pixels = Math.min(
    tileEdgePixels * highlightCornerRadiusShare,
    highlightCornerRadiusMaximumPixels,
  );
  return pixels < highlightCornerRadiusMinimumPixels ? 0 : pixels / tileEdgePixels;
}

export function cornerArcSegments(radiusPixels: number): number {
  const half = Math.min(3, Math.max(1, Math.ceil(radiusPixels / 3)));
  return half * 2;
}

export function cornerArcPoint(
  px: number,
  py: number,
  sx: number,
  sy: number,
  radius: number,
  angle: number,
): [number, number] {
  return [px + radius * sx * (1 - Math.sin(angle)), py + radius * sy * (1 - Math.cos(angle))];
}

export function appendCornerArc(
  out: number[],
  px: number,
  py: number,
  sx: number,
  sy: number,
  radius: number,
  from: number,
  to: number,
  segments: number,
): void {
  const steps = Math.max(1, Math.round((segments * Math.abs(to - from)) / (Math.PI / 2)));
  for (let step = 0; step <= steps; step += 1) {
    const [x, y] = cornerArcPoint(px, py, sx, sy, radius, from + ((to - from) * step) / steps);
    out.push(x, y);
  }
}

export function roundedRectanglePolygon(
  minimumX: number,
  minimumY: number,
  maximumX: number,
  maximumY: number,
  mask: number,
  radius: number,
  segments: number,
): number[] {
  const points: number[] = [];
  const corners = [
    [minimumX, minimumY, 1, 1, Math.PI / 2, 0],
    [maximumX, minimumY, -1, 1, 0, Math.PI / 2],
    [maximumX, maximumY, -1, -1, Math.PI / 2, 0],
    [minimumX, maximumY, 1, -1, 0, Math.PI / 2],
  ] as const;
  const rounding = Math.min(radius, (maximumX - minimumX) / 2, (maximumY - minimumY) / 2);
  corners.forEach(([x, y, sx, sy, from, to], corner) => {
    if (rounding > 0 && mask & (1 << corner)) {
      appendCornerArc(points, x, y, sx, sy, rounding, from, to, segments);
    } else {
      points.push(x, y);
    }
  });
  return points;
}

export function concaveCornerPolygon(
  x: number,
  y: number,
  sx: number,
  sy: number,
  radius: number,
  segments: number,
): number[] {
  const points = [x, y];
  appendCornerArc(points, x, y, sx, sy, radius, 0, Math.PI / 2, segments);
  return points;
}
