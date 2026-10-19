import type { SelectedMinimapPalette } from '../shared/api';
import { litColor, type ElevationSurface } from './preview-elevation';
import { MarkerMeshBuilder, OrderedMarkerLayer } from './preview-marker-mesh';
import {
  isDrawnPreviewObject,
  markerShapeOutline,
  objectMaterial,
  type AtomicShape,
  type PreviewMaterial,
  type PreviewObjectVisibility,
} from './preview-materials';
import { heightMapObjectLightAt, type ElevationRange } from './preview-terrain-mesh';
import {
  isStraightWallRun,
  previewWallPostHalfWidth,
  previewWallStrokeWidth,
  sceneWallJoins,
  wallJoinDirections,
  wallPostPolygon,
} from './preview-wall-joins';
import {
  diamondBasisComponent,
  mapRectangleScreenPolygon,
  previewAppearanceMarkerMinimumRadius,
  previewLevelPixels,
  previewMarkerScreenRadius,
  previewMarkerVerticalScale,
  previewObjectFootprintSpan,
  previewObjectMarkerRadiusBase,
  previewObjectMarkerSpan,
  previewProjectionVerticalScale,
  previewScale,
  previewViewCenter,
  type PreviewCamera,
  type PreviewViewport,
  type TopDownScene,
} from './top-down-preview';

export interface DrawnObjectMarkers {
  helpers: number;
  objects: number;
  radiusRange: string;
  culled: boolean;
  wallJoins: number;
}

