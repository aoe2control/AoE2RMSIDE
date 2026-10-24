import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FollowBottom } from './follow-bottom';

export const estimatedProblemRowHeight = 27;
export const problemWindowOverscanPixels = 400;
export const problemWindowMarginPixels = 100;
export const problemWindowInitialRows = 30;

export interface RowRange {
  start: number;
  end: number;
}

const emptyRange: RowRange = { start: 0, end: 0 };

export function averageRowHeight(heights: Iterable<number>): number {
  let total = 0;
  let count = 0;
  for (const height of heights) {
    total += height;
    count += 1;
  }
  return count === 0 ? estimatedProblemRowHeight : total / count;
}

export function rowOffsets(
  keys: readonly string[],
  heights: ReadonlyMap<string, number>,
  estimate: number,
): Float64Array {
  const offsets = new Float64Array(keys.length + 1);
  for (let index = 0; index < keys.length; index += 1) {
    offsets[index + 1] = offsets[index]! + (heights.get(keys[index]!) ?? estimate);
  }
  return offsets;
}

function firstRowEndingAfter(offsets: Float64Array, y: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (offsets[middle + 1]! > y) high = middle;
    else low = middle + 1;
  }
  return low;
}

export function rowsBetween(offsets: Float64Array, top: number, bottom: number): RowRange {
  const count = offsets.length - 1;
  if (count === 0 || bottom <= 0 || top >= offsets[count]! || bottom <= top) {
    return emptyRange;
  }
  const start = firstRowEndingAfter(offsets, top);
  let end = firstRowEndingAfter(offsets, bottom);
  if (end < count && offsets[end]! < bottom) end += 1;
  return { start, end: Math.max(start, end) };
}

export function nextRowRange(
  current: RowRange | undefined,
  offsets: Float64Array,
  viewTop: number,
  viewBottom: number,
): RowRange {
  const count = offsets.length - 1;
  const needed = rowsBetween(
    offsets,
    viewTop - problemWindowMarginPixels,
    viewBottom + problemWindowMarginPixels,
  );
  if (current && current.end <= count) {
    if (needed.start === needed.end) {
      if (current.start === current.end) return current;
    } else if (current.start <= needed.start && current.end >= needed.end) {
      return current;
    }
  }
  if (needed.start === needed.end) return emptyRange;
  return rowsBetween(
    offsets,
    viewTop - problemWindowOverscanPixels,
    viewBottom + problemWindowOverscanPixels,
  );
}

export function mergeRowRanges(ranges: readonly RowRange[], count: number): RowRange[] {
  const sorted = ranges
    .map((range) => ({
      start: Math.max(0, Math.min(count, range.start)),
      end: Math.max(0, Math.min(count, range.end)),
    }))
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start);
  const merged: RowRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

export type RowSlot =
  { kind: 'gap'; start: number; height: number } | { kind: 'rows'; start: number; end: number };

export function rowSlots(offsets: Float64Array, ranges: readonly RowRange[]): RowSlot[] {
  const count = offsets.length - 1;
  const slots: RowSlot[] = [];
  let next = 0;
  for (const range of mergeRowRanges(ranges, count)) {
    if (range.start > next) {
      slots.push({ kind: 'gap', start: next, height: offsets[range.start]! - offsets[next]! });
    }
    slots.push({ kind: 'rows', start: range.start, end: range.end });
    next = range.end;
  }
  if (next < count) {
    slots.push({ kind: 'gap', start: next, height: offsets[count]! - offsets[next]! });
  }
  return slots;
}

export interface WindowGroup {
  uri: string;
  keys: readonly string[];
  open: boolean;
}

type SelectionEdge = { row: string } | { group: string } | 'first' | 'last';

export interface ProblemRowWindow {
  listRef(element: HTMLElement | null): void;
  onScroll(): void;
  containerRef(uri: string, element: HTMLElement | null): void;
  measureRow(key: string, element: HTMLElement): () => void;
  onFocus(target: EventTarget): void;
  onBlur(next: EventTarget | null): void;
  slots(uri: string): RowSlot[];
}

