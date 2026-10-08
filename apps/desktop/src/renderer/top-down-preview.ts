import type { PreviewGenerationResult } from '../shared/api';
import { decodeCliffPieceColumn, type CliffPieceRecord } from '../shared/game-art';
import { decodeAppearanceObjectColumn } from '../shared/terrain-appearances';

export const previewChunkSize = 32;
export const minimumPreviewZoom = 0.95;
export const closestPreviewTileScale = 48;
export const minimumClosestPreviewZoom = 4;

export function maximumPreviewZoomFor(
  mapWidth: number,
  mapHeight: number,
  viewport: PreviewViewport,
): number {
  const fitted = previewScale(mapWidth, mapHeight, fitPreviewCamera(mapWidth, mapHeight), viewport);
  return Math.max(minimumClosestPreviewZoom, closestPreviewTileScale / fitted);
}
export const diamondBasisComponent = Math.SQRT1_2;

export type PreviewProjection = 'orthographic' | 'minimap';

export interface PreviewViewport {
  width: number;
  height: number;
  padding: number;
  projection?: PreviewProjection;
}

export interface PreviewCamera {
  centerX: number;
  centerY: number;
  zoom: number;
}

export interface MapPoint {
  x: number;
  y: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
}

export interface TopDownCliff {
  from: MapPoint;
  to: MapPoint;
  cliffType: number;
}

export interface TopDownConnection {
  start: MapPoint;
  end: MapPoint;
  kind: 'land' | 'water' | 'road' | 'unknown';
}

export interface TopDownObject {
  index: number;
  objectId: number;
  x: number;
  y: number;
  owner: number;
  facet: number;
  footprintWidth: number;
  footprintHeight: number;
  presentationKind: 'object' | 'wall';
  resourceType: number;
  resourceQuantityF32Bits: number;
  resourceDelta: number;
  status: number;
  deathState: number;
  dataStatus: number;
  selectionFlags: number;
  behaviorFlags: number;
  appearance?: 'tree' | 'decoration';
}

export interface TopDownScene {
  width: number;
  height: number;
  terrainIds: number[];
  preConnectionTerrainIds: number[];
  elevations: number[];
  terrainZones: number[];
  landZones: number[];
  layerIds: number[];
  flags: number[];
  cliffs: TopDownCliff[];
  cliffPieces?: CliffPieceRecord[];
  connections: TopDownConnection[];
  objects: TopDownObject[];
}

export interface VisibleTileRange {
  minimumX: number;
  maximumX: number;
  minimumY: number;
  maximumY: number;
  sampleStep: number;
}

export interface VisibleChunk {
  minimumX: number;
  maximumX: number;
  minimumY: number;
  maximumY: number;
}

export interface PreviewHit {
  kind: 'tile';
  index: number;
  x: number;
  y: number;
}

export interface PreviewSelection {
  minimumX: number;
  maximumX: number;
  minimumY: number;
  maximumY: number;
}

export function decodeTopDownScene(
  map: PreviewGenerationResult,
  options: { appearances?: boolean } = {},
): TopDownScene {
  const tileCount = map.width * map.height;
  if (!Number.isSafeInteger(tileCount) || tileCount < 1 || tileCount > 512 * 512) {
    throw new Error('preview map dimensions are invalid');
  }
  const terrainIds = decodeUnsigned(map.terrainIdsLe, 4, tileCount, 'terrain IDs');
  const preConnectionTerrainIds = decodeUnsigned(
    map.preConnectionTerrainIdsLe,
    4,
    tileCount,
    'pre-connection terrain IDs',
  );
  const elevations = decodeSigned16(map.elevations, tileCount, 'elevations');
  const terrainZones = decodeUnsigned(map.terrainZonesLe, 4, tileCount, 'terrain zones');
  const landZones = decodeUnsigned(map.landIdsLe, 4, tileCount, 'land zones');
  const layerIds = decodeUnsigned(map.layerIdsLe, 2, tileCount, 'layer IDs');
  const flags = decodeUnsigned(map.flagsLe, 4, tileCount, 'tile flags');
  const cliffs = decodeCliffs(map.cliffEdges, map.width, map.height);
  const cliffPieces = map.cliffPiecesLe
    ? (decodeCliffPieceColumn(map.cliffPiecesLe, map.width, map.height) ?? [])
    : [];
  const connections = decodeConnections(map, map.width, map.height);
  const objects = decodeObjects(map, map.width, map.height);
  if (options.appearances !== false) appendAppearanceObjects(objects, map);
  return {
    width: map.width,
    height: map.height,
    terrainIds,
    preConnectionTerrainIds,
    elevations,
    terrainZones,
    landZones,
    layerIds,
    flags,
    cliffs,
    cliffPieces,
    connections,
    objects,
  };
}

