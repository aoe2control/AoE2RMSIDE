import type { LiveWorkflowStage, ManagedDeploymentRequest } from '../shared/api';
import {
  controlLegacyMaximumCivilizationId,
  controlMaximumCivilizationId,
} from './control-contract';
import {
  gameModeModifierOptions,
  hasLobbyOptions,
  liveComputerPlayerSlots,
  lobbyOptionFlags,
  type GameModeModifier,
} from '../shared/lobby-options';
import { packagedCivilizationCount } from '../shared/packaged-game-versions';
import { ControlBridgeError } from './control-session-bridge';
import { ProfileXsStagingError } from './profile-xs-staging';

export const controlRmsIdeContractVersion = '1.0.0' as const;
export const controlRmsIdeCapabilityRevision = 'rms-session-3' as const;
export const controlMultiplayerSafetyContract = 'rmside-multiplayer-refusal-1' as const;
export const liveResetDeadlineMilliseconds = 15_000;
export const liveActivationDeadlineMilliseconds = 30_000;

const maximumRequestIdentifierLength = 96;
const maximumStatusPolls = 640;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const requestIdentifierPattern = /^[A-Za-z0-9._:-]+$/u;
const liveMapDimensions = {
  tiny: 120,
  small: 144,
  medium: 168,
  normal: 200,
  large: 220,
  huge: 240,
  ludicrous: 480,
} as const;

export type LiveSessionState =
  | 'single-player-ready'
  | 'single-player-active'
  | 'multiplayer'
  | 'replay'
  | 'changing'
  | 'unknown';

export interface ControlSessionIdentity {
  launcherSha256: string;
  gameProcessId: number;
  injectionId: string;
  endpointInstanceId: string;
  controlVersion: string;
  buildFlavor: 'release' | 'release-packed';
  gameVersion: string;
  gameBuild: string;
}

export interface ControlCapabilities {
  contractVersion: typeof controlRmsIdeContractVersion;
  capabilityRevision: typeof controlRmsIdeCapabilityRevision;
  multiplayerSafetyContract: typeof controlMultiplayerSafetyContract;
  identity: ControlSessionIdentity;
  safety: ControlSafetyAttestation;
  features: {
    typedStartTransaction: true;
    managedLocalMod: true;
    requestedEffectiveReadback: true;
    transactionRollback: true;
    explicitCleanEnd: true;
    sourceCatalogRefresh: true;
    managedSourceSelection: true;
    typedSetup: true;
    exactUnsignedSeed: true;
    effectiveReadback: true;
    cleanEnd: true;
    freshMatchDispatch: true;
    statusReadback: true;
    matchEpochs: true;
    reviewedFailClosedMultiplayerRefusal: true;
    lobbyOptions?: boolean;
    directPath: false;
    inlineSource: false;
    intermediateSemanticStages: false;
  };
  setupContextVersions?: string[];
}

export interface ControlSafetyAttestation {
  contract: typeof controlMultiplayerSafetyContract;
  verified: boolean;
  sessionState: LiveSessionState;
  observationSequence: number;
}

export interface LivePlayerSetup {
  slot: number;
  team: number;
  civilizationId: number;
  color: number;
}

export interface LiveSetupContext {
  schemaVersion: '1.0.0' | '1.1.0' | '1.2.0';
  compatibility: { minimumMajor: 1; maximumMajor: 1 };
  gameMode: string;
  startingResources: string;
  startingAge: string;
  revealMap: 'all-visible';
  positionPolicy: string;
  players: LivePlayerSetup[];
  computerPlayerSlots?: number[];
  gameModeModifiers?: GameModeModifier[];
  turboMode?: boolean;
  fullTechTree?: boolean;
  antiquityMode?: boolean;
  solidFarms?: boolean;
}

export interface LiveEffectiveSetupContext extends LiveSetupContext {
  mapSize: string;
  endingAge: string;
}

export interface ControlSourceIdentity {
  sourceKind: 'local-mod';
  modIdentity: string;
  sourceIdentity: string;
  authoredSourceSha256: string;
  catalogGeneration: number;
}

export interface ControlResetEvidence {
  sequence: number;
  previousMatchEpoch: number;
  requested: boolean;
  dispatchAccepted: boolean;
  inactiveBoundaryObserved: boolean;
  completed: boolean;
}

export interface ControlLastTransaction {
  requestId: string;
  state: 'dispatched' | 'active-verifying' | 'active-verified' | 'active-readback-mismatch';
  requestedSetup: LiveEffectiveSetupContext;
  effectiveSetup: LiveEffectiveSetupContext | null;
  requestedSeed: number;
  effectiveSeed: number | null;
  sourceIdentity: string;
  authoredSourceSha256: string;
  catalogGeneration: number;
  matchEpoch: number | null;
  route: string;
}

export interface ControlStatus {
  identity: ControlSessionIdentity;
  safety: ControlSafetyAttestation;
  match: {
    observationSequence: number;
    active: boolean;
    multiplayer: boolean;
    replay: boolean;
    matchEpoch: number;
  };
  resetEvidence: ControlResetEvidence;
  lastTransaction: ControlLastTransaction | null;
  effectiveSeed: number | null;
  effectiveSource: ControlSourceIdentity | null;
}

