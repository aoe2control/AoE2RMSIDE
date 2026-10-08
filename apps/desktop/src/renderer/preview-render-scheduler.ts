import type { Container } from 'pixi.js';

export interface PreviewRenderFrames {
  request(callback: (time: number) => void): number;
  cancel(handle: number): void;
}

export interface PreviewRenderSchedulerOptions {
  frames?: PreviewRenderFrames;
  verify?: () => boolean;
  frameHash?: () => number | null;
  verifyDelayMilliseconds?: number;
  timers?: {
    set(callback: () => void, milliseconds: number): number;
    clear(handle: number): void;
  };
  onFrame?(scheduler: PreviewRenderScheduler): void;
}

const renderPriority = -25;

export interface PreviewRenderStatistics {
  requests: number;
  renders: number;
  checks: number;
  staleFrames: number;
}

export class PreviewRenderScheduler {
  private frame: number | null = null;
  private verifyTimer: number | null = null;
  private presentedHash: number | null = null;
  private destroyed = false;
  private readonly before: (() => void)[] = [];
  private readonly after: (() => void)[] = [];
  private readonly frames: PreviewRenderFrames;
  readonly statistics: PreviewRenderStatistics = {
    requests: 0,
    renders: 0,
    checks: 0,
    staleFrames: 0,
  };

  constructor(
    private readonly draw: () => void,
    private readonly options: PreviewRenderSchedulerOptions = {},
  ) {
    this.frames = options.frames ?? {
      request: (callback) => requestAnimationFrame(callback),
      cancel: (handle) => cancelAnimationFrame(handle),
    };
  }

  get pending(): boolean {
    return this.frame !== null;
  }

  request(): void {
    if (this.destroyed) return;
    this.statistics.requests += 1;
    this.cancelVerify();
    if (this.frame !== null) return;
    this.frame = this.frames.request(() => {
      this.frame = null;
      this.renderNow();
    });
  }

  renderNow(): void {
    if (this.destroyed) return;
    if (this.frame !== null) {
      this.frames.cancel(this.frame);
      this.frame = null;
    }
    this.cancelVerify();
    for (const listener of this.before.splice(0)) listener();
    this.draw();
    this.statistics.renders += 1;
    const verifying = this.options.verify?.() ?? false;
    this.presentedHash = verifying ? (this.options.frameHash?.() ?? null) : null;
    for (const listener of this.after.splice(0)) listener();
    this.options.onFrame?.(this);
    if (verifying) this.scheduleVerify();
  }

  addOnce(listener: () => void, context?: unknown, priority = 0): this {
    const bound = context === undefined ? listener : () => listener.call(context);
    (priority >= renderPriority ? this.before : this.after).push(bound);
    this.request();
    return this;
  }

  private scheduleVerify(): void {
    const timers = this.options.timers ?? {
      set: (callback: () => void, milliseconds: number) =>
        globalThis.setTimeout(callback, milliseconds) as unknown as number,
      clear: (handle: number) => globalThis.clearTimeout(handle),
    };
    this.verifyTimer = timers.set(() => {
      this.verifyTimer = null;
      this.verifyNow();
    }, this.options.verifyDelayMilliseconds ?? 150);
  }

  private cancelVerify(): void {
    if (this.verifyTimer === null) return;
    const clear =
      this.options.timers?.clear ?? ((handle: number) => globalThis.clearTimeout(handle));
    clear(this.verifyTimer);
    this.verifyTimer = null;
  }

  verifyNow(): void {
    if (this.destroyed || this.frame !== null || !(this.options.verify?.() ?? false)) return;
    const presented = this.presentedHash;
    this.draw();
    const redrawn = this.options.frameHash?.() ?? null;
    this.statistics.checks += 1;
    if (presented !== null && redrawn !== null && presented !== redrawn) {
      this.statistics.staleFrames += 1;
    }
    this.presentedHash = redrawn;
    this.options.onFrame?.(this);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.frame !== null) this.frames.cancel(this.frame);
    this.frame = null;
    this.cancelVerify();
    this.before.length = 0;
    this.after.length = 0;
  }
}

const schedulers = new WeakMap<object, PreviewRenderScheduler>();

export function attachPreviewRenderScheduler(
  stage: Container,
  scheduler: PreviewRenderScheduler,
): void {
  schedulers.set(stage, scheduler);
}

export function detachPreviewRenderScheduler(stage: Container): void {
  schedulers.delete(stage);
}

export function previewRenderSchedulerOf(
  node: Container | null | undefined,
): PreviewRenderScheduler | undefined {
  let current: Container | null | undefined = node;
  while (current) {
    const scheduler = schedulers.get(current);
    if (scheduler) return scheduler;
    current = current.parent;
  }
  return undefined;
}

export function requestPreviewRender(node: Container | null | undefined): void {
  previewRenderSchedulerOf(node)?.request();
}

export function framePixelHash(pixels: Uint8Array): number {
  const words = new Uint32Array(
    pixels.buffer,
    pixels.byteOffset,
    Math.floor(pixels.byteLength / 4),
  );
  let hash = 0x811c9dc5;
  for (let index = 0; index < words.length; index += 1) {
    hash = Math.imul(hash ^ words[index]!, 0x01000193) >>> 0;
  }
  return hash;
}
