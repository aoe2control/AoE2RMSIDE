export const installationReadConcurrency = 2;

export interface InstallationReadQueueOptions {
  concurrency?: number;
  isBusy: (error: unknown) => boolean;
  retries?: number;
  initialDelayMilliseconds?: number;
  maximumDelayMilliseconds?: number;
}

export interface InstallationReadOptions<T> {
  id?: string;
  cancelled?: () => T;
}

export class InstallationReadCancelledError extends Error {
  constructor() {
    super('the installation data read was cancelled');
    this.name = 'InstallationReadCancelledError';
  }
}

const cancelledMarker: unique symbol = Symbol('cancelled');

interface Entry {
  id: string | undefined;
  cancelled: boolean;
  started: boolean;
  wake: (() => void) | null;
  begin: () => void;
  abandon: () => void;
}

export class InstallationReadQueue {
  private readonly concurrency: number;
  private readonly retries: number;
  private readonly initialDelay: number;
  private readonly maximumDelay: number;
  private readonly waiting: Entry[] = [];
  private readonly entries = new Set<Entry>();
  private running = 0;

  constructor(private readonly options: InstallationReadQueueOptions) {
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? installationReadConcurrency));
    this.retries = Math.max(0, Math.floor(options.retries ?? 8));
    this.initialDelay = Math.max(0, options.initialDelayMilliseconds ?? 100);
    this.maximumDelay = Math.max(this.initialDelay, options.maximumDelayMilliseconds ?? 2000);
  }

  get active(): number {
    return this.running;
  }

  get queued(): number {
    return this.waiting.length;
  }

  run<T>(attempt: () => Promise<T>, options: InstallationReadOptions<T> = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const settleCancelled = () => {
        if (options.cancelled) resolve(options.cancelled());
        else reject(new InstallationReadCancelledError());
      };
      const entry: Entry = {
        id: options.id,
        cancelled: false,
        started: false,
        wake: null,
        begin: () => {
          void this.execute(entry, attempt)
            .then((value) => (value === cancelledMarker ? settleCancelled() : resolve(value as T)))
            .catch(reject)
            .finally(() => {
              this.running -= 1;
              this.entries.delete(entry);
              this.pump();
            });
        },
        abandon: settleCancelled,
      };
      this.entries.add(entry);
      this.waiting.push(entry);
      this.pump();
    });
  }

  cancel(id: string): boolean {
    let found = false;
    let inFlight = false;
    for (const entry of [...this.entries]) {
      if (entry.id !== id) continue;
      found = true;
      entry.cancelled = true;
      if (!entry.started) {
        const index = this.waiting.indexOf(entry);
        if (index >= 0) this.waiting.splice(index, 1);
        this.entries.delete(entry);
        entry.abandon();
      } else if (entry.wake) {
        entry.wake();
      } else {
        inFlight = true;
      }
    }
    return found && !inFlight;
  }

  private pump(): void {
    while (this.running < this.concurrency && this.waiting.length > 0) {
      const entry = this.waiting.shift()!;
      this.running += 1;
      entry.started = true;
      entry.begin();
    }
  }

  private async execute<T>(
    entry: Entry,
    attempt: () => Promise<T>,
  ): Promise<T | typeof cancelledMarker> {
    for (let retry = 0; ; retry += 1) {
      if (entry.cancelled) return cancelledMarker;
      try {
        return await attempt();
      } catch (error) {
        if (!this.options.isBusy(error) || retry >= this.retries) throw error;
      }
      if (entry.cancelled) return cancelledMarker;
      await this.backoff(entry, Math.min(this.maximumDelay, this.initialDelay * 2 ** retry));
    }
  }

  private backoff(entry: Entry, milliseconds: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, milliseconds);
      function done() {
        clearTimeout(timer);
        entry.wake = null;
        resolve();
      }
      entry.wake = done;
    });
  }
}