export interface ControlCatalog {
  identity: ControlSessionIdentity;
  safety: ControlSafetyAttestation;
  catalogGeneration: number;
  sources: ControlSourceIdentity[];
}

export interface ControlStartRequest {
  contractVersion: typeof controlRmsIdeContractVersion;
  requestId: string;
  setup: LiveSetupContext;
  mapSize: string;
  endingAge: string;
  seed: number;
  source: ControlSourceIdentity;
}

export interface ControlStartResult {
  identity: ControlSessionIdentity;
  safety: ControlSafetyAttestation;
  requestId: string;
  dispatchAccepted: boolean;
  rollbackComplete: boolean;
  requestedSetup: LiveEffectiveSetupContext;
  effectiveSetup: LiveEffectiveSetupContext;
  requestedSeed: number;
  source: ControlSourceIdentity;
  route: string;
}

export interface ControlCleanEndResult {
  identity: ControlSessionIdentity;
  safety: ControlSafetyAttestation;
  status: 'already-inactive' | 'queued';
  resetEvidence: ControlResetEvidence;
}

export interface ControlLiveSessionPort {
  connect(reason: 'live-run', options?: { recovery?: boolean }): Promise<ControlCapabilities>;
  getStatus(): Promise<ControlStatus>;
  cleanEnd(): Promise<ControlCleanEndResult>;
  refreshCatalog(): Promise<ControlCatalog>;
  startRandomMap(request: ControlStartRequest): Promise<ControlStartResult>;
}

export interface ManagedSourceDeployment {
  changed: boolean;
  modIdentity: string;
  authoredSourceSha256: string;
  sourceCatalogHash: string;
  profileXsFiles?: readonly string[];
}

export interface LiveDeploymentPort {
  ensureCurrent(
    request: ManagedDeploymentRequest,
    options: { overwriteExternalChanges: boolean },
  ): Promise<ManagedSourceDeployment>;
  preflight?(request: ManagedDeploymentRequest): Promise<void>;
}

export interface ExactPreviewBinding {
  backend: 'exact';
  provenanceStatus: 'exact';
  documentUri: string;
  documentRevision: number;
  currentDocumentUri: string;
  currentDocumentRevision: number;
  requestHash: string;
  semanticProgramHash: string;
  sourceCatalogRevision: number;
  sourceCatalogHash: string;
  sourceGraphHash: string;
  externalAssetHash: string;
  profileId: string;
  profileHash: string;
  contentPackId: string;
  contentPackHash: string;
  width: number;
  height: number;
  mapSize: string;
  seed: number;
}

export interface LiveSynchronizationRequest {
  contractVersion: Readonly<{ major: 1; minor: 0; patch: 0 }>;
  requestId: string;
  preview: ExactPreviewBinding;
  deployment: ManagedDeploymentRequest;
  setup: LiveSetupContext;
  endingAge: string;
  replaceActiveMatch: boolean;
  overwriteDeploymentConflicts: boolean;
}

export type LiveWorkflowEventKind =
  | 'startup'
  | 'stage'
  | 'handshake'
  | 'clean-end'
  | 'deploy'
  | 'catalog-refresh'
  | 'start'
  | 'effective-readback'
  | 'cancellation'
  | 'failure';

export interface LiveWorkflowEvent {
  requestId: string;
  kind: LiveWorkflowEventKind;
  code: string;
  detail?: string;
  seed?: number;
  matchEpoch?: number;
  xsFiles?: string[];
}

export interface LiveSynchronizationResult {
  preview: 'current';
  live: 'active-verified';
  requestId: string;
  matchEpoch: number;
  seed: number;
  sourceIdentity: string;
  processIdentity: Pick<
    ControlSessionIdentity,
    'gameProcessId' | 'injectionId' | 'endpointInstanceId'
  >;
}

export interface LiveWorkflowClock {
  now(): number;
  wait(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

export class LiveWorkflowError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message.includes(`(${code})`) ? message : `${message} (${code})`);
    this.name = 'LiveWorkflowError';
  }
}

export class ControlLiveWorkflow {
  private operationTail: Promise<void> = Promise.resolve();
  private observationIdentity = '';
  private lastObservationSequence = 0;

  constructor(
    private readonly session: ControlLiveSessionPort,
    private readonly deployment: LiveDeploymentPort,
    private readonly emit: (event: LiveWorkflowEvent) => void = () => undefined,
    private readonly clock: LiveWorkflowClock = systemClock,
  ) {}

  synchronize(
    request: LiveSynchronizationRequest,
    signal?: AbortSignal,
  ): Promise<LiveSynchronizationResult> {
    return this.serialize(() => this.synchronizeExclusive(request, signal));
  }

