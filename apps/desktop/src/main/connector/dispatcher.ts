import type {
  ConnectorErrorCode,
  ConnectorOutputFacts,
  ConnectorOutputRow,
  ConnectorPairing,
  ConnectorToolName,
} from '../../shared/connector-api';
import type { ConnectorCatalog, ConnectorCatalogTool, ConnectorLimits } from './catalog';
import { connectorWire, truncateUtf8 } from './envelope';
import { ConnectionLimits } from './limits';
import { callOutputRow } from './output-rows';
import type { ConnectorSettings } from './settings';
import {
  codePoints,
  parseToolArguments,
  type ConnectorJsonValue,
  type ConnectorToolArguments,
} from './validator';

export interface ConnectorAppIdentity {
  name: string;
  title: string;
  version: string;
  launcherImage: string;
  displayName: string;
}

export interface ConnectorConnectionScope {
  readonly id: string;
  get<T>(key: object, create: () => T): T;
  onClose(callback: () => void): () => void;
}

export interface ConnectorToolContext {
  readonly tool: ConnectorCatalogTool;
  readonly app: ConnectorAppIdentity;
  readonly connection: ConnectorConnectionScope;
  readonly callId: bigint;
  readonly signal: AbortSignal;
  readonly limits: ConnectorLimits;
  readonly settings: Readonly<ConnectorSettings>;
  progress(done: number, total: number, message?: string): void;
}

export type ConnectorContent =
  | { type: 'text'; text: string }
  | { type: 'image'; png: Uint8Array; width: number; height: number };

export interface ConnectorToolResult {
  content: readonly ConnectorContent[];
  outcome?: 'done' | 'failed';
  facts?: ConnectorOutputFacts;
}

export type ConnectorToolHandler = (
  args: ConnectorToolArguments,
  context: ConnectorToolContext,
) => Promise<ConnectorToolResult>;

export class ConnectorToolError extends Error {
  readonly hint: string | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly details: Readonly<Record<string, ConnectorJsonValue>> | undefined;
  readonly facts: ConnectorOutputFacts | undefined;

  constructor(
    readonly code: ConnectorErrorCode,
    message: string,
    options: {
      hint?: string;
      retryAfterSeconds?: number;
      details?: Record<string, ConnectorJsonValue>;
      facts?: ConnectorOutputFacts;
    } = {},
  ) {
    super(message);
    this.name = 'ConnectorToolError';
    this.hint = options.hint;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.details = options.details;
    this.facts = options.facts;
  }
}

function compactValue(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const items = value.map(compactValue).filter((item) => item !== undefined);
    return items.length > 0 ? items : undefined;
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const compact = compactValue(entry);
      if (compact !== undefined) result[key] = compact;
    }
    return result;
  }
  return value;
}

export function connectorJsonText(value: object): string {
  return JSON.stringify(compactValue(value) ?? {});
}

export function connectorTextResult(
  value: object,
  options: { outcome?: 'done' | 'failed'; facts?: ConnectorOutputFacts } = {},
): ConnectorToolResult {
  return { content: [{ type: 'text', text: connectorJsonText(value) }], ...options };
}

export function connectorErrorText(error: ConnectorToolError): string {
  return connectorJsonText({
    error: error.code,
    message: error.message,
    ...error.details,
    hint: error.hint,
    retry_after_s: error.retryAfterSeconds,
  });
}

export class ConnectorToolRegistry {
  private readonly handlers = new Map<ConnectorToolName, ConnectorToolHandler>();

  register(name: ConnectorToolName, handler: ConnectorToolHandler): () => void {
    if (this.handlers.has(name)) throw new Error(`the tool ${name} already has a handler`);
    this.handlers.set(name, handler);
    return () => {
      if (this.handlers.get(name) === handler) this.handlers.delete(name);
    };
  }

  handler(name: ConnectorToolName): ConnectorToolHandler | undefined {
    return this.handlers.get(name);
  }

  names(): ConnectorToolName[] {
    return [...this.handlers.keys()];
  }
}

export interface DispatchSession {
  readonly app: ConnectorAppIdentity;
  readonly scope: ConnectorConnectionScope;
  pairing(): ConnectorPairing;
  pairingChanged(signal: AbortSignal): Promise<void>;
}

export interface CallSink {
  progress(callId: bigint, done: number, total: number, message: string): void;
  result(callId: bigint, isError: boolean, content: readonly ConnectorContent[]): void;
}

export interface CallRequest {
  callId: bigint;
  toolName: string;
  argumentsJson: string;
  wantsProgress: boolean;
}

const waitingForApprovalText = 'Waiting for approval in AoE2RMSIDE';
const approvalProgressMilliseconds = 5_000;

function internalError(): ConnectorToolError {
  return new ConnectorToolError('internal', 'Something went wrong in AoE2RMSIDE.', {
    hint: 'Try again; if it keeps failing, ask the user to look at the Output in AoE2RMSIDE.',
  });
}

