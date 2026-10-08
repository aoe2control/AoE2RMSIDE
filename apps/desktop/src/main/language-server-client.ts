import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import type { NativeProcessName, NativeProcessStatus } from '../shared/api';
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

export class LanguageServerClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private outputBuffer = Buffer.alloc(0);
  private stopping = false;

  constructor(
    private readonly executablePath: string,
    private readonly onStatus: (status: NativeProcessStatus) => void,
    private readonly onNotification: (method: string, params: unknown) => void,
    private readonly processName: NativeProcessName = 'rms-ls',
    private readonly arguments_: readonly string[] = [],
    private readonly budget: LanguageServerRequestBudget = defaultLanguageServerRequestBudget,
  ) {}

  async start(): Promise<void> {
    if (this.child) return;
    this.stopping = false;
    this.outputBuffer = Buffer.alloc(0);
    this.onStatus({ name: this.processName, state: 'starting' });
    const child = spawn(this.executablePath, [...this.arguments_], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    child.stdout.on('data', (chunk: Buffer) => {
      for (const id of this.pending.keys()) this.armTimeout(id);
      this.acceptOutput(chunk);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const detail = latencyProbe.nativeDiagnostics(this.processName, chunk).trim();
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
    await this.request('initialize', {
      processId: process.pid,
      clientInfo: { name: 'AoE2RMSIDE', version: '0.0.0' },
      capabilities: {
        general: { positionEncodings: ['utf-16'] },
        textDocument: { synchronization: { didSave: false } },
      },
    });
    this.notify('initialized', {});
    this.onStatus({ name: this.processName, state: 'running' });
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
      child.stdin.write(lspFrame({ jsonrpc: '2.0', id, method, params }), (error) => {
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
    child.stdin.write(lspFrame({ jsonrpc: '2.0', method, params }));
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
            throw new Error('rms-ls response header exceeds bounded length');
          }
          return;
        }
        if (headerEnd > maximumHeaderBytes) {
          throw new Error('rms-ls response header exceeds bounded length');
        }
        const header = this.outputBuffer.subarray(0, headerEnd).toString('ascii');
        const match = /(?:^|\r\n)Content-Length:\s*(\d+)\s*(?:\r\n|$)/i.exec(header);
        if (!match) throw new Error('rms-ls response is missing Content-Length');
        const length = Number(match[1]);
        if (!Number.isSafeInteger(length) || length < 0 || length > maximumMessageBytes) {
          throw new Error('rms-ls response length is invalid');
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
    if (typeof message.method === 'string' && message.id === undefined) {
      this.onNotification(message.method, message.params);
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

function lspFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message));
  if (body.byteLength > maximumMessageBytes) {
    throw new Error('rms-ls request exceeds the bounded message length');
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
