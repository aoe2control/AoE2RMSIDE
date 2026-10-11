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
  hidden: boolean[];
  center: BoundaryPoint | null;
  area: number;
}

const emptyBoundary: VisibleMapBoundary = Object.freeze({
  points: [],
  edges: [],
  hidden: [],
  center: null,
  area: 0,
}) as VisibleMapBoundary;

const pointEpsilon = 1e-3;
const minimumArea = 0.5;

export function visibleMapBoundary(
  polygon: readonly number[],
  frame: BoundaryFrame,
  hidden: ArrayLike<number> | null = null,
): VisibleMapBoundary {
  if (
    polygon.length < 6 ||
    polygon.length % 2 !== 0 ||
    !polygon.every(Number.isFinite) ||
    !(frame.right > frame.left) ||
    !(frame.bottom > frame.top) ||
    (hidden !== null && hidden.length !== polygon.length / 2)
  ) {
    return emptyBoundary;
  }
  let points: BoundaryPoint[] = [];
  let leaving: boolean[] = [];
  for (let index = 0; index < polygon.length; index += 2) {
    points.push({ x: polygon[index]!, y: polygon[index + 1]! });
    leaving.push(hidden !== null && hidden[index / 2] !== 0);
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
    const clippedLeaving: boolean[] = [];
    for (let index = 0; index < points.length; index += 1) {
      const current = points[index]!;
      const previousIndex = (index + points.length - 1) % points.length;
      const previous = points[previousIndex]!;
      const currentInside = plane.inside(current);
      const previousInside = plane.inside(previous);
      if (currentInside) {
        if (!previousInside) {
          clipped.push(plane.intersect(previous, current));
          clippedLeaving.push(leaving[previousIndex]!);
        }
        clipped.push(current);
        clippedLeaving.push(leaving[index]!);
      } else if (previousInside) {
        clipped.push(plane.intersect(previous, current));
        clippedLeaving.push(false);
      }
    }
    points = clipped;
    leaving = clippedLeaving;
  }
  ({ points, leaving } = simplify(points, leaving));
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
    hidden: edges.map((edge, index) => edge === null && leaving[index]!),
    center: { x: centroidX / (3 * doubleArea), y: centroidY / (3 * doubleArea) },
    area,
  };
}

export function boundaryOutlinePath(
  polygon: readonly number[],
  hidden: ArrayLike<number> | null = null,
): string {
  const count = polygon.length / 2;
  if (count < 3 || !Number.isInteger(count)) return '';
  const format = (index: number) =>
    `${polygon[index * 2]!.toFixed(2)},${polygon[index * 2 + 1]!.toFixed(2)}`;
  const isHidden = (edge: number) => hidden !== null && hidden[edge] !== 0;
  let start = -1;
  for (let edge = 0; edge < count; edge += 1) {
    if (isHidden(edge)) {
      start = edge;
      break;
    }
  }
  if (start < 0) {
    const parts: string[] = [];
    for (let index = 0; index < count; index += 1) {
      parts.push(`${index === 0 ? 'M' : 'L'}${format(index)}`);
    }
    return `${parts.join(' ')} Z`;
  }
  const parts: string[] = [];
  let open = false;
  for (let offset = 1; offset <= count; offset += 1) {
    const edge = (start + offset) % count;
    if (isHidden(edge)) {
      open = false;
      continue;
    }
    if (!open) parts.push(`M${format(edge)}`);
    parts.push(`L${format((edge + 1) % count)}`);
    open = true;
  }
  return parts.join(' ');
}

export function boundarySubpaths(boundary: VisibleMapBoundary): { border: string; frame: string } {
  const count = boundary.points.length;
  if (count === 0) return { border: '', frame: '' };
  const kinds = boundary.edges.map((edge, index) =>
    edge !== null ? 'frame' : boundary.hidden[index] ? 'hidden' : 'border',
  );
  const format = (point: BoundaryPoint) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`;
  const closed = (points: BoundaryPoint[]) =>
    `${points.map((point, index) => `${index === 0 ? 'M' : 'L'}${format(point)}`).join(' ')} Z`;
  if (kinds.every((kind) => kind === 'border')) {
    return { border: closed(boundary.points), frame: '' };
  }
  if (kinds.every((kind) => kind === 'frame'))
    return { border: '', frame: closed(boundary.points) };
  const start = Math.max(
    0,
    kinds.findIndex((kind, index) => kind !== kinds[(index + count - 1) % count]),
  );
  const runs: { kind: string; points: BoundaryPoint[] }[] = [];
  for (let offset = 0; offset < count; offset += 1) {
    const index = (start + offset) % count;
    const from = boundary.points[index]!;
    const to = boundary.points[(index + 1) % count]!;
    const last = runs.at(-1);
    if (last && last.kind === kinds[index]) last.points.push(to);
    else runs.push({ kind: kinds[index]!, points: [from, to] });
  }
  const open = (points: BoundaryPoint[]) =>
    points.map((point, index) => `${index === 0 ? 'M' : 'L'}${format(point)}`).join(' ');
  const joined = (kind: string) =>
    runs
      .filter((run) => run.kind === kind)
      .map((run) => open(run.points))
      .join(' ');
  return { border: joined('border'), frame: joined('frame') };
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

function simplify(
  points: BoundaryPoint[],
  leaving: boolean[],
): { points: BoundaryPoint[]; leaving: boolean[] } {
  const unique: number[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const next = points[(index + 1) % points.length]!;
    if (points.length === 1 || !samePoint(points[index]!, next)) unique.push(index);
  }
  const kept: number[] = [];
  const straight = (previous: number, current: number, next: number) =>
    leaving[previous] === leaving[current] &&
    collinear(points[previous]!, points[current]!, points[next]!);
  for (const index of unique) {
    kept.push(index);
    while (kept.length >= 3 && straight(kept.at(-3)!, kept.at(-2)!, kept.at(-1)!)) {
      kept.splice(kept.length - 2, 1);
    }
  }
  let changed = true;
  while (changed && kept.length >= 3) {
    changed = false;
    if (straight(kept.at(-2)!, kept.at(-1)!, kept[0]!)) {
      kept.pop();
      changed = true;
    } else if (straight(kept.at(-1)!, kept[0]!, kept[1]!)) {
      kept.shift();
      changed = true;
    }
  }
  return {
    points: kept.map((index) => points[index]!),
    leaving: kept.map((index) => leaving[index]!),
  };
}

function collinear(previous: BoundaryPoint, current: BoundaryPoint, next: BoundaryPoint): boolean {
  const cross =
    (current.x - previous.x) * (next.y - current.y) -
    (current.y - previous.y) * (next.x - current.x);
  const scale =
    Math.hypot(current.x - previous.x, current.y - previous.y) *
    Math.hypot(next.x - current.x, next.y - current.y);
  return Math.abs(cross) <= scale * 1e-9;
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
