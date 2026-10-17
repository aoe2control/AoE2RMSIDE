import {
  panPreviewCamera,
  zoomPreviewCamera,
  type PreviewCamera,
  type PreviewViewport,
  type ScreenPoint,
} from './top-down-preview';

export interface PreviewPanDrag {
  pointerId: number;
  pointer: ScreenPoint;
  startCamera: PreviewCamera;
}

export function panDragCamera(
  drag: PreviewPanDrag,
  shown: PreviewCamera,
  point: ScreenPoint,
  mapWidth: number,
  mapHeight: number,
  viewport: PreviewViewport,
): PreviewCamera {
  const next = panPreviewCamera(
    shown,
    point.x - drag.pointer.x,
    point.y - drag.pointer.y,
    mapWidth,
    mapHeight,
    viewport,
  );
  drag.pointer = { x: point.x, y: point.y };
  return next;
}

export function anchoredZoomFrame(
  shown: PreviewCamera,
  zoom: number,
  anchor: ScreenPoint,
  mapWidth: number,
  mapHeight: number,
  viewport: PreviewViewport,
): PreviewCamera {
  if (shown.zoom === zoom) return shown;
  return zoomPreviewCamera(shown, zoom / shown.zoom, anchor, mapWidth, mapHeight, viewport);
}
