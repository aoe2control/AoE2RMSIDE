import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export const followThresholdPixels = 24;
export const followGraceMilliseconds = 300;

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface FollowState {
  pinned: boolean;
  unseen: number;
}

export const initialFollowState: FollowState = { pinned: true, unseen: 0 };

export function distanceFromBottom(metrics: ScrollMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop);
}

export function followAfterScroll(state: FollowState, metrics: ScrollMetrics): FollowState {
  const pinned = distanceFromBottom(metrics) <= followThresholdPixels;
  if (pinned) return { pinned: true, unseen: 0 };
  return unpinned(state);
}

export function followAfterRows(
  state: FollowState,
  added: number,
): { state: FollowState; scrollToBottom: boolean } {
  if (state.pinned) return { state, scrollToBottom: true };
  return {
    state: { pinned: false, unseen: state.unseen + Math.max(0, added) },
    scrollToBottom: false,
  };
}

function unpinned(state: FollowState): FollowState {
  return state.pinned ? { pinned: false, unseen: 0 } : state;
}

export interface FollowModel {
  follow: FollowState;
  gestureAt: number;
  downwardAt: number;
  pointerHeld: boolean;
  pointerStartTop: number;
  scrollTop: number;
}

export const initialFollowModel: FollowModel = {
  follow: initialFollowState,
  gestureAt: Number.NEGATIVE_INFINITY,
  downwardAt: Number.NEGATIVE_INFINITY,
  pointerHeld: false,
  pointerStartTop: 0,
  scrollTop: 0,
};

export type ScrollDirection = 'up' | 'down' | 'unknown';

const pinnedAgain: FollowState = { pinned: true, unseen: 0 };

function nearBottom(metrics: ScrollMetrics): boolean {
  return distanceFromBottom(metrics) <= followThresholdPixels;
}

export function userScrolling(model: FollowModel, now: number): boolean {
  return model.pointerHeld || now - model.gestureAt < followGraceMilliseconds;
}

function scrollingDown(model: FollowModel, now: number): boolean {
  return now - model.downwardAt < followGraceMilliseconds;
}

export function followOnGesture(
  model: FollowModel,
  input: { now: number; direction: ScrollDirection; metrics: ScrollMetrics },
): FollowModel {
  if (input.direction === 'down') {
    if (model.pointerHeld) return { ...model, downwardAt: input.now };
    return {
      ...model,
      follow: nearBottom(input.metrics) ? pinnedAgain : model.follow,
      gestureAt: Number.NEGATIVE_INFINITY,
      downwardAt: input.now,
    };
  }
  const follow =
    input.direction === 'up' && input.metrics.scrollTop > 0 ? unpinned(model.follow) : model.follow;
  return { ...model, follow, gestureAt: input.now, downwardAt: Number.NEGATIVE_INFINITY };
}

export function followOnPointer(
  model: FollowModel,
  held: boolean,
  now: number,
  metrics: ScrollMetrics,
): FollowModel {
  if (held) {
    return {
      ...model,
      pointerHeld: true,
      pointerStartTop: metrics.scrollTop,
      gestureAt: now,
      downwardAt: Number.NEGATIVE_INFINITY,
    };
  }
  const movedDown = metrics.scrollTop >= model.pointerStartTop - 0.5;
  if (movedDown && nearBottom(metrics)) {
    return {
      ...model,
      follow: pinnedAgain,
      pointerHeld: false,
      gestureAt: Number.NEGATIVE_INFINITY,
      scrollTop: metrics.scrollTop,
    };
  }
  return { ...model, pointerHeld: false, gestureAt: now };
}

export function followOnScroll(
  model: FollowModel,
  metrics: ScrollMetrics,
  now: number,
): FollowModel {
  const movedUp = metrics.scrollTop < model.scrollTop - 0.5;
  const next = { ...model, scrollTop: metrics.scrollTop };
  if (!movedUp && !model.pointerHeld && scrollingDown(model, now)) {
    return { ...next, follow: nearBottom(metrics) ? pinnedAgain : unpinned(model.follow) };
  }
  if (!userScrolling(model, now))
    return { ...next, follow: followAfterScroll(model.follow, metrics) };
  if (movedUp || !nearBottom(metrics)) {
    return { ...next, follow: unpinned(model.follow) };
  }
  return next;
}