export function useProblemRowWindow(
  groups: readonly WindowGroup[],
  follow: Pick<FollowBottom, 'following' | 'keepAtBottom'>,
): ProblemRowWindow {
  const list = useRef<HTMLElement | null>(null);
  const containers = useRef(new Map<string, HTMLElement>());
  const heights = useRef(new Map<string, number>());
  const rowKeys = useRef(new WeakMap<Element, string>());
  const rowElements = useRef(new Map<string, HTMLElement>());
  const anchor = useRef<'follow' | { key: string; top: number } | null>(null);
  const [measured, setMeasured] = useState(0);
  const [ranges, setRanges] = useState<ReadonlyMap<string, RowRange>>(() => new Map());
  const [focused, setFocused] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ first: SelectionEdge; last: SelectionEdge } | null>(
    null,
  );

  const offsets = useMemo(() => {
    const estimate = averageRowHeight(heights.current.values());
    return new Map(
      groups.map((group) => [group.uri, rowOffsets(group.keys, heights.current, estimate)]),
    );
  }, [groups, measured]);

  const latest = useRef({ follow, groups, offsets, ranges });
  latest.current = { follow, groups, offsets, ranges };

  const update = useCallback(() => {
    const element = list.current;
    if (!element) return;
    const state = latest.current;
    const viewTop = element.scrollTop;
    const viewBottom = viewTop + element.clientHeight;
    const listTop = element.getBoundingClientRect().top - element.clientTop;
    let changed = false;
    const next = new Map<string, RowRange>();
    for (const group of state.groups) {
      const current = state.ranges.get(group.uri);
      const container = containers.current.get(group.uri);
      const groupOffsets = state.offsets.get(group.uri);
      if (!group.open || !container || !groupOffsets) {
        if (current) changed = true;
        continue;
      }
      const top = container.getBoundingClientRect().top - listTop + viewTop;
      const range = nextRowRange(current, groupOffsets, viewTop - top, viewBottom - top);
      if (current && range.start === current.start && range.end === current.end) {
        next.set(group.uri, current);
      } else {
        changed = true;
        next.set(group.uri, range);
      }
    }
    if (next.size !== state.ranges.size) changed = true;
    if (changed) setRanges(next);
  }, []);

  const captureAnchor = () => {
    const element = list.current;
    if (!element || anchor.current) return;
    if (latest.current.follow.following()) {
      anchor.current = 'follow';
      return;
    }
    const viewTop = element.getBoundingClientRect().top;
    let best: { key: string; top: number } | null = null;
    for (const [key, row] of rowElements.current) {
      const box = row.getBoundingClientRect();
      if (box.height === 0 || box.bottom <= viewTop) continue;
      if (!best || box.top - viewTop < best.top) best = { key, top: box.top - viewTop };
    }
    anchor.current = best;
  };
  const restoreAnchor = () => {
    const kept = anchor.current;
    anchor.current = null;
    const element = list.current;
    if (!kept || !element) return;
    if (kept === 'follow') {
      latest.current.follow.keepAtBottom();
      return;
    }
    const row = rowElements.current.get(kept.key);
    if (!row) return;
    const moved = row.getBoundingClientRect().top - element.getBoundingClientRect().top - kept.top;
    if (Math.abs(moved) >= 0.5) element.scrollTop += moved;
  };

  const rowObserver = useRef<ResizeObserver | null>(null);
  const observer = () => {
    rowObserver.current ??= new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const key = rowKeys.current.get(entry.target);
        if (key === undefined) continue;
        const height =
          entry.borderBoxSize?.[0]?.blockSize ?? (entry.target as HTMLElement).offsetHeight;
        if (height <= 0) continue;
        const previous = heights.current.get(key);
        if (previous !== undefined && Math.abs(previous - height) < 0.25) continue;
        if (!changed) captureAnchor();
        heights.current.set(key, height);
        changed = true;
      }
      if (changed) setMeasured((count) => count + 1);
    });
    return rowObserver.current;
  };

  const measureRow = useCallback((key: string, element: HTMLElement) => {
    rowKeys.current.set(element, key);
    rowElements.current.set(key, element);
    const rows = observer();
    rows.observe(element);
    return () => {
      rows.unobserve(element);
      rowKeys.current.delete(element);
      if (rowElements.current.get(key) === element) rowElements.current.delete(key);
    };
  }, []);

  const listObserver = useRef<ResizeObserver | null>(null);
  const listRef = useCallback(
    (element: HTMLElement | null) => {
      listObserver.current?.disconnect();
      listObserver.current = null;
      list.current = element;
      if (!element) return;
      const resize = new ResizeObserver(() => update());
      resize.observe(element);
      listObserver.current = resize;
    },
    [update],
  );

  const containerRef = useCallback((uri: string, element: HTMLElement | null) => {
    if (element) containers.current.set(uri, element);
    else containers.current.delete(uri);
  }, []);

  useLayoutEffect(() => {
    restoreAnchor();
    update();
  }, [offsets, update]);

  useLayoutEffect(() => {
    latest.current.follow.keepAtBottom();
  }, [ranges, focused, selection]);

  useEffect(() => {
    const known = heights.current;
    let total = 0;
    for (const group of groups) total += group.keys.length;
    if (known.size <= total * 2 + 200) return;
    const current = new Set(groups.flatMap((group) => group.keys));
    for (const key of [...known.keys()]) if (!current.has(key)) known.delete(key);
  }, [groups]);

  useEffect(
    () => () => {
      rowObserver.current?.disconnect();
      listObserver.current?.disconnect();
    },
    [],
  );

  const rowKeyOf = useCallback((target: EventTarget | Node | null): string | null => {
    let node: Node | null = target instanceof Node ? target : null;
    while (node && node !== list.current) {
      if (node instanceof Element) {
        const key = rowKeys.current.get(node);
        if (key !== undefined) return key;
      }
      node = node.parentNode;
    }
    return null;
  }, []);

  const onFocus = useCallback(
    (target: EventTarget) => {
      const key = rowKeyOf(target);
      setFocused((current) => (current === key ? current : key));
    },
    [rowKeyOf],
  );
  const onBlur = useCallback((next: EventTarget | null) => {
    if (next instanceof Node && list.current?.contains(next)) return;
    if (next === null && !document.hasFocus()) return;
    setFocused(null);
  }, []);

  useEffect(() => {
    const edgeOf = (node: Node, side: 'first' | 'last'): SelectionEdge => {
      const element = list.current;
      if (!element || !element.contains(node)) return side;
      const row = rowKeyOf(node);
      if (row !== null) return { row };
      const start = node instanceof Element ? node : node.parentElement;
      const group = start?.closest<HTMLElement>('[data-problem-group]')?.dataset.problemGroup;
      return group === undefined ? side : { group };
    };
    const sameEdge = (left: SelectionEdge, right: SelectionEdge) =>
      typeof left === 'string' || typeof right === 'string'
        ? left === right
        : 'row' in left && 'row' in right
          ? left.row === right.row
          : 'group' in left && 'group' in right && left.group === right.group;
    const change = () => {
      const element = list.current;
      const current = document.getSelection();
      let next: { first: SelectionEdge; last: SelectionEdge } | null = null;
      if (element && current && current.rangeCount > 0 && !current.isCollapsed) {
        const range = current.getRangeAt(0);
        if (range.intersectsNode(element)) {
          next = {
            first: edgeOf(range.startContainer, 'first'),
            last: edgeOf(range.endContainer, 'last'),
          };
        }
      }
      setSelection((previous) =>
        previous === next ||
        (previous &&
          next &&
          sameEdge(previous.first, next.first) &&
          sameEdge(previous.last, next.last))
          ? previous
          : next,
      );
    };
    document.addEventListener('selectionchange', change);
    return () => document.removeEventListener('selectionchange', change);
  }, [rowKeyOf]);

  const selected = useMemo(() => {
    if (!selection) return null;
    const starts = new Map<string, number>();
    const rows = new Map<string, number>();
    let total = 0;
    for (const group of groups) {
      starts.set(group.uri, total);
      group.keys.forEach((key, index) => rows.set(key, total + index));
      total += group.keys.length;
    }
    const position = (edge: SelectionEdge, side: 'first' | 'last'): number => {
      if (edge === 'first') return 0;
      if (edge === 'last') return total - 1;
      if ('row' in edge) return rows.get(edge.row) ?? (side === 'first' ? 0 : total - 1);
      const start = starts.get(edge.group);
      if (start === undefined) return side === 'first' ? 0 : total - 1;
      return side === 'first' ? start : start - 1;
    };
    return {
      first: position(selection.first, 'first'),
      last: position(selection.last, 'last'),
      starts,
    };
  }, [groups, selection]);

  const slots = useCallback(
    (uri: string): RowSlot[] => {
      const group = groups.find((candidate) => candidate.uri === uri);
      const groupOffsets = offsets.get(uri);
      if (!group || !group.open || !groupOffsets) return [];
      const count = group.keys.length;
      const drawn: RowRange[] = [
        ranges.get(uri) ?? { start: 0, end: Math.min(count, problemWindowInitialRows) },
      ];
      if (focused !== null) {
        const index = group.keys.indexOf(focused);
        if (index >= 0) drawn.push({ start: index, end: index + 1 });
      }
      if (selected && selected.last >= selected.first) {
        const start = selected.starts.get(uri) ?? 0;
        drawn.push({ start: selected.first - start, end: selected.last - start + 1 });
      }
      return rowSlots(groupOffsets, drawn);
    },
    [focused, groups, offsets, ranges, selected],
  );

  return { containerRef, listRef, measureRow, onBlur, onFocus, onScroll: update, slots };
}
