import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import type { NativeProcessName, NativeProcessState } from '../shared/api';
import { DesktopError } from '../shared/desktop-error';
import { guardChildStreams, isClosedPipeError } from './child-streams';
import * as latencyProbe from './latency-probe';

const maximumHeaderBytes = 8 * 1024;
const maximumMessageBytes = 28 * 1024 * 1024;

export interface LanguageServerRequestBudget {
  idleMilliseconds: number;
  maximumMilliseconds: number;
}

export const defaultLanguageServerRequestBudget: LanguageServerRequestBudget = Object.freeze({
  idleMilliseconds: 10_000,
  maximumMilliseconds: 60_000,
});

export interface LanguageServerClientOptions {
  maximumMessageBytes?: number;
  initializeParams?: Record<string, unknown>;
  onServerRequest?: (method: string, params: unknown) => unknown;
  onStderr?: (chunk: string) => void;
  cancelOnTimeout?: boolean;
  omitVoidParams?: boolean;
}

export interface LanguageServerClientStatus<Name extends string> {
  name: Name;
  state: NativeProcessState;
  detail?: string;
}

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer?: NodeJS.Timeout;
  deadline: number;
}

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

const maximumPendingRequests = 128;

export class LanguageServerClient<Name extends string = NativeProcessName> {
  private child: ChildProcessWithoutNullStreams | undefined;
  private pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private outputBuffer = Buffer.alloc(0);
  private stopping = false;
  private initializeAnswer: unknown;
  private closedChild: Promise<void> = Promise.resolve();
  private readonly maximumMessageBytes: number;

  constructor(
    private readonly executablePath: string,
    private readonly onStatus: (status: LanguageServerClientStatus<Name>) => void,
    private readonly onNotification: (method: string, params: unknown) => void,
    private readonly processName: NoInfer<Name> = 'rms-ls' as Name,
    private readonly arguments_: readonly string[] = [],
    private readonly budget: LanguageServerRequestBudget = defaultLanguageServerRequestBudget,
    private readonly options: LanguageServerClientOptions = {},
  ) {
    this.maximumMessageBytes = options.maximumMessageBytes ?? maximumMessageBytes;
  }

  get initializeResult(): unknown {
    return this.initializeAnswer;
  }

  get unreadOutput(): string {
    return this.outputBuffer
      .subarray(0, 512)
      .toString('utf8')
      .replace(/[\u0000-\u001f\u007f]/gu, ' ')
      .trim();
  }

  closed(milliseconds: number): Promise<void> {
    return Promise.race([
      this.closedChild,
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
    ]);
  }

  get running(): boolean {
    return this.child !== undefined;
  }

