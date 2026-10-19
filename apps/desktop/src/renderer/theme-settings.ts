export interface EdgeOverflow {
  left: boolean;
  right: boolean;
}

export const schemeDragThreshold = 4;

export function schemeDragStarted(deltaX: number, deltaY: number): boolean {
  return Math.hypot(deltaX, deltaY) > schemeDragThreshold;
}

export function schemeDragScrollLeft(
  startScrollLeft: number,
  startX: number,
  pointerX: number,
): number {
  return startScrollLeft - (pointerX - startX);
}

export function horizontalOverflow(
  scroller: Pick<HTMLElement, 'scrollLeft' | 'scrollWidth' | 'clientWidth'>,
  rightToLeft: boolean,
): EdgeOverflow {
  const range = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
  const fromStart = Math.min(range, Math.abs(scroller.scrollLeft));
  const before = fromStart > 1;
  const after = range - fromStart > 1;
  return rightToLeft ? { left: after, right: before } : { left: before, right: after };
}

export const schemeFlingTimeConstant = 325;

export const schemeWheelTimeConstant = 110;

export const schemeFlingMinimumVelocity = 0.1;

export const schemeFlingSampleWindow = 100;

export const schemeFlingRestTime = 60;

export interface SchemeScrollSample {
  time: number;
  scrollLeft: number;
}

export function schemeReleaseVelocity(
  samples: readonly SchemeScrollSample[],
  releaseTime: number,
): number {
  const last = samples.at(-1);
  if (!last || releaseTime - last.time > schemeFlingRestTime) return 0;
  const recent = samples.filter((sample) => last.time - sample.time <= schemeFlingSampleWindow);
  const first = recent[0];
  if (!first || recent.length < 2 || last.time <= first.time) return 0;
  return (last.scrollLeft - first.scrollLeft) / (last.time - first.time);
}

export function schemeMomentumStep(
  position: number,
  velocity: number,
  elapsed: number,
  timeConstant: number,
): { position: number; velocity: number } {
  const decay = Math.exp(-Math.max(0, elapsed) / timeConstant);
  return {
    position: position + velocity * timeConstant * (1 - decay),
    velocity: velocity * decay,
  };
}

export function schemeMomentumTarget(
  position: number,
  velocity: number,
  timeConstant: number,
): number {
  return position + velocity * timeConstant;
}

export function schemeLandingVelocity(
  position: number,
  velocity: number,
  timeConstant: number,
  minimum: number,
  maximum: number,
): number {
  const target = Math.min(
    maximum,
    Math.max(minimum, schemeMomentumTarget(position, velocity, timeConstant)),
  );
  return (target - position) / timeConstant;
}

export function schemeMomentumSettled(velocity: number, timeConstant: number): boolean {
  return Math.abs(velocity * timeConstant) < 0.5;
}

export function isNotchedWheel(event: {
  deltaMode: number;
  deltaY: number;
  wheelDeltaY?: number;
}): boolean {
  if (event.deltaMode !== 0) return true;
  if (Math.abs(event.deltaY) < 50) return false;
  if (event.wheelDeltaY === undefined) return Number.isInteger(event.deltaY);
  return event.wheelDeltaY !== 0 && event.wheelDeltaY % 120 === 0;
}
