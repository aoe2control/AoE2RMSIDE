export const tabDragThreshold = 4;

export const tabAutoScrollEdge = 40;

export const tabAutoScrollMaximumStep = 14;

export interface TabSlot {
  id: string;
  left: number;
  width: number;
}

export interface TabDropPlacement {
  sourceId: string;
  targetId: string;
  placement: 'before' | 'after';
}

export function tabDragStarted(deltaX: number, deltaY: number): boolean {
  return Math.hypot(deltaX, deltaY) > tabDragThreshold;
}

function slotGap(slots: readonly TabSlot[]): number {
  const [first, second] = slots;
  if (!first || !second) return 0;
  return Math.max(0, second.left - (first.left + first.width));
}

export function tabDragOrder<T>(
  items: readonly T[],
  draggedIndex: number,
  targetIndex: number,
): T[] {
  const next = [...items];
  const [dragged] = next.splice(draggedIndex, 1);
  if (dragged === undefined) return [...items];
  next.splice(targetIndex, 0, dragged);
  return next;
}

export function tabDragLayout(
  slots: readonly TabSlot[],
  draggedIndex: number,
  targetIndex: number,
): number[] {
  const lefts = slots.map((slot) => slot.left);
  const first = slots[0];
  if (!first) return lefts;
  const gap = slotGap(slots);
  const order = tabDragOrder(
    slots.map((_, index) => index),
    draggedIndex,
    targetIndex,
  );
  let cursor = first.left;
  for (const index of order) {
    lefts[index] = cursor;
    cursor += slots[index]!.width + gap;
  }
  return lefts;
}

export function tabDragOffset(
  slots: readonly TabSlot[],
  draggedIndex: number,
  travel: number,
): number {
  const dragged = slots[draggedIndex];
  const first = slots[0];
  const last = slots[slots.length - 1];
  if (!dragged || !first || !last) return 0;
  const minimum = first.left - dragged.left;
  const maximum = last.left + last.width - dragged.width - dragged.left;
  return Math.min(maximum, Math.max(minimum, travel));
}

export function tabDragTargetIndex(
  slots: readonly TabSlot[],
  draggedIndex: number,
  offset: number,
): number {
  const dragged = slots[draggedIndex];
  if (!dragged) return draggedIndex;
  const drawnLeft = dragged.left + offset;
  let best = draggedIndex;
  let bestDistance = Math.abs(offset);
  for (let index = 0; index < slots.length; index += 1) {
    if (index === draggedIndex) continue;
    const left = tabDragLayout(slots, draggedIndex, index)[draggedIndex]!;
    const distance = Math.abs(drawnLeft - left);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}

export function tabDragSeparators(
  slots: readonly TabSlot[],
  draggedIndex: number,
  targetIndex: number,
  activeIds: ReadonlySet<string>,
): boolean[] {
  const separators = slots.map(() => false);
  const plain = (index: number) => index !== draggedIndex && !activeIds.has(slots[index]?.id ?? '');
  const order = tabDragOrder(
    slots.map((_, index) => index),
    draggedIndex,
    targetIndex,
  );
  for (let place = 1; place < order.length; place += 1) {
    const index = order[place]!;
    separators[index] = plain(index) && plain(order[place - 1]!);
  }
  return separators;
}

export function tabDropPlacement(
  ids: readonly string[],
  draggedIndex: number,
  targetIndex: number,
): TabDropPlacement | null {
  const sourceId = ids[draggedIndex];
  if (sourceId === undefined || targetIndex === draggedIndex) return null;
  const order = tabDragOrder(ids, draggedIndex, targetIndex);
  const before = order[targetIndex - 1];
  if (before !== undefined) return { sourceId, targetId: before, placement: 'after' };
  const after = order[targetIndex + 1];
  return after === undefined ? null : { sourceId, targetId: after, placement: 'before' };
}

export function tabAutoScrollStep(pointerX: number, left: number, right: number): number {
  const edge = Math.min(tabAutoScrollEdge, (right - left) / 3);
  if (edge <= 0) return 0;
  const depth = (distance: number) =>
    Math.ceil(Math.min(1, Math.max(0, (edge - distance) / edge)) * tabAutoScrollMaximumStep);
  if (pointerX < left + edge) return -depth(pointerX - left);
  if (pointerX > right - edge) return depth(right - pointerX);
  return 0;
}

export interface TabDragFrame {
  offset: number;
  targetIndex: number;
  shifts: number[];
}

export class TabDrag {
  private travel = 0;
  private ended = false;

  constructor(
    readonly slots: readonly TabSlot[],
    readonly draggedIndex: number,
    private readonly startPointerX: number,
    private readonly startScrollLeft: number,
  ) {}

  get draggedId(): string {
    return this.slots[this.draggedIndex]?.id ?? '';
  }

  move(pointerX: number, scrollLeft: number): TabDragFrame {
    if (!this.ended) {
      this.travel = pointerX - this.startPointerX + (scrollLeft - this.startScrollLeft);
    }
    return this.frame();
  }

  frame(): TabDragFrame {
    const offset = this.ended ? 0 : tabDragOffset(this.slots, this.draggedIndex, this.travel);
    const targetIndex = this.ended
      ? this.draggedIndex
      : tabDragTargetIndex(this.slots, this.draggedIndex, offset);
    const lefts = tabDragLayout(this.slots, this.draggedIndex, targetIndex);
    const shifts = this.slots.map((slot, index) =>
      index === this.draggedIndex ? offset : lefts[index]! - slot.left,
    );
    return { offset, targetIndex, shifts };
  }

  release(): TabDropPlacement | null {
    if (this.ended) return null;
    const { targetIndex } = this.frame();
    this.ended = true;
    return tabDropPlacement(
      this.slots.map((slot) => slot.id),
      this.draggedIndex,
      targetIndex,
    );
  }

  cancel(): void {
    this.ended = true;
    this.travel = 0;
  }
}