export function drawObjects(
  stage: OrderedMarkerLayerStage,
  scene: TopDownScene,
  camera: PreviewCamera,
  viewport: PreviewViewport,
  visibility: PreviewObjectVisibility,
  playerColorIds: readonly number[] = [],
  minimapPalette: SelectedMinimapPalette | null = null,
  maximumObjects = Number.POSITIVE_INFINITY,
  spriteObjects: ReadonlySet<number> = new Set(),
  lookObjectColors?: ReadonlyMap<number, number>,
  cullMargin: { x: number; y: number } = { x: 0, y: 0 },
  surface: ElevationSurface | null = null,
  heightMap: ElevationRange | null = null,
): DrawnObjectMarkers {
  const drawn: DrawnObjectMarkers = {
    helpers: 0,
    objects: 0,
    radiusRange: '',
    culled: false,
    wallJoins: 0,
  };
  if (!visibility.objects) return drawn;
  const layer = new OrderedMarkerLayer(stage);
  const marks = layer.marks;
  const scale = previewScale(scene.width, scene.height, camera, viewport);
  const component = scale * diamondBasisComponent;
  const verticalComponent = component * previewProjectionVerticalScale(viewport);
  const { x: halfWidth, y: halfHeight } = previewViewCenter(viewport);
  const verticalScale = previewMarkerVerticalScale(viewport);
  const levelPixels = surface ? previewLevelPixels(scene.width, scene.height, camera, viewport) : 0;
  const rowKeys = scene.width + 1;
  const colocatedOrdinals = new Uint32Array(rowKeys * (scene.height + 1));
  const strayOrdinals = new Map<number, number>();
  const insideLeft = -cullMargin.x + footprintCullTolerance;
  const insideTop = -cullMargin.y + footprintCullTolerance;
  const insideRight = viewport.width + cullMargin.x - footprintCullTolerance;
  const insideBottom = viewport.height + cullMargin.y - footprintCullTolerance;
  const materials = new Map<number, PreviewMaterial>();
  let joins: Map<number, number> | null = null;
  let minimumRadius = Number.POSITIVE_INFINITY;
  let maximumRadius = 0;
  marks.setOffsetLaw({ base: scale * 0.16, minimum: 2, maximum: 8 });
  const objects = scene.objects;
  const objectCount = Math.min(objects.length, maximumObjects);
  for (let objectIndex = 0; objectIndex < objectCount; objectIndex += 1) {
    const object = objects[objectIndex]!;
    if (!isDrawnPreviewObject(object, visibility)) continue;
    if (spriteObjects.has(object.index)) continue;
    const tileKey = Math.floor(object.y) * rowKeys + Math.floor(object.x);
    let colocatedOrdinal: number;
    if (tileKey >= 0 && tileKey < colocatedOrdinals.length && Number.isInteger(tileKey)) {
      colocatedOrdinal = colocatedOrdinals[tileKey]!;
      colocatedOrdinals[tileKey] = colocatedOrdinal + 1;
    } else {
      colocatedOrdinal = strayOrdinals.get(tileKey) ?? 0;
      strayOrdinals.set(tileKey, colocatedOrdinal + 1);
    }
    const relativeX = object.x - camera.centerX;
    const relativeY = object.y - camera.centerY;
    let centerX = halfWidth + (relativeX + relativeY) * component;
    let centerY = halfHeight + (relativeY - relativeX) * verticalComponent;
    const lift = surface ? surface.heightAt(object.x, object.y) * levelPixels : 0;
    centerY -= lift;
    const reach =
      previewMarkerScreenRadius.maximum +
      scale * Math.max(1, object.footprintWidth, object.footprintHeight);
    if (
      centerX < -reach - cullMargin.x ||
      centerY < -reach - cullMargin.y ||
      centerX > viewport.width + reach + cullMargin.x ||
      centerY > viewport.height + reach + cullMargin.y
    ) {
      drawn.culled = true;
      continue;
    }
    let offsetX = 0;
    let offsetY = 0;
    if (colocatedOrdinal > 0) {
      const angle = (colocatedOrdinal - 1) * 2.399963229728653;
      const distance = Math.min(Math.max(2, scale * 0.16), 8) * Math.ceil(colocatedOrdinal / 6);
      offsetX = Math.cos(angle) * distance;
      offsetY = Math.sin(angle) * distance;
    }
    offsetY *= verticalScale;
    const mapX = centerX;
    const mapY = centerY;
    centerX += offsetX;
    centerY += offsetY;
    const materialKey =
      (object.objectId * 256 + (object.owner & 0xff)) * 2 +
      (object.presentationKind === 'wall' ? 1 : 0);
    let material = materials.get(materialKey);
    if (!material) {
      material = objectMaterial(
        object,
        playerColorIds,
        [],
        minimapPalette,
        undefined,
        visibility.helperObjectIds,
        lookObjectColors,
      );
      materials.set(materialKey, material);
    }
    const style = material.helper ? 'outline' : 'fill';
    if (material.shape === 'wall') {
      joins ??= sceneWallJoins(scene, (candidate) => isDrawnPreviewObject(candidate, visibility), [
        visibility.objects,
        visibility.helpers,
        visibility.helperObjectIds,
        visibility.decorations === true,
      ]);
      const bits = joins.get(objectIndex) ?? 0;
      const color = heightMap
        ? litColor(material.color, heightMapObjectLightAt(scene, object.x, object.y, heightMap))
        : material.color;
      if (material.helper) drawn.helpers += 1;
      else drawn.objects += 1;
      drawn.wallJoins += drawWallPiece(
        marks,
        wallPieceGeometry(
          object,
          bits,
          mapX,
          mapY,
          component,
          verticalComponent,
          scale,
          surface ? (x, y) => surface.heightAt(x, y) * levelPixels : null,
        ),
        mapX,
        mapY,
        color,
        style,
      );
      continue;
    }
    if (isFootprintShape(material.shape)) {
      const footprint = footprintMarker(
        object,
        component,
        verticalComponent,
        centerX,
        centerY,
        scale,
      );
      if (footprintCulled(footprint.polygon, viewport, cullMargin)) {
        drawn.culled = true;
        continue;
      }
      const color = heightMap
        ? litColor(material.color, heightMapObjectLightAt(scene, object.x, object.y, heightMap))
        : material.color;
      if (material.helper) drawn.helpers += 1;
      else drawn.objects += 1;
      marks.anchor(
        mapX,
        mapY,
        centerX,
        centerY,
        footprint.base,
        footprint.minimum,
        Number.POSITIVE_INFINITY,
      );
      drawFootprintMarker(marks, footprint, material.shape, color, style);
      continue;
    }
    if (
      !(
        centerX > insideLeft &&
        centerX < insideRight &&
        centerY > insideTop &&
        centerY < insideBottom
      ) &&
      footprintCulled(
        objectFootprint(object, scene, camera, viewport, offsetX, offsetY - lift),
        viewport,
        cullMargin,
      )
    ) {
      drawn.culled = true;
      continue;
    }
    const color = heightMap
      ? litColor(material.color, heightMapObjectLightAt(scene, object.x, object.y, heightMap))
      : material.color;
    const span = previewObjectMarkerSpan(object);
    const factor = material.shape === 'crown' && !object.appearance ? crownScale : 1;
    const minimum =
      (object.appearance
        ? previewAppearanceMarkerMinimumRadius
        : previewMarkerScreenRadius.minimum) * factor;
    const maximum = previewMarkerScreenRadius.maximum * factor;
    const radiusBase = previewObjectMarkerRadiusBase(scale, span) * factor;
    const radius = Math.min(Math.max(radiusBase, minimum), maximum);
    minimumRadius = Math.min(minimumRadius, radius);
    maximumRadius = Math.max(maximumRadius, radius);
    if (material.helper) drawn.helpers += 1;
    else drawn.objects += 1;
    marks.anchor(mapX, mapY, centerX, centerY, radiusBase, minimum, maximum);
    drawMarker(marks, centerX, centerY, radius, material, color, style, verticalScale);
  }
  layer.finish();
  if (maximumRadius > 0) {
    drawn.radiusRange = `${minimumRadius.toFixed(2)},${maximumRadius.toFixed(2)}`;
  }
  return drawn;
}

