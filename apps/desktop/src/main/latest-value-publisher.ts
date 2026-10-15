export class LatestValuePublisher<T> {
  private pending: { value: T } | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    private readonly publish: (value: T) => void,
    private readonly intervalMilliseconds: number,
  ) {
    if (!Number.isFinite(intervalMilliseconds) || intervalMilliseconds < 0) {
      throw new Error('latest-value publish interval must be non-negative');
    }
  }

  offer(value: T): void {
    if (this.disposed) return;
    if (this.timer !== undefined) {
      this.pending = { value };
      return;
    }
    this.emit(value);
  }

  reset(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
  }

  dispose(): void {
    this.reset();
    this.disposed = true;
  }

  private emit(value: T): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const pending = this.pending;
      this.pending = undefined;
      if (pending) this.emit(pending.value);
    }, this.intervalMilliseconds);
    this.publish(value);
  }
}
