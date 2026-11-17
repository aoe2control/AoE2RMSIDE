import {
  mapToScreen,
  previewProjectionVerticalScale,
  type MapPoint,
  type PreviewCamera,
  type PreviewSelection,
  type PreviewViewport,
  type ScreenPoint,
} from './top-down-preview';

export const previewRulerSize = Object.freeze({
  chevronGap: 3,
  chevronLength: 5,
  chevronHalfWidth: 4,
  bracketGap: 3,
  bracketTick: 4,
  diagonalTick: 3,
  diagonalRoom: 8,
  labelGap: 3,
  labelCharacterWidth: 6,
  labelHeight: 10,
  lineWidth: 1.5,
  haloWidth: 3.5,
  labelHaloWidth: 3,
});

export type PreviewRulerEdge = 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right';

export type PreviewRulerPlace = PreviewRulerEdge | 'diagonal';

export interface PreviewRulerEdgeFrame {
  start: ScreenPoint;
  end: ScreenPoint;
  tangent: ScreenPoint;
  outward: ScreenPoint;
  flatTangent: ScreenPoint;
  flatOutward: ScreenPoint;
  verticalScale: number;
  length: number;
}

export interface PreviewRulerBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PreviewRulerLabel {
  x: number;
  y: number;
  text: string;
}

export interface PreviewRulerMark {
  edge: PreviewRulerPlace;
  value: number;
  path: string;
  label: PreviewRulerLabel;
}

export interface PreviewRulerHoverMarks {
  x: PreviewRulerMark | null;
  y: PreviewRulerMark | null;
}

export interface PreviewRulerSelectionMarks {
  width: PreviewRulerMark | null;
  height: PreviewRulerMark | null;
  diagonal: PreviewRulerMark | null;
}

interface MapDimensions {
  width: number;
  height: number;
}

function edgeMapEnds(
  edge: PreviewRulerEdge,
  dimensions: MapDimensions,
): { start: MapPoint; end: MapPoint; length: number } {
  const { width, height } = dimensions;
  switch (edge) {
    case 'bottom-left':
      return { start: { x: 0, y: 0 }, end: { x: 0, y: height }, length: height };
    case 'bottom-right':
      return { start: { x: 0, y: height }, end: { x: width, y: height }, length: width };
    case 'top-left':
      return { start: { x: 0, y: 0 }, end: { x: width, y: 0 }, length: width };
    case 'top-right':
      return { start: { x: width, y: 0 }, end: { x: width, y: height }, length: height };
  }
}

export function previewRulerEdgeFrame(
  edge: PreviewRulerEdge,
  dimensions: MapDimensions,
  camera: PreviewCamera,
  viewport: PreviewViewport,
): PreviewRulerEdgeFrame {
  const ends = edgeMapEnds(edge, dimensions);
  const project = (point: MapPoint) =>
    mapToScreen(point, dimensions.width, dimensions.height, camera, viewport);
  const start = project(ends.start);
  const end = project(ends.end);
  const centre = project({ x: dimensions.width / 2, y: dimensions.height / 2 });
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const span = Math.hypot(dx, dy) || 1;
  const tangent = { x: dx / span, y: dy / span };
  let outward = { x: tangent.y, y: -tangent.x };
  const middle = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  if (outward.x * (middle.x - centre.x) + outward.y * (middle.y - centre.y) < 0) {
    outward = { x: -outward.x, y: -outward.y };
  }
  const verticalScale = previewProjectionVerticalScale(viewport);
  const flatSpan = Math.hypot(dx, dy / verticalScale) || 1;
  const flatTangent = { x: dx / flatSpan, y: dy / verticalScale / flatSpan };
  let flatOutward = { x: flatTangent.y, y: -flatTangent.x };
  if (flatOutward.x * outward.x + flatOutward.y * verticalScale * outward.y < 0) {
    flatOutward = { x: -flatOutward.x, y: -flatOutward.y };
  }
  return {
    start,
    end,
    tangent,
    outward,
    flatTangent,
    flatOutward,
    verticalScale,
    length: ends.length,
  };
}

function squished(frame: PreviewRulerEdgeFrame, offset: ScreenPoint): ScreenPoint {
  return { x: offset.x, y: offset.y * frame.verticalScale };
}