export function appendAppearanceObjects(
  objects: TopDownObject[],
  map: Pick<PreviewGenerationResult, 'appearanceObjectsLe' | 'width' | 'height'>,
): void {
  if (!map.appearanceObjectsLe) return;
  const records = decodeAppearanceObjectColumn(map.appearanceObjectsLe, map.width, map.height);
  for (const record of records ?? []) {
    objects.push({
      index: objects.length,
      objectId: record.objectId,
      x: record.x,
      y: record.y,
      owner: 0,
      facet: 0,
      footprintWidth: record.footprint,
      footprintHeight: record.footprint,
      presentationKind: 'object',
      resourceType: 0,
      resourceQuantityF32Bits: 0,
      resourceDelta: 0,
      status: 2,
      deathState: 2,
      dataStatus: 0,
      selectionFlags: 0,
      behaviorFlags: 0,
      appearance: record.tree ? 'tree' : 'decoration',
    });
  }
}

export function fitPreviewCamera(width: number, height: number): PreviewCamera {
  return { centerX: width / 2, centerY: height / 2, zoom: 1 };
}

export function previewScale(
  mapWidth: number,
  mapHeight: number,
  camera: PreviewCamera,
  viewport: PreviewViewport,
): number {
  const availableWidth = Math.max(1, viewport.width - viewport.padding * 2);
  const availableHeight = Math.max(1, viewport.height - viewport.padding * 2);
  const mapDiagonal = diamondBasisComponent * (mapWidth + mapHeight);
  const verticalScale = previewProjectionVerticalScale(viewport);
  return (
    Math.max(
      0.000_001,
      Math.min(availableWidth / mapDiagonal, availableHeight / (mapDiagonal * verticalScale)),
    ) * camera.zoom
  );
}

export function previewProjectionVerticalScale(
  viewport: Pick<PreviewViewport, 'projection'>,
): number {
  return viewport.projection === 'minimap' ? 0.5 : 1;
}

export const previewMarkerScreenRadius = Object.freeze({ minimum: 1.5, maximum: 24 });
export const previewAppearanceMarkerMinimumRadius = 1;
export const previewMarkerMinimumSpan = Object.freeze({ object: 0.5, wall: 1 });
export const previewMarkerMaximumSpan = 4;

export function previewObjectMarkerSpan(
  object: Pick<TopDownObject, 'footprintWidth' | 'footprintHeight' | 'presentationKind'>,
): number {
  const footprint = Math.min(object.footprintWidth, object.footprintHeight);
  return Math.min(
    previewMarkerMaximumSpan,
    Math.max(
      previewMarkerMinimumSpan[object.presentationKind],
      Number.isFinite(footprint) ? footprint : 0,
    ),
  );
}

export function previewObjectMarkerScreenRadius(
  scale: number,
  span: number,
  minimum: number = previewMarkerScreenRadius.minimum,
): number {
  const { maximum } = previewMarkerScreenRadius;
  if (!Number.isFinite(scale) || scale <= 0 || !Number.isFinite(span) || span <= 0) {
    return minimum;
  }
  return clamp(scale * Math.SQRT1_2 * span * 0.5, minimum, maximum);
}

export function previewMarkerVerticalScale(viewport: Pick<PreviewViewport, 'projection'>): number {
  return previewProjectionVerticalScale(viewport);
}

export const previewCliffStroke = Object.freeze({ tileFraction: 0.7, minimum: 5, maximum: 18 });

