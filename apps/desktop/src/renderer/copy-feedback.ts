export const copyFeedbackMilliseconds = 1_600;

export interface CopyFeedbackTimers {
  setTimeout(callback: () => void, milliseconds: number): number;
  clearTimeout(handle: number): void;
}

const globalTimers: CopyFeedbackTimers = {
  setTimeout: (callback, milliseconds) =>
    globalThis.setTimeout(callback, milliseconds) as unknown as number,
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

export class CopyFeedback {
  private timer: number | null = null;
  private shown = false;

  constructor(
    private readonly onChange: (copied: boolean) => void,
    private readonly timers: CopyFeedbackTimers = globalTimers,
    private readonly milliseconds = copyFeedbackMilliseconds,
  ) {}

  get copied(): boolean {
    return this.shown;
  }

  confirm(): void {
    this.clearTimer();
    this.set(true);
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.set(false);
    }, this.milliseconds);
  }

  reset(): void {
    this.clearTimer();
    this.set(false);
  }

  dispose(): void {
    this.clearTimer();
  }

  async run(copy: () => Promise<void>, onFailure?: (error: unknown) => void): Promise<boolean> {
    try {
      await copy();
    } catch (error) {
      this.reset();
      onFailure?.(error);
      return false;
    }
    this.confirm();
    return true;
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  private set(copied: boolean): void {
    if (this.shown === copied) return;
    this.shown = copied;
    this.onChange(copied);
  }
}
