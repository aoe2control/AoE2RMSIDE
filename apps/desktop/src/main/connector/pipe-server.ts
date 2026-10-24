import { randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { create } from '@bufbuild/protobuf';
import {
  CallProgressSchema,
  CallResultSchema,
  ContentItemSchema,
  GoodbyeReason,
  GoodbyeSchema,
  ImageSchema,
  PairingChangedSchema,
  PairingState,
  SessionReadySchema,
  type Envelope,
} from '../../generated/rmside/connect/v1/connect_pb';
import type { ConnectorOutputRow, ConnectorPairing } from '../../shared/connector-api';
import type { ConnectorCatalog } from './catalog';
import {
  ConnectorCallDispatcher,
  ConnectorToolError,
  ConnectorToolRegistry,
  connectorErrorText,
  type CallSink,
  type ConnectorAppIdentity,
  type ConnectorConnectionScope,
  type ConnectorContent,
  type DispatchSession,
} from './dispatcher';
import {
  ConnectorFrameDecoder,
  checkEnvelope,
  connectorEnvelope,
  connectorWire,
  decodeEnvelope,
  encodeFrame,
  protocolErrorCodes,
  protocolErrorPayload,
  truncateUtf8,
  type EnvelopePayload,
} from './envelope';
import {
  answerClientHello,
  catalogHashesMatch,
  connectorPipeName,
  connectorProofMatches,
  versionMismatchMessage,
  type PendingHandshake,
} from './handshake';
import type { ConnectorSettings } from './settings';

const maximumPendingHandshakes = 8;
const closeGraceMilliseconds = 1_000;

export interface ConnectorPipeServerOptions {
  key: Uint8Array;
  catalog: ConnectorCatalog;
  ideVersion: string;
  registry: ConnectorToolRegistry;
  settings: () => Readonly<ConnectorSettings>;
  pairingFor(connection: ConnectorPipeConnection): ConnectorPairing;
  onSessionOpened?(connection: ConnectorPipeConnection): void;
  onSessionClosed?(connection: ConnectorPipeConnection): void;
  onRow(row: ConnectorOutputRow): void;
  onChange?(): void;
  log?(message: string, error?: unknown): void;
}

function pairingWire(pairing: ConnectorPairing): PairingState {
  switch (pairing) {
    case 'approved':
      return PairingState.APPROVED;
    case 'pending':
      return PairingState.PENDING;
    case 'denied':
      return PairingState.DENIED;
  }
}

class ConnectionScope implements ConnectorConnectionScope {
  private readonly values = new Map<object, unknown>();
  private readonly closers = new Set<() => void>();
  private closed = false;

  constructor(readonly id: string) {}

  get<T>(key: object, createValue: () => T): T {
    if (!this.values.has(key)) this.values.set(key, createValue());
    return this.values.get(key) as T;
  }

  onClose(callback: () => void): () => void {
    if (this.closed) {
      callback();
      return () => undefined;
    }
    this.closers.add(callback);
    return () => this.closers.delete(callback);
  }

  close(log?: (message: string, error?: unknown) => void): void {
    if (this.closed) return;
    this.closed = true;
    for (const callback of this.closers) {
      try {
        callback();
      } catch (error) {
        log?.('a connector connection cleanup failed', error);
      }
    }
    this.closers.clear();
    this.values.clear();
  }
}

type ConnectionPhase = 'hello' | 'proof' | 'ready' | 'closing' | 'closed';

export class ConnectorPipeConnection {
  readonly id = randomUUID();
  readonly scope = new ConnectionScope(this.id);
  private phase: ConnectionPhase = 'hello';
  private readonly decoder = new ConnectorFrameDecoder(connectorWire.handshakeFrameBytes);
  private pending: PendingHandshake | undefined;
  private identity: ConnectorAppIdentity | undefined;
  private session: string | undefined;
  private pairingState: ConnectorPairing = 'pending';
  private readonly pairingWaiters = new Set<() => void>();
  private nextMessageId = 1n;
  private lastReceivedId = 0n;
  private lastCallId = 0n;
  private dispatcher: ConnectorCallDispatcher | undefined;
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly socket: Socket,
    private readonly server: ConnectorPipeServer,
    private readonly options: ConnectorPipeServerOptions,
  ) {
    this.handshakeTimer = setTimeout(
      () => this.destroy(),
      options.catalog.limits.handshakeSeconds * 1000,
    );
    socket.on('data', (chunk: Buffer) => this.receive(chunk));
    socket.on('error', (error) => {
      if (this.phase === 'ready') options.log?.('a connector connection failed', error);
    });
    socket.on('close', () => this.closed());
  }

  get ready(): boolean {
    return this.phase === 'ready';
  }

  get app(): ConnectorAppIdentity {
    if (!this.identity) throw new Error('the connection has not proved the key');
    return this.identity;
  }

  get sessionId(): string | undefined {
    return this.session;
  }

  get pairing(): ConnectorPairing {
    return this.pairingState;
  }

  get working(): boolean {
    return (this.dispatcher?.inFlight ?? 0) > 0;
  }

  setPairing(pairing: ConnectorPairing): void {
    if (this.pairingState === pairing) return;
    this.pairingState = pairing;
    if (this.phase === 'ready') {
      this.send({
        case: 'pairingChanged',
        value: create(PairingChangedSchema, { pairing: pairingWire(pairing) }),
      });
    }
    for (const waiter of [...this.pairingWaiters]) waiter();
  }

  goodbye(reason: GoodbyeReason, message = ''): void {
    if ((this.phase === 'ready' || this.phase === 'proof') && this.identity) {
      this.send({
        case: 'goodbye',
        value: create(GoodbyeSchema, {
          reason,
          message: truncateUtf8(message, connectorWire.goodbyeMessageBytes),
        }),
      });
    }
    this.end();
  }

  end(): void {
    if (this.finished) return;
    this.phase = 'closing';
    this.dispatcher?.close();
    this.socket.end();
    this.closeTimer = setTimeout(() => this.socket.destroy(), closeGraceMilliseconds);
    this.closeTimer.unref?.();
  }

  destroy(): void {
    if (this.phase === 'closed') return;
    this.phase = 'closing';
    this.dispatcher?.close();
    this.socket.destroy();
  }

  private get finished(): boolean {
    return this.phase === 'closing' || this.phase === 'closed';
  }

  private receive(chunk: Buffer): void {
    if (this.finished) return;
    let frames: Uint8Array[];
    try {
      frames = this.decoder.push(chunk);
    } catch {
      this.violation();
      return;
    }
    for (const frame of frames) {
      if (this.finished) return;
      this.frame(frame);
    }
  }

  private frame(frame: Uint8Array): void {
    let envelope: Envelope;
    try {
      envelope = decodeEnvelope(frame);
    } catch {
      this.violation();
      return;
    }
    const refusal = checkEnvelope(envelope);
    if (this.phase !== 'ready') {
      if (refusal || envelope.messageId <= this.lastReceivedId) {
        this.destroy();
        return;
      }
      this.lastReceivedId = envelope.messageId;
      if (this.phase === 'hello') this.hello(envelope);
      else this.proof(envelope);
      return;
    }
    if (refusal?.kind === 'unsupported-major') {
      this.send(protocolErrorPayload(protocolErrorCodes.unsupportedMajor, 'protocol major 1 only'));
      this.end();
      return;
    }
    if (envelope.messageId <= this.lastReceivedId) {
      this.violation();
      return;
    }
    this.lastReceivedId = envelope.messageId;
    if (refusal?.kind === 'unknown-message') {
      this.send(protocolErrorPayload(protocolErrorCodes.unknownMessage, 'no such payload'));
      return;
    }
    if (refusal?.kind === 'malformed-message') {
      this.send(protocolErrorPayload(protocolErrorCodes.malformedMessage, refusal.field));
      return;
    }
    this.sessionMessage(envelope);
  }

  private hello(envelope: Envelope): void {
    if (envelope.payload.case !== 'clientHello') {
      this.destroy();
      return;
    }
    const answer = answerClientHello({
      key: this.options.key,
      hello: envelope.payload.value,
      ideVersion: this.options.ideVersion,
      catalogHash: this.options.catalog.hash,
    });
    this.pending = answer.pending;
    this.phase = 'proof';
    this.send({ case: 'serverHello', value: answer.serverHello });
  }

  private proof(envelope: Envelope): void {
    const pending = this.pending;
    this.pending = undefined;
    if (
      envelope.payload.case !== 'clientProof' ||
      !pending ||
      !connectorProofMatches(envelope.payload.value.clientProof, pending.expectedClientProof)
    ) {
      this.destroy();
      return;
    }
    const app = pending.hello.app!;
    this.identity = {
      name: app.name,
      title: app.title,
      version: app.version,
      launcherImage: app.launcherImage,
      displayName: app.title.length > 0 ? app.title : app.name,
    };
    clearTimeout(this.handshakeTimer);
    this.handshakeTimer = undefined;
    if (!catalogHashesMatch(pending.hello.catalogHash, this.options.catalog.hash)) {
      this.goodbye(
        GoodbyeReason.VERSION_MISMATCH,
        versionMismatchMessage(pending.hello.connectorVersion),
      );
      return;
    }
    if (this.server.sessionCount >= this.options.catalog.limits.connections) {
      this.goodbye(GoodbyeReason.LIMIT_REACHED);
      return;
    }
    this.session = randomUUID();
    this.decoder.maximumBytes = connectorWire.frameBytes;
    this.phase = 'ready';
    this.server.sessionStarted(this);
    const dispatchSession: DispatchSession = {
      app: this.identity,
      scope: this.scope,
      pairing: () => this.pairingState,
      pairingChanged: (signal) =>
        new Promise<void>((resolve) => {
          const done = () => {
            this.pairingWaiters.delete(done);
            signal.removeEventListener('abort', done);
            resolve();
          };
          this.pairingWaiters.add(done);
          signal.addEventListener('abort', done, { once: true });
          if (signal.aborted) done();
        }),
    };
    const sink: CallSink = {
      progress: (callId, done, total, message) =>
        this.send({
          case: 'callProgress',
          value: create(CallProgressSchema, { callId, done, total, message }),
        }),
      result: (callId, isError, content) => this.sendResult(callId, isError, content),
    };
    this.dispatcher = new ConnectorCallDispatcher({
      catalog: this.options.catalog,
      registry: this.options.registry,
      session: dispatchSession,
      sink,
      settings: this.options.settings,
      onRow: this.options.onRow,
      onWorkingChange: () => this.options.onChange?.(),
      ...(this.options.log ? { log: this.options.log } : {}),
    });
    this.pairingState = this.options.pairingFor(this);
    this.send({
      case: 'sessionReady',
      value: create(SessionReadySchema, {
        sessionId: this.session,
        pairing: pairingWire(this.pairingState),
        appDisplayName: truncateDisplay(this.identity.displayName),
      }),
    });
    this.options.onSessionOpened?.(this);
  }

  private sessionMessage(envelope: Envelope): void {
    const payload = envelope.payload;
    switch (payload.case) {
      case 'callTool': {
        const call = payload.value;
        if (call.callId <= this.lastCallId) {
          this.violation();
          return;
        }
        this.lastCallId = call.callId;
        this.dispatcher!.start({
          callId: call.callId,
          toolName: call.toolName,
          argumentsJson: call.argumentsJson,
          wantsProgress: call.wantsProgress,
        });
        return;
      }
      case 'cancelCall':
        this.dispatcher!.cancel(payload.value.callId);
        return;
      case 'goodbye':
        this.end();
        return;
      case 'protocolError':
        if (payload.value.code === protocolErrorCodes.unsupportedMajor) this.end();
        else this.options.log?.(`rms-connect reported ${payload.value.code}`);
        return;
      default:
        this.violation();
    }
  }

  private sendResult(callId: bigint, isError: boolean, content: readonly ConnectorContent[]): void {
    const payload = (error: boolean, items: readonly ConnectorContent[]): EnvelopePayload => ({
      case: 'callResult',
      value: create(CallResultSchema, {
        callId,
        isError: error,
        content: items.map((item) =>
          create(ContentItemSchema, {
            item:
              item.type === 'text'
                ? { case: 'text', value: item.text }
                : {
                    case: 'image',
                    value: create(ImageSchema, {
                      png: item.png,
                      width: item.width,
                      height: item.height,
                    }),
                  },
          }),
        ),
      }),
    });
    const primary = payload(isError, content);
    if (this.send(primary, false)) return;
    this.options.log?.('a connector result was outside the contract and was replaced');
    this.send(
      payload(true, [
        {
          type: 'text',
          text: connectorErrorText(
            new ConnectorToolError('internal', 'Something went wrong in AoE2RMSIDE.'),
          ),
        },
      ]),
    );
  }

  private send(payload: EnvelopePayload, logRefusal = true): boolean {
    if (this.finished) return true;
    const envelope = connectorEnvelope(this.nextMessageId, payload);
    const refusal = checkEnvelope(envelope);
    if (refusal) {
      if (logRefusal) this.options.log?.(`refused to send a ${payload.case} envelope`);
      return false;
    }
    let frame: Buffer;
    try {
      frame = encodeFrame(envelope);
    } catch {
      if (logRefusal) this.options.log?.(`refused to send an oversized ${payload.case} envelope`);
      return false;
    }
    this.nextMessageId += 1n;
    this.socket.write(frame);
    return true;
  }

  private violation(): void {
    if (this.phase === 'ready') this.goodbye(GoodbyeReason.PROTOCOL_VIOLATION);
    else this.destroy();
  }

  private closed(): void {
    const wasReady = this.session !== undefined;
    this.phase = 'closed';
    clearTimeout(this.handshakeTimer);
    clearTimeout(this.closeTimer);
    this.dispatcher?.close();
    for (const waiter of [...this.pairingWaiters]) waiter();
    this.scope.close(this.options.log);
    this.server.connectionClosed(this);
    if (wasReady) this.options.onSessionClosed?.(this);
  }
}

