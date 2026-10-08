import { Container, Graphics } from 'pixi.js';
import { requestPreviewRender } from './preview-render-scheduler';
import {
  previewProjectionVerticalScale,
  previewScale,
  type MapPoint,
  type PreviewCamera,
  type PreviewViewport,
} from './top-down-preview';

export interface TileGridLine {
  from: MapPoint;
  to: MapPoint;
}

export function tileGridLines(width: number, height: number): TileGridLine[] {
  const lines: TileGridLine[] = [];
  for (let x = 0; x <= width; x += 1) lines.push({ from: { x, y: 0 }, to: { x, y: height } });
  for (let y = 0; y <= height; y += 1) lines.push({ from: { x: 0, y }, to: { x: width, y } });
  return lines;
}

export function terrainLocalPoint(point: MapPoint): MapPoint {
  return { x: point.x + point.y, y: point.y - point.x };
}

export function terrainLayerTransform(
  scene: { width: number; height: number },
  camera: PreviewCamera,
  viewport: PreviewViewport,
): { scaleX: number; scaleY: number; x: number; y: number } {
  const component = previewScale(scene.width, scene.height, camera, viewport) * Math.SQRT1_2;
  const verticalComponent = component * previewProjectionVerticalScale(viewport);
  return {
    scaleX: component,
    scaleY: verticalComponent,
    x: viewport.width / 2 - (camera.centerX + camera.centerY) * component,
    y: viewport.height / 2 - (camera.centerY - camera.centerX) * verticalComponent,
  };
}

export function tileEdgeScreenPixels(
  scene: { width: number; height: number },
  camera: PreviewCamera,
  viewport: PreviewViewport,
): number {
  const { scaleX, scaleY } = terrainLayerTransform(scene, camera, viewport);
  return Math.hypot(scaleX, scaleY);
}

export const tileGridHiddenPixels = 5;
export const tileGridFullPixels = 12;

export function tileGridStrength(pixels: number): number {
  if (!Number.isFinite(pixels) || pixels <= tileGridHiddenPixels) return 0;
  return Math.min(1, (pixels - tileGridHiddenPixels) / (tileGridFullPixels - tileGridHiddenPixels));
}

export interface TileGridColor {
  color: number;
  alpha: number;
}

export const fallbackTileGridColor: TileGridColor = { color: 0x060606, alpha: 0.4 };

export class TileGridLayer {
  readonly container = new Container({ label: 'tile-grid' });
  private readonly graphics = new Graphics();
  readonly lineCount: number;
  private color: TileGridColor;
  opacity = 0;

  constructor(
    readonly width: number,
    readonly height: number,
    color: TileGridColor,
  ) {
    this.container.eventMode = 'none';
    this.graphics.eventMode = 'none';
    const lines = tileGridLines(width, height);
    for (const line of lines) {
      const from = terrainLocalPoint(line.from);
      const to = terrainLocalPoint(line.to);
      this.graphics.moveTo(from.x, from.y).lineTo(to.x, to.y);
    }
    this.graphics.stroke({ width: 1, pixelLine: true, color: 0xffffff, alpha: 1 });
    this.lineCount = lines.length;
    this.color = color;
    this.graphics.tint = color.color;
    this.container.addChild(this.graphics);
  }

  setColor(color: TileGridColor): void {
    this.color = color;
    this.graphics.tint = color.color;
    requestPreviewRender(this.container);
  }

  update(
    scene: { width: number; height: number },
    camera: PreviewCamera,
    viewport: PreviewViewport,
  ): void {
    const strength = tileGridStrength(tileEdgeScreenPixels(scene, camera, viewport));
    this.opacity = strength * this.color.alpha;
    this.container.alpha = this.opacity;
    this.container.renderable = this.opacity > 0;
    requestPreviewRender(this.container);
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}
