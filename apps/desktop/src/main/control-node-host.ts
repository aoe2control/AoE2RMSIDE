import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ControlEngineIdentity } from '../shared/api';
import { maximumControlResponseBytes, type ControlEndpointRequest } from './control-contract';
import type {
  ControlBridgeHost,
  ControlBridgeTimeouts,
  ControlLauncherBinding,
  ControlLauncherEventCode,
} from './control-session-bridge';
import { isGameExecutableName, type GameExecutableName } from './linked-game-process';

const maximumLauncherLineBytes = 8 * 1024;
const maximumLauncherMessages = 64;
const launcherWaitGraceMs = 2_000;
const launcherStartMs = 30_000;
const launcherWaitCodes: ReadonlySet<string> = new Set(['engine-unloading', 'engine-starting']);
const launcherWaitTimeoutFailures: Readonly<Record<string, string>> = {
  'engine-unloading-timeout': 'launcher-still-unloading',
  'engine-starting-timeout': 'launcher-engine-starting-timeout',
};
const legacyLauncherWaitMessages: ReadonlyArray<readonly [string, ControlLauncherWaitCode]> = [
  ['Waiting for CONTROL to finish unloading', 'engine-unloading'],
  ['Waiting for CONTROL to finish starting', 'engine-starting'],
];
const legacyWaitTimeoutMessages: Readonly<Record<string, ControlLauncherWaitCode>> = {
  'CONTROL is still unloading in this game': 'engine-unloading',
  'CONTROL is still starting in this game': 'engine-starting',
};
const launcherEndpointNotOwnedCode = 'endpoint-not-owned';

type ControlLauncherWaitCode = Extract<
  ControlLauncherEventCode,
  'engine-unloading' | 'engine-starting'
>;

interface LauncherStatusLine {
  schemaVersion: '1.0.0';
  event: 'launcher-start' | 'game-detected' | 'injection-started' | 'engine-status';
  sequence: number;
  status: 'idle' | 'progress' | 'success' | 'error';
  terminal: boolean;
  code: string;
  launcher: { product: 'AoE2Control'; productVersion: string; processId: number };
  game: null | { processId: number; imageName: GameExecutableName };
  injection: { disposition: 'none' | 'injected' | 'reused'; method: 'none' | 'manual-map' };
  uiMode: 'hidden';
  message: string;
}

export interface ControlPipeExchangeInput {
  expectedServerProcessId: number;
  request: Buffer;
  timeoutMs: number;
  maximumResponseBytes: number;
}

export type ControlPipeExchangeStatus =
  | 'complete'
  | 'unavailable'
  | 'server-process-mismatch'
  | 'server-process-unknown'
  | 'failed'
  | 'response-too-large'
  | 'timed-out'
  | 'cancelled'
  | 'invalid'
  | 'unsupported';

export interface ControlPipeExchangeResult {
  status: ControlPipeExchangeStatus;
  response: Buffer;
}

export interface ControlPipeTransport {
  exchange(requestId: string, input: ControlPipeExchangeInput): Promise<ControlPipeExchangeResult>;
  cancel(requestId: string): Promise<unknown>;
}

const unavailableControlPipeTransport: ControlPipeTransport = {
  exchange: () => Promise.resolve({ status: 'unsupported', response: Buffer.alloc(0) }),
  cancel: () => Promise.resolve(false),
};

export class NodeControlBridgeHost implements ControlBridgeHost {
  constructor(
    private readonly spawnProcess: typeof spawn = spawn,
    private readonly transport: ControlPipeTransport = unavailableControlPipeTransport,
  ) {}