export type OrderedMarkerLayerStage = ConstructorParameters<typeof OrderedMarkerLayer>[0];

const footprintCullTolerance = 1e-6;

export function objectHeightMapLight(
  scene: Pick<TopDownScene, 'width' | 'height' | 'elevations'>,
  object: { x: number; y: number },
  range: ElevationRange,
): number {
  return heightMapObjectLightAt(scene, object.x, object.y, range);
}

export const crownScale = 1.25;

export function isFootprintShape(shape: AtomicShape): shape is 'building' | 'farm' {
  return shape === 'building' || shape === 'farm';
}

export interface FootprintMarker {
  polygon: number[];
  inset: number[] | null;
  base: number;
  minimum: number;
}

export const buildingInsetMinimumBase = 6;

export function footprintMarker(
  object: Pick<TopDownScene['objects'][number], 'footprintWidth' | 'footprintHeight'>,
  component: number,
  verticalComponent: number,
  centerX: number,
  centerY: number,
  scale: number,
): FootprintMarker {
  const width = previewObjectFootprintSpan(object.footprintWidth);
  const height = previewObjectFootprintSpan(object.footprintHeight);
  const base = previewObjectMarkerRadiusBase(scale, Math.min(width, height));
  const minimum = previewMarkerScreenRadius.minimum;
  const grow = base > 0 && base < minimum ? minimum / base : 1;
  const rectangle = (halfWidth: number, halfHeight: number) => {
    const points: number[] = [];
    for (const [signX, signY] of footprintCorners) {
      const deltaX = signX * halfWidth * grow;
      const deltaY = signY * halfHeight * grow;
      points.push(
        centerX + (deltaX + deltaY) * component,
        centerY + (deltaY - deltaX) * verticalComponent,
      );
    }
    return points;
  };
  const inset = Math.min(width, height) / 8;
  return {
    polygon: rectangle(width / 2, height / 2),
    inset:
      grow === 1 && base >= buildingInsetMinimumBase
        ? rectangle(width / 2 - inset, height / 2 - inset)
        : null,
    base,
    minimum,
  };
}

const footprintCorners: readonly (readonly [number, number])[] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

