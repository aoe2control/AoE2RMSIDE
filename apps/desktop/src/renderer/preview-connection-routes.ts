import { failedConnectionSearch, type ConnectionRouteSet } from '../shared/connection-routes';
import { t } from '../shared/i18n/translator';
import {
  mapToScreen,
  previewProjectionVerticalScale,
  previewScale,
  screenToMap,
  type PreviewCamera,
  type PreviewViewport,
  type ScreenPoint,
  type TopDownConnection,
} from './top-down-preview';

export type ConnectionOverlayMode = 'off' | 'lines' | 'paths';

export type ConnectionPathsAvailability = 'available' | 'not-final' | 'unavailable';

export function connectionPathsAvailability(
  routes: ConnectionRouteSet | null,
  final: boolean,
): ConnectionPathsAvailability {
  if (!final) return 'not-final';
  return routes ? 'available' : 'unavailable';
}

export function shownConnectionOverlayMode(
  chosen: ConnectionOverlayMode,
  availability: ConnectionPathsAvailability,
): ConnectionOverlayMode {
  return chosen === 'paths' && availability !== 'available' ? 'lines' : chosen;
}

export function nextConnectionOverlayMode(
  shown: ConnectionOverlayMode,
  availability: ConnectionPathsAvailability,
): ConnectionOverlayMode {
  if (shown === 'off') return 'lines';
  if (shown === 'lines') return availability === 'available' ? 'paths' : 'off';
  return 'off';
}

export function connectionRoutesTruncation(
  routes: Pick<ConnectionRouteSet, 'count' | 'totalAttempts'> | null,
): { shown: number; total: number } | null {
  if (!routes || routes.count >= routes.totalAttempts) return null;
  return { shown: routes.count, total: routes.totalAttempts };
}

export function connectionOverlayPresentation(
  shown: ConnectionOverlayMode,
  availability: ConnectionPathsAvailability,
  routes: Pick<ConnectionRouteSet, 'count' | 'totalAttempts'> | null,
): { label: string; note: string | null } {
  if (shown === 'off') return { label: t('preview-panel.tool.connections.off'), note: null };
  if (shown === 'paths') {
    const truncation = connectionRoutesTruncation(routes);
    return {
      label: t('preview-panel.tool.connections.paths'),
      note: truncation ? t('preview-panel.tool.connections.paths-partial', truncation) : null,
    };
  }
  return {
    label: t('preview-panel.tool.connections'),
    note:
      availability === 'not-final'
        ? t('preview-panel.tool.connections.paths-not-final')
        : availability === 'unavailable'
          ? t('preview-panel.tool.connections.paths-unavailable')
          : null,
  };
}

export const failedConnectionSearchColor = 0xb4b9c2;

export const connectionOverlayStroke = Object.freeze({
  line: 2,
  path: 2,
  pathAlpha: 0.72,
  endpointRadius: 2.5,
  failed: 1,
  failedAlpha: 0.9,
  dash: 4,
  gap: 3,
  hover: 4,
  hoverHalo: 8,
  hitTolerance: 5,
});

export type ConnectionOverlayTarget =
  | { kind: 'line'; connectionIndex: number; operationIndex: number | null }
  | { kind: 'path'; recordIndex: number; connectionIndex: number; operationIndex: number }
  | { kind: 'failed'; recordIndex: number; operationIndex: number };

export function sameConnectionOverlayTarget(
  left: ConnectionOverlayTarget | null,
  right: ConnectionOverlayTarget | null,
): boolean {
  if (left === null || right === null) return left === right;
  if (left.kind !== right.kind) return false;
  return left.kind === 'line'
    ? left.connectionIndex === (right as typeof left).connectionIndex
    : left.recordIndex === (right as typeof left).recordIndex;
}

export function connectionOverlayTargetKey(target: ConnectionOverlayTarget | null): string {
  if (!target) return '';
  return target.kind === 'line'
    ? `line:${target.connectionIndex}`
    : `${target.kind}:${target.recordIndex}`;
}

interface ScreenBasis {
  originX: number;
  originY: number;
  xx: number;
  xy: number;
  yx: number;
  yy: number;
}

function screenBasis(
  width: number,
  height: number,
  camera: PreviewCamera,
  viewport: PreviewViewport,
): ScreenBasis {
  const origin = mapToScreen({ x: 0, y: 0 }, width, height, camera, viewport);
  const unitX = mapToScreen({ x: 1, y: 0 }, width, height, camera, viewport);
  const unitY = mapToScreen({ x: 0, y: 1 }, width, height, camera, viewport);
  return {
    originX: origin.x,
    originY: origin.y,
    xx: unitX.x - origin.x,
    xy: unitX.y - origin.y,
    yx: unitY.x - origin.x,
    yy: unitY.y - origin.y,
  };
}