  async launch(
    executablePath: string,
    expectedSha256: string,
    timeouts: ControlBridgeTimeouts,
    signal: AbortSignal,
    publish: (code: ControlLauncherEventCode) => void,
  ): Promise<ControlLauncherBinding> {
    if (process.platform !== 'win32') throw new ControlHostError('unsupported-platform');
    if (signal.aborted) throw abortError();
    return new Promise<ControlLauncherBinding>((resolve, reject) => {
      const child = this.spawnProcess(
        executablePath,
        [
          '--headless',
          '--rmside-status-json',
          '--rmside-ui=hidden',
          '--timeout-ms',
          String(timeouts.injectionHandshakeMs),
        ],
        {
          shell: false,
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        },
      );
      let settled = false;
      let detected = false;
      let buffer = Buffer.alloc(0);
      let messages = 0;
      let lastSequence = -1;
      let game: LauncherStatusLine['game'] = null;
      let launcherProductVersion = '';
      let launcherIdentity = '';
      let handshakeTimer: NodeJS.Timeout | undefined;
      const reportedWaits = new Set<ControlLauncherWaitCode>();
      let injectionStarted = false;
      const armHandshakeTimer = (milliseconds: number) => {
        if (handshakeTimer) clearTimeout(handshakeTimer);
        handshakeTimer = setTimeout(
          () => finish(new ControlHostError('injection-handshake-timeout')),
          milliseconds,
        );
      };

      const finish = (error?: Error, binding?: ControlLauncherBinding) => {
        if (settled) return;
        settled = true;
        clearTimeout(startTimer);
        if (detectionTimer) clearTimeout(detectionTimer);
        if (handshakeTimer) clearTimeout(handshakeTimer);
        signal.removeEventListener('abort', onAbort);
        child.stdout?.removeAllListeners();
        child.removeAllListeners();
        if (error) {
          terminateChild(child);
          reject(error);
        } else if (binding) {
          const cleanupTimer = setTimeout(() => terminateChild(child), 1_000);
          cleanupTimer.unref();
          child.once('exit', () => clearTimeout(cleanupTimer));
          resolve(binding);
        }
      };
      const onAbort = () => finish(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
      let detectionTimer: NodeJS.Timeout | undefined;
      const startTimer = setTimeout(
        () => finish(new ControlHostError('launcher-start-timeout')),
        launcherStartMs,
      );

      const handleLine = (line: Buffer) => {
        if (line.length === 0) return;
        if (++messages > maximumLauncherMessages || line.length > maximumLauncherLineBytes) {
          finish(new ControlHostError('malformed-launcher-status'));
          return;
        }
        let status: LauncherStatusLine;
        try {
          status = validateControlLauncherStatus(JSON.parse(line.toString('utf8')), lastSequence);
        } catch {
          finish(new ControlHostError('malformed-launcher-status'));
          return;
        }
        lastSequence = status.sequence;
        const currentLauncherIdentity = `${status.launcher.productVersion}:${status.launcher.processId}`;
        if (launcherIdentity && currentLauncherIdentity !== launcherIdentity) {
          finish(new ControlHostError('malformed-launcher-status'));
          return;
        }
        launcherIdentity = currentLauncherIdentity;
        launcherProductVersion = status.launcher.productVersion;
        if (
          game &&
          status.game &&
          (game.processId !== status.game.processId || game.imageName !== status.game.imageName)
        ) {
          finish(new ControlHostError('malformed-launcher-status'));
          return;
        }
        if (status.game) game = status.game;
        if (
          (status.event === 'launcher-start' &&
            (messages !== 1 || status.game !== null || status.injection.disposition !== 'none')) ||
          (status.event === 'game-detected' &&
            (detected || !status.game || status.injection.disposition !== 'none'))
        ) {
          finish(new ControlHostError('malformed-launcher-status'));
          return;
        }
        if (status.event === 'launcher-start') {
          clearTimeout(startTimer);
          detectionTimer = setTimeout(() => {
            if (!detected) finish(new ControlHostError('game-not-detected'));
          }, timeouts.gameDetectionMs);
        } else if (status.event === 'game-detected') {
          detected = true;
          clearTimeout(startTimer);
          if (detectionTimer) clearTimeout(detectionTimer);
          publish('game-detected');
          if (!handshakeTimer) armHandshakeTimer(timeouts.injectionHandshakeMs);
        } else if (status.event === 'injection-started') {
          if (!detected || !game) {
            finish(new ControlHostError('malformed-launcher-status'));
            return;
          }
          injectionStarted = true;
          publish('attach');
          if (reportedWaits.size > 0) {
            armHandshakeTimer(timeouts.injectionHandshakeMs + launcherWaitGraceMs);
          }
        } else if (status.event === 'engine-status' && !status.terminal && detected) {
          const wait = launcherWaitCode(status.code, status.message);
          if (wait && !reportedWaits.has(wait)) {
            reportedWaits.add(wait);
            publish(wait);
            armHandshakeTimer(timeouts.injectionHandshakeMs + launcherWaitGraceMs);
          }
        }
        if (!status.terminal) return;
        if (status.code === 'engine-ready' || status.code === 'engine-reused') {
          if (
            !detected ||
            !game ||
            status.status !== 'success' ||
            (status.code === 'engine-ready' && status.injection.disposition !== 'injected') ||
            (status.code === 'engine-reused' && status.injection.disposition !== 'reused')
          ) {
            finish(new ControlHostError('malformed-launcher-status'));
            return;
          }
          finish(undefined, {
            artifactSha256: expectedSha256,
            launcherProductVersion,
            launcherProcessId: status.launcher.processId,
            gameProcessId: game.processId,
            gameImageName: game.imageName,
            disposition: status.injection.disposition as 'injected' | 'reused',
          });
          return;
        }
        const waitTimeout = launcherWaitTimeoutFailures[status.code];
        if (waitTimeout) {
          finish(new ControlHostError(waitTimeout));
          return;
        }
        if (status.code === 'startup-timeout') {
          const legacyWait =
            legacyWaitTimeoutMessages[status.message] ??
            (!injectionStarted ? [...reportedWaits].at(-1) : undefined);
          finish(
            new ControlHostError(
              legacyWait === 'engine-unloading'
                ? 'launcher-still-unloading'
                : legacyWait === 'engine-starting'
                  ? 'launcher-engine-starting-timeout'
                  : 'launcher-startup-timeout',
            ),
          );
          return;
        }
        if (status.code === launcherEndpointNotOwnedCode) {
          finish(new ControlHostError('launcher-injection-failed', launcherEndpointNotOwnedCode));
          return;
        }
        finish(
          new ControlHostError(
            !detected && status.code === 'game-not-found'
              ? 'game-not-detected'
              : normalizeLauncherFailure(status.code),
          ),
        );
      };

      child.once('error', () => {
        if (messages === 0) finish(new ControlHostError('launcher-exited-before-start'));
        else if (detected) finish(new ControlHostError('launcher-crashed'));
      });
      child.once('close', () => {
        if (settled) return;
        if (messages === 0) finish(new ControlHostError('launcher-exited-before-start'));
        else if (detected) finish(new ControlHostError('launcher-crashed'));
      });
      child.stdout?.on('data', (chunk: Buffer) => {
        if (settled) return;
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > maximumLauncherLineBytes * 2) {
          finish(new ControlHostError('malformed-launcher-status'));
          return;
        }
        let newline = buffer.indexOf(0x0a);
        while (newline >= 0 && !settled) {
          const line = buffer
            .subarray(0, newline)
            .subarray(0, buffer[newline - 1] === 0x0d ? newline - 1 : newline);
          buffer = buffer.subarray(newline + 1);
          handleLine(line);
          newline = buffer.indexOf(0x0a);
        }
      });
    });
  }

