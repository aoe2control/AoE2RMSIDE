import type {
  ControlCapabilities,
  ControlCatalog,
  ControlCleanEndResult,
  ControlConnectPurpose,
  ControlEndpointStatus,
  ControlEngineIdentity,
  ControlSessionEvent,
  ControlSessionStatus,
  ControlStartRandomMapRequest,
  ControlStartRandomMapResult,
} from '../shared/api';
import type {
  ControlLauncherPreferenceStore,
  ValidatedControlLauncher,
} from './control-launcher-preference';
import {
  assertSameControlIdentity,
  ControlContractError,
  createControlEndpointRequest,
  type ControlEndpointRequest,
  validateControlCapabilities,
  validateControlCatalog,
  validateControlCleanEnd,
  validateControlEndpointStatus,
  validateControlDetach,
  validateControlStartRequest,
  validateControlStartResult,
} from './control-contract';
import { controlGameBuildVerification } from './control-game-builds';
import { bindLauncherToEngine, ControlHostError } from './control-node-host';
import type { GameExecutableName } from './linked-game-process';

const maximumQueuedOperations = 16;
const sessionContractVersion: Readonly<{ major: 1; minor: 0; patch: 0 }> = Object.freeze({
  major: 1,
  minor: 0,
  patch: 0,
});

export interface ControlBridgeTimeouts {
  gameDetectionMs: number;
  injectionHandshakeMs: number;
  endpointRequestMs: number;
  cleanEndResponseMs: number;
  startResponseMs: number;
}

export const defaultControlBridgeTimeouts: Readonly<ControlBridgeTimeouts> = Object.freeze({
  gameDetectionMs: 3_000,
  injectionHandshakeMs: 15_000,
  endpointRequestMs: 5_000,
  cleanEndResponseMs: 30_000,
  startResponseMs: 30_000,
});

export type ControlLauncherEventCode =
  'game-detected' | 'attach' | 'engine-unloading' | 'engine-starting';

const detachSafetyRetryDeadlineMs = 5_000;
const detachSafetyRetryInitialDelayMs = 50;
const detachSafetyRetryMaximumDelayMs = 500;
const maximumDetachAttempts = 24;

export interface ControlLauncherBinding {
  artifactSha256: string;
  launcherProductVersion: string;
  launcherProcessId: number;
  gameProcessId: number;
  gameImageName: GameExecutableName;
  disposition: 'injected' | 'reused';
}

export interface ControlBridgeHost {
  launch(
    executablePath: string,
    expectedSha256: string,
    timeouts: ControlBridgeTimeouts,
    signal: AbortSignal,
    publish: (code: ControlLauncherEventCode) => void,
  ): Promise<ControlLauncherBinding>;
  request(
    request: ControlEndpointRequest,
    timeoutMs: number,
    signal: AbortSignal,
    serverProcessId: number,
  ): Promise<unknown>;
}

export class ControlSessionBridge {
  private connection: ControlSessionStatus['connection'] = 'disconnected';
  private detailCode: string | undefined;
  private capabilities: ControlCapabilities | undefined;
  private endpointStatus: ControlEndpointStatus | undefined;
  private artifactSha256: string | undefined;
  private gameProcessId: number | undefined;
  private operationTail: Promise<unknown> = Promise.resolve();
  private queuedOperations = 0;
  private requestSequence = 0;
  private eventSequence = 0;
  private activeAbort: AbortController | undefined;

