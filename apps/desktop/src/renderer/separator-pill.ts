export type SeparatorOrientation = 'vertical' | 'horizontal';

export function separatorPillCentre(
  pointer: number,
  trackLength: number,
  pillLength: number,
): number {
  const half = pillLength / 2;
  if (!Number.isFinite(pointer) || trackLength <= pillLength) return Math.max(0, trackLength) / 2;
  return Math.min(trackLength - half, Math.max(half, pointer));
}

export interface PillFollowState {
  position: number;
  velocity: number;
}

export const separatorPillMaxStepMilliseconds = 50;

const restDistance = 0.05;
const restVelocity = 0.005;

export function stepSeparatorPill(
  state: PillFollowState,
  target: number,
  elapsed: number,
  smoothing: number,
): PillFollowState {
  if (!(smoothing > 0)) return { position: target, velocity: 0 };
  const step = Math.min(separatorPillMaxStepMilliseconds, Math.max(0, elapsed));
  const omega = 2 / smoothing;
  const x = omega * step;
  const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = state.position - target;
  const pull = (state.velocity + omega * change) * step;
  let velocity = (state.velocity - omega * pull) * decay;
  let position = target + (change + pull) * decay;
  if ((change > 0 && position < target) || (change < 0 && position > target)) {
    position = target;
    velocity = 0;
  }
  if (Math.abs(position - target) < restDistance && Math.abs(velocity) < restVelocity) {
    return { position: target, velocity: 0 };
  }
  return { position, velocity };
}

export function separatorPillResting(state: PillFollowState, target: number): boolean {
  return state.position === target && state.velocity === 0;
}

export interface SeparatorPillOptions {
  smoothing(): number;
}

export function attachSeparatorPill(
  separator: HTMLElement,
  track: HTMLElement,
  pill: HTMLElement,
  orientation: SeparatorOrientation,
  options: SeparatorPillOptions,
): () => void {
  const vertical = orientation === 'vertical';
  let hovered = false;
  let dragging = false;
  let visible = false;
  let pointer: number | null = null;
  let state: PillFollowState = { position: Number.NaN, velocity: 0 };
  let snap = true;
  let smoothing = options.smoothing();
  let frame: number | null = null;
  let lastTime: number | null = null;

  const place = (position: number, pillLength: number) => {
    const offset = position - pillLength / 2;
    pill.style.transform = vertical
      ? `translate3d(0, ${offset}px, 0)`
      : `translate3d(${offset}px, 0, 0)`;
  };

  const tick = (time: number) => {
    frame = null;
    const bounds = track.getBoundingClientRect();
    const trackLength = vertical ? bounds.height : bounds.width;
    const pillLength = vertical ? pill.offsetHeight : pill.offsetWidth;
    const start = vertical ? bounds.top : bounds.left;
    const target = separatorPillCentre(
      pointer === null ? trackLength / 2 : pointer - start,
      trackLength,
      pillLength,
    );
    const elapsed = lastTime === null ? 1000 / 60 : time - lastTime;
    lastTime = time;
    state =
      snap || !Number.isFinite(state.position)
        ? { position: target, velocity: 0 }
        : stepSeparatorPill(state, target, elapsed, smoothing);
    snap = false;
    place(state.position, pillLength);
    if (separatorPillResting(state, target)) lastTime = null;
    else frame = requestAnimationFrame(tick);
  };

  const request = () => {
    if (frame === null) frame = requestAnimationFrame(tick);
  };

  const update = () => {
    pill.dataset.dragging = String(dragging);
    const next = hovered || dragging;
    if (next === visible) return;
    if (next) snap = true;
    visible = next;
    pill.dataset.visible = String(next);
  };

  const follow = (event: PointerEvent) => {
    pointer = vertical ? event.clientY : event.clientX;
    request();
  };

  const onEnter = (event: PointerEvent) => {
    smoothing = options.smoothing();
    hovered = true;
    update();
    follow(event);
  };
  const onMove = (event: PointerEvent) => {
    if (!hovered && !dragging) {
      hovered = true;
      update();
    }
    follow(event);
  };
  const onLeave = () => {
    hovered = false;
    update();
  };
  const onDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    dragging = true;
    update();
    follow(event);
  };
  const onRelease = (event: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    const hit = separator.ownerDocument.elementFromPoint(event.clientX, event.clientY);
    hovered = hit !== null && separator.contains(hit);
    update();
  };
  pill.dataset.visible = 'false';
  pill.dataset.dragging = 'false';
  separator.addEventListener('pointerenter', onEnter);
  separator.addEventListener('pointermove', onMove);
  separator.addEventListener('pointerleave', onLeave);
  separator.addEventListener('pointerdown', onDown);
  separator.addEventListener('pointerup', onRelease);
  separator.addEventListener('pointercancel', onRelease);
  separator.addEventListener('lostpointercapture', onRelease);
  request();
  return () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    separator.removeEventListener('pointerenter', onEnter);
    separator.removeEventListener('pointermove', onMove);
    separator.removeEventListener('pointerleave', onLeave);
    separator.removeEventListener('pointerdown', onDown);
    separator.removeEventListener('pointerup', onRelease);
    separator.removeEventListener('pointercancel', onRelease);
    separator.removeEventListener('lostpointercapture', onRelease);
  };
}