  private async synchronizeExclusive(
    request: LiveSynchronizationRequest,
    signal?: AbortSignal,
  ): Promise<LiveSynchronizationResult> {
    try {
      validateSynchronizationRequest(request);
      throwIfCancelled(signal);
      if (this.deployment.preflight) {
        try {
          await this.deployment.preflight(request.deployment);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw /^XS dependency .+ does not parse/u.test(message)
            ? new LiveWorkflowError('xs-syntax', message)
            : error;
        }
      }
      this.emit({
        requestId: request.requestId,
        kind: 'startup',
        code: 'control-startup',
      });
      const capabilities = await this.session.connect('live-run');
      validateCapabilities(capabilities);
      const identity = capabilities.identity;
      this.recordSafety(identity, capabilities.safety);
      if (
        request.setup.players.some(
          (player) => player.civilizationId > controlLegacyMaximumCivilizationId,
        ) &&
        !supportsNewerCivilizations(identity.controlVersion)
      ) {
        throw new LiveWorkflowError(
          'control-civilization-unsupported',
          `Saxons, Varangians and Danes need AoE2Control 1.1.1 or newer; the selected AoE2Control is ${identity.controlVersion} (control-civilization-unsupported).`,
        );
      }
      const setup = controlSetupFor(request.setup, capabilities);
      const gameCivilizationCount = packagedCivilizationCount(null, identity.gameVersion);
      if (
        gameCivilizationCount !== undefined &&
        request.setup.players.some((player) => player.civilizationId >= gameCivilizationCount)
      ) {
        throw new LiveWorkflowError(
          'game-civilization-unavailable',
          `AoE2DE ${identity.gameVersion} does not have a selected civilization (game-civilization-unavailable).`,
        );
      }
      this.emit({
        requestId: request.requestId,
        kind: 'handshake',
        code: 'control-capabilities-verified',
      });
      this.stage(request.requestId, 'checking-game');

      const initial = await this.safeStatus(identity, signal);
      const initialEpoch = initial.match.matchEpoch;
      if (initial.match.active) {
        if (!request.replaceActiveMatch) {
          throw new LiveWorkflowError(
            'active-match-confirmation-required',
            'Confirm replacing the active single-player match before live testing.',
          );
        }
        this.stage(request.requestId, 'ending-match');
        const boundary = await this.safeStatus(identity, signal);
        const clean = await this.session.cleanEnd();
        assertSameIdentity(identity, clean.identity);
        this.recordSafety(identity, clean.safety);
        if (!clean.resetEvidence.dispatchAccepted) {
          throw new LiveWorkflowError(
            'clean-end-rejected',
            'Control rejected the clean match end.',
          );
        }
        this.emit({
          requestId: request.requestId,
          kind: 'clean-end',
          code: clean.status,
        });
        await this.waitForInactiveReset(identity, boundary, clean.resetEvidence.sequence, signal);
      }

      this.stage(request.requestId, 'copying-map');
      await this.requireInactiveBoundary(identity, signal);
      const deployed = await this.deployment.ensureCurrent(request.deployment, {
        overwriteExternalChanges: request.overwriteDeploymentConflicts,
      });
      if (!sha256Pattern.test(deployed.authoredSourceSha256)) {
        throw new LiveWorkflowError(
          'deployment-identity-invalid',
          'Managed deployment did not return a canonical source identity.',
        );
      }
      if (deployed.sourceCatalogHash !== request.preview.sourceCatalogHash) {
        throw new LiveWorkflowError(
          'deployment-preview-mismatch',
          'Managed deployment no longer matches the successful preview.',
        );
      }
      this.emit({
        requestId: request.requestId,
        kind: 'deploy',
        code: deployed.changed ? 'managed-source-deployed' : 'managed-source-current',
        ...(deployed.profileXsFiles?.length ? { xsFiles: [...deployed.profileXsFiles] } : {}),
      });

      this.stage(request.requestId, 'selecting-map');
      await this.requireInactiveBoundary(identity, signal);
      const catalog = await this.refreshCatalogWithSameEngineRecovery(identity, signal);
      assertSameIdentity(identity, catalog.identity);
      this.recordSafety(identity, catalog.safety);
      const source = selectManagedSource(catalog, deployed);
      this.emit({
        requestId: request.requestId,
        kind: 'catalog-refresh',
        code: 'managed-source-selected',
      });

      this.stage(request.requestId, 'starting-match');
      await this.requireInactiveBoundary(identity, signal);
      const startRequest: ControlStartRequest = {
        contractVersion: controlRmsIdeContractVersion,
        requestId: request.requestId,
        setup: canonicalSetup(setup),
        mapSize: request.preview.mapSize,
        endingAge: request.endingAge,
        seed: request.preview.seed,
        source,
      };
      try {
        const start = await this.session.startRandomMap(startRequest);
        validateStartResult(startRequest, start, identity);
        this.recordSafety(identity, start.safety);
        this.emit({
          requestId: request.requestId,
          kind: 'start',
          code: 'match-start-dispatched',
          seed: request.preview.seed,
        });
      } catch (error) {
        if (!isStartResponseTimeout(error)) throw error;
        this.emit({
          requestId: request.requestId,
          kind: 'start',
          code: 'match-start-response-pending',
          seed: request.preview.seed,
        });
      }

      this.stage(request.requestId, 'verifying');
      const active = await this.waitForActiveVerified(
        identity,
        request,
        setup,
        source,
        initialEpoch,
        signal,
      );
      this.emit({
        requestId: request.requestId,
        kind: 'effective-readback',
        code: 'active-verified',
        seed: request.preview.seed,
        matchEpoch: active.match.matchEpoch,
      });
      return {
        preview: 'current',
        live: 'active-verified',
        requestId: request.requestId,
        matchEpoch: active.match.matchEpoch,
        seed: request.preview.seed,
        sourceIdentity: source.sourceIdentity,
        processIdentity: {
          gameProcessId: identity.gameProcessId,
          injectionId: identity.injectionId,
          endpointInstanceId: identity.endpointInstanceId,
        },
      };
    } catch (error) {
      const cancelled =
        signal?.aborted || (error instanceof LiveWorkflowError && error.code === 'cancelled');
      this.emit({
        requestId: request.requestId,
        kind: cancelled ? 'cancellation' : 'failure',
        code: cancelled ? 'cancelled' : errorCode(error),
        ...(cancelled ? {} : { detail: safeErrorMessage(error) }),
      });
      throw error;
    }
  }