export function previewCliffStrokeWidth(tileEdgePixels: number): number {
  const { tileFraction, minimum, maximum } = previewCliffStroke;
  if (!Number.isFinite(tileEdgePixels) || tileEdgePixels <= 0) return minimum;
  return clamp(tileEdgePixels * tileFraction, minimum, maximum);
}

export function previewObjectFootprintSpan(span: number): number {
  return Number.isFinite(span) ? Math.max(0.5, span) : 0.5;
}

export function hasLandConnection(scene: Pick<TopDownScene, 'connections'>): boolean {
  return scene.connections.some((connection) => connection.kind === 'land');
}

export function mapToScreen(
  point: MapPoint,
  mapWidth: number,
  mapHeight: number,
  camera: PreviewCamera,
  viewport: PreviewViewport,
): ScreenPoint {
  const scale = previewScale(mapWidth, mapHeight, camera, viewport);
  const component = scale * diamondBasisComponent;
  const verticalComponent = component * previewProjectionVerticalScale(viewport);
  const relativeX = point.x - camera.centerX;
  const relativeY = point.y - camera.centerY;
  return {
    x: viewport.width / 2 + (relativeX + relativeY) * component,
    y: viewport.height / 2 + (relativeY - relativeX) * verticalComponent,
  };
}

export function screenToMap(
  point: ScreenPoint,
  mapWidth: number,
  mapHeight: number,
  camera: PreviewCamera,
  viewport: PreviewViewport,
): MapPoint {
  const scale = previewScale(mapWidth, mapHeight, camera, viewport);
  const deltaX = point.x - viewport.width / 2;
  const deltaY = point.y - viewport.height / 2;
  const component = scale * diamondBasisComponent;
  const relativeSum = deltaX / component;
  const relativeDifference = deltaY / (component * previewProjectionVerticalScale(viewport));
  return {
    x: camera.centerX + (relativeSum - relativeDifference) / 2,
    y: camera.centerY + (relativeSum + relativeDifference) / 2,
  };
}

export interface PreviewScreenTransform {
  scale: number;
  x: number;
  y: number;
}

export function previewScreenTransform(
  mapWidth: number,
  mapHeight: number,
  drawnCamera: PreviewCamera,
  drawnViewport: PreviewViewport,
  shownCamera: PreviewCamera,
  shownViewport: PreviewViewport,
): PreviewScreenTransform {
  const scale =
    previewScale(mapWidth, mapHeight, shownCamera, shownViewport) /
    previewScale(mapWidth, mapHeight, drawnCamera, drawnViewport);
  const drawnOrigin = mapToScreen({ x: 0, y: 0 }, mapWidth, mapHeight, drawnCamera, drawnViewport);
  const shownOrigin = mapToScreen({ x: 0, y: 0 }, mapWidth, mapHeight, shownCamera, shownViewport);
  return {
    scale,
    x: shownOrigin.x - drawnOrigin.x * scale,
    y: shownOrigin.y - drawnOrigin.y * scale,
  };
}

export function previewViewportIsCollapsed(viewport: PreviewViewport): boolean {
  return viewport.width <= viewport.padding * 2 + 1 || viewport.height <= viewport.padding * 2 + 1;
}

export function mapRectangleScreenPolygon(
  minimum: MapPoint,
  maximum: MapPoint,
  mapWidth: number,
  mapHeight: number,
  camera: PreviewCamera,
  viewport: PreviewViewport,
): number[] {
  const corners = [
    minimum,
    { x: maximum.x, y: minimum.y },
    maximum,
    { x: minimum.x, y: maximum.y },
  ].map((point) => mapToScreen(point, mapWidth, mapHeight, camera, viewport));
  return corners.flatMap((point) => [point.x, point.y]);
}