export const farmFill = Object.freeze({ lighten: 0.3, alpha: 0.65 });

export const buildingInsetLighten = 0.45;

export function drawFootprintMarker(
  marks: MarkerMeshBuilder,
  footprint: FootprintMarker,
  shape: 'building' | 'farm',
  color: number,
  style: 'fill' | 'outline',
): void {
  if (style === 'outline') {
    marks.stroke(footprint.polygon, true, { color, width: 1, alpha: 0.75 });
    return;
  }
  if (shape === 'farm') {
    marks.polygon(footprint.polygon, mixColor(color, 0xffffff, farmFill.lighten), farmFill.alpha);
    return;
  }
  marks.polygon(footprint.polygon, color);
  if (footprint.inset) {
    marks.stroke(footprint.inset, true, {
      color: mixColor(color, 0xffffff, buildingInsetLighten),
      width: 1,
      alpha: 1,
    });
  }
}

export interface WallPieceGeometry {
  lines: number[][];
  post: number[] | null;
  postHalfWidth: number;
  strokeWidth: number;
  joins: number;
  cap: 'butt' | 'square';
}

export function wallPieceGeometry(
  object: Pick<TopDownScene['objects'][number], 'x' | 'y'>,
  bits: number,
  centerX: number,
  centerY: number,
  component: number,
  verticalComponent: number,
  scale: number,
  liftAt: ((x: number, y: number) => number) | null = null,
): WallPieceGeometry {
  const tileX = Math.floor(object.x) + 0.5;
  const tileY = Math.floor(object.y) + 0.5;
  const centerLift = liftAt ? liftAt(object.x, object.y) : 0;
  const ends: number[][] = [];
  for (const { dx, dy, bit } of wallJoinDirections) {
    if ((bits & bit) === 0) continue;
    const endX = tileX + dx * 0.5;
    const endY = tileY + dy * 0.5;
    const relativeX = endX - object.x;
    const relativeY = endY - object.y;
    const lift = liftAt ? liftAt(endX, endY) - centerLift : 0;
    ends.push([
      centerX + (relativeX + relativeY) * component,
      centerY + (relativeY - relativeX) * verticalComponent - lift,
    ]);
  }
  const lines = isStraightWallRun(bits)
    ? [[ends[0]![0]!, ends[0]![1]!, centerX, centerY, ends[1]![0]!, ends[1]![1]!]]
    : ends.map(([endX, endY]) => [centerX, centerY, endX!, endY!]);
  const strokeWidth = previewWallStrokeWidth(scale);
  const postHalfWidth = previewWallPostHalfWidth(bits, strokeWidth, scale);
  return {
    lines,
    post:
      postHalfWidth > 0
        ? wallPostPolygon(centerX, centerY, postHalfWidth, component, verticalComponent)
        : null,
    postHalfWidth,
    strokeWidth,
    joins: ends.length,
    cap: liftAt ? 'square' : 'butt',
  };
}

export function drawWallPiece(
  marks: MarkerMeshBuilder,
  piece: WallPieceGeometry,
  mapX: number,
  mapY: number,
  color: number,
  style: 'fill' | 'outline',
): number {
  const helper = style === 'outline';
  marks.anchor(mapX, mapY, mapX, mapY, 1, 0, Number.POSITIVE_INFINITY);
  for (const line of piece.lines) {
    marks.stroke(line, false, {
      color,
      width: helper ? 1 : piece.strokeWidth,
      alpha: helper ? 0.75 : 1,
      cap: piece.cap,
    });
  }
  if (piece.post) {
    const half = piece.postHalfWidth;
    marks.anchor(mapX, mapY, mapX, mapY, half, half, half);
    if (helper) marks.stroke(piece.post, true, { color, width: 1, alpha: 0.75 });
    else marks.polygon(piece.post, color);
  }
  return piece.joins;
}

export function mixColor(color: number, target: number, amount: number): number {
  let mixed = 0;
  for (const shift of [16, 8, 0]) {
    const from = (color >> shift) & 0xff;
    const to = (target >> shift) & 0xff;
    mixed |= Math.round(from + (to - from) * amount) << shift;
  }
  return mixed >>> 0;
}

