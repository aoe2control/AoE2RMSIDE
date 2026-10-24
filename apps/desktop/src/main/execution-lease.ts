import type { RootExecutionKind, RootExecutionOrigin, RootExecutionState } from '../shared/api';
import { DesktopError } from '../shared/desktop-error';

export const executionStopGraceMilliseconds = 2_000;

export interface ExecutionLeaseToken {
  readonly executionId: string;
  readonly generation: number;
}

export interface ExecutionLeaseOptions {
  origin?: RootExecutionOrigin;
  automatic?: boolean;
}

interface ExecutionOwner {
  token: ExecutionLeaseToken;
  kind: RootExecutionKind;
  label: string;
  startedAt: number;
  origin: RootExecutionOrigin | undefined;
  automatic: boolean;
  cooperativeStop(): Promise<void>;
  forceStop(): Promise<void>;
  released: Promise<void>;
  acknowledgeRelease(): void;
}

export class ExecutionLease {
  private owner: ExecutionOwner | null = null;
  private generation = 0;
  private stopping: Promise<boolean> | null = null;
  private readonly listeners = new Set<(state: RootExecutionState) => void>();

  constructor(private readonly publishState: (state: RootExecutionState) => void = () => {}) {}

  subscribe(listener: (state: RootExecutionState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private publish(state: RootExecutionState): void {
    this.publishState(state);
    for (const listener of [...this.listeners]) {
      try {
        listener(state);
      } catch {}
    }
  }

  state(): RootExecutionState {
    const owner = this.owner;
    if (!owner) return { phase: 'idle' };
    return {
      phase: this.stopping ? 'stopping' : 'running',
      executionId: owner.token.executionId,
      kind: owner.kind,
      label: owner.label,
      startedAt: owner.startedAt,
      ...(owner.origin ? { origin: { ...owner.origin } } : {}),
      ...(owner.automatic ? { automatic: true } : {}),
    };
  }

  acquire(
    executionId: string,
    kind: RootExecutionKind,
    label: string,
    cooperativeStop: () => Promise<void>,
    forceStop: () => Promise<void>,
    options: ExecutionLeaseOptions = {},
  ): ExecutionLeaseToken {
    if (this.owner) {
      throw new DesktopError(
        'execution.busy',
        'another application-global root execution is already active',
      );
    }
    if (!executionId || executionId.length > 128) throw new Error('execution identity is invalid');
    const token = Object.freeze({ executionId, generation: ++this.generation });
    let acknowledgeRelease = () => {};
    const released = new Promise<void>((resolve) => {
      acknowledgeRelease = resolve;
    });
    this.owner = {
      token,
      kind,
      label,
      startedAt: Date.now(),
      origin: options.origin ? { kind: 'app', app: options.origin.app } : undefined,
      automatic: options.automatic === true,
      cooperativeStop,
      forceStop,
      released,
      acknowledgeRelease,
    };
    this.publish(this.state());
    return token;
  }

  release(token: ExecutionLeaseToken): boolean {
    const owner = this.owner;
    if (!owner || owner.token.generation !== token.generation) return false;
    this.owner = null;
    owner.acknowledgeRelease();
    this.stopping = null;
    this.publish({ phase: 'idle' });
    return true;
  }

  stop(): Promise<boolean> {
    if (!this.owner) return Promise.resolve(false);
    if (this.stopping) return this.stopping;
    const owner = this.owner;
    const stopping: Promise<boolean> = this.stopOwner(owner)
      .catch((error: unknown) => {
        if (this.owner === owner && this.stopping === stopping) this.stopping = null;
        throw error;
      })
      .finally(() => {
        if (this.owner === owner) this.publish(this.state());
      });
    this.stopping = stopping;
    this.publish(this.state());
    return this.stopping;
  }

  private async stopOwner(owner: ExecutionOwner): Promise<boolean> {
    await owner.cooperativeStop().catch(() => undefined);
    const releasedCooperatively = await settlesWithin(
      owner.released,
      executionStopGraceMilliseconds,
    );
    if (releasedCooperatively) return true;
    await owner.forceStop();
    await owner.released;
    return true;
  }
}

async function settlesWithin(promise: Promise<void>, milliseconds: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