function unit(vector: ScreenPoint): ScreenPoint {
  const length = Math.hypot(vector.x, vector.y) || 1;
  return { x: vector.x / length, y: vector.y / length };
}

export function previewRulerEdgePoint(
  frame: PreviewRulerEdgeFrame,
  coordinate: number,
): ScreenPoint {
  const share = frame.length > 0 ? coordinate / frame.length : 0;
  return {
    x: frame.start.x + (frame.end.x - frame.start.x) * share,
    y: frame.start.y + (frame.end.y - frame.start.y) * share,
  };
}

export function previewRulerBounds(viewport: PreviewViewport): PreviewRulerBounds {
  const left = Math.max(viewport.insetLeft ?? 0, viewport.focusInsetLeft ?? 0);
  const right = Math.max(viewport.insetRight ?? 0, viewport.focusInsetRight ?? 0);
  return { left, top: 0, right: Math.max(left, viewport.width - right), bottom: viewport.height };
}

function inside(point: ScreenPoint, bounds: PreviewRulerBounds): boolean {
  return (
    point.x >= bounds.left &&
    point.x <= bounds.right &&
    point.y >= bounds.top &&
    point.y <= bounds.bottom
  );
}

export function previewRulerLabelCentre(
  from: ScreenPoint,
  outward: ScreenPoint,
  text: string,
): ScreenPoint {
  const halfWidth = (text.length * previewRulerSize.labelCharacterWidth) / 2;
  const halfHeight = previewRulerSize.labelHeight / 2;
  const extent = Math.abs(outward.x) * halfWidth + Math.abs(outward.y) * halfHeight;
  const distance = previewRulerSize.labelGap + extent;
  return { x: from.x + outward.x * distance, y: from.y + outward.y * distance };
}

function number(value: number): string {
  return (Math.round(value * 10) / 10).toString();
}

function pointText(point: ScreenPoint): string {
  return `${number(point.x)} ${number(point.y)}`;
}

function along(point: ScreenPoint, direction: ScreenPoint, distance: number): ScreenPoint {
  return { x: point.x + direction.x * distance, y: point.y + direction.y * distance };
}

function chevronMark(
  frame: PreviewRulerEdgeFrame,
  edge: PreviewRulerEdge,
  coordinate: number,
  value: number,
  bounds: PreviewRulerBounds,
): PreviewRulerMark | null {
  const point = previewRulerEdgePoint(frame, coordinate);
  if (!inside(point, bounds)) return null;
  const { chevronGap, chevronLength, chevronHalfWidth } = previewRulerSize;
  const outward = squished(frame, frame.flatOutward);
  const across = squished(frame, frame.flatTangent);
  const tip = along(point, outward, chevronGap);
  const base = along(tip, outward, chevronLength);
  const first = along(base, across, -chevronHalfWidth);
  const second = along(base, across, chevronHalfWidth);
  const text = String(value);
  return {
    edge,
    value,
    path: `M${pointText(first)}L${pointText(tip)}L${pointText(second)}`,
    label: { ...previewRulerLabelCentre(base, unit(outward), text), text },
  };
}

export function clipSegmentToBounds(
  start: ScreenPoint,
  end: ScreenPoint,
  bounds: PreviewRulerBounds,
): { from: number; to: number } | null {
  let from = 0;
  let to = 1;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const limits: Array<[number, number]> = [
    [-dx, start.x - bounds.left],
    [dx, bounds.right - start.x],
    [-dy, start.y - bounds.top],
    [dy, bounds.bottom - start.y],
  ];
  for (const [p, q] of limits) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > to) return null;
      if (t > from) from = t;
    } else {
      if (t < from) return null;
      if (t < to) to = t;
    }
  }
  return from <= to ? { from, to } : null;
}

export interface PreviewRulerBracketGeometry {
  start: ScreenPoint;
  end: ScreenPoint;
  outward: ScreenPoint;
}

function edgeBracketGeometry(
  frame: PreviewRulerEdgeFrame,
  from: number,
  to: number,
): PreviewRulerBracketGeometry {
  return {
    start: previewRulerEdgePoint(frame, from),
    end: previewRulerEdgePoint(frame, to),
    outward: squished(frame, frame.flatOutward),
  };
}