  async request(
    request: ControlEndpointRequest,
    timeoutMs: number,
    signal: AbortSignal,
    serverProcessId: number,
  ): Promise<unknown> {
    if (process.platform !== 'win32') throw new ControlHostError('unsupported-platform');
    if (signal.aborted) throw abortError();
    if (!isProcessId(serverProcessId)) {
      throw new ControlHostError(
        'endpoint-unavailable',
        `${request.method}: no game process to check the pipe against`,
      );
    }
    const payload = Buffer.from(JSON.stringify(request), 'utf8');
    const exchangeId = `control-pipe-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, value?: unknown, abandon = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        if (abandon) void this.transport.cancel(exchangeId).catch(() => undefined);
        if (error) reject(error);
        else resolve(value);
      };
      const onAbort = () => finish(abortError(), undefined, true);
      signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(
        () => finish(new ControlHostError('endpoint-timeout'), undefined, true),
        timeoutMs,
      );
      this.transport
        .exchange(exchangeId, {
          expectedServerProcessId: serverProcessId,
          request: payload,
          timeoutMs,
          maximumResponseBytes: maximumControlResponseBytes,
        })
        .then(
          (result) => {
            try {
              finish(undefined, readControlPipeExchange(result, request.method));
            } catch (error) {
              finish(error instanceof Error ? error : new ControlHostError('endpoint-rejected'));
            }
          },
          () =>
            finish(
              new ControlHostError(
                'endpoint-closed',
                `${request.method}: the connection stopped before an answer`,
              ),
            ),
        );
    });
  }
}

export function readControlPipeExchange(
  result: ControlPipeExchangeResult,
  method: string,
): unknown {
  switch (result.status) {
    case 'complete':
      if (result.response.length > maximumControlResponseBytes) {
        throw new ControlHostError('endpoint-response-too-large');
      }
      return readEndpointResponse(result.response, method);
    case 'server-process-mismatch':
      throw new ControlHostError(
        'endpoint-unavailable',
        `${method}: the pipe is served by another process than the game`,
      );
    case 'server-process-unknown':
      throw new ControlHostError(
        'endpoint-unavailable',
        `${method}: the pipe's server process could not be identified`,
      );
    case 'response-too-large':
      throw new ControlHostError('endpoint-response-too-large');
    case 'timed-out':
      throw new ControlHostError('endpoint-timeout');
    case 'cancelled':
      throw new ControlHostError(
        'endpoint-closed',
        `${method}: the connection stopped before an answer`,
      );
    case 'invalid':
      throw new ControlHostError('endpoint-unavailable', `${method}: the request exceeds a bound`);
    case 'unsupported':
      throw new ControlHostError(
        'endpoint-unavailable',
        `${method}: no connection to AoE2Control is available`,
      );
    default:
      throw new ControlHostError('endpoint-unavailable');
  }
}

