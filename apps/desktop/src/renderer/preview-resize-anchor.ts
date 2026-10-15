import type { Container } from 'pixi.js';
import {
  clampPreviewCamera,
  fitPreviewCamera,
  previewScreenTransform,
  previewViewportIsCollapsed,
  type PreviewCamera,
  type PreviewScreenTransform,
  type PreviewViewport,
} from './top-down-preview';

export interface DrawnPreviewLayout {
  viewport: PreviewViewport;
  scene: { width: number; height: number };
}

export function previewResizeAnchor(
  drawn: DrawnPreviewLayout | null,
  camera: PreviewCamera,
  fitted: boolean,
  width: number,
  height: number,
): PreviewScreenTransform | null {
  if (!drawn) return null;
  const { scene, viewport } = drawn;
  if (Math.abs(viewport.width - width) < 0.5 && Math.abs(viewport.height - height) < 0.5) {
    return null;
  }
  if (previewViewportIsCollapsed(viewport)) return null;
  const shownViewport = { ...viewport, width, height };
  const shownCamera = fitted
    ? fitPreviewCamera(scene.width, scene.height)
    : clampPreviewCamera(camera, scene.width, scene.height, shownViewport);
  return previewScreenTransform(
    scene.width,
    scene.height,
    camera,
    viewport,
    shownCamera,
    shownViewport,
  );
}

export function applyPreviewResizeAnchor(
  stage: Container,
  anchor: PreviewScreenTransform | null,
  host: HTMLElement,
): void {
  if (!anchor) {
    if (
      stage.scale.x !== 1 ||
      stage.scale.y !== 1 ||
      stage.position.x !== 0 ||
      stage.position.y !== 0
    ) {
      stage.position.set(0, 0);
      stage.scale.set(1);
    }
    delete host.dataset.resizeAnchor;
    return;
  }
  stage.position.set(anchor.x, anchor.y);
  stage.scale.set(anchor.scale);
  host.dataset.resizeAnchor = `${anchor.x.toFixed(2)},${anchor.y.toFixed(2)},${anchor.scale.toFixed(4)}`;
}
