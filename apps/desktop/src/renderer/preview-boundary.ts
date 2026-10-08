export interface BoundaryPoint {
  x: number;
  y: number;
}

export interface BoundaryFrame {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type BoundaryFrameSide = 'left' | 'top' | 'right' | 'bottom';

export interface VisibleMapBoundary {
  points: BoundaryPoint[];
  edges: Array<BoundaryFrameSide | null>;
  center: BoundaryPoint | null;
  area: number;
}

const emptyBoundary: VisibleMapBoundary = Object.freeze({
  points: [],
  edges: [],
  center: null,
  area: 0,
}) as VisibleMapBoundary;

const pointEpsilon = 1e-3;
const minimumArea = 0.5;

export function visibleMapBoundary(
  polygon: readonly number[],
  frame: BoundaryFrame,
): VisibleMapBoundary {
  if (
    polygon.length < 6 ||
    polygon.length % 2 !== 0 ||
    !polygon.every(Number.isFinite) ||
    !(frame.right > frame.left) ||
    !(frame.bottom > frame.top)
  ) {
    return emptyBoundary;
  }
  let points: BoundaryPoint[] = [];
  for (let index = 0; index < polygon.length; index += 2) {
    points.push({ x: polygon[index]!, y: polygon[index + 1]! });
  }
  const planes: Array<{
    inside(point: BoundaryPoint): boolean;
    intersect(from: BoundaryPoint, to: BoundaryPoint): BoundaryPoint;
  }> = [
    {
      inside: (point) => point.x >= frame.left,
      intersect: (from, to) => atX(from, to, frame.left),
    },
    {
      inside: (point) => point.x <= frame.right,
      intersect: (from, to) => atX(from, to, frame.right),
    },
    {
      inside: (point) => point.y >= frame.top,
      intersect: (from, to) => atY(from, to, frame.top),
    },
    {
      inside: (point) => point.y <= frame.bottom,
      intersect: (from, to) => atY(from, to, frame.bottom),
    },
  ];
  for (const plane of planes) {
    if (points.length === 0) break;
    const clipped: BoundaryPoint[] = [];
    for (let index = 0; index < points.length; index += 1) {
      const current = points[index]!;
      const previous = points[(index + points.length - 1) % points.length]!;
      const currentInside = plane.inside(current);
      const previousInside = plane.inside(previous);
      if (currentInside) {
        if (!previousInside) clipped.push(plane.intersect(previous, current));
        clipped.push(current);
      } else if (previousInside) {
        clipped.push(plane.intersect(previous, current));
      }
    }
    points = clipped;
  }
  points = simplify(points);
  if (points.length < 3) return emptyBoundary;
  let doubleArea = 0;
  let centroidX = 0;
  let centroidY = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    const cross = current.x * next.y - next.x * current.y;
    doubleArea += cross;
    centroidX += (current.x + next.x) * cross;
    centroidY += (current.y + next.y) * cross;
  }
  const area = Math.abs(doubleArea) / 2;
  if (area < minimumArea) return emptyBoundary;
  const edges = points.map((point, index) =>
    frameSide(point, points[(index + 1) % points.length]!, frame),
  );
  return {
    points,
    edges,
    center: { x: centroidX / (3 * doubleArea), y: centroidY / (3 * doubleArea) },
    area,
  };
}

