import { useEffect, useMemo, useRef, type FocusEvent } from 'react';

export const editorNoticeDurationMilliseconds = 4_000;
export const editorNoticeMaximumDurationMilliseconds = 10_000;
const editorNoticeBaseMilliseconds = 1_500;
const editorNoticeMillisecondsPerCharacter = 60;

export function editorNoticeDurationFor(text: string): number {
  const characters = text.replace(/\s+/gu, ' ').trim().length;
  return Math.min(
    editorNoticeMaximumDurationMilliseconds,
    Math.max(
      editorNoticeDurationMilliseconds,
      editorNoticeBaseMilliseconds + characters * editorNoticeMillisecondsPerCharacter,
    ),
  );
}

export const editorNoticeResumeMinimumMilliseconds = 1_000;

export type NoticeHoldReason = 'pointer' | 'focus';

export interface NoticeTimerScheduler {
  setTimeout(callback: () => void, milliseconds: number): number;
  clearTimeout(handle: number): void;
  now(): number;
}

const windowScheduler: NoticeTimerScheduler = {
  setTimeout: (callback, milliseconds) => window.setTimeout(callback, milliseconds),
  clearTimeout: (handle) => window.clearTimeout(handle),
  now: () => Date.now(),
};

export class NoticeAutoDismissTimer {
  private remaining: number;
  private startedAt: number | null = null;
  private handle: number | null = null;
  private readonly holds = new Set<NoticeHoldReason>();
  private disposed = false;

  constructor(
    private readonly onElapsed: () => void,
    duration: number = editorNoticeDurationMilliseconds,
    private readonly resumeMinimum: number = editorNoticeResumeMinimumMilliseconds,
    private readonly scheduler: NoticeTimerScheduler = windowScheduler,
  ) {
    this.remaining = duration;
    this.schedule();
  }

  get paused(): boolean {
    return this.holds.size > 0;
  }

  remainingMilliseconds(): number {
    if (this.startedAt === null) return this.remaining;
    return Math.max(0, this.remaining - (this.scheduler.now() - this.startedAt));
  }

  hold(reason: NoticeHoldReason): void {
    if (this.disposed || this.holds.has(reason)) return;
    this.holds.add(reason);
    if (this.holds.size > 1) return;
    this.remaining = this.remainingMilliseconds();
    this.startedAt = null;
    this.cancel();
  }

  release(reason: NoticeHoldReason): void {
    if (this.disposed || !this.holds.delete(reason) || this.holds.size > 0) return;
    this.remaining = Math.max(this.remaining, this.resumeMinimum);
    this.schedule();
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }

  private schedule(): void {
    this.cancel();
    this.startedAt = this.scheduler.now();
    this.handle = this.scheduler.setTimeout(() => {
      this.handle = null;
      if (this.disposed) return;
      this.disposed = true;
      this.onElapsed();
    }, this.remaining);
  }

  private cancel(): void {
    if (this.handle === null) return;
    this.scheduler.clearTimeout(this.handle);
    this.handle = null;
  }
}

export interface NoticeHoldHandlers {
  onPointerEnter(): void;
  onPointerLeave(): void;
  onFocus(): void;
  onBlur(event: FocusEvent<HTMLElement>): void;
}

export function useNoticeAutoDismiss(
  notice: unknown,
  onDismiss: () => void,
  duration: number = editorNoticeDurationMilliseconds,
): NoticeHoldHandlers {
  const timer = useRef<NoticeAutoDismissTimer | null>(null);
  const holds = useRef(new Set<NoticeHoldReason>());
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;

  useEffect(() => {
    if (!notice) {
      holds.current.clear();
      return undefined;
    }
    const next = new NoticeAutoDismissTimer(() => dismiss.current(), duration);
    for (const reason of holds.current) next.hold(reason);
    timer.current = next;
    return () => {
      next.dispose();
      if (timer.current === next) timer.current = null;
    };
  }, [notice]);

  return useMemo(() => {
    const hold = (reason: NoticeHoldReason) => {
      holds.current.add(reason);
      timer.current?.hold(reason);
    };
    const release = (reason: NoticeHoldReason) => {
      holds.current.delete(reason);
      timer.current?.release(reason);
    };
    return {
      onPointerEnter: () => hold('pointer'),
      onPointerLeave: () => release('pointer'),
      onFocus: () => hold('focus'),
      onBlur: (event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) return;
        release('focus');
      },
    };
  }, []);
}