export function clampPreviewCamera(
  camera: PreviewCamera,
  mapWidth: number,
  mapHeight: number,
  viewport: PreviewViewport,
): PreviewCamera {
  const zoom = clamp(
    camera.zoom,
    minimumPreviewZoom,
    maximumPreviewZoomFor(mapWidth, mapHeight, viewport),
  );
  const normalized = { ...camera, zoom };
  const scale = previewScale(mapWidth, mapHeight, normalized, viewport);
  const component = diamondBasisComponent * scale;
  const verticalComponent = component * previewProjectionVerticalScale(viewport);
  const halfVisibleU = Math.max(0, viewport.width - viewport.padding * 2) / (2 * component);
  const halfVisibleV =
    Math.max(0, viewport.height - viewport.padding * 2) / (2 * verticalComponent);
  const cameraU = camera.centerX + camera.centerY;
  const cameraV = camera.centerX - camera.centerY;
  const clampedU = clampRangeCenter(cameraU, 0, mapWidth + mapHeight, halfVisibleU);
  const clampedV = clampRangeCenter(cameraV, -mapHeight, mapWidth, halfVisibleV);
  return {
    zoom,
    centerX: (clampedU + clampedV) / 2,
    centerY: (clampedU - clampedV) / 2,
  };
}

export function panPreviewCamera(
  camera: PreviewCamera,
  deltaScreenX: number,
  deltaScreenY: number,
  mapWidth: number,
  mapHeight: number,
  viewport: PreviewViewport,
): PreviewCamera {
  const scale = previewScale(mapWidth, mapHeight, camera, viewport);
  const component = diamondBasisComponent * scale;
  const deltaU = deltaScreenX / component;
  const deltaV = deltaScreenY / (component * previewProjectionVerticalScale(viewport));
  return clampPreviewCamera(
    {
      ...camera,
      centerX: camera.centerX - (deltaU - deltaV) / 2,
      centerY: camera.centerY - (deltaU + deltaV) / 2,
    },
    mapWidth,
    mapHeight,
    viewport,
  );
}

export function zoomPreviewCamera(
  camera: PreviewCamera,
  factor: number,
  anchor: ScreenPoint,
  mapWidth: number,
  mapHeight: number,
  viewport: PreviewViewport,
): PreviewCamera {
  const mapAnchor = screenToMap(anchor, mapWidth, mapHeight, camera, viewport);
  const zoom = clamp(
    camera.zoom * factor,
    minimumPreviewZoom,
    maximumPreviewZoomFor(mapWidth, mapHeight, viewport),
  );
  const candidate = { ...camera, zoom };
  const scale = previewScale(mapWidth, mapHeight, candidate, viewport);
  const deltaX = anchor.x - viewport.width / 2;
  const deltaY = anchor.y - viewport.height / 2;
  const component = diamondBasisComponent * scale;
  const relativeSum = deltaX / component;
  const relativeDifference = deltaY / (component * previewProjectionVerticalScale(viewport));
  return clampPreviewCamera(
    {
      zoom,
      centerX: mapAnchor.x - (relativeSum - relativeDifference) / 2,
      centerY: mapAnchor.y - (relativeSum + relativeDifference) / 2,
    },
    mapWidth,
    mapHeight,
    viewport,
  );
}

export function visibleTileRange(
  scene: Pick<TopDownScene, 'width' | 'height'>,
  camera: PreviewCamera,
  viewport: PreviewViewport,
  overscanPixels = 0,
): VisibleTileRange {
  const overscan = Math.max(0, overscanPixels);
  const corners = [
    { x: -overscan, y: -overscan },
    { x: viewport.width + overscan, y: -overscan },
    { x: viewport.width + overscan, y: viewport.height + overscan },
    { x: -overscan, y: viewport.height + overscan },
  ].map((point) => screenToMap(point, scene.width, scene.height, camera, viewport));
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  const scale = previewScale(scene.width, scene.height, camera, viewport);
  return {
    minimumX: clamp(Math.floor(Math.min(...xs)) - 1, 0, scene.width - 1),
    maximumX: clamp(Math.ceil(Math.max(...xs)) + 1, 0, scene.width - 1),
    minimumY: clamp(Math.floor(Math.min(...ys)) - 1, 0, scene.height - 1),
    maximumY: clamp(Math.ceil(Math.max(...ys)) + 1, 0, scene.height - 1),
    sampleStep:
      Math.SQRT2 * scale >= 1.5
        ? 1
        : 2 ** Math.min(4, Math.max(1, Math.ceil(Math.log2(1.5 / (Math.SQRT2 * scale))))),
  };
}