function isProcessId(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 0xffff_ffff;
}

export class ControlHostError extends Error {
  constructor(
    readonly code: string,
    readonly detail?: string,
  ) {
    super(`AoE2Control operation failed: ${code}${detail ? ` (${detail})` : ''}`);
    this.name = 'ControlHostError';
  }
}

export function validateControlLauncherStatus(
  value: unknown,
  lastSequence = -1,
): LauncherStatusLine {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
  const status = value as Record<string, unknown>;
  const keys = [
    'schemaVersion',
    'event',
    'sequence',
    'status',
    'terminal',
    'code',
    'launcher',
    'game',
    'injection',
    'uiMode',
    'message',
  ];
  if (Object.keys(status).length !== keys.length || keys.some((key) => !(key in status)))
    throw new Error('invalid');
  if (
    status.schemaVersion !== '1.0.0' ||
    !['launcher-start', 'game-detected', 'injection-started', 'engine-status'].includes(
      status.event as string,
    ) ||
    !Number.isSafeInteger(status.sequence) ||
    (status.sequence as number) <= lastSequence ||
    !['idle', 'progress', 'success', 'error'].includes(status.status as string) ||
    typeof status.terminal !== 'boolean' ||
    typeof status.code !== 'string' ||
    status.code.length < 1 ||
    status.code.length > 96 ||
    status.uiMode !== 'hidden' ||
    typeof status.message !== 'string' ||
    Buffer.byteLength(status.message) > 4096
  ) {
    throw new Error('invalid');
  }
  const launcher = status.launcher as Record<string, unknown>;
  if (
    !launcher ||
    Object.keys(launcher).length !== 3 ||
    ['product', 'productVersion', 'processId'].some((key) => !(key in launcher)) ||
    launcher.product !== 'AoE2Control' ||
    typeof launcher.productVersion !== 'string' ||
    launcher.productVersion.length < 1 ||
    launcher.productVersion.length > 64 ||
    !Number.isInteger(launcher.processId) ||
    (launcher.processId as number) < 1 ||
    (launcher.processId as number) > 0xffff_ffff
  ) {
    throw new Error('invalid');
  }
  let game: LauncherStatusLine['game'] = null;
  if (status.game !== null) {
    const candidate = status.game as Record<string, unknown>;
    if (
      !candidate ||
      Object.keys(candidate).length !== 2 ||
      !('processId' in candidate) ||
      !('imageName' in candidate) ||
      !Number.isInteger(candidate.processId) ||
      (candidate.processId as number) < 1 ||
      (candidate.processId as number) > 0xffff_ffff ||
      !isGameExecutableName(candidate.imageName)
    ) {
      throw new Error('invalid');
    }
    game = candidate as unknown as LauncherStatusLine['game'];
  }
  const injection = status.injection as Record<string, unknown>;
  if (
    !injection ||
    Object.keys(injection).length !== 2 ||
    !('disposition' in injection) ||
    !('method' in injection) ||
    !['none', 'injected', 'reused'].includes(injection.disposition as string) ||
    !['none', 'manual-map'].includes(injection.method as string) ||
    (injection.disposition === 'none') !== (injection.method === 'none') ||
    (status.terminal === true
      ? status.event !== 'engine-status' || !['success', 'error'].includes(status.status as string)
      : !['idle', 'progress'].includes(status.status as string))
  ) {
    throw new Error('invalid');
  }
  return { ...status, launcher, game, injection } as unknown as LauncherStatusLine;
}

