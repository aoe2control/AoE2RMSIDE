import type { ElevationSurface } from './preview-elevation';
import {
  clampedTileAtScreenPoint,
  rectangularSelectionFromDrag,
  type PreviewCamera,
  type PreviewHit,
  type PreviewSelection,
  type PreviewViewport,
  type ScreenPoint,
  type TopDownScene,
} from './top-down-preview';

export interface PreviewSelectionDrag {
  pointerId: number;
  start: PreviewHit;
  end: PreviewHit;
  pointer: ScreenPoint;
  cancelled?: boolean;
}

export function selectionDragRectangle(
  drag: Pick<PreviewSelectionDrag, 'start' | 'end'>,
  scene: Pick<TopDownScene, 'width' | 'height'>,
): PreviewSelection {
  return rectangularSelectionFromDrag(drag.start, drag.end, scene.width, scene.height);
}

export function followSelectionDrag(
  drag: PreviewSelectionDrag,
  scene: Pick<TopDownScene, 'width' | 'height'>,
  camera: PreviewCamera,
  viewport: PreviewViewport,
  surface: ElevationSurface | null,
  pointer: ScreenPoint = drag.pointer,
): PreviewSelection {
  drag.pointer = { x: pointer.x, y: pointer.y };
  drag.end = clampedTileAtScreenPoint(scene, camera, viewport, drag.pointer, surface);
  return selectionDragRectangle(drag, scene);
}

export function cameraCommittedOnDragRelease(
  shown: PreviewCamera,
  transitionInFlight: boolean,
): PreviewCamera | null {
  return transitionInFlight ? null : shown;
}

export function sceneBuildCamera(
  state: PreviewCamera,
  shown: PreviewCamera,
  shownIsAhead: boolean,
): PreviewCamera {
  return shownIsAhead ? shown : state;
}