export function visibleChunks(
  range: VisibleTileRange,
  chunkSize = previewChunkSize,
): VisibleChunk[] {
  const chunks: VisibleChunk[] = [];
  const firstChunkX = Math.floor(range.minimumX / chunkSize);
  const lastChunkX = Math.floor(range.maximumX / chunkSize);
  const firstChunkY = Math.floor(range.minimumY / chunkSize);
  const lastChunkY = Math.floor(range.maximumY / chunkSize);
  for (let chunkY = firstChunkY; chunkY <= lastChunkY; chunkY += 1) {
    for (let chunkX = firstChunkX; chunkX <= lastChunkX; chunkX += 1) {
      chunks.push({
        minimumX: Math.max(range.minimumX, chunkX * chunkSize),
        maximumX: Math.min(range.maximumX, (chunkX + 1) * chunkSize - 1),
        minimumY: Math.max(range.minimumY, chunkY * chunkSize),
        maximumY: Math.min(range.maximumY, (chunkY + 1) * chunkSize - 1),
      });
    }
  }
  return chunks;
}

export function visibleTerrainChunks(
  range: VisibleTileRange,
  mapWidth: number,
  mapHeight: number,
  chunkSize = previewChunkSize,
): VisibleChunk[] {
  const chunks: VisibleChunk[] = [];
  const firstChunkX = Math.floor(range.minimumX / chunkSize);
  const lastChunkX = Math.floor(range.maximumX / chunkSize);
  const firstChunkY = Math.floor(range.minimumY / chunkSize);
  const lastChunkY = Math.floor(range.maximumY / chunkSize);
  for (let chunkY = firstChunkY; chunkY <= lastChunkY; chunkY += 1) {
    for (let chunkX = firstChunkX; chunkX <= lastChunkX; chunkX += 1) {
      chunks.push({
        minimumX: chunkX * chunkSize,
        maximumX: Math.min(mapWidth - 1, (chunkX + 1) * chunkSize - 1),
        minimumY: chunkY * chunkSize,
        maximumY: Math.min(mapHeight - 1, (chunkY + 1) * chunkSize - 1),
      });
    }
  }
  return chunks;
}

export function hitTestTopDownScene(
  scene: TopDownScene,
  camera: PreviewCamera,
  viewport: PreviewViewport,
  screenPoint: ScreenPoint,
): PreviewHit | null {
  const point = screenToMap(screenPoint, scene.width, scene.height, camera, viewport);
  if (point.x < 0 || point.x >= scene.width || point.y < 0 || point.y >= scene.height) return null;
  const x = Math.floor(point.x);
  const y = Math.floor(point.y);
  return { kind: 'tile', index: y * scene.width + x, x, y };
}

export function clampedTileAtScreenPoint(
  scene: Pick<TopDownScene, 'width' | 'height'>,
  camera: PreviewCamera,
  viewport: PreviewViewport,
  screenPoint: ScreenPoint,
): PreviewHit {
  const point = screenToMap(screenPoint, scene.width, scene.height, camera, viewport);
  const x = clamp(Math.floor(point.x), 0, scene.width - 1);
  const y = clamp(Math.floor(point.y), 0, scene.height - 1);
  return { kind: 'tile', index: y * scene.width + x, x, y };
}

export function rectangularSelectionFromDrag(
  start: Pick<PreviewHit, 'x' | 'y'>,
  end: Pick<PreviewHit, 'x' | 'y'>,
  mapWidth: number,
  mapHeight: number,
): PreviewSelection {
  const startX = clamp(Math.floor(start.x), 0, mapWidth - 1);
  const startY = clamp(Math.floor(start.y), 0, mapHeight - 1);
  const endX = clamp(Math.floor(end.x), 0, mapWidth - 1);
  const endY = clamp(Math.floor(end.y), 0, mapHeight - 1);
  return {
    minimumX: Math.min(startX, endX),
    maximumX: Math.max(startX, endX),
    minimumY: Math.min(startY, endY),
    maximumY: Math.max(startY, endY),
  };
}

export function selectionTileIndices(selection: PreviewSelection, mapWidth: number): number[] {
  const indices: number[] = [];
  for (let y = selection.minimumY; y <= selection.maximumY; y += 1) {
    for (let x = selection.minimumX; x <= selection.maximumX; x += 1) {
      indices.push(y * mapWidth + x);
    }
  }
  return indices;
}