function truncateDisplay(name: string): string {
  const characters = [...name];
  return characters.length <= connectorWire.appDisplayNameChars
    ? name
    : characters.slice(0, connectorWire.appDisplayNameChars).join('');
}

export class ConnectorPipeServer {
  readonly pipeName: string;
  private readonly connections = new Set<ConnectorPipeConnection>();
  private readonly sessions = new Set<ConnectorPipeConnection>();
  private closing = false;

  private constructor(
    private readonly server: Server,
    private readonly options: ConnectorPipeServerOptions,
  ) {
    this.pipeName = connectorPipeName(options.key);
  }

  static listen(options: ConnectorPipeServerOptions): Promise<ConnectorPipeServer> {
    const server = createServer({ allowHalfOpen: false, pauseOnConnect: false });
    const instance = new ConnectorPipeServer(server, options);
    server.maxConnections = options.catalog.limits.connections + maximumPendingHandshakes;
    server.on('connection', (socket) => instance.accept(socket));
    return new Promise((resolve, reject) => {
      const failed = (error: Error) => reject(error);
      server.once('error', failed);
      server.listen(instance.pipeName, () => {
        server.off('error', failed);
        server.on('error', (error) => options.log?.('the connector pipe server failed', error));
        resolve(instance);
      });
    });
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  sessionList(): ConnectorPipeConnection[] {
    return [...this.sessions];
  }

  sessionStarted(connection: ConnectorPipeConnection): void {
    this.sessions.add(connection);
  }

  connectionClosed(connection: ConnectorPipeConnection): void {
    this.connections.delete(connection);
    this.sessions.delete(connection);
  }

  async close(reason: GoodbyeReason, message = ''): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    for (const connection of [...this.connections]) {
      if (connection.ready) connection.goodbye(reason, message);
      else connection.destroy();
    }
    const bound = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, closeGraceMilliseconds * 2);
      timer.unref?.();
    });
    await Promise.race([closed, bound]);
  }

  private accept(socket: Socket): void {
    const pendingHandshakes = this.connections.size - this.sessions.size;
    if (this.closing || pendingHandshakes >= maximumPendingHandshakes) {
      socket.destroy();
      return;
    }
    this.connections.add(new ConnectorPipeConnection(socket, this, this.options));
  }
}
