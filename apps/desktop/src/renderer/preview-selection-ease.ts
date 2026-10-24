import type { MapRectangleEdges } from './preview-raised-overlays';
import type { PreviewSelection } from './top-down-preview';

export const selectionFollowFallbackMilliseconds = 40;

export const selectionFollowMaxStepMilliseconds = 34;

const settleDistance = 1e-3;

export function selectionEdges(selection: PreviewSelection): MapRectangleEdges {
  return {
    minimumX: selection.minimumX,
    minimumY: selection.minimumY,
    maximumX: selection.maximumX + 1,
    maximumY: selection.maximumY + 1,
  };
}

export function easeSelectionEdges(
  current: MapRectangleEdges,
  target: MapRectangleEdges,
  elapsedMilliseconds: number,
  timeConstantMilliseconds: number,
): MapRectangleEdges {
  if (!(timeConstantMilliseconds > 0)) return { ...target };
  const share = 1 - Math.exp(-Math.max(0, elapsedMilliseconds) / timeConstantMilliseconds);
  const edge = (from: number, to: number) => {
    const next = from + (to - from) * share;
    return Math.abs(to - next) <= settleDistance ? to : next;
  };
  return {
    minimumX: edge(current.minimumX, target.minimumX),
    minimumY: edge(current.minimumY, target.minimumY),
    maximumX: edge(current.maximumX, target.maximumX),
    maximumY: edge(current.maximumY, target.maximumY),
  };
}

export function sameEdges(first: MapRectangleEdges, second: MapRectangleEdges): boolean {
  return (
    first.minimumX === second.minimumX &&
    first.minimumY === second.minimumY &&
    first.maximumX === second.maximumX &&
    first.maximumY === second.maximumY
  );
}

export interface SelectionEaseOptions {
  timeConstant(): number;
  redraw(): void;
  now?: () => number;
  frames?: {
    request(callback: (time: number) => void): number;
    cancel(handle: number): void;
  };
}

export class SelectionEase {
  private target: PreviewSelection | null = null;
  private current: MapRectangleEdges | null = null;
  private frame: number | null = null;
  private lastStep = 0;
  private lastFrame: number | null = null;

  constructor(private readonly options: SelectionEaseOptions) {}

  get easing(): boolean {
    return this.frame !== null;
  }

  begin(target: PreviewSelection): void {
    this.cancelFrame();
    this.target = target;
    this.current = selectionEdges(target);
  }

  follow(target: PreviewSelection): void {
    if (!this.target || !this.current) {
      this.begin(target);
      return;
    }
    this.target = target;
    const goal = selectionEdges(target);
    if (sameEdges(this.current, goal)) return;
    if (!(this.options.timeConstant() > 0)) {
      this.cancelFrame();
      this.current = goal;
      return;
    }
    if (this.frame === null) {
      this.lastStep = this.now();
      this.lastFrame = null;
      this.frame = this.requestFrame();
    }
  }

  release(target: PreviewSelection): void {
    this.follow(target);
  }

  end(): void {
    this.cancelFrame();
    this.target = null;
    this.current = null;
  }

  drawn(selection: PreviewSelection): MapRectangleEdges {
    const target = this.target;
    if (
      this.current &&
      target &&
      target.minimumX === selection.minimumX &&
      target.minimumY === selection.minimumY &&
      target.maximumX === selection.maximumX &&
      target.maximumY === selection.maximumY
    ) {
      return this.current;
    }
    return selectionEdges(selection);
  }

  destroy(): void {
    this.end();
  }

  private step = (time?: number): void => {
    this.frame = null;
    if (!this.target || !this.current) return;
    const now = this.now();
    const frameTime = typeof time === 'number' && Number.isFinite(time) ? time : null;
    const raw =
      frameTime !== null && this.lastFrame !== null
        ? frameTime - this.lastFrame
        : now - this.lastStep;
    const elapsed = Math.min(Math.max(0, raw), selectionFollowMaxStepMilliseconds);
    this.lastStep = now;
    this.lastFrame = frameTime;
    const goal = selectionEdges(this.target);
    this.current = easeSelectionEdges(this.current, goal, elapsed, this.options.timeConstant());
    if (!sameEdges(this.current, goal)) this.frame = this.requestFrame();
    this.options.redraw();
  };

  private requestFrame(): number {
    return this.options.frames
      ? this.options.frames.request(this.step)
      : requestAnimationFrame(this.step);
  }

  private cancelFrame(): void {
    if (this.frame === null) return;
    if (this.options.frames) this.options.frames.cancel(this.frame);
    else cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  private now(): number {
    return this.options.now?.() ?? performance.now();
  }
}