export function blendPreviewRulerBracket(
  from: PreviewRulerBracketGeometry,
  to: PreviewRulerBracketGeometry,
  share: number,
): PreviewRulerBracketGeometry {
  if (share <= 0) return from;
  if (share >= 1) return to;
  const mix = (a: ScreenPoint, b: ScreenPoint) => ({
    x: a.x + (b.x - a.x) * share,
    y: a.y + (b.y - a.y) * share,
  });
  return {
    start: mix(from.start, to.start),
    end: mix(from.end, to.end),
    outward: mix(from.outward, to.outward),
  };
}

function bracketMark(
  edge: PreviewRulerEdge,
  geometry: PreviewRulerBracketGeometry,
  value: number,
  bounds: PreviewRulerBounds,
): PreviewRulerMark | null {
  const { bracketGap, bracketTick } = previewRulerSize;
  const offset = bracketGap + bracketTick;
  const { outward } = geometry;
  const start = along(geometry.start, outward, offset);
  const end = along(geometry.end, outward, offset);
  const clipped = clipSegmentToBounds(start, end, bounds);
  if (!clipped) return null;
  const at = (share: number) => ({
    x: start.x + (end.x - start.x) * share,
    y: start.y + (end.y - start.y) * share,
  });
  const shownStart = at(clipped.from);
  const shownEnd = at(clipped.to);
  const inward = { x: -outward.x, y: -outward.y };
  let path = '';
  if (clipped.from === 0) path += `M${pointText(along(shownStart, inward, bracketTick))}L`;
  else path += 'M';
  path += `${pointText(shownStart)}L${pointText(shownEnd)}`;
  if (clipped.to === 1) path += `L${pointText(along(shownEnd, inward, bracketTick))}`;
  const middle = at((clipped.from + clipped.to) / 2);
  const text = String(value);
  return {
    edge,
    value,
    path,
    label: { ...previewRulerLabelCentre(middle, unit(outward), text), text },
  };
}

export function previewRulerHoverMarks(
  tile: { x: number; y: number },
  dimensions: MapDimensions,
  camera: PreviewCamera,
  viewport: PreviewViewport,
): PreviewRulerHoverMarks {
  const bounds = previewRulerBounds(viewport);
  return {
    x: chevronMark(
      previewRulerEdgeFrame('bottom-right', dimensions, camera, viewport),
      'bottom-right',
      tile.x + 0.5,
      tile.x,
      bounds,
    ),
    y: chevronMark(
      previewRulerEdgeFrame('bottom-left', dimensions, camera, viewport),
      'bottom-left',
      tile.y + 0.5,
      tile.y,
      bounds,
    ),
  };
}

export function previewRulerSelectionSize(selection: PreviewSelection): {
  width: number;
  height: number;
} {
  return {
    width: selection.maximumX - selection.minimumX + 1,
    height: selection.maximumY - selection.minimumY + 1,
  };
}

export function previewRulerSelectionDiagonal(selection: PreviewSelection): number | null {
  const size = previewRulerSelectionSize(selection);
  if (size.width < 2 || size.height < 2) return null;
  return Math.round(Math.hypot(size.width, size.height) * 10) / 10;
}

function diagonalMark(
  selection: PreviewSelection,
  dimensions: MapDimensions,
  camera: PreviewCamera,
  viewport: PreviewViewport,
  bounds: PreviewRulerBounds,
  format: (value: number) => string,
): PreviewRulerMark | null {
  const value = previewRulerSelectionDiagonal(selection);
  if (value === null) return null;
  const project = (point: MapPoint) =>
    mapToScreen(point, dimensions.width, dimensions.height, camera, viewport);
  const start = project({ x: selection.minimumX, y: selection.minimumY });
  const end = project({ x: selection.maximumX + 1, y: selection.maximumY + 1 });
  const clipped = clipSegmentToBounds(start, end, bounds);
  if (!clipped) return null;
  const at = (share: number) => ({
    x: start.x + (end.x - start.x) * share,
    y: start.y + (end.y - start.y) * share,
  });
  const shownStart = at(clipped.from);
  const shownEnd = at(clipped.to);
  const text = format(value);
  const { diagonalTick, diagonalRoom, labelCharacterWidth } = previewRulerSize;
  const shown = Math.hypot(shownEnd.x - shownStart.x, shownEnd.y - shownStart.y);
  if (shown < text.length * labelCharacterWidth + 2 * diagonalRoom) return null;
  const verticalScale = previewProjectionVerticalScale(viewport);
  const flat = unit({ x: end.x - start.x, y: (end.y - start.y) / verticalScale });
  let flatNormal = { x: flat.y, y: -flat.x };
  if (flatNormal.y > 0 || (flatNormal.y === 0 && flatNormal.x < 0)) {
    flatNormal = { x: -flatNormal.x, y: -flatNormal.y };
  }
  const across = { x: flatNormal.x, y: flatNormal.y * verticalScale };
  const tick = (point: ScreenPoint) =>
    `M${pointText(along(point, across, -diagonalTick))}L${pointText(along(point, across, diagonalTick))}`;
  let path = `M${pointText(shownStart)}L${pointText(shownEnd)}`;
  if (clipped.from === 0) path += tick(shownStart);
  if (clipped.to === 1) path += tick(shownEnd);
  const middle = at((clipped.from + clipped.to) / 2);
  return {
    edge: 'diagonal',
    value,
    path,
    label: { ...previewRulerLabelCentre(middle, unit(across), text), text },
  };
}