export function selectionTileCount(selection: PreviewSelection): number {
  return (
    (selection.maximumX - selection.minimumX + 1) * (selection.maximumY - selection.minimumY + 1)
  );
}

export function mapScreenBounds(
  scene: Pick<TopDownScene, 'width' | 'height'>,
  camera: PreviewCamera,
  viewport: PreviewViewport,
): { left: number; right: number; top: number; bottom: number } {
  const corners = [
    { x: 0, y: 0 },
    { x: scene.width, y: 0 },
    { x: scene.width, y: scene.height },
    { x: 0, y: scene.height },
  ].map((point) => mapToScreen(point, scene.width, scene.height, camera, viewport));
  return {
    left: Math.min(...corners.map((point) => point.x)),
    right: Math.max(...corners.map((point) => point.x)),
    top: Math.min(...corners.map((point) => point.y)),
    bottom: Math.max(...corners.map((point) => point.y)),
  };
}

export function zoneDiagnosticColor(zone: number): number {
  const mixed = Math.imul(zone ^ 0x9e37_79b9, 0x85eb_ca6b) >>> 0;
  return ((mixed >>> 8) & 0x7f_7f_7f) | 0x40_40_40;
}

const littleEndianPlatform = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

type ColumnArray = Uint16Array | Int16Array | Uint32Array | Int32Array;

function decodeColumn(
  bytes: Uint8Array,
  type: { new (buffer: ArrayBuffer, offset: number, length: number): ColumnArray },
  width: 2 | 4,
  read: (view: DataView, offset: number) => number,
  count: number,
  label: string,
): number[] {
  if (bytes.byteLength !== count * width) throw new Error(`${label} have an invalid length`);
  const values = new Array<number>(count);
  if (
    littleEndianPlatform &&
    bytes.byteOffset % width === 0 &&
    bytes.buffer instanceof ArrayBuffer
  ) {
    const view = new type(bytes.buffer, bytes.byteOffset, count);
    for (let index = 0; index < count; index += 1) values[index] = view[index]!;
    return values;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < count; index += 1) values[index] = read(view, index * width);
  return values;
}

function decodeUnsigned(bytes: Uint8Array, width: 2 | 4, count: number, label: string): number[] {
  return width === 2
    ? decodeColumn(
        bytes,
        Uint16Array,
        2,
        (view, offset) => view.getUint16(offset, true),
        count,
        label,
      )
    : decodeColumn(
        bytes,
        Uint32Array,
        4,
        (view, offset) => view.getUint32(offset, true),
        count,
        label,
      );
}

function decodeSigned16(bytes: Uint8Array, count: number, label: string): number[] {
  return decodeColumn(
    bytes,
    Int16Array,
    2,
    (view, offset) => view.getInt16(offset, true),
    count,
    label,
  );
}

function decodeSigned32(bytes: Uint8Array, count: number, label: string): number[] {
  return decodeColumn(
    bytes,
    Int32Array,
    4,
    (view, offset) => view.getInt32(offset, true),
    count,
    label,
  );
}

function decodeCliffs(bytes: Uint8Array, width: number, height: number): TopDownCliff[] {
  if (bytes.byteLength % 12 !== 0) throw new Error('cliff columns have an invalid length');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: bytes.byteLength / 12 }, (_, index) => {
    const offset = index * 12;
    const cliff = {
      from: { x: view.getUint16(offset, true), y: view.getUint16(offset + 2, true) },
      to: { x: view.getUint16(offset + 4, true), y: view.getUint16(offset + 6, true) },
      cliffType: view.getUint32(offset + 8, true),
    };
    if (
      !mapPointIsBounded(cliff.from, width, height) ||
      !mapPointIsBounded(cliff.to, width, height)
    ) {
      throw new Error('cliff coordinate is outside the map');
    }
    return cliff;
  });
}