export function followContentChanged(
  previous: { rowCount: number; contentKey: unknown } | null,
  rowCount: number,
  contentKey: unknown,
): boolean {
  return previous === null || previous.rowCount !== rowCount || previous.contentKey !== contentKey;
}

export function followOnRows(
  model: FollowModel,
  added: number,
  now: number,
): { model: FollowModel; scrollToBottom: boolean } {
  const result = followAfterRows(model.follow, added);
  return {
    model: { ...model, follow: result.state },
    scrollToBottom: result.scrollToBottom && !userScrolling(model, now),
  };
}

export function followOnSettle(
  model: FollowModel,
  metrics: ScrollMetrics,
  now: number,
): { model: FollowModel; scrollToBottom: boolean } {
  if (userScrolling(model, now)) return { model, scrollToBottom: false };
  if (model.follow.pinned) return { model, scrollToBottom: true };
  if (nearBottom(metrics)) {
    return { model: { ...model, follow: pinnedAgain }, scrollToBottom: true };
  }
  return { model, scrollToBottom: false };
}

const upwardKeys = new Set(['ArrowUp', 'PageUp', 'Home']);
const scrollKeys = new Set([...upwardKeys, 'ArrowDown', 'PageDown', 'End', ' ']);

export function scrollKeyDirection(key: string, shiftKey: boolean): ScrollDirection | null {
  if (!scrollKeys.has(key)) return null;
  return upwardKeys.has(key) || (key === ' ' && shiftKey) ? 'up' : 'down';
}