  constructor(
    private readonly preference: ControlLauncherPreferenceStore,
    private readonly host: ControlBridgeHost,
    private readonly publishEvent: (event: ControlSessionEvent) => void = () => undefined,
    private readonly timeouts: Readonly<ControlBridgeTimeouts> = defaultControlBridgeTimeouts,
  ) {
    if (
      timeouts.gameDetectionMs !== 3_000 ||
      !Number.isInteger(timeouts.injectionHandshakeMs) ||
      timeouts.injectionHandshakeMs < 1_000 ||
      timeouts.injectionHandshakeMs > 60_000 ||
      !Number.isInteger(timeouts.endpointRequestMs) ||
      timeouts.endpointRequestMs < 100 ||
      timeouts.endpointRequestMs > 30_000 ||
      !Number.isInteger(timeouts.cleanEndResponseMs) ||
      timeouts.cleanEndResponseMs < timeouts.endpointRequestMs ||
      timeouts.cleanEndResponseMs > 60_000 ||
      !Number.isInteger(timeouts.startResponseMs) ||
      timeouts.startResponseMs < timeouts.endpointRequestMs ||
      timeouts.startResponseMs > 60_000
    ) {
      throw new Error('AoE2Control bridge timeouts are invalid');
    }
  }

  async snapshot(): Promise<ControlSessionStatus> {
    return this.publicStatus();
  }

  connect(
    purpose: ControlConnectPurpose,
    signal?: AbortSignal,
    options: { recovery?: boolean } = {},
  ): Promise<ControlSessionStatus> {
    if (purpose !== 'live-run' && purpose !== 'adopt-seed') {
      return Promise.reject(new Error('AoE2Control connection purpose is invalid'));
    }
    return this.serialize(() => this.connectUnqueued(signal, options.recovery === true));
  }

  getStatus(signal?: AbortSignal): Promise<ControlEndpointStatus> {
    return this.serialize(async () => {
      const context = await this.requireReady(signal);
      const status = await this.endpointStatusRequest(context);
      this.endpointStatus = status;
      return status;
    });
  }

  refreshCatalog(signal?: AbortSignal): Promise<ControlCatalog> {
    return this.mutate('refresh_catalog', {}, validateControlCatalog, signal);
  }

  cleanEnd(signal?: AbortSignal): Promise<ControlCleanEndResult> {
    return this.serialize(async () => {
      const context = await this.requireReady(signal);
      const status = await this.preflight(context);
      if (status.match.multiplayer || status.match.replay) {
        throw new ControlBridgeError('unsupported-session-state');
      }
      return this.requestValidated(context, 'clean_end', {}, (value) =>
        validatedAnswer('clean_end', () => validateControlCleanEnd(value, context.identity)),
      );
    });
  }

  startRandomMap(
    request: ControlStartRandomMapRequest,
    signal?: AbortSignal,
  ): Promise<ControlStartRandomMapResult> {
    const validated = validateControlStartRequest(request);
    return this.serialize(async () => {
      const context = await this.requireReady(signal);
      const status = await this.preflight(context);
      if (status.match.multiplayer || status.match.replay || status.match.active) {
        throw new ControlBridgeError('explicit-clean-end-required');
      }
      const { requestId, ...params } = validated;
      return this.requestValidated(
        context,
        'start_random_map',
        params as unknown as Record<string, unknown>,
        (value) =>
          validatedAnswer('start_random_map', () =>
            validateControlStartResult(value, context.identity, requestId),
          ),
        requestId,
      );
    });
  }

  async disconnect(): Promise<ControlSessionStatus> {
    this.activeAbort?.abort();
    return this.serialize(async () => {
      const identity = this.capabilities?.identity;
      const gameProcessId = this.gameProcessId;
      if (identity && gameProcessId !== undefined) {
        const controller = new AbortController();
        try {
          await this.detachIdentity(identity, gameProcessId, controller.signal);
        } catch (error) {
          this.clearConnection('failed');
          this.detailCode = bridgeErrorCode(error);
          this.emit('failure', this.detailCode, bridgeErrorDetail(error));
          throw new ControlBridgeError(this.detailCode, bridgeErrorDetail(error));
        }
      }
      this.clearConnection('disconnected');
      this.emit('detached', identity ? 'engine-detached' : 'client-disconnected');
      return this.publicStatus();
    });
  }

