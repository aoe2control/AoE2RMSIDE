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
    this.pending = { value };
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => this.flush(), this.intervalMilliseconds);
  }

  flush(): void {
    if (this.disposed) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const pending = this.pending;
    this.pending = undefined;
    if (pending) this.publish(pending.value);
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
    this.disposed = true;
  }
}