export function useFollowBottom(
  rowCount: number,
  contentKey?: unknown,
): {
  ref: (element: HTMLElement | null) => void;
  onScroll(): void;
  state: FollowState;
  jumpToLatest(): void;
} {
  const element = useRef<HTMLElement | null>(null);
  const model = useRef(initialFollowModel);
  const [state, setState] = useState(initialFollowState);
  const lastRowCount = useRef(rowCount);
  const programmatic = useRef(false);
  const observer = useRef<ResizeObserver | null>(null);
  const detachInput = useRef<(() => void) | null>(null);
  const settleTimer = useRef<number | undefined>(undefined);

  const commit = useCallback((next: FollowModel) => {
    const previous = model.current.follow;
    model.current = next;
    if (next.follow.pinned === previous.pinned && next.follow.unseen === previous.unseen) return;
    setState(next.follow);
  }, []);

  const scrollToBottom = useCallback(() => {
    const target = element.current;
    if (!target) return;
    const bottom = target.scrollHeight - target.clientHeight;
    if (Math.abs(target.scrollTop - bottom) < 1) return;
    programmatic.current = true;
    target.scrollTop = bottom;
    model.current = { ...model.current, scrollTop: target.scrollTop };
    window.requestAnimationFrame(() => {
      programmatic.current = false;
    });
  }, []);

  const settle = useCallback(() => {
    window.clearTimeout(settleTimer.current);
    settleTimer.current = undefined;
    const target = element.current;
    if (!target) return;
    const now = performance.now();
    if (model.current.pointerHeld) return;
    const remaining = model.current.gestureAt + followGraceMilliseconds - now;
    if (remaining > 0) {
      settleTimer.current = window.setTimeout(settle, remaining);
      return;
    }
    const result = followOnSettle(model.current, target, now);
    commit(result.model);
    if (result.scrollToBottom) scrollToBottom();
  }, [commit, scrollToBottom]);

  const scheduleSettle = useCallback(() => {
    window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(settle, followGraceMilliseconds);
  }, [settle]);

  const ref = useCallback(
    (next: HTMLElement | null) => {
      observer.current?.disconnect();
      observer.current = null;
      detachInput.current?.();
      detachInput.current = null;
      element.current = next;
      if (!next) return;
      const resize = new ResizeObserver(() => {
        if (model.current.follow.pinned && !userScrolling(model.current, performance.now())) {
          scrollToBottom();
        }
      });
      resize.observe(next);
      for (const child of Array.from(next.children)) resize.observe(child);
      observer.current = resize;
      const gesture = (direction: ScrollDirection) => {
        commit(
          followOnGesture(model.current, { now: performance.now(), direction, metrics: next }),
        );
        if (direction === 'down' && model.current.follow.pinned && !model.current.pointerHeld) {
          scrollToBottom();
        }
        scheduleSettle();
      };
      const onWheel = (event: WheelEvent) => {
        if (event.deltaY !== 0) gesture(event.deltaY < 0 ? 'up' : 'down');
      };
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        const direction = scrollKeyDirection(event.key, event.shiftKey);
        if (direction) gesture(direction);
      };
      const onTouchMove = () => gesture('unknown');
      const onPointerDown = (event: PointerEvent) => {
        if (event.target !== next && event.button !== 1) return;
        commit(followOnPointer(model.current, true, performance.now(), next));
        window.clearTimeout(settleTimer.current);
      };
      const onPointerUp = () => {
        if (!model.current.pointerHeld) return;
        commit(followOnPointer(model.current, false, performance.now(), next));
        if (model.current.follow.pinned) scrollToBottom();
        else scheduleSettle();
      };
      next.addEventListener('wheel', onWheel, { passive: true });
      next.addEventListener('keydown', onKeyDown);
      next.addEventListener('touchmove', onTouchMove, { passive: true });
      next.addEventListener('pointerdown', onPointerDown);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerUp);
      detachInput.current = () => {
        next.removeEventListener('wheel', onWheel);
        next.removeEventListener('keydown', onKeyDown);
        next.removeEventListener('touchmove', onTouchMove);
        next.removeEventListener('pointerdown', onPointerDown);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerUp);
      };
      model.current = { ...model.current, scrollTop: next.scrollTop };
      scrollToBottom();
    },
    [commit, scheduleSettle, scrollToBottom],
  );

  useEffect(
    () => () => {
      observer.current?.disconnect();
      detachInput.current?.();
      window.clearTimeout(settleTimer.current);
    },
    [],
  );

  const lastContent = useRef<{ rowCount: number; contentKey: unknown } | null>(null);
  useLayoutEffect(() => {
    if (!followContentChanged(lastContent.current, rowCount, contentKey)) return;
    lastContent.current = { rowCount, contentKey };
    const added = rowCount - lastRowCount.current;
    lastRowCount.current = rowCount;
    const target = element.current;
    if (target && observer.current) {
      for (const child of Array.from(target.children)) observer.current.observe(child);
    }
    const next = followOnRows(model.current, added, performance.now());
    commit(next.model);
    if (next.scrollToBottom) scrollToBottom();
  }, [commit, contentKey, rowCount, scrollToBottom]);

  const onScroll = useCallback(() => {
    const target = element.current;
    if (!target) return;
    if (programmatic.current) {
      programmatic.current = false;
      model.current = { ...model.current, scrollTop: target.scrollTop };
      return;
    }
    const now = performance.now();
    const scrolling = userScrolling(model.current, now);
    commit(followOnScroll(model.current, target, now));
    if (scrolling) scheduleSettle();
    else if (model.current.follow.pinned) scrollToBottom();
  }, [commit, scheduleSettle, scrollToBottom]);

  const jumpToLatest = useCallback(() => {
    window.clearTimeout(settleTimer.current);
    commit({
      ...model.current,
      follow: pinnedAgain,
      gestureAt: Number.NEGATIVE_INFINITY,
      downwardAt: Number.NEGATIVE_INFINITY,
      pointerHeld: false,
    });
    scrollToBottom();
  }, [commit, scrollToBottom]);

  return { ref, onScroll, state, jumpToLatest };
}
