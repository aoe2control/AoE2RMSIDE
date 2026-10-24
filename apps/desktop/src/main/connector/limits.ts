import type { ConnectorCatalogTool, ConnectorLimits } from './catalog';

const minuteMilliseconds = 60_000;

export class SlidingWindow {
  private readonly stamps: number[] = [];

  constructor(
    private readonly capacity: number,
    private readonly windowMilliseconds: number,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error('window capacity must be a positive integer');
    }
  }

  retryAfterSeconds(now: number): number {
    while (this.stamps.length > 0 && this.stamps[0]! <= now - this.windowMilliseconds) {
      this.stamps.shift();
    }
    if (this.stamps.length < this.capacity) return 0;
    const frees = this.stamps[0]! + this.windowMilliseconds - now;
    return Math.max(1, Math.ceil(frees / 1000));
  }

  record(now: number): void {
    this.stamps.push(now);
    if (this.stamps.length > this.capacity) this.stamps.shift();
  }
}

export type LimitRefusal =
  | { code: 'too_many_calls'; message: string; hint: string }
  | { code: 'rate_limited'; message: string; hint: string; retryAfterSeconds: number };

export function isPictureTool(tool: Pick<ConnectorCatalogTool, 'output'>): boolean {
  return tool.output.image;
}

export class ConnectionLimits {
  private running = 0;
  private readonly calls: SlidingWindow;
  private readonly pictures: SlidingWindow;

  constructor(
    private readonly limits: Pick<
      ConnectorLimits,
      'callsInFlight' | 'callsPerMinute' | 'picturesPerMinute'
    >,
    private readonly now: () => number = Date.now,
  ) {
    this.calls = new SlidingWindow(limits.callsPerMinute, minuteMilliseconds);
    this.pictures = new SlidingWindow(limits.picturesPerMinute, minuteMilliseconds);
  }

  get inFlight(): number {
    return this.running;
  }

  admit(tool: Pick<ConnectorCatalogTool, 'output'>): LimitRefusal | null {
    if (this.running >= this.limits.callsInFlight) {
      return {
        code: 'too_many_calls',
        message: `At most ${this.limits.callsInFlight} calls can run at once.`,
        hint: 'Wait for a running call to finish.',
      };
    }
    const now = this.now();
    const callWait = this.calls.retryAfterSeconds(now);
    const pictureWait = isPictureTool(tool) ? this.pictures.retryAfterSeconds(now) : 0;
    if (callWait > 0 || pictureWait > 0) {
      const pictures = pictureWait >= callWait;
      return {
        code: 'rate_limited',
        message: pictures
          ? `At most ${this.limits.picturesPerMinute} pictures per minute.`
          : `At most ${this.limits.callsPerMinute} calls per minute.`,
        hint: 'Wait, then try again.',
        retryAfterSeconds: Math.max(callWait, pictureWait),
      };
    }
    this.calls.record(now);
    if (isPictureTool(tool)) this.pictures.record(now);
    this.running += 1;
    return null;
  }

  release(): void {
    if (this.running > 0) this.running -= 1;
  }
}