  private async waitForInactiveReset(
    identity: ControlSessionIdentity,
    before: ControlStatus,
    resetSequence: number,
    signal?: AbortSignal,
  ): Promise<ControlStatus> {
    const deadline = this.clock.now() + liveResetDeadlineMilliseconds;
    for (
      let attempt = 0;
      attempt < maximumStatusPolls && this.clock.now() <= deadline;
      attempt += 1
    ) {
      const status = await this.pollSafeStatus(identity, signal);
      if (!status) {
        await this.clock.wait(50, signal);
        continue;
      }
      if (
        !status.match.active &&
        status.resetEvidence.sequence >= resetSequence &&
        status.resetEvidence.sequence > before.resetEvidence.sequence &&
        status.resetEvidence.requested &&
        status.resetEvidence.dispatchAccepted &&
        status.resetEvidence.inactiveBoundaryObserved &&
        status.resetEvidence.completed
      ) {
        return status;
      }
      await this.clock.wait(50, signal);
    }
    throw new LiveWorkflowError(
      'clean-end-timeout',
      'Timed out waiting for a verified inactive match reset (clean-end-timeout).',
    );
  }

  private async waitForActiveVerified(
    identity: ControlSessionIdentity,
    request: LiveSynchronizationRequest,
    setup: LiveSetupContext,
    source: ControlSourceIdentity,
    initialEpoch: number,
    signal?: AbortSignal,
  ): Promise<ControlStatus> {
    const deadline = this.clock.now() + liveActivationDeadlineMilliseconds;
    let unanswered = false;
    for (
      let attempt = 0;
      attempt < maximumStatusPolls && this.clock.now() <= deadline;
      attempt += 1
    ) {
      const status = await this.pollSafeStatus(identity, signal);
      unanswered = status === undefined;
      if (!status) {
        await this.clock.wait(50, signal);
        continue;
      }
      const transaction = status.lastTransaction;
      if (transaction?.state === 'active-readback-mismatch') {
        throw new LiveWorkflowError(
          'effective-readback-mismatch',
          'Control reported an effective live-match readback mismatch.',
        );
      }
      if (transaction?.state === 'active-verified') {
        validateEffectiveStatus(status, request, setup, source, initialEpoch);
        return status;
      }
      await this.clock.wait(50, signal);
    }
    if (unanswered) {
      throw new LiveWorkflowError(
        'match-start-unresponsive',
        'The game stopped answering while the match started; it may be showing a message such as a script error (match-start-unresponsive).',
      );
    }
    throw new LiveWorkflowError(
      'active-verification-timeout',
      'Timed out waiting for active-verified live-match readback (active-verification-timeout).',
    );
  }

  private async requireInactiveBoundary(
    identity: ControlSessionIdentity,
    signal?: AbortSignal,
  ): Promise<ControlStatus> {
    const status = await this.safeStatus(identity, signal);
    if (status.match.active || status.safety.sessionState !== 'single-player-ready') {
      throw new LiveWorkflowError(
        'session-changed-before-mutation',
        'The game session changed before the live-test mutation boundary.',
      );
    }
    return status;
  }

  private async safeStatus(
    identity: ControlSessionIdentity,
    signal?: AbortSignal,
  ): Promise<ControlStatus> {
    throwIfCancelled(signal);
    const status = await this.session.getStatus();
    throwIfCancelled(signal);
    assertSameIdentity(identity, status.identity);
    validateSafeStatus(status);
    this.recordSafety(identity, status.safety);
    return status;
  }

  private async refreshCatalogWithSameEngineRecovery(
    identity: ControlSessionIdentity,
    signal?: AbortSignal,
  ): Promise<ControlCatalog> {
    try {
      return await this.session.refreshCatalog();
    } catch (error) {
      if (!isTransientEndpointTransportFailure(error)) throw error;
    }

    throwIfCancelled(signal);
    const capabilities = await this.session.connect('live-run', { recovery: true });
    validateCapabilities(capabilities);
    assertSameIdentity(identity, capabilities.identity);
    this.recordSafety(identity, capabilities.safety);
    await this.requireInactiveBoundary(identity, signal);
    return this.session.refreshCatalog();
  }

