import type { PreviewGenerationEvent } from '../shared/api';
import {
  maximumGenerationEventBytes,
  maximumGenerationEvents,
} from '../shared/generation-event-bounds';

export class GenerationEventBoundError extends Error {
  constructor(
    readonly bound: 'events' | 'bytes',
    readonly maximumEvents: number,
    readonly maximumBytes: number,
  ) {
    super(
      `rmsd generation events exceed the collection bound of ${maximumEvents} events and ` +
        `${maximumBytes} encoded bytes`,
    );
    this.name = 'GenerationEventBoundError';
  }
}

export class GenerationEventCollector {
  private kept: PreviewGenerationEvent[] = [];
  private bytes = 0;
  private overflowBound: 'events' | 'bytes' | undefined;

  constructor(
    private readonly maximumEvents = maximumGenerationEvents,
    private readonly maximumBytes = maximumGenerationEventBytes,
  ) {}

  accept(event: PreviewGenerationEvent, encodedBytes: number): boolean {
    if (this.overflowBound) return false;
    if (!Number.isSafeInteger(encodedBytes) || encodedBytes < 0) {
      throw new Error('generation event size is invalid');
    }
    if (this.kept.length >= this.maximumEvents) {
      this.overflow('events');
      return false;
    }
    if (encodedBytes > this.maximumBytes - this.bytes) {
      this.overflow('bytes');
      return false;
    }
    this.kept.push(event);
    this.bytes += encodedBytes;
    return true;
  }

  get overflowed(): boolean {
    return this.overflowBound !== undefined;
  }

  get encodedBytes(): number {
    return this.bytes;
  }

  get events(): PreviewGenerationEvent[] {
    if (this.overflowBound) throw this.overflowError();
    return this.kept;
  }

  overflowError(): GenerationEventBoundError {
    return new GenerationEventBoundError(
      this.overflowBound ?? 'events',
      this.maximumEvents,
      this.maximumBytes,
    );
  }

  private overflow(bound: 'events' | 'bytes'): void {
    this.overflowBound = bound;
    this.kept = [];
    this.bytes = 0;
  }
}