  async start(): Promise<unknown> {
    if (this.child) return this.initializeAnswer;
    this.stopping = false;
    this.outputBuffer = Buffer.alloc(0);
    this.onStatus({ name: this.processName, state: 'starting' });
    const child = spawn(this.executablePath, [...this.arguments_], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.closedChild = new Promise((resolve) => child.once('close', () => resolve()));
    child.stdout.on('data', (chunk: Buffer) => {
      for (const id of this.pending.keys()) this.armTimeout(id);
      this.acceptOutput(chunk);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (this.options.onStderr) {
        this.options.onStderr(chunk);
        return;
      }
      const detail = latencyProbe
        .nativeDiagnostics(this.processName as unknown as NativeProcessName, chunk)
        .trim();
      if (detail && !this.stopping) {
        this.onStatus({ name: this.processName, state: 'running', detail });
      }
    });
    guardChildStreams(child, (error) => {
      if (this.child !== child) return;
      if (this.stopping || isClosedPipeError(error)) this.rejectPending(error);
      else this.fail(error);
    });
    child.once('error', (error) => this.fail(error));
    child.once('exit', (code, signal) => {
      this.child = undefined;
      const error = new DesktopError(
        'native.exited',
        `${this.processName} exited (code ${String(code)}, signal ${String(signal)})`,
        { name: this.processName },
      );
      this.rejectPending(error);
      this.onStatus({
        name: this.processName,
        state: this.stopping ? 'stopped' : 'failed',
        detail: this.stopping ? undefined : error.message,
      });
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    this.initializeAnswer = await this.request(
      'initialize',
      this.options.initializeParams ?? {
        processId: process.pid,
        clientInfo: { name: 'AoE2RMSIDE', version: '0.0.0' },
        capabilities: {
          general: { positionEncodings: ['utf-16'] },
          textDocument: { synchronization: { didSave: false } },
        },
      },
    );
    this.notify('initialized', {});
    this.onStatus({ name: this.processName, state: 'running' });
    return this.initializeAnswer;
  }

  request(method: string, params: unknown): Promise<unknown> {
    const child = this.child;
    if (!child || child.stdin.destroyed) {
      return Promise.reject(this.notRunning());
    }
    if (this.pending.size >= maximumPendingRequests) {
      return Promise.reject(new Error(`${this.processName} has too many pending requests`));
    }
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        method,
        resolve,
        reject,
        deadline: Date.now() + this.budget.maximumMilliseconds,
      });
      this.armTimeout(id);
      latencyProbe.languageExchange(id, method, 'sent');
      let frame: Buffer;
      try {
        frame = this.frame(this.message({ jsonrpc: '2.0', id, method }, method, params));
      } catch (error) {
        const pending = this.pending.get(id);
        if (pending) clearTimeout(pending.timer);
        this.pending.delete(id);
        reject(error);
        return;
      }
      child.stdin.write(frame, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  notify(method: string, params: unknown): void {
    const child = this.child;
    if (!child || child.stdin.destroyed) throw this.notRunning();
    child.stdin.write(this.frame(this.message({ jsonrpc: '2.0', method }, method, params)));
  }

  private message(
    base: Record<string, unknown>,
    method: string,
    params: unknown,
  ): Record<string, unknown> {
    if (
      this.options.omitVoidParams &&
      (method === 'shutdown' || method === 'exit') &&
      (params === null || params === undefined)
    ) {
      return base;
    }
    return { ...base, params };
  }

  private frame(message: unknown): Buffer {
    return lspFrame(message, this.maximumMessageBytes, this.processName);
  }

  kill(): void {
    this.stopping = true;
    this.child?.kill();
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    try {
      await Promise.race([
        this.request('shutdown', null),
        timeout(1500, `${this.processName} shutdown timed out`),
      ]);
      this.notify('exit', null);
      child.stdin.end();
    } catch {
      child.kill();
    }
    await waitForExit(child, 1500);
  }

  private armTimeout(id: number): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    const remaining = Math.min(this.budget.idleMilliseconds, pending.deadline - Date.now());
    pending.timer = setTimeout(
      () => {
        if (this.pending.get(id) !== pending) return;
        this.pending.delete(id);
        if (this.options.cancelOnTimeout && this.child && !this.child.stdin.destroyed) {
          try {
            this.notify('$/cancelRequest', { id });
          } catch {}
        }
        pending.reject(
          new DesktopError(
            'native.timeout',
            `${this.processName} request timed out: ${pending.method}`,
            { name: this.processName },
          ),
        );
      },
      Math.max(0, remaining),
    );
  }

  private acceptOutput(chunk: Buffer): void {
    try {
      this.outputBuffer = Buffer.concat([this.outputBuffer, chunk]);
      while (this.outputBuffer.length > 0) {
        const headerEnd = this.outputBuffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) {
          if (this.outputBuffer.length > maximumHeaderBytes) {
            throw new Error(`${this.processName} response header exceeds bounded length`);
          }
          return;
        }
        if (headerEnd > maximumHeaderBytes) {
          throw new Error(`${this.processName} response header exceeds bounded length`);
        }
        const header = this.outputBuffer.subarray(0, headerEnd).toString('ascii');
        const match = /(?:^|\r\n)Content-Length:\s*(\d+)\s*(?:\r\n|$)/i.exec(header);
        if (!match) throw new Error(`${this.processName} response is missing Content-Length`);
        const length = Number(match[1]);
        if (!Number.isSafeInteger(length) || length < 0 || length > this.maximumMessageBytes) {
          throw new Error(`${this.processName} response length is invalid`);
        }
        const bodyStart = headerEnd + 4;
        const frameEnd = bodyStart + length;
        if (this.outputBuffer.length < frameEnd) return;
        const body = this.outputBuffer.subarray(bodyStart, frameEnd);
        this.outputBuffer = this.outputBuffer.subarray(frameEnd);
        this.acceptMessage(JSON.parse(body.toString('utf8')) as JsonRpcMessage);
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private acceptMessage(message: JsonRpcMessage): void {
    if (!message || typeof message !== 'object') return;
    if (typeof message.method === 'string') {
      if (message.id === undefined) this.onNotification(message.method, message.params);
      else if (typeof message.id === 'number' || typeof message.id === 'string')
        this.answerServerRequest(message.id, message.method, message.params);
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    latencyProbe.languageExchange(message.id, '', 'answered');
    if (isJsonRpcError(message.error)) {
      pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
    } else {
      pending.resolve(message.result);
    }
  }

  private answerServerRequest(id: number | string, method: string, params: unknown): void {
    const child = this.child;
    const reply = (message: Record<string, unknown>) => {
      if (this.child !== child || !child || child.stdin.destroyed) return;
      try {
        child.stdin.write(this.frame({ jsonrpc: '2.0', id, ...message }));
      } catch {}
    };
    let answer: unknown;
    try {
      answer = this.options.onServerRequest?.(method, params);
    } catch (error) {
      reply({
        error: { code: -32603, message: error instanceof Error ? error.message : 'failed' },
      });
      return;
    }
    void Promise.resolve(answer).then(
      (result) =>
        reply(
          result === undefined
            ? { error: { code: -32601, message: `${method} is not supported` } }
            : { result },
        ),
      (error: unknown) =>
        reply({
          error: { code: -32603, message: error instanceof Error ? error.message : 'failed' },
        }),
    );
  }

  private notRunning(): DesktopError {
    return new DesktopError('native.unavailable', `${this.processName} is not running`, {
      name: this.processName,
    });
  }

  private fail(error: Error): void {
    this.rejectPending(error);
    this.onStatus({ name: this.processName, state: 'failed', detail: error.message });
    this.child?.kill();
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function isJsonRpcError(value: unknown): value is { code: number; message: string } {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { code?: unknown }).code === 'number' &&
    typeof (value as { message?: unknown }).message === 'string'
  );
}

function lspFrame(message: unknown, limit: number, processName: string): Buffer {
  const body = Buffer.from(JSON.stringify(message));
  if (body.byteLength > limit) {
    throw new Error(`${processName} request exceeds the bounded message length`);
  }
  return Buffer.concat([Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`), body]);
}

function timeout(milliseconds: number, message: string): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), milliseconds));
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  milliseconds: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((resolve) =>
      setTimeout(() => {
        child.kill();
        resolve();
      }, milliseconds),
    ),
  ]);
}
