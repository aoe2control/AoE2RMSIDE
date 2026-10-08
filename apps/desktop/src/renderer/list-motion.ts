import { motionDuration, motionEasing, motionNumber, prefersReducedMotion } from './motion';

export interface KeyedListDiff {
  entered: string[];
  left: string[];
  kept: string[];
  reordered: boolean;
}

export function diffKeyedList(previous: readonly string[], next: readonly string[]): KeyedListDiff {
  const previousKeys = new Set(previous);
  const nextKeys = new Set(next);
  const entered = next.filter((key) => !previousKeys.has(key));
  const left = previous.filter((key) => !nextKeys.has(key));
  const kept = next.filter((key) => previousKeys.has(key));
  const previousKept = previous.filter((key) => nextKeys.has(key));
  const reordered = kept.some((key, index) => previousKept[index] !== key);
  return { entered, kept, left, reordered };
}

export function staggerDelay(index: number, step: number, maximum: number): number {
  if (index <= 0 || step <= 0) return 0;
  return Math.min(index * step, Math.max(0, maximum));
}

export class MotionCoalescer {
  private last = Number.NEGATIVE_INFINITY;

  constructor(private readonly windowMs: number) {}

  admit(now: number): boolean {
    const animate = now - this.last >= this.windowMs;
    this.last = now;
    return animate;
  }
}

export const listMotionBurstMs = 100;

export type ListMotionPhase = 'running' | 'settled';

export class ListMotionPhaseTracker {
  private generation = 0;

  constructor(private readonly apply: (phase: ListMotionPhase) => void) {}

  begin(motions: readonly Promise<unknown>[]): void {
    const generation = ++this.generation;
    if (motions.length === 0) {
      this.apply('settled');
      return;
    }
    this.apply('running');
    void Promise.allSettled(motions).then(() => {
      if (generation === this.generation) this.apply('settled');
    });
  }
}

export type ListMotionAnchor = 'top' | 'bottom';

export interface RowGeometry {
  rowsTop: number;
  rowTop: number;
  scrollTop: number;
  shellHeight: number;
}

export function anchoredRowOffset(geometry: RowGeometry, anchor: ListMotionAnchor): number {
  const fromTop = geometry.rowsTop + geometry.rowTop - geometry.scrollTop;
  return anchor === 'top' ? fromTop : fromTop - geometry.shellHeight;
}

export function ghostPlacement(
  offset: number,
  height: number,
  anchor: ListMotionAnchor,
): { top: number } | { bottom: number } {
  return anchor === 'top' ? { top: offset } : { bottom: 0 - (offset + height) };
}

export function valueTickDirection(before: string, after: string): -1 | 1 {
  const parse = (text: string) => Number.parseFloat(text.replace(/,/gu, ''));
  return parse(after) < parse(before) ? -1 : 1;
}

export function shellHeightEase(
  drawn: number,
  target: number,
  reduced: boolean,
): [number, number] | null {
  if (reduced || !Number.isFinite(drawn) || Math.abs(drawn - target) < 0.5) return null;
  return [drawn, target];
}

const motionIds = {
  count: 'rmside-list-count',
  enter: 'rmside-list-enter',
  ghost: 'rmside-list-leave',
  height: 'rmside-list-height',
  move: 'rmside-list-move',
} as const;

export const listMotionAnimationIds: readonly string[] = Object.values(motionIds);

interface RowSnapshot {
  cells: number[];
  element: HTMLElement;
  height: number;
  left: number;
  top: number;
  values: string[];
  width: number;
}

interface ListSnapshot {
  columns: string;
  keys: string[];
  rows: Map<string, RowSnapshot>;
  rowsLeft: number;
  rowsTop: number;
  scrollTop: number;
  shellHeight: number;
}

export interface ListMotionElements {
  shell: HTMLElement;
  rows: HTMLElement;
  ghosts: HTMLElement;
}

export interface ListMotionOptions {
  rowSelector: string;
  keyAttribute: string;
  valueSelector: string;
  ghostClassName: string;
  anchor?: ListMotionAnchor;
  ghostLayout?: 'grid' | 'table-row';
  ghostOmittedAttributes?: readonly string[];
  beforeMeasure?: () => void;
  stackByAppearance?: boolean;
  skipUnrendered?: boolean;
  cullToShell?: boolean;
}

export function rowDrawnInside(offset: number, height: number, shellHeight: number): boolean {
  return offset + height > 0 && offset < shellHeight;
}