function tileCenter(basis: ScreenBasis, x: number, y: number): ScreenPoint {
  const mapX = x + 0.5;
  const mapY = y + 0.5;
  return {
    x: basis.originX + mapX * basis.xx + mapY * basis.yx,
    y: basis.originY + mapX * basis.xy + mapY * basis.yy,
  };
}

function segmentDistanceSquared(point: ScreenPoint, a: ScreenPoint, b: ScreenPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const along =
    length === 0
      ? 0
      : Math.min(1, Math.max(0, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length));
  const nearestX = a.x + along * dx - point.x;
  const nearestY = a.y + along * dy - point.y;
  return nearestX * nearestX + nearestY * nearestY;
}

export interface ConnectionOverlayGeometry {
  width: number;
  height: number;
  connections: readonly Pick<TopDownConnection, 'start' | 'end'>[];
  connectionOperation(index: number): number | null;
  routes: ConnectionRouteSet | null;
}

export function forEachConnectionOverlayElement(
  geometry: ConnectionOverlayGeometry,
  mode: 'lines' | 'paths',
  camera: PreviewCamera,
  viewport: PreviewViewport,
  visit: (target: ConnectionOverlayTarget, points: ScreenPoint[]) => void,
): void {
  const basis = screenBasis(geometry.width, geometry.height, camera, viewport);
  if (mode === 'lines') {
    geometry.connections.forEach((connection, connectionIndex) => {
      visit(
        {
          kind: 'line',
          connectionIndex,
          operationIndex: geometry.connectionOperation(connectionIndex),
        },
        [
          tileCenter(basis, connection.start.x, connection.start.y),
          tileCenter(basis, connection.end.x, connection.end.y),
        ],
      );
    });
    return;
  }
  const routes = geometry.routes;
  if (!routes) return;
  for (let recordIndex = 0; recordIndex < routes.count; recordIndex += 1) {
    const graphIndex = routes.records[recordIndex * 4]!;
    const operationIndex = routes.records[recordIndex * 4 + 1]!;
    const first = routes.records[recordIndex * 4 + 2]!;
    const count = routes.records[recordIndex * 4 + 3]!;
    const points: ScreenPoint[] = [];
    for (let vertex = first; vertex < first + count; vertex += 1) {
      points.push(
        tileCenter(basis, routes.vertices[vertex * 2]!, routes.vertices[vertex * 2 + 1]!),
      );
    }
    visit(
      graphIndex === failedConnectionSearch
        ? { kind: 'failed', recordIndex, operationIndex }
        : { kind: 'path', recordIndex, connectionIndex: graphIndex, operationIndex },
      points,
    );
  }
}

export function connectionTargetPoints(
  geometry: ConnectionOverlayGeometry,
  mode: 'lines' | 'paths',
  target: ConnectionOverlayTarget,
  camera: PreviewCamera,
  viewport: PreviewViewport,
): ScreenPoint[] {
  const basis = screenBasis(geometry.width, geometry.height, camera, viewport);
  if (target.kind === 'line') {
    const connection = geometry.connections[target.connectionIndex];
    if (mode !== 'lines' || !connection) return [];
    return [
      tileCenter(basis, connection.start.x, connection.start.y),
      tileCenter(basis, connection.end.x, connection.end.y),
    ];
  }
  const routes = geometry.routes;
  if (mode !== 'paths' || !routes || target.recordIndex >= routes.count) return [];
  const first = routes.records[target.recordIndex * 4 + 2]!;
  const count = routes.records[target.recordIndex * 4 + 3]!;
  const points: ScreenPoint[] = [];
  for (let vertex = first; vertex < first + count; vertex += 1) {
    points.push(tileCenter(basis, routes.vertices[vertex * 2]!, routes.vertices[vertex * 2 + 1]!));
  }
  return points;
}