  async shutdown(): Promise<void> {
    this.activeAbort?.abort();
    await this.serialize(async () => {
      const identity = this.capabilities?.identity;
      const gameProcessId = this.gameProcessId;
      if (identity && gameProcessId !== undefined) {
        const controller = new AbortController();
        await this.detachIdentity(identity, gameProcessId, controller.signal).catch(
          () => undefined,
        );
      }
      this.clearConnection('disconnected');
      this.emit('detached', 'ide-shutdown');
    });
  }

  private async connectUnqueued(
    signal?: AbortSignal,
    recovery = false,
  ): Promise<ControlSessionStatus> {
    const launcher = await this.preference.forLaunch();
    if (
      this.connection === 'ready' &&
      this.capabilities &&
      this.gameProcessId !== undefined &&
      this.artifactSha256 === launcher.sha256
    ) {
      try {
        const context = this.operationContext(this.gameProcessId, signal);
        const capabilities = await this.capabilitiesRequest(context);
        assertSameControlIdentity(this.capabilities.identity, capabilities.identity);
        const status = await this.endpointStatusRequest({
          ...context,
          identity: capabilities.identity,
        });
        this.capabilities = capabilities;
        this.endpointStatus = status;
        this.detailCode = undefined;
        this.emit('ready', 'retained-attachment');
        return this.publicStatus();
      } catch (error) {
        if (!isConnectionFailure(error)) {
          const code = bridgeErrorCode(error);
          this.connection = 'failed';
          this.detailCode = code;
          this.emit('failure', code, bridgeErrorDetail(error), recovery);
          throw new ControlBridgeError(code, bridgeErrorDetail(error));
        }
      }
    }

    const previousIdentity = this.capabilities?.identity;
    this.clearConnection('launching');
    this.emit('startup', 'headless-launcher-started');
    const controller = linkedAbortController(signal);
    this.activeAbort = controller;
    let establishedIdentity: ControlEngineIdentity | undefined;
    let launchedGameProcessId: number | undefined;
    try {
      const binding = await this.host.launch(
        launcher.canonicalPath,
        launcher.sha256,
        { ...this.timeouts },
        controller.signal,
        (code) => {
          if (code === 'game-detected') {
            this.connection = 'game-detected';
            this.emit('game-detected', 'running-game-detected');
          } else if (code === 'engine-unloading') {
            this.emit('startup', 'waiting-for-engine-unload');
          } else if (code === 'engine-starting') {
            this.emit('startup', 'waiting-for-engine-start');
          } else {
            this.emit('attach', 'control-injection-started');
          }
        },
      );
      this.connection = 'handshaking';
      this.emit('handshake', 'endpoint-validation-started');
      launchedGameProcessId = binding.gameProcessId;
      const context = this.operationContext(binding.gameProcessId, controller.signal);
      const capabilities = await this.capabilitiesRequest(context);
      establishedIdentity = capabilities.identity;
      bindLauncherToEngine(binding, capabilities.identity);
      if (
        previousIdentity &&
        binding.disposition === 'reused' &&
        (previousIdentity.engine.injectionId !== capabilities.identity.engine.injectionId ||
          previousIdentity.engine.endpointInstanceId !==
            capabilities.identity.engine.endpointInstanceId)
      ) {
        throw new ControlBridgeError('stale-reused-engine');
      }
      const status = await this.endpointStatusRequest({
        ...context,
        identity: capabilities.identity,
      });
      this.artifactSha256 = launcher.sha256;
      this.gameProcessId = binding.gameProcessId;
      this.capabilities = capabilities;
      this.endpointStatus = status;
      this.connection = 'ready';
      this.detailCode = undefined;
      this.emit('ready', binding.disposition === 'reused' ? 'engine-reused' : 'engine-ready');
      return this.publicStatus();
    } catch (error) {
      const code = bridgeErrorCode(error);
      if (establishedIdentity && launchedGameProcessId !== undefined) {
        await this.detachIdentity(
          establishedIdentity,
          launchedGameProcessId,
          new AbortController().signal,
        ).catch(() => undefined);
      }
      this.clearConnection('failed');
      this.detailCode = code;
      this.emit(
        error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'failure',
        code,
        bridgeErrorDetail(error),
        recovery,
      );
      throw new ControlBridgeError(code, bridgeErrorDetail(error));
    } finally {
      if (this.activeAbort === controller) this.activeAbort = undefined;
    }
  }