export function appearanceOrder(
  known: ReadonlyMap<string, number>,
  keys: readonly string[],
): Map<string, number> {
  const kept = keys.filter((key) => known.has(key)).sort((a, b) => known.get(a)! - known.get(b)!);
  const added = keys.filter((key) => !known.has(key));
  return new Map([...kept, ...added].map((key, index) => [key, index + 1]));
}

export function coveredShares(
  boxes: readonly { top: number; bottom: number; z: number }[],
): number[] {
  return boxes.map((box) => {
    const height = box.bottom - box.top;
    if (height <= 0) return 0;
    let covered = 0;
    for (const other of boxes) {
      if (other === box || other.z <= box.z) continue;
      const overlap = Math.min(box.bottom, other.bottom) - Math.max(box.top, other.top);
      covered = Math.max(covered, overlap / height);
    }
    return Math.max(0, Math.min(1, covered));
  });
}

const ghostStrippedAttributes = ['id', 'tabindex', 'role', 'data-testid'];

export class ListMotion {
  private snapshot: ListSnapshot | null = null;
  private stack = new Map<string, number>();
  private coverFrame = 0;
  private coverElements: ListMotionElements | null = null;
  private readonly coalescer = new MotionCoalescer(listMotionBurstMs);
  private shell: HTMLElement | null = null;
  private scroller: HTMLElement | null = null;
  private readonly resize =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
          if (this.shell && this.snapshot && this.settled) {
            this.snapshot.shellHeight = shellHeight(this.shell);
          }
        });
  private settled = true;
  private readonly phase = new ListMotionPhaseTracker((phase) => {
    this.settled = phase === 'settled';
    if (!this.shell) return;
    this.shell.dataset.listMotion = phase;
    if (phase === 'settled') delete this.shell.dataset.listOverflow;
  });
  private readonly onScroll = () => {
    const rows = this.scroller;
    if (rows && this.snapshot && this.settled) this.snapshot.scrollTop = rows.scrollTop;
  };

  constructor(private readonly options: ListMotionOptions) {}

  private get anchor(): ListMotionAnchor {
    return this.options.anchor ?? 'top';
  }

  reset(elements?: ListMotionElements): void {
    this.snapshot = null;
    if (elements) {
      this.attach(elements);
      this.settle(elements);
      this.phase.begin([]);
    }
  }

  record(elements: ListMotionElements): void {
    this.attach(elements);
    const previous = this.snapshot;
    this.snapshot = this.measure(elements);
    if (this.options.stackByAppearance) {
      this.stack = appearanceOrder(previous ? this.stack : new Map(), this.snapshot.keys);
    }
  }

  update(elements: ListMotionElements, now = performance.now()): void {
    this.attach(elements);
    const motions = this.animate(elements, now);
    this.phase.begin(motions);
    if (this.options.stackByAppearance) this.coverWhileMoving(elements);
  }

  private coverWhileMoving(elements: ListMotionElements): void {
    this.coverElements = elements;
    this.cover(elements);
    if (this.coverFrame) return;
    const frame = () => {
      this.coverFrame = 0;
      const current = this.coverElements;
      if (!current) return;
      this.cover(current);
      if (!this.settled) this.coverFrame = requestAnimationFrame(frame);
    };
    if (!this.settled) this.coverFrame = requestAnimationFrame(frame);
  }

  private cover(elements: ListMotionElements): void {
    const rows = [...elements.rows.querySelectorAll<HTMLElement>(this.options.rowSelector)].map(
      (element) => ({ element, z: Number(element.style.zIndex) || 0 }),
    );
    const ghosts = [...elements.ghosts.children]
      .filter((element): element is HTMLElement => element instanceof HTMLElement)
      .map((element) => ({ element, z: -1 }));
    const drawn = [...rows, ...ghosts];
    const shares = this.settled
      ? drawn.map(() => 0)
      : coveredShares(
          drawn.map(({ element, z }) => {
            const box = element.getBoundingClientRect();
            return { bottom: box.bottom, top: box.top, z };
          }),
        );
    drawn.forEach(({ element }, index) => {
      const share = shares[index]!;
      if (share > 0) element.style.setProperty('--list-row-cover', share.toFixed(3));
      else element.style.removeProperty('--list-row-cover');
    });
  }

  private attach(elements: ListMotionElements): void {
    if (this.shell !== elements.shell) {
      if (this.shell) this.resize?.unobserve(this.shell);
      this.resize?.observe(elements.shell);
    }
    this.shell = elements.shell;
    if (this.scroller === elements.rows) return;
    this.scroller?.removeEventListener('scroll', this.onScroll);
    this.scroller = elements.rows;
    this.scroller.addEventListener('scroll', this.onScroll, { passive: true });
  }

  private animate(elements: ListMotionElements, now: number): Promise<unknown>[] {
    const previous = this.snapshot;
    const running = elements.shell
      .getAnimations()
      .find((animation) => animation.id === motionIds.height && animation.playState !== 'finished');
    const drawnHeight = running
      ? shellHeight(elements.shell)
      : (previous?.shellHeight ?? Number.NaN);
    const drawnShift = new Map<Element, number>();
    for (const animation of elements.shell.getAnimations({ subtree: true })) {
      const target = (animation.effect as KeyframeEffect | null)?.target;
      if (animation.id === motionIds.move && target instanceof HTMLElement) {
        drawnShift.set(target, translateY(target));
      }
    }
    for (const animation of elements.shell.getAnimations()) {
      if (animation.id === motionIds.height) animation.finish();
    }
    delete elements.shell.dataset.listOverflow;
    this.options.beforeMeasure?.();
    const next = this.measure(elements);
    this.snapshot = next;
    if (this.options.stackByAppearance) {
      this.stack = appearanceOrder(previous ? this.stack : new Map(), next.keys);
      for (const [key, row] of next.rows) row.element.style.zIndex = String(this.stack.get(key));
    }
    if (!previous) {
      this.settle(elements);
      return [];
    }
    const reduced = prefersReducedMotion();
    if (reduced) {
      this.settle(elements);
      return [];
    }
    const motions: Promise<unknown>[] = [];
    const diff = diffKeyedList(previous.keys, next.keys);
    if (diff.entered.length > 0 || diff.left.length > 0 || this.changed(previous, next)) {
      const burst = !this.coalescer.admit(now);
      motions.push(...this.animateRows(elements, previous, next, diff, drawnShift, burst));
    }
    for (const animation of elements.shell.getAnimations({ subtree: true })) {
      if (animation.id !== motionIds.height && listMotionAnimationIds.includes(animation.id)) {
        motions.push(animation.finished);
      }
    }
    const ease = shellHeightEase(drawnHeight, next.shellHeight, false);
    const fits = layoutFits(elements.rows);
    if (ease && fits) elements.shell.dataset.listOverflow = 'clip';
    if (ease) {
      const animation = elements.shell.animate(
        ease.map((height) => ({ height: `${height}px` })),
        {
          duration: motionDuration('--motion-duration-list-height', 180),
          easing: motionEasing('--motion-ease-out', 'cubic-bezier(0.16, 1, 0.3, 1)'),
          id: motionIds.height,
        },
      );
      const shell = elements.shell;
      const unclip = () => {
        const easing = shell
          .getAnimations()
          .some((running) => running.id === motionIds.height && running.playState !== 'finished');
        if (!easing) delete shell.dataset.listOverflow;
      };
      motions.push(animation.finished.then(unclip, unclip));
    }
    return motions;
  }

  private animateRows(
    elements: ListMotionElements,
    previous: ListSnapshot,
    next: ListSnapshot,
    diff: KeyedListDiff,
    drawnShift: ReadonlyMap<Element, number>,
    burst: boolean,
  ): Promise<unknown>[] {
    const motions: Promise<unknown>[] = [];
    const track = (animation: Animation | undefined) => {
      if (animation) motions.push(animation.finished);
    };
    const itemDuration = motionDuration('--motion-duration-list-item', 140);
    const moveDuration = motionDuration('--motion-duration-list-move', 160);
    const staggerStep = motionDuration('--motion-stagger-list', 12);
    const staggerMaximum = motionDuration('--motion-stagger-list-max', 48);
    const easeOut = motionEasing('--motion-ease-out', 'cubic-bezier(0.16, 1, 0.3, 1)');
    const easeMove = motionEasing('--motion-ease-move', 'cubic-bezier(0.2, 0, 0, 1)');
    const easeIn = motionEasing('--motion-ease-in', 'cubic-bezier(0.4, 0, 1, 1)');
    const travel = motionNumber('--motion-distance-list-item', 4);
    const inside = (list: ListSnapshot, row: RowSnapshot) =>
      !this.options.cullToShell ||
      rowDrawnInside(list.rowsTop + row.top - list.scrollTop, row.height, list.shellHeight);

    for (const key of diff.kept) {
      const before = previous.rows.get(key);
      const after = next.rows.get(key);
      if (!before || !after) continue;
      if (!inside(previous, before) && !inside(next, after)) {
        for (const animation of after.element.getAnimations()) {
          if (animation.id === motionIds.move) animation.cancel();
        }
        continue;
      }
      const drawn = this.drawnOffset(previous, before) + (drawnShift.get(after.element) ?? 0);
      const offset = drawn - this.drawnOffset(next, after);
      for (const animation of after.element.getAnimations()) {
        if (animation.id === motionIds.move) animation.cancel();
      }
      if (Math.abs(offset) >= 0.5) {
        track(
          after.element.animate(
            [{ transform: `translateY(${offset}px)` }, { transform: 'translateY(0)' }],
            { composite: 'add', duration: moveDuration, easing: easeMove, id: motionIds.move },
          ),
        );
      }
      const values = after.element.querySelectorAll<HTMLElement>(this.options.valueSelector);
      after.values.forEach((text, index) => {
        const was = before.values[index];
        if (was === undefined || was === text || (burst && was !== '')) return;
        const direction = valueTickDirection(was, text);
        track(
          values[index]?.animate(
            [
              { opacity: 0, transform: `translateY(${direction * travel}px)` },
              { opacity: 1, transform: 'translateY(0)' },
            ],
            { duration: itemDuration, easing: easeOut, id: motionIds.count },
          ),
        );
      });
    }

    diff.entered
      .filter((key) => {
        const row = next.rows.get(key);
        return row !== undefined && inside(next, row);
      })
      .forEach((key, index) => {
        const element = next.rows.get(key)?.element;
        if (!element) return;
        track(
          element.animate(
            [
              { opacity: 0, transform: `translateX(${-travel}px)` },
              { opacity: 1, transform: 'translateX(0)' },
            ],
            {
              delay: burst ? 0 : staggerDelay(index, staggerStep, staggerMaximum),
              duration: itemDuration,
              easing: easeOut,
              fill: 'backwards',
              id: motionIds.enter,
            },
          ),
        );
      });

    for (const key of diff.left) {
      const before = previous.rows.get(key);
      if (!before || !inside(previous, before)) continue;
      const ghost = this.ghost(before, previous);
      elements.ghosts.append(ghost);
      const leave = ghost.animate(
        [
          { opacity: 1, transform: 'translateX(0)' },
          { opacity: 0, transform: `translateX(${-travel}px)` },
        ],
        { duration: itemDuration, easing: easeIn, fill: 'forwards', id: motionIds.ghost },
      );
      motions.push(
        leave.finished.then(
          () => ghost.remove(),
          () => ghost.remove(),
        ),
      );
    }

    return motions;
  }

  private drawnOffset(list: ListSnapshot, row: RowSnapshot): number {
    return anchoredRowOffset(
      {
        rowTop: row.top,
        rowsTop: list.rowsTop,
        scrollTop: list.scrollTop,
        shellHeight: list.shellHeight,
      },
      this.anchor,
    );
  }

  private changed(previous: ListSnapshot, next: ListSnapshot): boolean {
    for (const [key, row] of next.rows) {
      const before = previous.rows.get(key);
      if (!before) return true;
      if (Math.abs(this.drawnOffset(previous, before) - this.drawnOffset(next, row)) >= 0.5) {
        return true;
      }
      if (before.values.join('\u0000') !== row.values.join('\u0000')) return true;
    }
    return false;
  }

  private ghost(before: RowSnapshot, previous: ListSnapshot): HTMLElement {
    const ghost = document.createElement('div');
    ghost.className = this.options.ghostClassName;
    const omitted = new Set([
      ...ghostStrippedAttributes,
      `data-${kebab(this.options.keyAttribute)}`,
      ...(this.options.ghostOmittedAttributes ?? []),
    ]);
    if (this.options.ghostLayout === 'table-row') {
      const row = before.element.cloneNode(true) as HTMLElement;
      stripGhostAttributes(row, omitted);
      [...row.children].forEach((cell, index) => {
        if (!(cell instanceof HTMLElement)) return;
        cell.style.maxWidth = 'none';
        cell.style.width = `${before.cells[index] ?? cell.offsetWidth}px`;
      });
      Object.assign(ghost.style, { borderSpacing: '0', display: 'table', tableLayout: 'fixed' });
      ghost.append(row);
    } else {
      for (const attribute of before.element.getAttributeNames()) {
        if (attribute.startsWith('data-') && !omitted.has(attribute)) {
          ghost.setAttribute(attribute, before.element.getAttribute(attribute) ?? '');
        }
      }
      for (const child of before.element.childNodes) ghost.append(child.cloneNode(true));
      for (const child of ghost.children) stripGhostAttributes(child, omitted);
      ghost.style.gridTemplateColumns = previous.columns;
    }
    const offset = this.drawnOffset(previous, before);
    const placement = ghostPlacement(offset, before.height, this.anchor);
    Object.assign(ghost.style, {
      height: `${before.height}px`,
      left: `${previous.rowsLeft + before.left}px`,
      width: `${before.width}px`,
      ...('top' in placement
        ? { top: `${placement.top}px` }
        : { bottom: `${placement.bottom}px`, top: 'auto' }),
    });
    return ghost;
  }

  private settle(elements: ListMotionElements): void {
    for (const animation of elements.shell.getAnimations({ subtree: true })) {
      if (listMotionAnimationIds.includes(animation.id)) animation.finish();
    }
    elements.ghosts.replaceChildren();
  }

  private measure(elements: ListMotionElements): ListSnapshot {
    const rows = new Map<string, RowSnapshot>();
    const keys: string[] = [];
    const tableRows = this.options.ghostLayout === 'table-row';
    for (const element of elements.rows.querySelectorAll<HTMLElement>(this.options.rowSelector)) {
      const key = element.dataset[this.options.keyAttribute];
      if (!key || rows.has(key)) continue;
      if (this.options.skipUnrendered && element.offsetParent === null) continue;
      keys.push(key);
      const offset = offsetWithin(element, elements.rows);
      rows.set(key, {
        cells: tableRows
          ? [...element.children].map((cell) =>
              cell instanceof HTMLElement ? cell.offsetWidth : 0,
            )
          : [],
        element,
        height: element.offsetHeight,
        left: offset.left,
        top: offset.top,
        values: [...element.querySelectorAll(this.options.valueSelector)].map((value) =>
          value.hasAttribute('data-provisional') ? '' : (value.textContent ?? ''),
        ),
        width: element.offsetWidth,
      });
    }
    return {
      columns: tableRows ? '' : getComputedStyle(elements.rows).gridTemplateColumns,
      keys,
      rows,
      rowsLeft: elements.rows.offsetLeft,
      rowsTop: elements.rows.offsetTop,
      scrollTop: elements.rows.scrollTop,
      shellHeight: shellHeight(elements.shell),
    };
  }
}

