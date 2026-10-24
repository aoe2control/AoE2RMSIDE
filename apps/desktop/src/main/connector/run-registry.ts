import type { ConnectorJsonValue } from './validator';
import { ConnectorToolError, type ConnectorToolResult } from './dispatcher';

export const runRegistryCapacity = 8;

export type RunPrefix = 'g' | 'r' | 'q' | 's' | 'd' | 'l';

export interface RunProgress {
  done: number;
  total: number;
  message: string;
}

export interface RunContext {
  readonly id: string;
  readonly startedAt: number;
  readonly signal: AbortSignal;
  progress(done: number, total: number, message?: string): void;
  setDetails(details: unknown): void;
  stoppedBy(): 'app' | 'connection' | undefined;
}

type Settlement =
  { ok: true; result: ConnectorToolResult } | { ok: false; error: ConnectorToolError };

export interface RegisteredRun {
  readonly id: string;
  readonly prefix: RunPrefix;
  readonly startedAt: number;
  details: unknown;
  readonly progress: RunProgress;
  readonly settled: Settlement | undefined;
  readonly stoppedBy: 'app' | 'connection' | undefined;
}

class RunEntry implements RegisteredRun {
  details: unknown = undefined;
  progress: RunProgress = { done: 0, total: 0, message: '' };
  settled: Settlement | undefined;
  stoppedBy: 'app' | 'connection' | undefined;
  readonly controller = new AbortController();
  readonly done: Promise<void>;
  private readonly listeners = new Set<(progress: RunProgress) => void>();
  private resolveDone!: () => void;

  constructor(
    readonly id: string,
    readonly prefix: RunPrefix,
    readonly startedAt: number,
  ) {
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
  }

  report(progress: RunProgress): void {
    this.progress = progress;
    for (const listener of [...this.listeners]) listener(progress);
  }

  listen(listener: (progress: RunProgress) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  settle(settlement: Settlement): void {
    if (this.settled) return;
    this.settled = settlement;
    this.listeners.clear();
    this.resolveDone();
  }
}

export type RunWaitOutcome =
  { kind: 'finished'; result: ConnectorToolResult } | { kind: 'running'; run: RegisteredRun };

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || milliseconds <= 0) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener('abort', done, { once: true });
  });
}

export class RunRegistry {
  private readonly runs = new Map<string, RunEntry>();
  private readonly counters: Record<RunPrefix, number> = { g: 0, r: 0, q: 0, s: 0, d: 0, l: 0 };
  private closed = false;

  constructor(
    private readonly capacity = runRegistryCapacity,
    private readonly now: () => number = Date.now,
  ) {}

  start(prefix: RunPrefix, work: (run: RunContext) => Promise<ConnectorToolResult>): RegisteredRun {
    if (this.closed) throw new ConnectorToolError('cancelled', 'The connection closed.');
    this.counters[prefix] = this.counters[prefix] >= 999_999 ? 1 : this.counters[prefix] + 1;
    const entry = new RunEntry(`${prefix}${this.counters[prefix]}`, prefix, this.now());
    this.runs.delete(entry.id);
    this.runs.set(entry.id, entry);
    this.evict();
    const context: RunContext = {
      id: entry.id,
      startedAt: entry.startedAt,
      signal: entry.controller.signal,
      progress: (done, total, message = '') => {
        if (!entry.settled) entry.report({ done, total, message });
      },
      setDetails: (details) => {
        entry.details = details;
      },
      stoppedBy: () => entry.stoppedBy,
    };
    void Promise.resolve()
      .then(() => work(context))
      .then(
        (result) => entry.settle({ ok: true, result }),
        (error: unknown) =>
          entry.settle({
            ok: false,
            error:
              error instanceof ConnectorToolError
                ? error
                : new ConnectorToolError('internal', 'Something went wrong in AoE2RMSIDE.', {
                    hint: 'Try again; if it keeps failing, ask the user to look at the Output in AoE2RMSIDE.',
                  }),
          }),
      );
    return entry;
  }

  get(id: string): RegisteredRun | undefined {
    const entry = this.runs.get(id);
    if (!entry) return undefined;
    this.runs.delete(id);
    this.runs.set(id, entry);
    return entry;
  }

  async wait(
    id: string,
    waitMilliseconds: number,
    signal: AbortSignal,
    onProgress?: (progress: RunProgress) => void,
  ): Promise<RunWaitOutcome> {
    const entry = this.runs.get(id);
    if (!entry) throw expired(id);
    const unsubscribe = onProgress ? entry.listen(onProgress) : () => undefined;
    try {
      if (!entry.settled) {
        const waiter = new AbortController();
        const stop = () => waiter.abort();
        signal.addEventListener('abort', stop, { once: true });
        try {
          await Promise.race([entry.done, pause(waitMilliseconds, waiter.signal)]);
        } finally {
          signal.removeEventListener('abort', stop);
          waiter.abort();
        }
      }
    } finally {
      unsubscribe();
    }
    if (signal.aborted && !entry.settled) {
      throw new ConnectorToolError('cancelled', 'The call was cancelled.');
    }
    const settled = entry.settled;
    if (!settled) return { kind: 'running', run: entry };
    if (settled.ok) return { kind: 'finished', result: settled.result };
    throw settled.error;
  }

  stop(id: string, by: 'app' | 'connection'): boolean {
    const entry = this.runs.get(id);
    if (!entry || entry.settled) return false;
    entry.stoppedBy ??= by;
    entry.controller.abort();
    return true;
  }

  close(): void {
    this.closed = true;
    for (const entry of this.runs.values()) {
      if (!entry.settled) {
        entry.stoppedBy ??= 'connection';
        entry.controller.abort();
      }
    }
  }

  ids(): string[] {
    return [...this.runs.keys()];
  }

  private evict(): void {
    while (this.runs.size > this.capacity) {
      const finished = [...this.runs.values()].find((entry) => entry.settled);
      const victim = finished ?? this.runs.values().next().value!;
      if (!victim.settled) {
        victim.stoppedBy ??= 'connection';
        victim.controller.abort();
      }
      this.runs.delete(victim.id);
    }
  }
}

export function expired(id: string): ConnectorToolError {
  return new ConnectorToolError('run_expired', `${id} is no longer available.`, {
    hint: 'Start the run again; AoE2RMSIDE keeps the last 8 runs of a connection.',
  });
}

export function runningAnswer(run: RegisteredRun, now: number): Record<string, ConnectorJsonValue> {
  return {
    run: run.id,
    status: 'running',
    ...(run.progress.total > 0 ? { done: run.progress.done, total: run.progress.total } : {}),
    ...(run.progress.message ? { progress: run.progress.message } : {}),
    elapsed_s: Math.max(0, Math.round((now - run.startedAt) / 100) / 10),
  };
}