function cancelledError(): ConnectorToolError {
  return new ConnectorToolError('cancelled', 'The call was cancelled.');
}

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

class ProgressThrottle {
  private last = Number.NEGATIVE_INFINITY;
  private pending: { done: number; total: number; message: string } | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(
    private readonly send: (done: number, total: number, message: string) => void,
    private readonly intervalMilliseconds: number,
    private readonly now: () => number,
  ) {}

  offer(done: number, total: number, message: string): void {
    if (this.closed) return;
    const elapsed = this.now() - this.last;
    if (elapsed >= this.intervalMilliseconds && this.timer === undefined) {
      this.last = this.now();
      this.send(done, total, message);
      return;
    }
    this.pending = { done, total, message };
    this.timer ??= setTimeout(
      () => {
        this.timer = undefined;
        const pending = this.pending;
        this.pending = undefined;
        if (pending && !this.closed) {
          this.last = this.now();
          this.send(pending.done, pending.total, pending.message);
        }
      },
      Math.max(0, this.intervalMilliseconds - elapsed),
    );
  }

  close(): void {
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
  }
}

function boundedProgress(done: number, total: number): { done: number; total: number } {
  const clamp = (value: number) =>
    Number.isFinite(value) ? Math.min(0xffffffff, Math.max(0, Math.floor(value))) : 0;
  const safeTotal = clamp(total);
  const safeDone = clamp(done);
  return { done: safeTotal === 0 ? safeDone : Math.min(safeDone, safeTotal), total: safeTotal };
}

export function resultProblem(
  tool: ConnectorCatalogTool,
  content: readonly ConnectorContent[],
): string | null {
  if (content.length === 0 || content.length > connectorWire.contentItems) {
    return 'content count';
  }
  if (content[0]!.type !== 'text') return 'the first item is not text';
  let images = 0;
  for (const item of content) {
    if (item.type === 'text') {
      if (typeof item.text !== 'string') return 'text item';
      if (codePoints(item.text) > tool.output.maxChars) return 'text over the tool cap';
      if (Buffer.byteLength(item.text, 'utf8') > connectorWire.textItemBytes) {
        return 'text over the wire bound';
      }
    } else {
      images += 1;
      if (!tool.output.image) return 'an image from a tool without images';
      if (!(item.png instanceof Uint8Array) || item.png.byteLength > connectorWire.pngBytes) {
        return 'image bytes';
      }
    }
  }
  return images > connectorWire.imagesPerResult ? 'more than one image' : null;
}

export interface ConnectorCallDispatcherOptions {
  catalog: ConnectorCatalog;
  registry: ConnectorToolRegistry;
  session: DispatchSession;
  sink: CallSink;
  settings: () => Readonly<ConnectorSettings>;
  onRow: (row: ConnectorOutputRow) => void;
  onWorkingChange?: () => void;
  now?: () => number;
  log?: (message: string, error?: unknown) => void;
}

export class ConnectorCallDispatcher {
  private readonly limits: ConnectionLimits;
  private readonly calls = new Map<bigint, AbortController>();
  private readonly now: () => number;
  private closed = false;

  constructor(private readonly options: ConnectorCallDispatcherOptions) {
    this.now = options.now ?? Date.now;
    this.limits = new ConnectionLimits(options.catalog.limits, this.now);
  }

  get inFlight(): number {
    return this.calls.size;
  }

  start(call: CallRequest): void {
    if (this.closed) return;
    const startedAt = this.now();
    const tool = this.options.catalog.tools.get(call.toolName as ConnectorToolName);
    if (!tool) {
      this.answerError(
        call.callId,
        new ConnectorToolError('invalid_arguments', 'AoE2RMSIDE does not know this tool.', {
          hint: 'List the tools again; the AI app and AoE2RMSIDE may come from different versions.',
        }),
      );
      return;
    }
    const refusal = this.limits.admit(tool);
    if (refusal) {
      const error = new ConnectorToolError(refusal.code, refusal.message, {
        hint: refusal.hint,
        ...(refusal.code === 'rate_limited'
          ? { retryAfterSeconds: refusal.retryAfterSeconds }
          : {}),
      });
      this.answerError(call.callId, error);
      this.row(tool, 'refused', startedAt, error.code);
      return;
    }
    const controller = new AbortController();
    this.calls.set(call.callId, controller);
    this.options.onWorkingChange?.();
    void this.run(call, tool, controller, startedAt).finally(() => {
      this.limits.release();
      this.calls.delete(call.callId);
      if (!this.closed) this.options.onWorkingChange?.();
    });
  }

  cancel(callId: bigint): void {
    this.calls.get(callId)?.abort();
  }

  close(): void {
    this.closed = true;
    for (const controller of this.calls.values()) controller.abort();
  }

