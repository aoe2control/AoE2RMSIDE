import type {
  ConnectorPairingRequest,
  ConnectorRendererReply,
  ConnectorRendererRequest,
} from '../shared/connector-api';
import {
  validateConnectorPrompt,
  type ConnectorPrompt,
  type ConnectorPromptAnswer,
} from '../shared/connector-prompts';

export interface ConnectorBridgePrompt {
  requestId: string;
  prompt: ConnectorPrompt;
  closesAt: number | null;
}

export type ShownConnectorPrompt =
  | { kind: 'pairing'; request: ConnectorPairingRequest }
  | { kind: 'bridge'; entry: ConnectorBridgePrompt };

export const maximumConnectorPrompts = 16;

export class ConnectorPromptQueue {
  private entries: readonly ConnectorBridgePrompt[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly reply: (reply: ConnectorRendererReply) => void,
    private readonly now: () => number = Date.now,
  ) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly snapshot = (): readonly ConnectorBridgePrompt[] => this.entries;

  accept(request: ConnectorRendererRequest): boolean {
    if (request.kind !== 'prompt') return false;
    let prompt: ConnectorPrompt;
    try {
      prompt = validateConnectorPrompt(request.payload);
    } catch {
      this.reply({
        requestId: request.requestId,
        ok: false,
        error: { code: 'internal', message: 'The prompt request was not valid.' },
      });
      return true;
    }
    if (this.entries.length >= maximumConnectorPrompts) {
      this.reply({
        requestId: request.requestId,
        ok: false,
        error: { code: 'internal', message: 'AoE2RMSIDE has too many prompts open.' },
      });
      return true;
    }
    const closesAt = prompt.closeAfterMs === undefined ? null : this.now() + prompt.closeAfterMs;
    this.update([...this.entries, { requestId: request.requestId, prompt, closesAt }]);
    return true;
  }

  answer(requestId: string, answer: ConnectorPromptAnswer): void {
    if (!this.entries.some((entry) => entry.requestId === requestId)) return;
    this.update(this.entries.filter((entry) => entry.requestId !== requestId));
    this.reply({ requestId, ok: true, payload: answer });
  }

  expire(): number | null {
    const now = this.now();
    for (const entry of this.entries) {
      if (entry.closesAt !== null && entry.closesAt <= now) {
        this.answer(entry.requestId, { decision: 'no-answer' });
      }
    }
    const deadlines = this.entries
      .map((entry) => entry.closesAt)
      .filter((deadline): deadline is number => deadline !== null);
    return deadlines.length > 0 ? Math.min(...deadlines) : null;
  }

  closeAll(): void {
    for (const entry of this.entries) this.answer(entry.requestId, { decision: 'no-answer' });
  }

  private update(entries: readonly ConnectorBridgePrompt[]): void {
    this.entries = entries;
    for (const listener of [...this.listeners]) listener();
  }
}

export function shownConnectorPrompt(
  pairingRequests: readonly ConnectorPairingRequest[],
  prompts: readonly ConnectorBridgePrompt[],
): ShownConnectorPrompt | null {
  const pairing = pairingRequests[0];
  if (pairing) return { kind: 'pairing', request: pairing };
  const entry = prompts[0];
  return entry ? { kind: 'bridge', entry } : null;
}

export function connectorPromptKey(shown: ShownConnectorPrompt | null): string | null {
  if (!shown) return null;
  return shown.kind === 'pairing'
    ? `pairing:${shown.request.id}`
    : `prompt:${shown.entry.requestId}`;
}