export function previewRulerSelectionBrackets(
  selection: PreviewSelection,
  dimensions: MapDimensions,
  camera: PreviewCamera,
  viewport: PreviewViewport,
): {
  beside: { width: PreviewRulerBracketGeometry; height: PreviewRulerBracketGeometry };
  edges: { width: PreviewRulerBracketGeometry; height: PreviewRulerBracketGeometry };
} {
  const topLeft = previewRulerEdgeFrame('top-left', dimensions, camera, viewport);
  const topRight = previewRulerEdgeFrame('top-right', dimensions, camera, viewport);
  const project = (point: MapPoint) =>
    mapToScreen(point, dimensions.width, dimensions.height, camera, viewport);
  const right = selection.maximumX + 1;
  const bottom = selection.maximumY + 1;
  return {
    beside: {
      width: {
        start: project({ x: selection.minimumX, y: selection.minimumY }),
        end: project({ x: right, y: selection.minimumY }),
        outward: squished(topLeft, topLeft.flatOutward),
      },
      height: {
        start: project({ x: right, y: selection.minimumY }),
        end: project({ x: right, y: bottom }),
        outward: squished(topRight, topRight.flatOutward),
      },
    },
    edges: {
      width: edgeBracketGeometry(topLeft, selection.minimumX, right),
      height: edgeBracketGeometry(topRight, selection.minimumY, bottom),
    },
  };
}

export function previewRulerSelectionMarks(
  selection: PreviewSelection,
  dimensions: MapDimensions,
  camera: PreviewCamera,
  viewport: PreviewViewport,
  formatDiagonal: (value: number) => string = String,
  onEdges = 1,
): PreviewRulerSelectionMarks {
  const bounds = previewRulerBounds(viewport);
  const size = previewRulerSelectionSize(selection);
  const brackets = previewRulerSelectionBrackets(selection, dimensions, camera, viewport);
  return {
    width: bracketMark(
      'top-left',
      blendPreviewRulerBracket(brackets.beside.width, brackets.edges.width, onEdges),
      size.width,
      bounds,
    ),
    height: bracketMark(
      'top-right',
      blendPreviewRulerBracket(brackets.beside.height, brackets.edges.height, onEdges),
      size.height,
      bounds,
    ),
    diagonal: diagonalMark(selection, dimensions, camera, viewport, bounds, formatDiagonal),
  };
}

export function previewRulerGlideEase(progress: number): number {
  const clamped = Math.min(1, Math.max(0, progress));
  return 1 - (1 - clamped) ** 3;
}

export interface PreviewRulerPaint {
  foreground: string;
  halo: string;
  font: string;
}

export interface PreviewRulerCapture {
  marks: readonly PreviewRulerMark[];
  paint: PreviewRulerPaint;
}