  private mutate<T>(
    method: 'refresh_catalog',
    params: Record<string, unknown>,
    validate: (value: unknown, identity: ControlEngineIdentity) => T,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.serialize(async () => {
      const context = await this.requireReady(signal);
      const status = await this.preflight(context);
      if (status.match.multiplayer || status.match.replay) {
        throw new ControlBridgeError('unsupported-session-state');
      }
      return this.requestValidated(context, method, params, (value) =>
        validatedAnswer(method, () => validate(value, context.identity)),
      );
    });
  }

  private async preflight(context: OperationContext): Promise<ControlEndpointStatus> {
    try {
      const capabilities = await this.capabilitiesRequest(context);
      assertSameControlIdentity(context.identity, capabilities.identity);
      const status = await this.endpointStatusRequest({
        ...context,
        identity: capabilities.identity,
      });
      this.capabilities = capabilities;
      this.endpointStatus = status;
      return status;
    } catch (error) {
      if (isConnectionFailure(error)) {
        this.clearConnection('failed');
        this.detailCode = bridgeErrorCode(error);
      }
      throw error;
    }
  }

  private async requireReady(signal?: AbortSignal): Promise<OperationContext> {
    if (
      this.connection !== 'ready' ||
      !this.capabilities ||
      !this.artifactSha256 ||
      this.gameProcessId === undefined
    ) {
      throw new ControlBridgeError('session-not-connected');
    }
    const gameProcessId = this.gameProcessId;
    let launcher: ValidatedControlLauncher;
    try {
      launcher = await this.preference.forLaunch();
    } catch {
      const identity = this.capabilities.identity;
      await this.detachIdentity(identity, gameProcessId, new AbortController().signal).catch(
        () => undefined,
      );
      this.clearConnection('failed');
      this.detailCode = 'launcher-artifact-transition';
      throw new ControlBridgeError('launcher-artifact-transition');
    }
    if (launcher.sha256 !== this.artifactSha256) {
      const identity = this.capabilities.identity;
      await this.detachIdentity(identity, gameProcessId, new AbortController().signal).catch(
        () => undefined,
      );
      this.clearConnection('failed');
      this.detailCode = 'launcher-artifact-transition';
      throw new ControlBridgeError('launcher-artifact-transition');
    }
    return this.operationContext(gameProcessId, signal, this.capabilities.identity, launcher);
  }

  private operationContext(
    gameProcessId: number,
    signal?: AbortSignal,
    identity?: ControlEngineIdentity,
    launcher?: ValidatedControlLauncher,
  ): OperationContext {
    const controller = linkedAbortController(signal);
    this.activeAbort = controller;
    return {
      signal: controller.signal,
      gameProcessId,
      identity: identity ?? this.capabilities?.identity ?? (undefined as never),
      launcher,
    };
  }

  private async capabilitiesRequest(
    context: Pick<OperationContext, 'signal' | 'gameProcessId'>,
  ): Promise<ControlCapabilities> {
    const value = await this.endpointRequest(
      'get_capabilities',
      {},
      context.signal,
      context.gameProcessId,
    );
    return validatedAnswer('get_capabilities', () => validateControlCapabilities(value));
  }