function decodeConnections(
  map: PreviewGenerationResult,
  width: number,
  height: number,
): TopDownConnection[] {
  const count = map.connections.kinds.byteLength;
  const startX = decodeUnsigned(map.connections.startXLe, 2, count, 'connection start X');
  const startY = decodeUnsigned(map.connections.startYLe, 2, count, 'connection start Y');
  const endX = decodeUnsigned(map.connections.endXLe, 2, count, 'connection end X');
  const endY = decodeUnsigned(map.connections.endYLe, 2, count, 'connection end Y');
  return Array.from({ length: count }, (_, index) => {
    const start = { x: startX[index]!, y: startY[index]! };
    const end = { x: endX[index]!, y: endY[index]! };
    if (!mapPointIsBounded(start, width, height) || !mapPointIsBounded(end, width, height)) {
      throw new Error('connection coordinate is outside the map');
    }
    return {
      start,
      end,
      kind: (['land', 'water', 'road'] as const)[map.connections.kinds[index]!] ?? 'unknown',
    };
  });
}

function decodeObjects(
  map: PreviewGenerationResult,
  width: number,
  height: number,
): TopDownObject[] {
  const count = map.objects.owners.byteLength;
  const ids = decodeUnsigned(map.objects.idsLe, 4, count, 'object IDs');
  const xs = decodeUnsigned(map.objects.xLe, 4, count, 'object X coordinates');
  const ys = decodeUnsigned(map.objects.yLe, 4, count, 'object Y coordinates');
  const facets = decodeUnsigned(map.objects.facetsLe, 2, count, 'object facets');
  const footprintWidths = decodeUnsigned(
    map.objects.footprintWidths256Le,
    2,
    count,
    'object footprint widths',
  );
  const footprintHeights = decodeUnsigned(
    map.objects.footprintHeights256Le,
    2,
    count,
    'object footprint heights',
  );
  const resourceType = decodeSigned16(map.objects.resourceTypeLe, count, 'object resource types');
  const resourceQuantities = decodeUnsigned(
    map.objects.resourceQuantityF32BitsLe,
    4,
    count,
    'object resource quantity bits',
  );
  const resourceDeltas = decodeSigned32(
    map.objects.resourceDeltasLe,
    count,
    'object resource deltas',
  );
  const statuses = decodeUnsigned(map.objects.statusesLe, 4, count, 'object statuses');
  const dataStatuses = decodeUnsigned(map.objects.dataStatusesLe, 2, count, 'object data statuses');
  const behaviorFlags = decodeUnsigned(
    map.objects.behaviorFlagsLe,
    2,
    count,
    'object behavior flags',
  );
  if (
    map.objects.presentationKinds.byteLength !== count ||
    map.objects.deathStates.byteLength !== count ||
    map.objects.selectionFlags.byteLength !== count
  ) {
    throw new Error('object byte columns have an invalid length');
  }
  return Array.from({ length: count }, (_, index) => {
    const x = xs[index]! / 256;
    const y = ys[index]! / 256;
    if (x < 0 || x > width || y < 0 || y > height) {
      throw new Error('object coordinate is outside the map');
    }
    return {
      index,
      objectId: ids[index]!,
      x,
      y,
      owner: map.objects.owners[index]!,
      facet: facets[index]!,
      footprintWidth: Math.max(1, footprintWidths[index]!) / 256,
      footprintHeight: Math.max(1, footprintHeights[index]!) / 256,
      presentationKind: map.objects.presentationKinds[index] === 1 ? 'wall' : 'object',
      resourceType: resourceType[index]!,
      resourceQuantityF32Bits: resourceQuantities[index]!,
      resourceDelta: resourceDeltas[index]!,
      status: statuses[index]!,
      deathState: map.objects.deathStates[index]!,
      dataStatus: dataStatuses[index]!,
      selectionFlags: map.objects.selectionFlags[index]!,
      behaviorFlags: behaviorFlags[index]!,
    };
  });
}

function mapPointIsBounded(point: MapPoint, width: number, height: number): boolean {
  return point.x >= 0 && point.x < width && point.y >= 0 && point.y < height;
}

function clampRangeCenter(
  value: number,
  minimum: number,
  maximum: number,
  halfVisible: number,
): number {
  if (halfVisible >= (maximum - minimum) / 2) return (minimum + maximum) / 2;
  return clamp(value, minimum + halfVisible, maximum - halfVisible);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
