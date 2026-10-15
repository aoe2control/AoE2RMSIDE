import type { SelectedMinimapPalette } from '../shared/api';
import { litColor, type ElevationSurface } from './preview-elevation';
import { MarkerMeshBuilder, OrderedMarkerLayer } from './preview-marker-mesh';
import {
  hasVisiblePreviewFootprint,
  isDrawnPreviewObject,
  markerShapeOutline,
  objectMaterial,
  type PreviewMaterial,
  type PreviewObjectVisibility,
} from './preview-materials';
import { heightMapObjectLightAt, type ElevationRange } from './preview-terrain-mesh';
import {
  diamondBasisComponent,
  mapRectangleScreenPolygon,
  previewAppearanceMarkerMinimumRadius,
  previewLevelPixels,
  previewMarkerScreenRadius,
  previewMarkerVerticalScale,
  previewObjectFootprintSpan,
  previewObjectMarkerRadiusBase,
  previewObjectMarkerScreenRadius,
  previewObjectMarkerSpan,
  previewProjectionVerticalScale,
  previewScale,
  type PreviewCamera,
  type PreviewViewport,
  type TopDownScene,
} from './top-down-preview';

export interface DrawnObjectMarkers {
  helpers: number;
  objects: number;
  radiusRange: string;
  culled: boolean;
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
  const drawn: DrawnObjectMarkers = { helpers: 0, objects: 0, radiusRange: '', culled: false };
  if (!visibility.objects) return drawn;
  const layer = new OrderedMarkerLayer(stage);
  const marks = layer.marks;
  const scale = previewScale(scene.width, scene.height, camera, viewport);
  const component = scale * diamondBasisComponent;
  const verticalComponent = component * previewProjectionVerticalScale(viewport);
  const halfWidth = viewport.width / 2;
  const halfHeight = viewport.height / 2;
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
    const outlined = hasVisiblePreviewFootprint(object);
    let footprint: number[] | null = null;
    if (
      outlined ||
      !(
        centerX > insideLeft &&
        centerX < insideRight &&
        centerY > insideTop &&
        centerY < insideBottom
      )
    ) {
      footprint = objectFootprint(object, scene, camera, viewport, offsetX, offsetY - lift);
      if (footprintCulled(footprint, viewport, cullMargin)) {
        drawn.culled = true;
        continue;
      }
    }
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
    const color = heightMap
      ? litColor(material.color, heightMapObjectLightAt(scene, object.x, object.y, heightMap))
      : material.color;
    const span = previewObjectMarkerSpan(object);
    const minimum = object.appearance
      ? previewAppearanceMarkerMinimumRadius
      : previewMarkerScreenRadius.minimum;
    const radius = previewObjectMarkerScreenRadius(scale, span, minimum);
    minimumRadius = Math.min(minimumRadius, radius);
    maximumRadius = Math.max(maximumRadius, radius);
    const radiusBase = previewObjectMarkerRadiusBase(scale, span);
    if (material.helper) {
      drawn.helpers += 1;
      marks.anchor(
        mapX,
        mapY,
        centerX,
        centerY,
        radiusBase,
        minimum,
        previewMarkerScreenRadius.maximum,
      );
      drawMarker(marks, centerX, centerY, radius, material, color, 'outline', verticalScale);
      continue;
    }
    drawn.objects += 1;
    if (outlined && footprint) {
      marks.anchor(mapX, mapY, centerX, centerY, 1, 0, Number.POSITIVE_INFINITY);
      marks.stroke(footprint, true, { color, width: 1, alpha: 1 });
    }
    marks.anchor(
      mapX,
      mapY,
      centerX,
      centerY,
      radiusBase,
      minimum,
      previewMarkerScreenRadius.maximum,
    );
    drawMarker(marks, centerX, centerY, radius, material, color, 'fill', verticalScale);
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
  if (material.shape === 'double-line') {
    const wallGap = Math.min(2, Math.max(1, radius * 0.5)) * verticalScale;
    marks.stroke([x - radius, y - wallGap, x + radius, y - wallGap], false, {
      color,
      width: style === 'outline' ? 1 : 2,
      alpha: 1,
    });
    marks.stroke([x - radius, y + wallGap, x + radius, y + wallGap], false, {
      color,
      width: 1,
      alpha: 1,
    });
    return;
  }
  const outline = markerShapeOutline(material.shape);
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