  private async endpointStatusRequest(context: OperationContext): Promise<ControlEndpointStatus> {
    const value = await this.endpointRequest(
      'get_status',
      {},
      context.signal,
      context.gameProcessId,
    );
    return validatedAnswer('get_status', () =>
      validateControlEndpointStatus(value, context.identity),
    );
  }

  private async requestValidated<T>(
    context: OperationContext,
    method: 'refresh_catalog' | 'clean_end' | 'start_random_map',
    params: Record<string, unknown>,
    validate: (value: unknown) => T,
    requestId?: string,
  ): Promise<T> {
    try {
      return validate(
        await this.endpointRequest(
          method,
          params,
          context.signal,
          context.gameProcessId,
          requestId,
        ),
      );
    } catch (error) {
      const originalCode = bridgeErrorCode(error);
      const unanswered =
        originalCode === 'endpoint-timeout' ||
        originalCode === 'endpoint-render_timeout' ||
        originalCode === 'endpoint-closed' ||
        originalCode === 'malformed-endpoint-response';
      const reportedCode = unanswered
        ? method === 'start_random_map'
          ? 'start-response-timeout'
          : method === 'clean_end'
            ? 'clean-end-response-timeout'
            : originalCode
        : originalCode;
      const recoverableStartDeadline =
        method === 'start_random_map' && reportedCode === 'start-response-timeout';
      if (
        (isConnectionFailure(error) && !recoverableStartDeadline) ||
        originalCode === 'validation-failed'
      ) {
        if (originalCode === 'validation-failed') {
          await this.detachIdentity(
            context.identity,
            context.gameProcessId,
            new AbortController().signal,
          ).catch(() => undefined);
        }
        this.clearConnection('failed');
        this.detailCode = reportedCode;
      }
      const detail = bridgeErrorDetail(error);
      throw new ControlBridgeError(
        reportedCode,
        reportedCode === originalCode
          ? detail
          : `${originalCode}${detail ? `; ${detail}` : ''}`.slice(0, maximumDetailLength),
      );
    } finally {
      if (this.activeAbort?.signal === context.signal) this.activeAbort = undefined;
    }
  }

  private async detachIdentity(
    identity: ControlEngineIdentity,
    gameProcessId: number,
    signal: AbortSignal,
  ): Promise<void> {
    const params = {
      injectionId: identity.engine.injectionId,
      endpointInstanceId: identity.engine.endpointInstanceId,
    };
    const deadline = Date.now() + detachSafetyRetryDeadlineMs;
    for (let attempt = 1; ; attempt += 1) {
      try {
        const response = await this.endpointRequest('detach', params, signal, gameProcessId);
        validateControlDetach(response, identity);
        return;
      } catch (error) {
        const remaining = deadline - Date.now();
        if (
          bridgeErrorCode(error) !== 'endpoint-rms_session_safety_changing' ||
          attempt >= maximumDetachAttempts ||
          remaining <= 0
        ) {
          throw error;
        }
        await abortableDelay(
          Math.min(
            detachSafetyRetryInitialDelayMs * 2 ** (attempt - 1),
            detachSafetyRetryMaximumDelayMs,
            remaining,
          ),
          signal,
        );
      }
    }
  }