export function previewRulerMarkBox(mark: PreviewRulerMark): PreviewRulerBounds {
  const values = (mark.path.match(/-?\d+(?:\.\d+)?/gu) ?? []).map(Number);
  const halo = previewRulerSize.haloWidth / 2;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (let index = 0; index + 1 < values.length; index += 2) {
    left = Math.min(left, values[index]! - halo);
    right = Math.max(right, values[index]! + halo);
    top = Math.min(top, values[index + 1]! - halo);
    bottom = Math.max(bottom, values[index + 1]! + halo);
  }
  const labelHalo = previewRulerSize.labelHaloWidth / 2;
  const halfWidth = (mark.label.text.length * previewRulerSize.labelCharacterWidth) / 2 + labelHalo;
  const halfHeight = previewRulerSize.labelHeight / 2 + labelHalo;
  return {
    left: Math.min(left, mark.label.x - halfWidth),
    top: Math.min(top, mark.label.y - halfHeight),
    right: Math.max(right, mark.label.x + halfWidth),
    bottom: Math.max(bottom, mark.label.y + halfHeight),
  };
}

export interface PreviewRulerContext<Path> {
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  lineWidth: number;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  fillStyle: string | CanvasGradient | CanvasPattern;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  stroke(path: Path): void;
  strokeText(text: string, x: number, y: number): void;
  fillText(text: string, x: number, y: number): void;
}

export function drawPreviewRulerMarks<Path>(
  context: PreviewRulerContext<Path>,
  capture: PreviewRulerCapture,
  toPath: (d: string) => Path,
): void {
  const { marks, paint } = capture;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  for (const mark of marks) {
    const path = toPath(mark.path);
    context.strokeStyle = paint.halo;
    context.lineWidth = previewRulerSize.haloWidth;
    context.stroke(path);
    context.strokeStyle = paint.foreground;
    context.lineWidth = previewRulerSize.lineWidth;
    context.stroke(path);
  }
  context.font = paint.font;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  for (const mark of marks) {
    context.strokeStyle = paint.halo;
    context.lineWidth = previewRulerSize.labelHaloWidth;
    context.strokeText(mark.label.text, mark.label.x, mark.label.y);
    context.fillStyle = paint.foreground;
    context.fillText(mark.label.text, mark.label.x, mark.label.y);
  }
}

function nextFrame(callback: () => void): { cancel(): void } {
  if (typeof requestAnimationFrame === 'function') {
    const handle = requestAnimationFrame(callback);
    return { cancel: () => cancelAnimationFrame(handle) };
  }
  const handle = setTimeout(callback, 16);
  return { cancel: () => clearTimeout(handle) };
}

export interface PreviewRulerMarkElements {
  group: SVGGElement;
  halo: SVGPathElement;
  line: SVGPathElement;
  label: SVGTextElement;
}

export type PreviewRulerMarkKind =
  'cursor-x' | 'cursor-y' | 'selection-width' | 'selection-height' | 'selection-diagonal';

export const previewRulerMarkKinds: readonly PreviewRulerMarkKind[] = Object.freeze([
  'cursor-x',
  'cursor-y',
  'selection-width',
  'selection-height',
  'selection-diagonal',
]);

export class PreviewRulerOverlay {
  private readonly marks = new Map<PreviewRulerMarkKind, PreviewRulerMarkElements>();
  private enabled = true;
  private hover: { x: number; y: number } | null = null;
  private selection: PreviewSelection | null = null;
  private keptHover: { x: number; y: number } | null = null;
  private keptSelection: PreviewSelection | null = null;
  private formatNumber: (value: number) => string = String;
  private onEdges = false;
  private glide: { from: number; to: number; started: number; duration: number } | null = null;
  private glideFrame: { cancel(): void } | null = null;
  private lastDraw: [MapDimensions, PreviewCamera, PreviewViewport] | null = null;

  setNumberFormat(format: (value: number) => string): void {
    this.formatNumber = format;
  }

  setEdgePlacement(onEdges: boolean, glideMilliseconds = 0): void {
    if (onEdges === this.onEdges) return;
    const from = this.edgeShare();
    this.onEdges = onEdges;
    if (glideMilliseconds <= 0) {
      this.glide = null;
      this.redraw();
      return;
    }
    this.glide = {
      from,
      to: onEdges ? 1 : 0,
      started: performance.now(),
      duration: glideMilliseconds,
    };
    this.scheduleGlideFrame();
  }

  dispose(): void {
    this.glideFrame?.cancel();
    this.glideFrame = null;
    this.glide = null;
  }

