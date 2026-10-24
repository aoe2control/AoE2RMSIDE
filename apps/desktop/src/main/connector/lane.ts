import { randomUUID } from 'node:crypto';
import type {
  MapTestRunResult,
  PreviewGenerationResult,
  RootExecutionKind,
  RootExecutionState,
} from '../../shared/api';
import { ConnectorToolError } from './dispatcher';

export interface LaneLease {
  state(): RootExecutionState;
  subscribe(listener: (state: RootExecutionState) => void): () => void;
}

export type LaneAdmission = 'idle' | 'supersede';

const executionWords: Record<RootExecutionKind, string> = {
  rms: 'a map generation',
  'map-test': 'a map test',
  'control-live': 'a live test',
  'map-icon': 'a map icon generation',
  pictures: 'a contact sheet',
};

export function appExecutionLabel(app: string, label: string): string {
  return `${app} · ${label}`;
}

export function busyError(state: RootExecutionState, now: number): ConnectorToolError {
  const kind = state.kind ?? 'rms';
  const by = state.origin?.kind === 'app' ? state.origin.app : 'user';
  const elapsed =
    state.startedAt === undefined
      ? undefined
      : Math.max(0, Math.round((now - state.startedAt) / 1000));
  return new ConnectorToolError(
    'busy',
    `AoE2RMSIDE is running ${executionWords[kind] ?? 'a run'} started by ${by === 'user' ? 'the user' : by}.`,
    {
      details: {
        running: {
          kind,
          by,
          ...(state.label ? { label: state.label } : {}),
          ...(elapsed === undefined ? {} : { elapsed_s: elapsed }),
        },
      },
      hint: 'Try again when it finishes, or ask the user.',
      retryAfterSeconds: 10,
      facts: state.label ? { running: state.label.slice(0, 200) } : {},
    },
  );
}

export class AppLane {
  constructor(
    private readonly lease: LaneLease,
    private readonly busyWaitMilliseconds: number,
    private readonly now: () => number = Date.now,
  ) {}

  check(): LaneAdmission | null {
    const state = this.lease.state();
    if (state.phase === 'idle') return 'idle';
    if (state.phase === 'running' && state.kind === 'rms' && state.automatic === true) {
      return 'supersede';
    }
    return null;
  }

  async admit(signal: AbortSignal): Promise<LaneAdmission> {
    const deadline = this.now() + this.busyWaitMilliseconds;
    for (;;) {
      if (signal.aborted) throw new ConnectorToolError('cancelled', 'The call was cancelled.');
      const admission = this.check();
      if (admission) return admission;
      const remaining = deadline - this.now();
      if (remaining <= 0) throw busyError(this.lease.state(), this.now());
      await this.changeOrTimeout(remaining, signal);
    }
  }

  private changeOrTimeout(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      let unsubscribe = () => {};
      const done = () => {
        clearTimeout(timer);
        unsubscribe();
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, milliseconds);
      unsubscribe = this.lease.subscribe(done);
      signal.addEventListener('abort', done, { once: true });
    });
  }
}

export type AppRunTicketKind = 'generate' | 'map-test' | 'quality-check' | 'live-test';

export interface AppRunTicket {
  readonly token: string;
  readonly kind: AppRunTicketKind;
  readonly app: string;
  executionId: string | undefined;
  result: PreviewGenerationResult | MapTestRunResult | undefined;
  resultAt: number | undefined;
  cancelled: boolean;
  source: { uri: string; text: string } | undefined;
  onProgress: ((done: number, total: number) => void) | undefined;
}

const maximumTickets = 32;
export const appRunTokenPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export class AppRunTickets {
  private readonly tickets = new Map<string, AppRunTicket>();

  issue(kind: AppRunTicketKind, app: string): AppRunTicket {
    if (this.tickets.size >= maximumTickets) {
      this.tickets.delete(this.tickets.keys().next().value!);
    }
    const ticket: AppRunTicket = {
      token: randomUUID(),
      kind,
      app,
      executionId: undefined,
      result: undefined,
      resultAt: undefined,
      cancelled: false,
      source: undefined,
      onProgress: undefined,
    };
    this.tickets.set(ticket.token, ticket);
    return ticket;
  }

  claim(token: string, kinds: readonly AppRunTicketKind[]): AppRunTicket | 'cancelled' | undefined {
    if (typeof token !== 'string' || !appRunTokenPattern.test(token)) return undefined;
    const ticket = this.tickets.get(token);
    if (!ticket || !kinds.includes(ticket.kind)) return undefined;
    return ticket.cancelled ? 'cancelled' : ticket;
  }

  capture(
    ticket: AppRunTicket,
    result: PreviewGenerationResult | MapTestRunResult,
    at: number,
    source?: { uri: string; text: string },
  ): void {
    if (this.tickets.get(ticket.token) !== ticket || ticket.cancelled) return;
    ticket.result = result;
    ticket.resultAt = at;
    ticket.source = source;
  }

  cancel(token: string): string | undefined {
    const ticket = this.tickets.get(token);
    if (!ticket) return undefined;
    ticket.cancelled = true;
    return ticket.executionId;
  }

  finish(token: string): void {
    const ticket = this.tickets.get(token);
    if (ticket) ticket.cancelled = true;
    this.tickets.delete(token);
  }

  get size(): number {
    return this.tickets.size;
  }
}

export function isAppRunReference(value: unknown): value is { token: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === 1 &&
    keys[0] === 'token' &&
    typeof (value as { token: unknown }).token === 'string' &&
    appRunTokenPattern.test((value as { token: string }).token)
  );
}