  private async pollSafeStatus(
    identity: ControlSessionIdentity,
    signal?: AbortSignal,
  ): Promise<ControlStatus | undefined> {
    try {
      return await this.safeStatus(identity, signal);
    } catch (error) {
      if (!isTransientStatusObservationFailure(error)) throw error;
      if (requiresStatusReconnect(error)) {
        try {
          throwIfCancelled(signal);
          const capabilities = await this.session.connect('live-run', { recovery: true });
          validateCapabilities(capabilities);
          assertSameIdentity(identity, capabilities.identity);
          this.recordSafety(identity, capabilities.safety);
        } catch (recoveryError) {
          if (!isTransientStatusObservationFailure(recoveryError)) throw recoveryError;
        }
      }
      return undefined;
    }
  }

  private stage(requestId: string, stage: LiveWorkflowStage): void {
    this.emit({ requestId, kind: 'stage', code: stage });
  }

  private recordSafety(identity: ControlSessionIdentity, safety: ControlSafetyAttestation): void {
    validateSafeAttestation(safety);
    const observationIdentity = `${identity.gameProcessId}:${identity.injectionId}:${identity.endpointInstanceId}`;
    if (observationIdentity !== this.observationIdentity) {
      this.observationIdentity = observationIdentity;
      this.lastObservationSequence = 0;
    }
    if (safety.observationSequence <= this.lastObservationSequence) {
      throw new LiveWorkflowError(
        'stale-safety-observation',
        'Control returned a stale live-session safety observation.',
      );
    }
    this.lastObservationSequence = safety.observationSequence;
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function isTransientEndpointTransportFailure(error: unknown): error is ControlBridgeError {
  return (
    error instanceof ControlBridgeError &&
    (error.code === 'endpoint-unavailable' ||
      error.code === 'endpoint-timeout' ||
      error.code === 'endpoint-closed')
  );
}

function isStartResponseTimeout(error: unknown): error is ControlBridgeError {
  return error instanceof ControlBridgeError && error.code === 'start-response-timeout';
}

function isTransientStatusObservationFailure(error: unknown): error is ControlBridgeError {
  return (
    isTransientEndpointTransportFailure(error) ||
    (error instanceof ControlBridgeError &&
      (error.code === 'malformed-endpoint-response' ||
        error.code === 'session-not-connected' ||
        error.code === 'endpoint-render_timeout' ||
        error.code === 'endpoint-queue_full' ||
        error.code === 'endpoint-engine_stopping' ||
        error.code === 'endpoint-rms_session_safety_changing' ||
        error.code === 'endpoint-rms_session_safety_unknown' ||
        error.code === 'endpoint-session_boundary_changed'))
  );
}

function requiresStatusReconnect(error: unknown): error is ControlBridgeError {
  return (
    error instanceof ControlBridgeError &&
    (error.code === 'endpoint-unavailable' ||
      error.code === 'endpoint-timeout' ||
      error.code === 'endpoint-closed' ||
      error.code === 'endpoint-render_timeout' ||
      error.code === 'endpoint-engine_stopping' ||
      error.code === 'malformed-endpoint-response' ||
      error.code === 'session-not-connected')
  );
}

function validateSynchronizationRequest(request: LiveSynchronizationRequest): void {
  if (
    request.contractVersion.major !== 1 ||
    request.contractVersion.minor !== 0 ||
    request.contractVersion.patch !== 0
  ) {
    throw new LiveWorkflowError(
      'unsupported-live-contract',
      'Live-test request contract is unsupported.',
    );
  }
  if (
    request.requestId.length < 1 ||
    request.requestId.length > maximumRequestIdentifierLength ||
    !requestIdentifierPattern.test(request.requestId)
  ) {
    throw new LiveWorkflowError('invalid-live-request', 'Live-test request identifier is invalid.');
  }
  const preview = request.preview;
  if (
    preview.backend !== 'exact' ||
    preview.provenanceStatus !== 'exact' ||
    preview.documentUri !== preview.currentDocumentUri ||
    preview.documentRevision !== preview.currentDocumentRevision
  ) {
    throw new LiveWorkflowError(
      'stale-or-nonexact-preview',
      'Live testing requires the current successful preview revision.',
    );
  }
  const hashes = [
    preview.requestHash,
    preview.semanticProgramHash,
    preview.sourceCatalogHash,
    preview.sourceGraphHash,
    preview.externalAssetHash,
    preview.profileHash,
    preview.contentPackHash,
  ];
  if (hashes.some((hash) => !sha256Pattern.test(hash))) {
    throw new LiveWorkflowError('invalid-preview-identity', 'Preview identity is malformed.');
  }
  if (
    preview.sourceCatalogRevision !== request.deployment.sourceCatalogRevision ||
    preview.sourceCatalogHash !== request.deployment.sourceCatalogHash ||
    preview.sourceGraphHash !== request.deployment.sourceGraphHash ||
    preview.externalAssetHash !== request.deployment.externalAssetHash ||
    preview.documentUri !== request.deployment.documentUri ||
    preview.documentRevision !== request.deployment.documentRevision
  ) {
    throw new LiveWorkflowError(
      'deployment-preview-mismatch',
      'Deployment identity does not match the successful preview.',
    );
  }
  const expectedDimension = liveMapDimensions[preview.mapSize as keyof typeof liveMapDimensions];
  if (
    !validUnsigned32(preview.seed) ||
    expectedDimension === undefined ||
    preview.width !== expectedDimension ||
    preview.height !== expectedDimension
  ) {
    throw new LiveWorkflowError(
      'invalid-preview-options',
      'Preview seed or dimensions are invalid.',
    );
  }
  validateSetup(request.setup);
  if (
    typeof request.endingAge !== 'string' ||
    request.endingAge.length < 1 ||
    request.endingAge.length > 64
  ) {
    throw new LiveWorkflowError('invalid-ending-age', 'Ending age is invalid.');
  }
}

function validateSetup(setup: LiveSetupContext): void {
  if (
    !['1.0.0', '1.1.0', '1.2.0'].includes(setup.schemaVersion) ||
    setup.compatibility.minimumMajor !== 1 ||
    setup.compatibility.maximumMajor !== 1 ||
    setup.revealMap !== 'all-visible' ||
    setup.players.length < 1 ||
    setup.players.length > 8
  ) {
    throw new LiveWorkflowError('invalid-setup', 'Typed live setup is invalid.');
  }
  const slots = new Set<number>();
  const colors = new Set<number>();
  for (const player of setup.players) {
    if (
      !Number.isInteger(player.slot) ||
      player.slot < 1 ||
      player.slot > 8 ||
      !Number.isInteger(player.team) ||
      player.team < 0 ||
      player.team > 4 ||
      !Number.isInteger(player.civilizationId) ||
      player.civilizationId < 0 ||
      player.civilizationId > controlMaximumCivilizationId ||
      !Number.isInteger(player.color) ||
      player.color < 0 ||
      player.color > 7 ||
      slots.has(player.slot) ||
      colors.has(player.color)
    ) {
      throw new LiveWorkflowError('invalid-setup-player', 'Typed player setup is invalid.');
    }
    slots.add(player.slot);
    colors.add(player.color);
  }
  validateSetupExtensions(setup);
}

function validateSetupExtensions(setup: LiveSetupContext): void {
  const minor = Number(setup.schemaVersion.split('.')[1]);
  const modifierOrder = gameModeModifierOptions.map((option) => option.value) as string[];
  const modifiers = setup.gameModeModifiers;
  const expectedComputers = liveComputerPlayerSlots(setup.players.map((player) => player.slot));
  const lobbyOptions = hasLobbyOptions(setup);
  if (
    (modifiers !== undefined &&
      (!Array.isArray(modifiers) ||
        modifiers.length < 1 ||
        modifiers.some(
          (modifier, index) =>
            !modifierOrder.includes(modifier) ||
            (index > 0 &&
              modifierOrder.indexOf(modifier) <= modifierOrder.indexOf(modifiers[index - 1]!)),
        ))) ||
    lobbyOptionFlags.some((flag) => setup[flag] !== undefined && setup[flag] !== true) ||
    (lobbyOptions ? minor !== 2 : minor === 2) ||
    (setup.computerPlayerSlots === undefined
      ? minor === 1
      : minor < 1 ||
        !Array.isArray(setup.computerPlayerSlots) ||
        setup.computerPlayerSlots.length < 1 ||
        setup.computerPlayerSlots.join(',') !== expectedComputers.join(',')) ||
    (minor >= 1 && setup.computerPlayerSlots === undefined && expectedComputers.length > 0)
  ) {
    throw new LiveWorkflowError('invalid-setup', 'Typed live setup is invalid.');
  }
}

function controlSetupFor(
  setup: LiveSetupContext,
  capabilities: ControlCapabilities,
): LiveSetupContext {
  if (setup.schemaVersion === '1.0.0') return setup;
  const accepted =
    capabilities.features.lobbyOptions === true &&
    Array.isArray(capabilities.setupContextVersions) &&
    capabilities.setupContextVersions.includes(setup.schemaVersion);
  if (accepted) return setup;
  if (setup.schemaVersion === '1.2.0') {
    throw new LiveWorkflowError(
      'control-lobby-options-unsupported',
      `Lobby options need AoE2Control 1.1.1 or newer; the selected AoE2Control is ${capabilities.identity.controlVersion} (control-lobby-options-unsupported).`,
    );
  }
  const { computerPlayerSlots: _computers, ...legacy } = structuredClone(setup);
  return { ...legacy, schemaVersion: '1.0.0' };
}

function validateCapabilities(capabilities: ControlCapabilities): void {
  const expectedFeatures: Array<keyof ControlCapabilities['features']> = [
    'typedStartTransaction',
    'managedLocalMod',
    'requestedEffectiveReadback',
    'transactionRollback',
    'explicitCleanEnd',
    'sourceCatalogRefresh',
    'managedSourceSelection',
    'typedSetup',
    'exactUnsignedSeed',
    'effectiveReadback',
    'cleanEnd',
    'freshMatchDispatch',
    'statusReadback',
    'matchEpochs',
    'reviewedFailClosedMultiplayerRefusal',
  ];
  if (
    capabilities.contractVersion !== controlRmsIdeContractVersion ||
    capabilities.capabilityRevision !== controlRmsIdeCapabilityRevision ||
    capabilities.multiplayerSafetyContract !== controlMultiplayerSafetyContract ||
    expectedFeatures.some((feature) => capabilities.features[feature] !== true) ||
    capabilities.features.directPath !== false ||
    capabilities.features.inlineSource !== false ||
    capabilities.features.intermediateSemanticStages !== false ||
    !isCompatibleControlVersion(capabilities.identity.controlVersion) ||
    !['release', 'release-packed'].includes(capabilities.identity.buildFlavor)
  ) {
    throw new LiveWorkflowError(
      'incompatible-control-capabilities',
      'Control does not provide the complete reviewed RMS IDE capability boundary.',
    );
  }
  validateIdentity(capabilities.identity);
}

function validateSafeStatus(status: ControlStatus): void {
  validateSafeAttestation(status.safety);
  if (
    status.match.multiplayer ||
    status.match.replay ||
    status.match.observationSequence !== status.safety.observationSequence ||
    ['multiplayer', 'replay', 'changing', 'unknown'].includes(status.safety.sessionState) ||
    (status.match.active && status.safety.sessionState !== 'single-player-active') ||
    (!status.match.active && status.safety.sessionState !== 'single-player-ready')
  ) {
    throw new LiveWorkflowError(
      'unsafe-or-unknown-session',
      'Control could not verify a stable supported single-player session.',
    );
  }
}

function validateSafeAttestation(
  safety: ControlSafetyAttestation,
  minimumObservationSequence = 1,
): void {
  if (
    safety.contract !== controlMultiplayerSafetyContract ||
    safety.verified !== true ||
    !Number.isSafeInteger(safety.observationSequence) ||
    safety.observationSequence < minimumObservationSequence ||
    ['multiplayer', 'replay', 'changing', 'unknown'].includes(safety.sessionState)
  ) {
    throw new LiveWorkflowError(
      'unsafe-or-unknown-session',
      'Control could not verify a stable supported single-player session.',
    );
  }
}

function validateIdentity(identity: ControlSessionIdentity): void {
  if (
    !sha256Pattern.test(identity.launcherSha256) ||
    !Number.isInteger(identity.gameProcessId) ||
    identity.gameProcessId < 1 ||
    !boundedIdentity(identity.injectionId) ||
    !boundedIdentity(identity.endpointInstanceId) ||
    !boundedIdentity(identity.gameVersion) ||
    !boundedIdentity(identity.gameBuild)
  ) {
    throw new LiveWorkflowError(
      'invalid-session-identity',
      'Control session identity is malformed.',
    );
  }
}

function validateStartResult(
  request: ControlStartRequest,
  result: ControlStartResult,
  identity: ControlSessionIdentity,
): void {
  assertSameIdentity(identity, result.identity);
  const expectedSetup = effectiveSetup(request.setup, request.mapSize, request.endingAge);
  if (
    result.requestId !== request.requestId ||
    !result.dispatchAccepted ||
    !result.rollbackComplete ||
    result.requestedSeed !== request.seed ||
    !sameSetup(result.requestedSetup, expectedSetup) ||
    !sameSetup(result.effectiveSetup, expectedSetup) ||
    !sameSource(result.source, request.source)
  ) {
    throw new LiveWorkflowError(
      'start-transaction-mismatch',
      'Control start transaction did not preserve the immutable live request.',
    );
  }
}

function validateEffectiveStatus(
  status: ControlStatus,
  request: LiveSynchronizationRequest,
  setup: LiveSetupContext,
  source: ControlSourceIdentity,
  initialEpoch: number,
): void {
  const transaction = status.lastTransaction;
  const expectedSetup = effectiveSetup(
    canonicalSetup(setup),
    request.preview.mapSize,
    request.endingAge,
  );
  if (
    !status.match.active ||
    status.match.matchEpoch <= initialEpoch ||
    !transaction ||
    transaction.requestId !== request.requestId ||
    transaction.state !== 'active-verified' ||
    transaction.matchEpoch !== status.match.matchEpoch ||
    transaction.requestedSeed !== request.preview.seed ||
    transaction.effectiveSeed !== request.preview.seed ||
    status.effectiveSeed !== request.preview.seed ||
    !sameSetup(transaction.requestedSetup, expectedSetup) ||
    !transaction.effectiveSetup ||
    !sameSetup(transaction.effectiveSetup, expectedSetup) ||
    transaction.sourceIdentity !== source.sourceIdentity ||
    transaction.authoredSourceSha256 !== source.authoredSourceSha256 ||
    transaction.catalogGeneration !== source.catalogGeneration ||
    !status.effectiveSource ||
    !sameSource(status.effectiveSource, source)
  ) {
    throw new LiveWorkflowError(
      'effective-readback-mismatch',
      'Effective live-match readback does not match the immutable IDE request.',
    );
  }
}

function effectiveSetup(
  setup: LiveSetupContext,
  mapSize: string,
  endingAge: string,
): LiveEffectiveSetupContext {
  return { ...structuredClone(setup), mapSize, endingAge };
}

function canonicalSetup(setup: LiveSetupContext): LiveSetupContext {
  return {
    ...structuredClone(setup),
    players: [...setup.players]
      .sort((left, right) => left.slot - right.slot)
      .map((player) => ({ ...player })),
  };
}

function selectManagedSource(
  catalog: ControlCatalog,
  deployed: ManagedSourceDeployment,
): ControlSourceIdentity {
  if (!Number.isSafeInteger(catalog.catalogGeneration) || catalog.catalogGeneration < 1) {
    throw new LiveWorkflowError(
      'invalid-catalog-generation',
      'Control catalog generation is invalid.',
    );
  }
  const matches = catalog.sources.filter(
    (source) =>
      source.sourceKind === 'local-mod' &&
      source.modIdentity.toLocaleLowerCase('en-US') ===
        deployed.modIdentity.toLocaleLowerCase('en-US') &&
      source.authoredSourceSha256 === deployed.authoredSourceSha256 &&
      source.catalogGeneration === catalog.catalogGeneration,
  );
  if (matches.length !== 1 || !sha256Pattern.test(matches[0]!.sourceIdentity)) {
    throw new LiveWorkflowError(
      matches.length > 1 ? 'ambiguous-managed-source' : 'managed-source-unavailable',
      matches.length > 1
        ? 'Control returned multiple matching managed sources.'
        : 'Control did not return the managed source of the current deployment.',
    );
  }
  return structuredClone(matches[0]!);
}

function assertSameIdentity(
  expected: ControlSessionIdentity,
  actual: ControlSessionIdentity,
): void {
  validateIdentity(actual);
  if (
    expected.launcherSha256 !== actual.launcherSha256 ||
    expected.gameProcessId !== actual.gameProcessId ||
    expected.injectionId !== actual.injectionId ||
    expected.endpointInstanceId !== actual.endpointInstanceId ||
    expected.controlVersion !== actual.controlVersion ||
    expected.buildFlavor !== actual.buildFlavor ||
    expected.gameVersion !== actual.gameVersion ||
    expected.gameBuild !== actual.gameBuild
  ) {
    throw new LiveWorkflowError(
      'session-identity-changed',
      'The game process, Control injection, or endpoint identity changed during live testing.',
    );
  }
}

function sameSetup(left: LiveSetupContext, right: LiveSetupContext): boolean {
  const leftEffective = left as Partial<LiveEffectiveSetupContext>;
  const rightEffective = right as Partial<LiveEffectiveSetupContext>;
  return (
    left.schemaVersion === right.schemaVersion &&
    left.compatibility.minimumMajor === right.compatibility.minimumMajor &&
    left.compatibility.maximumMajor === right.compatibility.maximumMajor &&
    left.gameMode === right.gameMode &&
    left.startingResources === right.startingResources &&
    left.startingAge === right.startingAge &&
    left.revealMap === right.revealMap &&
    left.positionPolicy === right.positionPolicy &&
    leftEffective.mapSize === rightEffective.mapSize &&
    leftEffective.endingAge === rightEffective.endingAge &&
    sameLobbySetup(left, right) &&
    left.players.length === right.players.length &&
    left.players.every((player, index) => {
      const other = right.players[index];
      return (
        Boolean(other) &&
        player.slot === other!.slot &&
        player.team === other!.team &&
        player.civilizationId === other!.civilizationId &&
        player.color === other!.color
      );
    })
  );
}

function sameLobbySetup(left: LiveSetupContext, right: LiveSetupContext): boolean {
  return (
    (left.computerPlayerSlots ?? []).join(',') === (right.computerPlayerSlots ?? []).join(',') &&
    (left.gameModeModifiers ?? []).join(',') === (right.gameModeModifiers ?? []).join(',') &&
    lobbyOptionFlags.every((flag) => (left[flag] === true) === (right[flag] === true))
  );
}

function sameSource(left: ControlSourceIdentity, right: ControlSourceIdentity): boolean {
  return (
    left.sourceKind === right.sourceKind &&
    left.modIdentity === right.modIdentity &&
    left.sourceIdentity === right.sourceIdentity &&
    left.authoredSourceSha256 === right.authoredSourceSha256 &&
    left.catalogGeneration === right.catalogGeneration
  );
}

function isCompatibleControlVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\.\d+)?$/u.exec(version);
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > 1 || (major === 1 && minor >= 1);
}

function supportsNewerCivilizations(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version);
  if (!match) return false;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return major > 1 || (major === 1 && (minor > 1 || (minor === 1 && patch >= 1)));
}

function validUnsigned32(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

function boundedIdentity(value: string): boolean {
  return typeof value === 'string' && value.length >= 1 && value.length <= 256;
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new LiveWorkflowError('cancelled', 'Live test cancelled.');
}

function errorCode(error: unknown): string {
  if (
    error instanceof LiveWorkflowError ||
    error instanceof ControlBridgeError ||
    error instanceof ProfileXsStagingError
  ) {
    return error.code;
  }
  return 'live-test-failed';
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Live test failed.';
  return message.replace(/[A-Za-z]:[\\/][^\s]*/gu, '[local path]').slice(0, 512);
}

const systemClock: LiveWorkflowClock = {
  now: () => Date.now(),
  wait: (milliseconds, signal) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, milliseconds);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new LiveWorkflowError('cancelled', 'Live test cancelled.'));
        },
        { once: true },
      );
    }),
};
