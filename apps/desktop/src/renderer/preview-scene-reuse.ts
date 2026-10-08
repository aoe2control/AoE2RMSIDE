import {
  previewScreenTransform,
  type PreviewCamera,
  type PreviewViewport,
} from './top-down-preview';

export function markerCullMargin(viewport: Pick<PreviewViewport, 'width' | 'height'>): {
  x: number;
  y: number;
} {
  return { x: Math.round(viewport.width / 4), y: Math.round(viewport.height / 4) };
}

export interface BuiltMapLayer {
  camera: PreviewCamera;
  viewport: PreviewViewport;
  scene: { width: number; height: number };
  culled: boolean;
}

export function mapLayerKeptForCamera(
  built: BuiltMapLayer | null,
  camera: PreviewCamera,
  viewport: PreviewViewport,
  scene: { width: number; height: number } | null,
): boolean {
  if (!built || !scene || built.scene !== scene || built.viewport !== viewport) return false;
  if (built.camera.zoom !== camera.zoom) return false;
  if (!built.culled) return true;
  const transform = previewScreenTransform(
    scene.width,
    scene.height,
    built.camera,
    viewport,
    camera,
    viewport,
  );
  if (Math.abs(transform.scale - 1) > 1e-9) return false;
  const margin = markerCullMargin(viewport);
  return Math.abs(transform.x) <= margin.x && Math.abs(transform.y) <= margin.y;
}
