import type { Container } from 'pixi.js';
import {
  clampPreviewCamera,
  fitPreviewCamera,
  previewCameraForCentre,
  previewCameraIsCentred,
  previewScale,
  previewScreenTransform,
  previewViewCenter,
  previewViewportIsCollapsed,
  previewVisibleWidth,
  samePreviewEditorInsets,
  samePreviewFocus,
  screenToMap,
  type PreviewCamera,
  type PreviewScreenTransform,
  type PreviewViewport,
} from './top-down-preview';

export interface DrawnPreviewLayout {
  viewport: PreviewViewport;
  scene: { width: number; height: number };
}

export type PreviewCanvasSize = Pick<
  PreviewViewport,
  | 'width'
  | 'height'
  | 'insetLeft'
  | 'insetRight'
  | 'behindEditor'
  | 'focusInsetLeft'
  | 'focusInsetRight'
  | 'editorInsetLeft'
  | 'editorInsetRight'
>;

export function previewResizeAnchor(
  drawn: DrawnPreviewLayout | null,
  camera: PreviewCamera,
  fitted: boolean,
  size: PreviewCanvasSize,
  options: { drawnCamera?: PreviewCamera; laidOut?: PreviewViewport } = {},
): PreviewScreenTransform | null {
  if (!drawn) return null;
  const { scene, viewport } = drawn;
  const drawnCamera = options.drawnCamera ?? camera;
  const shownViewport = { ...viewport, ...size };
  if (
    drawnCamera === camera &&
    Math.abs(viewport.width - size.width) < 0.5 &&
    Math.abs(viewport.height - size.height) < 0.5 &&
    Math.abs((viewport.insetLeft ?? 0) - (size.insetLeft ?? 0)) < 0.5 &&
    Math.abs((viewport.insetRight ?? 0) - (size.insetRight ?? 0)) < 0.5 &&
    samePreviewFocus(viewport, size) &&
    samePreviewEditorInsets(viewport, size)
  ) {
    return null;
  }
  if (previewViewportIsCollapsed(viewport)) return null;
  const shownCamera = fitted
    ? fitPreviewCamera(scene.width, scene.height)
    : clampPreviewCamera(
        previewCameraForCentre(
          camera,
          scene.width,
          scene.height,
          options.laidOut ?? viewport,
          shownViewport,
        ),
        scene.width,
        scene.height,
        shownViewport,
      );
  return previewScreenTransform(
    scene.width,
    scene.height,
    drawnCamera,
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

export const identityPreviewTransform: PreviewScreenTransform = Object.freeze({
  scale: 1,
  x: 0,
  y: 0,
});

export function composePreviewTransforms(
  outer: PreviewScreenTransform,
  inner: PreviewScreenTransform,
): PreviewScreenTransform {
  return {
    scale: outer.scale * inner.scale,
    x: outer.scale * inner.x + outer.x,
    y: outer.scale * inner.y + outer.y,
  };
}

export function invertPreviewTransform(transform: PreviewScreenTransform): PreviewScreenTransform {
  const scale = Math.abs(transform.scale) < 1e-12 ? 1 : transform.scale;
  return { scale: 1 / scale, x: -transform.x / scale, y: -transform.y / scale };
}

export function partialPreviewTransform(
  transform: PreviewScreenTransform,
  share: number,
): PreviewScreenTransform {
  const progress = Math.min(1, Math.max(0, share));
  if (progress <= 0) return identityPreviewTransform;
  if (progress >= 1) return transform;
  const { scale, x, y } = transform;
  if (Math.abs(scale - 1) < 1e-9) return { scale: 1, x: x * progress, y: y * progress };
  const scaled = scale ** progress;
  return {
    scale: scaled,
    x: (x / (1 - scale)) * (1 - scaled),
    y: (y / (1 - scale)) * (1 - scaled),
  };
}

export interface PreviewDrawnView {
  camera: PreviewCamera;
  viewport: PreviewViewport;
}

export interface PreviewLayoutSwitchPlan {
  settled: PreviewViewport;
  target: PreviewCamera;
  fitted: boolean;
  offset: PreviewScreenTransform;
}

export function previewLayoutSwitchPlan(
  scene: { width: number; height: number },
  drawn: PreviewDrawnView,
  stage: PreviewScreenTransform,
  shift: number,
  settled: PreviewViewport,
  centred: boolean,
): PreviewLayoutSwitchPlan {
  const { width, height } = scene;
  const start = composePreviewTransforms({ scale: 1, x: shift, y: 0 }, stage);
  const stationary = previewCameraForPlacement(scene, drawn, start, settled);
  const aim = centred ? { ...stationary, centerX: width / 2, centerY: height / 2 } : stationary;
  let target = clampPreviewCamera(aim, width, height, settled);
  const fitted = previewCameraIsCentred(target, width, height) && Math.abs(target.zoom - 1) < 1e-6;
  if (fitted) target = fitPreviewCamera(width, height);
  return {
    settled,
    target,
    fitted,
    offset: composePreviewTransforms(
      start,
      previewScreenTransform(width, height, target, settled, drawn.camera, drawn.viewport),
    ),
  };
}

export function previewLayoutSwitchSettles(
  settled: PreviewViewport,
  viewport: PreviewViewport,
): boolean {
  return (
    (settled.behindEditor ?? false) === (viewport.behindEditor ?? false) &&
    Math.abs(previewVisibleWidth(settled) - previewVisibleWidth(viewport)) < 1.5 &&
    Math.abs(settled.height - viewport.height) < 0.5 &&
    samePreviewFocus(settled, viewport) &&
    samePreviewEditorInsets(settled, viewport)
  );
}

export function previewLayoutSwitchCamera(
  scene: { width: number; height: number },
  plan: Pick<PreviewLayoutSwitchPlan, 'settled' | 'target' | 'fitted'>,
  viewport: PreviewViewport,
): PreviewCamera {
  const { width, height } = scene;
  if (plan.fitted) return fitPreviewCamera(width, height);
  const fit = fitPreviewCamera(width, height);
  const ratio =
    previewScale(width, height, fit, plan.settled) / previewScale(width, height, fit, viewport);
  return clampPreviewCamera(
    { ...plan.target, zoom: plan.target.zoom * ratio },
    width,
    height,
    viewport,
  );
}

export interface PreviewSwitchRestore {
  before: PreviewCamera;
  fitted: boolean;
  after: PreviewCamera;
  behindEditor: boolean;
}

export function previewSwitchRestoreCamera(
  scene: { width: number; height: number },
  restore: PreviewSwitchRestore | null,
  camera: PreviewCamera,
  viewport: PreviewViewport,
): { camera: PreviewCamera; fitted: boolean } | null {
  if (
    !restore ||
    (viewport.behindEditor ?? false) !== restore.behindEditor ||
    camera.centerX !== restore.after.centerX ||
    camera.centerY !== restore.after.centerY ||
    camera.zoom !== restore.after.zoom
  ) {
    return null;
  }
  const { width, height } = scene;
  return {
    fitted: restore.fitted,
    camera: restore.fitted
      ? fitPreviewCamera(width, height)
      : clampPreviewCamera(restore.before, width, height, viewport),
  };
}

export function previewFocusShownShare(
  viewport: Pick<
    PreviewViewport,
    'focusInsetLeft' | 'focusInsetRight' | 'editorInsetLeft' | 'editorInsetRight'
  >,
): number {
  const covered = (viewport.editorInsetLeft ?? 0) + (viewport.editorInsetRight ?? 0);
  if (covered <= 0) return 0;
  const focus = (viewport.focusInsetLeft ?? 0) + (viewport.focusInsetRight ?? 0);
  return Math.min(1, Math.max(0, focus / covered));
}

export function previewMotionFocus(
  covered: { insetLeft: number; insetRight: number },
  shown: number,
): Required<
  Pick<
    PreviewViewport,
    'focusInsetLeft' | 'focusInsetRight' | 'editorInsetLeft' | 'editorInsetRight'
  >
> {
  const share = Math.min(1, Math.max(0, shown));
  return {
    focusInsetLeft: covered.insetLeft * share,
    focusInsetRight: covered.insetRight * share,
    editorInsetLeft: covered.insetLeft,
    editorInsetRight: covered.insetRight,
  };
}

export function previewCameraForPlacement(
  scene: { width: number; height: number },
  drawn: PreviewDrawnView,
  placement: PreviewScreenTransform,
  viewport: PreviewViewport,
): PreviewCamera {
  const { width, height } = scene;
  const scale = placement.scale * previewScale(width, height, drawn.camera, drawn.viewport);
  const zoom = scale / previewScale(width, height, fitPreviewCamera(width, height), viewport);
  const centre = previewViewCenter(viewport);
  const point = screenToMap(
    {
      x: (centre.x - placement.x) / placement.scale,
      y: (centre.y - placement.y) / placement.scale,
    },
    width,
    height,
    drawn.camera,
    drawn.viewport,
  );
  return { zoom, centerX: point.x, centerY: point.y };
}

export function previewLayoutSwitchAnchor(
  scene: { width: number; height: number },
  drawn: PreviewDrawnView,
  camera: PreviewCamera,
  plan: Pick<PreviewLayoutSwitchPlan, 'settled' | 'offset'>,
  share: number,
): PreviewScreenTransform {
  return composePreviewTransforms(
    partialPreviewTransform(plan.offset, 1 - share),
    previewScreenTransform(
      scene.width,
      scene.height,
      drawn.camera,
      drawn.viewport,
      camera,
      plan.settled,
    ),
  );
}