function objectFootprint(
  object: TopDownScene['objects'][number],
  scene: TopDownScene,
  camera: PreviewCamera,
  viewport: PreviewViewport,
  offsetX: number,
  offsetY: number,
): number[] {
  const footprintWidth = previewObjectFootprintSpan(object.footprintWidth);
  const footprintHeight = previewObjectFootprintSpan(object.footprintHeight);
  const footprint = mapRectangleScreenPolygon(
    { x: object.x - footprintWidth / 2, y: object.y - footprintHeight / 2 },
    { x: object.x + footprintWidth / 2, y: object.y + footprintHeight / 2 },
    scene.width,
    scene.height,
    camera,
    viewport,
  );
  for (let index = 0; index < footprint.length; index += 1) {
    footprint[index] = footprint[index]! + (index % 2 === 0 ? offsetX : offsetY);
  }
  return footprint;
}

function footprintCulled(
  footprint: readonly number[],
  viewport: PreviewViewport,
  cullMargin: { x: number; y: number },
): boolean {
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < footprint.length; index += 2) {
    const x = footprint[index]!;
    const y = footprint[index + 1]!;
    if (x < left) left = x;
    if (x > right) right = x;
    if (y < top) top = y;
    if (y > bottom) bottom = y;
  }
  return (
    right < -cullMargin.x ||
    left > viewport.width + cullMargin.x ||
    bottom < -cullMargin.y ||
    top > viewport.height + cullMargin.y
  );
}

export const clusterDots: readonly (readonly [number, number])[] = [
  [0, -0.5],
  [0.433, 0.25],
  [-0.433, 0.25],
];

export const clusterMinimumRadius = 3;

export const clusterBlob = Object.freeze({ offsetY: -0.125, radiusX: 0.933, radiusY: 0.875 });

export function drawMarker(
  marks: MarkerMeshBuilder,
  x: number,
  y: number,
  radius: number,
  material: Pick<PreviewMaterial, 'shape'>,
  color: number,
  style: 'fill' | 'outline',
  verticalScale: number,
): void {
  if (material.shape === 'cluster' && radius < clusterMinimumRadius) {
    const blobY = y + clusterBlob.offsetY * radius * verticalScale;
    const blobX = clusterBlob.radiusX * radius;
    const blobHeight = clusterBlob.radiusY * radius * verticalScale;
    if (style === 'outline') {
      marks.strokeEllipse(x, blobY, blobX, blobHeight, { color, width: 1, alpha: 0.75 });
    } else {
      marks.ellipse(x, blobY, blobX, blobHeight, color);
    }
    return;
  }
  if (material.shape === 'cluster') {
    const dot = radius * 0.5;
    for (const [unitX, unitY] of clusterDots) {
      const dotX = x + unitX * radius;
      const dotY = y + unitY * radius * verticalScale;
      if (style === 'outline') {
        marks.strokeEllipse(dotX, dotY, dot, dot * verticalScale, {
          color,
          width: 1,
          alpha: 0.75,
        });
      } else {
        marks.ellipse(dotX, dotY, dot, dot * verticalScale, color);
      }
    }
    return;
  }
  const outline = markerShapeOutline(
    isFootprintShape(material.shape) || material.shape === 'wall' ? 'square' : material.shape,
  );
  if (style === 'outline') {
    const stroke = { color, width: 1, alpha: 0.75 };
    if (!outline) {
      marks.strokeEllipse(x, y, radius, radius * verticalScale, stroke);
      return;
    }
    marks.stroke(
      outline.map((value, index) =>
        index % 2 === 0 ? x + value * radius : y + value * radius * verticalScale,
      ),
      true,
      stroke,
    );
    return;
  }
  if (!outline) {
    marks.ellipse(x, y, radius, radius * verticalScale, color);
    return;
  }
  marks.outline(outline, x, y, radius, verticalScale, color);
}
