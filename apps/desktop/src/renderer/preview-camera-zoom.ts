import { anchoredZoomFrame } from './preview-pan-drag';
import {
  maximumPreviewZoomFor,
  minimumPreviewZoomFor,
  previewCameraIsCentred,
  previewZoomIsMinimum,
  type PreviewCamera,
  type PreviewViewport,
  type ScreenPoint,
} from './top-down-preview';

export const wheelZoomStep = 1.2;
export const wheelZoomStepPixels = 50;
export const wheelLinePixels = 100 / 3;
export const pinchZoomPixels = 100;
export const cameraEaseDurationMs = 160;
export const cameraSettleDurationMs = 240;

export interface WheelZoomInput {
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
}

export function wheelZoomFactor(input: WheelZoomInput): number | null {
  const { deltaY, deltaMode } = input;
  if (!Number.isFinite(deltaY) || deltaY === 0) return null;
  const pixels =
    deltaMode === 1
      ? deltaY * wheelLinePixels
      : deltaMode === 2
        ? deltaY * wheelZoomStepPixels
        : deltaY;
  const steps =
    input.ctrlKey && deltaMode === 0
      ? -pixels / pinchZoomPixels / Math.log(wheelZoomStep)
      : -pixels / wheelZoomStepPixels;
  if (steps >= 1) return wheelZoomStep;
  if (steps <= -1) return 1 / wheelZoomStep;
  return wheelZoomStep ** steps;
}

export interface CameraTransition {
  from: PreviewCamera;
  startedAt: number;
  target: PreviewCamera;
  anchor?: ScreenPoint;
  settle?: boolean;
}

export interface CameraTransitionFrame {
  camera: PreviewCamera;
  target: PreviewCamera;
  done: boolean;
}

export function cameraTransitionProgress(
  startedAt: number,
  now: number,
  reduceMotion: boolean,
  durationMs = cameraEaseDurationMs,
): { progress: number; eased: number } {
  const progress = reduceMotion ? 1 : Math.min(1, Math.max(0, (now - startedAt) / durationMs));
  return { progress, eased: 1 - (1 - progress) ** 3 };
}

export function cameraTransitionFrame(
  transition: CameraTransition,
  now: number,
  shown: PreviewCamera,
  anchor: ScreenPoint | undefined,
  reduceMotion: boolean,
  mapWidth: number,
  mapHeight: number,
  viewport: PreviewViewport,
): CameraTransitionFrame {
  const { progress, eased } = cameraTransitionProgress(
    transition.startedAt,
    now,
    reduceMotion,
    transition.settle ? cameraSettleDurationMs : cameraEaseDurationMs,
  );
  const done = progress >= 1;
  if (transition.settle && transition.anchor && !done) {
    const { from, target } = transition;
    const zoomed = anchoredZoomFrame(
      from,
      from.zoom * (target.zoom / from.zoom) ** eased,
      transition.anchor,
      mapWidth,
      mapHeight,
      viewport,
    );
    return {
      camera: {
        zoom: zoomed.zoom,
        centerX: zoomed.centerX + (target.centerX - zoomed.centerX) * eased,
        centerY: zoomed.centerY + (target.centerY - zoomed.centerY) * eased,
      },
      target,
      done,
    };
  }
  if (!anchor || transition.settle) {
    return {
      camera: done
        ? transition.target
        : interpolateCamera(transition.from, transition.target, eased),
      target: transition.target,
      done,
    };
  }
  const target = anchoredZoomFrame(
    shown,
    transition.target.zoom,
    anchor,
    mapWidth,
    mapHeight,
    viewport,
  );
  if (done) return { camera: target, target, done };
  const zoom = transition.from.zoom * (transition.target.zoom / transition.from.zoom) ** eased;
  return {
    camera: anchoredZoomFrame(shown, zoom, anchor, mapWidth, mapHeight, viewport),
    target,
    done,
  };
}

export function zoomTransitionTarget(
  shown: PreviewCamera,
  base: PreviewCamera,
  factor: number,
  anchor: ScreenPoint,
  mapWidth: number,
  mapHeight: number,
  viewport: PreviewViewport,
): PreviewCamera {
  const zoom = Math.min(
    maximumPreviewZoomFor(mapWidth, mapHeight, viewport),
    Math.max(minimumPreviewZoomFor(viewport), base.zoom * factor),
  );
  return anchoredZoomFrame(shown, zoom, anchor, mapWidth, mapHeight, viewport);
}

export function zoomStepStartsTransition(
  base: PreviewCamera,
  target: PreviewCamera,
  mapWidth: number,
  mapHeight: number,
  viewport: PreviewViewport,
): boolean {
  if (target.zoom !== base.zoom) return true;
  return (
    previewZoomIsMinimum(target.zoom, viewport) &&
    !previewCameraIsCentred(base, mapWidth, mapHeight)
  );
}

export function cameraTransitionTo(
  from: PreviewCamera,
  startedAt: number,
  target: PreviewCamera,
  anchor: ScreenPoint | undefined,
  mapWidth: number,
  mapHeight: number,
  viewport: PreviewViewport,
  pan = false,
): CameraTransition {
  const transition: CameraTransition = {
    from,
    startedAt,
    target,
    ...(anchor ? { anchor: { ...anchor } } : {}),
  };
  if (!previewZoomIsMinimum(target.zoom, viewport)) return transition;
  if (pan) return transition;
  const centred: PreviewCamera = {
    zoom: minimumPreviewZoomFor(viewport),
    centerX: mapWidth / 2,
    centerY: mapHeight / 2,
  };
  if (target.zoom === centred.zoom && previewCameraIsCentred(target, mapWidth, mapHeight)) {
    return transition;
  }
  return { ...transition, target: centred, settle: true };
}

export function interpolateCamera(
  from: PreviewCamera,
  target: PreviewCamera,
  progress: number,
): PreviewCamera {
  return {
    centerX: from.centerX + (target.centerX - from.centerX) * progress,
    centerY: from.centerY + (target.centerY - from.centerY) * progress,
    zoom: from.zoom + (target.zoom - from.zoom) * progress,
  };
}