export function boundarySubpaths(boundary: VisibleMapBoundary): { border: string; frame: string } {
  const count = boundary.points.length;
  if (count === 0) return { border: '', frame: '' };
  const onFrame = boundary.edges.map((edge) => edge !== null);
  const format = (point: BoundaryPoint) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`;
  const closed = (points: BoundaryPoint[]) =>
    `${points.map((point, index) => `${index === 0 ? 'M' : 'L'}${format(point)}`).join(' ')} Z`;
  if (onFrame.every((value) => !value)) return { border: closed(boundary.points), frame: '' };
  if (onFrame.every(Boolean)) return { border: '', frame: closed(boundary.points) };
  const start = onFrame.findIndex((value, index) => value !== onFrame[(index + count - 1) % count]);
  const runs: { frame: boolean; points: BoundaryPoint[] }[] = [];
  for (let offset = 0; offset < count; offset += 1) {
    const index = (start + offset) % count;
    const from = boundary.points[index]!;
    const to = boundary.points[(index + 1) % count]!;
    const last = runs.at(-1);
    if (last && last.frame === onFrame[index]) last.points.push(to);
    else runs.push({ frame: onFrame[index]!, points: [from, to] });
  }
  const open = (points: BoundaryPoint[]) =>
    points.map((point, index) => `${index === 0 ? 'M' : 'L'}${format(point)}`).join(' ');
  return {
    border: runs
      .filter((run) => !run.frame)
      .map((run) => open(run.points))
      .join(' '),
    frame: runs
      .filter((run) => run.frame)
      .map((run) => open(run.points))
      .join(' '),
  };
}

export function boundaryFrameSides(boundary: VisibleMapBoundary): BoundaryFrameSide[] {
  const order: BoundaryFrameSide[] = ['top', 'right', 'bottom', 'left'];
  return order.filter((side) => boundary.edges.includes(side));
}

export function insetBoundaryFrame(
  width: number,
  height: number,
  strokeWidth: number,
): BoundaryFrame {
  const inset = Math.max(0, strokeWidth) / 2;
  return { left: inset, top: inset, right: width - inset, bottom: height - inset };
}

function atX(from: BoundaryPoint, to: BoundaryPoint, x: number): BoundaryPoint {
  const t = (x - from.x) / (to.x - from.x);
  return { x, y: from.y + (to.y - from.y) * t };
}

function atY(from: BoundaryPoint, to: BoundaryPoint, y: number): BoundaryPoint {
  const t = (y - from.y) / (to.y - from.y);
  return { x: from.x + (to.x - from.x) * t, y };
}

function simplify(points: BoundaryPoint[]): BoundaryPoint[] {
  let result = points.filter((point, index) => {
    const next = points[(index + 1) % points.length]!;
    return points.length === 1 || !samePoint(point, next);
  });
  let changed = true;
  while (changed && result.length >= 3) {
    changed = false;
    for (let index = 0; index < result.length; index += 1) {
      const previous = result[(index + result.length - 1) % result.length]!;
      const current = result[index]!;
      const next = result[(index + 1) % result.length]!;
      const cross =
        (current.x - previous.x) * (next.y - current.y) -
        (current.y - previous.y) * (next.x - current.x);
      const scale =
        Math.hypot(current.x - previous.x, current.y - previous.y) *
        Math.hypot(next.x - current.x, next.y - current.y);
      if (Math.abs(cross) <= scale * 1e-9) {
        result = result.filter((_, candidate) => candidate !== index);
        changed = true;
        break;
      }
    }
  }
  return result;
}

function samePoint(left: BoundaryPoint, right: BoundaryPoint): boolean {
  return Math.abs(left.x - right.x) <= pointEpsilon && Math.abs(left.y - right.y) <= pointEpsilon;
}

function frameSide(
  from: BoundaryPoint,
  to: BoundaryPoint,
  frame: BoundaryFrame,
): BoundaryFrameSide | null {
  const on = (value: number, target: number) => Math.abs(value - target) <= pointEpsilon;
  if (on(from.x, frame.left) && on(to.x, frame.left)) return 'left';
  if (on(from.x, frame.right) && on(to.x, frame.right)) return 'right';
  if (on(from.y, frame.top) && on(to.y, frame.top)) return 'top';
  if (on(from.y, frame.bottom) && on(to.y, frame.bottom)) return 'bottom';
  return null;
}

export type BoundaryMotion = 'spinning' | 'settling' | 'rest';

export function nextBoundaryMotion(current: BoundaryMotion, active: boolean): BoundaryMotion {
  if (active) return 'spinning';
  return current === 'spinning' ? 'settling' : current;
}

export function cssDurationMilliseconds(value: string): number {
  const match = /^\s*(-?[\d.]+)(ms|s)\s*$/u.exec(value);
  if (!match) return 0;
  const amount = Number.parseFloat(match[1]!);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return match[2] === 's' ? amount * 1000 : amount;
}
