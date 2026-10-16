import { Rectangle, type Application, type Container } from 'pixi.js';
import {
  exportImageSizeAllowed,
  maximumExportImagePixels,
  maximumExportImageSide,
  type ExportImagePixels,
} from '../shared/image-export';
import {
  mapToScreen,
  previewLevelPixels,
  type PreviewCamera,
  type PreviewViewport,
  type ScreenPoint,
} from './top-down-preview';

export function snapPixel(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export interface PixelCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function previewMapOutline(
  scene: { width: number; height: number },
  camera: PreviewCamera,
  viewport: PreviewViewport,
  lift: { minimum: number; maximum: number } | null = null,
): ScreenPoint[] {
  const corners = [
    { x: 0, y: 0 },
    { x: scene.width, y: 0 },
    { x: scene.width, y: scene.height },
    { x: 0, y: scene.height },
  ].map((point) => mapToScreen(point, scene.width, scene.height, camera, viewport));
  if (!lift) return corners;
  const level = previewLevelPixels(scene.width, scene.height, camera, viewport);
  const shifts = [Math.min(0, lift.minimum), Math.max(0, lift.maximum)].map(
    (height) => -height * level,
  );
  return convexHull(
    corners.flatMap((corner) => shifts.map((shift) => ({ x: corner.x, y: corner.y + shift }))),
  );
}

export function clipPolygonToRectangle(
  polygon: readonly ScreenPoint[],
  width: number,
  height: number,
): ScreenPoint[] {
  const edges: ((point: ScreenPoint) => number)[] = [
    (point) => point.x,
    (point) => width - point.x,
    (point) => point.y,
    (point) => height - point.y,
  ];
  let output = [...polygon];
  for (const inside of edges) {
    const input = output;
    output = [];
    for (let index = 0; index < input.length; index += 1) {
      const current = input[index]!;
      const previous = input[(index + input.length - 1) % input.length]!;
      const currentSide = inside(current);
      const previousSide = inside(previous);
      if (currentSide >= 0) {
        if (previousSide < 0)
          output.push(intersection(previous, current, previousSide, currentSide));
        output.push(current);
      } else if (previousSide >= 0) {
        output.push(intersection(previous, current, previousSide, currentSide));
      }
    }
    if (output.length === 0) return [];
  }
  return output;
}

export interface ScreenBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function previewImageCrop(
  outline: readonly ScreenPoint[],
  viewportWidth: number,
  viewportHeight: number,
  frameWidth: number,
  frameHeight: number,
  include: ScreenBox | null = null,
): PixelCrop | null {
  if (viewportWidth <= 0 || viewportHeight <= 0 || frameWidth < 1 || frameHeight < 1) return null;
  const visible = clipPolygonToRectangle(outline, viewportWidth, viewportHeight);
  if (visible.length < 3) return null;
  let minimumX = Math.min(...visible.map((point) => point.x));
  let minimumY = Math.min(...visible.map((point) => point.y));
  let maximumX = Math.max(...visible.map((point) => point.x));
  let maximumY = Math.max(...visible.map((point) => point.y));
  if (include) {
    const left = Math.max(0, include.left);
    const top = Math.max(0, include.top);
    const right = Math.min(viewportWidth, include.right);
    const bottom = Math.min(viewportHeight, include.bottom);
    if (right > left && bottom > top) {
      minimumX = Math.min(minimumX, left);
      minimumY = Math.min(minimumY, top);
      maximumX = Math.max(maximumX, right);
      maximumY = Math.max(maximumY, bottom);
    }
  }
  const scaleX = frameWidth / viewportWidth;
  const scaleY = frameHeight / viewportHeight;
  const frameRight = Math.floor(snapPixel(frameWidth));
  const frameBottom = Math.floor(snapPixel(frameHeight));
  const left = Math.max(0, Math.floor(snapPixel(minimumX * scaleX)));
  const top = Math.max(0, Math.floor(snapPixel(minimumY * scaleY)));
  const right = Math.min(frameRight, Math.ceil(snapPixel(maximumX * scaleX)));
  const bottom = Math.min(frameBottom, Math.ceil(snapPixel(maximumY * scaleY)));
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function previewCanvasResolution(
  canvasWidth: number,
  screenWidth: number,
  rendererResolution: number,
): number {
  return canvasWidth > 0 && screenWidth > 0 ? canvasWidth / screenWidth : rendererResolution;
}

export function previewImageResolution(
  canvasResolution: number,
  cropWidth: number,
  cropHeight: number,
): number {
  if (cropWidth <= 0 || cropHeight <= 0) return canvasResolution;
  const bySide = (maximumExportImageSide - 1) / Math.max(cropWidth, cropHeight);
  const byArea = Math.sqrt(maximumExportImagePixels / ((cropWidth + 1) * (cropHeight + 1)));
  return Math.min(canvasResolution, bySide, byArea);
}

export function cropUnpremultipliedRgba(
  pixels: Uint8Array | Uint8ClampedArray,
  frameWidth: number,
  crop: PixelCrop,
): Uint8ClampedArray {
  const output = new Uint8ClampedArray(crop.width * crop.height * 4);
  for (let row = 0; row < crop.height; row += 1) {
    const source = ((crop.y + row) * frameWidth + crop.x) * 4;
    output.set(pixels.subarray(source, source + crop.width * 4), row * crop.width * 4);
  }
  for (let index = 0; index < output.length; index += 4) {
    const alpha = output[index + 3]!;
    if (alpha === 255) continue;
    if (alpha === 0) {
      output[index] = 0;
      output[index + 1] = 0;
      output[index + 2] = 0;
      continue;
    }
    for (let channel = 0; channel < 3; channel += 1) {
      output[index + channel] = Math.round((output[index + channel]! * 255) / alpha);
    }
  }
  return output;
}

export interface RightPress {
  x: number;
  y: number;
  travelled: number;
}

export const rightClickMenuSlop = 4;

export function moveRightPress(press: RightPress, x: number, y: number): RightPress {
  const distance = Math.hypot(x - press.x, y - press.y);
  return distance > press.travelled ? { ...press, travelled: distance } : press;
}

export function rightClickOpensMenu(press: RightPress | null, x: number, y: number): boolean {
  if (!press) return false;
  return moveRightPress(press, x, y).travelled <= rightClickMenuSlop;
}

export interface PreviewImageSource {
  application: Application;
  scene: { width: number; height: number };
  camera: PreviewCamera;
  viewport: PreviewViewport;
  lift: { minimum: number; maximum: number } | null;
  transient: Iterable<Container>;
  selection: Container | null;
}

export interface CaptureLayer {
  visible: boolean;
  alpha: number;
  readonly destroyed: boolean;
}

export function prepareCaptureLayers(
  transient: Iterable<CaptureLayer>,
  kept: CaptureLayer | null,
): () => void {
  const hidden: CaptureLayer[] = [];
  for (const layer of transient) {
    if (layer.destroyed || !layer.visible || layer === kept) continue;
    layer.visible = false;
    hidden.push(layer);
  }
  const keptAlpha = kept && !kept.destroyed ? kept.alpha : null;
  if (kept && keptAlpha !== null) kept.alpha = 1;
  return () => {
    for (const layer of hidden) layer.visible = true;
    if (kept && keptAlpha !== null && !kept.destroyed) kept.alpha = keptAlpha;
  };
}

export function previewSelectionBox(selection: Container | null): ScreenBox | null {
  if (!selection || selection.destroyed || !selection.visible) return null;
  for (let parent = selection.parent; parent; parent = parent.parent) {
    if (!parent.visible) return null;
  }
  const bounds = selection.getBounds();
  if (!(bounds.width > 0 && bounds.height > 0)) return null;
  return { left: bounds.minX, top: bounds.minY, right: bounds.maxX, bottom: bounds.maxY };
}

export function capturePreviewImage(source: PreviewImageSource): ExportImagePixels | null {
  const { application, scene, camera, viewport } = source;
  const screen = application.renderer.screen;
  const width = snapPixel(Math.min(viewport.width, screen.width));
  const height = snapPixel(Math.min(viewport.height, screen.height));
  const outline = previewMapOutline(scene, camera, viewport, source.lift);
  const kept = previewSelectionBox(source.selection);
  const cssCrop = previewImageCrop(outline, width, height, width, height, kept);
  if (!cssCrop) return null;
  const canvasResolution = previewCanvasResolution(
    application.canvas.width,
    snapPixel(screen.width),
    application.renderer.resolution,
  );
  const resolution = previewImageResolution(canvasResolution, cssCrop.width, cssCrop.height);
  const restore = prepareCaptureLayers(source.transient, kept ? source.selection : null);
  let frame: { pixels: Uint8Array | Uint8ClampedArray; width: number; height: number };
  try {
    frame = application.renderer.extract.pixels({
      target: application.stage,
      frame: new Rectangle(0, 0, width, height),
      resolution,
      clearColor: [0, 0, 0, 0],
    });
  } finally {
    restore();
  }
  const scaled = previewImageCrop(
    outline,
    width,
    height,
    width * resolution,
    height * resolution,
    kept,
  );
  const crop = scaled && clampCrop(scaled, frame.width, frame.height);
  if (!crop || !exportImageSizeAllowed(crop.width, crop.height)) return null;
  return {
    width: crop.width,
    height: crop.height,
    pixels: cropUnpremultipliedRgba(frame.pixels, frame.width, crop),
  };
}

export function clampCrop(crop: PixelCrop, width: number, height: number): PixelCrop | null {
  const x = Math.max(0, crop.x);
  const y = Math.max(0, crop.y);
  const right = Math.min(Math.floor(width), crop.x + crop.width);
  const bottom = Math.min(Math.floor(height), crop.y + crop.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

function intersection(
  from: ScreenPoint,
  to: ScreenPoint,
  fromSide: number,
  toSide: number,
): ScreenPoint {
  const t = fromSide / (fromSide - toSide);
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
}

function convexHull(points: readonly ScreenPoint[]): ScreenPoint[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (sorted.length < 3) return sorted;
  const cross = (o: ScreenPoint, a: ScreenPoint, b: ScreenPoint) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: ScreenPoint[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper: ScreenPoint[] = [];
  for (const point of [...sorted].reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, point) <= 0) upper.pop();
    upper.push(point);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}