function layoutFits(rows: HTMLElement): boolean {
  return layoutScrollHeight(rows) - rows.clientHeight <= 1;
}

export function layoutScrollHeight(rows: HTMLElement): number {
  let extent = 0;
  for (const child of rows.children) {
    if (child instanceof HTMLElement) {
      extent = Math.max(extent, child.offsetTop + child.offsetHeight);
    }
  }
  return extent + (Number.parseFloat(getComputedStyle(rows).paddingBottom) || 0);
}

function translateY(element: HTMLElement): number {
  const transform = getComputedStyle(element).transform;
  return transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m42;
}

function shellHeight(shell: HTMLElement): number {
  const height = Number.parseFloat(getComputedStyle(shell).height);
  return Number.isFinite(height) ? height : shell.offsetHeight;
}

function offsetWithin(element: HTMLElement, container: HTMLElement): { left: number; top: number } {
  let left = 0;
  let top = 0;
  let node: Element | null = element;
  while (node instanceof HTMLElement && node !== container) {
    left += node.offsetLeft;
    top += node.offsetTop;
    node = node.offsetParent;
  }
  return { left, top };
}

function stripGhostAttributes(root: Element, omitted: ReadonlySet<string>): void {
  for (const element of [root, ...root.querySelectorAll('*')]) {
    for (const attribute of element.getAttributeNames()) {
      if (
        omitted.has(attribute) ||
        (attribute.startsWith('aria-') && attribute !== 'aria-hidden')
      ) {
        element.removeAttribute(attribute);
      }
    }
  }
}

function kebab(value: string): string {
  return value.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
}