export function readEndpointResponse(body: Buffer, method: string): unknown {
  if (body.length === 0) {
    throw new ControlHostError('endpoint-closed', `${method}: the pipe closed without an answer`);
  }
  const text = body.toString('utf8');
  let response: unknown;
  try {
    response = JSON.parse(text);
  } catch {
    const trimmed = text.trim();
    const cutOff = trimmed.startsWith('{') && !trimmed.endsWith('}');
    throw new ControlHostError(
      'malformed-endpoint-response',
      `${method}: ${body.length} bytes, ${cutOff ? 'JSON cut off' : 'not JSON'}`,
    );
  }
  return unwrapEndpointResponse(response, method);
}

const maximumShapeKeys = 8;

export function endpointResponseShape(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value !== 'object') return typeof value;
  const entries = Object.entries(value as Record<string, unknown>);
  const fields = entries.slice(0, maximumShapeKeys).map(([key, field]) => {
    const name = /^[A-Za-z0-9_$-]{1,32}$/u.test(key) ? key : '?';
    const type =
      field === null
        ? 'null'
        : Array.isArray(field)
          ? 'array'
          : typeof field === 'boolean'
            ? String(field)
            : typeof field;
    return `${name}:${type}`;
  });
  if (entries.length > maximumShapeKeys) fields.push(`+${entries.length - maximumShapeKeys}`);
  return `{${fields.join(', ')}}`;
}

function unwrapEndpointResponse(value: unknown, method: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ControlHostError(
      'malformed-endpoint-response',
      `${method}: answer is ${endpointResponseShape(value)}`,
    );
  }
  const response = value as Record<string, unknown>;
  if (response.ok === true && 'data' in response) return response.data;
  if (response.ok === false && response.error && typeof response.error === 'object') {
    const error = response.error as Record<string, unknown>;
    const code = error.code;
    let endpointCode =
      typeof code === 'string' && /^[a-z0-9_-]{1,96}$/u.test(code)
        ? `endpoint-${code}`
        : 'endpoint-rejected';
    if (
      code === 'invalid_request' &&
      typeof error.message === 'string' &&
      /^[a-z0-9_]{1,38}$/u.test(error.message)
    ) {
      endpointCode = `endpoint-invalid_request-${error.message}`;
    }
    const failures = incompleteRollbackFields(response.data);
    if (failures) {
      throw new ControlHostError('rollback-incomplete', `${endpointCode}; ${failures.join(', ')}`);
    }
    throw new ControlHostError(
      endpointCode,
      endpointCode === 'endpoint-rejected'
        ? `${method}: error ${endpointResponseShape(error)}`
        : undefined,
    );
  }
  throw new ControlHostError(
    'malformed-endpoint-response',
    `${method}: envelope ${endpointResponseShape(value)}`,
  );
}

function incompleteRollbackFields(data: unknown): string[] | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  if (record.rollbackComplete !== false) return null;
  const failures = Array.isArray(record.rollbackFailures) ? record.rollbackFailures : [];
  return failures
    .filter(
      (entry): entry is string =>
        typeof entry === 'string' && /^(?:set|readback):[A-Za-z0-9_.[\]]{1,64}$/u.test(entry),
    )
    .slice(0, 32);
}

function launcherWaitCode(code: string, message: string): ControlLauncherWaitCode | undefined {
  if (launcherWaitCodes.has(code)) return code as ControlLauncherWaitCode;
  if (code !== 'engine-status') return undefined;
  return legacyLauncherWaitMessages.find(([prefix]) => message.startsWith(prefix))?.[1];
}

function normalizeLauncherFailure(code: string): string {
  return /^[a-z0-9_-]{1,96}$/u.test(code) ? `launcher-${code}` : 'launcher-failed';
}

function terminateChild(child: ChildProcess): void {
  if (child.exitCode === null && child.signalCode === null) child.kill();
}

function abortError(): Error {
  const error = new Error('AoE2Control operation was cancelled');
  error.name = 'AbortError';
  return error;
}

export function bindLauncherToEngine(
  launcher: ControlLauncherBinding,
  identity: ControlEngineIdentity,
): void {
  if (
    launcher.launcherProductVersion !== identity.control.productVersion ||
    launcher.gameProcessId !== identity.engine.gameProcessId
  ) {
    throw new ControlHostError('launcher-engine-mismatch');
  }
}