  private async run(
    call: CallRequest,
    tool: ConnectorCatalogTool,
    controller: AbortController,
    startedAt: number,
  ): Promise<void> {
    const signal = controller.signal;
    const catalog = this.options.catalog;
    const throttle = new ProgressThrottle(
      (done, total, message) => {
        if (!this.closed && call.wantsProgress) {
          this.options.sink.progress(call.callId, done, total, message);
        }
      },
      Math.ceil(1000 / catalog.limits.progressPerSecond),
      this.now,
    );
    const progress = (done: number, total: number, message = '') => {
      if (signal.aborted) return;
      const bounded = boundedProgress(done, total);
      throttle.offer(
        bounded.done,
        bounded.total,
        truncateUtf8(String(message), connectorWire.progressMessageBytes),
      );
    };
    try {
      const parsed = parseToolArguments(
        call.argumentsJson,
        tool.inputSchema,
        catalog.limits.argumentsJsonBytes,
      );
      if (!parsed.ok) {
        throw new ConnectorToolError('invalid_arguments', parsed.message, {
          hint: `Check ${parsed.field} against the tool's input schema.`,
        });
      }
      await this.awaitApproval(signal, progress);
      if (tool.servedBy !== 'ide') {
        throw new ConnectorToolError('internal', 'rms-connect answers this tool itself.');
      }
      const handler = this.options.registry.handler(tool.name);
      if (!handler) {
        throw new ConnectorToolError('internal', 'AoE2RMSIDE cannot answer this tool.', {
          hint: 'Make sure the AI app runs the connector of this AoE2RMSIDE version.',
        });
      }
      const settings = this.options.settings;
      const session = this.options.session;
      const context: ConnectorToolContext = {
        tool,
        app: session.app,
        connection: session.scope,
        callId: call.callId,
        signal,
        limits: catalog.limits,
        get settings() {
          return settings();
        },
        progress,
      };
      const result = await handler(parsed.value, context);
      if (signal.aborted) throw cancelledError();
      const problem = resultProblem(tool, result.content);
      if (problem) {
        this.options.log?.(`connector tool ${tool.name} returned an invalid result: ${problem}`);
        throw internalError();
      }
      throttle.close();
      if (!this.closed) this.options.sink.result(call.callId, false, result.content);
      this.row(tool, result.outcome ?? 'done', startedAt, undefined, result.facts);
    } catch (thrown) {
      throttle.close();
      let error: ConnectorToolError;
      if (signal.aborted) {
        error = cancelledError();
      } else if (thrown instanceof ConnectorToolError) {
        error = thrown;
      } else {
        this.options.log?.(`connector tool ${tool.name} failed`, thrown);
        error = internalError();
      }
      this.answerError(call.callId, error);
      this.row(
        tool,
        error.code === 'cancelled' ? 'cancelled' : 'refused',
        startedAt,
        error.code,
        error.facts,
      );
    }
  }

  private async awaitApproval(
    signal: AbortSignal,
    progress: (done: number, total: number, message?: string) => void,
  ): Promise<void> {
    const session = this.options.session;
    const deadline = this.now() + this.options.catalog.limits.pairingWaitSeconds * 1000;
    while (session.pairing() === 'pending') {
      if (signal.aborted) throw cancelledError();
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        throw new ConnectorToolError(
          'needs_user_at_pc',
          'This app must be allowed once in AoE2RMSIDE at the PC.',
          {
            hint: 'Ask the user to choose Allow in AoE2RMSIDE when they are at the PC, then try again.',
          },
        );
      }
      progress(0, 0, waitingForApprovalText);
      const waiter = new AbortController();
      const stop = () => waiter.abort();
      signal.addEventListener('abort', stop, { once: true });
      try {
        await Promise.race([
          session.pairingChanged(waiter.signal),
          pause(Math.min(remaining, approvalProgressMilliseconds), waiter.signal),
        ]);
      } finally {
        signal.removeEventListener('abort', stop);
        waiter.abort();
      }
    }
    if (signal.aborted) throw cancelledError();
    if (session.pairing() !== 'approved') {
      throw new ConnectorToolError(
        'not_allowed',
        'The user did not allow this app in AoE2RMSIDE.',
        {
          hint: 'Ask the user to allow it; AoE2RMSIDE asks again after it restarts.',
        },
      );
    }
  }

  private answerError(callId: bigint, error: ConnectorToolError): void {
    if (this.closed) return;
    this.options.sink.result(callId, true, [{ type: 'text', text: connectorErrorText(error) }]);
  }

  private row(
    tool: ConnectorCatalogTool,
    outcome: 'done' | 'failed' | 'refused' | 'cancelled',
    startedAt: number,
    error?: ConnectorErrorCode,
    facts?: ConnectorOutputFacts,
  ): void {
    this.options.onRow(
      callOutputRow({
        app: this.options.session.app.displayName,
        tool: tool.name,
        outcome,
        ...(error ? { error } : {}),
        ...(facts ? { facts } : {}),
        durationMs: this.now() - startedAt,
      }),
    );
  }
}
