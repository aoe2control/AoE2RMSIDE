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