  edgeShare(now = performance.now()): number {
    const glide = this.glide;
    if (!glide) return this.onEdges ? 1 : 0;
    const progress = (now - glide.started) / glide.duration;
    if (progress >= 1) return glide.to;
    return glide.from + (glide.to - glide.from) * previewRulerGlideEase(progress);
  }

  private scheduleGlideFrame(): void {
    if (this.glideFrame !== null) return;
    this.glideFrame = nextFrame(() => {
      this.glideFrame = null;
      const glide = this.glide;
      if (glide && performance.now() - glide.started >= glide.duration) this.glide = null;
      this.redraw();
      if (this.glide) this.scheduleGlideFrame();
    });
  }

  private redraw(): void {
    if (this.lastDraw) this.draw(...this.lastDraw);
  }

  bind(kind: PreviewRulerMarkKind, elements: PreviewRulerMarkElements | null): void {
    if (elements) this.marks.set(kind, elements);
    else this.marks.delete(kind);
  }

  update(
    enabled: boolean,
    hover: { x: number; y: number } | null,
    selection: PreviewSelection | null,
  ): void {
    this.enabled = enabled;
    this.hover = hover;
    this.selection = selection;
    if (hover) this.keptHover = hover;
    if (selection) this.keptSelection = selection;
  }

  draw(dimensions: MapDimensions, camera: PreviewCamera, viewport: PreviewViewport): void {
    this.lastDraw = [dimensions, camera, viewport];
    if (this.marks.size === 0) return;
    const hoverShown = this.enabled && this.hover !== null;
    const selectionShown = this.enabled && this.selection !== null;
    const hover = this.hover ?? this.keptHover;
    const selection = this.selection ?? this.keptSelection;
    const hoverMarks = hover
      ? previewRulerHoverMarks(hover, dimensions, camera, viewport)
      : { x: null, y: null };
    const selectionMarks = selection
      ? previewRulerSelectionMarks(
          selection,
          dimensions,
          camera,
          viewport,
          this.formatNumber,
          this.edgeShare(),
        )
      : { width: null, height: null, diagonal: null };
    this.write('cursor-x', hoverMarks.x, hoverShown);
    this.write('cursor-y', hoverMarks.y, hoverShown);
    this.write('selection-width', selectionMarks.width, selectionShown);
    this.write('selection-height', selectionMarks.height, selectionShown);
    this.write('selection-diagonal', selectionMarks.diagonal, selectionShown);
  }

  capture(
    dimensions: MapDimensions,
    camera: PreviewCamera,
    viewport: PreviewViewport,
  ): PreviewRulerCapture | null {
    if (!this.enabled || !this.selection) return null;
    const selectionMarks = previewRulerSelectionMarks(
      this.selection,
      dimensions,
      camera,
      viewport,
      this.formatNumber,
      this.onEdges ? 1 : 0,
    );
    const marks = [selectionMarks.width, selectionMarks.height, selectionMarks.diagonal].filter(
      (mark): mark is PreviewRulerMark => mark !== null,
    );
    const paint = marks.length > 0 ? this.paint() : null;
    return paint ? { marks, paint } : null;
  }

  private paint(): PreviewRulerPaint | null {
    const elements = this.marks.get('selection-width');
    const view = elements?.label.ownerDocument.defaultView;
    if (!elements || !view) return null;
    const label = view.getComputedStyle(elements.label);
    return {
      foreground: view.getComputedStyle(elements.line).stroke,
      halo: view.getComputedStyle(elements.halo).stroke,
      font: `${label.fontWeight} ${label.fontSize} ${label.fontFamily}`,
    };
  }

  private write(kind: PreviewRulerMarkKind, mark: PreviewRulerMark | null, shown: boolean): void {
    const elements = this.marks.get(kind);
    if (!elements) return;
    const { group, halo, line, label } = elements;
    group.dataset.shown = String(shown && mark !== null);
    if (shown && mark) group.dataset.value = String(mark.value);
    else delete group.dataset.value;
    const path = mark?.path ?? '';
    if (halo.getAttribute('d') !== path) halo.setAttribute('d', path);
    if (line.getAttribute('d') !== path) line.setAttribute('d', path);
    label.setAttribute('x', mark ? number(mark.label.x) : '0');
    label.setAttribute('y', mark ? number(mark.label.y) : '0');
    const text = mark?.label.text ?? '';
    if (label.textContent !== text) label.textContent = text;
  }
}