export function connectionRouteBounds(routes: ConnectionRouteSet): Uint16Array {
  const bounds = new Uint16Array(routes.count * 4);
  for (let record = 0; record < routes.count; record += 1) {
    const first = routes.records[record * 4 + 2]!;
    const count = routes.records[record * 4 + 3]!;
    let minimumX = 0xffff;
    let minimumY = 0xffff;
    let maximumX = 0;
    let maximumY = 0;
    for (let vertex = first; vertex < first + count; vertex += 1) {
      const x = routes.vertices[vertex * 2]!;
      const y = routes.vertices[vertex * 2 + 1]!;
      minimumX = Math.min(minimumX, x);
      minimumY = Math.min(minimumY, y);
      maximumX = Math.max(maximumX, x);
      maximumY = Math.max(maximumY, y);
    }
    bounds.set([minimumX, minimumY, maximumX, maximumY], record * 4);
  }
  return bounds;
}

export function hitTestConnectionOverlay(
  point: ScreenPoint,
  geometry: ConnectionOverlayGeometry,
  mode: 'lines' | 'paths',
  camera: PreviewCamera,
  viewport: PreviewViewport,
  bounds: Uint16Array | null = null,
  tolerance: number = connectionOverlayStroke.hitTolerance,
): ConnectionOverlayTarget | null {
  const basis = screenBasis(geometry.width, geometry.height, camera, viewport);
  const toleranceSquared = tolerance * tolerance;
  const scale = previewScale(geometry.width, geometry.height, camera, viewport);
  const reach = tolerance / Math.max(1e-6, scale * previewProjectionVerticalScale(viewport)) + 1;
  const mapPoint = screenToMap(point, geometry.width, geometry.height, camera, viewport);
  let best: ConnectionOverlayTarget | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  const consider = (target: ConnectionOverlayTarget, distance: number) => {
    if (distance <= toleranceSquared && distance <= bestDistance) {
      best = target;
      bestDistance = distance;
    }
  };
  if (mode === 'lines') {
    geometry.connections.forEach((connection, connectionIndex) => {
      const a = tileCenter(basis, connection.start.x, connection.start.y);
      const b = tileCenter(basis, connection.end.x, connection.end.y);
      consider(
        {
          kind: 'line',
          connectionIndex,
          operationIndex: geometry.connectionOperation(connectionIndex),
        },
        segmentDistanceSquared(point, a, b),
      );
    });
    return best;
  }
  const routes = geometry.routes;
  if (!routes) return null;
  for (let recordIndex = 0; recordIndex < routes.count; recordIndex += 1) {
    if (
      bounds &&
      (mapPoint.x < bounds[recordIndex * 4]! + 0.5 - reach ||
        mapPoint.y < bounds[recordIndex * 4 + 1]! + 0.5 - reach ||
        mapPoint.x > bounds[recordIndex * 4 + 2]! + 0.5 + reach ||
        mapPoint.y > bounds[recordIndex * 4 + 3]! + 0.5 + reach)
    ) {
      continue;
    }
    const graphIndex = routes.records[recordIndex * 4]!;
    const operationIndex = routes.records[recordIndex * 4 + 1]!;
    const first = routes.records[recordIndex * 4 + 2]!;
    const count = routes.records[recordIndex * 4 + 3]!;
    let nearest = Number.POSITIVE_INFINITY;
    let previous = tileCenter(basis, routes.vertices[first * 2]!, routes.vertices[first * 2 + 1]!);
    if (count === 1) nearest = segmentDistanceSquared(point, previous, previous);
    for (let vertex = first + 1; vertex < first + count; vertex += 1) {
      const next = tileCenter(
        basis,
        routes.vertices[vertex * 2]!,
        routes.vertices[vertex * 2 + 1]!,
      );
      nearest = Math.min(nearest, segmentDistanceSquared(point, previous, next));
      previous = next;
    }
    consider(
      graphIndex === failedConnectionSearch
        ? { kind: 'failed', recordIndex, operationIndex }
        : { kind: 'path', recordIndex, connectionIndex: graphIndex, operationIndex },
      nearest,
    );
  }
  return best;
}

export function dashedSegments(
  a: ScreenPoint,
  b: ScreenPoint,
  dash: number = connectionOverlayStroke.dash,
  gap: number = connectionOverlayStroke.gap,
): [ScreenPoint, ScreenPoint][] {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length === 0) return [];
  const unitX = (b.x - a.x) / length;
  const unitY = (b.y - a.y) / length;
  const pieces: [ScreenPoint, ScreenPoint][] = [];
  const step = Math.max(dash + gap, length / 4096);
  for (let start = 0; start < length; start += step) {
    const end = Math.min(length, start + dash);
    pieces.push([
      { x: a.x + unitX * start, y: a.y + unitY * start },
      { x: a.x + unitX * end, y: a.y + unitY * end },
    ]);
  }
  return pieces;
}