  private endpointRequest(
    method: Parameters<typeof createControlEndpointRequest>[1],
    params: Record<string, unknown>,
    signal: AbortSignal,
    gameProcessId: number,
    requestId?: string,
  ): Promise<unknown> {
    const effectiveRequestId = requestId ?? `rmside:${Date.now()}:${++this.requestSequence}`;
    return this.host.request(
      createControlEndpointRequest(effectiveRequestId, method, params),
      method === 'start_random_map'
        ? this.timeouts.startResponseMs
        : method === 'clean_end'
          ? this.timeouts.cleanEndResponseMs
          : this.timeouts.endpointRequestMs,
      signal,
      gameProcessId,
    );
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.queuedOperations >= maximumQueuedOperations) {
      return Promise.reject(new ControlBridgeError('operation-queue-full'));
    }
    this.queuedOperations += 1;
    const result = this.operationTail
      .catch(() => undefined)
      .then(operation)
      .catch((error: unknown) => {
        if (error instanceof ControlBridgeError) throw error;
        throw new ControlBridgeError(bridgeErrorCode(error), bridgeErrorDetail(error));
      });
    this.operationTail = result;
    return result.finally(() => {
      this.queuedOperations -= 1;
    });
  }

  private async publicStatus(): Promise<ControlSessionStatus> {
    const productVersion = this.capabilities?.identity.gameBuild.fileVersion;
    const verification = productVersion ? controlGameBuildVerification(productVersion) : undefined;
    return {
      contractVersion: sessionContractVersion,
      connection: this.connection,
      ...(this.detailCode ? { detailCode: this.detailCode } : {}),
      launcher: await this.preference.status(),
      ...(this.capabilities ? { capabilities: structuredClone(this.capabilities) } : {}),
      ...(productVersion && verification ? { gameVersion: { productVersion, verification } } : {}),
      ...(this.endpointStatus ? { endpoint: structuredClone(this.endpointStatus) } : {}),
    };
  }

  private clearConnection(connection: ControlSessionStatus['connection']): void {
    this.connection = connection;
    this.detailCode = undefined;
    this.capabilities = undefined;
    this.endpointStatus = undefined;
    this.artifactSha256 = undefined;
    this.gameProcessId = undefined;
  }

  private emit(
    kind: ControlSessionEvent['kind'],
    detailCode: string,
    detail?: string,
    recovery = false,
  ): void {
    this.publishEvent({
      sequence: ++this.eventSequence,
      kind,
      detailCode,
      ...(kind === 'failure' && detail ? { detail: detail.slice(0, maximumDetailLength) } : {}),
      ...(kind === 'failure' && recovery ? { recovery: true } : {}),
    });
  }
}

interface OperationContext {
  signal: AbortSignal;
  gameProcessId: number;
  identity: ControlEngineIdentity;
  launcher?: ValidatedControlLauncher;
}

export class ControlBridgeError extends Error {
  constructor(
    readonly code: string,
    readonly detail?: string,
  ) {
    super(`AoE2Control session failed: ${code}${detail ? ` (${detail})` : ''}`);
    this.name = 'ControlBridgeError';
  }
}

const maximumDetailLength = 240;

function validatedAnswer<T>(method: string, validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    if (
      error instanceof ControlContractError ||
      error instanceof ControlBridgeError ||
      error instanceof ControlHostError ||
      !(error instanceof Error)
    ) {
      throw error;
    }
    throw new ControlBridgeError(
      'validation-failed',
      `${method}: ${error.message}`.slice(0, maximumDetailLength),
    );
  }
}

function bridgeErrorDetail(error: unknown): string | undefined {
  return error instanceof ControlHostError || error instanceof ControlBridgeError
    ? error.detail
    : undefined;
}

function linkedAbortController(signal?: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', () => controller.abort(), { once: true });
  return controller;
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cancelled = () => {
      const error = new Error('AoE2Control operation was cancelled');
      error.name = 'AbortError';
      return error;
    };
    if (signal.aborted) {
      reject(cancelled());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelled());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function bridgeErrorCode(error: unknown): string {
  if (
    error instanceof ControlBridgeError ||
    error instanceof ControlHostError ||
    error instanceof ControlContractError
  ) {
    return error.code;
  }
  if (error instanceof Error && error.name === 'AbortError') return 'cancelled';
  return 'validation-failed';
}

function isConnectionFailure(error: unknown): boolean {
  const code = bridgeErrorCode(error);
  return (
    code === 'endpoint-unavailable' ||
    code === 'endpoint-timeout' ||
    code === 'endpoint-closed' ||
    code === 'malformed-endpoint-response' ||
    code === 'launcher-engine-mismatch'
  );
}
